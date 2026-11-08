// F2.5-C.2 · 网络统一节点化
//
// 混合方案最大的坑是"两张独立路网直接叠加"：主路是张量场出来的流线，支路是
// Voronoi 出来的切线，两者各自有一套端点。叠上去之后：
//   · 支路的端头停在主路边 3~8 m 外，图上就是"路断在半空"；
//   · 主路在支路接入处没有节点，于是视觉上一条街被另一条"搭"着，拓扑上却毫不相干。
//
// 所以这里做两件事：
//   ① 悬挂端吸附：支路端头在容差内 → 投影到目标线上，并把投影点**插进目标线的点序列**
//      （这样后面 buildGraph 的 T 口打断才会真的在那个位置生成节点）
//   ② 剪掉仍然悬挂的断头（只有接不到任何东西的短支路才会被剪）

import { Pt } from '../../../../core/geom';
import type { PlanSurface } from '../../core/surface';
import { distToRingsU } from '../primal';
import type { CutLine } from '../graph';

export interface AttachRecord {
  from: string;
  to: string;
  at: Pt;
  gapM: number;
}

export interface AttachResult {
  lines: CutLine[];
  records: AttachRecord[];
}

/**
 * 把悬挂端接到最近的线上。
 *
 * 只处理"不在红线上"的端头 —— 落在红线上的端头是外部接入，把它拽走会毁掉出入口。
 */
export function attachEnds(lines: CutLine[], boundary: PlanSurface, tolM = 14): AttachResult {
  const work = lines.map((l) => ({ ...l, pts: l.pts.map((p) => new Pt(p.x, p.y)) }));
  const records: AttachRecord[] = [];
  const tol = tolM / 7;
  const onBoundary = (p: Pt): boolean => distToRingsU(p, [boundary.outer]) * 7 <= 3;

  // 最多两轮：第一轮接主路，第二轮让"刚接上的线"也能当目标
  for (let pass = 0; pass < 2; pass++) {
    let changed = false;
    for (const li of work) {
      if (li.pts.length < 2) continue;
      for (const which of ['start', 'end'] as const) {
        const idx = which === 'start' ? 0 : li.pts.length - 1;
        const p = li.pts[idx];
        if (onBoundary(p)) continue;

        let best: { d: number; q: Pt; target: (typeof work)[number]; seg: number } | null = null;
        for (const lj of work) {
          if (lj === li) continue;
          for (let k = 0; k + 1 < lj.pts.length; k++) {
            const a = lj.pts[k];
            const b = lj.pts[k + 1];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const l2 = dx * dx + dy * dy;
            if (l2 < 1e-12) continue;
            let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
            t = Math.max(0, Math.min(1, t));
            const q = new Pt(a.x + dx * t, a.y + dy * t);
            const d = Pt.distance(p, q);
            if (d > tol || d < 1e-6) continue;
            if (!best || d < best.d) best = { d, q, target: lj, seg: k };
          }
        }
        if (!best) continue;

        // 投影点插进目标线的对应段（buildGraph 会在这里打断成节点）
        const tg = best.target.pts;
        const a = tg[best.seg];
        const b = tg[best.seg + 1];
        const nearA = Pt.distance(best.q, a) < 1e-6;
        const nearB = Pt.distance(best.q, b) < 1e-6;
        if (!nearA && !nearB) tg.splice(best.seg + 1, 0, best.q);
        else if (nearB) best.q.set(b);

        li.pts[idx] = new Pt(best.q.x, best.q.y);
        records.push({ from: li.id ?? '?', to: best.target.id ?? '?', at: best.q, gapM: +(best.d * 7).toFixed(2) });
        changed = true;
      }
    }
    if (!changed) break;
  }
  return { lines: work, records };
}

/** 悬挂端还剩几个（出图与报告用） */
export function danglingEnds(lines: CutLine[], boundary: PlanSurface, tolM = 3): number {
  let n = 0;
  for (const l of lines) {
    if (l.pts.length < 2) continue;
    for (const p of [l.pts[0], l.pts[l.pts.length - 1]]) {
      if (distToRingsU(p, [boundary.outer]) * 7 <= tolM) continue;
      let best = Infinity;
      for (const m of lines) {
        if (m === l) continue;
        for (let k = 0; k + 1 < m.pts.length; k++) {
          const a = m.pts[k];
          const b = m.pts[k + 1];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const l2 = dx * dx + dy * dy;
          if (l2 < 1e-12) continue;
          let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
          t = Math.max(0, Math.min(1, t));
          best = Math.min(best, Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)));
        }
      }
      if (best * 7 > 2.5) n++;
    }
  }
  return n;
}
