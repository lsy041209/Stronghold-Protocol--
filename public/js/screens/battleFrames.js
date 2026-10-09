/**
 * 战斗帧的接线（`m.field` / `b.snap` / `b.ev`）—— 从 `screens/game.js` 抽出来的**可单测**部分。
 *
 * ## 为什么会有这个文件（2026-10-06，第 5 任 B；现象→根因→规则都记在 `协作/已知问题.md`）
 *
 * 原来这段监听器注册在 `useEffect(..., [view])` 里，而 `onSnap` 读了**组件作用域**的 `field`：
 *   · `field` 的初值是 `null`（`store.js` 的 `emptyMatch()`），而这个 effect 的依赖数组里**没有** `field`
 *     ⇒ **注册那一刻的 `null` 被闭包冻住**，之后 `field` 变成真值也**不会重跑 effect**；
 *   · ⇒ 每次 snap 都在 `field.local` 抛 `TypeError`，被 `runner.js:181-182` 的统一 try/catch **吞掉**，
 *     只在玩家日志里留一行 `[runner] snap listener failed`（用户机上实测 **1288 次**）；
 *   · ⇒ **它后面的每一行都没跑过**：`setWangMarks`（跟子/补子标记）一次没调用 ⇒ 幽灵棋子从来没画过；
 *     `snapUnitsRef` 与 HUD 也被同一行吃掉（HUD 停在进场那一刻的值）。
 *   · ⇒ 这是本工作区当天第 5 次「测试绿、实机没有」，而它**骗过了静态断言**：
 *     那条护栏 match 的是源码里的 `if (field.local && battleRunner` —— **这行确实在**，只是**跑起来会抛**。
 *
 * ## 现在的契约（由 `test/render/wang-pieces.test.js` 用**真跑**的方式钉住）
 *   1. **"这一帧是不是本地 sim"看【谁发的】**：`battleRunner` 发的 = 客户端本地战斗（帧里带 `mem`）；
 *      `net` 发的 = 服务端直播（帧里没有 `mem`，画不出跟子）。
 *      ⇒ **本模块的入参里根本没有 `field`** —— 想读也读不到（结构上消灭这一整类 bug）。
 *   2. **监听器不许抛**：抛了会被 `runner` 或 socket 的分发层吞掉 ⇒ 又变成"静默少一块显示功能"。
 *      所以下面的 handler 一律先做形状检查，且**不读任何组件作用域的值**（只读 refs 与入参）。
 *   3. **可单测**：`createBattleFrames()` 只依赖入参 ⇒ 可以在 Node 里用假 `net` / 假 `runner` / 假 `view`
 *      直接驱动（见 `test/render/wang-pieces.test.js`：runner 发的帧 ⇒ 推标记；net 发的帧 ⇒ 不推）。
 *
 * ## 🔴 2026-10-08 B12 实测：**这个模块现在没有生产调用点**（欠账，已报 C）
 * 换基座（0.2.0 → 0.2.1）之后 `screens/game.js` 用的是**上游那版内联 `onSnap`**，
 * 全树 `createBattleFrames` 只出现在本文件与两个测试里（生产代码 0 处）⇒ **本模块是孤儿**。
 * 而更贵的是：那个内联版也**不推标记**（它读不出"帧是谁发的"）⇒ `runner.wangMarks()` 从未被调用过，
 * 幽灵棋子一次都没出现过。B12 已按本模块的同一口径在 `game.js` 的内联 `onSnap` 上**补上那一跳**
 * （`local` 由注册处给出），并由 `test/render/wang-pieces.test.js` 的源码契约钉住。
 * ⚠️ **下一步（非本轮）**：把 `game.js` 的内联版**整段换成本模块**（同一逻辑、且可单测），
 * 或删掉本模块 —— ⛔ 但**不要**留着两个都像在跑的实现（那是本仓最贵的形状）。
 *
 * @param {object} o
 * @param {object|null} o.view       渲染视图（`setWangMarks` / `pushSnapshot` 可能不存在）
 * @param {object} o.net             信令/数据连接（只用 `on(type, fn) → off`）
 * @param {object|null} o.runner     本地战斗运行器（`battle/runner.js` 的 `battleRunner`）
 * @param {object} o.audio           声音（`handleBattleEvents(ev)`）
 * @param {object} o.refs            `{ reentryRef, lastFieldRef, snapBufRef, evBufRef, snapUnitsRef, hudRef }`（`.current` 容器）
 * @param {(snap:object)=>object} o.snapHud  从一帧算 HUD（`ui/gameLogic.js`）
 * @param {(hud:object)=>void} o.setHud     把 HUD 推给界面
 * @param {(e:unknown)=>boolean} o.keepEarly 迟到进场时值得重放的元组（`STATE_EV` + 变形 fx）
 * @param {number} [o.hzMs]          HUD 刷新间隔（默认 200 ms = 5 Hz）
 * @param {()=>number} [o.now]       时钟（测试可注入）
 * @param {Function} [o.setT] / [o.clearT]  定时器（测试可注入）
 * @returns {{ dispose:()=>void, onSnap:(s:object)=>void, onLocalSnap:(s:object)=>void, onEv:(m:object)=>void, onFieldMeta:(m:object)=>void }}
 */
export function createBattleFrames({
  view, net, runner, audio, refs, snapHud, setHud, keepEarly, hzMs = 200,
  now = () => performance.now(), setT = (fn, ms) => setTimeout(fn, ms), clearT = (h) => clearTimeout(h),
}) {
  const { reentryRef, lastFieldRef, snapBufRef, evBufRef, snapUnitsRef, hudRef } = refs;
  let last = 0;
  let pending = null;
  const flush = () => { pending = null; last = now(); setHud(hudRef.current); };

  /** 一个场次的元信息到了：清掉它的旧缓冲，并标记"正在重进它"（它的帧先缓存）。 */
  const onFieldMeta = (msg) => {
    if (!msg || typeof msg.fieldId !== 'string') return;
    evBufRef.current.set(msg.fieldId, []);
    snapBufRef.current.delete(msg.fieldId);
    if (msg.fieldId === lastFieldRef.current) reentryRef.current = msg.fieldId;
  };

  /** 视图此刻显示的场次（重进未完成时为 null：它的帧先缓存）。 */
  const shownId = () => (reentryRef.current && reentryRef.current === lastFieldRef.current ? null : lastFieldRef.current);

  /**
   * 一帧战斗快照。`local` 由**调用方按来源**给出（runner ⇒ true），**不是**从 store 里读的
   * —— 读 store 会闭包冻住注册那一刻的值（本文件顶部的那个 bug）。
   */
  const onSnap = (snap, local = false) => {
    const cur = shownId();
    if (!snap || typeof snap !== 'object') return;
    if (!cur || (snap.fieldId && snap.fieldId !== cur)) {
      if (typeof snap.fieldId === 'string') snapBufRef.current.set(snap.fieldId, snap);
      return;
    }
    view?.pushSnapshot(snap);
    // 望的棋子标记（跟子 = 幽灵棋子 + 青框；"补子" = 琥珀框）—— 见 render/app.js WANG_PIECE_STYLE。
    // ⚠️ 只对**客户端算战斗**有效：跟子只活在本地 sim 的 `owner.mem.wang.followers` 里
    //    （**在跑版** `server/sim/content/kits/ops/op-wang.js:300`；退休内置版写的 `owner.mem.wangFollow`
    //     在 0.2.1 基座上**没有任何写入方**，B12 2026-10-08 已改读在跑字段），
    //    服务端直播的帧不带 `mem` ⇒ 那种情况下标记为空（如实的能力边界，不是 bug）。
    // ⚠️ 这里用 `local`（这一帧是谁发的）+ `battleRunner` 自己的口径，**不读 `field`** —— 见文件头。
    if (local && runner && typeof runner.wangMarks === 'function') {
      // ⚠️ `setWangMarks` 必须在 `ui/fieldHost.js` 的 `guardView()` 白名单里登记过，否则这里**静默空转**
      //    （`view` 是白名单壳，没登记的方法在上面根本不存在）—— 这是 2026-10-06「幽灵棋子不出现」的真因。
      view?.setWangMarks?.(runner.wangMarks(cur));
    }
    if (Array.isArray(snap.units)) {
      const mp = new Map();
      for (const t of snap.units) if (Array.isArray(t)) mp.set(t[0], t);
      snapUnitsRef.current = mp;
    }
    hudRef.current = snapHud(snap);
    const dt = now() - last;
    if (dt >= hzMs) flush();
    else if (!pending) pending = setT(flush, hzMs - dt);
  };
  const onServerSnap = (snap) => onSnap(snap, false);
  const onLocalSnap = (snap) => onSnap(snap, true);

  const onEv = (msg) => {
    const cur = shownId();
    if (!msg || !Array.isArray(msg.ev)) return;
    if (!cur || (msg.fieldId && msg.fieldId !== cur)) {
      if (typeof msg.fieldId !== 'string') return;
      const buf = evBufRef.current.get(msg.fieldId) || [];
      // only state-bearing tuples are replayed later (see the enter effect)
      for (const e of msg.ev) if (keepEarly(e)) buf.push(e);
      if (buf.length > 1500) buf.splice(0, buf.length - 1500);
      evBufRef.current.set(msg.fieldId, buf);
      if (evBufRef.current.size > 8) evBufRef.current.delete(evBufRef.current.keys().next().value);
      return;
    }
    view?.pushEvents(msg);
    audio?.handleBattleEvents?.(msg.ev);
  };

  const offs = [net.on('m.field', onFieldMeta), net.on('b.snap', onServerSnap), net.on('b.ev', onEv)];
  if (runner) offs.push(runner.on('field', onFieldMeta), runner.on('snap', onLocalSnap), runner.on('ev', onEv));

  const dispose = () => {
    for (const off of offs) { try { off(); } catch { /* ignore */ } }
    clearT(pending);
    pending = null;
  };
  return { dispose, onSnap, onLocalSnap, onEv, onFieldMeta };
}
