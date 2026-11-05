// F2 · 分割上下文与默认参数
//
// 两条入口：
//   · `contextFromSite()`  —— 接真实 SiteContext（Planner 已有产出）
//   · `makeContext()`      —— 接 Golden 几何样本（测试与报告用）
// 两者产出**同一个** SubdivisionContext，策略只认这一个类型。

import { Pt } from '../../../core/geom';
import type { SiteContext, SiteRoadEdge, SiteTypology } from '../core/types';
import { SUBDIVIDE } from '../adapters/subdivide';
import { surface, surfaceArea, type PlanSurface } from '../core/surface';
import type { SubdivisionContext, SubdivisionMode, SubdivisionParams } from './types';

/** 合成一条道路边（Golden 样本与测试用；真实链路走 road/system） */
export function makeRoadEdge(
  key: string,
  a: Pt,
  b: Pt,
  cls: SiteRoadEdge['cls'] = 'local',
  extra: Partial<SiteRoadEdge> = {}
): SiteRoadEdge {
  return {
    key,
    a,
    b,
    len: Pt.distance(a, b),
    cls,
    carriageSide: cls === 'arterial' ? 1.4 : cls === 'collector' ? 0.9 : 0.45,
    sidewalk: cls === 'local' ? 0 : 0.18,
    median: cls === 'arterial' ? 0.12 : 0,
    ...extra,
  };
}

export interface MakeContextOpts {
  id?: string;
  parentId?: string;
  typology?: SiteTypology;
  mode?: SubdivisionMode;
  buildable?: PlanSurface;
  roadEdges?: SiteRoadEdge[];
  fixedBuildings?: PlanSurface[];
  existingAccess?: SubdivisionContext['existingAccess'];
  seed?: number;
}

/**
 * 面的入口统一过一遍 `surface()`（= cleanRing）。
 *
 * 这不是洁癖：真实数据里既有建筑的轮廓常常带相邻重复点，polygon-clipping 会直接抛
 * "Input geometry is not a valid Polygon"，而我们所有布尔都是 `catch → 返回 []`。
 * 于是一栋 450 m² 的楼对所有地块的"重叠面积"都算成 0 —— 归属判断落空，
 * 验证层报"该建筑不在任何地块内"（实测 C01 第 12 栋）。
 */
function normSurface(s: PlanSurface): PlanSurface {
  return surface(s.outer, s.holes);
}

/** 从一块边界 + 一组真实道路边建上下文 */
export function makeContext(boundary: PlanSurface, opts: MakeContextOpts = {}): SubdivisionContext {
  const fixed = (opts.fixedBuildings ?? []).map(normSurface);
  return {
    id: opts.id ?? 'sample',
    parentId: opts.parentId ?? opts.id ?? 'sample',
    typology: opts.typology ?? 'generic',
    mode: opts.mode ?? (fixed.length > 0 ? 'fixed_buildings' : 'vacant'),
    boundary: normSurface(boundary),
    buildable: opts.buildable ? normSurface(opts.buildable) : normSurface(boundary),
    roadEdges: opts.roadEdges ?? [],
    fixedBuildings: fixed,
    existingAccess: opts.existingAccess,
    seed: opts.seed ?? 682063530,
    notes: [],
  };
}

/**
 * 接真实 SiteContext。
 *
 * 关键取舍：`parcel` 是红线、`buildableArea` 是退线后 —— 两者都保留。
 * 旧 `subdivideByFrontage` 直接在 `buildableArea` 上切，切出来的地块
 * **不再贴着街**，于是它得靠 `edgesForPiece` 猜临街、猜不到就编一条巷。
 * 这里在红线上切，临街关系天然成立。
 */
export function contextFromSite(site: SiteContext, opts: { seed?: number; buildings?: PlanSurface[] } = {}): SubdivisionContext {
  const edges: SiteRoadEdge[] = site.roadEdges.slice();
  const buildings = (opts.buildings ?? []).map(normSurface);
  return {
    id: site.parcelId,
    parentId: site.parcelId,
    typology: site.typology,
    mode: buildings.length > 0 ? 'fixed_buildings' : 'vacant',
    boundary: normSurface(site.parcel),
    buildable: normSurface(site.buildableArea),
    roadEdges: edges,
    fixedBuildings: buildings,
    seed: opts.seed ?? 682063530,
    notes: site.notes.slice(),
  };
}

/**
 * 各 typology 的默认参数。
 *
 * 面宽 / 进深不是新拍的数：直接复用 `adapters/subdivide.ts` 的 `SUBDIVIDE` 表
 * （那张表本身就带"为什么不是规范下限"的论证）。这里只补分割器需要的
 * 停止条件与碎块阈值。
 */
export function defaultParams(typology: SiteTypology, over: Partial<SubdivisionParams> = {}): SubdivisionParams {
  const rule = SUBDIVIDE[typology as string] ?? { frontageM: 24, maxDepthM: 40 };
  const base: SubdivisionParams = {
    targetAreaM2: rule.frontageM * rule.maxDepthM,
    frontageM: rule.frontageM,
    depthM: rule.maxDepthM,
    minAreaM2: 200,
    minWidthM: 12.5,
    maxAspect: 3,
    alleyM: 6,
    maxRecursion: 4,
    cornerBonusM: 4,
    jitter: 0.05,
    rearPolicy: 'compound',
  };
  return { ...base, ...over };
}

/** 场地面积（m²） */
export function siteAreaM2(s: PlanSurface): number {
  return surfaceArea(s) * 49;
}
