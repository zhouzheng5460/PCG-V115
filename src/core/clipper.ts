// Clipper2 封装：**可靠的多边形偏移 + 布尔**。
//
// 为什么需要它：之前用的是自己写的 `buffered()` + polygon-clipping，
// 偏移一个大面（合并后的路网：上万顶点、上百个洞）时，斜接外扩会在凹角处
// 自己穿自己，`surfaceValid` 把它判成"自交" → 返回空 → 整层路面消失
// （实测 `road/curb` 变 0 片、人行道宽度乱跳）。这不是参数没调好，是那套
// 实现在**大输入 + 凹角**下没有拓扑清理能力。
//
// Clipper2 的做法不一样：内部全整数运算（无浮点巧合），偏移的结果再自动
// 做一次并集规范化 —— 凹角自交、偏移后相邻片互相吃掉、细缝闭合，都由它
// 在内部解决，不需要调用方事后补。
//
// 约定（重要，踩过坑）：
//   · **单位**：1 世界单位 = 7 m，缩放 1000 后 1 格 = 7 mm。所有进出都在
//     `RingSurface`（世界单位）层面，缩放只在这里发生。
//   · **绕向**：外环 CCW（面积 > 0）、洞 CW。Clipper 用非零绕数判内外，
//     绕向错了洞会被当成实体（外扩时洞不但不缩小反而长出去）。我们的
//     `cleanRing` 不保证绕向，所以这里强制归一化。
//   · **洞**：偏移时正 delta 让外环外扩、洞收缩（洞边界朝材料内部走），
//     这正是"整体加厚一层"的语义。

import { Pt } from './geom';
import {
  ClipType,
  EndType,
  FillRule,
  JoinType,
  PolyTree64,
  booleanOpWithPolyTree,
  inflatePaths,
  stripDuplicates,
  type Path64,
  type Paths64,
} from 'clipper2-ts';

/**
 * 世界单位 → 整数格的比例：1 单位 = 10000 格，即 1 格 = 0.7 mm。
 *
 * 精度为什么取这么细：代码里有"微偏移破退化"的用法（`unionPair` 失败后把面
 * 外扩 5 mm 再并一次，用来打破两个面**恰好共边**的病态输入）。1 格 7 mm 会
 * 把这个 5 mm 抹成 0，那个重试就退化成"什么都没做"。0.7 mm 既能保住它，
 * 又远小于最细的真实几何（0.3 m 路缘 = 428 格）。
 *
 * 坐标量级：城市半径 ~200 单位 → 2e6 格，离安全整数上限（9e15）还差九个数量级。
 */
export const CLIP_SCALE = 10000;

/** 与 `PlanSurface` 同构（这里不 import 它，避免 surface.ts ↔ clipper.ts 成环） */
export interface RingSurface {
  outer: Pt[];
  holes: Pt[][];
}

export interface OffsetOpts {
  /** 斜接上限：>1 的倍数。转角已圆角化，几乎不会触发；2 是 Clipper 默认 */
  miterLimit?: number;
  /** 圆弧容差（世界单位）：只在 JoinType.Round 时有意义，留个口子 */
  arcToleranceU?: number;
}

/** 有向面积 ×2（CCW 为正） */function signedArea2(ring: Pt[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a;
}

/** 按需要归一化绕向（外环 CCW、洞 CW） */
function orient(ring: Pt[], wantCcw: boolean): Pt[] {
  const ccw = signedArea2(ring) > 0;
  return ccw === wantCcw ? ring : ring.slice().reverse();
}

/** 世界单位环 → 整数路径（顺带去重：相邻格点相同就丢） */
function toPath(ring: Pt[]): Path64 {
  const p: Path64 = [];
  for (const q of ring) {
    const x = Math.round(q.x * CLIP_SCALE);
    const y = Math.round(q.y * CLIP_SCALE);
    const last = p[p.length - 1];
    if (last && last.x === x && last.y === y) continue;
    p.push({ x, y });
  }
  if (p.length > 1 && p[0].x === p[p.length - 1].x && p[0].y === p[p.length - 1].y) p.pop();
  return p.length >= 3 ? stripDuplicates(p, true) : [];
}

/** 一组面 → Clipper 路径集（外环 CCW、洞 CW） */
function toPaths(list: RingSurface[]): Paths64 {
  const out: Paths64 = [];
  for (const s of list) {
    if (!s.outer || s.outer.length < 3) continue;
    const o = toPath(orient(s.outer, true));
    if (o.length >= 3) out.push(o);
    for (const h of s.holes) {
      if (!h || h.length < 3) continue;
      const hp = toPath(orient(h, false));
      if (hp.length >= 3) out.push(hp);
    }
  }
  return out;
}

/** 整数路径 → 世界单位环 */
function fromPath(p: Path64): Pt[] {
  const out: Pt[] = [];
  for (const q of p) out.push(new Pt(q.x / CLIP_SCALE, q.y / CLIP_SCALE));
  return out;
}

/**
 * PolyTree → 面列表。
 *
 * 层级语义：偶数层是实体（外环），奇数层是洞，再往下（洞中岛）又是实体。
 * 不做这一步的话，`Paths64` 是**平铺**的，"哪个环是哪个洞"就丢了 ——
 * 平铺的洞会被当成独立小面，渲染出来就是路中间凭空多一块铺装。
 */
function fromTree(tree: PolyTree64): RingSurface[] {
  const out: RingSurface[] = [];
  const kids = (n: { count: number; child(i: number): any }): any[] => {
    const r: any[] = [];
    for (let i = 0; i < n.count; i++) r.push(n.child(i));
    return r;
  };
  const visit = (node: any, outer: RingSurface | null): void => {
    const poly = node.poly as Path64 | null;
    if (!poly || poly.length < 3) {
      for (const c of kids(node)) visit(c, outer);
      return;
    }
    const ring = fromPath(poly);
    if (node.isHole) {
      // 洞：挂到当前外环上；没有外环（异常情况）就自己成一片
      if (outer) outer.holes.push(orient(ring, false));
      else out.push({ outer: orient(ring, true), holes: [] });
    } else {
      const s: RingSurface = { outer: orient(ring, true), holes: [] };
      out.push(s);
      for (const c of kids(node)) visit(c, s);
      return;
    }
    for (const c of kids(node)) visit(c, outer);
  };
  for (const c of kids(tree)) visit(c, null);
  return out.filter((s) => s.outer.length >= 3 && Math.abs(signedArea2(s.outer)) > 1e-9);
}

/** 把偏移/布尔的平铺结果重新套成"外环 + 洞"的层级 */
function nest(paths: Paths64): RingSurface[] {
  if (paths.length === 0) return [];
  const tree = new PolyTree64();
  booleanOpWithPolyTree(ClipType.Union, paths, null, tree, FillRule.NonZero);
  return fromTree(tree);
}

/**
 * 对一个面集合整体外扩（delta > 0）或内缩（delta < 0）。
 *
 * **集合整体**是重点：相邻面之间的缝、偏移后互相吃掉的部分，都在同一次
 * 调用里合并成一张干净的面，不需要调用方先 union 再 offset 再 union。
 *
 * @param deltaU 偏移量（世界单位，1 单位 = 7 m）
 */
export function offsetSurfaceSet(
  list: RingSurface[],
  deltaU: number,
  opts: OffsetOpts = {}
): RingSurface[] {
  if (list.length === 0) return [];
  // 不足半格：四舍五入之后就是 0，直接返回原面（别吐一个"没长出去"的空结果）
  if (!Number.isFinite(deltaU) || Math.abs(deltaU) < 0.5 / CLIP_SCALE) return list.slice();
  const paths = toPaths(list);
  if (paths.length === 0) return [];
  const delta = Math.round(deltaU * CLIP_SCALE);
  if (delta === 0) return list.slice();
  const sol = inflatePaths(
    paths,
    delta,
    JoinType.Miter,
    EndType.Polygon,
    opts.miterLimit ?? 2,
    Math.round((opts.arcToleranceU ?? 0.05) * CLIP_SCALE)
  );
  return nest(sol);
}

/** 并集（同一引擎、整数内核，不会像 martinez 那样在退化输入上静默吐空） */
export function unionSurfaceSet(list: RingSurface[]): RingSurface[] {
  const paths = toPaths(list);
  if (paths.length === 0) return [];
  return nest(paths);
}

/** a − b */
export function subtractSurfaceSet(a: RingSurface[], b: RingSurface[]): RingSurface[] {
  const pa = toPaths(a);
  if (pa.length === 0) return [];
  const pb = toPaths(b);
  if (pb.length === 0) return nest(pa);
  const tree = new PolyTree64();
  booleanOpWithPolyTree(ClipType.Difference, pa, pb, tree, FillRule.NonZero);
  return fromTree(tree);
}

/** a ∩ b */
export function intersectSurfaceSet(a: RingSurface[], b: RingSurface[]): RingSurface[] {
  const pa = toPaths(a);
  const pb = toPaths(b);
  if (pa.length === 0 || pb.length === 0) return [];
  const tree = new PolyTree64();
  booleanOpWithPolyTree(ClipType.Intersection, pa, pb, tree, FillRule.NonZero);
  return fromTree(tree);
}

/** 单个面的偏移（`surfaceOffset` 的等价物，保留单入参形式方便替换） */
export function offsetSurfaceOne(s: RingSurface, deltaU: number, opts?: OffsetOpts): RingSurface[] {
  return offsetSurfaceSet([s], deltaU, opts);
}

/**
 * 把"自己碰自己"的环按重复顶点拆成若干简单环。
 *
 * 为什么必须做：Clipper2 用非零绕数，**不拆分单点相接的多边形** —— 两块地
 * 只在边界线上共用一个点时，它会回一个环（顶点重复两次、形状是个"8"）。
 * martinez 会拆成两个环，于是从 Clipper 换过来之后，街区会悄悄并掉
 * （实测 R01 样板：两个街区并成一个 15259 m² 的大街区，最后被判成 park、
 * 一栋楼都没有）。
 *
 * 算法：走环，遇到已经走过的顶点就把"从上次出现到现在的这一段"截下来当
 * 一个独立环，交点在两段里各留一次。这才是"8"字形的正确切法 —— 直接按
 * 重复点切开会把两块的面积都算错。
 */
export function splitPinched(ring: Pt[]): Pt[][] {
  if (ring.length < 4) return [ring];
  const out: Pt[][] = [];
  const stack: Pt[] = [];
  const seen = new Map<string, number>();
  const key = (p: Pt): string => `${p.x.toFixed(6)},${p.y.toFixed(6)}`;
  let pinched = false;
  for (const p of ring) {
    const k = key(p);
    const at = seen.get(k);
    if (at === undefined) {
      seen.set(k, stack.length);
      stack.push(p);
      continue;
    }
    pinched = true;
    const loop = stack.slice(at);
    if (loop.length >= 3) out.push(loop);
    for (let i = stack.length - 1; i >= at; i--) seen.delete(key(stack[i]));
    stack.length = at;
    seen.set(k, at);
    stack.push(p);
  }
  if (stack.length >= 3) out.push(stack);
  if (!pinched) return [ring];
  // 面积守恒自检：拆出来的总和应与原环一致（否则说明切法有问题，原样返回）
  const a0 = Math.abs(signedArea2(ring));
  const a1 = out.reduce((s, r) => s + Math.abs(signedArea2(r)), 0);
  if (out.length < 2 || Math.abs(a1 - a0) > a0 * 0.02 + 1e-6) return [ring];
  return out;
}

