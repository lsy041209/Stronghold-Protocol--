// T3-D §1-8「活性源石 2D/3D 材质统一」的探针（第 8 任 B，2026-10-07）
//
// 依据：`协作/C-清点-上游0.1.4前端差距-2026-10-07.md` §1-8 与 §5「T3-D 的判据要求」：
//   「断言『2D 图集与 3D 材质取自**同一个** ORIGINIUM 调色板』＋『活性源石在 infection/infection2 间有变体』」
//
// 本文件把那条要求拆成**能红**的 5 组（先跑时应当**全红**：我方此时 `ORIGINIUM` 0 处）：
//   ① `style.js` 真的导出 `ORIGINIUM` 调色板 + `linearToSrgb255`/`linearToHex`（**纯函数，强断言**：端点/单调/精确值）
//   ② **3D 侧**：**真调用** `infectionMaterial(THREE, tex, focus)`（THREE 用桩），读它真正吐出的 GLSL ——
//      断言里面写进去的 vec3 **逐位等于** `ORIGINIUM` 的四个分量（= "取自同一个调色板"的**数值**证据），
//      并且**新配方**在（第三个八度的 `grain`、去掉了逐格 `edge` 淡出），而**旧的硬编码 vec3 必须不在**。
//   ③ **2D 侧**（源码，**必须剥注释**：这些函数名/说明在注释里也有）：`MATERIALS` 有 `infection2`；
//      `DEFAULT_ART_LAYERS` 的 `infection`/`infection2` 挂 `proc: originium/originium2`；
//      `PROC_LAYERS` 定义 `originium`/`originium2`；`MAT_DRAW.infection/infection2` 走 `originiumOverlay`；
//      而且 2D 的画法是**从 `ORIGINIUM.*` 取的色**（不是又一套字面量）。
//   ④ **变体**：`tiles.js` 的 `variantMat` 按格高在 `infection`/`infection2` 之间选；`case 'i'` 的加色脉冲用 `ORIGINIUM.glow`。
//   ⑤ **两边同一个源**：3D 的 GLSL 与 2D 的取色**都来自同一个 `ORIGINIUM` 对象**（②与③的合取，单独成一条便于定位）。
//
// ⚠️ 事实（不要误读本探针）：活性源石的**像素长相**（画出来好不好看）**只有人眼能判**。
//    这里能证明的是「两边用的是同一份调色板与同一套配方参数」，**不是**「两张图看起来一样」。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
/** 剥掉 `//` 与 `/* … *​/` 注释 —— **源码断言前必须做**（注释里本来就有这些名字，不剥会假绿）。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
}

const style = await import('../../public/js/render/style.js');

describe('① style.js：ORIGINIUM 调色板与它的 sRGB 换算（纯函数，强断言）', () => {
  test('ORIGINIUM 有 base / crust / vein / spec / glow 五个分量，前四个是 linear 三元组', () => {
    const O = style.ORIGINIUM;
    assert.ok(O, 'style.js 必须导出 ORIGINIUM（活性源石**唯一**的调色板）');
    for (const k of ['base', 'crust', 'vein', 'spec']) {
      assert.ok(Array.isArray(O[k]) || ArrayBuffer.isView(O[k]), `ORIGINIUM.${k} 必须是三元组`);
      assert.equal(O[k].length, 3, `ORIGINIUM.${k} 必须有 3 个分量`);
      for (const v of O[k]) assert.ok(Number.isFinite(v) && v >= 0 && v <= 1, `ORIGINIUM.${k} 的分量必须在 0..1（linear）：${v}`);
    }
    assert.equal(typeof O.glow, 'number', 'ORIGINIUM.glow 是 2D 加色脉冲的 tint');
    assert.ok(Number.isInteger(O.glow) && O.glow >= 0 && O.glow <= 0xffffff);
  });

  test('linearToSrgb255：端点精确、单调不减、钳到 0..255', () => {
    assert.equal(typeof style.linearToSrgb255, 'function', 'style.js 必须导出 linearToSrgb255');
    assert.equal(style.linearToSrgb255(0), 0);
    assert.equal(style.linearToSrgb255(1), 255);
    let prev = -1;
    for (let i = 0; i <= 256; i++) {
      const v = style.linearToSrgb255(i / 256);
      assert.ok(Number.isInteger(v) && v >= 0 && v <= 255, `越界：linearToSrgb255(${i / 256}) = ${v}`);
      assert.ok(v >= prev, `必须单调不减：${i / 256} → ${v} < ${prev}`);
      prev = v;
    }
    assert.equal(style.linearToSrgb255(-1), 0, '负数钳到 0');
    assert.equal(style.linearToSrgb255(2), 255, '>1 钳到 255');
  });

  test('linearToHex：逐通道换算成 #rrggbb（用纯色做非循环的精确断言）', () => {
    assert.equal(typeof style.linearToHex, 'function', 'style.js 必须导出 linearToHex');
    assert.equal(style.linearToHex([1, 0, 0]), '#ff0000');
    assert.equal(style.linearToHex([0, 0, 0]), '#000000');
    assert.equal(style.linearToHex([1, 1, 1]), '#ffffff');
    // 与 linearToSrgb255 **逐通道一致**（同一份换算，不是第二套）
    const c = [0.16, 0.05, 0.05];
    const hex = style.linearToHex(c);
    const want = '#' + c.map((v) => style.linearToSrgb255(v).toString(16).padStart(2, '0')).join('');
    assert.equal(hex, want, 'linearToHex 必须就是 linearToSrgb255 的逐通道拼接');
  });
});

describe('② 3D 侧：infectionMaterial 真正吐出的 GLSL（真调用，THREE 用桩）', () => {
  /** 只要 `new THREE.ShaderMaterial({…})` 能拿到参数即可（本探针不渲染，只读它的 shader 源）。 */
  const stubTHREE = { ShaderMaterial: class { constructor(o) { Object.assign(this, o); } } };

  test('GLSL 里的 base/crust/vein/spec **逐位等于** ORIGINIUM 的那四个分量', async () => {
    const { infectionMaterial } = await import('../../public/js/render/board3d/materials.js');
    assert.equal(typeof infectionMaterial, 'function', 'materials.js 必须导出 infectionMaterial');
    const mat = infectionMaterial(stubTHREE, {}, {});
    const glsl = mat.fragmentShader;
    assert.equal(typeof glsl, 'string');
    const V3 = (c) => `vec3(${c.map((v) => Number(v).toFixed(3)).join(', ')})`;
    const O = style.ORIGINIUM;
    assert.ok(glsl.includes(V3(O.base)), `GLSL 必须用 ORIGINIUM.base（期望 ${V3(O.base)}）`);
    assert.ok(glsl.includes(V3(O.crust)), `GLSL 必须用 ORIGINIUM.crust（期望 ${V3(O.crust)}）`);
    assert.ok(glsl.includes(V3(O.vein)), `GLSL 必须用 ORIGINIUM.vein（期望 ${V3(O.vein)}）`);
    assert.ok(glsl.includes(V3(O.spec)), `GLSL 必须用 ORIGINIUM.spec（期望 ${V3(O.spec)}）`);
  });

  test('GLSL 用的是新配方（第三个八度 + 晶粒），而旧写法（硬编码 + 逐格 edge 淡出）必须不在', async () => {
    const { infectionMaterial } = await import('../../public/js/render/board3d/materials.js');
    const glsl = infectionMaterial(stubTHREE, {}, {}).fragmentShader;
    assert.match(glsl, /n3/, '必须有第三个八度 n3（晶粒用）');
    assert.match(glsl, /grain/, '必须有 grain（晶粒项）');
    assert.ok(!/float\s+edge/.test(glsl), '逐格 edge 淡出必须去掉（否则一片活性源石会读成一块块补丁）');
    assert.ok(!glsl.includes('vec3(0.16, 0.05, 0.05)'), '旧的硬编码 base 必须不在');
    assert.ok(!glsl.includes('vec3(1.0, 0.46, 0.18)'), '旧的硬编码 vein 必须不在');
  });
});

describe('③ 2D 侧：图集把活性源石画成同一个材质（源码断言，已剥注释）', () => {
  const tex = stripComments(read('public/js/render/textures.js'));

  test('ORIGINIUM 与 linearToSrgb255 真的**从 style.js 导入**了（跨模块引用对账）', () => {
    const imp = tex.split('\n').find((l) => /from '\.\/style\.js'/.test(l));
    assert.ok(imp, "textures.js 必须有 from './style.js' 的 import");
    assert.match(imp, /\bORIGINIUM\b/, 'import 里必须有 ORIGINIUM');
    assert.match(imp, /\blinearToSrgb255\b/, 'import 里必须有 linearToSrgb255');
  });

  test('MATERIALS 里有 infection2（第二个变体必须真的进材质表）', () => {
    const m = tex.match(/export const MATERIALS = \[([\s\S]*?)\];/);
    assert.ok(m, '找不到 MATERIALS');
    assert.match(m[1], /'infection'/, "MATERIALS 必须含 'infection'");
    assert.match(m[1], /'infection2'/, "MATERIALS 必须含 'infection2'");
  });

  test('DEFAULT_ART_LAYERS 的 infection / infection2 挂的是官方混凝土 + 过程化 crust', () => {
    const m = tex.match(/const DEFAULT_ART_LAYERS = Object\.freeze\(\{([\s\S]*?)\n\}\);/);
    assert.ok(m, '找不到 DEFAULT_ART_LAYERS');
    assert.match(m[1], /infection:\s*Object\.freeze\(\[[\s\S]*?proc:\s*'originium'\s*\}/, 'infection 必须挂 proc: originium');
    assert.match(m[1], /infection2:\s*Object\.freeze\(\[[\s\S]*?proc:\s*'originium2'\s*\}/, 'infection2 必须挂 proc: originium2');
  });

  test('PROC_LAYERS 真的定义了 originium / originium2（tiles.json 的 proc 名要有实现）', () => {
    const m = tex.match(/const PROC_LAYERS = \{([\s\S]*?)\n\};/);
    assert.ok(m, '找不到 PROC_LAYERS');
    assert.match(m[1], /originium\s*\(ctx, x, y, s\)/, 'PROC_LAYERS.originium 必须存在');
    assert.match(m[1], /originium2\s*\(ctx, x, y, s\)/, 'PROC_LAYERS.originium2 必须存在');
  });

  test('MAT_DRAW 的 infection / infection2 走 originiumOverlay（且第二个是镜像变体）', () => {
    const m = tex.match(/const MAT_DRAW = \{([\s\S]*?)\n\};/);
    assert.ok(m, '找不到 MAT_DRAW');
    assert.match(m[1], /infection\(ctx, x, y, s, r\)\s*\{[\s\S]*?originiumOverlay\(ctx, x, y, s, false\)/, 'MAT_DRAW.infection 必须走 originiumOverlay(false)');
    assert.match(m[1], /infection2\(ctx, x, y, s, r\)\s*\{[\s\S]*?originiumOverlay\(ctx, x, y, s, true\)/, 'MAT_DRAW.infection2 必须是镜像变体 originiumOverlay(true)');
  });

  test('2D 的取色**来自 ORIGINIUM**（不是又一套字面量）', () => {
    assert.match(tex, /ORIGINIUM\.base/, 'crust 的暗面必须取 ORIGINIUM.base');
    assert.match(tex, /ORIGINIUM\.crust/, 'crust 的亮面必须取 ORIGINIUM.crust');
    assert.match(tex, /ORIGINIUM\.vein/, 'vein 必须取 ORIGINIUM.vein');
    assert.match(tex, /ORIGINIUM\.spec/, '晶粒必须取 ORIGINIUM.spec');
    assert.match(tex, /linearToSrgb255\(/, '画到 canvas 前必须做 linear → sRGB 换算（与 3D 的 colorspace_fragment 对应）');
  });
});

describe('④ 变体与脉冲：tiles.js（源码断言，已剥注释）', () => {
  const tiles = stripComments(read('public/js/render/tiles.js'));

  test("variantMat 在 infection / infection2 之间按格选（一片活性源石不重复同一张图）", () => {
    const fn = tiles.match(/function variantMat\(t\)\s*\{([\s\S]*?)\n\}/);
    assert.ok(fn, '找不到 variantMat');
    assert.match(fn[1], /case 'infection':\s*return h < 4 \? 'infection' : 'infection2';/, 'variantMat 必须有 infection → infection/infection2 的分支');
  });

  test("加色脉冲用 ORIGINIUM.glow（不再写死 0xff6a3d）", () => {
    assert.match(tiles, /case 'i':\s*add\('infect',\s*'glow',\s*P\.BLEND_MODES\.ADD,\s*ORIGINIUM\.glow,/, "case 'i' 必须用 ORIGINIUM.glow");
    assert.ok(!/case 'i':[\s\S]{0,80}0xff6a3d/.test(tiles), '旧的写死色 0xff6a3d 必须不在');
  });
});

describe('⑤ 两边同一个源：3D 的 GLSL 与 2D 的取色指向同一个 ORIGINIUM', () => {
  test('把 ORIGINIUM 改一个分量，两侧读到的都应跟着变（本探针只验证"都引用它"）', async () => {
    const { infectionMaterial } = await import('../../public/js/render/board3d/materials.js');
    const stub = { ShaderMaterial: class { constructor(o) { Object.assign(this, o); } } };
    const glsl = infectionMaterial(stub, {}, {}).fragmentShader;
    const tex = stripComments(read('public/js/render/textures.js'));
    // 3D：GLSL 里出现的是**由 ORIGINIUM 格式化出来的字面量**；2D：直接读 ORIGINIUM.*
    for (const k of ['base', 'crust', 'vein', 'spec']) {
      const v3 = `vec3(${style.ORIGINIUM[k].map((v) => Number(v).toFixed(3)).join(', ')})`;
      assert.ok(glsl.includes(v3), `3D 侧没用到 ORIGINIUM.${k}`);
      assert.match(tex, new RegExp(`ORIGINIUM\\.${k}\\b`), `2D 侧没用到 ORIGINIUM.${k}`);
    }
  });
});

describe('⑥ 2D 侧**真跑一次**（桩掉 canvas/PIXI 调 tileAtlas(null)，抓 putImageData 的像素）', () => {
  /** 假的 2D 上下文：记录 `putImageData` 的像素，其余方法一律 no-op。 */
  function fakeCtx(rec) {
    const noop = () => {};
    const t = {
      createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
      getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: (img) => { rec.images.push(img); },
      drawImage: () => { rec.draws += 1; },
      createLinearGradient: () => ({ addColorStop: noop }),
      createRadialGradient: () => ({ addColorStop: noop }),
      measureText: () => ({ width: 1 }),
    };
    return new Proxy(t, {
      get: (o, k) => (k in o ? o[k] : noop),
      set: () => true,
    });
  }

  /** 跑一次真正的图集构建，返回记录到的像素与画布信息。 */
  async function buildAtlas() {
    const rec = { images: [], draws: 0 };
    const hadDoc = globalThis.document; const hadPixi = globalThis.PIXI;
    globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => fakeCtx(rec) }) };
    globalThis.PIXI = {
      BaseTexture: { from: () => ({}) },
      Texture: class { constructor(b) { this.base = b; } destroy() {} },
      MIPMAP_MODES: { ON: 1 }, SCALE_MODES: { LINEAR: 1 },
    };
    try {
      const textures = await import('../../public/js/render/textures.js');
      const atlas = textures.tileAtlas(null);       // 无板图 ⇒ 走 MAT_DRAW（含 infection / infection2）
      return { rec, atlas };
    } finally {
      if (hadDoc === undefined) delete globalThis.document; else globalThis.document = hadDoc;
      if (hadPixi === undefined) delete globalThis.PIXI; else globalThis.PIXI = hadPixi;
    }
  }

  /**
   * 🔴 `tileAtlas()`（`_atlases`）与 `originiumCanvas()`（`_originiumCells`）**都有进程内缓存** ⇒
   *   第二次调用**不会再画一遍**（我第一版就在这上面栽了：第 2/3 组拿到空记录）。
   *   ⇒ 整个文件**只构建一次**，三组共用同一份记录。
   */
  let ONCE = null;
  const atlasOnce = () => (ONCE ??= buildAtlas());

  const isOriginiumSized = (im) => im.width === 256 && im.height === 256;
  const px = (im, x, y) => { const i = (y * im.width + x) * 4; return [im.data[i], im.data[i + 1], im.data[i + 2], im.data[i + 3]]; };

  test('tileAtlas(null) 真的把 infection / infection2 画出来了（不是只"编译过"）', async () => {
    const { rec, atlas } = await atlasOnce();
    assert.ok(atlas && atlas.uv && atlas.uv.infection, 'MATERIALS 里必须有 infection 的 uv');
    assert.ok(atlas.uv.infection2, 'MATERIALS 里必须有 infection2 的 uv');
    const cells = rec.images.filter(isOriginiumSized);
    assert.equal(cells.length, 2, `活性源石的 crust 恰好两张（正常 + 镜像），实际记录到 ${cells.length} 张 256×256`);
    // 调色板不变量：R ≥ G ≥ B（base/crust/vein/spec 四个分量都满足，混合后仍满足；sRGB 换算是单调的）
    let lit = 0;
    for (const im of cells) {
      for (let i = 0; i < im.data.length; i += 4) {
        const [r, g, b] = [im.data[i], im.data[i + 1], im.data[i + 2]];
        assert.ok(r >= g && g >= b, `调色板不变量被破坏：像素 ${i / 4} = (${r},${g},${b})`);
        if (im.data[i + 3] > 0) lit += 1;
      }
    }
    assert.ok(lit > 0, '两张 crust 都必须真的画了东西（alpha 不能全是 0）');
  });

  test('两个变体是**精确的水平镜像**（= infection2 不是同一张图）', async () => {
    const { rec } = await atlasOnce();
    const cells = rec.images.filter(isOriginiumSized);
    const [a, b] = cells;
    assert.ok(a && b, '两张 crust 都在');
    assert.notEqual(a, b, '必须是两张不同的 ImageData');
    let same = 0;
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        const p = px(a, x, y); const q = px(b, 255 - x, y);
        if (p[0] === q[0] && p[1] === q[1] && p[2] === q[2] && p[3] === q[3]) same += 1;
      }
    }
    assert.equal(same, 256 * 256, `infection2 必须是 infection 的精确水平镜像（只有 ${same}/${256 * 256} 个像素相符）`);
  });

  test('crust **画到格子边缘**（没有逐格淡出边框 —— 否则一片活性源石会读成一块块补丁）', async () => {
    const { rec } = await atlasOnce();
    const im = rec.images.filter(isOriginiumSized)[0];
    // 外圈 2 像素的平均 alpha 必须与整图同量级：老写法（`edge = smoothstep(0, 0.1, min(e))`）在这一圈约 0.017×
    let ringSum = 0; let ringN = 0; let allSum = 0;
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        const al = px(im, x, y)[3];
        allSum += al;
        if (x < 2 || y < 2 || x > 253 || y > 253) { ringSum += al; ringN += 1; }
      }
    }
    const ring = ringSum / ringN; const all = allSum / (256 * 256);
    assert.ok(all > 0, '整图必须先有东西');
    assert.ok(ring >= all * 0.5, `外圈平均 alpha ${ring.toFixed(1)} 必须与整图 ${all.toFixed(1)} 同量级（逐格淡出会把它压到近 0）`);
  });
});
