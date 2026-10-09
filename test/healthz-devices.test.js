// 自检：`/healthz.devices` 设备占比统计（第 4 任 D，2026-10-09）
//   ① 分类器纯函数：手机/平板/桌面/爬虫/未知 各一条代表性 UA ⇒ 分类必须对（**先证能红**：故意传错的期望会失败）
//   ② 端到端：起服务器 → 用不同 UA 连 WS → `/healthz.devices` 计数必须涨对
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startServer } from '../server/index.js';
import { classifyUA } from '../server/healthz.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('classifyUA：五类代表性 UA（判序：爬虫 → 平板 → 手机 → 桌面）', () => {
  // 🔴 这几条**必须**分对；判序错了就会把 iPad 判成 mobile、把带 Mobile 的爬虫判成 mobile。
  const cases = [
    // 手机（真机 UA 片段）
    ['Mozilla/5.0 (Linux; Android 13; SM-S9080) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36', 'mobile'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1', 'mobile'],
    // 平板：**Android 不带 Mobile**、iPad 带 `iPad`
    ['Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36', 'tablet'],
    ['Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1', 'tablet'],
    // 桌面（含 Electron 外壳）
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36', 'desktop'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Electron/28.0.0 Safari/537.36', 'desktop'],
    // 爬虫（⚠️ 这条 UA 里**也带 Mobile** ⇒ 必须靠"先判爬虫"才分对）
    ['Mozilla/5.0 (Linux; Android 6.0.1) AppleWebKit/537.36 Chrome/41 Mobile Safari/537.36 Googlebot/2.1', 'bot'],
    // 未知
    ['', 'unknown'],
    [undefined, 'unknown'],
  ];
  for (const [ua, want] of cases) {
    assert.equal(classifyUA(ua), want, `UA 判定错：${String(ua).slice(0, 60)} ⇒ 期望 ${want}`);
  }
});

test('端到端：连上来的 UA 被记进 `/healthz.devices`（且分类正确）', async () => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    const health = async () => (await fetch(`${base}/healthz`)).json();
    const before = (await health()).devices;
    assert.ok(before, '`/healthz` 必须有 `devices` 字段');
    assert.equal(typeof before.mobile, 'number', '`devices` 要有 mobile 计数');

    // 用两条不同 UA 各连一次（一个手机、一个桌面）
    const phoneUA = 'Mozilla/5.0 (Linux; Android 13) Chrome/120 Mobile Safari/537.36';
    const deskUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36';
    for (const ua of [phoneUA, deskUA]) {
      const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { headers: { 'user-agent': ua } });
      await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
      await sleep(150);
      ws.close();
      await sleep(150);
    }
    const after = (await health()).devices;
    assert.equal(after.mobile, before.mobile + 1, `mobile 应 +1（${before.mobile} → ${after.mobile}）`);
    assert.equal(after.desktop, before.desktop + 1, `desktop 应 +1（${before.desktop} → ${after.desktop}）`);
    assert.equal(after.total, before.total + 2, 'total 应 +2');
  } finally { await srv.close(); }
});
