// Site Planning Core · Candidate Contract（PRD §P2.1）
//
// Candidate 是"一次完整的场地规划方案"，但它**不碰场景**：
// 不 import scene / three / renderer，只产出纯数据。Phase 2 末尾才由
// 单独的 adapter 把 Candidate 翻译成 SurfaceFeature / SolidFeature。
//
// 特别注意 `parkingRequests`：Phase 2 **不直接生成停车位**，只声明
// "这里要一片员工停车、入口在朝街那一侧"，具体的车位排布留给
// parking.ts 的 solver 消费 —— 否则规划错了和排错了会混在一起，无法调试。

import type { Pt } from '../../../core/geom';
import type { PlanSurface } from './surface';
import type { AccessKind, LayoutDiagnostics, SiteTypology } from './types';

/**
 * Ground Program（PRD §13 + §P2.6 的白名单）。
 *
 * Phase 2 只允许工业需要的七种 + residual。不要在这里加"装饰铺装 / 绿岛细分"，
 * 这一阶段的目的是验证**功能关系**，不是美化。
 */
export type GroundProgram =
  // 工业
  | 'office_forecourt'
  | 'employee_parking'
  | 'landscape_buffer'
  | 'loading_apron'
  | 'truck_court'
  | 'service_lane'
  | 'utility_yard'
  // 多户住宅 / 酒店 / 零售共用
  | 'courtyard'
  | 'amenity'
  | 'entrance_forecourt'
  // 酒店：到达院落与落客区（Freeze §5 允许新增程序，不改 SiteContext）
  | 'arrival_court'
  | 'dropoff'
  // 数据中心：设备场与安防缓冲（Freeze §5 允许，上限 3 个）
  | 'mechanical_yard'
  | 'electrical_yard'
  | 'security_buffer'
  // 独栋住宅：宅地内的院与车道（Freeze §5 允许；**内部路不进 Ground，走 circulation**）
  | 'front_yard'
  | 'rear_yard'
  | 'driveway'
  | 'community_green'
  | 'pedestrian'
  | 'parking'
  /**
   * 停车场里的**车行通道**（与车位面分开）。
   *
   * 专业总图上"车位格子"和"车行道"是两种材质：车位是浅一点的沥青、通道更深。
   * 之前为了避开重叠把它们合并成一个 `parking`，结果是整片一片灰 ——
   * 这正是"停车场看起来不像设计过"的直接原因。
   */
  | 'parking_aisle'
  /** 停车场里的**树岛**（车位组之间的绿带，不穿通道） */
  | 'parking_island'
  /**
   * 开阔草坪（修剪过的、可以踩上去的那种）。
   *
   * 和 `landscape`（种植区/野草地）分开，是因为公园和绿地需要**读得出层次**：
   * 大草坪、树丛、花境在总图上是三种绿，一种绿铺满就分不出哪里能活动。
   */
  | 'lawn'
  /** 种植区 / 密林 / 灌木带：不可进入的绿 */
  | 'planting'
  /** 公园里的次步道（碎石/透水，2~3 m）；主步道仍走 `pedestrian` */
  | 'park_path'
  | 'landscape'
  | 'service'
  // 兜底
  | 'residual';

/** 建筑体块的**规划角色**（不是渲染用的 SolidKind） */
export type BuildingRole = 'warehouse' | 'office' | 'amenity' | 'tower' | 'podium' | 'house' | 'hall';

export interface PlannedBuilding {
  role: BuildingRole;
  footprint: PlanSurface;
  /** 高度（世界单位；1 单位 ≈ 7 m） */
  height: number;
  /** 这一侧是正立面（朝哪条临街面），用于校验"正面朝主街" */
  frontSide?: Pt;
  /** 装卸面法线（工业专有：指向 truck court） */
  loadingSide?: Pt;
  notes?: string[];
}

export interface PlannedRegion {
  program: GroundProgram;
  surface: PlanSurface;
  /** 面积（世界单位²），方便 evaluator 直接用 */
  area: number;
  notes?: string[];
}

export interface PlannedAccess {
  kind: AccessKind;
  at: Pt;
  normal: Pt;
  /**
   * 这个口服务谁：car / truck / pedestrian / service / main_lobby。
   *
   * `main_lobby` 是酒店引入的：它不是一个"入口"，而是**到达序列的终点锚点** ——
   * 有了它才能验"落客点 → 大堂"这段有多长、中间有没有被停车或后勤切开。
   * 这是值层面的语义扩展，字段结构没变（Freeze §5/§6 允许）。
   */
  role: 'car' | 'truck' | 'pedestrian' | 'service' | 'main_lobby';
  /** 在哪条临街面上（'primary' / 'secondary' / 'service'），便于查"客货是否共用一条边" */
  frontage: 'primary' | 'secondary' | 'service';
  notes?: string[];
}

export interface PlannedPath {
  /** 内部通道（truck court 里的行车线 / 后场服务道） */
  pts: Pt[];
  width: number;
  role: 'vehicle' | 'truck' | 'pedestrian';
  /**
   * 这条中心线是谁定的（**可选，不改已有字段语义**）。
   *
   * - `archetype`（默认，缺省即此）：archetype 手画的固定直线，Realizer 既铺路面
   *   又画一条中心线（PathFeature），这是历史行为；
   * - `solver`：R1 内部交通求解器算出来的，路面由 `realizeRoads` 铺，
   *   **不再额外画一条 PathFeature** —— 否则同一段路会被画两次（面 + 线）。
   */
  source?: 'archetype' | 'solver' | 'skeleton';
}

/** 停车需求（**不含车位**，只声明区域与入口） */
export interface ParkingRequest {
  role: 'employee' | 'visitor' | 'resident' | 'guest' | 'truck' | 'trailer';
  region: PlanSurface;
  preferredEntry?: Pt;
  targetDensity: 'low' | 'medium' | 'high';
  notes?: string[];
}

/** 一次规划方案 */
export interface SitePlanCandidate {
  id: string;
  typology: SiteTypology;
  archetype: string;

  buildings: PlannedBuilding[];
  ground: PlannedRegion[];
  access: PlannedAccess[];
  parkingRequests: ParkingRequest[];
  circulation: PlannedPath[];

  score?: number;
  diagnostics?: LayoutDiagnostics;

  notes: string[];
}

/** 这个方案用的地面程序（去重，便于校验白名单） */
export function groundProgramsOf(c: SitePlanCandidate): GroundProgram[] {
  return Array.from(new Set(c.ground.map((g) => g.program)));
}

/** 方案总面积（地面各程序之和），用于残地计算 */
export function groundArea(c: SitePlanCandidate): number {
  return c.ground.reduce((a, g) => a + g.area, 0);
}

/**
 * 结构自检：不合法就返回原因，合法返回 null。
 *
 * 放在 Contract 里而不是各 archetype 里：Phase 2 的每个生成器都要过这一关，
 * 免得"某个 archetype 忘了填 loadingSide / 面积算成 0"这类问题拖到渲染才暴露。
 */
export function validateCandidate(c: SitePlanCandidate): string[] {
  const errs: string[] = [];
  if (!c.id) errs.push('缺少 id');
  if (!c.archetype) errs.push('缺少 archetype');
  if (c.buildings.length === 0) errs.push('没有建筑');

  for (const b of c.buildings) {
    if (b.footprint.outer.length < 3) errs.push(`建筑 ${b.role} 轮廓无效`);
    if (!(b.height > 0)) errs.push(`建筑 ${b.role} 高度无效`);
  }
  for (const g of c.ground) {
    if (g.surface.outer.length < 3) errs.push(`地面 ${g.program} 轮廓无效`);
    if (!(g.area > 0)) errs.push(`地面 ${g.program} 面积为 0`);
  }
  // 同一个 program 允许多块（端部绿化、两侧隔离带都是两条），
  // 但不能有面积算成 0 的碎片。真正该禁止的是"重叠"，那是几何层的事，
  // 不在这里查（查重叠需要两两求交，代价不该由 Contract 付）。
  return errs;
}
