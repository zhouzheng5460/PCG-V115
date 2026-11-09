// F3-B6 · 道路几何：一张完整路网面 → 街区 → 车行 / 路缘 / 人行 / 绿带 / 标线
//
// 唯一真值源是 `domain`（= `reserve`）：一张**已经带完整路口和圆角**的闭合
// 道路用地面。地块 = 场地 − 这张面；所有侧带是这张面按四级断面宽度
// （车行 / +路缘 / +人行 / +绿带）生成的同心闭合面两两求差。
//
// 不再有「逐路 sideBand 拼条带 → 同层 dedupe → 跨层相减 → 角上再补贴片」：
// 那套做法里每一层的边界都是自己算出来的，跟街区的闭合形状并不相等，
// 于是路口黑缝、绿十字、铺装堵路都是必然结果。现在每一层都读同一张面。

import { Pt } from '../core/geom';
import { bufferPolyline } from '../core/polyline';
import {
  bboxOf,
  distToSurfaceEdge,
  insideSurface,
  ringArea,
  selfIntersects,
  surfaceArea,
  surfaceIntersect,
  surfaceOffset,
  surfaceSubtract,
  surfaceUnion,
  type PlanSurface,
} from '../town/planning/core/surface';
import {
  M2,
  U,
  cleanRing,
  convexHull,
  rectRing,
  sampleAlong,
  shapeOf,
} from './geom';
import { filletConcave, filletConvex, removeHairpins, roundDomainAll, simplifyPolyline } from './rounding';
import type { PathGraph, RoadClass3, RoadPath, RoadSection, StylePreset } from './types';

import { buildJunctionManeuvers } from './lanes';
import {
  buildMarkings,
  MIN_CROSSING_GAP_M,
  MIN_CROSSING_WIDTH_M,
  type MarkKind,
  type MarkSeg,
} from './markings';

export type { MarkKind, MarkSeg };
/** 过街设施门槛与最小间距：实现在 markings.ts，这里重导出给测试与 UI 用 */
export { MIN_CROSSING_GAP_M, MIN_CROSSING_WIDTH_M };

export interface RoadGeom {
  carriage: PlanSurface[];
  junction: PlanSurface[];
  /** 兼容字段：圆角已属于 domain 自身，不再有独立的转角铺装层 */
  corner: PlanSurface[];
  curb: PlanSurface[];
  sidewalk: PlanSurface[];
  verge: PlanSurface[];
  /**
   * 路口行人平台 = 让开区里的人行道 + domain 上尚未归属的部分（圆角片、
   * 绿带收头空出的角）。它与人行道同材质、相邻不重叠，全部由 domain 派生。
   */
  apron: PlanSurface[];
  markings: MarkSeg[];
  /**
   * 车道级路口转向（maneuver graph）的统计。
   *
   * 目前只做"规模 + 完备性"的披露：每个 3 臂以上路口的每条进口车道
   * 都至少有一条通往出口的连接。真正的用途在后续（渠化 / 仿真），
   * 但数据得先建起来，否则箭头永远是"猜方向"。
   */
  maneuvers: { junctions: number; arms: number; links: number };
  /** 实际设了斑马线的路口中心（验收断言用） */
  crossings: Pt[];
  /** 唯一真值源：完整、已圆角的道路用地面（含全部路口） */
  domain: PlanSurface[];
  /** 同 domain：扣街区用 */
  reserve: PlanSurface[];
  roadAreaM2: number;
  /** 道路用地净面积：面积对账用这个口径，不用图层求和 */
  reserveAreaM2: number;
  /** 兼容字段：恒为 0（圆角已并入 reserve） */
  cornerAreaM2: number;
  junctionAreaM2: number;
  walkAreaM2: number;
  vergeAreaM2: number;
  lengthM: number;
  /** 实际生效的断面（按场地窄边收放之后）：路灯、入口、退线都读它 */
  sections: Record<RoadClass3, RoadSection>;
  notes: string[];
}

/**
 * 单一真值源：**一张完整的、已圆角的道路用地面**。
 *
 * 用户口径：地块是路网闭合面扣出来的范围，所以路网模型本身就得包含
 * 完整的路口和圆角；人行道、沿街绿带必须与这张闭合面同源，不能各自
 * 用矩形/条带拼完再 dedupe、跨层相减。
 *
 * 做法（四步，全程只有「闭合面」和「布尔差」，没有逐路条带）：
 *   ① 每条街按同一份断面生成 4 个**全宽缓冲**：车行 / +路缘 / +人行 / +绿带；
 *      路口让开区（每条分支一个矩形，按标线同一份 reach 收头）也在每一层里。
 *   ② 每层各并成一张闭合面 B0 ⊂ B1 ⊂ B2 ⊂ B3（宽度逐层递增，天然单调）。
 *   ③ B3 做**凹角/洞凸角圆弧化** → R。R 自带完整路口 + 圆角，是唯一的路网面。
 *   ④ 街区 = 场地 − R；curb = B1−B0，walk = B2−B1，verge = (B3−B2)−路口让开区，
 *      剩下的（圆角片 + 绿带收头空出的角）由 apron 一次补满。
 *   于是 R = 车行 ∪ 路缘 ∪ 人行 ∪ 绿带 ∪ 平台，两两不交、没有数值缝，
 *   而且绿带的外边界就是 R 的边界，街区的边界也是 R 的边界。
 */
export function buildRoadGeom(
  spec: { boundary: PlanSurface },
  graph: PathGraph,
  preset: StylePreset
): RoadGeom {
  const notes: string[] = [];
  const T0 = Date.now();
  const tick = (tag: string): void => {
    if (typeof process !== 'undefined' && process.env?.F3_TC) console.log(`[rg] ${tag} ${Date.now() - T0} ms`);
  };

  /** 断面按场地窄边收放（窄工业带不能被一条主干吃光） */
  const minorM = shapeOf(spec.boundary).minorM || 200;
  const capM = Math.max(9, minorM / 2.2);
  const shrunk: string[] = [];
  const secOf = (cls: RoadPath['cls']): RoadSection => {
    const sec = preset.section[cls];
    const total = sec.carriage + 2 * (sec.curb + sec.walk + sec.green);
    if (total <= capM) return sec;
    const k = capM / total;
    if (!shrunk.includes(cls)) shrunk.push(cls);
    return { carriage: sec.carriage * k, curb: sec.curb * k, walk: sec.walk * k, green: sec.green * k };
  };
  if (shrunk.length) notes.push(`断面按场地窄边 ${minorM.toFixed(0)} m 收放（上限 ${capM.toFixed(1)} m）：${shrunk.join(', ')}`);
  const widthOf = (cls: RoadPath['cls']): number => U(secOf(cls).carriage / 2);
  for (const e of graph.edges.values()) e.widthU = U(secOf(e.cls).carriage);
  for (const p of graph.paths) p.widthU = U(secOf(p.cls).carriage);

  /** 断面四级累计侧带宽（世界单位）：0 / 路缘 / 路缘+人行 / 全断面 */
  /**
   * 路缘石转弯半径**按道路等级取**（《城市道路交叉口规划规范》GB 50647 的口径：
   * 主干 15~20 m / 次干 10~15 m / 支路 6~9 m）。
   *
   * 取上界：主干 18 / 次干 13 / 支路 8。之前四层共用一个 6 m，17 m 宽的干道
   * 拐弯处只有 6 m 弧，大型车根本过不去，视觉上也像把四个角捏在一起。
   * three-roads 里这是 `minimumRadius` 的角色 —— 它按设计速度校验；这里退化成
   * 按断面宽度分档，但"等级越高、转角越大"的结论一致。
   */
  const cornerRFor = (half: number): number => (half >= U(7.5) ? 18 : half >= U(5) ? 13 : 8);

  const sideW = (cls: RoadPath['cls']): [number, number, number, number] => {
    const s = secOf(cls);
    return [0, U(s.curb), U(s.curb + s.walk), U(s.curb + s.walk + s.green)];
  };

  const site = spec.boundary;
  let lengthM = 0;
  for (const p of graph.paths) lengthM += polyLenM(p.pts);

  // ---------------- ① 路口入射方向（标线与让开区共用同一份）
  interface Approach {
    dir: Pt;
    ang: number;
    half: number;
    outer: number;
    cls: RoadPath['cls'];
    edgeId: string;
    reach: number;
  }
  const jApp = new Map<string, Approach[]>();
  for (const nid of graph.junctions) {
    const node = graph.nodes.get(nid);
    if (!node) continue;
    const list: Approach[] = [];
    for (const eid of new Set(node.edges)) {
      const e = graph.edges.get(eid);
      if (!e) continue;
      const dir = dirAtNode(e.pts, node.at);
      list.push({
        dir,
        ang: Math.atan2(dir.y, dir.x),
        half: widthOf(e.cls),
        outer: widthOf(e.cls) + sideW(e.cls)[3],
        cls: e.cls,
        edgeId: eid,
        reach: 0,
      });
    }
    if (list.length < 3) continue;
    list.sort((a, b) => a.ang - b.ang);
    const maxHalf = Math.max(...list.map((a) => a.half));
    for (let i = 0; i < list.length; i++) {
      let r = list[i].half * 0.9;
      for (let j = 0; j < list.length; j++) {
        if (j === i) continue;
        const s = Math.abs(Math.sin(list[j].ang - list[i].ang));
        r = Math.max(r, list[j].half / Math.max(0.32, s));
      }
      list[i].reach = Math.min(r, maxHalf * 1.9);
    }
    jApp.set(nid, list);
  }
  tick('apps');

  /** 圆盘：40 边足够，边界看起来就是圆弧 */
  const diskOf = (at: Pt, r: number, segs = 40): PlanSurface => {
    const ring: Pt[] = [];
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      ring.push(new Pt(at.x + Math.cos(a) * r, at.y + Math.sin(a) * r));
    }
    return { outer: ring, holes: [] };
  };

  /** 单臂横断矩形：从节点往外 L，半宽 h，端头垂直于该臂 */
  const armRect = (at: Pt, A: Approach, L: number, h: number): PlanSurface => {
    const nx = -A.dir.y;
    const ny = A.dir.x;
    const back = U(0.6);
    return {
      outer: cleanRing([
        new Pt(at.x - A.dir.x * back + nx * h, at.y - A.dir.y * back + ny * h),
        new Pt(at.x + A.dir.x * L + nx * h, at.y + A.dir.y * L + ny * h),
        new Pt(at.x + A.dir.x * L - nx * h, at.y + A.dir.y * L - ny * h),
        new Pt(at.x - A.dir.x * back - nx * h, at.y - A.dir.y * back - ny * h),
      ]),
      holes: [],
    };
  };

  /**
   * 一个路口的**星形让开区**（单一片）：每条臂一段横断收头线，转角处用
   * 一段**与两侧边线相切的圆弧**接起来。
   *
   * 三代实现的教训（改之前先读）：
   *   ① 每条臂一个矩形再并集 —— 矩形互相穿插，边界到处是 90°/锐角锯齿，
   *      切出来的臂端是斜嘴、路口中央长星形毛刺（用户红圈）。
   *   ② 各臂横断面的端点直接连直线（"星形多边形"）—— 边界没有锯齿了，但
   *      转角变成一个**直斜切**（正十字是 √2·(L−h) 长的一条斜边）。半径
   *      18 m 的路缘根本放不下（最多 0.44×边长），于是每个路口都是个八边形，
   *      用户红笔画的那条弧对不上。
   *   ③ 现在：横断线 → 沿边线走到切点 → 圆弧 → 另一条边线 → 下一个横断线。
   *      圆心 P 是两条边线的交点（"角点"），半径取该路口的路缘半径，
   *      圆弧向 P 内凹 —— 这正是街角铺装的形状。臂长必须够长（≥ 投影 + 切距），
   *      否则圆弧会被横断线切断，所以臂长在调用方按 `t = r·tan(φ/2)` 预留。
   */
  const starZone = (
    at: Pt,
    apps: Approach[],
    cuts: number[],
    half: (a: Approach, i: number) => number,
    cornerRadius: number,
    /** 输出：每条臂的**实际口部距离**（标记线要按它摆放，否则斑马线会落进路口里） */
    mouthOut?: number[]
  ): PlanSurface | null => {
    if (apps.length < 3) return null;
    const n = apps.length;
    const order = apps.map((_a, i) => i).sort((i, j) => apps[i].ang - apps[j].ang);
    const nrm = apps.map((A) => new Pt(-A.dir.y, A.dir.x));

    /** 相邻两臂的转角：交点 P、夹角 phi、以及 P 在两条臂上的投影 */
    interface Corner {
      k: number;
      i: number;
      j: number;
      P: Pt;
      phi: number;
      projA: number;
      projB: number;
    }
    const corners: (Corner | null)[] = new Array(n).fill(null);
    for (let k = 0; k < n; k++) {
      const i = order[k];
      const j = order[(k + 1) % n];
      const A = apps[i];
      const B = apps[j];
      const hA = half(A, i);
      const hB = half(B, j);
      const cosPhi = Math.max(-1, Math.min(1, A.dir.x * B.dir.x + A.dir.y * B.dir.y));
      const phi = Math.acos(cosPhi);
      if (phi > Math.PI - 0.14 || phi < 0.2) continue; // 几乎共线：这里没有转角
      const pA = new Pt(at.x + nrm[i].x * hA, at.y + nrm[i].y * hA);
      const pB = new Pt(at.x - nrm[j].x * hB, at.y - nrm[j].y * hB);
      const P = lineIntersect(pA, A.dir, pB, B.dir);
      if (!P || Pt.distance(P, at) > U(60)) continue;
      const projA = (P.x - at.x) * A.dir.x + (P.y - at.y) * A.dir.y;
      const projB = (P.x - at.x) * B.dir.x + (P.y - at.y) * B.dir.y;
      if (projA <= U(1) || projB <= U(1)) continue; // 转角落在节点背后，不是这个路口
      corners[k] = { k, i, j, P, phi, projA, projB };
    }

    /**
     * 每条臂的**嘴距**（横断线离路口中心多远）。
     *
     * 这是"黑色星形团块"的直接病根：原来嘴距只取 `cuts[i]`（按最窄夹角解析出来的
     * 收头距离），而锐角/钝角路口上它会**越过转角交点 P 很多**。于是口诀面沿着这条臂
     * 探进街角一大截，圆弧越过去之后再把两臂的嘴连起来 —— 那条弧外那块三角就是
     * 俯视图里戳出去的尖刺（全是沥青，而真实道路的街角应该是铺装）。
     *
     * 现在给嘴距加**两道夹子**：
     *   ① 不能超过「转角投影 + 圆弧切距上限」，圆弧永远落在嘴线以内；
     *   ② 圆弧切距再按臂宽封顶（≤ 1.4 倍最窄半幅）—— 这样转角半径再大也不会把
     *      路口撑成一个 60 m 宽的星形广场，只是"圆一点的街角"。
     */
    const tCapOf = (A: Approach, i: number, B: Approach, j: number): number =>
      Math.min(half(A, i), half(B, j)) * 1.4;
    /** 每个转角想要的切距（先算出来，嘴距要给它让出位置） */
    const cornerT = corners.map((c) => {
      if (!c) return 0;
      const tanH = Math.tan(c.phi / 2);
      return Math.min(cornerRadius * tanH, tCapOf(apps[c.i], c.i, apps[c.j], c.j));
    });
    /**
     * 嘴距必须**正好落在圆弧切点上**（proj + t），不能更远：
     * 更远的话环会先从嘴线出去、再折回切点，在转角处留下一个内凹的折痕
     * （俯视图上就是"捏进去一角"）。也不能更近，否则圆弧被嘴线切断。
     */
    const L: number[] = apps.map((A, i) => {
      let l = Math.min(cuts[i], A.half * 5);
      for (let k = 0; k < n; k++) {
        const c = corners[k];
        if (!c) continue;
        if (c.i === i) l = Math.min(l, c.projA + cornerT[k] + U(0.3));
        if (c.j === i) l = Math.min(l, c.projB + cornerT[k] + U(0.3));
      }
      // 下限：嘴距不能小于臂半宽（否则路口面比车行道还窄，会切出缺口）
      return Math.max(l, A.half * 0.85);
    });

    /**
     * 路口面 = **各臂口部端点的凸包**（再按需把凸包的转角切成圆角）。
     *
     * 为什么用凸包而不是"口线 + 转角圆弧"手工拼环（三代实现的教训）：
     *   ① 手拼时"嘴距 vs 圆弧切点"是两个互相依赖的量 —— 嘴给长了，环会先出去再
     *      折回来，在转角处留一道内凹折痕（俯视图上是"捏进去的角"）；嘴给短了，
     *      圆弧被切断，又退回直斜接。两头都试过，参数一换就翻车。
     *   ② 凸包天然是**简单多边形**：不自交、不凹、不用判 tFit，任何臂数/任何夹角
     *      都给一个干净形状。形状语义也对 —— 路口就是把各条路的断面"包"起来的那块沥青。
     *   ③ 尖刺的根因是"路口面伸到转角外面"，而凸包不会：它一定被口部端点围住。
     *
     * 转角圆角：凸包每条**非口线**的边（相邻两臂之间那段）中点往里收一点，
     * 形成一条短折线，视觉上就是"圆角"；标记线（jArcs）也从这些边派生。
     */
    const mouthPts: Pt[][] = [];
    for (let k = 0; k < n; k++) {
      const i = order[k];
      const A = apps[i];
      const hA = half(A, i);
      const nA = nrm[i];
      const a = new Pt(at.x + A.dir.x * L[i] - nA.x * hA, at.y + A.dir.y * L[i] - nA.y * hA);
      const b = new Pt(at.x + A.dir.x * L[i] + nA.x * hA, at.y + A.dir.y * L[i] + nA.y * hA);
      mouthPts.push([a, b]);
    }
    /**
     * 凸包点 = 各臂口部端点 **+ 各转角交点 P**。
     *
     * 只用口部端点时，相邻两臂之间是一条**直线弦**，弦会切进 B0（已圆角化的车行面）
     * 的转角里 —— 于是路口面的转角变成一个直折角，和外面人行道/路缘那条
     * 多段圆弧对不上：细分不同、接缝处漏一道细缝（用户红圈指的就是这里）。
     *
     * 把转角交点 P（两条边线的交点）也丢进凸包，凸包就把整个转角包住，
     * 路口面 = B0 ∩ 凸包 的边界在转角处**正好落在 B0 的圆弧上** ——
     * 细分、半径、起止点全部与人行道同源，不可能再漏缝。
     */
    const hullPts: Pt[] = mouthPts.flat();
    for (let k = 0; k < n; k++) {
      const c = corners[k];
      if (!c) continue;
      /**
       * 把**转角圆弧本身**采样成点，丢进凸包。
       *
       * 关键点：这里用的是和 `roundDomainAll` **同一个半径、同一个圆心公式**，
       * 采样密度也按弧长定（约 1.5 m 一段）。于是 `路口面 = B0 ∩ 凸包` 在转角处
       * 与 B0 的圆弧几乎重合 —— 细分一致、半径一致，不会再有"两种圆角对不上"。
       *
       * 之前试过"把交点 P 往角平分线外推 N 米"：推少了凸包还是切在弧里（直折角），
       * 推多了会把路口撑成圆饼，而且 P 只有一个点，没法跟弧的细分对齐。
       */
      const tanH = Math.tan(c.phi / 2);
      const t = Math.min(cornerRadius * tanH, Math.min(c.projA, c.projB) * 0.9);
      const rr = t / Math.max(1e-6, tanH);
      if (!(rr > U(1))) continue;
      const T1 = new Pt(c.P.x + apps[c.i].dir.x * t, c.P.y + apps[c.i].dir.y * t);
      const T2 = new Pt(c.P.x + apps[c.j].dir.x * t, c.P.y + apps[c.j].dir.y * t);
      const bx = apps[c.i].dir.x + apps[c.j].dir.x;
      const by = apps[c.i].dir.y + apps[c.j].dir.y;
      const bl = Math.hypot(bx, by) || 1;
      const C = new Pt(c.P.x + (bx / bl) * (rr / Math.cos(c.phi / 2)), c.P.y + (by / bl) * (rr / Math.cos(c.phi / 2)));
      const a1 = Math.atan2(T1.y - C.y, T1.x - C.x);
      const a2 = Math.atan2(T2.y - C.y, T2.x - C.x);
      let delta = a2 - a1;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      // 约 1.5 m 一段，和人行道圆弧的采样密度对齐
      const segs = Math.max(3, Math.min(24, Math.ceil((Math.abs(delta) * rr * 7) / 1.5)));
      for (let q = 0; q <= segs; q++) {
        const a = a1 + (delta * q) / segs;
        hullPts.push(new Pt(C.x + Math.cos(a) * rr, C.y + Math.sin(a) * rr));
      }
    }
    const hull = convexHull(hullPts);
    if (hull.length < 3) return null;

    /** 每条臂的口线端点对（用来识别"这条凸包边是不是口线"） */
    const mouthKey = new Set<string>();
    const kOf = (p: Pt): string => `${Math.round(p.x * 1e4)}_${Math.round(p.y * 1e4)}`;
    for (const [a, b] of mouthPts) mouthKey.add(`${kOf(a)}|${kOf(b)}`);

    /**
     * 先把凸包拆成**边**（口线 / 转角边），再拼环。
     *
     * 拼成一维边表而不是直接往 ring 里塞点，是为了让标记线能**沿整条边界连续**地
     * 铺设：旧实现按"每个转角单独算内移法线"，四个角的缝对不上，
     * 路口路缘线在接缝处直接断开（用户截图里那条白线中间缺一截）。
     */
    interface Edge {
      a: Pt;
      b: Pt;
      /** 口线 = 这条边接着一条路，不该画路缘线 */
      mouth: boolean;
    }
    const edges: Edge[] = [];
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i];
      const b = hull[(i + 1) % hull.length];
      const isMouth = mouthKey.has(`${kOf(a)}|${kOf(b)}`) || mouthKey.has(`${kOf(b)}|${kOf(a)}`);
      if (isMouth) {
        edges.push({ a, b, mouth: true });
        continue;
      }
      /**
       * 非口线：**直边**，不再人为往里收出一个"圆角"。
       *
       * 转角形状由 B0（已经过 roundDomainAll 圆角）与凸包求交得到，
       * 这里再自作主张收一下只会跟 B0 的圆弧打架（细分不同 → 漏缝）。
       */
      edges.push({ a, b, mouth: false });
    }
    /** 环 = 每条边的起点（边之间首尾相接，最后一条的终点就是第一条的起点） */
    const ring: Pt[] = edges.map((e) => e.a);
    if (mouthOut) {
      // 按臂写回：apps 的顺序与 L 一一对应（标线要按路口面自己的嘴距摆）
      for (let i = 0; i < n; i++) mouthOut[i] = L[i];
    }

    const r = ringArea(ring) < 0 ? ring.slice().reverse() : ring;
    const out = cleanRing(r);
    /**
     * 只要 ≥ 3 点就是合法多边形。
     *
     * 原来卡 6 点，是因为老实现是"星形多边形"（臂数多、必然 ≥6）；
     * 现在路口面是**凸包**，十字路口筛完就剩 4 个极值点 —— 卡 6 会把 70/82 个路口
     * 全部判死，退回 diskOf 的圆盘（截图里那些圆乎乎的路口、破面都是它）。
     */
    if (out.length < 3) return null;
    if (selfIntersects(out)) return null;
    return { outer: out, holes: [] };
  };

  /** 第 k 层路口让开区（长度取标线同一份 reach，宽度按层递增） */
  const zones: PlanSurface[][] = [[], [], [], []];
  /**
   * 每条进口的「路口面收头距离」：`${nodeId}|${edgeId}` → 世界单位。
   *
   * 标线（人行横道 / 停止线 / 箭头 / 路口边线）必须跟**路口面本身**的边界对齐，
   * 不能自己再估一个 reach：估小了斑马线压进路口、估大了留一条黑缝。
   * 这里是唯一真值源，markings 只负责消费。
   */
  const faces = new Map<string, number>();
  /** 各路口转角的圆弧中心线（已向沥青一侧挪 0.42 m），给标线画转角边线用 */
  const jArcs: Pt[][] = [];
  /** 绿带禁入区：按《Houdini 路网》任意 N 叉的垂线收头线求，绿带在此收头 */
  const yieldZones: PlanSurface[] = [];
  /**
   * 路口**转角平台**：让开区外扩「街角半径 + 绿带宽 + 2 m」。
   *
   * 为什么需要它：绿带是断面最外一圈（B3 − B2），它会绕路口转角连续包过去。
   * 只看让开区的话，转角那一圈 5 m 宽的弧带会被判成绿带 —— 于是每个路口
   * 四角都是绿色楔形，而真实道路的绿化在停止线前就收头，转角是整块铺装。
   * 外扩量 = 街角圆弧半径 + 该路口最宽绿带 + 2 m，刚好盖住转角弧带，
   * 又不会把半条街的绿带推平。
   */
  const cornerZones: PlanSurface[] = [];
  /** 最外层（街区块角）的圆弧半径，世界单位 */
  const cornerR = U(6);
  for (const [nid, apps] of jApp) {
    const node = graph.nodes.get(nid);
    if (!node) continue;
    // 收头距离用第 3 层（全断面）宽度解析，四层共用同一组 → B0⊂B1⊂B2⊂B3 严格同心
    const a3 = apps.map((A) => ({ ...A, outer: A.half + sideW(A.cls)[3] }));
    const cuts = junctionCutDistances(a3, node.at);
    const maxHalf = (k: number): number => Math.max(...apps.map((A) => A.half + sideW(A.cls)[k]));
    /** 该路口的路缘转弯半径（按最宽臂的等级） */
    const jR = U(cornerRFor(Math.max(...apps.map((A) => A.half))));
    /**
     * 绿带在**每条臂的收头处**垂直切断（真实道路：绿化到停止线前就结束）。
     *
     * 端头是垂直于道路的直线 —— 这是"横切断面"的形状，不会斜切。
     * 但长度要 superset 到相邻转角：只切到 `cuts[i]` 时，臂端与转角之间会
     * 留一小截绿带（图上是一个绿色小钩），因为转角在 edge 交点处、比收头更远。
     */
    let beltW = 0;
    for (const A of apps) beltW = Math.max(beltW, sideW(A.cls)[3] - sideW(A.cls)[2]);

    const armLen = apps.map((_A, i) => cuts[i]);
    const cornerPts: Pt[] = [];
    /** 最外侧的侧带宽度：圆弧半径在该层最大，臂长要按它预留 */
    let side3 = 0;
    for (const A of apps) side3 = Math.max(side3, sideW(A.cls)[3]);
    for (let i = 0; i < apps.length; i++) {
      const A = apps[i];
      const B = apps[(i + 1) % apps.length];
      const nA = new Pt(-A.dir.y, A.dir.x);
      const nB = new Pt(B.dir.y, -B.dir.x);
      const pA = new Pt(
        node.at.x + nA.x * (A.half + sideW(A.cls)[3]),
        node.at.y + nA.y * (A.half + sideW(A.cls)[3])
      );
      const pB = new Pt(
        node.at.x + nB.x * (B.half + sideW(B.cls)[3]),
        node.at.y + nB.y * (B.half + sideW(B.cls)[3])
      );
      const P = lineIntersect(pA, A.dir, pB, B.dir);
      // 交点飞太远（两臂几乎共线）说明那里没有真正的转角，不做处理
      if (!P || Pt.distance(P, node.at) > U(46)) continue;
      cornerPts.push(P);
      const vx = P.x - node.at.x;
      const vy = P.y - node.at.y;
      const projA = vx * A.dir.x + vy * A.dir.y;
      const projB = vx * B.dir.x + vy * B.dir.y;
      /**
       * 臂长要留出**圆弧切距** t = r·tan(φ/2)：转角圆弧切在边线上、离角点 P
       * 还有 t 米，收头线必须比那个切点更远，否则圆弧会被横断线削掉
       * （那就退回上一版的"直斜切八边形"）。
       *
       * 上限 8 m：不留上限时，锐角/钝角路口的 t 能到 30 m 以上，路口被撑成
       * 一个 60~70 m 见方的广场，而且停止线被推到 30 m 外、路口内一大段
       * 车行道没有任何标线。放不下的大半径由 `starZone` 按实际可用的切距
       * **降级**，圆弧仍然存在，只是小一点。
       */
      const phi = Math.acos(Math.max(-1, Math.min(1, A.dir.x * B.dir.x + A.dir.y * B.dir.y)));
      const tanHalf = Math.abs(phi - Math.PI) > 0.14 ? Math.abs(Math.tan(phi / 2)) : 0;
      const tOut = Math.min(U(8), (jR + side3) * tanHalf);
      armLen[i] = Math.max(armLen[i], projA + tOut + U(0.8));
      armLen[(i + 1) % apps.length] = Math.max(armLen[(i + 1) % apps.length], projB + tOut + U(0.8));
    }
    /**
     * 绿带禁区 = 一个**星形多边形**（各臂横断线 + 相邻臂之间的直连边）。
     *
     * 这里试过三种形状，只有星形是对的：
     *   · 单臂横断矩形并集 —— 矩形互相穿插，边界全是 90°/锐角锯齿；
     *   · 一条臂一个矩形 + 转角小圆 —— 直边与圆弧相交处出现尖角（"尖嘴"）；
     *   · 以路口为心的大圆 —— 锐角路口半径 40 m，把沿街绿化整段铲平。
     * 星形的边界只有两种边：垂直于道路的横断线（绿带端头）和两臂之间的
     * 直连边（转角，那一段本来就不该有绿化），于是绿带端头永远是干净的直线。
     *
     * 臂长取「收头距离」与「到相邻转角的投影 + 2.5 m」的较大者：转角在
     * 边缘线交点处，比收头更远，不延伸过去就会在臂端留一小截绿带（绿色小钩）。
     */
    /**
     * 各层路口让开区 = **同一个星形**，只是半宽按层递增。
     *
     * 之前这里是「以节点为心、半径 = 该层最宽臂半宽」的圆盘：一条 17 m 主干
     * 与 12 m 支路相交时，圆盘按 8.5 m 画，在支路方向鼓出 2.5 m 的圆头，
     * 路缘/人行道/绿带全跟着鼓包 —— 转角那块"伸出路面的米色舌头"。
     * 星形每条臂的半宽就是该臂自己的宽度，端头平齐，不会鼓。
     */
    const mouths0: number[] = [];
    for (let k = 0; k < 4; k++) {
      const w = (A: Approach): number => A.half + sideW(A.cls)[k];
      const maxSide = Math.max(...apps.map((A) => sideW(A.cls)[k]));
      // 四层同心：圆心不动，半径 = 路缘半径 + 该层累计侧带宽
      const z = starZone(node.at, apps, armLen, w, jR + maxSide, k === 0 ? mouths0 : undefined);
      zones[k].push(z ?? diskOf(node.at, Math.max(...apps.map(w))));
    }

    /**
     * 标线要用的收头距离 = **第 0 层路口面在自己这条臂上的实际口部距离**
     * （不是解析出来的 armLen）。
     *
     * 之前用 armLen：路口面按凸包算出来的嘴距可能比它更远，于是"斑马线 / 停止线"
     * 摆在了路口面**内部**，看起来就是路口中间横着几根白线（用户截图）。
     * 现在直接读路口面自己的嘴距，标线一定落在路口外面。
     */
    for (let i = 0; i < apps.length; i++) faces.set(`${nid}|${apps[i].edgeId}`, mouths0[i] ?? armLen[i]);

    const z3 = starZone(node.at, apps, armLen, (A) => A.half + sideW(A.cls)[3], jR + side3);
    if (z3) {
      yieldZones.push(z3);
    } else {
      for (let i = 0; i < apps.length; i++) {
        yieldZones.push(armRect(node.at, apps[i], Math.min(armLen[i], U(18)), apps[i].half + sideW(apps[i].cls)[3]));
      }
    }

    /**
     * 转角区 = 每个转角一个以「两臂边缘线交点」为心的小圆。
     *
     * 圆心落在角上，不在路口中心：以路口为心会把两侧沿街绿化整段铲平，
     * 铺装被补成一条沿街长带（用户红圈里那块"舌头"）。
     * 半径 = 街角圆弧 + 绿带宽 + 3 m：刚好盖住转角那圈绿带，沿街绿化不动。
     */
    for (const P of cornerPts) cornerZones.push(diskOf(P, jR + U(beltW + 5)));
  }

  /** 尽端回车场：也是路网面的一部分，四层都要带着它 */
  for (const n of graph.nodes.values()) {
    if (n.degree !== 1 || n.onBoundary) continue;
    const e = graph.edges.get(n.edges[0]);
    if (!e) continue;
    const half = widthOf(e.cls);
    const seg = sampleAlong(e.pts, U(1)).slice(0, 2);
    const dir = seg.length >= 2 ? new Pt(seg[0].at.x - seg[1].at.x, seg[0].at.y - seg[1].at.y) : new Pt(1, 0);
    const L = Math.hypot(dir.x, dir.y) || 1;
    const c = new Pt(n.at.x - (dir.x / L) * half * 0.6, n.at.y - (dir.y / L) * half * 0.6);
    const ring: Pt[] = [];
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      ring.push(new Pt(c.x + Math.cos(a) * half * 1.05, c.y + Math.sin(a) * half * 1.05));
    }
    for (let k = 0; k < 4; k++) zones[k].push({ outer: ring, holes: [] });
  }
  tick('zones');

  /** 批量裁回红线（一次求交，失败再逐片） */
  const clipBatch = (list: PlanSurface[]): PlanSurface[] => {
    if (list.length === 0) return [];
    try {
      const q = surfaceIntersect(list, [site]);
      if (q.length) return q.map(dropPins).filter((s) => M2(surfaceArea(s)) > 0.6);
    } catch {
      /* 逐片兜底 */
    }
    return clipToSite(list, site);
  };

  // ---------------- ② 四层闭合面 B0 ⊂ B1 ⊂ B2 ⊂ B3
  /**
   * 端点压在红线上的路，缓冲前**往外多伸半个断面**。
   *
   * 断面缓冲是平头收口：中心线端点正好落在红线上时，带的端面就是红线本身，
   * 于是「场地 − 路网面」在带的两端只剩下两个**角点相接**的残块 ——
   * polygon-clipping 会把它并成一个环（35 顶点、0 个洞），街区数从 2 掉到 1，
   * 那一块又因为太大而切不出地块、最后 0 栋建筑（实测 R01 样板）。
   * 多伸半个断面之后，带一定跨过红线，街区被干净地切开；多出来的部分被
   * `clipBatch` 裁回场地，不会让路面越界。
   */
  const outward = (pts: Pt[], half: number): Pt[] => {
    const out = pts.map((p) => new Pt(p.x, p.y));
    if (out.length < 2) return out;
    const dirAt = (a: Pt, b: Pt): Pt => {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const L = Math.hypot(dx, dy) || 1;
      return new Pt(dx / L, dy / L);
    };
    const ext = half + U(0.4);
    const head = out[0];
    if (distToSurfaceEdge(head, site) < U(0.5)) {
      const d = dirAt(out[1], out[0]);
      out.unshift(new Pt(head.x + d.x * ext, head.y + d.y * ext));
    }
    const tail = out[out.length - 1];
    if (distToSurfaceEdge(tail, site) < U(0.5)) {
      const d = dirAt(out[out.length - 2], tail);
      out.push(new Pt(tail.x + d.x * ext, tail.y + d.y * ext));
    }
    return out;
  };
  const band: PlanSurface[][] = [[], [], [], []];
  for (const p of graph.paths) {
    const w = sideW(p.cls);
    // 四层必须用**同一份**折线：逐米采样的中心线会在缓冲环上留下 3 cm 级的
    // 微边，街角放不下圆弧；简化只消化离散化折点（15 cm），四层仍严格同心。
    const pts = outward(simplifyPolyline(p.pts, U(0.15)), widthOf(p.cls) + w[3]);
    for (let k = 0; k < 4; k++) {
      const buf = bufferPolyline(pts, widthOf(p.cls) + w[k]);
      if (!buf) continue;
      const ring = cleanRing(buf);
      if (ring.length >= 3) band[k].push({ outer: ring, holes: [] });
    }
  }
  const Braw: PlanSurface[][] = [];
  for (let k = 0; k < 4; k++) Braw.push(clipBatch(unionPolys([...band[k], ...zones[k]])));
  tick('bands');
  for (let k = 0; k < 4; k++) {
    if (Braw[k].length === 0) notes.push(`第 ${k} 层道路面为空 —— 该层没有可生成的侧带（不静默当成功）`);
  }

  // ---------------- ③ 四级断面共用同一组同心圆弧
  /**
   * 圆角必须**贯穿整个断面**，不能只长在最外圈。
   *
   * 上一版只对 B3（含绿带的用地边界）圆角化：街区块 / 绿带的外角是圆的，
   * 但 B0/B1/B2 仍是直角缓冲并集，于是「灰色沥青 ↔ 米色铺装」那条路缘线
   * 在路口拐成直角，平台还被矩形让开区补出一块直角楔形（用户标红的那一块）。
   *
   * 同心条件：设最外层街角圆弧半径 r3、圆心 C；第 k 层的角点比最外层内缩
   * (w3 − wk)，要让圆心仍是 C，半径必须是 r_k = r3 + (w3 − wk)。
   * 于是车行面圆角最大、街区块角圆角最小，中间正好夹着等宽的路缘 / 人行 /
   * 绿带环带 —— 这才是「路网面自带完整路口和圆角」。
   */
  /** 每个节点按最宽入射边取四级累计侧带宽，供角点按位置查半径 */
  /**
   * 路缘石转弯半径**按道路等级取**（《城市道路交叉口规划规范》GB 50647 的口径）：
   * 主干 12 m / 次干 9 m / 支路 6 m。
   *
   * 之前四层共用一个 6 m，主干路口看起来"咬得太紧"：17 m 宽的干道拐弯处
   * 只有 6 m 弧，大型车根本过不去，视觉上也像把四个角捏在一起。
   * three-roads 里这是 `minimumRadius` 的角色 —— 它按车道设计速度校验，
   * 我们这里退化成按断面宽度分档，但"等级越高、转角越大"的结论一致。
   */
  /**
   * 每个路口记下**能放得下的最大半径**，用它去压 `cornerRFor`。
   *
   * 为什么必须在这里压，而不是让 `filletConvex` 里面按"44% 边长"去夹：
   * 四层（车行/路缘/人行/用地）是**各自**圆角化的，夹切距的公式是
   * `t = r/tan(θ/2) ≤ 0.44·最短边`。锐角路口上 `r` 大到必须夹时，
   * 四层的 `t` 都被夹到同一个上限 → `r = t·tan(θ/2)` 变成**同一个值** →
   * 相邻两层（B1 / B2）的圆弧完全重合 → 它们之间的环带在转角处宽度归零，
   * 于是人行道被挤成一个**尖刺**、或者干脆收成一个点（用户 0.28 km 截图里
   * 红圈那些楔形）。大城里街区边长几十上百米，永远碰不到这个夹子，所以只在
   * 小规模城市暴露。
   *
   * 现在改成"先把半径压到放得下"，四层就永远保持 `r, r+w1, r+w2, r+w3` 的
   * 平行关系，不会再撞上内层夹子。
   */
  const nodeW = [...graph.nodes.values()].map((n) => {
    let w: [number, number, number, number] = [0, 0, 0, 0];
    let half = 0;
    let minEdgeM = Infinity;
    const dirs: number[] = [];
    for (const eid of n.edges) {
      const e = graph.edges.get(eid);
      if (!e) continue;
      const cw = sideW(e.cls);
      if (cw[3] > w[3]) w = cw;
      half = Math.max(half, widthOf(e.cls));
      {
        let len = 0;
        for (let i = 0; i + 1 < e.pts.length; i++) len += Pt.distance(e.pts[i], e.pts[i + 1]);
        minEdgeM = Math.min(minEdgeM, len * 7);
      }
      const pts = e.a === n.id ? e.pts : e.pts.slice().reverse();
      const q = pts[Math.min(3, pts.length - 1)];
      dirs.push(Math.atan2(q.y - n.at.y, q.x - n.at.x));
    }
    // 最窄的臂夹角 → 该路口最尖的那个角（转角的 tan(θ/2) 由它主导）
    dirs.sort((a, b) => a - b);
    let phi = Math.PI / 2;
    for (let i = 0; i < dirs.length; i++) {
      const d = ((dirs[(i + 1) % dirs.length] - dirs[i] + Math.PI * 2) % (Math.PI * 2));
      phi = Math.min(phi, d);
    }
    const theta = Math.max(0.3, Math.min(Math.PI / 2, phi));
    const w3M = w[3] * 7;
    const edgeM = Number.isFinite(minEdgeM) ? minEdgeM : 60;
    /**
     * 42% 边长留给这一侧（两侧对称占 84%，中间还留一点直段）。
     *
     * 下限 9 m 是必须的：压到 5 m 时，锐角分叉口的人行道两侧弧会贴到一起，
     * 变成一条**细丝**横在路口里（r=90 的 41° 分叉实测如此），比原来的台阶更难看。
     * 9 m 既能让切线夹子基本不触发，又不会把转角压成针。
     */
    const fitM = Math.max(9, 0.42 * edgeM * Math.tan(theta / 2) - w3M);
    return { at: n.at, w, r: Math.min(cornerRFor(half), fitM) };
  });
  /** 该位置的路缘转弯半径（米 → 世界单位），按最近路口取 */
  const cornerRAt = (v: Pt): number => {
    let best = Infinity;
    let r = 6;
    for (const n of nodeW) {
      const dx = n.at.x - v.x;
      const dy = n.at.y - v.y;
      const d = dx * dx + dy * dy;
      if (d < best) {
        best = d;
        r = n.r;
      }
    }
    return U(r);
  };
  const localW = (v: Pt): [number, number, number, number] => {
    let best = Infinity;
    let w = nodeW.length ? nodeW[0].w : ([0, 0, 0, 0] as [number, number, number, number]);
    for (const n of nodeW) {
      const dx = n.at.x - v.x;
      const dy = n.at.y - v.y;
      const d = dx * dx + dy * dy;
      if (d < best) {
        best = d;
        w = n.w;
      }
    }
    return w;
  };
  /**
   * 第 k 层的圆角半径 = **路缘石转弯半径 + 该层累计侧带宽**。
   *
   * 关键是 `cornerRAt` 现在定义成**路缘石（沥青 ↔ 铺装那条线）的半径**，
   * 不是"最外圈的半径"：
   *   车行面 B0 = r0            ← 用户在图里画黄线的就是这条
   *   路缘 B1   = r0 + 路缘宽
   *   人行 B2   = r0 + 路缘 + 人行
   *   用地 R    = r0 + 全断面侧带宽
   * 四条弧同心、间距等于各自的侧带宽，所以转角铺装等宽。
   *
   * 之前写成 `r0 − (w3 − w[k])`：车行面半径只有 `12 − 5.6 = 6.4 m`，
   * 主干路口的转弯弧看着还是个"小圆角"，大型车根本过不去 —— 用户标出来的
   * 那条大弧就是要求把"路缘半径"本身做大。
   */
  const radiusFor = (k: number) => (v: Pt): number => {
    const w = localW(v);
    return Math.max(U(0.6), cornerRAt(v) + w[k]);
  };
  /**
   * 圆角分段数：**每 1.5 m 弧长一段**（原来固定 4 段）。
   *
   * 4 段在 18 m 半径的街角上每段 7 m，俯视一眼就是折线 —— 路口沥青是折的，
   * 跟着画的路缘线也只能是折的（用户连报三次"还是折线"）。
   * 这里按弧长定段数：R=18 m 的 90° 转角 ≈ 28 m 弧长 → 19 段，视觉上就是圆弧。
   * 顶点数只在转角处增加（直线的两条边仍是两个端点），对布尔和性能影响很小。
   */
  const arcSegsFor = (rrU: number): number => {
    const arcLenM = Math.PI * 0.5 * rrU * 7; // 按 90° 估
    return Math.max(6, Math.min(20, Math.ceil(arcLenM / 2.6)));
  };
  const roundWith = (list: PlanSurface[], r: (v: Pt) => number): PlanSurface[] => {
    // 半径是逐点的，段数按最大半径取一档，保证同一路口只用一种分段
    let rMax = 0;
    for (const s of list) for (const p of s.outer) rMax = Math.max(rMax, r(p));
    const segs = arcSegsFor(rMax);
    return roundDomainAll(list, r, segs);
  };
  /** 最外层圆角半径 = 路缘半径 + 全断面侧带宽（跟着最近路口走） */
  const outerRAt = (v: Pt): number => Math.max(U(0.6), cornerRAt(v) + localW(v)[3]);
  tick('round');

  /**
   * 四层全部圆角化；最外层就是 R 本身。
   *
   * 这里**不再**把 B[k] 与 R 求交：四层与 R 的边界本来就是同一族折线简化出来的，
   * 自己跟自己求交是 polygon-clipping 最容易报 "degenerate segment" 的病态输入
   * （实测 636 次静默失败，失败时兜底保留原片反而制造了层间重叠）。
   *
   * 不同等级相交 / 锐角路口会让半径补偿差几米，内层圆角片偶尔探出外层；
   * 因此逐层做一次**累积并集**强制 B0 ⊂ B1 ⊂ B2，而不是靠事后相减。
   * R 仍是纯圆角化的最外层，不把内层并进来 —— 并进来会让
   * `R − 已分配层` 变成病态布尔（实测铺装暴涨 4 万 m² 并压回车行面）。
   * 内层探出的那几片由下面的「派生层显式排除车行面」兜住。
   */
  /**
   * 四层各自圆角 + 累积并集（老的构造，保留）。
   *
   * 试过"只圆 B0、外层用 offset 逐级派生"：`surfaceOffset` 对"几万顶点、
   * 上百个洞的并集多边形"经常返回空（`surfaceValid` 判为自交），
   * 兜底成"没长出去"→ 路缘层整层消失、人行道宽度乱跳。这条路走不通。
   *
   * 真正的问题不在"各层各圆"，而在**每层各自被切距夹住**（`t ≤ 44% 最短邻边`）：
   * 夹住之后 `r = t·tan(θ/2)` 对所有层变成同一个值，弧不再同心。
   * 所以改成：**把半径压到"最外层都放得下"**（见 `nodeW` 里的 `fitM`），
   * 让夹子永不触发，四层就恢复严格同心。同时给 fillet 加了个计数器
   * （`filletClampCount`），测试里可以断言"没有一次夹切"。
   */
  const R = clipBatch(roundWith(Braw[3], outerRAt));
  const B: PlanSurface[][] = [];
  for (let k = 0; k < 3; k++) B.push(clipBatch(roundWith(Braw[k], radiusFor(k))));
  for (let k = 1; k < 3; k++) B[k] = unionPolys([...B[k], ...B[k - 1]]);
  B.push(R);
  tick('layers-round');

  // ---------------- ④ 所有层由 R / B 差集派生
  /**
   * 输出前统一**洗环**：去零长边 + 统一绕向（外环 CCW、洞环 CW）。
   *
   * 布尔与偏移的结果里会留 0.1 mm 量级的重复点（实测 junction 13/57 片、
   * curb 40/99 片带零长边）。这些退化边进三角化会生成 NaN 法线，
   * 3D 里就表现成路口中间一团**放射状黑块/星形**（用户截图红圈）。
   * 绕向不一致同样会让一部分三角形背面朝上，渲染出来发黑。
   */
  const sanitize = (list: PlanSurface[]): PlanSurface[] => {
    const out: PlanSurface[] = [];
    const eps = 6e-5;
    const dedupe = (ring: Pt[]): Pt[] => {
      const r: Pt[] = [];
      for (const q of ring) {
        const last = r[r.length - 1];
        if (last && Pt.distance(last, q) < eps) continue;
        r.push(new Pt(q.x, q.y));
      }
      if (r.length > 2 && Pt.distance(r[0], r[r.length - 1]) < eps) r.pop();
      return r;
    };
    const norm = (s0: PlanSurface): PlanSurface | null => {
      // 先摘发夹（零宽回折），否则三角化一定吐尖刺
      const outer = dedupe(removeHairpins(dedupe(s0.outer)));
      if (outer.length < 3) return null;
      if (ringArea(outer) < 0) outer.reverse();
      const holes: Pt[][] = [];
      for (const h of s0.holes) {
        const d = dedupe(removeHairpins(dedupe(h)));
        if (d.length < 3) continue;
        holes.push(ringArea(d) > 0 ? d.slice().reverse() : d);
      }
      return { outer, holes };
    };
    for (const s0 of list) {
      const s1 = norm(s0);
      if (!s1) continue;
      /**
       * 自交环必须**这里**修掉：斜接外扩（surfaceOffset）在凹角处会自己穿自己，
       * 布尔再把它传下去。自交环进三角化就是一团尖刺/星形（用户红圈），
       * 进读图就是"路口角落被咬掉一块"。
       * 修法：拿它自己跟自己并一次 —— polygon-clipping 会把自交环规范化成简单环。
       */
      const dirty = selfIntersects(s1.outer) || s1.holes.some((h) => selfIntersects(h));
      if (!dirty) {
        out.push(s1);
        continue;
      }
      try {
        const healed = surfaceUnion([s1]);
        for (const q of healed) {
          const n = norm(q);
          if (n && M2(surfaceArea(n)) > 1) out.push(n);
        }
      } catch {
        /* 修不了就丢掉这一片：宁可少一块铺装，也不要一张破面 */
      }
    }
    return out;
  };

  const sum = (list: PlanSurface[]): number => list.reduce((a, s) => a + M2(surfaceArea(s)), 0);
  const diff = (a: PlanSurface[], b: PlanSurface[]): PlanSurface[] => {
    if (a.length === 0) return [];
    if (b.length === 0) return a.filter((s) => M2(surfaceArea(s)) > 1);
    try {
      return surfaceSubtract(a, b).filter((s) => M2(surfaceArea(s)) > 1);
    } catch {
      /**
       * 整批失败时**逐片**重试，而不是原样返回 `a`。
       *
       * polygon-clipping 只要吃到一片自交/退化输入就整批静默失败；原样返回
       * 意味着"这一层没扣掉"，于是人行道里保留了车行面、平台压回车行道
       * ——实测宽路口（主干网 17 m 车行 + 转角平台）下会冒出 117 m² 的
       * apron∩车行、2210 m² 的 walk∩apron。逐片重试把失败限制在真正病态
       * 的那一片上。
       */
      const out: PlanSurface[] = [];
      for (const s of a) {
        try {
          out.push(...surfaceSubtract([s], b).filter((q) => M2(surfaceArea(q)) > 1));
        } catch {
          out.push(s);
        }
      }
      return out;
    }
  };
  /**
   * B0..B3 已全部圆角化，四层同心包含；派生层只是相邻两层的差，
   * 路缘 / 人行 / 绿带的内边界因此就是**同一条圆弧**，不再出现
   * 「外面圆、里面直角」的楔形平台。
   *
   * 唯一例外：不同等级相交时内层圆角片会探出外层几米，光靠 `B[k]−B[k−1]`
   * 会漏出 200 m² 级重叠。所以每一层再显式减一次**完整车行面 B0** ——
   * 减的是同一份面，不会把平台切成碎块，只是把数值毛刺还给沥青。
   */
  /** 派生层统一裁回 R：折线简化让边界收缩几厘米，不裁会有一条细边压进街区。
   *  只对派生层做，不对 B[k] 做（B[k] 与 R 共线，自求交是病态输入）。 */
  const cap = (list: PlanSurface[]): PlanSurface[] => {
    if (list.length === 0) return list;
    try {
      const q = surfaceIntersect(list, R).filter((s) => M2(surfaceArea(s)) > 1);
      if (q.length) return q;
    } catch {
      /* 逐片兜底 */
    }
    const out: PlanSurface[] = [];
    for (const s of list) {
      try {
        out.push(...surfaceIntersect([s], R).filter((q) => M2(surfaceArea(q)) > 1));
      } catch {
        out.push(s);
      }
    }
    return out;
  };
  const drive = B[0];
  /** 路口面直接洗环：标线里的路口边线要从**这一份**派生，才能与最终几何一致 */
  const junction = sanitize(cap(surfaceIntersect(drive, zones[0]).filter((s) => M2(surfaceArea(s)) > 1)));
  const carriage = cap(diff(drive, junction));

  /**
   * 路口路缘石线（标线 `jedge`）—— 从**最终路口面**派生。
   *
   * 为什么不能从"路口让开区"（starZone 的产物）派生：
   * 最终路口面是 `车行面 ∩ 让开区`，街角那块没有被任何路带覆盖，会被裁掉；
   * 按让开区画线，线就会伸进那块空地 5~7 m，在图上就是**飘在铺装上的白线**。
   * 现在直接沿最终多边形的内边（内移 0.42 m）走，并且：
   *   · 逐边判断"这条边是不是接着一条路"（往外探 0.8 m，落在车行面里就是口线）
   *     —— 口线不画，所以每条路进出口处会干净地断开；
   *   · 连续的非口线合成一条折线，一个转角一条（不会出现段与段之间的断口）。
   */
  const buildJunctionCurbs = (): void => {
    const d = U(0.42);
    /**
     * 判"这条边是不是路缘"的判据：它是否**与车行面 B0 的某条边完全重合**。
     *
     * 为什么不用"往外探 0.8 m 看是不是落在车行面里"：
     * 路口面本身是 `B0 ∩ 让开区`，边界由两部分拼成 —— 来自 B0 的那部分才是路缘，
     * 来自让开区的那部分是"路在这里继续"（口线）。探点法在让开区比 B0 小的路口
     * 上会全部判成口线（实测 12 个路口一条路缘线都没有）。
     * 按"边重合"判，得到的是 B0 自己的那段圆弧 —— 细分和人行道完全同源。
     */
    /** B0 边索引：4 单位一格，判断"点是否落在 B0 边界上"只看附近几格 */
    const cell = 4;
    const grid = new Map<number, { ax: number; ay: number; bx: number; by: number }[]>();
    const ckey = (ix: number, iy: number): number => (ix + 4096) * 8192 + (iy + 4096);
    for (const s of drive) {
      const r = s.outer;
      for (let i = 0; i < r.length; i++) {
        const a = r[i];
        const b = r[(i + 1) % r.length];
        const e = { ax: a.x, ay: a.y, bx: b.x, by: b.y };
        for (let ix = Math.floor(Math.min(a.x, b.x) / cell); ix <= Math.floor(Math.max(a.x, b.x) / cell); ix++) {
          for (let iy = Math.floor(Math.min(a.y, b.y) / cell); iy <= Math.floor(Math.max(a.y, b.y) / cell); iy++) {
            const k = ckey(ix, iy);
            const bin = grid.get(k);
            if (bin) bin.push(e);
            else grid.set(k, [e]);
          }
        }
      }
    }
    const carBoxes = carriage.map((q) => ({ q, b: bboxOf(q.outer) }));
    const inCarriage = (p: Pt): boolean =>
      carBoxes.some(({ q, b }) => p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY && insideSurface(p, q));

    /** 点到 B0 边界的最短距离是否小于 tol（tol 用世界单位） */
    const onB0 = (p: Pt, tol = U(0.05)): boolean => {
      const bin = grid.get(ckey(Math.floor(p.x / cell), Math.floor(p.y / cell)));
      if (!bin) return false;
      for (const e of bin) {
        const dx = e.bx - e.ax;
        const dy = e.by - e.ay;
        const L2 = dx * dx + dy * dy;
        const t = L2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p.x - e.ax) * dx + (p.y - e.ay) * dy) / L2));
        if (Math.hypot(p.x - (e.ax + dx * t), p.y - (e.ay + dy * t)) <= tol) return true;
      }
      return false;
    };
    for (const js of junction) {
      const ring = js.outer;
      const cnt = ring.length;
      if (cnt < 3) continue;
      const ccw = ringArea(ring) > 0;
      const inwardOf = (p0: Pt, p1: Pt): Pt => {
        const dx = p1.x - p0.x;
        const dy = p1.y - p0.y;
        const L = Math.hypot(dx, dy) || 1;
        return ccw ? new Pt(-dy / L, dx / L) : new Pt(dy / L, -dx / L);
      };
      /** 顶点内移（斜接，最多 1.5d） */
      const off: Pt[] = ring.map((v, i) => {
        const prev = ring[(i - 1 + cnt) % cnt];
        const next = ring[(i + 1) % cnt];
        const n1 = inwardOf(prev, v);
        const n2 = inwardOf(v, next);
        let mx = n1.x + n2.x;
        let my = n1.y + n2.y;
        const ml = Math.hypot(mx, my);
        if (ml < 1e-6) {
          mx = n1.x;
          my = n1.y;
        } else {
          mx /= ml;
          my /= ml;
        }
        const cosHalf = Math.max(0.4, mx * n1.x + my * n1.y);
        const k = Math.min(d / cosHalf, d * 1.5);
        return new Pt(v.x + mx * k, v.y + my * k);
      });
      /**
       * 逐边判口线：边的中点**不在 B0 边界上** = 口线（路从这里继续）。
       * 用"中点是否贴 B0 边界"，不用端点相等：布尔运算出来的顶点坐标会有
       * 1e-6 级差异，精确匹配永远对不上（实测 0 段命中）。
       */
      const mouthEdge: boolean[] = [];
      for (let i = 0; i < cnt; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % cnt];
        const mid = new Pt((a.x + b.x) / 2, (a.y + b.y) / 2);
        const n = inwardOf(a, b);
        const probeOut = new Pt(mid.x - n.x * U(0.8), mid.y - n.y * U(0.8));
        /**
         * 两个判据取"或"：
         *   ① 边中点贴在 B0 边界上 → 它来自车行面外轮廓，一定是路缘；
         *   ② 往外 0.8 m 不是沥青 → 外面是铺装/街区，也是路缘。
         * 只用 ①：布尔运算会把顶点重采样，个别路口一条边都对不上（实测只剩 20 段）；
         * 只用 ②：让开区比 B0 小的那 12 个路口整圈被判成口线、一条线都没有。
         */
        const isCurb = onB0(mid) || !inCarriage(probeOut);
        mouthEdge.push(!isCurb);
      }
      let run: Pt[] = [];
      const flush = (): void => {
        if (run.length < 2) {
          run = [];
          return;
        }
        /**
         * 只留"外侧不是沥青"的折线。
         *
         * 路口面是 `B0 ∩ 让开区`，凸包偶尔在路口内部咬出一个凹口；那个凹口
         * 也被车行面填着（看着还是一整块沥青），沿它画一圈线就成了**沥青中间
         * 的一根孤线**（截图里那根悬空的小弧）。
         * 判据：折线中点两侧 0.8 m 都还是沥青 → 它不在路缘上，丢掉。
         */
        const k = Math.floor(run.length / 2);
        const a = run[Math.max(0, k - 1)];
        const b = run[Math.min(run.length - 1, k)];
        const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const nx = -(b.y - a.y) / L;
        const ny = (b.x - a.x) / L;
        const m = run[k];
        const p1 = new Pt(m.x + nx * U(0.8), m.y + ny * U(0.8));
        const p2 = new Pt(m.x - nx * U(0.8), m.y - ny * U(0.8));
        const floating = inCarriage(p1) && inCarriage(p2);
        /**
         * 出口前做两次 Chaikin 平滑。
         *
         * 路口面的转角圆弧是**多边形**（分段数与道路面一致，通常 4~8 段），
         * 直接沿线画出来就是折线（用户："更像折线，希望更圆一些"）。
         * 标线是 15 cm 宽的贴地白线，平滑 1~2 次不会跑出沥青（偏移 < 0.2 m），
         * 却能把转角读成圆弧 —— 几何（沥青面、街区）不动，只美化标线。
         */
        if (!floating) jArcs.push(chaikin(run, 2));
        run = [];
      };

      // 从一条口线之后开始绕一圈，避免跨过环起点时被切成两段
      let startIdx = 0;
      for (let i = 0; i < cnt; i++) {
        if (mouthEdge[i]) {
          startIdx = (i + 1) % cnt;
          break;
        }
      }
      /** 顶点是否凹：凹点处两侧内移方向相反，连过去会横切过沥青 */
      const concave = (i: number): boolean => {
        const prev = ring[(i - 1 + cnt) % cnt];
        const v = ring[i];
        const next = ring[(i + 1) % cnt];
        const cross = (v.x - prev.x) * (next.y - v.y) - (v.y - prev.y) * (next.x - v.x);
        return ccw ? cross < -1e-9 : cross > 1e-9;
      };
      for (let step = 0; step < cnt; step++) {
        const i = (startIdx + step) % cnt;
        if (mouthEdge[i]) {
          flush();
          continue;
        }
        if (run.length === 0) run.push(off[i]);
        run.push(off[(i + 1) % cnt]);
        // 走到凹点/口线就断开：再连下去这条线会横切进沥青里（截图里那种斜穿线）
        const nextIdx = (i + 1) % cnt;
        if (mouthEdge[nextIdx] || concave(nextIdx)) flush();
      }
      flush();
    }
  };
  buildJunctionCurbs();
  const curb = cap(diff(B[1], drive));
  const walkAll = cap(diff(B[2], [...B[1], ...drive]));
  // 绿带在路口按垂线收头，且转角整块让开（绿化不进转角，见 cornerZones）
  const vergeRawPre = diff(R, B[2]);
  const verge = diff(vergeRawPre, [...yieldZones, ...cornerZones, ...drive]);
  /**
   * 路口转角平台 = 人行环带落在转角区里的那一块。**只用于记账**。
   */
  const platform = cap(
    surfaceIntersect(walkAll, cornerZones).filter((s) => M2(surfaceArea(s)) > 1)
  );

  /**
   * 铺装 = **R 内除车行面 / 路缘 / 绿带之外的一切**，一整片。
   *
   * 之前拆成「人行道 − 转角平台」「R − 已分配」再分两块铺，结果是：
   *   · 两块之间的边界由「圆 ∩ 环带」几何决定，全是尖角锯齿；
   *   · 绿带被切掉的每一个缺口都要单独补一块，补出来的形状是斜切楔形
   *     （用户三张红圈截图里那些"伸进路面的米色舌头/直角台阶"）。
   * 地面本来就是一片：转角、绿带缺口、折线简化的残差都只是它的一部分。
   * 分成一整片之后，可见轮廓只剩三条 —— R 边界（街区侧，6 m 圆弧）、
   * 车行面边界（路缘线，同心圆弧）、绿带禁区边界（臂端横断线 + 转角直连边），
   * 全是规整的几何，不再有拼接缝。
   */
  /**
   * 残余 = 绿带环带里落在禁区（路口 / 转角）内的那一块。**只在小片集合上做布尔**。
   *
   * 直接写 `R − drive − curb − verge` 语义等价，但那是「一张 28 万 m² 的大面
   * 减去 200 多片小面」，实测把一座城的生成从 3 s 拖到 37 s；而这里所有项
   * 都是已经算好的小片，差集瞬间完成。
   */
  const vergeRaw = vergeRawPre;
  const apronRest = diff(vergeRaw, verge);
  /**
   * 不做"粗粒度去重"：试过折叠 0.35 m 以内的点，微边 6001→4208，
   * 但边界最多位移 0.35 m —— `curb × walk` 出现 51 m² 重叠、人行道压到街区 9 m²，
   * `f3-road` 的两条"层间零重叠"断言直接红，视觉也没改善。整段撤掉。
   */
  const sidewalk = unionPolys([...walkAll, ...apronRest]);
  const apron = platform;
  tick('layers');

  let maneuversStat = { junctions: 0, arms: 0, links: 0 };

  // ---------------- 标线（只认车行面 B0，与路口 reach 同一份）
  tick('markings-pre');
  /**
   * 裁剪用**已拆好的小片**（carriage + junction），不要传 B[0]。
   *
   * B[0] 是整张车行面 union 成的**一片 25 万 m² 的大多边形**：bbox 过滤对它
   * 完全失效，3500 段标线每条都要跟这一整片做一次布尔 —— 实测 31.8 s。
   * 拆开的片每片只有一条街那么大，bbox 一筛就只剩 1~2 片。
   */
  const mk = buildMarkings(graph, [...carriage, ...junction], { secOf, jApp, blockers: junction, faces, jArcs });
  tick('markings');
  {
    let arms = 0;
    let links = 0;
    for (const apps of jApp.values()) {
      const mv = buildJunctionManeuvers(apps, secOf);
      arms += mv.arms.length;
      links += mv.links.length;
    }
    maneuversStat = { junctions: jApp.size, arms, links };
    notes.push(
      `路口转向（车道级 maneuver graph）：${jApp.size} 个路口 / ${arms} 个进口 / ${links} 条车道连接` +
        `（直行 ${links} 中的逐车道连接 + 每个左/右转各 1 条）`
    );
  }

  notes.push(
    `路网面：${graph.paths.length} 条街 / ${jApp.size} 个路口 → 一张已圆角的闭合道路用地 ${sum(R).toFixed(0)} m²（街角圆弧 6 m，车行面按断面宽补偿）；街区 = 场地 − 这张面`
  );
  notes.push(
    `同心断面派生：车行 ${sum(carriage).toFixed(0)} + 路口 ${sum(junction).toFixed(0)} / 路缘 ${sum(curb).toFixed(
      0
    )} / 人行 ${sum(sidewalk).toFixed(0)} + 平台 ${sum(apron).toFixed(0)} / 绿带 ${sum(verge).toFixed(0)} m²；标线 ${mk.segs.length} 段`
  );
  notes.push(
    `过街设施：合格路口 ${mk.eligible} → 设斑马线 ${mk.crossings.length} 处（车行道 ≥ ${MIN_CROSSING_WIDTH_M} m、路口中心间距 ≥ ${MIN_CROSSING_GAP_M} m、每处最多正对 2 条）`
  );
  {
    const c = new Map<string, number>();
    for (const m of mk.segs) c.set(m.kind ?? 'other', (c.get(m.kind ?? 'other') ?? 0) + 1);
    const fmt = (k: string): string => `${k} ${c.get(k) ?? 0}`;
    notes.push(
      `标线（按 GB 5768.3 分级）：${['center', 'lane', 'edge', 'cross', 'stop', 'arrow', 'bus', 'bike', 'slow'].map(fmt).join(' / ')} 段`
    );
  }

  return {
    carriage: sanitize(carriage),
    junction,
    /** 圆角已是 R 自身的形状，不再有独立的转角铺装层 */
    corner: [],
    curb: sanitize(curb),
    sidewalk: sanitize(sidewalk),
    verge: sanitize(verge),
    apron: sanitize(apron),
    maneuvers: maneuversStat,
    markings: mk.segs,
    crossings: mk.crossings,
    /** 完整道路用地（含路口与圆角）= 扣街区的唯一依据 */
    domain: sanitize(R),
    reserve: sanitize(R),
    roadAreaM2: sum(carriage),
    reserveAreaM2: sum(R),
    cornerAreaM2: 0,
    junctionAreaM2: sum(junction),
    walkAreaM2: sum(sidewalk),
    vergeAreaM2: sum(verge),
    lengthM,
    sections: { arterial: secOf('arterial'), collector: secOf('collector'), local: secOf('local') },
    notes,
  };
}

// ---------------------------------------------------------------- 标线

interface ApproachLike {
  dir: Pt;
  ang: number;
  half: number;
  reach: number;
  cls: RoadPath['cls'];
  edgeId: string;
}

/** 标线兜底：点是否在某个沥青面内（只在断言/调试里用） */
export function markOnAsphalt(m: MarkSeg, asphalt: PlanSurface[]): boolean {
  const p = new Pt(
    m.ring.reduce((a, q) => a + q.x, 0) / m.ring.length,
    m.ring.reduce((a, q) => a + q.y, 0) / m.ring.length
  );
  return asphalt.some((s) => {
    const bb = bboxOf(s.outer);
    return p.x >= bb.minX && p.x <= bb.maxX && p.y >= bb.minY && p.y <= bb.maxY;
  });
}

// ---------------------------------------------------------------- 工具

function dirAtNode(pts: Pt[], at: Pt): Pt {
  if (pts.length < 2) return new Pt(1, 0);
  const first = pts[0];
  const last = pts[pts.length - 1];
  // 端点离 at 更近 → 从该端指向内部
  const dA = Pt.distance(first, at);
  const dB = Pt.distance(last, at);
  const a = dA <= dB ? pts[0] : pts[pts.length - 1];
  const b = dA <= dB ? pts[1] : pts[pts.length - 2];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L = Math.hypot(dx, dy) || 1;
  return new Pt(dx / L, dy / L);
}

function polyLenM(pts: Pt[]): number {
  let s = 0;
  for (let i = 0; i + 1 < pts.length; i++) s += Pt.distance(pts[i], pts[i + 1]) * 7;
  return s;
}

/**
 * 稳健并集。
 *
 * polygon-clipping 在"共享边几乎重合"时会返回两个环（并了个寂寞），
 * 或直接抛错。这里逐块合并，失败就微偏移重试；再失败就原样留下
 * （面积会多算一点，但几何不丢）—— 不允许静默变成成功。
 */
export function unionPolys(list: PlanSurface[]): PlanSurface[] {
  const clean = list.filter((s) => s.outer.length >= 3 && Math.abs(surfaceArea(s)) > 1e-9);
  if (clean.length === 0) return [];
  /**
   * 先批量并一次。
   *
   * `surfaceUnion` 内部就是"一次布尔并完"，比逐对合并快一到两个数量级
   * （逐对：每条新区间都要跟累积体求交，多边形越滚越大）。
   * 只有在批量失败时才退回逐对 —— 逐对的成功率略高，但慢得多。
   */
  if (clean.length > 1) {
    try {
      const out = surfaceUnion(clean).filter((s) => M2(surfaceArea(s)) > 1);
      if (out.length > 0) return out;
    } catch {
      /* 落到逐对 */
    }
  }
  let acc: PlanSurface[] = [clean[0]];
  for (let i = 1; i < clean.length; i++) {
    const b = clean[i];
    let merged = false;
    for (let j = 0; j < acc.length; j++) {
      const u = unionPair(acc[j], b);
      if (u && u.length === 1) {
        acc = acc.map((x, k) => (k === j ? u[0] : x));
        merged = true;
        break;
      }
    }
    if (!merged) acc.push(b);
  }
  return acc.filter((s) => M2(surfaceArea(s)) > 1);
}

function unionPair(a: PlanSurface, b: PlanSurface): PlanSurface[] | null {
  try {
    const u = surfaceUnion([a, b]).filter((q) => M2(surfaceArea(q)) > 0.5);
    if (u.length === 1) return u;
  } catch {
    /* 落到微偏移 */
  }
  try {
    const off = surfaceOffset(a, 0.0008);
    const u = surfaceUnion([...(off.length ? off : [a]), b]).filter((q) => M2(surfaceArea(q)) > 0.5);
    if (u.length === 1) return u;
  } catch {
    /* 放弃 */
  }
  return null;
}

function diffPolys(a: PlanSurface[], b: PlanSurface[]): PlanSurface[] {
  const out: PlanSurface[] = [];
  for (const s of a) {
    try {
      for (const q of surfaceSubtract([s], b)) if (M2(surfaceArea(q)) > 0.6) out.push(q);
    } catch {
      out.push(s);
    }
  }
  return out;
}

function clipToSite(list: PlanSurface[], site: PlanSurface): PlanSurface[] {
  const out: PlanSurface[] = [];
  for (const s of list) {
    try {
      for (const q of surfaceIntersect([s], [site])) if (M2(surfaceArea(q)) > 0.6) out.push(dropPins(q));
    } catch {
      out.push(s);
    }
  }
  return out;
}

/** 布尔留下的针孔（<20 m² 的"洞"其实是数值毛刺，路面不可能有中庭） */
function dropPins(s: PlanSurface): PlanSurface {
  if (s.holes.length === 0) return s;
  const holes = s.holes.filter((h) => Math.abs(M2(surfaceArea({ outer: h, holes: [] }))) >= 20);
  return holes.length === s.holes.length ? s : { outer: s.outer, holes };
}

/** 路口的一条入射分支（世界单位） */
export interface JunctionApproach {
  dir: Pt;
  ang: number;
  /** 车行半幅 */
  half: number;
  /** 道路用地半宽（含路缘 / 人行道 / 绿带） */
  outer: number;
  /** 路口面沿这条分支的延伸长度 */
  reach: number;
}

/**
 * 任意 N 叉路口的**人行道收头线**距离 —— 用户补充的《Houdini 路网》分法。
 *
 * 以三叉口为例（对任意 N 叉同样成立）：
 *   图 1：curve1/2/3 交于 P，各自生成的带子 ribbon1/2/3 两两相交得 p1,p2,p3；
 *   图 2：把每个 p 投到「Y 形骨架」的所有分支上，取最近的分支得 p'；落在
 *         curve2 上的最近点可能有两个（p1'、p2'），比较弧线 Pp1' / Pp2'，
 *         **取更长的 p2'** 作为 curve2 分支上人行道的位置；
 *   图 3：过 p2' 作 curve2 的垂线，就是这条分支的人行道端线。
 *
 * 于是每条分支只有一条笔直收头线（垂直于自身中心线），不需要凸包 / 圆角盘 /
 * 每条路各削两个圆耳朵。返回值 = 沿 `dir` 从节点量出去的距离，与 apps 同序。
 */
export function junctionCutDistances(apps: JunctionApproach[], at: Pt, limit = true): number[] {
  const n = apps.length;
  const base = apps.map((A) => A.reach * 0.55 + A.outer * 0.22);
  if (n < 3) return base;

  // ① 相邻两分支的边线交点 p（ribbon 的外边界 = outer）。
  //    A 用左法线、B 用右法线，交点正好落在 A、B 夹出的那个角上。
  const corners: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const A = apps[i];
    const B = apps[(i + 1) % n];
    const nA = new Pt(-A.dir.y, A.dir.x);
    const nB = new Pt(B.dir.y, -B.dir.x);
    const pA = new Pt(at.x + nA.x * A.outer, at.y + nA.y * A.outer);
    const pB = new Pt(at.x + nB.x * B.outer, at.y + nB.y * B.outer);
    const p = lineIntersect(pA, A.dir, pB, B.dir);
    // 锐角路口的交点会飞到很远，不能让它把整条街铺成广场
    if (p && Pt.distance(p, at) <= Math.max(A.outer, B.outer) * 6) corners.push(p);
  }

  // ②③ 每个 p 投到最近的分支得 p'；同一分支可能收到多个 p'（图 2 里 curve2
  //     就同时有 p1'、p2'），比较弧线 Pp' 取**最长**的那个作为收头位置。
  //     对称路口里 p 到相邻两臂距离完全相等，只取唯一最近会漏掉一整条臂，
  //     所以容差内的近似平局全部记入 —— 这才对得上资料「任意 N 叉」的说法。
  const cuts = apps.map(() => 0);
  for (const p of corners) {
    const vx = p.x - at.x;
    const vy = p.y - at.y;
    const proj: { j: number; t: number; dist: number }[] = [];
    for (let j = 0; j < n; j++) {
      const d = apps[j].dir;
      const t = vx * d.x + vy * d.y;
      if (t < 0) continue;
      proj.push({ j, t, dist: Math.hypot(vx - t * d.x, vy - t * d.y) });
    }
    if (proj.length === 0) continue;
    const bestD = Math.min(...proj.map((q) => q.dist));
    const tol = Math.max(U(0.35), bestD * 0.03);
    for (const q of proj) {
      if (q.dist > bestD + tol) continue;
      cuts[q.j] = Math.max(cuts[q.j], q.t);
    }
  }

  // ④ 限幅：解析值决定「各分支长度可以不同」，旧口径决定整体尺度。
  //    不设上限时锐角路口会把平台铺到下一个路口，不设下限时窄支路盖不住车行核心。
  //    `limit=false` 用于测试/诊断，直接看解析解本身。
  if (!limit) return cuts;
  return cuts.map((c, i) => Math.max(base[i] * 0.72, Math.min(base[i] * 2.4, c)));
}

/**
 * 一个转角的"圆弧替换直角"多边形：两个切点 T1/T2、外角点 P、以及它们之间的圆弧。
 *
 * 返回的环 = [T1, P, T2, 弧线(T2→T1)]，围住的正是**角点与圆弧之间那一块**。
 *
 * 现在只用于「外侧转角铺装」：半径取侧带宽，并进道路用地并把地块咬成圆角。
 * 车行核心不再并这块 —— 并进去会在 apron 上咬出半圆凹口（见 junction 段注释）。
 *
 * `da/db` 是两条路各自被量到的偏移距离（车行半幅或用地半宽），
 * 两个角点取这两条偏移线的交点 —— 这是唯一在锐角路口也不会算错的做法。
 */
function cornerPiece(
  at: Pt,
  A: { dir: Pt; ang: number },
  B: { dir: Pt; ang: number },
  da: number,
  db: number,
  r: number
): Pt[] | null {
  if (Math.abs(Math.sin(B.ang - A.ang)) < 0.2) return null; // 近共线：这里没有角
  const nA = new Pt(-A.dir.y, A.dir.x);
  const nB = new Pt(B.dir.y, -B.dir.x);
  const pA = new Pt(at.x + nA.x * da, at.y + nA.y * da);
  const pB = new Pt(at.x + nB.x * db, at.y + nB.y * db);
  const P = lineIntersect(pA, A.dir, pB, B.dir);
  if (!P) return null;
  if (Pt.distance(P, at) > Math.max(da, db) * 4.5) return null;

  // 两条边的切向：**背离路口**（= 各自 dir 的正方向）。
  // 方向搞反的话，圆弧会落在路口里面 —— 图上就是"绿地角上贴了一个粉色圆弧补丁"，
  // 而地块的角仍然是方的（实测截图里那个绿方块就是这么来的）。
  const uA = new Pt(A.dir.x, A.dir.y);
  const uB = new Pt(B.dir.x, B.dir.y);
  const cosang = Math.max(-1, Math.min(1, uA.x * uB.x + uA.y * uB.y));
  const ang = Math.acos(cosang);
  if (ang < 0.18 || ang > Math.PI - 0.12) return null;
  const halfAng = ang / 2;
  const bx = uA.x + uB.x;
  const by = uA.y + uB.y;
  const bl = Math.hypot(bx, by);
  if (bl < 1e-6) return null;
  const bis = new Pt(bx / bl, by / bl);

  // 切点：沿线往路口里退 t；t 太大说明这个角非常锐，夹住不让它拉到路中间
  const tMax = Math.min(da, db) * 1.35;
  const t = Math.min(r / Math.tan(halfAng), tMax);
  const rr = Math.min(r, t * Math.tan(halfAng) + 1e-9);
  const T1 = new Pt(P.x + uA.x * t, P.y + uA.y * t);
  const T2 = new Pt(P.x + uB.x * t, P.y + uB.y * t);
  const C = new Pt(P.x + bis.x * (rr / Math.sin(halfAng)), P.y + bis.y * (rr / Math.sin(halfAng)));
  if (!Number.isFinite(C.x) || !Number.isFinite(C.y)) return null;

  let a1 = Math.atan2(T1.y - C.y, T1.x - C.x);
  const a2 = Math.atan2(T2.y - C.y, T2.x - C.x);
  let d = a2 - a1;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  const N = 5;
  const arcPts: Pt[] = [];
  for (let k = 1; k < N; k++) {
    const a = a2 - (d * k) / N; // 从 T2 往 T1 走
    arcPts.push(new Pt(C.x + Math.cos(a) * rr, C.y + Math.sin(a) * rr));
  }
  let ring = [T1, P, T2, ...arcPts];
  // 统一成逆时针，布尔库对朝向敏感
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const q = ring[i];
    const w = ring[(i + 1) % ring.length];
    area += q.x * w.y - w.x * q.y;
  }
  if (area < 0) ring = ring.reverse();
  return cleanRing(ring);
}

/**
 * 侧带自交的**便宜判据**（替代 O(n²) 的全环自交检测）。
 *
 * 修形之后每条街有几十到上百个折点，`ringSelfIntersects` 是 n² 量级：
 * 600 片侧带 × 200 点² 直接把这一步从 0.2 s 拖到 41 s（实测）。
 *
 * 但侧带会自交只有一种成因：**内偏移在尖角处翻过去**。
 * 判据也就一条：某个折点的转角够大，且内偏移量大到超过相邻段长的一半。
 * 缓弯（修形后的常态）永远不触发，于是这一步变成 O(n)。
 */
function riskyBand(pts: Pt[], h: number): boolean {
  const n = pts.length;
  for (let i = 1; i + 1 < n; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const c = pts[i + 1];
    const l1 = Pt.distance(a, b);
    const l2 = Pt.distance(b, c);
    if (l1 < 1e-9 || l2 < 1e-9) continue;
    const d1x = (b.x - a.x) / l1;
    const d1y = (b.y - a.y) / l1;
    const d2x = (c.x - b.x) / l2;
    const d2y = (c.y - b.y) / l2;
    const turn = Math.acos(Math.max(-1, Math.min(1, d1x * d2x + d1y * d2y)));
    if (turn < 0.18) continue;
    // 内偏移在第 i 点被"吃掉" h·tan(θ/2)；超过段长就会翻折成自交。
    // （写成 h / cos(θ/2) 是错的：缓弯上 h 有 10 m、段长只有 3.4 m，
    //   那个式子对任何 10° 以上的折点都成立，等于永远走慢路径 —— 实测 43 s。）
    if (h * Math.tan(turn / 2) > 0.95 * Math.min(l1, l2)) return true;
  }
  return false;
}

/**
 * Chaikin 角切割平滑（端点保留）。
 * 输入 n 点 → 输出 2n-2 点，两轮之后折角基本消失。
 */
function chaikin(pts: Pt[], rounds: number): Pt[] {
  let cur = pts;
  for (let r = 0; r < rounds; r++) {
    if (cur.length < 3) return cur;
    const out: Pt[] = [cur[0]];
    for (let i = 0; i + 1 < cur.length; i++) {
      const a = cur[i];
      const b = cur[i + 1];
      out.push(new Pt(a.x * 0.75 + b.x * 0.25, a.y * 0.75 + b.y * 0.25));
      out.push(new Pt(a.x * 0.25 + b.x * 0.75, a.y * 0.25 + b.y * 0.75));
    }
    out.push(cur[cur.length - 1]);
    cur = out;
  }
  return cur;
}

/** 折线上按 [0,1] 参数取点（总长为权） */
function lerpPoly(pts: Pt[], t: number): Pt {
  let total = 0;
  const segs: number[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const L = Pt.distance(pts[i], pts[i + 1]);
    segs.push(L);
    total += L;
  }
  if (total < 1e-9) return new Pt(pts[0].x, pts[0].y);
  let want = Math.max(0, Math.min(1, t)) * total;
  for (let i = 0; i < segs.length; i++) {
    if (want <= segs[i] || i === segs.length - 1) {
      const f = segs[i] < 1e-9 ? 0 : want / segs[i];
      return new Pt(pts[i].x + (pts[i + 1].x - pts[i].x) * f, pts[i].y + (pts[i + 1].y - pts[i].y) * f);
    }
    want -= segs[i];
  }
  return new Pt(pts[pts.length - 1].x, pts[pts.length - 1].y);
}

function lineIntersect(p1: Pt, d1: Pt, p2: Pt, d2: Pt): Pt | null {
  const den = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((p2.x - p1.x) * d2.y - (p2.y - p1.y) * d2.x) / den;
  return new Pt(p1.x + d1.x * t, p1.y + d1.y * t);
}

/** 供街区扣减：把所有道路用地并成一份，减少下游布尔次数 */
export function mergeReserve(reserve: PlanSurface[]): PlanSurface[] {
  return unionPolys(reserve);
}
