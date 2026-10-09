// public/js/ui/serverStatusPill.js — the ServerStatusPill (在线人数 / 房间数) presentational component.
//
// Reads the live reading from ui/serverStatus.js (started once in main.js) and re-renders when it changes. No
// fetching happens here: the poller owns the cadence, this only draws it. Split out of serverStatus.js so that the
// poller stays DOM-free and unit-testable without preact.

import { useEffect, useReducer } from '../../vendor/hooks.module.js';
import { html, Icon } from './components.js';
import { getServerStatus, subscribeServerStatus, SERVER_STATUS_OFFLINE } from './serverStatus.js';

/**
 * Compact "how busy is this server" pill.
 *
 * Three states, deliberately distinct:
 *   · no poll finished yet (`undefined`) → render NOTHING. A half-second of "0 在线 / 0 房间" on every page load
 *     would read as "nobody is here" on a server with a hundred players.
 *   · the last poll failed (`SERVER_STATUS_OFFLINE`) → a muted 离线 pill. An absent number must never be shown as 0.
 *   · a reading → 在线 (open WebSocket connections) + 房间.
 *
 * Re-rendering uses `useReducer` + a module-held reading rather than `useState(latest)` — the same choice
 * ui/components.js `useTicker` makes. A `useState` setter taking the new reading can be dropped by Preact's
 * re-render bail-out (`Object.is` against the value captured at mount) or by an update that lands while the initial
 * mount is still being committed, and the pill then never appears at all: measured with
 * .workbuddy/tools/probe-server-status-pill.mjs, the failed-first-poll case left the pill unrendered until some
 * unrelated re-render happened to come along. A force-update reducer has neither failure mode.
 * @param {{ class?: string, compact?: boolean }} props
 */
/**
 * The pill's three states **as data**, so the decision is unit-testable in Node.
 *
 * Why it is split out: a preact component cannot be called outside a render — its hooks throw
 * (`Cannot read properties of undefined (reading '__H')`, measured 2026-10-06), so the existing
 * `walk(vnode)` style of test used for hook-free components does not work here. The render below is then a
 * one-liner over this object and the states (未就绪 / 离线 / 有读数) can be asserted without a browser.
 *
 * @param {any} s the reading (undefined = no poll has finished yet; SERVER_STATUS_OFFLINE = unreachable)
 * @returns {null | { kind: 'offline'|'reading', online: number|null, rooms: number|null, detail: string }}
 */
export function pillView(s) {
  if (s === undefined) return null; // no poll has finished yet
  if (s === SERVER_STATUS_OFFLINE) {
    return { kind: 'offline', online: null, rooms: null, detail: '读不到服务器状态（/healthz 无响应）' };
  }
  // `?? 0`: a reading that omits these two counters (an older server) shows 0 rather than nothing — the pill's
  // headline numbers are what the player came for. (parseServerStats keeps them null, so the distinction is not lost
  // upstream; the tooltip still lists whatever else is present.)
  //
  // 🔴 2026-10-08 第 4 任 D（用户报「开 2 个浏览器却显示 3 人」）：
  //   `online` **现在来自 `parseServerStats` 的"人"口径**（`sessionsOnline` → `onlinePlayers` → `humans` → `sessions`），
  //   不再直接把 `sockets`（连接数）当人数 —— 那是本次误报的根因。见 `serverStatus.js` 的 `parseServerStats` 注释。
  const online = s.online ?? 0;
  const rooms = s.rooms ?? 0;
  const detail = [
    // ⚠️ 措辞要**点明口径**：这一格是"真会话数"（已握手的在线会话），不是连接数。
    `在线 ${online} 人（已握手的会话）`,
    // 房间数要说清"其中多少是空的休眠房"，否则"房间比人多"看起来像 bug（其实是保留期）。
    `房间 ${rooms}${s.dormantRooms ? `（另有休眠房 ${s.dormantRooms}）` : ''}`,
    s.matches != null ? `对局 ${s.matches}` : null,
    // ⚠️ 这两个是**技术读数**，量的是连接不是人 —— 如实标出来，免得下一个人又拿它当人数。
    s.sockets != null ? `连接 ${s.sockets}（含未握手）` : null,
    s.sessions != null ? `会话 ${s.sessions}（含重连窗口）` : null,
    s.humans != null ? `在座 ${s.humans}` : null,
    s.spectators != null && s.spectators > 0 ? `观战 ${s.spectators}` : null,
    s.bots != null && s.bots > 0 ? `AI ${s.bots}` : null,
  ].filter(Boolean).join(' · ');
  return { kind: 'reading', online, rooms, detail };
}

export function ServerStatusPill({ class: cls, compact = false }) {
  // A ref would be imported as an extra hook for nothing: the component is re-rendered by the reducer, so reading the
  // module value during render is always what we want to draw.
  const [, force] = useReducer((c) => c + 1, 0);
  useEffect(() => subscribeServerStatus(() => force()), []);

  const v = pillView(getServerStatus());
  const cx = (...p) => p.filter(Boolean).join(' ');
  const base = cx('serverpill', compact && 'serverpill--sm', cls);
  if (!v) return null; // no poll has finished yet
  if (v.kind === 'offline') {
    return html`<span class=${cx(base, 'serverpill--off')} title=${v.detail}>
      <${Icon} name="wifiOff" class="serverpill__icon" /><span class="serverpill__label">离线</span>
    </span>`;
  }

  return html`<span class=${base} title=${v.detail}>
    <span class="serverpill__stat" title=${`在线 ${v.online} 人`}>
      <${Icon} name="users" class="serverpill__icon" />
      <span class="serverpill__value num">${v.online}</span><span class="serverpill__label">在线</span>
    </span>
    <span class="serverpill__sep" aria-hidden="true"></span>
    <span class="serverpill__stat" title=${`房间 ${v.rooms}`}>
      <${Icon} name="rook" class="serverpill__icon" />
      <span class="serverpill__value num">${v.rooms}</span><span class="serverpill__label">房间</span>
    </span>
  </span>`;
}
