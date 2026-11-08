// F3 · 车道级模型：把「断面宽度」细化成「一条条车道」，以及车道在路口的转向。
//
// 为什么需要这一层
// ----------------
// 标线、导向箭头、停止线本来是"车道"的属性，不是"道路宽度"的属性：
//   · 车道分界线画在**车道边界**上，不是按 3.5 m 硬切；
//   · 导向箭头是"这条车道允许往哪走"，单车道不能既左转又右转（会逼着变道）；
//   · 停止线宽度 = 该进口车行道全宽，位置在各车道最前端。
// 之前这些都在 markings.ts 里用 `(k − (n−1)/2) * LANE_W` 硬算，箭头方向靠
// "出口方向接近垂直"猜 —— 猜不出"这条臂到底有没有那个出口"。
//
// 现在这一层给出两个东西，markings 只消费它们：
//   1. `lanesOf(sec)` —— 每个方向的车道（偏移 / 宽度 / 边界）；
//   2. `maneuversOf(apps)` —— 每个进口允许的转向（left / through / right）。
//
// 刻意**不**做车道连接图（进口车道 → 出口车道）：那需要 lane 级别的连通与
// 渠化数据，属于下一层（maneuver graph）的事；这里只到"这条车道在这个路口
// 允许哪些转向"，足够把标线画对。

import { Pt } from '../core/geom';
import type { PathGraph, RoadClass3, RoadSection } from './types';
import { U } from './geom';

/** 一条车道的行进方向（相对进口） */
export type Turn = 'left' | 'through' | 'right';

export interface Lane {
  /** −1 = 行进方向的左侧，+1 = 右侧 */
  side: -1 | 1;
  /** 0 = 最靠中心线的那条 */
  idx: number;
  /** 车道中心相对道路中线的横向偏移（世界单位，带符号） */
  offset: number;
  /** 车道宽度（世界单位） */
  width: number;
  /** 该车道**外侧**边界相对中线的偏移（画车道分界线用，带符号） */
  edge: number;
  /** 该车道在路口允许的转向；不在路口时是 ['through'] */
  turns: Turn[];
}

/** 设计车道宽（米）—— 取城市道路最小值，窄路上会按实际宽度压缩 */
export const LANE_W_M = 3.5;

/**
 * 单方向车道数：车行道半幅扣掉两侧 0.25 m 富余后能放几条 3.5 m。
 * 上限 3：再宽的路在没有渠化数据的情况下画 4 条以上只会更假。
 */
export function lanesPerDir(carriageM: number): number {
  return Math.max(1, Math.min(3, Math.floor((carriageM / 2 - 0.25) / LANE_W_M)));
}

/**
 * 单方向车道（从中心线往外排），`side` 只影响符号。
 *
 * 单位注意：`sec.carriage` 是**米**，所有几何量必须经 `U()` 转成世界单位。
 * 早期版本这里写 `Math.max(U(3.5), sec.carriage / 2 - U(0.25))` —— 把 8.5
 * 直接当世界单位用，车道偏移变成 60 m，导向箭头全部落到街区里。
 */
export function lanesOfSide(sec: RoadSection, side: -1 | 1): Lane[] {
  const n = lanesPerDir(sec.carriage);
  const half = U(sec.carriage / 2);
  const usable = Math.max(U(LANE_W_M), half - U(0.25));
  // 车道均匀填满可用半幅：宽路上每车道会比 3.5 m 略宽，窄路上略窄，
  // 但**边界永远落在物理车行面之内**（否则分界线会压到人行道上）。
  const w = usable / n;
  const out: Lane[] = [];
  for (let i = 0; i < n; i++) {
    const inner = i * w;
    out.push({
      side,
      idx: i,
      offset: side * (inner + w / 2),
      width: w,
      edge: side * (i === n - 1 ? usable : (i + 1) * w),
      turns: ['through'],
    });
  }
  return out;
}

/** 双向全部车道 */
export function lanesOf(sec: RoadSection): Lane[] {
  return [...lanesOfSide(sec, -1), ...lanesOfSide(sec, 1)];
}

/** 进口（从路口中心指向外部） */
export interface ApproachLike {
  dir: Pt;
  ang: number;
  half: number;
  cls: RoadClass3;
  edgeId: string;
}

/** 折到 (−π, π] */
function wrapPi(a: number): number {
  let v = a % (Math.PI * 2);
  if (v > Math.PI) v -= Math.PI * 2;
  if (v <= -Math.PI) v += Math.PI * 2;
  return v;
}

/** 直行判定的角度容差（弧度）：±20° 内算直行 */
const THROUGH_TOL = 0.35;

/**
 * 每个进口允许的转向。
 *
 * 判据是**相对直行的偏转角**：进口 A 的来向是 `A.ang + π`，出口 B 的朝向是
 * `B.ang`，所以
 *   delta = wrap(B.ang − (A.ang + π))
 *   |delta| ≤ 20°   → 直行
 *   delta > 0       → 左转（CCW；世界坐标 y 向上）
 *   delta < 0       → 右转
 *
 * 这里不做"这条车道能不能过去"的约束（那需要 lane 级连通），只回答
 * "这个进口在几何上有没有左/直/右的出口"。
 */
export function maneuversOf(apps: ApproachLike[]): Map<string, Turn[]> {
  const out = new Map<string, Turn[]>();
  for (const a of apps) {
    const turns = new Set<Turn>();
    for (const b of apps) {
      if (b === a) continue;
      const delta = wrapPi(b.ang - (a.ang + Math.PI));
      if (Math.abs(delta) <= THROUGH_TOL) turns.add('through');
      else if (delta > 0) turns.add('left');
      else turns.add('right');
    }
    if (turns.size === 0) turns.add('through');
    out.set(a.edgeId, [...turns]);
  }
  return out;
}

/**
 * 把"进口允许的转向"分配到各条车道。
 *
 * 规则（GB 5768.3 的导向车道布置口径）：
 *   · 单向 1 条车道：这条车道承担全部转向（不逼变道），画直行箭头，
 *     真需要左/右转时用组合箭头；
 *   · 多条车道：最内侧（靠中心线）吃左转，最外侧吃右转，其余直行；
 *     但如果该路口没有左转出口，内侧就退回直行（不画一个不存在的转向）。
 */
export function assignTurns(lanes: Lane[], available: Turn[]): Lane[] {
  if (lanes.length === 0) return lanes;
  const has = (t: Turn): boolean => available.includes(t);
  const out = lanes.map((l) => ({ ...l, turns: ['through'] as Turn[] }));
  if (lanes.length === 1) {
    const all: Turn[] = [];
    if (has('left')) all.push('left');
    all.push('through');
    if (has('right')) all.push('right');
    out[0].turns = all;
    return out;
  }
  const inner = out[0];
  const outer = out[out.length - 1];
  if (has('left')) inner.turns = ['left', 'through'];
  if (has('right')) outer.turns = ['right', 'through'];
  return out;
}

/**
 * 沿路径把车道偏移换成实际坐标（供标线 / 箭头直接使用）。
 *
 * 车道偏移是"沿法线的横向距离"，方向盘正负与道路法线 `(-dir.y, dir.x)` 一致。
 */
export function lanePointAt(at: Pt, dir: Pt, offset: number): Pt {
  return new Pt(at.x - dir.y * offset, at.y + dir.x * offset);
}

/** 便捷：某条路上每个进口的车道（markings 用） */
export function lanesAtJunction(
  graph: PathGraph,
  nodeId: string,
  secOf: (c: RoadClass3) => RoadSection
): Map<string, Lane[]> {
  const node = graph.nodes.get(nodeId);
  const out = new Map<string, Lane[]>();
  if (!node) return out;
  for (const eid of new Set(node.edges)) {
    const e = graph.edges.get(eid);
    if (!e) continue;
    out.set(eid, lanesOf(secOf(e.cls)));
  }
  return out;
}

/**
 * 车道级转向连接（maneuver graph）。
 *
 * `maneuversOf` 只回答"这个进口允许哪些转向"；这里再往下一层：
 * **哪条进口车道、连到哪条出口车道**。有了它，箭头数量、停止线宽度、
 * 未来的交通仿真与渠化设计才有共同的数据源。
 *
 * 车道配对是**按通行习惯的估算**（没有渠化/信号相位数据时的合理默认）：
 *   · 左转：进口内侧（idx 0）→ 出口内侧（idx 0）
 *   · 直行：进口第 k 条 → 出口第 k 条（出口车道少时夹到最外）
 *   · 右转：进口外侧（idx n−1）→ 出口外侧（idx nB−1）
 * 真实渠化会指定每个转向的专用车道，那属于后续的 lane 级 intent。
 */
export interface LaneManeuver {
  from: { edgeId: string; idx: number };
  to: { edgeId: string; idx: number };
  turn: Turn;
}

/** 一个路口的全部车道级转向 */
export interface JunctionManeuvers {
  arms: {
    edgeId: string;
    turns: Turn[];
    inLanes: number;
    outLanes: number;
  }[];
  links: LaneManeuver[];
}

/**
 * 构造一个路口的 maneuver graph。
 *
 * 需要各臂的断面（`secOf`）来算车道数：进口按 `lanesPerDir(carriage)`，
 * 出口同理。返回的 `links` 里 `from` 是进口车道、`to` 是出口车道，
 * 两者都用"从中心线往外的序号"（0 = 内侧）。
 */
export function buildJunctionManeuvers(
  apps: ApproachLike[],
  secOf: (c: RoadClass3) => RoadSection
): JunctionManeuvers {
  const turnsOf = maneuversOf(apps);
  const arms = apps.map((a) => {
    const n = lanesPerDir(secOf(a.cls).carriage);
    return { edgeId: a.edgeId, turns: turnsOf.get(a.edgeId) ?? (['through'] as Turn[]), inLanes: n, outLanes: n };
  });
  const links: LaneManeuver[] = [];
  for (const a of apps) {
    const nA = lanesPerDir(secOf(a.cls).carriage);
    for (const b of apps) {
      if (b === a) continue;
      const delta = wrapPi(b.ang - (a.ang + Math.PI));
      const turn: Turn =
        Math.abs(delta) <= THROUGH_TOL ? 'through' : delta > 0 ? 'left' : 'right';
      const nB = lanesPerDir(secOf(b.cls).carriage);
      if (turn === 'through') {
        for (let k = 0; k < nA; k++) links.push({ from: { edgeId: a.edgeId, idx: k }, to: { edgeId: b.edgeId, idx: Math.min(k, nB - 1) }, turn });
      } else if (turn === 'left') {
        links.push({ from: { edgeId: a.edgeId, idx: 0 }, to: { edgeId: b.edgeId, idx: 0 }, turn });
      } else {
        links.push({ from: { edgeId: a.edgeId, idx: nA - 1 }, to: { edgeId: b.edgeId, idx: nB - 1 }, turn });
      }
    }
  }
  return { arms, links };
}
