// F2 · 碎片修复（两个策略共用）
//
// "小残片合并"是分割系统的必要动作，但**不是每个策略各写一份**：
// 合并规则、连通性要求、合并顺序一旦不一致，两个策略的残片数字就不可比。
//
// 规则：
//   · 只看"残片"（面积 < minArea 或瓶颈宽 < minWidth），Compound / Reserved 不碰；
//   · 并入**共享边界最长的兄弟**；
//   · 只接受**连通合并**（union 后仍是一块）：断开的小块并进去会得到非连通多边形，
//     那比残片更糟，所以留在原地标成 fragment；
//   · 一轮一轮扫，最多 8 轮（防抖动循环），每轮只合一块，结果可复现。

import { surfaceUnion, type PlanSurface } from '../core/surface';
import type { LeafInput } from './assemble';
import { isFragment, metricsOf } from './metrics';
import { frontagesOf, sharedBoundaryWith } from './relations';
import type { SubdivisionContext, SubdivisionParams } from './types';

export interface MergeResult {
  leaves: LeafInput[];
  merged: number;
  /** 没合掉、留着当 fragment 的块数 */
  keptFragments: number;
}

export function mergeFragments(leaves: LeafInput[], p: SubdivisionParams, ctx: SubdivisionContext): MergeResult {
  const list = leaves.map((l) => ({ ...l }));
  let merged = 0;
  for (let guard = 0; guard < 8; guard++) {
    let changed = false;
    for (let i = 0; i < list.length; i++) {
      const li = list[i];
      if (li.role === 'compound' || li.role === 'reserved') continue;
      const m = metricsOf(li.surface, frontagesOf(li.surface, ctx.roadEdges), li.frame);
      if (!isFragment(m, p.minAreaM2, p.minWidthM)) continue;

      let bestJ = -1;
      let bestS = 0;
      for (let j = 0; j < list.length; j++) {
        if (j === i) continue;
        const s = sharedBoundaryWith(li.surface, list[j].surface).lengthM;
        if (s > bestS) {
          bestS = s;
          bestJ = j;
        }
      }
      if (bestJ < 0 || bestS < 1) continue;
      const mergedSurface = unionConnected(li.surface, list[bestJ].surface);
      if (!mergedSurface) continue;
      list[bestJ] = {
        ...list[bestJ],
        surface: mergedSurface,
        notes: [
          ...(list[bestJ].notes ?? []),
          {
            code: 'fragment-merged',
            severity: 'info',
            message: `并入残片 ${m.areaM2.toFixed(0)} m²（共享边界 ${bestS.toFixed(1)} m）`,
          },
        ],
      };
      list.splice(i, 1);
      merged++;
      changed = true;
      break;
    }
    if (!changed) break;
  }
  const keptFragments = list.filter((l) => {
    const m = metricsOf(l.surface, frontagesOf(l.surface, ctx.roadEdges), l.frame);
    return isFragment(m, p.minAreaM2, p.minWidthM);
  }).length;
  return { leaves: list, merged, keptFragments };
}

/** 两块并成一块；不成一块返回 null */
export function unionConnected(a: PlanSurface, b: PlanSurface): PlanSurface | null {
  try {
    const parts = surfaceUnion([a, b]);
    if (parts.length !== 1) return null;
    return parts[0];
  } catch {
    return null;
  }
}
