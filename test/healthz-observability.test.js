// test/healthz-observability.test.js — `/healthz` 的 `mem` / `loop`（第 3 任 D，2026-10-06，P1-④）
//
// 为什么加这两个字段：当天线上实测「**2 个连接、43 个房间**」，而我们**无法回答**"这些房间是否让内存持续增长、
// 进程有没有卡顿" —— 计数再多也答不了。同族部署都报这两项（xiaolubao 的 `loop{p50,p99,max,windowMs}`、wei 的 `mem{rss,heap}`）。
//
// 本测试钉四件：
//   ① 两个字段存在、形状正确、单位合理；
//   ② **`loop` 真的在量事件循环** —— 用一次故意的忙等把它顶起来（若直方图是摆设，这条必红）；
//   ③ 🔴 **回归护栏：不许把 `loop` 改回"读后即重置"** —— 实测 ELD 样本**懒落地**（等它自己的定时器在 timers 阶段跑过），
//      所以"忙等后立刻读"会读到 0，而那一读的重置会让尖峰**彻底消失**（随后一读只剩 ~31 ms 基线）。
//      本测试因此走真实顺序：读 → 忙等 → **让出一拍** → 再读，并断言 `max` 记得住这次忙等。
//   ④ 契约不破：原有 12 个核心字段一个不少（`协作/README.md` §1：加字段可以，改名/删字段不行）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.js';

/** `/healthz` 的既有核心字段（契约）。 */
const CORE = ['ok', 'version', 'app', 'uptimeSec', 'build', 'sockets', 'sessions', 'rooms', 'matches', 'humans', 'bots', 'spectators'];
const healthz = async (port) => (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
const start = () => startServer({ port: 0, host: '127.0.0.1', quiet: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('/healthz: mem 与 loop 存在、形状正确；12 个核心字段一个没少', async () => {
  const srv = await start();
  try {
    const b = await healthz(srv.port);
    for (const k of CORE) assert.ok(k in b, `核心字段 ${k} 丢了（契约：只能加，不能删/改名）`);
    assert.equal(typeof b.mem, 'object');
    assert.ok(b.mem.rss > 0 && b.mem.heapUsed > 0, `RSS/heap 应是正数 MB，实测 ${JSON.stringify(b.mem)}`);
    assert.ok(b.mem.heapUsed <= b.mem.rss, 'heapUsed 不可能大于 rss');
    assert.equal(typeof b.loop, 'object');
    for (const k of ['upMs', 'count', 'p50', 'p99', 'max']) {
      assert.ok(Number.isFinite(b.loop[k]), `loop.${k} 应是数字，实测 ${JSON.stringify(b.loop)}`);
    }
    assert.ok(b.loop.p50 <= b.loop.p99 && b.loop.p99 <= b.loop.max, `分位应单调：${JSON.stringify(b.loop)}`);
  } finally { await srv.close(); }
});

test('loop 记得住一次真正的阻塞 —— 且【前一个服务器 close 过】之后仍然量得到（回归护栏）', async () => {
  // 先起一个、读一次、关掉：防止有人把直方图改回"每实例一个、close 时 disable"那种写法。
  const first = await start();
  try { await healthz(first.port); } finally { await first.close(); }

  const srv = await start();
  try {
    const before = await healthz(srv.port);        // 读一次（这条不再重置，但先确认字段是活的）
    const t0 = Date.now();
    while (Date.now() - t0 < 120) { /* 故意阻塞事件循环：直方图必须看见它 */ }
    const blocked = Date.now() - t0;
    await sleep(80);                               // ⚠️ 让 ELD 的定时器把这次阻塞记下来（样本是懒落地的）

    const after = await healthz(srv.port);
    assert.ok(after.loop.max >= 50, `忙等 ${blocked} ms 后 loop.max 应 ≥ 50 ms，实测 ${after.loop.max}`
      + '（恒为基线 ⇒ 要么直方图没在量，要么又被改成了"读后即重置"而把尖峰丢掉）');
    assert.ok(after.loop.max >= before.loop.max, '累计值不该倒退（它不重置）');
    assert.ok(after.loop.count >= 0 && Number.isFinite(after.loop.upMs), `形状应稳定：${JSON.stringify(after.loop)}`);
  } finally { await srv.close(); }
});

test('/healthz 读过之后 close() 能干净收尾（直方图不许把进程吊住）', async () => {
  const srv = await start();
  await healthz(srv.port); // 触发惰性创建
  await srv.close();
  // 这条测试文件本身能跑完、进程能自然退出，就是这条断言的全部意义。
  assert.ok(true);
});
