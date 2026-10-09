// test/ui/quick-chat.test.js — **快捷聊天（纯逻辑）的判据**（2026-10-08 第 12 任 B；C 派工 B-C1/B-C2/B-C4 的客户端那半）
//
// 为什么先钉纯逻辑：面板里的"画"要靠 DOM 遍历测，而**真正会静默出错的**是这些判断——
//   · 哪个 id 能发（未知/带参的**必须被挡在本地**，别等服务端 `BAD_MSG`）；
//   · 收到的 `quick.msg` 怎么收敛（未知 id、类型不对、`ids` 超 3 个）；
//   · `chatMode` 的**读法**（`'quick'` 置灰；**缺省也必须不许打字** —— 否则玩家打一段字被服务端 `CHAT_OFF` 拒）；
//   · 个人屏蔽只影响**显示**、别动历史（用户第 3 点"旧历史不隐藏"），且**只丢被屏蔽者**（负对照）。
//
// ⚠️ 本文件**不建 DOM**（与 `chat-model.test.js` 同一套路），所以任何机器上都能跑。
// Run: node --test test/ui/quick-chat.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  QUICK_IDS, QUICK_PHRASES, QUICK_ID_SET, QUICK_ARG_IDS, QUICK_PARAMLESS_IDS,
  quickPhraseOf, quickMsgPayload, canSendQuickNow, normalizeQuickMessage, appendQuick,
  quickTextOf, canTypeInRoom, canToggleTextChat, textChatSwitch, quickBlockReason,
  cleanMuted, isMuted, toggleMuted, filterMuted, messageKey, posForCollapse, clampPanelSize,
} from '../../public/js/ui/chatModel.js';
import { isQuickId } from '../../shared/protocol.js';
import { quickArgOptions, QUICK_ARG_OPTION_CAP, chessTiers, chessBondsInTier, enemyKeysForStage } from '../../public/js/ui/quickArgs.js';

/**
 * 🔴 **豁免表（只许列这里）**：2026-10-08 早先 `niceOne`/`myBad` 被**树里的**协议校验器
 * （`/^[a-z0-9_]{1,32}$/`，只小写）拒掉 ⇒ 客户端**诚实置灰**。**A 已放宽字符类**（本条判据第 2 次跑红
 * 就是在报"豁免表该清空了"）⇒ 现在**空表**：9 条全部能发。
 * ⚠️ 双向规则仍然有效：① 出现新的"被拒且不在豁免里" ⇒ 红；② 全部都能过而豁免表非空 ⇒ 也红。
 */
const WIRE_REJECTED_PENDING_A_FIX = [];

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PACKS = ['en', 'ja', 'ko', 'zh-TW'].map((l) => [l, JSON.parse(readFileSync(path.join(ROOT, `public/i18n/${l}.json`), 'utf8'))]);

/** C 定稿的 9 条（顺序＝面板顺序）—— 与 `协作/C-派工-局内聊天固定句式与房间开关…` §3 的表逐字一致。 */
const DEFINED = ['playing', 'need', 'thanks', 'sorry', 'wait', 'help', 'careful', 'niceOne', 'myBad'];

test('9 条句式：id 与顺序 = 用户定稿；每条 msgid 都在四语包里（把"清单 ↔ 文案"钉在一起）', () => {
  assert.deepEqual([...QUICK_IDS], DEFINED);
  assert.equal(QUICK_PHRASES.length, 9);
  assert.equal(QUICK_ID_SET.size, 9, 'id 不许重复');
  for (const p of QUICK_PHRASES) {
    assert.equal(quickPhraseOf(p.id)?.msgid, p.msgid);
    for (const [lang, pack] of PACKS) {
      assert.ok(typeof pack[p.msgid] === 'string' && pack[p.msgid].trim(), `${lang} 包缺「${p.msgid}」`);
    }
  }
  // 需要参数的那 4 条 = playing/need/thanks/careful（**当前协议带不了参数** ⇒ 它们在 sendable 里必须被挡）
  assert.deepEqual([...QUICK_ARG_IDS], ['playing', 'need', 'thanks', 'careful']);
  assert.deepEqual([...QUICK_PARAMLESS_IDS], ['sorry', 'wait', 'help', 'niceOne', 'myBad']);
});

test('能发的 id：未知 id 被挡；**负对照**：无参的必须能发（带参的那 4 条要等选了参数，见下一条）', () => {
  assert.deepEqual(quickMsgPayload([{ id: 'sorry' }, { id: 'wait' }])?.id, 'sorry,wait');
  assert.equal(quickMsgPayload([{ id: 'nope' }, { id: '', id2: 1 }]), null, '未知 id 一个都不发');
  assert.equal(quickMsgPayload([{ id: 'need' }]), null, '🔴 带参的没选参数 ⇒ 不发（面板据此禁用，而不是发半句话）');
  assert.equal(quickMsgPayload(null), null);
  // 负对照：无参的**一定**能发（**除了**协议校验器不认的那两条，见下面那条"校验器"判据）
  for (const id of QUICK_PARAMLESS_IDS) {
    if (WIRE_REJECTED_PENDING_A_FIX.includes(id)) continue;
    assert.ok(quickMsgPayload([{ id }]), `${id} 应当能发`);
  }
});

test('带参句式的候选项（`quickArgOptions`，纯函数）：来源、过滤、名字、上限都对', () => {
  // 干员：🔴 2026-10-08 改成**以 chess 表为准**（值＝`charId`，A 的口径）；夹具也照这个形状给
  const data = {
    get: (f) => ({
      bonds: { yanShip: { name: '炎' }, sargonShip: { name: '萨尔贡' }, offShip: { name: '禁用的' } },
      chess: {
        chess_char_1_01_a: { name: '阿米娅', charId: 'char_002_amiya', visible: true, bonds: ['yanShip'] },
        chess_char_1_01_b: { name: '阿米娅', charId: 'char_002_amiya', visible: true, bonds: ['yanShip'] },   // 同干员另一形态 ⇒ 去重
        chess_char_2_02_a: { name: '凯尔希', charId: 'char_003_kalts', visible: true, bonds: ['sargonShip'] },
        chess_char_9_99_a: { name: '隐藏的', charId: 'char_hidden', visible: false, bonds: ['yanShip'] },
      },
      backups: {
        diy: { ownedPool: ['char_002_amiya', 'char_003_kalts'], prototypes: { 5: ['char_002_amiya', 'char_010_chen'] } },
        units: { char_002_amiya: { name: '阿米娅' }, char_003_kalts: { name: '凯尔希' }, char_010_chen: { name: '陈' } },
      },
    }[f] ?? null),
  };
  // ⚠️ 名字排序用的是 `localeCompare`（**随语言环境变**）⇒ 判据里用**同一个比较器**算期望，不写死中文顺序
  const byLabel = (a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value);
  // 盟约：**禁用盟约必须被排除**（列出来只会误导）
  const bondWant = [{ value: 'sargonShip', label: '萨尔贡' }, { value: 'yanShip', label: '炎' }].sort(byLabel);
  assert.deepEqual(quickArgOptions('bond', { data, pub: { disabledBonds: ['offShip'] } }), bondWant);
  assert.deepEqual(quickArgOptions('bond', { data, pub: { drawnDisabledBonds: ['offShip'] } }).map((x) => x.value),
    bondWant.map((x) => x.value), 'drawnDisabledBonds 也认（两个字段名都防着）');
  // 🆕 三级选择（阶级 → 盟约 → 干员）：用**真 data 夹具**跑，含负对照
  test('三级选择：阶级列表非空且升序；按阶级/盟约收敛；🔴 负对照：结果里不许混进别的阶级/盟约', () => {
    const C = JSON.parse(readFileSync(path.join(ROOT, 'data/chess.json'), 'utf8'));
    const tiers = chessTiers(C);
    assert.ok(tiers.length > 1, '应当有多个阶级');
    assert.deepEqual(tiers, [...tiers].sort((a, b) => a - b), '阶级升序');
    const t = tiers[tiers.length - 1];
    const bondsInT = chessBondsInTier(C, t);
    assert.ok(bondsInT.length > 0, `${t} 阶应当有盟约`);
    const opts = quickArgOptions('chess', { data: { get: () => C }, tier: t, bond: bondsInT[0] });
    assert.ok(opts.length > 0, `${t} 阶 + ${bondsInT[0]} 应当有干员`);
    const recs = Object.values(C);
    for (const o of opts) {
      // 🔴 负对照：该 charId **必须**存在一条"可见且 tier＝t 且含该盟约"的记录（否则就是混进来了）
      assert.ok(recs.some((r) => r.charId === o.value && r.visible !== false && r.isHidden !== true
        && Number(r.tier) === Number(t) && (r.bonds || []).includes(bondsInT[0])), `${o.value} 不属于 ${t} 阶/${bondsInT[0]}`);
    }
    // 负对照（反面）：换一个盟约，结果集必须不同
    const other = bondsInT.find((b) => b !== bondsInT[0]);
    if (other) {
      const o2 = quickArgOptions('chess', { data: { get: () => C }, tier: t, bond: other });
      assert.notDeepEqual(o2.map((x) => x.value), opts.map((x) => x.value), '换盟约必须换结果');
    }
  });
  // 队友：座位 ＋ 观战席；**值必须是 playerId**（不是名字）
  const mateWant = [{ value: 'p1', label: '甲' }, { value: 'p2', label: '乙' }, { value: 'p3', label: '丙' }].sort(byLabel);
  assert.deepEqual(quickArgOptions('mate', { room: { seats: [{ playerId: 'p1', name: '甲' }, { playerId: 'p2', name: '乙' }], spectators: [{ playerId: 'p3', name: '丙' }] } }), mateWant);
  // 🔴 enemy：客户端拿不到"本局有效敌人集合" ⇒ **如实返回空**（不许编候选）
  assert.deepEqual(quickArgOptions('enemy', { data, room: { seats: [] }, pub: {} }), []);
  assert.deepEqual(quickArgOptions(null, {}), []);
  // 坏数据一律不抛
  for (const bad of [null, undefined, {}, { data: null }, { data: { get: () => 'x' } }]) {
    for (const k of ['bond', 'chess', 'mate', 'enemy']) assert.deepEqual(quickArgOptions(k, bad), [], `${k} 的坏输入不许抛`);
  }
  // 上限（面板是个小浮层）—— fake `get` 要像真的一样"按文件名取内容"
  const many = { bonds: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`b${String(i).padStart(2, '0')}`, { name: `名${i}` }])) };
  assert.equal(quickArgOptions('bond', { data: { get: (f) => many[f] }, pub: {} }).length, QUICK_ARG_OPTION_CAP);
});

test('🔴 表里的每个 id 都必须过【协议校验器】`isQuickId` —— 这才是"能不能真发出去"的判据（豁免表双向把关）', () => {
  // 为什么需要它：A 的"逐字一致"工具比的是**两张表**（constants.js ↔ chatModel.js），
  // 而"这一条能不能上线"由 **isQuickId** 决定 —— 两者都能各自为真而合起来坏掉（`niceOne`/`myBad` 现在就是这样）。
  const rejected = QUICK_IDS.filter((id) => !isQuickId(id));
  assert.deepEqual([...rejected].sort(), [...WIRE_REJECTED_PENDING_A_FIX].sort(),
    `被协议校验器拒的 id 变了（实际 [${rejected.join(', ')}]）：`
    + '① 若 A 已放宽字符类 ⇒ 请把 WIRE_REJECTED_PENDING_A_FIX 清空；'
    + '② 若新出现被拒的 ⇒ 说明表与校验器又分叉了（症状：玩家点了没反应）。');
  // 被豁免的必须在【发送路径】上明确不可发（客户端不许给出"点了没反应"的按钮）
  for (const id of rejected) assert.equal(canSendQuickNow(id), false, `${id} 被协议拒 ⇒ 按钮必须也是灰的`);
  // 没被豁免的必须真能发（带参的用一个合法 arg 代进去）
  for (const id of QUICK_IDS.filter((x) => !rejected.includes(x))) {
    assert.ok(quickMsgPayload([{ id, arg: quickPhraseOf(id)?.arg ? 'x' : null }]), `${id} 应当能发`);
  }
  // 面板要能给禁用按钮一句**正确的**原因（wire ≠ 需要选参数）
  for (const id of rejected) assert.equal(quickBlockReason(id), 'wire');
  assert.equal(quickBlockReason('playing'), 'needArg', '带参没选 ⇒ 原因是"需要选参数"');
  assert.equal(quickBlockReason('wait'), null, '无参的能发 ⇒ 没有阻挡原因');
  assert.equal(quickBlockReason('nope'), 'unknown');
});

test('收到的 quick.msg 收敛：宽容、未知 id 丢弃、最多 3 个、全丢 ⇒ null', () => {
  const q = normalizeQuickMessage({ from: 'p1', name: '甲', ids: ['sorry', 'nope', 'wait'], at: 123 });
  assert.deepEqual(q, { from: 'p1', name: '甲', ids: ['sorry', 'wait'], at: 123, kind: 'quick' });
  assert.deepEqual(normalizeQuickMessage({ ids: 'sorry,wait' })?.ids, ['sorry', 'wait'], '字符串形式也认');
  assert.deepEqual(normalizeQuickMessage({ ids: ['a', 'b', 'c', 'd', 'sorry', 'wait'] })?.ids, ['sorry', 'wait'], '只看认识的；最多 3 个');
  assert.deepEqual(normalizeQuickMessage({ ids: ['sorry', 'wait', 'help', 'niceOne'] })?.ids, ['sorry', 'wait', 'help']);
  assert.equal(normalizeQuickMessage({ ids: ['nope'] }), null, '一个都不认识 ⇒ null（无可渲染内容）');
  assert.equal(normalizeQuickMessage(null), null);
  assert.equal(normalizeQuickMessage({}), null);
  assert.ok(Number.isFinite(normalizeQuickMessage({ ids: ['sorry'] }).at), '缺 at ⇒ 用当前时间（不抛）');
  assert.equal(normalizeQuickMessage({ ids: ['sorry'], name: '' }).name, '玩家', '空名回落（displayName）');
});

test('appendQuick：环形、坏消息不破坏列表；messageKey 对 quick 用 ids（**与文本消息不撞**）', () => {
  let list = [];
  for (let i = 0; i < 5; i++) list = appendQuick(list, { from: 'p1', ids: ['sorry'], at: i }, 3);
  assert.equal(list.length, 3, '环形截断');
  assert.deepEqual(list.map((m) => m.at), [2, 3, 4]);
  const before = list;
  assert.equal(appendQuick(list, { ids: ['nope'] }, 3), before, '坏消息 ⇒ 原样返回（同一个引用）');
  // 同一个 from/at，两条不同 id 的短语**不许**被去重成一条（指纹用 ids）
  assert.notEqual(messageKey({ from: 'p1', at: 7, ids: ['sorry'] }), messageKey({ from: 'p1', at: 7, ids: ['wait'] }));
  assert.notEqual(messageKey({ from: 'p1', at: 7, ids: ['sorry'] }), messageKey({ from: 'p1', at: 7, text: 'sorry' }), 'quick 与文本消息不同源');
});

test('quickTextOf：按自己的语言渲染；有名字就填参；**没名字就如实留占位符**；未知 id 跳过', () => {
  const t = (msgid, args = {}) => String(msgid).replace(/\{(\w+)\}/g, (_, k) => (k in args ? String(args[k]) : `{${k}}`));
  assert.equal(quickTextOf({ ids: ['sorry'] }, { t }), '对不起！');
  assert.equal(quickTextOf({ ids: ['sorry', 'wait'] }, { t }), '对不起！ 稍等一下');
  // ⚠️ `names` 现在按 **arg 的值**索引（一条消息只有一个 arg ⇒ 不可能按"参数类别"索引）
  assert.equal(quickTextOf({ ids: ['playing'], arg: 'siracusaShip' }, { t, names: { siracusaShip: '叙拉古' } }), '我玩 叙拉古');
  assert.equal(quickTextOf({ ids: ['playing'] }, { t }), '我玩 {bond}', '🔴 拿不到参数 ⇒ 占位符原样留着（如实，不编造）');
  assert.equal(quickTextOf({ ids: ['nope', 'wait'] }, { t }), '稍等一下', '未知 id 跳过');
  assert.equal(quickTextOf(null, { t }), '');
});

test('canTypeInRoom：**只有显式的限制值**才置灰（缺省/未知放行 —— 别把旧服务端的打字关掉）', () => {
  assert.equal(canTypeInRoom({ chatMode: 'open' }), true);
  assert.equal(canTypeInRoom({ chatMode: 'quick' }), false, '房主关了打字（服务端强制）');
  assert.equal(canTypeInRoom({ chatMode: 'off' }), false, '将来可能的第三态（全禁）');
  // 🔴 缺省必须**放行**：0.2.1 之前的老服务端不发 `chatMode`，而它那边 `room.chat` 是好用的
  //    ⇒ 缺省置灰 = 把旧服务端的打字功能整个关掉（这条是 `test/ui/chat-panel.test.js` 那条既有判据当场纠正我的）。
  assert.equal(canTypeInRoom({}), true, '缺省 ⇒ 允许（旧服务端）');
  assert.equal(canTypeInRoom(null), true);
  assert.equal(canTypeInRoom(undefined), true);
  assert.equal(canTypeInRoom({ quickOnly: false }), true, '旧字段名不认，但也不该据此关掉打字');
  // 负对照：**显式**的 'quick' 一定不放行（否则开关就没牙了）
  assert.notEqual(canTypeInRoom({ chatMode: 'quick' }), canTypeInRoom({ chatMode: 'open' }));
});

test('建房那半（源码契约）：`room.create` 必须**显式**带 `chatMode: \'quick\'`（用户已拍"打字默认关闭"）', () => {
  // 为什么这条要存在：A 的服务端口径是「**不提 = open（能打字）**」（`server/lobby.js:526` `quickOnly = chatMode === 'quick'`）
  // ⇒ 客户端不显式说，建出来的房就**默认能打字**（与用户裁定相反，而且**不报错**）。这条钉住那一行。
  const src = readFileSync(path.join(ROOT, 'public/js/screens/lobby.js'), 'utf8');
  assert.match(src, /net\.request\(\s*'room\.create',\s*\{[^}]*chatMode:\s*'quick'/,
    "建房必须显式发 chatMode:'quick' —— 不然默认是 open（能打字）");
  // 负对照：**不许**在建房那行写 'open'（那等于把默认反过来；房主之后在面板里改是另一回事）
  const line = src.split('\n').find((l) => l.includes("'room.create'")) || '';
  assert.ok(!/chatMode:\s*'open'/.test(line), "建房默认不许写成 'open'");
  // 野排（matchmake）**不带** chatMode：服务端对野排恒为 quick（A §2.1 ④）⇒ 这边别自己发明字段
  const mm = src.split('\n').find((l) => l.includes("'room.matchmake'")) || '';
  assert.ok(!/chatMode/.test(mm), '野排那条不许带 chatMode（服务端硬性恒为 quick）');
});

test('（A 的 `arg` 落地后）发送载荷：无参 ≤3 个；带参**恰好一条**且必须带合法 arg；混排歧义一律不发', () => {
  assert.deepEqual(quickMsgPayload([{ id: 'sorry' }, { id: 'wait' }]), { id: 'sorry,wait' });
  assert.deepEqual(quickMsgPayload([{ id: 'sorry' }, { id: 'wait' }, { id: 'help' }, { id: 'niceOne' }]), { id: 'sorry,wait,help' }, '无参最多 3 个');
  assert.equal(quickMsgPayload([{ id: 'nope' }]), null, '未知 id 不发');
  // 带参：必须有合法 arg（trim 后非空、≤24、无空白）
  assert.deepEqual(quickMsgPayload([{ id: 'playing', arg: 'siracusaShip' }]), { id: 'playing', arg: 'siracusaShip' });
  assert.equal(quickMsgPayload([{ id: 'playing' }]), null, '带参却没给 arg ⇒ 不发（面板据此禁用）');
  assert.equal(quickMsgPayload([{ id: 'playing', arg: '   ' }]), null, '空白 arg ⇒ 不发');
  assert.equal(quickMsgPayload([{ id: 'playing', arg: 'x'.repeat(25) }]), null, '超过 A 的 24 上限 ⇒ 不发');
  assert.equal(quickMsgPayload([{ id: 'playing', arg: 'a b' }]), null, 'arg 里有空白 ⇒ 不发（服务端只做长度/空白校验）');
  // 🔴 一个 arg 配多个 ids **是歧义** ⇒ 本层拒绝，而不是发出去让服务端原样广播
  assert.equal(quickMsgPayload([{ id: 'playing', arg: 'a' }, { id: 'need', arg: 'b' }]), null, '两条带参 ⇒ 歧义 ⇒ 不发');
  assert.equal(quickMsgPayload([{ id: 'playing', arg: 'a' }, { id: 'wait' }])?.id, 'playing', '带参 + 无参 ⇒ 只发带参那条（arg 的归属唯一）');
  assert.equal(quickMsgPayload([{ id: 'playing', arg: 'a' }, { id: 'wait' }])?.arg, 'a');
  // 与按钮禁用共用同一个函数
  assert.equal(canSendQuickNow('wait'), true);
  assert.equal(canSendQuickNow('playing'), false, '还没选盟约 ⇒ 按钮必须灰');
  assert.equal(canSendQuickNow('playing', 'yanShip'), true, '选了盟约 ⇒ 能发');
});

test('（A 的 `arg` 落地后）`arg` 的收发往返：normalize 保留它、超长/空白丢掉，quickTextOf 用它填参', () => {
  const q = normalizeQuickMessage({ from: 'p1', ids: ['playing'], arg: 'yanShip', at: 1 });
  assert.deepEqual(q, { from: 'p1', name: '玩家 p1', ids: ['playing'], at: 1, kind: 'quick', arg: 'yanShip' });
  assert.equal(normalizeQuickMessage({ ids: ['playing'], arg: 'x'.repeat(25) }).arg, undefined, '超长 arg ⇒ 丢掉（不整条丢）');
  assert.equal(normalizeQuickMessage({ ids: ['playing'], arg: '  ' }).arg, undefined);
  assert.equal(normalizeQuickMessage({ ids: ['wait'], arg: 'yanShip' }).arg, 'yanShip', '无参句式也照收（服务端原样广播）');
  const t = (msgid, args = {}) => String(msgid).replace(/\{(\w+)\}/g, (_, k) => (k in args ? String(args[k]) : `{${k}}`));
  assert.equal(quickTextOf({ ids: ['playing'], arg: 'yanShip' }, { t, names: { yanShip: '炎' } }), '我玩 炎', '名字由**接收端**本地化');
  assert.equal(quickTextOf({ ids: ['playing'], arg: 'yanShip' }, { t }), '我玩 yanShip', '拿不到本地化名字 ⇒ 回落成 arg（比整句缺一半好）');
  assert.equal(quickTextOf({ ids: ['wait'] }, { t }), '稍等一下', '无参不受影响');
});

test('（A 的 `arg` 落地后）与共享常量对账：客户端 9 个 id 必须与 `shared/constants.js` 的 `QUICK_PHRASES` **逐字一致**', () => {
  // 🔴 A 把白名单放进了 `shared/constants.js`（不是 `data/config.json` —— 那是 build-data 的产物、本仓禁手改；
  //    C 已接受这个偏离，并要求守住"与 chatModel.js 的 QUICK_PHRASES 逐字一致"这条判据）。
  const shared = readFileSync(path.join(ROOT, 'shared/constants.js'), 'utf8');
  const ids = [...shared.matchAll(/\{\s*id:\s*'([A-Za-z0-9_]+)'\s*,\s*arg:\s*(null|'[A-Za-z]+')/g)]
    .map((m) => ({ id: m[1], arg: m[2] === 'null' ? null : m[2].slice(1, -1) }));
  assert.equal(ids.length, 9, `shared/constants.js 的 QUICK_PHRASES 应当正好 9 条（实读 ${ids.length} 条 ⇒ 解析正则或文件形状变了，先看这里）`);
  assert.deepEqual(ids.map((x) => x.id), [...QUICK_IDS], '两边的 **id 与顺序**必须逐字一致');
  for (const x of ids) assert.equal(quickPhraseOf(x.id)?.arg, x.arg, `${x.id}: 两边的 arg 类别也要一致（bond/chess/mate/enemy）`);
});

test('房主开关：canToggleTextChat（**只房主＋只在对局开始前**）＋ textChatSwitch 的布尔方向', () => {
  // 客户端镜像 A 的两条服务端限制：非房主 NOT_HOST、开局后 WRONG_PHASE
  assert.equal(canToggleTextChat({ hostId: 'p1', inMatch: false }, 'p1'), true);
  assert.equal(canToggleTextChat({ hostId: 'p1', inMatch: false }, 'p2'), false, '非房主（负对照）');
  assert.equal(canToggleTextChat({ hostId: 'p1', inMatch: true }, 'p1'), false, '🔴 对局已开始 ⇒ 不给改（用户原话"战斗开始前"）');
  assert.equal(canToggleTextChat({ hostId: 'p1' }, 'p1'), true, 'inMatch 缺省 ⇒ 当作未开局（room.state 一定带它）');
  assert.equal(canToggleTextChat({}, 'p1'), false, '没有 hostId ⇒ 不给改');
  assert.equal(canToggleTextChat(null, 'p1'), false);
  assert.equal(canToggleTextChat({ hostId: 'p1', inMatch: false }, null), false);
  // 🔴 布尔方向：A 的 `on: true` 意思是「**把打字关掉**」（本房只允许短语）
  assert.deepEqual(textChatSwitch('open'), { on: true, label: '关闭打字' }, '现在能打字 ⇒ 动作＝关掉打字');
  assert.deepEqual(textChatSwitch('quick'), { on: false, label: '开启打字' }, '现在只允许短语 ⇒ 动作＝打开打字（payload 必须是 on:false）');
  assert.deepEqual(textChatSwitch('off'), { on: false, label: '开启打字' });
  assert.deepEqual(textChatSwitch(null), { on: true, label: '关闭打字' }, '缺省＝能打字 ⇒ 动作＝关掉');
  // 负对照：两个方向必须真的相反（否则按钮点了会反着来，而且**不报错**）
  assert.notEqual(textChatSwitch('open').on, textChatSwitch('quick').on);
});

test('个人屏蔽：只丢被屏蔽者（**负对照：别人必须留着**）、原列表不动、坏数据不崩', () => {
  const list = [
    { from: 'p1', name: '甲', text: 'a', at: 1 },
    { from: 'p2', name: '乙', text: 'b', at: 2 },
    { from: 'p1', name: '甲', ids: ['sorry'], at: 3, kind: 'quick' },
  ];
  const kept = filterMuted(list, ['p1']);
  assert.deepEqual(kept.map((m) => m.at), [2], 'p1 的两条（文本 + 短语）都丢掉，p2 留着');
  assert.equal(list.length, 3, '原列表不被原地改（历史照旧，只是不显示）');
  assert.equal(filterMuted(list, []).length, 3, '没人被屏蔽 ⇒ 一条不丢');
  assert.equal(filterMuted(list, null).length, 3);
  // 净化：坏数据 / 重复 / 上限
  assert.deepEqual(cleanMuted(null), []);
  assert.deepEqual(cleanMuted('p1'), []);
  assert.deepEqual(cleanMuted(['p1', 'p1', null, '', 'p2']), ['p1', 'p2']);
  assert.equal(cleanMuted(Array.from({ length: 100 }, (_, i) => `p${i}`)).length, 64, '上限 64');
  assert.equal(isMuted('p1', ['p1']), true);
  assert.equal(isMuted('p3', ['p1']), false);
  assert.equal(isMuted('', ['']), false);
  assert.deepEqual(toggleMuted(['p1'], 'p2'), ['p1', 'p2'], '加');
  assert.deepEqual(toggleMuted(['p1', 'p2'], 'p1'), ['p2'], '取消');
  assert.deepEqual(toggleMuted(['p1'], ''), ['p1'], '空 id 不动');
});

test('🔴 收起 ⇒ 位置作废（回"最开始的位置"），展开 ⇒ 保留当前位置（用户口径）', () => {
  // 用户原话：「收起后，消息按钮应该回到最开始的位置（原处），而不是停留在当前位置，这样既迷惑又误导人。」
  assert.equal(posForCollapse(true, { x: 300, y: 400 }), null, '收起 ⇒ 位置作废（默认角）');
  assert.equal(posForCollapse(true, null), null);
  assert.deepEqual(posForCollapse(false, { x: 300, y: 400 }), { x: 300, y: 400 }, '展开 ⇒ 保留位置');
  assert.equal(posForCollapse(false, null), null, '没拖过 ⇒ 仍是默认位');
  // 负对照：收起与展开**必须不同**（否则这条判据恒真、等于没判）
  assert.notDeepEqual(posForCollapse(true, { x: 1, y: 2 }), posForCollapse(false, { x: 1, y: 2 }));
});

// 🔴 2026-10-08（现场事故的护栏）：上面那次"界面发生错误"的**根因**是 ——
//   `chatPanel.js` 用了 `posForCollapse(...)` 却**没 import** ⇒ 渲染时 ReferenceError ⇒ **整个对局屏崩**。
//   `node --check` 抓不到（那是语法检查，未声明的标识符是**运行时**错），我的 DOM 判据也照不到
//   （`ChatPanelHost` 带 hook，Node 里当函数调不了）⇒ 于是"测试全绿、界面全崩"。
// ⇒ 这条判据补上那个缺口：**凡是我在带 hook 的组件里新引的纯函数，必须真的出现在 import 名单里**。
//   （比 eslint 便宜得多，但正好覆盖"新写的一行 + 忘了 import"这个形状 —— 本仓已栽过不止一次。）
test('🔴 源码契约：带 hook 的组件里用到的新函数**必须 import**（防止整屏 ReferenceError）', () => {
  const NEED = {
    'public/js/ui/chatPanel.js': ['posForCollapse', 'canTypeInRoom', 'canToggleTextChat', 'textChatSwitch', 'quickTextOf'],
    'public/js/screens/game.js': ['markBondIds', 'markMany', 'unmarkMany', 'loadMarks', 'saveMarks'],
    // 🗑️ 2026-10-08：这里原本还有 `public/js/ui/quickWheel.js`（短语浮层）—— 该文件已退役
    //    （移到 `.workbuddy/_retired-0.1.6/…`）⇒ 从名单里摘掉，否则这条判据会去读一个不存在的文件而红。
    // 🔴 2026-10-08：这条名单**必须连 hooks 一起查** —— 我在 `quickWheel.js` 里加了 `useRef` 却忘了 import，
    //    与 `posForCollapse` 是同一个形状（组件一渲染就 ReferenceError，界面直接崩/"点了没反应"）。
    // 🔴 2026-10-08 现场事故：`screens/lobby.js` 里我抄了上游的 `account.enabled` 守卫，而**这棵树没有账号模式**
    //    （`ui/accountMenu.js` 不存在）⇒ 点「快速匹配」直接 `account is not defined` 崩屏。
    'public/js/screens/lobby.js': ['account', 'toast', 'toastError', 'net', 'useState', 'useEffect'],
  };
  for (const [rel, names] of Object.entries(NEED)) {
    const src0 = readFileSync(path.join(ROOT, rel), 'utf8');
    // ⚠️ 先把**注释**剥掉再抽 import 名单 —— 否则 import 块里的注释会被当成名字（我第一版就在这里假红）
    const src = src0.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // 把所有 `import { … } from '…'` 的名字收集起来（多行也要收）
    const imported = new Set();
    for (const m of src.matchAll(/import\s*\{([\s\S]*?)\}\s*from/g)) {
      for (const raw of m[1].split(',')) {
        const n = raw.trim().split(/\s+as\s+/).pop().trim();
        if (/^[A-Za-z_$][\w$]*$/.test(n)) imported.add(n);
      }
    }
    for (const name of names) {
      // ⚠️ 用法判定**两种都算**：`foo(` 是调用，`foo.bar` 是属性访问。
      //    我第一版只查调用 ⇒ `account.enabled`（未 import）这种崩屏照不出来（2026-10-08 真踩：点快速匹配直接崩）。
      const used = new RegExp(`\\b${name}\\s*[.(]`).test(src);
      if (!used) continue;                     // 没用到就跳过（将来删了也不会假红）
      assert.ok(imported.has(name), `${rel} 用了 ${name} 却没 import ⇒ 运行时报 ReferenceError（整屏崩）`);
    }
  }
});

  // 🆕 2026-10-08（A 给的数据源）：**小心{敌怪}** 的候选 = 本局 `waves[stageId].spawns[].key`（＋bossId）。
  test('敌人候选：只列本局 waves 里的 key；🔴 负对照：别的舞台的敌人不许出现；拿不到舞台 ⇒ 空（不编）', () => {
    const W = JSON.parse(readFileSync(path.join(ROOT, 'data/waves.json'), 'utf8'));
    const withSpawns = Object.keys(W).filter((k) => Array.isArray(W[k].spawns) && W[k].spawns.length);
    assert.ok(withSpawns.length >= 2, '夹具里至少要有两个有 spawn 的舞台');
    const [a, b] = withSpawns;
    const ka = enemyKeysForStage(W, a);
    const kb = enemyKeysForStage(W, b);
    assert.ok(ka.length > 0, `${a} 应当有敌人`);
    assert.deepEqual(ka, [...ka].sort(), '稳定排序');
    assert.deepEqual([...new Set(ka)], ka, '去重');
    if (kb.length) {
      // 🔴 负对照：b 独有、a 没有的 key ⇒ 若两边完全不同，必须一个都不出现在 a 里
      for (const k of kb.filter((x) => !ka.includes(x))) assert.equal(ka.includes(k), false, `${k} 不属于 ${a}`);
    }
    assert.deepEqual(enemyKeysForStage(W, 'no-such-stage'), [], '未知舞台 ⇒ 空（不编候选）');
    assert.deepEqual(enemyKeysForStage(null, a), [], '没有 waves 数据 ⇒ 空');
    // bossId 若非 null 必须进候选
    const bossStage = Object.keys(W).find((k) => W[k].bossId != null && W[k].bossId !== '');
    if (bossStage) assert.ok(enemyKeysForStage(W, bossStage).includes(String(W[bossStage].bossId)), 'boss 必须进候选');
    // 面板取值：给了 stageId 才有候选，且标签来自 enemies.json 的 name
    const E = JSON.parse(readFileSync(path.join(ROOT, 'data/enemies.json'), 'utf8'));
    const opts = quickArgOptions('enemy', { data: { get: (f) => (f === 'waves' ? W : f === 'enemies' ? E : null) }, stageId: a });
    assert.equal(opts.length, ka.length, '候选条数＝该舞台去重 key 数');
    const named = opts.filter((o) => o.label !== o.value);
    assert.ok(named.length > 0, '至少要有一条能把 key 翻成名字（enemies.json.name）');
    assert.deepEqual(quickArgOptions('enemy', { data: { get: () => W } }), [], '没有 stageId ⇒ 空');
  });

test('🆕 聊天框自由缩放（用户 Q9 第 2 条 bug）：尺寸夹取 —— 坏输入回默认、不许拖成 0 或超屏', () => {
  const B = { vw: 1000, vh: 800 };
  assert.equal(clampPanelSize(null, B), null, '没存过 ⇒ null（用 CSS 默认尺寸）');
  assert.equal(clampPanelSize({ w: NaN, h: 100 }, B), null, '坏输入 ⇒ null（不崩）');
  assert.equal(clampPanelSize({ w: 0, h: 0 }, B).w, 190, '拖到 0 ⇒ 回到最小宽 190');
  assert.equal(clampPanelSize({ w: 10, h: 10 }, B).h, 130, '拖到 0 ⇒ 回到最小高 130');
  assert.deepEqual(clampPanelSize({ w: 400, h: 300 }, B), { w: 400, h: 300 }, '正常值原样');
  assert.equal(clampPanelSize({ w: 99999, h: 99999 }, B).w, 900, '不许超过视口 90%');
  assert.equal(clampPanelSize({ w: 99999, h: 99999 }, B).h, 680, '不许超过视口 85%');
  // 负对照：同一个值在**小屏**上要被夹小（说明它真的问了视口，而不是恒定放行）
  assert.ok(clampPanelSize({ w: 400, h: 300 }, { vw: 400, vh: 300 }).w < 400, '小屏 ⇒ 夹小');
});
// b12-resize-marker

// ── 🆕 W-6 头像插件（客户端那半）：id 校验／id→URL／清单不变量 ────────────────────────────────────
const AV = await import('../../public/js/ui/avatarPicker.js');

test('W-6 头像：id 只收本地 id（⛔ 不收 URL/路径/大写/空白）；没有 id ⇒ src 为 null（退回首字母）', () => {
  assert.equal(AV.cleanAvatarId('activity_ac'), 'activity_ac');
  assert.equal(AV.cleanAvatarId('def_01'), 'def_01');
  // 🔴 负对照：这些**都**必须被挡掉（否则玩家可控任意资源引用）
  for (const bad of ['../../etc/passwd', '/assets/avatar/x.png', 'http://evil/x.png', 'UPPER', 'a b', 'a-b', '', null, undefined, 'x'.repeat(33), 42]) {
    assert.equal(AV.cleanAvatarId(bad), '', `不该通过：${String(bad)}`);
  }
  assert.equal(AV.avatarSrc('activity_ac'), '/assets/avatar/activity_ac.png');
  assert.equal(AV.avatarSrc('../../etc/passwd'), null, '坏 id ⇒ null（调用方退回首字母，不显示坏图）');
  assert.equal(AV.avatarSrc(''), null);
});

test('W-6 头像：真素材不变量 —— 清单里**每个** id 的文件都在磁盘上，且 `avatarSrc(id)` 就是它', () => {
  const man = JSON.parse(readFileSync(path.join(ROOT, 'public/assets/avatar/manifest.json'), 'utf8'));
  const items = AV.pickerItems(man);
  assert.equal(items.length, 184, `清单应当 184 条（实得 ${items.length}）`);
  const missing = items.filter((a) => !existsSync(path.join(ROOT, 'public/assets/avatar', a.file)));
  assert.deepEqual(missing.map((a) => a.file), [], '清单里不许有死链（文件必须在磁盘上）');
  for (const a of items) {
    assert.equal(a.file, `${a.id}.png`, `文件名的约定是 <id>.png（${a.id}）`);
    assert.equal(AV.avatarSrc(a.id), `/assets/avatar/${a.file}`, `${a.id} 的 URL 必须由 id 推出来`);
  }
  // 负对照：坏清单 ⇒ 空表（不崩、不猜）
  assert.deepEqual(AV.pickerItems(null), []);
  assert.deepEqual(AV.pickerItems({ avatars: [{ id: 'UPPER', file: 'x.png' }, { id: 'ok', file: '' }] }), []);
});

test('W-6 头像：选择器接线（源码契约）—— 外壳挂一次、大厅与房间都喂 src、⛔ 不许自己拼 URL', () => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const g = strip(readFileSync(path.join(ROOT, 'public/js/main.js'), 'utf8'));
  assert.match(g, /<\$\{AvatarPickerHost\} \/>/, '宿主挂在外壳（任何一屏都能弹）');
  const lo = strip(readFileSync(path.join(ROOT, 'public/js/screens/lobby.js'), 'utf8'));
  assert.match(lo, /avatarSrc\(chosenAvatar\)/, '大厅名片喂 src');
  assert.match(lo, /openAvatarPicker\(\)/, '大厅有入口（换头像）');
  const rm = strip(readFileSync(path.join(ROOT, 'public/js/screens/room.js'), 'utf8'));
  assert.match(rm, /avatarSrc\(seat\.avatarId \|\| \(isMe \? myAvatarId : ''\)\)/, '房间座位：别人用 A 的 avatarId，自己用本地选择');
  assert.match(rm, /loadPref/, '自己的选择刷新后仍在（读偏好）');
  // ⛔ 反面：屏里不许自己拼 `/assets/avatar/...`（URL 只能由 avatarSrc 给）
  for (const [f, s] of [['lobby', lo], ['room', rm]]) {
    assert.equal(/\/assets\/avatar\//.test(s), false, `${f}.js 不许自己拼头像 URL（用 avatarSrc）`);
  }
});

// b12-avatar-marker

test('W-6 头像：选择后**必须把 id 发给服务器**（A 的 C2S `room.avatar`）｜空串 = 清掉｜刷新后从偏好补发', () => {
  const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const src = strip(readFileSync(path.join(ROOT, 'public/js/ui/avatarPicker.js'), 'utf8'));
  assert.match(src, /net\.request\('room\.avatar'/, 'chooseAvatar 要发 C2S（不发 ⇒ 只有自己看得见）');
  assert.match(src, /cleanAvatarId\(id\)/, '发出去的一律先过 id 校验');
  assert.match(src, /roomCode/, '进到/回到同盟时补发（⛔ 服务端不落盘 ⇒ 会话级）');
  assert.match(src, /loadPref\(AVATAR_PREF/, '刷新后从偏好恢复（否则"选过的头像刷新就没了"）');
  assert.equal(/avatarId:\s*[0-9]/.test(src), false, '不许把数字当 id 广播');
});
// b12-avatar-send-marker




// b12-teammate-strategy-marker

// b12-strategy-bandid-marker

test('🔴 局内头像：**个人头像优先**（局外选的），拿不到才退回策略图标 —— 四个来源逐条判 ＋ 负对照', () => {
  const { avatarIdForPlayer, avatarSrc } = AV;
  const room = { seats: [{ playerId: 'p_2', avatarId: 'def_01' }, { playerId: 'p_3' }], spectators: [{ playerId: 'p_9', avatarId: 'activity_ac' }] };
  assert.equal(avatarIdForPlayer({ playerId: 'p_2' }, { room, myId: 'p_1' }), 'def_01', '① 座位表里那一席');
  assert.equal(avatarIdForPlayer({ playerId: 'p_9' }, { room, myId: 'p_1' }), 'activity_ac', '② 观战席也算');
  assert.equal(avatarIdForPlayer({ playerId: 'p_1' }, { room, myId: 'p_1', myAvatarId: 'dyn_02' }), 'dyn_02', '③ 自己 ⇒ 本地偏好');
  assert.equal(avatarIdForPlayer({ playerId: 'p_5', avatarId: 'def_07' }, { room, myId: 'p_1' }), 'def_07', '④ 公开态自带（A 以后若加）');
  // 🔴 负对照：没选 ⇒ ''（调用方退回策略图标，⛔ 不编 id）；坏 id（URL/大写/穿越）⇒ ''
  assert.equal(avatarIdForPlayer({ playerId: 'p_3' }, { room, myId: 'p_1' }), '');
  assert.equal(avatarIdForPlayer(null, {}), '');
  assert.equal(avatarIdForPlayer({ playerId: 'p_x', avatarId: '../../etc/passwd' }, { room }), '');
  assert.equal(avatarIdForPlayer({ playerId: 'p_2' }, { room: { seats: [{ playerId: 'p_2', avatarId: 'UPPER' }] } }), '');
  assert.equal(avatarIdForPlayer({ playerId: 'p_1' }, { myId: 'p_1', myAvatarId: 'http://evil/x.png' }), '');
  // 契约：PlayerAvatar **优先** avatar prop；队伍面板必须把 avatar 传下去
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const gc = strip(readFileSync(path.join(ROOT, 'public/js/ui/gameComponents.js'), 'utf8'));
  assert.match(gc, /const src = avatar \|\| \(player\?\.bandId/, 'PlayerAvatar：个人头像优先、策略图标兜底');
  const tp = strip(readFileSync(path.join(ROOT, 'public/js/ui/teamPanel.js'), 'utf8'));
  assert.match(tp, /avatar=\$\{avatarSrc\(avatarIdForPlayer\(p, \{ room, myId, myAvatarId \}\)\) \|\| null\}/, '队伍面板要把解析结果传进 PlayerAvatar');
  assert.match(tp, /loadPref\(AVATAR_PREF/, '自己的头像刷新后仍在');
});
// b12-avatar-inmatch-marker
