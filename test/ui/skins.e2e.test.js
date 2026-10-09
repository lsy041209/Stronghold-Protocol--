// 换装皮肤（全量内置版，docs/SKINS.md）的浏览器 E2E：真服务器 + headless Chromium。
// Opt-in: SP_E2E=1 node --test test/ui/skins.e2e.test.js
//   Windows: CHROME_PATH="C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" SP_E2E=1 node --test test/ui/skins.e2e.test.js
//
// 为什么非要真浏览器（静态判据看不出这四条，而它们都会**静默**失败）：
//   ① 键用错（chessId vs operator id）⇒ 选择被清空，界面上只是「点了没反应」；
//   ② 头像 / 骨骼的 URL 在 `public/assets` 整体转 WebP 之后 404 ⇒ 回退到原皮，
//      看起来就是「换了皮肤但没变化」—— 这正是 2026-10-05「全站图标退化成文字」的失败模式，
//      所以这里断言的是 `<img>` **真的解码出来了**（naturalWidth > 0），不是「src 属性存在」；
//   ③ 四子标签页（技能 / 模组 / 数值 / 换装）把换装页挤没 / 横向溢出；
//   ④ 761×360 低配小屏下行高压到触达线以下 —— SKINS-BUILTIN-PLAN §1 要求 `.lo-skin` ≥ 46px、
//      `.lo-skin__art` 46px（磁贴版只有 ~27px / 15px，窄屏上根本点不准）。
//
// 截图落 test/e2e/out/skins-*.png。

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'test/e2e/out');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ENABLED = process.env.SP_E2E === '1' && existsSync(CHROME);

const CHESS = 'chess_char_1_01_a';        // 隐现
const NAME = '隐现';
const SKIN_A = 'char_498_inside@kitchen#2';   // 甜品大奖
const SKIN_B = 'char_498_inside@summer#22';   // 悠然假日 HDm25
const SKIN_COUNT = 2;

describe('换装皮肤 (real server, headless Chrome)', { skip: !ENABLED && 'set SP_E2E=1 (and have Chrome) to run' }, () => {
  let srv;
  let browser;
  let base;

  before(async () => {
    const { startServer } = await import('../../server/index.js');
    const puppeteer = (await import('puppeteer-core')).default;
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
    base = `http://127.0.0.1:${srv.port}`;
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
    mkdirSync(OUT, { recursive: true });
  });
  after(async () => { await browser?.close(); await srv?.close(); });

  async function open({ w = 1920, h = 1080, touch = false } = {}) {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport({ width: w, height: h, hasTouch: touch, isMobile: touch, deviceScaleFactor: 1 });
    const problems = [];
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('requestfailed', (r) => { if (!/fonts\.(googleapis|gstatic)/.test(r.url())) problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`); });
    page.on('response', (r) => { if (r.status() >= 400) problems.push(`http ${r.status()}: ${r.url()}`); });
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('sp.name', '换装测试');
      sessionStorage.setItem('sp.entered', '1');
    });
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => globalThis.__SP__?.store.get().connection.status === 'online' && !!document.querySelector('.lobby-screen'), { timeout: 30000 });
    return { ctx, page, problems };
  }

  /** 打开调配 → 搜到隐现 → 点开 → 切到「换装」页。 */
  async function openSkinPage(page, { touch = false } = {}) {
    const tap = (sel) => (touch ? page.tap(sel) : page.click(sel));
    await tap('.lobby-screen [data-testid="loadout-open"]');
    await page.waitForSelector('.lo .lo-card', { visible: true, timeout: 15000 });
    await page.type('.lo-search input', NAME);
    await page.waitForFunction(() => document.querySelectorAll('.lo-card').length === 1, { timeout: 5000 });
    await tap('.lo-card');
    await page.waitForSelector('.lo-dtabs [data-tab="skin"]', { visible: true, timeout: 10000 });
    await tap('.lo-dtabs [data-tab="skin"]');
    await page.waitForSelector('[data-testid="skin-section"] .lo-skin', { visible: true, timeout: 10000 });
  }

  test('desktop: 换装页 = 默认 + 每套一行；选中写进 localStorage，roster 卡亮起「已换装」小点', async () => {
    const { ctx, page, problems } = await open();
    await openSkinPage(page);

    // 一行一套（不做 wrap 磁贴）：默认 + 该干员的两套
    const rows = await page.$$eval('.lo-skin', (els) => els.map((e) => ({
      skin: e.dataset.skin, name: e.querySelector('.lo-skin__name')?.textContent, group: e.querySelector('.lo-skin__group')?.textContent,
    })));
    assert.equal(rows.length, SKIN_COUNT + 1, `默认 + ${SKIN_COUNT} 套：${JSON.stringify(rows)}`);
    assert.equal(rows[0].skin, '', '第一行是「默认」');
    assert.deepEqual(rows.slice(1).map((r) => r.skin), [SKIN_A, SKIN_B]);
    assert.deepEqual(rows.slice(1).map((r) => r.name), ['甜品大奖', '悠然假日 HDm25']);
    // 桌面宽度下两者都必须完整（窄屏的让位规则见下一条用例）
    const wide = await page.$$eval('.lo-skin', (els) => els.map((r) => {
      const n = r.querySelector('.lo-skin__name'); const g = r.querySelector('.lo-skin__group');
      return { n: n.scrollWidth > n.clientWidth + 1, g: g.scrollWidth > g.clientWidth + 1 };
    }));
    assert.deepEqual(wide.filter((w) => w.n || w.g), [], `1920 宽下名称与系列都完整：${JSON.stringify(wide)}`);

    // 头像必须**真的解码出来**（转 WebP 后 URL 写死 .png 就会 404 → 静默退回原皮）
    const art = await page.$$eval('.lo-skin__art img', (els) => els.map((e) => ({ src: e.getAttribute('src'), ok: e.complete && e.naturalWidth > 0 })));
    assert.ok(art.length >= SKIN_COUNT, `皮肤头像都在：${JSON.stringify(art)}`);
    for (const a of art) assert.ok(a.ok, `头像加载成功（不是 404 退回）：${JSON.stringify(a)}`);

    // 选中
    await page.click(`.lo-skin[data-skin="${SKIN_A}"]`);
    await page.waitForFunction((c, id) => JSON.parse(localStorage.getItem('sp.pref.skins') || '{}')[c] === id, { timeout: 5000 }, CHESS, SKIN_A);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('sp.pref.skins')));
    assert.deepEqual(stored, { [CHESS]: SKIN_A }, '按 chessId 存 —— 目录按 operator id 分组是另一回事，两者混用会静默清空');
    assert.equal(await page.$eval(`.lo-skin[data-skin="${SKIN_A}"]`, (e) => e.classList.contains('is-on')), true, '选中的那行标 is-on');
    // roster 卡上的小点（与「已调整」角标分开看 entries）
    assert.ok(await page.$(`.lo-card[data-chess="${CHESS}"] .lo-card__skin`), 'roster 卡亮起「已换装」小点');
    await page.screenshot({ path: path.join(OUT, 'skins-desktop.png') });

    // 点「默认」撤回 —— 选择回到空
    await page.click('.lo-skin[data-skin=""]');
    await page.waitForFunction((c) => !JSON.parse(localStorage.getItem('sp.pref.skins') || '{}')[c], { timeout: 5000 }, CHESS);
    assert.equal(await page.$(`.lo-card[data-chess="${CHESS}"] .lo-card__skin`), null, '撤掉换装后小点消失');
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  test('761×360（低配小屏）：单行卡片行高 ≥46px、头像 46px、系列仍在行内、无横向溢出', async () => {
    const { ctx, page, problems } = await open({ w: 761, h: 360, touch: true });
    await openSkinPage(page, { touch: true });

    const m = await page.evaluate(() => {
      const bodyEl = document.querySelector('.lo-detail__body');
      const body = bodyEl.getBoundingClientRect();
      const inside = (el) => { const b = el.getBoundingClientRect(); return b.left >= body.left - 1 && b.right <= body.right + 1 && b.width > 0; };
      const rows = [...document.querySelectorAll('.lo-skin')];
      return {
        over: bodyEl.scrollWidth - bodyEl.clientWidth,
        minRow: Math.min(...rows.map((r) => Math.round(r.getBoundingClientRect().height))),
        minArt: Math.min(...rows.map((r) => Math.round(r.querySelector('.lo-skin__art').getBoundingClientRect().height))),
        artSquare: rows.every((r) => { const b = r.querySelector('.lo-skin__art').getBoundingClientRect(); return Math.abs(b.width - b.height) <= 1; }),
        allInside: rows.every(inside),
        // 名称与系列**同一行**（系列飘到行尾），不是一个压在另一个下面
        sameRow: rows.every((r) => {
          const n = r.querySelector('.lo-skin__name').getBoundingClientRect();
          const g = r.querySelector('.lo-skin__group').getBoundingClientRect();
          return g.left >= n.right - 1 && g.top < n.bottom && g.bottom > n.top;
        }),
        nameClipped: rows.filter((r) => { const n = r.querySelector('.lo-skin__name'); return n.scrollWidth > n.clientWidth + 1; })
          .map((r) => { const n = r.querySelector('.lo-skin__name'); const g = r.querySelector('.lo-skin__group'); return { name: n.textContent, nameW: n.clientWidth, nameSw: n.scrollWidth, group: g.textContent, groupW: g.clientWidth }; }),
        groupClipped: rows.filter((r) => { const g = r.querySelector('.lo-skin__group'); return g.scrollWidth > g.clientWidth + 1; }).map((r) => r.querySelector('.lo-skin__group').textContent),
        rowW: rows.map((r) => Math.round(r.getBoundingClientRect().width)),
        detailW: Math.round(body.width),
        nameFs: parseFloat(getComputedStyle(document.querySelector('.lo-skin__name')).fontSize),
        groupFs: parseFloat(getComputedStyle(document.querySelector('.lo-skin__group')).fontSize),
        rowCount: rows.length,
      };
    });
    // SKINS-BUILTIN-PLAN §1：磁贴版行高 ~27px / 头像 15px，都在 `.sp-coarse` 的 30px 触达线之下
    assert.ok(m.minRow >= 46, `每行 ≥46px 触达线：${JSON.stringify(m)}`);
    assert.ok(m.minArt >= 46, `头像 ≥46px：${JSON.stringify(m)}`);
    assert.ok(m.artSquare, `头像正方：${JSON.stringify(m)}`);
    assert.ok(m.over <= 1, `不横向溢出：${JSON.stringify(m)}`);
    assert.ok(m.allInside, `每行都在详情列内：${JSON.stringify(m)}`);
    assert.ok(m.sameRow, `名称与系列同一行（系列推到行尾）：${JSON.stringify(m)}`);
    assert.ok(m.nameFs >= 13 && m.groupFs >= 10, `字号有 px 下限：${JSON.stringify(m)}`);
    assert.deepEqual(m.nameClipped, [], `名称是主信息，永远不截断：${JSON.stringify(m)}`);
    // 系列是次要信息：列宽不够时它才让位（761×360 的详情列只有 254px，两者放不下）
    assert.ok(m.groupClipped.length <= 1, `最多一个系列让位：${JSON.stringify(m)}`);
    await page.screenshot({ path: path.join(OUT, 'skins-narrow-761x360.png') });
    assert.deepEqual(problems, []);
    await ctx.close();
  });

  test('导出 / 导入带得动皮肤；只换了皮肤也能导出（nChanged || nSkins）', async () => {
    const { ctx, page, problems } = await open();
    await openSkinPage(page);
    await page.click(`.lo-skin[data-skin="${SKIN_B}"]`);
    await page.waitForFunction((c, id) => JSON.parse(localStorage.getItem('sp.pref.skins') || '{}')[c] === id, { timeout: 5000 }, CHESS, SKIN_B);

    // 只换了皮肤、一个技能/模组都没动 ⇒ 导出必须是可点的（`nChanged || nSkins`）
    const canExport = await page.$eval('[data-testid="loadout-export"]', (b) => !b.disabled);
    assert.equal(canExport, true, '只换皮肤也能导出（旧版只看 nChanged 会是灰的）');
    await page.click('[data-testid="loadout-export"]');
    await page.waitForSelector('[data-testid="loadout-io-text"]', { visible: true });
    const text = await page.$eval('[data-testid="loadout-io-text"]', (el) => el.value);
    const payload = JSON.parse(text);
    assert.equal(payload.skins?.[CHESS], SKIN_B, `导出的 payload 带 skins：${text.slice(0, 160)}`);
    await page.keyboard.press('Escape');

    // 改成本地选另一套 → 导入刚才那份 ⇒ 皮肤被覆盖回 SKIN_B
    await page.click(`.lo-skin[data-skin="${SKIN_A}"]`);
    await page.waitForFunction((c, id) => JSON.parse(localStorage.getItem('sp.pref.skins') || '{}')[c] === id, { timeout: 5000 }, CHESS, SKIN_A);
    await page.click('[data-testid="loadout-import"]');
    await page.waitForSelector('[data-testid="loadout-io-text"]', { visible: true });
    await page.$eval('[data-testid="loadout-io-text"]', (el, v) => {
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, text);
    await page.click('[data-testid="loadout-io-apply"]');
    await page.waitForFunction((c, id) => JSON.parse(localStorage.getItem('sp.pref.skins') || '{}')[c] === id, { timeout: 5000 }, CHESS, SKIN_B);
    const after = await page.evaluate(() => JSON.parse(localStorage.getItem('sp.pref.skins')));
    assert.deepEqual(after, { [CHESS]: SKIN_B }, '导入把皮肤收回来了');
    assert.deepEqual(problems, []);
    await ctx.close();
  });
});
