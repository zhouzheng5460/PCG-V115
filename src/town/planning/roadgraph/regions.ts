// F2.5-C · 区域合并 → 街区（F2.5-C.1 改造：带连通约束的合并）
//
// **顺序是这一层的核心**：先把 cell 合并成街区，消失的那条边才不是路；留下来的边才铺路。
//
// 为什么不先选路再挖：Voronoi 是一张完整的划分，随便挑几条边当路，剩下的 cell
// 就会被啃出缺口 —— 图上看到的是"被路咬过的碎块"，不是"被路围合的街区"。
// 反过来做则天然成立：每一次合并都**删掉一条共享边**，删完还在的边就构成闭合的街区轮廓。
//
// F2.5-C.1 改了什么（这是本轮的重点）：
//   上一轮是"先无条件合并，再看剩下什么"，于是合并会把唯一的连接边删掉，
//   收尾时得到几个互不相连的路段、或者一个绕洞的孤立环路。
//   这一轮每条边在删除**之前**要过四关：
//     ① 是不是连通骨架（protected）—— 是就不删
//     ② 删掉以后会不会多出"接不到外部"的分量（ConnectivityGuard）—— 会就不删
//     ③ 是不是窄到摆不下一条路（< minRoadableSpanM）—— 是就必须删
//     ④ 删掉以后街区会不会变成走廊（长短轴比 / 形状质量）—— 会就不删
//   四关之外才轮到"面积够大就留一条路"这种尺度考虑。

import { Pt } from '../../../core/geom';
import {
  ringArea,
  surfaceArea,
  surfaceIntersect,
  surfaceOffset,
  surfaceSubtract,
  surfaceUnion,
  type PlanSurface,
} from '../core/surface';
import { bufferPolyline } from '../../../core/polyline';
import { obbOf } from '../subdivision/geom';
import { sharedBoundaryWith } from '../subdivision/relations';
import type { Cell, Cut, Fracture } from './fracture';
import type { RoadClass } from './types';
import type { DensityPolicy } from './density';
import type { ConnectivityGuard } from './backbone';

const M2 = (u2: number) => u2 * 49;

export interface Block {
  id: string;
  surface: PlanSurface;
  areaM2: number;
  /** 由哪些 cell 合并而来 */
  cells: string[];
  /** 围合它的边（留下来的 cut id） */
  boundingCuts: string[];
}

export interface BlockNeighbor {
  id: string;
  sharedM: number;
}

export interface Region {
  id: string;
  /** 属于哪个街区（追溯用） */
  blockId: string;
  surface: PlanSurface;
  areaM2: number;
  neighbors: BlockNeighbor[];
  /** 临路边界长度（米） */
  roadFrontageM: number;
  preferredAngle: number;
  shapeQuality: number;
  cells: string[];
}

export interface MergeOpts {
  /** 合并成街区的目标面积区间（m²） */
  targetM2: [number, number];
  /** 短于这个长度（米）的共享边**优先**被合并掉 */
  weakEdgeM?: number;
  /** 长于这个长度（米）的共享边视为主路，不参与合并 */
  strongEdgeM?: number;
  /** 合并后形状质量允许下降多少（>0 更宽松） */
  shapeTol?: number;
  /** 受保护的连通骨架：绝不合并 */
  protectedCuts?: Set<string>;
  /** 密度策略：窄端强合并、走廊/形状下限 */
  policy?: DensityPolicy;
  /** 连通守卫：来自 backbone.makeConnectivityGuard */
  guard?: ConnectivityGuard;
  /** 收尾检查：把"保留但接不到外部"的边交给上层判断（返回需要强制合并的边） */
  inspect?: (kept: Cut[]) => { isolatedCuts: string[] };
  /** 复现上一轮：不做"微偏移重试"的布尔退化处理 */
  strictUnion?: boolean;
  /**
   * 密度策略判定"整片场地不需要内部路"时置 true：所有非保护边一律合并。
   *
   * 否则会出现自相矛盾的输出 —— 骨架说"不用内部路"，合并却因为形状原因
   * 留下一条 20 m 的横路（F02 楔形上实测）。既然判定不需要，就不该留残余。
   */
  mergeAll?: boolean;
}

export interface MergeResult {
  blocks: Block[];
  /** 留下来的边 = 道路 */
  keptCuts: Cut[];
  /** 被合并掉的边 */
  removedCuts: Cut[];
  merges: { cut: string; a: string; b: string; areaM2: number; why: string }[];
  before: number;
  after: number;
  /** 受保护（骨架）边 */
  protectedCuts: Cut[];
  /** 被拒绝的合并及原因（诊断与报告用） */
  rejects: { cut: string; why: string }[];
  /** 因"窄到摆不下路"被强制合并的边 */
  forced: string[];
  /** 为消除不可达分量而追加合并的边 */
  islandRepairs: string[];
  /** cell → block id */
  blockOfCell: Map<string, string>;
  /** block id → 围合它的保留边 */
  frontageOf: Map<string, string[]>;
}

export function mergeCells(f: Fracture, cuts: Cut[], opts: MergeOpts): MergeResult {
  const [minTarget] = opts.targetM2;
  const weakM = opts.weakEdgeM ?? 34;
  const strongM = opts.strongEdgeM ?? 95;
  const shapeTol = opts.shapeTol ?? 0.04;
  const prot = opts.protectedCuts ?? null;
  const pol = opts.policy;
  const guard = opts.guard;
  const maxArea = Math.min(opts.targetM2[1], pol?.blockMaxM2 ?? Infinity);

  let blocks: Block[] = f.cells.map((c) => ({
    id: c.id,
    surface: c.surface,
    areaM2: c.areaM2,
    cells: [c.id],
    boundingCuts: [],
  }));

  const byCell = new Map<string, number>(); // cellId → blocks index
  const indexBlocks = (): void => {
    byCell.clear();
    blocks.forEach((b, i) => b.cells.forEach((cid) => byCell.set(cid, i)));
  };
  indexBlocks();

  const merges: MergeResult['merges'] = [];
  const rejects: MergeResult['rejects'] = [];
  const removed = new Set<string>();
  const forced: string[] = [];
  const islandRepairs: string[] = [];

  /**
   * 保护线：给了骨架就只认骨架；没给（旧调用）就退回"长度前 15% 不许合并"。
   *
   * 不给骨架时必须留这条兜底：否则一个 4 个 cell 的工业地块会全部并成一块，
   * 图上一条路都没有。
   */
  let protect: Set<string>;
  if (prot) protect = prot;
  else {
    const byLen = cuts.slice().sort((a, b) => b.lenM - a.lenM);
    const protectN = Math.max(2, Math.min(6, Math.round(cuts.length * 0.15)));
    protect = new Set(byLen.slice(0, protectN).map((c) => c.id));
  }

  const sig = (cut: Cut): string => {
    const ia = byCell.get(cut.left);
    const ib = byCell.get(cut.right);
    if (ia === undefined || ib === undefined) return 'noblock';
    if (ia === ib) return 'same';
    return 'ok';
  };

  /**
   * 合并一次。返回 true 表示这条边被删掉（两块并了）。
   *
   * `mode`：
   *   normal  —— 四关全过才删
   *   forced  —— 窄端强合并 / 岛屿修复：只看保护 + 连通 + 布尔成功
   */
  const tryMerge = (cut: Cut, mode: 'normal' | 'forced'): boolean => {
    const ia = byCell.get(cut.left);
    const ib = byCell.get(cut.right);
    if (ia === undefined || ib === undefined) {
      rejects.push({ cut: cut.id, why: '一侧 cell 不在任何街区里（破碎阶段已丢弃）' });
      return false;
    }
    if (ia === ib) {
      // 两块已经并成一块 —— 这条边事实上已经消失（不能留着骗连通守卫）
      removed.add(cut.id);
      guard?.noteRemoved(cut.id);
      return true;
    }
    if (protect.has(cut.id)) {
      rejects.push({ cut: cut.id, why: '受保护（连通骨架 / 保护线）' });
      return false;
    }
    const A = blocks[ia];
    const B = blocks[ib];

    // 两块之间若隔着一条受保护的主路，绝不能并 —— 并了那条路就成了"穿过街区的路"
    const sepByProtected = cuts.some(
      (k) => protect.has(k.id) && ((A.cells.includes(k.left) && B.cells.includes(k.right)) || (B.cells.includes(k.left) && A.cells.includes(k.right)))
    );
    if (sepByProtected) {
      rejects.push({ cut: cut.id, why: '两块之间隔着受保护的主路' });
      return false;
    }

    const sum = A.areaM2 + B.areaM2;
    if (mode === 'normal' && sum > maxArea) {
      rejects.push({ cut: cut.id, why: `合并后 ${sum.toFixed(0)} m² 超过街区上限 ${maxArea.toFixed(0)} m²` });
      return false;
    }

    if (guard) {
      const v = guard.canRemove(cut.id);
      if (!v.ok) {
        rejects.push({ cut: cut.id, why: v.why });
        return false;
      }
    }

    const u = tryUnion(A.surface, B.surface, opts.strictUnion);
    if (!u) {
      rejects.push({ cut: cut.id, why: '布尔并集失败（两侧不共边）' });
      return false;
    }

    const weak = cut.lenM <= weakM;
    const qA = quality(A.surface);
    const qB = quality(B.surface);

    if (mode === 'forced' && pol && !opts.mergeAll) {
      // 窄端强合并仍然不接受"把地块拉成一条走廊"：上限放到场地自身长宽比
      const m = metricsOf(u);
      const ceil = Math.max(pol.maxAspect, pol.siteAspect * 1.15);
      if (m.aspect > ceil) {
        rejects.push({ cut: cut.id, why: `窄端强合并会得到长短轴比 ${m.aspect.toFixed(1)} > ${ceil.toFixed(1)} 的走廊` });
        return false;
      }
      // 也不接受"把街区撑爆"：碎段回收不能一路并成一块大饼（上限放宽 15%）
      if (m.areaM2 > pol.blockMaxM2 * 1.15) {
        rejects.push({ cut: cut.id, why: `碎段回收后 ${m.areaM2.toFixed(0)} m² 超过上限 ${(pol.blockMaxM2 * 1.15).toFixed(0)} m²` });
        return false;
      }
    }

    if (mode === 'normal' && !opts.mergeAll) {
      // 两块都够大、又不是弱边 → 这条边留着当路（街区尺度就靠这个）
      if (!weak && sum >= minTarget && Math.min(A.areaM2, B.areaM2) >= minTarget * 0.75) {
        rejects.push({ cut: cut.id, why: '两块都够大，保留为路' });
        return false;
      }
      if (pol) {
        const m = metricsOf(u);
        // 只用**绝对下限**判形状：合并两块紧凑的 cell，4πA/P² 本来就会掉一点，
        // 拿"掉了多少"当门槛会把所有合并都挡住（上一版就是这么退化的）。
        // 真正要防的是走廊与窄条 —— 那用长短轴比和绝对质量下限来判。
        if (m.aspect > pol.maxAspect) {
          rejects.push({ cut: cut.id, why: `合并后长短轴比 ${m.aspect.toFixed(1)} > ${pol.maxAspect}（走廊）` });
          return false;
        }
        if (m.shapeQ < pol.minShapeQ) {
          rejects.push({ cut: cut.id, why: `合并后形状质量 ${m.shapeQ.toFixed(2)} < ${pol.minShapeQ}（碎形）` });
          return false;
        }
        if (m.areaM2 > pol.blockMaxM2) {
          rejects.push({ cut: cut.id, why: `合并后 ${m.areaM2.toFixed(0)} m² 超过 ${pol.blockMaxM2} m²` });
          return false;
        }
      } else {
        const gain = quality(u) - Math.max(qA, qB);
        if (!weak && gain < -shapeTol) {
          rejects.push({ cut: cut.id, why: '合并会把形状拉坏（旧口径）' });
          return false;
        }
      }
    }

    blocks = blocks.filter((_, k) => k !== ia && k !== ib);
    const merged: Block = {
      id: `B${blocks.length}_${A.id}+${B.id}`,
      surface: u,
      areaM2: +M2(surfaceArea(u)).toFixed(0),
      cells: [...A.cells, ...B.cells],
      boundingCuts: [],
    };
    blocks.push(merged);
    indexBlocks();
    removed.add(cut.id);
    guard?.noteRemoved(cut.id);
    const why =
      mode === 'forced'
        ? `跨度仅 ${cut.lenM.toFixed(0)} m（< ${pol?.minRoadableSpanM ?? 0} m），摆不下一条路`
        : weak
          ? `共享边仅 ${cut.lenM.toFixed(0)} m（弱边）`
          : '两块都偏小，合并后更像一个街区';
    merges.push({ cut: cut.id, a: A.id, b: B.id, areaM2: merged.areaM2, why });
    if (mode === 'forced' && pol && cut.lenM < pol.minRoadableSpanM) forced.push(cut.id);
    return true;
  };

  // ---------------- 删除顺序：窄端 → 弱边 → 其余
  const order = cuts.filter((c) => !protect.has(c.id) && c.lenM <= strongM);
  const narrow = pol ? order.filter((c) => c.lenM < pol.minRoadableSpanM) : [];
  const rest = order.filter((c) => !narrow.includes(c));
  const byLen = (a: Cut, b: Cut): number => a.lenM - b.lenM || a.id.localeCompare(b.id);
  narrow.sort(byLen);
  rest.sort(byLen);

  for (const cut of narrow) tryMerge(cut, 'forced');
  for (const cut of rest) tryMerge(cut, 'normal');

  // ---------------- 留下来的边 = 道路
  const computeKept = (): Cut[] =>
    cuts.filter((c) => {
      if (removed.has(c.id)) return false;
      return sig(c) === 'ok';
    });

  let kept = computeKept();

  /**
   * 岛屿修复：仍然有"保留但接不到外部"的分量时，把它的边强制合并掉。
   *
   * 这是最后一道兜底 —— 一条开不进去的路比一块形状略差的街区更糟。
   * 骨架已经在 backbone 里保证过接入了，走到这里说明是形状关挡下的边。
   */
  if (opts.inspect) {
    for (let round = 0; round < 3; round++) {
      const { isolatedCuts } = opts.inspect(kept);
      if (isolatedCuts.length === 0) break;
      let changed = false;
      for (const cid of isolatedCuts) {
        const cut = cuts.find((c) => c.id === cid);
        if (!cut || protect.has(cid)) continue;
        if (tryMerge(cut, 'forced')) {
          islandRepairs.push(cid);
          changed = true;
        }
      }
      kept = computeKept();
      if (!changed) break;
    }
  }

  // 每块街区记下围合它的边（落在该块边界上的边）
  for (const b of blocks) {
    b.boundingCuts = kept
      .filter((c) => insideRingPt(c.a, b.surface) || insideRingPt(c.b, b.surface) || nearRing(c.a, b.surface) || nearRing(c.b, b.surface))
      .map((c) => c.id);
  }

  const blockOfCell = new Map<string, string>();
  for (const b of blocks) for (const cid of b.cells) blockOfCell.set(cid, b.id);
  const frontageOf = new Map<string, string[]>();
  for (const b of blocks) frontageOf.set(b.id, []);
  for (const c of kept) {
    const ba = blockOfCell.get(c.left);
    const bb = blockOfCell.get(c.right);
    if (ba && ba !== bb) frontageOf.get(ba)?.push(c.id);
    if (bb && bb !== ba) frontageOf.get(bb)?.push(c.id);
  }

  return {
    blocks,
    keptCuts: kept,
    removedCuts: cuts.filter((c) => removed.has(c.id)),
    merges,
    before: f.cells.length,
    after: blocks.length,
    protectedCuts: cuts.filter((c) => protect.has(c.id)),
    rejects,
    forced: [...new Set(forced)],
    islandRepairs,
    blockOfCell,
    frontageOf,
  };
}

// ---------------------------------------------------------------- 街区成品

export interface RegionResult {
  regions: Region[];
  /** 路面（并集后的整片，用于面积统计） */
  roads: PlanSurface[];
  /**
   * 逐条路面条带（**未并集**）。
   *
   * 出图要用这一份：并集结果在路口处容易产生自交环，
   * 按 evenodd 填充会翻出大片黑斑（实测第 ④ 层路面被画成一堆黑楔形）。
   * 逐条矩形在路口天然重叠，视觉上就是一个实心路口。
   */
  roadRibbons: PlanSurface[];
  /** 合并前的 cell（第 5 层对照用） */
  preMerge: { id: string; surface: PlanSurface }[];
  blocks: Block[];
  before: number;
  after: number;
}

/**
 * 街区 → 成品区域：挖掉路面、算临街与朝向。
 *
 * 因为路就在街区的边界上，挖的时候只会削掉沿边一圈（半幅路宽），
 * 不会出现"缺口"—— 看到的每块地都是完整闭合的。
 */
export function buildRegions(
  boundary: PlanSurface,
  merge: MergeResult,
  widths: (c: Cut) => number,
  opts: { minPartM2?: number } = {}
): RegionResult {
  const minPartM2 = opts.minPartM2 ?? 60;

  const ribbons: PlanSurface[] = [];
  for (const c of merge.keptCuts) {
    const ring = bufferPolyline([c.a, c.b], widths(c) / 2 / 7);
    if (ring) ribbons.push({ outer: ring, holes: [] });
  }
  let roads: PlanSurface[] = [];
  const roadRibbons: PlanSurface[] = [];
  for (const rb of ribbons) {
    try {
      const c = surfaceIntersect([rb], [boundary]).filter((q) => surfaceArea(q) > 1e-6);
      roadRibbons.push(...c);
    } catch {
      roadRibbons.push(rb);
    }
  }
  try {
    const u = surfaceUnion(ribbons).filter((q) => surfaceArea(q) > 1e-6);
    roads = surfaceIntersect(u, [boundary]).filter((q) => M2(surfaceArea(q)) > 1);
  } catch {
    roads = ribbons;
  }

  const regions: Region[] = [];
  for (const b of merge.blocks) {
    let rest: PlanSurface[] = [b.surface];
    try {
      rest = surfaceSubtract([b.surface], roads).filter((q) => M2(surfaceArea(q)) >= minPartM2);
    } catch {
      rest = [b.surface];
    }
    for (const s of rest) {
      const ob = obbOf(s.outer);
      regions.push({
        id: `${b.id}r${regions.length}`,
        blockId: b.id,
        surface: s,
        areaM2: +M2(surfaceArea(s)).toFixed(0),
        neighbors: [],
        roadFrontageM: 0,
        preferredAngle: ob ? Math.atan2(ob.uy, ob.ux) : 0,
        shapeQuality: +quality(s).toFixed(3),
        cells: b.cells,
      });
    }
  }

  // 邻接（只统计"还贴着"的：被路隔开的公共边界为 0）
  const boxes = regions.map((r) => bboxOfRing(r.surface.outer));
  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      const A = boxes[i];
      const B = boxes[j];
      const pad = 3 / 7;
      if (A.maxX + pad < B.minX || B.maxX + pad < A.minX) continue;
      if (A.maxY + pad < B.minY || B.maxY + pad < A.minY) continue;
      let shared = 0;
      try {
        shared = sharedBoundaryWith(regions[i].surface, regions[j].surface).lengthM;
      } catch {
        shared = 0;
      }
      if (shared > 1) {
        regions[i].neighbors.push({ id: regions[j].id, sharedM: +shared.toFixed(1) });
        regions[j].neighbors.push({ id: regions[i].id, sharedM: +shared.toFixed(1) });
      }
    }
    let front = 0;
    for (const r of roads) {
      try {
        front += sharedBoundaryWith(regions[i].surface, r).lengthM;
      } catch {
        /* 单次失败按 0 */
      }
    }
    regions[i].roadFrontageM = +front.toFixed(1);
  }

  return {
    regions,
    roads,
    roadRibbons,
    preMerge: merge.blocks.map((b) => ({ id: b.id, surface: b.surface })),
    blocks: merge.blocks,
    before: merge.before,
    after: regions.length,
  };
}

// ---------------------------------------------------------------- 小工具

export function quality(s: PlanSurface): number {
  const area = surfaceArea(s);
  let per = 0;
  for (let i = 0; i < s.outer.length; i++) per += Pt.distance(s.outer[i], s.outer[(i + 1) % s.outer.length]);
  if (per < 1e-9) return 0;
  return (4 * Math.PI * area) / (per * per);
}

export interface ShapeMetrics {
  areaM2: number;
  /** 短轴跨度（米） */
  minorM: number;
  /** 长轴跨度（米） */
  majorM: number;
  /** 长短轴比 */
  aspect: number;
  /** 4πA/P² */
  shapeQ: number;
  /** 主轴角（弧度） */
  ang: number;
}

export function metricsOf(s: PlanSurface): ShapeMetrics {
  const ob = obbOf(s.outer);
  const areaM2 = M2(surfaceArea(s));
  return {
    areaM2: +areaM2.toFixed(0),
    minorM: ob ? +(ob.d * 7).toFixed(1) : 0,
    majorM: ob ? +(ob.w * 7).toFixed(1) : 0,
    aspect: ob && ob.d > 1e-6 ? +(ob.w / ob.d).toFixed(2) : 99,
    shapeQ: +quality(s).toFixed(3),
    ang: ob ? Math.atan2(ob.uy, ob.ux) : 0,
  };
}

/**
 * 两块相邻 cell 的并集。
 *
 * 实测：Voronoi 相邻 cell 的共享边在数值上会差 1e-9 级（半平面裁剪的产物），
 * polygon-clipping 因此偶尔"并了个寂寞" —— 返回两个环，面积正好等于两块之和，
 * 图上看不出任何异常，但合并失败，最后多留一条本不该存在的路（R01 上 18 条里有 3 条）。
 *
 * 解法不是放大容差，而是给其中一块**向外扩 5 mm**，让共享边真正重叠：
 * 面积误差 ≤ 1 m²（远小于出图精度），换来合并成功率 100%。
 * 这条退化只在布尔层处理，**不进入**任何几何定义。
 */
/**
 * 去掉布尔运算留下的"针孔"。
 *
 * 微偏移重试会让其中一块比另一块多出 5 mm，两个环在共享边附近可能夹出一条
 * 零宽度的细缝 —— 它被当成洞（hole）带出来，evenodd 填充时会画成一条横穿街区的
 * 细线（I01 上实测）。真空腔（天井/中庭）不可能小于 20 m²，按面积滤掉即可。
 */
function dropPinHoles(s: PlanSurface): PlanSurface {
  if (s.holes.length === 0) return s;
  const holes = s.holes.filter((h) => Math.abs(ringArea(h)) * 49 >= 20);
  return holes.length === s.holes.length ? s : { outer: s.outer, holes };
}

function tryUnion(a: PlanSurface, b: PlanSurface, strict = false): PlanSurface | null {
  try {
    const u = surfaceUnion([a, b]).filter((q) => surfaceArea(q) > 1e-6);
    if (u.length === 1) return dropPinHoles(u[0]);
  } catch {
    /* 落到下面的微偏移重试 */
  }
  if (strict) return null;
  try {
    const off = surfaceOffset(a, 5 / 1000 / 7);
    const u = surfaceUnion([...(off.length ? off : [a]), b]).filter((q) => surfaceArea(q) > 1e-6);
    if (u.length === 1) return dropPinHoles(u[0]);
  } catch {
    /* 放弃合并 */
  }
  return null;
}

function insideRingPt(p: Pt, s: PlanSurface): boolean {
  if (!inRing(p, s.outer)) return false;
  for (const h of s.holes) if (inRing(p, h)) return false;
  return true;
}

function nearRing(p: Pt, s: PlanSurface): boolean {
  const tol = 0.3;
  for (let i = 0; i < s.outer.length; i++) {
    const a = s.outer[i];
    const b = s.outer[(i + 1) % s.outer.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    if (l2 < 1e-12) continue;
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    if (Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)) <= tol) return true;
  }
  return false;
}

function inRing(p: Pt, ring: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y || 1e-12) + a.x) inside = !inside;
  }
  return inside;
}

function bboxOfRing(ring: Pt[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of ring) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

export function widthOfClass(cls: RoadClass): number {
  return cls === 'arterial' ? 14 : cls === 'collector' ? 10 : cls === 'internal' ? 6 : 7.5;
}

export type { Cell };
