// 现代城市路网：层级化街网切块。
//
// 参考 ProbableTrain/MapGenerator 的三个关键结论：
//   1. 路网必须有层级（highway / arterial / street / alley），而不是一张同质的图；
//   2. 街区是接近矩形的 cell，建筑沿街立面对齐 —— 这是"现代城市"最直观的形态特征；
//   3. 路网朝向可以由一个"张量场"给出，而不是只有全局正交一种。
//
// 这里实现三种场（layout）：
//   grid   —— 全局正交街网 + 低频弯曲。北美棋盘城（曼哈顿、芝加哥）。
//   field  —— 旋涡张量场：扭转角在中心最强、向外衰减，街道连续弯曲。巴塞罗那扩展区
//             之外那种"街道被地形/水系带弯"的形态，也是 MapGenerator 的 smooth 场。
//   radial —— 放射环：同心环线 + 放射状辐条，环半径带谐波起伏，可叠螺旋偏转。
//             华盛顿、堪培拉、巴黎外侧那种形态。
//
// 三种布局只改"怎么切出地块"，切完都是 `Patch[]` + 边长等级表，
// 下游的内缩、路网横断面、地块内容、Scene、GLB 完全复用 —— 地块边依然就是道路中线。
//
// 与原项目空间链的关系：
//   原版是 Voronoi 分地块 → 拓扑寻路 → 地块内缩；
//   这里把第一步换成街网切块，"地块边 = 道路中线"这条约定保持不变，
//   下游的内缩、路网横断面、地块内容完全复用同一套代码。

import { Pt } from '../core/geom';
import { Polygon } from '../core/polygon';
import { Rng } from '../core/rng';
import { type EdgeClass, edgeKey, lineClassOf } from './edgeclass';
import { makeFootprint } from './footprint';
import { buildTensorLayout } from './field/layout';
import type { FieldSource } from './field/tensor';
import { Patch } from './patch';
import { area, ccw, fixTJunctions, intersect, pointInPolygon, weldVertices } from './zones';

export type { EdgeClass };
export { edgeKey };

/** 街网形态 */
export type LayoutKind = 'grid' | 'field' | 'radial' | 'tensor';

export interface GridOptions {
  /** 目标地块数（实际值受形状与裁剪影响） */
  cells: number;
  /** 城市半径 */
  radius: number;
  /** 街区尺度的连续系数（默认 1）。见 S 的算法 */
  spacingMul?: number;
  /**
   * 每边格数下限（默认 3）。
   *
   * 街区尺度 `S = R / n`，而 `n = round(√(cells/π))` 会被这个下限夹住 ——
   * 只要 cells 落在 28~44，n 恒为 3，`spacingK` 就完全失效。
   * 放到 2 才能让"放大街区"这个参数真正起作用（用于尺度对照）。
   */
  minN?: number;
  /** 变形幅度：0 = 规整，1 = 明显弯曲/螺旋 */
  warp?: number;
  /** 每隔几条线出一条主干道 */
  arterialEvery?: number;
  /** 街网形态，默认方格网 */
  layout?: LayoutKind;
  /** 禁建区轮廓：tensor 布局下当作方向场源（path） */
  zones?: Pt[][];
  /** tensor 布局：禁建区避障（开 = 路网绕开禁区；关 = 旧的对齐做法） */
  zoneAvoid?: boolean;
  /** tensor 布局：避障让距（世界单位） */
  zoneAvoidPad?: number;
  /** tensor 布局：禁区弧线绕障（实验，默认关；关 = 路到禁区跟前直着让开） */
  zoneAvoidBend?: boolean;
  /** tensor 布局：每族最多追多少条流线 */
  maxLines?: number;
  /** tensor 布局：外部追加的方向场源 */
  sources?: FieldSource[];
}

export interface GridLayout {
  patches: Patch[];
  edgeClass: Map<string, EdgeClass>;
  radius: number;
  /** 离原点最近的地块，用作中心广场 */
  core: Patch | null;
  /**
   * 整城的主朝向（单位向量，张量场布局才有）。
   *
   * 下游"地块内部的张量场"要用它打底：内部路的走向必须跟城外街网同一套方向，
   * 否则一个封闭区域里会长出一张歪着 30° 的独立路网，接缝处全是尖角。
   * grid / radial 两种布局没有"单一朝向"这个概念（放射环每个位置都不一样），
   * 留空，由调用方退回用地块自身的长边定方向。
   */
  axis?: Pt;
}

// ---------------------------------------------------------------- 内部结构

interface Ctx {
  cells: number;
  R: number;
  /** 街区特征尺度 */
  S: number;
  kArt: number;
  layout: LayoutKind;
  footprint: Pt[];
  minArea: number;
}

interface RawCell {
  /** 地块外环（已 ccw） */
  ring: Pt[];
  /** 四条边的折线，用于"这条边属于哪一级道路"的就近归类 */
  sides: Pt[][];
  cls: EdgeClass[];
}

function distToSeg(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L = dx * dx + dy * dy;
  if (L < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / L;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

function distToPolyline(p: Pt, line: Pt[]): number {
  let best = Infinity;
  for (let k = 0; k + 1 < line.length; k++) {
    const d = distToSeg(p, line[k], line[k + 1]);
    if (d < best) best = d;
  }
  return best;
}

/** 城市轮廓在 footprint.ts（方格网与放射环共用） */

// ---------------------------------------------------------------- 方格网 / 场线

function cartesianCells(ctx: Ctx, warp: number): RawCell[] {
  const { S, R, kArt, cells } = ctx;
  const field = ctx.layout === 'field';

  // 每边格数：圆内格子数 ≈ π·n²，所以 n = √(cells/π)
  const n = Math.max(3, Math.round(Math.sqrt(cells / Math.PI)));
  const m = n + 2;

  // ---- 路网朝向：0~90°，随机一次就固定，整城共用
  const ang = Rng.float() * Math.PI * 0.5;
  const ax = new Pt(Math.cos(ang), Math.sin(ang));
  const ay = new Pt(-Math.sin(ang), Math.cos(ang));

  // ---- 变形场
  // field：旋涡（twist 在原点最强，按 exp(-r²/2σ²) 衰减到外围），
  //        是整体映射而非逐条积分 —— 街道连续弯曲，但格点对应关系不变，街区严丝合缝。
  // grid ：低频正弦位移，让街网不至于像 CAD 图。位移量控制在 0.10 个街区尺度内，
  //        再大路口就开始歪得不合理。
  const sigma = R * 0.75;
  const twist = field ? 0.55 + 0.3 * warp : 0;
  const bend = field ? 0 : S * 0.10 * warp;
  const f1 = (Math.PI * 2) / (S * 8);
  const f2 = (Math.PI * 2) / (S * 13);
  const p1 = Rng.float() * 6.283;
  const p2 = Rng.float() * 6.283;
  const p3 = Rng.float() * 6.283;
  const p4 = Rng.float() * 6.283;

  const project = (lx: number, ly: number): Pt => {
    let x = ax.x * lx + ay.x * ly;
    let y = ax.y * lx + ay.y * ly;
    if (twist !== 0) {
      const r = Math.hypot(x, y);
      if (r > 1e-6) {
        const a = Math.atan2(y, x) + twist * Math.exp(-(r * r) / (2 * sigma * sigma));
        x = Math.cos(a) * r;
        y = Math.sin(a) * r;
      }
    } else if (bend !== 0) {
      x += Math.sin(y * f1 + p1) * Math.cos(x * f2 + p2) * bend;
      y += Math.cos(x * f1 + p3) * Math.sin(y * f2 + p4) * bend;
    }
    return new Pt(x, y);
  };

  // ---- 每条线的位置：间距轻微起伏，避免整齐到假
  const linePos = (phase: number, count: number): number[] => {
    const out: number[] = [0];
    let acc = 0;
    for (let k = 1; k <= count; k++) {
      acc += S * (1 + 0.09 * Math.sin(k * 2.1 + phase));
      out.push(acc);
    }
    return out;
  };
  const xsRaw = linePos(Rng.float() * 6.283, m);
  const ysRaw = linePos(Rng.float() * 6.283, m);
  const posOf = (i: number, arr: number[]): number => {
    const k = Math.min(Math.abs(i), arr.length - 1);
    return i >= 0 ? arr[k] : -arr[k];
  };
  const xs = (i: number) => posOf(i, xsRaw);
  const ys = (j: number) => posOf(j, ysRaw);

  // ---- 格边的折线。旋涡场下一条格边要被弯成曲线，沿局部坐标采样几个点再映射，
  // 相邻两格必须拿到同一份数组（对象身份相同），否则焊接会把本该共享的边拆成两条。
  const STEPS = field ? 3 : 1;
  const segCache = new Map<string, Pt[]>();
  const segH = (i: number, j: number): Pt[] => {
    const key = `H${i},${j}`;
    const hit = segCache.get(key);
    if (hit) return hit;
    const x0 = xs(i);
    const x1 = xs(i + 1);
    const y = ys(j);
    const out: Pt[] = [];
    for (let s = 0; s <= STEPS; s++) out.push(project(x0 + (x1 - x0) * (s / STEPS), y));
    segCache.set(key, out);
    return out;
  };
  const segV = (i: number, j: number): Pt[] => {
    const key = `V${i},${j}`;
    const hit = segCache.get(key);
    if (hit) return hit;
    const x = xs(i);
    const y0 = ys(j);
    const y1 = ys(j + 1);
    const out: Pt[] = [];
    for (let s = 0; s <= STEPS; s++) out.push(project(x, y0 + (y1 - y0) * (s / STEPS)));
    segCache.set(key, out);
    return out;
  };

  const out: RawCell[] = [];
  for (let i = -m; i < m; i++) {
    for (let j = -m; j < m; j++) {
      const bottom = segH(i, j); // 左 → 右
      const right = segV(i + 1, j); // 下 → 上
      const top = segH(i, j + 1).slice().reverse(); // 右 → 左
      const left = segV(i, j).slice().reverse(); // 上 → 下

      // 粗筛：整格离城市太远直接跳过
      const cx = (bottom[0].x + right[0].x + top[0].x + left[0].x) / 4;
      const cy = (bottom[0].y + right[0].y + top[0].y + left[0].y) / 4;
      if (Math.hypot(cx, cy) > R * 1.35) continue;

      out.push({
        ring: bottom.concat(right.slice(1), top.slice(1), left.slice(1, -1)),
        sides: [bottom, right, top, left],
        cls: [lineClassOf(j, kArt), lineClassOf(i + 1, kArt), lineClassOf(j + 1, kArt), lineClassOf(i, kArt)],
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- 放射环

function radialCells(ctx: Ctx, warp: number): RawCell[] {
  const { S, R, kArt } = ctx;
  // 中心圆盘给到 1.5 个街区尺度：再小的话最内几圈会退化成细楔形（弧长只有街区尺度的一半）。
  const rIn = S * 1.5;
  const rows = Math.max(2, Math.round((R - rIn) / S));
  // 列数按"内圈偏外一点"的半径定：内圈不至于碎成楔形，外圈也不至于宽成 4:1。
  let cols = Math.round((Math.PI * 2 * (rIn + (R - rIn) * 0.4)) / S);
  cols = Math.max(8, Math.min(28, cols));
  if (cols % 2) cols += 1;

  // 螺旋：越往外角度偏得越多，街道呈螺旋甩出（warp=0 时是干净的正交放射环）
  const spiral = 0.5 * warp;
  const f1 = Rng.float() * 6.283;
  const f2 = Rng.float() * 6.283;
  const a0 = Rng.float() * 6.283;

  // 半径带谐波起伏：环线不是正圆
  const ringR = (k: number): number => rIn + ((R - rIn) * k) / rows;
  const rAt = (k: number, t: number): number =>
    ringR(k) * (1 + 0.045 * Math.sin(3 * t + f1) + 0.028 * Math.sin(5 * t + f2));

  const ARC = 4; // 每格弧分几段，保证弧线是弯的
  const arcCache = new Map<string, Pt[]>();
  const arc = (k: number, j: number): Pt[] => {
    const key = `A${k},${j}`;
    const hit = arcCache.get(key);
    if (hit) return hit;
    const out: Pt[] = [];
    for (let s = 0; s <= ARC; s++) {
      const t = ((j + s / ARC) / cols) * Math.PI * 2;
      // 最内圈不偏转（log(1) = 0），保证中心圆盘和一环的内弧严丝合缝
      const ang = t + spiral * Math.log(Math.max(ringR(k) / rIn, 1e-3)) + a0;
      const r = rAt(k, t);
      out.push(new Pt(Math.cos(ang) * r, Math.sin(ang) * r));
    }
    arcCache.set(key, out);
    return out;
  };
  const spokeCache = new Map<string, Pt[]>();
  const spoke = (k: number, j: number): Pt[] => {
    const key = `S${k},${j}`;
    const hit = spokeCache.get(key);
    if (hit) return hit;
    const a = arc(k, j)[0];
    const b = arc(k + 1, j)[0];
    const out: Pt[] = [a];
    // 螺旋场下辐条不是直线，插一个中点让它跟着弯
    const mid = new Pt((a.x + b.x) / 2, (a.y + b.y) / 2);
    if (spiral !== 0) {
      out.push(mid);
    }
    out.push(b);
    spokeCache.set(key, out);
    return out;
  };

  // 辐条和平行格线用同一套 6/3/1 配比，否则放射布局下主干道又会多得离谱
  const spokeClass = (j: number): EdgeClass => lineClassOf(j, kArt);

  const out: RawCell[] = [];

  // ---- 中心区：整块圆盘，下游会当成中心广场
  const coreRing: Pt[] = [];
  const coreSides: Pt[][] = [];
  for (let j = 0; j < cols; j++) {
    const a = arc(0, j);
    coreSides.push(a);
    coreRing.push(...(j === 0 ? a : a.slice(1)));
  }
  out.push({ ring: coreRing, sides: coreSides, cls: coreSides.map(() => lineClassOf(0, kArt)) });

  // ---- 一圈圈的环带
  for (let k = 0; k < rows; k++) {
    for (let j = 0; j < cols; j++) {
      const inner = arc(k, j); // 内弧，顺
      const right = spoke(k, j + 1); // 右辐条，由内向外
      const outer = arc(k + 1, j).slice().reverse(); // 外弧，逆
      const left = spoke(k, j).slice().reverse(); // 左辐条，由外向内
      out.push({
        ring: inner.concat(right.slice(1), outer.slice(1), left.slice(1, -1)),
        sides: [inner, right, outer, left],
        cls: [lineClassOf(k, kArt), spokeClass(j + 1), lineClassOf(k + 1, kArt), spokeClass(j)],
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- 主入口

export function buildGridLayout(opts: GridOptions): GridLayout {
  const cells = Math.max(9, Math.round(opts.cells));
  const R = Math.max(20, opts.radius);
  const warp = opts.warp ?? 0.6;
  // 10 = 6/3/1 的断面配比循环（见 edgeclass.lineClassOf）
  const kArt = Math.max(4, Math.round(opts.arterialEvery ?? 10));
  const layout = opts.layout ?? 'grid';

  // 街区特征尺度：圆内街区数 ≈ π·n²，所以 S = R / √(cells/π)
  const n = Math.max(opts.minN ?? 3, Math.round(Math.sqrt(cells / Math.PI)));
  // 街区尺度。`spacingMul` 是给 spacingK 用的**连续**微调：
  // n 是整数，cells 落在同一档（28~44）时 S 完全不动，spacingK 就变成死参数。
  // 乘一个以默认档为锚的系数（k / 1.5），默认值下乘 1、城市与之前逐块一致。
  const S = (R / n) * (opts.spacingMul ?? 1);

  // 张量场是另一条链（场 → 流线 → 平面图 → 面），先委托出去，下面只管格网类布局
  if (layout === 'tensor') {
    return buildTensorLayout({
      radius: R,
      spacing: S,
      arterialEvery: kArt,
      warp,
      zones: opts.zones,
      zoneAvoid: opts.zoneAvoid,
      zoneAvoidPad: opts.zoneAvoidPad,
      zoneAvoidBend: opts.zoneAvoidBend,
      maxLines: opts.maxLines,
      sources: opts.sources,
    });
  }

  const ctx: Ctx = {
    cells,
    R,
    S,
    kArt,
    layout,
    footprint: makeFootprint(R),
    minArea: S * S * 0.16,
  };

  const raw = layout === 'radial' ? radialCells(ctx, warp) : cartesianCells(ctx, warp);
  const footprint = ctx.footprint;

  // ---- 裁剪：整块在轮廓内直接留用；跨界用布尔裁一刀
  interface Kept {
    poly: Polygon;
    sides: Pt[][];
    cls: EdgeClass[];
    dist: number;
  }
  const kept: Kept[] = [];

  for (const c of raw) {
    if (c.ring.length < 4) continue;
    const inside = c.ring.every((p) => pointInPolygon(p, footprint));
    let ring: Pt[];
    if (inside) {
      ring = c.ring;
    } else {
      let parts: Pt[][] = [];
      try {
        parts = intersect(c.ring, footprint, 0.18);
      } catch {
        parts = [];
      }
      if (parts.length === 0) continue;
      ring = parts.reduce((a, b) => (area(a) > area(b) ? a : b));
    }
    if (ring.length < 3 || area(ring) < ctx.minArea) continue;

    let sx = 0;
    let sy = 0;
    for (const p of ring) {
      sx += p.x;
      sy += p.y;
    }
    kept.push({
      poly: new Polygon(ccw(ring)),
      sides: c.sides,
      cls: c.cls,
      dist: Math.hypot(sx / ring.length, sy / ring.length),
    });
  }

  if (kept.length === 0) return { patches: [], edgeClass: new Map(), radius: R, core: null };

  // ---- 焊接：轮廓边上相邻两格各自裁出来的交点坐标相同但不是同一个对象，
  // 不焊起来路网会因为"两侧不是同一条边"而断掉（buildRoadNet 按对象身份配对）。
  const polys = kept.map((c) => c.poly);
  const verts = weldVertices(polys, 1e-3);
  // 轮廓边上的交点可能落在邻格的边内部（T 型连接），不插点的话
  // buildRoadNet 会因为"两侧不是同一条边"而把这段路丢掉，路网出现断头。
  fixTJunctions(polys, verts, 1e-3);

  // ---- 边分类：轮廓边找不到对应格线，就近归到四条边折线之一；
  // 这类边是城市外边界，本来就不修路，分类不影响画面。
  const edgeClass = new Map<string, EdgeClass>();
  for (const c of kept) {
    const ring = Array.from(c.poly);
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k];
      const b = ring[(k + 1) % ring.length];
      if (a === b) continue;
      const mid = new Pt((a.x + b.x) / 2, (a.y + b.y) / 2);
      let best = 0;
      let bd = Infinity;
      for (let e = 0; e < c.sides.length; e++) {
        const d = distToPolyline(mid, c.sides[e]);
        if (d < bd) {
          bd = d;
          best = e;
        }
      }
      edgeClass.set(edgeKey(a, b), c.cls[best] ?? 'local');
    }
  }

  // ---- 组成地块
  const patches: Patch[] = [];
  let core: Patch | null = null;
  let coreDist = Infinity;

  for (const c of kept) {
    const patch = new Patch([]);
    patch.shape = c.poly;
    patches.push(patch);
    // 城内：留一圈城郊（绿地/工业），否则城市会一直铺到轮廓边
    patch.withinCity = c.dist < R * 0.9;
    if (patch.withinCity && c.dist < coreDist) {
      coreDist = c.dist;
      core = patch;
    }
  }

  return { patches, edgeClass, radius: R, core };
}
