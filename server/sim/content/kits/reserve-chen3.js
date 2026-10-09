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
// ⚠️ 这个文件是从三位外援的共用文件 `reserve.js` 拆出来的，所以头部曾**原样继承**过一份
//    「陈 + 星熊的已知近似」清单（①～⑥）。那些条目**多数已经真正实现**（陈 S3 的龙、星熊 S2 的真投盾、
//    星熊 S3 的真·伤害转移、星熊天赋1 的负生命值），留着会误导 —— 已于第 17 轮删除。
//    **本文件（陈）现在的近似见下方 `reserve-chen3.js 自己的近似` 那段。**
//
// ── reserve-chen3.js 自己的近似（逐条标注，别当成完整实现）─────────────────────────────
//  ① 陈 S1「攻击使目标敌人特殊能力失效」：引擎没有独立语义 → 用 `silence` 近似。
//  ② 陈天赋1「攻击变为弱点伤害」：**已按用户 10-05 澄清的真实含义实现**
//     （不是独立伤害类型，而是「按目标 DEF/RES 现算物理/法术、取更高的那边」，见 `weakTypeOf`）。
//  ③ 陈 S3「可转向的剑气（龙）」：**已实现**（真实体、1.5 格/秒、每段每敌只判一次、
//     撞墙顺时针 90°、红光）。剩余近似只有「走格心折线而非连续曲线」，见文件内该节注释。
// ─────────────────────────────────────────────────────────────────────────────────────

// 这些辅助函数由 tier1.js 统一导出（tier6.js 自己另定义了一个局部 num，所以它没 import）
import { num, talentBb, skillBbOf, statBuff, once } from './tier1.js';
import { absoluteRangeKeys, canTargetEnemy } from '../../targeting.js';
// `mitigate` = 引擎的**纯减伤公式**（不结算）。龙的「弱点伤害」用它预判物理/法术哪边更高。
import { mitigate } from '../../damage.js';
// absoluteRangeKeys 返回的是**数字键** `r * COLS + c`（贝洛内 kit 里就是 `allowed.has(u.tileR * COLS + u.tileC)`），
// 所以这里要把 COLS 拿来做换算。
import { COLS, ROWS } from '../../constants.js';
// 方向工具（`server/sim/dir.js`，纯 ESM、双端共用）：龙的朝向与转向用它，别自己写三角函数。
import { dirVec, dirFromDelta } from '../../dir.js';
// ═══════════════════════════════════════════════════════════════════════════════════
// 赤刃明霄陈（char_1050_chen3，近卫·术战者）
//
// ⚠️ 这个文件**归 会话 B**（见 `协作/README.md` 的文件归属表）。另一个会话不要改它。
//    它由 `reserve.js` 合并后经 `tier3.js` / `tier6.js` 注册；`reserve.js` 只读。
// ═══════════════════════════════════════════════════════════════════════════════════

/** 技能范围（rangeGrid）内的敌人 —— 与贝洛内 kit 用的是同一套 absoluteRangeKeys + enemiesInKeys。
 *  `profile` 可覆盖：剑气/龙要 `AIR_OK`（可对空），普攻那一半走默认（`groundOnly` 只打地面）。 */
const foesInSkillRange = (battle, unit, grid, profile) => {
  if (!grid || !grid.length) return battle.blockedTargets ? battle.blockedTargets(unit, unit.profile) : [];
  const keys = absoluteRangeKeys(grid, unit.tileR, unit.tileC, unit.dir, 0);
  return battle.enemiesInKeys(keys, unit, profile || unit.profile) || [];
};

/** 剑气/龙可对空（官方 S3 前半：一道可转向的剑气；用户 15 轮：「3技能可对空」）。 */
const AIR_OK = Object.freeze({ canHitFly: true, groundOnly: false });

/**
 * 「**目标周围**最近的敌人」—— S2 的【转移】用。
 *
 * ⚠️ 官方 S2 原文有两处不同的「最近」，**中心不一样**，别混：
 *   ·「对**周围**最近的 1 名敌人发动 10 次斩击」→ 这个「周围」= 她自己的 **S2 技能范围**（`x-1`，13 格菱形）；
 *   ·「敌人被击倒时**转移至目标周围**最近的其他敌人」→ 这个「周围」**以目标为中心**，不是以她为中心。
 *     两者不是一回事：技能范围是绕她算的，所以「紧挨着目标、却离她很远的敌人」并不在技能范围内。
 *
 * 实现：以**目标所在格**为中心，取「自身格 + 四邻」（引擎的 `GridPosition.GRID_FOUR_WAYS` 语义，也就是
 * 方舟里「周围四格」的常规口径），在其中取最近的、可命中的敌人；四邻都没有时**回退**到她自己的技能范围
 * 里取最近（避免「看着该转移却没转移」）。排序用「曼哈顿距离 → 行 → 列」，保证确定性。
 *
 * @param {object} chess 干员记录（用来取 S2 的 rangeGrid 做回退）
 */
const nearestAroundTarget = (battle, unit, centre, chess) => {
  if (!centre || !centre.alive) return null;
  const cr = centre.tileR, cc = centre.tileC;
  // 只用**真正可命中**的敌人（`canTargetEnemy` 会排除隐匿/不可选中/睡眠/飞行 —— 官方 S2 斩击只打地面）
  const all = (battle.enemies || []).filter((e) => e && e.alive && e !== centre && canTargetEnemy(unit, e, unit.profile));
  if (!all.length) return null;
  const dist = (e) => Math.abs(e.tileR - cr) + Math.abs(e.tileC - cc);
  all.sort((a, b) => dist(a) - dist(b) || a.tileR - b.tileR || a.tileC - b.tileC);

  const NEAR = [[1, 0], [0, 1], [-1, 0], [0, -1]];   // 自身格之外的四邻
  for (const e of all) if (e.tileR === cr && e.tileC === cc) return e;      // 同格优先
  for (const [dr, dc] of NEAR) {
    const hit = all.find((e) => e.tileR === cr + dr && e.tileC === cc + dc);
    if (hit) return hit;
  }
  // 回退：以**目标**为中心套用 S2 的菱形范围（`x-1`，13 格），取其中最近的
  const grid = skillGridOf(chess, 'skchr_chen3_2');
  if (!grid || !grid.length) return null;
  const keys = absoluteRangeKeys(grid, cr, cc, unit.dir, 0);
  return all.find((e) => keys.includes(e.tileR * COLS + e.tileC)) ?? null;
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

// ── 陈 S3「赤霄·天喟」的**龙** ────────────────────────────────────────────────────────────
// 官方描述（`data/chess.json` 的 `skchr_chen3_3` desc）：
//   「技能开启时向前释放一道**可转向的剑气**，对穿过的敌人造成相当于其当前生命值 6% 的法术伤害
//     （至少造成自身攻击力 530% 的法术伤害）；攻击范围扩大，每次攻击对最多 3 名地面敌人造成 3 次
//     攻击力 165% 的法术伤害」
// ⇒ 「可转向的剑气」就是用户说的**龙**（同一条机制，两处叫法）。
//
// 数值（用户 15 轮原文 + 技能黑板，已核实）：
//   碰撞半径 1.3 · 移动速度 1.5（格/秒）· **每次转向前对每个敌人仅判定一次**伤害 ·
//   距「侵入点（S 起点）/ 保护目标（E 终点）/ 高度类型为高地的地块（h、a、A、# 、X）」< 0.25 时
//   **顺时针旋转 90°**；逼仄的单格空间里，每次拐弯都会造成一次「百分比 + 弱点」伤害。
//
// ⚠️ 仍有的近似（本引擎没有原作那条连续曲线）：
//   ① 龙走**格心到格心**的直角折线（原作是连续转向的曲线），所以「碰撞半径 1.3」用来判定
//      「这个格子里的敌人是否被碰到」，而不是做圆-矩形相交；
//   ② 「弱点伤害」：**已按用户 10-05 澄清的真实含义实现**（见 `weakTypeOf`）——
//      不是独立伤害类型，而是「按目标 DEF/RES 现算物理/法术、取打出更高的那边」；
//   ③ 「距离不低于 0.25 才转」在原作里是**几何距离**；本引擎没有「到最近障碍物的距离」这个量，
//      所以实现为「**按当前朝向的下一格不可走**（出界 / 隔墙 / 高地 / 侵入点 / 保护目标）就顺时针转 90°」——
//      这是同一条意图的可判定形式：从格心到格心的路径上，不可走的下一格正是原作的「侵入点/高地」。
//      因此它**必然**在逼仄的单格空间里连续拐弯，也就会有拐弯伤害（用户描述的那种表现）。
//   ④ 剑气在**技能开启瞬间**照旧对技能范围内的敌人各结算一次（原作的开技能那一下）。
const DRAGON_SPEED = 1.5;        // 格/秒（用户原文）
const DRAGON_RADIUS = 1.3;       // 碰撞半径（用户原文）—— 用于「这一格里的敌人是否被碰到」
const DRAGON_MAX_LEN = 24;       // 安全阀：一次技能最多走这么多格，避免病态循环

/** 每格的地形信息；越界返回 null。 */
const tileOf = (battle, r, c) => {
  const g = battle && battle.grid;
  if (!g || typeof g.inBounds !== 'function') return null;
  if (!g.inBounds(r, c)) return null;
  return typeof g.tile === 'function' ? g.tile(r, c) : null;
};

/**
 * 龙的下一格能不能走。
 *
 * 「不能走」= 出界，或该格是**高地**（`height === 'HIGH'`，即隔墙 / 高台）或**侵入点 / 保护目标**
 * （`special` 是 `start` / `end`，对应地图上的 S / E）。地面单位也走不了 `pass !== 'ALL'` 的格。
 */
const dragonCanEnter = (battle, r, c) => {
  if (r < 0 || c < 0 || r >= ROWS || c >= COLS) return false;
  const t = tileOf(battle, r, c);
  if (!t) return false;
  if (t.height === 'HIGH') return false;
  if (t.special === 'start' || t.special === 'end') return false;
  if (t.pass !== 'ALL' && t.pass !== 'GROUND' && t.pass !== 'WALK') return false;
  return true;
};

/** 顺时针 90°（`dir.js` 的 DIRS = [UP, RIGHT, DOWN, LEFT]，索引 +1 在屏幕坐标里就是顺时针）。 */
const CLOCKWISE = { UP: 'RIGHT', RIGHT: 'DOWN', DOWN: 'LEFT', LEFT: 'UP' };
const clockwise = (d) => CLOCKWISE[d] || 'RIGHT';

/** 建立龙的初始状态 —— 从陈所在格出发，朝她当时的面朝方向。 */
function spawnDragon(battle, unit, s3) {
  return {
    r: unit.tileR,
    c: unit.tileC,
    dir: unit.dir || 'RIGHT',
    acc: 0,
    len: 0,
    hits: new Set(),                                   // 本「转向段」内已判定过的敌人（原作：每次转向前只判一次）
    turns: 0,
    hpRatio: num(s3.hp_ratio, 0.06),
    floorScale: num(s3.projectile_min_atk_scale, 5.3),
    // ── 体节（用户 2026-10-06 给的**权威形态**）────────────────────────────────────────
    //   「龙**分为 3 段**，由**头领导**身体其他开始前进，**从陈身上发出**，
    //     **初始为挤在一起的 1 格**，**前进中展开为 3 格**。转弯时**也是由头先转弯**。
    //     身体**每一段落碰到敌人都算造成伤害**」
    //   ⇒ 记一条**走过的格子轨迹** `trail`（index 0 = 头，1 = 刚走过的格…），3 段取 `trail[0..2]`。
    //     刚发出时 trail 只有 1 格 ⇒ 3 段**挤在一起**（= 用户说的"初始为 1 格"）；
    //     前进后 trail 变长 ⇒ **自动展开为 3 格**。头先动、身体跟上、转弯也由头先转，全部自然成立。
    trail: [[unit.tileR, unit.tileC]],
  };
}

/** 龙的第 `i` 段所在格（0 = 头）。轨迹还不够长时**回落到尾巴那格** ⇒ 初始 3 段挤在一起。 */
function dragonSeg(d, i) {
  const t = d.trail;
  if (!t.length) return [d.r, d.c];
  return t[Math.min(i, t.length - 1)];
}

/**
 * 把 `e` 记进龙的「已判过」集合 —— **按段去重**。
 *
 * 用户 2026-10-06 给的权威口径：「身体**每一段落碰到敌人都算造成伤害**」。
 * ⇒ 一个敌人可以被**不同的段**各打一次（所以键里带段号 `i`），
 *   但**同一个段对同一个敌人只判一次**（否则同一 tick 的 while 循环里会重复结算）。
 *
 * 键的形态：\`\${i}:\${e.id ?? e.uid}\` —— 段号 + 敌人标识。
 * ⚠️ 原先只按 `e.id` 去重，等于"整个技能期内一个敌人只挨一次"，
 *    与「每段都算」冲突，已改。
 */
function dragonHitKey(i, e) {
  return `${i}:${e && (e.id ?? e.uid ?? '?')}`;
}

/** 结算龙的一次「穿过」：百分比 + 弱点（近似②：弱点用法术伤害表示）。 */
/**
 * 「弱点伤害」该走哪一边 —— **按目标的抗性现算物理/法术、取打出伤害更高的那边**。
 *
 * 用户 10-05 澄清的**真实含义**（取代原来「我本作没有这个伤害类型 → 用法术伤害表示」的近似）：
 *   「敌人的抗性中，物理端和法术端，哪边造成的伤害更高，就选择哪一边」。
 * ⇒ 它**不是**一个独立的伤害类型，而是**同一次攻击在两种减伤下比较**。
 *
 * 用引擎自己的 `mitigate()` 预判（纯公式、不结算，与真实伤害管线**同一份实现**），
 * 所以物理端的 DEF 减免与法术端的 RES 减免口径完全一致，不会各写一套。
 * @returns {'phys'|'arts'} 打出更多伤害的那一边
 */
function weakTypeOf(amount, targetStats) {
  return mitigate(amount, 'phys', targetStats) > mitigate(amount, 'arts', targetStats) ? 'phys' : 'arts';
}

function dragonDamage(battle, unit, dragon, e, seg = 0) {
  if (!e || !e.alive || e.side === unit.side) return false;
  // ⚠️ 按**段**去重（不再是"整个技能期只挨一次"）—— 用户口径：每一段碰到都算伤害
  const key = dragonHitKey(seg, e);
  if (dragon.hits.has(key)) return false;
  dragon.hits.add(key);
  const amount = Math.max(num(e.hp, 0) * dragon.hpRatio, unit.s.atk * dragon.floorScale);
  // 弱点：同一次伤害在物理/法术两端各算一遍，取更高的那边（见 weakTypeOf）。
  const type = weakTypeOf(amount, e.s);
  battle.dealDamage(unit, e, { amount, type, isSkill: true, tags: ['skill', 'chen3_dragon'] });
  // `weak` 让客户端/日志能看出这一下走的是哪一边（不影响结算）
  battle.fx('slash', { x: e.x, y: e.y, id: e.id, src: unit.id, skill: 'chen3Dragon', weak: type });
  return true;
}

/** 推进龙；返回 false 表示它该消失了。 */
function stepDragon(battle, unit, d, dt) {
  const [dr, dc] = dirVec(d.dir);
  const nr = d.r + dr, nc = d.c + dc;
  if (d.len >= DRAGON_MAX_LEN) return false;
  if (!dragonCanEnter(battle, nr, nc)) {
    // 前方是墙 / 高地 / 侵入点 / 保护目标 → **顺时针 90°**，并**结算一次拐弯伤害**
    // （「在逼仄的单格空间，释放的龙会在每次拐弯时造成一次百分比伤害+弱点伤害」）
    d.dir = clockwise(d.dir);
    d.hits = new Set();                                // 新的一段：每个敌人可以再被判一次
    d.turns += 1;
    // 剑气/龙**可对空** → 用 AIR_OK，否则飞行单位会被 profile 的 groundOnly 挡掉
    const here = battle.enemiesInKeys([d.r * COLS + d.c], unit, AIR_OK) || [];
    for (const e of here) dragonDamage(battle, unit, d, e, 0);   // 拐弯算**头**那一段的判定
    battle.fx('slash', { x: d.c, y: d.r, id: unit.id, src: unit.id, skill: 'chen3DragonTurn' });
    if (d.turns > 8) return false;                     // 一直转不出去（被封死）→ 收
    return true;
  }
  // 前进
  d.acc += DRAGON_SPEED * dt;
  while (d.acc >= 1) {
    d.acc -= 1;
    d.r += dr; d.c += dc;
    d.len += 1;
    // 轨迹：**头插到最前**，身体各段随之顺移 ⇒ 头先动、身体跟上，转弯也由头先转（用户口径）
    d.trail.unshift([d.r, d.c]);
    if (d.trail.length > 8) d.trail.length = 8;        // 只留够 3 段用的尾巴
    // ── 伤害：**每一段各自判定** ──────────────────────────────────────────────────────
    // 用户 2026-10-06：「身体**每一段落碰到敌人都算造成伤害**」。
    // ⇒ 3 段各查自己那一格（头再按朝向多看一格，保留原来的"碰撞半径 1.3"前瞻），
    //   并用 `dragonDamage(..., i)` 按**段**去重（同一段对同一敌人只判一次）。
    const DRAGON_SEGS = 3;
    const [ar, ac] = dirVec(d.dir);
    const aheadOk = (() => {
      const ahead = tileOf(battle, d.r + ar, d.c + ac);
      return ahead && dragonCanEnter(battle, d.r + ar, d.c + ac);
    })();
    for (let i = 0; i < DRAGON_SEGS; i++) {
      const [sr, sc] = dragonSeg(d, i);
      const keys = [sr * COLS + sc];
      if (i === 0 && aheadOk) keys.push((d.r + ar) * COLS + (d.c + ac));   // 只有头保留前瞻
      const foes = battle.enemiesInKeys(keys, unit, AIR_OK) || [];
      for (const e of foes) dragonDamage(battle, unit, d, e, i);
    }
    // ── 视觉：**段链**，不再从陈身上画 ──────────────────────────────────────────────
    // 用户报的"红光依然连接在陈身上"的根因就是这里原来那句
    //   `fx('beam', { x: unit.x, y: unit.y, tx: d.c, ty: d.r })` —— **每条光都从陈出发**。
    // 现在改成：3 段沿轨迹排布，**每段在自己那一格**发一个斩击闪光，
    // 并在**相邻两段之间**连一条光 ⇒ 画面上是一条"最长 3 格的龙形"，与陈脱钩。
    for (let i = 0; i < DRAGON_SEGS; i++) {
      const [sr, sc] = dragonSeg(d, i);
      battle.fx('slash', { x: sc, y: sr, id: unit.id, src: unit.id, skill: i === 0 ? 'chen3Dragon' : 'chen3DragonBody' });
      if (i > 0) {
        const [pr, pc] = dragonSeg(d, i - 1);
        if (pr !== sr || pc !== sc) {
          battle.fx('beam', { x: pc, y: pr, tx: sc, ty: sr, id: unit.id, skill: 'chen3DragonBody' });
        }
      }
    }
    // 「从陈身上发出」只在**刚出发、还没展开**时补一条尾迹（之后就与陈无关了）
    if (d.trail.length <= 2) {
      battle.fx('beam', { x: unit.x, y: unit.y, tx: unit.tileC, ty: unit.tileR, id: unit.id, skill: 'chen3DragonSpawn' });
    }
    if (d.len >= DRAGON_MAX_LEN) return false;
  }
  return true;
}

// 陈
const chen3 = (bb, chess, def) => {
  const t0 = talentBb(chess, 0), t1 = talentBb(chess, 1);
  const s1 = skillBbOf(chess, 'skchr_chen3_1');
  const s2 = skillBbOf(chess, 'skchr_chen3_2');
  const s3 = skillBbOf(chess, 'skchr_chen3_3');
  const tAtk = num(t0.atk, 0.13), tAspd = num(t0.attack_speed, 13);
  const healMin = num(t1.heal_atk_scale_min, 30) / 100;
  const healMax = num(t1.heal_atk_scale_max, 161) / 100;
  const healEvery = num(t1.stack_time, 7);
  const s2Hits = 10;
  const s2Slash = num(s2.atk_scale, 3.9);
  const s2AfterAtk = num(s2['chen3_s2[respawn_buff].atk'], 2.3);
  const s2Dodge = num(s2['chen3_s2[respawn_buff].prob'], 0.4);
  return {
    // ⚠️ 默认技能（S1）放顶层 `skill`，`skills` 里**只放非默认技能** —— 这是 kit 契约，
    //    测试 kits_alt_t3.test.js 断言 `Object.keys(kit.skills)` 恰好等于该干员的非默认技能集合。
    // 赤霄·奔夜：攻击力 +65%，攻击变为二连击，攻击使目标特殊能力失效至技能结束
    skill: {
      kind: 'duration', duration: num(s1.duration, 18),
      mods: { atkPct: num(s1.atk, 0.65) },
      attack: {
        hits: 2,
        // 近似②
        onHit({ battle, unit, target }) {
          if (target && target.alive) battle.applyStatus(target, 'silence', { duration: num(s1.duration, 18), source: unit });
        },
      },
    },
    skills: {
      // 赤霄·绝影-驰：10 次斩击（击杀转移、剩余次数 +1）→ 位移到目标格 → 攻击力 +230%、40% 闪避
      skchr_chen3_2: {
        kind: 'duration', duration: num(s2.duration, 6),
        attack: { atkScale: s2Slash },
        onStart({ battle, unit }) {
          const grid = skillGridOf(chess, 'skchr_chen3_2');
          const home = { r: unit.tileR, c: unit.tileC };
          unit.mem.chen3Home = home;
          // 首击：「对**周围**最近的 1 名敌人」—— 这个「周围」是她自己的 S2 技能范围（以她为中心）
          const firstTarget = () => foesInSkillRange(battle, unit, grid)[0] || null;
          let target = firstTarget();
          let slashes = s2Hits;
          for (let i = 0; i < slashes && target; i++) {
            battle.dealDamage(unit, target, { amount: unit.s.atk * s2Slash, type: 'arts', isSkill: true, tags: ['skill'] });
            if (target.alive) continue;
            slashes++;                       // 官方「敌人被击倒时…使剩余攻击次数 +1」
            // 官方「转移至**目标周围**最近的其他敌人」→ 以**目标**为中心，不是以她为中心
            target = nearestAroundTarget(battle, unit, target, chess);
          }
          // 官方「若目标未被击倒且其位置可部署则移动至该位置，否则返回原位置」
          const dest = target && target.alive ? { r: target.tileR, c: target.tileC } : home;
          if (dest && Number.isInteger(dest.r) && battle.moveRedeploy(unit, dest.r, dest.c, { clearSp: false })) {
            battle.fx('teleport', { x: unit.x, y: unit.y, id: unit.id });
          }
        },
        onEnd({ battle, unit }) {
          const home = unit.mem.chen3Home;
          unit.mem.chen3Home = null;
          if (home && unit.alive && unit.deployed) battle.moveRedeploy(unit, home.r, home.c, { clearSp: false });
          // 官方「接下来攻击力 +230%，获得 40% 物理和法术闪避」——技能结束后仍生效，按 6 秒近似
          battle.addBuff(unit, {
            key: 'chen3:s2_after', duration: num(s2.duration, 6), tags: ['skill'], allowDead: true,
            mods: { atkPct: s2AfterAtk, dodgePhys: s2Dodge, dodgeArts: s2Dodge },
          });
        },
      },
      // 赤霄·天喟：**可转向的龙**（剑气）+ 范围（领主分支 3-12，8 格）+ 每次攻击打最多 3 名地面敌人、各 3 段
      skchr_chen3_3: {
        kind: 'duration', duration: num(s3.duration, 20),
        mods: { atkPct: num(s3['attack@atk_scale'], 1.65) },
        // ⚠️ 这里**故意不写** `targeting.canHitFly` —— 官方 S3 是两半：
        //   ①「可转向的剑气」**可对空**（用户 15 轮原文），
        //   ②「每次攻击对最多 3 名**地面**敌人造成 3 次…」—— 普攻那一半**只打地面**。
        // `canHitFly` 是 profile 级开关（ai.js:241 / targeting.js:84 还看 `groundOnly`），
        // 写在 `targeting` 上会把**普攻也变成可对空**，与 ② 冲突（B3 核对时抓到的）。
        // 所以剑气自己在 onStart / 龙里显式给 `{ canHitFly: true, groundOnly: false }`。
        attack: { hits: 3, dmgType: 'arts' },
        targeting: {
          rangeGrid: skillGridOf(chess, 'skchr_chen3_3'),
          maxTargets: Math.max(1, Math.floor(num(s3['attack@max_target'], 3))),
        },
        onStart({ battle, unit }) {
          // 开技能那一下：对**技能范围内**的敌人各结算一次。
          // 剑气**可对空** → 显式放宽 profile（否则飞行单位会被 `groundOnly` 挡掉）。
          const hpRatio = num(s3.hp_ratio, 0.06);
          const floor = unit.s.atk * num(s3.projectile_min_atk_scale, 5.3);
          const grid = skillGridOf(chess, 'skchr_chen3_3');
          for (const e of foesInSkillRange(battle, unit, grid, AIR_OK)) {
            if (!e || !e.alive) continue;
            battle.dealDamage(unit, e, { amount: Math.max(num(e.hp, 0) * hpRatio, floor), type: 'arts', isSkill: true, tags: ['skill', 'chen3_dragon'] });
          }
          // 然后释放**龙**：按自己的 tick 前进、遇阻顺时针 90°、每次转向前对每个敌人只判一次
          unit.mem.chen3Dragon = spawnDragon(battle, unit, s3);
          battle.fx('beam', { x: unit.x, y: unit.y, tx: unit.tileC, ty: unit.tileR, id: unit.id, skill: 'chen3DragonSpawn' });
        },
        onTick({ battle, unit }) {
          const d = unit.mem.chen3Dragon;
          if (!d) return;
          if (!stepDragon(battle, unit, d, num(battle.dt, 0.03))) unit.mem.chen3Dragon = null;
        },
        onEnd({ unit }) { unit.mem.chen3Dragon = null; },
      },
    },
    talents: [{
      install(battle, unit) {
        if (tAtk > 0 || tAspd > 0) statBuff(battle, unit, 'talent:chen3_xingyi', { atkPct: tAtk, aspd: tAspd });
        // 天赋2 寒暑觉知：未受伤时每 healEvery 秒随机治疗自身（ATK 的 healMin~healMax）并闪避下次物/法攻击。
        // 「未受伤」用距上次受击时间判定；闪避用一次性高闪避 buff 近似（原作是「闪避下一次攻击」）。
        let sinceHit = 0;
        once(battle, 'talent:chen3_hanshu', () => {
          battle.on('hit', (ctx) => { if (ctx && ctx.target === unit) sinceHit = 0; });
          battle.on('tick', (ctx) => {
            if (!unit.alive || !unit.deployed) return;
            sinceHit += num(ctx && ctx.dt, 0);
            if (sinceHit < healEvery) return;
            sinceHit = 0;
            const r = battle.rng && typeof battle.rng.random === 'function' ? battle.rng.random() : 0.5;
            battle.heal(unit, unit, unit.s.atk * (healMin + (healMax - healMin) * r), { self: true, tags: ['talent'] });
            battle.addBuff(unit, { key: 'chen3:blind', duration: 2, tags: ['talent'], allowDead: true, mods: { dodgePhys: 1, dodgeArts: 1 } });
          });
        });
      },
    }],
  };
};

export default {
  chess_chen3_a: chen3,
};
