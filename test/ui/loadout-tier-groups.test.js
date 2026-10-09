// test/ui/loadout-tier-groups.test.js —— **C 施工单「干员调配 UI 按 1–6 阶分组」的 J-1…J-5**
//   ⭐ 口径来自施工单 §6：**J-2 必须从 `data/chess.json` 真表算**（⛔ 不许手工造 list 喂进去）；
//      J-1 要"改前必红"；J-3 是负对照（筛成一阶时**只能有一个头**）；J-5 钉吸顶（源码契约）。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { groupRosterByTier } = await import('../../public/js/screens/loadout.js');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** 真表：`data/chess.json` 里**可见且有阶级**的记录（这就是名册那条链路的源头）。 */
function realRoster() {
  const chess = JSON.parse(readFileSync(path.join(ROOT, 'data/chess.json'), 'utf8'));
  return Object.entries(chess)
    .filter(([, r]) => r && r.visible !== false && Number(r.tier))
    .map(([id, r]) => ({ chessId: r.chessId || id, tier: Number(r.tier) }));
}

describe('干员调配：按阶分组（J-1…J-5）', () => {
  test('J-1／J-2：真表（data/chess.json）—— 分组头数 == 有成员的阶数；各阶卡片数之和 == 总条数', () => {
    const roster = realRoster();
    assert.ok(roster.length > 50, `真表里应当有几十张牌（实得 ${roster.length}）`);
    const groups = groupRosterByTier(roster);
    const tiersInData = [...new Set(roster.map((c) => c.tier))].sort((a, b) => a - b);
    assert.deepEqual(groups.map((g) => g.tier), tiersInData, 'J-1：分组头**恰好**等于有成员的阶（⛔ 不补空阶）');
    assert.equal(groups.reduce((n, g) => n + g.items.length, 0), roster.length, 'J-2：各阶之和 == 总条数（一张不丢、一张不重）');
    for (const g of groups) for (const c of g.items) assert.equal(c.tier, g.tier, 'J-2：卡片不许串阶');
    // 每一阶都非空（J-1 的另一面）
    for (const g of groups) assert.ok(g.items.length > 0, `${g.tier} 阶不许是空组`);
  });

  test('J-3 🔴 负对照：筛成"只看某一阶" ⇒ **只能有一个分组头**，且它的数量 == 该阶真实条数', () => {
    const roster = realRoster();
    const tier = [...new Set(roster.map((c) => c.tier))].sort((a, b) => a - b)[1] ?? 3;
    const only = roster.filter((c) => c.tier === tier);          // 这就是 `filterRoster` 之后的样子
    const groups = groupRosterByTier(only);
    assert.equal(groups.length, 1, '筛成一阶 ⇒ 只许一个头（若实现"永远渲染 1–6 个头"这里必红）');
    assert.equal(groups[0].tier, tier);
    assert.equal(groups[0].items.length, only.length, '该阶数量 == 真实条数');
    // 空输入 ⇒ 零个头（⛔ 不造头）
    assert.deepEqual(groupRosterByTier([]), []);
    assert.deepEqual(groupRosterByTier(null), []);
    // 坏记录（没有 tier）⇒ 不进任何组（⛔ 不造"0 阶"）
    assert.deepEqual(groupRosterByTier([{ chessId: 'x' }, { chessId: 'y', tier: 0 }]), []);
  });

  test('J-4：分组顺序**升序**（乱序输入也要升序输出）', () => {
    const groups = groupRosterByTier([{ tier: 6 }, { tier: 2 }, { tier: 4 }, { tier: 1 }, { tier: 2 }]);
    assert.deepEqual(groups.map((g) => g.tier), [1, 2, 4, 6]);
    const tiers = groups.map((g) => g.tier);
    assert.deepEqual(tiers, [...tiers].sort((a, b) => a - b), '必须是升序');
    // 真表的输出同样升序
    const real = groupRosterByTier(realRoster()).map((g) => g.tier);
    assert.deepEqual(real, [...real].sort((a, b) => a - b));
  });

  test('J-5：源码契约 —— 渲染真的分组了、分组头**吸顶**、`gridRef`/`role=listbox`/空态都还在', () => {
    const js = strip(readFileSync(path.join(ROOT, 'public/js/screens/loadout.js'), 'utf8'));
    assert.match(js, /groupRosterByTier\(list\)/, '名册必须经分组函数渲染（⛔ 退回平铺）');
    assert.match(js, /class="lo-tier"/, '分组块存在');
    assert.match(js, /<\$\{TierChip\} tier=\$\{g\.tier\} size="sm" \/>/, '分组头带阶级芯片');
    assert.match(js, /class="lo-tier__count num">\$\{g\.items\.length\}/, '分组头带数量');
    assert.match(js, /role="listbox"[\s\S]{0,80}ref=\$\{gridRef\}/, 'J-5：滚动容器/ref 保留（键盘导航不回归）');
    assert.match(js, /没有符合条件的干员/, '空态仍在');
    // ⛔ 三条不许碰：RosterCard 参数、导航、filterRoster 语义
    assert.match(js, /<section class="lo-roster">[\s\S]{0,120}<\$\{Filters\}/, '筛选器仍在名册区（未被分组吃掉）');
    const css = readFileSync(path.join(ROOT, 'public/css/screens/loadout.css'), 'utf8');
    assert.match(css, /\.lo-tier__row\s*\{[^}]*position:\s*sticky/, 'J-5：分组头必须 position:sticky');
    assert.match(css, /\.lo-tier__row\s*\{[^}]*background:\s*var\(--bg-0\)/, '吸顶头底色取实际变量 var(--bg-0)（⛔ 不写死 hex）');
    assert.match(css, /\.lo-grid\.is-tiered\s*\{[^}]*display:\s*block/, 'is-tiered 时容器改为纵向堆叠');
    assert.match(css, /\.lo-tier__grid\s*\{[^}]*auto-fill/, '每阶自己出网格（与 .lo-grid 同参数）');
  });
});
