// F3-C · 道路围合的街区与二次地块切分
//
// 街区（Block）= 道路围合出来的一块地，**不是**建筑子地块。
// 一个街区按用途继续切成若干 BuildingParcel —— 切分数量由
//「用途目标尺度 + 实际面积 + 形状」推，不是"每块地切四块"。
//
// 切分线是 ParcelBoundary，不是道路：这里产出的任何一条线都不会进路面层。

import { Pt } from '../core/geom';
import {
  bboxOf,
  insideSurface,
  surfaceArea,
  surfaceIntersect,
  surfaceSubtract,
  type PlanSurface,
} from '../town/planning/core/surface';
import { makeRng, obbOf, splitSurfaceByLine } from '../town/planning/subdivision/geom';
import { M2, U, areaM2, distPointToPolyline, polyLen, shapeOf } from './geom';
import { binarySplit } from './lotsplit';
import type { BuildingParcel, CityBlock, CitySpec, PathGraph, RoadPath, StylePreset } from './types';

export interface BlockResult {
  blocks: CityBlock[];
  notes: string[];
  /** 小于 60 m² 的碎渣：不放进街区列表（切不动），但仍是场地里的地，必须入账 */
  crumbs: PlanSurface[];
}

const USE_FROM_PROGRAM: Record<string, CityBlock['use'][]> = {
  residential: ['residential'],
  commercial: ['commercial'],
  cbd: ['cbd', 'commercial'],
  industrial: ['industrial'],
  campus: ['campus'],
  mixed: ['residential', 'commercial', 'cbd'],
};

export function buildBlocks(
  spec: CitySpec,
  preset: StylePreset,
  /** 唯一真值源：完整且已圆角的道路用地面 */
  reserve: PlanSurface[],
  graph: PathGraph,
  /** 兼容旧调用：圆角已并入 reserve，此参数不再参与扣减 */
  _corners: PlanSurface[] = []
): BlockResult {
  const notes: string[] = [];
  let blocks: PlanSurface[] = [spec.boundary];
  try {
    blocks = surfaceSubtract([spec.boundary], reserve);
  } catch {
    notes.push('街区扣减失败：道路用地布尔异常，退回整个场地（不静默当成功）');
    blocks = [spec.boundary];
  }
  void _corners;

  /**
   * 这里**不再单独减转角铺装**。
   *
   * 以前 reserve 只是「每条路外轮廓 + 路口」的并集，街角的圆弧是另一份
   * 独立生成的 corner 片，必须再补一刀才不会让地块压在铺装上 —— 但那两片
   * 几何是各算各的，边界永远对不齐。现在圆角就是 reserve 自己的形状，
   * 一次 `场地 − 路网面` 得到的闭合范围天生与图上完全一致。
   */

  /**
   * 只丢掉真正没意义的渣（< 60 m²）。
   *
   * 原来丢 < 180 m² 的：那些碎片虽然放不下建筑，但它们是**真实的地**，
   * 丢掉之后面积对账就会差出 3%（I01 只有 5092 m²，153 m² 就是 3%）。
   * 现在保留下来，由用途分配统一做成口袋绿地 —— 既不空着，账也闭得上。
   */
  const pieces = blocks.filter((s) => areaM2(s) >= 60);
  const crumbs = blocks.filter((s) => areaM2(s) < 60);
  const dropped = crumbs.length;

  // 中心与最近道路
  let cx = 0;
  let cy = 0;
  for (const p of spec.boundary.outer) {
    cx += p.x;
    cy += p.y;
  }
  cx /= spec.boundary.outer.length;
  cy /= spec.boundary.outer.length;
  let maxD = 1;
  for (const p of spec.boundary.outer) maxD = Math.max(maxD, Math.hypot(p.x - cx, p.y - cy));

  const out: CityBlock[] = pieces.map((s, i) => {
    const c = centroidOf(s.outer);
    const near = nearestPath(graph, c);
    const centerDist = Math.hypot(c.x - cx, c.y - cy) / maxD;
    return {
      id: `B${i + 1}`,
      surface: s,
      areaM2: +areaM2(s).toFixed(1),
      use: 'residential',
      nearestCls: near?.cls ?? 'local',
      centerDist: +centerDist.toFixed(3),
      frontRad: frontRadOf(s, c, near),
      why: '',
    };
  });

  assignUses(spec, out, notes);
  notes.push(
    `街区：${out.length} 块（丢弃 <60 m² 的碎渣 ${dropped} 块）· 面积中位 ${median(out.map((b) => b.areaM2)).toFixed(0)} m²`
  );
  return { blocks: out, notes, crumbs };
}

/**
 * 街区**主导用途**分配：纯规则 + 排序，不做评分。
 *
 * 注意：这一步现在只决定 ① 该街区的地块切分尺度（parcelM2[use]）② 分区先验。
 * 每个地块最终的用途由 `landuse.ts` 在多中心可达性场下按竞租概率重新分配，
 * 所以这里给整块街区一个 use 不再等于"整块街区只盖这一种建筑"。
 */
function assignUses(spec: CitySpec, blocks: CityBlock[], notes: string[]): void {
  const byCenter = blocks.slice().sort((a, b) => a.centerDist - b.centerDist || b.areaM2 - a.areaM2);
  const byArea = blocks.slice().sort((a, b) => b.areaM2 - a.areaM2);
  const kind = spec.program;

  const set = (b: CityBlock, use: CityBlock['use'], why: string): void => {
    b.use = use;
    b.why = why;
  };

  // 小碎块统一做口袋绿地：它们放不下任何建筑类型
  for (const b of blocks) if (b.areaM2 < 700) set(b, 'green', `面积 ${b.areaM2.toFixed(0)} m² < 700，做口袋绿地`);

  const usable = byCenter.filter((b) => b.use === 'residential');
  if (usable.length === 0) {
    notes.push('没有可用大街区：全部按口袋绿地处理');
    return;
  }

  if (kind === 'industrial') {
    usable.forEach((b, i) => set(b, i === 0 ? 'civic' : 'industrial', i === 0 ? '入口第一块做园区服务/办公' : '园区主地块：大进深厂房 + 货场'));
  } else if (kind === 'campus') {
    usable.forEach((b, i) => {
      if (i === usable.length - 1 && b.areaM2 > 4000) set(b, 'green', '园区保留绿地');
      else set(b, 'campus', '校园/园区组团：少而大的建筑 + 内院');
    });
  } else if (kind === 'cbd') {
    usable.forEach((b, i) => {
      if (i === 0 || (i === 1 && b.areaM2 > 3000)) set(b, 'cbd', '城市中心：裙房 + 塔楼');
      else if (i <= 3) set(b, 'commercial', '中心外围商业街块');
      else if (i === usable.length - 1 && b.areaM2 > 6000) set(b, 'park', '最大街区做中央公园');
      else set(b, 'residential', '外围居住街区');
    });
  } else if (kind === 'commercial') {
    usable.forEach((b, i) => {
      if (i <= 1) set(b, 'commercial', '临主街商业街区');
      else if (i === 2 && b.areaM2 > 2500) set(b, 'civic', '公共设施（社区中心）');
      else set(b, 'residential', '商业区背后的居住街区');
    });
  } else if (kind === 'residential') {
    // 用"面积排序的第一块"当公园：不在遍历中途按 use 反查（那时的 use 还没分完）
    const bigId = byArea.filter((b) => b.areaM2 >= 700).sort((a, b) => b.areaM2 - a.areaM2)[0]?.id ?? '';
    usable.forEach((b, i) => {
      if (b.id === bigId && b.areaM2 > 6000) set(b, 'park', `最大街区 ${b.areaM2.toFixed(0)} m² 做社区公园`);
      else if (i === 1 && b.nearestCls !== 'local') set(b, 'commercial', '次干道旁一块做沿街商业');
      else if (i === 3 && b.areaM2 > 2000) set(b, 'civic', '社区公共设施');
      else set(b, 'residential', '居住街区');
    });
  } else {
    // mixed：中心 CBD / 次中心商业 / 一块公园 / 外围居住
    usable.forEach((b, i) => {
      if (i === 0) set(b, 'cbd', '最靠中心：CBD 塔楼 + 裙房');
      else if (i <= 2) set(b, 'commercial', '中心外围商业');
      else if (i === usable.length - 1 && b.areaM2 > 6000) set(b, 'park', '最大街区做公园');
      else if (i === 4 && b.areaM2 > 2500) set(b, 'civic', '公共设施');
      else set(b, 'residential', '外围居住');
    });
  }
}

// ---------------------------------------------------------------- 二次切分

export interface ParcelResult {
  parcels: BuildingParcel[];
  notes: string[];
}

/**
 * 街区 → 建筑子地块：**沿街面宽驱动**的成排成列切分。
 *
 * 上一版是"取最大块、按面积二分"——那只会得到 60~120 m 的长条（实测中位 67 m），
 * 是街区尺度，不是地块尺度。Houdini / CityEngine 那一套是：
 *   ① 沿**进深**方向把街区切成若干"排"（排深 = 目标地块进深）
 *   ② 每一排沿**面宽**方向切成若干"户"（户宽 = 目标面宽）
 *   ③ 面宽/进深按用途给（住宅窄而浅、厂房宽而深），并带确定性抖动
 *
 * 于是每个地块都直接临街（第一排）或临后排（后续排），面宽落在 8~30 m，
 * 这才是"沿街地块"该有的尺度。
 */
export function splitParcels(
  block: CityBlock,
  preset: StylePreset,
  densityScale: number,
  seed: number,
  mode: 'binary' | 'row' = 'row',
  /** 一级分区前缀：同一街区被张量场切成几块大分区时，地块 id 不能撞车 */
  idPrefix: string = block.id
): ParcelResult {
  const notes: string[] = [];
  const rng = makeRng(seed, `parcel-${block.id}`);
  const use = block.use;

  if (use === 'park' || use === 'green') {
    return {
      parcels: [makeParcel(block, block.surface, 0, idPrefix)],
      notes: [`${block.id} 是${use === 'park' ? '公园' : '绿地'}，不切分`],
    };
  }

  /**
   * 目标面宽/进深**由预设的地块目标面积推**，不写死常量：
   *
   *   A = (parcelM2[use] 的中值) × 密度倍率²
   *   宽 : 深 = 1.15 : 1   →  depth = √(A / 1.15)，width = √(A × 1.15)
   *
   * 这是一个显式公式：换用途或换密度，地块尺度就跟着变，而不是改一堆魔数。
   */
  const range = preset.parcelM2[use as keyof StylePreset['parcelM2']] ?? [500, 900];
  const A = ((range[0] + range[1]) / 2) * densityScale * densityScale;
  const aspect = 1.15;
  const depthM = Math.sqrt(A / aspect) * (0.9 + rng() * 0.22);
  const widthM = Math.sqrt(A * aspect) * (0.9 + rng() * 0.22);
  const depthU = U(depthM);
  const widthU = U(widthM);
  const minArea = Math.max(60, A * 0.22);

  /**
   * 二叉分割路径：街区直接随机对半切成**不规则子地块**，不再"排 × 户"。
   *
   * 文中 Houdini 的做法是对每个 poly 区域反复随机二分生成小路，得到不规则的
   * pattern；这里切出来的线同样是地块边界（不是路面），但形状不再受规则网格约束。
   * 建筑再在每个子地块里偏移一次，于是"街区 → 地块 → 建筑"三层是同一套语言。
   *
   * 每个街区给独立 seed：binarySplit 内部用固定 tag 起随机序列，
   * 传同一个 seed 会让所有街区的刀角/切点序列一模一样。
   */
  if (mode === 'binary') {
    /**
     * 每个街区的目标块尺度带倍率：固定 target 会把全城切成一样大的块，
     * 而文章的"随机分割"本来就产生**大小不一**的块 —— 有大地块才谈得上
     * 小区/内部路网，有小地块才是沿路别墅式布局。
     *
     * 但文中同时提醒「两种情况下地块面积都不宜过大，如果地块过大，① 的中心
     * 会很空，② 的步行路线将过长」。所以倍率收窄到 0.8~1.7，并给一个绝对
     * 上限 2600 m²（旧版 0.7~2.2 曾切出 6342 m² 的"地块"，那其实是街区尺度）。
     * CBD 是例外：用户判据要求"放开占用原本多个建筑的范围"，它本来就需要
     * 1000~2000 m² 的大盘，所以上限不压到商业那种小尺度。
     */
    const commercialish = use === 'commercial' || use === 'cbd';
    const scale = commercialish ? 0.85 + rng() * 0.7 : 0.8 + rng() * 0.9;
    /**
     * 尺度按用途分流（截图 2/3 vs 截图 5）：
     *   · 住宅/园区类要**围出内院**：地块太小时四条边各退一排建筑，院子只剩
     *     10 m 的缝（实测 500 m² 地块围出 10×10 m），根本不像院子。放大到
     *     ~1300 m²（约 36×36 m）才有 20 m 见方的内院，也才会触发"大地块配
     *     内部路网"的城市小区场景。
     *   · 商业/CBD 保持小地块：文中明确「地块面积都不宜过大，如果地块过大，
     *     ① 的中心会很空，② 的步行路线将过长」，且商业只留最外一圈。
     */
    const target = Math.min(A * scale * (commercialish ? 1 : 1.9), commercialish ? 1400 : 2600);
    const faces = binarySplit(block.surface, {
      seed: (seed ^ idSeed(block.id)) >>> 0,
      axisRad: block.frontRad,
      targetM2: target,
      minM2: Math.max(80, target * 0.22),
      minSideM: 9,
      maxDepth: 8,
    });
    const ps = faces.filter((q) => areaM2(q) >= 12).map((q, i) => makeParcel(block, q, i, idPrefix));
    if (ps.length === 0) {
      return { parcels: [makeParcel(block, block.surface, 0, idPrefix)], notes: [`${block.id}：二叉分割失败，退回整块`] };
    }
    return {
      parcels: ps,
      notes: [`${block.id}：二叉分割 → ${ps.length} 个不规则地块（目标 ${target.toFixed(0)} m²，实际中位 ${medianArea(ps).toFixed(0)} m²）`],
    };
  }

  const ux = Math.cos(block.frontRad);
  const uy = Math.sin(block.frontRad);
  const along = block.frontRad + Math.PI / 2;

  // ① 成排：沿进深方向切
  const rows = sliceAlong(block.surface, { x: ux, y: uy }, along, depthU, minArea * 1.6);
  // ② 每排成列：沿面宽方向切
  const lots: PlanSurface[] = [];
  for (const row of rows) {
    const vx = Math.cos(along);
    const vy = Math.sin(along);
    lots.push(...sliceAlong(row, { x: vx, y: vy }, block.frontRad, widthU, minArea));
  }

  /**
   * 小块**不丢**：丢掉就等于这块地凭空消失，面积对账会差出 3%（R01 实测 747 m²）。
   * 留成地块，到建筑那一步按"太小不盖房"处理（做绿地）。
   */
  const parcels = lots.filter((q) => areaM2(q) >= 12).map((q, i) => makeParcel(block, q, i, idPrefix));
  if (parcels.length === 0) {
    return { parcels: [makeParcel(block, block.surface, 0, idPrefix)], notes: [`${block.id}：切分失败，退回整块`] };
  }
  notes.push(
    `${block.id}：${rows.length} 排 × 平均 ${(parcels.length / Math.max(1, rows.length)).toFixed(1)} 户（进深 ${(depthU * 7).toFixed(0)} m / 面宽 ${(widthU * 7).toFixed(0)} m）`
  );
  void preset;
  return { parcels, notes };
}

/**
 * 沿一个方向按固定间距切片。
 *
 * `u` 是"被切的方向"（切完沿它增长），`cutAng` 是刀口方向。
 * 每次切下**靠近起点**的一片，剩下的继续切；最后一片不足 0.55 个间距时并入前一片，
 * 避免出现 3 m 宽的"纸片地"。
 */
function sliceAlong(s: PlanSurface, u: { x: number; y: number }, cutAng: number, stepU: number, minAreaM2: number): PlanSurface[] {
  const proj = (p: Pt): number => p.x * u.x + p.y * u.y;
  let rest = s;
  const out: PlanSurface[] = [];
  const c0 = centroidOf(rest.outer);
  let t = proj(c0) - extentOf(rest.outer, u) / 2 + stepU;
  for (let guard = 0; guard < 40; guard++) {
    const span = extentOf(rest.outer, u);
    if (span < stepU * 1.55) break;
    const c = centroidOf(rest.outer);
    const shift = t - proj(c);
    const at = new Pt(c.x + u.x * shift, c.y + u.y * shift);
    const sp = splitSurfaceByLine(rest, at, cutAng);
    if (!sp) break;
    // 取靠近起点的一侧当"片"
    const aA = sp.a.reduce((acc, q) => acc + M2(surfaceArea(q)), 0);
    const bA = sp.b.reduce((acc, q) => acc + M2(surfaceArea(q)), 0);
    const centerOf = (list: PlanSurface[]): number => {
      let tot = 0;
      let sum = 0;
      for (const q of list) {
        const ar = M2(surfaceArea(q));
        tot += ar;
        sum += proj(centroidOf(q.outer)) * ar;
      }
      return tot > 0 ? sum / tot : Infinity;
    };
    const farA = centerOf(sp.a);
    const farB = centerOf(sp.b);
    const nearList = farA <= farB ? sp.a : sp.b;
    const farList = farA <= farB ? sp.b : sp.a;
    const nearA = farA <= farB ? aA : bA;
    if (nearA < minAreaM2 * 0.5) {
      // 切出来的第一条太窄：把间距加大再试，避免无限循环
      t += stepU * 0.5;
      if (t > proj(c0) + extentOf(s.outer, u)) break;
      continue;
    }
    out.push(...nearList.filter((q) => M2(surfaceArea(q)) > 2));
    const farTotal = (farA <= farB ? bA : aA);
    if (farTotal < minAreaM2) {
      out.push(...farList.filter((q) => M2(surfaceArea(q)) > 2));
      return out;
    }
    rest = farList.length === 1 ? farList[0] : mergePartsOr(farList);
    t += stepU;
  }
  if (areaM2(rest) > 2) out.push(rest);
  return out;
}

/** 多块时只保留最大的一块继续切，其余作为独立片直接给出（避免形状退化） */
function mergePartsOr(list: PlanSurface[]): PlanSurface {
  return list.reduce((a, b) => (M2(surfaceArea(b)) > M2(surfaceArea(a)) ? b : a), list[0]);
}

function extentOf(ring: Pt[], u: { x: number; y: number }): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of ring) {
    const t = p.x * u.x + p.y * u.y;
    lo = Math.min(lo, t);
    hi = Math.max(hi, t);
  }
  return Math.max(1e-6, hi - lo);
}

/** 各地块用途的目标尺度（米）。宽度 = 沿街面宽，深度 = 从街往里进深 */
const LOT_SIZE: Record<string, { widthM: number; depthM: number }> = {
  residential: { widthM: 22, depthM: 24 },
  commercial: { widthM: 16, depthM: 26 },
  cbd: { widthM: 34, depthM: 36 },
  industrial: { widthM: 78, depthM: 62 },
  campus: { widthM: 92, depthM: 70 },
  civic: { widthM: 46, depthM: 34 },
  park: { widthM: 60, depthM: 60 },
  green: { widthM: 60, depthM: 60 },
};

/** FNV-1a：把街区 id 混进 seed，避免所有街区拿到同一串随机数 */
function idSeed(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function medianArea(ps: BuildingParcel[]): number {
  const a = ps.map((p) => p.areaM2).sort((x, y) => x - y);
  return a.length ? a[Math.floor(a.length / 2)] : 0;
}

function makeParcel(block: CityBlock, s: PlanSurface, i: number, idPrefix: string): BuildingParcel {
  return {
    id: `${idPrefix}-P${i + 1}`,
    blockId: block.id,
    use: block.use,
    surface: s,
    areaM2: +areaM2(s).toFixed(1),
    frontRad: blockFrontRad(block),
    frontDistM: 0,
  };
}

/**
 * 街区"面向街道"的方向：**从街道指向街区内部**。
 *
 * 做法：取最近道路上的最近点 P，方向 = 归一化(形心 − P)；再吸附到 OBB 的两条轴里
 * 与它最接近的那一条（带正负号）。直接用"形心−P"会被凹边带偏，直接用 OBB 轴
 * 又不知道朝哪一侧 —— 两者结合既稳又有确定朝向。
 */
export function frontRadOf(surface: PlanSurface, c: Pt, near: RoadPath | null): number {
  const ob = obbOf(surface.outer);
  if (!ob) return 0;
  const axes: [number, number][] = [
    [ob.ux, ob.uy],
    [ob.vx, ob.vy],
  ];
  if (!near) return Math.atan2(axes[0][1], axes[0][0]);
  let bp: Pt | null = null;
  let bd = Infinity;
  const pts = near.pts;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    let t = l2 < 1e-12 ? 0 : ((c.x - a.x) * dx + (c.y - a.y) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    const p = new Pt(a.x + dx * t, a.y + dy * t);
    const d = Pt.distance(c, p);
    if (d < bd) {
      bd = d;
      bp = p;
    }
  }
  if (!bp) return Math.atan2(axes[0][1], axes[0][0]);
  let dx = c.x - bp.x;
  let dy = c.y - bp.y;
  const L = Math.hypot(dx, dy) || 1;
  dx /= L;
  dy /= L;
  let best = axes[0];
  let bestDot = -Infinity;
  for (const ax of axes) {
    const dot = Math.abs(ax[0] * dx + ax[1] * dy);
    if (dot > bestDot) {
      bestDot = dot;
      best = ax;
    }
  }
  const sign = best[0] * dx + best[1] * dy >= 0 ? 1 : -1;
  return Math.atan2(best[1] * sign, best[0] * sign);
}

export function blockFrontRad(block: CityBlock): number {
  return block.frontRad;
}

// ---------------------------------------------------------------- 工具

export function centroidOf(ring: Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p.x;
    y += p.y;
  }
  const n = Math.max(1, ring.length);
  return new Pt(x / n, y / n);
}

export function nearestPath(graph: PathGraph, at: Pt): RoadPath | null {
  let best: RoadPath | null = null;
  let bestD = Infinity;
  for (const p of graph.paths) {
    const d = distPointToPolyline(at, p.pts);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

function median(list: number[]): number {
  if (list.length === 0) return 0;
  const s = list.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** 点在某个方向上的投影（用于"沿进深方向的中间"取刀位） */
function project(p: Pt, ang: number): number {
  return p.x * Math.cos(ang) + p.y * Math.sin(ang);
}

/** 环在某个方向上的跨度 */
function extents(ring: Pt[], ang: number): { lo: number; hi: number; span: number } {
  const ux = Math.cos(ang);
  const uy = Math.sin(ang);
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of ring) {
    const t = p.x * ux + p.y * uy;
    lo = Math.min(lo, t);
    hi = Math.max(hi, t);
  }
  return { lo, hi, span: hi - lo };
}

function norm(a: number): number {
  let x = a;
  while (x >= Math.PI / 2) x -= Math.PI;
  while (x < -Math.PI / 2) x += Math.PI;
  return x;
}

/** 地块短轴（米）：判狭长 */
export function parcelMinorM(s: PlanSurface): number {
  return shapeOf(s).minorM;
}

void insideSurface;
void surfaceIntersect;
void U;
void polyLen;
