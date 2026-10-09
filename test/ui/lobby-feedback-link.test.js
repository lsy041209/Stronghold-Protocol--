// test/ui/lobby-feedback-link.test.js — 大厅顶栏的「反馈」外链（用户 2026-10-08 指定）
//
// ## 为什么需要一条判据
// 用户原话：「在大厅里面找个位置附带上链接 …… 这是反馈的共享文档。直接将其做成『反馈』两个字的超链接就好」。
// 这个链接的价值**全在"玩家看得见、点得到"**上 —— 而本仓最贵的教训正是「**静默回退**」：
// 换基座/重挂时，一个 `public/js` 里的按钮可以**整块消失，而没有任何闸会红**（T6 的野排入口就是这么丢的）。
// ⇒ 所以这里钉三件事：**① 链接在（不是只写在注释里）② 地址是那份共享文档 ③ 外链的安全属性齐全**。
//
// ## 判据形状（每一态都能红）
//   ① 大厅源码里有一个**真 `<a>`**，`data-testid="feedback-link"` ＋ `href=${FEEDBACK_URL}`（不是死按钮）
//   ② `FEEDBACK_URL` 导出的就是用户给的那份腾讯文档地址（**逐字**）
//   ③ 外链三件套：`target="_blank"` ＋ `rel` 含 `noopener` 与 `noreferrer`（与 `ui/titlePanels.js` 同一套纪律）
//   ④ **反例哨兵**：这些串不许只出现在注释里（注释里提"反馈"不算实现）
//
// ## 阴性对照（证明它会红）
//   把 `lobby.js` 里那个 `<a …feedback-link…>` 删掉 ⇒ ① 立刻红；
//   把 `FEEDBACK_URL` 改成别的地址 ⇒ ② 立刻红。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const LOBBY = 'public/js/screens/lobby.js';

/** 用户给的那份共享文档地址（**逐字**，来自用户 2026-10-08 的消息）。 */
const EXPECTED = 'https://docs.qq.com/sheet/DWnhmR3Nya0dhSGJB?tab=BB08J2&scode=';

/** 注释里出现这些词**不算实现** ⇒ 反例哨兵要把注释行去掉再找。 */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

test('① 大厅里有真 `<a data-testid="feedback-link">`，且 href 指向 FEEDBACK_URL（不是死按钮）', () => {
  const src = read(LOBBY);
  assert.match(src, /data-testid="feedback-link"/, '找不到反馈链接的 testid');
  const anchor = src.match(/<a\b[^>]*data-testid="feedback-link"[^>]*>/);
  assert.ok(anchor, '`data-testid="feedback-link"` 必须落在一个真 `<a>` 上');
  assert.match(anchor[0], /href=\$\{FEEDBACK_URL\}/, '这个 `<a>` 的 href 必须用导出的 FEEDBACK_URL（别写死第二份地址）');
});

test('② `FEEDBACK_URL` 就是用户给的那份共享文档（逐字）', async () => {
  const mod = await import('../../public/js/screens/lobby.js');
  assert.equal(mod.FEEDBACK_URL, EXPECTED, '`FEEDBACK_URL` 与用户给的地址不一致');
});

test('③ 外链三件套齐全（新窗口打开 ＋ noopener ＋ noreferrer）', () => {
  const src = read(LOBBY);
  const anchor = src.match(/<a\b[^>]*data-testid="feedback-link"[^>]*>/)[0];
  assert.match(anchor, /target="_blank"/, '外部文档应新窗口打开（否则玩家离开大厅）');
  assert.match(anchor, /rel="[^"]*noopener[^"]*"/, '`rel` 必须含 noopener');
  assert.match(anchor, /rel="[^"]*noreferrer[^"]*"/, '`rel` 必须含 noreferrer');
});

test('④ 反例哨兵：这些串不许只出现在注释里', () => {
  const code = stripComments(read(LOBBY));
  for (const s of ['data-testid="feedback-link"', 'FEEDBACK_URL', 'noopener']) {
    assert.ok(code.includes(s), `\`${s}\` 只出现在注释里（注释不算实现）`);
  }
  // 「反馈」两个字要真的作为可见文案出现在 JSX 里（t('反馈')），不是只在注释里提
  assert.match(code, /t\('反馈'\)/, '「反馈」应以 `t(\'反馈\')` 出现在可见文案里');
});

test('⑤ 契约：地址不含我们的域名/服务器地址（那会让玩家以为反馈是站内功能）', async () => {
  const mod = await import('../../public/js/screens/lobby.js');
  assert.ok(!/ausevaywstr|localhost|127\.0\.0\.1/.test(mod.FEEDBACK_URL), '反馈地址不该指向我们自己的服务器');
  assert.match(mod.FEEDBACK_URL, /^https:\/\//, '必须是 https');
});
