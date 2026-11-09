// F3 · 路网图清理（多线相交的直接对策）
//
// 症状：张量场是两组流线（主向 + 次向）叠出来的，两条流线**以小角度相交**时，
// buildPathGraph 会照实建出一个节点；再加上 `extendEnds` 把断头往红线上拉、
// 拉的过程又跟别的流线交叉，于是同一小片区域里出现 3~5 个路口、
// 每条臂之间的夹角都很小 —— 铺成路面之后就是截图里那团"黑色星形团块"。
//
// 为什么不在几何层修：
//   starZone / 断面条带都是"忠实于图"的 —— 图里有 5 条臂它就画 5 条臂。
//   团块的根因是**图本身错了**（同一处不该有 4 个路口），
//   在几何上加特判只会在别处冒出来。所以这里做三件事，然后让下游照常跑：
//
//   ① 短路收缩：两个路口之间不足 9 m 的边直接并成一个路口（原来会铺出一小段
//      "连接沥青"，视觉上等于把两个路口粘成一个不规则块）；
//   ② 节点聚类：14 m 内的多个路口并成一个（位置取质心）—— 这是团块的主因，
//      "一个路口被切成了三个"；
//   ③ 锐角去重：同一路口上两条臂离开方向相差 < 20° 时，删掉较短的那条
//      （它是重复的街，不是真的分叉），前提是删掉不会让对端变成孤点。
//
// 做完全部走一遍 `finalize()`：重算度、踢掉孤立点、重建 paths / junctions。
// 顺序不能反 —— chainPaths 靠 degree 判断"能不能继续穿过去"。

import { Pt } from '../core/geom';
import { U, polyLen } from './geom';
import type { PathGraph, PathEdge, PathNode, RoadClass3 } from './types';
import { chainPaths } from './streets';

export interface CleanStats {
  contracted: number;
  merged: number;
  pruned: number;
  notes: string[];
}

const RANK: Record<RoadClass3, number> = { local: 0, collector: 1, arterial: 2 };

/** 路口之间的最短边长（米）：小于它的两个路口其实是同一个 */
const MIN_EDGE_M = 9;
/** 同一路口聚类的半径（米）：一个路口被切成两三个时，间距通常 10~20 m */
const CLUSTER_M = 14;
/** 两条臂的夹角小于它就算重复（度） */
const ACUTE_DEG = 20;
/** 只有短于这个长度的臂才允许因为锐角被删（长街不能因为拐弯被吃掉） */
const PRUNE_MAX_M = 120;

export function simplifyGraph(graph: PathGraph): CleanStats {
  const notes: string[] = [];
  let contracted = 0;
  let merged = 0;
  let pruned = 0;

  const nodes = graph.nodes;
  const edges = graph.edges;

  const dropEdge = (id: string): void => {
    edges.delete(id);
  };

  /** b 并进 a：把 b 上的边都改挂到 a，位置留在 a（a 的位置由调用方决定） */
  const absorb = (a: PathNode, b: PathNode): void => {
    for (const e of edges.values()) {
      if (e.a === b.id) e.a = a.id;
      if (e.b === b.id) e.b = a.id;
    }
    nodes.delete(b.id);
  };

  const edgeLenM = (e: PathEdge): number => polyLen(e.pts) * 7;

  // ---------------- ① 短路收缩
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const e of [...edges.values()]) {
      if (!edges.has(e.id)) continue;
      if (e.a === e.b) {
        dropEdge(e.id);
        changed = true;
        continue;
      }
      if (edgeLenM(e) >= MIN_EDGE_M) continue;
      const na = nodes.get(e.a);
      const nb = nodes.get(e.b);
      if (!na || !nb) {
        dropEdge(e.id);
        continue;
      }
      // 保留度数大的那个（通常是真路口），另一个并进去
      const keep = na.degree >= nb.degree ? na : nb;
      const gone = keep === na ? nb : na;
      // 位置取两者中点：直接留大路口会把整条街拉偏
      keep.at = new Pt((na.at.x + nb.at.x) / 2, (na.at.y + nb.at.y) / 2);
      absorb(keep, gone);
      dropEdge(e.id);
      contracted++;
      changed = true;
    }
    if (!changed) break;
  }

  // ---------------- ② 节点聚类
  /** 节点度要重算一次才能判断谁是路口 */
  const refreshDegrees = (): void => {
    for (const n of nodes.values()) n.edges = [];
    for (const e of edges.values()) {
      const a = nodes.get(e.a);
      const b = nodes.get(e.b);
      if (!a || !b || e.a === e.b) {
        if (e.a === e.b) edges.delete(e.id);
        continue;
      }
      a.edges.push(e.id);
      b.edges.push(e.id);
    }
    for (const n of nodes.values()) {
      n.edges = [...new Set(n.edges)];
      n.degree = n.edges.length;
    }
  };
  refreshDegrees();

  const cell = U(CLUSTER_M);
  const buckets = new Map<string, string[]>();
  const keyOf = (p: Pt): string => `${Math.floor(p.x / cell)}_${Math.floor(p.y / cell)}`;
  for (const n of nodes.values()) {
    const k = keyOf(n.at);
    const list = buckets.get(k) ?? [];
    list.push(n.id);
    buckets.set(k, list);
  }

  const mergedInto = new Map<string, string>();
  const rootOf = (id: string): string => {
    let cur = id;
    for (let guard = 0; guard < 64; guard++) {
      const up = mergedInto.get(cur);
      if (!up) return cur;
      cur = up;
    }
    return cur;
  };

  for (const n of [...nodes.values()]) {
    if (!nodes.has(n.id)) continue;
    const ix = Math.floor(n.at.x / cell);
    const iy = Math.floor(n.at.y / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const otherId of buckets.get(`${ix + dx}_${iy + dy}`) ?? []) {
          if (otherId === n.id) continue;
          const other = nodes.get(otherId);
          if (!other) continue;
          if (Pt.distance(n.at, other.at) > U(CLUSTER_M)) continue;
          /**
           * 只在**至少一端是路口**时合并。两个度-2 的中间点挨得近是正常的
           * （折线拐点），合并它们会把一条直街折成折线。
           */
          if (n.degree < 3 && other.degree < 3) continue;
          const a = rootOf(n.id);
          const b = rootOf(otherId);
          if (a === b) continue;
          const na = nodes.get(a);
          const nb = nodes.get(b);
          if (!na || !nb) continue;
          const keep = na.degree >= nb.degree ? na : nb;
          const gone = keep === na ? nb : na;
          keep.at = new Pt((na.at.x + nb.at.x) / 2, (na.at.y + nb.at.y) / 2);
          absorb(keep, gone);
          mergedInto.set(gone.id, keep.id);
          merged++;
        }
      }
    }
  }
  refreshDegrees();

  // ---------------- ③ 锐角去重
  /** 从节点出发，沿边取一个方向向量（走到 5 m 处，边太短就用端点） */
  const armDir = (n: PathNode, e: PathEdge): { dir: Pt; lenM: number; farId: string } => {
    const pts = e.a === n.id ? e.pts : e.pts.slice().reverse();
    const farId = e.a === n.id ? e.b : e.a;
    let acc = 0;
    let prev = pts[0];
    for (let i = 1; i < pts.length; i++) {
      acc += Pt.distance(prev, pts[i]);
      if (acc * 7 >= 5 || i === pts.length - 1) {
        const dx = pts[i].x - n.at.x;
        const dy = pts[i].y - n.at.y;
        const L = Math.hypot(dx, dy) || 1;
        return { dir: new Pt(dx / L, dy / L), lenM: edgeLenM(e), farId };
      }
      prev = pts[i];
    }
    return { dir: new Pt(1, 0), lenM: edgeLenM(e), farId };
  };

  for (const n of [...nodes.values()]) {
    if (n.degree < 3) continue;
    const arms = n.edges
      .map((id) => edges.get(id))
      .filter((e): e is PathEdge => !!e)
      .map((e) => ({ e, ...armDir(n, e) }))
      .sort((a, b) => (a.e.cls === b.e.cls ? b.lenM - a.lenM : RANK[b.e.cls] - RANK[a.e.cls]));
    for (let i = 0; i < arms.length; i++) {
      for (let j = i + 1; j < arms.length; j++) {
        const A = arms[i];
        const B = arms[j];
        if (!edges.has(A.e.id) || !edges.has(B.e.id)) continue;
        const dot = Math.max(-1, Math.min(1, A.dir.x * B.dir.x + A.dir.y * B.dir.y));
        const deg = (Math.acos(dot) * 180) / Math.PI;
        if (deg >= ACUTE_DEG) continue;
        /**
         * 两条臂几乎同向：留"更该留"的那条。
         * 判据顺序：等级高的优先 → 长的优先。候选被删的那条还必须够短、
         * 且对端不是路口（否则会把一片街区从路网里摘掉）。
         */
        const victim = A.lenM <= B.lenM ? A : B;
        if (victim.lenM > PRUNE_MAX_M) continue;
        const far = nodes.get(victim.farId);
        if (far && far.degree >= 3) continue;
        dropEdge(victim.e.id);
        pruned++;
      }
    }
  }
  refreshDegrees();

  // ---------------- ④ 收尾：踢孤立点 / 重建 paths
  for (const n of [...nodes.values()]) {
    if (n.degree === 0) nodes.delete(n.id);
  }
  refreshDegrees();
  graph.paths = chainPaths(edges, nodes);
  graph.junctions = [...nodes.values()].filter((n) => n.degree >= 3).map((n) => n.id);

  if (contracted + merged + pruned > 0) {
    notes.push(
      `路网图清理：短路收缩 ${contracted} · 路口聚类 ${merged} · 锐角去重 ${pruned} → 路口 ${graph.junctions.length} / 边 ${edges.size}`
    );
  }
  return { contracted, merged, pruned, notes };
}
