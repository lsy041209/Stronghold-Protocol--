// test/lobby-avatar.test.js —— 🆕 W-6 头像接入的**服务端字段与校验**（第 54 轮 A，2026-10-09）。
//   派工来源：`B12给A-W6头像接入素材已入树与要一个avatarId字段` —— 他要把**别人选的头像**广播出去，
//   所以需要一个**会话/公开态字段**。形状由 A 定稿；**判据先写、先证明能红**（本会话第 54 轮那条规矩）。
//
// 口径（与"短语只传 id、文案在 i18n"同一条）：
//   · **只收 `manifest.json` 里存在的 id**（真表校验，不是"看着像 id 就放行"）；
//   · ⛔ **协议里永远不出现文件名/路径** —— 传 URL 或 `../` 一律拒（id→`/assets/avatar/<file>` 的映射在客户端）；
//   · 空串 = **清掉**（回到默认，不报错）；
//   · `room.state` 的座位与观战席都带 `avatarId`（**公开**：别人的名片要画它）。
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';
import { ERR } from '../shared/constants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/assets/avatar/manifest.json'), 'utf8'));

let srv, url, perTest = [];
before(async () => {
  srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, ratePerSec: 200, rateBurst: 200 });
  url = `ws://127.0.0.1:${srv.port}/ws`;
});
after(async () => { if (srv) await srv.close(); });
afterEach(async () => { await Promise.all(perTest.map((c) => c.terminate().catch(() => {}))); perTest = []; });

async function player(name) {
  const c = await TestClient.connect(url);
  const w = await c.hello(name);
  c.id = w.playerId; c.token = w.token;
  perTest.push(c);
  return c;
}
const ok = async (c, msg) => { const r = await c.request(msg); assert.equal(r.t, 'ok', `${msg.t}: ${JSON.stringify(r)}`); return r; };
const err = async (c, msg) => { const r = await c.request(msg); assert.equal(r.t, 'error', `${msg.t} 应当被拒: ${JSON.stringify(r)}`); return r.code; };
async function createRoom(c, mode = 'coop', difficulty = 'NORMAL') {
  await ok(c, { t: 'room.create', mode, difficulty });
  return c.waitFor('room.state', (s) => s.hostId === c.id && s.mode === mode);
}

test('① 前置：素材 manifest 真的有 184 条、每条有 id（本判据的真表就是它）', () => {
  assert.ok(Array.isArray(MANIFEST.avatars), 'manifest.avatars 是数组');
  assert.ok(MANIFEST.avatars.length >= 100, `至少上百条（实收 ${MANIFEST.avatars.length}）`);
  for (const a of MANIFEST.avatars) assert.equal(typeof a.id, 'string', `每条都要有 id：${JSON.stringify(a)}`);
  assert.ok(MANIFEST.avatars.some((a) => a.id === 'activity_ac'), '样例 id 在表里');
});

test('② 🔴 真表逐条跑：**184 个 id 一个都不许被拒**（照"正例用真表"那条规矩）', async () => {
  const [host] = [await player('H')];
  await createRoom(host);
  const rejected = [];
  for (const a of MANIFEST.avatars) {
    const r = await host.request({ t: 'room.avatar', id: a.id });
    if (r.t !== 'ok') rejected.push(`${a.id}(${r.code})`);
  }
  assert.deepEqual(rejected, [], `🔴 真表里的头像 id 一个都不许被拒（共 ${MANIFEST.avatars.length}；被拒 ${rejected.length}）`);
});

test('③ 🔴 负对照：URL / 路径 / 未知 id / 超长 ⇒ 一律拒（**协议里不出现文件名或路径**）', async () => {
  const host = await player('H');
  await createRoom(host);
  for (const bad of [
    '/assets/avatar/activity_ac.png',      // 路径
    'https://evil.example/x.png',          // URL
    '../../etc/passwd',                    // 穿越
    'activity_ac.png',                     // 带扩展名的文件名
    'no_such_avatar_xyz',                  // 未知 id
    'x'.repeat(200),                       // 超长
  ]) {
    assert.equal(await err(host, { t: 'room.avatar', id: bad }), ERR.BAD_MSG, `必须拒：${JSON.stringify(bad)}`);
  }
});

test('④ 空串 = 清掉（回默认），不报错；且 `room.state` 的**自己**看到 null/空', async () => {
  const host = await player('H');
  const st = await createRoom(host);
  const id = MANIFEST.avatars[0].id;
  await ok(host, { t: 'room.avatar', id });
  const set = await host.waitFor('room.state', (s) => (s.seats || []).some((x) => x && x.avatarId === id));
  assert.ok(set, '设上之后 room.state 里应看到 avatarId');
  await ok(host, { t: 'room.avatar', id: '' });
  const cleared = await host.waitFor('room.state', (s) => (s.seats || []).some((x) => x && x.playerId === host.id && !x.avatarId));
  assert.ok(cleared, '清掉之后该座位上不该再有 avatarId');
  assert.ok(st.code);
});

test('⑤ **公开**：同房其他人也能在 `room.state` 里看到我的 avatarId（名片用）', async () => {
  const host = await player('H');
  const guest = await player('G');
  const st = await createRoom(host);
  await ok(guest, { t: 'room.join', code: st.code });
  await guest.waitFor('room.state', (s) => s.seats.some((x) => x && x.playerId === guest.id));
  const id = MANIFEST.avatars[1].id;
  await ok(host, { t: 'room.avatar', id });
  const seen = await guest.waitFor('room.state', (s) => s.seats.some((x) => x && x.playerId === host.id && x.avatarId === id));
  assert.ok(seen, '🔴 别人必须看得到（这是"广播"的全部意义）');
});

test('⑥ **观战席**也有这个字段（观战者也能挂头像）', async () => {
  const host = await player('H');
  const st = await createRoom(host);
  const spec = await player('S');
  await ok(spec, { t: 'room.spectate', code: st.code });
  const id = MANIFEST.avatars[2].id;
  await ok(spec, { t: 'room.avatar', id });
  const seen = await host.waitFor('room.state', (s) => (s.spectators || []).some((x) => x && x.playerId === spec.id && x.avatarId === id));
  assert.ok(seen, '观战席也要带 avatarId');
});
