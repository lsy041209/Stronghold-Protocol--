// Builds the asset plan: which files the game needs, where they come from and
// where they go, as a *manifest template* that mirrors data/assets.json.
//
// Template leaves:
//   { alts: [{ rel, urls[], kind, bytes? }, …] }  one file; the first alternative
//        that ends up on disk wins (later alts are fallbacks: other URLs for the
//        same file, or other sounds of the same bank);
//   { model: '<key>' }  a Spine model (skel + atlas + page PNGs) from plan.models;
//   literal(value)  a value emitted as it is (no files: enemies[id] / tokens[id].spineLocal).
// Inputs are the research JSONs (docs/research/03, 05, 07, 08), the official
// audio_data.json and Ark-Models' models_data.json.
//
// Scope (research 07 §1, DESIGN §0): all 138 pool charIds (incl. backup
// operators), the 自选 owned-6★ picks of data/backups.json (`extraOperators`:
// research 07 does not list them — their URLs follow its patterns) and their
// summons, the module type icons of every module the data offers
// (`moduleTypes`), the 20 pool tokens, every enemy that can appear in an
// act2autochess match (07 enemy list ∪ act1autochess wave/boss levels used by
// act2 modes ∪ bosses ∪ their summons ∪ enemy units spawned by operator kits),
// the 23 bonds, 59 shop items, 40 bands,
// default-skill icons, profession icons, autochess UI sprites (the 36 battle
// emotes and the 19 玩法说明 pages included: UI_EXTRAS), BGM and SFX.

import { RAW, joinUrl, safeName, urlBase, urlDir } from './sources.mjs';
import { kindOf } from './formats.mjs';
import { pickUnitSfx, UI_SFX, BATTLE_SFX, resolveSpec } from './audio.mjs';
import { literal } from './manifest.mjs';
import { EMOTE_CATALOG } from '../../shared/constants.js';

/**
 * Enemies whose Spine no community dump carries: the web model is another enemy's (research 07 §5.6). Their official
 * models come from the local client only (tools/local-extract ENEMY_SPINES): `localEnemySpines` adds them as the
 * optional `spineLocal` overlay, which the client draws when data/local-assets.json lists its files (user feedback
 * after 0.1.0, D3: 灼热源石虫 / 炽焰源石虫 were drawn as the plain 源石虫 everywhere).
 *
 * Why no dump carries them: isHarryh/Ark-Models *indexes* `1305_mhslim` / `1305_mhslim_2` but with an EMPTY
 * `assetList` — registered, never uploaded — so `arkModel()` returns nothing for them and the alias chain below falls
 * back to `enemy_1007_slime`: a different enemy rather than a variant of it, which is why the renderer tints it
 * (render/units.js ALIAS_TINT). The *mobile* build does ship their own model
 * (`enemy_spine/<enemyId>/<enemyId>.{skel,atlas,png}`), but the only public mirror of that build is a community wiki,
 * not a GitHub dump, so downloading from it would add a source the project deliberately does not use (docs/ASSETS.md
 * "Enemy aliases"). The tinted alias therefore stays the web model until a GitHub dump carries these two.
 */
export const ENEMY_SPINE_ALIAS = Object.freeze({
  enemy_1305_mhslim: 'enemy_1007_slime',
  enemy_1305_mhslim_2: 'enemy_1007_slime',
});

/** Loading illustrations referenced by act2autochess modeDataDict (non-training). */
const LOADING_USED = new Set(['loading_ac_core', 'loading_ac_prototype', 'loading_ac_hard', 'loading_ac_abyss']);

const PROFESSIONS = ['caster', 'medic', 'pioneer', 'sniper', 'special', 'support', 'tank', 'warrior'];

/**
 * The 19 official 玩法说明 (tutorial) pages, in the reading order of public/js/ui/guide.js GUIDE_CHAPTERS (a test keeps
 * the two identical): 基础规则 home 1–9, 调度手册 shop 1–6, 进阶图鉴 handbook 1–4.
 */
export const GUIDE_PAGES = Object.freeze([
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => `autochess_home_${i}`),
  ...[1, 2, 3, 4, 5, 6].map((i) => `autochess_shop_${i}`),
  ...[1, 2, 3, 4].map((i) => `autochess_handbook_${i}`),
]);

/**
 * Extra UI sprites (not in 07-assets.json groups): [group, key, path under ArknightsAssets2 cn assets/dyn].
 * The last two blocks are art that used to come from the local client only (tools/local-extract, DESIGN §13) and that
 * the mirror carries too (GitHub issue #42: a server without the client showed default emote icons): the 36 battle
 * emotes (shared/constants.js EMOTE_CATALOG; the bundle ui/emoticon/theme/[uc]<themeId>.ab → its icon/<picId>.png) and
 * the 19 玩法说明 pages (arts/guidebookpages/[pack]autochess.ab, 1024² like the local copies: displayed at 16:9). Their
 * manifest keys are the data/local-assets.json group and name — ui['emoticon/<dir>/<picId>'], ui['guide/<key>'] — so
 * the client looks both up by the same names (public/js/data.js artUrls: the local file first, then this copy).
 */
export const UI_EXTRAS = (() => {
  const L = [];
  const mc = 'ui/autochess/[uc]autochessouter/modechoice/auto_chess_mode_choice_state/';
  for (const m of ['normal', 'hard', 'abyss', 'funny']) L.push(['modeChoice', `${m}_rhodes_island`, `${mc}${m}_rhodes_island.png`]);
  const br = 'ui/autochess/[uc]autochessouter/battleready/auto_chess_battle_ready_state/';
  for (const k of ['bg_mountain1', 'bg_mountain2', 'bg_terrain', 'bg_ring', 'rhodes', 'rhodes_white', 'rhodes_outline']) L.push(['battleReady', k, `${br}${k}.png`]);
  const bn = 'arts/ui/[uc]battlecommon/ui_battle_new/';
  for (const k of ['btn_speed_1x', 'btn_speed_2x', 'btn_pause', 'slider_hp_back', 'slider_hp_fill', 'attack_range_attack', 'attack_range_stand']) L.push(['battleUi', k, `${bn}${k}.png`]);
  L.push(['battleUi', 'boss_avatar_bg', `${bn}enemybossinfo/sprite_enemy_boss_avatar_bg.png`]);
  L.push(['battleUi', 'skill_ready', 'arts/ui/[uc]battlecommon/ui_battle/sprite_skill_ready.png']);
  L.push(['skillIcon', 'empty', 'arts/ui/[uc]charcommon/skills/empty_skill.png']);
  L.push(['skillIcon', 'empty_large', 'arts/ui/[uc]charcommon/skills/empty_skill_large.png']);
  L.push(['entry', 'season_logo_settle', 'activity/[uc]act2autochess/arts/seasonlogo/season_logo_settle_game.png']);
  const ec = 'ui/autochess/[uc]autochessbattle/effectchoose/';
  for (const k of ['bg_circle', 'bg_grad', 'bottom', 'deco_glow_top', 'plus', 'square_1', 'square_2', 'square_fill_1', 'square_fill_2', 'tip_glow', 'tip_wait', 'title']) {
    L.push(['effectChoose', k, `${ec}autochess_battle_effect_choose_panel/${k}.png`]);
  }
  for (const k of ['bg_normal', 'bg_selected', 'btn_bg', 'btn_icon', 'select_frame', 'select_glow']) L.push(['effectChoose', `card_${k}`, `${ec}card_small_item/${k}.png`]);
  for (const k of ['head_bg', 'head_outline']) L.push(['effectChoose', `avatar_${k}`, `${ec}card_avatar_item/${k}.png`]);
  const er = 'ui/autochess/[uc]autochessbattle/equipreplace/equip_replace_dialog/equip_replace_';
  for (const k of ['bg', 'arrow_head', 'arrow_line', 'avatart_bg', 'avatart_frame', 'close', 'replace_icon', 'opiton_bg']) L.push(['equipReplace', k, `${er}${k}.png`]);
  const bd = 'ui/autochess/[uc]autochessbattle/hud/dialog/autochess_hud_bond_detail_dialog/';
  for (const k of ['active_icon', 'active_stack_bg', 'arrow', 'detail_bg', 'matte_circle', 'title_char_icon']) L.push(['bondDetail', k, `${bd}${k}.png`]);
  const pr = 'ui/autochess/[uc]autochessbattle/prepready/';
  for (const k of ['cancel_bg', 'cancel_icon', 'player_bg', 'player_frame', 'player_ready', 'ready_bg', 'ready_frame', 'ready_icon']) L.push(['prepReady', k, `${pr}panel_prep_ready/${k}.png`]);
  L.push(['prepReady', 'countdown_arrow', `${pr}countdown_arrow.png`]);
  const si = 'ui/autochess/[uc]autochessouter/stageinfo/auto_chess_stage_info_state/';
  for (const k of ['img_title_mode_abyss', 'img_title_mode_funny', 'img_title_mode_hard', 'img_title_mode_normal', 'btn_confirm', 'btn_confirmed']) L.push(['stageInfo', k, `${si}${k}.png`]);
  for (const e of EMOTE_CATALOG) L.push([`emoticon/${e.dir}`, e.picId, `ui/emoticon/theme/[uc]${e.themeId}/icon/${e.picId}.png`]);
  for (const k of GUIDE_PAGES) L.push(['guide', k, `arts/guidebookpages/[pack]autochess/${k}.png`]);
  return Object.freeze(L.map((x) => Object.freeze(x)));
})();

/** Renames of research 07 `arts` groups to manifest UI groups. */
const ARTS_GROUPS = Object.freeze({
  rarityStars: 'rarity', rarityStarsYellow: 'rarityYellow', eliteIcon: 'elite', eliteIconLarge: 'eliteLarge',
  campLogo: 'campLogo', loadingIllust: 'loading', battleCommon: 'battle', act2Entry: 'entry', itemRarityBg: 'itemRarity',
});

// ---------------------------------------------------------------------------
// helpers

/**
 * One download alternative.
 * @param {string} rel path under public/assets
 * @param {string|string[]} urls
 * @param {number} [bytes] expected size
 */
function alt(rel, urls, bytes) {
  const a = { rel, urls: [].concat(urls).filter((u) => typeof u === 'string' && u), kind: kindOf(rel) };
  if (Number.isInteger(bytes) && bytes > 0) a.bytes = bytes;
  return a;
}

/** A leaf with the given alternatives (null alternatives are dropped). */
function leaf(...alts) {
  const list = alts.flat().filter((a) => a && a.urls && a.urls.length);
  return list.length ? { alts: list } : null;
}

/** W-1-REAPPLY-2026-10-07：上游仓里中/日两个目录名。**日语在 `voice/`**（默认音轨），中文在 `voice_cn/`**（与 tools/fetch-bilingual-voices.mjs 同源）。 */
const VOICE_LANG_DIRS = Object.freeze({ jp: 'voice', cn: 'voice_cn' });

/**
 * 一条干员战斗语音 → leaf。`web` 是清单里记的路径 `/assets/audio/voice/<lang>/<charDir>/<file>.mp3`
 * （`docs/research/09-voices.json` 的形状），落盘 rel 去掉 `/assets/` 前缀，远端 alt 指回 sound_beta_2 的对应目录。
 *
 * ⚠️ **为什么必须原生产出**（而不是像上游那样事后 `sync-voices-manifest --write` 注进去）：
 * `tools/fetch-assets.mjs` 重建清单时，若计划里没有语音，`manifest.mjs` 的 shrink 守卫会发现
 * `audio.voice.*` 整片叶子"消失" ⇒ **拒绝写盘**（`droppedEntries`），或者更糟 —— 写出丢条目的清单。
 * 语音与皮肤同理，**产生引用的代码**必须跟着改（2026-10-05 图标全灭的同类失效）。
 * @param {string} web e.g. '/assets/audio/voice/jp/char_263_skadi/cn_019.mp3'
 */
function voiceLeaf(web) {
  if (typeof web !== 'string') return null;
  const rel = web.replace(/^\/assets\//, '');
  const p = rel.split('/');
  if (p.length < 4 || p[0] !== 'audio' || p[1] !== 'voice') return null;
  const remote = `${VOICE_LANG_DIRS[p[2]]}/${p.slice(3).join('/')}`;
  if (!remote.startsWith('voice')) return null;   // 语言目录不在表里 ⇒ 不猜
  return leaf(alt(rel, joinUrl(RAW.aa2voice, remote)));
}

/** Sound path under sound_beta_2 → alternative under public/assets/audio/<sub>. */
function soundAlt(path, sub = 'sfx') {
  const rel = `audio/${sub}/` + path.split('/').map(safeName).join('/');
  return alt(rel, joinUrl(RAW.aa2voice, path));
}

function soundLeaf(paths, sub = 'sfx', max = 4) {
  return leaf((paths || []).slice(0, max).map((p) => soundAlt(p, sub)));
}

/** 12 个战斗语音槽的固定顺序（清单里也照这个序写，diff 才稳定）。 */
export const VOICE_SLOT_ORDER = Object.freeze(['start', 'faceEnemy', 'select', 'place', 'skill1', 'skill2', 'skill3', 'skill4', 'resultFour', 'resultThree', 'resultTwo', 'resultLose']);

/**
 * 干员战斗语音段：`{ jp: { <charId>: { <槽>: leaf | leaf[] } }, cn: {…} }`。
 * 由 `buildPlan` 与 `tools/sync-voices-manifest.mjs` **共用**，保证"计划里算出来的"和"写进清单的"是同一份。
 *
 * 🔴 **不要用 `chars[charId]` 过滤**。`chars` 只含 research 03 里那批，而本地清单里还有十几位
 *    **内容包干员**（`content-packs/*.pack.json`）—— 按 `chars` 过滤会**静默丢掉他们的全部语音**。
 *    `09-voices.json` 本身已按"我们的可玩干员"筛过（`fetch-bilingual-voices.mjs` 用的是 `data/assets.json` 的 chars）。
 * @param {any} voices09 docs/research/09-voices.json
 */
export function buildVoiceSection(voices09) {
  const voice = { jp: {}, cn: {} };
  if (!voices09?.voices) return voice;
  const knownSlots = new Set(Array.isArray(voices09.meta?.slots) && voices09.meta.slots.length ? voices09.meta.slots : VOICE_SLOT_ORDER);
  for (const lang of ['jp', 'cn']) {
    for (const [charId, bySlot] of Object.entries(voices09.voices[lang] || {})) {
      if (!bySlot || typeof bySlot !== 'object') continue;
      const out = {};
      for (const slot of VOICE_SLOT_ORDER) {
        if (!knownSlots.has(slot)) continue;
        const v = bySlot[slot];
        if (v === undefined) continue;
        const list = (Array.isArray(v) ? v : [v]).map(voiceLeaf).filter(Boolean);
        if (list.length === 1) out[slot] = list[0];
        else if (list.length > 1) out[slot] = list;
      }
      if (Object.keys(out).length) voice[lang][charId] = out;
    }
  }
  return voice;
}

/**
 * A unit's SFX roles (pickUnitSfx) → { roles: { attack?, hit?, die?, born? } sound leaves, mix: { [role]: { p?, vol? } }
 * | null } — the official play chance / volume of each role's bank (audio.mjs bankMix; community report #30: 猎狗's
 * attack bank is 80 % silence). The caller stores `mix` last in the unit's entry (sfx.units[id].mix).
 */
function unitSounds(audio, sfx) {
  const roles = {};
  let mix = null;
  for (const r of ['attack', 'hit', 'die', 'born']) {
    if (!sfx[r]) continue;
    roles[r] = soundLeaf(sfx[r]);
    const m = typeof audio.mixOf === 'function' ? audio.mixOf(sfx[r]) : null;
    if (m) (mix || (mix = {}))[r] = m;
  }
  return { roles, mix };
}

/** Expected bytes for a 07 {url, bytes} record when it matches `url`. */
function bytesOf(rec, url) {
  return rec && typeof rec === 'object' && rec.url === url && Number.isInteger(rec.bytes) ? rec.bytes : undefined;
}

/** Local file stem for a skeleton URL or file name ('…/char_102_texas.skel' → 'char_102_texas'). */
function skelStem(urlOrName) {
  return safeName(urlBase(urlOrName).replace(/\.skel$/i, ''));
}

/** Collect every enemy key referenced under a wave/branch structure. */
function walkKeys(node, add) {
  if (Array.isArray(node)) { for (const x of node) walkKeys(x, add); return; }
  if (node && typeof node === 'object') {
    if (typeof node.key === 'string') add(node.key);
    for (const v of Object.values(node)) walkKeys(v, add);
  }
}

/**
 * A research-07-shaped operator record of a character research 07 does not list (the 自选 owned-6★ picks): every URL
 * from the patterns of 07-assets.json `meta.patterns` — avatar / portrait (E0–E1 and E2), the default-skin battle Spine
 * Front / Back, the skill icons, the sub-profession icon. No expected byte counts (the downloader validates the files);
 * a file the mirrors lack is a miss the client falls back from (the E2 art to the E0–E1 one, a missing Back to Front).
 * @param {string} id charId
 * @param {{ subProfessionId?: string|null, nationId?: string|null, skills?: Array<{ index: number, skillId: string, iconId?: string|null }> }} x
 */
export function patternOperator(id, x = {}) {
  const sp = (side) => {
    const b = `${RAW.fexli}spine/${id}/${id}/${side}/${id}`;
    return { skel: `${b}.skel`, atlas: `${b}.atlas`, png: `${b}.png` };
  };
  return {
    name: x.name ?? null, subProfessionId: x.subProfessionId ?? null, nationId: x.nationId ?? null, chess: [],
    avatar: { e0e1: { url: `${RAW.yuanyan}avatar/${id}.png` }, e2: { url: `${RAW.yuanyan}avatar/${id}_2.png` } },
    portrait: { e0e1: { url: `${RAW.yuanyan}portrait/${id}_1.png` }, e2: { url: `${RAW.yuanyan}portrait/${id}_2.png` } },
    skills: (x.skills || []).map((s) => ({
      index: s.index, skillId: s.skillId, iconId: s.iconId || s.skillId,
      icon: { url: `${RAW.yuanyan}skill/skill_icon_${encodeURIComponent(s.iconId || s.skillId)}.png` },
    })),
    battleSpine: { front: sp('Front'), back: sp('Back'), note: null },
    subProfessionIcon: x.subProfessionId ? joinUrl(RAW.aa2, `arts/ui/subprofessionicon/sub_${x.subProfessionId}_icon.png`) : null,
  };
}

// ---------------------------------------------------------------------------
// id sets

/**
 * Per-charId skill indices used by the pool (0-based; primary first).
 * @param {any} ops03 docs/research/03-operators.json
 * @returns {Map<string, number[]>}
 */
export function skillIndicesByChar(ops03) {
  const primary = new Map();
  const all = new Map();
  const add = (id, idx, isPrimary) => {
    if (typeof id !== 'string' || !Number.isInteger(idx) || idx < 0) return;
    if (!all.has(id)) all.set(id, new Set());
    all.get(id).add(idx);
    if (isPrimary && !primary.has(id)) primary.set(id, idx);
  };
  const chess = Array.isArray(ops03?.chess) ? ops03.chess : [];
  for (const c of chess) if (c.charId) add(c.charId, c.defaultSkillIndex, !c.isGolden);
  for (const c of chess) if (c.backup?.charId) add(c.backup.charId, c.backup.skillIndex, true);
  const out = new Map();
  for (const [id, set] of all) {
    const p = primary.has(id) ? primary.get(id) : Math.min(...set);
    out.set(id, [p, ...[...set].filter((i) => i !== p).sort((a, b) => a - b)]);
  }
  return out;
}

/**
 * Every enemy id that can appear in an act2autochess match.
 * @param {{ assets07:any, enemies05:any, maps05:any, ops03?:any }} r
 *   ops03 (optional): enemy units spawned by operator kits (e.g. 隐德来希's S3 summons
 *   `enemy_5601_entlec` 心烛 via a talent blackboard `take_extra_enemy_key`)
 * @returns {string[]} sorted ids
 */
export function collectEnemyIds({ assets07, enemies05, maps05, ops03 }) {
  const known = (id) => !!(enemies05?.enemies?.[id] || assets07?.enemies?.[id]);
  const set = new Set(Object.keys(assets07?.enemies || {}));
  const add = (k) => { if (typeof k === 'string' && /^enemy_\d+_[a-z0-9_]+$/i.test(k)) set.add(k); };
  for (const c of Array.isArray(ops03?.chess) ? ops03.chess : []) {
    const kit = JSON.stringify([c?.skill ?? null, c?.talents ?? null, c?.tokens ?? null]);
    for (const m of kit.match(/enemy_\d+_[a-z0-9_]+/gi) || []) add(m);
  }
  for (const lv of Object.values(maps05?.roundLevels || {})) {
    const usedBy = Array.isArray(lv?.usedBy) ? lv.usedBy : [];
    if (usedBy.length && usedBy.every((u) => String(u).startsWith('mode_training'))) continue; // tutorial is out of scope
    for (const ref of lv?.enemyDbRefs || []) add(Array.isArray(ref) ? ref[0] : ref);
    walkKeys(lv?.waves, add);
    walkKeys(lv?.branches, add);
  }
  for (const b of Object.values(enemies05?.bosses || {})) { add(b?.enemyId); for (const s of b?.spawns || []) add(s); }
  // Closure over summons: randomEnemyAttribute spawns + `enemy_key` blackboard references.
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...set]) {
      const e = enemies05?.enemies?.[id];
      if (!e) continue;
      const refs = new Set(e.ac?.rand?.spawns || []);
      for (const m of JSON.stringify([e.skills ?? null, e.talent ?? null]).match(/enemy_\d+_[a-z0-9_]+/gi) || []) refs.add(m);
      for (const r of refs) if (!set.has(r) && known(r)) { set.add(r); changed = true; }
    }
  }
  return [...set].sort();
}

// ---------------------------------------------------------------------------
// plan

/**
 * Build the asset plan.
 * @param {object} p
 * @param {any} p.assets07 docs/research/07-assets.json
 * @param {any} p.ops03 docs/research/03-operators.json
 * @param {any} p.enemies05 docs/research/05-enemies.json
 * @param {any} p.maps05 docs/research/05-maps.json
 * @param {ReturnType<import('./audio.mjs').indexAudio>} p.audio indexed audio_data.json
 * @param {any} p.modelsData Ark-Models models_data.json
 * @param {string[]} [p.extraEnemyIds] more enemy ids that can spawn (e.g. keys of data/enemies.json)
 * @param {string[]} [p.extraTokenIds] more token ids (e.g. token_* keys of data/tokens.json)
 * @param {Record<string,string>} [p.extraHandbook] enemyId → handbook/model id (e.g. from data/bosses.json)
 * @param {Record<string, import('./spine.mjs').LocalSpineMeta>} [p.localEnemySpines] metadata of the enemy models the
 *   local client has (the committed tools/assets/local-enemy-spines.json, never the disk): each planned enemy listed
 *   gets `spineLocal` = { group: 'spine/enemy/<id>', ...meta } beside its web `spine`
 * @param {Record<string, import('./spine.mjs').LocalSpineMeta>} [p.localTokenSpines] the same for the token (summon)
 *   models (tools/assets/local-token-spines.json): each planned token listed gets `spineLocal` = { group:
 *   'spine/token/<id>', ...meta } beside its web `spine`, if any (most have none: the client drew the avatar)
 * @param {Record<string, any>} [p.extraOperators] charId → { subProfessionId, nationId, skills: [{ index, skillId, iconId }] }
 *   of characters research 07 does not list (the 自选 owned-6★ picks, data/backups.json `units`): planned like the pool
 *   operators from patternOperator
 * @param {string[]} [p.moduleTypes] module type icon ids (`typeIcon`, e.g. 'sol-x') → manifest `modules[typeIcon]`, the
 *   official type icon (arts/ui/uniequiptype) the 干员调配 / 自选 module tiles draw when the local-client art lacks it
 * @param {any} [p.skins08] docs/research/08-skins.json（换装皮肤）→ `chars[].skins`
 * @param {any} [p.voices09] docs/research/09-voices.json（干员战斗语音结构，`tools/fetch-bilingual-voices.mjs` 产出）。
 *   缺文件时 `null` ⇒ 计划不含语音（老检出仍然能跑）。
 * @returns {{ template: any, models: Map<string, any>, notes: string[] }}
 */
export function buildPlan({ assets07, ops03, enemies05, maps05, audio, modelsData,
  extraEnemyIds = [], extraTokenIds = [], extraHandbook = {}, localEnemySpines = {}, localTokenSpines = {}, extraOperators = {},
  moduleTypes = [], skins08 = null, voices09 = null }) {
  const notes = [];
  /** @type {Map<string, any>} */
  const models = new Map();
  const skillIdx = skillIndicesByChar(ops03);
  /** 每个干员最终用的 skill 片段索引（本体模型算好的那套），皮肤模型复用（见下面的皮肤块） */
  const charSkillIdx = new Map();

  // --- Spine model helpers -------------------------------------------------
  const addModel = (key, def) => { if (!models.has(key)) models.set(key, { key, ...def }); return { model: key }; };
  const fexliModel = (key, kind, dir, rec, skillIndices) => {
    // rec: 07 { skel:{url,bytes}|url|url[], atlas, png } — arrays are candidate folders (same order for all three)
    const us = (x) => (Array.isArray(x) ? x : [typeof x === 'string' ? x : x?.url]).filter((v) => typeof v === 'string' && v);
    const b = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x.bytes : undefined);
    if (!us(rec?.skel).length || !us(rec?.atlas).length || !us(rec?.png).length) return null;
    const stem = skelStem(us(rec.skel)[0]);
    return addModel(key, {
      kind, dir, pma: false, skillIndices,
      baseUrl: urlDir(us(rec.atlas)[0]),
      skel: alt(`${dir}${stem}.skel`, us(rec.skel), b(rec.skel)),
      // pixi-spine finds the atlas by swapping the .skel extension: keep the same stem.
      atlas: { ...alt(`${dir}${stem}.atlas`, us(rec.atlas), b(rec.atlas)), mutable: true },
      pngs: [alt(dir + safeName(urlBase(us(rec.png)[0])), us(rec.png), b(rec.png))],
    });
  };

  // --- operators -----------------------------------------------------------
  const chars = {};
  const skills = {};
  const skillsById = {};
  const unitsSfx = {};
  const known = assets07?.operators || {};
  const extraOps = {};
  for (const [id, x] of Object.entries(extraOperators || {})) if (/^char_\d+_[a-z0-9]+$/i.test(id) && !known[id]) extraOps[id] = patternOperator(id, x);
  const operators = { ...known, ...extraOps };
  const charIds = Object.keys(operators).sort();
  for (const id of charIds) {
    const o = operators[id];
    // DESIGN §16 operator loadouts: any skill of the character can be equipped — the icons, skill SFX and Spine skill
    // clips of every skill index (the pool's primary index first, as before)
    const idx0 = skillIdx.get(id) || [0];
    const idx = [...idx0, ...(o.skills || []).map((k) => k.index).filter((i) => Number.isInteger(i) && i >= 0 && !idx0.includes(i)).sort((a, b) => a - b)];
    const c = {};
    c.avatar = leaf(alt(`char/avatar/${id}.png`, o.avatar?.e0e1?.url, o.avatar?.e0e1?.bytes));
    if (o.avatar?.e2?.url) c.avatarE2 = leaf(alt(`char/avatar/${id}_2.png`, o.avatar.e2.url, o.avatar.e2.bytes));
    c.portrait = leaf(alt(`char/portrait/${id}_1.png`, o.portrait?.e0e1?.url, o.portrait?.e0e1?.bytes));
    if (o.portrait?.e2?.url) c.portraitE2 = leaf(alt(`char/portrait/${id}_2.png`, o.portrait.e2.url, o.portrait.e2.bytes));
    c.spine = {};
    const front = fexliModel(`op:${id}:front`, 'op', `spine/op/${id}/front/`, o.battleSpine?.front, idx);
    if (front) c.spine.front = front; else notes.push(`${id}: no Front battle Spine in research data`);
    const back = fexliModel(`op:${id}:back`, 'op', `spine/op/${id}/back/`, o.battleSpine?.back, idx);
    if (back) c.spine.back = back;
    chars[id] = c;
    // 皮肤要用与干员本体**同一套** skill 片段索引（见下面的皮肤块），这里把算好的 idx 存下来复用
    charSkillIdx.set(id, idx);
    // skill icons (+ skill SFX) of every skill index; normal-mode attack / impact sounds only (a ranged operator's own
    // projectile banks projectile_chr_<name> as fallbacks — user playtest #4 item 6, audio.mjs pickUnitSfx)
    const short = id.replace(/^char_\d+_/, '');
    const sfx = pickUnitSfx(audio.unitBanks.get(id), { operator: true, projectile: {
      born: audio.bank(`battle.ON_PROJECTILE_BORN.projectile_chr_${short}`), hit: audio.bank(`battle.ON_PROJECTILE_HIT.projectile_chr_${short}`) } });
    const { roles: u, mix } = unitSounds(audio, sfx);
    const skillSfx = {};
    for (const i of idx) {
      const s = (o.skills || []).find((k) => k.index === i);
      if (!s) { notes.push(`${id}: skill index ${i} missing in research data`); continue; }
      const iconId = s.iconId || s.skillId;
      if (s.icon?.url && !skills[iconId]) skills[iconId] = leaf(alt(`skill/${safeName(iconId)}.png`, s.icon.url, s.icon.bytes));
      if (s.skillId) skillsById[s.skillId] = iconId;
      const ss = audio.skillBanks.get(s.skillId)?.get('ON_SKILL_START');
      if (ss?.length) skillSfx[String(i)] = soundLeaf(ss);
    }
    const primarySkill = skillSfx[String(idx[0])];
    if (primarySkill) u.skill = primarySkill;
    if (Object.keys(skillSfx).length > 1) u.skills = skillSfx;
    if (mix) u.mix = mix;
    if (Object.keys(u).length) unitsSfx[id] = u;
  }

  // --- operator skins (docs/SKINS.md, docs/research/08-skins.json) ----------
  //
  // 换装皮肤：`chars[charId].skins = { [skinId]: { name, group, avatar, spine? } }` — 与干员自己的
  // `chars[charId].avatar` 并列，客户端 `public/js/assets.js` 的 `avatarUrl(.., { skin })` 就读这里。
  //
  // ⚠️ 这里**必须**走 `leaf(alt(...))` / `fexliModel(...)` 而不是写死 URL 字符串（上游那份
  // `inject-skins-assets.mjs` 是写死的）：本工作区把 `public/assets` 整体转成了 WebP，写死
  // `/assets/char/skin_avatar/x.png` 在转换后会**全部 404** —— 就是 2026-10-05 那次「全站图标退化成文字」
  // 的失败模式。交给 `manifest.mjs` 的 `actualRel()` 解析，`.png` / `.webp` 两种落盘形态都会命中。
  //
  // `skinId` 按 **chessId** 存（`chess_char_1_01_a`），而目录是按 **operator id**（`char_498_inside`）分组的：
  // 两者混用会静默清空选择，见 docs/SKINS.md §2。
  //
  // **骨骼一定要注册成 model**，不能只写个 URL：`tools/assets/spine.mjs` 只在模型阶段做三件承重的事
  //   ① `normalizeAtlas()` 把页面尺寸补进 `.atlas`（**并且写回磁盘**）—— 缺 `size:` 行的 atlas 会
  //      让 `test/assets.test.js` 的「every atlas on disk has size: lines」直接红，客户端也定位不到切片；
  //   ② `resolveRoles()` 算 `anims` —— 客户端 `validSpine()` 要求它，缺了皮肤模型永远加载不出来，
  //      单位会停在占位头像上（不盯棋盘根本发现不了）；
  //   ③ 建立 skel/atlas/png 三件套的关联。
  // 皮肤与干员本体共用同一套 `skillIndices`（idx），否则皮肤自己的 skill 片段会被当成未知动画丢掉。
  if (skins08 && skins08.skins) {
    for (const [id, list] of Object.entries(skins08.skins)) {
      const c = chars[id];
      if (!c || !Array.isArray(list)) continue;
      const idx = charSkillIdx.get(id) || skillIdx.get(id) || [0];
      const m = {};
      for (const s of list) {
        if (!s || typeof s.skinId !== 'string') continue;
        const stem = typeof s.stem === 'string' && s.stem ? s.stem : s.skinId.replace(/@/g, '_').replace(/#/g, '_');
        const avatar = leaf(alt(`char/skin_avatar/${stem}.png`, s.avatar?.url, s.avatar?.bytes));
        if (!avatar) continue;
        const entry = { name: literal(s.name || s.skinId), group: literal(s.group || ''), avatar };
        // 只有普查表里真有这一侧的骨骼时才登记（研究表的 note：只收录上游存在的 Spine 目录）
        const sfront = fexliModel(`skin:${id}:${stem}:front`, 'op', `spine/op/${id}/${stem}/front/`, s.battleSpine?.front, idx);
        if (sfront) {
          const spine = { front: sfront };
          // W-1（2026-10-07）：`backMissingUpstream` 是**数据订正**，不是隐瞒 —— 这几套皮肤官方 CDN 上
          //   就没有独立 Back 骨骼（答C件 §4 取证：fexli 抽查 3/3 全 404）。跳过它，免得每次重跑配方
          //   都按"有 back"去找然后 miss（空跑一轮），也让 b-verify-asset-refs 的 warn 归零。
          //   客户端对缺 Back 的回退是 front（上游 patternOperator 头注："a missing Back to Front"）。
          const sback = s.battleSpine?.backMissingUpstream ? null
            : fexliModel(`skin:${id}:${stem}:back`, 'op', `spine/op/${id}/${stem}/back/`, s.battleSpine?.back, idx);
          if (sback) spine.back = sback;
          else if (s.battleSpine?.backMissingUpstream) notes.push(`skin ${s.skinId}: no Back Spine upstream — the unit falls back to Front`);
          entry.spine = spine;
        } else {
          notes.push(`skin ${s.skinId}: no Front Spine in research 08 — avatar only, the unit keeps the operator model`);
        }
        m[s.skinId] = entry;
      }
      if (Object.keys(m).length) c.skins = m;
    }
  }

  // --- tokens --------------------------------------------------------------
  const chessById = new Map((ops03?.chess || []).map((c) => [c.chessId, c]));
  const tokens = {};
  const tokenIds = new Set(Object.keys(assets07?.tokens || {}));
  for (const id of extraTokenIds) if (typeof id === 'string' && /^token_\d+_[a-z0-9_]+$/i.test(id)) tokenIds.add(id);
  for (const id of [...tokenIds].sort()) {
    // Tokens unknown to research 07: default avatar/Spine locations (misses are tolerated).
    const t = assets07?.tokens?.[id] ?? {
      avatar: { url: `${RAW.yuanyan}avatar/${id}.png` },
      battleSpineDefault: null,
      battleSpineSkinVariantsOnly: [id],
    };
    const usedBy = ops03?.tokensUsedByPool?.[id]?.usedByChess || [];
    const ownerChess = usedBy.map((cid) => chessById.get(cid)).find(Boolean);
    const entry = { owner: ownerChess?.charId || ownerChess?.backup?.charId || null };
    entry.avatar = t.avatar?.url ? leaf(alt(`token/avatar/${id}.png`, t.avatar.url, t.avatar.bytes)) : null;
    let model = null;
    if (t.battleSpineDefault) {
      model = fexliModel(`token:${id}`, 'token', `spine/token/${id}/`, t.battleSpineDefault, [0]);
    } else if (Array.isArray(t.battleSpineSkinVariantsOnly) && t.battleSpineSkinVariantsOnly.length) {
      // Skin-variant models live in a `Spine/` folder, or `Front/` for directional ones.
      const v = t.battleSpineSkinVariantsOnly[0];
      const bases = ['Spine', 'Front'].map((f) => `${RAW.fexli}spine/${encodeURIComponent(id)}/${encodeURIComponent(v)}/${f}/${encodeURIComponent(v)}`);
      model = fexliModel(`token:${id}`, 'token', `spine/token/${id}/`, {
        skel: bases.map((b) => b + '.skel'), atlas: bases.map((b) => b + '.atlas'), png: bases.map((b) => b + '.png'),
      }, [0]);
      if (model) entry.spineVariant = v;
    }
    entry.spine = model;
    // the official model from the local client, drawn instead of the avatar (or of `spine`) when extracted (optional)
    const loc = localTokenSpines && Object.hasOwn(localTokenSpines, id) ? localTokenSpines[id] : null;
    if (loc && typeof loc === 'object') {
      entry.spineLocal = literal({ group: `spine/token/${id}`, ...loc });
      notes.push(`${id}: official Spine from the local client when extracted (spineLocal)`);
    }
    tokens[id] = entry;
    const { roles: u, mix } = unitSounds(audio, pickUnitSfx(audio.unitBanks.get(id)));
    if (mix) u.mix = mix;
    if (Object.keys(u).length) unitsSfx[id] = u;
  }

  // --- enemies -------------------------------------------------------------
  const handbookOf = new Map();
  for (const b of Object.values(enemies05?.bosses || {})) if (b?.enemyId && b.handbookId && b.handbookId !== b.enemyId) handbookOf.set(b.enemyId, b.handbookId);
  for (const [eid, hb] of Object.entries(extraHandbook || {})) if (typeof hb === 'string' && hb !== eid && !handbookOf.has(eid)) handbookOf.set(eid, hb);
  const mdData = modelsData?.data || {};
  const enemyDir = modelsData?.storageDirectory?.Enemy || 'models_enemies';
  const pick = (v) => (Array.isArray(v) ? (v.find((x) => typeof x === 'string' && !x.includes('$')) ?? v[0]) : v);
  const arkModel = (eid) => {
    const key = eid.replace(/^enemy_/, '');
    const al = mdData[key]?.assetList;
    const skel = pick(al?.['.skel']); const atlas = pick(al?.['.atlas']); const png = pick(al?.['.png']);
    if (![skel, atlas, png].every((x) => typeof x === 'string' && x)) return null;
    const base = `${RAW.arkModels}${enemyDir}/${encodeURIComponent(key)}/`;
    const rec07 = assets07?.enemies?.[eid]?.battleSpine;
    const dir = `spine/enemy/${eid}/`;
    const stem = skelStem(skel);
    const mk = (file, r, rel) => alt(rel ?? dir + safeName(file), base + encodeURIComponent(file), bytesOf(r, base + encodeURIComponent(file)));
    return addModel(`enemy:${eid}`, {
      kind: 'enemy', dir, pma: true, skillIndices: [0], baseUrl: base,
      skel: mk(skel, rec07?.skel, `${dir}${stem}.skel`),
      atlas: { ...mk(atlas, rec07?.atlas, `${dir}${stem}.atlas`), mutable: true },
      pngs: [mk(png, rec07?.png)],
    });
  };
  const baseIdOf = (eid) => { const m = /^(enemy_\d+_[a-z0-9]+?)_\d+$/i.exec(eid); return m ? m[1] : null; };
  const enemyIdSet = new Set(collectEnemyIds({ assets07, enemies05, maps05, ops03 }));
  for (const id of extraEnemyIds) if (typeof id === 'string' && /^enemy_\d+_[a-z0-9_]+$/i.test(id)) enemyIdSet.add(id);
  // Boss handbook ids (their own icon/model ids) are addressable too.
  for (const hb of handbookOf.values()) if (/^enemy_\d+_[a-z0-9_]+$/i.test(hb)) enemyIdSet.add(hb);
  const enemyIds = [...enemyIdSet].sort();
  const enemies = {};
  for (const id of enemyIds) {
    const e = {};
    const icon07 = assets07?.enemies?.[id]?.icon;
    const iconAlts = [alt(`enemy/icon/${id}.png`, `${RAW.yuanyan}enemy/${id}.png`, bytesOf(icon07, `${RAW.yuanyan}enemy/${id}.png`))];
    for (const other of [handbookOf.get(id), baseIdOf(id)]) if (other) iconAlts.push(alt(`enemy/icon/${id}.png`, `${RAW.yuanyan}enemy/${other}.png`));
    e.icon = leaf(iconAlts);
    // Spine: own model, else alias chain (research 07 §5.6).
    let spine = arkModel(id);
    if (!spine) {
      const seen = new Set([id]);
      const queue = [ENEMY_SPINE_ALIAS[id], baseIdOf(id), handbookOf.get(id)].filter(Boolean);
      while (!spine && queue.length) {
        const cand = queue.shift();
        if (seen.has(cand)) continue;
        seen.add(cand);
        spine = arkModel(cand);
        if (spine) e.spineAliasOf = cand;
        else queue.push(...[ENEMY_SPINE_ALIAS[cand], baseIdOf(cand), handbookOf.get(cand)].filter(Boolean));
      }
      if (!spine) notes.push(`${id}: no enemy Spine upstream (client draws the icon, if any, or a glyph)`);
      else notes.push(`${id}: Spine aliased to ${e.spineAliasOf}`);
    }
    e.spine = spine;
    // the official model from the local client, drawn instead of `spine` when the extraction is installed (optional)
    const loc = localEnemySpines && Object.hasOwn(localEnemySpines, id) ? localEnemySpines[id] : null;
    if (loc && typeof loc === 'object') {
      e.spineLocal = literal({ group: `spine/enemy/${id}`, ...loc });
      notes.push(`${id}: official Spine from the local client when extracted (spineLocal)`);
    }
    enemies[id] = e;
    let banks = audio.unitBanks.get(id);
    for (const other of [handbookOf.get(id), e.spineAliasOf, baseIdOf(id)]) {
      if (banks?.size) break;
      if (other) banks = audio.unitBanks.get(other);
    }
    const { roles: u, mix } = unitSounds(audio, pickUnitSfx(banks));
    if (mix) u.mix = mix;
    if (Object.keys(u).length) unitsSfx[id] = u;
  }

  // --- bonds / items / bands -------------------------------------------------
  const bonds = {};
  for (const [bondId, b] of Object.entries(assets07?.bonds || {})) {
    bonds[bondId] = leaf(alt(`bond/${bondId}.png`, b.icon?.url, b.icon?.bytes), b.fallbackCampLogo ? alt(`bond/${bondId}.png`, b.fallbackCampLogo) : null);
  }
  const items = {};
  for (const [trapId, it] of Object.entries(assets07?.items || {})) items[trapId] = leaf(alt(`item/${trapId}.png`, it.icon?.url, it.icon?.bytes));
  const bands = {};
  for (const [bandId, b] of Object.entries(assets07?.bands || {})) bands[bandId] = leaf(alt(`band/${bandId}.png`, b.icon?.url, b.icon?.bytes));

  // --- professions ----------------------------------------------------------
  const prof = { icon: {}, large: {}, battlecard: {}, sub: {} };
  for (const p of PROFESSIONS) {
    const i = assets07?.arts?.professionIcon?.[p];
    if (i) prof.icon[p] = leaf(alt(`prof/icon_${p}.png`, i));
    const l = assets07?.arts?.professionIconLargeWhite?.[p];
    if (l) prof.large[p] = leaf(alt(`prof/large_${p}.png`, l));
  }
  for (const p of [...PROFESSIONS, 'token']) {
    prof.battlecard[p] = leaf(alt(`prof/battlecard_${p}.png`, joinUrl(RAW.aa2, `arts/ui/[uc]battlecommon/ui_battle_new/battlecard/icon_profession_${p}.png`)));
  }
  for (const o of Object.values(operators)) {
    const sub = o.subProfessionId;
    if (typeof sub === 'string' && sub && !prof.sub[sub] && o.subProfessionIcon) prof.sub[sub] = leaf(alt(`prof/sub/${safeName(sub)}.png`, o.subProfessionIcon));
  }

  // --- UI ------------------------------------------------------------------
  const ui = {};
  const addUi = (group, key, url) => {
    const k = safeName(key);
    const name = `${group}/${k}`;
    if (!ui[name] && url) ui[name] = leaf(alt(`ui/${group}/${k}.png`, url));
  };
  for (const [group, entries] of Object.entries(assets07?.autochessUi || {})) {
    for (const [key, url] of Object.entries(entries || {})) addUi(group, key, url);
  }
  const nations = new Set(Object.values(operators).map((o) => o.nationId).filter(Boolean));
  const logos = new Set(['logo_rhodes', ...[...nations].map((n) => `logo_${n}`)]);
  for (const b of Object.values(assets07?.bonds || {})) if (b.fallbackCampLogo) logos.add(urlBase(b.fallbackCampLogo).replace(/\.png$/i, ''));
  for (const [src, group] of Object.entries(ARTS_GROUPS)) {
    for (const [key, url] of Object.entries(assets07?.arts?.[src] || {})) {
      if (src === 'campLogo' && !logos.has(key)) continue;
      if (src === 'loadingIllust' && !LOADING_USED.has(key)) continue;
      addUi(group, key, url);
    }
  }
  for (const [group, key, path] of UI_EXTRAS) addUi(group, key, joinUrl(RAW.aa2, path));

  // --- audio ----------------------------------------------------------------
  const bgmLeaf = (bankName) => {
    const b = audio.bgm(bankName);
    if (!b?.loop) { notes.push(`BGM bank ${bankName} not found`); return null; }
    const out = { loop: soundLeaf([b.loop], 'bgm', 1) };
    if (b.intro) out.intro = soundLeaf([b.intro], 'bgm', 1);
    return out;
  };
  // BGM files are flattened to audio/bgm/<basename>.
  const flatBgm = (node) => {
    if (!node) return node;
    for (const k of Object.keys(node)) {
      const l = node[k];
      if (l?.alts) for (const a of l.alts) a.rel = 'audio/bgm/' + safeName(a.rel.split('/').pop());
    }
    return node;
  };
  // 联防 BGM: the official 联防 levels (`escaped_single` / `escaped_multi`) declare `bgmEvent = corrosion` — a
  // 卡西米尔 act13d5d0 battle track — so the rescue phase does NOT reuse the 作战's track. Kept out of `bgm` when the
  // bank is missing (the client then falls back to `bgm.combat`; public/js/audio.js resolveBgm), so the manifest stays
  // valid for an older audio_data.
  const unite = flatBgm(bgmLeaf('battle.ON_GAME_READY.corrosion'));
  // 开战 BGM: the two official battle tracks of the mode's own 卡西米尔 act (music_act13side_1 骑士之日 /
  // music_act13side_2 无畏者, 塞壬唱片). The client does not draw them: the round decides (audio.js combatTrackFor —
  // 无畏者 for rounds 1–7, 骑士之日 from round 8 on), so index 0 must stay `bat_kazimierz2_1` and index 1
  // `bat_kazimierz2_2` (test/ui/audio.test.js pins both the order and the round table).
  // Kept out of `bgm` below when the index has neither bank, so the manifest stays valid for an older audio_data.
  const combatAlts = ['battle.ON_GAME_READY.bat_kazimierz2_1', 'battle.ON_GAME_READY.bat_kazimierz2_2']
    .map((n) => flatBgm(bgmLeaf(n))).filter(Boolean);
  const bgm = {
    lobby: flatBgm(bgmLeaf('sys.ON_ACTIVITY_LOADED.act2autochess')),
    prep: flatBgm(bgmLeaf('battle.ON_GAME_READY.act1autochess_shop')),
    combat: flatBgm(bgmLeaf('battle.ON_GAME_READY.act1autochess_shop')),
    boss: flatBgm(bgmLeaf('battle.ON_GAME_READY.rglk1phantomcastle')),
    ...(combatAlts.length ? { combatAlts } : {}),
    ...(unite ? { unite } : {}),
  };
  const bossBgm = {};
  for (const lv of Object.values(maps05?.roundLevels || {})) {
    if (typeof lv?.bgm !== 'string') continue;
    for (const u of lv.usedBy || []) {
      const m = /\(boss:(boss_\d+)\)/.exec(String(u));
      if (m && !bossBgm[m[1]] && !String(u).startsWith('mode_training')) bossBgm[m[1]] = flatBgm(bgmLeaf(`battle.ON_GAME_READY.${lv.bgm}`));
    }
  }
  const sfxUi = {};
  for (const [name, spec] of Object.entries(UI_SFX)) { const l = soundLeaf(resolveSpec(spec, audio.bank)); if (l) sfxUi[name] = l; else notes.push(`UI SFX ${name}: no sound`); }
  const sfxBattle = {};
  for (const [name, spec] of Object.entries(BATTLE_SFX)) { const l = soundLeaf(resolveSpec(spec, audio.bank)); if (l) sfxBattle[name] = l; else notes.push(`battle SFX ${name}: no sound`); }

  // --- module type icons ----------------------------------------------------
  const modules = {};
  for (const t of [...new Set(moduleTypes || [])].filter((x) => typeof x === 'string' && /^[a-z0-9-]+$/i.test(x)).sort()) {
    // the client's file name, else its lower-case form (the type id of a few modules is mixed case: WAH-Y → wah-y.png).
    // One lower-case file per type: the official data spells one DEC X module 'dec-X' (uniequip_003_aglina) and the
    // others 'dec-x'; two paths that differ only in case are one file on Windows / macOS (and in a release zip built or
    // extracted there), so a case-sensitive server would miss one of them.
    modules[t] = leaf(alt(`module/${safeName(t).toLowerCase()}.png`, [...new Set([t, t.toLowerCase()])].map((n) => joinUrl(RAW.aa2, `arts/ui/uniequiptype/${n}.png`))));
  }

  // --- 干员战斗语音 ---------------------------------------------------------
  // `audio.voice[lang][charId][slot]` = 一个路径，或（同槽多条时）一个路径数组（客户端随机取一条）。
  // 过滤口径与理由见 `buildVoiceSection` 的注释（**别再用 `chars` 过滤**，会丢内容包干员）。
  const voice = buildVoiceSection(voices09);

  const template = {
    chars, enemies, tokens, bonds, items, bands, skills, skillsById, modules, ui, prof,
    audio: {
      bgm,
      bossBgm: Object.fromEntries(Object.entries(bossBgm).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))),
      voice,
      sfx: { ui: sfxUi, battle: sfxBattle, units: unitsSfx },
    },
  };
  return { template, models, notes };
}
