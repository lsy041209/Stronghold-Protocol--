// test/lobby-matchmake.test.js — D-2（3a 野排匹配 / 快速匹配）：C2S `room.matchmake { difficulty }`
//
// 参照 `阿里云开服/39-新参考服-simpfun-匹配与外援-2026-10-06.md` §2：他们的客户端就是
// `net.request('room.matchmake', { difficulty })`，文案「快速匹配 · 同难度自动组队 · 满 MAX_SEATS 人开局」。
// 服务端语义照他们（**同难度进/建一间等待房**），另加我们池子小必须的"到期 AI 补齐"。
//
// 本文件钉六件，全部走**真实服务器 + 真实 WebSocket 客户端**（不用桩、不直接调私有函数做断言）：
//   ① 两个真人各自 matchmake（同难度）⇒ **收到同一个 `room.code`**（进同一房）；
//   ② 单人 matchmake ⇒ `matchmakeFillMs` 到期 ⇒ **用现有 addBot 补满座位并开局**（`room.state.inMatch` + 真收到 `m.public`）；
//   ③ 不同难度**不会**匹配到一起（各建各的房）；
//   ④ **已开局**的房不再被匹配加入 —— 它有在线真人、也有空位，唯一的排除理由就是"已开局"；
//   ⑤ 手动 `room.start` 后**补齐计时器必须已取消**（否则会在对局中途往座位里塞 AI）；
//   ⑥ 最后一位真人 `room.leave` ⇒ 房被回收（`disposeRoom`）且**计时器已取消**。
//   ⚠️ 计时器泄漏会让 `node --test` 挂住进程（工作区踩过的坑）⇒ 本文件能**自然退出**本身是第七条证据。
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';
import { MAX_SEATS } from '../shared/constants.js';

/** 补齐截止时间：慢的那台服务器只用来看"分工"，快到期的服务器只给 ② / ⑤ 用。 */
const SLOW_FILL_MS = 60_000;
const FAST_FILL_MS = 200;

let srv;      // SLOW_FILL_MS：这些用例不该在中途自动开局
let fillSrv;  // FAST_FILL_MS：② 的到期补齐 / ⑤ 的取消
let url;
let fillUrl;
let perTest = [];

/** 连上 + hello；本用例结束后统一 terminate（掉线即从野排池里排除，见 findMatchmakeRoom 的"在线真人"）。 */
async function player(wsUrl, name) {
  const c = await TestClient.connect(wsUrl);
  const w = await c.hello(name);
  c.id = w.playerId;
  c.token = w.token;
  perTest.push(c);
  return c;
}

/** 自己的座位出现在座位表里 ⇒ 这条 room.state 与本次操作有关。 */
const seated = (c) => (s) => s.seats.some((x) => x && x.playerId === c.id);

before(async () => {
  srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, matchmakeFillMs: SLOW_FILL_MS });
  fillSrv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, matchmakeFillMs: FAST_FILL_MS });
  url = `ws://127.0.0.1:${srv.port}/ws`;
  fillUrl = `ws://127.0.0.1:${fillSrv.port}/ws`;
});

afterEach(async () => {
  await Promise.all(perTest.map((c) => c.terminate().catch(() => {})));
  perTest = [];
});

after(async () => {
  await Promise.all(perTest.map((c) => c.terminate().catch(() => {})));
  perTest = [];
  await srv.close();
  await fillSrv.close();
});

test('① 两人同难度点快速匹配 ⇒ 进同一房（房号相同，都是真人座位）', async () => {
  const a = await player(url, 'D-匹配甲');
  const b = await player(url, 'D-匹配乙');

  const ra = await a.request({ t: 'room.matchmake', difficulty: 'NORMAL' });
  assert.equal(ra.t, 'ok', `甲的 room.matchmake 应被接受：${JSON.stringify(ra)}`);
  const sa = await a.waitFor('room.state', seated(a));

  const rb = await b.request({ t: 'room.matchmake', difficulty: 'NORMAL' });
  assert.equal(rb.t, 'ok', `乙的 room.matchmake 应被接受：${JSON.stringify(rb)}`);
  const sb = await b.waitFor('room.state', seated(b));

  assert.equal(sb.code, sa.code, `两人必须进同一房（甲 ${sa.code} / 乙 ${sb.code}）`);
  assert.equal(sa.mode, 'coop', '野排房必须是 coop');
  assert.equal(sa.difficulty, 'NORMAL');
  assert.equal(sb.hostId, a.id, '先来的那位是房主');
  assert.deepEqual(
    sb.seats.filter((s) => s && !s.isBot).map((s) => s.playerId).sort(),
    [a.id, b.id].sort(),
    '两个真人各占一个座位，且都不是 AI',
  );
});

test('② 单人快速匹配 ⇒ 到期补满 AI 并开局（room.state.inMatch + 真收到 m.public）', async () => {
  const c = await player(fillUrl, 'D-野排单人');
  const r = await c.request({ t: 'room.matchmake', difficulty: 'NORMAL' });
  assert.equal(r.t, 'ok', `room.matchmake 应被接受：${JSON.stringify(r)}`);

  const s0 = await c.waitFor('room.state', seated(c));
  assert.equal(s0.inMatch, false, '刚匹配完还在等待房');
  assert.equal(s0.seats.filter(Boolean).length, 1, '刚匹配时只有自己一个座位');

  const s1 = await c.waitFor('room.state', (s) => s.inMatch === true, 3000);
  assert.equal(s1.code, s0.code, '补齐后还是同一间房');
  assert.equal(s1.difficulty, 'NORMAL', '难度不许被补齐改掉');
  const seats = s1.seats.filter(Boolean);
  assert.equal(seats.length, MAX_SEATS, `到期后座位必须补满（${seats.length}/${MAX_SEATS}）`);
  assert.equal(seats.filter((s) => s.isBot).length, MAX_SEATS - 1, '空位由 AI 补上');
  assert.equal(seats.filter((s) => !s.isBot).length, 1, '只有自己是真人');
  assert.ok(seats.every((s) => s.ready), '自动开局时所有座位（含真人）都应为 ready');
  // 房间进入对局的最硬证据：服务端真的起了一个 Match 并发 m.public
  const pub = await c.waitFor('m.public', (p) => p.phase === 'INFO_CHECK', 3000);
  assert.equal(pub.modeId, 'mode_multi_normal', 'coop/NORMAL 的 modeId（shared/constants.js modeIdFor）');
});

test('③ 不同难度不会匹配到一起（各建各的房）', async () => {
  const a = await player(url, 'D-难度甲');
  const b = await player(url, 'D-难度乙');
  assert.equal((await a.request({ t: 'room.matchmake', difficulty: 'FUNNY' })).t, 'ok');
  const sa = await a.waitFor('room.state', seated(a));
  assert.equal((await b.request({ t: 'room.matchmake', difficulty: 'HARD' })).t, 'ok');
  const sb = await b.waitFor('room.state', seated(b));

  assert.notEqual(sb.code, sa.code, `不同难度不许同房（FUNNY ${sa.code} / HARD ${sb.code}）`);
  assert.equal(sa.difficulty, 'FUNNY');
  assert.equal(sb.difficulty, 'HARD');
});

test('④ 已开局的房不再被匹配加入（有在线真人、也有空位，只因为"已开局"）', async () => {
  const host = await player(url, 'D-房主');
  assert.equal((await host.request({ t: 'room.create', mode: 'coop', difficulty: 'ABYSS' })).t, 'ok');
  await host.waitFor('room.state', (s) => s.hostId === host.id && s.difficulty === 'ABYSS');
  assert.equal((await host.request({ t: 'room.addBot' })).t, 'ok'); // 1 真人 + 1 AI ⇒ 开局后**还有空位**
  assert.equal((await host.request({ t: 'room.start' })).t, 'ok');
  const started = await host.waitFor('room.state', (s) => s.inMatch === true);
  assert.equal(started.seats.filter(Boolean).length, 2, '开局时只坐了 2 个座位（还剩空位）');

  const other = await player(url, 'D-后来者');
  assert.equal((await other.request({ t: 'room.matchmake', difficulty: 'ABYSS' })).t, 'ok');
  const s = await other.waitFor('room.state', seated(other));
  assert.notEqual(s.code, started.code, '已开局的房不许被野排加入');
  assert.equal(s.inMatch, false, '后来者进的是等待房，不是别人的对局');
});

test('⑤ 手动开局后补齐计时器已取消（否则会在对局中途塞 AI）', async () => {
  const c = await player(fillUrl, 'D-手快的人');
  assert.equal((await c.request({ t: 'room.matchmake', difficulty: 'FUNNY' })).t, 'ok');
  const s0 = await c.waitFor('room.state', seated(c));
  const room = fillSrv.lobby.getRoom(s0.code);
  assert.ok(room, '房应存在');
  assert.ok(room.matchmakeTimer, '快速匹配后应已武装补齐计时器');

  assert.equal((await c.request({ t: 'room.start' })).t, 'ok');
  await c.waitFor('room.state', (s) => s.inMatch === true);
  assert.equal(room.matchmakeTimer, null, 'start 必须取消补齐计时器');

  await delay(FAST_FILL_MS * 3); // 远超截止时间
  assert.equal(room.seats.filter(Boolean).length, 1, '计时器不许在对局中途补 AI（仍是 1 个座位）');
});

test('⑥ 最后一位真人离开 ⇒ 房被回收且补齐计时器已取消', async () => {
  const c = await player(url, 'D-要走的人');
  assert.equal((await c.request({ t: 'room.matchmake', difficulty: 'HARD' })).t, 'ok');
  const s = await c.waitFor('room.state', seated(c));
  const room = srv.lobby.getRoom(s.code);
  assert.ok(room.matchmakeTimer, '快速匹配后应已武装补齐计时器');

  assert.equal((await c.request({ t: 'room.leave' })).t, 'ok');
  assert.equal(srv.lobby.getRoom(s.code), null, '最后一个真人走了 ⇒ 房必须被回收');
  assert.equal(room.disposed, true, '房对象必须标记 disposed');
  assert.equal(room.matchmakeTimer, null, 'dispose 必须取消补齐计时器（否则测试会挂住进程）');
});

test('⑦ 在自己手建的房里按快速匹配 ⇒ 不会把自己的房当成野排房（另开一间）', async () => {
  const c = await player(url, 'D-自己有房');
  assert.equal((await c.request({ t: 'room.create', mode: 'coop', difficulty: 'HARD' })).t, 'ok');
  const mine = await c.waitFor('room.state', (s) => s.hostId === c.id && s.difficulty === 'HARD');

  assert.equal((await c.request({ t: 'room.matchmake', difficulty: 'HARD' })).t, 'ok');
  const s = await c.waitFor('room.state', (st) => st.code !== mine.code && seated(c)(st));
  assert.notEqual(s.code, mine.code, '必须另开/另进一间野排房，而不是把自己那间变成野排房');
  assert.equal(srv.lobby.getRoom(mine.code), null, '自己那间（只有自己）应被回收');
  const fresh = srv.lobby.getRoom(s.code);
  assert.equal(fresh.matchmade, true, '新进的房才是野排房');
});

test('⑧ 落进"房主手建的普通等待房"时：只置自己的 ready，**不**把别人的房变成野排房、也不武装计时器', async () => {
  const host = await player(url, 'D-普通房主');
  assert.equal((await host.request({ t: 'room.create', mode: 'coop', difficulty: 'ABYSS' })).t, 'ok');
  const st = await host.waitFor('room.state', (s) => s.hostId === host.id && s.difficulty === 'ABYSS');
  const room = srv.lobby.getRoom(st.code);
  assert.equal(room.matchmade, false, 'room.create 建的房不是野排房');

  const guest = await player(url, 'D-野排来客');
  assert.equal((await guest.request({ t: 'room.matchmake', difficulty: 'ABYSS' })).t, 'ok');
  const s = await guest.waitFor('room.state', (x) => x.code === st.code && seated(guest)(x));
  assert.equal(s.code, st.code, '池子里只有这一间同难度等待房 ⇒ 落进去（单子要求的"其次才是普通等待房"）');
  assert.equal(room.matchmade, false, '不许把房主手建的房变成野排房（开局时机仍归房主）');
  assert.equal(room.matchmakeTimer, null, '不许给普通房武装"到期 AI 补齐"计时器');
  assert.equal(room.seatOf(guest.id).ready, true, '按了快速匹配的人自己是 ready 的');
  assert.equal(room.hostId, host.id, 'host 不变');
});
