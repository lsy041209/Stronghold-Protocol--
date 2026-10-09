// test/match/spectate-effects.test.js —— **T3-A §1-2 的探针**：观战时效果列必须显示【被观看方】的效果
// （第 7 任 B，2026-10-07；依据 `协作/C-清点-上游0.1.4前端差距-2026-10-07.md` §1-2 / §4-T3-A / §5）
//
// 这一块是**行为错误修复**，不是新功能：
//   上游 `battle/observe.js:143` 的 `spectateEffects(spec, members)` 算出"被观看那个玩家"的效果，
//   由 `battle/runner.js:569` 放进 field meta，`screens/game.js:1311` 在观战时用它、**取不到就留空**
//   （上游注释原文：*the column stays empty rather than showing one's own*）。
//   我方原来 `screens/game.js:1249` 写死 `effects=${priv?.effects}` ⇒ **观战时显示的是自己的效果**。
//
// 判据分三层：① ② 是**运行时断言**（真正的判据）；③ 是**接线层的弱断言**（源码级，与本仓既有约定一致）——
// 之所以还要 ③：①② 证明"算得对"，③ 才证明"真的接上了"。⚠️ 弱断言不能替代强断言，反之亦然。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
// ⚠️ 只剥**整行**注释。本仓踩过"块注释正则把真实代码吃掉"的坑（见 c-verify-browser-safe.mjs 的头注释）。
const stripComments = (s) => s.split('\n')
  .filter((l) => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')); })
  .join('\n');

const { spectateEffects, effectsColumnFor } = await import('../../public/js/battle/observe.js');

const spec = (players) => ({ players });

describe('① spectateEffects：只取【被观看方】的效果（上游同名函数的契约）', () => {
  test('函数已导出（上游 0.1.4 有；我方原来完全没有：grep 0 次）', () => {
    assert.equal(typeof spectateEffects, 'function');
  });

  test('只有一个被观看者 ⇒ 返回他的效果，形状与 EffectsList 一致', () => {
    const out = spectateEffects(spec([{ playerId: 'A', playerEffects: [{ id: 'eff_x', source: 'choice' }] }]), ['A']);
    assert.ok(Array.isArray(out), '应当是数组');
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'eff_x');
    assert.equal(out[0].iconId, 'eff_x');       // 表里查不到时 iconId 回落成 id
    assert.equal(out[0].iconKind, 'choice');
  });

  test('counter 透传（层数）', () => {
    const out = spectateEffects(spec([{ playerId: 'A', playerEffects: [{ id: 'eff_y', source: 'choice', counter: 3 }] }]), ['A']);
    assert.equal(out[0].counter, 3);
  });

  test('被观看人数 ≠ 1（联防 / boss 对）⇒ undefined ⇒ 列留空（而不是显示自己的）', () => {
    assert.equal(spectateEffects(spec([{ playerId: 'A', playerEffects: [] }]), ['A', 'B']), undefined);
    assert.equal(spectateEffects(spec([{ playerId: 'A', playerEffects: [] }]), []), undefined);
  });

  test('被观看者不在 spec 里 ⇒ undefined', () => {
    assert.equal(spectateEffects(spec([{ playerId: 'A', playerEffects: [] }]), ['ZZZ']), undefined);
  });

  test('他没有 playerEffects 字段 ⇒ undefined（服务端跑的场地 meta 里没有这个字段）', () => {
    assert.equal(spectateEffects(spec([{ playerId: 'A' }]), ['A']), undefined);
  });

  test('坏条目被跳过（没有 id 的）', () => {
    const out = spectateEffects(spec([{ playerId: 'A', playerEffects: [{ source: 'choice' }, { id: 'ok', source: 'choice' }] }]), ['A']);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'ok');
  });
});

describe('② effectsColumnFor：观战时【绝不】回落到自己的效果（这就是那个 bug 的判据）', () => {
  const priv = { effects: [{ id: 'mine' }] };

  test('观战 + field.effects 有 ⇒ 用被观看方的', () => {
    assert.deepEqual(effectsColumnFor({ watchingOther: true, field: { effects: [{ id: 'theirs' }] }, priv }), [{ id: 'theirs' }]);
  });

  test('观战 + field 有但没有 effects ⇒ null —— **不能**回落成 priv.effects（这就是那个 bug 的判据）', () => {
    assert.equal(effectsColumnFor({ watchingOther: true, field: { units: [] }, priv }), null, 'field 没有 effects 时必须留空');
  });

  test('观战但 field 还没到（null）⇒ 按上游原式回落成自己的（⚠️ 这是**上游的行为**，我照搬，不是我的偏好）', () => {
    // 上游 `screens/game.js:1311` 的原式是 `watchingOther && field ? (field.effects ?? null) : priv?.effects`
    // ⇒ `field === null` 时**取自己的**（那一瞬还没进战斗）。上游那句"stays empty rather than showing one's own"
    //    指的是 `spectateEffects` 返回 undefined 的情形（联防/boss 对、服务端跑的场地），**不是**这一种。
    // 我第一版把这条写成"必须也是 null" —— 是**我的测试写错了**（比上游更严），不是实现错。留在这里当记录。
    assert.deepEqual(effectsColumnFor({ watchingOther: true, field: null, priv }), [{ id: 'mine' }]);
  });

  test('不观战 ⇒ 用自己的', () => {
    assert.deepEqual(effectsColumnFor({ watchingOther: false, field: null, priv }), [{ id: 'mine' }]);
    assert.deepEqual(effectsColumnFor({ watchingOther: false, field: { effects: [{ id: 'theirs' }] }, priv }), [{ id: 'mine' }]);
  });
});

describe('③ 接线层（源码级弱断言；强断言见 ①②）', () => {
  test('game.js 的 gm__effects 行走 effectsColumnFor（而不是写死 priv?.effects）', () => {
    const game = stripComments(read('public/js/screens/game.js'));
    assert.match(game, /gm__effects[\s\S]{0,200}effectsColumnFor\(/, 'gm__effects 那一行必须调用 effectsColumnFor');
  });

  test('runner.js 把 spectateEffects 的结果放进 field meta', () => {
    const runner = stripComments(read('public/js/battle/runner.js'));
    assert.match(runner, /effects:\s*spectateEffects\(/, 'field meta 里必须有 effects: spectateEffects(...)');
  });
});
