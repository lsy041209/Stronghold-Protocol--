// lobby-matching.test.js — 快速匹配浮层的**纯逻辑**判据（用户口径「下一步就做匹配的浮层」；C 派 T6 的客户端那半）
//
// ⚠️ 只测纯函数 `matchingStatus`（`lobby.js` 导出）：带 hook 的浮层在 Node 里当函数调不了，
//    它的**显示规则**（在找人 / 等 AI 补满 / 还要等几秒 / 队列读数怎么显示）全部落在这个纯函数里 ⇒ 这里判得动。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { matchingStatus, shouldShowMatch } = await import('../../public/js/ui/matchOverlay.js');
const S = matchingStatus;

describe('快速匹配浮层：状态与读数（纯逻辑）', () => {
  test('三态：0s / 未到时限 / 到时限（phase 与 fillIn 都要对）', () => {
    assert.deepEqual(S(0, 60000, 0), { elapsed: 0, phase: 'searching', fillIn: 60, queueText: '0' });
    assert.equal(S(30500, 60000, 2).elapsed, 30, '秒数向下取整');
    assert.equal(S(30500, 60000, 2).fillIn, 30, '还要等 30 秒');
    assert.equal(S(30500, 60000, 2).phase, 'searching');
    // 🔴 到达时限 ⇒ 换成"等 AI 补满"那一态
    assert.equal(S(60000, 60000, 0).phase, 'filling');
    assert.equal(S(60000, 60000, 0).fillIn, 0);
    // 负对照：超时很久也不许出现负数（否则界面会写"还要再等 -30 秒"）
    assert.equal(S(90000, 60000, 0).fillIn, 0);
    assert.equal(S(90000, 60000, 0).phase, 'filling');
  });

  test('🔴 坏输入不许崩、也不许给出误导性的数字', () => {
    assert.deepEqual(S(NaN, NaN, NaN), { elapsed: 0, phase: 'searching', fillIn: 60, queueText: '—' });
    assert.deepEqual(S(-5000, 60000, 0).elapsed, 0, '负等待 ⇒ 0');
    assert.deepEqual(S(Infinity, 60000, 0).elapsed, 0, 'Infinity ⇒ 0');
    assert.equal(S(0, 0, 0).fillIn, 60, 'fillMs 为 0/坏值 ⇒ 回默认 60000');
    assert.equal(S(1000, -1, 0).fillIn, 59, '等待 1 秒 ⇒ 还剩 59 秒（fillMs 坏值也回默认）');
  });

  test('队列读数：拿不到就显示「—」（⛔ 不许把"不知道"写成 0）；负数/小数都归一', () => {
    assert.equal(S(0, 60000, NaN).queueText, '—', '还没拿到 ⇒ —');
    assert.equal(S(0, 60000, undefined).queueText, '—');
    assert.equal(S(0, 60000, null).queueText, '—', 'null 不该被当成 0（Number(null)=0 ⇒ 这里按"没拿到"处理）');
    assert.equal(S(0, 60000, 3.7).queueText, '3', '小数截断');
    assert.equal(S(0, 60000, -2).queueText, '0', '负数归 0');
    assert.equal(S(0, 60000, 12).queueText, '12');
  });

  test('浮层该不该显示：匹配中且**还没开局**才显示（🔴 进房 ≠ 开局 —— 用户实测"匹配页面依然是房间内页面"就出在这里）', () => {
    assert.equal(shouldShowMatch({ at: 1 }, false), true, '在匹配、还没开局 ⇒ 显示（**房间屏上也要显示**）');
    assert.equal(shouldShowMatch(null, false), false, '没在匹配 ⇒ 不显示');
    assert.equal(shouldShowMatch({ at: 1 }, true), false, '开局了 ⇒ 收起（让位给对局）');
    assert.equal(shouldShowMatch(null, true), false);
    assert.equal(shouldShowMatch(undefined, undefined), false, '坏输入 ⇒ 不显示（不崩）');
  });

  test('🔴 匹配期间**留在主页面**（不进房间屏）＋ 锁住其它入口；开局/取消后恢复', async () => {
    const { matchingKeepsLobby, selectRoute } = await import('../../public/js/store.js');
    const { matchLocksLobby } = await import('../../public/js/ui/matchOverlay.js');
    const base = { session: { entered: true }, room: { code: 'ABCD', inMatch: false }, match: { public: { phase: 'LOBBY' } } };
    // 匹配中：即使服务端已经把你放进房（room 有值）⇒ 仍然显示大厅（用户口径）
    assert.equal(matchingKeepsLobby({ ...base, matchSearch: { at: 1 } }), true);
    assert.equal(selectRoute({ ...base, matchSearch: { at: 1 } }), 'lobby', '匹配中 ⇒ 大厅（不是 room）');
    // 不匹配 ⇒ 照旧进房间；开局 ⇒ 进对局
    assert.equal(matchingKeepsLobby({ ...base, matchSearch: null }), false);
    assert.equal(selectRoute({ ...base, matchSearch: null }), 'room', '没在匹配 ⇒ 房间屏照旧');
    assert.equal(selectRoute({ ...base, matchSearch: { at: 1 }, room: { code: 'ABCD', inMatch: true } }), 'game', '开局 ⇒ 对局（浮层让位）');
    assert.equal(matchingKeepsLobby({ ...base, matchSearch: { at: 1 }, match: { public: { phase: 'PREP' } } }), false, '对局相位 ⇒ 不再压在大厅');
    // 锁：匹配中锁住其它入口；干员调配/公告不在这条判据里（它们不受影响）
    assert.equal(matchLocksLobby({ at: 1 }), true);
    assert.equal(matchLocksLobby(null), false);
    assert.equal(matchLocksLobby(undefined), false);
  });
});
