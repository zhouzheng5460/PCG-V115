// Planning · Typology → Candidate 生成器映射（唯一出口）
//
// 为什么单独抽出来：Shadow Runner 和前端 Planner Mode 都需要"按 typology 找生成器"。
// 之前映射表写在 `shadow/runner.ts` 里，前端若照抄一份就会变成两份真相 ——
// 改了一个 typology 的生成器，另一个不跟着改，Shadow 报的数和前端看到的数对不上。
//
// 这里只做**路由**，不含任何规划逻辑：
//   SiteContext → 生成器 → SitePlanCandidate[]
//
// 生成器自己只吃 SiteContext、只吐 SitePlanCandidate，不碰 Scene / three。

import type { SiteContext, SiteTypology } from './core/types';
import type { SitePlanCandidate } from './core/candidate';
import { generateIndustrialRearLoadCandidates } from './archetypes/industrial/rear-load';
import { generateMultiFamilyCourtyardCandidates } from './archetypes/multifamily/courtyard';
import { generateRetailStripCandidates } from './archetypes/retail/strip';
import { generateHotelGurbanCandidates } from './archetypes/hotel/gurban';
import { generateDataCenterSingleHallCandidates } from './archetypes/datacenter/single-hall';
import { generateSingleFamilyGridCandidates } from './archetypes/singlefamily/grid';
import { generateGreenCandidates } from './archetypes/green/meadow';
import { generateParkCandidates } from './archetypes/park/paths';
import { generateCivicCandidates } from './archetypes/civic/hall';
import { asRects } from './archetypes/shared/rect';
import { claimResidual } from './archetypes/shared/claim';
import { rectsInArea } from './archetypes/shared/rect';
import { INDUSTRIAL_INTENSITY } from './typologies/industrial';
import { MF_INTENSITY } from './typologies/multifamily';
import { RETAIL_INTENSITY } from './typologies/retail';
import { surface, surfaceSubtract, surfaceArea as areaOf, type PlanSurface } from './core/surface';
import { Pt } from '../../core/geom';
import { evaluateLayout, weightsFor } from './core/evaluator';
import { surfaceArea } from './core/surface';
import type { LayoutDiagnostics } from './core/types';
import { industrialDiagnostics } from './typologies/industrial';
import { mfDiagnostics } from './typologies/multifamily';
import { retailDiagnostics } from './typologies/retail';
import { hotelDiagnostics } from './typologies/hotel';
import { dcDiagnostics } from './typologies/datacenter';
import { sfDiagnostics } from './typologies/singlefamily';
import { greenDiagnostics } from './typologies/green';
import { parkDiagnostics } from './typologies/park';
import { civicDiagnostics } from './typologies/civic';
import { generateSkeletonCandidates, type PatternMode, type S1Mode } from './skeleton';

/** typology → 生成器 */
export const PLANNING_GENERATORS: Partial<Record<SiteTypology, (ctx: SiteContext) => SitePlanCandidate[]>> = {
  industrial: generateIndustrialRearLoadCandidates,
  multi_family: generateMultiFamilyCourtyardCandidates,
  retail: generateRetailStripCandidates,
  hotel: generateHotelGurbanCandidates,
  data_center: generateDataCenterSingleHallCandidates,
  single_family: generateSingleFamilyGridCandidates,
  green: generateGreenCandidates,
  park: generateParkCandidates,
  civic: generateCivicCandidates,
};

/** typology → 诊断函数（矩形化之后要重算分，必须用同一个函数） */
const DIAGNOSTICS: Partial<Record<SiteTypology, (ctx: SiteContext, c: SitePlanCandidate) => LayoutDiagnostics>> = {
  industrial: industrialDiagnostics,
  multi_family: mfDiagnostics,
  retail: retailDiagnostics,
  hotel: hotelDiagnostics,
  data_center: dcDiagnostics,
  single_family: sfDiagnostics,
  green: greenDiagnostics,
  park: parkDiagnostics,
  civic: civicDiagnostics,
};

/**
 * 把所有建筑的 footprint 统一成**轴对齐矩形组**。
 *
 * 各 archetype 生成建筑时用的是 `矩形 ∩ 可建区`，在斜边 / 不规则地块上
 * 交出来的是梯形、五边形 —— 3D 里就是"被挤出来的怪形状"。
 *
 * 这一层放在**生成器出口**而不是每个 archetype 里：它是纯几何规整，
 * 与 typology 的语法无关。放在出口还保证了一件事 —— 所有走 Planner 的
 * 地块（六种类型、未来新增的类型）都自动是直角盒，不用逐个改。
 *
 * 矩形化之后 footprint 变了，diagnostics 必须**用同一个函数重算**，
 * 否则评分和几何对不上（覆盖率、围合度、碎片惩罚全都基于 footprint）。
 */
function rectifyBuildings(ctx: SiteContext, c: SitePlanCandidate): boolean {
  // **沿街基准角**：所有建筑按主临街面的方向分解。
  // 世界轴对齐会在斜街上切出"锯齿状垂直"的小块 —— 这是用户看到的那个问题。
  const f = ctx.primaryFrontage;
  const angle = f
    ? Math.atan2(f.parcelEdge[1].y - f.parcelEdge[0].y, f.parcelEdge[1].x - f.parcelEdge[0].x)
    : 0;
  let changed = false;
  const out: typeof c.buildings = [];
  for (const b of c.buildings) {
    const rects = asRects(b.footprint, { step: 0.2, minSide: 0.5, angle });
    if (rects.length === 1 && rects[0] === b.footprint) {
      out.push(b);
      continue;
    }
    changed = true;
    for (const r of rects) {
      out.push({ ...b, footprint: r, notes: [...(b.notes ?? []), rects.length > 1 ? '矩形分解' : ''] });
    }
  }
  if (changed) c.buildings = out;
  return changed;
}

/** typology → 强度带（覆盖率口径）。只给声明过带的类型补建筑。 */
const INTENSITY: Partial<Record<SiteTypology, { preferredMin: number }>> = {
  industrial: INDUSTRIAL_INTENSITY,
  multi_family: MF_INTENSITY,
  retail: RETAIL_INTENSITY,
};

/** 补建筑时的高度（按 typology 给，不要补出奇怪的塔） */
const INFILL_H: Partial<Record<SiteTypology, number>> = {
  industrial: 9 / 7,
  multi_family: 15 / 7, // 5 层：比主体略矮，读作"附属住宅"
  retail: 7 / 7, // 单层：像一排独立小店
};

/**
 * 地块容量补足：**按强度带的缺口补建筑**。
 *
 * ## 为什么需要
 *
 * 所有 archetype 的尺寸都是"按一个地块一个主体量"写死的（院子 26×22 m、
 * bar 进深 14~18 m、大盒 22 m 进深）。街区放大到 122 m 之后，大地块上
 * 主体量只占中间一块，四周全是绿地 —— 实测覆盖率 P50 只有 18~21%，
 * 强度带下限是 20~26%。用户看到的就是"大片空地 + 几栋楼"。
 *
 * ## 做法
 *
 * 不改 archetype 的形态语法（那会变成四套主次不清的平行逻辑），
 * 而是在**生成器出口**按缺口补：
 *   1. 算当前覆盖率，达到带下限就什么都不做；
 *   2. 否则从"可建区 − 建筑 − 硬质地面"里找空地；
 *   3. 每块空地取**轴对齐矩形**（复用矩形分解），面积不超过空地的 55%；
 *   4. 最多补 3 块，高度取 INFILL_H（比主体矮，读作附属建筑而不是又一个主楼）。
 *
 * 补的是"附属体量"：住宅区里的社区配套/小住宅、商业区里的独立小店、
 * 工业区里的附属仓储。这是真实城市大地块上本来就有的东西 ——
 * 不是凭空塞盒子凑面积。
 */
function topUpBuildings(ctx: SiteContext, c: SitePlanCandidate): void {
  const band = INTENSITY[ctx.typology];
  if (!band) return;
  // **口径必须和强度带一致**：强度带的 coverage 是 `建筑 / parcel`，
  // 不是 `建筑 / 可建区`。用可建区当分母会让"其实还差很多"的地块
  // 看起来已经够（可建区比 parcel 小 20~30%）。
  const lotA = areaOf(ctx.parcel);
  if (lotA < 1e-6) return;

  const bldA = c.buildings.reduce((a, b) => a + areaOf(b.footprint), 0);
  if (bldA / lotA >= band.preferredMin) return;

  // 空地：可建区减去建筑与硬质地面（绿地可以盖，配套就在绿地里）
  const hard = c.ground
    // `driveway` 必须在列表里：S1 的车行主通道就是它。漏掉的话，
    // "按覆盖率补建筑"会把附属体量直接放到车道上 —— 路被建筑压断，
    // 而且诊断里看不出来（补量的位置不经过任何交通检查）。
    .filter((g) => g.program === 'driveway' || g.program === 'parking' || g.program === 'employee_parking' || g.program === 'truck_court' || g.program === 'loading_apron' || g.program === 'service' || g.program === 'service_lane' || g.program === 'pedestrian' || g.program === 'entrance_forecourt')
    .map((g) => g.surface);
  const free = surfaceSubtract([ctx.buildableArea], [...c.buildings.map((b) => b.footprint), ...hard]);
  if (free.length === 0) return;

  const h = INFILL_H[ctx.typology] ?? 7 / 7;
  // 缺口面积：达到 preferredMin 还差多少
  const need = (band.preferredMin - bldA / lotA) * lotA;
  if (need <= 1e-6) return;

  let added = 0;
  let filled = 0;
  let running = bldA;
  // 从大到小取空地
  const sorted = [...free].sort((a, b) => areaOf(b) - areaOf(a));
  for (const piece of sorted) {
    if (added >= 4 || running / lotA >= band.preferredMin) break;
    const pa = areaOf(piece);
    if (pa < 200 / 49) continue; // < 200 m² 的空地不值得放一栋

    // 取这块空地的矩形（要求四角都在空地内，所以天然不越界）
    const rects = rectsInArea(piece, { step: 0.25, minSide: 0.7 });
    if (rects.length === 0) continue;
    let biggest = rects.reduce((a, b) => (areaOf(a) >= areaOf(b) ? a : b));

    // 目标：这一块最多承担缺口的一半，也最多占空地的 70%
    //（留出院子/通道 —— 补成"附属建筑"，不是"补丁式填满"）
    const cap = Math.min((need - filled) * 0.6, pa * 0.7);
    if (cap < 200 / 49) continue;
    const ba = areaOf(biggest);
    if (ba > cap) {
      // 以中心为基准等比缩小到 cap
      const sc = Math.sqrt(cap / ba);
      const ring = biggest.outer;
      const cx = ring.reduce((s2, q) => s2 + q.x, 0) / ring.length;
      const cy = ring.reduce((s2, q) => s2 + q.y, 0) / ring.length;
      biggest = surface(ring.map((q) => new Pt(cx + (q.x - cx) * sc, cy + (q.y - cy) * sc)));
    }
    if (areaOf(biggest) < 200 / 49) continue;

    c.buildings.push({
      role: ctx.typology === 'industrial' ? 'warehouse' : ctx.typology === 'retail' ? 'podium' : 'house',
      footprint: biggest,
      height: h,
      notes: ['地块容量补足（附属体量）'],
    });
    filled += areaOf(biggest);
    running += areaOf(biggest);
    added++;
  }
}

/**
 * 按 typology 生成候选；没有对应生成器就返回空数组。
 *
 * `opts.s1` 打开**场地布局骨架**（见 `planning/skeleton/`）：骨架候选**替换**
 * 原 archetype 的候选，而不是混在一起排 —— 两套的空间语法不同，混排会让
 * "评分最高"变成"哪套更容易被这套尺子量得高"，那就不是设计比较了。
 * 骨架一套都没有时自动回落原 archetype（复杂地块的简化回退）。
 */
export function generateCandidates(
  ctx: SiteContext,
  opts: { s1?: S1Mode; pattern?: PatternMode } = {}
): SitePlanCandidate[] {
  const gen = PLANNING_GENERATORS[ctx.typology];
  if (!gen) return [];
  const sk = generateSkeletonCandidates(ctx, opts.s1 ?? 'off', opts.pattern ?? 'off');
  const cands = sk.length > 0 ? sk : gen(ctx);

  const diag = DIAGNOSTICS[ctx.typology];
  for (const c of cands) {
    rectifyBuildings(ctx, c);
    // 骨架候选**不补量**：它的建筑是按布局意图排的，面积由组团格数控制。
    // 补量会往空地里塞附属盒子，正好破坏"有秩序"这件事。
    if (!c.archetype.startsWith('SK_')) topUpBuildings(ctx, c);

    // 矩形化会把斜边上的三角格子丢掉（约 8% 的可建区）。
    // 这些地如果不管，就成了"可建区里没有 program 的空白" —— 2D 上是一片
    // 纸面底色，度量上是 8.3% 无主地。所以补一次残地认领：
    // 大块给 typology 的绿地 program、小块给 residual。
    claimResidual(
      ctx,
      ctx.typology,
      [...c.ground.map((g) => g.surface), ...c.buildings.map((b) => b.footprint)],
      (program, s2, note) => {
        if (s2) c.ground.push({ program, surface: s2, area: surfaceArea(s2), ...(note ? { notes: [note] } : {}) });
      }
    );

    if (diag) {
      const d = diag(ctx, c);
      c.diagnostics = d;
      c.score = evaluateLayout(d, { weights: weightsFor(ctx.typology) }).score;
    }
  }
  cands.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return cands;
}
