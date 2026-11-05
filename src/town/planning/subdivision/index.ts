// F2 · 地块分割统一出口
//
// 外部只从这一个文件 import。策略、契约、验证、装配都是内部结构。

export * from './types';
export { obbOf, splitSurfaceByLine, sharedBoundaryLength, makeRng, normalizeAxis } from './geom';
export { metricsOf, isFragment } from './metrics';
export { frontagesOf, roadAccessOf, alleyAccessOf, sharedBoundaryWith } from './relations';
export { validatePartition } from './validate';
export { assemble } from './assemble';
export { mergeFragments } from './repair';
export { makeContext, makeRoadEdge, contextFromSite, defaultParams, siteAreaM2 } from './context';
export {
  STRATEGIES,
  strategyById,
  runStrategy,
  runAll,
  runFromLeaves,
  fingerprint,
  RecursiveObbStrategy,
  StreetFrontOffsetStrategy,
} from './registry';
