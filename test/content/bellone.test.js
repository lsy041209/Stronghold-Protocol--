// 贝洛内 (content pack, tier 1) kit tests — server/sim/content/kits/tier1.js `chess_bellone_a`.
// 用 defs.chess 注入贝洛内的 data 格式记录（与内容包 draft-chess_bellone_a.pack.json 一致），不依赖 data/ 是否 apply。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, enemyRec, checkInvariants } from '../helpers/battleHarness.js';
import { COLS } from '../../server/sim/constants.js';
import { absoluteRangeKeys } from '../../server/sim/targeting.js';
import kits from '../../server/sim/content/kits/tier1.js';

const bellone = {
  chessId: 'chess_bellone_a', baseId: 'chess_bellone_a', isGolden: false, tier: 1, name: '贝洛内',
  profession: 'WARRIOR', subProfessionId: 'fighter', position: 'MELEE', bonds: ['siracusaShip'],
  stats: { maxHp: 2625, atk: 665, def: 385, res: 0, cost: 11, blockCnt: 1, bat: 0.78, aspd: 100, respawnTime: 70, spRecovery: 1, hpRecoveryPerSec: 0, moveSpeed: 1, tauntLevel: 0, massLevel: 0, deployLimit: 1, deckStack: 0 },
  rangeGrid: [[0, 0], [0, 1]], dmgType: 'phys', attackKind: 'melee', projectile: 'none', canHitFly: false, targetPriority: null,
  trait: { desc: '能够阻挡一个敌人', bb: {} },
  talents: [
    { index: 0, name: '家族手段', bb: { def: -0.07, max_stack_cnt: 5, atk_scale: 1.2 }, bbStr: {}, hidden: false },
    { index: 1, name: '街头直觉', bb: { prob: 0.4, deploy_prob: 0.8, deploy_duration: 20 }, bbStr: {}, hidden: false },
  ],
  immunities: { stun: false, silence: false, sleep: false, frozen: false, levitate: false },
  skill: {
    skillId: 'skchr_demetr_1', name: '家主的余裕', level: 4, skillType: 'AUTO', durationType: 'NONE', duration: 0,
    spType: 'INCREASE_WHEN_ATTACK', spCost: 4, initSp: 0, maxChargeTime: 1, increment: 1,
    bb: { 'attack@atk_scale': 1.8, 'attack@times': 2 }, bbStr: {}, rangeId: null, rangeGrid: null, prefabId: 'skchr_demetr_1',
    trigger: { rule: 'DEFAULT' }, index: 0, overrideTokenKey: null,
  },
  skills: [
    { skillId: 'skchr_demetr_1', iconId: 'skchr_demetr_1', name: '家主的余裕', level: 4, desc: 'x', descRaw: 'x', isDefault: true, skillType: 'AUTO', durationType: 'NONE', duration: 0, spType: 'INCREASE_WHEN_ATTACK', spCost: 4, initSp: 0, maxChargeTime: 1, increment: 1, bb: { 'attack@atk_scale': 1.8, 'attack@times': 2 }, bbStr: {}, rangeId: null, rangeGrid: null, prefabId: 'skchr_demetr_1', trigger: { rule: 'DEFAULT' }, index: 0, overrideTokenKey: null },
    { skillId: 'skchr_demetr_2', iconId: 'skchr_demetr_2', name: '军师的手段', level: 4, desc: 'x', descRaw: 'x', isDefault: false, skillType: 'MANUAL', durationType: 'NONE', duration: 15, spType: 'INCREASE_WITH_TIME', spCost: 29, initSp: 14, maxChargeTime: 1, increment: 1, bb: { attack_speed: 40, 'attack@max_target': 3, 'attack@atk_scale': 1.55, duration: 15 }, bbStr: {}, rangeId: '3-13', rangeGrid: [[1, 1], [1, 2], [0, 0], [0, 1], [0, 2], [0, 3], [-1, 1], [-1, 2]], prefabId: 'skchr_demetr_2', trigger: { rule: 'DEFAULT' }, index: 1, overrideTokenKey: null },
  ],
};

const h = (extra = {}) => makeBattle({
  defs: { chess: { chess_bellone_a: bellone }, enemies: { enemy_e: enemyRec({ key: 'enemy_e', hp: 1e7, def: 200, res: 0, atk: 0, speed: 0, bat: 99 }) } },
  units: [{ chessId: 'chess_bellone_a', row: 10, col: 4, ...(extra.unit || {}) }],
  enemies: [{ key: 'enemy_e', pos: [10, 5] }],
  timeLimit: 40,
  ...extra.opts,
});

test('贝洛内: kit 加载 + 街头直觉闪避 + 家族手段降防', () => {
  const b = h();
  const u = b.unit('chess_bellone_a');
  assert.ok(u.kit && u.kit.skills && u.kit.skills.skchr_demetr_1, 'kit loaded (not generic)');
  // 天赋2 街头直觉: 部署后 80%（40% 常态 + 40% 部署加成），20 秒后回落到 40%
  assert.ok(u.s.dodgePhys > 0.4 && u.s.dodgeArts > 0.4, `dodge ${u.s.dodgePhys}/${u.s.dodgeArts} (deploy boost above base)`);
  // 天赋1 家族手段: 攻击命中 → 目标降防（叠层）
  b.runUntil(() => b.enemies().length > 0, 5);
  const e = b.enemy('enemy_e');
  assert.ok(e, 'enemy spawned');
  b.runUntil(() => e.s.def < 200, 40);
  assert.ok(e.s.def < 200, `family means lowered target DEF to ${e.s.def}`);
  checkInvariants(b.b);
});

test('贝洛内 S1 家主的余裕: 满 SP 后技能释放，攻击命中两段', () => {
  const b = h({ unit: { carryState: { sp: 999 } } });
  const u = b.unit('chess_bellone_a');
  b.runUntil(() => b.hooksOf('skillStart').some((c) => c.unit === u && c.skill?.id === 'skchr_demetr_1'), 40);
  assert.ok(b.hooksOf('skillStart').some((c) => c.unit === u && c.skill?.id === 'skchr_demetr_1'), 'S1 cast');
  checkInvariants(b.b);
});

// ---- 官方攻击范围 (3-13) 与 三技能【移动】 (x-2) ---------------------------------------------------------------------
//
// 三技能 清算 在精英2 开放，所以这条用例走精英记录 chess_bellone_b（普通记录只有 S1/S2 —— 与官方一致）。

/** 官方 技能范围=3-13：含自身、面朝方向 4×3 去掉四角（8 格）。 */
const G313 = [[1, 1], [1, 2], [0, 0], [0, 1], [0, 2], [0, 3], [-1, 1], [-1, 2]];
/** 官方 x-2：以释放位置为中心的 5×5 去掉四角（21 格）—— 三技能的选取范围。 */
const GX2 = [[2, -1], [2, 0], [2, 1], [1, -2], [1, -1], [1, 0], [1, 1], [1, 2], [0, -2], [0, -1], [0, 0], [0, 1], [0, 2], [-1, -2], [-1, -1], [-1, 0], [-1, 1], [-1, 2], [-2, -1], [-2, 0], [-2, 1]];

const elite = {
  ...bellone,
  chessId: 'chess_bellone_b', baseId: 'chess_bellone_a', isGolden: true,
  status: { phase: 2, level: 50, skillLevel: 7, equipLevel: 0 },
  skills: [
    ...bellone.skills,
    {
      skillId: 'skchr_demetr_3', iconId: 'skchr_demetr_3', name: '清算', level: 7, desc: 'x', descRaw: 'x', isDefault: false,
      skillType: 'MANUAL', durationType: 'NONE', duration: 30, spType: 'INCREASE_WITH_TIME', spCost: 39, initSp: 23,
      bb: { atk: 1.4, attack_speed: 40, 'attack@atk_scale': 1.5, 'attack@prob': 0.4, duration: 30 },
      trigger: { rule: 'DEFAULT' }, index: 2,
    },
  ],
};

/** A battle with the elite available, Bellone on (10,4) facing right, a dummy 1 tile ahead. */
const he = (extra = {}) => makeBattle({
  defs: {
    chess: { chess_bellone_a: bellone, chess_bellone_b: elite },
    enemies: { enemy_e: enemyRec({ key: 'enemy_e', hp: 1e7, def: 200, res: 0, atk: 0, speed: 0, bat: 99 }) },
  },
  units: [{ chessId: 'chess_bellone_b', row: 10, col: 4, ...(extra.unit || {}) }],
  enemies: [{ key: 'enemy_e', pos: [10, 5] }],
  timeLimit: 40,
  ...extra.opts,
});

test('贝洛内 S2 军师的手段: kit 把数据的官方 3-13 网格接进 targeting（不再用 rangeExtend）', () => {
  const s2rec = bellone.skills.find((s) => s.skillId === 'skchr_demetr_2');
  // the kit factory receives (bb, chess, def) with def.skill = the SELECTED skill record
  const spec = kits.chess_bellone_a({}, bellone, { skill: s2rec }).skills.skchr_demetr_2;
  assert.deepEqual(spec.targeting.rangeGrid, G313, 'S2 的 targeting.rangeGrid 就是官方 3-13');
  assert.equal(spec.targeting.rangeGrid.length, 8, '3-13 = 4×3 去四角 = 8 格');
  assert.equal(spec.targeting.maxTargets, 3);
  assert.equal(spec.targeting.rangeExtend, undefined, '不再用 rangeExtend 近似');
  // 网格按朝向旋转后正好落在预期的绝对格
  const abs = absoluteRangeKeys(spec.targeting.rangeGrid, 10, 4, 'RIGHT', 0);
  assert.deepEqual(abs.map((k) => [Math.floor(k / COLS), k % COLS]), [[11, 5], [11, 6], [10, 4], [10, 5], [10, 6], [10, 7], [9, 5], [9, 6]]);
  // 未选 S2 时不该带范围（默认 1-1）
  const s1rec = bellone.skills.find((s) => s.skillId === 'skchr_demetr_1');
  const spec1 = kits.chess_bellone_a({}, bellone, { skill: s1rec }).skills.skchr_demetr_2;
  assert.equal(spec1.targeting.rangeGrid, null, '数据没给技能范围时回落到默认');
});

// ---- 用户实测 bug（A-2）：敌人**只在技能范围、不在本体范围**时也必须开技能 -------------------------------------------
//
// 现象（用户 2026-10-05 报，会话 C 端到端复测）：贝洛内带 S2，敌人落在 S2 的 3-13 里、本体 1-1 外
// （例如本体在 (10,4)、敌人在 (10,7)）⇒ **技能永远不开** ✗。
// 根因：DEFAULT 技能的开启挂在「即将攻击」上（`onAboutToAttack`），而**没有目标就不会尝试攻击** ⇒
// 没有这次尝试，`onAboutToAttack` 永不触发。修法在 `server/sim/ai.js` 的 `acquireTargets`：
// 本体射程无目标时，退一步看「当前选定技能自身的 `rangeGrid`」，有目标就返回它（只影响"本来没目标"的情形）。
//
// ⚠️ 这条用例是**端到端**的（真的跑战斗循环），因为原来的 `bellone.test.js:100` 只断言数据接线
// （`targeting.rangeGrid` = 官方 3-13），它**覆盖不到这条症状** —— 那次 bug 就是从这个缺口漏过去的。

test('贝洛内 S2 只在技能范围内（本体射程外）也必须开技能（用户实测 A-2）', () => {
  // 本体 1-1 = (10,4) 自身 + (10,5)；S2 的 3-13 含 (10,7)（前方第 3 格）—— 敌人只落在后者里
  const b = makeBattle({
    defs: {
      chess: { chess_bellone_a: bellone },
      enemies: { enemy_e: enemyRec({ key: 'enemy_e', hp: 1e7, def: 200, res: 0, atk: 0, speed: 0, bat: 99 }) },
    },
    units: [{ chessId: 'chess_bellone_a', row: 10, col: 4, skillIndex: 1, carryState: { sp: 999 } }],
    enemies: [{ key: 'enemy_e', pos: [10, 7] }],
    timeLimit: 40,
  });
  const u = b.unit('chess_bellone_a');
  const sk = u.skill;
  assert.equal(sk.id, 'skchr_demetr_2', '选中的是 S2');
  // 前置条件（否则下面的断言没有意义）：敌人确实在技能范围里、且确实**不在**本体初始范围里
  const baseKeys = new Set(u.baseRangeKeys || u.rangeKeys || []);
  const inBase = baseKeys.has(10 * COLS + 7);
  assert.equal(inBase, false, `敌人在本体射程外（本体 ${[...baseKeys].map((k) => [Math.floor(k / COLS), k % COLS]).join(' ')}）`);
  // ⚠️ 注意：**不要**在这里断言 `sk._skillRangeSatisfied()` —— 它读的是 `u.def.skill.rangeGrid`，
  //    而**未选中技能时的 `def.skill` 就是默认技能**（S1），其 `rangeGrid` 是 null ⇒ 这条对贝洛内恒 false，
  //    与「技能范围」（`skills[1].rangeGrid`）不是同一个来源。真正管用的判据是**技能真的开了**（下面）✓。
  // 断言：技能真的开了（不是"看起来在打"）
  const a0 = sk.activations;
  b.runUntil(() => sk.activations > a0, 40);
  assert.ok(sk.activations > a0, `开过 ${sk.activations - a0} 次（应为 ≥1）`);
  assert.equal(sk.active, true, 'S2 处于激活态');
  checkInvariants(b.b);
});

test('贝洛内 S2 完全不在技能范围时仍然不开技能（A-2 的反向对照，防「无脑开」）', () => {
  const b = makeBattle({
    defs: {
      chess: { chess_bellone_a: bellone },
      enemies: { enemy_e: enemyRec({ key: 'enemy_e', hp: 1e7, def: 200, res: 0, atk: 0, speed: 0, bat: 99 }) },
    },
    units: [{ chessId: 'chess_bellone_a', row: 10, col: 4, skillIndex: 1, carryState: { sp: 999 } }],
    enemies: [{ key: 'enemy_e', pos: [10, 12] }],   // 3-13 之外（前方第 8 格）
    timeLimit: 40,
  });
  const u = b.unit('chess_bellone_a');
  const sk = u.skill;
  const a0 = sk.activations;
  b.run(20);
  assert.equal(sk.activations, a0, '技能范围里没有敌人 ⇒ 不该开技能');
  checkInvariants(b.b);
});

test('贝洛内 S3 清算: 技能开始【移动】到 x-2 内、最靠近目标的格；技能结束返回初始位置', () => {
  const b = he({ unit: { carryState: { sp: 999 }, skillIndex: 2 } });
  const u = b.unit('chess_bellone_b');
  const home = { r: u.tileR, c: u.tileC };
  b.runUntil(() => b.hooksOf('skillStart').some((c) => c.unit === u && c.skill?.id === 'skchr_demetr_3'), 40);
  assert.ok(b.hooksOf('skillStart').some((c) => c.unit === u && c.skill?.id === 'skchr_demetr_3'), 'S3 cast');
  const moved = u.tileR !== home.r || u.tileC !== home.c;
  assert.ok(moved, '【移动】应当把贝洛内挪到目标附近的一格');
  // 落点必须落在官方 x-2 选取范围内
  const allowed = new Set(absoluteRangeKeys(GX2, home.r, home.c, u.dir, 0));
  assert.ok(allowed.has(u.tileR * COLS + u.tileC), '【移动】的落点在 x-2 范围内');
  // 技能结束 → 返回初始位置
  b.runUntil(() => !u.skill.active, 40);
  assert.equal(u.tileR, home.r, '技能结束回到初始行');
  assert.equal(u.tileC, home.c, '技能结束回到初始列');
  checkInvariants(b.b);
});

test('贝洛内 S3 清算: 受到致命伤害时不撤退、生命保到 1、技能结束并返回初始位置', () => {
  const b = he({ unit: { carryState: { sp: 999 }, skillIndex: 2 } });
  const u = b.unit('chess_bellone_b');
  const home = { r: u.tileR, c: u.tileC };
  b.runUntil(() => u.skill?.active && u.skill.id === 'skchr_demetr_3', 40);
  assert.ok(u.skill.active, 'S3 已开启');
  // 一次必定致死的伤害（流失走的是同一条 fatal 记账路径）
  b.b.loseHp(u, 1e9, { source: null });
  assert.equal(u.alive, true, '受到致命伤害时不撤退');
  assert.ok(u.hp >= 1, `生命被保到 1（实际 ${u.hp}）`);
  assert.equal(u.skill.active, false, '致命伤害会结束技能');
  assert.equal(u.tileR, home.r, '技能结束返回初始行');
  assert.equal(u.tileC, home.c, '技能结束返回初始列');
  checkInvariants(b.b);
});

test('贝洛内 S3 清算: 击倒精英敌人后立即重新选取目标（换一个敌人再位移）', () => {
  // 两个敌人：近处一个精英（初始目标），更远一个普通敌人（重新选取后应当转向它）
  const b = makeBattle({
    defs: {
      chess: { chess_bellone_a: bellone, chess_bellone_b: elite },
      enemies: {
        enemy_e: enemyRec({ key: 'enemy_e', hp: 1e7, def: 0, res: 0, atk: 0, speed: 0, bat: 99, rank: 'ELITE' }),
        enemy_f: enemyRec({ key: 'enemy_f', hp: 1e7, def: 0, res: 0, atk: 0, speed: 0, bat: 99 }),
      },
    },
    units: [{ chessId: 'chess_bellone_b', row: 10, col: 4, carryState: { sp: 999 }, skillIndex: 2 }],
    enemies: [{ key: 'enemy_e', pos: [10, 5] }, { key: 'enemy_f', pos: [10, 7] }],
    timeLimit: 40,
  });
  const u = b.unit('chess_bellone_b');
  b.runUntil(() => u.skill?.active && u.skill.id === 'skchr_demetr_3', 40);
  assert.ok(u.skill.active, 'S3 已开启');
  const eliteFoe = b.enemies().find((e) => (e.def?.rank || '').toUpperCase() === 'ELITE');
  assert.ok(eliteFoe, '精英敌人存在');
  const before = { r: u.tileR, c: u.tileC };
  // 击倒精英 → 应当立即重新选取目标并朝剩下的敌人位移（走正常死亡路径以触发 kill 事件）
  b.b.loseHp(eliteFoe, 1e9, { source: u });
  b.step(2);
  assert.equal(eliteFoe.alive, false, '精英已被击倒');
  const moved = u.tileR !== before.r || u.tileC !== before.c;
  assert.ok(moved, `击倒精英后重新选取目标并位移（仍在 ${u.tileR},${u.tileC}）`);
  assert.ok(Math.abs(u.tileC - 7) < Math.abs(before.c - 7) || u.tileR !== before.r,
    '新落点比原来更靠近剩下的敌人');
  checkInvariants(b.b);
});
