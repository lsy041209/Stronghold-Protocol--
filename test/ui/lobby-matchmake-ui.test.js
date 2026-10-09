// test/ui/lobby-matchmake-ui.test.js — 野排「快速匹配」的**客户端入口**（C 派工 T6，2026-10-08 第 10 任 B）
//
// 为什么要有这个文件（它守的是一个**真实发生过的丢失**）：
//   换基座到上游 0.2.1 后，**整个野排客户端入口被冲掉** —— 服务端 `server/lobby.js` 全在、判据 8/8 绿，
//   而 `public/js` 里 `matchmake|快速匹配|野排` **0 命中**（C 10-08 12:4x 实测）。
//   更糟的是：`patch-game.mjs` 里 `public/js/screens/lobby.js` 的 marks 当时**只钉"加入同盟 / invite link"**
//   ⇒ 这个功能消失时**一条 mark 都没红（假绿）**。本轮已补 marks（见 patch-game.mjs 该条目）。
//
// 本文件钉"**人要走的那些跳**"（按钮 → matchmake → room.matchmake → 服务端有处理）：
//   ⚠️ **它是【源码级接线断言】**（比真跑弱，与仓内既有"接线层弱断言"同一约定）。
//   **强形式**是 C 判据 2 的双浏览器 e2e（点一次 ⇒ 两人同房 ⇒ matchmakeFillMs 到期真开局）—— 另立。
//   📌 但它**能红**：在本次重挂之前跑，第 1、2、5 条都会红（当时文件里 0 处 matchmake）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

const LOBBY = read('public/js/screens/lobby.js');

test('① 入口存在：coop 下的「快速匹配」按钮，onClick 指向 matchmake（不是沉默的死按钮）', () => {
  assert.match(
    LOBBY,
    /const matchmake = \(\) => run\('matchmake', \(\) => net\.request\('room\.matchmake', \{ difficulty \}\)\);/,
    'matchmake 必须发 room.matchmake { difficulty }（复用 server/lobby.js 的 matchmake 形状，不新造协议）',
  );
  assert.match(LOBBY, /onClick=\$\{matchmake\}/, '按钮的 onClick 必须是 matchmake');
  assert.match(LOBBY, /loading=\$\{busy === 'matchmake'\}/, '按钮要有 loading 态（busy === matchmake）');
  // 按钮文案走 i18n（中文是 msgid；树的约定）
  assert.match(LOBBY, /\$\{t\('快速匹配'\)\}/, '按钮文案要 t(\'快速匹配\')');
  assert.match(LOBBY, /t\('同难度自动组队 · 满 \{max\} 人开局', \{ max: MAX_SEATS \}\)/, '提示文案要带 MAX_SEATS 参数');
});

test('② 只在 coop 显示（solo 没有"组队"一说，服务端也只往 coop 房放人）', () => {
  const gate = LOBBY.indexOf("${roomMode === 'coop' ? html`<${Tooltip}");
  const btn = LOBBY.indexOf('onClick=${matchmake}');
  assert.ok(gate > 0, '必须有 coop 门控');
  assert.ok(btn > gate, '按钮必须在 coop 门控之内（否则 solo 也会露出来）');
  // 门控要闭合在这一段里（⚠️ 窗口要够大：这一段实际约 640 字符，我第一版写 400 ⇒ 误报）
  assert.match(LOBBY.slice(gate, gate + 1000), /: null\}/, 'coop 门控要闭合（`: null}`）');
});

test('③ 失败不沉默（C 判据 1 的负对照）：未连接 ⇒ 可读提示；服务端拒绝 ⇒ toastError', () => {
  // run() 是所有 lobby 请求（含 matchmake）的唯一入口 ⇒ 它的两条兜底就是负对照
  assert.match(LOBBY, /if \(!online\) \{ toast\(t\('尚未连接到服务器，请稍候'\), 'warn'\); return; \}/, '离线时必须给可读提示');
  assert.match(LOBBY, /catch \(err\) \{ toastError\(err\); \}/, '请求被拒时必须 toastError（不是静默什么都不发生）');
  assert.match(LOBBY, /const matchmake = \(\) => run\('matchmake'/, 'matchmake 必须走 run()（才拿得到上面两条兜底）');
});

test('④ 消息对得上真协议与服务端（客户端发的帧，服务端真的收）', () => {
  const proto = read('shared/protocol.js');
  assert.match(proto, /'room\.matchmake'/, "shared/protocol.js 的 C2S 必须有 'room.matchmake'");
  const server = read('server/lobby.js');
  assert.match(server, /room\.matchmake|matchmake\(session/, 'server/lobby.js 必须有处理（服务端早已落地）');
});

test('⑤ 反例哨兵：本文件守的那些串，不许只出现在注释里', () => {
  // 把注释行去掉再断言一次 —— 否则"注释里写了"就能糊弄过去（本仓踩过：mark 钉在注释上）
  const code = LOBBY.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.match(code, /net\.request\('room\.matchmake'/, 'room.matchmake 必须出现在【代码】里，不是注释里');
  assert.match(code, /onClick=\$\{matchmake\}/, 'onClick 必须出现在【代码】里');
});
