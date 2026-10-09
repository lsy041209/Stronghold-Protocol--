// server/ops.js — 运维动作：**停机倒计时播报** + **对局快照留档**（第 3 任 D，2026-10-06；用户 11:5x 批准）
//
// 用户原话：「可以做"关闭服务器维护前 60s 游戏内广播播报 + 倒计时"，并做快照留档」；「维护窗口时间不定」。
//
// ── ① 停机倒计时播报 ────────────────────────────────────────────────────────────────────────────
// 复用**既有**的客户端通道，**不改协议、不改客户端**（我实测过两条的形状）：
//   · `m.toast  { text, kind:'info'|'success'|'warn'|'error' }`  → main.js:222 → 一个 toast（最醒目，只发一次）
//   · `m.ticker { text, type?, priority? }`                     → main.js:226 → 顶栏下方播报条，
//                                                                  **每条停留 TICKER_MS=5200 ms**、队列上限 4（ui/ticker.js）
// ⇒ 因此**按"里程碑"发**（默认 30 / 10 / 5 秒），而不是每秒一条：每秒一条会排队，屏幕上会出现"说错数字"的旧行。
//
// ── ② 快照留档（只留档，**不做恢复**）────────────────────────────────────────────────────────────
// 为什么：房间/对局**全在单进程内存里**（`C-12` 换包要挑窗口的根因就是它）。出事时**没有任何现场**可查。
// 现在：停机前 dump 一次（`shutdown-start` 立即 + `shutdown` 关服前各一次），并可选**周期性** dump（默认 15 min，防崩溃丢现场）。
// 🔒 与 `server/stats.js` 同一套隐私纪律：**姓名不落盘**（字段白名单），玩家 id 用**同一个盐**哈希（所以两串数据能互相 join）。
//
// ⚠️ 落盘目录（线上**必须**在树外）：单元是 `ProtectSystem=strict` + `ReadOnlyPaths=/opt/stronghold` 且无
//    `ReadWritePaths` ⇒ 树内一个字节都写不进去（见 `协作/已知问题.md` 的 D 条）。所以默认目录可被
//    **`SP_STATE_DIR`** 顶掉（线上设为 `/var/lib/stronghold/state`，由 `StateDirectory=stronghold` 提供可写性）。
// ⚠️ 二者都**永不抛**：运维功能绝不能把一局游戏搞坏（写失败就记一次日志并自我禁用）。

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sendSession } from './net.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** 快照默认目录（线上用 `SP_STATE_DIR` 指到树外）。 */
export const STATE_DIR = process.env.SP_STATE_DIR ? path.resolve(process.env.SP_STATE_DIR) : path.join(ROOT, 'var', 'state');
/** 快照保留天数（按文件名日期）。 */
export const SNAPSHOT_RETENTION_DAYS = 7;
/** 默认停机宽限（ms）——用户批的 60 秒。 */
export const DEFAULT_GRACE_MS = 60_000;
/** 里程碑（**距停机还有多少 ms** 时播一条）。第一条永远是"满倒计时"。 */
export const SHUTDOWN_MARKS_MS = Object.freeze([30_000, 10_000, 5_000]);
/** 默认周期快照间隔（ms）；`0` = 关。 */
export const DEFAULT_SNAPSHOT_EVERY_MS = 15 * 60_000;

/** 停机宽限（ms）：`SP_SHUTDOWN_GRACE_MS`，默认 60 s，夹在 0…300 s。 */
export function shutdownGraceMs(env = process.env) {
  const raw = env.SP_SHUTDOWN_GRACE_MS;
  if (raw == null || String(raw).trim() === '') return DEFAULT_GRACE_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_GRACE_MS;
  return Math.min(300_000, Math.round(n));
}

/** 周期快照间隔（ms）：`SP_SNAPSHOT_EVERY_MS`，默认 15 min，`0` = 关。@param {Record<string,string|undefined>} env */
export function snapshotEveryMs(env = process.env) {
  const raw = env.SP_SNAPSHOT_EVERY_MS;
  if (raw == null || String(raw).trim() === '') return DEFAULT_SNAPSHOT_EVERY_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(24 * 3600_000, Math.round(n));
}

/** 播报文案（**纯函数**，好单测）。`final` = 最后 5 秒那条。 */
export function shutdownText(secondsLeft, { final = false } = {}) {
  const s = Math.max(0, Math.round(secondsLeft));
  return final
    ? `⚠️ 服务器将在 ${s} 秒后重启维护，请尽快结束当前对局`
    : `⚠️ 服务器将在 ${s} 秒后重启维护`;
}

/**
 * 给**所有**会话广播一条帧。返回成功发出的条数；任何异常都吞掉（停机路径不许因子问题卡住）。
 * @param {{all:()=>Iterable<any>}} registry @param {any} msg @param {(s:any,m:any)=>boolean} [send]
 */
export function broadcast(registry, msg, send = sendSession) {
  let n = 0;
  try {
    for (const s of registry.all()) {
      try { if (send(s, msg)) n++; } catch { /* 单个会话坏了不影响别人 */ }
    }
  } catch { /* registry 形状不对就当没人 */ }
  return n;
}

/**
 * 停机倒计时：立刻发一条 toast + 一条 ticker，然后按里程碑发 ticker。
 * @param {{registry:any, graceMs?:number, marksMs?:number[], send?:(s:any,m:any)=>boolean, log?:any}} opts
 * @returns {{cancel:()=>void, done:Promise<number>}} `done` 在宽限结束时 resolve 成"发过几条"
 */
export function announceShutdown(opts = {}) {
  const {
    registry, graceMs = DEFAULT_GRACE_MS, marksMs = SHUTDOWN_MARKS_MS,
    send = sendSession, log = null,
  } = opts;
  const total = Math.max(0, Math.round(graceMs));
  const timers = [];
  let sent = 0;
  const say = (msg) => { sent += broadcast(registry, msg, send); };
  const secs = (ms) => Math.max(0, Math.round(ms / 1000));

  const done = new Promise((resolve) => {
    if (total <= 0) { resolve(0); return; }             // 宽限 0 ⇒ 一句话都不发（紧急停机路径）
    try {
      // 最醒目的一条：toast（客户端 main.js:222）
      say({ t: 'm.toast', kind: 'warn', text: shutdownText(secs(total)) });
      // 顶栏播报条（客户端 main.js:226 / ui/ticker.js）：priority 抬高，别排在本局战报后面
      say({ t: 'm.ticker', type: 'server', priority: 5, text: shutdownText(secs(total)) });
      for (const mark of marksMs) {
        const delay = total - Math.max(0, Math.round(mark));
        if (delay <= 0) continue;
        timers.push(setTimeout(() => {
          try { say({ t: 'm.ticker', type: 'server', priority: 5, text: shutdownText(secs(mark), { final: mark <= 5_000 }) }); }
          catch (e) { try { log?.warn?.('[ops] 播报失败', e?.message); } catch { /* ignore */ } }
        }, delay));
      }
      timers.push(setTimeout(() => resolve(sent), total));
    } catch (e) {
      try { log?.warn?.('[ops] 播报初始化失败', e?.message); } catch { /* ignore */ }
      resolve(sent);
    }
  });
  const cancel = () => { for (const t of timers) { try { clearTimeout(t); } catch { /* ignore */ } } };
  return { cancel, done };
}

/**
 * 停机序列（**抽出来是为了可测**）：留现场 → 倒计时播报 → 再留现场 → 关服。
 *
 * ⚠️ 为什么必须抽成函数而不是写在 `main()` 的 `stop()` 里（2026-10-06 实测教训）：
 *   **Windows 上 Node 收不到可捕获的 `SIGTERM`** —— `child.kill('SIGTERM')` 会**直接强杀**进程
 *   （实测：日志里没有 `[SIGTERM] shutting down…`、socket 以 **1006** 关闭、零播报零快照）。
 *   ⇒ 把这段逻辑抽出来后，它在**任何平台**都能被真正跑到（真服务器 + 真 WebSocket 客户端即可验证）。
 *   线上是 Linux，`process.on('SIGTERM')` 正常工作（Node 标准行为）。
 *
 * @param {{snapshot?:Function, registry:any, close?:Function}} srv `startServer` 的返回值
 * @param {{graceMs?:number, marksMs?:number[], send?:Function, log?:any}} [opts]
 * @returns {Promise<{graceMs:number, announced:number, snapshots:Array<any>}>}
 */
export async function shutdownSequence(srv, opts = {}) {
  const { graceMs = DEFAULT_GRACE_MS, marksMs = SHUTDOWN_MARKS_MS, send = sendSession, log = null } = opts;
  const out = { graceMs, announced: 0, snapshots: [] };
  // ① 现场先留一份（万一倒计时期间崩了）
  try { const r = srv?.snapshot?.('shutdown-start'); if (r) out.snapshots.push(r); } catch { /* ignore */ }
  // ② 倒计时播报（`m.toast` + `m.ticker`，见本文件头部）
  if (graceMs > 0) {
    try { out.announced = await announceShutdown({ registry: srv?.registry, graceMs, marksMs, send, log }).done; }
    catch (e) { try { log?.warn?.('[ops] 播报失败', e?.message); } catch { /* ignore */ } }
  }
  // ③ 关服前再留一份（这才是"最终现场"）
  try { const r = srv?.snapshot?.('shutdown'); if (r) out.snapshots.push(r); } catch { /* ignore */ }
  // ④ 真正关服
  try { await srv?.close?.(); } catch { /* ignore */ }
  return out;
}

/**
 * 快照留档器：把 `lobby.rooms` 的**白名单字段**追加进 `snapshots-YYYY-MM-DD.jsonl`。
 * @param {{dir?:string, now?:()=>number, log?:any, hash?:(v:any)=>string|null, retentionDays?:number,
 *          everyMs?:number}} [opts]
 */
export function createSnapshotter(opts = {}) {
  const {
    dir = STATE_DIR, now = Date.now, log = null,
    hash = null, retentionDays = SNAPSHOT_RETENTION_DAYS,
    everyMs = snapshotEveryMs(),
  } = opts;
  let dead = false;
  let pruned = false;
  let timer = null;
  let fallbackHash = null;

  const warn = (msg, e) => { try { log?.warn?.(`[ops] ${msg}${e ? `: ${e.message || e}` : ''}`); } catch { /* ignore */ } };
  const who = (v) => {
    if (v == null || v === '') return null;
    if (typeof hash === 'function') { try { return hash(v); } catch { /* fall through */ } }
    // 没给 hash（= 统计被关）时用**进程内随机盐**：仍不可反查，但跨重启不可关联
    if (!fallbackHash) fallbackHash = randomBytes(16).toString('hex');
    return createHash('sha256').update(`${fallbackHash}:${String(v)}`).digest('hex').slice(0, 12);
  };
  const day = (t) => new Date(t).toISOString().slice(0, 10);
  const pathFor = (t = now()) => path.join(dir, `snapshots-${day(t)}.jsonl`);

  function prune(nowMs) {
    if (pruned) return;
    pruned = true;
    try {
      const cutoff = nowMs - retentionDays * 86_400_000;
      for (const name of fs.readdirSync(dir)) {
        const m = /^snapshots-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
        if (m && Date.parse(`${m[1]}T00:00:00Z`) < cutoff) fs.unlinkSync(path.join(dir, name));
      }
    } catch { /* 目录不存在/权限不足都无所谓 */ }
  }

  /** 一个房间 → 白名单行（**不含姓名**）。 */
  function roomRow(room, key, at) {
    const seats = Array.isArray(room?.seats) ? room.seats : [];
    const match = room?.match || null;
    return {
      code: String(room?.code ?? key ?? '').slice(0, 16) || null,
      mode: room?.mode === 'solo' ? 'solo' : 'coop',
      difficulty: typeof room?.difficulty === 'string' ? room.difficulty : null,
      inMatch: !!match,
      round: Number.isFinite(match?.round) ? match.round : null,
      phase: typeof match?.phase === 'string' ? match.phase : null,
      seats: seats.filter(Boolean).map((s, i) => ({
        seat: Number.isFinite(s.seat) ? s.seat : i,
        kind: s.isBot ? 'bot' : 'human',
        who: s.isBot ? null : who(s.playerId),
        connected: s.connected !== false,      // 缺字段时按"在座"算
        ready: !!s.ready,
      })),
    };
  }

  /**
   * 留一次档。永不抛。@param {{rooms?:Map<string,any>}} lobby @param {string} reason
   * @returns {{at:number, reason:string, rooms:number}|null}
   */
  function snapshot(lobby, reason = 'manual') {
    if (dead) return null;
    const at = now();
    try {
      const rooms = lobby && lobby.rooms instanceof Map ? [...lobby.rooms.entries()] : [];
      const rows = rooms.map(([key, room]) => roomRow(room, key, at));
      fs.mkdirSync(dir, { recursive: true });
      prune(at);
      const line = JSON.stringify({ at, reason, rooms: rows.length, detail: rows });
      fs.appendFileSync(pathFor(at), `${line}\n`, 'utf8');
      return { at, reason, rooms: rows.length };
    } catch (e) {
      dead = true;
      warn('快照写失败，已自我禁用', e);
      return null;
    }
  }

  /** 起周期快照（`everyMs <= 0` ⇒ 不起）。返回是否起了。 */
  function start(lobby) {
    if (dead || !(everyMs > 0) || timer) return false;
    timer = setInterval(() => snapshot(lobby, 'periodic'), everyMs);
    try { timer.unref?.(); } catch { /* ignore */ }
    return true;
  }
  function stop() { if (timer) { try { clearInterval(timer); } catch { /* ignore */ } timer = null; } }

  return {
    get enabled() { return !dead; },
    dir, everyMs, pathFor, snapshot, start, stop,
  };
}
