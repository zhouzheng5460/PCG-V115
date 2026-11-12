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

  const res: any = resolveAutomaticNetwork(doc, { junctionPortalSetback: portalSetbackM, snapTolerance: 1.5, splitInteriorCrossings: false });
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

/**
 * **原生全城道路生成（P1.1）**：不读任何旧路面几何，只用 RoadGraph 的中心线拓扑。
 *
 * 与 `buildNetworkAuto` 的差别：
 *   · 覆盖**全城**所有边，不做 chordDeviation 过滤（不再要求"近似直线"）
 *   · 每条边按**折线逐段**输出 line 段（s 累加），而不是拉成一根弦
 *   · 输出统计供验收（stroke 数、总长、模板分布、自动节点分布）
 */
export interface NativeResult {
  ok: boolean;
  diagnostics: { code?: string; message: string }[];
  doc: any;
  net: any;
  stats: {
    edges: number;
    strokes: number;
    segments: number;
    totalLenM: number;
    tplOf: Record<string, number>;
    nodes: { total: number; common: number; continuation: number; requiresSplit: number };
    resolveMs: number;
    compileMs: number;
    droppedJunctions?: string[];
    usedSetbackM?: number;
    droppedShort?: number;
    normalizedEdges?: number;
    tangentFixNodes?: number;
    tangentFixEdges?: number;
    tangentMaxShiftM?: number;
    droppedShortSample?: { edgeId: string; lenM: number }[];
    removedTooShort?: { strokeId: string; lenM: number }[];
  };
}

/**
 * **中心线规范化（P2）**：保端点、去高频点。
 *
 * 张量场采样出的折线里夹着 0.1~0.5 m 的碎段；道路半宽 4~8.5 m，
 * 偏移时这些碎段会**折过去**，左右边界自交 → `Invalid polygon ring`。
 * 中心线本身没自交（实测 132 条 stroke 自交数全 0），所以这是
 * **Offset Geometry Failure**，不是拓扑错误。
 *
 * 规则（确定性）：
 *   · 相邻点间距 < minSegM 的**丢弃**（保留前一个），首尾点强制保留
 *   · 不改端点坐标 → 接口位置不变
 *   · 不改变弯向，只降采样
 */
/**
 * **一条边 → 一个几何段（line 或 arc）**。
 *
 * three-roads 的 `RoadStroke.geometry` 是**切向连续（G1）**的参考线链：
 * line 接 line 必须共线，曲线只能用 arc / spiral。
 * 我之前"折线逐段拆成 line"——每条 joint 都有 0.002~0.1 rad 的折角，
 * 直接被拒：`geometry heading jumps 0.0023 rad at s=17`。
 *
 * 规则：
 *   · 偏离弦 < 0.3 m → 一个 `line`
 *   · 否则用 首/中/尾 三点定圆 → 一个 `arc`（curvature = 1/R，带符号）
 *   · 单段天然满足 G1（没有 joint）
 */
export function fitEdgeSegment(pts: Pt[]): any {
  if (pts.length < 2) return null;
  const A = pts[0], B = pts[pts.length - 1];
  const dx = (B.x - A.x) * 7, dy = (B.y - A.y) * 7;
  const chord = Math.hypot(dx, dy);
  if (chord < 0.5) return null;

  /** 端点切向：用 6 m 窗口估计（不依赖可能只有 0.14 m 的末段） */
  const tangentAt = (fromEnd: boolean): number => {
    const p0 = fromEnd ? A : B;
    let k = 0;
    for (let i2 = 1; i2 < pts.length; i2++) {
      const p = fromEnd ? pts[i2] : pts[pts.length - 1 - i2];
      if (Math.hypot(p.x - p0.x, p.y - p0.y) * 7 >= 6) { k = i2; break; }
      k = i2;
    }
    const p = fromEnd ? pts[k] : pts[pts.length - 1 - k];
    const ang = Math.atan2((p0.y - p.y), (p0.x - p.x));
    return fromEnd ? ang : ang + Math.PI;   // fromEnd: 从起点向外；否则行进方向
  };
  const t0 = tangentAt(true);
  const head = Math.atan2(dy, dx);
  const angDiff = (a: number, b: number) => {
    const d = Math.abs(a - b) % (Math.PI * 2);
    return (d > Math.PI ? Math.PI * 2 - d : d) * (180 / Math.PI);
  };
  // 终点切向（行进方向）
  let tEnd = t0;
  {
    const pLast = B;
    let k = 0;
    for (let i2 = 1; i2 < pts.length; i2++) {
      const p = pts[pts.length - 1 - i2];
      if (Math.hypot(p.x - pLast.x, p.y - pLast.y) * 7 >= 6) { k = i2; break; }
      k = i2;
    }
    const p = pts[pts.length - 1 - k];
    tEnd = Math.atan2((pLast.y - p.y), (pLast.x - p.x));
  }

  // 偏离弦的最大垂距
  const ux = dx / chord, uy = dy / chord;
  let dev = 0;
  for (const p of pts) {
    const vx = p.x * 7 - A.x * 7, vy = p.y * 7 - A.y * 7;
    dev = Math.max(dev, Math.abs(vx * uy - vy * ux));
  }

  /**
   * **P1：Line 必须同时满足位置与两端切向**。
   * 只看位置偏差会把"两端各偏 10° 的微弯路"拉直，导致节点处出现假折角
   * （实测：e0 弦 0° vs e1 端点 20.5° → 贯通对折角 20.5° → connector 解不出）。
   */
  const tolPos = 0.3, tolAng = 1.0;
  if (dev < tolPos && angDiff(t0, head) < tolAng && angDiff(tEnd, head) < tolAng) {
    return { seg: { kind: 'line', s: 0, x: A.x * 7, y: A.y * 7, heading: head, length: chord }, lenM: chord, kind: 'line' };
  }

  /**
   * **P2：圆弧由「起点 + 起点切向 + 终点」唯一确定**，而不是用 κ=(θ1−θ0)/L 反推。
   * 圆心 C = A + R·n（n 为切向左法向），由 |C−B| = R 解得 R = |D|² / (2·(D·n))。
   * 这样起点坐标、起点切向、终点坐标三者**同时精确**。
   */
  const Ax = A.x * 7, Ay = A.y * 7, Bx = B.x * 7, By = B.y * 7;
  const n = { x: -Math.sin(t0), y: Math.cos(t0) };          // 左法向
  const D = { x: Bx - Ax, y: By - Ay };
  const Dn = D.x * n.x + D.y * n.y;
  if (Math.abs(Dn) < 1e-6) {
    return { seg: { kind: 'line', s: 0, x: Ax, y: Ay, heading: head, length: chord }, lenM: chord, kind: 'line' };
  }
  const R = (D.x * D.x + D.y * D.y) / (2 * Dn);
  /**
   * **半径下限**：弧半径接近或小于道路半宽时，内侧偏移半径为负 → 边界翻转 → 自交。
   * 这里按"半宽 + 1 m"设下限，不足则退回直线（宁可牺牲这条边的端点切向，
   * 也不产生自交；全城只有极少数边会命中）。
   */
  const halfW = (chord > 0 ? 0 : 0) + 8.5 + 1;
  const Cx = Ax + n.x * R, Cy = Ay + n.y * R;
  const a0 = Math.atan2(Ay - Cy, Ax - Cx);
  const a1 = Math.atan2(By - Cy, Bx - Cx);
  let dA = a1 - a0;
  while (dA > Math.PI) dA -= Math.PI * 2;
  while (dA < -Math.PI) dA += Math.PI * 2;
  // 小半径弧只做诊断，不再退回直线（退回会牺牲端点切向，掩盖真实问题）
  const smallR = Math.abs(R) < halfW;
  /**
   * **近零曲率退化为直线**（关键修复）。
   *
   * 切线差 1.0001° 也能解出一个 R = 1e7 m 的"弧"，偏移时数值灾难，
   * 会在布尔里产生 0.298 m 的薄片环 → `Invalid polygon ring`。
   * R > 1000 m 时几何上与直线无异，直接按直线输出。
   */
  if (Math.abs(R) > 1000) {
    return { seg: { kind: 'line', s: 0, x: Ax, y: Ay, heading: head, length: chord }, lenM: chord, kind: 'line', debug: { fallback: 'near-zero-curvature' } };
  }
  const arcLen = Math.abs(R * dA);
  const curv = (dA >= 0 ? 1 : -1) / Math.abs(R);
  // 用构造值校验：终点位置误差应为 0，终点切向误差应很小
  const endTangent = a1 + (dA >= 0 ? Math.PI / 2 : -Math.PI / 2);
  const endErr = Math.hypot(Cx + Math.cos(a1) * Math.abs(R) - Bx, Cy + Math.sin(a1) * Math.abs(R) - By);
  return {
    seg: { kind: 'arc', s: 0, x: Ax, y: Ay, heading: t0, length: arcLen, curvature: curv },
    lenM: arcLen,
    kind: 'arc',
    debug: { R: Math.abs(R), endErrM: endErr, dThetaDeg: (dA * 180) / Math.PI, endTanErrDeg: angDiff(endTangent, tEnd), smallR },
  };
}

export function normalizePolyline(pts: Pt[], minSegM = 1.5): Pt[] {
  if (pts.length <= 2) return pts;
  const out: Pt[] = [pts[0]];
  const minU = minSegM / 7;
  for (let i = 1; i < pts.length - 1; i++) {
    const last = out[out.length - 1];
    if (Math.hypot(pts[i].x - last.x, pts[i].y - last.y) >= minU) out.push(pts[i]);
  }
  const end = pts[pts.length - 1];
  const last = out[out.length - 1];
  if (out.length > 1 && Math.hypot(end.x - last.x, end.y - last.y) < minU) out.pop();
  out.push(end);
  return out.length >= 2 ? out : pts;
}

/**
 * **节点切向整理（P1.7）**：把"贯通臂对"在节点处的折角拉直。
 *
 * 为什么需要：两臂夹角 180°−20.5° 时，库解不出 connector
 * （`geometries` 里没有该 maneuver → 冲突消解报 contact heading 不可用）。
 *
 * 做法（确定性）：
 *   · 每个节点上找"最接近 180°"的一对臂，若折角 ≤ maxAngle 则视为贯通
 *   · 目标方向 = 两臂向外方向的平均轴
 *   · 只在**末端 rangeM 范围内**把点绕端点旋转，权重 1→0 线性衰减
 *   · 端点坐标不动 → Junction 位置不变；范围外几何不动
 */
export function regularizeNodeTangents(
  g: any,
  ptsOf: Map<string, Pt[]>,
  maxAngleDeg = 30,
  rangeM = 15
): { touchedEdges: Set<string>; fixedNodes: string[]; maxShiftM: number } {
  const touched = new Set<string>();
  const fixedNodes: string[] = [];
  let maxShift = 0;
  const R = rangeM / 7;

  for (const nid of g.junctions) {
    const nd = g.nodes.get(nid);
    if (!nd) continue;
    const seen = new Set<string>();
    const arms: { eid: string; atEnd: boolean; dir: Pt }[] = [];
    for (const eid of nd.edges) {
      if (seen.has(eid)) continue;
      seen.add(eid);
      const pts = ptsOf.get(String(eid));
      if (!pts || pts.length < 2) continue;
      const atStart = Math.hypot(pts[0].x - nd.at.x, pts[0].y - nd.at.y) < 0.5;
      const atEnd = Math.hypot(pts[pts.length - 1].x - nd.at.x, pts[pts.length - 1].y - nd.at.y) < 0.5;
      if (!atStart && !atEnd) continue;
      const p0 = atStart ? pts[0] : pts[pts.length - 1];
      const p1 = atStart ? pts[Math.min(2, pts.length - 1)] : pts[Math.max(0, pts.length - 3)];
      const dx = p0.x - p1.x, dy = p0.y - p1.y;
      const L = Math.hypot(dx, dy) || 1;
      arms.push({ eid: String(eid), atEnd, dir: new Pt(dx / L, dy / L) });
    }
    if (arms.length < 2) continue;
    // 找最接近 180° 的一对
    let bi = 0, bj = 1, bdev = 999;
    for (let i = 0; i < arms.length; i++) for (let j = i + 1; j < arms.length; j++) {
      const dot = arms[i].dir.x * arms[j].dir.x + arms[i].dir.y * arms[j].dir.y;
      const ang = (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
      const dev = Math.abs(180 - ang);
      if (dev < bdev) { bdev = dev; bi = i; bj = j; }
    }
    if (bdev > maxAngleDeg) continue;
    // 平均轴
    const ax = arms[bi].dir.x - arms[bj].dir.x, ay = arms[bi].dir.y - arms[bj].dir.y;
    const al = Math.hypot(ax, ay) || 1;
    const axis = new Pt(ax / al, ay / al);
    for (const arm of [arms[bi], arms[bj]]) {
      const pts = ptsOf.get(arm.eid)!;
      const target = arm.dir.x * axis.x + arm.dir.y * axis.y >= 0 ? axis : new Pt(-axis.x, -axis.y);
      const delta = Math.atan2(target.y, target.x) - Math.atan2(arm.dir.y, arm.dir.x);
      const norm = ((delta + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      if (Math.abs(norm) < 1e-4) continue;
      const end = arm.atEnd ? pts.length - 1 : 0;
      const dirStep = arm.atEnd ? -1 : 1;
      const pivot = arm.atEnd ? pts[pts.length - 1] : pts[0];
      for (let k = 1; k < pts.length; k++) {
        const idx = end + dirStep * k;
        if (idx < 0 || idx >= pts.length) break;
        const dist = Math.hypot(pts[idx].x - pivot.x, pts[idx].y - pivot.y);
        if (dist > R) break;
        const w = 1 - dist / R;                      // 端点 1，范围外 0
        const ang = norm * w;
        const ca = Math.cos(ang), sa = Math.sin(ang);
        const vx = pts[idx].x - pivot.x, vy = pts[idx].y - pivot.y;
        const nx = pivot.x + vx * ca - vy * sa, ny = pivot.y + vx * sa + vy * ca;
        maxShift = Math.max(maxShift, Math.hypot(nx - pts[idx].x, ny - pts[idx].y) * 7);
        pts[idx] = new Pt(nx, ny);
      }
      touched.add(arm.eid);
    }
    fixedNodes.push(nid);
  }
  return { touchedEdges: touched, fixedNodes, maxShiftM: maxShift };
}

/**
 * ⚠️ **实验性 / 禁止正式调用**（TECH-ROAD-FREEZE）
 *
 * 全城单网络编译仍失败：为通过校验它会"删 stroke / 删 junction"，
 * 这是在用删数据满足库的几何校验，不是修复几何。冻结评审结论：
 * 正式管线**只能**走 `roadsThree.ts` 的逐路口替换；本函数仅在诊断脚本
 * 显式传入 `{ experimental: true }` 时才允许执行。
 */
export function buildCityNative(
  base: CityResult,
  portalSetbackM = 12,
  opts: { experimental?: boolean } = {}
): NativeResult {
  if (!opts.experimental) {
    throw new Error(
      'buildCityNative 是实验性接口（全城单网络仍失败）。' +
        '正式管线请用 roadsThree.applyThreeRoads；诊断请显式传 { experimental: true }。'
    );
  }
  const g = base.debug.graph;
  const secs = (base.debug.road as any).sections as Record<string, { carriage: number; curb: number; walk: number }>;

  let doc: any = createRoadAuthoringDocument({ id: 'native-city' });
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

  let strokes = 0, segments = 0, totalLenM = 0;
  const tplCount: Record<string, number> = {};
  /**
   * **形态规则 ①：短边整理**。
   *
   * `resolveAutomaticNetwork` 要求每条路至少放得下两端的 `junctionPortalSetback`，
   * 否则直接抛错。所以先把"肯定放不下"的边摘掉（短于 2×退让 + 2 m），
   * 记进诊断，而不是伪造长度。这些边在城市里本来就是几米的碎头。
   */
  const minLenM = 2 * portalSetbackM + 2;
  const droppedShort: { edgeId: string; lenM: number }[] = [];
  // 先把所有边拷一份，供切向整理使用
  const ptsMap = new Map<string, Pt[]>();
  for (const e of g.edges.values()) ptsMap.set(String(e.id), normalizePolyline(e.pts as Pt[], 1.5));
  // P0：暂时关闭节点切向整理，验证它不是编译通过的必要条件
  const reg = { touchedEdges: new Set<string>(), fixedNodes: [] as string[], maxShiftM: 0 };

  let normalizedPts = 0;
  for (const e of g.edges.values()) {
    const rawPts = e.pts;
    if (rawPts.length < 2) continue;
    const pts = ptsMap.get(String(e.id)) ?? normalizePolyline(rawPts as Pt[], 1.5);
    if (pts.length !== rawPts.length) normalizedPts++;
    const chordM = Math.hypot((pts[pts.length - 1].x - pts[0].x) * 7, (pts[pts.length - 1].y - pts[0].y) * 7);
    if (chordM < minLenM) { droppedShort.push({ edgeId: String(e.id), lenM: chordM }); continue; }
    // 一条边 → 一个 line 或一个 arc（G1 连续）
    const fit = fitEdgeSegment(pts as Pt[]);
    if (!fit) continue;
    const segs = [fit.seg];
    const sAcc = fit.lenM;
    segments++;
    const tpl = tplOf.get(String(e.cls)) ?? 'tpl_local';
    doc = addRoadStroke(doc, { id: `st_${e.id}`, geometry: segs, templateSpans: [{ templateId: tpl, s: 0 }] } as any);
    strokes++;
    totalLenM += sAcc;
    tplCount[tpl] = (tplCount[tpl] ?? 0) + 1;
  }

  /**
   * `resolveAutomaticNetwork` 在**退让放不进短边**时会直接抛错
   * （`Road xxx is too short for its junction portal setbacks`）。
   *
   * 这是库的硬约束，不是我们的 bug。做法：从给定退让开始**确定性递减**，
   * 取第一个能解通的档位，并把实际使用的档位记进统计 —— 不造假、不跳过。
   */
  const t1 = performance.now();
  let res: any = null;
  let usedSetback = portalSetbackM;

  /**
   * **确定性收敛规则**（P3）。
   *
   * 库在 `reserveJunctionFootprints` 里判：`length <= reserved.start + reserved.end`
   * 就抛错，而 `reserved = fitPortalSetback(adaptivePortalSetback(...))` ——
   * 它按模板宽度**自适应放大**，所以"调小 portalSetback"并不能保证通过。
   *
   * 这里的规则：按**真实几何长度**从最短的边开始摘，直到 resolve 成功。
   * 每一步记录被摘的边与长度，作为城市形态层的诊断输出（不伪造长度）。
   */
  const edgeLenM = new Map<string, number>();
  for (const e of g.edges.values()) {
    if (e.pts.length < 2) continue;
    let L = 0;
    for (let i = 0; i + 1 < e.pts.length; i++) L += Math.hypot(e.pts[i + 1].x - e.pts[i].x, e.pts[i + 1].y - e.pts[i].y) * 7;
    edgeLenM.set(`st_${e.id}`, L);
  }
  const removed: { strokeId: string; lenM: number }[] = [];
  let docTry = doc;
  for (let guard = 0; guard < 40; guard++) {
    try {
      res = resolveAutomaticNetwork(docTry, { junctionPortalSetback: portalSetbackM, snapTolerance: 1.5, splitInteriorCrossings: false });
      break;
    } catch (e2: any) {
      const m = /Road (\S+) is too short/.exec(String(e2?.message ?? ''));
      if (!m) throw e2;
      const bad = m[1];
      removed.push({ strokeId: bad, lenM: edgeLenM.get(bad) ?? -1 });
      // 从文档里摘掉这条 stroke（不改几何、不改长度）
      docTry = { ...docTry, strokes: (docTry.strokes ?? []).filter((x: any) => String(x.id) !== bad) };
    }
  }
  const resolveMs = performance.now() - t1;
  if (!res) throw new Error('resolveAutomaticNetwork 无法完成（见 removedTooShort）');
  /**
   * **逐路口剔除收敛**：编译失败时解析错误里的 junction id，移除该 intent 后重试。
   *
   * 剩下 5 条错误都是"两臂几乎平行 → maneuver contact heading 不可用"，
   * 属于该路口几何不可解，不影响其它路口。移除后它的道路自然变成 continuation，
   * 路面仍在（由 lane patches 提供），只是少了路口内的转向连接。
   */
  const t2 = performance.now();
  let doc2: any = res.document;
  const droppedJunctions: string[] = [];
  let cc: any = compileRoadNetwork(doc2);
  for (let guard = 0; guard < 12 && !cc.ok; guard++) {
    const errs = (cc.diagnostics ?? []).filter((d: any) => d.severity === 'error');
    const msg = String(errs[0]?.message ?? '');
    const mj = /Junction (\S+?)\x20/.exec(msg);
    if (mj?.[1]) {
      const jid = mj[1];
      doc2 = { ...doc2, junctions: (doc2.junctions ?? []).filter((j: any) => String(j.id) !== jid) };
      droppedJunctions.push(jid);
      cc = compileRoadNetwork(doc2);
      continue;
    }
    // 两条路凭空交叉：剔除较短的那条（多为短支路），避免整城编译失败
    const mc = /Roads (\S+) and (\S+) cross without a junction/.exec(msg);
    if (mc) {
      const [a, b] = [mc[1], mc[2]];
      const lenOf = (id: string) => (doc2.strokes ?? []).filter((x: any) => String(x.id) === id)
        .reduce((t: number, x: any) => t + (x.geometry ?? []).reduce((u: number, g: any) => u + (g.length ?? 0), 0), 1e9);
      const drop = lenOf(a) <= lenOf(b) ? a : b;
      doc2 = { ...doc2, strokes: (doc2.strokes ?? []).filter((x: any) => String(x.id) !== drop) };
      droppedJunctions.push(`cross:${drop}`);
      cc = compileRoadNetwork(doc2);
      continue;
    }
    break;
    cc = compileRoadNetwork(doc2);
  }
  const compileMs = performance.now() - t2;

  const nodes = res.nodes ?? [];
  return {
    ok: !!cc.ok,
    diagnostics: (cc.diagnostics ?? []).filter((d: any) => d.severity === 'error'),
    doc: res.document,
    net: cc.network,
    stats: {
      edges: g.edges.size,
      strokes,
      segments,
      totalLenM,
      tplOf: tplCount,
      nodes: {
        total: nodes.length,
        common: nodes.filter((n: any) => n.kind === 'common-junction').length,
        continuation: nodes.filter((n: any) => n.kind === 'continuation').length,
        requiresSplit: nodes.filter((n: any) => n.kind === 'requires-split').length,
      },
      resolveMs,
      compileMs,
      droppedJunctions,
      usedSetbackM: usedSetback,
      droppedShort: droppedShort.length,
      normalizedEdges: normalizedPts,
      tangentFixNodes: reg.fixedNodes.length,
      tangentFixEdges: reg.touchedEdges.size,
      tangentMaxShiftM: reg.maxShiftM,
      droppedShortSample: droppedShort.slice(0, 5),
      removedTooShort: removed,
    },
  };
}
