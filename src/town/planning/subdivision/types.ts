// F2 · 统一地块分割契约（类型部分）
//
// 这一层只放**纯数据 + 接口**，不放任何算法：
//   · 策略只负责"生成候选"，约束验证 / 评分 / 可视化 / 落面全部在策略之外；
//   · 所有策略共用同一份候选合同，禁止各自维护互不兼容的字段。
//
// 与既有代码的关系：
//   · `PlanSurface` 复用 `planning/core/surface`（外环 + holes，全链路认洞）；
//   · `SiteRoadEdge` 复用 `planning/core/types`（真实道路边，含车道/人行道/分隔带）；
//   · typology 与面宽/进深默认值复用 `adapters/subdivide` 的 `SUBDIVIDE` 表。
//
// 语义分层（产品定位要求，不是法定宗地）：
//   Block（城市道路围合的街区） > Parcel（临街 + 接入 + 用途的地块）
//   > Fragment（地块内部功能子区） / Compound（多建筑组团） / ReservedSpace（主动保留）

import type { Pt } from '../../../core/geom';
import type { PlanSurface } from '../core/surface';
import type { AccessKind, FrontageRole, SiteRoadEdge, SiteTypology } from '../core/types';

/** 1 世界单位 = 7 m —— 全工程唯一的换算，禁止在策略内部另立口径 */
export const U = (m: number) => m / 7;
export const toM = (u: number) => u * 7;
export const M2 = (u2: number) => u2 * 49;
export const fromM2 = (m2: number) => m2 / 49;

/** 分割模式：固定建筑（用户建筑不可移动） / 空地生成 */
export type SubdivisionMode = 'fixed_buildings' | 'vacant';

/**
 * 地块语义角色。
 *
 * `fragment` 与 `parcel` 的区别不是面积，而是**能不能独立成立**：
 * fragment 没有自己的入口或面宽不足，只能作为父地块内部的功能子区存在。
 */
export type PieceRole = 'parcel' | 'fragment' | 'compound' | 'reserved';

/**
 * 一个待分割场地的完整输入。
 *
 * `boundary` 是**红线**（含洞）；`buildable` 是退线后的可建区。
 * 两者必须都给：分割要在红线上做（临街面与红线对齐），
 * 而"能不能建"要按可建区判。混用是本阶段要根治的一类错误。
 */
export interface SubdivisionContext {
  id: string;
  /** 父级（街区 / 上层地块）标识，写进候选的 parentId */
  parentId: string;
  typology: SiteTypology;
  mode: SubdivisionMode;
  boundary: PlanSurface;
  /** 退线后的可建区；无退线时等于 boundary */
  buildable: PlanSurface;
  /** **只含真正与本地块相邻**的城市道路边（不允许把街区所有外边界都塞进来） */
  roadEdges: SiteRoadEdge[];
  /** 固定建筑（用户已有建筑 / 不可移动障碍）：不得被切分线穿越 */
  fixedBuildings: PlanSurface[];
  /** 已有合法出入口（固定建筑模式下的既有接入，必须保留） */
  existingAccess?: { kind: AccessKind; at: Pt; from?: string }[];
  seed: number;
  notes: string[];
}

/** 策略参数：全部是"米 / 平方米"，进策略内部才换成世界单位 */
export interface SubdivisionParams {
  /** 目标地块面积（m²）：递归停止的主判据 */
  targetAreaM2: number;
  /** 目标沿街面宽（m）：Street-front Offset 的切分步长 */
  frontageM: number;
  /** 目标进深（m）：超过就被视为"深地块" */
  depthM: number;
  /** 小于它的碎块不允许独立成块（m²） */
  minAreaM2: number;
  /** 最小有效宽度（m）：低于它的视为狭长残片 */
  minWidthM: number;
  /** 长宽比上限：超过不切（已经是长条）或继续切（太胖）由策略自行解释 */
  maxAspect: number;
  /** 巷道 / 内部通道最小宽（m）：后排经共享边界接出的最低要求 */
  alleyM: number;
  /** 递归层数上限 */
  maxRecursion: number;
  /** 非均匀切分比例（0~1）：不填由策略按目标面积推 */
  ratio?: number;
  /** 街角地块加宽（m） */
  cornerBonusM?: number;
  /** 切点抖动比例（0~0.15）：0 = 严格几何，可复现 */
  jitter?: number;
  /** 后排处理：保留为 Compound / 继续按 OBB 切 */
  rearPolicy?: 'compound' | 'obb';
}

/** 策略适用性：不是"能不能跑"，而是"跑出来会不会比整块更好" */
export interface ApplicabilityResult {
  applicable: boolean;
  /** 0~1，仅用于多策略排序，不参与硬约束 */
  score: number;
  reasons: string[];
}

/** 一条真实临街关系 */
export interface FrontageRef {
  roadKey: string;
  cls: SiteRoadEdge['cls'];
  role: FrontageRole;
  /** 该地块与这条道路共享的边界长度（m） */
  lengthM: number;
  /** 占本地块周长的比例 */
  share: number;
  /** 落在地块环上的代表边（世界坐标） */
  edge: [Pt, Pt];
  /** 综合分（0~1）：口径与 core/context.ts 的 resolveFrontages 一致，只用于本层排序 */
  score: number;
  /**
   * true = 这条临街是**经相邻地块的共享边界**间接得到的（后排巷）。
   * 硬约束要求这种接入必须显式标记，不得伪装成道路临街面。
   */
  viaSibling?: string;
}

/** 一个接入点 */
export interface AccessRef {
  kind: AccessKind;
  at: Pt;
  /** 朝外法线（从地块指向接入对象） */
  normal: Pt;
  via: 'road' | 'alley' | 'existing';
  /** via='alley' 时的供体地块 id */
  viaPieceId?: string;
  /** alley 接入必须先建一条内部通道（服务对象必须可说明） */
  requiresInternalLane: boolean;
}

/** 几何指标：全部是米 / 平方米，便于与规范对齐 */
export interface PieceMetrics {
  areaM2: number;
  perimeterM: number;
  /** 沿策略局部 u 轴（通常 = 沿街方向）的跨度 */
  widthM: number;
  /** 沿 v 轴（进深方向）的跨度 */
  depthM: number;
  /** 最小面积外接矩形的短边（凹形地块上的"名义宽度"） */
  obbWM: number;
  /** 最小面积外接矩形的长边 */
  obbDM: number;
  /** 长宽比（大/小） */
  aspect: number;
  /** 4πA/P²，1 = 正圆，正方形 = π/4 ≈ 0.785 */
  compactness: number;
  /** 瓶颈宽度 = 2 × 最大内切圆半径（L 形地块的真正可用宽度） */
  bottleneckM: number;
  /** 最短边（m） */
  minEdgeM: number;
  /** 内角 < 30° 的尖角个数 */
  acuteCorners: number;
  /** 有效临街长度（m，只算真实道路） */
  frontageM: number;
  /** 临街长度 / 周长 */
  frontageShare: number;
  /** 洞的个数与最大洞面积（m²） */
  holeCount: number;
  holeAreaM2: number;
}

/** 诊断 / 修复 / 拒绝记录：每条都必须能落到"为什么" */
export type NoteCode =
  | 'no-access'
  | 'no-viable-cut'
  | 'sliver'
  | 'fragment-merged'
  | 'hole-preserved'
  | 'hole-lost'
  | 'building-split'
  | 'building-crossed'
  | 'outside-parent'
  | 'overlap'
  | 'area-mismatch'
  | 'boolean-failed'
  | 'corner-widened'
  | 'rear-compound'
  | 'alley-access'
  | 'access-rejected'
  | 'cut-rejected'
  | 'kept-large';

export interface SubdivisionNote {
  code: NoteCode;
  severity: 'info' | 'warn' | 'error';
  message: string;
  /** 出问题的位置（世界坐标），便于在图上标注 */
  at?: Pt;
}

/** 一次切分的记录（切分树的节点） */
export interface CutRecord {
  /** 节点 id（稳定，按路径编码：root / root.a / root.b） */
  id: string;
  depth: number;
  /** 这一刀的方向（弧度，刀口方向 = 切分线方向） */
  angle: number;
  /** 刀口在局部 u 轴上的相对位置（0~1） */
  ratio: number;
  /** 为什么在这里切（人话，写进报告） */
  reason: string;
  /** 切分前的面积（m²） */
  beforeM2: number;
  /** 两个子区域的指标摘要 */
  children: { id: string; areaM2: number; widthM: number; depthM: number; note: string }[];
}

/**
 * 分割候选。所有策略都只能产出这个结构 —— 数据合同唯一。
 */
export interface SubdivisionCandidate {
  id: string;
  parentId: string;
  /** 生成方法（策略 id） */
  method: string;
  /** 这次生成用的参数（写进报告，便于复现） */
  methodParams: Record<string, unknown>;
  /** 完整多边形（外环 + holes，都是世界坐标，CCW 外环） */
  surface: PlanSurface;
  /** 可建 / 可使用区域（已扣退线与固定建筑） */
  usable: PlanSurface;
  /** 真实临街关系（只含真实道路；巷接用 viaSibling 标） */
  frontages: FrontageRef[];
  access: AccessRef[];
  neighbors: { id: string; sharedBoundaryM: number }[];
  metrics: PieceMetrics;
  role: PieceRole;
  /** 能否独立开发（有接入 + 面积/宽度达标） */
  developable: boolean;
  notes: SubdivisionNote[];
  /** 生成树节点（只有递归类策略有） */
  cut?: CutRecord;
}

/** 硬约束验证结果 */
export interface ValidationReport {
  ok: boolean;
  errors: SubdivisionNote[];
  warnings: SubdivisionNote[];
  /** 父面积（m²） */
  parentM2: number;
  /** 子块面积和（m²） */
  piecesM2: number;
  /** 未被任何子块覆盖的残留（m²） */
  residualM2: number;
  /** 子块之间的非法重叠（m²） */
  overlapM2: number;
  /** 落到父边界外的面积（m²） */
  outsideM2: number;
  /** 布尔运算静默失败次数（union/subtract/intersect） */
  booleanFailures: number;
}

/** 策略的诊断输出（只用于报告与调试，不属于数据合同） */
export interface StrategyDiagnostics {
  /** 可选切分方向（给可视化用） */
  axisHints: { ang: number; label: string }[];
  /** 切分树（根节点） */
  tree: CutRecord | null;
  notes: SubdivisionNote[];
}

/**
 * 统一分割策略接口。
 *
 * 只做两件事：判断自己是否适用、生成候选。
 * 约束验证 / 评分 / 落面 / 审计一律在策略之外 —— 这是"可组合"的前提。
 */
export interface SubdivisionStrategy {
  readonly id: string;
  readonly label: string;
  supports(ctx: SubdivisionContext): ApplicabilityResult;
  generate(ctx: SubdivisionContext, params: SubdivisionParams): SubdivisionCandidate[];
  /** generate 之后读取；实现必须每次 generate 重置 */
  readonly diagnostics: StrategyDiagnostics;
}

/** 一次完整运行 = 候选 + 验证 + 统计 */
export interface SubdivisionRun {
  strategyId: string;
  strategyLabel: string;
  params: SubdivisionParams;
  candidates: SubdivisionCandidate[];
  validation: ValidationReport;
  axisHints: { ang: number; label: string }[];
  tree: CutRecord | null;
  notes: SubdivisionNote[];
  stats: {
    pieces: number;
    developable: number;
    fragments: number;
    /** 父场地面积（m²） */
    parentM2: number;
    /** 已归属子块面积（m²） */
    coveredM2: number;
    /** 有效临街比例（按块平均） */
    frontageShareMean: number;
    /** 残片面积占比（bottleneck < minWidth 或 area < minArea） */
    fragmentShare: number;
    /** 无任何接入的块数（显式标记，不计入可建） */
    unreachable: number;
    /** P50/P95 耗时（ms），由 runStrategy 在多轮采样后填 */
    msMedian: number;
    msP95: number;
  };
}
