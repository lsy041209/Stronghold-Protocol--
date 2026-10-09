// server/http/config.js — where the server's settings come from. startServer() options win over the environment:
//
//   * PORT (default 3000), HOST (default 0.0.0.0);
//   * TRUST_PROXY ('auto' default: honour CF-Connecting-IP / X-Real-IP / X-Forwarded-For only from loopback/private
//     peers such as a local cloudflared; '1' always; '0' never) → net.js trustProxy;
//   * DEBUG → the console logger's debug level;
//   * the served directories (public/, data/, shared/ and the content packs' packs/ of this repository unless the
//     options name others), and which startServer() options are handed on to net.js Network and lobby.js Lobby.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

/** startServer() options handed on to net.js Network / lobby.js Lobby (an absent one keeps that module's default). */
// ⚠️ 我方（D-3 聊天 / 2026-10-07）追加了 `chatPerSec` / `chatBurst`：这张白名单**不转发 = 选项被静默丢掉**，
//    于是 `startServer({ chatPerSec: 200 })` 在测试里按默认的 1 条/秒生效 ⇒ `test/lobby-chat.test.js` 的
//    「空串/纯控制字符 ⇒ BAD_MSG」与「环形缓冲留 50 条」两条被限流打成 RATE/3 条。加键是**唯一**的修法。
// ⚠️ 同理（第 4 任 D，换基座到 0.2.x 后重新接线）：`matchmakeFillMs` / `roomRetentionMs` / `maxDormantRooms`
//    也**必须**在这张表里 —— 我实测验过：漏掉 `matchmakeFillMs` ⇒ `test/lobby-matchmake.test.js` 的第 ② 条
//    会拿默认的 60 s 去等一个 3 s 的窗口，**看起来像"到期补齐没生效"，其实是选项根本没透到 Lobby**。
//    ⇒ 本仓的规矩：**给 startServer 加一个会透到 net/lobby 的选项，就必须同时加到这个白名单**。
const NET_OPTION_KEYS = ['reconnectWindowMs', 'heartbeatMs', 'helloTimeoutMs', 'ratePerSec', 'rateBurst', 'maxConnections', 'abuseDropsPerSec',
  'maxConnectionsPerAddr', 'heavyPerSec', 'heavyBurst', 'chatPerSec', 'chatBurst', 'trustProxy'];
const LOBBY_OPTION_KEYS = ['lobbyGraceMs', 'maxRooms', 'maxRoomsPerAddr', 'maxMatchesPerAddr', 'resyncMinGapMs', 'soloReconnectWindowMs',
  'matchmakeFillMs', 'roomRetentionMs', 'maxDormantRooms'];

/**
 * Where to listen: the `port` / `host` options, else PORT / HOST, else port 3000 on 0.0.0.0.
 * @param {{ port?: number, host?: string }} opts
 * @returns {{ port: number, host: string }}
 * @throws {RangeError} when the port is not an integer in 0…65535
 */
export function listenAddress(opts) {
  const port = opts.port ?? (process.env.PORT != null && process.env.PORT !== '' ? Number(process.env.PORT) : 3000);
  const host = opts.host ?? process.env.HOST ?? '0.0.0.0';
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError(`invalid PORT ${port}`);
  return { port, host };
}

/**
 * The directories the static server reads (packsDir: the pack folders, server/packs.js).
 * @param {{ publicDir?: string, dataDir?: string, sharedDir?: string, packsDir?: string }} opts
 */
export function serveDirs(opts) {
  return {
    publicDir: opts.publicDir || path.join(ROOT, 'public'),
    dataDir: opts.dataDir || path.join(ROOT, 'data'),
    sharedDir: opts.sharedDir || path.join(ROOT, 'shared'),
    packsDir: opts.packsDir || path.join(ROOT, 'packs'),
  };
}

/** net.js Network options out of the startServer() options; `trustProxy` falls back to TRUST_PROXY. */
export function netOptionsFrom(opts) {
  const netOptions = {};
  for (const k of NET_OPTION_KEYS) {
    if (opts[k] != null) netOptions[k] = opts[k];
  }
  if (netOptions.trustProxy == null) netOptions.trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
  return netOptions;
}

/** lobby.js Lobby options out of the startServer() options. */
export function lobbyOptionsFrom(opts) {
  const lobbyOptions = {};
  for (const k of LOBBY_OPTION_KEYS) {
    if (opts[k] != null) lobbyOptions[k] = opts[k];
  }
  return lobbyOptions;
}

/** TRUST_PROXY env → net.js trustProxy ('auto' unless explicitly on/off). @param {string | undefined} v */
export function parseTrustProxy(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'always'].includes(s)) return true;
  if (['0', 'false', 'no', 'off', 'never'].includes(s)) return false;
  return 'auto';
}

/** The console logger (`quiet` → silent; debug lines only with DEBUG set). */
export function makeLogger(quiet) {
  if (quiet) return noopLog;
  return {
    info: (...a) => console.log(...a),
    warn: (...a) => console.warn(...a),
    error: (...a) => console.error(...a),
    debug: process.env.DEBUG ? (...a) => console.debug(...a) : () => {},
  };
}
