require('dotenv').config();
const { 
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, PermissionsBitField, MessageFlags 
} = require('discord.js');
const { DisTube } = require('distube');
const { SpotifyPlugin } = require('@distube/spotify');
const { YouTubePlugin } = require('@distube/youtube');
const axios = require('axios');
const cheerio = require('cheerio');
const cron = require('node-cron');
const { FFmpeg } = require('@distube/ffmpeg');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const websiteConfig = new Map();

// 쿠키 문자열을 배열로 변환
const cookies = process.env.YOUTUBE_COOKIE
  ? process.env.YOUTUBE_COOKIE.split(';')
      .map(pair => {
        const idx = pair.indexOf('=');
        if (idx === -1) return null;
        const name = pair.slice(0, idx).trim();
        const value = pair.slice(idx + 1).trim();
        return name && value ? { name, value, domain: '.youtube.com', path: '/' } : null;
      })
      .filter(Boolean)
  : [];

const distube = new DisTube(client, {
  plugins: [
    new SpotifyPlugin(),
    new YouTubePlugin({
      cookies,
      requestOptions: {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
        }
      }
    })
  ],
  ffmpeg: FFmpeg.path,
  emitNewSongOnly: true,
  leaveOnEmpty: false,
  leaveOnStop: false
});

// 동시 재생 방지 큐 시스템
const playQueue = [];
let isPlaying = false;
async function processQueue() {
  if (isPlaying || playQueue.length === 0) return;
  isPlaying = true;
  try {
    const { interaction, query } = playQueue.shift();
    await distube.play(interaction.member.voice.channel, query, {
      member: interaction.member,
      textChannel: interaction.channel
    });
  } catch (error) {
    console.error('큐 처리 오류:', error);
    try { await interaction.editReply({ content: `❌ 오류: ${error.message}` }); } catch {}
  }
  isPlaying = false;
  processQueue();
}

// ----------- 명령어 등록 -----------
client.once('ready', () => {
  client.application.commands.set([
    {
      name: 'play',
      description: '노래 검색 또는 URL로 재생',
      options: [{ name: 'query', type: 3, description: '검색어/URL', required: true }]
    },
    { name: 'skip', description: '현재 곡을 건너뜁니다.' },
    { name: 'queue', description: '재생 대기열을 확인합니다.' },
    { name: 'stop', description: '재생을 중지합니다.' },
    {
      name: '크롤링설정',
      description: '웹사이트 크롤링 설정 (관리자만)',
      options: [
        { name: 'url', type: 3, description: '크롤링할 웹사이트 URL', required: true },
        { name: '채널', type: 7, description: '알림 채널', required: true },
        { name: '간격', type: 4, description: '크롤링 간격(분)', required: false, minValue: 1, maxValue: 1440 }
      ]
    },
    { name: '웹사이트조회', description: '현재 웹사이트 크롤링 설정 확인' },
    { name: '웹사이트삭제', description: '웹사이트 크롤링 설정 삭제' }
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
    const url = options.getString('url');
    const channel = options.getChannel('채널');
    const interval = (options.getInteger('간격') || 5) * 60000;
    if (!channel.isTextBased()) {
      return interaction.reply({ content: '채널은 텍스트 채널이어야 합니다.', flags: MessageFlags.Ephemeral });
    }
    websiteConfig.set(guild.id, { url, channelId: channel.id, interval, lastPostId: null, cron: null });
    setupCron(guild.id);
    return interaction.reply({ 
      content: `웹사이트 크롤링이 설정되었습니다!\nURL: ${url}\n알림 채널: ${channel.name}\n크롤링 간격: ${interval/60000}분`, 
      flags: MessageFlags.Ephemeral
    });
  }
  if (commandName === '웹사이트조회') {
    if (!member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({ content: '관리자만 사용할 수 있습니다.', flags: MessageFlags.Ephemeral });
    }
    const config = websiteConfig.get(guild.id);
    if (!config) return interaction.reply({ content: '설정된 웹사이트가 없습니다.', flags: MessageFlags.Ephemeral });
    return interaction.reply({ content: `현재 설정:\nURL: ${config.url}\n알림 채널: <#${config.channelId}>\n크롤링 간격: ${config.interval/60000}분`, flags: MessageFlags.Ephemeral });
  }
  if (commandName === '웹사이트삭제') {
    if (!member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({ content: '관리자만 사용할 수 있습니다.', flags: MessageFlags.Ephemeral });
    }
    websiteConfig.delete(guild.id);
    return interaction.reply({ content: '웹사이트 크롤링 설정이 삭제되었습니다.', flags: MessageFlags.Ephemeral });
  }

  // --- 음악 명령어 ---
  if (commandName === 'play') {
    const query = options.getString('query');
    if (!member.voice.channel) return interaction.reply({ content: '음성 채널에 먼저 들어가세요!', flags: MessageFlags.Ephemeral });
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      playQueue.push({ interaction, query });
      await processQueue();
      if (!/^https?:\/\//.test(query)) {
        const youtubeSearchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
        await interaction.editReply({
          content: `🎶 첫 번째 결과를 재생합니다.  
🔗 [유튜브에서 직접 검색 결과 보기](${youtubeSearchUrl})\n다른 곡을 원하면 위 링크에서 URL을 복사해 /play에 붙여넣으세요.`,
        });
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
});

// ----------- 음악 컨트롤 버튼 및 임베드 -----------
distube.on('playSong', (queue, song) => {
  const repeatMode = queue.repeatMode === 0 ? '반복 없음' : (queue.repeatMode === 1 ? '한 곡 반복' : '전체 반복');
  const embed = new EmbedBuilder()
    .setTitle('🎵 현재 재생 중')
    .setDescription(`[${song.name}](${song.url})`)
    .addFields(
      { name: '길이', value: song.formattedDuration, inline: true },
      { name: '요청자', value: song.user?.toString() || '알 수 없음', inline: true },
      { name: '반복', value: repeatMode, inline: true }
    )
    .setThumbnail(song.thumbnail)
    .setColor('#2b2d31');
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('pause').setLabel('일시정지').setStyle(ButtonStyle.Secondary).setEmoji('⏸️'),
    new ButtonBuilder().setCustomId('skip').setLabel('스킵').setStyle(ButtonStyle.Primary).setEmoji('⏭️'),
    new ButtonBuilder().setCustomId('stop').setLabel('중지').setStyle(ButtonStyle.Danger).setEmoji('⏹️'),
    new ButtonBuilder().setCustomId('repeat').setLabel('반복').setStyle(ButtonStyle.Success).setEmoji('🔁')
  );
  queue.textChannel.send({ embeds: [embed], components: [row] });
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
      await interaction.reply({ content: '⏭️ 다음 곡으로 스킵했습니다.', flags: MessageFlags.Ephemeral });
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
function setupCron(guildId) {
  const config = websiteConfig.get(guildId);
  if (config && config.cron) config.cron.stop();
  if (config && config.url && config.channelId) {
    config.cron = cron.schedule(`*/${Math.max(1, Math.floor(config.interval / 60000))} * * * *`, () => checkWebsite(guildId));
  }
}

// ----------- 웹크롤링 함수 -----------
async function checkWebsite(guildId) {
  const config = websiteConfig.get(guildId);
  if (!config) return;
  try {
    const { data } = await axios.get(config.url);
    const $ = cheerio.load(data);
    const posts = [];
    const postElements = $('div, article, section, li').toArray();
    for (const el of postElements) {
      const $el = $(el);
      if ($el.text().trim().length === 0) continue;
      const post = {
        id: $el.attr('id') || $el.attr('data-id') || Date.now().toString(),
        title: $el.find('h1,h2,h3,h4,h5,h6,.title,.post-title,.article-title').first().text().trim(),
        link: $el.find('a[href]').attr('href'),
        date: new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }),
        image: $el.find('img').attr('src')
      };
      if (post.title && post.link) posts.push(post);
    }
    if (posts.length > 0 && posts[0].id !== config.lastPostId) {
      config.lastPostId = posts[0].id;
      const channel = client.channels.cache.get(config.channelId);
      if (channel) {
        const embed = new EmbedBuilder()
          .setTitle(posts[0].title)
          .setURL(posts[0].link)
          .setImage(posts[0].image)
          .addFields(
            { name: '등록 시간', value: posts[0].date, inline: true },
            { name: '바로가기', value: `[클릭](${posts[0].link})`, inline: true }
          )
          .setColor('#2b2d31');
        await channel.send({ embeds: [embed] });
      }
    }
  } catch (error) {
    console.error(`크롤링 오류:`, error);
  }
}

// ----------- 에러 핸들링 -----------
distube.on('error', (channel, error) => {
  console.error('DisTube 오류:', error);
  channel.send(`⚠️ 오류 발생: ${error.message.slice(0, 1900)}`);
});
process.on('uncaughtException', error => {
  console.error('처리되지 않은 예외:', error);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('처리되지 않은 프로미스 거부:', promise, '이유:', reason);
});

client.login(process.env.DISCORD_TOKEN);
