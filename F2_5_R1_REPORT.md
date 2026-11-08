# F2.5-A/B/C · 道路中心线系统重构（第一轮）

**审计 + 破碎 → 合并 → 中心线图 原型** ｜ 2026-11-06 ｜ 仅实验入口，未接生产链路

---

## 0. 一句话结论

旧系统**有**中心线和拓扑，但中心线只是"两点直线"、宽度由地块退让反推、路口靠事后拼片；
新系统把顺序倒过来：**先破碎成 cell → 合并 cell（删边）→ 剩下的边才是路 → 才铺路面**。
街区因此是"被路围合出来的"，不是"被路啃过的碎块"。

---

## 1. F2.5-A 审计：旧系统到底有什么

### 1.1 逐个问题的答案（`文件:行号`）

| 问题 | 事实 |
|---|---|
| 1. 有没有边/节点/路径坐标 | **有**。`road/system.ts:33 RoadEdge{a,b,dir,len,insetL,insetR,…}`；`road/system.ts:126 RoadNet{edges, junctions, nodeEdges:Map<Pt,number[]>, nodeJunction}`。节点是**匿名 `Pt`**（Map 键就是点对象），没有 id、没有类型。路径坐标 = `a`+`b` 两个点 |
| 2. 哪些路来自中心线 | **全部来自地块边界的缝**：`road/system.ts:262-293` 遍历 patch 的环边，两侧都有 ward 的边才成为路（`:299`）。所以"中心线"是地块角的连线 |
| 3. `visibleSpan` / 路口圆盘 / 转角补片 | `visibleSpan:733`（按 `padA/padB` 把条带在路口处**收起来**）；`junctionGeom:1652`（路口多边形：逐臂推到收口线 + `cornerOf` 圆角弧）；`cornerPaving:1372`（街角铺装补片）；`roadSurfaces:838` 还要"按几何邻近（NEAR=3.0）裁掉压在别的路口上的条带" |
| 4. 城市级与园区内部路是否共享几何 | **不共享**。城市级走 `RoadNet`；园区内部路是 `compose/types.ts:50 InternalRoad{centerline, surface}`，另一套，只用 `synthesicEdges` 伪装成 `SiteRoadEdge` 喂给临街判定 |
| 5. 可直接迁移的消费者 | `roadSurfaces`（条带构造）、`offsetLine/bandBetween`、`spec.ts` 断面表、`markings.ts` 标线、`scene/build.ts` 的 SceneIR 出口 |
| 6. 2D/3D/GLB 如何拿道路几何 | **同一个出口**：`scene/build.ts:109 roadSurfaces(net, scene.surfaces)`，2D、three.js、GLB 都读 Scene —— 这条旧系统是对的，必须保留 |
| 7. 宽度从哪来 | **从面片反推**：`road/system.ts:330 model.insetForEdge(L,R)` → `makeSection(insetL,insetR,cls)`（`:154`）。这正是任务书要纠正的点 |

### 1.2 当前道路数据流

```
Model.patches[].shape 环边
      │  buildRoadNet()  —— 只留"两侧都有 ward"的边
      ▼
RoadNet { RoadEdge{a,b,insetL,insetR,...}, nodeEdges:Map<Pt,[]>, junctions }
      │                         │
      │                    insetForEdge()  ← 宽度在这里反推
      ▼
roadSurfaces()
   ├─ 逐边条带（offsetLine/bandBetween）
   ├─ visibleSpan() 把条带在路口处收起
   ├─ junctionGeom() 路口多边形 + cornerPaving() 转角补片
   └─ 再用几何邻近裁掉"压在别的路口上"的条带
      ▼
Scene (SceneIR) ──► 2D canvas / three.js / GLB
```

问题不在出口，在源头：**边来自地块缝、宽度来自退让、路口靠事后拼**。

### 1.3 新 `RoadCenterlineGraph` 数据流

```
生成范围 Polygon/MultiPolygon + 风格预设 + seed
      │
      ├─ fractureVoronoi / fractureObb      → cells[] + cuts[]（候选，不是路）
      │
      ├─ mergeCells()                        ← F2.5-C 核心：删弱边
      │      · 短边（< weakEdgeM）优先合并掉
      │      · 长边（> strongEdgeM）与"保护线"永不合并
      │      · 合并后跨街区的边自动作废
      │      · 结果是 blocks[] + keptCuts[]
      │
      ├─ classifyRoads()                     → arterial / collector / local + 路幅
      │
      ├─ buildGraph()                        ← F2.5-B 核心
      │      相交打断 → 节点吸附 → 剪短边 → 合并共线 → Chaikin 平滑（端点不动）
      ▼
RoadCenterlineGraph { RoadNode{id,position,type}, RoadEdge{centerline[],class,width} }
      │
      ├─ buildRegions()  → 街区（blocks 减去路面）+ 邻接 + 临街长度 + 朝向
      └─（F2.5-D 待做）→ 车行道 / 路口 / 路缘 / 人行道 / 绿带 / 标线，全部从这一份 Graph 派生
```

Graph 只依赖 `Pt` 与 `PlanSurface`，不 import Three/Canvas/SceneIR。

### 1.4 旧字段 → 新字段迁移表

| 旧（`road/system.ts`） | 新（`roadgraph/`） | 说明 |
|---|---|---|
| `RoadEdge.a` / `.b` | `RoadEdge.centerline[0] / [-1]` | 端点改由路径两端表达 |
| `RoadEdge.dir` / `.len` | 由 `centerline` 现算（`edgeLengthM`） | 不再冗余存储 |
| `nodeEdges: Map<Pt, number[]>` | `RoadGraph.adjacency: Map<string, string[]>` | 匿名 `Pt` → 命名 `RoadNode.id` |
| 无节点类型 | `RoadNode.nodeType` = intersection / terminal / boundary / entrance | 出图与验收要用 |
| `RoadEdge.insetL/insetR → makeSection()` | `RoadEdge.widthM` + `design.section` | **宽度自带**，不再反推 |
| `RoadEdge.cls: arterial/collector/local` | 同名 + `internal` | 与园区内部路统一 |
| `visibleSpan` / `padA/padB` / `shortA/shortB` | 节点的 `centerline` 端点 + 路口多边形（F2.5-D） | 收口不再靠"裁条带" |
| `Junction.arms/corners` | 由 Graph 的度 ≥3 节点派生（F2.5-D） | 路口 = 拓扑事实，不是补片 |
| `InternalRoad.centerline`（compose） | `RoadClass='internal'` 的 `RoadEdge` | 两套合并成一套 |

### 1.5 调试图（真实现有场景）

`out/f25/A_legacy_centerlines.png`：R01 周边 260 m，71 条边 / 67 个图顶点 / 8 个路口。
能直接看到旧系统的性质：**地块边界是弧的，中心线却是直的弦**（`a→b`），
所以"路"和"地"在曲率上天生对不齐 —— 这就是路口生硬、条带要收口的根源。

---

## 2. F2.5-B/C 第一轮结果

管线：`fractureVoronoi → mergeCells → classifyRoads → buildGraph → buildRegions`

| 样板 | cell | 候选切线 | 保留为路 | 合并次数 | 街区 | 节点 | 交叉 | **悬空** | 连通分量 | 密度 m/ha |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| F01 规则矩形 140×98 | 8 | 14 | 8 | 4 | 4 | 8 | 4 | **0** | 1 | 209 |
| F02 狭长楔形 160×26 | 4 | 3 | 2 | 1 | 3 | 4 | 0 | **0** | 2 | 145 |
| F03 不规则 L 形 | 9 | 17 | 12 | 4 | 5 | 13 | 7 | **0** | 2 | 233 |
| F04 带洞街区 | 9 | 14 | 11 | 3 | 6 | 15 | 4 | **0** | 4 | 235 |
| R01 住宅 | 11 | 18 | 15 | 2 | 9 | 16 | 6 | **0** | 2 | 252 |
| C01 商业 | 7 | 11 | 10 | 1 | 6 | 12 | 5 | **0** | 2 | 242 |
| I01 工业 | 4 | 5 | 3 | 2 | 2 | 4 | 2 | **0** | 1 | 186 |

耗时：单样板 8~60 ms（破碎 + 合并 + 图清理 + 街区），远低于任务书给的"可以变慢"的余量。

**图**（`out/f25/`）：每样板 5 层 + 3D，另有三种街区并排与三种风格并排。

---

## 3. 这一轮没做 / 做得不好的

1. **F2.5-D 完全没做**：路面还是"中心线条带直接缓冲"，没有统一的**路口多边形**、路缘、人行道、绿带、标线。第 ④ 层看到的黑色路口是条带在端点重叠出来的，不是构造出来的。
2. **连通分量 > 1**：F02/F03/F04/R01/C01 都是 2 个分量，F04 是 4 个 —— 被洞和薄端切开的边自成一撮。任务书要求"主道路连续"，这一条**尚未达标**。
3. **街区数量偏少**（4~9 块）：这是破碎密度参数（cell 1800~3600 m²）决定的。这轮把它调到"街区尺度"，但一个 1.4 ha 地块只有 4 块街区，视觉上仍偏空 —— 街区内部还要靠 F2.1 再切地块。
4. **短边保护不够**：`保留为路` 里仍有几段 20~30 m 的边，端点接在别的路的中间（T 型），视觉上是短毛刺。理想的处理是"要么延长成完整路口，要么并回去"，这轮没做完。
5. **楔形样板（F02）最弱**：26 m 宽的地，一条 7 m 路横切就把断面吃掉 1/4，2 个分量的图明显不对。

---

## 4. 代码

```
新增  src/town/planning/roadgraph/types.ts    RoadNode / RoadEdge / RoadGraph（无渲染依赖）
新增  src/town/planning/roadgraph/fracture.ts Voronoi / OBB 两种破碎，输出 cells + cuts
新增  src/town/planning/roadgraph/graph.ts    打断 / 吸附 / 剪短 / 合并共线 / 平滑
新增  src/town/planning/roadgraph/select.ts   等级与路幅分级 + 三种风格预设
新增  src/town/planning/roadgraph/regions.ts  合并（删边）→ 街区 → 邻接/临街/朝向
新增  test/f25-draw.ts                        多层调试图渲染器
新增  test/f25-golden.ts                      7 个样板出图 + 三种街区/三种风格对照
新增  test/f25-audit.ts                       旧系统中心线调试图

未改动：src/road/*（旧系统保持原样，生产链路没碰）
```

---

## 5. 下一步（按任务书顺序）

1. **先修连通性**：破碎时按"距边界距离"分区，让每个分量都能接到边界（或人工指定入口）；目标是 `components = 1`。
2. **再做 F2.5-D**：路口多边形、路缘、人行道、绿带、标线全部从 Graph 派生；这一步才能消掉第 ④ 层那些黑色团块。
3. 街区内部接入 F2.1（地块切分），形成 Block → CompoundCell → BuildingGroup。
4. 通过后替换 `buildRoadNet` 的入口，但**保留 Scene 出口**（2D/3D/GLB 一致性）。
