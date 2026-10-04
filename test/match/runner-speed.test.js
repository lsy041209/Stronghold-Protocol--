// Player speed-up (public/js/battle/runner.js setSpeed): client-local pacing over the deterministic sim.
//
// The sim steps the SAME tick sequence at any speed — speed only changes how fast the runner catches up to the wall
// clock (targetTick). So a faster pace reaches the exact same outcome. This test proves both halves directly:
//   · determinism: the same BattleSpec run at a constant 2× to the end, and run with a mid-flight switch to 4×, end
//     with equal result digests;
//   · continuity: switching speed does not jump the game clock (setSpeed alone steps nothing, and the switch instant
//     keeps the elapsed game time it had reached).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBattleRunner } from '../../public/js/battle/runner.js';
import { resultDigest } from '../../server/sim/spec.js';
import * as simSpec from '../../server/sim/spec.js';
import { DataSource } from '../../server/sim/simdata.js';
import { DATA, makeMatch } from './harness.js';

/** A real authoritative b.start frame (clientCombat), harvested from a harness match. */
function makeSpec() {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 1, bots: 1, seed: 9101, captureFrames: false, clientCombat: true, clients: false });
  h.autoHumans();
  const starts = [];
  h.onSend.push((pid, msg) => { if (msg.t === 'b.start' && msg.authoritative) starts.push(msg); });
  h.m.start();
  h.run(() => starts.length >= 1, { maxSteps: 5e5 });
  h.m.dispose();
  return JSON.parse(JSON.stringify(starts[0]));
}

/** A runner driven by a manual clock (no rAF / timers): `tick(ms)` advances the clock and runs one frame. */
function makeRunner() {
  let now = 1000;
  const runner = createBattleRunner({
    net: { send() {}, request: () => Promise.resolve({ ok: true }), on: () => () => {} },
    store: { patch() {} },
    now: () => now,
    raf() {},
    caf() {},
    setInterval: () => 0,
    clearInterval() {},
    doc: null, // no document: `hidden()` is false, no rAF scheduling
    loadSim: async () => ({ spec: simSpec, ds: new DataSource(DATA, null) }),
  });
  const tick = (ms) => { now += ms; runner._frame(); };
  return { runner, tick };
}

const entryOf = (r) => [...r.runner._entries.values()][0];

test('speed-up keeps the result identical: constant 2× vs 2×→4× mid-flight', async () => {
  const spec = makeSpec();

  const a = makeRunner();
  await a.runner.onStart(spec);
  while (!entryOf(a).battle.finished) a.tick(1000);

  const b = makeRunner();
  await b.runner.onStart(spec);
  b.tick(2000); // a little at 2×
  assert.equal(b.runner.speedOf(), 2);
  b.runner.setSpeed(4); // switch mid-flight
  assert.equal(b.runner.speedOf(), 4);
  while (!entryOf(b).battle.finished) b.tick(1000);

  assert.equal(
    resultDigest(entryOf(a).battle).hash,
    resultDigest(entryOf(b).battle).hash,
    'the same outcome at any pace (speed never enters the sim)',
  );
});

test('switching speed keeps the game clock continuous', async () => {
  const spec = makeSpec();
  const r = makeRunner();
  await r.runner.onStart(spec);
  r.tick(1000); // 1 s at 2× → ~60 ticks
  const e = entryOf(r);
  const ticksBefore = e.battle.tickCount;
  assert.ok(ticksBefore >= 40 && ticksBefore <= 70, `2× for 1 s is ~60 ticks (${ticksBefore})`);

  r.runner.setSpeed(4);
  assert.equal(e.battle.tickCount, ticksBefore, 'setSpeed alone steps nothing — the game clock holds its position');
  assert.equal(r.runner.speedOf(), 4);

  // 1 more second at 4× (~120 ticks/s), no rewind: the tick count only grows from where it was
  r.tick(1000);
  assert.ok(e.battle.tickCount >= ticksBefore + 100, `4× advances ~120 ticks/s (${e.battle.tickCount} ≥ ${ticksBefore + 100})`);
});
