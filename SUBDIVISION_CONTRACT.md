# F2 · 统一分割契约（SUBDIVISION CONTRACT）

> 代码位置：`src/town/planning/subdivision/`
> 本文是**唯一**的合同说明。任何策略、任何调用方都以本文为准；实现与本文冲突时，以实现为准并回改本文。
> 状态：F2.1 已落地（Recursive OBB / Street-front Offset 两个策略按此合同接入）。

---

## 0. 一句话

**策略只负责"生成候选"；验证、评分、落面、审计全在策略之外。**

这条分工是"可组合"的全部前提。任何一条被破坏（策略自己判自己及格、策略自带一套临街口径、策略直接改 Scene），多策略就再也无法横向比较。

---

## 1. 类型总览

```
SubdivisionContext   输入：一块待分割的场地（红线 + 可建区 + 真实道路 + 固定建筑）
SubdivisionParams    参数：全部以 米 / 平方米 表达
       ↓
SubdivisionStrategy.generate()          ← 唯一的策略入口
       ↓
SubdivisionCandidate[]                  ← 唯一的数据合同（策略不得扩展字段）
       ↓
validatePartition()  →  ValidationReport   ← 唯一的裁判
       ↓
SubdivisionRun       →  统计 + 树 + 备注    ← 报告与图表都读这一份
```

文件对应：

| 文件 | 职责 | 不许做的事 |
|---|---|---|
| `types.ts` | 合同类型 | 不放算法 |
| `geom.ts` | 几何原语（OBB / 面级切分 / 共享边界 / 重叠测量 / 确定性随机） | 不做"该不该切"的判断 |
| `relations.ts` | 临街与接入 | 不虚构道路，不判可建性 |
| `metrics.ts` | 指标 | 不改几何 |
| `assemble.ts` | 叶子面 → 候选（含建筑归属、巷接网络） | 不切分 |
| `validate.ts` | 硬约束裁判 | 不修几何 |
| `repair.ts` | 碎片连通合并 | 不做非连通合并 |
| `strategies/*.ts` | 只产叶子面 / 候选 | 不判自己及格 |
| `registry.ts` | 运行器（计时 + 验证 + 统计） | 不含策略逻辑 |

---

## 2. 输入合同：`SubdivisionContext`

```ts
interface SubdivisionContext {
  id: string;
  parentId: string;
  typology: SiteTypology;
  mode: 'fixed_buildings' | 'vacant';
  boundary: PlanSurface;       // 红线（含 holes）
  buildable: PlanSurface;      // 退线后可建区
  roadEdges: SiteRoadEdge[];   // 只含**真正相邻**的道路边
  fixedBuildings: PlanSurface[]; // 不可移动、不可切开
  existingAccess?: { kind; at; from? }[];
  seed: number;
  notes: string[];
}
```

**四条硬规则：**

1. `boundary` 与 `buildable` **必须都给，不能混用**。
   分割在红线上做（临街面与红线对齐），"能不能建"按可建区判。旧实现 `subdivideByFrontage` 直接在可建区上切，切出来的地块不再贴街，只能事后猜临街 —— 这是 `edgesForPiece` 造假路的根因。
2. `roadEdges` 里**只许放真实道路边**。没有真路就不放，绝不允许插入"虚拟巷道边"。
3. `fixedBuildings` 在 `mode='fixed_buildings'` 下**不得为空**；反过来 `mode` 会由建筑是否存在自动推断。
4. 所有面进入上下文前统一过 `surface()`（`cleanRing`）。真实数据的建筑轮廓常带相邻重复点，不清理会让 `polygon-clipping` 直接抛错，而布尔是 `catch → 返回 []` —— 静默归零，最难查的一类 bug。

---

## 3. 参数合同：`SubdivisionParams`

单位**一律米 / 平方米**（世界单元换算只在策略内部发生一次：`U(m) = m/7`）。

| 参数 | 含义 | 默认来源 |
|---|---|---|
| `targetAreaM2` | 递归停止的主判据 | `SUBDIVIDE[typology].frontageM × maxDepthM` |
| `frontageM` | 目标沿街面宽 | `SUBDIVIDE` |
| `depthM` | 目标进深 | `SUBDIVIDE` |
| `minAreaM2` | 碎块阈值（小于它不成独立地块） | 200（规范：< 200 m² 视为碎渣） |
| `minWidthM` | 最小有效宽度（低于它算残片） | 12.5（Maitland：450 m²+ 地块下限） |
| `maxAspect` | 长宽比上限 | 3 |
| `alleyM` | 巷道最小宽，同时是**开口最小面宽** | 6（规范：共享庭院/通道 ≥ 6 m） |
| `maxRecursion` | 递归层数上限 | 4 |
| `ratio` | 指定切分比例（非均匀） | 不填则按目标面积反推 |
| `cornerBonusM` | 街角地块加宽 | 4 |
| `jitter` | 切点抖动比例（0~0.15） | 0.05 |
| `rearPolicy` | 后排处理：`compound` / `obb` | `compound` |

**禁止**在策略内部写死面宽/进深数字：那会让面板上调完参数后代码里还有一份"真正的值"。

---

## 4. 策略接口

```ts
interface SubdivisionStrategy {
  readonly id: string;
  readonly label: string;
  supports(ctx: SubdivisionContext): ApplicabilityResult;   // 适用性，不是"能不能跑"
  generate(ctx: SubdivisionContext, params: SubdivisionParams): SubdivisionCandidate[];
  readonly diagnostics: StrategyDiagnostics;                // 仅报告用，不是合同
}

interface ApplicabilityResult { applicable: boolean; score: number; reasons: string[] }
interface StrategyDiagnostics { axisHints: {ang;label}[]; tree: CutRecord|null; notes: SubdivisionNote[] }
```

**`supports` 的语义**：不是"代码会不会崩"，而是"跑出来会不会**比整块更好**"。
例：无相邻道路边时，任何切法都拿不到合法入口 → `applicable=false`，理由是"无相邻道路边"，而不是返回一条空数组。

**`diagnostics` 的纪律**：只读、只在 `generate` 之后有效、每次 `generate` 必须重置。它不属于数据合同 —— 消费者不得据此做几何决策。

---

## 5. 候选合同：`SubdivisionCandidate`

策略**只能**产出这个结构。字段逐条对应任务书要求的"候选必须输出"：

| 任务书要求 | 字段 | 说明 |
|---|---|---|
| 生成方法及参数 | `method` + `methodParams` | 可复现的最小参数集 |
| 完整 Polygon / holes | `surface`（`outer` + `holes`） | 世界坐标；洞不许丢 |
| 临街关系 | `frontages[]` | `roadKey` / `cls` / `role` / `lengthM` / `share` / `edge`，巷接用 `viaSibling` 标 |
| 实际接入关系 | `access[]` | `kind` / `at` / `normal` / `via: road\|alley\|existing` / `requiresInternalLane` |
| 父地块 ID | `parentId` | |
| 相邻关系 | `neighbors[]` | `id` + `sharedBoundaryM`（米） |
| 几何指标 | `metrics` | 见 §6 |
| 可建/可使用区域 | `usable` | 本块 ∩ 可建区 − 固定建筑 |
| 拒绝/修复原因 | `notes[]` | `code` + `severity` + 人话 + 位置 |

补充字段：

- `role`：`parcel`（可独立开发）/ `fragment`（内部功能子区）/ `compound`（多建筑组团）/ `reserved`（主动保留）
- `developable`：能否独立开发（有接入 + 面积/宽度达标）。**`role='reserved'` 永远是 false**
- `cut`：切分树节点（只有递归类策略有）

**语义分层（产品定位，不是法定宗地）：**

```
Block（城市道路围合的街区）
  └ Parcel（临街 + 接入 + 用途的地块）
      ├ Fragment（地块内部功能子区，不独立）
      ├ Compound（可含多栋建筑 + 共享空间的组团）
      └ ReservedSpace（主动保留的公共/生态/未设计区域）
```

`reserved` 与"接不进去"是两件事：前者是主动决策，后者必须报 `no-access` 错误。

---

## 6. 指标口径：`PieceMetrics`

全部米 / 平方米。**两套尺寸口径故意并存**，因为它们回答不同问题：

| 字段 | 口径 | 用途 |
|---|---|---|
| `widthM` / `depthM` | 策略局部系（沿街 / 进深） | 规划意义：面宽、进深 |
| `obbWM` / `obbDM` | 最小面积外接矩形短边 / 长边 | 几何意义：跨策略可比、可复现 |
| `bottleneckM` | 2 × 最大内切圆半径 | **L 形地块的真实可用宽度** |
| `aspect` | 长边 / 短边 | 狭长诊断 |
| `compactness` | 4πA / P² | 形状规整度（正方形 = 0.785） |
| `acuteCorners` | 内角 < 30° 的顶点数 | 尖角诊断 |
| `frontageM` / `frontageShare` | 真实临街长度 / 周长占比 | **有效临街比例** |
| `holeCount` / `holeAreaM2` | 洞的数量与面积 | 洞保留验证 |

**残片判据只有一条公式**（`isFragment`）：`area < minAreaM2 || bottleneck < minWidthM`。
不许在别处再写一套"看起来像残片"的判断。

---

## 7. 硬约束（`validatePartition`）

顺序固定、结果可复现。任一 `error` → `ValidationReport.ok = false`。

| # | 检查 | 判据 | 级别 |
|---|---|---|---|
| ① | 不越出父边界 | `area(piece − parent) > 1 m²` | error |
| ② | 子块互不重叠 | 两两 `intersect > 1 m²`（先 AABB 筛） | error |
| ③ | 洞仍是洞 | 洞内探针（质心 + 各顶点 40% 处）不被任何地块覆盖 | error |
| ④ | 无自交 | `selfIntersects`（父级本来就自交时降级 warn + 标注"继承"） | error / warn |
| ⑤ | 面积可对账 | `residual = parent − union(pieces)`，> 0.5% 且未被 `reserved` 显式认领 | error / warn |
| ⑥ | 固定建筑不被切开 | 一栋楼被 ≥ 2 块地各覆盖 > 2 m² | error |
| ⑦ | 固定建筑有归属 | 一栋楼覆盖 < 98% 落在单一块内 | error / warn |
| ⑧ | 无接入必须标记 | `access.length === 0`：`parcel` → error；`fragment`/`compound`/`reserved` → warn | 分级 |
| ⑨ | 布尔异常可观测 | `geometryFailures` 计数增量 > 0 | warn |

**为什么 ④⑧ 分级**：父场地本身自交（实测 `-469:284`）或"非独立地块"没有入口，都不是本轮引入的错误。一刀切会把整轮验证判死，反而看不出真正的几何问题。但两者都必须**带文字进报告**，不许静默。

---

## 8. 确定性

- 每个策略用 `makeRng(seed, tag)`（mulberry32 + 字符串哈希）派生**私有随机流**，不许碰全局 `Rng`。理由：全局流被城市生成器共用，地块分割多抽一次会让整城错位。
- `fingerprint(candidates)` = 每块 `面积×10 : 临街长度×10` 排序后拼接。同输入同 seed 必须相等 —— 这是"相同输入和 Seed 输出一致"的可执行判据。
- 所有候选排序必须**显式**给出次要键（如 `sharedBoundaryM desc, id asc`），不许依赖 `Map`/对象键序。

---

## 9. 接入规则（唯一一份，`assemble.ts`）

```
① 有真实临街（共享长度 ≥ alleyM）        → 路上开口：车行 + 人行（+ 第二条临街面给服务/货运）
② 无临街 → 巷接网络 BFS：
     边 = 共享边界 ≥ alleyM；种子 = 有路上接入的块
     分配 via='alley' + viaSibling + requiresInternalLane=true
     链路深度 > 1 → warn（需要连续两段以上内部通道）
③ 都覆盖不到 → 不造入口，报 no-access
```

**禁止**：把巷接写成 `roadEdges` 的虚拟边（旧 `edgesForPiece` 的做法）。巷接是一个必须被下游真正铺出来的工程承诺，不是一个字段。

---

## 10. 策略实现的五条禁令

1. **不许自造数据合同**：候选只能用 §5 的字段，附加信息进 `notes` 或 `diagnostics`。
2. **不许自己判及格**：策略内部可以做**局部**可行性检查（"这一刀值不值得"），但最终合法性只由 `validatePartition` 裁定。
3. **不许丢掉洞**：所有切分必须走 `splitSurfaceByLine`（面级）或 `surfaceIntersect`（保洞）。
4. **不许只留最大块**：凹形地块一刀可能切出多块，必须全部保留（`bisectRing` 只留最大块是已记录缺陷）。
5. **不许用填绿掩盖失败**：切不出来的空间只能标 `fragment` / `reserved` 并报原因，不许铺成绿地当"处理完了"。

---

## 11. 新增策略的最短路径

```ts
export class MyStrategy implements SubdivisionStrategy {
  readonly id = 'my-strategy';
  readonly label = 'My Strategy';
  diagnostics: StrategyDiagnostics = { axisHints: [], tree: null, notes: [] };

  supports(ctx) { /* 面积/形状/临街是否值得切 */ }

  generate(ctx, params) {
    this.diagnostics = { axisHints: [], tree: null, notes: [] };  // 必须重置
    const leaves: LeafInput[] = [];      // 只产叶子面
    // … 用 geom.ts 的原语切分 …
    return assemble(ctx, params, this.id, leaves).candidates;      // 收口交给 assemble
  }
}
```

`assemble` 会替你做：临街量化、接入网络、固定建筑归属、可用区裁剪、指标计算、邻接、角色判定。
策略里**不要**再写这些 —— 否则两个策略的数字就不可比了。
