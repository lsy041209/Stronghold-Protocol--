// 干员/敌人模板化 + 内容包 (2026-10-04). data/chess.json and data/enemies.json are GENERATED (tools/build-data.mjs)
// and the sim trusts them, so "make more operators" needs a supported path that keeps every invariant the generator
// enforces. That path is `.workbuddy/tools/content-packs.mjs`: author against the template, validate, merge — and the
// merge is additive, idempotent and reversible.
//
// This test drives the merge into a TEMP data directory (never into data/ — applying a pack to the shipped data would
// change the roster every player sees, and data.test.js' 112/266 assertions with it). It proves:
//   · the shipped example pack validates and merges (1 干员 + its derived 精锐 + 1 敌人)
//   · the merged records satisfy the same invariants the generator enforces (ids resolve, bonds exist, exactly one
//     default skill, module consistency, no non-finite numbers)
//   · the merge is idempotent (byte-identical on a second run) and reversible (revert restores the file exactly)
//   · the validator REJECTS each of the mistakes it exists to catch (a test that cannot fail proves nothing)
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE = path.resolve(ROOT, '..');
const TOOL = path.join(WORKSPACE, '.workbuddy', 'tools', 'content-packs.mjs');
const EXAMPLE = path.join(WORKSPACE, '数据解析', '模板化', 'examples', '示例内容包.pack.json');
const TEMPLATES = path.join(WORKSPACE, '数据解析', '模板化', 'templates');

const { validatePack, applyPacks, revertPacks, deriveElite } = await import('file://' + TOOL.replace(/\\/g, '/'));
const { loadData } = await import('../server/data.js');

/** A temp data dir holding the files a merge reads (chess / enemies + the ones it validates against + config/assets). */
function tempData() {
  const dir = mkdtempSync(path.join(tmpdir(), 'sp-packs-'));
  for (const f of ['chess', 'enemies', 'bonds', 'garrisons', 'config', 'assets']) {
    copyFileSync(path.join(ROOT, 'data', `${f}.json`), path.join(dir, `${f}.json`));
  }
  return dir;
}
const ctxOf = (dir) => ({
  bonds: JSON.parse(readFileSync(path.join(dir, 'bonds.json'), 'utf8')),
  garrisons: JSON.parse(readFileSync(path.join(dir, 'garrisons.json'), 'utf8')),
});
const readPack = (p) => JSON.parse(readFileSync(p, 'utf8'));

describe('内容包 (content packs) — 模板化的干员/敌人加载路径', () => {
  test('the shipped example pack validates', () => {
    const dir = tempData();
    try {
      const pack = readPack(EXAMPLE);
      const { errors, warnings } = validatePack(pack, ctxOf(dir));
      assert.deepEqual(errors, [], `示例内容包应当通过校验：\n${errors.join('\n')}`);
      assert.deepEqual(warnings, []);
      assert.equal(pack.chess.length, 1);
      assert.equal(pack.enemies.length, 1);
      assert.ok(pack.chess[0].elite, 'the example ships a 精锐 block (the twin is derived, not authored twice)');
      assert.equal(pack.chess[0].elite.isGolden, undefined, 'and does not try to set what the tool derives');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('applying it merges 普通 + 精锐 + 敌人, and the result passes the generator\'s own invariants', () => {
    const dir = tempData();
    try {
      const before = JSON.parse(readFileSync(path.join(dir, 'chess.json'), 'utf8'));
      const beforeEnemies = JSON.parse(readFileSync(path.join(dir, 'enemies.json'), 'utf8'));
      const pack = readPack(EXAMPLE);
      const added = applyPacks({ out: dir, packs: [pack], ctx: ctxOf(dir) });
      assert.deepEqual(added.untagged, [], 'nothing may be refused');
      assert.equal(added.chess.length, 2, '普通 + 精锐');
      assert.equal(added.enemies.length, 1);

      const data = loadData(dir, { log: { warn() {}, error() {}, info() {} } });
      const chess = data.chess;
      const enemies = data.enemies;
      assert.equal(Object.keys(chess).length, Object.keys(before).length + 2);
      assert.equal(Object.keys(enemies).length, Object.keys(beforeEnemies).length + 1);

      const baseId = pack.chess[0].chessId;
      const base = chess[baseId];
      assert.ok(base, `${baseId} is in the merged data`);
      assert.equal(base.pack, 'example', 'and carries its pack tag');
      assert.equal(base.goldenId, `${baseId.slice(0, -1)}b`, 'the 精锐 id follows the official _a → _b convention');

      // what the generator checks for every chess, checked again on the merged pair
      for (const c of [base, chess[base.goldenId]]) {
        assert.ok(c, `${c.chessId} exists`);
        assert.equal(chess[c.baseId], c.baseId === c.chessId ? c : chess[c.baseId], 'baseId resolves');
        assert.ok(chess[c.goldenId], 'goldenId resolves');
        for (const b of c.bonds) assert.ok(data.bonds[b], `${c.chessId}: bond ${b} exists`);
        for (const g of c.garrisonIds) assert.ok(data.garrisons[g], `${c.chessId}: garrison ${g} exists`);
        assert.ok(c.stats && c.skill && Array.isArray(c.rangeGrid), `${c.chessId}: stats / skill / rangeGrid`);
        assert.equal(JSON.stringify(c).includes('"__'), false, 'no template placeholder leaked into the data');
        // exactly one default skill, and it is the chess's own skill
        const defaults = c.skills.filter((s) => s.isDefault);
        assert.equal(defaults.length, 1, `${c.chessId}: exactly one default skill`);
        assert.equal(defaults[0].skillId, c.skill.skillId, `${c.chessId}: the default skill is skill.skillId`);
      }
      // the 精锐 keeps the 普通 numbers as its base (so 不装备模组 can show them) and got its own
      const elite = chess[base.goldenId];
      assert.equal(elite.isGolden, true);
      assert.equal(elite.status.phase, 2);
      assert.equal(elite.status.skillLevel, 7);
      assert.deepEqual(elite.statsBase, base.stats, 'statsBase = the 普通 stats');
      assert.ok(elite.traitBase && Array.isArray(elite.talentsBase), 'traitBase / talentsBase present');
      assert.ok(Array.isArray(elite.modules) && elite.modules.length, 'the example elite has a 模组');
      assert.equal(elite.modules.filter((m) => m.isDefault).length, 1, 'exactly one default 模组');
      assert.equal(elite.module.active, true);
      assert.equal(elite.module.id, elite.modules.find((m) => m.isDefault).uniEquipId);
      // no non-finite number anywhere in the merged records (they would become null in JSON)
      for (const rec of [base, elite, enemies[pack.enemies[0].key]]) {
        const bad = [];
        (function scan(v, p) { if (typeof v === 'number') { if (!Number.isFinite(v)) bad.push(p); return; }
          if (!v || typeof v !== 'object') return;
          for (const [k, x] of Object.entries(v)) scan(x, `${p}.${k}`); })(rec, 'rec');
        assert.deepEqual(bad, []);
      }
      // the enemy honours the game's own MELEE ⇔ rangeRadius 0 contract
      const en = enemies[pack.enemies[0].key];
      if (en.applyWay === 'MELEE') assert.equal(en.stats.rangeRadius, 0);
      else if (en.applyWay === 'RANGED') assert.ok(en.stats.rangeRadius > 0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('the merge is idempotent and reversible', () => {
    const dir = tempData();
    try {
      const pack = readPack(EXAMPLE);
      const originalChess = readFileSync(path.join(dir, 'chess.json'), 'utf8');
      const originalBonds = readFileSync(path.join(dir, 'bonds.json'), 'utf8');
      const originalConfig = readFileSync(path.join(dir, 'config.json'), 'utf8');
      applyPacks({ out: dir, packs: [pack], ctx: ctxOf(dir) });
      const once = readFileSync(path.join(dir, 'chess.json'), 'utf8');
      const second = applyPacks({ out: dir, packs: [pack], ctx: ctxOf(dir) });
      assert.equal(second.written, false, 'a second apply writes nothing');
      assert.equal(readFileSync(path.join(dir, 'chess.json'), 'utf8'), once, 'and the bytes are unchanged');
      // The 盟约 member list moved too, so it has to come back as well — otherwise chess and bonds disagree and
      // data.test.js' two-way bond check fails on seemingly unrelated records.
      assert.notEqual(readFileSync(path.join(dir, 'bonds.json'), 'utf8'), originalBonds, 'the pack joined a 盟约');
      // revert: the tool's own revert (not a hand-rolled delete) must restore the generated files byte for byte
      const back = revertPacks({ out: dir });
      assert.equal(back.chess, 2, 'both the 普通 and its derived 精锐 are removed');
      assert.equal(back.enemies, 1);
      assert.equal(readFileSync(path.join(dir, 'chess.json'), 'utf8'), originalChess, 'revert restores chess.json exactly');
      assert.equal(readFileSync(path.join(dir, 'bonds.json'), 'utf8'), originalBonds, 'and restores bonds.json exactly');
      assert.equal(readFileSync(path.join(dir, 'config.json'), 'utf8'), originalConfig, 'and restores config.json exactly');
      assert.equal(Object.keys(JSON.parse(originalChess)).length, 266, 'the roster is back to the generated 266');
      // idempotent both ways
      assert.equal(revertPacks({ out: dir }).written, false, 'reverting twice changes nothing');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a poolCopies override lands in config.json and revert removes it', () => {
    const dir = tempData();
    try {
      const pack = { pack: 'probe', version: 1, chess: [{ ...readPack(EXAMPLE).chess[0], chessId: 'chess_probe_a', poolCopies: 999999 }], enemies: [] };
      const originalConfig = readFileSync(path.join(dir, 'config.json'), 'utf8');
      applyPacks({ out: dir, packs: [pack], ctx: ctxOf(dir) });
      const cfg = JSON.parse(readFileSync(path.join(dir, 'config.json'), 'utf8'));
      assert.equal(cfg.economy.poolCopiesOverrides.chess_probe_a, 999999, 'override written');
      const chess = JSON.parse(readFileSync(path.join(dir, 'chess.json'), 'utf8'));
      assert.equal('poolCopies' in chess.chess_probe_a, false, 'poolCopies is a shop-weight override, never a chess field');
      revertPacks({ out: dir });
      assert.equal(readFileSync(path.join(dir, 'config.json'), 'utf8'), originalConfig, 'revert restores config.json exactly');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a spine block lands in assets.json and revert removes it', () => {
    const dir = tempData();
    try {
      const pack = { pack: 'probe', version: 1, chess: [], enemies: [], spine: { char_9999_probe: { spine: { front: { skel: '/assets/spine/op/char_9999_probe/front/char_9999_probe.skel' } } } } };
      const originalAssets = readFileSync(path.join(dir, 'assets.json'), 'utf8');
      applyPacks({ out: dir, packs: [pack], ctx: ctxOf(dir) });
      const assets = JSON.parse(readFileSync(path.join(dir, 'assets.json'), 'utf8'));
      assert.equal(assets.chars.char_9999_probe.pack, 'probe', 'spine entry written with pack mark');
      revertPacks({ out: dir });
      assert.equal(readFileSync(path.join(dir, 'assets.json'), 'utf8'), originalAssets, 'revert restores assets.json exactly');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a record that belongs to the game is never overwritten without --force', () => {
    const dir = tempData();
    try {
      const existingId = Object.keys(JSON.parse(readFileSync(path.join(dir, 'chess.json'), 'utf8')))[0];
      const pack = { pack: 'sneaky', version: 1, chess: [{ ...readPack(EXAMPLE).chess[0], chessId: existingId }], enemies: [] };
      const added = applyPacks({ out: dir, packs: [pack], ctx: ctxOf(dir) });
      assert.equal(added.chess.length, 0, 'nothing was added');
      assert.equal(added.written, false, 'and nothing was written');
      assert.equal(added.untagged.length, 1);
      assert.match(added.untagged[0], /已存在/);
      const after = JSON.parse(readFileSync(path.join(dir, 'chess.json'), 'utf8'));
      assert.equal(after[existingId].pack, undefined, 'the game\'s own record is untouched');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ---- the validator must be able to FAIL ------------------------------------------------------------------------------
// Every case below is a mistake an author actually makes; each one has to be caught, or the validator is decoration.

describe('内容包校验器：该拒绝的必须拒绝', () => {
  const dir = tempData();
  const ctx = ctxOf(dir);
  after(() => rmSync(dir, { recursive: true, force: true }));
  const base = () => {
    const p = readPack(EXAMPLE);
    return { pack: 'probe', version: 1, chess: [JSON.parse(JSON.stringify(p.chess[0]))], enemies: [JSON.parse(JSON.stringify(p.enemies[0]))] };
  };
  const errs = (p) => validatePack(p, ctx).errors;
  const expectCaught = (mutate, needle, label) => {
    const p = base();
    mutate(p);
    const found = errs(p);
    assert.ok(found.some((e) => e.includes(needle)), `${label}: expected an error containing '${needle}', got ${JSON.stringify(found)}`);
  };

  test('结构错误', () => {
    expectCaught((p) => { p.pack = 'Bad ID!'; }, 'pack', 'pack id');
    expectCaught((p) => { p.version = 0; }, 'version', 'version');
    expectCaught((p) => { p.chess = []; p.enemies = []; }, 'adds nothing', 'empty pack');
    expectCaught((p) => { p.chess[0].chessId = 'demo_a'; }, 'chessId must look like', 'chess id shape');
    expectCaught((p) => { p.chess[0].name = '  '; }, '.name: required', 'missing name');
    expectCaught((p) => { p.chess[0].profession = 'WIZARD'; }, 'profession', 'unknown profession');
    expectCaught((p) => { p.chess[0].position = 'AIR'; }, 'position', 'unknown position');
    expectCaught((p) => { p.chess[0].attackKind = 'beam'; }, 'attackKind', 'unknown 攻击方式');
    expectCaught((p) => { p.chess[0].tier = 9; }, 'tier', 'tier range');
  });

  test('数值与攻击范围', () => {
    expectCaught((p) => { delete p.chess[0].stats.maxHp; }, 'stats.maxHp', 'missing 生命');
    expectCaught((p) => { p.chess[0].stats.maxHp = 0; }, 'must be > 0', 'zero 生命');
    expectCaught((p) => { p.chess[0].stats.bat = 0; }, 'bat', 'zero 攻击间隔');
    expectCaught((p) => { p.chess[0].stats.def = 'x'; }, 'stats.def', 'non-numeric 防御');
    expectCaught((p) => { delete p.chess[0].rangeGrid; }, 'rangeGrid', 'missing 攻击范围');
    expectCaught((p) => { p.chess[0].rangeGrid = [[1, 0, 0]]; }, 'rangeGrid[0]', 'malformed 攻击范围 tile');
    expectCaught((p) => { p.chess[0].bonds = ['noSuchBond']; }, 'unknown bond', 'unknown 盟约');
  });

  test('技能与精锐', () => {
    expectCaught((p) => { delete p.chess[0].skill; }, '.skill: required', 'missing default skill');
    expectCaught((p) => { p.chess[0].skills = p.chess[0].skills.map((s) => ({ ...s, isDefault: false })); }, 'exactly one entry must have isDefault', 'no default skill');
    expectCaught((p) => { p.chess[0].skills = p.chess[0].skills.map((s) => ({ ...s, isDefault: true })); }, 'exactly one entry must have isDefault', 'two default skills');
    expectCaught((p) => { p.chess[0].skills[0].skillType = 'TOTALLY_FAKE'; }, 'skillType', 'unknown skillType');
    expectCaught((p) => { p.chess[0].goldenId = 'chess_probe_b'; delete p.chess[0].elite; }, 'goldenId', 'goldenId without elite');
    expectCaught((p) => { p.chess[0].elite.isGolden = true; }, 'elite.isGolden', 'authoring what the tool derives');
  });

  test('敌人：MELEE ⇔ rangeRadius 0 这条硬规则', () => {
    expectCaught((p) => { p.enemies[0].applyWay = 'RANGED'; }, 'rangeRadius > 0', 'RANGED with radius 0');
    expectCaught((p) => { p.enemies[0].stats.rangeRadius = 3; }, 'MELEE requires', 'MELEE with a radius');
    expectCaught((p) => { p.enemies[0].rank = 'MEGA'; }, 'rank', 'unknown rank');
    expectCaught((p) => { p.enemies[0].stats.bat = 0; }, 'bat', 'zero 攻击间隔');
    expectCaught((p) => { p.enemies[0].abilities = [{ /* no text */ }]; }, 'abilities[0].text', '能力没有文字');
    expectCaught((p) => { p.enemies[0].skills = [{ cooldown: 1 }]; }, 'prefabKey', '敌人技能没有 prefabKey');
    expectCaught((p) => { p.enemies[0].sp = { type: 'WHENEVER', maxSp: 10 }; }, 'sp.type', 'unknown sp type');
  });

  test('模板本身是合法的（占位符替换后即可通过）', () => {
    for (const [file, id] of [['新干员.template.json', 'chess_tpl_probe_a'], ['新敌人.template.json', 'enemy_tpl_probe']]) {
      const raw = readFileSync(path.join(TEMPLATES, file), 'utf8');
      const filled = raw.split('__SHORT__').join('tpl_probe').split('__ID__').join(id);
      const pack = JSON.parse(filled);
      const { errors } = validatePack(pack, ctx);
      assert.deepEqual(errors, [], `${file} 替换占位符后应当通过：\n${errors.join('\n')}`);
    }
  });

  test('deriveElite 是纯函数：同样的输入给出同样的精锐', () => {
    const rec = readPack(EXAMPLE).chess[0];
    const a = deriveElite(rec, 'chess_x_b');
    const b = deriveElite(rec, 'chess_x_b');
    assert.deepEqual(a, b);
    assert.notEqual(a, rec, 'and it does not mutate / alias the source');
    assert.ok(!rec.isGolden, 'the 普通 record is untouched (it never carries isGolden: true)');
    assert.equal(a.statsBase.maxHp, rec.stats.maxHp);
  });
});

// ---- the shipped content-packs/ directory is a real, working location -------------------------------------------------

test('content-packs/README.md 与工具命令一致', () => {
  const readme = path.join(ROOT, 'content-packs', 'README.md');
  assert.ok(existsSync(readme), 'content-packs/README.md exists (the pack contract)');
  const text = readFileSync(readme, 'utf8');
  for (const cmd of ['list', 'check', 'new chess', 'apply', 'revert']) assert.ok(text.includes(cmd), `README documents \`${cmd}\``);
  assert.ok(existsSync(path.join(ROOT, 'content-packs')), 'the pack directory exists');
});
