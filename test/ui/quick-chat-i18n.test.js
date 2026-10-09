// test/ui/quick-chat-i18n.test.js — **C 派工 B-C3 的判据**（2026-10-08 第 12 任 B）：
// 快捷聊天（固定句式）那 **9 条**在**四语包**里一条都不许缺，且**占位符必须一致**。
//
// 为什么要它（`AGENTS §十.2`：判据先写、且要能红）：
//   · 句式文本**只活在接收端的语言包里**（服务端只认 token，见 `协作/C-派工-局内聊天固定句式与房间开关`：§2.1「服务端只认 token」
//     ＋ §3「文案放 public/i18n/*（四语已齐）」）⇒ **漏一条 = 那位语言的玩家看到一句中文原文或半句话**，而且**不报错**；
//   · 占位符漏掉更糟：`{chess}` 一丢，日语玩家看到的「を送ってください」就**不知道要送什么**（静默的半句话）。
// ⚠️ 本判据**只读语言包**（不碰 UI），所以它不依赖聊天面板是否已落地 —— 面板落地后由 `test/ui/chat-panel.test.js` 那条继续守"面板渲染出 9 条"。
//
// Run: node --test test/ui/quick-chat-i18n.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LANGS = ['en', 'ja', 'ko', 'zh-TW'];
const PACKS = Object.fromEntries(LANGS.map((l) => [l, JSON.parse(readFileSync(path.join(ROOT, `public/i18n/${l}.json`), 'utf8'))]));

/**
 * 9 条句式的**中文原文**（＝ msgid；本仓惯例：`t('我玩 {bond}')` 那一边的字符串）。
 * 顺序与 C §3「用户定稿」的表一致；token 名（playing/need/thanks/sorry/wait/help/careful/niceOne/myBad）
 * 与它们的对应关系写在面板那一侧（`public/js/ui/chatPanel.js`），**本文件只守文案**。
 */
const MSGIDS = [
  '我玩 {bond}',      // playing  —— 参数：盟约 id
  '请给我 {chess}',   // need     —— 参数：干员 id（想让队友用信标发过来）
  '感谢 {mate}',      // thanks   —— 参数：队友名（服务端取 session.name）
  '对不起！',          // sorry
  '稍等一下',          // wait
  '救命！',            // help
  '小心 {enemy}',     // careful  —— 参数：敌方 id（服务端校验存在性）
  '漂亮！',            // niceOne
  '我的错',            // myBad
];

/** 一条文案里的占位符名（排序后比较 ⇒ 顺序不影响判定）。 */
const paramsOf = (s) => [...String(s).matchAll(/\{([a-zA-Z_]+)\}/g)].map((m) => m[1]).sort();

/**
 * 一套可复用的检查：返回"有问题"的清单（空 = 全好）。
 * 分开成函数是为了下面的**负对照**能在内存里造坏数据证明它真的有牙（不是恒真）。
 */
function problemsOf(packs, ids) {
  const out = [];
  for (const lang of Object.keys(packs)) {
    for (const id of ids) {
      const v = packs[lang][id];
      if (typeof v !== 'string' || !v.trim()) { out.push(`${lang}: 缺/空 ⇒ ${id}`); continue; }
      if (paramsOf(v).join(',') !== paramsOf(id).join(',')) out.push(`${lang}: 占位符不一致 ⇒ ${id}（译文用 [${paramsOf(v)}]，msgid 要 [${paramsOf(id)}]）`);
    }
  }
  return out;
}

test('9 条句式在四语包里都存在（缺一条即红）', () => {
  const missing = problemsOf(PACKS, MSGIDS);
  assert.deepEqual(missing, [], `快捷聊天的四语文案不齐：\n  ${missing.join('\n  ')}`);
  // 反向哨兵：确认我真的在读那 4 个包（读错文件 ⇒ 这个断言会先红）
  assert.deepEqual(Object.keys(PACKS), LANGS);
  assert.ok(Object.keys(PACKS.en).length > 1000, `en 包只有 ${Object.keys(PACKS.en).length} 条 ⇒ 读错文件了`);
});

test('每条译文的占位符与中文 msgid 一致（丢一个占位符 = 静默的半句话）', () => {
  for (const id of MSGIDS) {
    const want = paramsOf(id);
    if (!want.length) continue;
    for (const lang of LANGS) {
      assert.deepEqual(paramsOf(PACKS[lang][id]), want, `${lang}: 「${id}」的占位符与中文原文不一致`);
    }
  }
});

test('负对照：缺一条 / 空译文 / 丢了占位符 —— 这套检查必须判红（证明它不是恒真）', () => {
  const en = PACKS.en;
  const id0 = MSGIDS[0];
  const id1 = MSGIDS[1];
  const drop = (id) => { const c = { ...en }; delete c[id]; return { en: c }; };
  assert.equal(problemsOf({ en }, [id0]).length, 0, '原样 ⇒ 0 个问题');
  assert.equal(problemsOf(drop(id0), [id0]).length, 1, '缺一条 ⇒ 恰好 1 个问题');
  assert.equal(problemsOf({ en: { ...en, [id0]: '' } }, [id0]).length, 1, '空译文 ⇒ 1 个问题');
  assert.equal(problemsOf({ en: { ...en, [id1]: 'Can you send me?' } }, [id1]).length, 1,
    '`{chess}` 丢了 ⇒ 1 个问题（这正是"半句话"的形状）');
});
