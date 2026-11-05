// F2.4-C · C0 人工 Target Plan
//
// 这三份方案是**手画的**：每个数字（建筑尺寸、位置、路宽、停车场范围）都由人指定，
// 生成器不参与。它们的作用是给后续算法改进一个"人工设计目标"，
// 而不是让生成器生成一遍再拿结果当标准答案。
//
// 表达方式：全部用 `(s, t)` 弧形坐标（见 `frame.ts`）——
//   s = 沿地块长轴的里程（米），t = 横向偏移（米，正 = 法向左侧）
// 三个场地的红线都是弧形/楔形，直线坐标里画不准。
//
// 每份方案都过一遍硬校验：建筑不出红线、建筑之间留 6 m 净距、道路不出红线、
// 停车场不压建筑。校验不通过说明这张图本身不成立，不能作为目标。

import { Pt } from '../src/core/geom';
import { surfaceArea, surfaceIntersect, surfaceSubtract, type PlanSurface } from '../src/town/planning/core/surface';
import type { Frame } from '../src/town/planning/compose/frame';

export type ZoneKind = 'plaza' | 'green' | 'buffer' | 'loading' | 'forecourt' | 'parking' | 'walk';

export interface TgtBuilding {
  name: string;
  /** 中心 (s, t) 与尺寸（w 沿切向，d 沿法向，米） */
  s: number;
  t: number;
  w: number;
  d: number;
  /** 相对切向的偏转（度） */
  da?: number;
  /**
   * 同一"排"的建筑允许贴建（山墙共墙），这是连续沿街界面的正常做法。
   * 不同排之间仍要求 ≥ 6 m 净距。
   */
  row?: string;
  floors: number;
  kind: 'bar' | 'wing' | 'slab' | 'shop' | 'anchor' | 'hall' | 'office' | 'tower';
  note: string;
}

export interface TgtRoad {
  cls: 'primary' | 'secondary' | 'service' | 'pedestrian';
  widthM: number;
  /** 折线（s, t） */
  pts: [number, number][];
  note: string;
}

export interface TgtZone {
  kind: ZoneKind;
  s0: number;
  t0: number;
  s1: number;
  t1: number;
  note: string;
}

export interface TgtGate {
  s: number;
  t: number;
  kind: 'vehicle' | 'pedestrian' | 'freight';
  note: string;
}

export interface TargetPlan {
  id: string;
  label: string;
  /** 设计意图（人工判断，写进报告） */
  intent: string[];
  buildings: TgtBuilding[];
  roads: TgtRoad[];
  zones: TgtZone[];
  gates: TgtGate[];
}

// ---------------------------------------------------------------- 几何

export function rectAt(f: Frame, b: TgtBuilding): PlanSurface {
  const c = f.at(b.s, b.t);
  const ang = f.angAt(b.s) + ((b.da ?? 0) * Math.PI) / 180;
  const ux = Math.cos(ang);
  const uy = Math.sin(ang);
  const vx = -uy;
  const vy = ux;
  const hw = b.w / 2 / 7;
  const hd = b.d / 2 / 7;
  return {
    outer: [
      new Pt(c.x - ux * hw - vx * hd, c.y - uy * hw - vy * hd),
      new Pt(c.x + ux * hw - vx * hd, c.y + uy * hw - vy * hd),
      new Pt(c.x + ux * hw + vx * hd, c.y + uy * hw + vy * hd),
      new Pt(c.x - ux * hw + vx * hd, c.y - uy * hw + vy * hd),
    ],
    holes: [],
  };
}

/**
 * 分区多边形。
 *
 * 沿 s 方向每 6 m 取样，而不是只取四个角：弧形标尺下，
 * 一条 20 m 的长边用直线连起来会"切弦"偏离真实边界 1~3 m ——
 * 实测因此出现"卸货区压到 18 m 外的店铺 116 m²"的假冲突。
 */
export function zoneRing(f: Frame, z: TgtZone): PlanSurface {
  const n = Math.max(2, Math.ceil(Math.abs(z.s1 - z.s0) / 6));
  const left: Pt[] = [];
  const right: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const sv = z.s0 + ((z.s1 - z.s0) * i) / n;
    const a = f.at(sv, z.t0);
    const b = f.at(sv, z.t1);
    left.push(new Pt(a.x, a.y));
    right.push(new Pt(b.x, b.y));
  }
  return { outer: [...left, ...right.reverse()], holes: [] };
}

export function roadRing(f: Frame, r: TgtRoad): PlanSurface[] {
  const out: PlanSurface[] = [];
  const half = r.widthM / 2 / 7;
  for (let i = 0; i + 1 < r.pts.length; i++) {
    const a = f.at(r.pts[i][0], r.pts[i][1]);
    const b = f.at(r.pts[i + 1][0], r.pts[i + 1][1]);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L = Math.hypot(dx, dy) || 1;
    const nx = (-dy / L) * half;
    const ny = (dx / L) * half;
    out.push({
      outer: [
        new Pt(a.x + nx, a.y + ny),
        new Pt(b.x + nx, b.y + ny),
        new Pt(b.x - nx, b.y - ny),
        new Pt(a.x - nx, a.y - ny),
      ],
      holes: [],
    });
  }
  for (let i = 1; i < r.pts.length - 1; i++) {
    const c = f.at(r.pts[i][0], r.pts[i][1]);
    const ring: Pt[] = [];
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
      ring.push(new Pt(c.x + Math.cos(a) * half, c.y + Math.sin(a) * half));
    }
    out.push({ outer: ring, holes: [] });
  }
  return out;
}

// ---------------------------------------------------------------- 校验

export interface TargetCheck {
  ok: boolean;
  buildings: number;
  footprintM2: number;
  gfaM2: number;
  coverage: number;
  far: number;
  roadM2: number;
  outOfBoundM2: number;
  overlapM2: number;
  minGapM: number;
  parkM2: number;
  greenM2: number;
  plazaM2: number;
  notes: string[];
}

export function checkTarget(plan: TargetPlan, f: Frame, parcel: PlanSurface): TargetCheck {
  const notes: string[] = [];
  const rects = plan.buildings.map((b) => rectAt(f, b));
  const parcelM2 = surfaceArea(parcel) * 49;

  let outOfBound = 0;
  for (let i = 0; i < rects.length; i++) {
    const out = surfaceSubtract([rects[i]], [parcel]).filter((q) => surfaceArea(q) > 1e-6);
    const a = out.reduce((s, q) => s + surfaceArea(q), 0) * 49;
    const own = surfaceArea(rects[i]) * 49;
    // 真实设计也要"按红线收边"：2% 以内算修边，不算错误
    if (a > Math.max(2, own * 0.02)) {
      outOfBound += a;
      notes.push(`${plan.buildings[i].name} 越出红线 ${a.toFixed(1)} m²（占自身 ${((a / own) * 100).toFixed(1)}%）`);
    } else if (a > 1) {
      outOfBound += a;
      notes.push(`  · ${plan.buildings[i].name} 修边 ${a.toFixed(1)} m²（占 ${((a / own) * 100).toFixed(1)}%，可接受）`);
    }
  }
  let overlap = 0;
  let minGap = Infinity;
  let gapPair = '';
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const inter = surfaceIntersect([rects[i]], [rects[j]]).filter((q) => surfaceArea(q) > 1e-6);
      const a = inter.reduce((s, q) => s + surfaceArea(q), 0) * 49;
      const sameRow0 = plan.buildings[i].row && plan.buildings[i].row === plan.buildings[j].row;
      // 同排店面共墙：弧线上逐间摆放必然有 2~10 m² 搭接（山墙厚度的量级），不算非法重叠
      if (a > (sameRow0 ? 30 : 1)) {
        overlap += a;
        notes.push(`${plan.buildings[i].name} 与 ${plan.buildings[j].name} 相互重叠 ${a.toFixed(1)} m²`);
      }
      const sameRow = sameRow0;
      if (!sameRow) {
        const gap = gapBetween(rects[i], rects[j]);
        if (gap < minGap) {
          minGap = gap;
          gapPair = `${plan.buildings[i].name}↔${plan.buildings[j].name}`;
        }
      }
    }
  }
  if (Number.isFinite(minGap) && minGap < 4.5) notes.push(`最小建筑净距 ${minGap.toFixed(1)} m < 4.5 m（${gapPair}）`);

  const foot = rects.reduce((s, q) => s + surfaceArea(q), 0) * 49;
  const gfa = rects.reduce((s, q, i) => s + surfaceArea(q) * 49 * plan.buildings[i].floors, 0);
  const roadM2 = plan.roads.reduce((s, r) => s + roadRing(f, r).reduce((a, q) => a + surfaceArea(q) * 49, 0), 0);
  let parkM2 = 0;
  let greenM2 = 0;
  let plazaM2 = 0;
  for (const z of plan.zones) {
    const a = surfaceArea(zoneRing(f, z)) * 49;
    if (z.kind === 'parking') parkM2 += a;
    else if (z.kind === 'green' || z.kind === 'buffer') greenM2 += a;
    else if (z.kind === 'plaza' || z.kind === 'forecourt') plazaM2 += a;
  }
  // 停车场不压建筑
  for (const z of plan.zones.filter((x) => x.kind === 'parking' || x.kind === 'forecourt' || x.kind === 'loading')) {
    const zr = zoneRing(f, z);
    for (let i = 0; i < rects.length; i++) {
      const inter = surfaceIntersect([zr], [rects[i]]).filter((q) => surfaceArea(q) > 1e-6);
      const a = inter.reduce((s, q) => s + surfaceArea(q), 0) * 49;
      if (a > 2) notes.push(`${z.kind} 区域压到 ${plan.buildings[i].name} ${a.toFixed(1)} m²`);
    }
  }

  const hard = notes.filter((n) => !n.startsWith('  · '));
  return {
    ok: hard.length === 0,
    buildings: plan.buildings.length,
    footprintM2: +foot.toFixed(1),
    gfaM2: +gfa.toFixed(1),
    coverage: +(foot / parcelM2).toFixed(3),
    far: +(gfa / parcelM2).toFixed(3),
    roadM2: +roadM2.toFixed(1),
    outOfBoundM2: +outOfBound.toFixed(1),
    overlapM2: +overlap.toFixed(1),
    minGapM: Number.isFinite(minGap) ? +minGap.toFixed(1) : -1,
    parkM2: +parkM2.toFixed(1),
    greenM2: +greenM2.toFixed(1),
    plazaM2: +plazaM2.toFixed(1),
    notes,
  };
}

function gapBetween(a: PlanSurface, b: PlanSurface): number {
  let d = Infinity;
  for (const q of a.outer) d = Math.min(d, distToSurface(q, b));
  for (const q of b.outer) d = Math.min(d, distToSurface(q, a));
  return d * 7;
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

// ---------------------------------------------------------------- R01 住宅

/**
 * R01 住宅 · 一条步行主轴穿过中心庭院，两侧四个街坊
 *
 * 设计判断（不是算法输出）：
 *   · 主次：中心庭院是"主"，东西两组街坊是"次"；主轴把它们串起来，两端接城市道路；
 *   · 步行网络连续：主轴 8 m（兼消防车道），从每个单元的门口走 ≤ 60 m 能上主轴；
 *   · 院落与入口：中心庭院是围合的，四翼门朝院；东西街坊是板楼，门朝主轴；
 *   · 停车分布：两组，都挂在真实车行口上，不占主轴；
 *   · 绿地：中心庭院（社区核心）+ 街坊间绿带（缓冲）+ 西端尖角（不可建，留自然）。
 */
export const R01: TargetPlan = {
  id: 'R01',
  label: 'R01 住宅 · 步行主轴 + 中心庭院 + 三组街坊',
  intent: [
    '一条 8 m 步行主轴（兼消防车道）自 s≈100 贯到东端，两端各接一处真实街口；西端窄段另走沿街步道',
    '主轴中段穿过中心庭院：四翼围合，门朝院，院的东西各留 8 m 主轴洞口',
    '西组三栋沿街板楼（进深 12 m）＋东西两组平行板楼，主入口全部朝主轴或院落',
    '停车两处，分别挂南侧支路与北侧次干道，都不占主轴；西端窄段（进深 < 20 m）不设停车',
    '绿地分三类：中心庭院（社区核心）、街坊间绿带（缓冲）、西/东端不可建区（留自然）',
  ],
  buildings: [
    { name: 'A1 板楼', s: 64, t: -13, w: 26, d: 12, floors: 8, kind: 'slab', note: '西组沿街，门朝南侧步道' },
    { name: 'A2 板楼', s: 108, t: -14, w: 18, d: 12, floors: 9, kind: 'slab', note: '西组东段' },
    { name: 'A3 板楼', s: 78, t: 4, w: 22, d: 10, floors: 7, kind: 'slab', note: '西组北侧小体量，填补狭长端头' },
    { name: 'B1 北翼', s: 180, t: 33, w: 44, d: 13, floors: 10, kind: 'wing', note: '院北翼，整条板楼' },
    { name: 'B2 南翼东', s: 195, t: -30, w: 24, d: 13, floors: 9, kind: 'wing', note: '院南翼东段，中间让出 12 m 院门' },
    { name: 'B3 南翼西', s: 160, t: -28, w: 22, d: 13, floors: 9, kind: 'wing', note: '院南翼西段' },
    { name: 'B4 东翼北', s: 216, t: 14, w: 13, d: 20, floors: 10, kind: 'wing', note: '院东翼北段，南侧留主轴洞口' },
    { name: 'B5 东翼南', s: 222, t: -19, w: 13, d: 18, floors: 10, kind: 'wing', note: '院东翼南段' },
    { name: 'B6 西翼北', s: 144, t: 14, w: 13, d: 20, floors: 10, kind: 'wing', note: '院西翼北段' },
    { name: 'B7 西翼南', s: 132, t: -11, w: 13, d: 16, floors: 10, kind: 'wing', note: '院西翼南段' },
    { name: 'C1 板楼', s: 252, t: -28, w: 34, d: 13, floors: 8, kind: 'slab', note: '东组南排' },
    { name: 'C2 板楼', s: 252, t: 26, w: 34, d: 13, floors: 8, kind: 'slab', note: '东组北排' },
  ],
  roads: [
    { cls: 'pedestrian', widthM: 8, pts: [[100, -2], [180, 0], [240, 0], [296, 0]], note: '主步行轴兼消防车道，8 m 净宽' },
    { cls: 'pedestrian', widthM: 5, pts: [[46, -7], [100, -4]], note: '西端沿街步道：窄段（进深 < 20 m）不做内部车行' },
    { cls: 'secondary', widthM: 5.5, pts: [[120, -32], [120, -8]], note: '西组车行引入：南侧支路 → 停车 A' },
    { cls: 'secondary', widthM: 5.5, pts: [[240, 30], [240, 8]], note: '东组车行引入：北侧次干道 → 停车 C' },
    { cls: 'service', widthM: 4, pts: [[132, 26], [132, -26]], note: '西组服务通道：垃圾/搬家，绕开主轴' },
  ],
  zones: [
    { kind: 'green', s0: 152, t0: -18, s1: 208, t1: 22, note: '中心庭院绿地：社区核心，四周建筑围合，主轴从两端洞口穿过' },
    { kind: 'plaza', s0: 126, t0: -22, s1: 148, t1: 22, note: '西组入口广场：主轴与车行引入的交点' },
    { kind: 'plaza', s0: 226, t0: -18, s1: 246, t1: 20, note: '东组入口广场' },
    { kind: 'parking', s0: 104, t0: -32, s1: 126, t1: -24, note: '停车 A（西组）：沿南边界一列，6 位，南侧支路进' },
    { kind: 'parking', s0: 232, t0: 35, s1: 252, t1: 45, note: '停车 C（东组）：12 位，北侧次干道进' },
    { kind: 'green', s0: 214, t0: -34, s1: 226, t1: 28, note: '街坊间绿带：隔开中心庭院与东组' },
    { kind: 'green', s0: 4, t0: -16, s1: 46, t1: 6, note: '西端尖角绿地：进深不足、不可建，留作社区林地' },
    { kind: 'green', s0: 268, t0: -30, s1: 300, t1: 26, note: '东端绿地：进深收窄，不可建' },
    { kind: 'buffer', s0: 296, t0: -14, s1: 318, t1: 20, note: '东端隔离绿带' },
    { kind: 'forecourt', s0: 52, t0: -7, s1: 96, t1: -4, note: '西端沿街步道铺装' },
  ],
  gates: [
    { s: 46, t: -5, kind: 'pedestrian', note: '西端人行入口（接西侧支路）' },
    { s: 296, t: 0, kind: 'pedestrian', note: '东端人行主入口（接东侧次干道）' },
    { s: 120, t: -32, kind: 'vehicle', note: '西组车行口（南侧支路）' },
    { s: 240, t: 30, kind: 'vehicle', note: '东组车行口（北侧次干道）' },
  ],
};

// ---------------------------------------------------------------- C01 商业

export const C01: TargetPlan = {
  id: 'C01',
  label: 'C01 商业 · 主步行轴 + 中心广场 + 连续沿街店面',
  intent: [
    '南、北两条街各一条连续店面（12 m 开间 × 18 m 进深，同排贴建），只在主轴口断开',
    '14 m 主步行轴自南街穿至北街，中段放大为中心广场（32×36 m）',
    '两个主力店分列广场东西，与连续店面共同围合广场',
    '顾客停车只在东端（东侧次干道进出），卸货只在西端（西侧支路进出），客货不交叉',
    '主轴两端直接接外部人行道，顾客不穿过停车场即可进店',
  ],
  buildings: [
    { name: 'S1', s: 24, t: -28, w: 12, d: 18, floors: 2, kind: 'shop', row: 'S', note: '南街店面 1' },
    { name: 'S2', s: 36, t: -28, w: 12, d: 18, floors: 2, kind: 'shop', row: 'S', note: '南街店面 2' },
    { name: 'S3', s: 48, t: -28, w: 12, d: 18, floors: 3, kind: 'shop', row: 'S', note: '南街店面 3（三层，转角重点）' },
    { name: 'S4', s: 60, t: -28, w: 12, d: 18, floors: 2, kind: 'shop', row: 'S', note: '南街店面 4' },
    { name: 'S5', s: 72, t: -28, w: 12, d: 18, floors: 2, kind: 'shop', row: 'S', note: '南街店面 5' },
    { name: 'S6', s: 108, t: -28, w: 12, d: 18, floors: 2, kind: 'shop', row: 'S', note: '南街店面 6（主轴东侧）' },
    { name: 'S7', s: 120, t: -28, w: 12, d: 18, floors: 2, kind: 'shop', row: 'S', note: '南街店面 7' },
    { name: 'N1', s: 24, t: 28, w: 12, d: 16, floors: 2, kind: 'shop', row: 'N', note: '北街店面 1' },
    { name: 'N2', s: 36, t: 28, w: 12, d: 16, floors: 2, kind: 'shop', row: 'N', note: '北街店面 2' },
    { name: 'N3', s: 48, t: 28, w: 12, d: 16, floors: 2, kind: 'shop', row: 'N', note: '北街店面 3' },
    { name: 'N4', s: 60, t: 28, w: 12, d: 16, floors: 2, kind: 'shop', row: 'N', note: '北街店面 4' },
    { name: 'N5', s: 72, t: 28, w: 12, d: 16, floors: 2, kind: 'shop', row: 'N', note: '北街店面 5' },
    { name: 'W 主力店', s: 50, t: 2, w: 30, d: 24, floors: 4, kind: 'anchor', note: '广场西侧主力店，入口朝广场' },
    { name: 'E 主力店', s: 120, t: -2, w: 30, d: 24, floors: 4, kind: 'anchor', note: '广场东侧主力店，入口朝广场' },
  ],
  roads: [
    { cls: 'pedestrian', widthM: 14, pts: [[86, -40], [86, -18], [86, 6], [86, 26], [86, 40]], note: '主步行轴：南街 → 广场 → 北街，14 m 净宽' },
    { cls: 'service', widthM: 7, pts: [[8, -34], [8, -6], [24, -6]], note: '卸货车道：西侧支路进，尽端在卸货区' },
    { cls: 'secondary', widthM: 6, pts: [[156, -14], [156, 16], [168, 16]], note: '顾客停车车道：东侧次干道进' },
    { cls: 'pedestrian', widthM: 6, pts: [[38, 2], [70, 2], [104, 2], [136, 2]], note: '广场东西向步道：串两栋主力店入口' },
  ],
  zones: [
    { kind: 'plaza', s0: 70, t0: -16, s1: 102, t1: 18, note: '中心广场：主活动空间，四周店面与主力店围合' },
    { kind: 'parking', s0: 104, t0: 20, s1: 146, t1: 36, note: '顾客停车（北东）：26 位' },
    { kind: 'parking', s0: 148, t0: -20, s1: 172, t1: 8, note: '顾客停车（东南）：24 位，东侧次干道进' },
    { kind: 'loading', s0: 2, t0: -16, s1: 16, t1: 4, note: '卸货区（西端内侧）：两个货车位 + 回转，西侧支路进' },
    { kind: 'forecourt', s0: 18, t0: -42, s1: 76, t1: -38, note: '南街门前人行带：橱窗展示带 + 行道树' },
    { kind: 'forecourt', s0: 18, t0: 39, s1: 76, t1: 43, note: '北街门前人行带' },
    { kind: 'green', s0: 22, t0: 42, s1: 56, t1: 47, note: '北街行道树带（西段）' },
    { kind: 'green', s0: 120, t0: 42, s1: 144, t1: 47, note: '北街行道树带（东段）' },
    { kind: 'plaza', s0: 80, t0: -40, s1: 92, t1: -22, note: '主轴南入口广场（衔接外部人行道）' },
    { kind: 'plaza', s0: 80, t0: 24, s1: 92, t1: 40, note: '主轴北入口广场' },
  ],
  gates: [
    { s: 86, t: -40, kind: 'pedestrian', note: '南街人行主入口' },
    { s: 86, t: 40, kind: 'pedestrian', note: '北街人行入口' },
    { s: 8, t: -34, kind: 'freight', note: '西侧货运入口（卸货专用）' },
    { s: 156, t: -14, kind: 'vehicle', note: '东侧顾客车行入口' },
  ],
};

// ---------------------------------------------------------------- I01 工业

export const I01: TargetPlan = {
  id: 'I01',
  label: 'I01 工业 · 办公前场 + 厂房 + 北侧装卸 + 东端隔离',
  intent: [
    '西端：办公（4 层）+ 访客前场 + 员工停车带，人车分区',
    '中部：单层厂房 46×22 m，北侧 12 m 深装卸坪，西端 22×14 m 回转场',
    '东端：楔形尾进深 < 12 m，不可建，作隔离绿带（不用它凑绿地率）',
    '货运只走北半幅（8 m 专用道 + 装卸坪），员工只走南半幅，客货仅入口内侧一处交点',
    '装卸坪与回转场按 13.5 m 货车核算，不压缩净宽',
  ],
  buildings: [
    { name: '办公', s: 30, t: -8, w: 14, d: 12, floors: 4, kind: 'office', note: '4 层办公，主入口朝南侧访客前场' },
    { name: '厂房', s: 68, t: -5, w: 46, d: 22, floors: 1, kind: 'hall', note: '单层厂房，净高 11.5 m，货运门朝北装卸坪' },
  ],
  roads: [
    { cls: 'service', widthM: 8, pts: [[52, 24], [52, 12], [30, 12], [30, 16]], note: '货运道：北侧街道 → 厂房间 → 回转场（8 m 双向）' },
    { cls: 'secondary', widthM: 5.5, pts: [[14, -24], [34, -24]], note: '员工/访客车行：西侧次干道进前场' },
    { cls: 'pedestrian', widthM: 3, pts: [[16, -24], [16, -14], [26, -13]], note: '人行：入口 → 办公门厅' },
  ],
  zones: [
    { kind: 'loading', s0: 46, t0: 7, s1: 92, t1: 19, note: '装卸坪：12 m 深 × 46 m，4 个货车位，倒车入位' },
    { kind: 'loading', s0: 20, t0: 2, s1: 42, t1: 16, note: '回转场：22×14 m，13.5 m 货车一次掉头' },
    { kind: 'parking', s0: 34, t0: -26, s1: 70, t1: -19, note: '员工停车带：12 位（南边界一列，与厂房隔 2 m）' },
    { kind: 'forecourt', s0: 18, t0: -20, s1: 34, t1: -16, note: '访客前场：办公入口前的落客与步行铺装' },
    { kind: 'green', s0: 88, t0: -14, s1: 132, t1: 18, note: '东端隔离绿带：楔形尾不可建' },
    { kind: 'buffer', s0: 42, t0: -18, s1: 86, t1: -14, note: '厂房南侧缓冲带（设备/管廊/绿化）' },
  ],
  gates: [
    { s: 52, t: 24, kind: 'freight', note: '北侧货运入口（8 m，货车专用）' },
    { s: 14, t: -24, kind: 'vehicle', note: '西侧员工入口（5.5 m）' },
  ],
};

/** 三个样板 */
export const TARGETS: TargetPlan[] = [R01, C01, I01];
