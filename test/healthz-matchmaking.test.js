// test/healthz-matchmaking.test.js — `/healthz` 的**野排读数**（第 4 任 D，2026-10-08，C 的派工 T6b）
//
// ## 为什么需要它
// 野排（`room.matchmake`）是**我方独有**的联机功能（上游 `lobby.js` 里 0 处），服务端早已全绿
// （`test/lobby-matchmake.test.js` 8/8），但**"线上到底有没有人在用它"以前没有任何读数** ——
// 只能靠猜。C 10-08 实测外部同族服务器报的是 `queue` 字段（二服/四服 `queue: 0`），我们**没有对应字段**。
// ⇒ 这条判据把"野排正在凑人"变成一个**能从外部看的数据**：`/healthz.matchmaking`。
//
// ## 判据形状（**三态**，每一态都能红）
//   ① 没人野排 ⇒ **0**
//   ② 有人点了快速匹配、房间还在凑人 ⇒ **1**
//   ③ 该房到点用 AI 补满并**开局** ⇒ 回到 **0**（"凑人"结束；若这里不退，读数就永远挂在 1，是假绿）
//   ➕ ④ 空服务器上这个字段必须**存在且是数字**（不是 undefined/NaN）—— 否则看板会显示 undefined。
//   ➕ ⑤ 回归护栏：**普通等待房不算 matchmaking**（别把它做成 `waitingRooms` 的别名）。
//
// ## 阴性对照（证明它会红）
//   把 `lobby.stats()` 里的 `matchmaking++` 删掉 ⇒ ② 立刻红（恒 0）；
//   把 `routes.js` 的 `matchmaking: ls.matchmaking` 删掉 ⇒ ④ 立刻红。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';

/** 每一态都独立起一台服务器，互不污染（同一进程里跑多台是既有做法，见 lobby-matchmake.test.js）。 */
async function boot(opts = {}) {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, ...opts });
  const url = `ws://127.0.0.1:${srv.port}/ws`;
  const health = async () => (await fetch(`http://127.0.0.1:${srv.port}/healthz`)).json();
  return { srv, url, health };
}

/** 连上 + `hello`（**必须先握手**，否则服务端回 `hello required`）+ 记下 playerId/token。 */
async function player(wsUrl, name) {
  const c = await TestClient.connect(wsUrl);
  const w = await c.hello(name);
  c.id = w.playerId;
  c.token = w.token;
  return c;
}

test('①+④ 空服务器：`matchmaking` 存在、是数字、且为 0', async () => {
  const { srv, health } = await boot();
  try {
    const b = await health();
    assert.ok('matchmaking' in b, '`matchmaking` 字段必须存在（它是本判据要暴露的读数）');
    assert.equal(typeof b.matchmaking, 'number', `应是数字，实测 ${JSON.stringify(b.matchmaking)}`);
    assert.ok(Number.isFinite(b.matchmaking), '不许是 NaN/Infinity');
    assert.equal(b.matchmaking, 0, '没有人在野排 ⇒ 0');
  } finally { await srv.close(); }
});

test('② 有人快速匹配 ⇒ `matchmaking` 变 1（并且核心字段一个不少）', async () => {
  // 这台的补齐窗口放长，免得还没量到就开局了
  const { srv, url, health } = await boot({ matchmakeFillMs: 60_000 });
  const c = await player(url, 'D-野排读数');
  try {
    assert.equal((await health()).matchmaking, 0, '连接本身不该让读数为 1');
    const r = await c.request({ t: 'room.matchmake', difficulty: 'NORMAL' });
    assert.equal(r.t, 'ok', `room.matchmake 应被接受：${JSON.stringify(r)}`);
    // 等它真的进房（room.state 到了再量，避免竞态）
    await c.waitFor('room.state', (s) => !!s.code);
    assert.equal((await health()).matchmaking, 1, '有 1 间野排房在凑人 ⇒ 1');
    // 核心字段不许被这次改动碰掉
    const b = await health();
    for (const k of ['ok', 'version', 'app', 'uptimeSec', 'build', 'sockets', 'sessions', 'rooms', 'matches']) {
      assert.ok(k in b, `核心字段 ${k} 丢了（契约：只能加，不能删/改名）`);
    }
  } finally { await c.terminate(); await srv.close(); }
});

test('③ 到点 AI 补满并开局 ⇒ `matchmaking` 回 0（否则读数会永远挂在 1）', async () => {
  const { srv, url, health } = await boot({ matchmakeFillMs: 400 });
  const c = await player(url, 'D-野排到点');
  try {
    assert.equal((await c.request({ t: 'room.matchmake', difficulty: 'NORMAL' })).t, 'ok');
    await c.waitFor('room.state', (s) => !!s.code);
    assert.equal((await health()).matchmaking, 1, '刚匹配完：还在凑人');
    // 到期 ⇒ addBot 补满 + start ⇒ `matchmakePoolAlive` 变假（已开局）⇒ 读数归 0
    await c.waitFor('room.state', (s) => s.inMatch === true, 8000);
    const after = await health();
    assert.equal(after.matchmaking, 0, '已开局 ⇒ 不再是"正在凑人的房"');
    assert.ok(after.matches >= 1, '顺带核一下这台服务器真的进了对局');
  } finally { await c.terminate(); await srv.close(); }
});

test('⑤ 回归护栏：非野排的普通等待房**不算** matchmaking（别把它做成 waitingRooms 的别名）', async () => {
  const { srv, url, health } = await boot({ matchmakeFillMs: 60_000 });
  const c = await player(url, 'D-普通房');
  try {
    // 手建一间普通 coop 房：它在 `waitingRooms` 里算 1，但**不是野排** ⇒ matchmaking 必须是 0
    assert.equal((await c.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' })).t, 'ok');
    await c.waitFor('room.state', (s) => !!s.code);
    const b = await health();
    assert.equal(b.waitingRooms, 1, '普通等待房应计进 waitingRooms');
    assert.equal(b.matchmaking, 0, '**它不该**计进 matchmaking —— 两个读数量的是不同东西');
  } finally { await c.terminate(); await srv.close(); }
});
