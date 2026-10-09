// test/stats.test.js — 匿名对局/表情落盘（`server/stats.js`，第 3 任 D，2026-10-06）
//
// 用户 11:0x 批准「匿名落盘即可」。这条链的**硬约束**只有两条，本测试就是钉死它们：
//   ① **姓名永不落盘**（结算行里确实带 `name`，我们靠字段白名单不复制它）；
//   ② **绝不能因为统计把游戏搞坏**（写失败要自我禁用，且永不抛）。
// 另外钉住：同一局只写一行（finish+dispose 都会到）、表情只记成功的、`SP_STATS=0` 能关、
// 盐要持久（同机同值稳定、跨机不可比）、保留期清理。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStats, statsEnabled } from '../server/stats.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sp-stats-'));
const readLines = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const readRaw = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');

/** 一个"够用"的 Match 替身：`wrap()` 只要求 finish/dispose/emote 三个方法 + 记录时读到的那些字段。 */
class FakeMatch {
  constructor(opts) {
    this.opts = opts; this.mode = opts.mode; this.difficulty = opts.difficulty;
    this.round = 9; this.phase = 'PREP';
  }
  finish() { this.ended = true; return 'finished'; }
  dispose() { this.disposed = true; return 'disposed'; }
  emote(ps, id) { return id === 'nope' ? { error: 'BAD_MSG' } : undefined; }
}

/** 一局：人类 1 + 机器人 1，都带 `name`（正是**不许落盘**的那个字段）。 */
function makeMatch(over = {}) {
  const m = new FakeMatch({
    mode: 'coop', difficulty: 'HARD',
    seats: [{ playerId: 'p1', name: '简浩竹', isBot: false }, { playerId: 'ai_2', name: 'AI·华法琳', isBot: true }],
    ...over,
  });
  m.lastResultMsg = {
    victory: true, roundsPassed: 12, reason: 'clear',
    players: [
      { playerId: 'p1', name: '简浩竹', roundsPassed: 12, lp: 7, stats: { kills: 210, leaks: 1, dmgDealt: 18700.4, gold: 33 } },
      { playerId: 'ai_2', name: 'AI·华法琳', roundsPassed: 12, lp: 7, stats: { kills: 90, leaks: 3, dmgDealt: 5000, gold: 12 } },
    ],
  };
  return m;
}
const mk = (over = {}) => createStats({ dir: tmp(), enabled: true, app: '0.1.3.3', build: 'abc123abc123', artVersion: '03c3ee7b860a', now: () => Date.UTC(2026, 9, 6, 12, 0, 0), ...over });

test('statsEnabled：SP_STATS=0 关、=1 开；未设时测试进程默认关、真实部署默认开', () => {
  assert.equal(statsEnabled({ SP_STATS: '0' }), false);
  assert.equal(statsEnabled({ SP_STATS: '1' }), true);
  assert.equal(statsEnabled({ NODE_TEST_CONTEXT: 'child-v8' }), false, '测试子进程里不许往工作区写数据');
  assert.equal(statsEnabled({}), true, '真实部署默认开（用户已批准匿名落盘）');
});

test('SP_STATS_DIR：线上必须把落盘目录指到**树外**（单元是 ProtectSystem=strict + 树只读）', async () => {
  // 这条钉的是一个**实测出来的部署事实**：`11-stronghold.service` 里 ProtectSystem=strict / ReadOnlyPaths=/opt/stronghold
  // 且没有 ReadWritePaths ⇒ 树内默认目录写不进去（会安静自我禁用）。所以默认目录必须能被环境变量顶掉。
  const dir = tmp();
  process.env.SP_STATS_DIR = dir;
  try {
    const mod = await import(`../server/stats.js?probe=${Date.now()}`); // 重新求值：STATS_DIR 是模块级常量
    assert.equal(mod.STATS_DIR, path.resolve(dir), 'SP_STATS_DIR 要能决定默认目录');
    assert.equal(mod.createStats({ enabled: true }).dir, path.resolve(dir), 'createStats 的默认 dir 也要跟着走');
  } finally { delete process.env.SP_STATS_DIR; }
  // 未设时回到树内默认（本地开发/测试用）
  const mod2 = await import(`../server/stats.js?probe2=${Date.now()}`);
  assert.match(mod2.STATS_DIR, /[\\/]var[\\/]stats$/, '未设环境变量时仍是树内 var/stats');
});

test('记一局：一行、字段齐，且**姓名永不落盘**、who 是 12 位十六进制', () => {
  const s = mk();
  const m = makeMatch();
  const row = s.recordMatch(s.wrap(FakeMatch) && m, 'finished'); // 直接记（wrap 在另一条测试里测）
  const file = s.pathFor('matches');
  const raw = readRaw(file);
  assert.ok(row, '应当返回记录');
  assert.ok(!raw.includes('简浩竹') && !raw.includes('华法琳'), '姓名绝不许出现在文件里');
  assert.ok(!raw.includes('"name"'), '白名单：连 name 这个键都不该有');
  const [line] = readLines(file);
  assert.equal(line.difficulty, 'HARD');
  assert.equal(line.mode, 'coop');
  assert.equal(line.victory, true);
  assert.equal(line.roundsPassed, 12);
  assert.equal(line.app, '0.1.3.3');
  assert.equal(line.seats.length, 2);
  assert.equal(line.seats[0].kind, 'human');
  assert.match(line.seats[0].who, /^[0-9a-f]{12}$/);
  assert.equal(line.seats[0].rounds, 12);
  assert.equal(line.seats[0].kills, 210);
  assert.equal(line.seats[0].dmg, 18700, '伤害取整');
  assert.equal(line.seats[1].kind, 'bot');
  assert.equal(line.seats[1].who, null, '机器人没有身份');
});

test('finish 与 dispose 都会到 ⇒ **同一局只写一行**', () => {
  const s = mk();
  const Wrapped = s.wrap(FakeMatch);
  const m = new Wrapped({ mode: 'coop', difficulty: 'NORMAL', seats: [] });
  m.lastResultMsg = { victory: false, roundsPassed: 3, reason: 'defeat', players: [] };
  m.finish({ victory: false, reason: 'defeat' });
  m.dispose();
  const lines = readLines(s.pathFor('matches'));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].reason, 'finished');
});

test('只 dispose 而没 finish（中途散场）⇒ 也要留一行，并标明 reason', () => {
  const s = mk();
  const Wrapped = s.wrap(FakeMatch);
  const m = new Wrapped({ mode: 'solo', difficulty: 'ABYSS', seats: [{ playerId: 'p9', isBot: false }] });
  m.dispose();
  const [line] = readLines(s.pathFor('matches'));
  assert.equal(line.reason, 'disposed');
  assert.equal(line.mode, 'solo');
  assert.equal(line.victory, null, '没结算就没胜负，不许编');
});

test('表情：成功的记一行、**失败的（返回 {error}）不记**；且与对局行共享同一个 mid', () => {
  const s = mk();
  const Wrapped = s.wrap(FakeMatch);
  const m = new Wrapped({ mode: 'coop', difficulty: 'HARD', seats: [] });
  m.lastResultMsg = { victory: true, roundsPassed: 1, reason: 'clear', players: [] };
  const human = { playerId: 'p1', isBot: false };
  const bot = { playerId: 'ai_2', isBot: true };
  m.emote(human, 'hello');     // 成功
  m.emote(bot, 'ok');          // 成功（机器人也记，kind=bot、who=null）
  m.emote(human, 'nope');      // 假 Match 返回 {error} ⇒ 不记
  m.finish();
  const em = readLines(s.pathFor('emotes'));
  const mm = readLines(s.pathFor('matches'));
  assert.equal(em.length, 2, '只记真的广播出去的');
  assert.equal(em[0].id, 'hello');
  assert.equal(em[0].kind, 'human');
  assert.match(em[0].who, /^[0-9a-f]{12}$/);
  assert.equal(em[1].kind, 'bot');
  assert.equal(em[1].who, null);
  assert.equal(em[0].mid, mm[0].mid, '两串记录靠 mid 关联（离线才能重建"谁回应了谁"）');
});

test('关闭时：wrap 原样返回、一个文件都不建', () => {
  const dir = tmp();
  const s = createStats({ dir, enabled: false });
  assert.equal(s.enabled, false);
  assert.equal(s.wrap(FakeMatch), FakeMatch, '关闭 ⇒ 连子类都不建（零影响）');
  assert.equal(s.recordMatch(makeMatch()), null);
  assert.deepEqual(fs.readdirSync(dir), [], '关闭时不该产生任何文件');
});

test('盐持久化：同目录两次创建得到同一个 who；不同目录不同（跨机不可比）', () => {
  const dir = tmp();
  const a = createStats({ dir, enabled: true }).hash('p1');
  const b = createStats({ dir, enabled: true }).hash('p1');
  const c = createStats({ dir: tmp(), enabled: true }).hash('p1');
  assert.equal(a, b, '同一台机器上同一个玩家要稳定（否则没法做时间序列）');
  assert.notEqual(a, c, '换一台机器/换个目录就不该可比');
  assert.match(a, /^[0-9a-f]{12}$/);
});

test('写失败：**永不抛**、自我禁用（把 dir 指到一个已存在的文件）', () => {
  const base = tmp();
  const asFile = path.join(base, 'not-a-dir');
  fs.writeFileSync(asFile, 'x');
  const s = createStats({ dir: asFile, enabled: true });
  assert.doesNotThrow(() => s.recordMatch(makeMatch(), 'finished'));
  assert.equal(s.enabled, false, '写不进去就安静禁用，而不是每局都崩一次');
  assert.doesNotThrow(() => s.recordMatch(makeMatch(), 'finished'));
});

test('保留期：超过 30 天的旧文件在首次写入时被清掉，新文件不动', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'matches-2020-01-01.jsonl'), '{"old":1}\n');
  fs.writeFileSync(path.join(dir, 'emotes-2020-01-01.jsonl'), '{"old":1}\n');
  const keep = path.join(dir, 'matches-2026-10-06.jsonl');
  fs.writeFileSync(keep, '{"keep":1}\n');
  const s = createStats({ dir, enabled: true, now: () => Date.UTC(2026, 9, 6, 12, 0, 0) });
  s.recordMatch(makeMatch(), 'finished');
  const left = fs.readdirSync(dir).sort();
  assert.ok(!left.includes('matches-2020-01-01.jsonl'), '过期文件该删');
  assert.ok(!left.includes('emotes-2020-01-01.jsonl'));
  assert.ok(left.includes('matches-2026-10-06.jsonl'), '不该误删新的');
  assert.equal(readLines(keep).length, 2, '旧内容保留、新记录追加');
});

test('鸭子对象也不抛：缺 opts / 缺 lastResultMsg / 传 null', () => {
  const s = mk();
  for (const bad of [null, {}, { opts: {} }, { opts: { seats: null } }, { mode: 'coop' }]) {
    assert.doesNotThrow(() => s.recordMatch(bad, 'finished'));
  }
  const [line] = readLines(s.pathFor('matches'));
  assert.ok(line, '至少要留下能说明"有一局结束了但信息不全"的一行');
  assert.deepEqual(line.seats, []);
});
