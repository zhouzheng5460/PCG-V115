// F3-B · 城市路网：张量方向 → 破碎/格网 → 合并 → PathGraph
//
// 规则驱动，没有候选也没有评分：
//   structured  张量方向上的正交格网（主干贯通、次干每三条一道）
//   organic     两条顺张量场的流线当主街 + 沿场排布的 Voronoi 街区合并出支路
//   campus      一条主轴 + 两条横向分支，其余整片保留
//
// 破碎/合并直接复用 F2.5 的 `fractureVoronoi` / `mergeCells`（不重写几何），
// 但**不使用** Connectivity Backbone —— 那里是全局寻优器，本阶段不需要。

import { Pt } from '../core/geom';
import { TensorField, type FieldSource } from '../town/field/tensor';
import { bboxOf, surfaceArea, surfaceInset, type PlanSurface } from '../town/planning/core/surface';
import { fractureVoronoi, type Cell, type Cut } from '../town/planning/roadgraph/fracture';
import { mergeCells } from '../town/planning/roadgraph/regions';
import { makeRng } from '../town/planning/subdivision/geom';
import { obbOf } from '../town/planning/subdivision/geom';
import {
  U,
  cleanRing,
  clipLineToSurface,
  nearRings,
  polyLen,
  sampleAlong,
} from './geom';
import { type CitySpec, type PathEdge, type PathGraph, type PathNode, type RawRoad, type RoadClass3, type RoadPath, type StylePreset } from './types';

export interface StreetResult {
  raws: RawRoad[];
  graph: PathGraph;
  axisRad: number;
  notes: string[];
  /** 破碎/合并的中间数据（报告与 Golden 出图要能追溯） */
  cells: Cell[];
  cuts: Cut[];
}

const ARTERIAL_SHARE = 0.1;

export function generateStreets(spec: CitySpec, preset: StylePreset): StreetResult {
  const notes: string[] = [];
  const axisRad = spec.axisRad ?? mainAxisOf(spec.boundary);
  const densityScale = spec.density === 'high' ? 0.86 : spec.density === 'low' ? 1.16 : 1;

  let raws: RawRoad[] = [];
  let cells: Cell[] = [];
  let cuts: Cut[] = [];

  if (spec.style === 'structured') {
    raws = gridRoads(spec, preset, axisRad, densityScale, notes);
  } else if (spec.style === 'organic') {
    const r = organicRoads(spec, preset, axisRad, densityScale, notes);
    raws = r.raws;
    cells = r.cells;
    cuts = r.cuts;
  } else {
    raws = campusRoads(spec, preset, axisRad, densityScale, notes);
  }

  // 统一收尾：太短的不要（一条 6 m 的路在图上就是一个黑斑）
  const minLen = spec.style === 'campus' ? 45 : 28;
  raws = raws.filter((r) => polyLen(r.pts) * 7 >= minLen);

  const graph = buildPathGraph(raws, spec.boundary);
  notes.push(
    `${spec.style}：街道 ${raws.length} 条（主干 ${raws.filter((r) => r.cls === 'arterial').length} / 次干 ${
      raws.filter((r) => r.cls === 'collector').length
    } / 支路 ${raws.filter((r) => r.cls === 'local').length}），节点 ${graph.nodes.size}，路径 ${graph.paths.length}，路口 ${graph.junctions.length}`
  );
  return { raws, graph, axisRad, notes, cells, cuts };
}

/** 场地主轴：OBB 长轴（确定性，且与"城市长边"一致） */
export function mainAxisOf(boundary: PlanSurface): number {
  const ob = obbOf(boundary.outer);
  if (!ob) return 0;
  return Math.atan2(ob.uy, ob.ux);
}

// ---------------------------------------------------------------- 三种生成

function gridRoads(spec: CitySpec, preset: StylePreset, axisRad: number, densityScale: number, notes: string[]): RawRoad[] {
  const spacing = U(preset.spacingM * densityScale);
  const bb = bboxOf(spec.boundary.outer);
  const diag = Math.hypot(bb.maxX - bb.minX, bb.maxY - bb.minY);
  const cx = (bb.minX + bb.maxX) / 2;
  const cy = (bb.minY + bb.maxY) / 2;
  const out: RawRoad[] = [];

  const addFamily = (ang: number, tag: string): void => {
    const nx = -Math.sin(ang);
    const ny = Math.cos(ang);
    const n = Math.ceil(diag / spacing / 2) + 1;
    for (let k = -n; k <= n; k++) {
      const at = new Pt(cx + nx * k * spacing, cy + ny * k * spacing);
      for (const seg of clipLineToSurface(spec.boundary, at, ang)) {
        const len = polyLen(seg);
        if (len * 7 < 30) continue;
        // 贴着红线跑的平行线会切出 10 m 的细条地块 —— 宁可少一条街。
        // 注意用**线段中点**判：裁出来的段只有两个点，取 seg[len/2] 拿到的是
        // 端点（正好落在红线上），会把整族线全部误删（实测街道数 0）。
        const mid = new Pt((seg[0].x + seg[seg.length - 1].x) / 2, (seg[0].y + seg[seg.length - 1].y) / 2);
        if (nearRings(mid, [spec.boundary.outer], U(20))) continue;
        const cls: RoadClass3 = k === 0 && tag === 'A' ? 'arterial' : Math.abs(k) % 3 === 1 || (tag === 'B' && k === 0) ? 'collector' : 'local';
        out.push({ id: `${tag}${k >= 0 ? 'p' : 'n'}${Math.abs(k)}`, pts: seg, cls, from: 'grid' });
      }
    }
  };

  addFamily(axisRad, 'A');
  addFamily(axisRad + Math.PI / 2, 'B');
  notes.push(`规则格网：间距 ${(spacing * 7).toFixed(0)} m，主方向 ${((axisRad * 180) / Math.PI).toFixed(1)}°（场地 OBB 长轴）`);
  return out;
}

function organicRoads(
  spec: CitySpec,
  preset: StylePreset,
  axisRad: number,
  densityScale: number,
  notes: string[]
): { raws: RawRoad[]; cells: Cell[]; cuts: Cut[] } {
  const spacing = U(preset.spacingM * densityScale);
  const field = cityField(spec.boundary, axisRad, 0.4);

  // ① 两条顺场流线当主街（有机城市里"一条顺着地形走的主路"是骨架）
  const raws: RawRoad[] = [];
  const bb = bboxOf(spec.boundary.outer);
  const cy = (bb.minY + bb.maxY) / 2;
  const cx = (bb.minX + bb.maxX) / 2;
  const perp = axisRad + Math.PI / 2;
  for (let i = -1; i <= 1; i++) {
    const off = i * spacing * 0.9;
    const start = new Pt(cx + Math.cos(perp) * off, cy + Math.sin(perp) * off);
    const line = streamlineThrough(spec.boundary, field, start, axisRad);
    if (!line || polyLen(line) * 7 < 60) continue;
    raws.push({ id: `stream${i + 1}`, pts: line, cls: i === 0 ? 'arterial' : 'collector', from: 'spine' });
  }

  // ② 沿场排布的站点 → Voronoi 街区 → 确定性合并 → 剩余共享边当支路
  // 站点按**半个街区**铺：相邻两块合并成一个街区，合并这一步才有活干。
  // 按整街区铺站点时每块都刚好达标，一条都不并 —— 于是每条 cell 边都成了支路
  // （实测 1.03 km² 的城市出了 307 条街，路面占 44%）。
  const cellTarget = preset.blockM2;
  const lat = Math.sqrt(cellTarget * 0.5) / 7; // 世界单位
  const sites = latticeSites(spec.boundary, field, axisRad, lat * 0.94, spec.seed, 0.22);
  const fr = fractureVoronoi(spec.boundary, {
    seed: spec.seed,
    count: sites.length,
    relax: 0,
    jitter: 0,
    sites,
    minCellM2: 240,
  });
  const merged = mergeCells(fr, fr.cuts, {
    targetM2: [cellTarget * 0.82, cellTarget * 1.18],
    weakEdgeM: Math.max(26, preset.spacingM * 0.2),
    strongEdgeM: Math.max(90, preset.spacingM * 0.7),
  });

  const kept = merged.keptCuts
    .filter((k) => k.lenM >= 22)
    .filter((k) => !nearRings(new Pt((k.a.x + k.b.x) / 2, (k.a.y + k.b.y) / 2), [spec.boundary.outer], U(8)));

  // 按长度分档（条数口径，不按长度分位 —— 线少的时候长度分位会失控）
  const sorted = kept.slice().sort((a, b) => b.lenM - a.lenM);
  const colN = Math.max(1, Math.round(sorted.length * 0.3));
  const rankOf = new Map<string, number>();
  sorted.forEach((k, i) => rankOf.set(k.id, i));

  for (const k of kept) {
    const r = rankOf.get(k.id) ?? 999;
    const cls: RoadClass3 = r < colN ? 'collector' : 'local';
    raws.push({ id: `F_${k.id}`, pts: [new Pt(k.a.x, k.a.y), new Pt(k.b.x, k.b.y)], cls, from: 'fracture' });
  }

  notes.push(
    `有机破碎：站点 ${sites.length}（沿张量方向排布）→ 街区 ${fr.cells.length} → 合并保留 ${kept.length} 条内部边界当支路`
  );
  return { raws, cells: fr.cells, cuts: kept };
}

function campusRoads(spec: CitySpec, preset: StylePreset, axisRad: number, densityScale: number, notes: string[]): RawRoad[] {
  const out: RawRoad[] = [];
  const bb = bboxOf(spec.boundary.outer);
  const cx = (bb.minX + bb.maxX) / 2;
  const cy = (bb.minY + bb.maxY) / 2;
  const span = Math.hypot(bb.maxX - bb.minX, bb.maxY - bb.minY);
  const spacing = preset.spacingM * densityScale;

  // 主轴：过形心、沿 OBB 长轴
  const spine = clipLineToSurface(spec.boundary, new Pt(cx, cy), axisRad);
  const longest = spine.slice().sort((a, b) => polyLen(b) - polyLen(a))[0];
  if (longest) out.push({ id: 'spine', pts: longest, cls: 'arterial', from: 'spine' });

  // 横向分支：主轴两侧各一条，位置在 1/3 跨度处
  for (const k of [-1, 1]) {
    const at = new Pt(cx + Math.cos(axisRad) * (k * U(spacing) * 1.1), cy + Math.sin(axisRad) * (k * U(spacing) * 1.1));
    const segs = clipLineToSurface(spec.boundary, at, axisRad + Math.PI / 2);
    for (const seg of segs) if (polyLen(seg) * 7 > 60) out.push({ id: `br${k}`, pts: seg, cls: 'collector', from: 'spine' });
  }

  // 再补一条与主轴平行的次干，避免整片园区只有一个方向
  const par = clipLineToSurface(spec.boundary, new Pt(cx + Math.cos(axisRad + Math.PI / 2) * U(spacing) * 0.95, cy + Math.sin(axisRad + Math.PI / 2) * U(spacing) * 0.95), axisRad);
  for (const seg of par) if (polyLen(seg) * 7 > 70) out.push({ id: 'par0', pts: seg, cls: 'collector', from: 'spine' });

  notes.push(`园区骨架：主轴 ${(polyLen(longest ?? []) * 7).toFixed(0)} m + ${out.length - 1} 条分支，跨度 ${(span * 7).toFixed(0)} m`);
  return out;
}

// ---------------------------------------------------------------- 张量场

export function cityField(boundary: PlanSurface, axisRad: number, boundaryStrength: number): TensorField {
  const sources: FieldSource[] = [
    {
      id: 'axis',
      type: 'grid',
      direction: new Pt(Math.cos(axisRad), Math.sin(axisRad)),
      radius: U(400),
      strength: 1,
    },
    {
      id: 'edge',
      type: 'boundary',
      radius: U(95),
      strength: boundaryStrength,
      falloff: 1.6,
    },
  ];
  return new TensorField(sources, boundary.outer);
}

/** 从 start 出发、沿 `family` 方向积分出一条流线，出界即停（两端各补到红线） */
function streamlineThrough(boundary: PlanSurface, field: TensorField, start: Pt, axisRad: number): Pt[] | null {
  const step = U(7);
  const march = (dir: 1 | -1): Pt[] => {
    const out: Pt[] = [new Pt(start.x, start.y)];
    let p = new Pt(start.x, start.y);
    for (let i = 0; i < 400; i++) {
      const a = field.angleAt(p.x, p.y, 'major').a;
      const dx = Math.cos(a) * dir;
      const dy = Math.sin(a) * dir;
      const nx = p.x + dx * step;
      const ny = p.y + dy * step;
      const cand = new Pt(nx, ny);
      if (!insideSurfaceLite(cand, boundary)) break;
      out.push(cand);
      p = cand;
    }
    return out;
  };
  const fwd = march(1);
  const back = march(-1);
  if (fwd.length + back.length < 6) return null;
  const line = [...back.slice(1).reverse(), ...fwd];
  // 场可能把线拧回去（coherence 低的地方），修一下方向漂移过大的点
  const fixed: Pt[] = [line[0]];
  for (let i = 1; i < line.length; i++) {
    const prev = fixed[fixed.length - 1];
    const d = Pt.distance(prev, line[i]);
    if (d < step * 0.25) continue;
    fixed.push(line[i]);
  }
  void axisRad;
  return fixed.length >= 3 ? cleanRing(fixed) : null;
}

function insideSurfaceLite(p: Pt, s: PlanSurface): boolean {
  const inRing = (ring: Pt[]): boolean => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i];
      const b = ring[j];
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y || 1e-12) + a.x) inside = !inside;
    }
    return inside;
  };
  if (!inRing(s.outer)) return false;
  for (const h of s.holes) if (inRing(h)) return false;
  return true;
}

/**
 * 沿张量方向排布的抖动格点。
 *
 * 站点连线的中垂线就是将来的街区边界，所以格子的朝向 = 街区朝向。
 * 抖动用固定 seed：同一 spec 必须得到同一批点。
 */
function latticeSites(boundary: PlanSurface, field: TensorField, axisRad: number, spacingU: number, seed: number, jitter: number): Pt[] {
  const rng = makeRng(seed, 'f3lattice');
  const bb = bboxOf(boundary.outer);
  const cx = (bb.minX + bb.maxX) / 2;
  const cy = (bb.minY + bb.maxY) / 2;
  const ux = Math.cos(axisRad);
  const uy = Math.sin(axisRad);
  const vx = -uy;
  const vy = ux;
  const half = Math.hypot(bb.maxX - bb.minX, bb.maxY - bb.minY) / 2 + spacingU;
  const n = Math.ceil(half / spacingU) + 1;
  const out: Pt[] = [];
  for (let i = -n; i <= n; i++) {
    for (let j = -n; j <= n; j++) {
      // 每一行沿场方向错开一点：横向是严格格点，纵向跟着场走
      const bx = cx + ux * i * spacingU + vx * j * spacingU;
      const by = cy + uy * i * spacingU + vy * j * spacingU;
      const a = field.angleAt(bx, by, 'major').a;
      const warp = (a - axisRad) * spacingU * 0.55;
      const px = bx + vx * warp + (rng() - 0.5) * spacingU * jitter;
      const py = by + vy * warp + (rng() - 0.5) * spacingU * jitter;
      const p = new Pt(px, py);
      if (!insideSurfaceLite(p, boundary)) continue;
      out.push(p);
    }
  }
  return out;
}

// ---------------------------------------------------------------- PathGraph

/**
 * 中心线 → PathGraph。
 *
 * 与 F2.5 的 `buildGraph` 的关键差别：**保留折点**。
 * buildGraph 把每条边写成"两个节点之间的直线"（TopoEdge 只存端点），
 * 曲的流线因此被拉成弦；F3 的 D1 要修形、要贴弧线走，必须留全部采样点。
 *
 * 打断方式一致（全部线两两求交、在交点处插点），所以 T / X / Y 口都能成立。
 */
export function buildPathGraph(raws: RawRoad[], boundary: PlanSurface): PathGraph {
  const lines = raws.map((r) => r.pts.map((p) => new Pt(p.x, p.y)));
  /** 每条线上的切点参数（segIndex + t） */
  const params: number[][] = lines.map(() => []);

  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const A = lines[i];
      const B = lines[j];
      for (let a = 0; a + 1 < A.length; a++) {
        for (let b = 0; b + 1 < B.length; b++) {
          const hit = segIntersect(A[a], A[a + 1], B[b], B[b + 1]);
          if (!hit) continue;
          params[i].push(a + hit.ta);
          params[j].push(b + hit.tb);
        }
      }
    }
  }

  const nodes = new Map<string, PathNode>();
  const edges = new Map<string, PathEdge>();
  /**
   * 节点合并：**按距离**（哈希网格 + 42 cm 邻域），不用坐标取整。
   *
   * 取整分桶的坑：`round(x*200)` 是 3.5 cm 的桶，两个点差 0.007 mm，
   * 只要跨在桶边界上就会被判成两个节点，T 口就断了。
   * 按距离合并没有这个问题 —— 但**半径要小**：给到 42 cm 时，
   * 8 条弦的端点被吸成同一个点，边数从 208 掉到 155（也是错的）。
   * 12 cm 是实测最稳的一档：够吃掉布尔误差，又不会误合并。
   */
  const snapU = 0.017;
  const buckets = new Map<string, string[]>();
  const nodeAt = (p: Pt): PathNode => {
    const ix = Math.floor(p.x / snapU);
    const iy = Math.floor(p.y / snapU);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const id of buckets.get(`${ix + dx}_${iy + dy}`) ?? []) {
          const n = nodes.get(id)!;
          if (Pt.distance(n.at, p) <= snapU) return n;
        }
      }
    }
    const id = `n${nodes.size}_${Math.round(p.x * 1000)}`;
    const n: PathNode = { id, at: new Pt(p.x, p.y), degree: 0, onBoundary: false, edges: [] };
    nodes.set(id, n);
    const key = `${ix}_${iy}`;
    const list = buckets.get(key) ?? [];
    list.push(id);
    buckets.set(key, list);
    return n;
  };

  let seq = 0;
  lines.forEach((pts, li) => {
    const raw = raws[li];
    const cuts = [...new Set(params[li].map((t) => Math.round(t * 1e6) / 1e6))].sort((a, b) => a - b);
    const bounds = [0, ...cuts.filter((t) => t > 1e-4 && t < pts.length - 1 - 1e-4), pts.length - 1];
    const pieces: { a: Pt; b: Pt; mid: Pt[] }[] = [];
    for (let k = 0; k + 1 < bounds.length; k++) {
      const t0 = bounds[k];
      const t1 = bounds[k + 1];
      if (t1 - t0 < 1e-6) continue;
      const sub = subPolyline(pts, t0, t1);
      if (sub.length < 2) continue;
      pieces.push({ a: sub[0], b: sub[sub.length - 1], mid: sub.slice(1, -1) });
    }
    // 同一条线上的相邻碎段：中间点重复，去掉 2 m 以下的微段
    for (const pc of pieces) {
      const len = polyLen([pc.a, ...pc.mid, pc.b]);
      if (len * 7 < 2) continue;
      const na = nodeAt(pc.a);
      const nb = nodeAt(pc.b);
      if (na.id === nb.id) continue;
      const id = `e${seq++}`;
      edges.set(id, {
        id,
        a: na.id,
        b: nb.id,
        pts: [pc.a, ...pc.mid, pc.b].map((p) => new Pt(p.x, p.y)),
        cls: raw.cls,
        widthU: 1,
        from: raw.from,
      });
      na.edges.push(id);
      nb.edges.push(id);
    }
  });

  // 度 + 是否贴红线
  const rings = [boundary.outer, ...boundary.holes];
  for (const n of nodes.values()) {
    n.degree = new Set(n.edges).size;
    n.onBoundary = nearRings(n.at, boundariesOnly(boundary), U(2.2));
  }
  void rings;

  // 共线合并：把"被交点切出来的同一条街"接回一整条路径（不动节点位置）
  const paths = chainPaths(edges, nodes);
  const junctions = [...nodes.values()].filter((n) => n.degree >= 3).map((n) => n.id);

  return { nodes, edges, paths, junctions };
}

function boundariesOnly(s: PlanSurface): Pt[][] {
  return [s.outer, ...s.holes];
}

/** 从 t0 到 t1（段索引参数）取子折线，端点按插值生成 */
function subPolyline(pts: Pt[], t0: number, t1: number): Pt[] {
  const out: Pt[] = [];
  const at = (t: number): Pt => {
    const i = Math.floor(t);
    const f = t - i;
    if (i >= pts.length - 1) return new Pt(pts[pts.length - 1].x, pts[pts.length - 1].y);
    return new Pt(pts[i].x + (pts[i + 1].x - pts[i].x) * f, pts[i].y + (pts[i + 1].y - pts[i].y) * f);
  };
  out.push(at(t0));
  for (let i = Math.floor(t0) + 1; i <= Math.ceil(t1) - 1; i++) {
    if (i > 0 && i < pts.length) out.push(new Pt(pts[i].x, pts[i].y));
  }
  out.push(at(t1));
  return out;
}

interface SegHit {
  ta: number;
  tb: number;
}

function segIntersect(a: Pt, b: Pt, c: Pt, d: Pt): SegHit | null {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const sx = d.x - c.x;
  const sy = d.y - c.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null;
  const ta = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den;
  const tb = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den;
  if (ta < -1e-9 || ta > 1 + 1e-9 || tb < -1e-9 || tb > 1 + 1e-9) return null;
  return { ta: Math.max(0, Math.min(1, ta)), tb: Math.max(0, Math.min(1, tb)) };
}

/**
 * 度 2 节点穿成路径。
 *
 * 路径是"一条街"的视觉单位：路面按路径铺，路口按节点切，
 * 所以一条被 5 个路口切开的直街仍然是一整条铺装（转角不会被切成小方块）。
 */
/** 把边接回整条街。**导出给 graphclean**：图清理改了节点/边之后必须重建一次。 */
export function chainPaths(edges: Map<string, PathEdge>, nodes: Map<string, PathNode>): RoadPath[] {
  const used = new Set<string>();
  const out: RoadPath[] = [];
  const edgeList = [...edges.values()];

  const walk = (startEdge: PathEdge, startNode: string): { pts: Pt[]; edgeIds: string[]; nodeIds: string[] } => {
    const pts: Pt[] = [];
    const edgeIds: string[] = [];
    const nodeIds: string[] = [];
    let curEdge = startEdge;
    let curNode = startNode;
    nodeIds.push(curNode);
    for (let guard = 0; guard < 400; guard++) {
      used.add(curEdge.id);
      edgeIds.push(curEdge.id);
      const orient = curEdge.a === curNode ? curEdge.pts : curEdge.pts.slice().reverse();
      pts.push(...orient);
      const nextNodeId = curEdge.a === curNode ? curEdge.b : curEdge.a;
      nodeIds.push(nextNodeId);
      const next = nodes.get(nextNodeId);
      if (!next || next.degree !== 2) break;
      const other = next.edges.find((e) => e !== curEdge.id);
      if (!other || used.has(other)) break;
      const oe = edges.get(other);
      if (!oe) break;
      curEdge = oe;
      curNode = nextNodeId;
    }
    return { pts, edgeIds, nodeIds };
  };

  // 先从非度 2 节点出发的边开始（保证一条街从路口起头）
  for (const e of edgeList) {
    if (used.has(e.id)) continue;
    const a = nodes.get(e.a);
    const b = nodes.get(e.b);
    const start = a && a.degree !== 2 ? e.a : b && b.degree !== 2 ? e.b : e.a;
    const r = walk(e, start);
    const cls = r.edgeIds.reduce<RoadClass3>((acc, id) => {
      const c = edges.get(id)!.cls;
      const rank = { local: 0, collector: 1, arterial: 2 } as const;
      return rank[c] > rank[acc] ? c : acc;
    }, 'local');
    out.push({
      id: `p${out.length}`,
      pts: dedupe(r.pts),
      cls,
      widthU: Math.max(...r.edgeIds.map((id) => edges.get(id)!.widthU)),
      edgeIds: r.edgeIds,
      nodeIds: r.nodeIds,
    });
  }
  // 剩下的（纯环）随便起头
  for (const e of edgeList) {
    if (used.has(e.id)) continue;
    const r = walk(e, e.a);
    out.push({
      id: `p${out.length}`,
      pts: dedupe(r.pts),
      cls: edges.get(r.edgeIds[0])!.cls,
      widthU: Math.max(...r.edgeIds.map((id) => edges.get(id)!.widthU)),
      edgeIds: r.edgeIds,
      nodeIds: r.nodeIds,
    });
  }
  return out.filter((p) => p.pts.length >= 2 && polyLen(p.pts) * 7 > 8);
}

function dedupe(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Pt.distance(last, p) < 1e-6) continue;
    out.push(new Pt(p.x, p.y));
  }
  return out;
}

/** 供 roadgeom 使用：路径上取样（含端点），用于车道线与斑马线定位 */
export function pathSamples(path: RoadPath, stepM: number): { at: Pt; dir: Pt; s: number }[] {
  return sampleAlong(path.pts, U(stepM));
}

/** 主次比例（HUD / 报告用） */
export function classMix(raws: RawRoad[]): Record<RoadClass3, number> {
  const len: Record<RoadClass3, number> = { arterial: 0, collector: 0, local: 0 };
  for (const r of raws) len[r.cls] += polyLen(r.pts) * 7;
  const total = len.arterial + len.collector + len.local || 1;
  return {
    arterial: len.arterial / total,
    collector: len.collector / total,
    local: len.local / total,
  };
}
