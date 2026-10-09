// 干员皮肤：客户端状态与同步 (docs/SKINS.md).
//
// ⚠️ 本 fork 是**全量内置版**（174 套 / 115 干员），**没有**「按需安装」这一层 —— 上游 `0.1.6-pre-skin` 的
//    `server/skinInstall.js` 与 `room.skin.install` 我们**没有移植、也不要**（理由与对照表见 docs/SKINS.md 顶部）。
//    两份数据各司其职：
//
//   * 目录 (data/skins.json) —— 干员 → 皮肤 id / 名称 / 系列，**不带 URL**（这个文件的职责就是「有哪些」）。
//   * 素材 (data/assets.json → chars[charId].skins) —— 每套皮肤的 avatar / spine 落盘地址，由 assets 管线生成。
//
// 选择本身是 `{ [chessId]: skinId }`，按浏览器存 localStorage，并经 `room.skins` 镜像到服务端 —— 形状与接线
// 跟干员调配（ui/loadoutSync.js）一样，区别是这份是 **PUBLIC**：服务端把它放进 `Match.publicView().players[]`，
// 队友因此能看到你穿的皮肤。
// ⚠️ 键必须是 **chessId**，而目录按 **operator id** 分组；两者混用会**静默清空**选择（docs/SKINS.md §3）。

import { createStore, loadPref, savePref } from '../store.js';
import { data } from '../data.js';

export const SKINS_PREF = 'skins';
export const SYNC_DEBOUNCE_MS = 500;
export const RETRY_MS = 1500;

function readStored() {
  const raw = loadPref(SKINS_PREF, null);
  const out = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [chessId, skinId] of Object.entries(raw)) {
      if (typeof chessId === 'string' && typeof skinId === 'string' && skinId) out[chessId] = skinId;
    }
  }
  return out;
}

/**
 * The chosen skins (per browser), the sync state, and the skin currently being installed — kept apart from the
 * app store for the same reason the loadout is.
 */
export const skinsStore = createStore({ entries: readStored(), sync: 'idle' });

/** Replace the whole selection (persisted at once; the sync picks the change up). */
export function setSkins(entries) {
  const next = {};
  for (const [chessId, skinId] of Object.entries(entries && typeof entries === 'object' ? entries : {})) {
    if (typeof skinId === 'string' && skinId) next[chessId] = skinId;
  }
  savePref(SKINS_PREF, next);
  skinsStore.set({ entries: next });
}

/** Choose a skin for one operator. */
export function setSkin(chessId, skinId) {
  setSkins({ ...skinsStore.get().entries, [chessId]: skinId });
}

/** Drop one operator's choice (it goes back to its default model). */
export function clearSkin(chessId) {
  const next = { ...skinsStore.get().entries };
  delete next[chessId];
  setSkins(next);
}

/** The skin this browser picked for an operator, or null. */
export const skinFor = (chessId) => skinsStore.get().entries[chessId] || null;

/**
 * Every skin of an operator (built-in full set).
 *
 * Takes the OPERATOR id (`char_498_inside`), not the chess id (`chess_char_1_01_a`): both data/skins.json and
 * data/assets.json are grouped per operator, while a skin *choice* is stored per chess — see ui/skinPicker.js.
 * @param {string} charId
 * @returns {{ id: string, name: string, group: string }[]}
 */
export function availableSkins(charId) {
  const list = data.get('skins')?.chars?.[charId];
  if (!Array.isArray(list)) return [];
  return list.map((s) => ({ id: s.id, name: s.name, group: s.group || '' }));
}

/** Load what the picker needs (the catalogue, and the manifest that says which files are on disk). */
export function loadSkinData() {
  data.load('skins').catch(() => {});
  data.load('assets').catch(() => {});
}

/**
 * Keep the server's copy of this browser's skins current.
 *
 * Mirrors installLoadoutSync, minus the sanitising: the loadout has to be checked against data/chess.json before
 * it is sent (a stale entry would be dropped by the server), whereas a skinId needs no lookup to be sent — the
 * server keeps the entries whose chess it recognises and drops the rest, and an unknown skinId is harmless.
 * @param {{ net: any, timers?: { setTimeout: Function, clearTimeout: Function } }} deps
 * @returns {{ flush: () => Promise<void>, dispose: () => void }}
 */
export function installSkinsSync({ net, timers } = {}) {
  const T = timers || { setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: (id) => globalThis.clearTimeout(id) };
  let timer = null;
  let seq = 0;
  let pendingJson = null;
  let lastSent = null;
  let disposed = false;

  const setState = (sync) => { if (skinsStore.get().sync !== sync) skinsStore.set({ sync }); };
  const schedule = (ms = SYNC_DEBOUNCE_MS) => {
    if (disposed) return;
    T.clearTimeout(timer);
    setState('pending');
    timer = T.setTimeout(() => { timer = null; void flush(); }, ms);
  };

  async function flush() {
    if (disposed || net.status !== 'online') { setState('idle'); return; }
    try {
      const skins = skinsStore.get().entries;
      const json = JSON.stringify(skins);
      if (json === pendingJson) return;
      if (json === lastSent && pendingJson == null) { setState('synced'); return; }
      const my = ++seq;
      pendingJson = json;
      setState('sending');
      try {
        await net.request('room.skins', { skins });
        if (my !== seq) return;
        pendingJson = null;
        lastSent = json;
        setState('synced');
      } catch (err) {
        if (my !== seq) return;
        pendingJson = null;
        const code = err && err.code;
        if (code === 'RATE' || code === 'TIMEOUT' || code === 'OFFLINE') { schedule(RETRY_MS); return; }
        console.warn('[skins] room.skins refused', code, err && err.detail);
        setState('error');
      }
    } catch (e) {
      console.warn('[skins] sync failed', e);
      setState('error');
    }
  }

  const offWelcome = net.on('welcome', () => { lastSent = null; pendingJson = null; seq++; schedule(50); });
  const offStore = skinsStore.subscribe((s, prev) => { if (s.entries !== prev.entries) schedule(); });

  return {
    flush,
    dispose() {
      disposed = true;
      T.clearTimeout(timer);
      offWelcome?.();
      offStore?.();
    },
  };
}
