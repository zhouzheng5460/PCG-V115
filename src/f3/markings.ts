// F3 · 道路交通标线自动生成（按 GB 5768.3 的分级规则）
//
// 生成顺序严格照规范的顺序走，不"先画线再找理由"：
//   道路分级 → 车道划分 → 中心线与边缘线 → 路口识别 → 停止线与人行横道
//   → 导向箭头 → 特殊标线（公交道 / 非机动车道 / 减速）→ 几何裁剪
//
// 四条硬约束（踩过的坑写在这里，改代码前先读）：
//   ① 标线必须**从车道模型推出来**（lanes.ts），不允许再按 3.5 m 硬切：
//      车道分界线画在 `lane.edge` 上，边缘线画在最外侧车道的 `edge` 上 ——
//      三者（中心线 / 分界线 / 边缘线）共用同一个车道划分，位置才对得起来。
//   ② 标线必须**跟随曲率**：中心线是张量流线，本来就是弯的；用直线段近似会
//      在弯道处"穿出"路面。
//   ③ 每条标线最后都要被**车行面裁一次**，并且**不许互相重叠**：
//      线宽按 15 cm（半宽 7.5 cm）画，双黄线才留得出 15 cm 间隙；
//      边缘线在人行横道处断开，不停在斑马线上。
//   ④ 路口内不画边缘线（`jedge` 已移除，见文件末尾说明）：
//      路口本身就是一张闭合面，它的边界就是路缘石线。
//
// 不做什么（写了原因，避免下次又加回来）：
//   · 不画导流线：这套路网没有匝道合流/分流，也没有交通岛实体，
//     "在需要的地方画" = 这里不需要。硬画只会变成路口里的随机斜纹。
//   · 不画"BUS"字样：需要文字排版，属于贴图/纹理层，不属于几何标线。

import { Pt } from '../core/geom';
import { unionSurfaceSet } from '../core/clipper';
import { selfIntersects } from '../town/planning/core/surface';
import type { PathGraph, RoadClass3, RoadPath, RoadSection } from './types';
import { M2, U, cleanRing, polyLen } from './geom';
import { assignTurns, lanePointAt, lanesOfSide, lanesPerDir, maneuversOf, type Lane, type Turn } from './lanes';
import {
  bboxOf,
  insideSurface,
  surfaceIntersect,
  surfaceSubtract,
  type PlanSurface,
} from '../town/planning/core/surface';

/** 过街设施门槛：车行道全宽（米）。窄于双向两车道的路口不设独立斑马线 */
export const MIN_CROSSING_WIDTH_M = 12;
/** 路口过街设施最小中心间距（米） */
export const MIN_CROSSING_GAP_M = 80;

/**
 * 人行横道**后退**距离（米）：从路口面（让开区收头线）往外退。
 *
 * 实测对方（用户截图）：斑马线紧贴转角圆弧，行人站在弧上等灯，停止线又压在
 * 斑马线上。真实道路的斑马线在转角圆弧之外 2~4 m，给右转车留出转弯空间，
 * 也让停止线有一条清晰的横向位置。
 */
export const CROSS_SETBACK_M = 3.0;
/** 人行横道标线深度（米）：GB 5768.3 人行横道线宽 40~45 cm、全长 ≥ 3 m */
export const CROSS_DEPTH_M = 3.0;

/** 标线类型：给验收断言按类型分组统计用（渲染只看 yellow） */
export type MarkKind =
  | 'center'
  | 'lane'
  | 'edge'
  | 'stop'
  | 'cross'
  | 'arrow'
  | 'slow'
  | 'bus'
  | 'bike';

export interface MarkSeg {
  ring: Pt[];
  yellow: boolean;
  kind?: MarkKind;
}

/** 路口的一个进口：从路口中心指向外部（`dir` 朝外） */
export interface Approach {
  dir: Pt;
  ang: number;
  half: number;
  reach: number;
  cls: RoadClass3;
  edgeId: string;
}

export interface MarkingOptions {
  /** 沿路布灯的判断也复用这份断面表 */
  secOf: (c: RoadClass3) => RoadSection;
  /** 每个路口 → 进口列表 */
  jApp: Map<string, Approach[]>;
  /**
   * 路口面（车行核心）。**普通标线必须让开它**。
   *
   * 断面标线是按 path 的弧长铺的，`face` 只能估个大概：多叉路口两条臂
   * 夹角很小时，收头距离解析值很小，车道线/边缘线就一路画到路口中心，
   * 几条臂的线在中间交叉成一团白色乱麻。GB 5768.3 的要求是「路口范围内
   * 截断普通车道分界线」——这里用布尔保证；同时这批面也是路口边线的来源。
   */
  blockers?: PlanSurface[];
  /**
   * 每个路口每条进口的「路口面收头距离」：`${nodeId}|${edgeId}` → 世界单位。
   * 由 roadgeom 用**同一份** star zone 收头距离给出，标线不再自己估。
   */
  faces?: Map<string, number>;
  /** 路口转角圆弧的中心线（roadgeom 解析给出，已向沥青内挪 0.42 m） */
}

export interface MarkingResult {
  segs: MarkSeg[];
  /** 实际设了过街设施的路口中心（验收断言用） */
  crossings: Pt[];
  /** 通过资格筛选的路口数（被间距规则淘汰的不算） */
  eligible: number;
}

const CLASS_RANK: Record<RoadClass3, number> = { arterial: 3, collector: 2, local: 0 };
/** 标线标准宽度（GB 5768.3）：15 cm —— 这里是**半宽**，写成 15 cm 会让双黄线重叠 */
const LW = U(0.15) / 2;

/**
 * 被"标线自检"丢掉的段数（诊断用，不参与几何）。
 * 正常情况下应当是 0；非 0 说明某个生成器吐了闭合环/自交折线。
 */
export let markingDroppedCount = 0;
/** 车道宽（米）—— 只用于旧接口的兜底，真实车道由 lanes.ts 给出 */
const LANE_W = U(3.5);

/**
 * 中心线样式（GB 5768.3 §4.3）：
 *   · 双向四车道及以上、或主干路 → **双黄实线**（禁止跨越）
 *   · 次干路 → **黄色虚线**（允许借道超车）
 *   · 支路且车行道 ≥ 7 m → 单黄虚线；更窄的支路不画中心线
 */
function centerStyle(cls: RoadClass3, carriageM: number, lanes: number): 'double' | 'dash' | 'none' {
  if (cls === 'arterial' && lanes >= 2) return 'double';
  if (cls === 'collector') return 'dash';
  if (cls === 'local' && carriageM >= 7) return 'dash';
  return 'none';
}

/**
 * 沿折线取一段**整条**等宽带（实线用）。
 *
 * 逐段出四边形会让一条边缘线变成几十个 0.6 m² 的小面，既浪费又容易在接缝处
 * 出现 1 mm 的缝。这里沿折线走一遍，把左右偏移点各收成一条边，首尾连成
 * 一个多边形 —— 一条街的实线就是一片。
 */
function band(pts: Pt[], s0: number, s1: number, off: number, hw: number): Pt[] | null {
  if (s1 - s0 < 1e-6) return null;
  const left: Pt[] = [];
  const right: Pt[] = [];
  let acc = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const L = Pt.distance(a, b);
    if (L < 1e-9) continue;
    const segStart = acc;
    const segEnd = acc + L;
    acc = segEnd;
    const lo = Math.max(s0, segStart);
    const hi = Math.min(s1, segEnd);
    if (hi - lo < 1e-9) continue;
    const dx = (b.x - a.x) / L;
    const dy = (b.y - a.y) / L;
    const nx = -dy;
    const ny = dx;
    const p0 = new Pt(a.x + dx * (lo - segStart), a.y + dy * (lo - segStart));
    const p1 = new Pt(a.x + dx * (hi - segStart), a.y + dy * (hi - segStart));
    left.push(new Pt(p0.x + nx * (off + hw), p0.y + ny * (off + hw)));
    right.push(new Pt(p0.x + nx * (off - hw), p0.y + ny * (off - hw)));
    left.push(new Pt(p1.x + nx * (off + hw), p1.y + ny * (off + hw)));
    right.push(new Pt(p1.x + nx * (off - hw), p1.y + ny * (off - hw)));
  }
  if (left.length < 2) return null;
  const ring = cleanRing([...left, ...right.reverse()]);
  return ring.length >= 3 ? ring : null;
}

/** 沿折线取一段等宽带，按段切开（标线很短、必须跟着折点时用） */
function ribbon(pts: Pt[], s0: number, s1: number, off: number, hw: number): Pt[][] {
  const one = band(pts, s0, s1, off, hw);
  return one ? [one] : [];
}

/** 沿折线按 [dash, gap] 铺虚线 */
function dashes(pts: Pt[], s0: number, s1: number, off: number, hw: number, dashU: number, gapU: number): Pt[][] {
  const out: Pt[][] = [];
  for (let s = s0; s < s1; s += dashU + gapU) {
    out.push(...ribbon(pts, s, Math.min(s + dashU, s1), off, hw));
  }
  return out;
}

/** 导向箭头：沿 `ang` 指向的一方，杆长 `len`、头宽 `head` */
function arrowRing(c: Pt, ang: number, halfLen: number, shaftHalf: number, headHalf: number): Pt[] {
  const cs = Math.cos(ang);
  const sn = Math.sin(ang);
  const at = (u: number, v: number): Pt => new Pt(c.x + cs * u - sn * v, c.y + sn * u + cs * v);
  const neck = halfLen * 0.35;
  return [
    at(-halfLen, -shaftHalf),
    at(neck, -shaftHalf),
    at(neck, -headHalf),
    at(halfLen, 0),
    at(neck, headHalf),
    at(neck, shaftHalf),
    at(-halfLen, shaftHalf),
  ];
}

/**
 * 左右转箭头：竖杆 + 横杆 + 三角头（三段，同一个图层）。
 *
 * 形状按 GB 5768.3 的导向箭头：从停止线一侧看是"├─▶"的 L 形。
 * 拆成三块而不是一个凹多边形：凹多边形在布尔裁剪里最容易退化成自交。
 *
 * `turn` 的符号约定：+1 = 行进方向的**左侧**（世界坐标 y 向上）。
 */
function turnArrow(
  c: Pt,
  ang: number,
  halfLen: number,
  shaftHalf: number,
  headHalf: number,
  turn: -1 | 1
): Pt[][] {
  const cs = Math.cos(ang);
  const sn = Math.sin(ang);
  /** u = 沿行进方向（正 = 朝路口），v = 侧向（turn 决定往哪边） */
  const at = (u: number, v: number): Pt => new Pt(c.x + cs * u - sn * v, c.y + sn * u + cs * v);
  const sh = shaftHalf;
  const reach = halfLen * 0.5; // 横杆长度（再长就会压到邻道的箭头）
  const headLen = headHalf * 0.9; // 三角头长度
  const vTip = turn * reach;
  const vEnd = turn * (reach + headLen);
  const ring = (pts: [number, number][]): Pt[] => cleanRing(pts.map(([u, v]) => at(u, v)));
  const lo = (a: number, b: number): number => Math.min(a, b);
  const hi = (a: number, b: number): number => Math.max(a, b);
  return [
    // 竖杆：从尾端到拐点
    ring([
      [-halfLen, -sh],
      [sh, -sh],
      [sh, sh],
      [-halfLen, sh],
    ]),
    // 横杆：拐点向侧向
    ring([
      [-sh, lo(sh, vTip)],
      [sh, lo(sh, vTip)],
      [sh, hi(sh, vTip)],
      [-sh, hi(sh, vTip)],
    ]),
    // 三角头：底边垂直于侧向，尖朝侧向
    ring([
      [-headHalf, vTip],
      [headHalf, vTip],
      [0, vEnd],
    ]),
  ];
}

/**
 * 从路口节点出发，**沿这条边的实际走向**走 `d` 距离。
 *
 * 之前所有路口标线（斑马线 / 停止线 / 箭头）都是 `路口中心 + 臂方向 × d`
 * 直线外推。直路上没问题，但张量流线是弯的 —— 臂的 `dir` 只是节点处的切线，
 * 外推十几米就偏离车行面，标线被 `clipMarksToAsphalt` 整条裁掉。
 * 实测：242 段箭头里只有 6 段活下来，其余全在弯道上被裁没了。
 */
function alongEdge(
  graph: PathGraph,
  edgeId: string,
  nodeId: string,
  d: number
): { at: Pt; dir: Pt } | null {
  const e = graph.edges.get(edgeId);
  const n = graph.nodes.get(nodeId);
  if (!e || !n || e.pts.length < 2) return null;
  const head = e.pts[0];
  const tail = e.pts[e.pts.length - 1];
  const pts = Pt.distance(head, n.at) <= Pt.distance(tail, n.at) ? e.pts : e.pts.slice().reverse();
  let acc = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const L = Pt.distance(a, b);
    if (L < 1e-9) continue;
    if (acc + L >= d) {
      const t = (d - acc) / L;
      return {
        at: new Pt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t),
        dir: new Pt((b.x - a.x) / L, (b.y - a.y) / L),
      };
    }
    acc += L;
  }
  return null;
}

/** 以 `at` 为原点、沿 `dir` 的 u 区间与法向 v 区间围出的矩形（标线专用） */
function spanRect(at: Pt, dir: Pt, u0: number, u1: number, v0: number, v1: number): Pt[] {
  const nx = -dir.y;
  const ny = dir.x;
  const p = (u: number, v: number): Pt => new Pt(at.x + dir.x * u + nx * v, at.y + dir.y * u + ny * v);
  return cleanRing([p(u0, v0), p(u1, v0), p(u1, v1), p(u0, v1)]);
}

/**
 * 标线主入口。
 *
 * `graph` 已经从 roadgeom 拿到 `widthU`（= 车行道全宽），这里只做"读等级 →
 * 推车道 → 铺线"的事，不碰任何道路几何。
 */
export function buildMarkings(graph: PathGraph, asphalt: PlanSurface[], opts: MarkingOptions): MarkingResult {
  const out: MarkSeg[] = [];
  const tc = typeof process !== 'undefined' && process.env?.F3_TC;
  let tMark = Date.now();
  const lap = (tag: string): void => {
    if (!tc) return;
    const now = Date.now();
    console.log(`[mk] ${tag} ${now - tMark} ms  segs=${out.length}`);
    tMark = now;
  };
  const { secOf, jApp, faces } = opts;
  /** 每个路口每个进口允许的转向（lane 分配用） */
  const mvsOf = new Map<string, Turn[]>();
  for (const apps of jApp.values()) {
    for (const [eid, turns] of maneuversOf(apps)) mvsOf.set(eid, turns);
  }
  const gapU = U(MIN_CROSSING_GAP_M);
  const setback = U(CROSS_SETBACK_M);
  const depth = U(CROSS_DEPTH_M);

  /** 路口面对该端点的收头距离（世界单位） */
  const faceOf = (path: RoadPath, end: 0 | 1): number => {
    const nid = end === 0 ? path.nodeIds[0] : path.nodeIds[path.nodeIds.length - 1];
    const eid = end === 0 ? path.edgeIds[0] : path.edgeIds[path.edgeIds.length - 1];
    const f = faces?.get(`${nid}|${eid}`);
    if (f !== undefined) return f;
    const a = jApp.get(nid)?.find((q) => q.edgeId === eid);
    return a?.reach ?? 0;
  };

  // ---------------- ① 中心线 / 车道分界线 / 边缘线 / 公交·非机动车道
  for (const p of graph.paths) {
    if (p.pts.length < 2) continue;
    const s = secOf(p.cls);
    const total = polyLen(p.pts);
    const f0 = faceOf(p, 0);
    const f1 = faceOf(p, 1);
    if (total < U(6)) continue;

    const lanesR = lanesOfSide(s, 1); // 右侧（来车方向）
    const lanesL = lanesOfSide(s, -1);
    const nLane = lanesR.length;
    /** 边缘线位置 = 最外侧车道的边界（已扣 0.25 m 富余，正好压在沥青边缘内侧） */
    const edgeOff = lanesR[nLane - 1].edge;

    /**
     * 纵向标线分三段（"人行横道处断开"是规范要求，也是"不许重叠"的来源）：
     *   · 近端小段：路口面 → 人行横道 —— 只画边缘线（这一段是转角圆弧外侧）
     *   · 中段：停止线之外 → 对端停止线之外 —— 全部纵向标线
     *   · 远端小段：同上镜像
     */
    const nearZebra = f0 + setback;
    const farZebra = total - f1 - setback;
    // 停止线占 u∈[−0.25, 0.25]，纵向标线再从它外侧 0.3 m 起，避免压线
    const middleA = nearZebra + depth + U(1.1);
    const middleB = farZebra - depth - U(1.1);
    const spans: { s0: number; s1: number; inner: boolean }[] = [];
    const add = (a: number, b: number, inner: boolean): void => {
      if (b - a > U(0.5)) spans.push({ s0: Math.max(0, a), s1: Math.min(total, b), inner });
    };
    add(f0 + U(0.1), nearZebra - U(0.1), false);
    add(middleA, middleB, true);
    add(farZebra + U(0.1), total - f1 - U(0.1), false);

    for (const sp of spans) {
      // 边缘线：白实线，全段连续（GB 5768.3 §4.4）
      for (const side of [-1, 1]) {
        for (const q of ribbon(p.pts, sp.s0, sp.s1, edgeOff * side, LW)) out.push({ ring: q, yellow: false, kind: 'edge' });
      }
      if (!sp.inner) continue;

      /**
       * 中心线（GB 5768.3 §4.3）：双黄实线 / 黄色虚线。
       * 双黄线：两条 15 cm、中间 15 cm 间隙 → 中心在 ±(7.5 + 7.5) = ±15 cm。
       */
      const style = centerStyle(p.cls, s.carriage, nLane);
      if (style === 'double') {
        for (const side of [-1, 1]) {
          for (const q of ribbon(p.pts, sp.s0, sp.s1, side * (LW + U(0.075)), LW))
            out.push({ ring: q, yellow: true, kind: 'center' });
        }
      } else if (style === 'dash') {
        const dash = U(p.cls === 'collector' ? 4 : 3);
        for (const q of dashes(p.pts, sp.s0, sp.s1, 0, LW, dash, U(4))) out.push({ ring: q, yellow: true, kind: 'center' });
      }

      /**
       * 车道分界线：**沿车道模型的边界**画，不再按 3.5 m 硬切。
       *
       * 路口前后各 22 m 是禁止变道区：白虚线转白实线（渐变段 + 导向车道），
       * 导向箭头正好画在实线段里。最外侧那条分界线按等级改成
       * 公交专用道（黄虚线，§4.7.2）或非机动车道（白实线，§5.4）。
       */
      const solidZone = U(22);
      const mid0 = Math.min(sp.s1, sp.s0 + solidZone);
      const mid1 = Math.max(sp.s0, sp.s1 - solidZone);
      for (const side of [-1, 1]) {
        const lanes = side === 1 ? lanesR : lanesL;
        /**
         * 单车道次干路：没有"最外两条车道之间的分界线"，非机动车道线就画在
         * 边缘线内侧 2 m 处（GB 5768.3 §5.4 的非机动车道边线）。不画的话
         * 次干路上一条白线都没有 —— 实测 `bike` 段数为 0。
         */
        if (p.cls === 'collector' && nLane === 1) {
          const off = (edgeOff - U(2.0)) * side;
          if (edgeOff > U(2.6)) {
            for (const q of ribbon(p.pts, sp.s0, sp.s1, off, LW)) out.push({ ring: q, yellow: false, kind: 'bike' });
          }
        }
        for (let k = 0; k < nLane - 1; k++) {
          const off = lanes[k].edge;
          const outermost = k === nLane - 2;
          if (outermost && p.cls === 'arterial') {
            for (const q of dashes(p.pts, sp.s0, sp.s1, off, LW, U(4), U(2)))
              out.push({ ring: q, yellow: true, kind: 'bus' });
            continue;
          }
          if (outermost && p.cls === 'collector') {
            for (const q of ribbon(p.pts, sp.s0, sp.s1, off, LW)) out.push({ ring: q, yellow: false, kind: 'bike' });
            continue;
          }
          /**
           * 车道分界线：路口前 22 m 实线、中段虚线。**短街整段实线**——
           * 旧实现无条件 a=s0..mid0 + 虚线 mid0..mid1 + b=mid1..s1，
           * 街段短于 44 m 时 mid1 < mid0，前后两个实线矩形直接重叠。
           */
          if (sp.s1 - sp.s0 < solidZone * 2) {
            for (const q of ribbon(p.pts, sp.s0, sp.s1, off, LW)) out.push({ ring: q, yellow: false, kind: 'lane' });
          } else {
            for (const q of dashes(p.pts, mid0, mid1, off, LW, U(2.5), U(4)))
              out.push({ ring: q, yellow: false, kind: 'lane' });
            for (const q of ribbon(p.pts, sp.s0, mid0, off, LW)) out.push({ ring: q, yellow: false, kind: 'lane' });
            for (const q of ribbon(p.pts, mid1, sp.s1, off, LW)) out.push({ ring: q, yellow: false, kind: 'lane' });
          }
        }
      }
    }
    void LANE_W;
  }

  // ---------------- ② 路口识别：哪些路口设过街设施
  //
  // 规范口径：交叉口**应**设人行横道，但不是每条线段交点都设；主干路过街
  // 设施 300~500 m、次干路 150~300 m 一处，斑马线最小宽 3 m。
  // 生成器街区模数约 120 m，照搬会全城只剩三四处，所以折算成"路口之间
  // ≥ 80 m、且至少两条非支路相交、车行道 ≥ 12 m"三条可解释的门槛。
  const eligible: { nid: string; arms: Approach[]; score: number }[] = [];
  for (const [nid, apps] of jApp) {
    const main = apps.filter((a) => a.cls !== 'local');
    if (main.length < 2) continue;
    const widestM = Math.max(...main.map((a) => a.half * 2 * 7));
    if (widestM < MIN_CROSSING_WIDTH_M) continue;
    /**
     * **每一条非支路进口都设人行横道**，不再只挑"正对的一对"。
     * 之前只取夹角接近 180° 的一对臂：十字路口就只有左右两条斑马线，
     * 另外两条臂的行人根本过不去。总数由「路口之间 ≥ 80 m」这条规则控制。
     */
    const arms = main.slice().sort((a, b) => CLASS_RANK[b.cls] - CLASS_RANK[a.cls] || b.half - a.half);
    const score = main.reduce((acc, a) => acc + CLASS_RANK[a.cls], 0) * 10 + widestM + CLASS_RANK[arms[0].cls];
    eligible.push({ nid, arms, score });
  }
  eligible.sort((a, b) => b.score - a.score || a.nid.localeCompare(b.nid));

  const crossings: Pt[] = [];
  const chosen: { nid: string; arms: Approach[] }[] = [];
  for (const c of eligible) {
    const at = graph.nodes.get(c.nid)?.at;
    if (!at) continue;
    if (chosen.some((k) => Pt.distance(graph.nodes.get(k.nid)!.at, at) < gapU)) continue;
    chosen.push(c);
    crossings.push(at);
  }

  // ---------------- ③ 停止线 / 人行横道 / 导向箭头
  /** 人行横道 / 导向箭头的占位：这些矩形里的其它标线一律裁掉（"标线不许互相重叠"） */
  const crossZones: PlanSurface[] = [];
  for (const c of chosen) {
    const A0 = graph.nodes.get(c.nid)?.at;
    if (!A0) continue;
    for (const A of c.arms) {
      const ang = Math.atan2(A.dir.y, A.dir.x);
      const face = faces?.get(`${c.nid}|${A.edgeId}`) ?? A.reach;

      // 从路口往外：人行横道（后退 3 m）→ 停止线 → 导向箭头
      const zebraStart = face + setback;
      const stopD = zebraStart + depth + U(0.8);
      const zPt = alongEdge(graph, A.edgeId, c.nid, zebraStart + depth / 2);
      const zAt = zPt?.at ?? new Pt(A0.x + A.dir.x * (zebraStart + depth / 2), A0.y + A.dir.y * (zebraStart + depth / 2));
      const zDir = zPt?.dir ?? A.dir;
      const zAng = Math.atan2(zDir.y, zDir.x);
      const znx = -zDir.y;
      const zny = zDir.x;
      /**
       * 人行横道：条宽 45 cm、间隔 60 cm（GB 5768.3 §6.2.1），
       * **铺满整幅车行道**（双向行人都要走），两端各留 0.5 m 富余。
       */
      const barHalf = U(0.225);
      const pitch = U(1.05);
      const usable = A.half * 2 - U(1.0);
      const bars = Math.max(3, Math.min(20, Math.floor(usable / pitch)));
      const step = usable / bars;
      for (let k = 0; k < bars; k++) {
        const t = (k - (bars - 1) / 2) * step;
        const q = new Pt(zAt.x + znx * t, zAt.y + zny * t);
        out.push({ ring: rectRing(q, depth / 2, barHalf, zAng), yellow: false, kind: 'cross' });
      }
      // 人行横道整体占位（含两侧 0.3 m 富余）：其它标线不许压进来
      crossZones.push({
        outer: spanRect(zAt, zDir, -depth / 2 - U(0.3), depth / 2 + U(0.3), -usable / 2 - U(0.3), usable / 2 + U(0.3)),
        holes: [],
      });

      /**
       * 停止线：**只横跨本方向车行道**（中心线 → 外侧边缘线），
       * 不是整幅路 —— 旧实现居中铺满，对向进口的停止线压到本方向车道上。
       */
      const sPt = alongEdge(graph, A.edgeId, c.nid, stopD);
      const stopAt = sPt?.at ?? new Pt(A0.x + A.dir.x * stopD, A0.y + A.dir.y * stopD);
      const sDir = sPt?.dir ?? A.dir;
      const sHalf = A.half - U(0.25);
      out.push({
        ring: spanRect(stopAt, sDir, -U(0.25), U(0.25), U(0.3), sHalf),
        yellow: false,
        kind: 'stop',
      });

      /**
       * 导向箭头：**从车道派生**，不再按"最内侧左转 / 最外侧右转"硬套。
       *
       * 进口车道是**行进方向右侧**那半幅（右侧通行）：A.dir 由路口指向外，
       * 所以来车沿 −dir 行驶，其右侧就是 (−dir.y, dir.x) = `lanesOfSide(+1)`。
       * 旧实现取的是 −1 侧（对向车道），箭头全画在逆行位置上。
       */
      const sec = secOf(A.cls);
      const mvs = mvsOf.get(A.edgeId) ?? (['through'] as Turn[]);
      const lanes: Lane[] = assignTurns(lanesOfSide(sec, 1), mvs);
      const arrowD = stopD + U(6.0);
      const aPt = alongEdge(graph, A.edgeId, c.nid, arrowD);
      const aAt = aPt?.at ?? new Pt(A0.x + A.dir.x * arrowD, A0.y + A.dir.y * arrowD);
      const hd = aPt?.dir ?? A.dir;
      const head = U(0.95);
      // 行进方向 = 沿边向外（与 A.dir 同向）。注意车道偏移的法线也按 hd 取，
      // 这样箭头严格落在**它所属的车道**里，弯道上也不会漂到邻道。
      for (const lane of lanes) {
        const cAt = lanePointAt(aAt, hd, lane.offset);
        // 箭头占位：非机动车道线等纵线在这里让开，否则白线会从箭头中间穿过去
        crossZones.push({
          outer: spanRect(cAt, hd, -U(2.2), U(2.2), -U(1.55), U(1.55)),
          holes: [],
        });
        const kind: Turn | 'through' =
          lane.turns.includes('left') && !lane.turns.includes('right')
            ? 'left'
            : lane.turns.includes('right') && !lane.turns.includes('left')
              ? 'right'
              : 'through';
        // 箭头朝向路口 = 来车方向 = −hd
        const aAng = Math.atan2(-hd.y, -hd.x);
        /**
         * 左右转的符号：`turnArrow` 的 v 轴 = aAng 的左手法线。
         * 我们只画右侧半幅（右侧通行）的进口车道，所以**左转就是 +1**、
         * 右转就是 −1，不需要再按车道位置反推 —— 内侧车道本来就在左边。
         */
        const dirSign: -1 | 1 = kind === 'right' ? -1 : 1;
        if (kind === 'left' || kind === 'right') {
          for (const ring of turnArrow(cAt, aAng, U(1.6), U(0.15), head, dirSign))
            out.push({ ring, yellow: false, kind: 'arrow' });
        } else {
          out.push({ ring: arrowRing(cAt, aAng, U(1.5), U(0.15), head), yellow: false, kind: 'arrow' });
        }
      }

      // 减速标线：主干路进口、停止线外 12~20 m 处三道横向白虚线
      if (A.cls === 'arterial') {
        for (let k = 0; k < 3; k++) {
          const d = stopD + U(12 + k * 4);
          const rp = alongEdge(graph, A.edgeId, c.nid, d);
          const rAt = rp?.at ?? new Pt(A0.x + A.dir.x * d, A0.y + A.dir.y * d);
          const rDir = rp?.dir ?? A.dir;
          /**
           * 只画在**本方向半幅**（中心线外侧 → 边缘线内），不是整幅路：
           * 横跨中心线会压住双黄线（实测 12.1 m² 重叠）。
           */
          for (let m = 0; m < 4; m++) {
            const t = U(0.5) + ((2 * sHalf - U(1.0)) * (m + 0.5)) / 4;
            const q = new Pt(rAt.x - rDir.y * t, rAt.y + rDir.x * t);
            out.push({ ring: rectRing(q, U(0.6), U(0.16), Math.atan2(rDir.y, rDir.x)), yellow: false, kind: 'slow' });
          }
        }
      }
    }
  }

  // ---------------- ④ 路口内的路缘石边线（沿转角圆弧）
  lap('①-④ 生成');

  if (typeof process !== 'undefined' && process.env?.F3_MK) {
    const c = new Map<string, number>();
    for (const m of out) c.set(m.kind ?? '?', (c.get(m.kind ?? '?') ?? 0) + 1);
    console.log('[mk raw]', JSON.stringify(Object.fromEntries(c)));
  }
  const clipped = clipMarksToAsphalt(out, asphalt);
  lap('裁到沥青');
  /**
   * 最后一道裁剪把**路口面**和**人行横道占位**一起从普通标线里减掉。
   *
   * 路口面负责"路口内不留车道线"（GB 5768.3）；人行横道占位负责
   * "斑马线上不许压别的线" —— 钝角路口上，一条臂的边缘线会顺路延伸进
   * 相邻臂的斑马线里（实测截图里那条斜穿斑马线的白线就是这么来的）。
   */
  const blockers = [...(opts.blockers ?? []), ...crossZones];
  const segsRaw = blockers.length ? clearJunction(clipped, blockers) : clipped;
  lap('让开路口');
  /**
   * **最后一道不变量**：标线必须是"带"，不能是"面"。
   *
   * 一条标线的面积应该约等于 `中心线长 × 0.15 m`。一旦某一段的面积远超这个值，
   * 说明它被生成成了**闭合环 / 自交折线**，展开后是一块面 —— 只留"道路标线"这一层
   * 看的时候，它会把整片地糊住（用户截图里那些十几米宽的长条和圆角巨块）。
   *
   * 这里统一兜住：不论上游哪个生成器吐的，超过 `周长/2 × 0.15 × 6` 就丢掉，
   * 并在 `notes` 里留一句（不允许静默）。
   */
  const keep: typeof segsRaw = [];
  let dropped = 0;
  let droppedArea = 0;
  let healed = 0;
  let droppedKinds = new Set<string>();
  for (const m of segsRaw) {
    let per = 0;
    for (let i = 0; i < m.ring.length; i++) per += Pt.distance(m.ring[i], m.ring[(i + 1) % m.ring.length]);
    const expect = (per / 2) * LW * 2; // 带宽 = 2·LW
    const actual = Math.abs(ringAreaOf(m.ring));
    if (expect > 1e-9 && actual > expect * 6) {
      dropped++;
      droppedArea += actual * 49;
      droppedKinds.add(m.kind ?? '?');
      continue;
    }
    /**
     * **自交环必须修掉** —— 这是"标线变成面"的真正元凶。
     *
     * 白带是沿折线展开的：折线一旦几乎绕回起点（路口边线走完整圈），带子的
     * 两端会互相压过去，得到一个自交环。它的**面积**很小（所以躲得过上面那道
     * 面积检查），但**三角化会把自交区当内部填满** —— 渲染出来就是一块盖住街区
     * 的大面。实测 4649 段里 217 段是这种。
     *
     * 修法：交给 Clipper 的非零绕数并集归一化，自交环会被拆成简单环；
     * 一个环拆成多片时逐片放回（都是这片白带的一部分）。
     */
    if (selfIntersects(m.ring)) {
      const fixed = unionSurfaceSet([{ outer: m.ring, holes: [] }]).filter(
        (q) => q.outer.length >= 3 && Math.abs(ringAreaOf(q.outer)) > 1e-9
      );
      if (fixed.length === 0) {
        dropped++;
        droppedKinds.add(m.kind ?? '?');
        continue;
      }
      healed++;
      for (const q of fixed) keep.push({ ...m, ring: q.outer });
      continue;
    }
    keep.push(m);
  }
  if (dropped > 0 && typeof process !== 'undefined' && process.env?.F3_MK) {
    console.log(
      `[mk] 自检：修复自交 ${healed} 段 · 丢弃"面状" ${dropped} 段（${[...droppedKinds].join('/')}，共 ${droppedArea.toFixed(0)} m²）`
    );
  }
  markingDroppedCount = dropped;
  return { segs: keep, crossings, eligible: eligible.length };
}

/**
 * 路口内的路缘石边线：把每张**路口面**往里缩 30~45 cm 取一条 15 cm 白带，
 * 再把各进口的"嘴部"（停止线所在的那条横断线）裁掉。
 *
 * 为什么必须这么做：路口面是车行面的一部分，纵向标线在路口前就截断了，
 * 于是每个路口的边界是一圈**没有边线**的沥青 —— 俯视看就是路口"糊"成一
 * 整块，看不见路缘在哪儿（用户截图红笔画的就是这一圈）。
 * 路口面自己的边界本来就等于路缘石线（它是由同一张闭合面派生的），
 * 沿它内缩一条白带，边线就自动跟着转角圆弧走，不需要再解析一次圆角。
 */
// ```junctionEdgeMarks```（路口路缘石边线 `jedge`）已移除：它由"沥青边界内缩"
// 派生，而沥青里残留的 0.5~2 m 透镜缝隙会让轮廓多出一圈内边界 —— 表现为
// 路口中间浮着一段白线 / 一个闭合"眼睛"。修了几轮仍有残余，按用户决定直接去掉。
// 路口只保留人行横道 / 停止线 / 导向箭头（GB 5768.3 并不要求路口内画边缘线）。

/**
 * 环逐顶点内缩：CCW 环的"内侧"在每条有向边的左手边。
 * 斜接长度 d/sin(θ/2)，按 4d 夹住（凹角处不至于拉飞）。
 */
function insetRing(ring: Pt[], d: number): Pt[] | null {
  const n = ring.length;
  if (n < 3) return null;
  const src = ringAreaOf(ring) < 0 ? ring.slice().reverse() : ring;
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = src[(i - 1 + n) % n];
    const b = src[i];
    const c = src[(i + 1) % n];
    const l1 = Pt.distance(a, b);
    const l2 = Pt.distance(b, c);
    if (l1 < 1e-9 || l2 < 1e-9) continue;
    const u1 = new Pt((b.x - a.x) / l1, (b.y - a.y) / l1);
    const u2 = new Pt((c.x - b.x) / l2, (c.y - b.y) / l2);
    // 两条边的左法线
    const n1 = new Pt(-u1.y, u1.x);
    const n2 = new Pt(-u2.y, u2.x);
    let mx = n1.x + n2.x;
    let my = n1.y + n2.y;
    const ml = Math.hypot(mx, my);
    if (ml < 1e-9) {
      mx = n1.x;
      my = n1.y;
    } else {
      mx /= ml;
      my /= ml;
    }
    /**
     * 斜接长度 = d / sin(θ/2)，θ 是**内角**（转角 turn 的补角）。
     * 写成 sin(turn/2) 是错的：缓弯（turn→0）会得到 12d 的位移，
     * 实测把整条边线推进沥青里 1.2 m。
     */
    const cosT = Math.max(-1, Math.min(1, u1.x * u2.x + u1.y * u2.y));
    const turn = Math.acos(cosT);
    /**
     * **凹顶点**（左转叉积为负）的法线平均指向环外 —— 直接用它位移会让
     * 整段边线跑到路口面外面（实测 2/3 的白线悬在铺装上）。这里翻向，
     * 并把斜接长度压到 d 以内（凹角内缩本来就是收缩，不该拉长）。
     */
    const cross = u1.x * u2.y - u1.y * u2.x;
    let k = Math.min(d / Math.max(0.15, Math.cos(turn / 2)), d * 4);
    if (cross < 0) {
      mx = -mx;
      my = -my;
      k = Math.min(k, d);
    }
    out.push(new Pt(b.x + mx * k, b.y + my * k));
  }
  return out.length >= 3 ? out : null;
}

function ringAreaOf(ring: Pt[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/**
 * 普通标线让开路口：路口内只保留过街/停止线/箭头/路口边线，其余截断。
 *
 * 不改标线的生成位置，只在最后做一次布尔差 —— 这样"路口内有没有车道线"
 * 就变成结构性保证，不依赖每条臂的收头距离算得准不准。
 */
function clearJunction(marks: MarkSeg[], blockers: PlanSurface[]): MarkSeg[] {
  const keepInside = new Set(['cross', 'stop', 'arrow']);
  const boxes = blockers.map((q) => ({ q, b: bboxOf(q.outer) }));
  const out: MarkSeg[] = [];
  for (const m of marks) {
    if (keepInside.has(m.kind ?? '')) {
      out.push(m);
      continue;
    }
    const bb = bboxOf(m.ring);
    const near = boxes
      .filter(({ b }) => !(b.minX > bb.maxX || b.maxX < bb.minX || b.minY > bb.maxY || b.maxY < bb.minY))
      .filter(({ q, b }) => {
        // 先用点判断快速筛：整条线（含两端）都不在路口面里就直接放过。
        // 全城 3500 段标线里只有 100 多段真的进了路口，逐条做布尔要 30 s。
        const c = centroid(m.ring);
        if (insideSurface(c, q)) return true;
        for (const r of m.ring) if (insideSurface(r, q)) return true;
        void b;
        return false;
      })
      .map((x) => x.q);
    if (near.length === 0) {
      out.push(m);
      continue;
    }
    try {
      const rest = surfaceSubtract([{ outer: m.ring, holes: [] }], near);
      for (const r of rest) {
        if (Math.abs(M2(areaOf(r))) < 0.2) continue;
        out.push({ ...m, ring: r.outer });
      }
    } catch {
      out.push(m);
    }
  }
  return out;
}

/** 以 `c` 为中心、沿 `ang` 长 `halfL`、法向半宽 `halfW` 的矩形 */
function rectRing(c: Pt, halfL: number, halfW: number, ang: number): Pt[] {
  const cs = Math.cos(ang);
  const sn = Math.sin(ang);
  const at = (u: number, v: number): Pt => new Pt(c.x + cs * u - sn * v, c.y + sn * u + cs * v);
  return cleanRing([at(-halfL, -halfW), at(halfL, -halfW), at(halfL, halfW), at(-halfL, halfW)]);
}

/**
 * 车行面**边界边**的均匀网格索引。
 *
 * 为什么需要它：`clipMarksToAsphalt` 原来对每条标线都做一次 `surfaceIntersect`，
 * 而车行面里有一片是整张主路网并出来的大面（实测 **3179 个顶点**）——
 * 一次布尔要 20 ms，4774 段标线 × 平均 1.5 片 = **65 s**，整座城 90 s。
 *
 * 而 99% 的标线本来就整条落在车行面内部（它们是按车道模型偏移出来的），
 * 根本不需要布尔。所以先用"有没有边界边穿过这条标线"来判断：
 *   · 没有穿过 → 要么整条在里、要么整条在外，查一个点内测试即可，零布尔；
 *   · 有穿过   → 才走原来的布尔裁剪（跨路缘、跨路口的少数情况）。
 * 边按 4 世界单位（≈28 m）的格子入桶，一次查询只看附近几个格子的边。
 */
class AsphaltBoundaryIndex {
  private readonly cell = 4;
  private readonly grid = new Map<number, number[]>();
  private readonly ax: number[] = [];
  private readonly ay: number[] = [];
  private readonly bx: number[] = [];
  private readonly by: number[] = [];
  /** 每条边的包围盒（预计算：同一条边会被几百段标线反复问到） */
  private readonly eMinX: number[] = [];
  private readonly eMaxX: number[] = [];
  private readonly eMinY: number[] = [];
  private readonly eMaxY: number[] = [];
  /** 每条边属于哪一片车行面（点内测试要按片做奇偶） */
  private readonly ePiece: number[] = [];
  /** y 带索引：点内测试只扫过该点所在横带的边（射线法） */
  private readonly yBands = new Map<number, number[]>();

  constructor(list: PlanSurface[]) {
    list.forEach((s, pi) => {
      this.addRing(s.outer, pi);
      for (const h of s.holes) this.addRing(h, pi);
    });
  }

  private static key(ix: number, iy: number): number {
    return (ix + 4096) * 8192 + (iy + 4096);
  }

  /** 世界坐标 → 格子键（供外部按格缓存判定结果） */
  static cellKey(x: number, y: number, cell: number): number {
    return AsphaltBoundaryIndex.key(Math.floor(x / cell), Math.floor(y / cell));
  }

  private addRing(ring: Pt[], piece: number): void {
    const c = this.cell;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const id = this.ax.length;
      this.ax.push(a.x);
      this.ay.push(a.y);
      this.bx.push(b.x);
      this.by.push(b.y);
      const mnX = Math.min(a.x, b.x);
      const mxX = Math.max(a.x, b.x);
      const mnY = Math.min(a.y, b.y);
      const mxY = Math.max(a.y, b.y);
      this.eMinX.push(mnX);
      this.eMaxX.push(mxX);
      this.eMinY.push(mnY);
      this.eMaxY.push(mxY);
      this.ePiece.push(piece);

      for (let ix = Math.floor(mnX / c); ix <= Math.floor(mxX / c); ix++) {
        for (let iy = Math.floor(mnY / c); iy <= Math.floor(mxY / c); iy++) {
          const k = AsphaltBoundaryIndex.key(ix, iy);
          const bin = this.grid.get(k);
          if (bin) bin.push(id);
          else this.grid.set(k, [id]);
        }
      }
      for (let iy = Math.floor(mnY / c); iy <= Math.floor(mxY / c); iy++) {
        const bin = this.yBands.get(iy);
        if (bin) bin.push(id);
        else this.yBands.set(iy, [id]);
      }
    }
  }

  /** 有没有沥青边界边与这条标线的任一条边相交 */
  crosses(ring: Pt[], bb: { minX: number; minY: number; maxX: number; maxY: number }): boolean {
    const c = this.cell;
    const x0 = Math.floor(bb.minX / c);
    const x1 = Math.floor(bb.maxX / c);
    const y0 = Math.floor(bb.minY / c);
    const y1 = Math.floor(bb.maxY / c);
    const seen = new Set<number>();
    for (let ix = x0; ix <= x1; ix++) {
      for (let iy = y0; iy <= y1; iy++) {
        const bin = this.grid.get(AsphaltBoundaryIndex.key(ix, iy));
        if (!bin) continue;
        for (let k = 0; k < bin.length; k++) {
          const id = bin[k];
          if (seen.has(id)) continue;
          seen.add(id);
          if (this.hitAny(id, ring)) return true;
        }
      }
    }
    return false;
  }

  /**
   * 点是否落在这些车行面片的并集里（射线法 + y 带索引）。
   *
   * 为什么不用 `insideSurface`：那片主路网有 3179 个顶点，一次要 0.18 ms，
   * 全城上万段标线就是好几秒。这里只扫点所在横带（4 单位 ≈ 28 m）的边，
   * 每条边只做一次乘法比较，实测快 20 倍以上。
   */
  insideAny(p: Pt, pieces: number[]): boolean {
    const band = this.yBands.get(Math.floor(p.y / this.cell));
    if (!band) return false;
    for (const piece of pieces) {
      let inside = false;
      for (let k = 0; k < band.length; k++) {
        const id = band[k];
        if (this.ePiece[id] !== piece) continue;
        const ay = this.ay[id];
        const by = this.by[id];
        if (ay > p.y === by > p.y) continue;
        const ax = this.ax[id];
        const t = (p.y - ay) / (by - ay || 1e-12);
        if (ax + (this.bx[id] - ax) * t > p.x) inside = !inside;
      }
      if (inside) return true;
    }
    return false;
  }

  private hitAny(id: number, ring: Pt[]): boolean {
    const minX = this.eMinX[id];
    const maxX = this.eMaxX[id];
    const minY = this.eMinY[id];
    const maxY = this.eMaxY[id];
    const p1x = this.ax[id];
    const p1y = this.ay[id];
    const p2x = this.bx[id];
    const p2y = this.by[id];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      // 标线边与这条边界边的包围盒不相交就跳过（绝大多数情况在这里出局）
      if (Math.max(a.x, b.x) < minX || Math.min(a.x, b.x) > maxX) continue;
      if (Math.max(a.y, b.y) < minY || Math.min(a.y, b.y) > maxY) continue;
      if (segCross(a, b, p1x, p1y, p2x, p2y)) return true;
    }
    return false;
  }
}

/** 线段相交（含共线重叠；端点相接算相交 —— 宁可多走一次布尔，也不留悬空标线） */
function segCross(a: Pt, b: Pt, cx: number, cy: number, dx: number, dy: number): boolean {
  const d1 = cross3(cx, cy, dx, dy, a.x, a.y);
  const d2 = cross3(cx, cy, dx, dy, b.x, b.y);
  const d3 = cross3(a.x, a.y, b.x, b.y, cx, cy);
  const d4 = cross3(a.x, a.y, b.x, b.y, dx, dy);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const eps = 1e-9;
  const on = (px: number, py: number, qx: number, qy: number, rx: number, ry: number): boolean =>
    Math.abs(cross3(qx, qy, rx, ry, px, py)) < eps &&
    px >= Math.min(qx, rx) - eps &&
    px <= Math.max(qx, rx) + eps &&
    py >= Math.min(qy, ry) - eps &&
    py <= Math.max(qy, ry) + eps;
  return on(a.x, a.y, cx, cy, dx, dy) || on(b.x, b.y, cx, cy, dx, dy) || on(cx, cy, a.x, a.y, b.x, b.y) || on(dx, dy, a.x, a.y, b.x, b.y);
}

function cross3(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
  return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
}

/**
 * 标线裁到车行面内。
 *
 * 只按包围盒挑出可能相交的几块路面求交 —— 全城几千条标线，每条都跟整张
 * 路网做布尔会把这一步从 0.2 s 拖到十几秒。
 *
 * 在此之上还有一条**零布尔快路径**（见 `AsphaltBoundaryIndex`）：先用边界边
 * 索引判断这条标线有没有跨出车行面，没有跨就只做一次点内测试。
 */
function clipMarksToAsphalt(marks: MarkSeg[], asphalt: PlanSurface[]): MarkSeg[] {
  if (asphalt.length === 0) return marks;
  const boxes = asphalt.map((q) => bboxOf(q.outer));
  const boundary = new AsphaltBoundaryIndex(asphalt);
  /** 与给定包围盒相交的车行面片下标（平均只有 1.5 片） */
  const nearOf = (b: { minX: number; minY: number; maxX: number; maxY: number }): number[] => {
    const out: number[] = [];
    for (let i = 0; i < boxes.length; i++) {
      const ab = boxes[i];
      if (ab.minX > b.maxX || ab.maxX < b.minX || ab.minY > b.maxY || ab.maxY < b.minY) continue;
      out.push(i);
    }
    return out;
  };
  const patchCache = new Map<number, boolean>();
  const out: MarkSeg[] = [];
  let fast = 0;
  let slow = 0;
  for (const m of marks) {
    /**
     * 箭头**不参与碎片化裁剪**：它是 3 m × 0.3 m 的细条，一旦跨在沥青面的
     * 拼接缝上就会被切成几块 < 0.25 m² 的碎片全部丢掉（实测 242 段只剩 6 段）。
     * 箭头的生成位置由 `alongEdge` 沿边走、再按车道偏移横移，本来就在车行面内；
     * 这里只做"质心是否在沥青里"的把关，不裁形状。
     * 路口边线（`jedge`）同理：它由路口面内缩得到，必然在沥青里，而 15 cm
     * 宽的环带一旦跨在沥青拼接缝上就会被切成 < 0.25 m² 的碎块全部丢掉 ——
     * 实测路口的圆弧边线整段消失。
     */
    /**
     * 箭头与人行横道**不参与碎片化裁剪**：它们是 3 m × 0.3 m 的细条，一旦跨在
     * 沥青面的拼接缝上就会被切成几块 < 0.25 m² 的碎片全部丢掉（实测箭头
     * 242 段只剩 6 段）。箭头的生成位置由 `alongEdge` 沿边走、再按车道偏移
     * 横移，本来就在车行面内；路口边线（`jedge`）则是由路口面内缩得到的，
     * 位置同样有保证 —— 这两类直接放行，不裁形状、也不做质心检查。
     */
    if (m.kind === 'arrow') {
      const c = centroid(m.ring);
      if (boundary.insideAny(c, nearOf({ minX: c.x, minY: c.y, maxX: c.x, maxY: c.y }))) out.push(m);
      continue;
    }
    const b = bboxOf(m.ring);
    const near = nearOf(b);
    if (near.length === 0) continue;
    /**
     * 小标线快路径（虚线 / 斑马线条 / 停止线 / 箭头 / 减速线，全城占八成）：
     * 尺寸只有几米，逐顶点判内外就够了 —— 一条 15 cm × 1.5 m 的白条不可能
     * "四个角都在沥青里、中间却跨出车行面"。**不**做线段相交测试，
     * 那一步才是这一步 4 s 的真正开销来源（长标线的环有 80 个点，
     * 每个点都要跟附近几十条边界边比一遍）。
     */
    const small = b.maxX - b.minX < U(6) && b.maxY - b.minY < U(6);
    if (small) {
      let inCnt = 0;
      for (const p of m.ring) if (boundary.insideAny(p, near)) inCnt++;
      if (inCnt === m.ring.length) {
        fast++;
        out.push(m);
        continue;
      }
      if (inCnt === 0 && !boundary.insideAny(centroid(m.ring), near)) {
        // 整条都在车行面外：直接丢（这一档原来是"布尔之后被裁空"，结果一样）
        fast++;
        continue;
      }
      // 只有部分顶点在里：老老实实做布尔（全城不到 10 段）
    } else if (!boundary.crosses(m.ring, b)) {
      /**
       * 长标线快路径：没有沥青边界边穿过它 → 它要么整条在车行面里、要么整条在外，
       * 一个点内测试就能定，完全不需要布尔。
       */
      fast++;
      const c = centroid(m.ring);
      /**
       * 点内测试本身也不便宜（3179 顶点的车行面一片要 0.18 ms），而几百段虚线
       * 常常落在同一个 2 单位的格子里 —— 按格缓存，命中率约八成。
       */
      const ck = AsphaltBoundaryIndex.cellKey(c.x, c.y, 2);
      let inside = patchCache.get(ck);
      if (inside === undefined) {
        inside = boundary.insideAny(c, near);
        patchCache.set(ck, inside);
      }
      if (inside) out.push(m);
      continue;
    }
    slow++;
    let kept = false;
    for (const qi of near) {
      const q = asphalt[qi];
      try {
        const hit = surfaceIntersect([{ outer: m.ring, holes: [] }], [q]);
        for (const h of hit) {
          if (Math.abs(M2(areaOf(h))) < 0.25) continue;
          out.push({ ...m, ring: h.outer });
          kept = true;
        }
      } catch {
        /* 单片布尔失败就换下一片，不整条丢 */
      }
    }
    if (!kept && boundary.insideAny(centroid(m.ring), near)) out.push(m);
  }
  if (typeof process !== 'undefined' && process.env?.F3_TC) {
    console.log(`[mk] 裁剪：快路径 ${fast} / 布尔 ${slow} → 保留 ${out.length}`);
  }
  return out;
}

function areaOf(s: PlanSurface): number {
  let a = 0;
  const r = s.outer;
  for (let i = 0; i < r.length; i++) {
    const p = r[i];
    const q = r[(i + 1) % r.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
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
