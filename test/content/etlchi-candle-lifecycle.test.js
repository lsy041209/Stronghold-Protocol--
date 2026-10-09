// test/content/etlchi-candle-lifecycle.test.js —— **心烛（隐德来希 S3）的生命周期判据**（第 54 轮 A，2026-10-08）。
//
// 由来：用户点名一个 bug「**心烛无敌且不消失**」（C 派工单 §3 A-1，C 已定位 17 处）。
// 🔴 **我先做的是穷举诊断（`.workbuddy/tools/a54-candle-diag.mjs`），结论与"无敌"的字面相反，照实记在这里**：
//   · ① 用**他自己**打它：40 次 ×4×ATK 后 1,800,000 → 1,611,934，**仍活着** ⇒ 看起来像"无敌"，
//        但**原因是数值**：心烛按原怪的 **60 % 当前 HP** 复制（`attack@max_hp_scale`）⇒ 要 ~**380 击**才死，
//        而原怪每击只掉 ~2,200（1e6 HP）⇒ 它 ~**68 击**就先死、心烛随之熄灭。
//        ⇒ **不是"打不死"，是"永远打不到它死"**（两条命一起掉，但心烛的池子大 60 %…且先死的是原怪）。
//   · ② 原怪被【无来源】击杀 ⇒ ✅ 心烛跟着熄灭
//   · ③ 原怪 **leak** ⇒ ✅ 跟着熄灭（既有判据 `test/content/kits_t5.test.js:338` 也覆盖）
//   · ④ **技能结束** ⇒ ✅ 全部清空
//   · ⑤ **隐德来希自己倒下** ⇒ ✅ 心烛一并消失
//   · ⑥ 他自己的一击 ≥ 35 % 攻击力（`CANDLE_MIN_ATK`，实测 = 全额 ATK）⇒ ✅
//   ⇒ **实现里四条"该消失"的规则都成立**；本文件把它们**全部钉住**（含一条"别的来源打不中它"的阴性对照）。
//
// ⚠️ **仍然敞着的一条（我不擅自改，交 C 定）**：见文件末尾 §候选 bug ——
//    "自己的一击在心烛上"才把原怪掉血（`damaged` 钩子 `loseHp(candleOf)`），所以
//    **别人打原怪 / 环境伤害打原怪时，心烛的血不动** ⇒ 两条血只在"隐德来希打心烛"时同步。
//
// 跑：node --test test/content/etlchi-candle-lifecycle.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, enemyRec, checkInvariants } from '../helpers/battleHarness.js';
import { hasGeneratedData } from '../../server/sim/simdata.js';

const REAL = { skip: !hasGeneratedData() };
const CHESS = 'chess_char_5_06_a';   // 隐德来希
const dummy = (key, o = {}) => enemyRec({ key, hp: o.hp ?? 1e6, def: o.def ?? 0, speed: 0, atk: 0, ...o });

/** 一场最小 S3 场：一名隐德来希 ＋ 三个站定敌人，技能开到运行中，返回心烛列表。 */
function scene() {
  const h = makeBattle({
    defs: { enemies: { e_a: dummy('e_a', { hp: 1e6, def: 3000 }), e_b: dummy('e_b', { hp: 2e6 }), e_c: dummy('e_c', { hp: 3e6 }) } },
    units: [{ chessId: CHESS, row: 9, col: 4 }],
    enemies: [{ key: 'e_a', pos: [10, 5] }, { key: 'e_b', pos: [10, 6] }, { key: 'e_c', pos: [9, 6] }],
    autoFinish: false, timeLimit: 60, captureNoisy: true,
  });
  h.step();
  const u = h.unit(CHESS);
  u.skill.gainSp(1000);
  assert.ok(h.runUntil(() => u.skill.active, 5), '前置：S3 开起来了');
  const candles = () => h.b.enemies.filter((e) => e.mem && e.mem.candleOwner === u);
  assert.ok(candles().length > 0, '前置：心烛生成了');
  return { h, u, candles };
}

test('心烛 · 阴性对照：**别的来源打不中它**（只有隐德来希能伤它）—— 先证明这条链有判别力', REAL, () => {
  const { h, u, candles } = scene();
  const cd = candles()[0];
  assert.equal(h.b.dealDamage(null, cd, { amount: 5000, type: 'true' }), 0, '无来源真伤也伤不到心烛');
  const other = h.b.allies().find((a) => a !== u);
  if (other) assert.equal(h.b.dealDamage(other, cd, { amount: 1e6, type: 'true' }), 0, '别的友方也伤不到它');
  assert.ok(cd.alive, '它还在（这一条只证明"打不中"，不证明"打不死"）');
  checkInvariants(h.b);
  h.b.dispose?.();
});

test('心烛 · 他自己的一击 ≥ 35 % 攻击力，且**原怪同步掉同样的血**', REAL, () => {
  const { h, u, candles } = scene();
  const cd = candles()[0];
  const orig = cd.mem.candleOf;
  const o0 = orig.hp;
  const dealt = h.b.dealDamage(u, cd, { amount: u.s.atk, type: 'phys', isAttack: true });
  assert.ok(dealt >= u.s.atk * 0.35 - 1e-6, `心烛至少吃 35 % 攻击力（atk=${Math.round(u.s.atk)} 实得 ${Math.round(dealt)}）`);
  assert.ok(Math.abs(o0 - orig.hp - dealt) < 1e-6, '原怪掉的血 == 心烛吃到的伤害');
  checkInvariants(h.b);
  h.b.dispose?.();
});

test('🔴 (甲) 双向同步：**打原怪 ⇒ 心烛跟着掉同样的血**，且**心烛先死**（用户 2026-10-08 裁定）', REAL, () => {
  // 为什么要这条：修前只有"他打心烛 ⇒ 原怪掉血"一个方向 ⇒ 队友把伤害灌在**原怪**上时心烛**永远不掉血**，
  //   而队友又**打不中**它（阴性对照那条）⇒ 玩家看到的是"**无敌且不消失**"。
  const { h, u, candles } = scene();
  const cd = candles()[0];
  const orig = cd.mem.candleOf;
  const c0 = cd.hp, o0 = orig.hp;
  const dealt = h.b.dealDamage(null, orig, { amount: orig.s.maxHp * 0.2, type: 'true' });
  h.run(0.05);
  const dO = o0 - orig.hp, dC = c0 - cd.hp;
  assert.ok(Math.abs(dO - dealt) < 1e-6, `原怪该掉 ${Math.round(dealt)}（实测 ${Math.round(dO)}）`);
  assert.ok(Math.abs(dC - dO) < 1e-6,
    `🔴 心烛必须**跟着掉同一份**：原怪掉 ${Math.round(dO)}、心烛掉 ${Math.round(dC)}`
    + `（修前这里恒为 0 —— 那正是"无敌且不消失"的机制）`);
  assert.ok(Math.abs(dO - dealt * 2) > 1,
    `⚠️ 防自激：原怪**不许掉 2 倍**（实测 ${Math.round(dO)}，一击 ${Math.round(dealt)}）—— 反向同步与正向同步会互相触发`);
  checkInvariants(h.b);
  h.b.dispose?.();
});

test('🔴 (甲) 的推论：**心烛先于原怪而死**（它的池子只有原怪的 60 %）', REAL, () => {
  const { h, u, candles } = scene();
  const cd = candles()[0];
  const orig = cd.mem.candleOf;
  // 从"他打心烛"这条（双向同步的任一侧都行）一路打，直到心烛见底
  let n = 0;
  while (cd.alive && n < 500) { h.b.dealDamage(u, cd, { amount: u.s.atk * 20, type: 'true', isAttack: true }); h.run(0.05); n++; }
  assert.equal(cd.alive, false, '🔴 心烛必须能被打死（否则它会在场上留到技能结束，看起来就是"不消失"）');
  assert.ok(orig.alive, '🔴 (甲) 的关键：**心烛先死、原怪还活着**（池子 60 % ⇒ 先见底）');
  checkInvariants(h.b);
  h.b.dispose?.();
});

test('🔴 心烛在四条路径上**必须消失**：(a) 原怪被击杀 (b) 原怪漏掉 (c) 技能结束 (d) 隐德来希自己倒下', REAL, () => {
  // ⚠️ **断言必须钉在"我捕获的那一枚"上**（我第一版按 `candleOwner` 过滤 ⇒ 假红）：
  //    原型怪只要还活着，隐德来希的 SP 一满就会**再开一次 S3** 并召唤**新的一批**心烛 ⇒ "场上没有心烛"这条断言不成立。
  // (a) 原怪被【无来源】击杀（不是 leak、不是"他自己打心烛"那条路）
  {
    const { h, candles } = scene();
    const cd = candles()[0];
    h.b.dealDamage(null, cd.mem.candleOf, { amount: 1e9, type: 'true' });
    h.run(0.2);
    assert.equal(cd.mem.candleOf.alive, false, '(a) 前置：原怪确实死了');
    assert.equal(cd.alive, false, '(a) 🔴 原怪一死，**它那一枚**心烛必须跟着熄灭（`death` 钩子）');
    checkInvariants(h.b);
    h.b.dispose?.();
  }
  // (b) 原怪 leak
  {
    const { h, candles } = scene();
    const cd = candles()[0];
    h.b.leak(cd.mem.candleOf);
    h.run(0.2);
    assert.equal(cd.alive, false, '(b) 🔴 原怪漏掉，**它那一枚**心烛必须跟着熄灭');
    checkInvariants(h.b);
    h.b.dispose?.();
  }
  // (c) 技能自然结束
  {
    const { h, u, candles } = scene();
    const cd = candles()[0];
    assert.ok(h.runUntil(() => !u.skill.active, 25), '(c) 前置：技能结束了');
    assert.equal(cd.alive, false, '(c) 🔴 技能结束 ⇒ **这一批**必须被清掉（`onEnd` 里 `kill`）');
    assert.equal((u.mem.candles || []).length, 0, '(c) 列表也要清空（否则下一次 S3 会去 kill 一批陈旧引用）');
    // 此刻（技能刚结束、下一次还没开）场上不该再有活心烛
    assert.equal(h.b.enemies.filter((e) => e.alive && e.mem?.candleOwner).length, 0, '(c) 同时刻场上不该留活心烛');
    checkInvariants(h.b);
    h.b.dispose?.();
  }
  // (d) 隐德来希自己倒下
  {
    const { h, u, candles } = scene();
    const cd = candles()[0];
    h.b.dealDamage(null, u, { amount: 1e9, type: 'true' });
    h.run(0.3);
    assert.equal(u.alive, false, '(d) 前置：隐德来希倒下了');
    assert.equal(cd.alive, false, '(d) 🔴 主人没了，**它那一枚**心烛必须跟着消失');
    checkInvariants(h.b);
    h.b.dispose?.();
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §候选 bug（**我没有改**，交 C 定口径）
//   实测：把伤害打给**原怪**（无来源真伤 1e9）时，心烛的 hp **一点都不动**（它跟着原怪一起死，所以看不出来）；
//   但把伤害打给**心烛**时，原怪会掉同样的血。⇒ 两条血**只在"隐德来希打心烛"这一个方向上同步**。
//   若玩家的口径是"两条血应该始终同步"，那这里需要一个 `damaged`/`loseHp` 反方向钩子（打原怪 ⇒ 心烛也掉）。
//   我没有擅自加：① 设计意图未确认（可能是"心烛是伤害池、只从他这一侧进"）；② 它是 `server/sim/**`（A-0：T4 前不改树）。
