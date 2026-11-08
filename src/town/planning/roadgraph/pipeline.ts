// F2.5-C.1 · 一条可追溯的流水线
//
// 出图、审计、Golden 断言必须走**同一个**入口，否则"图上的差异是算法改动
// 还是脚本口径不同"就说不清了。上一轮每个脚本各自拼一遍 run()，这一轮收敛到这里。
//
//   fracture → policy → backbone → merge(guarded) → classify → graph → regions → diagnose
//      cells/cuts      密度策略   连通骨架    受约束删除      等级/路幅   拓扑   街区     诊断
//
// `legacy: true` 复现 F2.5 第一轮的行为（无骨架、无策略、无守卫），
// 只用于"修复前 vs 修复后"的同视角对照 —— 不是可选项，是对照组的定义。

import { Pt } from '../../../core/geom';
import { surfaceArea, type PlanSurface } from '../core/surface';
import type { SiteRoadEdge } from '../core/types';
import { buildBackbone, makeConnectivityGuard, type Backbone } from './backbone';
import { boundaryAccessOf, accessPointsOf, type AccessPoint } from './access';
import { densityPolicy, type DensityPolicy } from './density';
import { diagnose, type DiagResult } from './diagnose';
import { fractureVoronoi, type Cut, type Fracture } from './fracture';
import { buildGraph } from './graph';
import { buildRegions, mergeCells, widthOfClass, type MergeResult, type RegionResult } from './regions';
import { classifyRoads, STYLES, type ClassifyResult, type StyleId, type StylePreset } from './select';
import { buildCutTopology } from './primal';
import type { CutLine } from './graph';
import type { RoadGraph } from './types';

const M2 = (u2: number) => u2 * 49;

export interface PipelineInput {
  id: string;
  boundary: PlanSurface;
  style: StyleId;
  /** 破碎密度：只决定 cell 大小，不再直接决定路网密度 */
  cellM2: number;
  seed?: number;
  /** 真实城市道路（真实地块才有） */
  roads?: SiteRoadEdge[];
  /** 上层给的车行开口 */
  entrances?: Pt[];
}

export interface PipelineOpts {
  /** 复现 F2.5 第一轮：无骨架 / 无策略 / 无守卫 */
  legacy?: boolean;
  /** 破碎随机种子 */
  fractureSeed?: number;
}

export interface PipelineResult {
  input: PipelineInput;
  style: StylePreset;
  access: AccessPoint[];
  policy: DensityPolicy;
  frac: Fracture;
  backbone: Backbone | null;
  merge: MergeResult;
  cls: ClassifyResult;
  graph: RoadGraph;
  topo: ReturnType<typeof buildCutTopology>;
  regions: RegionResult;
  diag: DiagResult;
  ms: { fracture: number; backbone: number; merge: number; graph: number; regions: number; diag: number; total: number };
}

export const DEFAULT_FRACTURE_SEED = 20261106;

export function runPipeline(inp: PipelineInput, opts: PipelineOpts = {}): PipelineResult {
  const style = STYLES[inp.style];
  const seed = opts.fractureSeed ?? DEFAULT_FRACTURE_SEED;
  const t0 = Date.now();

  const areaM2 = M2(surfaceArea(inp.boundary));
  const rings = [inp.boundary.outer, ...inp.boundary.holes];

  // ---------------- ① 破碎
  const count = Math.max(4, Math.min(52, Math.round(areaM2 / inp.cellM2)));
  const frac = fractureVoronoi(inp.boundary, { seed, count, minDistM: 0, relax: 3, jitter: 0.35 });
  const t1 = Date.now();

  // ---------------- ② 接入点 + 密度策略 + 连通骨架
  const realAccess = accessPointsOf(inp.boundary, { roads: inp.roads, entrances: inp.entrances });
  const access = realAccess.length > 0 ? realAccess : boundaryAccessOf(inp.boundary);
  const policy = densityPolicy(style, { boundary: inp.boundary, areaM2, access });

  const backbone = opts.legacy ? null : buildBackbone({ boundary: inp.boundary, cells: frac.cells, cuts: frac.cuts, access, policy });
  const t2 = Date.now();

  // ---------------- ③ 受约束合并
  const topo = backbone?.topo ?? buildCutTopology(
    frac.cuts.map((k) => ({ id: k.id, pts: [k.a, k.b] })),
    { boundary: rings, access }
  );
  // 密度策略判定"整片不需要内部路"时，路网连通性无从谈起（根本不会有路），守卫直接关掉
  const noRoadNeeded = !!backbone && backbone.protectedCuts.size === 0 && backbone.uncovered.length === 0;
  const guard = backbone && !noRoadNeeded ? makeConnectivityGuard(topo, frac.cuts.map((c) => c.id), new Set(backbone.protectedCuts.keys())) : undefined;

  const merge = mergeCells(frac, frac.cuts, {
    targetM2: style.blockM2,
    weakEdgeM: style.weakEdgeM,
    strongEdgeM: style.strongEdgeM,
    protectedCuts: backbone ? new Set(backbone.protectedCuts.keys()) : undefined,
    policy: backbone ? policy : undefined,
    guard,
    strictUnion: opts.legacy,
    // 骨架判定"整片不需要内部路"时，合并要能真的并干净，不能留残余边
    mergeAll: noRoadNeeded,
    inspect: guard
      ? (kept: Cut[]) => {
          const keptSet = new Set(kept.map((c) => c.id));
          const comps = componentsOfKept(topo, keptSet);
          const total = comps.reduce((s, c) => s + c.lengthM, 0);
          const isolatedCuts: string[] = [];
          for (const comp of comps) {
            /**
             * 两类要回收的碎段：
             *   ① 接不到外部（非法，必须消除）
             *   ② 接得到外部、但短于全网 28%（"法律上没错，但不该存在"）
             * 第二类是被合并切出来的断头路 —— 它既不成街区也不成系统，
             * 收回去（强制合并）比留在图上更诚实。
             */
            const isolated = !comp.onBoundary && !comp.hasAccess;
            const orphan = total > 1 && comp.lengthM < 0.28 * total;
            if (!isolated && !orphan) continue;
            for (const eid of comp.edges) {
              const cid = topo.edges.get(eid)?.cutId;
              if (cid && !isolatedCuts.includes(cid)) isolatedCuts.push(cid);
            }
          }
          return { isolatedCuts };
        }
      : undefined,
  });
  const t3 = Date.now();

  // ---------------- ④ 等级 / 路幅
  const cls = classifyRoads(merge.keptCuts, {
    style,
    boundaryRings: rings,
    areaM2,
    spineCuts: backbone ? new Set(backbone.protectedCuts.keys()) : undefined,
    accessAt: access.filter((a) => a.kind !== 'siteBoundary').map((a) => a.at),
  });

  // ---------------- ⑤ 中心线图
  const cutLines: CutLine[] = cls.cuts.map((k) => ({
    id: k.id,
    pts: [k.a, k.b],
    cls: k.cls,
    widthM: k.widthM ?? style.width[k.cls],
    source: 'fracture',
  }));
  const graph = buildGraph(cutLines, { boundary: rings, smooth: 2, minEdgeM: 8, snapM: 1.8 });
  const t4 = Date.now();

  // ---------------- ⑥ 街区
  const regions = buildRegions(inp.boundary, merge, (k: Cut) => k.widthM ?? widthOfClass(k.cls), { minPartM2: 60 });
  const t5 = Date.now();

  // ---------------- ⑦ 诊断
  const diag = diagnose({
    boundary: inp.boundary,
    cells: frac.cells,
    cuts: frac.cuts,
    kept: merge.keptCuts,
    access,
    graph,
    blocks: merge.blocks,
    blockOfCell: merge.blockOfCell,
    topo,
    minBlockWidthM: backbone ? policy.minBlockWidthM : undefined,
    pruned: graph.diagnostics
      ? { count: graph.diagnostics.prunedEdges, lengthM: graph.diagnostics.prunedLengthM, cuts: graph.diagnostics.droppedCuts }
      : undefined,
  });
  const t6 = Date.now();

  return {
    input: inp,
    style,
    access,
    policy,
    frac,
    backbone,
    merge,
    cls,
    graph,
    topo,
    regions,
    diag,
    ms: { fracture: t1 - t0, backbone: t2 - t1, merge: t3 - t2, graph: t4 - t3, regions: t5 - t4, diag: t6 - t5, total: t6 - t0 },
  };
}

/** 局部小工具：kept 集合的连通分量（避免把 primal 的复杂度带进管线） */
function componentsOfKept(topo: ReturnType<typeof buildCutTopology>, kept: Set<string>) {
  const seen = new Set<string>();
  const out: { nodes: string[]; edges: string[]; onBoundary: boolean; hasAccess: boolean; lengthM: number }[] = [];
  for (const nid of topo.nodes.keys()) {
    if (seen.has(nid)) continue;
    const stack = [nid];
    seen.add(nid);
    const ns: string[] = [];
    const es: string[] = [];
    let ob = false;
    let ha = false;
    while (stack.length) {
      const cur = stack.pop()!;
      ns.push(cur);
      const n = topo.nodes.get(cur)!;
      if (n.onBoundary) ob = true;
      if (n.accessId) ha = true;
      for (const eid of topo.adj.get(cur) ?? []) {
        const e = topo.edges.get(eid);
        if (!e || !kept.has(e.cutId)) continue;
        if (!es.includes(eid)) es.push(eid);
        const other = e.a === cur ? e.b : e.a;
        if (seen.has(other)) continue;
        seen.add(other);
        stack.push(other);
      }
    }
    if (es.length === 0) continue;
    let len = 0;
    for (const eid of es) len += topo.edges.get(eid)?.lengthM ?? 0;
    out.push({ nodes: ns, edges: es, onBoundary: ob, hasAccess: ha, lengthM: +len.toFixed(1) });
  }
  return out;
}
