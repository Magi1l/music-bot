require('dotenv').config();
const { 
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, 
  PermissionsBitField, MessageFlags, ButtonStyle, REST, Routes, SlashCommandBuilder 
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
const http = require('http');
const { Server } = require('socket.io');
const grantXP = require('./bot/grantXP');
const { initWebSocketServer } = require('./lib/websocket-server');
const Guild = require('./models/Guild');
const fs = require('fs');

const DASHBOARD_API_URL = process.env.DASHBOARD_API_URL;
const DASHBOARD_SHOP_URL = process.env.DASHBOARD_SHOP_URL;

// ===== MongoDB 연결 및 모델 =====
mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('✅ MongoDB 연결 성공'))
  .catch(err => console.error('❌ MongoDB 연결 실패:', err));

const userSchema = new mongoose.Schema({
  userId: String,
  xp: { type: Number, default: 0 },
  level: { type: Number, default: 1 },
  points: { type: Number, default: 0 },
  username: String,
  discriminator: String,
  avatar: String
});
userSchema.index({ userId: 1 }, { unique: true });
userSchema.index({ level: -1 });
const User = mongoose.model('User', userSchema);

const configSchema = new mongoose.Schema({
  xpMultiplier: { type: Number, default: 1 },
  // 필요한 설정 필드 추가 가능
});
const Config = mongoose.model('Config', configSchema);

const profileSchema = new mongoose.Schema({
  userId: String,
  username: String,
  cardUrl: String,
  // 필요한 프로필 필드 추가 가능
});
const Profile = mongoose.model('Profile', profileSchema);

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
const adminCommands = [
  require('./commands/admin/addShopItem'),
  require('./bot/addXpCommand'), // 관리자 명령어에 추가
];
const userCommands = [
  require('./commands/user/ranking'),
  require('./commands/user/previewProfile'),
  require('./commands/user/mabinogiNews'),
  require('./commands/user/setColor'),
  require('./bot/profileImageCommand'), // 유저 명령어에 추가
];

// ===== 설정 캐시 및 주기적 동기화 =====
let cachedConfig = null;
const fetchConfig = async () => {
  cachedConfig = await Config.findOne();
  if (!cachedConfig) {
    cachedConfig = await Config.create({}); // 기본값 생성
  }
};
setInterval(fetchConfig, 5 * 60 * 1000); // 5분마다 동기화
fetchConfig(); // 최초 1회

// ===== 슬래시 명령어 등록 =====
const commands = [
  new SlashCommandBuilder().setName('프로필').setDescription('내 대시보드 프로필 카드를 보여줍니다.'),
  new SlashCommandBuilder().setName('랭킹').setDescription('현재 서버 랭킹을 보여줍니다.'),
  new SlashCommandBuilder().setName('상점').setDescription('대시보드 상점 링크를 안내합니다.'),
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);

// 명령어 등록
async function registerCommands() {
  try {
    const commands = [];
    
    // user 명령어 등록
    const userCommands = fs.readdirSync('./commands/user')
      .filter(file => file.endsWith('.js'))
      .map(file => require(`./commands/user/${file}`));
    
    // admin 명령어 등록
    const adminCommands = fs.readdirSync('./commands/admin')
      .filter(file => file.endsWith('.js'))
      .map(file => require(`./commands/admin/${file}`));
    
    commands.push(...userCommands, ...adminCommands);
    
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands }
    );
    
    console.log('명령어가 성공적으로 등록되었습니다.');
  } catch (error) {
    console.error('명령어 등록 중 오류 발생:', error);
  }
}

// 봇이 준비되면 명령어 등록
client.once('ready', async () => {
  console.log(`${client.user.tag} 봇이 준비되었습니다!`);
  await registerCommands();
});

// ===== 명령어 처리 =====
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;

  if (commandName === '프로필') {
    try {
      const res = await axios.get(`${DASHBOARD_API_URL}/api/profile/${interaction.user.id}`);
      const profile = res.data;
      const embed = new EmbedBuilder()
        .setTitle(`${profile.username}님의 프로필 카드`)
        .setImage(profile.cardUrl)
        .setDescription(profile.description || '');
      await interaction.reply({ embeds: [embed] });
    } catch (err) {
      await interaction.reply('프로필 정보를 불러오지 못했습니다.');
    }
  } else if (commandName === '랭킹') {
    try {
      const res = await axios.get(`${DASHBOARD_API_URL}/api/ranking`);
      const users = res.data;
      const embed = new EmbedBuilder()
        .setTitle('서버 랭킹 TOP 10')
        .setDescription(users.map((u, i) => `**${i+1}위** - ${u.username} (Lv.${u.level}, XP: ${u.xp})`).join('\n'));
      await interaction.reply({ embeds: [embed] });
    } catch (err) {
      await interaction.reply('랭킹 정보를 불러오지 못했습니다.');
    }
  } else if (commandName === '상점') {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('대시보드 상점 바로가기')
        .setStyle(ButtonStyle.Link)
        .setURL(DASHBOARD_SHOP_URL)
    );
    await interaction.reply({ content: '대시보드 상점은 아래 버튼을 클릭하세요!', components: [row] });
  } else {
    const userCommand = userCommands.find(cmd => cmd.data.name === commandName);
    const adminCommand = adminCommands.find(cmd => cmd.data.name === commandName);
    if (adminCommand) {
      await adminCommand.execute(interaction);
    } else if (userCommand) {
      await userCommand.execute(interaction);
    }
  }
});

// ===== 음성 경험치 적립 로직 =====
client.on('voiceStateUpdate', async (oldState, newState) => {
  if (!newState.member || newState.member.user.bot) return;
  const userId = newState.member.id;
  const guildId = newState.guild.id;
  // 입장 시 1회 지급 예시
  if (!oldState.channelId && newState.channelId) {
    setTimeout(async () => {
      const result = await grantXP({
        discordId: userId,
        guildId,
        type: 'voice',
        baseXP: 5,
        channelId: newState.channelId,
        requireMic: !newState.selfMute && !newState.selfDeaf
      });
      // 레벨업 등 후처리 필요시 여기에 추가
    }, 60 * 1000);
  }
});

// ===== 채팅 경험치 적립 로직 개선 =====
client.on('messageCreate', async message => {
  if (message.author.bot) return;
  const guildId = message.guildId;
  const userId = message.author.id;
  const result = await grantXP({
    discordId: userId,
    guildId,
    type: 'message',
    baseXP: 5,
    channelId: message.channel.id
  });
  if (result.success) {
    // 레벨업 처리
    const user = result.user;
    const newLevel = Math.floor(0.1 * Math.sqrt(user.xp));
    if (newLevel > user.level) {
      user.level = newLevel;
      user.points = (user.points || 0) + 100;
      await user.save();
      message.channel.send(`🎉 ${message.author} 레벨 업! (Lv. ${newLevel})\n💰 100포인트가 지급되었습니다!`);
    }
  }
});

// ===== 웹사이트 크롤링 설정 구조 =====
const websiteConfig = new Map(); // guildId → Map(name → config)

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
apiRouter.get('/ranking/all', async (req, res) => {
  try {
    // 모든 유저 랭킹 (레벨, xp 내림차순)
    const users = await User.find().sort({ level: -1, xp: -1 });
    // 색상 역할(닉네임 색상) 추출: roles 필드는 프론트에서 별도 API로 받아야 함 (여기선 userId만 반환)
    res.json(users.map(u => ({
      userId: u.userId,
      level: u.level,
      xp: u.xp,
      points: u.points
      // 색상 hex코드는 프론트에서 Discord API로 roles 중 #RRGGBB 이름을 찾아 표시
    })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
apiRouter.get('/bot/guilds', (req, res) => {
  const guildIds = client.guilds.cache.map(guild => guild.id);
  res.json(guildIds);
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

// ===== WebSocket 서버 통합 (5042 포트) =====
initWebSocketServer(app, User, Profile);

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

// 리액션 XP 지급 (예시: messageReactionAdd)
client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  const guildId = reaction.message.guildId;
  const userId = user.id;
  await grantXP({
    discordId: userId,
    guildId,
    type: 'reaction',
    baseXP: 2,
    channelId: reaction.message.channel.id
  });
});

// 커맨드 XP 지급 (슬래시 명령어 기준)
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  await grantXP({
    discordId: userId,
    guildId,
    type: 'command',
    baseXP: 3,
    channelId: interaction.channelId
  });
  // 기존 명령어 처리 분기(아래에 유지)
  const command = interaction.commandName;
  const userCommand = userCommands.find(cmd => cmd.data.name === command);
  const adminCommand = adminCommands.find(cmd => cmd.data.name === command);
  if (adminCommand) {
    await adminCommand.execute(interaction);
  } else if (userCommand) {
    await userCommand.execute(interaction);
  }
});

// ===== 서버(길드) 정보 DB 저장 및 통계 =====
client.on('guildCreate', async guild => {
  await Guild.findOneAndUpdate(
    { guildId: guild.id },
    { name: guild.name, joinedAt: new Date(), memberCount: guild.memberCount },
    { upsert: true }
  );
  console.log(`[서버 추가] ${guild.name} (${guild.id})`);
});

client.on('guildDelete', async guild => {
  await Guild.deleteOne({ guildId: guild.id });
  console.log(`[서버 제거] ${guild.name} (${guild.id})`);
});

client.on('guildMemberAdd', async member => {
  await Guild.findOneAndUpdate(
    { guildId: member.guild.id },
    { $inc: { memberCount: 1 } }
  );

  try {
    // User 모델에 새 유저 추가
    await User.findOneAndUpdate(
      { userId: member.id },
      {
        userId: member.id,
        username: member.user.username,
        discriminator: member.user.discriminator,
        avatar: member.user.displayAvatarURL(),
        xp: 0,
        level: 1,
        points: 0
      },
      { upsert: true }
    );

    // Profile 모델에 새 프로필 추가
    await Profile.findOneAndUpdate(
      { userId: member.id },
      {
        userId: member.id,
        username: member.user.username,
        cardUrl: member.user.displayAvatarURL()
      },
      { upsert: true }
    );

    console.log(`[프로필] 새 유저 프로필 생성: ${member.user.tag}`);
  } catch (error) {
    console.error('[프로필] 새 유저 프로필 생성 실패:', error);
  }
});

client.on('guildMemberRemove', async member => {
  await Guild.findOneAndUpdate(
    { guildId: member.guild.id },
    { $inc: { memberCount: -1 } }
  );
});

// ===== 메시지 카운트 및 마지막 메시지 시각 =====
const recentActivity = new Map(); // guildId -> Map(userId -> lastActiveDate)
client.on('messageCreate', async message => {
  if (!message.guild || message.author.bot) return;
  await Guild.findOneAndUpdate(
    { guildId: message.guild.id },
    {
      $inc: { messageCount: 1 },
      $set: { lastMessageAt: new Date() }
    }
  );
  // 최근 활동 멤버 기록
  if (!recentActivity.has(message.guild.id)) recentActivity.set(message.guild.id, new Map());
  recentActivity.get(message.guild.id).set(message.author.id, new Date());
});

// ===== 활성 멤버 집계 (매일 1회) =====
cron.schedule('0 4 * * *', async () => {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const guilds = await Guild.find();
  for (const guild of guilds) {
    let activeCount = 0;
    const activity = recentActivity.get(guild.guildId);
    if (activity) {
      for (const lastActive of activity.values()) {
        if (lastActive > sevenDaysAgo) activeCount++;
      }
    }
    await Guild.updateOne({ guildId: guild.guildId }, { activeMemberCount: activeCount });
  }
  console.log('[통계] 활성 멤버 수 집계 완료');
});

// ===== 서버 리스트 API =====
app.get('/api/guilds', async (req, res) => {
  try {
    const guilds = await Guild.find();
    res.json(guilds);
  } catch (err) {
    res.status(500).json({ error: '서버 목록을 불러오지 못했습니다.' });
  }
});

// 유저 정보 업데이트
client.on('userUpdate', async (oldUser, newUser) => {
  try {
    // User 모델 업데이트
    await User.updateOne(
      { userId: newUser.id },
      {
        username: newUser.username,
        discriminator: newUser.discriminator,
        avatar: newUser.displayAvatarURL()
      }
    );

    // Profile 모델 업데이트
    await Profile.updateOne(
      { userId: newUser.id },
      {
        username: newUser.username,
        cardUrl: newUser.displayAvatarURL()
      }
    );

    console.log(`[프로필] 유저 정보 업데이트: ${newUser.tag}`);
  } catch (error) {
    console.error('[프로필] 유저 정보 업데이트 실패:', error);
  }
});
