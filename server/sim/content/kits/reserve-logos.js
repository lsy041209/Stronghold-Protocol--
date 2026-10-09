// server/sim/content/kits/reserve-logos.js — **逻各斯**（char_4133_logos）的 kit
//
// 外援干员（A-7 第 3 位）。数据来源 = `content-packs/logos.pack.json.pending`
// （由 `.workbuddy/tools/a7-gen-reserve-packs.mjs` 从 `.workbuddy/simpfun-ref/data_chess.json` 投影）。
//
// ── 官方口径（逐条抄自 pack 的 `trait.desc` / `talents[].desc` / `skills[].desc`）────────────────
//   职业：CASTER / **corecaster 中坚术师**（远程）。特性：「**攻击造成法术伤害**」（引擎既有）
//   天赋1「语汇演化」：对一个目标发起攻击时，有 **40%** 几率额外对攻击范围内**一个随机目标**造成
//        相当于攻击力 **60%** 的法术伤害并使其**停顿 0.8 秒**
//   天赋2「剜魂具辞」：攻击使目标在 **5 秒**内**法术抗性 −10** 且**受到的法术伤害提高 150 点**
//   S1 殁亡（AUTO，**持续时间无限**，`rangeGrid` 提到 **12 格**）：攻击范围扩大，攻击力 **+40%**，
//        使攻击范围内**生命值低于逻各斯攻击力 90%** 的敌人**立刻倒下**，
//        并对**另一个随机目标**造成**与倒下单位生命值相等**的法术伤害
//   S2 提喻（20 s）：**法术抗性 +40**，攻击改为**锁定一个目标**对其**每 0.5 秒**造成一次
//        相当于攻击力 **35%** 的法术伤害，**对相同目标的伤害逐渐提高至 3 倍**并使其**移动速度逐渐降低至 40%**
//        （**锁定 5 秒后达到上限**），被打断或目标倒下时**重新索敌且效果重置**
//   S3 延异视阈（30 s，**默认技能**，`rangeGrid` 提到 **18 格**）：攻击范围扩大，攻击力 **+160%**，
//        **同时攻击 3 个目标**，使攻击范围内**敌方子弹的飞行速度大幅降低**、并在**技能结束时将其全部清除**
//
// ── ⚠️ 仍是近似 / 未做（**别当成已实现**）──────────────────────────────────────────────────
//   ① 🔴 **天赋2 的"受到的法术伤害 +150 点"没做**：引擎只有**乘法**的 `artsTakenMul`（见 `buffs.js:27` 的
//      合法列表：`artsTakenMul/physTakenMul/dmgTakenMul…`），**没有"受到法术伤害 +N（平加）"这个原语**。
//      本 kit 只做了能精确表达的**法术抗性 −10**（`resFlat: -10`）。
//      ⇒ 要做完整需要**新引擎原语**（`artsTakenFlat`），**不是 kit 层能补的** ⇒ 已记账。
//   ② 🟡 **S2 的"攻击改为锁定一个目标、每 0.5 s 一跳、伤害逐渐提高至 3 倍、移速逐渐降至 40%"是近似**：
//      我实现为"范围内取一个锁定目标 → 每 0.5 s 一跳（`atk × 0.35`，逐跳 ×(1+0.07×n) 封顶 3 倍）+
//      每跳叠一层 `movePct`（逐渐到 −0.6）"；**"被打断"的判据**（技能结束/目标死亡重置）我按
//      "目标死亡或技能不再激活 ⇒ 清 `mem`"处理 [ASSUMED]。
//   ③ 🟡 **S3 的"敌方子弹飞行速度降低 / 技能结束全部清除"未做**：需要"敌方投射物"的可写入口
//      （`projectile_move_scale` 在数据里，但我**没有**验证引擎有对应的运行时通道）[ASSUMED 缺]。
//      S3 我只做了能精确表达的**范围扩大 / 攻击力 ×2.6 / 同时 3 个目标**。
//   ④ 🟡 **S1 的"立刻倒下"用 `battle.kill` 直杀**（不是伤害到 0）：这样"与倒下单位生命值相等的法术伤害"
//      才能取到**真实的倒下前生命值**。⚠️ 这意味着**绕过护盾/减伤**（官方文案就是"立刻倒下"）[ASSUMED]。
//   ⑤ S1 的"另一个随机目标"用 `battle.rng.pick`（确定性）✓；**排除刚倒下的那个**。
//
// 判据：`test/content/reserve-logos.test.js`（先红后绿）
import { num, talentBb, skillBbOf, onHitBy } from './tier1.js';
import { COLS } from '../../constants.js';
import { rotateOffset } from '../../dir.js';

/** 技能自带的范围（相对格）→ 绝对格子键集合。与 `reserve-chen3.js:98` 同一算法。 */
const skillGridOf = (chess, skillId) => {
  const rec = (chess?.skills ?? []).find((s) => s.skillId === skillId);
  return rec?.rangeGrid?.length ? rec.rangeGrid : null;
};
function absKeys(unit, grid) {
  const out = new Set();
  for (const [dr, dc] of grid) {
    const [rr, cc] = rotateOffset(dr, dc, unit.dir);
    const r = unit.tileR + rr, c = unit.tileC + cc;
    if (r >= 0 && c >= 0 && c < COLS) out.add(r * COLS + c);
  }
  return out;
}
/** 技能范围内的敌人（**可选中**语义：跳过不可选中/未破隐的隐匿）。 */
const foesInSkillRange = (battle, unit, grid) => {
  if (!grid) return [];
  const keys = [...absKeys(unit, grid)];
  return battle.enemiesInKeys(keys, unit, unit.profile);
};

function logos(bb, chess, def) {
  const t0 = talentBb(chess, 0), t1 = talentBb(chess, 1);
  const s1 = skillBbOf(chess, 'skchr_logos_1');
  const s2 = skillBbOf(chess, 'skchr_logos_2');
  const s3 = skillBbOf(chess, 'skchr_logos_3');
  const G1 = skillGridOf(chess, 'skchr_logos_1');
  const G3 = skillGridOf(chess, 'skchr_logos_3');

  return {
    skills: {
      // S1 殁亡：范围扩大 + 攻击力 +40% + **处决**（< 攻击力 90% 立刻倒下）+ 对另一随机目标造成等量法术伤害
      // ⚠️ **无限持续必须用 `kind: 'toggle'`**（本仓库既有语义，见 `reserve-wang.js` 的 S1/S2、星熊 S1）。
      //    我第一版写 `duration: Infinity` ⇒ **`activate()` 直接失败**（`active` 一直是 false）——
      //    因为引擎的 `isTimed` 判定看的是 `kind`，不是 `duration` 的数值。
      skchr_logos_1: {
        kind: 'toggle',
        targeting: { rangeGrid: G1 },
        mods: { atkPct: num(s1.atk) },
        onAttack({ battle, unit }) {
          const thresh = num(unit.s && unit.s.atk, 0) * num(s1['attack@kill_atk_scale'], 0.9);
          if (!(thresh > 0)) return;
          const foes = foesInSkillRange(battle, unit, G1);
          const victim = foes.find((e) => e.alive && e.hp < thresh);
          if (!victim) return;
          const lost = victim.hp;                       // "与倒下单位生命值相等"
          // ⚠️ `fx` 的 kind **必须在 `public/js/render/fx.js` 的 `FX_KINDS` 里注册**，
          //    否则 `test/render/boardart.test.js` 的「every fx kind literal in server/sim has an explicit visual」会红
          //    （我第一版写了 `'execute'`，**当场被这条判据抓住** ⇒ 这是"先红后绿"起作用的例子）。
          //    这里用既有的 `'strike'`：处决的视觉本来也就是"在敌人身上爆一下"。
          battle.fx('strike', { x: victim.x, y: victim.y, id: victim.id, src: unit.id });
          battle.kill(victim, unit);
          // "对**另一个**随机目标造成与倒下单位生命值相等的法术伤害" ⇒ 排除刚倒下的那个
          const rest = foes.filter((e) => e.alive && e !== victim);
          if (!rest.length || !(lost > 0)) return;
          const t = battle.rng.pick(rest);
          if (t && t.alive) {
            battle.dealDamage(unit, t, { amount: lost, type: 'arts', isSkill: true, tags: ['skill', 'logosExecute'] });
          }
        },
      },
      // S2 提喻：法术抗性 +40；攻击改为"锁一个目标、每 0.5 s 一跳、伤害渐增至 3 倍、移速渐降至 40%"
      skchr_logos_2: {
        kind: 'duration',
        mods: { resFlat: num(s2.magic_resistance, 40) },
        onStart({ battle, unit }) {
          const cd = Math.max(0.05, num(s2['attack@cooldown'], 0.5));
          const base = num(s2['attack@atk_scale_base'], 0.35);
          const delta = num(s2['attack@atk_scale_delta'], 0.07);
          const maxN = Math.max(1, Math.floor(num(s2['attack@max_stack_cnt'], 10)));
          const slowStep = num(s2['attack@move_speed'], -0.06);
          const buf = 'skill:logos_s2_burn';
          battle.on('tick', (ctx) => {
            if (!unit.alive || !unit.deployed) return;
            if (!(unit.skill && unit.skill.active && unit.skill.id === 'skchr_logos_2')) {
              unit.mem.logosS2 = null; return;              // 技能结束 ⇒ 重置（"被打断…效果重置"）
            }
            unit.mem.logosS2Acc = num(unit.mem.logosS2Acc, 0) + num(ctx && ctx.dt, 0);
            if (unit.mem.logosS2Acc < cd) return;
            unit.mem.logosS2Acc = 0;
            // 锁定目标：目标死了/丢了就重新索敌并**重置层数**（官方"被打断或目标倒下时重新索敌且效果重置"）
            let lock = unit.mem.logosS2 && unit.mem.logosS2.id != null
              ? battle.enemies.find((e) => e.alive && e.id === unit.mem.logosS2.id) : null;
            if (!lock) {
              // S2 的索敌走**本体射程**（官方只说"锁定一个目标"，没给新范围）
              lock = battle.enemiesInKeys(unit.rangeKeys, unit, unit.profile)[0] ?? null;
              unit.mem.logosS2 = lock ? { id: lock.id, n: 0 } : null;
            }
            if (!lock) return;
            const n = Math.min(maxN, num(unit.mem.logosS2.n, 0) + 1);
            unit.mem.logosS2.n = n;
            const atk = num(unit.s && unit.s.atk, 0);
            // 官方"伤害逐渐提高至 3 倍"：每跳 +`delta` 的攻击力比例，封顶 3 × base
            const scale = Math.min(base * 3, base + delta * n);
            battle.dealDamage(unit, lock, { amount: atk * scale, type: 'arts', isSkill: true, tags: ['skill', 'logosBurn'] });
            // 移速逐渐降低（上限 = 数据给的 −0.06 × 10 = −0.6 ⇒ 40%）
            battle.addBuff(lock, { key: buf, duration: cd * 2, refresh: 'extend', source: unit,
              mods: { movePct: slowStep * n } });
          }, { owner: unit });
        },
      },
      // S3 延异视阈：范围扩大 + 攻击力 +160% + 同时 3 个目标
      // ⚠️ "敌方子弹减速 / 结束时清除" 未做（见文件头 ③）
      skchr_logos_3: {
        kind: 'duration',
        targeting: { rangeGrid: G3, maxTargets: Math.max(1, Math.floor(num(s3['attack@max_target'], 3))) },
        mods: { atkPct: num(s3.atk) },
      },
    },
    talents: [
      // 天赋1 语汇演化：40% 几率额外打一个随机目标（×0.6 法术）+ 停顿 0.8 s
      { install(battle, unit) {
        const prob = num(t0.prob, 0.4), scale = num(t0.atk_scale, 0.6), slow = num(t0.sluggish, 0.8);
        onHitBy(battle, unit, (ctx) => {
          if (ctx.dmg && ctx.dmg.cancel) return;
          if (!(scale > 0) || !battle.rng.chance(prob)) return;
          // "对攻击范围内一个随机目标" ⇒ 用**本体射程**里可被选中的敌人（排除刚打的那个）
          const pool = battle.enemiesInKeys(unit.rangeKeys, unit, unit.profile)
            .filter((e) => e.alive && e !== ctx.target);
          const t = pool.length ? battle.rng.pick(pool) : null;
          if (!t) return;
          const atk = num(unit.s && unit.s.atk, 0);
          battle.dealDamage(unit, t, { amount: atk * scale, type: 'arts', tags: ['talent', 'logosEcho'] });
          if (slow > 0 && t.alive) battle.applyStatus(t, 'sluggish', { duration: slow, source: unit });
        });
      } },
      // 天赋2 剜魂具辞：攻击使目标 5 s 内法术抗性 −10（⚠️ "+150 点受到法术伤害" 见文件头 ①，未做）
      { install(battle, unit) {
        const dur = num(t1.duration, 5), res = num(t1.magic_resistance, -10);
        onHitBy(battle, unit, (ctx) => {
          if (ctx.dmg && ctx.dmg.cancel) return;
          const t = ctx.target;
          if (!t || !t.alive) return;
          battle.addBuff(t, { key: 'talent:logos_res_down', duration: dur, refresh: 'extend', source: unit,
            mods: { resFlat: res } });
        });
      } },
    ],
  };
}

// ⚠️ 导出形态与另三个 `reserve-*.js` 一致：**对象、键 = `chess_<slug>_a`**（本仓库 133 个 KITS 键全带 `_a`）。
export default {
  chess_logos_a: logos,
};
