const mongoose = require('mongoose');

// MongoDB 연결 (앱 시작 시 1회만 호출)
async function connectDB() {
  if (mongoose.connection.readyState === 1) return; // 이미 연결됨
  await mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });
}

// User 모델 정의 (대시보드와 동일하게 확장 가능)
const UserSchema = new mongoose.Schema({
  discordId: String,
  username: String,
  points: { type: Number, default: 0 },
  // ... 기타 커스터마이즈/레벨/프로필 필드 추가 가능
});
const User = mongoose.models.User || mongoose.model('User', UserSchema);

// 유저 XP(포인트) 증가
async function addXP(discordId, amount) {
  await connectDB();
  const user = await User.findOneAndUpdate(
    { discordId },
    { $inc: { points: amount } },
    { new: true, upsert: true }
  );
  return user;
}

// 유저 정보 조회
async function getUser(discordId) {
  await connectDB();
  return await User.findOne({ discordId });
}

// 유저 정보 업데이트
async function updateUser(discordId, update) {
  await connectDB();
  return await User.findOneAndUpdate({ discordId }, update, { new: true });
}

module.exports = {
  connectDB,
  User,
  addXP,
  getUser,
  updateUser,
}; 