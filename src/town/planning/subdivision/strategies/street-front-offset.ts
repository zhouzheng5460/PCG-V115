// F2.1-B · Street-front Offset（临街带状切分）
//
// 定义（对齐 CityEngine 的 Offset Subdivision 思路，不是"再画一条矩形带"）：
//   ① 沿**真实临街边**向内 offset 出一个**不同进深的可用带域**（带域是真正的多边形，
//      斜边、梯形、凹边都由布尔求交得到，不假设矩形）；
//   ② 在带域内沿沿街方向按**面宽**切分，得到一排沿街地块；
//   ③ 剩余部分（后方）不硬切，保留为 Compound（大型建筑组团）；
//   ④ 街角地块加宽；小残片并回邻块。
//
// 本策略最容易被做错的一处，任务书里专门点名：
//   **不能把所有街区外边界视为道路。** 这里的带域只从 `ctx.roadEdges` 生成 ——
//   那些边由上游 `resolveFrontages` / Road Graph 给出，是真实相邻道路。
//   没有真实接入口的边不会被凭空补一条。
//
// 复用：`insetPerEdge` 的思路（半平面裁剪）在这里由 band 的四点构造 + 布尔求交代替，
// 因为带域需要在"整条街"上连续，而不是逐边内缩；`surfaceIntersect` 保留 holes。

import { Pt } from '../../../../core/geom';
import {
  bboxOf,
  surfaceArea,
  surfaceIntersect,
  surfaceSubtract,
  surfaceUnion,
  type PlanSurface,
} from '../../core/surface';
import { assemble, type LeafInput } from '../assemble';
import { makeRng, normalizeAxis } from '../geom';
import { frontagesOf } from '../relations';
import { mergeFragments } from '../repair';
import type {
  ApplicabilityResult,
  PieceRole,
  StrategyDiagnostics,
  SubdivisionCandidate,
  SubdivisionContext,
  SubdivisionParams,
  SubdivisionStrategy,
} from '../types';
import { defaultParams, siteAreaM2 } from '../context';
import { RecursiveObbStrategy } from './recursive-obb';

const U = (m: number) => m / 7;

interface Cluster {
  key: string;
  /** 沿街方向（u，弧度） */
  ang: number;
  /** 指向地块内部的法线 */
  nx: number;
  ny: number;
  edges: { a: Pt; b: Pt; key: string; cls: string; len: number }[];
  score: number;
  totalLen: number;
}

function centroidOf(s: PlanSurface): Pt {
  let x = 0;
  let y = 0;
  for (const p of s.outer) {
    x += p.x;
    y += p.y;
  }
  return new Pt(x / s.outer.length, y / s.outer.length);
}

export class StreetFrontOffsetStrategy implements SubdivisionStrategy {
  readonly id = 'street-front-offset';
  readonly label = 'Street-front Offset';

  diagnostics: StrategyDiagnostics = { axisHints: [], tree: null, notes: [] };

  supports(ctx: SubdivisionContext): ApplicabilityResult {
    const p = defaultParams(ctx.typology);
    const reasons: string[] = [];
    if (ctx.roadEdges.length === 0) {
      return { applicable: false, score: 0, reasons: ['无真实道路边：带域无从生成（不会虚构临街面）'] };
    }
    const clusters = this.cluster(ctx);
    if (clusters.length === 0) return { applicable: false, score: 0, reasons: ['道路边无法聚成有效临街带'] };
    let score = 0.45 + Math.min(0.3, clusters.length * 0.1);
    reasons.push(`${clusters.length} 条临街带（最长 ${(Math.max(...clusters.map((c) => c.totalLen)) * 7).toFixed(0)} m）`);
    const area = siteAreaM2(ctx.boundary);
    if (area > p.targetAreaM2 * 3) {
      score += 0.15;
      reasons.push(`面积 ${area.toFixed(0)} m² 足够排出多块沿街地块`);
    }
    if (clusters.length >= 2) {
      reasons.push('多面临街：可识别街角地块并加宽');
    }
    if (ctx.boundary.holes.length > 0) reasons.push(`含 ${ctx.boundary.holes.length} 个洞`);
    return { applicable: true, score: Math.min(1, score), reasons };
  }

  /** 把道路边聚成"临街带"：同一条 Voronoi 街的多段会并成一条 */
  private cluster(ctx: SubdivisionContext): Cluster[] {
    const c0 = centroidOf(ctx.boundary);
    const out: Cluster[] = [];
    for (const e of ctx.roadEdges) {
      const dx = e.b.x - e.a.x;
      const dy = e.b.y - e.a.y;
      const L = Math.hypot(dx, dy);
      if (L < 1e-6) continue;
      const ang = normalizeAxis(Math.atan2(dy, dx));
      let nx = -dy / L;
      let ny = dx / L;
      const mid = new Pt((e.a.x + e.b.x) / 2, (e.a.y + e.b.y) / 2);
      if ((c0.x - mid.x) * nx + (c0.y - mid.y) * ny < 0) {
        nx = -nx;
        ny = -ny;
      }
      let hit: Cluster | null = null;
      for (const c of out) {
        const dot = c.nx * nx + c.ny * ny;
        if (dot > 0.985) {
          hit = c;
          break;
        }
      }
      const w = e.cls === 'arterial' ? 1 : e.cls === 'collector' ? 0.72 : 0.46;
      if (!hit) {
        out.push({ key: e.key, ang, nx, ny, edges: [{ a: e.a, b: e.b, key: e.key, cls: e.cls, len: L }], score: w * L, totalLen: L });
      } else {
        hit.edges.push({ a: e.a, b: e.b, key: e.key, cls: e.cls, len: L });
        hit.score += w * L;
        hit.totalLen += L;
      }
    }
    out.sort((x, y) => y.score - x.score || x.key.localeCompare(y.key));
    return out;
  }

  generate(ctx: SubdivisionContext, params: SubdivisionParams): SubdivisionCandidate[] {
    const d = defaultParams(ctx.typology);
    const p: SubdivisionParams = { ...d, ...params };
    const rng = makeRng(ctx.seed, `off:${ctx.id}`);
    this.diagnostics = { axisHints: [], tree: null, notes: [] };

    const depthU = U(p.depthM);
    const frontageU = U(p.frontageM);
    const minAreaU2 = p.minAreaM2 / 49;
    const cornerBonusU = U(p.cornerBonusM ?? 0);

    const clusters = this.cluster(ctx);
    this.diagnostics.axisHints = clusters.map((c) => ({
      ang: c.ang + Math.PI / 2,
      label: `带状切分（沿街 ${c.edges.length} 段）`,
    }));

    const leaves: LeafInput[] = [];
    let claimed: PlanSurface[] = [];

    /**
     * 带域的裁剪底：**红线 − 固定建筑**。
     *
     * 固定建筑不能被"临街带"盖过去 —— 带域如果压着楼，后续按面宽的一切就落在一栋
     * 不能动的房子上。所以带域先让开建筑；建筑本体留在后方区域，由 Compound 承接，
     * 于是"楼完整地落在某一地块内"是构造保证的，不靠事后检查。
     */
    let bandBase: PlanSurface[] = [ctx.boundary];
    if (ctx.fixedBuildings.length > 0) {
      try {
        const rest = surfaceSubtract([ctx.boundary], ctx.fixedBuildings).filter((q) => surfaceArea(q) > 1e-6);
        if (rest.length > 0) bandBase = rest;
      } catch {
        this.diagnostics.notes.push({ code: 'boolean-failed', severity: 'warn', message: '扣除固定建筑失败，带域按整块红线走' });
      }
    }

    // ① 每条街生成带域：整条街一次成形，再裁到红线
    const bands: { cluster: Cluster; band: PlanSurface }[] = [];
    for (const c of clusters) {
      const quads: PlanSurface[] = [];
      for (const e of c.edges) {
        const dx = (e.b.x - e.a.x) / e.len;
        const dy = (e.b.y - e.a.y) / e.len;
        const m = 0.5; // 端点外延，同一条街的多段之间不留缝
        const a0 = new Pt(e.a.x - dx * m, e.a.y - dy * m);
        const b0 = new Pt(e.b.x + dx * m, e.b.y + dy * m);
        quads.push({
          outer: [
            a0,
            b0,
            new Pt(b0.x + c.nx * depthU, b0.y + c.ny * depthU),
            new Pt(a0.x + c.nx * depthU, a0.y + c.ny * depthU),
          ],
          holes: [],
        });
      }
      let bandParts: PlanSurface[] = [];
      try {
        bandParts = surfaceIntersect(surfaceUnion(quads), bandBase);
      } catch {
        this.diagnostics.notes.push({ code: 'boolean-failed', severity: 'warn', message: `临街带并集失败（${c.key}）` });
        continue;
      }
      // 后面的街要让开已被前面认领的部分（街角不重复计面积）
      if (claimed.length > 0 && bandParts.length > 0) {
        try {
          bandParts = surfaceSubtract(bandParts, claimed);
        } catch {
          /* 失败就保持原样，验证层会发现重叠 */
        }
      }
      bandParts = bandParts.filter((b) => surfaceArea(b) >= minAreaU2 * 0.5);
      if (bandParts.length === 0) continue;
      for (const b of bandParts) bands.push({ cluster: c, band: b });
      claimed = claimed.concat(bandParts);
    }

    if (bands.length === 0) {
      this.diagnostics.notes.push({ code: 'cut-rejected', severity: 'warn', message: '没有任何带域可用：整块保留' });
      const { candidates, notes } = assemble(ctx, p, this.id, [{ surface: ctx.boundary, role: 'reserved' }]);
      this.diagnostics.notes.push(...notes);
      return candidates;
    }

    // ② 每条带按面宽切分
    for (const { cluster, band } of bands) {
      const ux = Math.cos(cluster.ang);
      const uy = Math.sin(cluster.ang);
      const vx = cluster.nx;
      const vy = cluster.ny;
      const projU = (q: { x: number; y: number }) => q.x * ux + q.y * uy;
      const projV = (q: { x: number; y: number }) => q.x * vx + q.y * vy;

      let u0 = Infinity;
      let u1 = -Infinity;
      let v0 = Infinity;
      let v1 = -Infinity;
      for (const q of band.outer) {
        const a = projU(q);
        const b = projV(q);
        if (a < u0) u0 = a;
        if (a > u1) u1 = a;
        if (b < v0) v0 = b;
        if (b > v1) v1 = b;
      }
      const width = u1 - u0;
      if (width < frontageU * 0.5) {
        // 太短：整条带作为一块（沿街小店），而不是硬切成碎渣
        leaves.push({ surface: band, frame: { ang: cluster.ang } });
        continue;
      }

      const n = Math.max(1, Math.min(12, Math.round(width / frontageU)));
      const base = width / n;
      const widths: number[] = new Array(n).fill(base);

      // 街角加宽：哪一端更靠近别的街，就加宽那一端地块
      if (cornerBonusU > 0 && n >= 2) {
        const ends = [new Pt(u0 * ux + v0 * vx, u0 * uy + v0 * vy), new Pt(u1 * ux + v1 * vx, u1 * uy + v1 * vy)];
        let dLow = Infinity;
        let dHigh = Infinity;
        for (const oc of clusters) {
          if (oc === cluster) continue;
          for (const e of oc.edges) {
            for (const [idx, ep] of ends.entries()) {
              const dd = Math.min(Pt.distance(ep, e.a), Pt.distance(ep, e.b));
              if (idx === 0) dLow = Math.min(dLow, dd);
              else dHigh = Math.min(dHigh, dd);
            }
          }
        }
        const endIdx = dLow <= dHigh ? 0 : n - 1;
        if (Number.isFinite(dLow) || Number.isFinite(dHigh)) {
          widths[endIdx] += cornerBonusU;
          const sum = widths.reduce((s, w) => s + w, 0);
          for (let i = 0; i < n; i++) widths[i] *= width / sum;
          this.diagnostics.notes.push({
            code: 'corner-widened',
            severity: 'info',
            message: `街角地块加宽 ${p.cornerBonusM ?? 0} m（第 ${endIdx + 1}/${n} 块）`,
          });
        }
      }

      let cursor = u0;
      for (let i = 0; i < n; i++) {
        const uLo = cursor;
        const uHi = i === n - 1 ? u1 : cursor + widths[i];
        cursor = uHi;
        // 用"大矩形条"裁带域：得到的是真实多边形（斜边/梯形/凹边都保留）
        const m = 1.2;
        const strip: PlanSurface = {
          outer: [
            new Pt(uLo * ux + (v0 - m) * vx, uLo * uy + (v0 - m) * vy),
            new Pt(uHi * ux + (v0 - m) * vx, uHi * uy + (v0 - m) * vy),
            new Pt(uHi * ux + (v1 + m) * vx, uHi * uy + (v1 + m) * vy),
            new Pt(uLo * ux + (v1 + m) * vx, uLo * uy + (v1 + m) * vy),
          ],
          holes: [],
        };
        let parts: PlanSurface[] = [];
        try {
          parts = surfaceIntersect([strip], [band]).filter((q) => surfaceArea(q) > 1e-6);
        } catch {
          this.diagnostics.notes.push({
            code: 'boolean-failed',
            severity: 'warn',
            message: `第 ${i + 1} 条带裁剪失败（${cluster.key}）`,
          });
          continue;
        }
        if (parts.length === 0) continue;
        parts.sort((a, b) => surfaceArea(b) - surfaceArea(a));
        // 最大块 = 地块；其余（带域端部的碎角）= 残片，交给修复阶段
        leaves.push({ surface: parts[0], frame: { ang: cluster.ang } });
        for (let k = 1; k < parts.length; k++) {
          leaves.push({
            surface: parts[k],
            role: 'fragment',
            frame: { ang: cluster.ang },
            notes: [{ code: 'sliver', severity: 'warn', message: `带域端部碎角 ${(surfaceArea(parts[k]) * 49).toFixed(0)} m²` }],
          });
        }
      }
      void rng;
    }

    // ③ 后方：不硬切，保留为 Compound（大型建筑组团）
    const unionBands = (() => {
      try {
        return surfaceUnion(claimed);
      } catch {
        return claimed;
      }
    })();
    let rear: PlanSurface[] = [];
    try {
      // **不能按面积丢小块**：后方碎块里可能装着既有建筑，丢了它就"没有任何地块"了
      // （实测 C01 掉 3 栋、128 m² 无法对账）。小块的归并交给碎片修复阶段。
      rear = surfaceSubtract([ctx.boundary], unionBands).filter((q) => surfaceArea(q) > 1e-6);
    } catch {
      this.diagnostics.notes.push({ code: 'boolean-failed', severity: 'warn', message: '后方区域求差失败' });
    }
    rear.sort((a, b) => surfaceArea(b) - surfaceArea(a));
    for (const r of rear) {
      if (p.rearPolicy === 'obb' && surfaceArea(r) * 49 > p.targetAreaM2 * 1.2) {
        // 组合点：后方交给 OBB 继续切（F2.3 的雏形，只在这一个子区域上用）
        const subCtx: SubdivisionContext = { ...ctx, id: `${ctx.id}/rear`, parentId: ctx.parentId, boundary: r };
        const sub = new RecursiveObbStrategy().generate(subCtx, p);
        for (const c of sub) {
          leaves.push({ surface: c.surface, frame: c.cut ? { ang: c.cut.angle } : undefined });
        }
        this.diagnostics.notes.push({
          code: 'rear-compound',
          severity: 'info',
          message: '后方区域按 rearPolicy=obb 交给 Recursive OBB 继续切分',
        });
      } else {
        leaves.push({
          surface: r,
          role: 'compound',
          notes: [{ code: 'rear-compound', severity: 'info', message: `后方保留为组团 ${(surfaceArea(r) * 49).toFixed(0)} m²` }],
        });
      }
    }

    // ④ 碎片修复
    const repair = mergeFragments(leaves, p, ctx);
    if (repair.merged > 0) {
      this.diagnostics.notes.push({
        code: 'fragment-merged',
        severity: 'info',
        message: `碎片修复：${repair.merged} 块小残片并入相邻地块`,
      });
    }

    const { candidates, notes } = assemble(ctx, p, this.id, repair.leaves);
    this.diagnostics.notes.push(...notes);
    return candidates;
  }
}
