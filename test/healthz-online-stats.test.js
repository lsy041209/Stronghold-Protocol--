// test/healthz-online-stats.test.js — `/healthz` 的**在线/离线拆分**（第 3 任 D，2026-10-06，C 分派 T-3 之后那条）
//
// 为什么加：线上长期出现"**2 个连接、43 个房间**"这种数字 —— 因为官方单机对局把座位**保留 24 小时**可重连，
// 于是 `rooms/humans/matches` 数的是**座位**，不是**活人**。这个虚数会同时误导玩家（胶囊上的"房间/在线"）、
// 误导我们判断负载，也误导公告。参照 simpfun 的 `/healthz`（他们拆成
// `onlinePlayers/onlineHumans/offlineHumans/onlineInLobby/roomsOnline/roomsOffline/matchesOnline/matchesOffline/waitingRooms`）
// 做同一件事，但**字段语义由我们自己定义并在此钉死**。
//
// 本测试钉五件：
//   ① **12 个核心字段语义不变**（座位口径；契约：只能加，不能删/改名）；
//   ② 每个新字段的**确切数值**（用手造的房/座位算，不靠真实联机）；
//   ③ **离线座位必须被算成离线** —— 这是本功能存在的全部理由（若把 connected 写死成 true，这条必红）；
//   ④ `waitingRooms` 只数"未开局 + 有在线真人 + **还有空位**"（满座未开局不算等人）；
//   ⑤ 真服务器上 `/healthz` 有这些字段、且恒等式成立（`onlinePlayers == onlineHumans + onlineBots`）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lobby } from '../server/lobby.js';
import { startServer } from '../server/index.js';

/** `/healthz` 的既有核心字段（契约，`协作/README.md` §1）。 */
const CORE = ['ok', 'version', 'app', 'uptimeSec', 'build', 'sockets', 'sessions', 'rooms', 'matches', 'humans', 'bots', 'spectators'];
/** 本次新增的字段（正式族上线前只加不改）。 */
const NEW = ['onlineHumans', 'offlineHumans', 'onlineBots', 'onlineSpectators', 'offlineSpectators',
  'roomsOnline', 'roomsOffline', 'matchesOnline', 'matchesOffline', 'waitingRooms',
  'botsInOnlineRooms', 'botsInOfflineRooms', 'sessionsOnline', 'onlineInLobby', 'onlinePlayers'];

const seat = (o = {}) => ({ seat: 0, playerId: 'p', name: 'n', isBot: false, ready: true, connected: true, left: false, ...o });
const room = (o = {}) => ({ code: 'X', match: null, seats: [], spectators: [], ...o });
const asLobby = (rooms) => ({ rooms: new Map(rooms.map((r, i) => [`R${i}`, r])) });
const stats = (rooms) => Lobby.prototype.stats.call(asLobby(rooms));

test('在线/离线拆分：数值按"座位是否 connected"算，核心字段语义不变', () => {
  const s = stats([
    // A：已开局 —— 2 在线真人 + 1 离线真人（24h 可重连）+ 1 bot
    room({ match: {}, seats: [seat(), seat(), seat({ connected: false }), seat({ isBot: true })] }),
    // B：未开局、1 在线真人、还有空位 ⇒ 等待房
    room({ seats: [seat()] }),
    // C：未开局、2 在线真人 + 2 bot = 满座 ⇒ **不算等待房**
    room({ seats: [seat(), seat(), seat({ isBot: true }), seat({ isBot: true })] }),
    // D：未开局、只有 1 个 bot（没有真人）⇒ 离线房；另带 1 在线 + 1 离线观战
    room({ seats: [seat({ isBot: true })], spectators: [{ playerId: 'a', connected: true }, { playerId: 'b', connected: false }] }),
  ]);

  // ① 核心字段：仍然是**座位**口径（含离线座位），一个都不许变
  assert.equal(s.rooms, 4);
  assert.equal(s.matches, 1);
  assert.equal(s.humans, 6, '人类座位：A 3 + B 1 + C 2 + D 0');
  assert.equal(s.bots, 4, 'bot 座位：A 1 + C 2 + D 1');
  assert.equal(s.spectators, 2);

  // ② 新字段：确切数值
  assert.equal(s.onlineHumans, 5, '在线真人：A 2 + B 1 + C 2 + D 0');
  assert.equal(s.offlineHumans, 1, '离线真人：A 的第三个座位（connected:false）');
  assert.equal(s.onlineBots, 4, 'bot 恒 connected:true');
  assert.equal(s.onlineSpectators, 1);
  assert.equal(s.offlineSpectators, 1);
  assert.equal(s.roomsOnline, 3, 'A/B/C 有在线真人；D 只有 bot 与观战 ⇒ 离线');
  assert.equal(s.roomsOffline, 1);
  assert.equal(s.matchesOnline, 1, 'A 已开局且有人在线');
  assert.equal(s.matchesOffline, 0);
  assert.equal(s.waitingRooms, 1, '只有 B：未开局 + 有在线真人 + 还有空位（C 满座、A 已开局、D 无真人）');
  assert.equal(s.botsInOnlineRooms, 3, 'A 1 + C 2');
  assert.equal(s.botsInOfflineRooms, 1, 'D 1');
});

test('③ 回归护栏：离线座位必须被算成离线（写死 connected 就必红）', () => {
  const s = stats([room({ seats: [seat({ connected: false }), seat({ connected: false })] })]);
  assert.equal(s.humans, 2);
  assert.equal(s.onlineHumans, 0, '两个座位都 connected:false ⇒ 在线真人必须为 0');
  assert.equal(s.offlineHumans, 2);
  assert.equal(s.roomsOnline, 0, '没有在线真人 ⇒ 该房算离线');
  assert.equal(s.roomsOffline, 1);
});

test('④ 空 lobby 时所有新字段都是 0（不许出现 undefined/NaN）', () => {
  const s = stats([]);
  for (const k of NEW.filter((k) => k !== 'onlineInLobby' && k !== 'sessionsOnline' && k !== 'onlinePlayers')) {
    assert.equal(s[k], 0, `${k} 应为 0，实测 ${s[k]}`);
  }
});

test('⑤ 真服务器：`/healthz` 有全部新字段、核心字段没少、恒等式成立', async () => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
  try {
    const b = await (await fetch(`http://127.0.0.1:${srv.port}/healthz`)).json();
    for (const k of CORE) assert.ok(k in b, `核心字段 ${k} 丢了（契约：只能加，不能删/改名）`);
    for (const k of NEW) assert.equal(typeof b[k], 'number', `新字段 ${k} 应是数字，实测 ${JSON.stringify(b[k])}`);
    assert.equal(b.onlinePlayers, b.onlineHumans + b.onlineBots, 'onlinePlayers 应等于在线真人 + 在线 bot');
    assert.ok(b.sessionsOnline <= b.sessions, `sessionsOnline(${b.sessionsOnline}) 不可能大于 sessions(${b.sessions})`);
    assert.ok(b.onlineInLobby <= b.sessionsOnline, `onlineInLobby(${b.onlineInLobby}) 不可能大于 sessionsOnline(${b.sessionsOnline})`);
    assert.equal(b.roomsOnline + b.roomsOffline, b.rooms, 'roomsOnline + roomsOffline 应等于 rooms');
    assert.equal(b.matchesOnline + b.matchesOffline, b.matches, 'matchesOnline + matchesOffline 应等于 matches');
  } finally { await srv.close(); }
});
