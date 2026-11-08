// F2.5-D · 从图到"街道"：路径合成 + 视觉修形
//
// C.1 的输出是一张图：节点 + 一条一条的 Cut 边。直接照这个铺路面会得到
// "每一刀一块沥青"的观感 —— 同一条街被切成 3 段、每段各自起坡收边，接缝处
// 出现硬折角。所以第一件事是把**穿过度 2 节点的连续边串成一条完整街道**。
//
// 第二步才是修形：折角用圆弧过渡（先判半径够不够，不够退切角，再不够退回原线
// 并记原因）。修形只动中间点，**路口节点与端点节点一律不动** —— 拓扑不变。

import { Pt } from '../../../../core/geom';
import type { RoadGraph, RoadClass } from '../types';
import { sectionFor, type StyleId } from './sections';
import type { BendFix, DesignPath, DesignRole, RoadSection } from './types';

const TURN_MIN_DEG = 8;
const MIN_ARC_R = 1.2;

export interface PathBuildOpts {
  style: StyleId;
}

/** 把图的边串成街道（穿过度 2 节点，同等级才串） */
export function buildDesignPaths(g: RoadGraph, opts: PathBuildOpts): DesignPath[] {
  const edgeOf = (id: string) => g.edges.get(id);
  const nodeOf = (id: string) => g.nodes.get(id);
  const deg = (id: string): number => nodeOf(id)?.connectedEdges.length ?? 0;

  const visited = new Set<string>();
  const raw: { edgeIds: string[]; nodeIds: string[]; pts: Pt[]; cls: RoadClass; widthM: number }[] = [];

  const walk = (startEdge: string): void => {
    const e0 = edgeOf(startEdge);
    if (!e0) return;
    visited.add(startEdge);
    const edgeIds = [startEdge];
    const nodeIds: string[] = [e0.from, e0.to];
    const cls = e0.roadClass;
    const widthM = e0.widthM;

    // 向后（从 e0.to 继续）
    const back = (): void => {
      for (;;) {
        const endNode = nodeIds[nodeIds.length - 1];
        if (deg(endNode) !== 2) break;
        const next = (nodeOf(endNode)?.connectedEdges ?? []).find((id) => id !== edgeIds[edgeIds.length - 1] && !visited.has(id));
        if (!next) break;
        const ne = edgeOf(next);
        if (!ne || ne.roadClass !== cls) break;
        visited.add(next);
        edgeIds.push(next);
        nodeIds.push(ne.from === endNode ? ne.to : ne.from);
      }
    };
    const forward = (): void => {
      for (;;) {
        const endNode = nodeIds[0];
        if (deg(endNode) !== 2) break;
        const next = (nodeOf(endNode)?.connectedEdges ?? []).find((id) => id !== edgeIds[0] && !visited.has(id));
        if (!next) break;
        const ne = edgeOf(next);
        if (!ne || ne.roadClass !== cls) break;
        visited.add(next);
        edgeIds.unshift(next);
        nodeIds.unshift(ne.from === endNode ? ne.to : ne.from);
      }
    };
    back();
    forward();

    // 拼中心线
    const pts: Pt[] = [];
    for (let i = 0; i < edgeIds.length; i++) {
      const e = edgeOf(edgeIds[i])!;
      const fromNode = nodeIds[i];
      const line = e.from === fromNode ? e.centerline : [...e.centerline].reverse();
      if (pts.length === 0) pts.push(...line.map((p) => new Pt(p.x, p.y)));
      else for (let k = 1; k < line.length; k++) pts.push(new Pt(line[k].x, line[k].y));
    }
    raw.push({ edgeIds, nodeIds, pts, cls, widthM });
  };

  for (const id of g.edges.keys()) if (!visited.has(id)) walk(id);

  return raw.map((r, i) => finishPath(`P${i}`, r, g, opts));
}

function finishPath(
  id: string,
  r: { edgeIds: string[]; nodeIds: string[]; pts: Pt[]; cls: RoadClass; widthM: number },
  g: RoadGraph,
  opts: PathBuildOpts
): DesignPath {
  const ends = [
    { nodeId: r.nodeIds[0], at: r.pts[0] },
    { nodeId: r.nodeIds[r.nodeIds.length - 1], at: r.pts[r.pts.length - 1] },
  ].map((e) => {
    const n = g.nodes.get(e.nodeId);
    const d = n?.connectedEdges.length ?? 0;
    const kind: 'junction' | 'terminal' | 'boundary' = d >= 3 ? 'junction' : n?.nodeType === 'boundary' ? 'boundary' : 'terminal';
    return { ...e, kind, dM: 0 };
  });

  // 角色：两头都是尽端 = 断头支路；主路不允许断头（降一级）
  const terminals = ends.filter((e) => e.kind === 'terminal').length;
  let role: DesignRole = r.cls === 'arterial' ? 'arterial' : r.cls === 'collector' ? 'collector' : 'local';
  let roleWhy = `等级来自 F2.5-C 分级（${r.cls}）`;
  if (terminals === 2 && r.pts.length >= 2) {
    role = 'dead-end';
    roleWhy = '两端都是尽端（没有路口也没有红线出口）→ 判为尽端支路';
  } else if (terminals === 1 && role === 'arterial') {
    role = 'collector';
    roleWhy = '一端是尽端 → 从主干道降为次干道（主干道不应断头）';
  } else if (terminals === 1) {
    role = 'local';
    roleWhy = '一端是尽端 → 支路（尽端路是合法形态，但不承担通过性交通）';
  }

  const section: RoadSection = sectionFor(r.cls, opts.style);
  const widthM = role === 'dead-end' || terminals === 1 ? Math.min(r.widthM, section.carriageM * 0.86) : r.widthM;

  const { pts, bends, notes } = filletPolyline(r.pts, {
    rMaxM: Math.max(4, widthM * 1.3),
    nodeIds: r.nodeIds,
  });

  // 路口端收回：口线距离（后面 junction 用同一个数，两边才对得上）
  const totalLen = polyLenM(pts);
  for (const e of ends) {
    if (e.kind !== 'junction') continue;
    e.dM = +Math.min(junctionMouthDist(widthM), Math.max(2.5, totalLen * 0.3)).toFixed(2);
  }
  const corridorPts = trimBothEnds(pts, ends[0].dM, ends[1].dM);

  return {
    id,
    edgeIds: r.edgeIds,
    cutIds: r.edgeIds.map((eid) => g.edges.get(eid)?.cutId ?? ''),
    nodeIds: r.nodeIds,
    roadClass: r.cls,
    role,
    roleWhy,
    widthM: +widthM.toFixed(2),
    section: { ...section, carriageM: +widthM.toFixed(2) },
    rawPts: r.pts,
    pts,
    corridorPts,
    bends,
    ends,
    notes,
  };
}

/** 口线到节点的距离：车行道半宽 + 一段转角空间 */
export function junctionMouthDist(widthM: number): number {
  return +Math.max(5.5, Math.min(11.5, widthM * 0.5 + 3.4)).toFixed(2);
}

// ---------------------------------------------------------------- 修形

export interface FilletOpts {
  rMaxM: number;
  nodeIds: string[];
}

/**
 * 折角修形：圆弧 → 切角 → 退回原线。
 *
 * `bends[i]` 对应 `nodeIds[i+1]`（内部节点）。修形后中心线不再穿过该节点，
 * 但**节点本身在图上没动** —— 这是"不改拓扑"的具体含义。
 */
export function filletPolyline(
  pts: Pt[],
  opts: FilletOpts
): { pts: Pt[]; bends: BendFix[]; notes: string[] } {
  const out: Pt[] = [new Pt(pts[0].x, pts[0].y)];
  const bends: BendFix[] = [];
  const notes: string[] = [];
  for (let i = 1; i + 1 < pts.length; i++) {
    const prev = out[out.length - 1];
    const v = pts[i];
    const next = pts[i + 1];
    const l1 = Pt.distance(prev, v);
    const l2 = Pt.distance(v, next);
    if (l1 < 1e-6 || l2 < 1e-6) continue;
    const d1 = new Pt((v.x - prev.x) / l1, (v.y - prev.y) / l1);
    const d2 = new Pt((next.x - v.x) / l2, (next.y - v.y) / l2);
    const cos = Math.max(-1, Math.min(1, d1.x * d2.x + d1.y * d2.y));
    const turn = Math.acos(cos);
    const turnDeg = (turn * 180) / Math.PI;
    const nodeId = opts.nodeIds[i] ?? `n${i}`;

    if (turnDeg < TURN_MIN_DEG) {
      out.push(new Pt(v.x, v.y));
      bends.push({ nodeId, at: v, turnDeg: +turnDeg.toFixed(1), action: 'none', radiusM: 0, why: '接近直线，不需要修形' });
      continue;
    }

    const half = turn / 2;
    const tanHalf = Math.tan(half);
    const legMax = 0.45 * Math.min(l1, l2);
    const rFit = legMax / Math.max(1e-3, tanHalf);
    const r = Math.min(opts.rMaxM, rFit);

    if (r >= MIN_ARC_R) {
      const t = r * tanHalf;
      const t1 = new Pt(v.x - d1.x * t, v.y - d1.y * t);
      const t2 = new Pt(v.x + d2.x * t, v.y + d2.y * t);
      const side = Math.sign(d1.x * d2.y - d1.y * d2.x) || 1;
      const n1 = new Pt(-d1.y * side, d1.x * side);
      const center = new Pt(t1.x + n1.x * r, t1.y + n1.y * r);
      const a1 = Math.atan2(t1.y - center.y, t1.x - center.x);
      const a2 = Math.atan2(t2.y - center.y, t2.x - center.x);
      let da = a2 - a1;
      while (da > Math.PI) da -= Math.PI * 2;
      while (da < -Math.PI) da += Math.PI * 2;
      const steps = Math.max(2, Math.ceil((Math.abs(da) * r) / 1.6));
      out.push(t1);
      for (let k = 1; k < steps; k++) {
        const a = a1 + (da * k) / steps;
        out.push(new Pt(center.x + Math.cos(a) * r, center.y + Math.sin(a) * r));
      }
      out.push(t2);
      bends.push({
        nodeId,
        at: v,
        turnDeg: +turnDeg.toFixed(1),
        action: 'arc',
        radiusM: +r.toFixed(2),
        why: `转角 ${turnDeg.toFixed(0)}°，圆角半径 ${r.toFixed(1)} m（受两侧最短腿 ${Math.min(l1, l2).toFixed(1)} m 约束）`,
      });
      continue;
    }

    // 圆角放不下 → 切角
    const t = Math.min(legMax, Math.max(0.6, legMax * 0.8));
    if (t >= 0.5) {
      out.push(new Pt(v.x - d1.x * t, v.y - d1.y * t));
      out.push(new Pt(v.x + d2.x * t, v.y + d2.y * t));
      bends.push({
        nodeId,
        at: v,
        turnDeg: +turnDeg.toFixed(1),
        action: 'chamfer',
        radiusM: 0,
        why: `转角 ${turnDeg.toFixed(0)}°，圆角半径不足 ${MIN_ARC_R} m → 退化为 ${(t * 2).toFixed(1)} m 切角`,
      });
      continue;
    }

    out.push(new Pt(v.x, v.y));
    bends.push({
      nodeId,
      at: v,
      turnDeg: +turnDeg.toFixed(1),
      action: 'fallback',
      radiusM: 0,
      why: `两侧腿长仅 ${Math.min(l1, l2).toFixed(1)} m，放不下圆角也放不下切角 → 退回原中心线`,
    });
    notes.push(`节点 ${nodeId} 退回原中心线（腿太短）`);
  }
  out.push(new Pt(pts[pts.length - 1].x, pts[pts.length - 1].y));
  return { pts: out, bends, notes };
}

// ---------------------------------------------------------------- 折线小工具

export function polyLenM(pts: Pt[]): number {
  let t = 0;
  for (let i = 0; i + 1 < pts.length; i++) t += Pt.distance(pts[i], pts[i + 1]);
  return t * 7;
}

/** 从起点沿折线修剪 d 米（世界单位传入） */
export function trimStart(pts: Pt[], dU: number): Pt[] {
  if (dU <= 1e-6 || pts.length < 2) return pts;
  let left = dU;
  for (let i = 0; i + 1 < pts.length; i++) {
    const L = Pt.distance(pts[i], pts[i + 1]);
    if (L <= left) {
      left -= L;
      continue;
    }
    const t = left / L;
    const p = new Pt(pts[i].x + (pts[i + 1].x - pts[i].x) * t, pts[i].y + (pts[i + 1].y - pts[i].y) * t);
    return [p, ...pts.slice(i + 1)];
  }
  const last = pts[pts.length - 1];
  return [new Pt(last.x, last.y), new Pt(last.x, last.y)];
}

/** 从终点沿折线修剪 d 米 */
export function trimEnd(pts: Pt[], dU: number): Pt[] {
  if (dU <= 1e-6 || pts.length < 2) return pts;
  const rev = [...pts].reverse();
  return trimStart(rev, dU).reverse();
}

export function trimBothEnds(pts: Pt[], startM: number, endM: number): Pt[] {
  const len = polyLenM(pts);
  const s = Math.min(startM / 7, len * 0.45);
  const e = Math.min(endM / 7, len * 0.45);
  return trimEnd(trimStart(pts, s), e);
}

/** 折线在某一端的方向（单位向量，指向折线内部） */
export function dirAtEnd(pts: Pt[], which: 'start' | 'end'): Pt {
  const n = pts.length;
  if (n < 2) return new Pt(1, 0);
  if (which === 'start') {
    const d = new Pt(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
    const l = Math.hypot(d.x, d.y) || 1;
    return new Pt(d.x / l, d.y / l);
  }
  const d = new Pt(pts[n - 2].x - pts[n - 1].x, pts[n - 2].y - pts[n - 1].y);
  const l = Math.hypot(d.x, d.y) || 1;
  return new Pt(d.x / l, d.y / l);
}
