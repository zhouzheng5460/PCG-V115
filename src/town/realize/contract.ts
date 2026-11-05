// Planning Realization · R0 契约
//
// 一句话：**把已经决定好的 Candidate 忠实造出来，不再做任何规划决策。**
//
// 这一层是单向的：
//   SitePlanCandidate → Realizer → Scene 特征（surfaces / solids / paths）
//
// 三条红线（Phase 3 的"❌ 规划"）：
//   ① 不移动 / 不旋转 / 不缩放 footprint（BuildingRule 只能改高度细分与外观）；
//   ② 不扩大停车区域（Parking Solver 只能在 ParkingRequest.region 里排）；
//   ③ 不重新决定"哪里放什么"（Realizer 里不许出现 area > x 之类的判定）。
//
// 也不修改 Stable Core：这里只 import Candidate 的类型，不回写。

import type { Pt } from '../../core/geom';
import type { MatKey } from '../../scene/palette';
import type { SurfaceFeature, SolidFeature, PathFeature, PropFeature, SolidKind } from '../../scene/types';
import type { GroundProgram, SitePlanCandidate } from '../planning/core/candidate';

/** 一条 Realization 的产物 */
export interface RealizedSitePlan {
  candidateId: string;

  surfaces: SurfaceFeature[];
  solids: SolidFeature[];
  paths: PathFeature[];
  props: PropFeature[];

  /** 各类对象的 id（= Candidate 侧的名字），用于 parity 对拍 */
  buildingIds: string[];
  groundIds: string[];
  roadIds: string[];
  parkingIds: string[];

  warnings: RealizationWarning[];

  /** R5 的道路统计（每段 circulation 一条） */
  roadStats?: {
    name: string;
    consumedCenterline: { x: number; y: number }[];
    profile: string;
    segments: number;
    lengthM: number;
    junctions: number;
  }[];

  /** R4 的车位统计（每块 ParkingRequest 一条）：有多少位、多少条通道、用了什么角度 */
  parkingStats?: {
    requestIndex: number;
    role: string;
    usableArea: number;
    stalls: number;
    aisles: number;
    angleDeg: number;
    /** 实际用哪套求解器算出来的（legacy / placemaker） */
    provider?: 'legacy' | 'placemaker';
    /** 车道**面**面积 m² */
    aisleM2?: number;
    /** 景观岛个数 */
    islandCount?: number;
    /** 车道面连通分量（1 = 连成一片） */
    aisleComps?: number;
    /** 车位前缘落在车道面内的比例 */
    frontRate?: number;
    /** 停车区里转成景观的空地 m² */
    lawnM2?: number;
    /** 保留铺装但无明确功能（咽喉 / 碎片）的面积 m² */
    deadPavingM2?: number;
  }[];
}

export interface RealizationWarning {
  code: string;
  message: string;
  /** 涉及的对象 */
  target?: string;
}

export interface RealizationContext {
  /** 分组前缀（导出到 glTF 时的节点分组） */
  group: string;
  /** 地面基准高度（默认与城市道路一致 0.012） */
  groundY?: number;
  /** 是否生成停车位（Phase 3 第一版不排，留 false） */
  solveParking?: boolean;
  /** 建筑材质覆盖（不覆盖就用 role 的默认值） */
  overrides?: Partial<Record<string, { wall: MatKey; roof: MatKey }>>;
  /**
   * 是否生成地块内配景（树）。默认 true。
   * 关掉它只是不种树，不影响任何规划几何 —— 它是外观层的事。
   */
  scenery?: boolean;
  /** 地块用途（用来区分不同 typology 的建筑外观：住宅暖色、商业幕墙…） */
  typology?: string;
  /**
   * 地块红线（可选）。给了就把**红线退线带**（parcel − buildableArea）也铺出来。
   *
   * 为什么放在 Realizer 而不是 Planner：这条带子是"红线以内、可建区以外"的那一圈，
   * 规划决策（可建区）已经做完了，剩下的只是**把它标明归属** —— 属于落地表达，
   * 不属于方案。放进 Candidate 会污染所有按可建区算比例的诊断。
   */
  parcel?: import('../planning/core/surface').PlanSurface;
  /** 可建区（可选）。与 parcel 一起给，才能算出"红线退线带"。 */
  buildable?: import('../planning/core/surface').PlanSurface;
  /** 退线带铺成什么 program（默认 landscape） */
  setbackProgram?: import('../planning/core/candidate').GroundProgram;
  /**
   * circulation 的来源（R1.3）。
   *
   * `legacy`（默认）= archetype 手画的固定直线；`solver` = R1 内部交通求解器。
   * 两者对路面的要求不同：
   *   · 裁剪体：solver 的路会走在退线带里，必须裁到**红线**；legacy 裁到 ground 并集；
   *   · 中心线表达：solver 的路面已经由 realizeRoads 铺好，不再额外画一条
   *     PathFeature（否则同一段路被画两遍：面 + 线）；
   *   · 停车障碍：solver 的路要先从停车区里扣掉，车位不许压在路面上。
   */
  circulationMode?: 'legacy' | 'solver';
  /**
   * 停车求解器选择：legacy（现有求解器）/ placemaker（C# 离线烘焙）/ compare（两套都算，正式场景用 legacy）。
   * 默认 legacy —— 生产行为不变。
   */
  parkingProvider?: 'legacy' | 'placemaker' | 'compare';
}

/** Ground Program → 材质（R1 的唯一映射表，场景代码里不许再散落 if/else） */
export const GROUND_MATERIAL: Record<GroundProgram, MatKey> = {
  // 工业
  //
  // 铺装按**荷载等级**分三层，这是工业总图最核心的读法：
  //   货场 + 装卸坪 = 混凝土（最亮）—— 重载、叉车、拖挂，用不到沥青
  //   员工停车 + 服务道 = 沥青（中/深）—— 轻载，且要能画出车位线
  //   缓冲带 + 设备场 = 砂石（暖灰）
  // 原来 truck_court 和 employee_parking 都是 asphaltLot，工厂后面那 30%
  // 读成"一整片灰"，看不出哪里能走叉车、哪里是车位。
  truck_court: 'concrete',
  loading_apron: 'concrete',
  service_lane: 'asphalt',
  employee_parking: 'asphaltLot',
  office_forecourt: 'paver',
  // 工业缓冲带用**砂石**而不是草：真实的工业场地边缘就是碎石/杂草，
  // 而且工业地块的缓冲带动辄 20% 面积，给草会把整片工业区染成公园。
  landscape_buffer: 'gravel',
  utility_yard: 'gravel',
  // 住宅 / 零售 / 酒店共用
  //
  // 院子用草坪而不是浅灰铺装：stonePave(0.757) 和屋面 roofLight(0.615)
  // 在俯视图里几乎同色，一大片院子读起来像"这块地空着"。
  //
  // 但**不能用 grassLight**：住宅围合方案的院子占地块 67%，
  // 全城铺亮绿之后读起来是"公园里散着几栋楼"，不是城市。
  // 院子用**低饱和浅绿(lawn)**，不用 grass / grassLight：
  // 院子占围合式住宅地块 67%，饱和草绿铺满后整座城像"公园里散着几栋楼"。
  // 边缘绿化继续用 grassDark（深、饱和），于是 院子(浅灰绿) / 绿地(深绿) /
  // 铺装(paver 0.66~0.76) 三层能分开，且灰调为主。
  courtyard: 'lawn',
  amenity: 'paver',
  entrance_forecourt: 'stonePave',
  pedestrian: 'paver',
  // 车位用**浅灰**、通道用深灰 —— 这是专业总图的读法：
  // 车位格子浅（大面积硬地，视觉上往后退），车行道深（图的"骨"）。
  // 早先车位用 asphaltLot(0.268)、通道用 asphalt(0.243)，差 0.025，
  // 俯视图上完全分不开，整个停车场读成一片灰。
  parking: 'asphaltLot',
  parking_aisle: 'curb',
  parking_island: 'grass',
  landscape: 'grassDark',
  // 绿地层次：草坪（亮、可进入）/ 种植区（深、不可进入）/ 次步道（碎石）
  lawn: 'lawn',
  planting: 'grassDark',
  park_path: 'gravel',
  service: 'asphalt',
  // 酒店
  arrival_court: 'stonePave',
  dropoff: 'asphalt',
  // 数据中心
  mechanical_yard: 'concrete',
  electrical_yard: 'concrete',
  security_buffer: 'grass',
  // 独栋
  front_yard: 'grass',
  rear_yard: 'grassDark',
  driveway: 'concrete',
  community_green: 'grass',
  // 兜底
  residual: 'gravel',
};

/** Ground Program → 相对基准的层高偏移（避免共面 z-fighting，同时保留语义层次） */
export const GROUND_LIFT: Partial<Record<GroundProgram, number>> = {
  truck_court: 0.0004,
  parking: 0.0004,
  parking_aisle: 0.0004,
  parking_island: 0.0008,
  employee_parking: 0.0004,
  dropoff: 0.0006,
  driveway: 0.0008,
  service: 0.0004,
  service_lane: 0.0004,
  loading_apron: 0.0004,
  pedestrian: 0.0012,
  entrance_forecourt: 0.001,
  arrival_court: 0.001,
  courtyard: 0.001,
};

/** PlannedBuilding.role → SolidKind（realize 层唯一映射） */
export const ROLE_TO_KIND: Record<string, SolidKind> = {
  warehouse: 'warehouse',
  hall: 'warehouse',
  house: 'house',
  tower: 'tower',
  podium: 'podium',
  office: 'retail',
  amenity: 'podium',
  slab: 'slab',
};

/**
 * 按 typology 的建筑外观（R8 Visual Review）。
 *
 * 为什么要按 typology 分，而不只用 role：
 * legacy 链里住宅是 `brick / concrete 随机`、板楼是 `concrete / panel 随机`，
 * 于是俯视图上住宅是暖色斑驳、板楼是灰白、塔楼是玻璃幕墙 ——
 * **一眼能读出"这是住宅区 / 商业区 / 工业区"**。
 *
 * Planner 链早期把 `house` 固定成 wallConcrete，全城一个色调，
 * "素白大盒子"就是这么来的（wallGlass 数量从 33 掉到 0）。
 *
 * 这里给每个 typology 定一组墙/屋面候选，并按建筑序号确定性交替 ——
 * 同一片里相邻两栋不完全同色，但重建一次结果不变。
 */
export const TYPOLOGY_APPEARANCE: Record<
  string,
  { walls: { wall: MatKey; roof: MatKey }[]; note: string }
> = {
  multi_family: {
    // 多层住宅：砖红外墙 + **中深灰平屋顶**。
    //
    // 2D 用 roofMat 填充、wallMat 描边，所以"屋顶用浅色"等于"楼是白的" ——
    // 浅灰 roofLight(0.62) 铺在 lawn(0.72) 的院子上，只暗 0.1，
    // 整片读成"更白的一块地面"，就是用户说的"素白大盒子"。
    // 压到 roofFlat(0.40) / roofDark(0.30) 之后 figure-ground 才立起来：
    // 浅绿院子上的深灰条 = 楼，这是总图的读法。
    walls: [
      { wall: 'wallBrick', roof: 'roofDark' },
      { wall: 'wallConcrete', roof: 'roofDark' },
      { wall: 'wallBrick', roof: 'roofFlat' },
    ],
    note: '多层住宅：砖红外墙 + 深灰平屋顶',
  },
  single_family: {
    walls: [
      { wall: 'wallBrick', roof: 'roofDark' },
      { wall: 'wallStone', roof: 'roofFlat' },
      { wall: 'wallConcrete', roof: 'roofFlat' },
    ],
    note: '独栋：暖色外墙 + 深色坡屋面',
  },
  retail: {
    // 商业：玻璃幕墙 + 浅色檐口屋面（商业大盒在总图上本来就是浅的，
    // 和住宅的深灰屋顶正好形成"住深商浅"的读法）
    walls: [
      { wall: 'wallGlass', roof: 'roofLight' },
      { wall: 'wallPanel', roof: 'roofMetal' },
      { wall: 'wallStone', roof: 'roofLight' },
    ],
    note: '零售：玻璃幕墙为主',
  },
  civic: {
    // 公共建筑：石材/浅色外墙 + 浅色平屋面。
    // 不做玻璃幕墙（那是商业的语言），也不做深色屋面（那是住宅的语言）——
    // 政务中心/文化馆在总图上就是"浅色、方正、压得住场子"的一栋。
    walls: [
      { wall: 'wallStone', roof: 'roofLight' },
      { wall: 'wallConcrete', roof: 'roofLight' },
      { wall: 'wallStone', roof: 'roofFlat' },
    ],
    note: '公共建筑：浅色石材外墙 + 浅色平屋面',
  },
  hotel: {
    walls: [
      { wall: 'wallStone', roof: 'roofFlat' },
      { wall: 'wallGlass', roof: 'roofLight' },
    ],
    note: '酒店：石材 + 玻璃',
  },
  data_center: {
    walls: [{ wall: 'wallPanel', roof: 'roofMetal' }],
    note: '数据中心：金属面板',
  },
  industrial: {
    walls: [
      { wall: 'wallPanel', roof: 'roofMetal' },
      { wall: 'wallConcrete', roof: 'roofFlat' },
    ],
    note: '工业：金属面板 / 混凝土',
  },
};

/** 每种 role 的默认墙 / 屋面材质 */
export const ROLE_MATERIAL: Record<string, { wall: MatKey; roof: MatKey }> = {
  warehouse: { wall: 'wallPanel', roof: 'roofMetal' },
  hall: { wall: 'wallPanel', roof: 'roofMetal' },
  house: { wall: 'wallConcrete', roof: 'roofLight' },
  tower: { wall: 'wallGlass', roof: 'roofLight' },
  podium: { wall: 'wallStone', roof: 'roofLight' },
  office: { wall: 'wallPanel', roof: 'roofLight' },
  amenity: { wall: 'wallStone', roof: 'roofLight' },
  slab: { wall: 'wallPanel', roof: 'roofLight' },
};

/** 一条"开口"在场景里的落地宽度（米） */
export const ACCESS_WIDTH_M: Record<string, number> = {
  pedestrian: 3,
  vehicle: 6,
  service: 5,
  truck: 10,
};

export interface RealizerPart {
  name: string;
  surfaces: SurfaceFeature[];
  solids: SolidFeature[];
  paths: PathFeature[];
  props: PropFeature[];
  warnings: RealizationWarning[];
}

export function emptyPart(name: string): RealizerPart {
  return { name, surfaces: [], solids: [], paths: [], props: [], warnings: [] };
}
