// test/ui/shortcut-qx.test.js —— **T3-C §1-7 的探针**：Q 撤退 / X 出售（选中干员后）
// （第 7 任 B，2026-10-07；依据 `协作/C-清点-上游0.1.4前端差距-2026-10-07.md` §1-7 / §4-T3-C）
//
// 上游：`ui/gameLogic.js:1661-1662` 两行 —— `KeyQ→'retreat'`、`KeyX→'sell'`；
//       消费端 `screens/game.js:1149-1157`（`if (act === 'retreat' || act === 'sell')` 分支，靠
//       `underframeActions(...)` 判断这一手到底能不能撤退/出售）；按钮上的提示在 `ui/underframe.js:92-101`。
// 我方原来：`shortcutFor` **只有** R/F/D/Space/Esc ⇒ **完全没有 Q/X**（C 清点表实测）。
// ⚠️ 我方**已经有**整套底板撤退/出售管线（`underframeActions` / `retreatSel` / `sellSel` / 两个按钮都在），
//    缺的**只是"键盘入口 + 分发"** ⇒ 这一块很小，但必须与上游同形（不能自己发明动作名）。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const stripComments = (s) => s.split('\n')
  .filter((l) => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')); })
  .join('\n');

const { shortcutFor } = await import('../../public/js/ui/gameLogic.js');

/** 造一个"普通按键"事件（默认不在输入框里）。 */
const key = (k, extra = {}) => ({ key: k, code: `Key${k.toUpperCase()}`, target: { tagName: 'DIV' }, ...extra });

describe('① shortcutFor：Q/X 必须映射到上游那两个动作名（retreat / sell）', () => {
  test('q / Q ⇒ retreat（按 key）', () => {
    assert.equal(shortcutFor(key('q')), 'retreat');
    assert.equal(shortcutFor(key('Q')), 'retreat');
  });

  test('x / X ⇒ sell（按 key）', () => {
    assert.equal(shortcutFor(key('x')), 'sell');
    assert.equal(shortcutFor(key('X')), 'sell');
  });

  test('只给 code（key 为空）也要认 —— 上游是 `code === KeyQ || key === q` 两条并集', () => {
    assert.equal(shortcutFor({ code: 'KeyQ', key: 'Unidentified', target: { tagName: 'DIV' } }), 'retreat');
    assert.equal(shortcutFor({ code: 'KeyX', key: 'Unidentified', target: { tagName: 'DIV' } }), 'sell');
  });

  test('原有的 R/F/D/Space/Esc 一个都不能少（改这块最容易碰坏旧的）', () => {
    assert.equal(shortcutFor(key('r')), 'refresh');
    assert.equal(shortcutFor(key('f')), 'freeze');
    assert.equal(shortcutFor(key('d')), 'levelUp');
    assert.equal(shortcutFor({ code: 'Space', key: ' ', target: { tagName: 'DIV' } }), 'ready');
    assert.equal(shortcutFor({ key: 'Escape', code: 'Escape', target: { tagName: 'DIV' } }), 'escape');
  });

  test('修饰键下不触发 Q/X（原有守卫不能被绕过）', () => {
    assert.equal(shortcutFor(key('q', { ctrlKey: true })), null);
    assert.equal(shortcutFor(key('x', { metaKey: true })), null);
    assert.equal(shortcutFor(key('q', { altKey: true })), null);
  });

  test('在输入框里不触发（原有守卫）', () => {
    assert.equal(shortcutFor({ key: 'q', code: 'KeyQ', target: { tagName: 'INPUT' } }), null);
    assert.equal(shortcutFor({ key: 'x', code: 'KeyX', target: { tagName: 'TEXTAREA' } }), null);
  });

  test('按住不放的重复事件不触发（e.repeat，原有守卫）', () => {
    assert.equal(shortcutFor(key('q', { repeat: true })), null);
  });
});

describe('② 接线层（源码级弱断言；强断言在 ① 与实机）', () => {
  const game = stripComments(read('public/js/screens/game.js'));

  test('onKey 里有 retreat/sell 分支，并且真的调 retreatSel / sellSel', () => {
    assert.match(game, /act === 'retreat'\s*\|\|\s*act === 'sell'/, '必须有 retreat/sell 分支');
    assert.match(game, /retreatSel\(\)/, '分支里必须调 retreatSel()');
    assert.match(game, /sellSel\(\)/, '分支里必须调 sellSel()');
  });

  test('分支用 underframeActions 判断"这一手能不能退/卖"（不许无条件执行）', () => {
    assert.match(game, /underframeActions\(L\.placeCtx/, '必须用 underframeActions 判可用性');
  });

  test('分支读的是 live 快照里的字段（onKey 在 useEffect([]) 里，读闭包会读到陈旧值）', () => {
    assert.match(game, /L\.selBusy/, 'selBusy 必须来自 live 快照');
    assert.match(game, /L\.showPrep/, 'showPrep 必须来自 live 快照');
  });
});
