// Scene · Planner 前端接入（R8 Frontend Product Integration）
//
// ## 这一层是干什么的
//
// 把 Planner 的完整链路接进**真实的前端渲染**：
//
//   Parcel
//   → siteContextFromModel()
//   → generateCandidates()          （按 typology 路由）
//   → selectBestCandidate()         （显式选优 + margin）
//   → realizeSitePlan()             （忠实落地，不再做规划决策）
//   → Scene 特征
//   → 现有 2D / 3D Renderer
//
// ## 红线
//
// `realizeSitePlan()` 产出的特征**直接进 Scene**，不再经过 legacy 的地块规划逻辑
// （`ModernWard.lot` 那条链）。也就是说：被 Planner 接管的地块，
// 它的建筑、地面、开口、车位**全部**来自 Planner，legacy 一个字节都不进来。
// 只有"Planner 接不了的地块"才回落到 legacy —— 并且在报告里写明为什么。
//
// ## 三种模式
//
// | 模式 | 渲染 | 用途 |
// |---|---|---|
// | legacy  | 全部走 legacy | 现状基线 |
// | planner | 三类地块由 Planner 接管，其余 legacy | 看 Planner 真实产出 |
// | shadow  | 全部 legacy，Planner 的结果画成红色虚线轮廓叠在上面 | 一眼对比两套方案 |
//
// ## 第一批只接三类
//
// industrial / multi_family / retail —— 这三类有 Shadow 样本、有绝对强度带校准。
// hotel / data_center / single_family 暂时继续 legacy（没有 Shadow 样本，
// 假装校准过就是自欺）。
//
// **这一层不包含任何规划决策**：所有"放什么、放多大"都是 archetype 与
// evaluator 决定的；这里只负责调用、路由、汇总。

import type { Model } from '../town/model';
import { patchKey, type Patch } from '../town/patch';
import type { RoadNet } from '../road/system';
import { siteContextFromModel } from '../town/planning/adapters/model';
import { generateCandidates } from '../town/planning/generators';
import { selectBestCandidate } from '../town/shadow/runner';
import { adoptCirculation } from '../town/planning/circulation/adopt';
import { realizeSitePlan } from '../town/realize';
import { INTENSITY_TARGETS, bandState, intensityValue, type BandState } from '../town/shadow/intensity';
import { surfaceArea } from '../town/planning/core/surface';
import type { SiteTypology } from '../town/planning/core/types';
import type { PathFeature, PropFeature, SolidFeature, SurfaceFeature } from './types';

/**
 * 场景装配模式。
 *
 * `f3` 是规则驱动的城市合成器：它**不经过** buildScene / Planner，
 * 而是自己产一份完整 Scene 直接给 2D/3D/GLB 用。类型上列在这里是为了让
 * `state.planningMode` 只有一份真相；`buildScene` 收到 f3 时按 legacy 处理
 * （这条路径在此模式下根本不会被调用）。
 */
export type PlanningMode = 'legacy' | 'planner' | 'f3';

/**
 * R1.3 受控开关：启用新内部交通网络的地块（patchKey）。
 *
 * 只有这三个 Golden 先换，其余地块继续走 archetype 手画的 circulation ——
 * 一次只让三块地变，出问题能一眼定位到是哪一块，而不是整个城市一起漂。
 * 三个都过了生产验收再决定要不要放开。
 */
export const R13_CIRCULATION_PARCELS = new Set<string>(['-469:284', '176:176', '252:-578']);

/** 第一批接管的 typology */
export const PLANNER_ENABLED_TYPOLOGIES: SiteTypology[] = [
  'industrial',
  'multi_family',
  'retail',
  // 非开发型用地：建筑不是主体，空间由人的通行组织（P0 阶段接入）
  'green',
  'park',
  'civic',
];

export const TYPOLOGY_LABEL: Record<SiteTypology, string> = {
  industrial: 'Industrial',
  multi_family: 'Multi-Family',
  retail: 'Retail',
  hotel: 'Hotel',
  data_center: 'Data Center',
  single_family: 'Single-Family',
  green: 'Green',
  park: 'Park',
  civic: 'Civic',
  generic: 'Generic',
};

export interface PlannerIntensityInfo {
  /** 口径说明，例如 "FAR 1.84 / preferred 1.4–2.2" */
  label: string;
  value: number;
  state: BandState;
  band: { min: number; preferredMin: number; preferredMax: number; max: number };
}

export interface PlannerParcelReport {
  parcelId: string;
  typology: SiteTypology;
  typologyLabel: string;
  /** Planner 是否接管了这块地 */
  covered: boolean;
  /** 没接管的原因（给人看，不是给机器看） */
  reason?: string;

  candidateId?: string;
  archetype?: string;
  score?: number;
  margin?: number | null;
  lowConfidence?: boolean;
  candidateCount?: number;

  buildings?: number;
  /** 建筑基底覆盖率 */
  coverage?: number;
  intensity?: PlannerIntensityInfo;

  /**
   * R1.3 内部交通：这块地的新网络是否真的换上了。
   *
   * 只有受控开关里那几块（三个 Golden）会跑求解器；其余地块没有这一项。
   * `applied === false` 时必须看 `reason` —— 不许把"沿用旧路"读成"新网络连通"。
   */
  /** 停车求解结果（车位由哪套 provider 算出、排了多少） */
  parking?: {
    requests: number;
    stalls: number;
    providers: string[];
    islands: number;
    aisleM2: number;
    aisleComps: number;
    frontRate: number;
    /** 停车区语义修复：转景观 / 仍留铺装（无功能） */
    lawnM2: number;
    deadPavingM2: number;
    /** 每个请求的明细（角色 / 面积 / 车位数），诊断报告用 */
    perRequest: { role: string; usableM2: number; stalls: number; provider: string }[];
  };
  circulation?: {
    applied: boolean;
    reason?: string;
    /** 新铺路径条数 */
    paths: number;
    /** 新铺总长（m） */
    lengthM: number;
    /** 保留的旧 archetype 路条数 */
    keptLegacy: number;
    /** 被新路替换掉的旧路条数 */
    replacedLegacy: number;
    /** 因共用主干而没重复铺的长度（m） */
    dedupedM: number;
    odTotal: number;
    odConnected: number;
    sharedRate: number;
    ms: number;
  };
}

export interface PlannerParcelFeatures {
  surfaces: SurfaceFeature[];
  solids: SolidFeature[];
  paths: PathFeature[];
  props: PropFeature[];
}

/** R1.4 内部交通的三档开关 */
export type CirculationMode = 'off' | 'golden' | 'all';

export interface PlannerBundle {
  /** 每块被接管的地块的特征（key = patchKey） */
  byParcel: Map<string, PlannerParcelFeatures>;
  /** 每块地的报告（含没接管的） */
  reports: Map<string, PlannerParcelReport>;
  overlay: PlannerParcelFeatures;
  /** R1.4 诊断：每块地的完整网络 / 入口 / 失败点（只有跑过求解器或尝试过的地块才有） */
  circulationDebug: Map<string, import('../town/planning/circulation/adopt').CirDebug>;
  /** 本次用的是哪一档开关 */
  circulationMode: CirculationMode;
  stats: {
    total: number;
    covered: number;
    byTypology: Record<string, { total: number; covered: number }>;
  };
}

/** 空特征包 */
function emptyFeatures(): PlannerParcelFeatures {
  return { surfaces: [], solids: [], paths: [], props: [] };
}

export interface PlannerBundleOptions {
  /**
   * S1 场地布局骨架：`off` / `golden` / `all`，默认 `off`。
   *
   * 默认关是**有意**的 —— 本轮是三个 Golden 的方案对比，不是全城换血。
   * 打开之后这三块地会走"先车道后建筑"的骨架流程（见 `planning/skeleton/`）。
   */
  s1?: import('../town/planning/skeleton').S1Mode;
  /** 停车求解器：legacy / placemaker / compare（默认 legacy，生产行为不变） */
  parkingProvider?: 'legacy' | 'placemaker' | 'compare';
  /** Pattern Registry：off / golden / all（默认 off） */
  pattern?: import('../town/planning/skeleton').PatternMode;
  /**
   * R1.4 开关：`off` 不开 / `golden` 只开三块 / `all` 全城。
   *
   * 不传就是 `all`（本轮起本地开发默认全城启用）。
   */
  circulation?: CirculationMode;
  /**
   * 兼容 R1.3 的旧调用：直接给地块集合。
   * `null` = 全城，`new Set()` = 全关。给了 `circulation` 时以它为准。
   */
  circulationParcels?: Set<string> | null;
}

/** 把开关翻译成"哪些地块启用"：null = 全部，Set = 只有这些 */
function circulatingSet(opts: PlannerBundleOptions): Set<string> | null {
  if (opts.circulation !== undefined) {
    if (opts.circulation === 'off') return new Set<string>();
    if (opts.circulation === 'golden') return R13_CIRCULATION_PARCELS;
    return null;
  }
  if (opts.circulationParcels !== undefined) return opts.circulationParcels;
  return null; // 默认 all
}

/**
 * 跑一遍 Planner，产出可直接进 Scene 的特征与报告。
 *
 * 注意 `realizeSitePlan` 之后**不再有任何 legacy 调用** —— 这是 R8 的核心红线。
 */
export function buildPlannerBundle(
  model: Model,
  net: RoadNet,
  mode: PlanningMode,
  opts: PlannerBundleOptions = {}
): PlannerBundle {
  const gate = circulatingSet(opts);
  const circulationMode: CirculationMode =
    opts.circulation ?? (gate === null ? 'all' : gate.size === 0 ? 'off' : 'golden');
  const circulationDebug = new Map<
    string,
    import('../town/planning/circulation/adopt').CirDebug
  >();
  const byParcel = new Map<string, PlannerParcelFeatures>();
  const reports = new Map<string, PlannerParcelReport>();
  const overlay = emptyFeatures();
  const stats = {
    total: 0,
    covered: 0,
    byTypology: {} as Record<string, { total: number; covered: number }>,
  };

  for (const patch of model.patches) {
    if (patch.blocked) continue;
    const key = patchKey(patch);
    const ctx = siteContextFromModel(model, patch, { net });

    const bucket = (stats.byTypology[ctx.typology] ??= { total: 0, covered: 0 });
    bucket.total++;
    stats.total++;

    const report: PlannerParcelReport = {
      parcelId: key,
      typology: ctx.typology,
      typologyLabel: TYPOLOGY_LABEL[ctx.typology] ?? ctx.typology,
      covered: false,
    };
    reports.set(key, report);

    if (!PLANNER_ENABLED_TYPOLOGIES.includes(ctx.typology)) {
      report.reason = `${report.typologyLabel} 暂未接入（没有 Shadow 样本与强度带）`;
      continue;
    }

    const candidates = generateCandidates(ctx, { s1: opts.s1 ?? 'off', pattern: opts.pattern ?? 'off' });
    if (candidates.length === 0) {
      report.reason = '该地块没有可用候选（地块太小 / 形状不适合这类语法）';
      continue;
    }

    const best = selectBestCandidate(candidates);
    const cand = best.winner;

    // ---- R1.3 内部交通：受控开关，只对三个 Golden 换上求解器的网络
    //
    // 这一步在**规划侧**做：Realizer 只负责把中心线铺成路面，不跑 A*、不重规划。
    // 失败（OD 没全连通 / 没有路径）时保留 archetype 的旧 circulation，
    // 并把原因写进报告 —— 绝不静默把"沿用旧路"说成"新版连通"。
    let candToRealize = cand;
    let circNote: PlannerParcelReport['circulation'];
    if (gate === null || gate.has(key)) {
      const adopted = adoptCirculation(ctx, cand);
      const r = adopted.report;
      circNote = {
        applied: r.applied,
        reason: r.reason,
        paths: r.paths,
        lengthM: r.lengthM,
        keptLegacy: r.keptLegacy,
        replacedLegacy: r.replacedLegacy,
        dedupedM: r.dedupedM,
        odTotal: r.odTotal,
        odConnected: r.odConnected,
        sharedRate: r.sharedRate,
        ms: r.ms,
      };
      circulationDebug.set(key, adopted.debug);
      if (r.applied) candToRealize = adopted.candidate;
    }

    const realized = realizeSitePlan(candToRealize, {
      group: `lot/${ctx.typology}`,
      solveParking: true,
      // typology 决定建筑外观（住宅暖色 / 商业幕墙 / 工业面板）
      typology: ctx.typology,
      // 红线 + 可建区：Realizer 用它们铺"红线退线带"（见 realizeGround 注释）
      parcel: ctx.parcel,
      buildable: ctx.buildableArea,
      setbackProgram: ctx.typology === 'industrial' ? 'landscape_buffer' : 'landscape',
      // solver 出的路会走在退线带里：裁剪体必须是**红线**。
      // 用 ground 并集会把整段裁掉（"路径 2 条、铺装 0 m²"就是这么来的）。
      circulationMode: circNote?.applied ? 'solver' : 'legacy',
      parkingProvider: opts.parkingProvider ?? 'legacy',
    });

    const feats: PlannerParcelFeatures = {
      surfaces: realized.surfaces,
      solids: realized.solids,
      paths: realized.paths,
      props: realized.props,
    };
    byParcel.set(key, feats);

    // ---- 报告
    const parcelArea = surfaceArea(ctx.parcel);
    const fp = realized.solids.reduce((a, s) => a + Math.abs(ringAreaOf(s.ring)), 0);
    const coverage = parcelArea > 1e-9 ? fp / parcelArea : 0;
    report.covered = true;
    report.candidateId = cand.id;
    report.archetype = cand.archetype;
    report.score = cand.score ?? 0;
    report.margin = best.margin;
    report.lowConfidence = best.lowConfidence;
    report.candidateCount = best.count;
    const ps = realized.parkingStats ?? [];
    report.parking = {
      requests: ps.length,
      stalls: ps.reduce((a, s2) => a + s2.stalls, 0),
      providers: Array.from(new Set(ps.map((s2) => s2.provider ?? 'legacy'))),
      islands: ps.reduce((a, s2) => a + (s2.islandCount ?? 0), 0),
      aisleM2: ps.reduce((a, s2) => a + (s2.aisleM2 ?? 0), 0),
      // 多请求时取最差：有任何一个不连通，整体就不能算连通
      aisleComps: ps.length ? Math.max(...ps.map((s2) => s2.aisleComps ?? 1)) : 0,
      frontRate: ps.length ? Math.min(...ps.map((s2) => s2.frontRate ?? 1)) : 0,
      lawnM2: ps.reduce((a, s2) => a + (s2.lawnM2 ?? 0), 0),
      deadPavingM2: ps.reduce((a, s2) => a + (s2.deadPavingM2 ?? 0), 0),
      perRequest: ps.map((s2) => ({
        role: s2.role,
        usableM2: +(s2.usableArea * 49).toFixed(0),
        stalls: s2.stalls,
        provider: s2.provider ?? 'legacy',
      })),
    };
    report.buildings = realized.solids.length;
    report.coverage = coverage;
    if (circNote) report.circulation = circNote;

    const target = INTENSITY_TARGETS[ctx.typology];
    if (target) {
      const v = intensityValue(coverage, target);
      const st = bandState(v, target);
      // 覆盖率口径的数值很小（0.18 这种），用 1 位小数会显示成 "0.2–0.2"；
      // 容积率口径用 1 位小数就够。
      const fmt = (x: number) => (Math.abs(x) < 1 ? x.toFixed(2) : x.toFixed(1));
      report.intensity = {
        label: `${target.measure === 'stories' ? `FAR ×${target.stories}` : 'Cover'} ${fmt(v)} / preferred ${fmt(target.preferredMin)}–${fmt(target.preferredMax)}`,
        value: v,
        state: st,
        band: {
          min: target.min,
          preferredMin: target.preferredMin,
          preferredMax: target.preferredMax,
          max: target.max,
        },
      };
    }

    // （shadow 模式已移除：现在是 legacy / planner / f3 三种）
    if (false) {
      overlay.surfaces.push(...feats.surfaces);
      overlay.solids.push(...feats.solids);
      overlay.paths.push(...feats.paths);
      overlay.props.push(...feats.props);
    }
  }

  stats.covered = byParcel.size;
  for (const [k, r] of reports) {
    const b = stats.byTypology[r.typology];
    if (b && r.covered) b.covered++;
    void k;
  }

  return { byParcel, reports, overlay, circulationDebug, circulationMode, stats };
}

/** 多边形环面积（带符号） */
function ringAreaOf(ring: { x: number; y: number }[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

/** 给 UI 用的一句话摘要 */
export function summarizeBundle(b: PlannerBundle): string {
  const byType = Object.entries(b.stats.byTypology)
    .map(([t, v]) => `${TYPOLOGY_LABEL[t as SiteTypology] ?? t} ${v.covered}/${v.total}`)
    .join('  ');
  return `Planner 接管 ${b.stats.covered}/${b.stats.total} 块 · ${byType}`;
}
