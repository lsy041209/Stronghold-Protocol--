// test/ui/terrain-wiring.test.js —— **T3-A §1-1 接线层的"发事件/收事件"探针**（第 7 任 B，2026-10-07）
// 依据 `协作/B-T3-A接线施工单-2026-10-07.md` §4-B1。
//
// ⚠️ **为什么必须剥注释**（这是本文件存在的头号理由）：
//   上游/我方的**注释里**本来就会写 `terrainInfo` / `tileClick` 这些词（例如把"谁调用谁"写在 JSDoc 里）。
//   **不剥注释的源码断言会假绿** —— 本仓 `test/render/wang-pieces.test.js:36-37` 记过这次血案。
//   ⇒ 下面每一条断言都作用在 `strip()` 之后的可执行代码上。
//
// ⚠️ **这是"代理判据"，不能替代端到端**：`screens/game.js` 是整体 Preact 组件、`render/app.js` 导入即拉 PIXI，
//   两者的点击接线都在闭包里、且**不导出**（施工单 §4-B 已核实）。
//   ⇒ 真正"点一下能出卡"的判据只能在浏览器里跑（施工单 §4-B2：Edge + `SP_E2E=1`）。
//   本文件的价值：**把"接线到底有没有接上"从"人眼读代码"变成"机器可判"**，并在没人跑浏览器时也能拦住"忘了接"。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const raw = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
/** 剥掉块注释与行注释（保留 `http://` 里的斜杠）——**判据必须作用在可执行代码上**。 */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const code = (rel) => strip(raw(rel));

describe('① 引擎侧：canvas 的"裸地块点击"必须发得出来（施工单 8/9）', () => {
  const app = code('public/js/render/app.js');

  test('有 emitTileClick，而且发的是 tileClick 事件', () => {
    assert.match(app, /function emitTileClick\(/, 'render/app.js 必须有 emitTileClick');
    assert.match(app, /emit\('tileClick'/, '必须 emit(\'tileClick\', …)');
  });

  test('报的是**棋盘格**（pickBoardTile），不是画出来的格子', () => {
    // 上游注释点明：在最终攻势整备里，报"画出来的格"会被换算两次 ⇒ 解释错地块
    assert.match(app, /pickBoardTile\(ev\.x,\s*ev\.y\)/, '必须用 pickBoardTile 取棋盘格');
  });

  test('越界的双条件判断要在（bossPrep 分支会返回 row/col = -1，只判 !t 会漏）', () => {
    assert.match(app, /!\(t\.row >= 0\)/, '必须挡 row < 0');
    assert.match(app, /!\(t\.col >= 0\)/, '必须挡 col < 0');
  });

  test('两个分支都要落到 emitTileClick（battle 空地点地 + prep）', () => {
    const n = (app.match(/emitTileClick\(ev,\s*e\)/g) || []).length;
    assert.ok(n >= 2, `emitTileClick 的调用点应 ≥2 个（battle 与 prep 各一），实际 ${n}`);
  });
});

describe('② 兜底视图侧：DOM 棋盘每格也要发（施工单 11）', () => {
  test('fallbackField.js 也 emit tileClick（否则 ?render=fallback 下点不出卡）', () => {
    assert.match(code('public/js/ui/fallbackField.js'), /emit\('tileClick'/, 'DOM 兜底棋盘也必须发 tileClick');
  });
});

describe('③ 屏幕侧：收事件 → 查地形 → 设卡（施工单 5/6/7）', () => {
  const game = code('public/js/screens/game.js');

  test('import 了 terrainInfo', () => {
    assert.match(game, /terrainInfo/, 'screens/game.js 必须用 terrainInfo');
  });

  test('⚠️ 用到的 gameLogic 名字**必须真的在 import 块里**（`node --check` 查不出这种）', () => {
    // 血案（本仓 2026-10-07 第 7 任 B 现场抓到的）：`fieldTile` 只在函数体里出现、**没进 import** ⇒
    // `node --check` 照样 0（它是合法的标识符引用），只有**真跑到那一行**才 ReferenceError。
    const m = /import\s*\{([\s\S]*?)\}\s*from '\.\.\/ui\/gameLogic\.js'/.exec(raw('public/js/screens/game.js'));
    assert.ok(m, '必须能找到 from \'../ui/gameLogic.js\' 的 import 块');
    const names = m[1];
    for (const n of ['terrainInfo', 'fieldTile']) {
      assert.match(names, new RegExp(`\\b${n}\\b`), `${n} 必须在 gameLogic 的 import 块里（否则运行时 ReferenceError）`);
    }
  });

  test('监听了 tileClick 事件', () => {
    assert.match(game, /on\('tileClick'/, '必须 view.on(\'tileClick\', …)');
  });

  test('用的是**屏幕上那块板**的 stage（ownView 二选一），不是 placeCtx.stage', () => {
    assert.match(game, /terrainStage\s*=\s*ownView\s*\?\s*ownStage\s*:\s*baseStage/,
      'terrainStage 必须是 ownView ? ownStage : baseStage（placeCtx.stage 没加机变 overrides，会解释错）');
    assert.match(game, /terrainInfo\(L\.terrainStage/, '出卡要用 terrainStage');
  });

  test('棋盘格 → stage 格 的映射用了 fieldTile（boss 整备要换格，参数序是 (field,row,col)）', () => {
    assert.match(game, /fieldTile\(deployField,\s*row,\s*col\)/, 'bossPrep 必须 fieldTile(deployField, row, col)');
  });

  test('出的卡是 {kind:"terrain", terrain:info}（消费端 resolveDetail 认的就是它）', () => {
    assert.match(game, /setDetail\(\{\s*kind:\s*'terrain',\s*terrain:\s*info\s*\}\)/, 'setDetail 的载荷形状');
  });

  test('普通地块（terrainInfo 返回 null）必须**什么都不做**，不能把卡设成空', () => {
    assert.match(game, /if\s*\(!info\)\s*return;/, '取不到 info 要直接 return');
  });
});
