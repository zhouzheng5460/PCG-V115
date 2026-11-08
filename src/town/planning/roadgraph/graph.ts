// F2.5-B · 切割线 → 干净的中心线图
//
// 输入的切割线来自 fracture（Voronoi 共享边、OBB 切线…），它们本身**不是**路：
// 会互相穿越、端点对不上、长短悬殊、方向重复。
//
// 这一层只做"把几何收拾干净"，四件事：
//   ① 相交打断 + T 口打断（交给 primal.buildCutTopology，与诊断共用同一张原始图）
//   ② 节点吸附：端点/顶点距离 < snap 的合并成同一个节点（T 字口靠它成立）
//   ③ 清理：过短的边剪掉、度 2 且近似共线的节点合并（把折线碎段并成一条边）
//   ④ 平滑：Chaikin 只动中间点，**两个端点（节点）位置不动** ——
//      平滑改变几何表现，不改变拓扑
//
// F2.5-C.1 的变化：
//   · 打断逻辑与 `primal.ts` 合并，诊断看到的图和最终图**是同一张**；
//   · 补上 T 口打断 —— 上一轮一条线的端点落在另一条线上时不打断，
//     结果长出"叠在一起的两条路"，长度与面积都被算重；
//   · 记录被剪掉的短边（诊断里要区分"剪短边剪断了"和"本来就没接上"）。

import { Pt } from '../../../core/geom';
import { buildCutTopology, type CutTopology } from './primal';
import {
  CLASS_RANK,
  emptyGraph,
  reindex,
  type EdgeSource,
  type RoadClass,
  type RoadEdge,
  type RoadGraph,
  type RoadNode,
} from './types';

/** 一条切割线（可能已经有折点） */
export interface CutLine {
  /** 保留原始 id：出图与诊断要能追溯回 fracture 的 Cut */
  id?: string;
  pts: Pt[];
  cls: RoadClass;
  widthM: number;
  source: EdgeSource;
}

export interface BuildOpts {
  /** 节点吸附半径（米） */
  snapM?: number;
  /** 边的最短长度（米）：短于它的剪掉 */
  minEdgeM?: number;
  /** 度 2 节点合并的共线阈值（度）：转角小于它就算"同一条路" */
  mergeAngleDeg?: number;
  /** 平滑迭代次数（0 = 不平滑） */
  smooth?: number;
  /** 生成范围：用来标记 boundary 节点 */
  boundary?: Pt[][];
  /** 判定"在边界上"的容差（米） */
  boundaryTolM?: number;
}

export function buildGraph(cuts: CutLine[], opts: BuildOpts = {}): RoadGraph {
  const minEdge = (opts.minEdgeM ?? 8) / 7;
  const mergeAng = ((opts.mergeAngleDeg ?? 25) * Math.PI) / 180;
  const smooth = opts.smooth ?? 2;
  const bTol = (opts.boundaryTolM ?? 2) / 7;

  const g = emptyGraph();
  g.boundary = opts.boundary;
  g.diagnostics = { prunedEdges: 0, prunedLengthM: 0, droppedCuts: [] };

  const lines: Required<CutLine>[] = cuts.map((c, i) => ({
    id: c.id ?? `k${i}`,
    pts: c.pts.map((p) => new Pt(p.x, p.y)),
    cls: c.cls,
    widthM: c.widthM,
    source: c.source,
  }));

  // ---------------- ①② 打断 + 吸附（与诊断共用）
  const topo: CutTopology = buildCutTopology(
    lines.map((l) => ({ id: l.id, pts: l.pts })),
    { boundary: opts.boundary, snapM: opts.snapM ?? 1.5, boundaryTolM: opts.boundaryTolM ?? 2 }
  );

  const lineOf = new Map(lines.map((l) => [l.id, l]));
  for (const n of topo.nodes.values()) {
    const node: RoadNode = { id: n.id, position: n.at, connectedEdges: [], nodeType: n.onBoundary ? 'boundary' : 'terminal' };
    g.nodes.set(n.id, node);
    if (n.onBoundary) g.boundaryConnections.push(n.id);
  }
  for (const e of topo.edges.values()) {
    const l = lineOf.get(e.cutId);
    if (!l) continue;
    addEdge(g, e.a, e.b, [topo.nodes.get(e.a)!.at, topo.nodes.get(e.b)!.at], l.cls, l.widthM, l.source, e.cutId);
  }
  reindex(g);

  // ---------------- ③ 剪短边（不与边界相连的）
  pruneShort(g, minEdge, bTol);

  // ---------------- ④ 合并度 2 共线节点（把碎段并成一条边）
  mergeCollinear(g, mergeAng);

  // ---------------- ⑤ 平滑（端点不动）
  if (smooth > 0) for (const e of g.edges.values()) e.centerline = chaikin(e.centerline, smooth);

  // ---------------- ⑥ 标边界节点
  markBoundary(g, bTol);
  reindex(g);
  return g;
}

function addEdge(
  g: RoadGraph,
  from: string,
  to: string,
  centerline: Pt[],
  cls: RoadClass,
  widthM: number,
  source: EdgeSource,
  cutId?: string
): void {
  if (from === to) return;
  // 同一对节点之间不留重复边（重叠的候选切线很常见）
  for (const eid of g.adjacency.get(from) ?? g.nodes.get(from)?.connectedEdges ?? []) {
    const e = g.edges.get(eid);
    if (!e) continue;
    if ((e.from === from && e.to === to) || (e.from === to && e.to === from)) {
      const better = CLASS_RANK[cls] > CLASS_RANK[e.roadClass] || (CLASS_RANK[cls] === CLASS_RANK[e.roadClass] && widthM > e.widthM);
      if (better) {
        e.roadClass = cls;
        e.widthM = Math.max(e.widthM, widthM);
      }
      return;
    }
  }
  const id = `e${g.edges.size}`;
  g.edges.set(id, { id, from, to, centerline, roadClass: cls, widthM, source, cutId });
  g.nodes.get(from)?.connectedEdges.push(id);
  g.nodes.get(to)?.connectedEdges.push(id);
  if (!g.adjacency.has(from)) g.adjacency.set(from, []);
  if (!g.adjacency.has(to)) g.adjacency.set(to, []);
  g.adjacency.get(from)!.push(id);
  g.adjacency.get(to)!.push(id);
}

/**
 * 剪掉过短的边：两端都保留时把它们并成一个节点（等于抹掉这条边）。
 *
 * 边界上的入口不剪 —— 那是与外部路网的接口。
 */
function pruneShort(g: RoadGraph, minEdge: number, bTol: number): void {
  for (let guard = 0; guard < 8; guard++) {
    let changed = false;
    for (const [eid, e] of [...g.edges]) {
      const len = polyLen(e.centerline);
      if (len >= minEdge) continue;
      const a = g.nodes.get(e.from);
      const b = g.nodes.get(e.to);
      if (!a || !b) continue;
      if (onBoundary(a.position, g.boundary, bTol) || onBoundary(b.position, g.boundary, bTol)) continue;
      // 合并两端：把 b 的所有边改挂到 a
      for (const other of [...g.edges.values()]) {
        if (other.id === eid) continue;
        if (other.from === b.id) other.from = a.id;
        if (other.to === b.id) other.to = a.id;
      }
      g.nodes.delete(b.id);
      g.edges.delete(eid);
      if (g.diagnostics) {
        g.diagnostics.prunedEdges++;
        g.diagnostics.prunedLengthM += +len.toFixed(2);
        if (e.cutId) g.diagnostics.droppedCuts.push(e.cutId);
      }
      changed = true;
    }
    // 自环
    for (const [eid, e] of [...g.edges]) if (e.from === e.to) g.edges.delete(eid);
    dedupeEdges(g);
    reindex(g);
    if (!changed) break;
  }
  // 删掉孤立节点
  for (const [id, n] of [...g.nodes]) if (n.connectedEdges.length === 0) g.nodes.delete(id);
  reindex(g);
}

/**
 * 合并度 2 且近似共线的节点，把"一条街被切成的碎段"还原成一条边。
 *
 * 这里踩过一个**静默错误**，值得留档：
 * 旧实现的 `dirAt(e, node)` 对"结束于该节点的边"返回的是**沿边前进**的方向，
 * 而判据写的是 `cos(d1, -d2)` —— 对一条直街（两条边的前进方向相同）会算出
 * 180°，于是 `ang > angTol` 永远成立，合并从来没有发生过。
 * 表现就是 A 方案（张量场流线，采样点间隔 11 m）建出 51 条 11 m 的碎段；
 * 而 C.1 的 Voronoi 图折点少，没人注意到。
 *
 * 现在统一成"**从节点出发**的方向"：两条边共线 ⇔ 两个出向相反 ⇔ dot ≈ -1。
 */
function mergeCollinear(g: RoadGraph, angTol: number): void {
  /** 把一条边写成"从该节点出发"的有序点列 */
  const pathFrom = (e: RoadEdge, nid: string): Pt[] | null => {
    const pts = e.centerline;
    if (pts.length < 2) return null;
    if (e.from === nid) return pts.map((p) => new Pt(p.x, p.y));
    if (e.to === nid) return pts.slice().reverse().map((p) => new Pt(p.x, p.y));
    return null;
  };
  let mergeSeq = 0;
  const unit = (a: Pt, b: Pt): Pt => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l = Math.hypot(dx, dy) || 1;
    return new Pt(dx / l, dy / l);
  };

  // 每轮只合并一个节点（合并后要 reindex，所以内层 break）。
  // 上限按节点数给足 —— 写死 8 的时候一条 50 点的流线只能被并掉 8 个折点。
  for (let guard = 0; guard < 4 + g.nodes.size * 2; guard++) {
    let changed = false;
    for (const n of [...g.nodes.values()]) {
      const list = g.adjacency.get(n.id) ?? n.connectedEdges;
      if (list.length !== 2) continue;
      const e1 = g.edges.get(list[0]);
      const e2 = g.edges.get(list[1]);
      if (!e1 || !e2) continue;
      const p1 = pathFrom(e1, n.id);
      const p2 = pathFrom(e2, n.id);
      if (!p1 || !p2) continue;
      const d1 = unit(p1[0], p1[1]);
      const d2 = unit(p2[0], p2[1]);
      const dot = d1.x * d2.x + d1.y * d2.y;
      const ang = Math.acos(Math.max(-1, Math.min(1, -dot)));
      if (ang > angTol) continue;
      const fromA = e1.from === n.id ? e1.to : e1.from;
      const toB = e2.from === n.id ? e2.to : e2.from;
      if (fromA === toB) continue;
      // A → n → B
      const path = [...p1.slice().reverse(), ...p2.slice(1)];
      const cls = CLASS_RANK[e1.roadClass] >= CLASS_RANK[e2.roadClass] ? e1.roadClass : e2.roadClass;
      g.edges.delete(e1.id);
      g.edges.delete(e2.id);
      g.nodes.delete(n.id);
      /**
       * 这里必须**直接插入**，不能走 `addEdge`：
       * addEdge 有一条"同一对节点之间不留重复边"的去重规则（原本是给
       * fracture 的重叠切线用的）。合并出来的边如果和已有边落在同一对节点上
       * （两条平行的街、或者环路），去重会把它丢掉 —— 而它的两条母边已经删了，
       * 于是整条街凭空消失，图碎成好几段（F01 上实测 1 个分量裂成 5 个）。
       */
      const id = `em${mergeSeq++}`;
      g.edges.set(id, { id, from: fromA, to: toB, centerline: path, roadClass: cls, widthM: Math.max(e1.widthM, e2.widthM), source: e1.source, cutId: e1.cutId ?? e2.cutId });
      g.nodes.get(fromA)?.connectedEdges.push(id);
      g.nodes.get(toB)?.connectedEdges.push(id);
      changed = true;
      reindex(g);
      break;
    }
    if (!changed) break;
  }
  reindex(g);
}

/** 同一对节点之间只留一条边（合并共线 / 剪短边之后可能产生平行边） */
function dedupeEdges(g: RoadGraph): void {
  const seen = new Set<string>();
  const drop: string[] = [];
  for (const e of g.edges.values()) {
    const key = e.from < e.to ? e.from + '|' + e.to : e.to + '|' + e.from;
    if (seen.has(key)) {
      drop.push(e.id);
      continue;
    }
    seen.add(key);
  }
  for (const id of drop) g.edges.delete(id);
}

/** Chaikin 平滑：端点保持原位 */
function chaikin(pts: Pt[], iter: number): Pt[] {
  if (pts.length < 3) return pts;
  let cur = pts.slice();
  for (let k = 0; k < iter; k++) {
    const out: Pt[] = [cur[0]];
    for (let i = 0; i + 1 < cur.length; i++) {
      const a = cur[i];
      const b = cur[i + 1];
      out.push(new Pt(a.x * 0.75 + b.x * 0.25, a.y * 0.75 + b.y * 0.25));
      out.push(new Pt(a.x * 0.25 + b.x * 0.75, a.y * 0.25 + b.y * 0.75));
    }
    out.push(cur[cur.length - 1]);
    cur = out;
  }
  return cur;
}

function markBoundary(g: RoadGraph, tol: number): void {
  g.boundaryConnections = [];
  for (const n of g.nodes.values()) {
    if (onBoundary(n.position, g.boundary, tol)) {
      n.nodeType = 'boundary';
      g.boundaryConnections.push(n.id);
    }
  }
}

// ---------------------------------------------------------------- 几何小工具

export function polyLen(pts: Pt[]): number {
  let t = 0;
  for (let i = 0; i + 1 < pts.length; i++) t += Pt.distance(pts[i], pts[i + 1]);
  return t;
}

/** 边在某个节点处的离向单位向量 */
function dirAt(e: RoadEdge, nodeId: string): Pt | null {
  const pts = e.centerline;
  if (pts.length < 2) return null;
  if (e.from === nodeId) {
    const d = new Pt(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
    const l = Math.hypot(d.x, d.y) || 1;
    return new Pt(d.x / l, d.y / l);
  }
  if (e.to === nodeId) {
    const n = pts.length;
    const d = new Pt(pts[n - 1].x - pts[n - 2].x, pts[n - 1].y - pts[n - 2].y);
    const l = Math.hypot(d.x, d.y) || 1;
    return new Pt(d.x / l, d.y / l);
  }
  return null;
}

/** 线段真交叉（不含端点重合），返回交点 */
export function segIntersect(a1: Pt, a2: Pt, b1: Pt, b2: Pt): Pt | null {
  const d1x = a2.x - a1.x;
  const d1y = a2.y - a1.y;
  const d2x = b2.x - b1.x;
  const d2y = b2.y - b1.y;
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((b1.x - a1.x) * d2y - (b1.y - a1.y) * d2x) / den;
  const u = ((b1.x - a1.x) * d1y - (b1.y - a1.y) * d1x) / den;
  const eps = 1e-6;
  if (t < -eps || t > 1 + eps || u < -eps || u > 1 + eps) return null;
  return new Pt(a1.x + d1x * t, a1.y + d1y * t);
}

function onBoundary(p: Pt, boundary: Pt[][] | undefined, tol: number): boolean {
  if (!boundary) return false;
  for (const ring of boundary) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l2 = dx * dx + dy * dy;
      if (l2 < 1e-12) continue;
      let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
      t = Math.max(0, Math.min(1, t));
      if (Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)) <= tol) return true;
    }
  }
  return false;
}
