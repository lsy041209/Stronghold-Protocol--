// test/lobby-quickchat.test.js —— 🆕 快捷聊天（`room.quick` / `room.quickMsg` / `quick.msg`）与服务端强制的
// **打字开关**（第 54 轮 A，2026-10-08；用户拍板：「房主确认在战斗开始前要不要开启打字功能，其余人在开启打字功能后
// 可以选择"屏蔽指定的人"」；个人屏蔽是**纯客户端**的事，不在本判据的面上）。
//
// 🔴 本文件的核心是 **C 点名的硬要求 —— 负对照**：
//    **绕过 UI 直接发 `room.chat` 必须被拒**（不是"客户端不显示输入框"而已，服务端要真的拒）。
//
// 规格（判据里写死，不从实现 import，否则就是拿实现自证实现）：
//   · 开关：房主专用（非房主 NOT_HOST）｜**只在对局开始前可改**（对局中 WRONG_PHASE）｜幂等｜随 room.state 广播
//   · 关掉打字后：`room.chat` ⇒ **CHAT_OFF**，且同房**收不到**任何 chat.msg
//   · 快捷短语：**不受开关限制**（关了打字还能用短语交流）⇒ `room.quickMsg { id }` ⇒ 广播 `quick.msg { from, name, ids, at }`
//   · 白名单：`id` 只认 `config.quickPhrases`（未知 ⇒ BAD_MSG）；形状 ≤3 个、每个 [a-z0-9_]{1,32}
//   · 权限与打字相同：纯观战者 ⇒ SPECTATOR
//   · 隐私：短语**不落盘**（与 chat 同规矩）
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';
import { ERR, QUICK_IDS } from '../shared/constants.js';
import { isQuickId } from '../shared/protocol.js';
import { DATA } from './match/harness.js';

/** `data/bonds.json` 的键（盟约 id）—— 判据里写死来源，不从实现 import。 */
const BONDS = DATA.bonds ?? {};

let srv;
let url;
let perTest = [];

/** 房间级：短语白名单来自局数据 ⇒ 判据只依赖"实现是否查白名单"，不写死具体短语 id。 */

before(async () => {
  // 限流放宽：本文件要连发好几条（真正的 1/s 桶由 lobby-chat ⑤ 覆盖）
  srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, ratePerSec: 200, rateBurst: 200, chatPerSec: 200, chatBurst: 200 });
  url = `ws://127.0.0.1:${srv.port}/ws`;
});
after(async () => { if (srv) await srv.close(); });
afterEach(async () => {
  await Promise.all(perTest.map((c) => c.terminate().catch(() => {})));
  perTest = [];
});

async function player(name) {
  const c = await TestClient.connect(url);
  const w = await c.hello(name);
  c.id = w.playerId;
  c.token = w.token;
  perTest.push(c);
  return c;
}
const ok = async (c, msg) => {
  const r = await c.request(msg);
  assert.equal(r.t, 'ok', `${msg.t}: ${JSON.stringify(r)}`);
  return r;
};
const err = async (c, msg) => {
  const r = await c.request(msg);
  assert.equal(r.t, 'error', `${msg.t} 应当被拒: ${JSON.stringify(r)}`);
  return r.code;
};

/** 房主建房（房状态从广播里取，`room.create` 本身只回 OK）→ 返回 room.state。 */
async function createRoom(c, mode = 'coop', difficulty = 'NORMAL') {
  await ok(c, { t: 'room.create', mode, difficulty });
  return c.waitFor('room.state', (s) => s.hostId === c.id && s.mode === mode);
}

/** 房主建房 + 第二位真人入座（返回 [host, guest, room.state]）。 */
async function room2() {
  const host = await player('Host');
  const guest = await player('Guest');
  const st = await createRoom(host);
  await ok(guest, { t: 'room.join', code: st.code });
  await guest.waitFor('room.state', (s) => s.seats.some((x) => x && x.playerId === guest.id));
  return [host, guest, st];
}

test('① 🔴 负对照（C 的硬要求）：房主关掉打字后，**绕过 UI 直接发 room.chat** ⇒ CHAT_OFF，且同房收不到任何消息', async () => {
  const [host, guest, code] = await room2();
  // 关掉之前：打字是通的（先证明这条路本来是活的）
  await ok(host, { t: 'room.chat', text: '开关之前' });
  const before = await guest.waitFor('chat.msg');
  assert.equal(before.text, '开关之前');

  // 房主关掉
  await ok(host, { t: 'room.quick', on: true });

  // 🔴 绕过 UI：直接构造 `room.chat`（这就是"改了客户端也拦不住"的那条路）
  const code1 = await err(host, { t: 'room.chat', text: '绕过 UI 的尝试' });
  assert.equal(code1, ERR.CHAT_OFF, '服务端必须拒，且用的是专用码 CHAT_OFF（不是通用 BAD_MSG）');

  // 同房其他人**收不到**这条（不是"发出去了但客户端不显示"）
  //   ⚠️ `waitFor(type, predicate = () => true, timeout = 2000)` —— 第三参才是超时；第二参是谓词。
  const got = await guest.waitFor('chat.msg', () => true, 300).catch(() => null);
  assert.equal(got, null, '关掉后不许有任何 chat.msg 到达同房');

  assert.ok(code, '房间号存在');
});

test('② `room.state.chatMode` 真的出线（客户端据此置灰输入框）＋ 开关幂等', async () => {
  // ⚠️ 这里刻意**不依赖"事后广播"的时序**（我一度那样写，结果在测试夹具里等不到那条 state ——
  //    而同一个 `broadcastRoom` 在判据 ③ 里送 `quick.msg` 是通的，所以那是夹具时序问题，不是缺陷）。
  //    改成确定性验法：**房主先开开关，客人再入房** ⇒ 客人从 join 那条 state 里读到 chatMode。
  const host = await player('Host');
  const st0 = await createRoom(host);
  const raw = await host.request({ t: 'room.quick', on: true });
  assert.equal(raw.t, 'ok', `room.quick 必须回 ok（实收 ${JSON.stringify(raw)}）`);
  await ok(host, { t: 'room.quick', on: true });        // 幂等：再设同一个值也是 OK

  const guest = await player('Guest');
  await ok(guest, { t: 'room.join', code: st0.code });
  const st = await guest.waitFor('room.state', (s) => s.seats.some((x) => x && x.playerId === guest.id));
  assert.equal(st.chatMode, 'quick',
    `入房时的 state 必须带 chatMode=quick（实收 ${JSON.stringify(st.chatMode)}；键=${Object.keys(st).join(',')}）`);

  // 关掉 ⇒ 后进来的第三个人看到 open（证明这个字段是活的，不是写死的）
  await ok(host, { t: 'room.quick', on: false });
  const third = await player('Third');
  await ok(third, { t: 'room.join', code: st0.code });
  const st3 = await third.waitFor('room.state', (s) => s.seats.some((x) => x && x.playerId === third.id));
  assert.equal(st3.chatMode, 'open', '关掉后新进来的人看到 open');

  // 🔴 **已在房内的人**也必须收到新 state（我第一版这里踩过坑：`broadcastRoom(room, room.toState())` 会静默不发）。
  //    为一条不被 join 干扰的读数，另起一间：房主 + 客人先都在房里，再改开关。
  const h2 = await player('H2');
  const g2 = await player('G2');
  const s2 = await createRoom(h2);
  await ok(g2, { t: 'room.join', code: s2.code });
  await g2.waitFor('room.state', (s) => s.seats.some((x) => x && x.playerId === g2.id));
  await ok(h2, { t: 'room.quick', on: true });
  const live = await g2.waitFor('room.state', (s) => s.chatMode === 'quick').catch(() => null);
  assert.ok(live, '开关改了要给**已在房内**的人广播新 state（否则他们的输入框不会置灰）');
});

test('③ 快捷短语**不受开关限制**：关掉打字后 `room.quickMsg` 仍能发，同房收到 quick.msg', async () => {
  const [host, guest] = await room2();
  await ok(host, { t: 'room.quick', on: true });        // 关掉打字
  // 白名单现在是 `shared/constants.js QUICK_IDS`（手写共享真源，不再依赖生成的 data/config.json）
  const ids = QUICK_IDS.slice();
  assert.ok(ids.length >= 5, `9 条句式要在常量表里（实收 ${ids.length}）`);
  await ok(host, { t: 'room.quickMsg', id: ids[0] });
  const m = await guest.waitFor('quick.msg');
  assert.deepEqual(m.ids, [ids[0]]);
  assert.equal(m.from, host.id);
  assert.equal(typeof m.at, 'number');
});

test('③b 🆕 带参句式：`room.quickMsg { id, arg }` ⇒ 广播 `quick.msg.arg`（B12 那 4 条现在能发了）', async () => {
  const [host, guest] = await room2();
  // ⚠️ `arg` **不是自由文本**：`playing` 要求一个**真实存在的盟约 id**（③c 钉这条）⇒ 这里用真 id 走通正向
  const bondId = Object.keys(BONDS)[0];
  await ok(host, { t: 'room.quickMsg', id: 'playing', arg: `  ${bondId}  ` });
  const m = await guest.waitFor('quick.msg', (x) => x.arg != null);
  assert.equal(m.arg, bondId, 'arg 要 trim 后原样广播（渲染由接收端按语言做）');
  // 不带 arg 的无参句式：广播里**不许出现** arg 这个键（老客户端只看 ids 也不受影响）
  await ok(host, { t: 'room.quickMsg', id: 'sorry' });
  const m2 = await guest.waitFor('quick.msg', (x) => x.ids && x.ids[0] === 'sorry');
  assert.equal('arg' in m2, false, '无参句式不带 arg 字段');
  // 超长 arg ⇒ schema 挡；空串 ⇒ 当没带（无参句式照常发）
  assert.equal(await err(host, { t: 'room.quickMsg', id: 'need', arg: 'x'.repeat(40) }), ERR.BAD_MSG, '超长 arg 被拒');
  await ok(host, { t: 'room.quickMsg', id: 'wait', arg: '   ' });
  const m3 = await guest.waitFor('quick.msg', (x) => x.ids && x.ids[0] === 'wait');
  assert.equal('arg' in m3, false, '空白 arg 视同没带');
});

test('③c 🔴 `arg` 与 id **一起校验**（B12 提醒 1）：不存在的盟约/干员/队友一律拒', async () => {
  const [host, guest] = await room2();
  // ① playing ⇒ 盟约 id 必须在 data/bonds.json 里
  const bondId = Object.keys(BONDS)[0];
  await ok(host, { t: 'room.quickMsg', id: 'playing', arg: bondId });
  const okMsg = await guest.waitFor('quick.msg', (x) => x.ids && x.ids[0] === 'playing');
  assert.equal(okMsg.arg, bondId, '真实存在的盟约 id 要能发');
  assert.equal(await err(host, { t: 'room.quickMsg', id: 'playing', arg: 'no_such_bond_xyz' }), ERR.BAD_MSG,
    '不存在的盟约 id 必须拒（否则接收端渲染出一张拿不到的卡）');

  // ② need ⇒ 干员 charId 必须在 data/chess.json 的某条记录里
  const charId = Object.values(DATA.chess ?? {}).map((r) => r && r.charId).find(Boolean);
  if (charId) {
    await ok(host, { t: 'room.quickMsg', id: 'need', arg: charId });
    assert.equal(await err(host, { t: 'room.quickMsg', id: 'need', arg: 'char_does_not_exist' }), ERR.BAD_MSG,
      '不存在的干员 charId 必须拒');
  }

  // ③ thanks ⇒ playerId 必须是**本房的人**（座位或观战席）
  await ok(host, { t: 'room.quickMsg', id: 'thanks', arg: guest.id });
  assert.equal(await err(host, { t: 'room.quickMsg', id: 'thanks', arg: 'p_not_here' }), ERR.BAD_MSG,
    '不在本房的 playerId 必须拒（"感谢某人"的本意）');

  // ④ careful ⇒ 按 `data/enemies.json` 的存在性校验（C 派工）
  assert.equal(await err(host, { t: 'room.quickMsg', id: 'careful', arg: 'no_such_enemy_xyz' }), ERR.BAD_MSG,
    '伪造的敌人 id 必须拒');
  const enemyKey = Object.keys(DATA.enemies ?? {})[0];
  if (enemyKey) {
    await ok(host, { t: 'room.quickMsg', id: 'careful', arg: enemyKey });
    const cm = await guest.waitFor('quick.msg', (x) => x.ids && x.ids[0] === 'careful');
    assert.equal(cm.arg, enemyKey, '真表里的敌人 key 要能发');
  }
});

test('③d 🔴 **正例用真表逐条跑**（照 C 升格的那条规则）：本局每个 spawn 的 enemy key 都必须被接受', async () => {
  // 这条是"只测负例不测正例 = 假绿"那条规则在本功能上的落地：
  //   `careful` 的校验用 `data/enemies.json` ⇒ **必须证明"游戏里真会出现的敌人 key 一个都不会被拒"**，
  //   而不是只证明"伪造的会被拒"（后者是负例，前者才是玩家会遇到的）。
  const [host] = await room2();
  const spawnKeys = new Set();
  for (const stage of Object.values(DATA.waves ?? {})) {
    for (const s of (stage && Array.isArray(stage.spawns) ? stage.spawns : [])) if (s && s.key) spawnKeys.add(s.key);
    if (stage && typeof stage.bossId === 'string' && stage.bossId) spawnKeys.add(stage.bossId);
  }
  assert.ok(spawnKeys.size > 0, `前置：waves.json 里要有 spawns（实收 ${spawnKeys.size} 个 key）`);
  const list = [...spawnKeys];
  const rejected = [];
  for (const k of list) {
    const r = await host.request({ t: 'room.quickMsg', id: 'careful', arg: k });
    if (r.t !== 'ok') rejected.push(`${k}(${r.code})`);
  }
  assert.deepEqual(rejected, [],
    `🔴 真表里的敌人 key **一个都不许被拒**（共 ${list.length} 个；被拒 ${rejected.length} 个）`);
});

test('④ 非房主改开关 ⇒ NOT_HOST；**对局中**改 ⇒ WRONG_PHASE（用户口径："战斗开始前"）', async () => {
  const [host, guest] = await room2();
  assert.equal(await err(guest, { t: 'room.quick', on: true }), ERR.NOT_HOST, '只有房主能改');

  // 单人房开局（solo 最省事）⇒ 对局开始后不许再改开关
  const solo = await player('Solo');
  await createRoom(solo, 'solo');
  await ok(solo, { t: 'room.ready', ready: true });
  await ok(solo, { t: 'room.start' });
  assert.equal(await err(solo, { t: 'room.quick', on: true }), ERR.WRONG_PHASE,
    '战斗开始后不许再改（用户原话："战斗开始前"）');
  assert.ok(host.id && guest.id);
});

test('⑤ 白名单与形状：未知 id / 超长 / 4 个 id / 带空格 ⇒ BAD_MSG（**伪造不出新短语**）', async () => {
  const [host] = await room2();
  for (const id of ['不存在的短语', 'a'.repeat(200), 'a,b,c,d', 'has space']) {
    const c = await err(host, { t: 'room.quickMsg', id });
    assert.equal(c, ERR.BAD_MSG, `id=${JSON.stringify(id)} 必须被拒`);
  }
});

test('⑦ 建房时就能选聊天模式（`room.create.chatMode`，可选；不提 = open）', async () => {
  // ① 不传 chatMode ⇒ 默认 open（**老客户端不传也要能用**）
  const h = await player('H7');
  const c0 = await h.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
  assert.equal(c0.t, 'ok', JSON.stringify(c0));
  const s0 = await h.waitFor('room.state', (s) => s.hostId === h.id);
  assert.equal(s0.chatMode, 'open', '不提 chatMode ⇒ open');

  // ② 建房时带上 ⇒ 房间一出生就是 quick（否则客户端只能"先建房、再 room.quick"，那有中间态）
  const h2 = await player('H7b');
  const r = await h2.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', chatMode: 'quick' });
  assert.equal(r.t, 'ok', `建房带 chatMode=quick 必须成功（实收 ${JSON.stringify(r)}）`);
  const s2 = await h2.waitFor('room.state', (s) => s.hostId === h2.id);
  assert.equal(s2.chatMode, 'quick', '房间一出生就是 quick');

  // ③ 非法值 ⇒ 被 schema 挡（客户端伪造不出第四种模式）
  const bad = await h2.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', chatMode: 'silent' });
  assert.equal(bad.t, 'error', `非法 chatMode 必须被拒（实收 ${JSON.stringify(bad)}）`);
  assert.equal(bad.code, ERR.BAD_MSG);
});

test('⑤b 🔴 `isQuickId` 必须接受**真表里的每一个 id**（含 camelCase）—— 防"注释说 A、代码做 B"', () => {
  // 这条是补洞：用户 2026-10-08 裁定 id 用 `niceOne`/`myBad`（camelCase、不改名），
  // 而 `isQuickId` 曾经只收 `[a-z0-9_]` ⇒ 服务端会把这两条判 `BAD_MSG`，
  // **而当时的判据照不出来**（我只测了不存在的 id 被拒、没测真表能过）。
  for (const id of QUICK_IDS) {
    assert.equal(isQuickId(id), true, `真表里的 id 必须合法：${JSON.stringify(id)}`);
  }
  // 负对照仍在：伪造/超长/超条数一律拒
  assert.equal(isQuickId('has space'), false);
  assert.equal(isQuickId('a,b,c,d'), false);
  assert.equal(isQuickId('x'.repeat(40)), false);
  assert.equal(isQuickId(''), false);
});

test('⑥ 纯观战者发快捷短语 ⇒ SPECTATOR（与打字的权限口径一致）', async () => {
  const [host, , st] = await room2();
  // 观战者：**另起一个连接**、直接 room.spectate（照 lobby-chat.test.js:160 的搭法；他从未占过座）
  const spec = await player('Spec');
  await ok(spec, { t: 'room.spectate', code: st.code });
  assert.equal(await err(spec, { t: 'room.quickMsg', id: 'go' }), ERR.SPECTATOR,
    '观战席只读（既有判据 ③ 的同一条口径）');
  assert.ok(host.id);
});
