// S1 · 骨架落地：PlanSpec（布局意图）→ SitePlanCandidate
//
// 这一层只做**几何与归属**，不做任何设计判断：
//   · 车道裁到**红线**（不是可建区）；
//   · 建筑 / 停车 / 前场 / 服务 / 绿带裁到可建区；
//   · 按"车道 > 建筑 > 停车 > 前场 > 服务 > 绿带"的顺序互相扣除，
//     于是落到 `ground` 里时已经互不重叠（不是靠 Realizer 的 ownership 兜）；
//   · 剩下的空白交回 `claimResidual`（已有工具，不另写一套）。
//
// 车道裁红线的理由：可建区已经按退线内缩了 5~14 m。裁到可建区，
// 车道就停在退线带里、离街还有十来米 —— 那正是 R1.5 里"路面离最近街口
// 40 m"的成因之一。裁到红线，车道一定压到街上，A* 只剩"补齐断口"的活。

import { Pt } from '../../../core/geom';
import {
  surface,
  surfaceArea,
  surfaceIntersect,
  surfaceSubtract,
  type PlanSurface,
} from '../core/surface';
import type { SiteContext, SiteTypology } from '../core/types';
import type {
  GroundProgram,
  PlannedAccess,
  PlannedBuilding,
  PlannedPath,
  PlannedRegion,
  ParkingRequest,
  SitePlanCandidate,
} from '../core/candidate';
import { siteFrame } from '../archetypes/shared/frame';
import { claimResidual } from '../archetypes/shared/claim';
import { U, type PlanSpec, type Rect } from './spec';

/** 小于这个面积（世界单位²）的碎块丢掉：画出来只是脏斑。≈ 20 m² */
const MIN_PIECE = 20 / 49;

/** 矩形 → 世界面，裁到给定面，返回最大一块 */
function cutIn(
  at: (lu: number, lv: number) => Pt,
  clip: PlanSurface,
  r: Rect,
  minArea = MIN_PIECE
): PlanSurface | null {
  if (r.u1 - r.u0 < U(1.5) || r.v1 - r.v0 < U(1.5)) return null;
  const rect = surface([at(r.u0, r.v0), at(r.u1, r.v0), at(r.u1, r.v1), at(r.u0, r.v1)]);
  let parts: PlanSurface[];
  try {
    parts = surfaceIntersect([rect], [clip]);
  } catch {
    return null;
  }
  if (parts.length === 0) return null;
  const best = parts.reduce((a, b) => (surfaceArea(a) >= surfaceArea(b) ? a : b));
  return surfaceArea(best) > minArea ? best : null;
}

/** 从若干面里减掉已经占用的，保留够大的块 */
function carve(list: PlanSurface[], taken: PlanSurface[]): PlanSurface[] {
  if (list.length === 0 || taken.length === 0) return list;
  const out: PlanSurface[] = [];
  for (const s of list) {
    let rest = [s];
    for (const t of taken) {
      const next: PlanSurface[] = [];
      for (const p of rest) {
        try {
          next.push(...surfaceSubtract([p], [t]));
        } catch {
          next.push(p);
        }
      }
      rest = next;
      if (rest.length === 0) break;
    }
    out.push(...rest.filter((p) => surfaceArea(p) > MIN_PIECE));
  }
  return out;
}

const FRONT_DIR: Record<string, 'u-' | 'u+' | 'v-' | 'v+'> = {};

/**
 * 把一套骨架落成候选。
 *
 * 返回 null 的条件只有"几何上根本立不住"：
 *   · 车道一片都切不出来；
 *   · 建筑少于 2 栋。
 * 其余（覆盖率偏低、绿地偏碎）都留到度量里说，不在这一层偷偷丢掉候选。
 */
export function emitPlan(ctx: SiteContext, spec: PlanSpec): SitePlanCandidate | null {
  const f = siteFrame(ctx);
  if (!f) return null;
  const at = f.at;

  // ---- ① 车道（裁红线）
  const laneSurfaces: PlanSurface[] = [];
  for (const r of spec.lanes) {
    const s = cutIn(at, ctx.parcel, r, U(6) * U(2));
    if (s) laneSurfaces.push(s);
  }
  if (laneSurfaces.length === 0) return null;

  const ground: PlannedRegion[] = [];
  const push = (program: GroundProgram, s: PlanSurface | null, note?: string) => {
    if (!s) return;
    ground.push({ program, surface: s, area: surfaceArea(s), ...(note ? { notes: [note] } : {}) });
  };
  for (const s of laneSurfaces) push('driveway', s, `车行主通道 ${spec.laneWM.toFixed(0)} m`);

  // ---- ② 建筑（裁可建区，并从车道里让开）
  const buildings: PlannedBuilding[] = [];
  for (const b of spec.buildings) {
    const s = cutIn(at, ctx.buildableArea, b.r);
    if (!s) continue;
    // 构造上已经避开车道，这里再扣一次是保险：斜边地块上矩形可能被切得变形，
    // 变形后的一角有可能探进车道带
    const clean = carve([s], laneSurfaces);
    for (const piece of clean) {
      if (surfaceArea(piece) < U(4) * U(4)) continue;
      const front =
        b.front === 'v-'
          ? new Pt(-f.vDir.x, -f.vDir.y)
          : b.front === 'v+'
            ? new Pt(f.vDir.x, f.vDir.y)
            : b.front === 'u-'
              ? new Pt(-f.uDir.x, -f.uDir.y)
              : b.front === 'u+'
                ? new Pt(f.uDir.x, f.uDir.y)
                : undefined;
      buildings.push({
        role: b.role,
        footprint: piece,
        height: U(b.hM),
        ...(front ? { frontSide: front } : {}),
        // 厂房的装卸面永远朝场地内部（货场那边）。不填这一项，
        // `industrialDiagnostics` 的"装卸面朝向"直接读 0，typologyFit 掉一半。
        ...(b.role === 'warehouse' ? { loadingSide: new Pt(f.vDir.x, f.vDir.y) } : {}),
        notes: [b.note],
      });
    }
  }
  // 工业场地一栋厂房就是完整布局，不能按"至少两栋"判死；住宅/商业才要求成组
  const minBld = ctx.typology === 'industrial' ? 1 : 2;
  if (buildings.length < minBld) return null;
  void FRONT_DIR;

  // ---- ③ 停车 / 前场 / 服务 / 绿带（依次扣除）
  const placed: PlanSurface[] = [...laneSurfaces, ...buildings.map((b) => b.footprint)];
  const parkSurfaces: PlanSurface[] = [];
  // 工业的停车要落 `employee_parking`：它既是白名单里的程序，
  // 也是 `industrialDiagnostics` 认"员工停车"的唯一依据。落成 `parking`
  // 会同时踩两件事 —— 白名单违规 + parkingQuality 恒为 0。
  const parkProgram: GroundProgram = ctx.typology === 'industrial' ? 'employee_parking' : 'parking';
  for (const p of spec.parking) {
    const s = cutIn(at, ctx.buildableArea, p.r);
    if (!s) continue;
    for (const piece of carve([s], placed)) {
      parkSurfaces.push(piece);
      push(parkProgram, piece, p.note);
      placed.push(piece);
    }
  }

  for (const p of spec.courtyard) {
    const s2 = cutIn(at, ctx.buildableArea, p.r);
    if (!s2) continue;
    for (const piece of carve([s2], placed)) {
      push('courtyard', piece, p.note);
      placed.push(piece);
    }
  }

  for (const p of spec.walk) {
    const s2 = cutIn(at, ctx.buildableArea, p.r);
    if (!s2) continue;
    for (const piece of carve([s2], placed)) {
      push('pedestrian', piece, p.note);
      placed.push(piece);
    }
  }

  for (const p of spec.forecourt) {
    const s = cutIn(at, ctx.buildableArea, p.r);
    if (!s) continue;
    for (const piece of carve([s], placed)) {
      push('entrance_forecourt', piece, p.note);
      placed.push(piece);
    }
  }

  for (const p of spec.service) {
    const s = cutIn(at, ctx.buildableArea, p.r);
    if (!s) continue;
    // 工业的装卸/货场有专属 program，其余类型落到 service
    const prog: GroundProgram = ctx.typology === 'industrial' ? industrialProgram(p.note) : 'service';
    for (const piece of carve([s], placed)) {
      push(prog, piece, p.note);
      placed.push(piece);
    }
  }

  for (const p of spec.green) {
    const s = cutIn(at, ctx.buildableArea, p.r);
    if (!s) continue;
    const prog: GroundProgram = ctx.typology === 'industrial' ? 'landscape_buffer' : 'landscape';
    for (const piece of carve([s], placed)) {
      push(prog, piece, p.note);
      placed.push(piece);
    }
  }

  // ---- ④ 残地认领（已有工具）
  claimResidual(ctx, ctx.typology, [...ground.map((g) => g.surface), ...buildings.map((b) => b.footprint)], (program, s2, note) => {
    if (s2) ground.push({ program, surface: s2, area: surfaceArea(s2), ...(note ? { notes: [note] } : {}) });
  });

  // ---- ⑤ 出入口：点已经在车道中心上，这里只做去重与排序
  const access: PlannedAccess[] = [];
  const seen = new Set<string>();
  for (const g of spec.gates) {
    const k = `${g.kind}:${g.at.x.toFixed(2)},${g.at.y.toFixed(2)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    access.push({
      kind: g.kind,
      at: g.at,
      normal: g.normal,
      role: g.kind === 'pedestrian' ? 'pedestrian' : g.kind === 'truck' ? 'truck' : 'car',
      frontage: g.frontage ?? 'primary',
    });
  }
  if (access.length === 0) return null;

  // ---- ⑥ 停车需求：区域就是刚才铺出来的停车面，入口取**它与车道相接的那一点**
  //
  // 不能用车行门当 `preferredEntry`：门在临街上，求解器会认为"停车场入口在街上"，
  // 于是从街边到停车场中心自己铺一条 83 m 的新路穿进停车区（实测 retail 249 m²，
  // 与车道重叠 0 m² —— 它不是重复，是真的多修了一条）。改成"车道接驳点"之后，
  // 求解器发现目标本来就在网络上，只做验证，不再新增路面。
  const parkingRequests: ParkingRequest[] = [];
  for (const p of parkSurfaces) {
    if (surfaceArea(p) < U(8) * U(8)) continue;
    const entry = nearestPointOnLanes(p, laneSurfaces) ?? (access.find((a) => a.kind === 'vehicle')?.at ?? access[0].at);
    parkingRequests.push({
      role: spec.parkingRole,
      region: p,
      preferredEntry: entry,
      targetDensity: spec.parkingRole === 'visitor' ? 'high' : 'medium',
      notes: ['S1 骨架：停车区贴车行主通道，入口取车道接驳点'],
    });
  }

  // ---- ⑦ 车道**不进** circulation
  //
  // 它是 `ground` 里的 `driveway`（优先级 100 的 overlay，由 realizeGround 画一次），
  // 同时也被求解器的 `seedExistingRoads` 当作"既有可通行道路"并进初始网络。
  // 再往 circulation 里塞一份，`realizeRoads` 会照着中心线再画一遍 ——
  // 同一段路在 SceneIR 里出现两次，面积翻倍（实测 retail 从 542 涨到 883 m²）。
  const circulation: PlannedPath[] = [];

  return {
    id: spec.id,
    typology: ctx.typology,
    archetype: `SK_${spec.topology.toUpperCase()}`,
    buildings,
    ground,
    access,
    parkingRequests,
    circulation,
    notes: [`S1：${spec.label}`, ...spec.intent],
  };
}

/** 停车面**贴着车道的那个点**：取停车环上离车道最近的一个采样点 */
function nearestPointOnLanes(park: PlanSurface, lanes: PlanSurface[]): Pt | null {
  if (lanes.length === 0) return null;
  let best: Pt | null = null;
  let bestD = Infinity;
  for (const lane of lanes) {
    for (let i = 0; i < park.outer.length; i++) {
      const a = park.outer[i];
      const b = park.outer[(i + 1) % park.outer.length];
      const n = Math.max(1, Math.ceil(Pt.distance(a, b) / 0.5));
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) / n;
        const q = new Pt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
        let d = Infinity;
        for (let j = 0; j < lane.outer.length; j++) {
          const c = lane.outer[j];
          const e = lane.outer[(j + 1) % lane.outer.length];
          const dx = e.x - c.x;
          const dy = e.y - c.y;
          const L = dx * dx + dy * dy;
          let u = L > 1e-12 ? ((q.x - c.x) * dx + (q.y - c.y) * dy) / L : 0;
          u = Math.max(0, Math.min(1, u));
          d = Math.min(d, Math.hypot(q.x - (c.x + dx * u), q.y - (c.y + dy * u)));
        }
        if (d < bestD) {
          bestD = d;
          best = q;
        }
      }
    }
  }
  // 只有真的接上了才算（> 2 m 说明停车根本没贴着车道，退回门的位置）
  return best && bestD * 7 <= 2 ? best : null;
}

/** 工业的服务类说明 → 具体 program */
function industrialProgram(note: string): GroundProgram {
  if (note.includes('装卸')) return 'loading_apron';
  if (note.includes('货场')) return 'truck_court';
  if (note.includes('后勤')) return 'service_lane';
  return 'service_lane';
}

export type { SiteTypology };
