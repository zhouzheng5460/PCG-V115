// F2.5-B · 空间破碎：产生"街区候选"与"候选切线"
//
// 两种破碎器，输出同一份合同（cells + cuts）：
//   · `fractureVoronoi`  —— 受控 Voronoi：有机、不规则，适合住宅园区 / 老城
//   · `fractureObb`      —— Recursive OBB：沿主轴递归二分，规整、有方向感，适合商业/CBD
//
// 关键约定：**破碎不等于是路**。这里产出的 cuts 全是候选，
// 由 `select.ts` 决定哪几条才成为道路。

import { Pt } from '../../../core/geom';
import { bboxOf, surface, surfaceArea, surfaceIntersect, type PlanSurface } from '../core/surface';
import { obbOf, splitSurfaceByLine } from '../subdivision/geom';
import type { EdgeSource, RoadClass } from './types';

export interface Cell {
  id: string;
  surface: PlanSurface;
  centroid: Pt;
  areaM2: number;
}

export interface Cut {
  id: string;
  a: Pt;
  b: Pt;
  /** 两侧的 cell id（切割线本来就是两块地的分界） */
  left: string;
  right: string;
  lenM: number;
  source: EdgeSource;
  /** 建议等级（选择阶段可能改写） */
  cls: RoadClass;
  /** 选定后由风格预设给出的路幅（米）；未选中时为 undefined */
  widthM?: number;
}

export interface Fracture {
  cells: Cell[];
  cuts: Cut[];
  kind: 'voronoi' | 'obb';
}

const M2 = (u2: number) => u2 * 49;

// ---------------------------------------------------------------- Voronoi

export interface VoronoiFractureOpts {
  seed: number;
  count: number;
  /** 站点最小间距（米） */
  minDistM?: number;
  /** Lloyd 松弛次数 */
  relax?: number;
  /** 小于这个面积（m²）的 cell 丢弃 */
  minCellM2?: number;
  /** 站点向形心收缩的程度 0~1：0 = 纯随机（更有机），1 = 完全松弛（更均匀） */
  jitter?: number;
  /**
   * 外部给定站点（F3 用）。
   *
   * 规则城市要"沿张量方向排布的街区"，撒随机点做不到 —— 中垂线是站点连线的
   * 垂直平分线，站点排成带旋转的格子，切出来的边界才平行于主方向。
   * 给了 sites 就跳过撒点与松弛（仍然做半平面裁剪），行为与随机撒点完全一致。
   */
  sites?: Pt[];
}

/**
 * 受控 Voronoi 破碎。
 *
 * 站点撒点 + 中垂线半平面裁剪（纯布尔，无第三方几何库），可选 Lloyd 松弛。
 * `jitter` 控制"有机程度"：把松弛后的站点再往原随机位置拉回一部分，
 * 既有大小变化又不至于碎成蜂窝。
 */
export function fractureVoronoi(boundary: PlanSurface, opts: VoronoiFractureOpts): Fracture {
  const rng = rngOf(opts.seed);
  const count = Math.max(3, opts.count);
  const minDist = (opts.minDistM ?? 20) / 7;
  const relax = opts.relax ?? 3;
  const jitter = opts.jitter ?? 0.25;
  const minCellM2 = opts.minCellM2 ?? 300;

  const bb = bboxOf(boundary.outer);
  const spanX = bb.maxX - bb.minX;
  const spanY = bb.maxY - bb.minY;

  // 撒点（拒绝采样，最小间距逐轮放宽）
  let sites: Pt[] = opts.sites?.length ? opts.sites.map((p) => new Pt(p.x, p.y)) : [];
  for (let attempt = 0; attempt < 4 && !opts.sites?.length && sites.length < count; attempt++) {
    const md = minDist * Math.pow(0.72, attempt);
    for (let i = 0; i < count * 80 && sites.length < count; i++) {
      const p = new Pt(bb.minX + rng() * spanX, bb.minY + rng() * spanY);
      if (!insideRing(p, boundary)) continue;
      if (sites.some((q) => Pt.distance(q, p) < md)) continue;
      sites.push(p);
    }
  }
  const original = sites.map((p) => new Pt(p.x, p.y));
  if (sites.length < 3) return { cells: [], cuts: [], kind: 'voronoi' };

  let cells = cellsOf(boundary, sites, minCellM2);
  for (let r = 0; r < relax && !opts.sites?.length; r++) {
    const next: Pt[] = [];
    for (const c of cells) {
      const cen = centroidOf(c.outer);
      next.push(new Pt(cen.x, cen.y));
    }
    if (next.length < 3) break;
    // 拉回一部分原始位置 → 保留尺寸差异（不拉回就是标准 Lloyd，会趋于均匀）
    sites = next.map((p, i) => {
      const o = original[i % original.length];
      return new Pt(p.x + (o.x - p.x) * jitter * 0.35, p.y + (o.y - p.y) * jitter * 0.35);
    });
    cells = cellsOf(boundary, sites, minCellM2);
  }

  const out: Cell[] = cells.map((s, i) => ({
    id: `c${i}`,
    surface: s,
    centroid: centroidOf(s.outer),
    areaM2: M2(surfaceArea(s)),
  }));

  return { cells: out, cuts: sharedCuts(out, 'fracture'), kind: 'voronoi' };
}

/** 一组站点 → 各自被其它站点中垂线裁剪后的 cell（纯布尔） */
function cellsOf(boundary: PlanSurface, sites: Pt[], minCellM2: number): PlanSurface[] {
  const bb = bboxOf(boundary.outer);
  const diag = Math.hypot(bb.maxX - bb.minX, bb.maxY - bb.minY);
  let maxR = 0;
  for (const s of sites) for (const q of boundary.outer) maxR = Math.max(maxR, Pt.distance(s, q));

  const out: PlanSurface[] = [];
  for (let i = 0; i < sites.length; i++) {
    let cell: PlanSurface[] = [boundary];
    const si = sites[i];
    for (let j = 0; j < sites.length; j++) {
      if (i === j) continue;
      const sj = sites[j];
      const d = Pt.distance(si, sj);
      if (d > maxR * 2) continue;
      const nx = (sj.x - si.x) / (d || 1);
      const ny = (sj.y - si.y) / (d || 1);
      const mx = (si.x + sj.x) / 2;
      const my = (si.y + sj.y) / 2;
      const tx = -ny;
      const ty = nx;
      const R = diag * 3 + 1;
      const half = surface([
        new Pt(mx + tx * R, my + ty * R),
        new Pt(mx + tx * R - nx * R, my + ty * R - ny * R),
        new Pt(mx - tx * R - nx * R, my - ty * R - ny * R),
        new Pt(mx - tx * R, my - ty * R),
      ]);
      const next: PlanSurface[] = [];
      for (const c of cell) {
        try {
          const r = intersect(c, half);
          next.push(...r.filter((q) => surfaceArea(q) > 1e-7));
        } catch {
          next.push(c);
        }
      }
      cell = next;
      if (cell.length === 0) break;
    }
    for (const c of cell) if (M2(surfaceArea(c)) >= minCellM2) out.push(c);
  }
  return out;
}

// ---------------------------------------------------------------- OBB

export interface ObbFractureOpts {
  seed: number;
  /** 目标 cell 面积（m²） */
  targetCellM2?: number;
  /** 最大递归深度 */
  maxDepth?: number;
  /** 切割比例抖动（0 = 永远对半） */
  jitter?: number;
  minCellM2?: number;
}

/**
 * Recursive OBB 破碎：沿当前 cell 的最短边方向切，比例 0.5±jitter。
 *
 * 与 F2.1 的 Recursive OBB 同源（`splitSurfaceByLine` + OBB 主轴），
 * 但这里**不追求地块尺寸合规**，只负责"把场面切成街区"。
 */
export function fractureObb(boundary: PlanSurface, opts: ObbFractureOpts): Fracture {
  const target = (opts.targetCellM2 ?? 3500) / 49;
  const maxDepth = opts.maxDepth ?? 4;
  const jitter = opts.jitter ?? 0.12;
  const minCellM2 = opts.minCellM2 ?? 400;
  const rng = rngOf(opts.seed);

  const cells: Cell[] = [];
  const cuts: Cut[] = [];
  let cutId = 0;

  const walk = (s: PlanSurface, depth: number): void => {
    if (depth >= maxDepth || surfaceArea(s) <= target) {
      cells.push({ id: `c${cells.length}`, surface: s, centroid: centroidOf(s.outer), areaM2: M2(surfaceArea(s)) });
      return;
    }
    const ob = obbOf(s.outer);
    if (!ob) {
      cells.push({ id: `c${cells.length}`, surface: s, centroid: centroidOf(s.outer), areaM2: M2(surfaceArea(s)) });
      return;
    }
    // 沿短边方向切（切完两块更接近方形）
    const ang = Math.atan2(ob.uy, ob.ux) + Math.PI / 2;
    const ratio = Math.max(0.32, Math.min(0.68, 0.5 + (rng() - 0.5) * jitter * 2));
    const chord = chordOf(s, ob.cx, ob.cy, ang, ratio);
    if (!chord) {
      cells.push({ id: `c${cells.length}`, surface: s, centroid: centroidOf(s.outer), areaM2: M2(surfaceArea(s)) });
      return;
    }
    const at = new Pt((chord.a.x + chord.b.x) / 2, (chord.a.y + chord.b.y) / 2);
    const split = splitSurfaceByLine(s, at, ang);
    if (!split || split.a.length === 0 || split.b.length === 0) {
      cells.push({ id: `c${cells.length}`, surface: s, centroid: centroidOf(s.outer), areaM2: M2(surfaceArea(s)) });
      return;
    }
    const A = split.a.reduce((x, y) => (surfaceArea(y) > surfaceArea(x) ? y : x));
    const B = split.b.reduce((x, y) => (surfaceArea(y) > surfaceArea(x) ? y : x));
    if (M2(surfaceArea(A)) < minCellM2 || M2(surfaceArea(B)) < minCellM2) {
      cells.push({ id: `c${cells.length}`, surface: s, centroid: centroidOf(s.outer), areaM2: M2(surfaceArea(s)) });
      return;
    }
    // 先递归再登记 cut：cut 需要子 cell 的 id
    const before = cells.length;
    walk(A, depth + 1);
    const leftIds = cells.slice(before).map((c) => c.id);
    walk(B, depth + 1);
    const rightIds = cells.slice(before + leftIds.length).map((c) => c.id);
    cuts.push({
      id: `k${cutId++}`,
      a: chord.a,
      b: chord.b,
      left: leftIds[0] ?? '',
      right: rightIds[0] ?? '',
      lenM: Pt.distance(chord.a, chord.b) * 7,
      source: 'fracture',
      cls: 'local',
    });
  };

  walk(boundary, 0);
  return { cells, cuts, kind: 'obb' };
}

// ---------------------------------------------------------------- 共享边 → 候选切线

/**
 * 从 cell 集合里提取"相邻共享边"，作为候选切线。
 *
 * 判据：沿 cell 边的外法线挪 0.6 m，落进另一块 cell 就是共享边。
 * 返回的 a/b 是**该边在 cell 环上的两个顶点** —— 相邻两块共享的边会各被扫到一次，
 * 这里按中点去重（保留先遇到的那条）。
 */
export function sharedCuts(cells: Cell[], source: EdgeSource): Cut[] {
  const out: Cut[] = [];
  const seen = new Set<string>();
  const grid = new Map<string, string[]>();
  const CELL = 8;
  for (const c of cells) {
    for (const p of c.surface.outer) {
      const k = `${Math.floor(p.x / CELL)},${Math.floor(p.y / CELL)}`;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k)!.push(c.id);
    }
  }
  const candidates = (p: Pt): string[] => {
    const kx = Math.floor(p.x / CELL);
    const ky = Math.floor(p.y / CELL);
    const set = new Set<string>();
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) for (const id of grid.get(`${kx + dx},${ky + dy}`) ?? []) set.add(id);
    return [...set];
  };

  for (const c of cells) {
    const ring = c.surface.outer;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const L = Pt.distance(a, b);
      if (L < 1e-6) continue;
      // CCW 环的右手法线朝外
      const nx = (b.y - a.y) / L;
      const ny = -(b.x - a.x) / L;
      const probe = new Pt((a.x + b.x) / 2 + nx * 0.6, (a.y + b.y) / 2 + ny * 0.6);
      let other: Cell | null = null;
      for (const id of candidates(probe)) {
        if (id === c.id) continue;
        const cc = cells.find((x) => x.id === id);
        if (cc && insideRing(probe, cc.surface)) {
          other = cc;
          break;
        }
      }
      if (!other) continue;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const key = `${Math.round(mx * 4)},${Math.round(my * 4)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: `k${out.length}`,
        a: new Pt(a.x, a.y),
        b: new Pt(b.x, b.y),
        left: c.id,
        right: other.id,
        lenM: L * 7,
        source,
        cls: 'local',
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- 小工具

function rngOf(seed: number): () => number {
  let s = (seed | 0) || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1e6) / 1e6;
  };
}

export function centroidOf(ring: Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p.x;
    y += p.y;
  }
  const n = Math.max(1, ring.length);
  return new Pt(x / n, y / n);
}

export function insideRing(p: Pt, s: PlanSurface): boolean {
  if (!inRing(p, s.outer)) return false;
  for (const h of s.holes) if (inRing(p, h)) return false;
  return true;
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

function intersect(a: PlanSurface, b: PlanSurface): PlanSurface[] {
  return surfaceIntersect([a], [b]);
}

/**
 * 沿给定方向、过给定点，取多边形内最长的弦（用于 OBB 切线）。
 *
 * `ratio` 用来把切点沿法线推离中心（0.5 = 过中心）。
 */
function chordOf(s: PlanSurface, cx: number, cy: number, ang: number, ratio: number): { a: Pt; b: Pt } | null {
  const dx = Math.cos(ang);
  const dy = Math.sin(ang);
  const nx = -dy;
  const ny = dx;
  // 先求这条线在多边形内的参数范围（沿线方向 t 的范围）
  let lo = Infinity;
  let hi = -Infinity;
  const ring = s.outer;
  // 用多边形所有顶点在法线方向上的投影范围来决定线的偏移
  let nLo = Infinity;
  let nHi = -Infinity;
  for (const p of ring) {
    const t = p.x * dx + p.y * dy;
    const n = p.x * nx + p.y * ny;
    lo = Math.min(lo, t);
    hi = Math.max(hi, t);
    nLo = Math.min(nLo, n);
    nHi = Math.max(nHi, n);
  }
  if (!Number.isFinite(lo)) return null;
  void cx;
  void cy;
  const nAt = nLo + (nHi - nLo) * ratio;
  // 与各边求交，得到这条线在多边形内的两个端点
  const hits: number[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const na = a.x * nx + a.y * ny;
    const nb = b.x * nx + b.y * ny;
    const da = na - nAt;
    const db = nb - nAt;
    if (Math.abs(da - db) < 1e-12) continue;
    if ((da > 0 && db > 0) || (da < 0 && db < 0)) continue;
    const t = da / (da - db);
    const ix = a.x + (b.x - a.x) * t;
    const iy = a.y + (b.y - a.y) * t;
    hits.push(ix * dx + iy * dy);
  }
  if (hits.length < 2) return null;
  hits.sort((x, y) => x - y);
  const t0 = hits[0];
  const t1 = hits[hits.length - 1];
  return {
    a: new Pt(nx * nAt + dx * t0, ny * nAt + dy * t0),
    b: new Pt(nx * nAt + dx * t1, ny * nAt + dy * t1),
  };
}
