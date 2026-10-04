#!/usr/bin/env node
// content-packs.mjs — 干员 / 敌人模板化 + 可加载内容包 (the template & content-pack layer).
//
// WHY. data/chess.json and data/enemies.json are built by the game's own tools/build-data.mjs from the official
// Arknights client tables — a hand-edit is overwritten by the next `npm run build-data`, and the sim's integrity
// checks (`tools/build-data.mjs` → validateAll, `test/data.test.js`) reject a record that merely looks right.
// This tool is the supported way to ADD operators and enemies: author them against the template, keep them in
// `Stronghold-Protocol/content-packs/*.pack.json`, and merge them into data/ with the same invariants enforced.
//
//   node content-packs.mjs list                       show the packs found and what they add
//   node content-packs.mjs check [file…]              validate (no writing) — exits 1 on any error
//   node content-packs.mjs new chess <chessId>        scaffold a pack from the template (干员 + 精锐)
//   node content-packs.mjs new enemy <enemyKey>       scaffold a pack from the template (敌人)
//   node content-packs.mjs apply  [--out <dir>] [--force]     merge into data/ (or --out)
//   node content-packs.mjs revert [--out <dir>]               remove every pack-added record again
//
// The merge is idempotent and reversible: every record it writes carries `"pack": "<pack id>"`, a second `apply`
// changes nothing (same bytes), and `revert` restores the generated file exactly. A record that exists WITHOUT that
// tag belongs to the game (or to a manual edit) and is never overwritten unless --force.
//
// Order matters when you rebuild:  npm run build-data   THEN   node .workbuddy/tools/content-packs.mjs apply
// (build-data regenerates data/*.json from scratch and therefore drops the packs — that is by design, not a bug.)
//
// The authoring contract is documented in 数据解析/模板化/01-干员字段规范.md and 02-敌人字段规范.md, and mirrored as
// JSON Schema in 数据解析/模板化/schema/. Every field this tool refuses to guess is listed there.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, '..', '..');
// The game tree: `<ws>/Stronghold-Protocol` in the workspace layout this tool was written for, or the
// repository root when the tool ships INSIDE the game repo (a fork). Walk up looking for the markers
// rather than assuming a fixed depth — `HERE/../..` lands on `.workbuddy` in the in-repo case.
function findGameTree(start) {
  let d = start;
  for (let i = 0; i < 4; i++) {
    if (fs.existsSync(path.join(d, 'package.json')) && fs.existsSync(path.join(d, 'server', 'index.js'))) return d;
    const nested = path.join(d, 'Stronghold-Protocol');
    if (fs.existsSync(path.join(nested, 'package.json'))) return nested;
    d = path.resolve(d, '..');
  }
  return path.join(WORKSPACE, 'Stronghold-Protocol');
}
const GAME = findGameTree(HERE);
const DATA = path.join(GAME, 'data');
const PACKS = path.join(GAME, 'content-packs');
const TEMPLATES = path.join(WORKSPACE, '数据解析', '模板化', 'templates');

// The 精锐 twin's `stats` is `statsBase + the default 模组's attr` — the game's own composition rule
// (`shared/loadoutRecord.js composeStats`, the same arithmetic `tools/build-data.mjs` uses, asserted for every shipped
// elite by test/data.test.js). Importing it instead of re-implementing keeps one source of truth; a copy that drifts
// would fail that assertion on the next `npm test`.
const { composeStats, composeTalents } = await import(pathToFileURL(path.join(GAME, 'shared', 'loadoutRecord.js')).href).catch(() => ({
  // The game tree may be absent (the tool is also run against a bare checkout); fall back to the same arithmetic.
  composeStats: (base, attr) => {
    const s = { ...(base || {}) };
    for (const [f, v] of Object.entries(attr || {})) s[f] = Math.round(((s[f] || 0) + v) * 1e6) / 1e6;
    return s;
  },
  composeTalents: (base, changes) => {
    const talents = (base || []).map((t) => ({ ...t }));
    for (const ch of changes || []) {
      const { talentIndex, ...rest } = ch;
      const rec = { index: talentIndex, ...rest, fromModule: true };
      const at = talentIndex >= 0 ? talents.findIndex((x) => x.index === talentIndex) : -1;
      if (at >= 0) talents[at] = { ...talents[at], ...rec };
      else talents.push(rec);
    }
    return talents;
  },
}));

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt; };
const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--out');

const ENUMS = {
  profession: ['PIONEER', 'WARRIOR', 'TANK', 'SNIPER', 'CASTER', 'MEDIC', 'SUPPORT', 'SPECIAL'],
  position: ['MELEE', 'RANGED'],
  dmgType: ['phys', 'arts', 'heal'],
  attackKind: ['melee', 'ranged', 'heal', 'none'],
  targetPriority: ['fly', 'lowestDef'],
  projectile: ['arrow', 'bolt', 'orb', 'none'],
  skillType: ['AUTO', 'MANUAL', 'PASSIVE'],
  spType: ['INCREASE_WITH_TIME', 'INCREASE_WHEN_ATTACK', 'INCREASE_WHEN_TAKEN_DAMAGE', 'ON_DEPLOY'],
  durationType: ['NONE', 'AMMO', 'COOLDOWN'],
  rank: ['NORMAL', 'ELITE', 'BOSS'],
  applyWay: ['MELEE', 'RANGED', 'ALL', 'NONE'],
  motion: ['WALK', 'FLY'],
};

/** What the author may omit: the tool fills these so a template stays short (the values are the game's own defaults). */
const DEFAULTS = {
  chess: () => ({
    chessType: 'PRESET', isHidden: false, isDiy: false, visible: true,
    identifier: 9999, shopSortId: 9999, upgradeNum: 0, upgradeChessId: null,
    canHitFly: false, projectile: 'none', targetPriority: null,
    tokens: [], talents: [], garrisonIds: [],
    immunities: { stun: false, silence: false, sleep: false, frozen: false, levitate: false },
    assets: { avatar: null, portrait: null, spine: null, skillIcon: null, subProfIcon: null },
  }),
  enemy: () => ({
    level: 0, handbookIndex: '', desc: '', descRaw: '', notCountInTotal: false, isFlyEnemy: false,
    tokenOnly: false, staticBody: false, tags: [], acTypes: ['SPECIAL'], acType: 'SPECIAL',
    templateSlot: 'N', summons: [], inactiveIn: [], seasonOverride: null, modelScale: 1,
  }),
};

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const isInt = (v) => Number.isInteger(v);

/**
 * Drop the template's own documentation keys. A key starting with `_` is a comment for the author — it is never
 * written into data/, so the templates can explain every field in place without polluting the game data.
 *
 * Recursive: the templates comment nested objects too (`stats._res`, `elite.modules[0]._attr`), and a comment key
 * that leaks in is not harmless — it inflates `stats`, which the game deep-compares against `statsBase + 模组 attr`
 * (`test/data.test.js`) and hands to the sim as a stat field.
 */
function stripComments(v) {
  if (Array.isArray(v)) return v.map(stripComments);
  if (!v || typeof v !== 'object') return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) if (!k.startsWith('_')) out[k] = stripComments(x);
  return out;
}

// ---- validation --------------------------------------------------------------------------------------

/**
 * Validate one pack against the template contract.
 * @returns {{ errors: string[], warnings: string[], pack: any }}
 */
export function validatePack(pack, ctx = {}) {
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);
  const warn = (m) => warnings.push(m);
  const bonds = ctx.bonds || {};
  const garrisons = ctx.garrisons || {};
  const at = (w) => `${pack?.pack || '<pack>'} › ${w}`;

  if (!pack || typeof pack !== 'object' || Array.isArray(pack)) { err('<file>: not a JSON object'); return { errors, warnings, pack }; }
  if (typeof pack.pack !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/i.test(pack.pack)) err('pack: a lowercase id is required ([a-z0-9._-])');
  if (!isInt(pack.version) || pack.version < 1) err('pack.version: an integer ≥ 1 is required');
  if (pack.targetBase != null && typeof pack.targetBase !== 'string') err('pack.targetBase: a version string like "0.1.2"');
  const chessList = pack.chess ?? [];
  const enemyList = pack.enemies ?? [];
  if (!Array.isArray(chessList)) err('pack.chess: must be an array');
  if (!Array.isArray(enemyList)) err('pack.enemies: must be an array');
  if (Array.isArray(chessList) && Array.isArray(enemyList) && !chessList.length && !enemyList.length) err('pack: adds nothing (empty chess[] and enemies[])');

  const seen = new Set();
  for (const [i, c] of (Array.isArray(chessList) ? chessList : []).entries()) {
    const w = `chess[${i}]${c?.chessId ? ` ${c.chessId}` : ''}`;
    if (!c || typeof c !== 'object') { err(at(`${w}: not an object`)); continue; }
    if (typeof c.chessId !== 'string' || !/^chess_[a-z0-9_]+$/i.test(c.chessId)) { err(at(`${w}: chessId must look like chess_<name>_<a|b>`)); continue; }
    if (seen.has(c.chessId)) err(at(`${w}: duplicate chessId`));
    seen.add(c.chessId);
    if (c.isGolden) err(at(`${w}: write the 普通 record and an "elite" block — the tool derives the 精锐 twin`));
    if (typeof c.name !== 'string' || !c.name.trim()) err(at(`${w}.name: required`));
    for (const k of ['profession', 'position', 'dmgType', 'attackKind']) {
      if (!ENUMS[k].includes(c[k])) err(at(`${w}.${k}: '${c[k]}' is not one of ${ENUMS[k].join(' | ')}`));
    }
    for (const k of ['projectile', 'targetPriority']) {
      if (c[k] != null && !ENUMS[k].includes(c[k])) err(at(`${w}.${k}: '${c[k]}' is not one of ${ENUMS[k].join(' | ')}`));
    }
    if (!isInt(c.tier) || c.tier < 1 || c.tier > 6) err(at(`${w}.tier: an integer 1–6`));
    for (const k of ['price', 'sellPrice']) if (!(c[k] == null || (isInt(c[k]) && c[k] >= 0))) err(at(`${w}.${k}: a non-negative integer`));
    // poolCopies = the shop's copy-weighted override for this operator (config.json economy.poolCopiesOverrides). Optional;
    // a large value makes the operator show up (nearly) always — the "出现概率 100%" testing use.
    if (c.poolCopies != null && !(isInt(c.poolCopies) && c.poolCopies >= 0)) err(at(`${w}.poolCopies: a non-negative integer (shop weight override)`));
    if (!Array.isArray(c.bonds)) err(at(`${w}.bonds: required (may be empty)`));
    for (const b of c.bonds || []) if (!bonds[b]) err(at(`${w}.bonds: unknown bond '${b}'`));
    for (const g of c.garrisonIds || []) if (!garrisons[g]) err(at(`${w}.garrisonIds: unknown garrison '${g}'`));
    // stats
    const s = c.stats;
    if (!s || typeof s !== 'object') err(at(`${w}.stats: required`));
    else {
      for (const k of ['maxHp', 'atk', 'def', 'res', 'cost', 'blockCnt', 'bat', 'aspd']) {
        if (!Number.isFinite(s[k])) err(at(`${w}.stats.${k}: required, a finite number`));
      }
      if (Number.isFinite(s.maxHp) && !(s.maxHp > 0)) err(at(`${w}.stats.maxHp: must be > 0`));
      if (Number.isFinite(s.bat) && !(s.bat > 0)) err(at(`${w}.stats.bat: must be > 0 (攻击间隔, 0 would attack every tick)`));
      for (const k of ['def', 'res', 'cost', 'blockCnt', 'aspd', 'respawnTime', 'moveSpeed']) {
        if (s[k] != null && !Number.isFinite(s[k])) err(at(`${w}.stats.${k}: a finite number`));
      }
    }
    // 攻击范围
    if (!Array.isArray(c.rangeGrid) || !c.rangeGrid.length) err(at(`${w}.rangeGrid: required — the 攻击范围 tiles, [[dx,dy], …]`));
    else for (const [j, t] of c.rangeGrid.entries()) {
      if (!Array.isArray(t) || t.length !== 2 || !isInt(t[0]) || !isInt(t[1])) err(at(`${w}.rangeGrid[${j}]: must be [dx, dy] integers`));
    }
    if (c.rangeGridOfSkill != null) warn(at(`${w}.rangeGridOfSkill is not a game field — set the skill's rangeGrid instead`));
    // 技能
    if (!c.skill || typeof c.skill !== 'object') err(at(`${w}.skill: required — the default (S1) skill record`));
    else if (typeof c.skill.skillId !== 'string' || !c.skill.skillId) err(at(`${w}.skill.skillId: required`));
    const skills = c.skills;
    if (skills != null) {
      if (!Array.isArray(skills) || !skills.length) err(at(`${w}.skills: an array with at least the default skill`));
      else {
        const defaults = skills.filter((x) => x && x.isDefault);
        if (defaults.length !== 1) err(at(`${w}.skills: exactly one entry must have isDefault: true (got ${defaults.length})`));
        else if (c.skill && defaults[0].skillId !== c.skill.skillId) err(at(`${w}.skills: the default entry's skillId must equal skill.skillId`));
        const usedIndices = new Set();
        for (const [j, sk] of skills.entries()) {
          if (!sk || typeof sk.skillId !== 'string') { err(at(`${w}.skills[${j}].skillId: required`)); continue; }
          if (sk.index != null && !(isInt(sk.index) && sk.index >= 0)) err(at(`${w}.skills[${j}].index: a non-negative integer (or omit it — the tool numbers them by order)`));
          else {
            const slot = sk.index ?? j;
            if (usedIndices.has(slot)) err(at(`${w}.skills[${j}].index: ${slot} is already taken (a skill's index is its S1/S2/S3 slot)`));
            usedIndices.add(slot);
          }
          if (!ENUMS.skillType.includes(sk.skillType)) err(at(`${w}.skills[${j}].skillType: one of ${ENUMS.skillType.join(' | ')}`));
          if (sk.spType != null && !ENUMS.spType.includes(sk.spType)) err(at(`${w}.skills[${j}].spType: one of ${ENUMS.spType.join(' | ')}`));
          if (sk.spCost != null && !Number.isFinite(sk.spCost)) err(at(`${w}.skills[${j}].spCost: a number`));
          if (sk.bb != null && (typeof sk.bb !== 'object' || Array.isArray(sk.bb))) err(at(`${w}.skills[${j}].bb: an object (the skill's blackboard)`));
        }
      }
    }
    // 特性 / 天赋
    if (c.trait != null && typeof c.trait !== 'object') err(at(`${w}.trait: an object {desc, descRaw, bb, bbStr, rangeGrid}`));
    if (c.talents != null && !Array.isArray(c.talents)) err(at(`${w}.talents: an array`));
    const baseTalentNames = new Set((Array.isArray(c.talents) ? c.talents : []).map((t) => t && t.name));
    // 精锐
    if (c.elite != null) {
      const e = c.elite;
      if (typeof e !== 'object' || Array.isArray(e)) err(at(`${w}.elite: an object of overrides for the 精锐 twin`));
      else {
        for (const k of ['isGolden', 'goldenId', 'baseId', 'statsBase', 'traitBase', 'talentsBase', 'chessId']) {
          if (k in e) err(at(`${w}.elite.${k}: the tool sets this itself — remove it`));
        }
        if (e.stats && typeof e.stats !== 'object') err(at(`${w}.elite.stats: an object`));
        if (e.modules != null && !Array.isArray(e.modules)) err(at(`${w}.elite.modules: an array of 模组 records`));
        // 精锐-only talents do not exist in the game's data model: an elite's talents are ALWAYS
        // composeTalents(普通 talents, 默认模组 talentChanges). Refusing here (instead of emitting a record
        // test/data.test.js rejects with "talents") tells the author where the talent really belongs.
        if (e.talents != null) {
          if (!Array.isArray(e.talents)) err(at(`${w}.elite.talents: an array — but better: use the 默认模组's talentChanges`));
          else for (const [j, t] of e.talents.entries()) {
            if (!baseTalentNames.has(t && t.name)) {
              err(at(`${w}.elite.talents[${j}]: 精锐的天赋只能是「普通天赋 + 默认模组的 talentChanges」，` +
                `不能在这里凭空加一条（游戏会断言 composeTalents(talentsBase, talentChanges) == talents）。` +
                `想给精锐加天赋，就把它写在该模组的 "talentChanges": [{ "talentIndex": -1, "name": …, "desc": …, "descRaw": …, "bb": {…}, "bbStr": {}, "hidden": false }]`));
            }
          }
        }
      }
    } else if (typeof c.goldenId === 'string') err(at(`${w}.goldenId: given without an "elite" block — add the 精锐 overrides or drop goldenId`));
  }

  for (const [i, e] of (Array.isArray(enemyList) ? enemyList : []).entries()) {
    const w = `enemies[${i}]${e?.key ? ` ${e.key}` : ''}`;
    if (!e || typeof e !== 'object') { err(at(`${w}: not an object`)); continue; }
    if (typeof e.key !== 'string' || !/^enemy_[a-z0-9_]+$/i.test(e.key)) { err(at(`${w}.key: must look like enemy_<name>`)); continue; }
    if (seen.has(e.key)) err(at(`${w}: duplicate key`));
    seen.add(e.key);
    if (typeof e.name !== 'string' || !e.name.trim()) err(at(`${w}.name: required`));
    if (!ENUMS.rank.includes(e.rank)) err(at(`${w}.rank: one of ${ENUMS.rank.join(' | ')}`));
    if (!ENUMS.applyWay.includes(e.applyWay)) err(at(`${w}.applyWay: one of ${ENUMS.applyWay.join(' | ')}`));
    const s = e.stats;
    if (!s || typeof s !== 'object') err(at(`${w}.stats: required`));
    else {
      for (const k of ['maxHp', 'atk', 'def', 'res', 'moveSpeed', 'bat', 'aspd', 'rangeRadius']) {
        if (!Number.isFinite(s[k])) err(at(`${w}.stats.${k}: required, a finite number`));
      }
      if (Number.isFinite(s.maxHp) && !(s.maxHp > 0)) err(at(`${w}.stats.maxHp: must be > 0`));
      if (Number.isFinite(s.bat) && !(s.bat > 0)) err(at(`${w}.stats.bat: must be > 0`));
      // the game's own contract (DESIGN §5.5, tools/build-data.mjs): a MELEE enemy has rangeRadius 0, a ranged one > 0
      if (!(s.rangeRadius >= 0)) err(at(`${w}.stats.rangeRadius: must be ≥ 0`));
      else if (e.applyWay === 'MELEE' && s.rangeRadius !== 0) err(at(`${w}: applyWay MELEE requires stats.rangeRadius 0 (got ${s.rangeRadius})`));
      else if (e.applyWay === 'RANGED' && !(s.rangeRadius > 0)) err(at(`${w}: applyWay RANGED requires stats.rangeRadius > 0 (got ${s.rangeRadius})`));
      if (s.dmgType != null && !['phys', 'arts', 'none'].includes(s.dmgType)) err(at(`${w}.stats.dmgType: phys | arts | none`));
      if (s.motion != null && !ENUMS.motion.includes(s.motion)) err(at(`${w}.stats.motion: ${ENUMS.motion.join(' | ')}`));
    }
    if (e.abilities != null) {
      if (!Array.isArray(e.abilities)) err(at(`${w}.abilities: an array of {text, textRaw, format}`));
      else for (const [j, a] of e.abilities.entries()) {
        if (!a || typeof a.text !== 'string') err(at(`${w}.abilities[${j}].text: required (the 敌人特性 line)`));
        if (a && a.format != null && !['NORMAL', 'SILENCE', 'TITLE'].includes(a.format)) err(at(`${w}.abilities[${j}].format: NORMAL | SILENCE | TITLE`));
      }
    }
    if (e.skills != null) {
      if (!Array.isArray(e.skills)) err(at(`${w}.skills: an array of {prefabKey, cooldown, initCooldown, spCost, bb}`));
      else for (const [j, sk] of e.skills.entries()) {
        if (!sk || typeof sk.prefabKey !== 'string') err(at(`${w}.skills[${j}].prefabKey: required (the sim's skill handler key)`));
        if (sk && sk.bb != null && (typeof sk.bb !== 'object' || Array.isArray(sk.bb))) err(at(`${w}.skills[${j}].bb: an object`));
      }
    }
    if (e.sp != null) {
      if (!ENUMS.spType.includes(e.sp.type)) err(at(`${w}.sp.type: one of ${ENUMS.spType.join(' | ')}`));
      if (!Number.isFinite(e.sp.maxSp)) err(at(`${w}.sp.maxSp: a number`));
    }
    if (e.attackAnim != null && (typeof e.attackAnim !== 'object' || !Number.isFinite(e.attackAnim.dur))) err(at(`${w}.attackAnim: {clip, dur, hit} 且 dur 为数`));
  }
  return { errors, warnings, pack };
}

/**
 * The 精锐 twin derived from a 普通 record + the `elite` overrides (mirrors how the official build emits `_b`).
 *
 * Exported, so it has to be safe on a raw author record too — hence the comment strip here rather than only at the
 * call site: `elite.stats` is spread straight into the twin, and a `_`-prefixed comment surviving that path would end
 * up as a real stat field (and break `statsBase + 模组 attr == stats`).
 */
export function deriveElite(rawBase, goldenId) {
  const base = stripComments(rawBase);
  const { elite = {}, goldenId: _g, poolCopies: _pc, ...rest } = base;
  const twin = {
    ...JSON.parse(JSON.stringify(DEFAULTS.chess())), // defaults FIRST so the author's fields (assets included) win
    ...rest,
    ...Object.fromEntries(Object.entries(elite).filter(([k]) => k !== 'stats' && k !== 'modules')),
    chessId: goldenId,
    baseId: base.baseId || base.chessId,
    goldenId,
    isGolden: true,
    upgradeChessId: null,
    upgradeNum: 0,
    status: { ...(base.status || {}), phase: 2, level: 50, skillLevel: 7, equipLevel: 1 },
    // 精锐 keeps the 普通 numbers as its base, so the loadout screen can show 不装备模组
    statsBase: JSON.parse(JSON.stringify(base.stats)),
    traitBase: JSON.parse(JSON.stringify(base.trait || { desc: '', descRaw: '', bb: {}, bbStr: {}, rangeGrid: null })),
    talentsBase: JSON.parse(JSON.stringify(base.talents || [])),
    modules: Array.isArray(elite.modules) ? elite.modules : [],
  };
  // an elite with modules: `module` is the active one (or the inactive placeholder), as the official records have it
  const mods = twin.modules;
  const def = mods.find((m) => m && m.isDefault) || mods[0];
  // an elite with modules: `module` mirrors the default one (the official records' shape); without any, the inactive placeholder
  twin.module = def
    ? { id: def.uniEquipId ?? null, name: def.name ?? null, type: def.typeName ?? null, level: def.level ?? 1, active: true }
    : { id: null, name: null, type: null, level: 1, active: false };
  twin.status.equipLevel = def ? (twin.status.equipLevel ?? 1) : 0;
  // `stats` must stay equal to `statsBase + the default 模组's attr` (test/data.test.js asserts exactly that for every
  // shipped elite). Deriving it here means an author who tilts the 模组's attr no longer silently desyncs the twin; an
  // explicit `elite.stats` still wins, because some equipment changes a stat the 模组 does not restate.
  const composed = composeStats(twin.statsBase, def?.attr);
  twin.stats = elite.stats ? { ...composed, ...JSON.parse(JSON.stringify(elite.stats)) } : composed;
  // Same rule for the other two pieces the loadout screen compares against the base:
  //   trait   = the default 模组's traitOverride ?? traitBase
  //   talents = composeTalents(talentsBase, the default 模组's talentChanges)
  // (`elite.trait` still wins when an author really needs to restate it.) Verified against all 127 generated elites in
  // data/chess.json — the rule holds for every one of them. There is deliberately NO `elite.talents`: a 精锐-only
  // talent is a 模组 talentChange in the official data, and validatePack refuses the override rather than emitting a
  // record the game's own test rejects.
  twin.trait = elite.trait
    ? JSON.parse(JSON.stringify(elite.trait))
    : JSON.parse(JSON.stringify(def?.traitOverride ?? twin.traitBase));
  twin.talents = composeTalents(twin.talentsBase, def?.talentChanges);
  // The 精锐 is at skillLevel 7 while the 普通 sits at 4, and every entry of `skills[]` carries its own
  // `level` (the game asserts `s.level === status.skillLevel`). Normalise the twin's list BEFORE lifting it,
  // then bring the carried level in line with the 精锐's status.
  const norm = normalizeChessProfile(twin);
  const lvl = norm.status?.skillLevel;
  if (Array.isArray(norm.skills)) norm.skills = norm.skills.map((s) => (Number.isFinite(lvl) ? { ...s, level: lvl } : s));
  if (norm.skill && Number.isFinite(lvl)) norm.skill = { ...norm.skill, level: lvl };
  return orderChess(norm, true);
}

/** Put a chess record's keys in the same order the generated file uses, so a diff shows only real changes. */
function orderChess(rec, elite) {
  const head = ['chessId', 'baseId', 'goldenId', 'isGolden', 'tier', 'identifier', 'isHidden', 'isDiy', 'visible', 'chessType', 'shopSortId',
    'charId', 'name', 'appellation', 'rarity', 'profession', 'subProfessionId', 'subProfessionName', 'position', 'nationId',
    'bonds', 'garrisonIds', 'price', 'sellPrice', 'upgradeNum', 'upgradeChessId', 'status'];
  const tail = ['stats', 'statsBase', 'immunities', 'rangeId', 'rangeGrid', 'dmgType', 'attackKind', 'projectile', 'canHitFly', 'targetPriority',
    'trait', 'traitBase', 'skill', 'talents', 'talentsBase', 'tokens', 'module', 'modules', 'assets', 'skills'];
  const out = {};
  for (const k of [...head, ...tail]) if (k in rec && rec[k] !== undefined) out[k] = rec[k];
  else if (k === 'statsBase' || k === 'traitBase' || k === 'talentsBase' || k === 'modules') { /* elite-only */ }
  for (const [k, v] of Object.entries(rec)) if (!(k in out)) out[k] = v;
  return out;
}

function orderEnemy(rec) {
  const head = ['key', 'name', 'level', 'rank', 'handbookIndex', 'desc', 'descRaw', 'applyWay', 'stats', 'abilities', 'talents', 'skills',
    'notCountInTotal', 'tags', 'be', 'beFactor', 'attrPower', 'isFlyEnemy', 'tokenOnly', 'acTypes', 'acType', 'templateSlot', 'summons',
    'inactiveIn', 'seasonOverride', 'iconId', 'spine', 'modelScale', 'attackAnim'];
  const out = {};
  for (const k of head) if (k in rec && rec[k] !== undefined) out[k] = rec[k];
  for (const [k, v] of Object.entries(rec)) if (!(k in out)) out[k] = v;
  return out;
}

// ---- what the tool fills in so a merged record is indistinguishable from a generated one -------------------------

/**
 * Fill the parts of a chess record that are *derivable* and whose absence is a real defect:
 *  · `skills[].index` / `skill.index` — the game selects a skill BY index (`shared/loadoutRecord.js` resolves a
 *    loadout with `x.index === lo.skillIndex`; `public/js/ui/detailPanel.js` prints `S${index + 1}`). Without it a
 *    merged operator has no selectable skill slot at all. Filled from array position unless the author said otherwise,
 *    which is also what makes the array ordered and unique (test/data.test.js asserts both).
 *  · `skills[].iconId` — the skill icon, equal to `skillId` for every generated record.
 *  · `isDefault` — exactly one entry, so the loadout screen has a default.
 *  · `rangeGrid` / `overrideTokenKey` — present-but-null in every generated record (two different "absent").
 *  · `isHidden` / `visible` — an authored operator is recruitable, i.e. the opposite of the hidden rows in data/.
 */
export function normalizeChessProfile(rec) {
  const out = { ...rec };
  if (out.isHidden === undefined) out.isHidden = false;
  if (out.visible === undefined) out.visible = !out.isHidden;
  const list = Array.isArray(out.skills) ? out.skills.map((s) => (s && typeof s === 'object' ? { ...s } : s)) : null;
  if (list && list.length) {
    // The default entry and `skill` are two views of the SAME skill: the game's test asserts
    // `skills.find(isDefault)` minus `isDefault` deep-equals `skill`. So fill both from the same defaults —
    // otherwise the short `skills[]` shape and the full `skill` shape disagree and the merged record is rejected.
    const FIELDS = { iconId: null, level: null, desc: null, descRaw: null, skillType: null, durationType: null, duration: null,
      spType: null, spCost: null, initSp: null, maxChargeTime: 1, increment: 1, bb: {}, bbStr: {}, rangeId: null,
      rangeGrid: null, prefabId: null, trigger: { rule: 'DEFAULT' }, overrideTokenKey: null };
    let defIdx = list.findIndex((s) => s && s.isDefault);
    if (defIdx < 0) { defIdx = 0; list[0].isDefault = true; }
    for (const [i, s] of list.entries()) {
      for (const [k, v] of Object.entries(FIELDS)) if (s[k] === undefined) s[k] = JSON.parse(JSON.stringify(v));
      if (s.iconId === null) s.iconId = s.skillId;
      if (s.prefabId === null) s.prefabId = s.skillId;
      if (s.index === undefined) s.index = i;
      if (s.isDefault === undefined) s.isDefault = false;
    }
    out.skills = list;
    if (out.skill && typeof out.skill === 'object') {
      const s = { ...out.skill };
      for (const [k, v] of Object.entries(FIELDS)) if (s[k] === undefined) s[k] = JSON.parse(JSON.stringify(v));
      if (s.iconId === null) s.iconId = s.skillId;
      if (s.prefabId === null) s.prefabId = s.skillId;
      if (s.index === undefined) s.index = list[defIdx].index;
      out.skill = s;
    }
  }
  // talents carry an index too (it is what a 模组 talentChange addresses); fill it from array position like skills.
  if (Array.isArray(out.talents)) {
    out.talents = out.talents.map((t, i) => (t && typeof t === 'object' && t.index === undefined ? { ...t, index: i } : t));
  }
  return out;
}

/**
 * Keep `data/bonds.json`'s member lists in step with the chess records.
 *
 * The game checks this both ways (`test/data.test.js`): every `bond.members` entry must be an existing non-精锐 chess
 * that lists the bond back, and every 普通 chess's `bonds` must appear in that bond's `members`. `visibleMembers` is
 * the same list minus the hidden rows. Adding an operator to a 盟约 therefore has to touch bonds.json — "just write
 * `bonds: [...]`" leaves the two views disagreeing and the game's own test fails.
 *
 * Deliberately incremental (add on apply / remove on revert) rather than a full rebuild: a rebuild would silently
 * overwrite a hand-edited members list. `bondMemberIssues` reports drift instead of "fixing" it.
 *
 * @returns {boolean} whether bonds.json changed
 */
function syncBondMembers(dir, chess, { add = [], remove = [] } = {}) {
  const bondsPath = path.join(dir, 'bonds.json');
  if (!fs.existsSync(bondsPath)) return false;
  const bonds = readJson(bondsPath);
  const visible = (id) => Boolean(chess[id]) && chess[id].isHidden !== true && chess[id].visible !== false;
  for (const b of Object.values(bonds)) {
    if (!Array.isArray(b.members)) continue;
    if (remove.length) {
      const drop = new Set(remove);
      b.members = b.members.filter((m) => !drop.has(m));
      if (Array.isArray(b.visibleMembers)) b.visibleMembers = b.visibleMembers.filter((m) => !drop.has(m));
    }
    for (const id of add) {
      if (!chess[id] || chess[id].isGolden) continue;
      if (!(chess[id].bonds || []).includes(b.bondId)) continue;
      if (!b.members.includes(id)) b.members.push(id);
      if (Array.isArray(b.visibleMembers) && visible(id) && !b.visibleMembers.includes(id)) b.visibleMembers.push(id);
    }
  }
  const next = JSON.stringify(bonds);
  if (fs.readFileSync(bondsPath, 'utf8') === next) return false;
  fs.writeFileSync(bondsPath, next);
  return true;
}

/**
 * Keep `data/config.json`'s `economy.poolCopiesOverrides` in step with the chess records that declare a shop weight.
 *
 * The shop rolls copy-weighted over the shared pool (server/match/pool.js), so an author who wants a new operator to
 * show up (nearly) always — the "出现概率 100%" testing use — declares `"poolCopies": N` on the 普通 record and the tool
 * writes it here; `revert` removes exactly those overrides (other overrides such as the shipped 缪尔赛思 one survive).
 * A record without `poolCopies` keeps the tier default.
 *
 * @returns {boolean} whether config.json changed
 */
function syncPoolCopies(dir, { add = [], remove = [] } = {}) {
  const configPath = path.join(dir, 'config.json');
  if (!fs.existsSync(configPath)) return false;
  const config = readJson(configPath);
  const eco = config.economy ?? (config.economy = {});
  const ov = eco.poolCopiesOverrides ?? (eco.poolCopiesOverrides = {});
  for (const id of remove) if (ov[id] != null) delete ov[id];
  for (const [id, n] of add) if (Number.isInteger(n) && n >= 0) ov[id] = n;
  const next = JSON.stringify(config);
  if (fs.readFileSync(configPath, 'utf8') === next) return false;
  fs.writeFileSync(configPath, next);
  return true;
}

/**
 * Keep `data/assets.json`'s `chars` in step with a pack's `spine` block (charId → battle-spine entry).
 *
 * An author who wants a new operator to draw its own battle model declares a top-level `spine` block whose
 * entries mirror `data/assets.json` `chars[id]` (skel/atlas/textures/anims/animations/hits/bounds, …). The
 * model FILES (skel/atlas/webp) ship in `public/assets/spine/op/<charId>/…` and are always present; this only
 * toggles the manifest entry. Apply writes `{ ...entry, pack }`; revert removes every `chars[id].pack` entry.
 *
 * @returns {boolean} whether assets.json changed
 */
function syncSpine(dir, packs, { revert = false } = {}) {
  const assetsPath = path.join(dir, 'assets.json');
  if (!fs.existsSync(assetsPath)) return false;
  const assets = readJson(assetsPath);
  const chars = assets.chars ?? (assets.chars = {});
  if (revert) {
    for (const id of Object.keys(chars)) if (chars[id] && chars[id].pack) delete chars[id];
  } else {
    for (const p of packs) {
      for (const [id, entry] of Object.entries(p.spine || {})) {
        if (!entry || typeof entry !== 'object') continue;
        // never overwrite a shipped model; a pack may only add a charId it already owns
        if (chars[id] && !chars[id].pack) continue;
        chars[id] = { ...entry, pack: p.pack };
      }
    }
  }
  const next = JSON.stringify(assets);
  const before = fs.readFileSync(assetsPath, 'utf8');
  // preserve the generator's trailing newline (fetch-assets.mjs writes one; byte-for-byte revert depends on it)
  const out = next + (before.endsWith('\n') ? '\n' : '');
  if (before === out) return false;
  fs.writeFileSync(assetsPath, out);
  return true;
}

/** Report (never silently fix) bond membership that disagrees with the chess records. */
function bondMemberIssues(dir, chess) {
  const bondsPath = path.join(dir, 'bonds.json');
  if (!fs.existsSync(bondsPath)) return [];
  let bonds;
  try { bonds = readJson(bondsPath); } catch { return []; }
  const issues = [];
  for (const b of Object.values(bonds)) {
    if (!Array.isArray(b.members)) continue;
    for (const m of b.members) {
      if (!chess[m]) issues.push(`${b.bondId}: members 里的 ${m} 不在 chess.json`);
      else if (chess[m].isGolden) issues.push(`${b.bondId}: members 里的 ${m} 是精锐（成员表只放普通）`);
      else if (!(chess[m].bonds || []).includes(b.bondId)) issues.push(`${b.bondId}: members 里的 ${m} 没写这条盟约`);
    }
    for (const c of Object.values(chess)) {
      if (c.isGolden || !(c.bonds || []).includes(b.bondId)) continue;
      if (!b.members.includes(c.chessId)) issues.push(`${c.chessId} 写了 ${b.bondId}，但 ${b.bondId}.members 里没有它`);
    }
  }
  return [...new Set(issues)];
}

// ---- pack loading ------------------------------------------------------------------------------------

/** Every `*.pack.json` (or `*.json`) of a pack directory, sorted — deterministic merge order. */
function packFiles(dir = PACKS) {
  if (!fs.existsSync(dir)) return [];
  const st = fs.statSync(dir);
  if (st.isFile()) return [dir];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(dir, f));
}
const pick = (dir) => (dir === DATA ? DATA : path.resolve(dir));

function contextOf(dir) {
  const read = (n) => { try { return readJson(path.join(dir, `${n}.json`)); } catch { return {}; } };
  return { bonds: read('bonds'), garrisons: read('garrisons'), tokens: read('tokens') };
}

// ---- commands ----------------------------------------------------------------------------------------

function cmdList() {
  const files = packFiles(path.resolve(opt('--from', PACKS)));
  const drift = reportBondDrift(DATA);
  if (!files.length) { console.log(`  没有内容包。目录：${PACKS}\n  用 \`new chess <id>\` / \`new enemy <key>\` 生成一个。`); return drift ? 1 : 0; }
  const ctx = contextOf(DATA);
  console.log(`  内容包目录：${PACKS}\n`);
  for (const f of files) {
    let pack; try { pack = readJson(f); } catch (e) { console.log(`  ✗ ${path.basename(f)} — JSON 解析失败：${e.message}`); continue; }
    const { errors, pack: p } = validatePack(pack, ctx);
    const n = (p?.chess?.length || 0) + (p?.enemies?.length || 0);
    const mark = errors.length ? '✗' : '✓';
    console.log(`  ${mark} ${path.basename(f)}  [${p?.pack || '?'} v${p?.version ?? '?'}]  ${p?.chess?.length || 0} 干员 + ${p?.enemies?.length || 0} 敌人`);
    if (p?.note) console.log(`      ${p.note}`);
    for (const e of errors) console.log(`      ✗ ${e}`);
    void n;
  }
  return drift ? 1 : 0;
}

function cmdCheck(files) {
  const ctx = contextOf(DATA);
  // A directory argument means "every pack in it" — the same expansion `apply --from` does (passing a directory
  // used to reach JSON.parse and fail with a confusing EISDIR).
  const list = (files.length ? files.flatMap((f) => (fs.existsSync(f) && fs.statSync(f).isDirectory() ? packFiles(f) : [f])) : packFiles());
  const drift = reportBondDrift(DATA);
  if (!list.length) { console.log('  没有可校验的文件。'); return drift ? 1 : 0; }
  let bad = 0;
  for (const f of list) {
    let pack;
    try { pack = readJson(f); } catch (e) { console.log(`  ✗ ${f}: JSON 解析失败 ${e.message}`); bad += 1; continue; }
    const { errors, warnings } = validatePack(pack, ctx);
    const label = path.relative(WORKSPACE, f);
    if (errors.length) { bad += 1; console.log(`  ✗ ${label}`); for (const e of errors) console.log(`      ${e}`); }
    else console.log(`  ✓ ${label}  ${pack.chess?.length || 0} 干员 + ${pack.enemies?.length || 0} 敌人`);
    for (const w of warnings) console.log(`      ! ${w}`);
  }
  console.log(bad ? `\n  ${bad} 个文件校验失败。` : '\n  全部通过。');
  return bad || drift ? 1 : 0;
}

/** Report 盟约 membership that disagrees with the chess records (a check, never a silent repair). */
function reportBondDrift(dir) {
  const chessPath = path.join(dir, 'chess.json');
  if (!fs.existsSync(chessPath)) return false;
  const issues = bondMemberIssues(dir, readJson(chessPath));
  if (!issues.length) return false;
  console.log(`\n  ⚠ 盟约成员表与干员记录不一致（${issues.length} 条）—— npm run build-data 可重建对齐：`);
  for (const i of issues.slice(0, 8)) console.log(`      · ${i}`);
  if (issues.length > 8) console.log(`      … 其余 ${issues.length - 8} 条`);
  return true;
}

function cmdNew(kind, id) {
  if (!id) { console.log('  用法：new chess <chessId> | new enemy <enemyKey>'); return 2; }
  const tplName = kind === 'chess' ? '新干员.template.json' : kind === 'enemy' ? '新敌人.template.json' : null;
  if (!tplName) { console.log(`  未知类型 '${kind}'（chess | enemy）`); return 2; }
  const tplPath = path.join(TEMPLATES, tplName);
  if (!fs.existsSync(tplPath)) { console.log(`  找不到模板：${tplPath}`); return 2; }
  if (kind === 'chess' && !/^chess_[a-z0-9_]+_a$/i.test(id)) {
    console.log(`  ⚠ 干员 id 建议写成 chess_<名字>_a（普通），精锐 _b 由工具派生 —— 现在给的是 '${id}'`);
  }
  if (kind === 'enemy' && !/^enemy_[a-z0-9_]+$/i.test(id)) console.log(`  ⚠ 敌人 id 建议写成 enemy_<名字> —— 现在给的是 '${id}'`);
  const short = id.replace(/^chess_/i, '').replace(/_a$/i, '');
  const text = fs.readFileSync(tplPath, 'utf8').split('__SHORT__').join(short).split('__ID__').join(id);
  fs.mkdirSync(PACKS, { recursive: true });
  const out = path.join(PACKS, `draft-${id}.pack.json`);
  if (fs.existsSync(out)) { console.log(`  已存在，未覆盖：${out}`); return 1; }
  fs.writeFileSync(out, text);
  console.log(`  已生成：${out}\n  填好字段后运行：node .workbuddy/tools/content-packs.mjs check`);
  return 0;
}

/**
 * Merge validated packs into a data directory (exported so a test can drive it into a temp dir).
 * @param {{ out: string, packs: any[], ctx?: any, force?: boolean }} o
 * @returns {{ chess: string[], enemies: string[], untagged: string[], written: boolean }}
 */
export function applyPacks({ out, packs, ctx = {}, force = false }) {
  const dir = out;
  const chessPath = path.join(dir, 'chess.json');
  const enemyPath = path.join(dir, 'enemies.json');
  const chess = readJson(chessPath);
  const enemies = readJson(enemyPath);
  const added = { chess: [], enemies: [], untagged: [], written: false };
  void ctx;
  const bondAdd = [];
  const poolAdd = [];

  for (const pack of packs) {
    for (const raw of pack.chess || []) {
      const rec = normalizeChessProfile(stripComments(raw));
      const id = rec.chessId;
      const existing = chess[id];
      if (existing && existing.pack !== pack.pack && !force) { added.untagged.push(`chess ${id}（已存在，不属于任何内容包；需要 --force 才覆盖）`); continue; }
      const clean = { ...JSON.parse(JSON.stringify(DEFAULTS.chess())), ...rec };
      delete clean.elite;
      delete clean.poolCopies; // a config.json economy.poolCopiesOverrides entry, not a chess field (syncPoolCopies handles it)
      clean.chessId = id;
      clean.baseId = clean.baseId || id;
      clean.pack = pack.pack;
      // a 普通 record is normal by definition — say so, rather than relying on the key happening to be present:
      // test/data.test.js looks the base of every 精锐 up and asserts `isGolden === false`.
      clean.isGolden = false;
      // the 精锐 twin (derived, never authored twice)
      const goldenId = rec.elite || rec.goldenId ? (rec.goldenId || (id.endsWith('_a') ? `${id.slice(0, -1)}b` : `${id}_b`)) : null;
      clean.goldenId = goldenId;
      if (goldenId) {
        const twin = deriveElite(normalizeChessProfile(raw), goldenId);
        twin.pack = pack.pack;
        if (chess[goldenId] && chess[goldenId].pack !== pack.pack && !force) added.untagged.push(`chess ${goldenId}（精锐，已存在）`);
        else { chess[goldenId] = twin; added.chess.push(goldenId); }
      }
      clean.status = clean.status || { phase: 1, level: 55, skillLevel: 4, equipLevel: 0 };
      chess[id] = orderChess(clean, false);
      added.chess.push(id);
      bondAdd.push(id);
      // an author who wants this operator to (nearly) always show up declares `poolCopies` — the shop's copy-weighted
      // roll then favours it heavily; the value lands in config.json `economy.poolCopiesOverrides` (revert removes it).
      if (Number.isInteger(rec.poolCopies) && rec.poolCopies >= 0) poolAdd.push([id, rec.poolCopies]);
    }
    for (const raw of pack.enemies || []) {
      const rec = stripComments(raw);
      const key = rec.key;
      const existing = enemies[key];
      if (existing && existing.pack !== pack.pack && !force) { added.untagged.push(`enemy ${key}（已存在，不属于任何内容包）`); continue; }
      const clean = orderEnemy({ ...JSON.parse(JSON.stringify(DEFAULTS.enemy())), ...rec, pack: pack.pack });
      clean.key = key;
      clean.iconId = clean.iconId || key;
      clean.spine = clean.spine || key;
      enemies[key] = clean;
      added.enemies.push(key);
    }
  }

  const beforeChess = fs.readFileSync(chessPath, 'utf8');
  const beforeEnemy = fs.readFileSync(enemyPath, 'utf8');
  const afterChess = JSON.stringify(chess);
  const afterEnemy = JSON.stringify(enemies);
  // A new operator also changes its 盟约's member list — otherwise data/bonds.json and the chess records disagree
  // (test/data.test.js checks the relationship both ways). Resolve it after every record of the run is in `chess`.
  const bondsChanged = syncBondMembers(dir, chess, { add: [...new Set(bondAdd)] });
  const poolChanged = syncPoolCopies(dir, { add: poolAdd });
  const spineChanged = syncSpine(dir, packs);
  if (beforeChess === afterChess && beforeEnemy === afterEnemy && !bondsChanged && !poolChanged && !spineChanged) return added;
  if (beforeChess !== afterChess) fs.writeFileSync(chessPath, afterChess);
  if (beforeEnemy !== afterEnemy) fs.writeFileSync(enemyPath, afterEnemy);
  added.written = true;
  return added;
}

/**
 * The exact inverse of `applyPacks`: drop every record a pack added (they all carry `"pack"`), and take those ids out
 * of the 盟约 member lists again. Idempotent — reverting twice is a no-op. Exported so the guard test can prove the
 * round trip restores the generated files byte for byte instead of hand-rolling the deletion.
 *
 * @returns {{ chess: number, enemies: number, bonds: boolean, written: boolean }}
 */
export function revertPacks({ out }) {
  const dir = out;
  const chessPath = path.join(dir, 'chess.json');
  const enemyPath = path.join(dir, 'enemies.json');
  const result = { chess: 0, enemies: 0, bonds: false, written: false };
  if (!fs.existsSync(chessPath) || !fs.existsSync(enemyPath)) return result;
  const beforeChess = fs.readFileSync(chessPath, 'utf8');
  const beforeEnemy = fs.readFileSync(enemyPath, 'utf8');
  const chess = JSON.parse(beforeChess);
  const enemies = JSON.parse(beforeEnemy);
  const removedChess = [];
  for (const k of Object.keys(chess)) if (chess[k] && chess[k].pack) { delete chess[k]; removedChess.push(k); result.chess += 1; }
  for (const k of Object.keys(enemies)) if (enemies[k] && enemies[k].pack) { delete enemies[k]; result.enemies += 1; }
  const afterChess = JSON.stringify(chess);
  const afterEnemy = JSON.stringify(enemies);
  // remove BEFORE writing chess.json, so the member lists are computed from the pre-delete view that still has bonds
  result.bonds = syncBondMembers(dir, chess, { remove: removedChess });
  const poolChanged = syncPoolCopies(dir, { remove: removedChess });
  const spineChanged = syncSpine(dir, null, { revert: true });
  if (beforeChess !== afterChess) fs.writeFileSync(chessPath, afterChess);
  if (beforeEnemy !== afterEnemy) fs.writeFileSync(enemyPath, afterEnemy);
  result.written = beforeChess !== afterChess || beforeEnemy !== afterEnemy || result.bonds || poolChanged || spineChanged;
  return result;
}

function cmdApply() {
  const dir = pick(opt('--out', DATA));
  const force = flag('--force');
  const from = opt('--from', PACKS);
  const ctx = contextOf(DATA);
  const files = packFiles(path.resolve(from));
  if (!files.length) { console.log(`  没有内容包（${from}），什么都没做。`); return 0; }

  const packs = [];
  let bad = 0;
  for (const f of files) {
    let pack; try { pack = readJson(f); } catch (e) { console.log(`  ✗ ${f}: ${e.message}`); bad += 1; continue; }
    const { errors } = validatePack(pack, ctx);
    if (errors.length) { bad += 1; console.log(`  ✗ ${path.relative(WORKSPACE, f)}`); for (const e of errors) console.log(`      ${e}`); }
    else packs.push(pack);
  }
  if (bad) { console.log(`\n  ${bad} 个内容包校验失败，未写入任何数据。`); return 1; }
  if (!packs.length) { console.log('  没有可用的内容包。'); return 0; }

  if (!fs.existsSync(path.join(dir, 'chess.json')) || !fs.existsSync(path.join(dir, 'enemies.json'))) {
    console.log(`  ${dir} 里缺少 chess.json / enemies.json —— 先跑 npm run build-data。`);
    return 1;
  }
  const added = applyPacks({ out: dir, packs, ctx, force });
  // a record the merge refused changes nothing about it — report instead of silently shipping a half pack
  if (added.untagged.length) { console.log('  以下条目未写入：'); for (const u of added.untagged) console.log(`      · ${u}`); }
  if (!added.written) { console.log('  已是最新（内容包已合并）。'); return 0; }
  console.log(`  已写入 ${dir}`);
  console.log(`      干员 +${added.chess.length}（含精锐）：${added.chess.join(', ') || '—'}`);
  console.log(`      敌人 +${added.enemies.length}：${added.enemies.join(', ') || '—'}`);
  if (dir === DATA && added.chess.length) {
    console.log('\n  ⚠ test/data.test.js 断言可见干员数（112）与总数（266）—— 加了可见干员后要同步这两个数字。');
  }
  // Report (do not silently repair)盟约 membership that disagrees with the chess records.
  const bondDrift = bondMemberIssues(dir, readJson(path.join(dir, 'chess.json')));
  if (bondDrift.length) {
    console.log(`\n  ⚠ 盟约成员表与干员记录不一致（${bondDrift.length} 条），用 npm run build-data 重建数据层可以对齐：`);
    for (const b of bondDrift.slice(0, 8)) console.log(`      · ${b}`);
    if (bondDrift.length > 8) console.log(`      … 其余 ${bondDrift.length - 8} 条`);
  }
  return 0;
}

function cmdRevert() {
  const dir = pick(opt('--out', DATA));
  if (!fs.existsSync(path.join(dir, 'chess.json')) || !fs.existsSync(path.join(dir, 'enemies.json'))) {
    console.log(`  ${dir} 里缺少 chess.json / enemies.json。`);
    return 1;
  }
  const result = revertPacks({ out: dir });
  if (!result.written) { console.log(`  没有内容包条目（${dir}）。`); return 0; }
  console.log(`  已移除 ${result.chess} 个干员条目、${result.enemies} 个敌人条目（${dir}）${result.bonds ? '，并从盟约成员表里摘掉' : ''}。`);
  return 0;
}

// ---- main --------------------------------------------------------------------------------------------

function main() {
  const cmd = positional[0] || 'list';
  if (cmd === 'list') return cmdList();
  if (cmd === 'check') return cmdCheck(positional.slice(1).map((f) => path.resolve(f)));
  if (cmd === 'new') return cmdNew(positional[1], positional[2]);
  if (cmd === 'apply') return cmdApply();
  if (cmd === 'revert') return cmdRevert();
  console.log('  用法：content-packs.mjs [list | check [file…] | new chess|enemy <id> | apply [--out dir] [--force] | revert [--out dir]]');
  return 2;
}

export { DEFAULTS, ENUMS, orderChess, orderEnemy, packFiles, bondMemberIssues };
// Only run when invoked directly (the test imports validatePack / deriveElite).
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exit(main());
}
