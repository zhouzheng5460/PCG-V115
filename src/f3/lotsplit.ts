// F3-E · 地块/街区的随机二叉分割（random binary split）
//
// 按《houdini 路网》(1) 的做法：对一个 poly 不断横竖对半切，得到不规则的 pattern。
// 这一层**只负责切地**，不负责摆建筑 —— 建筑布局按《houdini 路网 (3)》的
// 场景规则放在 `layout.ts` 里，两者不要混。

import { Pt } from '../core/geom';
import { insideSurface, surfaceArea, surfaceIntersect, type PlanSurface } from '../town/planning/core/surface';
import { makeRng, splitSurfaceByLine } from '../town/planning/subdivision/geom';
import { M2, U, cleanRing, distPointToPolyline } from './geom';

// ---------------------------------------------------------------- 几何小工具

export function centroidOf(ring: Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p.x;
    y += p.y;
  }
  return new Pt(x / Math.max(1, ring.length), y / Math.max(1, ring.length));
}

interface Frame {
  /** 沿 ang 的跨度（世界单位） */
  w: number;
  /** 垂直 ang 的跨度 */
  h: number;
}

/** 面在给定朝向上的外接框尺寸 —— 切分时只需要一个"能切多宽"的量 */
function frameOf(ring: Pt[], ang: number): Frame {
  const ux = Math.cos(ang);
  const uy = Math.sin(ang);
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (const p of ring) {
    const u = p.x * ux + p.y * uy;
    const v = -p.x * uy + p.y * ux;
    u0 = Math.min(u0, u);
    u1 = Math.max(u1, u);
    v0 = Math.min(v0, v);
    v1 = Math.max(v1, v);
  }
  return { w: u1 - u0, h: v1 - v0 };
}

/** 沿法线 (nx,ny) 的投影区间 */
function spanAlong(ring: Pt[], nx: number, ny: number): { lo: number; hi: number } {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of ring) {
    const t = p.x * nx + p.y * ny;
    lo = Math.min(lo, t);
    hi = Math.max(hi, t);
  }
  return { lo, hi };
}

/**
 * 轮廓是否真的落在面里（允许贴边 3 cm），与验收用的 `ringInside` 同一判据。
 *
 * 注意：不规则细长块**不能**用 bbox 3×3 采样 —— 大半采样点本来就在块外，
 * 会把合法轮廓全判成越界（实测占地率 29% → 18%）。洞用"洞顶点是否落进轮廓"查。
 */
export function ringFits(ring: Pt[], s: PlanSurface): boolean {
  const probes: Pt[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    probes.push(a);
    probes.push(new Pt((a.x + b.x) / 2, (a.y + b.y) / 2));
    probes.push(new Pt(a.x * 0.75 + b.x * 0.25, a.y * 0.75 + b.y * 0.25));
    probes.push(new Pt(a.x * 0.25 + b.x * 0.75, a.y * 0.25 + b.y * 0.75));
  }
  if (s.holes.length > 0) {
    const asSurface: PlanSurface = { outer: cleanRing(ring), holes: [] };
    for (const h of s.holes) {
      for (const p of h) if (insideSurface(p, asSurface)) return false;
    }
  }
  const tolU = 0.025;
  return probes.every(
    (p) =>
      insideSurface(p, s) ||
      distPointToPolyline(p, s.outer) <= tolU ||
      s.holes.some((h) => distPointToPolyline(p, h) <= tolU)
  );
}

/** 把矩形裁回地块（保留 holes 的排除），取面积最大的无洞连通块 */
export function clipToSurface(ring: Pt[], s: PlanSurface): Pt[] | null {
  try {
    const parts = surfaceIntersect([{ outer: cleanRing(ring), holes: [] }], [s]);
    let best: PlanSurface | null = null;
    let bestA = 0;
    for (const q of parts) {
      if (q.holes.length > 0) continue;
      const a = Math.abs(surfaceArea(q));
      if (a > bestA) {
        bestA = a;
        best = q;
      }
    }
    return best && best.outer.length >= 3 ? best.outer : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 二叉分割

export interface BinarySplitOpts {
  seed: number;
  /** 主轴向（弧度）：偶数层沿它切，奇数层垂直它切 —— 交替才不会切出一堆细条 */
  axisRad: number;
  /** 目标子块面积（m²）：切到接近它就停 */
  targetM2: number;
  /** 小于这个面积不再切 */
  minM2: number;
  /** 最小可盖边宽（米）：窄于它再切就只能出纸片 */
  minSideM: number;
  maxDepth: number;
  /**
   * 刀角抖动（弧度），默认 0 = **严格横竖切**。
   *
   * 《houdini 路网 (3)》图 1「随机分割」原文：对一个地块不断进行「横竖分割」，
   * 切出的小块在规则街区下就是矩形；文中还明确「商业区地块最好大多数搞成矩形」。
   * 旧版 ±16° 抖动虽避免了尖角，却把矩形街区切成一堆斜边梯形（实测矩形度
   * p50 仅 0.81、66% 地块被判不规则），两排建筑那条规则形同虚设。
   * 现在由**切点位置**（32%~68%）而非刀角产生大小变化；非矩形街区本身是斜的，
   * 正交刀切出来依旧是异形，正合文中「非矩形地块出异形建筑与现实吻合」。
   */
  jitterRad?: number;
}

/**
 * 随机二叉分割。
 *
 * 与"取最大块一路二分"的区别：每个子块**各自递归**（走栈，不挑最大），
 * 否则小块的递归深度永远落后，最后得到"一大块 + 一堆碎渣"。
 * 刀角是**轴交替的正交横竖切**（文中原话），大小变化来自切点位置；
 * 非矩形街区切出来自然还是异形，不需要人为把刀歪过去。
 */
export function binarySplit(surface: PlanSurface, o: BinarySplitOpts): PlanSurface[] {
  const rng = makeRng(o.seed, 'binary-split');
  const out: PlanSurface[] = [];
  const stack: { s: PlanSurface; d: number }[] = [{ s: surface, d: 0 }];
  let guard = 0;

  while (stack.length > 0 && guard++ < 300) {
    const it = stack.pop() as { s: PlanSurface; d: number };
    const A = M2(surfaceArea(it.s));
    const fr = frameOf(it.s.outer, o.axisRad);
    const shortSideM = Math.min(fr.w, fr.h) * 7;
    const stop =
      A <= o.targetM2 * 1.15 || A < o.minM2 * 1.9 || it.d >= o.maxDepth || shortSideM < o.minSideM * 1.7;
    if (stop) {
      out.push(it.s);
      continue;
    }
    const parts = cutOnce(it.s, it.d, o, rng);
    if (!parts) {
      out.push(it.s);
      continue;
    }
    for (const q of parts) stack.push({ s: q, d: it.d + 1 });
  }
  return out;
}

function cutOnce(s: PlanSurface, depth: number, o: BinarySplitOpts, rng: () => number): PlanSurface[] | null {
  const axis = depth % 2 === 0 ? o.axisRad : o.axisRad + Math.PI / 2;
  const c = centroidOf(s.outer);

  for (let attempt = 0; attempt < 4; attempt++) {
    const ang = axis + (rng() - 0.5) * 2 * (o.jitterRad ?? 0);
    const nx = -Math.sin(ang);
    const ny = Math.cos(ang);
    const sp = spanAlong(s.outer, nx, ny);
    const span = sp.hi - sp.lo;
    if (span < U(7)) return null;
    // 切点落在 32%~68%：太靠边一定切出纸片，重试
    const t = sp.lo + span * (0.32 + rng() * 0.36);
    const off = t - (c.x * nx + c.y * ny);
    const at = new Pt(c.x + nx * off, c.y + ny * off);

    const r = splitSurfaceByLine(s, at, ang);
    if (!r) continue;
    const parts = [...r.a, ...r.b].filter((q) => M2(surfaceArea(q)) > 16);
    if (parts.length < 2) continue;
    // 面积失衡（一边不到 12%）说明刀切歪了：换个角度重试
    const tot = parts.reduce((acc, q) => acc + M2(surfaceArea(q)), 0);
    const minA = Math.min(...parts.map((q) => M2(surfaceArea(q))));
    if (minA < tot * 0.12) continue;
    return parts;
  }
  return null;
}
