// F2 · 策略注册与统一运行器
//
// 运行器负责三件策略不该管的事：
//   ① 计时（P50/P95）—— 策略内部不埋点，避免各写一套；
//   ② 验证 —— 调 validatePartition，策略无权自评；
//   ③ 统计 —— 用同一口径从候选里聚合，报告与图表都读这一份。

import { validatePartition } from './validate';
import { assemble, type LeafInput } from './assemble';
import type {
  ApplicabilityResult,
  SubdivisionCandidate,
  SubdivisionContext,
  SubdivisionNote,
  SubdivisionParams,
  SubdivisionRun,
  SubdivisionStrategy,
} from './types';
import { RecursiveObbStrategy } from './strategies/recursive-obb';
import { StreetFrontOffsetStrategy } from './strategies/street-front-offset';
import { defaultParams } from './context';

export { RecursiveObbStrategy, StreetFrontOffsetStrategy };

/** 全部策略（顺序即默认优先级：OBB 先，Offset 后） */
export const STRATEGIES: SubdivisionStrategy[] = [new RecursiveObbStrategy(), new StreetFrontOffsetStrategy()];

export function strategyById(id: string): SubdivisionStrategy | undefined {
  return STRATEGIES.find((s) => s.id === id);
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function pct(list: number[], p: number): number {
  if (list.length === 0) return 0;
  const s = list.slice().sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return s[i];
}

export interface RunOpts {
  /** 计时轮数（默认 1；对照表用 15） */
  rounds?: number;
  /** 校验用的固定建筑（默认取 ctx.fixedBuildings） */
  buildings?: Parameters<typeof validatePartition>[2];
}

/** 跑一个策略：生成 + 验证 + 统计 */
export function runStrategy(
  strategy: SubdivisionStrategy,
  ctx: SubdivisionContext,
  params: SubdivisionParams = defaultParams(ctx.typology),
  opts: RunOpts = {}
): SubdivisionRun {
  const rounds = Math.max(1, opts.rounds ?? 1);
  const times: number[] = [];
  let candidates: SubdivisionCandidate[] = [];
  for (let i = 0; i < rounds; i++) {
    const t0 = now();
    candidates = strategy.generate(ctx, params);
    times.push(now() - t0);
  }

  const validation = validatePartition(ctx.boundary, candidates, opts.buildings ?? ctx.fixedBuildings);
  return buildRun(
    strategy.id,
    strategy.label,
    params,
    candidates,
    validation,
    times,
    strategy.diagnostics.axisHints.slice(),
    strategy.diagnostics.tree,
    strategy.diagnostics.notes.slice()
  );
}

/**
 * 直接用叶子面装配成一次运行（对照实验用）。
 *
 * 存在的意义：让"旧实现的切分结果"和"新策略"走**同一套**装配与验证，
 * 于是两者之间的差异只来自"怎么切"，不来自"怎么算临街 / 怎么判残片"。
 */
export function runFromLeaves(
  ctx: SubdivisionContext,
  params: SubdivisionParams,
  method: string,
  label: string,
  leaves: LeafInput[],
  opts: RunOpts = {}
): SubdivisionRun {
  const rounds = Math.max(1, opts.rounds ?? 1);
  const times: number[] = [];
  let candidates: SubdivisionCandidate[] = [];
  let notes: SubdivisionNote[] = [];
  for (let i = 0; i < rounds; i++) {
    const t0 = now();
    const a = assemble(ctx, params, method, leaves);
    times.push(now() - t0);
    candidates = a.candidates;
    notes = a.notes;
  }
  const validation = validatePartition(ctx.boundary, candidates, opts.buildings ?? ctx.fixedBuildings);
  return buildRun(method, label, params, candidates, validation, times, [], null, notes);
}

function buildRun(
  strategyId: string,
  strategyLabel: string,
  params: SubdivisionParams,
  candidates: SubdivisionCandidate[],
  validation: ReturnType<typeof validatePartition>,
  times: number[],
  axisHints: { ang: number; label: string }[],
  tree: SubdivisionRun['tree'],
  notes: SubdivisionNote[]
): SubdivisionRun {
  const parentM2 = validation.parentM2;
  const coveredM2 = candidates.reduce((s, c) => s + c.metrics.areaM2, 0);
  const fragM2 = candidates
    .filter((c) => c.role === 'fragment' || (!c.developable && c.role !== 'compound'))
    .reduce((s, c) => s + c.metrics.areaM2, 0);
  const shares = candidates.filter((c) => c.metrics.perimeterM > 0).map((c) => c.metrics.frontageShare);

  return {
    strategyId,
    strategyLabel,
    params,
    candidates,
    validation,
    axisHints,
    tree,
    notes,
    stats: {
      pieces: candidates.length,
      developable: candidates.filter((c) => c.developable).length,
      fragments: candidates.filter((c) => c.role === 'fragment').length,
      parentM2: +parentM2.toFixed(1),
      coveredM2: +coveredM2.toFixed(1),
      frontageShareMean: shares.length ? shares.reduce((a, b) => a + b, 0) / shares.length : 0,
      fragmentShare: parentM2 > 0 ? fragM2 / parentM2 : 0,
      unreachable: candidates.filter((c) => c.access.length === 0).length,
      msMedian: +pct(times, 50).toFixed(2),
      msP95: +pct(times, 95).toFixed(2),
    },
  };
}

/** 对所有声明适用的策略各跑一遍（F2.3 的候选选择留到下一阶段） */
export function runAll(
  ctx: SubdivisionContext,
  params: SubdivisionParams = defaultParams(ctx.typology),
  opts: RunOpts = {}
): { run: SubdivisionRun; applicability: ApplicabilityResult }[] {
  const out: { run: SubdivisionRun; applicability: ApplicabilityResult }[] = [];
  for (const s of STRATEGIES) {
    const ap = s.supports(ctx);
    if (!ap.applicable) {
      out.push({
        run: {
          strategyId: s.id,
          strategyLabel: s.label,
          params,
          candidates: [],
          validation: {
            ok: false,
            errors: [],
            warnings: [],
            parentM2: 0,
            piecesM2: 0,
            residualM2: 0,
            overlapM2: 0,
            outsideM2: 0,
            booleanFailures: 0,
          },
          axisHints: [],
          tree: null,
          notes: [],
          stats: {
            pieces: 0,
            developable: 0,
            fragments: 0,
            parentM2: 0,
            coveredM2: 0,
            frontageShareMean: 0,
            fragmentShare: 0,
            unreachable: 0,
            msMedian: 0,
            msP95: 0,
          },
        },
        applicability: ap,
      });
      continue;
    }
    out.push({ run: runStrategy(s, ctx, params, opts), applicability: ap });
  }
  return out;
}

/**
 * 结果指纹：只由"块数 + 每块面积（0.1 m² 精度）+ 临街长度"决定。
 * 同一输入同一 seed 必须一致 —— 这是"相同输入和 Seed 输出一致"的可执行判据。
 */
export function fingerprint(candidates: SubdivisionCandidate[]): string {
  const parts = candidates
    .map((c) => `${Math.round(c.metrics.areaM2 * 10)}:${Math.round(c.metrics.frontageM * 10)}`)
    .sort();
  return parts.join('|');
}
