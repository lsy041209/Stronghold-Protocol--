// test/sim/x1-neghp-snapshot.test.js —— **X-1 的第三半：负生命（我执）必须活到客户端快照**（第 54 轮 A 新写的探针）。
//
// 为什么单独一条（第 53 轮 A 交接件 §3-2 新发现，我这一轮实测确认）：
//   · `server/sim/damage.js` 的 `heal()` —— 负血**优先被治疗**那半：✅ 已接回（11 命中，判据 `x1-neghp-heal.test.js` 4/4）；
//   · `server/sim/snapshot.js` 的 `unitTuple()` —— 把 `u.mem.negHpRatio` 转成**负 hp 下发**那半：🔴 **丢了**
//     （树里 `snapshot.js` 的 `negHp` **0 命中**；`.workbuddy/rollback/tree-cold-20261007-180433/.../snapshot.js:108-116`
//      与 `.workbuddy/tools/snapshot-neg-hp.mjs` 里的原实现都在，逐字可接）。
//   ⇒ 后果：`heal()` 能填负血了，但**客户端根本看不到负血**（快照里 `hp` 被 `Math.max(1, …)` 夹在 ≥1）。
//
// 口径真源（不是我推的）：
//   · `kits/reserve-hsgma2.js:439-452`（斩业星熊天赋1「我执」）写下：
//       `unit.mem.negHp`      = 累积的负生命绝对值
//       `unit.mem.negHpRatio` = 占**生命上限**的比例（0..1），`snapshot.js` 读它
//       `ratioCap = maxHp * max_minus_hp_ratio`（负数上限，默认 2）
//   · `damage.js:604-607` 与 kit 的 `syncNegHp()` **同一口径**：`negHpRatio = negHp / (maxHp * maxMinusHpRatio)`。
//   · 客户端按 `-hp / maxHp` 画「从左往右生长的暗红条」（`.workbuddy/tools/probe-client-neghp.mjs` 第 2 节）。
//
// ⚠️ 本探针**只测引擎语义**（`snapshot.js` 的 `unitTuple`，纯函数），不依赖 kit 被加载、不依赖渲染层 ⇒ 两态都能跑。
// ⚠️ 不改协议：元组仍是 `[id,x,y,hp,maxHp,sp,spMax,flags,anim]` 九项、字段位置不变。
// 跑：node --test test/sim/x1-neghp-snapshot.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, chessRec } from '../helpers/battleHarness.js';
import { unitTuple } from '../../server/sim/snapshot.js';

const ID = 't_carrier';
const REC = () => chessRec({ id: ID, profession: 'WARRIOR', stats: { maxHp: 3000, atk: 100, def: 0, bat: 1.2 }, skill: null });

/** 一个最小战场 + 一个友方单位。`negHp > 0` 时按 kit 的口径写好 `mem.negHp` / `negHpRatio`。 */
function arena({ negHp = 0, ratioCap = 2, hp = null } = {}) {
  const h = makeBattle({
    defs: { chess: { [ID]: REC() } },
    content: 'generic', timeLimit: 60, autoFinish: false, captureNoisy: true,
    units: [{ chessId: ID, row: 10, col: 3, dir: 'RIGHT', carryState: { sp: 0 } }],
    enemies: [],
  });
  h.step();
  const u = h.unit(ID);
  assert.ok(u, '单位必须上场');
  // 「我执」的口径：负血绝对值 ＋ 占**上限**（maxHp × max_minus_hp_ratio）的比例
  u.mem.negHp = negHp;
  u.mem.negHpRatio = negHp > 0 ? Math.min(1, negHp / (u.s.maxHp * ratioCap)) : 0;
  if (hp != null) u.hp = hp;
  return { h, u };
}

const tupleHp = (u, t = 0) => {
  const row = unitTuple(u, t);
  assert.equal(row.length, 9, '线格式契约：元组必须仍是九项（不改协议）');
  assert.ok(Number.isFinite(row[3]), `hp 必须是有限数，实际 ${row[3]}`);
  return row[3];
};

test('阴性对照（先证明探针搭得对）：**没有负血**时，快照照常发正 hp（上下界都不变）', () => {
  const { u } = arena({ negHp: 0, hp: 1234.5 });
  assert.equal(u.mem.negHpRatio, 0, '前置：没有负血 ⇒ ratio 为 0');
  assert.equal(tupleHp(u), 1235, 'hp 向上取整（原有行为不变：1234.5 → 1235）');

  // 上界仍然夹住（否则血条会溢出）
  const b = arena({ negHp: 0, hp: 99999 });
  assert.equal(tupleHp(b.u), b.u.s.maxHp, 'hp 不得超过 maxHp');

  // 下界仍然抬到 1（活着的单位不显示 0）
  const c = arena({ negHp: 0, hp: 0 });
  assert.equal(tupleHp(c.u), 1, '活着的单位 hp 至少显示 1');
});

test('🔴 核心：有负血时，快照必须发**负 hp**（这正是客户端暗红条的唯一数据来源）', () => {
  const { u } = arena({ negHp: 900, hp: 3000 });   // 满血 ＋ 负血 900（ratioCap = 3000×2）
  const ratio = 0.15;                              // 900 / 6000
  assert.ok(Math.abs(u.mem.negHpRatio - ratio) < 1e-12, '前置：ratio = 900 / (3000×2)');
  const hp = tupleHp(u);
  assert.ok(hp < 0, `🔴 快照的 hp 必须是负数，实际 ${hp}（旧实现被 Math.max(1, …) 夹成 ≥1 ⇒ 客户端永远看不到暗红条）`);
  assert.ok(Math.abs(hp - -ratio * u.s.maxHp) < 1e-9, `hp 必须 = -ratio × maxHp = ${-ratio * u.s.maxHp}，实际 ${hp}`);
});

test('负血比例与 hp 解耦：hp 掉到半血、负血不变 ⇒ 快照仍按负血发负数（不按 hp 的绝对值）', () => {
  const { u } = arena({ negHp: 900, hp: 1500 });   // 半血 ＋ 同样 900 负血
  const hp = tupleHp(u);
  assert.ok(hp < 0, `hp 是负数，实际 ${hp}`);
  assert.ok(Math.abs(hp - -0.15 * u.s.maxHp) < 1e-9, '负数只由 ratio 决定（不改协议、不改观感口径）');
});

test('口径边界：负血填平（ratio = 0）后必须**立刻**回到正 hp 那条路', () => {
  const { u } = arena({ negHp: 900, hp: 3000 });
  u.mem.negHp = 0; u.mem.negHpRatio = 0;          // `damage.js:607` 填平后就是这样落地的
  assert.equal(tupleHp(u), 3000, 'ratio 归零 ⇒ 走原来的正 hp 路径');
});

test('健壮性：ratio 缺失 / NaN / 超界时不得把脏值传进快照（客户端会拿它算像素宽度）', () => {
  const a = arena({ negHp: 0, hp: 2000 });
  delete a.u.mem.negHpRatio;
  assert.equal(tupleHp(a.u), 2000, 'ratio 不存在 ⇒ 照常正 hp');

  const b = arena({ negHp: 0, hp: 2000 });
  b.u.mem.negHpRatio = NaN;
  assert.equal(tupleHp(b.u), 2000, 'ratio = NaN ⇒ 不能被当成负血');

  const c = arena({ negHp: 0, hp: 2000 });
  c.u.mem.negHpRatio = 5;                          // 越界（>1）
  const hp = tupleHp(c.u);
  assert.ok(Math.abs(hp - -c.u.s.maxHp) < 1e-9, `ratio > 1 必须夹到 1（最多满条），实际 ${hp}`);

  const d = arena({ negHp: 0, hp: 2000 });
  d.u.mem.negHpRatio = -1;                         // 越界（<0）
  assert.equal(tupleHp(d.u), 2000, 'ratio < 0 必须夹到 0（不得变成正 hp 的反向）');
});

test('死掉的单位仍发 hp = 0（负血不得渗进 DIE 动画那几帧）', () => {
  const { h, u } = arena({ negHp: 900, hp: 3000 });
  u.alive = false; u.deathAt = h.b.t;              // snapshotUnits 会把它算进 DIE 动画
  assert.equal(tupleHp(u, h.b.t), 0, '死亡帧 hp 必须是 0');
});
