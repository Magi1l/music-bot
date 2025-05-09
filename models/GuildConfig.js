const mongoose = require('mongoose');

const guildConfigSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },
  xpConfig: {
    voiceXpPerMinute: { type: Number, default: 5 },
    textXpPerMessage: { type: Number, default: 10 },
    textCooldown: { type: Number, default: 60 },
    textChannelMultipliers: [
      {
        channelId: String,
        multiplier: { type: Number, default: 1.5 }
      }
    ]
  }
});

module.exports = mongoose.model('GuildConfig', guildConfigSchema); 