export default function handler(req, res) {
  // 더미 데이터 (실제 운영시 DB에서 조회)
  res.status(200).json([
    { userId: '123', level: 10, xp: 2500, points: 500 },
    { userId: '456', level: 8, xp: 1800, points: 320 },
    { userId: '789', level: 7, xp: 1500, points: 210 },
  ]);
} 