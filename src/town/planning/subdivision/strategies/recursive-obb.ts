// F2.1-A · Recursive OBB（递归最小外接矩形切分）
//
// 与"沿最长边对半切"的区别，逐条对应任务书要求：
//   ① 方向来自**局部 OBB**，每一层都重新计算（子地块自己的 OBB，不是父的方向旋转 90°）；
//   ② 候选切线有多源：OBB 主/次轴、临街边方向、临街边法线、最长边界方向；
//   ③ 非均匀比例：按目标面积反推切点，并允许 ±jitter；
//   ④ 建筑适配：面宽/进深约束进停止条件（太窄不再切，够小不再切）；
//   ⑤ 不继续切分保留大型组团：固定建筑占比高的块直接封为 Compound；
//   ⑥ 失去合法入口的切法**主动拒绝**，换下一个候选；全都不可行就整块保留；
//   ⑦ 尖角 / 狭长残片进诊断（acuteCorners / bottleneck），并在修复阶段合并。
//
// 复用：`splitSurfaceByLine`（面级、留洞）、`surfaceIntersect`、`metricsOf`、`assemble`。
// 不重写：`modern.ts` 的 `bisectRing`（环级、丢洞、只取最大瓣）在本阶段不适用，已在审计里记录原因。

import { Pt } from '../../../../core/geom';
import { surfaceArea, surfaceIntersect, type PlanSurface } from '../../core/surface';
import { assemble, type LeafInput } from '../assemble';
import { centroidOf, extentAlong, makeRng, obbOf, splitSurfaceByLine } from '../geom';
import { frontagesOf, sharedBoundaryWith } from '../relations';
import { mergeFragments } from '../repair';
import type {
  ApplicabilityResult,
  CutRecord,
  PieceRole,
  StrategyDiagnostics,
  SubdivisionCandidate,
  SubdivisionContext,
  SubdivisionParams,
  SubdivisionStrategy,
} from '../types';
import { defaultParams, siteAreaM2 } from '../context';

const U = (m: number) => m / 7;

interface Cand {
  ang: number;
  ratio: number;
  label: string;
}

export class RecursiveObbStrategy implements SubdivisionStrategy {
  readonly id = 'recursive-obb';
  readonly label = 'Recursive OBB';

  diagnostics: StrategyDiagnostics = { axisHints: [], tree: null, notes: [] };

  supports(ctx: SubdivisionContext): ApplicabilityResult {
    const p = defaultParams(ctx.typology);
    const reasons: string[] = [];
    const area = siteAreaM2(ctx.boundary);
    if (ctx.boundary.outer.length < 3) {
      return { applicable: false, score: 0, reasons: ['边界退化（顶点 < 3）'] };
    }
    if (ctx.roadEdges.length === 0) {
      return { applicable: false, score: 0, reasons: ['无相邻道路边：任何切法都拿不到合法入口'] };
    }
    let score = 0.5;
    if (area >= p.targetAreaM2 * 2) {
      score += 0.25;
      reasons.push(`面积 ${area.toFixed(0)} m² ≥ 2×目标 ${p.targetAreaM2.toFixed(0)} m²，有递归空间`);
    } else if (area < p.minAreaM2 * 1.5) {
      score -= 0.35;
      reasons.push(`面积 ${area.toFixed(0)} m² 太小，切了只会出碎渣`);
    }
    const obb = obbOf(ctx.boundary.outer);
    if (obb) {
      const aspect = obb.w / Math.max(obb.d, 1e-9);
      if (aspect > 4) {
        score -= 0.1;
        reasons.push(`OBB 长宽比 ${aspect.toFixed(1)} 偏长条（更适合 Street-front Offset）`);
      } else {
        reasons.push(`OBB ${(obb.w * 7).toFixed(0)}×${(obb.d * 7).toFixed(0)} m，长宽比 ${aspect.toFixed(1)}`);
      }
    }
    if (ctx.boundary.holes.length > 0) reasons.push(`含 ${ctx.boundary.holes.length} 个洞：面级切分保留洞`);
    return { applicable: score >= 0.25, score: Math.max(0, Math.min(1, score)), reasons };
  }

  generate(ctx: SubdivisionContext, params: SubdivisionParams): SubdivisionCandidate[] {
    const d = defaultParams(ctx.typology);
    const p: SubdivisionParams = { ...d, ...params };
    const rng = makeRng(ctx.seed, `obb:${ctx.id}`);
    this.diagnostics = { axisHints: [], tree: null, notes: [] };

    const targetU2 = p.targetAreaM2 / 49;
    const minAreaU2 = p.minAreaM2 / 49;
    const minWidthU = U(p.minWidthM);
    const jitter = Math.max(0, Math.min(0.15, p.jitter ?? 0));
    const alleyU = U(p.alleyM);

    /** 叶子：切分结果的末梢 */
    const leaves: LeafInput[] = [];
    /** 每层节点（用于生成切分树） */
    const nodeOf = new Map<string, CutRecord>();

    /**
     * 有没有真实临街。
     *
     * 带缓存：同一块地在"方向 × 比例"的候选循环里会被反复问同一个问题，
     * 每次重算要走一遍边界采样（6 点/单位），一组候选下来能差 5~10 倍耗时。
     * 缓存键用**量化后的环坐标**，因此与几何一一对应，不影响确定性。
     */
    const accessMemo = new Map<string, boolean>();
    const hasRoadAccess = (s: PlanSurface): boolean => {
      const key = s.outer.map((q) => `${Math.round(q.x * 200)},${Math.round(q.y * 200)}`).join(';');
      const hit = accessMemo.get(key);
      if (hit !== undefined) return hit;
      const v = frontagesOf(s, ctx.roadEdges).some((f) => f.lengthM >= p.alleyM);
      accessMemo.set(key, v);
      return v;
    };

    /**
     * 一刀下去，两个（或更多）子块是否都站得住。
     *
     * 站得住 = ① 面积不是渣；② 有真实临街，或对侧有临街且共享边界够宽（巷接）。
     * 这是要求 ⑥ 的落点：**先验证再切**，而不是切完发现后排进不去再补一条假路。
     */
    const childrenOk = (a: PlanSurface[], b0: PlanSurface[]): { ok: boolean; why: string } => {
      const all = [...a, ...b0];
      for (const s of all) {
        const areaU2 = surfaceArea(s);
        if (areaU2 < minAreaU2 * 0.25) return { ok: false, why: `有子块仅 ${(areaU2 * 49).toFixed(0)} m²（渣）` };
        const obb = obbOf(s.outer);
        if (obb && obb.d < minWidthU * 0.7) {
          return { ok: false, why: `有子块短边 ${(obb.d * 7).toFixed(1)} m < ${(p.minWidthM * 0.7).toFixed(1)} m` };
        }
      }
      // 固定建筑不得被切开：一刀把某栋楼分到两侧，直接判这一刀不可行
      if (ctx.fixedBuildings.length > 0) {
        const interArea = (b: PlanSurface, side: PlanSurface[]): number => {
          let t = 0;
          for (const s2 of side) {
            try {
              const q = surfaceIntersect([b], [s2]);
              t += q.reduce((acc, r) => acc + surfaceArea(r), 0);
            } catch {
              /* 失败按 0 计，验证层会再查一次 */
            }
          }
          return t;
        };
        for (const b of ctx.fixedBuildings) {
          if (interArea(b, a) * 49 > 2 && interArea(b, b0) * 49 > 2) {
            return { ok: false, why: '这一刀会切开固定建筑' };
          }
        }
      }

      /**
       * 子块是否还有"合法的接入可能"。
       *
       * 判据不是"对侧必须直接临街"—— 那会让第三排永远切不出来（深地块的常态）。
       * 真正的前提是：**这一刀留下的缝够宽，能铺一条巷道**（≥ alleyM），
       * 剩下的链路问题交给装配阶段的巷接网络去解（BFS，可多跳）。
       */
      const side = (self: PlanSurface[], other: PlanSurface[]): boolean =>
        self.every((s) => hasRoadAccess(s) || other.some((o) => sharedBoundaryWith(s, o).lengthM >= p.alleyM));
      if (!side(a, b0)) return { ok: false, why: '正侧子块失去合法入口' };
      if (!side(b0, a)) return { ok: false, why: '负侧子块失去合法入口' };
      return { ok: true, why: '' };
    };

    /** 切分方向候选：多源 + 去重（15° 内视为同一方向） */
    const anglesFor = (s: PlanSurface, root: boolean): { ang: number; label: string }[] => {
      const out: { ang: number; label: string }[] = [];
      const obb = obbOf(s.outer);
      if (obb) {
        out.push({ ang: Math.atan2(obb.vy, obb.vx), label: 'OBB 次轴（垂直长边切）' });
        out.push({ ang: Math.atan2(obb.uy, obb.ux), label: 'OBB 主轴（顺长边切）' });
      }
      const fr = frontagesOf(s, ctx.roadEdges);
      if (fr.length > 0) {
        const f = fr[0];
        const dir = Math.atan2(f.edge[1].y - f.edge[0].y, f.edge[1].x - f.edge[0].x);
        out.push({ ang: dir, label: '临街方向（切出前后排）' });
        out.push({ ang: dir + Math.PI / 2, label: '临街法线（切分面宽）' });
      }
      // 最长边界边方向
      let bestLen = 0;
      let bestAng = 0;
      for (let i = 0; i < s.outer.length; i++) {
        const a = s.outer[i];
        const b = s.outer[(i + 1) % s.outer.length];
        const L = Pt.distance(a, b);
        if (L > bestLen) {
          bestLen = L;
          bestAng = Math.atan2(b.y - a.y, b.x - a.x);
        }
      }
      if (bestLen > 1e-6) out.push({ ang: bestAng, label: '最长边界方向' });

      const dedup: { ang: number; label: string }[] = [];
      for (const c of out) {
        const norm = ((c.ang % Math.PI) + Math.PI) % Math.PI;
        if (dedup.some((q) => Math.abs(q.ang - norm) < (15 * Math.PI) / 180)) continue;
        dedup.push({ ang: norm, label: c.label });
      }
      if (root) this.diagnostics.axisHints = dedup.map((q) => ({ ang: q.ang, label: q.label }));
      return dedup;
    };

    /**
     * 切点比例候选。
     *
     * 有固定建筑时额外加"建筑间隙"位置：把每栋楼投到刀口法线上得到各自的区间，
     * 相邻两栋之间的空隙中点就是天然的刀口 —— 这是"不切楼"能成立的前提。
     * 只靠 want/0.5/want±0.08 这几档，13 栋楼的地块上几乎找不到不压楼的一刀（实测 C01）。
     */
    const ratiosFor = (s: PlanSurface, ang: number, areaU2: number): number[] => {
      const base: number[] = [];
      if (p.ratio && p.ratio > 0.1 && p.ratio < 0.9) base.push(p.ratio);
      else {
        const want = Math.max(0.25, Math.min(0.75, (targetU2 * 1.0) / areaU2));
        base.push(want, 0.5, want + 0.08, want - 0.08);
      }
      const ext = extentAlong(s.outer, ang + Math.PI / 2);
      const ux = -Math.sin(ang);
      const uy = Math.cos(ang);
      if (ctx.fixedBuildings.length > 0 && ext.span > 1e-6) {
        const spans = ctx.fixedBuildings
          .map((b) => {
            let lo = Infinity;
            let hi = -Infinity;
            for (const q of b.outer) {
              const t = q.x * ux + q.y * uy;
              if (t < lo) lo = t;
              if (t > hi) hi = t;
            }
            return { lo, hi };
          })
          .filter((q) => Number.isFinite(q.lo))
          .sort((x, y) => x.lo - y.lo);
        for (let i = 0; i + 1 < spans.length; i++) {
          const gap = spans[i + 1].lo - spans[i].hi;
          if (gap < 1.2) continue; // ≈8.4 m 的间隙才值得切一刀
          const r = ((spans[i].hi + spans[i + 1].lo) / 2 - ext.lo) / ext.span;
          if (r > 0.1 && r < 0.9) base.push(r);
        }
      }
      const out: number[] = [];
      for (const r0 of base) {
        const r = Math.max(0.1, Math.min(0.9, r0 + (rng() - 0.5) * jitter * 2));
        if (!out.some((q) => Math.abs(q - r) < 0.02)) out.push(r);
      }
      return out;
    };

    const tryCut = (s: PlanSurface): { a: PlanSurface[]; b: PlanSurface[]; ang: number; ratio: number; label: string } | null => {
      const areaU2 = surfaceArea(s);
      const angs = anglesFor(s, leaves.length === 0);
      for (const { ang, label } of angs) {
        // 刀口方向 = ang；**刀口的位置要沿法线移动**。
        //
        // 这里踩过一个隐蔽的坑：最初把切点沿 `ang` 方向平移，而 `ang` 正是刀口自身的
        // 方向 —— 平移一个"在直线上的点"不改变直线，于是所有比例候选切出来的是同一条
        // 过质心的线，非均匀比例（要求④）等于没实现，整块地被等比等分（G01 每块都是 857 m²）。
        const nx = -Math.sin(ang);
        const ny = Math.cos(ang);
        const ext = extentAlong(s.outer, ang + Math.PI / 2); // 沿法线的跨度
        if (ext.span < 1e-3) continue;
        for (const ratio of ratiosFor(s, ang, areaU2)) {
          const c = centroidOf(s.outer);
          const projN = c.x * nx + c.y * ny;
          const want = ext.lo + ext.span * ratio;
          const off = want - projN;
          const at = new Pt(c.x + nx * off, c.y + ny * off);
          const cut = splitSurfaceByLine(s, at, ang);
          if (!cut) continue;
          // 布尔在退化输入上会吐出 0.0x m² 的碎屑：它是数值噪声，不是子地块。
          // 不过滤的话"渣"判据会把整刀否掉 —— 实测 R01 因此一刀都切不了。
          const a = cut.a.filter((q) => surfaceArea(q) > 0.01);
          const b = cut.b.filter((q) => surfaceArea(q) > 0.01);
          if (a.length === 0 || b.length === 0) continue;
          const chk = childrenOk(a, b);
          if (!chk.ok) {
            this.diagnostics.notes.push({
              code: 'cut-rejected',
              severity: 'info',
              message: `拒绝 ${label} @${(ratio * 100).toFixed(0)}%：${chk.why}`,
              at,
            });
            continue;
          }
          return { a, b, ang, ratio, label };
        }
      }
      return null;
    };

    const walk = (s: PlanSurface, depth: number, path: string, cut?: CutRecord): void => {
      const areaU2 = surfaceArea(s);
      const areaM2 = areaU2 * 49;
      const obb = obbOf(s.outer);
      const shortM = obb ? obb.d * 7 : 0;

      // 停止条件（每一条都要能解释）
      const stop = (why: string, role?: PieceRole) => {
        leaves.push({
          surface: s,
          cut,
          role,
          frame: obb ? { ang: Math.atan2(obb?.uy ?? 0, obb?.ux ?? 1), note: why } : undefined,
          notes: [{ code: 'kept-large', severity: 'info', message: `${path} 停止切分：${why}` }],
        });
      };

      if (areaM2 < p.minAreaM2 * 0.5) return stop(`仅 ${areaM2.toFixed(0)} m²`);
      if (depth >= p.maxRecursion) return stop(`达到递归上限 ${p.maxRecursion} 层`);
      if (areaM2 <= p.targetAreaM2 * 1.5) return stop(`${areaM2.toFixed(0)} m² 已接近目标 ${p.targetAreaM2.toFixed(0)} m²`);
      if (shortM > 0 && shortM < p.minWidthM * 1.1) return stop(`短边 ${shortM.toFixed(1)} m 已窄于 ${p.minWidthM} m`);

      // 固定建筑占比高 → 整块保留为 Compound（要求⑤：允许保留大型完整组团）
      if (ctx.fixedBuildings.length > 0) {
        let bArea = 0;
        for (const b of ctx.fixedBuildings) {
          try {
            const inter = surfaceIntersect([b], [s]);
            bArea += inter.reduce((acc, q) => acc + surfaceArea(q), 0);
          } catch {
            /* 计数在验证层统一读 */
          }
        }
        if (bArea / Math.max(1e-9, areaU2) > 0.35) {
          return stop(`固定建筑占 ${((bArea / areaU2) * 100).toFixed(0)}%，保留为组团`, 'compound');
        }
      }

      const cutRes = tryCut(s);
      if (!cutRes) {
        if (ctx.fixedBuildings.length > 0) {
          return stop(
            '所有候选刀口都会切开固定建筑 → 保留为组团（沿建筑间隙选刀属 F2.4 的内部道路协同）',
            'compound'
          );
        }
        return stop('没有任何可行的切法（方向 × 比例全部被拒绝）');
      }

      const rec: CutRecord = {
        id: path,
        depth,
        angle: cutRes.ang,
        ratio: cutRes.ratio,
        reason: `${cutRes.label} @ ${(cutRes.ratio * 100).toFixed(0)}%（${areaM2.toFixed(0)} m² → 目标 ${p.targetAreaM2.toFixed(0)} m²）`,
        beforeM2: areaM2,
        children: [],
      };
      nodeOf.set(path, rec);
      const childA = `${path}a`;
      const childB = `${path}b`;
      // 子区域几何指标：要求"切分树里能看清每一刀左右的面积与宽深"
      const sideSummary = (parts: PlanSurface[], label: string) => {
        const big = parts.reduce((x, y) => (surfaceArea(y) > surfaceArea(x) ? y : x));
        const ob = obbOf(big.outer);
        return {
          areaM2: +(parts.reduce((t, q) => t + surfaceArea(q), 0) * 49).toFixed(1),
          // OBB 短边（≈面宽）/ 长边（≈进深）
          widthM: ob ? +(ob.d * 7).toFixed(1) : 0,
          depthM: ob ? +(ob.w * 7).toFixed(1) : 0,
          note: parts.length > 1 ? `${label} ${parts.length} 块（凹形切开）` : label,
        };
      };
      const sa = sideSummary(cutRes.a, '正侧');
      const sb = sideSummary(cutRes.b, '负侧');
      rec.children = [
        { id: childA, ...sa },
        { id: childB, ...sb },
      ];

      // 凹多边形一刀可能切出多块：每块都继续走，但**不复制**同一份 CutRecord
      cutRes.a.forEach((part, i) => walk(part, depth + 1, i === 0 ? childA : `${childA}.${i}`, rec));
      cutRes.b.forEach((part, i) => walk(part, depth + 1, i === 0 ? childB : `${childB}.${i}`, rec));
    };

    walk(ctx.boundary, 0, 'root');

    this.diagnostics.tree = nodeOf.get('root') ?? null;

    // 修复阶段：可合并的小残片并入共享边界最长的兄弟（连通才合）
    const repair = mergeFragments(leaves, p, ctx);
    if (repair.merged > 0) {
      this.diagnostics.notes.push({
        code: 'fragment-merged',
        severity: 'info',
        message: `碎片修复：${repair.merged} 块小残片并入相邻地块（连通合并）`,
      });
    }

    const { candidates, notes } = assemble(ctx, p, this.id, repair.leaves);
    this.diagnostics.notes.push(...notes);
    return candidates;
  }
}
