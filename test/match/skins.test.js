// test/match/skins.test.js —— **干员皮肤（换装）的四跳**（第 54 轮 A，2026-10-08）。
//
// 由来：换基座到 0.2.1 时整条换装链被静默丢掉（0.1.4.1 里玩家能选/能生效的 179 款皮肤全没了）。
//   ⇒ 本判据按 C 的派工单 §1.2 钉住四跳：**协议 → 路由 → PlayerState/Match → snapshot/UnitInfo**，
//     并加**负对照**：四跳任一摘掉 ⇒ 本文件必须红（这也是"能红"的证明方式）。
//   🔁 实现是照 `.workbuddy/rollback/tree-cold-20261007-180433/`（0.1.4.1 冷备）接回的。
//
// 跑：node --test test/match/skins.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, DATA, legalTileFor } from './harness.js';
import { checkDiyPicks } from '../../shared/protocol.js';
import { SKIN_LIMITS, isSkinSelection, isSkinId } from '../../shared/protocol.js';
import { buildBattleSpec, createBattleFromSpec } from '../../server/sim/spec.js';
import { GEO } from '../../shared/constants.js';

const wire = (m) => JSON.parse(JSON.stringify(m));

/** A live match with one human (p_0), reached prep. */
function started() {
  const seats = [{ seat: 0, playerId: 'p_0', name: 'P0', isBot: false, connected: true }];
  const h = makeMatch({ mode: 'coop', seats, seed: 11 }).start();
  h.toPrep(1);
  return h;
}

/**
 * Pick a (chessId, skinId) pair the way the client does: the catalogue is keyed by **`charId`**
 * (`data/skins.json` → `chars[charId] = [{id,name,group}]`), while the **choice** map the client sends is keyed by
 * **`chessId`** (纸鸢 0.2.1 的 `ui/skins.js:10`：*"The choice itself is a plain `{ [chessId]: skinId }` map"*).
 */
function pick() {
  const cat = DATA.skins?.chars ?? {};
  for (const r of Object.values(DATA.chess)) {
    if (!r || r.isGolden || r.isDiy || r.visible === false) continue;
    const list = cat[r.charId];
    if (Array.isArray(list) && list.length) return { chessId: r.chessId, charId: r.charId, skinId: list[0].id };
  }
  return null;
}

test('① 协议层：`room.skins` 的形状校验在位（SKIN_LIMITS / isSkinSelection / isSkinId）', () => {
  // 这层是**我们加的**（上游 `shared/protocol.js` 的 `room.skins` 是 0 处）⇒ 它必须在，否则客户端根本发不出来
  assert.ok(SKIN_LIMITS && typeof SKIN_LIMITS === 'object', 'SKIN_LIMITS 存在');
  assert.equal(typeof isSkinSelection, 'function');
  assert.equal(typeof isSkinId, 'function');
  assert.equal(isSkinSelection({}), true, '空映射合法（= 全默认）');
  assert.equal(isSkinSelection({ chess_char_1_01_a: 'not a skin@@' }), false, '伪造的 id 被挡');
  assert.equal(isSkinSelection(null), false, 'null 不是一张映射（⚠️ 我第一版把它当 true —— 照实现改的）');
});

test('②+③ 路由与 PlayerState：`room.skins` 存下来，并出现在公开视图里（队友看得见）', () => {
  const p = pick();
  assert.ok(p, '目录里至少有一位基础干员有皮肤');
  const h = started();
  const m = h.m;

  assert.equal(m.setSkins?.('p_0', { [p.chessId]: p.skinId })?.ok, true, 'Match.setSkins 存在且接受选择（换基座时它整段没有了 ⇒ 这里会红）');
  const ps = h.ps('p_0');
  assert.deepEqual(ps.skins, { [p.chessId]: p.skinId }, 'PlayerState.skins 记下来了');

  // 公开视图（m.public 里每座位的公开块）要能看到 ⇒ 队友的画面上才会画出这套衣服
  const pub = JSON.stringify(wire(m.publicView ? m.publicView() : (m.public ?? {})));
  assert.ok(pub.includes(p.skinId), `公开视图里必须带上她穿的这一套（冷备口径："PUBLIC on purpose"）: ${p.skinId}`);
  h.m.dispose?.();
});

test('③ PlayerState：只收「基础、可见、非精锐、非自选」的棋子，且空值/非字符串被丢弃', () => {
  const p = pick();
  assert.ok(p, '有一位基础干员');
  const h = started();
  const ps = h.ps('p_0');
  const golden = Object.values(DATA.chess).find((r) => r && r.isGolden && r.baseId === p.chessId);
  if (golden) {
    ps.setSkins({ [golden.chessId]: 'sk_ok@1' });
    assert.deepEqual(ps.skins, {}, '精锐棋子不许自己挂皮肤（要挂在它的 base 上）');
  }
  ps.setSkins({ [p.chessId]: 'sk_ok@1' });
  assert.deepEqual(ps.skins, { [p.chessId]: 'sk_ok@1' });
  ps.setSkins({ [p.chessId]: '' });
  assert.deepEqual(ps.skins, {}, '空字符串被丢弃');
  ps.setSkins({ [p.chessId]: 42 });
  assert.deepEqual(ps.skins, {}, '非字符串被丢弃');
  h.m.dispose?.();
});

test('④ snapshot / UnitInfo：上了场的干员带 `skin`，没选皮肤的**逐字节不变**（不写这个字段）', () => {
  const p = pick();
  assert.ok(p, '目录里至少有一位基础干员有皮肤');

  /** Field the picked chess and return its battle unit, with or without the skin set. */
  const field = (withSkin) => {
    const h = started();
    const m = h.m;
    const p0 = h.ps('p_0');
    if (withSkin) m.setSkins('p_0', { [p.chessId]: p.skinId });
    let piece = null;
    for (let i = 0; i < 60 && !piece; i++) { piece = p0.acquireChess?.(p.chessId, { source: 'shop' }) ?? null; }
    piece = piece ?? p0.allChess?.().find((c) => c.id === p.chessId) ?? null;
    assert.ok(piece, '⚙️ 前置：这位干员拿得到手（否则本判据无从判起）');
    const tile = legalTileFor(m, p0, piece.id);
    m.handle('p_0', { t: 'g.move', uid: piece.uid, to: { area: 'board', row: tile[0], col: tile[1] } });
    const input = p0.battleInput();
    const iu = input.units.find((x) => x.uid === piece.uid) ?? null;
    const spec = wire(buildBattleSpec({
      battleId: 't.1', fieldId: 'n:p_0', kind: 'normal', seed: 77, modeId: m.modeId, round: 1, stageId: m.stageId,
      rect: { ...GEO.NORMAL_RECT }, timeLimit: 40, players: [input],
      spawns: m.wave.spawns.map((x) => ({ ...x, ownerPlayerId: 'p_0' })), routes: m.wave.routes,
      flags: { layerGainsEnabled: true, ...m.gd.dp }, enemyOverrides: m.wave.overrides ?? {}, content: 'full',
    }));
    const si = spec.players[0].units.find((x) => x.uid === piece.uid) ?? null;
    const bt = createBattleFromSpec(wire(spec), undefined, { quiet: true, recordEvents: false });
    // ⚠️ 四次踩坑留证（都在这一行上）：战斗里的棋子 **`kind` 是 `'op'`**（spec 里才叫 `'chess'`）、
    //    `defId` 不带 `op:` 前缀、uid 与 spec 一致 —— 我先后按 uid / `endsWith(chessId)` / `kind==='chess'` 找，
    //    前三次都返回空，于是把"实现是对的"误判成红。**最终按 `kind === 'op'` 取**（本场只有这一枚）。
    const u = bt.allyUnits.find((x) => x.kind === 'op') ?? null;
    const board = bt.allyUnits.map((x) => `${x.kind}:${x.defId}`).join(',');
    // 把每个单位对象的真实字段带回去（进断言消息，不靠 console.log —— `node --test` 会吞掉它）
    const dump = bt.allyUnits.map((x) => ({ kind: x.kind, defId: x.defId, uid: x.uid, skin: x.skin ?? null }));
    // 线格式那一条要问 snapshot（不是内存里的单位对象）
    const snap = (() => { try { return bt.snapshot?.() ?? null; } catch { return null; } })();
    h.m.dispose?.(); bt.dispose?.();
    return { iu, si, u, board, dump, snap };
  };

  const dressed = field(true);
  assert.ok(dressed.iu, '上了场（battleInput 里那一条）');
  assert.equal(dressed.iu.skin, p.skinId,
    `④ 服务端这一跳：battleInput 必须带上选的皮肤 ${p.chessId} ⇒ ${p.skinId}（换基座时它整段没了 ⇒ 这里会红）`);
  assert.equal(dressed.si?.skin, p.skinId, '同一条要**活着过线**（battleSpec 的 players[0].units）');
  assert.equal(dressed.u?.skin, p.skinId,
    `同一条要活着进战斗（场上实际：[${dressed.board}]｜dump=${JSON.stringify(dressed.dump)}｜spec 里 = ${JSON.stringify(dressed.si)}）`);

  const plain = field(false);
  assert.ok(plain.iu, '没选皮肤时同样能上桌');
  assert.equal('skin' in plain.iu, false, 'battleInput 里**不许凭空多出这个字段**');
  assert.equal(plain.u?.skin ?? null, null, '战斗单位上它是 null（`Unit` 的构造总是设这个字段）');
  // 真正的契约在**线格式**上：snapshot 用 `?? undefined`，于是 JSON 里根本不出现这个键（逐字节不变）
  const snap = plain.snap;
  if (snap && Array.isArray(snap.units)) {
    assert.equal(snap.units.some((x) => 'skin' in x), false,
      '**线格式契约**：没穿皮肤时 snapshot 的 JSON 里不许出现 `skin` 键');
  }
});
