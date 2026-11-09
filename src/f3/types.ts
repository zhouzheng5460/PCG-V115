// F3 · 规则驱动的城市合成器 —— 规格、预设与中间数据结构
//
// 与 F2.5 的根本区别：**没有候选、没有评分**。
// 风貌 → 一组固定参数 → 单次确定性生成 → 几何校验 → 出图。
// 同一个 spec + 同一个 seed 必须给出一模一样的城市，连树的抖动都要一样。
//
// 单位约定（全项目一致）：1 世界单位 = 7 m。
// 本文件里的预设参数**全部以米为单位**（写起来直观），
// 进几何前统一用 `U()` 换成世界单位，面积用 `M2()` 换成平方米。

import type { Pt } from '../core/geom';
import type { PlanSurface } from '../town/planning/core/surface';

/** 1 米 = 多少世界单位 */
export const U = (m: number): number => m / 7;
/** 世界单位² → 平方米 */
export const M2 = (u2: number): number => u2 * 49;

export type CityStyle = 'structured' | 'organic' | 'campus';
export type CityDensity = 'low' | 'medium' | 'high';
export type CityProgram = 'residential' | 'commercial' | 'cbd' | 'industrial' | 'campus' | 'mixed';
export type RoadClass3 = 'arterial' | 'collector' | 'local';

export interface CitySpec {
  /** 城市边界（外环 + 洞） */
  boundary: PlanSurface;
  style: CityStyle;
  density: CityDensity;
  program: CityProgram;
  seed: number;
  /** 覆盖预设的街区目标面积（m²） */
  blockM2?: number;
  /** 覆盖预设的主方向（弧度）。不填走场地 OBB 长轴 */
  axisRad?: number;
  /**
   * 方向控制线（用户在图上画的"街道希望往这边走"）。
   *
   * 接到张量场当 `path` 型场源：线两侧约 3 个街区宽内主干路转向这条线，
   * 越远越回到全局方向。没有这一步，方向控制 UI 在 F3 下画了等于没画。
   */
  guides?: import('../town/guide').FieldGuide[];
  /**
   * 地块内建筑生成方式。
   *   `binary`：随机二叉分割 + 间距 offset（默认，按 Houdini 那套）
   *   `row`   ：最大内接矩形 + 排 × 段（上一版，留作对比与回退）
   */
  buildMode?: 'binary' | 'row';
  /** 建筑高度倍率（UI 全局滑杆用） */
  heightScale?: number;
  /**
   * 禁建区（用户在图上画的固定范围）。
   *
   * 语义：**生成完之后**再做局部后处理（`zoneapply.ts`），不参与路网与街区生成。
   *   · 禁区**本体**：里面的建筑**整栋**剔除（不是布尔切）、地块地面换成禁区材质、
   *     与本体重叠的**路面被裁掉**；
   *   · 本体 + 让距（`zonePadM`）：只在地块层面生效——剔楼、铺装、补树，
   *     **不动路面**（用户明确要求"让距范围影响的道路不要调整"）；
   *   · 让距内可选生成"衔接铺装"（内部路 / 草地 / 停车场）。
   *
   * 交互界面会按"无禁区"缓存基础城市，改禁区只重跑后处理（毫秒级）；
   * 直接调 `runF3City({ zones })` 时入口会替你调一次后处理，效果一致。
   */
  zones?: import('../town/zones').Zone[];
  /** 禁区的让距（米，默认 6 m = 一条人行道）。只在有 zones 时生效 */
  zonePadM?: number;
  /** 让距内是否生成衔接铺装（内部路 / 草地 / 停车场），默认 true */
  zonePadPave?: boolean;
  /** 逐街区覆盖（切分方向 / 地块数 / 类型 / 楼高），键是街区 id（`B12`） */
  blockOverrides?: Record<string, BlockOverride>;
  /** 调试开关：关掉路网图清理（`?f3clean=0`），用来 A/B 对比多线相交是否真的被清掉 */
  noGraphClean?: boolean;
  /**
   * 路网创建方式（先后关系，不是并列的两套路网）：
   *   `tensor`（默认）—— 第一步用 legacy 张量场生成道路，之后才切分街道围成的地块；
   *   `split`        —— 回退到递归面切分生成道路（对比用，URL `?f3road=split`）。
   * 两种方式的后续（道路建模 / 街区内切分 / 建筑布局）完全相同。
   */
  roadMode?: 'tensor' | 'split';
}

// ---------------------------------------------------------------- 断面

/** 道路断面（米）。**不是法定规范**，是游戏风格参数 */
export interface RoadSection {
  /** 车行道总宽（含双向） */
  carriage: number;
  /** 路缘石宽 */
  curb: number;
  /** 人行道宽（单侧） */
  walk: number;
  /**
   * 路侧绿带宽（单侧，0 = 没有）。
   *
   * 现已**全部置 0**：路侧绿带是用「最外一圈断面」做出来的，它必然会在路口
   * 转角绕成绿色楔形，与转角铺装 / 圆角抢同一块地；实测每个路口都要靠
   * `cornerZones` 事后铲掉，留下的收头边界就是那些"尖刺 / 半截绿钩"。
   * 绿化改由街区内部（`landuse` 的地块绿化、行道树）提供 —— 那里没有
   * 闭合面求差的病态输入，形状干净得多。
   */
  green: number;
}

export interface StylePreset {
  /** 目标街区面积（m²）：决定街道间距与合并目标 */
  blockM2: number;
  /** 街道间距（米）：规则路网的格网模数 */
  spacingM: number;
  section: Record<RoadClass3, RoadSection>;
  /** 建筑覆盖率上限（占地块比例） */
  coverage: number;
  /** 单个**建筑子地块**的目标面积（m²），按用途：切分的唯一尺度依据 */
  parcelM2: Record<'residential' | 'commercial' | 'cbd' | 'industrial' | 'campus' | 'park' | 'civic' | 'green', [number, number]>;
  /** 停车占"地块剩余可建面积"的目标比例 */
  parkingShare: number;
  /** 绿化占剩余空间的目标比例（用于判断"这块地还要不要塞停车"） */
  greenShare: number;
  /** 规则说明（报告与 HUD 直接显示） */
  note: string;
}

/**
 * 三种风貌的预设。
 *
 * `structured` 是网格城市：8% 的主干 + 32% 次干 + 其余支路，街区 0.6~1.2 ha。
 * `organic` 是自然生长的城市边缘：路更窄、街区尺度差异大，允许 15° 以内的
 *   方向漂移（由张量场的边界源给出），所以图上会有"顺着地形拐过去"的街。
 * `campus` 是园区：路极宽（货运）、间距 190 m、街区动辄 2 ha，只切一刀。
 */
export const STYLE_PRESETS: Record<CityStyle, StylePreset> = {
  structured: {
    blockM2: 16000,
    spacingM: 152,
    section: {
      arterial: { carriage: 17, curb: 0.4, walk: 3.2, green: 0 },
      collector: { carriage: 12, curb: 0.35, walk: 2.6, green: 0 },
      local: { carriage: 8, curb: 0.3, walk: 2.0, green: 0 },
    },
    coverage: 0.42,
    parcelM2: {
      residential: [420, 700],
      commercial: [300, 520],
      cbd: [760, 1300],
      industrial: [3200, 6000],
      campus: [4200, 7800],
      park: [6000, 12000],
      civic: [1400, 2600],
      green: [3000, 7000],
    },
    parkingShare: 0.22,
    greenShare: 0.26,
    note: '规则路网：主干贯通、次干围合、支路细分；街区尺度一致',
  },
  organic: {
    blockM2: 13000,
    spacingM: 136,
    section: {
      arterial: { carriage: 13, curb: 0.35, walk: 2.6, green: 0 },
      collector: { carriage: 9.5, curb: 0.3, walk: 2.2, green: 0 },
      local: { carriage: 7, curb: 0.3, walk: 1.8, green: 0 },
    },
    coverage: 0.46,
    parcelM2: {
      residential: [380, 640],
      commercial: [280, 470],
      cbd: [680, 1150],
      industrial: [2900, 5400],
      campus: [3800, 7000],
      park: [5400, 11000],
      civic: [1300, 2400],
      green: [2800, 6400],
    },
    parkingShare: 0.26,
    greenShare: 0.3,
    note: '有机路网：方向随边界缓慢漂移，街区大小不均但不出现锐角三角路',
  },
  campus: {
    blockM2: 42000,
    spacingM: 240,
    section: {
      arterial: { carriage: 18, curb: 0.45, walk: 3.6, green: 0 },
      collector: { carriage: 13, curb: 0.4, walk: 2.8, green: 0 },
      local: { carriage: 9, curb: 0.3, walk: 2.0, green: 0 },
    },
    coverage: 0.38,
    parcelM2: {
      residential: [900, 1500],
      commercial: [700, 1200],
      cbd: [1400, 2400],
      industrial: [6000, 11000],
      campus: [7000, 13000],
      park: [9000, 18000],
      civic: [2600, 4800],
      green: [5000, 12000],
    },
    parkingShare: 0.3,
    greenShare: 0.24,
    note: '园区路网：一条主轴 + 少量分支，保留大片完整厂区/校区',
  },
};

export interface DensityPreset {
  /** 住宅层数区间 */
  residentialFloors: [number, number];
  /** 商业层数区间 */
  commercialFloors: [number, number];
  /** CBD 塔楼层数区间 */
  towerFloors: [number, number];
  /** 工业厂房檐高（米） */
  industrialHeight: [number, number];
  /** 地块面积倍率：密度越高地块越小 */
  parcelScale: number;
  /** 层高（米） */
  floorH: number;
}

export const DENSITY_PRESETS: Record<CityDensity, DensityPreset> = {
  low: {
    residentialFloors: [3, 5],
    commercialFloors: [1, 2],
    towerFloors: [6, 10],
    industrialHeight: [8, 10],
    parcelScale: 1.25,
    floorH: 3.2,
  },
  medium: {
    residentialFloors: [5, 9],
    commercialFloors: [2, 3],
    towerFloors: [10, 18],
    industrialHeight: [9, 12],
    parcelScale: 1,
    floorH: 3.1,
  },
  high: {
    residentialFloors: [9, 18],
    commercialFloors: [3, 5],
    towerFloors: [18, 34],
    industrialHeight: [10, 14],
    parcelScale: 0.82,
    floorH: 3.0,
  },
};

// ---------------------------------------------------------------- 路网

/** 生成阶段的一条道路中心线（进入 PathGraph 之前的原始线） */
export interface RawRoad {
  id: string;
  pts: Pt[];
  cls: RoadClass3;
  /** 来源：规则格网 / 破碎合并 / 园区骨架 / 用户主线 */
  from: 'grid' | 'fracture' | 'spine' | 'guide';
}

export interface PathNode {
  id: string;
  at: Pt;
  degree: number;
  /** 是否贴在城市红线上（尽头落在边界） */
  onBoundary: boolean;
  edges: string[];
}

export interface PathEdge {
  id: string;
  a: string;
  b: string;
  /** 两个节点之间的折线（含中间折点：修形与路面都读它） */
  pts: Pt[];
  cls: RoadClass3;
  /** 车行道总宽（世界单位） */
  widthU: number;
  from: RawRoad['from'];
}

/** 一条"路径"：穿过数个度 2 节点的一整条街。路面按路径铺，不按边铺 */
export interface RoadPath {
  id: string;
  pts: Pt[];
  cls: RoadClass3;
  widthU: number;
  edgeIds: string[];
  nodeIds: string[];
}

export interface PathGraph {
  nodes: Map<string, PathNode>;
  edges: Map<string, PathEdge>;
  paths: RoadPath[];
  /** 真正需要路口多边形的节点（度 ≥ 3，或度 2 但两条边夹角 > 25°） */
  junctions: string[];
}

// ---------------------------------------------------------------- 街区与地块

export type BlockUse = 'residential' | 'commercial' | 'cbd' | 'industrial' | 'campus' | 'park' | 'civic' | 'green';

/**
 * 属性面板能选的"地块类型"：BlockUse + 一个**保留地**。
 *
 * 保留地故意不进 `BlockUse`：它不是一种用地指标，而是"这块地什么都不许盖"。
 * 生成时按"公园"的切分规则走（整块不切），但地面铺硬地、不排建筑 ——
 * 这样 12 张按用途查表的 Record 不用全部加一行空值。
 */
export type UseChoice = BlockUse | 'reserved';

/**
 * 单街区的人工覆盖（属性面板里改的那四项）。
 *
 * 为什么放在 CitySpec 而不是生成后再改几何：
 * 切分方向 / 切分数量会改变地块拓扑，建筑与地面都是从地块派生的 ——
 * 只有回到生成入口重跑，才不会出现"楼还按旧地块摆"的错位。
 */
export interface BlockOverride {
  /** 切分方向（弧度）：地块长轴朝向。不填 = 按临街方向 */
  axisRad?: number;
  /** 目标地块数：换算成目标面积后交给二叉分割（近似值，最后按几何微调） */
  parcels?: number;
  /** 地块类型（含保留地） */
  use?: UseChoice;
  /** 该街区的建筑高度倍率（1 = 全局） */
  heightScale?: number;
}

export interface CityBlock {
  id: string;
  surface: PlanSurface;
  areaM2: number;
  use: BlockUse;
  /** 最靠近它的道路等级（用途分配与断面都读它） */
  nearestCls: RoadClass3;
  /** 到城市中心的归一化距离 0~1 */
  centerDist: number;
  /** 面向街道的方向（从街道指向街区内部，弧度） */
  frontRad: number;
  /** 为什么给它这个用途（报告要能逐块解释） */
  why: string;
}

export interface BuildingParcel {
  id: string;
  blockId: string;
  use: BlockUse;
  surface: PlanSurface;
  areaM2: number;
  /** 临街方向（弧度）：由最近道路法线给出，建筑内退与入口都按它 */
  frontRad: number;
  /** 临街边到道路中线的距离（米），用于判断"要不要留前场" */
  frontDistM: number;
  /** 综合可达性 0~1（主中心 + 宽路廊道 + 次中心 + 区位场），由 landuse.ts 写 */
  access?: number;
  /** 宽路廊道强度 0~1 */
  corridor?: number;
  /** 区位未观测特征（低频连续场，-1~1），不是逐栋随机抖动 */
  localIntensity?: number;
  /** 该地块最靠近的道路等级 */
  streetCls?: RoadClass3;
  /** 是否临街第一排（到路缘 < 26 m） */
  frontRow?: boolean;
  /** 最靠近的那条街道 id（逐街统计带状商业占比用） */
  nearPathId?: string;
  /** 这一块地为什么给这个用途（逐块可解释） */
  useWhy?: string;
}

/** 最大内接矩形搜索结果（不虚称最优：带栅格精度与校验信息） */
export interface InscribedRect {
  /** 局部坐标下的矩形环（世界坐标） */
  ring: Pt[];
  areaM2: number;
  /** 相对世界坐标的旋转角 */
  angRad: number;
  /** 搜索质量：矩形面积 / 地块面积 */
  quality: number;
  /** 栅格精度（米） */
  cellM: number;
  /** 是否通过四角 + 边中点的真实几何校验 */
  verified: boolean;
  attempts: number;
}

export interface CityStats {
  roadLengthM: number;
  roadAreaM2: number;
  junctionAreaM2: number;
  sidewalkAreaM2: number;
  greenAreaM2: number;
  blockCount: number;
  parcelCount: number;
  buildingCount: number;
  parkingBays: number;
  treeCount: number;
  /** 建筑面积（占地） */
  footprintAreaM2: number;
  /** 地块面积合计（对账用） */
  parcelAreaM2: number;
  /** 建成区（边界内）面积 */
  siteAreaM2: number;
  /** 未归属面积（应当接近 0，超过阈值要在报告里解释） */
  unclaimedM2: number;
  gfaM2: number;
}
