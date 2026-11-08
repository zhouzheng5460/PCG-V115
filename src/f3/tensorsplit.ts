// F3-F · 地块切分的**第一级**：张量场少量粗切
//
// 层级关系（用户明确要求「先后关系」，不是两套并列机制）：
//
//   街区 CityBlock                       （道路围合出来的一块地）
//     └─ ① 张量场一级切分               （本文件：少量 1~2 刀 → 2~3 个大分区 + 内部步行街）
//          └─ ② 现有 splitParcels        （blocks.ts：正交二叉 / 排×户，机制完全不动）
//               └─ ③ BuildingParcel     （地块，交给 landuse / layout / height / ground）
//
// 张量场在这里**不是另一种道路生成方式**：它不再和 `growStreets` 并列，而是
// 在街区之后、现有切分之前插进来的一层「方向 + 粗分」。`growStreets` 仍只把
// 张量场当方向场用（挑刀口朝向），本层则把同一个场的方向用在地块尺度上：
//   · 一级刀口顺着局部场方向（贴近街区短轴的那一族），只切 0~2 刀；
//   · 一级缝按《houdini 路网 (3)》「或把内部分割线当步行街」铺成 3 m 内部步行带；
//   · 每个大分区带一个由场给出的 axisRad，二级 `binarySplit` 拿它当主轴向。
//
// 一级切出来的线**是地块边界 / 内部步行带，不是马路**，不会进 PathGraph，
// 所以道路分级、路口、标线、路灯那一整套完全不受影响。

import { Pt } from '../core/geom';
import {
  pointInRing,
  surfaceArea,
  surfaceIntersect,
  surfaceSubtract,
  surfaceUnion,
  type PlanSurface,
} from '../town/planning/core/surface';
import { makeRng, obbOf, splitSurfaceByLine } from '../town/planning/subdivision/geom';
import { TensorField, type FieldSource } from '../town/field/tensor';
import { M2, U, cleanRing, clipLineToSurface, distPointToPolyline, shapeOf } from './geom';
import type { CityBlock, CitySpec, PathGraph, StylePreset } from './types';

export interface TensorRegion {
  id: string;
  surface: PlanSurface;
  areaM2: number;
  /** 张量场在该分区形心给出的主轴向：二级 binarySplit 用它当 axisRad */
  axisRad: number;
  /** 产生这个分区的那一级刀口方向（诊断用；未切过的分区为 null） */
  cutRad: number | null;
}

export interface TensorSplit {
  regions: TensorRegion[];
  /** 一级缝上的内部步行带（已裁到街区里，互不重叠） */
  lanes: PlanSurface[];
  /** 一级刀口（诊断出图用） */
  seams: [Pt, Pt][];
  notes: string[];
}

/** 一级分区的目标尺度：街区面积越大，允许的一级刀数越多，但最多 2 刀 */
const MAX_CUTS = 2;
/** 内部步行带宽（米） */
const LANE_M = 3.0;

/** 张量场倾斜上限（弧度）：规则街区保持近正交，有机街区让场多带一点 */
function tiltOf(style: CitySpec['style']): number {
  return style === 'organic' ? 0.22 : style === 'campus' ? 0.11 : 0.07;
}

/**
 * 地块级张量场 = 道路层同一个场（全局主方向 + 城市边界）**再加**各条街道的
 * 局部方向源。
 *
   * 为什么加路源：一级分区要顺着「这一片地实际朝向哪条街」，而不是全城一个
 * 固定角度。靠近干道的地方由干道方向主导，街区腹地回到全局主方向，
 * 城市边缘由 boundary 源带弯 —— 与 `growStreets` 的场是同一套张量语言。
 *
 * 折线抽稀到 ≤ 9 点：`TensorField.sample` 对每个 path 源都要扫一遍折线，
 * Chaikin 修形后的街道点数不少，不抽稀会让每街区的几次采样变成几百次线段求交。
 */
export function buildParcelTensor(spec: CitySpec, graph: PathGraph, axisRad: number): TensorField {
  const boundaryStrength = spec.style === 'organic' ? 0.9 : spec.style === 'campus' ? 0.35 : 0.55;
  const sources: FieldSource[] = [
    {
      id: 'axis',
      type: 'grid',
      direction: new Pt(Math.cos(axisRad), Math.sin(axisRad)),
      radius: U(400),
      strength: 1,
    },
    {
      id: 'edge',
      type: 'boundary',
      radius: U(95),
      strength: boundaryStrength,
      falloff: 1.6,
    },
  ];
  for (const p of graph.paths.slice(0, 400)) {
    if (p.pts.length < 2) continue;
    const stride = Math.max(1, Math.ceil(p.pts.length / 9));
    const pts: Pt[] = [];
    for (let i = 0; i < p.pts.length; i += stride) pts.push(p.pts[i]);
    const last = p.pts[p.pts.length - 1];
    if (pts.length < 2 || Pt.distance(pts[pts.length - 1], last) > 1e-9) pts.push(last);
    sources.push({
      id: `street-${p.id}`,
      type: 'path',
      path: pts,
      radius: U(38),
      strength: p.cls === 'arterial' ? 1.7 : p.cls === 'collector' ? 1.25 : 0.85,
      falloff: 2,
    });
  }
  return new TensorField(sources, spec.boundary.outer);
}

/** 两个无向角的差（0~π/2） */
function angDiff(a: number, b: number): number {
  let d = Math.abs(a - b) % Math.PI;
  d = Math.min(d, Math.PI - d);
  return d;
}

/** 把角差折到 (-π/2, π/2] */
function signedDiff(a: number, b: number): number {
  let d = (a - b) % Math.PI;
  if (d > Math.PI / 2) d -= Math.PI;
  if (d < -Math.PI / 2) d += Math.PI;
  return d;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/**
 * 取场的主/次方向里离 `target` 最近的那一族，把偏离量夹在 ±maxTilt。
 *
 * 「夹一下」是刻意的：一级分区仍要能盖房子。完全放任场方向会在规则网格里
 * 切出斜边梯形，二级正交二叉就会把它碎成三角形（实测矩形度会从 0.97 掉到
 * 0.8 以下）。有限倾斜既保留了场的方向信息，又不破坏截图 3/4/5 的矩形地块。
 */
function fieldAxis(field: TensorField, at: Pt, target: number, maxTilt: number): number {
  const a = field.angleAt(at.x, at.y, 'major').a;
  const cands = [a, a + Math.PI / 2];
  let best = cands[0];
  for (const c of cands) if (angDiff(c, target) < angDiff(best, target)) best = c;
  return target + clamp(signedDiff(best, target), -maxTilt, maxTilt);
}

function centroidOf(ring: Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p.x;
    y += p.y;
  }
  return new Pt(x / Math.max(1, ring.length), y / Math.max(1, ring.length));
}

/** 折线形心处沿法线的投影跨度 */
function spanAlongNormal(ring: Pt[], ang: number): number {
  const nx = -Math.sin(ang);
  const ny = Math.cos(ang);
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of ring) {
    const t = p.x * nx + p.y * ny;
    lo = Math.min(lo, t);
    hi = Math.max(hi, t);
  }
  return hi - lo;
}

/** 由刀口两端点生成一条带宽度的内部步行街，并裁回街区 */
function laneAlong(seam: [Pt, Pt], block: CityBlock): PlanSurface[] {
  const [a, b] = seam;
  const L = Pt.distance(a, b);
  if (L < U(8)) return [];
  const dx = (b.x - a.x) / L;
  const dy = (b.y - a.y) / L;
  const nx = -dy;
  const ny = dx;
  const hw = U(LANE_M) / 2;
  const strip: PlanSurface = {
    outer: cleanRing([
      new Pt(a.x + nx * hw, a.y + ny * hw),
      new Pt(b.x + nx * hw, b.y + ny * hw),
      new Pt(b.x - nx * hw, b.y - ny * hw),
      new Pt(a.x - nx * hw, a.y - ny * hw),
    ]),
    holes: [],
  };
  try {
    return surfaceIntersect([strip], [block.surface]).filter((q) => M2(surfaceArea(q)) > 3);
  } catch {
    return [];
  }
}

/**
 * 街区 → 一级大分区。
 *
 * 「少量切分」的硬约束：每个街区最多 `MAX_CUTS=2` 刀（即最多 3 个分区），
 * 且只在面积够大、两侧都放得下一排建筑时才下刀。公园/绿地整块保留。
 */
export function splitBlockByTensor(
  block: CityBlock,
  field: TensorField,
  spec: CitySpec,
  preset: StylePreset,
): TensorSplit {
  const notes: string[] = [];
  const skip = (why: string): TensorSplit => ({
    regions: [
      {
        id: `${block.id}-T1`,
        surface: block.surface,
        areaM2: block.areaM2,
        axisRad: block.frontRad,
        cutRad: null,
      },
    ],
    lanes: [],
    seams: [],
    notes: [`${block.id}：${why}`],
  });
  if (block.use === 'park' || block.use === 'green') return skip('公园/绿地，不做一级切分');

  // 一级分区的目标尺度随街区模数走：约 1/3 个街区。实测 structured 街区中位
  // ~8300 m²、目标 16000 m² / 3 ≈ 5100 m²，于是典型街区切 1 刀、大街区 2 刀，
  // 小街区不切 —— 正好是「少量切分」，不会把街区直接打碎成地块尺度。
  const unitM2 = Math.max(2200, preset.blockM2 * 0.32);
  let wantCuts = clamp(Math.floor(block.areaM2 / unitM2), 0, MAX_CUTS);
  if (block.areaM2 < 2400) wantCuts = 0;
  // CBD 要「放开占用原本多个建筑的范围」的大底盘（截图 5 / height.ts 的
  // merge=3）：一级切得太碎会让 CBD 地块宽度掉到合并门槛以下，塔楼裙房
  // 从 ~930 m² 缩到 ~670 m²。街区主导用途是 cbd 时最多只切 1 刀。
  if (block.use === 'cbd') wantCuts = Math.min(wantCuts, 1);
  if (wantCuts === 0) return skip(`面积 ${block.areaM2.toFixed(0)} m² < 一级切分门槛，整块进二级`);

  const rng = makeRng((spec.seed ^ idSeed(block.id)) >>> 0, 'tensor-first');
  const tilt = tiltOf(spec.style);
  const seams: [Pt, Pt][] = [];
  let regions: { surface: PlanSurface; cutRad: number | null }[] = [{ surface: block.surface, cutRad: null }];
  const minRegionM2 = Math.max(600, Math.min(1400, block.areaM2 * 0.16));

  for (let cut = 0; cut < wantCuts; cut++) {
    // 每次挑当前最大的分区下刀 —— 与道路层「挑最大的面」同一套顺序语言
    let bi = -1;
    let bA = -1;
    for (let i = 0; i < regions.length; i++) {
      const A = M2(surfaceArea(regions[i].surface));
      if (A > bA) {
        bA = A;
        bi = i;
      }
    }
    if (bi < 0 || bA < unitM2 * 1.15) break;
    const src = regions[bi];
    if (shapeOf(src.surface).minorM < 24) break;

    const c = centroidOf(src.surface.outer);
    const ob = obbOf(src.surface.outer);
    const longAng = ob ? Math.atan2(ob.uy, ob.ux) : block.frontRad;
    // 一级刀口：切过分区长轴（把长边变短），方向由场给，倾斜量有上限
    const ang = fieldAxis(field, c, longAng + Math.PI / 2, tilt);
    const nx = -Math.sin(ang);
    const ny = Math.cos(ang);
    const span = spanAlongNormal(src.surface.outer, ang);
    let parts: { a: PlanSurface; b: PlanSurface; extra: PlanSurface[]; seam: [Pt, Pt] } | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const jitter = (rng() - 0.5) * 0.34;
      const at = new Pt(c.x + nx * span * jitter, c.y + ny * span * jitter);
      let r: ReturnType<typeof splitSurfaceByLine> | null = null;
      try {
        r = splitSurfaceByLine(src.surface, at, ang);
      } catch {
        r = null;
      }
      if (!r) continue;
      const aA = r.a.reduce((s, q) => s + M2(surfaceArea(q)), 0);
      const bA2 = r.b.reduce((s, q) => s + M2(surfaceArea(q)), 0);
      if (aA < minRegionM2 || bA2 < minRegionM2) continue;
      /**
       * 一条直线切**凹**多边形会吐出好几片：左右两侧各只取最大的一片，
       * 其余会变成 lefttover（铺绿地）。张量流线围出的街区本来就常常是凹的
       * （弧形街 + 斜交路口），只留最大片实测漏掉 6% 的街区面积 ——
       * 单个 11 万 m² 的超大街区漏了 4.1 万 m²，等于半条街变成"凭空出现的绿地"。
       *
       * 所以：**同一刀切出来的每一片都留下**（≥120 m²）。这不是多切了一刀 ——
       * 刀数仍是 ≤2，只是把这一刀真正切开的几块都算作分区。
       */
      const A = largest(r.a);
      const B = largest(r.b);
      if (!A || !B) continue;
      if (shapeOf(A).minorM < 20 || shapeOf(B).minorM < 20) continue;
      const extra = [...r.a, ...r.b].filter((q) => q !== A && q !== B && M2(surfaceArea(q)) >= 120);
      /**
       * 刀口端点自己算：`splitSurfaceByLine` 的 `seg`（seamOf）是纯展示用的，
       * 解线段参数 u 时符号写反且用 `dx || 1e-12` 兜竖直边，实测 8/89 刀
       * 能返回值 —— 直接拿它当缝会丢掉 90% 的内部步行街。这里用
       * `clipLineToSurface`（射线法判定线段是否落在面内）取最长的一段。
       */
      const segs = clipLineToSurface(src.surface, at, ang);
      let seam: [Pt, Pt] | null = null;
      let bestLen = 0;
      for (const sg of segs) {
        const L = Pt.distance(sg[0], sg[1]);
        if (L > bestLen) {
          bestLen = L;
          seam = [sg[0], sg[1]];
        }
      }
      if (!seam || bestLen < U(12)) continue;
      parts = { a: A, b: B, extra, seam };
      break;
    }
    if (!parts) break;

    const next = regions.slice(0, bi).concat(regions.slice(bi + 1));
    next.push({ surface: parts.a, cutRad: ang });
    next.push({ surface: parts.b, cutRad: ang });
    for (const q of parts.extra) next.push({ surface: q, cutRad: ang });
    regions = next;
    seams.push(parts.seam);
  }

  // 一级缝 → 内部步行带；并集一次，交叉处不重复铺
  let lanes: PlanSurface[] = [];
  for (const seam of seams) lanes.push(...laneAlong(seam, block));
  if (lanes.length > 1) {
    try {
      lanes = surfaceUnion(lanes).filter((q) => M2(surfaceArea(q)) > 3);
    } catch {
      /* 并集失败就按片铺，视觉上重叠但面积口径仍由 leftover 兜住 */
    }
  }
  // 再裁回城市红线：布尔并集在斜向交叉的带子上偶尔会吐出越界的凹角点。
  //
  // 必须**逐片**裁并逐片验收：一次性把 70 多片带子交给 polygon-clipping，
  // 只要其中一片自交，整批 intersection 会静默失败（实测 705 次布尔退化，
  // lastMessage = "degenerate segment at [NaN, NaN]"），失败后保留原样就会
  // 在总平面上挂一条伸出红线 9 m 的悬空石铺。裁不动的片宁可丢掉。
  if (lanes.length) {
    const clipped: PlanSurface[] = [];
    for (const l of lanes) {
      let parts: PlanSurface[] = [];
      try {
        parts = surfaceIntersect([l], [spec.boundary]).filter((q) => M2(surfaceArea(q)) > 3);
      } catch {
        parts = [];
      }
      for (const q of parts) {
        const bad = q.outer.some(
          (p) => !pointInRing(p, spec.boundary.outer) && distPointToPolyline(p, spec.boundary.outer) > 0.03
        );
        if (!bad) clipped.push(q);
      }
    }
    lanes = clipped;
  }
  // 分区让开步行带：二级切分拿到的是「已经扣掉内街」的干净地块面。
  // 每片都保留（≥24 m²）：内街从凹形分区中间穿过时会把它切成好几块，
  // 只留最大片同样会漏面积（实测会让 3%~6% 的街区变成 leftover）。
  if (lanes.length) {
    const trimmed: typeof regions = [];
    for (const r of regions) {
      let rest: PlanSurface[] = [r.surface];
      try {
        rest = surfaceSubtract([r.surface], lanes);
      } catch {
        rest = [r.surface];
      }
      for (const q of rest) {
        if (M2(surfaceArea(q)) >= 24) trimmed.push({ surface: q, cutRad: r.cutRad });
      }
    }
    regions = trimmed;
  }
  if (regions.length === 0) return skip('一级切分后没有可用分区，退回整块');

  const outRegions: TensorRegion[] = regions.map((r, i) => {
    const c = centroidOf(r.surface.outer);
    // 二级主轴向：沿用「从街道指向街区内部」的现有语义，只让场把它掰一点
    const axisRad = fieldAxis(field, c, block.frontRad, tilt);
    return {
      id: `${block.id}-T${i + 1}`,
      surface: r.surface,
      areaM2: +M2(surfaceArea(r.surface)).toFixed(1),
      axisRad,
      cutRad: r.cutRad,
    };
  });
  const laneM2 = lanes.reduce((s, q) => s + M2(surfaceArea(q)), 0);
  notes.push(
    `${block.id}：张量一级 ${seams.length} 刀 → ${outRegions.length} 个大分区` +
      `（分区中位 ${median(outRegions.map((r) => r.areaM2)).toFixed(0)} m²）· 内部步行街 ${laneM2.toFixed(0)} m²`
  );
  return { regions: outRegions, lanes, seams, notes };
}

function largest(list: PlanSurface[]): PlanSurface | null {
  let best: PlanSurface | null = null;
  let bestA = 0;
  for (const s of list) {
    const A = M2(surfaceArea(s));
    if (A >= 12 && A > bestA) {
      bestA = A;
      best = s;
    }
  }
  return best;
}

function median(list: number[]): number {
  if (list.length === 0) return 0;
  const s = list.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** FNV-1a：街区 id 混进 seed，避免所有街区拿到同一串切点 */
function idSeed(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
