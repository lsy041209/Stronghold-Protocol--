// 外援干员的 kit —— **只做合并，谁都不改自己那一份文件**。
//
// ⚠️ 为什么拆开：多个 AI 会话在协作（见工作区根目录 `协作/`）。
//    一个文件只归一个会话，才不会互相覆盖。归属表见 `协作/README.md`。
//
//   reserve-wang.js    ← 会话 A（望：棋子）
//   reserve-chen3.js   ← 会话 B（陈）
//   reserve-hsgma2.js  ← 会话 B（星熊）
//   reserve-typhon.js  ← 会话 A（A-7 第 1 位外援：提丰）
//   reserve-ascln.js   ← 会话 A（A-7 第 2 位外援：阿斯卡纶）
//   reserve-logos.js   ← 会话 A（A-7 第 3 位外援：逻各斯）
//
// 合并后的对象被 `tier3.js` 与 `tier6.js` 各 `...spread` 一次（单一来源，无重复代码）。
//
// ⚠️ **A-7 的外援"接线在这里、启用不在这里"**（2026-10-07 第 50 轮 A）：
//    这三位的内容包**仍是 `.pending`**（`content-packs/<slug>.pack.json.pending`）⇒
//    **`data/chess.json` 里没有它们的记录** ⇒ 引擎**永远不会查到**这三个 kit 键 ⇒
//    **接上它们对当前运行零影响**（`content/index.js` 是按 chessId 查表的）。
//    为什么要先接：kit 写完后立刻接线，**避免"kit 写了却忘了接"**这类遗漏；
//    启用（去掉 `.pending` + 迁移跨会话计数）时**这一处不用再改**。
//    为什么安全：`tools/kit-coverage.mjs` 是**以 chess 记录为基准**去查 kit（`for (const base of bases)`），
//    所以"kit 比记录多"**不会**让任何判据红。
import wang from './reserve-wang.js';
import chen3 from './reserve-chen3.js';
import hsgma2 from './reserve-hsgma2.js';
import typhon from './reserve-typhon.js';
import ascln from './reserve-ascln.js';
import logos from './reserve-logos.js';
import makoto from './reserve-makoto.js';

export default {
  ...chen3,
  ...hsgma2,
  ...wang,
  ...typhon,
  ...ascln,
  ...logos,
  ...makoto,
};
