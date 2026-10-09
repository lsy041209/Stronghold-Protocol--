// test/render/chen3dragon.test.js — 陈 S3「赤霄·天喟」**龙的表现**护栏（B，2026-10-06）
//
// 背景（C 的玩法单 §1）：用户报「赤刃明霄陈的 S3 看不到龙/剑气」。C 查出两件事：
//   ① **主因是环境**：线上跑的是 10-05 旧代码，`fx.js` 连 `hasPt` 都没有（`hasPt` 0 命中、
//      `chen3Dragon` 0 命中）⇒ 在本机/线上看到的**必然是旧的**，与代码对错无关。
//   ② **一条可疑残余**（C 标为「判断，请 B 验」）：`fx.js:1738` 的官方叠图只在
//      `ex.skill === 'chen3Dragon'`（**龙头**）触发，龙身 `chen3DragonBody` 与出生
//      `chen3DragonSpawn` 不匹配 ⇒ 可能「只有龙头华丽、龙身几乎看不见」。
//
// 本文件把 ② 拆成**两个可判定的问题**，并各自给出判据：
//   A. 机制问题：龙的两处**坐标载荷**光束是否真的进 `beamList`、会不会退化成 `strike()` 兜底？
//      ⇒ 实测：**不会**。`_point()` 每次返回**新对象**，所以 `a !== b` 成立；
//        `_bodyPt/_proj` 对纯坐标点也给出正常宽度 ⇒ 光束是**画出来了**的。
//        **C 的"降级成 strike()"机制不成立**（这条 A 现在是**绿**的，它同时是 B 的"假绿哨兵"：
//        若哪天有人把 `_point` 改成返回复用对象，A 会立刻变红）。
//   B. 观感问题：官方叠图（星爆 + 火焰须 + 速度光带）是否覆盖**每一段**？
//      ⇒ 实测：**只有头有**，龙身没有 ⇒ 这条 B **先红**，红在哪就是缺陷在哪。
//   C. 哨兵：**非龙**的普通近战 slash 不许吃到官方叠图（否则会显脏 —— 源码注释里也是这么写的）。
//
// 口径（改完之后以本文件为准）：**凡是 `chen3Dragon*` 的命中（counter/slash）都叠官方三张贴图**；
// 「只有 `chen3Dragon` 才叠」是**漏了龙身**，不是刻意设计。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { installFakePixi, fakeViewCtx } from './fakepixi.js';
import { presetCamera } from '../../public/js/render/projection.js';

let fake, FX;
before(async () => {
  fake = installFakePixi();
  FX = await import('../../public/js/render/fx.js');
});
after(() => { fake?.restore(); });

const cam = presetCamera('normal', { width: 1600, height: 900 });

/** 一个单位视图，形状按 FX 系统读它的方式给（与 `fxproj.test.js` 同一套）。 */
function unit(id, x, y, o = {}) {
  return { id, x, y, z: 0, hover: 0, _headTiles: 1.2, alive: true, destroyed: false, isEnemy: false, maxHp: 3000, info: { defId: 'char_x' }, onHit() {}, ...o };
}

function makeFx({ quality = 'high', ts = 2, load = 0, views = [] } = {}) {
  const P = fake.P;
  const ctx = fakeViewCtx(P);
  const map = new Map(views.map((v) => [v.id, v]));
  const fx = new FX.FxSystem({
    P, layers: ctx.layers, cam: () => cam, heightAt: () => 0, settings: { quality, damageNumbers: true },
    timeScale: () => ts, loadLevel: () => load, subProfOf: () => null, view: (id) => map.get(id) || null,
    screenSize: () => ({ width: 1600, height: 900 }), fieldTop: () => 120,
  });
  return { fx, map };
}

const liveTex = (fx, name) => fx.parts.filter((p) => p.sp.texture === fx.tex[name]);
/** 官方叠图的三张贴图（日服客户端解包；见 `fx.js:1738` 与 `textures.js` 的 `jpFxTextures()`）。 */
const STACK = ['jpBurst', 'jpFlame', 'jpFlare'];
/** 一次龙段事件里，官方叠图那三张贴图各自的粒子（按**贴图身份**认，不按名字/顺序）。 */
const stackParts = (fx) => fx.parts.filter((p) => STACK.some((n) => p.sp.texture === fx.tex[n]));
/** 一次事件里"全不透明"的粒子（起手 a0 ≥ 0.8 —— 叠加混合下它就是一坨亮斑）。 */
const opaqueParts = (fx) => fx.parts.filter((p) => p.a0 >= 0.8);
const hexes = (set) => [...set].map((t) => '0x' + Number(t).toString(16)).join(' / ');

describe('陈 S3 赤霄·天喟：龙的表现', () => {
  // ── A. 机制：坐标载荷光束必须真的进 beamList，且不许退化成 strike() 兜底 ──
  // 载荷形状**照抄 `reserve-chen3.js:288/294`**（注意：**没有** `src`/`from`，只有 `id`）——
  // 这一点很关键：龙的光束起点靠 `ex.x/ex.y`，不是靠单位视图。
  test('A. 龙身连线 / 出生光都进 beamList，且不退化成 strike()', () => {
    const chen = unit(1, 5, 10);
    const { fx } = makeFx({ views: [chen] });

    // reserve-chen3.js:288 —— 段间连线 `fx('beam', { x: pc, y: pr, tx: sc, ty: sr, id, skill: 'chen3DragonBody' })`
    fx.simFx('beam', 5, 10, { x: 5, y: 10, tx: 7, ty: 10, id: 1, skill: 'chen3DragonBody' });
    assert.equal(fx.beamList.length, 1, '龙身连线应进 beamList');
    const b1 = fx.beamList[0];
    assert.ok(b1.a && b1.b && b1.a !== b1.b, '两个端点都解析出来了（不是退化）');
    assert.ok(Math.abs(b1.b.x - 7) < 1e-9 && Math.abs(b1.b.y - 10) < 1e-9, '终点 = 事件的 tx/ty');

    // reserve-chen3.js:294 / :394 —— 出生 `fx('beam', { x: unit.x, y: unit.y, tx: unit.tileC, ty: unit.tileR, … })`
    fx.simFx('beam', 5, 10, { x: 5, y: 10, tx: 6, ty: 11, id: 1, skill: 'chen3DragonSpawn' });
    assert.equal(fx.beamList.length, 2, '出生光也应进 beamList');

    // 反证：`strike()` 兜底会画 pillar ⇒ 不许出现
    assert.equal(liveTex(fx, 'pillar').length, 0, '龙的坐标载荷不许退化成 strike()');
  });

  // ── B. 观感：官方叠图要覆盖**每一段**（头 **和** 身）—— 本条**先红** ──
  test('B. 官方叠图（星爆/火焰须/速度光带）覆盖龙的每一段，不是只有头', () => {
    const chen = unit(1, 5, 10);

    // 龙头（reserve-chen3.js:229 与 :284 的 i===0）
    {
      const { fx } = makeFx({ views: [chen] });
      fx.simFx('slash', 5, 10, { id: 1, src: 1, skill: 'chen3Dragon' });
      for (const n of STACK) assert.ok(liveTex(fx, n).length >= 1, `龙头应吃到 ${n}`);
    }

    // 龙身（reserve-chen3.js:284 的 i>0）—— **现在红**：只有 `chen3Dragon` 被匹配
    {
      const { fx } = makeFx({ views: [chen] });
      fx.simFx('slash', 5, 10, { id: 1, src: 1, skill: 'chen3DragonBody' });
      for (const n of STACK) {
        assert.ok(liveTex(fx, n).length >= 1,
          `龙身也应吃到 ${n}（现状：只有 chen3Dragon 匹配 ⇒ 龙身整段没有官方叠图）`);
      }
    }
  });

  // ── C. 哨兵：普通近战 slash 不许吃到叠图（否则"会显脏"，见 fx.js:1737 的注释）──
  test('C. 哨兵：非龙的普通近战 slash 不许吃到官方叠图', () => {
    const a = unit(1, 5, 10), b = unit(2, 6, 10, { isEnemy: true });
    const { fx } = makeFx({ views: [a, b] });
    fx.simFx('slash', 6, 10, { x: 6, y: 10, id: 1, src: 1, skill: undefined });
    for (const n of STACK) assert.equal(liveTex(fx, n).length, 0, `普通 slash 不许有 ${n}`);
    // 另一个 chen3 技能（转身）也不该蹭到龙的叠图
    const { fx: fx2 } = makeFx({ views: [a, b] });
    fx2.simFx('slash', 6, 10, { x: 6, y: 10, id: 1, src: 1, skill: 'chen3DragonTurn' });
    for (const n of STACK) assert.equal(liveTex(fx2, n).length, 0, `chen3DragonTurn 不是龙身，不该有 ${n}`);
  });

  // ══ D–G. 亮度 / 可辨识度 ═══════════════════════════════════════════════════════════════════════════
  // 来源：用户 2026-10-06 06:3x 实机反馈 ——「**赤刃明霄陈 3 技能的剑气（龙）看上去太晃眼睛了，
  // 看上去也不够清晰**」（C 定归属给 B，`fx.js`）。
  //
  // 为什么"每段"是判据单位：龙是**逐段（3 段）× 每一帧**发事件的
  // （`reserve-chen3.js:282-291` 的 for 循环在 `while (d.acc >= 1)` **之外** ⇒ 不移动也照发）。
  // ⇒ 单段上多出来的每一个亮斑，都会被「段数 × 帧率」乘一遍；龙越长、帧越密，叠得越亮，
  //    而龙本体（Spine 白刃段）被这层亮斑糊住 ⇒ 同时解释"晃眼"与"不够清晰"。
  // 判据形状（**故意不是"源码窗口 match"**，见 `交接-B到新B-2026-10-06-0640.md` §3-1 的假绿教训）：
  // 全部断言**跑出来的粒子记录**（`fx.parts` 的 a0 / tint / s0 / s1），不匹配源码文本。
  test('D. 龙每一段的官方叠图都是半透明的（起手 a0 ≤ 0.5），不是三个全不透明亮斑', () => {
    for (const skill of ['chen3Dragon', 'chen3DragonBody']) {
      const { fx } = makeFx({ views: [unit(1, 5, 10)] });
      fx.simFx('slash', 5, 10, { id: 1, src: 1, skill });
      const parts = stackParts(fx);
      // 先钉"非空"，否则下面整段循环在"贴图被删光"时**静默变绿**（vacuous truth）
      assert.equal(parts.length, STACK.length, `${skill} 每一段都应叠齐 ${STACK.length} 张官方贴图，实际 ${parts.length}`);
      for (const p of parts) {
        assert.ok(p.a0 <= 0.5,
          `${skill} 的叠图起手不透明度 a0=${p.a0} 太大（逐段 × 每帧叠加 ⇒ 糊成一团亮）`);
      }
    }
  });

  test('E. 龙每一段的官方叠图只允许一种色温（原来冷蓝 0xbfe4ff 与暖白 0xffd9c0 在同段互相打架）', () => {
    for (const skill of ['chen3Dragon', 'chen3DragonBody']) {
      const { fx } = makeFx({ views: [unit(1, 5, 10)] });
      fx.simFx('slash', 5, 10, { id: 1, src: 1, skill });
      const tints = new Set(stackParts(fx).map((p) => p.sp.tint));
      assert.equal(tints.size, 1, `${skill} 同段的官方叠图有 ${tints.size} 种色温（${hexes(tints)}）⇒ 底色互相打架、糊成一片`);
    }
  });

  test('F. 龙每一段官方叠图的放大倍率收敛（终态/起手 ≤ 2），不是一个亮斑涨到 2 倍还多', () => {
    for (const skill of ['chen3Dragon', 'chen3DragonBody']) {
      const { fx } = makeFx({ views: [unit(1, 5, 10)] });
      fx.simFx('slash', 5, 10, { id: 1, src: 1, skill });
      for (const p of stackParts(fx)) {
        const grow = p.s1 / p.s0;
        assert.ok(grow <= 2, `${skill} 的叠图放大倍率 ${grow.toFixed(2)} 太大（s0=${p.s0} → s1=${p.s1}）`);
      }
    }
  });

  test('G. 龙每一段不许再有"全不透明"粒子（a0 ≥ 0.8 的个数 ≤ 1）—— 普通近战每 hit 才发一次，龙是每帧发 3 段', () => {
    const { fx } = makeFx({ views: [unit(1, 5, 10)] });
    fx.simFx('slash', 5, 10, { id: 1, src: 1, skill: 'chen3Dragon' });
    const op = opaqueParts(fx);
    assert.ok(op.length <= 1,
      `一段龙身就有 ${op.length} 个全不透明粒子（${op.map((p) => 'a0=' + p.a0).join(', ')}）⇒ ×3 段 ×每帧 = 满屏亮斑`);
  });

  // ── H. 哨兵：**龙的降亮不许泄漏到普通近战**（近战每 hit 只发一次，原来的亮度是对的）──
  test('H. 哨兵：普通近战 slash 保持原亮度，不被龙的"逐段折扣"带着一起降', () => {
    const a = unit(1, 5, 10), b = unit(2, 6, 10, { isEnemy: true });
    const { fx } = makeFx({ views: [a, b] });
    fx.simFx('slash', 6, 10, { x: 6, y: 10, id: 1, src: 1, skill: undefined });
    const op = opaqueParts(fx);
    assert.ok(op.length >= 4,
      `普通近战每 hit 只发一次 ⇒ 该保持原来的亮度（现在只剩 ${op.length} 个全不透明粒子，像是被龙的折扣带下去了）`);
    assert.equal(stackParts(fx).length, 0, '普通近战不许吃官方叠图');
  });
});
