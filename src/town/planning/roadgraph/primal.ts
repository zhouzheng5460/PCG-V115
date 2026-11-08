// F2.5-C.1 · 候选切线的**原始拓扑图**
//
// 为什么在 buildGraph 之前还要有一层：诊断要回答"断在哪、为什么断"，
// 就必须拿到"还没被剪短边 / 还没被合并共线 / 还没平滑"的那张图。
// 一旦进了 buildGraph，短边被剪、共线节点被并，断点就找不到原始出处了。
//
// 这一步做三件事，全部确定性：
//   ① 真交叉处打断（X 口）
//   ② T 口打断：一条线的端点落在另一条线上 —— 不打断就会长出"叠在一起的两条路"
//   ③ 端点吸附（网格哈希）：同一处 Voronoi 顶点在相邻 cell 的环里是两份坐标
//
// 不做的事：不剪短边、不合并共线、不平滑、不放大容差。

import { Pt } from '../../../core/geom';
import type { AccessKind, AccessPoint } from './access';

export interface CutGeom {
  id: string;
  pts: Pt[];
}

export interface TopoNode {
  id: string;
  at: Pt;
  /** 落在生成范围红线上（= 与外部空间的几何接口） */
  onBoundary: boolean;
  /** 最近的真实接入点（在 accessTolM 内才有） */
  accessId: string | null;
  accessKind: AccessKind | null;
}

export interface TopoEdge {
  id: string;
  cutId: string;
  a: string;
  b: string;
  lengthM: number;
}

export interface CutTopology {
  nodes: Map<string, TopoNode>;
  edges: Map<string, TopoEdge>;
  /** 节点 → 边 */
  adj: Map<string, string[]>;
  /** 切线 → 它的若干段（按路径顺序） */
  cutEdges: Map<string, string[]>;
  /** 切线 → 路径上的节点（按顺序） */
  cutNodes: Map<string, string[]>;
}

export interface TopoOpts {
  boundary?: Pt[][];
  access?: AccessPoint[];
  /** 端点吸附半径（米） */
  snapM?: number;
  /** 判定"在红线上"的容差（米） */
  boundaryTolM?: number;
  /** 判定"接进真实道路"的半径（米） */
  accessTolM?: number;
}

const EMPTY: CutTopology = {
  nodes: new Map(),
  edges: new Map(),
  adj: new Map(),
  cutEdges: new Map(),
  cutNodes: new Map(),
};

/**
 * 建原始拓扑。
 *
 * 注意 `snapM` 的默认值只有 1.2 m：**不允许**用放大容差的办法伪造连通。
 * 真实存在的 2~6 m 缺口会被 diagnose 单独列成"几何不相接"，而不是被吸掉。
 */
export function buildCutTopology(cuts: CutGeom[], opts: TopoOpts = {}): CutTopology {
  if (cuts.length === 0) return { ...EMPTY, nodes: new Map(), edges: new Map(), adj: new Map(), cutEdges: new Map(), cutNodes: new Map() };
  const snapU = (opts.snapM ?? 1.2) / 7;
  const bTolU = (opts.boundaryTolM ?? 2.5) / 7;
  const aTolU = (opts.accessTolM ?? 14) / 7;

  // ---------------- ①② 打断
  const pts: Pt[][] = cuts.map((c) => c.pts.map((p) => new Pt(p.x, p.y)));
  const inserts: { seg: number; t: number; p: Pt }[][] = cuts.map(() => []);

  const collect = (ci: number, at: Pt): void => {
    const line = pts[ci];
    for (let i = 0; i + 1 < line.length; i++) {
      const q = closestOnSeg(at, line[i], line[i + 1]);
      if (Pt.distance(q, at) > 1e-3) continue;
      const L = Pt.distance(line[i], line[i + 1]);
      if (L < 1e-9) continue;
      const t = Pt.distance(line[i], q) / L;
      if (t <= 1e-4 || t >= 1 - 1e-4) return; // 正好落在端点，不用插
      inserts[ci].push({ seg: i, t, p: q });
      return;
    }
  };

  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      if (!bboxOverlap(pts[i], pts[j])) continue;
      for (let a = 0; a + 1 < pts[i].length; a++) {
        for (let b = 0; b + 1 < pts[j].length; b++) {
          const hit = segTouch(pts[i][a], pts[i][a + 1], pts[j][b], pts[j][b + 1]);
          if (!hit) continue;
          collect(i, hit);
          collect(j, hit);
        }
      }
    }
  }

  for (let ci = 0; ci < pts.length; ci++) {
    if (inserts[ci].length === 0) continue;
    const bySeg = new Map<number, { t: number; p: Pt }[]>();
    for (const it of inserts[ci]) {
      if (!bySeg.has(it.seg)) bySeg.set(it.seg, []);
      bySeg.get(it.seg)!.push(it);
    }
    const out: Pt[] = [];
    for (let i = 0; i + 1 < pts[ci].length; i++) {
      out.push(pts[ci][i]);
      const list = (bySeg.get(i) ?? []).slice().sort((x, y) => x.t - y.t);
      for (const it of list) {
        const last = out[out.length - 1];
        if (Pt.distance(last, it.p) > 1e-4) out.push(it.p);
      }
    }
    out.push(pts[ci][pts[ci].length - 1]);
    pts[ci] = out;
  }

  // ---------------- ③ 吸附建节点
  const nodes = new Map<string, TopoNode>();
  const edges = new Map<string, TopoEdge>();
  const adj = new Map<string, string[]>();
  const cutEdges = new Map<string, string[]>();
  const cutNodes = new Map<string, string[]>();
  const grid = new Map<string, string[]>();
  const cell = Math.max(snapU, 1e-6);

  const nodeAt = (p: Pt): string => {
    const kx = Math.floor(p.x / cell);
    const ky = Math.floor(p.y / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const id of grid.get(`${kx + dx},${ky + dy}`) ?? []) {
          if (Pt.distance(nodes.get(id)!.at, p) <= snapU) return id;
        }
      }
    }
    const id = `tn${nodes.size}`;
    const onBoundary = opts.boundary ? distToRingsU(p, opts.boundary) <= bTolU : false;
    let accessId: string | null = null;
    let accessKind: AccessKind | null = null;
    let best = aTolU;
    for (const a of opts.access ?? []) {
      const d = Pt.distance(a.at, p);
      if (d <= best) {
        best = d;
        accessId = a.id;
        accessKind = a.kind;
      }
    }
    nodes.set(id, { id, at: new Pt(p.x, p.y), onBoundary, accessId, accessKind });
    const k = `${kx},${ky}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k)!.push(id);
    return id;
  };

  for (let ci = 0; ci < pts.length; ci++) {
    const ids = pts[ci].map((p) => nodeAt(p));
    cutNodes.set(cuts[ci].id, ids);
    const list: string[] = [];
    for (let i = 0; i + 1 < ids.length; i++) {
      if (ids[i] === ids[i + 1]) continue;
      const eid = `te${edges.size}`;
      edges.set(eid, { id: eid, cutId: cuts[ci].id, a: ids[i], b: ids[i + 1], lengthM: Pt.distance(nodes.get(ids[i])!.at, nodes.get(ids[i + 1])!.at) * 7 });
      list.push(eid);
      for (const nid of [ids[i], ids[i + 1]]) {
        if (!adj.has(nid)) adj.set(nid, []);
        adj.get(nid)!.push(eid);
      }
    }
    cutEdges.set(cuts[ci].id, list);
  }

  return { nodes, edges, adj, cutEdges, cutNodes };
}

// ---------------------------------------------------------------- 连通分量

export interface TopoComponent {
  id: string;
  nodes: string[];
  edges: string[];
  lengthM: number;
  onBoundary: boolean;
  hasAccess: boolean;
  accessKinds: AccessKind[];
  accessIds: string[];
}

/** 按当前**保留**的切线算连通分量（kept 为 null 表示全留） */
export function componentsOf(topo: CutTopology, keptCuts?: Set<string> | null): TopoComponent[] {
  const seen = new Set<string>();
  const out: TopoComponent[] = [];
  const edgeOf = (eid: string) => topo.edges.get(eid)!;
  const alive = (eid: string): boolean => !keptCuts || keptCuts.has(edgeOf(eid).cutId);

  for (const nid of topo.nodes.keys()) {
    if (seen.has(nid)) continue;
    const stack = [nid];
    seen.add(nid);
    const ns: string[] = [];
    const es: string[] = [];
    const kinds = new Set<AccessKind>();
    const aids = new Set<string>();
    let onB = false;
    while (stack.length) {
      const cur = stack.pop()!;
      ns.push(cur);
      const n = topo.nodes.get(cur)!;
      if (n.onBoundary) onB = true;
      if (n.accessKind) kinds.add(n.accessKind);
      if (n.accessId) aids.add(n.accessId);
      for (const eid of topo.adj.get(cur) ?? []) {
        if (!alive(eid)) continue;
        const e = edgeOf(eid);
        if (!es.includes(eid)) es.push(eid);
        const other = e.a === cur ? e.b : e.a;
        if (seen.has(other)) continue;
        seen.add(other);
        stack.push(other);
      }
    }
    // 只由孤立节点组成的分量（没有任何边）不参与计数
    if (es.length === 0) continue;
    let len = 0;
    for (const eid of es) len += edgeOf(eid).lengthM;
    out.push({
      id: `cp${out.length}`,
      nodes: ns,
      edges: es,
      lengthM: +len.toFixed(1),
      onBoundary: onB,
      hasAccess: aids.size > 0,
      accessKinds: [...kinds],
      accessIds: [...aids],
    });
  }
  return out.sort((a, b) => b.lengthM - a.lengthM);
}

/** 分量是否是"一个闭环"（每个节点度 2、边数 = 节点数） */
export function isClosedLoop(topo: CutTopology, c: TopoComponent): boolean {
  if (c.nodes.length < 3) return false;
  if (c.edges.length !== c.nodes.length) return false;
  for (const nid of c.nodes) {
    const deg = (topo.adj.get(nid) ?? []).filter((eid) => c.edges.includes(eid)).length;
    if (deg !== 2) return false;
  }
  return true;
}

/**
 * 把一条**已经被删掉**的切线加回去，能不能把两个分量接起来。
 *
 * 用来回答"被 Merge 删除的关键 Cell 边"：不是所有被删的边都关键，
 * 只有那些加回后能减少分量数（接回外部接入）的才算。
 */
export function reconnectGain(topo: CutTopology, kept: Set<string>, cutId: string): { joins: boolean; sides: [string, string] | null } {
  const segs = topo.cutEdges.get(cutId) ?? [];
  const endpoints = segs.length
    ? [topo.edges.get(segs[0])!.a, topo.edges.get(segs[segs.length - 1])!.b]
    : (topo.cutNodes.get(cutId) ?? []);
  if (endpoints.length < 2) return { joins: false, sides: null };
  const comps = componentsOf(topo, kept);
  const compOf = new Map<string, number>();
  comps.forEach((c, i) => c.nodes.forEach((n) => compOf.set(n, i)));
  const a = compOf.get(endpoints[0]);
  const b = compOf.get(endpoints[1]);
  if (a === undefined || b === undefined) return { joins: false, sides: null };
  return { joins: a !== b, sides: [comps[a].id, comps[b].id] };
}

// ---------------------------------------------------------------- 小工具

export function closestOnSeg(p: Pt, a: Pt, b: Pt): Pt {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-12) return new Pt(a.x, a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return new Pt(a.x + dx * t, a.y + dy * t);
}

export function distToRingsU(p: Pt, rings: Pt[][]): number {
  let best = Infinity;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const q = closestOnSeg(p, ring[i], ring[(i + 1) % ring.length]);
      const d = Pt.distance(p, q);
      if (d < best) best = d;
    }
  }
  return best;
}

function bboxOverlap(A: Pt[], B: Pt[]): boolean {
  let aminX = Infinity;
  let aminY = Infinity;
  let amaxX = -Infinity;
  let amaxY = -Infinity;
  for (const p of A) {
    aminX = Math.min(aminX, p.x);
    aminY = Math.min(aminY, p.y);
    amaxX = Math.max(amaxX, p.x);
    amaxY = Math.max(amaxY, p.y);
  }
  let bminX = Infinity;
  let bminY = Infinity;
  let bmaxX = -Infinity;
  let bmaxY = -Infinity;
  for (const p of B) {
    bminX = Math.min(bminX, p.x);
    bminY = Math.min(bminY, p.y);
    bmaxX = Math.max(bmaxX, p.x);
    bmaxY = Math.max(bmaxY, p.y);
  }
  return aminX <= bmaxX && bminX <= amaxX && aminY <= bmaxY && bminY <= amaxY;
}

/** 两段的关系点：真交叉、或一端落在另一段上（T 口） */
function segTouch(a1: Pt, a2: Pt, b1: Pt, b2: Pt): Pt | null {
  const d1x = a2.x - a1.x;
  const d1y = a2.y - a1.y;
  const d2x = b2.x - b1.x;
  const d2y = b2.y - b1.y;
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) > 1e-12) {
    const t = ((b1.x - a1.x) * d2y - (b1.y - a1.y) * d2x) / den;
    const u = ((b1.x - a1.x) * d1y - (b1.y - a1.y) * d1x) / den;
    if (t > -1e-6 && t < 1 + 1e-6 && u > -1e-6 && u < 1 + 1e-6) {
      return new Pt(a1.x + d1x * t, a1.y + d1y * t);
    }
  }
  for (const [p, s1, s2] of [
    [a1, b1, b2],
    [a2, b1, b2],
    [b1, a1, a2],
    [b2, a1, a2],
  ] as [Pt, Pt, Pt][]) {
    const q = closestOnSeg(p, s1, s2);
    if (Pt.distance(p, q) < 0.02) return q;
  }
  return null;
}
