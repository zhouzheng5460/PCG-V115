// F2.4-E 试验 · Voronoi 有机路网
//
// 来源：视频里的 Houdini 做法（Voronoi fracture → 单元边界当路网 → inset 出地块）。
// 这里用**纯布尔**实现同一件事，不引入新依赖：
//
//   ① 在红线内撒站点（带最小间距的拒绝采样）
//   ② 每个站点 = 一块 cell：从整块红线开始，依次用**它到其它站点的中垂线**裁剪
//      （中垂线一侧的半平面用一个大矩形表示，交给现有的 surfaceIntersect）
//   ③ Lloyd 松弛 2 次：把站点挪到 cell 形心，cell 大小趋于均匀（Houdini 里是
//      relax/iterate，效果一样）
//   ④ 每块 cell 内缩 (路宽/2 + 人行道) 得到地块；剩下的就是路网
//      —— 这正是视频里"严丝合缝"那一步：路不是画出来的，是地块让出来的
//
// 与现有 S0/S1/S1p 的关系：它是另一种**骨架来源**（有机路网 vs 单脊），
// 输出同样的 parcels / roadGround，后续的功能分配、建筑、停车、地面、场景 IR 全部可复用。

import { Pt } from '../../../core/geom';
import {
  bboxOf,
  insideSurface,
  surface,
  surfaceArea,
  surfaceIntersect,
  surfaceInset,
  surfaceSubtract,
  surfaceUnion,
  type PlanSurface,
} from '../core/surface';
import { makeRng } from '../subdivision/geom';
import { bufferPolyline } from '../../../core/polyline';

export interface VoronoiOpts {
  seed: number;
  /** 期望的 cell 数量（实际会因裁剪略有出入） */
  count?: number;
  /** 站点最小间距（米） */
  minDistM?: number;
  /** 路幅总宽（米）：两块地各让一半，中间就是这条路 */
  roadM?: number;
  /** 人行道/退线（米） */
  sidewalkM?: number;
  /** Lloyd 松弛次数 */
  relax?: number;
  /** 小于这个面积（m²）的 cell 丢弃 */
  minCellM2?: number;
}

export interface VoronoiResult {
  sites: Pt[];
  /** 原始 cell（拼起来 = 红线） */
  cells: PlanSurface[];
  /** 内缩后的地块 */
  parcels: PlanSurface[];
  /** 路网 = 红线 − 地块（含洞） */
  roads: PlanSurface[];
  /** 单块 cell 的"想用"半径（米），用于报告 */
  cellRadiusM: number;
}

const M2 = (u2: number) => u2 * 49;
const BIG = 1e4; // 半平面用的超大矩形半边长（世界单位）

/**
 * 生成 Voronoi 街区。
 *
 * `count` 不是硬指标：站点撒在红线内之后，边缘处的 cell 会被裁得很小，
 * 所以实际 cell 数通常略少于 count。这也符合直觉 —— 边界附近的地块本来就更碎。
 */
export function voronoiBlock(boundary: PlanSurface, opts: VoronoiOpts): VoronoiResult {
  const count = opts.count ?? 36;
  const minDist = (opts.minDistM ?? 26) / 7;
  const roadHalf = (opts.roadM ?? 9) / 2 / 7;
  const sidewalk = (opts.sidewalkM ?? 3) / 7;
  const relax = opts.relax ?? 2;
  const minCellM2 = opts.minCellM2 ?? 220;
  const rng = makeRng(opts.seed, 'voronoi');

  const bb = bboxOf(boundary.outer);
  const spanX = bb.maxX - bb.minX;
  const spanY = bb.maxY - bb.minY;
  const areaU2 = surfaceArea(boundary);

  // ① 站点：拒绝采样（最小间距），不够就放宽间距再撒 —— 保证数量不失控
  let sites: Pt[] = [];
  for (let attempt = 0; attempt < 4 && sites.length < count; attempt++) {
    const md = minDist * Math.pow(0.75, attempt);
    const tries = count * 60;
    for (let i = 0; i < tries && sites.length < count; i++) {
      const p = new Pt(bb.minX + rng() * spanX, bb.minY + rng() * spanY);
      if (!insideSurface(p, boundary)) continue;
      if (sites.some((q) => Pt.distance(q, p) < md)) continue;
      sites.push(p);
    }
  }
  if (sites.length === 0) {
    return { sites: [], cells: [], parcels: [], roads: [], cellRadiusM: 0 };
  }

  // ② 用中垂线半平面裁剪：每个站点从整块红线开始，被其它站点的中垂线依次切掉
  const computeCells = (pts: Pt[]): PlanSurface[] => {
    const out: PlanSurface[] = [];
    // cell 的"想用半径"上界：离站点最远的红线角点距离
    let maxR = 0;
    for (const c of [boundary.outer[0], boundary.outer[1], boundary.outer[2], boundary.outer[3]].filter(Boolean)) {
      for (const q of pts) maxR = Math.max(maxR, Pt.distance(q, c));
    }
    for (let i = 0; i < pts.length; i++) {
      let cell: PlanSurface[] = [boundary];
      const si = pts[i];
      for (let j = 0; j < pts.length; j++) {
        if (i === j) continue;
        const sj = pts[j];
        const d = Pt.distance(si, sj);
        // 距离超过两倍上界的中垂线不可能切到这枚 cell，跳过（O(n²) 的主要剪枝）
        if (d > maxR * 2) continue;
        const nx = (sj.x - si.x) / (d || 1);
        const ny = (sj.y - si.y) / (d || 1);
        const mx = (si.x + sj.x) / 2;
        const my = (si.y + sj.y) / 2;
        // 靠近 si 的一侧：dot(p - m, n) < 0。用一个巨大矩形表示该半平面
        const tx = -ny;
        const ty = nx;
        const half = surface([
          new Pt(mx + tx * BIG, my + ty * BIG),
          new Pt(mx + tx * BIG - nx * BIG, my + ty * BIG - ny * BIG),
          new Pt(mx - tx * BIG - nx * BIG, my - ty * BIG - ny * BIG),
          new Pt(mx - tx * BIG, my - ty * BIG),
        ]);
        const next: PlanSurface[] = [];
        for (const c of cell) {
          try {
            next.push(...surfaceIntersect([c], [half]).filter((q) => surfaceArea(q) > 1e-7));
          } catch {
            next.push(c); // 单次失败保留原样，不让整枚 cell 消失
          }
        }
        cell = next;
        if (cell.length === 0) break;
      }
      for (const c of cell) {
        if (M2(surfaceArea(c)) >= minCellM2) out.push(c);
      }
    }
    return out;
  };

  let cells = computeCells(sites);

  // ③ Lloyd 松弛：站点挪到 cell 形心，cell 尺寸趋于均匀
  for (let r = 0; r < relax; r++) {
    const next: Pt[] = [];
    for (const c of cells) {
      let x = 0;
      let y = 0;
      let n = 0;
      for (const q of c.outer) {
        x += q.x;
        y += q.y;
        n++;
      }
      if (n >= 3) next.push(new Pt(x / n, y / n));
    }
    if (next.length < 3) break;
    sites = next;
    cells = computeCells(sites);
  }

  // ④ 只在 **cell 之间** 开槽，外圈不动
  //
  // 第一版是"每块 cell 整体内缩"，结果路占了 44%：因为外圈也被退让了 8 m，
  // 而外圈本来就是城市道路，不存在再退一次的道理。真实做法（视频里也是这么做的）
  // 是——路只出现在**共享边**上：把共享边按路宽缓冲、从两侧 cell 里各挖掉一半。
  //
  // 判共享边：沿边的外法线挪 0.6 m，如果落进了**另一块 cell**，这条边就是共享边。
  const internalEdges: { a: Pt; b: Pt }[] = [];
  for (let i = 0; i < cells.length; i++) {
    const ring = cells[i].outer;
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k];
      const b = ring[(k + 1) % ring.length];
      const L = Pt.distance(a, b);
      if (L < 1e-6) continue;
      // CCW 环的右手法线指向外侧
      const nx = (b.y - a.y) / L;
      const ny = -(b.x - a.x) / L;
      const mid = new Pt((a.x + b.x) / 2 + nx * 0.6, (a.y + b.y) / 2 + ny * 0.6);
      let shared = false;
      for (let j = 0; j < cells.length && !shared; j++) {
        if (j === i) continue;
        if (insideSurface(mid, cells[j])) shared = true;
      }
      if (shared) internalEdges.push({ a, b });
    }
  }

  /** 把一组边按半宽缓冲并合并成一整片 */
  const ribbon = (edges: { a: Pt; b: Pt }[], half: number): PlanSurface[] => {
    const parts: PlanSurface[] = [];
    for (const e of edges) {
      const ring = bufferPolyline([e.a, e.b], half);
      if (ring) parts.push(surface(ring));
    }
    return unionAll(parts);
  };

  const roadRibbons = ribbon(internalEdges, roadHalf);
  const carveRibbons = ribbon(internalEdges, roadHalf + sidewalk);

  const parcels: PlanSurface[] = [];
  for (const cell of cells) {
    let rest: PlanSurface[] = [cell];
    try {
      rest = surfaceSubtract([cell], carveRibbons).filter((q) => M2(surfaceArea(q)) >= 120);
    } catch {
      rest = [cell];
    }
    if (rest.length === 0) continue;
    rest.sort((a, b) => surfaceArea(b) - surfaceArea(a));
    parcels.push(rest[0]);
  }
  // 路面必须裁到红线内（含洞）：共享边的缓冲条会在洞口探出几个尖角，
  // 不裁的话图上就是"路穿进中庭"（实测 G07 有两处）。
  let roads: PlanSurface[] = [];
  try {
    roads = surfaceIntersect(roadRibbons, [boundary]).filter((q) => M2(surfaceArea(q)) > 1);
  } catch {
    roads = roadRibbons.filter((q) => M2(surfaceArea(q)) > 1);
  }

  const cellRadiusM = Math.sqrt(areaU2 / Math.max(1, cells.length)) * 7;
  return { sites, cells, parcels, roads, cellRadiusM };
}

function unionAll(ss: PlanSurface[]): PlanSurface[] {
  if (ss.length <= 1) return ss;
  try {
    const u = surfaceUnion(ss);
    return u.length > 0 ? u : ss;
  } catch {
    return ss;
  }
}
