// F2.5-C.1 · Connectivity Backbone（连通骨架）
//
// 位置很关键：**在 Region Merge 之前**。上一轮是"先无条件合并、再看剩下什么"，
// 于是合并可能把唯一的连接边删掉，最后得到几个互不相连的路段或一个绕洞的孤立环路。
//
// 这一轮倒过来：
//   ① 用**服务覆盖**找路：场地内任一点到最近道路/外部临街的距离 ≤ 服务半径，
//      覆盖率不够就先服务最差的那一片
//   ② 每补一条路，都从最深的 cell 起挑一条"每米能多覆盖多少面积"最高的共享边
//      （不新造几何，只用 fracture 已有的边）
//   ③ 选边时优先"已经搭在骨架上"的边 —— 新路是支路，整张网仍然连通；
//      否则贪心会挑两条互不相接的最短边，图上就是两段并排的断头路
//   ④ 骨架必须能沿真实边走到外部 —— 走不到就沿原始拓扑找最短链接补上
//   ⑤ 骨架边在合并阶段标记 protected，永不删除
//
// 一条都选不出来也是合法结果（窄条带、小地块的所有 Compound 都能直接临街），
// 但必须给出理由，不能把"生成失败"说成"不需要内部路"。

import { Pt } from '../../../core/geom';
import { bboxOf, type PlanSurface } from '../core/surface';
import type { Cell, Cut } from './fracture';
import { insideRing } from './fracture';
import { buildCutTopology, closestOnSeg, componentsOf, type CutTopology, type TopoComponent } from './primal';
import type { AccessPoint } from './access';
import type { DensityPolicy } from './density';

export interface BackboneInput {
  boundary: PlanSurface;
  cells: Cell[];
  cuts: Cut[];
  access: AccessPoint[];
  policy: DensityPolicy;
  /** 覆盖网格间距（米）：越小越准，越慢 */
  sampleStepM?: number;
  /** 允许的未覆盖面积占比（默认 3%） */
  uncoverTol?: number;
}

export type BackboneRole = 'spine' | 'branch' | 'accessLink';

export interface BackboneEdge {
  cutId: string;
  role: BackboneRole;
  why: string;
  lengthM: number;
}

export interface CellCoverage {
  cellId: string;
  /** 到最近"道路或外部临街"的距离（米） */
  beforeM: number;
  afterM: number;
}

export interface Backbone {
  policy: DensityPolicy;
  topo: CutTopology;
  /** 受保护边 → 理由 */
  protectedCuts: Map<string, BackboneEdge>;
  /** 覆盖情况（骨架前后，按 cell 统计最大服务距离） */
  coverage: CellCoverage[];
  /** 每轮补线的记录 */
  steps: { cutId: string; worstCell: string; beforeM: number; afterM: number; role: BackboneRole; gainM2: number }[];
  /** 仍然超出服务半径的 cell */
  uncovered: string[];
  /** 骨架各分量是否有外部出口 */
  components: { nodes: number; lengthM: number; accessLinked: boolean }[];
  /** 覆盖面积占比（0~1） */
  coverageRatio: number;
  notes: string[];
  noRoadReason: string | null;
  /** 骨架补完后，全场地最大服务距离（米） */
  worstServiceM: number;
}

export function buildBackbone(inp: BackboneInput): Backbone {
  const { cells, cuts, policy } = inp;
  const step = (inp.sampleStepM ?? 4) / 7;
  const tol = inp.uncoverTol ?? 0.03;
  const R = policy.serviceRadiusM;
  const notes: string[] = [];

  const cutById = new Map(cuts.map((c) => [c.id, c]));
  const cellCuts = new Map<string, string[]>();
  for (const k of cuts) {
    for (const cid of [k.left, k.right]) {
      if (!cellCuts.has(cid)) cellCuts.set(cid, []);
      cellCuts.get(cid)!.push(k.id);
    }
  }

  // 覆盖网格：整个生成范围（洞里不采样 —— 洞不是可服务的地面）
  const grid = gridOf(inp.boundary, step);
  const rails: Pt[][] = [inp.boundary.outer];
  const served = grid.map((p) => maxDistM(p, rails) <= R);
  const ratioOf = (): number => (grid.length ? served.filter(Boolean).length / grid.length : 1);

  const cellSamples = cells.map((c) => samplesOf(c, step * 2));
  const cellWorst = (i: number): number => {
    let m = 0;
    for (const p of cellSamples[i]) m = Math.max(m, maxDistM(p, rails));
    return m;
  };
  const beforeM = cells.map((_, i) => cellWorst(i));

  const protectedCuts = new Map<string, BackboneEdge>();
  const steps: Backbone['steps'] = [];
  const protEnds = new Set<string>();
  const roundKey = (p: Pt): string => `${Math.round(p.x * 2)},${Math.round(p.y * 2)}`;
  const onBoundaryCut = (k: Cut): boolean => {
    const d = (p: Pt): number => {
      let best = Infinity;
      const ring = inp.boundary.outer;
      for (let i = 0; i < ring.length; i++) {
        const q = closestOnSeg(p, ring[i], ring[(i + 1) % ring.length]);
        best = Math.min(best, Pt.distance(p, q));
      }
      return best;
    };
    return d(k.a) <= 2.5 / 7 || d(k.b) <= 2.5 / 7;
  };

  const skipped = new Set<string>();
  const px2 = (step * 7) * (step * 7);

  for (let iter = 0; iter < 24; iter++) {
    if (ratioOf() >= 1 - tol) break;
    // 最差的 cell：用"到最近道路的最大距离"排序（比覆盖率更好解释）
    let worst = -1;
    let worstD = R;
    for (let i = 0; i < cells.length; i++) {
      if (skipped.has(cells[i].id)) continue;
      const d = cellWorst(i);
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst < 0) break;
    const cell = cells[worst];

    let best: { cid: string; gain: number; score: number } | null = null;
    for (const cid of cellCuts.get(cell.id) ?? []) {
      if (protectedCuts.has(cid)) continue;
      const k = cutById.get(cid);
      if (!k || k.lenM < policy.minRoadableSpanM) continue;
      // 每米能多覆盖多少面积 —— 不是"最大距离降多少"（单边补路救不了远角）
      let hit = 0;
      for (let i = 0; i < grid.length; i++) {
        if (served[i]) continue;
        if (maxDistM(grid[i], [[k.a, k.b]]) <= R) hit++;
      }
      if (hit === 0) continue;
      const gainM2 = hit * px2;
      const onSpine = protEnds.has(roundKey(k.a)) || protEnds.has(roundKey(k.b));
      const bonus = (onSpine ? 1.7 : 1) * (onBoundaryCut(k) ? 1.3 : 1);
      const score = (gainM2 / Math.max(1, k.lenM)) * bonus;
      if (!best || score > best.score + 1e-9) best = { cid, gain: gainM2, score };
    }

    if (!best) {
      skipped.add(cell.id);
      notes.push(`cell ${cell.id} 距最近道路 ${worstD.toFixed(0)} m 超限，但没有可用的共享边（已保护或短于 ${policy.minRoadableSpanM} m），跳过`);
      continue;
    }

    const k = cutById.get(best.cid)!;
    protectedCuts.set(k.id, {
      cutId: k.id,
      role: 'spine',
      why: `cell ${cell.id} 服务距离 ${worstD.toFixed(0)} m > ${R.toFixed(0)} m；这条 ${k.lenM.toFixed(0)} m 共享边能多覆盖 ${best.gain.toFixed(0)} m²`,
      lengthM: k.lenM,
    });
    const after = cellWorst(worst);
    steps.push({ cutId: k.id, worstCell: cell.id, beforeM: +worstD.toFixed(1), afterM: +after.toFixed(1), role: 'spine', gainM2: +best.gain.toFixed(0) });
    rails.push([k.a, k.b]);
    protEnds.add(roundKey(k.a));
    protEnds.add(roundKey(k.b));
    for (let i = 0; i < grid.length; i++) if (!served[i] && maxDistM(grid[i], [[k.a, k.b]]) <= R) served[i] = true;
  }

  // ---------------- ② 骨架必须走到外部
  const topoAll = buildCutTopology(
    cuts.map((k) => ({ id: k.id, pts: [k.a, k.b] })),
    { boundary: [inp.boundary.outer, ...inp.boundary.holes], access: inp.access }
  );
  const prot = new Set(protectedCuts.keys());
  const protComps = componentsOf(topoAll, prot);
  for (const comp of protComps) {
    if (comp.onBoundary || comp.hasAccess) continue;
    const chain = shortestChainToAccess(topoAll, comp, prot);
    if (!chain) {
      notes.push(`骨架分量（${comp.edges.length} 段 / ${comp.lengthM.toFixed(0)} m）找不到通往外部的最短链，保留原样并在诊断里标为孤立`);
      continue;
    }
    for (const cid of chain.cutIds) {
      if (protectedCuts.has(cid)) continue;
      const k = cutById.get(cid);
      if (!k) continue;
      protectedCuts.set(cid, {
        cutId: cid,
        role: 'accessLink',
        why: `骨架分量无外部出口 → 沿 ${chain.lengthM.toFixed(0)} m 最短链接到 ${chain.via}`,
        lengthM: k.lenM,
      });
      steps.push({ cutId: cid, worstCell: '—', beforeM: 0, afterM: 0, role: 'accessLink', gainM2: 0 });
    }
  }

  // ---------------- ③ 结论
  const distAfter = cells.map((_, i) => cellWorst(i));
  const uncovered = cells.filter((_, i) => distAfter[i] > R + 0.5).map((c) => c.id);
  const worstAfter = distAfter.length ? Math.max(...distAfter) : 0;
  const coverageRatio = ratioOf();

  if (protectedCuts.size === 0 && coverageRatio >= 1 - tol) {
    notes.push(
      `明确判断：不需要内部道路。服务覆盖率 ${(coverageRatio * 100).toFixed(0)}%，` +
        `最大服务距离 ${worstAfter.toFixed(0)} m ≤ 服务半径 ${R.toFixed(0)} m，每个 Compound 都能直接临街接入（不是生成失败）`
    );
  } else if (coverageRatio < 1 - tol) {
    notes.push(
      `服务覆盖率 ${(coverageRatio * 100).toFixed(0)}%（容差 ${(tol * 100).toFixed(0)}%）：` +
        `仍有 ${uncovered.length} 个 cell 超出半径，最大 ${worstAfter.toFixed(0)} m > ${R.toFixed(0)} m；可用共享边不够，未强行补路`
    );
  }

  const comps = componentsOf(topoAll, prot).map((c) => ({
    nodes: c.nodes.length,
    lengthM: c.lengthM,
    accessLinked: c.onBoundary || c.hasAccess,
  }));

  return {
    policy,
    topo: topoAll,
    protectedCuts,
    coverage: cells.map((c, i) => ({ cellId: c.id, beforeM: +beforeM[i].toFixed(1), afterM: +distAfter[i].toFixed(1) })),
    steps,
    uncovered,
    components: comps,
    coverageRatio: +coverageRatio.toFixed(3),
    notes,
    noRoadReason: protectedCuts.size === 0 ? notes[notes.length - 1] ?? null : null,
    worstServiceM: +worstAfter.toFixed(1),
  };
}

// ---------------------------------------------------------------- 连通守卫

export interface GuardVerdict {
  ok: boolean;
  why: string;
}

export interface ConnectivityGuard {
  /** 删掉这条边，会不会多出一个"接不到外部"的分量 */
  canRemove(cutId: string): GuardVerdict;
  /** 确认已删除 */
  noteRemoved(cutId: string): void;
  /** 当前保留集合 */
  kept(): Set<string>;
}

/**
 * 合并阶段的连通守卫。
 *
 * 判据只有一条，但必须精确：**孤立分量的数量不能增加**。
 * 路段彼此断开本身不算错（两个方向的横路各自接在外部街道上，是合法的），
 * 错的是"断开之后有一半再也接不到外部"。这条判据恰好区分了这两件事，
 * 而且不需要放大任何端点容差。
 */
export function makeConnectivityGuard(
  topo: CutTopology,
  allCutIds: string[],
  protectedCuts: Set<string>,
  opts: { minFragmentShare?: number } = {}
): ConnectivityGuard {
  const kept = new Set(allCutIds);
  const share = opts.minFragmentShare ?? 0.3;

  const compsOf = (set: Set<string>) => componentsOf(topo, set);
  const isolCount = (set: Set<string>): number => compsOf(set).filter((c) => !c.onBoundary && !c.hasAccess).length;
  const totalLen = (set: Set<string>): number => compsOf(set).reduce((s, c) => s + c.lengthM, 0);
  const protCompCount = (set: Set<string>): number => {
    let n = 0;
    for (const c of compsOf(set)) {
      if (c.edges.some((eid) => protectedCuts.has(topo.edges.get(eid)?.cutId ?? ''))) n++;
    }
    return n;
  };
  /**
   * 骨架原本可能就是几片（例如两条互不相接的横路 —— 它们各自接在外部街道上，
   * 是合法的）。所以判据是"**不能把骨架切得更碎**"，不是"骨架必须只有一片"；
   * 否则在那种场地上任何一次合并都会被挡下（F04 上实测 9 次全被挡）。
   */
  let protComps = protCompCount(kept);

  /** 删掉 cutId 之后，它所在的分量会不会断成两段；断了两段的长度分别是多少 */
  const splitLens = (cutId: string): [number, number] | null => {
    const segs = topo.cutEdges.get(cutId) ?? [];
    if (segs.length === 0) return null;
    const ends: [string, string] = [topo.edges.get(segs[0])!.a, topo.edges.get(segs[segs.length - 1])!.b];
    const bfs = (from: string): Map<string, number> => {
      const seen = new Map<string, number>();
      const stack = [from];
      seen.set(from, 0);
      while (stack.length) {
        const cur = stack.pop()!;
        for (const eid of topo.adj.get(cur) ?? []) {
          const e = topo.edges.get(eid)!;
          if (e.cutId === cutId || !kept.has(e.cutId)) continue;
          const other = e.a === cur ? e.b : e.a;
          if (seen.has(other)) continue;
          seen.set(other, e.lengthM);
          stack.push(other);
        }
      }
      return seen;
    };
    const left = bfs(ends[0]);
    if (left.has(ends[1])) return null; // 不是桥：删掉也不会断
    const right = bfs(ends[1]);
    const lenOf = (m: Map<string, number>): number => {
      let t = 0;
      for (const v of m.values()) t += v;
      return t / 2; // 每条边被两端各记一次
    };
    return [lenOf(left), lenOf(right)];
  };

  return {
    canRemove(cutId: string): GuardVerdict {
      if (protectedCuts.has(cutId)) return { ok: false, why: '受保护（连通骨架）' };
      if (!kept.has(cutId)) return { ok: true, why: '已被合并' };

      const beforeIsolated = isolCount(kept);
      kept.delete(cutId);
      const afterIsolated = isolCount(kept);
      kept.add(cutId);
      if (afterIsolated > beforeIsolated) return { ok: false, why: '切除后会出现接不到外部道路的分量' };

      /**
       * 第一关：**骨架不能被切开**。
       *
       * 骨架是整张网的主干，一旦被切成两段，其中一段就只剩"自己接自己"——
       * 即使它还贴着红线，也失去了组织街区的作用。
       */
      kept.delete(cutId);
      const protAfter = protCompCount(kept);
      kept.add(cutId);
      if (protAfter > protComps) return { ok: false, why: '切除会把连通骨架切成两段' };
      return { ok: true, why: '' };
    },
    noteRemoved(cutId: string): void {
      kept.delete(cutId);
      protComps = protCompCount(kept);
    },
    kept(): Set<string> {
      return new Set(kept);
    },
  };
}

// ---------------------------------------------------------------- 采样与距离

/** 生成范围内的覆盖网格（洞里不采样） */
function gridOf(boundary: PlanSurface, step: number): Pt[] {
  const bb = bboxOf(boundary.outer);
  const out: Pt[] = [];
  const nx = Math.max(2, Math.min(90, Math.round((bb.maxX - bb.minX) / step)));
  const ny = Math.max(2, Math.min(90, Math.round((bb.maxY - bb.minY) / step)));
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const p = new Pt(bb.minX + ((i + 0.5) / nx) * (bb.maxX - bb.minX), bb.minY + ((j + 0.5) / ny) * (bb.maxY - bb.minY));
      if (insideRing(p, boundary)) out.push(p);
    }
  }
  return out;
}

function samplesOf(c: Cell, step: number): Pt[] {
  const out: Pt[] = [c.centroid];
  const bb = bboxOf(c.surface.outer);
  const sx = bb.maxX - bb.minX;
  const sy = bb.maxY - bb.minY;
  const nx = Math.max(1, Math.min(8, Math.round(sx / step)));
  const ny = Math.max(1, Math.min(8, Math.round(sy / step)));
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const p = new Pt(bb.minX + ((i + 0.5) / nx) * sx, bb.minY + ((j + 0.5) / ny) * sy);
      if (insideRing(p, c.surface)) out.push(p);
    }
  }
  for (const p of c.surface.outer) out.push(p);
  return out;
}

function maxDistM(p: Pt, rails: Pt[][]): number {
  let best = Infinity;
  for (const ln of rails) {
    for (let i = 0; i + 1 < ln.length; i++) {
      const q = closestOnSeg(p, ln[i], ln[i + 1]);
      const d = Pt.distance(p, q);
      if (d < best) best = d;
    }
  }
  return best * 7;
}

// ---------------------------------------------------------------- 最短接入链

interface ChainResult {
  cutIds: string[];
  lengthM: number;
  via: string;
}

/**
 * 从骨架分量的任一节点，沿**原始拓扑**走到最近的边界/接入节点，返回沿途的切线。
 *
 * 用 Dijkstra（边长 = 米），多源从所有 onBoundary / 有接入的节点出发。
 * 只加必要的那一段，不做"为了成环而补路"。
 */
function shortestChainToAccess(topo: CutTopology, comp: TopoComponent, protectedSet: Set<string>): ChainResult | null {
  const INF = Infinity;
  const dist = new Map<string, number>();
  const prev = new Map<string, { node: string; cutId: string }>();
  const queue: string[] = [];
  for (const n of topo.nodes.values()) {
    if (n.onBoundary || n.accessKind) {
      dist.set(n.id, 0);
      queue.push(n.id);
    }
  }
  if (queue.length === 0) return null;

  while (queue.length) {
    queue.sort((a, b) => (dist.get(a) ?? INF) - (dist.get(b) ?? INF));
    const cur = queue.shift()!;
    const dcur = dist.get(cur) ?? INF;
    for (const eid of topo.adj.get(cur) ?? []) {
      const e = topo.edges.get(eid)!;
      const other = e.a === cur ? e.b : e.a;
      const nd = dcur + e.lengthM;
      if (nd < (dist.get(other) ?? INF) - 1e-9) {
        dist.set(other, nd);
        prev.set(other, { node: cur, cutId: e.cutId });
        if (!queue.includes(other)) queue.push(other);
      }
    }
  }

  let bestNode: string | null = null;
  let bestD = INF;
  for (const nid of comp.nodes) {
    const d = dist.get(nid) ?? INF;
    if (d < bestD) {
      bestD = d;
      bestNode = nid;
    }
  }
  if (!bestNode || !Number.isFinite(bestD)) return null;

  const cutIds: string[] = [];
  let cur = bestNode;
  const guard = new Set<string>();
  while (prev.has(cur) && !guard.has(cur)) {
    guard.add(cur);
    const p = prev.get(cur)!;
    if (!protectedSet.has(p.cutId)) cutIds.push(p.cutId);
    cur = p.node;
  }
  const target = topo.nodes.get(cur);
  const via = target?.accessKind ?? (target?.onBoundary ? '红线' : cur);
  return { cutIds, lengthM: +bestD.toFixed(1), via: String(via) };
}

/** 供报告用：一块地的"最大服务距离"（米） */
export function maxServiceDistanceM(boundary: PlanSurface, cells: Cell[], stepM = 8): number {
  const step = stepM / 7;
  let m = 0;
  for (const c of cells) for (const p of samplesOf(c, step)) m = Math.max(m, maxDistM(p, [boundary.outer]));
  return +m.toFixed(1);
}
