const GuildConfig = require('../../models/GuildConfig');
const User = require('../../models/User');
const mongoose = require('mongoose');

/**
 * XP 지급 통합 서비스
 * @param {Object} params
 * @param {string} params.discordId - 유저 ID
 * @param {string} params.guildId - 서버 ID
 * @param {string} params.type - XP 소스(message|voice|reaction|command)
 * @param {number} [params.baseXP] - 기본 지급 XP(랜덤/고정)
 * @param {string} [params.channelId] - 채널 ID(필요시)
 * @param {boolean} [params.requireMic] - 음성 전용: 마이크 필요 여부
 * @returns {Promise<{success: boolean, reason?: string, grantedXP?: number, user?: any}>}
 */
async function grantXP({ discordId, guildId, type, baseXP = 1, channelId, requireMic }) {
  try {
    // 1. 정책 조회
    const config = await GuildConfig.findOne({ guildId });
    const policy = config?.activityXPPolicy?.[type];
    if (policy && policy.enabled === false) {
      return { success: false, reason: 'disabled' };
    }
    // 2. requireMic(voice 전용)
    if (type === 'voice' && policy?.requireMic && !requireMic) {
      return { success: false, reason: 'requireMic' };
    }
    // 3. 쿨타임 체크
    if (!global.xpCooldown) global.xpCooldown = {};
    const key = `${guildId}:${discordId}:${type}`;
    const now = Date.now();
    const cooldown = policy?.cooldownSec ?? 60;
    if (global.xpCooldown[key] && now - global.xpCooldown[key] < cooldown * 1000) {
      return { success: false, reason: 'cooldown' };
    }
    global.xpCooldown[key] = now;
    // 4. XP 계산
    let minXP = policy?.minXP ?? baseXP;
    let maxXP = policy?.maxXP ?? baseXP;
    let multiplier = policy?.multiplier ?? 1.0;
    let grantedXP = Math.round((Math.floor(Math.random() * (maxXP - minXP + 1)) + minXP) * multiplier);
    if (grantedXP <= 0) grantedXP = 0;
    // 5. DB 트랜잭션으로 XP 지급
    const session = await mongoose.startSession();
    session.startTransaction();
    let user;
    try {
      user = await User.findOneAndUpdate(
        { userId: discordId },
        { $inc: { xp: grantedXP } },
        { upsert: true, new: true, session }
      );
      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      session.endSession();
    }
    // 6. 로깅(간단히 콘솔)
    console.log(`[grantXP] ${type} | ${discordId} | +${grantedXP}xp | guild: ${guildId}`);
    return { success: true, grantedXP, user };
  } catch (error) {
    console.error('[grantXP] 지급 오류:', error);
    return { success: false, reason: 'error', error };
  }
}

module.exports = grantXP; 