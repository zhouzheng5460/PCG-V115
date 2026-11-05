// F2.4-B · 街区总平面合成 —— 类型合同
//
// 与 F2.4-A 的分工：
//   · F2.4-A（`planning/adapt`）回答"给定一块地，建筑摆哪" —— 它把既有建筑当**输入**；
//   · F2.4-B（本模块）回答"整块街区怎么组织" —— 既有建筑**不在输入里**，
//     新建筑按道路与地块重新生成（任务书第二节：不继承旧建筑 footprint / 坐标 / 朝向 / 栋数）。
//
// 阶段划分（对应任务书第十一节）：
//   A 道路与地块协同：`SiteInfrastructurePlan` + `ParcelSubdivisionResult`
//   B 新建筑群：`SiteBuilding[]`（含洞口、朝向、语法来源）
//   C 完整场地：`ParkingArea[]` + `GroundPatch[]` + 2D/3D 输出
//
// 一份契约贯穿三段，禁止各段自造字段：所有面积都从 `PlanSurface` 现算，
// 所有"为什么"都落成一句人话（`reason` / `purpose`）。

import type { Pt } from '../../../core/geom';
import type { PlanSurface } from '../core/surface';
import type { SiteRoadEdge, SiteTypology } from '../core/types';
import type { SubdivisionCandidate, SubdivisionRun } from '../subdivision/types';
import type { ParkLayout } from '../../parking';

// ---------------------------------------------------------------- 输入

export interface ComposeInput {
  id: string;
  typology: SiteTypology;
  /** 街区红线（含洞）。地块分割在它上面做 */
  boundary: PlanSurface;
  /** 退线后的可建区 = 红线 − 建筑退让。**不含既有建筑**（本阶段从零生成） */
  buildable: PlanSurface;
  /** 街区周边的真实城市道路（只读；本模块不改 Road Graph） */
  roadEdges: SiteRoadEdge[];
  /** 真实车辆出入口候选（来自 core/context 的 vehicleAccessCandidates） */
  vehicleEntrances: Pt[];
  /** 真实人行出入口候选 */
  pedestrianEntrances: Pt[];
  seed: number;
}

// ---------------------------------------------------------------- 阶段 A：基础设施

export type RoadClass = 'primary' | 'secondary' | 'service' | 'pedestrian';

/**
 * 内部道路。
 *
 * `serves` 不是装饰：任务书要求"任何新增内部道路必须能够说明服务对象"。
 * 一条 `serves` 为空的路不允许存在（验证层直接判错）。
 */
export interface InternalRoad {
  id: string;
  cls: RoadClass;
  /** 含两侧路缘的**总宽**（米）；车行道净宽见 `carriageM` */
  widthM: number;
  carriageM: number;
  centerline: Pt[];
  surface: PlanSurface;
  /** 服务的地块 id */
  serves: string[];
  /** 从哪个真实街口接出（`SiteGate.id`） */
  from: string;
  reason: string;
}

/** 街区级出入口：必须落在真实城市道路上 */
export interface SiteGate {
  id: string;
  kind: 'vehicle' | 'pedestrian' | 'service';
  at: Pt;
  /** 指向街区外的法线（= 道路方向的反向） */
  normal: Pt;
  roadKey: string;
  widthM: number;
}

/** 一块地的接入关系 */
export interface AccessLink {
  parcelId: string;
  via: 'street' | 'internal' | 'lane';
  /** 城市道路 key / 内部道路 id / 巷道 id */
  ref: string;
  at: Pt;
  /** 从地块边界到通行中心线的距离（米） */
  lengthM: number;
  /** 这条接入是否满足"车行"净宽（false 只能步行/服务） */
  vehicular: boolean;
}

/** 一个骨架候选的评估记录（写进报告，也进 JSON） */
export interface SkeletonOption {
  id: string;
  label: string;
  strategyId: string;
  score: number;
  /** 每个分项的原始值，便于复核打分 */
  metrics: {
    roadM2: number;
    roadShare: number;
    parcels: number;
    unservedM2: number;
    unservedShare: number;
    frontageShare: number;
    fragmentShare: number;
    compoundM2: number;
  };
  /** 分项（键 = 项名，值 = 该项目贡献的分数），诊断用 */
  scoreTerms: { k: string; v: number }[];
  /** 为什么是这个分 */
  reason: string;
  /** 是否因为硬性原因被否（无接入面积 > 0 且无可救） */
  rejected?: string;
}

export interface SiteInfrastructurePlan {
  roads: InternalRoad[];
  gates: SiteGate[];
  access: AccessLink[];
  /** 道路 + 路缘铺装占掉的地面（已裁到红线内） */
  roadGround: PlanSurface[];
  /** 全部骨架 × 策略组合的评估 */
  options: SkeletonOption[];
  chosen: string;
  notes: string[];
}

// ---------------------------------------------------------------- 阶段 A：地块

export type ParcelFunction =
  | 'building'
  | 'compound'
  | 'parking'
  | 'plaza'
  | 'green'
  | 'service'
  | 'reserve';

export const FN_LABEL: Record<ParcelFunction, string> = {
  building: '建筑地块',
  compound: '建筑组团',
  parking: '集中停车',
  plaza: '公共广场',
  green: '公共绿地',
  service: '服务后勤',
  reserve: '保留空间',
};

/** 用途分配的打分项（全部可复核，不是黑箱） */
export interface FunctionScore {
  fn: ParcelFunction;
  score: number;
  /** 分项贡献，便于在报告里解释"为什么不是别的用途" */
  terms: { k: string; v: number }[];
}

export interface ParcelPlan {
  id: string;
  /** F2.1 的原始候选（只读引用） */
  candidate: SubdivisionCandidate;
  /** 地块面（= 候选面） */
  surface: PlanSurface;
  /** 扣掉内部道路后的可建域 */
  usable: PlanSurface;
  fn: ParcelFunction;
  /** 为什么是这个用途（人话 + 数字） */
  reason: string;
  /** 全部候选用途的得分（降序），报告用 */
  ranked: FunctionScore[];
  /** 临街长度（米，只算真实城市道路） */
  streetFrontageM: number;
  /** 临街长度（米，含内部道路） */
  frontageM: number;
  /** 到最近真实车辆出入口的距离（米） */
  gateM: number;
  access: AccessLink[];
}

export interface ParcelSubdivisionResult {
  parcels: ParcelPlan[];
  run: SubdivisionRun;
  /** 内部道路作为合成道路边之后的完整临街边集合 */
  edges: SiteRoadEdge[];
  /** 地块面积之和 vs (可建区 − 道路) 的对账（m²） */
  accountedM2: number;
  parentM2: number;
  residualM2: number;
}

// ---------------------------------------------------------------- 阶段 B：建筑

export type BuildingGrammar =
  | 'street-shop-line'
  | 'courtyard-block'
  | 'courtyard-bar'
  | 'parallel-slabs'
  | 'tower'
  | 'big-box'
  | 'office'
  | 'hall'
  | 'compound-mixed';

export type SiteDoorKind = 'main' | 'secondary' | 'service' | 'freight';

export interface SiteDoor {
  kind: SiteDoorKind;
  at: Pt;
  normal: Pt;
  /** 接到的通行空间：内部道路 id / 街道 key / 步行道 id */
  target: string;
  /** 门到通行中心线的距离（米） */
  reachM: number;
  /** 门前空间（前场/装卸坪/庭院）是否已经生成 */
  apron: boolean;
}

export interface SiteBuilding {
  id: string;
  parcelId: string;
  name: string;
  grammar: BuildingGrammar;
  /** 建筑占地（真实多边形：可能被地块边界裁出斜边） */
  surface: PlanSurface;
  center: Pt;
  /** 长轴（弧度） */
  ang: number;
  widthM: number;
  depthM: number;
  floors: number;
  heightM: number;
  doors: SiteDoor[];
  /** 为什么用这套形态（进报告） */
  reason: string;
  /** 实际占地 / 目标包络（<1 = 被边界裁过） */
  fill: number;
}

// ---------------------------------------------------------------- 阶段 C：停车与地面

export interface ParkingArea {
  id: string;
  parcelId: string;
  surface: PlanSurface;
  stalls: number;
  layout: ParkLayout;
  /** 出入口（从哪条路进） */
  gate: SiteDoor | null;
  /** 内部连通验证：每排车位 → 通道 → 出入口 → 道路 */
  checks: {
    aisles: number;
    /** 每条通道是否与出入口铺装连通 */
    aislesConnected: number;
    /** 每个车位前缘到最近通道的距离（米）最大值 */
    stallGapMaxM: number;
    /** 出入口到道路中心线的距离（米） */
    gateReachM: number;
    /** 停车到最近建筑门厅的步行距离（米） */
    walkToBuildingM: number | null;
    ok: boolean;
  };
  reason: string;
}

export type GroundKind =
  | 'plaza'
  | 'forecourt'
  | 'courtyard'
  | 'loading'
  | 'parking-deck'
  | 'footpath'
  | 'driveway'
  | 'sidewalk'
  | 'green'
  | 'planting'
  | 'planter'
  | 'unassigned';

export const GROUND_LABEL: Record<GroundKind, string> = {
  plaza: '入口广场',
  forecourt: '建筑前场',
  courtyard: '内部庭院',
  loading: '装卸作业场',
  'parking-deck': '停车铺装',
  footpath: '步行道',
  driveway: '车行道',
  sidewalk: '人行道',
  green: '绿地',
  planting: '道路种植带',
  planter: '花坛节点',
  unassigned: '未设计区',
};

export interface GroundPatch {
  kind: GroundKind;
  surface: PlanSurface;
  areaM2: number;
  /** 这块地干什么用的（绿地必须写清，`unassigned` 必须写原因） */
  purpose: string;
  parcelId?: string;
  /** 属于哪类通行（footpath / driveway / sidewalk 用于连通校验） */
  walkable?: boolean;
  drivable?: boolean;
}

// ---------------------------------------------------------------- 整份方案

export interface ComposeNote {
  code:
    | 'skeleton-chosen'
    | 'skeleton-rejected'
    | 'lane-proposed'
    | 'access-fail'
    | 'function'
    | 'grammar'
    | 'reject'
    | 'parking'
    | 'green'
    | 'unassigned'
    | 'engine-fail'
    | 'road-serves';
  severity: 'info' | 'warn' | 'error';
  message: string;
  at?: Pt;
}

export interface ComposeValidation {
  ok: boolean;
  errors: ComposeNote[];
  warnings: ComposeNote[];
  /** 建筑越出所属地块可建域的面积（m²） */
  buildingOutsideM2: number;
  /** 建筑之间非法重叠（m²） */
  buildingOverlapM2: number;
  /** 建筑压到内部道路（m²） */
  buildingOnRoadM2: number;
  /** 地面类型之间的非法互压（m²） */
  groundOverlapM2: number;
  /** 道路越出红线（m²） */
  roadOutsideM2: number;
  /** 洞被建筑/铺装填死的面积（m²） */
  holeFilledM2: number;
  /** 面积对账误差：建筑 + 停车 + 地面 vs 可建区（m²） */
  reconciliationM2: number;
  /** 门未接通的个数 */
  doorFailures: number;
  /** 停车验证未通过的停车区个数 */
  parkingFailures: number;
  /** 明确判定的工程不可行项（如货车转弯净宽不足） */
  engineeringFailures: string[];
}

export interface ComposeMetrics {
  /** 红线面积（m²） */
  blockM2: number;
  buildableM2: number;
  roadM2: number;
  roadShare: number;
  parcels: number;
  /** 按用途统计的净面积（m²） */
  byFunction: Record<string, number>;
  buildings: number;
  /** 建筑占地（m²） */
  footprintM2: number;
  /** 覆盖度 = 建筑占地 / 可建区 */
  coverage: number;
  /** 总建筑面积（m²）= 占地 × 层数 */
  gfaM2: number;
  /** 容积率 = GFA / 可建区 */
  far: number;
  stalls: number;
  /** 车位 / 100 m² GFA */
  stallsPer100: number;
  greenM2: number;
  greenShare: number;
  plazaM2: number;
  unassignedM2: number;
  unassignedShare: number;
  /** 沿街界面连续性：临街面上 40 m 内有建筑的样本比例 */
  frontageContinuity: number;
  /** 建筑到所属地块主轴的方向偏差（按面积加权，度） */
  orientDevDeg: number;
  /** 门到通行网络的加权平均距离（米） */
  doorReachM: number;
  /** 每块地是否落到"可用空间核心"（人工看图时的辅助，不作评分） */
  buildingsPerCompound: number;
  /** 生成耗时（ms） */
  ms: number;
}

export interface SiteComposition {
  id: string;
  typology: SiteTypology;
  input: ComposeInput;
  infra: SiteInfrastructurePlan;
  parcels: ParcelSubdivisionResult;
  buildings: SiteBuilding[];
  parking: ParkingArea[];
  ground: GroundPatch[];
  /** 街区自带的洞（中庭）：不属于任何地块，但必须有归属 */
  voids: GroundPatch[];
  validation: ComposeValidation;
  metrics: ComposeMetrics;
  notes: ComposeNote[];
}
