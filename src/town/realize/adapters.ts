// Planning Realization · Ground + Building + Access + Circulation 四类 Adapter
//
// 每个 Adapter 都是**纯转译**：读 Candidate 的几何，原样写成 Scene 特征。
// 不许出现 "如果面积小于 x 就合并" / "如果朝向不对就转 90°" 这类判断 ——
// 那是规划决策，Planner 已经做完了。
//
// Parking 的 R4（接 parking.ts 排车位）留了开关：第一版只把 ParkingRequest.region
// 铺成沥青面，不排车位（`ctx.solveParking` 默认 false）。

import { Pt } from '../../core/geom';
import type { SurfaceFeature, SolidFeature, PathFeature } from '../../scene/types';
import type { SitePlanCandidate } from '../planning/core/candidate';
import { surfaceArea, surfaceSubtract, surfaceIntersect, geometryFailures, type PlanSurface } from '../planning/core/surface';
import { resolveGroundOwnership } from './ground-ownership';
import { subdivideGreen } from '../greenspace';
import {
  GROUND_MATERIAL,
  GROUND_LIFT,
  ROLE_TO_KIND,
  ROLE_MATERIAL,
  TYPOLOGY_APPEARANCE,
  ACCESS_WIDTH_M,
  type RealizationContext,
  type RealizerPart,
} from './contract';

const U = (m: number) => m / 7;

/**
 * R1 · Ground Program → Surface
 *
 * 先过 `resolveGroundOwnership()`：Ground Region 允许语义重叠（车道压前院是正常画法），
 * 但最终地表只能有一层。切割后每个点只有一个所有者，面积之和才等于并集。
 */
export function realizeGround(
  c: SitePlanCandidate,
  ctx: RealizationContext,
  part: RealizerPart,
  roadCorridors: PlanSurface[] = []
): void {
  const base = ctx.groundY ?? 0.012;
  const owned = resolveGroundOwnership(c.ground);
  if (owned.trimmed > 0 || owned.consumed > 0) {
    part.warnings.push({
      code: 'GROUND_OWNERSHIP_RESOLVED',
      message: `地面切割：${owned.trimmed} 块被裁小、${owned.consumed} 块被完全覆盖`,
    });
  }
  // R5.7：道路 > 地面。先把被道路走廊压到的部分扣掉，避免"前院草地压在路面上"
  // 只对**真的与道路相交**的面做减法：不相交的保持原样，
  // 否则每次 difference 都可能把洞（courtyard / 保留地）丢掉一次
  const pieces =
    roadCorridors.length > 0
      ? owned.regions.flatMap((g) => {
          const hit = surfaceIntersect([g.surface], roadCorridors).some((p) => surfaceArea(p) > 0.01);
          if (!hit) return [g];
          const rest = surfaceSubtract([g.surface], roadCorridors)
            .filter((p) => surfaceArea(p) > 0.02)
            .map((p) => ({ ...g, surface: p, area: surfaceArea(p) }));
          // 带洞的面被切之后洞经常保不住（polygon-clipping 的拓扑退化），留痕待修
          if (g.surface.holes.length > 0 && rest.every((p) => p.surface.holes.length === 0)) {
            part.warnings.push({
              code: 'GROUND_HOLE_LOST',
              message: `${g.program} 的洞在与道路求差时丢失（待修 topology）`,
            });
          }
          return rest;
        })
      : owned.regions;

  // 红线退线带：红线以内、可建区以外那一圈。
  //
  // 不铺的话这一圈在场景里只有底板色 —— 全城审计（D1）实测它占城内面积 8.4%，
  // 是最大的一块"有颜色但没有功能语义"的区域。它在真实总图上有明确身份
  // （红线内的绿化/铺装退线），所以在这里补一层**功能面**，而不是靠底板遮。
  if (ctx.parcel && ctx.buildable) {
    const fail0 = geometryFailures.subtract;
    const outside = surfaceSubtract([ctx.parcel], [ctx.buildable]);
    if (geometryFailures.subtract === fail0) {
      const parcelA = surfaceArea(ctx.parcel);
      let k = 0;
      for (const p of outside) {
        const a = surfaceArea(p);
        // 面积 ≥ 95% parcel = 布尔退化成了"原样返回"，宁可不铺
        if (a < 0.6 || a > parcelA * 0.95) continue;
        part.surfaces.push({
          name: `${c.id}_setback_${k++}`,
          group: ctx.group,
          ring: p.outer,
          mat: GROUND_MATERIAL[ctx.setbackProgram ?? 'landscape'] ?? 'grass',
          y: base - 0.0002,
        role: 'overlay',
          ...(p.holes.length > 0 ? { holes: p.holes } : {}),
        });
      }
    }
  }

  pieces.forEach((g, i) => {
    // 大块绿地做**分块规划**：园路把它切成 20~40 m 的块（草坪 / 草甸 / 密林）。
    // 整片刷一个 grassDark 是"没有规划"的读法 —— 详见 landscape.ts。
    const green = subdivideGreen(g.surface, g.program);
    if (green) {
      const lift = GROUND_LIFT[g.program] ?? 0;
      green.paths.forEach((s, k) => {
        part.surfaces.push({
          name: `${c.id}_${g.program}_${i}_path_${k}`,
          group: ctx.group,
          ring: s.outer,
          mat: 'gravel',
          y: base + lift + 0.0002,
          ...(s.holes.length > 0 ? { holes: s.holes } : {}),
        });
      });
      green.plots.forEach((p, k) => {
        part.surfaces.push({
          name: `${c.id}_${g.program}_${i}_${p.kind}_${k}`,
          group: ctx.group,
          ring: p.surface.outer,
          mat: p.mat,
          y: base + lift + 0.0004,
          ...(p.surface.holes.length > 0 ? { holes: p.surface.holes } : {}),
        });
      });
      return;
    }
    const mat = GROUND_MATERIAL[g.program] ?? 'gravel';
    part.surfaces.push({
      name: `${c.id}_${g.program}_${i}`,
      group: ctx.group,
      ring: g.surface.outer,
      mat,
      y: base + (GROUND_LIFT[g.program] ?? 0),
      ...(g.surface.holes.length > 0 ? { holes: g.surface.holes } : {}),
    });
  });
}

/** R2 · PlannedBuilding → Solid（footprint 原样，只补材质与 kind） */
export function realizeBuildings(c: SitePlanCandidate, ctx: RealizationContext, part: RealizerPart): void {
  // 外观表：优先用 typology 的（住宅暖色 / 商业幕墙 / 工业面板），
  // 没有就退回 role 的默认。同一个 typology 内按序号确定性交替，
  // 让相邻两栋不完全同色 —— 全城一个色调会读成"素白大盒子"。
  const look = ctx.typology ? TYPOLOGY_APPEARANCE[ctx.typology] : undefined;
  c.buildings.forEach((b, i) => {
    const kind = ROLE_TO_KIND[b.role] ?? 'podium';
    const mat =
      ctx.overrides?.[b.role] ??
      (look ? look.walls[i % look.walls.length] : undefined) ??
      ROLE_MATERIAL[b.role] ??
      ROLE_MATERIAL.podium;
    part.solids.push({
      name: `${c.id}_bld_${i}_${b.role}`,
      group: ctx.group,
      ring: b.footprint.outer,
      y0: 0.05,
      h: b.height,
      wallMat: mat.wall,
      roofMat: mat.roof,
      kind,
    });
    // 洞：PlannedBuilding.footprint 也可能带洞（例如围合式 L 形带内院）
    if (b.footprint.holes.length > 0) {
      part.warnings.push({
        code: 'BUILDING_HOLE_IGNORED',
        message: `建筑 ${i} 的轮廓带洞，Solid 目前不支持洞，已按外环生成`,
        target: `${c.id}_bld_${i}`,
      });
    }
  });
}

/** R3 · PlannedAccess → 短带（gate / walkway / apron） */
export function realizeAccess(c: SitePlanCandidate, ctx: RealizationContext, part: RealizerPart): void {
  // **开口不再落地成几何**。
  //
  // 原来每个 access 都在开口处铺一条 6~9 m 宽的带子（paver/asphalt），从地块
  // 边缘往街里伸。结果就是用户看到的那颗"米色的胶囊"死死压在车行道上 ——
  // 既不是真实的车道，也不是人行横道，只是把数据里的一个点画成了一个面。
  //
  // 开口是**语义信息**（这个地块在这里可以进出），不是几何。真正该画的东西
  // 是"引道"（`driveway`，出入口那一段实实在在的铺装），那已经由道路侧和
  // Ground Program 各自表达了。所以这里只保留数据，不产出几何。
  void c;
  void ctx;
  void part;
}

/** R5（轻量版） · circulation → 场景路径（还没有接 road/system，先成面） */
export function realizeCirculation(c: SitePlanCandidate, ctx: RealizationContext, part: RealizerPart): void {
  const base = ctx.groundY ?? 0.012;
  // R1.3：求解器出的中心线**已经由 realizeRoads 铺成路面**，这里不再画一条
  // PathFeature —— 否则同一段路会被表达两次（一块面 + 一条线），审计会把
  // 那条线与路面判成重复表达。
  const list = c.circulation.filter((p) => p.source !== 'solver');
  list.forEach((p, i) => {
    part.paths.push({
      name: `${c.id}_circ_${p.role}_${i}`,
      group: ctx.group,
      pts: p.pts,
      width: p.width,
      mat: p.role === 'truck' ? 'asphaltLot' : 'asphalt',
      y: base + 0.0006,
    });
  });
}

/** R4（第一版） · ParkingRequest.region → 沥青面；车位留给 parking.ts */
export function realizeParkingRequests(
  c: SitePlanCandidate,
  ctx: RealizationContext,
  part: RealizerPart
): void {
  const base = ctx.groundY ?? 0.012;
  c.parkingRequests.forEach((r, i) => {
    part.surfaces.push({
      name: `${c.id}_parkreq_${r.role}_${i}`,
      group: ctx.group,
      ring: r.region.outer,
      // 停车请求面 = **车位底**（深灰沥青），通道 / 模块步道 / 树岛叠在上面。
      //
      // 读法按用户给的参考图：车位是深的、通道是浅的，白线画在深底上才跳得出来。
      // 早先"浅车位 + 深通道"是照总图（纸面）的读法，但那是**黑白线稿**的规矩；
      // 在 3D 和带底色的平面图里，浅底 + 白线等于什么都没有 —— 整片场地糊成一块。
      mat: 'asphaltLot',
      y: base + 0.0005,
        role: 'overlay',
      ...(r.region.holes.length > 0 ? { holes: r.region.holes } : {}),
    });
    if (ctx.solveParking) {
      // 留位：这里将来调用 parking.ts 的 solveParking(region, {obstacles, entry, dims})
      part.warnings.push({
        code: 'PARKING_NOT_SOLVED',
        message: `车位排布尚未接入 parking.ts（区域已铺好，${(r.region.outer.length)} 点）`,
        target: `${c.id}_parkreq_${r.role}_${i}`,
      });
    }
  });
}

/** 校验：Realizer 不许改几何（R6 parity 的第一道自检） */
export function assertNoGeometryDrift(
  c: SitePlanCandidate,
  part: RealizerPart
): { code: string; message: string }[] {
  const out: { code: string; message: string }[] = [];
  const solids = part.solids.length;
  if (solids !== c.buildings.length) {
    out.push({ code: 'BUILDING_COUNT_MISMATCH', message: `${solids} vs ${c.buildings.length}` });
  }
  // 逐个比对顶点数（原样转译时必然相同）
  for (let i = 0; i < Math.min(solids, c.buildings.length); i++) {
    const a = part.solids[i].ring.length;
    const b = c.buildings[i].footprint.outer.length;
    if (a !== b) out.push({ code: 'BUILDING_RING_CHANGED', message: `#${i} ${a} vs ${b} 点` });
  }
  return out;
}

/** 供 parity 测试用：把 surface 也当作几何核对 */
export function collectGeom(part: RealizerPart): {
  surfaces: SurfaceFeature[];
  solids: SolidFeature[];
  paths: PathFeature[];
} {
  return { surfaces: part.surfaces, solids: part.solids, paths: part.paths };
}
