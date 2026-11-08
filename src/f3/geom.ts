// F3 · 几何小工具（只在 F3 内部用）
//
// 这里**不放**任何布尔运算的替代品：并、差、交一律调 `planning/core/surface` 的
// 那一份（polygon-clipping 封装）。本文件只做"折线/环"这一层的纯几何：
// 偏移带、线裁剪、凸包、矩形、圆、旋转。

import { Pt } from '../core/geom';
import { bboxOf, insideSurface, ringArea, surfaceArea, type PlanSurface } from '../town/planning/core/surface';

export const U = (m: number): number => m / 7;
export const M2 = (u2: number): number => u2 * 49;

/** 环去重 + 去共线点，减少布尔运算的顶点数 */
export function cleanRing(ring: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of ring) {
    const last = out[out.length - 1];
    if (last && Pt.distance(last, p) < 1e-7) continue;
    out.push(new Pt(p.x, p.y));
  }
  if (out.length > 1 && Pt.distance(out[0], out[out.length - 1]) < 1e-7) out.pop();
  if (out.length < 3) return out;
  // 去掉 179.x° 的共线点
  const res: Pt[] = [];
  for (let i = 0; i < out.length; i++) {
    const a = out[(i - 1 + out.length) % out.length];
    const b = out[i];
    const c = out[(i + 1) % out.length];
    const ax = b.x - a.x;
    const ay = b.y - a.y;
    const bx = c.x - b.x;
    const by = c.y - b.y;
    const la = Math.hypot(ax, ay);
    const lb = Math.hypot(bx, by);
    if (la < 1e-9 || lb < 1e-9) continue;
    const cross = (ax * by - ay * bx) / (la * lb);
    if (Math.abs(cross) < 0.006) continue;
    res.push(b);
  }
  return res.length >= 3 ? res : out;
}

/** 折线长度（世界单位） */
export function polyLen(pts: Pt[]): number {
  let s = 0;
  for (let i = 0; i + 1 < pts.length; i++) s += Pt.distance(pts[i], pts[i + 1]);
  return s;
}

/** 折线上按弧长取样点（含端点），step 为世界单位 */
export function sampleAlong(pts: Pt[], step: number, max = 4000): { at: Pt; dir: Pt; s: number }[] {
  const out: { at: Pt; dir: Pt; s: number }[] = [];
  if (pts.length < 2) return out;
  let acc = 0;
  let nextAt = 0;
  for (let i = 0; i + 1 < pts.length && out.length < max; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const L = Pt.distance(a, b);
    if (L < 1e-9) continue;
    const dx = (b.x - a.x) / L;
    const dy = (b.y - a.y) / L;
    while (nextAt <= acc + L && out.length < max) {
      const t = nextAt - acc;
      out.push({ at: new Pt(a.x + dx * t, a.y + dy * t), dir: new Pt(dx, dy), s: nextAt });
      nextAt += step;
    }
    acc += L;
  }
  return out;
}

/**
 * 折线一侧的偏移折线（斜接）。
 *
 * `hue` 的符号决定左右：正 = 前进方向左手侧。
 * 与 `core/polyline` 的 bufferPolyline 同一套斜接算法，只是这里只要一侧 ——
 * 人行道/绿带是"带状"，用两条同侧偏移线夹出来比"大缓冲减小缓冲"稳得多
 * （后者对同一折线做两次布尔，在锐角处会吐针孔）。
 */
export function offsetSide(pts: Pt[], h: number): Pt[] | null {
  if (pts.length < 2) return null;
  const src: Pt[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) if (Pt.distance(pts[i], src[src.length - 1]) > 1e-9) src.push(pts[i]);
  if (src.length < 2) return null;

  const nrm: { nx: number; ny: number }[] = [];
  for (let i = 0; i + 1 < src.length; i++) {
    const dx = src[i + 1].x - src[i].x;
    const dy = src[i + 1].y - src[i].y;
    const L = Math.hypot(dx, dy);
    if (L < 1e-9) continue;
    nrm.push({ nx: -dy / L, ny: dx / L });
  }
  if (nrm.length === 0) return null;

  const out: Pt[] = [];
  out.push(new Pt(src[0].x + nrm[0].nx * h, src[0].y + nrm[0].ny * h));
  for (let i = 1; i + 1 < src.length; i++) {
    const a = nrm[i - 1];
    const b = nrm[i];
    const nx = a.nx + b.nx;
    const ny = a.ny + b.ny;
    const nl = Math.hypot(nx, ny);
    if (nl < 1e-9) {
      out.push(new Pt(src[i].x + a.nx * h, src[i].y + a.ny * h));
      continue;
    }
    const ux = nx / nl;
    const uy = ny / nl;
    const cosHalf = ux * a.nx + uy * a.ny;
    const k = h / Math.max(0.35, cosHalf);
    out.push(new Pt(src[i].x + ux * k, src[i].y + uy * k));
  }
  const last = nrm[nrm.length - 1];
  out.push(new Pt(src[src.length - 1].x + last.nx * h, src[src.length - 1].y + last.ny * h));
  return out;
}

/**
 * 折线一侧的带状面（h0 → h1）。h1 > h0 且同号。
 *
 * 返回环 = 外偏移正向 + 内偏移反向。尖锐转角处内偏移可能自交，
 * 由调用方决定要不要退回缓冲相减（`bandSafe`）。
 */
export function sideBand(pts: Pt[], h0: number, h1: number): Pt[] | null {
  const a = offsetSide(pts, h0);
  const b = offsetSide(pts, h1);
  if (!a || !b) return null;
  const ring = [...b, ...a.slice().reverse()];
  return cleanRing(ring);
}

/** 环自交粗检（只查非相邻边） */
export function ringSelfIntersects(ring: Pt[]): boolean {
  const n = ring.length;
  if (n < 4) return false;
  const segHit = (a: Pt, b: Pt, c: Pt, d: Pt): boolean => {
    const cr = (p: Pt, q: Pt, r: Pt) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    const d1 = cr(c, d, a);
    const d2 = cr(c, d, b);
    const d3 = cr(a, b, c);
    const d4 = cr(a, b, d);
    return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segHit(ring[i], ring[(i + 1) % n], ring[j], ring[(j + 1) % n])) return true;
    }
  }
  return false;
}

/** 凸包（单调链），用于路口多边形 */
export function convexHull(input: Pt[]): Pt[] {
  const pts = input.slice().sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  if (pts.length < 3) return pts;
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/** 圆多边形（路口铺装 / 尽端回车场） */
export function circleRing(c: Pt, r: number, seg = 18): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    out.push(new Pt(c.x + Math.cos(a) * r, c.y + Math.sin(a) * r));
  }
  return out;
}

/** 旋转点集 */
export function rotatePts(pts: Pt[], ang: number, about?: Pt): Pt[] {
  const c = about ?? new Pt(0, 0);
  const cs = Math.cos(ang);
  const sn = Math.sin(ang);
  return pts.map((p) => {
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    return new Pt(c.x + dx * cs - dy * sn, c.y + dx * sn + dy * cs);
  });
}

/** 矩形环：中心、半宽、半高、朝向 */
export function rectRing(c: Pt, hw: number, hh: number, ang: number): Pt[] {
  const cs = Math.cos(ang);
  const sn = Math.sin(ang);
  const pt = (dx: number, dy: number) => new Pt(c.x + dx * cs - dy * sn, c.y + dx * sn + dy * cs);
  return [pt(-hw, -hh), pt(hw, -hh), pt(hw, hh), pt(-hw, hh)];
}

/** 轴对齐包围盒矩形 */
export function boxRing(minX: number, minY: number, maxX: number, maxY: number): Pt[] {
  return [new Pt(minX, minY), new Pt(maxX, minY), new Pt(maxX, maxY), new Pt(minX, maxY)];
}

// ---------------------------------------------------------------- 线裁剪

interface Hit {
  t: number;
  p: Pt;
}

/** 线段与环求交（返回参数 t 与交点） */
function segRingHits(a: Pt, b: Pt, ring: Pt[]): Hit[] {
  const out: Hit[] = [];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  for (let i = 0; i < ring.length; i++) {
    const c = ring[i];
    const d = ring[(i + 1) % ring.length];
    const ex = d.x - c.x;
    const ey = d.y - c.y;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / den;
    const s = ((c.x - a.x) * dy - (c.y - a.y) * dx) / den;
    if (t < -1e-9 || t > 1 + 1e-9) continue;
    if (s < -1e-9 || s > 1 + 1e-9) continue;
    out.push({ t: Math.max(0, Math.min(1, t)), p: new Pt(a.x + dx * t, a.y + dy * t) });
  }
  return out;
}

/**
 * 把一条无限直线裁到面内，返回若干段折线（洞会把一条线切成多段）。
 *
 * 用"交点排序 + 段中点判内外"，不依赖布尔库 —— 直线裁剪是纯一维问题，
 * 交给布尔库反而会引入容差。
 */
export function clipLineToSurface(surface: PlanSurface, at: Pt, ang: number): Pt[][] {
  const dx = Math.cos(ang);
  const dy = Math.sin(ang);
  const bb = bboxOf(surface.outer);
  const R = Math.hypot(bb.maxX - bb.minX, bb.maxY - bb.minY) * 1.2 + 10;
  const a = new Pt(at.x - dx * R, at.y - dy * R);
  const b = new Pt(at.x + dx * R, at.y + dy * R);

  const hits: Hit[] = [];
  for (const ring of [surface.outer, ...surface.holes]) hits.push(...segRingHits(a, b, ring));
  hits.sort((p, q) => p.t - q.t);

  const ts: number[] = [0];
  for (const h of hits) if (h.t > 1e-6 && h.t < 1 - 1e-6 && h.t > ts[ts.length - 1] + 1e-6) ts.push(h.t);
  ts.push(1);

  const out: Pt[][] = [];
  for (let i = 0; i + 1 < ts.length; i++) {
    const t0 = ts[i];
    const t1 = ts[i + 1];
    if (t1 - t0 < 1e-6) continue;
    const m = (t0 + t1) / 2;
    const mid = new Pt(a.x + (b.x - a.x) * m, a.y + (b.y - a.y) * m);
    if (!insideSurface(mid, surface)) continue;
    out.push([
      new Pt(a.x + (b.x - a.x) * t0, a.y + (b.y - a.y) * t0),
      new Pt(a.x + (b.x - a.x) * t1, a.y + (b.y - a.y) * t1),
    ]);
  }
  return out;
}

/** 一段折线是否贴在城市红线上（中点到边界 < tol 米） */
export function nearRings(p: Pt, rings: Pt[][], tolU: number): boolean {
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l2 = dx * dx + dy * dy;
      if (l2 < 1e-12) continue;
      let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
      t = Math.max(0, Math.min(1, t));
      if (Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)) <= tolU) return true;
    }
  }
  return false;
}

/** 面到线段的最近距离（世界单位） */
export function distPointToPolyline(p: Pt, pts: Pt[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    let t = l2 < 1e-12 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)));
  }
  return best;
}

/** 面的"短轴跨度"（米）与长短轴比，判狭长用 */
export function shapeOf(s: PlanSurface): { minorM: number; majorM: number; aspect: number } {
  const ring = s.outer;
  if (ring.length < 3) return { minorM: 0, majorM: 0, aspect: 1 };
  let bestA = Infinity;
  let best: { w: number; d: number } | null = null;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    if (L < 1e-9) continue;
    const ux = (b.x - a.x) / L;
    const uy = (b.y - a.y) / L;
    let lo = Infinity;
    let hi = -Infinity;
    let lo2 = Infinity;
    let hi2 = -Infinity;
    for (const p of ring) {
      const t = p.x * ux + p.y * uy;
      const v = -p.x * uy + p.y * ux;
      lo = Math.min(lo, t);
      hi = Math.max(hi, t);
      lo2 = Math.min(lo2, v);
      hi2 = Math.max(hi2, v);
    }
    const A = (hi - lo) * (hi2 - lo2);
    if (A < bestA) {
      bestA = A;
      best = { w: hi - lo, d: hi2 - lo2 };
    }
  }
  if (!best) return { minorM: 0, majorM: 0, aspect: 1 };
  const major = Math.max(best.w, best.d);
  const minor = Math.min(best.w, best.d);
  return { minorM: minor * 7, majorM: major * 7, aspect: minor < 1e-6 ? 1 : major / minor };
}

/** 面面积（m²） */
export function areaM2(s: PlanSurface): number {
  return M2(surfaceArea(s));
}

/** 环面积（m²，带符号） */
export function ringAreaM2(ring: Pt[]): number {
  return M2(ringArea(ring));
}
