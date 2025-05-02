require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { Node, Manager } = require('lavalink-client');
const { joinVoiceChannel, createAudioPlayer, createAudioResource } = require('@discordjs/voice');
const axios = require('axios');
const cheerio = require('cheerio');
const cron = require('node-cron');
const { parseDOM } = require('html-parse-stringify2');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const manager = new Manager({
  nodes: [
    new Node({
      host: process.env.LAVA_HOST || 'localhost',
      port: process.env.LAVA_PORT || 2333,
      password: process.env.LAVA_PASSWORD || 'youshallnotpass',
      secure: process.env.LAVA_SECURE === 'true'
    })
  ],
  send: (guildId, payload) => {
    const guild = client.guilds.cache.get(guildId);
    if (guild) guild.shard.send(payload);
  }
});

// 웹사이트 크롤링 설정 저장소
const websiteConfig = new Map();

// 웹사이트 크롤링 함수
async function checkWebsite(guildId) {
  const config = websiteConfig.get(guildId);
  if (!config) return;

  try {
    const response = await axios.get(config.url);
    const $ = cheerio.load(response.data);
    const html = response.data;
    
    // 게시글 요소 자동 탐색
    const posts = [];
    const postElements = $('div, article, section, li').toArray();
    
    for (const el of postElements) {
      const $el = $(el);
      
      // 게시글이 아닌 요소 필터링
      if (!isPostElement($el)) continue;
      
      // 게시글 정보 추출
      const post = {
        id: getPostId($el),
        title: getPostTitle($el),
        link: getPostLink($el),
        date: getPostDate($el),
        image: getPostImage($el)
      };
      
      if (post.title && post.link) {
        posts.push(post);
      }
    }

    function isPostElement($el) {
      // 게시글이 아닌 요소 필터링
      const text = $el.text().trim();
      return text.length > 0 && !text.includes('페이지') && !text.includes('검색');
    }

    function getPostId($el) {
      return $el.attr('id') || $el.attr('data-id') || $el.attr('data-post-id') || $el.attr('data-article-id') || Date.now().toString();
    }

    function getPostTitle($el) {
      // 제목을 찾는 여러 방법 시도
      const titleSelectors = [
        'h1, h2, h3, h4, h5, h6',
        '.title, .post-title, .article-title',
        'a[href]:contains("read")',
        'a[href]:contains("view")'
      ];
      
      for (const selector of titleSelectors) {
        const title = $el.find(selector).text().trim();
        if (title) return title;
      }
      return '';
    }

    function getPostLink($el) {
      // 링크를 찾는 여러 방법 시도
      const linkSelectors = [
        'a[href]',
        'button[href]',
        '[data-href]',
        '[data-link]'
      ];
      
      for (const selector of linkSelectors) {
        const link = $el.find(selector).attr('href');
        if (link) return link.startsWith('http') ? link : config.url + link;
      }
      return '';
    }

    function getPostDate($el) {
      // 날짜를 찾는 여러 방법 시도
      const dateSelectors = [
        '.date, .post-date, .article-date',
        'time',
        'span[data-date]',
        'div[data-date]'
      ];
      
      for (const selector of dateSelectors) {
        const date = $el.find(selector).text().trim();
        if (date) return date;
      }
      return '';
    }

    function getPostImage($el) {
      // 이미지를 찾는 여러 방법 시도
      const imageSelectors = [
        'img',
        '[data-image]',
        '[data-src]',
        '[style*="background-image"]'
      ];
      
      for (const selector of imageSelectors) {
        const $img = $el.find(selector);
        if ($img.length > 0) {
          const src = $img.attr('src') || 
                    $img.attr('data-image') || 
                    $img.attr('data-src') || 
                    $img.css('background-image').replace(/url\("|"\)/g, '');
          if (src) return src.startsWith('http') ? src : config.url + src;
        }
      }
      return null;
    }

    if (posts.length > 0 && posts[0].id !== config.lastPostId) {
      config.lastPostId = posts[0].id;
      
      const channel = client.channels.cache.get(config.channelId);
      if (channel) {
        const embed = new EmbedBuilder()
          .setTitle('새로운 게시글이 올라왔어요!')
          .setDescription(`[${posts[0].title}](${posts[0].link})`)
          .addFields(
            { name: '날짜', value: posts[0].date, inline: true }
          )
          .setColor('Random');

        // 이미지가 있을 경우 Embed에 추가
        if (posts[0].image) {
          embed.setThumbnail(posts[0].image);
        }

        await channel.send({ embeds: [embed] });
      }
    }
  } catch (error) {
    console.error(`서버 ${guildId}의 웹사이트 크롤링 중 오류:`, error);
  }
}

// 주기적인 크롤링 설정
function setupCron(guildId) {
  const config = websiteConfig.get(guildId);
  if (config && config.cron) {
    config.cron.destroy();
  }

  if (config && config.url && config.channelId) {
    config.cron = cron.schedule(`*/${Math.floor(config.interval / 60000)} * * * *`, () => checkWebsite(guildId));
  }
}

const nowPlayingMessages = new Map();

client.once('ready', () => {
  console.log(`${client.user.tag} 온라인!`);
  manager.init(client.user.id);
  registerCommands();
});

client.on('raw', d => manager.updateVoiceState(d));

// 슬래시 명령어 등록
async function registerCommands() {
  try {
    await client.application.commands.set([
      {
        name: 'play',
        description: '노래 재생',
        options: [{ name: 'query', type: 3, description: '노래 제목 또는 링크', required: true }]
      },
      {
        name: 'skip',
        description: '현재 재생 중인 노래 건너뛰기'
      },
      {
        name: 'queue',
        description: '대기열 확인'
      },
      {
        name: 'website',
        description: '웹사이트 크롤링 설정 (관리자만 사용 가능)',
        options: [
          {
            name: 'url',
            description: '크롤링할 웹사이트 URL',
            type: 3,
            required: false
          },
          {
            name: 'channel',
            description: '알림을 보낼 채널',
            type: 7,
            required: false
          },
          {
            name: 'interval',
            description: '체크 간격 (초)',
            type: 4,
            required: false,
            choices: [
              { name: '1분', value: 60 },
              { name: '5분', value: 300 },
              { name: '10분', value: 600 },
              { name: '30분', value: 1800 },
              { name: '1시간', value: 3600 }
            ]
          },
          {
            name: 'remove',
            description: '설정 제거',
            type: 5,
            required: false
          }
        ],
        default_member_permissions: ['Administrator']
      }
    ]);
  } catch (error) {
    console.error('명령어 등록 중 오류:', error);
  }
}

// 슬래시 명령어 처리
client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand()) return;

  const member = interaction.member;
  const player = manager.players.get(interaction.guild.id);

  try {
    if (interaction.commandName === 'play') {
      const query = interaction.options.getString('query');
      if (!member.voice.channelId) return interaction.reply({ content: '음성 채널에 먼저 들어가세요!', ephemeral: true });

      if (!player) {
        manager.create({
          guildId: interaction.guild.id,
          voiceChannelId: member.voice.channelId,
          textChannelId: interaction.channel.id,
          selfDeaf: true
        });
      }

      joinVoiceChannel({
        channelId: member.voice.channelId,
        guildId: interaction.guild.id,
        adapterCreator: interaction.guild.voiceAdapterCreator
      });

      await interaction.deferReply();
      const res = await player.search(query, interaction.user);
      
      if (!res.tracks.length) return interaction.editReply('검색 결과가 없습니다.');

      player.queue.add(res.tracks[0]);
      if (!player.playing) player.play();

      await interaction.editReply(`**${res.tracks[0].title}**(이)가 대기열에 추가되었습니다.`);
    }

    if (interaction.commandName === 'skip') {
      if (!player) return interaction.reply({ content: '재생 중인 곡이 없습니다.', ephemeral: true });
      player.skip();
      await interaction.reply({ content: '⏭️ 다음 곡으로 건너뛰었습니다.', ephemeral: true });
    }

    if (interaction.commandName === 'queue') {
      if (!player) return interaction.reply({ content: '재생 중인 곡이 없습니다.', ephemeral: true });
      if (!player.queue.size) return interaction.reply({ content: '대기열이 비어있어요.', ephemeral: true });
      
      const queueList = player.queue.map((t, i) => `${i + 1}. ${t.title}`).join('\n');
      await interaction.reply({ content: `**대기열**\n${queueList}`, ephemeral: true });
    }

    if (interaction.commandName === 'website') {
      // 관리자 권한 확인
      if (!interaction.member.permissions.has('Administrator')) {
        return interaction.reply({ 
          content: '이 명령어는 관리자만 사용할 수 있습니다.', 
          ephemeral: true 
        });
      }

      const url = interaction.options.getString('url');
      const channel = interaction.options.getChannel('channel');
      const interval = interaction.options.getInteger('interval');
      const remove = interaction.options.getBoolean('remove');

      if (remove) {
        websiteConfig.delete(interaction.guild.id);
        await interaction.reply({ content: '웹사이트 크롤링 설정이 제거되었습니다.', ephemeral: true });
        return;
      }

      if (!url || !channel || !interval) {
        const currentConfig = websiteConfig.get(interaction.guild.id);
        if (currentConfig) {
          await interaction.reply({
            content: `현재 설정:\nURL: ${currentConfig.url}\n채널: <#${currentConfig.channelId}>\n체크 간격: ${currentConfig.interval / 60}분`,
            ephemeral: true
          });
          return;
        } else {
          await interaction.reply({ content: '설정이 아직 없습니다.', ephemeral: true });
          return;
        }
      }

      websiteConfig.set(interaction.guild.id, {
        url: url,
        channelId: channel.id,
        interval: interval * 1000,
        lastPostId: null
      });

      setupCron(interaction.guild.id);
      await interaction.reply({
        content: `웹사이트 크롤링이 설정되었습니다!\nURL: ${url}\n채널: <#${channel.id}>\n체크 간격: ${interval / 60}분`,
        ephemeral: true
      });
    }
  } catch (error) {
    console.error('명령어 실행 중 오류:', error);
    await interaction.reply({ content: '명령어 실행 중 오류가 발생했습니다.', ephemeral: true });
  }
});

// 버튼 인터랙션 처리
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  const player = manager.players.get(interaction.guild.id);
  if (!player) return interaction.reply({ content: '재생 중인 곡이 없습니다.', ephemeral: true });

  try {
    switch (interaction.customId) {
      case 'stop':
        player.destroy();
        await interaction.reply({ content: '⏹️ 재생을 중지했습니다.', ephemeral: true });
        break;
      case 'repeat':
        player.setTrackRepeat(!player.trackRepeat);
        await interaction.reply({ content: player.trackRepeat ? '🔁 반복 재생 ON' : '🔁 반복 재생 OFF', ephemeral: true });
        break;
      case 'queue':
        if (!player.queue.size) return interaction.reply({ content: '대기열이 비어있어요.', ephemeral: true });
        const queueList = player.queue.map((t, i) => `${i + 1}. ${t.title}`).join('\n');
        await interaction.reply({ content: `**대기열**\n${queueList}`, ephemeral: true });
        break;
    }
  } catch (error) {
    console.error('버튼 인터랙션 중 오류:', error);
    await interaction.reply({ content: '버튼 처리 중 오류가 발생했습니다.', ephemeral: true });
  }
});

// 노래 시작 시 메시지 표시 및 버튼 생성
manager.on('trackStart', async (player, track) => {
  const channel = client.channels.cache.get(player.textChannelId);
  if (!channel) return;

  try {
    // 이전 메시지 삭제
    if (nowPlayingMessages.has(player.guildId)) {
      try {
        const oldMsg = await channel.messages.fetch(nowPlayingMessages.get(player.guildId));
        await oldMsg.delete().catch(() => {});
      } catch {}
    }

    const embed = new EmbedBuilder()
      .setTitle('🎵 현재 재생 중')
      .setDescription(`[${track.title}](${track.uri})`)
      .addFields(
        { name: '길이', value: msToTime(track.duration), inline: true },
        { name: '요청자', value: `<@${track.requester.id}>`, inline: true }
      )
      .setThumbnail(track.thumbnail)
      .setColor('Random');

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('stop').setLabel('중지').setStyle(ButtonStyle.Danger).setEmoji('⏹️'),
      new ButtonBuilder().setCustomId('repeat').setLabel('반복').setStyle(ButtonStyle.Primary).setEmoji('🔁'),
      new ButtonBuilder().setCustomId('queue').setLabel('대기열').setStyle(ButtonStyle.Secondary).setEmoji('📜')
    );

    const msg = await channel.send({ embeds: [embed], components: [row] });
    nowPlayingMessages.set(player.guildId, msg.id);
  } catch (error) {
    console.error('트랙 시작 알림 중 오류:', error);
  }
});

// 재생 종료 시 메시지 삭제
manager.on('queueEnd', async player => {
  const channel = client.channels.cache.get(player.textChannelId);
  if (nowPlayingMessages.has(player.guildId)) {
    try {
      const msg = await channel.messages.fetch(nowPlayingMessages.get(player.guildId));
      await msg.delete().catch(() => {});
      nowPlayingMessages.delete(player.guildId);
    } catch {}
  }
  
  try {
    await channel.send('모든 노래 재생이 끝났어요!');
  } catch (error) {
    console.error('재생 종료 알림 중 오류:', error);
  }
});

// 시간 변환 함수
function msToTime(ms) {
  const sec = Math.floor((ms / 1000) % 60);
  const min = Math.floor((ms / (1000 * 60)) % 60);
  const hr = Math.floor(ms / (1000 * 60 * 60));
  return hr ? `${hr}:${min.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}` : `${min}:${sec.toString().padStart(2, '0')}`;
}

// 에러 처리
process.on('unhandledRejection', error => {
  console.error('미처리된 프로미스 거부:', error);
});

let lastPostId = null;

// 웹사이트 크롤링 함수
async function checkWebsite() {
  try {
    const response = await axios.get(process.env.WEBSITE_URL);
    const $ = cheerio.load(response.data);
    
    // 게시글 선택자 수정 필요 (사이트에 맞게)
    const posts = $('div.post').map((i, el) => ({
      id: $(el).attr('id'),
      title: $(el).find('h3.title').text().trim(),
      link: $(el).find('a').attr('href'),
      date: $(el).find('.date').text().trim()
    })).get();

    if (posts.length > 0) {
      const newestPost = posts[0];
      if (lastPostId !== newestPost.id) {
        lastPostId = newestPost.id;
        
        const channel = client.channels.cache.get(process.env.CHANNEL_ID);
        if (channel) {
          const embed = new EmbedBuilder()
            .setTitle('새로운 게시글이 올라왔어요!')
            .setDescription(`[${newestPost.title}](${newestPost.link})`)
            .addFields(
              { name: '날짜', value: newestPost.date, inline: true }
            )
            .setColor('Random');

          await channel.send({ embeds: [embed] });
        }
      }
    }
  } catch (error) {
    console.error('웹사이트 크롤링 중 오류:', error);
  }
}

// 주기적인 크롤링 설정
if (process.env.WEBSITE_URL && process.env.CHANNEL_ID) {
  cron.schedule(`*/${Math.floor(process.env.CHECK_INTERVAL / 60000)} * * * *`, checkWebsite);
  console.log('웹사이트 크롤링이 시작되었습니다.');
}

client.login(process.env.DISCORD_TOKEN);
