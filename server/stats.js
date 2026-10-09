// server/stats.js — 匿名、只落本机的对局记录 + 表情事件（第 3 任 D，2026-10-06）
//
// 为什么存在（用户 2026-10-06 11:0x 批准：「匿名落盘即可」，路线是"野排先做好，后面慢慢加强 AI"）：
//   · 我们的数据本来就有**两条腿**：① 经济/布阵**决策意图**（g.buy / g.levelUp / g.move / g.equip …）**服务端本来就能看到**；
//     ② 战斗**过程与结果**由权威客户端上报（b.progress 带 killed/leaks/bossDmg/by{playerId:伤害}、b.result）。
//   · 但在此之前**一处都没有落盘**（全内存、用完即弃）⇒ "让 AI 更聪明/更人性化"没有燃料。
//   · 本模块就是**落盘那一条腿**：每局一行 + 每个表情一行，够离线做聚合统计、行为克隆与"表情回应"的学习。
//
// ⚠️ 挂载方式：**不碰 `server/match/Match.js` 与 `server/lobby.js`**，而是走**既有的注入口 `MatchClass`**
//    （`lobby.js:205` 默认 `DefaultMatch`、`:601` `new this.MatchClass({...})`；测试本来就在传 `FastMatch`/`RealtimeMatch`）。
//    `wrap()` 返回一个子类，覆写三个点：
//      · `finish()`  — 结算（`Match.js:3199`，`lastResultMsg` 在这里就绪）⇒ 记一局
//      · `dispose()` — 房间被拆（中途散场）⇒ 补一行（同一局只记一次）
//      · `emote()`   — 表情（`Match.js:1098`，成功才广播）⇒ 记一个事件
//
// 🔒 隐私（硬约束，靠**字段白名单**实现，不靠自觉）：
//   · **姓名永不落盘**（结算行里确实有 `name`，我们只挑 roundsPassed/lp/kills/leaks/dmgDealt/gold 这些数）；
//   · 玩家 id 一律 `sha256(salt + ':' + id)` 前 12 位；`salt` 存 `var/stats/.salt`（只在本机，重启后仍可关联）；
//   · 机器人写 `null`（它们不是人）。
//
// 🛠 运维：按天分文件（`matches-YYYY-MM-DD.jsonl` / `emotes-YYYY-MM-DD.jsonl`）；保留 30 天（首次写入时顺手清理）；
//   `SP_STATS=0` 一票关闭；**测试进程默认关闭**（Node 的 `NODE_TEST_CONTEXT`）⇒ 绝不会污染工作区；
//   写文件失败 ⇒ 记一次日志后**自我禁用**，**永不抛**（绝不能因为统计把一局游戏搞坏）。

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/**
 * 默认落盘目录。**优先级：显式 `dir` > `SP_STATS_DIR` 环境变量 > 树内 `<根>/var/stats`**。
 *
 * ⚠️ 为什么必须有环境变量（2026-10-06 D 实测，不是设想）：线上单元 `11-stronghold.service` 是
 *    `ProtectSystem=strict` + `ReadOnlyPaths=/opt/stronghold` + **没有 `ReadWritePaths`** ⇒
 *    **服务进程对整个代码树只读** ⇒ 默认的树内 `var/stats` **一个字节都写不进去**（本模块会安静自我禁用，
 *    于是"以为在收数据、其实一行没有"）。正解是 systemd 的 `StateDirectory=`（它**自动**把目录加进可写集），
 *    并把这里指到**树外**（`Environment=SP_STATS_DIR=/var/lib/stronghold/stats`）——
 *    顺带还解决了另一个坑：**换包是 `mv` 旧树**，树内 `var/` 会被留在 `prev` 里丢掉。
 */
export const STATS_DIR = process.env.SP_STATS_DIR ? path.resolve(process.env.SP_STATS_DIR) : path.join(ROOT, 'var', 'stats');
/** 保留天数（按文件名的日期判断）。 */
export const RETENTION_DAYS = 30;
const KINDS = ['matches', 'emotes'];

/**
 * 是否采集。`SP_STATS=0` 关、`=1` 开；未设时：**测试进程默认关**（Node 跑 `node --test` 会给子进程设 `NODE_TEST_CONTEXT`），
 * 其余（= 真实部署）默认开。@param {Record<string,string|undefined>} env */
export function statsEnabled(env = process.env) {
  const v = String(env.SP_STATS ?? '').trim();
  if (v === '0') return false;
  if (v === '1') return true;
  return !env.NODE_TEST_CONTEXT;
}

/**
 * 建一个采集器。永不抛：任何内部错误都会让它安静地自我禁用。
 * @param {{dir?:string,enabled?:boolean,now?:()=>number,log?:any,retentionDays?:number,
 *          app?:string|null, build?:string|null, artVersion?:string|null}} [opts]
 */
export function createStats(opts = {}) {
  const {
    dir = STATS_DIR, enabled = statsEnabled(), now = Date.now, log = null,
    retentionDays = RETENTION_DAYS, app = null, build = null, artVersion = null,
  } = opts;
  // `app`/`build`/`artVersion` 允许是**函数**（懒取值）：`startServer` 里 `new Lobby` 早于 build/art 的预热，
  // 传函数就既不用挪既有代码，也不会为一次可能永远不会发生的结算去读文件。
  const val = (v) => (typeof v === 'function' ? v() : v);

  let dead = !enabled;
  let salt = null;
  let pruned = false;
  /** 同一局只记一次（`finish` 与 `dispose` 都会到）。 */
  const recorded = new WeakSet();
  /** 一局一个匿名 id，用来把 `emotes-*` 与 `matches-*` 两串记录 join 起来。 */
  const mids = new WeakMap();

  const warn = (msg, e) => { try { log?.warn?.(`[stats] ${msg}${e ? `: ${e.message || e}` : ''}`); } catch { /* ignore */ } };

  /** 本机盐：首见创建，读不到就退回进程内随机盐（一样匿名，只是重启后不可关联）。 */
  function getSalt() {
    if (salt) return salt;
    const file = path.join(dir, '.salt');
    try {
      salt = fs.readFileSync(file, 'utf8').trim();
      if (!/^[0-9a-f]{16,}$/.test(salt)) throw new Error('bad salt');
    } catch {
      try {
        fs.mkdirSync(dir, { recursive: true });
        salt = randomBytes(16).toString('hex');
        fs.writeFileSync(file, `${salt}\n`, 'utf8');
      } catch { salt = randomBytes(16).toString('hex'); }
    }
    return salt;
  }

  /** 匿名化：同机同值稳定，跨机不可比。 */
  function hash(v) {
    if (v == null || v === '') return null;
    return createHash('sha256').update(`${getSalt()}:${String(v)}`).digest('hex').slice(0, 12);
  }

  const day = (t) => new Date(t).toISOString().slice(0, 10);
  const fileFor = (kind, t) => path.join(dir, `${kind}-${day(t)}.jsonl`);

  /** 保留期清理：只删我们自己的、文件名日期超过 `retentionDays` 的文件。 */
  function prune(nowMs) {
    if (pruned) return;
    pruned = true;
    try {
      const cutoff = nowMs - retentionDays * 86_400_000;
      for (const name of fs.readdirSync(dir)) {
        const m = /^(matches|emotes)-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
        if (!m) continue;
        if (Date.parse(`${m[2]}T00:00:00Z`) < cutoff) fs.unlinkSync(path.join(dir, name));
      }
    } catch { /* 目录不存在 / 权限不足都无所谓 */ }
  }

  function append(kind, row) {
    if (dead) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      prune(row.at);
      fs.appendFileSync(fileFor(kind, row.at), `${JSON.stringify(row)}\n`, 'utf8');
    } catch (e) {
      dead = true;
      warn('写文件失败，已自我禁用', e);
    }
  }

  const midOf = (match) => {
    let m = mids.get(match);
    if (!m) { m = randomBytes(6).toString('hex'); mids.set(match, m); }
    return m;
  };

  /** 座位构成 + 每人战果（**字段白名单：不复制 `name`/`title` 等任何身份信息**）。 */
  function seatsOf(match) {
    const res = match?.lastResultMsg || null;
    const byId = new Map((Array.isArray(res?.players) ? res.players : []).map((p) => [p?.playerId, p]));
    const seats = Array.isArray(match?.opts?.seats) ? match.opts.seats : [];
    return seats.map((s) => {
      const p = s && byId.get(s.playerId);
      const st = p && p.stats ? p.stats : null;
      const row = { kind: s && s.isBot ? 'bot' : 'human', who: s && s.isBot ? null : hash(s && s.playerId) };
      if (st) {
        for (const [k, src] of [['rounds', 'roundsPassed'], ['lp', 'lp']]) {
          const v = p[src];
          if (Number.isFinite(v)) row[k] = Math.round(v);
        }
        for (const k of ['kills', 'leaks', 'dmgDealt', 'gold']) {
          if (Number.isFinite(st[k])) row[k === 'dmgDealt' ? 'dmg' : k] = Math.round(st[k]);
        }
      }
      return row;
    });
  }

  /**
   * 记一局（`finish` 与 `dispose` 都调；**同一局只写一行**）。
   * @param {any} match @param {'finished'|'disposed'} reason
   */
  function recordMatch(match, reason = 'finished') {
    if (dead || !match || typeof match !== 'object') return null;
    if (recorded.has(match)) return null;
    recorded.add(match);
    const res = match.lastResultMsg || null;
    const row = {
      at: now(), mid: midOf(match), reason, app: val(app), build: val(build), artVersion: val(artVersion),
      mode: match.mode === 'solo' ? 'solo' : 'coop', difficulty: match.difficulty ?? null,
      round: Number.isFinite(match.round) ? match.round : null,
      victory: res && typeof res.victory === 'boolean' ? res.victory : null,
      roundsPassed: res && Number.isFinite(res.roundsPassed) ? res.roundsPassed : null,
      resultReason: res && typeof res.reason === 'string' ? res.reason : null,
      seats: seatsOf(match),
    };
    append('matches', row);
    return row;
  }

  /** 记一个表情事件（只记成功广播的：`Match.emote` 失败会返回 `{error}`）。 */
  function recordEmote(match, ps, id) {
    if (dead || !match || !ps || typeof id !== 'string') return null;
    const row = {
      at: now(), mid: midOf(match), who: ps.isBot ? null : hash(ps.playerId),
      kind: ps.isBot ? 'bot' : 'human', id,
      round: Number.isFinite(match.round) ? match.round : null,
      phase: typeof match.phase === 'string' ? match.phase : null,
    };
    append('emotes', row);
    return row;
  }

  /**
   * 包一层 `MatchClass`（`lobby.js:205/601` 的既有注入口）：`finish`/`dispose`/`emote` 三个钩子。
   * 关闭时**原样返回**（连子类都不建）⇒ 对性能与测试零影响。
   * @template T @param {T} Base @returns {T}
   */
  function wrap(Base) {
    if (Base == null) return Base;
    if (dead) return Base;
    return class StatsMatch extends Base {
      finish(o) {
        const r = super.finish(o);
        try { recordMatch(this, 'finished'); } catch { /* ignore */ }
        return r;
      }
      dispose() {
        const r = typeof super.dispose === 'function' ? super.dispose() : undefined;
        try { recordMatch(this, 'disposed'); } catch { /* ignore */ }
        return r;
      }
      emote(ps, id) {
        const r = typeof super.emote === 'function' ? super.emote(ps, id) : undefined;
        // `Match.emote` 失败时返回 `{ error, detail? }`（Match.js:202 的 fail）⇒ 只记真的广播出去的那些。
        if (!(r && typeof r === 'object' && r.error)) { try { recordEmote(this, ps, id); } catch { /* ignore */ } }
        return r;
      }
    };
  }

  return {
    get enabled() { return !dead; },
    dir, hash, recordMatch, recordEmote, wrap,
    /** 今天这个 kind 的文件路径（诊断/测试用）。 */
    pathFor: (kind, t = now()) => fileFor(KINDS.includes(kind) ? kind : 'matches', t),
  };
}
