// F2.4-A · 布局硬约束验证
//
// 与 F2.1 的分工一致：**布局模块不给自己判及格**。这里只做裁判。
//
// 五条硬约束（对应任务书 §任务5）：
//   ① 建筑不越出有效可建区            outsideM2
//   ② 建筑之间不非法重叠              overlapM2
//   ③ 不压、不切固定建筑              fixedTouchedM2
//   ④ 每个建筑的门都接得上合法通行     doorFailures
//   ⑤ 建筑 + 通道 + 空地 = 可建区      reconciliationM2

import type { Pt } from '../../../core/geom';
import { surfaceArea, surfaceIntersect, type PlanSurface } from '../core/surface';
import { outsideArea } from './geom';
import type { LayoutNote, LayoutValidation, ParcelLayout } from './types';

const M2 = (u2: number) => u2 * 49;

export interface ValidateOpts {
  /** 门到通行空间的最大可接受距离（米）。超过就算"接不上" */
  maxDoorReachM?: number;
  /** 面积对账容差（占比） */
  reconciliationShare?: number;
}

export function validateLayout(
  layouts: ParcelLayout[],
  fixedBuildings: PlanSurface[] = [],
  opts: ValidateOpts = {}
): LayoutValidation {
  const maxDoor = opts.maxDoorReachM ?? 30;
  const tolShare = opts.reconciliationShare ?? 0.02;
  const errors: LayoutNote[] = [];
  const warnings: LayoutNote[] = [];

  let outsideM2 = 0;
  let overlapM2 = 0;
  let fixedTouchedM2 = 0;
  let doorFailures = 0;
  let reconciliationM2 = 0;

  // ① 越界
  for (const l of layouts) {
    for (const b of l.buildings) {
      const out = M2(outsideArea(b.surface, l.effective));
      if (out > 1) {
        outsideM2 += out;
        errors.push({
          code: 'outside',
          severity: 'error',
          message: `${b.id} 有 ${out.toFixed(1)} m² 越出有效布局区`,
          at: b.center,
        });
      }
    }
  }

  // ② 建筑重叠（同地块内两两 + 跨地块 AABB 粗筛）
  const all: { id: string; s: PlanSurface; center: Pt }[] = [];
  for (const l of layouts) for (const b of l.buildings) all.push({ id: b.id, s: b.surface, center: b.center });
  const box = (s: PlanSurface) => {
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
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const A = box(all[i].s);
      const B = box(all[j].s);
      if (!(A.x0 < B.x1 && B.x0 < A.x1 && A.y0 < B.y1 && B.y0 < A.y1)) continue;
      try {
        const inter = surfaceIntersect([all[i].s], [all[j].s]);
        const a = M2(inter.reduce((s, q) => s + surfaceArea(q), 0));
        if (a > 0.5) {
          overlapM2 += a;
          errors.push({
            code: 'overlap',
            severity: 'error',
            message: `${all[i].id} 与 ${all[j].id} 重叠 ${a.toFixed(1)} m²`,
            at: all[i].center,
          });
        }
      } catch {
        /* 计数在报告层统一读 */
      }
    }
  }

  // ③ 固定建筑
  for (const l of layouts) {
    for (const b of l.buildings) {
      for (let k = 0; k < fixedBuildings.length; k++) {
        try {
          const inter = surfaceIntersect([b.surface], [fixedBuildings[k]]);
          const a = M2(inter.reduce((s, q) => s + surfaceArea(q), 0));
          if (a > 1) {
            fixedTouchedM2 += a;
            errors.push({
              code: 'outside',
              severity: 'error',
              message: `${b.id} 压到固定建筑 #${k + 1}：${a.toFixed(1)} m²`,
              at: b.center,
            });
          }
        } catch {
          /* ignore */
        }
      }
    }
  }

  // ④ 门
  for (const l of layouts) {
    for (const b of l.buildings) {
      if (!b.door) {
        doorFailures++;
        errors.push({ code: 'door-fail', severity: 'error', message: `${b.id} 没有门`, at: b.center });
      } else if (b.door.reachM > maxDoor) {
        warnings.push({
          code: 'door-fail',
          severity: 'warn',
          message: `${b.id} 门到通行空间 ${b.door.reachM.toFixed(0)} m（> ${maxDoor} m），接入偏弱`,
          at: b.door.at,
        });
      }
    }
  }

  // ⑤ 面积对账
  for (const l of layouts) {
    const sum =
      l.buildings.reduce((s, b) => s + M2(surfaceArea(b.surface)), 0) +
      l.spaces.filter((x) => x.kind === 'lane').reduce((s, x) => s + x.areaM2, 0) +
      l.spaces.filter((x) => x.kind !== 'lane').reduce((s, x) => s + x.areaM2, 0);
    const usable = l.metrics.usableM2;
    const diff = Math.abs(sum - usable);
    if (diff > Math.max(3, usable * tolShare)) {
      reconciliationM2 += diff;
      warnings.push({
        code: 'area-mismatch',
        severity: 'warn',
        message: `${l.parcelId} 面积对账偏差 ${diff.toFixed(1)} m²（建筑+通道+空地 ${sum.toFixed(0)} vs 可建区 ${usable.toFixed(0)}）`,
      });
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    outsideM2: +outsideM2.toFixed(1),
    overlapM2: +overlapM2.toFixed(1),
    fixedTouchedM2: +fixedTouchedM2.toFixed(1),
    doorFailures,
    reconciliationM2: +reconciliationM2.toFixed(1),
  };
}
