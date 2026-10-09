// test/lobby-chat.test.js — D-3（房间内打字聊天）的【服务端 + 协议】判据（2026-10-07，会话 D）
//
// 权威规格：`协作/D-口径-房间内聊天-兼容与规格-2026-10-07.md`（§1 兼容结论 / §2 规格 / §3 用户逐字裁决）；
// 给 B 的字段口径：`协作/D给B-聊天面板UI口径-2026-10-07.md`
//   —— C2S `room.chat { text }`；S2C `chat.msg { from, name, text, at }`（广播给同房所有人，含观战者）；
//   重连/重进补发 `chat.history { messages }`（走现有 `onHello` 重发路径）。
//
// 本文件全部走**真实服务器 + 真实 `ws` 客户端**（不用桩、不直接调私有函数下断言）。对局用**真 Match**
// （缩放计时器 + `FakeBattle`，战斗由服务端跑 ⇒ 不需要浏览器/仿真客户端），所以"对局中能不能聊""阵亡转观战
// 能不能聊"都是真的在跑一局时问的。八条：
//   ① 同房 A 发、B（与 A 自己）都收到 `chat.msg`，`from`/`name`/`text`/`at` 正确；
//   ② **不同房 / 房外的人收不到**；
//   ③ 权限：**纯观战者被拒**（`ERR.SPECTATOR`，房间内与对局中各问一次），**占过座位的阵亡观战者可以**；
//   ④ 超长按 **Unicode 码点**截到 120（含 emoji 代理对，不许截出半个字符）；
//   ⑤ 高频连发 10 条 ⇒ **收到的 < 10**（1 条/秒、突发 3；复用 `server/net.js` 的令牌桶，超了回 `ERR.RATE`）；
//   ⑥ 空串 / 纯控制字符 / 纯空白 ⇒ 被拒（`BAD_MSG`）；带控制字符但有字的串 ⇒ 清洗后照常发出；
//   ⑦ 断开重连（同 token）⇒ 收到 `chat.history` 且含刚才那条；环形缓冲只留最近 50 条；
//   ⑧ 🔴 **隐私哨兵**：**带聊天的对局**结束后，`var/stats/**` 与 `var/state/**` 里搜不到那句聊天
//      （同时断言这两个目录**确实落了文件**，否则"搜不到"是空搜）；顺带证明用户裁决 ④
//      （表情包 `m.emote` **一行都没改**）仍然工作。
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';
import { Match } from '../server/match/Match.js';
import { FakeBattle } from './match/fakeBattle.js';
import { ERR, EMOTES } from '../shared/constants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** 判据里**写死**的规格值（故意不从实现里 import，否则就是拿实现自证实现）。 */
const CHAT_MAX = 120;
const HISTORY_MAX = 50;
/** 隐私哨兵：一句可搜的独特字符串。 */
const SENTINEL = '聊天哨兵-7f3a';

/** 真 Match + 服务端跑战斗 + 缩放计时器：跑得动一整局，且不需要浏览器。 */
class FastChatMatch extends Match {
  constructor(o) { super({ ...o, timerScale: 0.02, BattleClass: FakeBattle, clientCombat: false }); }
}

let srv;        // 默认参数（含默认限流 1/s 突发 3）：①②④⑤⑦
let srvUrl;
let bigSrv;     // 两个令牌桶都放大：⑥ 的清洗、⑦ 的环形缓冲要的是"不被限流干扰"
let bigUrl;
let matchSrv;   // 真对局：③
let matchUrl;
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

/** 递归列目录里的文件（隐私判据用）。 */
function walkFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(p));
    else out.push(p);
  }
  return out;
}

before(async () => {
  srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
  srvUrl = `ws://127.0.0.1:${srv.port}/ws`;
  // 限流本身由 ⑤ 在**默认值**下测；⑥/⑦ 要测的是清洗与环形缓冲 ⇒ 把桶放大，别让限流替它们回答
  bigSrv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, ratePerSec: 200, rateBurst: 200, chatPerSec: 200, chatBurst: 200 });
  bigUrl = `ws://127.0.0.1:${bigSrv.port}/ws`;
  matchSrv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, MatchClass: FastChatMatch });
  matchUrl = `ws://127.0.0.1:${matchSrv.port}/ws`;
});

afterEach(async () => {
  await Promise.all(perTest.map((c) => c.terminate().catch(() => {})));
  perTest = [];
  FakeBattle.script = null; // 静态脚本不许跨用例漏出去
});

after(async () => {
  await Promise.all(perTest.map((c) => c.terminate().catch(() => {})));
  perTest = [];
  await srv.close();
  await bigSrv.close();
  await matchSrv.close();
});

test('① 同房 A 发 ⇒ B（与 A 自己）都收到 chat.msg，from/name/text/at 正确', async () => {
  const a = await player(srvUrl, 'D-聊天甲');
  const code = await createRoom(a);
  const b = await player(srvUrl, 'D-聊天乙');
  await joinRoom(b, code);

  const r = await a.request({ t: 'room.chat', text: '你好，同盟！' });
  assert.equal(r.t, 'ok', `room.chat 应被接受，实际：${JSON.stringify(r)}`);
  const gotB = await b.waitFor('chat.msg');
  const gotA = await a.waitFor('chat.msg'); // 广播给同房所有人 —— 发送者也在内
  console.log('[证据①] A 的回复 %j ；B 收到 %j', r, gotB);
  for (const got of [gotA, gotB]) {
    assert.equal(got.from, a.id, 'from = playerId');
    assert.equal(got.name, 'D-聊天甲', 'name = 当前昵称');
    assert.equal(got.text, '你好，同盟！');
    assert.equal(typeof got.at, 'number', 'at = ms epoch');
  }
  assert.equal(gotA.at, gotB.at, '同一条广播，时间戳必须一致');
});

test('② 不同房 / 房外的人收不到', async () => {
  const a = await player(srvUrl, 'D-房甲');
  const codeA = await createRoom(a);
  const other = await player(srvUrl, 'D-另一房');
  const codeB = await createRoom(other);
  assert.notEqual(codeA, codeB);
  const lone = await player(srvUrl, 'D-大厅里的人'); // 没进任何房

  await ok(a, { t: 'room.chat', text: '只在本房可见' });
  await ok(a, { t: 'room.chat', text: '第二句也只在同一间房' });
  await other.expectNone('chat.msg', () => true, 300);
  await lone.expectNone('chat.msg', () => true, 300);
  console.log('[证据②] 另一房（%s）与房外的人 300ms 内都没有 chat.msg', codeB);
});

test('③ 权限：纯观战者被拒（ERR.SPECTATOR），占过座的阵亡观战者可以发言', async () => {
  const a = await player(matchUrl, 'D-房主');
  const code = await createRoom(a);
  const b = await player(matchUrl, 'D-队友');
  await joinRoom(b, code);
  await ok(a, { t: 'room.addBot' }); // 第三席 AI
  await ok(b, { t: 'room.ready', ready: true });

  const spec = await player(matchUrl, 'D-纯观战');
  await ok(spec, { t: 'room.spectate', code });

  // (a) 房间（准备阶段）里的纯观战者：从未占过座 ⇒ 拒
  const rLobby = await spec.request({ t: 'room.chat', text: '我也说一句' });
  console.log('[证据③-纯观战/房间内] %j', rLobby);
  assert.equal(rLobby.t, 'error', `纯观战者必须被拒：${JSON.stringify(rLobby)}`);
  assert.equal(rLobby.code, ERR.SPECTATOR);

  await ok(a, { t: 'room.start' });
  await a.waitFor('m.public', (p) => p.phase === 'INFO_CHECK');
  await ok(a, { t: 'g.infoReady' });
  await ok(b, { t: 'g.infoReady' });
  // 天赋 draft：轮到谁谁选（AI 自己选）；缩放的计时器也可能替人超时选掉 ⇒ 只等"进入 PREP R1"。
  // ⚠️ 同一份 draft 状态会被 m.public 的节流重复推几次 ⇒ 用本地 Set 记住"这个人已经点过"，不重复点；
  // 同一个天赋被队友先抢了会回 BAD_TARGET（"队友已选"）⇒ 换一个再试，失败也无所谓（超时会自动选）。
  const picked = new Set();
  const BANDS = ['band_bldsk', 'band_sarkazb'];
  for (let i = 0; i < 60; i++) {
    const p = await a.waitFor('m.public', (x) => x.phase !== 'INFO_CHECK', 15000);
    if (p.phase !== 'BAND_DRAFT') break;
    const turn = p.draft && p.draft.turn;
    if (turn !== a.id && turn !== b.id) continue;
    if (picked.has(turn) || (p.draft.picks && p.draft.picks[turn])) continue;
    picked.add(turn);
    const who = turn === a.id ? a : b;
    for (const bandId of BANDS) {
      const r = await who.request({ t: 'g.band', bandId });
      if (r.t === 'ok') break;
      console.log('[③-天赋] %s 选 %s 被拒 %j（换一个 / 等超时自动选）', turn === a.id ? '房主' : '队友', bandId, r);
    }
  }
  await a.waitFor('m.public', (p) => p.phase === 'PREP' && p.round === 1, 15000);

  // (b) **对局中**的纯观战者：仍然拒（"对局中可用"不等于"观战者可用"）
  const rMid = await spec.request({ t: 'room.chat', text: '对局中我也想说' });
  console.log('[证据③-纯观战/对局中] %j', rMid);
  assert.equal(rMid.t, 'error');
  assert.equal(rMid.code, ERR.SPECTATOR);

  // 把"队友只差 1 点 LP"这个**真实长局会到达的状态**预置好（不然一局要打很多回合），
  // 并让本回合**每个**战场都漏 1 个敌人（无人 perfect ⇒ 不触发联防 ⇒ 各扣各的），
  // 于是队友在本回合**走真实结算路径**阵亡，而房主把 LP 垫高，对局继续（否则一死就整局结束，看不到"转观战"）。
  const room = matchSrv.lobby.getRoom(code);
  const psA = room.match.players.get(a.id);
  const psB = room.match.players.get(b.id);
  assert.ok(psA && psB, '对局里应有两个真人的 PlayerState');
  assert.ok(psB.lp > 1, `队友的初始 LP 应 > 1（实测 ${psB.lp}）`);
  psA.lp = 20;
  psB.lp = 1;
  FakeBattle.script = (bt) => ({ duration: 1, leaks: Object.fromEntries(bt.players.map((id) => [id, 1])) });
  await ok(a, { t: 'g.ready', ready: true });
  await ok(b, { t: 'g.ready', ready: true });
  const dead = await a.waitFor('m.public', (p) => p.players.some((x) => x.playerId === b.id && x.alive === false), 20000);
  const rowB = dead.players.find((x) => x.playerId === b.id);
  console.log('[证据③-阵亡] 服务端 m.public 里 %s 的 alive=%s / lp=%s', b.id, rowB.alive, rowB.lp);
  assert.equal(room.spectatorOf(b.id), null, '阵亡 ≠ 换成观战席：它仍是"占过座"的玩家');
  assert.ok(room.seatOf(b.id) && !room.seatOf(b.id).left, '座位仍在');

  // 阵亡 ⇒ 自动转观战（研究 09 §3.1）：它不再是任何战场的 player，改收别人的战场快照
  await a.waitFor('m.public', (p) => p.phase === 'PREP' && p.round === 2, 20000);
  await ok(a, { t: 'g.ready', ready: true });
  await a.waitFor('m.public', (p) => p.phase === 'COMBAT' && p.round === 2, 20000);
  const watched = b.log.filter((m) => m.t === 'm.field' && m.fieldId && m.fieldId !== `n:${b.id}`).length;
  assert.ok(watched > 0, `阵亡后应收到别人的战场快照（收到的 m.field：${b.log.filter((m) => m.t === 'm.field').map((m) => m.fieldId).join(',') || '无'}）`);
  console.log('[证据③-转观战] 阵亡后收到别人战场快照 %d 帧；own field = n:%s', watched, b.id);

  // (c) 阵亡转观战的人：占过座 ⇒ 允许发言，队友收得到
  const rb = await b.request({ t: 'room.chat', text: '阵亡了也能说话' });
  console.log('[证据③-阵亡转观战] %j', rb);
  assert.equal(rb.t, 'ok', `阵亡转观战者应可发言：${JSON.stringify(rb)}`);
  const got = await a.waitFor('chat.msg', (m) => m.from === b.id);
  assert.equal(got.text, '阵亡了也能说话');
  assert.equal(got.name, 'D-队友');
});

test('④ 超长按 Unicode 码点截到 120（含 emoji：不许截出半个代理对）', async () => {
  const a = await player(srvUrl, 'D-长文甲');
  const code = await createRoom(a);
  const b = await player(srvUrl, 'D-长文乙');
  await joinRoom(b, code);

  const cjk = '字'.repeat(200);
  await ok(a, { t: 'room.chat', text: cjk });
  const g1 = await b.waitFor('chat.msg');
  assert.equal([...g1.text].length, CHAT_MAX, `应按码点截到 ${CHAT_MAX}`);
  assert.equal(g1.text.length, CHAT_MAX, 'CJK 一个字一个码点');
  assert.ok(cjk.startsWith(g1.text));

  const emoji = '😀'.repeat(200); // 1 码点 = 2 个 UTF-16 单元
  await ok(a, { t: 'room.chat', text: emoji });
  const g2 = await b.waitFor('chat.msg');
  assert.equal([...g2.text].length, CHAT_MAX, 'emoji 也要按码点算');
  assert.equal(g2.text.length, CHAT_MAX * 2, '不许截出半个代理对（长度必须成对）');
  assert.ok(!g2.text.includes('\uFFFD'));
  console.log('[证据④] 200 个 CJK ⇒ %d 码点；200 个 emoji ⇒ %d 码点 / %d 个 UTF-16 单元',
    [...g1.text].length, [...g2.text].length, g2.text.length);
});

test('⑤ 高频连发 10 条 ⇒ 收到的 < 10（1 条/秒、突发 3；超了回 ERR.RATE）', async () => {
  const a = await player(srvUrl, 'D-连发甲');
  const code = await createRoom(a);
  const b = await player(srvUrl, 'D-连发乙');
  await joinRoom(b, code);
  b.clearInbox();

  const N = 10;
  for (let i = 0; i < N; i++) a.send({ t: 'room.chat', text: `连发 #${i}` });
  const replies = [];
  for (let i = 0; i < N; i++) replies.push(await a.waitFor(null, (m) => (m.t === 'ok' || m.t === 'error') && typeof m.rid === 'number', 3000));
  const accepted = replies.filter((r) => r.t === 'ok').length;
  const rejected = replies.filter((r) => r.t === 'error' && r.code === ERR.RATE).length;
  await delay(150);
  const got = b.log.filter((m) => m.t === 'chat.msg').length;
  console.log('[证据⑤] 连发 %d 条 ⇒ 接受 %d / RATE 拒绝 %d / B 收到 %d', N, accepted, rejected, got);
  assert.ok(got >= 1, '突发里至少要有 1 条出去');
  assert.ok(got < N, `高频连发必须被限流：收到 ${got} 条（应 < ${N}）`);
  assert.equal(accepted, got, '收到的条数 == 被接受的条数（不许偷偷丢帧）');
  assert.ok(rejected > 0, '超频要明确回 ERR.RATE（不是静默丢弃）');
});

test('⑥ 空串 / 纯控制字符 / 纯空白 ⇒ 被拒（BAD_MSG）；带控制字符但有字 ⇒ 清洗后发出', async () => {
  const a = await player(bigUrl, 'D-空文甲');
  const code = await createRoom(a);
  const b = await player(bigUrl, 'D-空文乙');
  await joinRoom(b, code);

  const bad = ['', '   ', '\u0000\u0007\u001f\u007f\u009f', '\u200b\u200b\ufeff', '\n\r\t', '  \u200b \u0000 '];
  for (const text of bad) {
    const r = await a.request({ t: 'room.chat', text });
    console.log('[证据⑥] %j ⇒ %j', text, r);
    assert.equal(r.t, 'error', `空/纯控制字符必须被拒：${JSON.stringify(text)}`);
    assert.equal(r.code, ERR.BAD_MSG);
  }
  await b.expectNone('chat.msg', () => true, 200);

  const r = await a.request({ t: 'room.chat', text: '好\u0007的\u200b\u200d' });
  assert.equal(r.t, 'ok', `清洗后仍有字 ⇒ 应发出：${JSON.stringify(r)}`);
  const got = await b.waitFor('chat.msg');
  console.log('[证据⑥-对照] 发 %j ⇒ 收到 %j', '好\u0007的\u200b\u200d', got.text);
  assert.equal(got.text, '好的', 'C0/C1 控制字符与零宽字符都要被剥掉');
});

test('⑦ 断开重连（同 token）⇒ 收到 chat.history；环形缓冲只留最近 50 条', async () => {
  // (a) 默认服务器：一条消息 + 掉线重连
  const a = await player(srvUrl, 'D-重连甲');
  const code = await createRoom(a);
  const b = await player(srvUrl, 'D-重连乙');
  await joinRoom(b, code);
  await ok(a, { t: 'room.chat', text: '重连前说的话' });
  await b.waitFor('chat.msg', (m) => m.text === '重连前说的话');

  await a.terminate();
  const a2 = await TestClient.connect(srvUrl);
  perTest.push(a2);
  const w = await a2.hello('D-重连甲', a.token);
  assert.equal(w.resumed, true, '同 token 必须认成同一个会话');
  a2.id = a.id;
  a2.token = a.token;
  const hist = await a2.waitFor('chat.history');
  console.log('[证据⑦] 重连后 chat.history = %j', hist);
  assert.equal(hist.messages.length, 1);
  assert.equal(hist.messages[0].text, '重连前说的话');
  assert.equal(hist.messages[0].from, a.id);
  assert.equal(hist.messages[0].name, 'D-重连甲');
  assert.equal(typeof hist.messages[0].at, 'number');

  // (b) 环形缓冲上限 50：连发 60 条 ⇒ 补发的是最近的 50 条（#10..#59）
  const c = await player(bigUrl, 'D-历史甲');
  await createRoom(c);
  for (let i = 0; i < 60; i++) c.send({ t: 'room.chat', text: `历史 #${i}` });
  await delay(400);
  await c.terminate();
  const c2 = await TestClient.connect(bigUrl);
  perTest.push(c2);
  await c2.hello('D-历史甲', c.token);
  const hist2 = await c2.waitFor('chat.history');
  console.log('[证据⑦-环形] 连发 60 条 ⇒ 补发 %d 条：%s … %s', hist2.messages.length, hist2.messages[0].text, hist2.messages[hist2.messages.length - 1].text);
  assert.equal(hist2.messages.length, HISTORY_MAX);
  assert.equal(hist2.messages[0].text, '历史 #10', '留下的是最近 50 条');
  assert.equal(hist2.messages[HISTORY_MAX - 1].text, '历史 #59');
});

test('⑧ 隐私哨兵：带聊天的对局结束后，var/stats/** 与 var/state/** 里搜不到那句聊天', async () => {
  const statsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-chat-stats-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-chat-state-'));
  FakeBattle.script = () => ({ duration: 1 });
  // 落盘目录一律指到临时目录（`SP_STATS_DIR` / `SP_STATE_DIR` 的等价物），绝不碰工作区树
  const s = await startServer({
    port: 0, host: '127.0.0.1', quiet: true, MatchClass: FastChatMatch,
    stats: { dir: statsDir, enabled: true },      // 测试子进程默认关统计 ⇒ 这里显式打开
    snapshot: { dir: stateDir, everyMs: 0 },      // 周期快照关掉，改成手动留一份
  });
  try {
    const c = await player(`ws://127.0.0.1:${s.port}/ws`, 'D-哨兵');
    const code = await createRoom(c);
    await ok(c, { t: 'room.addBot' });
    await ok(c, { t: 'room.start' });                       // 真的是"一场带聊天的对局"
    await c.waitFor('m.public', (p) => p.phase === 'INFO_CHECK');

    await ok(c, { t: 'room.chat', text: SENTINEL });
    const got = await c.waitFor('chat.msg', (m) => m.text === SENTINEL);
    assert.equal(got.text, SENTINEL, '聊天确实广播出去了（不是"没发出去所以没落盘"）');

    await ok(c, { t: 'g.emote', id: EMOTES[0] });           // 用户裁决 ④：表情包一行未改，仍工作
    await c.waitFor('m.emote');
    const snap = s.snapshot('manual');                      // 强制写一份现场快照（对局进行中）
    assert.ok(snap && snap.rooms >= 1, `快照应写到 ${stateDir}：${JSON.stringify(snap)}`);

    await ok(c, { t: 'g.leave' });                          // 中途散场 ⇒ 统计也会留一行（dispose 路径）
    await delay(300);
    console.log('[证据⑧] 房间 %s 里说了哨兵 %j，已强制写快照并结束对局', code, SENTINEL);
  } finally {
    await s.close();
  }

  const statsFiles = fs.existsSync(statsDir) ? walkFiles(statsDir) : [];
  const stateFiles = fs.existsSync(stateDir) ? walkFiles(stateDir) : [];
  const all = [...statsFiles, ...stateFiles];
  console.log('[证据⑧] 落盘文件 %d 个：%j', all.length, all.map((f) => path.basename(f)));
  assert.ok(statsFiles.some((f) => /matches-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)), `统计目录应真的落了 matches 行：${statsFiles.join(', ')}`);
  assert.ok(stateFiles.some((f) => /snapshots-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)), `快照目录应真的落了快照：${stateFiles.join(', ')}`);

  const hits = all.filter((f) => fs.readFileSync(f, 'utf8').includes(SENTINEL));
  const hits2 = all.filter((f) => fs.readFileSync(f, 'utf8').includes('聊天哨兵'));
  console.log('[证据⑧] 含完整哨兵的文件：%j ；含"聊天哨兵"前缀的：%j', hits.map((f) => path.basename(f)), hits2.map((f) => path.basename(f)));
  assert.deepEqual(hits, [], '聊天原文绝不许落盘');
  assert.deepEqual(hits2, [], '连哨兵的前缀都不许出现');

  fs.rmSync(statsDir, { recursive: true, force: true });
  fs.rmSync(stateDir, { recursive: true, force: true });
  assert.equal(fs.existsSync(statsDir), false, '临时目录要删干净');
  assert.equal(fs.existsSync(stateDir), false);
  // 🔴 2026-10-09（C 派工）：**只断言本用例自己的临时目录** —— ⛔ 不再扫整棵树。
  //    原来这里断言 `ROOT/var` 不存在 ⇒ **任何人在开发树里起过一次服务端**（`var/` 是它的默认落盘口）
  //    都会让本用例假红，而"树里有没有 var/"**与聊天隐私毫无关系**。
  //    本用例要证明的只有一件事：**它自己那两个临时目录**（`statsDir`/`stateDir`，上面扫的就是它们）
  //    里搜不到哨兵 —— 那两条断言在上面（`hits`/`hits2`）。
  //    ⚠️ 起服务端时请把落盘指到树外：`SP_STATE_DIR` / `SP_STATS_DIR`（`server/ops.js:30`、`server/stats.js:41`）。
  assert.deepEqual([...hits, ...hits2], [], '本用例自己的临时目录里不许出现哨兵（唯一的断言对象）');
});
