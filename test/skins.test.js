// 皮肤系统专项自动化测试 (docs/SKINS.md & SKINS-BUILTIN-PLAN.md)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isSkinId, isSkinSelection } from '../shared/protocol.js';
import { mergeSkins, sanitizeSkins, exportPayload, parseImport } from '../public/js/ui/loadoutModel.js';
import { avatarUrl, spineEntry, hasBackSpine } from '../public/js/assets.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const skinsData = JSON.parse(readFileSync(join(ROOT, 'data/skins.json'), 'utf8'));
const assetsData = JSON.parse(readFileSync(join(ROOT, 'data/assets.json'), 'utf8'));

test('全量 268 套皮肤内置元数据覆盖与映射正确（W-1 追平纸鸢 0.2.1 后）', () => {
  const chars = skinsData.chars || {};
  const charKeys = Object.keys(chars);
  // 174 = 119（上游 115 + 4 位外援，2026-10-07 W-2 用户裁定接入）＋ **55 位**（2026-10-08 W-a 追平纸鸢 0.2.1）
  // ⚠️ **这两个数是从源表 `docs/research/08-skins.json` 派生的，不是手写常量**：
  //   上一版写死 119/179，W-a 加了89 条皮肤（涉及 55 位新干员）后直接红 ——
  //   **判据滞后于实现**（本工作区头号坑）。⇒ 派生 + 一个下限断言，两边都要。
  const SRC = JSON.parse(readFileSync(join(ROOT, 'docs/research/08-skins.json'), 'utf8'));
  const srcChars = Object.keys(SRC.skins || {}).length;
  const srcSkins = Object.values(SRC.skins || {}).reduce((a, l) => a + l.length, 0);
  assert.equal(charKeys.length, srcChars, `拥有皮肤的干员数应等于源表（源表 ${srcChars} 名）`);
  assert.ok(charKeys.length >= 174, `干员数不应回退（当前 ${charKeys.length}，下限 174）`);

  let totalSkins = 0;
  for (const [charId, list] of Object.entries(chars)) {
    assert.ok(Array.isArray(list) && list.length > 0, `${charId} 拥有皮肤列表`);
    for (const s of list) {
      totalSkins++;
      assert.ok(isSkinId(s.id), `皮肤 id ${s.id} 满足命名协议规范`);
      assert.ok(typeof s.name === 'string' && s.name.length > 0, `皮肤 ${s.id} 具有名称`);
      // ⚠️ W-a 增项的承重断言：**每套皮肤的 avatar 引用都必须真在盘上**。
      //   🔴 查的是**哪个文件**这件事我第一版搞错了：`data/skins.json`（内置目录）**本来就不含 avatar**
      //   （只有 id/name/group）；真正的 avatar 挂在 **`data/assets.json` 的
      //   `chars[charId].skins[skinId].avatar`**（由 `plan.mjs` 的皮肤块产出，客户端 `avatarUrl(m, id, {skin})` 读它）。
      //   ⇒ 断言必须查 assets.json；查 skins.json 会把"字段不存在"当成缺陷（我第一版就这么红了一轮）。
      //   🔴 两个方向都要抓（写成 `if (s.avatar)` ⇒ 变异删掉后**照样绿**，形同装饰）：
      //     ① 缺 avatar 字段；② 有引用但盘上没有（10-05「全站图标退化成文字」的失败模式）。
      const withSkins = assetsData.chars?.[charId];
      const skinRec = withSkins?.skins?.[s.id];
      assert.ok(skinRec, `皮肤 ${s.id} 在 data/assets.json 的 chars.${charId}.skins 里（plan.mjs 的皮肤块没产出它）`);
      assert.ok(skinRec.avatar, `皮肤 ${s.id} 必须有 avatar 引用（缺了＝客户端回退原皮，点了没换装图）`);
      const rel = String(skinRec.avatar).replace(/^\/assets\//, '');
      assert.ok(existsSync(join(ROOT, 'public/assets', rel)), `皮肤 ${s.id} 的 avatar 在盘：${skinRec.avatar}`);
    }
  }
  assert.equal(totalSkins, srcSkins, `总皮肤数应等于源表（源表 ${srcSkins} 款）`);
  assert.equal(totalSkins, 268, `总皮肤数应为 268（179 + W-a 实取到的 89）`);
  assert.equal(srcSkins, totalSkins, '产物与源表条数一致（build-skins 没漏）');

  // 验证普查出的 6 名无皮肤干员
  const noSkinChars = [
    'char_512_aprot', // 盟约·辅助干员
    'char_1037_sora2', // 雪猎
    'char_4139_cathy', // 凯瑟琳
    'char_1039_titi',  // 缇缇
    'char_1041_silar2', // 凛御银灰
    'char_1042_astgn2', // 溯光星源
  ];
  for (const id of noSkinChars) {
    assert.equal(chars[id], undefined, `未实装皮肤干员 ${id} 不应存在于 skins.json`);
  }
});

test('导入语义增量覆盖 (mergeSkins) 行为正确', () => {
  const current = {
    chess_silverash: 'skin_silverash_1',
    chess_thorns: 'skin_thorns_1',
    chess_eyja: 'skin_eyja_1',
  };

  // 导入仅包含棘刺新皮与塞雷娅皮肤，银灰未提及
  const imported = {
    chess_thorns: 'skin_thorns_summer',
    chess_saria: 'skin_saria_prison',
  };

  const result = mergeSkins(current, imported);

  // 1. 银灰未提及，保留原选择
  assert.equal(result.chess_silverash, 'skin_silverash_1');
  // 2. 棘刺已提及，增量打补丁
  assert.equal(result.chess_thorns, 'skin_thorns_summer');
  // 3. 塞雷娅新增
  assert.equal(result.chess_saria, 'skin_saria_prison');
  // 4. 艾雅法拉未提及，保留原选择
  assert.equal(result.chess_eyja, 'skin_eyja_1');
});

test('导出与导入链路支持 skins 字段且安全隔离', () => {
  const loadout = { chess_char_1_01_a: { skill: 1 } };
  const skins = { chess_char_1_01_a: 'char_002_amiye@epoque#4' };

  const payload = exportPayload(loadout, { skins });
  assert.ok(payload.skins);
  assert.equal(payload.skins.chess_char_1_01_a, 'char_002_amiye@epoque#4');

  const parsed = parseImport(JSON.stringify(payload));
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.entries, loadout);
  assert.deepEqual(parsed.skins, skins);
});

test('Spine 与 Avatar 资源回退：皮肤缺损优雅 fallback 至原皮', () => {
  const manifest = {
    chars: {
      char_demo: {
        avatar: 'art/demo.png',
        spine: { front: { skel: '/art/demo.skel', atlas: '/art/demo.atlas', anims: {} } },
        skins: {
          skin_has_art: {
            avatar: 'art/skin_demo.png',
            spine: { front: { skel: '/art/skin.skel', atlas: '/art/skin.atlas', anims: {} } },
          },
          skin_no_spine: {
            avatar: 'art/skin_no_spine.png',
          },
          // 皮肤条目存在、但 `avatar` 缺失/为空 —— 必须回退到干员原皮头像。
          // 这条以前没测：上面三个皮肤都带 avatar，第 4 种情况 `skin` 又直接不存在，
          // 于是 `avatarUrl` 里 `str(skin.avatar)` 这个守卫**从未被触发过**（变异测试证实：
          // 把 `if (skin && str(skin.avatar))` 改成 `if (skin)` 时，旧版测试仍全绿）。
          skin_no_avatar: {
            name: '无头像皮肤',
          },
          skin_blank_avatar: {
            avatar: '',
          },
          skin_broken_spine: {
            avatar: 'art/skin_broken.png',
            spine: { front: { skel: 'https://remote.url/broken.skel' } },
          },
        },
      },
    },
  };

  // 1. 有独立皮肤模型与头像
  assert.equal(avatarUrl(manifest, 'char_demo', { skin: 'skin_has_art' }), 'art/skin_demo.png');
  assert.equal(spineEntry(manifest, 'char_demo', { skin: 'skin_has_art' })?.skel, '/art/skin.skel');

  // 2. 皮肤无独立 spine，回退至原皮 spine
  assert.equal(avatarUrl(manifest, 'char_demo', { skin: 'skin_no_spine' }), 'art/skin_no_spine.png');
  assert.equal(spineEntry(manifest, 'char_demo', { skin: 'skin_no_spine' })?.skel, '/art/demo.skel');

  // 3. 皮肤 spine 格式非法或损坏，优雅 fallback 回退至原皮 spine
  assert.equal(avatarUrl(manifest, 'char_demo', { skin: 'skin_broken_spine' }), 'art/skin_broken.png');
  assert.equal(spineEntry(manifest, 'char_demo', { skin: 'skin_broken_spine' })?.skel, '/art/demo.skel');

  // 4. 皮肤 id 完全不存在，回退至原皮头像与 spine
  assert.equal(avatarUrl(manifest, 'char_demo', { skin: 'skin_not_exist' }), 'art/demo.png');
  assert.equal(spineEntry(manifest, 'char_demo', { skin: 'skin_not_exist' })?.skel, '/art/demo.skel');

  // 5. 皮肤存在但 avatar 缺失 / 为空 ⇒ 也必须回退到原皮头像，绝不能返回 undefined
  //    （`undefined` 会让 `<img src=undefined>` 变成请求当前页面，比不换装更糟）
  assert.equal(avatarUrl(manifest, 'char_demo', { skin: 'skin_no_avatar' }), 'art/demo.png');
  assert.equal(avatarUrl(manifest, 'char_demo', { skin: 'skin_blank_avatar' }), 'art/demo.png');
  assert.equal(spineEntry(manifest, 'char_demo', { skin: 'skin_no_avatar' })?.skel, '/art/demo.skel');
});

test('协议层 isSkinId 与 isSkinSelection 防御校验', () => {
  assert.equal(isSkinId('char_002_amiye@epoque#4'), true);
  assert.equal(isSkinId('char_102_texas@summer#1'), true);
  assert.equal(isSkinId('invalid space id'), false);
  assert.equal(isSkinId(''), false);
  assert.equal(isSkinId(null), false);

  assert.equal(isSkinSelection({ chess_amiye: 'char_002_amiye@epoque#4' }), true);
  assert.equal(isSkinSelection({ 'invalid space chess': 'char_002_amiye@epoque#4' }), false);
  assert.equal(isSkinSelection({ chess_amiye: 'invalid space skin' }), false);
  assert.equal(isSkinSelection([]), false);
  assert.equal(isSkinSelection('not obj'), false);
});
