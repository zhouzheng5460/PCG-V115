// F3 · 道路设计层：中心线平滑与街道分级
//
// 【噪波机制已移除】用户要求：路网形态不得再由噪波决定。
// 原来这里有两条噪声链 —— `warpGraph`（整图 fbm 位移场）和 `reshape` 里的
// 逐街长波噪波 —— 它们会把中心线、甚至节点坐标推偏 10~20 m。
// 现在路网的弯曲**只来自第一步的张量场**（主干流线）与面切分本身；
// 这一层只做不改变拓扑的重采样 + Chaikin 平滑，再按街长分三级。
//
// 仍保留的工程约束
// ----------------
// · 端点（= 路口节点）位置**一律不动**，所以路口位置、连接关系、面结构全部不变；
// · 修形要**按路径**做，不能按边做：一条街被 5 个路口切成 6 段，
//   逐段平滑会在每个度 2 节点处留下一个折角（正是"碎成小段"的观感）。
//   所以先拼成整条街 → 修形 → 再按原边界切开。

import { Pt } from '../core/geom';
import type { CityStyle, PathGraph, RoadClass3, RoadPath } from './types';

export interface DesignStats {
  /** 位移最大值（米）：评估"修形有多明显" */
  maxOffsetM: number;
  /** 平均位移（米） */
  meanOffsetM: number;
  /** 处理前后的折角（> 12°）数量：修形应当把它降下来 */
  kinksBefore: number;
  kinksAfter: number;
  mix: Record<RoadClass3, number>;
  thresholds: { arterialM: number; collectorM: number };
  /** 串出来的"街"数（跨路口连续） */
  chains: number;
  /** 其中主干的条数：应当接近 1~3 条贯通全城的主街，而不是几十段碎段 */
  arterialChains: number;
}

export interface DesignOpts {
  /** Chaikin 平滑迭代次数（只平滑，不加位移） */
  smooth: number;
  /** 采样间距（米） */
  stepM: number;
}

/** 风貌 → 平滑参数。噪波已移除：形态差异全部来自第一步的张量场与切分规模 */
export function designOptsOf(style: CityStyle): DesignOpts {
  switch (style) {
    case 'organic':
      return { smooth: 2, stepM: 4 };
    case 'campus':
      return { smooth: 1, stepM: 5 };
    default:
      return { smooth: 2, stepM: 4 };
  }
}

/**
 * 修形整张图（原地改 `edge.pts` / `path.pts`，不动节点坐标）。
 *
 * 只改几何，不改 `nodes` 的 `at` —— 这是"拓扑不变"的唯一保证：
 * 任何下游（路口多边形、地块、标记）都从 nodes 取路口位置，
 * 从 edges 取走向，两者一致。
 */
export function designGraph(graph: PathGraph, style: CityStyle, seed: number, boundary?: { outer: Pt[] }): DesignStats {
  const opts = designOptsOf(style);
  // seed / boundary 只保留在签名上以兼容调用方；噪波机制移除后不再使用
  void seed;
  void boundary;
  let maxOff = 0;
  let sumOff = 0;
  let count = 0;
  let kinksBefore = 0;
  let kinksAfter = 0;

  for (const path of graph.paths) {
    const nodes: Pt[] = path.nodeIds.map((id) => graph.nodes.get(id)?.at ?? path.pts[0]);
    const origin = path.pts.map((p) => new Pt(p.x, p.y));
    kinksBefore += countKinks(resample(origin, opts.stepM / 7));

    const lens = edgeLengths(graph, path);
    const totalU = lens.reduce((a, b) => a + b, 0);
    if (totalU < 1e-6) continue;

    // ① 重采样 + 平滑 + 噪波
    const designed = reshape(origin, opts);

    // ② 位移统计（只统计内部点：端点是钉死的）
    for (let i = 1; i + 1 < designed.length; i++) {
      const q = nearestOnPolyline(designed[i], origin);
      const d = Pt.distance(designed[i], q) * 7;
      maxOff = Math.max(maxOff, d);
      sumOff += d;
      count++;
    }

    // ③ 端点钉回节点（噪波窗口已让它接近 0，这里做精确对齐）
    designed[0] = new Pt(nodes[0].x, nodes[0].y);
    designed[designed.length - 1] = new Pt(nodes[nodes.length - 1].x, nodes[nodes.length - 1].y);

    // ④ 按原始各边长度切开，端点用节点坐标覆盖
    const cum: number[] = [0];
    for (const L of lens) cum.push(cum[cum.length - 1] + L);
    const scale = polyLenU(designed) / Math.max(1e-9, totalU);
    path.edgeIds.forEach((eid, i) => {
      const e = graph.edges.get(eid);
      if (!e) return;
      const s0 = cum[i] * scale;
      const s1 = cum[i + 1] * scale;
      const sub = subByArc(designed, s0, s1);
      if (sub.length < 2) return;
      // 两端严格落在节点上：否则路口多边形的入射方向会差一点点，
      // 在锐角路口会放大成一个缺口
      sub[0] = new Pt(nodes[i].x, nodes[i].y);
      sub[sub.length - 1] = new Pt(nodes[i + 1].x, nodes[i + 1].y);
      e.pts = sub;
    });

    // ⑤ 路径点列 = 各边首尾相接
    const merged: Pt[] = [];
    for (const eid of path.edgeIds) {
      const e = graph.edges.get(eid);
      if (!e) continue;
      for (const p of e.pts) {
        const last = merged[merged.length - 1];
        if (last && Pt.distance(last, p) < 1e-9) continue;
        merged.push(new Pt(p.x, p.y));
      }
    }
    if (merged.length >= 2) {
      path.pts = merged;
      kinksAfter += countKinks(merged);
    }
  }

  return {
    maxOffsetM: +maxOff.toFixed(2),
    meanOffsetM: +(count ? sumOff / count : 0).toFixed(2),
    kinksBefore,
    kinksAfter,
    mix: { arterial: 0, collector: 0, local: 0 },
    thresholds: { arterialM: 0, collectorM: 0 },
    chains: 0,
    arterialChains: 0,
  };
}

/**
 * 街道三级分类（Houdini 口径：一条街越长，承载越重）。
 *
 * 分级对象是**连通街**（跨路口串起来的整条街），不是两个路口之间的一段：
 * 否则主街在每个路口都会换一次等级，图上读不出层级。
 *
 * 两条约束防止「长度」被误用：按条数取分位（前 12% / 前 40%）；
 * 主干还要求长度 ≥ 中位数的 1.15 倍且 ≥ 110 m。
 */
/**
 * 街道分级统计 —— **不再改写等级**。
 *
 * 等级由「生成层级」决定，在链路里就定死了：
 *   张量场流线 = 主干（城市最宽一级，决定整体形态）；
 *   递归面切分第一刀 = 次干（穿过整个超街区）；
 *   更深 = 支路（把半块再对半分）。
 *
 * 旧实现按"连通街长"重排：前 12% 且够长的升主干、前 40% 升次干。在
 * 「张量只管主干」这条链路里这是错的 —— 二级切出来的长街会被升成主干，
 * 三级路网塌成一级，图上就只剩张量那套网格（用户原话："全是张量起作用，
 * 看不到二级切割产生的低一级道路系统"）。
 *
 * 现在这里只做两件事：统计各等级长度占比（HUD / 报告用），以及给出
 * 街长分布阈值（诊断用），不再碰 `edge.cls` / `path.cls`。
 */
export function classifyStreets(
  graph: PathGraph,
  notes: string[]
): { mix: Record<RoadClass3, number>; thresholds: DesignStats['thresholds']; chains: number; arterialChains: number } {
  const empty = { arterial: 0, collector: 0, local: 0 };
  const chains = buildStreetChains(graph);
  if (chains.length === 0) return { mix: empty, thresholds: { arterialM: 0, collectorM: 0 }, chains: 0, arterialChains: 0 };

  const mix: Record<RoadClass3, number> = { arterial: 0, collector: 0, local: 0 };
  const count: Record<RoadClass3, number> = { arterial: 0, collector: 0, local: 0 };
  for (const p of graph.paths) {
    let L = 0;
    for (let i = 0; i + 1 < p.pts.length; i++) L += Pt.distance(p.pts[i], p.pts[i + 1]) * 7;
    mix[p.cls] += L;
    count[p.cls] += 1;
  }
  const lens = chains.map((c) => c.lengthM).sort((a, b) => a - b);
  const tot = mix.arterial + mix.collector + mix.local || 1;
  const thresholds = {
    arterialM: Math.round((lens[Math.floor(lens.length * 0.88)] ?? 0)),
    collectorM: Math.round((lens[Math.floor(lens.length * 0.6)] ?? 0)),
  };
  const pct = (v: number): string => ((v / tot) * 100).toFixed(0);
  notes.push(
    `路网三级（按**生成层级**，不按长度重排）：主干 ${pct(mix.arterial)}%（${count.arterial} 段，张量流线）/ ` +
      `次干 ${pct(mix.collector)}%（${count.collector} 段，递归切分第一刀）/ 支路 ${pct(mix.local)}%（${count.local} 段）`
  );
  return {
    mix: {
      arterial: +(mix.arterial / tot).toFixed(3),
      collector: +(mix.collector / tot).toFixed(3),
      local: +(mix.local / tot).toFixed(3),
    },
    thresholds,
    chains: chains.length,
    arterialChains: count.arterial,
  };
}

interface StreetChain {
  edges: string[];
  lengthM: number;
}

/** 直行配对串街：度 2 一律配对，度 ≥3 只在「够直」时配对 */
function buildStreetChains(graph: PathGraph): StreetChain[] {
  const dirAway = (eid: string, nid: string): Pt | null => {
    const e = graph.edges.get(eid);
    if (!e) return null;
    const pts = e.pts;
    if (pts.length < 2) return null;
    const atStart = e.a === nid;
    const a = atStart ? pts[0] : pts[pts.length - 1];
    const b = atStart ? pts[1] : pts[pts.length - 2];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L = Math.hypot(dx, dy) || 1;
    return new Pt(dx / L, dy / L);
  };

  const pair = new Map<string, string>();
  for (const [nid, node] of graph.nodes) {
    const list = [...new Set(node.edges)];
    if (list.length < 2) continue;
    const key = (eid: string): string => `${nid}|${eid}`;
    if (list.length === 2) {
      pair.set(key(list[0]), list[1]);
      pair.set(key(list[1]), list[0]);
      continue;
    }
    // 度 ≥ 3：按"直着穿过去"的程度贪心配对
    const cands: { i: number; j: number; dev: number }[] = [];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const d1 = dirAway(list[i], nid);
        const d2 = dirAway(list[j], nid);
        if (!d1 || !d2) continue;
        const dot = Math.max(-1, Math.min(1, d1.x * d2.x + d1.y * d2.y));
        cands.push({ i, j, dev: Math.PI - Math.acos(dot) });
      }
    }
    cands.sort((a, b) => a.dev - b.dev);
    const used = new Set<number>();
    for (const c of cands) {
      if (c.dev > (35 * Math.PI) / 180) break;
      if (used.has(c.i) || used.has(c.j)) continue;
      used.add(c.i);
      used.add(c.j);
      pair.set(key(list[c.i]), list[c.j]);
      pair.set(key(list[c.j]), list[c.i]);
    }
  }

  const seen = new Set<string>();
  const out: StreetChain[] = [];
  for (const e0 of graph.edges.keys()) {
    if (seen.has(e0)) continue;
    const e = graph.edges.get(e0)!;
    const forward: string[] = [e0];
    seen.add(e0);
    // 向前
    let cur = e0;
    let node = e.b;
    for (let guard = 0; guard < 400; guard++) {
      const next = pair.get(`${node}|${cur}`);
      if (!next || seen.has(next)) break;
      seen.add(next);
      forward.push(next);
      const ne = graph.edges.get(next)!;
      node = ne.a === node ? ne.b : ne.a;
      cur = next;
    }
    // 向后
    cur = e0;
    node = e.a;
    for (let guard = 0; guard < 400; guard++) {
      const next = pair.get(`${node}|${cur}`);
      if (!next || seen.has(next)) break;
      seen.add(next);
      forward.unshift(next);
      const ne = graph.edges.get(next)!;
      node = ne.a === node ? ne.b : ne.a;
      cur = next;
    }
    let len = 0;
    for (const id of forward) len += polyLenU(graph.edges.get(id)?.pts ?? []);
    out.push({ edges: forward, lengthM: +(len * 7).toFixed(1) });
  }
  return out;
}

// ---------------------------------------------------------------- 修形

/** 重采样 → Chaikin 平滑。不再叠加任何噪波位移（路网形态由张量场决定） */
function reshape(pts: Pt[], opts: DesignOpts): Pt[] {
  const stepU = opts.stepM / 7;
  let line = resample(pts, stepU);
  if (line.length < 3) return pts.map((p) => new Pt(p.x, p.y));
  for (let it = 0; it < opts.smooth; it++) line = chaikin(line);
  // 平滑后点变密，重新按 ~step 采样，保证各边按弧长切开的尺度稳定
  const out = resample(line, stepU * 0.85);
  return out.length >= 3 ? out : pts.map((p) => new Pt(p.x, p.y));
}

/** 按弧长重采样（含端点） */
function resample(pts: Pt[], stepU: number): Pt[] {
  const out: Pt[] = [new Pt(pts[0].x, pts[0].y)];
  let carry = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const L = Pt.distance(a, b);
    if (L < 1e-9) continue;
    let t = stepU - carry;
    while (t < L) {
      out.push(new Pt(a.x + ((b.x - a.x) * t) / L, a.y + ((b.y - a.y) * t) / L));
      t += stepU;
    }
    carry = L - (t - stepU);
  }
  const last = pts[pts.length - 1];
  if (Pt.distance(out[out.length - 1], last) > stepU * 0.25) out.push(new Pt(last.x, last.y));
  else out[out.length - 1] = new Pt(last.x, last.y);
  return out;
}

/** Chaikin 细分，端点固定 */
function chaikin(pts: Pt[]): Pt[] {
  if (pts.length < 3) return pts;
  const out: Pt[] = [new Pt(pts[0].x, pts[0].y)];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (i > 0) out.push(new Pt(a.x * 0.75 + b.x * 0.25, a.y * 0.75 + b.y * 0.25));
    if (i + 1 < pts.length - 1) out.push(new Pt(a.x * 0.25 + b.x * 0.75, a.y * 0.25 + b.y * 0.75));
  }
  out.push(new Pt(pts[pts.length - 1].x, pts[pts.length - 1].y));
  return out;
}

// ---------------------------------------------------------------- 小工具

function polyLenU(pts: Pt[]): number {
  let s = 0;
  for (let i = 0; i + 1 < pts.length; i++) s += Pt.distance(pts[i], pts[i + 1]);
  return s;
}

function edgeLengths(graph: PathGraph, path: RoadPath): number[] {
  return path.edgeIds.map((id) => polyLenU(graph.edges.get(id)?.pts ?? []));
}

/** 折线 [s0, s1] 段（弧长，世界单位），两端按插值生成 */
function subByArc(pts: Pt[], s0: number, s1: number): Pt[] {
  const out: Pt[] = [];
  const at = (s: number): Pt => {
    let acc = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      const L = Pt.distance(pts[i], pts[i + 1]);
      if (acc + L >= s || i + 2 === pts.length) {
        const t = L < 1e-12 ? 0 : Math.max(0, Math.min(1, (s - acc) / L));
        return new Pt(pts[i].x + (pts[i + 1].x - pts[i].x) * t, pts[i].y + (pts[i + 1].y - pts[i].y) * t);
      }
      acc += L;
    }
    return new Pt(pts[pts.length - 1].x, pts[pts.length - 1].y);
  };
  out.push(at(s0));
  let acc = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const L = Pt.distance(pts[i], pts[i + 1]);
    if (acc > s0 && acc < s1) out.push(new Pt(pts[i].x, pts[i].y));
    acc += L;
  }
  out.push(at(s1));
  return dedupe(out);
}

function dedupe(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Pt.distance(last, p) < 1e-7) continue;
    out.push(p);
  }
  return out;
}

/** 折角计数（相邻两段夹角 > 12°，且两段都长于 4 m） */
function countKinks(pts: Pt[]): number {
  let n = 0;
  for (let i = 1; i + 1 < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const c = pts[i + 1];
    const l1 = Pt.distance(a, b);
    const l2 = Pt.distance(b, c);
    if (l1 < 2.5 / 7 || l2 < 2.5 / 7) continue;
    const d1x = (b.x - a.x) / l1;
    const d1y = (b.y - a.y) / l1;
    const d2x = (c.x - b.x) / l2;
    const d2y = (c.y - b.y) / l2;
    const ang = Math.acos(Math.max(-1, Math.min(1, d1x * d2x + d1y * d2y)));
    if (ang > (12 * Math.PI) / 180) n++;
  }
  return n;
}

function nearestOnPolyline(p: Pt, pts: Pt[]): Pt {
  let best = Infinity;
  let at = p;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    let t = l2 < 1e-12 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    const q = new Pt(a.x + dx * t, a.y + dy * t);
    const d = Pt.distance(p, q);
    if (d < best) {
      best = d;
      at = q;
    }
  }
  return at;
}
