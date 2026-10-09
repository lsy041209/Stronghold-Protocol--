// 干员战斗语音 (W-3, public/js/audio.js): the VoiceGate scheduler, the settlement slot / speaker helpers, the language
// fallback, and what the manager does with `audio.voice` on field entry and on the b.ev tuples.
//
// 判据落点：**实现**（`public/js/audio.js`）+ **产物**（`data/assets.json` 的 `audio.voice` 与磁盘一致）。
// 每条都检查过"它会红"（把对应的守卫/优先级/分支改掉 ⇒ 当场失败），见 `协作/进度-workbuddy.md`。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AudioManager, VoiceGate, VOICE_PRIORITY, VOICE_COOLDOWN_MS, resultVoiceSlot, resultSpeaker, voiceKey } from '../../public/js/audio.js';
import { mediaUrl } from '../../public/js/media.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'data', 'assets.json'), 'utf8'));

/** 这个 manifest 地址被请求过吗（audio.js 先走 /media/ 再回退原地址，见 test/ui/audio.test.js）。 */
const asked = (urls, raw) => urls.includes(mediaUrl(raw)) || urls.includes(raw);
const askedCount = (urls, raw) => urls.filter((u) => u === mediaUrl(raw) || u === raw).length;

// ---- pure: VoiceGate --------------------------------------------------------------------------------------

describe('VoiceGate (官方 battleVoice 的调度口径)', () => {
  test('one line at a time; a global gap between two; a per-unit per-slot cooldown', () => {
    const g = new VoiceGate({ gapMs: 1200 });
    assert.equal(g.request('place', 1, 0), 'play');
    g.start('place', 1, 0);
    assert.equal(g.request('place', 2, 1000), 'drop', '有一条在响 ⇒ 谁也不许插');
    g.release();
    assert.equal(g.request('place', 2, 1000), 'drop', '刚响完，还在全局间隔内');
    assert.equal(g.request('place', 2, 1300), 'play');
    g.start('place', 2, 1300);
    g.release();
    // 接敌 3 s 冷却：同一单位同一槽在窗口内不许再来
    assert.equal(g.request('faceEnemy', 7, 5000), 'play');
    g.start('faceEnemy', 7, 5000);
    g.release();
    assert.equal(g.request('faceEnemy', 7, 7000), 'drop', '同单位同槽仍在 3 s 冷却内');
    assert.equal(g.request('faceEnemy', 8, 7000), 'play', '换个单位不受影响');
    // 作战中 10 s 冷却（官方 PASSIVE_NOR）
    assert.equal(VOICE_COOLDOWN_MS.skill1, 10000);
    assert.equal(VOICE_COOLDOWN_MS.faceEnemy, 3000);
    assert.equal(VOICE_COOLDOWN_MS.select, 1500);
  });

  test('a clearly more important line takes the channel over; an equal one waits', () => {
    // 抢占余量 = 10（VoiceGate.preemptMargin）：只有**高出 10 档**才抢，同档/高出不足都排队。
    const g = new VoiceGate();
    g.start('place', 1, 0);                              // 20
    assert.equal(g.request('skill1', 2, 10), 'preempt', '作战中(70) 压得住 部署(20)');
    g.start('skill1', 2, 10);                            // 70
    assert.equal(g.request('skill2', 3, 20), 'drop', '同为 70：不抢，排队');
    assert.equal(g.request('resultThree', 4, 20), 'preempt', '结算(85) 压得住作战中(70)');
    g.start('resultThree', 4, 20);                       // 85
    assert.equal(g.request('faceEnemy', 5, 20), 'drop', '接敌(90) 只高 5 ⇒ 抢不过结算(85)');
    assert.equal(g.request('start', 6, 20), 'preempt', '行动出发(100) 压得住结算(85)');
    g.start('start', 6, 20);                             // 100
    assert.equal(g.request('faceEnemy', 7, 20), 'drop', '接敌(90) 抢不过行动出发(100)');
    assert.equal(g.request('skill4', 8, 20), 'drop', '作战中(70) 更抢不过');
    assert.equal(VOICE_PRIORITY.start, 100);
    assert.equal(VOICE_PRIORITY.faceEnemy, 90);
    assert.equal(VOICE_PRIORITY.resultThree, 85);
    assert.equal(VOICE_PRIORITY.skill1, 70);
    assert.equal(VOICE_PRIORITY.place, 20);
    assert.equal(VOICE_PRIORITY.select, 10);
  });

  test('reset drops the previous field\'s cooldowns', () => {
    const g = new VoiceGate({ gapMs: 1200 });
    g.start('skill3', 1, 0);
    g.reset();
    assert.equal(g.playing, null);
    assert.equal(g.request('garbage', 1, 1), 'play', 'lastAt 也回到 -∞');
  });
});

// ---- pure: settlement slot / speaker ----------------------------------------------------------------------

describe('结算语音的槽位与说话人', () => {
  test('resultVoiceSlot: 完美 / 漏怪 / 全灭 × 绝境-终极', () => {
    assert.equal(resultVoiceSlot({ perfect: true, hard: false }), 'resultThree', '完美作战 ⇒ 3星结束行动');
    assert.equal(resultVoiceSlot({ perfect: true, hard: true }), 'resultFour', '完美 + 绝境/终极 ⇒ 完成高难行动');
    assert.equal(resultVoiceSlot({ perfect: false, leaked: 2, killed: 5, total: 7 }), 'resultTwo', '漏了怪 ⇒ 非3星');
    assert.equal(resultVoiceSlot({ perfect: false, leaked: 0, killed: 0, total: 7 }), 'resultLose', '一个没打掉 ⇒ 行动失败');
    assert.equal(resultVoiceSlot({ perfect: false, leaked: 0, killed: 7, total: 7, hard: true }), 'resultFour');
    assert.equal(resultVoiceSlot({ perfect: false, leaked: 0, killed: 7, total: 7 }), 'resultThree');
    // 「全灭」优先于「漏怪」：total>0 且 killed<=0 才算行动失败，漏不漏都无所谓
    assert.equal(resultVoiceSlot({ perfect: false, leaked: 3, killed: 0, total: 9 }), 'resultLose');
    // 空对象不抛，按"完美 + 普通"兜底
    assert.equal(resultVoiceSlot(), 'resultThree');
    assert.equal(resultVoiceSlot({ leaked: 'x', killed: null }), 'resultThree');
  });

  test('resultSpeaker: 存活者优先；全灭时由阵亡者代言；没有干员 ⇒ null', () => {
    const pp = { unitsEnd: [
      { defId: 'char_a', alive: false }, { defId: 'char_b', alive: true },
      { defId: 'token_x', alive: true }, { defId: null, alive: true },
    ] };
    assert.equal(resultSpeaker(pp, () => 0), 'char_b', '活着的干员先说（召唤物不说话）');
    assert.equal(resultSpeaker(pp, () => 0.999), 'char_b', '只有一位存活 ⇒ 怎么抽都是他');
    const wiped = { unitsEnd: [{ defId: 'char_a', alive: false }, { defId: 'char_b', alive: false }] };
    assert.equal(resultSpeaker(wiped, () => 0), 'char_a', '全灭 ⇒ 阵亡者代言');
    assert.equal(resultSpeaker(wiped, () => 0.9), 'char_b');
    assert.equal(resultSpeaker({ unitsEnd: [{ defId: 'token_x', alive: true }] }), null, '只有召唤物 ⇒ 没人说话');
    assert.equal(resultSpeaker({ unitsEnd: [] }), null);
    assert.equal(resultSpeaker(null), null, '不抛');
  });

  test('voiceKey: charId 直通；棋盘记录 / 棋子对象 / data source 都能解出干员', () => {
    assert.equal(voiceKey('char_263_skadi'), 'char_263_skadi');
    assert.equal(voiceKey({ charId: 'char_a' }), 'char_a');
    assert.equal(voiceKey({ id: 'chess_x' }, { getChess: (id) => (id === 'chess_x' ? { charId: 'char_a' } : null) }), 'char_a');
    assert.equal(voiceKey({ piece: { id: 'chess_y' } }, (id) => (id === 'chess_y' ? { charId: 'char_b' } : null)), 'char_b', 'gd 可以是函数');
    assert.equal(voiceKey('chess_unknown'), null, '没有 data source ⇒ 解不出');
    assert.equal(voiceKey(null), null);
    assert.equal(voiceKey({}), null);
  });
});

// ---- manager ----------------------------------------------------------------------------------------------

/** 只用于语音判据的最小 manifest：确定性 URL，不依赖 data/assets.json 的真实内容。 */
const VOICE_MANIFEST = {
  audio: {
    voice: {
      jp: {
        char_a: { start: '/v/jp/a_start.mp3', skill1: '/v/jp/a_s1.mp3', place: ['/v/jp/a_p1.mp3', '/v/jp/a_p2.mp3'], faceEnemy: '/v/jp/a_fe.mp3' },
        char_b: { place: '/v/jp/b_p.mp3', skill2: '/v/jp/b_s2.mp3' },
      },
      cn: { char_a: { start: '/v/cn/a_start.mp3' } },
    },
  },
};

function fakeWindow() {
  const listeners = new Map();
  const made = { started: 0, sources: 0 };
  class Param { constructor() { this.value = 1; } setValueAtTime(v) { this.value = v; } linearRampToValueAtTime(v) { this.value = v; } setTargetAtTime(v) { this.value = v; } cancelScheduledValues() {} }
  class Node { connect() {} disconnect() {} }
  class Gain extends Node { constructor() { super(); this.gain = new Param(); } }
  class Src extends Node { constructor() { super(); this.playbackRate = new Param(); made.sources++; } start() { made.started++; } stop() {} }
  class Ctx {
    constructor() { this.currentTime = 0; this.state = 'running'; this.destination = new Node(); }
    createGain() { return new Gain(); }
    createBufferSource() { return new Src(); }
    decodeAudioData(ab, ok) { ok({ duration: 0.05, length: 128, numberOfChannels: 1 }); }
    resume() { return Promise.resolve(); }
    suspend() { return Promise.resolve(); }
  }
  return {
    made,
    win: { AudioContext: Ctx, document: { hidden: false, addEventListener() {} }, addEventListener(t, fn) { listeners.set(t, fn); }, removeEventListener(t) { listeners.delete(t); } },
    fire(t) { listeners.get(t)?.(); },
  };
}

/**
 * 解锁 + 记下被请求的 URL 与**真的起播了几次**。
 * ⚠️ 「某个台词又响了一次」不能用"请求次数"判：`_buffer` 按 URL 缓存，同一条文件第二次播**不会再发请求**
 * ⇒ 那种判据抓不到重播（2026-10-07 实测：engage 的守卫被改坏后断言照样绿）。所以有 `made.started`。
 * `openGate()` 把闸门和在响的那条都放掉，模拟"上一条已经播完很久了"，让"本该不出声"的断言有区分力。
 */
async function rig(manifestLike = VOICE_MANIFEST) {
  const fw = fakeWindow();
  const urls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (u) => { urls.push(u); return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) }; };
  const a = new AudioManager({ win: fw.win, getManifest: () => manifestLike, random: () => 0.5 });
  a.install();
  fw.fire('pointerdown');
  return {
    a, urls, made: fw.made,
    settle: () => new Promise((r) => setTimeout(r, 5)),
    openGate: () => { a.voiceGate.reset(); a.voiceNode = null; a.voiceToken += 1; },
    restore: () => { globalThis.fetch = origFetch; },
  };
}

describe('AudioManager 语音声道', () => {
  test('没有 AudioContext / 静音 / 音量 0：一声不出', async () => {
    const a = new AudioManager({ win: null, getManifest: () => VOICE_MANIFEST });
    assert.equal(a.voice('char_a', 'start'), false, '没解锁（没有 ctx）');
    const { a: a2, urls, settle, restore } = await rig();
    try {
      a2.setVolumes({ muted: true });
      assert.equal(a2.voice('char_a', 'start'), false);
      a2.setVolumes({ muted: false, voice: 0 });
      assert.equal(a2.voice('char_a', 'start'), false);
      await settle();
      assert.equal(urls.length, 0, '静音 / 0 音量 ⇒ 一个请求都不发');
      a2.setVolumes({ voice: 0.8 });
      assert.equal(a2.voice('char_a', 'start'), true);
      await settle();
      assert.ok(asked(urls, '/v/jp/a_start.mp3'));
    } finally { restore(); }
  });

  test('语音语言：先本语言、缺了回退另一种；切换语言立即生效', async () => {
    const { a, urls, settle, openGate, restore } = await rig();
    try {
      assert.equal(a.voiceLang, 'jp', '默认日语');
      assert.equal(a.voice('char_a', 'start'), true);
      await settle();
      assert.ok(asked(urls, '/v/jp/a_start.mp3'));

      // char_a 的 cn 只有 start：日语下的 place 用 jp 的
      openGate();
      assert.equal(a.voice('char_a', 'place'), true);
      await settle();
      assert.equal(askedCount(urls, '/v/jp/a_p1.mp3') + askedCount(urls, '/v/jp/a_p2.mp3'), 1, '同槽多条随机取一条');

      // 切到中文：start 用 cn 的；cn 没有 place ⇒ 回退 jp（⚠️ 缓冲区按 URL 缓存，第二条同样的 jp 文件不会重新请求
      // ⇒ 这里看**实际在响的那条**，不是请求次数）
      a.setVoiceLang('cn');
      assert.equal(a.voiceLang, 'cn');
      openGate();
      assert.equal(a.voice('char_a', 'start'), true);
      await settle();
      assert.equal(a.voiceNode?.url, '/v/cn/a_start.mp3', '中文 start');
      openGate();
      assert.equal(a.voice('char_a', 'place'), true);
      await settle();
      assert.ok(['/v/jp/a_p1.mp3', '/v/jp/a_p2.mp3'].includes(a.voiceNode?.url), `cn 缺 place ⇒ 回退日语那条（实际 ${a.voiceNode?.url}）`);

      // setVolumes 也能带语言（settings 走的就是这条路），非法值忽略
      a.setVolumes({ voiceLang: 'jp' });
      assert.equal(a.voiceLang, 'jp');
      a.setVolumes({ voiceLang: 'en' });
      assert.equal(a.voiceLang, 'jp', '非法语言不生效');
    } finally { restore(); }
  });

  test('同一个干员在响时不再叠一条；没有这台词的干员一声不出', async () => {
    const { a, urls, settle, restore } = await rig();
    try {
      assert.equal(a.voice('char_a', 'start'), true);
      assert.equal(a.voice('char_a', 'skill1'), false, '同一位还在响 ⇒ 不再叠加');
      assert.equal(a.voice('char_c', 'start'), false, 'manifest 里没有这位 ⇒ false');
      assert.equal(a.voice('', 'start'), false);
      assert.equal(a.voice('char_a', 'no_such_slot'), false, '没有这一槽');
      await settle();
      assert.equal(urls.length, 1, '只有第一条真的去取文件');
    } finally { restore(); }
  });

  test('进入场次：第一位有 行动出发 台词的干员说 start；开局那批不说 部署', async () => {
    const { a, urls, settle, openGate, restore } = await rig();
    try {
      a.setFieldUnits([
        { id: 1, side: 'ally', kind: 'op', defId: 'char_a', spine: 'char_a' },
        { id: 2, side: 'ally', kind: 'op', defId: 'char_b', spine: 'char_b' },
        { id: 9, side: 'enemy', kind: 'enemy', defId: 'enemy_x', spine: 'enemy_x' },
      ]);
      await settle();
      assert.ok(asked(urls, '/v/jp/a_start.mp3'), '进入场次 ⇒ 行动出发');
      assert.equal(a.startVoiceDone, true);

      // 开局的整批部署（它们就在场次名单里）不该齐声喊 部署
      openGate();
      const before = urls.length;
      a.handleBattleEvents([['deploy', 1], ['deploy', 2]]);
      await settle();
      assert.equal(a.initialUnits.size, 3, '场次名单就是初始批');
      assert.equal(urls.length, before, '开局那批部署不出声');
    } finally { restore(); }
  });

  test('战斗中途的部署说 部署；召唤物 / 敌人不说', async () => {
    const { a, urls, settle, openGate, restore } = await rig();
    try {
      a.setFieldUnits([{ id: 1, side: 'ally', kind: 'op', defId: 'char_a', spine: 'char_a' }]);
      await settle();
      openGate();
      a.handleBattleEvents([
        ['spawn', { id: 5, side: 'ally', kind: 'op', defId: 'char_b', spine: 'char_b' }],
        ['deploy', 5],
        ['spawn', { id: 6, side: 'ally', kind: 'token', defId: 'token_x', spine: 'token_x' }],
        ['deploy', 6],
        ['spawn', { id: 7, side: 'enemy', kind: 'enemy', defId: 'enemy_x', spine: 'enemy_x' }],
        ['deploy', 7],
      ]);
      await settle();
      assert.ok(asked(urls, '/v/jp/b_p.mp3'), '中途部署的干员说 部署');
      assert.equal(askedCount(urls, '/v/jp/a_p1.mp3') + askedCount(urls, '/v/jp/a_p2.mp3'), 0, '召唤物 / 敌人不占用干员台词');
    } finally { restore(); }
  });

  test('作战中N 用装备技能的序号；接敌只在该单位第一次主动攻击时响一次', async () => {
    const { a, urls, made, settle, openGate, restore } = await rig();
    try {
      const units = [
        { id: 1, side: 'ally', kind: 'op', defId: 'char_a', spine: 'char_a', skillIndex: 0 },
        { id: 2, side: 'ally', kind: 'op', defId: 'char_b', spine: 'char_b', skillIndex: 1 },
        { id: 8, side: 'enemy', kind: 'enemy', defId: 'enemy_x', spine: 'enemy_x' },
      ];
      a.setFieldUnits(units);
      await settle();
      openGate();
      a.handleBattleEvents([['skill', 1, 'sk_a']]);
      await settle();
      assert.ok(asked(urls, '/v/jp/a_s1.mp3'), 'skillIndex 0 ⇒ 作战中1');
      openGate();
      a.handleBattleEvents([['skill', 2, 'sk_b']]);
      await settle();
      assert.ok(asked(urls, '/v/jp/b_s2.mp3'), 'skillIndex 1 ⇒ 作战中2');

      // 接敌：第一次打敌人时响；同一单位再来一次不响。
      // ⚠️ 判据必须是"起播次数"（`made.started`）：同一条台词第二次播不会再发请求（URL 缓存）⇒ 请求数抓不到重播。
      a.setFieldUnits(units);
      a.startVoiceDone = true;
      openGate();
      const n0 = made.started;
      a.handleBattleEvents([['atk', 1, 8, 'arrow']]);
      await settle();
      assert.ok(asked(urls, '/v/jp/a_fe.mp3'), '首次接敌');
      assert.equal(made.started, n0 + 1, '接敌台词真的起播了一次');
      const n1 = made.started;
      openGate();
      a.handleBattleEvents([['atk', 1, 8, 'arrow']]);
      await settle();
      assert.equal(made.started, n1, '同一单位不再喊第二次');
      // 打自己人（治疗）不算接敌
      a.setFieldUnits(units);
      openGate();
      const n2 = made.started;
      a.handleBattleEvents([['atk', 2, 1, 'orb']]);
      await settle();
      assert.equal(a.engaged.size, 0, '友方攻击不算接敌');
      assert.equal(made.started, n2, '友方攻击一声不出');
      // 真正的 'engage' 元组也认
      a.handleBattleEvents([['engage', 1]]);
      await settle();
      assert.equal(a.engaged.has(1), true);
    } finally { restore(); }
  });

  test('换场次会把闸门、冷却、初始批与在场单位全部重置', async () => {
    const { a, urls, settle, restore } = await rig();
    try {
      a.setFieldUnits([{ id: 1, side: 'ally', kind: 'op', defId: 'char_a', spine: 'char_a' }]);
      await settle();
      assert.equal(a.startVoiceDone, true, '第一场：char_a 有 start ⇒ 说了 行动出发');
      a.handleBattleEvents([['atk', 1, 8, 'arrow']]);
      a.engaged.add(1);

      // 新场次的第一位是 char_b（这台词表里没有 start）⇒ 复位后没有置位，交给第一个中途部署的干员说
      a.setFieldUnits([{ id: 4, side: 'ally', kind: 'op', defId: 'char_b', spine: 'char_b' }]);
      await settle();
      assert.equal(a.startVoiceDone, false, 'char_b 没有 行动出发 台词 ⇒ 留待后来者（上游语义）');
      assert.deepEqual([...a.initialUnits], [4], '初始批按新场次重建');
      assert.equal(a.engaged.size, 0, '接敌标记按场次清空');
      assert.equal(a.voiceGate.playing, null, '旧场次的闸门残留被清掉');
      assert.equal(a.units.has(1), false, '旧场次的单位不再跟踪');
      // 新场次里第一条台词照常播出（旧场次的冷却 / 闸门不该拦住）
      urls.length = 0;
      assert.equal(a.voice('char_b', 'place'), true);
      await settle();
      assert.ok(asked(urls, '/v/jp/b_p.mp3'));
    } finally { restore(); }
  });
});

// ---- 产物：清单与磁盘 --------------------------------------------------------------------------------------

describe('data/assets.json 的 audio.voice 与磁盘一致 (W-3 产物)', () => {
  const voice = manifest.audio?.voice;

  test('两种语言、12 个槽、每条引用都能在磁盘上找到', () => {
    assert.ok(voice, 'audio.voice 必须在清单里（跟着 tools/assets/plan.mjs 原生产出，不是事后注入）');
    assert.deepEqual(Object.keys(voice).sort(), ['cn', 'jp']);
    const SLOTS = ['start', 'faceEnemy', 'select', 'place', 'skill1', 'skill2', 'skill3', 'skill4',
      'resultFour', 'resultThree', 'resultTwo', 'resultLose'];
    let refs = 0;
    const badSlots = [];
    const missing = [];
    for (const [lang, chars] of Object.entries(voice)) {
      assert.ok(Object.keys(chars).length >= 100, `${lang}: 至少 100 位干员（实测 ${Object.keys(chars).length}）`);
      for (const [charId, slots] of Object.entries(chars)) {
        assert.match(charId, /^char_/, `${lang} 的键是 charId：${charId}`);
        for (const [slot, line] of Object.entries(slots)) {
          if (!SLOTS.includes(slot)) badSlots.push(`${lang}/${charId}/${slot}`);
          for (const p of Array.isArray(line) ? line : [line]) {
            refs += 1;
            assert.match(p, /^\/assets\/audio\/voice\/(jp|cn)\/[a-z0-9_]+\/[a-z0-9_]+\.mp3$/, `路径形状：${p}`);
            if (!existsSync(path.join(ROOT, 'public', p.replace(/^\//, '')))) missing.push(p);
          }
        }
      }
    }
    assert.deepEqual(badSlots, [], '槽名必须在那 12 个之内');
    assert.ok(refs >= 3000, `引用条数（实测 ${refs}）`);
    assert.deepEqual(missing.slice(0, 10), [], `清单引用但磁盘没有的文件（共 ${missing.length}）`);
  });

  test('音频在 /media/ 路由下也能取到（无扩展名形式）', () => {
    const first = Object.values(voice.jp)[0].start || Object.values(Object.values(voice.jp)[0])[0];
    const one = Array.isArray(first) ? first[0] : first;
    assert.match(mediaUrl(one), /^\/media\//, 'audio.js 先请求无扩展名的 /media/ 路径');
  });
});
