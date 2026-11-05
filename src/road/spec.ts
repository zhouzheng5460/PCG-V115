// 道路等级规范表。
//
// 依据：
//   CJJ 37-2012《城市道路工程设计规范》—— 分级、设计速度、车道宽、人行道宽、
//     交叉口缘石转弯半径；
//   GB 50180-2018《城市居住区规划设计标准》—— 居住区 / 小区路 / 组团路的红线与路面宽；
//   GB 5768《道路交通标志和标线》—— 哪些路口该画人行横道、停止线画多宽、导向箭头怎么放。
//
// 但**不能直接照抄大城市的数字**：本项目 1 单位 ≈ 7 m，城市半径 86 单位 ≈ 600 m，
// 街区中位边长 ≈ 85 m。这是"居住区 / 街坊"级别的尺度，主干道按 40 m 红线切
// 会把 85 m 的街区吃掉一半、城市直接散架。所以本表把规范里的**构成比例**搬到
// 这个尺度上：车道宽、人行道最小宽、绿化带宽、转弯半径都按真实米数取，
// 只把"红线总宽"落在 10.5 / 18 / 24 m 这三档（支路 / 次干路 / 主干路）。
// 每一档都能对上规范里相应等级的最小值，而不是随手拍的百分比。

import { clamp } from '../scene/types';
import type { RoadClass } from './system';

/** 1 单位 ≈ 7 m（车位 0.36×0.72 单位 = 2.5×5.0 m，正好卡在规范车位上） */
export const UNIT_M = 7;

/** 米 → 单位 */
export function u(meters: number): number {
  return meters / UNIT_M;
}

/** 单位 → 米 */
export function meters(units: number): number {
  return units * UNIT_M;
}

export interface RoadSpec {
  cls: RoadClass;
  label: string;
  short: string;
  /** 红线总宽（米）—— 两侧地块退让后的那一条缝 */
  redLine: number;
  /**
   * 红线最小宽（米）。低于这个宽度，路口缘石半径就画不出来了：
   * 人行道被压到 0，转角弧退化成斜切，街角会出现锯齿和尖角。
   * 车行道 + 两条最小人行道（1.2 m）+ 两条最小绿化带（0.5 m）。
   */
  minRedLine: number;
  /** 设计速度 km/h（CJJ 37 表 3.2.1，取该等级下限） */
  designSpeed: number;
  /** 双向车道数 */
  lanes: number;
  /** 单车道宽（米）—— CJJ 37 表 4.3.1 */
  laneWidth: number;
  /** 单侧人行道宽（米） */
  sidewalk: number;
  /** 单侧绿化带（行道树带）宽（米） */
  verge: number;
  /** 中央分隔带宽（米），0 = 只画双黄线 */
  median: number;
  /** 交叉口缘石转弯半径（米）—— CJJ 37 表 7.4.1 的最小值 */
  cornerRadius: number;
  /** 路口是否设人行横道（车行道太窄时不设，改画减速标线） */
  crossing: boolean;
  /** 两侧是否按规范布行道树 / 路灯 */
  streetFurniture: boolean;
  /** 行道树间距（米）—— 一般 6~8 m，行道树冠幅大时取上限 */
  treeSpacing: number;
  /** 路灯间距（米）—— 城市道路 25~35 m */
  lampSpacing: number;
}

/**
 * 三档断面。total 一项刻意等于 redLine —— 表格自洽才能保证"红线宽 = 各分项之和"，
 * 出现差额时下面的 fitSection 会把差额摊给人行道 / 绿化带。
 */
export const ROAD_SPECS: Record<RoadClass, RoadSpec> = {
  arterial: {
    cls: 'arterial',
    label: '主干路',
    short: '主',
    // 双向四车道：4 × 3.5 = 14 m 车行道 + 两侧各 3.5 m 人行道 + 1.5 m 绿化带 = 24 m
    //
    // 原来是 28 m / 六车道。在这个尺度（街区中位短边 107 m）上，六车道没有交通量
    // 支撑，却让每条主干道吃掉街区四分之一的边 —— 城市读起来像"被宽路围住的小岛"。
    // 降到四车道后车行道 14 m 仍然富余，人行道反而更宽（3.5 m），更像街道。
    redLine: 24,
    minRedLine: 20,
    designSpeed: 40,
    lanes: 4,
    laneWidth: 3.5,
    sidewalk: 3.5,
    verge: 1.5,
    median: 0,
    cornerRadius: 12,
    crossing: true,
    streetFurniture: true,
    treeSpacing: 8,
    lampSpacing: 28,
  },
  collector: {
    cls: 'collector',
    label: '次干路',
    short: '次',
    // 双向四车道：4 × 3.25 = 13 m 车行道 + 两侧各 2.0 m 人行道 + 0.5 m 绿化带 = 18 m
    redLine: 18,
    minRedLine: 15,
    designSpeed: 30,
    lanes: 4,
    laneWidth: 3.25,
    sidewalk: 2.0,
    verge: 0.5,
    median: 0,
    cornerRadius: 9,
    crossing: true,
    streetFurniture: true,
    treeSpacing: 8,
    lampSpacing: 30,
  },
  local: {
    cls: 'local',
    label: '支路',
    short: '支',
    // 双向两车道：2 × 3.25 = 6.5 m 车行道 + 两侧各 1.5 m 人行道 + 0.5 m 绿化带 = 10.5 m
    redLine: 10.5,
    minRedLine: 8.5,
    designSpeed: 20,
    lanes: 2,
    laneWidth: 3.25,
    sidewalk: 1.5,
    verge: 0.5,
    median: 0,
    cornerRadius: 6,
    // 车行道只有 6.5 m：行人横穿不需要斑马线，路口改画减速标线（GB 5768 只对
    // 交通量达到一定水平的道路要求人行横道）
    crossing: false,
    streetFurniture: true,
    treeSpacing: 8,
    lampSpacing: 32,
  },
};

export function specOf(cls: RoadClass): RoadSpec {
  return ROAD_SPECS[cls];
}

export interface FittedSection {
  sw: number;
  vg: number;
  md: number;
  carriage: number;
  lanes: number;
  laneWidth: number;
}

/**
 * 把规范的横断面装进"实际拿到的红线宽"里。
 *
 * 实际红线宽来自两条地块的内缩量之和，和等级的标称值不一定相等
 * （两条不同等级的路夹一个地块、或者是外圈被钳过的短边）。
 * 处理顺序：
 *   1. 车道宽先按标称取（不缩放，车道太窄会看不出是车）；
 *   2. 车道数按能塞下的最大偶数条算，但不超过等级上限；
 *   3. 剩下的宽度先给人行道（不低于 1.2 m 的可行走下限），再给绿化带；
 *   4. 还有富余就加宽人行道 —— 主干路红线宽时人行道本来就该宽。
 */
export function fitSection(cls: RoadClass, insetL: number, insetR: number): FittedSection {
  const spec = ROAD_SPECS[cls];
  const avail = Math.max(0.01, insetL + insetR);

  const laneW = u(spec.laneWidth);
  const swMin = u(1.2);
  const vgMin = 0;

  // 车道数：先按标称，再按可用宽度收紧
  let lanes = spec.lanes;
  let carriage = lanes * laneW;
  // 至少要给人行道留出两条最小宽度
  while (lanes > 2 && carriage + 2 * swMin > avail) {
    lanes -= 2;
    carriage = lanes * laneW;
  }
  if (avail < laneW * 2.6) {
    lanes = 1;
    carriage = Math.max(avail * 0.72, laneW * 0.9);
  }

  // 加宽：红线比以前宽出一对车道 + 两条标准人行道时，就加一对车道。
  //
  // 没有这一段的话，"把这条街调宽"只会长出两条巨宽的人行道 ——
  // 多出来的宽度全被下面的 `sw += half - sw - vg` 吃掉，车行道纹丝不动，
  // 用户看到的是"人行道变宽了"，而不是"路变宽了"。
  // 各等级标称红线宽正好等于 标称车道 + 人行道 + 绿化带，
  // 所以默认宽度下这里一次都不会触发，不会动到既有路网。
  while (lanes + 2 <= spec.lanes + 4 && avail >= (lanes + 2) * laneW + 2 * u(spec.sidewalk)) {
    lanes += 2;
    carriage = lanes * laneW;
  }

  let rest = avail - carriage;
  if (rest < 2 * swMin) {
    // 连人行道都放不下：把人行道压到最小值，车行道让一点
    carriage = Math.max(laneW * (lanes === 1 ? 0.9 : 2), avail - 2 * swMin);
    rest = Math.max(0, avail - carriage);
  }

  // 左右各一半。分给谁有先后：先人行道（有最小可行走宽度），再绿化带，
  // 还剩就都补给人行道 —— 红线宽的路，人行道本来就该宽。
  const half = rest / 2;
  let sw = Math.min(u(spec.sidewalk), half * 0.9);
  sw = Math.max(sw, Math.min(swMin, half * 0.9));
  let vg = Math.min(u(spec.verge), Math.max(0, half - sw));
  sw += Math.max(0, half - sw - vg);

  // 每侧不超过自己那半边的 92%（保证贴得住红线）
  const swL = Math.min(sw, insetL * 0.92);
  const swR = Math.min(sw, insetR * 0.92);
  const vgL = Math.min(vg, Math.max(0, insetL - swL) * 0.95);
  const vgR = Math.min(vg, Math.max(0, insetR - swR) * 0.95);
  const carL = Math.max(0, insetL - swL - vgL);
  const carR = Math.max(0, insetR - swR - vgR);
  const car = Math.max(carL + carR, 0.02);

  let n = lanes;
  let lw = car / n;
  while (n > 2 && lw < u(3.0)) {
    n -= 2;
    lw = car / n;
  }

  return { sw: Math.min(swL, swR), vg: Math.min(vgL, vgR), md: 0, carriage: car, lanes: n, laneWidth: lw };
}

/** 交叉口缘石转弯半径（单位），按等级给并受可用长度封顶 */
export function cornerRadius(cls: RoadClass, maxReach: number): number {
  const want = u(ROAD_SPECS[cls].cornerRadius);
  return clamp(Math.min(want, maxReach * 0.85), 0, want);
}
