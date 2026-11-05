// S1 · 场地布局编排器入口
//
// 对外只有两件事：
//   `generateSkeletonCandidates(ctx, mode)` —— 按开关产出骨架候选；
//   `s1Metrics(ctx, candidate)`            —— 可解释的度量（报告与测试用）。
//
// 开关与 R1.3/R1.4 同构：`off` / `golden` / `all`，默认 `off`。
// 默认关是有意的 —— 本轮是**三块 Golden 的方案对比**，不是全城换血。
// 打开方式：`?s1=golden`（浏览器）、`buildPlannerBundle(..., { s1: 'golden' })`。

import type { SiteContext } from '../core/types';
import type { SitePlanCandidate } from '../core/candidate';
import { buildSkeletons } from './builders';
import { emitPlan } from './emit';
import { selectPatterns } from '../patterns/registry';
import { s1Metrics } from './metrics';

/** 三个 Golden 的 patchKey */
export const S1_GOLDEN = new Set(['-469:284', '176:176', '252:-578']);

export type S1Mode = 'off' | 'golden' | 'all';
/** Pattern Registry 开关（与 s1 同构） */
export type PatternMode = 'off' | 'golden' | 'all';

/** 这块地该不该走 S1 */
export function s1Enabled(ctx: SiteContext, mode: S1Mode): boolean {
  if (mode === 'off') return false;
  if (mode === 'all') return true;
  return S1_GOLDEN.has(ctx.parcelId);
}

/**
 * 产出骨架候选。返回空数组 = 这套地没有 S1 方案（调用方应回落到原 archetype）。
 *
 * 不在这里排序：`generators.ts` 的出口会用**同一个** diagnostics + Evaluator
 * 统一打分排序，S1 不单独开一套尺子。
 */
export function generateSkeletonCandidates(
  ctx: SiteContext,
  mode: S1Mode = 'off',
  patternMode: PatternMode = 'off'
): SitePlanCandidate[] {
  if (!s1Enabled(ctx, mode)) return [];
  let specs = buildSkeletons(ctx);
  if (patternMode !== 'off' && s1Enabled(ctx, patternMode)) {
    // Pattern Registry 只做**筛选**：从类型库里选 2~3 套结构，
    // 再把 S1 已经能产出的那几种按选中顺序保留。
    // 一套都没映射上时**不硬删**（宁可多给一个候选，也不要因为映射表不全而整块地没有方案）。
    const { picks } = selectPatterns(ctx);
    const wanted = new Set(picks.map((p) => p.specId).filter((x): x is string => !!x));
    const keep = specs.filter((s) => s.patternId && wanted.has(s.patternId));
    if (keep.length > 0) specs = keep;
  }
  return emitAll(ctx, specs);
}

function emitAll(ctx: SiteContext, specs: ReturnType<typeof buildSkeletons>): SitePlanCandidate[] {
  const out: SitePlanCandidate[] = [];
  for (const spec of specs) {
    const cand = emitPlan(ctx, spec);
    if (cand) out.push(cand);
  }
  // **硬约束在这里真正生效**。
  //
  // S1 之前只把 `hard.ok` 写进度量、从不据此过滤 —— 也就是说"硬约束"只是报告，
  // 5% 覆盖率的工业方案照样能赢（S2.5 的 industrial Golden 就是这样）。
  // 现在：不通过 = 不可用，直接出局；一套都不剩就返回空数组，
  // 由 `generators.ts` 回落到原 archetype（合法的回退方案）。
  const ok = out.filter((c) => s1Metrics(ctx, c).hard.ok);
  return ok;
}

export { buildSkeletons } from './builders';
export { emitPlan } from './emit';
export { s1Metrics, type S1Metrics } from './metrics';
