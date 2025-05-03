// 환경 변수 로드
require('dotenv').config();

const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { DisTube } = require('distube');
const { SpotifyPlugin } = require('@distube/spotify');
const { YtDlpPlugin } = require('@distube/yt-dlp');
const axios = require('axios');
const cheerio = require('cheerio');
const cron = require('node-cron');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// DisTube 초기화 (yt-dlp 플러그인 필수)
const distube = new DisTube(client, {
  plugins: [
    new SpotifyPlugin(),
    new YtDlpPlugin({
      update: true // 주기적 yt-dlp 업데이트
    })
  ],
  searchSongs: 5,
  leaveOnEmpty: false,
  emitNewSongOnly: true,
  customFilters: {
    bassboost: 'bass=g=8,dynaudnorm=f=200'
  }
});

// 음악 컨트롤 버튼 시스템
const createControlButtons = (queue) => new ActionRowBuilder().addComponents(
  new ButtonBuilder()
    .setCustomId('pause')
    .setLabel(queue.paused ? '재개' : '일시정지')
    .setStyle(queue.paused ? ButtonStyle.Success : ButtonStyle.Primary)
    .setEmoji(queue.paused ? '▶️' : '⏸️'),
  new ButtonBuilder()
    .setCustomId('skip')
    .setLabel('스킵')
    .setStyle(ButtonStyle.Secondary)
    .setEmoji('⏭️'),
  new ButtonBuilder()
    .setCustomId('stop')
    .setLabel('중지')
    .setStyle(ButtonStyle.Danger)
    .setEmoji('⏹️'),
  new ButtonBuilder()
    .setCustomId('loop')
    .setLabel(queue.repeatMode ? '반복 해제' : '반복')
    .setStyle(queue.repeatMode ? ButtonStyle.Danger : ButtonStyle.Success)
    .setEmoji('🔁'),
  new ButtonBuilder()
    .setCustomId('queue')
    .setLabel('대기열')
    .setStyle(ButtonStyle.Secondary)
    .setEmoji('📜')
);

client.on('ready', () => {
  console.log(`${client.user.tag} 준비 완료!`);
});

// 슬래시 명령어 처리
client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand()) return;

  const { commandName, options } = interaction;

  switch(commandName) {
    case 'play':
      const query = options.getString('query');
      const voiceChannel = interaction.member.voice.channel;
      
      if (!voiceChannel) {
        return interaction.reply('음성 채널에 먼저 접속하세요!');
      }

      await interaction.deferReply();
      
      try {
        await distube.play(voiceChannel, query, {
          member: interaction.member,
          textChannel: interaction.channel
        });
        
        await interaction.editReply(`🔍 **${query}** 검색 중...`);
      } catch (error) {
        await interaction.editReply(`❌ 오류 발생: ${error.message}`);
      }
      break;

    case 'stop':
      const queue = distube.getQueue(interaction.guild);
      if (!queue) return interaction.reply('재생 중인 노래가 없습니다.');
      queue.stop();
      interaction.reply('⏹️ 재생 중지');
      break;
      
    case 'skip':
      const skipQueue = distube.getQueue(interaction.guild);
      if (!skipQueue) return interaction.reply('재생 중인 노래가 없습니다.');
      skipQueue.skip();
      interaction.reply('⏭️ 다음 곡으로 넘어갑니다.');
      break;
      
    case 'queue':
      const queueList = distube.getQueue(interaction.guild);
      if (!queueList || queueList.songs.length === 0)
        return interaction.reply('재생 목록이 비어있습니다.');
      
      const songs = queueList.songs.map((song, i) => 
        `${i + 1}. [${song.name}](${song.url})`
      ).join('\n');
      
      interaction.reply(`🎶 **재생 대기열**\n${songs}`);
      break;
  }
});

// 버튼 인터랙션 처리
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;

  const queue = distube.getQueue(interaction.guild);
  if (!queue) return interaction.reply('재생 중인 노래가 없습니다.');

  switch(interaction.customId) {
    case 'pause':
      queue.pause(!queue.paused);
      await interaction.update({ components: [createControlButtons(queue)] });
      break;

    case 'skip':
      queue.skip();
      interaction.reply('⏭️ 다음 곡으로 넘어갑니다.');
      break;

    case 'stop':
      queue.stop();
      interaction.reply('⏹️ 재생을 중지했습니다.');
      break;

    case 'loop':
      queue.setRepeatMode(queue.repeatMode ? 0 : 2);
      await interaction.update({ components: [createControlButtons(queue)] });
      break;

    case 'queue':
      const songs = queue.songs.map((song, i) => 
        `${i + 1}. [${song.name}](${song.url})`
      ).join('\n');
      interaction.reply(`🎶 **재생 대기열**\n${songs}`);
      break;
  }
});

// 노래 재생 시작 이벤트
distube.on('playSong', (queue, song) => {
  const embed = new EmbedBuilder()
    .setTitle('🎵 현재 재생 중')
    .setDescription(`[${song.name}](${song.url})`)
    .addFields(
      { name: '길이', value: song.formattedDuration, inline: true },
      { name: '요청자', value: song.user.toString(), inline: true }
    )
    .setThumbnail(song.thumbnail)
    .setColor('#2b2d31');

  queue.textChannel.send({
    embeds: [embed],
    components: [createControlButtons(queue)]
  });
});

// 재생 종료 시 메시지 정리
distube.on('finish', queue => {
  queue.textChannel.send('🎶 모든 재생이 완료되었습니다.');
});

// 오류 발생시 처리
distube.on('error', (channel, error) => {
  console.error('음악 재생 오류:', error);
  if (channel) channel.send(`음악 재생 중 오류가 발생했습니다: ${error.toString().slice(0, 1900)}`);
});

// 음성 채널 연결 이벤트 처리
distube.on('initQueue', (queue) => {
  queue.autoplay = false;
  queue.volume = 100;
});

// 오류 처리
process.on('unhandledRejection', error => {
  console.error('미처리된 프로미스 거부:', error);
});

// 간단한 명령어 등록
client.once('ready', async () => {
  try {
    const data = [
      {
        name: 'play',
        description: '음악을 재생합니다.',
        options: [{
          name: 'query',
          description: '검색어 또는 URL',
          type: 3,
          required: true
        }]
      },
      {
        name: 'skip',
        description: '현재 재생 중인 곡을 건너뜁니다.'
      },
      {
        name: 'stop',
        description: '재생을 중지합니다.'
      },
      {
        name: 'queue',
        description: '재생 대기열을 확인합니다.'
      }
    ];

    await client.application.commands.set(data);
    console.log('슬래시 명령어 등록 완료');
  } catch (error) {
    console.error('명령어 등록 오류:', error);
  }
});

// 봇 로그인
client.login(process.env.DISCORD_TOKEN).catch(error => {
  console.error('로그인 오류:', error.message);
});
