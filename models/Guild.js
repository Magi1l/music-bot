const mongoose = require('mongoose');

const guildSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },
  name: String,
  joinedAt: { type: Date, default: Date.now },
  memberCount: { type: Number, default: 0 },        // 전체 멤버 수
  activeMemberCount: { type: Number, default: 0 },  // 최근 7일 내 활동 멤버 수
  messageCount: { type: Number, default: 0 },       // 누적 메시지 수
  lastMessageAt: { type: Date },                    // 마지막 메시지 시각
});

module.exports = mongoose.model('Guild', guildSchema); 