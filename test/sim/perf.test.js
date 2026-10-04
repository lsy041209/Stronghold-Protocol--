// Performance: a normal battle with ~70 enemies + 10 operators must average < 0.5 ms per tick (DESIGN §11).
//
// The bar is asserted only when the run declares itself a perf run (`SP_PERF=1`, like the `SP_E2E` opt-ins) — see the
// header of test/sim/robustness.test.js for the measurements and the reasoning. In short, on a box that runs the whole
// `node --test` suite at once (16 concurrent test files here) the same code measures 32 / 60 µs per tick alone and
// 368 / 597 µs per tick inside that suite: that is the runner saturating the machine, not a regression, so a wall-clock
// budget cannot be judged there. The two worst-case workloads still run in every suite (they are the ones that catch a
// crash, a hang or a runaway spawn loop on the heavy field) and always print their per-tick cost.
//
//   SP_PERF=1 node --test test/sim/perf.test.js        # assert the 0.5 ms bars
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Battle } from '../../server/sim/Battle.js';
import { getDefaultSource, spawnsFromTemplate } from '../../server/sim/simdata.js';

const ds = getDefaultSource();
const quiet = { error() {}, warn() {} };
const BAR_MS_PER_TICK = 0.5;
const PERF_RUN = process.env.SP_PERF === '1';
const TIMING_SKIP = `set SP_PERF=1 (a dedicated perf run): the ${BAR_MS_PER_TICK} ms bar is DESIGN §11's budget for a machine running this file alone, and an all-core parallel \`node --test\` on a shared box measures ~10× that for the same code`;
const LINEUP = [
  ['chess_char_1_02_a', 9, 7], ['chess_char_2_09_a', 9, 4], ['chess_char_4_09_a', 12, 5], ['chess_char_3_08_a', 12, 7],
  ['chess_char_1_01_a', 10, 4], ['chess_char_1_03_a', 11, 4], ['chess_char_2_02_a', 12, 4], ['chess_char_2_14_a', 10, 5],
  ['chess_char_5_12_a', 11, 5], ['chess_char_6_13_a', 9, 8],
];

function build(spawns, routes, timeLimit, seed = 7) {
  return new Battle({
    seed, kind: 'normal', stageId: 'act2autochess_m01', routes, spawns, timeLimit, logger: quiet, quiet: true,
    players: [{ playerId: 'p', units: LINEUP.map(([chessId, row, col], i) => ({ uid: i + 1, kind: 'chess', chessId, row, col, abs: true })) }],
  });
}

/** The 70-enemy wave (h05) + 10 operators, twice warmed up, measured once. Memoized for the speed bar below. */
let wave = null;
function measureWave() {
  if (!wave) {
    const tpl = ds.getWave('act1autochess_h05');
    const { routes, spawns, maxPlayTime } = spawnsFromTemplate(tpl, { mods: { hpMul: 3 } });
    // warm-up (JIT)
    for (let i = 0; i < 2; i++) { const w = build(spawns, routes, maxPlayTime, i + 100); while (!w.finished) w.step(); }
    const b = build(spawns, routes, maxPlayTime);
    let n = 0, maxAlive = 0;
    const t0 = performance.now();
    while (!b.finished) {
      b.step();
      n++;
      if (n % 3 === 0) { b.snapshot(); b.drainEvents(); }
      if (b.enemies.length > maxAlive) maxAlive = b.enemies.length;
    }
    wave = { n, total: b.total, peak: maxAlive, reason: b.reason, avg: (performance.now() - t0) / n };
    // eslint-disable-next-line no-console
    console.log(`bench wave: ${n} ticks, total ${b.total} enemies, peak ${maxAlive} alive, avg ${(wave.avg * 1000).toFixed(1)} µs/tick, reason ${b.reason}${PERF_RUN ? '' : ' (bar not asserted: SP_PERF=1)'}`);
  }
  return wave;
}

/** 70 enemies alive at once + 10 operators, twice warmed up, measured once. Memoized for the speed bar below. */
let worst = null;
function measureWorst() {
  if (!worst) {
    const tpl = ds.getWave('act1autochess_h05');
    const { routes } = spawnsFromTemplate(tpl);
    const keys = ['enemy_1422_lrsldr', 'enemy_1427_lrnazg', 'enemy_1005_yokai', 'enemy_1042_frostd', 'enemy_1425_lrcmra', 'enemy_1040_bombd'];
    const spawns = [];
    for (let i = 0; i < 70; i++) spawns.push({ time: (i % 10) * 0.2, enemyKey: keys[i % keys.length], routeIndex: i % routes.length, mods: { hpMul: 10 } });
    for (let i = 0; i < 2; i++) { const w = build(spawns, routes, 20, 50 + i); while (!w.finished) w.step(); }
    const b = build(spawns, routes, 60);
    let n = 0;
    const t0 = performance.now();
    while (!b.finished && b.time < 40) { b.step(); n++; if (n % 3 === 0) { b.snapshot(); b.drainEvents(); } }
    worst = { n, alive: b.enemies.length, avg: (performance.now() - t0) / n };
    // eslint-disable-next-line no-console
    console.log(`bench worst: ${n} ticks, ${b.enemies.length} alive at end, avg ${(worst.avg * 1000).toFixed(1)} µs/tick${PERF_RUN ? '' : ' (bar not asserted: SP_PERF=1)'}`);
  }
  return worst;
}

test('benchmark workload: the 70-enemy wave (h05) + 10 operators runs and clears', () => {
  const r = measureWave();
  assert.ok(r.total >= 60, `total ${r.total}`);
  assert.ok(r.n > 0 && r.reason !== 'error', `reason ${r.reason}`);
});

test('benchmark workload: 70 enemies alive at once + 10 operators runs to the time limit', () => {
  const r = measureWorst();
  assert.ok(r.n > 0, 'the battle stepped');
  assert.ok(r.alive > 0, `${r.alive} enemies alive at the end of the run`);
});

test('benchmark: 70-enemy wave (h05) + 10 operators < 0.5 ms/tick average', { skip: !PERF_RUN && TIMING_SKIP }, () => {
  assert.ok(measureWave().avg < BAR_MS_PER_TICK, `avg ${measureWave().avg} ms/tick`);
});

test('benchmark: worst case — 70 enemies alive at once + 10 operators < 0.5 ms/tick', { skip: !PERF_RUN && TIMING_SKIP }, () => {
  assert.ok(measureWorst().avg < BAR_MS_PER_TICK, `avg ${measureWorst().avg} ms/tick`);
});
