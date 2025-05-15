const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const cheerio = require('cheerio');
const urlJoin = require('url-join');

const CATEGORIES = [
  { name: "공지사항", url: "https://mabinogimobile.nexon.com/News/Notice" },
  { name: "이벤트", url: "https://mabinogimobile.nexon.com/News/Events" },
  { name: "업데이트", url: "https://mabinogimobile.nexon.com/News/Update" },
  { name: "에린노트", url: "https://mabinogimobile.nexon.com/News/Devnote" },
];

async function crawlAllCategories() {
  let postsByCategory = {};
  for (const cat of CATEGORIES) {
    postsByCategory[cat.name] = [];
    try {
      const { data } = await axios.get(cat.url, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      const $ = cheerio.load(data);
      $('.event_list_item').each((i, el) => {
        const title = $(el).find('.event_link').text().trim();
        const link = urlJoin(cat.url, $(el).find('.event_link').attr('href'));
        let image = $(el).find('.event_thumb').attr('src');
        if (image) image = urlJoin(cat.url, image);
        postsByCategory[cat.name].push({
          category: cat.name,
          title,
          link,
          image
        });
      });
    } catch (e) {
      // ignore category error, continue others
    }
  }
  return postsByCategory;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('마비노기새글')
    .setDescription('마비노기 모바일 공지/이벤트/업데이트/에린노트 전체 새 글을 카테고리별로 보여줍니다.'),
  async execute(interaction) {
    if (!interaction.memberPermissions || !interaction.memberPermissions.has('Administrator')) {
      await interaction.reply({ content: '이 명령어는 서버 관리자만 사용할 수 있습니다.', ephemeral: true });
      return;
    }
    await interaction.deferReply();
    const postsByCategory = await crawlAllCategories();
    let found = false;
    for (const cat of CATEGORIES) {
      const posts = postsByCategory[cat.name];
      if (posts && posts.length > 0) {
        found = true;
        // 카테고리별로 최대 4개만
        for (const post of posts.slice(0, 4)) {
          const embed = new EmbedBuilder()
            .setTitle(`[${cat.name}] ${post.title}`)
            .setURL(post.link)
            .setColor(0x5CCC7A);
          if (post.image) embed.setImage(post.image);
          await interaction.followUp({ embeds: [embed] });
        }
      }
    }
    if (!found) {
      await interaction.editReply('새 글이 없습니다.');
    } else {
      await interaction.editReply('최신 글을 카테고리별로 전송했습니다.');
    }
  }
}; 