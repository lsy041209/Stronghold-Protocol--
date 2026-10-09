// server/sim/content/kits/reserve.js — 外援干员的 kit（10-05 加）
//
// 赤刃明霄陈（char_1050_chen3）与 斩业星熊（char_1044_hsgma2）。
// 数据全部来自 content-packs/{chen3,hsgma2}.pack.json —— 那里逐字段标了官方来源
// （character_table.json + skill_table.json，缓存在 .cache/）。技能数值取 Lv4（普通记录
// skillLevel=4），精锐取 Lv7；这里统一用 `skillBbOf(chess, id)` 取当前选中技能的黑板，
// 所以普通/精锐自动正确。
//
// 为什么单独一个文件：tier6.js 有 3000+ 行，把这个独立出来更好维护；而
// content/index.js 是 `KITS = Object.assign({}, ...TIERS.map(m => m.default))`，
// 也就是**按 baseChessId 合并成一张注册表**，与「放在哪个 tier 文件、干员是几阶」无关 ——
// 所以测试期这两位被临时设成 tier 3 时，这里的 kit 一样能被找到，不需要重复代码。
//
// ── 星熊天赋1「业火 / 我执」= 官方**负生命值**机制（第 17 轮按官方口径重做）────────────────
// 官方文本（pack 内 `desc`，取自 character_table.json）：
//   「生命降至0时进入"我执"：期间不成为其他角色的治疗目标，受到的伤害会继续积累，
//     积累至生命上限的 200%（max_minus_hp_ratio=2）时被击倒，5 秒内未受到伤害时，
//     每秒回复 5% 生命，生命大于 0 时退出"我执"」
// PRTS《斩业星熊》备注（权威语义，已抄进 hsgma2.pack.json 的 `_备注`）：
//   · 负生命值 = 为自身累积**超出常规生命值的伤害**；持有负生命值时进入我执；
//   · 期间**持有禁疗**，一切生命值变动先计入负生命值来抵消/增加负生命值；
//   · **只有负生命值达到上限**（生命上限 × max_minus_hp_ratio）才会被正常击倒；
//   · **负生命值清空**（原文「生命大于 0」）才能退出我执；
//   · 负生命值与真实生命值**无关**，不影响其它效果对生命值/生命比例的检测；
//   · 生命恢复走**「生命回复速度（百分比）」属性**，不受治疗加成与禁疗影响；
//   · **需成功受到伤害**，生命恢复效果才会失效并重新计时。
//
// 实现要点（为什么必须挂在 `fatal` 上）：引擎在 fatal 处理完后会把生命补到 1
// （`damage.js:296`），所以任何「在 hit 里看 hp <= 0」的写法都永远为假 —— 旧版正是这样空转的。
//
// ⚠️ 与客户端/A 的契约（不是近似）：引擎内部 `u.hp` **始终夹在 ≥0**，负数只活在
//    `unit.mem.negHp` / `negHpRatio` 里，由 `snapshot.js:100-111` 转成**负 hp 下发**，
//    客户端 `units.js:1072` 按 `-hp / maxHp` 画「从左往右生长的暗红条」。**不用改引擎。**
// ─────────────────────────────────────────────────────────────────────────────────────
//
// ⚠️ 这个文件是从三位外援的共用文件 `reserve.js` 拆出来的，头部曾**原样继承**过一份
//    「陈 + 星熊的已知近似」清单（①～⑤）。那些条目**现在基本都已真正实现**，留着会误导 ——
//    已于第 17 轮删除。**星熊现在的近似见下方 `reserve-hsgma2.js 自己的近似` 那段。**
//
// ── reserve-hsgma2.js 自己的近似（逐条标注，别当成完整实现）─────────────────────────────
//  ① 星熊 S1「受到攻击时对来源反弹法术伤害」：**已实现**（`hit` 钩子，见 skill.onStart）。
//  ② 星熊 S2「投出盾牌绕自身一圈」：**已按用户 10-05 的官方规格实现**
//     （起点 1.2 格 / 逆时针 365° / 90°/s / 碰撞半径 1.0 / 有可选目标时降速 80% / 转完收回即结束）。
//     轨迹 = **半径恒定的圆**（1.2 格）—— 早先用过「半径随角度增长」的推断，
//     被用户实机否掉（"像有离心力、最后飞出去"），已于 23:1x 改为旋转偏移向量。
//  ③ 星熊 S3「承担范围内友方致命伤害」：**已实现为真·伤害转移**（`fatal` 钩子 + 递归防护）。
//  ④ 星熊天赋1「我执」负生命值：**已实现**（`unit.mem.negHp` / `negHpRatio`，由快照转成负 hp 下发）。
// ─────────────────────────────────────────────────────────────────────────────────────

// 这些辅助函数由 tier1.js 统一导出（tier6.js 自己另定义了一个局部 num，所以它没 import）
import { num, talentBb, skillBbOf, statBuff, once } from './tier1.js';
import { absoluteRangeKeys, canTargetEnemy } from '../../targeting.js';
import { dirVec } from '../../dir.js';
// absoluteRangeKeys 返回的是**数字键** `r * COLS + c`（贝洛内 kit 里就是 `allowed.has(u.tileR * COLS + u.tileC)`），
// 所以这里要把 COLS 拿来做换算。
import { COLS } from '../../constants.js';
// ═══════════════════════════════════════════════════════════════════════════════════
// 斩业星熊（char_1044_hsgma2，重装·驭法铁卫）
//
// ⚠️ 这个文件**归 会话 B**（见 `协作/README.md` 的文件归属表）。另一个会话不要改它。
//    它由 `reserve.js` 合并后经 `tier3.js` / `tier6.js` 注册；`reserve.js` 只读。
// ═══════════════════════════════════════════════════════════════════════════════════

/** 技能范围（rangeGrid）内的敌人 —— 与贝洛内 kit 用的是同一套 absoluteRangeKeys + enemiesInKeys。 */
const foesInSkillRange = (battle, unit, grid) => {
  if (!grid || !grid.length) return battle.blockedTargets ? battle.blockedTargets(unit, unit.profile) : [];
  const keys = absoluteRangeKeys(grid, unit.tileR, unit.tileC, unit.dir, 0);
  return battle.enemiesInKeys(keys, unit, unit.profile) || [];
};

// ── S2「无始无明」的盾牌（用户 10-05 给的精确规格）────────────────────────────────────────
/** 投出的盾牌以**自身前方 1.2 格**为起点。 */
const SHIELD_START_R = 1.2;
/** 角速度 90°/s。 */
const SHIELD_OMEGA = 90;
/** 碰撞半径 1.0 —— 盾牌圆心到这个距离内的**可选目标**。 */
const SHIELD_RADIUS = 1.0;
/** 「碰撞范围内存在可选目标时速度-80%」⇒ 乘 0.2。 */
const SHIELD_SLOW = 0.2;
/**
 * 【**已废弃**，保留只为记录这段推断造成过什么】
 *
 * 我曾用「半径随转过的角度线性增长 1.0 格/圈」实现这个盾牌，理由是
 * 「走完一整圈时盾牌外缘正好扫到 1.2 + 1.0 = 2.2 格」。
 *
 * ⚠️ **那是错的。** 用户实机反馈（2026-10-05 23:0x，经 C 的玩法问题单 ③ 定位）：
 *    「盾的轨迹不是"围绕自身"，而是会越来越远，像是有离心力一样，最后飞出去」
 * 根因就是它：**半径线性增长 = 螺旋外扩 = 离心力**。
 *
 * ⇒ 现在改成**旋转那个偏移向量**（见 `onTick`），半径**恒为** `SHIELD_START_R`，
 *   即用户规格里的「**围绕自身**」。这个常量**不再参与计算**（保留 0 以免误用）。
 */
const SHIELD_GROW = 0;
/**
 * 视觉发射的**角度步进**（度）：盾牌每扫过这么多度，才发一次 `fx('shield')`。
 *
 * 为什么需要它：客户端 `case 'shield'` 每次生成 3–4 个**加色**粒子，
 * 若按 60 fps 每帧发 ⇒ 约 **200 个/s** 叠在同一点，ADD 混合饱和成白团
 * （用户反馈「星熊的盾粒子效果太厚了」）。
 *
 * 18° 的选择：正常 90°/s ⇒ **5 次/s**（够连成轨迹、不糊）；
 * 被绊住时 18°/s ⇒ **1 次/s**（仍看得见，不会因为减速而"消失"）。
 * 即发射频率**自动随角速度缩放**，无需单独判断。
 */
const SHIELD_EMIT_DEG = 18;

/**
 * 盾牌碰撞范围内**可选**的敌人（欧氏距离 ≤ SHIELD_RADIUS）。
 *
 * 用圆的欧氏距离而不是格键：盾牌圆心是**连续坐标**（在格与格之间），格键会把它量化到最近格，
 * 那样「碰撞半径 1.0」就退化成「最近一格」，与规格不符。
 * 「可选」沿用引擎的 `canTargetEnemy`（排除隐匿/不可选中/飞行等，与其它技能同一口径）。
 */
const shieldFoes = (battle, unit, cx, cy) => {
  const out = [];
  for (const e of battle.enemies || []) {
    if (!e || !e.alive) continue;
    const dx = e.x - cx;
    const dy = e.y - cy;
    if (dx * dx + dy * dy > SHIELD_RADIUS * SHIELD_RADIUS) continue;
    if (!canTargetEnemy(unit, e, unit.profile)) continue;
    out.push(e);
  }
  return out;
};

/**
 * 「我执」持有的禁疗（官方 `异常效果|禁疗` = HEAL_FREE：**连自己的治疗也归零**，
 * `damage.js:513`；只有「生命回复速度」属性与显式 `ignoreHealFree` 例外）。
 *
 * 用一个 **不限时**（`duration: Infinity`，见 `buffs.js:139`：`duration == null ? Infinity`，
 * **`0` 不是无限**）的 buff 承载，退出我执时 `removeBuff` 摘掉 —— 而不是自己记一个
 * `mem.xxxUntil` 时间戳，因为 `flags.healFree` 才是引擎与其它 kit（治疗选取、AI 选目标）真正读的字段。
 * `statBuff` 不带 flags，所以这里直接 `addBuff`；`allowDead` 保证它能在生命见底时挂上。
 */
const I_HOLD_HEAL_BLOCK = {
  key: 'hsgma2:ihold_healblock',
  status: 'healFree',
  duration: Infinity,
  tags: ['talent'],
  allowDead: true,
  flags: { noHeal: true, healFree: true },
};

/**
 * 某个技能自己的 rangeGrid。
 *
 * ⚠️ **不能**用 `def.skill.rangeGrid` —— 那个是「当前选中技能」的范围，会随玩家选哪个技能而变；
 * 而 kits_alt_t3.test.js 断言「用默认技能构建出的 kit」与「用该技能构建出的 kit」得到的 spec 完全一致。
 * 所以必须按 skillId 从 chess 记录里取，与当前选中项无关。
 */
const skillGridOf = (chess, skillId) => {
  const rec = (chess.skills || []).find((s) => s.skillId === skillId);
  return (rec && rec.rangeGrid) || null;
};

/** 是不是「我方单位」（S3 二阶段只替**友方干员**承担致命伤害，不替敌人、也不替装置）。 */
const isAllySide = (u) => !!(u && u.side === 'ally' && u.kind !== 'device');

// 星熊
const hsgma2 = (bb, chess, def) => {
  const t0 = talentBb(chess, 0), t1 = talentBb(chess, 1);
  const s1 = skillBbOf(chess, 'skchr_hsgma2_1');
  const s2 = skillBbOf(chess, 'skchr_hsgma2_2');
  const s3 = skillBbOf(chess, 'skchr_hsgma2_3');
  const minusHpRatio = num(t0.max_minus_hp_ratio, 2);
  const iHoldEvery = num(t0['hsgma2_t_1[heal].interval'], 5);
  const iHoldPct = num(t0['hsgma2_t_1[heal].hp_recovery_per_sec_by_max_hp_ratio'], 0.05);
  const berserkMaxHp = num(t1.min_hp_ratio, 0.3);
  const berserkAtk = num(t1.min_atk, 0.35);
  const berserkRes = num(t1.min_magic_resistance, 50);
  return {
    // ⚠️ 默认技能（S1）放顶层 `skill`，`skills` 只放非默认技能（见陈那边的说明）。
    // 恶业苦果：攻击 +40%、防御 +40%，每次受到攻击时对来源造成攻击力 100% 法术伤害（无限持续）
    skill: {
      // 🔴 **官方 `duration: -1` = 无限持续** —— 不能写成 `kind:'duration', duration:-1`：
      //    `skills.js:479` 对 duration 型取 `Math.max(0.01, this.duration)` ⇒ **-1 变成 0.01 秒**，
      //    下一 tick 就 `end('duration')`，而 `onEnd` 把反伤开关 `unit.mem.hsgma2S1` 清成 0
      //    ⇒ **技能不持续、反伤不生效、±40% 也没了**（用户 2026-10-06 06:2x 报的正是这两条）。
      //    引擎自己的口径就是 **`toggle`**：`content/generic.js:84-86`「`duration < 0` 且描述含"无限持续" ⇒ toggle」，
      //    而 `skills.js:479` 给 toggle 的 `timeLeft` 是 **Infinity**、tick 里**不递减** ⇒ 真正不结束（`:285`）。
      //    ⚠️ 这条**只修这一个技能**；"引擎要不要统一支持 duration<0" 属 A 的地盘，我已写进 `已知问题.md` 报备。
      kind: 'toggle',
      mods: { atkPct: num(s1.atk, 0.4), defPct: num(s1.def, 0.4) },
      attack: { dmgType: 'arts' },                    // 特性：技能开启时普攻转法术
      onStart({ battle, unit }) {
        unit.mem.hsgma2S1 = num(s1.atk_scale, 1);
        if (unit.mem.hsgma2Thorns) return;
        unit.mem.hsgma2Thorns = true;
        battle.on('hit', (ctx) => {
          if (!unit.alive || !unit.deployed || !unit.mem.hsgma2S1) return;
          if (!ctx || ctx.target !== unit) return;
          const src = ctx.source;
          if (!src || !src.alive || src.side === unit.side) return;
          battle.dealDamage(unit, src, { amount: unit.s.atk * unit.mem.hsgma2S1, type: 'arts', isSkill: true, tags: ['skill'] });
        });
      },
      onEnd({ unit }) { unit.mem.hsgma2S1 = 0; },
    },
    skills: {
      // 无始无明：**投出盾牌**，盾牌绕自身**逆时针**旋转一整圈；碰到敌人使其停顿并周期造成法术伤害。
      //
      // 官方描述（`data/chess.json` 的 `skchr_hsgma2_2` desc）：
      //   「投出盾牌并以攻击力55%的三连击攻击所有阻挡的敌人，盾牌会环绕斩业星熊飞行一圈；
      //     盾牌碰到敌人时使目标停顿，每0.5秒对其造成攻击力80%的法术伤害，自身回复盾牌造成伤害10%的生命」
      //
      // 用户 10-05 给的**精确规格**（这一版按它实现，取代原来的「对阻挡目标周期伤害」近似）：
      //   「※投出的盾牌以自身前方1.2格为起点，逆时针旋转365°，角速度90°/s，碰撞半径1.0，
      //     碰撞范围内存在可选目标时速度-80%
      //     ※技能持续至盾牌旋转365°并收回时结束」
      //
      // ⚠️ 这条规格把 S2 从「近似」变成了**真机制**：
      //   · 盾牌是一个**有位置、有速度、会被敌人"绊住"**的实体；
      //   · 「速度-80%」= 碰撞半径 1.0 内有可选目标时，角速度降到 20%（所以它会在敌人附近慢下来、多打几下）；
      //   · **技能由盾牌走完一整圈而结束**，不是固定 duration（`bb` 里 `duration: -1` 也印证了这点）。
      skchr_hsgma2_2: {
        // ⚠️ 不能用 `num(s2.duration, -1)`：官方 bb 里 `duration` 是 **-1**（"无固定时长"），
        //    但 `skills.js:74` 把它解析成 `d.duration > 0 ? d.duration : 0` → **0** ⇒ 技能瞬间结束。
        //    所以这里直接给「转完 365° 所需的时间」= 365/90 ≈ 4.056 s，由盾牌走完一整圈自然结束；
        //    若中途需要提前收（例如单位退场），`onTick` 里仍可 `sk.stop()`。
        kind: 'duration', duration: 365 / 90,
        attack: { hits: 3, atkScale: num(s2['attack@atk_scale'], 0.55), dmgType: 'arts' },
        onStart({ battle, unit }) {
          // 起点 = 自身前方 1.2 格。**以「偏移向量」的形式存下来**，之后靠旋转它来绕圈
          // （半径天然恒定 = 真正的「围绕自身」；详见 onTick 与 SHIELD_GROW 的说明）。
          const [dr, dc] = dirVec(unit.dir);      // dirVec 给的是格坐标 (dr, dc)：UP = (-1, 0)
          const ox = dc * SHIELD_START_R;             // 注意：x 对应列、y 对应行
          const oy = dr * SHIELD_START_R;
          unit.mem.hsgma2Shield = {
            ox,
            oy,
            // 从 -90° 起步：这样旋转式解出的位置正好是「前方」（见 onTick）。
            ang: -Math.PI / 2,
            t: 0,                                     // 转过的**整圈比例** 0 → 1（结束条件用它）
            acc: 0,
            interval: num(s2.interval, 0.5),
            scale: num(s2.shield_atk_scale, 0.8),
            heal: num(s2.heal_ratio, 0.1),
            slowCnt: 0,
          };
          battle.fx('shield', { x: unit.x + ox, y: unit.y + oy, id: unit.id, skill: 'hsgma2ShieldSpawn' });
        },
        onTick({ battle, unit, dt }) {
          const sh = unit.mem.hsgma2Shield;
          const sk = unit.skill;
          if (!sh) return;
          const step = num(dt, 0);

          // ── 位置：**旋转那个偏移向量**（半径恒定）──────────────────────────────────────────
          // ⚠️ 这里曾经是错的：用极坐标 `x = u.x - sin(θ)·r`、`y = u.y - cos(θ)·r` 且 **r 随 θ 增长**，
          //    结果盾牌**一圈比一圈远、最后一圈"飞出去"**（用户 2026-10-05 反馈的"离心力"）。
          //    正确做法是旋转「前方 1.2 格」这个**偏移向量**：|offset| 恒定 = 真正的「围绕自身」。
          //    求逆时针（屏幕 y 向下）：在 y 轴取负的坐标系里用标准旋转式
          //      x' = ox·cosθ + oy·sinθ
          //      y' = oy·cosθ − ox·sinθ
          //    代入 ang = -π/2 得 (x', y') = (−oy, ox) = (ox, oy) ⇒ 正好是起点「前方」，可自检。
          const c = Math.cos(sh.ang);
          const s = Math.sin(sh.ang);
          const offX = sh.ox * c + sh.oy * s;
          const offY = sh.oy * c - sh.ox * s;
          const cx = unit.x + offX;
          const cy = unit.y + offY;

          // ── 「碰撞范围内存在可选目标时速度-80%」────────────────────────────────────────
          const foes = shieldFoes(battle, unit, cx, cy);
          sh.slowCnt = foes.length;
          const speed = SHIELD_OMEGA * (foes.length ? SHIELD_SLOW : 1);
          // 角度按弧度推进：90°/s = π/2 rad/s。
          sh.ang += speed * (Math.PI / 180) * step;
          // `t` = 转过的整圈比例（0 → 1）：结束条件只看它，与弧度/角度单位无关。
          sh.t += (speed / 360) * step;
          sh.acc += step;
          // 本次 tick 转过的**角度**（度）—— 视觉发射按它步进，见下。
          const sweptDeg = speed * step;

          // ── 每 0.5 秒结算一次（官方 interval）──────────────────────────────────────────
          if (sh.acc >= sh.interval) {
            sh.acc -= sh.interval;
            let healed = 0;
            for (const e of foes) {
              if (!e || !e.alive) continue;
              const amount = unit.s.atk * sh.scale;
              battle.dealDamage(unit, e, { amount, type: 'arts', isSkill: true, tags: ['skill', 'hsgma2Shield'] });
              // 官方「盾牌碰到敌人时使目标停顿」
              battle.applyStatus(e, 'sluggish', { duration: sh.interval * 2, source: unit });
              healed += amount * sh.heal;
            }
            // 官方「自身回复盾牌造成伤害 10% 的生命」（走 heal 管线，因此受禁疗影响 —— 与 S1/S3 一致）
            if (healed > 0) battle.heal(unit, unit, healed, { self: true, tags: ['skill'] });
          }

          // ── 视觉：盾牌本体 + 一道拖尾（客户端按这两个 fx 画）────────────────────────────
          // ⚠️ 这里原来写的是 `r` —— 旧极坐标时代的变量，改造后**已不存在**。后果很严重：
          //    onTick 每帧抛 `ReferenceError` ⇒ **本体 fx 一帧都发不出去**，而且**后面的
          //    结束判定也永远跑不到**（技能只能靠 duration 兜底结束）。
          //
          // ⚠️⚠️ 但"每帧发一个"**本身就是第二个问题**（用户：「星熊的盾粒子效果太厚了」）：
          //    客户端 `case 'shield'` 每次会生成 3–4 个**加色**粒子，60 fps ⇒ 约 **200 个/s**
          //    同时存活、叠在同一点上，ADD 混合必然**饱和成一团白** —— 看不出盾牌轮廓。
          //    ⇒ 改为**按角度步进**发射：每扫过 `SHIELD_EMIT_DEG` 度才发一次。
          //      这样它**自动随速度自适应**：正常 90°/s ⇒ 5 次/s；被绊住时 18°/s ⇒ 1 次/s，
          //      既不会糊成一团，也不会在减速时"看不见了"。
          sh.emitAcc = (sh.emitAcc || 0) + sweptDeg;
          if (sh.emitAcc >= SHIELD_EMIT_DEG) {
            sh.emitAcc = 0;
            battle.fx('shield', { x: cx, y: cy, id: unit.id, skill: 'hsgma2Shield', r: SHIELD_START_R });
          }
          if (sh.slowCnt) battle.fx('beam', { x: cx, y: cy, tx: unit.x, ty: unit.y, id: unit.id, skill: 'hsgma2ShieldLink' });

          // ── 转完 365° → 收回 → **技能结束**（用户规格的结束条件）────────────────────────
          // ⚠️ 判 `sh.t`（**整圈比例**，0→1）而不是 `sh.ang`：`ang` 现在是**弧度**，
          //    一圈是 2π —— 沿用旧的 `>= 1` 会让技能在**转了约 57°** 时就提前结束。
          if (sh.t >= 1) {
            battle.fx('shield', { x: unit.x, y: unit.y, id: unit.id, skill: 'hsgma2ShieldReturn' });
            if (sk && sk.active) sk.stop();
          }
        },
        onEnd({ unit }) { unit.mem.hsgma2Shield = null; },
      },
      // 地狱变相：范围扩大、生命 +55%、攻击 +150%、二连击打最多 2 名；关闭后 11 秒临死模式（近似⑤）
      skchr_hsgma2_3: {
        kind: 'duration', duration: num(s3.duration, 32),
        mods: { atkPct: num(s3.atk, 1.5), maxHpPct: num(s3.max_hp, 0.55) },
        attack: { hits: 2, dmgType: 'arts' },
        targeting: { rangeGrid: skillGridOf(chess, 'skchr_hsgma2_3'), maxTargets: Math.max(1, Math.floor(num(s3['attack@max_target'], 2))) },
        // ── 主动关闭判定（用户 10-05 要求）──────────────────────────────────────────────────────
        // 原作里「主动关闭技能」是玩家的选择：关掉后进入 11 秒临死模式（见下面 onEnd），
        // 所以**在合适的时机提前关**比让它自然跑完好。用户要求 AI 这样判：
        //   「在自己的技能条快到底、有敌人朝着目标点行动且快要离开自己的攻击范围的情况下，主动关闭技能」
        //
        // 实现：
        //   ·「技能条快到底」= 剩余持续时间 ≤ CLOSE_WHEN_LEFT 秒（kind 是 duration，条就是 timeLeft）
        //   ·「快要离开攻击范围」= 同一个敌人在技能范围内、且**它到自身的距离比上一 tick 变大了**
        //     （没有速度矢量可用，用「距离正在变大」作为「正在离开」的近似）
        //   · 两个条件同时满足 → skill.stop()，于是 onEnd 触发临死模式
        onTick({ battle, unit }) {
          const sk = unit.skill;
          if (!sk || !sk.active || String(sk.id) !== 'skchr_hsgma2_3') return;
          const CLOSE_WHEN_LEFT = 3;
          if (!(num(sk.timeLeft, 0) <= CLOSE_WHEN_LEFT)) return;
          const foes = foesInSkillRange(battle, unit, skillGridOf(chess, 'skchr_hsgma2_3'));
          if (!foes.length) return;
          const prev = unit.mem.hsgma2FoeDist || {};
          const now = {};
          let leaving = false;
          for (const e of foes) {
            if (!e || !e.alive) continue;
            const d = Math.abs(e.tileR - unit.tileR) + Math.abs(e.tileC - unit.tileC);
            now[e.id] = d;
            if (prev[e.id] !== undefined && d > prev[e.id]) leaving = true;
          }
          unit.mem.hsgma2FoeDist = now;
          if (leaving) sk.stop();     // 主动关闭 → onEnd 进入临死模式（二阶段）
        },
        onEnd({ battle, unit }) {
          const dur = num(s3.before_dead_duration, 11);
          unit.mem.hsgma2LastStandAt = num(battle.time, 0);
          // 官方二阶段「攻击变为**四连击**」。引擎支持**运行时改段数**：改 `unit.profile.hits`
          // （既有先例：`tier6.js:1882` 二连击、`:3043` +1）。先存基准，到点再还原。
          if (unit.profile) {
            unit.mem.hsgma2BaseHits = unit.profile.hits;
            unit.profile.hits = 4;
          }
          // 「不会被击倒」+ 11 秒后强制退场。⚠️ 官方「保留技能加成」= 关闭前的 max_hp/atk 加成
          //    要继续生效（S3 的 mods 会随技能结束一起撤掉），所以这里按官方黑板再补一份。
          battle.addBuff(unit, {
            key: 'hsgma2:last_stand', duration: dur, tags: ['skill'], allowDead: true,
            mods: {
              atkPct: num(s3.atk, 1.5), maxHpPct: num(s3.max_hp, 0.55),
              dodgePhys: 1, dodgeArts: 1,
            },
            flags: { undying: true },
          });
          // 11 秒后强制退场（官方：「11 秒后强制退出战场」），并还原普攻段数
          battle.after(dur, () => {
            if (unit.profile && unit.mem.hsgma2BaseHits !== undefined) {
              unit.profile.hits = unit.mem.hsgma2BaseHits;
              unit.mem.hsgma2BaseHits = undefined;
            }
            if (unit.alive && unit.deployed) battle.retreat(unit, { reason: 'retreat' });
          }, { owner: unit });
        },
      },
    },
    talents: [{
      install(battle, unit) {
        // S3 临死模式的起点；用 -Infinity 表示「从没开过」，这样 `battle.time - x <= dur` 稳定为 false
        // （若留 undefined，算术会得到 NaN，而 `NaN <= 11` 是 false —— 碰巧对，但不要依赖巧合）
        if (unit.mem.hsgma2LastStandAt === undefined) unit.mem.hsgma2LastStandAt = Number.NEGATIVE_INFINITY;

        // ── S3 二阶段：**承担攻击范围内我方干员受到的致命伤害**（官方原文）────────────────────
        // 之前这里是「给友军加一层护盾」的近似；B3 核对时发现**引擎本来就做得到**真·伤害转移：
        //   `fatal` 的 `ctx.prevented` 是共享的（damage.js:296：prevented && alive → 生命补到 1），
        //   所以替队友 `prevented = true`，再把**超出部分**用 `battle.loseHp` 转到星熊自己身上即可。
        // ⚠️ 递归防护：`loseHp` 会再发一次 `fatal`（这次 target 是星熊），用 `mem` 上的嵌套标志挡住。
        once(battle, 'talent:hsgma2_laststand', () => {
          battle.on('hit', (ctx) => {
            if (ctx && ctx.target !== unit && isAllySide(ctx.target)) {
              ctx.target.mem.hsgma2PreHp = Math.max(0, num(ctx.target.hp, 0));
            }
          }, { owner: unit });
          battle.on('fatal', (ctx) => {
            if (num(unit.mem.hsgma2Transferring, 0)) return;
            const t = ctx && ctx.unit;
            if (!t || t === unit || ctx.prevented) return;
            if (!isAllySide(t)) return;
            if (!unit.alive || !unit.deployed || !t.deployed) return;
            const dur = num(s3.before_dead_duration, 11);
            if (!(num(battle.time, 0) - num(unit.mem.hsgma2LastStandAt, Number.NEGATIVE_INFINITY) <= dur)) return;
            const grid = skillGridOf(chess, 'skchr_hsgma2_3');
            if (!grid || !grid.length) return;
            const keys = absoluteRangeKeys(grid, unit.tileR, unit.tileC, unit.dir, 0);
            if (!keys || !keys.includes(t.tileR * COLS + t.tileC)) return;      // 只承担她**攻击范围**内的队友
            const preHp = Math.max(0, num(t.mem.hsgma2PreHp, num(t.hp, 0)));
            const overflow = Math.max(0, num(ctx.amount, 0) - preHp);
            ctx.prevented = true;                                               // 队友不死（引擎随后把生命补到 1）
            if (overflow <= 0) return;
            unit.mem.hsgma2Transferring = 1;
            try {
              battle.loseHp(unit, overflow, { source: ctx.source ?? null, from: ctx.dmg ?? null, tags: ['skill', 'hsgma2_transfer'] });
            } finally { unit.mem.hsgma2Transferring = 0; }
          }, { owner: unit });
        });
        // 天赋2 鬼之架势：坚忍 —— 损失生命越多加成越高（线性到 berserkAtk / berserkRes）
        let acc = 0;
        once(battle, 'talent:hsgma2_berserk', () => {
          battle.on('tick', (ctx) => {
            if (!unit.alive || !unit.deployed) return;
            acc += num(ctx && ctx.dt, 0);
            if (acc < 0.25) return;                       // 每 0.25 秒重算，别每 tick 刷 buff
            acc = 0;
            const maxHp = Math.max(1, num(unit.s.maxHp, 1));
            const lost = Math.max(0, 1 - num(unit.hp, maxHp) / maxHp);
            const k = Math.min(1, lost / Math.max(0.0001, 1 - berserkMaxHp));
            statBuff(battle, unit, 'talent:hsgma2_berserk', { atkPct: berserkAtk * k, res: berserkRes * k });
          });
        });
        // 天赋1 业火「我执」—— **负生命值**机制。契约（与 A 的客户端/快照对齐）：
        //   `unit.mem.negHp`      = 累积的负生命绝对值
        //   `unit.mem.negHpRatio` = 占**生命上限**的比例（0..1），`snapshot.js:100-111` 读它，
        //                           `> 0` 时把发给客户端的 hp 写成**负数** → 客户端 `units.js:1072` 画暗红条。
        // ⚠️ 所以**引擎内部 `u.hp` 始终夹在 ≥0**，负数只活在 `mem` 里、由快照转成负 hp 下发 —— 不用改引擎。
        let sinceHit = 0;
        unit.mem.negHp = 0;
        unit.mem.negHpRatio = 0;
        /** 把负生命绝对值同步成快照要的比例（上限 = maxHp × max_minus_hp_ratio）。 */
        const syncNegHp = () => {
          const maxHp = Math.max(1, num(unit.s.maxHp, 1));
          const cap = maxHp * minusHpRatio;                    // 官方 max_minus_hp_ratio：精0=1 / 精2=2
          const hold = Math.max(0, num(unit.mem.negHp, 0));
          // 给客户端的红条比例：占「上限」的比例（攒满 = 1）。注意不是占 maxHp。
          unit.mem.negHpRatio = cap > 0 ? Math.min(1, hold / cap) : 0;
        };
        once(battle, 'talent:hsgma2_ihold', () => {
          // ⚠️ 判据必须挂在 `fatal`（而不是 `hit` 里看 `hp <= 0`）：引擎在 fatal 处理完后会把生命**补到 1**
          //    （`damage.js:296`），所以到 `hit` 时生命已经 ≥1，`hp <= 0` 永远为假 —— 旧版因此在实战里
          //    从不进入我执，负生命也从不累积。
          battle.on('fatal', (ctx) => {
            if (!unit.alive || !unit.deployed) return;
            if (!ctx || ctx.unit !== unit || ctx.prevented) return;
            const maxHp = Math.max(1, num(unit.s.maxHp, 1));
            const cap = maxHp * minusHpRatio;
            // ⚠️ `ctx.amount` 是**这次攻击的减免后全额**，不是「超出部分」：引擎在发 fatal 之前已经把
            //    生命扣到 0 并夹住（`damage.js:288-292`），所以「超出」= 全额 − 挨打前的生命，
            //    而挨打前的生命只能由上一行 `hit`（在扣血之前发）或 tick 开头记下来。
            const preHp = Math.max(0, num(unit.mem.hsgma2PreHp, num(unit.hp, 0)));
            const overflow = Math.max(0, num(ctx.amount, 0) - preHp);
            if (num(unit.mem.negHp, 0) + overflow >= cap) return;   // 攒满 → 不拦，正常被击倒
            unit.mem.negHp = num(unit.mem.negHp, 0) + overflow;
            unit.hp = 0;                                             // 官方：生命降至 0 才进入我执
            // 官方「期间不成为其他角色的治疗目标 / 持有禁疗」：healFree 连自己的治疗也归零
            // （damage.js:513），而下面的回复是**生命回复速度**属性，按官方明文不受禁疗影响，
            // 所以直接改计数、不走 heal 管线。
            battle.addBuff(unit, I_HOLD_HEAL_BLOCK);
            syncNegHp();
            ctx.prevented = true;                                    // 引擎把生命补到 1（快照会发负数盖过它）
          }, { owner: unit });

          // 「5 秒内未受到伤害时，每秒回复 5% 生命」——恢复走**生命回复速度**属性，不受治疗加成与禁疗影响。
          // ⚠️ 顺序：`hit` 在 `fatal` **之前**发出（damage.js:225 → :295），所以同一个 tick 里先记下挨打前的
          //    生命、再重置计时，最后才由 fatal 记账 —— 不会出现「刚挨打就又回血」。
          // ⚠️ 为什么 **tick 开头也要记一次**：`battle.loseHp`（流失）**不发 `hit`**
          //    （它直接走 `applyHpLoss`，见 Battle.js:1535），只靠 hit 记账会在「同一 tick 内先流失、
          //    再挨致命一击」时用过期的生命值去算超出量。tick 开头读到的是**本 tick 尚未结算**的生命。
          battle.on('hit', (ctx) => {
            if (!unit.alive || !unit.deployed) return;
            if (!ctx || ctx.target !== unit) return;
            unit.mem.hsgma2PreHp = Math.max(0, num(unit.hp, 0));     // 扣血之前的生命，给 fatal 算超出量
            sinceHit = 0;
          });
          battle.on('tick', (ctx) => {
            if (!unit.alive || !unit.deployed) return;
            const dt = num(ctx && ctx.dt, 0);
            // 本 tick 尚未结算的生命 —— `loseHp` 不发 hit，只能在这里取基准
            if (num(unit.mem.negHp, 0) <= 0) unit.mem.hsgma2PreHp = Math.max(0, num(unit.hp, 0));
            sinceHit += dt;
            const hold = num(unit.mem.negHp, 0);
            if (hold <= 0) {
              // 负生命值清空（官方原文「生命大于 0」）→ 退出我执，禁疗解除
              if (unit.mem.hsgma2InIHold) {
                unit.mem.hsgma2InIHold = false;
                battle.removeBuff(unit, I_HOLD_HEAL_BLOCK.key);
              }
              unit.mem.negHpRatio = 0;
              return;
            }
            unit.mem.hsgma2InIHold = true;
            if (sinceHit < iHoldEvery) { syncNegHp(); return; }
            // 官方：每秒回复 5% 生命 = 负生命值每秒减少 5% 生命上限
            const maxHp = Math.max(1, num(unit.s.maxHp, 1));
            unit.mem.negHp = Math.max(0, hold - maxHp * iHoldPct * dt);
            syncNegHp();
          });
        });
      },
    }],
  };
};

export default {
  chess_hsgma2_a: hsgma2,
};
