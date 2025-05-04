require('dotenv').config();
const { 
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, 
  PermissionsBitField, MessageFlags, ButtonStyle 
} = require('discord.js');
const { DisTube } = require('distube');
const { SpotifyPlugin } = require('@distube/spotify');
const { SoundCloudPlugin } = require('@distube/soundcloud');
// const { YouTubePlugin } = require('@distube/youtube'); // << 유튜브 플러그인 임시 주석 처리
const axios = require('axios');
const cheerio = require('cheerio');
const cron = require('node-cron');
const mongoose = require('mongoose');
const express = require('express');

// MongoDB 연결 (불필요 옵션 제거, 연결 성공/실패 로그 추가)
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB 연결 성공'))
  .catch(err => console.error('❌ MongoDB 연결 실패:', err));
const userSchema = new mongoose.Schema({
  userId: String,
  xp: { type: Number, default: 0 },
  level: { type: Number, default: 1 },
  points: { type: Number, default: 0 }
});
// 인덱스 추가 (성능 최적화)
userSchema.index({ userId: 1 }, { unique: true });
userSchema.index({ level: -1 });
const User = mongoose.model('User', userSchema);

// 공지 채널 설정용 noticeConfig 스키마/모델 추가
const noticeConfigSchema = new mongoose.Schema({
  guildId: String,
  noticeChannelId: String
});
const NoticeConfig = mongoose.model('NoticeConfig', noticeConfigSchema);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

// 크롤링 설정 저장 구조 (최상단에 선언)
const websiteConfig = new Map(); // guildId → Map(name → config)

// 쿠키 파싱 로직
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
    // new YouTubePlugin({ cookies }), // << 유튜브 플러그인 임시 주석 처리
  ],
  emitNewSongOnly: true,
  nsfw: false,
});

// 동시 재생 방지 큐 시스템
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
    // 재생 후 큐에 곡이 없으면 안내
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

// 상대경로 처리 함수
function resolveUrl(link, baseUrl) {
  try {
    return new URL(link, baseUrl).href;
  } catch {
    return null;
  }
}

// 사이트 구조 유연화 함수
function extractPost($, el, baseUrl) {
  const $el = $(el);
  const title = $el.find('[itemprop="name"], .title, h1, h2').first().text().trim();
  const rawLink = $el.find('[href], [data-url]').attr('href') || $el.attr('data-url');
  const link = resolveUrl(rawLink, baseUrl);
  const image = $el.find('img').attr('src') || $el.find('[itemprop="image"]').attr('content');
  return { title, link, image };
}

// ----------- 명령어 등록 -----------
client.once('ready', () => {
  client.application.commands.set([
    {
      name: '색상설정',
      description: 'HEX 코드로 닉네임 색상 변경',
      options: [{
        name: 'hex코드',
        type: 3,
        description: '#을 제외한 6자리 코드 (예: FF0000)',
        required: true
      }]
    },
    {
      name: '운세',
      description: '오늘의 운세 확인'
    },
    {
      name: '익명',
      description: '익명 메시지 전송',
      options: [{
        name: '메시지',
        type: 3,
        description: '전송할 내용',
        required: true
      }]
    },
    {
      name: 'play',
      description: '노래 검색 또는 URL로 재생',
      options: [
        { name: 'query', type: 3, description: '검색어/URL', required: true },
        { 
          name: 'source', 
          type: 3, 
          description: '검색 우선 소스 (youtube/spotify/soundcloud)', 
          required: false, 
          choices: [
            { name: 'YouTube', value: 'youtube' },
            { name: 'Spotify', value: 'spotify' },
            { name: 'SoundCloud', value: 'soundcloud' }
          ]
        }
      ]
    },
    { name: 'skip', description: '현재 곡을 건너뜁니다.' },
    { name: 'queue', description: '재생 대기열을 확인합니다.' },
    { name: 'stop', description: '재생을 중지합니다.' },
    {
      name: '크롤링설정',
      description: '웹사이트 크롤링 설정 (관리자만)',
      options: [
        { name: 'name', type: 3, description: '설정 이름', required: true },
        { name: 'url', type: 3, description: '크롤링할 웹사이트 URL', required: true },
        { name: '채널', type: 7, description: '알림 채널', required: true },
        { name: '간격', type: 4, description: '크롤링 간격(분)', required: false, minValue: 1, maxValue: 1440 }
      ]
    },
    { name: '웹사이트조회', description: '현재 웹사이트 크롤링 설정 확인' },
    {
      name: '웹사이트삭제',
      description: '웹사이트 크롤링 설정 삭제',
      options: [
        { name: 'name', type: 3, description: '삭제할 설정 이름', required: true }
      ]
    },
    {
      name: '공지채널설정',
      description: '공지사항을 보낼 채널을 설정합니다',
      options: [{
        name: '채널',
        type: 7, // 채널 타입
        description: '공지사항을 보낼 텍스트 채널',
        required: true
      }]
    },
  ]);
  console.log(`${client.user.tag} 온라인!`);
});

// ----------- 명령어 처리 -----------
client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand()) return;
  const { commandName, options, guild, member } = interaction;

  // --- 웹사이트 크롤링 명령어 ---
  if (commandName === '크롤링설정') {
    if (!member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({ content: '관리자만 사용할 수 있습니다.', flags: MessageFlags.Ephemeral });
    }
    const name = options.getString('name');
    const url = options.getString('url');
    const channel = options.getChannel('채널');
    const interval = (options.getInteger('간격') || 5) * 60000;
    if (!channel.isTextBased()) {
      return interaction.reply({ content: '채널은 텍스트 채널이어야 합니다.', flags: MessageFlags.Ephemeral });
    }
    let guildConfigs = websiteConfig.get(guild.id);
    if (!guildConfigs) guildConfigs = new Map();
    if (guildConfigs.has(name)) {
      return interaction.reply({ content: '이미 등록된 이름입니다.', flags: MessageFlags.Ephemeral });
    }
    const config = { url, channelId: channel.id, interval, lastPostId: null, cron: null };
    guildConfigs.set(name, config);
    websiteConfig.set(guild.id, guildConfigs);
    setupCron(guild.id, name, config);
    return interaction.reply({ 
      content: `웹사이트 크롤링이 추가되었습니다!\n이름: ${name}\nURL: ${url}\n알림 채널: ${channel.name}\n크롤링 간격: ${interval/60000}분`, 
      flags: MessageFlags.Ephemeral
    });
  }
  if (commandName === '웹사이트조회') {
    if (!member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({ content: '관리자만 사용할 수 있습니다.', flags: MessageFlags.Ephemeral });
    }
    const guildConfigs = websiteConfig.get(guild.id);
    if (!guildConfigs || guildConfigs.size === 0) return interaction.reply({ content: '설정된 웹사이트가 없습니다.', flags: MessageFlags.Ephemeral });
    let msg = Array.from(guildConfigs.entries()).map(([name, cfg], i) => `#${i+1}\n이름: ${name}\nURL: ${cfg.url}\n알림 채널: <#${cfg.channelId}>\n크롤링 간격: ${cfg.interval/60000}분`).join('\n\n');
    return interaction.reply({ content: `현재 설정:\n${msg}`, flags: MessageFlags.Ephemeral });
  }
  if (commandName === '웹사이트삭제') {
    if (!member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({ content: '관리자만 사용할 수 있습니다.', flags: MessageFlags.Ephemeral });
    }
    const name = options.getString('name');
    let guildConfigs = websiteConfig.get(guild.id);
    if (!guildConfigs) return interaction.reply({ content: '설정된 웹사이트가 없습니다.', flags: MessageFlags.Ephemeral });
    const config = guildConfigs.get(name);
    if (!config) return interaction.reply({ content: '해당 이름이 등록되어 있지 않습니다.', flags: MessageFlags.Ephemeral });
    if (config.cron) config.cron.stop();
    guildConfigs.delete(name);
    websiteConfig.set(guild.id, guildConfigs);
    return interaction.reply({ content: '웹사이트 크롤링 설정이 삭제되었습니다.', flags: MessageFlags.Ephemeral });
  }

  // --- 음악 명령어 ---
  if (commandName === 'play') {
    const query = options.getString('query');
    const source = options.getString('source') || 'youtube';
    if (!member.voice.channel) return interaction.reply({ content: '음성 채널에 먼저 들어가세요!', flags: MessageFlags.Ephemeral });

    // 유튜브 링크 또는 source가 youtube일 때 안내
    if (source === 'youtube' || /youtu(be\.com|\.be)\//.test(query)) {
      return interaction.reply({ content: '❌ 유튜브는 현재 재생할 수 없습니다. SoundCloud 또는 Spotify를 이용해 주세요.', flags: MessageFlags.Ephemeral });
    }

    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      let playQuery = query;
      if (source === 'spotify' && !/^https?:\/\//.test(query) && !query.startsWith('spotify:')) {
        playQuery = `spotify:${query}`;
      } else if (source === 'soundcloud' && !/^https?:\/\//.test(query) && !query.startsWith('scsearch:')) {
        playQuery = `scsearch:"${query}"`;
      }
      // 디버그: SoundCloud 검색 쿼리 출력
      // if (source === 'soundcloud') {
      //   console.log('SoundCloud 검색 시도:', playQuery);
      //   const results = await distube.search(playQuery, { limit: 1 }).catch(() => []);
      //   console.log('검색 결과:', results);
      //   if (!results || results.length === 0) {
      //     return interaction.editReply({ content: `🔍 SoundCloud에서 "${query}" 검색 결과가 없습니다. 직접 링크를 입력해주세요.` });
      //   }
      // }
      playQueue.push({ interaction, query: playQuery, originalQuery: query, source });
      await processQueue();
      if (!/^https?:\/\//.test(query)) {
        if (source === 'spotify') {
          await interaction.editReply({
            content: `🎶 Spotify에서 첫 번째 결과를 재생합니다.\n다른 곡을 원하면 Spotify에서 URL을 복사해 /play에 붙여넣으세요.`
          });
        } else if (source === 'soundcloud') {
          await interaction.editReply({
            content: `🎶 SoundCloud에서 첫 번째 결과를 재생합니다.\n다른 곡을 원하면 SoundCloud에서 URL을 복사해 /play에 붙여넣으세요.`
          });
        }
      } else {
        await interaction.editReply({ content: '🎶 재생을 시작합니다.' });
      }
    } catch (error) {
      await interaction.editReply({ content: `❌ 오류: ${error.message}` });
    }
    return;
  }
  if (commandName === 'skip') {
    const queue = distube.getQueue(guild.id);
    if (!queue) return interaction.reply({ content: '재생 중인 곡이 없습니다.', flags: MessageFlags.Ephemeral });
    queue.skip();
    interaction.reply({ content: '⏭️ 다음 곡으로 스킵했습니다!', flags: MessageFlags.Ephemeral });
    return;
  }
  if (commandName === 'queue') {
    const queue = distube.getQueue(guild.id);
    if (!queue || queue.songs.length === 0) return interaction.reply({ content: '재생 목록이 비어있습니다.', flags: MessageFlags.Ephemeral });
    const embed = new EmbedBuilder()
      .setTitle('재생 목록')
      .setDescription(queue.songs.map((song, index) => `${index + 1}. [${song.name}](${song.url})`).join('\n'))
      .setColor('Random');
    interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    return;
  }
  if (commandName === 'stop') {
    const queue = distube.getQueue(guild.id);
    if (!queue) return interaction.reply({ content: '재생 중인 곡이 없습니다.', flags: MessageFlags.Ephemeral });
    queue.stop();
    interaction.reply({ content: '⏹️ 재생을 중지했습니다.', flags: MessageFlags.Ephemeral });
    return;
  }

  // 1. 닉네임 색상 시스템
  if (commandName === '색상설정') {
    const color = options.getString('hex코드').replace('#', '');
    if (!/^[0-9A-Fa-f]{6}$/i.test(color)) return interaction.reply({ content: '❌ 올바른 HEX 코드를 입력해주세요!', ephemeral: true });
    
    const roleName = `COLOR-${color}`;
    let role = guild.roles.cache.find(r => r.name === roleName);
    
    if (!role) {
      role = await guild.roles.create({
        name: roleName,
        color: parseInt(color, 16),
        permissions: []
      });
    }
    
    await member.roles.add(role);
    interaction.reply({ content: `✅ #${color} 색상이 적용되었습니다!`, ephemeral: true });
  }

  // 2. 레벨 시스템
  if (commandName === '운세') {
    const dateSeed = new Date().toISOString().split('T')[0] + interaction.user.id;
    const hash = dateSeed.split('').reduce((a,c) => a + c.charCodeAt(0), 0);
    interaction.reply(`🔮 오늘의 운세: ${fortunes[hash % 4]}`);
  }

  // 3. 웹훅 연동 시스템
  if (commandName === '익명') {
    const msg = options.getString('메시지');
    interaction.channel.send({
      embeds: [new EmbedBuilder()
        .setDescription(msg)
        .setColor(0x2F3136)
        .setFooter({ text: '익명 메시지' })
      ]
    });
    interaction.reply({ content: '✅ 메시지 전송 완료', ephemeral: true });
  }

  // /공지채널설정 명령어 처리
  if (commandName === '공지채널설정') {
    const channel = options.getChannel('채널');
    if (!channel || !channel.isTextBased()) {
      return interaction.reply({ content: '텍스트 채널만 지정할 수 있습니다.', ephemeral: true });
    }
    await NoticeConfig.findOneAndUpdate(
      { guildId: interaction.guild.id },
      { noticeChannelId: channel.id },
      { upsert: true }
    );
    interaction.reply({ content: `✅ 공지 채널이 <#${channel.id}>로 설정되었습니다!`, ephemeral: true });
  }
});

// ----------- 음악 컨트롤 버튼 및 임베드 -----------
distube.on('playSong', async (queue, song) => {
  try {
    if (!song || !queue || !queue.textChannel) return;
    // 채널 안전 fetch
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

// ----------- 컨트롤 버튼 처리 -----------
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

// ----------- 웹크롤링 스케줄러 -----------
function setupCron(guildId, name, config) {
  if (config.cron) config.cron.stop();
  if (config.url && config.channelId) {
    config.cron = cron.schedule(`*/${Math.max(1, Math.floor(config.interval / 60000))} * * * *`, () => checkWebsite(guildId, name));
  }
}

// ----------- 웹크롤링 함수 -----------
async function checkWebsite(guildId, name) {
  const guildConfigs = websiteConfig.get(guildId);
  if (!guildConfigs) return;
  const config = guildConfigs.get(name);
  if (!config) return;
  try {
    const { data } = await axios.get(config.url);
    const $ = cheerio.load(data);
    const posts = [];
    const postElements = $('div, article, section, li').toArray();
    for (const el of postElements) {
      try {
        const post = extractPost($, el, config.url);
        if (post.title && post.link) posts.push(post);
      } catch (e) {
        // 개별 포스트 추출 실패는 무시
      }
    }
    if (posts.length > 0 && posts[0].title !== config.lastPostId) {
      config.lastPostId = posts[0].title;
      // 채널 안전 fetch
      const channel = await client.channels.fetch(config.channelId).catch(() => null);
      if (!channel?.isTextBased()) return;
      const embed = new EmbedBuilder()
        .setTitle(posts[0].title)
        .setURL(posts[0].link)
        .setImage(posts[0].image)
        .addFields(
          { name: '바로가기', value: `[클릭](${posts[0].link})`, inline: true }
        )
        .setColor('#2b2d31');
      await channel.send({ embeds: [embed] });
    }
  } catch (error) {
    console.error(`크롤링 오류:`, error);
  }
}

// ----------- 에러 핸들링 -----------
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

// 6. 대시보드 API (서버 랭킹)
const dashboardApp = express();
dashboardApp.get('/api/users', async (req, res) => {
  const users = await User.find().sort({ level: -1, xp: -1 }).limit(10);
  res.json(users);
});
dashboardApp.listen(3001);

// 웹훅 연동 시스템에서 공지 채널을 DB에서 조회
const webhookApp = express();
webhookApp.post('/webhook', async (req, res) => {
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

process.on('uncaughtException', error => {
  console.error('처리되지 않은 예외:', error);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('처리되지 않은 프로미스 거부:', promise, '이유:', reason);
});

client.login(process.env.DISCORD_TOKEN);
