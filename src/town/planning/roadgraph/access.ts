// F2.5-C.1 · 合法接入点（"这条路到底接进了哪里"）
//
// 诊断里最关键的一句话是"每个分量是否接触**真实的城市道路接入点**"。
// 这句话不能用一个布尔值糊过去，因为三种"接触"的强度完全不同：
//
//   cityRoad     真实城市道路（SiteRoadEdge）投影到红线上的点 —— 最硬，能开口
//   entrance     上层 Access 评分给出的机动车开口候选 —— 次硬
//   siteBoundary 只贴红线，红线外**假定**是公共空间 —— 合成样板只有这一类
//
// 所以本模块只负责两件事：给出接入点，以及给出"点到最近道路/红线"的距离。
// 判定上的区别留给 diagnose.ts 去说，这里不替它下结论。

import { Pt } from '../../../core/geom';
import type { PlanSurface } from '../core/surface';
import type { SiteRoadEdge } from '../core/types';
import type { RoadClass } from './types';

export type AccessKind = 'cityRoad' | 'entrance' | 'siteBoundary';

export const ACCESS_RANK: Record<AccessKind, number> = {
  cityRoad: 3,
  entrance: 2,
  siteBoundary: 1,
};

export interface AccessPoint {
  id: string;
  at: Pt;
  kind: AccessKind;
  /** 真实城市道路等级（仅 cityRoad 有） */
  roadClass?: RoadClass;
  /** 接入点到红线的距离（米） */
  offsetM: number;
  label?: string;
}

export interface AccessOpts {
  /** 真实城市道路：只取贴着地块的那几条 */
  roads?: SiteRoadEdge[];
  /** 上层给的机动车开口候选 */
  entrances?: Pt[];
  /** 道路中心线到红线的最大容许距离（米） */
  roadTolM?: number;
  /** 同类接入点的合并半径（米） */
  dedupeM?: number;
}

/**
 * 采集接入点。
 *
 * 道路边不是直接当接入点用的：先把它的中点投影到红线上 —— 这条路在红线上的
 * 落点才是"开口位置"。否则接入点会飘到马路中间，后面对分量归类就会错。
 */
export function accessPointsOf(boundary: PlanSurface, opts: AccessOpts = {}): AccessPoint[] {
  const roadTol = opts.roadTolM ?? 26;
  const dedupe = (opts.dedupeM ?? 10) / 7;
  const out: AccessPoint[] = [];

  const add = (at: Pt, kind: AccessKind, roadClass?: RoadClass, label?: string, offsetM = 0): void => {
    let weakIdx = -1;
    for (let i = 0; i < out.length; i++) {
      if (Pt.distance(out[i].at, at) > dedupe) continue;
      // 同一位置已有更强的接入依据 → 保留强的
      if (ACCESS_RANK[out[i].kind] >= ACCESS_RANK[kind]) return;
      weakIdx = i;
    }
    const ap: AccessPoint = { id: `ax${out.length}_${kind}`, at: new Pt(at.x, at.y), kind, roadClass, offsetM, label };
    if (weakIdx >= 0) out[weakIdx] = ap;
    else out.push(ap);
  };

  for (const e of opts.roads ?? []) {
    const mid = new Pt((e.a.x + e.b.x) / 2, (e.a.y + e.b.y) / 2);
    const q = projectToRing(mid, boundary.outer);
    const d = Pt.distance(mid, q) * 7;
    if (d > roadTol) continue;
    add(q, 'cityRoad', e.cls as RoadClass, e.key, +d.toFixed(1));
  }
  for (const p of opts.entrances ?? []) {
    const q = projectToRing(p, boundary.outer);
    add(q, 'entrance', undefined, 'entrance', +(Pt.distance(p, q) * 7).toFixed(1));
  }
  return out;
}

/** 合成样板没有真实道路：把红线本身当作（弱）接入依据，供出图与诊断共用 */
export function boundaryAccessOf(boundary: PlanSurface, stepM = 40): AccessPoint[] {
  const out: AccessPoint[] = [];
  const ring = boundary.outer;
  let acc = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const L = Pt.distance(a, b) * 7;
    if (L < 1) continue;
    const n = Math.max(1, Math.round(L / stepM));
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      out.push({ id: `sb${out.length}`, at: new Pt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t), kind: 'siteBoundary', offsetM: 0 });
      acc++;
    }
  }
  void acc;
  return out;
}

/** 点到环的最近点（投影） */
export function projectToRing(p: Pt, ring: Pt[]): Pt {
  let best = ring[0] ?? new Pt();
  let bd = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const q = closestOnSeg(p, a, b);
    const d = Pt.distance(p, q);
    if (d < bd) {
      bd = d;
      best = q;
    }
  }
  return new Pt(best.x, best.y);
}

export function closestOnSeg(p: Pt, a: Pt, b: Pt): Pt {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-12) return new Pt(a.x, a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return new Pt(a.x + dx * t, a.y + dy * t);
}

/** 点到线段距离（米） */
export function distToSegmentM(p: Pt, a: Pt, b: Pt): number {
  return Pt.distance(p, closestOnSeg(p, a, b)) * 7;
}

/** 点到一组多段线的最短距离（米） */
export function distToLinesM(p: Pt, lines: Pt[][], capM = Infinity): number {
  let best = capM / 7;
  for (const ln of lines) {
    for (let i = 0; i + 1 < ln.length; i++) {
      const d = Pt.distance(p, closestOnSeg(p, ln[i], ln[i + 1]));
      if (d < best) best = d;
    }
  }
  return best * 7;
}

/** 点到一组道路的最短距离（米）；`lines` 用折线表达，方便直接喂中心线 */
export function distToAccessM(p: Pt, access: AccessPoint[]): number {
  let best = Infinity;
  for (const a of access) best = Math.min(best, Pt.distance(p, a.at) * 7);
  return best;
}
