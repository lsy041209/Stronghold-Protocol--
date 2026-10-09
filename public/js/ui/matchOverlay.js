// matchOverlay.js — **快速匹配浮层**（用户口径：「匹配页面依然是房间内页面」⇒ 匹配中要有自己的界面，
//   而且它必须**跨屏**存在：`room.matchmake` 会立刻把你放进/建好一个房并推 `room.state`，
//   界面马上切到房间屏 —— 浮层如果长在大厅屏里就会随它一起卸载 ⇒ 玩家只看到房间页。）
//
// 做法：状态放 **store**（`s.matchSearch`，跨屏）；浮层由**大厅与房间两屏各渲染一次**（同一份组件），
//   它自己带计时与 `/healthz` 轮询 ⇒ 换屏不打断计时。开局（`room.inMatch`）或用户取消 ⇒ 清掉。
import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html } from './components.js';
import { store, useStore } from '../store.js';
import { net } from '../net.js';
import { t } from '../../../shared/i18n.js';

/**
 * 匹配浮层的**纯逻辑**（判据落在这里，见 `test/ui/lobby-matching.test.js`）。
 * 口径：服务端 `matchmakeFillMs`（默认 60s）之前是"在找人"，之后是"等 AI 补满"；
 * `/healthz` 的 `matchmaking` = **正在凑人的房数**（照纸鸢那条线补的可观测字段）。
 * @param {number} waitedMs 已等待毫秒
 * @param {number} [fillMs] 服务端补齐时限（拿不到就用 60000）
 * @param {number} [queue] `/healthz.matchmaking`（NaN = 还没拿到）
 */
export function matchingStatus(waitedMs, fillMs = 60000, queue = NaN) {
  const waited = Number.isFinite(waitedMs) && waitedMs > 0 ? waitedMs : 0;
  const fill = Number.isFinite(fillMs) && fillMs > 0 ? fillMs : 60000;
  const q = queue == null || queue === '' ? NaN : Number(queue);   // ⚠️ `null` 是"还没拿到"，**不是 0**
  return {
    elapsed: Math.floor(waited / 1000),
    phase: waited >= fill ? 'filling' : 'searching',
    fillIn: Math.max(0, Math.ceil((fill - waited) / 1000)),
    queueText: Number.isFinite(q) ? String(Math.max(0, Math.trunc(q))) : '—',
  };
}

/**
 * 开局了（对局开始）或不在匹配 ⇒ 浮层不该再显示。
 * @param {{at?:number}|null} search `s.matchSearch`
 * @param {boolean} inMatch `!!s.room?.inMatch`
 */
export function shouldShowMatch(search, inMatch) {
  return !!search && !inMatch;
}

/** 匹配中**其它入口要被锁**（用户口径：不能开其它难度／独立模拟／开房；干员调配与公告仍可用）。 */
export function matchLocksLobby(search) {
  return !!search;
}

/** 快速匹配浮层本体（大厅屏与房间屏各渲染一次；状态与计时都在 store/自身，换屏不中断）。 */
export function MatchOverlay() {
  const search = useStore((s) => s.matchSearch);
  const inMatch = useStore((s) => !!s.room?.inMatch);
  const [queue, setQueue] = useState(NaN);
  const [now, setNow] = useState(() => Date.now());
  const show = shouldShowMatch(search, inMatch);

  useEffect(() => {
    if (!show) return undefined;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = () => {
      try {
        fetch('/healthz').then((r) => r.json()).then((h) => setQueue(Number(h?.matchmaking))).catch(() => {});
      } catch { /* ignore */ }
    };
    poll();
    const pollId = setInterval(poll, 3000);
    return () => { clearInterval(tick); clearInterval(pollId); };
  }, [show]);

  if (!show) return null;
  const ms = matchingStatus(now - (Number(search.at) || 0), 60000, queue);
  const collapsed = search.collapsed === true;
  const setCollapsed = (v) => store.set({ matchSearch: { ...search, collapsed: v } });
  const cancel = () => {
    store.set({ matchSearch: null });
    net.request('room.leave', {}).catch(() => {});     // 已进房就退出来；还在路上则无害失败
  };
  // 🔴 2026-10-08（用户口径）：**收起后计时条显示在所有页面上方**，旁边一个 ❌ 取消匹配；
  //    所以这个组件挂在 **app 外壳**（`main.js`）里 ⇒ 任何一屏都在。展开态则是一个居中浮层（可再收起）。
  if (collapsed) {
    return html`<div class="match-bar" data-match-bar
      style="position:fixed; top:0; left:50%; transform:translateX(-50%); z-index:9500; display:flex; align-items:center; gap:8px;
             padding:4px 10px; border:1px solid rgba(255,207,90,.6); border-top:0; border-radius:0 0 8px 8px; background:rgba(12,16,15,.96);">
      <button type="button" class="btn btn--ghost btn--sm" data-match-expand title=${t('展开匹配面板')}
        style="font-variant-numeric:tabular-nums;" onClick=${() => setCollapsed(false)}>
        ⏱ ${ms.elapsed}s ｜ ${t('匹配中')}
      </button>
      <button type="button" class="btn btn--secondary btn--sm" data-match-cancel title=${t('取消匹配')}
        aria-label=${t('取消匹配')} onClick=${cancel}>✕</button>
    </div>`;
  }
  return html`<div class="match-ov" data-match-overlay
    style="position:fixed; inset:0; z-index:9000; display:flex; align-items:center; justify-content:center; background:rgba(0,0,0,.55);">
    <div style="min-width:min(24rem,86vw); padding:16px 18px; border:1px solid rgba(255,255,255,.22); border-radius:10px; background:rgba(12,16,15,.98); box-shadow:0 10px 40px rgba(0,0,0,.7); text-align:center;">
      <div style="font-size:12px; opacity:.7; letter-spacing:.08em;">${t('快速匹配')}</div>
      <div style="font-size:15px; margin:8px 0 2px;" data-match-phase=${ms.phase}>
        ${ms.phase === 'searching' ? t('正在为你寻找同难度的公开同盟…') : t('已到补齐时间，AI 队友马上入场…')}
      </div>
      <div style="display:flex; align-items:center; justify-content:center; gap:8px; margin:2px 0;">
        <span style="font-size:30px; font-variant-numeric:tabular-nums;" data-match-elapsed=${ms.elapsed}>${ms.elapsed}s</span>
        <button type="button" class="btn btn--secondary btn--sm" data-match-cancel title=${t('取消匹配')}
          aria-label=${t('取消匹配')} onClick=${cancel}>✕</button>
      </div>
      <div style="font-size:12px; opacity:.75; margin-top:4px;">${t('最多再等 {n} 秒，之后由 AI 补满开局', { n: ms.fillIn })}</div>
      <div style="font-size:12px; opacity:.75; margin-top:2px;" data-match-queue=${ms.queueText}>
        ${t('正在凑人的同盟：{q} 个', { q: ms.queueText })}
      </div>
      <div style="font-size:11px; opacity:.6; margin-top:6px;">${t('已经在等待室里等你了 —— 可以先去干员调配，开局会自动进入')}</div>
      <div style="display:flex; gap:8px; justify-content:center; margin-top:12px;">
        <button type="button" class="btn btn--secondary btn--sm" data-match-collapse onClick=${() => setCollapsed(true)}>${t('收起')}</button>
        <button type="button" class="btn btn--secondary btn--sm" data-match-cancel-2 onClick=${cancel}>${t('取消匹配')}</button>
      </div>
    </div>
  </div>`;
}
