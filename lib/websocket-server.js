require('dotenv').config();
const { Server } = require('socket.io');
const http = require('http');

function initWebSocketServer(app, User, Profile) {
  const wsPort = process.env.WS_PORT || 5042;
  const wsServer = http.createServer(app);
  const io = new Server(wsServer, { cors: { origin: '*' } });

  io.on('connection', (socket) => {
    console.log('대시보드가 실시간으로 연결됨 (' + wsPort + ' 포트)');

    // 대시보드 → 프로필 요청
    socket.on('getProfile', async ({ userId }) => {
      const profile = await Profile.findOne({ userId });
      socket.emit('profile', profile);
    });

    // 대시보드 → 경험치 직접 설정
    socket.on('setXP', async ({ userId, xp }) => {
      await User.updateOne({ userId }, { xp });
      socket.emit('xpUpdated', { userId, xp });
      io.emit('xpUpdate', { userId, xp }); // 전체 broadcast
    });

    // 랭킹 요청 예시
    socket.on('getRanking', async () => {
      const users = await User.find().sort({ level: -1, xp: -1 }).limit(10);
      socket.emit('ranking', users);
    });
  });

  wsServer.listen(wsPort, () => {
    console.log(`WebSocket(Socket.io) 서버가 ${wsPort}번 포트에서 실행 중입니다.`);
  });
}

module.exports = { initWebSocketServer }; 