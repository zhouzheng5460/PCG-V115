// S1 · 三种布局骨架的构造
//
// 三种 typology 各自一套语法，但共用一条铁律：
//
//   ① 先问地块"你在这一进深上还剩多宽"（`crossSection` / `safeSpan`）
//   ② 再放**车道**（车道通到底，建筑让开）
//   ③ 然后按车道定出入口（门就在路上，构造保证）
//   ④ 最后把建筑按等深等宽的格子排进去，格子放不下就不放
//
// 与三个 archetype 的顺序对照：
//
//   旧：院子/店铺/仓库先落位 → 地面 → 停车 → **出入口最后算** → A* 补路
//   S1：车道与出入口先生成 → 建筑排进去 → 停车贴着车道 → 绿地收尾
//
// 每套布局都给 2 个方案（少数派备选），并由 `emit.ts` 负责落地。
// 真正"能不能用"由硬约束筛（几何合法 + 交通连通），不由这里判断。

import { Pt } from '../../../core/geom';
import { siteFrame, type SiteFrame } from '../archetypes/shared/frame';
import type { SiteContext } from '../core/types';
import { MF_INTENSITY } from '../typologies/multifamily';
import { RETAIL_INTENSITY } from '../typologies/retail';
import { INDUSTRIAL_INTENSITY } from '../typologies/industrial';
import { surfaceArea } from '../core/surface';
import {
  U,
  crossSection,
  inset,
  isEmpty,
  laneReach,
  rarea,
  rect,
  rd,
  rw,
  splitU,
  streetSpan,
  toLocalRing,
  type BuildingSpec,
  type LocalPt,
  type PatchSpec,
  type PlanSpec,
  type Rect,
} from './spec';

// ---------------------------------------------------------------- 公共参数

/** 车行主通道净宽（米）。7 m = 双车道 + 缘石余量，与 city 支路一致 */
const LANE_M = 7;
/** 车道边缘到建筑外墙的净距（米）。3 m 是一个人走不过去、但汽车开门够用的距离 */
const CLEAR_M = 3;
/** 建筑之间留的断口（米）——既是人行通道，也是消防间隔 */
const GAP_M = 8;


interface Ctx {
  ctx: SiteContext;
  f: SiteFrame;
  /** 红线环（局部） */
  ring: LocalPt[];
  /** 可建区环（局部） */
  bring: LocalPt[];
  /** 临街可用 u 跨度（红线口径） */
  front: [number, number];
  /** 地块面积（世界单位²） */
  lotA: number;
  laneW: number;
  clear: number;
  gap: number;
}

function prepare(ctx: SiteContext): Ctx | null {
  const f = siteFrame(ctx);
  if (!f) return null;
  const ring = toLocalRing(ctx.parcel.outer, f.origin, f.uDir, f.vDir);
  const bring = toLocalRing(ctx.buildableArea.outer, f.origin, f.uDir, f.vDir);
  // 临街宽度。两个坑都要躲：
  //   · **不能拿 f.W** —— 那是 bbox，MF 那块地的 bbox 面积是地块的 2.4 倍；
  //   · **不能在 v=0 上量** —— 红线的临街边常常是斜的（MF 从 (18,0) 斜到 (83,5)），
  //     一条扫描线只穿过两条边，量出来 ±18 m，而实际临街宽 112 m。
  //     错这一处，车道就摆在地块中间、建筑区只剩 20 m 宽 —— 整套候选直接判死。
  // 正确做法：在几个浅进深上各量一次，取**最宽**的那次（贴着街的那一段）。
  const front =
    streetSpan(ring, [U(1), U(2), U(3), U(4), U(6), U(8), U(10)]) ?? streetSpan(bring, [U(2), U(4)]);
  if (!front) return null;
  if (front[1] - front[0] < U(18)) return null;
  return {
    ctx,
    f,
    ring,
    bring,
    front,
    lotA: surfaceArea(ctx.parcel),
    laneW: U(LANE_M),
    clear: U(CLEAR_M),
    gap: U(GAP_M),
  };
}

/** 临街线上的一个点（世界坐标）。车道中心用它当出入口 —— 门必然在路上 */
function gateAt(c: Ctx, u: number): Pt {
  const span = c.front;
  const uu = Math.max(span[0] + U(1), Math.min(span[1] - U(1), u));
  return c.f.at(uu, 0);
}

/** 朝向地块外的法线：车道是从街上进来的，所以法线就是 +v 的反方向 */
function outward(c: Ctx): Pt {
  return new Pt(-c.f.vDir.x, -c.f.vDir.y);
}

/**
 * 把一条车道矩形补成"从红线开始"：
 * 起点外扩 1 m 落到红线外侧，保证落地面一定压到红线，
 * 不会出现"路停在退线带里、离街还有 8 m"。
 */
function fromStreet(r: Rect): Rect {
  return rect(r.u0, r.u1, Math.min(r.v0, -U(1)), r.v1);
}


/** 某进深上"还能用"的 u 跨度：期望区间 ∩ 实际横截面，再各留 margin */
function spanAt(
  ring: LocalPt[],
  v: number,
  want: [number, number],
  margin: number
): [number, number] | null {
  const s = crossSection(ring, v);
  if (!s) return null;
  const lo = Math.max(want[0], s[0]) + margin;
  const hi = Math.min(want[1], s[1]) - margin;
  return hi > lo ? [lo, hi] : null;
}

/**
 * 车道该摆在哪个 u：**整段进深都还放得下**的最左侧。
 *
 * 不能一律贴 `front[0]`：red line 的侧边是斜的（retail 的左边界从 -86 m
 * 一路斜到 -77 m，深 86 m），贴左的车道走 30 m 就出红线了。
 * 反过来也不能用全程 `safeSpan` —— 地块收到尾端只剩几米，全程求交会把
 * 整条车道判死。所以按"车道需要通到多深"（`vNeed`）来求这个左界。
 */
function laneSpanFor(
  ring: LocalPt[],
  front: [number, number],
  vNeed: number,
  laneW: number,
  margin: number
): [number, number] {
  let lo = front[0] + margin;
  const vStart = U(2);
  const n = 16;
  for (let i = 0; i <= n; i++) {
    const v = vStart + ((vNeed - vStart) * i) / n;
    const s = crossSection(ring, v);
    if (s) lo = Math.max(lo, s[0] + margin);
  }
  return [lo, lo + laneW];
}

/** 一段进深两端横截面的交集：整块矩形都能落在里面 */
function tightSpan(
  ring: LocalPt[],
  v0: number,
  v1: number,
  want: [number, number],
  margin: number
): [number, number] | null {
  const a = spanAt(ring, v0 + (v1 - v0) * 0.08, want, margin);
  const b = spanAt(ring, v1 - (v1 - v0) * 0.08, want, margin);
  if (!a || !b) return a ?? b;
  const lo = Math.max(a[0], b[0]);
  const hi = Math.min(a[1], b[1]);
  return hi > lo ? [lo, hi] : null;
}

/**
 * 从车道接一条支路到**服务临街面**，并在那条边上开货车口。
 *
 * 为什么必须这么做：工业的 `serviceSeparation` 判据是
 * `carAcc.frontage === truckAcc.frontage` —— 两个口都开在主街上，
 * 无论相距多远都只能拿 0.45；同一点则是 0.25 外加 accessConflictPenalty = 1。
 * 这块地的西侧本来就贴着一条 local 路（98 m），货车从那条路进场是**更正确**的做法，
 * 不是为了分数临时改口径。
 */
function serviceStub(
  c: Ctx,
  laneU0: number,
  laneU1: number,
  laneW: number,
  vMin: number,
  vMax: number
): { rect: Rect; gate: Pt; normal: Pt } | null {
  const svc = c.ctx.serviceFrontage;
  if (!svc || svc === c.ctx.primaryFrontage) return null;
  const [a, b] = svc.parcelEdge;
  const um = (a.x - c.f.origin.x) * c.f.uDir.x + (a.y - c.f.origin.y) * c.f.uDir.y;
  const um2 = (b.x - c.f.origin.x) * c.f.uDir.x + (b.y - c.f.origin.y) * c.f.uDir.y;
  const vm = (a.x - c.f.origin.x) * c.f.vDir.x + (a.y - c.f.origin.y) * c.f.vDir.y;
  const vm2 = (b.x - c.f.origin.x) * c.f.vDir.x + (b.y - c.f.origin.y) * c.f.vDir.y;
  const uEdge = (um + um2) / 2;
  if (uEdge > laneU0) return null; // 服务面在车道的另一侧，接不上
  const v = Math.max(vMin, Math.min(vMax, (vm + vm2) / 2));
  // 支路**止于车道的左缘**（laneU0），不是穿进车道：两段铺装首尾相接，
  // 但数据上不重叠（穿进去实测叠 81 m²，正好是 9×9 的交叉口）
  const rect0 = rect(uEdge - U(0.5), laneU0, v - laneW / 2, v + laneW / 2);
  const gate = c.f.at(uEdge, v);
  const cen = centroidOf(c.ctx.parcel.outer);
  const n = new Pt(gate.x - cen.x, gate.y - cen.y);
  const len = Math.hypot(n.x, n.y) || 1;
  return { rect: rect0, gate, normal: new Pt(n.x / len, n.y / len) };
}

/** 环的质心 */
function centroidOf(ring: readonly { x: number; y: number }[]): Pt {
  let x = 0;
  let y = 0;
  for (const q of ring) {
    x += q.x;
    y += q.y;
  }
  return new Pt(x / Math.max(1, ring.length), y / Math.max(1, ring.length));
}

/**
 * Placemaker 的停车区下限（**实测**，不是抄来的魔数）。
 *
 * 同一套车位尺寸（2.52 × 5.04 m，车道 6.3 m）下的实测边界：
 *   396 m²（18×22）→ 0 位　432 m²（24×18）→ 4 位　440 m²（20×22）→ 11 位
 *   560 m²（14×40）→ 12 位　330 m²（15×22）→ 0 位
 * 也就是**面积 ≥ ~432 且短边 ≥ ~17 m** 才排得出；面积够但太窄（14×40 除外，
 * 它是长条可以顺着排）也会归零。
 *
 * 这两个数决定"S1 该给停车预留多少"：不是"剩余多少给多少"，
 * 而是**先按这个下限要地**，不够再退化成单排/legacy。
 */
const PM_MIN_AREA_M2 = 440;
const PM_MIN_SIDE_M = 17;
/** 单排兜底：进深 11.3 m（5.04 + 6.3），长度够 6 个位 */
const PM_SINGLE_SIDE_M = 12;
const PM_SINGLE_AREA_M2 = 220;

/**
 * 主动为停车预留一条带（不是"剩余空间"）。
 *
 * 三步：
 *   ① 从车道尽端往回退，量这一段的真实可用宽度；
 *   ② 按 `areaTarget` 反推进深（宽 × 深），进深限制在 [minSide, maxDepth]；
 *   ③ 双面排（≥440 m² / 短边 ≥17 m）优先，退不出就退单排，再不行返回最大可用块
 *      —— **返回小块也要返回**，因为 legacy 求解器在小块上仍然可用，
 *      而调用方需要知道"这里确实有停车，只是 Placemaker 排不下"。
 */
function parkingBand(
  ring: LocalPt[],
  uFrom: number,
  areaTargetM2: number,
  fromV: number,
  opt: { maxDepthM?: number; minSideM?: number } = {}
): Rect | null {
  const maxDepth = U(opt.maxDepthM ?? 30);
  let best: Rect | null = null;
  let bestArea = 0;

  for (let k = 0; k < 14; k++) {
    const v1 = fromV - k * U(4);
    for (const target of [PM_MIN_AREA_M2, Math.max(PM_SINGLE_AREA_M2, areaTargetM2 * 0.6)]) {
      const step = U(2);
      for (let d = maxDepth; d >= U(PM_SINGLE_SIDE_M); d -= step) {
        const v0 = v1 - d;
        const sMid = crossSection(ring, (v0 + v1) / 2);
        const sTop = crossSection(ring, v0 + U(1));
        if (!sMid || !sTop) continue;
        const hi = Math.min(sMid[1], sTop[1]) - U(1);
        const wAvail = hi - uFrom;
        if (wAvail <= 0) continue;
        const areaM2 = wAvail * 7 * d * 7;
        if (wAvail * 7 < (opt.minSideM ?? PM_MIN_SIDE_M)) continue;
        if (areaM2 < target) continue;
        return rect(uFrom, uFrom + Math.min(wAvail, U(areaTargetM2 / Math.max(1, d * 7))), v0, v1);
      }
    }
    // 记下"最大可用块"，作为兜底
    const s = crossSection(ring, v1 - U(11));
    if (s) {
      const hi = Math.min(s[1] - U(1), uFrom + U(60));
      const w = hi - uFrom;
      if (w > 0) {
        const a = w * 7 * 22;
        if (a > bestArea) {
          bestArea = a;
          best = rect(uFrom, hi, v1 - U(22), v1);
        }
      }
    }
  }
  return best;
}

/**
 * 沿着车道找一块"右侧还能让出 `minW` 宽"的停车带。
 *
 * 不能一律放在车道尽头：MF 那块地是斜带，到 220 m 深时右边界只剩 0 m，
 * 停车会被裁成一条 20 m² 的缝（实测 292 m²，需求 1300 m²）。
 * 所以从尽端往回退，退到还有地方为止 —— 这是"地块形状适配"在停车上的体现。
 */
function parkAlong(
  ring: LocalPt[],
  laneU1: number,
  wantW: number,
  depth: number,
  fromV: number,
  minW: number
): Rect | null {
  for (let k = 0; k < 14; k++) {
    const v1 = fromV - k * U(10);
    const v0 = v1 - depth;
    const s = crossSection(ring, (v0 + v1) / 2);
    if (!s) continue;
    const hi = Math.min(s[1] - U(1), laneU1 + wantW);
    if (hi - laneU1 >= minW) return rect(laneU1, hi, v0, v1);
  }
  return null;
}

// ---------------------------------------------------------------- 多户住宅

/**
 * 住宅：**围合组团 + 侧向主通道 + 端头停车 + 后侧连续绿带**。
 *
 * 组团用"车道右侧的格子"排：每格 = 4 条 bar 围一个院子（与 `courtyard.ts`
 * 的语法相同，但格子的位置由车道和临街宽度决定，不由 bbox 决定）。
 * 原有的 `buildMultiGroup` 是按 bbox 切 N×M —— MF 那块地 bbox 192×239
 * 而实际只有 111 m 宽，于是 3 列里有两列落在红线外，被切成碎片。
 */
function mfSkeletons(c: Ctx): PlanSpec[] {
  const { f, front } = c;
  const out: PlanSpec[] = [];
  const laneW = U(LANE_M + 2); // 住宅内部路给 9 m：要容错车 + 垃圾车
  const laneU0 = front[0] + U(1.5);
  const laneU1 = laneU0 + laneW;

  // 车道能通到多深：取"这段 u 始终还在红线内"的最深处
  const laneEnd = laneReach(c.ring, [laneU0, laneU1], f.v0, f.v1 - U(4), 0);
  if (laneEnd - f.v0 < U(70)) return [];
  const lane = fromStreet(rect(laneU0, laneU1, f.v0, laneEnd));

  // 尽端停车：贴着车道右缘，兼回车场。住宅的地面停车只做**访客**这一小块 ——
  // 20000 m² 的地块按 1.2 车位/户要 600 个位，地面根本放不下，只能进地库。
  // 停车用地**主动预留**，不是"剩多少给多少"。
  //
  // 需求口径：访客/地面停车按地块 3%（住宅其余进地库），但**不得低于 Placemaker
  // 双面排的下限 440 m²** —— 低于它不是"少排几个位"，是整套求解直接归零（实测）。
  // 上层若真的让不出这么宽，`parkingBand` 会退单排、再退回最大可用块，
  // 由 Realizer 用 legacy 求解器兜住。
  const lotM2 = c.lotA * 49;
  const parkNeedM2 = Math.max(PM_MIN_AREA_M2, Math.min(lotM2 * 0.03, 900));
  const parkRect =
    parkingBand(c.ring, laneU1, parkNeedM2, laneEnd - U(2)) ??
    parkAlong(c.ring, laneU1, U(parkNeedM2 / 18), U(18), laneEnd, U(12));
  if (!parkRect) return [];

  const bU0 = laneU1 + c.clear;
  const bU1 = front[1] - U(2);
  const bV0 = f.v0 + U(5);
  const bV1 = parkRect.v0 - c.clear;
  if (bU1 - bU0 < U(30) || bV1 - bV0 < U(30)) return [];

  out.push(mfCourtGrid(c, { lane, laneW, parkRect, bU0, bU1, bV0, bV1 }));
  out.push(mfRowBars(c, { lane, laneW, parkRect, bU0, bU1, bV0, bV1 }));
  return out.filter((s) => s.buildings.length >= 3);
}

/**
 * 围合格子：每格 4 条 bar 围一个院子。
 * 格子数由**临街宽度**与**进深**算，不用 bbox。
 */
function mfCourtGrid(
  c: Ctx,
  p: { lane: Rect; parkRect: Rect; bU0: number; bU1: number; bV0: number; bV1: number; laneW: number }
): PlanSpec {
  const regionW = p.bU1 - p.bU0;
  const regionD = p.bV1 - p.bV0;
  const bd = U(13); // bar 进深
  const courtMinD = U(26);
  const courtMinW = U(26);
  const pitchV = bd * 2 + courtMinD + c.gap;

  const capA = MF_INTENSITY.preferredMax * c.lotA;
  const buildings: BuildingSpec[] = [];
  const courtyards: PatchSpec[] = [];
  const walks: PatchSpec[] = [];
  const forecourts: PatchSpec[] = [];
  const greens: PatchSpec[] = [];
  let accA = 0;

  const maxRows = Math.max(1, Math.floor((regionD + c.gap) / pitchV));
  for (let row = 0; row < maxRows; row++) {
    if (accA > capA) break;
    const v0 = p.bV0 + row * pitchV;
    const v1 = v0 + bd * 2 + courtMinD;
    if (v1 > p.bV1 + 1e-6) break;

    // **先量这一排有多宽，再切列。** 用中段进深量一次（不是逐格量）：
    // 同一排的楼才共用一条基线，读起来才是"排"，不是参差的碎块。
    const span = spanAt(c.bring, (v0 + v1) / 2, [p.bU0, p.bU1], U(1.5));
    if (!span || span[1] - span[0] < U(50)) break;

    const cols = Math.max(1, Math.min(3, Math.round(((span[1] - span[0]) * 7) / 90)));
    const colW = (span[1] - span[0] - (cols - 1) * c.gap) / cols;
    for (let col = 0; col < cols; col++) {
      const u0 = span[0] + col * (colW + c.gap);
      if (accA + colW * (v1 - v0) * 0.7 > capA * 1.15) break;
      const block = rect(u0, u0 + colW, v0, v1);
      const g = mfBlock(c, block, bd, row === 0 && col === 0 ? '主街界面' : `第 ${row + 1} 排`);
      if (!g) continue;

      buildings.push(...g.buildings);
      courtyards.push({ r: g.court, note: '围合院子' });
      walks.push(...g.walks.map((w) => ({ r: w, note: '院内主步道 5 m' })));
      if (row === 0 && col === 0) forecourts.push({ r: g.fore, note: '入口前场（门洞内）' });
      accA += g.buildings.reduce((a, b) => a + rarea(b.r), 0);
    }
    // 排与排之间的 8 m 断口是连续绿带（不是残地）
    if (row + 1 < maxRows) {
      const gapSpan = spanAt(c.bring, v1 + c.gap / 2, [p.bU0, p.bU1], 0);
      if (gapSpan && gapSpan[1] - gapSpan[0] > U(20)) {
        greens.push({ r: rect(gapSpan[0], gapSpan[1], v1, v1 + c.gap), note: '排间绿带 8 m' });
      }
    }
  }

  const gateU = (p.bU0 + p.bU1) / 2;
  return {
    id: 'sk-mf-court',
    patternId: 'mf_perimeter_court',
    label: 'S1 住宅 · 侧向主通道 + 围合组团',
    topology: 'spine-side',
    intent: [
      '车行主通道沿西侧通到底，尽端停车兼回车场',
      '围合组团按临街宽度排布，每格四条 bar 围一个院子',
      '组团之间留 8 m 断口作人行与消防间距',
      '后侧与尾部收成连续绿带，尖角不塞建筑',
    ],
    lanes: [p.lane],
    laneWM: p.laneW * 7,
    buildings,
    parking: [{ r: p.parkRect, note: '尽端停车（贴车道，兼回车）' }],
    forecourt: forecourts,
    courtyard: courtyards,
    walk: walks,
    service: [],
    green: greens,
    gates: [
      { kind: 'pedestrian', at: gateAt(c, gateU), normal: outward(c) },
      { kind: 'vehicle', at: gateAt(c, (p.lane.u0 + p.lane.u1) / 2), normal: outward(c) },
    ],
    parkingRole: 'resident',
    clearanceM: CLEAR_M,
  };
}

/** 一个围合组团：4 条 bar + 院子 + 一条 5 m 主步道 */
function mfBlock(
  c: Ctx,
  block: Rect,
  bd: number,
  note: string
): { buildings: BuildingSpec[]; court: Rect; walks: Rect[]; fore: Rect } | null {
  const court = inset(block, bd);
  if (isEmpty(court) || rw(court) < U(18) || rd(court) < U(20)) return null;
  const cu = (court.u0 + court.u1) / 2;
  const walk = rect(cu - U(2.5), cu + U(2.5), court.v0, court.v1);

  const bars: { r: Rect; hM: number; role: BuildingSpec['role']; note: string; front: BuildingSpec['front'] }[] = [
    { r: rect(block.u0, block.u1, block.v0, court.v0), hM: 21, role: 'house', note: `临街 bar（${note}）`, front: 'v-' },
    { r: rect(block.u0, block.u1, court.v1, block.v1), hM: 15, role: 'house', note: '后侧 bar', front: 'v+' },
    { r: rect(block.u0, court.u0, court.v0, court.v1), hM: 18, role: 'house', note: '西侧 bar', front: 'u+' },
    { r: rect(court.u1, block.u1, court.v0, court.v1), hM: 18, role: 'house', note: '东侧 bar', front: 'u-' },
  ];

  // 临街 bar 中间开 12 m 门洞：院子要能从街上进去，而门洞正好是前场的落点
  const gateHalf = U(6);
  const buildings: BuildingSpec[] = [];
  for (const b of bars) {
    if (b.note.startsWith('临街')) {
      const left = rect(b.r.u0, cu - gateHalf, b.r.v0, b.r.v1);
      const right = rect(cu + gateHalf, b.r.u1, b.r.v0, b.r.v1);
      for (const half of [left, right]) {
        if (rw(half) < U(7)) continue;
        buildings.push({ r: half, hM: b.hM, role: b.role, note: `${b.note}（中留 12 m 门洞）`, front: b.front });
      }
    } else {
      if (rw(b.r) < U(7) || rd(b.r) < U(7)) continue;
      buildings.push({ r: b.r, hM: b.hM, role: b.role, note: b.note, front: b.front });
    }
  }
  const fore = rect(cu - gateHalf, cu + gateHalf, block.v0 - U(5), court.v0);
  return { buildings, court, walks: [walk], fore };
}

/**
 * 简化备选：两排平行板楼 + 中轴绿廊。给斜边 / 锥形地块兜底 ——
 * 复杂候选放不下时**降级**，而不是让 A* 去补路。
 */
function mfRowBars(
  c: Ctx,
  p: { lane: Rect; parkRect: Rect; bU0: number; bU1: number; bV0: number; bV1: number; laneW: number }
): PlanSpec {
  const bd = U(14);
  const pitch = bd * 2 + U(26);
  const maxRows = Math.max(1, Math.floor((p.bV1 - p.bV0 + c.gap) / (pitch + c.gap)));
  const buildings: BuildingSpec[] = [];
  const greens: PatchSpec[] = [];
  const capA = MF_INTENSITY.preferredMax * c.lotA;
  let accA = 0;

  for (let row = 0; row < maxRows; row++) {
    if (accA > capA) break;
    const v0 = p.bV0 + row * (pitch + c.gap);
    // 每一排先问"这一进深上还剩多宽"，再按答案放 —— 收窄是台阶，不是楔形
    const span = spanAt(c.bring, (v0 + v0 + pitch) / 2, [p.bU0, p.bU1], U(1.5));
    if (!span || span[1] - span[0] < U(32)) break;
    const rowRect = rect(span[0], span[1], v0, v0 + pitch);
    // 两段板楼夹一条中轴绿廊
    const bars = [rect(rowRect.u0, rowRect.u1, v0, v0 + bd), rect(rowRect.u0, rowRect.u1, v0 + pitch - bd, v0 + pitch)];
    // 板楼按 26~34 m 断开，形成沿街节奏（不是一条通长的墙）
    for (const bar of bars) {
      const n = Math.max(1, Math.round(rw(bar) / U(30)));
      const parts = splitU(bar, n, c.gap * 0.5);
      for (const part of parts) {
        if (rw(part) < U(12)) continue;
        buildings.push({ r: part, hM: 18, role: 'house', note: `板楼（${n} 段）`, front: 'v-' });
        accA += rarea(part);
      }
    }
    greens.push({ r: rect(rowRect.u0, rowRect.u1, v0 + bd + U(2), v0 + pitch - bd - U(2)), note: '楼间绿廊' });
  }

  const gateU = (p.bU0 + p.bU1) / 2;
  return {
    id: 'sk-mf-rows',
    patternId: 'mf_internal_garden',
    label: 'S1 住宅 · 平行板楼 + 中轴绿廊（简化）',
    topology: 'rows',
    intent: [
      '每排先量可建宽度再放板楼，锥形地块收成台阶',
      '两排板楼夹一条连续绿廊，绿地不被切碎',
      '车道仍在西侧，不与建筑争地',
    ],
    lanes: [p.lane],
    laneWM: p.laneW * 7,
    buildings,
    parking: [{ r: p.parkRect, note: '尽端停车' }],
    forecourt: [{ r: rect(gateU - U(6), gateU + U(6), c.f.v0, c.f.v0 + U(6)), note: '入口前场' }],
    courtyard: [],
    walk: [],
    service: [],
    green: [{ r: rect(p.bU0, p.bU1, p.parkRect.v1 + U(3), c.f.v1), note: '后侧连续绿带' }, ...greens],
    gates: [
      { kind: 'pedestrian', at: gateAt(c, gateU), normal: outward(c) },
      { kind: 'vehicle', at: gateAt(c, (p.lane.u0 + p.lane.u1) / 2), normal: outward(c) },
    ],
    parkingRole: 'resident',
    clearanceM: CLEAR_M,
  };
}

// ---------------------------------------------------------------- 商业

/**
 * 商业：**临街店面 + 入口前场 + 共享停车通道 + 独立后勤**。
 *
 * 两个方案只差"停车在前还是在后"——这是 strip 唯一真实的设计选择
 *（`strip.ts` 的注释里也是这么写的）。
 */
function retailSkeletons(c: Ctx): PlanSpec[] {
  const { f, front } = c;
  const out: PlanSpec[] = [];
  const laneW = c.laneW;
  const shopD = U(22);
  const foreD = U(7);
  const svcD = U(7);
  // 车道要通到"后勤通道"为止：店前带 + 店面 + 停车 + 后勤
  const vNeed = foreD + shopD + c.clear + U(26) + svcD;
  const [laneU0, laneU1] = laneSpanFor(c.ring, front, vNeed, laneW, U(2));
  const laneEnd = laneReach(c.ring, [laneU0, laneU1], f.v0, f.v1 - U(3), 0);
  if (laneEnd < vNeed) return [];
  const lane = fromStreet(rect(laneU0, laneU1, f.v0, laneEnd));

  const uL = laneU1 + c.clear;
  const uR = front[1] - U(2);
  if (uR - uL < U(40)) return [];
  const lotM2 = c.lotA * 49;
  const parkNeedM2 = lotM2 * RETAIL_INTENSITY.preferredMin * 1.2;

  // ---- 方案 1：店面贴街、停车在后（街道界面连续，优先）
  {
    const vShop0 = f.v0 + foreD;
    const vShop1 = vShop0 + shopD;
    const vSvc0 = Math.min(f.v1 - svcD, laneEnd - U(4));
    // 停车**紧跟店面之后**（留 3 m），进深按需求定 —— 不是"剩余纵深全给停车"。
    // 早先按剩余算，店后 25 m 的空地既没铺装也没人走，被 residual 认领成绿地，
    // 读数上"绿地 24%"，视觉上是一条荒地夹在店面与停车场中间。
    const parkD = Math.min(
      U(Math.max(18, parkNeedM2 / Math.max(20, (uR - uL) * 7))),
      Math.max(U(16), vSvc0 - c.clear - (vShop1 + c.clear))
    );
    const vPark0 = vShop1 + c.clear;
    const vPark1 = Math.min(vPark0 + parkD, vSvc0 - c.clear);
    if (vPark1 - vPark0 > U(14) && vSvc0 > vPark1) {
      const shops = splitU(rect(uL, uR, vShop0, vShop1), Math.max(1, Math.round((uR - uL) / U(24))), U(2));
      out.push({
        id: 'sk-ret-rear-park',
    patternId: 'retail_frontage_rear_park',
        label: 'S1 商业 · 店面贴街 + 后侧共享停车',
        topology: 'spine-side',
        intent: [
          '店面直接压街，商业界面连续（停车不占临街）',
          '一条 7 m 车道从西侧贯穿到底，串起停车与后勤',
          '停车带贴车道，前端是入口前场',
          '店前 7 m 人行带贯到两端，顾客从车前走到店门',
        ],
        lanes: [lane],
        laneWM: laneW * 7,
        buildings: shops
          .filter((s) => rw(s) >= U(10))
          .map((s, i) => ({
            r: s,
            hM: i === 0 || i === shops.length - 1 ? 9 : 7,
            role: 'podium' as const,
            note: `沿街店面 ${i + 1}/${shops.length}（面宽 ${(rw(s) * 7).toFixed(0)} m）`,
            front: 'v-' as const,
          })),
        parking: [{ r: rect(laneU1, uR, vPark0, vPark1), note: '后侧共享停车（贴车道）' }],
        forecourt: [{ r: rect(uL, uR, f.v0, vShop0), note: '店前人行带 7 m' }],
        courtyard: [],
        walk: [],
        service: [{ r: rect(laneU1, uR, vSvc0, f.v1), note: '后侧后勤通道' }],
        green: [],
        gates: [
          { kind: 'pedestrian', at: gateAt(c, (uL + uR) / 2), normal: outward(c) },
          { kind: 'vehicle', at: gateAt(c, (lane.u0 + lane.u1) / 2), normal: outward(c) },
        ],
        parkingRole: 'visitor',
        clearanceM: CLEAR_M,
      });
    }
  }

  // ---- 方案 2：停车临街（strip 的经典剖面），店面后退
  {
    const parkD = U(Math.max(18, parkNeedM2 / Math.max(20, (uR - uL) * 7)));
    const vPark0 = f.v0 + U(1);
    const vPark1 = vPark0 + parkD;
    const vFore0 = vPark1 + c.clear;
    const vShop0 = vFore0 + foreD;
    const vShop1 = vShop0 + shopD;
    if (vShop1 < f.v1 - U(4)) {
      const shops = splitU(rect(uL, uR, vShop0, vShop1), Math.max(1, Math.round((uR - uL) / U(26))), U(2));
      out.push({
        id: 'sk-ret-front-park',
    patternId: 'retail_anchor_parking_court',
        label: 'S1 商业 · 临街停车 + 店面后退',
        topology: 'spine-side',
        intent: [
          '顾客先停车再进店（strip 的经典剖面）',
          '车道在西侧贯穿，停车与后勤共用一条入场路',
          '店面后退 26 m，中间 7 m 人行带过渡',
        ],
        lanes: [lane],
        laneWM: laneW * 7,
        buildings: shops
          .filter((s) => rw(s) >= U(10))
          .map((s, i) => ({
            r: s,
            hM: i === 0 || i === shops.length - 1 ? 9 : 7,
            role: 'podium' as const,
            note: `沿街店面 ${i + 1}/${shops.length}`,
            front: 'v-' as const,
          })),
        parking: [{ r: rect(laneU1, uR, vPark0, vPark1), note: '临街停车（贴车道）' }],
        forecourt: [{ r: rect(uL, uR, vFore0, vShop0), note: '店前人行带 7 m' }],
        courtyard: [],
        walk: [],
        service: [{ r: rect(laneU1, uR, Math.min(f.v1 - U(6), laneEnd - U(4)), f.v1), note: '后侧后勤通道' }],
        green: [],
        gates: [
          { kind: 'pedestrian', at: gateAt(c, (uL + uR) / 2), normal: outward(c) },
          { kind: 'vehicle', at: gateAt(c, (lane.u0 + lane.u1) / 2), normal: outward(c) },
        ],
        parkingRole: 'visitor',
        clearanceM: CLEAR_M,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- 工业

/**
 * 工业：**前场办公 + 厂房仓库 + 装卸场地 + 主货运通道 + 边界绿化**。
 *
 * 工业的命门是"货能进、能掉头、能装卸"。所以车道先定，厂房让在它东侧，
 * 货场在厂房之后，尾端收成绿化 —— 锥形地块的尖角绝对不塞厂房。
 */
function industrialSkeletons(c: Ctx): PlanSpec[] {
  const { f, front } = c;
  const out: PlanSpec[] = [];
  const laneW = U(9); // 货运通道 9 m（双车道 + 转弯余量）
  // 车道要通到"货场"为止：前场 + 厂房 + 装卸 + 货场
  const vNeed = U(14 + 42 + 9 + 20);
  const [laneU0, laneU1] = laneSpanFor(c.ring, front, vNeed, laneW, U(2));
  const laneEnd = laneReach(c.ring, [laneU0, laneU1], f.v0, f.v1 - U(4), 0);
  if (laneEnd < vNeed) return [];
  const lane = fromStreet(rect(laneU0, laneU1, f.v0, laneEnd));

  const uWh0 = laneU1 + c.clear;
  const uWh1 = front[1] - U(2);
  const lotM2 = c.lotA * 49;

  // ---- 方案 1：前场 → 厂房 → 装卸坪 → 货场 → 尾绿
  {
    // 从后往前切：货场贴车道尽头 → 装卸坪 → 厂房 → 前场
    const courtD = U(20);
    const apronD = U(9);
    const vCourt1 = laneEnd;
    const vCourt0 = vCourt1 - courtD;
    const vAp1 = vCourt0;
    const vAp0 = vAp1 - apronD;
    const vWh1 = vAp0;
    // **员工停车主动预留**：宽度取 Placemaker 双面排的最小短边 17 m，
    // 进深按 440 m² 反推（≈26 m），所以前场需要 ~31 m。
    // 早先是"前场 ≥14 m 就行"，于是停车只剩 ~10 m 深、221 m² ——
    // 低于 432 m² 时 Placemaker 一个车位都不出，只能整块退回 legacy。
    const parkWM = Math.min(PM_MIN_SIDE_M, Math.max(12, (uWh1 - laneU1) * 7));
    const parkDM = Math.min(30, Math.max(18, PM_MIN_AREA_M2 / parkWM));
    let whD = Math.min(U(42), vAp0 - f.v0 - U(parkDM + 5));
    let frontD = U(parkDM + 5);
    if (whD < U(24)) {
      // 场地不够深：先保厂房 24 m，再缩前场（停车退成单排/legacy，不硬撑）
      whD = U(24);
      frontD = Math.max(U(14), vAp0 - f.v0 - whD);
    }
    const vWh0 = vAp0 - whD;
    if (vWh0 - f.v0 < U(10)) return out;

    // 厂房在它那段进深里必须真的放得下：按最窄处收窄（阶梯退台）
    const whSpan = tightSpan(c.bring, vWh0, vWh1, [uWh0, uWh1], U(1));
    if (whSpan && whSpan[1] - whSpan[0] >= U(18)) {
      const wh = rect(whSpan[0], whSpan[1], vWh0, vWh1);
      const greens: PatchSpec[] = [];
      if (vCourt1 < f.v1 - U(2)) {
        greens.push({ r: rect(front[0] + U(1), front[1] - U(1), vCourt1, f.v1), note: '尾端绿化（锥形残地）' });
      }
      out.push({
        id: 'sk-ind-rear-yard',
    patternId: 'ind_mixed_yard',
        label: 'S1 工业 · 前场 + 厂房 + 装卸 + 货场',
        topology: 'spine-side',
        intent: [
          '9 m 货运通道沿西侧从街上直进货场，不穿厂房',
          '厂房按那段进深的真实可建宽度收窄（阶梯，不削楔形）',
          '装卸坪贴着厂房背面，货场接在装卸之后',
          '锥形尾端整块收成绿化，不塞建筑',
        ],
        lanes: [lane],
        laneWM: laneW * 7,
        buildings: [
          { r: wh, hM: 9, role: 'warehouse' as const, note: `厂房 ${(rw(wh) * 7).toFixed(0)}×${(rd(wh) * 7).toFixed(0)} m`, front: 'v-' as const },
        ],
        parking: [
          {
            r: rect(
              laneU1,
              Math.min(laneU1 + U(parkWM), whSpan[1]),
              f.v0 + U(4),
              Math.min(f.v0 + U(4 + parkDM), vWh0 - U(2))
            ),
            note: `员工停车 ${parkWM.toFixed(0)}×${parkDM.toFixed(0)} m（贴车道，主动预留）`,
          },
        ],
        forecourt: [{ r: rect(front[0] + U(1), whSpan[1], f.v0, f.v0 + U(4)), note: '办公前场' }],
        courtyard: [],
        walk: [],
        service: [
          { r: rect(whSpan[0], whSpan[1], vAp0, vAp1), note: '装卸坪' },
          { r: rect(laneU1, front[1] - U(1), vCourt0, vCourt1), note: '货场（掉头/排队）' },
        ],
        green: greens,
        gates: [
          { kind: 'pedestrian', at: gateAt(c, (uWh0 + uWh1) / 2), normal: outward(c) },
          { kind: 'vehicle', at: gateAt(c, (lane.u0 + lane.u1) / 2), normal: outward(c) },
          { kind: 'truck', at: gateAt(c, (lane.u0 + lane.u1) / 2), normal: outward(c) },
        ],
        parkingRole: 'employee',
        clearanceM: CLEAR_M,
      });
    }
  }

  // ---- 方案 2：厂房横跨前部、货场在后（宽地块更合适）
  {
    // 前场 20 m：西端办公、东端员工停车，都贴着货运通道。
    //
    // S2.5 为了把 parking 抬过 Placemaker 的 432 m² 门槛，曾把前场加深到 30 m、
    // 把办公挪成厂房副楼 —— 代价是厂房进深被压掉 10 m，覆盖率掉到 5%，
    // 而工业用地的主功能是**厂房 + 装卸**，不是停车。S2.6 撤回那次改动：
    // 停车区回到 ~220 m²，Placemaker 排不下就按闸门走 legacy（这是合法的回退）。
    const frontD = U(20);
    const whD = Math.min(U(38), Math.max(U(24), (laneEnd - f.v0) * 0.45));
    const vWh0 = f.v0 + frontD;
    const vWh1 = vWh0 + whD;
    const whSpan = tightSpan(c.bring, vWh0, vWh1, [uWh0, uWh1], U(1));
    if (whSpan && whSpan[1] - whSpan[0] >= U(20) && vWh1 < laneEnd - U(16)) {
      const wh = rect(whSpan[0], whSpan[1], vWh0, vWh1);
      const apron1 = vWh1 + U(8);
      const court1 = laneEnd;
      const officeW = Math.min(U(10), Math.max(U(8), (whSpan[1] - whSpan[0]) * 0.4));
      const office = rect(whSpan[1] - officeW, whSpan[1], f.v0 + U(3), f.v0 + U(17));
      // 员工车从**东侧单独一个口**进停车 —— 客货在街上就分开，
      // 而不是共用西侧的货运车道（那会让 serviceSeparation 判成混行）
      const spurW = laneW;
      const spurU0 = Math.min(whSpan[1] - spurW - U(1), office.u1 + U(9));
      const spur = spurU0 > office.u1 ? fromStreet(rect(spurU0, spurU0 + spurW, f.v0, f.v0 + U(16))) : null;
      // 货车从**服务临街面**（西侧的 local 路）进场：这才是这块地真实的
      // 做法，也是工业诊断里 serviceSeparation 唯一能拿满的方式
      const stub = serviceStub(c, laneU0, laneU1, laneW, f.v0 + U(24), laneEnd - U(10));
      out.push({
        id: 'sk-ind-front-wh',
    patternId: 'ind_single_loaded',
        label: 'S1 工业 · 厂房靠前 + 深货场',
        topology: 'yard',
        intent: [
          '厂房尽量靠前贴街，把连续的大块纵深让给货场',
          '货运通道沿西侧直通货场，与厂房互不穿越',
          '前场 20 m：西端办公、东端员工停车，都贴着车道',
        ],
        lanes: [...(spur ? [spur] : []), lane, ...(stub ? [stub.rect] : [])],
        laneWM: laneW * 7,
        buildings: [
          { r: wh, hM: 9, role: 'warehouse' as const, note: `厂房 ${(rw(wh) * 7).toFixed(0)}×${(rd(wh) * 7).toFixed(0)} m`, front: 'v-' as const },
          { r: office, hM: 8, role: 'office' as const, note: `办公楼 ${(rw(office) * 7).toFixed(0)}×${(rd(office) * 7).toFixed(0)} m`, front: 'v-' as const },
        ],
        parking: [{ r: rect(laneU1, office.u0 - U(2), f.v0 + U(3), vWh0 - U(2)), note: '员工停车（前场，贴车道）' }],
        forecourt: [{ r: rect(front[0] + U(1), office.u0 - U(2), f.v0, f.v0 + U(3)), note: '办公前场' }],
        courtyard: [],
        walk: [],
        service: [
          { r: rect(whSpan[0], whSpan[1], vWh1, apron1), note: '装卸坪' },
          { r: rect(laneU1, front[1] - U(1), apron1, court1), note: '货场' },
        ],
        green: court1 < f.v1 - U(2) ? [{ r: rect(front[0] + U(1), front[1] - U(1), court1, f.v1), note: '尾端绿化' }] : [],
        gates: [
          { kind: 'pedestrian', at: gateAt(c, (office.u0 + office.u1) / 2), normal: outward(c) },
          // 员工车走主街上的东侧支路；货车走**服务临街面**（西侧 local 路）进场。
          // 客货在两条街上分开 —— 这块地本来就有两条临街面，没必要挤一个口。
          { kind: 'vehicle', at: gateAt(c, spur ? (spur.u0 + spur.u1) / 2 : (lane.u0 + lane.u1) / 2), normal: outward(c) },
          stub
            ? { kind: 'truck' as const, at: stub.gate, normal: stub.normal, frontage: 'service' as const }
            : { kind: 'truck' as const, at: gateAt(c, (lane.u0 + lane.u1) / 2), normal: outward(c) },
        ],
        parkingRole: 'employee',
        clearanceM: CLEAR_M,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- 入口

export function buildSkeletons(ctx: SiteContext): PlanSpec[] {
  const c = prepare(ctx);
  if (!c) return [];
  switch (ctx.typology) {
    case 'multi_family':
      return mfSkeletons(c);
    case 'retail':
      return retailSkeletons(c);
    case 'industrial':
      return industrialSkeletons(c);
    default:
      return [];
  }
}

export type { Rect };
export type { PatchSpec };
