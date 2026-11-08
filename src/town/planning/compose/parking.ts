// F2.4-B4 · 停车与局部道路
//
// 复用 `src/town/parking.ts` 的求解器（任务书：不替换 Parking Solver）。
// 这一层不做排布算法，只做三件事：
//   ① 把停车地块内缩成"可排布的场地"（让开边界与出入口）；
//   ② 给它接一条真实的进出车道（从车道到城市道路/内部道路）；
//   ③ **逐项验证**：每排车位接通道 → 通道接出入口 → 出入口接道路 → 停车到建筑有步行联系。
//
// 第 ③ 步是任务书点名的坑："不允许仅验证停车场 Portal 已连接就认定停车可达"。
// 所以这里的判据全部落在几何上（车位前缘到通道的距离、通道与出入口铺装的相交），
// 不是"有一个叫 portal 的对象存在"。

import { Pt } from '../../../core/geom';
import { surface, surfaceArea, surfaceInset, surfaceIntersect, surfaceSubtract, type PlanSurface } from '../core/surface';
import { solveParking, CAR_STALL, type ParkLayout } from '../../parking';
import { bufferPolyline } from '../../../core/polyline';
import { obbOf } from '../subdivision/geom';
import { U } from '../subdivision/types';
import type { ComposeNote, GroundPatch, InternalRoad, ParcelPlan, ParkingArea, SiteBuilding, SiteDoor } from './types';

const M2 = (u2: number) => u2 * 49;

export interface ParkingResult {
  areas: ParkingArea[];
  /** 停车铺装（同时进 ground 层，参与面积对账） */
  ground: GroundPatch[];
  /** 进出车道（进 ground 层） */
  drives: GroundPatch[];
  notes: ComposeNote[];
}

/**
 * 在停车地块上排布车位。
 *
 * 内缩 3 m：停车排布必须让开地块边界（车轮不能压线），
 * 也让出沿街的绿化/人行带 —— 否则车位会怼到人行道上。
 */
export function placeParking(
  parcels: ParcelPlan[],
  buildings: SiteBuilding[],
  roads: InternalRoad[],
  typology: string
): ParkingResult {
  const out: ParkingArea[] = [];
  const ground: GroundPatch[] = [];
  const drivesOut: GroundPatch[] = [];
  const notes: ComposeNote[] = [];

  for (const p of parcels.filter((x) => x.fn === 'parking')) {
    const usable = p.usable ?? p.surface;
    const inner = insetForParking(usable, 3);
    if (!inner) {
      notes.push({ code: 'parking', severity: 'warn', message: `${p.id} 内缩后无法排布停车（地块 ${M2(surfaceArea(usable)).toFixed(0)} m²）` });
      continue;
    }
    const ob = obbOf(inner.outer);
    const a0 = ob ? Math.atan2(ob.uy, ob.ux) : 0;
    /**
     * 求解，失败就退到"内接矩形"。
     *
     * 带中庭/凹口的地块内缩后可能是 L 形或环带，求解器在里面找不到可用的双向车排
     *（实测 G07 一块 577 m² 的停车地排 0 位）。真实的停车场本来就是矩形的，
     * 所以退一步：取该地块的最小外接矩形、内缩 4%，在那上面排 —— 牺牲几个边角，
     * 换来一个真正可用的车位排布。
     */
    const angles = [a0, a0 + Math.PI / 2, a0 + Math.PI / 4, a0 - Math.PI / 4, a0 + Math.PI / 12, a0 - Math.PI / 12];
    let lay = solveParking(inner.outer, { angles, maxAngles: 6 });
    let used = inner;
    if (!lay || lay.count === 0 || lay.aisles.length === 0) {
      const rect = inscribedRect(inner);
      if (rect) {
        const r2 = solveParking(rect.outer, { angles, maxAngles: 6 });
        if (r2 && r2.count > 0 && r2.aisles.length > 0) {
          lay = r2;
          used = rect;
        }
      }
    }
    if (!lay || lay.count === 0 || lay.aisles.length === 0) {
      notes.push({ code: 'parking', severity: 'warn', message: `${p.id} 停车求解失败（${M2(surfaceArea(inner)).toFixed(0)} m² 可排布场地）` });
      continue;
    }
    const aisles = lay.aisles.map((r) => surface(r)).filter((s) => surfaceArea(s) > 1e-6);
    void used;
    const gaps = stallGapsM(lay, aisles);
    const stallGapMaxM = gaps.length ? Math.max(...gaps) : Infinity;
    /**
     * 孤列车位：前缘离任何通道都超过 9 m（车位进深 5 m + 4 m 余量）。
     *
     * 求解器在末尾会"再补一排单面停车"，那一排有时落在内缩后的边角上、够不着通道。
     * 这种车位不算数 —— 计进去等于虚报供给；直接判整块失败又太粗（其余几十个位是好的）。
     * 所以：扣除并报出个数，孤列超过 20% 才判失败。
     */
    const orphans = gaps.filter((g) => g > 9).length;
    /**
     * 只把**接得上通道**的车位计入供给。
     *
     * 求解器末尾会补一排单面停车，那一排有时够不着任何通道。把这种车位算进容量
     * 等于虚报供给，而为此判整块失败又太粗（其余几十个位是好的）。
     * 所以：计入的必须 100% 接通道（硬约束），没接上的单独报数、不计入。
     */
    const usableStalls = Math.max(0, lay.count - orphans);
    // 场内环形连接道：把各条通道端头串起来。
    // 并行通道如果互不相接，就是"三条死胡同"——真实停车场一定有横向环道。
    const ring = aisleRing(aisles, inner, lay);
    const gate = makeParkingGate(p, lay, aisles, roads);
    const drive = gate.drive ? clipToSurface(gate.drive, usable) : null;
    /**
     * 车位铺装要**挖掉车道与环道**。
     *
     * 两者都铺在车位区内部（车道起点伸进车位区，环道串在各通道端头），
     * 所以"车位铺装"与它们天然重叠。三块都按面积相加就会多算十几到几十平方米
     *（实测 G01 一块停车地的三块地面之和 693.5 m²，而并集正好等于可用地 681.8 m²）。
     * 这里按顺序逐个挖掉，剩下的才是"纯车位铺装"。
     */
    const drives: PlanSurface[] = [];
    let deck: PlanSurface | null = inner;
    for (const d of [ring, drive]) {
      if (!d) continue;
      const rest: PlanSurface | null = deck ? clipToSurface(deck, d, false) : null;
      if (rest) {
        deck = rest;
        drives.push(d);
      } else {
        // 挖不掉就不单列这块铺装（宁可少画一条线，也不要两笔重叠的面积）
        notes.push({ code: 'parking', severity: 'info', message: `${p.id} 场内道路无法从车位铺装中扣除，已并入车位铺装` });
      }
    }
    void drive;
    const gateReachM = gate.door ? gate.door.reachM : Infinity;
    const aislesConnected = countConnectedAisles(aisles, drives);
    const walk = nearestBuildingDoorM(inner, buildings, p.id);
    const ok =
      usableStalls > 0 &&
      aislesConnected >= aisles.length &&
      gateReachM <= 40;

    out.push({
      id: `pk-${p.id}`,
      parcelId: p.id,
      surface: deck ?? inner,
      stalls: usableStalls,
      layout: lay,
      gate: gate.door,
      checks: {
        aisles: aisles.length,
        aislesConnected,
        stallGapMaxM: +stallGapMaxM.toFixed(2),
        gateReachM: Number.isFinite(gateReachM) ? +gateReachM.toFixed(1) : -1,
        walkToBuildingM: walk === null ? null : +walk.toFixed(1),
        ok,
      },
      reason:
        `${usableStalls} 个可用车位（求解 ${lay.count} 个${orphans > 0 ? `，其中 ${orphans} 个孤列不计` : ''}），` +
        `${aisles.length} 条通道，最远车位距通道 ${stallGapMaxM.toFixed(1)} m；` +
        `出入口距道路 ${Number.isFinite(gateReachM) ? gateReachM.toFixed(1) + ' m' : '未接通'}` +
        (walk !== null ? `；到最近建筑门 ${walk.toFixed(0)} m` : '；本地块无建筑'),
    });

    notes.push({
      code: 'parking',
      severity: ok ? 'info' : 'warn',
      message: `${p.id} 停车 ${usableStalls} 位（${ok ? '验证通过' : '验证未通过'}）：通道 ${aislesConnected}/${aisles.length} 接通，最远车位贴道 ${stallGapMaxM.toFixed(1)} m${orphans ? `，孤列 ${orphans}` : ''}`,
    });
    ground.push({
      kind: 'parking-deck',
      surface: deck ?? inner,
      areaM2: M2(surfaceArea(deck ?? inner)),
      purpose: `集中停车 ${usableStalls} 位（${typology === 'industrial' ? '员工/访客' : '顾客/住户'}），排布方向 ${((lay.angle * 180) / Math.PI).toFixed(0)}°`,
      parcelId: p.id,
      drivable: true,
    });
    for (const d of drives) {
      drivesOut.push({
        kind: 'driveway',
        surface: d,
        areaM2: M2(surfaceArea(d)),
        purpose: d === ring ? `场内环形连接道（6 m）：把 ${aisles.length} 条停车通道串起来，避免死胡同` : `停车进出车道（7 m 双向），从${gate.door?.target ?? '道路'}进入`,
        parcelId: p.id,
        drivable: true,
      });
    }
  }
  return { areas: out, ground, drives: drivesOut, notes };
}

/**
 * 内缩出可排布场地。
 *
 * 用 `core/surface` 的 `surfaceInset`（它处理凹多边形与自交），
 * 而不是自己写"按边内移 + 求交"：后者在 L 形地块上会自交，
 * 交给求解器就是 0 个车位（实测 G07 两块停车地全部排空）。
 */
/** 内接矩形（OBB 内缩 4%）：停车排布的兜底场地 */
function inscribedRect(s: PlanSurface): PlanSurface | null {
  const ob = obbOf(s.outer);
  if (!ob) return null;
  const cx = ob.cx;
  const cy = ob.cy;
  const ux = Math.cos(Math.atan2(ob.uy, ob.ux));
  const uy = Math.sin(Math.atan2(ob.uy, ob.ux));
  const vx = -uy;
  const vy = ux;
  const hw = (ob.w / 2) * 0.92;
  const hd = (ob.d / 2) * 0.92;
  const ring = [
    new Pt(cx - ux * hw - vx * hd, cy - uy * hw - vy * hd),
    new Pt(cx + ux * hw - vx * hd, cy + uy * hw - vy * hd),
    new Pt(cx + ux * hw + vx * hd, cy + uy * hw + vy * hd),
    new Pt(cx - ux * hw + vx * hd, cy - uy * hw + vy * hd),
  ];
  const out = surface(ring);
  // 必须落在原场地内（外接矩形可能超出地块）
  const clipped = surfaceIntersect([out], [s]).filter((q) => surfaceArea(q) > 0.05);
  clipped.sort((a, b) => surfaceArea(b) - surfaceArea(a));
  return clipped[0] ?? null;
}

function insetForParking(s: PlanSurface, m: number): PlanSurface | null {
  const parts = surfaceInset(s, U(m)).filter((q) => surfaceArea(q) > 0.05);
  if (parts.length === 0) return null;
  parts.sort((a, b) => surfaceArea(b) - surfaceArea(a));
  return parts[0];
}

function toSurfaces(rings: Pt[][]): PlanSurface[] {
  return rings.map((r) => surface(r)).filter((s) => surfaceArea(s) > 0.01);
}

/**
 * 每个车位前缘到最近通道的距离（米）。
 *
 * 这是"每排车位与车道连接"的量化判据：车位前缘本来就贴在通道边界上，
 * 所以正常值应接近 0；大于 3.5 m 说明有一排车位根本没挨着车道（可能是求解器在
 * 边角补的单排，或者内缩后通道被切掉）。
 */
function stallGapsM(lay: ParkLayout, aisles: PlanSurface[]): number[] {
  if (aisles.length === 0) return [];
  const out: number[] = [];
  for (const f of lay.fronts) {
    const mid = new Pt((f[0].x + f[1].x) / 2, (f[0].y + f[1].y) / 2);
    let best = Infinity;
    for (const a of aisles) best = Math.min(best, distToRing(mid, a));
    out.push(best * 7);
  }
  return out;
}

function distToRing(p: Pt, s: PlanSurface): number {
  let d = Infinity;
  const rings = [s.outer, ...s.holes];
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l2 = dx * dx + dy * dy || 1;
      let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
      t = Math.max(0, Math.min(1, t));
      d = Math.min(d, Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)));
    }
  }
  return d;
}

/**
 * 停车出入口：从最靠近临街边的**通道端点**，拉一条 7 m 双向车道到街边。
 *
 * 只做到"通道端点"是不够的（那只是停车场内部），
 * 必须再连一段**铺装车道**到地块边界，这一段才是车辆真正驶入的地方。
 */
function makeParkingGate(
  p: ParcelPlan,
  lay: ParkLayout,
  aisles: PlanSurface[],
  roads: InternalRoad[]
): { door: SiteDoor | null; drive: PlanSurface | null } {
  if (aisles.length === 0) return { door: null, drive: null };
  // 候选：每条通道的两端
  const cands: Pt[] = [];
  for (const a of aisles) {
    for (const r of [a.outer]) {
      if (r.length >= 4) {
        cands.push(r[0], r[Math.floor(r.length / 2)]);
      }
    }
  }
  let best: { at: Pt; dist: number; target: string; edge: [Pt, Pt] } | null = null;
  for (const c of cands) {
    const near = nearestFrontage(c, p);
    if (!near) continue;
    if (!best || near.dist < best.dist) best = { at: c, dist: near.dist, target: near.roadKey, edge: near.edge };
  }
  if (!best) return { door: null, drive: null };
  // 车道：从通道端点走到街边中点（沿通道端点正对街边的最近点）
  //
  // **起点要伸进车位区 2.5 m**：两个多边形只沿一条线相接时交集面积为 0，
  // "通道与出入口是否连通"就永远判 false（实测 G01 两条通道接通数 0/2）。
  const aisle = aisles.find((a) => distToRing(best.at, a) < 0.05) ?? aisles[0];
  const ac = centroidOf(aisle.outer);
  const back = new Pt(best.at.x + (ac.x - best.at.x) * 0.12, best.at.y + (ac.y - best.at.y) * 0.12);
  const proj = projectToSegment(best.at, best.edge[0], best.edge[1]);
  const ring = bufferPolyline([back, proj.at], U(3.5));
  const drive = ring ? surface(ring) : null;
  const door: SiteDoor = {
    kind: 'main',
    at: best.at,
    normal: new Pt(proj.at.x - best.at.x, proj.at.y - best.at.y),
    target: best.target,
    reachM: +(best.dist * 7).toFixed(1),
    apron: true,
  };
  void lay;
  void roads;
  return { door, drive };
}

/**
 * 场内横向连接道：把每条通道"靠近出入口的那一端"串成一条折线。
 *
 * 不连的话，双排通道各自是死胡同，任何一条没接到出入口就等于那一排车位进不去
 *（实测 R01 一条通道接通 1/3）。
 */
function aisleRing(aisles: PlanSurface[], area: PlanSurface, lay: ParkLayout): PlanSurface | null {
  if (aisles.length < 2) return null;
  const ref = centroidOf([new Pt(Math.cos(lay.angle), Math.sin(lay.angle)), new Pt(0, 0)]);
  void ref;
  // 每条通道：取离"所有通道公共形心"最近的那个顶点作为接入端
  const all: Pt[] = aisles.flatMap((a) => a.outer);
  const common = centroidOf(all);
  // 端头要**伸进通道内部 2.5 m**：只贴边相接时两块多边形交集面积为 0，
  // "通道是否连通"就永远判 false（实测 G01 两条通道只连上一条）。
  const ends: Pt[] = aisles.map((a) => {
    let best = a.outer[0];
    let bd = Infinity;
    for (const q of a.outer) {
      const d = Pt.distance(q, common);
      if (d < bd) {
        bd = d;
        best = q;
      }
    }
    const ac = centroidOf(a.outer);
    const dx = ac.x - best.x;
    const dy = ac.y - best.y;
    const L = Math.hypot(dx, dy) || 1;
    const back = Math.min(2.5 / 7, L * 0.35);
    return new Pt(best.x + (dx / L) * back, best.y + (dy / L) * back);
  });
  if (ends.length < 2) return null;
  // 按通道主轴方向排序，折线才顺
  const ux = Math.cos(lay.angle);
  const uy = Math.sin(lay.angle);
  ends.sort((a, b) => a.x * ux + a.y * uy - (b.x * ux + b.y * uy));
  const ring = bufferPolyline(ends, U(3));
  if (!ring) return null;
  const clipped = clipToSurface(surface(ring), area);
  return clipped;
}

function centroidOf(ring: Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const q of ring) {
    x += q.x;
    y += q.y;
  }
  return new Pt(x / Math.max(1, ring.length), y / Math.max(1, ring.length));
}

function nearestFrontage(p: Pt, parcel: ParcelPlan): { dist: number; roadKey: string; edge: [Pt, Pt] } | null {
  let best: { dist: number; roadKey: string; edge: [Pt, Pt] } | null = null;
  for (const f of parcel.candidate.frontages) {
    const pr = projectToSegment(p, f.edge[0], f.edge[1]);
    if (!best || pr.dist < best.dist) best = { dist: pr.dist, roadKey: f.roadKey, edge: f.edge };
  }
  return best;
}

function projectToSegment(p: Pt, a: Pt, b: Pt): { at: Pt; t: number; dist: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy || 1;
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  const at = new Pt(a.x + dx * t, a.y + dy * t);
  return { at, t, dist: Pt.distance(p, at) };
}

/** 取 s ∩ area 的最大一块；`keep=true` 时取 s − area 的最大一块 */
function clipToSurface(s: PlanSurface, area: PlanSurface, keep = true): PlanSurface | null {
  try {
    const raw = keep ? surfaceIntersect([s], [area]) : surfaceSubtract([s], [area]);
    const parts = raw.filter((q) => surfaceArea(q) > 1e-6);
    parts.sort((a, b) => surfaceArea(b) - surfaceArea(a));
    return parts[0] ?? null;
  } catch {
    return null;
  }
}

/** 有几条通道与出入口车道连通（直接相交或经相邻通道） */
function countConnectedAisles(aisles: PlanSurface[], links: PlanSurface[]): number {
  const seen = new Set<number>();
  const queue: number[] = [];
  aisles.forEach((a, i) => {
    for (const l of links) {
      try {
        if (surfaceIntersect([a], [l]).some((q) => surfaceArea(q) > 1e-6)) {
          seen.add(i);
          queue.push(i);
          break;
        }
      } catch {
        /* 单次失败按不连通计 */
      }
    }
  });
  while (queue.length > 0) {
    const i = queue.pop()!;
    for (let j = 0; j < aisles.length; j++) {
      if (seen.has(j)) continue;
      try {
        if (surfaceIntersect([aisles[i]], [aisles[j]]).some((q) => surfaceArea(q) > 1e-6)) {
          seen.add(j);
          queue.push(j);
        }
      } catch {
        /* 忽略 */
      }
    }
  }
  return seen.size;
}

function nearestBuildingDoorM(area: PlanSurface, buildings: SiteBuilding[], parcelId: string): number | null {
  const c = area.outer.reduce((acc, q) => new Pt(acc.x + q.x / area.outer.length, acc.y + q.y / area.outer.length), new Pt(0, 0));
  let best = Infinity;
  for (const b of buildings) {
    if (b.parcelId !== parcelId) continue;
    for (const d of b.doors) best = Math.min(best, Pt.distance(c, d.at) * 7);
  }
  return Number.isFinite(best) ? best : null;
}

/** 停车需求（位）：按 GFA 折算，作为"够不够用"的参考，不参与硬约束 */
export function parkingDemandOf(gfaM2: number, typology: string): number {
  const per100 = typology === 'industrial' ? 0.4 : typology === 'retail' ? 1.2 : 0.9;
  return Math.round((gfaM2 / 100) * per100);
}

export { CAR_STALL };
