// F2.5-D · 道路视觉设计层的类型
//
// 这一层**不改拓扑**：节点、边的连接关系原样保留，只重新组织"视觉上的路段"：
//   图：节点 + 边（C.1 的 RoadGraph，一件一件的 Cut 段）
//   ↓ paths：把穿过度 2 节点的连续边串成一条完整街道
//   ↓ fillet：对折角做圆弧/切角修形（端点节点不动）
//   ↓ junction：在每个 ≥3 度的节点上算一个真正的路口多边形
//
// 所有几何都带来源：DesignPath 记住 edgeIds / cutIds / nodeIds，
// JunctionPoly 记住每个臂来自哪条 path、口线在哪。

import type { Pt } from '../../../../core/geom';
import type { PlanSurface } from '../../core/surface';
import type { RoadClass } from '../types';

/** 断面（米）：车行道宽度直接取 graph 的 widthM，其余由风格给出 */
export interface RoadSection {
  /** 车行道全宽（= 边宽度） */
  carriageM: number;
  /** 单侧人行道 */
  walkM: number;
  /** 单侧绿带 */
  vergeM: number;
  /** 路缘收边（视觉宽度，不参与面积扣减） */
  curbM: number;
}

/** 设计角色：图上能读出"这是主街 / 这是尽端支路" */
export type DesignRole = 'arterial' | 'collector' | 'local' | 'dead-end';

export interface BendFix {
  /** 对应图里的节点（修形不移动它，只是中心线在旁边绕过） */
  nodeId: string;
  at: Pt;
  turnDeg: number;
  action: 'none' | 'arc' | 'chamfer' | 'fallback';
  radiusM: number;
  why: string;
}

export interface DesignPath {
  id: string;
  /** 来源：图的边（顺序与 pts 一致） */
  edgeIds: string[];
  /** 来源：fracture 的 Cut（三层追溯） */
  cutIds: string[];
  /** 路径上的节点（首尾 + 内部弯点） */
  nodeIds: string[];
  roadClass: RoadClass;
  role: DesignRole;
  roleWhy: string;
  widthM: number;
  section: RoadSection;
  /** 原始中心线（C.1 的输出，未修形） */
  rawPts: Pt[];
  /** 修形后的中心线 */
  pts: Pt[];
  /** 用于生成路面的中心线（两端在路口处收回 d，避免压进路口多边形） */
  corridorPts: Pt[];
  bends: BendFix[];
  /** 两端（哪端接路口 / 尽头 / 红线） */
  ends: {
    nodeId: string;
    at: Pt;
    kind: 'junction' | 'terminal' | 'boundary';
    /** 路口端的口线距离；非路口为 0 */
    dM: number;
  }[];
  notes: string[];
}

export interface JunctionArm {
  pathId: string;
  edgeId: string;
  /** 从节点指向外的单位向量 */
  dir: Pt;
  widthM: number;
  /** 口线到节点的距离 */
  dM: number;
  /** 口线两端（右 = 沿 dir 的右手侧） */
  mouthA: Pt;
  mouthB: Pt;
}

export interface JunctionCorner {
  /** 这个转角连接的两条臂（pathId） */
  fromPath: string;
  toPath: string;
  /** 两条路缘线的交点（尖角点） */
  apex: Pt;
  /** 修形后的曲线点（二次贝塞尔，控制点在 apex） */
  pts: Pt[];
  /** 修形方式与原因 */
  action: 'arc' | 'chamfer' | 'fallback';
  why: string;
}

export interface JunctionPoly {
  nodeId: string;
  at: Pt;
  /** 角度排序后的臂（CCW） */
  arms: JunctionArm[];
  /** 路口多边形（CCW；每个臂一段口线，臂之间一段转角曲线） */
  ring: Pt[];
  corners: JunctionCorner[];
  kind: 'T' | 'cross' | 'multi';
  /** 路口面积（m²） */
  areaM2: number;
  notes: string[];
}

/** 缺口决策：F03/F04 的真实几何缺口 */
export interface GapDecision {
  aNode: string;
  bNode: string;
  atA: Pt;
  atB: Pt;
  gapM: number;
  action: 'connect' | 'dead-end';
  why: string;
  connectorId?: string;
}

export interface TopologyChange {
  kind: 'connect-gap' | 'mark-dead-end';
  a: string;
  b: string;
  lengthM: number;
  why: string;
}

export interface DesignNode {
  id: string;
  at: Pt;
  kind: 'junction' | 'terminal' | 'boundary';
  degree: number;
  junctionId?: string;
}

export interface RoadDesignGraph {
  paths: DesignPath[];
  junctions: JunctionPoly[];
  nodes: Map<string, DesignNode>;
  gaps: GapDecision[];
  topologyChanges: TopologyChange[];
  /** 修形前后的偏差统计（米） */
  deviation: { maxM: number; meanM: number; filleted: number; chamfered: number; fallback: number };
  notes: string[];
}

/** 路面成果 */
export interface RoadSurfaces {
  /** 车行道（含路口）—— 唯一用于扣减 Compound 的路面 */
  carriage: PlanSurface[];
  /** 每条 path 的走廊（未并集，出图与调试用） */
  corridors: PlanSurface[];
  /** 路口多边形（独立面，不靠互相压盖） */
  junctionPolys: PlanSurface[];
  /** 人行道 / 绿带 / 转角铺装 */
  walk: PlanSurface[];
  verge: PlanSurface[];
  corner: PlanSurface[];
  /** 标线（中心虚线 + 停止线），出图用 */
  markings: { pts: Pt[]; kind: 'dash' | 'stop' | 'edge'; widthM: number }[];
  /** 面积（m²） */
  areaM2: { carriage: number; junction: number; walk: number; verge: number; corner: number };
  notes: string[];
}
