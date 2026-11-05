// Site Planning Core · 面契约
//
// 这一层存在的理由（PRD §3 P0）：
//   整个工程原来只有 `ring: Pt[]` 一种面结构 —— 一个外环、没有洞。
//   于是所有"中庭 / 环路 / 停车岛 / 中央绿地 / 环形铺装"都只能画成
//   "大面 + 叠一块小面"，靠 y 值叠压来假装有洞。这套做法的代价是：
//     · 3D / GLB 里洞里其实还有一块面（俯视看不见、剖面就露馅）；
//     · 每一次布尔运算（subtract / difference）都得退化成一个或几个外环，
//       洞被静默丢掉 —— `unionParts` 现在只回一个 `holes: number` 计数就是证据。
//
// 所以这一层的职责只有一句话：
//   **让 `PlanSurface = { outer, holes }` 成为唯一的面结构，并让布尔 / 三角化 /
//     2D / 3D / GLB 全链路都真的认洞。**
//
// 约束（PRD 明确要求）：
//   · 第三方几何库的数据格式**不许出这个文件**（业务代码只调 surface* 系列）；
//   · 现有 `ring: Pt[]` 的调用点保持可用（用 `surfacesOf(ring)` 兼容）。

import { Pt } from '../../../core/geom';
import polygonClipping from 'polygon-clipping';

/** 一个平面区域：外环 + 若干洞（洞的方向与外环相反，此处不做强制，交给三角化处理） */
export interface PlanSurface {
  outer: Pt[];
  holes: Pt[][];
}

/** 多边形钳制库的嵌套元组格式：Polygon = Ring[]，MultiPolygon = Polygon[] */
type Nest = number[][][][];

export function surface(outer: Pt[], holes: Pt[][] = []): PlanSurface {
  return { outer: cleanRing(outer), holes: holes.map(cleanRing).filter((h) => h.length >= 3) };
}

/**
 * 清掉**相邻重复顶点**。
 *
 * 这不是洁癖，是硬需求：polygon-clipping 拒绝带重复点的多边形
 * （"Input geometry is not a valid Polygon or MultiPolygon"），
 * 而 `surfaceUnion` / `surfaceSubtract` / `surfaceIntersect` 都有
 * `catch { return 原值 }` 的兜底分支 —— 一旦几何非法，
 * **并集会静默退化成"把重叠部分算两遍"**，Fidelity Gate 的
 * groundCoverage 就从 1.00 掉到 0.95，看起来像 Realizer 漏做了 5% 的地面，
 * 实际上只是并集算错了。
 *
 * 实测来源：斜边地块上 `intersect(矩形, 可建区)` 会在裁切点留下
 * 一对完全相同的相邻顶点（-491:44 的 6 块地面**全部**中招）。
 *
 * 只删"完全相同"的相邻点（含首尾相同），不动几何形状。
 */
export function cleanRing(ring: Pt[]): Pt[] {
  if (ring.length < 3) return ring.slice();
  const out: Pt[] = [];
  for (const p of ring) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 1e-9 && Math.abs(last.y - p.y) < 1e-9) continue;
    out.push(p);
  }
  // 首尾相同也要去掉（闭合环里不应该出现）
  while (out.length >= 2) {
    const a = out[0];
    const b = out[out.length - 1];
    if (Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9) out.pop();
    else break;
  }
  return out.length >= 3 ? out : ring.slice();
}

/** 老代码兼容：单个外环 → 无洞的面 */
export function surfacesOf(ring: Pt[]): PlanSurface[] {
  return ring.length >= 3 ? [{ outer: ring, holes: [] }] : [];
}

/** 面积（外环 − 洞，取绝对值，保证是正数） */
export function surfaceArea(s: PlanSurface): number {
  const a = Math.abs(ringArea(s.outer));
  let holes = 0;
  for (const h of s.holes) holes += Math.abs(ringArea(h));
  return Math.max(0, a - holes);
}

/** 带符号面积（逆时针为正） */
export function ringArea(ring: Pt[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

/**
 * 送进布尔运算的坐标要**量化**。
 *
 * polygon-clipping 用的 martinez 算法对"几乎重合但不完全重合"的顶点很脆，
 * 典型报错是 `Unable to complete output ring starting at [...]`。
 * 实战里它让 4 块地的 `union(已用地)` 直接失败 —— 而失败会静默退回原列表，
 * 后续 `subtract(可建区, 已用地)` 就切不动，整块可建区被标成绿地。
 *
 * 1 世界单位 ≈ 7 m，所以 1e-6 单位 ≈ 7 微米：低于任何有意义的几何尺度，
 * 但足以把"1e-15 级别的差异"消掉。
 */
const SNAP_GRID = 1e-6;

function snap(v: number): number {
  const r = Math.round(v / SNAP_GRID) * SNAP_GRID;
  return Object.is(r, -0) ? 0 : r;
}

function toNest(ss: PlanSurface[]): Nest {
  return ss.map((s) => [
    s.outer.map((p) => [snap(p.x), snap(p.y)] as number[]),
    ...s.holes.map((h) => h.map((p) => [snap(p.x), snap(p.y)] as number[])),
  ]) as unknown as Nest;
}

function fromNest(n: Nest): PlanSurface[] {
  const out: PlanSurface[] = [];
  for (const poly of n ?? []) {
    if (!poly || poly.length === 0) continue;
    const outer = cleanRing((poly[0] ?? []).map((q) => new Pt(q[0], q[1])));
    if (outer.length < 3) continue;
    const holes: Pt[][] = [];
    for (let i = 1; i < poly.length; i++) {
      const h = cleanRing((poly[i] ?? []).map((q) => new Pt(q[0], q[1])));
      if (h.length >= 3) holes.push(h);
    }
    out.push({ outer, holes });
  }
  return out;
}

/**
 * 布尔运算**静默失败**的计数器（诊断用，不参与任何几何决策）。
 *
 * 三个函数都有 `catch { return 原值 }` 的兜底 —— 兜底本身是必要的
 * （宁可退化成"这一刀没切"也不崩），但**必须可观测**：
 * 一次静默失败会让 `subtract(可建区, 已用地)` 返回**整块地**，
 * 后续把它标成 landscape 就覆盖了整个地块 —— 零售地块上真的发生过，
 * 一张 4928 m² 的"绿地"直接盖住了 4928 m² 的可建区，
 * 2D 上看不出任何异常（因为它就是地块底色）。
 *
 * 集成测试可以 `resetGeometryFailures()` 后跑一遍全城，
 * 断言三个计数全为 0 —— 这才是"几何真的算对了"的证据。
 */
export const geometryFailures = {
  union: 0,
  subtract: 0,
  intersect: 0,
  lastMessage: '',
};

export function resetGeometryFailures(): void {
  geometryFailures.union = 0;
  geometryFailures.subtract = 0;
  geometryFailures.intersect = 0;
  geometryFailures.lastMessage = '';
}

function noteFailure(op: 'union' | 'subtract' | 'intersect', e: unknown): void {
  geometryFailures[op]++;
  const msg = e instanceof Error ? e.message : String(e);
  if (msg && msg !== geometryFailures.lastMessage) geometryFailures.lastMessage = `${op}: ${msg}`;
}

/** 一次并（全部一起传）。polygon-clipping 通常这样质量最好。 */
function unionOnce(list: PlanSurface[]): PlanSurface[] {
  const n = toNest(list);
  return fromNest(polygonClipping.union(n[0] as never, ...(n.slice(1) as never[])) as unknown as Nest);
}

/** 不记失败的并集（内部用，避免重复计数） */
function unionQuiet(list: PlanSurface[]): PlanSurface[] {
  if (list.length <= 1) return list;
  try {
    return unionOnce(list);
  } catch {
    return list;
  }
}

/**
 * 并集降级：逐个尝试并入已有的块，**只合并真正相交的**。
 *
 * 为什么需要它：polygon-clipping 的 martinez 实现是递归的，一次传十几个面
 *（MF 院子被步道切成 4 块 + 3 条步道 + 场地 + 前场 + 停车 + 绿化之后就常见）
 * 会直接 `Maximum call stack size exceeded`。
 *
 * 为什么不是"两两归并"：院子里的四块草坪**本来就不相连**，两两并的结果
 * 仍然是两块，按"块数有没有减少"判断收敛会立刻误判为失败。
 * 这里改成"挨个试并入"：并得进去就吸收、并不进去就独立成块，
 * 无论输入是否相连都能走完，结果和一次性并等价（只是慢）。
 */
function unionFold(list: PlanSurface[]): PlanSurface[] {
  const out: PlanSurface[] = [];
  for (const s of list) {
    let absorbed = false;
    for (let i = 0; i < out.length; i++) {
      const m = unionQuiet([out[i], s]);
      if (m.length === 1) {
        out[i] = m[0];
        absorbed = true;
        break;
      }
    }
    if (!absorbed) out.push(s);
  }
  return out;
}

export function surfaceUnion(ss: PlanSurface[]): PlanSurface[] {
  const list = ss.filter((s) => s.outer.length >= 3);
  if (list.length === 0) return [];
  if (list.length === 1) return list;
  // 先按最自然的方式一次并完（结果质量最好）；
  // 只有在它抛错（典型是 martinez 递归太深 → `Maximum call stack size exceeded`）
  // 时才降级为两两归并 —— 两两归并的合并成功率略低，但不会爆栈。
  try {
    return unionOnce(list);
  } catch (first) {
    try {
      return unionFold(list);
    } catch {
      noteFailure('union', first);
      return list;
    }
  }
}

/** 一次 difference（批量）。减数先并一次 —— 减数之间允许重叠。 */
function subtractOnce(as: PlanSurface[], bs: PlanSurface[]): PlanSurface[] {
  const A = toNest(as);
  const B = toNest(bs.length > 1 ? unionQuiet(bs) : bs);
  return fromNest(polygonClipping.difference(A as never, B as never) as unknown as Nest);
}

/** 面积和（内部用，避免依赖调用方的口径） */
function totalArea(ss: PlanSurface[]): number {
  return ss.reduce((s, p) => s + Math.abs(ringArea(p.outer)), 0);
}

/**
 * a 减去 b（保留 a 上被 b 掏出来的洞）。
 *
 * 批量 difference 在**减数与可建区边界相切**时会抛错（polygon-clipping 的
 * 数值退化），而抛错若直接 `return as`，调用方拿到的就是**整块 a** ——
 * 零售地块上因此出现过一张覆盖整个地块的假"绿地"。
 *
 * 所以失败时**降级为逐块减**：每次只面对一个减数，稳定性高得多。
 * 降级也可能有某几刀切不动，那种情况**跳过这一刀**继续 ——
 * 宁可少减（残地偏少），也绝不能返回整块（残地 = 整块，视觉上是假的满铺）。
 * 只有在"一块都没减掉"时才记一次真失败。
 */
export function surfaceSubtract(a: PlanSurface[], b: PlanSurface[]): PlanSurface[] {
  const as = a.filter((s) => s.outer.length >= 3);
  const bs = b.filter((s) => s.outer.length >= 3);
  if (as.length === 0) return [];
  if (bs.length === 0) return as;
  try {
    return subtractOnce(as, bs);
  } catch (e) {
    const before = totalArea(as);
    let cur = as;
    for (const one of bs) {
      try {
        const next = subtractOnce(cur, [one]);
        if (totalArea(next) < totalArea(cur) - 1e-12) cur = next;
      } catch {
        // 这一刀切不动，跳过（不影响其它刀）
      }
      if (cur.length === 0) break;
    }
    if (totalArea(cur) >= before - 1e-9) noteFailure('subtract', e);
    return cur;
  }
}

/** 交集（保留洞） */
export function surfaceIntersect(a: PlanSurface[], b: PlanSurface[]): PlanSurface[] {
  const as = a.filter((s) => s.outer.length >= 3);
  const bs = b.filter((s) => s.outer.length >= 3);
  if (as.length === 0 || bs.length === 0) return [];
  try {
    return fromNest(polygonClipping.intersection(toNest(as) as never, toNest(bs) as never) as unknown as Nest);
  } catch (e) {
    noteFailure('intersect', e);
    return [];
  }
}

/**
 * 变距内缩：每条边按各自的距离向内推。
 *
 * 为什么不能统一 offset：城市路网里这条街 10 m 红线、那条 28 m，
 * 地块必须沿每条边让出**各自**的红线宽。统一 offset 只能取一个值 ——
 * 要么压路（取小了），要么把地块啃掉一大块（取大了）。
 *
 * 做法是标准的半平面裁剪：对每条边求出"向内距离 d 的平行线"，
 * 把多边形裁到这条线的内侧，逐边做完就是变距内缩。
 * 环必须是 CCW（左手法线朝内），否则先翻转。
 */
/**
 * 转角倒角（chamfer）。
 *
 * 城市规划里地块在街角**必须切角**，不是直角怼上去：
 * 转弯半径、人行道加宽、视线三角都靠这个角。我们的地块从 patch 内缩之后
 * 全是直角，路口看过去"地块像刀切的"——这就是用户圈出来的那个问题。
 *
 * 只切**凸角**（CCW 环上叉积 > 0），凹角切了会把地块咬出缺口。
 * 每边退 `d` 得到两个切点，用一条直线代替顶点。
 *
 * @param d 沿两边各退多少（世界单位）
 * @param minEdge 这条边短于它就不切（否则切点会跑到对面顶点外）
 */
export function chamferCorners(
  ring: ReadonlyArray<{ x: number; y: number }>,
  d: number,
  // 默认 minEdge 只要求"两边都够放下切点"，不额外放大 ——
  // 原来写 d*2.5（3.5 m 倒角就是 8.75 m），短边交汇的角全被跳过，
  // 实测 52 块地里只有 37 块切到，用户在图上看到的就是"有的角切了有的没切"。
  minEdge = d * 1.2
): Pt[] {
  const n = ring.length;
  if (n < 3 || d <= 1e-9) return ring.map((p) => new Pt(p.x, p.y));
  const src = ringArea(ring as Pt[]) < 0 ? ring.slice().reverse() : ring.slice();
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const prev = src[(i - 1 + n) % n];
    const cur = src[i];
    const next = src[(i + 1) % n];
    const l1 = Math.hypot(prev.x - cur.x, prev.y - cur.y);
    const l2 = Math.hypot(next.x - cur.x, next.y - cur.y);
    if (l1 < minEdge || l2 < minEdge) {
      out.push(new Pt(cur.x, cur.y));
      continue;
    }
    // 凸角判定（CCW：cross > 0）
    const ax = cur.x - prev.x;
    const ay = cur.y - prev.y;
    const bx = next.x - cur.x;
    const by = next.y - cur.y;
    const cross = ax * by - ay * bx;
    const dot = ax * bx + ay * by;
    const turn = Math.atan2(cross, dot); // 转角（弧度，凸角为正）
    if (cross <= 1e-9 || turn > 2.6) {
      // 凹角 / 共线 / 几乎折返：不切
      out.push(new Pt(cur.x, cur.y));
      continue;
    }
    // 按转角大小收放倒角长度：钝角少切、直角满切
    const k = Math.min(1, turn / (Math.PI / 2));
    const dd = d * k;
    out.push(
      new Pt(cur.x + ((prev.x - cur.x) / l1) * dd, cur.y + ((prev.y - cur.y) / l1) * dd),
      new Pt(cur.x + ((next.x - cur.x) / l2) * dd, cur.y + ((next.y - cur.y) / l2) * dd)
    );
  }
  return out;
}

export function insetPerEdge(ring: ReadonlyArray<{ x: number; y: number }>, dists: number[]): Pt[] {
  const n = ring.length;
  // 输入只要求 {x,y}（adapters 那层的 patch 顶点是轻量对象），
  // 内部统一转成 core/geom 的 Pt —— 半平面裁剪要构造新顶点。
  const src: Pt[] = ring.map((p) => new Pt(p.x, p.y));
  if (n < 3) return src;
  // 统一成 CCW —— 边和法线都必须基于同一套顶点顺序。
  // （原环如果是 CW，先 reverse；否则内法线会朝外，把多边形裁没。）
  const ccw = ringArea(src) < 0 ? src.slice().reverse() : src.slice();
  // dists 是按原环的下标给的；翻转后下标要跟着翻
  const flipped = ringArea(src) < 0;
  const dOf = (i: number) => dists[flipped ? n - 1 - i : i] ?? 0;

  let poly = ccw.slice();
  for (let i = 0; i < n && poly.length >= 3; i++) {
    const a = ccw[i];
    const b = ccw[(i + 1) % n];
    const d = dOf(i);
    if (d <= 1e-9) continue;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-9) continue;
    // CCW 环的左法线朝内
    const nx = -(b.y - a.y) / len;
    const ny = (b.x - a.x) / len;
    poly = clipHalfPlane(poly, a, nx, ny, d);
  }
  return poly;
}

/** 保留 dot(p − a, n) >= d 的部分（Sutherland–Hodgman 单侧裁剪） */
function clipHalfPlane(poly: Pt[], a: Pt, nx: number, ny: number, d: number): Pt[] {
  const out: Pt[] = [];
  const side = (p: Pt) => (p.x - a.x) * nx + (p.y - a.y) * ny - d;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const sp = side(p);
    const sq = side(q);
    if (sp >= -1e-12) out.push(p);
    if ((sp > 1e-12 && sq < -1e-12) || (sp < -1e-12 && sq > 1e-12)) {
      const t = sp / (sp - sq);
      out.push(new Pt(p.x + (q.x - p.x) * t, p.y + (q.y - p.y) * t));
    }
  }
  return out;
}

/** 外扩（正数）/ 内缩（负数）。洞的方向相反：内缩时洞会变大。 */
export function surfaceOffset(s: PlanSurface, d: number): PlanSurface[] {
  if (Math.abs(d) < 1e-9) return [s];
  // buffered() 的符号约定：**正数 = 内缩**（沿 CCW 环的左手法线走）。
  // 对外语义反过来（正数 = 外扩），所以这里要取反。
  const out: PlanSurface = {
    outer: buffered(s.outer, -d),
    // 洞的方向与外环相反：外环外扩时洞要变小
    holes: s.holes.map((h) => buffered(h, d)),
  };
  if (!surfaceValid(out)) return [];
  // 凹角处的 miter 可能自交 —— 交给并集规范化一次（只在自交时才做，省开销）
  if (selfIntersects(out.outer)) {
    const fixed = surfaceUnion([out]);
    return fixed.filter((q) => surfaceArea(q) > 1e-9);
  }
  return [out];
}

/** 环是否自交（偏移后的自检）
 *
 * F2 起对外导出：地块分割的硬约束验证要复用同一份判据，
 * 不允许在 subdivision 里再写一套"差不多"的自交检测。 */
export function selfIntersects(r: Pt[]): boolean {
  const n = r.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    const a = r[i];
    const b = r[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = r[j];
      const d = r[(j + 1) % n];
      const d1 = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      const d2 = (b.x - a.x) * (d.y - a.y) - (b.y - a.y) * (d.x - a.x);
      const d3 = (d.x - c.x) * (a.y - c.y) - (d.y - c.y) * (a.x - c.x);
      const d4 = (d.x - c.x) * (b.y - c.y) - (d.y - c.y) * (b.x - c.x);
      if (d1 * d2 < 0 && d3 * d4 < 0) return true;
    }
  }
  return false;
}

/** 内缩（正数距离） */
export function surfaceInset(s: PlanSurface, d: number): PlanSurface[] {
  return surfaceOffset(s, -Math.abs(d));
}

/**
 * 单环的简单偏移（沿顶点法线做 miter）。
 *
 * 真正的 offset 应该走 Clipper2（PRD §5），但这里先给出**不引入新依赖**的
 * 可用实现：对规划层的矩形 / 梯形 / 凸多边形足够准；凹角处靠 miter 上限兜住。
 * 需要工业级 offset 时只改这一个函数，调用方不动。
 */
function buffered(ring: Pt[], delta: number): Pt[] {
  const n = ring.length;
  if (n < 3 || delta === 0) return ring;
  const ccw = ringArea(ring) > 0;
  const sgn = ccw ? 1 : -1;
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const prev = ring[(i + n - 1) % n];
    const cur = ring[i];
    const next = ring[(i + 1) % n];
    const e0 = unit(new Pt(cur.x - prev.x, cur.y - prev.y));
    const e1 = unit(new Pt(next.x - cur.x, next.y - cur.y));
    // 左手法线；CCW 环的左手边是内侧
    const n0 = new Pt(-e0.y * sgn, e0.x * sgn);
    const n1 = new Pt(-e1.y * sgn, e1.x * sgn);
    let mid = new Pt(n0.x + n1.x, n0.y + n1.y);
    const ml = Math.hypot(mid.x, mid.y);
    // 折返点（两条边几乎反向）法线相加会归零：这时退回用第一条边的法线，
    // 否则除以 0 会把顶点甩到原点，整个面直接炸掉
    mid = ml < 1e-6 ? new Pt(n0.x, n0.y) : new Pt(mid.x / ml, mid.y / ml);
    const cos = Math.max(0.35, mid.x * n0.x + mid.y * n0.y);
    out.push(new Pt(cur.x + mid.x * (delta / cos), cur.y + mid.y * (delta / cos)));
  }
  return out;
}

function unit(p: Pt): Pt {
  const l = Math.hypot(p.x, p.y) || 1;
  return new Pt(p.x / l, p.y / l);
}

/** 面是否退化（外环 < 3 点 / 面积近似 0） */
export function surfaceValid(s: PlanSurface): boolean {
  return s.outer.length >= 3 && surfaceArea(s) > 1e-9;
}

/**
 * 内部最稳的核心点（PRD §8 的 polylabel 轻量替代）。
 *
 * 做法：取外环的中轴采样，选"到边界距离最大"的那个点 —— 对矩形 / L 形 / 梯形
 * 已经足够稳，且不需要额外依赖。用途：庭院中心、水景、停车撒点、标签位置。
 */
export function surfaceAnchor(s: PlanSurface, samples = 24): Pt {
  const b = bboxOf(s.outer);
  let best = new Pt((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2);
  if (!insideSurface(best, s)) best = s.outer[0];
  let bestD = -Infinity;
  // 网格采样 + 到边界的距离，取最大者
  const nx = samples;
  const ny = samples;
  for (let i = 1; i < nx; i++) {
    for (let j = 1; j < ny; j++) {
      const p = new Pt(b.minX + ((b.maxX - b.minX) * i) / nx, b.minY + ((b.maxY - b.minY) * j) / ny);
      if (!insideSurface(p, s)) continue;
      const d = distToSurfaceEdge(p, s);
      if (d > bestD) {
        bestD = d;
        best = p;
      }
    }
  }
  return best;
}

export function bboxOf(ring: Pt[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of ring) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/** 点是否在面内（外环内且不在洞里） */
export function insideSurface(p: Pt, s: PlanSurface): boolean {
  if (!pointInRing(p, s.outer)) return false;
  for (const h of s.holes) if (pointInRing(p, h)) return false;
  return true;
}

export function pointInRing(p: Pt, ring: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y || 1e-12) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** 点到面边界（外环 + 洞）的最短距离 */
export function distToSurfaceEdge(p: Pt, s: PlanSurface): number {
  let best = distToRing(p, s.outer);
  for (const h of s.holes) best = Math.min(best, distToRing(p, h));
  return best;
}

function distToRing(p: Pt, ring: Pt[]): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L2 = dx * dx + dy * dy;
    if (L2 < 1e-12) continue;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
    const d = Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
    if (d < best) best = d;
  }
  return best;
}
