// F2.5-C.2 · 道路先于地块：从道路占地反推 Compound
//
// 任务书要求"最终道路中心线确认后，生成道路实际占地，从场地中扣除道路，
// 再划分 Compound，不得为了保留原始 Voronoi Cell 边界而牺牲道路形态"。
//
// 所以这一步完全不看 fracture 的 cell：输入只有"场地"和"道路面"，
// 输出是"扣掉路之后剩下的每一块地"，再用 **Recursive OBB** 继续细分
// （复用 F2.1 的 `obbOf` + `splitSurfaceByLine`，不新写几何）。
//
// 切的方向是"垂直于长轴"：这样切开后的两块**都还临街**。
// 若沿长轴切，后排那块就变成没有临街面的地 —— 建筑布局阶段会直接卡住。

import { Pt } from '../../../../core/geom';
import { obbOf, splitSurfaceByLine } from '../../subdivision/geom';
import { surfaceArea, surfaceSubtract, type PlanSurface } from '../../core/surface';

const M2 = (u2: number) => u2 * 49;

export interface Compound {
  id: string;
  surface: PlanSurface;
  areaM2: number;
  /** 短轴跨度（米） */
  minorM: number;
  /** 长短轴比 */
  aspect: number;
  /** 4πA/P² */
  shapeQ: number;
  /** 临街长度（米，沿道路中心线量） */
  frontageM: number;
  /** 临街长度 / 周长 */
  frontageRatio: number;
}

export interface CompoundOpts {
  /** 超过这个面积就继续切（m²） */
  targetMaxM2: number;
  /** 小于这个面积不再切（m²） */
  targetMinM2: number;
  /** 长短轴比超过它也要切 */
  maxAspect: number;
  maxDepth?: number;
  /** 面积小于它的碎块直接丢弃（m²） */
  discardM2?: number;
}

export interface CompoundResult {
  compounds: Compound[];
  /** 扣完路之后、切之前的碎块（出图看"路切出了几块地"） */
  pieces: PlanSurface[];
  remainderAreaM2: number;
  notes: string[];
}

/** 道路中心线（用于量临街）：只保留几何与半宽 */
export interface RoadRail {
  pts: Pt[];
  halfM: number;
}

export function compoundsFromRoads(
  boundary: PlanSurface,
  roads: PlanSurface[],
  rails: RoadRail[],
  opts: CompoundOpts
): CompoundResult {
  const notes: string[] = [];
  const discard = opts.discardM2 ?? 45;
  let rest: PlanSurface[] = [];
  try {
    rest = surfaceSubtract([boundary], roads).filter((s) => M2(surfaceArea(s)) >= discard);
  } catch {
    rest = [boundary];
    notes.push('道路扣减失败：退回整块场地（布尔退化）');
  }
  const pieces = rest.slice();
  const out: PlanSurface[] = [];
  for (const p of rest) splitRecursive(p, 0, opts, out);

  const compounds = out.map((s, i) => {
    const m = metrics(s);
    const fr = frontageOf(s.outer, rails);
    return {
      id: `K${i}`,
      surface: s,
      areaM2: +M2(surfaceArea(s)).toFixed(0),
      minorM: m.minorM,
      aspect: m.aspect,
      shapeQ: m.shapeQ,
      frontageM: +fr.lengthM.toFixed(1),
      frontageRatio: +(fr.lengthM / Math.max(1, m.perimeterM)).toFixed(3),
    };
  });
  notes.push(`扣路后 ${pieces.length} 块，细分成 ${compounds.length} 块 Compound`);
  return { compounds, pieces, remainderAreaM2: +M2(rest.reduce((s, x) => s + surfaceArea(x), 0)).toFixed(0), notes };
}

function splitRecursive(s: PlanSurface, depth: number, opts: CompoundOpts, out: PlanSurface[]): void {
  const area = M2(surfaceArea(s));
  const ob = obbOf(s.outer);
  const aspect = ob && ob.d > 1e-9 ? ob.w / ob.d : 1;
  const needArea = area > opts.targetMaxM2;
  const needShape = aspect > opts.maxAspect;
  if (depth >= (opts.maxDepth ?? 4) || (!needArea && !needShape) || !ob) {
    out.push(s);
    return;
  }
  // 垂直于长轴切（沿短边方向），保证两块都临街
  const ang = Math.atan2(ob.uy, ob.ux) + Math.PI / 2;
  const at = new Pt(ob.cx, ob.cy);
  const split = splitSurfaceByLine(s, at, ang);
  if (!split) {
    out.push(s);
    return;
  }
  /**
   * 切开后两侧**可能各有好几块**（L 形、带洞的地块被一条线切开就是这种）。
   * 早先只取两侧各自"面积最大的那一块"继续递归，其余碎块直接蒸发 ——
   * 面积对账因此少了 3%~8%（F03 上 1407 m² 凭空消失）。
   * 现在两侧的所有块都进递归，小块会自然落到 targetMin 以下而停止细分。
   */
  const parts = [...split.a, ...split.b].filter((x) => x && x.outer.length >= 3);
  if (parts.length === 0) {
    out.push(s);
    return;
  }
  if (parts.length === 1) {
    out.push(parts[0]);
    return;
  }
  const total2 = parts.reduce((x, q) => x + M2(surfaceArea(q)), 0);
  if (M2(surfaceArea(parts[0])) < opts.targetMinM2 && total2 < opts.targetMaxM2) {
    out.push(s);
    return;
  }
  for (const q of parts) splitRecursive(q, depth + 1, opts, out);
}

function metrics(s: PlanSurface): { minorM: number; aspect: number; shapeQ: number; perimeterM: number } {
  const ob = obbOf(s.outer);
  let per = 0;
  for (let i = 0; i < s.outer.length; i++) per += Pt.distance(s.outer[i], s.outer[(i + 1) % s.outer.length]);
  const area = surfaceArea(s);
  return {
    minorM: ob ? +(ob.d * 7).toFixed(1) : 0,
    aspect: ob && ob.d > 1e-9 ? +(ob.w / ob.d).toFixed(2) : 99,
    shapeQ: per > 1e-9 ? +((4 * Math.PI * area) / (per * per)).toFixed(3) : 0,
    perimeterM: +(per * 7).toFixed(1),
  };
}

/**
 * 临街长度：环上每条边取中点，若中点落在某条道路中心线的
 * (半宽 + 2 m) 内，就把这条边的长度算作临街。
 *
 * 不用 `sharedBoundaryWith` 逐对布尔：Compound × Road 的组合太多（几十×几十），
 * 采样法在这里既便宜又不会因为 1e-9 的偏差判错。
 */
export function frontageOf(ring: Pt[], rails: RoadRail[]): { lengthM: number } {
  let len = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const L = Pt.distance(a, b);
    if (L < 1e-9) continue;
    const mid = new Pt((a.x + b.x) / 2, (a.y + b.y) / 2);
    let hit = false;
    for (const r of rails) {
      const tol = (r.halfM + 2) / 7;
      for (let k = 0; k + 1 < r.pts.length && !hit; k++) {
        const p = r.pts[k];
        const q = r.pts[k + 1];
        const dx = q.x - p.x;
        const dy = q.y - p.y;
        const l2 = dx * dx + dy * dy;
        if (l2 < 1e-12) continue;
        let t = ((mid.x - p.x) * dx + (mid.y - p.y) * dy) / l2;
        t = Math.max(0, Math.min(1, t));
        if (Math.hypot(mid.x - (p.x + dx * t), mid.y - (p.y + dy * t)) <= tol) hit = true;
      }
      if (hit) break;
    }
    if (hit) len += L;
  }
  return { lengthM: len * 7 };
}
