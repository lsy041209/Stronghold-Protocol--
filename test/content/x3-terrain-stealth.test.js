// test/content/x3-terrain-stealth.test.js —— **X-3：地形/环境伤害对【隐匿】单位照常生效**（第 54 轮 A 新写的探针）。
//
// 为什么单独一条：这是一条**用户裁定的口径**，不是普通逻辑，所以必须有判据把它钉住 ——
//   · 用户 **2026-10-07 10:0x** 逐字问法：「隐匿的干员站在活性源石/深水里要不要也免伤？」
//     ⇒ 答案：**「照常吃（保持现状）」**（`content/devices.js` 的两处裁定注释 ＋ `协作/已知问题.md` 的口径节）。
//   · 依据（引擎侧，可读代码）：地形伤害是 `battle.dealDamage(null, …)`（**无来源**）⇒ **不经过索敌**；
//     隐匿的效力在**索敌那一层**（`targeting.js:110`：`ranged && (f.stealth || f.camou) && e.blockedBy !== a ⇒ false`），
//     而 `damage.js` 的 `liftoffEvades()`（:139-140）只管**起飞**（`liftoff`），**不管隐匿**。
//   · 对照（**要**守隐匿的是另一类）：毒圈/敌方光环（`content/enemies.js` 的 `pollution()` / `kitChimera`）。
//
// 🔴 **本判据的性质（写清楚，免得被误读成"回归"）**：第 1 条在我写下的那一刻就是**绿**的 ——
//   因为 0.2.1 换基座**只丢了 `devices.js` 里那两段裁定注释**，行为本身两版**逐字相同**（我实测过函数体）。
//   ⇒ 它的作用是**回归守卫 ＋ 裁定落地**：任何人日后"顺手"给地形加一个隐匿闸，它会立刻红。
//   ⇒ 它同时是 `patch-game` 那条 `缺少标记 server/sim/content/devices.js → 有意照常` 的**判据面**。
//
// ⚠️ 我第一版这文件里有**两条判据是错的**（都被它自己当场抓出来，改法留在此处当证据）：
//   ① 「深水对**友方**也该掉血」✗ —— `devices.js:429` 明写 `if (code === TERRAIN.deepsea && u.side === 'ally') code = 0;`
//      ⇒ **友方在深水里按设计就不吃水蚀**（水蚀是对敌方的）。是**判据错，不是代码错**。
//   ② 「有来源的伤害一律打不中隐匿」✗ —— 隐匿只在**索敌**那一层生效；直接调 `dealDamage(src, …)` 不受它管。
//      而"隐匿 vs 远程敌人"这颗**已有判据**（`test/sim/playtest5-targeting.test.js:311`）⇒ 我不重复造。
//
// 跑：node --test test/content/x3-terrain-stealth.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, chessRec, enemyRec, checkInvariants } from '../helpers/battleHarness.js';
import { hasGeneratedData, getDefaultSource } from '../../server/sim/simdata.js';
import { terrainAt } from '../../server/sim/content/devices.js';

const REAL = { skip: !hasGeneratedData() };
const ds = getDefaultSource();
const approx = (a, b, tol = 1e-6, msg = '') => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${msg} ${a} ≈ ${b}`);

/** 一个隐身的友方（PROTECTOR ⇒ **自己不攻击**，所以掉的血只能来自地形）。 */
const ghost = (o = {}) => chessRec({ id: 'test_ghost', profession: 'PROTECTOR', skill: null, stats: { atk: 0, maxHp: 100000, def: 0, blockCnt: 2 }, ...o });
/** 占位敌人：atk 0、不动 ⇒ 保证战场成立但绝不参与伤害。 */
const idle = () => enemyRec({ key: 'enemy_idle', hp: 100000, speed: 0, atk: 0 });

test('🔴 X-3：活性源石的环境伤害**照常**打在【隐匿】单位身上（用户 2026-10-07 10:0x 裁定：照常吃）', REAL, () => {
  const bb = ds.getStage('act1autochess_m04').special.infection.bb;
  const h = makeBattle({
    stageId: 'act1autochess_m04',
    defs: { chess: { test_ghost: ghost() }, enemies: { enemy_idle: idle() } },
    units: [{ chessId: 'test_ghost', row: 11, col: 6 }],
    enemies: [{ key: 'enemy_idle', pos: [9, 6] }],
    autoFinish: false, timeLimit: 60,
  });
  h.step();
  const u = h.unit('test_ghost');
  assert.ok(u, '单位必须上场');
  assert.equal(terrainAt(h.b, 11, 6), 'infection', '前置：它站在活性源石上');

  h.b.applyStatus(u, 'stealth', { duration: 999 });      // 隐匿（buffs.js:89 里 stealth 是合法状态键）
  assert.ok(u.s.flags.stealth, '前置：隐匿真的挂上了');

  const hp0 = u.hp;
  h.run(3);
  const lost = hp0 - u.hp;
  assert.ok(lost > 0, `🔴 隐匿单位必须**照常吃**环境伤害，实际掉了 ${lost}（若为 0 ⇒ 有人给地形加了隐匿闸，与用户裁定相反）`);
  approx(lost, 3 * bb.damage, 0.34, '3 秒 ≈ 3 × bb.damage（容差 ±1 跳）');
  approx(u.stats.taken, lost, 0.02, '计入 taken 的必须与掉血量一致（不是"免伤但记账"）');
  checkInvariants(h.b);
});

test('🔴 X-3（阴性对照）：**同样掉血，与隐匿无关** —— 关掉隐匿、且场上没有任何伤害来源，掉的血一模一样', REAL, () => {
  // 为什么这条是必要的：上面那条只证明"隐匿单位掉了血"。必须排除"它是被敌人打的"这个解释。
  // ⚠️ 我第一版这条写错了两次（都留在此处当证据）：
  //   ① 「深水对**友方**也该掉血」✗ —— `devices.js:429` 明写 `if (code === TERRAIN.deepsea && u.side === 'ally') code = 0;`
  //      ⇒ **友方在深水里按设计就不吃水蚀**（水蚀是对敌方的）。是**判据错，不是代码错**。
  //   ② 「有来源的伤害一律打不中隐匿」✗ —— 隐匿只在**索敌**那一层（`targeting.js:110`）生效。
  //      而且**时序有牙**：`h.step()` 后敌人会**当场打第一发**（`enemyRec` 的 `bat` 改不动敌人的 `interval`，实测恒为 1）
  //      ⇒ "跑一会儿再挂隐匿"永远会漏掉那一发。所以我改成**根本不放任何伤害来源**：
  //      ⇒ 掉的血只可能来自脚下的地形，安静且确定。（"隐匿 vs 远程敌人"那颗已有判据：`test/sim/playtest5-targeting.test.js:311`）
  const bb = ds.getStage('act1autochess_m04').special.infection.bb;
  const h = makeBattle({
    stageId: 'act1autochess_m04',
    defs: { chess: { test_ghost: ghost() }, enemies: { enemy_idle: idle() } },
    units: [{ chessId: 'test_ghost', row: 11, col: 6 }],
    enemies: [{ key: 'enemy_idle', pos: [9, 6] }],     // atk 0、不动 ⇒ 绝不参与伤害
    autoFinish: false, timeLimit: 60, captureNoisy: true,
  });
  h.step();
  const u = h.unit('test_ghost');
  assert.ok(!u.s.flags.stealth, '前置：这一条**故意不挂**隐匿');
  assert.equal(terrainAt(h.b, 11, 6), 'infection', '前置：同一格活性源石');
  const hp0 = u.hp;
  h.run(3);
  const lost = hp0 - u.hp;
  const fromAnyone = h.hooksOf('damaged').filter((c) => c.target === u && c.source).reduce((a, c) => a + c.amount, 0);
  assert.equal(fromAnyone, 0, '全场只有地形在造成伤害（这就是"照常"的来源）');
  approx(lost, 3 * bb.damage, 0.34, '3 秒 ≈ 3 × bb.damage（与上面那条一致）');
  checkInvariants(h.b);
});
