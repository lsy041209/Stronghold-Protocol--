// test/ui/terrain-info.test.js —— **T3-A §1-1 的探针（核心层）**：特殊地块的单击提示
// （第 7 任 B，2026-10-07；依据 `协作/C-清点-上游0.1.4前端差距-2026-10-07.md` §1-1 / §5-T3-A）
//
// 上游实现：`ui/gameLogic.js:886-995`（`TERRAIN_TIPS` / `TIP_BY_TILEKEY` / `BUILDABILITY` / `terrainInfo`）。
// **为什么要它**（上游注释原话）：`lines` 是**场地自己那份地形参数**（`stage.special[<terrain>]` 与地块的 `bb`，
// 也就是 **sim 跑的那几个数** ⇒ 提示**不可能与战斗不一致**）；措辞才是我们的（PRTS 特殊地形/沼泽控制/深水区）。
//
// ⚠️ C §5 的判据原文：「探针须断言"点特殊地块 ⇒ 出 `type:'terrain'` 卡且**文案与 `special.*.bb` 一致**"」。
//    本文件守的就是**后半句**（核心层）；前半句（真的点出卡）属接线层，见 T3-A 的下一步。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { terrainInfo, closesOnFieldPress } = await import('../../public/js/ui/gameLogic.js');

/** 造一个最小场地：`rows[row][col]` 是 tileKey；`tiles[key]` 是地块定义；`special` 是场地自己的地形参数。 */
const stage = ({ rows, tiles, special }) => ({ rows, tiles, special });

describe('① terrainInfo：特殊地块 ⇒ 出一张卡；普通地块 ⇒ null', () => {
  test('函数已导出（上游 0.1.4 有；我方原来 grep 0 次）', () => {
    assert.equal(typeof terrainInfo, 'function');
  });

  test('活性源石：damage 取自 stage.special.infection.bb（**文案必须与 sim 那几个数一致**）', () => {
    const st = stage({
      rows: ['S'],
      tiles: { S: { special: 'infection', buildable: 'MELEE', groundPassable: true } },
      special: { infection: { bb: { damage: 50, atk: 0.2, attack_speed: 30, duration: 3 } } },
    });
    const info = terrainInfo(st, 0, 0);
    assert.ok(info, '应当出卡');
    assert.equal(info.key, 'infection');
    assert.equal(info.row, 0);
    assert.equal(info.col, 0);
    assert.ok(info.name && info.tag, 'name / tag 都要有（卡头）');
    const text = info.lines.join('｜');
    assert.match(text, /50/, '伤害数字必须来自 bb.damage ⇒ 文案与 sim 同源');
    assert.match(text, /20%/, '攻击加成必须来自 bb.atk（0.2 ⇒ +20%）');
    assert.match(text, /3/, '持续时间必须来自 bb.duration');
  });

  test('沼泽：层数上限/间隔取自 stage.special.mire（不是写死的）', () => {
    const st = stage({
      rows: ['M'],
      tiles: { M: { special: 'mire' } },
      special: { mire: { aspdPerStack: -0.05, moveMulPerStack: -0.05, maxStacks: 7, intervalSec: 2, heavyWeight: 3 } },
    });
    const info = terrainInfo(st, 0, 0);
    const text = info.lines.join('｜');
    assert.match(text, /7/, '最大层数必须来自 mire.maxStacks=7');
    assert.match(text, /2/, '间隔必须来自 mire.intervalSec=2');
  });

  test('深水区：敌人每秒伤害取自 special.deepsea.bb 的 `sea_drown[enemy].damage`', () => {
    const st = stage({
      rows: ['D'],
      tiles: { D: { special: 'deepsea' } },
      special: { deepsea: { bb: { 'sea_drown[enemy].damage': 123, 'sea_drown[enemy].attack_speed': -0.3, 'sea_drown[enemy].move_speed': 0.5 } } },
    });
    const text = terrainInfo(st, 0, 0).lines.join('｜');
    assert.match(text, /123/, '每秒伤害必须来自 bb');
    assert.match(text, /30%/, '攻速 -0.3 ⇒ 30%');
  });

  test('闸门/传送门：地块**没有** special 字段，靠 tileKey 认出来', () => {
    const tiles = { G: { tileKey: 'tile_start' }, E: { tileKey: 'tile_end' }, I: { tileKey: 'tile_telin' }, O: { tileKey: 'tile_telout' } };
    for (const [tk, key] of [['G', 'start'], ['E', 'end'], ['I', 'telin'], ['O', 'telout']]) {
      const info = terrainInfo(stage({ rows: [tk], tiles, special: {} }), 0, 0);
      assert.ok(info, `${tk} 应当出卡`);
      assert.equal(info.key, key);
    }
  });

  test('普通地块 ⇒ null（点了什么也不说，不该弹卡）', () => {
    const st = stage({ rows: ['R'], tiles: { R: { tileKey: 'tile_road', buildable: 'ALL' } }, special: {} });
    assert.equal(terrainInfo(st, 0, 0), null);
  });

  test('越界 / 缺字段 ⇒ null（不许抛）', () => {
    const st = stage({ rows: ['S'], tiles: { S: { special: 'infection' } }, special: { infection: { bb: {} } } });
    assert.equal(terrainInfo(st, 5, 0), null, 'row 越界');
    assert.equal(terrainInfo(st, 0, 9), null, 'col 越界');
    assert.equal(terrainInfo(st, -1, 0), null, '负 row');
    assert.equal(terrainInfo(null, 0, 0), null, 'null stage');
    assert.equal(terrainInfo({ rows: ['X'] }, 0, 0), null, 'tiles 缺失');
    assert.equal(terrainInfo(stage({ rows: ['Z'], tiles: {}, special: {} }), 0, 0), null, '地块不在 tiles 里');
  });

  test('facts：把可部署性 / 高台 / 地面通行写进卡里', () => {
    const st = stage({
      rows: ['S'],
      tiles: { S: { special: 'infection', buildable: 'NONE', height: 'HIGH', groundPassable: false } },
      special: { infection: { bb: {} } },
    });
    const info = terrainInfo(st, 0, 0);
    assert.ok(Array.isArray(info.facts) && info.facts.length >= 2, 'facts 至少有可部署性 + 高台/通行');
    const f = info.facts.join('｜');
    assert.match(f, /不可部署/, 'buildable=NONE 的文案');
    assert.match(f, /高台/, 'height=HIGH 的文案');
  });

  test('普通地块带 buildable 也不出卡（facts 只在真有 tip 时才出现）', () => {
    const st = stage({ rows: ['R'], tiles: { R: { tileKey: 'tile_road', buildable: 'ALL', height: 'HIGH' } }, special: {} });
    assert.equal(terrainInfo(st, 0, 0), null);
  });
});

describe('② 接线的一环：地形卡必须"再点一次场地就关"（上游 gameLogic.js:1674 同形）', () => {
  test('closesOnFieldPress 认 terrain —— 否则那张卡会赖在屏幕上不走', () => {
    assert.equal(closesOnFieldPress({ kind: 'terrain' }), true, 'terrain 必须算"场地开的卡"');
    assert.equal(closesOnFieldPress({ kind: 'piece' }), true);
    assert.equal(closesOnFieldPress({ kind: 'unit' }), true);
  });

  test('商店 / 手牌 / HUD 开的卡**不**受影响（它们要等自己的关闭按钮）', () => {
    assert.equal(closesOnFieldPress({ kind: 'chess' }), false);
    assert.equal(closesOnFieldPress({ kind: 'item' }), false);
    assert.equal(closesOnFieldPress({ kind: 'bond' }), false);
    assert.equal(closesOnFieldPress(null), false);
    assert.equal(closesOnFieldPress(undefined), false);
  });
});
