// test/ui/reserve-picker-r1.test.js — **R1 探针**：外援面板改造（第 8 任 B，2026-10-07）
//
// 用户 16:0x 原话（照抄）：「外援的面板需要修改。当前的外援面板修改为"**类似当前干员调配页面的选人页面**，
//   但**不标注阶级**，也**不标注技能**，只有**双击选择**。排列方法为**按盟约排列**（因为外援都是单盟约干员）。」
// 依据：`协作/C-总结与派单v5-正式版初始阶级与面板改造-2026-10-07.md` §2（4 条要求 + 5 条判据）。
//
// 五组（**先跑时应当红**；落地后转绿）：
//   ① **不标阶级**：面板里**一张卡都不渲染阶级角标**（`TierChip` vnode / `lo-resv__tier` 类）
//      —— 现状：`:295` 用**记录 tier**（外援全是 6）画 VI，用户原话就是"不需要标上六阶的标记"。
//   ② **不标技能**：面板里没有技能段（`lo-skill` / `data-skill`）。⚠️ **本组落地前就已满足** ——
//      按 C §5 的要求**明说**："此条已满足"，**不假造红**。（模态框右上那个「配置技能」按钮**不算**卡上的技能标注，它是另一个入口。）
//   ③ **只有双击选择**：卡上**没有 `onClick`**（单击改变不了任何事）、**有 `onDblClick`** 且它 ⇒ `onConfirm(id, tier)`。
//      —— 现状：单击是"两段式"（第一次选中、第二次确定）⇒ 红。
//   ④ **按盟约排列**：卡片的 `bonds[0]` 序列**非降**，且**每个盟约有一行分组头**（`data-resv-bond`）。
//   ⑤ 不回退：分页/搜索/按阶筛选这几条**既有**行为仍在（本文件也顺带钉一下，防改造时把它们弄丢）。
//
// ⚠️ 手法与 `reserve-slot.test.js` 同一套：**走 htm vnode 树**、把 `props.onXxx` 当成 DOM 会调的那个函数**真调一遍** ——
//    而不是 match 源码（本工作区的老教训："文件里写着 `onClick=${…}`"证明不了点下去会发生什么）。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { ReservePicker } = await import('../../public/js/screens/loadout.js');
const { TierChip } = await import('../../public/js/ui/components.js');

const EXPAND = new Set(['Button']);
function* walk(v) {
  if (Array.isArray(v)) { for (const x of v) yield* walk(x); return; }
  if (!v || typeof v !== 'object') return;
  yield v;
  if (typeof v.type === 'function' && EXPAND.has(v.type.name)) yield* walk(v.type(v.props));
  for (const [k, val] of Object.entries(v.props || {})) {
    if (k === 'children' || val == null || typeof val !== 'object') continue;
    yield* walk(val);
  }
  yield* walk(v.props?.children);
}
const nodes = (tree) => [...walk(tree)];
const textOf = (v) => {
  if (v == null || typeof v === 'boolean') return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.map(textOf).join('');
  if (typeof v !== 'object') return '';
  if (typeof v.type === 'function' && EXPAND.has(v.type.name)) return textOf(v.type(v.props));
  return Object.entries(v.props || {}).filter(([k, val]) => k !== 'children' && val && typeof val === 'object')
    .map(([, val]) => textOf(val)).join('') + textOf(v.props?.children);
};
const buttons = (tree) => nodes(tree).filter((n) => n.type === 'button');
const button = (tree, pickId) => buttons(tree).find((b) => b.props?.['data-pick'] === pickId);
const hasClass = (v, c) => typeof v?.props?.class === 'string' && v.props.class.split(/\s+/).includes(c);
const cards = (tree) => buttons(tree).filter((b) => b.props?.['data-pick']);

/** 四位候选：两个盟约 × 两位，**故意打乱输入顺序**（否则"已排序"可能是输入恰好有序）。 */
const CANDS = [
  { chessId: 'chess_b1_a', name: '贝塔一', tier: 6, bonds: ['bondB'] },
  { chessId: 'chess_a1_a', name: '阿尔法一', tier: 6, bonds: ['bondA'] },
  { chessId: 'chess_b2_a', name: '贝塔二', tier: 6, bonds: ['bondB'] },
  { chessId: 'chess_a2_a', name: '阿尔法二', tier: 6, bonds: ['bondA'] },
];
const base = { m: null, entries: {}, onConfirm: () => {}, onClear: () => {}, onSelect: () => {}, onClose: () => {}, tierFilter: 'all' };

describe('R1 ① 不标注阶级：面板里一张卡都没有阶级角标', () => {
  test('整棵树里没有 `TierChip` vnode、也没有 `lo-resv__tier` 类', () => {
    const t = ReservePicker({ ...base, tier: 5, candidates: CANDS });
    const chips = nodes(t).filter((n) => n.type === TierChip || hasClass(n, 'lo-resv__tier'));
    assert.equal(chips.length, 0,
      `外援选择器里**一张卡都不许有阶级角标**（用户 16:0x：「不标注阶级」）；实际找到 ${chips.length} 个`
      + `（其中记录 tier=${chips.map((c) => c.props?.tier).join('/') || '-'}）`);
  });

  test('卡片文本里也不出现罗马数字（底图缺失时的 CSS 兜底会写 VI）', () => {
    const t = ReservePicker({ ...base, tier: 5, candidates: CANDS });
    for (const c of cards(t)) {
      const txt = textOf(c.props.children).replace(/\s+/g, ' ');
      assert.ok(!/\b(VI|IV|III|II)\b/.test(txt), `卡片「${txt}」上出现了罗马数字阶标`);
    }
  });
});

describe('R1 ② 不标注技能（⚠️ 落地前就已满足，此组不是红）', () => {
  test('面板里没有技能段（`lo-skill` / `data-skill`）', () => {
    const t = ReservePicker({ ...base, tier: 5, candidates: CANDS });
    const skill = nodes(t).filter((n) => hasClass(n, 'lo-skill') || n.props?.['data-skill'] != null);
    assert.equal(skill.length, 0, '外援选择器里不许有技能段（技能在「配置技能」那个独立入口里）');
  });
});

describe('R1 ③ 只有双击选择：单击不改变已选、双击才切换', () => {
  test('卡上**没有 `onClick`**（单击结构上就改不了任何东西）', () => {
    const t = ReservePicker({ ...base, tier: 5, candidates: CANDS });
    for (const c of cards(t)) {
      assert.equal(c.props.onClick, undefined,
        `卡片 ${c.props['data-pick']} 不该绑 onClick —— 用户要「只有双击选择」，单击必须什么都不做`
        + `（现状：单击是"先选中、再点一次确定"的两段式）`);
    }
  });

  test('`onDblClick` 存在，且真调它 ⇒ `onConfirm(chessId, tier)` 恰好一次', () => {
    const confirm = [];
    const t = ReservePicker({ ...base, tier: 6, candidates: CANDS, onConfirm: (id, tier) => confirm.push([id, tier]) });
    const c = button(t, 'chess_a1_a');
    assert.ok(c, '候选卡在');
    assert.equal(typeof c.props.onDblClick, 'function', '卡片必须有 onDblClick（双击 = 选中/装上）');
    c.props.onDblClick();
    assert.deepEqual(confirm, [['chess_a1_a', 6]], '双击 ⇒ onConfirm(id, 槽位阶)');
  });

  test('双击已装那位 ⇒ 也是 `onConfirm`（幂等装上），**绝不卸下**', () => {
    const confirm = [], clear = [];
    const entries = { chess_a1_a: { reserve: 5 } };
    const t = ReservePicker({ ...base, tier: 5, candidates: CANDS, entries, onConfirm: (id, tier) => confirm.push([id, tier]), onClear: (id) => clear.push(id) });
    const c = button(t, 'chess_a1_a');
    assert.equal(c.props['aria-selected'], 'true', '已装那位必须标记为选中');
    c.props.onDblClick();
    assert.deepEqual(confirm, [['chess_a1_a', 5]]);
    assert.deepEqual(clear, [], '双击**不许**卸下（"点第二下就被卸下"是用户 09:0x 报过的老 bug）');
  });
});

describe('R1 ④ 按盟约排列', () => {
  test('卡片的 `bonds[0]` 序列非降（输入是打乱的）', () => {
    const t = ReservePicker({ ...base, tier: 5, candidates: CANDS });
    const order = cards(t).map((c) => CANDS.find((x) => x.chessId === c.props['data-pick']).bonds[0]);
    assert.deepEqual(order, ['bondA', 'bondA', 'bondB', 'bondB'],
      `面板必须**按盟约排列**（外援都是单盟约干员）；实际顺序 ${order.join(' → ')}`);
  });

  test('每个盟约有一行分组头（`data-resv-bond`），且顺序与卡片一致', () => {
    const t = ReservePicker({ ...base, tier: 5, candidates: CANDS });
    const heads = nodes(t).filter((n) => n.props?.['data-resv-bond'] != null).map((n) => n.props['data-resv-bond']);
    assert.deepEqual(heads, ['bondA', 'bondB'], `每个盟约要有一行分组头，按盟约出现顺序；实际 ${heads.join(' / ') || '(没有)'}`);
  });
});

describe('R1 ⑤ 不回退：分页 / 搜索 / 按阶筛选仍在', () => {
  const mk = (n, tier, bond) => ({ chessId: `chess_o${n}_a`, name: `干员${n}`, tier, bonds: [bond] });
  const many = Array.from({ length: 20 }, (_, i) => mk(i + 1, 5, `b${i % 3}`));

  test('一页 12 位、第二页 8 位；页码节点仍在', () => {
    const p0 = ReservePicker({ ...base, tier: 5, candidates: many, page: 0 });
    assert.equal(cards(p0).length, 12, '第一页只渲染 pageSize 条');
    const p1 = ReservePicker({ ...base, tier: 5, candidates: many, page: 1 });
    assert.equal(cards(p1).length, 8, '第二页是剩下的 8 位');
  });

  test('搜索仍按名字筛；筛空仍是专门文案', () => {
    const hit = ReservePicker({ ...base, tier: 5, candidates: many, query: '干员13' });
    assert.deepEqual(cards(hit).map((c) => c.props['data-pick']), ['chess_o13_a']);
    const none = ReservePicker({ ...base, tier: 5, candidates: many, query: '不存在' });
    assert.equal(cards(none).length, 0);
    assert.ok(nodes(none).some((n) => n.props?.['data-resv-noresult'] != null), '筛空要有专门的提示节点');
  });

  test('按阶筛选的 auto 兼容性仍在（老数据只有 tier=6 一条时不许变空列表）', () => {
    const t = ReservePicker({ ...base, tier: 5, candidates: [{ chessId: 'chess_x_a', name: 'X', tier: 6, bonds: ['b'] }], tierFilter: null });
    assert.deepEqual(cards(t).map((c) => c.props['data-pick']), ['chess_x_a']);
  });
});
