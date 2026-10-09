// test/healthz-online-semantics.test.js
//   —— "我开 2 个浏览器，界面却写 3 人在线" ＋ "房间比人还多" 的**能红判据**
//      （第 4 任 D，2026-10-08；用户实测报告）
//
// ## 现象（用户报告，真机截图）
// 大厅顶栏显示「**3 在线 ｜ 0 房间**」，但用户**只开了 2 个浏览器**。
// 且用户另报：服务器内会出现「**房间比人还多**」。
//
// ## 根因（三条，各有探测读数为证）
// ① **UI 的「在线」数的是 `sockets`（WebSocket 连接数），不是人数**
//    —— `net.js:587` 每一条 upgrade 成功的 socket **立刻**进 `conns`，而 `sessions` 要等客户端发 `hello` 才有。
//    ⇒ **"连上但没握手"的连接被算成"一个人"**。
//    实测（`.workbuddy/tools/d-probe-online-count-semantics.mjs`）：只连不发 hello ×2 ⇒ `sockets +2`、`sessions +0`。
// ② **`sessions` 也不能当"在线"**：它含"断线但仍在重连窗口内"的会话，**断开后不回落**。
//    实测同探针 ③：全部断开后 `sockets` 回到基线，而 `sessions` **仍停在 +1**。
//    ⇒ 真正的"在线会话"是 **`sessionsOnline`**（已握手且 `connected`）。
// ③ **房间会活「宽限期 ＋ 休眠期」，所以"房间数"长期大于"在线人数"**
//    —— 掉线**不立刻走人**：`lobby.js:489` 先 `startGrace`（`lobbyGraceMs` 默认 **60 s**），
//       宽限到了才 `removeMember` ⇒ 空了才 `disposeRoom('empty')` ⇒ 再进 `dormantRooms` 保留 `roomRetentionMs`（默认 **20 分钟**）。
//    ⇒ 所以人走了房间还在，**这是有意的**（房号可找回）；但 `/healthz` 以前**没有一个字段告诉你"有几间是休眠房"**。
//
// ## 判据形状（每一态都能红）
//   ① `sockets` 会把"只连接不 hello"的连接算进去 ⇒ 必须还能拿到 **`sessionsOnline`**，且它**不涨**；
//   ② 断开之后 `sessionsOnline` 必须**回落**（`sessions` 允许不回落 —— 那是重连窗口）；
//   ③ `/healthz` 必须**分别**给出「活跃房」与「休眠房」的口径（`dormantRooms`），否则看板无法区分"有人在的房"与"人走了还在的房"；
//   ④ 回归护栏：**"只连接不 hello"不许把 `sessionsOnline` 或 `onlineHumans` 抬起来**（否则又是"把人算多"）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

import { startServer } from '../server/index.js';

/** 起一台自己的服务器（不碰别人的端口），并给一个 healthz 读取器。 */
async function boot(opts = {}) {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, ...opts });
  const base = `http://127.0.0.1:${srv.port}`;
  return {
    srv,
    wsUrl: `ws://127.0.0.1:${srv.port}/ws`,
    health: async () => (await fetch(`${base}/healthz`)).json(),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 连上并完成 `hello`（= 一个真正的会话）。 */
async function hello(wsUrl, name) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.send(JSON.stringify({ t: 'hello', name, version: 1 }));
  await new Promise((res, rej) => {
    const tm = setTimeout(() => rej(new Error('hello 超时')), 4000);
    ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.t === 'welcome') { clearTimeout(tm); res(m); } });
  });
  return ws;
}

/** 只连接、**不发 hello**（= 用户那种"连上但没握手"的连接）。 */
async function bareConnect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  return ws;
}

test('① 用户报告的形状：只连接不 hello 的连接会抬高 `sockets`，但**不许**抬高 `sessionsOnline`', async () => {
  const { srv, wsUrl, health } = await boot();
  try {
    const base = await health();
    // 只连不发 hello ×2 —— 这就是"多出来的那条连接"
    const bare = [await bareConnect(wsUrl), await bareConnect(wsUrl)];
    await sleep(250);
    const after = await health();

    assert.ok(after.sockets > base.sockets, `sockets 应包含这些连接（基线 ${base.sockets} → ${after.sockets}）`);
    assert.equal(after.sessionsOnline, base.sessionsOnline,
      `🔴 \`sessionsOnline\` 必须**不涨**（它是"真会话数"）——实测 ${base.sessionsOnline} → ${after.sessionsOnline}`);
    assert.equal(after.onlineHumans, base.onlineHumans, '`onlineHumans` 也不许被"没握手的连接"抬高');

    for (const ws of bare) ws.close();
  } finally { await srv.close(); }
});

test('② 断开之后 `sessionsOnline` 必须回落（`sessions` 允许不回落 = 重连窗口）', async () => {
  const { srv, wsUrl, health } = await boot();
  try {
    const base = await health();
    const ws = await hello(wsUrl, 'D-口径②');
    await sleep(200);
    const during = await health();
    assert.equal(during.sessionsOnline, base.sessionsOnline + 1, '握手后应 +1');

    ws.close();
    await sleep(600);
    const after = await health();
    assert.equal(after.sessionsOnline, base.sessionsOnline,
      `🔴 断开后 \`sessionsOnline\` 必须回落（实测 ${after.sessionsOnline}，基线 ${base.sessionsOnline}）`);
    assert.ok(after.sessions >= base.sessions + 1,
      '`sessions` **允许**不回落（它含重连窗口内的会话）—— 这正是它不能当"在线人数"的原因');
  } finally { await srv.close(); }
});

test('③ `/healthz` 必须分开给出「活跃房」与「休眠房」的口径（否则"房间比人多"没法解释）', async () => {
  const { srv, wsUrl, health } = await boot({ roomRetentionMs: 60_000, lobbyGraceMs: 50 });
  try {
    const ws = await hello(wsUrl, 'D-口径③');
    ws.send(JSON.stringify({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' }));
    await sleep(300);
    const built = await health();
    assert.equal(built.roomsOnline, 1, '建完房应在"在线房"里');

    ws.close();
    // 宽限期（50 ms）过了 ⇒ 走人 ⇒ 房转休眠
    await sleep(900);
    const after = await health();

    assert.equal(after.roomsOnline, 0, '人走了 ⇒ 不再有"在线房"');
    assert.ok('dormantRooms' in after,
      '🔴 `/healthz` 必须给出 `dormantRooms`（休眠房数）—— 否则看板分不清"有人在的房"与"人走了还在保留期的房"');
    assert.equal(after.dormantRooms, 1, `那 1 间应被算成休眠房（实测 ${after.dormantRooms}）`);
  } finally { await srv.close(); }
});

test('④ 回归护栏：`sockets` 恒 ≥ `sessionsOnline`，且两者只有在"都真在线"时才相等', async () => {
  const { srv, wsUrl, health } = await boot();
  try {
    const bare = await bareConnect(wsUrl);
    const good = await hello(wsUrl, 'D-口径④');
    await sleep(250);
    const b = await health();
    assert.ok(b.sockets > b.sessionsOnline,
      `有"没握手的连接"时 sockets(${b.sockets}) 必须 **严格大于** sessionsOnline(${b.sessionsOnline}) —— 这就是 UI 数错人的条件`);
    bare.close(); good.close();
  } finally { await srv.close(); }
});
