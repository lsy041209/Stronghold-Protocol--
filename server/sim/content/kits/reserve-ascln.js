// server/sim/content/kits/reserve-ascln.js — **阿斯卡纶**（char_4132_ascln）的 kit
//
// 外援干员（A-7 第 2 位）。数据来源 = `content-packs/ascln.pack.json.pending`（由
// `.workbuddy/tools/a7-gen-reserve-packs.mjs` 从 `.workbuddy/simpfun-ref/data_chess.json` 投影）。
//
// ── 官方口径（逐条抄自 pack 的 `trait.desc` / `talents[].desc` / `skills[].desc`）────────────────
//   职业：SPECIAL / **stalker 伏击者**（近战，**阻挡数 0**）
//   特性：「**对攻击范围内所有敌人造成伤害**；拥有 **50% 的物理和法术闪避**且**不容易成为敌人的攻击目标**」
//     ✅ 这三条**引擎早已实现**，**本 kit 不要再写一遍**（否则双重计算）：
//        `professions.js:533` `stalker: P({ allInRange: true, install: installStalker })`
//        ＋ `:590` `stalker: (tb) => ({ dodge: num(tb.prob, 0.5) })`（读的正是特性 bb 的 `prob: 0.5`）
//        ＋ `:308` `installStalker` ⇒ `dodgePhys/dodgeArts/taunt:-1`。同分支的 `chess_char_4_09_a`（水月）在用。
//   天赋1「死亡拘审」：攻击对敌人施加效果 —— **移动速度 −18%**、**每秒受到 10% 阿斯卡纶当前攻击力的法术伤害**、
//        持续 **25 秒**、**最多叠 3 层**
//   天赋2「噬光残影」：攻击速度 **+8**；**自身周围四格有高台时**，攻击速度**额外 +6**
//   S1 追袭（AUTO，**可充能 2 次**）：下次攻击攻击力提升至 **130%**，并**连续攻击两次**
//   S2 恩赐（35 s）：攻击力 **+50%**，使攻击范围内**地面**敌人移动速度 **−30%**，
//        并在**其被击倒时**对**周围敌人施加一层第一天赋效果**
//   S3 降临（45 s）：攻击范围扩大，攻击力 **+20%**，**攻击间隔缩短**（`base_attack_time = −1.2`），
//        使攻击范围内的**地面**敌人**物理与法术命中率 −15%**；**自身更易受到敌人攻击**（`taunt_level = 2`）；
//        **敌人未命中自身或自身闪避时回复 4% 最大生命值**
//
// ── ⚠️ 仍是近似 / 未做（**别当成已实现**）──────────────────────────────────────────────────
//   ① 🔴 **S3 的「命中率 −15%」未实现**：全引擎**没有命中率属性**（实测 `hitrate`/`hitRate`/`damage_hitrate`
//      在 `server/sim/` 下命中数 = **0**）⇒ 这需要**新引擎原语**，不是 kit 层能补的。
//   ② 🔴 **S3 的「敌人未命中自身**或**自身闪避时回复 4% 最大生命值」未实现** —— 它依赖 ①（没有"未命中"概念）。
//      ⚠️ "闪避"本身是**有的**（`dodgePhys/dodgeArts`）⇒ 只做"闪避时回血"可行，但官方把两项并列，
//      只做一半会让玩家觉得"回血比官方少" ⇒ **留给用户/下一轮定**（已在 `进度-A.md` 记账）。
//   ③ 天赋1 的 DOT 取"**当前**攻击力"：每次跳伤害时读活值 `unit.s.atk`；官方是否在**施加瞬间**快照**无表可查** [ASSUMED]。
//   ④ S2 的「周围敌人」用 **1.5 格**（`RING1`）[ASSUMED]：官方只写"周围敌人"、未给半径。
//   ⑤ S1 的 `hits: 2` 是"连续攻击两次"的最近似表达（引擎的 `hits` 是同一目标的多段）——
//      官方原文"并连续攻击两次"未指明是否可换目标 [ASSUMED]。
//
// 判据：`test/content/reserve-ascln.test.js`（先红后绿）
import { num, talentBb, skillBbOf, statBuff, once, onHitBy, instantKind, batMod, RING1 } from './tier1.js';

const DETENTION = 'talent:ascln_detention';

/** 天赋1「死亡拘审」的一层。S2 的"击倒时补一层"也调它 ⇒ **单一实现**。 */
function addDetention(battle, unit, target, t0) {
  if (!target || !target.alive || target.side !== 'enemy') return null;
  return battle.addBuff(target, {
    key: DETENTION,
    duration: num(t0.debuff_duration, 25),
    refresh: 'stack', stacks: 1, maxStacks: Math.max(1, Math.floor(num(t0.max_stack_cnt, 3))), source: unit,
    mods: { movePct: num(t0.move_speed, -0.18) }, tags: ['dot', 'talent'],
  });
}

/** 天赋1：攻击施加"移动速度 −18% ＋ 每秒 10% 当前攻击力法术伤害"（最多 3 层 / 25 秒）。 */
function installDetention(battle, unit, t0) {
  const ratio = num(t0.atk_ratio, 0.1);
  const every = Math.max(0.05, num(t0.interval, 1));
  onHitBy(battle, unit, (ctx) => {
    if (ctx.dmg && ctx.dmg.cancel) return;
    addDetention(battle, unit, ctx.target, t0);
  });
  // DOT：每秒一跳，伤害 = `unit.s.atk × ratio × 层数`（官方"每秒受到 10% **当前**攻击力的法术伤害"，每层各一份）
  once(battle, `talent:ascln_dot:${unit.id}`, () => {
    battle.on('tick', (ctx) => {
      if (!unit.alive || !unit.deployed) return;
      unit.mem.asclnDotAcc = num(unit.mem.asclnDotAcc, 0) + num(ctx && ctx.dt, 0);
      if (unit.mem.asclnDotAcc < every) return;
      unit.mem.asclnDotAcc = 0;
      const atk = num(unit.s && unit.s.atk, 0);
      if (!(atk > 0) || !(ratio > 0)) return;
      for (const e of battle.enemies) {
        if (!e.alive) continue;
        const b = e.findBuff ? e.findBuff(DETENTION) : null;
        if (!b) continue;
        const n = Math.max(1, num(b.stacks, 1));
        battle.loseHp(e, atk * ratio * n, { tags: ['dot', 'talent'], sourceless: true });
      }
    }, { owner: unit });
  });
}

/** 天赋2「噬光残影」：攻击速度 +8；**自身周围四格有高台**时额外 +6。 */
function installLightShadow(battle, unit, t1) {
  const base = num(t1.attack_speed, 8);
  const extra = num(t1.attack_speed_add, 6);
  /** 高台 = `height === 'HIGH'` 且可部署（`canStand(r,c,{ranged:true})` 同时允许 LOW+RANGED/ALL 与 HIGH）。 */
  const highAround = () => {
    const g = battle.grid;
    if (!g || typeof g.canStand !== 'function' || typeof g.tile !== 'function' || typeof g.inRect !== 'function') return false;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const r = unit.tileR + dr, c = unit.tileC + dc;
        if (!g.inRect(r, c)) continue;
        if (g.tile(r, c).height !== 'HIGH') continue;
        if (!g.canStand(r, c, { ranged: true })) continue;
        return true;
      }
    }
    return false;
  };
  const apply = () => statBuff(battle, unit, 'talent:ascln_light', { aspd: base + (highAround() ? extra : 0) });
  apply();
  // 邻接高台可能因部署/再部署变化 ⇒ 每 0.5 s 重算（`statBuff` 同 key 覆盖 ⇒ 幂等）
  battle.every(0.5, () => { if (unit.alive && unit.deployed) apply(); }, { owner: unit });
}

function ascln(bb, chess, def) {
  const t0 = talentBb(chess, 0), t1 = talentBb(chess, 1);
  const s1 = skillBbOf(chess, 'skchr_ascln_1');
  const s2 = skillBbOf(chess, 'skchr_ascln_2');
  const s3 = skillBbOf(chess, 'skchr_ascln_3');
  return {
    skills: {
      // S1 追袭：可充能 2 次（`instantKind` 读 `def.skill.maxCharges`）⇒ 下一次攻击 ×1.3 且连击两次
      skchr_ascln_1: {
        kind: instantKind(def),
        attack: { atkScale: num(s1.atk_scale, 1.3), hits: Math.max(1, Math.floor(num(s1.cnt, 2))) },
      },
      // S2 恩赐：攻击力 +50%；范围内**地面**敌人移速 −30%；被击倒时给击杀点**周围**敌人补一层天赋1
      skchr_ascln_2: {
        kind: 'duration',
        mods: { atkPct: num(s2.atk) },
        onStart({ battle, unit }) {
          // "攻击范围内地面敌人移动速度 −30%"：每 0.5 s 给范围内的**非飞行**敌人挂一层减速 buff
          // ⚠️ 用 `foesInRadius`（**可选中**语义：跳过不可选中/未破隐的隐匿）—— 敌方单位是"敌人"，
          //    按 PRTS AOE 判定应走可选中选择器（与 `enemies.js` 的 `areaAllies` 同一纪律）。
          const r = num(s2.range_radius, 1.3);
          battle.every(0.5, (b) => {
            if (!unit.alive || !unit.deployed) return;
            if (!(unit.skill && unit.skill.active && unit.skill.id === 'skchr_ascln_2')) return;
            for (const e of b.foesInRadius(unit.x, unit.y, r)) {
              if (!e.alive || e.isFlying) continue;          // 官方写"**地面**敌人"
              b.addBuff(e, { key: 'skill:ascln_s2_slow', duration: 1.0, refresh: 'extend', source: unit,
                mods: { movePct: num(s2.move_speed, -0.3) } });
            }
          }, { owner: unit });
          // "并在其被击倒时对周围敌人施加一层第一天赋效果"
          battle.on('kill', (ctx) => {
            const v = ctx && ctx.victim;
            if (!v || v.side !== 'enemy') return;
            if (!(unit.skill && unit.skill.active && unit.skill.id === 'skchr_ascln_2')) return;
            for (const e of battle.foesInRadius(v.x, v.y, RING1)) {
              if (e.alive) addDetention(battle, unit, e, t0);
            }
          }, { owner: unit });
        },
      },
      // S3 降临：攻击力 +20%、攻击间隔缩短、自身更易被攻击（taunt +2）
      // ⚠️ "命中率 −15%" 与 "未命中/闪避回血" **未实现**（引擎没有命中率原语）—— 见文件头 ①②
      skchr_ascln_3: {
        kind: 'duration',
        mods: {
          atkPct: num(s3.atk),
          batPct: batMod(num(s3.base_attack_time, -1.2), chess),
          taunt: num(s3.taunt_level, 2),
        },
      },
    },
    talents: [
      { install(battle, unit) { installDetention(battle, unit, t0); } },
      { install(battle, unit) { installLightShadow(battle, unit, t1); } },
    ],
  };
}

// ⚠️ 导出形态与另三个 `reserve-*.js` 一致：**对象、键 = `chess_<slug>_a`**（本仓库 133 个 KITS 键全带 `_a`）。
export default {
  chess_ascln_a: ascln,
};
