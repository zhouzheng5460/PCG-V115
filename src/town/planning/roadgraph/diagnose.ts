// F2.5-C.1 · 连通性诊断
//
// 任务书 §1 要求对每个样板逐个回答六个问题。这一层的职责就是"只回答，不修"：
//   · 每个分量有哪些节点和边
//   · 分量有没有接进**真实**城市道路（不是"碰到红线"就算）
//   · 哪些被 Merge 删掉的 Cell 边是**关键**连接边（加回去能减少分量数）
//   · 每个分量服务几个 Compound
//   · 是不是绕洞形成的合法闭环 / 无接入的孤立环路
//   · 是不是节点化错误造成的假断连（几何上明明差 2 m 却当成两段）
//
// 最后一条特别说明：本模块**不会**为了让图连通而放大吸附容差。
// 2~6 m 的缺口一律列成 "几何不相接"，让读者看见它是缺口，而不是假装接上了。

import { Pt } from '../../../core/geom';
import { distToRingsU, isClosedLoop, reconnectGain, componentsOf, type CutTopology } from './primal';
import type { AccessKind, AccessPoint } from './access';
import { metricsOf, type Block } from './regions';
import type { Cell, Cut } from './fracture';
import type { PlanSurface } from '../core/surface';
import type { RoadGraph } from './types';

export interface DiagNode {
  id: string;
  at: [number, number];
  degree: number;
  onBoundary: boolean;
  accessKind: AccessKind | null;
}

export interface DiagEdge {
  id: string;
  cutId: string | null;
  from: string;
  to: string;
  lengthM: number;
}

export type ComponentVerdict =
  /** 接进了真实城市道路 */
  | 'city-access'
  /** 只贴红线（红线外假定公共） */
  | 'boundary-only'
  /** 绕洞的闭环，但没有外部接入 */
  | 'isolated-loop'
  /** 绕洞的闭环，且有外部接入 */
  | 'hole-ring'
  /** 悬空在城市内部、接不到任何外部 */
  | 'isolated';

export interface ComponentDiag {
  id: string;
  nodes: DiagNode[];
  edges: DiagEdge[];
  lengthM: number;
  touchesBoundary: boolean;
  touchesCityRoad: boolean;
  accessIds: string[];
  closedLoop: boolean;
  aroundHole: boolean;
  compounds: string[];
  cells: string[];
  verdict: ComponentVerdict;
  note: string;
}

export interface KeyEdgeDiag {
  cutId: string;
  lengthM: number;
  /** 加回去会接起哪两个分量 */
  joins: [string, string];
  /** 两侧分量原本是否都接得到外部 */
  sidesWithoutAccess: number;
  left: string;
  right: string;
}

export interface NearMiss {
  a: [number, number];
  b: [number, number];
  gapM: number;
  why: string;
}

export interface CompoundDiag {
  id: string;
  areaM2: number;
  frontageM: number;
  onOuterBoundary: boolean;
  served: boolean;
  cells: string[];
  /** 短轴跨度（米）与长短轴比：判"狭长地块" */
  minorM: number;
  aspect: number;
  /** 短轴小于策略下限 → 狭长 */
  sliver: boolean;
  note: string;
}

export interface DiagInput {
  boundary: PlanSurface;
  cells: Cell[];
  cuts: Cut[];
  kept: Cut[];
  access: AccessPoint[];
  graph: RoadGraph;
  blocks: Block[];
  blockOfCell: Map<string, string>;
  topo: CutTopology;
  /** 建图时被剪掉的短边（来自 RoadGraph.diagnostics） */
  pruned?: { count: number; lengthM: number; cuts: string[] };
  /** 街区短边下限（米）：来自密度策略，用来判狭长 */
  minBlockWidthM?: number;
}

export interface DiagResult {
  components: ComponentDiag[];
  keyEdges: KeyEdgeDiag[];
  nearMiss: NearMiss[];
  compounds: CompoundDiag[];
  /** 无外部接入的分量数（目标 0） */
  isolated: number;
  /** 服务的 Compound 里没有被任何道路服务的数量（目标 0） */
  unserved: number;
  totals: {
    comps: number;
    nodes: number;
    edges: number;
    lengthM: number;
    roadAreaM2: number;
    compounds: number;
    keptCuts: number;
    removedCuts: number;
    /** 短于 12 m 的路段（无意义路段） */
    shortEdges: number;
    shortEdgeLenM: number;
    /** 狭长街区数（短轴 < 策略下限） */
    slivers: number;
  };
}

const TOL_BOUNDARY_M = 3;
const TOL_CITY_M = 16;

export function diagnose(inp: DiagInput): DiagResult {
  const g = inp.graph;
  const access = inp.access;
  const cutById = new Map(inp.cuts.map((c) => [c.id, c]));

  // 分量（用**最终图**，不是候选拓扑 —— 诊断的是交付物）
  const comps: ComponentDiag[] = [];
  g.connectedComponents.forEach((nodeIds, i) => {
    const set = new Set(nodeIds);
    const edges: DiagEdge[] = [];
    for (const e of g.edges.values()) {
      if (set.has(e.from) && set.has(e.to)) {
        edges.push({
          id: e.id,
          cutId: e.cutId ?? null,
          from: e.from,
          to: e.to,
          lengthM: +(polyLenM(e.centerline)).toFixed(1),
        });
      }
    }
    const nodes: DiagNode[] = nodeIds.map((id) => {
      const n = g.nodes.get(id)!;
      const onB = n.nodeType === 'boundary' || distToRingsU(n.position, [inp.boundary.outer, ...inp.boundary.holes]) * 7 <= TOL_BOUNDARY_M;
      let kind: AccessKind | null = null;
      let best = TOL_CITY_M;
      for (const a of access) {
        if (a.kind === 'siteBoundary') continue;
        const d = Pt.distance(a.at, n.position) * 7;
        if (d <= best) {
          best = d;
          kind = a.kind;
        }
      }
      return {
        id,
        at: [+(n.position.x * 7).toFixed(1), +(n.position.y * 7).toFixed(1)],
        degree: n.connectedEdges.length,
        onBoundary: onB,
        accessKind: kind,
      };
    });

    let lengthM = 0;
    for (const e of edges) lengthM += e.lengthM;

    const touchesBoundary = nodes.some((n) => n.onBoundary);
    const cityNodes = nodes.filter((n) => n.accessKind === 'cityRoad' || n.accessKind === 'entrance');
    const touchesCityRoad = cityNodes.length > 0;
    const ids = new Set(edges.map((e) => e.cutId).filter((x): x is string => !!x));

    const cells = new Set<string>();
    const compounds = new Set<string>();
    for (const cid of ids) {
      const cut = cutById.get(cid);
      if (!cut) continue;
      for (const cellId of [cut.left, cut.right]) {
        cells.add(cellId);
        const b = inp.blockOfCell.get(cellId);
        if (b) compounds.add(b);
      }
    }

    const closedLoop =
      nodes.length >= 3 && edges.length === nodes.length && nodes.every((n) => n.degree === 2);
    const aroundHole = closedLoop && loopCoversHole(nodes, inp.boundary);

    let verdict: ComponentVerdict;
    let note: string;
    if (touchesCityRoad) {
      verdict = 'city-access';
      note = `接进真实城市道路 ${cityNodes.map((n) => n.accessKind).join('/')}`;
    } else if (touchesBoundary) {
      verdict = aroundHole ? 'hole-ring' : 'boundary-only';
      note = aroundHole ? '绕洞闭环，且两端落在红线上' : '只贴红线（红线外假定公共空间），未接真实道路';
    } else if (closedLoop) {
      verdict = 'isolated-loop';
      note = aroundHole ? '绕洞闭环，但没有任何外部接入 —— 非法' : '闭环，且没有任何外部接入 —— 非法';
    } else {
      verdict = 'isolated';
      note = '悬空在城市内部，接不到任何外部 —— 非法';
    }

    comps.push({
      id: `cp${i}`,
      nodes,
      edges,
      lengthM: +lengthM.toFixed(1),
      touchesBoundary,
      touchesCityRoad,
      accessIds: [...new Set(cityNodes.map((n) => `${n.accessKind}`))],
      closedLoop,
      aroundHole,
      compounds: [...compounds],
      cells: [...cells],
      verdict,
      note,
    });
  });

  // 被删掉的"关键 Cell 边"：加回去能接起两个不同分量
  const keptSet = new Set(inp.kept.map((c) => c.id));
  const topoComps = componentsOf(inp.topo, keptSet);
  const compAccess = new Map<string, boolean>();
  for (const c of topoComps) compAccess.set(c.id, c.onBoundary || c.hasAccess);

  const keyEdges: KeyEdgeDiag[] = [];
  for (const cut of inp.cuts) {
    if (keptSet.has(cut.id)) continue;
    const r = reconnectGain(inp.topo, keptSet, cut.id);
    if (!r.joins || !r.sides) continue;
    const noAcc = r.sides.filter((s) => !compAccess.get(s)).length;
    keyEdges.push({
      cutId: cut.id,
      lengthM: +cut.lenM.toFixed(1),
      joins: [r.sides[0], r.sides[1]],
      sidesWithoutAccess: noAcc,
      left: cut.left,
      right: cut.right,
    });
  }

  // 近似相接但没接上（1.5 ~ 8 m）：列出来，不修
  const nearMiss: NearMiss[] = [];
  for (let i = 0; i < comps.length; i++) {
    for (let j = i + 1; j < comps.length; j++) {
      let best = Infinity;
      let pa: [number, number] | null = null;
      let pb: [number, number] | null = null;
      for (const a of comps[i].nodes) {
        for (const b of comps[j].nodes) {
          const d = Math.hypot(a.at[0] - b.at[0], a.at[1] - b.at[1]);
          if (d < best) {
            best = d;
            pa = a.at;
            pb = b.at;
          }
        }
      }
      if (pa && pb && best <= 8 && best > 1.5) {
        nearMiss.push({ a: pa, b: pb, gapM: +best.toFixed(1), why: '端点相距 1.5~8 m：真实几何缺口，不用容差伪造' });
      }
    }
  }

  // Compound 服务情况
  const keptCuts = inp.kept;
  const frontOf = new Map<string, number>();
  for (const c of keptCuts) {
    for (const cellId of [c.left, c.right]) {
      const b = inp.blockOfCell.get(cellId);
      if (!b) continue;
      frontOf.set(b, (frontOf.get(b) ?? 0) + c.lenM);
    }
  }
  const minW = inp.minBlockWidthM ?? 18;
  const compounds: CompoundDiag[] = inp.blocks.map((b) => {
    const frontageM = +(frontOf.get(b.id) ?? 0).toFixed(1);
    const onOuter = ringTouches(b.surface, inp.boundary.outer, TOL_BOUNDARY_M / 7);
    const served = frontageM > 0.5 || onOuter;
    const m = metricsOf(b.surface);
    return {
      id: b.id,
      areaM2: b.areaM2,
      frontageM,
      onOuterBoundary: onOuter,
      served,
      cells: b.cells,
      minorM: m.minorM,
      aspect: m.aspect,
      sliver: m.minorM < minW,
      note: served ? (frontageM > 0.5 ? `临内部路 ${frontageM.toFixed(0)} m` : '直接临街') : '既无内部路也无临街 —— 不可达',
    };
  });

  let shortEdges = 0;
  let shortEdgeLenM = 0;
  for (const e of g.edges.values()) {
    const len = polyLenM(e.centerline) / 1;
    const atBoundary = g.nodes.get(e.from)?.nodeType === 'boundary' || g.nodes.get(e.to)?.nodeType === 'boundary';
    if (len < 12 && !atBoundary) {
      shortEdges++;
      shortEdgeLenM += len;
    }
  }
  const slivers = compounds.filter((c) => c.sliver).length;

  const isolated = comps.filter((c) => c.verdict === 'isolated' || c.verdict === 'isolated-loop').length;
  const unserved = compounds.filter((c) => !c.served).length;
  const roadAreaM2 = [...g.edges.values()].reduce((s, e) => s + polyLenM(e.centerline) * e.widthM, 0);

  return {
    components: comps,
    keyEdges,
    nearMiss,
    compounds,
    isolated,
    unserved,
    totals: {
      comps: comps.length,
      nodes: g.nodes.size,
      edges: g.edges.size,
      lengthM: +comps.reduce((s, c) => s + c.lengthM, 0).toFixed(1),
      roadAreaM2: +roadAreaM2.toFixed(0),
      compounds: compounds.length,
      keptCuts: keptCuts.length,
      removedCuts: inp.cuts.length - keptCuts.length,
      shortEdges,
      shortEdgeLenM: +shortEdgeLenM.toFixed(1),
      slivers,
    },
  };
}

// ---------------------------------------------------------------- 小工具

function polyLenM(pts: Pt[]): number {
  let t = 0;
  for (let i = 0; i + 1 < pts.length; i++) t += Pt.distance(pts[i], pts[i + 1]);
  return t * 7;
}

/** 闭环是否套着一个洞（用洞的形心判断） */
function loopCoversHole(nodes: DiagNode[], boundary: PlanSurface): boolean {
  if (boundary.holes.length === 0) return false;
  const ring = nodes.map((n) => new Pt(n.at[0] / 7, n.at[1] / 7));
  for (const h of boundary.holes) {
    const c = h.reduce((a, p) => new Pt(a.x + p.x / h.length, a.y + p.y / h.length), new Pt());
    if (pointInRing(c, ring)) return true;
  }
  return false;
}

function ringTouches(s: PlanSurface, outer: Pt[], tol: number): boolean {
  for (const p of s.outer) if (distToRingsU(p, [outer]) <= tol) return true;
  return false;
}

function pointInRing(p: Pt, ring: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y || 1e-12) + a.x) inside = !inside;
  }
  return inside;
}

export { isClosedLoop };
