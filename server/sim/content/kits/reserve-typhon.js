// server/sim/content/kits/reserve-typhon.js — **提丰**（char_2012_typhon）的 kit
//
// 外援干员（A-7 第 1 位）。数据来源 = `content-packs/typhon.pack.json`（由
// `.workbuddy/tools/a7-gen-reserve-packs.mjs` 从 `.workbuddy/simpfun-ref/data_chess.json` 投影，
// 投影规则被"用已交付的 4 位反证"验证过：26/26 关键字段逐字相同）。
//
// ── 官方口径（逐条抄自 pack 里的 `desc` / `talents[].desc`，不凭印象）──────────────────────────
//   职业：SNIPER / **siegesniper 攻城手**｜特性：「**优先攻击重量最重的敌人**」
//   天赋1「锐如兽牙」：连续攻击时逐渐无视敌人防御力，**最高 50%**（每次 +10%），**8 秒内未攻击则失去加成**
//   天赋2「重如沼泥」：技能期间对**每个敌人首次造成伤害**时，攻击力提升至 **160%** 并使目标**停顿 3 秒**
//   S1 迅捷打击·γ型（35s）：攻击力 +27%，攻击速度 +25
//   S2 冰原秩序（20s）：攻击力 +26%，每次攻击**发射两支箭矢**（优先攻击不同目标），**40%** 概率晕眩 **1 秒**；
//                        **第二次及以后使用时持续时间无限**
//   S3「永恒狩猎」（AMMO 7 发）：立刻**标记**攻击范围内的一名目标，**攻击间隔大幅增大**，攻击变为对标记目标
//                        **发射一轮箭雨**；箭雨**随机攻击标记目标周围的敌人**，共造成 **4 次**攻击力 **145%** 的物理伤害
//                        并使目标**晕眩 0.4 秒**；打完后结束（可随时停止）
//
// ── 实现落点（三段式，逐条对照）─────────────────────────────────────────────────────────
//   ✅ 特性「重量优先」：**改的是引擎**（不是这个文件）—— `targeting.js` 的 `PRIORITY_FNS.heaviest`
//      ＋ `professions.js` 的 `PRIORITY_ALIASES`；pack 里声明 `targetPriority: 'heaviest'`。
//      ⚠️ 为什么必须改引擎：`build-data.mjs` 的 `resolveTraitFields` **不解析**「优先攻击重量最重的敌人」
//         （它只认"优先攻击空中单位"与"防御力最低"）⇒ 外援只能在 pack 里显式声明，而引擎必须有对应实现。
//   ✅ 天赋1：`onHitBy` 累加层数 → `statBuff` 的 `defIgnorePct`（引擎的"无视防御百分比"，见 `bonds/addon/battle.js:122` 的先例）；
//      8 秒未攻击归零（`onTick` 里按 `battle.time - lastAtkAt`）。
//   ✅ 天赋2：`battle.on('hit')` 里判 `skillBusy(unit)`；用 `Set`（`unit.mem`）保证"**每个敌人**首次"。
//   ✅ S1：`kind:'duration'` + `mods {atkPct, aspd}`（走引擎的 mods，不手搓 buff）。
//   ✅ S2：`mods {atkPct}` ＋ 重写 `attack`：`targeting.maxTargets: 2`（引擎按 `sortEnemyTargets` 排序后取前 N，
//      **两支箭优先不同目标**）+ `onHit` 里 `battle.rng.chance(0.4)` ⇒ `applyStatus stun 1s`。
//      「第二次及以后无限持续」：`unit.mem.typhonUsed2` 记录用过 ⇒ 第二次起 `duration: Infinity`。
//   ✅ S3：`kind:'ammo'`（`ammo` 由 `generic.js` 的 getter 从 `attack@s3_trigger_time` 解析 = 7）
//      ＋ `mods {batPct}`（攻击间隔大幅增大）＋ `onStart` 标记最近的目标并起一片"箭雨区域"。
//      箭雨：`makeZone(interval 0.5s)`，每 tick **随机**取标记点周围的一个敌人，造成 `atk × 1.45` 物理伤害 + 眩晕 0.4s。
//      ⚠️ 官方"共造成 4 次"= **每次触发打 4 下**（`attack@s3_max_hit_num = 4`）⇒ 一个脉冲里循环 4 次，各自独立随机目标。
//
// ── ⚠️ 仍是近似 / 未做（**别当成已实现**）──────────────────────────────────────────────
//   ① 天赋1 的"连续攻击"我按**每次命中**（`onHitBy`，含溅射/多目标各自算一次）计层 —— 官方原文是"连续攻击时"，
//      是否按"攻击动作"计一次**无表可查** [ASSUMED]。层数上限取 `max_stack_cnt = 5`、每层 `def_penetrate = 0.1`（= 50% 封顶）。
//   ② S2 的"优先攻击**不同**目标"我是靠引擎的 `maxTargets: 2` 排序取前二实现的 —— 单目标时就打同一个（符合官方，
//      它只写"优先"）。未额外验证"两个候选时的挑选顺序"是否与官方逐步一致。
//   ③ S3 的"标记"我只做了**最近的目标**（`priority: 'nearest'`）；官方写"一名目标"未指明优先规则 [ASSUMED]。
//   ④ S3 的箭雨**半径**官方未给数，我用 **1.5 格**（`RING1` 同族）[ASSUMED]；"随机"用 `battle.rng.pick`（确定性）。
//   ⑤ S3 未做"可随时主动停止技能"之外的手动停技 UI 交互（引擎的 `toggle`/手动停由既有机制承担）。
//
// 判据（先红后绿，见 `test/content/reserve-typhon.test.js`）：
//   特性重量优先 / 天赋1 叠到 50% 且 8 秒归零 / 天赋2 每敌首次 160% + 停顿 3s / S1 数值 / S2 双击+概率晕+二次无限 / S3 弹药 7 + 箭雨 4 下
import { num, talentBb, skillBbOf, statBuff, once, onHitBy, skillBusy, batMod, RING1 } from './tier1.js';

/** 天赋1「锐如兽牙」：连续攻击逐渐无视防御，上限 50%，8 秒未攻击归零。 */
function installFangs(battle, unit, t0) {
  const per = num(t0.def_penetrate, 0.1);
  const max = Math.max(1, Math.floor(num(t0.max_stack_cnt, 5)));
  const idle = num(t0.duration, 8);
  const add = () => {
    const n = Math.min(max, num(unit.mem.typhonFang, 0) + 1);
    unit.mem.typhonFang = n;
    unit.mem.typhonFangAt = battle.time;
    statBuff(battle, unit, 'talent:typhon_fang', { defIgnorePct: per * n });
  };
  onHitBy(battle, unit, (ctx) => {
    // `cancel` 的伤害不算（被盾吃掉/被打断的那一下不该叠层）
    if (ctx.dmg && ctx.dmg.cancel) return;
    add();
  });
  // 8 秒内未攻击 ⇒ 失去加成。用 `onTick` 而不是 `every`：redeploy 后 `install` 不会再跑，
  // 而 `onTick` 挂在 battle 上、由 `owner` 随单位生死启停（与 wang/其他人一致）。
  once(battle, `talent:typhon_fang_reset:${unit.id}`, () => {
    battle.on('tick', () => {
      if (!unit.alive || !unit.deployed) return;
      const n = num(unit.mem.typhonFang, 0);
      if (!n) return;
      const at = unit.mem.typhonFangAt;
      if (Number.isFinite(at) && battle.time - at <= idle) return;
      unit.mem.typhonFang = 0;
      battle.removeBuff(unit, 'talent:typhon_fang');
    }, { owner: unit });
  });
}

/** 天赋2「重如沼泥」：技能期间对**每个敌人首次**造成伤害时，攻击力 160% 且停顿 3 秒。 */
function installMire(battle, unit, t1) {
  const scale = num(t1.atk_scale, 1.6);
  const slow = num(t1.sluggish, 3);
  battle.on('hit', (ctx) => {
    if (ctx.source !== unit || !ctx.dmg || ctx.dmg.cancel) return;
    const target = ctx.target;
    if (!target || target.side !== 'enemy' || !target.alive) return;
    if (!skillBusy(unit)) return;                       // 只在技能期间
    const seen = unit.mem.typhonMire ?? (unit.mem.typhonMire = new Set());
    if (seen.has(target.id)) return;                     // 每个敌人**首次**
    seen.add(target.id);
    ctx.dmg.mul *= scale;                                // 攻击力提升至 160%
    if (slow > 0) battle.applyStatus(target, 'sluggish', { duration: slow, source: unit });
  }, { owner: unit, priority: -20 });                    // 先于其它 hit 钩子（让 mul 生效在同一实例上）
}

/**
 * S3「永恒狩猎」的**箭雨**：在标记点周围随机取敌人，每次触发打 `maxHit` 下（官方 4 下）。
 * 官方原文：「箭雨会随机攻击**标记目标周围**的敌人，共造成 4 次相当于攻击力 145% 的物理伤害并使目标晕眩 0.4 秒」
 */
function rainOnce(battle, unit, mark, hitN, atkScale, stunSec, radius) {
  // ⚠️ 用 `foesInRadius`（**可选中**语义：跳过不可选中与未破隐的隐匿）—— 箭雨是"技能范围 AOE"，
  //    按 PRTS 作战机制 §AOE伤害判定「对攻击范围内的每个**可以被选中的**敌人进行判定」。
  //    `enemiesInRadius` 是**纯几何**（物理碰撞/敌方光环用的），拿它打伤害会误伤隐匿 [ASSUMED→已避开的坑]。
  const pool = battle.foesInRadius(mark.x, mark.y, radius).filter((e) => e.alive);
  if (!pool.length) return;
  for (let i = 0; i < hitN; i++) {
    const t = battle.rng.pick(pool);
    if (!t || !t.alive) continue;
    battle.dealDamage(unit, t, { amount: unit.s.atk * atkScale, type: 'phys', isSkill: true, tags: ['skill', 'typhonRain'] });
    if (stunSec > 0 && t.alive) battle.applyStatus(t, 'stun', { duration: stunSec, source: unit });
    battle.fx('strike', { x: t.x, y: t.y, id: t.id, src: unit.id });
  }
}

function typhon(bb, chess) {
  const t0 = talentBb(chess, 0), t1 = talentBb(chess, 1);
  const s1 = skillBbOf(chess, 'skcom_quickattack[3]');
  const s2 = skillBbOf(chess, 'skchr_typhon_2');
  const s3 = skillBbOf(chess, 'skchr_typhon_3');
  return {
    skills: {
      // S1 迅捷打击·γ型：纯数值，走 mods
      'skcom_quickattack[3]': {
        kind: 'duration',
        mods: { atkPct: num(s1.atk), aspd: num(s1.attack_speed) },
      },
      // S2 冰原秩序
      skchr_typhon_2: {
        kind: 'duration',
        duration: num(s2.duration, 20),      // ⚠️ 第二次及以后无限：见下面的 onStart 改写
        mods: { atkPct: num(s2.atk) },
        targeting: { maxTargets: 2 },        // 两支箭（引擎排序后取前二 ⇒ 优先不同目标）
        attack: {
          onHit(ctx) {
            const { battle, unit, target } = ctx;
            if (!target || !target.alive) return;
            if (battle.rng.chance(num(s2['attack@prob'], 0.4))) {
              battle.applyStatus(target, 'stun', { duration: num(s2['attack@stun'], 1), source: unit });
            }
          },
        },
        onStart({ unit, skill }) {
          // 官方「**第二次及以后使用时持续时间无限**」。
          // 🔴 教训（第 50 轮 A，我在这里错了两版）：`activate()` 的顺序是
          //    `activations++` →（`skills.js:510`）`timeLeft = Math.max(0.01, duration)` → … →（`:523`）`_call('onStart')`
          //    ⇒ **`onStart` 跑在"时长已被赋值"之后**，所以：
          //      · 写 `skill.duration = Infinity` **对本次无效**（510 早就读过了）；
          //      · 写 `skill.timeLeft = Infinity` 会被 harness 的不变式判为坏
          //        （`battleHarness.js`：`kind==='duration' && !Number.isFinite(timeLeft)` ⇒ bad）。
          //    ✅ 正确做法 = **改 spec + 让引擎重跑它自己的赋值路径**：`duration = Infinity`、`kind = 'toggle'`，
          //       再 `activate()` 一次 —— `skills.js:510` 对 toggle 走的就是 `Infinity` 分支。
          //       这正是本仓库对"无限持续"的既有语义（`timeLeft = Infinity`，tick 不递减）✓
          const used = num(unit.mem.typhonUsed2, 0);
          unit.mem.typhonUsed2 = used + 1;
          if (used >= 1 && skill && skill.kind === 'duration') {
            skill.spec.duration = Infinity;
            skill.kind = 'toggle';
            skill.duration = Infinity;
            skill.activate('secondUse', { free: true });   // 重跑 ⇒ 引擎把 timeLeft 设成 Infinity
          }
        },
      },
      // S3「永恒狩猎」
      skchr_typhon_3: {
        kind: 'ammo',
        ammo: 7,                             // 官方「攻击装有 7 发弹药，打完后结束」
        mods: { batPct: batMod(num(s3.base_attack_time, 3.1), chess) },   // 3.1 s ÷ 本体 bat 2.4 ⇒ ×(1+0.2917)
        onStart({ battle, unit }) {
          // 「立刻标记攻击范围内的一名目标」——优先最近（官方未指明，[ASSUMED]）
          const list = battle.enemiesInKeys
            ? battle.enemiesInKeys(unit.rangeKeys, unit, unit.profile)
            : [];
          const mark = list.length ? list.slice().sort((a, b) => Math.hypot(a.x - unit.x, a.y - unit.y) - Math.hypot(b.x - unit.x, b.y - unit.y))[0] : null;
          if (!mark) return;
          unit.mem.typhonMark = mark.id;
          battle.fx('telegraph', { x: mark.x, y: mark.y, r: RING1, kind: 'typhonMark', id: unit.id });
          // 箭雨：每 0.5 秒一个脉冲，每个脉冲打 maxHit 下（各自随机目标）。只要技能还在就继续。
          const hitN = Math.max(1, Math.floor(num(s3['attack@s3_max_hit_num'], 4)));
          const atkScale = num(s3['attack@s3_atk_scale'], 1.45);
          const stunSec = num(s3['attack@s3_stun'], 0.4);
          battle.every(0.5, (b) => {
            if (!unit.alive || !unit.deployed) return;
            const sk = unit.skill;
            if (!sk || !sk.active || sk.id !== 'skchr_typhon_3') return;
            const t = b.units.find((u) => u.id === unit.mem.typhonMark);
            const at = t && t.alive ? { x: t.x, y: t.y } : (t ? { x: t.x, y: t.y } : null);
            if (!at) return;
            rainOnce(b, unit, at, hitN, atkScale, stunSec, RING1);
          }, { owner: unit });
        },
      },
    },
    talents: [
      { install(battle, unit) { installFangs(battle, unit, t0); } },
      { install(battle, unit) { installMire(battle, unit, t1); } },
    ],
  };
}

export const TYPHON_SKILL_IDS = ['skcom_quickattack[3]', 'skchr_typhon_2', 'skchr_typhon_3'];

// ⚠️ **导出的形态必须与另三个 `reserve-*.js` 一致**：**对象、键 = `chess_<slug>_a`**，值是工厂函数。
//    本仓库 **133 个 `KITS` 键全部带 `_a`**（实测）⇒ 键必须写 `_a`。
//    我第一版把工厂**直接 `export default`** ⇒ `reserve.js` 里 `...typhon` 展开一个**函数** ⇒
//    **一个键都加不上，而且不报错**（`Object.keys(reserveKits)` 仍然只有 3 个）—— 这种"静默无效"最危险。
export default {
  chess_typhon_a: typhon,
};
