// test/content/summon-wiring.test.js —— 🆕 S1 家族补洞：**每一条"召唤接线"都必须在真表里存在**。
//   为什么写它：第 54 轮 A 摸 S3② 的形状时发现 —— `data/chess.json[rec].skills[].overrideTokenKey`
//   是"技能召唤哪只召唤物"的唯一接线，但**当时没有任何判据逐条跑它**：
//   接线写错（写成别的 token、或写成已退役的 token）**不会有任何东西变红**。
//   这与我刚被升格的那条规则同源：**正例用真表逐条跑**（只测"伪造的被拒"照不出"真表被自己拒掉"）。
//
// ⚠️ 本判据**只读数据**（不建战斗）：它钉的是"数据层的接线完整性"，与战斗行为判据互补。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ⚠️ 本文件在 `test/content/` 下 ⇒ 要**退两层**才是树根（`test/content` → `test` → 根）。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const J = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const chess = J('data/chess.json');
const tokens = J('data/tokens.json');
const backups = J('data/backups.json');
const bTokens = backups.tokens ?? {};

/** 召唤物可能落在两张表里：上游 `data/tokens.json` 与自选编队的 `data/backups.json.tokens`。 */
const knownToken = (id) => Object.hasOwn(tokens, id) || Object.hasOwn(bTokens, id);

test('① 前置：两张召唤物表都读得到（真表就是它们）', () => {
  assert.ok(Object.keys(tokens).length > 0, `data/tokens.json 非空（实收 ${Object.keys(tokens).length}）`);
  assert.ok(Object.keys(bTokens).length > 0, `data/backups.json.tokens 非空（实收 ${Object.keys(bTokens).length}）`);
});

test('② 🔴 **逐条跑**：`chess.json` 里每一个 `skills[].overrideTokenKey` 都必须指向真表里存在的召唤物', () => {
  const wires = [];
  for (const [chessId, r] of Object.entries(chess)) {
    if (!r || !Array.isArray(r.skills)) continue;
    for (const s of r.skills) {
      if (s && typeof s.overrideTokenKey === 'string' && s.overrideTokenKey) {
        wires.push({ chessId, skillId: s.skillId, index: s.index, token: s.overrideTokenKey });
      }
    }
  }
  assert.ok(wires.length >= 10, `前置：召唤接线至少十来条（实收 ${wires.length}）`);
  const broken = wires.filter((w) => !knownToken(w.token));
  assert.deepEqual(broken, [],
    `🔴 这些召唤接线指向**不存在的召唤物**（共核 ${wires.length} 条，坏 ${broken.length} 条）：\n`
    + broken.map((w) => `  ${w.chessId} ${w.skillId}(档${w.index}) → ${w.token}`).join('\n'));
});

test('③ 逐条跑：`talents[].tokenKey`（天赋召唤／跟子）同样必须存在', () => {
  const wires = [];
  for (const [chessId, r] of Object.entries(chess)) {
    if (!r || !Array.isArray(r.talents)) continue;
    for (const t of r.talents) {
      if (t && typeof t.tokenKey === 'string' && t.tokenKey) wires.push({ chessId, token: t.tokenKey, name: t.name });
    }
  }
  const broken = wires.filter((w) => !knownToken(w.token));
  assert.deepEqual(broken, [],
    `🔴 天赋召唤接线指向不存在的召唤物（共核 ${wires.length} 条，坏 ${broken.length} 条）：\n`
    + broken.map((w) => `  ${w.chessId} ${w.name} → ${w.token}`).join('\n'));
});

test('④ 反向：`data/tokens.json` 里的每个召唤物都**至少被一条接线用到**（孤儿表项是可查的）', () => {
  const used = new Set();
  for (const r of Object.values(chess)) {
    if (!r) continue;
    for (const s of (r.skills ?? [])) if (s && s.overrideTokenKey) used.add(s.overrideTokenKey);
    for (const t of (r.talents ?? [])) if (t && t.tokenKey) used.add(t.tokenKey);
    for (const t of (r.tokens ?? [])) if (t) used.add(t);
  }
  const orphans = Object.keys(tokens).filter((id) => !used.has(id));
  // ⚠️ 孤儿**不算失败**（上游表可能含未接线的素材）——这里只把它**报出来**，避免"以为全都在用"。
  assert.ok(orphans.length < Object.keys(tokens).length,
    `data/tokens.json 里**全部** ${Object.keys(tokens).length} 条都没被接线用到 ⇒ 说明我查错了表（这是个自检）`);
  console.log(`[summon-wiring] data/tokens.json ${Object.keys(tokens).length} 条，其中未被任何接线用到的 ${orphans.length} 条`
    + (orphans.length ? `：${orphans.slice(0, 8).join(', ')}${orphans.length > 8 ? ' …' : ''}` : ''));
});
