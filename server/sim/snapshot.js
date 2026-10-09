// server/sim/snapshot.js — compact serialization for clients (DESIGN §8.2).
//
// b.snap  = { fieldId, t, units: [[id, x, y, hp, maxHp, sp, spMax, flags, anim]], dp, killed, total }
//   (hp of a countdown summon — unit.countdown, content/tokens.js startCountdown — is maxHp × the share of its life left)
// UnitInfo = { id, kind, side, ownerId, defId, name, tier, golden, spine, avatar, x, y, facing, dir, maxHp, motion?, boss?, uid?,
//   form?, skillIndex?, moduleId?, items?, standInFor?, diy? }  (standInFor = the replaced operator's charId of a 补位
//   stand-in; diy = a 自选 piece's pick { charId, skillIndex, uniEquipId } — defId is its slot, spine / avatar the operator's;
//   form = the unit's current model form — an enemy's, content/enemies/helpers.js setForm:
//   掠海漂移体 'crawl', 暴鸰 'bombed', 转译基底·α's forms …; a 傀儡师 fighting as its 替身 'doll', professions.js — a view built
//   after the change, a field opened mid-battle, draws it: render/units.js FORMS)
//   dir = 'UP'|'RIGHT'|'DOWN'|'LEFT' (allies: the deploy direction, sim/dir.js); facing = its horizontal sign (±1).
//   items = an ally operator's equipped item ids (absent without any).
// flags bits & anim codes come from shared/constants.js (UF / ANIM); an enemy's stealth bit = its 隐匿 is on (not while it
// is blocked or revealed, nor in the seconds after a block before it hides again — targeting.js enemyStealthed), an
// ally's = 隐匿 / 迷彩 whatever it blocks.

import { UF, ANIM } from '../../shared/constants.js';
import { DIE_ANIM_TIME, ATTACK_ANIM_TIME, DEPLOY_ANIM_TIME } from './constants.js';
import { enemyStealthed } from './targeting.js';

const r2 = (v) => Math.round(v * 100) / 100;
const r1 = (v) => Math.round(v * 10) / 10;

/** Static per-unit info sent on spawn / in m.field. */
export function unitInfo(u) {
  const d = u.def || {};
  return {
    id: u.id,
    kind: u.kind,
    side: u.side,
    ownerId: u.ownerId ?? null,
    defId: u.defId,
    name: u.name,
    tier: d.tier ?? (d.rank === 'BOSS' ? 3 : d.rank === 'ELITE' ? 2 : 1),
    golden: !!d.golden,
    spine: d.spine ?? d.charId ?? u.defId,
    // 干员皮肤 (docs/SKINS.md): `undefined`, not `null` — JSON.stringify drops it, so a battle with no skins produces
    // the exact same bytes as before the feature existed (the DESIGN §8.2 wire-format contract test relies on this).
    // 🔁 2026-10-08（第 54 轮 A）：换基座到 0.2.1 时整段被静默丢掉（0.1.4.1 冷备 `snapshot.js:36`）⇒ 已按冷备份接回。
    skin: u.skin ?? undefined,
    avatar: d.avatar ?? d.charId ?? u.defId,
    x: r2(u.x),
    y: r2(u.y),
    facing: u.facing ?? 1,
    dir: u.dir ?? 'RIGHT',
    maxHp: Math.max(1, Math.round(u.s.maxHp)),
    motion: u.motion === 'FLY' ? 'FLY' : undefined,
    boss: u.isBoss ? true : undefined,
    // the unit's current model form (an enemy's content/enemies/helpers.js setForm, a 傀儡师's 替身 — render/units.js FORMS): a
    // view built mid-battle (fieldMeta — a watched teammate's field, 联防 observers, a reconnect) starts on that clip set
    form: typeof u.form === 'string' ? u.form : undefined,
    uid: u.uid ?? undefined,
    // DESIGN §16: the equipped skill's index (the renderer / audio pick that skill's Spine clip and sound)
    skillIndex: u.side === 'ally' && Number.isInteger(d.skill?.index) ? d.skill.index : undefined,
    // DESIGN §16: an elite ally's equipped module (uniEquipId | 'none'; display only — a teammate's unit in a shared
    // field shows its owner's module in the detail card)
    moduleId: u.side === 'ally' && d.golden && typeof d.loadout?.moduleId === 'string' ? d.loadout.moduleId : undefined,
    // an ally operator's equipped item ids (display: a 变形同构体 wearer counts for the bond it grants — the bond popup's
    // member list and the detail card's bond chips of a teammate's unit)
    items: u.side === 'ally' && u.kind === 'op' && Array.isArray(u.items) && u.items.length ? [...u.items] : undefined,
    // 补位: the replaced operator's charId when the chess fights as its stand-in (spine / avatar are the stand-in's; the
    // detail card composes the stand-in record, shared/standIn.js standInRecord)
    standInFor: u.side === 'ally' && u.kind === 'op' && typeof d.standInFor === 'string' ? d.standInFor : undefined,
    // 自选: the pick of a DIY slot's piece (the detail card composes its record, shared/diy.js diyRecord)
    diy: u.side === 'ally' && u.kind === 'op' && d.diyFor && d.loadout?.diy ? { ...d.loadout.diy } : undefined,
  };
}

/** Status flag bitmask. */
export function flagsOf(u) {
  const f = u.s.flags;
  let bits = 0;
  if (u.side === 'enemy' ? !!u.blockedBy : u.blocking.length > 0) bits |= UF.BLOCKED;
  if (f.stun && !f.freeze && !f.sleep) bits |= UF.STUNNED;
  if (f.freeze) bits |= UF.FROZEN;
  // 隐匿 or 迷彩 (buffs.js camou), shown the see-through way. An ally keeps it while blocking (targeting.js
  // canTargetAlly); an enemy's 隐匿 is off while it is blocked or revealed and until it hides again after a block (PRTS
  // 作战机制 §隐匿 "在被阻挡时开关会被关掉从而失去隐匿，阻挡状态解除后3s开关重新被开启"; targeting.js enemyStealthed): a
  // blocked 逐火 余烬 is drawn solid while the team beats it, and for 3 s after it slips away
  if (u.side === 'enemy' ? (f.stealth && enemyStealthed(u)) || f.camou : f.stealth || f.camou) bits |= UF.STEALTH;
  if (u.skill && u.skill.active && u.skill.kind !== 'passive') bits |= UF.SKILL;
  if (u.s.shield > 0 || u.buffs.some((b) => b.shieldHits > 0)) bits |= UF.SHIELD;
  if (f.invulnerable) bits |= UF.INVULN;
  if (f.cold) bits |= UF.COLD;
  if (f.sleep) bits |= UF.SLEEP;
  if (u.motion === 'FLY') bits |= UF.FLYING;
  return bits;
}

/** Animation code. */
export function animOf(u, t) {
  if (!u.alive) return ANIM.DIE;
  if (u.s.flags.stun) return ANIM.STUN;
  if (t - u.deployedAt < DEPLOY_ANIM_TIME && u.side === 'ally') return ANIM.DEPLOY;
  if (t < (u.skillAnimUntil ?? -1)) return ANIM.SKILL;
  if (t - u.lastAttackAt < ATTACK_ANIM_TIME) return u.skill && u.skill.active && u.skill.kind !== 'passive' ? ANIM.SKILL : ANIM.ATTACK;
  if (u.side === 'enemy' && u.moving && !u.blockedBy) return ANIM.MOVE;
  return ANIM.IDLE;
}

/** Snapshot tuple for one unit. */
export function unitTuple(u, t) {
  const sk = u.skill;
  let spMax = sk && !sk.noSkill ? sk.spCost : 0;
  let sp = sk && !sk.noSkill ? sk.sp : 0;
  if (sk && sk.active && sk.isTimed) {
    // show remaining duration/ammo as a draining bar — ammo out of the activation's real total (base + bullets added:
    // 拉特兰, 逃犯引渡手续, refills; community report #35), so every bullet shortens it
    if (sk.kind === 'ammo') sp = spMax * (sk.ammoLeft / Math.max(1, sk.ammoMax || sk.ammo || 0, sk.ammoLeft));
    else if (Number.isFinite(sk.timeLeft) && sk.duration > 0) {
      if (spMax === 0) spMax = sk.duration;
      sp = spMax * (sk.timeLeft / sk.duration);
    }
  }
  // hp is rounded up (a living unit never shows 0) but never above the rounded max HP. A countdown summon (医疗探机, 海嗣 …:
  // content/tokens.js startCountdown) shows the share of its life left instead — its bar runs down like a timer and it
  // leaves when it is empty (community report of 2026-10-06; its HP itself never moves: 无敌, 禁疗)
  const maxHp = Math.max(1, Math.round(u.s.maxHp));
  const cd = u.alive ? u.countdown : null;
  const left = cd ? Math.max(0, Math.min(1, (cd.until - t) / Math.max(1e-9, cd.until - cd.from))) : 1;
  // 负数生命值（斩业星熊天赋「业火」的「我执」）：kit 把超出生命上限的伤害记在
  // `unit.mem.negHp` / `unit.mem.negHpRatio`（0..1 的占上限比例）里（kits/reserve-hsgma2.js 头部）；
  // 引擎内部 u.hp 仍夹在 ≥0（damage.js 不碰），但**发给客户端的快照用负数表示**，
  // 客户端按 `-hp / maxHp` 画「从左往右生长的暗红条」。不改协议（元组长度与字段位置不变），
  // 也不影响其它单位（`negHp` 不存在或为 0 时整段跳过）。
  // 🔁 **2026-10-07（第 54 轮 A）**：这一段在换基座到上游 0.2.1 时**被静默丢掉**
  //    （树里 `snapshot.js` 的 `negHp` 命中 **0**；`.workbuddy/rollback/tree-cold-20261007-180433/server/sim/snapshot.js:108-116`
  //     与 `.workbuddy/tools/snapshot-neg-hp.mjs` 里的原实现都在）⇒ 已按原实现**接回**，
  //    并把上游新加的 countdown 分支一起保留（`cd` 存在时不吃负血那条路）。
  //    判据 = `test/sim/x1-neghp-snapshot.test.js`（红 → 绿）。
  const negRatio = u.alive && !cd && u.mem && Number.isFinite(u.mem.negHpRatio)
    ? Math.min(1, Math.max(0, u.mem.negHpRatio)) : 0;
  const hp = u.alive
    ? (negRatio > 0 ? -negRatio * maxHp : Math.min(Math.max(1, Math.ceil(cd ? maxHp * left : u.hp)), maxHp))
    : 0;
  return [u.id, r2(u.x), r2(u.y), hp, maxHp, r1(sp), spMax, flagsOf(u), animOf(u, t)];
}

/** Units included in a snapshot: deployed & visible, plus recently dead ones (DIE animation). */
export function snapshotUnits(units, t) {
  const out = [];
  for (const u of units) {
    if (u.hidden) continue;
    if (u.alive && u.deployed) out.push(unitTuple(u, t));
    else if (!u.alive && t - u.deathAt < DIE_ANIM_TIME && u.deathAt > -Infinity) out.push(unitTuple(u, t));
  }
  return out;
}
