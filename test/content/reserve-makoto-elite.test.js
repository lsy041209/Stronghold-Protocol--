// test/content/reserve-makoto-elite.test.js —— **结城理（`char_4217_makoto`）的数据层判据**（第 53 轮 A 重写）。
//
// 这份文件替掉换基座时丢掉的那份同名件，覆盖两件此前**没有判据**的事：
//   ① **U-19「满潜能」口径**：用户 2026-10-07 21:2x 裁定 (A)「我们的新干员与基座一致，按满潜能取值」。
//      真源是上游 0.2.1 自带的 `test/full-potential.test.js` 头注释 + 它的 `frame()`/`steps()`：
//        `stats` = frame(phase, level) + Σ potentialRanks(ADDITION)；天赋取「status 已解锁里
//        `requiredPotentialRank ≤ 5` 的最后一个候选」；`desc` 写**满潜能值**，增量用全角「（+N）」，
//        `descRaw` 把增量包在 `<@ba.talpu>…</>` 里。
//      ⇒ 修前 `makoto.pack.json` 是**潜能 0** 档（atk 643 / cost 16 / 天赋 0.8 / 4.3）⇒ 这条判据当时会红。
//   ② **精锐（`chess_makoto_b`）的派生链**：内容包只写普通记录 + `elite` 块，精锐由工具的 `deriveElite` 派生；
//      「3 张合不成精锐」的根因正是**没有 `elite` 块** ⇒ 这里守住"包声明了 elite ⇒ data 里真的有精锐"。
//
// ⚠️ 本文件**不写树**：全部在 `mkdtempSync` 的临时 data 目录里 `applyPacks`（照 `test/content-packs.test.js` 的做法）。
// ⚠️ 缺 `.cache/gamedata` 时跳过需要官方表的用例（与 `test/full-potential.test.js` 的 `HAS_CACHE` 同法）。
// 跑：node --test test/content/reserve-makoto-elite.test.js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKSPACE = path.resolve(ROOT, '..');
const TOOL = path.join(WORKSPACE, '.workbuddy', 'tools', 'content-packs.mjs');
const { validatePack, applyPacks } = await import('file://' + TOOL.replace(/\\/g, '/'));
const { loadData } = await import('../../server/data.js');

const CH = 'char_4217_makoto';
const PACK = path.join(ROOT, 'content-packs', 'makoto.pack.json');
const CT_PATH = path.join(ROOT, '.cache', 'character_table.json');
const HAS_CT = existsSync(CT_PATH);
const CT = HAS_CT ? JSON.parse(readFileSync(CT_PATH, 'utf8')) : null;
const PACKDATA = JSON.parse(readFileSync(PACK, 'utf8'));
const REC = PACKDATA.chess[0];

/** 一个装有合并所需文件的临时 data 目录（照 content-packs.test.js 的 tempData）。 */
function tempData() {
  const dir = mkdtempSync(path.join(tmpdir(), 'sp-makoto-elite-'));
  for (const f of ['chess', 'enemies', 'bonds', 'garrisons', 'config', 'assets']) {
    copyFileSync(path.join(ROOT, 'data', `${f}.json`), path.join(dir, `${f}.json`));
  }
  return dir;
}
const ctxOf = (dir) => ({
  bonds: JSON.parse(readFileSync(path.join(dir, 'bonds.json'), 'utf8')),
  garrisons: JSON.parse(readFileSync(path.join(dir, 'garrisons.json'), 'utf8')),
});

// ── 官方口径复算（与上游 test/full-potential.test.js 的 frame()/steps() 同法）─────────────────
const FKEY = { MAX_HP: 'maxHp', ATK: 'atk', DEF: 'def', MAGIC_RESISTANCE: 'res', COST: 'cost', RESPAWN_TIME: 'respawnTime', ATTACK_SPEED: 'aspd' };
const potentialSteps = (charId) => {
  const out = {};
  for (const r of CT[charId].potentialRanks || []) {
    for (const m of r.buff?.attributes?.attributeModifiers || []) {
      assert.equal(m.formulaItem, 'ADDITION', `${charId}: 潜能步只能是 ADDITION`);
      assert.ok(FKEY[m.attributeType], `${charId}: 未映射的潜能属性 ${m.attributeType}`);
      out[FKEY[m.attributeType]] = (out[FKEY[m.attributeType]] || 0) + m.value;
    }
  }
  return out;
};
const frame = (charId, phase, level) => {
  const P = CT[charId].phases[phase];
  const k0 = P.attributesKeyFrames[0], k1 = P.attributesKeyFrames[P.attributesKeyFrames.length - 1];
  const t = (level - k0.level) / (k1.level - k0.level || 1);
  const f = (k) => k0.data[k] + (k1.data[k] - k0.data[k]) * t;
  return { maxHp: f('maxHp'), atk: f('atk'), def: f('def'), res: f('magicResistance'), cost: f('cost'), respawnTime: f('respawnTime'), aspd: f('attackSpeed'), bat: f('baseAttackTime') };
};
/**
 * 把一条记录按 U-19(A) 复算，返回**不符的字段清单**（空数组 = 完全合规）。
 * 这是本条判据的**判别力本体**：阴性对照直接把它喂给一条被改坏的记录（见下面第二个用例）。
 */
function potentialMismatches(rec, charId = CH) {
  const exp = frame(charId, rec.status.phase, rec.status.level);
  for (const [k, v] of Object.entries(potentialSteps(charId))) exp[k] += v;
  const bad = [];
  for (const k of ['maxHp', 'atk', 'def', 'res', 'cost', 'respawnTime', 'aspd', 'bat']) {
    if (rec.stats[k] === undefined) continue;
    if (Math.abs(rec.stats[k] - exp[k]) > 0.5 + 1e-9) bad.push(`${k}: 包内=${rec.stats[k]} 满潜能应=${exp[k]}`);
  }
  // 潜能步真的加过吗？（frame 与 满潜能 必须不同，否则这条判据是"永远为真"的噪音）
  const steps = potentialSteps(charId);
  assert.ok(Object.keys(steps).length > 0, `${charId} 必须真的有潜能步 —— 否则下面的自证没有意义`);
  return bad;
}
/** 该 status 已解锁、且 `requiredPotentialRank ≤ 5` 的最后一个天赋候选（= 满潜能档）。 */
const PH = { PHASE_0: 0, PHASE_1: 1, PHASE_2: 2 };
const bestTalent = (t, phase, level) => {
  const ok = (c) => {
    const u = c.unlockCondition;
    const p = PH[u?.phase ?? 'PHASE_0'];
    return (c.requiredPotentialRank || 0) <= 5 && (p < phase || (p === phase && (u?.level || 1) <= level));
  };
  const cands = (t.candidates || []).filter(ok);
  return cands[cands.length - 1] ?? null;
};

describe('结城理精锐（chess_makoto_b）· 数据层', () => {
  test('① 内容包过工具自己的校验，且**声明了 `elite` 块**（精锐是派生的，不是手写两遍）', () => {
    const dir = tempData();
    try {
      const { errors, warnings } = validatePack(PACKDATA, ctxOf(dir));
      assert.deepEqual(errors, [], `makoto.pack.json 应通过校验：\n${errors.join('\n')}`);
      assert.deepEqual(warnings, []);
      assert.ok(REC.elite, 'elite 块必须存在 —— 「3 张合不成精锐」的根因就是它缺了');
      for (const k of ['isGolden', 'goldenId', 'baseId', 'statsBase', 'talentsBase', 'chessId']) {
        assert.equal(REC.elite[k], undefined, `elite.${k} 由工具派生，不许手写`);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('② U-19(A)：普通记录按【满潜能】取值（从官方 character_table 复算，含阴性对照）', { skip: !HAS_CT && '缺 .cache/character_table.json' }, () => {
    // 判据本体
    assert.deepEqual(potentialMismatches(REC), [], '普通记录必须等于 frame(status) + Σ潜能步');

    // 自证：这一档**不是**潜能 0 档 —— 否则"复算通过"可能只是因为两者恰好相等
    const zero = frame(CH, REC.status.phase, REC.status.level);
    assert.notEqual(REC.stats.atk, zero.atk, '满潜能档的 atk 必须与潜能 0 档不同（makoto 潜能 3 = 攻击力+34）');
    assert.notEqual(REC.stats.cost, zero.cost, '满潜能档的 cost 必须与潜能 0 档不同（潜能 1/5 各 部署费用-1）');
    assert.equal(REC.stats.atk - zero.atk, 34, '攻击力步 = +34');
    assert.equal(REC.stats.cost - zero.cost, -2, '部署费用步 = -2');

    // 阴性对照：把这**唯一**两个受潜能影响的字段改回潜能 0 档 ⇒ 判据必须点名它们
    const broken = { ...REC, stats: { ...REC.stats, atk: zero.atk, cost: zero.cost } };
    const bad = potentialMismatches(broken);
    assert.equal(bad.length, 2, `改回潜能 0 档必须被点名两次，实得：${JSON.stringify(bad)}`);
    assert.ok(bad.some((s) => s.startsWith('atk:')), '必须点名 atk');
    assert.ok(bad.some((s) => s.startsWith('cost:')), '必须点名 cost');
  });

  test('③ U-19(A)：天赋取满潜能候选，且 desc / descRaw 用的是上游那套写法', { skip: !HAS_CT && '缺 .cache/character_table.json' }, () => {
    const talents = CT[CH].talents || [];
    let checked = 0;
    // ⚠️ 官方 `talents[]` 的元素**没有 `index` 字段** ⇒ 只能按**数组位置**对应（上游 full-potential.test.js 同法：
    //    `(CT[c.charId].talents || []).forEach((t, index) => … base.find((x) => x.index === index))`）。
    talents.forEach((t, i) => {
      const best = bestTalent(t, REC.status.phase, REC.status.level);
      if (!best || (!best.name && !best.description && !best.blackboard.length && !best.tokenKey)) return;
      const rec = (REC.talents ?? []).find((x) => x.index === i);
      assert.ok(rec, `记录缺 talent ${i}`);
      for (const b of best.blackboard) {
        if (b.valueStr && b.value === 0) continue;
        assert.ok(Math.abs(rec.bb[b.key] - b.value) < 1e-9, `talent ${i} ${b.key}: 记录=${rec.bb[b.key]} 满潜能候选=${b.value}`);
      }
      if ((best.requiredPotentialRank || 0) > 0) {
        checked++;
        // 上游写法：desc 里出现满潜能值 + 全角「（+N）」；descRaw 把增量包在 <@ba.talpu> 里
        assert.match(rec.desc, /（\+\d/, `talent ${i} 的 desc 应带潜能增量写法「（+N）」（上游 268 处都这么写）`);
        assert.match(rec.descRaw, /<@ba\.talpu>（\+\d/,
          `talent ${i} 的 descRaw 应把增量包进 <@ba.talpu>…</>`);
      }
    });
    assert.ok(checked >= 2, `makoto 应有 ≥2 条天赋落在潜能步上（实得 ${checked}）`);
    // 这两个数字是用户裁定 U-19 之后**改过**的：旧版的 0.8 / 4.3 是潜能 0 档
    const t0 = (REC.talents ?? []).find((x) => x.index === 0), t1 = (REC.talents ?? []).find((x) => x.index === 1);
    assert.equal(t0.bb.atk, 0.85, '不羁之力：攻击力 +85%（满潜能；潜能 0 档是 +80%）');
    assert.match(t0.desc, /85%/, 'desc 文本必须与数值同步（§十.2：判据滞后于实现是头号坑）');
    assert.equal(t1.bb.atk_scale, 4.5, 'S.E.E.S.队长：总攻击 450%（满潜能；潜能 0 档是 430%）');
    assert.match(t1.desc, /450%/, 'desc 文本必须与数值同步');
  });

  test('④ 精锐派生的身份链与模组（3 张合一所依赖的那条链）', () => {
    const dir = tempData();
    try {
      const ctx = ctxOf(dir);
      const added = applyPacks({ out: dir, packs: [PACKDATA], ctx });
      assert.deepEqual(added.untagged, [], '不许有被拒绝的记录');
      assert.deepEqual([...added.chess].sort(), ['chess_makoto_a', 'chess_makoto_b'], '普通 + 精锐 两条都要派生出来');
      const chess = JSON.parse(readFileSync(path.join(dir, 'chess.json'), 'utf8'));
      const a = chess.chess_makoto_a, b = chess.chess_makoto_b;
      assert.equal(a.goldenId, 'chess_makoto_b', '普通记录的 goldenId 必须指向精锐（`PlayerState.goldenIdOf` 靠它）');
      assert.equal(a.upgradeChessId, 'chess_makoto_b');
      assert.equal(a.isGolden, false);
      assert.equal(b.isGolden, true, '精锐必须 isGolden');
      assert.equal(b.baseId, 'chess_makoto_a', '精锐的 baseId 指回普通 —— kit 就是靠 baseId 查到 chess_makoto_a 的');
      assert.equal(b.upgradeChessId, null);
      assert.equal(b.status.skillLevel, 7, '精锐 = 专三（skillLevel 7）');
      assert.equal(a.status.skillLevel, 4);
      // 官方 Y 模组「彼此的声音」：uniequip_002_makoto / PUM-Y / 用户拍板「先 1 级」
      assert.equal(b.module.id, 'uniequip_002_makoto');
      assert.equal(b.module.type, 'PUM-Y');
      assert.equal(b.module.level, 1, '用户 2026-10-07 20:5x 拍板：模组**先 1 级**');
      assert.equal(b.status.equipLevel, b.module.level, 'data.test.js 要求 modules[].level === status.equipLevel');
      assert.deepEqual(b.modules.map((m) => m.attr), [{ maxHp: 200, atk: 18, def: 18 }]);
      // 精锐的 stats 必须 == statsBase + 默认模组 attr（上游 test/data.test.js 的规则）
      for (const k of Object.keys(b.stats)) {
        const want = (b.statsBase[k] ?? 0) + (b.modules[0]?.attr?.[k] ?? 0);
        assert.ok(Math.abs(b.stats[k] - want) <= 1e-9, `精锐 stats.${k}: ${b.stats[k]} vs statsBase+attr=${want}`);
      }
      // 派生出来的精锐也要过一遍 U-19 复算的**形状**（数值档见 §4 的已知工具缺口）
      assert.deepEqual(b.talents, b.talentsBase, '1 级模组不改天赋');
      assert.equal(b.talents.find((t) => t.index === 0).bb.atk, 0.85, '精锐继承满潜能天赋');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('⑤ 合并后的 data 能被游戏自己的装载器读进来，且结城理两条记录都在', () => {
    const dir = tempData();
    try {
      applyPacks({ out: dir, packs: [PACKDATA], ctx: ctxOf(dir) });
      const data = loadData(dir, { log: { warn() {}, error() {}, info() {} } });
      assert.ok(data.chess.chess_makoto_a, 'chess_makoto_a 必须进 data');
      assert.ok(data.chess.chess_makoto_b, 'chess_makoto_b 必须进 data');
      assert.equal(data.chess.chess_makoto_a.charId, CH);
      assert.equal(data.chess.chess_makoto_a.isReserve, true, '结城理是**外援**（isReserve）');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
