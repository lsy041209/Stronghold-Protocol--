// 外援干员 (reserve operators) — the loadout slot flag, its validation, the pool seeding and the per-player roll filter.
//
// A reserve operator is an operator the ordinary roster hides (`isReserve: true`, not in `visibleChess`). A seat may
// equip it in a tier-5 / tier-6 reserve slot (`entries[id].reserve = 5|6`); the match then seeds it into the SHARED
// pool at that slot tier's copy count (so its shop odds match the tier's ordinary chess), while a player only ever
// rolls the reserves it equipped itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameData } from '../../server/match/gamedata.js';
import { SharedPool } from '../../server/match/pool.js';
import { checkLoadout, loadoutOptions, RESERVE_TIERS, LOADOUT_LIMITS } from '../../shared/protocol.js';
import { DATA, chessOfTier } from './harness.js';

const R1 = 'chess_reserve_1';
const R2 = 'chess_reserve_2';
const R3 = 'chess_reserve_3';
const PLAIN = 'chess_plain_probe';

/** DATA + three reserve candidates (hidden) and one ordinary probe chess. */
function probeData() {
  const tmpl = DATA.chess[chessOfTier(1)[0]];
  const mk = (chessId, extra) => ({ ...tmpl, chessId, baseId: chessId, goldenId: null, ...extra });
  const chess = {
    ...DATA.chess,
    [R1]: mk(R1, { name: '外援一', isReserve: true, isHidden: true, visible: false }),
    [R2]: mk(R2, { name: '外援二', isReserve: true, isHidden: true, visible: false }),
    [R3]: mk(R3, { name: '外援三', isReserve: true, isHidden: true, visible: false }),
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
  assert.equal(e.cap, 8, 'tier-5 ordinary copy count');
  assert.equal(e.left, e.cap);
  assert.equal(pool.isReserve(R1), true);
  // tier 6 uses the tier-6 count
  const p6 = new SharedPool(gd, { reserves: [{ id: R1, tier: 6 }] });
  assert.equal(p6.cap(R1), gd.poolCopiesForTier(6));
  assert.equal(p6.cap(R1), 5);
});

test('外援: 多个玩家装同一个只占一份池子名额，copies 共享消耗', () => {
  const data = probeData();
  const gd = gdOf(data);
  const pool = new SharedPool(gd, { reserves: [{ id: R1, tier: 5 }, { id: R1, tier: 5 }, { id: R1, tier: 6 }] });
  assert.equal(pool.entries.get(R1).cap, 8, 'one entry, seeded once (first slot wins)');
  assert.equal(pool.reserves.get(R1), 5);
  assert.equal(pool.take(R1, 3), 3);
  assert.equal(pool.left(R1), 5, 'a second player draws from the same pile');
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

test('外援: 已经是被禁用的干员时不会被塞进池子', () => {
  const data = probeData();
  const gd = gdOf(data);
  const pool = new SharedPool(gd, { banned: [R1], reserves: [{ id: R1, tier: 5 }] });
  assert.equal(pool.entries.has(R1), false);
  assert.equal(pool.isReserve(R1), false);
});
