// card-marks.test.js — 标记卡（"本局我想要"高亮）的纯逻辑判据（C 需求件 J-1 / J-2 / J-2bis / J-5）
//
// 🔴 两条**负对照**是这批判据的全部价值（C 原话：「J-2／J-3 的负对照是这两条判据的全部价值」）：
//    · J-2：按盟约批量之后，**必须有至少一位别的盟约的干员仍是 false**（否则就是"全选"了）；
//    · J-2bis：**未激活**的盟约调用 ⇒ 无效果；"全部高亮"之后**至少一位别的盟约干员仍 false**。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const M = await import('../../public/js/ui/cardMarks.js');
// 判据用**真实夹具**（data/*.json 只读）—— 避免自己编一份和线上不同的池子（本仓"夹具自造 ⇒ 假绿"的坑）
const { readFileSync } = await import('node:fs');
const J = (f) => JSON.parse(readFileSync(new URL(`../../data/${f}`, import.meta.url), 'utf8'));
const chess = J('chess.json');
const bonds = J('bonds.json');
const diy = J('backups.json').diy;
const ALL_BONDS = Object.keys(bonds);

describe('J-1 标记的纯逻辑（切/查/清）', () => {
  test('标记后 true、取消后 false；**负对照**：没标过的 id ⇒ false', () => {
    const a = 'chess_char_1_01_a';
    let marks = [];
    assert.equal(M.isMarked(marks, a), false, '负对照：初始必须没被标');
    marks = M.toggleMark(marks, a);
    assert.equal(M.isMarked(marks, a), true);
    marks = M.toggleMark(marks, a);
    assert.equal(M.isMarked(marks, a), false, '再切一次 ⇒ 取消');
    assert.equal(M.isMarked(marks, 'chess_char_9_99_z'), false, '负对照：无关 id 恒 false');
  });
  test('纯函数：原数组不被改（面板靠引用比较决定重渲染）', () => {
    const before = ['x'];
    const after = M.toggleMark(before, 'chess_char_1_01_a');
    assert.deepEqual(before, ['x'], '原数组必须没动');
    assert.notEqual(after, before, '返回的是新数组');
  });
  test('unmarkAll ⇒ 空；markMany 去重', () => {
    assert.deepEqual(M.unmarkAll(), []);
    assert.deepEqual(M.markMany([], ['a', 'a', 'b']), ['a', 'b']);
    assert.deepEqual(M.unmarkMany(['a', 'b', 'c'], ['b']), ['a', 'c']);
  });
});

describe('J-2 按盟约批量（负对照：别的盟约一个都不沾）', () => {
  test('markBondIds(叙拉古) ⇒ 该盟约候选全被标；**至少一位别的盟约干员仍 false**', () => {
    const ids = M.markBondIds(chess, diy, 'siracusaShip');
    assert.ok(ids.length > 0, '叙拉古应当有候选（实测 visibleMembers 10 条）');
    for (const id of ids) assert.deepEqual(M.bondsOf(chess, id).includes('siracusaShip'), true);
    const marks = M.markMany([], ids);
    for (const id of ids) assert.equal(M.isMarked(marks, id), true);
    // 🔴 负对照：换一个盟约的候选 ⇒ 必须还是 false
    const other = M.markBondIds(chess, diy, 'yanShip');
    assert.ok(other.length > 0, '炎国应当也有候选（否则这条负对照没意义）');
    const stranger = other.find((id) => !ids.includes(id));
    assert.ok(stranger, '两个盟约的候选集应当有不相交的成员');
    assert.equal(M.isMarked(marks, stranger), false, '🔴 别的盟约的干员不许被顺手标上（否则就是"全选"）');
  });
  test('未激活/不存在的盟约 ⇒ 空（负对照：不许退化成全选）', () => {
    assert.deepEqual(M.markBondIds(chess, diy, 'nopeShip'), []);
    assert.deepEqual(M.markBondIds(chess, diy, 'suntShip'), [], 'suntShip 的 visibleMembers 是空的（实测）⇒ 候选空');
  });
});

describe('J-2bis 入口＝已激活盟约（未激活的调用无效果）', () => {
  test('selectableBondIds：禁用的盟约被摘掉；**负对照**：没禁用时全在', () => {
    assert.equal(M.selectableBondIds(ALL_BONDS, {}).length, ALL_BONDS.length, '没有禁用 ⇒ 一个不少');
    const off = M.selectableBondIds(ALL_BONDS, { disabledBonds: ['siracusaShip'] });
    assert.equal(off.includes('siracusaShip'), false, '被禁 ⇒ 不可点');
    assert.equal(off.length, ALL_BONDS.length - 1);
    assert.equal(M.selectableBondIds(ALL_BONDS, { drawnDisabledBonds: ['yanShip'] }).includes('yanShip'), false, 'drawnDisabledBonds 也认');
  });
  test('"该盟约全部高亮"＝候选集全勾，而**不是全树**（至少一位别的盟约仍 false）', () => {
    const ids = M.markBondIds(chess, diy, 'siracusaShip');
    const marks = M.markMany([], ids);
    const candidates = M.candidateChessIds(chess, diy);
    assert.ok(candidates.length > ids.length, '候选集必须比单个盟约大（否则这条判据恒真）');
    const outside = candidates.filter((id) => !ids.includes(id));
    assert.ok(outside.some((id) => !M.isMarked(marks, id)), '🔴 盟约外必须还有没被标的');
  });
  test('候选口径：隐藏项不进候选；🔴 **不用自选池**（实测 ownedPool 与 chess.charId 交集 0 ⇒ 按它筛会 23/23 盟约全空）', () => {
    const candidates = M.candidateChessIds(chess, diy);
    const hidden = Object.entries(chess).filter(([, r]) => r.visible === false || r.isHidden === true).map(([k]) => k);
    assert.ok(hidden.length > 0, '夹具里应当有隐藏项（实测 42 条）');
    for (const h of hidden) assert.equal(candidates.includes(h), false, `隐藏项不许进候选：${h}`);
    assert.equal(candidates.length, Object.keys(chess).length - hidden.length, '候选 = 全部可见（实测 224 = 266 − 42）');
    // 🔴 事实记录（**会随数据漂移**，所以只记不判死）：2026-10-08 早先实测 `ownedPool ∩ chess.charId = 0`，
    //    当天晚些重测变 **4**（数据被重建过）⇒ 比例类断言一律**不作为契约**。
    //    真正的契约只有两条：**隐藏项不进候选**（上一行）＋ **每个盟约都标得到**（下一行）。
    const pool = diy.ownedPool;
    const inter = pool.filter((x) => Object.values(chess).some((r) => r.charId === x));
    assert.ok(inter.length < pool.length, `ownedPool 与 chess.charId 只该有极少数交集（实测 0 → 4；实得 ${inter.length}/${pool.length}）`);
    assert.ok(M.markBondIds(chess, diy, 'siracusaShip').length > 0, '叙拉古必须标得到（这是候选口径的实质护栏）');
  });
});

describe('J-5 持久化：往返一致 ＋ 坏数据安全回退（不许崩）', () => {
  const fake = () => {
    const map = new Map();
    globalThis.localStorage = {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: (k) => map.delete(k),
    };
    return map;
  };
  test('saveMarks → loadMarks 往返一致', () => {
    fake();
    const ids = M.markBondIds(chess, diy, 'siracusaShip').slice(0, 3);
    M.saveMarks('R1#match', ids);
    assert.deepEqual(M.loadMarks('R1#match'), ids);
  });
  test('🔴 坏数据（null／"{}"／[1,{},"x",null] 等）⇒ 安全回退，**不抛**', () => {
    const map = fake();
    for (const bad of [null, '{}', '[1,{},"x",null]', '"x"', '{"a":1}', '[[]]', 'true']) {
      map.set(`sp.pref.${M.CARD_MARKS_KEY}`, bad);
      let got;
      assert.doesNotThrow(() => { got = M.loadMarks('R1#match'); }, `坏数据不许抛：${bad}`);
      assert.ok(Array.isArray(got), `坏数据要回退成数组：${bad}`);
      for (const x of got) assert.equal(typeof x, 'string', `回退后只留字符串：${bad}`);
    }
    delete globalThis.localStorage;
    assert.deepEqual(M.loadMarks('R1#match'), [], '连 localStorage 都没有 ⇒ 空集（老环境/Node）');
  });
  test('cleanMarks：去重 / 丢空 / 丢超长 / 有上限', () => {
    assert.deepEqual(M.cleanMarks(['a', 'a', '', null, 'b']), ['a', 'b']);
    assert.deepEqual(M.cleanMarks(['x'.repeat(65)]), [], '超长 id 丢掉');
    assert.equal(M.cleanMarks(Array.from({ length: 900 }, (_, i) => `c${i}`)).length, M.CARD_MARKS_MAX);
  });
});

// ── J-3 / J-4：**卡面高亮**（DOM 级：真走 vnode、真调 onClick）─────────────────────────────────────
// 做法与 `chat-panel.test.js` 同一套：把 htm 的 vnode 树走一遍、把 `props.onClick` 当 DOM 会调的函数**真调一次**
// （本仓教训：「文件里写着 onClick」证明不了点下去会发生什么）。
const { ChessCard } = await import('../../public/js/ui/shopBar.js');
function* walk(v) {
  if (Array.isArray(v)) { for (const x of v) yield* walk(x); return; }
  if (!v || typeof v !== 'object') return;
  yield v;
  for (const [k, val] of Object.entries(v.props || {})) {
    if (k === 'children' || val == null || typeof val !== 'object') continue;
    yield* walk(val);
  }
  yield* walk(v.props?.children);
}
const findMarkBtn = (tree) => [...walk(tree)].find((n) => n.props?.['data-card-marked'] != null) || null;
const findStar = (tree) => [...walk(tree)].find((n) => n.props?.['data-card-mark'] != null) || null;
const cls = (n) => String(n?.props?.class || '').split(/\s+/).filter(Boolean);
const SLOT = (id) => ({ id, kind: 'chess', price: 3 });
const BASE = { priv: {}, onBuy: () => {}, onDetail: () => {} };

describe('J-3 卡面高亮（DOM 级；负对照＝同一次遍历里必须一张带一张不带）', () => {
  test('标记的卡带 `is-marked` 与 `data-card-marked=1`；未标记的不带', () => {
    const marked = ChessCard({ ...BASE, slot: SLOT('chess_char_1_01_a'), idx: 0, marked: true, onMark: () => {} });
    const plain = ChessCard({ ...BASE, slot: SLOT('chess_char_1_02_a'), idx: 1, marked: false, onMark: () => {} });
    // 🔴 **同一次遍历**（两张卡一起走）—— 这正是 C 要的负对照：否则"恒真"也能过
    const btns = [...walk([marked, plain])].filter((n) => n.type === 'button' && n.props?.['data-card-marked'] != null);
    assert.equal(btns.length, 2, '两张卡都要有 data-card-marked（判据才分得清）');
    assert.equal(btns[0].props['data-card-marked'], '1');
    assert.equal(btns[1].props['data-card-marked'], '0', '未标记 ⇒ 属性**恒存在**（值 0）—— 判据才分得清');
    assert.equal(cls(btns[0]).includes('is-marked'), true);
    assert.equal(cls(btns[1]).includes('is-marked'), false, '🔴 一张带、一张不带');
    // ⛔ 不许碰到既有语义（armed / frozen / merge / disabled 的 class 一个都没变）
    for (const other of ['is-armed', 'is-frozen', 'is-merge', 'is-disabled']) {
      assert.equal(cls(btns[0]).includes(other), false, `标记不许顺手加 ${other}`);
    }
  });
});

describe('J-3bis 卡角的星＝逐卡入口（点了回调带 idx/id/want；不传 onMark ⇒ 没有星）', () => {
  test('未标记时 want=true；已标记时 want=false；**不传 onMark 的调用点零影响**', () => {
    const calls = [];
    const off = ChessCard({ ...BASE, slot: SLOT('chess_char_1_01_a'), idx: 2, marked: false, onMark: (i, id, w) => calls.push([i, id, w]) });
    const star = findStar(off);
    assert.ok(star, '有 onMark ⇒ 渲染星');
    assert.equal(star.props['data-card-mark'], 'chess_char_1_01_a', '星上带的是 **chess id**（标记集合的键）');
    star.props.onClick({ stopPropagation: () => {} });
    assert.deepEqual(calls, [[2, 'chess_char_1_01_a', true]], '点未标记的 ⇒ want=true');
    const on = ChessCard({ ...BASE, slot: SLOT('chess_char_1_01_a'), idx: 2, marked: true, onMark: () => {} });
    assert.equal(cls(findStar(on)).includes('is-on'), true, '已标记 ⇒ 星点亮');
    const none = ChessCard({ ...BASE, slot: SLOT('chess_char_1_01_a'), idx: 2 });
    assert.equal(findStar(none), null, '不传 onMark ⇒ 不渲染星（奖励卡/老调用点不受影响）');
  });
});

describe('J-4 随时可改：同一张卡 marked false → true，**下一次渲染**就带高亮', () => {
  test('前后两次渲染对比（状态在父层 ⇒ 改一次就重渲染一次）', () => {
    const before = ChessCard({ ...BASE, slot: SLOT('chess_char_1_01_a'), idx: 0, marked: false, onMark: () => {} });
    const after = ChessCard({ ...BASE, slot: SLOT('chess_char_1_01_a'), idx: 0, marked: true, onMark: () => {} });
    assert.equal(cls(findMarkBtn(before)).includes('is-marked'), false, '改之前不带');
    assert.equal(cls(findMarkBtn(after)).includes('is-marked'), true, '改之后**下一次渲染**就带');
  });
  test('高亮是"按 id 判定"的：同一批里只标其中一个 ⇒ 只有它带（防"整排都亮"）', () => {
    const ids = ['chess_char_1_01_a', 'chess_char_1_02_a', 'chess_char_1_03_a'];
    const marks = [ids[1]];
    const trees = ids.map((id, i) => ChessCard({ ...BASE, slot: SLOT(id), idx: i, marked: marks.includes(id), onMark: () => {} }));
    const flags = [...walk(trees)].filter((n) => n.props?.['data-card-marked'] != null).map((n) => n.props['data-card-marked']);
    assert.deepEqual(flags, ['0', '1', '0'], '🔴 只标中间那张 ⇒ 只有它带（负对照：两边必须不带）');
  });
});

// ── 🔴 2026-10-09 用户实测 bug：标记跨局残留 ────────────────────────────────────────────────────────
test('🔴 标记是**本局**的：换局/换房/回等待室都不许残留（旧裸数组也忽略）', () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  // 纯函数：marker = 房间码#相位
  assert.equal(M.marksMarker({ code: 'VRWP', inMatch: true }), 'VRWP#match');
  assert.equal(M.marksMarker({ code: 'VRWP', inMatch: false }), 'VRWP#lobby');
  assert.equal(M.marksMarker(null), '', '没有房间 ⇒ 空 marker');
  assert.equal(M.marksMarker({}), '');
  // 同一局往返一致
  M.saveMarks('VRWP#match', ['a', 'b']);
  assert.deepEqual(M.loadMarks('VRWP#match'), ['a', 'b']);
  // 🔴 核心：**下一局**（相位变回 lobby、再变 match）⇒ 空集
  assert.deepEqual(M.loadMarks('VRWP#lobby'), [], '回等待室 ⇒ 空');
  M.saveMarks('VRWP#lobby', ['x']);
  assert.deepEqual(M.loadMarks('VRWP#match'), [], 'lobby 阶段写的也不许带进 match 阶段');
  // 换房 ⇒ 空
  M.saveMarks('VRWP#match', ['a']);
  assert.deepEqual(M.loadMarks('ABCD#match'), [], '换了房 ⇒ 空');
  // 连打两局：局 1 标 a，局 2 只标 c ⇒ 局 2 读不到 a
  M.saveMarks('VRWP#match', ['a']);
  M.saveMarks('VRWP#lobby', []);           // 局 1 结束回等待室（清）
  M.saveMarks('VRWP#match', ['c']);        // 局 2
  assert.deepEqual(M.loadMarks('VRWP#match'), ['c'], '局 2 只有它自己标的');
  // ⚠️ 修这个 bug 之前的**存量数据是裸数组** ⇒ 必须当空集忽略（玩家不用手清）
  store.set('sp.pref.' + M.CARD_MARKS_KEY, JSON.stringify(['old1', 'old2']));
  assert.deepEqual(M.loadMarks('VRWP#match'), [], '旧裸数组 ⇒ 忽略（这正是用户遇到的残留）');
  // 坏形状也不许抛
  for (const bad of ['null', '[]', '{"marker":123,"ids":"x"}', '{"ids":["a"]}', '"str"']) {
    store.set('sp.pref.' + M.CARD_MARKS_KEY, bad);
    assert.doesNotThrow(() => M.loadMarks('VRWP#match'));
  }
  delete globalThis.localStorage;
});
// b12-marks-scope-marker
