// test/ui/chat-panel.test.js — 聊天**面板**的交互护栏（第 6 任 B，2026-10-07；C 总表 B-6）
//
// 做法与 `reserve-slot.test.js` **同一套**：把 htm vnode 树走一遍，把 `props.onClick / onInput / onPointerDown`
// 当成 DOM 会调的那个函数**真调一遍** —— 而不是去 match 源码（本工作区的教训：
// 「文件里写着 `onClick=${...}`」**证明不了点下去会发生什么**）。
//
// 只测**纯展示组件** `ChatPanel`（无 hook ⇒ 能直接当函数调）；带 hook 的 `ChatPanelHost`
// （拖动/偏好/net）在 Node 里跑不了，它的**纯逻辑**（位置夹取、拖动阈值、环形、权限、降级）由
// `chat-model.test.js` 覆盖 —— 这是本工程对"带 hook 的组件"的既有处理方式（见 `loadout.js` 的 `Detail`）。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { ChatPanel } = await import('../../public/js/ui/chatPanel.js');
const { CHAT_MAX_CODEPOINTS } = await import('../../public/js/ui/chatModel.js');

const EXPAND = new Set(['Button']);      // 展示型组件：原地展开才能看到它渲染出的 <button>
function* walk(v) {
  if (Array.isArray(v)) { for (const x of v) yield* walk(x); return; }
  if (!v || typeof v !== 'object') return;
  yield v;
  if (typeof v.type === 'function' && EXPAND.has(v.type.name)) yield* walk(v.type(v.props));
  for (const [k, val] of Object.entries(v.props || {})) {
    if (k === 'children' || val == null || typeof val !== 'object') continue;
    yield* walk(val);
  }
  yield* walk(v.props?.children);
}
const nodes = (tree) => [...walk(tree)];
const textOf = (v) => {
  if (v == null || typeof v === 'boolean') return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.map(textOf).join('');
  if (typeof v !== 'object') return '';
  if (typeof v.type === 'function' && EXPAND.has(v.type.name)) return textOf(v.type(v.props));
  return Object.entries(v.props || {}).filter(([k, val]) => k !== 'children' && val && typeof val === 'object')
    .map(([, val]) => textOf(val)).join('') + textOf(v.props?.children);
};
const buttons = (tree) => nodes(tree).filter((n) => n.type === 'button')
  .map((n) => ({ props: n.props, onClick: n.props.onClick, text: textOf(n.props.children).replace(/\s+/g, ' ').trim() }));
const byAttr = (tree, name) => nodes(tree).find((n) => n.props?.[name] != null) || null;
const hasClass = (v, c) => typeof v?.props?.class === 'string' && v.props.class.split(/\s+/).includes(c);

const MSG = (from, text, at, name) => ({ from, text, at, name: name || from });
const BASE = {
  selfId: 'me', onToggle: () => {}, onDraft: () => {}, onSend: () => {}, onDragStart: () => {},
};

describe('聊天面板：收起态（用户口径「收起时上面会弹红点以表示有新消息」）', () => {
  test('收起 ⇒ **只剩一个把手**；没有新消息时**没有红点**', () => {
    const tree = ChatPanel({ ...BASE, messages: [MSG('me', '早', 1000)], collapsed: true, unread: 0, canSpeak: true });
    assert.equal(hasClass(tree, 'is-collapsed'), true);
    assert.equal(byAttr(tree, 'data-chat-list'), null, '收起时不该渲染消息列表');
    assert.equal(byAttr(tree, 'data-chat-unread'), null, '未读 0 ⇒ 不弹红点');
    assert.equal(buttons(tree).length, 1, '只留一个把手');
  });

  test('🔴 收起 + 有新消息 ⇒ 把手上有红点，且带**条数**', () => {
    const tree = ChatPanel({ ...BASE, messages: [], collapsed: true, unread: 3, canSpeak: true });
    const dot = byAttr(tree, 'data-chat-unread');
    assert.ok(dot, '必须有红点节点');
    assert.equal(dot.props['data-chat-unread'], '3');
    assert.equal(hasClass(dot, 'sp-chat__dot'), true);
  });

  test('点把手 ⇒ `onToggle()`（展开）', () => {
    const seen = [];
    const tree = ChatPanel({ ...BASE, messages: [], collapsed: true, unread: 1, canSpeak: true, onToggle: () => seen.push('t') });
    buttons(tree)[0].onClick();
    assert.deepEqual(seen, ['t']);
  });
});

describe('聊天面板：展开态（消息、自己/别人、时间）', () => {
  test('消息按给定顺序渲染，`data-chat-mine` 区分自己/别人', () => {
    const tree = ChatPanel({ ...BASE, messages: [MSG('a', '别人说的', 1000, '甲'), MSG('me', '我说的', 2000)], collapsed: false, canSpeak: true });
    const rows = nodes(tree).filter((n) => n.props?.['data-chat-msg'] != null);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].props['data-chat-mine'], 'false');
    assert.equal(rows[1].props['data-chat-mine'], 'true');
    assert.match(textOf(rows[0]), /别人说的/);
    assert.match(textOf(rows[1]), /我说的/);
    assert.match(textOf(rows[0]), /甲/, '显示昵称');
    assert.match(textOf(rows[1]), /我/, '自己显示"我"');
    assert.match(textOf(rows[0]), /\d\d:\d\d/, '带本地时间');
  });

  test('没有消息时给一句空态（不是空白面板）', () => {
    const tree = ChatPanel({ ...BASE, messages: [], collapsed: false, canSpeak: true });
    assert.match(textOf(tree), /还没有人说话/);
  });

  test('点「收起」⇒ `onToggle()`', () => {
    const seen = [];
    const tree = ChatPanel({ ...BASE, messages: [], collapsed: false, canSpeak: true, onToggle: () => seen.push('t') });
    buttons(tree).find((b) => b.props['data-chat-toggle']).onClick();
    assert.deepEqual(seen, ['t']);
  });

  test('拖动把手存在，`onPointerDown` 交给父层（位置/夹取在 host 里）', () => {
    const seen = [];
    const tree = ChatPanel({ ...BASE, messages: [], collapsed: false, canSpeak: true, onDragStart: (e) => seen.push(e?.pointerId) });
    const grip = byAttr(tree, 'data-chat-drag');
    assert.ok(grip, '要有拖动把手');
    grip.props.onPointerDown({ pointerId: 7 });
    assert.deepEqual(seen, [7]);
  });
});

describe('聊天面板：权限与降级（用户口径「观战者不可发言」/ 旧服务端优雅降级）', () => {
  test('🔴 纯观战（canSpeak=false）⇒ 禁言提示 + 发送按钮 disabled', () => {
    const tree = ChatPanel({ ...BASE, messages: [], collapsed: false, canSpeak: false, draft: '想说' });
    assert.ok(byAttr(tree, 'data-chat-readonly'), '要有"观战中只能看"的说明');
    assert.equal(byAttr(tree, 'data-chat-send').props.disabled, true, '按了也不该发出去');
  });

  test('🔴 旧服务端（unsupported）⇒ 说"当前服务器不支持聊天"，且**不再显示禁言文案**、发送 disabled', () => {
    const tree = ChatPanel({ ...BASE, messages: [], collapsed: false, canSpeak: true, unsupported: true, draft: 'hi' });
    assert.ok(byAttr(tree, 'data-chat-unsupported'));
    assert.equal(byAttr(tree, 'data-chat-readonly'), null, '两种说明互斥（降级优先）');
    assert.equal(byAttr(tree, 'data-chat-send').props.disabled, true);
  });

  test('可以发言 + 草稿非空 ⇒ 发送可用，点了调 `onSend()`', () => {
    const seen = [];
    const tree = ChatPanel({ ...BASE, messages: [], collapsed: false, canSpeak: true, draft: '你好', onSend: () => seen.push('s') });
    const send = byAttr(tree, 'data-chat-send');
    assert.equal(send.props.disabled, false);
    send.props.onClick();
    assert.deepEqual(seen, ['s']);
  });

  test('草稿是空白（空格/全角空格）⇒ 发送不可用（别把空消息发出去）', () => {
    const tree = ChatPanel({ ...BASE, messages: [], collapsed: false, canSpeak: true, draft: '   ' });
    assert.equal(byAttr(tree, 'data-chat-send').props.disabled, true);
  });

  test('输入框：`onInput` 交上来的草稿**已经按 120 码点截断**（双保险，服务端还会再截）', () => {
    const got = [];
    const tree = ChatPanel({ ...BASE, messages: [], collapsed: false, canSpeak: true, onDraft: (v) => got.push(v) });
    const field = nodes(tree).find((n) => typeof n.props?.onInput === 'function');
    assert.ok(field, '要有输入框');
    field.props.onInput('🎯'.repeat(200));
    assert.equal(Array.from(got[0]).length, CHAT_MAX_CODEPOINTS);
    assert.equal(got[0].includes('\uFFFD'), false, '不能把 emoji 切成半个');
  });

  test('禁用时输入框也 disabled（观战/降级两种情形都盖上）', () => {
    const a = nodes(ChatPanel({ ...BASE, messages: [], collapsed: false, canSpeak: false })).find((n) => typeof n.props?.onInput === 'function');
    const b = nodes(ChatPanel({ ...BASE, messages: [], collapsed: false, canSpeak: true, unsupported: true })).find((n) => typeof n.props?.onInput === 'function');
    assert.equal(a.props.disabled, true);
    assert.equal(b.props.disabled, true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 🆕 2026-10-08（B12，C 派工 B-C1/B-C2）：**快捷短语行 / 房主开关 / 个人屏蔽 / 带参选择器**的 DOM 级判据。
// 为什么必须补这一层：模型级判据（`quick-chat.test.js`）**证明不了"面板真的把它们画出来了"** ——
// 用户实测「一个功能都没有出现」时，缺的正是这一层（`AGENTS §三`：文件里写着 `onClick` 证明不了点下去会发生什么）。
describe('🆕 快捷短语（用户 2026-10-08：「像表情一样弹出」⇒ 短语已**移出聊天面板**）', () => {
  test('🔴 聊天面板里**不再有**短语行/选择器（两个入口＝迟早分叉，用户当场裁定删掉）', () => {
    const tree = ChatPanel({ ...BASE, messages: [], canSpeak: true, chatMode: 'open' });
    assert.equal(byAttr(tree, 'data-chat-quick'), null, '短语行必须已经移出面板');
    assert.equal(byAttr(tree, 'data-chat-picker'), null, '选择器也移出面板');
    assert.equal(nodes(tree).filter((n) => n.props?.['data-chat-quick-btn'] != null).length, 0);
    // 负对照：面板"该有的"仍在（别把整块面板删了还说通过）
    assert.ok(byAttr(tree, 'data-chat-list'), '消息列表还在');
    assert.ok(byAttr(tree, 'data-chat-send'), '输入/发送还在');
  });

  test('🔴 `chatMode: \'quick\'` ⇒ 发送禁用 ＋ 出"房主关了打字"说明（短语请用**弹出面板**）', () => {
    const tree = ChatPanel({ ...BASE, messages: [], canSpeak: true, chatMode: 'quick' });
    assert.ok(byAttr(tree, 'data-chat-textoff'), '要有一句"房主已关闭本房的打字"的说明');
    assert.equal(byAttr(tree, 'data-chat-send').props.disabled, true, '打字关了 ⇒ 发送必须禁用');
    assert.equal(byAttr(tree, 'data-chat-quick'), null, '面板里没有短语行（那是弹出面板的事）');
  });

  test('房主开关：`canSwitch` 才渲染；点了调 `onSwitch(on)` —— 布尔方向由纯函数给（open ⇒ on:true）', () => {
    const off = ChatPanel({ ...BASE, messages: [], canSpeak: true, chatMode: 'open', canSwitch: false, onSwitch: () => {} });
    assert.equal(byAttr(off, 'data-chat-switch'), null, '非房主 / 已开局 ⇒ 不渲染开关');
    const calls = [];
    const on = ChatPanel({ ...BASE, messages: [], canSpeak: true, chatMode: 'open', canSwitch: true, onSwitch: (v) => calls.push(v) });
    const sw = byAttr(on, 'data-chat-switch');
    assert.ok(sw, '房主 ⇒ 渲染开关');
    sw.props.onClick();
    assert.deepEqual(calls, [true], '现在能打字 ⇒ 动作＝关闭打字 ⇒ 发 on:true');
    const calls2 = [];
    const q = ChatPanel({ ...BASE, messages: [], canSpeak: true, chatMode: 'quick', canSwitch: true, onSwitch: (v) => calls2.push(v) });
    byAttr(q, 'data-chat-switch').props.onClick();
    assert.deepEqual(calls2, [false], '现在只允许短语 ⇒ 动作＝开启打字 ⇒ on:false');
  });

  test('个人屏蔽：**别人的**消息带屏蔽按钮（点了带 from 回调）；自己的不带', () => {
    const calls = [];
    const tree = ChatPanel({ ...BASE, canSpeak: true, onToggleMute: (f) => calls.push(f),
      messages: [{ from: 'p2', name: '乙', text: 'hi', at: 1 }, { from: 'me', text: 'yo', at: 2 }] });
    const ms = nodes(tree).filter((n) => n.props?.['data-chat-mute'] != null);
    assert.equal(ms.length, 1, '只有别人那条有屏蔽按钮');
    assert.equal(ms[0].props['data-chat-mute'], 'p2');
    ms[0].props.onClick();
    assert.deepEqual(calls, ['p2']);
  });

  test('快捷消息（`quick.msg`）与文本消息**同一列表混排**，各按自己的形状渲染', () => {
    const tree = ChatPanel({ ...BASE, canSpeak: true, messages: [
      { from: 'p2', name: '乙', ids: ['sorry'], at: 1, kind: 'quick' },
      { from: 'p3', name: '丙', text: '打字消息', at: 2 },
    ] });
    const rows = nodes(tree).filter((n) => n.props?.['data-chat-kind'] != null);
    assert.deepEqual(rows.map((n) => n.props['data-chat-kind']), ['quick', 'text'], '两种来源各自标了 kind');
    assert.match(textOf(rows[0]), /对不起/, '短语按 i18n 渲染（不是把 id 印出来）');
    assert.match(textOf(rows[1]), /打字消息/);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 🆕 弹出面板 `ui/quickWheel.js`：**源码契约**（不是行为测试 —— 它有 hook，Node 里当函数调不了）。
// 为什么接受这一层：本仓对"带 hook 的组件"的既有处理就是"纯逻辑单测 + 源码契约"（见本文件顶部第 7-9 行）。
// 行为上的"能不能点/发什么"由**共用函数**的判据保证：`quick-chat.test.js` 的 `canSendQuickNow`/`quickMsgPayload`
// 与 `quickArgs.js` 那几条 —— 面板与浮层**问的是同一对函数**，所以这层契约只需钉"接线真的接上了"。
describe('🆕 短语 UI 的形状契约（**回退到初版**：聊天面板里那一排 ＋ 发送后头像旁气泡）', () => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const read = (p) => strip(readFileSync(new URL(p, import.meta.url), 'utf8'));

  test('🔴 短语那一排**在聊天面板里**（用户口径：「本身的快捷短语 UI 在初版就对了」）；底栏那个按钮已撤', () => {
    const cp = read('../../public/js/ui/chatPanel.js');
    assert.match(cp, /data-chat-quick>/, '那一排');
    assert.match(cp, /data-chat-quick-btn=/, '每条一个按钮');
    assert.match(cp, /data-chat-picker=/, '带参的展开候选项');
    assert.match(cp, /quickMsgPayload\(\[\{ id, arg \}\]\)/, '载荷走共用的那个函数');
    assert.match(cp, /canSendQuickNow\(p\.id\)/, '可用性＝共用判据');
    assert.match(cp, /quickSection=\$\{quickSection\}/, '插槽传进纯面板');
    // 🔴 顺序判据（2026-10-08 现场事故）：读 `canSpeak` 的东西必须在它**之后**求值 ——
    //    我把短语段插在 `canSpeak` 声明之前 ⇒ `Cannot access 'canSpeak' before initialization` ⇒ **整屏崩**。
    assert.ok(cp.indexOf('const canSpeak') < cp.indexOf('const quickSection = html'),
      '`quickSection` 求值必须在 `canSpeak` 声明之后（否则 TDZ 崩屏）');
    const g = read('../../public/js/screens/game.js');
    assert.equal(/QuickPhraseWheel/.test(g), false, '⛔ 底栏那个「快捷短语」按钮已撤（那是我折腾出来、用户没要的）');
  });

  test('🔴 发送后的表现＝**头像旁气泡**（与表情同一条管道、同一套"最近优先"）', () => {
    const w = read('../../public/js/ui/gameLogic/watch.js');
    assert.match(w, /export function activeBubbles\(emotes, now, ttl = 3000, quickMsgs = \[\]\)/, '短语进同一个函数');
    assert.match(w, /kind: 'quick'/, '标成短语气泡');
    const tp = read('../../public/js/ui/teamPanel.js');
    assert.match(tp, /bubble\.kind === 'quick'/, '头像旁按 kind 分别渲染');
    assert.match(tp, /quickTextOfMessage\(bubble\.msg/, '文案按各自语言算、并把 arg 翻成显示名（⛔ 数据里不存文案）');
    assert.match(tp, /argLabel\(kind, arg, \{ data, room \}\)/, '参数字符串要翻成显示名（用户实测：气泡里显示编号看不懂；队友名在座位表里 ⇒ 必须要 room）');
    assert.match(tp, /data-phrase-bubble/, '可判据的钩子');
    const g = read('../../public/js/screens/game.js');
    assert.match(g, /activeBubbles\(emotes, Date\.now\(\), bubbleMs, chatQuick\)/, 'game.js 把短语消息传进同一条管道');
  });
});
