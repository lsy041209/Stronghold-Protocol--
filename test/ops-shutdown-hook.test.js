// test/ops-shutdown-hook.test.js — **停机钩子的接线**（第 4 任 D，2026-10-07）
//
// ## 为什么需要这条判据
// 上游 0.2.x 的 `server/http/boot.js` 把 `runMain` 的 `stop` 写成「**写死 5 秒**直接 `process.exit(0)`」——
// 我方 `server/ops.js` 的停机序列（60 s 宽限 ＋ 30/10/5 里程碑播报 ＋ 停机前后快照）**整段不在生产路径上**。
// 这是本仓最贵的那类回退：**字段/行为没了，但没有任何闸会红**（`patch-game` 只在源码里找字符串，
// 而"这段代码被接上了没有"**不是字符串能回答的**）。
//
// ## 这条判据的设计（**不许退化成"grep 源码"**）
//   · 它**不**断言 `boot.js` 里出现 `shutdownSequence` 字样 —— 那种断言改个名字就假绿；
//   · 它**注入一个假的 `seq` 和假的 `exit`**，跑一遍**真的 `runMain`**，然后断言：
//     ① 停机序列**真的被调了**、且拿到的是**服务端对象本身**；
//     ② 宽限期 = `SP_SHUTDOWN_GRACE_MS` 量出来的值（默认 60 s）—— 这是"不再写死 5 秒"的**行为**证据；
//     ③ 退出码来自停机序列的结果（成功 ⇒ 0）；
//     ④ **第二次**信号是**强制退出**（码 1），不是再走一遍序列；
//     ⑤ 停机序列**抛错**时，仍然把服务端**关掉**（运维功能不能把停服搞坏）。
//
// ## 阴性对照（证明它会红）
//   把 `boot.js` 的 `seq(srv, …)` 那一行改回 `srv.close()`（= 上游的行为）⇒ ① 立刻红。
//   把 `shutdownGraceMs()` 换成写死的 `5000` ⇒ ② 立刻红。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runMain } from '../server/http/boot.js';
import { DEFAULT_GRACE_MS } from '../server/ops.js';

/** 一个只够 `runMain` 用的假服务端；`silent: true` 让 banner 少打点字。 */
const fakeSrv = (over = {}) => ({
  url: 'http://127.0.0.1:0', host: '127.0.0.1', port: 0,
  close: async () => {}, ...over,
});

/** 把 SIGINT/SIGTERM 的监听器收干净：`runMain` 每次都会 `process.on`，不摘会跨测试累积。 */
function withoutSignals(fn) {
  const before = { INT: process.listeners('SIGINT').length, TERM: process.listeners('SIGTERM').length };
  return Promise.resolve(fn()).finally(() => {
    const trim = (sig, n) => { const ls = process.listeners(sig); for (let i = n; i < ls.length; i++) process.off(sig, ls[i]); };
    trim('SIGINT', before.INT);
    trim('SIGTERM', before.TERM);
  });
}

test('停机钩子：SIGTERM 真的走我方 shutdownSequence（而不是上游的"写死 5 秒直接退"）', async () => {
  const calls = [];
  const exits = [];
  const srv = fakeSrv();
  await withoutSignals(async () => {
    const h = await runMain(async () => srv, {
      seq: async (got, opts) => { calls.push({ got, opts }); },
      exit: (c) => exits.push(c),
      signals: [],
    });
    assert.ok(h && typeof h.stop === 'function', 'runMain 应把 stop 暴露出来（否则这条路径没法被测）');
    h.stop('SIGTERM');
    await new Promise((r) => setImmediate(r));
  });

  assert.equal(calls.length, 1, '停机序列必须**恰好**被调一次（一次就够，别重复播报）');
  assert.equal(calls[0].got, srv, '要拿到**服务端对象本身**（序列要用它的 registry/snapshot/close）');
  assert.equal(calls[0].opts.graceMs, DEFAULT_GRACE_MS, `宽限期应是 ${DEFAULT_GRACE_MS} ms，实测 ${calls[0].opts.graceMs}`);
  assert.deepEqual(exits, [0], '序列成功 ⇒ 以 0 退出');
});

test('停机钩子：宽限期随 SP_SHUTDOWN_GRACE_MS 变（= 不是写死的那个 5 秒）', async () => {
  const prev = process.env.SP_SHUTDOWN_GRACE_MS;
  process.env.SP_SHUTDOWN_GRACE_MS = '12345';
  const seen = [];
  try {
    await withoutSignals(async () => {
      const h = await runMain(async () => fakeSrv(), {
        seq: async (got, opts) => { seen.push(opts.graceMs); },
        exit: () => {}, signals: [],
      });
      h.stop('SIGTERM');
      await new Promise((r) => setImmediate(r));
    });
  } finally {
    if (prev === undefined) delete process.env.SP_SHUTDOWN_GRACE_MS; else process.env.SP_SHUTDOWN_GRACE_MS = prev;
  }
  assert.deepEqual(seen, [12345], '宽限期必须来自 shutdownGraceMs()（环境变量），不是源码里的常数');
});

test('停机钩子：第二次信号 = 强制退出（码 1），不再走一遍序列', async () => {
  let seqCalls = 0;
  const exits = [];
  await withoutSignals(async () => {
    const h = await runMain(async () => fakeSrv(), {
      seq: async () => { seqCalls++; await new Promise((r) => setTimeout(r, 5)); },
      exit: (c) => exits.push(c), signals: [],
    });
    h.stop('SIGTERM');
    h.stop('SIGTERM');            // 第二次：用户等不及了
    await new Promise((r) => setTimeout(r, 20));
  });
  assert.equal(seqCalls, 1, '第二次信号**不许**再走一遍停机序列');
  assert.deepEqual(exits, [1], '第二次信号应立刻以 1 退出（"forced exit"）');
});

test('停机钩子：序列抛错时仍然关服（运维功能不能把停服搞坏）', async () => {
  let closed = 0;
  const exits = [];
  await withoutSignals(async () => {
    const srv = fakeSrv({ close: async () => { closed++; } });
    const h = await runMain(async () => srv, {
      seq: async () => { throw new Error('boom'); },
      exit: (c) => exits.push(c), signals: [],
    });
    h.stop('SIGTERM');
    await new Promise((r) => setTimeout(r, 20));
  });
  assert.equal(closed, 1, '序列炸了也必须把服务端关掉（否则端口一直占着）');
  assert.deepEqual(exits, [1], '这种情况应报非 0 退出码');
});

test('辅助（**源码级**，不是行为证据）：默认 seq 回落到真的 `shutdownSequence`', async () => {
  // ⚠️ 说清定位：上面四条是**注入型行为判据**（它们不看源码字符串）；这一条**是**源码级断言，
  //    只用来钉住"默认值别被换成 noop"。**别拿它当"停机接通了"的证据** —— 那个由上面四条负责。
  const { shutdownSequence } = await import('../server/ops.js');
  assert.equal(typeof shutdownSequence, 'function');
  const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../server/http/boot.js', import.meta.url), 'utf8'));
  assert.match(src, /const seq = deps\.seq \|\| shutdownSequence/, '默认必须回落到真 `shutdownSequence`');
});
