// 外援干员 (reserve operators) — the loadout slot flag, its validation, the pool seeding and the per-player roll filter.
//
// A reserve operator is an operator the ordinary roster hides (`isReserve: true`, not in `visibleChess`). A seat may
// equip it in a tier-5 / tier-6 reserve slot (`entries[id].reserve = 5|6`); the match then seeds it into the SHARED
// pool at that slot tier's copy count (so its shop odds match the tier's ordinary chess), while a player only ever
// rolls the reserves it equipped itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameData, DEFAULTS } from '../../server/match/gamedata.js';
import { SharedPool } from '../../server/match/pool.js';
import { checkLoadout, loadoutOptions, RESERVE_TIERS, LOADOUT_LIMITS } from '../../shared/protocol.js';
import { DATA, chessOfTier } from './harness.js';

const R1 = 'chess_reserve_1';
const R2 = 'chess_reserve_2';
const R3 = 'chess_reserve_3';
const PLAIN = 'chess_plain_probe';
/** simpfun 形状的助战记录：`isSupport: true`、**没有 `isReserve`**、`visible:false` 但 `isHidden:false`（照他们原样）。 */
const SUP = 'chess_support_probe_1';

/** DATA + three reserve candidates (hidden) and one ordinary probe chess. */
function probeData() {
  const tmpl = DATA.chess[chessOfTier(1)[0]];
  const mk = (chessId, extra) => ({ ...tmpl, chessId, baseId: chessId, goldenId: null, ...extra });
  const chess = {
    ...DATA.chess,
    [R1]: mk(R1, { name: '外援一', isReserve: true, isHidden: true, visible: false }),
    [R2]: mk(R2, { name: '外援二', isReserve: true, isHidden: true, visible: false }),
    [R3]: mk(R3, { name: '外援三', isReserve: true, isHidden: true, visible: false }),
    // 🔴 **simpfun 的形状**（2026-10-06 T-3 P2）：`isSupport` 而不是 `isReserve`，而且 **`isHidden:false`** ——
    //    `isHidden` 那条路是"普通选择也不可见"，他们的记录靠 **`visible:false`** 挡住普通池 ✓（实测他们的
    //    `chess_support_6_char_4037_demetr_a` = `tier 6 / visible false / isHidden false / isSupport true`）。
    [SUP]: mk(SUP, { name: '助战探针', isSupport: true, isReserve: undefined, isHidden: false, visible: false }),
    [PLAIN]: mk(PLAIN, { name: '普通探针', isReserve: false, isHidden: false, visible: true }),
  };
  return { ...DATA, chess };
}
const gdOf = (data) => new GameData(data, 'mode_multi_normal');
const getOf = (data) => (id) => data.chess[id];

test('外援: 合法槽位通过校验；越界阶级 / 非候选 / 隐藏干员的普通选择都被拒', () => {
  const data = probeData();
  const get = getOf(data);
  // a legal reserve pick — a HIDDEN candidate is allowed here (that is the whole point)
  const ok = checkLoadout({ [R1]: { reserve: 5 } }, get);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.loadout[R1].reserve, 5);
  assert.equal(ok.loadout[R1].skill, loadoutOptions(get(R1), null).defaultSkill, 'the default skill is filled in');
  // tier outside RESERVE_TIERS
  assert.equal(checkLoadout({ [R1]: { reserve: 4 } }, get).error, 'BAD_MSG');
  assert.equal(checkLoadout({ [R1]: { reserve: 7 } }, get).error, 'BAD_MSG');
  assert.equal(checkLoadout({ [R1]: { reserve: '5' } }, get).error, 'BAD_MSG');
  // an ordinary PROBE may not claim a reserve slot
  assert.equal(checkLoadout({ [PLAIN]: { reserve: 5 } }, get).error, 'BAD_TARGET');
  // and a reserve candidate may not be taken as an ordinary slot (it is hidden)
  const skill = loadoutOptions(get(R1), null).defaultSkill;
  assert.equal(checkLoadout({ [R1]: { skill } }, get).error, 'BAD_TARGET');
  // RESERVE_TIERS is the documented pair
  assert.deepEqual([...RESERVE_TIERS], [5, 6]);
  assert.equal(LOADOUT_LIMITS.reserveSlots, 2);
});

test('外援: 每个阶级最多 2 个槽位（第 3 个被拒）', () => {
  const data = probeData();
  const get = getOf(data);
  const two = checkLoadout({ [R1]: { reserve: 5 }, [R2]: { reserve: 5 } }, get);
  assert.equal(two.ok, true);
  const three = checkLoadout({ [R1]: { reserve: 5 }, [R2]: { reserve: 5 }, [R3]: { reserve: 5 } }, get);
  assert.equal(three.error, 'BAD_TARGET');
  assert.match(three.detail, /reserve/i);
  // two per tier is independent: 2 at tier 5 + 2 at tier 6 is fine
  const both = checkLoadout({ [R1]: { reserve: 5 }, [R2]: { reserve: 5 }, [R3]: { reserve: 6 } }, get);
  assert.equal(both.ok, true);
});

test('外援: 🔴 **simpfun 的形状（`isSupport`，没有 `isReserve`）也能装进 5/6 阶槽** —— T-3 P2 的服务端硬闸', () => {
  // **为什么要这条**（C 的落地单 §4.2）：下一版要采用 simpfun 的记录形状（`isSupport: true`，**不带 `isReserve`**）。
  //   `checkLoadout` 是配装的唯一入口 ⇒ 这一行漏了就会"**UI 能装、服务端拒绝**"（而且是静默的：装载时才发现）。
  const data = probeData();
  const get = getOf(data);
  const gd = gdOf(data);
  // ① 普通池里**没有**它（`visible:false`，与 `isHidden` 无关）
  assert.ok(!gd.visibleChess.includes(SUP), 'support 记录不进 visibleChess');
  assert.equal(get(SUP).isReserve, undefined, '前置：它是 simpfun 形状，**没有** isReserve');
  assert.equal(get(SUP).isSupport, true, '前置：它带 isSupport');
  // ② 装进 5 阶 / 6 阶槽都要通过
  for (const tier of [5, 6]) {
    const ok = checkLoadout({ [SUP]: { reserve: tier } }, get);
    assert.equal(ok.ok, true, `isSupport 记录装 ${tier} 阶槽必须通过：${JSON.stringify(ok)}`);
    assert.equal(ok.loadout[SUP].reserve, tier);
  }
  // ③ 闸的边界：**既不是 isReserve 也不是 isSupport** 的普通干员照样被拒（别把闸开成"谁都能装"）
  assert.equal(checkLoadout({ [PLAIN]: { reserve: 5 } }, get).error, 'BAD_TARGET');
  // ④ 它作为**普通选择**仍不可见（哪怕 `isHidden:false`）—— 死规矩：外援永不进商店
  const skill = loadoutOptions(get(SUP), null).defaultSkill;
  assert.equal(checkLoadout({ [SUP]: { skill } }, get).error, 'BAD_TARGET');
  // ⑤ 进池：按槽位阶级、且 `isReserve()` 认得它（池子只认"装了的那个 id"，与记录上的标记无关）
  const pool = new SharedPool(gd, { reserves: [{ id: SUP, tier: 6 }] });
  assert.equal(pool.isReserve(SUP), true, '池子认得它');
  assert.equal(pool.entries.get(SUP)?.tier, 6, '按槽位阶级入池');
  assert.equal(pool.entries.get(SUP)?.cap, gd.poolCopiesForTier(6));
});

test('外援: 只带外援位、技能模组全是默认的条目不会被当成「等于默认」丢掉', () => {
  const data = probeData();
  const get = getOf(data);
  const plainEntry = checkLoadout({ [PLAIN]: {} }, get);
  assert.equal(plainEntry.error, 'BAD_MSG', 'an empty entry is structurally invalid, never silently kept');
  // an ordinary entry equal to the defaults IS dropped
  const skill = loadoutOptions(get(PLAIN), null).defaultSkill;
  const dropped = checkLoadout({ [PLAIN]: { skill } }, get);
  assert.equal(dropped.ok, true);
  assert.equal(dropped.loadout[PLAIN], undefined, 'default-equal ordinary entry dropped');
  // the same shape WITH a reserve slot is kept (the slot is a choice of its own)
  const kept = checkLoadout({ [R1]: { reserve: 6 } }, get);
  assert.equal(kept.ok, true);
  assert.ok(kept.loadout[R1], 'reserve entry kept');
});

test('外援: 按槽位阶级进池（copies 同该阶级），且槽位阶级覆盖干员自身阶级', () => {
  const data = probeData();
  const gd = gdOf(data);
  // hidden candidates are not in the ordinary pool
  assert.ok(!gd.visibleChess.includes(R1), 'a reserve candidate stays out of visibleChess');
  const pool = new SharedPool(gd, { reserves: [{ id: R1, tier: 5 }] });
  const e = pool.entries.get(R1);
  assert.ok(e, 'seeded into the pool');
  assert.equal(e.tier, 5, 'the SLOT tier decides');
  assert.equal(e.reserve, true);
  assert.equal(e.cap, gd.poolCopiesForTier(5));
  // ⚠️ `poolCopiesForTier` = 该阶级的普通份数 × **测试期** `economy.tierCopiesScale`（测试态 3 阶 ×4）⇒
  //    这里**绝不写死** `8` / `5`：那两个值只在规范态成立，测试态会把本条判成假红（2026-10-06 第 46 轮 A 修）。
  assert.equal(gd.economy.poolCopies?.[5] ?? DEFAULTS.poolCopies[5], 8, '规范态的 5 阶普通份数是 8（本档唯一硬编码，与两态无关）');
  assert.equal(e.left, e.cap);
  assert.equal(pool.isReserve(R1), true);
  // tier 6 uses the tier-6 count（用**阶级间的大小关系**表达"按阶级取份数"，不依赖两态的具体数值）
  const p6 = new SharedPool(gd, { reserves: [{ id: R1, tier: 6 }] });
  assert.equal(p6.cap(R1), gd.poolCopiesForTier(6));
  assert.equal(gd.economy.poolCopies?.[6] ?? DEFAULTS.poolCopies[6], 5, '规范态的 6 阶普通份数是 5');
  assert.ok(p6.cap(R1) < e.cap, '6 阶各档都比 5 阶稀有（同一 scale 下仍成立）');
});

test('外援: 多个玩家装同一个只占一份池子名额，copies 共享消耗', () => {
  const data = probeData();
  const gd = gdOf(data);
  const pool = new SharedPool(gd, { reserves: [{ id: R1, tier: 5 }, { id: R1, tier: 5 }, { id: R1, tier: 6 }] });
  const cap5 = gd.poolCopiesForTier(5);
  assert.equal(pool.entries.get(R1).cap, cap5, 'one entry, seeded once (first slot wins)');
  assert.equal(pool.reserves.get(R1), 5);
  assert.equal(pool.take(R1, 3), 3);
  // ⚠️ 同样**不写死** `8` / `5`：本条的意图是"两个玩家共用同一堆、消耗共享"，
  //    用 `cap5` 推导即可表达（测试态 `tierCopiesScale` 会把 cap5 放大成 32）。
  assert.equal(pool.left(R1), cap5 - 3, 'a second player draws from the same pile');
});

test('外援: 每个玩家只 roll 自己装配的外援', () => {
  const data = probeData();
  const gd = gdOf(data);
  const pool = new SharedPool(gd, { reserves: [{ id: R1, tier: 5 }, { id: R3, tier: 6 }] });
  const ordinary = gd.visibleChess[0];
  // a player who equipped none: every reserve is filtered out, ordinary chess pass
  const none = pool.rollReserveFilter(null);
  assert.equal(none(R1), false);
  assert.equal(none(R3), false);
  assert.equal(none(ordinary), true);
  // a player who equipped R1 only
  const one = pool.rollReserveFilter(new Set([R1]));
  assert.equal(one(R1), true);
  assert.equal(one(R3), false, 'someone else\'s reserve stays invisible');
  assert.equal(one(ordinary), true);
  // a pool WITHOUT reserves needs no filter at all
  const bare = new SharedPool(gd, {});
  assert.equal(bare.rollReserveFilter(null), null);
});

test('外援: 随机抽出的禁用羁绊不拦外援；模式静态禁用的羁绊才拦（2026-10-06 用户口径）', () => {
  const data = probeData();
  const gd = gdOf(data);
  // ── ① `banned`（`Match` 传进来的是 `drawDisabledBonds()` 每局**随机抽**出来的结果）**只管普通池子** ──
  //    ⚠️ 外援是**玩家在配装里明确装配的槽位干员**，不属于"本局随机洗牌出来的商店集合"。
  //    旧行为是 `ban.has(id)` 一并把外援挡掉 ⇒ 四位外援的 bonds 都是同一个羁绊 ⇒
  //    **约 25% 的对局（实测 10/40 个种子）商店里根本刷不到外援** ✗（B 报备的缺口②，用户裁决：按官方/按"不该牵连"改）。
  const pool = new SharedPool(gd, { banned: [R1], reserves: [{ id: R1, tier: 5 }] });
  assert.equal(pool.entries.has(R1), true, '随机抽出的禁用羁绊不把外援挡在池外');
  assert.equal(pool.isReserve(R1), true);
  assert.equal(pool.cap(R1), gd.poolCopiesForTier(5), '仍按槽位阶级的份数入池');
  assert.deepEqual(pool.banned, [R1], '`pool.banned` 的对外口径不变（仍列出被禁的棋子）');
  // ── ② 模式的**静态**禁用羁绊（`mode.inactiveBondIds`）**仍然**作用于外援：那是固定规则，不是随机性 ──
  //    构造一个把 R1 的**全部**羁绊都静态禁掉的 mode（本作 `mode_multi_normal` 的 inactiveBondIds 是空的，
  //    所以这里必须注入，否则这条判据恒真 = 噪音 ✗）。
  //    ⚠️ harness 的 `DATA` **没有 `modes`**（mode 是 `GameData` 从 `data/config.json` 另拼的）
  //    ⇒ 不能 `{...data.modes, ...}`（`undefined` 展开成 `{}` 会把 mode 抹掉 ⇒ `GameData` 里 `this.mode` 为空 ✗）。
  const bonds = Array.isArray(gd.chess(R1).bonds) ? gd.chess(R1).bonds : [];
  assert.ok(bonds.length > 0, '探针前置：R1 有羁绊（否则下面那条静态判据测不到）');
  //    ⚠️ `GameData` 的 mode 走的是 `server/data.js` 的 `getMode(modeId, raw)` → `getConfig(raw)`，
  //    而 `getConfig` 只认 **`raw.config`**（`Object.hasOwn(data,'config')`）；harness 的 `DATA` 没有 `config`
  //    ⇒ 必须把 mode 注到 **`data.config.modes`** 里（注 `data.modes` 是无效的：`[...gd.modeInactiveBonds]` 会是空的 ✗）。
  const dataStatic = {
    ...data,
    config: { ...(data.config || {}), modes: { ...((data.config || {}).modes || {}), mode_multi_normal: { ...gd.mode, inactiveBondIds: bonds } } },
  };
  const gdStatic = gdOf(dataStatic);
  assert.deepEqual([...gdStatic.modeInactiveBonds], bonds, '静态禁用羁绊注入成功（否则这条测不到）');
  const p2 = new SharedPool(gdStatic, { banned: [], reserves: [{ id: R1, tier: 5 }] });
  assert.equal(p2.entries.has(R1), false, '静态禁用羁绊**仍然**把外援挡在池外');
  assert.equal(p2.isReserve(R1), false);
});
