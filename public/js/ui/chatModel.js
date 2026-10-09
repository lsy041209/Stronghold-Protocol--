// chatModel.js —— 房间内聊天的**纯逻辑层**（第 6 任 B，2026-10-07；C 总表 B-6 / `D给B-聊天面板UI口径-2026-10-07.md`）
//
// 为什么单独一层：面板要能**在 Node 里单测**（本工作区 `test/ui/*.test.js` 的惯例是"遍历 vnode 树 + 真调 props.onClick"），
// 而"长度怎么算 / 历史怎么并 / 谁能不能发言 / 服务端不支持时怎么认"这些判断**与 DOM 无关** ⇒ 抽成纯函数，好测也好复用。
//
// 口径来源（**不要自己发明**）：
//   · 长度上限 **120 码点**（`D给B-…md` §2；服务端也会截一遍 ⇒ 这边截是"双保险 + UI 即时反馈"）——
//     ⚠️ 用 **码点**（`Array.from`）而不是 `String.prototype.slice`：后者按 UTF-16 码元切，
//     一个 emoji / 一个增补平面汉字会被切成半个（用户看到"口口"）。
//   · 补发走 **`chat.history { messages: [...] }`**（B 2026-10-07 回 D 的那封信；**默认 50 条**，客户端自己留 `CHAT_HISTORY_CAP`）。
//   · 表情 `m.emote` **不动**：本层只处理文本消息，不碰表情。
//   · 权限（用户 07:0x 逐字）：「**观战者不可发言（战斗中死了而观战的可以）**」
//     ⇒ 客户端的判据是 **"是否曾占过座位"**（`everSeated`）——纯 `room.spectate` 进来的一律只读；
//       对局中阵亡转观战的人**仍然有 `everSeated`** ⇒ 可以发言。（服务端也会拒，这边提前置灰体验更好。）

// 🔴 2026-10-08：把**协议校验器**接进来（唯一的形状真源）。为什么必须：
//   `shared/protocol.js` 的 `isQuickId` 才是"这一条能不能上线"的判据，而我这张表里 `niceOne`/`myBad` 是 camelCase、
//   落地的校验器是 `/^[a-z0-9_]{1,32}$/`（**只小写**）⇒ 这两条会被**客户端自己**挡下（`net.request` → `validateC2S`），
//   玩家看到的是"点了没反应"。⇒ 按钮的可用性必须**问同一个校验器**，而不是我以为的形状。
//   （已报 A：把字符类改成 `[A-Za-z0-9_]`；他修完 `QUICK_IDS_ALL_WIRE_OK` 那条判据会要求删掉豁免表。）
import { isQuickId } from '../../../shared/protocol.js';

/** 单条上限：**120 码点**（与 `D给B-…md` §2 一致）。 */
export const CHAT_MAX_CODEPOINTS = 120;
/** 客户端最多留多少条（服务端补发默认 50；留大一点以便一局内翻看）。 */
export const CHAT_HISTORY_CAP = 200;
/** 昵称显示上限（防有人用超长昵称把面板撑破）。 */
export const CHAT_NAME_CAP = 24;

/**
 * 按**码点**截断并去掉首尾空白（内部空白保留）。
 * @param {unknown} value @param {number} [limit]
 * @returns {string}
 */
export function clampText(value, limit = CHAT_MAX_CODEPOINTS) {
  if (value == null) return '';
  const s = String(value);
  const points = Array.from(s);                       // ← 码点，不是码元
  const cut = points.length > limit ? points.slice(0, limit).join('') : s;
  return cut.replace(/\s+$/u, '').replace(/^\s+/u, '');
}

/** 空白串（含全角空格）不该发出去。 */
export function isBlank(value) {
  return clampText(value) === '';
}

/** 昵称：截断 + 空则回落成 id 的短形式。 */
export function displayName(name, from) {
  const n = clampText(name, CHAT_NAME_CAP);
  if (n) return n;
  const id = from == null ? '' : String(from);
  return id ? `玩家 ${id.slice(-4)}` : '玩家';
}

/**
 * 把任意来路的消息收敛成固定形状（**宽容**：字段缺失/类型不对都不抛）。
 * @returns {{ from: string, name: string, text: string, at: number }}
 */
export function normalizeMessage(msg) {
  const m = msg && typeof msg === 'object' ? msg : {};
  const from = m.from == null ? '' : String(m.from);
  const at = Number.isFinite(Number(m.at)) ? Number(m.at) : Date.now();
  return { from, name: displayName(m.name, from), text: clampText(m.text), at };
}

/**
 * 追加一条（**环形**：超过 `cap` 丢最旧的）。返回新数组（不原地改，方便 store 做浅比较）。
 */
export function appendChat(list, msg, cap = CHAT_HISTORY_CAP) {
  const base = Array.isArray(list) ? list : [];
  const next = base.concat([normalizeMessage(msg)]);
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/** 同一条消息的指纹（**去重**用：重连补发 + 实时广播可能重叠）。 */
export function messageKey(m) {
  // 🆕 2026-10-08 快捷短语（`quick.msg { ids }`）走这里：它的指纹用 `ids`（它不是文本消息，没有 `text`）。
  // ⚠️ **必须带 `q:` 前缀**：单个 id `'sorry'` 直接 join 出来的串与一条**文本** `'sorry'` 一模一样
  //    ⇒ 不带前缀时"同一时刻收到一条短语和一条同字文本"会被去重成一条（我自己的判据当场抓到的撞键）。
  if (m && typeof m === 'object' && Array.isArray(m.ids)) {
    const q = normalizeQuickMessage(m);
    return q ? `${q.from}\u0000${q.at}\u0000q:${q.ids.join(',')}` : '';
  }
  const n = normalizeMessage(m);
  return `${n.from}\u0000${n.at}\u0000${n.text}`;
}

/**
 * 合并补发历史：`history` 是权威的**前段**，本地可能已有更晚的实时消息。
 * 策略：以 history 为底，再把"本地独有的"按 `messageKey` 补在后面（保持时间序），最后按 cap 截断。
 * ⚠️ **宽容**：`history` 不是数组（旧服务端/字段改名）⇒ 当"没有历史"，**不抛**。
 */
export function mergeHistory(local, history, cap = CHAT_HISTORY_CAP) {
  const base = Array.isArray(history) ? history.map(normalizeMessage) : [];
  const extra = (Array.isArray(local) ? local : []).map(normalizeMessage);
  const seen = new Set(base.map(messageKey));
  const merged = base.concat(extra.filter((m) => !seen.has(messageKey(m))));
  merged.sort((a, b) => a.at - b.at);
  return merged.length > cap ? merged.slice(merged.length - cap) : merged;
}

/** 本地时钟 `HH:MM`（本地时区；`at` 是 ms epoch）。非法值 ⇒ `--:--`。 */
export function formatClock(at) {
  const n = Number(at);
  if (!Number.isFinite(n)) return '--:--';
  const d = new Date(n);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * 服务端"不认识 `room.chat`"的识别（D §1：新客户端 + **旧服务端** ⇒ `error BAD_MSG`）。
 * ⇒ UI 要**优雅降级**（置灰 + 一句说明），**别弹错误刷屏**。
 */
export function isUnsupportedChatError(err) {
  if (!err) return false;
  const code = err.code != null ? String(err.code) : '';
  if (code === 'BAD_MSG' || code === 'UNKNOWN' || code === 'BAD_INTENT') return true;
  // 没给 code 时退回看文案（不同版本可能只带 msg）
  const msg = err.msg != null ? String(err.msg) : String(err.message || '');
  return /bad[_ ]?msg|unknown|不支持/i.test(msg);
}

/** 自己发的消息要右对齐/配色区分（`from` 与自己的 id 相同）。 */
export function isMine(msg, selfId) {
  const n = normalizeMessage(msg);
  return n.from !== '' && String(selfId) === n.from;
}

/**
 * 能不能发言（用户 07:0x 口径的**客户端判据**：**是否曾占过座位**）。
 * @param {{ everSeated?: boolean }} room
 * @returns {boolean}
 */
export function canSpeakInRoom(room) {
  return !!(room && room.everSeated);
}

/** 未读数：收起时用（红点）。`since` = 上次"看过"的时刻（ms epoch）。 */
export function countUnread(list, since) {
  const t = Number(since);
  if (!Number.isFinite(t)) return 0;
  return (Array.isArray(list) ? list : []).filter((m) => normalizeMessage(m).at > t).length;
}

/**
 * 把面板位置夹进视口（**纯函数** —— 拖动在本工程是第一次做，而 Node 里没有 DOM，
 * 所以把"能算的部分"抽出来单测；`ui/lanPanel.js` 是唯一先例，它的公式见下）。
 *
 * 先例的公式（`ui/lanPanel.js:99-133`）：`startX/startY` + 元素 `offsetLeft/offsetTop`，
 * `pointermove` 里 `dx/dy`，10px 内算点击（`Math.hypot(dx,dy) < 10`），最后
 * `clamp(0 … innerWidth - offsetWidth - 4)`。这里把**夹取**这一段做成纯函数并按它对齐（留 4px 边距）。
 *
 * @param {{x:number,y:number}|null} pos 期望位置（px，相对视口左上角）
 * @param {{w:number,h:number,vw:number,vh:number,pad?:number}} box 面板尺寸 + 视口尺寸
 * @returns {{x:number,y:number}} 夹取后的位置（`pos` 非法时兜到右下角默认位）
 */
/**
 * 🔴 2026-10-08（用户 Q9 第 2 条 bug）：「聊天框**不能自由放大缩小**（想看更多消息做不到）」⇒ 尺寸规则。
 * 纯函数（可判据）：坏输入 ⇒ null（＝用 CSS 默认尺寸）；给值就夹进 [min, 视口的 90%/85%]。
 * @param {{w?:number,h?:number}|null} size 已存的尺寸（`sp.pref.chat.size`）
 * @param {{vw?:number, vh?:number, minW?:number, minH?:number}} box
 * @returns {{w:number,h:number}|null}
 */
export function clampPanelSize(size, box) {
  const w = Number(size?.w), h = Number(size?.h);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
  const vw = Number.isFinite(box?.vw) && box.vw > 0 ? box.vw : 1280;
  const vh = Number.isFinite(box?.vh) && box.vh > 0 ? box.vh : 720;
  const minW = Number.isFinite(box?.minW) ? box.minW : 190;
  const minH = Number.isFinite(box?.minH) ? box.minH : 130;
  return {
    w: Math.max(minW, Math.min(Math.round(w), Math.round(vw * 0.9))),
    h: Math.max(minH, Math.min(Math.round(h), Math.round(vh * 0.85))),
  };
}

/**
 * 🔴 2026-10-08（用户口径）：「**收起后，消息按钮应该回到最开始的位置（原处）**，而不是停留在当前位置，
 * 这样既迷惑又误导人。」⇒ 把这条规则抽成**纯函数**（可判据，不靠"看代码像是对的"）：
 *   · **收起** ⇒ 位置一律作废（`null` ＝ 回默认角）；
 *   · **展开** ⇒ 保留给它的位置（拖过就还在拖到的地方，直到下次收起）。
 * ⚠️ 刻意**不做**"展开时恢复上次拖走的位置"：那正是用户说的"迷惑"——收起态只剩一个小把手，
 *   玩家看到它待在奇怪的地方就会以为"聊天按钮不见了"。
 */
export function posForCollapse(collapsed, pos) {
  return collapsed ? null : (pos ?? null);
}

export function clampPanelPos(pos, box) {
  const pad = Number.isFinite(box?.pad) ? box.pad : 4;
  const vw = Number.isFinite(box?.vw) ? box.vw : 0;
  const vh = Number.isFinite(box?.vh) ? box.vh : 0;
  const w = Number.isFinite(box?.w) ? box.w : 0;
  const h = Number.isFinite(box?.h) ? box.h : 0;
  const maxX = Math.max(pad, vw - w - pad);
  const maxY = Math.max(pad, vh - h - pad);
  const rawX = Number.isFinite(pos?.x) ? pos.x : maxX;
  const rawY = Number.isFinite(pos?.y) ? pos.y : maxY;
  return { x: Math.min(Math.max(pad, rawX), maxX), y: Math.min(Math.max(pad, rawY), maxY) };
}

/** 拖动判定：位移小于这个像素数仍算"点击"（`lanPanel.js` 用的就是 10）。 */
export const DRAG_SLOP_PX = 10;

/** 这次指针位移算不算"真的在拖"（纯函数，好单测）。 */
export function isDragMove(dx, dy, slop = DRAG_SLOP_PX) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
  return Math.hypot(dx, dy) >= slop;
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 🆕 2026-10-08 快捷聊天（**C 派工 B-C1/B-C2/B-C4**，协议形状由 A 落：`room.quick` 开关／`room.quickMsg { id }`／
//    S2C `quick.msg { from, name, ids, at }`／`room.state.chatMode: 'open'|'quick'`）。本段仍是**纯逻辑**：
//    不 import store、不碰 DOM ⇒ 面板与 `main.js` 各自取用，判据在 `test/ui/quick-chat.test.js`。
//
// 口径来源（**不要自己发明**）：
//   · 9 条句式的**id 与顺序**＝用户 2026-10-08 定稿（`协作/C-派工-局内聊天固定句式与房间开关…` §3）；
//     **文案**＝`public/i18n/*`（服务端只认 id，文本在**接收端**按各自语言渲染）。
//   · 🔴 **参数**：A 落的 `room.quickMsg` **只带 `id`（逗号分隔、最多 3 个）**，**没有 `arg` 字段**
//     ⇒ 4 条带参句式（playing/need/thanks/careful）**当前发不出去**（发了也只会渲染成缺参数的句子）。
//     ⇒ 本层把它们标成 `arg` 且**单独导出** `QUICK_ARG_IDS`：**面板先禁用它们**（别静默发半句话），
//       等协议加 `arg?`（已请 C 裁决）后只需把面板的 `disabled` 拆掉。
//   · `chatMode` 的**读法**：`=== 'open'` 才允许打字；**其它值/缺省一律不许**（fail-safe：宁可置灰，也别让玩家
//     打一段字却被服务端 `CHAT_OFF` 拒）。`'quick'` = 房主关了打字（A 的服务端强制，客户端只是体验层）。
//   · **个人屏蔽**（用户第 2 点后半，A 裁定**纯客户端**）：只影响**显示**，不动服务端、不改历史（用户第 3 点
//     "旧历史不隐藏" ⇒ 屏蔽只过滤**被屏蔽者**的消息）。

/** 9 条句式的 id（**顺序即面板顺序**；与 `test/ui/quick-chat-i18n.test.js` 的 9 条 msgid 一一对应）。 */
export const QUICK_IDS = Object.freeze(['playing', 'need', 'thanks', 'sorry', 'wait', 'help', 'careful', 'niceOne', 'myBad']);

/**
 * 每条句式的形状：`id`（上线真源）、`msgid`（＝中文原文，`public/i18n/*` 的键）、`arg`（需要哪个参数；null = 无参）。
 * ⚠️ `id` 必须与 `data/config.json` 的 `quickPhrases[].id` **逐字一致**（服务端按表查白名单，未知 ⇒ `BAD_MSG`）。
 */
export const QUICK_PHRASES = Object.freeze([
  { id: 'playing', msgid: '我玩 {bond}', arg: 'bond' },
  { id: 'need', msgid: '请给我 {chess}', arg: 'chess' },
  { id: 'thanks', msgid: '感谢 {mate}', arg: 'mate' },
  { id: 'sorry', msgid: '对不起！', arg: null },
  { id: 'wait', msgid: '稍等一下', arg: null },
  { id: 'help', msgid: '救命！', arg: null },
  { id: 'careful', msgid: '小心 {enemy}', arg: 'enemy' },
  { id: 'niceOne', msgid: '漂亮！', arg: null },
  { id: 'myBad', msgid: '我的错', arg: null },
]);

const QUICK_BY_ID = new Map(QUICK_PHRASES.map((p) => [p.id, p]));
/** 认识的 id（伪造/未知的一律丢掉）。 */
export const QUICK_ID_SET = new Set(QUICK_IDS);
/** 🔴 需要参数、而当前协议**带不了参数**的 4 条 ⇒ 面板先禁用（见本段顶部注释）。 */
export const QUICK_ARG_IDS = Object.freeze(QUICK_PHRASES.filter((p) => p.arg).map((p) => p.id));
/** 当前就能发的 5 条（无参）。 */
export const QUICK_PARAMLESS_IDS = Object.freeze(QUICK_PHRASES.filter((p) => !p.arg).map((p) => p.id));

/** 一条 id 的句式定义（不认识 ⇒ null）。 */
export function quickPhraseOf(id) {
  return QUICK_BY_ID.get(String(id)) ?? null;
}

/**
 * 面板按钮 → 可发送的 `ids` 数组（**最多 3 个**；只用无参的 —— 带参的走 `quickMsgPayload`）。
 * ⚠️ 本函数是 `quickMsgPayload` 的**薄包装**（唯一实现仍在那边）⇒ 不会出现"两套判据"。
 */
export function sendableQuickIds(ids, max = 3) {
  const p = quickMsgPayload((Array.isArray(ids) ? ids : []).map((id) => ({ id })), max);
  return p && p.id ? p.id.split(',') : [];
}

/** `ids` → `room.quickMsg.id` 那一个串（空 ⇒ null，调用方据此不发）。 */
export function quickIdPayload(ids, max = 3) {
  return quickMsgPayload((Array.isArray(ids) ? ids : []).map((id) => ({ id })), max)?.id ?? null;
}

/**
 * 把收到的 `quick.msg` 收敛成固定形状（**宽容**：缺字段/类型不对/未知 id 都不抛）。
 * 未知 id 被丢掉（服务端已按白名单过滤，这里只是别把没见过的 id 画出来）；全被丢掉 ⇒ `null`（无可渲染内容）。
 * @returns {{ from: string, name: string, ids: string[], at: number, kind: 'quick' }|null}
 */
export function normalizeQuickMessage(msg) {
  const m = msg && typeof msg === 'object' ? msg : {};
  const from = m.from == null ? '' : String(m.from);
  const at = Number.isFinite(Number(m.at)) ? Number(m.at) : Date.now();
  const raw = Array.isArray(m.ids) ? m.ids : (typeof m.ids === 'string' ? m.ids.split(',') : []);
  const ids = [];
  for (const x of raw) {
    const id = String(x).trim();
    if (!QUICK_BY_ID.has(id) || ids.includes(id)) continue;
    ids.push(id);
    if (ids.length >= 3) break;
  }
  if (!ids.length) return null;
  // 🆕 2026-10-08：S2C 现在会带**一个** `arg`（配整条消息；A `QUICK_ARG_MAX_LEN = 24`）。宽容收敛：超长/带空白 ⇒ 丢掉。
  const rawArg = m.arg == null ? '' : String(m.arg).trim();
  const arg = rawArg && rawArg.length <= QUICK_ARG_MAX_LEN && !/\s/.test(rawArg) ? rawArg : '';
  return { from, name: displayName(m.name, from), ids, at, kind: 'quick', ...(arg ? { arg } : {}) };
}

/** 追加一条快捷短语（与 `appendChat` 同规矩：环形 + 不原地改；坏消息 ⇒ 原样返回）。 */
export function appendQuick(list, msg, cap = CHAT_HISTORY_CAP) {
  const q = normalizeQuickMessage(msg);
  if (!q) return Array.isArray(list) ? list : [];
  const base = Array.isArray(list) ? list : [];
  const next = base.concat([q]);
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/**
 * 一条消息的**显示文本**（收端按自己语言渲染；`t` 注入 ⇒ 本层仍是纯函数）。
 * 带参句式若拿不到参数（协议还没带 `arg`）⇒ `t` 会把 `{…}` 原样留下 —— 那是**如实**的"缺参数"，
 * 比编一个名字好（判据里有一条专门钉这个形状）。
 * @param {{ids: string[]}} m @param {{t: Function, names?: Record<string, string>}} deps
 */
export function quickTextOf(m, { t, names = {} } = {}) {
  const ids = Array.isArray(m?.ids) ? m.ids : [];
  const arg = m && typeof m.arg === 'string' ? m.arg : null;   // S2C 的一个 arg 配整条消息（见 quickMsgPayload 的说明）
  const parts = [];
  for (const id of ids) {
    const p = QUICK_BY_ID.get(id);
    if (!p) continue;
    // 参数优先取调用方给的**已本地化名字**（`names[arg]`，如盟约名/干员名/队友名/敌怪名）；
    // 拿不到就只有"带参的那一条"回落成原始 arg（对玩家来说是个 id —— 总比整句缺一半好），无参的不受影响。
    const value = (arg && names[arg] != null) ? names[arg] : (p.arg && arg ? arg : null);
    const args = p.arg && value != null ? { [p.arg]: value } : {};
    parts.push(typeof t === 'function' ? t(p.msgid, args) : p.msgid);
  }
  return parts.join(' ');
}

/** A 给的上限（`QUICK_ARG_MAX_LEN = 24`）：与他那边一致，别自己发明。 */
export const QUICK_ARG_MAX_LEN = 24;

/**
 * 🔴 2026-10-08（A 落了 `arg` 之后，C 提醒"`quick.msg` 走 `ids` 复数"）：带参句式的**发送层**。
 *
 * 协议实况（A 的落法）：C2S `{ t:'room.quickMsg', id:'playing,wait', arg:'siracusaShip' }`｜
 * S2C `{ t:'quick.msg', from, name, ids:['playing','wait'], arg:'siracusaShip', at }` —— **一个 `arg` 配整条消息**。
 * ⇒ ⚠️ **一个 `arg` 配多个 `ids` 是有歧义的**（哪一条 id 用这个 arg？）：所以本层定一条客户端规则：
 *   **一条消息要么只含无参 id（≤3 个），要么恰好一条带参 id（带它的 arg）** —— 歧义在源头消灭，
 *   而不是发给服务端让它"原样广播"（A 那层不校验 arg 语义 ⇒ 发出去也不会有人拦）。
 * @param {Array<{id: string, arg?: string}>} items 面板上"要发的条目"
 * @param {number} [max] 无参 id 的条数上限（与 `isQuickId` 的"逗号分隔最多 3 个"一致）
 * @returns {{ id: string, arg?: string }|null} `room.quickMsg` 的载荷（null ⇒ 不发）
 */
export function quickMsgPayload(items, max = 3) {
  const arged = [];
  const plain = [];
  for (const it of Array.isArray(items) ? items : []) {
    const id = it && it.id != null ? String(it.id) : '';
    const p = QUICK_BY_ID.get(id);
    if (!p) continue;                                       // 未知 id 一律不发
    if (!isQuickId(id)) continue;                           // 🔴 协议校验器不认的形状（如 camelCase）⇒ 不发
    if (!p.arg) { if (!plain.includes(id)) plain.push(id); continue; }
    const arg = it && it.arg != null ? String(it.arg).trim() : '';
    if (!arg || arg.length > QUICK_ARG_MAX_LEN || /\s/.test(arg)) continue;   // 带参的**必须有合法 arg**
    if (!arged.some((x) => x.id === id)) arged.push({ id, arg });
  }
  if (arged.length) return arged.length === 1 ? { id: arged[0].id, arg: arged[0].arg } : null;  // ≥2 条带参 ⇒ 歧义 ⇒ 不发
  return plain.length ? { id: plain.slice(0, max).join(',') } : null;
}

/** 这条短语要哪一类参数（`null` = 无参）——渲染时用它决定要不要把 arg 翻成显示名。 */
export function quickArgKind(m) {
  const id = Array.isArray(m?.ids) ? m.ids[0] : null;
  return (id && QUICK_BY_ID.get(id)?.arg) || null;
}

/**
 * 🆕 2026-10-08（用户实测：气泡里显示的是编号）：**把一条短语消息渲染成给人看的字** ——
 * `resolve(kind, arg)` 由调用方给（客户端那边是 `quickArgs.argLabel`，需要 data/room）；
 * 拿不到名字就退回原始 arg（**不空白**，也不假装知道）。
 * @param {object} m 收敛后的短语消息
 * @param {{ t?: Function, resolve?: (kind:string|null, arg:string)=>string, names?: object }} opts
 */
export function quickTextOfMessage(m, { t, resolve = null, names = {} } = {}) {
  const kind = quickArgKind(m);
  const arg = m && typeof m.arg === 'string' ? m.arg : null;
  const map = { ...names };
  if (kind && arg && typeof resolve === 'function') {
    const label = resolve(kind, arg);
    if (label) map[arg] = label;
  }
  return quickTextOf(m, { t, names: map });
}

/**
 * 这一条**现在**能不能一键发出去（无参的能；带参的要先选到 arg）。
 * 面板按钮的 `disabled` 与发送路径**共用本函数** ⇒ 不会分叉（这是"按钮能点但发不出去"的根治办法）。
 */
export function canSendQuickNow(id, arg = null) {
  return quickMsgPayload([{ id, arg }]) != null;
}

/**
 * 这一条**为什么**现在发不出去（面板用它给禁用按钮一句**正确的**提示；`null` = 能发）。
 * @returns {'unknown'|'needArg'|'wire'|null}
 */
export function quickBlockReason(id, arg = null) {
  if (!QUICK_BY_ID.has(String(id))) return 'unknown';
  if (!isQuickId(String(id))) return 'wire';                 // 协议校验器不认（camelCase 那两条就是这个）
  return quickMsgPayload([{ id, arg }]) ? null : 'needArg';  // 带参但还没选到参数
}

/**
 * 能不能**打字**：只有房间**明确**说"不许"时才置灰 —— 即 `chatMode` 是 `'quick'`／`'off'`（或将来别的显式值）；
 * `chatMode` **缺省**（`null`/`undefined`）⇒ **允许**。
 *
 * 🔴 为什么缺省是"允许"而不是"不许"（2026-10-08，被 `test/ui/chat-panel.test.js` 那条既有判据当场纠正）：
 *   · **旧服务端**（0.2.1 之前）根本**不发** `chatMode`，而它那边的 `room.chat` 是好用的 ⇒ 缺省置灰 = **把旧服务端的
 *     打字功能整个关掉**（真回退，而且玩家只看到"打字已关闭"、不知道为什么）；
 *   · 反过来"缺省允许"的最坏情况很轻：新服务端若忘了带这个字段而房主又关了打字，玩家打一段字会被服务端
 *     `CHAT_OFF` 拒（**服务端本来就有强制**，这才是唯一的执行者）⇒ 只是多一次失败提示，不是功能丢失。
 *   ⇒ 判据：**只有显式的限制值才关**（白名单式），未知/缺省一律放行。
 * @param {{ chatMode?: string }|null} room room.state 载荷（客户端 `store.room` 就是它）
 */
export function canTypeInRoom(room) {
  const mode = room && room.chatMode != null ? String(room.chatMode) : null;
  return mode == null || mode === 'open';
}

/** 个人屏蔽名单的**净化**（纯函数；读写交给 `loadPref/savePref`，本层不碰 store/localStorage）。 */
export function cleanMuted(value) {
  const arr = Array.isArray(value) ? value : [];
  const out = [];
  for (const x of arr) {
    const id = x == null ? '' : String(x);
    if (!id || out.includes(id)) continue;
    out.push(id);
    if (out.length >= 64) break;                 // 上限：别让坏数据把偏好撑爆
  }
  return out;
}

/** 某人是否被我屏蔽。 */
export function isMuted(from, muted) {
  const id = from == null ? '' : String(from);
  return !!id && cleanMuted(muted).includes(id);
}

/** 屏蔽/取消（返回新数组）。 */
export function toggleMuted(muted, from) {
  const id = from == null ? '' : String(from);
  if (!id) return cleanMuted(muted);
  const list = cleanMuted(muted);
  return list.includes(id) ? list.filter((x) => x !== id) : list.concat([id]);
}

/**
 * 过滤**显示**（个人屏蔽的落点）：只丢掉被屏蔽者的消息，**不动**列表本身、**不动**历史。
 * @param {Array<object>} list @param {string[]} muted
 */
export function filterMuted(list, muted) {
  const ban = new Set(cleanMuted(muted));
  if (!ban.size) return Array.isArray(list) ? list : [];
  return (Array.isArray(list) ? list : []).filter((m) => !ban.has(m && m.from != null ? String(m.from) : ''));
}

/**
 * 🆕 2026-10-08（用户当场裁定：开关入口放**房内聊天面板头部**）：谁能在**什么时候**改这个开关。
 *
 * 口径（＝ A 服务端那两条限制的**客户端镜像**，不是我发明的）：**房主** ＋ **对局开始前**（`!room.inMatch`）。
 * 服务端仍然是唯一的执行者（非房主 ⇒ `NOT_HOST`，开局后 ⇒ `WRONG_PHASE`）；这边只是**别让按钮假装能点**。
 * @param {{ hostId?: string, inMatch?: boolean }|null} room `store.room`（＝ `room.state` 载荷）
 * @param {string|null} selfId 自己的 playerId
 */
export function canToggleTextChat(room, selfId) {
  if (!room || room.hostId == null || selfId == null) return false;
  return String(room.hostId) === String(selfId) && !room.inMatch;
}

/**
 * 开关按钮**要发的那一条**：`room.quick { on }` —— 注意 A 的 `on` 是「**打字关掉**」（`on:true` ⇒ 本房只允许短语）。
 * 我按"**动作**"给按钮取文案、按这个函数给 payload ⇒ ⛔ 别在面板里手写 `on: true/false`（布尔反了不会报错，
 * 只会让"关闭打字"变成"打开打字"，这正是本仓最贵的静默错之一）。
 * @param {string|null} chatMode 当前 `room.state.chatMode`
 * @returns {{ on: boolean, label: '开启打字'|'关闭打字' }}
 */
export function textChatSwitch(chatMode) {
  const typingOff = chatMode === 'quick' || (chatMode != null && chatMode !== 'open');
  // 现在**打字是关的** ⇒ 按钮的动作是"开启打字" ⇒ payload 必须是 on:false（把 quickOnly 关掉）
  return typingOff ? { on: false, label: '开启打字' } : { on: true, label: '关闭打字' };
}

