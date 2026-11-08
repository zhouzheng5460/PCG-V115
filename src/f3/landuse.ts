// F3-H · 用地混合与多中心可达性场
//
// 为什么要这一层：原来 `blocks.ts:assignUses` 把 **整块街区** 按「到城市中心的距离」
// 排序后一次性指定一个用途，`height.ts:gradient` 也只吃 centerDist 一个变量。
// 于是①一个街区里全是同一种（且同高）的建筑，②全城按半径一级级往下掉，成梯形。
//
// 现实机制（本轮调研）：
//  · Bid-rent 的「同心圈」是"胜者全得"的理论抽象；Wheaton (2004) 指出土地按各用途
//    竞租**比例共享**，Anas & Kim (1996) 用位置的未观测特征 + 效用变化解释混合配置
//    ——> 用途应当是**按概率分摊到地块**，而不是整街区硬指派。
//  · 漳州市自然资源局、六安市规划技术规定：沿快速路 / 交通性主干路两侧优先布置
//    沿街商业；带状商业面宽占所临道路长度有上限（支路 ≤70%，其他道路不宜超 40%）
//    ——> 宽路两侧是「概率更高」，不是整条街全商业，且要有占比上限。
//  · Philadelphia Fed《Making Sense of Urban Patterns》：主干街从 CBD 逐渐过渡到
//    商住混合，一英里外还有第二就业中心密度回升；环路×放射线交汇形成次中心
//    ——> 可达性是**多中心 + 廊道**，不是单一径向。
//  · 大连中山区三维景观研究：超高层在 ~660 m 内聚集、更大尺度离散，高容积率地块
//    占比少且集中在少数街道 ——> 小尺度成簇、大尺度分散，用低频连续场而非逐栋随机。
//
// 因此本模块只做两件事，不碰路网、不碰地块切分、不碰建筑布局：
//   ① buildLandUseField：建一个确定性的**可达性场**（主中心软核 + 宽路廊道 +
//      干道交汇次中心 + 两尺度区位噪声）；
//   ② assign：在已切好的 BuildingParcel 粒度，按竞租分数做 softmax 概率抽样，
//      用目标配比校准 bias，并给沿街带状商业加占比上限。
//
// 街区原来的 use 不清空，降级为「主导用途 / 切分尺度依据 / 分区先验」。

import { Pt } from '../core/geom';
import { centroidOf } from './blocks';
import { distPointToPolyline } from './geom';
import type {
  BlockUse,
  BuildingParcel,
  CityBlock,
  CityProgram,
  CitySpec,
  PathGraph,
  RoadClass3,
  RoadPath,
  StylePreset,
} from './types';

const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));

/** FNV-1a，字符串 → 32 位无符号 */
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 确定性二维哈希：[0,1) */
function hash2(ix: number, iy: number, seed: number): number {
  let h = (Math.imul(ix | 0, 374761393) + Math.imul(iy | 0, 668265263) + Math.imul(seed | 0, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smooth = (t: number): number => t * t * (3 - 2 * t);

/** 双线性 value noise，输出 -1~1。cellU 是世界单位（1 U = 7 m） */
function valueNoise(p: Pt, cellU: number, seed: number): number {
  const gx = Math.floor(p.x / cellU);
  const gy = Math.floor(p.y / cellU);
  const fx = smooth(p.x / cellU - gx);
  const fy = smooth(p.y / cellU - gy);
  const a = hash2(gx, gy, seed);
  const b = hash2(gx + 1, gy, seed);
  const c = hash2(gx, gy + 1, seed);
  const d = hash2(gx + 1, gy + 1, seed);
  return 2 * ((a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy) - 1;
}

/** 参与地块级概率分配的用途。park 保留给街区级中央公园，不往小地块里撒 */
const USES: BlockUse[] = ['residential', 'commercial', 'cbd', 'industrial', 'campus', 'civic', 'green'];

/**
 * 各 program 的目标配比（地块数量口径）。
 * 数字是"规划分区的主导 + 兼容比例"，不是硬分区：每一项都会经 softmax 概率抽样打散。
 */
const TARGET: Record<CityProgram, Record<BlockUse, number>> = {
  mixed: { residential: 58, commercial: 19, cbd: 6, industrial: 5, campus: 3, civic: 4, park: 0, green: 4 },
  residential: { residential: 72, commercial: 10, cbd: 1, industrial: 2, campus: 2, civic: 5, park: 0, green: 6 },
  commercial: { residential: 44, commercial: 32, cbd: 8, industrial: 3, campus: 2, civic: 5, park: 0, green: 4 },
  cbd: { residential: 32, commercial: 27, cbd: 21, industrial: 3, campus: 4, civic: 5, park: 0, green: 5 },
  industrial: { residential: 14, commercial: 7, cbd: 0, industrial: 62, campus: 3, civic: 5, park: 0, green: 7 },
  campus: { residential: 16, commercial: 7, cbd: 0, industrial: 3, campus: 56, civic: 7, park: 0, green: 9 },
};

/** 道路等级 → 廊道权重与衰减半径（米）。宽路影响更远 */
// 三级路网下 collector 才是承担大部分临街面的那一级（实测占总街长 56%），
// 权重给 0.62 会让"宽路临街"和支路拉不开差距；按 GB 的城市商业分布，
// 次干临街仍应明显高于支路。arterial : collector : local ≈ 1 : 0.72 : 0.18。
const CLASS_W: Record<RoadClass3, number> = { arterial: 1.0, collector: 0.72, local: 0.18 };
const FALLOFF_M: Record<RoadClass3, number> = { arterial: 34, collector: 24, local: 13 };

/** 带状商业占所临道路的临街地块比例上限（六安市规划技术规定口径） */
const FRONTAGE_CAP: Record<RoadClass3, number> = { arterial: 0.4, collector: 0.4, local: 0.7 };

const SOFTMAX_T = 0.45;

export interface SiteContext {
  /** 综合可达性 0~1 */
  access: number;
  /** 主中心软核 0~1 */
  core: number;
  /** 宽路廊道强度 0~1 */
  corridor: number;
  /** 次中心强度 0~1 */
  sub: number;
  /** 低频区位场（-1~1）：让同类在 ~150 m 尺度成簇 */
  local: number;
  /** 高频区位场（-1~1）：局部绿地/小体量斑块 */
  fine: number;
  centerDist: number;
  /** 最近道路等级 */
  cls: RoadClass3;
  /** 最近道路完整断面宽（米） */
  roadWidthM: number;
  /** 形心到路缘的距离（米，已减去半路宽） */
  edgeM: number;
  frontRow: boolean;
  /** 街角强度 0~1 */
  corner: number;
  nearPathId: string;
}

export interface LandUseResult {
  notes: string[];
  byUse: Record<string, number>;
  /** 地块数 ≥4 的街区里，内部出现 ≥2 种用途的比例 */
  mixRatio: number;
  /** 临主干/次干的商业占比 / 临支路的商业占比 */
  arterialBias: number;
}

interface PathInfo {
  path: RoadPath;
  widthM: number;
  halfU: number;
  falloffM: number;
  w: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

interface SubCenter {
  at: Pt;
  w: number;
  /** 高斯半径（世界单位） */
  rU: number;
}

export interface LandUseField {
  at(p: Pt): SiteContext;
  assign(parcels: BuildingParcel[], blocks: CityBlock[]): LandUseResult;
  subcenters: SubCenter[];
}

function sectionWidthM(preset: StylePreset, cls: RoadClass3): number {
  const s = preset.section[cls];
  return s.carriage + 2 * (s.curb + s.walk + s.green);
}

export function buildLandUseField(spec: CitySpec, preset: StylePreset, graph: PathGraph): LandUseField {
  // 城市几何中心与半径
  let cx = 0;
  let cy = 0;
  for (const p of spec.boundary.outer) {
    cx += p.x;
    cy += p.y;
  }
  cx /= Math.max(1, spec.boundary.outer.length);
  cy /= Math.max(1, spec.boundary.outer.length);
  let maxD = 1;
  for (const p of spec.boundary.outer) maxD = Math.max(maxD, Math.hypot(p.x - cx, p.y - cy));

  const paths: PathInfo[] = graph.paths.map((path) => {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of path.pts) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    const widthM = sectionWidthM(preset, path.cls);
    return {
      path,
      widthM,
      halfU: widthM / 14,
      falloffM: FALLOFF_M[path.cls],
      // 宽度也进权重：同为 arterial，越宽的断面商业吸引力越强
      w: CLASS_W[path.cls] * (0.62 + 0.38 * clamp(widthM / 30, 0, 1)),
      minX,
      maxX,
      minY,
      maxY,
    };
  });

  const junctions: Pt[] = [];
  for (const id of graph.junctions) {
    const n = graph.nodes.get(id);
    if (n) junctions.push(n.at);
  }

  const seed = (spec.seed ^ hashStr(`${spec.program}|${spec.style}`)) >>> 0;
  const coarseCellU = Math.max(8, maxD / 4.2); // ≈ 150 m：小尺度簇
  const fineCellU = Math.max(3.5, maxD / 12); // ≈ 55 m：局部斑块

  /** 不含次中心的廊道强度（选次中心时要先有它，避免循环依赖） */
  function corridorAt(p: Pt): { v: number; nearest: PathInfo | null; edgeM: number; cls: RoadClass3; widthM: number; pathId: string } {
    let v = 0;
    let nearest: PathInfo | null = null;
    let bestDU = Infinity;
    let bestEdgeM = Infinity;
    for (const pi of paths) {
      // 包围盒下界剪枝：到盒子的距离已经大于当前最近值就不用算折线了
      const bx = Math.max(0, pi.minX - p.x, p.x - pi.maxX);
      const by = Math.max(0, pi.minY - p.y, p.y - pi.maxY);
      if (Math.hypot(bx, by) > bestDU + 0.001) continue;
      const dU = distPointToPolyline(p, pi.path.pts);
      if (dU < bestDU) {
        bestDU = dU;
        nearest = pi;
        bestEdgeM = Math.max(0, dU * 7 - pi.widthM / 2);
      }
      const edgeM = Math.max(0, dU * 7 - pi.widthM / 2);
      const g = Math.exp(-Math.pow(edgeM / pi.falloffM, 2));
      v = Math.max(v, pi.w * g);
    }
    return {
      v: clamp(v, 0, 1),
      nearest,
      edgeM: bestEdgeM,
      cls: nearest?.path.cls ?? 'local',
      widthM: nearest?.widthM ?? 10,
      pathId: nearest?.path.id ?? '',
    };
  }

  /**
   * 次中心：优先取「距主中心 0.24~0.88 半径、且本身在宽路廊道上」的路网交汇点，
   * 贪心挑彼此间距 > 0.26R 的最多 3 个。对应环路×放射线交汇 / 就业副中心。
   * 交汇点不够时，用主干道上的 1/3、2/3 位置补位。
   */
  const cand = junctions
    .map((at) => {
      const cd = Math.hypot(at.x - cx, at.y - cy) / maxD;
      return { at, cd, score: corridorAt(at).v * 0.75 + hash2(Math.round(at.x * 50), Math.round(at.y * 50), seed) * 0.25 };
    })
    .filter((x) => x.cd > 0.32 && x.cd < 0.9)
    .sort((a, b) => b.score - a.score);
  const subcenters: SubCenter[] = [];
  for (const c of cand) {
    if (subcenters.length >= 3) break;
    if (subcenters.some((s) => Math.hypot(s.at.x - c.at.x, s.at.y - c.at.y) < maxD * 0.26)) continue;
    subcenters.push({ at: c.at, w: subcenters.length === 0 ? 0.7 : 0.56, rU: maxD * 0.2 });
  }
  for (const pi of paths) {
    if (subcenters.length >= 3) break;
    if (pi.path.cls !== 'arterial' || pi.path.pts.length < 2) continue;
    for (const t of [0.34, 0.67]) {
      const i = Math.floor((pi.path.pts.length - 1) * t);
      const at = pi.path.pts[i];
      const cd = Math.hypot(at.x - cx, at.y - cy) / maxD;
      if (cd < 0.22 || cd > 0.9) continue;
      if (subcenters.some((s) => Math.hypot(s.at.x - at.x, s.at.y - at.y) < maxD * 0.26)) continue;
      subcenters.push({ at, w: 0.6, rU: maxD * 0.18 });
      if (subcenters.length >= 3) break;
    }
  }

  function at(p: Pt): SiteContext {
    const cd = Math.hypot(p.x - cx, p.y - cy) / maxD;
    const core = 1 / (1 + Math.pow(cd / 0.34, 2));
    const cor = corridorAt(p);
    let sub = 0;
    for (const s of subcenters) {
      const d = Math.hypot(p.x - s.at.x, p.y - s.at.y);
      sub = Math.max(sub, s.w * Math.exp(-Math.pow(d / s.rU, 2)));
    }
    const local = valueNoise(p, coarseCellU, seed ^ 0x51ed);
    const fine = valueNoise(p, fineCellU, seed ^ 0x7a3b);

    let corner = 0;
    for (const j of junctions) {
      const dM = Math.hypot(p.x - j.x, p.y - j.y) * 7;
      corner = Math.max(corner, 1 - clamp(dM / 34, 0, 1));
    }

    const access = clamp(0.56 * core + 0.28 * cor.v + 0.26 * sub + 0.08 * (0.5 + 0.5 * local) + 0.04, 0, 1);
    const edgeM = Number.isFinite(cor.edgeM) ? cor.edgeM : 999;
    return {
      access,
      core,
      corridor: cor.v,
      sub,
      local,
      fine,
      centerDist: cd,
      cls: cor.cls,
      roadWidthM: cor.widthM,
      edgeM,
      frontRow: edgeM < 26,
      corner,
      nearPathId: cor.pathId,
    };
  }

  function normalizeTarget(): Record<BlockUse, number> {
    const raw = TARGET[spec.program];
    let sum = 0;
    for (const u of USES) sum += Math.max(0, raw[u]);
    const out = {} as Record<BlockUse, number>;
    for (const u of USES) out[u] = Math.max(0, raw[u]) / Math.max(1e-6, sum);
    return out;
  }

  /** 单个地块对某用途的竞租分数（线性部分；softmax 后即"竞租比例共享"） */
  function scoreOf(use: BlockUse, s: SiteContext, parcel: BuildingParcel, block: CityBlock, bias: Record<BlockUse, number>): number {
    const a = s.access;
    const c = s.corridor;
    const sizeT = clamp(Math.log(Math.max(40, parcel.areaM2) / 700) / 1.8, -0.5, 0.7);
    let v = bias[use];

    // 街区主导用途只作为**分区先验**，不再是硬指派
    if (block.use === use) v += 0.42;
    else if (block.use === 'cbd' && use === 'commercial') v += 0.16;
    else if (block.use === 'commercial' && use === 'cbd') v += 0.1;
    else if (block.use === 'residential' && use === 'commercial') v += 0.05;
    else if (block.use === 'industrial' && use === 'campus') v += 0.03;

    switch (use) {
      case 'residential':
        v += 0.22 * (1 - a) - 0.14 * c + (s.frontRow ? 0 : 0.1);
        break;
      case 'commercial':
        // 用户给的判据：宽路两侧商业几率更高；街角、临街第一排再加一档
        v += 0.9 * a + 1.05 * c + 0.42 * s.corner + (s.frontRow ? 0.3 : 0);
        break;
      case 'cbd':
        // 只在可达性峰值区出现：主中心 + 少数次中心。低可达性给负分，
        // 防止下面的比例校准为了凑配额把写字楼摊到全城（那会变成"撒胡椒面"）。
        // 同时明显偏向大地块：写字楼需要大盘，落到小地块上只能盖细柱，
        // 也保不住上一轮"CBD 沿街可放开占用原本多个建筑范围"的判据。
        v += 4.0 * Math.max(0, a - 0.6) - 2.0 * Math.max(0, 0.6 - a) + 0.22 * c + 1.25 * (sizeT + 0.5);
        break;
      case 'industrial':
        v += 0.85 * (1 - a) - 0.55 * c + 0.25 * (1 - s.core);
        break;
      case 'campus':
        v += 0.3 * s.local - 0.18 * a;
        break;
      case 'civic':
        v += 0.22 * s.local + 0.1 * (1 - a);
        break;
      case 'green':
        v += 0.35 * s.fine - 0.3 * a - (s.frontRow ? 0.1 : 0) - 0.45 * Math.max(0, sizeT);
        break;
      default:
        break;
    }
    return v;
  }

  function pick(scores: Record<BlockUse, number>, u: number): BlockUse {
    let mx = -Infinity;
    for (const k of USES) mx = Math.max(mx, scores[k]);
    let sum = 0;
    const w = {} as Record<BlockUse, number>;
    for (const k of USES) {
      w[k] = Math.exp((scores[k] - mx) / SOFTMAX_T);
      sum += w[k];
    }
    let acc = 0;
    for (const k of USES) {
      acc += w[k] / sum;
      if (u <= acc) return k;
    }
    return USES[USES.length - 1];
  }

  function assign(parcels: BuildingParcel[], blocks: CityBlock[]): LandUseResult {
    const notes: string[] = [];
    const byBlock = new Map(blocks.map((b) => [b.id, b]));
    const sites = new Map<string, SiteContext>();
    const eligible: { parcel: BuildingParcel; block: CityBlock; s: SiteContext; u: number }[] = [];

    for (const parcel of parcels) {
      const block = byBlock.get(parcel.blockId);
      if (!block) continue;
      const s = at(centroidOf(parcel.surface.outer));
      sites.set(parcel.id, s);
      parcel.access = +s.access.toFixed(4);
      parcel.corridor = +s.corridor.toFixed(4);
      parcel.localIntensity = +s.local.toFixed(4);
      parcel.streetCls = s.cls;
      parcel.frontRow = s.frontRow;
      parcel.nearPathId = s.nearPathId;
      // 公园/绿地街区保持完整：现实里公园是成片的，不往里面撒住宅
      if (block.use === 'park' || block.use === 'green') {
        parcel.use = block.use;
        parcel.useWhy = '街区级公园/绿地，保持完整不参与混合';
        continue;
      }
      eligible.push({ parcel, block, s, u: Math.max(1e-6, hashStr(`${parcel.id}|use`) / 4294967296) });
    }

    const target = normalizeTarget();
    const bias = {} as Record<BlockUse, number>;
    for (const k of USES) bias[k] = 0;

    // 比例校准：Wheaton 的"按竞租比例共享"需要配比约束，否则全城会被高可达性用途吃满。
    // 每次都用同一个确定性 u，迭代 4 轮即可收敛，仍然逐块概率抽样、不产生硬分区。
    for (let iter = 0; iter < 4; iter++) {
      const count = {} as Record<BlockUse, number>;
      for (const k of USES) count[k] = 0;
      for (const e of eligible) {
        const scores = {} as Record<BlockUse, number>;
        for (const k of USES) scores[k] = scoreOf(k, e.s, e.parcel, e.block, bias);
        count[pick(scores, e.u)]++;
      }
      const n = Math.max(1, eligible.length);
      for (const k of USES) {
        const got = count[k] / n;
        const delta = 0.55 * Math.log((target[k] + 0.004) / (got + 0.004));
        // CBD 只设上限不设下限：宁可少几栋塔楼，也不能把它们摊到低可达性地块
        const step = k === 'cbd' && delta > 0 ? 0 : delta;
        bias[k] = clamp(bias[k] + step, -2.6, 2.6);
      }
    }

    const byUse: Record<string, number> = {};
    for (const e of eligible) {
      const scores = {} as Record<BlockUse, number>;
      for (const k of USES) scores[k] = scoreOf(k, e.s, e.parcel, e.block, bias);
      const use = pick(scores, e.u);
      e.parcel.use = use;
      byUse[use] = (byUse[use] ?? 0) + 1;
      e.parcel.useWhy =
        `可达性 ${e.s.access.toFixed(2)}（中心 ${e.s.core.toFixed(2)} / 廊道 ${e.s.corridor.toFixed(2)}` +
        ` / 次中心 ${e.s.sub.toFixed(2)}）· ${e.s.cls} 断面 ${e.s.roadWidthM.toFixed(1)} m` +
        ` · 路缘距 ${e.s.edgeM.toFixed(0)} m${e.s.frontRow ? '（临街第一排）' : ''}` +
        ` → ${use}`;
    }

    // 带状商业占比上限：同一条街的临街第一排里，商业+CBD 不能超过规定比例。
    // 超出的部分挑"竞租优势最小"的几块退回居住，避免一条街被商业铺满。
    const byPath = new Map<string, { parcel: BuildingParcel; s: SiteContext; cls: RoadClass3 }[]>();
    for (const e of eligible) {
      // 口径对齐「商业建筑面宽 / 所临道路长度」：已经划为绿地/公园的地块
      // 既不可能有商业建筑，也不该进分母把它稀释掉。
      if (!e.s.frontRow || !e.s.nearPathId || e.parcel.use === 'park' || e.parcel.use === 'green') continue;
      const arr = byPath.get(e.s.nearPathId) ?? [];
      arr.push({ parcel: e.parcel, s: e.s, cls: e.s.cls });
      byPath.set(e.s.nearPathId, arr);
    }
    let capped = 0;
    for (const [, arr] of byPath) {
      if (arr.length < 4) continue;
      const cap = FRONTAGE_CAP[arr[0].cls];
      const com = arr.filter((x) => x.parcel.use === 'commercial' || x.parcel.use === 'cbd');
      const allowed = Math.floor(arr.length * cap);
      if (com.length <= allowed) continue;
      com.sort((a, b) => {
        const sa = scoreOf(a.parcel.use, a.s, a.parcel, byBlock.get(a.parcel.blockId)!, bias) - scoreOf('residential', a.s, a.parcel, byBlock.get(a.parcel.blockId)!, bias);
        const sb = scoreOf(b.parcel.use, b.s, b.parcel, byBlock.get(b.parcel.blockId)!, bias) - scoreOf('residential', b.s, b.parcel, byBlock.get(b.parcel.blockId)!, bias);
        return sa - sb;
      });
      for (let i = 0; i < com.length - allowed; i++) {
        const was = com[i].parcel.use;
        com[i].parcel.use = 'residential';
        com[i].parcel.useWhy = `沿 ${com[i].cls} 带状商业占比超过 ${(cap * 100).toFixed(0)}% 上限，退回居住兼容用地`;
        byUse[was] = Math.max(0, (byUse[was] ?? 0) - 1);
        byUse['residential'] = (byUse['residential'] ?? 0) + 1;
        capped++;
      }
    }

    // 街区内部用途种数
    const perBlock = new Map<string, Set<BlockUse>>();
    for (const e of eligible) {
      const set = perBlock.get(e.parcel.blockId) ?? new Set<BlockUse>();
      set.add(e.parcel.use);
      perBlock.set(e.parcel.blockId, set);
    }
    let mixed = 0;
    let counted = 0;
    for (const [id, set] of perBlock) {
      const n = eligible.filter((e) => e.parcel.blockId === id).length;
      if (n < 4) continue;
      counted++;
      if (set.size >= 2) mixed++;
    }
    const mixRatio = counted ? mixed / counted : 0;

    // 宽路 vs 支路的商业占比（只统计临街第一排，口径一致）
    const front = eligible.filter((e) => e.s.frontRow);
    const isCom = (u: BlockUse): boolean => u === 'commercial' || u === 'cbd';
    const wide = front.filter((e) => e.s.cls !== 'local');
    const narrow = front.filter((e) => e.s.cls === 'local');
    const wideShare = wide.length ? wide.filter((e) => isCom(e.parcel.use)).length / wide.length : 0;
    const narrowShare = narrow.length ? narrow.filter((e) => isCom(e.parcel.use)).length / narrow.length : 0;
    const arterialBias = narrowShare > 0.001 ? wideShare / narrowShare : wideShare > 0 ? 99 : 1;

    const parts = USES.filter((u) => (byUse[u] ?? 0) > 0)
      .map((u) => `${u} ${((100 * (byUse[u] ?? 0)) / Math.max(1, eligible.length)).toFixed(1)}%`)
      .join(' / ');
    notes.push(
      `用地混合：${eligible.length} 个地块参与竞租概率分配 · 次中心 ${subcenters.length} 处 · ` +
        `街区内出现 ≥2 种用途的比例 ${(mixRatio * 100).toFixed(0)}%`
    );
    notes.push(`用地配比：${parts}`);
    notes.push(
      `沿街商业：宽路临街 ${wide.length} 块中 ${(wideShare * 100).toFixed(1)}% 为商业/CBD，` +
        `支路临街 ${narrow.length} 块中 ${(narrowShare * 100).toFixed(1)}%（倍率 ${arterialBias.toFixed(2)}）；` +
        `带状上限回退 ${capped} 块`
    );

    return { notes, byUse, mixRatio, arterialBias };
  }

  return { at, assign, subcenters };
}
