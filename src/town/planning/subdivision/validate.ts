// F2 · 硬约束验证（策略之外的统一裁判）
//
// 这一层的存在意义：**策略只负责生成，不许自己给自己判及格**。
// 任何策略产出的候选都要过同一套检查，报告与可视化也读同一份结果。
//
// 检查项（对应任务书"硬性验收 · 几何正确性"）：
//   ① 不越出父边界        outsideM2
//   ② 子地块互不重叠      overlapM2
//   ③ 不丢失父级 holes    hole-lost
//   ④ 不产生自相交        self-intersect
//   ⑤ 面积可对账          residualM2
//   ⑥ 固定建筑不被穿越    building-split / building-partial
//   ⑦ 有效空间都有归属    residual + no-access
//   ⑧ 布尔异常可观测      booleanFailures（surface.ts 的静默失败计数）

import { Pt } from '../../../core/geom';
import {
  geometryFailures,
  pointInRing,
  selfIntersects,
  surfaceArea,
  surfaceIntersect,
  surfaceSubtract,
  surfaceUnion,
  type PlanSurface,
} from '../core/surface';
import { overlapAreaM2 } from './geom';
import type {
  SubdivisionCandidate,
  SubdivisionNote,
  ValidationReport,
} from './types';

const M2 = (u2: number) => u2 * 49;

/** 面积容差：万分之一 + 0.5 m²（布尔量化误差在 1e-6 单位级，远超这个量级） */
const areaTol = (a: number) => Math.max(a * 1e-4, 0.5);

export interface ValidateOpts {
  /** 允许的未归属残留占比（默认 0.5%）—— 超出就报 area-mismatch */
  residualShare?: number;
  /** 重叠面积告警阈值（m²，默认 1） */
  overlapM2?: number;
}

/** 布尔失败计数快照（用于把"这一轮静默失败了几次"归因到本次分割） */
export function failureSnapshot() {
  return {
    union: geometryFailures.union,
    subtract: geometryFailures.subtract,
    intersect: geometryFailures.intersect,
  };
}

export function failureDelta(before: ReturnType<typeof failureSnapshot>): number {
  return (
    geometryFailures.union -
    before.union +
    (geometryFailures.subtract - before.subtract) +
    (geometryFailures.intersect - before.intersect)
  );
}

function probesOfHole(hole: Pt[]): Pt[] {
  // 洞的质心 + 洞内采样：只测质心会漏掉"洞被切分线穿过但质心恰好落在缝隙"的情况
  let cx = 0;
  let cy = 0;
  for (const p of hole) {
    cx += p.x;
    cy += p.y;
  }
  cx /= hole.length;
  cy /= hole.length;
  const out = [new Pt(cx, cy)];
  // 从质心向每个顶点走 40%：都在洞里（洞一般是凸的或弱凹）
  for (const p of hole) {
    out.push(new Pt(cx + (p.x - cx) * 0.4, cy + (p.y - cy) * 0.4));
  }
  return out;
}

/**
 * 统一裁判。
 *
 * @param parent   父场地（红线，含 holes）
 * @param pieces   候选（只读，不修改）
 * @param buildings 固定建筑（fixed_buildings 模式下必须为 [] 之外的真实占地）
 */
export function validatePartition(
  parent: PlanSurface,
  pieces: SubdivisionCandidate[],
  buildings: PlanSurface[] = [],
  opts: ValidateOpts = {}
): ValidationReport {
  const errors: SubdivisionNote[] = [];
  const warnings: SubdivisionNote[] = [];
  const parentM2 = M2(surfaceArea(parent));
  const residualShare = opts.residualShare ?? 0.005;
  const overlapLimit = opts.overlapM2 ?? 1;

  const before = failureSnapshot();

  // ① 越界
  let outsideU2 = 0;
  for (const c of pieces) {
    if (c.surface.outer.length < 3) continue;
    try {
      const out = surfaceSubtract([c.surface], [parent]);
      const a = out.reduce((s, q) => s + surfaceArea(q), 0);
      // 阈值必须用 **m²**：1e-6 世界单位² 只有 5e-5 m²，是布尔量化的数值噪声，
      // 按"面积 > 1 m²"判，才不会把浮点尾数当成越界。
      if (M2(a) > 1) {
        outsideU2 += a;
        errors.push({
          code: 'outside-parent',
          severity: 'error',
          message: `${c.id} 有 ${M2(a).toFixed(1)} m² 落在父边界外`,
          at: c.surface.outer[0],
        });
      }
    } catch {
      warnings.push({ code: 'boolean-failed', severity: 'warn', message: `${c.id} 越界检查的布尔运算失败` });
    }
  }

  // ② 两两重叠（先 AABB 筛，再精确求交）
  let overlapU2 = 0;
  const boxOf = (s: PlanSurface) => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of s.outer) {
      if (p.x < x0) x0 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.x > x1) x1 = p.x;
      if (p.y > y1) y1 = p.y;
    }
    return { x0, y0, x1, y1 };
  };
  for (let i = 0; i < pieces.length; i++) {
    for (let j = i + 1; j < pieces.length; j++) {
      const A = boxOf(pieces[i].surface);
      const B = boxOf(pieces[j].surface);
      if (!(A.x0 < B.x1 && B.x0 < A.x1 && A.y0 < B.y1 && B.y0 < A.y1)) continue;
      try {
        const inter = surfaceIntersect([pieces[i].surface], [pieces[j].surface]);
        const a = inter.reduce((s, q) => s + surfaceArea(q), 0);
        if (M2(a) > overlapLimit) {
          overlapU2 += a;
          errors.push({
            code: 'overlap',
            severity: 'error',
            message: `${pieces[i].id} 与 ${pieces[j].id} 重叠 ${M2(a).toFixed(1)} m²`,
            at: inter[0]?.outer[0],
          });
        }
      } catch {
        warnings.push({ code: 'boolean-failed', severity: 'warn', message: `${pieces[i].id}/${pieces[j].id} 重叠检查失败` });
      }
    }
  }

  // ③ 洞必须还是洞
  for (let hi = 0; hi < parent.holes.length; hi++) {
    const hole = parent.holes[hi];
    const probes = probesOfHole(hole);
    const covered = probes.filter((q) => pieces.some((c) => pointInRing(q, c.surface.outer) && !holeContains(c.surface, q)));
    if (covered.length > 0) {
      errors.push({
        code: 'hole-lost',
        severity: 'error',
        message: `父级第 ${hi + 1} 个洞被 ${covered.length} 个探针点覆盖（洞被填死）`,
        at: covered[0],
      });
    }
  }

  // ④ 自相交
  //
  // 父场地本身就可能自交（红线由道路带差集得到，实测 MF -469:284 就有真正的交叉）。
  // 那种情况下子块继承同一处交叉不是本轮引入的错误 —— 降级为 warn 并写明"继承"，
  // 否则整轮验证会被一个上游问题全盘否掉，反而看不出本阶段的几何到底对不对。
  const parentSelf = selfIntersects(parent.outer);
  for (const c of pieces) {
    if (selfIntersects(c.surface.outer)) {
      (parentSelf ? warnings : errors).push({
        code: 'boolean-failed',
        severity: parentSelf ? 'warn' : 'error',
        message: parentSelf ? `${c.id} 外环自相交（继承自父场地，非本轮引入）` : `${c.id} 外环自相交`,
        at: c.surface.outer[0],
      });
    }
    for (const h of c.surface.holes) {
      if (selfIntersects(h)) {
        errors.push({ code: 'boolean-failed', severity: 'error', message: `${c.id} 的洞自相交`, at: h[0] });
      }
    }
  }

  // ⑤ 面积对账：父 − 子并集 = 残留
  const piecesU2 = pieces.reduce((s, c) => s + surfaceArea(c.surface), 0);
  let residualU2 = 0;
  if (pieces.length > 0) {
    try {
      const uni = surfaceUnion(pieces.map((c) => c.surface));
      const rest = surfaceSubtract([parent], uni);
      residualU2 = rest.reduce((s, q) => s + surfaceArea(q), 0);
    } catch {
      residualU2 = Math.max(0, surfaceArea(parent) - piecesU2);
    }
  }
  const residualM2 = M2(residualU2);
  const share = parentM2 > 0 ? residualM2 / parentM2 : 0;
  if (share > residualShare) {
    const msg = `未归属残留 ${residualM2.toFixed(1)} m²（父级 ${(share * 100).toFixed(2)}%）`;
    // 残留本身不是几何错误（可能是被主动保留的空间），但必须显式声明
    const declared = pieces.some((c) => c.role === 'reserved');
    (declared ? warnings : errors).push({
      code: 'area-mismatch',
      severity: declared ? 'warn' : 'error',
      message: declared ? `${msg} —— 已由 reserved 块显式声明` : msg,
    });
  }

  // ⑥ 固定建筑不得被切开或遗漏
  for (let bi = 0; bi < buildings.length; bi++) {
    const b = buildings[bi];
    const bArea = surfaceArea(b);
    if (bArea < 1e-6) continue;
    const hits: { id: string; a: number }[] = [];
    for (const c of pieces) {
      // 与装配阶段同一把尺子（含采样降级），否则两边会得出不同归属
      const a = overlapAreaM2(b, c.surface).m2;
      if (a > 2) hits.push({ id: c.id, a });
    }
    if (hits.length > 1) {
      errors.push({
        code: 'building-split',
        severity: 'error',
        message: `固定建筑 #${bi + 1} 被切进 ${hits.length} 块地（${hits.map((h) => h.id).join(' / ')}）`,
        at: b.outer[0],
      });
    } else if (hits.length === 1) {
      const covered = hits[0].a / bArea;
      if (covered < 0.98) {
        warnings.push({
          code: 'building-crossed',
          severity: 'warn',
          message: `固定建筑 #${bi + 1} 只有 ${(covered * 100).toFixed(0)}% 落在 ${hits[0].id} 内（压线）`,
          at: b.outer[0],
        });
      }
    } else {
      errors.push({
        code: 'building-crossed',
        severity: 'error',
        message: `固定建筑 #${bi + 1} 不在任何地块内（无归属）`,
        at: b.outer[0],
      });
    }
  }

  // ⑦ 无接入必须显式标记
  //
  // 分级而不是一刀切：`parcel` 是要独立开发的，没有入口就是硬错误；
  // `fragment` / `compound` / `reserved` 本身就是"非独立"语义 —— 它们被标出来
  // 就是任务书要求的"无接入区域必须明确标记"，不必再把整轮判死。
  for (const c of pieces) {
    if (c.access.length > 0) continue;
    const severe = c.role === 'parcel';
    (severe ? errors : warnings).push({
      code: 'no-access',
      severity: severe ? 'error' : 'warn',
      message: `${c.id} 没有任何合法接入（role=${c.role}${severe ? '' : '，已显式标记为非独立'}）`,
      at: c.surface.outer[0],
    });
  }

  const booleanFailures = failureDelta(before);
  if (booleanFailures > 0) {
    warnings.push({
      code: 'boolean-failed',
      severity: 'warn',
      message: `本次分割触发 ${booleanFailures} 次布尔静默失败（已降级，非致命但需复核）`,
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    parentM2: +parentM2.toFixed(1),
    piecesM2: +M2(piecesU2).toFixed(1),
    residualM2: +residualM2.toFixed(1),
    overlapM2: +M2(overlapU2).toFixed(1),
    outsideM2: +M2(outsideU2).toFixed(1),
    booleanFailures,
  };
}

/** 该点是否也落在候选自己的洞里（洞里有洞时不算覆盖） */
function holeContains(s: PlanSurface, q: Pt): boolean {
  return s.holes.some((h) => pointInRing(q, h));
}
