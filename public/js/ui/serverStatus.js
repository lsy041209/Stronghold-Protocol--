// public/js/ui/serverStatus.js — "how busy is this server right now" (在线人数 / 房间数).
//
// WHY: a player about to create a room wants to know whether anybody else is around, and the operator wants a
// in-game read on load. The server already answers all of it: `GET /healthz` (server/index.js) returns the lobby's
// counters (rooms, matches, humans, bots, spectators — server/lobby.js stats()) next to the socket/session counts.
//
// WHY A SECOND POLLER rather than a field on buildGuard.js: the guard's whole contract is "detect a NEW build and
// reload", and its two-sighting rule exists so a half-finished deploy cannot ping-pong a page. Population is a
// display detail on a different clock: it wants a plain last-known reading, no confirmations, and it must never
// influence a reload. Sharing one fetch would couple the two the moment either needs a different cadence.
//
// COST: one small request per client per POLL_INTERVAL_MS. It is served from memory (sendJson, no disk read, no
// gzip cache entry) and is deliberately NOT counted against the WebSocket rate limits (it is plain HTTP, not /ws).
// 45 s keeps a lobby of a hundred players at a couple of requests per second.
//
// "Online" is the number of open WebSocket connections (`sockets`), which is the only headline number /healthz
// reports that does not depend on any player having joined a room yet. It counts spectators and un-seated players,
// and it is the metric a client can be honest about. `sessions` (which outlives a socket by the reconnect window)
// and `humans` (seated, non-bot players — room-bound) are carried alongside so a future panel can show them, but
// they are not what the pill calls 在线.
//
// Kept dependency-free and injectable (fetch / timers / onError) so test/ui/serverStatus.test.js can drive it.

/** How often a page re-reads the population. */
export const POLL_INTERVAL_MS = 45_000;
/** Give up on a `/healthz` that does not answer, so a hang cannot stop every later poll. */
export const FETCH_TIMEOUT_MS = 5_000;

/**
 * Pull the numbers we display out of a `/healthz` body.
 *
 * Tolerant by design: every field is optional and anything unusable becomes null (the static stand-in, an older
 * server without these counters, a proxy error page that still parsed as JSON). All counters are floored
 * non-negative integers, so a stray `-1` or `2.7` can never reach the screen as a count.
 *
 * 🔴 **2026-10-08 第 4 任 D（用户实测报告：「我只开了两个浏览器，却显示有 3 人」）：**
 * 这里的 `online` **原来是 `sockets + socketsInternal`（= WebSocket 连接数）**，那是**错的**：
 * `server/net.js` 在**每一条 upgrade 成功的 socket** 上立刻登记（`conns.set(ws, conn)`），
 * 而真正的"会话"要等客户端发 `hello` 才有 ⇒ **"连上但没握手的连接"会被算成"一个人"**。
 * 实测（`.workbuddy/tools/d-probe-online-count-semantics.mjs`）：只连不发 hello ×2 ⇒ `sockets +2`、`sessions +0`。
 * 另：`sessions`（全部会话）**也不能当在线人数** —— 它含"断线但仍在重连窗口内"的会话，**断开后不回落**（同探针 ③）。
 * ⇒ 现在 `online` 取**已握手且在线的会话数**，按新旧服务器兼容顺序回退：
 *    `sessionsOnline`（0.2.1 起有）→ `onlinePlayers`（真人＋AI 在座）→ `humans` → `sessions` → `sockets`。
 *    `sockets` 仍单独保留（技术读数），并在浮层里**如实写明它是"连接数"**。
 * @param {any} body parsed /healthz JSON
 * @returns {{ online: number|null, sockets: number|null, socketsInternal: number|null, sessions: number|null,
 *             sessionsOnline: number|null, onlinePlayers: number|null, dormantRooms: number|null,
 *             rooms: number|null, matches: number|null, humans: number|null, bots: number|null,
 *             spectators: number|null, build: string|null }}
 */
export function parseServerStats(body) {
  const count = (v) => (Number.isFinite(v) ? Math.max(0, Math.floor(v)) : null);
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const sockets = count(b.sockets);
  const socketsInternal = count(b.socketsInternal);
  // 已握手且在线的会话（0.2.1 起 `/healthz` 提供）—— 这才是"多少人开着页面"。
  const sessionsOnline = count(b.sessionsOnline);
  const onlinePlayers = count(b.onlinePlayers);
  return {
    // An unreachable server must show "离线", never a confident "0 在线" — so carry null, not 0, when absent.
    // ⚠️ 顺序即语义：**优先"人"**，只有老服务器什么都不给时才退回"连接数"。
    online: sessionsOnline ?? onlinePlayers ?? count(b.humans) ?? count(b.sessions)
      ?? (sockets == null && socketsInternal == null ? null : (sockets ?? 0) + (socketsInternal ?? 0)),
    sockets,
    socketsInternal,
    sessions: count(b.sessions),
    sessionsOnline,
    onlinePlayers,
    dormantRooms: count(b.dormantRooms),
    rooms: count(b.rooms),
    matches: count(b.matches),
    humans: count(b.humans),
    bots: count(b.bots),
    spectators: count(b.spectators),
    build: typeof b.build === 'string' && b.build ? b.build : null,
  };
}

/**
 * Read `/healthz` once. Never throws: an unreachable / non-OK / non-JSON / too-slow answer resolves to null,
 * which the caller renders as 离线.
 * @param {{ fetchFn?: Function, timeoutMs?: number, setTimeout?: Function, clearTimeout?: Function }} [o]
 * @returns {Promise<ReturnType<typeof parseServerStats>|null>}
 */
export async function fetchServerStatus(o = {}) {
  const fetchFn = o.fetchFn || ((url, init) => globalThis.fetch(url, init));
  const timeoutMs = Number.isFinite(o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : FETCH_TIMEOUT_MS;
  const setT = o.setTimeout || ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clearT = o.clearTimeout || ((h) => globalThis.clearTimeout(h));
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = null;
  const tooSlow = new Promise((_, reject) => {
    timer = setT(() => { try { ctrl?.abort(); } catch { /* ignore */ } reject(new Error('timeout')); }, timeoutMs);
  });
  try {
    const res = await Promise.race([fetchFn('/healthz', { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined }), tooSlow]);
    if (!res || !res.ok) return null;
    return parseServerStats(await res.json());
  } catch {
    return null;
  } finally {
    if (timer != null) clearT(timer);
  }
}

/** The live reading, readable without subscribing (a component's first render). @type {ReturnType<typeof parseServerStats>|null} */
/**
 * The reading of a poll that could not reach the server.
 *
 * Not `null`: a component subscribing through `useState` would be handed `null` both before the first poll and after
 * a failed one, and `setState(null)` when the state is already `null` is a no-op — the pill would then never render
 * its 离线 state at all (found by .workbuddy/tools/probe-offline-pill.mjs). A distinct object (identity compared)
 * makes "not polled yet" (`undefined`) and "polled and failed" two different, renderable values.
 * @type {Readonly<{ offline: true }>}
 */
export const SERVER_STATUS_OFFLINE = Object.freeze({ offline: true });

/** The live reading: `undefined` = no poll finished yet, `SERVER_STATUS_OFFLINE` = the last poll failed, else the
 *  parsed stats. Readable without subscribing (a component's first render). */
let snapshot;
/** Subscribers of the reading (the pill's component). */
const listeners = new Set();
/** The running poller — one per page (startServerStatus is idempotent). @type {object|null} */
let started = null;

/** Notify every subscriber of the current reading. @param {ReturnType<typeof parseServerStats>|typeof SERVER_STATUS_OFFLINE} next */
function publish(next) {
  snapshot = next;
  for (const fn of [...listeners]) {
    try { fn(snapshot); } catch { /* one bad subscriber must not stop the others (or the poll loop) */ }
  }
}

/** @returns {ReturnType<typeof parseServerStats>|typeof SERVER_STATUS_OFFLINE|undefined} */
export function getServerStatus() { return snapshot; }

/**
 * Subscribe to population changes. The listener is called on every completed poll (`SERVER_STATUS_OFFLINE` when the
 * server could not be read). No immediate call — a component renders the current `getServerStatus()` itself, so it
 * does not flicker when it mounts between two polls.
 * @param {(s: ReturnType<typeof parseServerStats>|typeof SERVER_STATUS_OFFLINE|undefined) => void} fn
 * @returns {() => void} unsubscribe
 */
export function subscribeServerStatus(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * Start polling. Idempotent per page: a second call joins the running loop instead of adding a second timer, so a
 * screen that also starts it defensively cannot double the request rate.
 * @param {{ fetchFn?: Function, intervalMs?: number, timeoutMs?: number, onError?: (e: unknown) => void,
 *           setInterval?: Function, clearInterval?: Function, setTimeout?: Function, clearTimeout?: Function,
 *           immediate?: boolean }} [o]
 * @returns {{ stop: () => void, check: () => Promise<ReturnType<typeof parseServerStats>|typeof SERVER_STATUS_OFFLINE>,
 *             status: () => ReturnType<typeof parseServerStats>|typeof SERVER_STATUS_OFFLINE|undefined,
 *             subscribe: (fn: Function) => () => void }}
 */
export function startServerStatus(o = {}) {
  if (started) return started;
  const setIv = o.setInterval || ((fn, ms) => globalThis.setInterval(fn, ms));
  const clearIv = o.clearInterval || ((h) => globalThis.clearInterval(h));
  const intervalMs = Number.isFinite(o.intervalMs) && o.intervalMs > 0 ? o.intervalMs : POLL_INTERVAL_MS;
  let stopped = false;
  let pending = false;
  let timer = null;
  const onError = typeof o.onError === 'function' ? o.onError : (e) => console.warn('[server-status] poll failed', e);

  const check = async () => {
    if (stopped) return snapshot;
    if (pending) return snapshot; // one request in flight at a time: a slow server must not build a backlog
    pending = true;
    let next = SERVER_STATUS_OFFLINE;
    try {
      next = (await fetchServerStatus({ fetchFn: o.fetchFn, timeoutMs: o.timeoutMs, setTimeout: o.setTimeout, clearTimeout: o.clearTimeout })) ?? SERVER_STATUS_OFFLINE;
    } catch (e) {
      // fetchServerStatus() already swallows everything; this only guards a throwing injected fetchFn.
      try { onError(e); } catch { /* ignore */ }
      next = SERVER_STATUS_OFFLINE;
    } finally {
      pending = false;
    }
    if (stopped) return next;
    publish(next);
    return next;
  };

  const tick = () => { check().catch(() => {}); };
  timer = setIv(tick, intervalMs);
  if (o.immediate !== false) tick();

  started = {
    stop: () => { stopped = true; if (timer != null) { clearIv(timer); timer = null; } started = null; },
    check,
    status: getServerStatus,
    subscribe: subscribeServerStatus,
  };
  return started;
}

/** Whether a poll loop is currently running (tests, diagnostics). */
export function isServerStatusRunning() { return started != null; }

/** Tear the page-level poller down (tests, and a page that must stop polling). Idempotent. */
export function resetServerStatus() {
  if (started) { try { started.stop(); } catch { /* ignore */ } }
  started = null;
  snapshot = undefined;
  listeners.clear();
}
