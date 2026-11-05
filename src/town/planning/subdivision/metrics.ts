// F2 · 地块几何指标
//
// 全部输出**米 / 平方米**。理由：所有验收口径（面宽、进深、残片宽度、临街率）
// 在规范里都是米，内部世界单位只在计算中出现一次。

import {
  distToSurfaceEdge,
  surfaceAnchor,
  surfaceArea,
  type PlanSurface,
} from '../core/surface';
import { acuteCorners, minEdgeOf, obbOf, perimeterOf } from './geom';
import type { FrontageRef, PieceMetrics } from './types';

/** 面宽 / 进深的参考方向：策略把自己的局部 u 轴传进来 */
export interface MetricsFrame {
  ang: number;
  /** 局部 u 轴是否就是"沿街"（影响 width/depth 的命名） */
  note?: string;
}

function extentAlong(ring: ReadonlyArray<{ x: number; y: number }>, ang: number): number {
  const ux = Math.cos(ang);
  const uy = Math.sin(ang);
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of ring) {
    const t = p.x * ux + p.y * uy;
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  return hi - lo;
}

/**
 * 一块地的全部指标。
 *
 * `widthM / depthM` 与 `obbWM / obbDM` 是**两套口径**，故意都留着：
 *   · width/depth 来自策略的局部系（= 沿街 / 进深），是"规划意义"上的尺寸；
 *   · obbW/obbD 是纯几何的最小外接矩形，跨策略可比、可复现。
 * 报告里两者都列，避免拿一套数字论证另一套结论。
 */
export function metricsOf(piece: PlanSurface, frontages: FrontageRef[], frame?: MetricsFrame): PieceMetrics {
  const areaU2 = surfaceArea(piece);
  const perU = perimeterOf(piece);
  const obb = obbOf(piece.outer);

  let widthU = obb ? obb.w : 0;
  let depthU = obb ? obb.d : 0;
  if (frame && piece.outer.length >= 3) {
    widthU = extentAlong(piece.outer, frame.ang);
    // 进深 = 垂直于沿街方向的跨度
    depthU = extentAlong(piece.outer, frame.ang + Math.PI / 2);
    // 保证 depth ≥ width 的直觉顺序交给调用方判断，这里不强行交换
  }

  const anchor = surfaceAnchor(piece, 14);
  const bottleneckU = 2 * distToSurfaceEdge(anchor, piece);

  let holeArea = 0;
  for (const h of piece.holes) holeArea += Math.abs(surfaceArea({ outer: h, holes: [] }));

  const frontageU = frontages.reduce((s, f) => s + f.lengthM, 0) / 7;
  const minSide = Math.min(widthU, depthU);
  const maxSide = Math.max(widthU, depthU);

  return {
    areaM2: areaU2 * 49,
    perimeterM: perU * 7,
    widthM: widthU * 7,
    depthM: depthU * 7,
    obbWM: obb ? obb.d * 7 : 0,
    obbDM: obb ? obb.w * 7 : 0,
    aspect: minSide > 1e-9 ? maxSide / minSide : Infinity,
    compactness: perU > 1e-9 ? (4 * Math.PI * areaU2) / (perU * perU) : 0,
    bottleneckM: bottleneckU * 7,
    minEdgeM: minEdgeOf(piece) * 7,
    acuteCorners: acuteCorners(piece, 30),
    frontageM: frontageU * 7,
    frontageShare: perU > 1e-9 ? frontageU / perU : 0,
    holeCount: piece.holes.length,
    holeAreaM2: holeArea * 49,
  };
}

/** 残片判定：有明确阈值，不在别处再写一套 */
export function isFragment(m: PieceMetrics, minAreaM2: number, minWidthM: number): boolean {
  return m.areaM2 < minAreaM2 || m.bottleneckM < minWidthM;
}
