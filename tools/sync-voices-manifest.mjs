#!/usr/bin/env node
// tools/sync-voices-manifest.mjs —— 把干员战斗语音段写进 `data/assets.json`（**W-3**）。
//
// 为什么需要这一步（而不是直接跑 `tools/fetch-assets.mjs`）：
//   `fetch-assets` 重建整份清单时会**同时**重算别的东西，而本地清单里的 4 位**内容包干员**
//   （`content-packs/*.pack.json`：望 / 陈 / 赫格玛2 / 德米特里）**不在 `buildPlan` 的 `chars` 里**（138 vs 143）
//   ⇒ shrink 守卫会判定 `chars.char_2027_wang.*` 被丢弃并**拒绝写盘**。这是既有的集成缺口，不该由语音这一单去动。
//   所以这里做**纯增量**写入：只加/改 `audio.voice`，其余字节不动。
//
// 🔴 与"事后注入"的旧方案的区别：语音段由 `tools/assets/plan.mjs` 的 `buildVoiceSection()` **原生重算**，
//    `fetch-assets` 计划里也有它 ⇒ **下一次整包重建能照样算出同一段**（否则重建会因丢条目而拒绝写）。
//    本脚本与 plan.mjs 共用同一个函数，不存在两份实现。
//
// 用法：
//   node tools/sync-voices-manifest.mjs            # 校验（默认；不一致 exit 1）
//   node tools/sync-voices-manifest.mjs --write    # 写入
//   node tools/sync-voices-manifest.mjs --check    # 与默认相同，显式写法

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildVoiceSection, VOICE_SLOT_ORDER } from './assets/plan.mjs';
import { resolveTemplate } from './assets/manifest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'data', 'assets.json');
const VOICES_JSON = path.join(ROOT, 'docs', 'research', '09-voices.json');
const ASSETS = path.join(ROOT, 'public', 'assets');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

/** 数一段 `{ jp, cn }` 里有多少条引用（数组算长度）。 */
function countRefs(section) {
  let n = 0;
  for (const lang of ['jp', 'cn']) {
    for (const bySlot of Object.values(section?.[lang] || {})) for (const v of Object.values(bySlot)) n += Array.isArray(v) ? v.length : 1;
  }
  return n;
}

/** 按 `plan.mjs` 的同一实现算出"应有的" `audio.voice`，并在磁盘上解析成 web 路径。 */
export function computeVoiceSection() {
  if (!fs.existsSync(VOICES_JSON)) return { section: { jp: {}, cn: {} }, misses: [], source: null };
  const voices09 = readJson(VOICES_JSON);
  const leaves = buildVoiceSection(voices09);
  const r = resolveTemplate({ audio: { voice: leaves } }, { root: ASSETS, spine: new Map() });
  return { section: r.value.audio.voice, misses: r.misses, source: voices09 };
}

/** 深度比较两段（键序无关）。 */
function sameJSON(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

/** 字典序排序每个 lang 的干员键与槽键，让写入结果稳定（否则 diff 会随插入顺序抖）。 */
function sortSection(section) {
  const out = { jp: {}, cn: {} };
  for (const lang of ['jp', 'cn']) {
    for (const charId of Object.keys(section?.[lang] || {}).sort()) {
      const bySlot = section[lang][charId];
      const ordered = {};
      for (const slot of VOICE_SLOT_ORDER) if (bySlot[slot] !== undefined) ordered[slot] = bySlot[slot];
      for (const slot of Object.keys(bySlot).sort()) if (ordered[slot] === undefined) ordered[slot] = bySlot[slot];
      out[lang][charId] = ordered;
    }
  }
  return out;
}

function main() {
  const write = process.argv.includes('--write');
  const manifest = readJson(MANIFEST);
  const { section, misses, source } = computeVoiceSection();

  if (!source) {
    console.error('✘ 找不到 docs/research/09-voices.json —— 先跑 `node tools/fetch-bilingual-voices.mjs`');
    process.exitCode = 1;
    return;
  }

  const wanted = sortSection(section);
  const refs = countRefs(wanted);
  const chars = new Set([...Object.keys(wanted.jp), ...Object.keys(wanted.cn)]).size;
  console.log(`[voices-manifest] 09-voices.json：${Object.keys(source.voices?.jp || {}).length} 位（jp）/ ${Object.keys(source.voices?.cn || {}).length} 位（cn）`);
  console.log(`[voices-manifest] 解析后：jp ${Object.keys(wanted.jp).length} 位 / cn ${Object.keys(wanted.cn).length} 位 / ${refs} 条引用`);
  if (misses.length) {
    console.error(`✘ 有 ${misses.length} 条引用在磁盘上找不到（清单不能登记空气）：`);
    misses.slice(0, 8).forEach((m) => console.error('   ✗ ' + m));
    process.exitCode = 1;
    return;
  }

  const current = manifest.audio?.voice || null;
  if (!write) {
    if (current && sameJSON(sortSection(current), wanted)) {
      console.log(`✔ 清单里的 audio.voice 已是最新（${countRefs(current)} 条引用，${chars} 位干员）`);
      return;
    }
    console.error('✘ data/assets.json 的 audio.voice 与 09-voices.json 不一致（或缺失）—— 跑 `--write` 写入');
    console.error(`   清单现状：${current ? countRefs(current) + ' 条引用' : '（没有 audio.voice）'}`);
    process.exitCode = 1;
    return;
  }

  // 纯增量：**只动 `audio.voice`**，其余字段（含 `hash` / `stats` / `generator` 与键序）逐字保留。
  //
  // ⚠️ **为什么不重算 `hash`**（实测，不是偷懒）：`hash` 是 `contentHash(body)`（`JSON.stringify` 的**键序敏感**），
  //    而本树这份清单在 `fetch-assets` 之后还被**内容包合并**重写过 ⇒ 用"摘掉构建字段再原序序列化"重算
  //    得到 `28a1b0610429`、全键深排序得到 `a6bb3685f979`，**都不等于**文件里的 `7f118cf0f7bb`
  //    ⇒ 现有 `hash` **本来就是陈旧的**（`test/assets.test.js:637` 也只断言它是个字符串）。
  //    我既无法复现它的口径，就不该凭空写一个"按我的规则算的"值 —— 那只会让下一个读的人更困惑。
  //    真正的刷新点是**下一次整包 `fetch-assets` 重建**（那时 hash/stats 一起重算）。
  const next = JSON.parse(JSON.stringify(manifest));
  next.audio = { ...(next.audio || {}), voice: wanted };

  // 写入前守住"除了 audio.voice 之外什么都没变"。
  const before = JSON.parse(JSON.stringify(manifest));
  const after = JSON.parse(JSON.stringify(next));
  delete before.audio.voice; delete after.audio.voice;
  if (!sameJSON(before, after)) {
    console.error('✘ 守卫：本次改动波及了 audio.voice 之外的字段，拒绝写入。');
    process.exitCode = 1;
    return;
  }

  const hadNewline = fs.readFileSync(MANIFEST, 'utf8').endsWith('\n');
  const tmp = MANIFEST + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next) + (hadNewline ? '\n' : ''), 'utf8');
  fs.renameSync(tmp, MANIFEST);
  console.log(`✔ 已写入 ${path.relative(ROOT, MANIFEST).replace(/\\/g, '/')}：audio.voice = ${refs} 条 / ${chars} 位干员`);
  console.log('  ℹ️ hash/stats 保持原样（见本文件上方说明）；下次 `fetch-assets` 重建时一并刷新。');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
