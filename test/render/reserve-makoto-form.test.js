// test/render/reserve-makoto-form.test.js — 结城理 (`char_4217_makoto`, 傀儡师) 的**渲染层**判据（第 52 轮 A 加）。
//
// 为什么单写一份：`public/js/render/units.js` 的 `FORMS` 是**按 charId 硬编码的白名单**，第 51 轮交付时
// **没有 `char_4217_makoto`** ⇒ `app.js:1698` 先过白名单（不在表里就不写 `inf.form`）＋ `units.js:550` 再挡一次
// ⇒ **引擎把 `form:'doll'` 发到了、客户端一帧都不切**：这正是用户实机的
// 「三技能**出现替身图标，但并没有出现替身**，也没有变化攻击范围（范围见 test/content/reserve-makoto-realpath.test.js）、
//  **人物模型不变**」里"模型不变"那一半。（"有图标"= fx 到了 ⇒ 问题在**画**的那一层。）
//
// 本文件断三层（与第 51 轮 A §12 的六条对应）：
//   ① **素材真的在**：`FORMS` 里写下的**每一个 clip 名**都必须在真 `data/assets.json` 的对应骨骼里存在
//      （多写一个不存在的 clip ⇒ 变形态那一刻静默退化/黑屏；这正是第 51 轮"照 kazema 抄 `Start_B`"会踩的坑 ——
//       makoto 骨骼里**根本没有** `_B`/`_2` 组，见 `协作/移交` 与 C 的 PRTS 取证）。
//   ② **真的切得动**：真的建一个 `UnitView`，`setForm('doll')` 后 clip 必须换成该形态的 clip（**不是**本体 `Idle`）；
//      切回本体必须回到本体 clip（走 `leave`）。
//   ③ **一个形态多套 clip**：`doll` 按 `UnitInfo.skillIndex` 分 S1 俄耳甫斯 / S2 塔纳托斯 / S3 P1 塔纳托斯·改，
//      外加 sim 侧 kit 自己发的 `doll_orpheus`（S3 P2 俄耳甫斯·改）。
// 红线性（"写了测试就要证明它会失败"）：最后一条**哨兵**用例断"白名单外的形态一律不动" ——
// **本文件加的 FORMS 条目被删掉时，②③ 会立刻红**（我实测过：先写本文件 → ②③ 全红 → 加表后绿）。
//
// ⚠️ 归 属：`public/js/render/**` 是 B 的地盘。第 52 轮 A 改它**事先报备**（`协作/已知问题.md` 末段）＋
//   给 B 留了 `协作/A给B-动了你的render-2026-10-07.md`（用户 2026-10-07 当面批准）。**本文件是 A 自己新增的**，
//   没有改 B/D 的任何既有测试文件。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakePixi, fakeViewCtx } from './fakepixi.js';
import { presetCamera } from '../../public/js/render/projection.js';
import { spineEntry, hasBackSpine } from '../../public/js/assets.js';
import { DOLL_SWITCH } from '../../server/sim/professions.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const assets = JSON.parse(readFileSync(path.join(ROOT, 'data/assets.json'), 'utf8'));
const MAKOTO = 'char_4217_makoto';
/** 官方技能 → 形态（PRTS `https://prts.wiki/w/结城理` 的技能/备注节）。 */
const SKILL_FORM = { 0: 'S1 <俄耳甫斯>', 1: 'S2 <塔纳托斯>', 2: 'S3 P1 <塔纳托斯·改>' };

let fake, UnitView, FORMS, renderInfo;
before(async () => {
  fake = installFakePixi();
  ({ UnitView, FORMS } = await import('../../public/js/render/units.js'));
  ({ renderInfo } = await import('../../public/js/render/app.js'));
});
after(() => fake.restore());

const tick = () => new Promise((r) => setImmediate(r));
const cam = () => presetCamera('normal', { width: 1280, height: 720 });
function store() {
  const s = {
    picture: () => null,
    image: async () => null,
    hasBack: (id) => hasBackSpine(assets, id),
    spineEntry: (id, o) => spineEntry(assets, id, o),
    spine: { acquire: async (entry) => ({ animations: Object.keys(entry.animations || {}).map((name) => ({ name })) }), release() {} },
  };
  return s;
}
/** A real UnitView of 结城理 on the real manifest (Front model). */
async function makoto(info = {}, opts = {}) {
  const ctx = fakeViewCtx(fake.P, { assets: store(), cam, ...opts });
  const v = new UnitView(ctx, { id: 1, side: 'ally', kind: 'op', defId: 'chess_makoto_a', spine: MAKOTO, tier: 6, x: 5, y: 9, maxHp: 2215, dir: 'RIGHT', skillIndex: 2, ...info });
  await tick(); await tick();
  assert.ok(v.actor, 'Spine model built');
  return v;
}
const clip = (v) => v.actor.current;
const frames = (v, n, dt = 1 / 60) => { for (let i = 0; i < n; i++) v.update(dt, cam(), i * dt); };
/** Every clip name a form spec asks for (change / leave / roles…). */
const clipsOf = (f) => [f.change, f.leave, f.roles.idle, f.roles.deploy, f.roles.die, f.roles.stun?.loop, f.roles.attack?.loop].filter((x) => typeof x === 'string');

describe('结城理 的替身形态 (FORMS char_4217_makoto)', () => {
  test('表里有他 —— 白名单缺一条就是"引擎发得出、客户端画不出"（本次返工的根因）', () => {
    assert.ok(FORMS[MAKOTO], 'FORMS 必须有 char_4217_makoto');
    assert.ok(FORMS[MAKOTO].doll, '替身形态 `doll`（引擎 professions.js 发的就是它）');
    assert.ok(FORMS[MAKOTO].doll_orpheus, 'S3 第二段 `doll_orpheus`（<俄耳甫斯·改>，kit 自己发）');
  });

  test('① 素材：每条 clip 都在真骨骼里（front）；S2 / P2 没有攻击 clip＝官方"不进行普通攻击"', () => {
    const front = assets.chars[MAKOTO].spine.front.animations;
    const sets = { ...FORMS[MAKOTO].doll.bySkill, doll_orpheus: FORMS[MAKOTO].doll_orpheus };
    for (const [k, f] of Object.entries(sets)) {
      const names = clipsOf(f);
      assert.ok(names.length >= 4, `${k}: 形态至少要有 change/leave/idle/die`);
      for (const name of names) assert.ok(name in front, `${k}: 骨骼里没有 ${name}`);
    }
    // 官方 S3 备注「<俄耳甫斯·改> 不进行普通攻击」＋素材只有 Loop ⇒ 必须**没有**攻击 clip
    assert.equal(FORMS[MAKOTO].doll_orpheus.roles.attack, null, 'P2 不普攻');
    assert.equal(FORMS[MAKOTO].doll.bySkill[1].roles.attack, null, 'S2 <塔纳托斯> 的素材也没有攻击 clip');
    assert.equal(FORMS[MAKOTO].doll.bySkill[0].roles.attack.loop, 'Doll_Skill_1_Attack', 'S1 <俄耳甫斯> 有攻击 clip');
    // ⚠️ 别照抄别的傀儡师：这套骨骼里**没有** `_B` / `_2` 组
    for (const bogus of ['Start_B', 'Idle_B', 'Die_B', 'Die_B_2', 'Start_2']) assert.ok(!(bogus in front), `这本骨骼里不存在 ${bogus}`);
    // back 骨骼是 front 的子集（朝上部署走优雅兜底，不报错）
    const back = assets.chars[MAKOTO].spine.back.animations;
    assert.ok(assets.chars[MAKOTO].spine.back, 'back 骨骼在');
    for (const name of ['Doll_Skill_1_SwitchIn', 'Doll_Skill_1_SwitchOut', 'Doll_Skill_1_Die', 'Doll_Skill_3_P2_Loop']) {
      assert.ok(!(name in back), `back 里没有 ${name}（spine.js has() 兜底，不该崩）`);
    }
    assert.ok('Doll_Skill_1_Idle' in back && 'Doll_Skill_2_Loop' in back && 'Doll_Skill_3_P1_Idle' in back, 'back 里有三段替身的待机 clip');
  });

  for (const idx of [0, 1, 2]) {
    test(`② 真的切得动：skillIndex=${idx}（${SKILL_FORM[idx]}）⇒ clip 换成该形态的进入/待机 clip，切回本体走 leave`, async () => {
      const v = await makoto({ skillIndex: idx });
      assert.equal(clip(v), 'Idle', '本体');
      const f = FORMS[MAKOTO].doll.bySkill[idx];
      v.setForm('doll', { id: 1, form: 'doll', dur: DOLL_SWITCH + 20 });
      assert.equal(v.form, 'doll');
      assert.equal(clip(v), f.change, '先播该形态自己的 SwitchIn');
      frames(v, Math.ceil((assets.chars[MAKOTO].spine.front.animations[f.change] || 1) * 60) + 4);
      assert.equal(clip(v), f.roles.idle, `过渡完进 ${f.roles.idle}（**不是**本体 Idle）`);
      assert.notEqual(clip(v), 'Idle', '模型必须真的换了');
      v.setForm(null, { id: 1, form: null });
      assert.equal(clip(v), f.leave, '切回本体：播该形态自己的 SwitchOut');
      frames(v, Math.ceil((assets.chars[MAKOTO].spine.front.animations[f.leave] || 1) * 60) + 4);
      assert.equal(clip(v), 'Idle', '本体 clip 回来了');
    });
  }

  test('③ S3 第二段：`doll_orpheus` ⇒ ChangeBegin 过渡后进 P2 待机（P1toP2 的两段动画只播第一段，见 kit [ASSUMED]⑧）', async () => {
    const v = await makoto({ skillIndex: 2 });
    v.setForm('doll', { id: 1, form: 'doll', dur: DOLL_SWITCH + 20 });
    frames(v, 60);
    assert.equal(clip(v), 'Doll_Skill_3_P1_Idle', '先是 P1 <塔纳托斯·改>');
    v.setForm('doll_orpheus', { id: 1, form: 'doll_orpheus', kind: 'doll_orpheus' });
    assert.equal(clip(v), 'Doll_Skill_3_P1toP2_ChangeBegin', 'P1⇒P2 的切换动画');
    frames(v, 40);
    assert.equal(clip(v), 'Doll_Skill_3_P2_Loop', '进 P2 <俄耳甫斯·改>');
    v.setForm(null, { id: 1, form: null });
    assert.equal(clip(v), 'Doll_Skill_3_P2_SwitchOut');
  });

  test('③ 晚建的视图（掉线重连 / 观战：没有重放那次切换的 fx）按 UnitInfo 直接起在替身形态上', async () => {
    const v = await makoto({ form: 'doll', skillIndex: 1 });
    assert.equal(clip(v), 'Doll_Skill_2_Loop', 'S2 的 <塔纳托斯> 待机');
    const w = await makoto({ form: 'doll', skillIndex: 0 });
    assert.equal(clip(w), 'Doll_Skill_1_Idle', 'S1 的 <俄耳甫斯> 待机');
    const x = await makoto({ form: 'doll_orpheus', skillIndex: 2 });
    assert.equal(clip(x), 'Doll_Skill_3_P2_Loop', 'S3 的 P2');
    // renderInfo 不许把 form / skillIndex 丢掉（丢了晚建的视图就退回本体）
    const info = renderInfo({ id: 3, kind: 'op', side: 'ally', defId: 'chess_makoto_a', spine: MAKOTO, form: 'doll_orpheus', skillIndex: 2 });
    assert.equal(info.form, 'doll_orpheus');
    assert.equal(info.skillIndex, 2);
  });

  test('哨兵（红线性）：白名单里没有的形态一律**一动不动** —— 这就是本次返工前 makoto 的处境', async () => {
    const v = await makoto({ skillIndex: 2 });
    v.setForm('doll', { id: 1, form: 'doll', dur: 21 });
    const before = clip(v);
    assert.notEqual(before, 'Idle');
    v.setForm('not_a_form_of_this_skeleton');       // app.js:1698 / units.js:550 的同一个白名单闸
    assert.equal(v.form, 'doll', '形态字段不许被写坏');
    assert.equal(clip(v), before, 'clip 不许变');
    assert.equal(FORMS[MAKOTO].not_a_form_of_this_skeleton, undefined);
  });

  // 第二天赋「S.E.E.S.队长」的 <总攻击>（用户实机：「天赋的**真实伤害我并未看出来**」—— 一半原因就是**屏幕上没有演出**）。
  // 官方天赋备注：替身结束后**先切 `<总攻击>` 形态**发起总攻击，**随后再切换回 `<本体>`**。素材是现成的两支 clip：
  // `Skill_AllOutAttack_Loop`(0.167 s) ＋ `Skill_AllOutAttack_End`(1.433 s)，sim 的 `ALLOUT_DUR` 就是这两个相加。
  test('④ <总攻击> 形态：Loop → 收尾 End（正好在形态结束时播完）→ 回本体 —— 两支 clip 都在真骨骼里', async () => {
    const front = assets.chars[MAKOTO].spine.front.animations;
    const f = FORMS[MAKOTO].allout;
    assert.ok(f, 'FORMS 必须有 allout');
    for (const n of [f.end, f.roles.idle]) assert.ok(n in front, `骨骼里没有 ${n}`);
    const dur = front[f.roles.idle] + front[f.end];         // 0.167 + 1.433 = 1.6
    assert.equal(f.roles.attack, null, '<总攻击> 是演出，不是普攻');
    const v = await makoto({ skillIndex: 2 });
    v.setForm('allout', { id: 1, form: 'allout', dur });
    assert.equal(clip(v), f.roles.idle, '先播 Loop');
    frames(v, Math.round(front[f.roles.idle] * 60) + 6);
    assert.equal(clip(v), f.end, 'Loop 播完 ⇒ 收尾 clip');
    frames(v, Math.round(front[f.end] * 60) + 6);
    assert.equal(clip(v), 'Idle', '形态结束 ⇒ 回本体 clip');
  });
});
