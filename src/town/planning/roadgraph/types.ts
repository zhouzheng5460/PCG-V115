// F2.5 · 道路中心线图 —— 唯一权威几何源
//
// 这一层**不引用** Three.js / Canvas / SceneIR，也不引用 Town 的模型与地块：
// 它只认识「点、线、宽度、等级、拓扑」。道路面、路口、人行道、绿带、标线、GLB
// 全部从这里派生；任何反向依赖（从面片反推宽度）都算违约。
//
// 与旧系统（`src/road/system.ts`）的关系见 F2_5_A_ROAD_AUDIT.md：
//   · 旧 `RoadEdge{a,b,insetL,insetR,...}`：中心线 = 两点直线，宽度由两侧地块退让反推；
//   · 新 `RoadEdge.centerline: Pt[]`：有序路径点，宽度自带，支持曲线与多段。

import type { Pt } from '../../../core/geom';

export type RoadClass = 'arterial' | 'collector' | 'local' | 'internal';

/** 等级的排序权重（路口让行、宽度下限、渲染线宽都用它） */
export const CLASS_RANK: Record<RoadClass, number> = {
  arterial: 3,
  collector: 2,
  local: 1,
  internal: 0,
};

export const CLASS_LABEL: Record<RoadClass, string> = {
  arterial: '主干道',
  collector: '次干道',
  local: '支路',
  internal: '内部路',
};

/**
 * 节点类型。
 *
 * F2.5-C.1 补了 'bend'：上一轮把"度 2 的过路点"也算成 intersection，
 * 于是图上到处是"路口"，报告里的交叉口数量根本不能用来判断路网质量。
 */
export type NodeType = 'intersection' | 'bend' | 'terminal' | 'boundary' | 'entrance';

export interface RoadNode {
  id: string;
  position: Pt;
  connectedEdges: string[];
  nodeType: NodeType;
}

export type EdgeSource = 'fracture' | 'inherited' | 'manual';

export interface RoadEdge {
  id: string;
  from: string;
  to: string;
  /** 有序路径点：首点 = from，末点 = to，中间是曲线 */
  centerline: Pt[];
  roadClass: RoadClass;
  widthM: number;
  source: EdgeSource;
  /** 来自哪条候选切线（fracture 的 Cut.id）：三层数据互相追溯用 */
  cutId?: string;
  /** 设计参数（可选，供选型与出图用；不参与几何） */
  design?: {
    /** 总转角（度）：越大越"弯" */
    turnDeg?: number;
    /** 这段路服务的地块数（选型时优先保留组织多地块的路） */
    serves?: number;
    /** 优先级：0~1，越大越该保留 */
    priority?: number;
    /** 断面：车行道 / 人行道 / 绿带（米，单侧） */
    section?: { carriageM: number; walkM: number; vergeM: number };
  };
}

export interface RoadGraph {
  nodes: Map<string, RoadNode>;
  edges: Map<string, RoadEdge>;
  /** 节点 id → 邻接边 id */
  adjacency: Map<string, string[]>;
  /** 连通分量（每组是一组节点 id） */
  connectedComponents: string[][];
  /** 落在生成范围边界上的节点（路网与"外部世界"的接口） */
  boundaryConnections: string[];
  /** 生成范围（用于出图与越界检查） */
  boundary?: Pt[][];
  /** 建图过程中的清理记录（诊断用） */
  diagnostics?: {
    /** 被剪掉的短边数 */
    prunedEdges: number;
    /** 被剪掉的总长度（米） */
    prunedLengthM: number;
    /** 因此消失的切线 id */
    droppedCuts: string[];
  };
}

export function emptyGraph(): RoadGraph {
  return {
    nodes: new Map(),
    edges: new Map(),
    adjacency: new Map(),
    connectedComponents: [],
    boundaryConnections: [],
  };
}

/** 边的长度（米）：按世界单位算完 ×7 */
export function edgeLengthM(e: RoadEdge): number {
  let t = 0;
  for (let i = 0; i + 1 < e.centerline.length; i++) {
    t += Math.hypot(e.centerline[i + 1].x - e.centerline[i].x, e.centerline[i + 1].y - e.centerline[i].y);
  }
  return t * 7;
}

/** 图里所有边的总长（米） */
export function graphLengthM(g: RoadGraph): number {
  let t = 0;
  for (const e of g.edges.values()) t += edgeLengthM(e);
  return t;
}

/** 重新计算邻接、连通分量、边界连接 —— 任何增删边之后都要调一次 */
export function reindex(g: RoadGraph): void {
  g.adjacency.clear();
  for (const n of g.nodes.values()) n.connectedEdges = [];
  for (const e of g.edges.values()) {
    const a = g.nodes.get(e.from);
    const b = g.nodes.get(e.to);
    if (!a || !b) continue;
    a.connectedEdges.push(e.id);
    b.connectedEdges.push(e.id);
    if (!g.adjacency.has(a.id)) g.adjacency.set(a.id, []);
    if (!g.adjacency.has(b.id)) g.adjacency.set(b.id, []);
    g.adjacency.get(a.id)!.push(e.id);
    g.adjacency.get(b.id)!.push(e.id);
  }

  // 节点类型：度 0/1 = 尽端，≥3 = 交叉口，度 2 视边界而定
  for (const n of g.nodes.values()) {
    const deg = n.connectedEdges.length;
    // boundary / entrance 是"来源标记"而不是"度数推导结果"，不能被覆盖
    if (n.nodeType === 'entrance' || n.nodeType === 'boundary') continue;
    if (deg <= 1) n.nodeType = 'terminal';
    else if (deg >= 3) n.nodeType = 'intersection';
    else n.nodeType = 'bend';
  }

  // 连通分量
  const seen = new Set<string>();
  const comps: string[][] = [];
  for (const id of g.nodes.keys()) {
    if (seen.has(id)) continue;
    const stack = [id];
    const comp: string[] = [];
    seen.add(id);
    while (stack.length) {
      const cur = stack.pop()!;
      comp.push(cur);
      for (const eid of g.adjacency.get(cur) ?? []) {
        const e = g.edges.get(eid);
        if (!e) continue;
        const other = e.from === cur ? e.to : e.from;
        if (seen.has(other)) continue;
        seen.add(other);
        stack.push(other);
      }
    }
    comps.push(comp);
  }
  g.connectedComponents = comps.sort((a, b) => b.length - a.length);
}

/** 图的摘要（报告与断言用） */
export function graphStats(g: RoadGraph): {
  nodes: number;
  edges: number;
  intersections: number;
  bends: number;
  terminals: number;
  boundaries: number;
  lengthM: number;
  components: number;
  dangling: number;
} {
  let intersections = 0;
  let bends = 0;
  let terminals = 0;
  let boundaries = 0;
  let dangling = 0;
  for (const n of g.nodes.values()) {
    if (n.nodeType === 'intersection') intersections++;
    else if (n.nodeType === 'bend') bends++;
    else if (n.nodeType === 'terminal') terminals++;
    else if (n.nodeType === 'boundary') boundaries++;
    // 悬空端点：度为 1 且不在边界上
    if (n.connectedEdges.length <= 1 && n.nodeType !== 'boundary') dangling++;
  }
  return {
    nodes: g.nodes.size,
    edges: g.edges.size,
    intersections,
    bends,
    terminals,
    boundaries,
    lengthM: +graphLengthM(g).toFixed(1),
    components: g.connectedComponents.length,
    dangling,
  };
}
