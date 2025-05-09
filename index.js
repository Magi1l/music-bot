require('dotenv').config();
const { 
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, 
  PermissionsBitField, MessageFlags, ButtonStyle 
} = require('discord.js');
const { DisTube } = require('distube');
const { SpotifyPlugin } = require('@distube/spotify');
const { SoundCloudPlugin } = require('@distube/soundcloud');
// const { YouTubePlugin } = require('@distube/youtube'); // 유튜브 플러그인 임시 주석 처리
const axios = require('axios');
const cheerio = require('cheerio');
const cron = require('node-cron');
const mongoose = require('mongoose');
const express = require('express');
const ShopItem = require('./models/ShopItem');
const PurchaseHistory = require('./models/PurchaseHistory');
const User = require('./models/User');
const GuildConfig = require('./models/GuildConfig');
const CrawlConfig = require('./models/CrawlConfig');
const puppeteer = require('puppeteer');
const axiosRetry = require('axios-retry');
const urlJoin = require('url-join');
const winston = require('winston');
const crypto = require('crypto');

// ===== MongoDB 연결 및 모델 =====
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB 연결 성공'))
  .catch(err => console.error('❌ MongoDB 연결 실패:', err));

const userSchema = new mongoose.Schema({
  userId: String,
  xp: { type: Number, default: 0 },
  level: { type: Number, default: 1 },
  points: { type: Number, default: 0 }
});
userSchema.index({ userId: 1 }, { unique: true });
userSchema.index({ level: -1 });
const User = mongoose.model('User', userSchema);

const noticeConfigSchema = new mongoose.Schema({
  guildId: String,
  noticeChannelId: String
});
const NoticeConfig = mongoose.model('NoticeConfig', noticeConfigSchema);

// ===== Discord 클라이언트 =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates
  ]
});

// ===== 명령어 파일 불러오기 및 등록 =====
const adminCommands = require('./commands/admin/addShopItem');
const userCommands = [
  require('./commands/user/ranking'),
  require('./commands/user/previewProfile')
];

client.once('ready', async () => {
  await client.application.commands.set([adminCommands.data, ...userCommands.map(cmd => cmd.data)]);
  console.log('명령어 등록 완료!');
  console.log(`${client.user.tag} 온라인!`);
});

// ===== 명령어 처리 =====
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const command = interaction.commandName;
  const userCommand = userCommands.find(cmd => cmd.data.name === command);
  const adminCommand = adminCommands.data.name === command;
  if (adminCommand) {
    await adminCommands.execute(interaction);
  } else if (userCommand) {
    await userCommand.execute(interaction);
  }
});

// ===== 음성 경험치 적립 로직 =====
client.on('voiceStateUpdate', async (oldState, newState) => {
  // 봇이거나 음성 채널 입장/퇴장 아닌 경우 무시
  if (!newState.member || newState.member.user.bot) return;
  const userId = newState.member.id;
  const guildId = newState.guild.id;
  // 음성 채널에 새로 들어온 경우만 처리
  if (!oldState.channelId && newState.channelId) {
    // 1분마다 경험치 지급 (간단 구현: 1분 후 1회 지급)
    setTimeout(async () => {
      const config = await GuildConfig.findOne({ guildId });
      const voiceXp = config?.xpConfig?.voiceXpPerMinute ?? 5;
      await User.findOneAndUpdate(
        { userId },
        { $inc: { xp: voiceXp } },
        { upsert: true, new: true }
      );
    }, 60 * 1000);
  }
});

// ===== 채팅 경험치 적립 로직 개선 =====
client.on('messageCreate', async message => {
  if (message.author.bot) return;
  const guildId = message.guildId;
  const userId = message.author.id;
  const config = await GuildConfig.findOne({ guildId });
  const textXp = config?.xpConfig?.textXpPerMessage ?? 10;
  const cooldown = config?.xpConfig?.textCooldown ?? 60;
  const multipliers = config?.xpConfig?.textChannelMultipliers || [];
  // 쿨타임 체크용 캐시 (메모리)
  if (!global.textXpCooldown) global.textXpCooldown = {};
  const key = `${guildId}:${userId}`;
  const now = Date.now();
  if (global.textXpCooldown[key] && now - global.textXpCooldown[key] < cooldown * 1000) return;
  global.textXpCooldown[key] = now;
  // 채널별 배수 적용
  let multiplier = 1;
  const found = multipliers.find(m => m.channelId === message.channel.id);
  if (found) multiplier = found.multiplier;
  const addXp = Math.round(textXp * multiplier);
  const user = await User.findOneAndUpdate(
    { userId },
    { $inc: { xp: addXp } },
    { upsert: true, new: true }
  );
  const newLevel = Math.floor(0.1 * Math.sqrt(user.xp));
  if (newLevel > user.level) {
    user.level = newLevel;
    await user.save();
    message.channel.send(`🎉 ${message.author} 레벨 업! (Lv. ${newLevel})`);
  }
});

// ===== DisTube(음악) 설정 =====
const cookies = process.env.YOUTUBE_COOKIE?.split(';')
  .map(pair => {
    if (!pair.includes('=')) return null;
    const [name, value] = pair.trim().split('=').map(s => s.trim());
    return { name, value, domain: '.youtube.com', path: '/' };
  })
  .filter(cookie => cookie.name && cookie.value) || [];

const distube = new DisTube(client, {
  plugins: [
    new SpotifyPlugin({
      api: {
        clientId: process.env.SPOTIFY_CLIENT_ID,
        clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
      }
    }),
    new SoundCloudPlugin(),
    // new YouTubePlugin({ cookies }),
  ],
  emitNewSongOnly: true,
  nsfw: false,
});

// ===== 재생 큐 시스템 =====
const playQueue = [];
let isPlaying = false;
async function processQueue() {
  if (isPlaying || playQueue.length === 0) return;
  isPlaying = true;
  try {
    const { interaction, query, originalQuery, source } = playQueue.shift();
    await distube.play(interaction.member.voice.channel, query, {
      member: interaction.member,
      textChannel: interaction.channel,
      metadata: { source: source || (query.startsWith('spotify:') ? 'spotify' : query.startsWith('scsearch:') ? 'soundcloud' : 'youtube') }
    }).catch(error => {
      console.error('DisTube 재생 오류:', error);
      interaction.editReply({ content: `❌ 재생 오류: ${error.message}` }).catch(() => {});
      throw error;
    });
    setTimeout(() => {
      const queue = distube.getQueue(interaction.guildId);
      if (!queue || !queue.songs || queue.songs.length === 0) {
        interaction.editReply({ content: `❌ 재생 가능한 곡을 찾지 못했습니다.\n- 입력: ${originalQuery || query}\n- 플랫폼: ${source || 'youtube'}\n다른 검색어나 URL을 시도해보세요.` }).catch(() => {});
      }
    }, 2000);
  } catch (error) {
    console.error('큐 처리 오류:', error);
    try { await interaction.editReply({ content: `❌ 오류: ${error.message}` }).catch(() => {}); } catch {}
  }
  isPlaying = false;
  processQueue();
}

// ===== 웹사이트 크롤링 설정 구조 =====
const websiteConfig = new Map(); // guildId → Map(name → config)

// ===== 명령어 등록 (글로벌+길드 모두) =====
client.once('ready', async () => {
  // 글로벌 등록
  await client.application.commands.set(commands);
  console.log('글로벌 명령어 등록 완료!');

  // 길드(서버) 전용 등록(즉시 반영)
  const guild = client.guilds.cache.get('652710221759774730');
  if (guild) {
    await guild.commands.set(commands);
    console.log('길드(652710221759774730) 전용 명령어 등록 완료!');
  } else {
    console.log('서버(652710221759774730)에 봇이 없습니다.');
  }
  console.log(`${client.user.tag} 온라인!`);
});

// ===== 음악 컨트롤 버튼 및 임베드 =====
distube.on('playSong', async (queue, song) => {
  try {
    if (!song || !queue || !queue.textChannel) return;
    let channel = queue.textChannel;
    if (!channel?.isTextBased) {
      channel = await client.channels.fetch(queue.textChannel.id).catch(() => null);
      if (!channel?.isTextBased()) return;
    }
    const repeatMode = queue.repeatMode === 0 ? '반복 없음' : (queue.repeatMode === 1 ? '한 곡 반복' : '전체 반복');
    const embed = new EmbedBuilder()
      .setTitle('🎵 현재 재생 중')
      .setDescription(`[${song.name || '알 수 없는 제목'}](${song.url || 'https://distube.js.org'})`)
      .addFields(
        { name: '길이', value: song.formattedDuration || '알 수 없음', inline: true },
        { name: '요청자', value: song.user?.toString() || '알 수 없음', inline: true },
        { name: '반복', value: repeatMode, inline: true }
      )
      .setThumbnail(song.thumbnail || null)
      .setColor('#2b2d31');
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('pause').setLabel('일시정지').setStyle(ButtonStyle.Secondary).setEmoji('⏸️'),
      new ButtonBuilder().setCustomId('skip').setLabel('스킵').setStyle(ButtonStyle.Primary).setEmoji('⏭️'),
      new ButtonBuilder().setCustomId('stop').setLabel('중지').setStyle(ButtonStyle.Danger).setEmoji('⏹️'),
      new ButtonBuilder().setCustomId('repeat').setLabel('반복').setStyle(ButtonStyle.Success).setEmoji('🔁')
    );
    channel.send({ embeds: [embed], components: [row] }).catch(error => {
      console.error('재생 정보 메시지 전송 오류:', error);
    });
  } catch (error) {
    console.error('playSong 이벤트 처리 오류:', error);
  }
});

// ===== 음악 컨트롤 버튼 처리 =====
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  const queue = distube.getQueue(interaction.guildId);
  if (!queue) return interaction.reply({ content: '재생 중인 곡이 없습니다.', flags: MessageFlags.Ephemeral });
  switch (interaction.customId) {
    case 'pause':
      queue.pause(!queue.paused);
      await interaction.reply({ content: queue.paused ? '⏸️ 일시정지' : '▶️ 재개', flags: MessageFlags.Ephemeral });
      break;
    case 'skip':
      queue.skip();
      await interaction.reply({ content: '⏭️ 다음 곡으로 스킵했습니다!', flags: MessageFlags.Ephemeral });
      break;
    case 'stop':
      queue.stop();
      await interaction.reply({ content: '⏹️ 재생을 중지했습니다.', flags: MessageFlags.Ephemeral });
      break;
    case 'repeat':
      if (queue.repeatMode === 2) {
        queue.setRepeatMode(0);
        await interaction.reply({ content: '🔁 반복 해제', flags: MessageFlags.Ephemeral });
      } else {
        queue.setRepeatMode(2);
        await interaction.reply({ content: '🔁 전체 반복', flags: MessageFlags.Ephemeral });
      }
      break;
  }
});

// ===== 웹크롤링 스케줄러 =====
function setupCron(guildId, name, config) {
  if (config.cron) config.cron.stop();
  if (config.url && config.channelId) {
    console.log(`[크롤러] setupCron: ${guildId}/${name} - ${config.url} → #${config.channelId} (${config.interval}ms)`);
    config.cron = cron.schedule(`*/${Math.max(1, Math.floor(config.interval / 60000))} * * * *`, () => checkWebsite(guildId, name));
  } else {
    console.log(`[크롤러] setupCron: ${guildId}/${name} - url/channelId 누락`);
  }
}

// ===== Winston 로거 설정 =====
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'crawler.log' })
  ]
});

// ===== axios 재시도 설정 =====
axiosRetry(axios, { retries: 3, retryDelay: axiosRetry.exponentialDelay });

// ===== 다양한 이미지 속성 지원 extractPost =====
function extractPost($, el, baseUrl) {
  const $el = $(el);
  const title = $el.find('.post-title, .entry-title, [itemprop="headline"], .title, h1, h2').first().text().trim();
  // 링크: data-url, href, src 등
  let rawLink = $el.find('[href], [data-url]').attr('href') || $el.attr('data-url') || $el.find('a').attr('href');
  const link = rawLink ? urlJoin(baseUrl, rawLink) : null;
  // 이미지: src, data-src, lazy-src, srcset, itemprop 등
  let image = $el.find('img[data-src]').attr('data-src') ||
              $el.find('img[lazy-src]').attr('lazy-src') ||
              $el.find('img[srcset]').attr('srcset') ||
              $el.find('img[src]').attr('src') ||
              $el.find('[itemprop="image"]').attr('content');
  // srcset에서 첫번째 이미지만 추출
  if (image && image.includes(',')) image = image.split(',')[0].split(' ')[0];
  return { title, link, image };
}

// ===== 게시글 고유 해시 생성 (link 우선, 없으면 title+image) =====
function getPostId(post) {
  const base = post.link || (post.title + '|' + (post.image || ''));
  return crypto.createHash('md5').update(base).digest('hex');
}

// ===== 사이트별 맞춤 셀렉터 우선, 없으면 fallback =====
const POST_SELECTORS = [
  '.post-item', '.article-list-item', 'article', 'li', 'section', 'div'
];

// ===== 동적 렌더링 + fallback 크롤링 =====
async function checkWebsite(guildId, name) {
  const guildConfigs = websiteConfig.get(guildId);
  if (!guildConfigs) {
    logger.warn(`[크롤러] guildId ${guildId}에 대한 설정 없음`);
    return;
  }
  const config = guildConfigs.get(name);
  if (!config) {
    logger.warn(`[크롤러] name ${name}에 대한 설정 없음`);
    return;
  }
  let posts = [];
  let usedDynamic = false;
  try {
    logger.info(`[크롤러] checkWebsite 시작: ${guildId}/${name}`);
    // 1. Puppeteer로 동적 렌더링 시도
    const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)');
    await page.goto(config.url, { waitUntil: 'networkidle2', timeout: 20000 });
    const content = await page.content();
    const $ = cheerio.load(content);
    for (const selector of POST_SELECTORS) {
      $(selector).each((i, el) => {
        const post = extractPost($, el, config.url);
        if (post.title && (post.link || post.image)) posts.push(post);
      });
      if (posts.length > 0) break;
    }
    await browser.close();
    usedDynamic = true;
    logger.info(`[크롤러] Puppeteer posts 개수: ${posts.length}`);
  } catch (err) {
    logger.error(`[크롤러] Puppeteer 오류: ${err.message}`);
  }
  // 2. fallback: axios+cheerio (정적)
  if (posts.length === 0) {
    try {
      const response = await axios.get(config.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
        timeout: 10000
      });
      const $ = cheerio.load(response.data);
      for (const selector of POST_SELECTORS) {
        $(selector).each((i, el) => {
          const post = extractPost($, el, config.url);
          if (post.title && (post.link || post.image)) posts.push(post);
        });
        if (posts.length > 0) break;
      }
      logger.info(`[크롤러] cheerio fallback posts 개수: ${posts.length}`);
    } catch (err) {
      logger.error(`[크롤러] cheerio fallback 오류: ${err.message}`);
    }
  }
  // 3. 게시글 중복 감지 (link 해시)
  if (posts.length > 0) {
    const postId = getPostId(posts[0]);
    logger.info(`[크롤러] 추출 postId: ${postId}, lastPostId: ${config.lastPostId}`);
    if (postId !== config.lastPostId) {
      config.lastPostId = postId;
      await CrawlConfig.updateOne({ guildId, name }, { $set: { lastPostId: postId } });
      // Discord 알림 전송
      try {
        const channel = await client.channels.fetch(config.channelId).catch(() => null);
        if (!channel) {
          logger.warn(`[크롤러] 채널 ${config.channelId}을 찾을 수 없음`);
          return;
        }
        if (!channel.isTextBased()) {
          logger.warn(`[크롤러] 채널 ${config.channelId}이 텍스트 채널이 아님`);
          return;
        }
        const embed = new EmbedBuilder()
          .setTitle(posts[0].title)
          .setURL(posts[0].link || config.url)
          .setImage(posts[0].image)
          .addFields({ name: '바로가기', value: `[클릭](${posts[0].link || config.url})`, inline: true })
          .setColor('#2b2d31');
        await channel.send({ embeds: [embed] });
        logger.info(`[크롤러] 새 글 알림 전송: ${posts[0].title}`);
      } catch (err) {
        logger.error(`[크롤러] Discord 알림 오류: ${err.message}`);
      }
    } else {
      logger.info(`[크롤러] 새 글 없음 or 이미 알림 보냄: ${guildId}/${name}`);
    }
  } else {
    logger.warn(`[크롤러] 게시글 추출 실패: ${guildId}/${name}`);
  }
}

// ===== 에러 핸들링 =====
distube.on('error', async (channel, error) => {
  try {
    if (error.message && error.message.includes('NO_RESULT')) {
      await channel.send('🔍 SoundCloud에서 곡을 찾지 못했습니다. 검색어를 바꾸거나 직접 링크를 입력해 주세요.');
      return;
    }
    let errorMessage = error.message || '알 수 없는 오류가 발생했습니다.';
    if (errorMessage && typeof errorMessage === 'string') {
      if (errorMessage.length > 1900) {
        errorMessage = errorMessage.substring(0, 1900) + '...';
      }
    } else {
      errorMessage = '오류가 발생했지만 상세 내용을 표시할 수 없습니다.';
    }
    if (error.name === 'TypeError' && errorMessage.includes('Cannot read properties of undefined')) {
      errorMessage = 'Spotify/SoundCloud 트랙을 재생할 수 없습니다. URL이 유효하거나 지역 제한이 없는지 확인하세요.';
    }
    if (errorMessage.includes('not available in your country')) {
      errorMessage = '해당 컨텐츠는 국가 제한으로 인해 재생할 수 없습니다.';
    }
    if (channel && channel.send) {
      await channel.send(`⚠️ 오류 발생: ${errorMessage}`).catch(err => {
        console.error('오류 메시지 전송 실패:', err);
      });
    }
  } catch (handlerError) {
    console.error('에러 핸들러 내부 오류:', handlerError);
  }
});

// ===== Express 서버 통합 =====
const app = express();
app.use(express.json());

// ===== API 라우터 =====
const apiRouter = express.Router();
apiRouter.get('/shop', async (req, res) => {
  try {
    const items = await ShopItem.find();
    res.json(items);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
apiRouter.post('/purchase', async (req, res) => {
  try {
    const { userId, itemId } = req.body;
    const item = await ShopItem.findOne({ itemId });
    if (!item) return res.status(404).json({ error: '상품을 찾을 수 없습니다' });
    const user = await User.findOne({ userId });
    if (!user) return res.status(404).json({ error: '유저를 찾을 수 없습니다' });
    if (user.points < item.price) return res.status(400).json({ error: '포인트가 부족합니다' });
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      await User.updateOne(
        { userId },
        { $inc: { points: -item.price }, $push: { purchasedItems: itemId } },
        { session }
      );
      const purchase = new PurchaseHistory({ userId, itemId });
      await purchase.save({ session });
      await session.commitTransaction();
      res.json({ success: true, message: '구매가 완료되었습니다' });
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
apiRouter.get('/ranking', async (req, res) => {
  try {
    const users = await User.find()
      .sort({ level: -1, xp: -1 })
      .limit(10)
      .select('userId level xp');
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.use('/api', apiRouter);

// ===== 대시보드용 API 라우터 =====
const dashboardRouter = express.Router();
dashboardRouter.get('/users', async (req, res) => {
  try {
    const users = await User.find().sort({ level: -1, xp: -1 }).limit(10);
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.use('/dashboard', dashboardRouter);

// ===== 웹훅 라우터 =====
const webhookRouter = express.Router();
webhookRouter.post('/', async (req, res) => {
  const guildId = req.body.guildId;
  const config = await NoticeConfig.findOne({ guildId });
  if (!config) return res.status(400).json({ error: '공지 채널이 설정되지 않았습니다.' });
  const channel = client.channels.cache.get(config.noticeChannelId);
  if (channel) {
    channel.send({
      embeds: [new EmbedBuilder()
        .setTitle('새 공지')
        .setDescription(req.body.content)
        .setColor(0x00FF00)
      ]
    });
  }
  res.sendStatus(200);
});
app.use('/webhook', webhookRouter);

// ===== 자동 환급 스케줄러 =====
cron.schedule('0 0 * * *', async () => {
  try {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const oldPurchases = await PurchaseHistory.find({ purchasedAt: { $lt: weekAgo } });
    for (const purchase of oldPurchases) {
      const item = await ShopItem.findOne({ itemId: purchase.itemId });
      if (item) {
        await User.updateOne(
          { userId: purchase.userId },
          { $inc: { points: item.price } }
        );
      }
      await purchase.delete();
    }
  } catch (error) {
    console.error('자동 환급 처리 중 오류:', error);
  }
});

// ===== 서버 시작 시 크롤링 설정 복구 =====
async function restoreCrawlers() {
  try {
    const configs = await CrawlConfig.find();
    for (const conf of configs) {
      if (!websiteConfig.has(conf.guildId)) websiteConfig.set(conf.guildId, new Map());
      websiteConfig.get(conf.guildId).set(conf.name, {
        url: conf.url,
        channelId: conf.channelId,
        interval: conf.interval,
        lastPostId: conf.lastPostId
      });
      setupCron(conf.guildId, conf.name, websiteConfig.get(conf.guildId).get(conf.name));
    }
    console.log(`[크롤러] DB에서 ${configs.length}개 설정 복구 완료`);
  } catch (err) {
    console.error('[크롤러] 복구 중 오류:', err);
  }
}
restoreCrawlers();

// ===== 서버 실행 =====
app.listen(3000, () => {
  console.log('서버가 3000번 포트에서 실행 중입니다.');
});

// ===== 예외 핸들링 =====
process.on('uncaughtException', error => {
  console.error('처리되지 않은 예외:', error);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('처리되지 않은 프로미스 거부:', promise, '이유:', reason);
});

client.login(process.env.DISCORD_TOKEN);

// ===== 크롤링 대상 추가/삭제/상태 확인 함수 샘플 =====
// 아래 함수들은 명령어/관리 API 등에서 활용할 수 있습니다.

/**
 * 크롤링 대상 추가
 */
async function addCrawlingTarget(guildId, name, url, channelId, interval = 60000) {
  await CrawlConfig.create({ guildId, name, url, channelId, interval });
  if (!websiteConfig.has(guildId)) websiteConfig.set(guildId, new Map());
  websiteConfig.get(guildId).set(name, { url, channelId, interval, lastPostId: null });
  setupCron(guildId, name, websiteConfig.get(guildId).get(name));
  console.log(`[크롤러] 크롤링 대상 추가: ${guildId}/${name}`);
}

/**
 * 크롤링 대상 삭제
 */
async function removeCrawlingTarget(guildId, name) {
  await CrawlConfig.deleteOne({ guildId, name });
  if (websiteConfig.has(guildId)) {
    const conf = websiteConfig.get(guildId).get(name);
    if (conf && conf.cron) conf.cron.stop();
    websiteConfig.get(guildId).delete(name);
    if (websiteConfig.get(guildId).size === 0) websiteConfig.delete(guildId);
  }
  console.log(`[크롤러] 크롤링 대상 삭제: ${guildId}/${name}`);
}

/**
 * 현재 등록된 크롤링 대상/상태 출력
 */
function printCrawlingStatus() {
  for (const [guildId, configs] of websiteConfig.entries()) {
    for (const [name, conf] of configs.entries()) {
      console.log(`[상태] ${guildId}/${name}: url=${conf.url}, channel=${conf.channelId}, interval=${conf.interval}, lastPostId=${conf.lastPostId}`);
    }
  }
}
