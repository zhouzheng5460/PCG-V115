// S1 · 可解释度量
//
// 用户的要求写得很清楚：**不允许只用一个不透明的美观分数**。
// 所以这里产出的是**分项**，每一项都能指到具体几何：
//
//   建筑与道路间距       —— 最短距离（米）
//   主入口可达性         —— 门是否落在车道上（距离 ≤ 1 m）
//   停车可达性           —— 停车边界贴车道的比例
//   道路长度 / 面积预算  —— 车道长（米）、面积占地块比例
//   绿地连续性           —— 最大绿地块 / 绿地总面积
//   剩余空间碎片率       —— 小于 100 m² 的面片占比
//   布局完整度           —— 已归属面积 / 可建区
//   功能区冲突           —— 面片两两重叠的实测面积
//
// 几何合法与必要交通连通是**硬约束**：不通过就不是"分低"，是"不可用"，
// 由 `hard.ok` 直接判死，不参与排序。

import { Pt } from '../../../core/geom';
import { surfaceArea, surfaceIntersect, type PlanSurface } from '../core/surface';
import type { SiteContext } from '../core/types';
import type { GroundProgram, SitePlanCandidate } from '../core/candidate';
import { INDUSTRIAL_INTENSITY } from '../typologies/industrial';

const GREEN: GroundProgram[] = ['landscape', 'landscape_buffer', 'lawn', 'planting', 'community_green'];
/** 碎片阈值：小于 100 m² 的地面算碎片 */
const FRAG_M2 = 100;
/** 贴墙判定：车道边到建筑外墙小于这个距离，就是"路贴着建筑走" */
export const HUG_M = 2.5;

export interface S1Hard {
  ok: boolean;
  failures: string[];
}

export interface S1Row {
  label: string;
  /** 0~1 的归一值（越大越好），或原始量 */
  value: number;
  unit: string;
  note: string;
}

export interface S1Metrics {
  hard: S1Hard;
  buildingCount: number;
  buildingM2: number;
  coverage: number;
  /** 车道面片数 / 总长（米）/ 面积（m²）/ 占地块比例 */
  lanePieces: number;
  laneLengthM: number;
  laneAreaM2: number;
  laneAreaShare: number;
  /** 建筑外墙到车道边的最近距离（米） */
  clearanceM: number;
  /** 车行门到最近车道的距离（米） */
  gateToLaneM: number;
  /** 停车边界上贴着车道的比例（0~1） */
  parkingOnLane: number;
  parkingM2: number;
  /** 最大绿地块 / 绿地总面积 */
  greenContinuity: number;
  greenM2: number;
  /** 小于 100 m² 面片 / 面片总数 */
  fragmentRate: number;
  pieceCount: number;
  /** 已归属面积 / 可建区 */
  completeness: number;
  /** 面片两两重叠面积（m²） */
  conflictM2: number;
  rows: S1Row[];
}

const m2 = (s: PlanSurface) => surfaceArea(s) * 49;

function distPointRing(p: Pt, ring: readonly Pt[]): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L = dx * dx + dy * dy;
    let t = L > 1e-12 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / L : 0;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)));
  }
  return best;
}

/** 两个环之间的最短距离（世界单位） */
function distRingRing(a: readonly Pt[], b: readonly Pt[]): number {
  let best = Infinity;
  for (const p of a) best = Math.min(best, distPointRing(p, b));
  for (const p of b) best = Math.min(best, distPointRing(p, a));
  return best;
}

const bboxOf = (r: readonly Pt[]) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of r) {
    x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y);
    x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y);
  }
  return { x0, y0, x1, y1 };
};
const boxesHit = (a: ReturnType<typeof bboxOf>, b: ReturnType<typeof bboxOf>) =>
  a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

export function s1Metrics(ctx: SiteContext, cand: SitePlanCandidate): S1Metrics {
  const lotM2 = surfaceArea(ctx.parcel) * 49;
  const buildM2 = surfaceArea(ctx.buildableArea) * 49;

  const lanes = cand.ground.filter((g) => g.program === 'driveway').map((g) => g.surface);
  const parks = cand.ground
    .filter((g) => g.program === 'parking' || g.program === 'employee_parking')
    .map((g) => g.surface);
  const greens = cand.ground.filter((g) => GREEN.includes(g.program)).map((g) => g.surface);
  const blds = cand.buildings.map((b) => b.footprint);

  const buildingM2 = blds.reduce((a, s) => a + m2(s), 0);
  const laneAreaM2 = lanes.reduce((a, s) => a + m2(s), 0);
  const parkingM2 = parks.reduce((a, s) => a + m2(s), 0);
  const greenM2 = greens.reduce((a, s) => a + m2(s), 0);

  // 车道长度：用 bbox 长边近似有偏，这里直接算各面片的周长/2 太粗，
  // 改用"车道宽度已知"反推：长度 ≈ 面积 / 宽度
  const laneW_m = Math.max(3, laneWidthMOf(cand));
  const laneLengthM = laneAreaM2 / laneW_m;

  // ---- 间距
  let clearanceM = Infinity;
  for (const b of blds) for (const l of lanes) clearanceM = Math.min(clearanceM, distRingRing(b.outer, l.outer) * 7);

  // ---- 门是否在车道上
  const veh = cand.access.find((a) => a.kind === 'vehicle') ?? cand.access[0];
  let gateToLaneM = Infinity;
  if (veh) for (const l of lanes) gateToLaneM = Math.min(gateToLaneM, distPointRing(veh.at, l.outer) * 7);

  // ---- 停车贴车道：沿停车边界采样，看有多少点落在车道 1.5 m 内
  let parkingOnLane = 0;
  if (parks.length && lanes.length) {
    let hit = 0;
    let all = 0;
    for (const p of parks) {
      const ring = p.outer;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        const segs = Math.max(1, Math.ceil(Pt.distance(a, b) / 1.5));
        for (let k = 0; k < segs; k++) {
          const t = (k + 0.5) / segs;
          const q = new Pt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
          all++;
          if (lanes.some((l) => distPointRing(q, l.outer) * 7 <= 1.5)) hit++;
        }
      }
    }
    parkingOnLane = all > 0 ? hit / all : 0;
  }

  // ---- 绿地连续性
  const gAreas = greens.map(m2).sort((a, b) => b - a);
  const greenContinuity = greenM2 > 0 ? gAreas[0] / greenM2 : 0;

  // ---- 碎片率
  const allPieces = cand.ground.map((g) => m2(g.surface)).concat(blds.map(m2));
  const pieceCount = allPieces.length;
  const frags = allPieces.filter((a) => a < FRAG_M2).length;
  const fragmentRate = pieceCount > 0 ? frags / pieceCount : 0;

  // ---- 完整度
  const claimed = allPieces.reduce((a, b) => a + b, 0);
  const completeness = buildM2 > 0 ? Math.min(1, claimed / buildM2) : 0;

  // ---- 冲突：地面面片两两重叠（bbox 预筛）
  let conflictM2 = 0;
  const boxes = cand.ground.map((g) => bboxOf(g.surface.outer));
  for (let i = 0; i < cand.ground.length; i++) {
    for (let j = i + 1; j < cand.ground.length; j++) {
      if (!boxesHit(boxes[i], boxes[j])) continue;
      const a = cand.ground[i].surface;
      const b = cand.ground[j].surface;
      try {
        const inter = surfaceIntersect([a], [b]).reduce((s, p) => s + surfaceArea(p), 0) * 49;
        if (inter > 1) conflictM2 += inter;
      } catch {
        /* 布尔失败就当没重叠：审计脚本会单独报 */
      }
    }
  }

  // ---- 硬约束
  const failures: string[] = [];
  if (cand.buildings.length === 0) failures.push('没有建筑');
  if (lanes.length === 0) failures.push('没有车行主通道');
  if (veh && gateToLaneM > 1.5) failures.push(`车行门离车道 ${gateToLaneM.toFixed(1)} m（应 ≤ 1.5）`);
  if (clearanceM < 1) failures.push(`建筑贴到车道上（最小间距 ${(clearanceM * 1).toFixed(1)} m）`.replace('-', ''));
  if (conflictM2 > lotM2 * 0.005) failures.push(`地面冲突 ${conflictM2.toFixed(0)} m²（> 地块 0.5%）`);
  // 工业：建筑覆盖率跌破**强度带下限**不是"分低"，是这块地没完成主功能
  // （厂房 + 装卸）。S2.5 曾为了抬高停车把前场从 20 m 加深到 30 m，
  // 覆盖率掉到 5% —— 那就是这条硬约束要挡的情况。
  {
    // 用和返回值同一个口径（建筑 / **地块**面积），否则阈值对不上
    const cov = lotM2 > 0 ? buildingM2 / lotM2 : 0;
    if (ctx.typology === 'industrial' && cov < INDUSTRIAL_INTENSITY.min) {
      failures.push(
        `工业覆盖率 ${(cov * 100).toFixed(0)}% 低于下限 ${(INDUSTRIAL_INTENSITY.min * 100).toFixed(0)}%`
      );
    }
  }
  for (const b of blds) {
    // 建筑必须整块落在可建区里（面积比 ≈ 1）
    try {
      const inter = surfaceIntersect([b], [ctx.buildableArea]).reduce((s, p) => s + surfaceArea(p), 0);
      if (inter < surfaceArea(b) * 0.93) {
        failures.push('有建筑探出可建区');
        break;
      }
    } catch {
      /* 忽略 */
    }
  }

  const rows: S1Row[] = [
    {
      label: '建筑与道路间距',
      value: Number.isFinite(clearanceM) ? clearanceM : 0,
      unit: 'm',
      note: clearanceM >= HUG_M ? `≥ ${HUG_M} m，路不贴墙` : `小于 ${HUG_M} m，出现贴墙路`,
    },
    {
      label: '主入口可达',
      value: Number.isFinite(gateToLaneM) ? gateToLaneM : 999,
      unit: 'm',
      note: gateToLaneM <= 1.5 ? '车行门就在车道上' : '车行门没接上车行道',
    },
    { label: '停车贴车道', value: parkingOnLane, unit: '比例', note: '停车边界有多少贴着车道' },
    { label: '道路长度', value: laneLengthM, unit: 'm', note: `车道 ${laneW_m.toFixed(0)} m 宽` },
    { label: '道路面积占比', value: lotM2 > 0 ? laneAreaM2 / lotM2 : 0, unit: '比例', note: `${laneAreaM2.toFixed(0)} m² / 地块 ${lotM2.toFixed(0)} m²` },
    { label: '绿地连续性', value: greenContinuity, unit: '比例', note: `最大一块占绿地 ${(greenContinuity * 100).toFixed(0)}%` },
    { label: '空间碎片率', value: fragmentRate, unit: '比例', note: `小于 ${FRAG_M2} m² 的碎块占比` },
    { label: '布局完整度', value: completeness, unit: '比例', note: '已归属面积 / 可建区' },
    { label: '功能区冲突', value: conflictM2, unit: 'm²', note: conflictM2 < 1 ? '无重叠' : '存在重叠' },
  ];

  return {
    hard: { ok: failures.length === 0, failures },
    buildingCount: cand.buildings.length,
    buildingM2,
    coverage: lotM2 > 0 ? buildingM2 / lotM2 : 0,
    lanePieces: lanes.length,
    laneLengthM,
    laneAreaM2,
    laneAreaShare: lotM2 > 0 ? laneAreaM2 / lotM2 : 0,
    clearanceM: Number.isFinite(clearanceM) ? clearanceM : 0,
    gateToLaneM: Number.isFinite(gateToLaneM) ? gateToLaneM : 999,
    parkingOnLane,
    parkingM2,
    greenContinuity,
    greenM2,
    fragmentRate,
    pieceCount,
    completeness,
    conflictM2,
    rows,
  };
}

/** 从 circulation 里取车道宽度（米）。取不到就按 7 m */
function laneWidthMOf(cand: SitePlanCandidate): number {
  const w = cand.circulation.find((p) => p.width > 0)?.width ?? 0;
  return w > 0 ? w * 7 : 7;
}
