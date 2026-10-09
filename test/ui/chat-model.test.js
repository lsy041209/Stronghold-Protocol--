// test/ui/chat-model.test.js — 聊天**纯逻辑层**的护栏（第 6 任 B，2026-10-07；C 总表 B-6）
//
// 为什么先测这一层：面板本体是 htm vnode（另有一份 `chat-panel.test.js` 走 vnode 遍历），
// 而"**码点**截断 / 环形缓冲 / 历史合并 / 谁能发言 / 旧服务端降级"这几条**与 DOM 无关**、最容易写错、也最该先钉住。
// ⚠️ 本文件里的每条断言都**证过会红**（见 `工作复盘` 与 `进度-B.md`；我至少对"码点"与"环形"做过变异）。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const {
  CHAT_MAX_CODEPOINTS, clampText, isBlank, displayName, normalizeMessage,
  appendChat, mergeHistory, messageKey, formatClock, isUnsupportedChatError,
  isMine, canSpeakInRoom, countUnread, clampPanelPos, isDragMove,
} = await import('../../public/js/ui/chatModel.js');

describe('聊天纯逻辑：长度按**码点**算（emoji / 增补平面汉字不能被切成半个）', () => {
  test('普通文本：超过 120 码点被截到恰好 120', () => {
    const s = 'あ'.repeat(200);
    assert.equal(Array.from(clampText(s)).length, CHAT_MAX_CODEPOINTS);
  });

  test('🔴 码点判据：120 个 emoji（每枚 2 个 UTF-16 码元）必须**完整保留 120 枚**', () => {
    const s = '🎯'.repeat(130);
    const out = clampText(s);
    assert.equal(Array.from(out).length, 120, '按码点截 ⇒ 120 枚；若误用 slice(0,120) 只剩 60 枚、且末尾是半个代理对');
    assert.equal(out.includes('\uFFFD'), false);
    // 反向：末尾不能落单（半个代理对的特征）
    const last = out.codePointAt(out.length - 2);
    assert.ok(last >= 0x1f000 && last <= 0x1faff, '最后一枚应是完整 emoji');
  });

  test('去首尾空白、保留内部空白；`isBlank` 只认真的空', () => {
    assert.equal(clampText('  你好  世界  '), '你好  世界');
    assert.equal(isBlank('   \t  '), true);
    assert.equal(isBlank('  。 '), false);
    assert.equal(isBlank(null), true);
  });
});

describe('聊天纯逻辑：消息形状与环形缓冲', () => {
  test('normalizeMessage 对垃圾输入宽容（不抛，字段有安全回落）', () => {
    const a = normalizeMessage(undefined);
    assert.equal(typeof a.text, 'string');
    assert.equal(typeof a.at, 'number');
    assert.equal(a.from, '');
    const b = normalizeMessage({ from: 12345, name: '', text: 999, at: 'oops' });
    assert.equal(b.from, '12345');
    assert.equal(b.text, '999');
    assert.equal(b.name, '玩家 2345', '昵称空了 ⇒ 回落成 id 尾号');
    assert.equal(typeof b.at, 'number');
  });

  test('🔴 环形：超过上限丢**最旧**的，且长度恒等于上限', () => {
    let list = [];
    for (let i = 0; i < 7; i += 1) list = appendChat(list, { from: 'p', text: `#${i}`, at: 1000 + i }, 5);
    assert.equal(list.length, 5);
    assert.deepEqual(list.map((m) => m.text), ['#2', '#3', '#4', '#5', '#6'], '留下的是**最新** 5 条');
  });

  test('非数组输入不抛（store 初始化/旧版本存档）', () => {
    assert.equal(appendChat(null, { text: 'x' }).length, 1);
    assert.deepEqual(mergeHistory(undefined, undefined), []);
  });
});

describe('聊天纯逻辑：补发历史合并（重连/重进要看到最近几条）', () => {
  const h1 = { from: 'a', name: '甲', text: '历史一', at: 100 };
  const h2 = { from: 'b', name: '乙', text: '历史二', at: 200 };
  const live = { from: 'c', name: '丙', text: '刚说的', at: 300 };

  test('历史为底 + 本地独有的接上；按时间排序', () => {
    const merged = mergeHistory([live], [h1, h2]);
    assert.deepEqual(merged.map((m) => m.text), ['历史一', '历史二', '刚说的']);
  });

  test('**去重**：同一条既在历史里又在本地（实时广播 + 补发重叠）⇒ 只留一条', () => {
    const merged = mergeHistory([h2, live], [h1, h2]);
    assert.deepEqual(merged.map((m) => m.text), ['历史一', '历史二', '刚说的']);
  });

  test('`chat.history` 字段缺失/改名 ⇒ 当"没有历史"，不抛也不丢本地', () => {
    assert.deepEqual(mergeHistory([live], { messages: [h1] }).map((m) => m.text), ['刚说的']);
    assert.deepEqual(mergeHistory([live], null).map((m) => m.text), ['刚说的']);
  });

  test('messageKey 认得出"同一条"', () => {
    assert.equal(messageKey({ from: 'a', at: 1, text: 'x' }), messageKey({ from: 'a', at: 1, text: 'x', name: '别的名字' }));
    assert.notEqual(messageKey({ from: 'a', at: 1, text: 'x' }), messageKey({ from: 'a', at: 2, text: 'x' }));
  });
});

describe('聊天纯逻辑：权限 / 降级 / 展示', () => {
  test('🔴 用户口径：**纯观战者不可发言，阵亡转观战的可以**（客户端判据 = 是否曾占过座位）', () => {
    assert.equal(canSpeakInRoom({ everSeated: false }), false, 'room.spectate 进来的 ⇒ 只读');
    assert.equal(canSpeakInRoom({ everSeated: true }), true);
    assert.equal(canSpeakInRoom(null), false);
  });

  test('旧服务端的 `BAD_MSG` 认得出（UI 要置灰，不是弹错误刷屏）', () => {
    assert.equal(isUnsupportedChatError({ code: 'BAD_MSG', msg: 'bad message' }), true);
    assert.equal(isUnsupportedChatError({ code: 'BAD_MSG' }), true);
    assert.equal(isUnsupportedChatError(new Error('unknown intent room.chat')), true);
    assert.equal(isUnsupportedChatError({ code: 'RATE_LIMIT' }), false);
    assert.equal(isUnsupportedChatError(null), false);
  });

  test('自己 / 别人分得清；本地时钟格式化稳定', () => {
    assert.equal(isMine({ from: 'me' }, 'me'), true);
    assert.equal(isMine({ from: 'other' }, 'me'), false);
    assert.equal(isMine({ from: '' }, ''), false, 'from 为空不算"我"');
    assert.equal(formatClock(0).length, 5);
    assert.match(formatClock(1791266816837), /^\d\d:\d\d$/);
    assert.equal(formatClock('oops'), '--:--');
  });

  test('未读数（收起时的红点）：只看**比"上次看过"更晚**的', () => {
    const list = [{ at: 100, text: 'a' }, { at: 200, text: 'b' }, { at: 300, text: 'c' }];
    assert.equal(countUnread(list, 150), 2);
    assert.equal(countUnread(list, 300), 0);
    assert.equal(countUnread(list, undefined), 0);
  });
});

// ══ 拖动（本工程第一次做可拖动的 DOM 面板；Node 里没有 DOM ⇒ 把"能算的部分"抽成纯函数在这里钉住）════════
// 先例是 `ui/lanPanel.js:99-133`（但它**只在桌面外壳里渲染**）：pointerDown 记 base + pointerMove 里
// `Math.hypot(dx,dy) < 10` 算点击、最后 clamp 到 `innerWidth - offsetWidth - 4`。这里测的就是那两段。
describe('聊天纯逻辑：拖动的位置夹取与"算不算拖"（替代在 Node 里测不了的真实拖动）', () => {
  test('视口内 ⇒ 原样返回', () => {
    assert.deepEqual(clampPanelPos({ x: 100, y: 200 }, { w: 228, h: 200, vw: 1920, vh: 1080 }), { x: 100, y: 200 });
  });

  test('🔴 越界 ⇒ 被夹回视口内（右边/下边都留 4px），不能拖出去再也点不到', () => {
    const p = clampPanelPos({ x: 9999, y: 9999 }, { w: 228, h: 200, vw: 1000, vh: 600 });
    assert.deepEqual(p, { x: 1000 - 228 - 4, y: 600 - 200 - 4 });
    const n = clampPanelPos({ x: -50, y: -50 }, { w: 228, h: 200, vw: 1000, vh: 600 });
    assert.deepEqual(n, { x: 4, y: 4 }, '左上也要留边距');
  });

  test('位置缺失/非法 ⇒ 兜到右下角默认位（首次打开不炸）', () => {
    const d = clampPanelPos(null, { w: 100, h: 50, vw: 800, vh: 600 });
    assert.deepEqual(d, { x: 800 - 100 - 4, y: 600 - 50 - 4 });
    assert.deepEqual(clampPanelPos({ x: NaN, y: 'x' }, { w: 100, h: 50, vw: 800, vh: 600 }), d);
  });

  test('面板比视口还大 ⇒ 至少停在边距上（不许出现负坐标）', () => {
    const p = clampPanelPos({ x: 500, y: 500 }, { w: 2000, h: 2000, vw: 800, vh: 600 });
    assert.ok(p.x >= 4 && p.y >= 4);
  });

  test('🔴 拖动阈值：位移 <10px 算点击（否则"点一下"会把面板挪走几个像素）', () => {
    assert.equal(isDragMove(3, 4), false, '5px 位移 = 点击');
    assert.equal(isDragMove(6, 8), true, '10px == 阈值 ⇒ 算拖');
    assert.equal(isDragMove(0, 0), false);
    assert.equal(isDragMove(NaN, 5), false);
  });
});
