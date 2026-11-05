// F2 · 分割几何工具
//
// 只放**几何原语**，不含任何"该不该切"的判断：
//   obbOf / extents / splitSurfaceByLine / sharedBoundaryLength / makeRng
//
// 复用边界（见 PARCEL_SUBDIVISION_AUDIT.md）：
//   · 布尔与洞：`planning/core/surface` 的 surfaceIntersect / surfaceSubtract / surfaceUnion
//   · 点/面积：core/geom 的 Pt、surface.ts 的 ringArea / surfaceArea / bboxOf
//   · 这里**不重写**旧代码已有的 `bisectRing`（modern.ts）与 `insetPerEdge`（surface.ts），
//     只在它们不可用的地方补齐：带 holes 的面级切分、最小面积外接矩形、共享边界长度。

import { Pt, distToSegment } from '../../../core/geom';
import { pointInRing } from '../core/surface';
import {
  bboxOf,
  ringArea,
  surfaceArea,
  surfaceIntersect,
  type PlanSurface,
} from '../core/surface';

// ---------------------------------------------------------------- 确定性随机

/**
 * 每个策略独立的确定性随机流（mulberry32）。
 *
 * 不用全局 `Rng`：全局流被 city 生成器共用，地块分割多抽一次就会让整城错位
 * （modern.ts 里为此专门讨论过"少抽一次只影响这一块"）。
 * 用 `seed + 字符串哈希` 派生的私有流，保证"相同输入 + 相同 seed = 相同输出"。
 */
export function makeRng(seed: number, tag = ''): () => number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < tag.length; i++) {
    h ^= tag.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  let s = (seed ^ h) >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- 最小面积外接矩形

export interface Obb {
  /** 中心 */
  cx: number;
  cy: number;
  /** 长轴方向（单位向量）与其跨度 */
  ux: number;
  uy: number;
  w: number;
  /** 短轴方向（u 逆时针 90°）与其跨度 */
  vx: number;
  vy: number;
  d: number;
  /** 轴角（弧度，折到 [-π/2, π/2)） */
  ang: number;
}

/** 把角折到 [-π/2, π/2)：一条边的方向与反向是同一条轴 */
export function normalizeAxis(ang: number): number {
  let a = ang;
  while (a >= Math.PI / 2) a -= Math.PI;
  while (a < -Math.PI / 2) a += Math.PI;
  return a;
}

function extentsAlong(ring: ReadonlyArray<{ x: number; y: number }>, ux: number, uy: number) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of ring) {
    const t = p.x * ux + p.y * uy;
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  return { lo, hi, span: hi - lo };
}

/**
 * 最小面积外接矩形（旋转卡壳的暴力版：以每条边为候选轴）。
 *
 * 为什么不用 bbox：三个 Golden 场地没有一个是轴对齐的 —— MF `-469:284`
 * 的 bbox 面积是地块本身的 2.4 倍（见 skeleton/spec.ts 的注释），
 * 拿 bbox 当分割域等于在 55% 的空白上排布。
 *
 * 复杂度 O(n²)，n 是地块环顶点数（实测 ≤ 30），一次分割可忽略。
 */
export function obbOf(ring: ReadonlyArray<{ x: number; y: number }>): Obb | null {
  const n = ring.length;
  if (n < 3) return null;
  let best: Obb | null = null;
  let bestArea = Infinity;
  const seen: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    if (L < 1e-9) continue;
    const ang = normalizeAxis(Math.atan2(b.y - a.y, b.x - a.x));
    // 相邻近共线的边跳过（Voronoi 折线有大量 1~2° 的碎边）
    if (seen.some((q) => Math.abs(q - ang) < 1e-4)) continue;
    seen.push(ang);
    const ux = Math.cos(ang);
    const uy = Math.sin(ang);
    const vx = -uy;
    const vy = ux;
    const eu = extentsAlong(ring, ux, uy);
    const ev = extentsAlong(ring, vx, vy);
    const area = eu.span * ev.span;
    if (area < bestArea) {
      bestArea = area;
      const cu = (eu.lo + eu.hi) / 2;
      const cv = (ev.lo + ev.hi) / 2;
      // 让 u 永远是**长轴**：策略层统一按"沿长轴切"实现递归 OBB
      const swap = eu.span < ev.span;
      best = {
        cx: cu * ux + cv * vx,
        cy: cu * uy + cv * vy,
        ux: swap ? vx : ux,
        uy: swap ? vy : uy,
        w: swap ? ev.span : eu.span,
        vx: swap ? ux : vx,
        vy: swap ? uy : vy,
        d: swap ? eu.span : ev.span,
        ang: swap ? normalizeAxis(ang + Math.PI / 2) : ang,
      };
    }
  }
  return best;
}

/** 沿任意方向 dir 的跨度与中心投影 */
export function extentAlong(ring: ReadonlyArray<{ x: number; y: number }>, ang: number) {
  const ux = Math.cos(ang);
  const uy = Math.sin(ang);
  return extentsAlong(ring, ux, uy);
}

// ---------------------------------------------------------------- 面级切分

export interface SplitResult {
  /** 刀口正侧（+法线）的多块：凹多边形一刀可能切出多块 */
  a: PlanSurface[];
  /** 刀口负侧 */
  b: PlanSurface[];
  /** 刀口线段（只用于画图与报告，不是数据合同） */
  seg: [Pt, Pt] | null;
}

/**
 * 用一条**无限直线**把面切成两半（保留 holes）。
 *
 * 与 `modern.ts` 的 `bisectRing` 的差别（这是本阶段必须补齐的缺口）：
 *   ① 输入是 PlanSurface，洞被保留；`bisectRing` 只吃 `Pt[]`，洞直接消失；
 *   ② 两侧都返回**全部连通块**；`bisectRing` 只取面积最大的那块，
 *      凹多边形一刀切出的第二个瓣被静默丢掉（G05 L 形会踩到）；
 *   ③ 返回值带刀口线段，切分树与可视化都要它。
 *
 * 实现本身没有新算法：半平面矩形 + `surfaceIntersect`，与既有做法同一套。
 */
export function splitSurfaceByLine(s: PlanSurface, at: Pt, ang: number): SplitResult | null {
  if (s.outer.length < 3) return null;
  const ux = Math.cos(ang);
  const uy = Math.sin(ang);
  // 法线 = 刀口方向逆时针 90°
  const nx = -uy;
  const ny = ux;
  const bb = bboxOf(s.outer);
  const span = Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY, 1);
  const R = span * 3 + 1;

  const half = (sign: number): PlanSurface => {
    // 沿法向让开 1e-4：刀口正好压在多边形顶点上时布尔会吐零宽碎瓣
    const ox = at.x + nx * sign * 1e-4;
    const oy = at.y + ny * sign * 1e-4;
    const tx = ux * R;
    const ty = uy * R;
    const sx = nx * sign * R;
    const sy = ny * sign * R;
    return {
      outer: [
        new Pt(ox - tx, oy - ty),
        new Pt(ox + tx, oy + ty),
        new Pt(ox + tx + sx, oy + ty + sy),
        new Pt(ox - tx + sx, oy - ty + sy),
      ],
      holes: [],
    };
  };

  const sideOf = (sign: number) => {
    const parts = surfaceIntersect([s], [half(sign)]);
    return parts.filter((p) => surfaceArea(p) > 1e-6);
  };

  const a = sideOf(1);
  const b = sideOf(-1);
  if (a.length === 0 || b.length === 0) return null;

  return { a, b, seg: seamOf(s, at, ang) };
}

/** 刀口与面边界的两个最远交点（纯展示用；多连通面上取极值两点） */
function seamOf(s: PlanSurface, at: Pt, ang: number): [Pt, Pt] | null {
  const ux = Math.cos(ang);
  const uy = Math.sin(ang);
  const ts: number[] = [];
  const rings = [s.outer, ...s.holes];
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % ring.length];
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      // 解 p + t*d = at + s*dir
      const den = ux * dy - uy * dx;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((p.x - at.x) * dy - (p.y - at.y) * dx) / den;
      const u = (p.x - at.x + ux * t) / (dx || 1e-12);
      if (u < -1e-9 || u > 1 + 1e-9) continue;
      ts.push(t);
    }
  }
  if (ts.length < 2) return null;
  ts.sort((x, y) => x - y);
  const t0 = ts[0];
  const t1 = ts[ts.length - 1];
  return [
    new Pt(at.x + ux * t0, at.y + uy * t0),
    new Pt(at.x + ux * t1, at.y + uy * t1),
  ];
}

/** 把多个连通块合并成一块（失败就原样返回）：策略内部收拢用 */
export function mergeParts(parts: PlanSurface[]): PlanSurface | null {
  const list = parts.filter((p) => p.outer.length >= 3 && surfaceArea(p) > 1e-9);
  if (list.length === 0) return null;
  if (list.length === 1) return list[0];
  let best = list[0];
  let bestA = surfaceArea(best);
  for (const p of list) {
    const a = surfaceArea(p);
    if (a > bestA) {
      best = p;
      bestA = a;
    }
  }
  return best;
}

// ---------------------------------------------------------------- 邻接关系

/**
 * 两块地的共享边界长度（米）。
 *
 * 采样法而不是解析法：两块地从同一次切分出来，共享边在数值上"几乎完全重合"
 * （布尔运算会把坐标量化到 1e-6），解析求共线区间对 1e-9 级偏差极脆，
 * 而采样只要容差合理就稳。步长 0.15 单位 ≈ 1 m。
 */
export function sharedBoundaryLength(a: PlanSurface, b: PlanSurface, tol = 0.08): number {
  if (a.outer.length < 3 || b.outer.length < 3) return 0;
  const rings = [b.outer, ...b.holes];
  let hits = 0;
  const step = 0.15;
  const count = (from: PlanSurface, to: Pt[][]) => {
    let c = 0;
    for (let i = 0; i < from.outer.length; i++) {
      const p = from.outer[i];
      const q = from.outer[(i + 1) % from.outer.length];
      const L = Pt.distance(p, q);
      if (L < 1e-9) continue;
      const n = Math.max(1, Math.ceil(L / step));
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) / n;
        const x = p.x + (q.x - p.x) * t;
        const y = p.y + (q.y - p.y) * t;
        for (const ring of to) {
          let hit = false;
          for (let j = 0; j < ring.length; j++) {
            const s0 = ring[j];
            const s1 = ring[(j + 1) % ring.length];
            if (distToSegment(new Pt(x, y), s0, s1) <= tol) {
              hit = true;
              break;
            }
          }
          if (hit) {
            c += L / n;
            break;
          }
        }
      }
    }
    return c;
  };
  hits += count(a, rings);
  // 双向量一次取较小值：单侧采样会在"薄片贴厚块"时高估
  const back = count(b, [a.outer, ...a.holes]);
  return Math.min(hits, back) * 7; // 世界单位 → 米
}

// ---------------------------------------------------------------- 环工具

/** 环的顶点平均（分割刀口定位用；不做面积加权，理由见注释） */
export function centroidOf(ring: ReadonlyArray<{ x: number; y: number }>): Pt {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p.x;
    y += p.y;
  }
  const n = Math.max(1, ring.length);
  return new Pt(x / n, y / n);
}

/** 环是否 CCW（用于统一方向后送布尔） */
export function isCcw(ring: ReadonlyArray<{ x: number; y: number }>): boolean {
  return ringArea(ring as Pt[]) > 0;
}

/** 统一成 CCW 外环；洞统一成 CW（与 polygon-clipping 的期望一致） */
export function orientSurface(s: PlanSurface): PlanSurface {
  const outer = isCcw(s.outer) ? s.outer.slice() : s.outer.slice().reverse();
  const holes = s.holes.map((h) => (isCcw(h) ? h.slice().reverse() : h.slice()));
  return { outer, holes };
}

/** 周长（外环 + 洞） */
export function perimeterOf(s: PlanSurface): number {
  let p = 0;
  for (const ring of [s.outer, ...s.holes]) {
    for (let i = 0; i < ring.length; i++) {
      p += Pt.distance(ring[i], ring[(i + 1) % ring.length]);
    }
  }
  return p;
}

/** 最短边长 */
export function minEdgeOf(s: PlanSurface): number {
  let best = Infinity;
  for (const ring of [s.outer, ...s.holes]) {
    for (let i = 0; i < ring.length; i++) {
      const d = Pt.distance(ring[i], ring[(i + 1) % ring.length]);
      if (d > 1e-9 && d < best) best = d;
    }
  }
  return Number.isFinite(best) ? best : 0;
}

/** 内角 < `deg` 的顶点数（尖角诊断） */
export function acuteCorners(s: PlanSurface, deg = 30): number {
  const limit = (deg * Math.PI) / 180;
  let n = 0;
  for (const ring of [s.outer]) {
    const m = ring.length;
    for (let i = 0; i < m; i++) {
      const prev = ring[(i - 1 + m) % m];
      const cur = ring[i];
      const next = ring[(i + 1) % m];
      const ax = prev.x - cur.x;
      const ay = prev.y - cur.y;
      const bx = next.x - cur.x;
      const by = next.y - cur.y;
      const la = Math.hypot(ax, ay);
      const lb = Math.hypot(bx, by);
      if (la < 1e-9 || lb < 1e-9) continue;
      const cos = Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)));
      if (Math.acos(cos) < limit) n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- 重叠面积

/**
 * 两块面的重叠面积（m²），**带采样降级**。
 *
 * 为什么不能只用精确求交：`polygon-clipping` 在"两条边几乎完全重合但不完全重合"的
 * 输入上会抛 `Unable to complete output ring` —— 而"地块减掉固定建筑"产生的边界
 * 与被减的那栋楼必然共享同一条边，于是 `intersect(楼, 地块)` 正好踩这个坑。
 * 实测 C01 第 12 栋 450 m² 的楼对所有地块的精确重叠都返回 0（并计一次静默失败），
 * 归属判断因此落空，验证层报"该建筑不在任何地块内"。
 *
 * 这里的语义是**测量**（谁占了这栋楼多少），不是几何修改，所以用采样兜底是合适的：
 * 不改变任何面，只给出一个面积估计。精度 0.3 单位网格（≈2 m），对"归属唯一"足够。
 */
export function overlapAreaM2(a: PlanSurface, b: PlanSurface): { m2: number; exact: boolean } {
  try {
    const q = surfaceIntersect([a], [b]);
    const u2 = q.reduce((s, r) => s + surfaceArea(r), 0);
    if (u2 > 1e-9) return { m2: u2 * 49, exact: true };
    // 求交"成功但为空"：可能真的不相交，也可能被退化输入骗了。用采样复核一次。
    const est = sampleOverlapU2(a, b);
    return { m2: est * 49, exact: est < 1e-9 };
  } catch {
    return { m2: sampleOverlapU2(a, b) * 49, exact: false };
  }
}

function sampleOverlapU2(a: PlanSurface, b: PlanSurface): number {
  const bb = bboxOf(a.outer);
  const step = 0.3; // ≈2.1 m
  const inA = (p: Pt) => {
    if (!pointInRing(p, a.outer)) return false;
    for (const h of a.holes) if (pointInRing(p, h)) return false;
    return true;
  };
  const inB = (p: Pt) => {
    if (!pointInRing(p, b.outer)) return false;
    for (const h of b.holes) if (pointInRing(p, h)) return false;
    return true;
  };
  let hits = 0;
  let total = 0;
  for (let x = bb.minX + step / 2; x < bb.maxX; x += step) {
    for (let y = bb.minY + step / 2; y < bb.maxY; y += step) {
      const p = new Pt(x, y);
      if (!inA(p)) continue;
      total++;
      if (inB(p)) hits++;
    }
  }
  if (total === 0) return 0;
  return hits * step * step;
}
