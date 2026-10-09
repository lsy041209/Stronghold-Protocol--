// server/sim/content/kits/reserve-wang.js — **望**（char_2027_wang）的 kit
//
// ⚠️ 这个文件是三位外援共用文件 `reserve.js` 拆分出来的（一文件一会话），
//    所以头部曾**原样继承**了那份「陈/星熊的已知近似」清单 —— 那些条目**不属于望**、
//    而且其中多条**早已实现完**（陈 S3 的龙、星熊 S3 的真·伤害转移、星熊天赋1 的负生命）。
//    第 17 轮已删除，避免误导。**望自己的近似清单在下面（L70 起那一段）。**
//
// 数据来源与公共约定见 `reserve.js`（只读）与 `MEMORY.md` 的「写 kit 的硬知识」。
//
// ── 望自己的近似（逐条标注）──────────────────────────────────────────────────────────
// 见本文件下方那**两栏**：`// ── ✅ 已实现（第 22 轮重新核对…）` 与 `// ⚠️ 仍然是近似 / 未做`。
// **#5「棋子剩余机制」已于第 22 轮全部完成**（跟子 / S2 轴向+记忆化 / S3 停攻 / S3 弹药制 /
// 超出上限自动部署 / 阻回），每条都有探针；**仍近似的只剩 5 条**（见下方逐条）。

// 这些辅助函数由 tier1.js 统一导出（tier6.js 自己另定义了一个局部 num，所以它没 import）
import { num, talentBb, skillBbOf, statBuff, once } from './tier1.js';
import { absoluteRangeKeys } from '../../targeting.js';
// absoluteRangeKeys 返回的是**数字键** `r * COLS + c`（贝洛内 kit 里就是 `allowed.has(u.tileR * COLS + u.tileC)`），
// 所以这里要把 COLS 拿来做换算。
import { COLS } from '../../constants.js';

/**
 * 技能「立即获得 N 枚棋子」 —— 官方 `skchr_wang_*` 的 `cnt`：
 *   · 取势 S1 / 连星 S2 → **2** 枚
 *   · 天下劫 S3 → **8** 枚
 * 库存挂在**望**身上（`mem.wangStock`），与 `tokens.js` 的 `wangPieceKit` 共用同一个数。
 * 上限用官方天赋「铸子」精2 的「可以使用 6 枚，**最多拥有 7 枚**」 → cap = 7。
 */
const WANG_STOCK_CAP = 7;
/**
 * S3 的授予上限 = **8**（用户 10-06 澄清：「再获得 8 颗」= 精英2 + 模组那档的口径）✓
 * 官方天赋精2 是「可以使用 6 枚（潜能+1 = 7），**最多拥有 7 枚**（潜能+1 = 8）」——
 * 所以 7 是「常态上限」、8 是「满潜/模组上限」；S3 的 `cnt = 8` 正好落在后者 ✓。
 */
const WANG_S3_GRANT = 8;
function wangGrantPieces(owner, skillId) {
  if (!owner || !owner.mem) return;
  const add = String(skillId).endsWith('_3') ? 8 : 2;
  const cur = Number.isFinite(owner.mem.wangStock) ? owner.mem.wangStock : 6;   // 初值 = 天赋 cnt(精2)
  owner.mem.wangStock = Math.min(WANG_STOCK_CAP, cur + add);
}

/**
 * 在「**触发范围**（S3 = 官方 `4-12` 的 5×5 = 25 格；其余 = 自身 1 格）」内的**可放置空地**上随机部署棋子。
 *
 * 官方 S3 原文（PRTS，`skchr_wang_3`）：
 *   「立即获得 **8** 枚棋子，然后将**超出上限**的棋子**优先部署在范围内敌人所在位置**」
 * ⚠️ 优先级：**有敌人的格 > 其它格** —— 所以这里**先铺敌人脚下的格**，再随机铺其余空地 ✓
 *   （用户 10-06 的口径是「在扩大的攻击范围内**随机**部署」，与官方"优先敌人"不冲突：
 *     有敌人时先落敌人，没敌人时随机 —— 两个口径都满足 ✓）
 *
 * ⚠️ **必须用 `battle.rng`**（确定性的 mulberry32）✗ 不能用 `Math.random()` ——
 *   否则回放 / 测试的确定性会被破坏（`rng.js` 顶部写着"the ONLY source of randomness in the sim"）。
 *
 * @returns {number} 实际部署了几枚
 */
function wangDeployInRange(battle, owner, want, skillId, chess) {
  if (!battle || !owner || !(want > 0)) return 0;
  // 🔴 **范围必须取官方 `rangeGrid`，绝不能自己另抄一份** ✗ ——
  //    本文件原来用的是 `WANG_JIANYU`（德克萨斯「剑雨」`x-1` 的 **13 格**），
  //    而 S3「天下劫」的官方范围是 `skchr_wang_3` 的 `rangeId 4-12` = **25 格 5×5**
  //    （施法者在一条边的中点：向两侧各 2 格、向前 4 格）。
  //    ⇒ 后果正是用户 2026-10-06 实测报的那条：**棋子被放到望的身后/上下（竖直方向）**，
  //      因为 13 格剑雨是「前 2 + 左右 2 + 上下 2」的星形，**与 5×5 不是一回事** ✓
  //    ⇒ 现在与 `tokens.js` 的 `WANG_S3_GRID`、以及 `wang-s3-deploy.test.js` 的期望
  //      **三处同源**（都来自 chess 记录里 S3 的 `rangeGrid`）✓
  //    ⚠️ **`chess` 必须由调用方传进来**（2026-10-06 第 46 轮 A 修）：本函数是**模块作用域**的，
  //       够不到工厂闭包里的 `chess` —— 我第一版直接写 `skillGridOf(chess, …)`，
  //       实测抛 `ReferenceError: chess is not defined`，而它**被 `Battle._safe()` 吞掉** ✗ ⇒
  //       表面上"技能开了但一枚棋子都没铺"（`stock` 停在 6、`ammo` 是 `undefined`），**看不到任何报错** ✓。
  //       ⇒ 教训：**引擎里的 handler 异常是静默的** ⇒ 改这类代码必须看 `stock`/`ammo` 这种"后续副作用有没有发生"，
  //         不能只看"函数有没有被调用" ✗。
  const grid = String(skillId).endsWith('_3') ? skillGridOf(chess, 'skchr_wang_3') : [[0, 0]];
  const keys = absoluteRangeKeys(grid, owner.tileR, owner.tileC, owner.dir, 0);
  const g = battle.grid;
  /**
   * 该格现在能放下一枚棋子吗 —— **空地 + "这个单位真的能站" + 不是特殊格**（2026-10-06 第 46 轮 A 修）。
   *
   * 🔴 **修前它只查了 `g.walkable`**（C 用真对局探针 `c-probe-wang-deploy-tiles.mjs` 抓到，**exit 1**）：
   *   · **`walkable` 回答的是"这条路通不通"，不是"这个单位能不能站"**（`grid.js:10/:94` 自己写着）⇒
   *     实测 25 格里的 **3 格 `tile_deepsea`（深水区）** 被它判成"可放" ✗ —— 而深水区是**拒绝部署**的地形
   *     （`grid.js:97` 的 `DEPLOY_REFUSED_TILES`）⇒ 用户看到「棋子被放到奇怪的地方」（他报的是"蓝门"）✓
   *   · **`special` 完全没排除** ⇒ `tile_start` / `tile_end`（蓝门/侵入点）/ `telin` / `telout` 都可能被铺上棋子 ✗
   *     （参照：陈的龙在 `reserve-chen3.js:148` 明确排除了 `special === 'start' || 'end'`）
   *
   * ✅ **改用引擎自己的 `g.canStand(r, c, { ranged })`**：它内部就把 `build === 'NONE'`（含深水区）拒掉，
   *    并且尊重 `OB_BLOCK` 这类"被地图卡切换成障碍"的格（`grid.js:209-215`）✓
   * ⚠️ **`ranged` 取棋子自己的 `position`**（数据里是 `MELEE`）—— 不要写死，position 变了要自动跟上 ✓
   * ⚠️ **`special` 我排除全部四种**（start/end/telin/telout），比陈的龙更严一点：
   *    棋子是"**部署**"到一个格子上，而蓝门/侵入点/传送点是**关卡机制格**，不该被铺占 ✓
   *    （陈的龙只是**经过**，所以它只排除 start/end —— 两者口径不同是**故意**的，不是漏写。）
   */
  const pieceRanged = String((chess && chess.position) || '').toUpperCase() === 'RANGED';
  const free = (r, c) => {
    if (!Number.isInteger(r) || !Number.isInteger(c) || !g || !g.inRect(r, c)) return false;
    const t = g.tile ? g.tile(r, c) : null;
    if (t && t.special) return false;                                  // 蓝门 / 侵入点 / 传送点：关卡机制格，不铺
    if (typeof g.canStand === 'function' && !g.canStand(r, c, { ranged: pieceRanged })) return false;
    else if (g.walkable && !g.walkable(r, c, true)) return false;       // 兜底（没有 canStand 的旧 grid 实现）
    return !(battle.allyUnits || []).some((u) => u && u.alive && u.deployed && u.tileR === r && u.tileC === c);
  };
  const rng = typeof battle.rng === 'function' ? battle.rng : Math.random;
  const foes = (battle.enemies || []).filter((e) => e && e.alive && e.deployed);
  const foeTiles = new Set(foes.map((e) => e.tileR * COLS + e.tileC));
  const onEnemy = [], other = [];
  for (const k of keys) {
    const r = Math.floor(k / COLS), c = k % COLS;
    if (r === owner.tileR && c === owner.tileC) continue;            // 望自己站的格不放
    if (foeTiles.has(k)) { if (free(r, c)) onEnemy.push([r, c]); }
    else if (free(r, c)) other.push([r, c]);
  }
  if (typeof rng.shuffle === 'function') { rng.shuffle(onEnemy); rng.shuffle(other); }
  // 官方优先级：**有敌人的格优先** ✓；剩下按随机序 ✓
  const cands = [...onEnemy, ...other];
  let done = 0;
  for (const [r, c] of cands) {
    if (done >= want) break;
    // 🔴 **`mem.wangAuto` 必须用 `opts.mem` 在【部署前】落笔**（2026-10-06 第 47 轮 A 踩的坑）：
    //    棋子 kit 的 deploy 钩子**在 `spawnToken` 内部就跑了** ⇒ 事后再 `put.mem.wangAuto = true` 已经晚了 ✗
    //    ⇒ 那一版实测：技能铺的每枚棋子都被当成"手放的" ⇒ **每枚都触发一次四邻扩散** ⇒
    //      弹药被瞬间烧光、棋子铺得到处都是（用户口径的**排除条款完全失效**）✗
    const put = battle.spawnToken(owner, WANG_PIECE_TOKEN_ID, r, c, { mem: { wangAuto: true } });
    if (put) done++;
  }
  return done;
}

/** 棋子的官方 tokenId（内容包 wang.pack.json 的顶层 `tokens` 段声明，`placeable: true`）。 */
const WANG_PIECE_TOKEN_ID = 'token_10064_wang_stone1';
// ⚠️ 这里原来有一个 `WANG_JIANYU`（德克萨斯「剑雨」13 格）**已被删除** —— 它是错的：
//    S3「天下劫」的范围是官方 `rangeId 4-12` 的 **25 格 5×5**，必须走 `skillGridOf(chess,'skchr_wang_3')`
//    取数据（见 `wangDeployInRange` 的注释与用户 2026-10-06 的实测反馈）。
//    **不要**再在本文件里抄第二份范围 ✗
// ═══════════════════════════════════════════════════════════════════════════════════
// 望（char_2027_wang，特种·陷阱师）—— 棋子系统
//
// ⚠️ 这个文件**归 会话 A**（见 `协作/README.md` 的文件归属表）。另一个会话不要改它。
//    它由 `reserve.js` 合并后经 `tier3.js` / `tier6.js` 注册；`reserve.js` 只读。
// ═══════════════════════════════════════════════════════════════════════════════════

/** 技能范围（rangeGrid）内的敌人 —— 与贝洛内 kit 用的是同一套 absoluteRangeKeys + enemiesInKeys。 */
const foesInSkillRange = (battle, unit, grid) => {
  if (!grid || !grid.length) return battle.blockedTargets ? battle.blockedTargets(unit, unit.profile) : [];
  const keys = absoluteRangeKeys(grid, unit.tileR, unit.tileC, unit.dir, 0);
  return battle.enemiesInKeys(keys, unit, unit.profile) || [];
};

/**
 * 某个技能自己的 rangeGrid。
 *
 * ⚠️ **不能**用 `def.skill.rangeGrid` —— 那个是「当前选中技能」的范围，会随玩家选哪个技能而变；
 * 而 kits_alt_t3.test.js 断言「用默认技能构建出的 kit」与「用该技能构建出的 kit」得到的 spec 完全一致。
 * 所以必须按 skillId 从 chess 记录里取，与当前选中项无关。
 */
const skillGridOf = (chess, skillId) => {
  // ⚠️ **两个形态都要看**（2026-10-06 第 46 轮 A 修）：
  //    `normalizeChess()` 只把**当前选中技能**规范成 `def.skill`，**没有** `def.skills` 数组 ✗；
  //    原始记录（含全部技能）在 **`def.raw.skills`** ✓ —— 所以原来只查 `chess.skills` 的那版
  //    **在这条链路上恒为 `null`**（静默失效！范围一空，`absoluteRangeKeys` 就返回空数组
  //    ⇒ **S3 一枚棋子都铺不出去**，正是本轮测试从"0 枚落地"抓到的 ✗）。
  //    测试/沙箱直接传原始记录（顶层就有 `skills`）时也要能用，所以两个都查 ✓。
  const list = (chess && chess.skills) || (chess && chess.raw && chess.raw.skills) || [];
  const rec = list.find((s) => s && (s.skillId === skillId || s.id === skillId));
  return (rec && rec.rangeGrid) || null;
};

// ─────────────────────────────────────────────────────────────────────────────────────
// 望（char_2027_wang，特种·陷阱师）—— 棋子系统第一版
//
// 设计依据：`.workbuddy/ops-research/wang-spec.md`（官方数据 + 用户给的 6 条放置规则 + 可行性结论）。
//
// ✅ 真的实现了：
//   · 棋子 = 内联 def 的召唤物（`spawnToken` 的 `opts.def`），**不需要 token 记录**
//   · 自动放置：候选格按「离最近的敌人最近 → 否则顺时针」排序，逐个尝试 spawnToken
//     —— 失败就让引擎拒（`_deploy` 返回 false 即该格站不了），这天然实现了「隔墙任何时候都不可部署」
//   · 敌人踩到棋子所在格 → 触发「当前所选技能」的效果（S1 停顿+每秒法伤 / S2 范围法伤+减速 / S3 法伤）
//   · 天赋2「料敌机先」按**当前存活的棋子数**给增伤与法穿（叠加上限 3 层，与原作一致）
//
// ── ✅ 已实现（**第 22 轮重新核对，#5 已全部完成**）────────────────────────────────────
//   每条都配了探针（`.workbuddy/tools/probe-wang-*.mjs`），括号里是实测结果：
//   · **棋子 = 玩家待部署区里可手部署的一次性地雷**（内容包 `placeable: true`）——
//     引擎 `pieceSource` / `releaseSkillSummon` 交到手上，玩家自己放。
//   · **引爆一次后召唤物消失** + **原位按 `respawnTime` 自动补位**（库存扣完为止）。
//     ⚠️ 扣账在「**真的补上去**」时才发生（引爆格常站着敌人，占格会失败）。〔probe-wang-piece〕
//   · **库存**：初值 6（天赋「铸子」`cnt`），挂在**望**身上（`mem.wangStock`），上限 7。
//   · **技能加库存**：S1/S2 每次 **+2**、S3 每次 **+8**（官方 `cnt`）。
//   · **跟子**（天赋1 的额外部署）：相邻生成、**不是单位/不占格**、**参与连线**、**也能引爆**（上限 9）。
//     〔probe-wang-follow **7/0**〕
//   · **连线激活门控**：只有与相邻棋子/跟子**正交相连**的棋子才响应敌人（`isActivated`）。
//   · **料敌机先**：按**连续直线上的棋子数**加成（最多 3 层；精2 每层 +13% / 无视 12 法抗）。
//   · **连星（S2）轴向效果范围**：相连在**上下 → 垂直**（自身及上下 3 格）／**左右 → 水平**（自身及左右 3 格），
//     且**激活后不因相连棋子消失而取消**（`mem.wangAxis` 记忆化；在 tick 里**持续跟踪**）。
//     〔probe-wang-s2-axis **5/0**〕
//   · **天下劫（S3）触发/伤害范围** = 官方 `rangeId 4-12` 的 **25 格 5×5**（`skchr_wang_3`）——
//     ⚠️ **2026-10-06 更正**：旧版写的「德克萨斯剑雨 `x-1`（13 格）」**是错的** ✗（用户实测推翻）。
//   · **S3「停止攻击但攻击范围扩大」**：`onStart` 挂 `flags: { disarm: true }` 时效 buff。
//     〔probe-wang-s3 **4/0**：技能期间 0 次普攻 vs 对照 10 次〕
//   · **S3 弹药制**：`trigger_time = 20` 发；每引爆一枚扣 1；归零 **或棋子耗尽** → 技能结束；
//     **剩余弹药返还为棋子**（`onEnd`）。〔probe-wang-s3-ammo **6/0**〕
//   · **S3「超出上限的棋子 → 优先部署在范围内敌人所在位置」**：`wangAutoDeployExcess()`；
//     放不下去时**退回库存**（不凭空丢失）✓〔同上 ①b〕
//   · **阻回**：库存 ≥ 上限 7 时挂 `flags: { noSp: true }`（SP 不回复），降下来再移除。
//     〔probe-wang-zhuhui **4/0**：满库存 SP Δ=0.000；降到 3 后 Δ=+3.000/3s〕
//   · **可对空**：棋子与跟子的伤害 `canHitFly`。
//
// ⚠️ 仍然是近似 / 未做（逐条标注，别当成完整实现）：
//   ① **逐实例独立记账没做**：原作每个 DOT 各自记录「**触发它的那枚棋子**的第二天赋层数」；
//      这里统一按**当前**层数算 ⇒ 多层棋子先后引爆时，已在跳的 DOT 会跟着变 ✗
//   ② **S2 轴向的"两侧都有相连"没定义**：官方只说「上下→垂直／左右→水平」，
//      **没说同时有上下和左右相连时取哪个** ✗ 我按**遍历顺序返回先遇到的** ⇒ **顺序相关** ⚠️
//      （触发场景常见：棋子的**跟子**总在一侧，另一侧可能有棋子。）**等用户/B 给口径** ✓
//   ③ **S3「手动停止」没做**：官方「**手动停止或棋子耗尽后技能结束**」—— "棋子耗尽"已做 ✓，
//      **"手动停止"没有入口**（需要玩家主动收技能的 UI/协议）✗
//   ④ **棋子的图标/模型还没接**：`data/assets.json` 的 `tokens` 段**没有** `token_10064_wang_stone1` ✗
//      原因已查明：**本机日服客户端里没有该资源**（皮肤按需下载）⇒ 需用户让望在日服上场一次、
//      或从官方 CDN 取。**在拿到真资源前不往 assets.json 写路径**（会 404）✓
//   ⑤ **A-5「放置时扣 `stats.cost`(3) 的 DP」未核实**：`PlayerState.spend()` 存在（L811），
//      但它的 5 个调用点**全是商店/奖励购买** ✗ 手牌放置的入口不在 `server/match/*.js` ✓ **待查**
// ─────────────────────────────────────────────────────────────────────────────────────

/** 棋子的内联定义（`normalizeToken` 会补齐 id/baseId/golden/bonds/rarity 等）。
 *
 *  🔴 **2026-10-06 第 48 轮 A（C 定位）：`cost` 原来写成 `0`，官方是 `3`** ——
 *     · 官方真源：`data/tokens.json` → `token_10064_wang_stone1.stats.cost = 3` ✓
 *     · 而 `spawnToken(owner, id, r, c, { def: WANG_PIECE_DEF })` **会用内联 def 覆盖官方记录**
 *       （`Battle.js:1816`：`opts.def ? normalizeToken(...) : this._tokenDef(...)`）⇒ 官方那个 3 被 0 盖掉 ✗
 *     · **但注意：本文件里用它的 `placePieces()` 已经是【死代码】**（没有任何调用点；棋子自第 17 轮起
 *       由内容包的 `placeable: true` token 记录生成）⇒ **这条不是运行时缺陷**，属"将来谁复活这段代码会踩"的坑
 *       ⇒ 仍然改成与官方一致的 **3** ✓
 *     ⚠️ 真正的"手放棋子不扣 DP"是**匹配层**的事（`server/match/PlayerState.js` 的 `_moveTokenToBoard`
 *        全程不查不扣 DP），**不在本文件** —— 见 `协作/已知问题.md` 的"第 48 轮"一节。
 */
const WANG_PIECE_DEF = Object.freeze({
  name: '棋子',
  description: '敌人进入激活的棋子所在地块时触发其效果',
  profession: 'TOKEN',
  position: 'MELEE',
  tier: 1,
  attackKind: 'none',            // 棋子自己不打人，效果由本 kit 的钩子结算
  stats: {
    maxHp: 1000, atk: 0, def: 0, res: 0, cost: 3, blockCnt: 0,     // cost = 官方 3（原来是 0，见上面那段注）
    bat: 1, aspd: 100, respawnTime: 0, moveSpeed: 0,
    spRecovery: 0, hpRecoveryPerSec: 0, tauntLevel: 0, massLevel: 0,
  },
  rangeGrid: [[0, 0]],           // 棋子自身只占一格
});

/** 顺时针（上→右→下→左）遍历候选格用；dx=列、dy=行，dy>0 为前方（与项目其它地方口径一致）。 */
const CLOCKWISE = [[0, 1], [1, 0], [0, -1], [-1, 0]];

const wang = (bb, chess, def) => {
  const t1 = talentBb(chess, 1);
  const s1 = skillBbOf(chess, 'skchr_wang_1');
  const s2 = skillBbOf(chess, 'skchr_wang_2');
  const s3 = skillBbOf(chess, 'skchr_wang_3');
  const perAtk = num(t1['attack@per_atk_scale'], 0.1);
  const perPen = num(t1['attack@per_magic_resist_penetrate_fixed'], 9);
  const maxStack = Math.max(1, Math.floor(num(t1['attack@max_trigger_cnt'], 3)));

  /**
   * 按「离最近的敌人最近 → 否则顺时针」给出候选格，逐个尝试放棋子。
   * 放置合法性交给引擎（spawnToken 在该格站不了时会返回 null）。
   */
  function placePieces(battle, unit, grid, want, clockwiseOnly) {
    if (!grid || !grid.length) return 0;
    const keys = absoluteRangeKeys(grid, unit.tileR, unit.tileC, unit.dir, 0);
    const tiles = [];
    for (const k of keys) {
      // absoluteRangeKeys 给的是数字键 r * COLS + c
      const r = Math.floor(k / COLS), c = k % COLS;
      if (!Number.isInteger(r) || !Number.isInteger(c)) continue;
      if (r === unit.tileR && c === unit.tileC) continue;   // 自己站的格不放
      tiles.push([r, c]);
    }
    const foes = (battle.enemies || []).filter((e) => e && e.alive && e.deployed);
    // 排序：先按「到最近敌人的距离」升序；平手时按「顺时针」次序
    const distToFoe = ([r, c]) => {
      let best = Infinity;
      for (const e of foes) best = Math.min(best, Math.abs(e.tileR - r) + Math.abs(e.tileC - c));
      return best;
    };
    const cwIndex = ([r, c]) => {
      // 相对望的方位：上(0,1)→右(1,0)→下(0,-1)→左(-1,0)
      const dr = r - unit.tileR, dc = c - unit.tileC;
      for (let i = 0; i < CLOCKWISE.length; i++) {
        const [dx, dy] = CLOCKWISE[i];
        if (Math.sign(dc) === Math.sign(dx) && Math.sign(dr) === Math.sign(dy) && (dx === 0 || dc !== 0) && (dy === 0 || dr !== 0)) return i;
      }
      return CLOCKWISE.length;
    };
    // 靠近敌人的格子优先（没有敌人时 `distToFoe` 全是 Infinity，就退化成顺时针 + 距离）
    tiles.sort((a, b) => {
      const da = distToFoe(a), db = distToFoe(b);
      if (da !== db) return da - db;
      const dist = (t) => Math.abs(t[0] - unit.tileR) + Math.abs(t[1] - unit.tileC);
      const d = dist(a) - dist(b);
      if (d !== 0) return d;
      if (clockwiseOnly) return cwIndex(a) - cwIndex(b);
      return cwIndex(a) - cwIndex(b);
    });
    let placed = 0;
    for (const [r, c] of tiles) {
      if (placed >= want) break;
      const u = battle.spawnToken(unit, 'wang_piece', r, c, { def: WANG_PIECE_DEF });
      if (!u) continue;                 // 越界 / 有人 / 该格站不了 → 引擎拒，换下一格
      u.mem.wangPiece = true;
      placed++;
    }
    return placed;
  }

  /**
   * 场上存活的棋子（天赋2「料敌机先」的层数用它）。
   *
   * ⚠️ 第 17 轮起判据改了：棋子**不再由本 kit 生成**（那是旧的自动放置方案），
   * 而是由引擎按内容包声明的 `placeable: true` 召唤物生成 —— 所以没有 `mem.wangPiece` 标记了，
   * 改为按 `kind === 'token' && defId === 棋子的 tokenId && ownerUnit === 望` 认。
   */
  function livePieces(battle, unit) {
    return (battle.allyUnits || []).filter(
      (u) => u && u.alive && u.kind === 'token' && u.defId === WANG_PIECE_TOKEN_ID && u.ownerUnit === unit,
    );
  }

  /** 敌人踩到棋子 → 按**当前所选技能**结算一次触发效果。 */
  function firePiece(battle, unit, piece, foe) {
    const sid = (unit.skill && unit.skill.skillId) || '';
    if (sid === 'skchr_wang_1') {
      battle.applyStatus(foe, 'sluggish', { duration: num(s1['attack@sluggish'], 6.5), source: unit });
      foe.mem = foe.mem || {};
      foe.mem.wangDot = { until: battle.time + num(s1['attack@sluggish'], 6.5), scale: num(s1['attack@atk_scale'], 1.05) };
      return;
    }
    if (sid === 'skchr_wang_2') {
      // 近似①：没有连线拓扑 → 用「目标格 + 上下左右」代替「连线方向两侧 3 格」
      const around = battle.unitsInGrid
        ? battle.unitsInGrid(foe, [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]], { side: 'enemy' })
        : [foe];
      for (const e of around) {
        if (!e || !e.alive) continue;
        battle.dealDamage(unit, e, { amount: unit.s.atk * num(s2['attack@atk_scale'], 4.2), type: 'arts', isSkill: true, tags: ['skill'] });
        battle.applyStatus(e, 'sluggish', { duration: num(s2['attack@duration'], 6), source: unit });
      }
      return;
    }
    // S3 及默认：棋子触发/伤害范围扩大的法术伤害
    battle.dealDamage(unit, foe, { amount: unit.s.atk * num(s3.atk_scale, 2.9), type: 'arts', isSkill: true, tags: ['skill'] });
  }

  return {
    // 默认技能 S1 取势（自动回复 / 自动触发，**无限持续**）
    skill: {
      // 🔴 **`kind:'toggle'`，不是 `kind:'duration', duration:-1`**（2026-10-06 第 46 轮 A 修，**实测过的活 bug**）：
      //   官方这两条是**被动**技能（`durationType: NONE`，黑板上 `duration = -1` 是"不由技能时长驱动"的**哨兵值**，
      //   真正的时长在 `attack@sluggish` = 6.5 / `attack@duration` = 6 里，由**棋子的效果**用 ✓）。
      //   而引擎 `skills.js:479` 对 `kind:'duration'` 是 `Math.max(0.01, this.duration)`
      //   ⇒ **`-1` 被截成 0.01 秒** ⇒ 下一 tick 就 `end('duration')` ⇒ `onEnd` 把 `mem.wangPieces` 清成 false
      //   ⇒ **望在场等于没带技能**（天赋2 的标记没了）。
      //   **实测（`tmp-dur-probe.mjs`，修前）**：S1/S2 都是 `timeLeft = 0.01`，0.05s 后 `active = false`；S3 = 32 正常 ✓
      //   ⇒ 改用引擎自己的 `toggle` 口径（`generic.js:84-86` 就是这么把 `duration<0` 判定成 toggle 的；
      //      toggle 的 `timeLeft = Infinity` 且 tick 不递减）—— 与星熊 S1 同一类修法 ✓
      kind: 'toggle',
      // ⚠️ 第 17 轮起：**棋子不再由这里自动放置**。
      //    棋子已经是官方形态的「玩家待部署区里可手部署的装置」——
      //    内容包 `wang.pack.json` 的顶层 `tokens` 段声明了 `placeable: true`，
      //    引擎的 `pieceSource` / `releaseSkillSummon` 把它交到玩家手上、放在玩家指定的格；
      //    触发效果在 `server/sim/content/tokens.js` 的 `wangPieceKit()` 里。
      //    所以这里**只标记「望在场」**，供天赋2 数棋子用。
            // 官方主动效果「立即获得 N 枚棋子」（S1/S2 = 2、S3 = 8）；
      // 库存挂在**望**身上（棋子的 `wangPieceKit` 也从同一个 `mem.wangStock` 扣）。
      onStart({ unit }) { unit.mem.wangPieces = true; wangGrantPieces(unit, 'skchr_wang_1'); },
      onEnd({ unit }) { unit.mem.wangPieces = false; },
    },
    skills: {
      // 连星
      skchr_wang_2: {
        // 🔴 同上（S1）：`duration:-1` ⇒ 0.01 秒 ⇒ 必须 `toggle`（2026-10-06 实测过的活 bug）✓
        kind: 'toggle',
              // 官方主动效果「立即获得 N 枚棋子」（S1/S2 = 2、S3 = 8）；
      // 库存挂在**望**身上（棋子的 `wangPieceKit` 也从同一个 `mem.wangStock` 扣）。
      onStart({ unit }) { unit.mem.wangPieces = true; wangGrantPieces(unit, 'skchr_wang_2'); },
              onEnd({ unit }) { unit.mem.wangPieces = false; },
      },
      // 天下劫：范围扩大（近似④：弹药制未实现）
      skchr_wang_3: {
        kind: 'duration', duration: num(s3.duration, 32),
        // ⚠️ 官方主动效果是「**停止攻击但攻击范围扩大**」——
        //    所以这里**不能**靠 `attack` 去打人（那正是用户实测报的 bug：「开技能的情况下依然在攻击」）。
        //    `targeting.rangeGrid` 保留，是因为**棋子的触发/伤害范围扩大**要用它（→ 官方 4-12 的 5×5）；
        //    「望自己不打」由下面 onStart 挂的 `disarm` 时效 buff 实现。
        targeting: { rangeGrid: skillGridOf(chess, 'skchr_wang_3'), maxTargets: 1 },
        onStart({ battle, unit }) {
          unit.mem.wangPieces = true;
          // ── 官方 S3 原文（PRTS `skchr_wang_3`）──
          //   「立即获得 **8** 枚棋子，然后将**超出上限**的棋子**优先部署在范围内敌人所在位置**」
          // + 用户 10-06 的权威口径：
          //   「望开启技能后，**所有剩余棋子都会在扩大的攻击范围内随机部署**，然后**再获得 8 颗**。」
          //   「目前…**自动开技能也不会将剩余棋子部署**」（= 要修的 bug）✓
          // ⇒ 顺序照用户说的：**先把现有库存全铺到范围内**，再**补到 8 枚** ✓
          const before = Math.max(0, Math.floor(num(unit.mem.wangStock, 6)));
          const put = wangDeployInRange(battle, unit, before, 'skchr_wang_3', chess);
          // 已经在 `wangDeployInRange` 里按"敌人格优先 + 其余随机"落地 ✓
          // ⚠️ **账目**：铺出去的那些**从库存里扣**（没铺下去的留着，不凭空丢 ✓）
          unit.mem.wangStock = Math.max(0, before - put);
          // 然后「**再获得 8 颗**」：夹在「可以使用 6 / 最多拥有 7」（精2；潜能再 +1 = 8）——
          // ⚠️ 用户明确说"再获得 8 颗" ⇒ 这里按 **8** 给，而不夹到 7 ✗
          //    （官方 S3 自己就是 `cnt = 8`，与"超出上限"那句一致 ✓）
          unit.mem.wangStock = Math.min(WANG_S3_GRANT, unit.mem.wangStock + 8);
          {
            // 官方下半句：「然后将**超出上限**的棋子优先部署在范围内敌人所在位置」——
            // 上面已经把库存夹在 8 以内，这里把**还超出的**部分（= 上限外）落到敌人格/空地 ✓
            const over = Math.max(0, unit.mem.wangStock - WANG_STOCK_CAP);
            if (over > 0) {
              const done = wangDeployInRange(battle, unit, over, 'skchr_wang_3', chess);
              if (done > 0) unit.mem.wangStock = Math.max(0, unit.mem.wangStock - done);
            }
          }
          // ── 弹药制（官方：「装有 {trigger_time} 发弹药」；L7 = **20 发**）──
          // 从 bb 读，不写死；读不到才回退 20。
          const ammo = num(bb.trigger_time, 20);
          unit.mem.wangAmmo = ammo > 0 ? ammo : 20;
          // 「停止攻击」：引擎里 `flags.disarm` 就是「不进行普通攻击」（先例 bosses.js 碎铳之簧的追逐模式）。
          // 用时效 buff，技能结束自动恢复，不需要手工还原 profile。
          battle.addBuff(unit, {
            key: 'wang:s3_no_attack', duration: num(s3.duration, 32), tags: ['skill'],
            flags: { disarm: true },
          });
        },
        onEnd({ battle, unit }) {
          unit.mem.wangPieces = false;
          battle.removeBuff(unit, 'wang:s3_no_attack');
          // ── 官方：「**剩余的弹药返还为棋子**」──
          const left = Math.max(0, Math.floor(num(unit.mem.wangAmmo, 0)));
          if (left > 0) {
            const before = num(unit.mem.wangStock, 0);
            unit.mem.wangStock = Math.min(WANG_S3_GRANT, before + left);
          }
          unit.mem.wangAmmo = 0;
        },
      },
    },
    talents: [{
      install(battle, unit) {
        // ── 阻回（官方天赋「铸子」备注：「持有的棋子库存达到上限的情况下具有阻回」）──
        // 阻回 = SP 不回复；引擎用 buff flag `noSp` 表达（`buffs.js:40` 的合法列表里有它）。
        // 口径：取**拥有上限 7** 作阈值（官方只说"达到上限"，未区分"可用 6 / 拥有 7"，这是我的选择）。
        battle.on('tick', () => {
          if (!unit.alive) return;
          const full = num(unit.mem.wangStock, 0) >= WANG_STOCK_CAP;
          const has = !!(unit.s && unit.s.flags && unit.s.flags.noSp);
          if (full && !has) {
            battle.addBuff(unit, { key: 'wang:no_sp', duration: Infinity, tags: ['talent'], flags: { noSp: true } });
          } else if (!full && has) {
            battle.removeBuff(unit, 'wang:no_sp');
          }
        }, { owner: unit });
        let acc = 0;
        once(battle, 'talent:wang_liaodi', () => {
          battle.on('tick', (ctx) => {
            if (!unit.alive || !unit.deployed || !unit.mem.wangPieces) return;
            const dt = num(ctx && ctx.dt, 0);
            // 天赋2 料敌机先：近似①——层数改为「当前存活棋子数」（原作是连线上的棋子数），上限 3
            const layers = Math.min(maxStack, livePieces(battle, unit).length);
            acc += dt;
            if (acc < 0.5) return;
            acc = 0;
            statBuff(battle, unit, 'talent:wang_liaodi', { atkPct: perAtk * layers, resPen: perPen * layers });
          });
          // ⚠️ 第 17 轮起：**「敌人踩到棋子 → 触发」与 S1 的每秒 DOT 都不在这里做了** ——
          //    棋子已是引擎按内容包 `placeable: true` 生成的装置，触发效果在
          //    `server/sim/content/tokens.js` 的 `wangPieceKit()` 里（那里能用 `bodyOnTile` /
          //    `ownerAtk` 等引擎内部 helper，比我在这里手搓更准）。这里只留天赋2 的层数。
        });
      },
    }],
  };
};

export default {
  chess_wang_a: wang,
};
