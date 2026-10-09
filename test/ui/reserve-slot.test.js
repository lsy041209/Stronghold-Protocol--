// test/ui/reserve-slot.test.js — 外援槽位 / picker 的**交互**护栏（第 5 任 B，2026-10-06）
//
// 用户 09:0x 实机报：「**外援干员的技能无法替换**（因为**点击第二下就被卸下了**）」；C 定位 + 用户裁「方案 A」。
// 根因：`loadout.js` 的**填满槽位卡只有一个动作 = 卸下**（`onClick = onClear`，卡片上还印着"点击卸下"）
//   ⇒ 而**改技能要先"选中他"**，选中的入口只在名册里，外援**又不在名册**（`isLoadoutSlot` 要求 `visible !== false`）
//   ⇒ **外援装上去之后，既没有"选中"的路，也没有"换"的路，只有"卸下"**。
//
// 本文件的做法（与 `loadout-stats.test.js` 同一套：**走 htm vnode 树**，把 `props.onClick` 当成 DOM 会调的那个函数**真调一遍**）——
// 而不是去 match 源码：这一次的教训就是"文件里写着 `onClick=${...}`"**证明不了点下去会发生什么**。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { ReserveSlot, ReservePicker, ReserveHeadActions, detailTargetId } = await import('../../public/js/screens/loadout.js');
const { setReserve, reserveOf, reserveSlots } = await import('../../public/js/ui/loadoutModel.js');

const EXPAND = new Set(['Button']);   // 无 hook 的展示型组件 ⇒ 原地展开，才能看到它渲染出的 <button>
/** htm 树 → vnode 迭代器。
 *  ⚠️ 两处细节是**踩过才知道**的：① `<${Modal} actions=${...}>` 的 `actions` 是**prop**、不是 children
 *  ⇒ 必须把**对象型的 props 值**也走一遍（否则「卸下」按钮根本不在遍历结果里）；
 *  ② 展示型组件（`Button`）要先展开再走。 */
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
/** 子树里的全部可见文本（递归拼）—— 只取"直接字符串 children"会漏掉 `<b>已选</b> · 已在 5 阶` 这种混排。 */
const textOf = (v) => {
  if (v == null || typeof v === 'boolean') return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.map(textOf).join('');
  if (typeof v !== 'object') return '';
  if (typeof v.type === 'function' && EXPAND.has(v.type.name)) return textOf(v.type(v.props));
  return Object.entries(v.props || {}).filter(([k, val]) => k !== 'children' && val && typeof val === 'object')
    .map(([, val]) => textOf(val)).join('') + textOf(v.props?.children);
};
/** 树里所有 `<button>`：`{text, onClick, props}` */
const buttons = (tree) => nodes(tree)
  .filter((n) => n.type === 'button')
  .map((n) => ({ props: n.props, onClick: n.props.onClick, text: textOf(n.props.children).replace(/\s+/g, ' ').trim() }));
const hasClass = (v, c) => typeof v?.props?.class === 'string' && v.props.class.split(/\s+/).includes(c);

const CHESS = { chessId: 'chess_wang_a', name: '望', tier: 3 };

describe('外援槽位：点击进技能页 + 名字右侧两个按钮（用户 09:4x 口径）', () => {
  test('🔴 装满的槽：点卡片 ⇒ 进技能页（`onSelect(id)`），**不再弹替换页**', () => {
    const sel = [], pick = [];
    const tree = ReserveSlot({ tier: 5, id: 'chess_wang_a', chess: CHESS, m: null,
      onSelect: (id) => sel.push(id), onPick: (t) => pick.push(t), onClear: () => {} });
    const main = buttons(tree).find((b) => b.props['data-reserve-main'] === 'chess_wang_a');
    assert.ok(main, '内层主按钮必须能进技能页');
    main.onClick();
    assert.deepEqual(sel, ['chess_wang_a'], '点卡片 = 选中这位（进技能页）');
    assert.deepEqual(pick, [], '点卡片**不许**打开替换 picker');
    assert.ok(!buttons(tree).some((b) => /点击卸下/.test(b.text)), '卡片上不许再出现"点击卸下"');
  });

  test('名字右侧两个按钮：**在详情面板（技能替换面板）里**「替换」打开 picker；「卸下」⇒ `onClear(id)`', () => {
    const pick = [], clear = [];
    const tree = ReserveHeadActions({ tier: 6, id: 'chess_hsgma2_a', name: '斩业星熊',
      onReplace: (t) => pick.push(t), onClear: (id) => clear.push(id) });
    const rep = buttons(tree).find((b) => b.props['data-reserve-replace']);
    const off = buttons(tree).find((b) => b.props['data-reserve-clear']);
    assert.ok(rep && off, '「替换」「卸下」两个按钮都要在（名字旁边）');
    assert.equal(rep.text, '替换'); assert.equal(off.text, '卸下');
    assert.equal(rep.props['data-reserve-replace'], 6, '替换要知道是哪一阶的槽');
    assert.equal(off.props['data-reserve-clear'], 'chess_hsgma2_a', '卸下要知道卸谁');
    rep.onClick(); off.onClick();
    assert.deepEqual(pick, [6]); assert.deepEqual(clear, ['chess_hsgma2_a']);
  });

  test('普通干员（不在外援槽里）⇒ 详情面板里**不出现**这两个按钮', () => {
    assert.equal(ReserveHeadActions({ tier: null, id: 'chess_char_1_01_a', name: '隐现', onReplace: () => {}, onClear: () => {} }), null);
  });

  test('🔴 槽位卡上**不许**再出现「替换」「卸下」——它们只在详情面板的名字旁边（用户 09:5x 更正）', () => {
    const tree = ReserveSlot({ tier: 6, id: 'chess_hsgma2_a', chess: CHESS, m: null, onSelect: () => {}, onPick: () => {}, onClear: () => {} });
    assert.ok(!buttons(tree).some((b) => /替换|卸下/.test(b.text)), '卡片上只剩"点一下进技能页"这一个动作');
  });

  test('空槽行为不变：只有一个「+」⇒ `onPick(tier)`', () => {
    const pick = [];
    const tree = ReserveSlot({ tier: 6, id: null, chess: null, m: null, onPick: (t) => pick.push(t) });
    const bs = buttons(tree);
    assert.equal(bs.length, 1);
    assert.ok(hasClass(bs[0], 'is-empty'));
    bs[0].onClick();
    assert.deepEqual(pick, [6]);
  });
});

// ══ 🆕 2026-10-07 16:0x（用户口径 / C《总结与派单v5》§2 R1）—— **口径变更**，不是"改测试让它变绿" ═══════════
// 用户原话：「外援的面板需要修改…**不标注阶级**，也不**标注技能**，只有**双击选择**。排列方法为**按盟约排列**。」
//   ⇒ ① 旧口径「点一次选中、再点一次确定」（用户 **09:4x**）**作废** ⇒ 卡上不绑 `onClick`、只认 `onDblClick`；
//     ② 「按阶展示」（每张卡画**记录**阶级的角标）**作废** ⇒ 面板里一张阶标都没有；
//     ③ 新行为（不标阶级 / 不标技能 / 双击 / 按盟约分组）在 **`test/ui/reserve-picker-r1.test.js`** 里判。
//   ⚠️ 本文件下面那两条改的是**断言**、不是实现 —— 依据是"用户改主意了"，并且新判据**先证明过会红**。
describe('外援 picker：**只有双击选择**（用户 16:0x 口径；旧的"点一次选中、再点一次确定"已作废）', () => {
  const candidates = [CHESS, { chessId: 'chess_chen3_a', name: '赤刃明霄陈', tier: 3 }];
  const entries = { chess_wang_a: { reserve: 5 } };

  test('🆕 单击**什么都不做**（卡上没有 `onClick`）；**双击** ⇒ `onConfirm(id, tier)`', () => {
    const confirm = [], choose = [];
    const t = ReservePicker({ tier: 5, candidates, m: null, entries,
      onConfirm: (id, ti) => confirm.push([id, ti]), onChoose: (id) => choose.push(id),
      onClear: () => {}, onSelect: () => {}, onClose: () => {} });
    const chen = () => buttons(t).find((b) => b.props['data-pick'] === 'chess_chen3_a');
    assert.equal(chen().props.onClick, undefined,
      '单击必须什么都不做 —— 旧口径的"第一次点 = 选中待定"已作废（用户 16:0x：只有双击选择）');
    chen().props.onDblClick();
    assert.deepEqual(confirm, [['chess_chen3_a', 5]], '双击 ⇒ 直接装上那位');
    assert.deepEqual(choose, [], '老口径（点一次就装）也必须不存在');
  });

  test('已装那位显示「已选 · 已在 N 阶」；**单击不改已选**、**双击只装上**、**绝不卸下**', () => {
    const confirm = [], clear = [];
    const tree = ReservePicker({ tier: 5, candidates, m: null, entries,
      onConfirm: (id, ti) => confirm.push([id, ti]), onClear: (id) => clear.push(id), onSelect: () => {}, onClose: () => {} });
    const wang = buttons(tree).find((b) => b.props['data-pick'] === 'chess_wang_a');
    assert.equal(wang.props['aria-selected'], 'true');
    assert.ok(hasClass(wang, 'is-sel'));
    assert.match(wang.text, /已选/); assert.match(wang.text, /已在 5 阶/);
    assert.equal(wang.props.onClick, undefined, '单击不许改变已选');
    wang.props.onDblClick();
    assert.deepEqual(confirm, [['chess_wang_a', 5]], '双击 = 幂等装上（已装那位也一样）');
    assert.deepEqual(clear, [], '**绝不能因为点它而卸下**（用户 09:0x 报过的老 bug）');
  });

  test('「配置技能」把已装那位送进技能页；「卸下」是独立按钮；空槽没有卸下', () => {
    const sel = [], clear = [];
    const tree = ReservePicker({ tier: 5, candidates, m: null, entries,
      onConfirm: () => {}, onClear: (id) => clear.push(id), onSelect: (id) => sel.push(id), onClose: () => {} });
    const cfg = buttons(tree).find((b) => /配置技能/.test(b.text));
    assert.equal(cfg.props['data-reserve-config'], 'chess_wang_a');
    cfg.onClick();
    assert.deepEqual(sel, ['chess_wang_a']);
    const off = buttons(tree).find((b) => /卸下/.test(b.text));
    off.onClick();
    assert.deepEqual(clear, ['chess_wang_a']);
    const empty = ReservePicker({ tier: 6, candidates, m: null, entries: {},
      onConfirm: () => {}, onClear: () => {}, onSelect: () => {}, onClose: () => {} });
    assert.ok(!buttons(empty).some((b) => /卸下/.test(b.text)), '没人装着 ⇒ 不该出现卸下');
  });

  test('没有候选时不抛，且给出提示文案', () => {
    const tree = ReservePicker({ tier: 5, candidates: [], m: null, entries: {},
      onConfirm: () => {}, onClear: () => {}, onSelect: () => {}, onClose: () => {} });
    assert.ok(nodes(tree).some((n) => hasClass(n, 'lo-resv-none')), '空候选要有说明（内容包缺 isReserve）');
  });
});

// ══ 🔴 「替换」的语义（用户 09:2x：替换 = **先卸下当前这位，再装新人**；C 定位、B 实现）═══════════════
// 根因：`chooseReserve(id, tier)` 只把 tier 交给 `setReserve` ⇒ 它**只能去找这一阶的第一个空位**
// ⇒ 用户点「替换」时，新人被填进**同阶那个空槽**、旧人还在（两格都满）；两槽都满时更会走淘汰分支**静默换错人**。
// ⇒ 修法：`setReserve(entries, baseId, tier, replaceId)` —— 显式把"要顶掉谁"交进去（语义集中一处）。
describe('「替换」= 先卸下再装（数据层语义；C 的探针 `c-probe-reserve-replace.mjs` 复现的是【修前】调用形态）', () => {
  const TIER = 5;
  test('🔴 同阶 1 满 1 空：替换 ⇒ **仍是 1 满 1 空**，且旧那位已被卸下', () => {
    const before = { chess_bellone_a: { reserve: TIER } };
    const after = setReserve(before, 'chess_chen3_a', TIER, 'chess_bellone_a');
    assert.deepEqual(reserveSlots(after, TIER), ['chess_chen3_a', null],
      `替换后应当是 1 满 1 空，实际 ${JSON.stringify(reserveSlots(after, TIER))}`);
    assert.equal(reserveOf(after, 'chess_bellone_a'), null, '旧那位必须已经卸下（这就是用户报的 bug）');
    assert.equal(reserveOf(after, 'chess_chen3_a'), TIER);
  });

  test('不带 `replaceId`（空槽的「+」那条路）⇒ 行为不变：填进空位、旧的不动', () => {
    const before = { chess_bellone_a: { reserve: TIER } };
    const after = setReserve(before, 'chess_chen3_a', TIER);
    assert.equal(after.chess_bellone_a.reserve, TIER, '「+」不该动已装的那位');
    assert.equal(after.chess_chen3_a.reserve, TIER);
  });

  // ✅ 用户 2026-10-06 10:2x 亲口拍的边界口径（原话）：
  //    「把五阶换成六阶已装的，**六阶直接替换掉五阶的，六阶的那个栏位变成空栏位**」
  //    ⇒ 即：名册里每位只有**一个** `reserve` 值 ⇒ 他**换到被替换的那一阶（5）**，
  //      而他原来站的那一阶（6）**空出来**。**不是**"两个人各占一格"、也不是"留在原阶不动"。
  test('✅ 用户已拍：替换成"已装在另一阶"的那位 ⇒ 他换到本阶（5），原阶（6）变空位', () => {
    const before = { chess_bellone_a: { reserve: 5 }, chess_wang_a: { reserve: 6 } };
    const after = setReserve(before, 'chess_wang_a', 5, 'chess_bellone_a');
    assert.equal(reserveOf(after, 'chess_bellone_a'), null, '5 阶那格空出来（被替换者卸下）');
    assert.equal(reserveOf(after, 'chess_wang_a'), 5, '他换到 5 阶');
    assert.deepEqual(reserveSlots(after, 6), [null, null], '6 阶那个栏位变成空栏位（用户原话）');
    assert.deepEqual(reserveSlots(after, 5), ['chess_wang_a', null], '5 阶 1 满 1 空');
  });

  test('替换成"就是这一位自己" ⇒ 幂等，不许把他卸下', () => {
    const before = { chess_bellone_a: { reserve: 5 } };
    const after = setReserve(before, 'chess_bellone_a', 5, 'chess_bellone_a');
    assert.equal(reserveOf(after, 'chess_bellone_a'), 5);
  });
});

// ══ 🔴 这一组是用户 09:3x 那句「3 阶的外援干员信息未来是需要删除的，调三阶没用」的**代码对应物** ═════════
// 事实：详情面板原来只认 **名册**（`roster`）里的 id，而名册要求 `visible !== false`；
// **外援的正式形态就是 `visible:false`**（贝洛内现在就是）⇒ **选中外援会被静默丢弃** ⇒ **技能改不了**。
// 今天"看起来能用"只是因为测试期把陈/星熊/望也做成 3 阶可见 —— **T-5 一做完立刻全坏，且没有任何报错**。
describe('详情面板的选中口径：外援**不在名册里**也必须能被选中（T-5 之后唯一的路）', () => {
  const ROSTER = [{ chessId: 'chess_char_1_01_a' }, { chessId: 'chess_char_2_02_a' }];   // 名册里没有外援
  const LIST = ROSTER;
  const TABLE = { chess_wang_a: { chessId: 'chess_wang_a' }, chess_bellone_a: { chessId: 'chess_bellone_a' } };
  const getChess = (id) => TABLE[id] || null;

  test('🔴 选中一个**不在名册**里的外援 ⇒ 仍然选中它（老实现会回落到名册第一张卡）', () => {
    assert.equal(detailTargetId('chess_bellone_a', LIST, ROSTER, getChess), 'chess_bellone_a',
      'visible:false 的外援也能进详情面板 —— 否则它的技能永远改不了');
  });

  test('没选 / 选了个不存在的 id ⇒ 回落到列表第一位（行为不变）', () => {
    assert.equal(detailTargetId(null, LIST, ROSTER, getChess), 'chess_char_1_01_a');
    assert.equal(detailTargetId('chess_not_real', LIST, ROSTER, getChess), 'chess_char_1_01_a');
  });
});

// ══ 🆕 2026-10-06 14:3x（C《工作分派-14x》T-4 / 《落地单》P3「外援槽 UI 扩容到 16 位」）═══════════════════════
// 背景：助战/外援要从 **4 位**扩到 **16 位 × 2 阶**（采用 `play.simpfun.cn` 的"按阶拆记录"形状）
//   ⇒ 一屏铺不下 ⇒ picker 要有 **分页 / 搜索 / 按阶筛选**，并在每张卡上**显示记录阶级**。
// ⚠️ 判据的形状（本轮教训）：**打在这几个"人真的会点的东西"上** ——
//   `data-resv-page`（页码）/`data-resv-prev|next`（真调 onClick）/`data-resv-count`（计数）/`data-resv-noresult`（筛空）。
//   🆕 2026-10-07 16:0x（R1 口径变更）：原来的「**每张卡的 `lo-resv__tier` 角标**（按阶展示）」**已作废** ——
//      用户要「不标注阶级」⇒ 现在断言的是"**一张卡都不带阶标**"；"按盟约分组"另见 `reserve-picker-r1.test.js`。
describe('外援 picker 扩容（16 位）：分页 / 搜索 / 按阶筛选（"按阶展示"已按 R1 作废）', () => {
  const mk = (n, tier) => ({ chessId: `chess_o${n}_a`, name: `干员${n}`, tier });
  const many = Array.from({ length: 20 }, (_, i) => mk(i + 1, 5));            // 20 位（> 一页）
  const base = { m: null, entries: {}, onConfirm: () => {}, onClear: () => {}, onSelect: () => {}, onClose: () => {} };
  const pickIds = (tree) => buttons(tree).map((b) => b.props['data-pick']).filter(Boolean);
  const attr = (tree, name) => nodes(tree).find((n) => n.props?.[name] != null)?.props[name];

  test('分页：一页 12 位、第二页是剩下的 8 位；页码与「上一页」禁用态都对', () => {
    const p0 = ReservePicker({ ...base, tier: 5, candidates: many, page: 0 });
    assert.equal(pickIds(p0).length, 12, '第一页只渲染 pageSize 条（不是 20 条全铺）');
    assert.equal(attr(p0, 'data-resv-page'), '1/2');
    assert.equal(buttons(p0).find((b) => b.props['data-resv-prev']).props.disabled, true, '第一页的「上一页」必须禁用');
    const p1 = ReservePicker({ ...base, tier: 5, candidates: many, page: 1 });
    assert.equal(pickIds(p1).length, 8, '第二页是剩下的 8 位');
    assert.equal(attr(p1, 'data-resv-page'), '2/2');
    assert.equal(buttons(p1).find((b) => b.props['data-resv-next']).props.disabled, true, '最后一页的「下一页」必须禁用');
    // 越界的 page 要被夹回最后一页（否则用户会看到一个空列表）
    assert.equal(pickIds(ReservePicker({ ...base, tier: 5, candidates: many, page: 99 })).length, 8);
  });

  test('「下一页」真的把页码交给父组件（`onPage(n)`），不是自己偷偷改', () => {
    const pages = [];
    const t = ReservePicker({ ...base, tier: 5, candidates: many, page: 0, onPage: (n) => pages.push(n) });
    buttons(t).find((b) => b.props['data-resv-next']).onClick();
    assert.deepEqual(pages, [1]);
  });

  test('搜索：按名字筛 ⇒ 只剩那一位；筛空时给**专门**文案（别把"筛空"说成"数据里没有外援"）', () => {
    const hit = ReservePicker({ ...base, tier: 5, candidates: many, query: '干员13' });
    assert.deepEqual(pickIds(hit), ['chess_o13_a']);
    const none = ReservePicker({ ...base, tier: 5, candidates: many, query: '不存在的名字' });
    assert.equal(pickIds(none).length, 0);
    assert.ok(nodes(none).some((n) => n.props?.['data-resv-noresult'] != null), '筛空要有专门的提示节点');
    assert.ok(!/没有外援干员候选/.test(textOf(none)), '「筛空」与「数据里没有外援」必须是两句不同的话');
  });

  test('按阶筛选：auto（本阶有货 ⇒ 只看本阶）/ 显式 all / 本阶没货时兜底显示全部', () => {
    const mixed = [mk(1, 5), mk(2, 6), mk(3, 5), mk(4, 6)];
    assert.deepEqual(pickIds(ReservePicker({ ...base, tier: 5, candidates: mixed })).sort(), ['chess_o1_a', 'chess_o3_a'],
      'auto：本阶（5）有货 ⇒ 只显示 5 阶那两条');
    assert.equal(pickIds(ReservePicker({ ...base, tier: 5, candidates: mixed, tierFilter: 'all' })).length, 4);
    assert.deepEqual(pickIds(ReservePicker({ ...base, tier: 5, candidates: [mk(9, 6)] })), ['chess_o9_a'],
      '老数据（只有 tier=6 一条）在 5 阶槽里 **auto 不能变成空列表** —— 这是兼容性判据');
  });

  test('筛选按钮的语义：把 auto 的当前结果切到另一边（点一下 ⇒ `onTierFilter("all")`）', () => {
    const seen = [];
    const t = ReservePicker({ ...base, tier: 5, candidates: [mk(1, 5), mk(2, 6)], onTierFilter: (v) => seen.push(v) });
    buttons(t).find((b) => b.props['data-resv-tierfilter']).onClick();
    assert.deepEqual(seen, ['all'], 'auto 在"本阶有货"时等价于 this ⇒ 点一下切到 all');
  });

  test('🚫 R1（用户 16:0x「不标注阶级」）：每张候选卡**都不带**阶级角标；计数条随筛选变化', () => {
    const mixed = [mk(1, 5), mk(2, 6)];
    const t = ReservePicker({ ...base, tier: 5, candidates: mixed, tierFilter: 'all' });
    const chips = nodes(t).filter((n) => hasClass(n, 'lo-resv__tier'));
    assert.equal(chips.length, 0,
      '外援面板**一张卡都不画阶标** —— 原来画的是**记录** tier（外援全是 6）⇒ 卡片冒 VI，正是用户点名要去的那个标记');
    assert.equal(attr(t, 'data-resv-count'), '2');
    const filtered = ReservePicker({ ...base, tier: 5, candidates: mixed, query: '干员1' });
    assert.equal(attr(filtered, 'data-resv-count'), '1', '计数条要反映筛选后的数量');
  });
});
