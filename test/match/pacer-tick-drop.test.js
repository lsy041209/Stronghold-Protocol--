// test/match/pacer-tick-drop.test.js — **服务端节拍不能把"卡顿期间的欠账"丢掉**（A-3b，2026-10-07 第 49 轮 A）
//
// **为什么写这条**：`server/match/fields.js` 的两处节拍器（`FieldRunner._pump` / `HeadlessPacer._pump`）原来是
//   ```js
//   if (n > cap) { n = cap; this.acc = 0; }   // ← 把整段欠账抹掉
//   ```
//   ⇒ 事件循环一卡（垃圾回收 / 大同步任务 / 容器限流），**多出来的那段时间被永久丢弃**：
//   战斗的游戏时间**再也追不上真实时间**。而客户端用的是**绝对目标 tick**（`runner.js` 的 `targetTick`，只"晚"不"丢"）
//   ⇒ **两端结果会分叉**：同一个种子，服务端跑（`SP_COMBAT=server`）与客户端跑（`SP_COMBAT=client`）的
//   tick 数不同 ⇒ 伤害/击杀/掉落都可能不同。
//
// **用户 2026-10-07 的裁定**（逐字问法：「那条独立的'服务端节拍真丢 tick'要现在修吗？」）⇒ **「现在就修（先探针后改）」** ✓
//
// ⚠️ **修法口径**：**保留欠账**（`acc -= n * TICK` 照旧），只把**欠账本身封顶**到「4 个 interval 的量」
//   —— 与**客户端的 catch-up 阈值同口径**（`runner.js` `catchingUp = behind > cap * 4`）：
//   抖动/短卡顿**一点都不丢**，而真正的长时间停摆（远超 4 个 interval）仍然不会 spiral ✓
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VirtualScheduler } from '../../server/match/scheduler.js';
import { FieldRunner, HeadlessPacer, maxTicksPerInterval, INTERVAL_MS } from '../../server/match/fields.js';
import { TICK } from '../../server/sim/constants.js';
import { FakeBattle } from './fakeBattle.js';

/** 最小 Match 替身：节拍器只用到 sched / gameSpeed / paused / guard / reportError / markPublic。 */
function matchOf(sched, gameSpeed = 2) {
  return { sched, gameSpeed, paused: false, guard: (fn) => fn(), reportError: () => {}, markPublic: () => {} };
}

/** 「事件循环被卡住 ms 毫秒」：虚拟时钟前进，但**回调一个都不跑**（VirtualScheduler.t 是公开字段）。 */
const stall = (sched, pump, ms) => { sched.t += ms; pump(); };

test('HeadlessPacer: **卡住 3 秒后欠账照跑完**（原来 `acc = 0` 把它整段丢掉）', () => {
  const sched = new VirtualScheduler({ instantCombat: false });
  const m = matchOf(sched);
  FakeBattle.reset();
  const battle = new FakeBattle({ kind: 'boss', fieldId: 'b1', players: [], timeLimit: Infinity });
  const pacer = new HeadlessPacer(m);
  pacer.add({ battle, onDone: () => {} });
  const t0 = sched.t;
  const cap = maxTicksPerInterval(2);
  stall(sched, () => pacer._pump(), 3000);
  assert.equal(battle.tickCount, cap, `这一拍按 cap 限速（${cap} tick）—— 前置`);
  // 之后正常跑 3 秒（每 interval ≈ 33.3 ms）⇒ 卡顿那 3 秒的游戏时间应当已经被追平
  for (let i = 0; i < 90; i++) sched.advance(INTERVAL_MS);
  const due = Math.floor((((sched.t - t0) / 1000) * 2) / TICK);          // 2× ⇒ 6 s 真实 = 12 游戏秒 = 360 tick
  assert.ok(battle.tickCount >= due - cap,
    `卡顿的 3 秒**不能被丢掉**：按真实时间应付 ≈ ${due} tick，实测只走了 ${battle.tickCount}（差 ${due - battle.tickCount}）✗`);
  assert.ok(battle.tickCount <= due + 1, `也不该超前：实测 ${battle.tickCount} vs 应付 ${due}`);
  pacer.stop?.();
});

test('FieldRunner: 同款代码（`:149`）同样**不丢卡顿的欠账**', () => {
  const sched = new VirtualScheduler({ instantCombat: false });
  const m = matchOf(sched);
  FakeBattle.reset();
  // ⚠️ `kind: 'boss'` ⇒ FakeBattle 的 plan.duration = Infinity（`kind: 'normal'` 会在 8 游戏秒自己结束，
  //    那样测到的是"战斗结束了"，不是"丢 tick"—— 我第一版就踩了这个假红）
  const battle = new FakeBattle({ kind: 'boss', fieldId: 'f1', players: [], timeLimit: Infinity });
  const fields = [{ fieldId: 'f1', kind: 'normal', players: [], battle, live: true }];
  const runner = new FieldRunner(m, fields, { onDone: () => {}, emit: false });
  runner.start();
  const t0 = sched.t;
  const cap = maxTicksPerInterval(2);
  stall(sched, () => runner._pump(), 3000);
  assert.equal(runner.ticks, cap, `这一拍按 cap 限速（${cap} tick）—— 前置`);
  for (let i = 0; i < 90; i++) sched.advance(INTERVAL_MS);
  const due = Math.floor((((sched.t - t0) / 1000) * 2) / TICK);
  assert.ok(runner.ticks >= due - cap,
    `卡顿的 3 秒不能被丢掉：应付 ≈ ${due} tick，实测 ${runner.ticks} ✗`);
  assert.ok(runner.ticks <= due + 1, `也不该超前：实测 ${runner.ticks} vs 应付 ${due}`);
  runner.stop();
});
