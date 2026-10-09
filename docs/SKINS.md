# 干员皮肤 (Operator skins) —— **我们的内置版实现**

> 引渡自上游分叉 `Paper-Yuan/Stronghold-Protocol@0.1.6-pre-skin`（B站 @纸鸢安好 的适配），2026-10-06。
> ⚠️ **本文件描述的是我们树里的实现，与上游那份文档口径不同，别照抄上游**：
>
> | | 上游 `0.1.6-pre-skin` | **我们（本树）** |
> |---|---|---|
> | 形态 | **按需安装**：`tools/install-skins.mjs` + `server/skinInstall.js`，游戏里点「安装」按钮现拉 7 个文件 | **全量内置**：174 套的 180×180 头像随仓库提交，进游戏即可换 |
> | `data/skins-installed.json` | 初始为空，只有 installer 往里加 | **174 条，一个不少**（"内置"这个开关只有这一个文件） |
> | 素材来源 | 运行时从 GitHub 现拉（实测大陆线路 ~35 KB/s，全量要一小时以上） | 头像**已在仓库里**；骨骼模型用 `tools/fetch-skin-spines.mjs` 离线抓 |
> | `data/assets.json` 怎么来 | `inject-skins-assets.mjs` 后处理注入 | **`tools/assets/plan.mjs` 原生产出**（见下 §3 的理由） |
> | 我们树里有没有 installer | —— | **没有**，也**故意不要**：见 §3 |

---

## 1. 怎么跑通的（数据流）

```
docs/research/08-skins.json            上游有什么：174 套 / 115 名干员（静态普查表，build 期不抓）
   │
   ├── tools/build-skins.mjs ────→ data/skins.json        客户端读的**目录**：id / name / group。
   │                                                      不含 URL —— 没装的皮肤没有文件可指。
   │
   └── tools/assets/plan.mjs ────→ chars[charId].skins[skinId] = { name, group, avatar, spine? }
            ↑ 读 08-skins.json                       （buildPlan 的 skins08 入参）
            └── npm run assets（tools/fetch-assets.mjs）把它解析进 data/assets.json

玩家选皮肤 ──→ room.skins ──→ PlayerState.skins ──→ Match.publicView().players[].skins   （PUBLIC：队友当场看得见）
                                    │
                                    └── battleInput() u.skin ──→ snapshot ──→ 渲染层 ──→ spineEntry(m, id, { skin })
```

## 2. 三条承重性质（搞错哪一条都静默）

1. **皮肤「选择」按 chessId 存，皮肤「目录 / 素材清单」按 operator id 分组。**
   chess 记录长这样：`chess_char_1_01_a`，它带 `charId: char_498_inside`。两者混用**不报错**：
   选择器渲染出一个空段，而 `setSkins` 把每一条都丢掉。
2. **皮肤模型必须走 build 期 spine 管线。**
   `resolveRoles()` 在 `tools/assets/spine.mjs` 离线跑，客户端 `validSpine()` 要的是它产出的 `anims`。
   跳过这一步的模型加载不了，单位会**永远停在占位头像**上 —— 不看到棋盘根本发现不了。
3. **`snapshot.js` 里必须是 `skin: u.skin ?? undefined`，不能是 `null`。**
   `JSON.stringify` 会丢掉 `undefined` ⇒ 没皮肤的玩家，线格式**逐字节不变**，`DESIGN §8.2` 的契约测试才过得去。
   写成 `null` 会给每条 unit 凭空多一个键。

## 3. 为什么 `data/assets.json` 走 `plan.mjs` 原生，而不是上游那个后处理脚本

上游的 `tools/inject-skins-assets.mjs` 把头像路径**硬编码**成字符串：

```js
const avatarUrl = fs.existsSync(localAvatar) ? `/assets/char/skin_avatar/${stem}.png` : (s.avatar?.url || null);
```

**这在本工作区会翻车。** 本树把 `public/assets` 整体转成了 WebP（`convert-assets.py`，约小 70%），
写死的 `.png` 在转换之后会**全部 404** —— 正是 **2026-10-05 那次「全站图标退化成文字」** 的失败模式
（`MEMORY.md` 规则 10 / 18）。

所以我们改成在 `tools/assets/plan.mjs` 的 `buildPlan()` 里原生产出（`skins08` 入参）：

```js
const avatar = leaf(alt(`char/skin_avatar/${stem}.png`, s.avatar?.url, s.avatar?.bytes));
```

交给 `tools/assets/manifest.mjs` 的 `resolveTemplate()` → `actualRel()` 解析，它会先找原 `rel`、
再找 `.webp` 兄弟文件 ⇒ **`.png` / `.webp` 两种落盘形态都能命中**，永远不会因为一次格式转换而全灭。

> 于是 `tools/inject-skins-assets.mjs` 在我们树里**是备用/对照用的，正常流程不需要跑它**。
> 两种做法产物等价（实测 `stats.skins = 174`），但只有一条对格式转换免疫。
>
> **验收判据**（探针，不是"看着对"）：
> ```
> node .workbuddy/tools/probe-skin-assets.mjs      # 拿真实 plan + 真实 public/assets 跑 resolveTemplate
> ```
> 它逐条断言 ①计划里 174 套 ②每套的 avatar 都解析出字符串 ③解析出的 URL 在磁盘上存在 ④原皮叶子没被弄坏。

## 4. 新文件

| 路径 | 是什么 |
|---|---|
| `docs/research/08-skins.json` | 静态研究表：`{ meta, skins: { [charId]: [{ skinId, stem, name, group, avatar, battleSpine }] } }` |
| `tools/build-skins.mjs` | `docs/research/08-skins.json` → `data/skins.json` |
| `data/skins.json` | 客户端读的目录（无 URL）：115 干员 / 174 套 |
| `data/skins-installed.json` | 哪些 skinId 是内置的 —— **"全量内置"的唯一开关**，现在是 174 条 |
| `public/assets/char/skin_avatar/*.png` | **174 张 180×180 头像（约 11 MB，已随仓库提交）** |
| `tools/fetch-skin-avatars.mjs` | 补抓 / 换源头像（正常情况下用不到，头像已在树里） |
| `tools/fetch-skin-spines.mjs` | 离线抓战斗骨骼：`spine/op/<charId>/<stem>/{front,back}/{skel,atlas,png}`，可断点续传 |
| `tools/inject-skins-assets.mjs` | 上游的后处理注入器 —— **备用/对照**，正式流程走 `plan.mjs`（见 §3） |
| `public/js/ui/skins.js` | 客户端状态：localStorage 选择 + `room.skins` 同步（PUBLIC） |
| `public/js/ui/skinPicker.js` | 调配页「换装」子标签页的选择器（自包含；`screens/loadout.js` 只点名它一行） |
| `test/skins.test.js` | 皮肤守卫 5 条（目录映射 / 导入语义 / 素材回退 / 协议校验） |
| `test/skins-manifest.test.js` | **清单守卫（我们的）**：174 套都在 `assets.json` 里 + 每条引用都落盘 |

## 5. 对既有文件的改动（一行一行列出来，方便合并上游发布）

| 文件 | 位置 | 改了什么 |
|---|---|---|
| `shared/protocol.js` | `isId` 之后 | `SKIN_LIMITS` / `isSkinId` / `isSkinSelection`。**`isSkinId` 不能用 `isId`**：那个只允许 `[A-Za-z0-9_\-.:]`，而 skinId 带 `@` 和 `#` |
| `shared/protocol.js` | `C2S` 表 | `'room.skins': { skins: isSkinSelection }` |
| `server/lobby.js` | `freezeLoadout` 之后 | `freezeSkins()` —— 与 `checkLoadout` 同一道闸（`isGolden` / `visible === false` / `isHidden` / `isDiy` / `baseId !== id`） |
| `server/lobby.js` | `onMessage` | `case 'room.skins'` |
| `server/lobby.js` | `loadout()` 之后 | `skins()` —— **没有阶段闸门**（与 loadout 相反：换装是纯外观且公开），战斗中也能改 |
| `server/lobby.js` | `humanSeat()` / `startMatch()` | session→seat→`new Match()` 一路带上 `skins` |
| `server/match/Match.js` | `setLoadout` 之后 | `setSkins()` —— 任意阶段，`markPublic()` |
| `server/match/Match.js` | `publicView().players[]` | `...(Object.keys(ps.skins).length ? { skins: ps.skins } : {})` —— 空则整个键省略，没皮肤的人载荷不变 |
| `server/match/Match.js` | 侦察视图 units | `skin: piece.kind === 'chess' ? (ps.skins?.[rec?.baseId \|\| piece.id] \|\| ps.skins?.[piece.id]) : undefined` —— baseId 优先，升金后不丢皮肤 |
| `server/match/PlayerState.js` | 构造器 | `this.skins = Object.freeze({})` + 从 `seat.skins` 恢复 |
| `server/match/PlayerState.js` | `setLoadout` 之后 | `setSkins()` —— bot 拒绝；同一道闸；`dirty()` |
| `server/match/PlayerState.js` | `battleInput()` | `const baseId = (this.gd.chess(piece.id) \|\| {}).baseId \|\| piece.id;` + `if (skin) u.skin = skin;` |
| `server/match/PlayerState.js` | `pieceView()` | 带 `skin`（有值才加键） |
| `server/sim/snapshot.js` | `unitInfo()` | `skin: u.skin ?? undefined` —— **必须是 `undefined`**（见 §2.3） |
| `public/js/data.js` | `DATA_FILES` | `skins: 'skins.json'` |
| `public/js/ui/gameComponents.js` | `GAME_FILES` | `'skins'` —— 进房间后与其它数据一起预取 |
| `public/js/main.js` | 启动 | `installSkinsSync({ net })` + `data.load('skins')` |
| `public/js/assets.js` | `avatarUrl` / `spineEntry` / `hasBackSpine` / `unitPictureUrl` | 接受 `opts.skin`：皮肤自己的头像/骨骼优先，**缺则回退原皮**（`str(skin.avatar)` 这个守卫是承重的，见 §7） |
| `public/js/render/units.js` | `_loadPicture` / 骨骼 / 背面 | 把 `this.info.skin` 透传下去，并让贴图缓存键带上皮肤（否则换装不重绘） |
| `public/js/render/app.js` | `renderInfo` / `pieceInfo` / `_sig` | 填 `skin`，且 `_sig` 混入 skin 才会真的重绘 |
| `public/js/ui/loadoutModel.js` | 存储与导入导出 | `sanitizeSkins` / `mergeSkins`；`exportPayload(…, { skins })`、`parseImport` 带回 `skins` |
| `public/js/screens/loadout.js` | `Detail()` | **技能 / 模组 / 数值 / 换装 四个子标签页**（`.lo-dtabs`），换装页挂 `<${SkinSection}>` |
| `public/css/screens/loadout.css` | 标签栏 + 末尾 | `.lo-dtabs` / `.lo-dtab` + `.lo-skin*`（**单行垂直列表**：一款皮肤独占一行，左头像、中名称与系列、右状态标签；兼容旧机型 Chromium 80–84） |
| `data/assets.json` | — | 重建后带 `chars[charId].skins`（由 `plan.mjs` 产出，不是后处理） |

## 6. 重建素材侧（我们的命令）

```
node tools/build-skins.mjs                    # docs/research/08-skins.json → data/skins.json
node tools/fetch-skin-avatars.mjs             # 补抓/换源头像（正常不用跑：174 张已在树里）
node tools/fetch-skin-spines.mjs              # 抓战斗骨骼（见 §7 的"待做"）
npm run assets                                # 重建 data/assets.json（皮肤头像由 plan.mjs 原生带出）
node .workbuddy/tools/probe-skin-assets.mjs   # 验收：174 套都解析得到、且 URL 真在磁盘上
node --test test/skins.test.js test/skins-manifest.test.js
```

命名规则两条，都实测过：

```
stem   = skinId.replace(/@/g, '_').replace(/#/g, '_')      char_002_amiya@winter#1 → char_002_amiya_winter_1
avatar = 'avatar/' + encodeURIComponent(avatarId) + '.png'  avatarId 来自 skin_table，**不是**从 skinId 推的
```

整套皮肤立绘（`skin/{portraitId}b.png`）**故意不用**：每张 ~2.5 MB，174 张要多 ~435 MB —— 比其余全部素材加起来还大，只为一张缩略图不值。

上游素材源：`fexli/ArknightsResource`（`spine/{charId}/{stem}/{Front,Back}/` 骨骼）、
`yuanyan3060/ArknightsGameResource`（`avatar/{avatarId}.png` 头像）、Kengxxiao 的 `skin_table.json`（名称与系列）。

## 7. 已知边界与待做

- ✅ **皮肤骨骼已落地**（2026-10-06）。`public/assets/spine/op/<charId>/<stem>/{front,back}/{skel,atlas,png}`
  —— 实测 **1029 文件 / 167 MB**，**169/174 套** front+back×3 齐全，**5 套缺 back**
  （`char_4134_cetsyr_epoque_50` / `char_291_aglina_boc_1` / `char_291_aglina_summer_5` /
  `char_1012_skadi2_boc_4` / `char_1012_skadi2_iteration_2`）⇒ 那 5 套的背面回退原皮（`hasBackSpine(…, skinId)`）。
  ⚠️ **骨骼必须登记成 model，不能只写 URL**：`tools/assets/spine.mjs` 的模型阶段会
  ① `normalizeAtlas()` 把 `size: W,H` 补进 `.atlas` **并写回磁盘**（缺它 `test/assets.test.js` 的
  「every atlas on disk has size: lines」直接红，客户端也定位不到切片），② `resolveRoles()` 算 `anims`
  （客户端 `validSpine()` 要求），③ 关联 skel/atlas/png。皮肤与本体**共用同一套 `skillIndices`**，否则皮肤
  自己的 skill 片段会被当未知动画丢掉。
- ⚠️ **`data/assets.json` 的皮肤 `spine` 目前来自 `tools/inject-skins-assets.mjs`（注入脚本）**，
  原生那条路（`plan.mjs` 的 `skins08` 块）**代码已就绪但还没产出过清单** —— 因为
  `node tools/fetch-assets.mjs --offline` 会**拒绝写**一份比现状小的清单（安全网按设计生效：
  当前清单里有别的会话更新的条目，例如 `skills.skchr_chen3_*`、`tokens.token_10064_wang_stone1.*`）。
  ⇒ 需要**一次整包重建窗口**让原生路径产出；在那之前注入脚本那条路是可用的。
- **没有皮肤特效。** 官方逐角色战斗特效是 `.ab` 粒子包，本项目不抽取（见 `docs/ASSETS.md`）；战斗 FX 仍是程序化的。
- **没有干员语音。** 独立的一块工作（上游也把它列为独立项）；文件存在（`ArknightsAssets2` 的 `voice` 分支），
  但我们树里 `public/js/audio.js` 还没有 `voice()` 与事件映射。⇒ 见 `归档/上游分叉-0.1.6-pre-skin/`。
- **Bot 永远穿原版**（`setSkins` 拒绝 bot，与 `setLoadout` 一致）。
- **旧 Android WebView 适配**：`public/js/ui/compat.js` 补了 `String.prototype.replaceAll` / `Promise.any`
  （Chromium 85 才有）。⚠️ 注意：**我们树里没有任何地方调用这两个 API** ⇒ 这是**防御性补齐**，
  不是修实际崩溃。上游 CHANGELOG 说的「物理坐标回退」在他们自己的 Kotlin 外壳里，我们的外壳是 `nodejs-mobile` + Java，
  **结构不同、不可照搬**。
