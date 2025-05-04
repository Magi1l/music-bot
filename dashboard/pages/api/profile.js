// 실제 운영에서는 이 파일 대신 봇 서버의 API를 호출해야 합니다.
export default function handler(req, res) {
  // 예시: 쿼리에서 userId 추출
  const { userId } = req.query;
  // 더미 데이터 반환 (실제 운영시 MongoDB에서 조회)
  res.status(200).json({
    userId,
    level: 7,
    xp: 1234,
    points: 250
  });
} 