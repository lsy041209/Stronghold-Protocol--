// test/render/wang-pieces.test.js — 望的「跟子 / 补子」**显示层**护栏（第 4 任 B，2026-10-06）。
//
// 用户原话（A 的 `交接-A到B.md` 06:1x §1 转述，权威）：
//   「…并在旁边部署一颗**非玩家自己部署的无来源棋子**，该棋子属于望自己本人的弹道，
//     **以让玩家明了『这是补充的棋子』**」。
//
// 机制早就在跑（不需要新做）：手放一枚棋子 ⇒ 望在**相邻格**配出一枚"跟子"，记在 `owner.mem.wang.followers`
// （`{r,c,…}`，**在跑版** `server/sim/content/kits/ops/op-wang.js:300` / `:159-165` —— 🔴 2026-10-08 B12 换过名：
// 退休的内置版望写 `owner.mem.wangFollow`，而 `kits/index.js:138` 只注册 `op-wang.js`）。**但跟子不是单位**
// （官方：「不具有单位相关的性质」）⇒ 不在 `battle.allyUnits`
// ⇒ 引擎侧不画 ⇒ **玩家什么都看不到**，这正是用户说"不会在旁边部署"的原因。
// 补子相反：它是**真单位**（望自己重新部署上场的棋子，**不是**玩家战前摆的那一批 —— 在跑版没有 mem 标记，
// 用 `mem.wangNode` + `deployedAt > 0` 判，见 `runner.js:wangMarks`），本来就会画，只是看不出"这是补的"。
//
// 分工（A 交接明确）：引擎只留标记；**画什么由 B 定**。本文件就钉住 B 定的那份口径：
//   · 跟子 ⇒ **幽灵棋子**（同一套官方模型 + `UnitView.dimmed`）+ **青色格框** `WANG_PIECE_STYLE`；
//   · 补子 ⇒ **琥珀色格框** `WANG_REFILL_STYLE`。
//
// ⚠️ 本文件**只测纯规划函数与源码接线**，不建 canvas：
//    `wangMarkPlan(marks)` 是纯函数（marks → 要画什么），而真正的画由 `setWangMarks` 用现成的
//    `UnitView` / `tiles.setHighlights` 完成（那两条路径分别由 test/render/unitview.test.js 与
//    tiles 自己的用例覆盖）。这样这条护栏**在任何机器上都不会因为缺 GPU / 缺素材而红**。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(path.resolve(ROOT, p), 'utf8');

const { wangMarkPlan, WANG_PIECE_STYLE, WANG_REFILL_STYLE } = await import('../../public/js/render/app.js');
const { spineEntry } = await import('../../public/js/assets.js');
// 引擎侧**自己那一份** token id（不是我在测试里另抄一个字符串）⇒ token 改名时这条护栏会**跟着改名**，
// 于是"改了名却没登记模型"当场变红（这正是要防的静默回归）。
// 🔴 2026-10-08 B12：改从**在跑的那一版**取（`kits/ops/op-wang.js:68`，`kits/index.js:138` 只注册它）——
//    原来取的是 `server/sim/content/tokens.js`（退休内置版望的家，0.2.1 基座里那个常量**已经不在那儿了**
//    ⇒ 拿到 `undefined` ⇒ 下面"能解析出模型"那组报的是间接症状）。
const { STONE } = await import('../../server/sim/content/kits/ops/op-wang.js');
// 🔴 全链判据要用的三件真东西（都是**生产构造器**，不是我在测试里仿的）：
//   `buildBattleSpec`（服务端/客户端共用的 spec 构造器）｜`getDefaultSource()`（真数据源）｜`createBattleRunner`
//   （真的客户端 runner —— 它自己 `createBattleFromSpec` 建这局，再自己 `wangMarks()` 读出来）。
const specMod = await import('../../server/sim/spec.js');
const { getDefaultSource } = await import('../../server/sim/simdata.js');
const { createBattleRunner } = await import('../../public/js/battle/runner.js');
// 战斗帧的真实接线（从 `screens/game.js` 抽出来的那条路径）—— **纯模块，不拉 Preact/网络/音频**，所以能在这里跑。
const { createBattleFrames } = await import('../../public/js/screens/battleFrames.js');
/** 剥掉 `//` 与 `/* … *\/` 注释。**匹配源码前必须先剥** —— 上一版就是被窗口里的注释骗绿的。 */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/** A `battleRunner.wangMarks()` payload (the runner's own tests cover how it is read off the sim). */
const marks = (follow, refilled) => ({ follow, refilled });

describe('望的跟子 / 补子：显示层要画什么（纯规划）', () => {
  test('跟子 ⇒ 一枚该格上的幽灵棋子，带上持有者棋子的模型 id 和格框', () => {
    const p = wangMarkPlan(marks([{ r: 9, c: 5, ownerUnitId: 3, ownerId: 'u1', spine: 'token_10064_wang_stone1' }], []));
    assert.equal(p.ghosts.length, 1, '一条跟子 ⇒ 一个幽灵视图');
    const g = p.ghosts[0];
    assert.equal(g.r, 9); assert.equal(g.c, 5);
    assert.equal(g.spine, 'token_10064_wang_stone1', '幽灵用**和棋子同一个**官方模型（不是占位图形）');
    assert.equal(g.ownerUnitId, 3, '记得它属于哪一枚棋子');
    assert.equal(g.key, 'w:9,5', '视图键按格固定 ⇒ 同一格不会重复建视图');
    assert.deepEqual(p.followTiles, [[9, 5]], '同一格也要进格框（青色）');
  });

  test('跟子**不是单位**：没有 unitId 这个概念，也不该混进补子的列表', () => {
    const p = wangMarkPlan(marks([{ r: 9, c: 5, spine: 'x' }], []));
    assert.equal(p.refilledTiles.length, 0, '跟子不能被当成"补出来的棋子"');
    assert.ok(!('unitId' in p.ghosts[0]), '幽灵视图不是按 unitId 建的（它没有 id）');
  });

  test('补出来的棋子 ⇒ 只打格框（它本来就是真单位，已经在画了）', () => {
    const p = wangMarkPlan(marks([], [{ unitId: 7, r: 11, c: 4 }]));
    assert.equal(p.ghosts.length, 0, '补子**不**建幽灵视图（否则会画出一枚重复的棋子）');
    assert.deepEqual(p.refilledTiles, [[11, 4]]);
  });

  test('两种标记可以同时存在，各归各的', () => {
    const p = wangMarkPlan(marks(
      [{ r: 9, c: 5, spine: 'token_10064_wang_stone1' }],
      [{ unitId: 7, r: 11, c: 4 }, { unitId: 8, r: 11, c: 5 }],
    ));
    assert.deepEqual(p.followTiles, [[9, 5]]);
    assert.deepEqual(p.refilledTiles, [[11, 4], [11, 5]]);
  });

  test('坏数据一律丢掉，不抛（空 / null / 缺 r,c / 非整数）', () => {
    assert.deepEqual(wangMarkPlan(null), { ghosts: [], followTiles: [], refilledTiles: [] });
    assert.deepEqual(wangMarkPlan(undefined), { ghosts: [], followTiles: [], refilledTiles: [] });
    assert.deepEqual(wangMarkPlan({}), { ghosts: [], followTiles: [], refilledTiles: [] });
    const p = wangMarkPlan(marks([null, {}, { r: 1 }, { c: 2 }, { r: NaN, c: 3 }], [null, {}]));
    assert.deepEqual(p.ghosts, [], '缺坐标的条目一个都不画');
    assert.deepEqual(p.refilledTiles, []);
  });

  test('同一格重复的跟子只画一枚（引擎理论上不会重复，重复也不许叠出两个视图）', () => {
    const p = wangMarkPlan(marks([{ r: 9, c: 5, spine: 'x' }, { r: 9, c: 5, spine: 'x' }], []));
    assert.equal(p.ghosts.length, 1);
    assert.equal(p.followTiles.length, 1);
  });

  test('两套样式都是 `tiles.js setHighlights` 认的形状，且青/琥珀是两种颜色', () => {
    for (const st of [WANG_PIECE_STYLE, WANG_REFILL_STYLE]) {
      assert.equal(typeof st.color, 'number');
      assert.equal(typeof st.fill, 'number');
      assert.equal(typeof st.line, 'number');
      assert.equal(typeof st.group, 'string');
    }
    assert.notEqual(WANG_PIECE_STYLE.color, WANG_REFILL_STYLE.color, '跟子与补子必须是**看得出区别**的两种标记');
    assert.notEqual(WANG_PIECE_STYLE.group, WANG_REFILL_STYLE.group, '格框分组不同 ⇒ 互不覆盖');
  });
});

// ══ 真正的接线：**跑** `screens/battleFrames.js` 那条真实路径（不是 match 源码） ══════════════════════════
// 为什么要有这一组（2026-10-06，第 5 任 B —— 我的**假绿**被 C 从玩家机日志戳穿）：
//   上一版这里断的是源码片段 `if (field.local && battleRunner` —— **那行确实在代码里**，
//   但 `field` 的初值是 `null`（`store.emptyMatch()`）而这个 effect 的依赖数组**不含 `field`**
//   ⇒ 注册那一刻的 `null` 被闭包冻住 ⇒ **每次 snap 都在 `field.local` 抛 TypeError**，
//   被 `runner.js:181-182` 的统一 try/catch 吞掉（用户机日志 **1288 行**）⇒ 它后面的
//   `setWangMarks` **一次都没跑过** ⇒ 幽灵棋子从来没画过。
//   ⇒ **静态断言看不见"这行会不会抛"**。所以现在：把逻辑抽到 `screens/battleFrames.js`（入参里**没有** `field`），
//     并且在下面用**假 net / 假 runner** 真跑：runner 发的帧 ⇒ 推标记；net 发的帧 ⇒ 不推；任何一帧都不许抛。
/** 一个能"发帧"的假 emitter：记下注册的 handler，返回 off（形状与 `net.on` / `runner.on` 一致）。 */
function emitter() {
  const handlers = new Map();
  return {
    on(type, fn) {
      const list = handlers.get(type) || [];
      list.push(fn);
      handlers.set(type, list);
      return () => { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); };
    },
    emit(type, payload) { for (const fn of [...(handlers.get(type) || [])]) fn(payload); },
    count(type) { return (handlers.get(type) || []).length; },
  };
}
/** `game.js` 里那六个 ref（同名同形：都是 `useRef(...)` 的 `{ current }` 容器）。 */
const mkRefs = (fieldId = 'n:P1') => ({
  reentryRef: { current: null }, lastFieldRef: { current: fieldId },
  snapBufRef: { current: new Map() }, evBufRef: { current: new Map() },
  snapUnitsRef: { current: new Map() }, hudRef: { current: null },
});
/** 一套"真跑"的场地：假 net / 假 runner（带 wangMarks）/ 记事的 view。 */
function frameWorld({ fieldId = 'n:P1', marks = { follow: [{ r: 9, c: 5 }], refilled: [] } } = {}) {
  const net = emitter(), runner = emitter();
  runner.wangMarks = () => marks;
  const pushed = [], snapshots = [], events = [];
  const view = { pushSnapshot: (s) => snapshots.push(s), pushEvents: (m) => events.push(m), setWangMarks: (m) => pushed.push(m) };
  const refs = mkRefs(fieldId);
  const huds = [];
  const frames = createBattleFrames({
    view, net, runner, audio: { handleBattleEvents() {} }, refs,
    snapHud: () => ({ hp: 1 }), setHud: (h) => huds.push(h), keepEarly: () => false,
    hzMs: 0, now: () => 0, setT: () => 0, clearT: () => {},
  });
  return { net, runner, view, refs, pushed, snapshots, events, huds, frames };
}

describe('接线：跑真实的 battleFrames（不是 match 源码）', () => {
  test('🔴 复现用户那条 bug：`field` 还是 null 时注册的监听器，收到 snap 必须**不抛**且把标记推给视图', () => {
    const w = frameWorld();
    // ⚠️ 这里**没有任何 `field`**（等价于 store 里 `match.field === null` 的那一次注册）。
    //    老实现读的就是这个被闭包冻住的 null ⇒ `TypeError: Cannot read properties of null (reading 'local')`。
    assert.equal(w.runner.count('snap'), 1, '本地战斗的 snap 必须注册在 runner 上');
    assert.equal(w.net.count('b.snap'), 1, '服务端直播的 snap 也要注册');
    w.runner.emit('snap', { fieldId: 'n:P1', units: [[1, 2]] });   // ← 老实现**在这一行抛**
    assert.equal(w.pushed.length, 1, 'runner 发的帧 ⇒ 必须把 wangMarks 推给视图（幽灵棋子/青框靠它）');
    assert.equal(w.pushed[0], w.runner.wangMarks('n:P1'), '推的就是 runner 的 marks');
    assert.deepEqual(w.snapshots.length, 1, '同一帧照旧进 pushSnapshot');
    assert.equal(w.huds.length, 1, 'HUD 也要跟着更新（老实现里它同样被那一行吃掉）');
    assert.equal(w.refs.snapUnitsRef.current.get(1)[0], 1, 'snapUnitsRef 也一样（老实现里从没更新过）');
  });

  test('服务端直播的帧（net）**不许**推标记 —— 那种帧里没有 `mem`，画不出跟子', () => {
    const w = frameWorld();
    w.net.emit('b.snap', { fieldId: 'n:P1', units: [] });
    assert.equal(w.pushed.length, 0, 'net 的帧没有 mem ⇒ 不推（这是能力边界，不是 bug）');
    assert.equal(w.snapshots.length, 1, '但帧照旧进视图');
  });

  test('别的场次的帧先缓存、不许推给当前视图（同格标记会画错地方）', () => {
    const w = frameWorld({ fieldId: 'n:P1' });
    w.runner.emit('snap', { fieldId: 'n:P2', units: [] });
    assert.equal(w.pushed.length, 0); assert.equal(w.snapshots.length, 0);
    assert.ok(w.refs.snapBufRef.current.has('n:P2'), '缓存起来了（重进那个场次时用它开场）');
  });

  test('坏帧一律不抛（null / 非对象 / 缺 fieldId / units 不是数组）', () => {
    const w = frameWorld();
    // 形状**完全不是帧**的：原实现直接 return（连 pushSnapshot 都不做）
    for (const bad of [null, undefined, 0, 'x', true]) {
      w.runner.emit('snap', bad);
      w.net.emit('b.snap', bad);
      w.runner.emit('ev', bad);
      w.net.emit('b.ev', bad);
    }
    assert.equal(w.snapshots.length, 0, '非对象一律丢掉');
    assert.equal(w.pushed.length, 0, '非对象不许推标记');
    // 形状是对象、但**没声明别的场次**的 ⇒ 契约是"当成当前场次的帧"（原实现如此：`fieldId` 是可选自述）
    // runner 3 帧 + net 3 帧 = 6 次进视图；其中只有 runner 的 3 帧推标记（net 的帧没有 mem）。
    // 第 4 个 `{ fieldId: 5 }` 声明了一个**不是当前场次**的值 ⇒ 两边的调用都被丢掉（也不缓存，它不是字符串）。
    for (const odd of [[], {}, { fieldId: 5 }, { fieldId: 'n:P1', units: 'no' }]) {
      w.runner.emit('snap', odd);
      w.net.emit('b.snap', odd);
    }
    assert.equal(w.snapshots.length, 6, '6 帧进视图（不抛）');
    assert.equal(w.pushed.length, 3, '只有 runner 的 3 帧推标记');
  });

  test('dispose 会摘掉每一个监听器（否则重进 screen 会重复推帧）', () => {
    const w = frameWorld();
    w.frames.dispose();
    assert.equal(w.runner.count('snap'), 0);
    assert.equal(w.net.count('b.snap'), 0);
    assert.equal(w.net.count('m.field'), 0);
  });

  test('🔴 源码契约（互补，不是主判据）：生产代码里**真的有人**调那条接线，且它不读 store 的 `field`', () => {
    // ⚠️ 先**剥注释**再匹配 —— 上一版就是被窗口里的注释骗绿的（注释里也写着 `field.local`）。
    const src = stripComments(read('public/js/screens/game.js'));
    const frames = stripComments(read('public/js/screens/battleFrames.js'));
    // 🔴 2026-10-08 B12（C 16:0x 裁决 B-α「整段换过去」）：帧接线**整段**搬进 `battleFrames.js`，锚点跟着搬。
    //    这一段现在钉四件事：
    //    ① 生产代码**真的调** `createBattleFrames`（B-α 之前：0 调用点＝孤儿 ⇒ 标记那一跳从来没跑过）；
    //    ② 调的时候**传了 runner**（不传就收不到本地 sim 的帧 ⇒ 幽灵棋子永远不出现）；
    //    ③ 那段 effect **不许读 store 的 `field`**（闭包冻住 null 那个 bug）；
    //    ④ `game.js` 里**不许再有内联副本**（"两个都像在跑的实现"＝本仓最贵的形状；C 已裁：留 battleFrames.js）。
    const from = src.indexOf('const frames = createBattleFrames({');
    const to = src.indexOf('}, [view]);', from);
    assert.ok(from > 0 && to > from, '能定位战斗帧那段 effect（锚点：`const frames = createBattleFrames({`）');
    const body = src.slice(from, to);
    assert.match(body, /runner: battleRunner/, '不传 runner ⇒ 收不到本地帧 ⇒ 跟子标记永远不会被推');
    // ⚠️ 只禁"**读 store 的 field 变量**"（`field.local` / `field?.[…]`）——`'m.field'`、`'field'` 这种**字符串**
    //    是本段的正常内容（事件名）；第一版写成裸 `\bfield\b` ⇒ 被自己刚加的那行 `battleRunner.on('field', …)` 假红。
    assert.ok(!/(^|[^.\w'"])\bfield\b\s*[.?\[]/m.test(body),
      '这段不许**读** `field`（`field.local` 那种）：它的初值是 null 且不在依赖数组里 ⇒ 会被闭包冻住、每帧抛错（本文件头部的那个 bug）');
    assert.ok(!/snapBufRef\.current\.set\(/.test(src), '⛔ `game.js` 里不许再有内联的帧缓冲（B-α 二选一：留 battleFrames.js）');
    assert.ok(!/net\.on\('b\.snap'/.test(src), '⛔ 同上：`b.snap` 的注册归 `battleFrames.js`（内联版不许回来）');
    // 而"推标记"那一跳在**生产真的会跑的**那个模块里（`local` 由注册处给出，不看 store）
    assert.match(frames, /if \(local && runner && typeof runner\.wangMarks === 'function'\)/,
      '`battleFrames.js` 必须按帧来源推标记（local ⇒ runner.wangMarks）');
    assert.match(frames, /view\?\.setWangMarks\?\.\(runner\.wangMarks\(cur\)\)/, '推的就是 `runner.wangMarks()` 的结果');
  });
});

describe('接线：其余源码契约（视图 / runner / 协议）', () => {
  test('视图把 setWangMarks 暴露给 screens（fieldHost 的方法表外，直接挂 view）', () => {
    const src = read('public/js/render/app.js');
    // ⚠️ 2026-10-08 B（判据适配 3/N）：原来是 `/^\s{4}setWangMarks,$/m` —— **钉死了 4 空格缩进**，
    //    而上游重构 `render/app.js` 的导出块之后实际是 **6 空格**（`      setWangMarks,`）⇒ 断言红。
    //    ✅ 先实测过"功能是完整的"（4 处：`app.js:1091` 实现／`:1938` 导出／`battleFrames.js:78` 调用／
    //       `fieldHost.js:28` 的 `OPTIONAL` 白名单）⇒ 这是**断言滞后**、不是功能丢失 ⇒ **放宽缩进，意图不变**。
    assert.match(src, /^\s*setWangMarks,$/m, 'view 对象上挂了 setWangMarks（缩进不限：上游重构过导出块）');
    assert.match(src, /function setWangMarks\(marks\)/, '实现存在');
    assert.match(src, /views\.set\(g\.key, v\)/, '跟子按格建视图');
    assert.match(src, /v\.dimmed = true/, '幽灵观感（unitview: dimmed ⇒ alpha×0.35）');
  });

  // ══ 🔴 这一组是 2026-10-06 08:2x 补的：**上面那条断言是"半个契约"** ═══════════════════════════════════
  // 事实链（用户机日志实测，第 5 任 B）：
  //   · `render/app.js` **确实**导出了 `setWangMarks` ⇒ 上面那条源码断言**绿** ✗；
  //   · 但 screens 拿到的 **不是**那个对象，而是 `ui/fieldHost.js` 的 `guardView()` **包装**过的 `safe`，
  //     它**只转发 `METHODS + OPTIONAL` 里登记过的名字** ⇒ `setWangMarks` 没登记 ⇒ `view.setWangMarks === undefined`
  //     ⇒ `view?.setWangMarks?.()` **永远什么都不做**（不抛、不警告、没有任何测试会红）。
  //   · 实机证据：`[wangmarks] local frame=n:p_… follow=15 refilled=0 draw=undefined view=true`
  //     —— `follow=15` 说明**引擎一直在给**，`draw=undefined` 说明**渲染层根本没被调用**。
  //   ⇒ 教训与 C 那条同源：**断言要打在"真正被调用的那个对象/那条路径"上**，不是"某个文件里写着"。
  test('🔴 guardView 必须把 setWangMarks 转发给 screens（否则 app.js 导出了也白搭）', async () => {
    const { guardView } = await import('../../public/js/ui/fieldHost.js');
    const got = [];
    const raw = { setWangMarks(m) { got.push(m); return true; }, setPen() { return true; } };
    const safe = guardView(raw, 'engine');
    assert.equal(typeof safe.setWangMarks, 'function', 'guardView 的白名单里必须有 setWangMarks');
    assert.equal(safe.setWangMarks({ follow: [] }), true, '返回值要透传（`false` = 早退，诊断靠它）');
    assert.equal(got.length, 1, '调用要真的落到 raw view 上');
    // 负对照：没登记的名字**不该**被转发 —— 证明这条断言有区分力，不是"把什么都塞进去"
    assert.equal(typeof safe.notAViewMethod, 'undefined');
  });

  test('🔴 契约：screens 通过 view 调的**每一个**方法，guardView 都必须转发（这次漏的就是这个形状）', async () => {
    const { guardView } = await import('../../public/js/ui/fieldHost.js');
    // ⚠️ **两个文件都要扫**：`game.js` 是持有 view 的那个 screen，而**真实调用点现在已经搬到
    //    `battleFrames.js`**（2026-10-06 抽出去的那段）—— 只扫 game.js 会**漏掉 setWangMarks**，
    //    我第一次写这条时就漏了（下破坏只红了 1 条而不是 2 条，是它提醒了我）。
    const files = ['public/js/screens/game.js', 'public/js/screens/battleFrames.js'];
    const names = new Set();
    for (const f of files) {
      const src = stripComments(read(f));
      // `view?.name(` 与 `view.name(` 都算，**并且要认 `view?.name?.(`**（可选链调用 —— 我第一次写漏了它，
      // 结果 `setWangMarks` 没被扫到、哨兵断言先红了：这正是"正则漏一个形状 ⇒ 假绿"的现场）。
      // `raw` 是 guardView 特意**作为属性**挂上的（不是方法），排除它。
      for (const m of src.matchAll(/\bview(?:\?\.|\.)([A-Za-z_$][\w$]*)(?:\?\.)?\s*\(/g)) names.add(m[1]);
    }
    names.delete('raw');
    assert.ok(names.size >= 8, `扫到的 view 方法太少（${names.size}）⇒ 正则失效了，这条断言会变成假绿`);
    const raw = {}; for (const n of names) raw[n] = () => 'ok';
    const safe = guardView(raw, 'engine');
    const missing = [...names].filter((n) => typeof safe[n] !== 'function');
    assert.deepEqual(missing, [],
      `这些方法 screens 会调、但 guardView 不转发（会被**静默**吃掉，不抛不警告）：${missing.join(', ')}`);
    assert.ok(names.has('setWangMarks'), '哨兵：这次踩中的那个方法必须在扫描结果里（否则说明正则又漏了）');
  });

  test('runner 只读引擎留下的两种标记（**在跑版**字段），并且**不改**引擎状态', () => {
    const src = read('public/js/battle/runner.js');
    const from = src.indexOf('wangMarks(fieldId = null)');
    // ⚠️ 取到**下一个方法**为止（原来写死 2600 字符 ⇒ 注释一长就截断了要断言的最后几行，
    //    这正是本用例第一次跑出来的假红 —— 断言写死了"窗口"，而窗口会随实现漂移）。
    const to = src.indexOf('_entries: entries');
    assert.ok(from > 0 && to > from, '能定位 wangMarks 的完整方法体');
    const fn = src.slice(from, to);
    // ⚠️ **先剥注释再断言**（这个方法体里就写着"退休字段叫什么"的注释 ⇒ 不剥会把我自己的注释当代码，
    //    第一版就是这么假红的 —— 同族先例见本文件顶部 "上一版就是被窗口里的注释骗绿的"）。
    const code = stripComments(fn);
    // 🔴 2026-10-08 B12：字段名**换了基座**（C 15:0x 裁决的 (乙)＋改形态）——
    //    在跑版是 `owner.mem.wang.followers`（`op-wang.js:300`）＋ 棋子身上的 `mem.wangNode`
    //    ＋"不是战前那批"的 `deployedAt > 0`；退休的内置版是 `mem.wangFollow` / `mem.wangRefilled`。
    assert.match(code, /mem\.wang\s*&&\s*u\.mem\.wang\.followers/, '跟子来自在跑版的 owner.mem.wang.followers');
    assert.match(code, /mem\.wangNode/, '"补子"要认望的棋子身上的 mem.wangNode（在跑版的部署钩子写的）');
    assert.match(code, /deployedAt\s*>\s*0/, '"补子"＝不是战前摆的那一批（deployedAt > 0）');
    // ⚠️ **反证**：退休字段一个都不许留 —— 留着就是"永远读不到数据"的静默失效（本文件顶部那条 bug）。
    assert.ok(!/wangFollow/.test(code), '⛔ 不许再读退休的 `mem.wangFollow`（0.2.1 基座上没有任何写入方）');
    assert.ok(!/wangRefilled/.test(code), '⛔ 不许再读退休的 `mem.wangRefilled`（在跑版没有这个标记）');
    assert.ok(!/\.followers\s*=/.test(code), '显示层**不许写**引擎状态（只读）');
    assert.ok(!/\.wangNode\s*=/.test(code), '同上');
    assert.ok(!/\.deployedAt\s*=/.test(code), '同上');
  });

  test('协议带上 refilled（A 交接 §2 点名的那条：unitStatsEntry 原来不带 mem）—— 判据＝在跑版的两个字段', async () => {
    const { unitStatsEntry } = await import('../../shared/protocol.js');
    const sim = (mem, deployedAt = 0) => ({ id: 1, uid: 1, defId: 'token_x', hp: 5, alive: true, deployedAt, base: { maxHp: 10, atk: 1, def: 0, res: 0, interval: 1, blockCnt: 0, moveSpeed: 0 }, mem });
    // 🔴 2026-10-08 B12：这条判据的**输入形状也换了**（原来喂 `{ wangRefilled: true }` —— 一个在跑版
    //    永远不会被写出来的字段 ⇒ 那是"判据自己恒绿"，本仓最贵的形状之一）。
    //    现在喂在跑版真会写的东西：望的棋子的 `mem.wangNode`（`op-wang.js:232`）＋ 部署时间 `deployedAt`。
    assert.equal(unitStatsEntry(sim({ wangNode: { seq: 2 } }, 2.03)).refilled, true, '望自己重新部署的棋子 ⇒ refilled:true');
    assert.equal(unitStatsEntry(sim({ wangNode: { seq: 1 } })).refilled, false, '战前那批（deployedAt === 0）⇒ 不是补的');
    assert.equal(unitStatsEntry(sim({}, 9)).refilled, false, '`deployedAt > 0` 但不是望的棋子（没有 wangNode）⇒ 不算补子');
    assert.equal(unitStatsEntry(sim({ wangRefilled: true }, 9)).refilled, false,
      '⛔ 退休的内置版标记 `wangRefilled` **不再算数**（在跑版没有写入方 ⇒ 认它＝认一个永假字段）');
    assert.equal(unitStatsEntry(sim(null)).refilled, false, '没有 mem 也不许抛');
    assert.equal(unitStatsEntry(null).refilled, false, 'null 单位也不许抛');
  });
});

// ══ 望的跟子「依然没有模型」（用户 2026-10-06 06:3x 原话）═══════════════════════════════════════════
// 用户原话：「**望下棋的旁边虽然说『能正常在下的棋旁边落一颗子』，但实际上依然没有模型**」。
// C 逐行核过链路（`C-给A-B-用户实测反馈交接-063x.md` §2），B 复核：
//   `runner.js:854-858 pieceSpine()` 取 `u.def.spine ?? u.def.charId ?? u.defId`
//     ⇒ 棋子这两个字段都是 undefined ⇒ 落到 `defId`（= 内容包/引擎那个 token id）
//   `assets.js:157-158 spineEntry()` 查的是 **`m.tokens[<id>]`**（不是 `chars`）
//     ⇒ 有完整 skel/atlas/textures ⇒ 幽灵棋子画的是**官方模型**；**没有 ⇒ spine=null ⇒ 只剩格框**
//        （用户看到的就是"没有模型"，而且**不会报错、不会掉帧** —— 完全静默）。
// ⇒ 这条护栏钉住**那一跳**：**引擎（在跑的那一版）用的那个 token id** 必须在 `data/assets.json` 的 `tokens` 里
//    能解析出模型，且模型文件真的在磁盘上。删掉那条 token 的 spine ⇒ 本组立刻红。
describe('望的跟子：模型能解析（user「依然没有模型」→ token → spineEntry → 幽灵棋子）', () => {
  // 默认读真清单；`SP_TEST_ASSETS` 是给"负对照/下破坏"用的（喂它一份改过的副本 ⇒ 应当红）。
  const MANIFEST = process.env.SP_TEST_ASSETS || 'data/assets.json';
  const manifest = JSON.parse(read(MANIFEST));
  const TOKEN = STONE;

  test('引擎（在跑的那个 kit 文件）那个 token id 在 assets.json 的 tokens 里解析出官方模型（不是 null）', () => {
    assert.equal(typeof TOKEN, 'string', '在跑版必须导出它自己那份 token id（`op-wang.js` 的 `STONE`）');
    assert.ok(manifest.tokens && manifest.tokens[TOKEN],
      `assets.json 的 tokens 表里没有 ${TOKEN} ⇒ 幽灵棋子只能画一个空框（用户说的"没有模型"）`);
    const sp = spineEntry(manifest, TOKEN);
    assert.ok(sp, `spineEntry('${TOKEN}') 是 null ⇒ 幽灵棋子静默退回"只画格框"`);
    assert.ok(typeof sp.skel === 'string' && sp.skel, 'skel 路径');
    assert.ok(typeof sp.atlas === 'string' && sp.atlas, 'atlas 路径');
    assert.ok(Array.isArray(sp.textures) && sp.textures.length > 0 && sp.textures.every((u) => typeof u === 'string' && u),
      'textures 至少一张');
  });

  test('负对照：**没登记**的 token id 必须解析成 null（证明上面那条不是恒真）', () => {
    assert.equal(spineEntry(manifest, 'token_10064_wang_stone1_not_registered'), null,
      '不存在的 token 都能解析出模型 ⇒ 上一条断言没有区分力');
    assert.equal(spineEntry(manifest, ''), null);
    assert.equal(spineEntry(manifest, null), null);
  });

  test('模型与头像文件在磁盘上真的存在（清单引用不许是死链）', () => {
    const sp = spineEntry(manifest, TOKEN);
    const urls = [sp.skel, sp.atlas, ...sp.textures, manifest.tokens[TOKEN].avatar].filter(Boolean);
    assert.ok(urls.length >= 4, `skel/atlas/textures(+avatar) 都要有，实际 ${urls.length} 条`);
    for (const u of urls) {
      const p = path.join(ROOT, 'public', u);
      assert.ok(existsSync(p) && readFileSync(p).length > 0, `${u} 在磁盘上不存在或为空（客户端会 404）`);
    }
  });

  test('哨兵：幽灵棋子拿到的 spine 字符串，就是上面那条能解析的 id（显示层与清单不许分叉）', () => {
    const p = wangMarkPlan(marks([{ r: 9, c: 5, ownerUnitId: 3, ownerId: 'u1', spine: TOKEN }], []));
    assert.equal(p.ghosts.length, 1);
    const s = p.ghosts[0].spine;
    assert.equal(s, TOKEN, '幽灵用的模型 id 必须与引擎/清单一致');
    assert.ok(spineEntry(manifest, s), `幽灵棋子的模型 id ${s} 解析不出模型 ⇒ 玩家又只看到格框`);
    // 反证"解析走的是 tokens 分支"：这个 id **不在** chars 表里 ⇒ 上面那次解析成功只可能来自 tokens。
    assert.ok(!(manifest.chars || {})[TOKEN], `${TOKEN} 不该在 chars 表里（棋子是 token，不是干员）`);
  });
});

// ══ 🔴 C 15:0x 裁决点名的那条「红 → 绿」判据（B12 2026-10-08）：**全链**，不是源码 match ═══════════════════
// 链路每一跳都是真的（一个都不用我假装）：
//   真 `BattleSpec`（`buildBattleSpec`）→ **真 sim**（runner 自己 `createBattleFromSpec` 建这局）
//   → 引擎在"棋子被消耗、望自己把它补回来"时写 `owner.mem.wang.followers` + 棋子的 `mem.wangNode`/`deployedAt`
//   → **真 `battleRunner.wangMarks()`**（就是屏幕上跑的那个函数）→ `wangMarkPlan` → `spineEntry` ⇒ **有模型**。
// 为什么它必须存在：旧代码读的是**退休字段** `mem.wangFollow`／`mem.wangRefilled`（0.2.1 基座上**没有任何写入方**）
//   ⇒ 这一条在修之前**必然是空的**（B12 用同一套 rig 实测过：旧读法下 `follow: []`／`refilled: []`，
//     而引擎那边的 `mem.wang.followers` 已经有 1 条）。
// ⚠️ 这一组里唯一一处替身：`b.autoFinish = false` —— 这一局**故意不配敌人**（要的是"消耗→补回来"这条引擎路径，
//    敌人只会把它提前引爆），而 Battle 默认 `autoFinish` 会在**没有敌人的第一个 tick** 就判 `cleared` 结束。
//    它是**夹具**的事（让这一局继续跑），不是被判据的对象。
describe('🔴 全链：真引擎 ⇒ 真 runner.wangMarks ⇒ 幽灵棋子的 spine（用户那句"依然没有模型"）', () => {
  const STAGE = 'act1autochess_m01';   // 真关卡（data/stages.json）：(10,8)/(10,9) 是空地，棋子才部署得上
  const SLOT = 'chess_char_6_diy1_a';  // 自选槽（望 = 6★ 特种的 tier-6 自选位）——与 test/content/op_wang.test.js 同路
  const BATTLE = 'b:wang-1';
  const FIELD = 'n:P1';

  /** 一套真 rig（`test/match/runner.test.js` 同一套做法：假 socket ＋ 手动时钟 ＋ 手动帧）。 */
  function rig() {
    let t = 1000;
    const frames = [];
    const runner = createBattleRunner({
      net: { on: () => () => {} },
      store: { patch() {} },
      doc: { hidden: false, addEventListener() {} },
      now: () => t,
      raf: (fn) => { frames.push(fn); return frames.length; },
      caf: () => {},
      setInterval: () => 0,
      clearInterval: () => {},
      loadSim: async () => ({ spec: specMod, ds: getDefaultSource() }),
      logger: { error() {}, warn() {}, info() {}, debug() {} },
    });
    /** 把排队的帧跑掉（preparation 里的 `yieldFrame` 就靠它）。 */
    const settle = async (n = 40) => {
      for (let i = 0; i < n; i++) { await new Promise((res) => setImmediate(res)); for (const fn of frames.splice(0)) fn(t); }
    };
    return { runner, settle };
  }

  test('棋子被消耗、望自己补回来 ⇒ wangMarks 抓到跟子（带模型）＋ 那枚棋子被判成"补子"', async () => {
    // 真 spec：望（S2 连星）＋ 两枚**战前摆好**的棋子
    const spec = specMod.buildBattleSpec({
      battleId: BATTLE, fieldId: FIELD, kind: 'normal', seed: 5, modeId: 'mode_multi_hard', round: 1,
      stageId: STAGE, rect: null, timeLimit: 900,
      players: [{
        playerId: 'p_0', seat: 0, side: 'L', colOffset: 0,
        units: [
          { uid: 1, chessId: SLOT, diy: { charId: 'char_2027_wang', skillIndex: 1 }, elite: true, row: 12, col: 3 },
          { uid: 2, kind: 'token', tokenId: STONE, ownerUid: 1, row: 10, col: 8 },
          { uid: 3, kind: 'token', tokenId: STONE, ownerUid: 1, row: 10, col: 9 },
        ],
      }],
      spawns: [], routes: [], flags: { startOpCooldown: 0, dpPerSec: 0, dpMax: 999 }, content: 'full',
    });
    const { runner, settle } = rig();
    await runner.onStart({ battleId: BATTLE, fieldId: FIELD, kind: 'normal', spec, authoritative: false, watch: false, elapsed: 0 });
    await settle();
    const e = runner._entries.get(BATTLE);
    assert.ok(e && e.battle, 'runner 必须真的把这一局建起来（loadSim → createBattleFromSpec）');
    const b = e.battle;
    b.autoFinish = false;   // 见这一组标题下的说明（夹具的事）
    for (let i = 0; i < 4; i++) b.step();

    const owner = b.allyUnits.find((x) => x.kind === 'op' && x.mem && x.mem.wang);
    assert.ok(owner, '望必须在场上（DIY 自选槽 ⇒ 她的天赋 install 建了 mem.wang）');
    const stones = b.allyUnits.filter((x) => x.kind === 'token' && x.defId === STONE && x.alive);
    assert.equal(stones.length, 2, `两枚棋子都要部署上场（(10,8)/(10,9) 在 ${STAGE} 上得是空地）`);

    // ① 引擎（**在跑版**）的数据源：显示层读的就是这两个
    assert.ok(Array.isArray(owner.mem.wang.followers), '跟子在 owner.mem.wang.followers（op-wang.js:300）');
    assert.ok(stones.every((s) => s.mem.wangNode), '棋子身上有 mem.wangNode（部署钩子写的）');
    assert.ok(!('wangFollow' in owner.mem) && stones.every((s) => !('wangRefilled' in s.mem)),
      '退休字段（mem.wangFollow / mem.wangRefilled）在 0.2.1 基座上**不该**再出现（出现就说明注册表换回了退役版）');
    const before = runner.wangMarks(FIELD);
    assert.deepEqual([before.follow.length, before.refilled.length], [0, 0], '还没补回来 ⇒ 两种标记都为空');

    // ② 战前那批的判据：deployedAt === 0（"不是玩家摆的"这句话的另一半）
    assert.ok(stones.every((s) => s.deployedAt === 0), '战前摆上去的棋子 deployedAt === 0');

    // ③ 消耗一枚（**引擎自己那条路**：`op-wang.js` 的 `spend()` 就是这一行），等望把它补回来
    const spent = stones[0];
    b.retreat(spent, { reason: 'expired', permanent: true });
    let back = false;
    for (let i = 0; i < 200 && !back; i++) { b.step(); back = spent.alive; }
    assert.ok(back, '棋子应当在再部署时间后原位回来（望自己补的）');
    assert.ok(spent.deployedAt > 0, `补回来的棋子 deployedAt > 0（实测 ${spent.deployedAt}）`);
    assert.equal(owner.mem.wang.followers.length, 1, '回来时望在相邻格补了一枚跟子（引擎的 dropFollowers）');

    // ④ 真 runner 的读法：跟子带模型；那枚棋子被判成"补子"（琥珀框）
    const marks = runner.wangMarks(FIELD);
    assert.equal(marks.follow.length, 1, 'runner 必须抓到跟子 —— **旧读法（mem.wangFollow）在这里是 0**，本用例就是它转绿的那一条');
    assert.deepEqual([marks.follow[0].r, marks.follow[0].c],
      [owner.mem.wang.followers[0].r, owner.mem.wang.followers[0].c], '坐标就是引擎给的那一格');
    assert.equal(marks.follow[0].spine, STONE, '跟子的模型 id ＝ 引擎自己那份 token id（pieceSpine 解析链）');
    assert.equal(marks.refilled.length, 1, '补回来的那枚 ⇒ 琥珀框');
    assert.deepEqual([marks.refilled[0].r, marks.refilled[0].c], [spent.tileR, spent.tileC]);
    assert.equal(marks.refilled[0].unitId, spent.id);
    // 负对照（这一组的区分力）：另**两半**都没被顺手写进去
    assert.equal(before.follow.length, 0, '战前那批**不**算补子（deployedAt === 0）');

    // ⑤ 显示层那一跳：幽灵棋子拿到的 spine 能解析出真模型（用户要的"看得见"）
    const plan = wangMarkPlan(marks);
    assert.equal(plan.ghosts.length, 1);
    assert.equal(plan.ghosts[0].spine, STONE);
    assert.deepEqual(plan.followTiles, [[marks.follow[0].r, marks.follow[0].c]]);
    assert.deepEqual(plan.refilledTiles, [[spent.tileR, spent.tileC]]);
    const man = JSON.parse(read('data/assets.json'));
    assert.ok(spineEntry(man, plan.ghosts[0].spine), `幽灵棋子的模型 id ${plan.ghosts[0].spine} 解析不出模型 ⇒ 玩家只看到格框`);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 🔴 探针（第 11 任 B 2026-10-08 加，第 12 任 B 当日按 C 的裁决改指向）：**数「在跑的那一版望」的锚点**。
//
// 为什么要有这条：本仓已经发生过【一整段实现被换基座吞掉】——
// 我上一轮把 `server/sim/content/tokens.js`（树 104,195 B vs 冷备 143,959 B）读成"望整段丢了"，
// 差点去搬 40 KB。**真相是搬家**：0.2.1 把望的整套搬进了 `kits/ops/op-wang.js`，而
// **`kits/index.js:138` 只注册 `op-wang.js`** ⇒ 玩家的望跑的是那一版（C 15:0x 实测，`.workbuddy/tools/_c11-which-wang.mjs`）。
// ⇒ 这条探针现在钉**两件事**：① 在跑的那个文件里的锚点一个都不许少；
//    ② 注册表仍然只认它在跑（若哪天有人改注册表，下面每条行为断言都会变成"测一个没人跑的实现"）。
//
// ⚠️ 上面那些行为断言（解析模型 / 磁盘文件）**只有拿到 token id 才可能跑**，
//    所以"整段没了"时它们报的是 `undefined`/`null` 这类**间接症状**；这条探针报的是**直接事实**：
//    **锚点不见了**。⇒ 下一任不必再去比对冷备，跑一次就知道。
describe('🔴 探针：在跑的那一版望（op-wang.js）的锚点必须还在，且它必须还在注册表里', () => {
  const KIT = 'server/sim/content/kits/ops/op-wang.js';
  test(`${KIT} 里的锚点一个都不许少`, () => {
    const src = read(KIT);
    const need = [
      'token_10064',               // 官方 token id 字面量（棋子 = token_10064_wang_stone1）
      'export const STONE',        // 引擎那份 token id（判据从这里取，不另抄字符串）
      'STOCK_CAP_FALLBACK',        // 持有库存的兜底
      'unit.mem.wang = {',         // 望自己的账：`{ stock, followers, seq, ammo }`（:300）
      'followers',                 //   ↳ 跟子就住在这里（显示层读的是它）
      'followCap',                 // 跟子上限（读天赋 bb）
      'mem.wangNode',              // 棋子身上的节点（部署钩子写的；"补子"判据的一半）
      'scheduleReturn',            // 原位再部署（补子）的那条路
      'addFollower',               // 跟子的写入方
    ];
    const miss = need.filter((k) => !src.includes(k));
    assert.deepEqual(miss, [],
      `「在跑的望」的锚点不见了 ⇒ 这一版可能又被换基座吞掉（树里 0 命中就是证据）：[${miss.join(', ')}]`
      + ` —— 对照物：上游 \`E:/sp-junk/up-021\` 的同名文件（0.2.1 基座里它与上游逐字节相同），`
      + `冷备 \`.workbuddy/rollback/tree-cold-20261007-180433/\` 里它是【不存在】的（因为它是上游带来的）。`);
  });

  test('注册表仍然只认这一版（不然上面的行为断言就是在测一个没人跑的实现）', () => {
    const reg = read('server/sim/content/kits/index.js');
    assert.match(reg, /'op-wang\.js'/, '`kits/index.js` 必须仍然注册 op-wang.js（玩家实际跑的那一版）');
    assert.ok(!/'reserve-wang\.js'/.test(reg),
      '⛔ `reserve-wang.js`（外援退役族）**不该**被注册：它写退休字段 `mem.wangFollow`/`wangRefilled`，'
      + '注册它就会与在跑版两份数据分叉（用户 2026-10-07 已拍「外援退役、采用上游自选编队」）');
  });
});
