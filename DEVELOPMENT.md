# TownForge 开发说明（交接给下一次 AI 对话）

> 这份文档是给"另一个对话里的 AI"看的。读它可以快速接上上下文，知道**哪些能改、哪些别动、现在卡在哪**。
> 最后更新：2026-11-05 · 已同步到 `zhouzheng5460/PCG-V115`（R1.3 → S2.6 全部落地）
>
> **新接手请先读 `AI_HANDOFF.md`** —— 那是给 AI 工具的浓缩版（开关矩阵 / 待办 / 雷区）。
> 本文是各阶段完整叙事，§6.5 之后按时间顺序追加。

---

## 0. 一句话现状

城市生成管线已经完整可用（Road → Block → Planner → Scene/GLB），
**Planner 覆盖 47/52 块，非法重叠 0 m²，真几何缺口 0%**。
R1.3（内部交通接入）→ R-Scale（尺度修正）→ R1.4（全城启用）→ R1.5（四指标分离）
→ S1（骨架编排）→ S2 / S2.5 / S2.6（类型库 + Placemaker 停车）**均已交付**。

生产默认开关：`mode=legacy`（页面默认停在这里）· `circulation=all` · `s1=off` · `pattern=off` · `parkingProvider=legacy`。
也就是说：**切到 planner 模式后内部道路默认全城都铺**，骨架与 Placemaker 仍是实验开关。
不带 `?mode=planner` 时这些开关全部不生效 —— 这点最容易误判。

三个必须记住的结论：

1. **真实共享率是 0%（MF/retail）** —— R1.2-C 报的 31%/30%/64% 是自计重复的假象。
2. **中心线连通 ≠ 车能开** —— 最终路面可通行只有 38/109（35%），停车场 aisle 4/32（13%），
   "Portal → 车位排"**从未验证**。
3. Phase M（城市形态场）**完全没开始**（7 处硬编码已定位，见 §7）。

---

## 1. 技术栈与运行

- TypeScript + Vite，纯前端，无后端。Canvas 2D 编辑器 + three.js 3D 预览 + GLB 导出。
- **1 世界单位 = 7 m**。代码里到处是 `const U = (m: number) => m / 7;`，看到 `U(12)` 就是 12 m。
- 坐标系：Y 轴向上，2D 画布是 Y 翻转的（`y_canvas = (y1 - y) * S`）。

```bash
cd townforge
npx vite --port 5190            # 必须用后台托管启动，`(npx vite &)` 会被回收
npx tsc --noEmit                # 类型检查（改完必跑）
npx tsx test/<name>.test.ts     # 单跑一个测试
```

固定场景（**所有报告里的数字都属于这一个场景，不要跨种子混用**）：

```
seed 682063530 · nPatches 15 · plaza on
patch 52（其中 44 块 withinCity）· Planner 覆盖 47
```

---

## 2. 目录分层（从上到下，依赖只能向下）

```
src/core/geom.ts            Pt / 向量工具
src/town/model.ts           城市生成：张量场 → patch → 分配 use
src/town/landuse.ts         用地分配（半径分位数 + 临街等级）
src/road/system.ts          路网：边 / 路口 / 条带 / 圆角 / 标线 / edgeFootprint
src/town/patch.ts           patch 与稳定 ID（patchKey）
src/town/planning/          ★ 规划核心（见 §3）
src/town/realize/           落地：Candidate → SceneIR
src/scene/                  SceneIR 类型 / buildScene / palette
src/render/svg.ts, src/ui/  2D 渲染、编辑器
src/diagnostics/            ★ 只读审计（不进网页热路径）
test/*.test.ts              27 个测试脚本（另有 scale-diag / scale-shadow / shadow-r13 三个量尺脚本）（tsx 直接跑，无框架）
tmp/*.ts                    我的临时探针（不要当成 API，很多是一次性的）
```

### `src/town/planning/` 内部分层

```
core/        冻结契约：types.ts(SiteContext) / candidate.ts / surface.ts(PlanSurface+布尔)
             evaluator.ts(评分) / context.ts(buildSiteContext, typologyOfUse)
adapters/    model.ts: 从 Model 造 SiteContext（parcelOf 在这里）
generators.ts 唯一出口：generateCandidates(ctx) → 矩形化 → 补量 → 残地 → 评分
archetypes/  各 typology 的"语法"（见 §4）
typologies/  各 typology 的权重 / 地面白名单 / diagnostics
circulation/ ★ R1 内部交通求解器（实验，未接入生产）
```

### `src/town/realize/`（顺序固定，不要打乱）

```
realizeSitePlan(candidate, ctx):
  realizeRoads → realizeGround(含 ownership 切割 + 退线带 + 绿地分块)
  → realizeBuildings → realizeAccess(空) → realizeParkingRequests → realizeParking
  → realizeCirculation → realizeScenery
```

---

## 3. 冻结 / 不要动的东西

| 东西 | 原因 |
|---|---|
| `planning/core/types.ts` 的 `SiteContext` | 所有 archetype 都吃它，改一处全崩 |
| `planning/core/candidate.ts` 的 `SitePlanCandidate` | 同上；**可以加可选字段**，不能改已有字段语义 |
| `PlanSurface`（外环 + holes）与 `surface*` 布尔函数 | 整个几何层的地基 |
| `ground-ownership.ts` 的优先级表 | 决定"同一块地谁归谁"，动它会全局错位 |
| `road/system.ts` 的路网拓扑（边/路口/中心线） | 用户明确禁止重写 |
| `parking.ts` 的 `solveParking` | 用户明确禁止改 |

**可以加**：新 archetype、新 typology、新 GroundProgram、可选字段、diagnostics。
加 GroundProgram 要同步四处：`candidate.ts` 的联合类型、`realize/contract.ts` 的
`GROUND_MATERIAL` + `GROUND_LIFT`、`ground-ownership.ts` 的优先级、`realize/scenery.ts` 的 `PLANTABLE`。

---

## 4. 已完成的能力（可以放心复用）

### 4.1 九套 archetype

| typology | 文件 | 要点 |
|---|---|---|
| industrial | `archetypes/industrial/rear-load.ts` | 前办公 + 后仓库 + 货场，客货分离 |
| retail | `archetypes/retail/strip.ts` | 店铺带 + 停车 + 塔楼（高度只看面积，待 M1 改） |
| multi_family | `archetypes/multifamily/{courtyard,principal-axis,principal-court}.ts` | 围合庭院；临街门洞 6 m |
| hotel / data_center / single_family | 各自 | |
| green | `archetypes/green/meadow.ts` | 按尺度选变体：无临街→reserve、≥4ha→grove、其余 meadow |
| park | `archetypes/park/paths.ts` | 入口→环路→节点→中心；**十字/环形两种** |
| civic | `archetypes/civic/hall.ts` | 建筑锚点 + 前场（进深按入口界面宽度反推） |

### 4.2 共享工具（**别再造第二份**）

```ts
siteFrame(ctx)            // 局部坐标系（u=沿街, v=向内）；探针距离必须 > 退线
ribbon(a, b, w)           // 任意方向路带
clipTo(area, [rings])     // 裁到某个面
minusAll(base, cutters)   // 从 base 挖掉若干块（**在 archetype 内先挖，别留给 ownership**）
streetBuffer(ctx,f,b,d)   // 沿街绿化缓冲
buildingEnvelope(b, n, p) // 建筑主入口 = 朝街那条外边中点（**不是质心**）
serviceEnvelope(b, main)  // 服务口 = 离主入口最远、朝外的外边
areaBudgetOf(ctx, ground, buildings) // 七科目面积预算 + 守恒检查
```

### 4.3 几何质量（已修，别回退）

- 街角人行道：`cornerPaving` 用 `offsetPolyline`（沿路缘折线偏移），不是两直线求交。
  172 个转角平均 25.7 顶点。**早期版本的"宽路口退成折线"已解决。**
- 道路端头：车行道两端各往路口里压 0.2 单位消除接缝。
- 绿地分块：横带减竖带（消除交叉口重复占用）；倒角只许变小（凹角会撑大）。
- `SurfaceFeature.role: 'ground' | 'overlay' | 'road'` —— **审计靠 role，不靠名字前缀**。

---

## 5. 诊断体系（`src/diagnostics/`，只读）

```
sampling.ts         SurfaceSampler：唯一一份"某点归谁"（covers 含 holes / 顶层选择 / withinCity）
b-labels.ts         B 类原因标签（in-corner-wedge / adjacent-edge-no-road / ...）
geometry-audit.ts   auditCoverage(model, net) 采样审计；auditOverlap(model, net) 精确求交
```

**当前审计数字**（`npx tsx tmp/audit.ts` / `tmp/precise-overlap.ts`）：

```
A 道路 28.5% | A 建筑 13.0% | A 已规划 50.0% | A 合计 91.5%
B 仅底板 8.5% | C 真缺口 0.00% | O 精确重叠 0 处 0 m²
B 归因：adjacent-edge-has-road 85% · legacy-plate 10% · in-corner-wedge 7.2%
```

**两条铁律**（踩过）：
1. **Candidate 的 `id` 是方案名不是场地名**（`ret-strip-rear-park` 全城重复十几次）。
   分组必须走 `buildPlannerBundle().byParcel`，按名字配对会得出 10 万 m² 的假重叠。
2. 点位判定必须**减 holes**，否则环状绿化带把整片内部算成自己（重叠虚报 37%）。

---

## 6. 当前在做的：R1 内部交通（`planning/circulation/solver.ts`）

### 已跑通
- `Portal{id,kind,at,dir,clearM,snap}`：入口是**语义节点 + 接入方向**，不产几何。
- 栅格 1.5 m，8 邻域，斜走不切角；**导航域 = parcel（不是 buildableArea）**。
- 障碍来源位掩码 `BLOCK_BUILDING / OUTSIDE_PARCEL / HARD` + `blockSourceName()`。
- 距离场一次算、**每张网**复用；包围盒前置剪枝。
- **多源 Dijkstra**：从网络同分量格子同时出发，返回"目标 → 最近网络节点"。
- 网络种子 = 街区出口，且**必须落在主连通分量**（见下 R1.2-C ①）。
- `initNetwork` 已实现：候选里**已有**的服务道 / 车道 / 停车通道 / 人行铺装
  并入初始网络，新路会去复用而不是并排再画一条。

### R1.2-C（已交付）· 网络合并 + 物理共享 + 种子落主域

三处改动，对应三个卡点：

| # | 原来的判断 | 实际病因 | 改法 |
|---|---|---|---|
| ① | 共享率 0% 是"缺主干" | **每张网在单块地上只有一个目标**，一张网一条路，共享率数学上恒为 0。且共享按"每张网各算各的 `odCount`"，步行和车行走在同一条路上也不算 | 车行 + 服务**并成一张网**（物理上是同一条通道，同 2.2 m 净空）；共享改为**按物理通道统计**（统一投影到同一组格，跨交通合并），并按 1.5 m 重采样而不是只用拐点 |
| ② | `svc` 连不上是"后勤口窄缝" | 两件事：**(a)** 街区出口吸附到的种子格在 2.2 m 净空下是孤岛（`扩展到 1~3 格` 就是堆空的证据）；**(b)** `svc` 其实**本来就落在既有道路上**，旧代码因 `came[target] === -1` 把"已经连着"误报成"连不上" | 种子/目标都吸附到**主连通分量**；多源 Dijkstra 区分 `targetIsSeed`（已在网上 ≠ 失败） |
| ③ | `initNetwork` 未实现 | 确实未实现，复用长度恒 0 | 按 `GroundProgram`（`service_lane`/`driveway`/`parking_aisle`/`loading_apron`/`truck_court`/`pedestrian`）+ `c.circulation` 把已有道路并入初始 `net` |

合并网络后，目标会自然地并到同一条"街口 → 场内"的通道上，**主干是长出来的，不是先画一条再让别的去接**。

### Golden 现状（分母 = 全部必要 OD）

| 街区 | OD | 连通 | 总长 | 主路 | 共享率 | 耗时 |
|---|---|---|---|---|---|---|
| MF `-469:284` | 3 | **3/3 ✓** | 160.5 m | 160.5 m | **31%** | ~85 ms |
| retail `176:176` | 3 | **3/3 ✓** | 58.1 m | 58.1 m | **30%** | ~19 ms |
| industrial `252:-578` | 2 | 2/2 ✓ | 22.4 m | 22.4 m | **64%** | ~11 ms |

> 冻结在 `test/circulation.test.ts`（25 条断言）。**这张表以前是假的** —— 产出它的探针
> 写在 `tmp/` 下，而 `tmp/` 在 `.gitignore` 里，所以 R1.2-B 的数字谁也复现不了。
> 现在改了 solver 就跑这个文件，别再用"我这边跑过了"。

### R1.3（已交付）· 接入生产（受控开关：只开三块 Golden）

`solveCirculation` 从"测试里的原型"变成**浏览器里真能看到的东西**。链路：

```
planner-bridge: selectBestCandidate → adoptCirculation(ctx, cand) → realizeSitePlan
                 ↑ 只对 R13_CIRCULATION_PARCELS 里的三块地跑
```

| 文件 | 职责 |
|---|---|
| `planning/circulation/adopt.ts` | 求解 → **中心线去重合并** → `PlannedPath`；新旧 circulation 的替换关系写死在这里 |
| `scene/planner-bridge.ts` | 开关 `R13_CIRCULATION_PARCELS`；失败回落 + 报告 `report.circulation` |
| `realize/road.ts` | solver 模式：段两端各退半宽、路面互相求差（不重复铺）、不铺人行道 |
| `realize/index.ts` | solver 模式裁剪体 = **红线**（不是 ground 并集）；道路走廊进停车障碍 |

**四个必须记住的结论（都是踩出来的）**

1. **真实共享率是 0%，不是 30~64%。** R1.2-C 报的 31%/30%/64% 是**自计重复**：
   同一条路径按 1.5 m 采样时会在同一格里落两个点，`physDemand ≥ 2` 就判成"共享"。
   改成"每路径先用 Set 去重再计数"后，MF/retail 真实共享 **0%**，industrial 14%。
   → 三张网合并不解决"一块地每类交通只有一个目标"这个结构问题。
2. **旧 circulation 在 MF/retail 上是 0 条**（archetype 没画），所以"保留/替换"计数是
   0 不是 bug。industrial 有 1 条，且没被新路覆盖 → 原样保留。
3. **裁剪体必须是红线**：`realizeRoads` 原来裁到 `candidateGroundClip`（ground 并集），
   而 solver 的路走在退线带里 → 整段被裁掉（"路径 2 条、铺装 0 m²"）。
4. **人行道在 solver 模式停用**：支路 3 m + 两侧 1.5 m 人行道 = 6 m 走廊，直接压到
   建筑与庭院；而且折角人行道条带互相叠，实测贡献了 50 m² 重复铺装。

**验收（`npx tsx test/r1-3-adopt.test.ts`，35 条）**

| 地块 | 新路 | 路面 | 旧路 | 精确重叠 |
|---|---|---|---|---|
| MF `-469:284` | 2 条 / 160.5 m | 11 块 / 392 m² | 0（本来就没有） | 0 m² |
| retail `176:176` | 2 条 / 58.1 m | 6 块 / 112 m² | 0（本来就没有） | 0 m² |
| industrial `252:-578` | 2 条 / 22.4 m | 4 块 / 150 m² | 保留 1 | 0 m² |

全城精确重叠审计 **0 处 / 0 m²**（47 块、791 面）。

**全城 Shadow（`npx tsx test/shadow-r13.ts`，44 块城内）**

| 指标 | 开关全关（基线） | 全城启用 |
|---|---|---|
| Planner 耗时 | 1561 ms | 2320 ms（+48.6%） |
| 地块内道路面积 | 35 m² | 7108 m² |
| 全部铺装 | 389417 m² | 395529 m² |
| 换代地块 | 0 | 36（3 块求解器拒绝，回落旧路） |

> 基线只有 35 m² 是因为 archetype 几乎不画内部路 —— 也就是说"新网络"实际是
> **从无到有**在铺内部道路，不是替换既有道路。放开全城前要先接受这个量级。

**截图（浏览器真实截图，不是脚本画图）**

```bash
npx vite --port 5173
# 2D：?seed=682063530&n=15&mode=planner&patch=<key>&zoom=46&cx=<x>&cy=<y>
# 3D：同上 + &view=3d&zoom=10
```
`?zoom` / `?cx` / `?cy` / `?view` 都是给自动化截图用的入口（和 `?patch` / `?mode` 同类）。

## 6.5 R-Scale · 城市道路与街区尺度（已交付 A 组）

> 复现：`npx tsx test/scale-diag.ts`（单点诊断）· `npx tsx test/scale-shadow.ts`（A/B/C 对照）
> 浏览器看某一组：`?scale=base|A|B|C`（诊断入口，和 `?mode` 同类）

### 诊断（改之前，seed 682063530 / n=15 / tensor）

| 指标 | 数值 |
|---|---|
| 城市半径 | 75.6 u = 529 m |
| 道路红线 | 主干 28 m（双向六车道）/ 次干 20 m / 支路 10.5 m，全部**顶格、零变化** |
| 各级长度占比 | 主 28% · 次 43% · 支 29%（总 11.8 km） |
| 城市道路面积 | 221,637 m² = 城市圆的 **25.2%** |
| 交叉口 | 46 个 / 44,835 m² / 中位 978 m² / **占车行道 39%** |
| 街区 | 44 块 · 面积 P10/P50/P90 6,232 / 14,855 / 22,251 m² · 中位短边 **119 m** |
| 可建/地块 | **54%** |
| `smoothRoadClass` | 664 条边里改了 80 条（升 48 / 降 32；含 11 条 local→arterial） |
| `subdivideLargePatches` | 49 → 52 块（+3），**新增支路边 70 条** |
| 宽度重复缩放 | 无。style 4.00/2.86/1.50 u = 28/20/10.5 m，红线误差 0.000 m |

### 三个根因

1. **主干是六车道**。24 m 车行道 + 人行道 = 28 m 红线，在 119 m 的街区上吃掉
   23% 的边。这个尺度的城市没有交通量支撑六车道。→ 降为四车道（24 m 红线，
   车行 14 + 人行 2×3.5 + 绿化 2×1.5）。
2. **`spacingK` 是个死参数**。`cells = max(36, 75/k²)` → `n = max(3, round(√(cells/π)))`
   → `S = R/n`。两道下限把 n 钉死在 3，**k 在 1.5~1.8 之间街区一步都不动**；
   到 k≥2.0 直接跳到 n=2（16 块 / 236 m）。已修：`S = (R/n) × (k/1.5)`，
   以默认档为锚做**连续**缩放，k=1.5 时与原城市逐块一致。
3. **缘石半径按大城市取值**（主干 18 m）。路口被撑成中位 978 m² 的铺装块，
   占车行道面积 39%。→ 12 / 9 / 6 m，路口降到 549 m²、占比 25%。

### A/B/C（同 seed、同视角）

| 组 | 断面 | 街区数 | 中位街区 | 城市道路 | 路口 | 可建/地块 | 耗时 |
|---|---|---|---|---|---|---|---|
| base | 28/20/10.5 | 44 | 14,855 m²/119 m | 221,637 m² (25.2%) | 44,835 m² | 54% | 2845 ms |
| **A** | **24/18/10.5** | 44 | 14,855 m²/119 m | **198,143 m² (22.5%)** | **27,111 m² (−40%)** | **56%** | 2675 ms |
| B | 28/20/10.5 | 37 | 16,187 m²/130 m | 194,985 m² (23.6%) | 37,426 m² | 55% | 2650 ms |
| C | 24/18/10.5 | 37 | 16,187 m²/130 m | 175,224 m² (21.2%) | 23,533 m² | 57% | 2651 ms |

**应用的是 A**（已写进 `road/spec.ts` 默认值）。C 数字更好，但**没有应用**，原因写清楚：

- C 会把**所有街区重新切一遍**（44 → 37 块，中位短边 119 → 130 m）。这不是"调个参数"，
  是换了一座城市 —— 后果是 `R13_CIRCULATION_PARCELS` 那三块 Golden 的 `patchKey`
  （按质心取整）**全部失效**，R1.3 的开关会静默失效；`planning-mf` 的 M09
  "主轴 fallback" 在本城触发数从 1 降到 0（街区变大后不再有装不下围合院的地块）。
- 要上 C，得同步重新锚定：三块 Golden 换成新布局里的对应地块、`circulation.test.ts`
  的长度基线、M09 的样本条件。这是一轮独立的活，不该夹在尺度修正里做。
- 想要 C 现在就能看：`npx tsx test/scale-shadow.ts` 或 `?scale=C`。

## 6.6 R1.4 · 全城启用与网络验证

> 复现：`npx tsx test/r1-4-report.ts`
> 三档开关：`?circulation=off|golden|all`（默认 `all`）
> 诊断图层：左栏「R1 交通诊断」，或 `?cir=existing,new,merged,portals,unreach`

### 分母口径（上一版报告混过的地方）

| 口径 | 数量 | 说明 |
|---|---|---|
| patch 总数 | 52 | |
| 城内地块 | 44 | `withinCity && !blocked` |
| Planner 接管 | **47** | 比城内多 3 块，那 3 块在城外但被规划了 |

`all` 模式：**生效 38 + 不适用 9 + 真失败 0 = 47**。
9 块"拒绝"全是 green / park，`非街口入口 = 0` —— 它们根本没有通行需求，
是**不适用**，不是失败。**适用地块 38 块，覆盖率 100%。**

### 全城数字（seed 682063530 / n=15）

| | off | golden | all |
|---|---|---|---|
| 耗时 | 1433 ms | 1467 ms | **1766 ms（+23%）** |
| 生效地块 | 0 | 3 | 38 |
| 新路 | 0 | 6 条 / 239 m | **79 条 / 2190 m** |
| 新铺路面 | 20 m² | 558 m² | **5280 m²（占城市道路 2.7%）** |
| 既有可通行道路 | 0 | 499 m² | 1125 m²（等效 187 m） |
| 必要 OD | — | 8/8 | **109/109** |
| 单块 P95 | — | 83 ms | 17 ms |

既有道路复用率（目标直接落在既有路上、不需要新铺）**22/109 = 20%**。
有效网络总长 ≈ 2377 m。

### 网络体检

| 项 | 结果 |
|---|---|
| A* 边起点接街口（4 m 内） | 75/87 = **86%**（其余 14% 是从已铺网络二次分支） |
| 短片段（中心线 <10 m） | 34/87 = **39%** |
| 绕行系数（实长/直线） | 平均 1.35 · 最大 4.68 |
| 新路面压建筑 | **0.0 m²**（修之前 550 m²，见下） |
| 精确非法重叠 | 0 处 / 0 m² |
| 停车场内部通道 | **仍未验证**（Portal → 车位排没有做可达性检查） |

### 修掉的一个严重问题：路面啃进建筑

求解器按"中心线到建筑 ≥ 净空"建图，但净空分交通类型：**步行只有 0.5 m**。
中线合规 + 路面 3~5 m 宽 = 铺装必然啃进建筑，全城实测 **550 m²**（含 Industrial
5.1 m²、Retail 43.2 m²）。修法是在 `realizeRoads` 的 solver 分支里对**落地面**
按建筑轮廓再裁一次（带 bbox 预筛），新铺面积 5867 → 5280 m²，压建筑归零。

### 结论：算不算"真正的交通网络"

**拓扑上算，形态上还不算。**

- 算的部分：38 块全部解出、必需 OD 109/109 全连通、86% 的边直接接在街口上、
  重叠与压建筑都为 0、失败为 0。
- 不算的部分：**39% 的边短于 10 m**。也就是说多数地块得到的不是"内部路网"，
  而是"街边 → 门/车位"的一小截连接头；它们接得上，但谈不上层次（没有主干、
  没有环通、没有支路分级）。这跟 R1.2-C 的结论一致：单块地上每类交通往往只有
  一个目标，共享率天然为 0。

所以 R1 现在解决的是"**可达性**"（每个口都连得上），还没解决"**内部道路系统**"
（一条主路把几个口串起来）。后者要做场内环路，属于下一轮。

## 6.7 R1.5 · 最终路面与停车场可达性

> `npx tsx test/r1-5-a.ts`（路面连通）· `npx tsx test/r1-5-b.ts`（停车场）

### 必须分开看的四个指标

| 指标 | 结果 | 口径 |
|---|---|---|
| 中心线连通 | **109/109 = 100%** | solver 的 OD 有没有解出来 |
| **最终路面可通行** | **38/109 = 35%** | 入口脚下有路面，且该路面与街口同一连通分量 |
| 停车场通道连通 | **4/32 = 13%** | aisle 单分量（含横缝仍分裂） |
| 车位实际可达 | **未验证** | 只证到"前缘贴通道"1503/1577；逐位可达要建图搜索 |

按交通类型的路面可通行：pedestrian 2/38 (5%) · service 21/36 (58%) · vehicle 15/35 (43%)。
入口脚下完全没路面 62 处；有路面但没接上街口 18 处；路面碎块 199 块 / 连通分量 116 个。

### 根因：净空按窄中线算，落地面按路宽铺

`solver` 的净空原来是 pedestrian 0.5 m / vehicle 2.2 m，而落地面是 3 m / 5 m 宽。
中线合法、路面放不下 → Realizer 只能裁，裁完就断。
**已改**：净空 = 最终路宽的一半（`ROAD_W` 常量），规划阶段就不允许出现放不下的位置。
改完压建筑从 550 m² 降到 **0 m²**，新铺面积 5280 → 6691 m²（绕开建筑的那部分补回来了）。

**剩下的 65% 不可通行不是净空问题**，是**起点被吸到地块深处**：MF 的路面离最近
街口 40 m（`snapToMain` 在路口格被判成孤立分量时会往主分量里找，一找就找远了）。
这条要在 R1.6 一起处理：要么把"街口那一小截"补铺出来，要么禁止这么远的吸附。

### 停车场：没有内部通道拓扑

- `ParkLayout.aisles` 是**每排车位一条的独立条带**，彼此被车位隔开，不是路网；
  32 个停车场里只有 4 个 aisle 单分量。
- `walks`（2.6 m 横向缝）也接不起来 —— 加了还是分裂。
- 停车 Portal 距最近通道 ≤3 m 的只有 12/32（38%）。
- 车位前缘贴通道 1503/1577（95%）—— 说明**车位排本身是合理的**，缺的是
  "排与排之间、排与入口之间"的连接。

按任务书要求，这属于"布局本身无法满足 → 报告给停车布局规划器"，
不在 R1 里重新设计车位和内部车道。要在适配层补的话，最小改动是给
`ParkLayout` 加一条 `crossAisle`（沿车位排端头串起所有 aisle、并接到 Portal）。

## 6.8 S1 · 场地布局编排器

> 代码：`src/town/planning/skeleton/`（`spec` / `builders` / `emit` / `metrics` / `index`）
> 开关：`?s1=off|golden|all`（默认 `off`，本轮只对三个 Golden 生效）
> 报告：`npx tsx test/s1-report.ts`
> 截图：`out/s1/{mf,retail,ind}-{2d-off,2d-golden,3d-golden}.png`

### 先做的是"顺序审计"：路为什么会被迫绕建筑

三个 archetype 的空间决策链（逐行读的结论）：

| | 建筑位置 | 朝向 / 间距 | 主要入口 | 内部道路 | 地面分区 |
|---|---|---|---|---|---|
| `courtyard.ts` | bbox 上切 N×M 组团（`GROUP_MIN 58 m`） | bar 进深 11/14/17 m；朝向取临街面（对） | **最后一步 ⑨**：临街边中点 ±4.6 单位 | **完全不产**（`circulation: []`） | 院子 → bar → 步道挖院子 → 次项 |
| `strip.ts` | 按纵深切三段（店 22 / 前场 8 / 服务 7） | 店面通铺面宽，切成 2~5 间 | **最后一步**：`edgePoint(0.22)` | **完全不产** | 停车 / 前场 / 服务 / 端绿 |
| `rear-load.ts` | 纵深按比例切（front 0.2 / truck 0.21 / apron 0.07） | 仓库居中，长边平行主街 | **最后一步**：`edgePoint(0.5)` | 唯一一条：货场里 7 m 直线，**不接街上任何口** | 前场 / 装卸 / 货场 / 服务道 |

**两条结构性病因**（不是"参数没调好"）：

1. **出入口是最后一步算的，和空间骨架不同源。**
   MF 的门洞开在 `entryU`（院子中心），车行口在 `edgePoint(tCar)`（临街边参数）——
   两个坐标系、两个锚点。中间横着临街 bar，车只能绕。retail 更直接：
   停车在后时**根本没有一条从街到停车场的路**，只能让 A* 从店面旁边绕过去（58 m）。
2. **机动车内部交通从来不是一个设计对象。** 三个 archetype 里唯一"像路"的东西
   是 MF 的 5 m 院内步道（人行）和 industrial 的一条货场直线。所以每个地块
   都得由 A* 现编一条车行路 —— 它当然贴着建筑走，因为缝隙就在那儿。

还有一处量出来的硬伤：**MF 用 bbox 当设计域**。`-469:284` 的 bbox 是 192×239 m
（45,800 m²），而地块只有 22,391 m²（填充率 49%）—— 3×3 组团里有两列落在红线外，
被切成碎片。实测内部路面 **15 片 / 708 m²**，其中 **469 m² 贴着建筑**。

### S1 的做法：把顺序倒过来

```
① 先问地块：临街这一段有多宽（streetSpan，浅进深取最宽，不能在 v=0 上量）
② 再定车道：这条 u 区间能通到多深（laneReach），车道从红线出发
③ 出入口由车道中心在临街线上生成 —— 门必然在路上（构造保证，不是事后对齐）
④ 停车贴着车道摆（parkAlong：沿车道找右侧还让得出空间的那一段）
⑤ 建筑按"该进深的真实宽度"切格子排进去（spanAt / tightSpan，锥形地块收成台阶）
⑥ 剩下的交 claimResidual
```

三种语法（各 2 个方案，复杂度不够时自动降级）：

- **住宅 `sk-mf-court`**：侧向主通道 + 围合组团（每格四条 bar 围一个院子）+ 尽端停车 + 尾部连续绿带。
  降级方案 `sk-mf-rows`：平行板楼 + 中轴绿廊。
- **商业 `sk-ret-rear-park`**：店面压街 + 7 m 店前人行带 + 后侧共享停车 + 侧向贯穿车道 + 后侧后勤。
  备选 `sk-ret-front-park`：临街停车、店面后退。
- **工业 `sk-ind-front-wh`**：20 m 前场（办公 + 员工停车）+ 厂房 + 装卸坪 + 深货场 + 尾端绿化；
  货车从**服务临街面**进场（西侧 local 路），员工车走主街。

### 结果（同 seed、同一把尺子）

| | 原版 | S1 | |
|---|---|---|---|
| **MF `-469:284`** 评分 | 7.90 | **8.23** | ↑ |
| 　建筑 / 覆盖率 | 13 栋 / 18% | 19 栋 / **24%** | ↑ |
| 　建筑-道路间距 | **0.0 m** | **4.5 m** | ↑ |
| 　地块内路面 | 15 片 / 708 m² | **2 片 / 70 m²** | ↑ |
| 　贴墙铺装 | **469 m²** | **29 m²** | ↑ |
| 　空间碎片率 | 36% | **14%** | ↑ |
| **retail `176:176`** 评分 | 7.17 | 6.88 | ↓ |
| 　建筑 / 覆盖率 | 5 栋 / 19% | 7 栋 / 20% | ↑ |
| 　建筑-道路间距 | 0.0 m | **3.0 m** | ↑ |
| 　绿地最大块占比 | 59% | **93%** | ↑ |
| **industrial `252:-578`** 评分 | 5.20 | 5.20 | = |
| 　建筑 / 覆盖率 | 8 栋 / 28% | 2 栋 / **16%** | ↓ |
| 　建筑-道路间距 | 0.0 m | **5.4 m** | ↑ |
| 　地面冲突 | 18 m² | **0 m²** | ↑ |

三个地块的 **SceneIR 精确非法重叠都是 0 m²**（原版与 S1 同）。
"候选内地面叠放"那一列原版很高（MF 51,019 m²）——那是 archetype 故意叠着放、
交给 Realizer 的 ownership 去切的写法，不是非法重叠，两张表要分开读。

### 诚实的短板

- **工业覆盖率掉到 16%**（强度带下限 18%）。`252:-578` 是一条 48 m 宽、
  127 m 深、向右收成三角的带子；要留 20 m 货场 + 9 m 装卸 + 足够宽的厂房，
  就只能盖 2 栋。原版 28% 是靠 8 个碎块堆出来的（那就不是工业场地了）。
  这一项要不要为了覆盖率牺牲货场，是产品决定，不是技术决定。
- **retail 贴墙铺装 69→337 m²**：这 337 里 329 是求解器在停车区里补的一条
  83 m 通道（它按"离街最近的停车边界顶点"选入口，不看我们给的 `preferredEntry`，
  见 `solver.ts:796` 的注释）。与车道重叠 0 m²，不是重复道路，是停车区内部车道。
  要彻底消掉得改 R1 求解器的 portal 选择，不在本轮范围。
- **S1 默认关**。三块地之外一行代码都没换；`?s1=all` 可以全城试，但没有做全城验收。

## 6.9 S2 · 骨架类型库 × Placemaker 多边形停车

> 能力审计：`S2_CAPABILITY_AUDIT.md`（三份源码实测 + 21 个真实地块）
> 代码：`src/town/planning/patterns/`（类型库 + Registry）、`src/town/parking/{placemaker,provider,baked}`
> 烘焙：`npx tsx tools/bake-parking.ts [--all]` → `src/town/parking/baked/layouts.json`
> 开关：`?pattern=off|golden|all` · `?parkingProvider=legacy|placemaker|compare`（**都默认 off / legacy**）

### 三个"读代码看不出来、只有跑起来才知道"的事实

1. **`stats` 不是实存量。** 带建筑障碍时 Placemaker 报 `Stat.Stalls=313`，
   而实际 `objects[parkingBay]` 只有 248 —— 它先排满再按障碍裁。
   车位数一律数 objects。按 stats 做 A/B 会稳定高估 20~26%。
2. **`nets[]` 的拓扑只能靠端点配对。** 中心线被切成 3 段（a/b/c/d），
   相邻段共享端点；`startAttach/endAttach` 实测恒为 -1。
3. **环上不能有洞。** `AreaShape.Ring` 是单环；建筑只能走 `obstacles`（**只吃四边形**），
   而那是 `SiteSafety.Apply` 事后裁剪。所以 S1 必须交出**不含建筑的 ParkingZone** ——
   这是设计约束，不是实现细节。

### 数据驱动的骨架选择（Pattern Registry）

- 类型库原样复制进 `src/town/planning/patterns/`（`skeleton-types.ts` / `ranker.ts` / 两个 JSON），**一行没改**。
- `measureSite(ctx)` 从**真实多边形**量 6 个指标：面积、有效宽度（沿主轴 9 个横截面的**中位数**）、
  长宽比、凹度（面积/凸包）、临街面数、是否有洞。
  **不能用 bbox**：MF 的 bbox 面积是地块的 2.4 倍，用它会选到 6000 m² 的多组团模式。
- `PATTERN_TO_SPEC` 只列 11 条映射（4 supported + 9 partial），其余 13 种 data-only
  `specId = null`，进不了生产候选 —— 这是硬闸。

### Placemaker 接入方式：离线烘焙 + 几何指纹

浏览器起不了 .NET 进程，所以：

```
tools/bake-parking.ts（Node）
   → 逐地块跑 C# --emit → 转成 ParkLayout（世界单位）
   → 按「可用停车面」的几何哈希存 src/town/parking/baked/layouts.json
运行时
   realizeParking → lookupBaked(usable.outer) → 命中就用，未命中 → PARKING_BAKE_MISS 告警 + 回退 legacy
```

**钥匙是几何不是 parcelId**：同一块地换个候选停车区就变了，用 parcelId 会画出对不上的车位。

踩过的两个坑（都写在代码注释里）：

- 注册曾经放在 `scene/build.ts` 的 side-effect import 里 → 凡是没经过 `buildScene` 的调用方
  （探针/单测/直接调 planner-bridge 的脚本）查表永远 MISS。现在改到 `provider.ts` **模块加载即注册**。
- 车位/车道尺寸必须和 legacy 一致。第一版用 Placemaker 默认的 3.0/5.9/7.0，
  同一块地它只能排 45 位而 legacy 排 78 位 —— 那个差距 100% 来自车位宽度，
  跟算法优劣无关。现在两边都是 `2.52 / 5.04 / 6.3 m`（legacy 的 `CAR_STALL`）。

### A/B/C 实测（seed 682063530）

| 地块 | A 旧布局+legacy | B S1+legacy | C Pattern+S1+Placemaker |
|---|---|---|---|
| **retail 176:176** | 5 栋 / 13% / **104 位** | 7 栋 / 14% / **78 位** | 7 栋 / 14% / **116 位** |
| 　绿岛 | 16 块 / 194 m² | 17 块 / 206 m² | **2 块 / 456 m²**（连续，不是碎点） |
| MF -469:284 | 13 栋 / 16% / 3 位 | 19 栋 / 22% / 8 位 | 同 B（**回退**：停车区 290 m² < 440 m² 下限） |
| industrial 252:-578 | 8 栋 / 17% / 4 位 | 2 栋 / 10% / 4 位 | 同 B（**回退**：221 m²） |

零售同一块停车区上：**Placemaker 116 位 vs legacy 78 位（+49%）**，
视觉上是「双面停车排 + 一条连续车道 + 两个大绿岛」对「碎成十几段的短排 + 随机白色横条」。

### 多边形泛化（5 种形状，尺寸同 legacy）

| 形状 | 面积 | ready | 车位 | 车道段 | 车道m | 分量 | 前端贴车道 | 绿岛 |
|---|---|---|---|---|---|---|---|---|
| 矩形 150×100 | 15000 | ✓ | 467 | 49 | 1198 | **1** | 100% | 67 |
| 楔形三角 120×90 | 5400 | ✓ | 149 | 23 | 447 | **1** | 96% | 22 |
| 凹形 L 120×100 | 8425 | ✓ | 261 | 29 | 686 | **1** | 100% | 42 |
| 狭长 160×18 | 2880 | ✓ | 53 | 5 | 158 | **1** | 100% | 11 |
| 含建筑障碍 | 15000 | ✓ | **392**（无障 467） | 32 | 770 | **1** | **78%** | 59 |

含障碍那一行是**真实短板**：`SiteSafety` 事后裁剪丢车位，22% 的车位前缘不再贴车道。

### 全城烘焙（`--all`，47 块）

21 个停车区成功 · 合计 **1313 位** · 中位 65 位/区（10~116）·
**100% 车道网单连通** · **100% 全部车道段接到入口** · 车位前缘贴车道中位 **100%** ·
单次 753 ms（P95 873 ms）· 整城烘焙 43 s。

### 诚实的边界

- **< 440 m² 排不出车位**（18×18 m 的 324 m² 是 `ready=true` 但 0 位）。MF/工业两个 Golden 因此用不上。
- `pk_angled_oneway`（45°/60° 斜列）能传参，**没有单独验收**。
- 车道只有中心线，没有车道面；Realizer 也一直不画通道面（`layout.aisles` 全程为空，两套 provider 一致）。
- 洞口场景质量退化（78% 前端贴车道），没有质量基线。
- 生产默认**未改变**：`pattern=off` / `parkingProvider=legacy` / `s1=off`。

## 6.10 S2.5 · 场地与多边形停车场协同

> 详报：`S2_5_REPORT.md` · 脚本：`test/s2-5-diag.ts`（归因）、`test/s2-5-abc.ts`（A/B/C）
> 开关默认全关：`?pattern=` `?s1=` `?parkingProvider=`；生产行为未变。

### 一句话结论

采用率 18% → 41%，但**这个数字不能单独看**：按停车区规模分组是
<600 m² 0% / 1200~2000 m² 67% / ≥2000 m² 71%。
Placemaker 在大场地上赢（retail 116 位 vs legacy 87 位，+33%），
在紧凑小场地上输给 legacy 的满排（24×26 m：14 vs 24）—— 这是语法差异，不是参数问题。

### 修掉的三件事

1. **烘焙矩阵**。原来只烘 `s1=golden|off`，网页跑 `s1=all` → 停车区几何不同 →
   17 个请求全部 MISS。现在烘 6 组配置（`off/golden/all × off/golden/all`），
   MISS 归零。
2. **S1 主动预留停车**。`parkingBand()` 按 `PM_MIN_AREA_M2=440` / `PM_MIN_SIDE_M=17`
   （实测：396 m² 全失败、432 m² 起成功）沿车道找带；住宅停车 290→540 m²、
   工业 221→635 m²（前场 20→30 m，办公楼改成厂房前脸的东端副楼）。
3. **车道面**。`bufferPolyline()` 按 `aisleWidth` 把中心线加成带、斜接转角、
   裁到停车区，写进 `ParkLayout.aisles` → SceneIR 的 `*_pk_aisle_*`（overlay，asphalt
   比车位底深一档）。`aislePolyComponents` 用**多边形相交**判连通，不是端点配对。

### 一条新闸门（很重要）

`baked.diag.legacyStalls` 是烘焙时用**和运行时完全相同的角度集**算出的 legacy 车位数。
运行时若 `PM < legacy × 0.85` 就回退 legacy 并写 `PARKING_PM_WORSE`。

没有它，"启用 Placemaker"就等于"悄悄掉一半车位"（实测窄带 15 vs 29）。
阈值 85% 的含义：用 ≤15% 的车位换连成一片的车道面 + 端头绿岛，是本阶段愿意付的价。

### 新增字段

- `BakedParking.aisles`（车道面环）、`empty`（跑过但 0 位，只用于归因）
- `diag.aislePolyM2 / aislePolyComponents / aisleWidthOk / stallFrontPolyRate / legacyStalls`
- `report.parking = { requests, stalls, providers, islands, aisleM2, aisleComps, frontRate, perRequest[] }`

### 仍未解决

- 锥形尾端的大片死铺装（PM 的 `asphalt` 面没回写 ground，retail 约 400~600 m² 深色三角）
- <600 m² 的小停车区全部回退 legacy（住宅/工业的常态）
- 含障碍区域：车位前缘入面 100% → 78%
- 工业前场加深的代价：厂房进深减少、覆盖率 5%

## 6.11 S2.6 · 停车场地面语义与布局质量收口

> 详报：`S2_6_REPORT.md` · 脚本：`test/s2-6-ground.ts`（语义分区 + SVG）

### 一条被推翻的前提

"retail 尾端有一大片没用的铺装"—— **面积上不成立**。
实测 `asphalt + grass = ParkingZone`（2593 + 456 = 3049），PM 把整块区都铺了；
语义核算下来：车位带 1644 / 车道 1122 / 岛 456 / 空地 0 / 无功能铺装 0。

用户看到的深色三角 = **车位带本身**。因为车位从来没有底色，只有 1 px 白线，
一排 58 个位远看就是"一块深灰撒了一排线"。

### 修法：按功能分层上色（车位浅、车道深）

| 层 | 材质 | 亮度 |
|---|---|---|
| 停车区底 | `asphaltLot` | 0.268 |
| **车位带** | **`stallBand`（新）** | **0.335** |
| 车行通道 | `asphalt` | 0.243 |
| 景观岛 / 转绿 | `grass` | — |

`rowBands` 由烘焙写入（每排车位的**外包**，不是全体凸包 —— 凸包会把两排之间的
锥形空地包进去，`Zone − 占用` 恒为空，尾端永远识别不出来）。
无功能铺装识别通道保留：`Zone − 排 − 车道 − 岛`，再按"≥8 m² / 等效宽 ≥3.5 m /
离进出喉咙 >2 m / 离车位 >6 m"决定转绿还是留铺装，保留量进 `deadPavingM2`。
当前全城可转绿块 0 —— 通道是兜底，不是死代码。

### 工业：撤回 S2.5 的"为停车让路"

前场 30 → 20 m、办公楼回前场、厂房进深 30~34 → 42 m。
停车区 635 → 221 m²（PM 排不下，闸门回退 legacy 4 位），覆盖率 5% → 10%(patch)/16%(parcel)。

**覆盖率下限现在是真硬约束**：`INDUSTRIAL_INTENSITY.min = 16%`，
且 `emitAll` 开始按 `hard.ok` **过滤候选** —— 之前在 metrics 里只算不过滤，
5% 的方案照样能赢。一套不剩就返回空数组，回落 archetype。

> 口径：metrics 用**红线地块**（5092 m²），SceneIR 里量 patch（8534 m²），
> 同一个方案会有 16% / 10% 两个数，别混用。

### 快照带上实验开关

`#s=` 现在也存 `s1` / `ptn` / `pp` / `cm`（可选字段，默认组合不写）。
分享链接不会再"打开还是旧算法"。

### 复现

```
npx tsx test/s2-6-ground.ts     # 语义分区面积 + out/s26/<key>-zones.svg
npx tsx test/s2-5-abc.ts        # A/B/C，retail 116 位 / 车道 1 分量 / 前缘 100%
```

### 顺带修的：图层里没有"内部道路"这一项

用户反馈"看不出哪一段是内部道路"，根因不是看不见，是**图层归属错了**：

- 地块内部铺出来的路面（`realize/road.ts` 产出的 `*_road_N_surf/walk/curb/pad`）带的是
  `group = lot/<typology>`、`mat = asphalt/concrete` —— 与"停车场地坪""硬质铺装"
  同组同材质，于是被并进了 `pave:asphalt` / `pave:hard`。把「道路」整组关掉，
  地块里的沥青还在，看起来就是"有一半路关不掉"。
- 手绘的内部路中线（`path:lane`）原来藏在「线性要素」组里，和围栏混在一起。

改法：`scene/layers.ts` 新增 `内部道路` 组（`lotRoad:surf` / `lotRoad:walk` / `path:lane`），
在按材质分类**之前**用命名把内部路面拦下来（这几类面是 `realize/road.ts` 自己命名的，
group/mat 分不开它们）。面板的计数改成从**当前渲染的场景**现数
（`View2D.layerCounts()`），否则切到 Planner 之后还显示 legacy 的 0。

另外给了「内部道路」组一个 **高亮** 开关（组标题右侧，实心强调色 = 开启）：
把内部车行面 / 人行面 / 中线临时染成橙红（`palette.MAT.lotRoadHi` / `lotRoadHiWalk`），
不用靠"关掉别的东西"来反衬。实现是纯表现层：

- 判定只有一份 —— `scene/layers.ts` 的 `isInternalRoadLayer` / `hiliteMatOf`；
- 2D 在 `View2D.draw()` 填色时替换、3D 在 `buildTownMeshes` 的 `colorOf()` 里替换，
  两边走同一个函数，不会出现"2D 染了 3D 没染"；
- 不写回 `Scene`，也不改图层显隐，所以关掉就恢复原色；
- 截图/核对入口：`?hilite=1`。

**两个坑（都踩了才改对）：**

1. **车位划线被算成"内部道路中线"**。`realize/parking.ts` 把每个车位画成一条
   `markWhite` 的短线（`*_stall_i_k`），而 `layerOfPath` 只判"有没有高度"——
   1339 条里 1333 条是车位线，真正的内部路中线只有 3 条。高亮一开，整片停车场
   变橙。现在按**材质**分流：`markWhite / markYellow → road:parkmark（车位线）`。
2. **孤立方垫**。solver 常常只补"街边 → 已铺场地"一小截，退让后只剩 1~4 m，
   铺出来是一个方块；顶点方垫还会在端点/无邻段处单独留一个 5×5 的橙块。
   现在 solver 模式：段长 ≤ 自身断面 0.75 倍就不铺（交给方垫与既有铺装衔接）、
   端点不铺垫、两边都没有邻段的垫不铺。工业那块的垫从 3 个降到 1 个，
   `road_2`（只有一个垫、没有段）整条消失。

### 保证项复核

- 没动 Road Graph 核心（只改断面表与 `S` 的算法），没动建筑的世界单位；
- 红线 = 车行道 + 人行道 + 绿化带，误差 0.000 m；低于等级最小红线的边 0 条；
- 车道数跟着断面走（主干 6→4、次干 4、支路 2），人行道 3.5/2.0/1.5 m 都在可行走下限之上；
- 路口面积/红线² 从 2.45 降到 1.69，仍 >1（合并路口 MERGE_LEN 2.6 u 造成的长条，属既有行为）；
- R1.3 内部路：三块 Golden 仍全连通，精确重叠 **0 m²**（47 块 / 787 面）；
- 未改 Parking Solver。

### 还剩什么（未解）

- **停车场内部可达性**：R1 只连到停车区边界的 Portal，**"Portal → 车位排"未验证**，不能标 PASS。
- **共享率仍是 0%（MF/retail）**：三张网合并不解决"一块地每类交通只有一个目标"。
  真正的场内环路（把几个入口串成一条）还没做 —— 那才是共享率该到 70%+ 的形态。
- **solver 只在三块 Golden 上开**：放开要改 `R13_CIRCULATION_PARCELS`，
  先看 `test/shadow-r13.ts` 的 3 块拒绝（`-23:570` / `207:571` / `338:-254`：
  求解器没有产出任何路径，目前回落旧路）。

---

## 7. Phase M（城市形态场）：完全没开始，先读这个

Phase 0 审计已定位 **7 处硬编码**（报告 `PHASE_0_AUDIT.md`）：

| # | 现象 | 位置 |
|---|---|---|
| 1 | 住宅高度只有 21/18/15 三个值，永远"临街高后侧矮" | `multifamily/courtyard.ts:325` |
| 2 | 塔楼高度只看地块面积，与区位无关 | `retail/strip.ts:201` |
| 3 | 工业厂房固定 9 m | `industrial/rear-load.ts:257` |
| 4 | 补量高度按 typology 固定 | `generators.ts::INFILL_H` |
| 5 | 用地只看"到原点半径分位数" | `landuse.ts:62-90` |
| 6 | 外围 18% 工业否则绿地 | `landuse.ts:72` |
| 7 | 大地块只调一次单组团生成器 | `generators.ts` |

**基线数据（改前必须记）**：

```
高度分布：0~12m 47.9% | 12~24m 50.4% | 24~36m 0% | 36~60m 1.8% | 60m+ 0%
FAR：内环 0.55 | 中环 0.48 | 外环 0.90   ← 梯度是反的
体块 280 个 / 有建筑的 block 39 个
```

---

## 8. 测试（27 个脚本，全绿；`gen` 有 1 条历史失败）

```bash
npx tsx test/planning-frontend.test.ts   # 175 条，最重要
npx tsx test/planning-green.test.ts      # 174 条，green/park/civic + D0 回归
npx tsx test/diagnostics.test.ts         # 16 条，13 s，审计回归
npx tsx test/circulation.test.ts         # 25 条，R1 内部交通 Golden（建模型 ~3 s）
npx tsx test/r1-3-adopt.test.ts          # 35 条，R1.3 生产接入验收（含全城重叠审计）
npx tsx test/shadow-r13.ts               # 全城 A/B 统计（不是测试，是量尺）
npx tsx test/scale-diag.ts               # 道路/街区尺度诊断（单点）
npx tsx test/scale-shadow.ts             # 尺度 A/B/C 对照
npx tsx test/s1-audit.ts                 # 三个 Golden 的规划顺序审计（改前基线）
npx tsx test/s1-report.ts                # S1 骨架 vs 原版布局对比
npx tsx test/s2-5-diag.ts                # S2.5 停车采用率归因（34 个请求逐条）
npx tsx test/s2-5-abc.ts                 # S2.5 A/B/C 对照 + 四层停车验收
npx tsx test/s2-6-ground.ts              # S2.6 停车场地面语义分区（面积 + SVG）
npx tsx test/planning-{mf,retail,industrial,hotel,dc,sf,realize,freeze}.test.ts
npx tsx test/{layers,snapshot,cover,surface,glb}.test.ts
```

`test/gen.test.ts` 有一条**历史失败**：`radial-10 城内路网连通 187/196`。
**不是你引入的**，别去"修"它。

---

## 9. 性能基线（同机、同场景）

```
模型生成        3045~3835 ms
路网             15~28 ms
全城规划(Planner) 1213~1418 ms   ← Phase D 收口时的数字，作为基线
Scene(planner)  1590~1837 ms
R1 求解（单块）  MF 92.6 / retail 28.7 / industrial 10 ms
```

性能结论必须**同机交替多跑几次**：单次差异可达 ±20%（有一次 +43% 全是噪声）。

---

## 10. 踩过的坑（按主题，省你几天）

### 几何 / 布尔
- `surfaceInset` 对**带洞的面返回 0 片**；对凹多边形会外翻。用之前先判断。
- `surfaceSubtract` 失败时**原样返回被减数**（返回整个面）。必须防护：
  返回块面积 ≥ 95% 原面就整体放弃。否则会出现"认领退线带 = 认领整块地"。
- `chamferCorners` 在**凹角**会撑大面积（切点算到另一侧）。倒角后要比面积。
- 多边形共边时，落在边上的采样点会被**两边同时判内** —— 采样审计必须留 2 cm 容差。

### Planning
- `topUpBuildings` 按覆盖率补量，`INFILL_H` 决定补多高 —— 这是"固定三栋"之外的第二个来源。
- 诊断分**不是跨版本可比的**：改了 diagnostics 的公式，分数变化不代表方案变好/变差。
  要比就"用同一版 Evaluator 重评两个 Candidate"。
- `lawn` 铺整块再让广场叠上去，诊断会读到"绿地 114%" → 区间打爆归零。
  **在 archetype 里用 `minusAll` 先挖**。
- 面积预算里 `bReason` 之类数组存的**已经是 m²**，别再乘 49。

### 编辑器 / 渲染
- 调试渲染器要用 `scene/palette` 的 `MAT`，**不要自己手写颜色表**（我手写过一版，全偏亮，
  据此判断"停车场糊成一片"全是错的）。
- `buildScene` 里 `legacy` 与 `planner` 是**二选一**，不会重复生成；但 2D/3D 各跑一遍。

---

## 11. 下一步建议（按优先级）

> ~~1. R1.2-C 引入主干~~ → **已交付**，见 §6。
> ~~2. `svc` 连通~~ → **已解决**：病的不是后勤口，是种子落孤岛 + "已在网上"被误报为失败。
> ~~`initNetwork`~~ → 已实现。
> ~~3. R1.3 接入生产~~ → **已交付**，三块 Golden 浏览器可见，重叠 0 m²。

1. **决定要不要放开全城**。判据已经有了（`test/shadow-r13.ts`）：+48.6% Planner 耗时、
   +7073 m² 内部道路、3 块拒绝。**先要回答的是产品问题**：这些内部路该不该存在？
   基线是 35 m² —— 也就是说现在的城市几乎没有内部道路，全城放开等于重画所有街区。
2. **场内环路**：共享率 0% 的根因是"一块地每类交通只有一个目标"。要么做真正的场内环路
   （把几个入口串成一条），要么承认"共享率"这个指标单块地上没意义、改成城市级统计。
3. **停车场内部验证**：拿到 `solveParking` 的 aisle 数据，验证 Portal → 车位排可达。
4. **M1**：形态场 + 让 CBD/MF 读目标高度，替换 §7 那 7 处硬编码。

---

## 12. 文档索引（都在仓库根）

```
AI_HANDOFF.md             ★ 给接手 AI 的浓缩版：开关矩阵 / 待办 / 雷区（先读这个）
DEVELOPMENT.md            本文：各阶段完整叙事
S2_CAPABILITY_AUDIT.md    S2 输入审计：29 种骨架的可实现性（4 supported / 9 partial / 13 data-only）
S2_5_REPORT.md            S2.5 协同优化：采用率归因（MISS 17→0，18%→41%）
S2_6_REPORT.md            S2.6 地面语义：分区核算 + 车位带 + 工业回撤
PHASE_0_AUDIT.md          Phase 0 代码审计 + 基线数据（7 处硬编码）
PHASE_D_FINAL_REPORT.md   D 阶段收口（PASS_WITH_ISSUES）
PHASE_G0_REPORT.md        统一采样底座（PASS）
PHASE_G_TRACE_REPORT.md   道路/地块边界溯源（结论已被下一份部分撤回）
PHASE_G1R0_REPORT.md      两个假设被否 + 测量有污染
PHASE_R1_REPORT.md        R1 原型
PHASE_R1_1_REPORT.md      Portal 抽象
PHASE_R1_1A_REPORT.md     导航域改 parcel
PHASE_R1_1A2_REPORT.md    MF 停车真实阻塞
PHASE_R1_1B_REPORT.md     MF 门洞修复 + OD 去重（三 Golden 全连通）
PHASE_R1_2_REPORT.md      共享折扣 + 三联图（未通过）
PHASE_R1_2B_REPORT.md     多源 Dijkstra（性能达成，共享 0%）
```

**读文档有个坑**：`PHASE_G_TRACE_REPORT.md` 里"短边过度内缩 78%"的结论已被
`PHASE_G1R0_REPORT.md` 撤回（相关系数 r=−0.17）。以**新的为准**。
