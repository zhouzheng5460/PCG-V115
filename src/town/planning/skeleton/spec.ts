// S1 · 场地布局骨架 —— 数据模型与矩形代数
//
// ## 为什么要有这一层
//
// 三个 archetype 原来的顺序是"先铺满场地，最后一行才算入口"：
//
//   courtyard.ts  → 先定院子 → 围建筑 → 挖步道 → 停车 → **⑨ 出入口**
//   strip.ts      → 先按纵深切三段 → 店铺 → 停车 → 服务道 → **出入口**
//   rear-load.ts  → 先按比例切纵深 → 仓库 → 货场 → 最后算出入口
//
// 于是入口和门洞 / 停车区各按自己的比例定位、互不知情，中间横着建筑，
// 只能交给 A* 去兜 —— 这就是"道路贴着建筑绕"的机制性原因。
//
// S1 把顺序倒过来：**先用少量矩形定出空间骨架（车道、组团、停车、前场、
// 开放空间），再让建筑去适配它**。骨架是布局意图，不是最终几何 ——
// 落到 Scene 仍然走 `siteFrame` / `surface` 布尔 / `claimResidual`，
// 一个几何工具都没有新写。
//
// 全部坐标都在 `SiteFrame` 的局部系里（u 沿主临街面、v 向地块内部），
// 与三个 archetype 用的是同一个坐标系，方便互相迁移与对比。

import type { BuildingRole } from '../core/candidate';

const U = (m: number) => m / 7;

export { U };

/** 局部系的轴对齐矩形。骨架层全部由它组成 —— 没有斜边、没有自由多边形 */
export interface Rect {
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

export const rect = (u0: number, u1: number, v0: number, v1: number): Rect => ({ u0, u1, v0, v1 });

/** 宽（沿街方向，世界单位） */
export const rw = (x: Rect) => x.u1 - x.u0;
/** 深（进深方向，世界单位） */
export const rd = (x: Rect) => x.v1 - x.v0;
export const rarea = (x: Rect) => rw(x) * rd(x);
/** 宽/深（米） */
export const rwM = (x: Rect) => rw(x) * 7;
export const rdM = (x: Rect) => rd(x) * 7;

export const isEmpty = (x: Rect) => rw(x) <= 1e-6 || rd(x) <= 1e-6;

/** 四边各自内缩（正数向内、负数向外） */
export function inset(x: Rect, d: number | { u?: number; v?: number }): Rect {
  const du = typeof d === 'number' ? d : (d.u ?? 0);
  const dv = typeof d === 'number' ? d : (d.v ?? 0);
  return rect(x.u0 + du, x.u1 - du, x.v0 + dv, x.v1 - dv);
}

/** 单边内缩（哪边给多少，没给的边不动） */
export function insetSides(
  x: Rect,
  s: { u0?: number; u1?: number; v0?: number; v1?: number }
): Rect {
  return rect(x.u0 + (s.u0 ?? 0), x.u1 - (s.u1 ?? 0), x.v0 + (s.v0 ?? 0), x.v1 - (s.v1 ?? 0));
}

export function overlaps(a: Rect, b: Rect): boolean {
  return a.u0 < b.u1 && b.u0 < a.u1 && a.v0 < b.v1 && b.v0 < a.v1;
}

/**
 * 轴对齐矩形差：`base − cut`。
 *
 * 骨架层只需要这一种布尔操作，用纯矩形算术做比走 `surfaceSubtract` 稳得多
 * （后者在退化输入上会"原样返回被减数"，那是最难查的一类 bug）。
 * 返回 0~4 块，小块由调用方按面积过滤。
 */
export function subtractRect(base: Rect, cut: Rect): Rect[] {
  if (!overlaps(base, cut)) return [base];
  const out: Rect[] = [];
  // 上（v 小的一侧）
  if (cut.v0 > base.v0) out.push(rect(base.u0, base.u1, base.v0, Math.min(cut.v0, base.v1)));
  // 下（v 大的一侧）
  if (cut.v1 < base.v1) out.push(rect(base.u0, base.u1, Math.max(cut.v1, base.v0), base.v1));
  // 中间那段被 cut 在 v 方向覆盖，再按 u 切成左右两块
  const mv0 = Math.max(base.v0, cut.v0);
  const mv1 = Math.min(base.v1, cut.v1);
  if (mv1 > mv0) {
    if (cut.u0 > base.u0) out.push(rect(base.u0, Math.min(cut.u0, base.u1), mv0, mv1));
    if (cut.u1 < base.u1) out.push(rect(Math.max(cut.u1, base.u0), base.u1, mv0, mv1));
  }
  return out.filter((p) => !isEmpty(p));
}

/** 依次挖掉多个矩形 */
export function subtractRects(base: Rect, cuts: Rect[]): Rect[] {
  let cur = [base];
  for (const c of cuts) {
    const next: Rect[] = [];
    for (const p of cur) next.push(...subtractRect(p, c));
    cur = next;
    if (cur.length === 0) break;
  }
  return cur;
}

/**
 * 沿 u 方向把一块切成 n 份，件与件之间留 gap。
 *
 * 这是"有秩序的建筑排列"的实现：店铺带 / 板楼都按这个切，等宽、等深、
 * 有节奏 —— 而不是各自按剩余空间凑尺寸。
 */
export function splitU(x: Rect, n: number, gap = 0, widths?: number[]): Rect[] {
  if (n <= 0) return [];
  const total = rw(x) - gap * (n - 1);
  if (total <= 1e-6) return [];
  const out: Rect[] = [];
  if (widths && widths.length === n) {
    const sum = widths.reduce((a, b) => a + b, 0);
    let cursor = x.u0;
    for (let i = 0; i < n; i++) {
      const w = (total * widths[i]) / sum;
      out.push(rect(cursor, cursor + w, x.v0, x.v1));
      cursor += w + gap;
    }
    return out;
  }
  const w = total / n;
  for (let i = 0; i < n; i++) {
    const u0 = x.u0 + i * (w + gap);
    out.push(rect(u0, u0 + w, x.v0, x.v1));
  }
  return out;
}

/** 沿 v 方向切（前场 / 建筑 / 停车 这类纵深分层） */
export function splitV(x: Rect, n: number, gap = 0): Rect[] {
  if (n <= 0) return [];
  const total = rd(x) - gap * (n - 1);
  if (total <= 1e-6) return [];
  const d = total / n;
  const out: Rect[] = [];
  for (let i = 0; i < n; i++) {
    const v0 = x.v0 + i * (d + gap);
    out.push(rect(x.u0, x.u1, v0, v0 + d));
  }
  return out;
}

// ---------------------------------------------------------------- 形状适配
//
// 三个 Golden 没有一个是矩形：
//   · MF `-469:284`   红线环是一个 111 m 宽、230 m 深、向左倾斜的**平行四边形带**，
//                     而局部坐标系的 bbox 是 192×239 —— bbox 面积是地块的 2.4 倍。
//                     拿 bbox 当设计域，等于在 55% 的空白上排布，切出来的全是碎片。
//   · retail `176:176` 177 m 宽、~90 m 深，后边界斜切。
//   · industrial `252:-578` 48 m 宽、127 m 深，向右收窄成三角形。
//
// 所以骨架的第一个动作不是"切矩形"，而是**问地块：在这个进深上你还剩多宽**。
// 下面两个函数就是这个问题的最小工具集。

export interface LocalPt {
  u: number;
  v: number;
}

/** 世界环 → 局部 (u,v) 环 */
export function toLocalRing(
  ring: readonly { x: number; y: number }[],
  origin: { x: number; y: number },
  uDir: { x: number; y: number },
  vDir: { x: number; y: number }
): LocalPt[] {
  return ring.map((q) => ({
    u: (q.x - origin.x) * uDir.x + (q.y - origin.y) * uDir.y,
    v: (q.x - origin.x) * vDir.x + (q.y - origin.y) * vDir.y,
  }));
}

/** 多边形在进深 `v` 上的 u 跨度（外环口径，忽略洞） */
export function crossSection(ring: LocalPt[], v: number): [number, number] | null {
  const us: number[] = [];
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const da = a.v - v;
    const db = b.v - v;
    // 半开区间判交，顶点落在扫描线上时只算一次
    if ((da <= 0 && db > 0) || (da > 0 && db <= 0)) {
      const t = da / (da - db);
      us.push(a.u + (b.u - a.u) * t);
    }
  }
  if (us.length < 2) return null;
  us.sort((x, y) => x - y);
  return [us[0], us[us.length - 1]];
}

/**
 * 在 `[v0, v1]` 这段进深上**处处都还在**的 u 区间。
 *
 * 用它定位车道：车道必须从街边一直通到底，中途不能掉出红线。
 * MF 那条斜带上，靠左的区间能通到底，靠右的到 v=180 就出界了 ——
 * 这条差别决定了"车道是通到底的死胡同"还是"半路被截断"。
 */
export function safeSpan(ring: LocalPt[], v0: number, v1: number, samples = 14): [number, number] | null {
  let lo = -Infinity;
  let hi = Infinity;
  let seen = 0;
  for (let i = 0; i <= samples; i++) {
    const v = v0 + ((v1 - v0) * i) / samples;
    const s = crossSection(ring, v);
    if (!s) continue;
    seen++;
    lo = Math.max(lo, s[0]);
    hi = Math.min(hi, s[1]);
  }
  if (seen === 0 || !(hi > lo)) return null;
  return [lo, hi];
}

/**
 * 临街宽度。
 *
 * **不能在 v=0 上量** —— 红线的临街边常常是斜的（MF 那块地从 (18,0) 斜到 (83,5)），
 * 一条扫描线只穿过两个边，量出来 47 m，而实际临街宽 112 m。
 * 所以在几个浅进深上各量一次，取**最宽**的那一次：贴着街的那一段就是临街面。
 */
export function streetSpan(ring: LocalPt[], probes: number[]): [number, number] | null {
  let best: [number, number] | null = null;
  for (const d of probes) {
    const s = crossSection(ring, d);
    if (!s) continue;
    if (!best || s[1] - s[0] > best[1] - best[0]) best = s;
  }
  return best;
}

/**
 * 车道能通到多深：从 `vTo` 往回找，"这段 u 区间仍然完整地在红线内"的最深位置。
 *
 * 这是"车道到底了没有"的唯一可靠判据。用固定的比例（比如 82% 进深）
 * 会在锥形地块上直接冲出红线；用全程 `safeSpan` 又过于严格 ——
 * 工业 `252:-578` 收到尾端只剩几米，全程求交会把整条车道判死，
 * 而实际它只要通到货场（约 80 m 深）就够了。
 */
export function laneReach(
  ring: LocalPt[],
  u: [number, number],
  vFrom: number,
  vTo: number,
  margin = 0,
  stepM = 2
): number {
  const tol = 1e-6;
  const fit = (v: number): boolean => {
    const s = crossSection(ring, v);
    if (!s) return false;
    return s[0] + margin <= u[0] + tol && s[1] - margin >= u[1] - tol;
  };
  // 起点：从 `vFrom`（通常是可建区的 v0，可能是负数）起最多往前试 12 m。
  // 红线的临街边常常是斜的，车道在**正好压着街**的那一米会略微探出去，
  // 差一点就判死整条车道 —— 而实际裁到红线之后它只是窄了半米，仍然接得上街。
  let start: number | null = null;
  for (let d = 0; d <= 12; d += 1) {
    const v = Math.max(vFrom, 0) + d / 7;
    if (fit(v)) {
      start = v;
      break;
    }
  }
  if (start === null) return vFrom;
  const step = stepM / 7;
  let last = start;
  for (let v = start; v <= vTo + 1e-9; v += step) {
    if (!fit(v)) break;
    last = v;
  }
  return last;
}

/**
 * 把一段 u 区间夹到"这一进深上真实还存在的范围"里。
 *
 * 这是**阶梯退台**的来源：每排建筑先按自己的进深问一次宽度，再按答案收窄，
 * 于是收窄是一级一级的台阶，而不是被斜边削成一条楔形。
 */
export function clampSpanTo(
  ring: LocalPt[],
  v0: number,
  v1: number,
  want: [number, number],
  margin: number
): [number, number] | null {
  let lo = want[0] + margin;
  let hi = want[1] - margin;
  for (const v of [v0, (v0 + v1) / 2, v1]) {
    const s = crossSection(ring, v);
    if (!s) continue;
    lo = Math.max(lo, s[0] + margin);
    hi = Math.min(hi, s[1] - margin);
  }
  return hi > lo ? [lo, hi] : null;
}

// ---------------------------------------------------------------- 骨架本身

/** 建筑意图。落到 `PlannedBuilding` 还要经过可建区裁剪与矩形分解 */
export interface BuildingSpec {
  r: Rect;
  /** 高度（米），落到候选时换成世界单位 */
  hM: number;
  role: BuildingRole;
  note: string;
  /** 正面朝向：'v-' 朝街；'v+' 朝内；'u-'/'u+' 朝侧。默认按位置推 */
  front?: 'v-' | 'v+' | 'u-' | 'u+';
}

/** 地面意图 */
export interface PatchSpec {
  r: Rect;
  note: string;
}

/**
 * 一套骨架 = 一个完整的布局意图。
 *
 * 车道排在第一位不是排版选择：**它是先被决定的**，其它一切让着它。
 * 这也是本模块与三个 archetype 的分界线 —— 那边是建筑先落位，车道不存在。
 */
export interface PlanSpec {
  /** 稳定 id（写进 Candidate.archetype，报告与测试靠它认方案） */
  id: string;
  /** 人话名字 */
  label: string;
  /** 对应的类型库 pattern id（Pattern Registry 用它筛候选） */
  patternId?: string;
  /** 拓扑类型，用于统计与对比 */
  topology: 'spine-side' | 'spine-parallel' | 'rows' | 'yard';
  /** 设计意图（逐条可读，给面板和报告用） */
  intent: string[];

  /** 车行主通道（局部矩形；全部同宽，宽度见 laneWM） */
  lanes: Rect[];
  /** 车道净宽（米） */
  laneWM: number;

  buildings: BuildingSpec[];

  parking: PatchSpec[];
  forecourt: PatchSpec[];
  /** 核心空间（住宅的围合院子 / 商业与工业可空） */
  courtyard: PatchSpec[];
  /** 步行骨架（院内主步道等） */
  walk: PatchSpec[];
  service: PatchSpec[];
  /** 显式绿带（剩下的由 claimResidual 认领） */
  green: PatchSpec[];

  /**
   * 场地出入口。
   *
   * 与三个 archetype 最大的差别：这里给的是**世界坐标点**，由车道中心在
   * 临街线上算出，所以"门就在路上"是构造保证的，不靠事后对齐。
   */
  gates: {
    kind: 'pedestrian' | 'vehicle' | 'service' | 'truck';
    at: import('../../../core/geom').Pt;
    normal: import('../../../core/geom').Pt;
    /** 开在哪条临街面上。工业的客货分离判据按 frontage 认，必须如实给 */
    frontage?: 'primary' | 'service';
  }[];

  /** 停车需求角色 */
  parkingRole: 'resident' | 'visitor' | 'employee';

  /** 车道边缘到建筑的净距（米）—— 度量与报告要用 */
  clearanceM: number;
}
