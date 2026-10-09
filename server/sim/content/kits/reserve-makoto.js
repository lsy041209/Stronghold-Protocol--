// server/sim/content/kits/reserve-makoto.js — **结城理**（char_4217_makoto）的 kit
//
// 数据来源 = `content-packs/makoto.pack.json.pending`（由 `a7-gen-reserve-packs.mjs` 从 simpfun 参照投影，**别手抄**）。
// 骨架由 `.workbuddy/tools/a7-new-kit.mjs --kit char_4217_makoto` 生成（2026-10-07 第 51 轮 A）；**本文件已是实现**（骨架标记已删）。
//
// ── 官方口径（逐条抄自 pack）──────────────────────────────────────────────────────────────
//   职业：SPECIAL/**dollkeeper**（傀儡师）　攻击：melee/phys
//   特性：「受到致命伤时不撤退，切换成<替身>作战（替身阻挡数为0），持续20秒后自身再次替换<替身>」bb `{duration: 20}`
//        ⇒ **引擎已实现**：`server/sim/professions.js installDollkeeper`（致命伤 → 1 秒切换动画 → 替身 20 秒 → 切回；
//          `unit.trait.doll` / `dollSwitching` / `unit.form='doll'` / fx `substitute|swap|dollEnd` / 钩子 `dollSwitch` `dollSwap`）
//   天赋0「不羁之力」：切换为<替身>时**停顿周围一定范围内敌人 8 秒**；<替身>状态下召唤**人格面具**作战，
//        攻击间隔增大、攻击力 +80%、生命值 +35%，作战能力随技能选择而改变　bb `{atk:0.8, base_attack_time:0.4, sluggish:8, max_hp_t1:0.35}`
//   天赋1「S.E.E.S.队长」：<替身>状态**结束后**，带领 S.E.E.S. 小队发动**总攻击**，
//        对 S.E.E.S. 小队队员周围一定范围内的所有敌人造成 **430% 攻击力真实伤害**（可叠加）　bb `{atk_scale:4.3, multi_attack_total_cnt:1, final_damage_different_ratio:1}`
//   S1「俄耳甫斯的竖琴」：被动：<替身>状态召唤**俄耳甫斯**，攻击造成 **150% 攻击力法术伤害**；
//        **范围内有生命值低于 50% 的友方干员时，改为对其治疗 40% 攻击力**。主动：**立即切换为<替身>作战**　bb `{attack@atk_scale:1.5, attack@heal_scale:0.4}`
//   S2「塔纳托斯的囚锁」：被动：<替身>状态召唤**塔纳托斯**，攻击对**至多 3 名**敌人造成 **160% 攻击力法术伤害**，
//        并有 **35% 概率恐惧 1.5 秒**；范围内**恐惧中**的敌人若生命值**低于 230% 攻击力**则**立刻倒下**。主动：立即切换为<替身>
//        bb `{attack@max_target:3, attack@atk_scale:1.6, attack@prob:0.35, attack@fear:1.5, attack@kill_atk_scale:2.3, attack@kill_damage:9999999}`
//   S3「开辟明日的剑刃」：被动：<替身>状态**初始召唤塔纳托斯**，攻击速度 +30，攻击对**至多 3 名**敌人造成 **170% 弱点伤害**；
//        **塔纳托斯在场时**，**开启技能或受到致命伤时改为召唤俄耳甫斯**，**阻挡数 +2**，使**范围内友方干员获得 30% 物理与法术闪避**，
//        并**每秒治疗范围内最多 3 名友方干员 25% 攻击力**，**直到<替身>状态结束**。主动：立即切换为<替身>
//        bb `{talent@attack_speed:30, attack@atk_scale:1.7, attack@heal_scale:0.25, attack@interval:1, attack@prob:0.3, attack@max_target:3, attack@max_target_heal:3, attack@block_cnt:2}`
//
// ── 🔴 第 52 轮 A：按 PRTS 复核后改了三处（**起因 = 用户实机反馈**："三技能只出现替身图标，模型不变、范围不变，被打死也不切第二替身"）
//   权威来源（用户点名，2026-10-07 复核）：<https://prts.wiki/w/结城理> 的「攻击范围」「技能」「天赋」三节 ＋
//   <https://prts.wiki/index.php?title=分支特性信息/data&action=raw> 的「傀儡师」分支正文。
//   ① **替身的作战范围**：本体 `1-1`（自身格＋身前 1 格 = **2 格**）；**<替身>的攻击范围 `x-1` = 自身周围 8 格
//      ＋上下左右再外扩 1 格 = 13 格**，且 S1/S2/S3 的「技能范围」**也都是 x-1**（与本仓库记录的 13 条 `rangeGrid` 逐格对上 ✓）。
//      ⇒ 本 kit 现在进替身时把 `unit.rangeGrid` 换成技能的 13 格并 `battle.refreshRange`（引擎的合法手段，
//        与 `tier4.js` 的 `applyModuleRange` 同一套；`Battle._refreshRange:1814` 读的就是 `unit.rangeGrid`），
//        **切回本体时还原**成 2 格。这一条同时修"引擎打得到、卡面范围不变"（`unitStatsEntry.range`）。
//   ② **天赋0 的停顿范围**：PRTS 天赋备注写明「**停顿效果范围与<替身>的攻击范围相同**」⇒ 从"本体周围 8 格"改成 **x-1**。
//   ③ **S3 的两个人格面具形态**：官方 S3 备注 —— `<塔纳托斯·改>`（P1）期间**受到致命伤**或**再次点按技能键**
//      ⇒ 切到 `<俄耳甫斯·改>`（P2）；P2「持有阻回、静默，**不进行普通攻击**，阻挡**不再归零**（恢复正常 2 阻挡数）」，
//      并每秒对范围内生命不满的友方治疗。⇒ 本 kit 现在**真的会切 P2**（收掉 P1 的攻速加成，换上阻挡 2 ＋ 强制缴械/静默）。
//      「第二替身」这个词只对 S3 成立：**非 S3 的替身被击倒 ⇒ 撤退**（官方分支正文只规定"20 秒到点切回本体"，
//      替身被击倒的处理无明文 ⇒ 保留引擎现状，见 §4.5-3 的复核结论）。
//   📌 形态名（客户端 `public/js/render/units.js` 的 `FORMS`）：引擎只发 `'doll'`，客户端按 `skillIndex`
//      分成 俄耳甫斯(S1)／塔纳托斯(S2)／塔纳托斯·改(S3 P1) 三套 clip；**S3 的 P2 由本 kit 自己发 `'doll_orpheus'`**。
//
// ── ⚠️ [ASSUMED] / 未做（**别当成已实现**）─────────────────────────────────────────────────
//   ① ~~**「弱点伤害」的伤害类型**按真实伤害实现~~ ⇒ 🔴 **第 52 轮更正**：PRTS S3 备注原文「**弱点伤害的默认伤害类型为法术伤害**」
//      ⇒ 已改成 **`arts`（法术）**（第 51 轮按 `true` 实现是**错的**，已修）。
//   ② **「S.E.E.S. 小队队员周围」**：我们的数据里**没有 S.E.E.S. 盟约/队员**（simpfun 参照把联动的盟约填成了别的）
//      ⇒ `SEES_CHARS` 为空集，总攻击**只按结城理自己**的射程算 [ASSUMED]；将来数据里有队员时，把 charId 填进集合即可。
//   ③ **「人格面具在场」**：本 kit 用 `unit.mem.makotoPersona`（'thanatos' | 'orpheus'）**状态机**建模，**不是**真正的召唤物实体
//      （pack 的 `tokens: []` ⇒ 没有 token 实体）。⇒ S3 的"塔纳托斯在场时…改为召唤俄耳甫斯"按状态机实现 [ASSUMED]。
//   ④ **「可叠加」**（`multi_attack_total_cnt: 1`）：总攻击按**一次** 430% 实现（数据给的就是 1 次）。
//   ⑤ 「停顿周围一定范围」的**半径**：bb 没给 ⇒ 按官方天赋备注「**停顿效果范围与<替身>的攻击范围相同**」取 `x-1`（13 格）。
//   ⑥ S2 的"额外 2 个目标"走 `dealDamage`（**不是**同一次命中的分叉）⇒ 它们**各自**过一遍减伤/护盾，与主目标一致 [ASSUMED]。
//   ⑦ **替身的「不可对空」没做**：官方 S1/S2 备注写明 <俄耳甫斯>/<塔纳托斯>「不可对空」（S2 的恐惧斩杀光环**可对空**）；
//      本 kit 没改 `canHitFly` ⇒ 替身的普通攻击仍可能打飞行单位。**这是缺口，不是已实现。**
//   ⑧ **P1⇒P2 的切换动画只播半段**：官方有 `Doll_Skill_3_P1toP2_ChangeBegin`(0.5 s) ＋ `ChangeEnd`(1 s)，
//      而 `render/spine.js setForm(roles, change)` 只接受**一个**过渡 clip ⇒ 客户端目前播 `ChangeBegin` 后直接进 P2 待机，
//      `ChangeEnd` 那 1 秒没播（见 `public/js/render/units.js` 的 FORMS 注释）。
//
// 判据：`test/content/reserve-makoto.test.js`（注入式 10 条，第 51 轮）＋
//      **`test/content/reserve-makoto-realpath.test.js`（真实路径：真 data ＋ `content:'full'` ＋ 真 kit 注册表 ＋ 真 loadout）**
//      ＋ `test/render/reserve-makoto-form.test.js`（渲染层：FORMS 的每条 clip 在真素材里存在 ＋ 真的切得动）。
import { num, talentBb, skillBbOf, onHitBy, statBuff, enemiesInGrid } from './tier1.js';

/** 本体周围 8 格（傀儡师既有 kit 的口径，见 `tier5.js` 的 `aroundGrid`）——**只在拿不到技能范围时兜底**，
 *  官方替身的作战范围是 `x-1`（13 格），见 §①。 */
const AROUND = [[1, -1], [1, 0], [1, 1], [0, -1], [0, 0], [0, 1], [-1, -1], [-1, 0], [-1, 1]];
/** S.E.E.S. 小队队员的 charId —— 我们的数据里没有 ⇒ 空集（[ASSUMED] ②）。 */
const SEES_CHARS = new Set();
/** 替身形态（**不含** 1 秒切换动画：动画期间她既不是本体也不是替身）。 */
const inDoll = (u) => !!u && u.alive && !!u.trait && u.trait.doll === true && !u.trait.dollSwitching;
/** 客户端 `FORMS` 的形态名：引擎发 `'doll'`（客户端按 `skillIndex` 分三套）；S3 的 P2 由本 kit 自己发。 */
const FORM_DOLL = 'doll';
const FORM_ORPHEUS_KAI = 'doll_orpheus';
/** 第二天赋的 `<总攻击>` 形态（官方备注：替身结束后**先切总攻击形态**、随后再回本体）。 */
const FORM_ALLOUT = 'allout';
/** `<总攻击>` 的时长 —— **由骨骼推**（不是编的）：`Skill_AllOutAttack_Loop` 0.167 s ＋ `_End` 1.433 s = **1.6 s**。 */
const ALLOUT_DUR = 0.167 + 1.433;
/** S3 两个人格面具形态的 buff 键：P1 `<塔纳托斯·改>` 的攻速 / P2 `<俄耳甫斯·改>` 的阻挡与禁普攻。 */
const S3_P1 = 'talent:makotoS3P1';
const S3_P2 = 'talent:makotoS3P2';

function makoto(bb, chess, def) {
  void bb; void def;
  const t0 = talentBb(chess, 0);
  const t1 = talentBb(chess, 1);
  const s1 = skillBbOf(chess, 'skchr_makoto_1');
  const s2 = skillBbOf(chess, 'skchr_makoto_2');
  const s3 = skillBbOf(chess, 'skchr_makoto_3');
  /** 技能的「范围」（官方 `rangeGrid`，13 格）——**替身的作战范围按技能走**（本体的 melee 射程只有 2 格）。 */
  const skillGrid = (skillId) => (chess?.skills ?? []).find((s) => s && s.skillId === skillId)?.rangeGrid ?? AROUND;
  /** 主动：「立即切换为<替身>状态作战」——走引擎的 `dollSwitch`（`professions.js` 的 `enter()`）。 */
  const switchToDoll = (battle, unit) => { battle.emit('dollSwitch', { unit, reason: 'skill', done: false }); };

  return {
    skills: {
      skchr_makoto_1: { kind: 'instant', onStart({ battle, unit }) { switchToDoll(battle, unit); } },
      skchr_makoto_2: { kind: 'instant', onStart({ battle, unit }) { switchToDoll(battle, unit); } },
      skchr_makoto_3: { kind: 'instant', onStart({ battle, unit }) { switchToDoll(battle, unit); } },
    },
    talents: [
      { install(battle, unit) {
        // ── 天赋0：替身形态的加成 ＋ 切换时的 8 秒停顿 ──────────────────────────────────────────
        const ATK_PCT = num(t0.atk, 0.8), HP_PCT = num(t0.max_hp_t1, 0.35), SLUG = num(t0.sluggish, 8);
        // 攻击间隔增大：官方 `base_attack_time: 0.4`（平加秒数）⇒ 本仓库约定 `batPct = 0.4 / bat`（见 `tier1.js batMod`）
        const BAT_PCT = num(t0.base_attack_time, 0.4) / Math.max(0.1, num(chess?.stats?.bat, 1.2));
        const SID = () => (unit.skill && unit.skill.id) || null;
        const isS3 = () => SID() === 'skchr_makoto_3';
        const personaIs = (p) => unit.mem.makotoPersona === p;
        /** 本体范围（官方 `1-1` = 2 格）：第一次进替身前记下来，切回时**必须**还原（别把范围永久改掉）。 */
        let bodyGrid = null;
        /** 替身的作战范围 = 选中技能的 `rangeGrid`（官方 `x-1` = 13 格；三个技能都是它）。 */
        const dollGrid = () => skillGrid(SID());
        /** 告诉客户端「现在画哪套替身 clip」——引擎只发 `'doll'`，**S3 的 P2 是我们自己的形态**。 */
        const announceForm = (form) => {
          unit.form = form;
          battle.fx('phase', { x: unit.x, y: unit.y, id: unit.id, kind: form, form });
        };
        /** 🔴 替身的作战范围（官方 `x-1`）：引擎的合法手段 = 改 `unit.rangeGrid` 再 `battle.refreshRange`
         *  （`Battle._refreshRange` 读的就是它；`tier4.js` 的 `applyModuleRange` 是同一个用法）。
         *  ⚠️ 不改的话替身的 `rangeKeys` 只有本体那 2 格 ⇒ 玩家在场上看到的**高亮范围不变**
         *  （`unitStatsEntry.range` = `unit.liveRangeGrid`，卡面/场上画的就是它）——**用户实测的那一条**。 */
        const setRange = (grid) => {
          if (!Array.isArray(grid) || !grid.length) return;
          unit.rangeGrid = grid;
          battle.refreshRange(unit);
        };
        /** P2 `<俄耳甫斯·改>` 给范围内友方的 30% 物法闪避的 buff 键（**必须记名单**，见 `dodgeSet`）。 */
        const dodgeKey = `talent:makotoOrpheusDodge:${unit.id}`;
        /** 当前挂着闪避的友方 —— `statBuff` 是 `persist`（永不过期）⇒ 不主动收掉就会**永久**留在友方身上。 */
        const dodgeSet = new Set();
        const applyForm = () => {
          statBuff(battle, unit, 'talent:makotoDoll', { atkPct: ATK_PCT, hpPct: HP_PCT, batPct: BAT_PCT });
          // Y 模组「彼此的声音」：官方**特性 override** 的 `bb.max_hp` = `<替身>` 生命值 +20%（1 级就有；2/3 级还改天赋）。
          // ⚠️ 引擎**没有**读 `trait.bb.max_hp` 的通用规则 —— 只有 `tier5.js:1764` 给归溟幽灵鲨单独读过一次；
          //    所以本 kit 自己读（不然精锐装了模组，说明文字写了"生命值提升"而数值不动）。
          const hpUp = num(chess && chess.trait && chess.trait.bb && chess.trait.bb.max_hp, 0);
          if (hpUp) statBuff(battle, unit, 'talent:makotoDollY', { hpPct: hpUp });
          // S3 的 P1（<塔纳托斯·改>）：「攻击速度 +30」（数据在技能 bb 里）
          if (isS3() && !personaIs('orpheus')) statBuff(battle, unit, S3_P1, { aspd: num(s3['talent@attack_speed'], 30) });
          if (bodyGrid === null) bodyGrid = unit.rangeGrid;      // 本体范围只记一次（进替身前）
          setRange(dollGrid());
        };
        const clearForm = () => {
          for (const k of ['talent:makotoDoll', 'talent:makotoDollY', S3_P1, S3_P2]) battle.removeBuff(unit, k);
          for (const a of dodgeSet) battle.removeBuff(a, dodgeKey);
          dodgeSet.clear();
          // 范围必须还原成本体那 2 格（官方 `1-1`）——不还原就是"替身结束后范围永久变大"的 bug
          if (bodyGrid) { unit.rangeGrid = bodyGrid; battle.refreshRange(unit); }
        };
        /**
         * S3 的 P2：`<塔纳托斯·改>` ⇒ `<俄耳甫斯·改>`（官方 S3 备注：**受到致命伤**或**再次点按技能键**）。
         * 官方 P2「持有阻回、静默，**不进行普通攻击**，阻挡**不再归零**（恢复正常 2 阻挡数）」。
         * @returns {boolean} 真的切了（调用方据此决定是否吞掉这次致命伤）
         */
        const toOrpheusKai = () => {
          if (!inDoll(unit) || !isS3() || !personaIs('thanatos')) return false;
          unit.mem.makotoPersona = 'orpheus';
          battle.removeBuff(unit, S3_P1);
          battle.addBuff(unit, {
            key: S3_P2, persist: true, allowDead: true, tags: ['talent'],
            // ⚠️ 引擎里 `s.blockCnt = 本体基础值 + Σ(mods)`；特性给替身 **−99**（"替身阻挡数为 0"），
            //    官方 P2 要**恢复到正常的 2** ⇒ 这个 mod 必须是 `目标值 − 基础值 + 99`
            //    （实测：给 101 会变成 4；给 99 才对）。
            mods: { blockCnt: num(s3['attack@block_cnt'], 2) - num(chess?.stats?.blockCnt, 2) + 99 },
            flags: { disarm: true, silence: true },     // 官方 P2：不进行普通攻击（＋静默）
          });
          announceForm(FORM_ORPHEUS_KAI);
          return true;
        };
        /**
         * 第二天赋「S.E.E.S.队长」的**总攻击**（官方天赋备注逐字）：
         * 「`<替身>` 结束后会**先切换为 `<总攻击>` 形态**发起总攻击（**不享受 `<替身>` 形态的天赋/技能加成**），
         *   **随后再切换回 `<本体>`**；`<总攻击>` 期间持有〔无敌〕〔静默〕；每个队员的总攻击**均可对空**，
         *   其**伤害范围 `x-1`**。」
         * 🔴 用户实机「天赋的**真实伤害我并未看出来**」的两个根因都在这段里：
         *   ① 原来用**本体周围 8 格**（3×3）⇒ 官方是 **`x-1`**（13 格，多出正前方第 2 格那 4 格）⇒ **范围小了一半**；
         *   ② 原来**只发伤害、不发形态** ⇒ 玩家在屏幕上**看不到任何变化**（没有总攻击的演出）。
         * ⇒ 现在：先切 `<总攻击>` 形态（`FORMS.allout`，`Skill_AllOutAttack_Loop` → 收尾 `_End`，见 `ALLOUT_DUR` 的推导），
         *   期间无敌/静默，伤害按 `x-1` 落地，`ALLOUT_DUR` 后形态自动回本体（客户端靠 fx 的 `dur` 播收尾 clip）。
         */
        const totalAttack = () => {
          const scale = num(t1.atk_scale, 4.3);
          // ⚠️ 取 `atk` 必须在 `clearForm()` **之后**（上面就是）：官方「**不享受 <替身> 形态的天赋/技能加成**」
          const atk = num(unit.s && unit.s.atk, 0);
          unit.form = FORM_ALLOUT;
          battle.fx('phase', { x: unit.x, y: unit.y, id: unit.id, kind: FORM_ALLOUT, form: FORM_ALLOUT, dur: ALLOUT_DUR });
          battle.addBuff(unit, {
            key: 'talent:makotoAllOut', duration: ALLOUT_DUR,
            flags: { invulnerable: true, silence: true, noSp: true },   // 官方：<总攻击>期间持有〔无敌〕〔静默〕
          });
          const srcs = [unit, ...battle.allyUnits.filter((a) => a && a.alive && a.side === 'ally' && SEES_CHARS.has(a.def && a.def.charId))];
          const hit = new Set();
          for (const src of srcs) {
            // 「队员**周围一定范围**」＝官方备注的 **x-1**（[ASSUMED]② 仍是"只按结城理自己算"，因为数据里没有 S.E.E.S. 队员）
            for (const e of battle.unitsInGrid(src, dollGrid(), { side: 'enemy' })) {
              if (!e.alive || hit.has(e.id)) continue;
              hit.add(e.id);
              battle.dealDamage(src, e, { amount: atk * scale, type: 'true', isSkill: true, tags: ['talent', 'makotoAllOut'] });
            }
          }
          // 形态是**状态**（snapshot.js unitInfo.form）⇒ 结束时要把它放回本体，晚建的视图才画得对
          battle.after(ALLOUT_DUR, () => { if (unit.form === FORM_ALLOUT) unit.form = null; }, { owner: unit });
        };
        battle.on('dollSwap', (ctx) => {
          if (ctx.unit !== unit) return;
          if (ctx.form === FORM_DOLL) {
            // S3「初始召唤塔纳托斯」；S1 的替身本身就是<俄耳甫斯>；S2 是<塔纳托斯>
            unit.mem.makotoPersona = isS3() ? 'thanatos' : (SID() === 'skchr_makoto_1' ? 'orpheus' : 'thanatos');
            applyForm();
            // 「切换为<替身>时停顿周围一定范围内敌人 8 秒」——官方天赋备注：
            // 「**停顿效果范围与<替身>的攻击范围相同**」⇒ 用 `dollGrid()`（x-1），不是本体周围 8 格。
            if (SLUG > 0) {
              for (const e of battle.unitsInGrid(unit, dollGrid(), { side: 'enemy' })) {
                if (e.alive && e.side === 'enemy') battle.applyStatus(e, 'sluggish', { duration: SLUG, source: unit });
              }
            }
          } else {
            clearForm();
            totalAttack();
          }
        }, { owner: unit });

        // ── 替身形态的攻击档案（随**选中的技能**改变）──────────────────────────────────────
        // ⚠️ `tier1.js` 的命名：**`onHitBy(battle, unit, fn)` = 本 unit 打中敌人**（代码是 `ctx.source === unit`），
        //    `onHitOn` 才是"敌人打本 unit"。这里要的是前者。
        onHitBy(battle, unit, (ctx) => {
          if (!inDoll(unit)) return;
          const t = ctx.target;
          if (!t || !t.alive || t.side !== 'enemy') return;
          // 🔴 **防递归**：下面"额外目标"是用 `battle.dealDamage(unit, e, …)` 打的 ⇒ 它会**再进这个钩子**。
          //    不做这个闸，一击会指数级放大（探针实测：3 秒 104 次命中）。
          const mine = ctx.dmg && Array.isArray(ctx.dmg.tags) ? ctx.dmg.tags : [];
          if (mine.includes('makotoOrpheus') || mine.includes('makotoThanatos') || mine.includes('makotoWeakness')) return;
          const atk = num(unit.s && unit.s.atk, 0);
          const sid = unit.skill && unit.skill.id;
          const retype = (amount, type, tag) => {
            ctx.dmg.amount = amount;                       // `hit` 钩子在减伤之前 ⇒ 改的是原始值
            ctx.dmg.type = type;
            if (Array.isArray(ctx.dmg.tags) && !ctx.dmg.tags.includes(tag)) ctx.dmg.tags.push(tag);
          };
          if (sid === 'skchr_makoto_1') {
            // S1 俄耳甫斯的竖琴：**攻击范围内**有生命比例 **≤ 50%** 的可治疗友方 ⇒ 改为治疗（40% 攻击力）；否则 150% 法术
            // ⚠️ 阈值是 `<=`：PRTS S1 备注 `{{修正|不高于|原文=低于}}` ⇒ **实机行为是不高于 50%**（游戏内文案仍写"低于"）。
            const ally = battle.unitsInGrid(unit, skillGrid('skchr_makoto_1'), { side: 'ally' })
              .filter((a) => a !== unit && a.alive && a.hp > 0 && a.hpRatio <= 0.5 + 1e-9)
              .sort((a, b) => a.hpRatio - b.hpRatio || a.id - b.id)[0];
            if (ally) {
              ctx.dmg.cancel = true;                        // 这一下不打敌人
              battle.heal(unit, ally, atk * num(s1['attack@heal_scale'], 0.4));
              return;
            }
            retype(atk * num(s1['attack@atk_scale'], 1.5), 'arts', 'makotoOrpheus');
            return;
          }
          if (sid === 'skchr_makoto_2') {
            // S2 塔纳托斯的囚锁：主目标 160% 法术 + 35% 恐惧；再打至多 2 个（合计 max_target 3，**技能范围内**）
            retype(atk * num(s2['attack@atk_scale'], 1.6), 'arts', 'makotoThanatos');
            if (battle.rng.chance(num(s2['attack@prob'], 0.35))) battle.applyStatus(t, 'fear', { duration: num(s2['attack@fear'], 1.5), source: unit });
            const extra = enemiesInGrid(battle, unit, skillGrid('skchr_makoto_2'), { n: Math.max(0, Math.floor(num(s2['attack@max_target'], 3)) - 1) })
              .filter((e) => e.alive && e.id !== t.id);
            for (const e of extra) {
              battle.dealDamage(unit, e, { amount: atk * num(s2['attack@atk_scale'], 1.6), type: 'arts', isSkill: true, tags: ['skill', 'makotoThanatos'] });
              if (battle.rng.chance(num(s2['attack@prob'], 0.35))) battle.applyStatus(e, 'fear', { duration: num(s2['attack@fear'], 1.5), source: unit });
            }
            // 「**范围内**恐惧中的敌人若生命值低于 230% 攻击力则立刻倒下」——官方式的是**范围内所有**这类敌人，
            // 不只是这一击命中的那几个 ⇒ 每次替身攻击时扫一遍技能范围。
            const line = atk * num(s2['attack@kill_atk_scale'], 2.3);
            for (const e of enemiesInGrid(battle, unit, skillGrid('skchr_makoto_2'), { n: 0 })) {
              if (e.alive && e.findBuff('fear') && e.hp < line) battle.kill(e, unit);
            }
            return;
          }
          if (sid === 'skchr_makoto_3') {
            // S3 开辟明日的剑刃：170% 弱点伤害，至多 3 个目标（技能范围内）
            // ⚠️ **伤害类型 = 法术**（不是真实伤害）：PRTS S3 备注原文「**弱点伤害的默认伤害类型为法术伤害**」
            //    （第 52 轮按 C 的 `C给A-结城理官方口径-PRTS取证-2026-10-07.md` §2 复核；此前按 `true` 实现是错的）。
            retype(atk * num(s3['attack@atk_scale'], 1.7), 'arts', 'makotoWeakness');
            const extra = enemiesInGrid(battle, unit, skillGrid('skchr_makoto_3'), { n: Math.max(0, Math.floor(num(s3['attack@max_target'], 3)) - 1) })
              .filter((e) => e.alive && e.id !== t.id);
            for (const e of extra) battle.dealDamage(unit, e, { amount: atk * num(s3['attack@atk_scale'], 1.7), type: 'arts', isSkill: true, tags: ['skill', 'makotoWeakness'] });
          }
        });

        // ── P2 `<俄耳甫斯·改>` 的光环（官方 S3 备注：**直到<替身>状态结束**）：范围内友方 30% 物法闪避 ＋
        //    每秒对生命不满的至多 3 名友方治疗 25% 攻击力（[ASSUMED]：官方还有"延迟 0.5 秒生效"，本仓库没建延迟治疗）
        battle.every(1, () => {
          const on = inDoll(unit) && isS3() && personaIs('orpheus');
          const allies = on
            ? battle.unitsInGrid(unit, skillGrid('skchr_makoto_3'), { side: 'ally' }).filter((a) => a.alive && a.hp > 0)
            : [];
          // 🔴 闪避必须**记名单并主动收掉**：`statBuff` 是 `persist`（永不过期）⇒ 原来只在 `clearForm` 里对
          //    `unit` 删键（删错了对象），友方的 30% 闪避会**永久留着**（替身结束后还在）——本轮实测的真 bug。
          const want = new Set(allies);
          for (const a of [...dodgeSet]) if (!want.has(a)) { battle.removeBuff(a, dodgeKey); dodgeSet.delete(a); }
          for (const a of allies) if (!dodgeSet.has(a)) { statBuff(battle, a, dodgeKey, { dodgePhys: 0.3, dodgeArts: 0.3 }); dodgeSet.add(a); }
          if (!on) return;
          const heal = num(unit.s && unit.s.atk, 0) * num(s3['attack@heal_scale'], 0.25);
          const wounded = allies.filter((a) => a.hpRatio < 1).sort((a, b) => a.hpRatio - b.hpRatio || a.id - b.id)
            .slice(0, Math.max(0, Math.floor(num(s3['attack@max_target_heal'], 3))));
          for (const a of wounded) battle.heal(unit, a, heal);
        }, { owner: unit });

        // 「塔纳托斯在场时，**开启技能**或**受到致命伤**时改为召唤俄耳甫斯」（官方 S3 备注：P1 ⇒ P2）
        battle.on('skillStart', (ctx) => {
          if (ctx.unit !== unit) return;
          toOrpheusKai();
        }, { owner: unit });
        battle.on('fatal', (ctx) => {
          if (ctx.unit !== unit || ctx.prevented) return;
          // 🔴 S3 的"**第二替身**"：`<塔纳托斯·改>` 期间受致命伤 ⇒ 切 `<俄耳甫斯·改>`（**不是**撤退）。
          //    必须在引擎的替身判定（priority −100，`if (unit.trait.doll) return;` = 替身被击倒即撤退）**之前**跑：
          //    本钩子 −101 ⇒ `ctx.prevented = true` 让引擎整段早退（`damage.js:308` 见 `prevented` 就把生命补到 ≥1）。
          //    ⚠️ 只有 S3 有这条官方条文：`<俄耳甫斯·改>` 再挨致命伤没有第二替身了（`personaIs('thanatos')` 为假 ⇒ 不拦）。
          if (!toOrpheusKai()) return;
          ctx.prevented = true;
          // 官方：「切换动画开始时会清除自身一切Buff」＋「切换途中重设自身生命至最大值」
          for (const b of unit.buffs.slice()) if (b.status) battle.removeBuff(unit, b);
          unit.markDirty();
          unit.hp = unit.s.maxHp;
        }, { owner: unit, priority: -101 });   // 跑在引擎的替身判定之前（引擎用 -100）
      } },
    ],
  };
}

// ⚠️ 导出形态**必须是对象**、键 = `chess_makoto_a`（本仓库所有 KITS 键都带 `_a`）。
//    直接 `export default 工厂函数` ⇒ 接线时 `...展开一个函数` 是**静默无效**的（不报错、也不生效）。
export default {
  chess_makoto_a: makoto,
};
