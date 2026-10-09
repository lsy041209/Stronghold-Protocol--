// test/content/reserve-logos.test.js — **逻各斯**（char_4133_logos，外援，A-7 第 3 位）的 kit 护栏。
//
// ⚠️ 与 `reserve-typhon.test.js` / `reserve-ascln.test.js` 同一套"**注入式**"做法与同一批坑：
//   · 必须 `content: 'generic'`（`'none'` 会让 kit 根本不加载）；
//   · **不能用 `chessRec()`**（它不透传 `skills`）⇒ 手写完整记录；
//   · 顶层 `skill.id` 决定"装备的是哪个技能"；`skillIndex` 在注入式记录上不生效；
//   · 敌人必须在射程内（**先打印 `enemiesInKeys` 确认**）。
//
// 官方口径（抄自 `content-packs/logos.pack.json.pending`）：
//   特性：攻击造成法术伤害（引擎既有）
//   天赋1 语汇演化：攻击时 40% 几率额外对范围内**随机**一个目标造成 60% 攻击力的法术伤害 + 停顿 0.8 s
//   天赋2 剜魂具辞：攻击使目标 5 s 内法术抗性 −10（**"+150 点受到法术伤害"引擎无原语，未做**）
//   S1 殁亡（无限持续）：范围扩大、+40% 攻击、**处决**（生命 < 攻击力 90% 立刻倒下）+ 对另一随机目标等量法术伤害
//   S2 提喻：法术抗性 +40；攻击改为锁定目标每 0.5 s 一跳、伤害渐增至 3 倍、移速渐降
//   S3 延异视阈：范围扩大、+160% 攻击、同时 3 个目标
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, enemyRec, checkInvariants } from '../helpers/battleHarness.js';
import logosKit from '../../server/sim/content/kits/reserve-logos.js';

const ID = 'chess_logos_a';
const approx = (a, b, eps = 1e-6, msg = '') => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${msg} ${a} ≈ ${b}`);
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

const sk = (skillId, o) => ({
  id: skillId, skillId, iconId: skillId, name: skillId, skillType: o.skillType ?? 'MANUAL', durationType: 'NONE',
  duration: o.duration ?? 0, spType: 'INCREASE_WITH_TIME', spCost: o.spCost ?? 30, initSp: o.initSp ?? 0,
  maxChargeTime: 1, bb: o.bb ?? {}, rangeId: null, rangeGrid: o.rangeGrid ?? null,
  trigger: { rule: 'DEFAULT', rawRule: 'DEFAULT' }, index: o.index ?? 0, isDefault: !!o.isDefault,
});
// 本体射程（10 格，与 pack 同构）；S1/S3 各自扩到 12/18 格
const BASE_GRID = [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2], [-1, 0], [-1, 1], [-1, 2], [0, 3]];
const S1_GRID = [...BASE_GRID, [1, 3], [-1, 3]];
const S3_GRID = [...S1_GRID, [0, 4], [1, 4], [-1, 4], [0, -1], [1, -1], [-1, -1], [0, -2], [1, -2]];
const S1 = sk('skchr_logos_1', { skillType: 'AUTO', bb: { atk: 0.4, 'attack@kill_atk_scale': 0.9, 'attack@kill_damage': 9999999 }, duration: -1, spCost: 74, initSp: 0, index: 0, rangeGrid: S1_GRID });
const S2 = sk('skchr_logos_2', { bb: { magic_resistance: 40, 'attack@cooldown': 0.5, 'attack@atk_scale_base': 0.35, 'attack@atk_scale_delta': 0.07, 'attack@move_speed': -0.06, 'attack@max_stack_cnt': 10 }, duration: 20, spCost: 39, initSp: 20, index: 1 });
const S3 = sk('skchr_logos_3', { bb: { atk: 1.6, 'attack@max_target': 3, projectile_move_scale: 0.05 }, duration: 30, spCost: 45, initSp: 9, index: 2, isDefault: true, rangeGrid: S3_GRID });

const LOGOS = {
  chessId: ID, baseId: ID, isGolden: false, tier: 6, name: '逻各斯', charId: 'char_4133_logos',
  profession: 'CASTER', subProfessionId: 'corecaster', position: 'RANGED', bonds: [],
  stats: { maxHp: 1297, atk: 556, def: 106, res: 20, cost: 21, blockCnt: 1, bat: 1.6, aspd: 100, respawnTime: 70, spRecovery: 1, hpRecoveryPerSec: 0, moveSpeed: 1, tauntLevel: 0, massLevel: 0, deployLimit: 1, deckStack: 0 },
  rangeGrid: BASE_GRID,
  dmgType: 'arts', attackKind: 'ranged', projectile: 'bolt', canHitFly: true, targetPriority: null,
  trait: { desc: '攻击造成法术伤害', bb: {} },
  talents: [
    { index: 0, name: '语汇演化', desc: '40% 几率额外打一个随机目标', bb: { prob: 0.4, atk_scale: 0.6, sluggish: 0.8 } },
    { index: 1, name: '剜魂具辞', desc: '法术抗性 −10', bb: { duration: 5, magic_resistance: -10, atk_addition: 150 } },
  ],
  tokens: [], immunities: {},
  skill: S3, skills: [S1, S2, S3],
};
function recFor(skillId) {
  const s = LOGOS.skills.find((x) => x.skillId === skillId);
  assert.ok(s, `记录里必须有 ${skillId}`);
  return { ...LOGOS, skill: s };
}
// ⚠️ kit 模块的默认导出是**对象**（{ chess_<slug>_a: 工厂 }，与另三个 reserve-*.js 同形）
//    ⇒ 这里必须**取出那个工厂**，不能把对象当工厂传（否则 4 条探针全红）。
const logosFactory = Object.values(logosKit)[0];
const KITS = { [ID]: logosFactory };
const DUMMY = (o = {}) => enemyRec({ key: 'enemy_dummy', hp: 1e8, speed: 0, atk: 0, def: 0, res: 0, ...o });
function arena({ skillId = 'skchr_logos_3', enemies = null, sp = 999 } = {}) {
  const defs = { chess: { [ID]: recFor(skillId) }, enemies: { enemy_dummy: DUMMY(), enemy_soft: DUMMY({ key: 'enemy_soft', hp: 400 }) } };
  const h = makeBattle({
    defs, kits: KITS, content: 'generic', timeLimit: 60, autoFinish: false, captureNoisy: true,
    units: [{ chessId: ID, row: 10, col: 3, dir: 'RIGHT', carryState: { sp } }],
    enemies: enemies ?? [{ key: 'enemy_dummy', pos: [10, 5] }],
  });
  h.step();
  return { h, u: h.unit(ID) };
}
const done = (h) => { checkInvariants(h.b); assert.deepEqual(h.b.errors.map((e) => `${e.label} ${e.message}`), []); };

// ─────────────────────────────────────────────────────────────────────────────────────────────
test('逻各斯 天赋1「语汇演化」：攻击时 40% 几率额外打一个**随机**目标（60% 法术）+ 停顿 0.8 s', () => {
  // 多放几个敌人，保证"另一个随机目标"有得选
  const { h, u } = arena({ enemies: [
    { key: 'enemy_dummy', pos: [10, 4] }, { key: 'enemy_dummy', pos: [10, 5] }, { key: 'enemy_dummy', pos: [10, 6] },
  ] });
  let echo = false, slowed = false;
  for (let i = 0; i < 400 && !(echo && slowed); i++) {
    h.b.step();
    if (h.hooksOf('damaged').some((c) => c.source === u && c.dmg?.tags?.includes('logosEcho'))) echo = true;
    if (h.enemies().some((e) => e.findBuff('sluggish'))) slowed = true;
  }
  assert.ok(echo, '应出现「语汇演化」的额外一击（tags 含 logosEcho）');
  assert.ok(slowed, '额外一击应带停顿（sluggish）');
  // 额外一击的伤害 = 当时攻击力 × 0.6
  const e = h.hooksOf('damaged').filter((c) => c.source === u && c.dmg?.tags?.includes('logosEcho'))[0];
  approx(e.amount, num(u.s.atk) * 0.6, 0.02, '额外一击 = 攻击力 ×0.6');
  done(h);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
test('逻各斯 天赋2「剜魂具辞」：攻击使目标 5 s 内**法术抗性 −10**', () => {
  const { h, u } = arena({});
  const e = h.enemies()[0];
  h.run(3);
  const b = e.findBuff('talent:logos_res_down');
  assert.ok(b, '命中后应挂上「剜魂具辞」');
  approx(num(b.mods?.resFlat), -10, 1e-9, '法术抗性 −10（resFlat）');
  approx(num(b.stacks) || 1, 1, 1e-9, '单层');
  done(h);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
test('逻各斯 S1「殁亡」：**处决**生命值 < 攻击力 90% 的敌人，并对另一随机目标造成等量法术伤害', () => {
  // ⚠️ 软目标必须**在开打之后**再手动放进来：`h.step()` 里 Logos 一出手就是 556 伤害，
  //    400 血的软目标**在第一帧就被普攻打死了**（我在这里红了两次）⇒ 用 `h.spawn` 精确控制时机。
  const { h, u } = arena({ skillId: 'skchr_logos_1', sp: 999, enemies: [{ key: 'enemy_dummy', pos: [10, 5] }] });
  u.skill.activate('test', { free: true });
  h.run(0.2);
  assert.ok(u.skill.active, 'S1 已激活');
  // 阈值 = 556 × 0.9 = 500.4；给 400 血 ⇒ **必然低于阈值**，但不会被一记普攻秒掉
  const soft = h.spawn('enemy_soft', { pos: [10, 4] });
  assert.ok(soft && soft.alive, '前置：软目标已放进射程内');
  assert.ok(soft.hp < 500.4, `前置：400 < 阈值 500.4（实得 ${soft.hp}）`);
  const softId = soft.id, softHp = soft.hp;
  const before = h.hooksOf('damaged').length;
  h.run(3.5);                                  // 等下一次攻击触发 onAttack 的处决
  assert.equal(h.b.enemies.find((e) => e.id === softId)?.alive ?? false, false, '生命 < 阈值 ⇒ 应被**立刻处决**');
  const exec = h.hooksOf('damaged').slice(before).find((c) => c.source === u && c.dmg?.tags?.includes('logosExecute'));
  assert.ok(exec, '应出现「等量法术伤害」的那一发（tags 含 logosExecute）');
  approx(exec.amount, softHp, 1e-6, '伤害 = 倒下单位的生命值');
  done(h);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
test('逻各斯 S2「提喻」：**法术抗性 +40**；锁定目标每 0.5 s 一跳、伤害**逐渐提高**', () => {
  const { h, u } = arena({ skillId: 'skchr_logos_2', sp: 999 });
  const res0 = u.base.res;
  u.skill.activate('test', { free: true });
  h.run(0.3);
  assert.ok(u.skill.active, 'S2 已激活');
  approx(num(u.s.res), res0 + 40, 1e-6, '法术抗性 +40');
  const e = h.enemies()[0];
  const before = h.hooksOf('damaged').length;
  h.run(3.0);
  const burn = h.hooksOf('damaged').slice(before).filter((c) => c.source === u && c.dmg?.tags?.includes('logosBurn'));
  assert.ok(burn.length >= 4, `每 0.5 s 一跳 ⇒ 3 s 内应 ≥ 6 跳（实得 ${burn.length}）`);
  assert.ok(burn[burn.length - 1].amount > burn[0].amount, `伤害应逐渐提高（首跳 ${burn[0].amount.toFixed(0)} → 末跳 ${burn[burn.length - 1].amount.toFixed(0)}）`);
  assert.ok(e.findBuff('skill:logos_s2_burn'), '目标应被挂上减速');
  done(h);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
test('逻各斯 S3「延异视阈」：**攻击力 +160%**、**同时攻击 3 个目标**（默认技能）', () => {
  const { h, u } = arena({ skillId: 'skchr_logos_3', sp: 999 });
  const atk0 = u.base.atk;
  u.skill.activate('test', { free: true });
  h.run(0.3);
  assert.ok(u.skill.active, 'S3 已激活');
  approx(num(u.s.atk), atk0 * 2.6, 1e-6, '攻击力 ×2.6（+160%）');
  assert.equal(num(u.skill.spec?.targeting?.maxTargets), 3, '同时攻击 3 个目标');
  done(h);
});
