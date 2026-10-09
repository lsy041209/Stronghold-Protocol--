// server/http/routes.js — the node:http request listener. Every response gets the security headers (common.js), then:
// (i18n-ignore-file: the error pages are bilingual by design, 中文 · English — docs/I18N.md)
//
//   * a URL longer than 4096 characters → 414; one that does not parse → 400;
//   * any method but GET / HEAD → 405 with `Allow: GET, HEAD`;
//   * GET /healthz → JSON status (protocol `version`, release `app`, uptime, the served `build`, sockets, sessions,
//     rooms, matches), never cached;
//   * everything else → the static files (static.js).
// A route that throws is logged and answers 500.

import { PROTOCOL_VERSION, APP_VERSION } from '../../shared/constants.js';
import { buildTag } from './buildTag.js';
import { artTag, memStats, loopStats, deviceStats } from '../healthz.js';
import { setSecurityHeaders, sendError, sendJson, splitUrl } from './common.js';

const MAX_URL_LENGTH = 4096;

/**
 * The GET /healthz body.
 * @param {{ startedAt: number, network: import('../net.js').Network, registry: import('../net.js').SessionRegistry,
 *           lobby: import('../lobby.js').Lobby }} health
 */
export function healthReport({ startedAt, network, registry, lobby }) {
  // 在线/离线拆分（第 3 任 D，2026-10-06；D 于 0.2.1 重新接线）：
  //   · **座位口径**（`rooms`/`matches`/`humans`/`bots`/`spectators`）由 `lobby.stats()` 给，语义不变；
  //   · **会话口径**在这里补：`sessions` 含"断线但仍在重连窗口内"的会话 ⇒ 再给一个 `sessionsOnline`；
  //     `onlineInLobby` = 在线且**还没进任何房间**（`roomCode` 为空）—— 看板/公告里"大厅里有多少活人"。
  //   ⇒ 之前线上"**2 个连接、43 个房间**"就是因为只有座位口径；现在两套都有，**别再拿座位当活人**。
  const ls = lobby.stats();
  let sessionsOnline = 0;
  let onlineInLobby = 0;
  for (const s of registry.all()) {
    if (!s.connected) continue;
    sessionsOnline++;
    if (!s.roomCode) onlineInLobby++;
  }
  return {
    ok: true, version: PROTOCOL_VERSION, app: APP_VERSION, uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    // the runtime the server is serving right now (public/js/ui/buildGuard.js): a page whose own build is
    // older than this reloads itself, so a deploy reaches clients that never reload
    build: buildTag(),
    // 本进程**启动时**读到的素材/数据清单摘要 —— 换包是否真的落地，这是**线上唯一**的凭证
    // （与 `阿里云开服/22-asset-freshness.mjs` 的算法同源，可直接比；见 server/healthz.js）
    artVersion: artTag(),
    // observability：**累计**的事件循环直方图（**永不重置** —— 重置会静默丢掉尖峰，
    // 判据 `test/healthz-observability.test.js`）+ 进程内存（MB）
    mem: memStats(),
    loop: loopStats(),
    // 🆕 2026-10-09 第 4 任 D：**设备/UA 占比**（累计、永不重置）—— 用来回答"手机端到底占多少"，
    //    从而决定"要不要为手机端投工"（用户 2026-10-09 的问句）。口径见 `server/healthz.js` 的 `classifyUA`。
    devices: deviceStats(),
    sockets: network.connectionCount, sessions: registry.size, ...ls,
    sessionsOnline, onlineInLobby, onlinePlayers: ls.onlineHumans + ls.onlineBots,
    // 野排（我方独有的快速匹配）：**正在凑人的房数** —— 来自 `lobby.stats()` 的 `matchmaking`。
    // 为什么值得单独给个名字：外部同族服务器报的是 `queue`（C 10-08 实测），而"野排到底有没有人在用"
    // 在我们这里**以前只能靠猜**。判据 `test/healthz-matchmaking.test.js`（0 → 1 → 0 三态）。
    matchmaking: ls.matchmaking,
  };
}

/**
 * The request listener for `http.createServer`.
 * @param {{ serveStatic: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse,
 *             rawPath: string, query: string) => Promise<void>,
 *           health: Parameters<typeof healthReport>[0], log: object }} deps
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function createRequestHandler({ serveStatic, health, log }) {
  async function handleRequest(req, res) {
    const url = req.url || '/';
    if (url.length > MAX_URL_LENGTH) { sendError(req, res, 414, '请求地址过长 · URI too long'); return; }
    const parts = splitUrl(url);
    if (!parts) { sendError(req, res, 400, '请求地址无效 · Bad request'); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      sendError(req, res, 405, '不支持的请求方法 · Method not allowed');
      return;
    }
    if (parts.rawPath === '/healthz') {
      sendJson(req, res, 200, healthReport(health));
      return;
    }
    await serveStatic(req, res, parts.rawPath, parts.query);
  }

  return (req, res) => {
    setSecurityHeaders(res);
    handleRequest(req, res).catch((e) => {
      log.error('[http] request failed', e);
      sendError(req, res, 500, '服务器内部错误 · Internal error');
    });
  };
}
