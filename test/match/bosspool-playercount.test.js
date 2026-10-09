// F-5 — 多人联机 BOSS 血量按【开局玩家数】缩放（协作/C给D-F5-BOSS血量按人数缩放-2026-10-06.md，用户裁决 2026-10-06）:
//
//   N_eff   = min(seatsFull = 4, 真人数 + AI数 × aiWeight = 0.5)
//   f(难度) = 1 + (coopCap4[难度] − 1) × (N_eff − 1) / 3        # 仅 mode_multi_*
//   pool    = Math.round(bloodPoint[difficulty] × f)
//   coopCap4: FUNNY 1 | NORMAL 2 | HARD 3 | ABYSS 4              # 只有终极能到 ×4
//   mode_single_*: 不动（仍 ×0.25）
//
// 轴的区别（本单的关键）：`aliveCount` 是"开打时还活着几个"（`aliveScaling` 的轴，本单不开），
// 本单缩的是**开局座位构成**（几个真人 / 几个 AI）⇒ 走 `GameData.setRoster()`，由 `Match` 开局接线。
// **未设 roster ⇒ 与旧口径逐位一致**（回归 `pick('coop', 1)`）—— 这是"40 个 bloodPoint 基准值不许变"的保证。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameData } from '../../server/match/gamedata.js';
import { DATA, makeMatch } from './harness.js';

const gd = (modeId) => new GameData(DATA, modeId);
/** a GameData of `modeId` with the match's opening roster handed to it (what Match does at start) */
const withRoster = (modeId, humans, bots) => { const g = gd(modeId); g.setRoster({ humans, bots }); return g; };
/** GameData of `modeId` with a mode-level `bossHpScale` merged into the real data (parameter overrides) */
const withModeScale = (modeId, scale) => {
  const mode = DATA.config.modes[modeId];
  return new GameData({ ...DATA, config: { ...DATA.config, modes: { ...DATA.config.modes, [modeId]: { ...mode, bossHpScale: { ...(mode.bossHpScale || {}), ...scale } } } } }, modeId);
};

// 胄 (boss_1) 的基准 —— data/bosses.json 的 bloodPoint*，**基准值本身不许变**（bosshp.test.js 钉的就是它们）
const BP = DATA.bosses.boss_1.bloodPoint;

test('F-5 终极(ABYSS)：领袖池按开局座位构成缩放 —— 4/3/2 真人 ⇒ ×4/×3/×2，1 真人 + 3 AI ⇒ ×2.5', () => {
  assert.deepEqual([BP.FUNNY, BP.NORMAL, BP.HARD, BP.ABYSS], [247500, 675000, 1800000, 3600000], '胄的四个基准（不许变）');
  const pool = (humans, bots) => withRoster('mode_multi_abyss', humans, bots).bossPoolHp('boss_1');
  // 定稿实算表（单子 §3.2）
  assert.equal(pool(4, 0), 14400000, '4 真人 ⇒ N_eff 4 ⇒ ×4');
  assert.equal(pool(3, 0), 10800000, '3 真人 ⇒ N_eff 3 ⇒ ×3');
  assert.equal(pool(2, 0), 7200000, '2 真人 ⇒ N_eff 2 ⇒ ×2');
  assert.equal(pool(1, 3), 9000000, '1 真人 + 3 AI ⇒ N_eff 2.5 ⇒ ×2.5');
  assert.equal(pool(2, 2), 10800000, '2 真人 + 2 AI ⇒ N_eff 3 ⇒ ×3');
  assert.equal(pool(1, 1), 5400000, '1 真人 + 1 AI ⇒ N_eff 1.5 ⇒ ×1.5');
  assert.equal(pool(1, 0), 3600000, 'multi 但 1 真人 0 AI ⇒ ×1（不是单人的 0.25，单子 §3.3）');
  assert.equal(pool(3, 1), 12600000, '3 真人 + 1 AI ⇒ N_eff 3.5 ⇒ ×3.5');
});

test('F-5 边角：N_eff 上限 = seatsFull 4（4 真人 + 4 AI 仍 ×4）', () => {
  const p = (h, b) => withRoster('mode_multi_abyss', h, b).bossPoolHp('boss_1');
  assert.equal(p(4, 0), 14400000);
  assert.equal(p(4, 4), 14400000, '4 真人 + 4 AI ⇒ min(4, 4 + 2) = 4 ⇒ ×4');
  assert.equal(p(10, 10), 14400000, '同上（座位本来就最多 4）');
  assert.equal(p(0, 4), 7200000, '0 真人 + 4 AI ⇒ N_eff 2 ⇒ ×2（AI 半个人）');
});

test('F-5 非终极三档：FUNNY 恒 ×1、NORMAL 4 真人 ×2、HARD 4 真人 ×3', () => {
  for (const n of [1, 2, 3, 4]) {
    assert.equal(withRoster('mode_multi_funny', n, 0).bossPoolHp('boss_1'), BP.FUNNY, `FUNNY ${n} 真人 ⇒ ×1（coopCap4 = 1）`);
    assert.equal(withRoster('mode_multi_funny', n, 4).bossPoolHp('boss_1'), BP.FUNNY, `FUNNY ${n} 真人 + AI ⇒ 仍 ×1`);
  }
  const normal = (h, b) => withRoster('mode_multi_normal', h, b).bossPoolHp('boss_1');
  assert.equal(normal(4, 0), 1350000, 'NORMAL 4 真人 ⇒ ×2（coopCap4 = 2）');
  assert.equal(normal(2, 0), 900000, 'NORMAL 2 真人 ⇒ N_eff 2 ⇒ ×4/3');
  assert.equal(normal(1, 0), BP.NORMAL, 'NORMAL 1 真人 ⇒ ×1');
  const hard = (h, b) => withRoster('mode_multi_hard', h, b).bossPoolHp('boss_1');
  assert.equal(hard(4, 0), 5400000, 'HARD 4 真人 ⇒ ×3（coopCap4 = 3）');
  assert.equal(hard(2, 0), 3000000, 'HARD 2 真人 ⇒ N_eff 2 ⇒ ×5/3');
  assert.equal(hard(1, 0), BP.HARD, 'HARD 1 真人 ⇒ ×1');
});

test('F-5 单人模式不动：mode_single_* 仍 ×0.25，与人数无关', () => {
  for (const [modeId, base] of [['mode_single_funny', BP.FUNNY], ['mode_single_normal', BP.NORMAL], ['mode_single_hard', BP.HARD], ['mode_single_abyss', BP.ABYSS]]) {
    const want = Math.max(1, Math.round(base * 0.25));
    for (const [h, b] of [[1, 0], [1, 3], [4, 0]]) {
      assert.equal(withRoster(modeId, h, b).bossPoolHp('boss_1'), want, `${modeId}: ${h} 真人 + ${b} AI ⇒ 仍 ×0.25`);
    }
  }
});

test('F-5 向后兼容：未设 roster ⇒ 与旧口径逐位一致（coop ×1 回归）；playerScaling:false ⇒ 退回旧行为', () => {
  for (const modeId of ['mode_multi_funny', 'mode_multi_normal', 'mode_multi_hard', 'mode_multi_abyss']) {
    const g = gd(modeId);
    const want = BP[DATA.config.modes[modeId].difficulty];
    for (const n of [undefined, 1, 2, 4, 9]) {
      assert.equal(g.bossPoolHp('boss_1', n), want, `${modeId}: 未设 roster，aliveCount ${n} ⇒ 旧值`);
    }
  }
  const off = withModeScale('mode_multi_abyss', { playerScaling: false });
  off.setRoster({ humans: 4, bots: 0 });
  assert.equal(off.bossPoolHp('boss_1'), BP.ABYSS, '总开关显式 false ⇒ 退回旧行为（×1）');
});

test('F-5 参数可从 mode 的 bossHpScale 覆盖（aiWeight / seatsFull），缺省用 0.5 / 4', () => {
  const w1 = withModeScale('mode_multi_abyss', { aiWeight: 1 });
  w1.setRoster({ humans: 1, bots: 3 });
  assert.equal(w1.bossPoolHp('boss_1'), 14400000, 'aiWeight 覆盖为 1 ⇒ AI 算一个人 ⇒ N_eff 4 ⇒ ×4');
  const s2 = withModeScale('mode_multi_abyss', { seatsFull: 2 });
  s2.setRoster({ humans: 4, bots: 0 });
  assert.equal(s2.bossPoolHp('boss_1'), 7200000, 'seatsFull 覆盖为 2 ⇒ N_eff 2 ⇒ ×2');
  const cap = withModeScale('mode_multi_abyss', { coopCap4: 2 });
  cap.setRoster({ humans: 4, bots: 0 });
  assert.equal(cap.bossPoolHp('boss_1'), 7200000, 'coopCap4 覆盖为 2 ⇒ 4 真人只 ×2');
});

test('F-5 接线：Match 开局把座位构成交给 GameData（本单在 Match.js 只加一行 setRoster）', () => {
  for (const [humans, bots, want] of [[4, 0, 14400000], [3, 0, 10800000], [2, 0, 7200000], [1, 3, 9000000]]) {
    const h = makeMatch({ mode: 'coop', difficulty: 'ABYSS', humans, bots, seed: 5 });
    assert.equal(h.m.modeId, 'mode_multi_abyss');
    assert.equal(h.m.gd.bossPoolHp('boss_1'), want, `${humans} 真人 + ${bots} AI 的 ABYSS 池`);
  }
  const solo = makeMatch({ mode: 'solo', difficulty: 'ABYSS', humans: 1, seed: 5 });
  assert.equal(solo.m.gd.bossPoolHp('boss_1'), Math.round(BP.ABYSS * 0.25), '单人局仍 ×0.25');
});
