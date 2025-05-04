import React, { useEffect, useState } from 'react';
import axios from 'axios';

export default function Home() {
  const [users, setUsers] = useState([]);
  useEffect(() => {
    axios.get(process.env.NEXT_PUBLIC_API_URL + '/api/users')
      .then(res => setUsers(res.data))
      .catch(() => setUsers([]));
  }, []);

  return (
    <main>
      <h1>서버 랭킹</h1>
      <ul>
        {users.length === 0 && <li>데이터를 불러올 수 없습니다.</li>}
        {users.map((user, idx) => (
          <li key={user.userId} style={{marginBottom: 12}}>
            <b>#{idx + 1}</b> | <b>LV.{user.level}</b> | {user.xp} XP | {user.points} 포인트 | <span style={{color:'#888'}}>ID: {user.userId}</span>
          </li>
        ))}
      </ul>
    </main>
  );
} 