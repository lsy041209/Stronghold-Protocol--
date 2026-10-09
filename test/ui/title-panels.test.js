// 登录页右侧的两个面板 —— 「更新公告」与「特别鸣谢」（**W-5**，`协作/C-工作分派-总表-2026-10-07.md` §2）。
//
// 需求原文（C 的总表 + `协作/C-特别鸣谢-服务器与B站-2026-10-06.md` §三）：
//   ① 做成**可点开的面板**，放**登录页右侧空白处**；② **每行的链接都能点开（真 `<a>`）且新窗口**（别把游戏顶掉）；
//   ③ **窄屏（720P / 450px）不溢出**；④ **离线/无网也不报错**；⑤ **面板可关闭**，且**不影响登录**；
//   ⑥ **没有链接的条目就写纯文本** —— 名字与链接**不许凭印象写**，待确认的拼写不落死。
//
// 这些判据绝大部分**不需要浏览器**（唯一需要真浏览器的那条在 `title-panels.e2e.test.js`），所以本文件是
// 面板形状、数据来源与 CSS 兜底的守卫。
//
// 一个具体教训（本文件的第 ⑩ 条就是为它立的）：`theme.css:270` 早就写过
// 「**带 transform 的元素会成为 `position: fixed` 后代的包含块**」，我第一版 CSS 恰好把 `translateY(-50%)`
// 挂在 `.title-side` 上 ⇒ 浮层会被困在侧栏那个小盒子里，而不是铺满视口。这条判据就是防它回来。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../helpers/proc.js';
import { PANELS, CREDITS_TOP, CREDITS_REFS, CREDITS_LINE } from '../../public/js/ui/titlePanels.js';
import { ANNOUNCEMENTS, ANNOUNCEMENT_SOURCE } from '../../public/js/ui/announcementData.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

const PANEL_JS = read('public/js/ui/titlePanels.js');
const NEWS_JS = read('public/js/ui/announcementData.js');
const TITLE_JS = read('public/js/screens/title.js');
const TITLE_CSS = read('public/css/screens/title.css');

/** 取某个 CSS 选择器的规则体（用于「这一块里不许有 transform」这种断言）。 */
function ruleBody(css, selector) {
  const at = css.indexOf(`\n${selector} {`);
  assert.notEqual(at, -1, `CSS 里找不到 ${selector} 的规则体`);
  const end = css.indexOf('}', at);
  return css.slice(at, end);
}

test('面板清单：两个面板、顺序即右侧出现顺序', () => {
  assert.deepEqual(PANELS.map((p) => p.id), ['news', 'credits']);
  assert.deepEqual(PANELS.map((p) => p.label), ['更新公告', '特别鸣谢']);
  for (const p of PANELS) assert.match(p.micro, /^[A-Z ]+$/, `${p.id} 的 micro 文案`);
});

test('置顶：原作者 Ausevay 在最上，其次纸鸢安好（含两个服务器链接）', () => {
  assert.equal(CREDITS_TOP[0].name, 'Ausevay', '用户 00:2x 定的顺序：原作者在最上');
  assert.equal(CREDITS_TOP[0].role, '原作者');
  // 原作者没有公开服务器/主页可挂 ⇒ **刻意留空**，不是漏了（不许替他编一个 URL）
  assert.deepEqual(CREDITS_TOP[0].links, [], 'Ausevay 那条不许有链接（没有可信来源）');

  assert.equal(CREDITS_TOP[1].name, '纸鸢安好');
  assert.deepEqual(CREDITS_TOP[1].links.map((l) => l.url),
    ['http://106.55.191.70:3000', 'http://101.37.150.107:3000'], '一服 / 二服');
  assert.match(CREDITS_TOP[1].note, /皮肤|语音|安卓/, '要写明本项目从哪里来');
});

test('学习参考：8 条、名字与链接逐条照抄权威表（不许凭印象）', () => {
  // 这 8 条的名字与 URL 逐字来自 协作/C-特别鸣谢-服务器与B站-2026-10-06.md §二。
  const EXPECTED = [
    ['临夏俨然', 'https://wei.linxia.dev'],
    ['鹿可可 Official', 'https://game.xiaolubao.com'],
    ['雨方_', 'https://game.rainya.me/'],
    ['d星空之下', 'http://183.66.27.19:20522'],
    ['Stardust_减', 'https://ark-proto.stardust.matce.cn'],
    ['Crane_paul', 'https://game.craneapaul.dpdns.org/'],
    ['涂涂小弟047', null],
    ['各位服务器作者', 'http://play.simpfun.cn:14517'],
  ];
  assert.equal(CREDITS_REFS.length, EXPECTED.length, '条数');
  EXPECTED.forEach(([name, url], i) => {
    const e = CREDITS_REFS[i];
    assert.equal(e.name, name, `第 ${i + 1} 条的名字`);
    assert.equal(e.links.length, url ? 1 : 0, `${name} 的链接数`);
    if (url) assert.equal(e.links[0].url, url, `${name} 的 URL 必须逐字一致`);
    for (const l of e.links) assert.match(l.url, /^https?:\/\//, `${name} 只许 http(s)`);
  });
});

test('没有链接的条目写纯文本；已关服的照常留名并标注', () => {
  const tutu = CREDITS_REFS.find((e) => e.name === '涂涂小弟047');
  assert.deepEqual(tutu.links, [], '涂涂小弟047 无公开网址 ⇒ 纯文本');
  assert.match(tutu.note, /421345512/, 'Q 群号要写出来');

  const crane = CREDITS_REFS.find((e) => e.name === 'Crane_paul');
  assert.ok(crane, '⚠️ Crane_paul 已关服但**不许删**（他做过电脑+安卓全屏适配）');
  assert.equal(crane.down, true, '要标成「暂不可用」，而不是悄悄留着或删掉');

  assert.match(CREDITS_LINE, /本页网站均可匹配/, '截图里那句说明句');
});

test('待确认的拼写不许落死（表里不能出现占位/待定标记）', () => {
  const all = [...CREDITS_TOP, ...CREDITS_REFS];
  for (const e of all) {
    const blob = [e.name, e.role, e.bili, e.note, ...e.links.map((l) => `${l.label || ''}${l.url}`)].join(' ');
    assert.doesNotMatch(blob, /待确认|待定|TODO|TBD|占位|xxx|\?\?\?/i, `${e.name} 里还有待确认标记`);
  }
});

test('渲染层：每条链接都是真 <a>，新窗口打开，且带 rel=noopener', () => {
  assert.match(PANEL_JS, /href=\$\{l\.url\}/, '链接要由数据驱动（不是把 URL 抄进模板）');
  // ⚠️ 断言必须**锚在同一个 `<a …>` 标签内**（`[^>]*` 不许跨过 `>`）：本文件头部注释里也写着 `target="_blank"`，
  //    只匹配整份源码的话，**注释就能把这条判据喂饱** —— 那正是 10-05「src 存在、但图没解码出来」那类假绿。
  //    （这条是探针 `probe-title-panels-can-fail.mjs` 抓出来的：它第一版只改注释处，判据照绿。）
  assert.match(PANEL_JS, /href=\$\{l\.url\}[^>]*\btarget="_blank"/, '必须新窗口 —— 否则会把游戏页面顶掉');
  assert.match(PANEL_JS, /href=\$\{l\.url\}[^>]*\brel="noopener noreferrer"/);
  assert.match(PANEL_JS, /<a key=\$\{i\}[^>]*href=/, '必须是真锚点，不是纯文本也不是 span');
  // 没有链接的条目应当整体不渲染这个块（否则会出现一个空的 <a>）
  assert.match(PANEL_JS, /if \(!links \|\| !links\.length\) return null;/);
});

test('离线安全：面板模块自己不发任何请求', () => {
  for (const [name, src] of [['titlePanels.js', PANEL_JS], ['announcementData.js', NEWS_JS]]) {
    assert.doesNotMatch(src, /\bfetch\s*\(/, `${name} 不许 fetch`);
    assert.doesNotMatch(src, /XMLHttpRequest/, `${name} 不许 XHR`);
    assert.doesNotMatch(src, /new\s+Image\s*\(/, `${name} 不许 new Image`);
    assert.doesNotMatch(src, /await\s+import\s*\(/, `${name} 不许动态 import（会多一条网络路径）`);
  }
  assert.equal(ANNOUNCEMENT_SOURCE, 'CHANGELOG.md', '公告的事实源只能是仓库里的 CHANGELOG.md');
});

test('面板可关闭：× 按钮 / Esc / 点背景 三条路都在', () => {
  assert.match(PANEL_JS, /aria-label="关闭"/);
  assert.match(PANEL_JS, /'Escape'/);
  assert.match(PANEL_JS, /onMouseDown=/, '点背景关闭');
  assert.match(PANEL_JS, /role="dialog"/);
  assert.match(PANEL_JS, /aria-modal="true"/);
});

test('title.js 真的把面板挂上了（否则整个功能静默消失）', () => {
  assert.match(TITLE_JS, /from '\.\.\/ui\/titlePanels\.js'/, '要 import');
  assert.match(TITLE_JS, /<\$\{TitlePanels\} \/>/, '要渲染');
  // 窄屏兜底把它收成一行，所以它必须是 title-screen 的直接子节点（在 main 之外）
  const mainEnd = TITLE_JS.indexOf('</main>');
  assert.ok(TITLE_JS.indexOf('<${TitlePanels} />') > mainEnd, '面板要挂在 main 之外');
});

test('公告数据：非空、结构对、且没有 markdown 残留', () => {
  assert.ok(ANNOUNCEMENTS.length >= 1, '至少一个版本');
  for (const v of ANNOUNCEMENTS) {
    assert.match(v.version, /^\d+\.\d+/, `版本号形状：${v.version}`);
    assert.ok(v.sections.length >= 1, `v${v.version} 至少一节`);
    for (const s of v.sections) {
      assert.ok(s.items.length >= 1, `v${v.version}/${s.name} 至少一条`);
      for (const it of s.items) {
        assert.equal(typeof it, 'string');
        assert.ok(it.trim().length > 0);
        // 生成器要把 markdown 剥干净 —— 面板按纯文本渲染，留着 `**` / 反引号会被玩家原样看到
        assert.doesNotMatch(it, /\*\*|`|~~|\]\(/, `markdown 残留：${it.slice(0, 40)}`);
        assert.ok(!it.startsWith('#'), `标题残留：${it.slice(0, 40)}`);
      }
    }
  }
});

test('公告生成物与 CHANGELOG.md 同步（改了 CHANGELOG 忘了重跑 ⇒ 这里红）', async () => {
  const r = await run(process.execPath, [path.join(ROOT, 'tools/build-announcements.mjs'), '--check'], { cwd: ROOT });
  assert.equal(r.status, 0, `生成物过期或被手改。输出：\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /一致/);
});

test('CSS：侧栏上不许有 transform（否则 fixed 浮层会被困在侧栏里）', () => {
  const side = ruleBody(TITLE_CSS, '.title-side');
  assert.doesNotMatch(side, /transform\s*:/,
    '.title-side 带 transform 会成为 position:fixed 后代的包含块 —— 居中用的 translate 只能挂在内层 .title-side__btns 上');
  assert.match(ruleBody(TITLE_CSS, '.title-side__btns'), /transform\s*:\s*translateY\(-50%\)/, '居中在内层做');
  assert.match(ruleBody(TITLE_CSS, '.tpanel'), /position\s*:\s*fixed/);
});

test('CSS：窄屏 / 矮屏兜底（铺满整行居中 + 浮层自身可滚 + 长 URL 能断行）', () => {
  assert.match(TITLE_CSS, /@media \(max-width: 900px\), \(max-height: 560px\)/, '窄屏与矮屏都要覆盖');
  const narrow = TITLE_CSS.slice(TITLE_CSS.indexOf('@media (max-width: 900px)'));
  assert.match(narrow, /\.title-side \{[^}]*left:\s*0;\s*right:\s*0;/, '侧栏要铺满整行（结构上不可能横向溢出）');
  assert.match(narrow, /flex-wrap:\s*wrap/, '允许折行');
  assert.match(ruleBody(TITLE_CSS, '.tpanel__body'), /overflow:\s*auto/, '内容再长也是浮层自己滚，不推页面');
  assert.match(ruleBody(TITLE_CSS, '.tpanel__linktext'), /overflow-wrap:\s*anywhere/,
    '长 URL 是浮层里唯一能横向溢出的东西，必须能断行');
});
