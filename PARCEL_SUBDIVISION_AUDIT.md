# F2.0 · 现有地块分割能力审计

> 审计对象：`PCG-V115` 仓库 `main` 分支当前代码（44,131 行 TS）。
> 审计方式：**逐文件读实现**，不依据 `DEVELOPMENT.md` / `PHASE_*_REPORT.md` 的历史叙述。
> 所有结论都带 `文件:行号`，可逐条复核。
> 审计时间：2026-11-05。

---

## 0. 结论摘要

现有代码里**有四套**"把街区切成地块"的实现，它们共享同一组布尔工具，但**没有一套**具备：

- 洞的处理（四套全都只吃 `Pt[]`，洞在入口就丢了）；
- 建筑约束（没有任何一处在切分时看建筑）；
- 地块级几何审计（自交、面积对账、洞保留、建筑归属都在切分之外，且没有实现）；
- 统一的候选合同与策略接口（四套各有各的返回结构）。

因此 F2.1 的定位不是"再写一个更好的切割器"，而是先补 **面级切分原语 + 候选合同 + 统一裁判**，再在其上实现两个策略。本阶段新增代码**没有重写**已有的布尔运算、临街打分、面宽参数表。

| 能力 | 现状 | 本阶段处置 |
|---|---|---|
| 面结构（外环 + holes） | 已有且全链路认洞 `surface.ts:23` | 直接复用 |
| 布尔（并/差/交） | 已有，带静默失败降级与计数 `surface.ts:212/255/280/147` | 直接复用 |
| 变距内缩（逐边） | 已有 `surface.ts:362` `insetPerEdge` | 复用其半平面裁剪思路 |
| 环级二分切分 | 已有 `modern.ts:4381` `bisectRing` | **不可用**（丢洞、只留最大瓣），另写面级版本 |
| 按面宽网格切分 | 已有 `modern.ts:4508` `frontagePartition` | 作为对照基线 |
| 按面积递归切分 | 已有 `modern.ts:4737` `tensorPartition` | 作为对照基线 |
| 临街面识别与打分 | 已有 `context.ts:173` `resolveFrontages` | 复用口径（3 单位阈值、同街合并） |
| 面宽/进深参数表 | 已有 `adapters/subdivide.ts:76` `SUBDIVIDE` | 复用为默认参数 |
| 地块级几何验证 | **不存在** | 本阶段新建 `validate.ts` |
| 分割候选合同 | **不存在** | 本阶段新建 `types.ts` |
| 建筑保护 | **不存在** | 本阶段新建（装配阶段统一归属） |

---

## 1. 四套现有分割算法

### 1.1 `tensorPartition` — 按面积递归二分

`src/town/modern.ts:4737`

```
walk(ring, depth, ang)
  area ≤ targetA 或 depth ≥ maxDepth → 收为地块
  否则：过质心（带 ±26%/±30% 抖动）沿 ang 切一刀 → 两侧递归，ang += 90°
```

- 方向来源：`opts.ang0`（外部传入），之后**逐级固定正交**，不重新计算局部方向。
- 停止条件：**只有面积**（+ 递归层数）。没有面宽、进深、临街、建筑任何一个判据。
- 切分原语：`bisectRing`（`modern.ts:4381`）。
- 已知自述缺陷（代码注释 `modern.ts:4735`）：能切出 60×7 m 的窄条，退线后是一栋超长薄楼；`strip`（平行条带）模式因此被删。
- 该函数在当前主链路里**只用于公园地块**（`modern.ts:1747`、`modern.ts:1129`、`modern.ts:3508`），`planParcels` 已改用 `frontagePartition`。

**判定：真正的空间细分（递归二分），但只约束面积、不认临街、不认建筑、丢洞。**

### 1.2 `frontagePartition` — 按沿街面宽排布网格

`src/town/modern.ts:4508`

```
① 沿 u（临街方向）等分 nU 条 → ② 每条按进深上限横切 nV 排
nU = round(W / frontage + 0.15)，nV = round(D / maxDepth + 0.15)
每刀位置：u0 + W*(i + rand*jitter*2)/nU
```

- 比 `tensorPartition` 多一条真实约束：**沿街方向切**，所以每块地天然有一条临街边。
- 但切点位置是**逐刀独立抖动**的：第 i 刀的坐标与第 i-1 刀无关，jitter 到 15% 时切点可能非单调，出现**重叠或缝隙**。实测 G03 旧·沿街网格有 **1091 m²（6.6%）面积无人认领**。
- 进深方向同样不认建筑；`depth` 只做"够深才切"的闸。

**判定：几何上是"网格 + 布尔裁剪"，不是自适应细分。**

### 1.3 `planParcels` — 编排层

`src/town/modern.ts:2372`

- 从 `LandUse` 推面宽系数（`FRONTAGE_K`）与进深上限（`MAX_DEPTH_M`），调 `frontagePartition`；
- 把切分线铺成巷（`depth 0` 沥青巷 / `depth 1` 混凝土巷）；
- **本阶段不改动它**（它属于 legacy 街区分支，不在 Planner 链路上）。

### 1.4 `subdivideByFrontage` — Planner 自己的沿街切分

`src/town/planning/adapters/subdivide.ts:95`

```
u = primaryFrontage 方向，v = 指向内部
rows = depth > 1.7*maxDepth ? 2 : 1
cols = round(width / frontageU)
每块 = 矩形条 ∩ buildableArea，短边<8m 或 面积<200m² 丢弃
```

- 与 1.2 的区别：在**可建区**（退线后）上切，且用 `surfaceIntersect` 保住洞（这是唯一保住洞的一处）。
- 代价：切出来的地块**不再贴着街**，于是需要 `edgesForPiece`（`adapters/subdivide.ts:195`）反查临街；查不到就**造一条虚拟 alley edge**。
- 随机：无。结果完全确定。

**判定：网格切分 + 布尔裁剪；"临街"是事后猜的，不是切分时保证的。**

---

## 2. 逐项回答任务书的七个问题

### 2.1 已有哪些地块分割算法？

| 函数 | 位置 | 类型 | 使用者 |
|---|---|---|---|
| `tensorPartition` | `modern.ts:4737` | 面积递归二分 | 公园/子街坊 |
| `frontagePartition` | `modern.ts:4508` | 沿街网格 | `planParcels` |
| `planParcels` | `modern.ts:2372` | 编排（参数 + 铺巷） | legacy 街区 |
| `subdivideByFrontage` | `adapters/subdivide.ts:95` | 沿街网格（在可建区上） | Planner 前置 |

四套之外，`archetypes/*` 里的"切段"（如 `strip.ts` 的纵深三段、`courtyard.ts` 的院子/bar）是**布局内部分区**，不是地块分割，不参与本次对照。

### 2.2 哪些是真正的空间细分，哪些只是 Polygon 布尔运算？

**四套都是"布尔运算拼出来的空间细分"，没有一套是几何自适应的细分算法。**

- 真正的空间细分应回答"这一刀该不该在这里、方向该取哪个、切完还能不能开发"；
- 现有实现的"方向"是外部传入的常量或街区最长边，**位置**是等分 + 抖动，**合法性**在切完之后才（部分）检查。

唯一的例外是 `bisectRing` 返回的 `seg`（刀口线段）被拿去铺巷 —— 这是"切分结果反哺几何"的正确方向，但只用于画巷道，没有回流到地块判定。

### 2.3 哪些支持不规则、凹形、带洞的 Polygon？

| 层面 | 不规则 | 凹形 | 带洞 |
|---|---|---|---|
| 面结构 `PlanSurface` | ✅ | ✅ | ✅（`outer + holes`，全链路认洞） |
| 布尔 `surfaceUnion/Subtract/Intersect` | ✅ | ✅ | ✅（`polygon-clipping`，失败有降级与计数） |
| `bisectRing`（`modern.ts:4381`） | ✅ | ⚠️ 只取每侧**面积最大**的一块，凹多边形切出的第二瓣被静默丢弃 | ❌ 只吃 `Pt[]`，洞在函数签名处就没了 |
| `tensorPartition` / `frontagePartition` | ✅ | ⚠️ 同上（经 `bisectRing`） | ❌ |
| `subdivideByFrontage` | ✅ | ✅（用 `surfaceIntersect`） | ✅（唯一保住洞的一处） |

**实测证据（G07 带洞街区，中庭 42×42 m）：**

| 方案 | 洞丢失 | 说明 |
|---|---|---|
| 旧·沿街网格 | **1 处** | 23 块地把中庭填平 |
| 旧·面积递归 | **1 处** | 8 块地把中庭填平 |
| 新·Recursive OBB | 0 | 16 块，洞被完整保留 |
| 新·Street-front Offset | 0 | 8 块，洞成为后方组团的内庭 |

### 2.4 哪些能识别真实道路临街关系？

**有一处做得对，有一处做得危险。**

- ✅ `resolveFrontages`（`core/context.ts:173`）：街区级真实临街识别。
  - 地块每条边配一条"3 单位（≈21 m）内"的道路边（注意：`RoadEdge.a/b` 是**道路中心线**，地块边界离它还有半条路宽 + 人行道，所以阈值不能用 0.6）；
  - 按 `roadClass + sharedLength + visibility + accessibility − obstruction` 四项打分；
  - 把**同一条街的多段 Voronoi 边合并成一条临街面**（相邻且方向差 < 25°），否则 primary/secondary 会落在同一条街的两段上。
  - 这套打分与合并逻辑本阶段**没有重写**，新的 `frontagesOf` 只做地块级的长度量化，口径沿用 3 单位与 `roadClass` 权重。
- ⚠️ `streetAxis`（`modern.ts:4471`）：用"压在 patch 边界上的最长边"当沿街方向。这是个**几何代理**，不知道那条边后面是不是真有路。
- ❌ `edgesForPiece`（`adapters/subdivide.ts:195`）：找不到相邻道路边时，**沿地块最长边造一条虚拟 edge**（`key: ${ctx.parcelId}#alley`，`carriageSide: 0.45`）塞进 `roadEdges`。下游无从分辨"真路"与"编出来的路" —— 这正是任务书点名禁止的"虚构车辆入口"。

新实现的做法：巷接走 `AccessRef.via='alley'` + `viaSibling`，并且 `requiresInternalLane=true`，**绝不放进 `roadEdges`**。

### 2.5 哪些能保留建筑和道路之间的约束？

**没有。全仓库的四个切分函数里，没有任何一处读过建筑。**

- `tensorPartition` / `frontagePartition` / `subdivideByFrontage` 的入参里没有建筑；
- `planParcels` 也不看建筑；
- 建筑是切分**之后**由 `archetypes/*` 往地块里摆的，所以"切分线穿过既有建筑"这件事在结构上无法避免。

本阶段的处置（`assemble.ts` `assignFixedBuildings`）：

1. 切分时把建筑当**硬约束**：OBB 的每个候选刀口都要过"是否切开固定建筑"的检查（`childrenOk`）；
2. Offset 的带域**先让开建筑**（`bandBase = boundary − buildings`）；
3. 装配阶段统一"整栋归一块地"：归属块吸收红线内的整栋楼，其余地块从楼边让开。

### 2.6 哪些具备完整几何错误检测？

| 检测项 | 现状 |
|---|---|
| 全城覆盖分类（A 路 / A 建筑 / A 规划面 / B 仅底板 / C 真缺口） | ✅ `diagnostics/geometry-audit.ts:109` `auditCoverage` |
| 全城两两精确重叠 | ✅ `diagnostics/geometry-audit.ts:376` `auditOverlap` |
| 布尔静默失败计数 | ✅ `surface.ts:147` `geometryFailures` |
| **地块级**：越界 / 互相重叠 / 洞被填死 / 自交 / 面积对账 / 建筑被切 / 无接入 | ❌ **全部不存在** |

前者是"整城体检"，粒度是场景面；后者是"这一次切分合不合法"，粒度是候选。两者不能互相替代 —— 本阶段新建 `subdivision/validate.ts` 补后者。

### 2.7 哪些能力可以直接复用？

**直接复用（未改一行实现）：**

| 能力 | 位置 | 用途 |
|---|---|---|
| `PlanSurface` / `cleanRing` | `surface.ts:23/51` | 面结构、重复点清理 |
| `surfaceUnion/Subtract/Intersect` | `surface.ts:212/255/280` | 所有布尔 |
| `surfaceArea` / `ringArea` / `bboxOf` | `surface.ts:75/83/525` | 面积、方位 |
| `surfaceAnchor` / `distToSurfaceEdge` | `surface.ts:503/559` | 瓶颈宽度（最大内切圆） |
| `pointInRing` / `insideSurface` | `surface.ts:546/540` | 洞探针 |
| `geometryFailures` | `surface.ts:147` | 布尔异常可观测 |
| `SUBDIVIDE` 表 | `adapters/subdivide.ts:76` | 各 typology 默认面宽/进深 |
| `SiteRoadEdge` / `Frontage` / `SiteContext` | `core/types.ts:41/57/105` | 输入合同 |
| `resolveFrontages` 的打分口径 | `core/context.ts:173` | 新 `frontagesOf` 的参数来源 |
| `crossSection` / `safeSpan` / `streetSpan` | `skeleton/spec.ts:178/204/227` | 已知可用的扫描线工具（本阶段未用，留给 F2.2） |

**只改了一行**：`surface.ts` 的 `selfIntersects` 加了 `export`（`validate.ts` 复用同一份自交判据，避免第二套"差不多"的实现）。

**作为对照基线（加了 `export`，未改实现）**：`modern.ts` 的 `tensorPartition`、`frontagePartition`。

---

## 3. 明确缺失的能力（本阶段必须补）

| 缺失 | 影响 | 补齐位置 |
|---|---|---|
| 面级切分原语（保洞、保全部连通块） | 凹形/带洞地块无法正确切分；凹形切出的第二瓣被丢弃 | `subdivision/geom.ts` `splitSurfaceByLine` |
| 最小面积外接矩形 | 无局部方向，只能沿全局轴切 → 斜街区出楔形 | `subdivision/geom.ts` `obbOf` |
| 地块级临街长度量化 | 只有"边中点最近"的布尔判定，斜边临街长度被低估 | `subdivision/relations.ts` `frontagesOf` |
| 接入的显式表达（路 / 巷 / 既有） | 后排"有没有入口"只能靠事后猜 | `subdivision/relations.ts` `roadAccessOf` / `alleyAccessOf` |
| 候选数据合同 | 四套实现四种返回结构，无法横向比较 | `subdivision/types.ts` |
| 统一裁判 | 无人对"切完是否合法"负责 | `subdivision/validate.ts` |
| 建筑保护 | 切分线可以穿过不可移动的楼 | `subdivision/assemble.ts` |
| 碎片修复（连通合并） | 残片只能被丢弃或填绿 | `subdivision/repair.ts` |

---

## 4. 明确**禁止**重复开发的部分

以下实现已经存在且经过生产验证，F2.1 及后续阶段**不得另写一套**：

1. **布尔运算与洞语义** —— 一律调 `surfaceUnion/Subtract/Intersect`，不许直接 `import polygon-clipping`。
2. **重复点清理** —— 一律用 `cleanRing` / `surface()`。注意：真实数据里建筑轮廓常有相邻重复点，不清理会让布尔直接抛错。
3. **临街打分公式** —— 沿用 `resolveFrontages` 的 `0.45*roadClass + 0.25*sharedLength + 0.2*visibility + 0.1*accessibility − obstruction`；新的 `frontagesOf` 已按此实现，后续不得另立口径。
4. **面宽/进深参数表** —— 用 `SUBDIVIDE`，不要在策略里新拍数字（那张表带着"为什么不是规范下限"的论证）。
5. **自交判定** —— 用 `surface.ts` 的 `selfIntersects`。
6. **全城几何审计** —— `auditCoverage` / `auditOverlap` 继续负责整城体检，不要拿它们替代地块级验证，也不要在地块级重写采样器。

---

## 5. 审计中发现的上游问题（不是本轮引入，但会误导判断）

| 编号 | 现象 | 证据 | 影响 |
|---|---|---|---|
| A-01 | 生产红线 `-469:284` 的外环**本身自相交** | `selfIntersects(site.parcel.outer) === true`，29 顶点、无重复点 | 子块继承该交叉；验证层据此把"自交"降级为 warn 并标注"继承自父场地"，否则整轮验证会被一个上游问题全盘否掉 |
| A-02 | 既有建筑轮廓带相邻重复点 | C01 第 12 栋（450 m²）对**所有**地块的精确重叠都返回 0，并计 1 次 `geometryFailures.intersect` | 归属判断落空，误报"建筑无归属"。已在 `contextFromSite` 统一过 `surface()` 修复 |
| A-03 | 建筑可压在红线上 | I01 有楼探出红线 738 m² | 归属块"吸收整栋楼"会把地块顶出父边界 → 越界。已改为只吸收红线内那部分 |
| A-04 | `polygon-clipping` 在"共线但不完全重合"的边上抛 `Unable to complete output ring` | 地块减掉建筑后再与该建筑求交，必然踩中 | 精确求交不可作为唯一判据；已加采样降级的 `overlapAreaM2`（仅用于**测量**，不用于修改几何） |
| A-05 | `frontagePartition` 的逐刀独立抖动会让切点非单调 | G03 旧·沿街网格残留 1091 m² / 6.6% | 旧方案的"面积对账"天生不成立，对照表里如实呈现 |

---

## 6. 复现方式

```bash
npx tsc --noEmit                          # 类型检查
npx tsx test/subdivision-golden.ts        # 8 类 Golden + 旧方案对照（89 项断言）
npx tsx test/subdivision-production.ts    # R01/C01/I01 生产场景（39 项断言）
node  test/subdivision-png.mjs            # SVG → PNG
```

产物：`out/subdivision/G01..G08.{svg,png}`、`out/subdivision/prod-*.{svg,png}`、`metrics.json`、`production.json`。
