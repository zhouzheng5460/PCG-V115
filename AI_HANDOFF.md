# TownForge · AI 交接文档

> 这份文档是写给**接手的 AI 开发工具**（Cursor / Claude Code / Codex 等）的。
> 读完这一篇就能开工，不需要先读根目录那 12 份历史 `PHASE_*_REPORT.md`。
>
> - 生成时间：2026-11-05
> - 仓库：`https://github.com/zhouzheng5460/PCG-V115`（分支 `main`）
> - 同步来源：本地工作区最后提交 `e41e30d` + 本轮未提交改动，已合并为一个提交推送
> - 更细的阶段叙事：`DEVELOPMENT.md`（§6.5 之后是 R-Scale / R1.4 / R1.5 / S1 / S2）

---

## 0. 30 秒跑起来

```bash
git clone https://github.com/zhouzheng5460/PCG-V115.git townforge
cd townforge
npm install
npx vite --port 5190        # 必须后台托管启动；(npx vite &) 会被 shell 回收
```

打开 `http://localhost:5190/`。默认是固定场景（seed 682063530 / n=15），但**默认停在 legacy 模式**；
要看本轮成果（Planner / 内部道路 / 停车实验）必须显式加参数：

```
http://localhost:5190/?mode=planner
http://localhost:5190/?mode=planner&patch=-469:284&zoom=46&hilite=1
```

```bash
npx tsc --noEmit                    # 类型检查，改完必跑
npx tsx test/planning-frontend.test.ts   # 175 条，最重要的一条回归
npx tsx test/<name>.test.ts         # 无测试框架，脚本自己打印 PASS/FAIL
```

**固定场景（所有数字都属于这一个，不要跨种子混用）**

```
seed 682063530 · nPatches 15 · plaza on
patch 52（其中 44 块 withinCity）· Planner 覆盖 47
三块 Golden：MF -469:284 / retail 176:176 / industrial 252:-578
```

**唯一必须记住的换算：1 世界单位 = 7 m。** 代码里 `const U = (m: number) => m / 7;`，
看到 `U(12)` 就是 12 m；反过来 `area × 49` 才是 m²。

**唯一的外部依赖：** 重烘停车布局需要 .NET 6 运行时（`dotnet --version` 实测 `6.0.428`）。
不重烘就不需要，仓库里已经带了烘焙产物。

---

## 1. 这是什么项目

纯前端城市生成器（TypeScript + Vite + Canvas 2D + three.js），无后端。管线是单向的：

```
Model（张量场 → patch → 用地分配）
  → RoadNet（边 / 路口 / 断面 / 标线）
  → Planner（每块地出 SitePlanCandidate：建筑 + 地面 + 停车 + 内部交通）
  → Realize（Candidate → SceneIR）
  → 2D 编辑器 / 3D 预览 / GLB 导出
```

2D、3D、GLB **都从 `buildScene()` 取同一份数据**，所以任何实验开关必须在
`SceneOptions` 这一层透传，否则三个视图会不一致。

---

## 2. 进度总表

| 阶段 | 状态 | 关键结论 / 数字 | 证据脚本 |
|---|---|---|---|
| Phase 0 → D | ✅ | Planner 覆盖 47/52，非法重叠 0 m²，真几何缺口 0% | `test/planning-frontend.test.ts` |
| R1.2-C | ✅ | 车行 + 服务合成一张网；**真实共享率 0%**（旧报告的 31%/30%/64% 是自计重复的假象） | `test/circulation.test.ts` |
| R1.3 | ✅ | 求解器接进生产（`adopt.ts` → `realizeSitePlan`），精确重叠 0 m² | `test/r1-3-adopt.test.ts`（35 条） |
| R-Scale | ✅ A 组 | 主干 28→24 m（六→四车道）、次干 20→18、缘石 18→12；道路 −11%、路口 −40% | `test/scale-diag.ts` / `scale-shadow.ts` |
| R1.4 | ✅ | 三档开关落地；47 = 生效 38 + 不适用 9 + **真失败 0**，适用覆盖率 100% | `test/r1-4-report.ts` |
| R1.5 | ⚠️ 部分 | 中心线 109/109=100%，但**最终路面可通行只有 38/109=35%**；停车场 aisle 4/32=13% | `test/r1-5-a.ts` / `r1-5-b.ts` |
| S1 骨架编排 | ✅ 默认关 | MF 评分 7.90→8.23、贴墙铺装 469→29 m²、碎片率 36%→14%；retail 7.17→6.88；industrial 持平 | `test/s1-report.ts` |
| S2 类型库 + Placemaker | ✅ 默认关 | 29 种骨架（4 supported / 9 partial / 13 data-only）；retail 同尺寸 116 位 vs legacy 78（+49%） | `test/s2-abc.ts` / `s2-polygon.ts` |
| S2.5 协同优化 | ✅ 默认关 | 采用率归因：MISS 17→0、采用率 18%→41% | `test/s2-5-diag.ts` / `s2-5-abc.ts` |
| S2.6 地面语义 | ✅ 默认关 | 推翻"retail 有无用尾端铺装"前提（无功能铺装 0 m²）；新增车位带 `stallBand` | `test/s2-6-ground.ts` |
| Phase M 形态场 | ❌ 未开始 | 7 处硬编码已定位（见 §5 P2-5） | `PHASE_0_AUDIT.md` |

**一句话现状：** 管线能跑、Planner 覆盖率满、内部道路全城已默认打开，
但"路画出来了 ≠ 车能开进去"——车位级可达性还没验，这是当前最大的洞。

---

## 3. 开关矩阵（动手前先看这一页）

生产默认 = `mode legacy` / `circulation all` / `s1 off` / `pattern off` / `parkingProvider legacy`。
**注意 `mode` 的默认是 `legacy`** —— 不带 `?mode=planner` 时，下面这些开关**全部不生效**，
这曾经导致"我改了参数但页面没变化"的误判。

| URL 参数 | 取值 | 默认 | 影响面 | 备注 |
|---|---|---|---|---|
| `?mode=` | `legacy` / `planner` / `shadow` | **`legacy`** | 谁来规划地块 | 所有实验开关的前提；`shadow` 只把 Planner 方案叠成红虚线 |
| `?circulation=` | `off` / `golden` / `all` | `all` | 内部道路求解器开哪些地 | **planner 模式下已默认全城**，不是实验开关 |
| `?s1=` | `off` / `golden` / `all` | `off` | 先车道后建筑的骨架流程 | 只对 MF/retail/industrial 有效 |
| `?pattern=` | `off` / `golden` / `all` | `off` | Pattern Registry 数据驱动选骨架 | 与 `s1` 有耦合，见 §6 雷区 4 |
| `?parkingProvider=` | `legacy` / `placemaker` / `compare` | `legacy` | 停车排布算法 | `placemaker` 走离线烘焙表，查不到就回退 legacy |
| `?scale=` | `base` / `A` / `B` / `C` | `A` | 道路断面与街区尺度 | **只有 A 可以当基线**，C 会重切街区使 Golden key 失效 |
| `?hilite=1` | — | 关 | 内部道路染橙红 | 纯表现层，不写回 Scene |
| `?cir=existing,new,merged,portals,unreach` | 逗号分隔 | 关 | R1 诊断覆盖层 | 截图核对用 |
| `?view=3d` | — | 2D | 三维预览 | 同参数下 3D 与 2D 必须看到同一份规划 |
| `?patch=<key>&zoom=&cx=&cy=` | — | 全城 | 视角定位 | 例：`patch=-469:284&zoom=46` |

**代码里的单一入口：** `src/scene/build.ts` 的 `SceneOptions`。
`app.ts` 只负责把 UI state 灌进去，**不要**在 `view2d.ts` / `view3d.ts` / `build3d.ts`
里各自读开关——那是上一轮 2D/3D 不一致的根因。

**快照（`#s=`）** 会存 `s1` / `ptn` / `pp` / `cm`（可选字段，默认组合不写），
所以分享链接不会"打开还是旧算法"。

---

## 4. 代码地图

```
src/core/geom.ts                 Pt / 向量
src/town/model.ts                张量场 → patch → 用地
src/town/landuse.ts              用地分配（半径分位数 + 临街等级）★ Phase M 要改这里
src/road/system.ts               路网拓扑（冻结，禁止重写）
src/road/spec.ts                 断面表（R-Scale 改过：主干 24 / 次干 18 / 支路 12）
src/road/scale-preset.ts         base/A/B/C 预设（诊断用）
src/town/patch.ts                patchKey（Golden key 就出自这里）
src/town/planning/
  core/                          ★ 冻结契约：types / candidate / surface / evaluator
  adapters/model.ts              Model → SiteContext（parcelOf 在这里）
  generators.ts                  唯一出口 generateCandidates()
  archetypes/                    九套地块语法
  typologies/                    各 typology 的权重 / 地面白名单 / 硬约束
  circulation/solver.ts          R1 内部交通求解器
  circulation/adopt.ts           solver → PlannedPath（source:'solver'），生产接入点
  skeleton/                      ★ S1 骨架（spec/builders/emit/metrics/index）
  patterns/                      ★ S2 类型库（29 骨架 JSON + registry + ranker）
src/town/parking/
  provider.ts                    ★ 两套 parking provider 的统一入口 + 烘焙表注册
  placemaker.ts                  C# 驱动的调用 / 几何哈希 / PM → ParkLayout
  baked/layouts.json             ★ 烘焙产物（255 KB，离线生成，勿手改）
src/town/realize/                顺序固定：road → ground → buildings → parking → circulation → scenery
src/scene/                       SceneIR 类型 / buildScene / planner-bridge / layers / palette
src/render/svg.ts, src/ui/       2D 渲染 + 编辑器
src/diagnostics/                 只读审计，不进网页热路径
tools/bake-parking.ts            ★ 烘焙 Placemaker 布局
tools/placemaker/bin/            ★ PlacemakerDriver.dll（4 MB，重烘才用得到）
test/*.test.ts                   回归；test/*.ts 里另有量尺脚本（见 §7）
```

**Realize 的顺序不能打乱**，`realizeRoads` 必须在 `realizeGround` 之前（路面决定红线裁剪）。

---

## 5. 待办（按优先级，每条带验收判据）

### P0-1 停车场内部可达性：Portal → 车位排（**最大缺口**）

- **现状**：R1 只连到停车区边界的 Portal，`"Portal → 车位排"` 从来没验证过，
  所以 R1.5 的第四个指标**不能标 PASS**。
- **已有材料**：`ParkLayout.aisles` 现在是**车道面多边形**（S2.5 由 `bufferPolyline()` 生成，
  写入 SceneIR 的 `*_pk_aisle_*`），不再是零散中线，可以直接当拓扑用。
- **做法建议**：aisle 面 → 中心线骨架 → 与 Portal 求连通 → 每个车位（`dividers` 的中点）
  吸到最近 aisle 段 → 逐位判可达。
- **验收**：输出"车位总数 / 可达数 / 不可达车位清单"，且不可达必须有理由
  （出口未接上 / 车位前缘被障碍占 / aisle 不连通），不能只有一个百分比。

### P0-2 内部道路"最终路面可通行"只有 35%

- **现状**：中心线 109/109 全连通，但按真实路宽铺出来之后只有 38/109 可通行
  （pedestrian 5% / service 58% / vehicle 43%）。
- **根因**：`snapToMain` 把起点吸到地块深处（MF 离街口 40 m），路径后段被建筑与
  红线裁掉；净空按"最终路宽一半"算（`ROAD_W`）之后仍有一批段落在不可建区。
- **验收**：对 47 块逐块输出"中心线连通 / 路面连通"两列，路面连通率 ≥ 80%，
  剩下 20% 必须给出地块级的物理原因（红线太窄 / 退线吃满）。

### P1-3 共享率 0%（MF / retail）

- **根因**：一块地每类交通只有一个 OD 目标，三张网合并也不产生共享。
- **两条路**：① 做真正的**场内环路**（把几个入口串成一条，共享率才可能到 70%+）；
  ② 承认"单块地谈共享率没意义"，改成城市级统计。
- **先做决策再写代码**，别直接改 solver。

### P1-4 全城放开内部道路的代价还没被人拍板

- 本地默认已经 `circulation=all`，代价是 Planner 耗时 +48.6%、内部道路 +7073 m²，
  且有 3 块求解器**一条路径都不产**（`-23:570` / `207:571` / `338:-254`，目前静默回落旧路）。
- **待办**：定位这 3 块为什么零产出（是几何不可行还是求解器 bug），
  然后让用户/产品明确"这些内部路该不该存在"。基线只有 35 m²，
  全城放开等于重画所有街区 —— 这是产品判断，不是技术判断。

### P1-5 legacy 没有"车位带"

- `rowBands` 只有 Placemaker 烘焙有，所以 `parkingProvider=legacy` 时停车场
  还是"深色底 + 一排白线"，和 PM 的观感不一致。
- **做法**：legacy 的 `solveParking` 输出的排也要能算外包（**逐排外包，不是全体凸包**，
  凸包会把两排之间的锥形空地包进去）。
- **注意**：`solveParking` 本身是冻结的，只能在 realize 层做后处理。

### P2-6 工业覆盖率与 S1 覆盖

- `INDUSTRIAL_INTENSITY.min = 16%` 现在是**硬约束**（`emitAll` 按 `hard.ok` 过滤），
  但工业 S1 覆盖只有 10%(patch) / 16%(parcel)，一套不剩就回落 archetype。
- 前场已从 30 m 撤回到 20 m（停车 635→221 m²）。要提覆盖率只能动厂房进深或停车带位置。

### P2-7 其余已知未解

| 问题 | 现状数字 |
|---|---|
| 含障碍区的车位前缘入面率 | 100% → **78%** |
| 斜列停车 | 类型库里有，**未验收** |
| <440~600 m² 的小停车区 | 全部回退 legacy（住宅/工业常态） |
| Placemaker 的锥形尾端 | asphalt 面没回写 ground，仍靠 `stallBand` 视觉兜底 |
| Phase M 形态场 | 未开始；7 处硬编码见 `PHASE_0_AUDIT.md` |

---

## 6. 雷区（每一条都真实踩过，能省你一天）

### 6.1 `surfaceSubtract` 失败时返回**被减数**（整块面）

不报错，直接返回原来的面。必须防护：`结果面积 ≥ 95% 原面` 就整体放弃。
否则会出现"认领一条 3 m 退线带 = 认领整块地"。

### 6.2 车位划线会被误判成"内部道路中线"

`layerOfPath` 只判"有没有高度"，而 `realize/parking.ts` 把每个车位画成一条
`markWhite` 短线。实测 1339 条里 1333 条是车位线。
**按材质分流**：`markWhite / markYellow → road:parkmark`，别再按高度猜。

### 6.3 烘焙表注册不能靠 side-effect import

早先是 `scene/build.ts` 里 `import './parking/baked'` 触发注册，结果所有**不经过
`buildScene`** 的调用方（探针、单测、直接调 `planner-bridge`）查表永远 MISS，
表现为"明明烘过却全部回退"。现在注册放在 `parking/provider.ts` **模块加载即执行**。
能力不能依赖"调用方恰好 import 了某个文件"。

### 6.4 烘焙必须覆盖运行时**全部**开关组合

几何指纹是**停车面几何**，而停车面取决于候选。`s1=golden` 只给三个 Golden 产骨架，
其余地块回退原 archetype —— 于是 `s1=golden` 烘的表在 `s1=all` 下**全部查不到**。
这就是 S2 采用率只有 18% 的主因（35 个请求 17 个 MISS）。
现在 `DEFAULT_CONFIGS` 默认烘 6 组（`s1 × pattern` 两轴），改开关组合就要重烘。

```bash
npx tsx tools/bake-parking.ts --all              # 全城 × 6 组配置（默认）
npx tsx tools/bake-parking.ts --all --configs=all # 只烘 s1=all/pattern=all
```

### 6.5 A/B 对照必须同车位尺寸、同角度集

比"算法"就不能同时变"输入"。所有停车对照固定 `2.52 × 5.04 m` 车位、`6.3 m` 车道
（与 legacy `CAR_STALL` 同尺寸），否则比出来的是尺寸差不是算法差。
`baked/layouts.json` 的 `seedNote` 里记了这套参数。

### 6.6 一个方案，两个覆盖率数字

- `metrics` 口径用**红线地块**（industrial 5092 m²）
- `SceneIR` 口径用 **patch**（8534 m²）

同一个方案会同时出现 16% 和 10%。**报告里必须写清用的是哪个口径**，别混用。

### 6.7 诊断分数不能跨版本比较

改了 `diagnostics` 的公式，分数变化不代表方案变好/变差。
要比就"用同一版 Evaluator 重评两个 Candidate"。

### 6.8 路面互相求差 + 裁剪体

- `realizeRoads` 的裁剪体：ground 并集 → 红线，不能直接用 bbox。
- 路面之间要互相求差，否则两条路重叠处会 z-fighting / 重复计面积。
- solver 不铺人行道；段长 ≤ 自身断面 0.75 倍不铺（否则退让后剩 1~4 m 的孤立方垫）。

### 6.9 性能数字要同机交替多跑

单次差异可达 ±20%（有过一次 +43% 全是噪声）。别拿一次测量下结论。

### 6.10 `boot()` 里 `#s=` 的处理顺序

快照解析**不能提前 return**，否则 `?s1=&parkingProvider=` 全部失效，
表现为"我加了参数页面上一点变化都没有"。现在的顺序是
`applySnapshot → applyQueryParams → 装配`。

### 6.11 冻结清单（改了会全局崩）

| 东西 | 原因 |
|---|---|
| `planning/core/types.ts` 的 `SiteContext` | 所有 archetype 都吃它 |
| `planning/core/candidate.ts` 的 `SitePlanCandidate` | 同上；**可以加可选字段**，不能改已有语义 |
| `PlanSurface` + `surface*` 布尔函数 | 整个几何层的地基 |
| `ground-ownership.ts` 优先级表 | 决定"同一块地谁归谁" |
| `road/system.ts` 路网拓扑 | 用户明确禁止重写 |
| `solveParking` | 用户明确禁止改 |

**可以加**：新 archetype、新 typology、新 GroundProgram、可选字段、diagnostics。
加 GroundProgram 要同步**四处**：`candidate.ts` 联合类型、`realize/contract.ts` 的
`GROUND_MATERIAL` + `GROUND_LIFT`、`ground-ownership.ts` 优先级、`realize/scenery.ts` 的 `PLANTABLE`。

### 6.12 "切得更碎 → 更多楼"只在住宅上成立

`patchedit.test.ts` 里那条切分断言曾经拿"总高最大的地块"当探针，R-Scale 把路变窄、
地块变大之后，探针自动落到了 cbd 上 —— 而 cbd 的小地块走"塔楼 + 裙房"，
切碎之后塔楼放不下，栋数反而**变少**（同一块 cbd：16 块 13 栋、24 块 10 栋）。
现在探针单独挑"面积最大的住宅"。**别把它改回 cbd 或"总高最大"**。

同理：自动切分按 26 m 面宽 + 40 m 进深上限走，一块 300~470 单位² 的住宅街区
自动就有 15~20 个地块，"切成 16 块"其实比自动更粗，验不出接线。

---

## 7. 复现与产出

```bash
# 回归（改完至少跑这三条）
npx tsx test/planning-frontend.test.ts    # 175 条
npx tsx test/planning-green.test.ts       # 174 条
npx tsx test/r1-3-adopt.test.ts           # 35 条，含全城重叠审计

# 量尺（不是测试，是出数字的脚本）
npx tsx test/r1-4-report.ts               # 全城内部交通覆盖率
npx tsx test/r1-5-a.ts / r1-5-b.ts        # 四指标分离
npx tsx test/scale-diag.ts / scale-shadow.ts
npx tsx test/s1-audit.ts / s1-report.ts   # 改前基线 / S1 对比
npx tsx test/s2-abc.ts / s2-polygon.ts    # Placemaker A/B/C + 多边形泛化
npx tsx test/s2-5-diag.ts                 # 停车采用率逐条归因（34 个请求）
npx tsx test/s2-5-abc.ts                  # 四层停车验收
npx tsx test/s2-6-ground.ts               # 地面语义分区 + out/s26/*-zones.svg
npx tsx test/shadow-r13.ts                # 全城 A/B 统计
```

- 截图与分区图都在 `out/`（**已 gitignore，不在仓库里**），要哪张就重跑对应脚本。
- 2D 截图 URL 模板：`?seed=682063530&n=15&mode=planner&patch=<key>&zoom=46&cx=<x>&cy=<y>`
- 3D 截图 URL：同上 + `&view=3d&zoom=10`

**同步时的回归状态（2026-11-05 实测）：** `tsc --noEmit` 通过；除 `gen.test.ts` 的
1 条历史失败（`radial-10 城内路网连通 187/196`）外**全部通过**：

```
circulation 26 · cover 19 · diagnostics 16 · glb · lattice 25 · layers 10 · params 66
patchedit 21 · planning 46 · planning-dc 39 · planning-freeze 19 · planning-frontend 175
planning-green 174 · planning-hotel 41 · planning-industrial 40 · planning-mf 43
planning-realize 44 · planning-retail 33 · planning-sf 24 · r1-3-adopt 35 · shadow 14
shape 5 · snapshot 43 · surface 16 · zoneavoid 20 · zoneedit 29
```

---

## 8. 口径速查

| 词 | 含义 |
|---|---|
| patch | 路网围出来的一块地（52 块） |
| withinCity | 城内 patch（44 块） |
| parcel | patch 去掉退线后的**红线地块**；metrics 用它算覆盖率 |
| Planner 覆盖 | 47 块（industrial / multi_family / retail 三类被接管） |
| Golden | 三块固定验收地块，所有对照都在它们上面做 |
| Portal | 地块内部交通与外部路网的接驳口 |
| 共享率 | 多类交通复用同一物理通道的占比（当前 MF/retail = 0%，这是真实的） |
| `stallBand` | 车位带底色（S2.6 新增，亮度 0.335，比车道浅一档） |
| 无功能铺装 | `Zone − 排 − 车道 − 岛` 的残差，当前全城可转绿块 = 0 |

---

## 9. 别做的事

1. **别改 `road/system.ts` 的拓扑、别改 `solveParking`** —— 用户明确禁止。
2. **别把 `?scale=C` 当基线** —— 它会重切街区，Golden key 全部失效。
3. **别在 `view2d` / `view3d` 里各自读开关** —— 一律走 `SceneOptions`。
4. **别手改 `baked/layouts.json`** —— 重跑 `tools/bake-parking.ts`。
5. **别"修" `test/gen.test.ts` 的那条失败**（`radial-10 城内路网连通 187/196`），
   它是历史遗留，不是回归。
6. **别在报告里混用 metrics 与 SceneIR 的口径**（§6.6）。
7. **别把 `out/` 或 `node_modules/` 提交进仓库**（已 gitignore）。
8. **别在 `mode=legacy` 下判断本轮的改动** —— 页面默认就是 legacy，
   内部道路 / 骨架 / 停车实验全部不生效，看到的永远是旧渲染。
