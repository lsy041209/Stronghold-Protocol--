// cardMarks.js — 标记卡（"本局我想要"高亮）的**纯逻辑 ＋ 持久化**（C 需求件 `C-需求与判据-标记卡本局我想要高亮`；用户 2026-10-08 拍"我想要"）。
//
// 🔴 **候选集合＝X**（C §1ter 要求"实现方先核三种机制再写判据"；取证脚本 `.workbuddy/tools/_b12-markcard-pool2.mjs`，读数照抄）：
//   · **键一律是 chess id**（`chess_char_1_01_a` 这种 —— 商店卡 `slot.id` 与 `bonds.json.visibleMembers` 都是它）。
//     ⚠️ 自选编队池 `backups.diy.ownedPool` 是 **char id**（`char_003_kalts`）：实测那 71 个 id **直接当 chess 键命中 0/71**
//     ⇒ **两个 id 空间，别交叉**（本仓"0 命中"的第 4 种成因就吃过这个亏）。char→chess 用 chess 记录的 `charId` 反查。
//   · **候选 = `visible !== false && isHidden !== true` 的 chess 记录**（实测 **224/266**；隐藏的 42 条不进候选）。
//     🔴 **为什么不用"自选编队池"**（C §1ter 的猜测）：实测两种口径的差距是**压倒性的** ——
//        `backups.diy.ownedPool`（71 个 **char id**）与 `chess.json` 的 `charId` **交集 0**
//        ⇒ 按"自选池口径"筛完，**23 个盟约一个都标不了（23/23 全空）**；而"全部可见口径"给出
//        叙拉古 20 ／ 炎 20 ／ 萨尔贡 20 …（逐盟约读数见 `.workbuddy/tools/_b12-markcard-rule.mjs`）。
//        ⇒ **候选＝全部可见**（这也正是玩家要的："我是叙拉古，选中所有叙拉古"）。
//        ⚠️ 可见的 224 = **112 位干员 × 2 形态**（普通/精锐各一条记录）⇒ 勾一位干员会让**两种形态都高亮**（正是想要的）。
//   · **`diy.excluded`（7 条）不是"本局 ban"** —— 实测 `char_456_ash`/`char_1029_yato2`/`char_1048_orchd2`/`char_4123_ela`/
//     `char_4141_marcil`/`char_4182_oblvns`/`char_4217_makoto` **一个都不在 ownedPool 里** ⇒ 它是**整合包层面不提供**
//     （已体现在池子里）⇒ ⛔ **不要再减一遍**（C 让我核的就是这句）。
//   · **本局禁用盟约**（`pub.disabledBonds` / `pub.drawnDisabledBonds`）只决定"**哪些盟约可点**"（入口，J-2bis），
//     **不删已有标记**（玩家改主意/盟约被禁时，标记留着更不意外）。
//
// 状态：**`{ marker, ids }`**（`ids` = chess id 数组）＋ 走 `store.js` 的 `loadPref/savePref`（照皮肤先例 `ui/skins.js`）。
// 🔴 2026-10-09 用户实测 bug：「在**前几局**标记过的干员，在该局结束后不会解除标记，导致之后几局都会携带标记」。
//    根因：我把**本局**的标记存成了**全局键**（裸数组，与"哪一局"无关）⇒ 跨局残留。
//    修法：键里带 **marker**（`房间码#相位`，相位 = match/lobby）；**marker 不同 ⇒ 一律当空集**。
//    ⚠️ 于是"旧的裸数组"（本次修 bug 之前的存量数据）**天然被忽略** —— 玩家不用手动清。
import { loadPref, savePref } from '../store.js';

export const CARD_MARKS_KEY = 'cardMarks';
/** 上限：防坏数据把偏好存爆（正常一局标几十张就到头）。 */
export const CARD_MARKS_MAX = 400;

/**
 * 🔴 本局标识（纯函数，可判据）：`房间码#相位`。
 * 相位用 `room.inMatch`：**新的一局开始**（false→true）就换 marker ⇒ 上一局的标记自动作废；
 * 一局结束回到等待室 ⇒ marker 回到 `lobby` ⇒ 也是空集。**没有房间 ⇒ `''`**（视角外的标记不持久化）。
 * ⚠️ 客户端**没有 seed**（查过：只有特效的随机种子）⇒ 相位＋房间码是能拿到的最准信号。
 * @param {{ code?: string, inMatch?: boolean }|null} room
 */
export function marksMarker(room) {
  const code = room && room.code != null ? String(room.code) : '';
  if (!code) return '';
  return `${code}#${room.inMatch ? 'match' : 'lobby'}`;
}

/** 坏数据 ⇒ 空集，**不抛**（J-5：非法 JSON/未知形状都要安全回退）。 */
export function cleanMarks(v) {
  const out = [];
  for (const raw of Array.isArray(v) ? v : []) {
    const id = raw == null ? '' : String(raw);
    if (!id || id.length > 64 || out.includes(id)) continue;
    out.push(id);
    if (out.length >= CARD_MARKS_MAX) break;
  }
  return out;
}

/**
 * 读**本局**的标记。⛔ `marker` 必须给（`game.js` 传 `marksMarker(room)`）：
 *   · 存的是老形状（裸数组）⇒ 当空集（修 bug 前的存量，忽略）；
 *   · 存里的 marker 与本局不同 ⇒ 空集（**这就是"跨局不残留"的落点**）。
 * @param {string} marker `marksMarker(room)`
 */
export function loadMarks(marker) {
  const rec = loadPref(CARD_MARKS_KEY, null);
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return [];
  if (String(rec.marker == null ? '' : rec.marker) !== String(marker == null ? '' : marker)) return [];
  return cleanMarks(rec.ids);
}

/** 写**本局**的标记（连 marker 一起写，下一局读的时候自然对不上）。 */
export function saveMarks(marker, list) {
  savePref(CARD_MARKS_KEY, { marker: String(marker == null ? '' : marker), ids: cleanMarks(list) });
}

/** J-1：查/切。**纯函数**（返回新数组，原数组不动 ⇒ 面板里比较引用就能决定重渲染）。 */
export function isMarked(marks, id) { return cleanMarks(marks).includes(String(id)); }
export function toggleMark(marks, id) {
  const cur = cleanMarks(marks);
  const k = String(id);
  return cur.includes(k) ? cur.filter((x) => x !== k) : cleanMarks([...cur, k]);
}
export function markMany(marks, ids) { return cleanMarks([...cleanMarks(marks), ...(Array.isArray(ids) ? ids : [])]); }
export function unmarkMany(marks, ids) {
  const drop = new Set((Array.isArray(ids) ? ids : []).map(String));
  return cleanMarks(marks).filter((x) => !drop.has(x));
}
export function unmarkAll() { return []; }

/** 一条 chess 记录的盟约归属（`data/chess.json` 每条都有 `bonds`）。 */
export function bondsOf(chess, id) {
  const rec = chess && typeof chess === 'object' ? chess[String(id)] : null;
  return Array.isArray(rec?.bonds) ? rec.bonds : [];
}

/**
 * 候选集合（见文件头 §候选集合）：本局**真可能出现**的 chess id。
 * @param {object} chess `data/chess.json`（键 = chess id）
 * @param {{ ownedPool?: string[] }|null} [_diy] ⚠️ **故意不用**：见文件头那条读数（自选池口径 = 23/23 盟约全空）
 */
export function candidateChessIds(chess, _diy = null) {
  const out = [];
  for (const [id, rec] of Object.entries(chess && typeof chess === 'object' ? chess : {})) {
    if (!rec || rec.visible === false || rec.isHidden === true) continue;
    out.push(id);
  }
  return out;
}

/** J-2：**按盟约**批量 —— 该盟约 ∩ 候选（⛔ 不是全树；负对照见判据）。 */
export function markBondIds(chess, diy, bondId) {
  const want = String(bondId);
  return candidateChessIds(chess, diy).filter((id) => bondsOf(chess, id).includes(want));
}

/**
 * J-2bis：**入口＝本局已激活（未被禁用）的盟约**。
 * @param {string[]} allBondIds 全部盟约（`data/bonds.json` 的键）
 * @param {{ disabledBonds?: string[], drawnDisabledBonds?: string[] }|null} pub 本局公开态
 */
export function selectableBondIds(allBondIds, pub) {
  const off = new Set([...(Array.isArray(pub?.disabledBonds) ? pub.disabledBonds : []),
    ...(Array.isArray(pub?.drawnDisabledBonds) ? pub.drawnDisabledBonds : [])]);
  return (Array.isArray(allBondIds) ? allBondIds : []).filter((b) => !off.has(b));
}
