// test/content/reserve-makoto-realpath.test.js —— **结城理的真实路径冒烟**（第 53 轮 A 重写）。
//
// 与 `reserve-makoto.test.js`（注入式）的区别：那一边把 kit 直接塞进 `opts.kits`；
// 这一边走**生产路径**：记录来自**内容包工具的合并产物**（`applyPacks` 进临时 data 目录），
// `content: 'full'`、**不注入 kits** ⇒ kit 必须由 `content/index.js` 的 `kitOf` 按 `def.baseId`
// 从 `kits/index.js → tier3/tier6 → reserve.js → reserve-makoto.js` 自己查到。
//
// 🔴 为什么这条判据值钱：用户实机报的「**范围不变**」在注入式探针里**照不出来**（那一层 kit 是被直接调用的），
//    只有这条路径同时经过"记录 → def → baseId → kit registry → 范围改到玩家看得见的那一层"。
//    ⇒ 断言落在 `unitStatsEntry(u).range`（= `unit.liveRangeGrid`，卡面/场上画的就是它）。
//
// ⚠️ **两态都能跑**：记录是从内容包现算的，不依赖树处于"测试模式"（§五：判据要两态可比）。
// ⚠️ 本文件**不写树**（只在 mkdtemp 里合并）。
// 跑：node --test test/content/reserve-makoto-realpath.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeBattle, enemyRec, checkInvariants } from '../helpers/battleHarness.js';
import { unitStatsEntry } from '../../shared/protocol.js';
import { KITS } from '../../server/sim/content/index.js';
import { diyPool } from '../../shared/diy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKSPACE = path.resolve(ROOT, '..');
const TOOL = path.join(WORKSPACE, '.workbuddy', 'tools', 'content-packs.mjs');
const { applyPacks } = await import('file://' + TOOL.replace(/\\/g, '/'));
const PACK = JSON.parse(readFileSync(path.join(ROOT, 'content-packs', 'makoto.pack.json'), 'utf8'));

const ID = 'chess_makoto_a', ELITE = 'chess_makoto_b';

/** 内容包工具的合并产物（一次性，临时目录，跑完删）。这就是 `data/chess.json` 里会长成的那两条。 */
const APPLIED = (() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sp-makoto-real-'));
  try {
    for (const f of ['chess', 'enemies', 'bonds', 'garrisons', 'config', 'assets']) {
      copyFileSync(path.join(ROOT, 'data', `${f}.json`), path.join(dir, `${f}.json`));
    }
    const ctx = {
      bonds: JSON.parse(readFileSync(path.join(dir, 'bonds.json'), 'utf8')),
      garrisons: JSON.parse(readFileSync(path.join(dir, 'garrisons.json'), 'utf8')),
    };
    const added = applyPacks({ out: dir, packs: [PACK], ctx });
    assert.deepEqual(added.untagged, [], '内容包不许有被拒绝的记录');
    const chess = JSON.parse(readFileSync(path.join(dir, 'chess.json'), 'utf8'));
    return { [ID]: chess[ID], [ELITE]: chess[ELITE] };
  } finally { rmSync(dir, { recursive: true, force: true }); }
})();

const approx = (a, b, eps = 1e-6, msg = '') => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${msg}：${a} ≈ ${b}`);
const S3 = 'skchr_makoto_3';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 🔴🔴 **本文件为什么现在是 SKIP 而不是"绿"**（第 53 轮 A 实测，2026-10-07）：
//
// `kits/reserve-makoto.js` **在树上、且与 0.1.4.1 冷备逐字节相同**（sha `E52A6084DCBA`），
// 但 0.2.1 把 kit 注册表换成了**新的 `kits/index.js`**（10841 B，**overlay 与冷备里都没有** ⇒ 上游新增），
// 它只按 `KIT_FILES` / `STANDIN_KIT_FILES` / `OPERATOR_KIT_FILES` 去 `./ops/<file>` 动态 import，
// **不再 import `reserve.js`**；而 `tier3.js` / `tier6.js`（那两个 `...spread reserveKits` 的旧 shim）
// **在 0.2.1 里没有任何人 import** ⇒ `reserve.js` 成了**死代码**。
//
// 实测：`Object.keys(KITS).length === 209`，7 个外援键（`chess_makoto_a` / `chess_wang_a` / `chess_chen3_a` /
// `chess_hsgma2_a` / `chess_typhon_a` / `chess_ascln_a` / `chess_logos_a`）**一个都不在**。
// ⇒ `kitOf(def)` 查不到 ⇒ 引擎回落到 **generic kit** ⇒ 替身范围不变、天赋加成不生效、总攻击不发动。
//
// 🔴 **这正是"注入式判据"的盲区**：`reserve-makoto.test.js` 把 kit 通过 `opts.kits` 直接塞进去、
// 绕过注册表 ⇒ 它 **10/10 全绿**，而**真实路径是坏的**。本文件就是用来照出这一层的。
// ⇒ 接线落进 `kits/index.js` 之后，下面的 `skip` 会**自动消失**、判据自动生效（不需要改判据）。
const REGISTERED = (() => {
  try { return !!KITS[ID]; } catch { return false; }
})();
const NEEDS_WIRING = !REGISTERED
  && '🔴 A-2 未完成：外援 kit 未接进 0.2.1 的 kit 注册表（kits/index.js 不再 import reserve.js）⇒ 见 协作/已知问题.md 与 协作/交接-A到B-...';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 🔴 **diy（上游自选编队）路的唯一数据前置**（第 54 轮 A 加）。
//
// C 第 4 批 §0.2 裁定：留下的联动**走权威件的 (a) = 上游 `diy` 池**（kit 键 = charId）。那条路的**第一道闸在服务端**：
// `shared/diy.js:163` 的 `checkDiyPick()` —— 一个 pick 的 charId **必须**在 `data/backups.json` 的 `diy.ownedPool` 里，
// 否则整个 loadout 被拒（`<charId> is not a tier-N 自选 pick`）。而 `diy.ownedPool` 是 `tools/build-data.mjs` 从官方
// `character_table` **现算**的（`buildBackups`：`legal6 = 6★ 可获得 且不是名单干员`，再剔除
// `DIY_EXCLUDED_TEAMS = ['rainbow','action4','mujica','sees','laios']` 与 `DIY_EXCLUDED_NUMBER_PREFIXES = ['MH','RS','AM','PS','DD']`）。
//
// 🔴 结城理（`char_4217_makoto`，`displayNumber` `PS33`、`teamId` `sees`）**同时命中两条剔除规则** ⇒ 上游的 `diy` 池
// **在定义上就不含联动干员**（上游 README 自己写着 the collab operators are not included）⇒ **数据不落地，这条路走不通**。
// ⇒ 本文件下面新增的那条判据**带原因 skip**，数据一落地会自动开始判（不需要改判据）。这也是"删除临时桥"的第 ② 个条件。
const BACKUPS = (() => {
  try { return JSON.parse(readFileSync(path.join(ROOT, 'data', 'backups.json'), 'utf8')); } catch { return {}; }
})();
const DIY_SLOT = 'chess_char_6_diy1_a';
const DIY_POOL = diyPool(6, { data: { backups: BACKUPS, chess: APPLIED } });
const NEEDS_DIY_DATA = DIY_POOL.includes('char_4217_makoto') ? false
  : `🔴 走 diy 路缺数据前置（归 B-3 / 数据层）：data/backups.json 的 diy.ownedPool（${(BACKUPS.diy?.ownedPool ?? []).length} 条）不含 char_4217_makoto`
    + '；buildBackups 用 DIY_EXCLUDED_TEAMS(含 sees) ＋ DIY_EXCLUDED_NUMBER_PREFIXES(含 PS) 把联动整类剔除了（上游 README：the collab operators are not included）'
    + '；且 backups.units 里没有他的 diy 形态记录 ⇒ checkDiyPick(shared/diy.js:163) 会拒整个 loadout';

const skillOf = (id, skillId) => {
  const rec = APPLIED[id];
  const s = (rec.skills ?? []).find((x) => x.skillId === skillId);
  assert.ok(s, `${id} 必须有 ${skillId}`);
  return { ...rec, skill: s };
};
const DUMMY = (o = {}) => enemyRec({ key: 'enemy_dummy', hp: 1e5, speed: 0, atk: 0, def: 0, res: 0, ...o });

/** 生产路径的最小战场：`defs` 喂合并产物，`content:'full'`，**kits 不注入**。 */
function arena({ chessId = ID, skillId = S3, row = 10, col = 3, enemy = [10, 4], sp = 0 } = {}) {
  const h = makeBattle({
    defs: { chess: { ...APPLIED, [chessId]: skillOf(chessId, skillId) }, enemies: { enemy_dummy: DUMMY() } },
    content: 'full',
    timeLimit: 60, autoFinish: false, captureNoisy: true,
    units: [{ chessId, row, col, dir: 'RIGHT', carryState: { sp } }],
    enemies: [{ key: 'enemy_dummy', pos: enemy }],
  });
  h.step();
  return { h, u: h.unit(chessId) };
}
const toDoll = ({ h, u }) => h.b.dealDamage(null, u, { amount: 1e9, type: 'true' });   // 官方傀儡师路径：致命伤 ⇒ 替身
const done = (h) => { checkInvariants(h.b); assert.deepEqual(h.b.errors.map((e) => `${e.label} ${e.message}`), []); };
const tagged = (h, tag) => h.hooksOf('damaged').filter((c) => c.dmg?.tags?.includes(tag));

test('前置：kit 真的被 registry 查到了（baseId 链没断）', { skip: NEEDS_WIRING }, () => {
  const { h, u } = arena({});
  assert.equal(u.def.charId, 'char_4217_makoto');
  assert.equal(u.def.baseId, ID, 'kitOf 按 def.baseId 查 => 必须是 chess_makoto_a');
  assert.equal(u.side, 'ally');
  assert.equal(u.kind, 'op');
  // 🔴 真正的守门：kit 必须能被**注册表**查到 —— 这一条就是照出"文件在、接线不在"的那个断言
  assert.equal(typeof KITS[ID], 'function', `外援 kit 必须真的接进 KITS（键 = chess baseId）；现在 KITS[${ID}] = ${typeof KITS[ID]}`);
  assert.equal(u.form, null, '开局是本体（没有 form）');
  done(h);
});

test('🔴 范围（用户实机报的「范围不变」）：替身的作战范围 = 技能的 `x-1`（13 格），切回还原', { skip: NEEDS_WIRING }, () => {
  const { h, u } = arena({});
  const bodyRange = unitStatsEntry(u).range;
  const skillGrid = APPLIED[ID].skills.find((s) => s.skillId === S3).rangeGrid;

  // 自证：这一档**真的有判别力** —— 本体射程（1-1，2 格）与替身射程（x-1，13 格）不是一回事
  assert.equal(bodyRange.length, 2, '本体 `1-1` = 2 格（官方）');
  assert.equal(skillGrid.length, 13, '技能 `x-1` = 13 格（官方）');
  const bodyKeys = new Set(bodyRange.map((p) => p.join(',')));
  const only = skillGrid.filter((p) => !bodyKeys.has(p.join(',')));
  assert.ok(only.length >= 5, `必须有足够多"只有 x-1 才有"的格，否则这条判据没有牙（实得 ${only.length}）`);

  toDoll({ h, u });
  h.run(1.2);                                   // 过切换动画
  assert.equal(u.form, 'doll', '进了替身');
  const dollRange = unitStatsEntry(u).range;
  assert.ok(dollRange, '替身必须带 range（`liveRangeGrid`）');
  assert.deepEqual([...dollRange].map((p) => p.join(',')).sort(), [...skillGrid].map((p) => p.join(',')).sort(),
    '替身的作战范围必须逐格等于技能的 `x-1` —— 这正是用户看到的"范围不变"那一处');

  // 切回本体 ⇒ 范围必须还原（不能把 13 格永久留下）
  h.b.removeBuff(u, 'trait:substitute');
  h.run(0.2);
  assert.deepEqual(unitStatsEntry(u).range, bodyRange, '替身结束必须把范围还原成本体的 2 格');
  done(h);
});

test('形态：S3 的 P1（塔纳托斯·改）受致命伤 ⇒ 切 P2（俄耳甫斯·改），且发 form 字段给显示层', { skip: NEEDS_WIRING }, () => {
  const { h, u } = arena({});
  toDoll({ h, u });
  h.run(1.2);
  assert.equal(u.form, 'doll', 'S3 的 P1 形态名仍是 doll（按 skillIndex 在 FORMS 里选）');
  const before = h.hooksOf('damaged').length;
  h.b.dealDamage(null, u, { amount: 1e9, type: 'true' });      // P1 吃致命伤 ⇒ 第二替身
  h.run(0.2);
  assert.equal(u.form, 'doll_orpheus', '第二替身 = 俄耳甫斯·改（P2）');
  assert.equal(u.s.blockCnt, 2, 'P2 恢复阻挡 2（P1 是 0）');
  assert.equal(u.flags?.disarm, true, 'P2 禁普攻');
  assert.ok(h.hooksOf('damaged').length > before);
  done(h);
});

test('🔴 U-19(A) 落到真实路径：天赋1 总攻击 = 450% 攻击力真实伤害（不是潜能 0 档的 430%）', { skip: NEEDS_WIRING }, () => {
  const { h, u } = arena({});
  toDoll({ h, u });
  h.run(1.2);
  assert.ok(u.trait.doll, '前置：在替身里');
  const before = tagged(h, 'makotoAllOut').length;
  h.b.removeBuff(u, 'trait:substitute');        // 替身结束（等价 20 秒到点）
  h.run(0.2);
  const out = tagged(h, 'makotoAllOut').slice(before);
  assert.ok(out.length >= 1, '替身结束后必须发动总攻击');
  assert.equal(out[0].dmg.type, 'true', '总攻击是真实伤害');
  approx(out[0].amount, u.s.atk * 4.5, 0.05, '满潜能 450% 攻击力');
  assert.notEqual(u.s.atk * 4.3, out[0].amount, '必须**不是**潜能 0 档的 430%（否则说明包没升档）');
  done(h);
});

test('精锐（Y 模组「彼此的声音」）的替身生命 = 天赋0 +35% **再加**模组特性 +20%（带阴性对照）', { skip: NEEDS_WIRING }, () => {
  const ratioOf = (chessId) => {
    const { h, u } = arena({ chessId });
    const hp0 = u.base.maxHp;
    toDoll({ h, u });
    h.run(1.2);
    return u.s.maxHp / hp0;
  };
  const normal = ratioOf(ID);
  const elite = ratioOf(ELITE);
  // ⚠️ 两个 `statBuff` 的 **hpPct 是相加**的（不是相乘）：1 + 0.35 + 0.20 = 1.55。
  //    （本人第一版按 1.35 × 1.2 = 1.62 断，实测 1.55 ⇒ **是判据写错了，不是数据错**，已按实测口径改正。）
  approx(normal, 1.35, 0.02, '普通记录的替身：只有天赋0 的 +35%');
  approx(elite, 1.55, 0.02, '精锐的替身：天赋0 +35% ＋ 模组特性 `bb.max_hp` +20%（相加）');
  assert.ok(elite > normal + 0.1, '阴性对照：精锐必须**明显**高于普通（否则模组特性没被读到）');
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 🔴 **diy（上游自选编队）路的闸**（第 54 轮 A 加；C 第 4 批 §0.2 裁定 = 权威件的 (a)）
//
// 上面那五条走的是 `chessId = chess_makoto_a`（**临时桥**喂进注册表的键）。它证明的是"kit 本身是对的"，
// **不是**"玩家能玩到"：真正上场的形态是**上游 `diy` 池的自选 piece**（`def.diyFor` ＋ `def.charId`）。
// 下面两条把那个形态钉住 —— 数据前置没落地时，第二条**带原因 skip**、第一条**红**（诚实，而不是拿桥的绿当"能玩"）。

test('🔴 走 diy 路的第一步（数据层前置）：`diy.ownedPool` 必须含 char_4217_makoto（恒跑，未落地即红）', () => {
  const pool = BACKUPS.diy?.ownedPool ?? [];
  assert.ok(pool.includes('char_4217_makoto'),
    `diy.ownedPool（现在 ${pool.length} 条）必须含 char_4217_makoto —— 否则 shared/diy.js:163 的 checkDiyPick 直接拒整个 loadout`
    + '（服务端硬闸，与客户端选择器无关）。落点是数据层：`tools/build-data.mjs` 的 buildBackups（DIY_EXCLUDED_TEAMS 含 sees、'
    + 'DIY_EXCLUDED_NUMBER_PREFIXES 含 PS）＋ `data/backups.json` 的 `diy.operators` / `units.<charId>.forms`。');
});

test('🔴 走 diy 路（生产路径，不注入 kits）：自选 piece 上场 ⇒ kit 被按 charId 查到、替身范围 = x-1 13 格（数据未落地则带原因 skip）', { skip: NEEDS_DIY_DATA }, () => {
  const h = makeBattle({
    defs: { chess: { ...APPLIED }, enemies: { enemy_dummy: DUMMY() } },
    content: 'full', timeLimit: 60, autoFinish: false, captureNoisy: true,
    units: [{ diy: { slot: DIY_SLOT, charId: 'char_4217_makoto', skillIndex: 2 }, row: 10, col: 3, dir: 'RIGHT', carryState: { sp: 0 } }],
    enemies: [{ key: 'enemy_dummy', pos: [10, 4] }],
  });
  h.step();
  const u = h.unit(0) ?? h.allies()[0];
  assert.ok(u, '自选 piece 必须真的上场（checkDiyPick 过了）');
  assert.equal(u.def.charId, 'char_4217_makoto', 'def.charId = 被选中的干员');
  assert.equal(u.def.diyFor, DIY_SLOT, 'def.diyFor = 自选槽 ⇒ kitOf 走 isOtherBody 分支、按 charId 查');
  assert.equal(typeof KITS['char_4217_makoto'], 'function', 'kit 必须被注册表按 charId 查到');

  const skillGrid = APPLIED[ID].skills.find((s) => s.skillId === S3).rangeGrid;
  assert.equal(skillGrid.length, 13, '前置：技能 `x-1` = 13 格（官方）');
  const bodyRange = unitStatsEntry(u).range;
  assert.equal(bodyRange.length, 2, '前置：本体 `1-1` = 2 格');

  toDoll({ h, u });
  h.run(1.2);
  assert.equal(u.form, 'doll', '进了替身');
  assert.deepEqual([...unitStatsEntry(u).range].map((p) => p.join(',')).sort(), [...skillGrid].map((p) => p.join(',')).sort(),
    '替身的作战范围必须逐格等于技能的 `x-1`（这就是用户实机报的「范围不变」那一处）');
  done(h);
});
