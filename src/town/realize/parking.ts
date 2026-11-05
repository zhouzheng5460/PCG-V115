// Planning Realization · R4 Parking（ParkingRequest → 现有 parking.ts）
//
// 架构红线：**Solver 没有权利修改 region。**
//   request.region − obstacles = 真正可停的面积，Solver 只在这个结果里排。
// 这样"为了多塞几个车位就往外扩停车场"从 Contract 层就被堵死了。
//
// 第一版不追求车位数：角度集合（主朝向 + 30/45/60/90）里挑 aisleRatio 合理的那个，
// 排不出来就如实告警，而不是硬塞。

import { Pt } from '../../core/geom';
import { surface, surfaceArea, surfaceSubtract, type PlanSurface } from '../planning/core/surface';
import { solveParking } from '../parking';
import { bakedToLayout, lookupBaked, lookupBakedMiss } from '../parking/provider';
import type { SitePlanCandidate } from '../planning/core/candidate';
import type { RealizationContext, RealizerPart } from './contract';

const U = (m: number) => m / 7;

/**
 * 停车区要扣掉的"硬障碍"。
 *
 * 烘焙 Placemaker 与运行时扣障碍必须用**同一份清单**：两边的可用面一旦不同，
 * 几何哈希就对不上，会表现为"明明烘焙过却一直回退"。
 *
 * 只算建筑与明确不可停车的地面（庭院 / 装卸坪 / 货场 / 设备场 / 院子 / 绿地）。
 * `landscape` / `service` / `pedestrian` 是软边界，车位压上去不算违规，全算会把
 * 停车区减到几乎没剩。
 */
export const PARKING_HARD_PROGRAMS: string[] = [
  'courtyard', 'amenity', 'loading_apron', 'truck_court', 'dropoff',
  'mechanical_yard', 'electrical_yard', 'utility_yard', 'security_buffer',
  'front_yard', 'rear_yard', 'community_green',
];

export function parkingObstaclesOf(c: SitePlanCandidate): PlanSurface[] {
  return [
    ...c.buildings.map((b) => b.footprint),
    ...c.ground.filter((g) => PARKING_HARD_PROGRAMS.includes(g.program)).map((g) => g.surface),
  ];
}

export interface ParkingRealizationStat {
  requestIndex: number;
  /** 实际用哪套求解器算出来的 */
  provider?: 'legacy' | 'placemaker';
  role: string;
  usableArea: number;
  stalls: number;
  aisles: number;
  angleDeg: number;
  /** 车道**面**面积 m²（不是中心线长度） */
  aisleM2?: number;
  /** 景观岛个数 */
  islandCount?: number;
  /** 车道面连通分量（1 = 连成一片） */
  aisleComps?: number;
  /** 车位前缘落在车道面内的比例 */
  frontRate?: number;
  /** `Zone − asphalt` 里转成景观的面积 m² */
  lawnM2?: number;
  /** 同一块区域里**保留铺装**的面积（进出咽喉 / 过小碎片），需要报告 */
  deadPavingM2?: number;
}

/**
 * 整个候选的统一停车朝向。
 *
 * 车位朝向有 90° 周期（转 90° 是同一套车位），所以先把每个面的最长边方向
 * 折到 0~90°，再按**面积加权**投票（10° 一档）。面积加权很重要：
 * 一个 5000 m² 的主停车面不该被旁边 200 m² 的碎角带偏。
 *
 * 没有它的时候，每个面各选各的最优角度 —— 那是"每片塞得最多"的局部最优，
 * 合起来就是"车位线歪七扭八"的整体最差。
 */
export function globalParkingAxis(c: SitePlanCandidate, obstacles: PlanSurface[]): number {
  const PERIOD = Math.PI / 2;
  const BUCKET = Math.PI / 18; // 10°
  const votes = new Map<number, number>();
  for (const req of c.parkingRequests) {
    const parts = surfaceSubtract([req.region], obstacles).filter((p) => surfaceArea(p) > U(4) * U(4));
    for (const p of parts) {
      const a = longestEdgeAngle(p.outer);
      const folded = ((a % PERIOD) + PERIOD) % PERIOD;
      const key = Math.round(folded / BUCKET) * BUCKET;
      votes.set(key, (votes.get(key) ?? 0) + surfaceArea(p));
    }
  }
  let best = 0;
  let bestW = -1;
  for (const [a, w] of votes) {
    if (w > bestW) {
      bestW = w;
      best = a;
    }
  }
  return best;
}

/** 把每个 ParkingRequest 变成一个真实车位布局 */
export function realizeParking(
  c: SitePlanCandidate,
  ctx: RealizationContext,
  part: RealizerPart,
  obstacles: PlanSurface[]
): ParkingRealizationStat[] {
  const base = ctx.groundY ?? 0.012;
  const stats: ParkingRealizationStat[] = [];
  if (!ctx.solveParking) return stats;

  // 整个候选的统一停车朝向：所有停车面的最长边方向按面积加权投票，10° 一档
  const axis = globalParkingAxis(c, obstacles);

  c.parkingRequests.forEach((req, i) => {
    // ① region − obstacles（建筑 / 庭院 / 装卸坪 / 服务区 / 洞）
    const usableParts = surfaceSubtract([req.region], obstacles).filter((p) => surfaceArea(p) > U(4) * U(4));
    if (usableParts.length === 0) {
      part.warnings.push({
        code: 'PARKING_REGION_CONSUMED',
        message: `停车区域被障碍完全占据（${req.role}）`,
        target: `${c.id}_parkreq_${req.role}_${i}`,
      });
      return;
    }
    const usable = usableParts.reduce((a, b) => (surfaceArea(a) >= surfaceArea(b) ? a : b));

    // ② 角度：**用整个候选的统一朝向**，不是每个面自己的最长边。
    //
    // 原来每个停车面拿自己的最长边当主朝向，于是相邻两片可能一片 90°、
    // 一片 60° —— 车位线在交界处互相错开，一眼看就是"没设计过"。
    // 现在先全片投票出一个朝向（见 globalParkingAxis），每个面都从这个朝向
    // 出发，最多偏 45°（斜列兜底）。`solveParking` 里的 devOf 仍会惩罚斜列，
    // 所以能排下时一定用统一朝向。
    const angles = [axis, axis + Math.PI / 6, axis + Math.PI / 4, axis + Math.PI / 3];

    // ---- Provider 选择
    //
    // placemaker 走"离线烘焙 + 几何哈希查表"：浏览器里起不了 .NET 进程，
    // 所以 C# 的结果必须先烘焙成 JSON（tools/bake-parking.ts），运行时按
    // **可用停车面**的指纹查。查不到就明确告警并回退 legacy ——
    // 绝不能静默沿用旧数据，那会画出和地块对不上的车位。
    const providerId = ctx.parkingProvider ?? 'legacy';
    let layout: ReturnType<typeof solveParking> | null = null;
    let usedProvider: 'legacy' | 'placemaker' = 'legacy';
    let baked: ReturnType<typeof lookupBaked> = null;
    let compareCount = -1;
    if (providerId !== 'legacy') {
      // 烘焙与运行时必须扣**同一份**障碍（见 parkingObstaclesOf 的注释）
      const obs2 = parkingObstaclesOf(c);
      const parts2 = surfaceSubtract([req.region], obs2).filter((p) => surfaceArea(p) > U(4) * U(4));
      const usable2 = parts2.length
        ? parts2.reduce((a, b) => (surfaceArea(a) >= surfaceArea(b) ? a : b))
        : usable;
      baked = lookupBaked(usable2.outer);
      if (baked) {
        layout = bakedToLayout(baked);
        usedProvider = 'placemaker';
        compareCount = providerId === 'compare' ? layout.count : -1;
        // 闸门：**别比旧方案更差**。
        //
        // Placemaker 在同一区域上不一定排得更多（窄带/凹形尤其），
        // 而"启用它"不该等于"悄悄掉一半车位"。烘焙时已经算了同区域
        // legacy 的车位数，这里做一次对照：低于 90% 就退回 legacy 并说明。
        // 反过来，"PM 多但破坏公共空间"的情况由 Evaluator 的场地评分管，
        // 不在这一层判断。
        const lg2 = baked.diag.legacyStalls ?? 0;
        if (lg2 > 0 && baked.count < lg2 * 0.85) {
          part.warnings.push({
            code: 'PARKING_PM_WORSE',
            message:
              `Placemaker 在同一区域只排 ${baked.count} 位，legacy 能排 ${lg2} 位 ` +
              `（${req.role}）→ 采用 legacy；这不是失败，是该形状下 PM 的排布语法更费地`,
            target: `${c.id}_parkreq_${req.role}_${i}`,
          });
          layout = null;
          usedProvider = 'legacy';
        }
      } else {
        const why = lookupBakedMiss(usable2.outer);
        part.warnings.push(
          why
            ? {
                // 算过但排不出：这是 Placemaker 的能力边界，不是缓存问题
                code: 'PARKING_PM_EMPTY',
                message: `${why}（${req.role} ${(surfaceArea(usable2) * 49).toFixed(0)} m²）→ 回退 legacy`,
                target: `${c.id}_parkreq_${req.role}_${i}`,
              }
            : {
                code: 'PARKING_BAKE_MISS',
                message:
                  `Placemaker 没有这块停车区的烘焙结果（${(surfaceArea(usable2) * 49).toFixed(0)} m²，` +
                  `${req.role}）→ 回退 legacy；跑 \`npx tsx tools/bake-parking.ts\` 重新烘焙`,
                target: `${c.id}_parkreq_${req.role}_${i}`,
              }
        );
      }
    }
    if (!layout) layout = solveParking(usable.outer, { angles });
    if (!layout) {
      part.warnings.push({
        code: 'PARKING_NOT_SOLVED',
        message: `区域排不下车位（${(surfaceArea(usable) * 49).toFixed(0)} m²，${req.role}）`,
        target: `${c.id}_parkreq_${req.role}_${i}`,
      });
      return;
    }
    if (providerId === 'compare') {
      // 正式场景仍用 legacy；这里只把 Placemaker 的车位数记下来做 A/B
      const pm = lookupBaked(req.region.outer);
      part.warnings.push({
        code: 'PARKING_COMPARE',
        message:
          `compare：legacy ${layout.count} 位` +
          (pm ? ` / placemaker ${pm.count} 位（仅诊断，未写入场景）` : ' / placemaker 未烘焙'),
        target: `${c.id}_parkreq_${req.role}_${i}`,
      });
    }
    void compareCount;

    // ③ 通道**不单独成面**：停车区底色已经是 asphaltLot，再叠一层沥青会让
    //    "地面独占性"失真（parity 的 overlap 会算进去）。通道信息保留在 stats 里。
    // ④ 车位分隔线
    for (const [k, seg] of layout.dividers.entries()) {
      part.paths.push({
        name: `${c.id}_stall_${i}_${k}`,
        group: ctx.group,
        pts: [seg[0], seg[1]],
        width: U(0.1),
        mat: 'markWhite',
        y: base + 0.0026,
      });
    }

    // ④a 车位带：整排车位的底，浅一档。
    //
    // 停车场的读法应该是"车位浅、车道深"。只有 `asphaltLot` 一层底 + 细白线时，
    // 一排 58 个车位看起来就是"一块深灰 + 一排细线"；锥形处更像没人用的空地。
    // 铺一层 `stallBand` 之后，"车位在哪儿"是一眼能看出来的条带。
    for (const [k, band] of (baked?.rowBands ?? []).entries()) {
      part.surfaces.push({
        name: `${c.id}_pk_band_${i}_${k}`,
        group: ctx.group,
        ring: band.map(([x, y]) => new Pt(x, y)),
        mat: 'stallBand',
        y: base + 0.0016,
        role: 'overlay',
      });
    }

    // ④b 通道面 + 树岛面：专业总图上"车位 / 通道 / 树岛"是三层不同材质。
    //
    //   parking        asphaltLot（0.268，车位底）
    //   parking_aisle  asphalt   （0.243，通道 —— **比车位底深一档**）
    //   parking_island grass
    //
    // 通道当年用 `curb`（0.80 的米白），是因为那时 `layout.aisles` 永远是空的、
    // 没人真看到过。S2.5 把 Placemaker 的车道面接进来之后，米白一条横在停车场
    // 中间像人行道 —— 真实总图上通道和车位是同一色系，靠白线读出来。
    for (const [k, a] of layout.aisles.entries()) {
      part.surfaces.push({
        name: `${c.id}_pk_aisle_${i}_${k}`,
        group: ctx.group,
        ring: a,
        mat: 'asphalt',
        y: base + 0.0018,
        role: 'overlay',
      });
    }
    for (const [k, isl] of layout.islands.entries()) {
      part.surfaces.push({
        name: `${c.id}_pk_island_${i}_${k}`,
        group: ctx.group,
        ring: isl,
        mat: 'grass',
        y: base + 0.0022,
        role: 'overlay',
      });
    }
    // 模块之间的横向步道：铺**沥青**（比车位底色深一档），
    // 它才是把一条 300 车位的长排切成"一段一段"的那条线。
    for (const [k, wk] of layout.walks.entries()) {
      part.surfaces.push({
        name: `${c.id}_pk_walk_${i}_${k}`,
        group: ctx.group,
        ring: wk,
        mat: 'curb',
        y: base + 0.0019,
        role: 'overlay',
      });
    }

    // ④c 停车场地面语义：把 Placemaker 铺了、但**没有任何功能**的沥青铺成绿地。
    //
    // 判据（烘焙时算好，运行时只负责画）：
    //   `Zone − (车道中心线 ± 8.65 m 的可达带) − 景观岛`
    // 8.65 = 车道半宽 3.15 + 车位深 4.68 + 开关车门余量。也就是说，带子以外
    // 的沥青既停不了车、也开不进去 —— retail 176:176 那块约 500 m² 的深色三角
    // 就是它。带子以内一律保留铺装。
    //
    // **不是一律变绿**：与场地车行道相接的进出喉咙、以及等效宽度 < 3.5 m 的碎片
    // 继续留铺装，面积记进 `deadPavingM2` 并在报告里列出来。
    let lawnM2 = 0;
    let deadPavingM2 = baked?.diag.deadPavingM2 ?? 0;
    for (const [k, ring] of (baked?.lawn ?? []).entries()) {
      const pts = ring.map(([x, y]) => new Pt(x, y));
      lawnM2 += Math.abs(ringAreaU(pts)) * 49;
      part.surfaces.push({
        name: `${c.id}_pk_lawn_${i}_${k}`,
        group: ctx.group,
        ring: pts,
        mat: 'grass',
        y: base + 0.0021,
        role: 'overlay',
      });
    }

    // ⑤ 树岛：**按车位排的真实位置**种，不再随机撒。
    //
    // `layout.islands` 是每 6 个车位之间那条 1.5 m 的树池带（只占车位排、
    // 不穿通道）。一条树池种 1~2 棵，密度比绿地低得多，读起来是
    // "每 4~6 个车位一组、组间有绿化"的真实停车场，而不是"车停在树林里"。
    for (const [k, isl] of layout.islands.entries()) {
      // **隔一条树池种一条**：每条都种的话，双排 + 每 6 位一条 → 视觉上
      // 变成"一道绿篱横穿停车场"，比纯灰还难受。隔一条种，读起来才是
      // "每 10~12 个车位一组、组间有绿化"。
      if (k % 2 !== 0) continue;
      const cx = isl.reduce((a, q) => a + q.x, 0) / isl.length;
      const cy = isl.reduce((a, q) => a + q.y, 0) / isl.length;
      part.props.push({
        name: `${c.id}_island_${i}_${k}`,
        group: ctx.group,
        kind: 'treeSmall',
        at: new Pt(cx, cy),
        rot: ((k * 1.7 + i * 0.9) % 1) * Math.PI * 2,
        // 树池只有 1.5 m 宽，树冠要小 —— 不然会盖住两侧车位
        scale: 0.42 + ((k * 0.37) % 1) * 0.08,
        seed: (k * 0.61 + i * 0.23) % 1,
      });
    }

    // 车道面 / 连通性：placemaker 直接读它的诊断，legacy 现场量
    let aisleM2 = 0;
    for (const poly of layout.aisles) {
      let a2 = 0;
      for (let q = 0; q < poly.length; q++) {
        const u = poly[q];
        const v = poly[(q + 1) % poly.length];
        a2 += u.x * v.y - v.x * u.y;
      }
      aisleM2 += Math.abs(a2 / 2) * 49;
    }
    stats.push({
      requestIndex: i,
      role: req.role,
      usableArea: surfaceArea(usable),
      stalls: layout.count,
      aisles: layout.aisles.length,
      provider: usedProvider,
      angleDeg: Math.round((layout.angle * 180) / Math.PI),
      aisleM2,
      islandCount: layout.islands.length,
      aisleComps: usedProvider === 'placemaker' ? (baked?.diag.aislePolyComponents ?? 1) : 0,
      frontRate: usedProvider === 'placemaker' ? (baked?.diag.stallFrontPolyRate ?? 0) : 0,
      // 语义分区结果：转成景观的空地 / 因"可能是转弯或喉咙"而保留的铺装
      lawnM2,
      deadPavingM2,
    });
  });

  return stats;
}

/** 环的有向面积（世界单位²） */
function ringAreaU(ring: Pt[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

function longestEdgeAngle(ring: Pt[]): number {
  let best = 0;
  let len = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    if (l > len) {
      len = l;
      best = Math.atan2(b.y - a.y, b.x - a.x);
    }
  }
  return best;
}
