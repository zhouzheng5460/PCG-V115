// F2.4-B · 街区总平面合成 —— 主流程
//
// 阶段 A 在这里落地：骨架 × 分割的**组合候选**，每个组合都真跑一次分割，
// 用同一把尺子打分，选一个，然后把结果整理成 `ParcelPlan[]`（含用途分配）。
//
// 为什么"组合"而不是"先骨架后分割"：
//   同一条脊，切成 8 块和切成 14 块，接入质量完全不同；反过来，
//   同一套分割参数，有脊和没脊的结果也不是"多了条路"那么简单。
//   两者必须放在一起评，否则"骨架好不好"这件事就无从判断。

import { Pt } from '../../../core/geom';
import { surfaceArea, surfaceIntersect, surfaceSubtract, surfaceUnion, type PlanSurface } from '../core/surface';
import type { SiteRoadEdge, SiteTypology } from '../core/types';
import { STRATEGIES, runStrategy, type RunOpts } from '../subdivision/registry';
import { defaultParams, makeContext } from '../subdivision/context';
import { unionConnected } from '../subdivision/repair';
import type { SubdivisionCandidate, SubdivisionParams, SubdivisionRun } from '../subdivision/types';
import { obbOf } from '../subdivision/geom';
import { assignFunctions } from './assign';
import {
  buildRoads,
  laneForParcel,
  makeGates,
  mergeAll,
  proposeSkeletons,
  sharedBoundarySegment,
  subtractRoads,
  synthesicEdges,
  sectionOf,
  parcelsAlongRoad,
} from './roads';
import { generateBuildings } from './buildings';
import { placeParking } from './parking';
import { buildGround } from './ground';
import { validateComposition } from './validate';
import type {
  AccessLink,
  ComposeInput,
  ComposeNote,
  GroundPatch,
  InternalRoad,
  ParcelPlan,
  ParcelSubdivisionResult,
  SiteComposition,
  SiteGate,
  SiteInfrastructurePlan,
  SkeletonOption,
} from './types';

const M2 = (u2: number) => u2 * 49;

/** 组合候选的一次评估 */
interface Attempt {
  skId: string;
  skLabel: string;
  strategyId: string;
  strategyLabel: string;
  roads: InternalRoad[];
  roadGround: PlanSurface[];
  gates: SiteGate[];
  candidates: SubdivisionCandidate[];
  /** part 数（被内部道路切开后每块单独分割） */
  parts: number;
  runs: SubdivisionRun[];
  option: SkeletonOption;
}

export interface ComposeOpts extends RunOpts {
  params?: SubdivisionParams;
  /** 只跑指定策略（测试用） */
  only?: string[];
  /** 只跑指定骨架（测试用） */
  onlySkeleton?: string;
  /** 不做巷道补线（用于对照"补线到底救了多少地"） */
  noLane?: boolean;
}

/**
 * 阶段 A：骨架 × 分割。
 *
 * 输出 `SiteInfrastructurePlan` + `ParcelSubdivisionResult`（含用途分配），
 * 不含任何建筑 —— 任务书第十一节要求"此阶段不生成建筑"。
 */
export function planParcels(
  input: ComposeInput,
  opts: ComposeOpts = {}
): { infra: SiteInfrastructurePlan; parcels: ParcelSubdivisionResult; notes: ComposeNote[]; attempts: Attempt[] } {
  const notes: ComposeNote[] = [];
  const gates = makeGates(input);
  if (gates.length === 0) {
    notes.push({ code: 'access-fail', severity: 'error', message: '街区没有可用的真实出入口候选（vehicleAccessCandidates 为空）' });
  }
  const skeletons = proposeSkeletons(input).filter((s) => !opts.onlySkeleton || s.id === opts.onlySkeleton);
  const strategies = STRATEGIES.filter((s) => !opts.only || opts.only.includes(s.id));
  const buildableM2 = M2(surfaceArea(input.buildable));

  const attempts: Attempt[] = [];
  for (const sk of skeletons) {
    const built = buildRoads(input, sk, gates);
    for (const st of strategies) {
      const a = attemptCombo(input, sk, built, gates, st.id, st.label, buildableM2, opts, notes);
      if (a) attempts.push(a);
    }
  }
  if (attempts.length === 0) {
    throw new Error(`F2.4-B: ${input.id} 没有任何可用的骨架 × 分割组合`);
  }
  // 排序：分数 → 道路占地 → 骨架 id（确定性）
  attempts.sort(
    (a, b) =>
      b.option.score - a.option.score ||
      a.option.metrics.roadM2 - b.option.metrics.roadM2 ||
      a.skId.localeCompare(b.skId) ||
      a.strategyId.localeCompare(b.strategyId)
  );
  const win = attempts.find((a) => !a.option.rejected) ?? attempts[0];
  notes.push({
    code: 'skeleton-chosen',
    severity: 'info',
    message:
      `选定 ${win.skLabel} × ${win.strategyLabel}（得分 ${win.option.score.toFixed(3)}）：` +
      `${win.option.reason}`,
  });
  for (const a of attempts) {
    if (a === win) continue;
    notes.push({
      code: 'skeleton-rejected',
      severity: 'info',
      message: `未选 ${a.skLabel} × ${a.strategyLabel}（${a.option.score.toFixed(3)}）：${a.option.reason}`,
    });
  }

  // 巷道补线：仍无接入的地块，沿与"已接入地块"的共享边界补一条 4 m 巷道
  const lanes: InternalRoad[] = [];
  const laneGround: PlanSurface[] = [];
  if (!opts.noLane) {
    repairUnserved(win, input, lanes, laneGround, notes);
  }
  const allRoads = [...win.roads, ...lanes];
  const allGround = mergeAll([...win.roadGround, ...laneGround]);
  const edges = [...input.roadEdges, ...synthesicEdges(allRoads)];

  // 整理地块
  const parcels = toParcelPlans(win.candidates, allRoads, edges, gates, input);
  assignFunctions(parcels, input.typology, buildableM2, notes);

  // 服务对象：每条内部道路必须能说出它服务哪几块地（任务书第三节硬要求）
  for (const r of allRoads) {
    if (r.serves.length > 0) continue; // 巷道已在补线时确定
    const near = parcels.filter((p) => {
      try {
        const { bufferPolyline } = { bufferPolyline: null as null };
        void bufferPolyline;
        return parcelsAlongRoad(r, [p.surface]) > 0;
      } catch {
        return false;
      }
    });
    r.serves = near.map((p) => p.id);
  }

  const parentM2 = win.runs.reduce((s, r) => s + r.validation.parentM2, 0);
  const accountedM2 = parcels.reduce((s, p) => s + M2(surfaceArea(p.surface)), 0);
  const run = mergeRuns(win.runs, `${win.skId}·${win.strategyId}`);
  const infra: SiteInfrastructurePlan = {
    roads: allRoads,
    gates,
    access: parcels.flatMap((p) => p.access),
    roadGround: allGround,
    options: attempts.map((a) => a.option),
    chosen: `${win.skId}·${win.strategyId}`,
    notes: [
      ...built2notes(win),
      ...lanes.map((l) => `巷道 ${l.id}：${l.reason}`),
    ],
  };
  const result: ParcelSubdivisionResult = {
    parcels,
    run,
    edges,
    accountedM2: +accountedM2.toFixed(1),
    parentM2: +parentM2.toFixed(1),
    residualM2: +(parentM2 - accountedM2).toFixed(1),
  };
  return { infra, parcels: result, notes, attempts };
}

function built2notes(a: Attempt): string[] {
  return a.roads.map((r) => `${r.id}（${r.cls} ${r.widthM.toFixed(1)} m）：${r.reason}`);
}

function attemptCombo(
  input: ComposeInput,
  sk: ReturnType<typeof proposeSkeletons>[number],
  built: ReturnType<typeof buildRoads>,
  gates: SiteGate[],
  strategyId: string,
  strategyLabel: string,
  buildableM2: number,
  opts: ComposeOpts,
  notes: ComposeNote[]
): Attempt | null {
  const strategy = STRATEGIES.find((s) => s.id === strategyId)!;
  const roadGround = mergeAll(built.ground);
  const parts = subtractRoads(input.buildable, roadGround);
  if (parts.length === 0) {
    notes.push({ code: 'engine-fail', severity: 'warn', message: `${sk.id}：道路占满可建区，组合无效` });
    return null;
  }
  const edges = [...input.roadEdges, ...synthesicEdges(built.roads)];
  const params = opts.params ?? defaultParams(input.typology);
  const candidates: SubdivisionCandidate[] = [];
  const runs: SubdivisionRun[] = [];
  // 小块（被道路切下来的薄条）不单独分割，计入"道路边角"
  const big = parts.filter((p) => M2(surfaceArea(p)) >= 300).sort((a, b) => surfaceArea(b) - surfaceArea(a));
  if (big.length === 0) return null;
  for (let i = 0; i < big.length; i++) {
    const part = big[i];
    const ctx = makeContext(part, {
      id: big.length > 1 ? `${input.id}·${sk.id}/${i + 1}` : `${input.id}·${sk.id}`,
      parentId: input.id,
      typology: input.typology,
      mode: 'vacant',
      buildable: part,
      roadEdges: edges,
      seed: input.seed + i * 17,
    });
    if (!strategy.supports(ctx).applicable) continue;
    const run = runStrategy(strategy, ctx, params, { rounds: opts.rounds ?? 1, buildings: [] });
    for (const c of run.candidates) {
      candidates.push(big.length > 1 ? { ...c, id: `${i + 1}/${c.id}` } : c);
    }
    runs.push(run);
  }
  if (candidates.length === 0) {
    notes.push({ code: 'engine-fail', severity: 'warn', message: `${sk.id}×${strategyId}：分割不出任何地块` });
    return null;
  }

  // 分割可能吐出 0~1 m² 的布尔碎屑（实测 I01 出现过 0 m² 与 1 m² 的"地块"）。
  // 它们不是地，既不能分配用途也不该参与评分 —— 先并给相邻地块，并不上就丢。
  absorbSlivers(candidates, notes, sk.id, strategyId);
  // 偏移法切出的相邻带在斜边上会互相压几个 m²（实测 R01 子块合计比父级多 75.6 m²）。
  // 分区必须是**互不重叠的划分**，所以按面积从大到小重新裁一遍。
  dedupeOverlaps(candidates, notes);

  const roadM2 = M2(roadGround.reduce((s, r) => s + surfaceArea(r), 0));
  const unserved = candidates.filter((c) => c.access.length === 0);
  const unservedM2 = unserved.reduce((s, c) => s + c.metrics.areaM2, 0);
  const fragM2 = candidates
    .filter((c) => c.role === 'fragment' || c.metrics.bottleneckM < params.minWidthM)
    .reduce((s, c) => s + c.metrics.areaM2, 0);
  const compoundM2 = candidates.filter((c) => c.role === 'compound').reduce((s, c) => s + c.metrics.areaM2, 0);
  const shares = candidates.filter((c) => c.metrics.perimeterM > 0).map((c) => c.metrics.frontageShare);
  const frontageShare = shares.length ? shares.reduce((a, b) => a + b, 0) / shares.length : 0;

  const surfaces = candidates.map((c) => c.surface);
  /** 服务 0 块地的内部道路 = 白铺的路（占地却没有服务对象） */
  let idleRoadM2 = 0;
  const idleIds: string[] = [];
  for (const r of built.roads) {
    if (parcelsAlongRoad(r, surfaces) === 0) {
      idleRoadM2 += M2(surfaceArea(r.surface));
      idleIds.push(r.id);
    }
  }
  const largestM2 = candidates.reduce((m, c) => Math.max(m, c.metrics.areaM2), 0);

  const unservedShare = buildableM2 > 0 ? unservedM2 / buildableM2 : 0;
  const roadShare = buildableM2 > 0 ? roadM2 / buildableM2 : 0;
  const fragmentShare = buildableM2 > 0 ? fragM2 / buildableM2 : 0;
  const compoundShare = buildableM2 > 0 ? compoundM2 / buildableM2 : 0;
  const idleShare = buildableM2 > 0 ? idleRoadM2 / buildableM2 : 0;
  const largestShare = buildableM2 > 0 ? largestM2 / buildableM2 : 0;
  /**
   * 单一地块占街区可建区的上限（超过就说明这一刀没切开）。
   * 不同用地不一样：工业园留一个大厂房是常态，住宅区里出现半个街区的"一块地"就是失败。
   */
  const largestCap = input.typology === 'industrial' || input.typology === 'data_center' ? 0.46 : 0.34;
  const largestOver = Math.max(0, largestShare - largestCap);

  /**
   * 评分（只用于**在这一组组合里排序**，不参与任何硬约束）。
   *
   *   无接入面积    权重 1.0  —— 没入口的地等于零产出，首要问题；
   *   道路占地     -1.2  —— 同样的通达度下占地越少越好；
   *   白铺的路     -1.0  —— 占地却不服务任何地块；
   *   临街率       +0.5  —— 空间质量；
   *   残片率       -0.6  —— 反面；
   *   单一巨型地块 -0.8  —— 超出上限的部分（说明该切没切）；
   *   保留组团     +0.15 —— 产品目标之一。
   *
   * 系数只做量纲对齐（各项都在 0~1），不代表"精度"，也不参与验收。
   */
  const terms = [
    { k: '通达 1.0×(1-无接入占比)', v: 1.0 * (1 - unservedShare) },
    { k: '道路占地 -1.2×', v: -1.2 * roadShare },
    { k: '白铺道路 -1.0×', v: -1.0 * idleShare },
    { k: '临街率 +0.5×', v: 0.5 * frontageShare },
    { k: '残片 -0.6×', v: -0.6 * fragmentShare },
    { k: `巨型地块 -0.8×(超出 ${(largestCap * 100).toFixed(0)}% 的部分)`, v: -0.8 * largestOver },
    { k: '保留组团 +0.15×', v: 0.15 * compoundShare },
  ];
  const score = terms.reduce((s, t) => s + t.v, 0);
  const reason =
    `地块 ${candidates.length} 块（${big.length} 个分块，最大 ${(largestShare * 100).toFixed(0)}%）· ` +
    `道路 ${roadM2.toFixed(0)} m²（${(roadShare * 100).toFixed(1)}%，其中白铺 ${idleRoadM2.toFixed(0)} m²）· ` +
    `无接入 ${unserved.length} 块 ${unservedM2.toFixed(0)} m² · 临街率 ${(frontageShare * 100).toFixed(0)}% · ` +
    `残片 ${(fragmentShare * 100).toFixed(1)}% · 组团 ${(compoundShare * 100).toFixed(0)}%` +
    (idleIds.length ? ` · 无服务对象的道路：${idleIds.join(',')}` : '');
  const option: SkeletonOption = {
    id: `${sk.id}·${strategyId}`,
    label: `${sk.label} × ${strategyLabel}`,
    strategyId,
    score: +score.toFixed(4),
    metrics: {
      roadM2: +roadM2.toFixed(1),
      roadShare: +roadShare.toFixed(4),
      parcels: candidates.length,
      unservedM2: +unservedM2.toFixed(1),
      unservedShare: +unservedShare.toFixed(4),
      frontageShare: +frontageShare.toFixed(4),
      fragmentShare: +fragmentShare.toFixed(4),
      compoundM2: +compoundM2.toFixed(1),
    },
    scoreTerms: terms.map((t) => ({ k: t.k, v: +t.v.toFixed(4) })),
    reason,
    rejected: unservedShare > 0.12 ? `无接入面积占 ${(unservedShare * 100).toFixed(1)}%，超 12% 上限` : undefined,
  };
  return {
    skId: sk.id,
    skLabel: sk.label,
    strategyId,
    strategyLabel,
    roads: built.roads,
    roadGround,
    gates,
    candidates,
    parts: big.length,
    runs,
    option,
  };
}

/**
 * 巷道补线：给无接入的地块沿共享边界提一条窄巷道。
 *
 * 只从"已经接入的地块"接出，所以链路最短、想解释得清。
 * 补不上就留着让验证层报错 —— 不允许静默把它当可建地块。
 */
function repairUnserved(win: Attempt, input: ComposeInput, lanes: InternalRoad[], laneGround: PlanSurface[], notes: ComposeNote[]): void {
  const unserved = win.candidates.filter((c) => c.access.length === 0);
  for (const c of unserved) {
    let best: { donor: SubdivisionCandidate; seg: { a: Pt; b: Pt; lenU: number } } | null = null;
    for (const d of win.candidates) {
      if (d === c || d.access.length === 0) continue;
      const seg = sharedBoundarySegment(c.surface, d.surface);
      if (!seg) continue;
      if (!best || seg.lenU > best.seg.lenU) best = { donor: d, seg };
    }
    if (!best) {
      notes.push({ code: 'access-fail', severity: 'warn', message: `${c.id} 无接入且找不到可借用巷道的地块` });
      continue;
    }
    const r = laneForParcel(c.surface, best.donor.surface, 4);
    if (!r) {
      notes.push({ code: 'access-fail', severity: 'warn', message: `${c.id} 与 ${best.donor.id} 的共享边界不足以铺 4 m 巷道` });
      continue;
    }
    const ring = r.ring;
    const surf = { outer: ring, holes: [] };
    const laneId = `lane-${lanes.length + 1}`;
    lanes.push({
      id: laneId,
      cls: 'pedestrian',
      widthM: 4,
      carriageM: 4,
      centerline: [r.ring.length > 0 ? centroid(r.ring) : new Pt(0, 0)],
      surface: surf,
      serves: [c.id],
      from: best.donor.access[0]?.viaPieceId ?? best.donor.access[0]?.via ?? 'street',
      reason: `为 ${c.id} 补 4 m 巷道（借用与 ${best.donor.id} 的共享边界 ${(best.seg.lenU * 7).toFixed(0)} m），服务对象仅 ${c.id}`,
    });
    laneGround.push(surf);
    const a = c.access[0];
    if (!a) {
      c.access.push({
        kind: 'service',
        at: centroid(ring),
        normal: new Pt(0, 1),
        via: 'alley',
        viaPieceId: best.donor.id,
        requiresInternalLane: true,
      });
    }
    c.role = c.developable ? 'parcel' : c.role;
    notes.push({ code: 'lane-proposed', severity: 'info', message: `${c.id} 经 ${best.donor.id} 补巷道（${laneId}）` });
  }
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

/** 候选 → ParcelPlan（补接入、扣巷道、算临街长度） */
function toParcelPlans(
  candidates: SubdivisionCandidate[],
  roads: InternalRoad[],
  edges: SiteRoadEdge[],
  gates: SiteGate[],
  _input: ComposeInput
): ParcelPlan[] {
  const internalIds = new Set(roads.map((r) => r.id));
  const edgeByKey = new Map(edges.map((e) => [e.key, e]));
  const out: ParcelPlan[] = [];
  for (const c of candidates) {
    // 地块不得超出可建区。这一步是"面积归属可对账"的兜底：
    // F2.1 的分割在斜边上会把地块推出父级 0.1~0.2%（布尔量化），
    // 六块加起来就有 38 m²（实测 R01 S0），不裁的话子块之和永远比父级大一点。
    // 只在**真的越界**时才裁。无脑 intersect 会把本来就在内部的环按布尔精度"削掉一圈"
    //（实测 G01 因此掉了 80.6 m² 无主面积，覆盖账怎么也对不上）。
    let own = c.surface;
    try {
      const outside = surfaceSubtract([c.surface], [_input.buildable]).reduce((a, q) => a + surfaceArea(q), 0);
      if (outside * 49 > 0.5) {
        const clipped = surfaceIntersect([c.surface], [_input.buildable]).filter((q) => surfaceArea(q) > 1e-6);
        clipped.sort((a, b) => surfaceArea(b) - surfaceArea(a));
        if (clipped.length > 0) own = clipped[0];
      }
    } catch {
      /* 裁失败就保持原样，验证层会报越界 */
    }
    const usableParts = roads.length === 0 ? [own] : surfaceSubtract([own], roads.map((r) => r.surface));
    usableParts.sort((a, b) => surfaceArea(b) - surfaceArea(a));
    const usable = usableParts[0] ?? own;
    const streetM = c.frontages.filter((f) => !internalIds.has(f.roadKey)).reduce((s, f) => s + f.lengthM, 0);
    const frontageM = c.frontages.reduce((s, f) => s + f.lengthM, 0);
    const ctr = centroid(c.surface.outer);
    const gateM = gates.length
      ? (gates.reduce((s, g) => Math.min(s, Pt.distance(ctr, g.at)), 1e9) * 7)
      : 0;

    // 接入：优先用分割器给出的（它知道巷接链），空则按临街面补
    const access: AccessLink[] = [];
    for (const a of c.access) {
      const viaInternal = a.via === 'alley' || c.frontages.some((f) => internalIds.has(f.roadKey) && nearEdge(a.at, f.edge));
      const ref = viaInternal
        ? roads.find((r) => distToRing(a.at, r.surface) * 7 < 8)?.id ?? roads[0]?.id ?? 'lane'
        : nearestEdgeKey(a.at, c.frontages);
      const e = edgeByKey.get(ref);
      access.push({
        parcelId: c.id,
        via: a.via === 'alley' ? 'lane' : viaInternal ? 'internal' : 'street',
        ref,
        at: a.at,
        lengthM: e ? distToSeg(a.at, e.a, e.b) * 7 : 0,
        vehicular: (e ? e.carriageSide * 2 * 7 : 7) >= 5.0,
      });
    }
    if (access.length === 0) {
      for (const f of c.frontages.slice(0, 2)) {
        const mid = new Pt((f.edge[0].x + f.edge[1].x) / 2, (f.edge[0].y + f.edge[1].y) / 2);
        const internal = internalIds.has(f.roadKey);
        access.push({
          parcelId: c.id,
          via: internal ? 'internal' : 'street',
          ref: f.roadKey,
          at: mid,
          lengthM: 0,
          vehicular: !internal || (e2Carriage(f.roadKey, roads) ?? 7) >= 5,
        });
      }
    }
    out.push({
      id: c.id,
      candidate: c,
      surface: own,
      usable,
      fn: 'building',
      reason: '',
      ranked: [],
      streetFrontageM: +streetM.toFixed(2),
      frontageM: +frontageM.toFixed(2),
      gateM: +gateM.toFixed(1),
      access,
    });
  }
  return out;
}

function e2Carriage(id: string, roads: InternalRoad[]): number | null {
  const r = roads.find((x) => x.id === id);
  return r ? r.carriageM : null;
}

function nearestEdgeKey(p: Pt, fs: SubdivisionCandidate['frontages']): string {
  let best = fs[0]?.roadKey ?? 'none';
  let bestD = Infinity;
  for (const f of fs) {
    const d = distToSeg(p, f.edge[0], f.edge[1]);
    if (d < bestD) {
      bestD = d;
      best = f.roadKey;
    }
  }
  return best;
}

function nearEdge(p: Pt, e: [Pt, Pt]): boolean {
  return distToSeg(p, e[0], e[1]) * 7 < 8;
}

function distToSeg(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-12) return Pt.distance(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

function distToRing(p: Pt, s: PlanSurface): number {
  let d = Infinity;
  for (const ring of [s.outer, ...s.holes]) {
    for (let i = 0; i < ring.length; i++) d = Math.min(d, distToSeg(p, ring[i], ring[(i + 1) % ring.length]));
  }
  return d;
}

/** 多个分块的 run 合成一个（统计口径统一） */
function mergeRuns(runs: SubdivisionRun[], label: string): SubdivisionRun {
  const first = runs[0];
  const candidates = runs.flatMap((r) => r.candidates);
  const sum = (f: (r: SubdivisionRun) => number) => runs.reduce((s, r) => s + f(r), 0);
  return {
    strategyId: label,
    strategyLabel: label,
    params: first.params,
    candidates,
    validation: {
      ok: runs.every((r) => r.validation.ok),
      errors: runs.flatMap((r) => r.validation.errors),
      warnings: runs.flatMap((r) => r.validation.warnings),
      parentM2: +sum((r) => r.validation.parentM2).toFixed(1),
      piecesM2: +sum((r) => r.validation.piecesM2).toFixed(1),
      residualM2: +sum((r) => r.validation.residualM2).toFixed(1),
      overlapM2: +sum((r) => r.validation.overlapM2).toFixed(1),
      outsideM2: +sum((r) => r.validation.outsideM2).toFixed(1),
      booleanFailures: sum((r) => r.validation.booleanFailures),
    },
    axisHints: first.axisHints,
    tree: first.tree,
    notes: runs.flatMap((r) => r.notes),
    stats: {
      pieces: candidates.length,
      developable: candidates.filter((c) => c.developable).length,
      fragments: candidates.filter((c) => c.role === 'fragment').length,
      parentM2: +sum((r) => r.stats.parentM2).toFixed(1),
      coveredM2: +sum((r) => r.stats.coveredM2).toFixed(1),
      frontageShareMean: first.stats.frontageShareMean,
      fragmentShare: first.stats.fragmentShare,
      unreachable: sum((r) => r.stats.unreachable),
      msMedian: +Math.max(...runs.map((r) => r.stats.msMedian)).toFixed(2),
      msP95: +Math.max(...runs.map((r) => r.stats.msP95)).toFixed(2),
    },
  };
}

/** 道路断面查询（出图与验证共用） */
export { sectionOf };
export { surfaceUnion };
export type { SiteTypology };


/** 几何被改过之后重算与面积相关的指标（不重跑完整 metrics，代价太大且用不到） */
function refreshArea(c: SubdivisionCandidate): SubdivisionCandidate {
  const areaM2 = surfaceArea(c.surface) * 49;
  const ob = obbOf(c.surface.outer);
  return {
    ...c,
    metrics: {
      ...c.metrics,
      areaM2: +areaM2.toFixed(2),
      obbWM: ob ? +(Math.min(ob.w, ob.d) * 7).toFixed(1) : c.metrics.obbWM,
      obbDM: ob ? +(Math.max(ob.w, ob.d) * 7).toFixed(1) : c.metrics.obbDM,
      aspect: ob ? +(Math.max(ob.w, ob.d) / Math.max(1e-6, Math.min(ob.w, ob.d))).toFixed(2) : c.metrics.aspect,
    },
  };
}

/**
 * 把布尔碎屑并进相邻地块。
 *
 * 阈值 60 m² 不是随手取的：20×3 m 的条已经不可能承载任何建筑或车位，
 * 而 60 m² 以下的"地块"在任何图上都只是一条缝 —— 它进不了任何用途。
 */
function absorbSlivers(candidates: SubdivisionCandidate[], notes: ComposeNote[], skId: string, strategyId: string): void {
  const MIN = 60;
  let absorbedCount = 0;
  for (let i = candidates.length - 1; i >= 0; i--) {
    const c = candidates[i];
    if (c.metrics.areaM2 >= MIN) continue;
    let best = -1;
    let bestLen = 0;
    for (let j = 0; j < candidates.length; j++) {
      if (j === i) continue;
      const seg = sharedBoundarySegment(c.surface, candidates[j].surface);
      if (seg && seg.lenU > bestLen) {
        bestLen = seg.lenU;
        best = j;
      }
    }
    if (best >= 0) {
      const merged = unionConnected(candidates[best].surface, c.surface);
      if (merged) {
        candidates[best] = refreshArea({ ...candidates[best], surface: merged });
        absorbedCount++;
        candidates.splice(i, 1);
        continue;
      }
    }
    notes.push({ code: 'engine-fail', severity: 'warn', message: `${skId}×${strategyId}：丢弃 ${c.id}（${c.metrics.areaM2.toFixed(1)} m² 碎屑，无法并入邻块）` });
    candidates.splice(i, 1);
  }
  if (absorbedCount > 0) {
    notes.push({ code: 'engine-fail', severity: 'info', message: `${skId}×${strategyId}：${absorbedCount} 块布尔碎屑并入相邻地块` });
  }
}

/**
 * 保证"互不重叠的划分"。
 *
 * 为什么必须做，而不是"报个重叠面积让人判断"：
 *   · 面积对账的口径是"子块之和 = 父级"，一旦重叠就永远差那一块；
 *   · 建筑阶段按地块可建域布建筑，重叠区会被两块地各建一次 —— 那是硬约束违背。
 * 做法是确定的：按面积降序（同面积按 id），每块减去已接受部分的并集。
 * 被减出来的其它连通块保留为残片（不丢面积），减空的直接丢弃并记录。
 */
function dedupeOverlaps(candidates: SubdivisionCandidate[], notes: ComposeNote[]): void {
  const order = candidates
    .map((c, i) => ({ c, i }))
    .sort((a, b) => b.c.metrics.areaM2 - a.c.metrics.areaM2 || a.c.id.localeCompare(b.c.id));
  const accepted: PlanSurface[] = [];
  const keep: SubdivisionCandidate[] = [];
  for (const { c } of order) {
    let rest = [c.surface];
    if (accepted.length > 0) {
      try {
        rest = surfaceSubtract([c.surface], accepted).filter((q) => surfaceArea(q) > 1e-6);
      } catch {
        rest = [c.surface];
      }
    }
    if (rest.length === 0) {
      notes.push({ code: 'engine-fail', severity: 'warn', message: `${c.id} 完全落在其它地块内，已丢弃` });
      continue;
    }
    rest.sort((a, b) => surfaceArea(b) - surfaceArea(a));
    if (surfaceArea(rest[0]) < surfaceArea(c.surface) - 0.02) {
      const lost = (surfaceArea(c.surface) - rest.reduce((s, q) => s + surfaceArea(q), 0)) * 49;
      if (lost > 1) notes.push({ code: 'engine-fail', severity: 'info', message: `${c.id} 与先到的地块重叠 ${lost.toFixed(1)} m²，已裁掉` });
    }
    keep.push(refreshArea({ ...c, surface: rest[0] }));
    accepted.push(...rest);
  }
  // 保持原顺序（原顺序 = 分割器给出的空间顺序，报告与图都按它读）
  const byId = new Map(keep.map((c) => [c.id, c]));
  candidates.length = 0;
  for (const c of byId.values()) candidates.push(c);
}


// ---------------------------------------------------------------- 完整合成

/**
 * 完整合成：阶段 A → B → C → 验证。
 *
 * 三个阶段的接口边界很清楚：
 *   A 只出"地块 + 道路 + 接入"；B 只出"建筑 + 门"；C 只出"停车 + 地面"。
 * 每一段都能单独跑（阶段验收），也能串起来跑（总平面）。
 * 串起来时顺序不能换：B 需要 A 的可建域，C 需要 A 的地块与 B 的建筑。
 */
export function composeSite(input: ComposeInput, opts: ComposeOpts = {}): SiteComposition {
  const t0 = Date.now();
  const params = opts.params ?? defaultParams(input.typology);
  const { infra, parcels, notes } = planParcels(input, opts);

  const br = generateBuildings(parcels.parcels, input, params, infra.roads);
  notes.push(...br.notes);

  const pk = placeParking(parcels.parcels, br.buildings, infra.roads, input.typology);
  notes.push(...pk.notes);

  const gr = buildGround({
    input,
    parcels: parcels.parcels,
    buildings: br.buildings,
    parking: pk.areas,
    roads: infra.roads,
    roadGround: infra.roadGround,
    parkingGround: [...pk.ground.map((x) => x.surface), ...pk.drives.map((x) => x.surface)],
  });
  notes.push(...gr.notes);

  // 地面层的顺序 = 绘制顺序（先铺装后种植，花坛最后压在上面）
  const ground: GroundPatch[] = [...pk.ground, ...pk.drives, ...gr.ground];

  const { validation, metrics } = validateComposition({
    input,
    parcels: parcels.parcels,
    buildings: br.buildings,
    parking: pk.areas,
    ground,
    voids: gr.voids,
    roads: infra.roads,
    roadGround: infra.roadGround,
    engineering: br.failures,
    ms: Date.now() - t0,
  });

  return {
    id: input.id,
    typology: input.typology,
    input,
    infra,
    parcels,
    buildings: br.buildings,
    parking: pk.areas,
    ground,
    voids: gr.voids,
    validation,
    metrics,
    notes,
  };
}
