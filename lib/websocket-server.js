require('dotenv').config();
const { Server } = require('socket.io');
const http = require('http');
const WebSocket = require('ws');
const express = require('express');
const cors = require('cors');
const Guild = require('../models/Guild');
const User = require('../models/User');
const Profile = require('../models/Profile');

const app = express();
app.use(cors());
app.use(express.json());

// API 엔드포인트
app.get('/api/guilds/:guildId/stats', async (req, res) => {
  try {
    const guild = await Guild.findOne({ guildId: req.params.guildId });
    if (!guild) {
      return res.status(404).json({ error: '서버를 찾을 수 없습니다.' });
    }
    res.json(guild);
  } catch (error) {
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// 프로필 API 엔드포인트
app.get('/api/profile/:userId', async (req, res) => {
  try {
    const user = await User.findOne({ userId: req.params.userId });
    const profile = await Profile.findOne({ userId: req.params.userId });
    
    if (!user || !profile) {
      return res.status(404).json({ error: '프로필을 찾을 수 없습니다.' });
    }

    // 랭크 계산
    const rank = await User.countDocuments({
      $or: [
        { level: { $gt: user.level } },
        { level: user.level, xp: { $gt: user.xp } }
      ]
    }) + 1;

    res.json({
      userId: user.userId,
      username: user.username,
      level: user.level,
      xp: user.xp,
      points: user.points,
      rank: rank,
      cardUrl: profile.cardUrl,
      description: `레벨 ${user.level} | XP: ${user.xp} | 랭크: ${rank}위`
    });
  } catch (error) {
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

function initWebSocketServer(server) {
  const wss = new WebSocket.Server({ server });
  
  wss.on('connection', (ws) => {
    console.log('클라이언트가 연결되었습니다.');
    
    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message);
        // 메시지 처리 로직
      } catch (error) {
        console.error('메시지 처리 중 오류:', error);
      }
    });
    
    ws.on('close', () => {
      console.log('클라이언트 연결이 종료되었습니다.');
    });
  });
  
  return wss;
}

module.exports = {
  initWebSocketServer,
  app
}; 