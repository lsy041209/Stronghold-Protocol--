# content-packs/ — 干员 / 敌人内容包

这个目录是**给游戏加干员和敌人的唯一正规入口**。

`data/chess.json`、`data/enemies.json` 和 `data/bonds.json` 都是由 `tools/build-data.mjs` 从明日方舟官方客户端表生成的**产物**——手改会在下一次
`npm run build-data` 时被覆盖，而且模拟器会拒收字段不对的记录。内容包把「加人」变成一件可校验、可重复、可撤销的事：

```
content-packs/
  my-pack.pack.json      ← 你写的（本目录只放 *.json）
```

> 本目录默认是**空的**。示例内容包在 `数据解析/模板化/examples/示例内容包.pack.json`，不会被自动加载
> ——想看一份填好的完整例子就直接校验它：
> `node .workbuddy/tools/content-packs.mjs check 数据解析/模板化/examples`

---

## 快速开始

```bash
# 1) 生成骨架（自动填好 id、技能 id、精锐框架，并带上逐字段中文注释）
node .workbuddy/tools/content-packs.mjs new chess chess_myop_a
node .workbuddy/tools/content-packs.mjs new enemy enemy_myfoe

# 2) 改字段（注释都在文件里；字段含义见 数据解析/模板化/01-干员字段规范.md ）
#    以 _ 开头的键都是注释（嵌套的也算，例如 stats._res），写进 data/ 时会被丢弃

# 3) 只看不写（也可以直接给目录，会展开成里面的所有 *.json）
node .workbuddy/tools/content-packs.mjs list
node .workbuddy/tools/content-packs.mjs check
node .workbuddy/tools/content-packs.mjs check 数据解析/模板化/examples

# 4) 合并进 data/（幂等：重复跑没有副作用）
npm run build-data                                   # 重新生成基础数据（会清掉内容包）
node .workbuddy/tools/content-packs.mjs apply

# 5) 后悔了（三个文件一起还原：chess / enemies / bonds）
node .workbuddy/tools/content-packs.mjs revert
```

`apply` 之后跑一次 `node tools/doctor.mjs` 和 `npm test` 确认没破坏别的东西。

---

## 命令

| 命令 | 作用 |
|---|---|
| `list` | 列出本目录的内容包、每个加了什么、校验状态（`list --from <目录或文件>` 看别处的） |
| `check [文件或目录…]` | 只校验不写入；有错就退出码 1。传目录会展开成里面的 `*.json`；顺带报告盟约成员表漂移（也是退出码 1） |
| `new chess <chessId>` | 从「干员模板」生成骨架，`chessId` 形如 `chess_myop_a`（精锐 `_b` 自动派生） |
| `new enemy <enemyKey>` | 从「敌人模板」生成骨架，`enemyKey` 形如 `enemy_myfoe` |
| `apply [--out <dir>] [--force] [--from <path>]` | 校验并合并进 `data/`（`--out` 写到别处、`--force` 允许覆盖不属于内容包的记录） |
| `revert [--out <dir>]` | 删除所有带 `pack` 标记的记录，并把这些 id 从盟约成员表里摘掉，恢复到生成态 |

---

## 内容包格式

```jsonc
{
  "pack": "my-pack",        // 小写 id，[a-z0-9._-]
  "version": 1,             // 自身版本
  "targetBase": "0.1.2",    // 针对的游戏版本（仅记录，不强制）
  "note": "一句话说明",       // 可选
  "chess":   [ /* 干员记录，见 干员模板 */ ],
  "enemies": [ /* 敌人记录，见 敌人模板 */ ]
}
```

**先写普通干员，精锐不用再写一遍。** 加一个 `elite: { … }` 块写「和普通哪里不一样」，工具会：

* 派生 `_b` 记录（`baseId` / `goldenId` 互指、`isGolden: true`；普通那条会被显式写成 `isGolden: false`）
* 把普通的 `stats` / `trait` / `talents` 复制成 `statsBase` / `traitBase` / `talentsBase`（这样「不装备模组」才有基准值）
* **算出**精锐的 `stats` / `trait` / `talents`，用的是游戏自己的合成规则
  （`shared/loadoutRecord.js` 的 `composeStats` / `composeTalents`，`test/data.test.js` 会逐条断言）：
  `stats = statsBase + 默认模组的 attr`、`trait = 默认模组的 traitOverride ?? traitBase`、`talents = composeTalents(talentsBase, 默认模组的 talentChanges)`
* 把 `status` 改成 `phase 2 / level 50 / skillLevel 7 / equipLevel 1`
* 从 `modules` 里挑默认模组，写成 `module` 字段（没有模组时写 `{id:null,…,active:false}`）
* 补齐技能与天赋的 `index`（游戏按 `index` 选技能档位），精锐的技能 `level` 写 7

> ⚠️ **不要在 `elite` 里写 `stats` 或 `talents`。**
> 写了 `stats` 会被当成覆盖值——如果你的手算和 `statsBase + attr` 不一致（例如写成 1560/548，而
> 1200+80 / 420+22 只有 **1280/442**），游戏自带的 `test/data.test.js` 会当场报错。
> 想给精锐加一条专属天赋，正确写法是默认模组的
> `"talentChanges": [{ "talentIndex": -1, "name": …, "desc": …, "descRaw": …, "bb": {…}, "bbStr": {}, "hidden": false }]`
> （`talentIndex: -1` = 新增一条；写已有的下标 = 改那一条）。`elite.talents` 里凭空多出来的天赋会被校验器拒绝。
>
> ⚠️ 模组 id 必须形如 `uniequip_<三位数字>_<名字>`（游戏自带测试按这个格式断言）；`999` 留给自制模组，
> 官方数据目前只用到 002–004。

---

## 安全边界

* **只增不改。** 一条已存在、且没有 `pack` 标记的记录，`apply` 会拒绝覆盖并告诉你是哪一条。确实要覆盖才加 `--force`。
* **幂等。** 每条合并进来的记录都带 `"pack": "<你的 pack id>"`，第二次 `apply` 不会产生任何字节变化。
* **盟约成员表自动同步。** 新干员填了 `bonds: [...]`，工具会把它的 id 补进 `data/bonds.json` 对应盟约的
  `members` / `visibleMembers`（`test/data.test.js` 双向断言这两处必须一致）；`revert` 时再摘掉。**不需要你手工改 `bonds.json`。**
  反过来说：如果 `bonds.json` 与干员记录本来就不一致，`apply` / `check` / `list` 会**报告**（不偷偷修），并让 `check`/`list` 退出码为 1 ——
  用 `npm run build-data` 重建数据层即可对齐。
* **可撤销。** `revert` 删掉所有带标记的记录，并把它们从盟约成员表里摘掉：`data/chess.json`、`data/enemies.json`、
  `data/bonds.json` 三个文件都与生成态**逐字节**一致。（守卫测试用真实的 `revertPacks` 证明了这一点。）
* **先校验再写。** 任何一个包校验失败，**一个字节都不会写**（不会写半个包）。
* **加人会动到两个断言。** `test/data.test.js` 断言「112 个可见干员 / 266 条干员记录」；`apply` 时工具会提示你同步。
  不想动就先把新干员设为 `"visible": false` 并 `"isHidden": true`（只做数据、不进商店池）。

---

## 相关文档

| 文件 | 内容 |
|---|---|
| `数据解析/模板化/README.md` | 模板化总览与三条工作流 |
| `数据解析/模板化/01-干员字段规范.md` | 干员每个字段：含义、类型、取值、示例（攻击方式 / 攻击范围 / 攻击力 / 技能效果…） |
| `数据解析/模板化/02-敌人字段规范.md` | 敌人每个字段：同上 |
| `数据解析/模板化/schema/*.schema.json` | 同一份规范的 JSON Schema（给编辑器补全/CI 用） |
| `数据解析/模板化/examples/示例内容包.pack.json` | 一份填好的完整例子 |
| `Stronghold-Protocol/docs/DATA.md` | 上游产物格式权威文档（生成器视角） |
