// test/sim/x1-limits-notes.test.js —— **X-1：`bosses.js` 的限伤引用必须指向"封顶"那条路**（第 54 轮 A）。
//
// 为什么单独一条（换基座事故的第三次现身）：
//   · 用户 **2026-10-07** 裁定：官方那条"伤害过高 ⇒ **整击作废**"改成「**只去掉伤害清零，做一个伤害上限**，溢出的删掉」
//     ⇒ 引擎侧实现 = `damage.js` 的 **`capLeaderHit()`**（返回夹到上限的值）；`leaderHitCancelled()` **仍原样导出**，
//     身份变成"**官方那条规则怎么说**"的**谓词**，**流水线不许再调用它**。
//   · 🔴 **换基座到 0.2.1 后，`content/bosses.js:90` 的注释还写着旧名 `leaderHitCancelled`**
//     （实测：树里 `capLeaderHit` 在 `bosses.js` **0 命中**、0.1.4.1 冷备 **1 命中**）
//     ⇒ 这正是 `patch-game` 那条 `缺少标记 server/sim/content/bosses.js → capLeaderHit` 的**全部内容**：
//      **差一行注释，不是差代码**（`capLeaderHit` 在 `damage.js:205` 导出、`:307` 与 `battle/combat.js:32` 都在调用）。
//
// ⚠️ **哪条判据在守什么（避免重复造）**：
//   · **"谁调用谁"** 已由既有判据钉住 —— `test/sim/limits-clamp.test.js:53-60`（它精确匹配 `capLeaderHit(battle, target, final)`
//     与 `capLeaderHit(this, target, amount)`，并禁止两处调用 `leaderHitCancelled`）⇒ **本文件不重复那一条**。
//   · **"封顶的数值行为"** 由 `test/sim/limits-clamp.test.js` 的 12 条钉住。
//   · 本文件只补**两处别人没守的**：① `bosses.js` 的**注释面**（它是登记 mark）；② 一条**领袖封顶的行为对照**（证明这条链有判别力）。
//
// 跑：node --test test/sim/x1-limits-notes.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeBattle, enemyRec, checkInvariants } from '../helpers/battleHarness.js';
import { BOSS_HIT_LIMIT } from '../../shared/constants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('🔴 X-1 注释面（**源码级辅助，只为守 patch-game 的登记 mark**）：`bosses.js` 里讲 限伤 的**引用**必须指向 `capLeaderHit`', () => {
  const lines = read('server/sim/content/bosses.js').split(/\r?\n/);
  const refs = lines.map((l, i) => [i + 1, l]).filter(([, l]) => /限伤/.test(l));
  assert.ok(refs.length >= 1, '`bosses.js` 里应当有讲 限伤 的行（胄把伤害传给领袖那一段）');
  // ⚠️ 判据必须**照规则**判，不能照"含不含某个词"判（我第一版就是后者 ⇒ 连"用旧名做解释性引用"也判红，
  //    那正是 D 那条规矩说的"grep 源码式断言改个名字就假红"）。
  //    规则是：**旧名不许出现在"路径式引用"里**（`sim/damage.js leaderHitCancelled` 这种写法 = 说"限伤走它"），
  //    而"把它当谓词解释"（`(leaderHitCancelled ...)`）是允许且应当保留的。
  const asRef = refs.filter(([, l]) => /damage\.js\s+leaderHitCancelled/.test(l));
  assert.deepEqual(asRef.map(([n]) => n), [],
    `这几行把旧名当成了"限伤走的那条路"（与"流水线走封顶"矛盾，且 \`patch-game\` 的 \`bosses.js → capLeaderHit\` 登记项满足不了）：\n${asRef.map(([n, l]) => `  :${n} ${l.trim()}`).join('\n')}`);
  assert.ok(refs.some(([, l]) => /capLeaderHit/.test(l)), '限伤那处引用必须点名 `capLeaderHit`（登记项的 marks 就是它）');
});

test('阴性对照（先证明这条链有判别力）：领袖吃 `BOSS_HIT_LIMIT × 16` ⇒ **只掉 `BOSS_HIT_LIMIT`**', () => {
  // ⚠️ 领袖的造法（我第一版写错成"友方 + rank BOSS"）：**领袖是一个带 `tag: 'boss'` 的敌方**，
  //    `Battle` 在 spawn 时置 `isBoss`（`server/sim/battle/spawns.js:152`）—— 见 `limits-clamp.test.js:44` 的前置写法。
  const h = makeBattle({
    kind: 'boss',
    defs: { enemies: { enemy_lead: enemyRec({ key: 'enemy_lead', rank: 'BOSS', hp: 1e9, speed: 0, atk: 0 }) } },
    content: 'generic', timeLimit: 60, autoFinish: false, captureNoisy: true,
    enemies: [{ key: 'enemy_lead', pos: [3, 9], tag: 'boss' }],
  });
  h.step();
  const leader = h.enemy('enemy_lead');
  assert.ok(leader && leader.isBoss, '前置：领袖是 boss 单位');
  const hp0 = leader.hp;
  h.b.dealDamage(null, leader, { amount: BOSS_HIT_LIMIT * 16, type: 'true' });
  assert.equal(hp0 - leader.hp, BOSS_HIT_LIMIT,
    `🔴 领袖吃 ${BOSS_HIT_LIMIT * 16} ⇒ **只掉 ${BOSS_HIT_LIMIT}**（封顶；若掉满说明封顶没生效，若掉 0 说明回到了"整击作废"）`);
  checkInvariants(h.b);
});
