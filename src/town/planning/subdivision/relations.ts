// F2 · 临街与接入关系
//
// 这里只回答两个问题，且**只承认真实道路**：
//   ① 这一块地到底临哪条路、临了多长（不把街区外边界一律当道路）；
//   ② 它能不能开门、门开在哪（不能虚构车辆入口）。
//
// 与既有实现的分工：
//   · `resolveFrontages`（core/context.ts:173）在**街区级**做同一件事，
//     带四项打分与"同一条街多段合并"；这里不重写那套打分，
//     只在**地块级**做区间长度量化，并复用它的 3 单位匹配口径（≈21 m）。
//   · `edgesForPiece`（adapters/subdivide.ts:195）在没有道路时会**造一条虚拟
//     alley edge** 塞进 roadEdges —— 下游无从分辨"真路"和"编出来的路"。
//     本层不这么做：巷接单独用 `AccessRef.via='alley'` + `viaSibling` 表达。

import { Pt, distToSegment } from '../../../core/geom';
import type { AccessKind, FrontageRole, SiteRoadEdge } from '../core/types';
import type { AccessRef, FrontageRef } from './types';
import type { PlanSurface } from '../core/surface';

/** 与道路中心线的匹配阈值（世界单位）：沿用 core/context.ts 的 3 单位 ≈ 21 m */
export const FRONTAGE_TOL_U = 3;

const SAMPLES_PER_U = 6;

interface EdgeSample {
  x: number;
  y: number;
  /** 沿外环的累计长度（世界单位） */
  s: number;
  /** 所属外环边的下标（用来取代表边） */
  edge: number;
}

function samplesOf(s: PlanSurface): EdgeSample[] {
  const out: EdgeSample[] = [];
  const ring = s.outer;
  let acc = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    const L = Pt.distance(p, q);
    const n = Math.max(1, Math.ceil(L * SAMPLES_PER_U));
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t, s: acc + L * t, edge: i });
    }
    acc += L;
  }
  return out;
}

/**
 * 一块地的真实临街关系。
 *
 * 判据：地块外环上的采样点，若到某条道路**线段**的距离 ≤ 3 单位，
 * 就认为这一点临那条路。于是"临街长度"是**投影长度**，斜边地块天然正确
 * （旧实现按"边中点最近"匹配，一条斜边上只有中点被计入，长度被严重低估）。
 */
export function frontagesOf(piece: PlanSurface, roadEdges: SiteRoadEdge[]): FrontageRef[] {
  if (roadEdges.length === 0 || piece.outer.length < 3) return [];
  const samples = samplesOf(piece);
  if (samples.length === 0) return [];

  interface Acc {
    edge: SiteRoadEdge;
    len: number;
    /** 距离累加（用于 meanDist） */
    distSum: number;
    count: number;
    bestEdgeIdx: number;
    bestEdgeHits: number;
  }
  const acc = new Map<string, Acc>();
  const hits = new Map<string, number>();
  for (const e of roadEdges) hits.set(e.key, 0);

  const stepLen = (() => {
    let per = 0;
    for (let i = 0; i < piece.outer.length; i++) {
      per += Pt.distance(piece.outer[i], piece.outer[(i + 1) % piece.outer.length]);
    }
    return per / Math.max(1, samples.length);
  })();

  for (const smp of samples) {
    const q = new Pt(smp.x, smp.y);
    let best: { e: SiteRoadEdge; d: number } | null = null;
    for (const e of roadEdges) {
      const d = distToSegment(q, e.a, e.b);
      if (d > FRONTAGE_TOL_U) continue;
      if (!best || d < best.d) best = { e, d };
    }
    if (!best) continue;
    const e = best.e;
    let a = acc.get(e.key);
    if (!a) {
      a = { edge: e, len: 0, distSum: 0, count: 0, bestEdgeIdx: smp.edge, bestEdgeHits: 0 };
      acc.set(e.key, a);
    }
    a.len += stepLen;
    a.distSum += best.d;
    a.count += 1;
    hits.set(e.key, (hits.get(e.key) ?? 0) + 1);
    if ((hits.get(e.key) ?? 0) > a.bestEdgeHits) {
      a.bestEdgeHits = hits.get(e.key) ?? 0;
      a.bestEdgeIdx = smp.edge;
    }
  }

  const out: FrontageRef[] = [];
  const perimeterU = samples.length * stepLen;
  for (const a of acc.values()) {
    if (a.len < 1e-3) continue;
    const ring = piece.outer;
    const ea = ring[a.bestEdgeIdx];
    const eb = ring[(a.bestEdgeIdx + 1) % ring.length];
    const roadClass = a.edge.cls === 'arterial' ? 1 : a.edge.cls === 'collector' ? 0.72 : 0.46;
    const sharedLength = Math.min(1, a.len / 2.4); // 2.4 单位 ≈ 17 m 就算"占满一条边"
    const meanDist = a.count > 0 ? a.distSum / a.count : 0;
    const visibility = Math.max(0, 1 - meanDist / FRONTAGE_TOL_U);
    const accessibility = a.edge.sidewalk > 0.05 ? 1 : a.edge.carriageSide > 0.05 ? 0.55 : 0.15;
    out.push({
      roadKey: a.edge.key,
      cls: a.edge.cls,
      role: 'none',
      lengthM: a.len * 7,
      share: perimeterU > 0 ? a.len / perimeterU : 0,
      edge: [ea, eb],
      score: 0.45 * roadClass + 0.25 * sharedLength + 0.2 * visibility + 0.1 * accessibility,
    });
  }

  // 角色分配：分高者 primary，次高且够 55% 的给 secondary，其余 local 面给 service
  out.sort((x, y) => y.score - x.score);
  if (out.length > 0) out[0].role = 'primary';
  if (out.length > 1) out[1].role = out[1].score >= out[0].score * 0.55 ? 'secondary' : 'service';
  for (let i = 2; i < out.length; i++) {
    out[i].role = out[i].cls === 'local' ? 'service' : 'secondary';
  }
  return out;
}

/** 取一条临街面上的一点（fract: 0~1，沿代表边插值） */
export function pointOnFrontage(f: FrontageRef, fract: number): Pt {
  const [a, b] = f.edge;
  return new Pt(a.x + (b.x - a.x) * fract, a.y + (b.y - a.y) * fract);
}

function centroidOf(s: PlanSurface): Pt {
  let x = 0;
  let y = 0;
  for (const p of s.outer) {
    x += p.x;
    y += p.y;
  }
  return new Pt(x / s.outer.length, y / s.outer.length);
}

/** 朝外法线：从地块质心指向接入点，再归一化 */
function outward(center: Pt, at: Pt): Pt {
  const dx = at.x - center.x;
  const dy = at.y - center.y;
  const L = Math.hypot(dx, dy) || 1;
  return new Pt(dx / L, dy / L);
}

export interface AccessOpts {
  /** 开口最小面宽（m）：低于它不算合法车行入口 */
  minWidthM: number;
}

/**
 * 直接临路的接入点。
 *
 * 只在**真实临街面**上开口：没有临街面就返回空 —— 由调用方决定
 * "放弃这一刀"还是"经巷接入"，绝不在这里编一个入口。
 */
export function roadAccessOf(piece: PlanSurface, frontages: FrontageRef[], opts: AccessOpts): AccessRef[] {
  const usable = frontages.filter((f) => f.lengthM >= opts.minWidthM);
  if (usable.length === 0) return [];
  const center = centroidOf(piece);
  const out: AccessRef[] = [];
  const primary = usable[0];
  const va = pointOnFrontage(primary, 0.5);
  out.push({
    kind: 'vehicle',
    at: va,
    normal: outward(center, va),
    via: 'road',
    requiresInternalLane: false,
  });
  const pa = pointOnFrontage(primary, 0.25);
  out.push({
    kind: 'pedestrian',
    at: pa,
    normal: outward(center, pa),
    via: 'road',
    requiresInternalLane: false,
  });
  // 第二条临街面（街角）给服务/货运入口，避免客货同口
  if (usable.length > 1) {
    const second = usable[1];
    const sa = pointOnFrontage(second, 0.5);
    out.push({
      kind: second.role === 'service' ? 'service' : 'vehicle',
      at: sa,
      normal: outward(center, sa),
      via: 'road',
      requiresInternalLane: false,
    });
  }
  return out;
}

/**
 * 经相邻地块共享边界接入（后排巷）。
 *
 * 这是"每块必须临街（街道 / 共享庭院 / ≥6 m 通道）"里的第三类。
 * 必须显式标记 `via:'alley'` + `requiresInternalLane:true`：
 * 它意味着**下游要真的铺一条通道**，不是数据上补个字段就算了。
 */
export function alleyAccessOf(
  piece: PlanSurface,
  sibling: PlanSurface,
  siblingId: string,
  minWidthM: number,
  tol = 0.08
): AccessRef | null {
  const shared = sharedBoundaryWith(piece, sibling, tol);
  if (shared.lengthM < minWidthM) return null;
  const center = centroidOf(piece);
  return {
    kind: 'vehicle',
    at: shared.mid,
    normal: outward(center, shared.mid),
    via: 'alley',
    viaPieceId: siblingId,
    requiresInternalLane: true,
  };
}

/** 两块地的共享边界：长度（m） + 中点 + 一侧代表边 */
export function sharedBoundaryWith(
  a: PlanSurface,
  b: PlanSurface,
  tol = 0.08
): { lengthM: number; mid: Pt; edge: [Pt, Pt] } {
  const rings = [b.outer, ...b.holes];
  const hits: { p: Pt; len: number; edge: number }[] = [];
  const step = 0.15;
  for (let i = 0; i < a.outer.length; i++) {
    const p = a.outer[i];
    const q = a.outer[(i + 1) % a.outer.length];
    const L = Pt.distance(p, q);
    if (L < 1e-9) continue;
    const n = Math.max(1, Math.ceil(L / step));
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      const x = p.x + (q.x - p.x) * t;
      const y = p.y + (q.y - p.y) * t;
      let hit = false;
      for (const ring of rings) {
        for (let j = 0; j < ring.length; j++) {
          if (distToSegment(new Pt(x, y), ring[j], ring[(j + 1) % ring.length]) <= tol) {
            hit = true;
            break;
          }
        }
        if (hit) break;
      }
      if (hit) hits.push({ p: new Pt(x, y), len: L / n, edge: i });
    }
  }
  if (hits.length === 0) {
    return { lengthM: 0, mid: centroidOf(a), edge: [a.outer[0], a.outer[1 % a.outer.length]] };
  }
  const total = hits.reduce((s, h) => s + h.len, 0);
  const mid = hits[Math.floor(hits.length / 2)];
  const e0 = a.outer[mid.edge];
  const e1 = a.outer[(mid.edge + 1) % a.outer.length];
  return { lengthM: total * 7, mid: mid.p, edge: [e0, e1] };
}

/** 接入点是否落在某块地内部（非法：门开在别人家里） */
export function accessKindLabel(kind: AccessKind): string {
  return kind === 'vehicle' ? '车行' : kind === 'pedestrian' ? '人行' : kind === 'service' ? '服务' : '货运';
}

/** 角色标号（图例与报告共用） */
export function roleLabel(role: FrontageRole): string {
  return role === 'primary' ? '主临街' : role === 'secondary' ? '次临街' : role === 'service' ? '服务面' : '无';
}
