/**
 * A6.1：真实城市多路口 → 单网络（一份 RoadAuthoringDocument，一次编译）
 *
 * 与 `roadsThree.ts` 的单路口版本区别：这里把**相邻路口连成一张网**，
 * 共享的 RoadEdge 只生成一条 RoadStroke，两端各自带一个 JunctionIntent。
 *
 * 只在隔离脚本 / Flag 下使用，不参与默认管线。
 */
import {
  resolveAutomaticNetwork,
  createRoadAuthoringDocument,
  addRoadTemplate,
  addRoadStroke,
  addJunctionIntent,
  createSingleLanePriorityTJunctionIntent,
  createSingleLaneFourArmJunctionIntent,
  compileRoadNetwork,
} from '@three-roads/core';
import type { CityResult } from './index';
import { Pt } from '../core/geom';

const U = (m: number): number => m / 7;
const M = (u: number): number => u * 7;

export interface Cluster {
  nodes: string[];
  edges: string[];
  /** 每个待删的可疑边（不可用） */
  skipped: { edgeId: string; why: string }[];
  /** 短连接道路（保留，只记录剩余长度） */
  shortEdges: { edgeId: string; remainM: number }[];
}

/** 折线偏离弦线的最大值（米） */
function chordDeviation(pts: Pt[]): number {
  if (pts.length < 3) return 0;
  const a = pts[0], b = pts[pts.length - 1];
  const dx = b.x - a.x, dy = b.y - a.y;
  const L = Math.hypot(dx, dy) || 1;
  let mx = 0;
  for (const p of pts) mx = Math.max(mx, Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / L);
  return mx * 7;
}

/**
 * 从某个路口出发做 BFS，凑够 `want` 个路口。
 * 只走**能用直线近似**的边（偏离 < 1.5 m），否则 three-roads 的 line 段表达不了。
 */
export function pickCluster(base: CityResult, want = 5): Cluster {
  const g = base.debug.graph;
  const secs = (base.debug.road as any).sections as Record<string, { carriage: number; curb: number; walk: number }>;
  const skipped: { edgeId: string; why: string }[] = [];
  const shortEdges: { edgeId: string; remainM: number }[] = [];

  // 起点：三臂等宽、最正交的那个（与单路口版一致）
  let start: string | null = null;
  let bestScore = -1e9;
  for (const id of g.junctions) {
    const nd = g.nodes.get(id);
    if (!nd) continue;
    const seen = new Set<string>();
    const cls = new Set<string>();
    let n = 0;
    for (const eid of nd.edges) {
      const e = g.edges.get(eid);
      if (!e || seen.has(eid)) continue;
      seen.add(eid); cls.add(String(e.cls)); n++;
    }
    if (n !== 3 || cls.size !== 1) continue;
    const sc = 1 / (1 + Math.hypot(nd.at.x, nd.at.y) / 40);
    if (sc > bestScore) { bestScore = sc; start = id; }
  }
  if (!start) throw new Error('找不到起点路口');

  const nodes: string[] = [start];
  const edges = new Set<string>();
  const queue = [start];
  const usable = (eid: string): boolean => {
    const e = g.edges.get(eid);
    if (!e) return false;
    if (chordDeviation(e.pts) > 1.5) { skipped.push({ edgeId: eid, why: `折线偏离 ${chordDeviation(e.pts).toFixed(1)} m > 1.5` }); return false; }
    const s = secs[String(e.cls) as keyof typeof secs];
    if (!s) { skipped.push({ edgeId: eid, why: '缺断面' }); return false; }
    return true;
  };

  /** 一条边在两端各自扣掉 setback 后还剩多少米（<12 m 视为不可用） */
  const effectiveLen = (eid: string): number => {
    const e = g.edges.get(eid);
    if (!e) return -1;
    const chord = M(Math.hypot(e.pts[e.pts.length - 1].x - e.pts[0].x, e.pts[e.pts.length - 1].y - e.pts[0].y));
    const wOf = (nid: string) => {
      const nd = g.nodes.get(nid);
      if (!nd) return 15;
      let widest = 0;
      const seen = new Set<string>();
      for (const x of nd.edges) {
        const ee = g.edges.get(x);
        if (!ee || seen.has(x)) continue;
        seen.add(x);
        const sec = secs[String(ee.cls) as keyof typeof secs];
        if (sec) widest = Math.max(widest, sec.carriage / 2 + sec.curb + sec.walk);
      }
      return Math.ceil(widest || 6) + 10;
    };
    return chord - wOf(e.a) - wOf(e.b);
  };

  while (queue.length && nodes.length < want) {
    const cur = queue.shift()!;
    const nd = g.nodes.get(cur)!;
    // 先挑"扣掉退让后最长"的边，避免刚起步就被短路段卡死
    const cand = [...new Set(nd.edges)]
      .filter((eid) => !edges.has(eid) && usable(eid))
      .sort((x, y) => effectiveLen(y) - effectiveLen(x));
    for (const eid of cand) {
      if (nodes.length >= want) break;
      // P1：短连接不再静默删除，交给编译验证（只记诊断）
      if (effectiveLen(eid) < 12) shortEdges.push({ edgeId: eid, remainM: effectiveLen(eid) });
      const e = g.edges.get(eid)!;
      const other = e.a === cur ? e.b : e.a;
      const on = g.nodes.get(other);
      if (!on || on.degree < 3) continue;                 // 只连到路口
      if (!g.junctions.includes(other)) continue;
      edges.add(eid);
      if (!nodes.includes(other)) { nodes.push(other); queue.push(other); }
    }
  }
  return { nodes, edges: [...edges], skipped, shortEdges };
}

export interface NetResult {
  ok: boolean;
  diagnostics: { severity?: string; code?: string; message: string }[];
  doc: any;
  net: any;
  /** 每条 stroke 的两端信息，便于诊断 */
  strokes: { id: string; edgeId: string; from: string; to: string; lenM: number; setbackFrom: number; setbackTo: number }[];
  junctions: { id: string; node: string; arms: number; role: 'T' | 'cross' }[];
  elapsedMs: number;
}

/** 用 cluster 构建一份文档并编译一次 */
export function buildNetwork(base: CityResult, cluster: Cluster): NetResult {
  const g = base.debug.graph;
  const secs = (base.debug.road as any).sections as Record<string, { carriage: number; curb: number; walk: number }>;
  const t0 = performance.now();

  // 1) 模板：按等级各一份（driving 半幅 = carriage/2；sidewalk = curb + walk）
  let doc: any = createRoadAuthoringDocument({ id: 'a61-net' });
  const tplOf = new Map<string, string>();
  for (const cls of ['arterial', 'collector', 'local'] as const) {
    const s = (secs as any)[cls];
    if (!s) continue;
    const id = `tpl_${cls}`;
    tplOf.set(cls, id);
    doc = addRoadTemplate(doc, {
      id, name: cls,
      lanes: [
        { role: 'left-through', side: 'left', order: 1, type: 'driving', width: s.carriage / 2 },
        { role: 'left-sidewalk', side: 'left', order: 2, type: 'sidewalk', width: s.curb + s.walk },
        { role: 'right-through', side: 'right', order: 1, type: 'driving', width: s.carriage / 2 },
        { role: 'right-sidewalk', side: 'right', order: 2, type: 'sidewalk', width: s.curb + s.walk },
      ],
    } as any);
  }
  if (doc.markings) doc.markings = [];

  // 2) 每臂 setback（按该路口最宽臂）
  const armInfo = new Map<string, { eid: string; dir: Pt; halfFull: number; cls: string }[]>();
  const setbackOf = new Map<string, number>();
  for (const nid of cluster.nodes) {
    const nd = g.nodes.get(nid)!;
    const seen = new Set<string>();
    const arms: { eid: string; dir: Pt; halfFull: number; cls: string }[] = [];
    for (const eid of nd.edges) {
      const e = g.edges.get(eid);
      if (!e || seen.has(eid)) continue;
      seen.add(eid);
      const pts = e.a === nd.id ? e.pts : e.pts.slice().reverse();
      const q = pts[Math.min(3, pts.length - 1)];
      const dx = q.x - nd.at.x, dy = q.y - nd.at.y, L = Math.hypot(dx, dy) || 1;
      const s = (secs as any)[String(e.cls)] ?? { carriage: 8, curb: 0.3, walk: 2 };
      arms.push({ eid, dir: new Pt(dx / L, dy / L), halfFull: s.carriage / 2 + s.curb + s.walk, cls: String(e.cls) });
    }
    armInfo.set(nid, arms);
    const widest = Math.max(...arms.map((a) => a.halfFull));
    setbackOf.set(nid, Math.ceil(widest) + 10);
  }

  // 3) 每条边一条 stroke（两端按各自 setback 内缩）
  /**
   * P0：**所有 incident 边都要有 stroke**，不只是 cluster 内部共享边。
   *
   * 之前只取 cluster.edges，导致每个路口只有 1~2 条臂有 stroke → intent 建不出来。
   * 区域外的边只生成 stroke（那一端没有 intent），这是合法的"断头路"。
   */
  const allEdges = new Set<string>(cluster.edges);
  for (const nid of cluster.nodes) {
    const nd = g.nodes.get(nid);
    if (!nd) continue;
    for (const eid of nd.edges) {
      const e = g.edges.get(eid);
      if (!e) continue;
      if (chordDeviation(e.pts) > 1.5) continue;   // 折线太长，line 段表达不了
      allEdges.add(eid);
    }
  }

  const shortEdgesOut: { edgeId: string; remainM: number }[] = [];
  const strokes: NetResult['strokes'] = [];
  for (const eid of allEdges) {
    const e = g.edges.get(eid)!;
    const pts = e.pts;
    const A = pts[0], B = pts[pts.length - 1];
    const Lm = M(Math.hypot(B.x - A.x, B.y - A.y));
    const sA = setbackOf.get(e.a) ?? 15;
    const sB = setbackOf.get(e.b) ?? 15;
    const rawLen = Lm - sA - sB;
    /**
     * 短连接：不再跳过，压到 4 m 下限照建，让编译给出真实诊断。
     * （真正的冲突由 three-roads 的 portal/assembly 判断，不由我们猜）
     */
    if (rawLen < 4) {
      // P0：**不伪造 4 m 残段**。记录冲突（边 + 两端节点 + 原始长度），交由上层判定 BLOCKED
      shortEdgesOut.push({ edgeId: eid, remainM: rawLen });
      continue;
    }
    const lenM = rawLen;
    const ux = (B.x - A.x) / (Math.hypot(B.x - A.x, B.y - A.y) || 1);
    const uy = (B.y - A.y) / (Math.hypot(B.x - A.x, B.y - A.y) || 1);
    // from 端（e.a）作 start：起点在 a 侧内缩处、朝 b 方向
    const x0 = A.x * 7 + ux * sA, y0 = A.y * 7 + uy * sA;
    const tpl = tplOf.get(String(e.cls)) ?? 'tpl_local';
    const sid = `st_${eid}`;
    doc = addRoadStroke(doc, {
      id: sid,
      geometry: [{ kind: 'line', s: 0, x: x0, y: y0, heading: Math.atan2(uy, ux), length: lenM }],
      templateSpans: [{ templateId: tpl, s: 0 }],
    } as any);
    strokes.push({ id: sid, edgeId: eid, from: e.a, to: e.b, lenM, setbackFrom: sA, setbackTo: sB });
  }

  // 4) 每个路口一个 intent；接触端按 stroke 的 from/to
  const strokeOfEdge = new Map(strokes.map((s) => [s.edgeId, s]));
  const junctions: NetResult['junctions'] = [];
  for (const nid of cluster.nodes) {
    const arms = armInfo.get(nid) ?? [];
    const items = arms.map((a) => {
      const st = strokeOfEdge.get(a.eid);
      if (!st) return null;
      const isStart = st.from === nid;                       // 该 stroke 在这一端是 start
      return {
        key: a.eid,
        roadId: st.id,
        contactPoint: (isStart ? 'start' : 'end') as 'start' | 'end',
        inbound: isStart ? 'left-through' : 'right-through',
        outbound: isStart ? 'right-through' : 'left-through',
      };
    }).filter(Boolean) as any[];
    if (items.length < 3) continue;                          // 缺臂：跳过该路口（诊断会体现）
    const ap = (i: number) => ({ key: items[i].key, roadId: items[i].roadId, contactPoint: items[i].contactPoint, inboundLaneRole: items[i].inbound, outboundLaneRole: items[i].outbound });
    try {
      if (items.length === 3) {
        // 主路 = 夹角最接近 180° 的一对
        let pi = 0, pj = 1, best = -1;
        for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
          const c = Math.abs((arms[i].dir.x * arms[j].dir.x + arms[i].dir.y * arms[j].dir.y));
          if (c > best) { best = c; pi = i; pj = j; }
        }
        const k = [0, 1, 2].find((x) => x !== pi && x !== pj)!;
        doc = addJunctionIntent(doc, createSingleLanePriorityTJunctionIntent({
          id: `jt_${nid}`, mainline: [ap(pi), ap(pj)], side: ap(k),
        } as any));
        junctions.push({ id: `jt_${nid}`, node: nid, arms: 3, role: 'T' });
      } else if (items.length === 4) {
        doc = addJunctionIntent(doc, createSingleLaneFourArmJunctionIntent({
          id: `jt_${nid}`, approaches: [ap(0), ap(1), ap(2), ap(3)],
        } as any));
        junctions.push({ id: `jt_${nid}`, node: nid, arms: 4, role: 'cross' });
      }
    } catch (e: any) {
      junctions.push({ id: `jt_${nid}`, node: nid, arms: items.length, role: items.length === 4 ? 'cross' : 'T' });
    }
  }

  const comp: any = compileRoadNetwork(doc);
  const elapsedMs = performance.now() - t0;
  return {
    ok: !!comp.ok,
    diagnostics: (comp.diagnostics ?? []).filter((d: any) => d.severity === 'error'),
    doc,
    net: comp.network,
    strokes,
    junctions,
    elapsedMs,
  };
}

/**
 * **官方路径**：stroke 端点画到路口中心，退让与 intent 交给 `resolveAutomaticNetwork`。
 *
 * 与 `buildNetwork` 的区别（也是之前所有问题的根因）：
 *   · 不手削 stroke（不扣 setback）—— 库按 `junctionPortalSetback` 自己截
 *   · 不手写 intent —— 库按端点吸附自动建 common-junction
 *   · 不设固定臂长 —— 长度 = 真实 RoadGraph 边的全长
 */
export function buildNetworkAuto(base: CityResult, cluster: Cluster, portalSetbackM = 12): NetResult {
  const g = base.debug.graph;
  const secs = (base.debug.road as any).sections as Record<string, { carriage: number; curb: number; walk: number }>;
  const t0 = performance.now();

  let doc: any = createRoadAuthoringDocument({ id: 'a61-auto' });
  const tplOf = new Map<string, string>();
  for (const cls of ['arterial', 'collector', 'local'] as const) {
    const sec = (secs as any)[cls];
    if (!sec) continue;
    const id = `tpl_${cls}`;
    tplOf.set(cls, id);
    doc = addRoadTemplate(doc, {
      id, name: cls,
      lanes: [
        { role: 'left-through', side: 'left', order: 1, type: 'driving', width: sec.carriage / 2 },
        { role: 'left-sidewalk', side: 'left', order: 2, type: 'sidewalk', width: sec.curb + sec.walk },
        { role: 'right-through', side: 'right', order: 1, type: 'driving', width: sec.carriage / 2 },
        { role: 'right-sidewalk', side: 'right', order: 2, type: 'sidewalk', width: sec.curb + sec.walk },
      ],
    } as any);
  }

  // 所有 incident 边 → 全长 stroke（端点落在路口中心，不扣退让）
  const allEdges = new Set<string>(cluster.edges);
  for (const nid of cluster.nodes) {
    const nd = g.nodes.get(nid);
    if (!nd) continue;
    for (const eid of nd.edges) {
      const e = g.edges.get(eid);
      if (!e) continue;
      if (chordDeviation(e.pts) > 1.5) continue;
      allEdges.add(eid);
    }
  }
  const strokes: NetResult['strokes'] = [];
  for (const eid of allEdges) {
    const e = g.edges.get(eid)!;
    const A = e.pts[0], B = e.pts[e.pts.length - 1];
    const dx = B.x - A.x, dy = B.y - A.y;
    const Lm = Math.hypot(dx, dy) * 7;
    if (Lm < 6) continue;
    doc = addRoadStroke(doc, {
      id: `st_${eid}`,
      geometry: [{ kind: 'line', s: 0, x: A.x * 7, y: A.y * 7, heading: Math.atan2(dy, dx), length: Lm }],
      templateSpans: [{ templateId: tplOf.get(String(e.cls)) ?? 'tpl_local', s: 0 }],
    } as any);
    strokes.push({ id: `st_${eid}`, edgeId: eid, from: e.a, to: e.b, lenM: Lm, setbackFrom: 0, setbackTo: 0 });
  }

  const res: any = resolveAutomaticNetwork(doc, { junctionPortalSetback: portalSetbackM, snapTolerance: 1.5, splitInteriorCrossings: true });
  const cc: any = compileRoadNetwork(res.document);
  const errs = (cc.diagnostics ?? []).filter((d: any) => d.severity === 'error');
  return {
    ok: !!cc.ok,
    diagnostics: errs,
    doc: res.document,
    net: cc.network,
    strokes,
    junctions: (res.nodes ?? []).map((n: any) => ({ id: n.id, node: n.id, arms: n.roadIds.length, role: n.kind === 'common-junction' ? 'cross' : 'T' })),
    elapsedMs: performance.now() - t0,
  };
}
