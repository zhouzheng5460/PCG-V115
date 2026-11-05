// Planning Realization · 唯一入口
//
//   SitePlanCandidate → realizeSitePlan() → Scene 特征
//
// 这个文件**不产生任何规划决策**：顺序固定（地面 → 建筑 → 开口 → 停车 → 循环），
// 每步都是纯转译。要看"Planner 说的和场景里的是不是一回事"，走 R6 的 parity 检查。

import type { SitePlanCandidate } from '../planning/core/candidate';
import type { RealizationContext, RealizedSitePlan } from './contract';
import { emptyPart } from './contract';
import {
  realizeAccess,
  realizeBuildings,
  realizeCirculation,
  realizeGround,
  realizeParkingRequests,
  assertNoGeometryDrift,
} from './adapters';
import { realizeParking } from './parking';
import { surfaceUnion } from '../planning/core/surface';
import { realizeRoads } from './road';
import { realizeScenery } from './scenery';


/** 道路的裁剪体：所有 Ground 的并集（地块内部的铺装范围），避免路探出红线 */
function candidateGroundClip(c: SitePlanCandidate) {
  const merged = surfaceUnion(c.ground.map((g) => g.surface));
  if (merged.length === 0) return undefined;
  // 取面积最大的一块当裁剪体（多块时路本来也只在一侧）
  return merged.reduce((a, b) => (a.outer.length >= b.outer.length ? a : b));
}

export function realizeSitePlan(candidate: SitePlanCandidate, ctx: RealizationContext): RealizedSitePlan {
  const part = emptyPart(candidate.id);

  // 顺序：先算道路走廊（要拿来从地面里扣），再铺地面
  const roadPart = emptyPart(candidate.id);
  // 裁剪体：solver 出的中心线是"能走的地方"，常常落在退线带里 —— 而 ground 并集
  // 只覆盖功能面，拿它当裁剪体等于把退线带里的路整段删掉。所以 solver 模式裁红线。
  const clip = ctx.circulationMode === 'solver' ? ctx.parcel : candidateGroundClip(candidate);
  const { stats: roadStats, corridors } = realizeRoads(candidate, ctx, roadPart, { clip });

  realizeGround(candidate, ctx, part, corridors);
  part.surfaces.push(...roadPart.surfaces);
  part.warnings.push(...roadPart.warnings);

  realizeBuildings(candidate, ctx, part);
  realizeAccess(candidate, ctx, part);
  realizeParkingRequests(candidate, ctx, part);

  // R4：真正排车位。
  // 障碍 = 建筑 + **明确不可停车**的地面（庭院 / 装卸坪 / 货场 / 落客 / 设备场 / 院子 / 绿地）。
  // 不把 landscape / service / pedestrian 算进去：它们是软边界（车位压上去也不违规），
  // 全算会把 parking region 减到几乎没剩 —— 那是 Planner 侧 Ground 重叠的问题，
  // 应该由 ownership 切割解决，不该靠 Solver 兜。
  const HARD_OBSTACLES = new Set([
    'courtyard', 'amenity', 'loading_apron', 'truck_court', 'dropoff',
    'mechanical_yard', 'electrical_yard', 'utility_yard', 'security_buffer',
    'front_yard', 'rear_yard', 'community_green',
  ]);
  const obstacles = [
    ...candidate.buildings.map((b) => b.footprint),
    ...candidate.ground.filter((g) => HARD_OBSTACLES.has(g.program)).map((g) => g.surface),
    // solver 的路先扣掉再排车位：车位不许压在路面上。
    // legacy 模式保持原行为（那条路上本来就没排过车位，动了只会让老地块漂）。
    ...(ctx.circulationMode === 'solver' ? corridors : []),
  ];
  const parkingStats = realizeParking(candidate, ctx, part, obstacles);

  realizeCirculation(candidate, ctx, part);

  // R8 配景：把 Planner 标出来的绿地类 Ground Program 翻译成树。
  // 放在最后 —— 这样才能同时避开建筑、车位与货场。
  realizeScenery(candidate, part, ctx.group, ctx.scenery !== false);

  // Realizer 自检：几何不许被改动
  const drift = assertNoGeometryDrift(candidate, part);
  for (const d of drift) part.warnings.push({ code: d.code, message: d.message });

  return {
    candidateId: candidate.id,
    surfaces: part.surfaces,
    solids: part.solids,
    paths: part.paths,
    props: part.props,
    buildingIds: part.solids.map((s) => s.name),
    groundIds: part.surfaces.map((s) => s.name),
    roadIds: candidate.circulation.map((_, i) => `${candidate.id}_circ_${i}`),
    parkingIds: candidate.parkingRequests.map((_, i) => `${candidate.id}_parkreq_${i}`),
    warnings: part.warnings,
    parkingStats,
    roadStats,
  };
}

/** 把多块地的 Realization 合成一个 Scene（Phase 3 的批量入口） */
export function realizeSitePlans(
  candidates: SitePlanCandidate[],
  ctx: RealizationContext
): { surfaces: RealizedSitePlan['surfaces']; solids: RealizedSitePlan['solids']; paths: RealizedSitePlan['paths']; plans: RealizedSitePlan[] } {
  const plans = candidates.map((c) => realizeSitePlan(c, ctx));
  return {
    surfaces: plans.flatMap((p) => p.surfaces),
    solids: plans.flatMap((p) => p.solids),
    paths: plans.flatMap((p) => p.paths),
    plans,
  };
}
