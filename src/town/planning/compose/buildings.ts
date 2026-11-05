// F2.4-B3/B4 · 按新地块重新生成建筑群
//
// 与 F2.4-A 的区别（任务书第二节）：
//   · **不继承**旧建筑的 footprint / 坐标 / 朝向 / 栋数；
//   · 旧建筑完全不在输入里 —— 这一层根本不知道旧建筑长什么样；
//   · 但复用 F2.4-A 的几何原语（clearance 场、placeRect、精确布尔复核）。
//
// 形态语法按用地类型分开写，不是"一套模板换参数"：
//   住宅  院落围合 / 平行板楼（日照间距 24 m）/ 塔楼
//   商业  沿街连续店面（跟着街边走，不是摆一排矩形）/ 大盒 + 前场
//   工业  办公前场 + 厂房主体 + 装卸坪（净宽按货车核算）
//
// 每栋建筑的**门开在哪**与**摆在哪种形态里**是同一步决定的，
// 所以门的可达性在构造时就成立，验证只是复核。

import { Pt } from '../../../core/geom';
import { insideSurface, surfaceArea, surfaceIntersect, type PlanSurface } from '../core/surface';
import type { SiteTypology } from '../core/types';
import type { SubdivisionParams } from '../subdivision/types';
import { obbOf } from '../subdivision/geom';
import { makeRng } from '../subdivision/geom';
import { clearanceField, placeRect, rectSurface, U, toM, vertexCentroid, type ClearField } from '../adapt/geom';
import type { ComposeInput, ComposeNote, InternalRoad, ParcelPlan, SiteBuilding, SiteDoor } from './types';

const M2 = (u2: number) => u2 * 49;

/** 建筑层高（米）：住宅 3.0 / 商业 4.5（首层）/ 工业 9~12 单层厂房 */
const FLOOR_H = { residential: 3.0, retail: 3.9, office: 3.6, hall: 9.5, mall: 5.2 } as const;

interface ParcelCtx {
  p: ParcelPlan;
  area: PlanSurface;
  field: ClearField;
  core: Pt;
  /** 长轴（弧度） */
  ang: number;
  /** 临街方向（= 沿街边方向）；无临街时等于长轴 */
  streetAng: number;
  /** 从临街边指向地块内部的单位向量 */
  inward: Pt;
  /** 临街边（可能是 null） */
  frontEdge: [Pt, Pt] | null;
  /** 全部临街边（含内部道路），门的可达性按它算 */
  frontages: ParcelPlan['candidate']['frontages'];
  /** 内部道路：门的"可达"要算到它们，否则后排建筑的门离街 60 m 会被误判不可达 */
  roads: InternalRoad[];
  placed: PlanSurface[];
  /** 全场已摆的建筑（含其它地块）：跨地块也不许贴在一起 */
  global: { center: Pt; ang: number; w: number; d: number }[];
  out: SiteBuilding[];
  notes: ComposeNote[];
  failures: string[];
  rng: () => number;
}

export interface BuildingResult {
  buildings: SiteBuilding[];
  notes: ComposeNote[];
  failures: string[];
}

/**
 * 生成一个街区的全部建筑。
 *
 * 顺序：按地块面积从大到小（大地块定调，小地块填空），保证组团关系是
 * "先有大院、再有小楼"，而不是反过来。
 */
export function generateBuildings(
  parcels: ParcelPlan[],
  input: ComposeInput,
  params: SubdivisionParams,
  roads: InternalRoad[] = []
): BuildingResult {
  const buildings: SiteBuilding[] = [];
  const notes: ComposeNote[] = [];
  const failures: string[] = [];
  /** 全场建筑清单（用于跨地块的退距约束） */
  const global: { center: Pt; ang: number; w: number; d: number }[] = [];
  const order = parcels
    .filter((p) => p.fn === 'building' || p.fn === 'compound')
    .sort((a, b) => M2(surfaceArea(b.usable)) - M2(surfaceArea(a.usable)) || a.id.localeCompare(b.id));

  for (const p of order) {
    const ctx = makeCtx(p, input, params, roads, global);
    if (!ctx) {
      notes.push({ code: 'reject', severity: 'warn', message: `${p.id} 可建域为空（地块被道路/让线吃光）` });
      continue;
    }
    const areaM2 = M2(surfaceArea(ctx.area));
    if (areaM2 < 220) {
      notes.push({ code: 'reject', severity: 'info', message: `${p.id} 可建域仅 ${areaM2.toFixed(0)} m²，不足以布置建筑` });
      continue;
    }
    try {
      if (input.typology === 'retail') retailOf(ctx);
      else if (input.typology === 'industrial' || input.typology === 'data_center') industrialOf(ctx);
      else residentialOf(ctx);
    } catch (e) {
      notes.push({ code: 'engine-fail', severity: 'warn', message: `${p.id} 建筑生成异常：${(e as Error).message}` });
    }
    for (const n of ctx.notes) notes.push(n);
    for (const f of ctx.failures) failures.push(f);
    // 门必须在同一个 ctx 里开：它需要真实的地块临街边与接入点
    for (const b of ctx.out) b.doors = addDoors(b, ctx);
    for (const b of ctx.out) global.push({ center: b.center, ang: b.ang, w: b.widthM, d: b.depthM });
    buildings.push(...ctx.out);
  }
  return { buildings, notes, failures };
}

function makeCtx(
  p: ParcelPlan,
  input: ComposeInput,
  params: SubdivisionParams,
  roads: InternalRoad[],
  globalPlaced: { center: Pt; ang: number; w: number; d: number }[]
): ParcelCtx | null {
  const area = p.usable ?? p.surface;
  if (!area || area.outer.length < 3 || surfaceArea(area) <= 1e-6) return null;
  const field = clearanceField(area, params.minWidthM > 12 ? 2 : 1.5);
  if (!field.core) return null;
  const ob = obbOf(area.outer);
  const ang = ob ? Math.atan2(ob.uy, ob.ux) : 0;
  // 临街：优先真实城市道路（内部道路作为次选），取最长的一条
  const city = p.candidate.frontages.filter((f) => p.access.some((a) => a.ref === f.roadKey && a.via === 'street'));
  const pick = (city.length ? city : p.candidate.frontages).slice().sort((a, b) => b.lengthM - a.lengthM)[0];
  let streetAng = ang;
  let inward = new Pt(-Math.sin(ang), Math.cos(ang));
  let frontEdge: [Pt, Pt] | null = null;
  if (pick) {
    const e = pick.edge;
    streetAng = Math.atan2(e[1].y - e[0].y, e[1].x - e[0].x);
    frontEdge = e;
    const nx = -Math.sin(streetAng);
    const ny = Math.cos(streetAng);
    const mid = new Pt((e[0].x + e[1].x) / 2, (e[0].y + e[1].y) / 2);
    const s = (field.core.at.x - mid.x) * nx + (field.core.at.y - mid.y) * ny;
    inward = new Pt(nx * Math.sign(s || 1), ny * Math.sign(s || 1));
  }
  return {
    p,
    area,
    field,
    core: field.core.at,
    ang,
    streetAng,
    inward,
    frontEdge,
    frontages: p.candidate.frontages.slice().sort((a, b2) => b2.lengthM - a.lengthM),
    roads,
    placed: [],
    global: globalPlaced,
    out: [],
    notes: [],
    failures: [],
    rng: makeRng(input.seed, `bld:${p.id}`),
  };
}

// ---------------------------------------------------------------- 落位原语

interface PutOpts {
  w: number;
  d: number;
  ang: number;
  at: Pt;
  floors: number;
  heightM?: number;
  name: string;
  grammar: SiteBuilding['grammar'];
  reason: string;
  minScale?: number;
  /** 是否允许被边界裁形（默认不允许，靠缩放而不是裁切） */
  allowClip?: boolean;
}

/**
 * 摆一栋楼。
 *
 * 判据顺序（与 F2.4-A 同一套，不另立标准）：
 *   ① 内切圆半径必要条件 → ② 5×5 采样 → ③ 精确布尔越界复核 → ④ 与已摆建筑精确求交。
 * 缩到 minScale 还不行就返回 null —— 由调用方决定是换形态还是明确拒绝。
 */
function put(cx: ParcelCtx, o: PutOpts): SiteBuilding | null {
  const r = placeRect(cx.area, cx.field, {
    ang: o.ang,
    w: U(o.w),
    d: U(o.d),
    prefer: (p, clear) => -Pt.distance(p, o.at) + clear * 0.3,
    minScale: o.minScale ?? 0.72,
    avoid: avoidRects(cx),
  });
  if (!r) return null;
  const floors = Math.max(1, Math.round(o.floors));
  const h = o.heightM ?? floors * floorHOf(o.grammar);
  const b: SiteBuilding = {
    id: `${cx.p.id}#${cx.out.length + 1}`,
    parcelId: cx.p.id,
    name: o.name,
    grammar: o.grammar,
    surface: r.surface,
    center: r.center,
    ang: o.ang,
    widthM: +(o.w * r.scale).toFixed(1),
    depthM: +(o.d * r.scale).toFixed(1),
    floors,
    heightM: +h.toFixed(1),
    doors: [],
    reason: o.reason + (r.scale < 0.999 ? `（受边界限制缩到 ${(r.scale * 100).toFixed(0)}%）` : ''),
    fill: +r.scale.toFixed(3),
  };
  cx.placed.push(r.surface);
  // 立刻进全场清单（**不是等这一块地摆完**）：否则同一地块内后摆的楼
  // 只看得到未扩边的已摆面，两块地之间 2 m、同一块地里 0 m，
  // 实测 G04 两栋楼只隔 0.13 m。
  cx.global.push({ center: b.center, ang: b.ang, w: b.widthM, d: b.depthM });
  cx.out.push(b);
  return b;
}

function floorHOf(g: SiteBuilding['grammar']): number {
  if (g === 'hall') return FLOOR_H.hall;
  if (g === 'street-shop-line') return FLOOR_H.retail;
  if (g === 'big-box') return FLOOR_H.mall;
  if (g === 'office') return FLOOR_H.office;
  return FLOOR_H.residential;
}

/**
 * 已摆建筑 + **2 m 退距**的矩形。
 *
 * 为什么不能只避让"重叠"：两栋楼贴在一起（甚至只是共一条边）时，
 * 长边上的门一推开就是邻居的墙 —— 实测 G04 有两栋的门因此被判"被相邻建筑挡住"。
 * 把每栋楼按外扩 2 m 的矩形送进 placeRect 的避让表，间距就由构造保证，
 * 后面的门检查只是复核。
 */
function avoidRects(cx: ParcelCtx): PlanSurface[] {
  return cx.global.map((g) => rectSurface(g.center, g.ang, U(g.w + 4), U(g.d + 4)));
}

/** 沿方向的偏移点 */
function off(at: Pt, ang: number, dist: number): Pt {
  return new Pt(at.x + Math.cos(ang) * dist, at.y + Math.sin(ang) * dist);
}

// ---------------------------------------------------------------- 住宅

/**
 * 住宅形态选择。
 *
 * 决定的不是"摆几栋"，而是**哪种居住类型**：
 *   · 地块够大够方 → 院落围合（周边式）：沿街是街墙，内部是院子；
 *   · 狭长 → 平行板楼：按日照间距排；
 *   · 小地块 → 单栋街屋。
 * 三种形态的层数、进深、间距都不同，所以不能"一个程序改参数"。
 */
function residentialOf(cx: ParcelCtx): void {
  const areaM2 = M2(surfaceArea(cx.area));
  const ob = obbOf(cx.area.outer);
  const wM = ob ? toM(Math.max(ob.w, ob.d)) : 0;
  const dM = ob ? toM(Math.min(ob.w, ob.d)) : 0;
  const big = areaM2 >= 2400 && dM >= 32;
  cx.notes.push({
    code: 'grammar',
    severity: 'info',
    message: `${cx.p.id}（${areaM2.toFixed(0)} m²，约 ${wM.toFixed(0)}×${dM.toFixed(0)} m）→ ${big ? '院落围合' : '街屋/板楼'}`,
  });
  if (big && courtyardBlock(cx)) return;
  if (parallelSlabs(cx)) return;
  singleBar(cx);
}

/**
 * 院落围合（周边式）。
 *
 * 先定院子（四至），再把四边 bar 贴上去 —— 顺序反了就会变成
 * "先摆几栋楼，剩下的空当叫院子"，那只是空地的别名。
 * 临街一侧断开 12 m 作为入口（车行 + 人行同口），这是院落的"门"。
 */
function courtyardBlock(cx: ParcelCtx): boolean {
  const ob = obbOf(cx.area.outer);
  if (!ob) return false;
  const axis = Math.atan2(ob.uy, ob.ux);
  // 长轴与临街方向夹角在 30° 内就用临街方向，否则用长轴（斜边地块顺边更合理）
  const dev = Math.abs(((axis - cx.streetAng + Math.PI / 2) % Math.PI) - Math.PI / 2);
  const u = dev < Math.PI / 6 ? cx.streetAng : axis;
  const v = u + Math.PI / 2;
  const dWing = 13; // 住宅进深（13 m 能排下两户 + 走廊）
  const courtW = Math.max(30, Math.min(52, toM(ob.w) * 0.42));
  const courtD = Math.max(24, Math.min(36, toM(ob.d) * 0.36));
  const gate = 12;
  const floors = 7 + Math.floor(cx.rng() * 4); // 7~10 层
  const C = cx.core;
  let n = 0;

  // 远端 bar（整条）
  n += put(cx, { w: courtW + dWing * 2, d: dWing, ang: u, at: off(C, v, U(courtD / 2 + dWing / 2)), floors, name: '院落北侧住宅', grammar: 'courtyard-bar', reason: '院落北翼：整条板楼，夏天挡西晒、冬天不遮南向日照' }) ? 1 : 0;
  // 临街侧 bar（断 12 m 门洞）
  const segW = (courtW + dWing * 2 - gate) / 2;
  if (segW >= 9) {
    const base = off(C, v, -U(courtD / 2 + dWing / 2));
    n += put(cx, { w: segW, d: dWing, ang: u, at: off(base, u, U((courtW + dWing * 2) / 2 - segW / 2)), floors: floors - 1, name: '临街住宅（东段）', grammar: 'courtyard-bar', reason: `临街街墙东段，中间让出 ${gate} m 院落入口` }) ? 1 : 0;
    n += put(cx, { w: segW, d: dWing, ang: u, at: off(base, u, -U((courtW + dWing * 2) / 2 - segW / 2)), floors: floors - 1, name: '临街住宅（西段）', grammar: 'courtyard-bar', reason: `临街街墙西段，中间让出 ${gate} m 院落入口` }) ? 1 : 0;
  }
  // 两侧 bar
  n += put(cx, { w: courtD, d: dWing, ang: v, at: off(C, u, U(courtW / 2 + dWing / 2)), floors, name: '院落东侧住宅', grammar: 'courtyard-bar', reason: '院落东翼：与北翼一起围合，东侧留消防通道' }) ? 1 : 0;
  n += put(cx, { w: courtD, d: dWing, ang: v, at: off(C, u, -U(courtW / 2 + dWing / 2)), floors, name: '院落西侧住宅', grammar: 'courtyard-bar', reason: '院落西翼：与北翼一起围合，西侧留消防通道' }) ? 1 : 0;
  if (n === 0) return false;
  cx.notes.push({
    code: 'grammar',
    severity: 'info',
    message: `${cx.p.id} 院落围合：院子 ${courtW.toFixed(0)}×${courtD.toFixed(0)} m，${n} 栋（${floors} 层），临街断 ${gate} m 入口`,
  });
  return true;
}

/**
 * 平行板楼。
 *
 * 排距不是"好看"决定的：24 m ≈ 1.2 × 建筑高度（8 层 24 m）的日照系数下限，
 * 也是消防车道（4 m）+ 宅间路（3 m）+ 绿化（10 m）的总和。
 */
function parallelSlabs(cx: ParcelCtx): boolean {
  const ob = obbOf(cx.area.outer);
  if (!ob) return false;
  const u = Math.abs(((Math.atan2(ob.uy, ob.ux) - cx.streetAng + Math.PI / 2) % Math.PI) - Math.PI / 2) < Math.PI / 6 ? cx.streetAng : Math.atan2(ob.uy, ob.ux);
  const v = u + Math.PI / 2;
  const dBar = 14;
  const gap = 24;
  const width = Math.min(toM(Math.max(ob.w, ob.d)) - 12, 68);
  const rows = Math.max(1, Math.min(2, Math.floor((toM(Math.min(ob.w, ob.d)) - 8 + gap) / (dBar + gap))));
  const floors = 8 + Math.floor(cx.rng() * 3);
  const C = cx.core;
  let n = 0;
  for (let i = 0; i < rows; i++) {
    const offset = (i - (rows - 1) / 2) * (dBar + gap);
    const b = put(cx, {
      w: width,
      d: dBar,
      ang: u,
      at: off(C, v, U(offset)),
      floors,
      name: `板楼 ${i + 1}`,
      grammar: 'parallel-slabs',
      reason: `平行板楼：排距 ${gap} m（≈1.2×建筑高度，日照 + 消防车道 + 宅间路）`,
    });
    if (b) n++;
  }
  if (n === 0) return false;
  cx.notes.push({ code: 'grammar', severity: 'info', message: `${cx.p.id} 平行板楼：${n} 排 × ${floors} 层，排距 ${gap} m` });
  return true;
}

/** 单栋街屋（小地块） */
function singleBar(cx: ParcelCtx): void {
  const ob = obbOf(cx.area.outer);
  const floors = 6 + Math.floor(cx.rng() * 4);
  const w = ob ? Math.min(toM(Math.max(ob.w, ob.d)) - 8, 54) : 30;
  const d = 14;
  const b = put(cx, {
    w: Math.max(12, w),
    d,
    ang: cx.streetAng,
    at: cx.core,
    floors,
    name: '沿街住宅',
    grammar: 'parallel-slabs',
    reason: '小地块只能落一栋：正脸朝街、进深 14 m（两户 + 楼梯间）',
    minScale: 0.6,
  });
  if (!b) {
    cx.notes.push({ code: 'reject', severity: 'warn', message: `${cx.p.id} 放不下住宅（可建域 ${M2(surfaceArea(cx.area)).toFixed(0)} m²）` });
  }
}

// ---------------------------------------------------------------- 商业

function retailOf(cx: ParcelCtx): void {
  const areaM2 = M2(surfaceArea(cx.area));
  const ob = obbOf(cx.area.outer);
  const dM = ob ? toM(Math.min(ob.w, ob.d)) : 0;
  cx.notes.push({
    code: 'grammar',
    severity: 'info',
    message: `${cx.p.id}（${areaM2.toFixed(0)} m²，进深约 ${dM.toFixed(0)} m）→ ${cx.p.fn === 'compound' || areaM2 > 3000 ? '沿街店面 + 大盒' : '沿街连续店面'}`,
  });
  const shops = shopLine(cx);
  if (cx.p.fn === 'compound' || areaM2 > 2600) {
    bigBox(cx);
  } else if (shops === 0) {
    // 没有可用的临街边（内部地块）：做一栋内向的商业体
    const b = put(cx, {
      w: 34,
      d: 22,
      ang: cx.ang,
      at: cx.core,
      floors: 3,
      name: '商业体',
      grammar: 'big-box',
      reason: '无城市道路临街 → 做内向商业体，主入口朝内部道路',
      minScale: 0.6,
    });
    if (!b) cx.notes.push({ code: 'reject', severity: 'warn', message: `${cx.p.id} 放不下商业建筑` });
  }
}

/**
 * 沿街连续店面。
 *
 * 不是"在质心摆一排矩形"：沿**真实临街折线**逐段走，每一开间都按该处的
 * 街边方向摆放 —— 所以斜街、弧街上店面是跟着街走的（G04 的斜边能看出来）。
 * 开间 8~14 m（一个商铺单元），进深 20 m，进深方向留 3 m 门前铺装。
 */
function shopLine(cx: ParcelCtx): number {
  const edge = cx.frontEdge;
  if (!edge) return 0;
  const lenM = Pt.distance(edge[0], edge[1]) * 7;
  if (lenM < 10) return 0;
  const ang = cx.streetAng;
  const inward = cx.inward;
  const depth = 20;
  const setback = 3; // 门前铺装（在 5 m 建筑退线之外再让 3 m）
  const units: number = Math.max(1, Math.floor(lenM / 13));
  const unitW = Math.min(14, Math.max(7, (lenM - 2) / units));
  let n = 0;
  for (let i = 0; i < units; i++) {
    const t = (i + 0.5) / units;
    const p0 = new Pt(edge[0].x + (edge[1].x - edge[0].x) * t, edge[0].y + (edge[1].y - edge[0].y) * t);
    const at = new Pt(p0.x + inward.x * U(setback + depth / 2), p0.y + inward.y * U(setback + depth / 2));
    const b = put(cx, {
      w: unitW,
      d: depth,
      ang,
      at,
      floors: 2 + (cx.rng() > 0.7 ? 1 : 0),
      name: `沿街商铺 ${i + 1}`,
      grammar: 'street-shop-line',
      reason: `沿街第 ${i + 1} 开间（${unitW.toFixed(0)} m 面宽 × ${depth} m 进深），门前 ${setback} m 铺装`,
      minScale: 0.8,
    });
    if (b) n++;
  }
  if (n > 0) {
    cx.notes.push({ code: 'grammar', severity: 'info', message: `${cx.p.id} 沿街店面 ${n} 开间（连续界面 ${(n * unitW).toFixed(0)} m / 可用 ${lenM.toFixed(0)} m）` });
  }
  return n;
}

/** 大盒（商场 / 超市）：自身 + 前场 */
function bigBox(cx: ParcelCtx): void {
  const ob = obbOf(cx.area.outer);
  if (!ob) return;
  const w = Math.min(64, toM(Math.max(ob.w, ob.d)) * 0.62);
  const d = Math.min(46, toM(Math.min(ob.w, ob.d)) * 0.55);
  if (w < 22 || d < 16) {
    cx.notes.push({ code: 'reject', severity: 'info', message: `${cx.p.id} 剩余空间不足 ${22}×${16} m，不放大盒` });
    return;
  }
  // 放在街墙之后（沿 inward 方向偏），把沿街面留给店面 / 前场
  const at = new Pt(cx.core.x + cx.inward.x * U(6), cx.core.y + cx.inward.y * U(6));
  const b = put(cx, {
    w,
    d,
    ang: cx.streetAng,
    at,
    floors: 4,
    name: '商业综合体',
    grammar: 'big-box',
    reason: `大盒 ${w.toFixed(0)}×${d.toFixed(0)} m，退到街墙之后，沿街面留作前场与落客`,
    minScale: 0.6,
  });
  if (b) cx.notes.push({ code: 'grammar', severity: 'info', message: `${cx.p.id} 大盒 ${b.widthM.toFixed(0)}×${b.depthM.toFixed(0)} m / 4 层` });
}

// ---------------------------------------------------------------- 工业

/**
 * 工业：办公前场 + 厂房 + 装卸坪。
 *
 * 货运净宽是硬指标，不是"尽量"：
 *   · 单车道 6.5 m（货车 2.5 m 宽 + 双侧余量）；
 *   · 装卸坪进深 ≥ 18 m（13.5 m 车长 + 倒车余量），最小 14 m（小型车）；
 *   · 厂房进深 30~40 m（单跨 24 m + 办公夹层）。
 * 场地放不下就**明确失败**（写清哪一项差多少），不压缩货车空间。
 */
function industrialOf(cx: ParcelCtx): void {
  const ob = obbOf(cx.area.outer);
  if (!ob) return;
  const wM = toM(Math.max(ob.w, ob.d));
  const dM = toM(Math.min(ob.w, ob.d));
  const variants = [
    { hallD: 36, apron: 22, office: true, officeD: 15, side: false },
    { hallD: 30, apron: 20, office: true, officeD: 14, side: false },
    { hallD: 30, apron: 16, office: true, officeD: 14, side: true },
    { hallD: 24, apron: 14, office: true, officeD: 12, side: true },
    { hallD: 24, apron: 14, office: false, officeD: 0, side: true },
  ];
  const u = Math.abs(((Math.atan2(ob.uy, ob.ux) - cx.streetAng + Math.PI / 2) % Math.PI) - Math.PI / 2) < Math.PI / 6 ? cx.streetAng : Math.atan2(ob.uy, ob.ux);
  /**
   * 所需进深。
   *
   * `side: true` 表示办公**并排**在厂房一端而不是前后串联 —— 窄场地（I01 只有 56 m 进深）
   * 前后串需要 10+12+14+24+6 = 66 m，无论如何放不下；并排只要 54 m 就成立。
   * 早先把 side 也算成串联，结果 I01 被判成"只能放厂房、不能放办公"，
   * 一个 142×56 的工业地块没有办公楼，这在功能上是不成立的。
   */
  const need = (x: (typeof variants)[number]) =>
    (x.side ? 10 + x.apron + x.hallD + 6 : 10 + x.officeD + x.apron + x.hallD + 6);
  const fit = variants.find((x) => dM >= need(x));
  if (!fit) {
    const minNeed = need(variants[variants.length - 1]);
    cx.failures.push(
      `${cx.p.id}：场地进深 ${dM.toFixed(1)} m < 工业最小布局所需 ${minNeed.toFixed(1)} m（退线 10 + 装卸 14 + 厂房 24 + 后场 6），` +
        `按任务书不压缩货运净宽，改为拒绝布置厂房`
    );
    cx.notes.push({
      code: 'reject',
      severity: 'error',
      message: `${cx.p.id} 工业布局不可行：进深 ${dM.toFixed(1)} m，最小需求 ${minNeed.toFixed(1)} m`,
    });
    return;
  }
  const floorsOffice = 4;
  let n = 0;
  const hallW = Math.min(60, Math.max(24, wM - 14));
  // 厂房位置：办公之后（串联）或者前端之后（并排）
  const backInsetM = fit.side ? fit.apron + fit.hallD / 2 + 4 : fit.officeD + fit.apron + fit.hallD / 2 + 4;
  const hallAt = new Pt(
    cx.core.x + cx.inward.x * U(backInsetM - 4) - cx.inward.x * U(0),
    cx.core.y + cx.inward.y * U(backInsetM - 4)
  );
  // 让厂房相对街边有 10 m 前场（串联时办公占这段，并排时是办公+货车场地）
  const hallShift = fit.side ? U(0) : 0;
  void hallShift;
  const hall = put(cx, {
    w: hallW,
    d: fit.hallD,
    ang: u,
    at: hallAt,
    floors: 1,
    heightM: fit.hallD >= 30 ? 11.5 : 9.5,
    name: '厂房',
    grammar: 'hall',
    reason: `厂房 ${hallW.toFixed(0)}×${fit.hallD} m、净高 ${fit.hallD >= 30 ? 11.5 : 9.5} m；前方 ${fit.apron} m 装卸坪（货车 13.5 m 长，倒车余量 ≥ 6 m）`,
    minScale: 0.7,
  });
  if (hall) n++;
  if (fit.office) {
    const officeW = Math.min(30, Math.max(16, fit.side ? 18 : wM * 0.3));
    /**
     * 办公位置相对**已摆好的厂房**算，不是相对理想点算。
     *
     * placeRect 可能因为边界/避让把厂房挪了几米，用理想点去推办公，
     * 推出来的位置就会落在厂房或边界上（实测 I01 办公连续失败）。
     * 三个候选：厂房一端（并排）/ 厂房靠街一侧（串联）/ 另一端。
     */
    const hc = hall ? hall.center : hallAt;
    const hu = hall ? hall.ang : u;
    const hw = hall ? U(hall.widthM / 2) : U(hallW / 2);
    const hd = hall ? U(hall.depthM / 2) : U(fit.hallD / 2);
    const candidatesAt = fit.side
      ? [
          off(hc, hu, hw + U(7 + officeW / 2)),
          off(hc, hu, -(hw + U(7 + officeW / 2))),
          new Pt(hc.x - cx.inward.x * U(hd + 8 + fit.officeD / 2), hc.y - cx.inward.y * U(hd + 8 + fit.officeD / 2)),
        ]
      : [
          new Pt(hc.x - cx.inward.x * U(hd + fit.apron / 2 + fit.officeD / 2), hc.y - cx.inward.y * U(hd + fit.apron / 2 + fit.officeD / 2)),
          off(hc, hu, hw + U(7 + officeW / 2)),
        ];
    // 按"离街面由近到远"排：办公要有街面存在感，靠街的候选先试
    candidatesAt.sort((a, b2) => nearestNetwork(a, cx.frontages, cx.roads).dist - nearestNetwork(b2, cx.frontages, cx.roads).dist);
    let placedOffice: SiteBuilding | null = null;
    for (const at of candidatesAt) {
      placedOffice = put(cx, {
        w: officeW,
        d: fit.officeD,
        ang: hu,
        at,
        floors: floorsOffice,
        name: '办公楼',
        grammar: 'office',
        reason: `办公前场：${fit.side ? '与厂房并排（窄场地不做前后串联）' : '贴街布置'}，${floorsOffice} 层，前场兼做客货分流`,
        minScale: 0.7,
      });
      if (placedOffice) break;
    }
    if (placedOffice) n++;
    else cx.notes.push({ code: 'reject', severity: 'warn', message: `${cx.p.id} 办公楼放不下（${officeW.toFixed(0)}×${fit.officeD} m，试了 ${candidatesAt.length} 个位置）` });
  }
  if (n === 0) {
    cx.failures.push(`${cx.p.id}：场地 ${wM.toFixed(0)}×${dM.toFixed(0)} m 连最小工业单元（24×24 厂房 + 14 m 装卸坪）都放不下`);
    cx.notes.push({ code: 'reject', severity: 'error', message: `${cx.p.id} 工业建筑全部放不下` });
    return;
  }
  cx.notes.push({
    code: 'grammar',
    severity: 'info',
    message: `${cx.p.id} 工业布局：${n} 栋（办公 ${fit.officeD} m 进深 + 装卸坪 ${fit.apron} m + 厂房 ${fit.hallD} m 进深，共需 ${need(fit).toFixed(0)} m / 实有 ${dM.toFixed(0)} m）`,
  });
}

// ---------------------------------------------------------------- 门

/**
 * 给每栋建筑开门。
 *
 * 判据是"这面墙到**真实临街边**有多远"，不是"哪个方向好看"：
 *   · 主入口 = 离临街边最近的那一面（沿街店面的门因此天然朝街）；
 *   · 服务入口 = 离临街边最远的那一面（背面，进货/垃圾，不占街面）；
 *   · 次入口 = 两个侧面的一个（疏散要求两个方向）；
 *   · 货运入口只给厂房，开在装卸坪那一面（与主入口同一侧，因为装卸坪就在厂房前）。
 * 每个门都带 `reachM`（到临街边的距离，米），验证层据此判断"门是不是接上了真路"。
 */
export function addDoors(b: SiteBuilding, cx: ParcelCtx): SiteDoor[] {
  if (b.surface.outer.length < 4) return [];
  const faces = faceNormals(b);
  const fr = cx.frontages;
  if (fr.length === 0) {
    return [
      {
        kind: 'main',
        at: faces[0].at,
        normal: faces[0].normal,
        target: `${cx.p.id}:internal`,
        reachM: 0,
        apron: false,
      },
    ];
  }
  const near = faces.map((f) => ({ f, ...nearestNetwork(f.at, fr, cx.roads) }));
  const byDist = near.slice().sort((a, b2) => a.dist - b2.dist);
  /**
   * 院落 bar 的主入口朝院，不朝街。
   *
   * 周边式住宅的"主入口"本来就是院内门厅（院是住户的公共客厅），
   * 按"离街最近"选会选到背街那面 —— 那面正对另一翼的墙，门开出去就是墙
   *（实测 G07 的院落西翼被判"门前被相邻建筑挡住"）。
   */
  let main = byDist[0];
  const courtyardOrder: typeof near = [];
  if (b.grammar === 'courtyard-bar') {
    // 判据：这一面的正前方 12 m 处，离最近的**其它建筑**有多远 —— 选最空的那面。
    // 比"朝地块几何中心"稳：地块中心可能正好落在另一翼里（实测 G07 西翼）。
    let bestClear = -Infinity;
    for (const x of near) {
      const probe = new Pt(x.f.at.x + x.f.normal.x * U(9), x.f.at.y + x.f.normal.y * U(9));
      let nearestProbe = Infinity;
      let nearestDoor = Infinity;
      for (const o of cx.out) {
        if (o.id === b.id) continue;
        nearestProbe = Math.min(nearestProbe, distToRing(probe, o.surface));
        nearestDoor = Math.min(nearestDoor, distToRing(x.f.at, o.surface));
      }
      // 门口自身的净距也要看：只看到 9 m 外的探针会漏掉"门紧贴隔壁墙"的情况
      const clear = Math.min(nearestProbe, nearestDoor * 3);
      courtyardOrder.push(x);
      if (clear > bestClear) {
        bestClear = clear;
        main = x;
      }
    }
    courtyardOrder.sort((a, b2) => scoreOf(b2) - scoreOf(a));
    function scoreOf(x: (typeof near)[number]): number {
      const probe = new Pt(x.f.at.x + x.f.normal.x * U(9), x.f.at.y + x.f.normal.y * U(9));
      let np = Infinity;
      let nd = Infinity;
      for (const o of cx.out) {
        if (o.id === b.id) continue;
        np = Math.min(np, distToRing(probe, o.surface));
        nd = Math.min(nd, distToRing(x.f.at, o.surface));
      }
      return Math.min(np, nd * 3);
    }
  }
  /**
   * 兜底：主入口那一面如果"出门就撞墙"（0.7 m 外就是别的楼），往后顺延另一面。
   *
   * 院落围合的窄院（G04 的三角地里院子只有 24 m 宽）四个面都挨得近，
   * 按打分选出来的第一面偶尔正对另一翼的墙。门不能开在墙上，
   * 所以这里做一次真正的外向检查，而不是把打分当结论。
   */
  {
    const order = courtyardOrder.length > 0 ? courtyardOrder.slice(1) : byDist.slice(1);
    const blockedAt = (x: (typeof near)[number]) => {
      const probe = new Pt(x.f.at.x + x.f.normal.x * U(0.8), x.f.at.y + x.f.normal.y * U(0.8));
      return cx.out.some((o) => o.id !== b.id && insideSurface(probe, o.surface));
    };
    if (blockedAt(main)) {
      const alt = order.find((x) => !blockedAt(x));
      if (alt) main = alt;
    }
  }
  const rear = byDist[byDist.length - 1];
  const sides = near.filter((x) => x !== main && x !== rear);
  const out: SiteDoor[] = [
    {
      kind: b.grammar === 'hall' ? 'freight' : 'main',
      at: main.f.at,
      normal: main.f.normal,
      target: main.roadKey,
      reachM: +(main.dist * 7).toFixed(1),
      apron: false,
    },
  ];
  if (sides[0]) {
    out.push({
      kind: 'secondary',
      at: sides[0].f.at,
      normal: sides[0].f.normal,
      target: sides[0].roadKey,
      reachM: +(sides[0].dist * 7).toFixed(1),
      apron: false,
    });
  }
  if (b.grammar !== 'street-shop-line') {
    out.push({
      kind: 'service',
      at: rear.f.at,
      normal: rear.f.normal,
      target: `${cx.p.id}:service`,
      reachM: +(rear.dist * 7).toFixed(1),
      apron: false,
    });
  }
  if (b.grammar !== 'hall' && cx.p.fn === 'compound') {
    out.push({
      kind: 'secondary',
      at: rear.f.at,
      normal: rear.f.normal,
      target: `${cx.p.id}:courtyard`,
      reachM: +(rear.dist * 7).toFixed(1),
      apron: false,
    });
  }
  return out;
}

/**
 * 点到**通行网络**的距离（米）与网络成员 key。
 *
 * 网络 = 真实临街边 + 内部道路路面。为什么必须含内部道路：
 * 一个 4000 m² 的组团后排建筑离城市道路 60 m，它的门接的是院内通道，
 * 只按"到街边距离"判会把它判成"门不可达"（实测 G01 组团后排 62.5 m 被判失败）。
 */
function nearestNetwork(p: Pt, fr: ParcelPlan['candidate']['frontages'], roads: InternalRoad[]): { dist: number; roadKey: string } {
  let bd = Infinity;
  let key = fr[0]?.roadKey ?? 'none';
  for (const f of fr) {
    const d = distToSeg(p, f.edge[0], f.edge[1]);
    if (d < bd) {
      bd = d;
      key = f.roadKey;
    }
  }
  for (const r of roads) {
    const d = distToRing(p, r.surface);
    if (d < bd) {
      bd = d;
      key = r.id;
    }
  }
  return { dist: bd, roadKey: key };
}

function distToRing(p: Pt, s: PlanSurface): number {
  let d = Infinity;
  for (const ring of [s.outer, ...s.holes]) {
    for (let i = 0; i < ring.length; i++) d = Math.min(d, distToSeg(p, ring[i], ring[(i + 1) % ring.length]));
  }
  return d;
}

function distToSeg(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-12) return Pt.distance(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

/** 矩形四面的外法线与边中点（按长轴方向重建，避免环序噪声） */
function faceNormals(b: SiteBuilding): { normal: Pt; at: Pt }[] {
  const ux = Math.cos(b.ang);
  const uy = Math.sin(b.ang);
  const hw = (b.widthM / 2) * (1 / 7);
  const hd = (b.depthM / 2) * (1 / 7);
  const c = b.center;
  const u = new Pt(ux, uy);
  const v = new Pt(-uy, ux);
  return [
    { normal: new Pt(-u.x, -u.y), at: new Pt(c.x - u.x * hw, c.y - u.y * hw) },
    { normal: new Pt(u.x, u.y), at: new Pt(c.x + u.x * hw, c.y + u.y * hw) },
    { normal: new Pt(-v.x, -v.y), at: new Pt(c.x - v.x * hd, c.y - v.y * hd) },
    { normal: new Pt(v.x, v.y), at: new Pt(c.x + v.x * hd, c.y + v.y * hd) },
  ];
}

/** 建筑面积（m²） */
export function gfaOf(b: SiteBuilding): number {
  return M2(surfaceArea(b.surface)) * b.floors;
}

/** 城市道路临街长度（米） */
export function cityFrontageM(p: ParcelPlan): number {
  return p.streetFrontageM;
}

export type { SiteTypology };
