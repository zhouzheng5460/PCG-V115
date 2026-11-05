// 城市道路断面 / 街区尺度的**对照预设**（R-Scale 的 A/B/C 可复现开关）
//
// 默认值已经改成 C 组（见 `road/spec.ts` 与 `params.ts` 的 `block.spacingK`）。
// 这个模块保留的是"改之前的基线"和三组候选的**绝对表格** —— 它不读当前默认值，
// 而是各自写死一套，所以无论以后默认怎么调，`?scale=base|A|B|C` 都还能复现同一组对照。
//
// 用法（诊断 / 截图，不是生产路径）：
//   npx tsx test/scale-diag.ts            当前默认值下的诊断
//   npx tsx test/scale-shadow.ts          base / A / B / C 四组对照
//   http://localhost:5173/?scale=A        浏览器里看某一组
//
// ⚠ 全局可变状态。生产路径不调用它；`ROAD_SPECS` 的默认值才是唯一事实来源。

import { ROAD_SPECS, type RoadSpec } from './spec';
import type { RoadClass } from './system';

export type ScalePresetName = 'base' | 'A' | 'B' | 'C';

const CLASSES: RoadClass[] = ['arterial', 'collector', 'local'];

/** 模块加载时的默认值（= 已经应用好的 C 组），用于 reset */
const DEFAULT_SPECS: Record<RoadClass, RoadSpec> = JSON.parse(JSON.stringify(ROAD_SPECS));

/** 改之前的老断面：主干 28 / 次干 20 / 支路 10.5，六车道、缘石 18 m */
const OLD: Record<RoadClass, Partial<RoadSpec>> = {
  arterial: { redLine: 28, minRedLine: 24, lanes: 6, laneWidth: 3.5, sidewalk: 2.4, verge: 1.3, cornerRadius: 18 },
  collector: { redLine: 20, minRedLine: 17, lanes: 4, laneWidth: 3.5, sidewalk: 2.0, verge: 1.0, cornerRadius: 12 },
  local: { redLine: 10.5, minRedLine: 8.5, lanes: 2, laneWidth: 3.25, sidewalk: 1.5, verge: 0.5, cornerRadius: 6 },
};

/** 新断面：主干 24（四车道）/ 次干 18 / 支路 10.5，缘石 12 / 9 / 6 */
const NEW: Record<RoadClass, Partial<RoadSpec>> = {
  arterial: { redLine: 24, minRedLine: 20, lanes: 4, laneWidth: 3.5, sidewalk: 3.5, verge: 1.5, cornerRadius: 12 },
  collector: { redLine: 18, minRedLine: 15, lanes: 4, laneWidth: 3.25, sidewalk: 2.0, verge: 0.5, cornerRadius: 9 },
  local: { redLine: 10.5, minRedLine: 8.5, lanes: 2, laneWidth: 3.25, sidewalk: 1.5, verge: 0.5, cornerRadius: 6 },
};

export interface ScalePreset {
  name: ScalePresetName;
  label: string;
  spec: Record<RoadClass, Partial<RoadSpec>>;
  spacingK: number;
}

export const SCALE_PRESETS: Record<ScalePresetName, ScalePreset> = {
  base: { name: 'base', label: '基线（旧断面 + k 1.5）', spec: OLD, spacingK: 1.5 },
  A: { name: 'A', label: 'A · 只改断面（24/18/10.5）+ k 1.5', spec: NEW, spacingK: 1.5 },
  B: { name: 'B', label: 'B · 只改街区（k 1.6）+ 旧断面', spec: OLD, spacingK: 1.6 },
  C: { name: 'C', label: 'C · 组合（24/18/10.5 + k 1.6）= 当前默认', spec: NEW, spacingK: 1.6 },
};

/** 复位到当前默认断面 */
export function resetRoadSpecs(): void {
  for (const c of CLASSES) Object.assign(ROAD_SPECS[c], DEFAULT_SPECS[c]);
}

/**
 * 应用预设（绝对表格，不依赖当前默认值）。
 *
 * 必须在**构造 Model 之前**调用：Model 的路宽默认值就是从 `ROAD_SPECS` 取的。
 */
export function applyScalePreset(name: ScalePresetName): { spacingK: number } {
  resetRoadSpecs();
  const p = SCALE_PRESETS[name] ?? SCALE_PRESETS.C;
  for (const c of CLASSES) Object.assign(ROAD_SPECS[c], p.spec[c]);
  return { spacingK: p.spacingK };
}

export function isScalePreset(v: string | null): v is ScalePresetName {
  return v === 'base' || v === 'A' || v === 'B' || v === 'C';
}
