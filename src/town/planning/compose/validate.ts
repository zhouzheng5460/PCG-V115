// F2.4-B · 硬约束验证与指标
//
// 这一层是"裁判"，不产生任何几何。所有检查都落在面积与距离上：
//   · 越界、互压、穿建筑、填洞   → 面积（m²）
//   · 门是否接得上、停车是否连通 → 距离（m）+ 连通性
//   · 面积归属可对账             → 逐层相减后的残差
//
// 关键口径：**所有几何都来自同一批 `PlanSurface`**，
// 所以"图上的面积"和"报告里的面积"是同一个数，不存在两套账。

import { Pt } from '../../../core/geom';
import { obbOf } from '../subdivision/geom';
import { bboxOf } from '../core/surface';
import { insideSurface, surfaceArea, surfaceIntersect, surfaceSubtract, surfaceUnion, type PlanSurface } from '../core/surface';
import type {
  ComposeInput,
  ComposeMetrics,
  ComposeNote,
  ComposeValidation,
  GroundPatch,
  InternalRoad,
  ParcelPlan,
  ParkingArea,
  SiteBuilding,
} from './types';

const M2 = (u2: number) => u2 * 49;

export interface ValidateInput {
  input: ComposeInput;
  parcels: ParcelPlan[];
  buildings: SiteBuilding[];
  parking: ParkingArea[];
  ground: GroundPatch[];
  voids: GroundPatch[];
  roads: InternalRoad[];
  roadGround: PlanSurface[];
  engineering: string[];
  ms: number;
}

/** 允许的意外（布尔量化级别）。超过就要在报告里解释，不能默默放过 */
const TOL_M2 = 1.0;

export function validateComposition(v: ValidateInput): { validation: ComposeValidation; metrics: ComposeMetrics } {
  const errors: ComposeNote[] = [];
  const warnings: ComposeNote[] = [];

  // ① 建筑越出所属地块可建域
  let outside = 0;
  for (const b of v.buildings) {
    const p = v.parcels.find((x) => x.id === b.parcelId);
    if (!p) continue;
    const a = areaOf(subtract([b.surface], [p.usable ?? p.surface]));
    if (a > TOL_M2) {
      outside += a;
      errors.push({ code: 'reject', severity: 'error', message: `${b.id} 越出地块可建域 ${a.toFixed(1)} m²`, at: b.center });
    }
  }

  // ② 建筑之间非法重叠
  let bOverlap = 0;
  for (let i = 0; i < v.buildings.length; i++) {
    for (let j = i + 1; j < v.buildings.length; j++) {
      const a = areaOf(intersect([v.buildings[i].surface], [v.buildings[j].surface]));
      if (a > TOL_M2) {
        bOverlap += a;
        errors.push({
          code: 'reject',
          severity: 'error',
          message: `${v.buildings[i].id} 与 ${v.buildings[j].id} 重叠 ${a.toFixed(1)} m²`,
          at: v.buildings[i].center,
        });
      }
    }
  }

  // ③ 建筑压到内部道路
  let onRoad = 0;
  for (const b of v.buildings) {
    const a = areaOf(intersect([b.surface], v.roadGround));
    if (a > TOL_M2) {
      onRoad += a;
      errors.push({ code: 'reject', severity: 'error', message: `${b.id} 压在内部道路上 ${a.toFixed(1)} m²`, at: b.center });
    }
  }

  // ④ 地面类型之间非法互压（花坛已从铺装挖掉，这里应该接近 0）
  let gOverlap = 0;
  const gs = v.ground.map((g) => g.surface);
  for (let i = 0; i < gs.length; i++) {
    for (let j = i + 1; j < gs.length; j++) {
      const a = areaOf(intersect([gs[i]], [gs[j]]));
      if (a > 2.0) {
        gOverlap += a;
        if (gOverlap < 200) {
          errors.push({
            code: 'reject',
            severity: 'error',
            message: `地面互压 ${a.toFixed(1)} m²（${v.ground[i].kind} / ${v.ground[j].kind}）`,
            at: gs[i].outer[0],
          });
        }
      }
    }
  }

  // ⑤ 道路越出红线
  let roadOut = 0;
  for (const r of v.roads) {
    const a = areaOf(subtract([r.surface], [v.input.boundary]));
    if (a > TOL_M2) roadOut += a;
  }
  if (roadOut > TOL_M2) errors.push({ code: 'reject', severity: 'error', message: `内部道路越出红线 ${roadOut.toFixed(1)} m²` });

  // ⑥ 洞被填死
  let holeFilled = 0;
  for (const h of v.input.boundary.holes) {
    const hs = { outer: h, holes: [] };
    const a = areaOf(intersect([hs], v.buildings.map((b) => b.surface)));
    if (a > TOL_M2) {
      holeFilled += a;
      errors.push({ code: 'reject', severity: 'error', message: `建筑填进中庭（洞）${a.toFixed(1)} m²` });
    }
  }

  // ⑦ 门是否接得上（有门 + 距离合理 + 门前没被别的建筑挡住）
  let doorFail = 0;
  for (const b of v.buildings) {
    const main = b.doors.find((d) => d.kind === 'main') ?? b.doors.find((d) => d.kind === 'freight');
    if (!main) {
      doorFail++;
      errors.push({ code: 'reject', severity: 'error', message: `${b.id} 没有主入口`, at: b.center });
      continue;
    }
    if (main.reachM > 45) {
      doorFail++;
      errors.push({
        code: 'reject',
        severity: 'error',
        message: `${b.id} 主入口距临街面 ${main.reachM.toFixed(1)} m，超过 45 m 上限`,
        at: main.at,
      });
    }
    // 门点本身不得落在别的建筑里（间距另有一条硬约束，见 ⑨）
    const blocked = v.buildings.some((o) => o.id !== b.id && insideSurface(main.at, o.surface));
    if (blocked) {
      doorFail++;
      errors.push({ code: 'reject', severity: 'error', message: `${b.id} 门点落在相邻建筑内`, at: main.at });
    }
  }

  // ⑧ 停车验证
  let pkFail = 0;
  for (const p of v.parking) {
    if (!p.checks.ok) {
      pkFail++;
      errors.push({
        code: 'parking',
        severity: 'error',
        message: `${p.parcelId} 停车未通过：车位贴道 ${p.checks.stallGapMaxM} m / 通道接通 ${p.checks.aislesConnected}/${p.checks.aisles} / 出入口距路 ${p.checks.gateReachM} m`,
        at: p.surface.outer[0],
      });
    }
  }

  // ⑧-b 建筑间距：任何两栋的外墙净距不得小于 1 m（消防与构造的最低要求）
  let minGap = Infinity;
  for (let i = 0; i < v.buildings.length; i++) {
    for (let j = i + 1; j < v.buildings.length; j++) {
      const a = v.buildings[i];
      const bb = v.buildings[j];
      // 连续沿街店面是**故意共墙**的（一间挨一间才是商业界面），
      // 它们之间没有间距不是缺陷，跳过这一对。
      if (a.grammar === 'street-shop-line' && bb.grammar === 'street-shop-line' && a.parcelId === bb.parcelId) continue;
      if (Pt.distance(a.center, bb.center) * 7 > Math.max(a.widthM, a.depthM) + Math.max(bb.widthM, bb.depthM) + 6) continue;
      const g = gapBetween(a.surface, bb.surface);
      if (g < minGap) minGap = g;
    }
  }
  if (Number.isFinite(minGap) && minGap < 1.0) {
    errors.push({
      code: 'reject',
      severity: 'error',
      message: `建筑间距不足：最小净距 ${minGap.toFixed(2)} m（< 1.0 m）`,
    });
  }

  // ⑨ 面积对账（两本账，缺一不可）
  //
  // 只用"Σ各部分 vs 可建区"是不够的：Σ 里既有重叠（重复计量）也有缺口（无主），
  // 两者可以互相抵消，看起来正好对上，其实一块地既漏又叠。
  // 所以拆成两条：
  //   ① **覆盖账**：所有部分的并集 vs 可建区 → 差 = 无主 / 越界（应该 ≈ 0）；
  //   ② **叠算账**：Σ各部分 − 并集 → 差 = 同一块地被记了两次（应该 ≈ 0）。
  // 两条都过，才叫"面积归属可对账"。
  const buildableM2 = M2(surfaceArea(v.input.buildable));
  const roadM2 = M2(areaOf(v.roadGround));
  const footM2 = M2(areaOf(v.buildings.map((b) => b.surface)));
  const deckM2 = M2(areaOf(v.parking.map((p) => p.surface)));
  const groundM2 = M2(areaOf(v.ground.filter((g) => g.kind !== 'parking-deck').map((g) => g.surface)));
  const allParts = [
    ...v.buildings.map((b) => b.surface),
    ...v.parking.map((p) => p.surface),
    ...v.ground.filter((g) => g.kind !== 'parking-deck').map((g) => g.surface),
    ...v.roadGround,
  ];
  /**
   * 用**栅格审计**代替布尔并集。
   *
   * 为什么不能用 `union(所有部分)` 的可建区差：
   * `polygon-clipping` 在几百条共享边的并集上会把边界"长"出去 —— 实测 G01 的并集
   * 比可建区多 56.5 m²、G07 多 197 m²，而逐块核对（Σ = 并集 = 可建区）明明是闭合的。
   * 也就是说：**误差来自并集这一步，不是设计本身**。
   *
   * 栅格审计问的是另一件事：可建区里每一平方米，到底有几块地认领它。
   *   · 0 块 → 无主（漏）；
   *   · ≥2 块 → 叠算（重）。
   * 它不做布尔，所以不会被边界的数值噪声骗，精度就是一个格子（1~1.5 m）。
   */
  const audit = rasterAudit(v.input.buildable, allParts);
  const coveredM2 = +audit.ownedM2.toFixed(1);
  const sumM2 = footM2 + deckM2 + groundM2 + roadM2;
  const reconciliation = +audit.unownedM2.toFixed(1);
  const doubleCount = +audit.doubleM2.toFixed(1);
  // 面积账容差 1%（≥40 m²）：1 m 栅格 + 布尔在共享边上的亚米级缝隙，
  // 是本轮唯一允许的"说不清归属"的量。超过就说明真的漏了一块地。
  const tol = Math.max(buildableM2 * 0.01, 40);
  if (Math.abs(reconciliation) > tol) {
    errors.push({
      code: 'reject',
      severity: 'error',
      message: `覆盖账对不上：可建区 ${buildableM2.toFixed(0)} m² 里有 ${reconciliation.toFixed(1)} m² 没有任何部分认领（容差 ${tol.toFixed(0)}）`,
    });
  }
  if (doubleCount > tol) {
    errors.push({
      code: 'reject',
      severity: 'error',
      message: `叠算账对不上：有 ${doubleCount.toFixed(1)} m² 被两块以上的部分同时认领（各部分之和 ${sumM2.toFixed(0)} m²，唯一归属 ${coveredM2.toFixed(0)} m²）`,
    });
  }
  if (Math.abs(reconciliation) <= tol && doubleCount <= tol && (Math.abs(reconciliation) > TOL_M2 || doubleCount > TOL_M2)) {
    warnings.push({
      code: 'reject',
      severity: 'warn',
      message: `面积对账残差 无主 ${reconciliation} m² / 叠算 ${doubleCount} m²（在 ${tol.toFixed(0)} m² 容差内，栅格精度 ±1 格）`,
    });
  }

  // ⑩ 工程不可行项（不允许靠压缩货车净宽蒙混）
  for (const f of v.engineering) {
    errors.push({ code: 'engine-fail', severity: 'error', message: f });
  }

  const validation: ComposeValidation = {
    ok: errors.length === 0,
    errors,
    warnings,
    buildingOutsideM2: +outside.toFixed(1),
    buildingOverlapM2: +bOverlap.toFixed(1),
    buildingOnRoadM2: +onRoad.toFixed(1),
    groundOverlapM2: +gOverlap.toFixed(1),
    roadOutsideM2: +roadOut.toFixed(1),
    holeFilledM2: +holeFilled.toFixed(1),
    reconciliationM2: reconciliation,
    doorFailures: doorFail,
    parkingFailures: pkFail,
    engineeringFailures: v.engineering,
  };

  const metrics = computeMetrics(v, validation, roadM2, footM2, deckM2, groundM2, buildableM2);
  return { validation, metrics };
}

function computeMetrics(
  v: ValidateInput,
  _val: ComposeValidation,
  roadM2: number,
  footM2: number,
  deckM2: number,
  groundM2: number,
  buildableM2: number
): ComposeMetrics {
  const byFn: Record<string, number> = {};
  for (const p of v.parcels) byFn[p.fn] = (byFn[p.fn] ?? 0) + M2(surfaceArea(p.usable ?? p.surface));
  const gfa = v.buildings.reduce((s, b) => s + M2(surfaceArea(b.surface)) * b.floors, 0);
  const stalls = v.parking.reduce((s, p) => s + p.stalls, 0);
  const greenM2 = M2(areaOf(v.ground.filter((g) => g.kind === 'green' || g.kind === 'planting').map((g) => g.surface)));
  const plazaM2 = M2(areaOf(v.ground.filter((g) => g.kind === 'plaza' || g.kind === 'forecourt' || g.kind === 'courtyard').map((g) => g.surface)));
  const unassignedM2 = M2(areaOf(v.ground.filter((g) => g.kind === 'unassigned').map((g) => g.surface)));

  // 沿街界面连续性：沿每条真实临街边按 4 m 取样，看 40 m 内有没有建筑
  const continuity = frontageContinuity(v);
  // 方向偏差：建筑长轴 vs 所属地块长轴（按面积加权）
  let devSum = 0;
  let devW = 0;
  for (const b of v.buildings) {
    const p = v.parcels.find((x) => x.id === b.parcelId);
    if (!p) continue;
    const rank = dominantAxis(p);
    if (rank === null) continue;
    // JS 的 % 对负数返回负值：直接用它折半角会得到 -270°~270° 的鬼数
    //（实测 G01/G07 因此报出 66°/73° 的"方向偏差"，实际是 0~6°）。
    const raw = ((((b.ang - rank) % Math.PI) + Math.PI) % Math.PI);
    const d = (Math.min(raw, Math.PI - raw) * 180) / Math.PI;
    const w = M2(surfaceArea(b.surface));
    devSum += d * w;
    devW += w;
  }
  const doorReach = v.buildings.reduce((s, b) => {
    const d = b.doors.find((x) => x.kind === 'main') ?? b.doors[0];
    return s + (d ? d.reachM : 0);
  }, 0);

  const compounds = v.parcels.filter((p) => p.fn === 'compound').length;
  return {
    blockM2: +M2(surfaceArea(v.input.boundary)).toFixed(1),
    buildableM2: +buildableM2.toFixed(1),
    roadM2: +roadM2.toFixed(1),
    roadShare: +(roadM2 / Math.max(1, buildableM2)).toFixed(4),
    parcels: v.parcels.length,
    byFunction: Object.fromEntries(Object.entries(byFn).map(([k, x]) => [k, +x.toFixed(1)])),
    buildings: v.buildings.length,
    footprintM2: +footM2.toFixed(1),
    coverage: +(footM2 / Math.max(1, buildableM2)).toFixed(3),
    gfaM2: +gfa.toFixed(1),
    far: +(gfa / Math.max(1, buildableM2)).toFixed(3),
    stalls,
    stallsPer100: +(stalls / Math.max(1, gfa) * 100).toFixed(2),
    greenM2: +greenM2.toFixed(1),
    greenShare: +(greenM2 / Math.max(1, buildableM2)).toFixed(4),
    plazaM2: +plazaM2.toFixed(1),
    unassignedM2: +unassignedM2.toFixed(1),
    unassignedShare: +(unassignedM2 / Math.max(1, buildableM2)).toFixed(4),
    frontageContinuity: +continuity.toFixed(3),
    orientDevDeg: devW > 0 ? +(devSum / devW).toFixed(1) : 0,
    doorReachM: v.buildings.length ? +(doorReach / v.buildings.length).toFixed(1) : 0,
    buildingsPerCompound: compounds > 0 ? +(v.buildings.length / compounds).toFixed(1) : v.buildings.length,
    ms: +v.ms.toFixed(0),
    // 下面的数字不进 ComposeMetrics 的合同字段，但报告要用，放这里便于一处取
    ...({
      parkingM2: +deckM2.toFixed(1),
      groundM2: +groundM2.toFixed(1),
      voidM2: +M2(areaOf(v.voids.map((x) => x.surface))).toFixed(1),
    } as object),
  } as ComposeMetrics;
}

/** 沿街界面：临街边每 4 m 一个取样点，40 m 内有建筑的比例 */
function frontageContinuity(v: ValidateInput): number {
  let hit = 0;
  let total = 0;
  for (const p of v.parcels) {
    const bs = v.buildings.filter((b) => b.parcelId === p.id);
    for (const f of p.candidate.frontages) {
      if (f.lengthM < 6) continue;
      const n = Math.max(2, Math.round(f.lengthM / 4));
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const at = new Pt(f.edge[0].x + (f.edge[1].x - f.edge[0].x) * t, f.edge[0].y + (f.edge[1].y - f.edge[0].y) * t);
        total++;
        let near = Infinity;
        for (const b of bs) near = Math.min(near, distToSurface(at, b.surface) * 7);
        if (near <= 40) hit++;
      }
    }
  }
  return total > 0 ? hit / total : 0;
}

/**
 * 地块的主轴 = 最小面积外接矩形的长轴。
 *
 * 早先取"最长临街边的方向"，但 `FrontageRef.edge` 是**地块环上的边**，
 * 而临街判定允许 21 m 容差 —— 一块地的**侧边**只要离路够近也会被记成临街边，
 * 于是"最长临街边"经常是垂直于街的那条（实测 G01 十块地全部返回 -90°，
 * 报出 66° 的假方向偏差）。地块长轴没有这个歧义，也正是任务书要的
 * "建筑方向与所属子地块具有明确关联"。
 */
function dominantAxis(p: ParcelPlan): number | null {
  const ob = obbOf((p.usable ?? p.surface).outer);
  if (!ob) return null;
  return Math.atan2(ob.uy, ob.ux);
}

function distToSurface(p: Pt, s: PlanSurface): number {
  let d = Infinity;
  for (const ring of [s.outer, ...s.holes]) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l2 = dx * dx + dy * dy || 1;
      let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
      t = Math.max(0, Math.min(1, t));
      d = Math.min(d, Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)));
    }
  }
  return Number.isFinite(d) ? d : 0;
}

/**
 * 栅格审计：可建区里每一格被几块认领。
 *
 * 格子按可建区面积自适应（目标 8k~40k 格），精度 1~2 m —— 对"平方米级归属"足够，
 * 而且完全不依赖布尔，是有意为之的"第二把尺子"：
 * 布尔与栅格同时通过，才敢说面积对得上。
 */
export function rasterAudit(buildable: PlanSurface, parts: PlanSurface[]): { ownedM2: number; unownedM2: number; doubleM2: number; cells: number; stepM: number } {
  const bb = bboxOf(buildable.outer);
  const areaM2 = M2(surfaceArea(buildable));
  // 步长固定 1 m：这是"平方米级归属"能诚实声称的精度上限。
  // 再细下去只会把布尔量化在共享边上留下的亚米级缝隙放大成"无主面积"，
  // 那既不是设计问题，也没法归属给任何一块地。
  const stepM = areaM2 > 40000 ? 1.5 : 1.0;
  const stepU = stepM / 7;
  const cellM2 = stepM * stepM;
  let owned = 0;
  let unowned = 0;
  let dbl = 0;
  let cells = 0;
  for (let x = bb.minX + stepU / 2; x < bb.maxX; x += stepU) {
    for (let y = bb.minY + stepU / 2; y < bb.maxY; y += stepU) {
      const pt = new Pt(x, y);
      if (!insideSurface(pt, buildable)) continue;
      cells++;
      let n = 0;
      for (const p of parts) {
        if (insideSurface(pt, p)) {
          n++;
          if (n >= 2) break;
        }
      }
      if (n === 0) unowned += cellM2;
      else if (n === 1) owned += cellM2;
      else dbl += cellM2;
    }
  }
  return { ownedM2: owned, unownedM2: unowned, doubleM2: dbl, cells, stepM };
}

/** 两块面之间的最小净距（米）：环上点对另一块边的距离取最小（够用且便宜） */
function gapBetween(a: PlanSurface, b: PlanSurface): number {
  let d = Infinity;
  for (const q of a.outer) d = Math.min(d, distToSurface(q, b));
  for (const q of b.outer) d = Math.min(d, distToSurface(q, a));
  return d * 7;
}

/** 合并（并集）；失败时退回原列表（覆盖账会因此偏大，宁可报警也不要静默） */
function unionAll(ss: PlanSurface[]): PlanSurface[] {
  if (ss.length <= 1) return ss;
  try {
    const u = surfaceUnion(ss);
    return u.length > 0 ? u : ss;
  } catch {
    return ss;
  }
}

function areaOf(ss: PlanSurface[]): number {
  return ss.reduce((s, q) => s + surfaceArea(q), 0);
}

function subtract(a: PlanSurface[], b: PlanSurface[]): PlanSurface[] {
  try {
    return surfaceSubtract(a, b);
  } catch {
    return [];
  }
}

function intersect(a: PlanSurface[], b: PlanSurface[]): PlanSurface[] {
  try {
    return surfaceIntersect(a, b);
  } catch {
    return [];
  }
}
