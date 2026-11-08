// F2.5 · 道路中心线系统
//
//   fracture  → 候选街区 + 候选切线（不是路）
//   access    → 合法接入点（真实城市道路 / 开口 / 只贴红线）
//   density   → 密度策略（服务距离、可布置路的最小跨度）
//   backbone  → 连通骨架（合并前锁定，合并阶段 protected）
//   select    → 挑出真正成为道路的线，定等级与路幅
//   graph     → 打断/吸附/清理/平滑 → 唯一权威的 RoadCenterlineGraph
//   regions   → 受约束合并 + 挖掉路、把还贴着的碎片合并成街区
//   diagnose  → 连通性诊断（断在哪、为什么断）
//   pipeline  → 上面全部串成一条可追溯的流水线
//
// 下游（道路面、路口、人行道、绿带、标线、GLB）只允许读 graph，不许反推。

export {
  CLASS_LABEL,
  CLASS_RANK,
  edgeLengthM,
  emptyGraph,
  graphLengthM,
  graphStats,
  reindex,
  type EdgeSource,
  type NodeType,
  type RoadClass,
  type RoadEdge,
  type RoadGraph,
  type RoadNode,
} from './types';
export { buildGraph, polyLen, segIntersect, type BuildOpts, type CutLine } from './graph';
export {
  centroidOf,
  fractureObb,
  fractureVoronoi,
  insideRing,
  sharedCuts,
  type Cell,
  type Cut,
  type Fracture,
  type ObbFractureOpts,
  type VoronoiFractureOpts,
} from './fracture';
export { classifyRoads, dominantAxis, STYLES, type ClassifyOpts, type ClassifyResult, type StyleId, type StylePreset } from './select';
export {
  buildRegions,
  mergeCells,
  metricsOf,
  quality,
  widthOfClass,
  type Block,
  type BlockNeighbor,
  type MergeOpts,
  type MergeResult,
  type Region,
  type RegionResult,
  type ShapeMetrics,
} from './regions';

// ---------------- F2.5-C.1 新增
export {
  ACCESS_RANK,
  accessPointsOf,
  boundaryAccessOf,
  closestOnSeg,
  distToAccessM,
  distToLinesM,
  distToSegmentM,
  projectToRing,
  type AccessKind,
  type AccessOpts,
  type AccessPoint,
} from './access';
export {
  buildCutTopology,
  componentsOf,
  distToRingsU,
  isClosedLoop,
  reconnectGain,
  type CutGeom,
  type CutTopology,
  type TopoComponent,
  type TopoEdge,
  type TopoNode,
  type TopoOpts,
} from './primal';
export { densityPolicy, roadableSpan, type DensityPolicy, type PolicyCtx } from './density';
export {
  buildBackbone,
  makeConnectivityGuard,
  maxServiceDistanceM,
  type Backbone,
  type BackboneEdge,
  type BackboneInput,
  type BackboneRole,
  type CellCoverage,
  type ConnectivityGuard,
  type GuardVerdict,
} from './backbone';
export {
  diagnose,
  type ComponentDiag,
  type ComponentVerdict,
  type CompoundDiag,
  type DiagInput,
  type DiagNode,
  type DiagEdge,
  type DiagResult,
  type KeyEdgeDiag,
  type NearMiss,
} from './diagnose';
export {
  DEFAULT_FRACTURE_SEED,
  runPipeline,
  type PipelineInput,
  type PipelineOpts,
  type PipelineResult,
} from './pipeline';
