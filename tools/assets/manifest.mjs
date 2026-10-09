// Manifest assembly: walks the plan template (tools/assets/plan.mjs), collects
// the single-file download alternatives, and resolves the template against the
// files that actually exist on disk into data/assets.json. Entries whose files
// are missing are dropped (never emitted as broken URLs); a `literal(value)` node
// is emitted as it is (no files behind it).

import { existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { assetUrl, githubSourceUrl, mirrorUrl } from './sources.mjs';

/** Manifest schema version (bump on breaking shape changes). */
export const MANIFEST_VERSION = 1;

const isLeaf = (n) => !!n && typeof n === 'object' && Array.isArray(n.alts);
const isModelRef = (n) => !!n && typeof n === 'object' && typeof n.model === 'string' && Object.keys(n).length === 1;
const LITERAL = Symbol('literal');
const isLiteral = (n) => !!n && typeof n === 'object' && Object.hasOwn(n, LITERAL);

/**
 * A template node emitted as it is (a JSON copy; null fields kept): data that is no file to download or resolve, e.g.
 * the metadata of a local-client Spine model (plan.mjs enemies[id].spineLocal).
 * @param {any} value JSON value
 */
export function literal(value) { return { [LITERAL]: JSON.parse(JSON.stringify(value)) }; }

/**
 * Collect every leaf of the template with its dotted path.
 * @param {any} node
 * @param {string} [path]
 * @param {{path:string, leaf:any}[]} [out]
 * @returns {{path:string, leaf:any}[]}
 */
export function collectLeaves(node, path = '', out = []) {
  if (isLeaf(node)) { out.push({ path, leaf: node }); return out; }
  if (isModelRef(node) || isLiteral(node) || !node || typeof node !== 'object') return out;
  for (const [k, v] of Object.entries(node)) collectLeaves(v, path ? `${path}.${k}` : k, out);
  return out;
}

/**
 * Download leaves round by round: round r tries each unsatisfied leaf's r-th alternative.
 * A leaf only moves on to its next alternative after a definitive miss (404 on every source);
 * a transient failure (network error, 5xx, invalid payload after all retries) stops that leaf, so
 * a fallback file (e.g. the base enemy's icon) never lands on the primary's path by accident and
 * the next run retries the primary.
 * @param {{path:string, leaf:any}[]} leaves
 * @param {import('./downloader.mjs').Downloader} dl
 * @param {string} root public/assets
 * @param {string} [label]
 * @returns {Promise<string[]>} dotted paths of leaves that stopped on a transient error
 */
export async function downloadLeaves(leaves, dl, root, label = 'files') {
  const tried = new Map(leaves.map((l) => [l, 0]));
  const blocked = new Set();
  // `actualRel`（不是裸 rel）：已转成 webp 的树里，计划写 .png 而盘上是 .webp ⇒ 已落盘的叶子
  // 必须算"已满足"，否则每次跑配方都要把整棵素材重下一遍。
  const satisfied = (l) => l.leaf.alts.slice(0, tried.get(l)).some((a) => actualRel(root, a.rel) !== null);
  let last = new Map();
  for (let round = 0; round < 8; round++) {
    const jobs = [];
    for (const l of leaves) {
      const t = tried.get(l);
      if (blocked.has(l)) continue;
      if (t > 0 && satisfied(l)) continue;
      if (t > 0 && last.get(l.leaf.alts[t - 1].rel)?.status === 'error') { blocked.add(l); continue; }
      if (t >= l.leaf.alts.length) continue;
      jobs.push(l.leaf.alts[t]);
      tried.set(l, t + 1);
    }
    if (!jobs.length) break;
    last = await dl.run(jobs, round === 0 ? label : `${label} fallback#${round}`);
  }
  return [...blocked].map((l) => l.path);
}

/**
 * Resolve the template against the disk.
 * @param {any} template
 * @param {object} o
 * @param {string} o.root public/assets
 * @param {Map<string, any>} o.spine resolved Spine entries by model key
 * @param {(rel:string)=>string|undefined} [o.sourceOf] URL a file was downloaded from (ledger), to report
 *   fallbacks that share the primary's path (e.g. an enemy icon taken from its base id)
 * @returns {{ value: any, misses: string[], fallbacks: string[], files: Set<string> }}
 */
/**
 * W-1-REAPPLY-2026-10-07：一个 leaf 备选在盘上**真正**存在的路径 —— 要么就是 `rel` 本身，要么是它转换后的 `.webp` 兄弟。
 *
 * 计划里存的是**上游的 `.png` 名**（`plan.mjs` 写 `rel: 'ui/<key>.png'`），而本工作区的 `public/assets`
 * 已整体由 `.workbuddy/tools/convert-assets.py` 转成 WebP（小 ~70%、像素一致）。转换器会改写已提交的清单，
 * 但**故意不动 `plan.mjs`** —— 因为计划描述的是**镜像站提供什么**（` .png`）。
 *
 * 所以解析器必须两种形态都认、并报出盘上真在的那个。修复前实测：计划的 127 个静态 UI 叶子，
 * 以 `.png` 存在的 **0** 个、以 `.webp` 存在的 **127** 个 ⇒ `resolveTemplate` 一个都没解析出来、报 127 miss
 * ⇒ 一旦放行写盘，清单会丢掉这些条目，全站图标退化（与 2026-10-05 图标全灭同一失败模式）。
 *
 * @param {string} root public/assets
 * @param {string} rel 计划里的相对路径（上游命名）
 * @returns {string|null} 真在盘上的那个 rel，或 null
 */
function actualRel(root, rel) {
  if (existsSync(join(root, rel))) return rel;
  const webp = String(rel).replace(/\.png$/i, '.webp');
  if (webp !== rel && existsSync(join(root, webp))) return webp;
  return null;
}

export function resolveTemplate(template, { root, spine, sourceOf = () => undefined }) {
  const misses = [];
  const fallbacks = [];
  const files = new Set();
  const walk = (node, path) => {
    if (node === null || node === undefined) return undefined;
    if (isLiteral(node)) return JSON.parse(JSON.stringify(node[LITERAL]));
    if (isLeaf(node)) {
      for (let i = 0; i < node.alts.length; i++) {
        const a = node.alts[i];
        const actual = actualRel(root, a.rel);
        if (actual) {
          const src = sourceOf(a.rel);
          // Provenance only: disabling/changing a proxy does not change the
          // identity of a previously downloaded asset.
          const primary = node.alts[0].urls.flatMap((u) => [u, mirrorUrl(u)]);
          if (i > 0) fallbacks.push(`${path} ← ${src || a.urls[0]}`);
          else if (src && !primary.includes(githubSourceUrl(src))) fallbacks.push(`${path} ← ${src}`);
          files.add(actual);
          return assetUrl(actual);
        }
      }
      misses.push(path);
      return undefined;
    }
    if (isModelRef(node)) {
      const e = spine.get(node.model);
      if (!e) { misses.push(`${path} (spine ${node.model})`); return undefined; }
      for (const u of [e.skel, e.atlas, ...e.textures]) files.add(u.replace(/^\/assets\//, ''));
      return e;
    }
    if (Array.isArray(node)) {
      const lines = node.map((x, i) => walk(x, `${path}[${i}]`)).filter((x) => x !== undefined);
      // An array whose every line is missing on disk is a missing entry, like a missing leaf (e.g. a voice slot whose
      // lines were never downloaded here): dropped, never an empty [] that reads as a slot with no lines.
      return lines.length || !node.length ? lines : undefined;
    }
    if (typeof node !== 'object') return node;
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      const r = walk(v, path ? `${path}.${k}` : k);
      if (r === undefined) continue;
      if (r && typeof r === 'object' && !Array.isArray(r) && !Object.keys(r).length && isContainer(v)) continue;
      out[k] = r;
    }
    return out;
  };
  const isContainer = (v) => v && typeof v === 'object' && !isLeaf(v) && !isModelRef(v) && !isLiteral(v);
  const value = walk(template, '');
  return { value, misses, fallbacks, files };
}

/**
 * Total size in bytes of files under root.
 * @param {string} root
 * @param {Iterable<string>} rels
 * @returns {number}
 */
export function totalBytes(root, rels) {
  let n = 0;
  // `actualRel`：转换过的树要报**真实**体积，而不是因为计划写 .png、盘上是 .webp 而全部算成 0。
  for (const r of rels) {
    const actual = actualRel(root, r);
    if (!actual) continue;
    try { n += statSync(join(root, actual)).size; } catch { /* missing */ }
  }
  return n;
}

/**
 * Deterministic short content hash of a JSON value (for cache busting).
 * @param {any} value
 * @returns {string}
 */
export function contentHash(value) {
  return createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 12);
}

/** Top-level manifest fields that describe the build, not assets: never counted as dropped entries. */
const BUILD_FIELDS = new Set(['version', 'hash', 'generator', 'stats']);

/**
 * Entries of the manifest `prev` that `next` no longer has, as sorted dotted paths. An entry is a leaf value (a URL
 * string, a number, a flag, null or an array — an array is one entry); an object entry missing from `next` contributes
 * all its leaves. A path that changed shape (a leaf became an object or the reverse) is still there, not dropped.
 * The build fields (version, hash, generator, stats) are left out.
 * @param {object} prev the current data/assets.json
 * @param {object} next the manifest about to replace it
 * @returns {string[]}
 */
export function droppedEntries(prev, next) {
  const out = [];
  const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const leaves = (v, path) => {
    if (!isObj(v)) { out.push(path); return; }
    for (const [k, x] of Object.entries(v)) leaves(x, `${path}.${k}`);
  };
  const walk = (p, n, path) => {
    if (n === undefined) { leaves(p, path); return; }
    if (!isObj(p) || !isObj(n)) return;
    for (const [k, v] of Object.entries(p)) walk(v, Object.hasOwn(n, k) ? n[k] : undefined, `${path}.${k}`);
  };
  if (!isObj(prev)) return out;
  const nx = isObj(next) ? next : {};
  for (const [k, v] of Object.entries(prev)) {
    if (!BUILD_FIELDS.has(k)) walk(v, Object.hasOwn(nx, k) ? nx[k] : undefined, k);
  }
  return out.sort();
}
