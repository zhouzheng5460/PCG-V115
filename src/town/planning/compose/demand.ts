// F2.4-C · 功能需求可行性检查
//
// 骨架候选能不能成立，不能只看"几何没压线"。这一层把任务书第二节的六条需求
// 落成可计算的判据，输出 `DemandReport`，供骨架选择与诊断共用：
//
//   D1 每栋建筑主入口经**连续合法通行面**接入公共道路
//   D2 服务入口有对应的服务路径
//   D3 停车构成完整车行链路（车位→通道→场内道路→出入口→外部道路）
//   D4 工业装卸区满足指定车型的可达与转弯（内切圆半径）
//   D5 主要公共空间（>300 m²）有连续步行接入
//   D6 路径使用**实际净宽**，不是端点距离
//
// 关键设计：D1/D2/D5 靠一张**通行面连通图**（节点 = 可通行面，边 = 面积相交），
// 而不是"最近距离 < X"。距离再近，中间隔着一栋楼也走不过去。

import { Pt } from '../../../core/geom';
import {
  distToSurfaceEdge,
  insideSurface,
  pointInRing,
  surfaceArea,
  surfaceIntersect,
  type PlanSurface,
} from '../core/surface';
import type { ComposeNote, GroundPatch, SiteComposition } from './types';

const M2 = (u2: number) => u2 * 49;

export type DemandCode = 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6';

export interface DemandItem {
  code: DemandCode;
  label: string;
  ok: boolean;
  /** 失败或达标的量化说明 */
  detail: string;
  /** 失败时的对象（建筑 / 地块 / 停车区 id） */
  subject?: string;
  at?: Pt;
}

export interface DemandReport {
  ok: boolean;
  items: DemandItem[];
  /** 未通过的类别（去重），便于在诊断表里一眼看出是"哪一类不行" */
  failed: DemandCode[];
  stats: {
    buildings: number;
    doorsChecked: number;
    doorsReachable: number;
    /** 门到最近通行面的距离（米，加权平均） */
    meanDoorGapM: number;
    parkChains: number;
    parkChainsOk: number;
    publicSpaces: number;
    publicSpacesReachable: number;
    /** 最窄的步行通道净宽（米） */
    minWalkWidthM: number;
    /** 装卸区内切圆半径（米），无装卸区为 -1 */
    loadingRadiusM: number;
  };
}

interface Node {
  id: string;
  surface: PlanSurface;
  /** 允许步行 */
  walk: boolean;
  /** 允许车行 */
  drive: boolean;
  label: string;
}

/**
 * 建通行面连通图。
 *
 * 节点来自：内部道路路面、停车铺装与车道、各类铺装/庭院/广场、步行道、绿地（绿地可走，
 * 但不是"合法通行面"—— 绿地节点只作为连通性的**弱势中间节点**，不作为判定终点）。
 * 边 = 两块面的交集面积 > 0.3 m²。
 */
function buildGraph(c: SiteComposition): { nodes: Node[]; adj: number[][]; sources: Set<number> } {
  const nodes: Node[] = [];
  const push = (surface: PlanSurface, walk: boolean, drive: boolean, label: string) => {
    if (surfaceArea(surface) <= 1e-6) return;
    nodes.push({ id: `${nodes.length}`, surface, walk, drive, label });
  };
  /**
   * 街区边缘带（红线内 5.5 m）。
   *
   * 这一条必须显式存在，否则连通性会被"退线带不可走"切断：地块的可通行面到红线
   * 之间还隔着 5 m 建筑退线（住宅是种植带），于是每栋楼的门都判成"接不到公共道路"
   * —— 实测第一版 18/18 樘门全部失败，全部卡在最后 5 m。
   * 现实里红线内侧就是人行道与路缘，它是**公共通行面**，不是私人绿地。
   */
  const edge = edgeBand(c.input.boundary, 5.5);
  if (edge) push(edge, true, true, 'street-edge');
  for (const p of c.parking) push(p.surface, true, true, `park:${p.id}`);
  for (const g of c.ground) {
    const walkable = g.walkable ?? (g.kind !== 'green' && g.kind !== 'planting' && g.kind !== 'planter' && g.kind !== 'unassigned');
    const drivable = g.drivable === true || g.kind === 'driveway' || g.kind === 'loading';
    push(g.surface, walkable, drivable, `ground:${g.kind}:${g.parcelId ?? '-'}`);
  }

  const adj: number[][] = nodes.map(() => []);
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (connected(nodes[i].surface, nodes[j].surface)) {
        adj[i].push(j);
        adj[j].push(i);
      }
    }
  }

  // 源头：与红线贴边（≤2 m）的通行面 —— 它们直接接城市道路
  const sources = new Set<number>();
  const ring = c.input.boundary.outer;
  nodes.forEach((n, i) => {
    if (n.label === 'street-edge') {
      sources.add(i);
      return;
    }
    if (!n.walk) return;
    for (const q of n.surface.outer) {
      if (distToRingU(q, ring) * 7 <= 2.0) {
        sources.add(i);
        return;
      }
    }
  });
  return { nodes, adj, sources };
}

/**
 * 两块通行面是否"接得上"。
 *
 * 只判"交集面积 > 0"是错的：地面层是**逐层切出来**的，相邻两块共享一条边，
 * 交集面积恒为 0 —— 那样整张图会一个边都没有，所有门都判"不连通"
 * （实测第一版就是这样：18/18 樘门全部失败，而门离铺装 0.0 m）。
 * 所以这里补一条"边界相接"判据：任一环顶点到对方边界的距离 < 0.25 单位（1.75 m）。
 */
function connected(a: PlanSurface, b: PlanSurface): boolean {
  try {
    const inter = surfaceIntersect([a], [b]);
    if (inter.some((q) => surfaceArea(q) > 0.3 / 49)) return true;
  } catch {
    /* 交集失败继续用边界判据 */
  }
  for (const p of a.outer) if (distToSurfaceEdge(p, b) < 0.25) return true;
  for (const p of b.outer) if (distToSurfaceEdge(p, a) < 0.25) return true;
  return false;
}

/** 红线内宽 w 米的边缘带（贴边一圈） */
function edgeBand(boundary: PlanSurface, wM: number): PlanSurface | null {
  const inner = insetRingLocal(boundary.outer, wM / 7);
  if (inner.length < 3) return null;
  const holes = [...boundary.holes, inner];
  const outer = boundary.outer;
  if (surfaceArea({ outer, holes }) <= 1e-6) return null;
  return { outer, holes };
}

function insetRingLocal(ring: Pt[], d: number): Pt[] {
  let ccw = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    ccw += a.x * b.y - b.x * a.y;
  }
  const sgn = ccw >= 0 ? 1 : -1;
  const n: { x: number; y: number }[] = [];
  const pts: Pt[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L = Math.hypot(dx, dy);
    if (L < 1e-9) continue;
    n.push({ x: (-dy / L) * sgn, y: (dx / L) * sgn });
    pts.push(a);
  }
  if (pts.length < 3) return [];
  return pts.map((p, i) => {
    const pv = n[(i - 1 + n.length) % n.length];
    const nx = n[i];
    const mx = pv.x + nx.x;
    const my = pv.y + nx.y;
    const ml = Math.hypot(mx, my) || 1;
    const cosHalf = (mx / ml) * nx.x + (my / ml) * nx.y || 1;
    const k = d / Math.max(0.4, cosHalf);
    return new Pt(p.x + (mx / ml) * k, p.y + (my / ml) * k);
  });
}

function distToRingU(p: Pt, ring: Pt[]): number {
  let d = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy || 1;
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    d = Math.min(d, Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)));
  }
  return d;
}

/** 从源头出发能到达的节点集合（可按"是否允许车行"过滤） */
function reachable(adj: number[][], sources: Set<number>, nodes: Node[], need: 'walk' | 'drive'): Set<number> {
  const seen = new Set<number>();
  const queue: number[] = [];
  for (const s of sources) {
    if (need === 'drive' && !nodes[s].drive) continue;
    seen.add(s);
    queue.push(s);
  }
  while (queue.length > 0) {
    const i = queue.pop()!;
    for (const j of adj[i]) {
      if (seen.has(j)) continue;
      if (need === 'drive' && !nodes[j].drive) continue;
      seen.add(j);
      queue.push(j);
    }
  }
  return seen;
}

/** 点是否落在某节点内（或距其边界 ≤ tol 米）—— 门的"落点"判定 */
function nodeAt(nodes: Node[], p: Pt, tolM: number): number[] {
  const out: number[] = [];
  nodes.forEach((n, i) => {
    if (insideSurface(p, n.surface) || distToSurfaceEdge(p, n.surface) * 7 <= tolM) out.push(i);
  });
  return out;
}

export function checkDemand(c: SiteComposition): DemandReport {
  const items: DemandItem[] = [];
  const { nodes, adj, sources } = buildGraph(c);
  const walkSet = reachable(adj, sources, nodes, 'walk');
  const driveSet = reachable(adj, sources, nodes, 'drive');

  const stats = {
    buildings: c.buildings.length,
    doorsChecked: 0,
    doorsReachable: 0,
    meanDoorGapM: 0,
    parkChains: c.parking.length,
    parkChainsOk: 0,
    publicSpaces: 0,
    publicSpacesReachable: 0,
    minWalkWidthM: Infinity,
    loadingRadiusM: -1,
  };

  // ---- D1 主入口 → 公共道路（连续通行面）
  let gapSum = 0;
  let gapN = 0;
  const badD1: string[] = [];
  for (const b of c.buildings) {
    const door = b.doors.find((d) => d.kind === 'main') ?? b.doors.find((d) => d.kind === 'freight') ?? b.doors[0];
    if (!door) continue;
    stats.doorsChecked++;
    // 门点到最近通行面的距离：这是"门口有没有铺装"的直接度量
    let bestGap = Infinity;
    for (const n of nodes) bestGap = Math.min(bestGap, distToSurfaceEdge(door.at, n.surface) * 7);
    gapSum += Number.isFinite(bestGap) ? bestGap : 99;
    gapN++;
    const near = nodeAt(nodes, door.at, 4);
    const ok = near.some((i) => walkSet.has(i));
    if (ok) stats.doorsReachable++;
    else badD1.push(`${b.id}(${bestGap.toFixed(1)}m)`);
  }
  stats.meanDoorGapM = gapN > 0 ? +(gapSum / gapN).toFixed(2) : 0;
  items.push({
    code: 'D1',
    label: '主入口经连续通行面接入公共道路',
    ok: badD1.length === 0,
    detail:
      badD1.length === 0
        ? `${stats.doorsChecked} 樘主入口全部连通（平均离通行面 ${stats.meanDoorGapM} m）`
        : `${badD1.length}/${stats.doorsChecked} 樘主入口不连通：${badD1.slice(0, 4).join(' ')}`,
  });

  // ---- D2 服务入口 → 服务路径（允许车行或服务性通行面）
  const badD2: string[] = [];
  for (const b of c.buildings) {
    for (const d of b.doors.filter((x) => x.kind === 'service' || x.kind === 'freight')) {
      const near = nodeAt(nodes, d.at, 4);
      const ok = near.some((i) => walkSet.has(i) || driveSet.has(i));
      if (!ok) badD2.push(`${b.id}:${d.kind}`);
    }
  }
  items.push({
    code: 'D2',
    label: '服务/货运入口有对应路径',
    ok: badD2.length === 0,
    detail: badD2.length === 0 ? '全部服务入口可经通行面接出' : `${badD2.length} 处服务入口接不出：${badD2.slice(0, 4).join(' ')}`,
  });

  // ---- D3 停车完整链路
  const badD3: string[] = [];
  for (const p of c.parking) {
    const gateOk = p.gate ? nodeAt(nodes, p.gate.at, 4).some((i) => driveSet.has(i)) : false;
    const ok = p.checks.ok && p.checks.aislesConnected >= Math.max(1, p.checks.aisles) && gateOk;
    if (ok) stats.parkChainsOk++;
    else badD3.push(`${p.parcelId}(通道 ${p.checks.aislesConnected}/${p.checks.aisles}${gateOk ? '' : ',车道未接路'})`);
  }
  items.push({
    code: 'D3',
    label: '停车：车位→通道→场内道→出入口→道路',
    ok: badD3.length === 0,
    detail:
      c.parking.length === 0
        ? '无集中停车（本方案未设停车地块）'
        : badD3.length === 0
          ? `${c.parking.length} 处停车链路完整`
          : `${badD3.length}/${c.parking.length} 处链路断裂：${badD3.slice(0, 3).join(' ')}`,
  });

  // ---- D4 装卸区转弯（内切圆半径）
  const loadings = c.ground.filter((g) => g.kind === 'loading');
  let worstR = Infinity;
  for (const g of loadings) worstR = Math.min(worstR, maxInscribedRadius(g.surface));
  stats.loadingRadiusM = Number.isFinite(worstR) ? +worstR.toFixed(1) : -1;
  const needR = c.typology === 'industrial' || c.typology === 'data_center' ? 5.5 : 4;
  items.push({
    code: 'D4',
    label: `装卸/回转区满足车型（内切半径 ≥ ${needR} m）`,
    ok: loadings.length === 0 ? !(c.typology === 'industrial') : worstR >= needR,
    detail:
      loadings.length === 0
        ? c.typology === 'industrial'
          ? '工业地块没有任何装卸区 —— 不可行'
          : '本方案无装卸区'
        : `最大可回转半径 ${stats.loadingRadiusM} m（${loadings.length} 处装卸区）`,
  });

  // ---- D5 公共空间步行接入
  const publics = c.ground.filter((g) => (g.kind === 'plaza' || g.kind === 'courtyard' || g.kind === 'green') && g.areaM2 >= 300);
  const badD5: string[] = [];
  for (const g of publics) {
    stats.publicSpaces++;
    // 该空间内是否有任意点属于可达集合
    const idx = nodeAt(nodes, centroidOf(g.surface.outer), 1);
    const ok = idx.some((i) => walkSet.has(i));
    if (ok) stats.publicSpacesReachable++;
    else badD5.push(`${g.kind}${g.areaM2.toFixed(0)}m²`);
  }
  items.push({
    code: 'D5',
    label: '主要公共空间（≥300 m²）有连续步行接入',
    ok: badD5.length === 0,
    detail:
      publics.length === 0
        ? '无 ≥300 m² 的公共空间'
        : badD5.length === 0
          ? `${publics.length} 处公共空间全部可达`
          : `${badD5.length}/${publics.length} 处不可达：${badD5.slice(0, 3).join(' ')}`,
  });

  // ---- D6 实际净宽
  let minW = Infinity;
  for (const g of c.ground) {
    if (g.kind !== 'footpath' && g.kind !== 'sidewalk' && g.kind !== 'driveway') continue;
    if (g.areaM2 < 40) continue; // 切蛋糕留下的边角条不参与"净宽"统计
    // 半径 < 0.5 m 的"面"是切蛋糕留下的边角条，不是通道 —— 参与统计会把最小净宽压到 0
    const r = maxInscribedRadius(g.surface);
    if (r >= 0.5) minW = Math.min(minW, r * 2);
  }
  for (const r of c.infra.roads) {
    const w = r.carriageM;
    if (w > 0) minW = Math.min(minW, w);
  }
  const hasPath = Number.isFinite(minW);
  stats.minWalkWidthM = hasPath ? +minW.toFixed(1) : 0;
  items.push({
    code: 'D6',
    label: '通行路径按实际净宽（步行 ≥ 1.5 m，车行 ≥ 3.5 m）',
    ok: hasPath && minW >= 1.5,
    detail: hasPath
      ? `最窄通行面净宽 ${stats.minWalkWidthM} m`
      : '整块地没有任何成规模的步行/车行通道面（只有贴建筑的零碎铺装）',
  });

  const failed = Array.from(new Set(items.filter((i) => !i.ok).map((i) => i.code)));
  return { ok: failed.length === 0, items, failed, stats };
}

/** 面的最大内切圆半径（米）——用 clearance 场近似 */
function maxInscribedRadius(s: PlanSurface): number {
  const bb = s.outer.reduce(
    (a, p) => ({ minX: Math.min(a.minX, p.x), minY: Math.min(a.minY, p.y), maxX: Math.max(a.maxX, p.x), maxY: Math.max(a.maxY, p.y) }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  );
  let best = 0;
  const step = 0.5;
  for (let x = bb.minX + step / 2; x < bb.maxX; x += step) {
    for (let y = bb.minY + step / 2; y < bb.maxY; y += step) {
      const p = new Pt(x, y);
      if (!insideSurface(p, s)) continue;
      const d = distToSurfaceEdge(p, s);
      if (d > best) best = d;
    }
  }
  return best * 7;
}

function centroidOf(ring: Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p.x;
    y += p.y;
  }
  return new Pt(x / ring.length, y / ring.length);
}

export type { ComposeNote, GroundPatch };
export { M2, pointInRing };
