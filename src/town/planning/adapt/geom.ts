// F2.4-A · 布局几何原语
//
// 只做三件事：造矩形、量"能放多大的圆"、在区域里**搜索**一处能放下该矩形的位置。
//
// 为什么不直接用多边形质心当锚点：
// 质心对 L 形、梯形、带洞地块毫无意义（可能落在凹口或洞里）。
// 这里用的是**clearance field**（每个采样点到边界的距离），
// 它才是"这块地哪里最宽敞"的直接度量，锚点由它决定，而不是由面积积分决定。

import { Pt, distToSegment } from '../../../core/geom';
import {
  bboxOf,
  distToSurfaceEdge,
  pointInRing,
  surfaceArea,
  surfaceIntersect,
  surfaceSubtract,
  type PlanSurface,
} from '../core/surface';

/** 米 → 世界单位（全工程唯一换算） */
export const U = (m: number) => m / 7;
export const toM = (u: number) => u * 7;

/** 轴角折到 (-90°, 90°]：一条轴的正反向是同一条轴 */
export function foldAxis(ang: number): number {
  let a = ang;
  while (a > Math.PI / 2) a -= Math.PI;
  while (a <= -Math.PI / 2) a += Math.PI;
  return a;
}

/** 两轴夹角（度，0~90） */
export function axisDeltaDeg(a: number, b: number): number {
  const d = Math.abs(foldAxis(a) - foldAxis(b));
  return (Math.min(d, Math.PI - d) * 180) / Math.PI;
}

/**
 * 以 `center` 为中心、长轴 `ang`、面宽 `w`、进深 `d` 的矩形（世界单位）。
 * 顶点顺序保证 CCW（u → v，v 在 u 左侧）。
 */
export function rectSurface(center: Pt, ang: number, w: number, d: number): PlanSurface {
  const ux = Math.cos(ang);
  const uy = Math.sin(ang);
  const vx = -uy;
  const vy = ux;
  const hw = w / 2;
  const hd = d / 2;
  const at = (a: number, b: number) => new Pt(center.x + ux * a + vx * b, center.y + uy * a + vy * b);
  return { outer: [at(-hw, -hd), at(hw, -hd), at(hw, hd), at(-hw, hd)], holes: [] };
}

export interface ClearPoint {
  at: Pt;
  /** 到边界（含洞）的距离，世界单位 */
  clear: number;
}

export interface ClearField {
  pts: ClearPoint[];
  /** 最宽敞的点（= 可用空间核心） */
  core: ClearPoint | null;
  stepU: number;
}

/**
 * clearance field：网格采样 + 到边界距离。
 *
 * 这是"可用空间核心"的定义来源。对矩形它落在几何中心附近，
 * 对 L 形它落在转角的大块里，对带洞的地块它离洞最远 —— 这三点正是质心做不到的。
 */
export function clearanceField(area: PlanSurface, gridM = 2): ClearField {
  const bb = bboxOf(area.outer);
  const stepU = Math.max(U(gridM), 0.02);
  const pts: ClearPoint[] = [];
  let core: ClearPoint | null = null;
  for (let x = bb.minX + stepU / 2; x < bb.maxX; x += stepU) {
    for (let y = bb.minY + stepU / 2; y < bb.maxY; y += stepU) {
      const p = new Pt(x, y);
      if (!inside(area, p)) continue;
      const c = distToSurfaceEdge(p, area);
      const cp = { at: p, clear: c };
      pts.push(cp);
      if (!core || c > core.clear) core = cp;
    }
  }
  return { pts, core, stepU };
}

export function inside(s: PlanSurface, p: Pt): boolean {
  if (!pointInRing(p, s.outer)) return false;
  for (const h of s.holes) if (pointInRing(p, h)) return false;
  return true;
}

/** 矩形是否完全落在区域内（返回越出面积，世界单位²） */
export function outsideArea(rect: PlanSurface, area: PlanSurface): number {
  try {
    const out = surfaceSubtract([rect], [area]);
    return out.reduce((s, q) => s + surfaceArea(q), 0);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export interface PlaceOpts {
  /** 长轴 */
  ang: number;
  /** 目标面宽 / 进深（世界单位） */
  w: number;
  d: number;
  /**
   * 位置偏好：给每个候选点打分（越大越优先）。
   * 默认用 clearance（= 尽量居中）；各 typology 用它把建筑拉向街道 / 院落 / 后方。
   */
  prefer?: (p: Pt, clear: number) => number;
  /** 允许多次缩小的下限（0.6 = 最多缩到目标的 60%） */
  minScale?: number;
  /** 已经摆好的建筑（新建筑不许压上去） */
  avoid?: PlanSurface[];
}

export interface PlacedRect {
  surface: PlanSurface;
  center: Pt;
  /** 实际使用缩放（1 = 目标尺寸） */
  scale: number;
  /** 越出面积（应 ≈ 0） */
  outside: number;
  /** 中心处的 clearance（世界单位） */
  clear: number;
}

/** 矩形外接包围盒 */
function bboxOfSurface(s: PlanSurface) {
  return bboxOf(s.outer);
}

function aabbHit(a: { minX: number; minY: number; maxX: number; maxY: number }, b: { minX: number; minY: number; maxX: number; maxY: number }) {
  return a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
}

/** 矩形（局部系）在区域内：5×5 采样全部落在区域内且不在洞里 */
function rectSampledInside(area: PlanSurface, center: Pt, ang: number, w: number, d: number): boolean {
  const ux = Math.cos(ang);
  const uy = Math.sin(ang);
  const vx = -uy;
  const vy = ux;
  const N = 4;
  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= N; j++) {
      const a = (i / N - 0.5) * w;
      const b = (j / N - 0.5) * d;
      if (!inside(area, new Pt(center.x + ux * a + vx * b, center.y + uy * a + vy * b))) return false;
    }
  }
  return true;
}

/**
 * 在区域里找一处能放下 `w × d` 矩形的**最佳位置**。
 *
 * 判据三层，从便宜到精确：
 *   ① 必要条件：中心 clearance ≥ 内切圆半径 min(w,d)/2
 *      —— 注意**不是**外接半对角线。早先按半对角线判，等于要求"整块地能塞下一个直径 = 对角线 的圆"，
 *      一条 60×22 m 的厂房需要 32 m 净半径，几乎没有任何真实地块满足，结果是一栋都放不下（实测 I01）。
 *   ② 5×5 采样：矩形的 25 个内部点必须全在区域内（洞会被这一步抓到）；
 *   ③ 精确布尔复核：越出面积必须 ≈ 0。
 * 全都不行就按 0.94 逐步缩小，直到 `minScale`；仍不行返回 null（由调用方拒绝）。
 */
export function placeRect(area: PlanSurface, field: ClearField, o: PlaceOpts): PlacedRect | null {
  const minScale = o.minScale ?? 0.6;
  const prefer = o.prefer ?? ((_p: Pt, c: number) => c);
  const avoid = (o.avoid ?? []).map((s) => bboxOfSurface(s));

  for (let scale = 1; scale >= minScale - 1e-9; scale *= 0.94) {
    const w = o.w * scale;
    const d = o.d * scale;
    const need = (Math.min(w, d) / 2) * 0.95;
    const cands = field.pts
      .filter((c) => c.clear >= need)
      .map((c) => ({ c, score: prefer(c.at, c.clear) }))
      .sort((a, b) => b.score - a.score || a.c.at.x - b.c.at.x || a.c.at.y - b.c.at.y)
      .slice(0, 90);
    for (const { c } of cands) {
      const rect = rectSurface(c.at, o.ang, w, d);
      const rb = bboxOf(rect.outer);
      let blocked = false;
      for (let k = 0; k < avoid.length; k++) {
        if (!aabbHit(rb, avoid[k])) continue;
        // AABB 相交才做采样：矩形 5×5 的任一采样点落在已有建筑里就算压上
        if (rectOverlapsSurface(rect, o.ang, w, d, o.avoid![k])) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      if (!rectSampledInside(area, c.at, o.ang, w, d)) continue;
      const out = outsideArea(rect, area);
      if (out > 0.01) continue;
      // 采样只排除"大块压上"，边缘薄贴会漏 —— 通过采样后做一次精确求交（代价可控，
      // 因为走到这里的候选很少）。实测 C01 曾有 6.1 m² 的贴边重叠漏网。
      if (o.avoid && o.avoid.length > 0) {
        let ov = 0;
        for (const a of o.avoid) {
          try {
            ov += surfaceIntersect([rect], [a]).reduce((t, q) => t + surfaceArea(q), 0);
          } catch {
            /* 计数在验证层统一读 */
          }
        }
        if (ov > 0.02) continue;
      }
      return { surface: rect, center: c.at, scale, outside: out, clear: c.clear };
    }
  }
  return null;
}

/** 矩形是否与某块面重叠（采样法：够用且不贵） */
function rectOverlapsSurface(rect: PlanSurface, ang: number, w: number, d: number, other: PlanSurface): boolean {
  const c = rect.outer.reduce((acc, q) => new Pt(acc.x + q.x / 4, acc.y + q.y / 4), new Pt(0, 0));
  const ux = Math.cos(ang);
  const uy = Math.sin(ang);
  const vx = -uy;
  const vy = ux;
  for (let i = 0; i <= 4; i++) {
    for (let j = 0; j <= 4; j++) {
      const a = (i / 4 - 0.5) * w;
      const b = (j / 4 - 0.5) * d;
      if (inside(other, new Pt(c.x + ux * a + vx * b, c.y + uy * a + vy * b))) return true;
    }
  }
  return false;
}

/** 点到一条线段所在直线的垂足（并夹在该段内） */
export function projectOnSegment(p: Pt, a: Pt, b: Pt): { at: Pt; t: number; dist: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L2 = dx * dx + dy * dy;
  if (L2 < 1e-12) return { at: a, t: 0, dist: Pt.distance(p, a) };
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
  const at = new Pt(a.x + dx * t, a.y + dy * t);
  return { at, t, dist: Pt.distance(p, at) };
}

/** 点到环的距离（用于"门离临街线多远"这类度量） */
export function distToRing(p: Pt, ring: Pt[]): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const d = distToSegment(p, ring[i], ring[(i + 1) % ring.length]);
    if (d < best) best = d;
  }
  return best;
}

/** 沿法线内侧、离某条边 `dist` 的点（前场定位用） */
export function offsetFromEdge(a: Pt, b: Pt, dist: number, inward: Pt): Pt {
  const mid = new Pt((a.x + b.x) / 2, (a.y + b.y) / 2);
  return new Pt(mid.x + inward.x * dist, mid.y + inward.y * dist);
}

/** 多边形质心（顶点平均）——只用于对照基线，不作为锚点 */
export function vertexCentroid(ring: Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p.x;
    y += p.y;
  }
  const n = Math.max(1, ring.length);
  return new Pt(x / n, y / n);
}
