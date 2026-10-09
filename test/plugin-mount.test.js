// test/plugin-mount.test.js —— **「插件载荷挂载」验收闸**（第 8 任 B，2026-10-07）
//
// 用途（用户 2026-10-07 口径：**「我们现在确实是在重复劳动……只做插件就好」**）：
//   换基座到上游 **0.2.0** 时，用它判「**我们自己的插件是不是真的挂上了**」。
//   三个阶段它应该分别是：
//     · **现在的 0.1.3 树** ⇒ **绿**（我们的插件本来就在，这是"起点由绿"的证明）
//     · **刚把 0.2.0 铺成工作树** ⇒ **红**（上游没有这些功能；**红就是"该挂的还没挂"的证据**，不是回归）
//     · **按施工单重挂完** ⇒ 应当转绿
//   ⇒ 所以它是**基座切换的验收闸**，不是"0.1.3 的回归闸"。
//
// 依据：`协作/B-插件载荷-施工单-2026-10-07.md`（挂载点逐一给了 `0.2.0 的 文件:行`；只读子代理调研 + B 抽查 5 处）。
//
// ⚠️ 两条手法上的纪律（本仓踩过两次）：
//   ① **源码断言必须先剥注释** —— 这些名字在注释里本来就写着（不剥必然假绿）；
//   ② 断言打在**"人真的会走的那一跳"**上（协议表 / 事件名 / 白名单），不是"文件里出现过这个词"。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ⚠️ 本文件在 `test/`（**一层深**）⇒ ROOT 是 `..`。
//    （我第一版抄了 `test/ui/` 两层深的写法（`../..`）⇒ 所有路径都指向**工作区根**、不是树 ⇒ 一组组假红。
//      这正是"判据必须真跑一遍才敢信"的又一例：写的时候完全看不出来。）
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = (rel) => path.join(ROOT, rel);
const has = (rel) => existsSync(P(rel));
const raw = (rel) => (has(rel) ? readFileSync(P(rel), 'utf8') : '');
/** 剥掉 `//` 与块注释 —— **不剥注释的源码断言必然假绿**（注释里本来就写着这些名字）。 */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
const src = (rel) => strip(raw(rel));

describe('插件载荷 ①：我方功能面文件在位', () => {
  const FILES = [
    'public/js/ui/chatModel.js', 'public/js/ui/chatPanel.js', 'public/css/chat.css',
    'public/js/ui/serverLink.js', 'public/js/ui/lanPanel.js', 'public/js/ui/serverStatus.js', 'public/js/ui/serverStatusPill.js',
    'public/js/ui/titlePanels.js', 'public/js/ui/announcementData.js', 'public/js/screens/battleFrames.js',
    'server/ops.js', 'server/stats.js',
  ];
  test(`${FILES.length} 个插件文件都在`, () => {
    const miss = FILES.filter((f) => !has(f));
    assert.deepEqual(miss, [], `缺这些插件文件（换基座后应先重挂它们）：${miss.join('、')}`);
  });
});

describe('插件载荷 ②：房间聊天在【服务端协议与大厅】上真的挂着', () => {
  test('`shared/protocol.js` 里有聊天类型（C2S）', () => {
    const s = src('shared/protocol.js');
    assert.match(s, /room\.chat|C2S_CHAT|'chat'/, '协议表里没有聊天消息类型 ⇒ 客户端发了服务端也不认');
  });
  test('大厅真的处理了聊天消息（不是只在协议表里挂个名）', () => {
    const s = src('server/lobby.js');
    assert.match(s, /room\.chat/, '`server/lobby.js` 里没有 room.chat 的处理分支 ⇒ 消息会被丢掉');
  });
});

describe('插件载荷 ③：客户端真的能发收聊天（**挂载点以实现为准，不是以我猜的为准**）', () => {
  // 🔴 我第一版把这条断言写成「`net.js` 里有聊天发送路径」⇒ **冤枉了实现**。实测（2026-10-07 17:0x）：
  //    真正的发送点是 `public/js/ui/chatPanel.js:147` 的 `net.request('room.chat', { text })`；
  //    收在 `public/js/main.js:245`（`chat.msg`）与 `:250`（`chat.history`，重连补发）；
  //    状态在 `public/js/store.js:84`。
  //    而 `net.js` 是**通用传输层** ⇒ **它本来就不该有聊天专有代码**（那是正确设计，不是缺口）。
  //    ⇒ 教训：**源码断言的挂载点必须读实现再写**（与上一任"拿 `kind:'terrain'` grep JSDoc 冤枉实现"同族）。
  test('发送点：`ui/chatPanel.js` 真的 `net.request(\'room.chat\', …)`', () => {
    assert.match(src('public/js/ui/chatPanel.js'), /net\.request\(\s*'room\.chat'/,
      '聊天面板里没有 `net.request(\'room.chat\')` ⇒ 客户端发不出去');
  });
  test('接收点：`main.js` 订阅了 `chat.msg` 与 `chat.history`（重连补发）', () => {
    const s = src('public/js/main.js');
    assert.match(s, /chat\.msg/, '`main.js` 没订阅 `chat.msg` ⇒ 收到的消息进不了界面');
    assert.match(s, /chat\.history/, '没订阅 `chat.history` ⇒ 重连/重进房间看不到之前的消息');
  });
  test('状态：`store.js` 里有聊天状态', () => {
    assert.match(src('public/js/store.js'), /chat/i, '`store.js` 里没有聊天状态 ⇒ 界面无源可渲染');
  });
  test('聊天面板被真正的屏幕引用（挂载点，不是孤立组件）', () => {
    const hit = ['public/js/screens/room.js', 'public/js/screens/game.js', 'public/js/screens/lobby.js']
      .filter(has).some((f) => /chatPanel|ChatPanel/.test(src(f)));
    assert.ok(hit, '没有任何屏幕引用 ChatPanel ⇒ 组件在但没人挂它');
  });
});

describe('插件载荷 ④：望的跟子标记 —— **三处必须同时挂**（少一处就是静默空转）', () => {
  test('① `ui/fieldHost.js` 的 OPTIONAL 白名单里有 `setWangMarks`', () => {
    assert.match(src('public/js/ui/fieldHost.js'), /setWangMarks/,
      '`guardView` 白名单里没有它 ⇒ 调用会被静默吞掉（这正是"幽灵棋子"那类事故的形状）');
  });
  test('② `render/app.js` 里有 `setWangMarks` 的实现', () => {
    assert.match(src('public/js/render/app.js'), /setWangMarks/, '引擎侧没有实现 ⇒ 传了也没用');
  });
  test('③ `screens/battleFrames.js` 真的调它', () => {
    assert.match(src('public/js/screens/battleFrames.js'), /setWangMarks/, '没人调它 ⇒ 前两处白挂');
  });
});

describe('插件载荷 ⑤：标题页侧栏（更新公告 / 特别鸣谢）挂在 title 上', () => {
  test('`screens/title.js` 引用了 `TitlePanels`', () => {
    assert.match(src('public/js/screens/title.js'), /TitlePanels/, '标题页没有引用它 ⇒ 面板不会出现');
  });
  test('署名写法没被改坏（`AGENTS §十.1` 的常设规矩）', () => {
    const s = raw('public/js/ui/titlePanels.js');
    assert.match(s, /Ausevay/, '原作者署名必须是 `Ausevay`（用户 2026-10-06 定的唯一写法）');
    assert.match(s, /各位服务器作者/, '服务器作者必须写成「各位服务器作者」（不许编名字）');
  });
});

// ⚠️ 口径更正（2026-10-07 21:4x，权威落点 = `协作/C-待用户拍板-清单-2026-10-07.md` §1 的 **U-2**）：
//   **用户拍的是 (A) —— 保留我们的【运行期】换装（`room.skins`），不采用上游的 `FaceSwitcher`（编译期）。**
//   （此前这一组写的是"走上游 FaceSwitcher" —— 那是**相反的**一条，已按 C 的《三条纠正与退役口径》§4 清掉。
//     这是**第二次确认**：20:5x 那次也是 (A)。）
// ⚠️ **本组只断言"已在树里"的那一半**；运行期换装的**界面那一半**（`loadout.js` 的 `SkinSection` 等）
//    尚未重挂（派工 **B-4.5**）⇒ **它不在本组断言里，别把本组的绿读成"换装整条链都挂上了"**。
describe('插件载荷 ⑥：皮肤/换装的挂载（✅ 口径 = 我们的运行期换装 `room.skins`）', () => {
  test('我方换装文件仍在', () => {
    const miss = ['public/js/ui/skins.js', 'public/js/ui/skinPicker.js', 'data/skins.json'].filter((f) => !has(f));
    assert.deepEqual(miss, [], `缺：${miss.join('、')}`);
  });
  test('运行期协议那一半真的在：`shared/protocol.js` 的 `room.skins` 与它的结构校验', () => {
    const s = src('shared/protocol.js');
    assert.match(s, /SKIN_LIMITS/, '协议层没有 SKIN_LIMITS ⇒ 皮肤选择会被当非法消息拒掉');
    assert.match(s, /isSkinSelection/, '没有 isSkinSelection ⇒ room.skins 没有结构校验');
    assert.match(s, /'room\.skins'/, "C2S 表里没有 'room.skins' ⇒ 客户端发了服务端不认");
  });
  test('运行期数据那一半真的在：`data/skins.json` 能被客户端的数据层加载', () => {
    // 皮肤目录是生成产物（tools/build-skins.mjs），这里只钉"它在、且 data.js 认得它"
    assert.ok(has('data/skins.json'), 'data/skins.json 不在 ⇒ 换装列表无源可列');
    assert.match(src('public/js/data.js'), /skins/, 'data.js 的 DATA_FILES 里没有 skins ⇒ 目录不会被加载');
  });
});
