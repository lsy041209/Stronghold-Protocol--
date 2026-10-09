// test/sim/limits-clamp.test.js — **限伤 = 封顶**（A-5 / F-7）的护栏 —— 2026-10-07 第 51 轮 A。
//
// **用户 2026-10-07 指示（照抄）**：「只去掉"伤害过高导致伤害清零"即可，做一个伤害上限就好了，溢出的伤害在删掉。」
// **执行单**：`协作/C-执行单-限伤改封顶-2026-10-07.md`（规格 §2、判据 §3）。
//
// 口径：**单次 `ceil(amount) ≥ BOSS_HIT_LIMIT`（300000）⇒ 这一击就造成 `BOSS_HIT_LIMIT`**，超出的部分**直接丢弃**；
//       **其余流程照常**（护盾 → HP/池 → 伤害数字 → credit/stats）。
//       ⚠️ 与**官方客户端**（`modifier.Cancel()` = 整击作废）**有意不一致** —— 这是用户裁定的偏离，别"对齐上游"时改回去。
//
// 🔴 **先红后绿**：本文件在实现前，第 1/2/4/7 条与"命名"那条**必然红**（那时 `dealDamage` 返回 0）；
//    3/5/6 三条是**不该变**的对照（实现前后都要绿）—— 有它们才能证明"改的是封顶、不是把限伤整个删了"。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BOSS_HIT_LIMIT } from '../../shared/constants.js';
import { makeBattle, chessRec, enemyRec } from '../helpers/battleHarness.js';
import { SharedBossPool } from '../../server/match/finalAssault.js';
import * as damage from '../../server/sim/damage.js';

const LIMIT = BOSS_HIT_LIMIT;
const fxOf = (h) => h.eventsOf('fx').filter((e) => e[1] === 'hitCap');

const opRec = () => chessRec({ id: 't_op', profession: 'WARRIOR', stats: { atk: 10, maxHp: 1e9 }, skill: null });
/** 一个 `kind` 战场：领袖（tag `boss`）、小怪、部件；可选共享池。全部站定不动。 */
function field({ kind = 'boss', pool = null } = {}) {
  const h = makeBattle({
    kind, sharedBoss: pool,
    defs: {
      chess: { t_op: opRec() },
      enemies: {
        enemy_lead: enemyRec({ key: 'enemy_lead', rank: 'BOSS', hp: 1e9, speed: 0 }),
        enemy_mini: enemyRec({ key: 'enemy_mini', hp: 1e9, speed: 0 }),
        enemy_part: enemyRec({ key: 'enemy_part', rank: 'ELITE', hp: 1e9, speed: 0 }),
      },
    },
    players: [{ playerId: 'P', seat: 0, side: 'L', colOffset: 0, units: [{ uid: 1, chessId: 't_op', row: 10, col: 2 }], bonds: {}, playerEffects: [] }],
    enemies: kind === 'boss' || kind === 'hidden'
      ? [{ key: 'enemy_lead', pos: [3, 9], tag: 'boss' }, { key: 'enemy_mini', pos: [3, 12] }, { key: 'enemy_part', pos: [4, 12], tag: 'part' }]
      : [{ key: 'enemy_lead', pos: [10, 9], tag: 'boss' }, { key: 'enemy_mini', pos: [11, 9] }],
    content: 'none', autoFinish: false,
  });
  h.step();
  const leader = h.enemy('enemy_lead');
  assert.ok(leader && leader.isBoss, '前置：领袖是 boss 单位');
  return { h, b: h.b, leader, mini: h.enemy('enemy_mini'), part: h.enemy('enemy_part'), op: h.unit(1) };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ⚠️ **第 52 轮 A（换基座到上游 0.2.1 后）改过这条判据** —— 它原来断"`leaderHitCancelled` 必须消失"。
//    但 0.2.1 的 `battle/combat.js` 与既有判据（`playtest6_limits.test.js`）都 **import 那个名字**（它现在是**上游的**公共 API）
//    ⇒ **名字删不掉**。⇒ 真正要钉住的不再是"名字在不在"，而是**流水线不许再走"整击作废"**（名字会说谎，行为不会）：
//    两个入口各自必须调用 `capLeaderHit`，且谁也不许再调用 `leaderHitCancelled`。
test('口径：流水线走 `capLeaderHit`（封顶）—— `damage.js` 与 `battle/combat.js` 都不许再调用 `leaderHitCancelled`（那是清零）', () => {
  assert.equal(typeof damage.capLeaderHit, 'function', '封顶函数必须在');
  const dmg = readFileSync(new URL('../../server/sim/damage.js', import.meta.url), 'utf8');
  const combat = readFileSync(new URL('../../server/sim/battle/combat.js', import.meta.url), 'utf8');
  assert.ok(!/leaderHitCancelled\(\s*battle,\s*target,\s*final\s*\)/.test(dmg), 'dealDamage 不许再调用 leaderHitCancelled（清零）');
  assert.match(dmg, /final\s*=\s*capLeaderHit\(battle,\s*target,\s*final\)/, 'dealDamage 必须走 capLeaderHit');
  assert.ok(!/leaderHitCancelled\(\s*this,\s*target,\s*amount\s*\)/.test(combat), 'loseHp 不许再调用 leaderHitCancelled（清零）');
  assert.match(combat, /amount\s*=\s*capLeaderHit\(this,\s*target,\s*amount\)/, 'loseHp 必须走 capLeaderHit');
});

test('判据 1+2：boss 关领袖吃 5,000,000 ⇒ **掉血 300,000**、credit/stats 也记 300,000（现在：0）', () => {
  const pool = new SharedBossPool(5e6);
  const { h, b, leader, op } = field({ pool });
  const dealt = b.dealDamage(op, leader, { amount: 5e6, type: 'true' });
  assert.equal(dealt, LIMIT, '掉血 = 上限（不是 0、不是 5e6）');
  assert.equal(pool.hp, 5e6 - LIMIT, '共享池按 300,000 扣');
  assert.equal(pool.byPlayer.get('P'), LIMIT, 'credit 记 300,000');
  assert.equal(b._pp('P').bossDamage, LIMIT, 'bossDamage 统计记 300,000');
  assert.equal(op.stats.dmg, LIMIT, '攻击者 dmg 统计记 300,000');
  assert.equal(h.eventsOf('dmg').length, 1, '**要有伤害数字**（归零时代才没有）');
  assert.ok(h.hooksOf('damaged').length >= 1, "**要走 'damaged' 钩子**（正常流程）");
  const ev = fxOf(h);
  assert.equal(ev.length, 1, '`hitCap` 事件保留（客户端本来就画空）');
  assert.deepEqual([ev[0][4].id, ev[0][4].n], [leader.id, 5e6], '事件带的是**原始**命中值 ceil(amount)');
  assert.ok(leader.alive);
});

test('判据 3：299,999 ⇒ **原样 299,999**（下限侧不变）', () => {
  const pool = new SharedBossPool(5e6);
  const { b, leader, op } = field({ pool });
  assert.equal(b.dealDamage(op, leader, { amount: LIMIT - 1, type: 'true' }), LIMIT - 1);
  assert.equal(pool.hp, 5e6 - (LIMIT - 1));
  assert.equal(pool.byPlayer.get('P'), LIMIT - 1);
});

test('判据 4：正好 300,000 ⇒ 300,000（边界是 `>=`，封顶前后数值相同 ⇒ 无观感变化）', () => {
  const pool = new SharedBossPool(5e6);
  const { b, leader, op } = field({ pool });
  assert.equal(b.dealDamage(op, leader, { amount: LIMIT, type: 'true' }), LIMIT);
  assert.equal(pool.hp, 5e6 - LIMIT);
});

test('判据 5：**非领袖**（小怪/部件）吃 5,000,000 ⇒ 原样吃满（限伤只管领袖）', () => {
  const { b, mini, part, op } = field({});
  assert.equal(b.dealDamage(op, mini, { amount: 5e6, type: 'true' }), 5e6);
  assert.equal(b.dealDamage(op, part, { amount: 5e6, type: 'true' }), 5e6);
  assert.equal(part.isBoss, false);
});

test('判据 6：**非 boss/hidden 关**（普通/联防）⇒ 同一只领袖照吃 5,000,000', () => {
  for (const kind of ['normal', 'unite']) {
    const { b, leader, op } = field({ kind });
    assert.equal(b.dealDamage(op, leader, { amount: 5e6, type: 'true' }), 5e6, kind);
  }
  // 反面对照：hidden 关要封
  const { b, leader, op } = field({ kind: 'hidden' });
  assert.equal(b.dealDamage(op, leader, { amount: 5e6, type: 'true' }), LIMIT, 'hidden（隐秘核心）也是 boss 关');
});

test('判据 7：`loseHp`（流失）传给领袖的 ≥300k 也封顶（部件传递 / 无人机死亡）', () => {
  const pool = new SharedBossPool(5e6);
  const { b, leader, op } = field({ pool });
  assert.equal(b.loseHp(leader, 3e5, { source: op }), LIMIT, '流失通道同样封顶');
  assert.equal(pool.hp, 5e6 - LIMIT);
  assert.equal(b.loseHp(leader, 2e5, { source: op }), 2e5, '线下原样');
});

test('封顶发生在**全部乘算之后、护盾之前**：被夹到 300,000 后仍要过护盾', () => {
  const { b, leader, op } = field({});
  b.addBuff(leader, { key: 'test:shield', shield: 100000 });
  const hp0 = leader.hp;
  assert.equal(b.dealDamage(op, leader, { amount: 350000, type: 'true' }), LIMIT - 100000, '350000 ⇒ 夹到 300000 ⇒ 护盾吃 100000 ⇒ 落 200000');
  assert.equal(leader.findBuff('test:shield'), null, '护盾被花掉（不是"整击作废、护盾不动"）');
  assert.equal(leader.hp, hp0 - (LIMIT - 100000));
  assert.equal(b.dealDamage(op, leader, { amount: 250000, type: 'true' }), 250000, '线下照常：250000 全落（护盾已在上一条花完）');
});

test('乘算把线下伤害推上线 ⇒ 也封顶（不是"只封原始 amount"）', () => {
  const { b, leader, op } = field({});
  b.addBuff(leader, { key: 'test:fragile', mods: { dmgTakenMul: 2 } });
  assert.equal(b.dealDamage(op, leader, { amount: 149999, type: 'true' }), 299998, '299998 < 线 ⇒ 原样');
  assert.equal(b.dealDamage(op, leader, { amount: 150000, type: 'true' }), LIMIT, '300000 ⇒ 夹到 300000');
  b.removeBuff(leader, 'test:fragile');
  b.addBuff(op, { key: 'test:dealt', mods: { dmgDealtMul: 3 } });
  assert.equal(b.dealDamage(op, leader, { amount: 200000, type: 'true' }), LIMIT, '200000 × 3 = 600000 ⇒ 300000');
});

test('元素伤害 / 元素爆发 / DoT 的一跳，都按"一次命中"封顶', () => {
  const pool = new SharedBossPool(5e7);
  const { h, b, leader, op } = field({ pool });
  assert.equal(b.dealDamage(op, leader, { amount: 4e5, type: 'elemental', element: 'burn' }), LIMIT, '元素伤害');
  b.addBuff(leader, { key: 'test:elemFragile', mods: { elementalTakenMul: 100 } });
  const p0 = pool.hp;
  b.dealDamage(op, leader, { amount: 1e7, type: 'element', element: 'burn' });
  assert.ok(leader.findBuff('burnBurst'), '前置：损伤槽爆了');
  assert.equal(p0 - pool.hp, LIMIT, '爆发的元素伤害也封顶（150000 × 100 = 1.5e7 ⇒ 300000）');
  b.removeBuff(leader, 'test:elemFragile');
  const p1 = pool.hp;
  b.addBuff(leader, { key: 'test:dot', duration: 3.01, interval: 1, onTick: () => b.dealDamage(op, leader, { amount: 6e5, type: 'true', canDodge: false }) });
  h.run(3.2);
  assert.ok(p1 - pool.hp > 0 && (p1 - pool.hp) % LIMIT === 0, `每跳都应封顶（实得 ${p1 - pool.hp}）`);
});

test('关掉开关的语义保留：`BOSS_HIT_LIMIT <= 0` ⇒ 完全不生效（本进程内翻不动常量，故只在代码里守）', () => {
  // ⚠️ 诚实边界：`BOSS_HIT_LIMIT` 是模块级 `export const`（`shared/constants.js:113`），**本进程内改不了** ⇒
  //    这条只能靠"代码里的 `!(BOSS_HIT_LIMIT > 0)` 守卫"保证，不能在这里动态翻。此处只断言开关的**当前值**。
  assert.equal(LIMIT, 300000);
  assert.ok(LIMIT > 0, '开着（0 / Infinity = 关，见 constants 注释）');
});

test('确定性：同一条战跑两遍，结果摘要与池血完全一致', () => {
  const run = () => {
    const pool = new SharedBossPool(5e6);
    const { b, leader, op } = field({ pool });
    for (let i = 0; i < 12; i++) b.dealDamage(op, leader, { amount: 100000 + i * 50000, type: 'true' });
    return { hp: pool.hp, d: JSON.stringify(b.result ? b.result().stats ?? null : null), alive: leader.alive };
  };
  assert.deepEqual(run(), run());
});
