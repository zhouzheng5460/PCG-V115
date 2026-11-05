// F2.4-A · 建筑布局适配层出口
//
// 外部只从这里 import。这一层**只读** F2.1 的候选，不修改分割合同。

export * from './types';
export { U, toM, foldAxis, axisDeltaDeg, rectSurface, clearanceField, placeRect, vertexCentroid, inside } from './geom';
export { programFor, type Program, type SlotSpec, type Posture } from './program';
export { layoutParcel, defaultLayoutParams, summarize, doorReach, buildingInHole, type LayoutOpts } from './layout';
export { validateLayout, type ValidateOpts } from './validate';
