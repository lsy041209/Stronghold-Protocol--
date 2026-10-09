// test/ops.test.js — 停机倒计时播报 + 对局快照留档（`server/ops.js`，第 3 任 D，2026-10-06）
//
// 用户 11:5x 批准：「关闭服务器维护前 60s 游戏内广播播报 + 倒计时」+「快照留档」。
// 本测试钉住四件容易做错的事：
//   ① 复用的是**既有客户端通道**（`m.toast` / `m.ticker`，形状照 main.js:222/226）⇒ 断言帧形状；
//   ② **按里程碑发**，不是每秒一条（客户端 ticker 每条停 5.2 s、队列上限 4 ⇒ 每秒一条会说错数字）；
//   ③ 宽限 `0` 时必须**一句都不发**（紧急停机路径），`cancel()` 要能停掉后续；
//   ④ 快照**姓名不落盘**、永不抛、写不进去要自我禁用、保留期要清、周期快照能起能停。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  shutdownText, shutdownGraceMs, snapshotEveryMs, broadcast, announceShutdown, createSnapshotter, shutdownSequence,
} from '../server/ops.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sp-ops-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readLines = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const readRaw = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');

/** 假 registry：只实现 `all()`（真实的是 `SessionRegistry.all()` ⇒ 迭代 session）。 */
const reg = (...sessions) => ({ all: () => sessions[Symbol.iterator]() });
/** 收帧器：`send(session, msg)` 返回是否送达。 */
function sink() {
  const got = [];
  const send = (s, m) => { if (s?.dead) return false; got.push(m); return true; };
  return { got, send };
}
/** 假房间（字段照 lobby.js 的座位形状；`name` 正是**不许落盘**的那个字段）。 */
const room = (over = {}) => ({
  code: 'ABCD', mode: 'coop', difficulty: 'HARD',
  seats: [{ seat: 0, playerId: 'p1', name: '简浩竹', isBot: false, connected: true, ready: true },
    { seat: 1, playerId: 'ai_1', name: 'AI·杜宾', isBot: true, connected: true, ready: true }],
  ...over,
});
const lobbyOf = (...rooms) => ({ rooms: new Map(rooms.map((r, i) => [r.code || `R${i}`, r])) });

test('shutdownText：纯函数，普通条与最后 5 秒那条文案不同', () => {
  assert.equal(shutdownText(60), '⚠️ 服务器将在 60 秒后重启维护');
  assert.match(shutdownText(5, { final: true }), /5 秒后重启维护，请尽快结束当前对局/);
  assert.equal(shutdownText(-3), shutdownText(0), '负数按 0 处理');
});

test('shutdownGraceMs / snapshotEveryMs：默认值、可关、夹范围', () => {
  assert.equal(shutdownGraceMs({}), 60_000, '用户批的就是 60 s');
  assert.equal(shutdownGraceMs({ SP_SHUTDOWN_GRACE_MS: '0' }), 0, '0 = 紧急停机（不播报）');
  assert.equal(shutdownGraceMs({ SP_SHUTDOWN_GRACE_MS: '1500' }), 1500);
  assert.equal(shutdownGraceMs({ SP_SHUTDOWN_GRACE_MS: '999999' }), 300_000, '夹到 5 分钟');
  assert.equal(shutdownGraceMs({ SP_SHUTDOWN_GRACE_MS: 'abc' }), 60_000, '乱填就回默认');
  assert.equal(snapshotEveryMs({}), 15 * 60_000);
  assert.equal(snapshotEveryMs({ SP_SNAPSHOT_EVERY_MS: '0' }), 0, '0 = 关周期快照');
  assert.equal(snapshotEveryMs({ SP_SNAPSHOT_EVERY_MS: '-1' }), 0);
});

test('broadcast：发给每个会话；单个会话发失败不影响别人；registry 形状不对也不抛', () => {
  const { got, send } = sink();
  assert.equal(broadcast(reg({ id: 1 }, { id: 2, dead: true }, { id: 3 }), { t: 'x' }, send), 2);
  assert.equal(got.length, 2);
  assert.doesNotThrow(() => broadcast(null, { t: 'x' }, send));
  assert.doesNotThrow(() => broadcast({ all: () => { throw new Error('boom'); } }, { t: 'x' }, send));
});

test('announceShutdown：先 toast 再 ticker，按里程碑发，最后一条是"请尽快结束"', async () => {
  const { got, send } = sink();
  const s = announceShutdown({ registry: reg({ id: 1 }), graceMs: 200, marksMs: [150, 100, 50], send });
  const sent = await s.done;
  assert.ok(sent >= 5, `至少要发出 5 条（1 toast + 1 ticker + 3 里程碑），实测 ${sent}`);
  assert.equal(got[0].t, 'm.toast');
  assert.equal(got[0].kind, 'warn', '维护要用 warn 级，客户端才会当回事');
  assert.equal(got[1].t, 'm.ticker');
  assert.equal(got[1].type, 'server');
  assert.ok(got[1].priority >= 1, '要抬优先级，别排在本局战报后面');
  const tickers = got.filter((m) => m.t === 'm.ticker');
  assert.equal(tickers.length, 4, '首条 + 3 个里程碑');
  assert.match(tickers[tickers.length - 1].text, /请尽快结束当前对局/, '最后一条必须是"最后 5 秒"文案');
  for (const m of got) assert.equal(typeof m.text, 'string');
});

test('announceShutdown：宽限 0 ⇒ 一句都不发；cancel() 能停掉后续里程碑', async () => {
  const a = sink();
  assert.equal(await announceShutdown({ registry: reg({ id: 1 }), graceMs: 0, send: a.send }).done, 0);
  assert.deepEqual(a.got, [], '紧急停机路径不许刷屏');

  const b = sink();
  const s = announceShutdown({ registry: reg({ id: 1 }), graceMs: 200, marksMs: [150, 100], send: b.send });
  assert.equal(b.got.length, 2, '首条 toast + ticker 是同步发的');
  s.cancel();
  await sleep(260);
  assert.equal(b.got.length, 2, 'cancel 之后不该再有里程碑');
});

test('快照：白名单字段齐全，且**姓名永不落盘**；房间码保留（运维要用它对照）', () => {
  const s = createSnapshotter({ dir: tmp(), now: () => Date.UTC(2026, 9, 6, 12, 0, 0) });
  const out = s.snapshot(lobbyOf(room({ match: { round: 7, phase: 'PREP' } })), 'shutdown');
  assert.deepEqual(out, { at: Date.UTC(2026, 9, 6, 12, 0, 0), reason: 'shutdown', rooms: 1 });
  const raw = readRaw(s.pathFor());
  assert.ok(!raw.includes('简浩竹') && !raw.includes('杜宾'), '姓名绝不许出现在快照里');
  assert.ok(!raw.includes('"name"'), '白名单：连 name 这个键都不该有');
  const [line] = readLines(s.pathFor());
  const r = line.detail[0];
  assert.equal(r.code, 'ABCD');
  assert.equal(r.mode, 'coop');
  assert.equal(r.difficulty, 'HARD');
  assert.equal(r.inMatch, true);
  assert.equal(r.round, 7);
  assert.equal(r.phase, 'PREP');
  assert.equal(r.seats.length, 2);
  assert.equal(r.seats[0].kind, 'human');
  assert.match(r.seats[0].who, /^[0-9a-f]{12}$/);
  assert.equal(r.seats[0].connected, true);
  assert.equal(r.seats[1].kind, 'bot');
  assert.equal(r.seats[1].who, null);
});

test('快照：复用统计那套盐（两串数据可 join）；永不抛；写不进去就自我禁用', () => {
  const dir = tmp();
  const s = createSnapshotter({ dir, hash: (v) => `H${v}`.slice(0, 12) });
  s.snapshot(lobbyOf(room()), 'x');
  assert.equal(readLines(s.pathFor())[0].detail[0].seats[0].who, 'Hp1'.padEnd(12, ' ').slice(0, 12).trimEnd());
  // 形状不对也不抛
  for (const bad of [null, {}, { rooms: [] }, { rooms: new Map([['A', null]]) }]) assert.doesNotThrow(() => s.snapshot(bad, 'x'));
  // 写不进去（dir 是个文件）⇒ 返回 null + 自我禁用，且不抛
  const base = tmp();
  const asFile = path.join(base, 'not-a-dir');
  fs.writeFileSync(asFile, 'x');
  const bad = createSnapshotter({ dir: asFile });
  assert.equal(bad.snapshot(lobbyOf(room()), 'x'), null);
  assert.equal(bad.enabled, false);
  assert.doesNotThrow(() => bad.snapshot(lobbyOf(room()), 'x'));
});

test('快照：保留期清旧文件；周期快照能起、能停', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'snapshots-2020-01-01.jsonl'), '{"old":1}\n');
  const keep = path.join(dir, 'snapshots-2026-10-06.jsonl');
  fs.writeFileSync(keep, '{"keep":1}\n');
  const s = createSnapshotter({ dir, now: () => Date.UTC(2026, 9, 6, 12, 0, 0), everyMs: 30 });
  s.snapshot(lobbyOf(room()), 'manual');
  assert.ok(!fs.readdirSync(dir).includes('snapshots-2020-01-01.jsonl'), '过期文件该删');
  assert.equal(readLines(keep).length, 2, '旧内容保留 + 新记录追加');

  const lobby = lobbyOf(room());
  assert.equal(s.start(lobby), true);
  await sleep(90);
  const n1 = readLines(s.pathFor()).length;
  assert.ok(n1 >= 3, `周期快照应至少再写 2 条，实测 ${n1}`);
  s.stop();
  await sleep(90);
  assert.equal(readLines(s.pathFor()).length, n1, 'stop 之后不该再写');
  assert.equal(s.start({ rooms: new Map() }), true, 'stop 后还能再 start');
  s.stop();
});

test('SP_STATE_DIR：线上必须把快照也放到**树外**（与 stats 同一条实测教训）', async () => {
  const dir = tmp();
  process.env.SP_STATE_DIR = dir;
  try {
    const mod = await import(`../server/ops.js?probe=${Date.now()}`);
    assert.equal(mod.STATE_DIR, path.resolve(dir));
    assert.equal(mod.createSnapshotter().dir, path.resolve(dir));
  } finally { delete process.env.SP_STATE_DIR; }
  const mod2 = await import(`../server/ops.js?probe2=${Date.now()}`);
  assert.match(mod2.STATE_DIR, /[\\/]var[\\/]state$/, '未设环境变量时仍是树内 var/state');
});

test('shutdownSequence：顺序是「留现场 → 播报 → 再留现场 → 关服」，且每步都不抛', async () => {
  const order = [];
  const srv = {
    registry: reg({ id: 1 }),
    snapshot: (reason) => { order.push(`snapshot:${reason}`); return { at: 0, reason, rooms: 0 }; },
    close: async () => { order.push('close'); },
  };
  const { got, send } = sink();
  const out = await shutdownSequence(srv, { graceMs: 60, marksMs: [40, 20], send });
  assert.deepEqual(order, ['snapshot:shutdown-start', 'snapshot:shutdown', 'close'], '关服必须是最后一步');
  assert.ok(out.announced >= 4);
  assert.equal(out.snapshots.length, 2);
  assert.ok(got.some((m) => m.t === 'm.toast'));
  // 形状全烂也不抛
  await assert.doesNotReject(() => shutdownSequence(null, { graceMs: 0, send }));
  await assert.doesNotReject(() => shutdownSequence({ registry: null, snapshot: () => { throw new Error('x'); }, close: () => { throw new Error('y'); } }, { graceMs: 0, send }));
});

test('端到端：**真服务器 + 真 WebSocket 客户端** —— 停机播报真的到客户端、快照真的落盘、且姓名不落盘', async () => {
  const { startServer } = await import('../server/index.js');
  const WebSocket = (await import('ws')).default;
  const dir = tmp();
  const srv = await startServer({
    port: 0, host: '127.0.0.1', quiet: true,
    stats: { enabled: false, dir },                 // 统计关掉：顺便验"关掉时不产生文件"
    snapshot: { dir, everyMs: 0 },                  // 不起周期定时器
  });
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
  const frames = [];
  ws.on('message', (raw) => { try { frames.push(JSON.parse(String(raw))); } catch { /* ignore */ } });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  ws.send(JSON.stringify({ t: 'hello', name: '端到端探针' }));
  await sleep(150);
  ws.send(JSON.stringify({ t: 'room.create', mode: 'solo', difficulty: 'FUNNY' }));
  await sleep(250);
  assert.ok(frames.some((f) => f.t === 'welcome'), '先要握手成功');
  assert.ok(frames.some((f) => f.t === 'room.state'), '先要建出房间');

  const out = await shutdownSequence(srv, { graceMs: 150, marksMs: [100, 50] });
  assert.equal(out.announced, 4, '1 个会话 × (1 toast + 1 ticker + 2 个里程碑) = 4 条');
  const toast = frames.filter((f) => f.t === 'm.toast');
  const ticker = frames.filter((f) => f.t === 'm.ticker');
  assert.equal(toast.length, 1, 'toast 只发一次（最醒目的那一条）');
  assert.equal(toast[0].kind, 'warn');
  assert.ok(ticker.length >= 3, `客户端应真的收到 ticker 行，实测 ${ticker.length}`);
  assert.match(String(ticker[0].text), /重启维护/);
  assert.match(String(ticker[ticker.length - 1].text), /请尽快结束当前对局/);

  const raw = readRaw(srv.state.pathFor());
  assert.ok(raw.length > 0, '快照必须真的写出来');
  assert.ok(!raw.includes('端到端探针'), '姓名不许落盘（快照与统计同一条纪律）');
  const lines = readLines(srv.state.pathFor());
  assert.ok(lines.some((l) => l.reason === 'shutdown'), '必须有 shutdown 那一份');
  assert.ok(lines.some((l) => l.reason === 'shutdown-start'), '也要有 shutdown-start 那一份');
  const roomRow = lines.find((l) => l.reason === 'shutdown').detail[0];
  assert.equal(roomRow.mode, 'solo');
  assert.equal(roomRow.difficulty, 'FUNNY');
  assert.equal(roomRow.seats[0].kind, 'human');
  assert.match(roomRow.seats[0].who, /^[0-9a-f]{12}$/);
  try { ws.close(); } catch { /* ignore */ }
});
