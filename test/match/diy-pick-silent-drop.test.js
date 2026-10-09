// test/match/diy-pick-silent-drop.test.js —— **自选编队的"静默丢槽"判据**（第 54 轮 A）。
//
// 由来（一条真实的玩家反馈 ＋ 我在上游 0.2.1 里的逐跳取证）：
//   玩家：「自选了**外援**（= 自选编队）**赤刃明霄陈**、槽位显示**技能 3**、进战斗却是**技能 1**。」
//   我在 `E:/sp-junk/up-021`（**上游 0.2.1 源码，不是我们的树**）里逐跳跑出来 —— `{charId}`（**不带 `skillIndex`**）：
//     ① `shared/diy.js` `checkDiyPick` ⇒ **拒**（`an owned pick needs a skill index`）
//     ② `diyRecord` ⇒ normal / golden **都 null**
//     ③ `server/match/player/diy.js:161` 的 `if (!slot || !normal || !golden) continue;` ⇒ **静默丢槽（零日志）**
//     ④ `server/match/player/round.js:106` `diyPickOf` 拿不到 ⇒ 走 `:115-119` 的 else ⇒ **`u.skillIndex = 默认技能`**
//     ⇒ **"显示 3、进战斗是 1" 的形状就是这么来的**（服务端那一刻认为"这个子不是自选棋子"）。
//   同树实测：带 `skillIndex=2` 时**全链正确**（`getChess` ⇒ `skchr_slent2_3`）⇒ **上游服务端本身是对的**。
//
// 🔴 **本文件要守住的两件"不许静默"**（C 的口径：**不许静默丢槽**）：
//   ① 引擎侧：**不带 `skillIndex`** 的自选棋子**不许悄悄走上场**（现在它"没上场"且零错误）；
//   ② 服务端侧：`setDiy` 因**能读懂的原因**丢掉一个槽时**必须留日志**（指名哪个槽、什么 pick、为什么）。
//
// ⚠️ 上游 0.2.1 的同一处（`server/match/player/diy.js:161`）也有这个静默 `continue` —— 本判据是**我们树**的守卫；
//    要不要顺手推给上游由 C/用户定。
// 跑：node --test test/match/diy-pick-silent-drop.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, chessRec, enemyRec, checkInvariants } from '../helpers/battleHarness.js';
import { hasGeneratedData, getDefaultSource } from '../../server/sim/simdata.js';
import { DATA, makeMatch } from './harness.js';

const REAL = { skip: !hasGeneratedData() };
const ds = getDefaultSource();
const T6A = 'chess_char_6_diy1_a';
const T5A = 'chess_char_5_diy1_a';
const SLENT2 = 'char_1031_slent2';   // 赤刃明霄陈（玩家反馈里的那位；在 0.2.1 的自选池里）

/** 一个不出手、只挨打的友方？—— 不，用真实记录：自选槽上的棋子。 */
const idle = () => enemyRec({ key: 'enemy_idle', hp: 1e6, speed: 0, atk: 0 });

test('🔴 引擎侧：**不带 `skillIndex`** 的自选棋子不上场 —— 系统**知道**为什么，但那条理由默认**只进内存**（不进任何可观测通道）', REAL, () => {
  const h = makeBattle({
    defs: { enemies: { enemy_idle: idle() } },
    content: 'full', timeLimit: 60, autoFinish: false, captureNoisy: true,
    units: [{ diy: { slot: T6A, charId: SLENT2 }, row: 10, col: 3, dir: 'RIGHT', carryState: { sp: 0 } }],   // ← 故意不带 skillIndex
    enemies: [{ key: 'enemy_idle', pos: [10, 4] }],
  });
  h.step();
  assert.equal(h.allies().length, 0, '前置：这个 pick 本来就是非法的（不带 skillIndex）⇒ 棋子不该上场');
  assert.deepEqual((h.b.errors ?? []).map((e) => e.message), [], '前置：它不是"处理器异常"，所以 `b.errors` 里没有它');

  // ✅ 事实 ①：**系统知道**为什么丢掉它 —— `players.js:149` 记录过一条指名道姓的理由（去重集合 `_errKeys` 是它的落地处）。
  const told = [...(h.b._errKeys ?? [])].filter((k) => k.startsWith('log:') && k.includes(T6A));
  assert.ok(told.length > 0,
    `系统必须知道"这个子为什么没上场"（现行实现 = \`players.js:149\` 的 \`this.log(...)\`）。实测 _errKeys = ${JSON.stringify([...(h.b._errKeys ?? [])])}`);

  // 🔴 事实 ②（**本判据真正要守的**）：那条理由**默认没有任何对外通道** ——
  //    `Battle.log`（`battle/events.js:15-20`）只在 `opts.verbose` 时 `logger.warn`，否则**只进内存去重集合**。
  //    ⇒ 玩家看到"我选的技能没生效"，而**服务器日志里一个字都没有**；只有那个人恰好开 verbose 才看得见。
  //    C 的口径是"不许静默丢槽" —— 这里记的是：**"知道" ≠ "可观测"**。
  const visible = (h.b.errors ?? []).length > 0;   // 目前的"可观测通道"只有 b.errors
  assert.ok(visible,
    '🔴 一个自选棋子**没能上场**时，必须留下**运维可见**的痕迹（不是只进内存去重集合）：'
    + '现在 `b.errors=[]`，而 `[sim] unknown chess … (illegal 自选 pick)` 只在 `SP_VERBOSE`/`verbose` 下才打到 logger。\n'
    + `实测：_errKeys 里有理由 ${JSON.stringify(told)}，但没有任何对外通道。`);
  checkInvariants(h.b);
});

test('🔴 对照（证明这条链有判别力）：**带 `skillIndex=2`** 时棋子正常上场，且用的就是那一档技能', REAL, () => {
  const h = makeBattle({
    defs: { enemies: { enemy_idle: idle() } },
    content: 'full', timeLimit: 60, autoFinish: false, captureNoisy: true,
    units: [{ diy: { slot: T6A, charId: SLENT2, skillIndex: 2 }, row: 10, col: 3, dir: 'RIGHT', carryState: { sp: 0 } }],
    enemies: [{ key: 'enemy_idle', pos: [10, 4] }],
  });
  h.step();
  const u = h.unit(T6A);
  assert.ok(u, '带 skillIndex 时棋子必须上场');
  assert.equal(u.def?.charId, SLENT2, 'def.charId = 被选中的干员');
  assert.equal(u.def?.diyFor, T6A, 'def.diyFor = 自选槽（kitOf 按 charId 查）');
  const form = ds.rawBackups().units[SLENT2].forms['2/1/4/0'];
  const want = form.skills.find((s) => s.index === 2)?.skillId;
  assert.equal(u.skill?.id, want, `玩家选的那一档必须是引擎实际驱动的那张（期望 ${want}）`);
  checkInvariants(h.b);
});

test('🔴 服务端侧：`setDiy` 丢掉一个槽时**必须留痕**（点名哪个槽 ＋ 为什么）—— C 的口径：不许静默丢槽', REAL, () => {
  const h = makeMatch({ humans: 1 });
  const p = h.m.order?.[0] ?? [...(h.m.players?.values?.() ?? [])][0];
  assert.ok(p && typeof p.setDiy === 'function', '前置：拿得到 PlayerState.setDiy（`Match` 的玩家集合是 `m.players` Map ＋ `m.order`）');
  const before = h.logs.warn.length;
  // 一个结构合法、但语义非法的 pick：owned 干员**不带 skillIndex**（`validateDiyPicks` 会拒 ⇒ 这个槽被丢）
  const ok = p.setDiy({ [T5A]: { charId: 'char_112_siege' } });
  const warns = h.logs.warn.slice(before).join(' | ');
  // 🔴 判据（两条都要）：**点名槽位** ＋ **说出理由**
  assert.ok(warns.includes(T5A),
    '🔴 被丢掉的槽必须**点名**（`checkDiyPicks` 只返回一个 `dropped` 计数、而 `setDiy` 的告警分支要求 `!(\'ok\' in res)`，'
    + '它**永远**返回 `ok: true` ⇒ 槽级丢弃**完全没有日志**）。\n'
    + `实测：setDiy 返回 ${ok}；新增日志 = ${JSON.stringify(h.logs.warn.slice(before))}`);
  assert.match(warns, /skill index|自选|pick/i,
    `被丢掉的槽还要说出**理由**（玩家/维护者才知道该改什么）。实测日志 = ${JSON.stringify(h.logs.warn.slice(before))}`);
});
