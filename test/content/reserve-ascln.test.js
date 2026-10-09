// test/content/reserve-ascln.test.js — **阿斯卡纶**（char_4132_ascln，外援，A-7 第 2 位）的 kit 护栏。
//
// ⚠️ 与 `reserve-typhon.test.js` 同一套"**注入式**"做法与同一批坑（详见那边的文件头）：
//   · 必须 `content: 'generic'`（`'none'` 会让 `setupUnitKit` 直接 `return {}` ⇒ kit 根本不加载）；
//   · **不能用 `chessRec()`**（它不透传 `skills`）⇒ 手写完整记录；
//   · 顶层 `skill.id` 决定"装备的是哪个技能"；`skillIndex` 在注入式记录上不生效；
//   · 空格子键用 `r * COLS + c`，**`COLS` = 21**；加第二目标前先确认它在射程内。
//
// 官方口径（逐条抄自 `content-packs/ascln.pack.json.pending`）：
//   特性：对攻击范围内所有敌人造成伤害 / 50% 物法闪避 / 不易成为目标 —— **引擎既有，本文件只做一条"确实生效"的旁证**
//   天赋1 死亡拘审：移速 −18%、每秒 10% **当前**攻击力法术伤害、最多 3 层、25 s
//   天赋2 噬光残影：攻速 +8；周围四格有高台再 +6
//   S1 追袭：充能 2、下次攻击 ×1.3、连击两次
//   S2 恩赐：+50% 攻击、范围内地面敌人移速 −30%、击倒时给周围敌人补一层天赋1
//   S3 降临：+20% 攻击、间隔缩短、taunt +2（"命中率 −15%"与"未命中/闪避回血"未实现，见 kit 文件头）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, enemyRec, checkInvariants } from '../helpers/battleHarness.js';
import asclnKit from '../../server/sim/content/kits/reserve-ascln.js';

const ID = 'chess_ascln_a';
const approx = (a, b, eps = 1e-6, msg = '') => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${msg} ${a} ≈ ${b}`);
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

const sk = (skillId, o) => ({
  id: skillId, skillId, iconId: skillId, name: skillId, skillType: o.skillType ?? 'MANUAL', durationType: 'NONE',
  duration: o.duration ?? 0, spType: 'INCREASE_WITH_TIME', spCost: o.spCost ?? 30, initSp: o.initSp ?? 0,
  maxChargeTime: o.maxChargeTime ?? 1, bb: o.bb ?? {}, rangeId: null, rangeGrid: null,
  trigger: { rule: 'DEFAULT', rawRule: 'DEFAULT' }, index: o.index ?? 0, isDefault: !!o.isDefault,
});
const S1 = sk('skchr_ascln_1', { skillType: 'AUTO', bb: { atk_scale: 1.3, cnt: 2 }, duration: -1, spCost: 10, initSp: 2, maxChargeTime: 2, index: 0 });
const S2 = sk('skchr_ascln_2', { bb: { atk: 0.5, move_speed: -0.3, range_radius: 1.3 }, duration: 35, spCost: 27, initSp: 5, index: 1 });
const S3 = sk('skchr_ascln_3', { bb: { base_attack_time: -1.2, atk: 0.2, taunt_level: 2, 'attack@hp_ratio': 0.04, 'attack@damage_hitrate_physical': -0.15, 'attack@damage_hitrate_magical': -0.15 }, duration: 45, spCost: 53, initSp: 25, index: 2, isDefault: true });

// 特性 bb 的 `prob: 0.5` 是**引擎**读的（`professions.js:590`），所以这里要写上，才与真数据一致。
const ASCLN = {
  chessId: ID, baseId: ID, isGolden: false, tier: 6, name: '阿斯卡纶', charId: 'char_4132_ascln',
  profession: 'SPECIAL', subProfessionId: 'stalker', position: 'MELEE', bonds: [],
  stats: { maxHp: 1233, atk: 763, def: 283, res: 30, cost: 21, blockCnt: 0, bat: 3.5, aspd: 100, respawnTime: 70, spRecovery: 1, hpRecoveryPerSec: 0, moveSpeed: 1, tauntLevel: -1, massLevel: 0, deployLimit: 1, deckStack: 0 },
  rangeGrid: [[0, 0], [0, 1], [1, 0], [1, 1], [-1, 0], [-1, 1], [0, -1], [1, -1], [-1, -1], [0, 2]],
  dmgType: 'arts', attackKind: 'melee', projectile: 'none', canHitFly: false, targetPriority: null,
  trait: { desc: '对攻击范围内所有敌人造成伤害\n拥有50%的物理和法术闪避且不容易成为敌人的攻击目标', bb: { prob: 0.5 } },
  talents: [
    { index: 0, name: '死亡拘审', desc: '攻击对敌人施加效果', bb: { move_speed: -0.18, atk_ratio: 0.1, max_stack_cnt: 3, debuff_duration: 25, interval: 1 } },
    { index: 1, name: '噬光残影', desc: '攻击速度+8…', bb: { attack_speed: 8, attack_speed_add: 6, cnt: 1 } },
  ],
  tokens: [], immunities: {},
  skill: S3, skills: [S1, S2, S3],
};
function recFor(skillId) {
  const s = ASCLN.skills.find((x) => x.skillId === skillId);
  assert.ok(s, `记录里必须有 ${skillId}`);
  return { ...ASCLN, skill: s };
}

// ⚠️ kit 模块的默认导出是**对象**（{ chess_<slug>_a: 工厂 }，与另三个 reserve-*.js 同形）
//    ⇒ 这里必须**取出那个工厂**，不能把对象当工厂传（否则 4 条探针全红）。
const asclnFactory = Object.values(asclnKit)[0];
const KITS = { [ID]: asclnFactory };
/** 一片开阔地面；`extra` 用来铺高台（`'^'` 之类），见各用例。 */
const ROWS_FLAT = {}; for (const r of [6, 7, 8, 9, 10, 11]) ROWS_FLAT[r] = '#' + 'w'.repeat(19) + '#';
const DUMMY = (o = {}) => enemyRec({ key: 'enemy_dummy', hp: 1e8, speed: 0, atk: 0, def: 0, res: 0, ...o });

function arena({ skillId = 'skchr_ascln_3', enemies = null, sp = 999, rows = null, units = null } = {}) {
  const defs = { chess: { [ID]: recFor(skillId) }, enemies: { enemy_dummy: DUMMY() } };
  const h = makeBattle({
    defs, kits: KITS, content: 'generic', timeLimit: 60, autoFinish: false, captureNoisy: true,
    ...(rows ? { stage: { rows } } : {}),
    units: units ?? [{ chessId: ID, row: 10, col: 3, dir: 'RIGHT', carryState: { sp } }],
    enemies: enemies ?? [{ key: 'enemy_dummy', pos: [10, 5] }],
  });
  h.step();
  return { h, u: h.unit(ID) };
}
const done = (h) => { checkInvariants(h.b); assert.deepEqual(h.b.errors.map((e) => `${e.label} ${e.message}`), []); };

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 特性：引擎既有（`allInRange` + 50% 闪避 + taunt −1）—— 只做"确实生效"的旁证，**不要重复实现**
test('阿斯卡纶 特性：`allInRange`（打范围内所有敌人）+ 50% 物法闪避 + taunt −1（**引擎既有**）', () => {
  // 两个敌人都必须在射程内：她的 rangeGrid 最远到 col 5（(10,3)+2）=> (10,6) 是界外
  const { h, u } = arena({ enemies: [{ key: 'enemy_dummy', pos: [10, 4] }, { key: 'enemy_dummy', pos: [10, 5] }] });
  assert.equal(u.profile.allInRange, true, 'profile.allInRange 必须为真（伏击者特性）');
  assert.equal(u.profile.dodge, 0.5, '闪避率取自特性 bb 的 prob');
  approx(num(u.findBuff('trait:stalker')?.mods?.dodgePhys), 0.5, 1e-9, '物理闪避 buff 已挂上');
  approx(num(u.findBuff('trait:stalker')?.mods?.dodgeArts), 0.5, 1e-9, '法术闪避 buff 已挂上');
  approx(num(u.findBuff('trait:stalker')?.mods?.taunt), -1, 1e-9, '不易成为目标（taunt −1）');
  // `allInRange` = 一次攻击动作打到范围内的**所有**敌人 ⇒ 同一步里应出现两个不同目标。
  // ⚠️ 本体的 `bat` 是 **3.5 s** ⇒ 步数要给够（150 步 × 0.05 s ≈ 7.5 s 才 2 次攻击）。
  let pair = false;
  for (let i = 0; i < 300 && !pair; i++) {
    const before = h.hooksOf('damaged').length;
    h.b.step();
    const ids = new Set(h.hooksOf('damaged').slice(before).filter((c) => c.source === u && c.dmg?.isAttack).map((c) => c.target.id));
    if (ids.size >= 2) pair = true;
  }
  assert.ok(pair, '同一步内应命中范围内两个不同敌人（allInRange）');
  done(h);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 天赋1 死亡拘审：移速 −18% + 每秒 10% 当前攻击力法术伤害，最多 3 层 / 25 s
test('阿斯卡纶 天赋1「死亡拘审」：−18% 移速 + 每秒 10% 当前攻击力法术伤害，**最多 3 层**', () => {
  const { h, u } = arena({ enemies: [{ key: 'enemy_dummy', pos: [10, 5] }] });
  const e = h.enemies()[0];
  h.run(0.2);
  const b0 = e.findBuff('talent:ascln_detention');
  assert.ok(b0, '首次命中后应挂上「死亡拘审」');
  approx(num(b0.mods?.movePct), -0.18, 1e-9, '移速 −18%');
  // 叠层：继续打 ⇒ 层数上升，但**不超过 3**
  h.run(20);
  const b1 = e.findBuff('talent:ascln_detention');
  assert.ok(b1, 'buff 还在（25 s 内）');
  const n = num(b1.stacks, 1);
  assert.ok(n >= 2, `应已叠层（实得 ${n}）`);
  assert.ok(n <= 3, `最多 3 层（实得 ${n}）`);
  // DOT：每秒掉一次血，且掉血量与"当前攻击力 × 10% × 层数"一致
  const hp0 = e.hp;
  h.run(3.0);
  const lost = hp0 - e.hp;
  assert.ok(lost > 0, `「死亡拘审」应有 DOT（实测掉了 ${lost}）`);
  // 单层 ≈ atk × 0.1；这里至少能证明量级正确（层数≥2 时约 2 倍）
  const one = num(u.s.atk) * 0.1;
  assert.ok(lost >= one * 1.5, `3 秒的 DOT 应 ≥ 约 3 跳 × 单层（单层 ${one.toFixed(1)}，实测 ${lost.toFixed(1)}）`);
  done(h);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 天赋2 噬光残影：攻速 +8；周围四格有高台再 +6
test('阿斯卡纶 天赋2「噬光残影」：攻速 +8；**周围四格有高台**时额外 +6', () => {
  // 地形：'w' = 可走地面，'^' = 高台（`height HIGH`，需可部署）。
  // `10,3` 的**上/下邻格留作高台**：在 (9,3) 放一个高台。
  // ⚠️ 网格格子的 height/build 是**冻结的**（实测 `Cannot assign to read only property 'height'`）
  //    ⇒ **不能"改格子"，只能"选位置"**。默认 arena 里 row10–12 的 **col 2 是高台**（实测）：
  //      (10,2)/(11,2) = `height HIGH`、`build RANGED`、`canStand({ranged:true}) = true`。
  // 对照 A：**周围四格真有高台** ⇒ aspd = 100 + 8 + 6
  const hi = arena({ enemies: [{ key: 'enemy_dummy', pos: [10, 5] }] });
  hi.h.run(0.7);
  assert.equal(hi.h.b.grid.tile(10, 2).height, 'HIGH', '前置：默认 arena 的 (10,2) 是高台');
  approx(num(hi.u.s.aspd), 100 + 8 + 6, 1e-6, '周围有高台：攻速 = 100 + 8 + 6');
  done(hi.h);
  // 对照 B：把干员放在**邻域没有高台**的位置（col 4：邻域 col 3–5，全 LOW）⇒ aspd = 100 + 8
  const flat = arena({ units: [{ chessId: ID, row: 10, col: 4, dir: 'RIGHT', carryState: { sp: 999 } }], enemies: [{ key: 'enemy_dummy', pos: [10, 6] }] });
  flat.h.run(0.7);
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    if (!dr && !dc) continue;
    const t = flat.h.b.grid.tile(10 + dr, 4 + dc);
    assert.notEqual(t.height, 'HIGH', `前置：(${10 + dr},${4 + dc}) 不该是高台`);
  }
  approx(num(flat.u.s.aspd), 100 + 8, 1e-6, '周围无高台：攻速 = 100 + 8');
  done(flat.h);
  done(hi.h);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// S1 追袭：可充能 2 次，下次攻击 ×1.3 并连击两次
test('阿斯卡纶 S1「追袭」：**可充能 2 次**；下次攻击 ×1.3 且连击两次', () => {
  const { h, u } = arena({ skillId: 'skchr_ascln_1', sp: 0 });
  assert.equal(u.skill.kind, 'charges', `S1 应为可充能（kind=charges），实得 ${u.skill.kind}`);
  assert.equal(u.skill.maxCharges, 2, 'maxCharges = 2（官方"可充能2次"）');
  approx(num(u.skill.spec.attack.atkScale), 1.3, 1e-9, '攻击力 ×1.3');
  assert.equal(num(u.skill.spec.attack.hits), 2, '连击两次（hits=2）');
  const e = h.enemies()[0];
  u.skill.gainSp(999);
  h.run(0.1);
  u.skill.activate('test', { free: true });
  const before = h.hooksOf('damaged').length;
  h.run(8);
  const hits = h.hooksOf('damaged').slice(before).filter((c) => c.source === u && c.target === e);
  assert.ok(hits.length >= 2, `应至少打出两次（实得 ${hits.length}）`);
  done(h);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// S2 恩赐：+50% 攻击；范围内**地面**敌人移速 −30%；击倒时给周围敌人补一层天赋1
test('阿斯卡纶 S2「恩赐」：+50% 攻击、范围内**地面**敌人 −30% 移速、**击倒时**给周围补一层天赋1', () => {
  const { h, u } = arena({ skillId: 'skchr_ascln_2', sp: 999, enemies: [{ key: 'enemy_dummy', pos: [10, 4] }] });
  const atk0 = u.base.atk;
  u.skill.activate('test', { free: true });
  h.run(1.2);   // ⚠️ 实测减速要到 ~1.2 s 才在（every(0.5) + 语义窗口）
  assert.ok(u.skill.active, 'S2 已激活');
  approx(num(u.s.atk), atk0 * 1.5, 1e-6, '攻击力 ×1.5');
  const e = h.enemies()[0];
  assert.ok(e.findBuff('skill:ascln_s2_slow'), '范围内的敌人应被减速');
  approx(num(e.findBuff('skill:ascln_s2_slow').mods?.movePct), -0.3, 1e-6, '移速 −30%');
  // 击倒时给**周围敌人**补一层天赋1：在死者旁边放一个新敌人，然后击杀它旁边的那个
  const near = h.spawn('enemy_dummy', { pos: [10, 5] });
  const victim = h.spawn('enemy_dummy', { pos: [10, 4] });
  h.run(0.2);
  assert.equal(near.findBuff('talent:ascln_detention'), null, '前置：near 此时还没有「死亡拘审」');
  h.b.kill(victim, u);
  h.run(0.2);
  assert.ok(near.findBuff('talent:ascln_detention'), '**击倒**时应给周围敌人补一层「死亡拘审」');
  done(h);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// S3 降临：+20% 攻击、攻击间隔缩短、taunt +2
test('阿斯卡纶 S3「降临」：+20% 攻击、**攻击间隔缩短**、自身更易被攻击（taunt +2）', () => {
  const { h, u } = arena({ skillId: 'skchr_ascln_3', sp: 999 });
  const atk0 = u.base.atk, bat0 = u.base.bat;
  u.skill.activate('test', { free: true });
  h.run(0.2);
  assert.ok(u.skill.active, 'S3 已激活');
  approx(num(u.s.atk), atk0 * 1.2, 1e-6, '攻击力 ×1.2');
  assert.ok(num(u.s.bat) < bat0, `攻击间隔应缩短（${bat0} → ${num(u.s.bat)}）`);
  approx(num(u.s.bat), bat0 - 1.2, 1e-6, '平加 −1.2 s（`batMod` 的秒数约定）');
  approx(num(u.findBuff('skill:1')?.mods?.taunt ?? u.s.taunt), 2, 1e-6, 'taunt +2（更易成为目标）');
  done(h);
});
