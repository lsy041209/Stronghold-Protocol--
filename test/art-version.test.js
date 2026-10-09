// test/art-version.test.js — the art/data tag (`/healthz.artVersion`).
//
// WHY IT EXISTS: `build` covers `public/**` only (BUILD_INPUTS) and never reads anything under `data/`, so a
// **data-pack swap** used to be invisible on the wire: every model/icon/spine could change while `/healthz.build`
// stayed identical. This tag is the on-the-wire proof that the swap landed — and it must stay **byte-comparable
// with the deploy tool**, whose §④ compares the very same document as "what SHOULD be live"
// (阿里云开服/22-asset-freshness.mjs:148: sha256 of the document's utf8 text → first 12 hex).
//
// ⚠️ Paths are relative to the **runtime data dir** (`startServer({ dataDir })`), not the game root — C's spec
// (协作/C给D-健康检查数据版本字段-2026-10-06-064x.md §2). The last test below is the one that pins that wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { computeArtTag, artTag, resetArtTag, ART_INPUTS, BUILD_INPUTS, startServer } from '../server/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sp-art-'));
/** Write a stand-in data dir: just the manifest (relative to the DATA DIR, not the game root). */
const writeManifest = (dataDir, text) => fs.writeFileSync(path.join(dataDir, 'assets.json'), text);
/** The deploy tool's own formula, recomputed here on purpose: if either side drifts, this test goes red. */
const toolDigest = (text) => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
/**
 * 手工递归拷贝（**不要换成 `fs.cpSync`**）。
 * 本机实测（Node 24 / Windows）：`fs.cpSync(src, dst, { recursive: true })` 会**原生崩溃**
 * `exit -1073740791`（= 0xC0000409，STATUS_STACK_BUFFER_OVERRUN）—— 崩在 cpSync 内部，
 * 与 artVersion 一点关系没有，但会把"测试失败"伪装成"这个字段不对"。
 */
function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyTree(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}
const REAL = '{"a":{"path":"x.webp"},"token_10064_wang_stone1":{"avatar":"y.webp"}}';

test('computeArtTag: 12 hex, and equal to the deploy tool digest of the same document', () => {
  const dir = tmp();
  writeManifest(dir, REAL);
  const tag = computeArtTag(dir);
  assert.match(tag, /^[0-9a-f]{12}$/);
  assert.equal(tag, toolDigest(REAL), 'must stay comparable with 20-verify-deploy.mjs §④');
});

test('computeArtTag: a different manifest (i.e. a data-pack swap) is a different tag', () => {
  const a = tmp();
  const b = tmp();
  writeManifest(a, REAL);
  writeManifest(b, '{"a":{"path":"x.webp"}}');
  assert.notEqual(computeArtTag(a), computeArtTag(b));
});

test('computeArtTag: no manifest → null (an unknown version must never claim to be current)', () => {
  assert.equal(computeArtTag(tmp()), null);
  assert.equal(computeArtTag(undefined), null, 'a missing dir argument is null, not a throw');
});

test('the whole point: data/ is invisible to `build`, so it needs its own tag', () => {
  assert.deepEqual([...ART_INPUTS], ['assets.json'], 'relative to the DATA DIR');
  assert.ok(!BUILD_INPUTS.some((p) => p.startsWith('data')), 'BUILD_INPUTS must not cover data/**');
});

test('artTag: computed once per process — a swap on disk does not move it until the next process', () => {
  const dir = tmp();
  writeManifest(dir, REAL);
  resetArtTag();
  const first = artTag(dir);
  writeManifest(dir, '{"a":{"path":"x.webp"}}');
  assert.equal(artTag(dir), first, 'a stale tag is exactly the failure this field must reveal');
  resetArtTag();
  assert.notEqual(artTag(dir), first);
});

test('artTag: unreadable manifest → null, never a crash', () => {
  resetArtTag();
  assert.equal(artTag(tmp()), null);
});

test('startServer: artVersion comes from the RUNTIME dataDir, not from a hardcoded ROOT/data', async () => {
  // A stand-in data dir: the real data/*.json (startServer loads them) with a deliberately different manifest.
  const dataDir = tmp();
  // ⚠️ `data/` 里**不只有 .json**：0.2.x 起还有子目录 `data/i18n/` ⇒ 必须**递归**拷。
  //    原先写死 `copyFileSync`，换基座后遇到 `data/i18n`（目录）直接抛
  //    `EPERM: operation not permitted, copyfile`，**测试在跑到真正的断言之前就崩了**
  //    （现象像"artVersion 不对"，其实**根本没验到**）—— 2026-10-07 换到 0.2.1 后由第 4 任 D 修。
  //    另注：这里**不能用 `fs.cpSync(…, {recursive:true})`** —— 本机实测它在 Node 24 / Windows 上
  //    **原生崩溃**（`exit -1073740791` = 0xC0000409），崩在 cpSync 自己内部，与 artVersion 无关。
  copyTree(path.join(ROOT, 'data'), dataDir);
  const text = `${fs.readFileSync(path.join(dataDir, 'assets.json'), 'utf8')}\n`;
  writeManifest(dataDir, text);
  const expected = toolDigest(text);

  const srv = await startServer({ port: 0, host: '127.0.0.1', dataDir, quiet: true });
  try {
    const body = await (await fetch(`http://127.0.0.1:${srv.port}/healthz`)).json();
    assert.equal(body.artVersion, expected, 'must be the digest of the data dir this process was given');
    assert.notEqual(body.artVersion, computeArtTag(path.join(ROOT, 'data')), 'and NOT the default data/ digest');
    assert.equal(typeof body.build === 'string' || body.build === null, true, 'the existing build field is untouched');
    assert.equal(body.app, JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);
  } finally { await srv.close(); }
});
