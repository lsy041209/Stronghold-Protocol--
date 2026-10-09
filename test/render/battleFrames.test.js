// test/render/battleFrames.test.js — `public/js/screens/battleFrames.js` 的**专属**护栏（第 5 任 B，2026-10-06）
//
// 为什么这个文件存在（它替掉的是一条**假绿**）：
//   `screens/game.js` 的那个 `useEffect(..., [view])` 原来把 `m.field` / `b.snap` / `b.ev` 的接线**内联**在里面，
//   而 `onSnap` 读了**组件作用域**的 `field`（初值 `null`、又不在依赖数组里 ⇒ 闭包冻住）⇒ 每帧抛 TypeError、
//   被 `runner.js:181-182` 的 try/catch 吞掉 ⇒ 它后面的 `setWangMarks`（望的幽灵棋子/青框）**一次都没跑过**。
//   而当时的护栏是**match 源码**（`if (field.local && battleRunner` 那一行**确实在**）⇒ **全绿** ✗。
//   ⇒ 现在那段逻辑抽成了 `createBattleFrames(opts)`（**入参里没有 `field`**），本文件用**假 net / 假 runner / 假 view**
//     **真驱动它**，把整条管线的契约钉住：谁发的帧算什么、什么时候缓冲、HUD 怎么节流、dispose 摘不摘干净。
//
// ⚠️ 另一条真实教训（同一天，用户机日志实测）：`ui/fieldHost.js` 的 `guardView()` 是**白名单包装**，
//    没登记的方法在 screens 手里**根本不存在** ⇒ `view?.setWangMarks?.()` 静默空转。
//    ⇒ 所以本文件**必须**用"会记账的假 view"来断言"**调用真的发生了**"，而不是断言"某个文件里写着这句话"。
//    （那条白名单的护栏在 `test/render/wang-pieces.test.js`。）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { createBattleFrames } = await import('../../public/js/screens/battleFrames.js');

/** 会记账的假 emitter：记下注册的 handler，返回 off（形状与 `net.on` / `runner.on` 一致）。 */
function emitter() {
  const handlers = new Map();
  return {
    on(type, fn) {
      const list = handlers.get(type) || [];
      list.push(fn);
      handlers.set(type, list);
      return () => { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); };
    },
    emit(type, payload) { for (const fn of [...(handlers.get(type) || [])]) fn(payload); },
    count(type) { return (handlers.get(type) || []).length; },
    types() { return [...handlers.keys()]; },
  };
}

/** 一套完整的假场地：假 net / 假 runner（可给 wangMarks）/ 记账 view / 六个 ref / 手动时钟与定时器。 */
function world({ fieldId = 'n:P1', marks = null, keepEarly = () => false, hzMs = 200, withRunner = true } = {}) {
  const net = emitter(), runner = withRunner ? emitter() : null;
  if (runner && marks) runner.wangMarks = () => marks;
  const log = { snapshots: [], events: [], audio: [], huds: [], marks: [], cleared: [], timers: [] };
  const view = {
    pushSnapshot: (s) => log.snapshots.push(s),
    pushEvents: (m) => log.events.push(m),
    setWangMarks: (m) => { log.marks.push(m); return true; },
  };
  const refs = {
    reentryRef: { current: null }, lastFieldRef: { current: fieldId },
    snapBufRef: { current: new Map() }, evBufRef: { current: new Map() },
    snapUnitsRef: { current: new Map() }, hudRef: { current: null },
  };
  let t = 1000;
  const pendingTimers = new Set();
  const frames = createBattleFrames({
    view, net, runner, audio: { handleBattleEvents: (ev) => log.audio.push(ev) }, refs,
    snapHud: (snap) => ({ hudOf: snap && snap.fieldId }), setHud: (h) => log.huds.push(h),
    keepEarly, hzMs,
    now: () => t,
    setT: (fn, ms) => { pendingTimers.add(fn); log.timers.push(ms); return fn; },
    clearT: (h) => { if (h) { pendingTimers.delete(h); log.cleared.push(h); } },
  });
  return {
    net, runner, view, refs, log, frames,
    advance(ms) { t += ms; },
    fireTimers() { const q = [...pendingTimers]; pendingTimers.clear(); for (const fn of q) fn(); },
    pendingTimers: () => pendingTimers.size,
  };
}

describe('battleFrames：把 m.field / b.snap / b.ev 接到视图上', () => {
  test('注册：net 上接 m.field / b.snap / b.ev，runner 上也接 field / snap / ev（各一个）', () => {
    const w = world();
    assert.deepEqual(w.net.types().sort(), ['b.ev', 'b.snap', 'm.field']);
    assert.equal(w.net.count('b.snap'), 1); assert.equal(w.net.count('b.ev'), 1); assert.equal(w.net.count('m.field'), 1);
    assert.deepEqual(w.runner.types().sort(), ['ev', 'field', 'snap']);
    assert.equal(w.runner.count('snap'), 1);
  });

  test('runner 缺失时只接 net（不抛）', () => {
    const w = world({ withRunner: false });
    assert.equal(w.net.count('b.snap'), 1);
    assert.equal(w.runner, null);
    w.net.emit('b.snap', { fieldId: 'n:P1', units: [] });   // 不许抛
  });

  test('🔴 本地 sim 的帧（runner）推标记；服务端直播的帧（net）不推 —— 后者没有 `mem`', () => {
    const marks = { follow: [{ r: 9, c: 5, spine: 'token_10064_wang_stone1' }], refilled: [] };
    const w = world({ marks });
    w.runner.emit('snap', { fieldId: 'n:P1', units: [] });
    assert.equal(w.log.marks.length, 1, 'runner 的帧必须把标记推给视图（幽灵棋子只走这一条）');
    assert.equal(w.log.marks[0], marks);
    w.net.emit('b.snap', { fieldId: 'n:P1', units: [] });
    assert.equal(w.log.marks.length, 1, 'net 的帧不推标记');
    assert.equal(w.log.snapshots.length, 2, '但两帧都照旧进视图');
  });

  test('别的场次的帧：先缓存，不许推给当前视图（同格标记会画错地方）', () => {
    const w = world({ fieldId: 'n:P1' });
    w.runner.emit('snap', { fieldId: 'n:P2', units: [] });
    w.net.emit('b.snap', { fieldId: 'n:P2', units: [] });
    assert.equal(w.log.snapshots.length, 0); assert.equal(w.log.marks.length, 0);
    assert.equal(w.refs.snapBufRef.current.get('n:P2').fieldId, 'n:P2', '最后一帧留在缓存里（重进时开场用）');
  });

  test('🔴 重进窗口（`reentryRef === lastFieldRef`）⇒ `shownId()` 为 null ⇒ 连当前场次的帧也要先缓存', () => {
    const w = world({ fieldId: 'n:P1' });
    w.net.emit('m.field', { fieldId: 'n:P1' });          // 同一个场次的新 meta ⇒ 进入"重进"状态
    assert.equal(w.refs.reentryRef.current, 'n:P1');
    w.runner.emit('snap', { fieldId: 'n:P1', units: [] });
    assert.equal(w.log.snapshots.length, 0, '重进未完成时不许推帧（视图正被重建）');
    assert.ok(w.refs.snapBufRef.current.has('n:P1'), '缓存起来等重进结束');
    assert.equal(w.refs.evBufRef.current.get('n:P1').length, 0, 'm.field 会把该场次的事件缓冲清空');
  });

  test('事件：当前场次 ⇒ 推给视图并交给 audio；别的场次 ⇒ 只留 `keepEarly` 认的元组', () => {
    const keep = (e) => Array.isArray(e) && e[0] === 'skill';
    const w = world({ fieldId: 'n:P1', keepEarly: keep });
    w.net.emit('b.ev', { fieldId: 'n:P1', ev: [['skill', 1]] });
    assert.equal(w.log.events.length, 1); assert.equal(w.log.audio.length, 1);
    w.net.emit('b.ev', { fieldId: 'n:P2', ev: [['skill', 2], ['fx', 3]] });
    assert.equal(w.log.events.length, 1, '别的场次不推');
    assert.deepEqual(w.refs.evBufRef.current.get('n:P2'), [['skill', 2]], '非状态元组（fx）被丢掉');
  });

  test('事件缓冲是**有界**的：单场次 ≤1500 条、最多留 8 个场次（LRU）', () => {
    // ⚠️ 这个场地必须让 `keepEarly` 全真 —— 默认是 `() => false`，那样**一条都不会进缓冲**，
    //    断言就会变成"0 条也算过"（我第一次就是这么写的，红在 `buf.length` 上）。
    const w = world({ fieldId: 'n:P1', keepEarly: () => true });
    const many = Array.from({ length: 1600 }, (_, i) => ['skill', i]);
    w.net.emit('b.ev', { fieldId: 'n:P9', ev: many });
    const buf = w.refs.evBufRef.current.get('n:P9');
    assert.equal(buf.length, 1500, '超出部分从头部丢');
    assert.equal(buf[0][1], 100, '丢掉的是最老的 100 条');
    for (let i = 0; i < 12; i++) w.net.emit('b.ev', { fieldId: `n:L${i}`, ev: [['skill', i]] });
    assert.ok(w.refs.evBufRef.current.size <= 8, `最多 8 个场次，实际 ${w.refs.evBufRef.current.size}`);
    assert.ok(!w.refs.evBufRef.current.has('n:P9'), '最先被淘汰的是最老的那个场次');
  });

  test('HUD：`snapHud` 的结果进 hudRef，并按 hzMs 节流（不是每帧都 setHud）', () => {
    const w = world({ fieldId: 'n:P1', hzMs: 200 });
    w.runner.emit('snap', { fieldId: 'n:P1', units: [] });      // 第一帧：dt 很大（last=0）⇒ 立刻 flush
    assert.equal(w.log.huds.length, 1);
    assert.deepEqual(w.log.huds[0], { hudOf: 'n:P1' });
    w.advance(50);
    w.runner.emit('snap', { fieldId: 'n:P1', units: [] });      // 50 ms 后：排一个定时器
    assert.equal(w.log.huds.length, 1, '还没到点，不推');
    assert.equal(w.pendingTimers(), 1);
    w.fireTimers();
    assert.equal(w.log.huds.length, 2, '到点后 flush 一次（拿的是 hudRef 里最新那份）');
    w.advance(300);
    w.runner.emit('snap', { fieldId: 'n:P1', units: [] });      // 超过 hzMs：立刻 flush
    assert.equal(w.log.huds.length, 3);
  });

  test('`snapUnitsRef` 跟着帧更新（键 = 元组首字段），units 不是数组时不动它', () => {
    const w = world({ fieldId: 'n:P1' });
    w.runner.emit('snap', { fieldId: 'n:P1', units: [[7, 'a'], [8, 'b']] });
    assert.equal(w.refs.snapUnitsRef.current.get(7)[1], 'a');
    w.refs.snapUnitsRef.current.set(99, ['keep']);
    w.runner.emit('snap', { fieldId: 'n:P1', units: 'nope' });
    assert.ok(w.refs.snapUnitsRef.current.has(99), '形状不对时不许清掉/重建');
  });

  test('坏帧一律不抛（null / 非对象 / 缺 fieldId / 缺 ev）', () => {
    const w = world();
    for (const bad of [null, undefined, 0, 'x', true, [], {}]) {
      w.net.emit('b.snap', bad); w.runner.emit('snap', bad);
      w.net.emit('b.ev', bad); w.runner.emit('ev', bad);
      w.net.emit('m.field', bad); w.runner.emit('field', bad);
    }
    // `{}` / `[]` **没有声明 fieldId** ⇒ 契约是"当成当前场次的帧"；两个 emitter 各发一遍 ⇒ 4 帧
    assert.equal(w.log.snapshots.length, 4, '只有"没声明别的场次"的对象被当成当前场次的帧');
    assert.equal(w.log.events.length, 0);
  });

  test('`dispose`：摘掉全部监听器 + 清掉挂着的定时器（否则重进 screen 会重复推帧）', () => {
    const w = world();
    w.runner.emit('snap', { fieldId: 'n:P1', units: [] });
    w.advance(10);
    w.runner.emit('snap', { fieldId: 'n:P1', units: [] });      // 排一个 flush
    assert.equal(w.pendingTimers(), 1);
    const before = w.log.snapshots.length;                      // = 2（上面两帧都进了视图）
    const handle = [...w.log.timers].length;
    w.frames.dispose();
    assert.equal(w.net.count('b.snap'), 0); assert.equal(w.net.count('b.ev'), 0); assert.equal(w.net.count('m.field'), 0);
    assert.equal(w.runner.count('snap'), 0); assert.equal(w.runner.count('ev'), 0); assert.equal(w.runner.count('field'), 0);
    assert.equal(w.pendingTimers(), 0, '定时器被 clearT 清掉');
    assert.ok(handle >= 1);
    w.advance(1000);
    w.net.emit('b.snap', { fieldId: 'n:P1', units: [] });        // 摘干净后不许再有任何副作用
    assert.equal(w.log.snapshots.length, before, 'dispose 之后那一帧不许再进视图');
  });
});
