// test/sim/x1-neghp-heal.test.js —— **X-1 的另一半：负生命（我执）必须能被治疗**（第 53 轮 A 新写的探针）。
//
// 为什么单独一条：C 第 4 批 A-4.2 实测 —— 树里 `server/sim/damage.js` 的 `capLeaderHit` **3 命中 ✅**，
// 但 **`negHp` 0 命中**（0.1.4.1 冷备与 `.workbuddy/_a52-recovery/X-1/` 那份都是 **10 命中**）
// ⇒ **"封顶"那半接好了，"负血"那半没接回来**。本文件就是那半的判据。
//
// 被丢掉的实现（逐字在冷备里，`damage.js` 的 `heal()` 内、`heal` 钩子**之后**）：
//   负血记在 `target.mem.negHp`（斩业星熊「我执」）；而原来的 `min(amt, max - hp)` 在
//   **满血 ＋ 有负血**时算出 **0** ⇒ **一旦进入负血，任何治疗都不再有效** —— 用户 2026-10-06 报的就是这条
//   （「星熊 S2 的盾牌能给自己的负血量回复上来」）。修法：**先把治疗量花在负血上（往 0 抬），剩下的才补 hp**；
//   对 `negHp` 不存在或为 0 的单位**零影响**。
//
// ⚠️ 本探针**只测引擎语义**（`damage.js` 的 `heal`），不依赖任何 kit 被加载 ⇒ 两态都能跑、可复跑。
// 跑：node --test test/sim/x1-neghp-heal.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, chessRec } from '../helpers/battleHarness.js';
import { heal } from '../../server/sim/damage.js';

const ID = 't_carrier';
const REC = () => chessRec({ id: ID, profession: 'WARRIOR', stats: { maxHp: 3000, atk: 100, def: 0, bat: 1.2 }, skill: null });

/** 一个最小战场 + 一个友方单位。`negHp > 0` 时把它设成**满血 ＋ 有负血**（治疗会被浪费的那种处境）。 */
function arena({ negHp = 0, ratioCap = 2 } = {}) {
  const h = makeBattle({
    defs: { chess: { [ID]: REC() } },
    content: 'generic', timeLimit: 60, autoFinish: false, captureNoisy: true,
    units: [{ chessId: ID, row: 10, col: 3, dir: 'RIGHT', carryState: { sp: 0 } }],
    enemies: [],
  });
  h.step();
  const u = h.unit(ID);
  assert.ok(u, '单位必须上场');
  // 「我执」的口径：负血绝对值 + 占**上限**（maxHp × max_minus_hp_ratio）的比例
  u.mem.negHp = negHp;
  u.mem.negHpRatio = negHp > 0 ? Math.min(1, negHp / (u.s.maxHp * ratioCap)) : 0;
  u.hp = u.s.maxHp;                       // 🔴 关键场景：**满血** ＋ 有负血 ⇒ 旧代码任何治疗都无效
  return { h, u };
}

test('阴性对照（先证明探针搭得对）：**没有负血**时，治疗照常回血', () => {
  const { h, u } = arena({ negHp: 0 });
  u.hp = u.s.maxHp - 500;
  const before = u.hp;
  const healed = heal(h.b, null, u, 300);
  assert.equal(healed, 300, '应回复 300');
  assert.equal(u.hp, before + 300, '没有负血时治疗必须照常生效');
  assert.equal(u.mem.negHp, 0, '不该凭空产生负血');
});

test('🔴 满血 ＋ 有负血：治疗必须**先填负血**，不能白费（这就是被换掉的那半）', () => {
  const { h, u } = arena({ negHp: 900 });
  const hp0 = u.hp;
  assert.equal(hp0, u.s.maxHp, '前置：满血（这正是"治疗会被 min(amt, max-hp)=0 吃掉"的处境）');
  const healed = heal(h.b, null, u, 300);
  assert.equal(u.mem.negHp, 600, '负血必须从 900 降到 600（治疗量全部花在负血上）');
  assert.ok(Math.abs(u.mem.negHpRatio - 600 / (u.s.maxHp * 2)) < 1e-9,
    '`negHpRatio` 必须同步（快照就是靠它把负 hp 下发给客户端的）');
  assert.equal(u.hp, u.s.maxHp, '负血还没填完 ⇒ hp 不应溢出');
  assert.equal(healed, 300, '返回值应是"这一次实际治好的量"（含填掉的那部分负血）');
});

test('负血被填完之后，**剩下的**治疗量才去补 hp（两段都要对）', () => {
  const { h, u } = arena({ negHp: 200 });
  u.hp = u.s.maxHp - 1000;
  const healed = heal(h.b, null, u, 500);
  assert.equal(u.mem.negHp, 0, '负血 200 应被填平');
  assert.equal(u.mem.negHpRatio, 0, '填平后比例归零');
  assert.equal(u.hp, u.s.maxHp - 1000 + 300, '剩下的 300 才去补 hp');
  assert.equal(healed, 500, '实际治好的量 = 200（负血）＋ 300（hp）');
});

test('治疗量**不足以**填平负血时，一点都不该进 hp', () => {
  const { h, u } = arena({ negHp: 900 });
  u.hp = u.s.maxHp - 1000;
  const hp0 = u.hp;
  const healed = heal(h.b, null, u, 400);
  assert.equal(u.mem.negHp, 500, '负血 900 − 400 = 500');
  assert.equal(u.hp, hp0, '负血没填平 ⇒ hp 一点都不该涨');
  assert.equal(healed, 400);
});
