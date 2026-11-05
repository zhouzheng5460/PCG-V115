// F2.4-A · 子地块 → 建筑布局
//
// 一句话：**先问这块地能干什么，再把建筑放进去**；而不是先把建筑生成出来，
// 再想办法塞进多边形里。
//
// 顺序（顺序本身就是设计意图）：
//   ① 朝向：取真实临街方向（没有临街才退回 OBB 长轴）
//   ② 交通：先把"接入必须走的那条通道"从可建区里扣掉
//   ③ 程序：按 typology 决定几栋、多大、什么姿态（见 program.ts）
//   ④ 锚点：clearance field（最宽敞处）+ typology 偏好，**不用多边形质心**
//   ⑤ 落位：矩形包络在有效区里搜索；放不下就缩，缩到 60% 还放不下就拒绝
//   ⑥ 开门：门必须朝向真实通行空间，并且连线不穿过建筑/洞
//   ⑦ 空地：扣完建筑与通道之后剩下的，逐块命名（前场/院落/装卸/停车/绿化）
//
// 最后算指标：中心偏移、方向偏差、包络填充、覆盖率、前后场比例。

import { Pt, distToSegment } from '../../../core/geom';
import {
  distToSurfaceEdge,
  insideSurface,
  pointInRing,
  surfaceArea,
  surfaceIntersect,
  surfaceSubtract,
  type PlanSurface,
} from '../core/surface';
import { obbOf } from '../subdivision/geom';
import type { SubdivisionCandidate } from '../subdivision/types';
import type { SiteTypology } from '../core/types';
import {
  axisDeltaDeg,
  clearanceField,
  foldAxis,
  inside,
  outsideArea,
  placeRect,
  projectOnSegment,
  rectSurface,
  toM,
  U,
  vertexCentroid,
} from './geom';
import { compoundProgram, programFor, type Program, type SlotSpec } from './program';
import type {
  BuildingDoor,
  BuildingKind,
  LayoutMetrics,
  LayoutNote,
  LayoutParams,
  ParcelLayout,
  PlacedBuilding,
  SpaceKind,
  SpacePatch,
} from './types';

const M2 = (u2: number) => u2 * 49;

/** 默认参数（米）。尺度来自既有 typology 常量与 subdivide.ts 的口径 */
export function defaultLayoutParams(over: Partial<LayoutParams> = {}): LayoutParams {
  return {
    shopDepthM: 22,
    barDepthM: 15,
    hallDepthM: 55,
    courtMinWM: 18,
    courtMinDM: 16,
    frontYardM: 5,
    gapM: 6,
    corridorM: 6,
    minBarWidthM: 10,
    minEnvelopeFill: 0.6,
    maxCoverage: 0.65,
    gridM: 2,
    ...over,
  };
}

export interface LayoutOpts {
  /** 地块类型（candidate 上没有这个字段，由调用方从 SiteContext 带下来） */
  typology: SiteTypology;
  /** 对照基线：只在多边形质心放一栋、不扣走廊、不做偏好 —— 用来证明"改进不是错觉" */
  baseline?: boolean;
}

/**
 * 一块地 → 一套布局。
 *
 * 注意：这里**只读**候选（surface / usable / frontages / access / role），
 * 不修改任何分割数据 —— 这是"不改 F2.1 合同"的落点。
 */
export function layoutParcel(cand: SubdivisionCandidate, params: LayoutParams, opts: LayoutOpts): ParcelLayout {
  const notes: LayoutNote[] = [];
  const reasons: string[] = [];
  const usable = cand.usable;

  /**
   * 拒绝时也要把地交代清楚。
   *
   * 早先拒绝地块返回 `spaces: []`，于是"建筑 + 空地 vs 可建区"永远差一整块地
   * （实测 I01 差 2788.8 m²，正好是两块被拒地块的面积之和）。
   * 地被拒绝 ≠ 地不存在：它必须作为一块"未布置"的空间进账，并写明原因。
   */
  const fail = (why: string): ParcelLayout => {
    const area = M2(surfaceArea(usable));
    return {
      parcelId: cand.id,
      role: cand.role,
      usable,
      effective: usable,
      core: usable.outer[0] ?? new Pt(0, 0),
      buildings: [],
      spaces:
        area > 1
          ? [{ kind: 'green', surface: usable, areaM2: area, purpose: `未布置建筑（${why}）` }]
          : [],
      metrics: emptyMetrics(usable),
      notes: [...notes, { code: 'reject', severity: 'error', message: why }],
      ok: false,
      reasons: [...reasons, why],
    };
  };

  if (usable.outer.length < 3 || M2(surfaceArea(usable)) < 60) return fail(`可建区无效或过小（${M2(surfaceArea(usable)).toFixed(0)} m²）`);

  // ① 朝向
  const obb = obbOf(usable.outer);
  const fr = cand.frontages[0];
  const frontAng = fr
    ? foldAxis(Math.atan2(fr.edge[1].y - fr.edge[0].y, fr.edge[1].x - fr.edge[0].x))
    : foldAxis(obb ? Math.atan2(obb.uy, obb.ux) : 0);
  const field0 = clearanceField(usable, params.gridM);
  const core0 = field0.core;
  if (!core0) return fail('可建区里找不到任何内部采样点（几何退化）');

  /** 朝内方向：从临街边中点指向场地核心 */
  let inward: Pt;
  if (fr) {
    const mid = new Pt((fr.edge[0].x + fr.edge[1].x) / 2, (fr.edge[0].y + fr.edge[1].y) / 2);
    const dx = core0.at.x - mid.x;
    const dy = core0.at.y - mid.y;
    const L = Math.hypot(dx, dy) || 1;
    inward = new Pt(dx / L, dy / L);
  } else {
    const dir = cand.access[0]?.normal;
    inward = dir ? new Pt(-dir.x, -dir.y) : new Pt(-Math.sin(frontAng), Math.cos(frontAng));
  }

  // ② 交通走廊（先扣）
  const lanes: SpacePatch[] = [];
  let effective = usable;
  if (!opts.baseline) {
    const lanePatches = buildLanes(cand, usable, params, notes);
    for (const lp of lanePatches) {
      try {
        const before = surfaceArea(effective);
        const rest = surfaceSubtract([effective], [lp]).filter((q) => surfaceArea(q) > 1e-6);
        rest.sort((a, b) => surfaceArea(b) - surfaceArea(a));
        // 只减了不到 5% 就当没减：布尔静默失败时它会把原值返回，
        // 直接采用会让建筑压在通道上（面积对账会多出通道那几十平方米）。
        if (rest.length > 0 && surfaceArea(rest[0]) < before * 0.95) effective = rest[0];
        lanes.push({ kind: 'lane', surface: lp, areaM2: M2(surfaceArea(lp)), purpose: '地块内部通道（承接接入点）' });
      } catch {
        notes.push({ code: 'area-mismatch', severity: 'warn', message: '扣除通道时布尔失败，通道未从有效区扣除' });
      }
    }
    if (lanes.length > 0) {
      notes.push({
        code: 'corridor',
        severity: 'info',
        message: `预留内部通道 ${lanes.length} 条，合计 ${lanes.reduce((s, l) => s + l.areaM2, 0).toFixed(0)} m²`,
      });
    }
  }

  // ③ 程序
  const field = clearanceField(effective, params.gridM);
  const effObb = obbOf(effective.outer);
  const prog =
    cand.role === 'compound'
      ? compoundProgram(opts.typology, effObb ? toM(effObb.w) : 0, effObb ? toM(effObb.d) : 0, params)
      : programFor(
          {
            typology: opts.typology,
            widthM: effObb ? toM(effObb.w) : 0,
            depthM: effObb ? toM(effObb.d) : 0,
            hasFrontage: !!fr,
          },
          params
        );

  // ④⑤ 落位
  const buildings: PlacedBuilding[] = [];
  const court = prog.courtyard ? courtRectOf(core0.at, frontAng, params) : null;
  /** 已摆好的建筑：后续 slot 必须避开它们，否则组团里几栋会叠在一起 */
  const placedSurfaces: PlanSurface[] = [];
  for (const slot of [...prog.slots].sort((a, b) => a.priority - b.priority)) {
    if (opts.baseline) {
      // 基线 = "每块地放一栋，放在多边形质心"。多放只会互相叠，所以只放第一栋
      if (buildings.length > 0) break;
      const w = U(slot.widthM);
      const d = U(slot.depthM);
      const c = vertexCentroid(effective.outer);
      const rect = rectSurface(c, frontAng, w, d);
      if (outsideArea(rect, effective) > 0.5) continue;
      buildings.push(mkBuilding(cand, slot, rect, c, frontAng, 1));
      continue;
    }
    /**
     * 朝向不是只有一个答案。
     *
     * 临街方向决定"建筑正脸朝哪"，但**地块长轴决定它能不能放进去**：
     * 一条 17.6 m 宽、74 m 长的工业地块，按临街方向摆 36×16 m 的厂房横跨窄条，
     * 怎么缩都放不进（实测 I01 一栋都排不上）；转 90° 让它顺着长轴就成立。
     * 所以这里枚举 [临街方向, OBB 长轴, 临街+90°]，按"放得更大 + 更贴偏好中心"择优，
     * 并把最终用的角度记进 building.ang —— 方向偏差指标因此是**真实代价**，不是装饰。
     */
    // 朝向代价权重（每偏离 1° 扣多少分）。商业必须正脸朝街，工业可以让位给长轴：
    // 这不是"阈值"，是三类建筑不同的设计判断。
    const orientW =
      opts.typology === 'retail' ? 12 : opts.typology === 'industrial' || opts.typology === 'data_center' ? 3 : opts.typology === 'multi_family' ? 6 : 8;
    const obbAng = obb ? foldAxis(Math.atan2(obb.uy, obb.ux)) : frontAng;
    /**
     * 组团只有**一个**主轴。
     *
     * 单个 slot 各自挑角度会出现"一排横楼里插一栋竖楼"（实测 G07）：那栋楼确实放得更大，
     * 但它破坏了组团的整体性 —— 任务书要求"先确定组团主轴、公共空间和内部连接，再安排各建筑位置"。
     * 所以 Compound 先定主轴（临街方向与地块长轴二选一，长宽比极端时取长轴），全组共用。
     */
    const groupAng =
      cand.role === 'compound' && obb && obb.w / Math.max(1e-9, obb.d) > 2.2 ? obbAng : frontAng;
    const angs: number[] = cand.role === 'compound' ? [groupAng] : [frontAng];
    if (cand.role !== 'compound') {
      for (const a of [obbAng, frontAng + Math.PI / 2]) {
        const f = foldAxis(a);
        if (!angs.some((x) => axisDeltaDeg(x, f) < 8)) angs.push(f);
      }
    }
    let placed: ReturnType<typeof placeRect> = null;
    let placedAng = frontAng;
    let bestScore = -Infinity;
    for (const a of angs) {
      const preferAt = preferredCenter(slot, core0.at, a, inward, court, params);
      const r = placeRect(effective, field, {
        ang: a,
        w: U(slot.widthM),
        d: U(slot.depthM),
        prefer: (p, clear) => -Pt.distance(p, preferAt) + clear * 0.35,
        minScale: params.minEnvelopeFill,
        avoid: placedSurfaces,
      });
      if (!r) continue;
      // 缩放优先（放得下多大），其次朝向代价（封顶 900，保证"正脸朝街但小一点"仍能赢），最后贴偏好中心
      const dev = axisDeltaDeg(a, frontAng);
      const orientPenalty = Math.min(900, orientW * dev);
      const score = r.scale * 1000 - orientPenalty - Pt.distance(r.center, preferAt) * 7;
      if (score > bestScore) {
        bestScore = score;
        placed = r;
        placedAng = a;
      }
    }
    if (!placed) {
      // 兜底：按地块真实可容尺寸改写包络（任务要求"根据面宽/进深调整建筑长宽比"），
      // 仍然放不下才拒绝 —— 拒绝时给的是具体尺寸，不是"放不下"四个字。
      // 逐步试更小的目标：60×27 放不下就试 48×22、39×17.5…（每次都记下实际尺寸）
      for (const k of [0.8, 0.65, 0.5, 0.4]) {
        if (placed) break;
        const w2 = slot.widthM * k;
        const d2 = slot.depthM * k;
        if (w2 < params.minBarWidthM || d2 < 8) break;
        for (const a of angs) {
          const r2 = placeRect(effective, field, {
            ang: a,
            w: U(w2),
            d: U(d2),
            prefer: (p, clear) => -Pt.distance(p, core0.at) + clear * 0.35,
            minScale: 0.96,
            avoid: placedSurfaces,
          });
          if (!r2) continue;
          placed = r2;
          placedAng = a;
          notes.push({
            code: 'shrink',
            severity: 'info',
            message: `${slot.why}：按地块可容尺寸改为 ${(w2 * r2.scale).toFixed(0)}×${(d2 * r2.scale).toFixed(0)} m（原目标 ${slot.widthM.toFixed(
              0
            )}×${slot.depthM.toFixed(0)} m）`,
            at: r2.center,
          });
          break;
        }
      }
    }
    if (!placed) {
      notes.push({
        code: 'no-slot-fit',
        severity: 'warn',
        message: `${slot.why}：${slot.widthM.toFixed(0)}×${slot.depthM.toFixed(0)} m 放不下（已缩到 ${(params.minEnvelopeFill * 100).toFixed(0)}%）`,
        at: core0.at,
      });
      continue;
    }
    if (placed.scale < 0.999) {
      notes.push({
        code: 'shrink',
        severity: 'info',
        message: `${slot.why}：包络缩到 ${(placed.scale * 100).toFixed(0)}%（${(slot.widthM * placed.scale).toFixed(0)}×${(
          slot.depthM * placed.scale
        ).toFixed(0)} m）才放进去`,
        at: placed.center,
      });
    }
    buildings.push(mkBuilding(cand, slot, placed.surface, placed.center, placedAng, placed.scale));
    placedSurfaces.push(placed.surface);
  }

  if (buildings.length === 0) return fail('程序里的建筑一个都放不下：可建区形状/尺寸不足以容纳该类型的建筑包络');

  // ⑥ 开门
  for (const b of buildings) {
    b.door = makeDoor(b, cand, usable, lanes, court, prog);
    if (!b.door) {
      notes.push({ code: 'door-fail', severity: 'warn', message: `${b.kind} 找不到能接入合法通行空间的门位`, at: b.center });
    }
  }

  // ⑦ 空地
  // 通道本身就是"被占用的地面"，必须和其它空地一起进对账，否则面积永远差一个通道
  const spaces = [...lanes, ...classifySpaces(usable, buildings, lanes, prog, court, fr, params, notes)];
  const residualM2 = spaces.reduce((s, x) => s + x.areaM2, 0) + buildings.reduce((s, b) => s + M2(surfaceArea(b.surface)), 0);
  const usableM2 = M2(surfaceArea(usable));
  if (Math.abs(residualM2 - usableM2) > Math.max(3, usableM2 * 0.02)) {
    notes.push({
      code: 'area-mismatch',
      severity: 'warn',
      message: `面积对账偏差 ${(residualM2 - usableM2).toFixed(1)} m²（建筑+通道+空地 ${residualM2.toFixed(0)} vs 可建区 ${usableM2.toFixed(0)}）`,
    });
  }

  // ⑧ 指标
  const metrics = computeMetrics(cand, usable, effective, buildings, spaces, core0.at, frontAng, fr, params);

  // ⑨ 失败识别：不是"绿地多了"就报错，而是"绿地多了且建筑明显不足"
  if (metrics.greenShare > 0.55 && metrics.coverage < 0.22) {
    notes.push({
      code: 'empty-large',
      severity: 'error',
      message: `绿地占 ${(metrics.greenShare * 100).toFixed(0)}% 而建筑占地只有 ${(metrics.coverage * 100).toFixed(
        0
      )}%：实质是建筑没排上，不允许用绿地掩盖`,
    });
    reasons.push('建筑覆盖率过低且绿地占比过高');
  }
  if (metrics.coverage > params.maxCoverage) {
    notes.push({
      code: 'cover-low',
      severity: 'warn',
      message: `覆盖率 ${(metrics.coverage * 100).toFixed(0)}% 超过上限 ${(params.maxCoverage * 100).toFixed(0)}%：院子被挤没了`,
    });
  }

  for (const r of prog.rationale) notes.push({ code: 'compound', severity: 'info', message: r });

  return {
    parcelId: cand.id,
    role: cand.role,
    usable,
    effective,
    core: core0.at,
    buildings,
    spaces,
    metrics,
    notes,
    ok: reasons.length === 0 && buildings.length > 0,
    reasons,
  };
}

// ---------------------------------------------------------------- 内部

function emptyMetrics(usable: PlanSurface): LayoutMetrics {
  return {
    usableM2: M2(surfaceArea(usable)),
    effectiveM2: M2(surfaceArea(usable)),
    buildingM2: 0,
    coverage: 0,
    centerOffsetM: 0,
    orientationDevDeg: 0,
    envelopeFill: 0,
    frontBackRatio: null,
    greenM2: 0,
    greenShare: 0,
    largestEmptyShare: 0,
  };
}

/**
 * 内部通道：从接入点贴着**一侧边界**向里走。
 *
 * 为什么不走中线：6 m 宽的通道从中间穿过一块 35 m 宽的地，会把它切成两条 14 m 的碎条，
 * 建筑就再也排不下了。真实做法也是把侧巷贴边（省地、少穿院子）。
 * 只有贴边放不下时才退回中线，并记一条 note。
 */
function buildLanes(cand: SubdivisionCandidate, usable: PlanSurface, p: LayoutParams, notes: LayoutNote[]): PlanSurface[] {
  const out: PlanSurface[] = [];
  /**
   * 一条地通常只要一条内部通道。
   *
   * 早先对前两个接入点各铺一条，两条从相邻的临街点出发、大面积重叠：
   * 减法只扣一次重叠区，但两条都按全尺寸计面积 —— 每块地因此多算 20~40 m²，
   * 5 块地累计 338 m²，"面积可对账"直接失败（实测 C01）。
   * 现在：普通地块最多 1 条，组团最多 2 条，且后一条必须减去前一条。
   */
  const maxLanes = cand.role === 'compound' ? 2 : 1;
  const built: PlanSurface[] = [];
  const obb = obbOf(usable.outer);
  if (!obb) return out;
  const depthM = toM(obb.d);
  const lenU = U(Math.min(depthM * 0.8, Math.max(p.frontYardM + p.barDepthM + 8, 24)));
  const wU = U(p.corridorM);
  if (lenU < 1e-3) return out;

  for (const a of cand.access) {
    if (out.length >= maxLanes) break;
    const dirX = -a.normal.x;
    const dirY = -a.normal.y;
    const ang = Math.atan2(dirY, dirX);
    // 侧向（沿街方向）
    const latX = -dirY;
    const latY = dirX;
    let lo = Infinity;
    let hi = -Infinity;
    for (const q of usable.outer) {
      const t = q.x * latX + q.y * latY;
      if (t < lo) lo = t;
      if (t > hi) hi = t;
    }
    const tAt = a.at.x * latX + a.at.y * latY;
    const push = tAt < (lo + hi) / 2 ? lo + wU / 2 + 0.02 - tAt : hi - wU / 2 - 0.02 - tAt;
    const center = new Pt(a.at.x + dirX * (lenU / 2) + latX * push, a.at.y + dirY * (lenU / 2) + latY * push);
    const rect = rectSurface(center, ang, lenU, wU);
    let clipped: PlanSurface[] = [];
    try {
      clipped = surfaceIntersect([rect], [usable]).filter((q) => surfaceArea(q) > 0.05);
    } catch {
      continue;
    }
    if (clipped.length === 0) continue;
    clipped.sort((x, y) => surfaceArea(y) - surfaceArea(x));
    let lane = clipped[0];
    if (built.length > 0) {
      try {
        const rest = surfaceSubtract([lane], built).filter((q) => surfaceArea(q) > 0.02);
        rest.sort((x, y) => surfaceArea(y) - surfaceArea(x));
        if (rest.length === 0) continue;
        lane = rest[0];
      } catch {
        continue;
      }
      // 剩下的太少说明它和已有通道基本重合，不值得再算一条
      if (surfaceArea(lane) < surfaceArea(clipped[0]) * 0.35) continue;
    }
    built.push(lane);
    out.push(lane);
    notes.push({
      code: 'lane-reused',
      severity: 'info',
      message: `接入点 (${a.at.x.toFixed(1)},${a.at.y.toFixed(1)}) → 内部通道 ${(lenU * 7).toFixed(0)}×${p.corridorM} m（${
        a.via === 'alley' ? '巷接，必须铺' : '路上开口'
      }）`,
      at: a.at,
    });
  }
  return out;
}

function courtRectOf(center: Pt, ang: number, p: LayoutParams) {
  return {
    center,
    ang,
    w: U(Math.max(p.courtMinWM, 12)),
    d: U(Math.max(p.courtMinDM, 12)),
  };
}

/** 各姿态的偏好中心：这是"不机械居中"的具体落点 */
function preferredCenter(
  slot: SlotSpec,
  core: Pt,
  ang: number,
  inward: Pt,
  court: { center: Pt; ang: number; w: number; d: number } | null,
  p: LayoutParams
): Pt {
  const dU = U(slot.depthM);
  const wU = U(slot.widthM);
  const ux = Math.cos(ang);
  const uy = Math.sin(ang);
  if (slot.offsetU !== undefined || slot.offsetV !== undefined) {
    const ou = U(slot.offsetU ?? 0);
    const ov = U(slot.offsetV ?? 0);
    return new Pt(core.x + ux * ou + inward.x * ov, core.y + uy * ou + inward.y * ov);
  }
  switch (slot.posture) {
    case 'street':
      // 离核心朝街一侧：核心沿 -inward 走 (核心到边界的一半 + 半个进深)
      return new Pt(core.x - inward.x * (U(p.frontYardM) + dU / 2), core.y - inward.y * (U(p.frontYardM) + dU / 2));
    case 'rear':
      return new Pt(core.x + inward.x * (U(p.frontYardM) + dU), core.y + inward.y * (U(p.frontYardM) + dU));
    case 'court-s':
      if (court) return new Pt(court.center.x + inward.x * (court.d / 2 + dU / 2), court.center.y + inward.y * (court.d / 2 + dU / 2));
      return core;
    case 'court-n':
      if (court) return new Pt(court.center.x - inward.x * (court.d / 2 + dU / 2), court.center.y - inward.y * (court.d / 2 + dU / 2));
      return core;
    case 'court-e':
      if (court) {
        const lx = -inward.y;
        const ly = inward.x;
        return new Pt(court.center.x + lx * (court.w / 2 + wU / 2), court.center.y + ly * (court.w / 2 + wU / 2));
      }
      return core;
    case 'court-w':
      if (court) {
        const lx = -inward.y;
        const ly = inward.x;
        return new Pt(court.center.x - lx * (court.w / 2 + wU / 2), court.center.y - ly * (court.w / 2 + wU / 2));
      }
      return core;
    default:
      return core;
  }
}

function mkBuilding(
  cand: SubdivisionCandidate,
  slot: SlotSpec,
  surface: PlanSurface,
  center: Pt,
  ang: number,
  scale: number
): PlacedBuilding {
  return {
    id: `${cand.id}/b${slot.priority}`,
    surface,
    center,
    ang,
    widthM: slot.widthM * scale,
    depthM: slot.depthM * scale,
    kind: slot.kind as BuildingKind,
    door: null,
    fill: scale,
    note: slot.why,
  };
}

/**
 * 门：四边各试一次，选"离目标通行空间最近且连线不穿建筑/洞"的那一边。
 *
 * 门不是装饰：`reach` 会被验证层拿去判"门真的接得上"，
 * 接不上就不许标 ok（任务书：建筑门必须接入合法通行空间）。
 */
function makeDoor(
  b: PlacedBuilding,
  cand: SubdivisionCandidate,
  usable: PlanSurface,
  lanes: SpacePatch[],
  court: { center: Pt; ang: number; w: number; d: number } | null,
  prog: Program
): BuildingDoor | null {
  const targets: { at: Pt; target: 'street' | 'lane' | 'courtyard' | 'loading' }[] = [];
  const fr = cand.frontages[0];
  if (fr) {
    // 沿临街面取三点：只用中点会让"门在街的另一半"这种情况永远失败
    for (const t of [0.25, 0.5, 0.75]) {
      targets.push({
        at: new Pt(fr.edge[0].x + (fr.edge[1].x - fr.edge[0].x) * t, fr.edge[0].y + (fr.edge[1].y - fr.edge[0].y) * t),
        target: 'street',
      });
    }
  }
  for (const a of cand.access) targets.push({ at: a.at, target: 'street' });
  for (const l of lanes) {
    targets.push({ at: vertexCentroid(l.surface.outer), target: 'lane' });
    // 通道两端的端点也当目标：门靠近通道口时不必走到通道中心
    const ring = l.surface.outer;
    targets.push({ at: ring[0], target: 'lane' });
    targets.push({ at: ring[Math.floor(ring.length / 2) % ring.length], target: 'lane' });
  }
  if (court && prog.courtyard) targets.push({ at: court.center, target: 'courtyard' });
  if (targets.length === 0) return null;

  const ring = b.surface.outer;
  let best: BuildingDoor | null = null;
  let bestVisible = false;
  // 门位不是"投影点"一个答案：沿每面按位置枚举，取最短可达的那个
  const POS = [0.5, 0.38, 0.62, 0.28, 0.72, 0.2, 0.8];
  for (const t of targets) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const c = ring[(i + 1) % ring.length];
      for (const tt of POS) {
        const at = new Pt(a.x + (c.x - a.x) * tt, a.y + (c.y - a.y) * tt);
        const pr = { at, t: tt, dist: Pt.distance(t.at, at) };
      const dx = pr.at.x - b.center.x;
      const dy = pr.at.y - b.center.y;
      const L = Math.hypot(dx, dy) || 1;
      const normal = new Pt(dx / L, dy / L);
        const reachM = pr.dist * 7;
        const visible = lineOfSight(pr.at, t.at, usable);
        // 可视目标优先（reach 记真实距离）；都不可视时保留最近的一面，并把距离如实带出去
        const cand2: BuildingDoor = { at: pr.at, normal, target: t.target, reachM };
        if (!best) best = cand2;
        else if (visible && (!bestVisible || reachM < best.reachM)) best = cand2;
        if (visible) {
          bestVisible = true;
          best = cand2;
        }
      }
    }
  }
  return best;
}

/** 两点之间的连线是否一直在合法通行空间内（含洞判定） */
function lineOfSight(a: Pt, b: Pt, usable: PlanSurface): boolean {
  const n = 14;
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const p = new Pt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
    if (!inside(usable, p)) return false;
  }
  return true;
}

/**
 * 空地分类：扣完建筑与通道之后，逐块命名。
 *
 * 顺序即优先级：院落 > 装卸 > 前场 > 停车 > 绿化。
 * 绿化永远排在最后 —— 它是"剩下的"，不是"用来填的"。
 */
function classifySpaces(
  usable: PlanSurface,
  buildings: PlacedBuilding[],
  lanes: SpacePatch[],
  prog: Program,
  court: { center: Pt; ang: number; w: number; d: number } | null,
  fr: SubdivisionCandidate['frontages'][number] | undefined,
  p: LayoutParams,
  notes: LayoutNote[]
): SpacePatch[] {
  const cut: PlanSurface[] = [...buildings.map((b) => b.surface), ...lanes.map((l) => l.surface)];
  let rest: PlanSurface[] = [];
  try {
    rest = surfaceSubtract([usable], cut).filter((q) => surfaceArea(q) > 0.06);
  } catch {
    return [];
  }
  const courtSurf = court ? rectSurface(court.center, court.ang, court.w, court.d) : null;
  const out: SpacePatch[] = [];

  for (const piece of rest) {
    const c = vertexCentroid(piece.outer);
    const areaM2 = M2(surfaceArea(piece));
    const inCourt = courtSurf ? insideSurface(c, courtSurf) : false;
    const dFront = fr ? projectOnSegment(c, fr.edge[0], fr.edge[1]).dist : Infinity;
    const dBuild = buildings.length > 0 ? Math.min(...buildings.map((b) => distToSurfaceEdge(c, b.surface))) : Infinity;
    const touchesLane = lanes.some((l) => touch(piece, l.surface));

    let kind: SpaceKind = 'green';
    let purpose = '';
    if (inCourt) {
      kind = 'courtyard';
      purpose = '围合院落（住户共享，四周由 bar 围合）';
    } else if (prog.loading && dBuild < U(22) && dFront > dBuild * 1.4) {
      kind = 'loading';
      purpose = '装卸/堆场（贴厂房背面，不跨建筑进出）';
    } else if (dFront < dBuild) {
      kind = 'front_yard';
      purpose = '入口前场（从街道到建筑门的过渡）';
    } else if (touchesLane && areaM2 >= 260 && prog.loading) {
      kind = 'parking';
      purpose = `货运/员工停车（约 ${Math.floor(areaM2 / 30)} 位，贴内部通道）`;
    } else {
      kind = 'green';
      const dims = bboxDims(piece);
      purpose =
        Math.min(dims.w, dims.d) * 7 < 8
          ? '侧向绿化隔离带（沿地块边界的窄条，不可上人）'
          : areaM2 > 600
            ? '内部开敞绿地（可作活动场地/雨水调蓄）'
            : '边角绿地（补齐形状，兼作缓冲）';
    }
    out.push({ kind, surface: piece, areaM2, purpose });
  }

  // 院落即使被建筑切碎也要认领：把落在院落矩形里的碎片并成一条 note
  if (prog.courtyard && court) {
    const cArea = out.filter((s) => s.kind === 'courtyard').reduce((s, x) => s + x.areaM2, 0);
    notes.push({
      code: 'courtyard',
      severity: 'info',
      message: cArea > 0 ? `院落 ${cArea.toFixed(0)} m²（${U(p.courtMinWM) * 7}×${p.courtMinDM} m 起）` : '院落未形成（bars 围合失败）',
      at: court.center,
    });
  }
  const greenArea = out.filter((s) => s.kind === 'green').reduce((s, x) => s + x.areaM2, 0);
  if (greenArea > 0) {
    notes.push({ code: 'green', severity: 'info', message: `绿地 ${greenArea.toFixed(0)} m²，逐块已注明用途（见 spaces）` });
  }
  return out;
}

function bboxDims(s: PlanSurface): { w: number; d: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of s.outer) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { w: x1 - x0, d: y1 - y0 };
}

function touch(a: PlanSurface, b: PlanSurface, tol = 0.08): boolean {
  for (const p of a.outer) {
    for (let i = 0; i < b.outer.length; i++) {
      if (distToSegment(p, b.outer[i], b.outer[(i + 1) % b.outer.length]) <= tol) return true;
    }
  }
  return false;
}

function computeMetrics(
  cand: SubdivisionCandidate,
  usable: PlanSurface,
  effective: PlanSurface,
  buildings: PlacedBuilding[],
  spaces: SpacePatch[],
  core: Pt,
  frontAng: number,
  fr: SubdivisionCandidate['frontages'][number] | undefined,
  p: LayoutParams
): LayoutMetrics {
  const usableM2 = M2(surfaceArea(usable));
  const effectiveM2 = M2(surfaceArea(effective));
  const buildingM2 = buildings.reduce((s, b) => s + M2(surfaceArea(b.surface)), 0);
  // 单栋 = 建筑中心到核心；多栋 = **组团形心**到核心
  // （组团里每栋必然分散，拿单栋去比核心会得出"越分散越差"的假结论）
  const groupCenter =
    buildings.length === 1
      ? buildings[0].center
      : new Pt(buildings.reduce((s, b) => s + b.center.x, 0) / buildings.length, buildings.reduce((s, b) => s + b.center.y, 0) / buildings.length);
  const centerOffsetM = buildings.length ? Pt.distance(groupCenter, core) * 7 : 0;
  const orientationDevDeg = buildings.length
    ? buildings.reduce((s, b) => s + axisDeltaDeg(b.ang, frontAng), 0) / buildings.length
    : 0;
  // 填充率 = 实际尺寸 / 目标尺寸（placeRect 的缩放上限），比“面积/自己”有意义
  const envelopeFill = buildings.length ? buildings.reduce((s, b) => s + b.fill, 0) / buildings.length : 0;

  // 前后场比例：只对“最靠街的那栋”算（组团里每栋的前后场含义不同）
  let frontBackRatio: number | null = null;
  if (fr && buildings.length > 0) {
    const b = [...buildings].sort(
      (x, y) => projectOnSegment(x.center, fr.edge[0], fr.edge[1]).dist - projectOnSegment(y.center, fr.edge[0], fr.edge[1]).dist
    )[0];
    const dC = projectOnSegment(b.center, fr.edge[0], fr.edge[1]).dist * 7;
    const front = Math.max(0.5, dC - b.depthM / 2);
    const back = Math.max(0.5, distToSurfaceEdge(b.center, usable) * 7 - b.depthM / 2);
    frontBackRatio = front / back;
  }

  const greenM2 = spaces.filter((s) => s.kind === 'green').reduce((s, x) => s + x.areaM2, 0);
  const largest = spaces.length ? Math.max(...spaces.map((s) => s.areaM2)) : 0;
  void p;

  return {
    usableM2,
    effectiveM2,
    buildingM2,
    coverage: effectiveM2 > 0 ? buildingM2 / effectiveM2 : 0,
    centerOffsetM,
    orientationDevDeg,
    envelopeFill,
    frontBackRatio,
    greenM2,
    greenShare: usableM2 > 0 ? greenM2 / usableM2 : 0,
    largestEmptyShare: usableM2 > 0 ? largest / usableM2 : 0,
  };
}

/** 供报告用：把一块地的布局摘要成一行文字 */
export function summarize(l: ParcelLayout): string {
  const m = l.metrics;
  return (
    `${l.parcelId} ${l.role} ${l.buildings.length} 栋 ` +
    `覆盖 ${(m.coverage * 100).toFixed(0)}% 中心偏移 ${m.centerOffsetM.toFixed(1)} m ` +
    `方向偏差 ${m.orientationDevDeg.toFixed(0)}° 包络 ${(m.envelopeFill * 100).toFixed(0)}% ` +
    `绿地 ${(m.greenShare * 100).toFixed(0)}%`
  );
}

/** 门到通行空间的平均可达距离（米）：门是否"真的接得上"的量化 */
export function doorReach(l: ParcelLayout): { n: number; meanM: number; worstM: number } {
  const ds = l.buildings.map((b) => b.door?.reachM ?? NaN).filter((x) => Number.isFinite(x));
  if (ds.length === 0) return { n: 0, meanM: 0, worstM: 0 };
  return {
    n: ds.length,
    meanM: ds.reduce((s, x) => s + x, 0) / ds.length,
    worstM: Math.max(...ds),
  };
}

/** 供外部检查"建筑是否落在洞里"（洞里不该有建筑） */
export function buildingInHole(l: ParcelLayout, holes: Pt[][]): boolean {
  for (const b of l.buildings) {
    for (const h of holes) {
      if (pointInRing(b.center, h)) return true;
    }
  }
  return false;
}
