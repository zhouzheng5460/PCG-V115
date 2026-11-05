# F2.2 前置 · Straight Skeleton 集成可行性分析（暂不实施）

> 状态：**只做技术验证与成本评估，未接入生产链路。**
> 依据：实际下载并读取 `StrandedKitty/straight-skeleton` 仓库（`main` 分支）源码与构建产物，
> 不是凭印象评估。凡未实测的都明确标注为"未验证"。

---

## 0. 结论先行

| 问题 | 结论 |
|---|---|
| 能不能给出"每条临街边对应的影响区域"？ | **面域可以，映射不行**。库导出的是骨架顶点 + 每个面的顶点索引，**没有导出"面 ↔ 输入边"的关系**（见 §3.2），需要我们自己几何反推。 |
| 能否在 Node 里跑（我们的测试与后端都跑 Node）？ | **不能直接跑**。构建产物是 `ENVIRONMENT='web'` 的 emscripten 单文件，需重建或起 headless browser（见 §4.1）。 |
| 成本 | 初始化 1.0 MB WASM（首屏）+ 一次许可证复核 + 一个几何反推模块 + 一套稳定性回归。**工期风险主要在许可证与反推，不在算法**。 |
| 本轮建议 | **不接入**。等 F2.3 证明"没有骨架就拿不到更好的候选"时再启动，且必须走 Adapter。 |

---

## 1. 核实到的事实（可复核）

### 1.1 仓库与许可

| 项 | 值 | 来源 |
|---|---|---|
| 仓库 | `StrandedKitty/straight-skeleton` | `package.json` `repository` |
| 版本 | `3.0.0` | `package.json` `version` |
| 声明许可 | **MIT** | `LICENSE` / `package.json` `license` |
| 你要求的那份许可证文本 | `MIT License · Copyright (c) 2021-2023 StrandedKitty` | `LICENSE` 第 1–3 行 |
| 是否预编译产物随仓库分发 | **是**，`src/core/build/main.js` **1,053,613 字节** | `ls -l src/core/build/` |

### 1.2 运行时依赖（WASM 里静态链接的）

`src/core/CMakeLists.txt` 与 `src/core/main.cpp` 的 include 清单：

```
CGAL 5.6      （Exact_predicates_inexact_constructions_kernel）
boost 1.81    （shared_ptr）
gmp 6.2.1 / mpfr 4.2.0   （精确谓词的数论后端）
emscripten    （-O3 -s SINGLE_FILE -s MODULARIZE=1 -s ENVIRONMENT='web'）
```

用到的 CGAL 算法只有一个：`CGAL::create_interior_straight_skeleton_2(polygon_with_holes)`（`main.cpp`）。

> ⚠️ **许可证要点（必须复核，不能想当然）**：仓库自带的 MIT `LICENSE` 覆盖的是**胶水代码**（TS wrapper + C++ 适配层）。
> WASM 二进制里**静态链接了 CGAL**，而 CGAL 是按包分别授权的（大部分 LGPL，少数是 GPL 一类）。
> `Straight Skeleton` 包是否落在 LGPL 档，需要以 CGAL 官方 package 页面为准逐条确认。
> 若不属 LGPL 档，则"把这个 1 MB 二进制随产品分发"要按相应条款处理 —— 这是**比技术风险更前置的决策点**，
> 建议在写任何集成代码之前先由法务/架构拍板。

### 1.3 公开 API

`src/wrapper/index.ts`：

```ts
export type Vertex = [number, number, number];        // x, y, time
export type Polygon = number[];                       // 顶点索引
export interface Skeleton { vertices: Vertex[]; polygons: Polygon[] }

class SkeletonBuilder {
  static async init(): Promise<void>;
  static buildFromGeoJSONPolygon(polygon: GeoJSON.Polygon): Skeleton | null;
  static buildFromPolygon(coordinates: number[][][]): Skeleton | null;
}
```

输入约束（原文注释）：

- 至少一个环；**第一个是外环，其余是洞**；
- 外环必须 **CCW**，洞必须 **CW**；
- 所有环必须**弱简单**（weakly simple）；
- **每个环必须在末尾重复第一个顶点**。

输出：

- `vertices`：骨架顶点 `(x, y, time)`。`time` 即该顶点的"消隐时间"，可用来推 z / 做分层；
- `polygons`：骨架的**面**，每个面是一串顶点索引。

---

## 2. 与我们需求的对应关系

任务书要求的是"**每条道路临街边对应的影响区域**，而不仅是一组骨架线"。

直骨架的数学性质正好给这个东西：**CGAL 的直骨架每个面对应唯一一条输入轮廓边**，该面就是这条边在收缩过程中"扫过"的区域。
所以从"面集合"到"每条边的影响区域"只差一步映射。

**问题就在这一步。**

---

## 3. 三个实打实的集成障碍

### 3.1 输入格式不对齐（低风险，工作量小）

| 我们的 `PlanSurface` | 库要求 |
|---|---|
| `outer: Pt[]`，**不含**闭合重复点（`cleanRing` 明确删掉首尾重复） | 末尾**必须**重复首点 |
| 洞的方向不强制，由三角化处理 | 洞必须 CW |
| 世界坐标可为负，量级 ±500 | 内部按 `float32` 解析（`main.cpp` 里 `*((float*)data + i*2)`） |

适配器要做的：补闭合点、按 `ringArea` 正负统一方向、必要时平移到局部原点以免 float32 精度损失。
**成本：半天。风险：低。**

### 3.2 面 ↔ 输入边 的映射没有导出（中风险，需要自己补）

`main.cpp` 的 `serialize_skeleton()` 只做两件事：序列化顶点（x,y,time）、序列化每个面的顶点索引。
**它没有序列化 `face → contour_edge` 的关系**，而 CGAL 内部是有的（`Ss::Face` 带 `contour_edge` 句柄）。

后果：拿到 `polygons` 之后，我们**不知道自己看到的是"临街边 A 的影响区"还是"背街边 B 的影响区"**，
而这恰恰是本轮最需要的信息（临街归属）。两条出路：

| 办法 | 做法 | 成本 | 风险 |
|---|---|---|---|
| **A. 几何反推**（不改库） | 每个面的边界必然与**唯一一条输入边**共线/贴合 → 用"面边界与输入边的共线长度"投票 | 1–2 天 | 输入边很短（< 2 m）或两条边共线时可能误判；需在 G03/G06 上做专项回归 |
| **B. 改 C++ 重新编译** | 在 `serialize_skeleton` 里多序列化一个 `face → edge index` | 编译链齐全就 1 天 | 需要 emscripten + CMake + 预编译好的 CGAL/boost/gmp/mpfr 静态库（仓库里没有，要按 `install_libraries.sh` 自己拉） |

推荐 A（不动第三方代码，也不引入编译链依赖），但必须接受"短边误判"这个已知弱点。

### 3.3 构建产物只能在浏览器环境跑（已核实）

`CMakeLists.txt` 的链接参数含：

```
-s SINGLE_FILE -s MODULARIZE=1 -s ENVIRONMENT='web'
```

`ENVIRONMENT='web'` 意味着 emscripten 生成的 loader **只认浏览器全局**（`window`/`fetch`/`document`），
在 Node 里 `import` 会找不到运行环境。

我们的两套测试（`test/subdivision-*.ts`）都跑在 Node + tsx 上，所以：

- 要么**重建** WASM，把 `ENVIRONMENT` 改为 `'web,node'`（需要完整编译链 + 上面那堆静态库）；
- 要么**换运行环境**：起 headless browser（Playwright/Puppeteer）在页面里跑，再把结果 postMessage 回来。

**成本**：重建 ≥ 1 天（下载/编译 CGAL + boost + gmp + mpfr 是大头）；headless 方案半天，但测试会变慢、CI 复杂度上升。

**未验证**：我没有实测初始化耗时与单次骨架计算的耗时（原因就是要先解决上面这个环境问题）。
1.0 MB 的 WASM 首屏加载在桌面浏览器上量级是几十到几百毫秒，但这只是量级估计，**不是实测数据**，
不允许写进任何性能承诺。

---

## 4. 其它需要评估的点（任务书点名）

| 评估项 | 结论 | 依据 / 说明 |
|---|---|---|
| WASM 初始化与运行成本 | **未实测**（环境不通） | 见 §3.3。必须先在可运行环境里补测，才谈得上"是否可接受" |
| 大规模多边形稳定性 | **有明确风险** | CGAL 用的是 `Exact_predicates_inexact_constructions_kernel`（精确谓词 + 非精确构造）。我们地块最多 ~50 顶点，属小规模；但**生产红线存在自相交**（审计 A-01：`-469:284` 外环自交），而库要求"弱简单"，喂进去可能直接返回 `null` | 
| 几何输入格式与坐标方向 | 明确（§3.1） | 补闭合点 / 外环 CCW / 洞 CW / float32 精度 |
| CGAL 相关许可证与分发条件 | **必须复核** | 见 §1.2。仓库 MIT ≠ 可自由分发静态链接的 CGAL |
| 对现有 `PlanSurface` 的适配难度 | 低–中 | 输入侧简单（§3.1）；**输出侧的"面↔边"映射才是主要工作量**（§3.2） |
| 用普通 Offset / Medial Axis 冒充 | **明确禁止** | 两者都给不出"每条边的影响区域"：Offset 只给等距轮廓（不含分区），Medial Axis 的边不对应输入边 |

---

## 5. 如果 F2.2 真的启动，建议的接入形态

```
subdivision/adapters/straight-skeleton.ts
  ├─ 输入适配：PlanSurface → { rings: number[][][], edgeIndexMap: number[][] }
  ├─ 调用：SkeletonBuilder（经 worker / headless 桥）
  ├─ 输出适配：Skeleton → EdgeRegion[]（每条输入边一张影响面）
  └─ 校验：region 面积和 ≈ 父面积；每 region 与父边贴合；无自交
```

关键纪律（与 F2 契约一致）：

1. **不得让 WASM 的对象/格式漏出 adapter**。业务层只认 `EdgeRegion[]`（`{ edgeKey, surface }`）；
2. **失败必须显式**：库返回 `null`、面域面积对不上、边映射置信度低——三种情况分别报 `skeleton-failed` / `area-mismatch` / `edge-map-uncertain`，不许静默降级成"不切"；
3. **必须有无骨架的退路**：同一块地若骨架失败，回落到 OBB 或 Offset，并记录原因。

验收门槛（建议）：

- 在 G03（梯形）/ G04（三角形）/ G05（L 形）/ G06（多道路）/ G07（带洞）五个样本上，面域面积和与父场地误差 < 0.5%；
- 每条 input edge 都能匹配到一个面域（匹配率 = 100%），且匹配的共线长度 ≥ 该边长的 60%；
- 与现有 Offset 相比，"临街率"不下降、"残片占比"不上升；
- 在 R01/C01/I01 三个生产地块上不崩、不超时（单块 < 200 ms 才谈得上进主链路）。

---

## 6. 本轮为什么不做

1. **当前证据表明它不是瓶颈**：Offset 已经把平均临街率从 22% 提到 42%，残片占比压到 0；
   真正卡住的问题是"深地块需要几段巷道"和"固定建筑把刀口全挡住"，这两个都不是骨架能直接解的。
2. **它的最大价值场景（异形角地的临街分区）我们在 G04/G05 上已经用 Offset 达到可接受水平**（临街率 51% / 36%）。
3. **许可证没澄清之前写任何集成代码都是沉没成本。**

建议顺序：先做 F2.4（内部道路协同，解决"排数/巷道成本"）→ 再看 F2.3 的候选选择是否真的缺"异形角地的更优解" → 最后才评估骨架。
