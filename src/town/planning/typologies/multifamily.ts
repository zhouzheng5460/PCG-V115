// Typology · Multi-Family（PRD §7 / §P2-MF.9 / §P2-MF.10 / §P2-MF.11）
//
// 和工业**正好相反**的一门语法：
//   工业是"先定生产建筑，再从建筑往外长地面"；
//   住宅是"先定核心院子，再让建筑围着它长"。
//
// 这个文件只做三件事：权重、地面白名单、把 Candidate 读成诊断。
// 几何在 archetypes/multifamily/courtyard.ts。

import { Pt } from '../../../core/geom';
import type { LayoutDiagnostics } from '../core/types';
import type { GroundProgram, SitePlanCandidate } from '../core/candidate';
import { surfaceArea, surfaceIntersect, surfaceUnion, pointInRing } from '../core/surface';
import type { SiteContext } from '../core/types';

/** 住宅权重（PRD §P2-MF.10 的数值，逐项对齐） */
export { weightsFor as mfWeights } from '../core/evaluator';

/** Phase 2 第一版允许的住宅地面程序（PRD §P2-MF.9） */
export const MF_GROUND_WHITELIST: GroundProgram[] = [
  'courtyard',
  'amenity',
  'entrance_forecourt',
  'pedestrian',
  'parking',
  'landscape',
  'service',
  'residual',
  // S1（场地布局骨架）：**场地内部的机动车主通道**。
  // 复用 `driveway` 而不是新造一个 program —— 它在 ground-ownership 里
  // 已经是优先级最高（100）的 overlay，天然压过绿地和停车，
  // 语义也正是"地块内的车道"。
  'driveway',
];

/** 院子最小净尺寸（米）——小于这个值就不是院子，是天井 */
export const COURT_MIN_W_M = 18;
export const COURT_MIN_D_M = 16;
/** 院子长宽比上限：超过就是一条走廊 */
export const COURT_MAX_ASPECT = 2.6;

/**
 * 住宅的**强度目标带**（R7.8）。
 *
 * 围合式多层住宅（6 层 / 18 m）：容积率 1.2~2.6 是可辩护区间，
 * 1.4~2.2 是常态。折算成建筑基底覆盖率就是下面这组数
 * （容积率 = 覆盖率 × 6 层）。
 *
 * 这条带是 MF 的强度靶子 —— 没有它，`typologyFit` 只看围合度，
 * Evaluator 会一路奖励"院子越大越好"，最后选出 11% 覆盖率的方案。
 */
export const MF_INTENSITY = {
  min: 0.2,
  preferredMin: 0.233,
  preferredMax: 0.367,
  max: 0.433,
};

/**
 * 覆盖度拟合（0~1）。
 *
 * 形状和工业 / 零售那两条**故意不同**：工业和零售的候选几乎都落在带内，
 * 曲线在带外那段基本不触发；住宅不行 —— 大地块上围合式方案天然给不出高覆盖率，
 * 用工业那条"带外一路扣到 0"的陡曲线会把所有方案一起压成 0，毫无区分度。
 * 所以这里换成四段缓坡：
 *
 *   < min            0.62 → 0    （覆盖度再低就不是围合式住宅了）
 *   min..prefMin    0.62 → 1.0
 *   prefMin..prefMax  ≈1（偏好靠中间）
 *   prefMax..max    1.0 → 0.12
 *   > max           0
 */
export function mfCoverageFit(actual: number, band = MF_INTENSITY): number {
  const { min, preferredMin, preferredMax, max } = band;
  if (actual >= preferredMin && actual <= preferredMax) {
    const center = (preferredMin + preferredMax) / 2;
    const half = Math.max(0.01, (preferredMax - preferredMin) / 2);
    return clamp01(1 - (Math.abs(actual - center) / half) * 0.12);
  }
  if (actual >= min && actual < preferredMin) {
    return clamp01(0.62 + 0.38 * ((actual - min) / Math.max(1e-6, preferredMin - min)));
  }
  if (actual > preferredMax && actual <= max) {
    return clamp01(1 - 0.88 * ((actual - preferredMax) / Math.max(1e-6, max - preferredMax)));
  }
  return clamp01(0.62 * (actual / Math.max(1e-6, min)));
}

/**
 * 住宅诊断。
 *
 * 三个通用项在这里第一次被真正用上：
 *   · spatialCoreQuality —— 院子够不够大、形状正不正、围合度离目标多远；
 *   · pedestrianClarity  —— 街 → 入口 → 院子的序列有没有被停车切断；
 *   · enclosureRatio     —— 院子周长被建筑贴住的比例（目标值随 archetype 变）。
 */
export function mfDiagnostics(
  ctx: SiteContext,
  c: SitePlanCandidate,
  opts: { targetEnclosure?: number } = {}
): LayoutDiagnostics {
  const lotArea = Math.max(1e-6, surfaceArea(ctx.parcel));
  // 院子**不是一个面**，是一个域：草坪被院内步道切成几块，但它们在规划上
  // 仍然是同一个院子。诊断必须按"院子域 = 草坪 ∪ 院内步道"来读，
  // 否则拿第一块草坪去量围合度，切得越规整分越低 —— 度量在惩罚正确做法。
  const courtParts = c.ground.filter((g) => g.program === 'courtyard');
  const courtWalks = c.ground.filter((g) => g.program === 'pedestrian');
  const courtDomain = courtParts.length
    ? surfaceUnion([...courtParts.map((g) => g.surface), ...courtWalks.map((g) => g.surface)])
    : [];
  // 草坪净面积（不含步道）—— 开放空间率要的是这个
  const courtLawn = courtParts.reduce((a, g) => a + g.area, 0);
  const court = courtParts[0] ?? null;
  const parking = c.ground.find((g) => g.program === 'parking');
  const fore = c.ground.find((g) => g.program === 'entrance_forecourt');
  const amenity = c.ground.find((g) => g.program === 'amenity');
  const land = c.ground.filter((g) => g.program === 'landscape');
  const residual = c.ground.find((g) => g.program === 'residual');
  const target = opts.targetEnclosure ?? 0.9;

  // ① 围合度：沿院子域的周长**等距采样**，每个探针向外 0.45 单位看是否落在建筑里。
  //
  //   原来每条边只取一个中点 —— 加了 5 m 入口门洞之后，门洞正好开在临街边的
  //   正中，一个中点就把"有楼但中间有门"误判成"这一侧完全没围合"。
  //   采样步长 4 m，门洞只占它该占的比例。
  let enclosed = 0;
  let samples = 0;
  if (courtDomain.length > 0) {
    // 每 4 m 一个探针（7 m 一个世界单位）
    const stepLen = 4 / 7;
    for (const dom of courtDomain) {
      const ring = dom.outer;
      if (ring.length < 3) continue;
      const ctr = centroid(ring);
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (len < 1e-9) continue;
        const k = Math.max(1, Math.round(len / stepLen));
        for (let j = 0; j < k; j++) {
          const t = (j + 0.5) / k;
          const mid = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
          const n = norm(new Pt(mid.x - ctr.x, mid.y - ctr.y));
          const probe = { x: mid.x + n.x * 0.45, y: mid.y + n.y * 0.45 };
          if (c.buildings.some((bld) => pointInRing(new Pt(probe.x, probe.y), bld.footprint.outer))) enclosed++;
          samples++;
        }
      }
    }
    enclosed = samples > 0 ? enclosed / samples : 0;
  }

  // ② 院子质量 = 尺寸富余 + 形状 + 围合（离目标越近越好）
  let spatialCoreQuality = 0;
  if (courtDomain.length > 0) {
    const b = bbox(courtDomain.flatMap((d) => d.outer));
    const wM = (b.maxX - b.minX) * 7;
    const dM = (b.maxY - b.minY) * 7;
    const size = clamp01(Math.min(wM / COURT_MIN_W_M, dM / COURT_MIN_D_M) / 2);
    const aspect = Math.max(wM, dM) / Math.max(1e-6, Math.min(wM, dM));
    const shape = clamp01(1 - (aspect - 1) / (COURT_MAX_ASPECT - 1));
    const encl = clamp01(1 - Math.abs(enclosed - target) / 0.45);
    spatialCoreQuality = clamp01(0.3 * size + 0.25 * shape + 0.45 * encl);
  }

  // ③ 人行清晰度：入口到院子中心的直线有没有被停车切掉
  let pedestrianClarity = 0;
  const ped = c.access.find((a) => a.role === 'pedestrian');
  const domainBig = courtDomain.length
    ? courtDomain.reduce((a, b) => (surfaceArea(a) >= surfaceArea(b) ? a : b))
    : null;
  if (ped && domainBig) {
    const ctr = centroid(domainBig.outer);
    const steps = 12;
    let blocked = 0;
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const p = { x: ped.at.x + (ctr.x - ped.at.x) * t, y: ped.at.y + (ctr.y - ped.at.y) * t };
      if (parking && pointInRing(new Pt(p.x, p.y), parking.surface.outer)) blocked++;
    }
    pedestrianClarity = clamp01(1 - blocked / (steps - 1));
    if (fore) pedestrianClarity = clamp01(pedestrianClarity + 0.15);
    if (c.ground.some((g) => g.program === 'pedestrian')) pedestrianClarity = clamp01(pedestrianClarity + 0.1);
  }

  // ④ 建筑规整度：各条 bar 的矩形度平均
  const bars = c.buildings.filter((b) => b.role === 'house' || b.role === 'podium');
  const buildingRegularity = bars.length === 0 ? 0 : average(bars.map((b) => rectness(b.footprint)));

  // ⑤ 地面可用性 / 停车 / 沿街 / 开放空间
  const has = (p: GroundProgram) => c.ground.some((g) => g.program === p);
  const key = ['courtyard', 'entrance_forecourt', 'parking', 'landscape'] as const;
  const groundUsability = key.filter(has).length / key.length;

  const parkRatio = parking ? parking.area / lotArea : 0;
  // 停车太少的扣分交给 parkingQuality 低，太多则靠前端限制；这里只判"是否在合理区间"
  const parkingQuality = clamp01(parkRatio < 0.05 ? parkRatio / 0.05 * 0.5 : 1 - Math.max(0, parkRatio - 0.22) / 0.2);

  const frontageQuality = ctx.primaryFrontage ? ctx.primaryFrontage.score : 0.2;
  const openSpaceQuality = clamp01(
    (courtLawn + (amenity?.area ?? 0) + land.reduce((a, g) => a + g.area, 0)) / lotArea / 0.3
  );

  // ⑥ 惩罚
  const deadSpacePenalty = clamp01((residual ? residual.area / lotArea : 0) / 0.22);
  // "碎片"只统计**窄缝**，不统计"面积小但规整"的功能面。
  //
  // 旧口径 `area/lotArea < 0.012 就计一次` 把前场、服务带、端头绿化这些
  // **有意为之**的小面全算成碎片：在 -312:429 这类大地块上，balanced 形态
  // 拿到 4 个"碎片"→ 惩罚满分 1.00，而稀疏的 asymmetric 只有 2 个 → 0.67，
  // 于是 Evaluator 反而选中了 13% 覆盖率的方案。
  // 真正的"切碎"是那种又窄又长的缝：短边 < 3 m。
  const tiny = c.ground.filter(
    (g) => g.program !== 'residual' && shortestSideM(g.surface.outer) < 3
  ).length;
  const fragmentationPenalty = clamp01(tiny / 3);
  // 窄条：残地短边不足 3 m 就惩罚（住宅最怕院子边被切一条缝）
  const narrowResidualPenalty = residual ? clamp01((3 - shortestSideM(residual.surface.outer)) / 3) : 0;

  // ⑦ 客货冲突：车行口压在主入口 4 单位内、或停车占满主街正面
  const car = c.access.find((a) => a.role === 'car');
  let accessConflictPenalty = 0;
  if (car && ped && dist(car.at, ped.at) < 4) accessConflictPenalty = 0.6;
  if (parking && ctx.primaryFrontage) {
    // 停车区是否压在主临街面上
    const [pa, pb] = ctx.primaryFrontage.parcelEdge;
    const mid = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
    if (pointInRing(new Pt(mid.x, mid.y), parking.surface.outer)) accessConflictPenalty = Math.max(accessConflictPenalty, 0.9);
  }

  const serviceSeparation = car ? (car.frontage === 'primary' ? 0.5 : 0.9) : 0.2;

  // ⑦ 开发强度（FAR 口径）：围合式住宅必须有"体量"，否则院子再大也是空地
  const buildingArea = c.buildings.reduce((a, b) => a + surfaceArea(b.footprint), 0);
  const coverageFit = mfCoverageFit(buildingArea / lotArea);

  return {
    accessClarity: clamp01((ped ? 0.6 : 0) + (car ? 0.4 : 0)),
    spatialCoreQuality,
    pedestrianClarity,
    enclosureRatio: enclosed,
    serviceSeparation,
    // 围合度（空间像不像院子） + 强度（体量够不够）两条腿，缺一条都会跑偏
    typologyFit: court ? clamp01(0.45 * (0.5 + 0.5 * enclosed) + 0.55 * coverageFit) : 0,
    circulationQuality: clamp01(0.5 + (fore ? 0.3 : 0) + (c.ground.some((g) => g.program === 'pedestrian') ? 0.2 : 0)),
    buildingRegularity,
    groundUsability,
    parkingQuality,
    frontageQuality,
    openSpaceQuality,
    deadSpacePenalty,
    fragmentationPenalty,
    narrowResidualPenalty,
    accessConflictPenalty,
  };
}

/** 白名单校验 */
export function mfProgramViolations(c: SitePlanCandidate): GroundProgram[] {
  return c.ground.map((g) => g.program).filter((p) => !MF_GROUND_WHITELIST.includes(p));
}

/** 院子与停车是否重叠（生成器的自检，测试也会用） */
export function courtOverlapsParking(c: SitePlanCandidate): number {
  const court = c.ground.find((g) => g.program === 'courtyard');
  const parking = c.ground.find((g) => g.program === 'parking');
  if (!court || !parking) return 0;
  return surfaceIntersect([court.surface], [parking.surface]).reduce((a, q) => a + surfaceArea(q), 0);
}

// ---------------------------------------------------------------- 工具

function bbox(ring: Pt[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of ring) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
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

function norm(p: Pt): Pt {
  const l = Math.hypot(p.x, p.y) || 1;
  return new Pt(p.x / l, p.y / l);
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function average(v: number[]): number {
  return v.length === 0 ? 0 : v.reduce((a, b) => a + b, 0) / v.length;
}

function rectness(s: { outer: Pt[] }): number {
  const b = bbox(s.outer);
  const box = (b.maxX - b.minX) * (b.maxY - b.minY);
  if (box < 1e-9) return 0;
  return clamp01(Math.abs(shoelace(s.outer)) / box);
}

function shoelace(ring: Pt[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

function shortestSideM(ring: Pt[]): number {
  const b = bbox(ring);
  return Math.min(b.maxX - b.minX, b.maxY - b.minY) * 7;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}
