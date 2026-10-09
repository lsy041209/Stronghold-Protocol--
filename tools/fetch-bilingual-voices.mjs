#!/usr/bin/env node
// tools/fetch-bilingual-voices.mjs —— 干员战斗语音（中/日双语）抓取（**W-3**）。
//
// 蓝本：`归档/上游分叉-0.1.6-pre-skin/source/tools/fetch-bilingual-voices.mjs`（照它移植，改了四处，理由见下）。
//
// 从官方 `charword_table.json` 解析出**我们这 143 位干员**的 12 个战斗语音槽，往
// `public/assets/audio/voice/{jp,cn}/<charDir>/<name>.mp3` 抓，并写 `.cache/bilingual_voice_structure.json`
// 供 `tools/sync-voices-manifest.mjs` 注入 `data/assets.json` 的 `audio.voice`。
//
// 与蓝本的四处差异（都是**实测换来的**，不是偏好）：
//   ① **加镜像回退**。`raw.githubusercontent.com` 本机实测**不稳**（8 路 33.7 KB/s、3/8 失败，
//      见 `.workbuddy/tools/probe-voice-mirrors.mjs`）：jsDelivr **不支持 `voice` 分支**（三个站点全 404），
//      而 `ghfast.top` / `ghproxy.net` / `gh-proxy.com` 可用 ⇒ 按序回退，raw 放最后当兜底。
//   ② **写盘前先量文件头**。蓝本只看 `size > 500` 就算成功；**镜像会拿"限流页/HTML"当 200 回**，
//      所以这里额外校验头 3 字节是 `ID3` 或 `0xFF 0xFB/0xF3`（MPEG 帧），否则删掉重试。
//   ③ **实测自报**：结束时打印**真实**的文件数/字节数/耗时（不写外推值 —— 本项目栽过"用样本冒充实测"）。
//   ④ **`--plan` 只算不下载**，用来在动手前核规模与判据。
//
// 用法：
//   node tools/fetch-bilingual-voices.mjs --plan
//   node tools/fetch-bilingual-voices.mjs                       # 双语全量
//   node tools/fetch-bilingual-voices.mjs --lang=jp --only=char_002_amiya
//   node tools/fetch-bilingual-voices.mjs --concurrency=24

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_EXCEL = path.join(ROOT, '.cache', 'gamedata', 'excel', 'charword_table.json');
const ASSETS_PATH = path.join(ROOT, 'data', 'assets.json');
const VOICE_ROOT = path.join(ROOT, 'public', 'assets', 'audio', 'voice');
/**
 * 落盘的结构文件（**committed**，照 `docs/research/08-skins.json` 的模式）。
 * 🔴 **必须是仓库里的一份**，不能只放 `.cache/`：`tools/assets/plan.mjs` 要读它才能**原生**产出 `audio.voice`，
 * 否则下一次 `fetch-assets` 重建清单时 `audio.voice` 整段消失 ⇒ 触发 shrink 守卫**拒绝写**（或更糟：写出丢条目的清单）。
 */
const STRUCTURE_OUT = path.join(ROOT, 'docs', 'research', '09-voices.json');

/** 官方 `charword_table.json` 的 `placeType` → 我们在清单里用的槽名（与上游分叉一致）。 */
export const VOICE_SLOTS = Object.freeze({
  BATTLE_START: 'start',
  BATTLE_FACE_ENEMY: 'faceEnemy',
  BATTLE_SELECT: 'select',
  BATTLE_PLACE: 'place',
  BATTLE_SKILL_1: 'skill1',
  BATTLE_SKILL_2: 'skill2',
  BATTLE_SKILL_3: 'skill3',
  BATTLE_SKILL_4: 'skill4',
  FOUR_STAR: 'resultFour',
  THREE_STAR: 'resultThree',
  TWO_STAR: 'resultTwo',
  LOSE: 'resultLose',
});

/** 上游仓里中/日两个目录名。**日语在 `voice/`**（默认音轨），中文在 `voice_cn/`。 */
export const LANG_DIRS = Object.freeze({ jp: 'voice', cn: 'voice_cn' });

/** 12 槽的**固定顺序**（写进 `09-voices.json` 的 meta，读侧照它判定槽名集合）。 */
export const VOICE_SLOTS_LIST = Object.freeze(['start', 'faceEnemy', 'select', 'place', 'skill1', 'skill2', 'skill3', 'skill4', 'resultFour', 'resultThree', 'resultTwo', 'resultLose']);

/** 数一份 `{ jp, cn }` 结构里有多少条引用（数组算长度）。 */
export function countRefs(structure) {
  let n = 0;
  for (const lang of Object.keys(structure || {})) {
    for (const byChar of Object.values(structure[lang] || {})) {
      for (const v of Object.values(byChar)) n += Array.isArray(v) ? v.length : 1;
    }
  }
  return n;
}

/** 镜像（按实测速度排序，raw 兜底）。`<base>/<langDir>/<charDir>/<name>.mp3`。 */
export const MIRRORS = Object.freeze([
  'https://ghfast.top/https://raw.githubusercontent.com/ArknightsAssets/ArknightsAssets2/voice/assets/dyn/audio/sound_beta_2/',
  'https://ghproxy.net/https://raw.githubusercontent.com/ArknightsAssets/ArknightsAssets2/voice/assets/dyn/audio/sound_beta_2/',
  'https://gh-proxy.com/https://raw.githubusercontent.com/ArknightsAssets/ArknightsAssets2/voice/assets/dyn/audio/sound_beta_2/',
  'https://raw.githubusercontent.com/ArknightsAssets/ArknightsAssets2/voice/assets/dyn/audio/sound_beta_2/',
]);

/**
 * 计划：从 charword 表算出「我们干员的 12 个槽 ⇒ 双语文件清单」。
 *
 * 过滤条件**逐条照抄上游**（每一句都删掉过一批文件，别随手改）：
 *   · `placeType` 命中 12 槽之一 · `charId` 在我们的 `data/assets.json` 里
 *   · `voiceId` 以 `CN_` 开头（**中文编号**：两种语言的同名文件在各自目录里同名，靠目录区分）
 *   · `wordKey === charId`（排掉 `charExtraWords` / 阵营台词那些变体）
 *   · `voiceAsset` 恰两段 ⇒ `<charDir>/<CN_xxx>`
 * 落盘名用 **小写**（`CN_001` → `cn_001.mp3`）。
 *
 * @param {{ charword?: any, chars?: Record<string, any> }} [src] 允许测试注入
 * @returns {{ structure: {jp: Record<string, Record<string, string|string[]>>, cn: Record<string, Record<string, string|string[]>>},
 *   queue: { lang: 'jp'|'cn', rel: string, url: string, dest: string }[], stats: { chars: number, files: number, perSlot: Record<string, number>, noVoice: string[] } }}
 */
export function buildVoicePlan(src = {}) {
  const charword = src.charword ?? JSON.parse(fs.readFileSync(CACHE_EXCEL, 'utf8'));
  const chars = src.chars ?? (JSON.parse(fs.readFileSync(ASSETS_PATH, 'utf8')).chars || {});
  const known = new Set(Object.keys(chars));

  const words = charword.charWords || {};
  const structure = { jp: {}, cn: {} };
  const perSlot = {};
  const spoken = new Set();
  const rels = new Set();
  const queue = [];

  for (const e of Object.values(words)) {
    if (!e || typeof e !== 'object') continue;
    const slot = VOICE_SLOTS[e.placeType];
    if (!slot) continue;
    if (!e.charId || !known.has(e.charId)) continue;
    if (!e.voiceId || !String(e.voiceId).startsWith('CN_')) continue;
    if (e.wordKey !== e.charId) continue;
    if (!e.voiceAsset) continue;
    const parts = String(e.voiceAsset).split('/');
    if (parts.length !== 2) continue;

    const rel = `${parts[0]}/${parts[1].toLowerCase()}.mp3`;
    rels.add(rel);
    spoken.add(e.charId);
    perSlot[slot] = (perSlot[slot] || 0) + 1;

    for (const lang of ['jp', 'cn']) {
      const byChar = (structure[lang][e.charId] ||= {});
      const web = `/assets/audio/voice/${lang}/${rel}`;
      const list = (byChar[slot] ||= []);
      if (!list.includes(web)) list.push(web);
    }
  }

  // 一个槽只有一条时写成字符串（与上游分叉的清单写法一致：省体积、读侧两种都认）
  for (const lang of ['jp', 'cn']) {
    for (const byChar of Object.values(structure[lang])) {
      for (const [slot, list] of Object.entries(byChar)) if (list.length === 1) byChar[slot] = list[0];
    }
  }

  const all = [...rels];
  for (const lang of ['jp', 'cn']) {
    for (const rel of all) {
      queue.push({ lang, rel, url: `${MIRRORS[0]}${LANG_DIRS[lang]}/${rel}`, dest: path.join(VOICE_ROOT, lang, ...rel.split('/')) });
    }
  }

  return {
    structure,
    queue,
    stats: { chars: spoken.size, files: all.length, perSlot, noVoice: [...known].filter((c) => !spoken.has(c)) },
  };
}

/** 是不是一段真音频：`ID3` 头，或 MPEG 帧同步（`0xFF 0xEx/0xFx`）。镜像会拿限流页当 200 回，所以必须查。 */
export function looksLikeMp3(buf) {
  if (!buf || buf.byteLength < 3) return false;
  const b = new Uint8Array(buf, 0, 3);
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return true;   // 'ID3'
  return b[0] === 0xff && (b[1] & 0xe0) === 0xe0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 把计划里的结构裁到「磁盘上真有的文件」。`--only` / `--lang` 的局部抓取必须走这一步，
 * 否则清单会登记一堆空气（2026-10-05 图标全灭的失效模式）。
 * @param {{jp: any, cn: any}} structure
 * @returns {{ structure: {jp: any, cn: any}, dropped: number }}
 */
export function pruneStructureToDisk(structure, root = VOICE_ROOT) {
  const out = { jp: {}, cn: {} };
  let dropped = 0;
  const onDisk = (lang, web) => {
    if (typeof web !== 'string') return false;
    const prefix = `/assets/audio/voice/${lang}/`;
    if (!web.startsWith(prefix)) return false;
    return fs.existsSync(path.join(root, lang, ...web.slice(prefix.length).split('/')));
  };
  for (const lang of ['jp', 'cn']) {
    for (const [charId, byChar] of Object.entries(structure[lang] || {})) {
      const keep = {};
      for (const [slot, v] of Object.entries(byChar)) {
        const list = (Array.isArray(v) ? v : [v]).filter((web) => onDisk(lang, web));
        dropped += (Array.isArray(v) ? v.length : 1) - list.length;
        if (list.length === 1) keep[slot] = list[0];
        else if (list.length > 1) keep[slot] = list;
      }
      if (Object.keys(keep).length) out[lang][charId] = keep;
    }
  }
  return { structure: out, dropped };
}

/** 取一个文件（按 MIRRORS 顺序回退）。返回字节数；404 返回 0（上游确实缺这条，不算失败）。 */
async function fetchOne(rel, lang, { timeoutMs = 30000, retries = 3 } = {}) {
  const dir = LANG_DIRS[lang];
  let lastErr = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    const base = MIRRORS[Math.min(attempt, MIRRORS.length - 1)];
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(`${base}${dir}/${rel}`, { signal: ctl.signal });
      clearTimeout(timer);
      if (res.status === 404) { await res.arrayBuffer().catch(() => {}); return 0; }
      if (!res.ok) { await res.arrayBuffer().catch(() => {}); lastErr = new Error(`HTTP ${res.status}`); await sleep(400); continue; }
      const buf = await res.arrayBuffer();
      if (!looksLikeMp3(buf)) { lastErr = new Error(`不是音频（${buf.byteLength} B，${base.replace(/^https:\/\/([^/]+).*/, '$1')}）`); await sleep(400); continue; }
      return buf;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      await sleep(400);
    }
  }
  throw lastErr || new Error('unknown');
}

async function main() {
  const argv = process.argv.slice(2);
  const has = (k) => argv.some((a) => a === `--${k}` || a.startsWith(`--${k}=`));
  const val = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };

  const { structure, queue, stats } = buildVoicePlan();
  const langs = val('lang', 'both') === 'both' ? ['jp', 'cn'] : [val('lang')];
  const only = val('only', null);
  const concurrency = Number(val('concurrency', '16')) || 16;

  console.log('[voices] 计划：%d 位干员 · %d 文件/语言 · 双语 %d 条', stats.chars, stats.files, stats.files * 2);
  console.log('[voices] 槽位分布：%s', JSON.stringify(stats.perSlot));
  console.log('[voices] 这 %d 位在我们的 chars 里但官方表没有战斗语音：%s', stats.noVoice.length, stats.noVoice.slice(0, 8).join(', ') + (stats.noVoice.length > 8 ? ' …' : ''));

  if (has('plan')) {
    console.log('[voices] --plan：只算不下载。');
    return;
  }

  let work = queue.filter((it) => langs.includes(it.lang));
  if (only) work = work.filter((it) => it.rel.startsWith(`${only}/`));
  console.log('[voices] 本次任务 %d 条（语言 %s%s），并发 %d', work.length, langs.join('/'), only ? `，仅 ${only}` : '', concurrency);

  fs.mkdirSync(VOICE_ROOT, { recursive: true });
  let ok = 0, bytes = 0, missing = 0, failed = 0, skipped = 0, done = 0;
  const failures = [];

  const chunks = Array.from({ length: concurrency }, () => []);
  work.forEach((it, i) => chunks[i % concurrency].push(it));

  const t0 = Date.now();
  await Promise.all(chunks.map(async (c) => {
    for (const it of c) {
      try {
        if (fs.existsSync(it.dest) && fs.statSync(it.dest).size > 500) { skipped++; bytes += fs.statSync(it.dest).size; }
        else {
          const buf = await fetchOne(it.rel, it.lang);
          if (!buf) { missing++; }
          else {
            fs.mkdirSync(path.dirname(it.dest), { recursive: true });
            fs.writeFileSync(it.dest, Buffer.from(buf));
            ok++; bytes += buf.byteLength;
          }
        }
      } catch (err) { failed++; failures.push(`${it.lang}/${it.rel} ${err.message}`); }
      done++;
      if (done % 25 === 0 || done === work.length) {
        process.stdout.write(`  ${done}/${work.length}  新下 ${ok} 跳过 ${skipped} 上游缺 ${missing} 失败 ${failed}  ${(bytes / 1048576).toFixed(2)} MB\r`);
      }
    }
  }));
  const sec = (Date.now() - t0) / 1000;

  console.log('\n[voices] 实测：新下 ' + ok + ' · 已存在跳过 ' + skipped + ' · 上游缺(404) ' + missing + ' · 失败 ' + failed);
  const mb = (bytes / 1048576).toFixed(2);
  const kbs = sec > 0 ? (bytes / 1024 / sec).toFixed(0) : '-';
  console.log(`[voices] 实测：${ok + skipped} 条 / ${mb} MB / ${sec.toFixed(1)} s（${kbs} KB/s）`);
  if (failures.length) {
    console.log('[voices] 失败清单（前 10，可重跑本脚本补齐）：');
    failures.slice(0, 10).forEach((f) => console.log('  ✗ ' + f));
  }

  // 🔴 **结构只写"磁盘上真有的"**：`--only` / `--lang` 时若把整份计划写下，清单就会引用**不存在的文件**
  //    ⇒ 皮肤头像那次（2026-10-05 图标全灭）就是这个失效模式。宁可少登记，也不能登记空气。
  const pruned = pruneStructureToDisk(structure);
  const droppedSlots = pruned.dropped;
  if (droppedSlots) console.log('[voices] 结构按磁盘裁剪：丢掉 ' + droppedSlots + ' 条本机没有的引用（跑全量后它们会回来）');
  const out = {
    meta: {
      generator: 'tools/fetch-bilingual-voices.mjs',
      source: MIRRORS[0],
      note: '干员战斗语音（W-3）。key = charId，值 = { <槽>: web路径 | web路径[] }；路径一律 /assets/audio/voice/<lang>/…',
      slots: [...VOICE_SLOTS_LIST],
      chars: new Set([...Object.keys(pruned.structure.jp), ...Object.keys(pruned.structure.cn)]).size,
      refs: countRefs(pruned.structure),
    },
    voices: pruned.structure,
  };
  fs.mkdirSync(path.dirname(STRUCTURE_OUT), { recursive: true });
  fs.writeFileSync(STRUCTURE_OUT, JSON.stringify(out, null, 2) + '\n', 'utf8');
  const rel = path.relative(ROOT, STRUCTURE_OUT).replace(/\\/g, '/');
  console.log(`[voices] 结构已写 ${rel}（jp ${Object.keys(pruned.structure.jp).length} + cn ${Object.keys(pruned.structure.cn).length} 位干员 / ${out.meta.refs} 条引用）`);
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
