// Planning Realization · R5 Road（PlannedPath → 路面 / 路缘 / 人行道 / 转角）
//
// 一条硬红线：**只 realize centerline，绝不修改 centerline。**
// Planner 已经决定路在哪；这里只决定"这条内部路长什么样"。
//
// 关于"接 road/system.ts"的判断（重要）：
//   `buildRoadNet(model)` 是**城市级**入口 —— 它需要整个 Model、街区拓扑、
//   路口连通性。它不认识"任意一条 centerline"。硬接只能靠伪造 RoadEdge + patchL/R，
//   那会把城市路网的推断逻辑（自动延伸 / 吸附 / 连通）带进来，
//   正好违反"Road System 不能重新规划路线"。
//   所以 R5 在 Realizer 里做 **corridor 构建**（路面 + 路缘 + 人行道 + 转角垫），
//   到 R7 Shadow Mode 再把 corridor 交给城市路网做衔接（那时才有 Model 上下文）。
//
// 不做：转弯半径求解 / swept path / 复杂 spline。90° 网格 + 转角方垫就够早期规划观感。

import { Pt } from '../../core/geom';
import type { MatKey } from '../../scene/palette';
import type { SitePlanCandidate, PlannedPath } from '../planning/core/candidate';
import { surface, surfaceArea, surfaceSubtract, surfaceIntersect, type PlanSurface } from '../planning/core/surface';
import type { RealizationContext, RealizerPart } from './contract';

const U = (m: number) => m / 7;

/** 道路的**实现在语义**（不是 Planner 的 role） */
export type RoadClassReal = 'internal_residential' | 'service' | 'truck' | 'customer_access' | 'campus_service';

export interface RoadProfile {
  class: RoadClassReal;
  /** 车行道宽（米） */
  surfaceM: number;
  /** 路缘宽（米） */
  curbM: number;
  /** 人行道宽（米），0 = 没有 */
  sidewalkM: number;
  mat: MatKey;
  curbMat: MatKey;
  walkMat: MatKey;
}

/**
 * 道路剖面表（Realization Profile）。
 *
 * Planner 只说"这是 internal / service circulation"，具体多宽、有没有人行道在这里定。
 * 这样 Planner 不用携带 curbHeight / laneMarking / lampSpacing 这类渲染参数。
 */
export const ROAD_PROFILES: Record<RoadClassReal, RoadProfile> = {
  internal_residential: { class: 'internal_residential', surfaceM: 7, curbM: 0.4, sidewalkM: 1.5, mat: 'asphalt', curbMat: 'stonePave', walkMat: 'paver' },
  service: { class: 'service', surfaceM: 7.5, curbM: 0.4, sidewalkM: 0, mat: 'asphaltLot', curbMat: 'concrete', walkMat: 'concrete' },
  truck: { class: 'truck', surfaceM: 10, curbM: 0.5, sidewalkM: 0, mat: 'asphaltLot', curbMat: 'concrete', walkMat: 'concrete' },
  customer_access: { class: 'customer_access', surfaceM: 7, curbM: 0.4, sidewalkM: 1.2, mat: 'asphalt', curbMat: 'stonePave', walkMat: 'paver' },
  campus_service: { class: 'campus_service', surfaceM: 6.5, curbM: 0.3, sidewalkM: 0, mat: 'asphaltLot', curbMat: 'concrete', walkMat: 'concrete' },
};

export interface RoadRealizationStat {
  name: string;
  /** 实际消费的中心线（parity 用：与 Planner 的 pts 必须逐点一致） */
  consumedCenterline: Pt[];
  profile: RoadClassReal;
  segments: number;
  lengthM: number;
  junctions: number;
}

export interface RoadRealizeOptions {
  /** Planner 的 role 是 'vehicle' 时用哪个剖面 */
  vehicleClass?: RoadClassReal;
  /** 人行道开关（默认按剖面） */
  sidewalk?: boolean;
  /**
   * 裁剪体（通常是地块）。
   *
   * 内部路的中心线贴着地块边界时，路面条带 / 路缘 / 转角方垫会探出红线 ——
   * 这不是"规划错了"，是 Realizer 忘了裁。不裁的话 Shadow 会把每条边界路
   * 都记成 blocker（实测工业每块 1 条）。
   */
  clip?: PlanSurface;
}

/** 一块环的包围盒 */
function segClipBox(ring: Pt[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of ring) {
    x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y);
    x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y);
  }
  return { x0, y0, x1, y1 };
}

/** 把一块面裁到 clip 里（取最大块） */
function clipSurface(s: Pt[], clip?: PlanSurface): Pt[] | null {
  if (!clip) return s;
  const parts = surfaceIntersect([surface(s)], [clip]);
  if (parts.length === 0) return null;
  const best = parts.reduce((a, b) => (surfaceArea(a) >= surfaceArea(b) ? a : b));
  return surfaceArea(best) > 0.01 ? best.outer : null;
}

/**
 * 把 circulation 变成道路面。
 *
 * 输出：
 *   · 车行道（逐段矩形 + 顶点方垫，保证 90° 转角不裂）
 *   · 路缘（两侧窄条）
 *   · 人行道（可选，路缘外侧）
 *
 * 返回的 `corridors` 要拿去从 Ground 里减掉（道路 > 地面，R5.7）。
 */
export function realizeRoads(
  c: SitePlanCandidate,
  ctx: RealizationContext,
  part: RealizerPart,
  opts: RoadRealizeOptions = {}
): { stats: RoadRealizationStat[]; corridors: PlanSurface[] } {
  const base = ctx.groundY ?? 0.012;
  const stats: RoadRealizationStat[] = [];
  const corridors: PlanSurface[] = [];
  const vehicleClass = opts.vehicleClass ?? 'internal_residential';

  // solver 模式：已经铺出去的路面。后面的路要**从里面扣掉**再铺。
  //
  // 逐段矩形在折角与并流处一定会互压（规划侧已经按格子去重、按上游半宽退让，
  // 仍然会在"两条路并行一小段"时叠 6 m²）。这里做最后一道：路面不重复铺 ——
  // 后来者贴着先来者的边缘接上去。差集后可能碎成多块，各自成面。
  const drawn: PlanSurface[] = [];

  /**
   * solver 模式：路面**必须从建筑轮廓里让开**。
   *
   * 求解器按"中心线到建筑 ≥ 净空"建图，但净空是分交通类型的：步行只有 0.5 m。
   * 中线合规 + 路面 3~5 m 宽 = 铺装必然啃进建筑（实测全城 550 m²）。
   * 光靠中线守法不够，落地面自己得再裁一次 —— 与"地面扣除走廊"同源的做法。
   */
  const bldCuts =
    ctx.circulationMode === 'solver'
      ? c.buildings.map((b) => {
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          for (const q of b.footprint.outer) {
            x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y);
            x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y);
          }
          return { ring: b.footprint.outer, box: { x0, y0, x1, y1 } };
        })
      : [];
  const cutBuildings = (pieces: PlanSurface[], box: { x0: number; y0: number; x1: number; y1: number }) => {
    if (bldCuts.length === 0) return pieces;
    const hits = bldCuts.filter(
      (b) => box.x0 < b.box.x1 && b.box.x0 < box.x1 && box.y0 < b.box.y1 && b.box.y0 < box.y1
    );
    if (hits.length === 0) return pieces;
    let out = pieces;
    for (const b of hits) {
      out = surfaceSubtract(out, [surface(b.ring)]).filter((q) => surfaceArea(q) > 0.02);
      if (out.length === 0) return out;
    }
    return out;
  };

  c.circulation.forEach((path, i) => {
    if (path.pts.length < 2) return;
    const profile = path.role === 'truck' ? ROAD_PROFILES.truck : ROAD_PROFILES[vehicleClass];
    const surfW = U(path.width > 0 ? path.width : U(profile.surfaceM) * 7 / 7) * 7; // 以 Planner 的宽度为准
    const halfW = (path.width > 0 ? path.width : U(profile.surfaceM)) / 2;
    void surfW;

    const name = `${c.id}_road_${i}`;
    let len = 0;
    let junctions = 0;

    // ① 车行道：逐段矩形
    //
    // solver 模式：**段两端各退半个路宽**。Realizer 是按段铺矩形，两段在折角处
    // 一定互压（5 m 路每转一个弯就是 6.25 m² 的重复铺装）。退让之后两块矩形变成
    // "相接"而不是"相交"，转角交给顶点方垫（role=overlay，本来就为该缝而存在）。
    const solver = ctx.circulationMode === 'solver';
    const shorten = (p: Pt, toward: Pt, by: number): Pt => {
      const dx = toward.x - p.x;
      const dy = toward.y - p.y;
      const L = Math.hypot(dx, dy);
      if (L <= 1e-9) return p;
      const t = Math.min(by / L, 0.49);
      return new Pt(p.x + dx * t, p.y + dy * t);
    };
    /** 每一段是否真的铺了（方垫要靠它决定自己该不该存在） */
    const segOk: boolean[] = [];
    for (let k = 0; k + 1 < path.pts.length; k++) {
      const a0 = path.pts[k];
      const b0 = path.pts[k + 1];
      len += Pt.distance(a0, b0);
      let a = a0;
      let b = b0;
      const w = path.width > 0 ? path.width : U(profile.surfaceM);
      if (solver) {
        if (k > 0) a = shorten(a0, b0, w / 2);
        if (k + 2 < path.pts.length) b = shorten(b0, a0, w / 2);
        // **短于自身断面的一段不是路**。solver 常常只补"街边 → 已铺场地"这一小截，
        // 退让之后可能只剩 1~4 m —— 铺出来就是一个方块，比缺口更难看。
        // 这种段交给方垫和既有铺装去衔接，不单独成面。
        if (Pt.distance(a, b) <= w * 0.75) { segOk[k] = false; continue; }
      }
      const seg = segRect(a, b, path.width > 0 ? path.width : U(profile.surfaceM));
      if (!seg) continue;
      segOk[k] = false;
      const segClipped = clipSurface(seg, opts.clip);
      if (segClipped) {
        segOk[k] = true;
        let pieces: PlanSurface[] = [surface(segClipped)];
        if (solver) {
          const bx = segClipBox(segClipped);
          pieces = cutBuildings(pieces, bx);
          if (pieces.length > 0 && drawn.length > 0) {
            pieces = surfaceSubtract(pieces, drawn).filter((p) => surfaceArea(p) > 0.02);
          }
        }
        const multi = pieces.length > 1;
        pieces.forEach((p, pi) => {
          const nm = multi ? `${name}_surf_${k}_${pi}` : `${name}_surf_${k}`;
          part.surfaces.push({
            name: nm,
            group: ctx.group,
            ring: p.outer,
            mat: profile.mat,
            y: base + 0.0016,
            ...(p.holes.length > 0 ? { holes: p.holes } : {}),
          });
          corridors.push(p);
        });
        if (solver) drawn.push(...pieces);
      }
      // 路缘：两侧（垂直于段方向，偏移 halfW + curb/2）
      for (const side of [1, -1] as const) {
        const curb = sideStrip(a, b, halfW, U(profile.curbM), side);
        const c2 = curb ? clipSurface(curb, opts.clip) : null;
        // 路缘石是**边界表达**：它本来就骑在"路面 / 场地"的接缝上，
        // 两侧各压一部分是它的语义，不是重复认领。标 overlay。
        if (c2) part.surfaces.push({ name: `${name}_curb_${k}_${side}`, group: ctx.group, ring: c2, mat: profile.curbMat, y: base + 0.0018, role: 'overlay' });
      }
      // 人行道（可选）
      //
      // solver 模式不铺：求解器给的是"通行净空"（支路 3 m / 主干 5 m），再往两侧
      // 各加 1.5 m 人行道等于把 3 m 支路撑成 6 m 走廊，直接压到建筑与庭院上；
      // 而且折角处人行道条带互相叠，实测 50 m² 的重复铺装全是它。
      if (!solver && (opts.sidewalk ?? profile.sidewalkM > 0) && profile.sidewalkM > 0) {
        for (const side of [1, -1] as const) {
          const walk = sideStrip(a, b, halfW + U(profile.curbM), U(profile.sidewalkM), side);
          const w2 = walk ? clipSurface(walk, opts.clip) : null;
          if (w2) {
            part.surfaces.push({ name: `${name}_walk_${k}_${side}`, group: ctx.group, ring: w2, mat: profile.walkMat, y: base + 0.0014 });
            // 人行道也是**路面**，不是铺在草地上的装饰：solver 模式下它必须参与
            // 地面扣除。否则一条 1.5 m 的人行道会横穿庭院/绿地而地面不知道，
            // 精确重叠加起来实测 448 m²。
            if (ctx.circulationMode === 'solver') corridors.push(surface(w2));
          }
        }
      }
    }

    // ② 顶点方垫：90° 转角不留裂缝（loop 的四个角全靠它）
    for (let k = 0; k < path.pts.length; k++) {
      if (solver) {
        // 端点不需要垫：段的末端本来就没退让，垫只会从路口里探出一个方块
        if (k === 0 || k === path.pts.length - 1) continue;
        // 两边都没铺出段，这个垫就是孤零零一块 5×5 —— 正是"橙色方块"的来源
        if (!segOk[k - 1] && !segOk[k]) continue;
      }
      const p = path.pts[k];
      const pad = square(p, path.width > 0 ? path.width : U(profile.surfaceM));
      let p2 = pad ? clipSurface(pad, opts.clip) : null;
      if (!p2) continue;
      if (solver && bldCuts.length > 0) {
        const cut = cutBuildings([surface(p2)], segClipBox(p2));
        if (cut.length === 0) continue;
        p2 = cut.reduce((a, b) => (surfaceArea(a) >= surfaceArea(b) ? a : b)).outer;
      }
      // 顶点方垫是**表达层**：它就是为了盖住两段直角相交处的缝，
      // 天然与相邻段矩形重叠。用 role 声明，而不是让审计去猜名字。
      part.surfaces.push({ name: `${name}_pad_${k}`, group: ctx.group, ring: p2, mat: profile.mat, y: base + 0.0016, role: 'overlay' });
      corridors.push(surface(p2));
      junctions++;
    }

    stats.push({
      name,
      consumedCenterline: path.pts.map((p) => new Pt(p.x, p.y)),
      profile: profile.class,
      segments: Math.max(0, path.pts.length - 1),
      lengthM: len * 7,
      junctions,
    });
  });

  return { stats, corridors };
}

/**
 * 把 Ground 从道路走廊里扣掉（R5.7：road surface > ground）。
 *
 * 不做这一步就会出现"前院草地压在路面上"的叠面 —— 和 R3.5 之前的问题同源。
 */
export function subtractRoadCorridor(regions: PlanSurface[], corridors: PlanSurface[]): PlanSurface[] {
  if (corridors.length === 0) return regions;
  const out: PlanSurface[] = [];
  for (const r of regions) {
    const rest = surfaceSubtract([r], corridors).filter((p) => surfaceArea(p) > 0.02);
    out.push(...rest);
  }
  return out;
}

// ---------------------------------------------------------------- 几何

/** 沿 a→b、宽 w 的矩形 */
function segRect(a: Pt, b: Pt, w: number): Pt[] | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L = Math.hypot(dx, dy);
  if (L < 1e-9) return null;
  const nx = (-dy / L) * (w / 2);
  const ny = (dx / L) * (w / 2);
  return [
    new Pt(a.x + nx, a.y + ny),
    new Pt(b.x + nx, b.y + ny),
    new Pt(b.x - nx, b.y - ny),
    new Pt(a.x - nx, a.y - ny),
  ];
}

/** 段一侧的偏移条（offset 是条的内边缘到中心线的距离） */
function sideStrip(a: Pt, b: Pt, offset: number, w: number, side: 1 | -1): Pt[] | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L = Math.hypot(dx, dy);
  if (L < 1e-9 || w <= 0) return null;
  const nx = (-dy / L) * side;
  const ny = (dx / L) * side;
  const p = (t: number, d: number) => new Pt(a.x + dx * t + nx * d, a.y + dy * t + ny * d);
  return [p(0, offset), p(1, offset), p(1, offset + w), p(0, offset + w)];
}

/** 转角方垫 */
function square(c: Pt, w: number): Pt[] | null {
  if (w <= 0) return null;
  const h = w / 2;
  return [
    new Pt(c.x - h, c.y - h),
    new Pt(c.x + h, c.y - h),
    new Pt(c.x + h, c.y + h),
    new Pt(c.x - h, c.y + h),
  ];
}
