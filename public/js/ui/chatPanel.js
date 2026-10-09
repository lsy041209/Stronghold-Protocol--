// chatPanel.js —— 对局中的**聊天面板**（第 6 任 B，2026-10-07；C 总表 B-6 / `D给B-聊天面板UI口径-2026-10-07.md`）
//
// 用户 07:0x 逐字口径：
//   「**对局中放个聊天的面板，这个面板可拖动，可收起，不想看的时候就收起（收起时上面会弹红点以表示有新消息），
//     同时保留表情包。观战者不可发言（战斗中死了而观战的可以），重进房间要看到。**」
//
// 设计取舍（**与 `ReservePicker` 同一套路**）：
//   ⚠️ **本组件保持"无 hook"** —— 测试直接把它当纯函数调（`ChatPanel({...})` 后遍历 vnode 树、真调 `props.onClick`）。
//   ⇒ 拖动/收起/草稿/未读的**状态全在父层**（对局界面 + store），这里只收 props + 回调。
//   ⇒ 好处：面板逻辑可以**完全不依赖 DOM** 地单测（本工作区已多次栽在"文件里写着 onClick 证明不了点下去会发生什么"）。
//
// 数据形状（D 定的，见 `D给B-…md` §2）：
//   发 `net.request('room.chat', { text })`（≤120 码点）｜收 `chat.msg { from, name, text, at }`｜补发 `chat.history { messages }`
//   —— 纯逻辑在 `./chatModel.js`（截断/环形/合并/权限/降级），本文件只管**画**与**回调**。
import { html, Button, TextField } from './components.js';
import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { useStore, loadPref, savePref, isSpectating } from '../store.js';
import { net } from '../net.js';
import { t } from '../../../shared/i18n.js';
import { toastError } from './toasts.js';
import {
  clampText, formatClock, isMine, isBlank, displayName, CHAT_MAX_CODEPOINTS,
  clampPanelPos, isDragMove, countUnread, isUnsupportedChatError,
  // ⚠️ 2026-10-08（用户裁：「快捷短语像表情一样弹出」）：短语已挪到**弹出面板** `ui/quickWheel.js`
  //    ⇒ 本文件只留**面板自己还用得到**的：收消息怎么渲染（`quickTextOf`）、打字门（`canTypeInRoom`）、
  //    房主开关（`canToggleTextChat`/`textChatSwitch`）、个人屏蔽（`cleanMuted`/`toggleMuted`/`filterMuted`）。
  //    ⛔ 这里**不要再引** `QUICK_PHRASES`/`canSendQuickNow`/`quickMsgPayload`/`quickArgOptions` ——
  //    两个入口"共用同一对函数"是允许的（也是必须的），但**两处各自渲染一遍**就是分叉。
  quickTextOf, quickTextOfMessage, canTypeInRoom, canToggleTextChat, textChatSwitch, posForCollapse, clampPanelSize,
  QUICK_PHRASES, canSendQuickNow, quickBlockReason, quickMsgPayload, quickPhraseOf,
  cleanMuted, toggleMuted, filterMuted,
} from './chatModel.js';
import { quickArgOptions, chessTiers, chessBondsInTier, argLabel } from './quickArgs.js';
import { data } from '../data.js';

/**
 * @param {object} p
 * @param {Array<{from:string,name:string,text:string,at:number}>} p.messages
 * @param {string} p.selfId              自己的 playerId（区分左右/配色）
 * @param {boolean} p.collapsed          收起态（收起只留把手 + 红点）
 * @param {number} p.unread              未读条数（收起时用；>0 出红点）
 * @param {boolean} p.canSpeak           能否发言（纯观战者 false；阵亡转观战 true）
 * @param {boolean} p.unsupported        服务端不支持（旧服务端 `BAD_MSG`）⇒ 置灰 + 一句说明
 * @param {string} p.draft               输入框草稿
 * @param {boolean} p.sending            正在发（防重复）
 * @param {() => void} p.onToggle        收起/展开
 * @param {(v:string) => void} p.onDraft 草稿变化
 * @param {() => void} p.onSend          发送
 * @param {(e:Event) => void} [p.onDragStart] 拖动开始（状态在父层）
 * @param {() => void} [p.onClose]       关闭（可选；收起与关闭是两件事：收起留把手，关闭整块隐藏）
 */
export function ChatPanel({
  messages, selfId, collapsed = false, unread = 0, canSpeak = false, unsupported = false,
  draft = '', sending = false, chatMode = null, mutedCount = 0, canSwitch = false,
  quickSection = null, quickText = null, size = null, onResizeStart = null,
  onToggle, onDraft, onSend, onDragStart, onClose, onToggleMute, onUnmuteAll, onSwitch,
}) {
  const list = Array.isArray(messages) ? messages : [];
  const dot = collapsed && unread > 0;
  // 🔴 2026-10-08（C 派工 B-C2）：**打字**还要过房间那道门 —— `room.state.chatMode === 'open'` 才允许
  //    （`'quick'` = 房主关了打字；缺省/未知也一律不许：宁可置灰，也别让玩家打一段字被服务端 `CHAT_OFF` 拒）。
  const typingOn = canTypeInRoom({ chatMode });
  const canType = canSpeak && !unsupported && !sending && typingOn;
  // 房主开关（用户 2026-10-08 裁定：入口在**房内聊天面板头部**）：按钮发的是**动作**，payload 由纯函数给
  //   （`textChatSwitch` 把"现在打字是关的"翻译成 `on:false`）—— 面板里**不许**手写布尔。
  const switchAction = textChatSwitch(chatMode);

  // ── 收起态：**只留一个把手**，有新消息就在把手上弹红点（用户口径逐字） ────────────────────────
  if (collapsed) {
    return html`<div class="sp-chat is-collapsed" data-chat-root data-chat-collapsed="true">
      <button type="button" class="sp-chat__handle" data-chat-toggle title=${t('展开聊天')} onClick=${() => onToggle?.()}>
        <span class="sp-chat__handle-icon" aria-hidden="true">${'💬'}</span>
        <span class="sp-chat__handle-text">${t('聊天')}</span>
        ${dot ? html`<span class="sp-chat__dot" data-chat-unread=${String(unread)} aria-label=${t('{n} 条未读', { n: unread })}></span>` : null}
      </button>
    </div>`;
  }

  // ── 展开态 ─────────────────────────────────────────────────────────────────────────────────
  return html`<div class="sp-chat is-open" data-chat-root data-chat-collapsed="false"
    style=${size ? `width:${size.w}px; height:${size.h}px; max-height:none;` : ''}>
    ${/* 🔴 用户 Q9 第 2 条 bug「不能自由放大缩小」：右下角一个拖拽把手（`data-chat-resize`），尺寸存 `sp.pref.chat.size` */''}
    ${onResizeStart ? html`<div class="sp-chat__grip" data-chat-resize role="separator" aria-label=${t('拖动缩放聊天框')}
      title=${t('拖动缩放聊天框')} onPointerDown=${onResizeStart}></div>` : null}
    <div class="sp-chat__head">
      <span class="sp-chat__grip" data-chat-drag title=${t('按住拖动面板')} onPointerDown=${(e) => onDragStart?.(e)}>⠿</span>
      <span class="sp-chat__title">${t('房间聊天')}</span>
      <span class="sp-chat__count" data-chat-count=${String(list.length)}>${list.length ? t('{n} 条', { n: list.length }) : ''}</span>
      ${mutedCount > 0 && onUnmuteAll ? html`<button type="button" class="sp-chat__btn" data-chat-unmute-all
        title=${t('恢复显示被屏蔽的人')} onClick=${() => onUnmuteAll()}>${t('已屏蔽 {n}', { n: mutedCount })}</button>` : null}
      ${canSwitch ? html`<button type="button" class="sp-chat__btn sp-chat__btn--switch" data-chat-switch
        title=${t('房主可改：只在对局开始前（关了打字，大家仍可用快捷短语）')}
        onClick=${() => onSwitch?.(switchAction.on)}>${t(switchAction.label)}</button>` : null}
      <button type="button" class="sp-chat__btn" data-chat-toggle title=${t('收起（新消息会在把手上弹红点）')} onClick=${() => onToggle?.()}>${t('收起')}</button>
      ${onClose ? html`<button type="button" class="sp-chat__btn sp-chat__btn--x" data-chat-close title=${t('关闭')} onClick=${() => onClose()}>✕</button>` : null}
    </div>

    <div class="sp-chat__list" data-chat-list role="log" aria-live="polite">
      ${list.length ? list.map((m, i) => {
        const mine = isMine(m, selfId);
        const quick = m && m.kind === 'quick';
        const body = quick ? (typeof quickText === 'function' ? quickText(m) : quickTextOf(m, { t })) : m.text;
        return html`<div key=${`${m.from}-${m.at}-${i}`} class=${`sp-chat__msg${mine ? ' is-mine' : ''}${quick ? ' is-quick' : ''}`}
            data-chat-msg data-chat-mine=${mine ? 'true' : 'false'} data-chat-at=${String(m.at)}
            data-chat-kind=${quick ? 'quick' : 'text'}>
          <span class="sp-chat__meta"><span class="sp-chat__who">${mine ? t('我') : displayName(m.name, m.from)}</span>
            <span class="sp-chat__time">${formatClock(m.at)}</span>
            ${/* 短语与打字混排时的**识别标签**（用户实测：只靠斜体分不清） */''}
            ${quick ? html`<span class="sp-chat__tag">${t('快捷短语')}</span>` : null}
            ${!mine && onToggleMute ? html`<button type="button" class="sp-chat__mute" data-chat-mute=${m.from}
              title=${t('屏蔽这个人的消息（只影响你自己看到的）')} onClick=${() => onToggleMute(m.from)}>${t('屏蔽')}</button>` : null}</span>
          <span class="sp-chat__text">${body}</span>
        </div>`;
      }) : html`<p class="sp-chat__empty">${t('还没有人说话 —— 打字回车即可发言。')}</p>`}
    </div>

    ${unsupported ? html`<p class="sp-chat__note" data-chat-unsupported>${t('当前服务器不支持聊天（版本较旧）—— 表情包仍可用。')}</p>`
      : !canSpeak ? html`<p class="sp-chat__note" data-chat-readonly>${t('观战中只能看 —— 本局参战过的玩家（含阵亡后观战）可以发言。')}</p>`
      : !typingOn ? html`<p class="sp-chat__note" data-chat-textoff>${t('房主已关闭本房的打字 —— 用下面的快捷短语交流。')}</p>`
      : null}

    ${quickSection}

    <div class="sp-chat__input">
      <${TextField} size="sm" value=${draft} placeholder=${canType ? t('说点什么…（回车发送）') : t('打字已关闭')}
        class="sp-chat__field" disabled=${!canType}
        onInput=${(v) => onDraft?.(clampText(v))}
        onKeyDown=${(e) => { if (e?.key === 'Enter') { e.preventDefault?.(); onSend?.(); } }} />
      <${Button} size="sm" variant="primary" data-chat-send
        disabled=${!canType || isBlank(draft)} loading=${sending}
        onClick=${() => onSend?.()}>${t('发送')}<//>
    </div>
    ${''}
    <p class="sp-chat__hint">${typingOn ? t('最多 {n} 字 · 拖动标题栏的 ⠿ 换位置', { n: CHAT_MAX_CODEPOINTS }) : t('拖动标题栏的 ⠿ 换位置')}</p>
  </div>`;
}

/**
 * 壳层：把 store / net / 拖动 / 偏好接进**纯展示**的 `ChatPanel`。
 *
 * 为什么分两层：`ChatPanel` 要能在 Node 里单测（无 hook ⇒ 直接当纯函数调），
 * 而拖动/偏好/收消息必须有状态 ⇒ 状态集中在这里（本工程同类先例：`loadout.js` 把 `Detail` 拆成
 * "带 hook 的 Detail + 可单测的纯组件"）。
 *
 * 位置记忆用本工程惯例 `loadPref/savePref`（键前缀 `sp.pref.`，见 `store.js:168/182`；实例 `ui/emotes.js`），
 * **不**用 `lanPanel.js` 的裸 `localStorage`——那条路是桌面外壳专用的。
 */
export function ChatPanelHost({ quickOpen = false, onQuickToggle = null }) {
  const messages = useStore((s) => s.chat);
  const selfId = useStore((s) => s.me.playerId);
  const room = useStore((s) => s.room);
  const online = useStore((s) => s.connection.status === 'online');

  const [collapsed, setCollapsed] = useState(() => loadPref('chat.collapsed', false) === true);
  const [seenAt, setSeenAt] = useState(() => {
    const v = loadPref('chat.seenAt', 0);
    return Number.isFinite(Number(v)) ? Number(v) : 0;
  });
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  // 🆕 个人屏蔽（用户 2026-10-08 第 2 点后半；A 的裁定：**纯客户端**、不走协议）：存 playerId 列表，
  //    只影响"我看到什么"（用户第 3 点「旧历史不隐藏」⇒ 不过滤列表本身，只在**显示**这一层丢掉）。
  const [muted, setMuted] = useState(() => cleanMuted(loadPref('chat.muted', [])));
  // ⚠️ 2026-10-08：短语的"正在选参数"状态随短语一起挪去了 `ui/quickWheel.js` —— 本面板**不再管短语**。
  const [pos, setPos] = useState(() => loadPref('chat.pos', null));
  // 🔴 2026-10-08（用户 Q9 第 2 条 bug「不能自由放大缩小」）：尺寸存 `sp.pref.chat.size`；null = 用 CSS 默认尺寸。
  const [size, setSize] = useState(() => clampPanelSize(loadPref('chat.size', null), { vw: globalThis.innerWidth, vh: globalThis.innerHeight }));
  useEffect(() => { savePref('chat.size', size); }, [size]);
  /**
   * 右下角把手的拖拽：**自包含**（在 window 上挂 pointermove/up，不占宿主既有的拖动处理器）。
   * 尺寸一律过 `clampPanelSize` ⇒ 不会拖成 0 宽或超出屏幕。
   */
  const onResizeStart = (e) => {
    const r = boxRef.current?.getBoundingClientRect?.();
    const d = {
      id: e?.pointerId, x0: Number(e?.clientX) || 0, y0: Number(e?.clientY) || 0,
      w0: r?.width || 260, h0: r?.height || 240,
    };
    const move = (ev) => {
      if (d.id != null && ev.pointerId !== d.id) return;
      const next = clampPanelSize(
        { w: d.w0 + ((Number(ev.clientX) || 0) - d.x0), h: d.h0 + ((Number(ev.clientY) || 0) - d.y0) },
        { vw: globalThis.innerWidth, vh: globalThis.innerHeight },
      );
      if (next) setSize(next);
    };
    const up = (ev) => {
      if (d.id != null && ev.pointerId !== d.id) return;
      globalThis.removeEventListener?.('pointermove', move);
      globalThis.removeEventListener?.('pointerup', up);
      globalThis.removeEventListener?.('pointercancel', up);
    };
    globalThis.addEventListener?.('pointermove', move);
    globalThis.addEventListener?.('pointerup', up);
    globalThis.addEventListener?.('pointercancel', up);
  };
  const boxRef = useRef(null);
  const drag = useRef(null);
  const prevCollapsed = useRef(collapsed);   // 收起那一刻要不要把位置作废，靠它与当前值比（不是"每次渲染都比"）

  useEffect(() => {
    // 🔴 2026-10-08（用户口径）：**收起 ⇒ 把手回到最开始的位置**（`pos` 作废＝默认角），
    //   而不是停在拖走的地方（用户原话：「既迷惑又误导人」）。
    //   ⚠️ 只在**收起这一刻**清（用上一次的值判断）：否则"收起态下拖把手"会被这条立刻抹掉。
    if (collapsed && !prevCollapsed.current) setPos(null);
    prevCollapsed.current = collapsed;
  }, [collapsed]);
  useEffect(() => { savePref('chat.collapsed', collapsed); }, [collapsed]);

  useEffect(() => { savePref('chat.pos', pos); }, [pos]);
  useEffect(() => { savePref('chat.muted', muted); }, [muted]);

  // 🔴 2026-10-08（用户实测"局内连聊天面板都没有"）：**恢复出来的位置必须夹进视口**。
  //    旧的 `sp.pref.chat.pos` 是**上一次会话**存的像素绝对坐标；换了窗口尺寸/分辨率/显示器后
  //    它会把面板渲染到**屏幕外** ⇒ 表现成"这个功能不存在"（而不是报错）。这里挂载时夹一次，并在 resize 时再夹。
  useEffect(() => {
    if (!pos) return undefined;
    // 🔴 2026-10-08（用户实测："把聊天框拖走后收起，会导致聊天按钮消失"）：三处硬化 ——
    //   ① 坏位置（NaN/Infinity/缺字段）⇒ **回到默认角**（宁可回默认位，也不能让把手跑到屏幕外）；
    //   ② 量不到尺寸时用**兜底尺寸**（收起态与展开态差别很大；量不到就按收起态的小尺寸算）；
    //   ③ 依赖里加 `collapsed` —— 收起/展开**都会重夹一次**（原来只在 pos 变时夹，收起后就没人管了）。
    const clamp = () => {
      const cur = pos;
      if (!Number.isFinite(cur?.x) || !Number.isFinite(cur?.y)) { setPos(null); return; }
      const el = boxRef.current;
      const w = el?.offsetWidth || (collapsed ? 150 : 280);
      const h = el?.offsetHeight || (collapsed ? 34 : 220);
      const vw = globalThis.innerWidth || 0, vh = globalThis.innerHeight || 0;
      if (!vw || !vh) return;
      const next = clampPanelPos(cur, { w, h, vw, vh });
      if (next.x !== cur.x || next.y !== cur.y) setPos(next);
      // 🆕 尺寸也一起夹（窗口变小后，之前拖大的聊天框不许超出屏幕）
      setSize((s) => clampPanelSize(s, { vw, vh }));
    };
    clamp();
    globalThis.addEventListener?.('resize', clamp);
    return () => globalThis.removeEventListener?.('resize', clamp);
  }, [pos, collapsed]);

  // 展开时算"看过了"（收起时才有红点）——用最后一条的时间戳，别用 Date.now()（否则会吞掉同毫秒的消息）。
  const list = Array.isArray(messages) ? messages : [];
  const shown = filterMuted(list, muted);            // 个人屏蔽只丢"被屏蔽者"的显示
  const lastAt = list.length ? Number(list[list.length - 1]?.at) || 0 : 0;
  useEffect(() => {
    if (collapsed || !lastAt) return;
    if (lastAt > seenAt) { setSeenAt(lastAt); savePref('chat.seenAt', lastAt); }
  }, [collapsed, lastAt, seenAt]);

  // 纯观战 = 命中 room.spectators；**阵亡者仍占座位**（`m.private.alive === false`）⇒ 照常能发言（用户口径）。
  const spectator = isSpectating(room, selfId);
  const canSpeak = !spectator && !!room && online;

  const send = async () => {
    const text = clampText(draft);
    if (!canSpeak || unsupported || sending || isBlank(text)) return;
    setSending(true);
    try {
      await net.request('room.chat', { text });      // 长度上限 120 码点，服务端还会再截一遍
      setDraft('');
    } catch (err) {
      // 旧服务端不认识 `room.chat` ⇒ `BAD_MSG`：**置灰 + 一句说明，别弹错误刷屏**（D 口径 §1）。
      if (isUnsupportedChatError(err)) setUnsupported(true);
      else toastError(err);
    } finally {
      setSending(false);
    }
  };

  // 🆕 房主的打字开关（用户 2026-10-08 裁定）。
  //    ⚠️ 只有**房主**＋**对局开始前**才给点（`canToggleTextChat` ＝ A 那两条服务端限制的客户端镜像）；
  //    服务端仍是唯一执行者（非房主 `NOT_HOST`、开局后 `WRONG_PHASE`）⇒ 这里挡不住也不影响正确性，只是别让按钮假装能点。
  const switchTextChat = async (on) => {
    if (!canToggleTextChat(room, selfId)) return;
    try {
      await net.request('room.quick', { on: !!on });
    } catch (err) {
      toastError(err);                                  // 照实提示（相位/权限由服务端说了算）
    }
  };

  /**
   * ⚠️ 2026-10-08：`quickPick` / `sendQuick`（短语的选参与发送）已随短语一起挪进 `ui/quickWheel.js`。
   * 本面板**只渲染收到的短语消息**（`quickTextOf`），不再自己发短语。
   */
  const onDragStart = (e) => {
    const el = boxRef.current;
    if (!el || !e) return;
    drag.current = { id: e.pointerId, startX: e.clientX, startY: e.clientY, baseX: el.offsetLeft, baseY: el.offsetTop, moved: false };
    el.setPointerCapture?.(e.pointerId);
  };
  const onDragMove = (e) => {
    const d = drag.current; const el = boxRef.current;
    if (!d || !el || d.id !== e.pointerId) return;
    const dx = e.clientX - d.startX; const dy = e.clientY - d.startY;
    if (!d.moved && !isDragMove(dx, dy)) return;
    d.moved = true;
    setPos(clampPanelPos({ x: d.baseX + dx, y: d.baseY + dy }, {
      w: el.offsetWidth, h: el.offsetHeight,
      vw: globalThis.innerWidth || 0, vh: globalThis.innerHeight || 0,
    }));
  };
  const onDragEnd = (e) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (d.moved) savePref('chat.pos', pos);          // 只有"真拖了"才落盘（点一下不算）
  };

  // 🔴 2026-10-08（用户口径）：「**展开后收起就应该回到默认的左下角角落**」。
  //    ⇒ 把这条规则放在**渲染期**（而不只靠 effect 里 setPos(null) 的时序）：收起时一律按"没有位置"渲染
  //      ⇒ host 不带 `is-pinned` ⇒ 回到 `.gm__corner`（左下角，与表情/设置同一排）。**即使盘里还存着旧位置也不会停在那**。
  // 🔴 2026-10-08（用户口径）：「**本身的快捷短语 UI 在初版就对了**」⇒ 回退到**聊天面板里那一排**（初版），
  //   底栏那个浮层按钮**撤掉**；发出去之后的表现＝**头像旁气泡**（见 `gameLogic/watch.js activeBubbles` ＋ `teamPanel`）。
  const [quickPending, setQuickPending] = useState(null);
  const [quickBusy, setQuickBusy] = useState(false);
  const pub = useStore((s) => s.match?.public ?? null);
  const sendQuick = async (id, arg = null) => {
    const payload = quickMsgPayload([{ id, arg }]);
    if (!canSpeak || unsupported || quickBusy || !payload) return;
    setQuickBusy(true);
    try {
      await net.request('room.quickMsg', payload);
      setQuickPending(null);
    } catch (err) {
      if (isUnsupportedChatError(err)) setUnsupported(true);
      else toastError(err);
    } finally {
      setQuickBusy(false);
    }
  };
  const quickPick = (id) => {
    const p = quickPhraseOf(id);
    if (!p) return;
    if (!p.arg) { sendQuick(id); return; }
    setQuickPending((cur) => (cur?.id === id ? null : { id, tier: null, bond: null }));
  };
  const quickArg = quickPhraseOf(quickPending?.id)?.arg ?? null;
  const quickOptions = quickPending
    ? quickArgOptions(quickArg, { data, room, pub, tier: quickPending.tier, bond: quickPending.bond, stageId: pub?.stageId ?? null })
    : [];
  const quickBook = data.get('bonds') || {};
  const bondLabel = (b) => (quickBook[b] && quickBook[b].name) ? quickBook[b].name : b;
  const quickOn = canSpeak && !unsupported;
  const quickSection = html`<div class="sp-chat__quick" data-chat-quick>
    <span class="sp-chat__quick-label">${t('快捷短语')}</span>
    ${QUICK_PHRASES.map((p) => {
      const ok = canSendQuickNow(p.id);
      const why = quickBlockReason(p.id);
      const label = t(p.msgid, p.arg ? { [p.arg]: '…' } : {});
      return html`<button key=${p.id} type="button" class=${`sp-chat__quick-btn${p.arg ? ' is-arg' : ''}`}
        data-chat-quick-btn=${p.id} disabled=${!quickOn || (p.arg ? why === 'wire' : !ok)}
        title=${ok ? label : why === 'wire' ? t('当前协议不接受这个句式（已报修）') : t('点一下选参数，选完就发')}
        onClick=${() => quickPick(p.id)}>${label}</button>`;
    })}
  </div>
  ${quickPending ? html`<div class="sp-chat__picker" data-chat-picker=${String(quickPending.id)}>
    <button type="button" class="sp-chat__btn" data-chat-pick-cancel onClick=${() => setQuickPending(null)}>${t('取消')}</button>
    ${quickArg === 'chess' ? html`
      <div class="sp-chat__row" data-chat-pick-step="tier">
        <span class="sp-chat__picker-label">${t('阶级')}</span>
        ${chessTiers(data.get('chess')).map((x) => html`<button key=${`t${x}`} type="button"
          class=${`sp-chat__quick-btn${quickPending.tier === x ? ' is-on' : ''}`} data-chat-pick-tier=${x}
          onClick=${() => setQuickPending((c) => ({ ...c, tier: x, bond: null }))}>${x}</button>`)}
      </div>
      ${quickPending.tier != null ? html`<div class="sp-chat__row" data-chat-pick-step="bond">
        <span class="sp-chat__picker-label">${t('盟约')}</span>
        ${chessBondsInTier(data.get('chess'), quickPending.tier).map((b) => html`<button key=${b} type="button"
          class=${`sp-chat__quick-btn${quickPending.bond === b ? ' is-on' : ''}`} data-chat-pick-bond=${b}
          onClick=${() => setQuickPending((c) => ({ ...c, bond: b }))}>${bondLabel(b)}</button>`)}
      </div>` : null}
      ${quickPending.bond ? html`<div class="sp-chat__row" data-chat-pick-step="op">
        <span class="sp-chat__picker-label">${t('干员')}</span>
        ${(quickOptions || []).length
          ? quickOptions.map((o) => html`<button key=${o.value} type="button" class="sp-chat__quick-btn"
              data-chat-pick=${o.value} onClick=${() => sendQuick(quickPending.id, o.value)}>${o.label}</button>`)
          : html`<span class="sp-chat__picker-empty">${t('这个组合下没有干员')}</span>`}
      </div>` : null}` : html`
      <span class="sp-chat__picker-label">${t('选一个：')}</span>
      ${(quickOptions || []).length
        ? quickOptions.map((o) => html`<button key=${o.value} type="button" class="sp-chat__quick-btn"
            data-chat-pick=${o.value} onClick=${() => sendQuick(quickPending.id, o.value)}>${o.label}</button>`)
        : html`<span class="sp-chat__picker-empty">${t('这一条现在没有可选的值')}</span>`}`}
  </div>` : null}`;

  const effPos = posForCollapse(collapsed, pos);
  // 🔴 2026-10-09（D 复核实测抓出的**运行期作用域错**）：我上一版在宿主这里写了 `onToggle?.()`，
  //    而 `onToggle` 只是**子组件 ChatPanel 的 prop**（本文件 :56 的形参），**宿主作用域里没有它**
  //    ⇒ 点遮罩 / 点「收起」都会 `ReferenceError: onToggle is not defined` ⇒ **面板开着一关不掉**。
  //    ⚠️ **`node --check` 抓不到它** —— 那是运行期作用域错误，不是语法错误。
  //    ✅ 正解：宿主作用域里已经有 `setCollapsed`（:154）⇒ 定义**一个**回调，遮罩与「收起」共用，
  //      ⛔ 不新造状态（D 的补丁就是这么给的）。
  const toggleChat = () => setCollapsed((v) => !v);

  return html`<div class=${`sp-chat-host${collapsed ? ' is-collapsed' : ''}${effPos ? ' is-pinned' : ''}`}
      ref=${boxRef} data-chat-host
      style=${effPos ? `left:${effPos.x}px; top:${effPos.y}px; right:auto; bottom:auto;` : ''}
      onPointerMove=${onDragMove} onPointerUp=${onDragEnd} onPointerCancel=${onDragEnd}>
    ${/* 🔴 2026-10-09（D 缺陷单；用户原话「至少把干员的信息也遮好」＋「让玩家打开聊天界面以后无法购买」）：
       **打开态才渲染的遮罩层**。宿主自己的 `pointer-events: none` 是给**收起态**用的（那个设计是对的），
       所以打开时"面板矩形之外"会**穿透到商店 ⇒ 误购**。这一层铺满视口、只吃点击：
         · ⇒ 面板外点不到商店（**误购消失**）；· 半透明压暗 ⇒ 有明确边界（**"遮好了"**）；
         · **点它 = 收起面板**（给了一个统一的退出路径，D 建议的"点外即关"）。
       ⛔ 宿主本身不动（它收 `onPointerMove/Up` 做拖动，改了会破坏拖拽）。
       ⚠️ 别用 `:has()`（本仓 `test/client-static.test.js` 禁止）；用"打开态才渲染"最稳。
       ⚠️ **层级**：遮罩 `z-index: 45`、面板 `z-index: 46`（见 `chat.css`）——
          45 压过局内全部正栈级（最高 `.uframe` 12）⇒ 面板外点不到商店；46 ⇒ 面板自己照常可点。
          C 第一版**没给遮罩 z-index** ⇒ 遮罩铺在最上层**把面板自己盖住**了（D 的实测：面板中心/面板头/
          「收起」按钮/消息列表 的 `elementFromPoint` 全返回 `div.sp-chat__backdrop`）。 */''}
    ${collapsed ? null : html`<div class="sp-chat__backdrop" data-chat-backdrop aria-hidden="true"
      onClick=${toggleChat}></div>`}
    <${ChatPanel} messages=${shown} selfId=${selfId} collapsed=${collapsed}
      unread=${countUnread(shown, seenAt)} canSpeak=${canSpeak} unsupported=${unsupported}
      draft=${draft} sending=${sending}
      chatMode=${room?.chatMode ?? null} mutedCount=${muted.length}
      canSwitch=${canToggleTextChat(room, selfId)}
      onToggle=${toggleChat} onDraft=${setDraft} onSend=${send}
      onSwitch=${switchTextChat}
      quickSection=${quickSection}
      quickText=${(m) => quickTextOfMessage(m, { t, resolve: (kind, arg) => argLabel(kind, arg, { data, room }) })}
      size=${size} onResizeStart=${onResizeStart}
      onToggleMute=${(from) => setMuted((m) => toggleMuted(m, from))}
      onUnmuteAll=${() => setMuted([])}
      onDragStart=${onDragStart} />
  </div>`;
}
