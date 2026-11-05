// 移植自 Source/com/watabou/towngenerator/building/Model.hx
//
// 结构改动（为了支持编辑）：
// 1. build() 拆成 buildPatches / buildAll，中间插入一次坐标快照。
//    拖动拓扑点后只需 restore + buildAll，不用重跑 Voronoi。
// 2. 新增禁建区管线：种子点推开 → 地块布尔差集 → 顶点焊接 → T 型连接修复。
// 3. arteries 变成带 width 的 Artery，宽度参与地块内缩。
// 4. buildGeometry 对建筑做禁建区裁剪，保证形状边界精确。

import { Pt, sign } from '../core/geom';
import { Polygon } from '../core/polygon';
import { Voronoi } from '../core/voronoi';
import { Rng } from '../core/rng';
import { A } from '../core/ext';
import { Patch, patchKey, type PatchEdit } from './patch';
import { ModernWard } from './modern';
import type { ParkLevel } from './parking';
import { ROAD_SPECS, specOf, u } from '../road/spec';
import { planLandUse } from './landuse';
import { buildGridLayout, edgeKey, type EdgeClass, type LayoutKind } from './grid';
import type { FieldSource } from './field/tensor';
import { type FieldGuide, guideToSource } from './guide';
import { type TownParams, type DeepPartial, resolveParams } from './params';
import {
  Zone,
  zoneToPolygon,
  pushSeedsOutOfZones,
  subtract,
  intersect,
  intersectArea,
  unionAll,
  quantizeRing,
  ccw,
  weldVertices,
  fixTJunctions,
  area,
  pointInPolygon,
  edgeInsideZones,
} from './zones';

export interface TownStyle {
  /** 主干道宽度（原版 MAIN_STREET = 2.0） */
  mainStreetWidth: number;
  /** 普通街道宽度（原版 REGULAR_STREET = 1.0） */
  regularStreetWidth: number;
  /** 巷道宽度（原版 ALLEY = 0.6） */
  alleyWidth: number;
}

export interface ModelOptions {
  nPatches?: number;
  seed?: number;
  zones?: Zone[];
  style?: Partial<TownStyle>;
  plaza?: boolean;
  /** 圆内格子数下限（默认 36）。调小可以让 spacingK 真正生效，用于街区尺度对照 */
  minCells?: number;
  /** 每边格数下限（默认 3）。放到 2 才能让街区真的变大，见 grid.ts 的 minN */
  minN?: number;
  /** 地块被禁建区覆盖超过该比例就整块不出内容 */
  zoneBlockThreshold?: number;
  /** 街网形态：方格网 / 场线 / 放射环 / 张量场 */
  layout?: LayoutKind;
  /** 张量场布局下追加的方向场源（主体建筑朝向等） */
  fieldSources?: FieldSource[];
  /** 用户画的方向控制线 */
  guides?: FieldGuide[];
  /**
   * 停车配比档位（用户只控三档，见停车场规范 §16）：
   * 'low' → 0.65 面积 / 0.75 簇数；'normal' → 1.0 / 1.0；'high' → 1.25 / 1.20。
   * 默认 normal，不暴露具体数值。
   */
  parkingLevel?: ParkLevel;
  /** 城市参数（地块形态 / 建筑体型 / 绿地）—— 见 src/town/params.ts */
  params?: DeepPartial<TownParams>;
  /**
   * 用户对单个地块的手动覆盖（键 = `patchKey(patch)`，见 patch.ts）。
   * 传进来就优先于自动用途分档；不传就完全走原逻辑。
   */
  patchEdits?: Map<string, PatchEdit>;
}

export type { ParkLevel };

interface Snapshot {
  verts: Pt[];
  pos: { x: number; y: number }[];
  rings: number[][];
  flags: { withinCity: boolean; blocked: boolean; isInner: boolean }[];
  centerIdx: number;
  plazaIdx: number;
}

const MODEL_SUBSEED = 0x5eed1a7;

/**
 * 由地块身份键派生一个稳定种子（FNV-1a，落在 Rng 的合法区间内）。
 *
 * 用途：被手动改过的地块用一条私有随机流，让"改这块地"不影响别的地块。
 * 必须是**纯函数**——同一个 key 每次得到同一个数，改完重建才长得一样。
 */
function seedOfKey(key: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  // Rng 是 Park-Miller：模数 N-1 内的正数才是合法初值
  return (h % 2147483646) + 1;
}

/** 禁绘区被裁到城内后，小于这个面积（1 单位² = 49 m²）就不值得单独成块 */
const MIN_ZONE_AREA = 1.2;
/** 布尔切块留下的碎屑阈值 */
const MIN_SLIVER = 0.6;

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function bboxOf(ring: Pt[]): Box {
  const b: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const p of ring) {
    if (p.x < b.x0) b.x0 = p.x;
    if (p.y < b.y0) b.y0 = p.y;
    if (p.x > b.x1) b.x1 = p.x;
    if (p.y > b.y1) b.y1 = p.y;
  }
  return b;
}

function boxesOverlap(a: Box, b: Box): boolean {
  return a.x1 > b.x0 && b.x1 > a.x0 && a.y1 > b.y0 && b.y1 > a.y0;
}

/** 全局切分刀数上限：大地图上布尔运算次数会爆炸，这里给它封顶 */
const MAX_SUBDIVIDES = 300;

/** `spacingK` 的默认值。街区尺度连续缩放以它为锚（k = K_REF 时乘 1，城市不变） */
const K_REF = 1.5;

/**
 * 用等距平行带把多边形切成若干条，按面积降序返回（第一片是最大的）。
 *
 * 切分方向沿**长轴**等分（刀口垂直于长轴）：一块 30×8 的长条地，切两刀变成
 * 三块 10×8，才回到接近方形的街区；反过来顺长轴切只会得到更细的长条。
 * 条带用平行带（半平面矩形）与多边形求交，条带之间严格无缝，不会切出空洞。
 */
function cutIntoStrips(ring: Pt[], targetSide: number): Pt[][] {
  if (ring.length < 3) return [];

  // 参考轴：最长那条边的方向
  let bi = 0;
  let bl = 0;
  for (let i = 0; i < ring.length; i++) {
    const d = Pt.distance(ring[i], ring[(i + 1) % ring.length]);
    if (d > bl) {
      bl = d;
      bi = i;
    }
  }
  const a0 = ring[bi];
  const a1 = ring[(bi + 1) % ring.length];
  const l = Pt.distance(a0, a1) || 1;
  const u = new Pt((a1.x - a0.x) / l, (a1.y - a0.y) / l);
  const v = new Pt(-u.y, u.x);

  let eu0 = Infinity;
  let eu1 = -Infinity;
  let ev0 = Infinity;
  let ev1 = -Infinity;
  for (const p of ring) {
    const su = p.x * u.x + p.y * u.y;
    const sv = p.x * v.x + p.y * v.y;
    if (su < eu0) eu0 = su;
    if (su > eu1) eu1 = su;
    if (sv < ev0) ev0 = sv;
    if (sv > ev1) ev1 = sv;
  }
  const Eu = eu1 - eu0;
  const Ev = ev1 - ev0;

  // 沿跨度大的那一维等分；刀口垂直于它
  const alongU = Eu >= Ev;
  const ext = alongU ? Eu : Ev;
  const stack = alongU ? u : v;
  const band = alongU ? v : u;
  const s0 = alongU ? eu0 : ev0;
  const s1 = alongU ? eu1 : ev1;

  let n = Math.round(ext / Math.max(targetSide, 1));
  if (n < 2) n = 2;
  if (n > 4) n = 4;

  const step = (s1 - s0) / n;
  if (!(step > 1e-3)) return [];
  const BIG = ext * 2 + 40;
  const at = (t: number, s: number) => new Pt(band.x * t + stack.x * s, band.y * t + stack.y * s);

  const pieces: Pt[][] = [];
  for (let i = 0; i < n; i++) {
    const lo = s0 + step * i;
    const hi = s0 + step * (i + 1);
    const slab = [at(-BIG, lo), at(BIG, lo), at(BIG, hi), at(-BIG, hi)];
    for (const p of intersect(ring, slab, 0.004)) {
      if (p.length >= 3 && area(p) > 0.05) pieces.push(p);
    }
  }
  if (pieces.length < 2) return [];
  pieces.sort((p, q) => area(q) - area(p));
  return pieces;
}

/**
 * 按邻域焊接顶点（3×3 桶查找，容差 eps）。
 *
 * 不能直接用 zones.ts 的 weldVertices：它是"把坐标按 eps 取整当 key"，
 * 两个相距 1e-9 的点恰好跨在桶边界两侧时会被判成两个不同顶点 ——
 * 概率不高，但一发生就是整圈路网碎成孤立边（实测 seed=33 有 1786 条边、
 * 1622 个节点，最大连通块只有 2 个节点）。这里改成先按 eps 分桶、再查
 * 周围 9 个桶并做真实距离判定，跨边界也能焊上。
 */
function weldNear(polys: Polygon[], eps: number): void {
  const grid = new Map<string, Pt[]>();
  const ck = (ix: number, iy: number) => `${ix}:${iy}`;

  const find = (x: number, y: number): Pt | null => {
    const ix = Math.floor(x / eps);
    const iy = Math.floor(y / eps);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const arr = grid.get(ck(ix + dx, iy + dy));
        if (!arr) continue;
        for (const p of arr) {
          if (Math.abs(p.x - x) <= eps && Math.abs(p.y - y) <= eps) return p;
        }
      }
    }
    return null;
  };

  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const v = poly[i];
      const hit = find(v.x, v.y);
      if (hit) {
        poly[i] = hit;
        continue;
      }
      const k = ck(Math.floor(v.x / eps), Math.floor(v.y / eps));
      const arr = grid.get(k);
      if (arr) arr.push(v);
      else grid.set(k, [v]);
    }
    // 焊接后可能出现相邻重复点
    for (let i = poly.length - 1; i >= 0 && poly.length > 3; i--) {
      if (poly[i] === poly[(i + 1) % poly.length]) poly.splice((i + 1) % poly.length, 1);
    }
  }
}

export class Model {
  static instance: Model | null = null;

  nPatches: number;
  seed: number;
  style: TownStyle;
  zones: Zone[];
  zonePolys: Pt[][] = [];
  zoneBlockThreshold: number;
  /** 街网形态 */
  layout: LayoutKind;
  /** 张量场布局下追加的方向场源 */
  fieldSources: FieldSource[];
  /** 用户画的方向控制线（只影响 tensor 布局） */
  guides: FieldGuide[] = [];
  /** 停车配比档位，默认 normal */
  parkingLevel: ParkLevel = 'normal';

  /** 地块内容（用途规划 + 建筑群） */
  lots = new Map<Patch, ModernWard>();

  /** 现代模式：每条地块边的道路等级（键是端点坐标，和顶点身份无关） */
  edgeClass = new Map<string, EdgeClass>();

  /**
   * `smoothRoadClass()` **执行前**的等级快照（只读诊断用）。
   *
   * 等级平滑会批量升级长链路上的支路，"改了多少条、从什么等级变成什么"是尺度
   * 诊断的必答项，但平滑之后原值就没了。这里在平滑入口存一份，不参与任何逻辑。
   */
  roadClassRaw: Map<string, EdgeClass> = new Map();

  /** 大块地二次切分的计数（只读诊断用）：切前/切后地块数、新增边数 */
  splitStats = { before: 0, after: 0, newEdges: 0 };

  /**
   * 圆内格子数下限（默认 36）。
   *
   * `cells = max(minCells, nPatches*5/k²)`。36 是"环形布局最外圈还能闭合"的经验
   * 下限，但它会把 `spacingK` 架空（k=1.5 时 75/2.25=33 < 36）。做街区尺度对照时
   * 允许调到更小，默认值不变。
   */
  minCells: number;

  /**
   * 每边格数下限（默认 3）。
   *
   * 即使把 minCells 调小，`grid.ts` 里还有一道 `n = max(3, round(√(cells/π)))`，
   * 而街区尺度 `S = R/n` 只认 n —— 所以只要 n 被夹在 3，spacingK 就是死参数。
   * 放到 2 才能让"放大街区"真的生效（尺度对照用）。
   */
  minN: number;

  /**
   * 地块内部路的**出入口**（世界坐标矩形）。
   *
   * 封闭地块的内部路必须真的接到外部车行道上，而不是"两块沥青在图上叠着"。
   * 地块边 = 外部道路的红线，从红线到车行道之间还隔着一条人行道 + 绿化带；
   * 那些带子要在这个开口处断开，内部路才连得出去（现实中就是小区大门的
   * 无障碍坡道 + 人行道断口）。地块规划阶段把开口记在这里，道路层铺人行道
   * 时按它裁 —— 这是地块与道路之间唯一一处"事后补丁"，但必须这么做：
   * 铺路的时候还不知道每块地会把门开在哪。
   */
  driveways: Pt[][] = [];

  /**
   * 整城主朝向（仅张量场布局有）。地块内部的张量场以它为基准方向，
   * 这样封闭区域里的内部路跟城外街网是同一套朝向。
   */
  cityAxis: Pt | null = null;

  /**
   * 单条路的红线宽覆盖（键 = edgeKey，值 = 世界单位宽）。
   *
   * 中世纪那一批功能被移除时，这张表跟着 `WidthOverrides` 一起被删掉了，
   * 侧栏的"选中路"滑杆因此变成永久禁用的死控件。现在按坐标键重建：
   * 宽度只需要影响 `insetForEdge` 一个点，地块内缩与道路横断面就同时跟着变。
   */
  widthOverrides = new Map<string, number>();

  /**
   * 城市参数（已钳制过的完整对象）。
   *
   * 只在这里存一份，其余模块一律读 `model.params` —— `Ctx` 里已经带着 model，
   * 所以地块内容层不需要额外传参，也就不会出现"两处参数不一致"。
   */
  params: TownParams;

  private plazaNeeded: boolean;

  /** 用户对单个地块的手动覆盖（见 PatchEdit）。键是 patchKey */
  patchEdits: Map<string, PatchEdit> = new Map();


  patches: Patch[] = [];
  inner: Patch[] = [];
  plaza: Patch | null = null;
  center = new Pt();


  /** 城内轮廓（禁建区裁剪前），仅供城墙使用 */
  boundaryOutline: Patch[] = [];

  cityRadius = 0;
  gates: Pt[] = [];


  /** 是否把种子点推开以让地块绕开禁区（默认否，保持其余地块完全不变） */

  /**
   * 几何版本号：每完成一次 buildAll 就 +1。
   * 2D / 3D 视图靠它判断"模型变了，该重新组装场景了"，
   * 不用在每个改模型的地方手动通知视图。
   */
  revision = 0;

  private snapshot: Snapshot | null = null;
  lastError: string | null = null;

  constructor(opts: ModelOptions = {}) {
    this.nPatches = opts.nPatches ?? 15;
    this.minCells = opts.minCells ?? 36;
    this.minN = opts.minN ?? 3;
    this.seed = opts.seed ?? -1;
    this.zones = opts.zones ?? [];
    this.zoneBlockThreshold = opts.zoneBlockThreshold ?? 0.35;
    this.layout = opts.layout ?? 'tensor';
    this.fieldSources = opts.fieldSources ?? [];
    this.guides = opts.guides ?? [];
    this.parkingLevel = opts.parkingLevel ?? 'normal';
    // 现代城市的道路横断面按 road/spec.ts 的规范表给（1 单位 ≈ 7 m）：
    // 主干路 24 m（双向四车道 + 3 m 人行道 + 2 m 绿化带）、
    // 次干路 15 m、支路 10.5 m。三档都要和表里的 redLine 对上，
    // 否则"红线宽 = 各分项之和"会在 fitSection 里产生差额。
    const base: TownStyle = {
      mainStreetWidth: u(ROAD_SPECS.arterial.redLine),
      regularStreetWidth: u(ROAD_SPECS.collector.redLine),
      alleyWidth: u(ROAD_SPECS.local.redLine),
    };
    this.style = { ...base, ...opts.style };

    this.params = resolveParams(opts.params);

    this.patchEdits = opts.patchEdits ?? new Map();

    this.plazaNeeded = opts.plaza ?? Rng.bool();
  }

  // ------------------------------------------------------------------ 入口

  generate(): void {
    this.lastError = null;
    if (this.seed > 0) Rng.reset(this.seed);

    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        this.buildPatches();
        this.buildAll();
        Model.instance = this;
        return;
      } catch (e) {
        this.lastError = (e as Error).message;
      }
    }
    throw new Error(`城市生成失败（重试 40 次）：${this.lastError}`);
  }

  /** 编辑顶点 / 禁建区 / 路宽后重建。不会重跑 Voronoi。 */
  rebuild(): void {
    if (!this.snapshot) {
      this.generate();
      return;
    }
    this.lastError = null;
    const prev = this.snapshot;
    try {
      this.restoreSnapshot();
      // 顶点移动后禁建区判定跟着重算（不改地块形状，只更新 blocked 与内容）
      if (this.zonePolys.length > 0) {
        this.markBlockedPatches();
        this.dropContentInsideZones();
      }
      this.buildAll();
    } catch (e) {
      this.lastError = (e as Error).message;
      this.snapshot = prev;
      this.restoreSnapshot();
      // 保留上一次成功的几何，只报告错误
      throw e;
    }
  }

  /** 更新禁建区并重建（会重跑 Voronoi，因为种子点分布要变） */
  setZones(zones: Zone[]): void {
    this.zones = zones;
    this.zonePolys = zones.filter((z) => z.enabled).map(zoneToPolygon);
    this.generate();
  }

  // ------------------------------------------------------------------ 阶段 1：地块

  private buildPatches(): void {
    this.zonePolys = this.zones.filter((z) => z.enabled).map(zoneToPolygon);
    this.driveways = [];

    // 街网切块：方格网 / 场线 / 放射环 / 张量场，四者只影响切块，
    // 切完都是一样的 Patch[]，下游内缩、路网横断面、地块内容全部复用。
    this.buildGridPatches();

    // 面积异常大的街区再切一刀（最多两层）。
    // 张量场切出来的街区大小本来就不均匀：场线汇合处会出现 2~4 倍于中位数的大块，
    // 上面只能摆一栋孤立的大楼，读起来完全不像城市。这里按面积补切，
    // 让街区尺度回到中位数附近，同时保证递归只有两层、总刀数有上限。
    this.subdivideLargePatches();

    // 禁绘区 = 用户自定义的封闭地块。
    // 必须在切块之后、快照之前把轮廓"挖"成一块独立地块：
    // 快照是"编辑前的拓扑"，挖完再拍，拖顶点才不会把禁区边界扯散。
    this.carveZones();

    // 等级平滑放在**所有切块动作之后、任何内缩计算之前**：
    // 地块内缩和道路横断面都从 edgeClass 读，先改等级，两者才会一起变宽/变窄，
    // 不会出现"路面变宽了、地块没退"的错位。
    // 不能放 buildGridPatches 里 —— 那之后还有 subdivideLargePatches / carveZones，
    // 它们会造出新顶点和新键，平滑过的结果会被覆盖掉。
    this.smoothRoadClass();

    // 默认轮廓 = 地块本身
    this.boundaryOutline = this.inner;
    this.takeSnapshot();

    // 挖完以后，宽度超过阈值的覆盖已经不存在了；这里仍跑一遍是为了
    // 处理"禁区被裁得只剩一条边"的边角情况，并统一置 blocked 标记。
    if (this.zonePolys.length > 0) {
      this.markBlockedPatches();
      this.dropContentInsideZones();
    }
  }

  /**
   * 大块地二次切分。
   *
   * 触发条件：面积超过**中位数的 1.7 倍**。一刀切到 n 段，n 按"长边 / √中位面积"算，
   * 上限 4 段 —— 不能更多，否则小城会被切成火柴盒，而且布尔运算次数线性增长。
   * 切完仍然偏大的，再做**第二层**；两层封顶（deep 循环 2 次）+ 全局刀数上限，
   * 这是"避免卡死"的两道闸。
   *
   * 新边一律记 local（支路）：它们是大街区内部的补充分隔，不该继承外围主干道等级。
   */
  private subdivideLargePatches(): void {
    const inner = this.patches.filter((p) => p.withinCity);
    if (inner.length < 6) return;
    this.splitStats = { before: this.patches.length, after: this.patches.length, newEdges: 0 };
    const areas = inner.map((p) => area(Array.from(p.shape))).sort((a, b) => a - b);
    const med = areas[Math.floor(areas.length / 2)];
    if (!(med > 0.5)) return;

    // 启用闸：只有"大块确实离群"时才切。
    // 方格网/小城本来就很均匀（max/med ≈ 1.5），硬切会把中位数推高 ——
    // 实测 n=6 时 max/med 从 1.51 反升到 1.80，块数还少了 5 个。
    // 张量场才是真正的目标场景（汇合处有 2~4 倍中位数的大块，max/med ≥ 3）。
    const maxA = areas[areas.length - 1];
    if (maxA / med < 1.95) return;

    const targetSide = Math.sqrt(med);
    const limit = med * 1.7;
    let budget = MAX_SUBDIVIDES;
    let cutAny = false;

    for (let depth = 0; depth < 2 && budget > 0; depth++) {
      const next: Patch[] = [];
      let changed = false;

      for (const patch of this.patches) {
        if (budget > 0 && patch.withinCity && !patch.blocked) {
          const ring = Array.from(patch.shape);
          if (area(ring) > limit) {
            // 已按面积降序返回
            const pieces = cutIntoStrips(ring, targetSide);
            if (pieces.length >= 2) {
              budget -= pieces.length - 1;
              changed = true;
              cutAny = true;
              let biggest: Patch | null = null;
              pieces.forEach((r, i) => {
                let np: Patch;
                if (i === 0) {
                  patch.shape = new Polygon(r);
                  np = patch;
                } else {
                  np = new Patch(r);
                  np.withinCity = patch.withinCity;
                }
                next.push(np);
                if (!biggest) biggest = np;
              });
              // 中心广场被切开时，留最大的一片继续当广场
              if (this.plaza === patch && biggest) this.plaza = biggest;
              continue;
            }
          }
        }
        next.push(patch);
      }

      this.patches = next;
      if (!changed) break;
    }

    if (!cutAny) return;

    // ---- 拓扑修复：和 carveZones 同一套理由（布尔输出是全新顶点）
    const polys = this.patches.map((p) => p.shape);
    weldNear(polys, 1e-3);
    const verts: Pt[] = [];
    for (const poly of polys) for (const v of poly) verts.push(v);
    fixTJunctions(polys, verts, 1e-3);
    this.compactPatchRings();

    // 新切出来的边没有等级记录 → 一律支路。
    // 不写的话 roadClassOf 会退到 'local'，结果一样，但显式登记便于单条路宽编辑按 key 生效。
    let newEdges = 0;
    for (const patch of this.patches) {
      const ring = Array.from(patch.shape);
      for (let i = 0; i < ring.length; i++) {
        const key = edgeKey(ring[i], ring[(i + 1) % ring.length]);
        if (!this.edgeClass.has(key)) { this.edgeClass.set(key, 'local'); newEdges++; }
      }
    }
    this.splitStats = { before: this.splitStats.before, after: this.patches.length, newEdges };

    this.inner = this.patches.filter((p) => p.withinCity);
  }

  /**
   * 去掉地块环上距离几乎为 0 的相邻顶点。
   *
   * 焊接会把"原本相距 < 1e-3 的两个点"并成一个实例，于是环上出现 A→A 的零长边；
   * 这条零长边会一路传进地坪多边形，俯视图上看不出来，但多边形自交检测
   * （以及很多几何库）会直接判它非法。这里统一收口，顺便把退化地块丢掉。
   */
  private compactPatchRings(): void {
    const same = (a: Pt, b: Pt) => Math.abs(a.x - b.x) < 1e-7 && Math.abs(a.y - b.y) < 1e-7;
    const keep: Patch[] = [];
    for (const patch of this.patches) {
      const ring = Array.from(patch.shape);
      const out: Pt[] = [];
      for (const p of ring) {
        const last = out[out.length - 1];
        if (last && same(last, p)) continue;
        out.push(p);
      }
      while (out.length > 3 && same(out[0], out[out.length - 1])) out.pop();
      if (out.length < 3) continue; // 退化地块：留着只会产出零面积的铺装
      if (out.length !== ring.length) patch.shape = new Polygon(out);
      keep.push(patch);
    }
    if (keep.length !== this.patches.length) this.patches = keep;
  }

  /**
   * 禁绘区 → 独立地块。
   *
   * 语义：用户画的是一个**封闭地块**，不是"路网要绕开的洞"。
   * 所以轮廓本身变成 1 个独立 Patch（blocked → 用途 reserved → 走 planReserved），
   * 并从每个原有地块里把这块形状挖掉。挖完之后区内再没有任何城市道路 ——
   * 城市道路是"地块边"，区内已经没有地块边了，路自然就没了。
   *
   * 两个必须做的善后（否则路网会整圈断掉）：
   *   1. 布尔运算产出的顶点是全新对象，必须 weldVertices 焊成共享实例。
   *      buildRoadNet 是按**对象身份**配对两侧边的，不焊就认为"两侧不是同一条边"，
   *      这条路直接被丢弃。
   *   2. 焊接会在邻块边上留下单侧顶点（T 型连接），要 fixTJunctions 补点，
   *      否则邻块那条边会被切成两段而只有一段有配对。
   */
  private carveZones(): void {
    const zones = this.zonePolys;
    if (zones.length === 0 || this.patches.length === 0) return;
    // zonePolys 是"启用中的 zone"投影出来的多边形，索引一一对应 ——
    // 这里再取一份 purpose，让禁区的"内容类型"能一路传到地块上。
    const purposes = this.zones.filter((z) => z.enabled).map((z) => z.purpose ?? 'cbd');

    const boxes = this.patches.map((p) => bboxOf(Array.from(p.shape)));
    const zonePatches = new Set<Patch>();

    for (let zi = 0; zi < zones.length; zi++) {
      const z = zones[zi];
      let ring = quantizeRing(z);
      if (ring.length < 3) continue;
      const zb = bboxOf(ring);

      // 城区覆盖范围 = 附近地块的并集。禁区画到城外时只保留落在城区里的那部分，
      // 否则会多出一块悬在城市轮廓外的地块（四邻皆无 → 铺不出路 → 一块孤岛）。
      // 只并"包围盒相交"的几块（一张地图上百块地，全并一次要多花 200+ ms）。
      const near: Pt[][] = [];
      for (let i = 0; i < this.patches.length; i++) {
        if (boxesOverlap(boxes[i], zb)) near.push(Array.from(this.patches[i].shape));
      }
      if (near.length === 0) continue;
      const coverage = unionAll(near);
      if (coverage.length < 3) continue;

      const clipped = intersect(ring, ccw(coverage), 0.02)[0];
      if (!clipped) continue;
      ring = quantizeRing(ccw(clipped));
      if (ring.length < 3 || area(ring) < MIN_ZONE_AREA) continue;

      const next: Patch[] = [];
      for (let i = 0; i < this.patches.length; i++) {
        const patch = this.patches[i];
        const base = Array.from(patch.shape);
        if (base.length < 3) continue;
        // 包围盒不相交：一定在禁区外，跳过布尔运算（否则每次生成要白跑上百次）
        if (!boxesOverlap(boxes[i], zb)) {
          next.push(patch);
          continue;
        }
        if (intersectArea(base, ring) < 1e-6) {
          next.push(patch);
          continue;
        }
        const parts = subtract(base, [ring])
          .filter((r) => r.length >= 3 && area(r) > MIN_SLIVER)
          .sort((a, b) => area(b) - area(a));
        if (parts.length === 0) {
          // 整块被禁区吃掉
          if (patch === this.plaza) this.plaza = null;
          continue;
        }
        // 禁区把一块地劈成两半时，另一半不能丢（丢了就是一个没地台没路的洞）
        patch.shape = new Polygon(parts[0]);
        for (let k = 1; k < parts.length; k++) {
          const extra = new Patch(parts[k]);
          extra.withinCity = patch.withinCity;
          next.push(extra);
        }
        next.push(patch);
      }

      // 禁区自身作为一块地块加入。禁区先定义，后续禁区会从它身上再挖。
      const zp = new Patch(ring);
      zp.withinCity = true;
      zp.blocked = true;
      zp.purpose = purposes[zi] ?? 'cbd';
      next.push(zp);
      zonePatches.add(zp);

      this.patches = next;

      // 地块集合变了（有被吃掉的、有被劈成两块的），包围盒必须重算
      boxes.length = 0;
      for (const p of this.patches) boxes.push(bboxOf(Array.from(p.shape)));
    }

    if (zonePatches.size === 0) return;

    // ---- 焊接 + T 型连接
    //
    // 容差取 0.02 单位（≈14 cm），不是 1e-3。
    // 布尔减法在轮廓附近会留下 3~5 cm 的碎边（实测最短一条 0.0 m）。这些边
    // 几何上"没错"，但它是地块边 → 会变成一条 3 cm 长的**路**：进路口求解时
    // 方向是任意的，臂的收口距离算不出，于是路口中央多出一片飘着的白碎线。
    // 14 cm 在 7 m/单位的世界里不可能是一条路，焊掉不会让任何真实几何消失。
    // 用 weldNear 而不是 weldVertices：后者按 eps 取整当 key，跨桶边界的两个
    // 重合点会被判成不同顶点（详见上面 weldNear 的注释）。
    const polys = this.patches.map((p) => p.shape);
    weldNear(polys, 0.02);
    const verts: Pt[] = [];
    for (const poly of polys) for (const v of poly) verts.push(v);
    fixTJunctions(polys, verts, 1e-3);

    // 焊接后可能出现极短的自环，去掉避免路口圆角算出 NaN
    for (const patch of this.patches) {
      const ring = Array.from(patch.shape);
      const keep = ring.filter((v, i) => Pt.distance(v, ring[(i + 1) % ring.length]) > 1e-6);
      if (keep.length >= 3 && keep.length !== ring.length) patch.shape = new Polygon(keep);
    }
    this.compactPatchRings();

    // ---- 等级继承：被切开的边是全新顶点，edgeClass 里没有它们的键，
    // 全部按"支路"处理会让一条主干道在禁区边界处莫名降级。
    this.inheritEdgeClasses(zonePatches);

    this.inner = this.patches.filter((p) => p.withinCity);
  }

  /**
   * 布尔切出来的新边没有等级记录，沿地块环用最近的有等级边补上。
   *
   * 只写"还没有记录"的键，并且跳过禁区自身 —— 禁区与邻块的公共边
   * 应该由邻块那一侧来定级（禁区块四周没有一条"原生的"路可以继承）。
   */
  private inheritEdgeClasses(skip: Set<Patch>): void {
    for (const patch of this.patches) {
      if (skip.has(patch)) continue;
      const ring = Array.from(patch.shape);
      const n = ring.length;
      if (n < 3) continue;

      const cls: (EdgeClass | undefined)[] = [];
      for (let i = 0; i < n; i++) cls.push(this.edgeClass.get(edgeKey(ring[i], ring[(i + 1) % n])));
      if (cls.every((c) => c !== undefined)) continue;

      // 正反各扫一遍，两端都被有等级边夹住时才补，单侧无解就保持 undefined
      for (let pass = 0; pass < 2; pass++) {
        for (let k = 0; k < n; k++) {
          const i = pass === 0 ? k : n - 1 - k;
          if (cls[i] !== undefined) continue;
          const prev = pass === 0 ? (i - 1 + n) % n : (i + 1) % n;
          if (cls[prev] !== undefined) cls[i] = cls[prev];
        }
      }

      for (let i = 0; i < n; i++) {
        const c = cls[i];
        if (c === undefined) continue;
        const key = edgeKey(ring[i], ring[(i + 1) % n]);
        if (!this.edgeClass.has(key)) this.edgeClass.set(key, c);
      }
    }
  }

  /**
   * 现代城市：街网切块。
   *
   * 地块数按规模给（每块地约 5 个街区），街区尺度由「圆内格子数 ≈ π·n²」反推，
   * 所以 6 / 10 / 15 / 24 四种规模都能得到合理的街区大小，不会出现
   * "小镇是几个巨型街区、大城是几百个火柴盒"。
   *
   * 形态由 this.layout 决定（方格网 / 场线 / 放射环），三者只影响切块，
   * 切完都是一样的 Patch[]。
   */
  private buildGridPatches(): void {
    this.patches = [];
    this.inner = [];
    this.plaza = null;
    this.center = new Pt(0, 0);

    // 街区尺度系数直接作用在"目标街区数"上：S = R / √(cells/π)，
    // 所以 cells / k² 正好让道路间距变成 k 倍，其余（minArea、流线间距）全是它的下游。
    //
    // 下限 36 不是拍的：环形 / 格网布局的环数 n = round(√(cells/π))，
    // n = 3（cells 28~44）时最外圈刚好还能闭合。原来写 50，
    // 后果是 `spacingK` 一旦大于 1.22 就**完全失效**（75/k² < 50），
    // 街区尺寸被死死钉在 86 m 见方 —— 而 86 m 的街区让 8 m 的路边退让
    // 占掉 34% 面积，看起来就像"地块压在路上"。
    // 真实小城的街区是 100~150 m，退让只占 10~15%。
    const k = this.params.block.spacingK;
    // 下限可配：36 是"环形布局最外圈还能闭合"的经验值，但 k 稍大就会把
    // spacingK 整个架空（75/k² < 36 → 街区被钉死在 156 m）。做尺度对照时
    // 需要能把它放开看，默认仍是 36，行为不变。
    const minCells = this.minCells;
    const cells = Math.max(minCells, Math.round((this.nPatches * 5) / (k * k)));
    const radius = 42 + this.nPatches * 1.9;
    const grid = buildGridLayout({
      cells,
      radius,
      minN: this.minN,
      spacingMul: k / K_REF,
      layout: this.layout,
      warp: 0.65,
      // tensor 布局下禁建区轮廓会作为方向场源参与合成（zoneAvoid 关时），
      // 开避障时它只当几何障碍，由流线绕行处理
      zones: this.zonePolys,
      zoneAvoid: this.params.block.zoneAvoid,
      zoneAvoidPad: u(this.params.block.zoneAvoidPadM),
      zoneAvoidBend: this.params.block.zoneAvoidBend,
      // 方向控制线按城市半径换算影响范围，所以要在算出 radius 之后再转
      sources: this.fieldSources.concat(
        this.guides.filter((g) => g.enabled && g.pts.length >= 2).map((g) => guideToSource(g, radius))
      ),
    });

    this.patches = grid.patches;
    this.edgeClass = grid.edgeClass;
    this.cityRadius = grid.radius;
    this.cityAxis = grid.axis ?? null;
    this.inner = grid.patches.filter((p) => p.withinCity);
    this.plaza = this.plazaNeeded ? grid.core : null;

    this.fillPatchHoles(grid.radius);
    this.inner = this.patches.filter((p) => p.withinCity);
  }

  /**
   * 道路等级平滑：一条连续（直通）的街道不允许中途突兀地换等级。
   *
   * 等级是**逐条流线**给的（每 kArt 条一条主干道，其余按奇偶分次干道 / 支路）。
   * 张量场里一条物理街道常被打成两三段独立的流线 —— 线头一断，下一段就是另一条
   * 线的等级，于是"同一条路上一半是主干道、一半是支路"，宽度在某个不起眼的路口
   * 突然减半，读起来就是"路断了"。
   *
   * 做法：把"在某个顶点上方向近乎相反"的两条边配成对（= 一条路从这里穿过去），
   * 用并查集串成链，链内按**长度加权投票**取一个等级写回去。只跑一遍，不迭代，
   * 所以不会一路传染把整城都升成主干道。
   *
   * 阈值取 30°（dot < -0.87）：比这更弯的转折已经是一个真的路口转向，
   * 那本来就该允许换等级。
   */
  private smoothRoadClass(): void {
    const cls = this.edgeClass;
    if (cls.size === 0 || this.patches.length === 0) return;
    // 诊断用快照：平滑之后原等级就没了，先存一份（不参与逻辑）
    this.roadClassRaw = new Map(cls);

    interface E {
      a: Pt;
      b: Pt;
      len: number;
    }
    const ends = new Map<string, E>();
    for (const patch of this.patches) {
      const ring = Array.from(patch.shape);
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        if (a === b) continue;
        const k = edgeKey(a, b);
        if (ends.has(k)) continue;
        const len = Pt.distance(a, b);
        if (len < 1e-6) continue;
        ends.set(k, { a, b, len });
      }
    }
    if (ends.size === 0) return;

    // 节点 → 入射边（带"从该点出发"的单位方向）
    const at = new Map<Pt, { k: string; d: Pt }[]>();
    const addAt = (p: Pt, k: string, d: Pt) => {
      const l = at.get(p);
      if (l) l.push({ k, d });
      else at.set(p, [{ k, d }]);
    };
    for (const [k, e] of ends) {
      const dx = e.b.x - e.a.x;
      const dy = e.b.y - e.a.y;
      const L = Math.hypot(dx, dy) || 1;
      addAt(e.a, k, new Pt(dx / L, dy / L));
      addAt(e.b, k, new Pt(-dx / L, -dy / L));
    }

    const par = new Map<string, string>();
    for (const k of ends.keys()) par.set(k, k);
    const find = (x: string): string => {
      let r = x;
      while (par.get(r) !== r) r = par.get(r)!;
      let c = x;
      while (par.get(c) !== c) {
        const nx = par.get(c)!;
        par.set(c, r);
        c = nx;
      }
      return r;
    };
    const union = (x: string, y: string) => {
      const rx = find(x);
      const ry = find(y);
      if (rx !== ry) par.set(rx, ry);
    };

    for (const [, list] of at) {
      if (list.length < 2) continue;
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const p = list[i];
          const q = list[j];
          if (p.k === q.k) continue;
          if (p.d.x * q.d.x + p.d.y * q.d.y > -0.87) continue;
          union(p.k, q.k);
        }
      }
    }

    // 链内长度加权投票
    const votes = new Map<string, Map<EdgeClass, number>>();
    for (const [k, e] of ends) {
      const r = find(k);
      let m = votes.get(r);
      if (!m) {
        m = new Map();
        votes.set(r, m);
      }
      const c = cls.get(k) ?? 'local';
      m.set(c, (m.get(c) ?? 0) + e.len);
    }

    const rank: Record<EdgeClass, number> = { local: 1, collector: 2, arterial: 3 };
    let changed = 0;
    for (const [k] of ends) {
      const r = find(k);
      const m = votes.get(r);
      if (!m) continue;
      let best: EdgeClass = 'local';
      let bestV = -1;
      for (const [c, v] of m) {
        // 票数相同取等级高的：宁可让一条路的次要段跟着升级，也不要让主干道
        // 在一半的时候掉成支路
        if (v > bestV + 1e-9 || (Math.abs(v - bestV) <= 1e-9 && rank[c] > rank[best])) {
          best = c;
          bestV = v;
        }
      }
      if (cls.get(k) !== best) {
        cls.set(k, best);
        changed++;
      }
    }
    void changed;
  }

  /**
   * 补洞：切块偶尔会漏掉一整块区域（张量场里某个格子被丢掉 / 布尔运算失败），
   * 城市正中就会留下一块"没有地块、没有路面、没有任何铺装"的空地 ——
   * 俯视图上是一大片底色，看着像地图破了个洞。
   *
   * 这里把"城内范围 − 已切地块"的残余补成正常地块，让它照常走用途规划
   * （多半会变成绿地或停车场），而不是留在那里当真空。
   * 目标范围取略小于城市半径的圆，避免把城市轮廓外的空地也当成洞填掉。
   */
  private fillPatchHoles(radius: number): void {
    if (this.patches.length === 0) return;
    const R = radius * 0.88;
    const disc: Pt[] = [];
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      disc.push(new Pt(Math.cos(a) * R, Math.sin(a) * R));
    }
    const covered = this.patches.map((p) => Array.from(p.shape));
    const holes = subtract(disc, covered).filter((h) => h.length >= 3 && area(h) > 4);
    for (const h of holes) {
      const patch = new Patch(h);
      patch.withinCity = true;
      this.patches.push(patch);
    }
  }

  private markBlockedPatches(): void {
    for (const patch of this.patches) {
      const ring = Array.from(patch.shape);
      const base = area(ring);
      if (base <= 0) continue;

      let covered = 0;
      for (const z of this.zonePolys) covered += intersectArea(ring, z);
      if (covered / base >= this.zoneBlockThreshold) patch.blocked = true;
    }
  }

  /** 禁建区遮住了广场/中心时，放弃这些要素而不是让整个城市生成失败 */
  private dropContentInsideZones(): void {
    const inside = (p: Pt) => this.zonePolys.some((z) => pointInPolygon(p, z));

    if (this.plaza) {
      const c = this.plaza.shape.center;
      if (this.plaza.blocked || this.plaza.shape.length < 3 || inside(c)) this.plaza = null;
    }

    if (inside(this.center)) {
      // 找一个禁建区外、离原点最近的可用顶点当中心
      let best: Pt | null = null;
      let bestD = Infinity;
      for (const patch of this.patches) {
        if (patch.blocked) continue;
        for (const v of patch.shape) {
          if (inside(v)) continue;
          const d = v.length;
          if (d < bestD) {
            best = v;
            bestD = d;
          }
        }
      }
      if (best) this.center = best;
    }
  }

  // ------------------------------------------------------------------ 快照

  private takeSnapshot(): void {
    const index = new Map<Pt, number>();
    const verts: Pt[] = [];
    const pos: { x: number; y: number }[] = [];
    const rings: number[][] = [];
    const flags: Snapshot['flags'] = [];

    for (const patch of this.patches) {
      const ring: number[] = [];
      for (const v of patch.shape) {
        let i = index.get(v);
        if (i === undefined) {
          i = verts.length;
          index.set(v, i);
          verts.push(v);
          pos.push({ x: v.x, y: v.y });
        }
        ring.push(i);
      }
      rings.push(ring);
      flags.push({
        withinCity: patch.withinCity,
        blocked: patch.blocked,
        isInner: this.inner.indexOf(patch) !== -1,
      });
    }

    this.snapshot = {
      verts,
      pos,
      rings,
      flags,
      centerIdx: index.get(this.center) ?? -1,
      plazaIdx: this.plaza ? this.patches.indexOf(this.plaza) : -1,
    };
  }

  private restoreSnapshot(): void {
    const s = this.snapshot;
    if (!s) return;

    // buildGates / smoothStreet 会改写共享顶点坐标，这里复位
    for (let i = 0; i < s.verts.length; i++) s.verts[i].setTo(s.pos[i].x, s.pos[i].y);

    this.patches = s.rings.map((ring, i) => {
      const patch = new Patch(ring.map((k) => s.verts[k]));
      patch.withinCity = s.flags[i].withinCity;
      patch.blocked = s.flags[i].blocked;
      return patch;
    });
    this.inner = this.patches.filter((_, i) => s.flags[i].isInner);
    this.plaza = s.plazaIdx >= 0 ? this.patches[s.plazaIdx] : null;
    this.center = s.centerIdx >= 0 ? s.verts[s.centerIdx] : new Pt();

    this.boundaryOutline = this.inner;
    this.cityRadius = 0;
    this.lots = new Map();
  }

  /** 所有可拖动顶点（坐标快照里的唯一实例） */
  get vertices(): Pt[] {
    return this.snapshot ? this.snapshot.verts : [];
  }

  /** 拖动某个顶点后调用；坐标为世界坐标 */
  moveVertex(v: Pt, x: number, y: number): void {
    v.setTo(x, y);
    if (this.snapshot) {
      const i = this.snapshot.verts.indexOf(v);
      if (i !== -1) {
        this.snapshot.pos[i].x = x;
        this.snapshot.pos[i].y = y;
      }
    }
  }

  // ------------------------------------------------------------------ 阶段 2+

  private buildAll(): void {
    // 固定子种子：只要顶点不变，重建结果就完全一致
    Rng.reset(MODEL_SUBSEED);
    this.createWards();
    this.buildGeometry();
    this.revision++;
  }

  /**
   * 某地块某条边"靠路一侧"的内缩量。
   *
   * 这是整个改造的关键同源点：地块内缩（wards.getCityBlock）与道路横断面
   * （road/system 铺车行道与人行道）必须用同一个数，否则路面会压到建筑红线里，
   * 或者反过来在路和楼之间留一条无主的缝。原版把这个式子写在 getCityBlock 里，
   * 现在抽出来供两边共用。
   */
  insetForEdge(patch: Patch, v0: Pt, v1: Pt): number {
    // 红线宽由这段路在街网里的等级决定（主干道 / 次干道 / 支路），
    // 但**不得低于该等级的最小红线宽**：再窄人行道就没了，路口转角半径
    // 会被压成斜角，街角出现锯齿。这条下限是"圆角不被破坏"的前提。
    const cls = this.roadClassOf(v0, v1);
    const w = Math.max(this.edgeWidthAt(v0, v1), u(specOf(cls).minRedLine));
    return w / 2;
  }

  /**
   * 单条路红线宽（世界单位）：用户单独调过就用调过的值，否则按等级默认。
   *
   * 键是边的**坐标键**（edgeKey）：路宽是"这一段路"的属性，不是地块的属性，
   * 用坐标定位才能在拖顶点后仍对得上同一条边。顶点一挪键就变，覆盖值随之失效，
   * 这是有意的 —— 几何都变了，硬套旧宽度只会得到一条宽度失真的路。
   */
  edgeWidthAt(v0: Pt, v1: Pt): number {
    const w = this.widthOverrides.get(edgeKey(v0, v1));
    return w !== undefined ? w : this.widthOfClass(this.roadClassOf(v0, v1));
  }

  /** 该等级允许的红线宽范围（下限是路口圆角能画出来的前提） */
  edgeWidthRange(v0: Pt, v1: Pt): { min: number; max: number; cls: EdgeClass } {
    const cls = this.roadClassOf(v0, v1);
    return { min: u(specOf(cls).minRedLine), max: 6, cls };
  }

  setEdgeWidth(v0: Pt, v1: Pt, w: number | null): void {
    const key = edgeKey(v0, v1);
    if (w === null) this.widthOverrides.delete(key);
    else this.widthOverrides.set(key, w);
  }

  /** 现代模式：地块边对应的道路等级（未登记的一律按支路处理） */
  roadClassOf(a: Pt, b: Pt): EdgeClass {
    return this.edgeClass.get(edgeKey(a, b)) ?? 'local';
  }

  private widthOfClass(cls: EdgeClass): number {
    const s = this.style;
    return cls === 'arterial' ? s.mainStreetWidth : cls === 'collector' ? s.regularStreetWidth : s.alleyWidth;
  }

  /** 这条边是主干道 —— 要有中央标线与斑马线 */
  edgeIsArterial(v0: Pt, v1: Pt): boolean {
    return this.roadClassOf(v0, v1) === 'arterial';
  }

  /** 新增：边是否被禁建区遮挡（Topology 调用） */
  edgeBlocked(a: Pt, b: Pt): boolean {
    if (this.zonePolys.length === 0) return false;
    return edgeInsideZones(a, b, this.zonePolys);
  }

  private createWards(): void {
    this.lots = new Map();
    this.assignModernLots();
  }

  /**
   * 先按区位规划用途（土地用途分档），再由用途生成建筑群。
   * 地块、路网、内缩这些空间结构与用途规划完全解耦。
   */
  private assignModernLots(): void {
    // cityRadius 必须先算：土地用途按"到中心的归一化半径"分档，
    // 若此时它还是 0，所有地块都会落到最外一档（第一版就是这么错的，
    // 整个城区只剩工业区和绿地）。
    this.cityRadius = 0;
    for (const patch of this.patches) {
      if (!patch.withinCity) continue;
      for (const v of patch.shape) this.cityRadius = Math.max(this.cityRadius, v.length);
    }

    const plan = planLandUse(this);

    for (const patch of this.patches) {
      // 手动覆盖优先于自动分档：把 override 挂回 Patch，下游（地块内容层、
      // 图例、HUD）读到的就是同一份结果，不需要到处再查一次 Map。
      const ov = this.patchEdits.get(patchKey(patch));
      if (ov) patch.override = ov;
      const use = ov?.use ?? plan.use.get(patch);
      if (!use) continue;
      const ward = new ModernWard(this, patch, use, plan.radius.get(patch) ?? 1);
      patch.ward = ward;
      this.lots.set(patch, ward);
    }
  }

  private buildGeometry(): void {
    for (const patch of this.patches) {
      // 禁建区不是"什么都不长"：它是一个封闭地块，照样要有地坪
      // （否则俯视图上就是一个洞，四周的路也没有一侧地块可以配）。
      // 没有 ward 的地块只是不排建筑，地坪由内容层自己铺。
      const w = patch.ward;
      if (!w) continue;

      // 每块地的几何用**自己那条随机流**，不跟邻居排队抽签。
      //
      // 起因是"选中一块地改用途"：手一改，它消耗的随机数个数就变了，后面
      // 每一块地抽到的高度/树位整体错位 —— 改一块、全城重掷，用户没法判断
      // 自己到底改动了什么，也无从对比前后。改成按 `种子 + 地块键` 派生私有
      // 流之后，地块几何变成 (种子, 地块位置, 参数, 覆盖) 的纯函数：
      // 改一块只变这一块，撤销能逐位回到原样，"同一座城"也更好复现。
      //
      // 存/取全局流是为了不影响**几何之外**的抽签（路面、路灯、行道树），
      // 让改造范围只停在建筑几何这一层。
      const saved = Rng.getSeed();
      Rng.reset(seedOfKey(`${this.seed}:${patchKey(patch)}`));
      w.createGeometry();
      Rng.reset(saved);
    }

    // 新增：建筑再按禁建区精确裁剪一次
    if (this.zonePolys.length > 0) {
      for (const patch of this.patches) {
        if (!patch.ward || patch.ward.geometry.length === 0) continue;
        const clipped: Polygon[] = [];
        for (const g of patch.ward.geometry) {
          if (g.length < 3) continue;
          const ring = Array.from(g);
          const parts = subtract(ring, this.zonePolys);
          if (parts.length === 0) continue;
          const base = area(ring);
          for (const part of parts) {
            if (area(part) > base * 0.25 && part.length >= 3) clipped.push(new Polygon(part));
          }
        }
        patch.ward.geometry = clipped;
      }
    }
  }

  // ------------------------------------------------------------------ 查询

  getNeighbour(patch: Patch, v: Pt): Patch | null {
    const next = patch.shape.next(v);
    for (const p of this.patches) if (p.shape.findEdge(next, v) !== -1) return p;
    return null;
  }

  getNeighbours(patch: Patch): Patch[] {
    return this.patches.filter((p) => p !== patch && p.shape.borders(patch.shape));
  }

  isEnclosed(patch: Patch): boolean {
    return patch.withinCity && A.every(this.getNeighbours(patch), (p) => p.withinCity);
  }

  /** 统计信息，供 UI 显示 */
  stats() {
    let buildings = 0;
    for (const p of this.patches) if (p.ward) buildings += p.ward.geometry.length;
    return {
      patches: this.patches.length,
      buildings,
      radius: this.cityRadius,
      blocked: this.patches.filter((p) => p.blocked).length,
    };
  }
}
