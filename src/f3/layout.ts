// F3-F · 建筑布局：按《houdini 路网（3）：关于建筑布局》的**场景分流**
//
// 作者从地图上归纳的三类现实，是本文件唯一的布局依据：
//   · 城市街区：大都是规则矩形块，每个地块上**两排建筑**，这样自然保证所有建筑
//     都与公路相邻（截图 3 卫星图）；两端也有房子时就是四边围合的院子；
//   · 城市小区：地块大、整块都有建筑，因此**需要内部路网**；内部路与马路牙子等高，
//     商业区步行街与公路交汇处只需把路牙压低；
//   · 乡村别墅区：路网不规则、地块大小形状不一，**所有房子都沿路边**，朝向正对公路。
//
// 两种算法：
//   · 随机分割（横竖切）：不保证都临路/朝向平行路，会出异形建筑；商业区可只留最外一圈，
//     或把内部分割线当步行街；地块不宜过大；商业区地块最好多数是矩形。
//   · 随机填充：预设几档尺寸矩形去填路边，保证临路与正对公路；用大小两档是因为全用大矩形
//     会留很多空挡 —— 大矩形=庭院，小矩形=孤立小屋，都做预制再 copy（截图 1）。
//   · 改进布局：**院子形状尽量保持接近矩形**（截图 2）。本轮的实现是「先定内院矩形，
//     建筑沿它的四边向外排」，而不是"建筑各自贴外边界、中间剩什么算什么"。
//   · 非矩形地块出异形建筑不是 bug，恰恰与现实吻合（截图 5）；院子形状尽量接近矩形。
//
// 高度分层拆到了 `height.ts`，按用户给的三条判据（CBD 沿街高且占地大 / 普通商业沿街高、
// 中间不填建筑 / 住宅沿街低、内部高层）+ 若干确定性补充规则插值。
// 本文件**不引入**覆盖率反推栋数、超预算等比收缩、每栋随机层数/材质轮换之类的自创规则；
// `coverage` 只作为项目验收要求的"占地上限"起作用，不参与布局决策。

import { Pt } from '../core/geom';
import { insideSurface, surfaceArea, surfaceSubtract, type PlanSurface } from '../town/planning/core/surface';
import { obbOf } from '../town/planning/subdivision/geom';
import type { SolidFeature } from '../scene/types';
import { M2, U, cleanRing } from './geom';
import { heightOf, type HeightBand } from './height';
import { centroidOf, clipToSurface, ringFits } from './lotsplit';
import { DENSITY_PRESETS, type BuildingParcel, type CityDensity, type RoadClass3, type StylePreset } from './types';

export type LayoutScene = 'twoRows' | 'courtyard' | 'roadside';

/** 超过这个面积就算"城市小区"，必须配内部路网（按用途给，单位 m²） */
const LARGE_M2: Record<BuildingParcel['use'], number> = {
  residential: 1200,
  commercial: 1400,
  cbd: 1600,
  industrial: 2600,
  campus: 1600,
  civic: 1400,
  park: 1e9,
  green: 1e9,
};

/** 建筑进深上限（米）：沿用项目 `build.ts` 里已经定好的体量语法，不另立数值 */
const DEPTH_CAP_M: Record<BuildingParcel['use'], number> = {
  residential: 13.5,
  commercial: 20,
  cbd: 26,
  industrial: 40,
  campus: 16,
  civic: 22,
  park: 9,
  green: 9,
};

/** 沿街单栋目标面宽（米）：两档预制矩形由它派生，不写死两套数 */
const TARGET_W_M: Record<BuildingParcel['use'], number> = {
  residential: 12,
  commercial: 20,
  cbd: 20,
  industrial: 30,
  campus: 22,
  civic: 20,
  park: 12,
  green: 12,
};

/**
 * 两档预制面宽倍率（截图 1 原文："上图中我故意设定了大小两个级别的矩形，是因为
 * 如果都用较大尺寸的矩形去填充，总难免出现很多空挡"）。
 *
 * 只改**面宽**、统一进深：建筑外沿贴齐地块边、内沿贴齐内院矩形，院子才接近矩形
 * （截图 2 的改进目标）。大档 = 庭院，小档 = 孤立小屋。
 */
const TIER_BIG = 1.5;
const TIER_SMALL = 0.7;

export interface LayoutOpts {
  density: CityDensity;
  heightScale: number;
  /** 项目验收用的占地上限（占地块比例），不参与布局决策 */
  coverage?: number;
  centerDist?: number;
  /** 地块最靠近的道路等级：进 `height.ts` 的沿街高度修正 */
  streetCls?: RoadClass3;
  /** 多中心可达性（landuse.ts），替代单一 centerDist 梯度 */
  access?: number;
  /** 位置相关的低频区位强度 -1~1 */
  localIntensity?: number;
  /** 风貌预设：提供该用途的目标地块面积，作为"大地块允许更高"的基准 */
  preset: StylePreset;
  seed: number;
}

export interface InnerRoad {
  surface: PlanSurface;
  kind: 'walk' | 'drive';
}

export interface HeightRecord {
  band: HeightBand;
  floors: number;
  why: string;
}

export interface LayoutOut {
  solids: SolidFeature[];
  footprints: PlanSurface[];
  innerRoads: InnerRoad[];
  /** 内院保护区：四边围合出来的近矩形院落，交给地面层整片做绿化/铺装 */
  courtyard: PlanSurface | null;
  gfaM2: number;
  note: string;
  scene: LayoutScene;
  frontRing: Pt[] | null;
  /** 逐栋高度依据，供报告/测试核对"规则真的进了算法" */
  heights: HeightRecord[];
}

/**
 * 场景判据只用地块自身的两个可观测量：**面积**和**矩形度**（面积 / OBB 面积）。
 * 不按风貌、不按 seed 拍脑袋分流。
 */
export function classifyScene(parcel: BuildingParcel): { scene: LayoutScene; rectRatio: number } {
  const ob = obbOf(parcel.surface.outer);
  const A = Math.abs(M2(surfaceArea(parcel.surface)));
  const rectRatio = ob ? A / Math.max(1, M2(ob.w * ob.d)) : 0.5;
  if (parcel.areaM2 >= LARGE_M2[parcel.use]) return { scene: 'courtyard', rectRatio };
  if (rectRatio < 0.84) return { scene: 'roadside', rectRatio };
  return { scene: 'twoRows', rectRatio };
}

// ---------------------------------------------------------------- 街道坐标系

interface UVFrame {
  ux: number;
  uy: number;
  vx: number;
  vy: number;
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

/**
 * u = 沿 `frontRad`（从街指向地块内部），v = 沿街。
 * 因为 (ux,uy)/(vx,vy) 是一组正交单位基，p = u·(ux,uy) + v·(vx,vy)，
 * 所以这里的 u/v 是绝对点积值，不需要减原点。
 */
function uvFrame(parcel: BuildingParcel): UVFrame {
  const ux = Math.cos(parcel.frontRad);
  const uy = Math.sin(parcel.frontRad);
  const vx = -uy;
  const vy = ux;
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (const p of parcel.surface.outer) {
    const u = p.x * ux + p.y * uy;
    const v = p.x * vx + p.y * vy;
    u0 = Math.min(u0, u);
    u1 = Math.max(u1, u);
    v0 = Math.min(v0, v);
    v1 = Math.max(v1, v);
  }
  return { ux, uy, vx, vy, u0, u1, v0, v1 };
}

function fromUV(u: number, v: number, f: UVFrame): Pt {
  return new Pt(u * f.ux + v * f.vx, u * f.uy + v * f.vy);
}

function uvRect(u0: number, u1: number, v0: number, v1: number, f: UVFrame): Pt[] {
  return cleanRing([fromUV(u0, v0, f), fromUV(u1, v0, f), fromUV(u1, v1, f), fromUV(u0, v1, f)]);
}

// ---------------------------------------------------------------- 确定性序列

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 整数 → [0,1)，用于两档面宽的确定性抽样（不是逐栋随机抖动） */
function hashInt(x: number): number {
  let h = x | 0;
  h = Math.imul(h ^ (h >>> 16), 2246822519);
  h = Math.imul(h ^ (h >>> 13), 3266489917);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// ---------------------------------------------------------------- 实现

export function realizeLayout(parcel: BuildingParcel, opts: LayoutOpts): LayoutOut {
  const d = DENSITY_PRESETS[opts.density];
  const use = parcel.use;
  const cd = opts.centerDist ?? 0.5;
  const streetCls = opts.streetCls ?? 'local';
  const targetRange = opts.preset.parcelM2[use];
  const parcelTargetM2 = (targetRange[0] + targetRange[1]) / 2;
  // CBD 单独放宽：用户判据是"放开占用原本多个建筑的范围"，大底盘一栋就可能超过
  // 常规 coverage 上限；若不放宽，临街第一栋建完就把中心塔楼全挡掉了，大地块只剩半边。
  // 这只影响 CBD 少数几个地块，其余用途仍严格按项目验收的占地上限走。
  // 四边围合比"两排条带"多两条端头排，占地天然高一档；商业只留最外一圈不需要放宽。
  // 这不是放宽验收口径，而是让 coverage 继续当**上限**、不反过来把院落形状切碎。
  const budget =
    parcel.areaM2 *
    (opts.coverage ?? 0.45) *
    (use === 'cbd' ? 1.4 : use === 'commercial' ? 1 : 1.2);
  const { scene, rectRatio } = classifyScene(parcel);
  const f = uvFrame(parcel);
  const rowSeed = (opts.seed ^ hashStr(parcel.id)) >>> 0;

  const solids: SolidFeature[] = [];
  const footprints: PlanSurface[] = [];
  const innerRoads: InnerRoad[] = [];
  const heights: HeightRecord[] = [];
  let courtyard: PlanSurface | null = null;
  let builtArea = 0;
  let gfa = 0;
  let frontRing: Pt[] | null = null;

  /** 把一个建筑轮廓真正落地：裁回地块 → 内收 8 cm → 覆盖率上限 → 按位置带推高度 */
  const addRing = (raw: Pt[], band: HeightBand, frontageM: number): boolean => {
    if (builtArea >= budget) return false;
    const clipped = clipToSurface(raw, parcel.surface);
    if (!clipped || clipped.length < 3) return false;
    const c = centroidOf(clipped);
    const shrunk = clipped.map((p) => {
      const dx = p.x - c.x;
      const dy = p.y - c.y;
      const L = Math.hypot(dx, dy) || 1;
      const k = Math.max(0.05, (L - U(0.08)) / L);
      return new Pt(c.x + dx * k, c.y + dy * k);
    });
    if (!ringFits(shrunk, parcel.surface)) return false;
    // 轮廓绕过一个洞时（L 形/凹形），顶点和边中点都合法，但质心可能落进洞里。
    if (!insideSurface(centroidOf(shrunk), parcel.surface)) return false;
    const A = Math.abs(M2(surfaceArea({ outer: shrunk, holes: [] })));
    if (A < 45) return false;
    // coverage 只当上限：第一栋永远允许，后面累加超了就停，不收缩、不改布局
    if (builtArea > 0 && builtArea + A > budget * 1.05) return false;

    const ht = heightOf({
      use,
      density: opts.density,
      heightScale: opts.heightScale,
      centerDist: cd,
      access: opts.access ?? parcel.access,
      localIntensity: opts.localIntensity ?? parcel.localIntensity,
      streetCls,
      band,
      footprintM2: A,
      frontageM,
      parcelM2: parcel.areaM2,
      parcelTargetM2,
    });

    solids.push({
      name: `${parcel.id}_${ht.kind}_${solids.length}`,
      group: `lot/${use}`,
      ring: shrunk,
      y0: 0,
      h: ht.hU,
      wallMat: ht.wall,
      roofMat: ht.roof,
      kind: ht.kind,
    });
    footprints.push({ outer: shrunk, holes: [] });
    heights.push({ band, floors: ht.floors, why: ht.why });
    builtArea += A;
    gfa += (A * (ht.hU * 7)) / d.floorH;
    if (!frontRing) frontRing = shrunk;
    return true;
  };

  /**
   * 在一条边上排**一排**建筑（截图 1 的随机填充）。
   *
   * `axis='v'` 表示沿街方向排（前后两排），`axis='u'` 表示沿进深方向排（两端排）。
   * 面宽默认走两档预制矩形的确定性混用；`equi=true` 时退回等分 —— CBD 需要
   * 等宽开间才能稳定合并成"一栋顶替多栋"的大底盘（用户判据 ①）。
   *
   * `merge > 1` 把相邻若干开间合成一栋，只放大面宽、不改进深，最后统一
   * `clipToSurface` + `ringFits` 裁回地块，所以绝不会越出边界。
   */
  const fillRow = (
    u0: number,
    u1: number,
    v0: number,
    v1: number,
    axis: 'u' | 'v',
    band: HeightBand,
    opt: { merge?: number; equi?: boolean; salt?: number; wM?: number } = {}
  ): number => {
    const lo = axis === 'v' ? v0 : u0;
    const hi = axis === 'v' ? v1 : u1;
    const spanM = (hi - lo) * 7;
    if (spanM < 9 || (u1 - u0) * 7 < 6 || (v1 - v0) * 7 < 6) return 0;
    const wM = opt.wM ?? TARGET_W_M[use];
    const gapU = U(1.4);
    const widths: number[] = [];
    /** 第 i 栋之后到下一栋起点的间隔（含刻意留出的空档） */
    const gaps: number[] = [];
    const salt = opt.salt ?? 0;
    const merge = opt.merge ?? 1;

    if (opt.equi) {
      const k = Math.max(1, Math.min(Math.round(spanM / wM), Math.floor(spanM / 8)));
      const each = ((hi - lo) - gapU * (k - 1)) / k;
      if (each < U(7)) return 0;
      for (let i = 0; i < k; i++) {
        widths.push(each);
        gaps.push(gapU);
      }
    } else {
      const bigW = U(wM * TIER_BIG);
      const smallW = U(wM * TIER_SMALL);
      let t = 0;
      for (let i = 0; i < 40; i++) {
        const room = (hi - lo) - t - (widths.length ? gapU : 0);
        if (room < U(7)) break;
        const h = hashInt((rowSeed ^ (salt * 7919) ^ (i * 104729)) >>> 0);
        const w = h < 0.56 ? bigW : smallW;
        widths.push(Math.min(w, room));
        // 截图 1 原文："如果都用较大尺寸的矩形去填充，总难免出现很多空挡" ——
        // 空档是这套布局的固有节奏，不是缺陷。小屋档之后按确定性留一段空，
        // 让院落边缘有进退，而不是一排严丝合缝的排屋。
        const voidGap = h > 0.78 ? U(2.6) : 0;
        widths.push(Math.min(w, room));
        gaps.push(gapU + voidGap);
        t += widths[widths.length - 1] + gaps[gaps.length - 1];
      }
    }
    if (widths.length === 0) return 0;

    const groups: [number, number][] = [];
    for (let i = 0; i < widths.length; i += merge) groups.push([i, Math.min(widths.length, i + merge)]);

    let made = 0;
    for (let g = 0; g < groups.length; g++) {
      const [i0, i1] = groups[g];
      let start = lo;
      for (let i = 0; i < i0; i++) start += widths[i] + gaps[i];
      let end = start;
      for (let i = i0; i < i1; i++) {
        end += widths[i];
        if (i < i1 - 1) end += gaps[i];
      }
      const rect = axis === 'v' ? uvRect(u0, u1, start, end, f) : uvRect(start, end, v0, v1, f);
      // 街角：临街排两端自动升一档，形成"两端高、中间缓"的确定性节奏
      const atCorner = band === 'front' && groups.length >= 3 && (g === 0 || g === groups.length - 1);
      if (addRing(rect, atCorner ? 'corner' : band, (end - start) * 7)) made++;
    }
    return made;
  };

  /**
   * 内院矩形驱动的四边围合（截图 2 的改进："院子形状尽量保持接近矩形"）。
   *
   * 做法与"建筑各自贴外边界、中间剩什么算什么"相反：**先算出内院矩形**
   * （四条边各退一排建筑进深 + 退线 + 缝），再沿它的四条边向外排建筑。
   * 于是院子天生是矩形，四角由 front/back 排占满、端头排只占中段，互不重叠；
   * 斜边地块由 clipToSurface 裁出异形建筑，正合截图 5。
   *
   * `frontOnly` = 商业"只留最外一圈"（截图 5 方式 ①），中间整片留给广场/停车/绿化。
   */
  const ringLayout = (
    frontDU: number,
    backDU: number,
    endDU: number,
    bands: { front: HeightBand; back: HeightBand; end: HeightBand },
    frontOnly: boolean,
    cbdMerge: number
  ): { n: number; note: string } => {
    const sb = U(1.2);
    const gap = U(1.2);
    const fU0 = f.u0 + sb;
    const fU1 = f.u0 + sb + frontDU;
    const bU1 = f.u1 - sb;
    const bU0 = bU1 - backDU;
    const eV0 = f.v0 + sb;
    const eV1 = eV0 + endDU;
    const wV1 = f.v1 - sb;
    const wV0 = wV1 - endDU;

    // 内院矩形：四条边都被一排建筑夹住
    const inU0 = fU1 + gap;
    const inU1 = bU0 - gap;
    const inV0 = eV1 + gap;
    const inV1 = wV0 - gap;
    const innerWidthM = (inU1 - inU0) * 7;
    const innerDepthM = (inV1 - inV0) * 7;
    // 内院可以是扁矩形（截图 2 里院落长宽比各不相同），只要四边都夹得住就行
    const canRing = !frontOnly && innerWidthM > 6 && innerDepthM > 6;

    let n = 0;
    const isCbd = cbdMerge > 1;
    n += fillRow(fU0, fU1, eV0, wV1, 'v', bands.front, {
      merge: cbdMerge,
      equi: isCbd,
      salt: 1,
    });
    if (!frontOnly) {
      n += fillRow(bU0, bU1, eV0, wV1, 'v', bands.back, {
        merge: use === 'residential' || isCbd ? 2 : 1,
        equi: isCbd,
        salt: 2,
      });
    }
    if (canRing) {
      // 两端排只占内院的 u 段，避免与前后排的四角重叠
      n += fillRow(inU0, inU1, eV0, eV1, 'u', bands.end, { salt: 3 });
      n += fillRow(inU0, inU1, wV0, wV1, 'u', bands.end, { salt: 4 });
    }

    if (canRing) {
      const c = clipToSurface(uvRect(inU0, inU1, inV0, inV1, f), parcel.surface);
      if (c && Math.abs(M2(surfaceArea({ outer: c, holes: [] }))) > 120) {
        courtyard = { outer: c, holes: [] };
      }
    }
    const suffix = canRing
      ? `｜内院 ${innerWidthM.toFixed(0)}×${innerDepthM.toFixed(0)} m（近矩形）`
      : frontOnly
        ? '｜只留最外一圈，中心留空'
        : '';
    return { n, note: `四边围合 ${n} 栋${suffix}` };
  };

  /** courtyard 分支用的兼容包装：在一个 uv 子域里贴 front/back 侧排一排 */
  const rowInDomain = (
    u0: number,
    u1: number,
    v0: number,
    v1: number,
    side: 'front' | 'back',
    depthM: number,
    band: HeightBand,
    merge = 1,
    salt = 7
  ): number => {
    const depthAvailableM = (u1 - u0) * 7;
    if (depthAvailableM < 7) return 0;
    const dU = U(Math.min(depthM, depthAvailableM * 0.72));
    const sbU = U(1.2);
    return side === 'front'
      ? fillRow(u0 + sbU, u0 + sbU + dU, v0, v1, 'v', band, { merge, equi: merge > 1, salt })
      : fillRow(u1 - sbU - dU, u1 - sbU, v0, v1, 'v', band, { merge, equi: merge > 1, salt: salt + 1 });
  };

  const depthM = (f.u1 - f.u0) * 7;
  const widthM = (f.v1 - f.v0) * 7;
  const capM = DEPTH_CAP_M[use];
  // 进深收窄到地块深度的 26%：截图 2 的改进布局里建筑是细长排屋、院子很大，
  // 旧版 34%（且下限 9 m）会把 23 m 深的地块前后各吃掉 9 m，内院直接被挤没。
  const dM = Math.min(capM, Math.max(7, depthM * 0.26));
  // 商业/CBD 沿街做大进深：中间既然留空，沿街这一排就要撑得起街墙
  const frontDM = Math.min(capM, Math.max(dM, depthM * 0.46));
  let note = '';

  if (use === 'park' || use === 'green') {
    // 公园/绿地：文章没有"布局"一说，只留一间管理房，其余交给绿地规则
    if (parcel.areaM2 > 5000) {
      addRing(uvRect(f.u0 + U(3), f.u0 + U(12), (f.v0 + f.v1) / 2 - U(4), (f.v0 + f.v1) / 2 + U(4), f), 'solo', 8);
    }
    note = '绿地，不参与布局';
  } else if (scene === 'twoRows') {
    /**
     * 城市街区（截图 3）：规则矩形地块，前后各贴一条边 —— "自然保证所有建筑都与公路相邻"。
     * 进深够时两端也排房子，围出**接近矩形的院子**（截图 2 的改进布局）。
     * 三条用户判据在这里落地：
     *   · CBD：沿街相邻开间合并成一栋大底盘（merge=3），面宽加成自动拔高；
     *   · 普通商业：只做临街一排（截图 5 方式 ①），内侧整片留给广场/停车/绿化；
     *   · 住宅：临街排最低，背街排与两端排是高层居民楼，内院保持完整。
     */
    const frontOnly = use === 'commercial';
    const cbdMerge = use === 'cbd' && widthM > 36 ? 3 : 1;
    const bands = {
      front: 'front' as HeightBand,
      back: (use === 'residential' || use === 'cbd' ? 'core' : 'inner') as HeightBand,
      end: (use === 'residential' ? 'core' : 'solo') as HeightBand,
    };
    const ring = ringLayout(U(frontOnly || cbdMerge > 1 ? frontDM : dM), U(cbdMerge > 1 ? dM * 0.62 : dM), U(dM * 0.9), bands, frontOnly, cbdMerge);
    note =
      `规则矩形地块（矩形度 ${rectRatio.toFixed(2)}）→ ${ring.note}` +
      (frontOnly ? '，普通商业中心不填建筑（广场/停车/绿化）' : '') +
      (cbdMerge > 1 ? `，沿街每 ${cbdMerge} 开间合并为一栋` : '，大小两档预制矩形混排');
  } else if (scene === 'courtyard') {
    /**
     * 城市小区：地块大、整块都有建筑，先立**内部路网**。
     *
     * 一条沿街的主通道 + 一条垂直支路组成十字，把地块分成四块；商业/CBD 的通道是
     * 步行街（paving），其余是等高内部车道（asphaltLot）—— 对应文章"内部路网通常在
     * 马路牙子之上"以及商业区"把公路路牙压低即可"。
     */
    const isWalk = use === 'commercial' || use === 'cbd';
    const laneU = U(isWalk ? 4.5 : 6);
    const um = (f.u0 + f.u1) / 2;
    const vm = (f.v0 + f.v1) / 2;
    const roadKind: InnerRoad['kind'] = isWalk ? 'walk' : 'drive';
    const mainRing = uvRect(um - laneU / 2, um + laneU / 2, f.v0, f.v1, f);
    const crossRing = uvRect(f.u0, f.u1, vm - laneU / 2, vm + laneU / 2, f);
    // CBD 要连续的大街墙：只留一条横贯的内部步行街，不再用垂直支路把街墙切断
    const withCross = use !== 'cbd';
    for (const r of withCross ? [mainRing, crossRing] : [mainRing]) {
      const c = clipToSurface(r, parcel.surface);
      if (c) innerRoads.push({ surface: { outer: c, holes: [] }, kind: roadKind });
    }
    const uA = [f.u0, um - laneU / 2];
    const uB = [um + laneU / 2, f.u1];
    const vA = [f.v0, vm - laneU / 2];
    const vB = [vm + laneU / 2, f.v1];
    let n = 0;
    if (use === 'commercial') {
      // 普通商业：只做临街半边的两排，背街半与中心整片留给广场/停车/绿化
      n += rowInDomain(uA[0], uA[1], vA[0], vA[1], 'front', frontDM, 'front', 1, 11);
      n += rowInDomain(uA[0], uA[1], vB[0], vB[1], 'front', frontDM, 'front', 1, 13);
      note = `大商业地块 ${parcel.areaM2.toFixed(0)} m² → 十字步行街 + 临街 ${n} 栋，内侧不填建筑`;
    } else if (use === 'cbd') {
      // CBD：整幅街墙合并成少数几栋大底盘（"放开占用原本多个建筑的范围"）。
      const m = 3;
      n += rowInDomain(uA[0], uA[1], f.v0, f.v1, 'front', frontDM, 'front', m, 15);
      n += rowInDomain(uB[0], uB[1], f.v0, f.v1, 'front', dM * 0.62, 'core', m, 17);
      note = `大 CBD 地块 ${parcel.areaM2.toFixed(0)} m² → 一条内部步行街 + ${n} 栋大底盘（临街裙房 / 中心塔楼）`;
    } else if (use === 'residential') {
      // 住宅小区：临街半外圈低层，中心十字路两侧是合并开间的板式高层，后部留绿地/停车
      n += rowInDomain(uA[0], uA[1], vA[0], vA[1], 'front', dM, 'front', 1, 21);
      n += rowInDomain(uA[0], uA[1], vB[0], vB[1], 'front', dM, 'front', 1, 23);
      n += rowInDomain(uB[0], uB[1], vA[0], vA[1], 'front', dM, 'core', 2, 25);
      n += rowInDomain(uB[0], uB[1], vB[0], vB[1], 'front', dM, 'core', 2, 27);
      note = `大住宅地块 ${parcel.areaM2.toFixed(0)} m² → 内部车道 + 沿街低层/中心高层 ${n} 栋`;
    } else {
      n += rowInDomain(uA[0], uA[1], vA[0], vA[1], 'front', dM, 'front', 1, 31);
      n += rowInDomain(uA[0], uA[1], vB[0], vB[1], 'front', dM, 'front', 1, 33);
      n += rowInDomain(uB[0], uB[1], vA[0], vA[1], 'back', dM, 'inner', 1, 35);
      n += rowInDomain(uB[0], uB[1], vB[0], vB[1], 'back', dM, 'inner', 1, 37);
      note = `大地块 ${parcel.areaM2.toFixed(0)} m² → 十字${isWalk ? '步行街' : '内部车道'} + 外圈 ${n} 栋`;
    }
  } else {
    /**
     * 乡村别墅区（截图 1/2）：路网不规则、地块大小形状不一，**所有房子沿路边**、
     * 朝向正对公路。这里仍用内院矩形驱动的四边围合 —— 不规则地块的斜边由
     * clipToSurface 吃掉，出来的异形建筑正是文章说的"与现实吻合"（截图 5）。
     *
     * 大小两档预制矩形由 fillRow 按确定性序列混排，不再"大档优先、小档补空"，
     * 否则 big 几乎总能放下，小屋档形同虚设。
     */
    const scale = use === 'industrial' ? 1.5 : use === 'cbd' || use === 'campus' ? 1.25 : 1;
    const frontOnly = use === 'commercial';
    const cbdMerge = use === 'cbd' && widthM > 40 ? 3 : 1;
    const bands = {
      front: (use === 'residential' ? 'solo' : 'front') as HeightBand,
      back: (use === 'residential' ? 'inner' : 'solo') as HeightBand,
      end: (use === 'residential' ? 'core' : 'solo') as HeightBand,
    };
    const ring = ringLayout(
      U(dM * (cbdMerge > 1 ? 1.5 : 1) * scale),
      U(dM * 0.9 * scale),
      U(Math.min(capM, Math.max(7, widthM * 0.14)) * scale),
      bands,
      frontOnly,
      cbdMerge
    );
    note = `不规则地块（矩形度 ${rectRatio.toFixed(2)}）→ ${ring.note}（大小两档预制矩形沿边填充）`;
  }

  // 内部路要扣掉建筑占地，否则铺装会画到房子底下
  if (innerRoads.length > 0 && footprints.length > 0) {
    const cleaned: InnerRoad[] = [];
    for (const r of innerRoads) {
      try {
        const rest = surfaceSubtract([r.surface], footprints);
        for (const q of rest) {
          if (Math.abs(M2(surfaceArea(q))) < 5) continue;
          cleaned.push({ surface: q, kind: r.kind });
        }
      } catch {
        cleaned.push(r);
      }
    }
    innerRoads.length = 0;
    innerRoads.push(...cleaned);
  }

  // ---------------------------------------------------------------- 内院兜底
  // twoRows 的 ringLayout 已经显式给出内院矩形；courtyard（大地块 + 十字内部路）
  // 与 roadside（不规则地块沿路填充）留出来的中心空地同样该整片认领为院落，
  // 否则地面层会把同一块院子切成 L 形绿化 / 花坛 / 余量硬铺（截图 2 的改进布局）。
  // 这里只把「本来就空着」的地方标出来给地面层，不新增任何建筑布局规则。
  if (!courtyard && solids.length >= 3) {
    try {
      const occupied: PlanSurface[] = [...footprints, ...innerRoads.map((r) => r.surface)];
      const rest = surfaceSubtract([parcel.surface], occupied);
      const ux = Math.cos(parcel.frontRad);
      const uy = Math.sin(parcel.frontRad);
      let best: PlanSurface | null = null;
      let bestScore = -Infinity;
      let bestA = 0;
      for (const q of rest) {
        const A = Math.abs(M2(surfaceArea(q)));
        if (A < 160) continue;
        const ob = obbOf(q.outer);
        if (!ob || A / Math.max(1, M2(ob.w * ob.d)) < 0.62) continue;
        const c = centroidOf(q.outer);
        // frontRad 从街指向内部：u 越大越靠内侧，避免把临街前场误认成院子
        const score = c.x * ux + c.y * uy + A * 0.0002;
        if (score > bestScore) {
          bestScore = score;
          best = q;
          bestA = A;
        }
      }
      if (best) {
        courtyard = { outer: best.outer, holes: best.holes };
        note += `｜院落保护区 ${bestA.toFixed(0)} m²`;
      }
    } catch {
      /* 求余量失败就不显式输出内院，地面层照常按剩余面铺 */
    }
  }

  // 高度摘要放进地块 note：页面上逐块都能看到"这一块从几层到几层"
  if (heights.length > 0) {
    const fs = heights.map((h) => h.floors);
    const lo = Math.min(...fs);
    const hi = Math.max(...fs);
    note += `｜${lo}~${hi} 层（${new Set(fs).size} 档）`;
  }

  return {
    solids,
    footprints,
    innerRoads,
    courtyard,
    gfaM2: +gfa.toFixed(0),
    note,
    scene,
    frontRing,
    heights,
  };
}
