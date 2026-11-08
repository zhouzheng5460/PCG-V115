// F2.5-C.2 · 三种道路骨架候选的统一出口
//
//   A tensor   —— 张量场流线（复用 town/field 的 RK4 + Jobard–Lefer）
//   B fracture —— F2.5-C.1 的 Fracture + Merge + Backbone（原样复用，不动一行）
//   C hybrid   —— A 的主路先切出大块，剩余区域交给 B 生成支路，再统一节点化
//
// 三者输出同一份结构：带稳定节点 ID 的图 + 真实道路占地 + 从占地反推的 Compound
// + 一套同口径的度量。于是"选谁"可以看数，也可以看图。

import { Pt } from '../../../../core/geom';
import { bufferPolyline } from '../../../../core/polyline';
import { bboxOf, ringArea, surfaceArea, surfaceIntersect, surfaceOffset, surfaceSubtract, surfaceUnion, type PlanSurface } from '../../core/surface';
import type { SiteRoadEdge } from '../../core/types';
import { accessPointsOf, boundaryAccessOf, type AccessPoint } from '../access';
import { densityPolicy } from '../density';
import { insideRing } from '../fracture';
import { buildGraph, polyLen, type CutLine } from '../graph';
import { fractureVoronoi } from '../fracture';
import { mergeCells } from '../regions';
import { runPipeline } from '../pipeline';
import { STYLES, type StyleId } from '../select';
import { CLASS_RANK, emptyGraph, reindex, type RoadClass, type RoadGraph } from '../types';
import { attachEnds, danglingEnds, type AttachRecord } from './attach';
import { compoundsFromRoads, type Compound, type CompoundResult, type RoadRail } from './parcels';
import { tensorLines } from './tensor';

const M2 = (u2: number) => u2 * 49;

export type SkeletonAlgo = 'tensor' | 'fracture' | 'hybrid';

export const ALGO_LABEL: Record<SkeletonAlgo, string> = {
  tensor: 'A · Tensor-guided',
  fracture: 'B · Fracture-guided',
  hybrid: 'C · Hybrid-guided',
};

export interface SkeletonInput {
  id: string;
  boundary: PlanSurface;
  style: StyleId;
  cellM2: number;
  roads?: SiteRoadEdge[];
  entrances?: Pt[];
  seed: number;
}

export interface SkeletonStats {
  nodes: number;
  edges: number;
  components: number;
  lengthM: number;
  /** 按等级的长度（米） */
  byClass: Record<RoadClass, number>;
  /** 非边界尽端数（应接近 0） */
  deadEnds: number;
  /** < 25 m 的路段数（无意义路段） */
  shortSegments: number;
  /** 转角总数与 >45° 的急转角数 */
  turns: number;
  sharpTurns: number;
  meanTurnDeg: number;
  /** 每 100 m 急转角数（转折连续性） */
  sharpPer100m: number;
  roadAreaM2: number;
  roadRatio: number;
  compounds: {
    count: number;
    medianM2: number;
    meanShapeQ: number;
    slivers: number;
    buildable: number;
    buildableShare: number;
    meanFrontageRatio: number;
  };
  access: { city: number; boundaryOnly: number; none: number };
}

export interface SkeletonResult {
  id: string;
  algo: SkeletonAlgo;
  graph: RoadGraph;
  access: AccessPoint[];
  roadSurface: PlanSurface[];
  compounds: CompoundResult;
  stats: SkeletonStats;
  notes: string[];
  /** 全局前置判定：整片场地是否根本不需要内部路 */
  noRoad: { needed: boolean; why: string };
  trace: {
    tensorLines: number;
    mainLines: number;
    branchLines: number;
    attached: AttachRecord[];
    prunedEdges: number;
    prunedLenM: number;
    dangling: number;
  };
}

export function runSkeleton(algo: SkeletonAlgo, inp: SkeletonInput): SkeletonResult {
  const style = STYLES[inp.style];
  const spacing = spacingOf(inp, style.id);
  const notes: string[] = [];
  const trace: SkeletonResult['trace'] = { tensorLines: 0, mainLines: 0, branchLines: 0, attached: [], prunedEdges: 0, prunedLenM: 0, dangling: 0 };

  /**
   * 前置判定（三种算法共用）：如果"从场地内任一点到红线的距离"已经不超过
   * 该风格的服务半径，就说明整片场地就是一个街区 —— 任何算法都不该在里面切路。
   *
   * 这条判定的意义在于把结论说清楚：F02（160×26 条带）与 I01（5092 m² 园区）
   * 三种候选都输出"无内部道路"，不是算法失败，而是场地本来就只有一块。
   */
  const pre = noRoadCheck(inp);
  if (!pre.needed) {
    const empty = emptyGraph();
    empty.boundary = [inp.boundary.outer, ...inp.boundary.holes];
    reindex(empty);
    const access0 = accessPointsOf(inp.boundary, { roads: inp.roads, entrances: inp.entrances });
    const acc = access0.length ? access0 : boundaryAccessOf(inp.boundary);
    // 判定"无需内部路"时整片场地就是**一个** Compound，不再按长宽比细分：
    // 否则 160×26 的条带会因为 aspect 6.2 > 4.4 被切成两块，与"一块地"的结论自相矛盾。
    const compounds0 = compoundsFromRoads(inp.boundary, [], [], {
      targetMaxM2: Number.POSITIVE_INFINITY,
      targetMinM2: 0,
      maxAspect: 99,
      maxDepth: 0,
    });
    return {
      id: inp.id,
      algo,
      graph: empty,
      access: acc,
      roadSurface: [],
      compounds: compounds0,
      stats: computeStats(empty, inp.boundary, [], compounds0.compounds, acc),
      notes: [pre.why, '三种候选在本场地一致判定为「无需内部道路」—— 这是结论，不是生成失败'],
      noRoad: pre,
      trace,
    };
  }

  let graph: RoadGraph;
  let access: AccessPoint[];

  if (algo === 'fracture') {
    const r = runPipeline({
      id: inp.id,
      boundary: inp.boundary,
      style: inp.style,
      cellM2: inp.cellM2,
      roads: inp.roads,
      entrances: inp.entrances,
    });
    graph = r.graph;
    access = r.access;
    notes.push(...r.backbone?.notes ?? []);
    notes.push(`复用 F2.5-C.1：保留 ${r.merge.keptCuts.length}/${r.frac.cuts.length} 条切线，合并 ${r.merge.merges.length} 次`);
  } else if (algo === 'tensor') {
    const t = tensorLines(inp.boundary, inp.style, { spacingM: spacing, seed: inp.seed });
    notes.push(...t.notes);
    trace.tensorLines = t.lines.length;
    graph = buildGraph(t.lines, { boundary: [inp.boundary.outer, ...inp.boundary.holes], smooth: 2, minEdgeM: 8, snapM: 1.8 });
    const pr = pruneDeadEnds(graph);
    trace.prunedEdges = pr.edges;
    trace.prunedLenM = pr.lengthM;
    if (pr.edges > 0) notes.push(`剪掉接不到任何东西的断头 ${pr.edges} 段 / ${pr.lengthM.toFixed(0)} m`);
    access = accessPointsOf(inp.boundary, { roads: inp.roads, entrances: inp.entrances });
    if (access.length === 0) access = boundaryAccessOf(inp.boundary);
  } else {
    // ---------------- C：主路先切，支路后补
    // 主路用"更疏的间距"追，但不能疏到一条都追不出来：
    // `traceFamily` 有一条"线长 ≥ 间距 × 1.1"的门槛，1.85 倍间距时
    // 140 m 的场地里没有任何一条线能过门槛，C 就退化成 B 了（实测完全同数）。
    const t = tensorLines(inp.boundary, inp.style, { spacingM: spacing * 1.3, seed: inp.seed + 17, maxLines: 14 });
    const all = t.lines.slice().sort((a, b) => polyLenM(b.pts) - polyLenM(a.pts));
    const mainCount = Math.max(1, Math.min(4, Math.round(all.length * 0.45)));
    const main = all.slice(0, mainCount).map((l, i) => ({ ...l, id: `MA${i}`, cls: (i === 0 ? 'arterial' : 'collector') as RoadClass, widthM: style.width[i === 0 ? 'arterial' : 'collector'] }));
    trace.tensorLines = t.lines.length;
    trace.mainLines = main.length;
    notes.push(`主路：张量场 ${t.lines.length} 条里取最长 ${main.length} 条（${main.reduce((s, l) => s + polyLenM(l.pts), 0).toFixed(0)} m）`);

    const mainSurf = footprintOf(main, inp.boundary);
    let rest: PlanSurface[] = [];
    try {
      rest = surfaceSubtract([inp.boundary], mainSurf).filter((s) => M2(surfaceArea(s)) >= 800);
    } catch {
      rest = [];
      notes.push('主路扣减失败（布尔退化）：本轮无支路');
    }

    /**
     * 剩余区域 → 次级街区。
     *
     * 这里**直接调用 B 的两步核心**（fracture + merge），而不是 `runPipeline`：
     * pipeline 带"服务半径"前置判定，而剩余区域四面都是主路，任何一块都满足
     * 服务半径 → 判定为"无需内部路" → 一条支路都不会出（实测 C 退化成"只有主路"）。
     * 但混合方案的意图恰恰是"主路切出大街区，再在大街区里补次级街道"，
     * 所以这里按"街区再切一半"的目标单独跑一次分碎 + 合并。
     */
    const branch: CutLine[] = [];
    const secMax = Math.max(2000, style.blockM2[1] * 0.7);
    const secMin = Math.max(600, style.blockM2[0] * 0.5);
    rest.forEach((piece, i) => {
      const areaM2 = M2(surfaceArea(piece));
      if (areaM2 < secMax * 0.55) return;
      const count = Math.max(3, Math.min(18, Math.round(areaM2 / (secMax * 0.5))));
      const fr = fractureVoronoi(piece, { seed: inp.seed + 101 + i * 7, count, minDistM: 0, relax: 3, jitter: 0.35 });
      const mg = mergeCells(fr, fr.cuts, {
        targetM2: [secMin, secMax],
        weakEdgeM: Math.max(24, style.weakEdgeM * 0.8),
        strongEdgeM: Math.max(70, style.strongEdgeM * 0.8),
      });
      // 次级街道内部再分一档：面积较大区域的保留边里，最长的一批当次干道，
      // 其余当支路。不给这档的话，C 方案除了 1 条主路以外全是"支路"，
      // 图上读不出层级（实测 主33/次0/支67）。
      const sorted = mg.keptCuts.slice().sort((a, b) => b.lenM - a.lenM);
      const colN = Math.max(1, Math.round(sorted.length * 0.4));
      const clsOf = new Map<string, RoadClass>();
      sorted.forEach((k, rank) => clsOf.set(k.id, rank < colN ? 'collector' : 'local'));
      for (const k of mg.keptCuts) {
        // 支路不能是主干道（它接在主路上，是次级）
        const cls: RoadClass = CLASS_RANK[k.cls] >= CLASS_RANK.collector ? 'collector' : clsOf.get(k.id) ?? k.cls;
        branch.push({
          id: `HB${i}_${k.id}`,
          pts: [new Pt(k.a.x, k.a.y), new Pt(k.b.x, k.b.y)],
          cls,
          widthM: style.width[cls],
          source: 'fracture',
        });
      }
    });
    trace.branchLines = branch.length;
    notes.push(`支路：${rest.length} 个剩余区域，共 ${branch.length} 条（复用 C.1 的 fracture+merge+backbone）`);

    const attached = attachEnds([...main, ...branch], inp.boundary, 16);
    trace.attached = attached.records;
    if (attached.records.length > 0) {
      const maxGap = Math.max(...attached.records.map((r) => r.gapM));
      notes.push(`节点化：${attached.records.length} 个悬挂端接到主/支路上（最大缺口 ${maxGap.toFixed(1)} m，投影点已插入目标线）`);
    }
    graph = buildGraph(attached.lines, { boundary: [inp.boundary.outer, ...inp.boundary.holes], smooth: 2, minEdgeM: 8, snapM: 1.8 });
    const pr = pruneDeadEnds(graph);
    trace.prunedEdges = pr.edges;
    trace.prunedLenM = pr.lengthM;
    if (pr.edges > 0) notes.push(`剪掉仍然悬挂的断头 ${pr.edges} 段 / ${pr.lengthM.toFixed(0)} m`);
    access = accessPointsOf(inp.boundary, { roads: inp.roads, entrances: inp.entrances });
    if (access.length === 0) access = boundaryAccessOf(inp.boundary);
  }

  const roadSurface = footprintOfGraph(graph, inp.boundary);
  const rails: RoadRail[] = [...graph.edges.values()].map((e) => ({ pts: e.centerline, halfM: e.widthM / 2 }));
  const compounds = compoundsFromRoads(inp.boundary, roadSurface, rails, {
    targetMaxM2: style.blockM2[1] * 1.1,
    targetMinM2: style.blockM2[0] * 0.55,
    maxAspect: 4.4,
    maxDepth: 4,
  });

  trace.dangling = danglingEnds(
    [...graph.edges.values()].map((e) => ({ pts: e.centerline, cls: e.roadClass, widthM: e.widthM, source: e.source })),
    inp.boundary
  );

  const stats = computeStats(graph, inp.boundary, roadSurface, compounds.compounds, access);
  return { id: inp.id, algo, graph, access, roadSurface, compounds, stats, notes, noRoad: pre, trace };
}

/**
 * 场地是否需要内部道路：把场地打成 4 m 网格，量每格到红线的最短距离。
 *
 * 判据与 F2.5-C.1 的 backbone 完全一致（服务半径），只是这里没有 cell，
 * 所以直接量"到红线"。这样 A/B/C 面对的是同一把尺子。
 */
export function noRoadCheck(inp: SkeletonInput): { needed: boolean; why: string; worstM: number; radiusM: number } {
  const style = STYLES[inp.style];
  const acc = accessPointsOf(inp.boundary, { roads: inp.roads, entrances: inp.entrances });
  const access = acc.length ? acc : boundaryAccessOf(inp.boundary);
  const areaM2 = M2(surfaceArea(inp.boundary));
  const policy = densityPolicy(style, { boundary: inp.boundary, areaM2, access });

  const bb = bboxOf(inp.boundary.outer);
  const step = 4 / 7;
  let worst = 0;
  for (let y = bb.minY + step / 2; y < bb.maxY; y += step) {
    for (let x = bb.minX + step / 2; x < bb.maxX; x += step) {
      const p = new Pt(x, y);
      if (!insideRing(p, inp.boundary)) continue;
      // 只量到**外环**：中庭洞边不是街道，不提供接入（与 C.1 的密度策略同口径）
      worst = Math.max(worst, distanceToRingM(p, { outer: inp.boundary.outer, holes: [] }));
    }
  }
  const needed = worst > policy.serviceRadiusM;
  return {
    needed,
    worstM: +worst.toFixed(1),
    radiusM: policy.serviceRadiusM,
    why: needed
      ? `场地内最远点距红线 ${worst.toFixed(0)} m > 服务半径 ${policy.serviceRadiusM.toFixed(0)} m → 需要内部道路`
      : `场地内最远点距红线 ${worst.toFixed(0)} m ≤ 服务半径 ${policy.serviceRadiusM.toFixed(0)} m → 整片场地就是一个街区，不需要内部道路`,
  };
}

// ---------------------------------------------------------------- 度量

function computeStats(
  g: RoadGraph,
  boundary: PlanSurface,
  roadSurface: PlanSurface[],
  compounds: Compound[],
  access: AccessPoint[]
): SkeletonStats {
  let lengthM = 0;
  const byClass: Record<RoadClass, number> = { arterial: 0, collector: 0, local: 0, internal: 0 };
  let shortSegments = 0;
  for (const e of g.edges.values()) {
    const L = polyLen(e.centerline) * 7;
    lengthM += L;
    byClass[e.roadClass] += L;
    if (L < 25) shortSegments++;
  }

  // 转角：度 2 节点的折角
  let turns = 0;
  let sharp = 0;
  let sumDeg = 0;
  for (const n of g.nodes.values()) {
    const list = g.adjacency.get(n.id) ?? [];
    if (list.length !== 2) continue;
    const d1 = dirOf(g, list[0], n.id);
    const d2 = dirOf(g, list[1], n.id);
    if (!d1 || !d2) continue;
    const cos = Math.max(-1, Math.min(1, d1.x * d2.x + d1.y * d2.y));
    const deg = 180 - (Math.acos(cos) * 180) / Math.PI;
    turns++;
    sumDeg += deg;
    if (deg > 45) sharp++;
  }
  const deadEnds = [...g.nodes.values()].filter((n) => n.connectedEdges.length === 1 && n.nodeType !== 'boundary').length;

  const roadAreaM2 = +M2(roadSurface.reduce((s, x) => s + surfaceArea(x), 0)).toFixed(0);
  const siteArea = M2(surfaceArea(boundary));

  const areas = compounds.map((c) => c.areaM2).sort((a, b) => a - b);
  const medianM2 = areas.length ? areas[Math.floor(areas.length / 2)] : 0;
  const slivers = compounds.filter((c) => c.minorM < 16).length;
  const buildable = compounds.filter((c) => c.areaM2 >= 350 && c.minorM >= 14).length;
  const meanQ = compounds.length ? compounds.reduce((s, c) => s + c.shapeQ, 0) / compounds.length : 0;
  const meanFr = compounds.length ? compounds.reduce((s, c) => s + c.frontageRatio, 0) / compounds.length : 0;

  // 接入：真实城市道路开口 → 仅红线 → 都没有
  let city = 0;
  let boundaryOnly = 0;
  let none = 0;
  const realAccess = access.filter((a) => a.kind !== 'siteBoundary');
  for (const n of g.nodes.values()) {
    if (n.connectedEdges.length === 0) continue;
    const p = n.position;
    const nearReal = realAccess.some((a) => Pt.distance(a.at, p) * 7 <= 12);
    if (nearReal) city++;
    else if (n.nodeType === 'boundary' || distanceToRingM(p, boundary) <= 3) boundaryOnly++;
    else none++;
  }

  return {
    nodes: g.nodes.size,
    edges: g.edges.size,
    components: g.connectedComponents.length,
    lengthM: +lengthM.toFixed(1),
    byClass: {
      arterial: +byClass.arterial.toFixed(1),
      collector: +byClass.collector.toFixed(1),
      local: +byClass.local.toFixed(1),
      internal: +byClass.internal.toFixed(1),
    },
    deadEnds,
    shortSegments,
    turns,
    sharpTurns: sharp,
    meanTurnDeg: turns ? +(sumDeg / turns).toFixed(1) : 0,
    sharpPer100m: lengthM > 1 ? +((sharp / lengthM) * 100).toFixed(2) : 0,
    roadAreaM2,
    roadRatio: siteArea > 0 ? +(roadAreaM2 / siteArea).toFixed(3) : 0,
    compounds: {
      count: compounds.length,
      medianM2,
      meanShapeQ: +meanQ.toFixed(3),
      slivers,
      buildable,
      buildableShare: compounds.length ? +(buildable / compounds.length).toFixed(2) : 0,
      meanFrontageRatio: +meanFr.toFixed(3),
    },
    access: { city, boundaryOnly, none },
  };
}

function dirOf(g: RoadGraph, eid: string, nodeId: string): Pt | null {
  const e = g.edges.get(eid);
  if (!e) return null;
  const pts = e.centerline;
  if (pts.length < 2) return null;
  if (e.from === nodeId) {
    const d = new Pt(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
    const l = Math.hypot(d.x, d.y) || 1;
    return new Pt(d.x / l, d.y / l);
  }
  const n = pts.length;
  const d = new Pt(pts[n - 2].x - pts[n - 1].x, pts[n - 2].y - pts[n - 1].y);
  const l = Math.hypot(d.x, d.y) || 1;
  return new Pt(d.x / l, d.y / l);
}

function distanceToRingM(p: Pt, s: PlanSurface): number {
  let best = Infinity;
  for (const ring of [s.outer, ...s.holes]) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l2 = dx * dx + dy * dy;
      if (l2 < 1e-12) continue;
      let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
      t = Math.max(0, Math.min(1, t));
      best = Math.min(best, Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)));
    }
  }
  return best * 7;
}

// ---------------------------------------------------------------- 道路占地

/** 一组中心线 → 真实占地（并集，裁到场地内） */
export function footprintOf(lines: CutLine[], boundary: PlanSurface): PlanSurface[] {
  const ribbons: PlanSurface[] = [];
  for (const l of lines) {
    const ring = bufferPolyline(l.pts, l.widthM / 2 / 7);
    if (ring) ribbons.push({ outer: ring, holes: [] });
  }
  return clipToSite(unionAll(ribbons), boundary);
}

export function footprintOfGraph(g: RoadGraph, boundary: PlanSurface): PlanSurface[] {
  const ribbons: PlanSurface[] = [];
  for (const e of g.edges.values()) {
    const ring = bufferPolyline(e.centerline, e.widthM / 2 / 7);
    if (ring) ribbons.push({ outer: ring, holes: [] });
  }
  return clipToSite(unionAll(ribbons), boundary);
}

/**
 * 逐条并集（fold）。polygon-clipping 对"几十条共享边"的批量并集会退化，
 * 折叠 + 5 mm 微偏移重试能把成功率拉到 100%（同 C.1 的 tryUnion）。
 */
export function unionAll(list: PlanSurface[]): PlanSurface[] {
  if (list.length === 0) return [];
  let acc: PlanSurface[] = [list[0]];
  for (let i = 1; i < list.length; i++) {
    const b = list[i];
    let merged = false;
    for (let j = 0; j < acc.length; j++) {
      const u = unionPair(acc[j], b);
      if (u && u.length === 1) {
        // 只替换被合并的那一块，其余原样保留。
        // （早先版本这里写成 `next=[u[0]] + acc.slice(1)`，一旦合并发生在 acc[2]，
        //   acc[0]/acc[1] 就被丢掉了 —— 路面积少了 3/4，扣地块时又"多出"一块地。）
        acc = acc.map((x, k) => (k === j ? u[0] : x));
        merged = true;
        break;
      }
    }
    if (!merged) acc.push(b);
  }
  return acc;
}

function unionPair(a: PlanSurface, b: PlanSurface): PlanSurface[] | null {
  try {
    const u = surfaceUnion([a, b]).filter((q) => surfaceArea(q) > 1e-6);
    if (u.length === 1) return u;
  } catch {
    /* 下面的微偏移 */
  }
  try {
    const off = surfaceOffset(a, 5 / 1000 / 7);
    const u = surfaceUnion([...(off.length ? off : [a]), b]).filter((q) => surfaceArea(q) > 1e-6);
    if (u.length === 1) return u;
  } catch {
    /* 放弃 */
  }
  return null;
}

function clipToSite(list: PlanSurface[], boundary: PlanSurface): PlanSurface[] {
  const out: PlanSurface[] = [];
  for (const s of list) {
    /**
     * 先去掉"针孔洞"。两条路带十字相交时，polygon-clipping 有时会在交叉口
     * 中间留一个几平方米的洞 —— evenodd 填充下就是一个灰色的方块（F01 实测）。
     * 路面不可能有 20 m² 以下的中庭，按面积滤掉即可；真正的洞（场地里的中庭）
     * 是靠下面与 boundary 求交裁出来的，不受影响。
     */
    const clean = s.holes.length ? { outer: s.outer, holes: s.holes.filter((h) => Math.abs(ringArea(h)) * 49 >= 20) } : s;
    try {
      out.push(...surfaceIntersect([clean], [boundary]).filter((q) => M2(surfaceArea(q)) > 1));
    } catch {
      out.push(clean);
    }
  }
  return out;
}

// ---------------------------------------------------------------- 剪断头

/** 反复剪掉"度数 1 且不在红线"的边（它们接不到任何东西） */
export function pruneDeadEnds(g: RoadGraph): { edges: number; lengthM: number } {
  let edges = 0;
  let lengthM = 0;
  for (let guard = 0; guard < 40; guard++) {
    const kill: string[] = [];
    for (const n of g.nodes.values()) {
      if (n.connectedEdges.length !== 1) continue;
      if (n.nodeType === 'boundary') continue;
      kill.push(n.connectedEdges[0]);
    }
    if (kill.length === 0) break;
    for (const eid of kill) {
      const e = g.edges.get(eid);
      if (!e) continue;
      lengthM += polyLen(e.centerline) * 7;
      g.edges.delete(eid);
      edges++;
    }
    reindex(g);
    for (const [id, n] of [...g.nodes]) if (n.connectedEdges.length === 0) g.nodes.delete(id);
    reindex(g);
  }
  return { edges, lengthM: +lengthM.toFixed(1) };
}

export function polyLenM(pts: Pt[]): number {
  return polyLen(pts) * 7;
}

/** 风格决定的流线间距（米） */
export function spacingOf(inp: SkeletonInput, style: StyleId): number {
  // 间距按"街区尺度"给：城市里两条街之间 60~100 m 是常态。
  // 给太密（40~50 m）时主次路宽度会把道路占地推到 40% 以上，C01 上实测 54% —— 视觉上是停车场不是街区。
  const base = style === 'structured' ? 62 : style === 'campus' ? 95 : 62;
  // 场地越小，街区尺度越小（但要保证至少能出 2~3 条街）
  const area = M2(surfaceArea(inp.boundary));
  const scale = Math.max(0.7, Math.min(1.25, Math.sqrt(area / 12000)));
  return Math.round(base * scale);
}
