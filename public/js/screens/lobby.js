// Lobby screen: pick 独立模拟 / 同盟模拟 and a difficulty (标准/险境/绝境/终极), create a room,
// or join one with a 同盟密钥 (recent codes remembered) — as a player (加入同盟) or in one of its MAX_SPECTATORS
// spectator seats (观战: room.spectate, also while its match runs; community report #26, a remake feature — the
// official room has none). Shows connection status + ping.
//
// 快速匹配 (3a 野排, C-工作分派-总表-2026-10-07 §5 D-2; reference: simpfun's `room.matchmake`): with 同盟模拟 picked,
// 「快速匹配」 sends `room.matchmake { difficulty }` — the server joins or builds a same-difficulty public waiting
// room and fills it with AI after `matchmakeFillMs` (server/lobby.js). The room state arrives as the usual
// `room.state` push; no new S2C frame.
//
// Difficulty descriptions come from data/config.json `modes[modeId]` when present, else from the
// official act2autochess `modeDataDict` texts embedded below (desc + effectDescList), so the
// screen is complete before data is generated. Rounds: solo 标准 = 9, everything else 14 (+R15
// hidden core on 险境+), per research 00-INDEX §2. Battlefield pool (`modes[].stages`): 标准 always
// plays 战场#01, 险境 draws one of 8, 绝境 / 终极 one of 7 (m01 excluded).
// Texts go through t() (docs/I18N.md); the module-level tables hold msgids (N_) translated where they are shown, the
// config.json mode texts come localized from data.js.

import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { DIFFICULTIES, DIFFICULTY_NAMES, DIFFICULTY_COLORS, ROOM_CODE_LEN, MAX_SEATS, MAX_SPECTATORS, modeIdFor, ERR } from '../../../shared/constants.js';
import { html, Button, Icon, MicroLabel, Panel, TextField, PingPill, AvatarFrame, Tooltip, Spinner, DifficultyIcon, doctorNo } from '../ui/components.js';
import { ServerStatusPill } from '../ui/serverStatusPill.js';
import { toast, toastError } from '../ui/toasts.js';
import { parseInvite, goToServer, currentServer } from '../ui/serverLink.js'; // invite link with a server address
import { GuideButton } from '../ui/guide.js';
import { LoadoutButton } from './loadout.js';
import { net, identity } from '../net.js';
import { store, useStore, shallowEqual, loadPref, savePref } from '../store.js';
import { AVATAR_PREF, avatarSrc, openAvatarPicker } from '../ui/avatarPicker.js';
import { getConfig, getMode, getStage, useData } from '../data.js';
import { t, tc, N_ } from '../../../shared/i18n.js';

/**
 * 玩家反馈共享文档（用户 2026-10-08 指定：把「反馈」两个字做成超链接即可）。
 * 放在大厅顶栏（`topbar__right`）而不是埋在浮层里 —— 反馈入口的可见性就是它的价值。
 * ⚠️ 是**腾讯文档共享表**，不是本仓资源 ⇒ 用真 `<a target="_blank" rel="noopener noreferrer">`，
 *    与 `ui/titlePanels.js` 的外链同一套写法（那里也是 `target=_blank` + `noopener noreferrer`）。
 */
export const FEEDBACK_URL = 'https://docs.qq.com/sheet/DWnhmR3Nya0dhSGJB?tab=BB08J2&scode=';

/** Official mode texts (activity_table act2autochess.modeDataDict), fallback when config.json is absent. */
export const MODE_TEXT = {
  single: {
    FUNNY: { code: 'AC-1', desc: N_('时长较短的模拟训练'), effects: [N_('可以快速完成作战'), N_('常规奖励')] },
    NORMAL: { code: 'AC-2', desc: N_('敌方攻击强度较高的模拟训练'), effects: [N_('可使用盟约数增加'), N_('大幅增加奖励')] },
    HARD: { code: 'AC-3', desc: N_('敌方攻击强度极高的模拟训练'), effects: [N_('作战环境困难'), N_('出现更加危险的敌人')] },
    ABYSS: { code: 'AC-4', desc: N_('敌方攻击强度到达极限的模拟训练'), effects: [N_('作战环境无比困难'), N_('出现极度危险的敌人')] },
  },
  multi: {
    FUNNY: { code: 'AC-1', desc: N_('敌方攻击强度较低的模拟训练'), effects: [N_('作战环境较为温和'), N_('常规奖励')] },
    NORMAL: { code: 'AC-2', desc: N_('敌方攻击强度较高的模拟训练'), effects: [N_('可使用盟约数增加'), N_('大幅增加奖励')] },
    HARD: { code: 'AC-3', desc: N_('敌方攻击强度极高的模拟训练'), effects: [N_('作战环境困难'), N_('出现更加危险的敌人')] },
    ABYSS: { code: 'AC-4', desc: N_('敌方攻击强度到达极限的模拟训练'), effects: [N_('作战环境无比困难'), N_('出现极度危险的敌人')] },
  },
};

/** Battlefield pool per difficulty when config.json is absent (the modes' `stages` lists; same for solo and co-op). */
export const STAGE_POOL = { FUNNY: ['act1autochess_m01'], NORMAL: 8, HARD: 7, ABYSS: 7 };

/**
 * Display name of a stage: stages.json when it is loaded, else derived from the id (act1 m0N → 战场#0N, act2 m0N → 战场#0(N+4)).
 * From the data name only its 战场#NN part (with a (上半) / (下半) mark) — 'Battlefield #NN (First Half)' in English.
 * @param {string} id e.g. 'act1autochess_m01'
 */
export function stageLabel(id) {
  const rec = getStage(id);
  if (rec && typeof rec.name === 'string' && rec.name) {
    const m = rec.name.match(/^(.*?#\d+(?:\s*[(（][^)）]*[)）])?)/);
    return m ? m[1] : rec.name.split(/\s+/)[0];
  }
  const m = String(id || '').match(/^act(\d)autochess_m(\d+)$/);
  return m ? t('战场#{no}', { no: String(Number(m[2]) + (m[1] === '2' ? 4 : 0)).padStart(2, '0') }) : '';
}

/**
 * The battlefield note of a difficulty (official wording): a single-stage pool is fixed ("战场固定为 战场#01"), a larger
 * one is drawn at random ("战场随机（共8张）").
 * @param {string[] | number | null | undefined} stages the mode's `stages` list (or a count)
 * @returns {string} '' when unknown
 */
export function stageNote(stages) {
  if (Array.isArray(stages)) {
    const ids = stages.filter((s) => typeof s === 'string' && s);
    if (ids.length === 1) { const name = stageLabel(ids[0]); return name ? t('战场固定为 {name}', { name }) : t('战场固定'); }
    return ids.length > 1 ? t('战场随机（共{n}张）', { n: ids.length }) : '';
  }
  return Number.isInteger(stages) && stages > 1 ? t('战场随机（共{stages}张）', { stages }) : '';
}

const MODE_CARDS = [
  {
    id: 'solo', name: N_('独立模拟'), en: 'SOLO SIMULATION', icon: 'user',
    desc: N_('独自调配资金与干员，以自己的节奏完成整场模拟。'),
    points: [N_('1 名博士'), N_('休整期与机变阶段不限时')],
  },
  {
    id: 'coop', name: N_('同盟模拟'), en: 'ALLIANCE SIMULATION', icon: 'users',
    desc: N_('与至多 {n} 名博士组成同盟，共享干员池，联防协作抵御敌潮。'), params: { n: MAX_SEATS - 1 },
    points: [N_('1–{n} 名博士 · 可由 AI 队友补位'), N_('联防阶段 · 最终攻势合并生命值')], pointParams: { n: MAX_SEATS },
  },
];

/**
 * Text for a difficulty card, preferring data/config.json.
 * @param {'solo'|'coop'} roomMode
 * @param {string} difficulty
 * @returns {{ code: string, desc: string, effects: string[], rounds: number, hidden: boolean, stageNote: string }}
 */
export function difficultyInfo(roomMode, difficulty) {
  const fallback = MODE_TEXT[roomMode === 'solo' ? 'single' : 'multi'][difficulty] || { code: '', desc: '', effects: [] };
  // modeIdFor() lower-cases the difficulty: never call it with a value the server did not validate.
  const m = DIFFICULTIES.includes(difficulty) ? getMode(modeIdFor(roomMode, difficulty)) : null;
  const effects = Array.isArray(m?.effectDescList)
    ? m.effectDescList.map((e) => String(e).replace(/^[·•・･\s]+/, '')).filter(Boolean)
    : fallback.effects.map((e) => t(e));
  const rounds = Number.isFinite(m?.lastRound) ? m.lastRound : roomMode === 'solo' && difficulty === 'FUNNY' ? 9 : 14;
  return {
    code: typeof m?.code === 'string' ? m.code : fallback.code,
    desc: typeof m?.desc === 'string' ? m.desc : t(fallback.desc),
    effects,
    rounds,
    hidden: difficulty !== 'FUNNY',
    stageNote: stageNote(Array.isArray(m?.stages) && m.stages.length ? m.stages : STAGE_POOL[difficulty]),
  };
}

const CODE_RE = new RegExp(`^[A-Z0-9]{${ROOM_CODE_LEN}}$`);
/**
 * Normalise user input into a room code: accepts a pasted invite link (`…?room=ABCD`), keeps
 * upper-cased alphanumerics and clamps to the code length.
 * @param {string} v
 * @returns {string}
 */
export function normalizeCode(v) {
  let s = String(v ?? '');
  const m = s.match(/[?&]room=([A-Za-z0-9]+)/);
  if (m) s = m[1];
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, ROOM_CODE_LEN);
}

/**
 * The 加入同盟 field's own input transform: an invite link / address has to stay **verbatim** in the box
 * (`normalizeCode` would keep only the `?room=` code and drop the host, which is the whole point of the link),
 * while a bare key is normalised as before. Scheme-relative input is left alone too: a partially typed
 * `http` must not be upper-cased into an unusable prefix.
 * @param {string} v
 * @returns {string}
 */
function transformJoinInput(v) {
  const raw = String(v ?? '');
  return /[./:]/.test(raw) ? raw.trim() : normalizeCode(raw);
}

/**
 * A handler that Preact binds as `onClick=${fn}` receives the click EVENT as its first argument, and a default
 * parameter only applies to `undefined` — so `fn(c = code)` would normalise the event target into a nonsense code
 * (`String(el)` → `"[object HTMLElement]"` → "OBJE"). Only a string is ever a code; anything else falls back to the
 * input field. Returns null when neither yields a well-formed code.
 * @param {unknown} arg the argument a handler was called with
 * @param {string} field the current input-field value
 * @returns {string|null}
 */
export function codeArg(arg, field) {
  const k = normalizeCode(typeof arg === 'string' ? arg : field);
  return CODE_RE.test(k) ? k : null;
}

/**
 * Room code from a deep link query string (`?room=CODE`), or null when absent/malformed.
 * Accepts ROOM_CODE_LEN..ROOM_CODE_LEN+2 alphanumerics (the protocol's join limit).
 * @param {string} search e.g. location.search
 * @returns {string|null}
 */
export function parseRoomParam(search) {
  try {
    const raw = new URLSearchParams(search || '').get('room');
    if (!raw) return null;
    const code = raw.trim().toUpperCase();
    if (!/^[A-Z0-9]+$/.test(code)) return null;
    return code.length >= ROOM_CODE_LEN && code.length <= ROOM_CODE_LEN + 2 ? code : null;
  } catch {
    return null;
  }
}

/** Recently joined/created co-op room codes (most recent first). */
export function recentRooms() {
  const list = loadPref('recentRooms', []);
  return Array.isArray(list) ? list.filter((c) => typeof c === 'string' && CODE_RE.test(c)).slice(0, 4) : [];
}

/** @param {string} code */
export function rememberRoom(code) {
  if (!CODE_RE.test(code)) return;
  savePref('recentRooms', [code, ...recentRooms().filter((c) => c !== code)].slice(0, 4));
}

const FALLBACK_TIPS = [
  N_('联合模拟在选择策略时可以进行一次跳过'),
  N_('调度中心即使冻结，依然可以主动刷新'),
  N_('两件同名装备可以合成一件更强力的装备'),
  N_('只有达成完美作战的队友可以进行联防'),
];
const TIP_ROTATE_MS = 5000; // matchingTipRotateInterval

/** Rotating tactical tips (config.json `tips`, weighted list of { tip, weight }). */
function TipsPanel() {
  const cfg = getConfig();
  const fallback = FALLBACK_TIPS.map((x) => t(x));
  const tips = Array.isArray(cfg?.tips)
    ? cfg.tips.map((x) => (typeof x === 'string' ? x : x?.tip)).filter((x) => typeof x === 'string' && x)
    : fallback;
  const list = tips.length ? tips : fallback;
  const [idx, setIdx] = useState(() => Math.floor(Math.random() * list.length));
  useEffect(() => {
    const id = setInterval(() => setIdx((i) => i + 1), TIP_ROTATE_MS);
    return () => clearInterval(id);
  }, []);
  const i = ((idx % list.length) + list.length) % list.length;
  return html`<div class="tips brackets">
    <div class="tips__head">
      <${Icon} name="info" />
      <span>${t('作战提示')}</span>
      <${MicroLabel}>TACTICAL TIPS<//>
      <span class="tips__idx num">${String(i + 1).padStart(2, '0')}<span class="t-dim">/${String(list.length).padStart(2, '0')}</span></span>
      <button type="button" class="tips__nav" onClick=${() => setIdx(i - 1 + list.length)} aria-label=${t('上一条')}><${Icon} name="chevronLeft" /></button>
      <button type="button" class="tips__nav" onClick=${() => setIdx(i + 1)} aria-label=${t('下一条')}><${Icon} name="chevronRight" /></button>
    </div>
    <p key=${i} class="tips__text">${list[i]}</p>
  </div>`;
}

function ModeCard({ card, selected, onSelect }) {
  return html`<button type="button" class=${`mode-card brackets${selected ? ' is-selected' : ''}`} onClick=${() => onSelect(card.id)}
      aria-pressed=${selected ? 'true' : 'false'}>
    <span class="mode-card__bg" aria-hidden="true"></span>
    <span class="mode-card__icon"><${Icon} name=${card.icon} /></span>
    <span class="mode-card__text">
      <${MicroLabel} tone=${selected ? 'mint' : undefined}>${card.en}<//>
      <span class="mode-card__name">${t(card.name)}</span>
      <span class="mode-card__desc">${t(card.desc, card.params)}</span>
      <span class="mode-card__points">${card.points.map((p) => html`<span key=${p}>${t(p, card.pointParams)}</span>`)}</span>
    </span>
    <span class="mode-card__check" aria-hidden="true"><${Icon} name="check" />${t('已选定')}</span>
  </button>`;
}

function DifficultyCard({ roomMode, difficulty, selected, onSelect }) {
  const info = difficultyInfo(roomMode, difficulty);
  return html`<button type="button" class=${`diff-card${selected ? ' is-selected' : ''}`}
      style=${`--d-color:${DIFFICULTY_COLORS[difficulty]}`} onClick=${() => onSelect(difficulty)} aria-pressed=${selected ? 'true' : 'false'}>
    <span class="diff-card__bar" aria-hidden="true"></span>
    <span class="diff-card__head">
      <${DifficultyIcon} difficulty=${difficulty} class="diff-card__glyph" />
      <span class="diff-card__name">${t(DIFFICULTY_NAMES[difficulty])}</span>
      <span class="diff-card__code num">${info.code}</span>
      <span class="diff-card__meta">
        <span class="num">${info.rounds}</span> ${tc('rounds', '回合')}${info.hidden ? html`<span class="diff-card__hidden">${t('+ 隐秘核心')}</span>` : null}
      </span>
    </span>
    <span class="diff-card__desc">${info.desc}</span>
    <span class="diff-card__effects">${info.effects.map((e) => html`<span key=${e}>${e}</span>`)}${info.stageNote ? html`<span key="stage" class="diff-card__stage"><${Icon} name="rook" />${info.stageNote}</span>` : null}</span>
    <span class="diff-card__check" aria-hidden="true"><${Icon} name="check" /><span>${t('已选定')}</span></span>
  </button>`;
}


/** Lobby screen component. */
export function LobbyScreen() {
  const me = useStore((s) => s.me, shallowEqual);
  const conn = useStore((s) => s.connection, shallowEqual);
  useData('config');
  const [roomMode, setRoomMode] = useState(() => (loadPref('lobby.mode', 'coop') === 'solo' ? 'solo' : 'coop'));
  const [difficulty, setDifficulty] = useState(() => {
    const d = loadPref('lobby.difficulty', 'FUNNY');
    return DIFFICULTIES.includes(d) ? d : 'FUNNY';
  });
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(null);
  const [recent] = useState(recentRooms);
  const alive = useRef(true);
  const inFlight = useRef(false); // synchronous guard against double clicks (state updates are async)
  useEffect(() => () => { alive.current = false; }, []);

  const online = conn.status === 'online';
  // 🔴 2026-10-08（用户口径）：**匹配中锁住其它入口** —— 不能改难度／切独立模拟／开房；
  //    但**干员调配与公告照常可用**（它们不在这条路上，故一行都不用改）。
  const matchingNow = !!useStore((s) => s.matchSearch === undefined ? null : s.matchSearch);
  // 🆕 W-6：自己的头像 —— store 里优先（选完立刻重渲染），否则读偏好（刷新后仍在）；都没有 ⇒ null ⇒ 首字母字形。
  const chosenAvatar = useStore((s) => s.ui?.avatarId) || loadPref(AVATAR_PREF, '');
  const lockPick = (fn) => (matchingNow ? () => toast(t('匹配中：模拟方式与难度已锁定（取消匹配后可改）'), 'warn') : fn);
  const codeOk = CODE_RE.test(normalizeCode(code));
  // A pasted invite link may carry the host it belongs to (`https://host/?room=ABCD`, `192.168.1.5:3000`).
  // An address that is NOT the server we are already on switches us over; anything else is an ordinary
  // local join, which is what a bare alliance key has always been.
  const invite = parseInvite(code);
  const switchTo = invite && invite.server !== currentServer() ? invite : null;

  const pickMode = (m) => { setRoomMode(m); savePref('lobby.mode', m); };
  const pickDifficulty = (d) => { setDifficulty(d); savePref('lobby.difficulty', d); };

  const run = async (kind, fn) => {
    if (inFlight.current) return;
    if (!online) { toast(t('尚未连接到服务器，请稍候'), 'warn'); return; }
    inFlight.current = true;
    setBusy(kind);
    try { await fn(); } catch (err) { toastError(err); } finally {
      inFlight.current = false;
      if (alive.current) setBusy(null);
    }
  };
  // 🔴 2026-10-08（C 派工 B-C2 的"建房那半"；用户已拍「**打字默认关闭**」）：
  //    建房时**显式**把默认发出去 —— A 的服务端口径是「**不提 = open（能打字）**，只把 `'quick'` 当"关打字"」
  //    （`server/lobby.js:526` `const quickOnly = chatMode === 'quick'`），所以"默认关闭"**必须由客户端说出口**；
  //    否则这个客户端建出来的房会默认**能**打字，与用户裁定相反（而且不报错）。
  //    房主之后可在**房内聊天面板头部**改（用户裁的入口；只在对局开始前 —— 服务端 `WRONG_PHASE` 强制）。
  const create = () => run('create', () => net.request('room.create', { mode: roomMode, difficulty, chatMode: 'quick' }));
  // 野排快速匹配 (3a; 服务端 server/lobby.js `matchmake`): 同难度自动组队，满 MAX_SEATS 人开局；
  // 池子里没人就在 matchmakeFillMs 后用 AI 补齐开局。**不新造 S2C**：房间状态继续由 room.state 推送更新。
  // 只在 coop 显示（solo 没有"组队"一说，服务端也只往 coop 房放人）。
  // 🆕 2026-10-08（用户口径「下一步就做匹配的浮层」→「匹配页面依然是房间内页面」）：
  //    **匹配中的状态与界面都挪到 `ui/matchOverlay.js`**（状态放 store ⇒ 跨屏；大厅与房间各渲染一次同一份组件）。
  //    ⛔ 这里不再自己维护 `matching/matchQueue/matchNow` 与那段浮层标记（两处实现迟早分叉）。
  /**
   * **快速匹配（野排）**。三条现场教训都写在这里（都真发生过，且都崩过屏）：
   *  ① ⛔ 不许写 `account.*` —— 我们这棵树**没有账号模式**（`ui/accountMenu.js` 不存在，那是上游才有）⇒ `account is not defined`；
   *  ② 就绪变量叫 **`online`**（上游那版叫 `ready`）⇒ 抄错就 `ready is not defined`；
   *  ③ 匹配状态放 **store**（跨屏）：服务端会**立刻**推 `room.state`、界面马上切到房间屏 ——
   *     浮层若只长在本屏就会随卸载消失（用户实测"匹配页面依然是房间内页面"）⇒ 现在**两屏都渲染** `<MatchOverlay/>`。
   */
  const matchmake = async () => {
    if (inFlight.current) return;
    if (!online) { toast(t('尚未连接到服务器，请稍候'), 'warn'); return; }
    inFlight.current = true;
    setBusy('matchmake');
    store.set({ matchSearch: { at: Date.now() } });
    try {
      await net.request('room.matchmake', { difficulty });
      // 成功 ⇒ `room.state` 马上到、界面切到房间屏；**浮层继续在那里计时**（直到开局或取消）
    } catch (err) {
      toastError(err);
      store.set({ matchSearch: null });
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(null);
    }
  };
  const join = (c = code) => {
    // `onClick=${join}` hands the click EVENT as the first argument, and a default parameter only applies to
    // `undefined` — codeArg keeps an event target out of the key and falls back to the input field
    // A link to somebody else's server: hand the whole thing to the page reload (see ui/serverLink.js).
    // Not run() - there is no request to make here, and the reload replaces this screen anyway.
    // ⚠️ 这一段**必须在 codeArg 之前**：codeArg/normalizeCode 对链接也会"成功"（只抽出 ?room= 的密钥），
    //    结果是**静默连到本机服务器**而不是链接里那台。
    const target = parseInvite(typeof c === 'string' ? c : code);
    if (target && target.server !== currentServer()) {
      toast(`正在连到 ${target.server} …`, 'info', { ttl: 2500 });
      goToServer(target.server, target.room);
      return;
    }
    const k = codeArg(c, code);
    if (!k) { toast(t('同盟密钥为 {ROOM_CODE_LEN} 位字母或数字', { ROOM_CODE_LEN }), 'warn'); return; }
    run('join', () => net.request('room.join', { code: k }));
  };
  // a spectator seat: no player seat taken, nothing to do but watch (also a match already running)
  const spectate = (c = code) => {
    // same guard as join: `onClick=${spectate}` passes the click event, not a code
    const k = codeArg(c, code);
    if (!k) { toast(t('同盟密钥为 {ROOM_CODE_LEN} 位字母或数字', { ROOM_CODE_LEN }), 'warn'); return; }
    run('spectate', () => net.request('room.spectate', { code: k }).catch((err) => {
      // Clearer than the bare ERR_TEXT: the usual cause is a code that is not the host's (a remembered one from an
      // earlier room, or another machine's) — the server can only answer "no such room".
      if (err?.code === ERR.ROOM_NOT_FOUND) {
        toast(t('没有找到密钥 {k} 对应的同盟：请和房主核对密钥（同盟结束后密钥即失效）', { k }), 'warn');
        return;
      }
      if (err?.code === ERR.ALREADY) {
        toast(t('你已经是该同盟的博士：先离开同盟，才能以观战身份进入'), 'warn');
        return;
      }
      throw err;
    }));
  };
  const backToTitle = () => {
    identity.setEntered(false);
    store.set((s) => ({ session: { ...s.session, entered: false } }));
  };

  return html`<div class="screen lobby-screen">
    <header class="topbar">
      <div class="topbar__left">
        <${Button} variant="ghost" size="sm" icon="chevronLeft" onClick=${backToTitle} title=${t('返回标题')}>${t('返回')}<//>
        <${PingPill} ms=${conn.ping} online=${online} />
        <${ServerStatusPill} compact=${true} />
      </div>
      <div class="topbar__center">
        <${MicroLabel} tone="mint">SIMULATION PROTOCOL SELECT<//>
        <h1 class="topbar__title">${t('选择模拟协议')}</h1>
      </div>
      <div class="topbar__right">
        <${GuideButton} class="lobby-guide" variant="secondary" label=${t('玩法说明')} />
        <${LoadoutButton} from="lobby" size="sm" class="lobby-loadout" label=${t('干员调配')} />
        <a class="btn btn--ghost btn--sm lobby-feedback" data-testid="feedback-link" href=${FEEDBACK_URL}
            target="_blank" rel="noopener noreferrer" title=${t('反馈与建议 · 共享文档（新窗口打开）')}>
          <${Icon} name="link" class="btn__icon" /><span class="btn__label">${t('反馈')}</span>
        </a>
        <div class="me-chip">
          <${AvatarFrame} size="sm" name=${me.name} src=${avatarSrc(chosenAvatar)} seat=${0} self=${true} />
        <button type="button" class="btn btn--secondary btn--sm" data-avatar-open title=${t('选择头像')}
          style="flex:none; white-space:nowrap; min-width:max-content;"
          onClick=${() => openAvatarPicker()}>${t('换头像')}</button>
          <div class="me-chip__text">
            <span class="me-chip__name">${me.name || t('博士')}</span>
            <${MicroLabel}>${me.playerId != null ? `DOCTOR #${doctorNo(me.playerId)}` : 'DOCTOR'}<//>
          </div>
        </div>
      </div>
    </header>

    <div class="lobby-body screen__scroll">
      <section class="lobby-left">
        <div class="section-label"><span class="section-label__idx num">01</span>${t('模拟方式')}<${MicroLabel}>MODE<//></div>
        <div class="mode-cards">
          ${MODE_CARDS.map((c) => html`<${ModeCard} key=${c.id} card=${c} selected=${roomMode === c.id} onSelect=${lockPick(pickMode)} />`)}
        </div>

        <div class="section-label"><span class="section-label__idx num">03</span>${t('加入同盟')}<${MicroLabel}>JOIN WITH ALLIANCE KEY<//></div>
        <${Panel} class="join-panel" tone="amber">
          <div class="join-row">
            <${TextField} size="code" icon="key" value=${code} placeholder=${t('输入同盟密钥 / 粘贴邀请链接')}
              transform=${transformJoinInput} onInput=${(v) => setCode(transformJoinInput(v))} onEnter=${() => join()} />
            <${Button} variant="amber" size="lg" icon="users" loading=${busy === 'join'} disabled=${!codeOk || !online} onClick=${() => join()}>${t('加入同盟')}<//>
            <${Tooltip} text=${t('以观战者身份进入：不占博士席位，只能观看（每个同盟最多 {MAX_SPECTATORS} 名，模拟进行中也可进入）', { MAX_SPECTATORS })}>
              <${Button} variant="secondary" size="lg" icon="eye" class="join-spectate" loading=${busy === 'spectate'} disabled=${!codeOk || !online} onClick=${spectate}>${t('观战')}<//>
            <//>
          </div>
          ${switchTo ? html`<div class="join-foot">
              <span class="t-lo">${t('将切换到好友的服务器')}</span>
              <span class="code-chip num">${switchTo.server}</span>
              ${switchTo.room ? html`<span class="t-dim">${t('，并加入同盟')} <span class="num">${switchTo.room}</span></span>` : null}
            </div>`
            : html`<div class="join-foot">
            ${recent.length ? html`<span class="t-lo">${t('最近的同盟')}</span>
              ${recent.map((c) => html`<button key=${c} type="button" class="code-chip num" title=${t('填入密钥（不会直接加入）')}
                onClick=${() => setCode(c)}>${c}</button>`)}`
              : html`<span class="t-dim">${t('向同伴索取 {ROOM_CODE_LEN} 位同盟密钥，或直接打开邀请链接', { ROOM_CODE_LEN })}</span>`}
          </div>`}
        <//>
        <${TipsPanel} />
      </section>

      <section class="lobby-right">
        <div class="section-label"><span class="section-label__idx num">02</span>${t('模拟难度')}<${MicroLabel}>DIFFICULTY<//></div>
        <div class="diff-list">
          ${DIFFICULTIES.map((d) => html`<${DifficultyCard} key=${d} roomMode=${roomMode} difficulty=${d} selected=${difficulty === d} onSelect=${lockPick(pickDifficulty)} />`)}
        </div>
        <div class="create-box">
          <${Tooltip} block=${true} text=${online ? null : t('正在连接服务器…')}>
            <${Button} variant="primary" size="xl" block=${true} iconRight="chevrons" loading=${busy === 'create'} disabled=${!online || matchingNow} onClick=${create}>
              ${roomMode === 'solo' ? t('开始独立模拟') : t('创建同盟')}
            <//>
          <//>
          <div class="create-box__hint">
            ${online
              ? html`<span>${roomMode === 'solo' ? t('创建后即可开始模拟') : t('创建后可邀请好友或添加 AI 队友')}</span>`
              : html`<${Spinner} size="sm" label="CONNECTING" />`}
          </div>
          ${roomMode === 'coop' ? html`<${Tooltip} block=${true} text=${online ? null : t('正在连接服务器…')}>
            <${Button} variant="secondary" size="xl" block=${true} icon="users" loading=${busy === 'matchmake'} disabled=${!online} onClick=${matchmake}>${t('快速匹配')}<//>
          <//>
          <div class="create-box__hint">
            ${online
              ? html`<span>${t('同难度自动组队 · 满 {max} 人开局', { max: MAX_SEATS })}</span>`
              : html`<${Spinner} size="sm" label="CONNECTING" />`}
          </div>` : null}
        </div>
      </section>
    </div>
  </div>`;
}
