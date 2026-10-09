// server/healthz.js — `/healthz` 的**可观测性字段**（第 3 任 D，2026-10-06，P1-④；**第 4 任 D 于 0.2.1 重新接线**）
//
// 换基座背景（为什么要单独一个模块）：上游 0.2.x 把 `server/index.js`（1016 行）拆成 `server/http/*` 9 个模块，
// 我们原来写在 `index.js` 里的 `artTag` / `memStats` / `loopStats` 随之**整段消失**（那是**静默回退**：
// 字段没了，但**没有任何闸会红** —— 交付闸只查 `artVersion` 在不在线，不查源码）。⇒ 现在把它独立成一个模块，
// 由 `http/routes.js`（健康体）与 `index.js`（启动时算一次 artTag）共同使用。
//
// ── ① artTag：线上"这一包素材到底换没换"的唯一在线凭证 ────────────────────────────────────────────
// 与 `buildTag`（前端运行时的构建号）**不是一回事**：`buildTag` 证明"页面代码换了"，`artTag` 证明"**素材/数据清单换了**"。
// 换包日外验清单里那条「`/healthz` 的 `artVersion` == 包内摘要」就是靠它。
//
// ⚠️ **路径相对于运行时的 `dataDir`**，不是游戏根目录：`startServer({ dataDir })` 可以指向别处（测试 / e2e / 自定义布局），
//    拿默认目录的 tag 去代表另一份数据是**一个自信的谎**（C 2026-10-06 的 spec：「请用运行时的 dataDir」）。
// ⚠️ **进程级只读一次**（与 `buildTag` 同）：换包必然重启服务器，**过期的 tag 正是这个字段要暴露的失败**。
//
// ── ② mem / loop：回答"房间涨到 43 个，内存有没有一直涨、进程有没有卡" ─────────────────────────────
// 为什么加：2026-10-06 线上实测「**2 个连接、43 个房间**」，而计数再多也答不了上面那个问题。
// 同族部署都报这两项（xiaolubao 的 `loop{p50,p99,max,windowMs}`、wei 的 `mem{rss,heap}`）。
//
// ⚠️ **`loop` 是进程级单例、累计、永不 `disable()`、永不 `reset()`** —— 两条都是实测出来的
//    （2026-10-06，Node 24 / Windows；判据 `test/healthz-observability.test.js` 的第 3 条是专门的回归护栏）：
//   · `monitorEventLoopDelay` 的样本**懒落地**（要等它自己的定时器在 timers 阶段跑过）。所以"**读后即重置**"那种写法
//     会把**还没落地的尖峰丢掉** —— 实测：忙等 124 ms 后立刻读 ⇒ 三个值全 0，而这一读的重置让随后一读只剩 31 ms 基线
//     ⇒ **尖峰彻底消失**。⇒ 改为**累计**（不重置）。
//   · 一次可疑实测（未定论）：先建一个直方图再 `disable()`，之后新建的直方图没采到随后的 120 ms 阻塞。
//     不论成因，这里都不需要 disable：**enable 的直方图不会吊住进程**（实测脚本 0.8 s 自然退出）。
//
// ⇒ 报的是**进程生命周期累计**：`max` = "自启动以来最坏一次卡顿"（最有用的一条），`p50/p99` = 整段分布，
//   `count` = 样本数（判断它有没有在量），`upMs` = 这个直方图已经看了多久。

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';

/** 参与 artTag 的清单（相对运行时 `dataDir`）。 */
export const ART_INPUTS = Object.freeze(['assets.json']);

/** 已发布素材清单的短哈希（utf8 文本），读不到时返回 null。@param {string} dataDir */
export function computeArtTag(dataDir) {
  const h = createHash('sha256');
  for (const rel of ART_INPUTS) {
    let text;
    // 按 utf8 读、对重新编码后的文本做哈希：这是 `阿里云开服/22-asset-freshness.mjs` 摘要的**同一种**算法
    // （它哈希的是文档的**原始文本**），所以两个值**可以直接比**，不需要一张翻译表。
    try { text = fs.readFileSync(path.join(String(dataDir), rel), 'utf8'); } catch { return null; }
    h.update(text, 'utf8');
  }
  return h.digest('hex').slice(0, 12);
}

/** @type {{ tag: string|null } | null} */
let artCache = null;

/** 本进程的 art tag（只算一次，与 `buildTag` 同）。@param {string} dataDir 运行时数据目录 */
export function artTag(dataDir) {
  if (artCache === null) artCache = { tag: computeArtTag(dataDir) };
  return artCache.tag;
}

/** 丢掉缓存：下一次 `artTag()` 重新读清单（测试，以及 `startServer`）。 */
export function resetArtTag() { artCache = null; }

let loopHist = null;
let loopStartedAt = 0;

/** 事件循环延迟（ms，一位小数；**自启动累计**，不重置）。 */
export function loopStats() {
  const ms = (ns) => Math.round((ns / 1e6) * 10) / 10;
  if (!loopHist) {
    // resolution 10 ms = Node 默认，也是同族部署的量级（xiaolubao 的 `loop.p50 ≈ 10.2`）；
    // 分辨率越大，**基线越高**（实测本机 resolution:20 ⇒ p50 稳定在 ~31 ms，看着像"一直在卡"）。
    loopHist = monitorEventLoopDelay({ resolution: 10 });
    loopHist.enable();
    loopStartedAt = Date.now();
    return { upMs: 0, count: 0, p50: 0, p99: 0, max: 0 };
  }
  return {
    upMs: Date.now() - loopStartedAt,
    count: loopHist.count,
    p50: ms(loopHist.percentile(50)),
    p99: ms(loopHist.percentile(99)),
    max: ms(loopHist.max),
  };
}

/** 进程内存（MB，一位小数）—— 只看这两个数就够判断"有没有持续增长"。 */
export function memStats() {
  const m = process.memoryUsage();
  const mb = (b) => Math.round((b / 1048576) * 10) / 10;
  return { rss: mb(m.rss), heapUsed: mb(m.heapUsed) };
}

// ── ③ devices：**设备/UA 占比**（第 4 任 D，2026-10-09）─────────────────────────────────────
// 为什么要有它：用户问「经此一役，是否要把插件适配到手机端」—— 而**我们不知道手机端占比多少**。
//   "要不要适配手机"一半取决于这个数 ⇒ **先量，再决定投多少**（别靠感觉开一个无底洞项目）。
// 口径（三个都要看得懂）：
//   · `mobile` / `tablet`        —— 手机 / 平板（触屏形态）
//   · `desktop`                 —— 桌面浏览器（含 Electron 外壳；它的 UA 里有 Electron）
//   · `bot` / `unknown`         —— 爬虫 / 拿不到 UA
// ⚠️ **累计、永不重置**（同 `loop` 的口径：重置会静默丢掉历史）；`sessions` 那一刻的在线分布另由 `/healthz` 的现有字段回答。
// ⚠️ 这是**粗分类**，只回答"手机占多少"这个问题；⛔ 不追求精确机型识别（那要引入依赖，不值）。
const DEVICE_KEYS = ['mobile', 'tablet', 'desktop', 'bot', 'unknown'];
const deviceCounts = { mobile: 0, tablet: 0, desktop: 0, bot: 0, unknown: 0 };

/**
 * 把一段 User-Agent 粗分成 `mobile` / `tablet` / `desktop` / `bot` / `unknown`。
 * 判序很重要：**先判平板再判手机**（iPad 的 UA 同时含 `Mobile`），**先判爬虫**（有些爬虫 UA 里也带 `Mobile`）。
 * @param {string | undefined | null} ua
 * @returns {'mobile'|'tablet'|'desktop'|'bot'|'unknown'}
 */
export function classifyUA(ua) {
  const s = String(ua ?? '');
  if (!s) return 'unknown';
  if (/bot|crawler|spider|headless|curl|wget|python-requests|node-fetch|axios/i.test(s)) return 'bot';
  if (/iPad|Tablet|PlayBook|Silk|(Android(?!.*Mobile))/i.test(s)) return 'tablet';
  if (/Mobile|iPhone|iPod|Android|Windows Phone|webOS|BlackBerry/i.test(s)) return 'mobile';
  return 'desktop';
}

/** 记一次"有人连上来"（在 WS upgrade 时用 `req.headers['user-agent']` 调）。 */
export function noteDevice(ua) {
  deviceCounts[classifyUA(ua)] += 1;
}

/** 累计的设备分布（只读快照）。 */
export function deviceStats() {
  const out = { total: 0 };
  for (const k of DEVICE_KEYS) { out[k] = deviceCounts[k]; out.total += deviceCounts[k]; }
  return out;
}
