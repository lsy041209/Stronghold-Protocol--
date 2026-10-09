// server/http/boot.js — running the server as a process (`node server/index.js`, npm start, scripts/launch.mjs, the
// Windows service's scripts/run-server.cmd, NSSM, systemd):
//
//   * first, an update package extracted over the install (UPDATE.json) is finished — old files deleted, the install
//     verified (server/update.js); one that does not match its MANIFEST.json keeps the server from starting (exit 1);
//   * the boot banner: release version, the Local URL, the LAN URLs when listening on every interface, the
//     cloudflared command for internet play;
//   * a server that cannot start exits 1 (with a hint when the port is in use); unhandled rejections and uncaught
//     exceptions are logged, not fatal;
//   * graceful shutdown on SIGINT/SIGTERM (rooms get room.closed{reason:'shutdown'}, sockets close 1001); a second
//     signal exits at once, and the process exits anyway 5 s after the first.

import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { APP_VERSION, DEV_BUILD } from '../../shared/constants.js';
import { shutdownSequence, shutdownGraceMs } from '../ops.js';
import { applyPendingUpdate } from '../update.js';
import { ROOT } from './config.js';

/** Non-internal IPv4 addresses as http URLs. @param {number} port */
export function lanUrls(port) {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push(`http://${a.address}:${port}`);
    }
  }
  return out;
}

/** Is the module whose `import.meta.url` is `metaUrl` the file node was started with? */
export function isProcessEntry(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

/** Print the boot banner of a started server. @param {{ url: string, host: string, port: number }} srv */
export function printBanner(srv) {
  console.log(`\n  卫戍协议：盟约 · Stronghold Protocol: Alliance v${APP_VERSION}`);
  if (DEV_BUILD) console.log('  ! 开发版（dev 分支）：不稳定，请勿用于公开服务器 · development build — unstable, not for public servers');
  console.log(`  Local:   ${srv.url}`);
  if (srv.host === '0.0.0.0' || srv.host === '::') {
    for (const u of lanUrls(srv.port)) console.log(`  LAN:     ${u}`);
  }
  console.log('  Internet: cloudflared tunnel --url ' + `http://localhost:${srv.port}` + '\n');
}

/**
 * The process main: finish a pending update package, start the server, print the banner, stop gracefully on SIGINT /
 * SIGTERM.
 *
 * ── 停机序列（第 3 任 D 的 `server/ops.js`；**第 4 任 D 于 0.2.1 重新接线**）────────────────────────
 * 上游 0.2.x 这份 `stop` 原样是「**写死 5 秒**直接 `process.exit(0)`」—— **不播报、不留现场**。
 * 我方的行为（用户 2026-10-06 11:5x 批准）是：
 *   · **宽限 60 秒**（`SP_SHUTDOWN_GRACE_MS`，夹在 0…300 s）；
 *   · 在 **30 / 10 / 5 秒**三个里程碑往所有在线会话播 `m.toast`（1 条）+ `m.ticker`（每条）；
 *   · 停机**前后各落一份快照**（`snapshot('shutdown-start')` / `snapshot('shutdown')`，见 `server/ops.js`）。
 * 这些都在 `shutdownSequence(srv, …)` 里，**它自己会调 `srv.close()`** ⇒ 这里不能再调一次。
 * ⚠️ 这是**静默回退**的典型：换基座后字段/行为没了，**没有任何闸会红**（`patch-game` 只在源码里找字符串）。
 *    判据 `test/ops-shutdown-hook.test.js`（它注入一个假的 `shutdownSequence`，**不看源码字符串**，只看真的被调了）。
 *
 * @param {() => Promise<{ url: string, host: string, port: number, close: () => Promise<void> }>} start index.js startServer
 * @param {{ seq?: Function, exit?: (code?: number) => void, signals?: string[] }} [deps]
 *   `seq` = `shutdownSequence`（测试注入假的，默认用真的）；`exit` = 退出（测试注入假的，默认 `process.exit`）；
 *   `signals` = 要接的信号（默认 SIGINT/SIGTERM）。**注入是为了让停机路径可被判据覆盖** —— 那条路径平时跑不到。
 */
export async function runMain(start, deps = {}) {
  const seq = deps.seq || shutdownSequence;
  const exit = deps.exit || ((code) => process.exit(code));
  process.on('unhandledRejection', (e) => console.error('[process] unhandled rejection', e));
  process.on('uncaughtException', (e) => console.error('[process] uncaught exception', e));
  // before the data, the packs or the browser runtime are read: the files must be the new version's (server/update.js).
  // Nothing is listening yet, so returning ends the process with exit code 1 once the message is written.
  if (applyPendingUpdate(ROOT).state === 'failed') { process.exitCode = 1; return; }
  let srv;
  try {
    srv = await start();
  } catch (e) {
    if (e && e.code === 'EADDRINUSE') console.error(`端口已被占用 / port in use: ${e.port ?? process.env.PORT ?? 3000}. Try PORT=3001 npm start`);
    else console.error('[boot] failed to start', e);
    exit(1);
    return;
  }
  printBanner(srv);

  let stopping = false;
  let forced = false;
  const stop = (signal) => {
    if (stopping) {
      // 第二次信号 = 用户/运维等不及了 ⇒ 立刻退出。置 `forced` 是为了让**第一遍**序列晚到的 resolve
      // 不再多退一次（在测试里那会变成 [1, 0] 两个码；在生产里 `process.exit` 已经终止了，属于死代码）。
      forced = true;
      console.log('forced exit');
      exit(1);
      return;
    }
    stopping = true;
    console.log(`\n[${signal}] shutting down…`);
    // 兜底：万一停机序列自己卡住（写盘阻塞等），到点仍然退出（比宽限期多留 10 s 余量）。
    setTimeout(() => exit(0), shutdownGraceMs() + 10_000).unref();
    // `shutdownSequence` 会 ① 留现场 ② 播报倒计时 ③ 再留现场 ④ 才 `srv.close()`
    //   ⇒ **不要**在这里再调 `srv.close()`，否则关服会抢在播报之前。
    seq(srv, { graceMs: shutdownGraceMs() }).then(() => { if (!forced) exit(0); }, (e) => {
      if (forced) return;
      console.error('[boot] shutdown sequence failed', e);
      // 停机序列炸了也必须关服，否则端口一直占着（这是"运维功能不能把停服搞坏"的下限）。
      Promise.resolve(srv?.close?.()).then(() => exit(1), () => exit(1));
    });
  };
  for (const sig of deps.signals || ['SIGINT', 'SIGTERM']) process.on(sig, () => stop(sig));
  // 测试用的把手：**不发真信号、不真退出**，直接走一遍上面的停机路径（`test/ops-shutdown-hook.test.js`）。
  return { stop };
}
