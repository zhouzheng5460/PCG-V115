// F3-G · 建筑高度分层
//
// 之前 `layout.ts` 里同类建筑共用一个层数（`mid(预设区间)`），全城只有"到城市中心
// 的距离"这一个变量，鸟瞰就是一张等高线的毯子。这里把高度改成**由可观测条件插值**：
//
//   ① 用途        —— 层数区间全部取自 `DENSITY_PRESETS`（不凭空给数字）
//   ② 位置带      —— 临街 / 街角 / 内侧 / 核心 / 后巷 / 沿路独立小屋
//   ③ 街道等级    —— 主干道 > 次干道 > 支路，只影响临街界面
//   ④ 单栋体量    —— 面宽与占地越大越高（CBD 合并大栋的依据）
//   ⑤ 地块尺度    —— 大地块相对该用途的目标地块更大，允许更高
//   ⑥ 多中心可达性  —— landuse.ts 的 access（主中心 + 宽路廊道 + 次中心 + 区位场）
//
// 用户给的三条判据落在这里：
//   · CBD/商业中心：临街带 t 高 + 面宽加成 → 沿街又高又大；
//   · 普通商业：临街带 t 高、内侧带 t 低，且布局层**不在内侧放建筑**；
//   · 住宅小区：临街带 t 最低、内侧/核心带 t 最高 → 沿街低、中间高层。
//
// 我补充的（都是确定性的，没有随机抖动，逐条可在 `why` 里查到）：
//   A. 街角栋比同一排中间栋高（可视性/地价），沿街节奏是曲线而非锯齿；
//   B. 临主干道 +0.14、次干道 +0.06、支路 +0，街道等级真的进高度；
//   C. 工业是单层大跨，檐高按占地分三档，且**不随进城长高**（厂房高度由工艺定，
//      不是地价定），只对中心梯度保留 25% 的弱影响；
//   D. 园区/公共设施低层围合，只有核心带（主轴标志体量）拔高，不出塔楼；
//   E. 高度全部取整到区间插值，外扩有上界，不出现离谱高楼；
//   F. 材质/实体类型仍按用途固定，不随高度轮换（避免"看起来很花"而不是"有层次"）。

import { MAT } from '../scene/palette';
import type { SolidKind } from '../scene/types';
import { DENSITY_PRESETS, type BlockUse, type CityDensity, type RoadClass3 } from './types';

/** 建筑在地块里的位置带 */
export type HeightBand =
  | 'front' // 临街第一排
  | 'corner' // 临街排的两端（街角）
  | 'inner' // 内侧一排（不临街）
  | 'core' // 大地块内部路网围合的核心
  | 'back' // 后巷 / 后勤
  | 'solo'; // 不规则地块沿路填充的独立小屋

export interface HeightCtx {
  use: BlockUse;
  density: CityDensity;
  heightScale: number;
  /** 到城市中心的归一化距离 0~1 */
  centerDist: number;
  streetCls: RoadClass3;
  band: HeightBand;
  /** 这一栋的占地（m²） */
  footprintM2: number;
  /** 这一栋沿街面宽（m） */
  frontageM: number;
  parcelM2: number;
  /** 该用途在风貌预设里的目标地块面积中值（m²） */
  parcelTargetM2: number;
  /**
   * 综合可达性 0~1（landuse.ts 的多中心场）。
   * 传入后替代单一 centerDist 梯度；不传时回退旧口径，方便 `row` 模式对照。
   */
  access?: number;
  /** 位置相关的低频区位强度 -1~1（连续场，不是逐栋随机抖动） */
  localIntensity?: number;
}

export interface HeightOut {
  /** 世界单位（1 U = 7 m） */
  hU: number;
  floors: number;
  kind: SolidKind;
  wall: keyof typeof MAT;
  roof: keyof typeof MAT;
  /** 逐栋可解释：这一栋为什么是这个高度 */
  why: string;
}

const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));

/**
 * 位置带 → 区间插值系数 t（0 = 区间下沿，1 = 上沿）。
 * 住宅的 front/inner 是**反过来的**，这正是"沿街低、中间高"的落点。
 */
const BAND_T: Record<BlockUse, Record<HeightBand, number>> = {
  residential: { front: 0.08, corner: 0.26, inner: 0.82, core: 1.0, back: 0.62, solo: 0.12 },
  commercial: { front: 0.76, corner: 0.94, inner: 0.28, core: 0.55, back: 0.22, solo: 0.34 },
  cbd: { front: 0.7, corner: 0.9, inner: 0.42, core: 1.0, back: 0.34, solo: 0.44 },
  industrial: { front: 0.5, corner: 0.5, inner: 0.5, core: 0.5, back: 0.5, solo: 0.5 },
  campus: { front: 0.3, corner: 0.52, inner: 0.28, core: 0.78, back: 0.22, solo: 0.2 },
  civic: { front: 0.34, corner: 0.6, inner: 0.28, core: 0.74, back: 0.22, solo: 0.22 },
  park: { front: 0, corner: 0, inner: 0, core: 0, back: 0, solo: 0 },
  green: { front: 0, corner: 0, inner: 0, core: 0, back: 0, solo: 0 },
};

/** 街道等级：越高的等级，临街界面越高（只作用于 front / corner） */
const STREET_T: Record<RoadClass3, number> = { arterial: 0.14, collector: 0.06, local: 0 };

/**
 * 层数区间。全部从 `DENSITY_PRESETS` 的既有字段推导：
 *   · 住宅下探 2 层（沿街多层/底商）、上探 2 层（小区内圈高层）；
 *   · 商业上沿借用住宅层数（沿街商住楼），下沿保持商业预设；
 *   · CBD 下沿取塔楼区间下沿的一半（裙房），上沿就是塔楼上沿；
 *   · 园区/公共设施介于商业下沿与住宅下沿之间，只允许核心带拔高。
 */
function floorRange(use: BlockUse, d: (typeof DENSITY_PRESETS)[CityDensity]): [number, number] {
  switch (use) {
    case 'residential':
      return [Math.max(2, d.residentialFloors[0] - 2), d.residentialFloors[1] + 2];
    case 'commercial':
      return [d.commercialFloors[0], Math.max(d.commercialFloors[1], d.residentialFloors[1])];
    case 'cbd':
      return [Math.max(3, Math.round(d.towerFloors[0] * 0.55)), d.towerFloors[1]];
    case 'campus':
    case 'civic':
      return [d.commercialFloors[0], d.residentialFloors[0] + 2];
    default:
      return [1, 1];
  }
}

/**
 * 高度对区位的响应。
 *
 * 旧口径是 `cd < 0.55 ? 1 + (0.55-cd)*1.8 : 1`：一个 0.55 半径的硬折点、
 * 中心是外围 2 倍，且只吃到城市中心的距离 —— 这就是鸟瞰里那圈"生硬的梯形回落"。
 *
 * 新口径读 `landuse.ts` 的多中心可达性场：主中心是连续软核，宽路廊道和次中心
 * 会把高可达性带到外围，所以高度不再沿半径单调递减，也不再有折点。
 * 整体幅度 0.78~1.60 倍。这个梯度只乘**楼层数**，不再乘在层高上：
 * 旧版 `hU = floors × floorH × 梯度` 等于把每层拉高 / 压低（同一栋 6 层楼
 * 在市中心每层 4.6 m、外围 2.5 m），真实城市的差异体现在盖几层，层高由
 * 用途和密度预设给定。`heightScale` 是用户全局倍率，仍单独作用于最终高度。
 */
function gradient(ctx: HeightCtx): number {
  if (ctx.access === undefined) {
    const cd = clamp(ctx.centerDist, 0, 1);
    return cd < 0.55 ? 1 + (0.55 - cd) * 1.8 : 1;
  }
  const a = clamp(ctx.access, 0, 1);
  return 0.78 + 0.82 * a;
}

/** 按用途给固定的实体语法：材质**不随高度轮换**，只有 CBD 按高度分塔楼/裙房 */
function solidStyle(use: BlockUse, floors: number, lo: number, hi: number, band: HeightBand) {
  switch (use) {
    case 'cbd': {
      const isTower = floors >= Math.round(lo + 0.62 * (hi - lo)) && band !== 'back' && band !== 'solo';
      return isTower
        ? { kind: 'tower' as SolidKind, wall: 'wallGlass' as const, roof: 'roofDark' as const }
        : { kind: 'podium' as SolidKind, wall: 'wallStone' as const, roof: 'roofLight' as const };
    }
    case 'commercial':
      return { kind: 'retail' as SolidKind, wall: 'wallBrick' as const, roof: 'roofFlat' as const };
    case 'industrial':
      return { kind: 'warehouse' as SolidKind, wall: 'wallPanel' as const, roof: 'roofMetal' as const };
    case 'campus':
      return { kind: 'slab' as SolidKind, wall: 'wallConcrete' as const, roof: 'roofLight' as const };
    case 'civic':
      return { kind: 'slab' as SolidKind, wall: 'wallStone' as const, roof: 'roofLight' as const };
    case 'park':
    case 'green':
      return { kind: 'house' as SolidKind, wall: 'wallStone' as const, roof: 'roofDark' as const };
    default:
      return { kind: 'slab' as SolidKind, wall: 'wallConcrete' as const, roof: 'roofFlat' as const };
  }
}

export function heightOf(ctx: HeightCtx): HeightOut {
  const d = DENSITY_PRESETS[ctx.density];
  const g = gradient(ctx);

  // 绿地只留管理房，一层，不参与任何高度规则
  if (ctx.use === 'park' || ctx.use === 'green') {
    const st = solidStyle(ctx.use, 1, 1, 1, ctx.band);
    return { hU: (1 * d.floorH) / 7, floors: 1, ...st, why: '绿地管理房，固定 1 层' };
  }

  // 工业：单层大跨厂房。檐高由占地（跨度）分三档，不由地价决定
  if (ctx.use === 'industrial') {
    const [h0, h1] = d.industrialHeight;
    const step = h1 - h0;
    const eavesM =
      ctx.footprintM2 > 1800
        ? h1
        : ctx.footprintM2 > 700
          ? h0 + step * 0.55
          : h0 + step * 0.15;
    // 单层厂房没有"层数"可调，只能让檐高吃到 25% 的梯度（含全局倍率）
    const weak = 1 + (g * ctx.heightScale - 1) * 0.25;
    const st = solidStyle(ctx.use, 1, 1, 1, ctx.band);
    return {
      hU: (eavesM * weak) / 7,
      floors: 1,
      ...st,
      why: `单层厂房，占地 ${ctx.footprintM2.toFixed(0)} m² → 檐高 ${eavesM.toFixed(1)} m（中心梯度仅 25%）`,
    };
  }

  const [lo, hi] = floorRange(ctx.use, d);
  let t = BAND_T[ctx.use][ctx.band];

  const streetT = ctx.band === 'front' || ctx.band === 'corner' ? STREET_T[ctx.streetCls] : 0;
  t += streetT;

  // 单栋面宽：22 m 起加，62 m 封顶 0.16。CBD 合并掉原本两三栋之后，这里会自动拔高
  const frontageT = clamp((ctx.frontageM - 22) / 40, 0, 0.16);
  t += frontageT;

  // 单栋占地：大底盘更高（用户第 1 条的推广）
  const footprintT = clamp((ctx.footprintM2 / 600 - 1) * 0.035, 0, 0.1);
  t += footprintT;

  // 地块尺度：比风貌预设的目标地块更大 → 允许更高（大地块才立得住高楼）
  const parcelT = clamp((ctx.parcelM2 / Math.max(1, ctx.parcelTargetM2) - 1) * 0.06, -0.06, 0.1);
  t += parcelT;

  // 可达性 → 容积率：连续、多中心，替代原来「按中心距离分公司」的硬阶梯
  const a = clamp(ctx.access ?? 1 - clamp(ctx.centerDist, 0, 1), 0, 1);
  const accessT = ctx.access === undefined ? 0 : 0.34 * (a - 0.45);
  t += accessT;

  // 区位未观测特征：低频连续场，让同排/相邻街区的开发强度有起伏。
  // 依据：大连中山区研究里高层在 ~660 m 内聚集、更大尺度离散，高容积率地块
  // 占比少且集中在少数街道。这里不是逐栋随机抖动，同一位置永远同一数值。
  const localT = clamp(ctx.localIntensity ?? 0, -1, 1) * 0.11;
  t += localT;

  t = clamp(t, 0, 1.06);
  // 区位梯度决定盖几层；层高固定为密度预设的 floorH，只留用户全局倍率
  const floors = Math.max(1, Math.round((lo + t * (hi - lo)) * g));
  const hU = (floors * d.floorH * ctx.heightScale) / 7;
  const st = solidStyle(ctx.use, floors, lo, hi, ctx.band);

  return {
    hU,
    floors,
    ...st,
    why:
      `${ctx.use}/${ctx.band} t=${t.toFixed(2)}（带 ${BAND_T[ctx.use][ctx.band]} + 街道 ${streetT.toFixed(2)}` +
      ` + 面宽 ${frontageT.toFixed(2)} + 占地 ${footprintT.toFixed(2)} + 地块 ${parcelT.toFixed(2)}` +
      ` + 可达 ${accessT.toFixed(2)} + 区位 ${localT.toFixed(2)}）` +
      ` → ${floors} 层 / ${(hU * 7).toFixed(1)} m`,
  };
}
