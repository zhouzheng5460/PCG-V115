// Typology · Industrial（PRD §6 / §P2.4 / §P2.5 / §P2.6）
//
// 一个 typology 的职责只有三件：
//   ① 给这个行业专用的**权重**（工业最怕客货混行，不看重沿街形象）；
//   ② 给允许出现的 **Ground Program 白名单**（Phase 2 只要功能关系，不要装饰）；
//   ③ 把 Candidate 读数变成 `LayoutDiagnostics`（通用 8 项 + serviceSeparation）。
//
// 它**不生成几何**。几何在 archetypes/industrial/rear-load.ts。

import type { SiteContext } from '../core/types';
import type { LayoutDiagnostics, ScoreWeights } from '../core/types';
import type { GroundProgram, SitePlanCandidate } from '../core/candidate';
import { surfaceArea } from '../core/surface';
import { weightsFor } from '../core/evaluator';

/**
 * 工业权重（PRD §P2.4 给的那一套，补齐 ScoreWeights 的新字段）。
 *
 * 语义：`warehouse → loading → truck court → truck gate` 这一条要干净。
 * 所以 circulation / serviceSeparation / typologyFit 高，frontage / openSpace 低。
 */
export const INDUSTRIAL_WEIGHTS: ScoreWeights = {
  ...weightsFor('industrial'),
  typologyFit: 2.5,
  serviceSeparation: 2.8,
  circulationQuality: 2.5,
  accessClarity: 1.5,
  buildingRegularity: 1.5,
  groundUsability: 1.3,
  parkingQuality: 0.8,
  frontageQuality: 0.8,
  openSpaceQuality: 0.3,
  accessConflict: 3.0,
  deadSpace: 1.5,
  fragmentation: 1.5,
};

/** Phase 2 允许的工业地面程序（PRD §P2.6 的白名单，多一个都算 bug） */
export const INDUSTRIAL_GROUND_WHITELIST: GroundProgram[] = [
  'office_forecourt',
  'employee_parking',
  'landscape_buffer',
  'loading_apron',
  'truck_court',
  'service_lane',
  'utility_yard',
  'residual',
  // S1（场地布局骨架）：**场地内部的机动车主通道**。
  // 复用 `driveway` 而不是新造一个 program —— 它在 ground-ownership 里
  // 已经是优先级最高（100）的 overlay，天然压过绿地和停车，
  // 语义也正是"地块内的车道"。
  'driveway',
];

/**
 * 工业的**强度目标带**（R7.6）。
 *
 * 偏好区间 20~28%，低于 18% 或高于 32% 明显扣分。用它把"建筑盖得越满
 * typologyFit 越高"的系统偏差拧回来 —— 这是 Shadow 里 high 强度永远赢的根因。
 */
export const INDUSTRIAL_INTENSITY = {
  min: 0.16,
  preferredMin: 0.18,
  preferredMax: 0.24,
  max: 0.28,
};

/**
 * 覆盖度拟合（0~1）：落在偏好带内满分，偏离两侧都扣。
 * 不新增 Diagnostic，只折算进现有 `typologyFit`（Freeze §6）。
 */
export function coverageFit(actual: number, band = INDUSTRIAL_INTENSITY): number {
  if (actual >= band.preferredMin && actual <= band.preferredMax) {
    // 带内也轻微偏好"靠中间"：贴上限只给 0.88 分，
    // 否则 24%（贴着 preferredMax）会和 21% 同分，winner 就永远被推向上限
    const center = (band.preferredMin + band.preferredMax) / 2;
    const half = Math.max(0.01, (band.preferredMax - band.preferredMin) / 2);
    return clamp01(1 - (Math.abs(actual - center) / half) * 0.12);
  }
  if (actual < band.preferredMin) {
    const span = Math.max(0.02, band.preferredMin - band.min);
    return clamp01(1 - (band.preferredMin - actual) / span);
  }
  const span = Math.max(0.02, band.max - band.preferredMax);
  return clamp01(1 - ((actual - band.preferredMax) / span) * 0.9);
}

/**
 * 三段式饱和曲线（R7.6 续）。
 *
 * 为什么不用 `min(v / 封顶, 1)`：实测四个候选的 courtRatio 从 7.6% 到 34%，
 * 而 18% 封顶让 24%~34% 全给 1.00 —— 这一项**完全失去区分度**，
 * 于是"货场越大越好"变成了默认前提。
 *
 *   < lo     明显不足（最多 0.35）
 *   lo~knee  快速加分（0.35 → 0.90）
 *   knee~hi  缓慢加分（0.90 → 1.00）
 *   > hi     不再加分，**也不处罚**（大物流项目本来就可能需要更大货场）
 */
function saturate(v: number, lo: number, knee: number, hi: number): number {
  if (v <= lo) return clamp01((v / Math.max(1e-6, lo)) * 0.35);
  if (v <= knee) return 0.35 + ((v - lo) / Math.max(1e-6, knee - lo)) * 0.55;
  if (v <= hi) return 0.9 + ((v - knee) / Math.max(1e-6, hi - knee)) * 0.1;
  return 1;
}

/** 停车的经验目标：员工停车 ≈ 地块面积的 8%（不做法规计算，只看视觉合理性） */
const PARKING_TARGET_RATIO = 0.08;
/** truck court 的最小可用进深（米）——低于这个值大车掉不了头 */
const TRUCK_COURT_MIN_M = 12;

/**
 * 把 Candidate 读成诊断。
 *
 * 每一项都是**几何事实**能算出来的，不含主观判断；差值留给权重去表达。
 */
export function industrialDiagnostics(ctx: SiteContext, c: SitePlanCandidate): LayoutDiagnostics {
  const lotArea = Math.max(1e-6, surfaceArea(ctx.parcel));
  const wh = c.buildings.find((b) => b.role === 'warehouse');
  const truck = c.ground.find((g) => g.program === 'truck_court');
  const apron = c.ground.find((g) => g.program === 'loading_apron');
  const parking = c.ground.find((g) => g.program === 'employee_parking');
  const buffer = c.ground.find((g) => g.program === 'landscape_buffer');
  const residual = c.ground.find((g) => g.program === 'residual');

  // ① 客货分离：车行口与货运口在不在同一条临街面
  const carAcc = c.access.find((a) => a.role === 'car');
  const truckAcc = c.access.find((a) => a.role === 'truck');
  const sharedFrontage = !!carAcc && !!truckAcc && carAcc.frontage === truckAcc.frontage;
  const sepDist = carAcc && truckAcc ? distance(carAcc.at, truckAcc.at) : 0;
  const serviceSeparation = !carAcc || !truckAcc ? 0.2 : sharedFrontage ? (sepDist > 3 ? 0.45 : 0.25) : 1;

  // ② 装卸面是否真的朝 truck court、正立面是否朝主街
  let typologyFit = 0;
  if (wh && truck) {
    const courtCtr = centroid(truck.surface.outer);
    const whCtr = centroid(wh.footprint.outer);
    const toCourt = norm({ x: courtCtr.x - whCtr.x, y: courtCtr.y - whCtr.y });
    const loadDot = wh.loadingSide ? dot(norm({ x: wh.loadingSide.x, y: wh.loadingSide.y }), toCourt) : 0;
    const frontDot = wh.frontSide && ctx.primaryFrontage
      ? dot(norm({ x: wh.frontSide.x, y: wh.frontSide.y }), norm(outwardNormal(ctx.primaryFrontage.parcelEdge, whCtr)))
      : 0;
    // 密度拟合：太稀 / 太密都扣（取代"越满越 fit"的隐式偏好）
    const footprint = Math.abs(shoelace(wh.footprint.outer));
    const densityFit = coverageFit(footprint / lotArea);
    typologyFit = clamp01(
      0.45 * clamp01((loadDot + 1) / 2) + 0.25 * clamp01((frontDot + 1) / 2) + 0.3 * densityFit
    );
  }

  // ③ 物流循环：truck court 进深够不够掉头、apron 在不在
  const courtDepthM = truck ? shortestSideM(truck.surface) : 0;
  const courtRatio = truck ? truck.area / lotArea : 0;
  // 货场：进深 10~20 m 快速加分、30 m 饱和；占比 6%~12% 快速、18% 饱和
  const depthScore = saturate(courtDepthM, 10, 20, 30);
  const ratioScore = saturate(courtRatio, 0.06, 0.12, 0.18);
  const circulationQuality = clamp01(0.5 * depthScore + 0.3 * ratioScore + (apron ? 0.2 : 0));

  // ④ 建筑规整度：矩形度（面积 / 外接矩形）
  const buildingRegularity = wh ? rectness(wh.footprint) : 0;

  // ⑤ 地面可用性：白名单里几个关键程序齐不齐
  const has = (p: GroundProgram) => c.ground.some((g) => g.program === p);
  const keyPrograms = ['office_forecourt', 'employee_parking', 'loading_apron', 'truck_court', 'service_lane'] as const;
  const groundUsability = keyPrograms.filter(has).length / keyPrograms.length;

  // ⑥ 停车：面积是否接近经验目标
  const parkingQuality = clamp01((parking ? parking.area / lotArea : 0) / PARKING_TARGET_RATIO);

  // ⑦ 沿街质量 / 开放空间（工业权重低，但仍要有值）
  const frontageQuality = ctx.primaryFrontage ? ctx.primaryFrontage.score : 0.2;
  const openSpaceQuality = clamp01((buffer ? buffer.area / lotArea : 0) / 0.12);

  // ⑧ 惩罚项
  const deadSpacePenalty = clamp01((residual ? residual.area / lotArea : 0) / 0.25);
  const tinyRegions = c.ground.filter((g) => g.program !== 'residual' && g.area / lotArea < 0.015).length;
  const fragmentationPenalty = clamp01(tinyRegions / 3);
  const accessConflictPenalty = sharedFrontage ? clamp01(1 - sepDist / 4) : 0;

  return {
    accessClarity: clamp01(0.5 * (carAcc ? 1 : 0) + 0.5 * (truckAcc ? 1 : 0)),
    serviceSeparation,
    typologyFit,
    circulationQuality,
    buildingRegularity,
    groundUsability,
    parkingQuality,
    frontageQuality,
    openSpaceQuality,
    deadSpacePenalty,
    fragmentationPenalty,
    accessConflictPenalty,
  };
}

/** 白名单校验：出现白名单外的程序就报出来（Phase 2 的自检） */
export function industrialProgramViolations(c: SitePlanCandidate): GroundProgram[] {
  return c.ground.map((g) => g.program).filter((p) => !INDUSTRIAL_GROUND_WHITELIST.includes(p));
}

// ---------------------------------------------------------------- 局部工具

type Pt = { x: number; y: number };

function centroid(ring: Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p.x;
    y += p.y;
  }
  return { x: x / Math.max(1, ring.length), y: y / Math.max(1, ring.length) };
}

function norm(p: Pt): Pt {
  const l = Math.hypot(p.x, p.y) || 1;
  return { x: p.x / l, y: p.y / l };
}

function dot(a: Pt, b: Pt): number {
  return a.x * b.x + a.y * b.y;
}

/** 从地块中心指向临街边的外法线 */
function outwardNormal(edge: [Pt, Pt], from: Pt): Pt {
  const mid = { x: (edge[0].x + edge[1].x) / 2, y: (edge[0].y + edge[1].y) / 2 };
  return norm({ x: mid.x - from.x, y: mid.y - from.y });
}

function shortestSideM(s: { outer: Pt[] }): number {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of s.outer) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  // 世界单位 → 米（1 单位 ≈ 7 m），取外接矩形短边
  return Math.min(maxX - minX, maxY - minY) * 7;
}

/** 矩形度：面积 / 最小外接矩形面积（用平面外接矩形近似，够用） */
function rectness(s: { outer: Pt[] }): number {
  const a = Math.abs(shoelace(s.outer));
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of s.outer) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const box = (maxX - minX) * (maxY - minY);
  return box > 1e-9 ? clamp01(a / box) : 0;
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

function distance(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}
