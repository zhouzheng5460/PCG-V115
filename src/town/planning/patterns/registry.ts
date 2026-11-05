// Pattern Registry · 从真实地块量出 SiteMeasurements，再用类型库自带的 ranker 选 2~3 套
//
// ## 这一层只做"选结构"，不做几何
//
// 29 种骨架全部带有 `implementation.state = 'declarative_only'` 与
// `notProductionReady: true` —— 它们描述的是**空间组织规则**，不是可执行几何。
// 所以这里选出来的东西只能映射到**已有 S1 Builder 能产出的那几种结构**上，
// data-only 的模式一律不进生产候选（见 `mapToSpec`）。
//
// ## 为什么不能直接用 bbox
//
// 类型库的 `fit` 全是真实多边形口径（`areaNote` 里写死了"不要用 bbox 冒充"）。
// 三个 Golden 里 MF 的 bbox 面积是地块的 2.4 倍，用 bbox 会把它判成"大地块"，
// 于是选到需要 6000 m² 的多组团模式 —— 而它实际只有 22391 m² 且是斜带。
// 所以 `effectiveWidth` 用**沿主轴各进深的横截面中位数**，`concavity` 用
// 面积 / 凸包面积。

import type { SiteContext } from '../core/types';
import type { SiteMeasurements, PatternRanking, SkeletonCatalogue } from './skeleton-types';
import { selectSkeletons } from './ranker';
import catalogueJson from './site-skeleton-patterns.json';
import parkingJson from './parking-patterns.json';
import type { ParkingCatalogue } from './skeleton-types';

export const CATALOGUE = catalogueJson as unknown as SkeletonCatalogue;
export const PARKING_CATALOGUE = parkingJson as unknown as ParkingCatalogue;

/** 局部系下的横截面（与 S1 skeleton/spec 里的 crossSection 同义，但只在这里用一次） */
function crossWidth(ring: { x: number; y: number }[], ang: number, t: number): number {
  const cs = Math.cos(ang);
  const sn = Math.sin(ang);
  const us: number[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    // 投影到"法线方向 = t"的那条扫描线上，求它与各边的交点参数 u
    const av = -a.x * sn + a.y * cs;
    const bv = -b.x * sn + b.y * cs;
    if ((av - t) * (bv - t) > 0) continue;
    if (Math.abs(bv - av) < 1e-12) continue;
    const k = (t - av) / (bv - av);
    us.push(a.x * cs + a.y * sn + k * (b.x - a.x) * cs + k * (b.y - a.y) * sn);
  }
  if (us.length < 2) return 0;
  return Math.max(...us) - Math.min(...us);
}

/** 凸包面积（Andrew monotone chain），用于凹度 */
function hullArea(ring: { x: number; y: number }[]): number {
  const pts = [...ring].sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  if (pts.length < 3) return 0;
  const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: { x: number; y: number }[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: { x: number; y: number }[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  let a2 = 0;
  for (let i = 0; i < hull.length; i++) {
    const p = hull[i];
    const q = hull[(i + 1) % hull.length];
    a2 += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a2 / 2);
}

function polyArea(ring: { x: number; y: number }[]): number {
  let a2 = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a2 += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a2 / 2);
}

/** 从 SiteContext 量出类型库需要的 6 个指标（**全部来自真实多边形**） */
export function measureSite(ctx: SiteContext): SiteMeasurements & { detail: string } {
  const ring = ctx.buildableArea.outer;
  const areaU = polyArea(ring);
  const areaM2 = areaU * 49;

  // 主轴：有临街面就用临街方向，否则用最长边
  const f = ctx.primaryFrontage;
  const ang = f
    ? Math.atan2(f.parcelEdge[1].y - f.parcelEdge[0].y, f.parcelEdge[1].x - f.parcelEdge[0].x)
    : ctx.orientation;

  // 有效宽度：沿进深方向取 9 个横截面，用**中位数**（不是最大值）
  const nx = -Math.sin(ang);
  const ny = Math.cos(ang);
  let vmin = Infinity;
  let vmax = -Infinity;
  for (const p of ring) {
    const v = p.x * nx + p.y * ny;
    if (v < vmin) vmin = v;
    if (v > vmax) vmax = v;
  }
  const ws: number[] = [];
  for (let i = 1; i <= 9; i++) {
    const t = vmin + ((vmax - vmin) * i) / 10;
    const w = crossWidth(ring, ang, t);
    if (w > 0) ws.push(w);
  }
  ws.sort((a, b) => a - b);
  const effW = ws.length ? ws[Math.floor(ws.length / 2)] * 7 : 0;

  const hullU = hullArea(ring);
  const concavity = hullU > 1e-9 ? Math.max(0, Math.min(1, 1 - areaU / hullU)) : 0;

  // 长宽比：沿主轴的外接长度 / 有效宽度
  let umin = Infinity;
  let umax = -Infinity;
  const ux = Math.cos(ang);
  const uy = Math.sin(ang);
  for (const p of ring) {
    const u = p.x * ux + p.y * uy;
    if (u < umin) umin = u;
    if (u > umax) umax = u;
  }
  const spanM = (umax - umin) * 7;
  const aspect = effW > 0.1 ? Math.max(spanM / effW, effW / spanM) : 1;

  const frontageCount = [ctx.primaryFrontage, ctx.secondaryFrontage, ctx.serviceFrontage].filter(Boolean).length;

  return {
    typology: ctx.typology as SiteMeasurements['typology'],
    areaM2,
    effectiveWidthM: effW,
    aspectRatio: +aspect.toFixed(2),
    concavity: +concavity.toFixed(3),
    frontageCount,
    hasHoles: ctx.buildableArea.holes.length > 0,
    detail: `地块 ${areaM2.toFixed(0)} m² · 有效宽 ${effW.toFixed(0)} m · 长宽比 ${aspect.toFixed(2)} · 凹度 ${(concavity * 100).toFixed(0)}% · 临街面 ${frontageCount}`,
  };
}

export interface PatternPick extends PatternRanking {
  /** 映射到哪个 S1 结构；null = 纯数据，没有对应几何能力 */
  specId: string | null;
}

/**
 * Pattern → S1 结构的映射表。
 *
 * 只列**已经能出几何**的那几条。29 种里目前 6 种有对应 Builder，
 * 其余是 data-only：它们会被 `selectSkeletons` 选出来（作为"应该长什么样"的说明），
 * 但 `specId = null`，不进入生产候选。
 */
export const PATTERN_TO_SPEC: Record<string, string> = {
  mf_perimeter_court: 'sk-mf-court',
  mf_internal_garden: 'sk-mf-rows',
  mf_external_rows: 'sk-mf-rows',
  mf_single_side_spine: 'sk-mf-rows',
  retail_frontage_rear_park: 'sk-ret-rear-park',
  retail_strip_shared_park: 'sk-ret-rear-park',
  retail_anchor_parking_court: 'sk-ret-front-park',
  ind_single_loaded: 'sk-ind-front-wh',
  ind_mixed_yard: 'sk-ind-rear-yard',
  ind_infill_side: 'sk-ind-front-wh',
  ind_perimeter_compound: 'sk-ind-front-wh',
};

/** 选 2~3 套骨架（纯数据初筛，不做几何） */
export function selectPatterns(ctx: SiteContext, max = 3): { measure: SiteMeasurements; picks: PatternPick[] } {
  const measure = measureSite(ctx);
  const ranked = selectSkeletons(CATALOGUE, measure, max);
  return {
    measure,
    picks: ranked.map((r) => ({ ...r, specId: PATTERN_TO_SPEC[r.id] ?? null })),
  };
}

/** 8 种停车 Pattern 与两套 provider 的能力映射（报告用） */
export function parkingPatternSupport(): { id: string; label: string; provider: 'legacy' | 'placemaker' | 'both' | 'none'; note: string }[] {
  return PARKING_CATALOGUE.patterns.map((p) => {
    const irregular = p.siteFit.acceptsIrregularPolygon;
    const multiAxis = p.layout.allowMultiAxis;
    const angled = p.layout.rowMode === 'angled';
    // 结论来自实测，不是目录声明：
    //  · legacy 只能排矩形网格，斜列只支持固定角（30/45/60/90），多轴不支持
    //  · placemaker 支持任意多边形与多轴（楔形/L 形/障碍物都已实测出图）
    const legacyOk = !multiAxis && !irregular && !angled;
    const pmOk = true;
    const provider = legacyOk && pmOk ? 'both' : pmOk ? 'placemaker' : 'none';
    const note = [
      irregular ? '任意多边形' : '偏矩形',
      multiAxis ? '多轴' : '单轴',
      angled ? '斜列' : '正交/斜列可选',
      p.layout.greenIslands ? '含景观岛' : '无景观岛',
    ].join(' · ');
    return { id: p.id, label: p.labelZh, provider, note };
  });
}
