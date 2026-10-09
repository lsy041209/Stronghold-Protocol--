#!/usr/bin/env node
// tools/build-announcements.mjs — 把仓库根的 `CHANGELOG.md` 生成成登录页「更新公告」面板要用的 JS 模块。
//
// 为什么是「生成 JS 模块」而不是「让客户端 fetch 一份 JSON」：
//   判据之一是**离线 / 无网也不报错**（面板照常可开）。JS 模块随客户端一起加载，**不发任何请求**，
//   所以断网、直接开本地文件、CDN 挂了都无所谓；而多一份 `data/*.json` 就多一条 404 路径，还得挤进发布包。
//
// 为什么公告要生成而不是手写：**单一事实源**。发版就改 `CHANGELOG.md`，然后重跑本工具。
//   幂等：同一份 CHANGELOG 跑两次，输出逐字节一致（不含时间戳）。
//
// 用法：node tools/build-announcements.mjs            # 写文件
//       node tools/build-announcements.mjs --check    # 只校验「生成物与 CHANGELOG 一致」，不写（判据用）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'CHANGELOG.md');
const OUT = path.join(ROOT, 'public', 'js', 'ui', 'announcementData.js');

/** 面板里放几个版本（再多会把浮层拖得很长；更老的去 CHANGELOG 看）。 */
const MAX_VERSIONS = 3;

/** 去掉 changelog 里的 markdown 装饰，只留纯文本（面板按纯文本渲染，不解析 markdown ⇒ 没有注入面）。 */
export function plain(s) {
  return String(s)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)') // [t](u) → t (u)
    .replace(/\*\*([^*]+)\*\*/g, '$1')              // **粗**
    .replace(/`([^`]+)`/g, '$1')                    // `代码`
    .replace(/~~([^~]+)~~/g, '$1')                  // ~~删除~~
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 解析 CHANGELOG.md → [{ version, date, summary, sections: [{ name, items: string[] }] }]
 * @param {string} text
 */
export function parseChangelog(text) {
  const lines = String(text).split(/\r?\n/);
  const out = [];
  let ver = null;
  let sec = null;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const h2 = /^##\s+(.+?)\s*(?:[—–-]\s*(.+))?$/.exec(line);
    if (/^##\s/.test(line)) {
      if (h2) {
        ver = { version: plain(h2[1]), date: h2[2] ? plain(h2[2]) : '', summary: '', sections: [] };
        out.push(ver);
        sec = null;
      } else {
        ver = null; sec = null;
      }
      continue;
    }
    if (!ver) continue;
    const h3 = /^###\s+(.+)$/.exec(line);
    if (h3) { sec = { name: plain(h3[1]), items: [] }; ver.sections.push(sec); continue; }
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    if (bullet) {
      const txt = plain(bullet[1]);
      if (!txt) continue;
      if (!sec) { sec = { name: '', items: [] }; ver.sections.push(sec); }
      sec.items.push(txt);
      continue;
    }
    // 缩进的续行：并进上一颗子弹（changelog 里长条目都是这么折的）。
    if (/^\s{2,}\S/.test(line) && sec && sec.items.length) {
      sec.items[sec.items.length - 1] = plain(`${sec.items[sec.items.length - 1]} ${line}`);
      continue;
    }
    // `## v` 之下、第一个 `###` 之前的段落 = 该版本的一句话说明。
    if (line.trim() && !sec) ver.summary = plain(ver.summary ? `${ver.summary} ${line}` : line);
  }
  return out.filter((v) => v.sections.length);
}

/** 生成模块源码（幂等：不含任何时间戳）。 */
export function renderModule(versions) {
  const body = JSON.stringify(versions, null, 2);
  return `// ⚠️ 本文件由 \`tools/build-announcements.mjs\` 从仓库根的 \`CHANGELOG.md\` **生成** —— 不要手改。
//    改公告 = 改 CHANGELOG.md → 重跑该工具。判据：\`node tools/build-announcements.mjs --check\`。
//    登录页「更新公告」面板读它（public/js/ui/titlePanels.js）。

/** 事实源（面板上不显示，供开发者与判据用）。 */
export const ANNOUNCEMENT_SOURCE = 'CHANGELOG.md';

/** 面板里展示的版本，从新到旧（最多 ${MAX_VERSIONS} 个）。 */
export const ANNOUNCEMENTS = ${body};
`;
}

function main() {
  const check = process.argv.includes('--check');
  if (!fs.existsSync(SRC)) {
    console.log(`✘ 找不到 ${path.relative(ROOT, SRC)}`);
    process.exit(1);
  }
  const versions = parseChangelog(fs.readFileSync(SRC, 'utf8')).slice(0, MAX_VERSIONS);
  const next = renderModule(versions);
  const prev = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;

  if (versions.length === 0) {
    console.log('✘ CHANGELOG.md 里没解析出任何版本段（格式变了吗？应形如 `## 0.1.3.3 — 2026-10-06`）');
    process.exit(1);
  }

  const items = versions.reduce((n, v) => n + v.sections.reduce((m, s) => m + s.items.length, 0), 0);
  if (check) {
    if (prev === next) {
      console.log(`✔ 更新公告生成物与 CHANGELOG.md 一致（${versions.length} 个版本 / ${items} 条）。`);
      process.exit(0);
    }
    console.log(`✘ 更新公告生成物**过期** —— 重跑：node tools/build-announcements.mjs`);
    process.exit(1);
  }
  if (prev === next) {
    console.log(`✔ 无需改动（${versions.length} 个版本 / ${items} 条）。`);
    process.exit(0);
  }
  fs.writeFileSync(OUT, next, 'utf8');
  console.log(`✔ 已写入 ${path.relative(ROOT, OUT)} —— ${versions.map((v) => 'v' + v.version).join(' / ')}（共 ${items} 条）`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
