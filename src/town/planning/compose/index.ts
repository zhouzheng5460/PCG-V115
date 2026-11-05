// F2.4-B · 街区总平面合成 —— 对外出口
//
// 只导出"能用来跑一整个街区"的东西；内部打分与几何辅助不外露，
// 避免下游绕过合同直接调用打分函数（那会让"为什么是这个用途"变成死代码）。

export * from './types';
export { planParcels, composeSite, type ComposeOpts } from './compose';
export { proposeSkeletons, makeGates, deepRegion, frontStrips, buildRoads, synthesicEdges } from './roads';
export { assignFunctions, quotaFor } from './assign';
export { generateBuildings, gfaOf } from './buildings';
export { placeParking, parkingDemandOf } from './parking';
export { buildGround } from './ground';
export { validateComposition } from './validate';
