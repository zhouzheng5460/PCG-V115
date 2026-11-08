// F2.4-D · 候选生成与择优
//
// 任务书第六节："建议每个地块最多生成 3 个候选，在其中选择视觉表现最好的一个"。
// 所以这里不再用单一评分选骨架，而是：
//   ① 把骨架候选（S0 / 车行主脊 / 步行主轴 / 脊+支）各自跑完整场地；
//   ② 用五项视觉评分排序；
//   ③ 全部保留，供出图对照（评审要看"两种可辨认的建筑群组合方式"）。

import { composeSite, type ComposeOpts } from './compose';
import { proposeSkeletons } from './roads';
import { sceneFromSite, type SiteScene } from './scene';
import { visualScore, type VisualScore } from './score';
import type { ComposeInput, SiteComposition } from './types';

export interface ComposeCandidate {
  /** 候选键（骨架 id） */
  key: string;
  label: string;
  comp: SiteComposition;
  scene: SiteScene;
  score: VisualScore;
  ms: number;
}

export interface CandidatesResult {
  inputId: string;
  cands: ComposeCandidate[];
  /** 被放弃的骨架 id 与原因 */
  skipped: { key: string; why: string }[];
}

/**
 * 生成候选。
 *
 * 骨架是唯一的"结构性"变量：同一份骨架下换分割策略，出来的图差异很小，
 * 而 S0 / 主脊 / 脊+支三种骨架出来的总平面完全是三种城市形态 ——
 * 评审要看的正是这个差别。所以候选按**骨架**去重，而不是按策略。
 */
export function composeCandidates(input: ComposeInput, opts: { max?: number; base?: ComposeOpts } = {}): CandidatesResult {
  const max = opts.max ?? 3;
  const sk = proposeSkeletons(input);
  const skipped: { key: string; why: string }[] = [];
  const cands: ComposeCandidate[] = [];

  // 排序：无路 → 单脊 → 步行/货运主轴 → 脊+支。稳定顺序便于复现
  const rank = (id: string) => (id === 'S0' ? 0 : id === 'S1' ? 1 : id === 'S1p' ? 2 : 3);
  const ordered = sk.slice().sort((a, b) => rank(a.id) - rank(b.id));

  for (const s of ordered) {
    if (cands.length >= max) {
      skipped.push({ key: s.id, why: `已满 ${max} 个候选` });
      continue;
    }
    const t0 = Date.now();
    try {
      const comp = composeSite(input, { ...opts.base, onlySkeleton: s.id });
      const scene = sceneFromSite(comp);
      const score = visualScore(comp, scene);
      cands.push({ key: s.id, label: s.label, comp, scene, score, ms: Date.now() - t0 });
    } catch (e) {
      skipped.push({ key: s.id, why: `生成失败：${(e as Error).message.slice(0, 80)}` });
    }
  }

  /**
   * 一栋建筑都没有的候选排在最后。
   *
   * 不是因为分数低（它的道路/地面分可能很高），而是因为它不成立 ——
   * 任务书的验收第一条就是"三个主要场地均能生成完整的场景"，
   * 一个没有建筑的"园区"没有交付价值。
   */
  const viable = (c: ComposeCandidate) => (c.comp.buildings.length > 0 ? 1 : 0);
  /** 硬约束通过优先：有 ERROR 的方案不管分数多高都不该被选中 */
  const clean = (c: ComposeCandidate) => (c.comp.validation.ok ? 1 : 0);
  cands.sort(
    (a, b) =>
      clean(b) - clean(a) || viable(b) - viable(a) || b.score.total - a.score.total || a.key.localeCompare(b.key)
  );
  return { inputId: input.id, cands, skipped };
}
