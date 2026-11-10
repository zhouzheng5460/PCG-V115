// F3-D · 最大内接直角矩形 + 建筑内退 + 体量实现
//
// 这一段是本阶段最容易被"看起来对"骗过去的地方，所以把判据写死在这里：
//   · 最大内接矩形**不是** OBB 包围盒：OBB 可能在多边形外；
//   · 用栅格 + 直方图求出"完全位于可用多边形内的最大轴对齐矩形"（可旋转），
//     再对四角与边中点做真实几何校验；
//   · 报告里写清栅格精度与"矩形面积 / 地块面积"，不虚称数学最优。
//
// 内退之后得到 BuildingFootprint —— 它同时是建筑体量和外围地面的**共同控制区**，
// 不是"建筑外面的四条路"。

import { Pt } from '../core/geom';
import {
  insetPerEdge,
  surfaceArea,
  type PlanSurface,
} from '../town/planning/core/surface';
import { insideSurface } from '../town/planning/core/surface';
import { distPointToPolyline } from './geom';
import { obbOf } from '../town/planning/subdivision/geom';
import { MAT } from '../scene/palette';
import type { SolidFeature, SolidKind } from '../scene/types';
import { M2, U, areaM2, cleanRing, rectRing } from './geom';
import { DENSITY_PRESETS, type BuildingParcel, type CityDensity, type InscribedRect } from './types';

// ---------------------------------------------------------------- 最大内接矩形

export interface RectSearch {
  rect: InscribedRect | null;
  /** 所有试过的角度（报告里写，便于复现） */
  tried: { angRad: number; areaM2: number }[];
}

/**
 * 在 `surface` 内找最大面积的直角矩形（允许旋转）。
 *
 * 做法（有界、确定性、可复现）：
 *   对每个候选角度 → 把多边形旋到局部坐标系 → 0.45~1.3 m 栅格化成 0/1 矩阵
 *   → 直方图法求"全 1 最大子矩形" → 反算回世界坐标 → 四角/边中点校验。
 *
 * 栅格法的误差是"最多缩掉半格"，所以结果**偏保守**：找到的矩形一定在面内，
 * 但可能比理论最大值小半格。这个取舍写在 `quality` 与 `cellM` 里。
 */
export function maxInscribedRect(surface: PlanSurface, frameRad: number, extraAngles: number[] = []): RectSearch {
  const tried: { angRad: number; areaM2: number }[] = [];
  let best: InscribedRect | null = null;

  /**
   * 快路径：地块本来就是个"沿 frontRad 摆的矩形"时，直接用它，
   * 不开栅格。城市里 80% 以上的地块属于这种（子地块就是沿街向切出来的）。
   *
   * 判据不是"看起来像"：矩形面积占地块面积 ≥ 88%，且四角/边中点真的在面内。
   * 不满足就老老实实走栅格搜索。
   */
  const fast = rectInFrame(surface, frameRad);
  if (fast) return { rect: fast, tried: [{ angRad: +frameRad.toFixed(4), areaM2: fast.areaM2 }] };

  const angles = [frameRad, ...extraAngles];
  for (const ang of angles) {
    const r = searchAtAngle(surface, ang);
    tried.push({ angRad: +ang.toFixed(4), areaM2: r ? +r.areaM2.toFixed(1) : 0 });
    if (r && (!best || r.areaM2 > best.areaM2)) best = r;
  }
  return { rect: best, tried };
}

function searchAtAngle(surface: PlanSurface, ang: number): InscribedRect | null {
  const c = centroid(surface.outer);
  const cs = Math.cos(-ang);
  const sn = Math.sin(-ang);
  const toLocal = (p: Pt): Pt => {
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    return new Pt(dx * cs - dy * sn, dx * sn + dy * cs);
  };

  const local = surface.outer.map(toLocal);
  const holesLocal = surface.holes.map((h) => h.map(toLocal));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of local) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const wU = maxX - minX;
  const hU = maxY - minY;
  if (wU < 1e-3 || hU < 1e-3) return null;

  const cellM = Math.min(1.3, Math.max(0.45, (Math.min(wU, hU) * 7) / 110));
  const cellU = U(cellM);
  const cols = Math.max(2, Math.min(130, Math.round(wU / cellU)));
  const rows = Math.max(2, Math.min(130, Math.round(hU / cellU)));
  const dx = wU / cols;
  const dy = hU / rows;

  const localSurface: PlanSurface = { outer: local, holes: holesLocal };
  const mask: Uint8Array = new Uint8Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const p = new Pt(minX + (i + 0.5) * dx, minY + (j + 0.5) * dy);
      if (insideSurface(p, localSurface)) mask[j * cols + i] = 1;
    }
  }

  const best = largestRect(mask, cols, rows);
  if (!best) return null;

  const x0 = minX + best.x * dx;
  const x1 = minX + (best.x + best.w) * dx;
  const y0 = minY + best.y * dy;
  const y1 = minY + (best.y + best.h) * dy;

  // 半格内缩 + 真实几何校验（四角 + 四条边中点）
  let shrink = 0;
  let world = localRectToWorld(x0, y0, x1, y1, c, ang);
  let verified = false;
  for (let k = 0; k < 10; k++) {
    const s = shrink;
    const ring = localRectToWorld(x0 + s, y0 + s, x1 - s, y1 - s, c, ang);
    if (ringValid(ring, surface)) {
      world = ring;
      verified = true;
      break;
    }
    shrink += U(0.3);
  }
  if (!verified) {
    // 边界现在是**曲线**（路缘修形之后地块边不再是直线段），
    // 内接矩形的角常常正好压在曲边上 —— 一次 0.6 m 的收缩不一定够，
    // 逐级再试，直到真的落在面内（最多退 2.1 m，再不行就承认失败）
    for (const shrink of [0.6, 1.1, 1.6, 2.1]) {
      const cand = localRectToWorld(x0 + U(shrink), y0 + U(shrink), x1 - U(shrink), y1 - U(shrink), c, ang);
      world = cand;
      if (ringValid(cand, surface)) {
        verified = true;
        break;
      }
    }
  }

  const area = Math.abs(M2(surfaceArea({ outer: world, holes: [] })));
  if (area < 40) return null;
  const parcelArea = areaM2(surface);
  return {
    ring: world,
    areaM2: +area.toFixed(1),
    angRad: ang,
    quality: +(area / Math.max(1, parcelArea)).toFixed(3),
    cellM: +cellM.toFixed(2),
    verified,
    attempts: anglesCount(1),
  };
}

/** 局部坐标系下的矩形（frameRad 的 +v 指向街道） */
function rectInFrame(surface: PlanSurface, ang: number): InscribedRect | null {
  const c = centroid(surface.outer);
  const cs = Math.cos(ang);
  const sn = Math.sin(ang);
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (const p of surface.outer) {
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    const u = dx * cs + dy * sn;
    const v = -dx * sn + dy * cs;
    u0 = Math.min(u0, u);
    u1 = Math.max(u1, u);
    v0 = Math.min(v0, v);
    v1 = Math.max(v1, v);
  }
  const area = Math.abs(M2((u1 - u0) * (v1 - v0)));
  const parcelArea = areaM2(surface);
  if (parcelArea <= 0 || area / parcelArea < 0.88) return null;
  let ring = localRectToWorld(u0, v0, u1, v1, c, ang);
  if (!ringValid(ring, surface)) {
    // 顶点正好落在多边形边上时 pointInRing 会判"外" —— 往里收 0.4 m 再验一次。
    // 不这么做的话，一个完美矩形地块也会掉进栅格搜索，白丢 2~3% 面积。
    const e = U(0.4);
    ring = localRectToWorld(u0 + e, v0 + e, u1 - e, v1 - e, c, ang);
    if (!ringValid(ring, surface)) return null;
  }
  return {
    ring,
    areaM2: +area.toFixed(1),
    angRad: ang,
    quality: +(area / parcelArea).toFixed(3),
    cellM: 0.05,
    verified: true,
    attempts: 1,
  };
}

function anglesCount(n: number): number {
  return n;
}

function localRectToWorld(x0: number, y0: number, x1: number, y1: number, c: Pt, ang: number): Pt[] {
  const cs = Math.cos(ang);
  const sn = Math.sin(ang);
  const toWorld = (p: Pt): Pt => new Pt(c.x + p.x * cs - p.y * sn, c.y + p.x * sn + p.y * cs);
  return cleanRing([
    toWorld(new Pt(x0, y0)),
    toWorld(new Pt(x1, y0)),
    toWorld(new Pt(x1, y1)),
    toWorld(new Pt(x0, y1)),
  ]);
}

function ringValid(ring: Pt[], surface: PlanSurface): boolean {
  const probes: Pt[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    probes.push(a);
    probes.push(new Pt((a.x + b.x) / 2, (a.y + b.y) / 2));
    probes.push(new Pt(a.x * 0.75 + b.x * 0.25, a.y * 0.75 + b.y * 0.25));
    probes.push(new Pt(a.x * 0.25 + b.x * 0.75, a.y * 0.25 + b.y * 0.75));
  }
  /**
   * 只验四角和边中点是不够的：一个把中庭洞整个盖住的矩形，四角和边中点
   * 全都在面内（20×20 的方院子中间挖 4×4 的洞，边中点离洞还远）。
   * 所以内部也要布 3×3 采样 —— 这也是"最大内接矩形真的在可用多边形内"
   * 这条验收要求的最小实现。
   */
  if (ring.length >= 3) {
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
    for (const u of [0.2, 0.5, 0.8]) {
      for (const v of [0.2, 0.5, 0.8]) {
        const px = minX + (maxX - minX) * u;
        const py = minY + (maxY - minY) * v;
        if (pointInQuad(ring, px, py)) probes.push(new Pt(px, py));
      }
    }
  }
  /**
   * "在面内"要**允许贴边**。
   *
   * 内接矩形是从地块自身的范围里搜出来的，四角天然就压在地块边上；
   * `insideSurface` 对边界点一律判"外"，于是 campus 那种大而规整的地块
   * 672 块**全部**被判成"没通过校验"（实测）。贴边 3 cm 以内算通过，
   * 真超界（几米）照样会被抓出来。
   */
  const tolU = 0.03;
  return probes.every(
    (p) =>
      insideSurface(p, surface) ||
      distPointToPolyline(p, surface.outer) <= tolU ||
      surface.holes.some((h) => distPointToPolyline(p, h) <= tolU)
  );
}

/** 点是否在四边形内（用对角线叉积判，够用且便宜） */
function pointInQuad(q: Pt[], x: number, y: number): boolean {
  if (q.length !== 4) return true;
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const c = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    if (Math.abs(c) < 1e-12) continue;
    const s = c > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (sign !== s) return false;
  }
  return true;
}

/** 二值矩阵里的最大全 1 矩形（直方图 + 单调栈） */
function largestRect(mask: Uint8Array, cols: number, rows: number): { x: number; y: number; w: number; h: number } | null {
  const heights = new Int32Array(cols);
  let best = { x: 0, y: 0, w: 0, h: 0, area: 0 };
  const stack: number[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) heights[i] = mask[j * cols + i] ? heights[i] + 1 : 0;
    stack.length = 0;
    for (let i = 0; i <= cols; i++) {
      const h = i < cols ? heights[i] : 0;
      while (stack.length > 0 && heights[stack[stack.length - 1]] >= h) {
        const top = stack.pop()!;
        const hh = heights[top];
        const left = stack.length > 0 ? stack[stack.length - 1] + 1 : 0;
        const w = i - left;
        const area = w * hh;
        if (area > best.area) best = { x: left, y: j - hh + 1, w, h: hh, area };
      }
      stack.push(i);
    }
  }
  return best.area > 0 ? best : null;
}

// ---------------------------------------------------------------- 内退

interface Setbacks {
  front: number;
  side: number;
  back: number;
}

/**
 * 退线（米）。地块变小之后这些数要跟着变：
 * 22 m 面宽的地块上留 4 m 侧退线，房子只剩 14 m 宽，图上就是"一格格小盒子夹在铺装里"。
 * 真实沿街住宅是**共墙**的（侧退 0~1.2 m），退线主要在前后。
 */
const SETBACKS: Record<BuildingParcel['use'], Setbacks> = {
  residential: { front: 3.5, side: 1.2, back: 4.5 },
  commercial: { front: 1.5, side: 0.8, back: 3 },
  cbd: { front: 2, side: 2, back: 4 },
  industrial: { front: 8, side: 4, back: 7 },
  campus: { front: 10, side: 5, back: 10 },
  civic: { front: 5, side: 3, back: 5 },
  park: { front: 3, side: 3, back: 3 },
  green: { front: 3, side: 3, back: 3 },
};

/**
 * 把内接矩形按"前/侧/后"内退成建筑控制区。
 *
 * 矩形环的边序是 [p0(局部 x0,y0), p1(x1,y0), p2(x1,y1), p3(x0,y1)]，
 * 局部 +v 指向街道 → 边 2（p2→p3）是**临街边**。这个约定由
 * `maxInscribedRect(frameRad = frontRad - 90°)` 保证，不能随便改。
 */
export function footprintOf(rect: InscribedRect, use: BuildingParcel['use']): Pt[] | null {
  const sb = SETBACKS[use];
  const ring = rect.ring;
  if (ring.length !== 4) return null;
  /**
   * 退线要**按地块实际尺寸收放**。
   *
   * 固定退线（工业前 9 m / 后 8 m）在一条 34 m 宽的带子上会直接把可用进深吃光，
   * 结果是"有地块、没建筑"（I01 实测 0 栋）。规则改成：
   * 前+后 ≤ 进深的 50%，左+右 ≤ 面宽的 30%，超了就等比缩 —— 缩了多少写进报告。
   */
  // 边序 [p0(后左), p1(后右), p2(前右), p3(前左)]：
  //   进深 = 边 1（p1→p2，从后到前），面宽 = 边 0（p0→p1，沿街）。
  // 这两个搞反过一次：把"临街边长"当进深，结果 14 m 深的带子算成 65 m 深，
  // 退线一刀不缩，直接吃掉全部可用进深（I01 变 0 栋）。
  const depthU = Math.hypot(ring[2].x - ring[1].x, ring[2].y - ring[1].y) || 1;
  const widthU = Math.hypot(ring[1].x - ring[0].x, ring[1].y - ring[0].y) || 1;
  const kDepth = Math.min(1, (depthU * 0.5) / Math.max(1e-6, U(sb.front + sb.back)));
  const kWidth = Math.min(1, (widthU * 0.35) / Math.max(1e-6, U(sb.side * 2)));
  const k = Math.max(0.3, Math.min(kDepth, kWidth, 1));
  // 边序：0=后(局部 y0)，1=右(x1)，2=临街(y1)，3=左(x0)
  // 局部 +v 指街道（由 frameRad = frontRad - 90° 保证），所以 y1 那一侧临街。
  const dists = [U(sb.back) * k, U(sb.side) * k, U(sb.front) * k, U(sb.side) * k];
  const out = insetPerEdge(ring, dists);
  if (out.length < 3) return null;
  const a = Math.abs(M2(surfaceArea({ outer: out, holes: [] })));
  if (a < 30) return null;
  return out;
}

// ---------------------------------------------------------------- 体量

export interface BuildingOut {
  solids: SolidFeature[];
  /** 建筑占地（含裙房、裙楼），用于扣地面 */
  footprints: PlanSurface[];
  gfaM2: number;
  note: string;
}

export interface RealizeOpts {
  density: CityDensity;
  heightScale: number;
  rng: () => number;
  /** 建筑覆盖率上限（占地 / 地块）：来自风貌预设 */
  coverage?: number;
  /** 到城市中心的归一化距离 0~1：中心更高，边缘更低（风貌的高度梯度） */
  centerDist?: number;
}

/**
 * 由 Footprint 生出体量。
 *
 * 不继承旧算法里的任何位置/轮廓：这里的每一栋都由
 * "地块 → 最大内接矩形 → 内退 → 体量语法"重新推出来。
 */
export function realizeBuildings(parcel: BuildingParcel, footprint: Pt[], opts: RealizeOpts): BuildingOut {
  const d = DENSITY_PRESETS[opts.density];
  /**
   * 高度梯度：越靠城市中心越高。
   *
   * 这一条是"城市风貌"最直接的表达 —— 没有它，全城所有楼都是同一个层数，
   * 鸟瞰就是一张均匀的毯子，没有中心也没有边缘。梯度只作用在层数上，
   * 不改体量语法（体量语法由用途决定）。
   */
  const cd = opts.centerDist ?? 0.5;
  // 中心最高接近 2 倍、0.55 半径以外回到 1 倍 —— 城市需要一条可读的天际线，
  // 而不是全城同一个层数（那在鸟瞰里就是一张毯子）。
  const hs = opts.heightScale * (cd < 0.55 ? 1 + (0.55 - cd) * 1.8 : 1);
  const fl = (n: number): number => (n * d.floorH * hs) / 7;
  const solids: SolidFeature[] = [];
  const footprints: PlanSurface[] = [];
  const use = parcel.use;
  let gfa = 0;
  let note = '';

  /**
   * 体量在"街道坐标系"里生成：u 从街往地块里指，v 沿街。
   *
   * 这是本轮最关键的一条修正。上一版是"把内退后的轮廓整块拉起来"，
   * 结果一栋住宅的进深等于地块进深（实测 50 m 深、130 m 长的板楼），
   * 全城看起来像一片仓库。真实建筑有**进深上限**：住宅 13~15 m、
   * 商业 18~22 m、厂房 40~50 m；剩下的地是院子。
   */
  /**
   * 取**轮廓自己的**轴向（不是街区朝向）。
   *
   * 用 frontRad 当轴的时候，只要轮廓跟街道朝向差一个角度，`uMin..uMax` 这个
   * 包围盒就会比轮廓大一圈，排出来的楼会戳出地块（实测 715 栋里 4 栋越界）。
   * 所以轴向从 footprint 的 OBB 取，只把**正负**按 frontRad 定（保证"前"仍是临街侧）。
   */
  const obF = obbOf(footprint);
  let ux = Math.cos(parcel.frontRad);
  let uy = Math.sin(parcel.frontRad);
  if (obF) {
    const cand: [number, number][] = [
      [obF.ux, obF.uy],
      [obF.vx, obF.vy],
    ];
    let best = cand[0];
    let bestDot = -Infinity;
    for (const c of cand) {
      const d = Math.abs(c[0] * ux + c[1] * uy);
      if (d > bestDot) {
        bestDot = d;
        best = c;
      }
    }
    const sign = best[0] * ux + best[1] * uy >= 0 ? 1 : -1;
    ux = best[0] * sign;
    uy = best[1] * sign;
  }
  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const p of footprint) {
    const dx = p.x;
    const dy = p.y;
    const u = dx * ux + dy * uy;
    const v = -dx * uy + dy * ux;
    uMin = Math.min(uMin, u);
    uMax = Math.max(uMax, u);
    vMin = Math.min(vMin, v);
    vMax = Math.max(vMax, v);
  }
  /**
   * 建筑占地预算：`coverage` 是**唯一**控制"这块地能盖多满"的规则。
   *
   * 上一版这个字段写了却没人读（全城实际覆盖率 28%，预设 42% 形同虚设）。
   * 现在按地块面积 × coverage 给一个总预算，排到预算用完就停 ——
   * 于是"排数 × 段数"不再各自为政，整个地块的密度是可控的。
   */
  const coverageBudget = Math.max(0, parcel.areaM2 * (opts.coverage ?? 0.45));
  let builtArea = 0;

  const avail = uMax - uMin;
  const width = vMax - vMin;
  /**
   * 进深上限：建筑占地不能超过地块 × coverage。
   *
   * 只在 `add` 里拦是"事后否决"——第一栋往往就已经超了（16×26 的商业地块上
   * 排 20 m 进深，占 58%），于是整块地要么没有停车空间、要么被直接否掉。
   * 在这里先把可用进深**压到预算以内**，后面排几排都自然合规。
   */
  const depthCap = Math.min(avail, coverageBudget / Math.max(1e-6, width));
  if (avail < U(6) || width < U(6)) return { solids, footprints, gfaM2: 0, note: '内退后不足以放下建筑' };

  const ringOf = (u0: number, u1: number, v0: number, v1: number): Pt[] =>
    cleanRing([
      new Pt(ux * u0 - uy * v0, uy * u0 + ux * v0),
      new Pt(ux * u0 - uy * v1, uy * u0 + ux * v1),
      new Pt(ux * u1 - uy * v1, uy * u1 + ux * v1),
      new Pt(ux * u1 - uy * v0, uy * u1 + ux * v0),
    ]);

  const add = (ringIn: Pt[], hU: number, kind: SolidKind, wall: keyof typeof MAT, roof: keyof typeof MAT): void => {
    // `hU <= 0` 挡不住 NaN（NaN <= 0 是 false），必须单独判
    if (ringIn.length < 3 || !(hU > 0)) return;
    let ring = ringIn;
    /**
     * 统一再收 8 cm：地块边界现在是**曲线**（路缘修形之后），
     * 内接矩形的角正好落在曲边上时，浮点误差会让一栋楼探出去 1~2 cm，
     * 断言里就是"956 栋里有 1 栋越界"。收 8 cm 比放大容差诚实。
     */
    const cx0 = ring.reduce((t, q) => t + q.x, 0) / ring.length;
    const cy0 = ring.reduce((t, q) => t + q.y, 0) / ring.length;
    const shrink = 0.08;
    ring = ring.map((q) => {
      const dx = q.x - cx0;
      const dy = q.y - cy0;
      const L = Math.hypot(dx, dy) || 1;
      const k = Math.max(0, (L - shrink) / L);
      return new Pt(cx0 + dx * k, cy0 + dy * k);
    });
    const A = Math.abs(M2(surfaceArea({ outer: ring, holes: [] })));
    if (A < 12) return;
    // 预算只挡"再加一栋"：第一栋永远允许，否则一排 13.5 m 进深的住宅
    // 在 25 m 进深的地块上（54%）会被整块否掉，全城建筑数直接腰斩（实测 1190 → 430）。
    if (builtArea > 0 && builtArea + A > coverageBudget * 1.05) return;
    solids.push({
      name: `${parcel.id}_${kind}_${solids.length}`,
      group: `lot/${use}`,
      ring,
      y0: 0,
      h: hU,
      wallMat: wall,
      roofMat: roof,
      kind,
    });
    footprints.push({ outer: ring, holes: [] });
    builtArea += A;
    gfa += (A * (hU * 7)) / d.floorH;
  };

  const pick = (lo: number, hi: number): number => lo + opts.rng() * (hi - lo);

  /**
   * 沿街排建筑：沿 v 切成若干栋，沿 u 排 1~3 排。
   *
   * 排数由**进深**决定，不是固定值：`N = (进深 + 院子) / (建筑进深 + 院子)`。
   * 这一条直接决定鸟瞰观感 —— 只排前排时，30×60 m 的地块上建筑只占 22%，
   * 剩下全是草坪，看起来是"草地上散着几栋房子"；排两排就到 45%，
   * 中间自然留出宅间绿地，这才是街区。
   */
  const rows = (
    depthU: number,
    segLenU: number,
    gapU: number,
    hU: number,
    kind: SolidKind,
    wall: keyof typeof MAT,
    roof: keyof typeof MAT
  ): number => {
    const yardU = U(13);
    const nRows = Math.max(1, Math.min(3, Math.round((avail + yardU) / (depthU + yardU))));
    const span = nRows > 1 ? (avail - depthU) / (nRows - 1) : 0;
    // 段长带 ±25% 抖动：否则全城每一栋都是同一个长度，像一排排货架
    const seg = segLenU * (0.78 + opts.rng() * 0.5);
    const k = Math.max(1, Math.min(6, Math.round((width + gapU) / (seg + gapU))));
    const each = (width - gapU * (k - 1)) / k;
    let n = 0;
    const one = (u0: number, u1: number, v0: number, v1: number): void => {
      // 每栋 ±1 层的抖动：全城一个层数在鸟瞰里就是"一条毯子"，
      // 有抖动才有"一栋一栋"的读法（抖动是确定性的：rng 来自 seed）
      const jit = (opts.rng() < 0.5 ? -1 : 1) * (opts.rng() < 0.55 ? 1 : 0);
      const h = Math.max(fl(2), hU + (jit * d.floorH * hs) / 7);
      add(ringOf(u0, u1, v0, v1), h, kind, wall, roof);
      n++;
    };
    for (let r = 0; r < nRows; r++) {
      const u0 = uMin + r * span;
      const u1 = Math.min(uMax, u0 + depthU);
      if (each < U(7)) {
        one(u0, u1, vMin, vMax);
        continue;
      }
      for (let i = 0; i < k; i++) {
        // 奇偶排错开半段：前后排完全对齐会像军营
        const shift = r % 2 === 1 ? gapU * 0.5 : 0;
        const v0 = Math.min(vMax - each, vMin + i * (each + gapU) + shift);
        one(u0, u1, v0, Math.min(vMax, v0 + each));
      }
    }
    return n;
  };

  if (use === 'cbd') {
    const podiumD = Math.min(depthCap, U(38));
    const podiumH = fl(2 + Math.round(opts.rng()));
    add(ringOf(uMin, uMin + podiumD, vMin, vMax), podiumH, 'podium', 'wallStone', 'roofLight');
    const floors = Math.round(pick(d.towerFloors[0], d.towerFloors[1]));
    const tw = Math.min(width * 0.46, U(34));
    const td = Math.min(podiumD * 0.62, U(24));
    const tv = (vMin + vMax) / 2;
    add(ringOf(uMin + U(2), uMin + U(2) + td, tv - tw / 2, tv + tw / 2), Math.max(fl(floors), podiumH + fl(2)), 'tower', 'wallGlass', 'roofDark');
    note = `裙房 ${(podiumH * 7).toFixed(0)} m（进深 ${(podiumD * 7).toFixed(0)} m）+ 塔楼 ${floors} 层`;
  } else if (use === 'commercial') {
    const floors = Math.round(pick(d.commercialFloors[0], d.commercialFloors[1]));
    const depth = Math.min(depthCap, U(20));
    const k = rows(depth, U(38), U(8), fl(floors), 'retail', 'wallBrick', 'roofFlat');
    note = `沿街商业 ${floors} 层 × ${k} 段（进深 ${(depth * 7).toFixed(0)} m）`;
  } else if (use === 'industrial') {
    const h = (pick(d.industrialHeight[0], d.industrialHeight[1]) * hs) / 7;
    const depth = Math.min(depthCap, U(46));
    add(ringOf(uMin, uMin + depth, vMin + width * 0.06, vMax - width * 0.06), h, 'warehouse', 'wallPanel', 'roofMetal');
    // 办公配楼靠一侧，压在厂房前
    const ow = Math.min(U(26), width * 0.3);
    add(ringOf(uMin, uMin + Math.min(depthCap, U(14)), vMin, vMin + ow), fl(3), 'podium', 'wallPanel', 'roofLight');
    note = `厂房 ${(h * 7).toFixed(0)} m 高 / 进深 ${(depth * 7).toFixed(0)} m + 3 层办公`;
  } else if (use === 'campus') {
    const floors = Math.round(pick(4, 6));
    const depth = Math.min(depthCap, U(16));
    if (width * 7 > 55 && avail * 7 > 34) {
      // 院落式：沿街两翼 + 后翼，中间内院
      const wing = Math.min(U(14), width * 0.22);
      const backD = Math.min(U(13), avail * 0.3);
      add(ringOf(uMin, uMin + depth, vMin, vMin + wing), fl(floors), 'slab', 'wallConcrete', 'roofLight');
      add(ringOf(uMin, uMin + depth, vMax - wing, vMax), fl(floors), 'slab', 'wallConcrete', 'roofLight');
      add(ringOf(uMax - backD, uMax, vMin + wing * 0.5, vMax - wing * 0.5), fl(floors), 'slab', 'wallConcrete', 'roofLight');
      note = `院落式 ${floors} 层（两翼 + 后翼 + 内院）`;
    } else {
      rows(depth, U(40), U(10), fl(floors), 'slab', 'wallConcrete', 'roofLight');
      note = `板式 ${floors} 层`;
    }
  } else if (use === 'civic') {
    const floors = Math.round(pick(3, 4));
    const depth = Math.min(depthCap, U(22));
    add(ringOf(uMin, uMin + depth, vMin + width * 0.1, vMax - width * 0.1), fl(floors), 'slab', 'wallStone', 'roofLight');
    note = `公共设施 ${floors} 层`;
  } else if (use === 'park' || use === 'green') {
    if (areaM2(parcel.surface) > 5000) {
      add(ringOf(uMin, uMin + U(9), vMin + width * 0.4, vMin + width * 0.4 + U(7)), fl(1), 'house', 'wallStone', 'roofDark');
      note = '公园管理房';
    } else note = '纯绿地，无建筑';
  } else {
    // 居住
    const floors = Math.round(pick(d.residentialFloors[0], d.residentialFloors[1]));
    const depth = Math.min(depthCap, U(13.5));
    if (width * 7 < 15) {
      add(ringOf(uMin, uMin + Math.min(depthCap, U(12)), vMin, vMax), fl(2 + Math.round(opts.rng() * 2)), 'retail', 'wallBrick', 'roofFlat');
      note = '细长地块 → 沿街小商业 2~3 层';
    } else {
      const k0 = solids.length;
      // 屋顶色按段轮换：全城同一个灰在鸟瞰里就是一张毯子
      const roofPick = k0 % 3;
      const roofKey: keyof typeof MAT = roofPick === 0 ? 'roofFlat' : roofPick === 1 ? 'roofLight' : 'roofMetal';
      const k = rows(depth, U(44), U(10), fl(floors), 'slab', 'wallConcrete', roofKey);
      note = `${k} 栋板楼 ${floors} 层（进深 ${(depth * 7).toFixed(0)} m${k > 1 ? '，前后双排' : ''}）`;
    }
  }

  return { solids, footprints, gfaM2: +gfa.toFixed(0), note };
}

function centroid(ring: Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p.x;
    y += p.y;
  }
  return new Pt(x / Math.max(1, ring.length), y / Math.max(1, ring.length));
}
