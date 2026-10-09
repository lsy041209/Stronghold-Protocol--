// quickArgs.js — 快捷短语**带参句式**的候选项（第 12 任 B，2026-10-08；C 派工 B-C1 的后半）。
//
// 为什么单独一层：候选来自**三处不同的数据源**（本局公开态 `pub`、本房座位 `room`、客户端数据 `data`），
// 而"哪些能选、显示成什么"是**纯映射** ⇒ 抽成纯函数，Node 里能单测（不建 DOM、不 import store）。
// 面板只负责画：`quickArgOptions(kind, { data, room, pub }) → [{ value, label }]`。
//
// 口径（口径来源写清楚，**不要自己发明**）：
//   · `playing` ⇒ **本局没被禁用的盟约**（`pub.disabledBonds` / `pub.drawnDisabledBonds` 之外的；键与名字取自 `data.get('bonds')`）
//     —— 「我玩 X」说的是**这局能玩的**阵营/盟约，禁用的列出来只会误导。
//   · `need`    ⇒ **自选编队池**（`backups.diy.ownedPool` ＋ 各阶级 `prototypes`；名字取 `backups.units[charId].name`）
//     —— 与 `shared/diy.js diyPool()` 同源（客户端拿不到 `kitted` 那份过滤，见下 ⚠️）。
//   · `thanks`  ⇒ **本房座位 ＋ 观战席**（`room.seats` / `room.spectators` 的 `{playerId, name}`）
//     —— 人退了就发不出，正合"感谢某人"的本意（服务端 `BAD_TARGET` 兜底）。
//   · `careful` ⇒ **本局敌人**：⚠️ 客户端目前**拿不到"本局有效敌人集合"**（那是波次/战场帧的东西）⇒ 返回空数组，
//     面板据此把这一条留在"不能发"的状态（⛔ 不编候选、也不假装校验 —— 与 A 那边"不假装校验"口径一致）。
//
// ⚠️ 名字都取**数据里的中文名**（`rec.name`）。多语言的名字要走 `shared/i18n.js` 的 `dn`/`tName` 那族，
//    那是**另一个单**（本层的判据只钉"候选对不对、值是不是 id"）。

/** 候选条数上限（面板是个小浮层，别把 DOM 撑爆）。 */
export const QUICK_ARG_OPTION_CAP = 40;

/** 一个对象 → 它的键们（坏数据 ⇒ []）。 */
const keysOf = (o) => (o && typeof o === 'object' ? Object.keys(o) : []);

/** 名字优先，其次 id；把"看起来是 id"的兜底成短形式。 */
const labelOf = (rec, id) => {
  const n = rec && typeof rec.name === 'string' ? rec.name.trim() : '';
  return n || String(id);
};

/** 排序 + 截断（同名字的按 value 稳定排序，保证判据可复跑）。 */
const finish = (list) => list
  .filter((x) => x && typeof x.value === 'string' && x.value)
  .sort((a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value))
  .slice(0, QUICK_ARG_OPTION_CAP);

/**
 * 🆕 2026-10-08（用户实测）：**把参数字符串翻成显示名** —— 选的时候是名字，发出去/气泡里却是编号
 * （`我玩 egirShip`／`请给我 char_350_surr`）⇒ 一般玩家看不懂。
 * **接收端**渲染时用这个把 id 换成本地可见的名字（⛔ 协议里永远只传 id，见 chatModel 的口径）。
 * @param {'bond'|'chess'|'mate'|'enemy'|null} kind
 * @param {string} value 协议里的那个 arg（id）
 * @param {{ data?: object, room?: object|null }} deps
 * @returns {string} 拿不到名字就**原样返回 id**（宁可显示 id，也不要显示空白）
 */
export function argLabel(kind, value, deps) {
  const { data, room } = deps && typeof deps === 'object' ? deps : {};
  const get = typeof data?.get === 'function' ? (f) => data.get(f) : () => null;
  const v = value == null ? '' : String(value);
  if (!v) return '';
  if (kind === 'bond') return labelOf(get('bonds')?.[v], v);
  if (kind === 'chess') {
    const units = get('backups')?.units ?? null;
    if (units && units[v]) return labelOf(units[v], v);
    const chess = get('chess');
    const rec = Object.values(chess && typeof chess === 'object' ? chess : {}).find((r) => r && r.charId === v);
    return labelOf(rec, v);
  }
  if (kind === 'mate') {
    const seats = [...(Array.isArray(room?.seats) ? room.seats : []), ...(Array.isArray(room?.spectators) ? room.spectators : [])];
    const s = seats.find((x) => x && String(x.playerId) === v);
    return labelOf({ name: s?.name }, v);
  }
  if (kind === 'enemy') return labelOf(get('enemies')?.[v], v);
  return v;
}

/** 一条 chess 记录是否"玩家可能看到"（**唯一一处定义**，候选/阶级/盟约都问它）。 */
export function isChessVisible(rec) {
  return !!rec && rec.visible !== false && rec.isHidden !== true;
}

/**
 * 🆕 2026-10-08（A 给的数据源）：**本局会出现的敌人 key** —— `data/waves.json[stageId].spawns[].key` 去重
 * ＋ `bossId`（若非 null）。
 * ⚠️ 口径来自 A（逐字）：「`data/stages.json` 不列敌人（只有 rows/tiles/size/modes）——别在那儿找；
 * `data/enemies.json`（249 条）是全量键空间：够校验"这个 key 存在吗"，但**"本局会不会出现"只有 waves.json 说得准**。」
 * @param {object} waves `data/waves.json`
 * @param {string|null} stageId 本局舞台（客户端 = `pub.stageId`）
 * @returns {string[]} 空数组 = 拿不到舞台/该舞台没 spawn ⇒ **如实空**（面板据此不可点）
 */
export function enemyKeysForStage(waves, stageId) {
  const rec = stageId && waves && typeof waves === 'object' ? waves[String(stageId)] : null;
  const out = new Set();
  for (const s of Array.isArray(rec?.spawns) ? rec.spawns : []) {
    const k = s && s.key != null ? String(s.key) : '';
    if (k) out.add(k);
  }
  if (rec && rec.bossId != null && rec.bossId !== '') out.add(String(rec.bossId));
  return [...out].sort();
}

/**
 * 🆕 2026-10-08 三级选择的第 1 步：**有可见干员的阶级**（升序）。 */
export function chessTiers(chess) {
  const s = new Set();
  for (const rec of Object.values(chess && typeof chess === 'object' ? chess : {})) {
    if (!isChessVisible(rec)) continue;
    const tier = Number(rec.tier);
    if (Number.isFinite(tier)) s.add(tier);
  }
  return [...s].sort((a, b) => a - b);
}

/** 🆕 第 2 步：该阶级的可见干员涉及到的**盟约**（排序稳定）。 */
export function chessBondsInTier(chess, tier) {
  const s = new Set();
  for (const rec of Object.values(chess && typeof chess === 'object' ? chess : {})) {
    if (!isChessVisible(rec)) continue;
    if (tier != null && Number(rec.tier) !== Number(tier)) continue;
    for (const b of Array.isArray(rec.bonds) ? rec.bonds : []) s.add(b);
  }
  return [...s].sort();
}

/**
 * 某一类参数的候选项。
 * @param {'bond'|'chess'|'mate'|'enemy'|null} kind
 * @param {{ data?: { get?: Function, lookup?: Function }, room?: object|null, pub?: object|null,
 *   tier?: number|null, bond?: string|null }} deps
 *   `tier`/`bond` 只对 `chess` 生效 —— 三级选择（阶级 → 盟约 → 干员）靠它收敛。
 * @returns {Array<{ value: string, label: string }>} 空数组 = 这一条现在没有可选值（面板据此保持禁用）
 */
export function quickArgOptions(kind, deps) {
  // ⚠️ `deps` 可能是 `null`（调用方还没拿到数据）⇒ **不能直接解构**（`const {data} = null` 会抛）
  const { data, room, pub, tier = null, bond = null } = deps && typeof deps === 'object' ? deps : {};
  const get = typeof data?.get === 'function' ? (f) => data.get(f) : () => null;
  const lookup = typeof data?.lookup === 'function' ? (f, id) => data.lookup(f, id) : () => null;

  if (kind === 'bond') {
    const off = new Set([...(Array.isArray(pub?.disabledBonds) ? pub.disabledBonds : []),
      ...(Array.isArray(pub?.drawnDisabledBonds) ? pub.drawnDisabledBonds : [])]);
    const bonds = get('bonds');
    return finish(keysOf(bonds).filter((id) => !off.has(id)).map((id) => ({ value: id, label: labelOf(bonds[id], id) })));
  }

  if (kind === 'chess') {
    // 🔴 2026-10-08 改（用户实测"灰色的那几个要落实"）：候选改用 **`chess` 表**（商店里出现的干员就是它）。
    //   为什么不用 `diy.ownedPool`：那是 **char id** 且与 `chess` 的 `charId` **交集 0**（实测，见
    //   `.workbuddy/tools/_b12-markcard-rule.mjs`）⇒ 拿它当候选**一个都选不出来**。
    //   **值＝`rec.charId`**（A 定的口径：`need` 的 arg 是干员 charId），标签＝干员名（拿不到就用 id）。
    const chess = get('chess');
    const units = get('backups')?.units ?? null;
    const seen = new Set();
    const list = [];
    for (const [id, rec] of Object.entries(chess && typeof chess === 'object' ? chess : {})) {
      if (!isChessVisible(rec)) continue;
      if (tier != null && Number(rec.tier) !== Number(tier)) continue;                       // 第 1 步：阶级
      if (bond && !(Array.isArray(rec.bonds) ? rec.bonds : []).includes(bond)) continue;      // 第 2 步：盟约
      const value = rec.charId || id;
      if (seen.has(value)) continue;
      seen.add(value);
      list.push({ value, label: labelOf(units?.[value] || rec, value) });
    }
    return finish(list);
  }

  if (kind === 'mate') {
    const seats = Array.isArray(room?.seats) ? room.seats : [];
    const specs = Array.isArray(room?.spectators) ? room.spectators : [];
    const list = [];
    const seen = new Set();
    for (const s of [...seats, ...specs]) {
      const pid = s && s.playerId != null ? String(s.playerId) : '';
      if (!pid || seen.has(pid)) continue;
      seen.add(pid);
      list.push({ value: pid, label: labelOf({ name: s.name }, pid) });
    }
    return finish(list);
  }

  if (kind === 'enemy') {
    // 🆕 2026-10-08（A 给的数据源）：**本局会出现的敌人** —— 只有 `waves.json` 说得准（`enemies.json` 是全量键空间）。
    const keys = enemyKeysForStage(get('waves'), deps && typeof deps === 'object' ? deps.stageId : null);
    return finish(keys.map((k) => ({ value: k, label: argLabel('enemy', k, { data }) })));
  }

  // 未知类别：**如实返回空**（⛔ 不编候选）
  return [];
}
