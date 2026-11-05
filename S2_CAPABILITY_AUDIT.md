# S2 能力审计（S2_CAPABILITY_AUDIT）

> 生成时间：2026-11-05 · 依据：三份源码实测 + 21 个真实地块的 Placemaker 运行结果
>
> **本文所有"已支持"都附了证据**（跑过的命令、输出的数字、文件行号）。
> 只按 README 或 JSON 里的 `implementation.state` 声明就写成"已实现"的条目，一条都没有。

---

## 0. 一句话结论

| 能力 | 真实状态 |
|---|---|
| Placemaker C# Core | **能独立跑，能出真实几何**（21 个真实地块全部成功，中位 753 ms） |
| 8 种停车 Pattern | Placemaker 全部能出**数据**；但只有 3 种能在 TownForge 里**看出来**（受我们的可视化契约限制） |
| 29 种场地骨架 | **6 种**能出几何（复用 5 个 S1 Builder），其余 23 种是纯数据 |
| Pattern Registry | 可用（真地块 → 量指标 → 选 2~3 套 → 筛 S1 候选） |
| 联合生成 | 已打通：Pattern → S1 → ParkingZone → Placemaker → Ground → SceneIR |

---

## 1. 场地骨架能力（29 种）

### 1.1 判定口径

- **supported**：有 S1 Builder 实现了同一套空间语法（临街、主通道位置、建筑排布方式都对得上）。
- **partial**：能借已有 Builder 出一个**近似**方案，但语法上缺东西（少了围合/多翼/双排店面等）。
- **data-only**：只有 `signature` 描述，没有对应几何能力，**不得进入生产候选**。

### 1.2 归类结果

| # | pattern id | 用地 | 状态 | 落到哪个 Builder / 缺什么 |
|---|---|---|---|---|
| 1 | `mf_perimeter_court` | MF | **supported** | `sk-mf-court`（侧脊 + 四边围合 + 尽端停车） |
| 2 | `mf_internal_garden` | MF | partial | `sk-mf-rows`（平行板楼 + 绿廊）；缺"内部主轴 + 主轴两侧串联"这件事 |
| 3 | `mf_external_rows` | MF | partial | 同上；缺"多组团各自向街巷开口" |
| 4 | `mf_podium_court` | MF | partial | `sk-mf-court`；**裙房语法完全没有** |
| 5 | `mf_single_side_spine` | MF | partial | `sk-mf-rows` 在窄地块上自然退化（实测 MF 226×236 不触发） |
| 6-8 | `sf_*`（3 种） | 独栋 | **data-only** | S1 没有独栋 Builder；现有 `singlefamily/grid.ts` 未被 S1 接管 |
| 9 | `retail_frontage_rear_park` | 商业 | **supported** | `sk-ret-rear-park` |
| 10 | `retail_anchor_parking_court` | 商业 | partial | `sk-ret-front-park`；缺"主力店 + 外圈 pad" |
| 11 | `retail_lifestyle_street` | 商业 | **data-only** | 步行商业街（多排店面夹步道）没有 Builder |
| 12 | `retail_strip_shared_park` | 商业 | partial | `sk-ret-rear-park`；只有单排店面 + 单条车道，缺"双排共享停车" |
| 13 | `retail_pad_court` | 商业 | data-only | 独立 pad + 小停车没有 Builder |
| 14 | `ind_single_loaded` | 工业 | **supported** | `sk-ind-front-wh` |
| 15 | `ind_mixed_yard` | 工业 | **supported** | `sk-ind-rear-yard`（多厂房共享货场） |
| 16 | `ind_crossdock` | 工业 | partial | `sk-ind-rear-yard`；**双侧装卸完全没有** |
| 17 | `ind_infill_side` | 工业 | partial | `sk-ind-front-wh` 在窄带上退化 |
| 18 | `ind_perimeter_compound` | 工业 | partial | 缺"外围环路 + 集中厂房" |
| 19-21 | `hotel_*`（3 种） | 酒店 | **data-only**（对 S1） | S1 无酒店骨架；现有 `hotel/gurban.ts` 是独立 archetype |
| 22-23 | `dc_*`（2 种） | 数据中心 | **data-only**（对 S1） | 同上 |
| 24-25 | `civic_*`（2 种） | 公共建筑 | **data-only**（对 S1） | 同上 |
| 26-27 | `park_*`（2 种） | 公园 | 不适用 | 无停车、无建筑，S1 不接管（走原 archetype） |
| 28 | `green_continuous` | 绿地 | 不适用 | 同上 |
| 29 | `generic_simple_infill` | 兜底 | 不适用 | 回落到原 archetype |

**合计：supported 4 · partial 9 · data-only 13 · 不适用 3。**

> 注意 supported 是 4 而不是 6：`mf_internal_garden` 与 `ind_crossdock` 这类虽然能借到 Builder，
> 但**语法确实缺了一块**（内部主轴 / 双侧装卸），把它们算成 supported 是自欺。

### 1.3 data-only 怎么处理

`PATTERN_TO_SPEC`（`src/town/planning/patterns/registry.ts`）只列了 11 条映射，
覆盖上面 4+9 种；没有映射的 pattern 即使被 `selectSkeletons` 选中，
`specId` 也是 `null`，不会进生产候选。这是硬闸，不是注释。

---

## 2. 停车骨架能力（8 种 Pattern × 7 项检查）

判定依据是**实测**（`tools/bake-parking.ts --all` 跑出的 21 个真实停车区 + 4 个畸形多边形用例），
不是 `parking-patterns.json` 里的 `providerCapabilityMustBeProbed` 声明。

| Pattern | 车位排列 | 主车道 | 横向连接 | 入口接入 | 车道连通 | 景观岛 | 多边形适配 | 落地结论 |
|---|---|---|---|---|---|---|---|---|
| `pk_double_loaded` | ✅ 双侧 | ✅ | ✅ `CrossEvery` 默认 9 位一条 | ✅ `driveConnector` | ✅ 21/21 单分量 | ✅ grass 面 | ✅ 楔形/L 形/障碍都出图 | **可用** |
| `pk_single_loaded` | ✅ 单侧 | ✅ | — | ✅ | ✅ | ✅ | ✅ | **可用** |
| `pk_edge_offset` | ✅ | ✅ 外围优先 | ✅ | ✅ | ✅ | ✅ | ✅（窄于 15 m 时退化） | **可用** |
| `pk_free_shape_multi_axis` | ✅ 多轴 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 实测 L 形出 2 条 connector | **可用** |
| `pk_landscaped_loop` | ✅ | ✅ 环通 | ✅ | ✅ | ✅ | ✅ | ✅（150×100 用例 22 个绿岛） | **可用** |
| `pk_multiwing_connectors` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ L 形用例 2 条 connector | **可用** |
| `pk_angled_oneway` | ⚠️ 需 `stallAngle=45/60` | ✅ | ✅ | ✅ | 未单独实测 | ✅ | 未单独实测 | **可配置，未验收** |
| `pk_minimal_pad` | ✅ 小面积极值 | ✅ 单车道 + 回车 | — | ✅ | ✅ | ⚠️ 面积小时无 | ✅ | **可用，但 < 440 m² 出 0 位** |

### 2.1 三条硬边界（实测，不是推测）

1. **面积下限**：440 m² 才开始出车位（22×20 m → 2 位）；324 m²（18×18 m）`ready=true` 但 **0 位**。
   所以 MF（290/196 m²）与工业（221/343 m²）三个 Golden 里有**两个根本没有资格用 Placemaker**。
2. **宽度下限**：12 m 宽的窄条 `ready=false`；15 m 可以（单侧排）。
3. **`stats` 不是实存量**：带障碍时 `Stat.Stalls=313` 而 `objects[parkingBay]=248` ——
   **统计读 stats 会高估 26%**。所有车位数一律数 `objects`。

### 2.2 两套 Provider 的能力差

| 维度 | legacy `solveParking` | Placemaker |
|---|---|---|
| 边界 | 矩形优先（`boxes` 网格） | 任意简单多边形 |
| 排角度 | 0/30/45/60/90 固定档 | 同样 4 档，但按边自动选 |
| 多轴（同一场地不同区域不同朝向） | ❌ | ✅ |
| 景观岛 | 自己按"每 6 位一条树池"切 | Core 直接产出 `grass` 面 |
| 车道 | **不产车道几何**（只产通道多边形，且 Realizer 不画） | 产出 `driveAisle` + `driveConnector` 网络（带拓扑） |
| 车位前缘贴车道 | 100%（构造保证） | 100%（21/21 实测中位） |
| 速度 | ~5 ms | 753 ms（中位，含 ~90 ms 冷启动） |

---

## 3. Placemaker 复用能力（真实状态）

### 3.1 能不能独立跑 —— 能

```
dotnet tools/placemaker/bin/PlacemakerDriver.dll --emit <case.json> <plan.json>
```
- `dotnet 6.0.428` 在 PATH 上；apphost `.exe` 找不到 runtime（只装了 SDK），
  所以**必须用 `dotnet <dll>` 而不是直接跑 exe**。这条踩过一次。
- 编译产物已收进仓库：`tools/placemaker/bin/`（4 MB，`PlacemakerCore.dll` + Driver）。

### 3.2 输入契约（`Emit.cs::BuildInput` 逐字段读出来的）

| 字段 | 类型 | 说明 |
|---|---|---|
| `generator` | string | 固定 `"parking"` |
| `seed` | number | 确定性 |
| `shape.ring` | `[[x,z],…]` | 米；**单环，不支持洞** |
| `streets[]` | `{id,a,b,width,sidewalk,speed,category}` | 入口建议的依据；**没有就 ready=false** |
| `obstacles[]` | `{kind, quad:[[x,z]×4]}` | **只能四边形**；缺口在调用侧拆 |
| `settings` | object | `aisleWidth` / `stallWidth` / `stallLength` / `stallAngle` / `greenery` / `medianDepth` / `crossEvery` / `perimeterRoad` … |

**上游不支持的字段（必须显式记录，不能假装生效）**：

- ✗ **环上的洞（holes）**：`AreaShape.Ring` 是单环。要表达"建筑挖洞"只能走 `obstacles`，
  而 `obstacles` 只吃四边形、且处理方式是 `SiteSafety.Apply **事后裁剪**`
  （日志："避让: 压界 1 块, 丢 134 条 / 裁 13 环"）。
  这正好落进任务书禁止的做法（"不得先铺满车位再粗暴裁掉"），
  **所以 S1 必须先交出不含障碍的合法 ParkingZone**，这是设计约束不是实现细节。
- ✗ 多环/多面形状：一次只能一块。
- ✗ 渐收边界的"曲线"：只认折线。
- ✗ 建筑高度、用地性质、开发强度：Core 完全不关心（它只管停车）。

### 3.3 输出契约（`Emit.cs::Serialize` 实际产物）

| 字段 | 内容 | 我们怎么用 |
|---|---|---|
| `ready` | Core 自评 | 直接作为 provider 是否成功的第一道闸 |
| `surfaces[]` | `{role, ring}`，role 只有 `asphalt` / `grass` | asphalt → 停车区底色；grass → `parking_island` |
| `nets[]` | `{role:'driveAisle'\|'driveConnector', a,b,c,d}` | 中心线被切成 3 段；**相邻段共享端点** |
| `objects[]` | `{role:'parkingBay', x,z,yaw,scale}` 等 | 车位标记线由 (中心, yaw, 宽 3.0 m) 反推 |
| `stats[]` | `[{key:'Stat.Stalls', value}]` | **只做交叉校验，不当车位数** |
| `areas[]` / `regions[]` | 场地环 / 分割面 | 暂未消费 |
| `issues[]` | 如 `Issue.PerimeterRoadDropped` | 记进诊断报告 |

**没有的东西**（不能说它给了）：

- ✗ 车位编号 / 无障碍分布 → 只有 `Stat.AccessibleStalls` 一个数
- ✗ 车道宽度几何 → 只有中心线，宽度要自己按 `aisleWidth` 补
- ✗ 车道与车位的显式关联 → 只能靠"车位中心到车道中心线距离 ≤ 车深 + 1.2 m"判定
- ✗ 标记线几何 → 只能从 `objects[parkingBay]` 反推
- ✗ 景观岛之外的绿地（边界绿化、缓冲带）→ 这些跟停车无关，仍是 TownForge 自己铺

### 3.4 真实阻塞项

| 阻塞项 | 影响 | 现状 |
|---|---|---|
| 浏览器不能起 .NET | 实时求解不可用 | 走**离线烘焙 + 几何哈希查表**（`tools/bake-parking.ts`），查不到就告警回退 |
| 面积 < 440 m² | 小停车区排不出 | 回退 legacy，**不静默**（`PARKING_BAKE_MISS` 告警写明原因） |
| 洞口只能靠 obstacles 事后裁 | 违反"不得先铺满再裁" | S1 保证 ParkingZone 无建筑，实测 21/21 无 obstacles |
| 单次 750 ms | 全城 47 块 ≈ 35 s | 只烘焙、不实时；烘焙一次 43 s 可接受 |

---

## 4. 已存在的、可直接接线的能力

1. `SiteContext.primaryFrontage / buildableArea` —— Pattern 量指标的全部依据（`measureSite`）。
2. `skeleton/spec.ts` 的 `crossSection / streetSpan / laneReach / spanAt` —— 已有，直接用来算有效宽度。
3. `ranker.ts` + 两个 JSON —— 原样复制进 `src/town/planning/patterns/`，一行没改。
4. `realizeParkingRequests` 的 `ParkLayout` 契约 —— Placemaker 结果可以完整填进去，Realizer 零改动。
5. `tools/bake-plan.ts`（旧项目）的烘焙思路 —— 已有先例，本轮照做。

## 5. 需要补充适配的

1. **`driveAisle` → 车道几何**：现在只用来算连通性，没有生成车道面。要画出来得做折线缓冲 + 并集。
2. **车位标记线去重**：一辆车贡献一条边，相邻车位共用边，目前靠端点取整去重（316 → 313 条）。
3. **45°/60° 斜列**：`stallAngle` 能传，但没有单独验收过。
4. **洞口场景**：`obstacles` 路径能用，但会退化（丢车位），没有量化的质量基线。

## 6. 不建议做的事

- 不建议重翻 C#：465 个文件已经跑通，重翻只会引入一致性风险。
- 不建议给 29 种 pattern 各写一个 Builder：其中 13 种连语法都缺（见 §1.2），
  写了也只是拿同一个 Builder 换个名字。
- 不建议把 Placemaker 接进浏览器实时链路：进程模型对不上，烘焙已经够用。
