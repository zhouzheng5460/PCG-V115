// F2.4-D · 游戏级视觉评分
//
// 定这个评分的目的只有一个：**在同一批候选里排出先后**。
// 它不是规划合规检查（那套在 `validate.ts`），也不产生新的硬约束 ——
// 任务书第六节明确要求"只用于候选排序，不把这些分数转换为大量新的硬约束"。
//
// 五项权重（任务书给定）：
//   道路与空间层级 30% / 建筑群组合 30% / 停车·广场·铺装·绿化 20% / 入口连接 10% / 地块变化 10%

import type { SiteComposition } from './types';
import type { SiteScene } from './scene';

export interface VisualScore {
  total: number;
  terms: { k: string; weight: number; raw: number; v: number }[];
  /** 人话结论（进图注与报告） */
  verdict: string;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export function visualScore(c: SiteComposition, scene: SiteScene): VisualScore {
  const m = c.metrics;
  const terms: { k: string; weight: number; raw: number; v: number }[] = [];

  // ---------------- ① 道路与空间层级（30%）
  const roads = c.infra.roads;
  const classes = new Set(roads.map((r) => r.cls));
  const areaM2 = Math.max(1, m.blockM2);
  /** 路网密度：每公顷的通道长度（m/ha）。住宅园区 60~160 是正常区间，0 就是"没有结构" */
  const roadLenM = roads.reduce((s, r) => {
    let t = 0;
    for (let i = 0; i + 1 < r.centerline.length; i++) t += Math.hypot(r.centerline[i + 1].x - r.centerline[i].x, r.centerline[i + 1].y - r.centerline[i].y);
    return s + t * 7;
  }, 0);
  const density = (roadLenM / areaM2) * 10000;
  const densityScore = clamp01(density / 120) * (1 - clamp01((density - 200) / 200));
  const hasHierarchy = classes.size >= 2 ? 1 : classes.size === 1 ? 0.6 : 0;
  // 主干是否连通两处街口（有骨架的路才算"体系"，孤立的尽端路不算）
  const spine = roads.filter((r) => r.cls === 'primary' || r.cls === 'pedestrian' || r.cls === 'service');
  const spineLenM = spine.reduce((s, r) => {
    let t = 0;
    for (let i = 0; i + 1 < r.centerline.length; i++) t += Math.hypot(r.centerline[i + 1].x - r.centerline[i].x, r.centerline[i + 1].y - r.centerline[i].y);
    return s + t * 7;
  }, 0);
  const spineScore = clamp01(spineLenM / 90);
  const roadRaw = 0.5 * densityScore + 0.3 * hasHierarchy + 0.2 * spineScore;
  terms.push({ k: '道路与空间层级', weight: 0.3, raw: roadRaw, v: 0.3 * roadRaw });

  // ---------------- ② 建筑群组合（30%）
  const hs = c.buildings.map((b) => b.heightM);
  const meanH = hs.length ? hs.reduce((a, b) => a + b, 0) / hs.length : 0;
  const sdH = hs.length > 1 ? Math.sqrt(hs.reduce((s, h) => s + (h - meanH) ** 2, 0) / hs.length) : 0;
  const heightVar = clamp01(sdH / Math.max(1, meanH * 0.45));
  // 覆盖度：住宅 22~38%、商业 25~45%、工业 25~45% 为佳，过低空旷、过高窒息
  const target = c.typology === 'retail' ? [0.24, 0.45] : c.typology === 'industrial' ? [0.22, 0.45] : [0.2, 0.38];
  const covScore = bandScore(m.coverage, target[0], target[1], 0.14);
  // 朝向一致性：同一地块内建筑长轴与该地块主轴的一致度
  const orient = 1 - clamp01(m.orientDevDeg / 35);
  // 间距：最小净距 ≥ 6 m 得满分，< 2 m 归零
  const minGap = minBuildingGap(c);
  const gapScore = clamp01((minGap - 2) / 4);
  const buildRaw = 0.3 * heightVar + 0.28 * covScore + 0.22 * orient + 0.2 * gapScore;
  terms.push({ k: '建筑群组合', weight: 0.3, raw: buildRaw, v: 0.3 * buildRaw });

  // ---------------- ③ 停车 / 广场 / 铺装 / 绿化（20%）
  const gGreen = m.greenM2 / areaM2;
  // 绿地不是越多越好：15%~42% 是"有设计感"的区间，> 60% 说明在拿草地充数
  const greenScore = bandScore(gGreen, 0.15, 0.42, 0.16);
  const treeDensity = scene.trees.length / Math.max(1, m.greenM2 / 1000);
  const treeScore = clamp01(treeDensity / 18) * (1 - clamp01((treeDensity - 55) / 60));
  const plazaShare = m.plazaM2 / areaM2;
  const plazaScore = clamp01(plazaShare / 0.06);
  const parkScore = m.stalls > 0 ? clamp01(m.stalls / Math.max(6, m.gfaM2 / 400)) : 0.25;
  const unassigned = clamp01(m.unassignedShare / 0.12);
  const groundRaw = 0.3 * greenScore + 0.22 * treeScore + 0.2 * plazaScore + 0.16 * parkScore + 0.12 * (1 - unassigned);
  terms.push({ k: '停车·广场·铺装·绿化', weight: 0.2, raw: groundRaw, v: 0.2 * groundRaw });

  // ---------------- ④ 入口连接（10%）
  const doors = c.buildings.flatMap((b) => b.doors);
  const reach = doors.length ? doors.filter((d) => d.reachM <= 30).length / doors.length : 0;
  const walkable = c.ground.filter((g) => g.walkable).length > 0 ? 1 : 0.4;
  const doorRaw = 0.7 * reach + 0.3 * walkable;
  terms.push({ k: '入口与主路连接', weight: 0.1, raw: doorRaw, v: 0.1 * doorRaw });

  // ---------------- ⑤ 地块变化（10%）
  const areas = c.parcels.parcels.map((p) => p.candidate.metrics.areaM2);
  const meanA = areas.length ? areas.reduce((a, b) => a + b, 0) / areas.length : 0;
  const sdA = areas.length > 1 ? Math.sqrt(areas.reduce((s, a) => s + (a - meanA) ** 2, 0) / areas.length) : 0;
  const areaVar = clamp01(sdA / Math.max(1, meanA * 0.6));
  const grammars = new Set(c.buildings.map((b) => b.grammar));
  const varietyRaw = 0.55 * areaVar + 0.45 * clamp01(grammars.size / 3);
  terms.push({ k: '地块与形态变化', weight: 0.1, raw: varietyRaw, v: 0.1 * varietyRaw });

  const total = terms.reduce((s, t) => s + t.v, 0);
  const verdict =
    `道路层级 ${(roadRaw * 100).toFixed(0)} · 建筑组合 ${(buildRaw * 100).toFixed(0)} · ` +
    `地面协调 ${(groundRaw * 100).toFixed(0)} · 入口 ${(doorRaw * 100).toFixed(0)} · 变化 ${(varietyRaw * 100).toFixed(0)}`;
  return { total: +total.toFixed(4), terms, verdict };
}

/** 落在 [lo,hi] 得 1，越界按 soft 距离线性衰减 */
function bandScore(v: number, lo: number, hi: number, soft: number): number {
  if (v >= lo && v <= hi) return 1;
  if (v < lo) return clamp01(1 - (lo - v) / Math.max(1e-6, soft));
  return clamp01(1 - (v - hi) / Math.max(1e-6, soft));
}

/** 建筑之间最小净距（米） */
function minBuildingGap(c: SiteComposition): number {
  const bs = c.buildings;
  let best = Infinity;
  for (let i = 0; i < bs.length; i++) {
    for (let j = i + 1; j < bs.length; j++) {
      const a = bs[i];
      const b = bs[j];
      const dc = Math.hypot(a.center.x - b.center.x, a.center.y - b.center.y) * 7;
      if (dc > (Math.max(a.widthM, a.depthM) + Math.max(b.widthM, b.depthM)) / 2 + 8) continue;
      const d = gapBetween(a.surface.outer, b.surface.outer) * 7;
      if (d < best) best = d;
    }
  }
  return Number.isFinite(best) ? best : 99;
}

function gapBetween(a: { x: number; y: number }[], b: { x: number; y: number }[]): number {
  let best = Infinity;
  for (const p of a) {
    for (let i = 0; i < b.length; i++) {
      const q = b[i];
      const r = b[(i + 1) % b.length];
      best = Math.min(best, segDist(p, q, r));
    }
  }
  for (const p of b) {
    for (let i = 0; i < a.length; i++) {
      const q = a[i];
      const r = a[(i + 1) % a.length];
      best = Math.min(best, segDist(p, q, r));
    }
  }
  return best;
}

function segDist(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}
