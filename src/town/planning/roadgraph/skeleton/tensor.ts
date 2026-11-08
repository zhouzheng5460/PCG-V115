// F2.5-C.2 · 方案 A：Tensor-guided 道路骨架
//
// 复用而不是重写：
//   · `town/field/tensor.ts`  `TensorField` —— 无迹二阶张量 + 高斯衰减，θ 与 θ+π 天然等价
//   · `town/field/streamline.ts` `traceFamily` —— RK4 积分 + Jobard–Lefer 播种子 + 平行孪生线剔除
//   · `town/edgeclass.ts` `EdgeClass` 分级口径
//
// 本文件只做三件场地适配的事：
//   ① 把场源换成**真实场地轮廓**（原有 `buildFieldLines` 用的是圆形 footprint）
//   ② 族内按长度分位定级（沿用 `field/layout.ts` 的做法，理由见那里的注释）
//   ③ 输出成 C.1 的 `CutLine`，于是能直接复用 `buildGraph` 的打断/吸附/清理
//
// 这样 A 和 B 走的是同一套建图与评价，差异只在"线从哪来"。

import { Pt } from '../../../../core/geom';
import { Rng } from '../../../../core/rng';
import { guideToSource, type FieldGuide } from '../../../guide';
import { TensorField, type FieldSource } from '../../../field/tensor';
import { traceFamily, type FieldLine } from '../../../field/streamline';
import { bboxOf, type PlanSurface } from '../../core/surface';
import { STYLES, type StyleId } from '../select';
import { insideRing } from '../fracture';
import type { CutLine } from '../graph';
import type { RoadClass } from '../types';

export interface TensorOpts {
  /** 线距（米）≈ 街区尺度 */
  spacingM: number;
  seed: number;
  maxLines?: number;
  /** 主朝向（弧度）；不填则由场地轮廓的主导边算出 */
  axisRad?: number;
  /** 边界对方向的牵引半径（米） */
  boundaryRadiusM?: number;
  /** 确定性播种：关掉网格种子抖动与洗牌，路网形态只由张量场决定（F3 用） */
  deterministic?: boolean;
  /** 方向控制线：转成 path 型场源，让局部主干顺着用户画的线走 */
  guides?: FieldGuide[];
}

export interface TensorResult {
  lines: CutLine[];
  /** 场（出图看方向用） */
  field: TensorField;
  axisRad: number;
  raw: number;
  kept: number;
  spacingM: number;
  notes: string[];
}

/**
 * 从场地轮廓算主导方向：所有边长按长度加权，方向折到 90°（正反、垂直都视为同一条轴）。
 *
 * 与 `roadgraph/select.ts` 的 `dominantAxis` 同一个口径 —— 沿用它，A 与 B 的
 * "主朝向"才可比。
 */
export function axisOfRing(ring: Pt[]): number {
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const L = Pt.distance(a, b);
    if (L < 1e-9) continue;
    const ang = Math.atan2(b.y - a.y, b.x - a.x) * 2;
    sx += Math.cos(ang) * L;
    sy += Math.sin(ang) * L;
  }
  return Math.atan2(sy, sx) / 2;
}

export function tensorLines(boundary: PlanSurface, style: StyleId, opts: TensorOpts): TensorResult {
  const notes: string[] = [];
  const bb = bboxOf(boundary.outer);
  const spanX = bb.maxX - bb.minX;
  const spanY = bb.maxY - bb.minY;
  const R = Math.max(20, 0.5 * Math.hypot(spanX, spanY) / 7) * 7; // 米
  const Ru = R / 7;
  const spacingU = opts.spacingM / 7;
  const axisRad = opts.axisRad ?? axisOfRing(boundary.outer);

  // 场源：全局基准（强）+ 边界牵引（靠边时顺着轮廓切线弯过去）
  const sources: FieldSource[] = [
    { id: 'grid', type: 'grid', direction: new Pt(Math.cos(axisRad), Math.sin(axisRad)), radius: Ru, strength: 1.0 },
    {
      id: 'edge',
      type: 'boundary',
      // 边界只负责"把街道带弯"，不负责定调。
      // 强度给到 0.95 时，靠近红线的流线会整条贴着边走 —— 那条路一半落在红线外，
      // 被裁掉后沿边只剩 6 m 的地，图纸上看就是"路边贴了一条细长地块"（F01 实测 947 m²）。
      radius: (opts.boundaryRadiusM ?? Math.max(16, R * 0.32)) / 7,
      strength: 0.55,
      falloff: 1.5,
    },
  ];
  // 方向控制线：用户画一条"街道顺着走"的折线，线两侧一个带内压过全局基准。
  // 强度按 guideToSource 的换算（5 倍），衰减半径 = 城市半径 0.26。
  if (opts.guides?.length) {
    for (const g of opts.guides) {
      if (!g.enabled || g.pts.length < 2) continue;
      sources.push(guideToSource(g, Ru));
    }
  }
  const field = new TensorField(sources, boundary.outer);
  const inside = (p: Pt): boolean => insideRing(p, boundary);

  Rng.reset(opts.seed);
  const traceOpts = {
    spacing: spacingU,
    inside,
    bounds: { minX: bb.minX, maxX: bb.maxX, minY: bb.minY, maxY: bb.maxY },
    maxLines: opts.maxLines ?? 46,
    maxLength: Ru * 2.6,
    minCoherence: 0.12,
    classFor: () => 'local' as const,
    ...(opts.deterministic ? { seedJitter: 0, shuffle: false } : {}),
  };
  const major = traceFamily(field, 'major', traceOpts);
  const minor = traceFamily(field, 'minor', traceOpts);
  // 流线在"下一步会出界"时停下，端头离红线通常还有半个步长（~10 m）。
  // 不补到红线的话：路不接街（视觉断头），而且 buildGraph 认不出 boundary 节点，
  // 这些端头会被当成"接不到任何东西的断头"剪掉 —— A 方案会整张网被剪空。
  for (const l of major.concat(minor)) l.pts = extendToRing(l.pts, boundary.outer, 34);
  const all = dedupeAcrossFamilies(major.concat(minor), spacingU * 0.78);

  // 族内按长度分位定级（6:3:1 的心智模型）：主轴占 12% 长度做主干，其余 30% 做支路
  gradeByLength(all);

  const style4 = STYLES[style];
  const lines: CutLine[] = all.map((l, i) => ({
    id: `TA${i}`,
    pts: l.pts.map((p) => new Pt(p.x, p.y)),
    cls: l.cls as RoadClass,
    widthM: style4.width[l.cls as RoadClass],
    source: 'fracture' as const,
  }));

  notes.push(
    `张量场：主朝向 ${((axisRad * 180) / Math.PI).toFixed(0)}°，线距 ${opts.spacingM} m，` +
      `追出 ${all.length} 条（major ${major.length} / minor ${minor.length}）`
  );
  return { lines, field, axisRad, raw: all.length, kept: lines.length, spacingM: opts.spacingM, notes };
}

/**
 * 把折线两端沿端部方向延长到红线（最多 maxM 米）。
 *
 * 只做"补到接上"，不做"为了连通硬怼"：射线打不到红线就原样返回。
 */
export function extendToRing(pts: Pt[], ring: Pt[], maxM: number): Pt[] {
  if (pts.length < 2) return pts;
  const out = pts.map((p) => new Pt(p.x, p.y));
  const push = (which: 'start' | 'end'): void => {
    const n = out.length;
    const p = which === 'start' ? out[0] : out[n - 1];
    const q = which === 'start' ? out[1] : out[n - 2];
    const dx = p.x - q.x;
    const dy = p.y - q.y;
    const L = Math.hypot(dx, dy) || 1;
    const ux = dx / L;
    const uy = dy / L;
    let best = maxM / 7;
    let hit: Pt | null = null;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const ex = b.x - a.x;
      const ey = b.y - a.y;
      const den = ux * ey - uy * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((a.x - p.x) * ey - (a.y - p.y) * ex) / den;
      const s2 = ((a.x - p.x) * uy - (a.y - p.y) * ux) / den;
      if (t <= 1e-6 || s2 < 0 || s2 > 1) continue;
      if (t < best) {
        best = t;
        hit = new Pt(p.x + ux * t, p.y + uy * t);
      }
    }
    if (!hit) return;
    if (which === 'start') out.unshift(hit);
    else out.push(hit);
  };
  push('start');
  push('end');
  return out;
}

/**
 * 跨族去重。
 *
 * `traceFamily` 的线距去重哈希是**每族一个**，所以主方向族和次方向族之间
 * 可以贴得很近。靠近红线时两族都会被边界源掰到"顺着边"的方向，于是并排出现
 * 两条相距 10 m 的街 —— 图上就是"两条黑带中间夹一条 4 m 宽的地"。
 * 这里做一次全局去重：按长度从长到短保留，短的那条若有 >45% 的采样点
 * 落在已保留线的 minGap 内，就丢掉。
 */
function dedupeAcrossFamilies(lines: FieldLine[], minGapU: number): FieldLine[] {
  const lenOf = (l: FieldLine): number => {
    let acc = 0;
    for (let i = 0; i + 1 < l.pts.length; i++) acc += Pt.distance(l.pts[i], l.pts[i + 1]);
    return acc;
  };
  /**
   * 判断"p 是否贴在 l 上"。
   *
   * 必须**同时**满足两条：距离 < minGap，且局部方向一致（< 25°）。
   * 只比距离是错的 —— 一条横街上的每个点到竖街的"垂直距离"都很小（几米），
   * 但那是**正交叉**，不是重复。早先只比距离时，F01 的三条纵街被两条横街
   * 全部判成重复删掉了，A 方案只剩一条横街。
   */
  const near = (p: Pt, dir: Pt, l: FieldLine): boolean => {
    let best = Infinity;
    let bestDir: Pt | null = null;
    for (let i = 0; i + 1 < l.pts.length; i++) {
      const a = l.pts[i];
      const b = l.pts[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l2 = dx * dx + dy * dy;
      if (l2 < 1e-12) continue;
      let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
      if (d < best) {
        best = d;
        const len = Math.sqrt(l2);
        bestDir = new Pt(dx / len, dy / len);
      }
    }
    if (best > minGapU || !bestDir) return false;
    const dot = Math.abs(dir.x * bestDir.x + dir.y * bestDir.y);
    return dot > Math.cos((25 * Math.PI) / 180);
  };
  const sorted = lines.slice().sort((a, b) => lenOf(b) - lenOf(a));
  const kept: FieldLine[] = [];
  for (const l of sorted) {
    let hit = 0;
    let total = 0;
    for (let i = 1; i + 1 < l.pts.length; i += 2) {
      const a = l.pts[i - 1];
      const b = l.pts[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const dir = new Pt(dx / len, dy / len);
      total++;
      if (kept.some((k) => near(l.pts[i], dir, k))) hit++;
    }
    if (total > 0 && hit / total > 0.45) continue;
    kept.push(l);
  }
  return kept;
}

/**
 * 族内定级：按**条数**分档，不按长度分位。
 *
 * 长度分位在这里会失控：线少的时候（5~6 条）最长的那一条就占掉 40% 总长度，
 * "主干占 12%" 直接变成"主干占 69%"（R01 实测）。城市里"每隔几条街一条主干"
 * 说的是**条数**，所以改成：最长的一条（或多条）当主干，其次一批当次干。
 */
function gradeByLength(lines: FieldLine[]): void {
  if (lines.length === 0) return;
  const lenOf = (l: FieldLine): number => {
    let acc = 0;
    for (let i = 0; i + 1 < l.pts.length; i++) acc += Pt.distance(l.pts[i], l.pts[i + 1]);
    return acc;
  };
  const idx = lines.map((_, i) => i).sort((a, b) => lenOf(lines[b]) - lenOf(lines[a]));
  const n = idx.length;
  const artN = Math.max(1, Math.round(n * 0.18));
  const colN = Math.max(1, Math.round(n * 0.42));
  idx.forEach((i, rank) => {
    lines[i].cls = (rank < artN ? 'arterial' : rank < artN + colN ? 'collector' : 'local') as FieldLine['cls'];
  });
}
