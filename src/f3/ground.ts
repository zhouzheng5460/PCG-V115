// F3-E · 建筑外围复合地面：前场铺装 / 停车 / 绿化 / 树木 / 小品
//
// 核心：GroundResidual = 地块 − 建筑占地，是**一整块不规则剩余面**。
// 绝不能被机械切成"上/下/左/右"四块 —— 转角处的 L 形绿化、跨角停车、
// 沿边种植带都是在这同一块剩余面上按规则"认领"出来的。
//
// 认领顺序是固定的（这就是"确定性的降级规则"）：
//   ① 建筑前场铺装（临街一条）
//   ② 停车（只有在面积与形状都够时；不够就缩，再不够就转绿化）
//   ③ 绿化（剩余部分；小于 30 m² 的碎片转铺装，不用草坪填缝）
//   ④ 树木（在绿地里按网格 + 抖动放，避开建筑与入口）

import { Pt } from '../core/geom';
import {
  insideSurface,
  surfaceArea,
  surfaceInset,
  surfaceIntersect,
  surfaceOffset,
  surfaceSubtract,
  type PlanSurface,
} from '../town/planning/core/surface';
import { solveParking } from '../town/parking';
import { makeRng } from '../town/planning/subdivision/geom';
import type { PropFeature, SurfaceFeature } from '../scene/types';
import { MAT } from '../scene/palette';
import type { MatKey } from '../scene/palette';
import { M2, U, areaM2, cleanRing, rectRing, shapeOf } from './geom';
import { maxInscribedRect } from './build';
import type { BuildingParcel, InscribedRect, StylePreset } from './types';

export interface LotPatch {
  ring: Pt[];
  holes?: Pt[][];
  mat: MatKey;
  kind: 'paving' | 'parking' | 'drive' | 'lawn' | 'greenL' | 'greenEdge' | 'planter' | 'hard' | 'water';
  y: number;
}

export interface GroundOut {
  patches: LotPatch[];
  /** 车位线（贴地细线，用 PathFeature 出） */
  stallLines: [Pt, Pt][];
  trees: { at: Pt; scale: number; seed: number }[];
  props: PropFeature[];
  bays: number;
  pavingM2: number;
  parkingM2: number;
  lawnM2: number;
  note: string;
}

export interface GroundOpts {
  preset: StylePreset;
  seed: number;
  /** 建筑入口位置（世界坐标），绿化与停车都要避开 */
  entrances: Pt[];
  heightScale: number;
  /** 内院保护区：布局层四边围合出来的近矩形院落，整片做院落绿化 */
  courtyard?: PlanSurface | null;
}

const EMPTY: GroundOut = {
  patches: [],
  stallLines: [],
  trees: [],
  props: [],
  bays: 0,
  pavingM2: 0,
  parkingM2: 0,
  lawnM2: 0,
  note: '',
};

export function groundForParcel(
  parcel: BuildingParcel,
  rect: InscribedRect | null,
  footprintRing: Pt[] | null,
  footprints: PlanSurface[],
  opts: GroundOpts
): GroundOut {
  const rng = makeRng(opts.seed, `ground-${parcel.id}`);
  const out: GroundOut = { ...EMPTY, patches: [], stallLines: [], trees: [], props: [] };
  const use = parcel.use;
  const claimed: PlanSurface[] = [];

  const residual = footprints.length ? safeSubtract([parcel.surface], footprints) : [parcel.surface];
  const residualM2 = residual.reduce((s, q) => s + M2(surfaceArea(q)), 0);
  if (residualM2 < 20) {
    out.note = '没有剩余地面（建筑占满地块）';
    return out;
  }

  /**
   * 局部坐标系：+u 从街道指向地块内部，+v 沿街。
   *
   * 所有"语法构件"（前场、后院、L 形绿化、停车带、车道）都在这个坐标系里
   * 用矩形定义，再裁到真实剩余面上。这样形状是**规整的设计语言**，
   * 而不是"剩什么铺什么"。
   */
  const c = centroidOfSurface(parcel.surface);
  const ux = Math.cos(parcel.frontRad);
  const uy = Math.sin(parcel.frontRad);
  const vx = -uy;
  const vy = ux;
  const toUV = (p: Pt): { u: number; v: number } => ({
    u: (p.x - c.x) * ux + (p.y - c.y) * uy,
    v: (p.x - c.x) * vx + (p.y - c.y) * vy,
  });
  const fromUV = (u: number, v: number): Pt => new Pt(c.x + ux * u + vx * v, c.y + uy * u + vy * v);
  const uvRect = (u0: number, u1: number, v0: number, v1: number): Pt[] =>
    cleanRing([fromUV(u0, v0), fromUV(u1, v0), fromUV(u1, v1), fromUV(u0, v1)]);

  const pe = extents(parcel.surface.outer.map(toUV));
  const fe = footprintRing && footprintRing.length >= 3 ? extents(footprintRing.map(toUV)) : null;
  const frontU = pe.u0; // 临街边界
  const backU = pe.u1;
  const vMin = pe.v0;
  const vMax = pe.v1;
  const fFrontU = fe ? fe.u0 : frontU + U(6);
  const fBackU = fe ? fe.u1 : backU - U(6);
  const fV0 = fe ? fe.v0 : vMin + U(3);
  const fV1 = fe ? fe.v1 : vMax - U(3);
  const bandM = (vMax - vMin) * 7;

  /**
   * 认领一块面：裁到**当前还空着的**面，然后把它从空面里扣掉。
   *
   * 维护一个"可用的 remaining"，每次只减刚认领的那块 —— 而不是每次都
   * `residual − 全部已认领`。后者在一个地块上要做 6~8 次逐块并集减法，
   * 全城 1200 个地块把 ground 这一步从 1.5 s 拖到 4 s（实测）。
   */
  let remaining = residual;
  const take = (
    ring: Pt[],
    kind: GroundOut['patches'][number]['kind'],
    mat: MatKey,
    y: number,
    minM2 = 2
  ): number => {
    const poly: PlanSurface = { outer: cleanRing(ring), holes: [] };
    const clipped = safeIntersect([poly], remaining);
    let got = 0;
    for (const q of clipped) {
      const A = M2(surfaceArea(q));
      if (A < minM2) continue;
      claimed.push(q);
      out.patches.push({ ring: q.outer, holes: q.holes, mat, kind, y });
      got += A;
    }
    if (got > 0) remaining = safeSubtract(remaining, [poly]);
    return got;
  };

  // ================================================================ ① 停车 + 车道
  //
  // 顺序上停车排在绿化前面（优先级：建筑 > 道路/入口 > 停车 > 前场 > 绿化 > 余量硬铺）。
  // 停车只放在**建筑背面**（u > 建筑后墙），临街面留给前场和入口，
  // 并且必须有一条 4.5 m 的车道从地块临街边界通到停车场 —— 没有车道的停车场
  // 是"画上去的"，这是上一版 26 个车位、18/18 片与车行面不相接的根因。
  const parkShare = PARK_SHARE[use] ?? 0;
  /**
   * 二叉分割路径（`rect === null`）的地块小、剩余地被建筑切成 L 形，
   * 沿用规则地块那套 180 m² / 60 m² 门槛会把大部分地块直接判"没地方停"。
   * 这不是放宽规则，而是把门槛跟着地块尺度一起缩。
   */
  const isSplit = rect === null;
  if (parkShare > 0 && residualM2 > (isSplit ? 95 : 180)) {
    const targetM2 = Math.min(residualM2 * parkShare, PARK_CAP[use] ?? 900);

    /**
     * 停车的候选区：**背院 + 左右侧院**，各自求最大内接矩形，取面积最大的那个。
     *
     * 只找背院是不够的 —— 商业地块进深被建筑吃掉大半，背院常常是负的
     * （建筑后墙越过了地块后边界），于是"每块商业地都有停车"这条规则
     * 会被静默跳过（实测 37 块商业地、0 块有停车）。侧院通常还留着地。
     */
    const zones: Pt[][] = [];
    if (fBackU + U(1.8) < backU - U(1.5)) zones.push(uvRect(fBackU + U(1.5), backU, vMin + U(1), vMax - U(1)));
    if (fV0 - U(1.5) > vMin + U(1.8)) zones.push(uvRect(fFrontU, backU, vMin, fV0 - U(1)));
    if (vMax - U(1.5) > fV1 + U(1.8)) zones.push(uvRect(fFrontU, backU, fV1 + U(1), vMax));

    let spot: InscribedRect | null = null;
    let spotRect: Pt[] | null = null;
    for (const z of zones) {
      const r0 = maxInscribedRect({ outer: cleanRing(z), holes: [] }, parcel.frontRad).rect;
      if (!r0) continue;
      if (!spot || r0.areaM2 > spot.areaM2) {
        spot = r0;
        spotRect = z;
      }
    }

    /**
     * 兜底候选：直接在"还空着的面"里找最大内接矩形。
     *
     * 地块和建筑轮廓改成不规则 polygon 之后，上面那三个由 extents 拼出来的
     * 矩形候选区可能整块压在建筑里，`safeIntersect` 得到空面，于是车位静默归零
     * （structured 实测 4245 → 257 位）。剩余面本身才是最可靠的候选来源。
     */
    for (const q of remaining) {
      const a = M2(surfaceArea(q));
      if (a < Math.max(isSplit ? 45 : 90, targetM2 * 0.5)) continue;
      const r0 = maxInscribedRect(q, parcel.frontRad).rect;
      if (r0 && (!spot || r0.areaM2 > spot.areaM2)) spot = r0;
    }

    /**
     * 停车场面积要受 `parkShare` 约束，不能"剩余面能塞多大就塞多大"。
     *
     * 上面两组候选取的都是**最大**内接矩形；布局改成"沿路两排 + 中央院落"之后
     * 剩余面又大又整，最大内接矩形会把整个院子变成沥青（实测 9438 位、
     * 总平面上深灰压过绿地）。parkShare 本来就是"停车占剩余空间的目标比例"，
     * 这里按面积等比收回到目标值，才是让这条规则真正生效。
     */
    if (spot && spot.areaM2 > targetM2 * 1.3) {
      const k = Math.sqrt((targetM2 * 1.15) / spot.areaM2);
      const c = centroid(spot.ring);
      spot = {
        ...spot,
        ring: spot.ring.map((p) => new Pt(c.x + (p.x - c.x) * k, c.y + (p.y - c.y) * k)),
        areaM2: +(spot.areaM2 * k * k).toFixed(1),
      };
      spotRect = null;
    }

    if (spot && spot.areaM2 >= (isSplit ? 32 : Math.max(60, targetM2 * 0.45))) {
      const inset = surfaceInset({ outer: spot.ring, holes: [] }, U(0.7)).filter((q) => M2(surfaceArea(q)) > 30)[0];
      const innerRing = inset?.outer ?? spot.ring;
      // 这一步只用来**选朝向**：整块停车坪统一一个角度，避免同一块地里
      // 水平排、竖直排、斜排混着出现（截图 2 的"方向乱"）。
      const orient = solveParking(innerRing, {
        angles: [parcel.frontRad, parcel.frontRad + Math.PI / 2],
        maxAngles: 2,
      });
      const angle = orient?.angle ?? parcel.frontRad;
      // 先把面裁到"还空着的面"，再在**裁完的这块**上排车位
      const pieces = safeIntersect([{ outer: cleanRing(innerRing), holes: [] }], remaining)
        .filter((q) => M2(surfaceArea(q)) > 40)
        .sort((a, b) => M2(surfaceArea(b)) - M2(surfaceArea(a)));
      const lotPoly = pieces[0];
      if (lotPoly) {
        const se = extents(lotPoly.outer.map(toUV));
        // 车道：从停车场靠街一侧拉到临街边界
        const laneV = Math.min(se.v1 - U(4.5), Math.max(se.v0, fV0));
        take(uvRect(frontU, se.u0 + U(0.2), laneV, laneV + U(4.5)), 'drive', 'asphaltLot', 0.0118, 8);

        const lotM2 = M2(surfaceArea(lotPoly));
        claimed.push(lotPoly);
        out.patches.push({ ring: lotPoly.outer, holes: lotPoly.holes, mat: 'asphaltLot', kind: 'parking', y: 0.0122 });
        remaining = safeSubtract(remaining, [lotPoly]);
        out.parkingM2 += lotM2;

        /**
         * 车位线必须**在铺装面上重解一次**。
         *
         * 旧版直接用 `orient`（在 innerRing 上算的）的 dividers/fronts，
         * 而铺装只取了 innerRing ∩ remaining 的一小块 —— 于是大量车位线
         * 落在没有沥青的黑底上，形成截图 2 里那些孤立的"梳子"。
         * GB 5768.3 §5.12：小型车位 2.5 × 6 m（受限时 ≥2.0 × 5.3 m）、
         * 标线宽 6~10 cm；`CAR_STALL` 的 2.52 × 5.04 m + 6.3 m 通道已按此取。
         *
         * 狭长铺装（短边 < 10.5 m）**不再画垂直车位**：一排 5 m 深的格子
         * 配一条通长基线，俯视就是"车道边的梯子"（截图 2 里最刺眼的那条）。
         * 这种尺度实际只能做**路边平行式停车带** —— 一条连续边线 +
         * 每 6.3 m 一根 2.3 m 短分隔线，不把整条带子横着切断。
         */
        const onLot = solveParking(cleanRing(lotPoly.outer), { angles: [angle], maxAngles: 1 });
        const narrow = shapeOf(lotPoly).minorM < 10.5;
        if (narrow || !onLot || onLot.count < 3) {
          const lines = parallelBayLines(se, fromUV);
          const kept = linesInside(lines, lotPoly);
          for (const l of kept) out.stallLines.push(l);
          // 短分隔线（长度 < 3.2 m）有几根就有几个平行车位；
          // 通长基线不算车位，也不按 bbox 跨度虚报。
          const ticks = kept.filter(([a, b]) => Pt.distance(a, b) < U(3.2)).length;
          out.bays += Math.max(1, ticks - 1);
        } else {
          const dividers = linesInside(onLot.dividers, lotPoly);
          // 前缘线：每排一条通长基线；通长线跨出凹口时退回逐格短线
          const merged = linesInside(mergeStallFronts(onLot.fronts), lotPoly);
          const fronts = merged.length ? merged : linesInside(onLot.fronts, lotPoly);
          for (const l of dividers) out.stallLines.push(l);
          for (const l of fronts) out.stallLines.push(l);
          out.bays += dividers.length;
          for (const isl of onLot.islands) {
            for (const q of safeIntersect([{ outer: isl, holes: [] }], [lotPoly])) {
              const A = Math.abs(M2(surfaceArea(q)));
              if (A < 6) continue;
              out.patches.push({ ring: q.outer, holes: q.holes, mat: 'lawn', kind: 'greenL', y: 0.0124 });
              out.lawnM2 += A;
              out.trees.push({ at: centroid(q.outer), scale: 0.72 + rng() * 0.16, seed: Math.floor(rng() * 1000) });
            }
          }
        }
      }
    }
    void spotRect;
  }

  // ================================================================ ①b 内院
  //
  // 《houdini 路网 (3)》截图 2「改进布局。改进后使院子形状尽量保持接近矩形」：
  // 布局层先定内院矩形、建筑沿它的四边向外排，所以院子天生是矩形。这里把内院
  // **剩下没被停车占用**的部分整片认领为院落绿地，后续的 L 形绿化 / 边带 /
  // 花坛 / 余量硬铺都不会再把院子切成碎片。kind='lawn' 会进 ⑦ 种树，得到
  // 截图里"院子里成片树"的效果。
  //
  // 刻意放在停车之后：停车仍按 parkShare 占一角，不会被内院挤到 0；
  // 内院 y 取 0.0108，比停车（0.0122）低，不会盖住车位线。
  if (opts.courtyard && opts.courtyard.outer.length >= 3) {
    const A = take(opts.courtyard.outer, 'lawn', 'grass', 0.0108, 40);
    if (A > 0) out.lawnM2 += A;
  }

  // ================================================================ ② 临街前场
  if (rect && rect.ring.length === 4 && footprintRing && footprintRing.length === 4) {
    const ring = frontStrip(rect, footprintRing);
    if (ring) {
      out.pavingM2 += take(ring, 'paving', pavingMat(use), 0.012);
    }
  }

  // ================================================================ ②b 建筑周边硬化
  //
  // 一圈 1.6~2.4 m 的硬地（散水 + 入户 + 后勤）。没有它，楼就像"浮在草上"；
  // 有了它，草地才不会贴着墙根长。所有用途都做，只是工业/园区更宽。
  if (footprints.length > 0 && residualM2 > 120) {
    const apron = U(use === 'industrial' || use === 'campus' ? 3.2 : 1.8);
    for (const fp of footprints) {
      let grown: PlanSurface[] = [];
      try {
        grown = surfaceOffset(fp, apron);
      } catch {
        grown = [];
      }
      if (!grown.length) continue;
      out.pavingM2 += take(grown[0].outer, 'paving', pavingMat(use), 0.0121, 6);
    }
  }

  // ================================================================ ③ L 形转角绿化
  //
  // 用户示意图里最标志性的一笔：建筑一角沿两条边向外折出 L 形绿地。
  // 做法是**两条互相垂直的矩形**在同一个角上相接，再一起裁到剩余面 ——
  // 比"在剩余面里随便撒一块草"可控得多，也不会跨过建筑。
  const wantGreenM2 = residualM2 * (opts.preset.greenShare ?? 0.25);
  let greenM2 = 0;
  if (residualM2 > 120 && wantGreenM2 > 30) {
    /**
     * 四个角各探一块 13×13 m 的"空面"，挑最空的角做 L。
     *
     * 之前固定选"后角"，但住宅前后双排之后后墙几乎贴到地块边，
     * L 被裁得只剩 12 m²，图上根本看不出是 L。现在按实际空面挑角，
     * 于是 L 总是落在真正有地的那一侧（通常是临街侧角或停车旁边）。
     */
    const probe = U(13);
    let bestCorner = { i: 0, area: -1 };
    const corners = [
      { u: frontU, v: vMin },
      { u: frontU, v: vMax },
      { u: backU, v: vMin },
      { u: backU, v: vMax },
    ];
    corners.forEach((c0, i) => {
      const du = c0.u === frontU ? probe : -probe;
      const dv = c0.v === vMin ? probe : -probe;
      const box = uvRect(Math.min(c0.u, c0.u + du), Math.max(c0.u, c0.u + du), Math.min(c0.v, c0.v + dv), Math.max(c0.v, c0.v + dv));
      const a = safeIntersect([{ outer: cleanRing(box), holes: [] }], remaining).reduce((t, q) => t + M2(surfaceArea(q)), 0);
      if (a > bestCorner.area) bestCorner = { i, area: a };
    });
    const c0 = corners[bestCorner.i];
    const atFront = c0.u === frontU;
    const atVMin = c0.v === vMin;
    const wLeg = U(4.6);
    const dLeg = U(7.5);
    // 沿 v 方向的一条（贴着那一侧的墙，进深 dLeg）
    const alongV = uvRect(atFront ? frontU : backU - dLeg, atFront ? frontU + dLeg : backU, atVMin ? vMin : vMax - wLeg, atVMin ? vMin + wLeg : vMax);
    // 沿 u 方向的一条（从同一个角往回收 45% 的面宽）
    const span = (vMax - vMin) * 0.45;
    const alongU = uvRect(atFront ? frontU : backU - wLeg, atFront ? frontU + wLeg : backU, atVMin ? vMin : vMax - span, atVMin ? vMin + span : vMax);
    greenM2 += take(alongV, 'greenL', 'lawn', 0.0131, 8);
    greenM2 += take(alongU, 'greenL', 'lawn', 0.0132, 8);
  }

  // ================================================================ ④ 沿边种植带
  if (greenM2 < wantGreenM2 && residualM2 > 140) {
    const w = U(2.2);
    greenM2 += take(uvRect(backU - w, backU, vMin + U(0.6), vMax - U(0.6)), 'greenEdge', 'lawn', 0.0117, 10);
    greenM2 += take(uvRect(fFrontU, backU, vMin, vMin + w), 'greenEdge', 'lawn', 0.0117, 10);
    greenM2 += take(uvRect(fFrontU, backU, vMax - w, vMax), 'greenEdge', 'lawn', 0.0117, 10);
  }

  // ================================================================ ⑤ 广场花坛
  //
  // 临街前场够宽时，在入口另一侧放一个 4×9 m 的规则花坛（带树），
  // 这是商业/公共地块最容易读出"设计感"的一笔。
  if (bandM > 26 && residualM2 > 260 && (use === 'commercial' || use === 'cbd' || use === 'civic')) {
    const pv = rng() < 0.5 ? fV0 - U(5.5) : fV1 + U(1.5);
    const planter = uvRect(fFrontU + U(1.2), Math.min(fBackU, fFrontU + U(9)), pv, pv + U(4));
    const got = take(planter, 'planter', 'lawn', 0.0119, 8);
    if (got > 0) {
      greenM2 += got;
      out.trees.push({ at: fromUV((fFrontU + U(5)) , pv + U(2)), scale: 0.9, seed: Math.floor(rng() * 1000) });
    }
  }

  // ================================================================ ⑤b 内侧开放空间
  //
  // 用户判据：普通商业"中间区域可以不填充建筑，以绿化相关用地和广场空地或停车场填充"。
  // 布局层已经不在内侧放建筑；停车在 ① 优先占了背面，L 形/边带绿化在 ③④ 落位，
  // 这里补第三种 —— 建筑后墙之后、地块中部的一块规则广场。只取 v 方向中间 50%，
  // 两侧仍留给绿化，避免把整块内侧刷成一片硬地。
  if ((use === 'commercial' || use === 'cbd') && residualM2 > 260) {
    const plazaU0 = fBackU + U(1.5);
    const plazaU1 = Math.min(backU - U(1), plazaU0 + U(16));
    const span = vMax - vMin;
    if (plazaU1 > plazaU0 + U(4) && span > U(14)) {
      out.pavingM2 += take(
        uvRect(plazaU0, plazaU1, vMin + span * 0.25, vMax - span * 0.25),
        'paving',
        'stonePave',
        0.0126,
        20
      );
    }
  }

  out.lawnM2 += greenM2;

  // ================================================================ ⑥ 余量：硬质铺装
  //
  // 这里刻意**不刷草**：上一版"面积 ≥26 m² 就铺草"，全城看起来像一片草地
  // 上散着几栋楼。真实地块的余量是硬地（停车周边、后勤、宅间活动），
  // 绿化只出现在上面几个明确语法里。
  const rest = remaining;
  for (const q of rest) {
    const A = M2(surfaceArea(q));
    if (A < 3) continue;
    /**
     * 余量材质：住宅/商业/CBD 是**绿地**（有边带和 L 形绿化做骨架，不是乱撒），
     * 工业/园区/公共设施是硬地（货场、集散）。上一版全刷草地、这一版先全刷硬地，
     * 都是"一刀切"；按用途给才是规则驱动。
     */
    const keepGreen = use !== 'industrial' && use !== 'civic';
    out.patches.push({
      ring: q.outer,
      holes: q.holes,
      mat: keepGreen ? 'grass' : 'concrete',
      kind: keepGreen ? 'lawn' : 'hard',
      y: 0.0112,
    });
    if (keepGreen) {
      out.lawnM2 += A;
      claimed.push(q);
    } else {
      out.pavingM2 += A;
    }
  }

  // ================================================================ ⑦ 树
  const greenPolys = out.patches
    .filter((p) => p.kind === 'lawn' || p.kind === 'greenL' || p.kind === 'greenEdge' || p.kind === 'planter')
    .map((p) => ({ outer: p.ring, holes: p.holes ?? [] }));
  for (const lawn of greenPolys) {
    const A = M2(surfaceArea(lawn));
    if (A < 26) continue;
    const count = Math.min(90, Math.floor(A / (use === 'park' ? 55 : 70)));
    if (count <= 0) continue;
    const bb = bbox(lawn.outer);
    let placed = 0;
    for (let k = 0; k < count * 14 && placed < count; k++) {
      const p = new Pt(bb.minX + rng() * (bb.maxX - bb.minX), bb.minY + rng() * (bb.maxY - bb.minY));
      if (!insideSurface(p, lawn)) continue;
      if (!insideSurface(new Pt(p.x + U(1.8), p.y), lawn)) continue;
      if (!insideSurface(new Pt(p.x - U(1.8), p.y), lawn)) continue;
      if (!insideSurface(new Pt(p.x, p.y + U(1.8)), lawn)) continue;
      if (!insideSurface(new Pt(p.x, p.y - U(1.8)), lawn)) continue;
      if (opts.entrances.some((e) => Pt.distance(e, p) < U(3.2))) continue;
      if (out.trees.some((t) => Pt.distance(t.at, p) < U(3.6))) continue;
      out.trees.push({ at: p, scale: 0.82 + rng() * 0.34, seed: Math.floor(rng() * 1000) });
      placed++;
    }
  }

  if (out.note === '') {
    out.note =
      `前场/硬铺 ${out.pavingM2.toFixed(0)} m² · 停车 ${out.parkingM2.toFixed(0)} m²（${out.bays} 位）· ` +
      `绿化 ${out.lawnM2.toFixed(0)} m²（L 形 / 边带 / 花坛）`;
  }
  return out;
}

/** 地上停车：按用途给目标占比与上限（房建规范不是目标，游戏观感才是） */
const PARK_SHARE: Record<string, number> = {
  commercial: 0.32,
  cbd: 0.1,
  industrial: 0.34,
  campus: 0.24,
  civic: 0.18,
  residential: 0.12,
  park: 0,
  green: 0,
};
const PARK_CAP: Record<string, number> = {
  commercial: 620,
  cbd: 420,
  industrial: 2400,
  campus: 1400,
  civic: 600,
  residential: 260,
  park: 0,
  green: 0,
};

function extents(uv: { u: number; v: number }[]): { u0: number; u1: number; v0: number; v1: number } {
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (const p of uv) {
    u0 = Math.min(u0, p.u);
    u1 = Math.max(u1, p.u);
    v0 = Math.min(v0, p.v);
    v1 = Math.max(v1, p.v);
  }
  return { u0, u1, v0, v1 };
}

/**
 * 路边平行式停车带的标线（GB 5768.3 §5.12）。
 *
 * 只在**狭长铺装**上用：一条连续边线（距路缘 2.5 m）+ 每 6.3 m 一根
 * 2.3 m 短分隔线。短分隔线只占带宽的一小截，不会像垂直车位那样把整条
 * 沥青横着切成一格一格的"梯子"。
 *
 * `se` 是铺装面在 (u,v) 局部坐标里的外接范围；长轴自动从 u/v 里较长的
 * 那一边选，所以横着、竖着的狭长带都适用。
 */
function parallelBayLines(
  se: { u0: number; u1: number; v0: number; v1: number },
  fromUV: (u: number, v: number) => Pt
): [Pt, Pt][] {
  const du = se.u1 - se.u0;
  const dv = se.v1 - se.v0;
  const alongV = dv >= du;
  const lo = alongV ? se.v0 : se.u0;
  const hi = alongV ? se.v1 : se.u1;
  const cLo = alongV ? se.u0 : se.v0;
  const cHi = alongV ? se.u1 : se.v1;
  const P = (a: number, c: number): Pt => (alongV ? fromUV(c, a) : fromUV(a, c));
  const edge = cLo + Math.min(U(2.5), (cHi - cLo) * 0.45);
  const n = Math.max(2, Math.floor(((hi - lo) * 7) / 6.3));
  const lines: [Pt, Pt][] = [];
  // 基线按泊位分段：一整条长直线只要有一处蹭出凹口就会被 `linesInside`
  // 整条丢掉（实测放大图里只剩 5 根孤立白短杠，读不成"一条边线"）。
  // 分段之后每段只覆盖 6.3 m，端点相接仍是一条连续边线，且各自能独立通过裁切。
  for (let i = 0; i < n; i++) {
    const a0 = lo + ((hi - lo) * i) / n;
    const a1 = lo + ((hi - lo) * (i + 1)) / n;
    lines.push([P(a0, edge), P(a1, edge)]);
  }
  for (let i = 0; i <= n; i++) {
    const a = lo + ((hi - lo) * i) / n;
    lines.push([P(a, cLo + U(0.15)), P(a, edge)]);
  }
  return lines;
}

function centroidOfSurface(s: PlanSurface): Pt {
  // 面积加权形心：用外环鞋带公式，凹多边形也不会偏
  const r = s.outer;
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < r.length; i++) {
    const p = r[i];
    const q = r[(i + 1) % r.length];
    const cr = p.x * q.y - q.x * p.y;
    a += cr;
    cx += (p.x + q.x) * cr;
    cy += (p.y + q.y) * cr;
  }
  if (Math.abs(a) < 1e-9) return centroid(r);
  return new Pt(cx / (3 * a), cy / (3 * a));
}

// ---------------------------------------------------------------- 工具

/**
 * 临街前场：控制矩形与建筑 Footprint 之间的条带（临街那一侧）。
 *
 * 两个环都是 4 顶点、边序一致（0=后 1=右 2=临街 3=左），
 * 所以前场就是一个四边形：footprint 的临街两角 + 控制矩形的临街两角。
 * 不需要布尔运算 —— 内退本来就是沿边平移，两条临街边严格平行。
 */
function frontStrip(rect: InscribedRect, footprint: Pt[]): Pt[] | null {
  const r = rect.ring;
  const f = footprint;
  if (r.length !== 4 || f.length !== 4) return null;
  const quad = cleanRing([f[2], f[3], r[3], r[2]]);
  if (quad.length < 3) return null;
  const A = Math.abs(M2(surfaceArea({ outer: quad, holes: [] })));
  return A > 6 ? quad : null;
}

function pavingMat(use: BuildingParcel['use']): MatKey {
  switch (use) {
    case 'commercial':
    case 'cbd':
      return 'stonePave';
    case 'industrial':
      return 'concrete';
    case 'civic':
    case 'campus':
      return 'paver';
    default:
      return 'paver';
  }
}

function safeSubtract(a: PlanSurface[], b: PlanSurface[]): PlanSurface[] {
  if (b.length === 0) return a;
  const out: PlanSurface[] = [];
  for (const s of a) {
    try {
      for (const q of surfaceSubtract([s], b)) if (M2(surfaceArea(q)) > 0.5) out.push(q);
    } catch {
      out.push(s);
    }
  }
  return out;
}

function safeIntersect(a: PlanSurface[], b: PlanSurface[]): PlanSurface[] {
  const out: PlanSurface[] = [];
  for (const s of a) {
    try {
      for (const q of surfaceIntersect([s], b)) if (M2(surfaceArea(q)) > 0.5) out.push(q);
    } catch {
      /* 忽略：交集失败不产出，比产出错误几何好 */
    }
  }
  return out;
}

/**
 * 车位前缘线：`solveParking` 给的是**每个车位一段短封口线**，画出来是一排
 * 断断续续的"梳齿"（截图 2 里那些孤立短横）。GB 5768.3 的停车位标线是
 * 一条连续边线 + 等距分隔线，所以这里把同一排、共线且首尾相接的短段并成
 * 一条通长基线。树池 / 模块缝（≥2.4 m）不并，那里本来就该断开。
 */
function mergeStallFronts(lines: [Pt, Pt][]): [Pt, Pt][] {
  interface Group {
    cs: number;
    sn: number;
    n: number;
    segs: { t0: number; t1: number }[];
  }
  const groups = new Map<string, Group>();
  for (const [a, b] of lines) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (Math.hypot(dx, dy) < 1e-9) continue;
    let ang = Math.atan2(dy, dx);
    // 方向归一到 [-90°, 90°)：反向的段属于同一排
    if (ang < -Math.PI / 2 || ang >= Math.PI / 2) ang += Math.PI;
    const cs = Math.cos(ang);
    const sn = Math.sin(ang);
    const n = -a.x * sn + a.y * cs;
    const key = `${Math.round(ang * 200)}|${Math.round(n * 200)}`;
    const t0 = a.x * cs + a.y * sn;
    const t1 = b.x * cs + b.y * sn;
    const g = groups.get(key) ?? { cs, sn, n, segs: [] };
    g.segs.push({ t0: Math.min(t0, t1), t1: Math.max(t0, t1) });
    groups.set(key, g);
  }
  const out: [Pt, Pt][] = [];
  // 相邻车位段首尾相接（差 0）；树池 2.4 m、模块缝 3.4 m 会明显大于这个容差
  const tol = U(0.9);
  for (const g of groups.values()) {
    g.segs.sort((x, y) => x.t0 - y.t0);
    const emit = (t0: number, t1: number): void => {
      if (t1 - t0 < U(1.2)) return;
      out.push([
        new Pt(t0 * g.cs - g.n * g.sn, t0 * g.sn + g.n * g.cs),
        new Pt(t1 * g.cs - g.n * g.sn, t1 * g.sn + g.n * g.cs),
      ]);
    };
    let cur = g.segs[0];
    for (let i = 1; i < g.segs.length; i++) {
      const s = g.segs[i];
      if (s.t0 - cur.t1 <= tol) cur = { t0: cur.t0, t1: Math.max(cur.t1, s.t1) };
      else {
        emit(cur.t0, cur.t1);
        cur = s;
      }
    }
    emit(cur.t0, cur.t1);
  }
  return out;
}

/**
 * 车位线裁到**实际铺装面**内。
 *
 * 旧版在 `innerRing`（候选最大矩形）上解车位，铺装却只取它和剩余面求交后的
 * 一小块 `pieces[0]`，两套几何不一致 —— 截图 2 里那些"悬在黑底上的梳子"
 * 就是没铺到沥青上的车位线。这里按 5 点采样，整条线都在铺装面（含洞）
 * 内才保留；宁可少画几格，也不把线画到草地/建筑上。
 */
function linesInside(lines: [Pt, Pt][], s: PlanSurface): [Pt, Pt][] {
  return lines.filter(([a, b]) => {
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      if (!insideSurface(new Pt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t), s)) return false;
    }
    return true;
  });
}

function centroid(ring: Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p.x;
    y += p.y;
  }
  return new Pt(x / Math.max(1, ring.length), y / Math.max(1, ring.length));
}

function bbox(ring: Pt[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of ring) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

// ---------------------------------------------------------------- 公园

/** 公园/绿地：草坪 + 十字园路 + 水塘 + 树阵 */
export function parkGround(parcel: BuildingParcel, opts: GroundOpts): GroundOut {
  const rng = makeRng(opts.seed, `park-${parcel.id}`);
  const out: GroundOut = { ...EMPTY, patches: [], stallLines: [], trees: [], props: [] };
  const ring = parcel.surface.outer;
  const c = centroid(ring);
  out.patches.push({
    ring,
    holes: parcel.surface.holes,
    mat: parcel.use === 'green' ? 'grass' : 'lawn',
    kind: 'lawn',
    y: 0.0115,
  });
  out.lawnM2 += areaM2(parcel.surface);

  // 十字园路（不是道路层：它是 park path，只做地面材质）
  const ob = rectRing(c, U(2.2), U(Math.min(60, areaM2(parcel.surface) / 90)), 0);
  for (const [w, h, ang] of [
    [U(2.2), U(40), 0],
    [U(2.2), U(40), Math.PI / 2],
  ] as [number, number, number][]) {
    const path = rectRing(c, w, h, ang);
    const clipped = safeIntersect([{ outer: path, holes: [] }], [parcel.surface]);
    for (const q of clipped) {
      if (M2(surfaceArea(q)) < 10) continue;
      out.patches.push({ ring: q.outer, mat: 'paver', kind: 'paving', y: 0.013 });
      out.pavingM2 += M2(surfaceArea(q));
    }
  }
  void ob;

  // 小水塘
  if (areaM2(parcel.surface) > 7000) {
    const r = U(9 + rng() * 6);
    const pond: Pt[] = [];
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const rr = r * (0.82 + rng() * 0.36);
      pond.push(new Pt(c.x + Math.cos(a) * rr, c.y + Math.sin(a) * rr));
    }
    const clipped = safeIntersect([{ outer: pond, holes: [] }], [parcel.surface]);
    for (const q of clipped) {
      if (M2(surfaceArea(q)) < 30) continue;
      out.patches.push({ ring: q.outer, mat: 'water', kind: 'water', y: 0.0125 });
    }
  }

  // 树阵
  const count = Math.min(180, Math.floor(areaM2(parcel.surface) / 160));
  const bb = bbox(ring);
  let placed = 0;
  for (let k = 0; k < count * 14 && placed < count; k++) {
    const p = new Pt(bb.minX + rng() * (bb.maxX - bb.minX), bb.minY + rng() * (bb.maxY - bb.minY));
    if (!insideSurface(p, parcel.surface)) continue;
    if (out.patches.some((q) => q.kind === 'water' && insideSurface(p, { outer: q.ring, holes: [] }))) continue;
    if (out.trees.some((t) => Pt.distance(t.at, p) < U(6.5))) continue;
    out.trees.push({ at: p, scale: 0.9 + rng() * 0.5, seed: Math.floor(rng() * 1000) });
    placed++;
  }
  out.note = `公园：草坪 ${out.lawnM2.toFixed(0)} m² · 树木 ${out.trees.length}`;
  return out;
}

export function treeProp(at: Pt, scale: number, seed: number, group: string): PropFeature {
  return { name: `tree_${seed}`, group, kind: 'tree', at, rot: (seed % 100) / 100 * Math.PI, scale, seed };
}

void MAT;
