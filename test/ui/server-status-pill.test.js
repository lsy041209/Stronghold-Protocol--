// test/ui/server-status-pill.test.js — 左上角「在线人数 / 房间数」胶囊（第 3 任 D，2026-10-06）
//
// 用户要求：在**服务器端页面左上角的延迟旁边**标出当前在线人数与房间数。
// 组件（ui/serverStatusPill.js）与轮询（ui/serverStatus.js）早已存在，但此前**只挂在标题页与大厅页**；
// 对局内顶栏 / 赛前步骤页头 / 房间页只有延迟 —— 本次补齐（并加 .statusrow 让它们在竖排容器里也并排）。
//
// 本测试钉两件事：
//   ① 三种状态的判定：未就绪 → 什么都不画；离线 → 离线胶囊；有读数 → 在线 + 房间 + 明细。
//      走**纯函数 `pillView`**：带 hooks 的 preact 组件在 Node 里不能直接调用（实测抛 `reading '__H'`），
//      所以既有那种 `walk(vnode)` 的写法在这里不适用。
//   ② 不变量：**凡是挂了延迟（PingPill）的文件，必须也挂这个胶囊** —— 否则下次有人在别处加个延迟就漏了。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const { pillView } = await import('../../public/js/ui/serverStatusPill.js');
const { SERVER_STATUS_OFFLINE, parseServerStats } = await import('../../public/js/ui/serverStatus.js');

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// 🔴 2026-10-08 第 4 任 D：**端到端那条链**（`/healthz` 原始 JSON → `parseServerStats` → `pillView`）。
//
// 为什么必须单独钉这一段：用户实测报「**我只开了两个浏览器，却显示有 3 人**」。
// 根因在 `parseServerStats` —— 它原来把 `sockets`（WebSocket **连接数**）当"在线人数"；
// 而 `server/net.js` 在**每一条 upgrade 成功的 socket** 上立刻登记，真正的会话要等客户端发 `hello` 才有
// ⇒ **"连上但没握手"的连接被算成一个人**。
//
// ⚠️ **这里是我当天先是漏掉、后补上的一段**：我最初只写了 `pillView({online: …})` 那种**手工造对象**的用例，
//    于是"把 `online` 改回 sockets 口径"这个**真回归**照样 12/12 全绿（= 假绿）。
//    教训（C 当天刚升格成规则）：**只测负例/只喂手工字段，测不到真实入参那条链。**
//    所以下面**一律用 `/healthz` 的原始形状**喂 `parseServerStats`，再喂给 `pillView`。
test('端到端：`sockets=3` 但 `sessionsOnline=2` ⇒ **显示 2 人**（不是 3）——用户报的那条', () => {
  // 真实形状（本机 :3001 实测抓到的）：3 条连接、其中 1 条"连上但没握手"、2 个真会话。
  const raw = { ok: true, sockets: 3, sessions: 2, sessionsOnline: 2, onlineInLobby: 2,
    rooms: 0, matches: 0, humans: 0, bots: 0, spectators: 0 };
  const s = parseServerStats(raw);
  assert.equal(s.online, 2, `🔴 必须取"已握手的会话数"2，而不是连接数 3（实测 ${s.online}）`);
  assert.equal(s.sockets, 3, '连接数仍要保留（技术读数）');
  const v = pillView(s);
  assert.equal(v.online, 2);
  assert.ok(v.detail.includes('在线 2 人'), `明细要写 2，实测：${v.detail}`);
});

test('端到端：没有 `sessionsOnline` 的老服务器 ⇒ 退回 `onlinePlayers`／`humans`／`sessions`，最后才退回连接数', () => {
  // 0.2.1 之前的服务端只报 sockets/sessions/humans
  assert.equal(parseServerStats({ sockets: 9, humans: 4 }).online, 4, '有 humans 就用 humans（在座真人）');
  assert.equal(parseServerStats({ sockets: 9, sessions: 7 }).online, 7, '没有 humans 就退到 sessions');
  assert.equal(parseServerStats({ sockets: 9 }).online, 9, '**什么都没有**才退回连接数（老服务器兼容）');
  assert.equal(parseServerStats({ sockets: 9, onlinePlayers: 5 }).online, 5, 'onlinePlayers 优先于 humans');
  // 完全读不到 ⇒ null（不许显示自信的 0）
  assert.equal(parseServerStats({}).online, null);
});

test('端到端：`dormantRooms` 要透传到明细（"房间比人多"的解释）', () => {
  const s = parseServerStats({ sockets: 1, sessionsOnline: 1, rooms: 0, dormantRooms: 3 });
  assert.equal(s.dormantRooms, 3);
  const v = pillView(s);
  assert.ok(v.detail.includes('休眠房 3'), `明细要写出休眠房数，实测：${v.detail}`);
});

test('pillView: 还没轮询过 ⇒ null（半秒的「0 在线」会让百人服看起来没人）', () => {
  assert.equal(pillView(undefined), null);
});

test('pillView: 读不到服务器 ⇒ 离线，且明细点明是 /healthz 没响应', () => {
  const v = pillView(SERVER_STATUS_OFFLINE);
  assert.equal(v.kind, 'offline');
  assert.equal(v.online, null);
  assert.equal(v.rooms, null);
  assert.match(v.detail, /healthz/);
});

test('pillView: 有读数 ⇒ 在线用 online、房间用 rooms，明细带上其余计数', () => {
  const v = pillView({ online: 25, rooms: 55, matches: 54, sessions: 72, humans: 62, spectators: 1, bots: 3 });
  assert.equal(v.kind, 'reading');
  assert.equal(v.online, 25);
  assert.equal(v.rooms, 55);
  // ⚠️ 2026-10-08 第 4 任 D：措辞改了 —— 头条那个数是"**已握手的会话**"，不再自称"活跃连接"。
  //    原因（用户实测报「开 2 个浏览器却显示 3 人」）：`sockets` 含"连上但没握手"的连接，
  //    以前拿它当人数 ⇒ 数多。详见 `serverStatus.js` 的 `parseServerStats` 注释 与
  //    `test/healthz-online-semantics.test.js`（服务端侧的同一条判据）。
  for (const part of ['在线 25 人（已握手的会话）', '房间 55', '对局 54', '会话 72（含重连窗口）', '在座 62', '观战 1', 'AI 3']) {
    assert.ok(v.detail.includes(part), `明细里应有「${part}」，实测：${v.detail}`);
  }
});

test('pillView: 休眠房要单独说出来（否则"房间比人多"看起来像 bug，其实是保留期）', () => {
  // 服务端 `/healthz` 的 `dormantRooms`：人走了但还在保留期（默认 20 分钟）里的空房。
  const v = pillView({ online: 1, rooms: 0, dormantRooms: 3 });
  assert.ok(v.detail.includes('房间 0（另有休眠房 3）'),
    `有休眠房时明细必须写出来，实测：${v.detail}`);
  // 没有休眠房（或老服务端不报这个字段）⇒ 不许编造后半句
  const w = pillView({ online: 1, rooms: 2 });
  assert.ok(!w.detail.includes('休眠房'), `无休眠房时不该出现「休眠房」，实测：${w.detail}`);
  const z = pillView({ online: 1, rooms: 2, dormantRooms: 0 });
  assert.ok(!z.detail.includes('休眠房'), `休眠房为 0 时也不该出现，实测：${z.detail}`);
});

test('pillView: 连接数如实标注为"连接"（它是技术读数，不是人数）', () => {
  const v = pillView({ online: 2, rooms: 0, sockets: 3, sessions: 5 });
  assert.ok(v.detail.includes('连接 3（含未握手）'), `连接数必须标明含未握手，实测：${v.detail}`);
  assert.ok(v.detail.includes('会话 5（含重连窗口）'), `会话数必须标明含重连窗口，实测：${v.detail}`);
});

test('pillView: 旧服务端缺计数 ⇒ 头条数字取 0，但没报的项不编造', () => {
  const v = pillView({ online: null, rooms: null });
  assert.equal(v.online, 0);
  assert.equal(v.rooms, 0);
  assert.equal(v.detail, '在线 0 人（已握手的会话） · 房间 0');
});

test('pillView: 0 观战 / 0 AI 不进明细（别在 tooltip 里堆噪音）', () => {
  const v = pillView({ online: 1, rooms: 1, spectators: 0, bots: 0 });
  assert.ok(!v.detail.includes('观战'));
  assert.ok(!v.detail.includes('AI'));
});

test('位置不变量：每个挂了延迟的地方，都必须也挂「在线/房间」胶囊', () => {
  const files = ['public/js/ui', 'public/js/screens']
    .flatMap((d) => fs.readdirSync(path.join(ROOT, d)).filter((f) => f.endsWith('.js')).map((f) => `${d}/${f}`));
  const mountsPing = files.filter((f) => /<\$\{PingPill\}/.test(read(f)));
  assert.ok(mountsPing.length >= 5, `应至少 5 处挂延迟（标题 / 大厅 / 房间 / 对局内顶栏 / 赛前步骤页头），实测 ${mountsPing.length}`);
  const missing = mountsPing.filter((f) => !/<\$\{ServerStatusPill\}/.test(read(f)));
  assert.deepEqual(missing, [], '这些文件挂了延迟却没有「在线/房间」胶囊（用户 2026-10-06 的要求）');
});
