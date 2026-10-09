// test/lobby-room-retention.test.js — D-3 **第二批**（① 首次进房补发聊天历史 · ② 房间休眠保留）的服务端判据
//
// 权威规格：`协作/D-口径-房间内聊天-兼容与规格-2026-10-07.md`
//   · §3 表格第 3 行：**进入已开过几局的房间会看到之前的人留下的消息**，且**首次拿密钥进房也要看到** ⇒ `join()` 补发；
//   · §3.0（用户 2026-10-07 逐字追加的保留期规则 + 6 条落地解释）：
//       1) 房间关闭（空房）后**不立即销毁** ⇒ 转入休眠，保留 `roomRetentionMs`（默认 20 分钟，可配）；
//       2) 保留期内**同一个房主账号（同一 playerId）再次 `create()`** ⇒ 复用**原房号 + 原聊天记录**；
//       3) 超时 ⇒ **删房 + 清空聊天记录**，之后要玩必须开新房（新房号、空记录）；
//       4) 休眠房**不计入活跃**（`/healthz` 的 `rooms` / `waitingRooms` 不算它），但**也不许泄漏**（判据断言休眠表清空）；
//       5) **只有房主账号重新开房能唤醒它**（用户 2026-10-07 已确认）⇒ 休眠房**不可**被 `room.join` 加入或唤醒；
//       6) 保留期定时器必须 `unref()`，并在**超时 / 唤醒 / 关停**三条路径上都 `clearTimeout`。
//   · 会议 D 2026-10-07 追加拍板：休眠表要有**硬上限** `maxDormantRooms`（默认 200，超了淘汰最早休眠的那间）——
//     依据是用户给这条规则的理由原话「**以免内存占用过高**」；并钉住野排不进休眠房。
//
// 本文件全部走**真实服务器 + 真实 `ws` 客户端**（不直连私有函数下断言；只有"休眠表"这一项没有线上协议可观测，
// 才读 `lobby.dormantRooms` 这个内部表 —— 它正是规格 §3.0 点名的数据结构）。十条：
//   ① 首次拿密钥进房（另一个 session 用 `room.join`）⇒ 收到 `chat.history`，含之前那位留下的消息；**新房不发**；
//   ② 房间空了之后，**同一个房主账号**在保留期内再 `create` ⇒ **同一个 `room.code`**，且 `chat.history` 仍是那几条；
//   ③ 保留期注入 200ms ⇒ 300ms 后：**不同房号**、`chat.history` 空/不发、**休眠表已清空**（不许泄漏）；
//   ④ 休眠期间 `/healthz` 与 `lobby.stats()` 都**不把它算进** `rooms` / `waitingRooms`；
//   ⑤ 别人拿旧密钥 `room.join` / `room.spectate` ⇒ `ROOM_NOT_FOUND`，**不许把休眠房捞回活跃表**、也不许消费掉它；
//   ⑥ 规矩钉住：只有**最后那位房主账号**能唤醒（开房人先走则不再算房主）；**lobby 关停** ⇒ 删房 + 清空聊天记录；
//   ⑦ 进程不会因保留期定时器挂住（子进程自己退出）；⑧ 默认值 = 20 分钟 + 休眠表上限 200；
//   ⑨ `maxDormantRooms` 上限：超了**淘汰最早休眠的那间**并清它的 chat（FIFO），之后 `create` 拿不到那个房号；
//   ⑩ 野排 `room.matchmake` / `findMatchmakeRoom` **不会进休眠房、也不会消费掉它**（口径 §3.0.5）。
// 🔴 聊天**绝不落盘**的判据在 `test/lobby-chat.test.js` ⑧（本文件不重复，也不碰那条敏感路径）。
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';
import { run } from './helpers/proc.js'; // ⚠️ spawnSync 在 `node --test` 内必然 EBUSY ⇒ 用这个异步替身
import { ERR } from '../shared/constants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 判据里**写死**的规格值（故意不从实现里 import，否则就是拿实现自证实现）。 */
const RETENTION_MS = 200;

let longSrv;   // 默认保留期（20 分钟）：①②⑤ —— 保留期内唤醒
let longUrl;
let shortSrv;  // roomRetentionMs: 200：③ —— 过期删房
let shortUrl;
let hzSrv;     // ④ 专用（只放本用例那间房，/healthz 的计数才是确定的）
let hzUrl;
let perTest = [];

async function player(wsUrl, name) {
  const c = await TestClient.connect(wsUrl);
  const w = await c.hello(name);
  c.id = w.playerId;
  c.token = w.token;
  perTest.push(c);
  return c;
}

const ok = async (c, msg) => {
  const r = await c.request(msg);
  assert.equal(r.t, 'ok', `${msg.t}: ${JSON.stringify(r)}`);
  return r;
};
const seated = (c) => (s) => s.seats.some((x) => x && x.playerId === c.id);

/** 建房并把房号返回（默认 coop）。 */
async function createRoom(c, mode = 'coop', difficulty = 'NORMAL') {
  await ok(c, { t: 'room.create', mode, difficulty });
  return (await c.waitFor('room.state', seated(c))).code;
}
async function joinRoom(c, code) {
  await ok(c, { t: 'room.join', code });
  return c.waitFor('room.state', seated(c));
}

/** 休眠表大小。⚠️ 实现前这个表还不存在 ⇒ 返回 0（让红的是一条**断言**，不是一个 TypeError）。 */
const dormantCount = (lobby) => (lobby.dormantRooms ? lobby.dormantRooms.size : 0);
/** 休眠表里那间房的记录（不存在就给 null）。 */
const dormantEntry = (lobby, code) => (lobby.dormantRooms ? [...lobby.dormantRooms.values()].find((e) => e.code === code) || null : null);

/**
 * ⑦ 用的子进程脚本：**不监听端口、不写文件**，只造一间休眠房（保留期 60 s）然后什么都不做。
 * 定时器若没 `unref()`，这个进程就会在这里挂 60 秒（父进程 8 秒判红）—— 这是"进程不会因此挂住"的端到端证据。
 */
const PROBE_SRC = `
import { Lobby } from '__LOBBY_URL__';
const session = {
  playerId: 'p_dormant_probe', name: 'probe', connected: true, roomCode: null,
  limitKey: null, addr: 'local', loadout: null, skins: null,
  ws: { readyState: 1, bufferedAmount: 0, send() {} },
};
const registry = { byId: (id) => (id === session.playerId ? session : null), all: () => [session] };
const lobby = new Lobby({ registry, options: { roomRetentionMs: 60_000 } });
const created = lobby.create(session, { mode: 'coop', difficulty: 'NORMAL' });
if (created.error) { console.error('create failed ' + JSON.stringify(created)); process.exit(3); }
lobby.leave(session);
if (lobby.dormantRooms.size !== 1) { console.error('not dormant: ' + lobby.dormantRooms.size); process.exit(4); }
console.log('DORMANT-ARMED');
`;

/** 真 `/healthz`（不走 lobby.stats()，走 HTTP）。 */
function healthz(port) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/healthz', method: 'GET', agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  longSrv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
  longUrl = `ws://127.0.0.1:${longSrv.port}/ws`;
  shortSrv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, roomRetentionMs: RETENTION_MS });
  shortUrl = `ws://127.0.0.1:${shortSrv.port}/ws`;
  hzSrv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
  hzUrl = `ws://127.0.0.1:${hzSrv.port}/ws`;
});

afterEach(async () => {
  await Promise.all(perTest.map((c) => c.terminate().catch(() => {})));
  perTest = [];
});

after(async () => {
  await Promise.all(perTest.map((c) => c.terminate().catch(() => {})));
  perTest = [];
  await longSrv.close();
  await shortSrv.close();
  await hzSrv.close();
});

test('① 首次拿密钥进房（另一个 session 用 room.join）⇒ 收到 chat.history，含之前留下的消息；新房不发', async () => {
  const a = await player(longUrl, 'D-先驱');
  const code = await createRoom(a);
  assert.equal(a.log.some((m) => m.t === 'chat.history'), false, '新房必空：create 不该补发 chat.history');

  await ok(a, { t: 'room.chat', text: '先驱留下的话' });
  await a.waitFor('chat.msg', (m) => m.text === '先驱留下的话');
  await a.expectNone('chat.history', () => true, 150); // 说话的人自己也不该收到 history（那是进房/重连时的事）

  const b = await player(longUrl, 'D-后来者');
  await joinRoom(b, code); // 首次进房：拿密钥 join，不是重连（b 的 welcome.resumed 与 history 无关）
  const hist = await b.waitFor('chat.history');
  console.log('[证据①] 后来者首次进房 %s ⇒ chat.history = %j', code, hist);
  assert.equal(hist.messages.length, 1, '要看到之前那位留下的那一条');
  assert.equal(hist.messages[0].text, '先驱留下的话');
  assert.equal(hist.messages[0].from, a.id, 'from = 留话那个人的 playerId');
  assert.equal(hist.messages[0].name, 'D-先驱');
  assert.equal(typeof hist.messages[0].at, 'number');
});

test('② 房间空了后，同一房主账号在保留期内再 create ⇒ 同一个 room.code + 仍是那几条聊天', async () => {
  const a = await player(longUrl, 'D-房主甲');
  const code = await createRoom(a);
  const b = await player(longUrl, 'D-队友乙');
  await joinRoom(b, code);
  await ok(a, { t: 'room.chat', text: '保留期内的那句' });
  await b.waitFor('chat.msg', (m) => m.text === '保留期内的那句');

  // a 先走（房主迁移给 b），b 后走 ⇒ 房空 ⇒ 转休眠；休眠房的唤醒账号 = **最后那位房主** b
  await ok(a, { t: 'room.leave' });
  await ok(b, { t: 'room.leave' });
  await delay(20);
  const lobby = longSrv.lobby;
  assert.equal(lobby.getRoom(code), null, '空房必须先从活跃表摘掉（休眠房不许算活跃）');
  assert.equal(dormantCount(lobby), 1, `空房应转入休眠表，实际 ${dormantCount(lobby)} 间`);
  const entry = dormantEntry(lobby, code);
  assert.ok(entry, `休眠表里应有 ${code}`);
  assert.equal(entry.ownerId, b.id, '休眠房的唤醒账号 = 最后那位房主账号');
  assert.equal(entry.chat.length, 1, '聊天记录必须留在休眠房里');
  assert.equal(entry.chat[0].text, '保留期内的那句');
  assert.equal(typeof entry.timer?.hasRef, 'function', '保留期应有定时器');
  assert.equal(entry.timer.hasRef(), false, '保留期定时器必须 unref()（否则进程被它挂住）');

  // 房主账号 b 再开房 ⇒ 唤醒：复用原房号 + 原聊天记录
  // ⚠️ 先清空收件箱：a 离开时广播的 room.state 还压在 b 的收件箱里，否则下面等到的可能是那帧**旧**状态
  b.clearInbox();
  await ok(b, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
  const woken = await b.waitFor('room.state', seated(b));
  const hist = await b.waitFor('chat.history');
  console.log('[证据②] 原房号 %s ⇒ 唤醒后 %s；chat.history = %j；休眠表 %d', code, woken.code, hist, dormantCount(lobby));
  assert.equal(woken.code, code, '必须复用原房号（朋友手里的旧链接仍指向这间房）');
  assert.equal(woken.hostId, b.id);
  assert.equal(woken.seats.filter(Boolean).length, 1, '唤醒后是干净的一间房（旧座位不复活）');
  assert.equal(hist.messages.length, 1, '回来还要看到"之前的人留下的消息"');
  assert.equal(hist.messages[0].text, '保留期内的那句');
  assert.equal(hist.messages[0].from, a.id, '留下的仍是原来那个人的消息');
  assert.equal(dormantCount(lobby), 0, '唤醒后休眠表里不许再留着它（不许泄漏）');
  assert.equal(lobby.getRoom(code)?.code, code, '唤醒后它回到活跃表');
});

test('③ 保留期 200ms ⇒ 300ms 后：不同房号 + chat.history 空/不发 + 休眠表已清空（无泄漏）', async () => {
  const a = await player(shortUrl, 'D-短保留');
  const code = await createRoom(a);
  await ok(a, { t: 'room.chat', text: '过期就没了' });
  await a.waitFor('chat.msg', (m) => m.text === '过期就没了');
  await ok(a, { t: 'room.leave' });

  const lobby = shortSrv.lobby;
  assert.equal(dormantCount(lobby), 1, '空房应先转入休眠表');
  const entry = dormantEntry(lobby, code);
  assert.ok(entry, `休眠表里应有 ${code}`);
  assert.equal(entry.chat.length, 1, '休眠期间记录还在');
  assert.equal(entry.timer.hasRef(), false, '保留期定时器必须 unref()');

  await delay(RETENTION_MS + 100); // 300ms > 200ms 保留期
  assert.equal(dormantCount(lobby), 0, '超时后休眠表必须清空（不许泄漏）');
  assert.equal(lobby.getRoom(code), null, '超时后房号也不在活跃表');
  assert.equal(entry.chat.length, 0, '超时必须清空聊天记录（内存里也不许再留字符串）');

  // 同一个账号再开房 ⇒ 新房号 + 空记录（不发 chat.history）
  a.clearInbox(); // 收件箱里的旧 room.state 不许冒充新帧
  await ok(a, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
  const fresh = await a.waitFor('room.state', seated(a));
  console.log('[证据③] 原房号 %s ⇒ 过期后再开房 %s；休眠表 %d', code, fresh.code, dormantCount(lobby));
  assert.notEqual(fresh.code, code, '超时后必须拿到新房号');
  await a.expectNone('chat.history', () => true, 200);
  assert.equal(entry.chat.length, 0, '新房不许接上旧记录');
});

test('④ 休眠期间 /healthz 与 lobby.stats() 都不把它算进 rooms / waitingRooms', async () => {
  const a = await player(hzUrl, 'D-休眠房主');
  const code = await createRoom(a);
  const before = await healthz(hzSrv.port);
  assert.equal(before.rooms, 1, '活跃房要算进 rooms（否则下面的 0 没有对照）');

  await ok(a, { t: 'room.chat', text: '休眠期间不算活跃' });
  await a.waitFor('chat.msg', (m) => m.text === '休眠期间不算活跃');
  await ok(a, { t: 'room.leave' });
  assert.equal(dormantCount(hzSrv.lobby), 1, '空房应转入休眠表');

  const during = await healthz(hzSrv.port);
  const st = hzSrv.lobby.stats();
  console.log('[证据④] 休眠中 /healthz rooms=%d waitingRooms=%d matches=%d；stats()=%j；休眠表=%d',
    during.rooms, during.waitingRooms, during.matches, st, dormantCount(hzSrv.lobby));
  assert.equal(during.rooms, 0, '休眠房不许算进 /healthz 的 rooms');
  assert.equal(during.waitingRooms, 0, '休眠房不许算进 waitingRooms');
  assert.equal(during.matches, 0);
  assert.equal(st.rooms, 0, 'stats().rooms 也不许算它');
  assert.equal(st.waitingRooms, 0, 'stats().waitingRooms 也不许算它');
  assert.equal(st.matches, 0);
  assert.equal(hzSrv.lobby.getRoom(code), null);
});

test('⑤ 别人拿旧密钥 room.join / room.spectate ⇒ ROOM_NOT_FOUND，不许把休眠房捞回活跃表', async () => {
  const a = await player(longUrl, 'D-旧密钥房主');
  const code = await createRoom(a);
  await ok(a, { t: 'room.chat', text: '休眠房里的旧话' });
  await a.waitFor('chat.msg', (m) => m.text === '休眠房里的旧话');
  await ok(a, { t: 'room.leave' });

  const lobby = longSrv.lobby;
  assert.equal(dormantCount(lobby), 1, '空房应转入休眠表');
  const entry = dormantEntry(lobby, code);
  assert.ok(entry && entry.chat.length === 1);

  const other = await player(longUrl, 'D-拿着旧密钥的人');
  const rj = await other.request({ t: 'room.join', code });
  const rs = await other.request({ t: 'room.spectate', code });
  console.log('[证据⑤] 别人 join ⇒ %j ；spectate ⇒ %j ；休眠表仍有 %d 间，记录 %d 条',
    rj, rs, dormantCount(lobby), entry.chat.length);
  assert.equal(rj.t, 'error', `休眠房不许被 join：${JSON.stringify(rj)}`);
  assert.equal(rj.code, ERR.ROOM_NOT_FOUND);
  assert.equal(rs.t, 'error');
  assert.equal(rs.code, ERR.ROOM_NOT_FOUND);
  assert.equal(lobby.getRoom(code), null, '休眠房不许被别人的 join 捞回活跃表');
  assert.equal(dormantCount(lobby), 1, '别人的 join 不许把它唤醒/消费掉（它还在等房主账号）');
  assert.equal(entry.chat.length, 1, '聊天记录仍留在休眠房里');
  assert.equal(other.log.some((m) => m.t === 'chat.history'), false, '别人不该看到休眠房的聊天');
});

test('⑥ 规矩钉住：唤醒账号 = 最后那位房主；lobby 关停 ⇒ 删房 + 清空聊天记录', async () => {
  // (a) 开房的人先走、别人接了房主 ⇒ 休眠房的唤醒账号是**接任的房主**：开房人自己不再能唤醒它
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
  try {
    const url = `ws://127.0.0.1:${srv.port}/ws`;
    const a = await player(url, 'D-开房人');
    const b = await player(url, 'D-接任房主');
    const code = await createRoom(a);
    await joinRoom(b, code);
    await ok(a, { t: 'room.leave' });
    await ok(b, { t: 'room.leave' });
    const lobby = srv.lobby;
    assert.equal(dormantCount(lobby), 1, '空房应转入休眠表');
    assert.equal(dormantEntry(lobby, code).ownerId, b.id, '唤醒账号 = 最后接任的房主账号');

    // ⚠️ 两个收件箱都先清空：房空之前广播的 room.state 还压在里面，会冒充"这次开房"的那帧
    a.clearInbox();
    await ok(a, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' }); // 开房人已不是房主 ⇒ 不唤醒
    const fresh = await a.waitFor('room.state', seated(a));
    assert.notEqual(fresh.code, code, '开房人回来时已不是房主账号 ⇒ 只能开新房（休眠房仍在等房主）');
    assert.equal(dormantCount(lobby), 1, '休眠房不许被不是房主账号的人消费掉');

    b.clearInbox();
    await ok(b, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' }); // 房主账号回来 ⇒ 唤醒
    const woken = await b.waitFor('room.state', seated(b));
    console.log('[证据⑥-a] 开房人拿到新房 %s；房主账号唤醒原房 %s', fresh.code, woken.code);
    assert.equal(woken.code, code, '房主账号 create 必须唤醒原房');
    assert.equal(dormantCount(lobby), 0);
  } finally {
    await srv.close();
  }

  // (b) lobby 关停（`startServer().close()` → `lobby.shutdown()`）：休眠房必须被删掉、聊天记录清空
  const s2 = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
  const a2 = await player(`ws://127.0.0.1:${s2.port}/ws`, 'D-关停前的房主');
  await createRoom(a2);
  await ok(a2, { t: 'room.chat', text: '关停后必须消失的聊天' });
  await a2.waitFor('chat.msg', (m) => m.text === '关停后必须消失的聊天');
  await ok(a2, { t: 'room.leave' });
  assert.equal(dormantCount(s2.lobby), 1, '关停前它确实是休眠房');
  const chatArr = [...s2.lobby.dormantRooms.values()][0].chat; // 抓住同一个数组：关停后它必须被清空
  await a2.terminate();
  await s2.close();
  console.log('[证据⑥-b] 关停后 休眠表=%d 间，原 chat 数组长度=%d', dormantCount(s2.lobby), chatArr.length);
  assert.equal(dormantCount(s2.lobby), 0, 'lobby 关停必须清空休眠表（定时器一起走）');
  assert.equal(chatArr.length, 0, 'lobby 关停必须清空聊天记录');
});

test('⑦ 进程不会因保留期定时器挂住：只剩一间休眠房时，子进程能自己退出（unref 的端到端证据）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-dormant-probe-'));
  const file = path.join(dir, 'probe.mjs');
  const lobbyUrl = pathToFileURL(path.join(ROOT, 'server', 'lobby.js')).href;
  fs.writeFileSync(file, PROBE_SRC.replace('__LOBBY_URL__', lobbyUrl), 'utf8');
  try {
    // 子进程：造一间休眠房（保留 60 s）⇒ 什么都不做。定时器没 unref 就会挂住 ⇒ 8 s 判超时。
    const r = await run(process.execPath, [file], { timeout: 8000 });
    console.log('[证据⑦] 子进程 status=%s timedOut=%s stdout=%j stderr=%j',
      r.status, r.timedOut, r.stdout.trim(), r.stderr.trim());
    assert.equal(r.timedOut, false, '子进程被保留期定时器挂住了 ⇒ 定时器没 unref()（判据要点 §3.0 第 6 条）');
    assert.equal(r.status, 0, `子进程应自己干净退出：${r.stderr.slice(-500)}`);
    assert.match(r.stdout, /DORMANT-ARMED/, '子进程要先证明它真的武装了一间休眠房');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('⑧ 默认值：保留期 20 分钟 + 休眠表上限 200（都写进 LOBBY_DEFAULTS，可配）', async () => {
  // 规格值（用户逐字口径：「房间关闭后…长时间（20分钟）没有再次…开房间，则要删除该房间并清除聊天记录」；
  // 上限的依据是同一句里的「**以免内存占用过高**」，D 2026-10-07 拍板）
  const SPEC_MS = 20 * 60_000;
  const SPEC_CAP = 200;
  const { LOBBY_DEFAULTS } = await import('../server/lobby.js');
  assert.equal(LOBBY_DEFAULTS.roomRetentionMs, SPEC_MS, '默认保留期必须是 20 分钟');
  assert.equal(Number.isFinite(LOBBY_DEFAULTS.roomRetentionMs), true, '必须是有限的毫秒数');
  assert.equal(LOBBY_DEFAULTS.maxDormantRooms, SPEC_CAP, '休眠表默认上限必须写进 LOBBY_DEFAULTS');
  // 行为面：默认服务器（没注入 roomRetentionMs）上的休眠房，200ms 后**还在**（默认远长于 200ms；上面的 ③ 才是短保留期）
  // ⚠️ longSrv 是①②⑤共用的 ⇒ 计数用**增量**，别假设全局只有这一间休眠房
  const before = dormantCount(longSrv.lobby);
  const a = await player(longUrl, 'D-默认保留期');
  const code = await createRoom(a);
  await ok(a, { t: 'room.leave' });
  assert.equal(dormantCount(longSrv.lobby), before + 1, '默认服务器上的空房也应转休眠');
  await delay(200);
  const entry = dormantEntry(longSrv.lobby, code);
  assert.ok(entry, '默认保留期下 200ms 后必须还在休眠表里');
  assert.equal(entry.timer.hasRef(), false, '默认保留期的定时器同样必须 unref()');
  console.log('[证据⑧] 默认 roomRetentionMs=%d ms / maxDormantRooms=%d；200ms 后休眠表仍有 %d 间',
    LOBBY_DEFAULTS.roomRetentionMs, LOBBY_DEFAULTS.maxDormantRooms, dormantCount(longSrv.lobby));
});

test('⑨ 休眠表上限：超了淘汰最早休眠的那间（清它的 chat），之后那个房号再也拿不到', async () => {
  // 注入 maxDormantRooms: 2；保留期放长（60 s）⇒ 这一条只看"上限淘汰"，不看超时回收
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, roomRetentionMs: 60_000, maxDormantRooms: 2 });
  try {
    const url = `ws://127.0.0.1:${srv.port}/ws`;
    /** 开一间房、说一句话、然后离开（⇒ 该房转休眠）。 */
    const dormantRoom = async (name) => {
      const c = await player(url, name);
      const code = await createRoom(c);
      await ok(c, { t: 'room.chat', text: `来自 ${name}` });
      await c.waitFor('chat.msg', (m) => m.text === `来自 ${name}`);
      await ok(c, { t: 'room.leave' });
      return { c, code };
    };
    const r1 = await dormantRoom('D-第1间'); // 最早休眠 ⇒ 该被淘汰
    const r2 = await dormantRoom('D-第2间');
    assert.equal(dormantCount(srv.lobby), 2, '上限 2 ⇒ 两间都留着');
    const entry1 = dormantEntry(srv.lobby, r1.code);
    assert.equal(entry1.chat.length, 1, '第 1 间的聊天记录还在');

    const r3 = await dormantRoom('D-第3间'); // 第 3 间 ⇒ 超上限 ⇒ 淘汰最早的 r1
    console.log('[证据⑨] 上限 2 + 第 3 间 ⇒ 淘汰最早的 %s；休眠表 %d 间', r1.code, dormantCount(srv.lobby));
    assert.equal(dormantCount(srv.lobby), 2, '上限 2 ⇒ 休眠表永远不超过 2 间');
    assert.equal(dormantEntry(srv.lobby, r1.code), null, '最早休眠的那间必须被淘汰（FIFO）');
    assert.equal(entry1.chat.length, 0, '被淘汰那间的聊天记录必须清空（用户要的就是省内存）');
    assert.equal(entry1.timer, null, '被淘汰那间的保留期定时器必须已取消');
    assert.equal(dormantEntry(srv.lobby, r2.code)?.chat.length, 1, '没被淘汰的那间记录原样保留');
    assert.equal(dormantEntry(srv.lobby, r3.code)?.chat.length, 1, '新来的那间也在表里');

    // 第 1 间那个账号再开房 ⇒ 拿不到原房号（它已被淘汰 ⇒ 新房号 + 不发 chat.history）
    r1.c.clearInbox();
    await ok(r1.c, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
    const fresh = await r1.c.waitFor('room.state', seated(r1.c));
    console.log('[证据⑨-b] 被淘汰的 %s ⇒ 该账号再开房拿到 %s', r1.code, fresh.code);
    assert.notEqual(fresh.code, r1.code, '被淘汰的房号不许复用（它已不是休眠房）');
    await r1.c.expectNone('chat.history', () => true, 200);
    assert.equal(dormantCount(srv.lobby), 2, '它开的是新房（活跃），休眠表仍是 2 间');
  } finally {
    await srv.close();
  }
});

test('⑩ 野排不会进休眠房、也不会消费掉它；房主账号自己野排仍走 create 的唤醒规则', async () => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true }); // 默认保留 20 分钟
  try {
    const url = `ws://127.0.0.1:${srv.port}/ws`;
    const host = await player(url, 'D-休眠房主');
    const code = await createRoom(host);
    await ok(host, { t: 'room.chat', text: '休眠房里的旧话' });
    await host.waitFor('chat.msg', (m) => m.text === '休眠房里的旧话');
    await ok(host, { t: 'room.leave' });
    const lobby = srv.lobby;
    assert.equal(dormantCount(lobby), 1, '空房应转入休眠表');
    const entry = dormantEntry(lobby, code);
    assert.equal(entry.chat.length, 1);

    // 池子里只剩休眠房 ⇒ findMatchmakeRoom 必须什么都找不到（休眠房不是等待房，它已关闭）
    assert.equal(lobby.findMatchmakeRoom('NORMAL', null), null, 'findMatchmakeRoom 不许把休眠房当等待房');

    // (a) **别人**按快速匹配 ⇒ 只会建/进自己的房，绝不进休眠房、也不许把它消费掉
    const other = await player(url, 'D-野排的人');
    other.clearInbox();
    await ok(other, { t: 'room.matchmake', difficulty: 'NORMAL' });
    const st = await other.waitFor('room.state', seated(other));
    console.log('[证据⑩-a] 别人野排 ⇒ 进/建了 %s（休眠房是 %s）；休眠表仍有 %d 间，记录 %d 条',
      st.code, code, dormantCount(lobby), entry.chat.length);
    assert.notEqual(st.code, code, '野排绝不进休眠房');
    assert.equal(lobby.getRoom(code), null, '休眠房不许被野排捞回活跃表');
    assert.equal(dormantCount(lobby), 1, '野排不许消费掉别人的休眠房');
    assert.equal(entry.chat.length, 1, '它的聊天记录也不许被野排动');
    assert.equal(other.log.some((m) => m.t === 'chat.history'), false, '野排的人看不到休眠房里的聊天');

    // (b) **房主账号自己**按快速匹配：野排池里没有同难度的等待房（上面那间是 NORMAL，这里用 HARD 避开）
    //     ⇒ matchmake 走 create ⇒ 唤醒规则照旧（口径 §3.0 第 5 条：同一房主账号 + 开房路径）
    host.clearInbox();
    await ok(host, { t: 'room.matchmake', difficulty: 'HARD' });
    const back = await host.waitFor('room.state', seated(host));
    const hist = await host.waitFor('chat.history');
    console.log('[证据⑩-b] 房主账号自己野排 ⇒ 唤醒 %s；chat.history=%j', back.code, hist);
    assert.equal(back.code, code, '房主账号自己野排走的是 create 这条路 ⇒ 按 §3.0.5 唤醒原房');
    assert.equal(hist.messages.length, 1);
    assert.equal(hist.messages[0].text, '休眠房里的旧话');
    assert.equal(lobby.getRoom(code)?.matchmade, true, '唤醒后的房确实变成了野排房');
    assert.equal(dormantCount(lobby), 0, '唤醒 ⇒ 出休眠表');
  } finally {
    await srv.close();
  }
});
