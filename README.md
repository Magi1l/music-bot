# Discord Music Bot

이 봇은 Discord에서 음악을 재생하고 웹사이트 알림을 제공하는 봇입니다.

## 기능
- 음악 재생 (음성 채널 연결 필요)
- 웹사이트 크롤링 및 알림 (관리자만 사용 가능)
- 대기열 관리

## 사용 방법

### 음악 관련 명령어
- `/play [query]` - 노래 재생
- `/skip` - 현재 재생 중인 노래 건너뛰기
- `/queue` - 대기열 확인

### 웹사이트 알림 (관리자만 사용 가능)
- `/website url: [URL] channel: [채널] interval: [시간]` - 알림 설정
- `/website remove: true` - 설정 제거

## 설정

`.env` 파일에 다음 설정을 추가하세요:
```
DISCORD_TOKEN=여기_디스코드_봇_토큰
LAVA_HOST=localhost
LAVA_PORT=2333
LAVA_PASSWORD=youshallnotpass
LAVA_SECURE=false
```

## 실행
```bash
npm install
node index.js
```
