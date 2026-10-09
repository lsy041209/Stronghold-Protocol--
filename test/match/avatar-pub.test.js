// test/match/avatar-pub.test.js —— 🆕 W-6 头像**局内公开块**（C 派工：把 `avatarId` 放进 `pub.players[]`，
//   解锁 B12 的"局内看别人的头像"）。第 54 轮 A，2026-10-09。
//
// 四跳（与 `test/match/skins.test.js` 同形）：
//   ① 建座时 `seat.avatarId` ⇒ ② `PlayerState.avatarId` ⇒ ③ `publicView().players[].avatarId` ⇒ ④ 线上可 JSON 化
// ⚠️ **空则不带这个键**（与 `skins` 同族）：没挑头像的玩家给每一帧 `m.public` 加 **0 字节**。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeMatch } from './harness.js';

// ⚠️ 本文件在 `test/match/` 下 ⇒ 要**退两层**才是树根（`test/match` → `test` → 根）。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/assets/avatar/manifest.json'), 'utf8'));
const AID = MANIFEST.avatars[0].id;          // 真表里的第一个 id（真表逐条跑的"正例"）

const wire = (x) => JSON.parse(JSON.stringify(x));   // 线上就是 JSON（`encode()`）

/** 一场打到 prep 的活对局，一座位带 `avatarId`（模拟大厅建座时的 `seat.avatarId`）。 */
function started(avatarId) {
  const seats = [{ seat: 0, playerId: 'p_0', name: 'P0', isBot: false, connected: true, avatarId }];
  const h = makeMatch({ mode: 'coop', seats, seed: 11 }).start();
  h.toPrep(1);
  return h;
}

test('① 前置：素材 manifest 里有一条 id 可当正例', () => {
  assert.equal(typeof AID, 'string');
  assert.ok(AID.length > 0, `manifest.avatars[0].id = ${JSON.stringify(AID)}`);
});

test('② 🔴 四跳：`seat.avatarId` ⇒ `PlayerState.avatarId` ⇒ `m.public.players[].avatarId`（线上可 JSON 化）', () => {
  const h = started(AID);
  // ② PlayerState 收到了（建座 ⇒ Match 开局）
  const ps = h.ps('p_0');
  assert.equal(ps.avatarId, AID, 'PlayerState.avatarId 必须从 seat 带过来（这是四跳的第一跳）');
  // ③ 公开块
  const pub = wire(h.m.publicView ? h.m.publicView() : (h.m.public ?? {}));
  const me = (pub.players ?? []).find((x) => x && x.playerId === 'p_0');
  assert.ok(me, `publicView().players[] 里必须有 p_0（实收 ${JSON.stringify((pub.players ?? []).map((x) => x && x.playerId))}）`);
  assert.equal(me.avatarId, AID, '🔴 队友要能在 `m.public` 里看到我的头像 id（这就是本派工的全部意义）');
});

test('③ 🔴 负对照：**没挑头像时那一帧里没有 `avatarId` 这个键**（0 字节，与 `skins` 同规矩）', () => {
  const h = started(undefined);
  const ps = h.ps('p_0');
  assert.equal(ps.avatarId, '', "缺省是空串（不是 undefined）⇒ 下游判断只需看 truthy");
  const pub = wire(h.m.publicView ? h.m.publicView() : (h.m.public ?? {}));
  const me = (pub.players ?? []).find((x) => x && x.playerId === 'p_0');
  assert.ok(me, 'p_0 在 players[] 里');
  assert.equal(Object.hasOwn(me, 'avatarId'), false,
    `🔴 没挑头像就不许带这个键（否则每帧给所有观众多几百字节 × 玩家数）；实收 ${JSON.stringify(me.avatarId)}`);
});

test('④ 只传 id、**绝不出现文件名或路径**（形状层已挡；这里钉住"存下来的也必须只是 id"）', () => {
  const h = started(AID);
  const ps = h.ps('p_0');
  assert.ok(!ps.avatarId.includes('/'), '不得含 /');
  assert.ok(!ps.avatarId.includes('.'), '不得含 .（带扩展名的文件名在这一层不可能存在）');
  assert.ok(MANIFEST.avatars.some((a) => a.id === ps.avatarId), '必须是真表里的 id');
});
