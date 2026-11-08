// F3 · 道路用地面的圆角化
//
// 用户口径：地块是从**路网闭合面**里扣出来的范围，所以「完整的路口 + 圆角」
// 必须是这张路网面自己的形状，而不是事后在角上贴一块铺装再去单独减街区。
//
// 一张路网面 R 的拓扑是：外环沿城市红线，内部有若干洞 —— 每个洞就是一个
// 被道路围合的街区。街区的 90° 凸角，在 R 上看是洞环的凸角（或外环的凹角）。
// 把街区角磨圆 = 让 R 在那个角上多占一点，于是：
//   · 外环的**凹角** → 填一段外凸圆弧（V 被包进 R 内部）；
//   · 洞环的**凸角** → 削成一段圆弧（洞缩小，街区角变圆）。
// 两者都是对**同一张闭合面**的形态学操作，不做布尔、不并任何补丁片，
// 因此 R 的外边界、洞边界与后面所有派生层天然同源。
//
// 这是 pure ring 操作：O(顶点数)，顶点只增不减地局部替换，不会引入自交
// （切点被限制在相邻边长的 44% 以内）。

import { Pt } from '../core/geom';
import { ringArea, selfIntersects, type PlanSurface } from '../town/planning/core/surface';
import { cleanRing } from './geom';

const TAU = Math.PI * 2;

/**
 * 圆角半径可以是常数，也可以是「按角点位置取值」的函数。
 *
 * 四级断面（车行 / 路缘 / 人行 / 绿带）在同一个路口角上必须共用**同一个
 * 圆心**：内层（车行面）的圆弧半径要加上它到最外层的断面宽度差，否则
 * 四层各自圆角化只会让圆角出现在最外圈，路面（沥青 ↔ 铺装那条路缘线）
 * 仍然是直角。
 */
export type Radius = number | ((v: Pt) => number);

function radiusAt(r: Radius, v: Pt): number {
  const x = typeof r === 'function' ? r(v) : r;
  return Number.isFinite(x) && x > 0 ? x : 0;
}

/** 点到线段的距离（世界单位） */
function pointSegDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-18) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

/**
 * 折线简化（保留首尾，在线容差）。
 *
 * 道路中心线是逐米采样出来的，缓冲 / 布尔并集之后，街角两侧会留下
 * 一串 3 cm 级的微边。圆角的切点必须落在相邻边上，微边会把半径
 * 压到几乎为 0（实测 2528 个街角只有 50 个放得下 6 m 圆角）。
 * 容差 15 cm 只消化离散化折点，不改变道路的实际走向。
 */
export function simplifyPolyline(pts: Pt[], tol: number): Pt[] {
  if (pts.length <= 2 || tol <= 0) return pts.slice();
  let src = pts.slice();
  for (let pass = 0; pass < 3; pass++) {
    const out: Pt[] = [src[0]];
    for (let i = 1; i < src.length - 1; i++) {
      const a = out[out.length - 1];
      const b = src[i];
      const c = src[i + 1];
      if (pointSegDist(b, a, c) < tol) continue;
      out.push(b);
    }
    out.push(src[src.length - 1]);
    if (out.length === src.length) break;
    src = out;
  }
  return src;
}

/** 闭环简化：拆成首尾同点的开链，简化后去掉重复尾点 */
function simplifyRing(ring: Pt[], tol: number): Pt[] {
  if (ring.length < 4 || tol <= 0) return ring.slice();
  const s = simplifyPolyline([...ring, ring[0]], tol);
  s.pop();
  return s.length >= 3 ? s : ring.slice();
}

/** 把角度归一到 (-π, π] */
function wrap(a: number): number {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
}

/** 角区间 a1 → a1+delta 是否经过 am */
function arcPasses(a1: number, delta: number, am: number): boolean {
  const rel = wrap(am - a1);
  return delta >= 0 ? rel >= -1e-6 && rel <= delta + 1e-6 : rel <= 1e-6 && rel >= delta - 1e-6;
}

/**
 * 在 T1→T2 之间按经过 am 的方向采样圆弧（不含两端点）。
 *
 * 一条圆角弧永远不会超过 π：90° 街角的弧就是 90°，最锐的路口也就 120° 左右。
 * 一旦算出来接近「一整圈」（|delta| > 2.2 rad），说明选向选反了 —— 圆弧会
 * 绕到外侧再回来，画出来就是路口角上的**星形/尖刺**（用户红圈）。
 * 这时强制走短边，宁可圆角小一点，也不吐一圈自交的弧。
 */
function arcPoints(C: Pt, r: number, a1: number, a2: number, am: number, segs: number): Pt[] {
  let delta = a2 - a1;
  while (delta > Math.PI) delta -= TAU;
  while (delta < -Math.PI) delta += TAU;
  if (!arcPasses(a1, delta, am)) delta -= Math.sign(delta || 1) * TAU;
  if (Math.abs(delta) > 2.2) {
    // 选向反了：改走另一侧（短弧）
    delta = -Math.sign(delta) * (TAU - Math.abs(delta));
    if (!arcPasses(a1, delta, am)) delta = -delta;
  }
  const out: Pt[] = [];
  for (let k = 1; k < segs; k++) {
    const a = a1 + (delta * k) / segs;
    out.push(new Pt(C.x + Math.cos(a) * r, C.y + Math.sin(a) * r));
  }
  return out;
}

interface Corner {
  /** 两条边从顶点指向相邻顶点的单位向量 */
  u1x: number;
  u1y: number;
  u2x: number;
  u2y: number;
  l1: number;
  l2: number;
  cross: number;
  theta: number;
  bisx: number;
  bisy: number;
}

/** 量一个角；返回 null 表示不该处理（凹角/共线/退化） */
function measure(V: Pt, P: Pt, Q: Pt): Corner | null {
  const l1 = Math.hypot(P.x - V.x, P.y - V.y);
  const l2 = Math.hypot(Q.x - V.x, Q.y - V.y);
  if (l1 < 1e-9 || l2 < 1e-9) return null;
  const u1x = (P.x - V.x) / l1;
  const u1y = (P.y - V.y) / l1;
  const u2x = (Q.x - V.x) / l2;
  const u2y = (Q.y - V.y) / l2;
  const cross = u1x * u2y - u1y * u2x;
  const theta = Math.acos(Math.max(-1, Math.min(1, u1x * u2x + u1y * u2y)));
  const sx = u1x + u2x;
  const sy = u1y + u2y;
  const sl = Math.hypot(sx, sy);
  if (sl < 1e-6 || theta < 0.18 || theta > Math.PI - 0.12) return null;
  return { u1x, u1y, u2x, u2y, l1, l2, cross, theta, bisx: sx / sl, bisy: sy / sl };
}

/**
 * 凸角削圆（输入必须 CCW）。
 *
 * 用在「街区多边形」上：把 90° 尖角换成一段凸向街区外侧的圆弧。
 * 顶点 V 被切掉，切点 T1/T2 落在两条边上，圆弧取靠近 V 的那一侧。
 */
export function filletConvex(ring: Pt[], r: Radius, segs = 4): Pt[] {
  const n = ring.length;
  if (n < 3) return ring.slice();
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const V = ring[i];
    const P = ring[(i - 1 + n) % n];
    const Q = ring[(i + 1) % n];
    const c = measure(V, P, Q);
    // CCW 环上，u1=prev−V、u2=next−V：凸角 cross < 0
    if (!c || c.cross > -0.12) {
      out.push(V);
      continue;
    }
    const tanH = Math.tan(c.theta / 2);
    const rv = radiusAt(r, V);
    if (rv <= 1e-9) {
      out.push(V);
      continue;
    }
    let t = rv / tanH;
    const maxT = 0.44 * Math.min(c.l1, c.l2);
    if (t > maxT) t = maxT;
    const rr = t * tanH;
    if (rr < 1e-7 || t < 1e-7) {
      out.push(V);
      continue;
    }
    const d = rr / Math.sin(c.theta / 2);
    const C = new Pt(V.x + c.bisx * d, V.y + c.bisy * d);
    const T1 = new Pt(V.x + c.u1x * t, V.y + c.u1y * t);
    const T2 = new Pt(V.x + c.u2x * t, V.y + c.u2y * t);
    const a1 = Math.atan2(T1.y - C.y, T1.x - C.x);
    const a2 = Math.atan2(T2.y - C.y, T2.x - C.x);
    // 圆上离 V 最近的方向 = 从圆心指向 −bis
    out.push(T1, ...arcPoints(C, rr, a1, a2, Math.atan2(-c.bisy, -c.bisx), segs), T2);
  }
  return out;
}

/**
 * 凹角填圆（输入必须 CCW，且是道路用地面 R 的外环）。
 *
 * R 在路口四角是 270° 内角（凹角）。把角点 V 与一段外凸圆弧之间的
 * 那一小扇形并进 R：新边界走 T1 → 圆弧 → T2，V 落到 R 内部。
 * 于是街区的角就是同一段圆弧，读出来是「街道自己长出来的圆角地面」。
 */
export function filletConcave(ring: Pt[], r: Radius, segs = 4): Pt[] {
  const n = ring.length;
  if (n < 3) return ring.slice();
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const V = ring[i];
    const P = ring[(i - 1 + n) % n];
    const Q = ring[(i + 1) % n];
    const c = measure(V, P, Q);
    // CCW 环上，凹角 cross > 0
    if (!c || c.cross < 0.12) {
      out.push(V);
      continue;
    }
    const tanH = Math.tan(c.theta / 2);
    const rv = radiusAt(r, V);
    if (rv <= 1e-9) {
      out.push(V);
      continue;
    }
    let t = rv / tanH;
    const maxT = 0.44 * Math.min(c.l1, c.l2);
    if (t > maxT) t = maxT;
    const rr = t * tanH;
    if (rr < 1e-7 || t < 1e-7) {
      out.push(V);
      continue;
    }
    const d = rr / Math.sin(c.theta / 2);
    const C = new Pt(V.x + c.bisx * d, V.y + c.bisy * d);
    const T1 = new Pt(V.x + c.u1x * t, V.y + c.u1y * t);
    const T2 = new Pt(V.x + c.u2x * t, V.y + c.u2y * t);
    const a1 = Math.atan2(T1.y - C.y, T1.x - C.x);
    const a2 = Math.atan2(T2.y - C.y, T2.x - C.x);
    // 圆上离 V 最远的方向 = bis（缺口方向），弧要经过它
    out.push(T1, ...arcPoints(C, rr, a1, a2, Math.atan2(c.bisy, c.bisx), segs), T2);
  }
  return out;
}

/**
 * 把一张「道路用地面」整体圆角化。
 *
 * 外环凹角填圆（扩大 R），洞环凸角削圆（缩小街区）—— 两者都让 R 增大，
 * 方向一致；输出保持输入环的绕向，布尔库与三角化都不需要额外归一化。
 */
/**
 * 带兜底的圆角化：**结果一旦自交就降级重试**。
 *
 * 单纯的"切点限在 44% 边长内"不足以保证整环简单：相邻两个角同时吃到同一条
 * 短边、或锐角处的圆弧跨过邻边时，环会自己穿自己。自交环交给三角化就是
 * 一地**尖刺/星形**（用户截图红圈），交给布尔就是静默失败。
 *
 * 降级顺序：原样 → 少弧点 → 半径减半 → 再减半 → 干脆不圆角。
 * 宁可这个角是直角，也不能吐出一张破面。
 */
function safeFillet(ring: Pt[], r: Radius, segs: number, mode: 'convex' | 'concave'): Pt[] {
  const fillet = mode === 'convex' ? filletConvex : filletConcave;
  const tries: { r: Radius; segs: number }[] = [
    { r, segs },
    { r, segs: Math.max(2, segs - 2) },
    { r: halveRadius(r), segs },
    { r: halveRadius(r), segs: 2 },
    { r: halveRadius(halveRadius(r)), segs },
  ];
  for (const t of tries) {
    const out = cleanRing(fillet(ring, t.r, t.segs));
    if (out.length >= 3 && !selfIntersects(out)) return out;
  }
  return ring.slice();
}

function halveRadius(r: Radius): Radius {
  return typeof r === 'function' ? (v: Pt) => r(v) * 0.5 : r * 0.5;
}

export function roundDomain(s: PlanSurface, r: Radius, segs = 4): PlanSurface {
  // 闭合并集会留下离散化微边；先按 15 cm 容差并掉它们，街角才有放圆弧的长边。
  const tol = 0.15 / 7;
  const outerCCW = ringArea(s.outer) > 0;
  const oSrc = simplifyRing(outerCCW ? s.outer : s.outer.slice().reverse(), tol);
  const o = safeFillet(oSrc, r, segs, 'concave');
  return {
    outer: outerCCW ? o : o.reverse(),
    holes: s.holes.map((h) => {
      const ccw = ringArea(h) > 0;
      const src = simplifyRing(ccw ? h : h.slice().reverse(), tol);
      // 圆弧切点可能与相邻折点重合；去掉零长边 / 共线点，否则下游布尔
      // 会在「degenerate segment」上静默失败，派生层整片不裁造成层间重叠。
      const f = safeFillet(src, r, segs, 'convex');
      return ccw ? f : f.reverse();
    }),
  };
}

export function roundDomainAll(list: PlanSurface[], r: Radius, segs = 4): PlanSurface[] {
  return list.map((s) => roundDomain(s, r, segs));
}

/**
 * 去掉环里的**发夹**（180° 回折）。
 *
 * 缓冲 / 布尔在锐角处会把边界折成一条零宽的针：A→B→C 几乎原路返回。
 * 这种针不改面积，却会让三角化吐出细长三角形 —— 俯视和 3D 里就是路口角上
 * 那团**锯齿/星形**（用户红圈标出来的地方）。
 *
 * 处理：某个顶点两侧的夹角 > 170° 且两条边都不长（< 12 m），说明这是折返的
 * 针尖，直接把该顶点摘掉。重复到稳定（最多 4 轮）。
 */
export function removeHairpins(ring: Pt[], maxEdge = 12 / 7): Pt[] {
  let cur = ring.slice();
  for (let pass = 0; pass < 8; pass++) {
    if (cur.length < 4) break;
    const n = cur.length;
    const out: Pt[] = [];
    let removed = 0;
    for (let i = 0; i < n; i++) {
      const b = cur[i];
      const a = cur[(i - 1 + n) % n];
      const c = cur[(i + 1) % n];
      const l1 = Math.hypot(b.x - a.x, b.y - a.y);
      const l2 = Math.hypot(c.x - b.x, c.y - b.y);
      if (l1 > maxEdge || l2 > maxEdge || l1 < 1e-9 || l2 < 1e-9) {
        out.push(b);
        continue;
      }
      const dot = ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)) / (l1 * l2);
      if (dot < -0.985) {
        removed++;
        continue;
      }
      out.push(b);
    }
    cur = out;
    if (removed === 0) break;
  }
  return cur.length >= 3 ? cur : ring.slice();
}

/** 供验收用：环上有多少段"圆弧"（连续短边、方向平缓变化的三连点） */
export function arcVertexCount(ring: Pt[]): number {
  let n = 0;
  for (let i = 1; i + 1 < ring.length; i++) {
    const a = ring[i - 1];
    const b = ring[i];
    const c = ring[i + 1];
    const l1 = Math.hypot(b.x - a.x, b.y - a.y);
    const l2 = Math.hypot(c.x - b.x, c.y - b.y);
    if (l1 < 1e-9 || l2 < 1e-9) continue;
    const cr = ((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)) / (l1 * l2);
    if (Math.abs(cr) > 0.02 && Math.abs(cr) < 0.75 && Math.abs(l1 - l2) < Math.min(l1, l2) * 0.6) n++;
  }
  return n;
}
