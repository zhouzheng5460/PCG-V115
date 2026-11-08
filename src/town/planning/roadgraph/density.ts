// F2.5-C.1 · 道路密度策略
//
// 上一轮用"单一目标 Cell 面积"控制全部场景：规则矩形、楔形、工业地块都按同一个
// 面积切，结果楔形窄端被横路切断、工业大组团被切成碎块。这一轮换成**服务距离**：
//
//   硬指标：场地内任一点到"最近的道路或外部临街"的距离 ≤ serviceRadiusM
//   软指标：街区短边、形状质量、长短轴比 —— 合并后不能变成走廊
//
// 这两条能同时回答任务书 §4 的六个场景：
//   · 规则矩形 —— 中心点离外围街道远 → 自动补内部路
//   · 楔形 —— 窄端跨度小于 minRoadableSpanM，横路直接被判"不可行"
//   · L 形 —— 转折处离街道远 → 连通骨架在转折处落一条
//   · 带洞 —— 洞边不算外部接入（access.ts 只认红线），绕洞必须有真路
//   · 大型住宅 —— 半径小、允许连续主轴 + 少量分支
//   · 工业 —— 半径大、街区面积上限高，优先保持完整大组团
//
// 所有系数都是**可解释的乘法**，不是调参玄学；notes 会原样写进报告。

import { bboxOf } from '../core/surface';
import type { PlanSurface } from '../core/surface';
import type { AccessPoint } from './access';
import type { StyleId, StylePreset } from './select';

export interface DensityPolicy {
  style: StyleId;
  /** 场地内任一点到最近道路/外部临街的距离上限（米） */
  serviceRadiusM: number;
  /** 短于这个跨度的共享边不能成为道路（窄端不插横路） */
  minRoadableSpanM: number;
  /** 街区面积上限（m²）：超过就必须留一条路 */
  blockMaxM2: number;
  /** 街区面积下限（m²）：低于它优先合并 */
  blockMinM2: number;
  /** 合并后街区短边下限（米） */
  minBlockWidthM: number;
  /** 合并后形状质量下限（4πA/P²） */
  minShapeQ: number;
  /** 合并后长短轴比上限 */
  maxAspect: number;
  /** 场地自身的长宽比：窄长场地的地块本来就不可能方，用它放宽上限 */
  siteAspect: number;
  /** 判断依据（原样进报告） */
  notes: string[];
}

export interface PolicyCtx {
  boundary: PlanSurface;
  areaM2: number;
  access: AccessPoint[];
}

/**
 * `minRoadableSpanM`：一条共享边短到什么程度就"不该成为一段路"。
 *
 * 这个数只用来拦**真正的窄端**（两侧各留不出 6~8 m 进深的 10~22 m 跨度），
 * 不用来管"路网该多密"—— 那是 serviceRadiusM 的事。
 * 上一轮把它直接当密度旋钮用，才出现"窄端被横路切断、内部却没有主路"。
 */
const BASE: Record<StyleId, Omit<DensityPolicy, 'style' | 'notes' | 'siteAspect'>> = {
  organic: { serviceRadiusM: 40, minRoadableSpanM: 16, blockMaxM2: 6200, blockMinM2: 900, minBlockWidthM: 20, minShapeQ: 0.3, maxAspect: 4.6 },
  structured: { serviceRadiusM: 42, minRoadableSpanM: 16, blockMaxM2: 5000, blockMinM2: 700, minBlockWidthM: 22, minShapeQ: 0.34, maxAspect: 4.0 },
  campus: { serviceRadiusM: 85, minRoadableSpanM: 22, blockMaxM2: 16000, blockMinM2: 2600, minBlockWidthM: 32, minShapeQ: 0.26, maxAspect: 6.5 },
};

export function densityPolicy(style: StylePreset, ctx: PolicyCtx): DensityPolicy {
  const p: DensityPolicy = { style: style.id, ...BASE[style.id], siteAspect: 1, notes: [] };
  const bb = bboxOf(ctx.boundary.outer);
  const aspect = Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY) / Math.max(1e-6, Math.min(bb.maxX - bb.minX, bb.maxY - bb.minY));

  p.siteAspect = +aspect.toFixed(2);
  p.notes.push(
    `${style.id}：服务半径 ${p.serviceRadiusM} m / 不可布置路段的最小跨度 ${p.minRoadableSpanM} m / 街区上限 ${p.blockMaxM2} m² / 场地长宽比 ${aspect.toFixed(1)}`
  );

  if (ctx.areaM2 < 4500) {
    p.serviceRadiusM *= 1.12;
    p.blockMaxM2 *= 1.2;
    p.notes.push('小场地（<4500 m²）：外围街道已覆盖多数面积，内部路按最少量给');
  }
  if (aspect > 3.4) {
    p.serviceRadiusM *= 1.25;
    p.minRoadableSpanM += 4;
    p.notes.push(`长宽比 ${aspect.toFixed(1)}（条带/楔形）：不插横路，窄端交给外围街道`);
  }
  if (ctx.boundary.holes.length > 0) {
    p.serviceRadiusM *= 0.9;
    p.notes.push(`带洞 ${ctx.boundary.holes.length} 个：洞边不计外部接入，绕洞必须有真实道路`);
  }
  const cityRoads = ctx.access.filter((a) => a.kind === 'cityRoad').length;
  if (cityRoads > 0) {
    p.serviceRadiusM *= 0.95;
    p.notes.push(`真实城市道路开口 ${cityRoads} 处：主路可以直接落在红线上`);
  }

  p.serviceRadiusM = +p.serviceRadiusM.toFixed(1);
  p.blockMaxM2 = Math.round(p.blockMaxM2);
  p.minRoadableSpanM = +p.minRoadableSpanM.toFixed(1);
  return p;
}

/** 这条跨度能不能布一条路（窄端判据） */
export function roadableSpan(p: DensityPolicy, spanM: number): boolean {
  return spanM >= p.minRoadableSpanM;
}
