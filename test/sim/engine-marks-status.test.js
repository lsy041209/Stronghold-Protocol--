// test/sim/engine-marks-status.test.js —— **G1「服务端运行时」那 7 条"登记项过期"的判据面**（第 54 轮 A）。
//
// 背景：C《最小可上线判据-先上0.2.1》§1.2 把 G1（服务端运行时）里 ≈12 条划给 A54。我逐条取证后（`协作/交接-A到C与B11-G1服务端面A54的12条取证-2026-10-07.md`）：
//   · ✅ **真丢代码的：0 条**。只有 `devices.js` 的两段**裁定注释**（X-3）与 `bosses.js` 的一行**旧名注释**（X-1）是真丢，已各接回。
//   · 🟡 其余 7 条是**登记项过期** —— mark 是 **0.1.4.1 的写法**，上游 0.2.1 **重构换了写法/换了归属**
//     （`bands.js`/`bonds.js`：静态 import → 带守卫的动态 import；`tokens.js`/`Battle.js`/`ai.js`/`skills.js`：望的棋子/跟子逻辑搬到 kit 层）。
//
// 🔴 **本文件要解决的问题（"登记项过期"最危险的一点）**：这类登记项在 `patch-game` 里**永远是红的**，
//   于是**没人看得见它什么时候变成"真的缺了"** —— 上游哪天把 `bands/battle.js` 删了，缺标记数**一点都不会变**。
//   ⇒ 所以给这 7 条各配一条**功能层**判据：**它们在 + 接口在**（能红：模块/导出/子职业一旦消失就红）。
//
// ⚠️ 归 B10 的 `server/match/fields.js → 卡顿欠账的上限`（`MAX_CATCHUP_DEBT_SECONDS`）**不在本文件**（不是 A54 归属，见 §末尾注释）。
// ⚠️ 我**没有**改 `patch-game.mjs` 的 `FILES`（那是 B 的文件）：这份文件与 `x1-limits-notes.test.js`、`x3-terrain-stealth.test.js`
//    都**还没登记**（按 D 的判据 `grep "rel: '<rel>'" patch-game.mjs` 命中 0 ⇒ 我也没有同步进 overlay）。**请 B11 登记。**
//
// 跑：node --test test/sim/engine-marks-status.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ① bands.js / bonds.js：上游把「静态 import」改成了「带守卫的动态 import」
test('🟡 登记项过期 · `content/bands.js`：两个部件仍被加载且导出 `install`/`registerMeta`（mark 的旧写法已不存在）', async () => {
  for (const rel of ['server/sim/content/bands/battle.js', 'server/sim/content/bands/meta.js']) {
    assert.ok(exists(rel), `🔴 部件必须还在：${rel}（上游一旦删它 ⇒ 策略整批失效，而"缺少标记"数一点都不会变）`);
  }
  const src = read('server/sim/content/bands.js');
  assert.ok(/load\('\.\/bands\/battle\.js'\)/.test(src), '`bands.js` 必须仍然加载 `./bands/battle.js`（上游 0.2.1 的写法是 `load(...)`，不是静态 import）');
  const mod = await import('../../server/sim/content/bands.js');
  assert.equal(typeof mod.install, 'function', '`bands.js` 必须导出 `install(battle)`');
  assert.equal(typeof mod.registerMeta, 'function', '`bands.js` 必须导出 `registerMeta(registry)`');
  const battlePart = await import('../../server/sim/content/bands/battle.js');
  assert.equal(typeof battlePart.install, 'function', '`bands/battle.js` 必须导出 `install`（否则上面的 install 成了空转）');
});

test('🟡 登记项过期 · `content/bonds.js`：三个部件仍被加载且导出 `install`/`registerMeta`', async () => {
  for (const rel of ['server/sim/content/bonds/core.js', 'server/sim/content/bonds/addon.js', 'server/sim/content/support/meta.js']) {
    assert.ok(exists(rel), `🔴 部件必须还在：${rel}`);
  }
  const src = read('server/sim/content/bonds.js');
  for (const part of ['./bonds/core.js', './bonds/addon.js', './support/meta.js']) {
    assert.ok(src.includes(`load('${part}')`), `\`bonds.js\` 必须仍然加载 \`${part}\``);
  }
  const mod = await import('../../server/sim/content/bonds.js');
  assert.equal(typeof mod.install, 'function', '`bonds.js` 必须导出 `install(battle)`');
  assert.equal(typeof mod.registerMeta, 'function', '`bonds.js` 必须导出 `registerMeta(registry)`');
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ② professions.js：`artsprotector`（法抗师）仍在已知子职业表里，且 resolveProfile 认得它
test('🟡 登记项过期 · `professions.js` 的 `artsprotector`：仍在 `KNOWN_SUBPROFESSIONS`，且 `resolveProfile` 能解析', async () => {
  const mod = await import('../../server/sim/professions.js');
  assert.ok(Array.isArray(mod.KNOWN_SUBPROFESSIONS), '必须导出 `KNOWN_SUBPROFESSIONS`');
  assert.ok(mod.KNOWN_SUBPROFESSIONS.includes('artsprotector'),
    '🔴 `artsprotector`（法抗师）必须仍在已知子职业表里 —— 丢了它，法抗师会**静默**退回通用职业行为');
  // 功能层：拿一个法抗师 def 走一遍解析器，确认它**真的**被当成法抗师（不是只有名字在表里）
  const p = mod.resolveProfile({ profession: 'TANK', subProf: 'artsprotector', subProfessionId: 'artsprotector', phase: 2, level: 60, traitBb: {}, stats: {} });
  assert.ok(p && typeof p === 'object', '`resolveProfile` 必须返回 profile');
  assert.equal(p.sub, 'artsprotector', '解析出来的 profile 必须带上这个子职业（说明 SUB 表里也有它）');
});

// ─────────────────────────────────────────────────────────────────────────────
// ③ tokens.js / skills.js：能加载（这是"我方那半被静默丢掉"的直接症状 —— 悬空引用会让整个模块 import 失败）
test('🟡 登记项过期 · `content/tokens.js` 与 `sim/skills.js` 能加载（当年的失败模式正是"模块 import 直接抛"）', async () => {
  const tokens = await import('../../server/sim/content/tokens.js');
  assert.ok(tokens && typeof tokens === 'object', '`content/tokens.js` 必须能加载');
  assert.ok(Object.keys(tokens).length > 0, '`content/tokens.js` 必须仍有导出（召唤物内容）');
  const skills = await import('../../server/sim/skills.js');
  assert.ok(skills && typeof skills === 'object', '`sim/skills.js` 必须能加载');
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ④ 望的棋子/跟子：0.2.1 的归属 = **上游自己的 `op_wang.js` ＋ 上游自己的判据**
test('🟡 登记项过期 · 望的棋子/跟子：逻辑在 `kits/ops/op-wang.js`，判据是**上游自带的**（不是我们那批 `reserve-wang-*`）', () => {
  const kit = read('server/sim/content/kits/ops/op-wang.js');
  assert.ok(kit.includes('follower'), '🔴 `op-wang.js` 必须仍然实现"跟子"（`follower`：它的 summon fx 与落点）');
  assert.ok(kit.includes('token_10064_wang_stone1'), '`op-wang.js` 必须仍然引用棋子的 token id');
  const ownTest = read('test/content/op_wang.test.js');
  assert.ok(ownTest.includes('跟子'), '上游判据 `test/content/op_wang.test.js` 必须仍然覆盖 跟子（它与上游 0.2.1 逐字节相同、24/24 绿）');
  // 我们那批外援时代的判据**已随机制退役**（不在树里是**预期**，不是缺失）：
  for (const gone of ['test/content/reserve-wang-follow-boom.test.js', 'test/content/reserve-wang-piece-air.test.js']) {
    assert.ok(!exists(gone), `${gone} 属于已退役的 reserve 机制 ⇒ 它不在树里是预期（别把它当缺失补回来）`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ⑤（**2026-10-08 已落地 · B10**）`server/match/fields.js → 卡顿欠账的上限`
//   ⚠️ 本条原先由 A54 写成"只记录不判"（`assert.equal(present, false)`），并在其消息里写明
//      "**若这里变红 ⇒ 说明 B10 已接回 ⇒ 请顺手更新取证件**"。**2026-10-08 B10 接回了它** ⇒
//      本条按它自己的指示翻转：从"记录它不在"改成"**守住它在**"（同一件事、方向反过来，仍然能红）。
test('✅ 已落地（B10，2026-10-08）：`match/fields.js` 的 `MAX_CATCHUP_DEBT_SECONDS` 已在树里（A-3b 重挂）', () => {
  const src = read('server/match/fields.js');
  // 🔴 现在的方向：**它必须在**。谁再把它冲掉，这条立刻红（这就是本条存在的意义）。
  assert.ok(src.includes('MAX_CATCHUP_DEBT_SECONDS'),
    '`match/fields.js` 必须仍有 `MAX_CATCHUP_DEBT_SECONDS`（A-3b：卡顿欠账封顶，不许再用 `acc = 0` 抹掉整段）');
  // 顺带钉住"旧写法不许回来"——那正是 A-3b 修掉的那一行
  assert.ok(!src.includes('if (n > cap) { n = cap; this.acc = 0; }'),
    '🔴 旧写法 `this.acc = 0` 不许回来（它把卡顿期间的整段欠账抹掉 ⇒ 服务端跑与客户端跑分叉）');
});
