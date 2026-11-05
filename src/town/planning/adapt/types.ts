// F2.4-A · 建筑布局适配 —— 类型合同
//
// 这一层**不改** F2.1 的分割合同（`SubdivisionCandidate` 只读），
// 只是在它的产出上回答一个新问题：**建筑到底该摆在哪**。
//
// 输入：一个 `SubdivisionCandidate`（surface / usable / frontages / access / role）
// 输出：该地块的建筑、门、通道、各类空地，以及一套可对照的数字指标。
//
// 设计纪律：
//   · 建筑永远是**真实多边形**（矩形包络），不是"概念上的中心点"；
//   · 摆不下就明确拒绝并给原因，**不许把建筑缩到异常比例**蒙混过关；
//   · 绿地是"扣完建筑、通道、停车、装卸之后剩下的"，不是一个用来填坑的类别。

import type { Pt } from '../../../core/geom';
import type { PlanSurface } from '../core/surface';
import type { PieceRole } from '../subdivision/types';

/** 建筑在组团里的角色（与 archetype 的 BuildingRole 无关，别混用） */
export type BuildingKind = 'street_bar' | 'courtyard_bar' | 'rear_bar' | 'hall' | 'house' | 'tower';

/** 门的接入对象：必须是真实存在的通行空间 */
export type DoorTarget = 'street' | 'lane' | 'courtyard' | 'loading';

export interface BuildingDoor {
  at: Pt;
  /** 朝外法线 */
  normal: Pt;
  target: DoorTarget;
  /** 门到目标通行空间的距离（米），用于验证"门真的接得上" */
  reachM: number;
}

export interface PlacedBuilding {
  id: string;
  /** 建筑占地（矩形，可能被边界裁出斜边） */
  surface: PlanSurface;
  center: Pt;
  /** 长轴方向（弧度） */
  ang: number;
  /** 面宽（沿 ang）与进深（垂直 ang），米 */
  widthM: number;
  depthM: number;
  kind: BuildingKind;
  door: BuildingDoor | null;
  /** 实际占地 / 目标包络面积（1 = 完整放下） */
  fill: number;
  note: string;
}

/** 空地类型。`green` 只是其中一种，且必须带 purpose */
export type SpaceKind = 'front_yard' | 'courtyard' | 'loading' | 'parking' | 'lane' | 'green' | 'setback';

export interface SpacePatch {
  kind: SpaceKind;
  surface: PlanSurface;
  areaM2: number;
  /** 这块地是干什么用的（人话）。绿地尤其必须写清楚 */
  purpose: string;
}

/** 布局指标：全部是米 / 平方米 / 比例，禁止用单一阈值替代设计判断 */
export interface LayoutMetrics {
  usableM2: number;
  /** 扣除预留交通走廊后的有效布局区 */
  effectiveM2: number;
  buildingM2: number;
  /** 建筑占地 / 有效布局区 */
  coverage: number;
  /** 建筑中心到"可用空间核心"的偏移（米）—— 越小越贴核心 */
  centerOffsetM: number;
  /** 建筑长轴与临街方向的夹角（0~45°） */
  orientationDevDeg: number;
  /** 建筑占地 / 目标包络面积（< 1 说明被迫缩小） */
  envelopeFill: number;
  /** 前场深度 : 后场深度（只有单栋时有意义，组团为 null） */
  frontBackRatio: number | null;
  greenM2: number;
  greenShare: number;
  /** 最大一块无功能空地的占比（用于抓"一大片空地啥也没干"） */
  largestEmptyShare: number;
}

export type LayoutNoteCode =
  | 'no-usable'
  | 'no-slot-fit'
  | 'shrink'
  | 'reject'
  | 'corridor'
  | 'lane-reused'
  | 'door-ok'
  | 'door-fail'
  | 'courtyard'
  | 'loading'
  | 'green'
  | 'compound'
  | 'fixed-building'
  | 'area-mismatch'
  | 'overlap'
  | 'outside'
  | 'cover-low'
  | 'empty-large';

export interface LayoutNote {
  code: LayoutNoteCode;
  severity: 'info' | 'warn' | 'error';
  message: string;
  at?: Pt;
}

/** 一块地的完整布局结果 */
export interface ParcelLayout {
  parcelId: string;
  role: PieceRole;
  /** 候选自带的可建区（只读） */
  usable: PlanSurface;
  /** 扣除交通走廊后的有效布局区 */
  effective: PlanSurface;
  /** 可用空间核心（锚点）：clearance field 的最大值点，不是多边形质心 */
  core: import('../../../core/geom').Pt;
  buildings: PlacedBuilding[];
  spaces: SpacePatch[];
  metrics: LayoutMetrics;
  notes: LayoutNote[];
  /** 这块地是否成功产出布局（false 时 reasons 里必有原因） */
  ok: boolean;
  reasons: string[];
}

/** 布局参数：全部米 / 平方米 */
export interface LayoutParams {
  /** 商业沿街条进深（SHOP_DEPTH_M = 22） */
  shopDepthM: number;
  /** 住宅/办公条进深 */
  barDepthM: number;
  /** 工业厂房进深（subdivide.ts：厂房要 55 m） */
  hallDepthM: number;
  /** 院落最小面宽 / 进深 */
  courtMinWM: number;
  courtMinDM: number;
  /** 前场最小深度（建筑到红线） */
  frontYardM: number;
  /** 建筑之间最小净距 */
  gapM: number;
  /** 内部通道宽 */
  corridorM: number;
  /** 建筑最小面宽（低于它就不是一栋楼） */
  minBarWidthM: number;
  /** 包络填充率下限：低于它判定"这块地装不下这个程序" */
  minEnvelopeFill: number;
  /** 覆盖率上限（超过就是铺满，没有院子） */
  maxCoverage: number;
  /** 搜索网格步长 */
  gridM: number;
}

export interface LayoutValidation {
  ok: boolean;
  errors: LayoutNote[];
  warnings: LayoutNote[];
  /** 建筑越出有效布局区的面积（m²） */
  outsideM2: number;
  /** 建筑之间非法重叠（m²） */
  overlapM2: number;
  /** 建筑压到固定建筑的面积（m²） */
  fixedTouchedM2: number;
  /** 门没有接到合法通行的个数 */
  doorFailures: number;
  /** 面积对账误差：建筑 + 通道 + 空地 vs 可建区（m²） */
  reconciliationM2: number;
}
