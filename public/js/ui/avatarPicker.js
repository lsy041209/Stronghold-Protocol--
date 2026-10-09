// avatarPicker.js — **W-6 头像插件（客户端那半）**：选一张个人头像、存本地、自己看得见。
//
// 用户 2026-10-08 晚口径：素材「已经储存了很久」⇒ 今晚做出来；选的是「乙：两半一起做」。
//   · **我这半**（本文件）：素材已在 `public/assets/avatar/`（184 张 PNG ＋ `manifest.json`，185 文件/5.7 MB），
//     这里给一个网格选择器 ＋ 本地持久化（`sp.pref.avatar.id`）＋ 把 `src` 喂给 `AvatarFrame`（大厅名片 / 房间座位）。
//   · **另一半**（别人也看得见）：需要 A 在会话/公开态广播一个 `avatarId`（已派单：
//     `协作/B12给A-W6头像接入素材已入树与要一个avatarId字段-2026-10-08.md`）。
//     ⇒ 我这边**只读**那个字段（`seat.avatarId`），**不造第二套**；字段没到就照旧退回首字母字形。
//
// 口径：协议里**永远不出现文件名/路径** —— 存的是 id（`[a-z0-9_]{1,32}`），id→URL 的映射只在这里。
import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html } from './components.js';
import { store, useStore, loadPref, savePref } from '../store.js';
import { net } from '../net.js';
import { t } from '../../../shared/i18n.js';

/** 本地偏好键（只存 id，不存路径）。 */
export const AVATAR_PREF = 'avatar.id';
/** 清单地址（`public/assets/avatar/manifest.json`，与素材同目录）。 */
export const AVATAR_MANIFEST_URL = '/assets/avatar/manifest.json';

/** 合法 id：与小写 id 同族（`[a-z0-9_]{1,32}`）——⛔ 不许 URL/路径/大写，**也必须是字符串**（数字/对象一律不收）。 */
export function cleanAvatarId(v) {
  if (typeof v !== 'string') return '';
  return /^[a-z0-9_]{1,32}$/.test(v) ? v : '';
}

/**
 * id → 图片 URL。**没有 id 就返回 null**（调用方据此退回首字母字形，而不是显示一个坏图）。
 * ⚠️ 依赖一条不变量：入树时**文件名就是 `<id>.png`**（由 `_b12-avatar-intake.mjs` 保证，判据在钉它）。
 */
export function avatarSrc(id) {
  const k = cleanAvatarId(id);
  return k ? `/assets/avatar/${k}.png` : null;
}

/**
 * 🆕 2026-10-09（用户口径：「局外换完头像，局内头像却换成了策略的头像」）：**局内该显示谁的头像**。
 * 三级来源（前面的赢）：① 对局公开态自带的 `player.avatarId`（A 以后若加） ② `room.seats/spectators` 里那一席的
 * `avatarId`（A 现在广播在 `room.state`，**今天就有**） ③ 自己 ⇒ 本地偏好（`sp.pref.avatar.id`）。
 * ⛔ 一律过 `cleanAvatarId`（不许 URL/路径）；拿不到 ⇒ 返回 `''`（调用方退回策略图标/字形）。
 * @param {{playerId?:string, avatarId?:string}|null} player 局内某个玩家
 * @param {{ room?:any, myId?:string|null, myAvatarId?:string|null }} [ctx]
 */
export function avatarIdForPlayer(player, ctx = {}) {
  const pid = player?.playerId != null ? String(player.playerId) : '';
  const own = cleanAvatarId(player?.avatarId);
  if (own) return own;
  const room = ctx.room;
  const seats = [
    ...(Array.isArray(room?.seats) ? room.seats : []),
    ...(Array.isArray(room?.spectators) ? room.spectators : []),
  ];
  const hit = seats.find((s) => s && String(s.playerId) === pid);
  const fromSeat = cleanAvatarId(hit?.avatarId);
  if (fromSeat) return fromSeat;
  if (pid && ctx.myId != null && pid === String(ctx.myId)) return cleanAvatarId(ctx.myAvatarId);
  return '';
}

/** 打开/关闭选择器（状态放 store ⇒ 外壳里的宿主能反应）。 */
export function openAvatarPicker() { store.set((s) => ({ ui: { ...s.ui, avatarOpen: true } })); }
export function closeAvatarPicker() { store.set((s) => ({ ui: { ...s.ui, avatarOpen: false } })); }

/** 把选择**发给服务器**（A 的 C2S：`{ t:'room.avatar', id }`，空串 = 清掉回默认）。失败无害（只影响别人看不看得见）。 */
export function publishAvatar(id) {
  return net.request('room.avatar', { id: cleanAvatarId(id) }).catch(() => {});
}

/** 选一张（写偏好 ＋ 写 store ＋ **发给服务器**，三处一起动，避免"存了但不重渲染/别人看不见"）。 */
export function chooseAvatar(id) {
  const k = cleanAvatarId(id);
  savePref(AVATAR_PREF, k);
  store.set((s) => ({ ui: { ...s.ui, avatarId: k, avatarOpen: false } }));
  // 🔴 2026-10-09（A 的字段已落地）：**必须发出去**，否则只有自己看得见；服务端**不落盘**（会话级）
  //    ⇒ 重连/重进房后由下面那个 effect 补发一次（见 `AvatarPickerHost`）。
  publishAvatar(k);
}

/** 网格里要用的那一份清单（`{ avatars: [{id,file,label}] }`；坏数据一律当空）。 */
export function pickerItems(manifest) {
  const list = manifest && Array.isArray(manifest.avatars) ? manifest.avatars : [];
  return list
    .map((a) => ({ id: cleanAvatarId(a && a.id), file: a && typeof a.file === 'string' ? a.file : '', label: a && typeof a.label === 'string' ? a.label : '' }))
    .filter((a) => a.id && a.file);
}

/**
 * 宿主（`main.js` 挂一次）⇒ 任何一屏都能弹；点外面关。
 * 挂在 **app 外壳**而不是某个屏：与匹配浮层同理（换屏不丢）。
 */
export function AvatarPickerHost() {
  const open = useStore((s) => !!s.ui?.avatarOpen);
  // ⚠️ 刷新后 store 里没有选中的 id ⇒ 退回读偏好（否则"我选过的头像刷新就没了"）。
  const current = useStore((s) => s.ui?.avatarId) || loadPref(AVATAR_PREF, '');
  const roomCode = useStore((s) => s.room?.code || '');
  // 🔴 服务端**不落盘**（会话级）⇒ 每次进到/回到一个同盟时补发一次，让别人看得到（没选过就不发）。
  useEffect(() => {
    const k = cleanAvatarId(current);
    if (roomCode && k) publishAvatar(k);
    return undefined;
  }, [roomCode, current]);
  const [items, setItems] = useState(null);
  const [err, setErr] = useState(false);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!open || items || err) return undefined;
    let alive = true;
    fetch(AVATAR_MANIFEST_URL)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => { if (alive) setItems(pickerItems(j)); })
      .catch(() => { if (alive) setErr(true); });
    return () => { alive = false; };
  }, [open, items, err]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e?.key === 'Escape') closeAvatarPicker(); };
    globalThis.addEventListener?.('keydown', onKey);
    return () => globalThis.removeEventListener?.('keydown', onKey);
  }, [open]);

  if (!open) return null;
  const q = query.trim().toLowerCase();
  const shown = (items || []).filter((a) => !q || a.id.includes(q) || a.label.toLowerCase().includes(q));

  return html`<div class="avpick" data-avatar-picker
    style="position:fixed; inset:0; z-index:9600; display:flex; align-items:center; justify-content:center; background:rgba(0,0,0,.6);"
    onClick=${(e) => { if (e.target === e.currentTarget) closeAvatarPicker(); }}>
    <div style="width:min(46rem,92vw); max-height:80vh; display:flex; flex-direction:column; gap:10px; padding:14px 16px;
                border:1px solid rgba(255,255,255,.22); border-radius:10px; background:rgba(12,16,15,.99); box-shadow:0 10px 40px rgba(0,0,0,.7);">
      <div style="display:flex; align-items:center; gap:10px;">
        <b style="font-size:15px;">${t('选择头像')}</b>
        <span style="font-size:11px; opacity:.6;">${t('共 {n} 张（本地素材，选完立刻生效）', { n: (items || []).length })}</span>
        <span style="flex:1;"></span>
        <button type="button" class="btn btn--secondary btn--sm" data-avatar-clear onClick=${() => chooseAvatar('')}>${t('用默认（首字母）')}</button>
        <button type="button" class="btn btn--secondary btn--sm" data-avatar-close onClick=${() => closeAvatarPicker()}>${t('关闭')}</button>
      </div>
      <div style="font-size:12px; opacity:.7;">${t('别人能否看到取决于服务器设置 —— 在那之前只有你自己看得见。')}</div>
      <input type="text" value=${query} placeholder=${t('筛选（按 id / 名称）')} data-avatar-search
        onInput=${(e) => setQuery(e?.currentTarget?.value ?? '')}
        style="font:inherit; font-size:12px; padding:4px 8px; border:1px solid rgba(255,255,255,.2); border-radius:6px; background:rgba(255,255,255,.06); color:inherit;" />
      ${err ? html`<div style="font-size:12px; color:#ffb4a2;" data-avatar-error>${t('读不到头像清单（{url}）', { url: AVATAR_MANIFEST_URL })}</div>` : null}
      ${items == null && !err ? html`<div style="font-size:12px; opacity:.7;">${t('正在读取…')}</div>` : null}
      <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(64px, 1fr)); gap:6px; overflow:auto; padding:2px;">
        ${shown.map((a) => html`<button key=${a.id} type="button" title=${a.label || a.id} data-avatar-id=${a.id}
          onClick=${() => chooseAvatar(a.id)}
          style=${`padding:0; border:2px solid ${a.id === current ? '#8fd0ff' : 'rgba(255,255,255,.18)'}; border-radius:8px; background:rgba(255,255,255,.05); cursor:pointer; line-height:0;`}>
          <img src=${`/assets/avatar/${a.file}`} alt=${a.label || a.id} loading="lazy"
            style="width:100%; aspect-ratio:1; object-fit:cover; border-radius:6px;" />
        </button>`)}
      </div>
      ${items && !shown.length ? html`<div style="font-size:12px; opacity:.7;">${t('没有匹配的头像')}</div>` : null}
    </div>
  </div>`;
}
