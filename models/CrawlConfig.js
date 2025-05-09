const mongoose = require('mongoose');

const crawlConfigSchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  name: { type: String, required: true },
  url: { type: String, required: true },
  channelId: { type: String, required: true },
  interval: { type: Number, default: 60000 }, // ms 단위
  lastPostId: { type: String }
});
crawlConfigSchema.index({ guildId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('CrawlConfig', crawlConfigSchema); 