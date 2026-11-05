// R1.3 · 把内部交通求解结果接入生产（规划侧）
//
// ## 这一层做什么
//
//   solveCirculation(ctx, candidate)            ← 已经在 solver.ts 里算完
//   → 中心线去重合并（共享主干只出现一次）
//   → 转成 Realizer 已支持的 PlannedPath
//   → 与 archetype 手画的旧 circulation 明确替换
//
// ## 为什么去重要放在这里，而不是 Realizer
//
// 共享主干天然被多条 OD 走过：MF 的两条路径有 31% 是同一段。Realizer 只会
// "逐条中心线铺矩形"，同一段铺两遍就是两块重合的路面 —— 全城精确重叠审计
// （`auditOverlap`，阈值 5 m²）会直接判非法。所以**必须在中心线层面**合并：
// 先按"需求最重的路径"占用格子，后来的路径从第一个没被占的顶点开始接。
//
// Realizer 的职责边界不变：它只 realize 中心线，不重规划。
//
// ## 与旧 circulation 的替换关系（明确写死，不靠猜）
//
// 1. archetype 画的旧路**先不铺**，等新路径占完格子再判；
// 2. 旧路有 ≥50% 的采样格已被新路覆盖 → 视为"被替换"，不再输出（否则同一段
//    会被画两遍）；它原来的宽度会**并到替换它的那条新路上**（不许把 10 m 的
//    货运通道悄悄收成 3 m）；
// 3. 旧路没被覆盖 → 原样保留。它是 archetype 认定的合法内部道路，新网络不认它
//    也不能把它删掉。

import { Pt } from '../../../core/geom';
import type { SiteContext } from '../core/types';
import type { PlannedPath, SitePlanCandidate } from '../core/candidate';
import { solveCirculation, type CirEdge, type Traffic } from './solver';

/** 米 → 世界单位 */
const U = (m: number) => m / 7;
/** 共享主干的半幅（5 m 的一半）。支路起点要退到这里，T 型口才不会叠面 */
const TRUNK_HALF_U = U(2.5);
/** 采样步长 = 求解器栅格 */
const STEP_U = U(1.5);
/** 旧路有多少比例的采样格被新路覆盖就算"被替换" */
const REPLACE_RATIO = 0.5;
/** 锯齿拉直容差：正好一个栅格。小于它等于没拉，大于它会把真绕行拉成直线 */
const DP_TOL_U = U(1.5);

export interface AdoptReport {
  /** 是否真的换成了新网络 */
  applied: boolean;
  /** 没换的原因（applied=false 时必填，不许静默） */
  reason?: string;
  /** 新路径条数 */
  paths: number;
  /** 新路径总长（m） */
  lengthM: number;
  /** 保留的旧路条数 */
  keptLegacy: number;
  /** 被新路替换掉的旧路条数 */
  replacedLegacy: number;
  /** 因共用主干而"没有重复铺"的长度（m） */
  dedupedM: number;
  /** 被旧路加宽过的路径条数 */
  widened: number;
  odTotal: number;
  odConnected: number;
  connected: boolean;
  sharedRate: number;
  ms: number;
  warnings: string[];
}

export interface AdoptResult {
  candidate: SitePlanCandidate;
  report: AdoptReport;
  /** 仅供开发诊断图层使用：完整网络 + 入口 + 失败点 */
  debug: CirDebug;
}

/**
 * R1.4 诊断数据（只给 `?circulation` 的诊断图层用，不参与任何几何）。
 *
 * 分三类画：既有可通行道路、A* 新增连接、以及合并后的完整网络 ——
 * 只看"新增"会得出"内部路是几个断头"的错误结论，因为网络主体往往是既有铺装。
 */
export interface CirDebug {
  /** 需求点与街区出口（按 kind 分色画） */
  nodes: { id: string; kind: string; at: Pt; role: string }[];
  /** A* 新增的连接（中心线 + 宽度 + 承担的需求数） */
  edges: { traffic: Traffic; pts: Pt[]; widthM: number; odCount: number }[];
  /** 被并进网络的既有可通行道路（按 program 分类） */
  adopted: { program: string; outer: Pt[] }[];
  /** 接不上的需求点 */
  unreachable: { id: string; kind: string; at: Pt; reason: string }[];
  /** 目标本身就在既有道路上（不需要新铺）的个数 */
  onExisting: number;
}

interface GridRef {
  x0: number;
  y0: number;
  nx: number;
  ny: number;
}

const cellIdx = (g: GridRef, p: Pt): number => {
  const i = Math.floor((p.x - g.x0) / STEP_U);
  const j = Math.floor((p.y - g.y0) / STEP_U);
  if (i < 0 || j < 0 || i >= g.nx || j >= g.ny) return -1;
  return j * g.nx + i;
};

/** 沿折线按栅格步长采样成格索引序列（去重用） */
function sampleCells(pts: Pt[], g: GridRef): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const n = Math.max(1, Math.ceil(Pt.distance(a, b) / STEP_U));
    for (let s = 0; s < n; s++) {
      const t = s / n;
      const k = cellIdx(g, new Pt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t));
      if (k >= 0) out.push(k);
    }
  }
  const last = pts.length ? cellIdx(g, pts[pts.length - 1]) : -1;
  if (last >= 0) out.push(last);
  return out;
}

const ROLE_OF: Record<Traffic, PlannedPath['role']> = {
  pedestrian: 'pedestrian',
  vehicle: 'vehicle',
  service: 'truck',
};

/** 采样点 + 所属格（去重按格判，成段要按点连） */
function sampleAlong(pts: Pt[], g: GridRef): { at: Pt; cell: number }[] {
  const out: { at: Pt; cell: number }[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const n = Math.max(1, Math.ceil(Pt.distance(a, b) / STEP_U));
    for (let s = 0; s < n; s++) {
      const t = s / n;
      const at = new Pt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
      out.push({ at, cell: cellIdx(g, at) });
    }
  }
  if (pts.length) out.push({ at: pts[pts.length - 1], cell: cellIdx(g, pts[pts.length - 1]) });
  return out;
}

/** Douglas–Peucker：把栅格锯齿压成直线段。
 *
 * A* 走 8 邻域，出来的是"斜-直-斜"交替的锯齿（MF 那条 140 m 的路有 14 个顶点，
 * 其中好几个是 3 m 的小折）。Realizer 按**段**铺矩形，每个折角两块矩形必然互压 ——
 * 锯齿越多叠得越狠。先在规划侧把锯齿拉直，Realizer 才不会被逼着画一堆碎面。 */
function simplifyDP(pts: Pt[], tol: number): Pt[] {
  if (pts.length <= 2) return pts;
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop()!;
    const a = pts[i0];
    const b = pts[i1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L = Math.hypot(dx, dy) || 1e-9;
    let best = -1;
    let bd = 0;
    for (let i = i0 + 1; i < i1; i++) {
      const p = pts[i];
      const d = Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / L;
      if (d > bd) { bd = d; best = i; }
    }
    if (bd > tol && best > 0) {
      keep[best] = true;
      stack.push([i0, best], [best, i1]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** 去掉共线点（与 solver 里的 simplify 同义，但这里是位置级） */
function simplify(pts: Pt[]): Pt[] {
  if (pts.length <= 2) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1];
    const b = pts[i];
    const c = pts[i + 1];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) > 1e-9) out.push(b);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

const polylineM = (pts: Pt[]) =>
  pts.slice(1).reduce((s, p, i) => s + Pt.distance(pts[i], p), 0) * 7;

/** 把一条边沿它自己的方向前移 d（世界单位），用于把支路起点退到主干边缘。
 *  支路本身比 d 还短时返回 null —— 这条支路整个含在主干断面里，不该单独铺。 */
function advance(pts: Pt[], d: number): Pt[] | null {
  if (pts.length < 2 || d <= 0) return pts;
  const a = pts[0];
  const b = pts[1];
  const L = Pt.distance(a, b);
  if (L <= d + 1e-6) return null;
  const t = d / L;
  const head = new Pt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
  return [head, ...pts.slice(1)];
}

/**
 * 求解 → PlannedPath（已去重）+ 新旧替换。
 *
 * `solveCirculation` 不在这里重跑第二次：一个候选用一次求解结果，
 * 保证 2D / 3D / 导出看到的是同一份规划。
 */
export function adoptCirculation(ctx: SiteContext, candidate: SitePlanCandidate): AdoptResult {
  const t0 = performance.now();
  const warnings: string[] = [];

  const empty = (reason: string, debug: CirDebug): AdoptResult => ({
    candidate,
    debug,
    report: {
      applied: false,
      reason,
      paths: 0,
      lengthM: 0,
      keptLegacy: candidate.circulation.length,
      replacedLegacy: 0,
      dedupedM: 0,
      widened: 0,
      odTotal: 0,
      odConnected: 0,
      connected: false,
      sharedRate: 0,
      ms: +(performance.now() - t0).toFixed(1),
      warnings,
    },
  });

  const res = solveCirculation(ctx, candidate);
  warnings.push(...res.warnings);

  const edgeTargets = new Set(res.edges.map((e) => e.to));
  const debug: CirDebug = {
    nodes: res.nodes.map((n) => ({ id: n.id, kind: n.kind, at: n.at, role: n.role })),
    edges: res.edges.map((e) => ({ traffic: e.traffic, pts: e.pts, widthM: e.widthM, odCount: e.odCount ?? 1 })),
    adopted: res.adopted.map((a) => ({ program: a.program, outer: a.area.outer })),
    unreachable: res.unreachable.map((u) => ({ id: u.id, kind: u.kind, at: u.at, reason: u.reason })),
    onExisting: Math.max(0, (res.stats.odConnected ?? 0) - edgeTargets.size),
  };

  const g = res.grid;
  if (!g) return empty('求解器没有返回栅格（入口不足）', debug);
  if (res.edges.length === 0) return empty('求解器没有产出任何路径', debug);

  const odTotal = res.stats.odTotal ?? res.nodes.filter((n) => n.kind !== 'street').length;
  const odConnected = res.stats.odConnected ?? res.edges.length;
  if (!res.stats.connected) {
    // 明明有断口就换上，等于把"没连上"包装成"新方案"—— 明确拒绝。
    return empty(
      `必要 OD 未全部连通（${odConnected}/${odTotal}），保留旧 circulation；求解器告警：${
        res.warnings.filter((w) => w.includes('无法接入') || w.includes('不在')).join('；') || '无'
      }`,
      debug
    );
  }

  // ---------------------------------------------------------------- 新路径去重合并
  // 需求最重的先占格子：共享段归它，后来者从第一个空闲顶点接入。
  const order = res.edges
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (b.e.odCount ?? 1) - (a.e.odCount ?? 1) || b.e.lengthM - a.e.lengthM);

  const used = new Uint8Array(g.nx * g.ny);
  /** 每格归谁铺、铺多宽（m）。支路要在**上游那条路的边缘**起步，退多少得看上游客是谁 */
  const cellWidthM = new Map<number, number>();
  const newPaths: { path: PlannedPath; cells: number[]; edge: CirEdge }[] = [];
  let emittedM = 0;
  let totalM = 0;

  for (const { e } of order) {
    totalM += e.lengthM;
    const samples = sampleAlong(e.pts, g);
    if (samples.length < 2) continue;

    // **按"连续空闲段"切分**，不是只裁前缀。
    // 只裁前缀会让"支路先走一段自己的路、再并进主干"的情况把主干画两遍 ——
    // 实测 MF 就是这么出现 15 对 / 41 m² 重复路面的。中间被占用的段必须断开。
    const runs: { start: number; end: number }[] = [];
    let cur: { start: number; end: number } | null = null;
    for (let i = 0; i < samples.length; i++) {
      const free = samples[i].cell >= 0 && !used[samples[i].cell];
      if (free) {
        if (!cur) cur = { start: i, end: i };
        else cur.end = i;
      } else if (cur) {
        runs.push(cur);
        cur = null;
      }
    }
    if (cur) runs.push(cur);

    for (const run of runs) {
      // 太短的残余段不铺（半幅主干以内的碎头）
      if (run.end - run.start < 2) continue;
      let pts = simplify(samples.slice(run.start, run.end + 1).map((s) => s.at));
      pts = simplifyDP(pts, DP_TOL_U);
      if (pts.length < 2) continue;
      // 段首若紧接在已占用的主干上：**退到主干的边缘**起步。
      //
      // 原来的写法固定退 2.5 m（按 5 m 主干算）：3 m 支路会退过头留缝，
      // 4 m 主干又会退不够而叠面。这里按上游那条路真正的半宽算，再减掉
      // 一个栅格（起点本身已经离主干一格了）。
      if (run.start > 0) {
        const prevCell = samples[run.start - 1].cell;
        const upM = prevCell >= 0 ? (cellWidthM.get(prevCell) ?? 3) : 3;
        const back = Math.max(0, U(upM / 2) - U(1.5));
        if (back > 0) {
          const moved = advance(pts, back);
          if (!moved || moved.length < 2) continue;
          pts = moved;
        }
      }
      const cells = sampleCells(pts, g);
      for (const k of cells) {
        used[k] = 1;
        cellWidthM.set(k, Math.max(cellWidthM.get(k) ?? 0, e.widthM));
      }
      emittedM += polylineM(pts);
      newPaths.push({
        path: { pts, width: U(e.widthM), role: ROLE_OF[e.traffic], source: 'solver' },
        cells,
        edge: e,
      });
    }
  }

  const dedupedM = Math.max(0, totalM - emittedM);

  if (newPaths.length === 0) return empty('所有路径都被判为重复，没有可铺的新路', debug);

  // ---------------------------------------------------------------- 旧路替换
  const kept: PlannedPath[] = [];
  let replacedLegacy = 0;
  let widened = 0;

  for (const old of candidate.circulation) {
    if (old.pts.length < 2) continue;
    const cells = sampleCells(old.pts, g);
    if (cells.length === 0) { kept.push(old); continue; }
    const hit = cells.filter((k) => used[k]).length;
    const ratio = hit / cells.length;

    if (ratio < REPLACE_RATIO) {
      kept.push(old);
      for (const k of cells) used[k] = 1;
      continue;
    }

    // 被替换：把它的宽度并给覆盖它最多的一条新路，别把宽通道悄悄收窄
    replacedLegacy++;
    let best = newPaths[0];
    let bn = -1;
    for (const np of newPaths) {
      const n = np.cells.filter((k) => cells.includes(k)).length;
      if (n > bn) { bn = n; best = np; }
    }
    if (best && old.width > best.path.width + 1e-6) {
      best.path.width = old.width;
      widened++;
    }
  }

  const lengthM = newPaths.reduce((s, x) => s + x.edge.lengthM, 0);

  return {
    debug,
    candidate: { ...candidate, circulation: [...newPaths.map((x) => x.path), ...kept] },
    report: {
      applied: true,
      paths: newPaths.length,
      lengthM: +lengthM.toFixed(1),
      keptLegacy: kept.length,
      replacedLegacy,
      dedupedM: +dedupedM.toFixed(1),
      widened,
      odTotal,
      odConnected,
      connected: true,
      sharedRate: res.stats.sharedRate,
      ms: +(performance.now() - t0).toFixed(1),
      warnings,
    },
  };
}
