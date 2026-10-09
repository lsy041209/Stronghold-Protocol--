// 皮肤清单守卫（我们的，不是上游的）—— 打在**产物**上，不是打在"树"上。
//
// 为什么必须有这一条（本工作区 2026-10-06 判明）：
//   `data/assets.json` 是 `tools/fetch-assets.mjs` 的**生成产物**，而皮肤数据有**两条**进它的路：
//     · 原生的：`tools/fetch-assets.mjs` 读 `docs/research/08-skins.json` → `tools/assets/plan.mjs` 的
//       `buildPlan({ skins08 })` 产出 `chars[].skins`（头像走 `leaf(alt(...))` ⇒ `.png`/`.webp` 两种形态都命中）；
//     · 后处理的：`tools/inject-skins-assets.mjs`（**皮肤骨骼**目前只从这条路进，见下）。
//
//   于是 —— `node tools/fetch-assets.mjs`（或任意 `npm run assets` / `tools/setup.mjs`）重建清单时：
//     · 头像 → 原生那条约在，**不会丢**；
//     · **骨骼 → 会丢**（`plan.mjs` 的 skins 条目目前只产出 `{ name, group, avatar }`，不含 `spine`）。
//   而丢了**不会报错**：`assets.js` 的 `spineEntry` 在 `validSpine(skin.spine)` 失败时回退到干员原皮模型
//   —— 表现是"换了皮肤但棋盘上的小人没变"，没有任何一条错误。这正是本工作区记过的头号坑形态：
//   **生成流程会把东西悄悄冲掉，而当时所有"看树"的判据都是绿的。**
//
// 所以判据落点必须是**产物**：跑一遍生成流程之后，这几个断言必须仍然成立。
// 红了怎么修（两条都对，按当时的意图选）：
//     node tools/inject-skins-assets.mjs     ← 立刻恢复骨骼（皮肤的 spine 字段回来）
//     （根治：把 spine 接进 plan.mjs 的 skins 条目，走 models 注册表让 build 期 spine 管线算 anims —— 待做）
//
// 反向验证（**必须真的红过**，2026-10-06 实测）：
//     把 data/assets.json 里任一 chars[<id>].skins 删掉再跑本文件 ⇒ 立刻红；重新 inject ⇒ 转绿。
//     另：断言 3（骨骼数）在「只跑过 npm run assets、没跑 inject」时会红 —— 那是**有意的**，
//     它就是在提醒"骨骼还没进产物"，不是误报。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJSON = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

const catalogue = readJSON('data/skins.json');            // 目录：有哪些皮肤（tools/build-skins.mjs 生成）
const installed = readJSON('data/skins-installed.json');  // 内置清单：这一版实际装了哪些
const manifest = readJSON('data/assets.json');            // 素材清单：客户端真正读的那份（fetch-assets 的产物）

/** `{ [skinId]: charId }`，从目录里倒排出来 —— 清单是按 operator id 分组的。 */
const charOfSkin = new Map();
for (const [charId, list] of Object.entries(catalogue.chars || {})) {
  for (const s of list || []) charOfSkin.set(s.id, charId);
}

test('皮肤清单：内置清单里的每一套都真的在 data/assets.json 里（生成流程冲掉就会红）', () => {
  const ids = Array.isArray(installed) ? installed : [];
  assert.ok(ids.length > 0, 'data/skins-installed.json 不应为空');

  const missing = [];
  for (const skinId of ids) {
    const charId = charOfSkin.get(skinId);
    if (!charId) { missing.push(`${skinId}（目录里没有这个 skinId）`); continue; }
    const rec = manifest.chars?.[charId]?.skins?.[skinId];
    if (!rec) missing.push(`${skinId}（${charId} 在 assets.json 里的 skins 下没有它）`);
  }
  assert.deepEqual(
    missing,
    [],
    `以下皮肤在 data/assets.json 里不存在 —— 多半是刚跑过 fetch-assets / setup，清单被重建后皮肤没跟上。\n`
    // ⚠️ 2026-10-07（B，C《总表-第7任》B-3）：这里原来推荐的"修复命令"是 `node tools/inject-skins-assets.mjs`，
    //    而那个脚本写死 `.png` 且用 `existsSync` 探盘 ⇒ **树已整体转 WebP 之后跑它**，探测必然落空、
    //    于是它会把 174 条头像**回退成研究表里的远程 GitHub URL**（离线/大陆网络下等于坏），比不修更糟。
    //    ⇒ 正确做法：让 `fetch-assets` 重建清单（它走 `plan.mjs` 的 `leaf(alt(...))` + `actualRel` 后缀解析，两种落盘形态都能命中）。
    + `  修复：node tools/fetch-assets.mjs（走 plan.mjs 的后缀解析；⛔ 别再用 inject-skins-assets.mjs —— 转 WebP 后它会写出远程 URL）\n`
    + `  缺失：${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` …共 ${missing.length}` : ''}`,
  );
});

test('皮肤清单：每条引用（头像 + 骨骼 + 贴图）在磁盘上真的存在', () => {
  const dangling = [];
  let skins = 0;
  let spines = 0;
  for (const [, list] of Object.entries(catalogue.chars || {})) {
    for (const s of list || []) {
      const charId = charOfSkin.get(s.id);
      const rec = manifest.chars?.[charId]?.skins?.[s.id];
      if (!rec) continue; // 上一条件已经报过
      skins++;

      // 头像：清单里写的路径必须落盘（历史上本项目就因为「改了资源后缀却没改引用」全站图标 404 过）
      if (rec.avatar && !existsSync(join(ROOT, 'public', rec.avatar))) dangling.push(`${s.id} avatar ${rec.avatar}`);

      // 骨骼：pixi-spine 需要 skel + atlas 两个文件，缺一个就整只单位退化成占位图
      if (rec.spine) {
        spines++;
        for (const side of ['front', 'back']) {
          const sp = rec.spine[side];
          if (!sp) continue;
          if (sp.skel && !existsSync(join(ROOT, 'public', sp.skel))) dangling.push(`${s.id} spine.${side}.skel ${sp.skel}`);
          if (sp.atlas && !existsSync(join(ROOT, 'public', sp.atlas))) dangling.push(`${s.id} spine.${side}.atlas ${sp.atlas}`);
          for (const tex of sp.textures || []) {
            if (!existsSync(join(ROOT, 'public', tex))) dangling.push(`${s.id} spine.${side} tex ${tex}`);
          }
        }
      }
    }
  }
  assert.ok(skins > 0, '一份皮肤都没读到 —— 先确认 data/assets.json 里有 chars[].skins');
  assert.deepEqual(dangling, [], `清单引用了磁盘上不存在的文件：${dangling.slice(0, 5).join(', ')}${dangling.length > 5 ? ` …共 ${dangling.length}` : ''}`);
  // 应有骨骼的套数由研究表数据驱动：08-skins.json 里带 battleSpine 的条目才必须有独立骨骼。
  // ⚠️ 不能写死「spines == skins」：2026-10-07 W-2 给外援收编的精2（#2）条目是**官方支持的 avatar-only 形态**
  // （plan.mjs skins08 块对无 battleSpine 的条目本就只产 avatar，渲染层回退本体模型），那 4 套没有骨骼是设计而非缺损。
  // 保护意图不变：fetch-assets 重建把骨骼冲掉时 spines 掉下去 ⇒ 照样红。
  const research = readJSON('docs/research/08-skins.json');
  let expectSpines = 0;
  for (const list of Object.values(research.skins || {})) {
    for (const s of list || []) if (s.battleSpine?.front) expectSpines++;
  }
  assert.equal(spines, expectSpines, `研究表有 ${expectSpines} 套皮肤带 battleSpine 但产物里只有 ${spines} 套带独立骨骼（tools/fetch-assets.mjs 重建把骨骼冲掉了？）`);
});

test('皮肤清单：目录覆盖的干员，assets.json 都认识（否则 inject 会静默跳过）', () => {
  const unknown = [];
  for (const charId of Object.keys(catalogue.chars || {})) {
    if (!manifest.chars?.[charId]) unknown.push(charId);
  }
  assert.deepEqual(unknown, [], `这些干员有皮肤但不在 assets.json 的 chars 里，tools/inject-skins-assets.mjs 会跳过它们：${unknown.slice(0, 8).join(', ')}`);
});
