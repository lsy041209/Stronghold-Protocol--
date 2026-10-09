// test/content/reserve-makoto.test.js — **结城理**（char_4217_makoto，外援，A-7）的 kit 护栏。
//
// ⚠️ 与另几份 `reserve-*.test.js` 同一套"**注入式**"做法与同一批坑：
//   · 必须 `content: 'generic'`（`'none'` 会让 kit 根本不加载 ⇒ 一批不相关的探针同时全红）；
//   · 记录从**我们的内容包**读（`content-packs/makoto.pack.json[.pending]` —— 外援在 `--enable` 之前 `data/` 里没有它）；
//   · 注入式记录**没有 `def.raw`** ⇒ 每条技能要补 `id`；
//   · ⚠️ **`sp` 必须给 0**：给满技力会让基础技能策略**开局自动施放** S3（= 立刻切替身），
//     那样"前置：一开始是本体"这类断言会红 —— 这不是 kit 的 bug，是**探针没搭好场景**（本人第一版就踩了）。
//   · 本体的近战射程只有 2 格（`[[0,0],[0,1]]`）⇒ 敌人要**贴脸**；而**技能范围是 13 格**（替身的作战范围按技能走）。
//
// 官方口径（抄自 `content-packs/makoto.pack.json.pending`）：
//   特性：受致命伤 ⇒ 切换成<替身>作战（引擎 `professions.js installDollkeeper`），20 秒后切回
//   天赋0 不羁之力：切换为<替身>时停顿周围敌人 8 秒；替身期间攻击力 +85%、攻击间隔增大、生命值 +35%
//   天赋1 S.E.E.S.队长：替身**结束**后发动总攻击 —— 450% 攻击力**真实**伤害
//   ⚠️ **满潜能口径**（用户 2026-10-07 21:2x 裁定 U-19 = (A)：我方新干员与基座一致，按满潜能取值；
//      上游 `test/full-potential.test.js` 是这条口径的真源）：上面两个数字是**潜能 5** 之后的值
//      （官方 candidate `requiredPotentialRank` 4 / 2）⇒ 旧版的 +80% / 430% 是**潜能 0**，已作废。
//      按 §十.2「判据滞后于实现」同步改了本条的两处断言（1.8 → 1.85、4.3 → 4.5）。
//   S1 俄耳甫斯的竖琴：替身攻击 150% 法术；范围内有 < 50% 生命的友方 ⇒ 改为治疗 40% 攻击力
//   S2 塔纳托斯的囚锁：替身攻击至多 3 名 160% 法术 + 35% 恐惧；恐惧中且生命 < 230% 攻击力 ⇒ 立刻倒下
//   S3 开辟明日的剑刃：替身初始塔纳托斯、攻速 +30、至多 3 名 170%（**法术** —— 官方备注「弱点伤害的默认伤害
//        类型为法术伤害」；第 51 轮按"真实伤害"实现是错的，第 52 轮已修正）、阻挡 +2；
//        塔纳托斯在场时开技能/受致命伤 ⇒ 改召俄耳甫斯（范围友方 30% 物法闪避 + 每秒治疗 25% 攻击力）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeBattle, chessRec, enemyRec, checkInvariants } from '../helpers/battleHarness.js';
import kit from '../../server/sim/content/kits/reserve-makoto.js';

const ID = 'chess_makoto_a';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const approx = (a, b, eps = 1e-6, msg = '') => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${msg}：${a} ≈ ${b}`);

/** 记录来自我们的内容包（`.pending` 也算 —— 外援在 `--enable` 之前 `data/` 里没有它）。 */
function recOf() {
  for (const n of ['makoto.pack.json.pending', 'makoto.pack.json']) {
    let raw = null;
    try { raw = readFileSync(path.join(ROOT, 'content-packs', n), 'utf8'); } catch { continue; }
    const rec = JSON.parse(raw).chess[0];
    const skills = (rec.skills ?? []).map((s) => ({ ...s, id: s.id ?? s.skillId }));
    return { ...rec, baseId: rec.chessId, isGolden: false, skills, skill: skills.find((s) => s.isDefault) ?? skills[0] };
  }
  throw new Error('找不到 content-packs/makoto.pack.json[.pending]');
}
const REC = recOf();
const recFor = (skillId) => {
  const s = REC.skills.find((x) => x.skillId === skillId);
  assert.ok(s, `pack 里必须有 ${skillId}`);
  return { ...REC, skill: s };
};
const factory = Object.values(kit)[0];
assert.equal(typeof factory, 'function', 'kit 的默认导出必须是对象、值是工厂函数');
const KITS = { [ID]: factory };

const DUMMY = (o = {}) => enemyRec({ key: 'enemy_dummy', hp: 1e5, speed: 0, atk: 0, def: 0, res: 0, ...o });
const ALLY = () => chessRec({ id: 't_ally', profession: 'WARRIOR', stats: { maxHp: 2000, atk: 100, def: 0, bat: 1.2 }, skill: null });
/** 最小战场：结城理 ＋ 可选友方 ＋ 可选敌人。**默认敌人在 [10,4]（贴脸，在 2 格近战射程里）**。 */
function arena({ skillId = 'skchr_makoto_3', sp = 0, enemies = null, allies = [] } = {}) {
  const defs = {
    chess: { [ID]: recFor(skillId), t_ally: ALLY() },
    enemies: { enemy_dummy: DUMMY(), enemy_soft: DUMMY({ key: 'enemy_soft', hp: 1e5 }) },
  };
  const units = [{ chessId: ID, row: 10, col: 3, dir: 'RIGHT', carryState: { sp } },
    ...allies.map((a, i) => ({ chessId: 't_ally', row: a.row ?? 10, col: a.col ?? 4 + i, dir: 'RIGHT', carryState: { sp: 0 } }))];
  const h = makeBattle({
    defs, kits: KITS, content: 'generic', timeLimit: 60, autoFinish: false, captureNoisy: true,
    units, enemies: enemies ?? [{ key: 'enemy_dummy', pos: [10, 4] }],
  });
  h.step();
  return { h, u: h.unit(ID) };
}
/** 让结城理进入替身（`lethal` = 用一次致命伤触发，走官方的傀儡师路径）。 */
const toDoll = ({ h, u }, lethal = false) => {
  if (lethal) h.b.dealDamage(null, u, { amount: 1e9, type: 'true' });
  else h.b.emit('dollSwitch', { unit: u, reason: 'test', done: false });
};
const done = (h) => { checkInvariants(h.b); assert.deepEqual(h.b.errors.map((e) => `${e.label} ${e.message}`), []); };
const tagged = (h, tag) => h.hooksOf('damaged').filter((c) => c.dmg?.tags?.includes(tag));

// ── 结构性判据（一开始就绿：证明"工地搭起来了"）──────────────────────────────────────────────
test('接线：kits/reserve.js 里必须有这一位（否则 kit 永远是死代码）', () => {
  const src = readFileSync(path.join(ROOT, 'server/sim/content/kits/reserve.js'), 'utf8');
  assert.ok(src.includes('reserve-makoto.js'), 'reserve.js 缺少 import');
  assert.ok(src.includes('...makoto'), 'reserve.js 的默认导出里缺少展开');
});

test('导出形态：默认导出是对象，键 = chess_makoto_a，值是工厂函数', () => {
  assert.equal(typeof kit, 'object');
  assert.deepEqual(Object.keys(kit), [ID]);
  assert.equal(typeof kit[ID], 'function');
});

test('冒烟：kit 接上跑 5 游戏秒不崩、不变量成立', () => {
  const { h } = arena({});
  h.run(5);
  done(h);
});

// ── 特性：致命伤 ⇒ 替身 20 秒 ⇒ 切回 ─────────────────────────────────────────────────────────
test('特性（傀儡师）：受到致命伤不撤退，切换成<替身>（阻挡 0），20 秒后切回本体', () => {
  const { h, u } = arena({ skillId: 'skchr_makoto_1' });     // 用不带阻挡修正的技能量"替身阻挡数为 0"
  assert.ok(!u.trait.doll, '前置：一开始是本体');
  toDoll({ h, u }, true);
  assert.ok(u.alive, '致命伤没有让她撤退');
  assert.equal(u.trait.doll, true, '已经切换成<替身>');
  assert.equal(u.form, 'doll', '形态 = doll（客户端据此画替身）');
  h.run(1.2);                                   // 走完 1 秒切换动画
  assert.equal(u.s.blockCnt, 0, '替身阻挡数为 0（引擎 −99）');
  assert.ok(u.hpRatio > 0.99, '切换后满血');
  h.runUntil(() => !u.trait.doll, 30);          // 20 秒到点 ⇒ 自己切回
  assert.ok(u.alive && !u.trait.doll, '切回本体');
  // ⚠️ 第 52 轮 A：切回本体的**同一瞬间**进 <总攻击> 形态（天赋1；官方备注"先切总攻击形态…随后再切换回本体"）
  //    ⇒ 这里先看到 'allout'，1.6 s（`ALLOUT_DUR`）之后才回 null。
  assert.equal(u.form, 'allout', '替身结束 ⇒ 先切 <总攻击> 形态');
  h.run(2);
  assert.equal(u.form, null, '<总攻击> 结束 ⇒ 回本体形态');
  done(h);
});

test('天赋0：切换为<替身>时停顿周围敌人 8 秒；替身期间攻击力 +85%、生命上限 +35%、攻击间隔增大', () => {
  const { h, u } = arena({});
  const e = h.enemies()[0];
  const atk0 = u.base.atk, hp0 = u.base.maxHp, bat0 = u.base.bat;
  toDoll({ h, u });
  h.run(0.1);
  const sl = e.findBuff('sluggish');
  assert.ok(sl, '周围敌人应被「不羁之力」停顿');
  const slDur = sl.duration ?? sl.timeLeft ?? 8;
  assert.ok(slDur > 7 && slDur <= 8.1, `停顿 8 秒（实得 ${slDur}）`);
  h.run(1.2);                                   // 过切换动画 ⇒ 形态加成生效
  approx(u.s.atk / atk0, 1.85, 0.02, '攻击力 +85%');
  approx(u.s.maxHp / hp0, 1.35, 0.02, '生命上限 +35%');
  approx(u.s.bat, bat0 + 0.4, 0.03, '攻击间隔 +0.4 秒（官方 base_attack_time 0.4）');
  done(h);
});

// ── S1 俄耳甫斯的竖琴 ───────────────────────────────────────────────────────────────────────
test('S1：主动立即切换为<替身>；替身攻击造成 150% 攻击力**法术**伤害（tag makotoOrpheus）', () => {
  const { h, u } = arena({ skillId: 'skchr_makoto_1' });
  assert.equal(u.skill.id, 'skchr_makoto_1', '装备的是 S1');
  u.skill.activate('test', { free: true });
  h.run(1.2);
  assert.ok(u.trait.doll, 'S1 主动把她切成了<替身>');
  const before = tagged(h, 'makotoOrpheus').length;
  h.run(3);
  const hits = tagged(h, 'makotoOrpheus').slice(before);
  assert.ok(hits.length >= 1, '替身至少打了一下');
  approx(hits[0].amount, u.s.atk * 1.5, 0.05, '150% 攻击力');
  assert.equal(hits[0].dmg.type, 'arts', '法术伤害');
  done(h);
});

test('S1：范围内有生命值低于一半的友方 ⇒ 这一下改为治疗它（40% 攻击力）', () => {
  const { h, u } = arena({ skillId: 'skchr_makoto_1', allies: [{ row: 11, col: 3 }] });   // 偏移 [1,0]，在 13 格技能范围内
  const ally = h.b.allyUnits.find((x) => x.id !== u.id);
  assert.ok(ally, '前置：友方在场');
  toDoll({ h, u });
  h.run(1.2);
  ally.hp = ally.s.maxHp * 0.3;                 // < 50%
  const hp0 = ally.hp, hits0 = tagged(h, 'makotoOrpheus').length;
  h.run(3);
  assert.ok(ally.hp > hp0, `低血友方应被治疗（${hp0} → ${ally.hp}）`);
  approx(tagged(h, 'makotoOrpheus').length, hits0, 1e-9, '改为治疗后**不再**打敌人');
  done(h);
});

// ── S2 塔纳托斯的囚锁 ───────────────────────────────────────────────────────────────────────
test('S2：替身攻击至多 3 名敌人（160% 法术，tag makotoThanatos）；恐惧中且生命 < 230% 攻击力 ⇒ 立刻倒下', () => {
  const { h, u } = arena({
    skillId: 'skchr_makoto_2',
    enemies: [{ key: 'enemy_dummy', pos: [10, 4] }, { key: 'enemy_dummy', pos: [11, 4] }, { key: 'enemy_dummy', pos: [9, 4] }, { key: 'enemy_dummy', pos: [10, 5] }, { key: 'enemy_dummy', pos: [10, 2] }],
  });
  u.skill.activate('test', { free: true });
  h.run(1.2);
  assert.ok(u.trait.doll, 'S2 主动切替身');
  h.run(3);
  const main = tagged(h, 'makotoThanatos');
  assert.ok(main.length >= 1, '替身打出塔纳托斯的一击');
  approx(main[0].amount, u.s.atk * 1.6, 0.05, '160% 攻击力');
  assert.equal(main[0].dmg.type, 'arts', '法术伤害');
  assert.ok(main.length <= 3 * 4, `至多 3 名目标（3 秒内 ${main.length} 次命中，含多轮攻击；**递归 bug 会打到上百次**）`);
  // 「范围内**恐惧中**的敌人若生命值低于 230% 攻击力则立刻倒下」——摆好条件再让它打一下
  const victim = h.b.enemies.find((e) => e.alive && e.tileR === 10 && e.tileC === 5);
  assert.ok(victim, '前置：[10,5] 的敌人在场');
  h.b.applyStatus(victim, 'fear', { duration: 5, source: u });
  victim.hp = Math.max(1, u.s.atk * 1.5);        // < 230% 攻击力
  assert.ok(victim.hp < u.s.atk * 2.3, '前置：低于处决线');
  const alive0 = victim.alive;
  assert.ok(alive0, '前置：还活着');
  h.run(3);
  assert.equal(h.b.enemies.find((e) => e.id === victim.id)?.alive ?? false, false, '恐惧中且低于 230% 攻击力 ⇒ 立刻倒下');
  done(h);
});

// ── S3 开辟明日的剑刃 ───────────────────────────────────────────────────────────────────────
// 🔴 第 52 轮 A 按 PRTS 复核**改了这条判据本身**（不是"把断言改到能过"）：
//   官方 S3 备注 —— 进替身**先**是 `<塔纳托斯·改>`（P1，阻挡数仍归 0），**再**点技能键/受致命伤才切
//   `<俄耳甫斯·改>`（P2），**P2 才**「阻挡不再归零（恢复正常的 2 阻挡数）」「不进行普通攻击」。
//   ⇒ 旧版把"阻挡 2"断在 P1 上是**错的**（它把两句官方文本混成了一句）；现在已经按官方分开断言。
//   来源：`协作/C给A-结城理官方口径-PRTS取证-2026-10-07.md` §2-S3 备注；判据见
//   `test/content/reserve-makoto-realpath.test.js` 的"第二替身"用例（真实路径）。
test('S3：替身初始塔纳托斯·改（攻速 +30、阻挡仍为 0）；开技能后改召俄耳甫斯·改（阻挡 2、不普攻）⇒ 范围友方 30% 物法闪避 + 每秒治疗 25%', () => {
  const { h, u } = arena({ skillId: 'skchr_makoto_3', allies: [{ row: 11, col: 3 }, { row: 9, col: 4 }] });
  const aspd0 = u.base.aspd;
  toDoll({ h, u });
  h.run(1.2);
  approx(u.s.aspd, aspd0 + 30, 1e-6, 'P1 攻速 +30');
  assert.equal(u.s.blockCnt, 0, 'P1 <塔纳托斯·改> 的阻挡数**仍然归 0**（官方：<替身>形态阻挡数最终 ×0）');
  assert.equal(u.mem.makotoPersona, 'thanatos', 'S3 初始召唤塔纳托斯·改');
  u.skill.activate('test', { free: true });      // 「塔纳托斯在场时，**开启技能**…改为召唤俄耳甫斯」
  h.run(0.1);
  assert.equal(u.mem.makotoPersona, 'orpheus', '开技能 ⇒ 改召俄耳甫斯·改');
  assert.equal(u.s.blockCnt, 2, 'P2 <俄耳甫斯·改>：阻挡**不再归零**（恢复正常的 2）');
  assert.equal(u.s.flags.disarm, true, 'P2 <俄耳甫斯·改>：**不进行普通攻击**（官方 S3 备注）');
  assert.equal(u.form, 'doll_orpheus', '形态字段换成 P2（客户端据此换模型）');
  const allies = h.b.allyUnits.filter((a) => a.alive && a.id !== u.id);
  assert.ok(allies.length >= 1, '前置：范围里有友方');
  for (const a of allies) a.hp = a.s.maxHp * 0.5;      // 让治疗看得见
  const hp0 = allies.map((a) => a.hp);
  h.run(2.5);
  for (const [i, a] of allies.entries()) {
    assert.ok(a.findBuff(`talent:makotoOrpheusDodge:${u.id}`), '俄耳甫斯给范围友方 30% 物法闪避');
    assert.ok(a.hp > hp0[i], `每秒治疗（${hp0[i]} → ${a.hp}）`);
  }
  done(h);
});

// ── 天赋1 S.E.E.S.队长 ──────────────────────────────────────────────────────────────────────
test('天赋1：<替身>状态结束后发动总攻击 —— 450% 攻击力**真实**伤害（tag makotoAllOut）', () => {
  const { h, u } = arena({});
  toDoll({ h, u });
  h.run(1.2);
  assert.ok(u.trait.doll, '前置：在替身里');
  const before = tagged(h, 'makotoAllOut').length;
  h.b.removeBuff(u, 'trait:substitute');                // 替身结束（等价于 20 秒到点）
  h.run(0.2);
  const out = tagged(h, 'makotoAllOut').slice(before);
  assert.ok(out.length >= 1, '替身结束后应发动总攻击');
  approx(out[0].amount, u.s.atk * 4.5, 0.05, '450% 攻击力');
  assert.equal(out[0].dmg.type, 'true', '真实伤害');
  done(h);
});
