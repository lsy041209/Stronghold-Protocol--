// 盟约几率显示必须夹到 100%（A 线 T3-E；GitHub #108 / 用户 2026-10-07 的 ① 「取其精华」清点表 §1-9）。
//
// 为什么需要这条判据：
//   `formatBondEffect` 把「层数缩放值」按 `base + perStack × L` 直接算出来，**不夹**。
//   而**几率**类参数（迅捷 `base_prob`/`prob_per_stack`、不屈同、奇迹 `baseprob`/`prob`）在 sim 里
//   是**夹到 1** 的：`bonds/addon/battle.js:92 procChance = min(1, base_prob + prob_per_stack·L)`、
//   `bonds/addon/meta.js:129 奇迹 = min(1, baseprob + prob·layers)`。
//   ⇒ 显示层不夹 ⇒ 卡片会写出「**124%** 概率」这种不存在的值（266 层的不屈，实测 1.2440）。
//
// ⚠️ 判据必须**有牙**：
//   ① 只夹「几率」那一类 —— 盟约里还有大片**不是几率**的层数缩放（如维多利亚 `base_damage_scale` 在 10 层 = 1.33），
//      它们是**倍率**，**绝不能**一起夹到 100%（那样会显示成 100% 的伤害倍率 = 把内容改错）。
//   ② 用**真实 `data/bonds.json`** 的三条（迅捷 / 不屈 / 奇迹）而不是造一条假记录 —— 免得"判据只证明自己会绿"。
//   ③ 未超 100% 时**必须原样显示**（不许"反正夹一下更安全"地把 58% 变成别的数）。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatBondEffect, richTextPlain } from '../../public/js/ui/richText.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const bonds = JSON.parse(readFileSync(path.join(ROOT, 'data', 'bonds.json'), 'utf8'));

/** 把 `formatBondEffect` 渲染出的文本里第一个 `NN%` 的数字取出来。 */
function percentOf(bond, layers) {
  const plain = richTextPlain(formatBondEffect(bond, layers));
  const m = /(-?\d+(?:\.\d+)?)%/.exec(plain);
  assert.ok(m, `${bond.bondId} L=${layers} 没渲染出百分比：${plain}`);
  return Number(m[1]);
}

describe('盟约几率显示夹到 100%（T3-E）', () => {
  test('三条"层数缩放的几率"在高层的渲染值都 ≤ 100%', () => {
    const cases = [
      // [bondId, 层数, 未夹时的原始值]
      ['indomShip', 266, 1.2440],   // C 的现场读数：显示 124%（1.2440）
      ['swiftShip', 266, 1.1310],   // 迅捷：1.1310 ⇒ 113%
      ['miraShip', 300, 1.0800],    // 奇迹：266 层还是 97.8% ⇒ 得取更高的层数才越界（证明不是对 266 特判）
    ];
    for (const [id, L, raw] of cases) {
      const b = bonds[id];
      assert.ok(b, `data/bonds.json 里没有 ${id} —— 判据的前提数据变了，先核对`);
      // ① 先确认"未夹时确实越界"（否则这条用例对实现没有约束力）
      const realRaw = b.effectDescParams.filter((p) => /prob/i.test(`${p.base}|${p.perStack}`))
        .map((p) => (Number(b.bb[p.base]) || 0) + (Number(b.bb[p.perStack]) || 0) * L)[0];
      assert.ok(Math.abs(realRaw - raw) < 0.02, `${id} L=${L} 原始值 ${realRaw} 与判据里写的 ${raw} 不符 —— 数据变了就更新判据`);
      assert.ok(realRaw > 1, `${id} L=${L} 原始值 ${realRaw} 未越界 ⇒ 这条用例失去意义`);
      // ② 显示值必须 ≤ 100%
      const shown = percentOf(b, L);
      assert.ok(shown <= 100, `${id} L=${L} 显示 ${shown}%（原始 ${(realRaw * 100).toFixed(1)}% ⇒ 必须夹到 100%）`);
      assert.equal(shown, 100, `${id} L=${L} 越界时应当正好是 100%（不是别的夹法）`);
    }
  });

  test('未越界的层数原样显示（不许"顺手夹一下"）', () => {
    assert.equal(percentOf(bonds.indomShip, 100), 58);    // 0.18 + 0.004×100 = 0.58
    assert.equal(percentOf(bonds.indomShip, 0), 18);
    assert.equal(percentOf(bonds.swiftShip, 25), 29);     // 0.2875 ⇒ 四舍五入 29%
    assert.equal(percentOf(bonds.miraShip, 266), 98);     // 0.9780 ⇒ 98%
  });

  test('非几率的层数缩放【不许】被夹（负对照：把钳子开大在这里必须红）', () => {
    // 这三条都是"层数缩放的**非几率**参数，且 10 层时的值已经 > 1" —— 一律夹到 1 就会把它们改错。
    // （判据取的是**真实文本**：改完实现后这里必须**逐字**还是原样。）
    const v = bonds.victoriaShip;     // {0:0%} base_damage_scale=1.25 + 0.008/层 ⇒ 10 层 = 1.33 ⇒ 伤害倍率 133%
    assert.ok(v, 'data/bonds.json 里没有 victoriaShip');
    assert.ok((Number(v.bb.base_damage_scale) || 0) + (Number(v.bb.damage_scale_per_stack) || 0) * 10 > 1, '维多利亚 10 层未越界 ⇒ 负对照失去意义');
    assert.ok(richTextPlain(formatBondEffect(v, 10)).includes('伤害提升至133%'), '倍率类参数被夹了 ⇒ 钳子开太大（把内容改错了）');

    const k = bonds.kjeragShip;       // {0:0%} base_ex_damage_scale=1.35 + 0.01/层 ⇒ 10 层 = 1.45 ⇒ 145%
    assert.ok(richTextPlain(formatBondEffect(k, 10)).includes('额外提升至145%'), '谢拉格的额外伤害倍率被夹了');

    const s = bonds.siracusaShip;     // {0:0} 攻速 33 ／ {2:0} 真实伤害 5500 —— 数字类，夹到 1 会显示 "1"
    const sOut = richTextPlain(formatBondEffect(s, 10));
    assert.ok(sOut.includes('攻击速度+33'), `叙拉古攻速被夹了：${sOut.split('\n')[0]}`);
    assert.ok(sOut.includes('造成5500'), '叙拉古的真实伤害 5500 被夹了 ⇒ 钳子开太大');
  });
});
