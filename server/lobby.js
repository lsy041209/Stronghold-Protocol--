// server/lobby.js — rooms, seats, host, AI seats, ready/start, reconnect, and room → Match wiring
// (DESIGN §2, §6.1 LOBBY, §8.1). Implements the handler interface consumed by server/net.js.
//
// Rules (the choices where DESIGN is silent are marked ▸):
//   * Rooms are keyed by 4-letter codes from an unambiguous alphabet (no I/O, letters only). Join codes are
//     case-insensitive.
//   * 'solo' rooms hold exactly one human and never bots. 'coop' rooms have 4 seats (humans + AI bots).
//     Humans and bots take the lowest free seat index; seat indexes never compact.
//   * ▸ Being in a LOBBY room and sending room.create / room.join implicitly leaves it. While your room is
//     in a match, create/join of another room fails with ROOM_STARTED (send g.leave or room.leave first).
//   * Host-only: room.setDifficulty, room.addBot, room.removeBot, room.kick, room.start. ▸ Changing the difficulty
//     un-readies the other humans. ▸ room.start requires every other human to be connected and ready;
//     the host's start counts as the host's ready (the host may still toggle room.ready for display).
//   * room.kick {seat, playerId} (community report #17, owner approved): before the match only, the host removes another
//     human like an AI seat (an AI seat stays room.removeBot's; never the host itself). `playerId` names the player the
//     host confirmed: a seat that changed hands meanwhile (left, someone else joined) is refused with BAD_TARGET. The
//     seat is freed at once and the player gets `room.closed {reason:'kicked'}` — now, or on the next resume when
//     offline (with the result replay, as the grace timeout) —, so the reconnect token no longer leads back to the seat
//     (it stays the player's identity: net.js sessions belong to players, not seats). ▸ No ban: the player may join
//     again with the code.
//   * Host migration: when the host leaves (or is removed), the lowest-seat remaining human (connected
//     ones first) becomes host. A room without humans is disposed (bots never keep a room alive).
//   * Disconnect in LOBBY: the seat shows connected=false and is freed after `lobbyGraceMs` (60 s); a
//     session that comes back after that gets `room.closed {reason:'timeout'}`.
//     Disconnect in a match: the seat is kept and match.onDisconnect(playerId) is called.
//   * Reconnect: `hello` with a known token (reconnect window, 10 min, see net.js) rebinds the session;
//     the lobby then broadcasts room.state and, in a match, calls match.onReconnect(playerId).
//     Solo runs (下半: "休整期及机变阶段没有时间限制…24小时内随时返回", research 01 §1 / 06 §17): a session that drops
//     while its solo room's match runs stays resumable for the official `config.constants.singleReconnectTime`
//     (86400 s; option `soloReconnectWindowMs` overrides it) instead of the 10-minute window — the untimed solo match
//     simply waits (net.js session.resumeWindowMs, set at every disconnect). Only after that does expiry turn into
//     match.onLeave ('abandoned'). The extension outlives the match, so a run that ended meanwhile (e.g. a server-run
//     Final Assault) still shows its result on the player's return.
//     A repeated hello on a live connection is a full resync: room.state goes to the requester only
//     (broadcast only when the seat visibly changed, e.g. a rename in LOBBY); the heavy part (match.onReconnect,
//     or the result replay below) runs at most once per `resyncMinGapMs` per session — extra requests inside
//     that window coalesce into one deferred resync, so hello spam cannot amplify into ~15 KB per request.
//   * Result replay: the match's final m.public and each human's m.result are kept after the match ends. A
//     human who resyncs (resume after a drop, a reloaded tab, a repeated hello) while the room is back in LOBBY
//     gets room.state followed by those two frames again, until they act in the room (ready, difficulty, AI
//     seats, start), leave it, or a new match starts. A human removed by the lobby grace gets them right after
//     `room.closed {timeout}` on their next resume (Match.onReconnect cannot do this: the lobby drops the
//     match reference at onEnd and disposes it on the next macrotask).
//   * Per-network limits (internet clients only, see net.js clientAddress): at most `maxRoomsPerAddr` rooms
//     created from one network may exist at once and at most `maxMatchesPerAddr` matches started from one
//     network may run at once (room.create / room.start → ERR.RATE). Without them a socket loop could fill
//     `maxRooms` or keep hundreds of unattended matches simulating for the whole reconnect window.
//   * Permanent departure during a match (room.leave, g.leave, reconnect window expired): the seat is
//     marked departed (shown as connected=false), match.onLeave(playerId) is called, and the seat is freed
//     when the match ends. 'g.leave' is handled here and never reaches match.handle().
//   * All other 'g.*' messages go to room.match.handle(playerId, msg); its {ok}/{error} becomes the reply.
//   * Match lifecycle: room.start → new Match({...}) → room.state (inMatch=true) → match.start(). The match gets
//     `matchNo` = the room's match number (1, 2, …): with the seed it keeps battleIds unique across the room's
//     matches, so a late b.progress / b.result of the previous match is ignored by the next one (DESIGN §14).
//     onEnd(summary) → room back to LOBBY (departed seats freed, humans un-readied, disconnected humans
//     get the lobby grace), dispose() on the next macrotask. Players can start again.
//   * room.closed reasons: 'timeout' (removed after lobby grace), 'kicked' (room.kick, room.removeSpectator), 'empty' (a
//     spectator whose room lost its last player), 'shutdown' (server stopping).
//   * Operator loadout (DESIGN §16): room.loadout { entries } is checked strictly against the game data
//     (shared/protocol.js checkLoadout: known visible chess, a skill index legal for the normal AND the elite status, a
//     module of the elite or 'none'; any bad entry rejects the whole message, nothing is stored). ▸ It is stored on the
//     session (it follows the player into every room they create/join, and survives a resume) and on the seat; the
//     match receives seats[].loadout (bots: none — they fight with the defaults). ▸ Accepted any time: in a LOBBY room
//     (or outside a room) it simply replaces the stored one; while the room's match runs it is also handed to
//     match.setLoadout(playerId, loadout), which accepts it only during INFO_CHECK (the 干员调配 entry of the briefing)
//     and refuses it afterwards (WRONG_PHASE: the match's loadout is locked, the stored one applies to the next match).
//   * Operator ownership (干员持有, 0.2.0 补位, owner's decision 2026-10-05): room.ownership { notOwned } — the base chess
//     ids the player marked as not owned — is checked leniently (shared/protocol.js checkNotOwned: anything that is not
//     a droppable NORMAL chess is dropped, never the whole list; only a malformed list is BAD_MSG) and stored on the
//     session and the seat like the loadout. The match receives seats[].notOwned when it starts (bots: none — they own
//     every operator) and keeps it for its whole length: the setting is out of match ("局外设置，下一局生效"), so while
//     the room's match runs a new list is only stored for the next match (ROOM_STARTED 'stored for the next match',
//     never handed to the match). A spectator's list stays on its session.
//   * 自选编队 (0.2.0 DIY, the owner's decisions of 2026-10-05): room.diy { picks } — the player's picks for the four DIY
//     slots ({ [slotBaseId]: { charId, skillIndex?, uniEquipId? } | null }) — is checked leniently (shared/protocol.js
//     checkDiyPicks against the game data and the kit registry, server/sim/content/kits/index.js KITTED_CHARS: an
//     illegal pick — an operator without a kit, another tier's prototype, a prototype off its locked skill, a second slot
//     of one owned operator, the same operator twice in a tier, an unknown slot / skill / module — is dropped, never the
//     whole roster; only malformed picks are BAD_MSG) and stored on the session and the seat exactly like the
//     not-owned list: the match receives seats[].diy when it starts (bots: none — they field no 自选 piece [ASSUMED]),
//     and a change while it runs is stored for the next match (ROOM_STARTED 'stored for the next match'). Every
//     `welcome` carries `diyKitted` (welcomeInfo): the operators a DIY slot may field, so the client's picker offers
//     exactly what the server accepts.
//   * Spectator seats (community report #26, owner's decision 2026-10-04 — a remake feature, the official room has none):
//     room.spectate { code } takes one of a co-op room's MAX_SPECTATORS (2) spectator seats, in its lobby or while its
//     match runs (▸ solo rooms: ROOM_FULL). A spectator is not a player: never in `seats`, never counted for the 1–4 players
//     or the start gate, never host, never keeps a room alive (a room whose last human leaves closes with room.closed
//     {empty} for its spectators). It receives room.state (`spectators: [{ playerId, name, connected }]`) and every match
//     broadcast (m.public, m.ticker, m.emote, b.pool — public data); the match registers it (opts.spectators /
//     addSpectator) and shows it fields like an eliminated player (b.start watch / m.field), never an m.private. It may
//     only g.watch (the heavy bucket, like every watcher), g.leave / room.leave, and room.loadout / room.ownership /
//     room.diy (stored for its session, never handed to the match); anything else → SPECTATOR (▸ emotes too). Host: room.removeSpectator { playerId } any
//     time → room.closed {kicked} to it. A spectator in a LOBBY room may take a free player seat with room.join of the same
//     code; a player never switches to spectating in place (ALREADY). Disconnect / grace / reconnect / expiry work as for
//     a player seat (the seat is kept and given back on resume).

import { randomBytes, randomInt } from 'node:crypto';
import fs from 'node:fs';        // 🆕 W-6：读头像真表
import path from 'node:path';    // 🆕 W-6：拼路径
import { ERR, MAX_SEATS, MAX_SPECTATORS, ROOM_CODE_LEN, modeIdFor, QUICK_IDS } from '../shared/constants.js';
import { checkLoadout, checkNotOwned, checkDiyPicks, CHAT_LIMITS } from '../shared/protocol.js';
import { encode, isDroppable, isErrCode, sanitizeChat, sendRaw, sendSession } from './net.js';
import { getData as defaultGetData, lookup } from './data.js';
import { ROOT as REPO_ROOT } from './http/config.js';   // 🆕 W-6：读 public/assets/avatar/manifest.json 的真表
import { Match as DefaultMatch } from './match/Match.js';
import { KITTED_CHARS } from './sim/content/kits/index.js';

/** Room code alphabet: uppercase letters without I and O (and no digits, so no 0/1). */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

/** Tunables. */
export const LOBBY_DEFAULTS = Object.freeze({
  lobbyGraceMs: 60_000,   // disconnected humans keep their lobby seat this long
  // 野排房等到期自动用 AI 补满座位并开局（≤0/非有限值 = 关掉到期补齐，只进/建房等人）。
  // 野排（`room.matchmake`）是**我方独有**的联机功能；换基座到 0.2.x 时它整段消失（静默回退），
  // 2026-10-07 由第 4 任 D 按新基座重新接线；判据 `test/lobby-matchmake.test.js`（9 条）。
  matchmakeFillMs: 60_000,
  // **空房**不立刻销毁，转入休眠表保留这么久（默认 20 分钟），期内**同一个房主账号**再开房
  // ⇒ 复用原房号 + 原聊天记录。≤0 / 非有限值 = 不保留（空房立刻销毁）。
  roomRetentionMs: 20 * 60_000,
  // 休眠表的**硬上限**（按用户给保留期规则的原话「**以免内存占用过高**」）：超了按 **FIFO** 淘汰
  // **最早进入休眠**的那间（连带清空它的聊天记录）。≤0 / 非有限值 = 不限。
  maxDormantRooms: 200,
  maxRooms: 1000,
  maxRoomsPerAddr: 16,    // rooms created from one client network that may exist at once (0 = unlimited)
  maxMatchesPerAddr: 8,   // matches started from one client network that may run at once (0 = unlimited)
  resyncMinGapMs: 1000,   // heavy resyncs (match state / result replay) per session at most this often on repeated hellos
  soloReconnectWindowMs: null, // a dropped solo run stays resumable this long (null = data singleReconnectTime, 24 h)
});

/** Official `singleReconnectTime` (s) when the data lacks it (constData, research 01 §1). */
export const SOLO_RECONNECT_FALLBACK_SEC = 86_400;

/** Display names for AI teammates (the tutorial NPCs first, then a few familiar faces). */
export const BOT_NAMES = Object.freeze(['AI·华法琳', 'AI·阿米娅', 'AI·惊蛰', 'AI·杜宾', 'AI·凯尔希', 'AI·可露希尔']); // i18n-ignore: player names (docs/I18N.md)

const OK = Object.freeze({ ok: true });
const fail = (code, detail) => (detail ? { error: code, detail } : { error: code });
const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * @typedef {{ seat: number, playerId: string, name: string, isBot: boolean, ready: boolean,
 *             connected: boolean, left: boolean, loadout?: Record<string, { skill: number, module: string|null }> | null,
 *             notOwned?: readonly string[] | null, diy?: Readonly<Record<string, DiyLoadout>> | null }} Seat
 * @typedef {{ charId: string, skillIndex: number, uniEquipId: string|null }} DiyLoadout
 */

/** Deep-frozen copy of a checked loadout (shared by the session, the seat and the match's PlayerState). */
function freezeLoadout(loadout) {
  const out = {};
  for (const [id, e] of Object.entries(loadout || {})) out[id] = Object.freeze({ skill: e.skill, module: e.module ?? null });
  return Object.freeze(out);
}

/** Deep-frozen copy of checked 自选 picks (shared by the session, the seat and the match's PlayerState). */
function freezeDiy(picks) {
  const out = {};
  for (const [id, p] of Object.entries(picks || {})) out[id] = Object.freeze({ charId: p.charId, skillIndex: p.skillIndex, uniEquipId: p.uniEquipId ?? null });
  return Object.freeze(out);
}

/**
 * Deep-frozen copy of the player's operator skins `{ [baseChessId]: skinId }` (docs/SKINS.md) — shared by the session,
 * the seat and the match's PlayerState (whose `setSkins` re-checks the records against the data).
 * 🔁 2026-10-08（第 54 轮 A）：换基座到 0.2.1 时整段被静默丢掉（0.1.4.1 冷备 `lobby.js:184`）⇒ 已按冷备份接回。
 */
function freezeSkins(skins) {
  const out = {};
  for (const [id, skinId] of Object.entries(skins || {})) if (typeof skinId === 'string' && skinId) out[id] = skinId;
  return Object.freeze(out);
}

/** One room: 4 seat slots, host, difficulty, optional running match. */
export class Room {
  /** @param {string} code @param {'solo'|'coop'} mode @param {string} difficulty @param {number} now */
  constructor(code, mode, difficulty, now) {
    this.code = code;
    this.mode = mode;
    this.difficulty = difficulty;
    /** @type {string | null} */
    this.hostId = null;
    /** @type {(Seat | null)[]} */
    this.seats = new Array(MAX_SEATS).fill(null);
    /** @type {{ playerId: string, name: string, connected: boolean }[]} spectator seats, ≤ MAX_SPECTATORS (header) */
    this.spectators = [];
    /** @type {any} running Match instance */
    this.match = null;
    /**
     * 🆕 2026-10-08 快捷聊天：**房主的打字开关**。true ⇒ 本房只允许快捷短语（`server/lobby.js chat` 直接拒打字，
     * **服务端强制**、与客户端 UI 无关）；`room.quick` 只能在对局开始前改（用户 2026-10-08 拍板「战斗开始前」）。
     * 随房休眠/复活一起带（见 dormant 快照那两处）。
     */
    this.quickOnly = false;
    /** @type {{ live: boolean, ended: boolean, disposed: boolean, match: any } | null} */
    this.matchCtx = null;
    this.matchCount = 0;
    /** @type {any} summary passed to onEnd by the last match */
    this.lastSummary = null;
    /**
     * Frames of the last match's end, replayed on resync to humans who have not moved on yet.
     * @type {{ publicFrame: string | null, frames: Map<string, string>, pending: Set<string> } | null}
     */
    this.replay = null;
    /**
     * 房间内打字聊天的**内存**环形缓冲（最新 CHAT_LIMITS.history 条；`addChat`）。🔴 只活在内存里，**绝不落盘**；
     * 补发走 `onHello`（重连）与 `join`（首次进房）→ `chat.history { messages }`（D-3，用户裁决 ③）。
     * @type {{ from: string, name: string, text: string, at: number }[]}
     */
    this.chat = [];
    /** @type {string | null} per-network limit key of the creator (net.js clientAddress) */
    this.ownerKey = null;
    /**
     * @type {string | null} **房主账号**（`session.playerId`）—— 与 `ownerKey`（网络来源哈希）**不是一回事**。
     * 它专门给**空房保留（休眠表）**用来认人唤醒：房空了 `hostId` 会被 migrateHost 清掉，这个字段**故意不清**
     * （`migrateHost` 每次都把它跟到"当前/最后那位"房主，判据 `test/lobby-room-retention.test.js` ⑥）。
     */
    this.ownerId = null;
    /** @type {string | null} per-network limit key of whoever started the running match */
    this.matchKey = null;
    this.createdAt = now;
    /**
     * 野排快速匹配房：这间房是因为有人按了「快速匹配」才存在的 ⇒ 到点用 AI 补满并开局（见本文件的 matchmake 一族）。
     * @type {boolean}
     */
    this.matchmade = false;
    /** @type {NodeJS.Timeout | null} 该房的"到期 AI 补齐"计时器（**必须**在 start/dispose/失去资格时取消） */
    this.matchmakeTimer = null;
    /** @type {number | null} 截止时刻（`now()` 口径；只用于观测/日志，判定一律靠计时器本身） */
    this.matchmakeDeadline = null;
    /** @type {number | null} 进入休眠表（空房保留）的时刻；非 null = 正在休眠、不在 `rooms` 里。 */
    this.dormantAt = null;
    this.disposed = false;
  }

  /**
   * Append one chat line to the in-memory ring buffer, keeping only the newest `CHAT_LIMITS.history` (D-3).
   * Never touches the disk (`server/stats.js` / `server/ops.js` are not on this path).
   * @param {{ from: string, name: string, text: string, at: number }} entry
   */
  addChat(entry) {
    this.chat.push(entry);
    if (this.chat.length > CHAT_LIMITS.history) this.chat.splice(0, this.chat.length - CHAT_LIMITS.history);
  }

  /** @param {string} playerId @returns {Seat | null} */
  seatOf(playerId) {
    for (const s of this.seats) if (s && s.playerId === playerId) return s;
    return null;
  }

  /** @param {string} playerId @returns {{ playerId: string, name: string, connected: boolean } | null} */
  spectatorOf(playerId) { return this.spectators.find((s) => s.playerId === playerId) || null; }

  /** Lowest free seat index, or -1. */
  freeSeat() { return this.seats.indexOf(null); }

  /** Humans that have not departed, in seat order. @returns {Seat[]} */
  activeHumans() { return this.seats.filter((s) => s && !s.isBot && !s.left); }

  /** `room.state` frame (DESIGN §8.1) plus `inMatch`. */
  toState() {
    return {
      t: 'room.state',
      code: this.code,
      hostId: this.hostId,
      mode: this.mode,
      difficulty: this.difficulty,
      inMatch: !!this.match,
      // 🆕 2026-10-08 快捷聊天：**聊天模式**（客户端据此置灰输入框、显示「本房已关闭打字」）。
      //   'open' = 打字 + 短语都行｜'quick' = 只允许快捷短语（房主用 room.quick 开的，服务端强制）。
      //   ⚠️ 留 `'off'`（短语也禁）给将来用 —— 现在是两态，但形状按三态留，免得以后再来一次协议改动。
      chatMode: this.quickOnly ? 'quick' : 'open',
      seats: this.seats.map((s) => (s
        // 🆕 2026-10-09 W-6：`avatarId` **公开**（别人的名片要画）—— 与 `name` 同族；空则不带这个键
        ? { seat: s.seat, playerId: s.playerId, name: s.name, avatarId: s.avatarId || undefined, isBot: s.isBot, ready: s.ready, connected: s.connected && !s.left }
        : null)),
      spectators: this.spectators.map((s) => ({ playerId: s.playerId, name: s.name, avatarId: s.avatarId || undefined, connected: s.connected })),   // 🆕 W-6
    };
  }
}

/** Room registry + lobby message handlers. Pass an instance as the `handler` of net.js Network. */
export class Lobby {
  /**
   * @param {{
   *   registry: import('./net.js').SessionRegistry,
   *   log?: { info: Function, warn: Function, error: Function, debug?: Function },
   *   MatchClass?: new (opts: object) => any,
   *   getData?: () => object,
   *   now?: () => number,
   *   seedFn?: () => number,
   *   options?: Partial<typeof LOBBY_DEFAULTS>,
   * }} opts
   */
  constructor({ registry, log = noopLog, MatchClass = DefaultMatch, getData = defaultGetData, now = Date.now, seedFn, options = {} }) {
    this.registry = registry;
    this.log = log;
    this.MatchClass = MatchClass;
    this.getData = getData;
    this.now = now;
    this.seedFn = seedFn || (() => randomInt(2 ** 32));
    this.opts = { ...LOBBY_DEFAULTS, ...options };
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
    /**
     * **空房保留（休眠表）** —— 与 `this.rooms` **分开**的第三张表（第 3 任 D 的 D-3 第二批；
     * 换基座到 0.2.x 后整段消失，2026-10-07 由第 4 任 D 重新接线；判据 `test/lobby-room-retention.test.js`）。
     *
     * 空房（`disposeRoom(room,'empty')`）不立刻销毁 ⇒ 转入这里保留 `roomRetentionMs`（默认 20 分钟）；
     * 期内**同一个房主账号**再开房 ⇒ 复用**原房号 + 原聊天记录**。
     * ▸ **关停**（`'shutdown'`）等其余销毁路径一律照旧立刻销毁（`dormantOnDispose` 只认 `'empty'`）。
     * ▸ 每条的保留期定时器**必须 `unref()`**，否则会把 `node --test` 挂住不退出（本仓已知的坑）。
     * ▸ 表有硬上限 `maxDormantRooms`（默认 200，依据是用户给保留期规则的原话「**以免内存占用过高**」），
     *   超了按 **FIFO** 淘汰最早转休眠的那间（连带清空它的聊天记录）。
     * @type {Map<string, { code: string, ownerId: string, chat: any[], createdAt: number, timer: NodeJS.Timeout | null }>}
     */
    this.dormantRooms = new Map();
    /** @type {Map<string, NodeJS.Timeout>} lobby grace timers by playerId */
    this.graceTimers = new Map();
    /** @type {Map<string, NodeJS.Timeout>} deferred (coalesced) resyncs by playerId */
    this.resyncTimers = new Map();
    /** per-network limit warnings: at most one log line per 10 s (the rest are counted) */
    this.limitLog = { at: -Infinity, suppressed: 0 };
  }

  /** @param {string} code @returns {Room | null} */
  getRoom(code) { return this.rooms.get(String(code).toUpperCase()) || null; }

  /**
   * Counters for /healthz. Two口径 side by side (第 3 任 D，2026-10-06；D 换基座后于 0.2.1 重新接线)：
   *
   *   · **座位口径**（`rooms`/`matches`/`humans`/`bots`/`spectators`）—— 语义**从未变过**，含 24h 可重连的离线座位。
   *   · **在线口径**（`onlineHumans`/`offlineHumans`/`onlineBots`/`onlineSpectators`/`offlineSpectators`/
   *     `roomsOnline`/`roomsOffline`/`matchesOnline`/`matchesOffline`/`waitingRooms`/`botsInOnlineRooms`/`botsInOfflineRooms`）
   *     —— 判据 = **该座位/观战是否 `connected`**（`!== false` 即算在线，缺字段按在座算）。
   *
   * 为什么必须两套都有（线上实测的教训）：座位口径会出现「**2 个连接、43 个房间**」这种虚数 ——
   * 那 43 间里绝大多数只有离线座位。**别拿座位当活人。**
   *
   * `waitingRooms` = **未开局 ＋ 有在线真人 ＋ 还有空位**（满座未开局不算"在等人"；也是野排池子的观测量）。
   * ⚠️ 空位判据用 **`MAX_SEATS`（房间容量）**，**不是 `r.seats.length`** —— 测试里的假 room 只给实际有人的那几个座位，
   * 用 `r.seats.length` 会把"1 个座位"误判成"满座"（这正是本仓"判据读的是什么"那一类坑）。
   * 判据：`test/healthz-online-stats.test.js`（含"离线座位必须算离线"的回归护栏）。
   */
  stats() {
    let matches = 0;
    let humans = 0;
    let bots = 0;
    let spectators = 0;
    let onlineHumans = 0;
    let offlineHumans = 0;
    let onlineBots = 0;
    let onlineSpectators = 0;
    let offlineSpectators = 0;
    let roomsOnline = 0;
    let matchesOnline = 0;
    let waitingRooms = 0;
    let matchmaking = 0;
    let botsInOnlineRooms = 0;
    let botsInOfflineRooms = 0;
    for (const r of this.rooms.values()) {
      if (r.match) matches++;
      let roomHumansOnline = 0;
      let roomBots = 0;
      let occupied = 0;
      for (const s of r.seats) {
        if (!s || s.left) continue;
        occupied++;
        const on = s.connected !== false;      // 缺字段时按"在座"算（与座位口径的既有宽容一致）
        if (s.isBot) {
          bots++; roomBots++;
          if (on) onlineBots++;
        } else {
          humans++;
          if (on) { onlineHumans++; roomHumansOnline++; } else offlineHumans++;
        }
      }
      spectators += r.spectators.length;
      for (const sp of r.spectators) { if (sp.connected !== false) onlineSpectators++; else offlineSpectators++; }
      const online = roomHumansOnline > 0;
      if (online) { roomsOnline++; botsInOnlineRooms += roomBots; } else botsInOfflineRooms += roomBots;
      if (r.match && online) matchesOnline++;
      if (!r.match && online && occupied < MAX_SEATS) waitingRooms++;
      // 野排正在凑人的房（判据 = 同一族 `matchmakePoolAlive`：已标 matchmade、未开局、有在线真人）。
      // ⇒ `/healthz` 的 `matchmaking` 由它汇总。为什么要有这个读数：**野排是我方独有功能**，
      //    而"有没有人在用"以前**只能靠猜**（外部同族服务器用的是 `queue` 字段，C 10-08 实测过）。
      // ⚠️ 这里**故意内联**、不调 `this.matchmakePoolAlive(r)` —— `stats()` 会被判据用**裸 `{rooms}` 夹具**调用
      //    （`test/healthz-online-stats.test.js` 的 `Lobby.prototype.stats.call({rooms})`）⇒ 调原型方法会 `TypeError`。
      //    本函数全程都是这种"只看字段"的写法（同 `r.match` / `s.isBot` / `s.connected`），别改成方法调用。
      if (r.matchmade === true && !r.match && r.mode === 'coop'
        && r.seats.some((s) => s && !s.isBot && !s.left && s.connected !== false)) matchmaking++;
    }
    return {
      rooms: this.rooms.size, matches, humans, bots, spectators,
      onlineHumans, offlineHumans, onlineBots, onlineSpectators, offlineSpectators,
      roomsOnline, roomsOffline: this.rooms.size - roomsOnline,
      matchesOnline, matchesOffline: matches - matchesOnline,
      waitingRooms, matchmaking, botsInOnlineRooms, botsInOfflineRooms,
      // 🆕 2026-10-08 第 4 任 D（用户报「**房间比人还多**」）：**休眠房**数与**它们的保留期**。
      // 为什么必须有这个读数：空房**不立刻销毁**（`disposeRoom(room,'empty')` ⇒ 转 `dormantRooms` 保留
      // `roomRetentionMs`，默认 20 分钟，好让掉线的人找回原房号）。**以前没有任何字段告诉外面"有几间是人走了还在的"**，
      // 于是看板把"宽限期(60 s)＋休眠期(20 min)"里那些空房也画成"房间"，看起来就荒谬。
      // 判据 `test/healthz-online-semantics.test.js` ③。
      // ⚠️ **这里故意内联 `retentionMs()` 的算法、不调那个原型方法** —— 同上面 `matchmaking` 的理由：
      //    `test/healthz-online-stats.test.js` 会用**裸 `{rooms}` 夹具**调 `stats()` ⇒ 调原型方法会 `TypeError`。
      // ⚠️ `dormantRooms` 也要**防御式读**：判据用**裸 `{rooms}` 夹具**调 `stats()`
      //    （`test/healthz-online-stats.test.js` 的 `asLobby()` **只给 `rooms`**）⇒ 直接 `.size` 会 `TypeError`。
      //    语义上这也是对的：夹具没有休眠表 ⇒ 休眠房数就是 0。
      dormantRooms: this.dormantRooms ? this.dormantRooms.size : 0,
      dormantRoomRetentionMs: (() => {
        const ms = this.opts && this.opts.roomRetentionMs;
        return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : 0;
      })(),
    };
  }

  // ---------------------------------------------------------------------------------------------------
  // net.js handler interface
  // ---------------------------------------------------------------------------------------------------

  /**
   * After `welcome`: resend room state / match state for resumed (or repeated) hellos.
   * @param {import('./net.js').Session} session
   * @param {{ resumed: boolean, repeat: boolean }} info
   */
  onHello(session, { resumed, repeat }) {
    if (!resumed && !repeat) return;
    const room = this.roomOf(session);
    if (!room) {
      if (session.notice) {
        sendSession(session, { t: 'room.closed', reason: session.notice });
        session.notice = null;
      }
      if (session.pendingResult) {
        for (const frame of session.pendingResult) if (frame) sendRaw(session.ws, frame);
        session.pendingResult = null;
      }
      return;
    }
    session.notice = null;
    session.pendingResult = null;
    // a player seat, or a spectator seat (header): both carry `connected` / `name`
    const seat = room.seatOf(session.playerId) || room.spectatorOf(session.playerId);
    this.clearGrace(session.playerId);
    // Only a visible change (reconnect, rename, new host) is broadcast; a plain resync (repeated hello on a
    // live socket) answers the requester alone, so hello spam cannot amplify into room-wide traffic.
    let changed = !seat.connected;
    seat.connected = true;
    if (!room.match && seat.name !== session.name) { seat.name = session.name; changed = true; }
    if (!room.hostId) { this.migrateHost(room); changed = true; }
    // 野排房：人回来了（有在线真人 + 还有空位）⇒ 重新开始倒计时
    this.syncMatchmakeTimer(room);
    if (changed) this.broadcastState(room);
    else this.sendState(room, session);
    // 房间内打字聊天 (D-3, 用户裁决 ③「重进房间要看到」): 重连/重进同一会话时把最近几条补发给自己。
    // ▸ 只发给**请求者**（不进广播）；▸ 缓冲为空时**不发帧** —— 这样既有 resync 的帧序逐字不变
    //   （test/lobby.test.js 的 order() 断言 `['room.state','m.public:RESULT','m.result']`）。
    if (room.chat.length) sendSession(session, { t: 'chat.history', messages: room.chat.map((m) => ({ ...m })) });
    this.resync(session, !resumed);
  }

  /**
   * Validated client message from an identified session.
   * @param {import('./net.js').Session} session
   * @param {any} msg
   * @returns {{ ok: true } | { error: string, detail?: string }}
   */
  onMessage(session, msg) {
    switch (msg.t) {
      case 'room.create': return this.create(session, msg);
      case 'room.join': return this.join(session, msg);
      case 'room.leave': return this.leave(session);
      case 'room.ready': return this.ready(session, msg);
      case 'room.setDifficulty': return this.setDifficulty(session, msg);
      case 'room.addBot': return this.addBot(session);
      case 'room.removeBot': return this.removeBot(session, msg);
      case 'room.kick': return this.kick(session, msg);
      case 'room.start': return this.start(session);
      case 'room.loadout': return this.loadout(session, msg);
      case 'room.ownership': return this.ownership(session, msg);
      case 'room.diy': return this.diy(session, msg);
    // 🆕 2026-10-08（第 54 轮 A）：换基座 0.2.1 时丢掉的换装路由（冷备 `lobby.js:559`）⇒ 已接回。
    case 'room.skins': return this.skins(session, msg);
      case 'room.spectate': return this.spectate(session, msg);
      case 'room.removeSpectator': return this.removeSpectator(session, msg);
      case 'room.chat': return this.chat(session, msg);
    // 🆕 2026-10-08 快捷聊天：房主的打字开关 ＋ 白名单短语
    case 'room.quick': return this.quick(session, msg);
    case 'room.quickMsg': return this.quickMsg(session, msg);
    // 🆕 2026-10-09 W-6 头像：只传 id（真表 = public/assets/avatar/manifest.json）
    case 'room.avatar': return this.avatar(session, msg);
      case 'room.matchmake': return this.matchmake(session, msg);
      default:
        if (typeof msg.t === 'string' && msg.t.startsWith('g.')) return this.routeGame(session, msg);
        return fail(ERR.BAD_MSG, `unhandled type ${String(msg.t).slice(0, 32)}`);
    }
  }

  /** The session's socket closed. @param {import('./net.js').Session} session */
  onDisconnect(session) {
    this.clearResync(session.playerId); // the next resume resyncs immediately
    const room = this.roomOf(session);
    // a solo run may be resumed within singleReconnectTime (24 h); everything else keeps the registry's window
    session.resumeWindowMs = room && room.match && room.mode === 'solo' ? this.soloResumeWindowMs() : null;
    if (!room) return;
    const player = room.seatOf(session.playerId);
    const seat = player || room.spectatorOf(session.playerId);
    seat.connected = false;
    // a spectator's seat is kept like a player's (nothing to tell the match: it plays no field)
    if (room.match) { if (player) this.callMatch(room, 'onDisconnect', session.playerId); } else this.startGrace(room, seat);
    this.broadcastState(room);
  }

  /** The session's reconnect window elapsed (already removed from the registry). */
  onExpire(session) {
    session.notice = null;
    session.pendingResult = null;
    this.clearResync(session.playerId);
    const code = session.roomCode;
    session.roomCode = null;
    const room = code ? this.rooms.get(code) : null;
    if (room) this.removeMember(room, session.playerId);
  }

  /**
   * Dispose every room (notifying members with room.closed) — used on server shutdown.
   * @param {string} [reason]
   */
  shutdown(reason = 'shutdown') {
    for (const room of [...this.rooms.values()]) this.disposeRoom(room, reason);
    // ⚠️ 顺序：上面的 disposeRoom(reason='shutdown') **不会**把房转成休眠（`dormantOnDispose` 只认 'empty'）
    //    ⇒ 这里只需清掉**此前**已经休眠的那些（关停时不留任何内存里的房 + 聊天记录）。
    for (const code of [...this.dormantRooms.keys()]) this.dropDormantRoom(code);
    for (const t of this.graceTimers.values()) clearTimeout(t);
    this.graceTimers.clear();
    for (const t of this.resyncTimers.values()) clearTimeout(t);
    this.resyncTimers.clear();
  }

  // ---------------------------------------------------------------------------------------------------
  // room.* handlers
  // ---------------------------------------------------------------------------------------------------

  create(session, { mode, difficulty, chatMode }) {
    // 🆕 2026-10-08 建房时就能决定聊天模式（用户拍板：房主在战斗开始前决定要不要开打字）。
    //    ⚠️ 只认 'quick' 才关打字；`'off'`（短语也禁）还没实现 ⇒ 按 'open' 处理（宁可开着，不误关）。
    const quickOnly = chatMode === 'quick';
    const cur = this.roomOf(session);
    if (cur && cur.match) return fail(ERR.ROOM_STARTED, 'leave your running match first');
    if (this.rooms.size >= this.opts.maxRooms) return fail(ERR.INTERNAL, 'too many rooms');
    const key = session.limitKey || null;
    if (key && this.opts.maxRoomsPerAddr > 0) {
      // The room being left disappears with this create when the creator is its only human (a spectator is none).
      const leaving = cur && cur.ownerKey === key && cur.activeHumans().length === 1 && !cur.spectatorOf(session.playerId) ? 1 : 0;
      if (this.countRooms((r) => r.ownerKey === key) - leaving >= this.opts.maxRoomsPerAddr) {
        this.limitWarn(`room limit (${this.opts.maxRoomsPerAddr}) reached for ${session.addr}`);
        return fail(ERR.RATE, 'too many rooms from your network');
      }
    }
    // **空房保留**：同一房主账号名下有休眠房 ⇒ 复用**原房号 + 原聊天记录**（这是"原来那间房"）。
    const dormant = this.takeDormantRoom(session.playerId);
    const code = dormant ? dormant.code : this.genCode();
    if (!code) return fail(ERR.INTERNAL, 'no room code available');
    if (cur) this.removeMember(cur, session.playerId);
    const room = new Room(code, mode, difficulty, this.now());
    room.quickOnly = quickOnly;   // 🆕 2026-10-08 建房时选定的聊天模式
    room.ownerKey = key;
    // `ownerId` = **房主账号**（与 `ownerKey` 那个"网络来源"哈希不是一回事）：休眠表靠它认人唤醒。
    room.ownerId = session.playerId;
    if (dormant) room.chat = dormant.chat;   // 接着用原聊天记录
    if (dormant) room.quickOnly = !!dormant.quickOnly;   // 🆕 2026-10-08 打字开关也接着用
    room.seats[0] = this.humanSeat(0, session);
    room.hostId = session.playerId;
    this.rooms.set(code, room);
    session.roomCode = code;
    session.notice = null;
    session.pendingResult = null;
    this.log.info(`[lobby] ${code} ${dormant ? 'revived from dormancy' : 'created'} (${mode}/${difficulty}) by ${session.name}`);
    this.broadcastState(room);
    // **唤醒**：房主回到"原来那间房"，要像首次进房/重连那样**补发一次聊天记录**
    // （不然他会看到一间空白的旧房 —— 判据 `test/lobby-room-retention.test.js` ②）。
    // 新房不发（房间必空，见测试 ① 的断言）。
    if (dormant && room.chat.length) sendSession(session, { t: 'chat.history', messages: room.chat });
    return OK;
  }

  join(session, { code }) {
    const norm = String(code).trim().toUpperCase();
    const room = norm.length === ROOM_CODE_LEN ? this.rooms.get(norm) : undefined;
    if (!room) return fail(ERR.ROOM_NOT_FOUND);
    const cur = this.roomOf(session);
    // idempotent for members; a spectator of this room goes on below: it may take a free player seat (header)
    if (cur === room && !room.spectatorOf(session.playerId)) { this.sendState(room, session); return OK; }
    if (cur && cur.match) return fail(ERR.ROOM_STARTED, 'leave your running match first');
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (room.mode === 'solo') return fail(ERR.ROOM_FULL, 'solo room');
    const idx = room.freeSeat();
    if (idx < 0) return fail(ERR.ROOM_FULL);
    if (cur) this.removeMember(cur, session.playerId);
    room.seats[idx] = this.humanSeat(idx, session);
    session.roomCode = room.code;
    session.notice = null;
    session.pendingResult = null;
    if (!room.hostId) room.hostId = session.playerId;
    // D-3 第二批（用户裁决 ③ 追加确认「首次拿密钥进房也要看到」）：**首次进房**也补发最近几条。
    // ▸ 只发给**进房者**（不进广播）；▸ 缓冲为空 ⇒ **不发帧**（新房/没聊过的房保持既有帧序逐字不变）。
    // ⚠️ 上面那条"已在房里的重复 room.join"幂等路径**不补发**：它本来就在房里，客户端手里已有记录。
    if (room.chat.length) sendSession(session, { t: 'chat.history', messages: room.chat.map((m) => ({ ...m })) });
    this.broadcastState(room);
    return OK;
  }

  leave(session) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    this.removeMember(room, session.playerId);
    return OK;
  }

  /**
   * room.spectate: one of a co-op room's MAX_SPECTATORS spectator seats, in its lobby or during its match (header). In a
   * running match the match registers the spectator and resends what it may see (Match.addSpectator).
   */
  spectate(session, { code }) {
    const norm = String(code).trim().toUpperCase();
    const room = norm.length === ROOM_CODE_LEN ? this.rooms.get(norm) : undefined;
    if (!room) return fail(ERR.ROOM_NOT_FOUND);
    const cur = this.roomOf(session);
    if (cur === room) {
      if (!room.spectatorOf(session.playerId)) return fail(ERR.ALREADY, 'seated as a player');
      this.sendState(room, session);
      return OK;
    }
    if (cur && cur.match) return fail(ERR.ROOM_STARTED, 'leave your running match first');
    if (room.mode === 'solo') return fail(ERR.ROOM_FULL, 'solo room');
    if (room.spectators.length >= MAX_SPECTATORS) return fail(ERR.ROOM_FULL, 'no free spectator seat');
    if (cur) this.removeMember(cur, session.playerId);
    room.spectators.push({ playerId: session.playerId, name: session.name, avatarId: session.avatarId || '', connected: session.connected });   // 🆕 W-6
    session.roomCode = room.code;
    session.notice = null;
    session.pendingResult = null;
    this.broadcastState(room);
    if (room.match) this.callMatch(room, 'addSpectator', session.playerId);
    return OK;
  }

  /** room.removeSpectator (host, any time): the spectator gets room.closed {kicked} and its seat is freed. */
  removeSpectator(session, { playerId }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (!room.spectatorOf(playerId)) return fail(ERR.BAD_TARGET, 'not a spectator of this room');
    const target = this.registry.byId(playerId);
    const wasHere = !!target && target.roomCode === room.code;
    const replay = this.replayFor(room, playerId);
    this.removeMember(room, playerId);
    if (wasHere) {
      // like room.kick: now, or on the next resume (with the result replay, as after the grace timeout)
      if (target.connected) sendSession(target, { t: 'room.closed', reason: 'kicked' });
      else { target.notice = 'kicked'; target.pendingResult = replay; }
    }
    return OK;
  }

  ready(session, { ready }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.spectatorOf(session.playerId)) return fail(ERR.SPECTATOR);
    if (room.match) return fail(ERR.ROOM_STARTED);
    this.dropReplay(room, session.playerId);
    const seat = room.seatOf(session.playerId);
    if (seat.ready !== ready) {
      seat.ready = ready;
      this.broadcastState(room);
    }
    return OK;
  }

  setDifficulty(session, { difficulty }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    this.dropReplay(room, session.playerId);
    if (room.difficulty !== difficulty) {
      room.difficulty = difficulty;
      for (const s of room.seats) if (s && !s.isBot && s.playerId !== room.hostId) s.ready = false;
      this.broadcastState(room);
    }
    return OK;
  }

  addBot(session) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    this.dropReplay(room, session.playerId);
    if (room.mode === 'solo') return fail(ERR.ROOM_FULL, 'solo rooms cannot have AI teammates');
    const idx = room.freeSeat();
    if (idx < 0) return fail(ERR.ROOM_FULL);
    const used = new Set(room.seats.filter((s) => s && s.isBot).map((s) => s.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) || `AI·${idx + 1}`;
    let playerId;
    do playerId = 'ai_' + randomBytes(4).toString('hex'); while (room.seatOf(playerId));
    room.seats[idx] = { seat: idx, playerId, name, isBot: true, ready: true, connected: true, left: false };
    this.broadcastState(room);
    return OK;
  }

  removeBot(session, { seat }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    this.dropReplay(room, session.playerId);
    const target = room.seats[seat];
    if (!target || !target.isBot) return fail(ERR.BAD_TARGET, 'seat does not hold an AI');
    room.seats[seat] = null;
    this.broadcastState(room);
    return OK;
  }

  /** Host removes another human before the match (header: room.kick). */
  kick(session, { seat, playerId }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    this.dropReplay(room, session.playerId);
    const target = room.seats[seat];
    if (!target || target.left) return fail(ERR.BAD_TARGET, 'seat holds no player');
    if (target.playerId !== playerId) return fail(ERR.BAD_TARGET, 'seat changed hands'); // the confirmed player left meanwhile
    if (target.isBot) return fail(ERR.BAD_TARGET, 'seat holds an AI (room.removeBot)');
    if (target.playerId === session.playerId) return fail(ERR.BAD_TARGET, 'cannot kick yourself');
    const kicked = this.registry.byId(target.playerId);
    const wasHere = !!kicked && kicked.roomCode === room.code;
    const replay = this.replayFor(room, target.playerId);
    this.removeMember(room, target.playerId);
    if (wasHere) {
      if (kicked.connected) sendSession(kicked, { t: 'room.closed', reason: 'kicked' });
      else { kicked.notice = 'kicked'; kicked.pendingResult = replay; }
    }
    this.log.info(`[lobby] ${room.code} ${target.name} removed by the host`);
    return OK;
  }

  start(session) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    const humans = room.activeHumans();
    for (const s of humans) {
      if (s.playerId !== room.hostId && (!s.connected || !s.ready)) return fail(ERR.NOT_READY);
    }
    const bots = room.seats.filter((s) => s && s.isBot);
    if (humans.length < 1 || (room.mode === 'solo' && (humans.length !== 1 || bots.length > 0))) {
      return fail(ERR.BAD_MSG, 'invalid seat configuration');
    }
    const key = session.limitKey || null;
    if (key && this.opts.maxMatchesPerAddr > 0 && this.countRooms((r) => !!r.match && r.matchKey === key) >= this.opts.maxMatchesPerAddr) {
      this.limitWarn(`match limit (${this.opts.maxMatchesPerAddr}) reached for ${session.addr}`);
      return fail(ERR.RATE, 'too many running matches from your network');
    }
    return this.startMatch(room, key);
  }

  /**
   * room.loadout (DESIGN §16): check the operator loadout against the game data, store it on the session and the seat,
   * and — while a match runs — hand it to the match (accepted only during INFO_CHECK, see the header).
   */
  loadout(session, { entries }) {
    const data = this.safeData();
    const res = checkLoadout(entries, (id) => lookup('chess', id, data));
    if (!res || res.error) return fail(res && isErrCode(res.error) ? res.error : ERR.BAD_MSG, res && res.detail);
    const loadout = freezeLoadout(res.loadout);
    session.loadout = loadout;
    const room = this.roomOf(session);
    if (!room) return OK;
    const seat = room.seatOf(session.playerId);
    if (seat) seat.loadout = loadout;
    if (!room.match || !seat) return OK; // a spectator's loadout stays on its session, never reaching the match
    if (typeof room.match.setLoadout !== 'function') return fail(ERR.ROOM_STARTED, 'stored for the next match');
    let r;
    try {
      r = room.match.setLoadout(session.playerId, loadout);
    } catch (e) {
      this.log.error(`[lobby] ${room.code} match.setLoadout threw`, e);
      return fail(ERR.INTERNAL);
    }
    if (r && typeof r === 'object' && r.error) {
      return fail(isErrCode(r.error) ? r.error : ERR.INTERNAL, typeof r.detail === 'string' ? r.detail : undefined);
    }
    return OK;
  }

  /**
   * room.ownership (0.2.0 补位): keep the droppable chess of the not-owned list, store it on the session and the seat
   * (see the header). A running match never takes it: it keeps the list its seat had at its start.
   */
  ownership(session, { notOwned }) {
    const data = this.safeData();
    const res = checkNotOwned(notOwned, (id) => lookup('chess', id, data));
    if (!res || res.error) return fail(ERR.BAD_MSG, res && res.detail);
    const list = Object.freeze(res.notOwned.slice());
    session.notOwned = list;
    const room = this.roomOf(session);
    if (!room) return OK;
    const seat = room.seatOf(session.playerId);
    if (seat) seat.notOwned = list;
    if (room.match && seat) return fail(ERR.ROOM_STARTED, 'stored for the next match');
    return OK;
  }

  /**
   * room.diy (0.2.0 自选编队): keep the legal picks (checkDiyPicks against the data and KITTED_CHARS), store them on the
   * session and the seat (see the header). A running match never takes them: it keeps the picks its seat had at its
   * start.
   */
  diy(session, { picks }) {
    const res = checkDiyPicks(picks, { data: this.safeData(), kitted: KITTED_CHARS });
    if (!res || !('ok' in res)) return fail(ERR.BAD_MSG, res && res.detail);
    const kept = freezeDiy(res.picks);
    session.diy = kept;
    const room = this.roomOf(session);
    if (!room) return OK;
    const seat = room.seatOf(session.playerId);
    if (seat) seat.diy = kept;
    if (room.match && seat) return fail(ERR.ROOM_STARTED, 'stored for the next match');
    return OK;
  }

  /** Extra fields of every `welcome` (net.js): the operators a 自选 slot may field (shared/diy.js `kitted`). */
  welcomeInfo() {
    return { diyKitted: KITTED_CHARS };
  }

  /**
   * room.skins (docs/SKINS.md): store the player's chosen operator skins on the session and the seat, and — while a match
   * runs — hand them to the match (any phase: a skin is cosmetic, see `Match.setSkins`). The payload's shape is already
   * checked by `shared/protocol.js` (SKIN_LIMITS / isSkinSelection / isSkinId), and `PlayerState.setSkins` re-checks the
   * records against the data, so nothing is validated here (0.1.4.1's `lobby.skins` did the same).
   * 🔁 2026-10-08（第 54 轮 A）：换基座到 0.2.1 时整段被静默丢掉（冷备 `lobby.js:1037-1060`）⇒ 已按冷备份接回。
   */
  skins(session, { skins } = {}) {
    const frozen = freezeSkins(skins);
    session.skins = frozen;
    const room = this.roomOf(session);
    if (!room) return OK;
    const seat = room.seatOf(session.playerId);
    if (seat) seat.skins = frozen;
    if (!room.match || !seat) return OK; // a spectator's skins stay on its session, never reaching the match
    if (typeof room.match.setSkins !== 'function') return fail(ERR.ROOM_STARTED, 'stored for the next match');
    let r;
    try {
      r = room.match.setSkins(session.playerId, frozen);
    } catch (e) {
      this.log.error(`[lobby] ${room.code} match.setSkins threw`, e);
      return fail(ERR.INTERNAL);
    }
    if (r && typeof r === 'object' && r.error) {
      return fail(isErrCode(r.error) ? r.error : ERR.INTERNAL, typeof r.detail === 'string' ? r.detail : undefined);
    }
    return OK;
  }

  // ---------------------------------------------------------------------------------------------------
  // Match wiring
  // ---------------------------------------------------------------------------------------------------

  /** @param {Room} room @param {string | null} [key] per-network limit key of the starter */
  startMatch(room, key = null) {
    const host = room.seatOf(room.hostId);
    if (host) host.ready = true;
    const seats = room.seats.filter(Boolean).map((s) => ({
      seat: s.seat, playerId: s.playerId, name: s.name, isBot: s.isBot, connected: s.connected,
      // DESIGN §16: the human's checked operator loadout (bots fight with the defaults)
      loadout: s.isBot ? null : s.loadout || null,
      // 🆕 干员皮肤 (docs/SKINS.md): the human's chosen skins (bots wear the default model) —— 换基座时丢掉的字段。
      skins: s.isBot ? null : s.skins || null,
      // 0.2.0 补位: the chess the human marked as not owned (bots own every operator)
      notOwned: s.isBot ? null : s.notOwned || null,
      // 0.2.0 自选编队: the human's checked DIY picks (bots field no 自选 piece [ASSUMED])
      diy: s.isBot ? null : s.diy || null,
    }));
    // lastPublic / results: the latest m.public broadcast and the m.result frames (encoded), kept for the replay.
    const ctx = { live: true, ended: false, disposed: false, match: null, lastPublic: null, sharedResult: null, results: new Map() };
    let seed = 0;
    try { seed = this.seedFn() >>> 0; } catch { seed = randomInt(2 ** 32); }
    try {
      const match = new this.MatchClass({
        roomCode: room.code,
        mode: room.mode,
        difficulty: room.difficulty,
        modeId: modeIdFor(room.mode, room.difficulty),
        seats,
        // the spectator seats (header): watched like eliminated players, never players
        spectators: room.spectators.map((s) => s.playerId),
        seed,
        // the room's match number: with the seed it keeps battleIds unique across the room's matches (DESIGN §14)
        matchNo: room.matchCount + 1,
        data: this.safeData(),
        log: this.log,
        now: this.now,
        send: (playerId, msg) => (ctx.live ? this.matchSend(room, ctx, playerId, msg) : false),
        broadcast: (msg) => { if (ctx.live) this.matchBroadcast(room, ctx, msg); },
        onEnd: (summary) => this.onMatchEnd(room, ctx, summary),
      });
      ctx.match = match;
      room.match = match;
      room.matchCtx = ctx;
      room.matchKey = key;
      room.replay = null;
      // 已开局 ⇒ 野排的"到期补齐"不再适用（也绝不能往对局里塞 AI）
      this.clearMatchmakeTimer(room);
      room.matchCount++;
      this.log.info(`[lobby] ${room.code} match #${room.matchCount} starting (${room.mode}/${room.difficulty}, ${seats.length} seats, seed ${seed})`);
      this.broadcastState(room);
      match.start();
    } catch (e) {
      this.log.error(`[lobby] ${room.code} match failed to start`, e);
      if (room.matchCtx === ctx) { room.match = null; room.matchCtx = null; room.matchKey = null; }
      this.disposeMatchCtx(ctx);
      this.broadcastState(room);
      return fail(ERR.INTERNAL, 'match failed to start');
    }
    return OK;
  }

  /** onEnd callback: return the room to LOBBY and dispose the match on the next macrotask. */
  onMatchEnd(room, ctx, summary) {
    if (ctx.ended || !ctx.live || room.matchCtx !== ctx || room.disposed) return;
    ctx.ended = true;
    room.lastSummary = summary ?? null;
    room.match = null;
    room.matchCtx = null;
    room.matchKey = null;
    room.replay = this.buildReplay(room, ctx);
    setImmediate(() => this.disposeMatchCtx(ctx));
    this.log.info(`[lobby] ${room.code} match #${room.matchCount} ended`);
    for (let i = 0; i < room.seats.length; i++) {
      const s = room.seats[i];
      if (!s || s.isBot) continue;
      if (s.left) { room.seats[i] = null; continue; }
      s.ready = false;
      if (!s.connected) this.startGrace(room, s);
    }
    for (const s of room.spectators) if (!s.connected) this.startGrace(room, s);
    const host = room.hostId ? room.seatOf(room.hostId) : null;
    if (!host || host.isBot || host.left) this.migrateHost(room);
    if (room.activeHumans().length === 0) this.disposeRoom(room, 'empty');
    else this.broadcastState(room);
  }

  /** Match unicast; m.result frames are also kept for the replay. */
  matchSend(room, ctx, playerId, msg) {
    if (msg && msg.t === 'm.result') {
      const data = encode(msg);
      if (data != null) ctx.results.set(playerId, data);
    }
    return this.sendToPlayer(room, playerId, msg);
  }

  /** Match broadcast; the latest m.public and a broadcast m.result are also kept for the replay. */
  matchBroadcast(room, ctx, msg) {
    const data = this.broadcastRoom(room, msg);
    if (data == null) return;
    if (msg.t === 'm.public') ctx.lastPublic = data;
    else if (msg.t === 'm.result') ctx.sharedResult = data;
  }

  /**
   * Replay record for the humans still seated when a match ends (null when the match produced no m.result,
   * e.g. it was abandoned: those clients then see "simulation closed").
   * @param {Room} room @returns {Room['replay']}
   */
  buildReplay(room, ctx) {
    const frames = new Map();
    for (const s of [...room.seats, ...room.spectators]) {
      if (!s || s.isBot || s.left) continue;
      const frame = ctx.results.get(s.playerId) || ctx.sharedResult;
      if (frame) frames.set(s.playerId, frame);
    }
    if (frames.size === 0) return null;
    return { publicFrame: ctx.lastPublic, frames, pending: new Set(frames.keys()) };
  }

  /** The replay frames still owed to a player (null when they moved on). @returns {string[] | null} */
  replayFor(room, playerId) {
    const r = room.replay;
    if (!r || !r.pending.has(playerId)) return null;
    return [r.publicFrame, r.frames.get(playerId)].filter(Boolean);
  }

  /** The player moved on from the result screen (acted in the room, left): stop replaying it. */
  dropReplay(room, playerId) {
    const r = room.replay;
    if (!r || !r.pending.delete(playerId)) return;
    r.frames.delete(playerId);
    if (r.pending.size === 0) room.replay = null;
  }

  /**
   * The heavy part of a resync — full match state (match.onReconnect) or, back in LOBBY, the result replay.
   * Immediate after a (re)connect; for repeated hellos on a live socket at most once per resyncMinGapMs
   * (requests inside the window coalesce into one deferred resync).
   * @param {import('./net.js').Session} session @param {boolean} coalesce
   */
  resync(session, coalesce) {
    const pid = session.playerId;
    if (coalesce) {
      if (this.resyncTimers.has(pid)) return; // the scheduled resync answers this request too
      const wait = (Number.isFinite(session.resyncAt) ? session.resyncAt : -Infinity) + this.opts.resyncMinGapMs - this.now();
      if (wait > 0) {
        const t = setTimeout(() => { this.resyncTimers.delete(pid); this.runResync(session); }, wait);
        t.unref?.();
        this.resyncTimers.set(pid, t);
        return;
      }
    } else {
      this.clearResync(pid);
    }
    this.runResync(session);
  }

  /** @param {import('./net.js').Session} session */
  runResync(session) {
    if (!session.connected || this.registry.byId(session.playerId) !== session) return;
    const room = this.roomOf(session);
    if (!room) return;
    session.resyncAt = this.now();
    if (room.match) {
      this.callMatch(room, room.spectatorOf(session.playerId) ? 'addSpectator' : 'onReconnect', session.playerId);
      return;
    }
    const frames = this.replayFor(room, session.playerId);
    if (frames) for (const frame of frames) sendRaw(session.ws, frame);
  }

  clearResync(playerId) {
    const t = this.resyncTimers.get(playerId);
    if (t) { clearTimeout(t); this.resyncTimers.delete(playerId); }
  }

  /** Log a per-network limit refusal without letting a refusal loop flood the log. */
  limitWarn(text) {
    const now = this.now();
    if (now - this.limitLog.at < 10_000) { this.limitLog.suppressed++; return; }
    const more = this.limitLog.suppressed ? ` (+${this.limitLog.suppressed} similar refusals)` : '';
    this.limitLog.at = now;
    this.limitLog.suppressed = 0;
    this.log.warn(`[lobby] ${text}${more}`);
  }

  /** Number of rooms matching a predicate. */
  countRooms(pred) {
    let n = 0;
    for (const r of this.rooms.values()) if (pred(r)) n++;
    return n;
  }

  /** Route a 'g.*' intent to the running match. */
  routeGame(session, msg) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (!room.match) return fail(ERR.WRONG_PHASE, 'no running match');
    if (msg.t === 'g.leave') {
      this.removeMember(room, session.playerId);
      return OK;
    }
    // a spectator only watches (header): nothing else of it ever reaches the match
    if (msg.t !== 'g.watch' && room.spectatorOf(session.playerId)) return fail(ERR.SPECTATOR);
    let res;
    try {
      res = room.match.handle(session.playerId, msg);
    } catch (e) {
      this.log.error(`[lobby] ${room.code} match.handle(${msg.t}) threw`, e);
      return fail(ERR.INTERNAL);
    }
    if (res && typeof res.then === 'function') {
      // Contract violation (handle must be synchronous): never let the rejection go unhandled.
      this.log.error(`[lobby] ${room.code} match.handle(${msg.t}) returned a Promise; it must be synchronous`);
      Promise.resolve(res).catch((e) => this.log.error(`[lobby] ${room.code} match.handle(${msg.t}) rejected`, e));
      return OK;
    }
    if (res && typeof res === 'object' && res.error) {
      return fail(isErrCode(res.error) ? res.error : ERR.INTERNAL, typeof res.detail === 'string' ? res.detail : undefined);
    }
    return OK;
  }

  /** Call an optional match hook without letting it throw. onLeave falls back to onDisconnect. */
  callMatch(room, method, ...args) {
    const m = room.match;
    if (!m) return undefined;
    let fn = m[method];
    if (typeof fn !== 'function' && method === 'onLeave') fn = m.onDisconnect;
    if (typeof fn !== 'function') return undefined;
    try {
      return fn.apply(m, args);
    } catch (e) {
      this.log.error(`[lobby] ${room.code} match.${method} threw`, e);
      return undefined;
    }
  }

  disposeMatchCtx(ctx) {
    if (ctx.disposed) return;
    ctx.disposed = true;
    ctx.live = false;
    try { ctx.match?.dispose?.(); } catch (e) { this.log.error('[lobby] match.dispose threw', e); }
  }

  safeData() {
    try { return this.getData(); } catch (e) { this.log.error('[lobby] getData failed', e); return Object.freeze({}); }
  }

  /** How long a dropped solo run stays resumable (ms): the option, else data singleReconnectTime, else 24 h. */
  soloResumeWindowMs() {
    const o = this.opts.soloReconnectWindowMs;
    if (typeof o === 'number' && Number.isFinite(o) && o > 0) return o;
    const sec = this.safeData()?.config?.constants?.singleReconnectTime;
    return (typeof sec === 'number' && Number.isFinite(sec) && sec > 0 ? sec : SOLO_RECONNECT_FALLBACK_SEC) * 1000;
  }

  // ---------------------------------------------------------------------------------------------------
  // Membership helpers
  // ---------------------------------------------------------------------------------------------------

  /** The session's current room (self-heals stale `roomCode`). @returns {Room | null} */
  roomOf(session) {
    if (!session.roomCode) return null;
    const room = this.rooms.get(session.roomCode);
    const seat = room ? room.seatOf(session.playerId) : null;
    if (room && !seat && room.spectatorOf(session.playerId)) return room; // a spectator seat
    if (!room || !seat || seat.left || seat.isBot) { session.roomCode = null; return null; }
    return room;
  }

  /** @returns {Seat} */
  humanSeat(idx, session) {
    return {
      seat: idx, playerId: session.playerId, name: session.name, avatarId: session.avatarId || '',   // 🆕 W-6
      isBot: false, ready: false, connected: session.connected, left: false,
      loadout: session.loadout || null,
      notOwned: session.notOwned || null,
      diy: session.diy || null,
    };
  }

  /**
   * Remove a human from a room permanently (leave, grace timeout, expiry, switching rooms).
   * In LOBBY the seat is freed; during a match it is marked departed and match.onLeave is called.
   * @param {Room} room @param {string} playerId
   */
  removeMember(room, playerId) {
    const session = this.registry.byId(playerId);
    if (session && session.roomCode === room.code) session.roomCode = null;
    this.clearGrace(playerId);
    this.dropReplay(room, playerId);
    if (this.freeSpectatorSeat(room, playerId)) return;
    const seat = room.seatOf(playerId);
    if (!seat || seat.isBot || seat.left || room.disposed) return;
    if (room.match) {
      seat.left = true;
      seat.connected = false;
      seat.ready = false;
      this.callMatch(room, 'onLeave', playerId);
    } else {
      room.seats[seat.seat] = null;
    }
    if (room.disposed) return; // onLeave may have ended the match and emptied the room
    // 走人后可能不再合格（例如最后一位在线真人）⇒ 立刻取消/重算野排计时器
    this.syncMatchmakeTimer(room);
    if (room.hostId === playerId) this.migrateHost(room);
    if (room.activeHumans().length === 0) this.disposeRoom(room, 'empty');
    else this.broadcastState(room);
  }

  /**
   * Free a spectator seat (removeMember): the match forgets the spectator; never a host change or a disposal — a
   * spectator neither holds the host nor keeps a room alive. @returns {boolean} true when it was a spectator seat
   */
  freeSpectatorSeat(room, playerId) {
    const i = room.spectators.findIndex((s) => s.playerId === playerId);
    if (i < 0) return false;
    room.spectators.splice(i, 1);
    if (room.disposed) return true;
    this.callMatch(room, 'removeSpectator', playerId);
    this.broadcastState(room);
    return true;
  }

  /** Lowest-seat connected human becomes host (else lowest-seat human, else null). */
  migrateHost(room) {
    const humans = room.activeHumans();
    const pick = humans.find((s) => s.connected) || humans[0] || null;
    const prev = room.hostId;
    room.hostId = pick ? pick.playerId : null;
    // **休眠房的唤醒账号 = 最后那位房主**（判据 `test/lobby-room-retention.test.js` ⑥）：
    // 换房主 ⇒ 跟上新的；房**彻底空了**（`pick` 为 null，`prev` 就是最后那位）⇒ **留住他**（别清成 null，
    // 否则 `dormantOnDispose` 认不到人、空房就不能转休眠了）。
    room.ownerId = pick ? pick.playerId : (prev || room.ownerId);
    if (pick && prev !== pick.playerId) this.log.info(`[lobby] ${room.code} host → ${pick.name}`);
  }

  startGrace(room, seat) {
    const playerId = seat.playerId;
    this.clearGrace(playerId);
    const t = setTimeout(() => {
      this.graceTimers.delete(playerId);
      if (room.disposed || room.match) return;
      const s = room.seatOf(playerId) || room.spectatorOf(playerId);
      if (!s || s.connected) return;
      const session = this.registry.byId(playerId);
      if (session && session.roomCode === room.code) {
        session.notice = 'timeout';
        session.pendingResult = this.replayFor(room, playerId); // still shown after room.closed on resume
      }
      this.removeMember(room, playerId);
    }, this.opts.lobbyGraceMs);
    t.unref?.();
    this.graceTimers.set(playerId, t);
  }

  clearGrace(playerId) {
    const t = this.graceTimers.get(playerId);
    if (t) { clearTimeout(t); this.graceTimers.delete(playerId); }
  }

  /**
   * Delete a room, detach its members (room.closed unless the room simply emptied) and dispose its match.
   * @param {Room} room @param {string} reason
   */
  disposeRoom(room, reason) {
    if (room.disposed) return;
    room.disposed = true;
    // 房间没了 ⇒ 野排计时器必须一起走（否则漏掉的计时器会吊住 `node --test` 不让它退出）
    this.clearMatchmakeTimer(room);
    // **空房保留**：算好"要不要转休眠"再摘表（要看 room.hostId / room.ownerId / room.chat）。
    // ⚠️ 只认 `reason === 'empty'` —— 关停等其余路径一律照旧立刻销毁。
    const dormant = this.dormantOnDispose(room, reason);
    if (this.rooms.get(room.code) === room) this.rooms.delete(room.code);
    if (dormant) {
      room.dormantAt = this.now();
      this.armRetentionTimer(dormant);   // 登记进休眠表 + 武装保留期（unref）
    }
    const ctx = room.matchCtx;
    room.match = null;
    room.matchCtx = null;
    room.matchKey = null;
    room.replay = null;
    for (const s of room.seats) {
      if (!s || s.isBot) continue;
      this.clearGrace(s.playerId);
      const session = this.registry.byId(s.playerId);
      if (!session || session.roomCode !== room.code) continue;
      session.roomCode = null;
      if (s.left || reason === 'empty') continue;
      if (session.connected) sendSession(session, { t: 'room.closed', reason });
      else session.notice = reason;
    }
    // spectators did not leave: they are told whatever closed the room (its last human leaving included)
    for (const s of room.spectators) {
      this.clearGrace(s.playerId);
      const session = this.registry.byId(s.playerId);
      if (!session || session.roomCode !== room.code) continue;
      session.roomCode = null;
      if (session.connected) sendSession(session, { t: 'room.closed', reason });
      else session.notice = reason;
    }
    if (ctx) this.disposeMatchCtx(ctx);
    this.log.info(`[lobby] ${room.code} disposed (${reason})`);
  }

  genCode() {
    for (let attempt = 0; attempt < 1000; attempt++) {
      let code = '';
      for (let i = 0; i < ROOM_CODE_LEN; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      // ⚠️ **休眠表里的房号也要避开** —— 否则新开的房会占掉一个"等着被房主唤醒"的房号，
      //    唤醒时 `takeDormantRoom` 会撞上活房（它会把那条休眠记录丢掉，房主就找不回原房号了）。
      if (!this.rooms.has(code) && !this.dormantRooms.has(code)) return code;
    }
    return null;
  }

  // ---------------------------------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------------------------------

  /** Connected, non-departed human sessions of a room — its spectators included (room.state, match broadcasts). */
  *memberSessions(room) {
    for (const s of [...room.seats, ...room.spectators]) {
      if (!s || s.isBot || s.left) continue;
      const session = this.registry.byId(s.playerId);
      if (session && session.connected && session.roomCode === room.code) yield session;
    }
  }

  broadcastState(room) {
    if (room.disposed) return;
    const data = encode(room.toState());
    for (const session of this.memberSessions(room)) sendRaw(session.ws, data);
  }

  sendState(room, session) {
    sendSession(session, room.toState());
  }

  /**
   * `room.chat { text }` (D-3; 用户 2026-10-07 07:0x 逐字拍板 —— 「对局中放个聊天的面板…观战者不可发言（战斗中死了而
   * 观战的可以），重进房间要看到」): 清洗 + 按码点截断后**广播给同房所有人（含观战席）**为 `chat.msg`，并把这一条
   * 放进房间的内存环形缓冲（供下次 resync 的 `chat.history`）。
   *
   * 权限：**"是否曾占过座位"** —— `roomOf` 只认玩家座位或观战席，且玩家不会原地转观战（`spectate` ⇒ ALREADY），
   * 所以 `room.spectatorOf` 命中的就是**纯观战者**（⇒ SPECTATOR）。战斗中**阵亡**的人**仍占着座位**（Match 只清它
   * 的棋盘），它一边观战一边照常发言 —— 正是用户要的那条。**不新造身份系统**，判据就来自现有座位查找。
   *
   * 频率已由 `server/net.js` 的 `CHAT_TYPES` 令牌桶（1 条/秒、突发 3）在这之前处理（超了直接 ERR.RATE），这里不重复限流。
   * 🔴 本方法不碰 `server/stats.js` / `server/ops.js`：聊天文本**绝不落盘**。
   */
  chat(session, { text }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.spectatorOf(session.playerId)) return fail(ERR.SPECTATOR, 'a spectator seat is read-only');
    // 🆕 2026-10-08 **服务端强制的打字开关**（用户拍板：房主在战斗开始前决定）。
    //    ⚠️ 放在**权限检查之后**：纯观战者在两个原因同时成立时仍拿 SPECTATOR（保持既有判据 ③ 的语义）。
    //    ⚠️ 这道门**与客户端 UI 无关** —— 绕过 UI 直接发 room.chat 一样被拒（判据里有这条负对照）。
    if (room.quickOnly) return fail(ERR.CHAT_OFF, 'text chat is off in this room');
    const clean = sanitizeChat(text);
    if (!clean) return fail(ERR.BAD_MSG, 'bad field text');
    const at = this.now();
    const name = session.name; // 当前昵称（每次 hello 都会刷新；对局中改名也以它为准）
    room.addChat({ from: session.playerId, name, text: clean, at });
    this.broadcastRoom(room, { t: 'chat.msg', from: session.playerId, name, text: clean, at });
    return OK;
  }

  /**
   * 🆕 2026-10-08 `room.quick { on }` —— **房主的打字开关**（用户 2026-10-08 拍板：「房主确认在战斗开始前要不要开启
   * 打字功能，其余人在开启打字功能后可以选择"屏蔽指定的人"」）。
   *
   * * **只有房主**能改（非房主 NOT_HOST，与 room.setDifficulty 同族）；
   * * **只在对局开始前**能改（对局中 WRONG_PHASE —— 用户那句「战斗开始前」是硬口径）；
   * * **幂等**（设成同一个值也回 OK）；改完广播一份 room.state，让所有人的输入框一起变。
   * * "屏蔽指定的人"是**纯客户端**的事（各人自己的显示过滤，服务端不存"谁屏蔽了谁"）⇒ 这里没有对应消息。
   */
  quick(session, { on }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.WRONG_PHASE, "the typing switch is decided before the battle starts");
    room.quickOnly = on === true;
    // ⚠️ 必须用 `broadcastState(room)`（照 setDifficulty 的榜样）：它内部是 `encode(room.toState())` + `sendRaw`。
    //    我第一版写的是 `broadcastRoom(room, room.toState())` —— 那等于把**已 toState 的对象**再 encode 一次，
    //    拿到 null 就**静默不发**（判据里实测：房主自己也收不到；而同一个 broadcastRoom 送 quick.msg 是通的）。
    this.broadcastState(room);
    return OK;
  }

  /**
   * 🆕 2026-10-09 W-6 `room.avatar { id }` —— 玩家挑的头像（**只传 id**；空串 = 清掉，回默认字形）。
   *
   * * **真表校验**：id 必须在 `public/assets/avatar/manifest.json` 里（形状已由 `shared/protocol.js isAvatarId` 挡过，
   *   那一层已排除 URL / 路径 / 带扩展名的文件名）；不在表里 ⇒ `BAD_MSG`。
   * * **公开**：写进 session，随 `room.state` 的座位/观战席广播（别人的名片要画它）—— 与 `name` 同族，**不新造 S2C 帧**。
   * * **任意相位**：头像与玩法无关（与 `room.skins` 同族口径）。
   * * 🔴 **绝不落盘**（只活在 session / room.state 里）。
   */
  avatar(session, { id }) {
    const known = this.avatarIds();
    const want = typeof id === 'string' ? id : '';
    if (want && !known.has(want)) return fail(ERR.BAD_MSG, 'unknown avatar id');
    session.avatarId = want;
    const room = this.roomOf(session);
    if (room) {
      const seat = room.seatOf(session.playerId);
      if (seat) seat.avatarId = want;
      const spec = room.spectatorOf(session.playerId);
      if (spec) spec.avatarId = want;
      this.broadcastState(room);
    }
    return OK;
  }

  /**
   * 🆕 2026-10-09 W-6 本部署的头像真表（`public/assets/avatar/manifest.json` 的 id 集合）。
   * ⚠️ 读一次后按 mtime 缓存；**读不到就返回空集** ⇒ 所有 id 都被拒（宁可拒绝，也不放行未审素材 ——
   *   与快捷短语表没落地就一律拒同一条取舍）。
   */
  avatarIds() {
    const file = path.join(this.opts.publicDir || path.join(REPO_ROOT, 'public'), 'assets', 'avatar', 'manifest.json');
    try {
      const st = fs.statSync(file);
      if (this._avatarCache && this._avatarCache.mtime === st.mtimeMs) return this._avatarCache.ids;
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      const ids = new Set((Array.isArray(j.avatars) ? j.avatars : []).map((a) => a && a.id).filter((x) => typeof x === 'string'));
      this._avatarCache = { mtime: st.mtimeMs, ids };
      return ids;
    } catch (e) {
      if (this.log && this.log.warn) this.log.warn(`[lobby] avatar manifest unreadable: ${e && e.message}`);
      return new Set();
    }
  }

  /**
   * 🆕 2026-10-08 `room.quickMsg { id }` —— 发一条**白名单短语**（快捷聊天）。开关管的是"打字"，
   * 关掉之后大家仍要用短语交流 ⇒ 这条路**不受 quickOnly 限制**。
   *
   * * `id` 的形状由 `shared/protocol.js isQuickId` 挡（逗号分隔、最多 3 个、每个 1–32 位 [a-z0-9_]）；
   * * **白名单**在这里查（`config.quickPhrases`，data 工具线维护）—— 未知 id 一律 BAD_MSG，
   *   所以客户端**伪造不出新短语**（与打字开关同一层防线）；
   * * 权限与打字相同：**纯观战者**被拒（SPECTATOR）；频率走 net.js 的 CHAT_TYPES 小桶（1/s，突发 3）；
   * * 🔴 短语文本**绝不落盘**（与 chat 同规矩：不碰 server/stats.js / server/ops.js）。
   */
  quickMsg(session, { id, arg }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.spectatorOf(session.playerId)) return fail(ERR.SPECTATOR, "a spectator seat is read-only");
    const ids = String(id).split(",");
    const known = this.quickPhraseIds();
    for (const one of ids) if (!known.has(one)) return fail(ERR.BAD_MSG, "unknown quick phrase");
    // 🆕 2026-10-08 带参句式（playing/need/thanks/careful）：`arg` 是**一个短串**，形状已由
    //   `shared/protocol.js isQuickArg` 挡过；这里再 trim 一次，空串就当没带（无参句式照常）。
    const rawArg = typeof arg === "string" ? arg.trim() : "";
    // 🔴 **arg 必须与 id 一起校验**（B12 提醒 1）：形状已由 `shared/protocol.js isQuickArg` 挡过，
    //   这里按**这条 id 是哪一类**再查一次"值真的存在吗"（见 quickArgOk；`careful` 那类不假装校验）。
    if (rawArg && !this.quickArgOk(session, ids, rawArg)) return fail(ERR.BAD_MSG, "bad quick phrase argument");
    const at = this.now();
    const name = session.name;
    this.broadcastRoom(room, { t: "quick.msg", from: session.playerId, name, ids, at,
      ...(rawArg ? { arg: rawArg } : {}) });
    return OK;
  }

  /**
   * 🆕 2026-10-08 快捷短语的**白名单**（服务端唯一真源）。
   * 真源是 `shared/constants.js` 的 `QUICK_IDS`（手写常量表，与 `DIFFICULTIES`/`EMOTE_THEMES` 同族）；
   * **文案不在这里** —— 文本是 `public/i18n/*` 的 msgid，由**接收端**按各自语言渲染（服务端只认 id）。
   * ⚠️ 为什么不是 `data/config.json` 的 `quickPhrases`：那张表是 `tools/build-data.mjs` 从**游戏数据**派生的
   *   **产物**（本仓禁止手改），而短语不是游戏数据 ⇒ 见 `协作/A答C-quickPhrases落地与arg-2026-10-08.md` §2。
   */
  quickPhraseIds() {
    return new Set(QUICK_IDS);
  }

  /**
   * 🆕 2026-10-08 快捷短语的**参数校验**（B12 提醒 1：`arg` 必须与 `id` 一起校验）。
   * 分类口径见 `public/js/ui/chatModel.js` 的 `QUICK_PHRASES[].arg`：
   *   · `playing` ⇒ 盟约 id（`data/bonds.json` 的键）
   *   · `need`    ⇒ 干员 **charId**（`data/chess.json` 记录里的 `charId`；用 charId 而不是 chess id ——
   *                面板显示的是"干员"，而一个干员可能有普通/精锐两条记录，客户端发 charId 更稳）
   *   · `thanks`  ⇒ **本房**的 playerId（座位或观战席；人退了就发不出去 —— 这正是"感谢某人"的本意）
   *   · `careful` ⇒ **不做存在性校验**：本层拿不到可靠的"本局有效敌人集合"，**不假装校验**（宁可放行，也不误杀）
   * @param {import("./net.js").Session} session @param {string[]} ids @param {string} arg
   * @returns {boolean}
   */
  quickArgOk(session, ids, arg) {
    const data = this.safeData() || {};
    const room = this.roomOf(session);
    for (const id of ids) {
      if (id === 'playing') {
        if (!data.bonds || !Object.hasOwn(data.bonds, arg)) return false;
      } else if (id === 'need') {
        const chess = data.chess || {};
        let found = false;
        for (const rec of Object.values(chess)) if (rec && rec.charId === arg) { found = true; break; }
        if (!found) return false;
      } else if (id === 'thanks') {
        if (!room) return false;
        const inRoom = room.seats.some((s) => s && s.playerId === arg)
          || room.spectators.some((s) => s && s.playerId === arg);
        if (!inRoom) return false;
      } else if (id === 'careful') {
        // 🆕 2026-10-08（C 派工）：**按真表的存在性校验** —— ⚠️ 必须查**两张表**：
        //   `data/enemies.json`（249 条常规敌人）＋ **`data/bosses.json`**（`boss_1`…`boss_10`）。
        //   🔴 这不是我猜的：③d 那条"正例用真表逐条跑"的判据**当场抓出**我用单表时有 **10/50** 个真实 key 被拒
        //      （全部是 `boss_*`）—— 那正是"只测负例 = 假绿"会漏掉的东西。
        //   为什么用全量而不是"本局集合"：本局集合要按 `data/waves.json[stageId].spawns[].key` 解析（C 已确认），
        //   但服务端这一层拿不到"本局是哪个 stage"而不引入新状态；全量表能挡住伪造 id，且**不误杀**真实 key。
        const knownEnemy = (data.enemies && Object.hasOwn(data.enemies, arg))
          || (data.bosses && Object.hasOwn(data.bosses, arg));
        if (!knownEnemy) return false;
      }
    }
    return true;
  }

  /**
   * 快速匹配（`room.matchmake { difficulty }`，参照 simpfun 的同名消息）：
   * **同难度进/建一间等待房** —— 语义是「同难度自动组队 · 满 MAX_SEATS 人开局」，不做队列/分桶/成局那一套。
   *
   * ⚠️ 本族是**我方独有**的联机功能（上游 0.2.x 没有）；换基座时它整段消失（**静默回退：没有任何闸会红**），
   * 2026-10-07 由第 4 任 D 按新基座重新接线。判据 `test/lobby-matchmake.test.js`（9 条，含"不许把别人的房变成野排房"）。
   * @param {import('./net.js').Session} session
   * @param {{ difficulty: string }} msg
   */
  matchmake(session, { difficulty }) {
    const cur = this.roomOf(session);
    if (cur && cur.match) return fail(ERR.ROOM_STARTED, 'leave your running match first');
    // 连点/重按：已经在同一间同难度的野排房里 ⇒ 幂等，回一次 state 就好（不要把自己从房里挪走）
    if (cur && cur.matchmade && !cur.match && cur.difficulty === difficulty) { this.sendState(cur, session); return OK; }
    const target = this.findMatchmakeRoom(difficulty, cur);
    if (target) {
      // 复用现有 join（座位、host 迁移、广播、session.roomCode 全走同一条路）
      const joined = this.join(session, { code: target.code });
      if (!joined.error) {
        // 落进**普通等待房**（房主手建的那间）时：只置自己的 ready，**不打野排标记、不武装计时器** ——
        // 那间房的开局时机仍归房主，我们的到期补齐不许替别人决定（见 findMatchmakeRoom 的取舍）。
        if (target.matchmade) this.markMatchmade(target, session.playerId);
        else this.markMatchmakeReady(target, session.playerId);
        return OK;
      }
    }
    // 没有可用的等待房（或极端竞态下那一间满了）⇒ 用现有 create 建一间 coop 房
    const created = this.create(session, { mode: 'coop', difficulty });
    if (created.error) return created;
    const room = this.roomOf(session);
    if (room) this.markMatchmade(room, session.playerId);
    return OK;
  }

  /**
   * 野排池里挑一间房：**同难度 + 未开局 + 有在线真人 + 还有空位**的 coop 等待房。找不到返回 null。
   *
   * ▸ **优先 matchmade 房，其次才是普通等待房**：
   *   普通等待房是房主用 `room.create` 建的 —— 很可能**是房主约好的人**（密钥私下发出去，正在等人上线）。
   *   把野排的人直接塞进去会打扰那场约定；而 `matchmade` 房本身就是"谁都能来"的池子。**代价**：池子空的时候
   *   野排玩家仍会被放进一间普通房（否则小池子永远开不了局）—— 所以只在**没有 matchmade 房可加入**时才这么做，
   *   并且**不**给普通房打 matchmade 标记（它的开局时机仍归房主，不会被我们的定时器自动开局）。
   * ▸ 同类之间挑**座位占得最多**的（其次最早建的）：先把一间填满比人手一间更容易成局。
   * ▸ `exclude` = 请求者**当前所在的房**：手建的房不该被自己的"快速匹配"选中（否则按一次按钮就把自己的房
   *   变成了会自动开局、会塞 AI 的野排房）—— 宁可另开一间。
   * @param {string} difficulty
   * @param {Room | null} [exclude]
   * @returns {Room | null}
   */
  findMatchmakeRoom(difficulty, exclude = null) {
    let best = null;
    for (const room of this.rooms.values()) {
      if (room === exclude) continue;
      if (room.disposed || room.match) continue;
      if (room.mode !== 'coop' || room.difficulty !== difficulty) continue;
      if (room.freeSeat() < 0) continue;
      // "有在线真人"：掉线还在 grace 里的座位不算（与 /healthz 的 waitingRooms 同口径）
      if (!room.activeHumans().some((s) => s.connected)) continue;
      if (!best) { best = room; continue; }
      if (!!room.matchmade !== !!best.matchmade) { if (room.matchmade) best = room; continue; }
      const n = room.seats.filter(Boolean).length; const bn = best.seats.filter(Boolean).length;
      if (n > bn || (n === bn && room.createdAt < best.createdAt)) best = room;
    }
    return best;
  }

  /**
   * 把一间房标成野排房并武装补齐计时器。只有 `matchmake` **建出来**的房（或已经是野排房的房）会走到这里
   * （普通等待房只走 markMatchmakeReady，见 findMatchmakeRoom 的取舍）。
   * @param {Room} room @param {string} [playerId]
   */
  markMatchmade(room, playerId) {
    room.matchmade = true;
    this.markMatchmakeReady(room, playerId);
    this.syncMatchmakeTimer(room);
  }

  /**
   * ▸ 按了「快速匹配」就等于**同意开局**（野排的共识：人不齐由 AI 补）⇒ 把这个座位置 ready，
   * 这样既有 `start()` 的 ready 闸门不必为野排开特例，房主手点「开始模拟」也不会被同伴的 ready 挡住。
   * @param {Room} room @param {string} [playerId]
   */
  markMatchmakeReady(room, playerId) {
    const seat = playerId ? room.seatOf(playerId) : null;
    if (seat && !seat.isBot && !seat.ready) { seat.ready = true; this.broadcastState(room); }
  }

  /** 野排池还"活着"吗：未开局 + 有在线真人。计时器的**取消**判据用它（`start`/`dispose` 会让它为假）。 */
  matchmakePoolAlive(room) {
    return !!room && !room.disposed && room.matchmade === true && !room.match && room.mode === 'coop'
      && room.activeHumans().some((s) => s.connected);
  }

  /** 该不该计时：池子活着 **且还有空位**（满座未开局 = 只差人点开局，不必倒计时）。条件不成立 ⇒ 立刻取消。 */
  syncMatchmakeTimer(room) {
    if (!this.matchmakePoolAlive(room) || room.freeSeat() < 0) this.clearMatchmakeTimer(room);
    else this.armMatchmakeTimer(room);
  }

  /** 武装 `matchmakeFillMs` 到期的补齐计时器（已武装则不重置 —— 否则每来一个人就把截止时间推后）。 */
  armMatchmakeTimer(room) {
    if (room.matchmakeTimer) return;
    const ms = this.opts.matchmakeFillMs;
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return; // 关掉到期补齐
    room.matchmakeDeadline = this.now() + ms;
    const t = setTimeout(() => this.fillMatchmade(room), ms);
    // 双保险：即使哪条路径漏了取消，也不让 `node --test` 因为这个计时器挂住不退出（本仓已知的坑）
    t.unref?.();
    room.matchmakeTimer = t;
  }

  /** 取消并清空计时器（start / dispose / 失去资格 / 离开时都必须走这里）。 */
  clearMatchmakeTimer(room) {
    if (!room) return;
    if (room.matchmakeTimer) { clearTimeout(room.matchmakeTimer); room.matchmakeTimer = null; }
    room.matchmakeDeadline = null;
  }

  /**
   * 到期：**用现有 `addBot` 补满空位，再走现有 `start`** 开局（不为野排另写一套座位/开局逻辑）。
   * 条件在到期时会**重新判一遍**（这期间房间可能已开局、已空、或人已掉线）。
   * @param {Room} room
   */
  fillMatchmade(room) {
    room.matchmakeTimer = null;
    room.matchmakeDeadline = null;
    if (room.disposed || room.match) return;                       // 已 dispose / 已开局 ⇒ 什么都不做
    const humans = room.activeHumans();
    if (humans.length === 0) return;                               // 没有人（房间随后会被回收）
    if (!humans.some((s) => s.connected)) return;                   // 没有在线真人 ⇒ 不打扰，等有人回来再算
    const host = this.registry.byId(room.hostId);                   // addBot/start 都要一个 session（host 即可）
    if (!host) { this.log.warn(`[lobby] ${room.code} matchmake fill skipped: no host session`); return; }
    let filled = 0;
    while (!room.match && room.freeSeat() >= 0) {
      const r = this.addBot(host);
      if (r && r.error) break;
      filled++;
    }
    // 野排共识"人不齐由 AI 补、补满就开"：在线的真人置 ready，再走既有 start（不动 start 的语义）
    for (const s of room.activeHumans()) if (s.connected) s.ready = true;
    this.log.info(`[lobby] ${room.code} matchmake deadline: +${filled} AI, starting`);
    const started = this.start(host);
    if (started && started.error) {
      this.log.warn(`[lobby] ${room.code} matchmake start failed (${started.error}${started.detail ? `: ${started.detail}` : ''})`);
      // 例如有人正掉线在 grace 里（start 的 ready/connected 闸门过不去）⇒ 条件好了再补一次
      if (this.matchmakePoolAlive(room)) this.armMatchmakeTimer(room);
    }
  }

  // ---------------------------------------------------------------------------------------------------
  // 空房保留（休眠表）—— 第 3 任 D 的 D-3 第二批；换基座后重新接线（判据 test/lobby-room-retention.test.js）
  // ---------------------------------------------------------------------------------------------------

  /** 保留期（ms）：`roomRetentionMs`，非法/≤0 ⇒ 0（= 不保留，空房立刻销毁）。 */
  retentionMs() {
    const ms = this.opts.roomRetentionMs;
    return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : 0;
  }

  /** 休眠表上限（间）；≤0 / 非有限值 ⇒ Infinity = 不限。 */
  dormantCap() {
    const n = this.opts.maxDormantRooms;
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : Infinity;
  }

  /**
   * 这次销毁要不要改成"转休眠"？—— 只有**空房**（`reason === 'empty'`）+ 配置了保留期 + 有唤醒账号才转；
   * **关停**（`'shutdown'`）等其余路径一律照旧立刻销毁。
   * @param {Room} room @param {string} reason
   * @returns {{ code: string, ownerId: string, chat: any[], createdAt: number, timer: null } | null}
   */
  dormantOnDispose(room, reason) {
    if (reason !== 'empty') return null;
    if (this.retentionMs() <= 0) return null;
    // 走到这里 `hostId` 通常已被 migrateHost 清空（房空了）⇒ 落到 `Room.ownerId` = **最后那位房主**。
    // ⚠️ `ownerId` 是我们在 Room 上**自己维护**的字段（不是 ownerKey —— 那是"网络来源"的哈希，不是账号）。
    const ownerId = room.hostId || room.ownerId;
    if (!ownerId) return null;
    if (this.dormantRooms.has(room.code)) this.dropDormantRoom(room.code); // 同码旧记录（不该出现）⇒ 先清掉
    return { code: room.code, ownerId, chat: room.chat, createdAt: room.createdAt, timer: null,
      quickOnly: !!room.quickOnly };   // 🆕 2026-10-08 打字开关随房休眠/复活一起带
  }

  /**
   * 武装保留期定时器并登记进休眠表。**必须 `unref()`**（不许把进程挂住）；
   * 到期 ⇒ 删记录 + **清空聊天记录**（清的是与 `Room.chat` 同一个数组）。
   * @param {{ code: string, ownerId: string, chat: any[], createdAt: number, timer: NodeJS.Timeout | null }} entry
   */
  armRetentionTimer(entry) {
    const ms = this.retentionMs();
    const t = setTimeout(() => {
      entry.timer = null;
      if (this.dormantRooms.get(entry.code) !== entry) return; // 已被唤醒 / 已被关停清掉
      this.dormantRooms.delete(entry.code);
      entry.chat.length = 0;
      this.log.info(`[lobby] ${entry.code} dormancy expired (kept ${ms} ms) — room and chat dropped`);
    }, ms);
    t.unref?.(); // 双保险：即使哪条路径漏了取消，也不让 `node --test` 因为这个计时器挂住不退出
    entry.timer = t;
    this.dormantRooms.set(entry.code, entry);
    this.enforceDormantCap();
  }

  /**
   * 休眠表**硬上限**：超了按 **FIFO** 淘汰**最早进入休眠**的那间 —— `Map` 的迭代顺序就是"转休眠的时刻顺序"，
   * 与 `createdAt`（开房时刻）无关。淘汰 = 取消它的保留期定时器 + **清空它的聊天记录**（`dropDormantRoom`）。
   * 被淘汰的房号之后可以被 `genCode` 重新发出去（它已不是休眠房）。
   */
  enforceDormantCap() {
    const cap = this.dormantCap();
    while (this.dormantRooms.size > cap) {
      const oldest = this.dormantRooms.keys().next().value; // FIFO：最早转休眠的那间
      this.log.warn(`[lobby] dormant rooms over the cap (${cap}) — dropping the oldest, ${oldest}`);
      this.dropDormantRoom(oldest);
    }
  }

  /** 删掉一间休眠房（超时 / 关停 / 被唤醒）：取消定时器 + **清空聊天记录**。 */
  dropDormantRoom(code) {
    const e = this.dormantRooms.get(code);
    if (!e) return;
    this.dormantRooms.delete(code);
    if (e.timer) { clearTimeout(e.timer); e.timer = null; }
    e.chat.length = 0;
  }

  /**
   * 唤醒：取走这个账号名下的休眠房（**只有房主账号**命中）。命中的记录会被**消费掉**
   * （`clearTimeout` + 出表），房号与聊天记录交给 `create` 复用。
   * ▸ 一个账号名下最多只有一间（开房是唯一入口，且开房必先消费掉旧的）；真出现多间时取**最早建**的那间。
   * @param {string} playerId
   * @returns {{ code: string, ownerId: string, chat: any[], createdAt: number, timer: null } | null}
   */
  takeDormantRoom(playerId) {
    let found = null;
    for (const e of this.dormantRooms.values()) {
      if (e.ownerId !== playerId) continue;
      if (!found || e.createdAt < found.createdAt) found = e;
    }
    if (!found) return null;
    this.dormantRooms.delete(found.code);
    if (found.timer) { clearTimeout(found.timer); found.timer = null; } // 唤醒 ⇒ 保留期作废
    if (this.rooms.has(found.code)) {
      // 极端情况：这个房号已被别人新开的房占了（`genCode` 会避开休眠表，所以不该发生）⇒ 不能唤醒，改开新房
      this.log.warn(`[lobby] dormant ${found.code} collides with a live room — dropped instead of revived`);
      found.chat.length = 0;
      return null;
    }
    this.log.info(`[lobby] ${found.code} revived by its host account`);
    return found;
  }

  /** Match broadcast: encode once, send to every connected member. @returns {string | null} the encoded frame */
  broadcastRoom(room, msg) {
    if (room.disposed) return null;
    const data = encode(msg);
    if (data == null) { this.log.error(`[lobby] ${room.code} unserializable broadcast ${msg && msg.t}`); return null; }
    const droppable = isDroppable(msg);
    for (const session of this.memberSessions(room)) sendRaw(session.ws, data, { droppable });
    return data;
  }

  /** Match unicast. @returns {boolean} */
  sendToPlayer(room, playerId, msg) {
    if (room.disposed) return false;
    const seat = room.seatOf(playerId) || room.spectatorOf(playerId);
    if (!seat || seat.isBot || seat.left) return false;
    const session = this.registry.byId(playerId);
    if (!session || session.roomCode !== room.code) return false;
    return sendSession(session, msg);
  }
}
