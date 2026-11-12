/**
 * three-roads 道路预览（Feature Flag 隔离）
 *
 * 开关：URL `?f3roads=three`，或运行时 `setRoadsMode('three')`。
 * 默认 `'old'`，走原有管线，本模块一行不参与。
 *
 * 做法：把真实路口 n26_-47310 的 three-roads 装配面 + 相邻道路面
 * **减去**旧道路面（Clipper 差集，真正的所有权裁剪，不是抬高叠压），
 * 再追加到 scene。建筑 / 地块 / 绿地 / 相机全都不动。
 */
import { canonicalAuthoringScenarios, compileRoadNetwork, inferJunctionAssemblySurfaces, inferLaneSurfacePatches } from '@three-roads/core';
import type { CityResult } from './index';
import type { SurfaceFeature } from '../scene/types';
import { surfaceArea, surfaceIntersect, surfaceSubtract, surfaceUnion, type PlanSurface } from '../town/planning/core/surface';
import { closeSurfaceSet, offsetSurfaceSet } from '../core/clipper';
import { Pt } from '../core/geom';
import { M2 } from './geom';

export type RoadsMode = 'old' | 'three';

/**
 * 目标路口**运行时**解析，不写死 ID。
 *
 * 之前写死 `n26_-47310`，但那是 `seed 20261106 / r95 / medium` 那座城的节点 ID；
 * 页面默认是 `seed 682063530 / r90 / low`，节点 ID 完全不同 → 预览直接失败。
 * 现在按确定性规则从当前图里挑：三臂、等宽、夹角尽量接近正交、靠近城市中心。
 */
export let TARGET_JUNCTION = '';

let mode: RoadsMode = (() => {
  if (typeof location === 'undefined') return 'old';
  return new URLSearchParams(location.search).get('f3roads') === 'three' ? 'three' : 'old';
})();

export const roadsMode = (): RoadsMode => mode;
export const setRoadsMode = (m: RoadsMode): void => {
  mode = m;
};

const M = (u: number): number => u * 7;
const U = (m: number): number => m / 7;

interface Arm { dir: Pt; halfM: number }

const surfaceUnionPS = (l: PlanSurface[]): PlanSurface[] => (l.length ? surfaceUnion(l) : []);
const toPS = (arr: any[]): PlanSurface[] =>
  arr.map((p) => ({
    outer: p.outer.map((v: any) => new Pt(v.x / 7, v.y / 7)),
    holes: (p.holes ?? []).map((h: any[]) => h.map((v: any) => new Pt(v.x / 7, v.y / 7))),
  }));

/**
 * 目标路口 + 最近的若干个路口（只用于"逐路口"替换，不做网络）。
 */
function pickNearbyJunctions(base: CityResult, seedId: string, n: number, maxDistM = 220): string[] {
  const g = base.debug.graph;
  const seed = g.nodes.get(seedId);
  if (!seed) return [seedId];
  const others = g.junctions
    .filter((id) => id !== seedId)
    .map((id) => ({ id, d: Math.hypot(g.nodes.get(id)!.at.x - seed.at.x, g.nodes.get(id)!.at.y - seed.at.y) * 7 }))
    .filter((o) => o.d < maxDistM)
    .sort((a, b) => a.d - b.d)
    .slice(0, n);
  return [seedId, ...others.map((o) => o.id)];
}

/**
 * 从当前 RoadGraph 里确定性地挑一个三臂路口。
 * 规则：三臂 · 三条边同一等级 · 最小夹角最大者优先 · 距离城市质心更近者优先。
 */
function resolveTarget(base: CityResult): { id: string; at: Pt } {
  const g = base.debug.graph;
  let cx = 0, cy = 0, n = 0;
  for (const nd of g.nodes.values()) { cx += nd.at.x; cy += nd.at.y; n++; }
  cx /= Math.max(1, n); cy /= Math.max(1, n);

  let best: { id: string; at: Pt; score: number } | null = null;
  for (const id of g.junctions) {
    const nd = g.nodes.get(id);
    if (!nd) continue;
    const seen = new Set<string>();
    const dirs: Pt[] = [];
    const clss = new Set<string>();
    for (const eid of nd.edges) {
      const e = g.edges.get(eid);
      if (!e || seen.has(eid)) continue;
      seen.add(eid);
      const pts = e.a === nd.id ? e.pts : e.pts.slice().reverse();
      const q = pts[Math.min(3, pts.length - 1)];
      dirs.push(new Pt(q.x - nd.at.x, q.y - nd.at.y));
      clss.add(String(e.cls));
    }
    if (dirs.length !== 3 || clss.size !== 1) continue;   // 只收三臂等宽
    // 最小夹角（越接近 90° 越好）
    const angs = dirs.map((d) => Math.atan2(d.y, d.x)).sort((a, b) => a - b);
    let gap = 360;
    for (let i = 0; i < 3; i++) {
      const d = (((angs[(i + 1) % 3] - angs[i]) * 180) / Math.PI + 360) % 360;
      gap = Math.min(gap, d);
    }
    const ortho = -Math.abs(gap - 90);                     // 越大越正交
    const dist = Math.hypot(nd.at.x - cx, nd.at.y - cy);
    const score = ortho * 10 - dist;                        // 正交优先，其次靠中心
    if (!best || score > best.score) best = { id, at: nd.at, score };
  }
  if (!best) throw new Error('当前城市里没有符合条件的三臂等宽路口');
  return { id: best.id, at: best.at };
}

/**
 * 生成该路口的 three-roads 面（米制 → 世界单位）。
 * @returns 装配面（role junction）+ 道路臂面（role road）
 */
function buildThreeRoads(base: CityResult, forceId?: string): { junction: PlanSurface[]; sidewalk: PlanSurface[]; road: PlanSurface[]; setbackM: number; ms: number; centerAt: Pt; armEnds: { p: Pt; dir: Pt }[] } {
  const g = base.debug.graph;
  const secs = (base.debug.road as any).sections as Record<string, { carriage: number; curb: number; walk: number }>;
  const resolved = forceId ? { id: forceId, at: base.debug.graph.nodes.get(forceId)!.at } : resolveTarget(base);
  TARGET_JUNCTION = resolved.id;
  const node = g.nodes.get(resolved.id);
  if (!node) throw new Error(`未找到路口 ${resolved.id}`);

  const seen = new Set<string>();
  const arms: (Arm & { eid: string })[] = [];
  for (const eid of node.edges) {
    const e = g.edges.get(eid);
    if (!e || seen.has(eid)) continue;
    seen.add(eid);
    const pts = e.a === node.id ? e.pts : e.pts.slice().reverse();
    const q = pts[Math.min(3, pts.length - 1)];
    const dx = q.x - node.at.x, dy = q.y - node.at.y, L = Math.hypot(dx, dy) || 1;
    const s = secs[String(e.cls) as keyof typeof secs];
    arms.push({ eid, dir: new Pt(dx / L, dy / L), halfM: (s?.carriage ?? 8) / 2 });
  }
  if (arms.length < 3 || arms.length > 4) throw new Error(`路口 ${resolved.id} 臂数 ${arms.length} 不支持（3/4）`);

  const halfM = arms[0].halfM;
  /** 全断面半宽 → 自适应退让（A5.1C：ceil(半宽)+10，且不得落在 14~18 m 禁带） */
  const halfFull = halfM + 2.95;
  const baseSetback = Math.ceil(halfFull) + 10;
  /**
   * **A6.3：短边自适应**。
   *
   * 两条路口之间只剩 20~30 m 时，两端各退 19 m 会把路吃穿。
   * 这里按**最短相邻边**压退让，下限 12 m；压不下去的路口交给上层判 BLOCKED。
   */
  let minChord = 1e9;
  for (const a of arms) {
    const e = g.edges.get(a.eid);
    if (!e) continue;
    minChord = Math.min(minChord, Math.hypot(e.pts[e.pts.length - 1].x - e.pts[0].x, e.pts[e.pts.length - 1].y - e.pts[0].y) * 7);
  }
  const setbackM = Math.max(12, Math.min(baseSetback, minChord / 2 - 5));

  /**
   * **A6.2：按臂数挑基础场景**，不再自己拼 intent。
   *
   * 3 臂用官方 T 字场景、4 臂用官方四臂场景 —— 它们的 ports / maneuvers /
   * laneContinuations 都是官方调好的，我只搬 stroke 几何和宽度。
   * 这样四臂路口不用手写 12 条转向，也不会踩 14/16 那种坑。
   */
  const scenarioName = arms.length === 4 ? 'Canonical four-arm urban intersection' : 'Canonical priority T junction';
  const scenario = canonicalAuthoringScenarios.find((s2: any) => s2.name === scenarioName);
  if (!scenario) throw new Error(`缺少基础场景：${scenarioName}`);
  const doc: any = JSON.parse(JSON.stringify(scenario.buildDocument()));
  doc.markings = [];
  for (const t of doc.templates) for (const ln of t.lanes) {
    if (ln.type === 'driving') ln.width = halfM;
    if (ln.type === 'sidewalk') ln.width = 2.95;
  }
  // 模板 ID 跟着场景走（四臂场景不叫 urban-two-way）
  const tplId = String(doc.templates?.[0]?.id ?? 'urban-two-way');
  // 主路 = 夹角最接近 180° 的一对
  let pi = 0, pj = 1, best = -1;
  for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
    const c = Math.abs(arms[i].dir.x * arms[j].dir.x + arms[i].dir.y * arms[j].dir.y);
    if (c > best) { best = c; pi = i; pj = j; }
  }
  /**
   * **stroke ↔ 臂** 的对应：按"port 的接触端 + 原场景里该 stroke 的航向"去匹配，
   * 不依赖 east/west/south 命名（四臂场景没有 side-south）。
   */
  const CP = new Map<string, string>();
  for (const p of doc.junctions[0].ports) CP.set(String(p.roadId), String(p.contactPoint));
  /**
   * **stroke ↔ 臂：唯一分配（贪心）**。
   *
   * 原来是「每条 stroke 各自取最近臂」——两条臂接近平行时（斜交 T、钝角），
   * 会把**两条 stroke 指到同一条臂**上，另一条臂没有 stroke → 编译时少连接（7/9）。
   * 现在按"角度差升序"逐个占位，一条臂只能被一条 stroke 占用。
   */
  const angDiff = (a: number, b: number): number => {
    const d = Math.abs(a - b) % (Math.PI * 2);
    return d > Math.PI ? Math.PI * 2 - d : d;
  };
  const pairs: { d: number; rid: string; idx: number }[] = [];
  for (const st of doc.strokes) {
    const rid = String(st.id);
    const cp = CP.get(rid) ?? 'start';
    const h0 = st?.geometry?.[0]?.heading ?? 0;
    const want = cp === 'start' ? h0 : h0 + Math.PI;
    arms.forEach((a, i) => pairs.push({ d: angDiff(Math.atan2(a.dir.y, a.dir.x), want), rid, idx: i }));
  }
  pairs.sort((x, y) => x.d - y.d);
  const strokeArm = new Map<string, number>();
  const usedArm = new Set<number>();
  const usedStroke = new Set<string>();
  for (const pr of pairs) {
    if (usedStroke.has(pr.rid) || usedArm.has(pr.idx)) continue;
    usedStroke.add(pr.rid);
    usedArm.add(pr.idx);
    strokeArm.set(pr.rid, pr.idx);
  }
  const dropped = doc.strokes.filter((st: any) => !strokeArm.has(String(st.id))).map((st: any) => String(st.id));
  const unmatchedArms = arms.map((_, i) => i).filter((i) => !usedArm.has(i));
  const armOf = (rid: string) => arms[strokeArm.get(rid) ?? 0];
  const mw = arms[pi], me = arms[pj], ms = arms[pi];

  const CX = node.at.x * 7, CY = node.at.y * 7;
  /**
   * **每条臂伸到邻近路口的口线**，而不是固定 60 m。
   *
   * 固定长度会让相邻两个路口的新几何在中间留一段空白 → 那段只能用旧路面填，
   * 于是出现"新-旧-新"交替。伸到对面口线后，两个路口的新几何首尾相接，
   * 整片区域就能完全替换（旧路面可以整段删掉，不留洞）。
   */
  const setbackOfNode = (nid: string): number => {
    const nd = g.nodes.get(nid);
    if (!nd) return 15;
    let widest = 0;
    const seen2 = new Set<string>();
    for (const x of nd.edges) {
      const ee = g.edges.get(x);
      if (!ee || seen2.has(x)) continue;
      seen2.add(x);
      const sc = secs[String(ee.cls) as keyof typeof secs];
      if (sc) widest = Math.max(widest, sc.carriage / 2 + sc.curb + sc.walk);
    }
    return Math.ceil(widest || 6) + 10;
  };
  const armLenOf = (arm: { eid: string; dir: Pt }): number => {
    const e = g.edges.get(arm.eid);
    if (!e) return 40;
    const chord = Math.hypot(e.pts[e.pts.length - 1].x - e.pts[0].x, e.pts[e.pts.length - 1].y - e.pts[0].y) * 7;
    const far = e.a === node.id ? e.b : e.a;
    const farSet = setbackOfNode(far);
    return Math.max(20, chord - farSet);
  };
  const armLenMap = new Map<string, number>();
  for (const st of doc.strokes) {
    const nm = String(st.id), arm = armOf(nm), cp = CP.get(nm) ?? 'start';
    const L = armLenOf(arm);
    armLenMap.set(nm, L);
    const px = CX + arm.dir.x * setbackM, py = CY + arm.dir.y * setbackM;
    st.geometry = [cp === 'end'
      ? { kind: 'line', s: 0, x: px + arm.dir.x * L, y: py + arm.dir.y * L, heading: Math.atan2(-arm.dir.y, -arm.dir.x), length: L }
      : { kind: 'line', s: 0, x: px, y: py, heading: Math.atan2(arm.dir.y, arm.dir.x), length: L }];
    st.templateSpans = [{ templateId: tplId, s: 0 }];
  }
  const comp: any = compileRoadNetwork(doc);
  if (!comp.ok) throw new Error(`编译失败：${(comp.diagnostics ?? []).map((d: any) => d.message).join('；')}`);

  const asm = inferJunctionAssemblySurfaces(comp.network, { step: 0.5 }) as any[];
  /**
   * **不能直接用 `components`**：它是 driving ∪ sidewalk 的并集外轮廓，
   * 而 `laneTypeSurfaces.sidewalk` 是带洞的外环，两者一并不出内凹的"蝴蝶形"，
   * 肉眼就是路口四角被啃掉（A3.15 已实测 driving∩sidewalk = 130.65 m²）。
   *
   * 按分层取：
   *   车行面 = components ∩ driving           ← 干净的 T
   *   人行道 = (sidewalk − driving) − curb     ← 外环带
   */
  const all = asm.flatMap((s) => toPS(s.components));
  const drvRaw = asm.flatMap((s) => (s.laneTypeSurfaces ?? []).filter((lt: any) => lt.laneType === 'driving').flatMap((lt: any) => toPS(lt.components)));
  const swRaw = asm.flatMap((s) => (s.laneTypeSurfaces ?? []).filter((lt: any) => lt.laneType === 'sidewalk').flatMap((lt: any) => toPS(lt.components)));
  const drvIn = surfaceIntersect(drvRaw, all);                        // 车行面（Assembly 内）
  const swBase = surfaceSubtract(surfaceIntersect(swRaw, all), drvIn); // 人行道（扣掉车行）
  const junction = drvIn;
  /**
   * **道路带必须按车道类型取，不能取全断面**。
   *
   * `inferRoadSurfacePatches` 给的是「车行 + 人行」整条断面；拿它当沥青铺，
   * 新臂就会比旧路宽出一圈人行道（实测视觉上宽 ~1/4）。
   * 这里用 `inferLaneSurfacePatches` 按 laneType 分开：
   *   车行 → 沥青   ·   人行 → 铺装
   */
  const laneP = (inferLaneSurfacePatches(comp.network, { step: 0.5 }) as any[]).filter(
    (p) => !String(p.roadId).includes('__')          // 排除 connector / continuation
  );
  const laneDrv = toPS(laneP.filter((p) => p.laneType === 'driving'));
  const laneWalk = toPS(laneP.filter((p) => p.laneType === 'sidewalk'));
  const road = laneDrv;                                  // 只保留车行道
  const swCorridor = surfaceSubtract(surfaceUnionPS(laneWalk), surfaceUnionPS(laneDrv));
  const armEnds = arms.map((a) => {
    const L = armLenOf(a);
    return { p: new Pt(node.at.x + a.dir.x * (U(setbackM) + U(L)), node.at.y + a.dir.y * (U(setbackM) + U(L))), dir: a.dir };
  });
  return { junction, sidewalk: [...swBase, ...swCorridor], road, setbackM, ms: M(setbackM), centerAt: node.at, armEnds };
}

/**
 * 把 three-roads 几何替换进已生成的城市（不修改 base，返回新对象）。
 * 失败时抛错，由调用方回退。
 */
export function applyThreeRoads(base: CityResult, opts: { maxRadiusM?: number; allJunctions?: boolean } = {}): CityResult {
  /**
   * **逐路口独立编译 + 局部回退**（A6.1-RECOVERY）。
   *
   * 多路口单网络要求全部成功才有产物，一个 4 m 残段就能拖垮整座城。
   * 改成：目标路口 + 周边 N 个路口各自编译，**成功的合并展示，失败的留在旧版**，
   * 并在控制台列出 BLOCKED 清单。这不是"五路口整体 PASS"，是局部替换。
   */
  const seedId = resolveTarget(base).id;
  // `?f3roads=three&f3all=1` → 全城逐路口（A6.4 批量统计用）
  const allCity = !!opts.allJunctions || (() => {
    if (typeof location === 'undefined') return false;
    return new URLSearchParams(location.search).get('f3all') === '1';
  })();
  const cand = allCity
    ? [seedId, ...base.debug.graph.junctions.filter((id) => id !== seedId)]
    : pickNearbyJunctions(base, seedId, 4);
  const built: ReturnType<typeof buildThreeRoads>[] = [];
  const blocked: { id: string; why: string }[] = [];
  for (const id of cand) {
    try {
      built.push(buildThreeRoads(base, id));
    } catch (e: any) {
      blocked.push({ id, why: String(e?.message ?? e).slice(0, 120) });
    }
  }
  if (!built.length) throw new Error(`候选路口全部编译失败：${blocked.map((b) => b.id).join(',')}`);
  /**
   * **按材质先去重再合并**。
   *
   * 相邻两个路口各自会生成一段 40 m 的臂，同一段路被生成两次 → 重叠、z-fighting、
   * 视觉上的 X 形和缺口。这里先 `union` 成一份干净的面，再交给后续裁剪与输出。
   */
  const uniq = (l: PlanSurface[]): PlanSurface[] => {
    if (l.length <= 1) return l;
    try {
      return surfaceUnion(l).filter((q) => q.outer.length >= 3);
    } catch {
      return l;
    }
  };
  const junction = uniq(built.flatMap((b) => b.junction));
  const swJ = uniq(built.flatMap((b) => b.sidewalk));
  const road = uniq(built.flatMap((b) => b.road));
  const armEnds = built.flatMap((b) => b.armEnds);
  const setbackM = built[0].setbackM;
  const center = built[0].centerAt;
  const okIds = built.length;

  console.info(
    `[f3roads] 单网络未启用，改用**逐路口**替换：成功 ${okIds}/${cand.length}` +
      (blocked.length ? ` · BLOCKED: ${blocked.map((b) => `${b.id}(${b.why})`).join(' | ')}` : '')
  );
  // 只替换路口周边（避免把整条路带的差集做到全城）
  const R = U(opts.maxRadiusM ?? Math.max(30, setbackM + 25));
  const disc: PlanSurface[] = [{
    outer: Array.from({ length: 72 }, (_, i) => {
      const a = (i / 72) * Math.PI * 2;
      return new Pt(center.x + Math.cos(a) * R, center.y + Math.sin(a) * R);
    }),
    holes: [],
  }];

  /**
   * **人行道过渡带**（方案 A）：three-roads 只给车行面 + 人行道连续带，
   * 不含我们那圈转角铺装；直接换会露出 2.95 m 宽的一圈地面。
   * 这里沿装配面外扩 curb+walk 生成一圈铺装，明确标成 `road/sidewalk`，
   * 让视觉上读作"新路口的人行道"，而不是"露底"。
   *
   * 注意：它参与下面的旧面裁剪（`newAll`），所以不会与旧铺装重复占地。
   */
  /**
   * **人行道用"缺口回填"，不用新建带**。
   *
   * 之前同时存在两套人行道：旧的原样保留 + 新的 paver 叠上去 —— 两套边界不同，
   * 于是出现双线、台阶和凹口（用户截圈的就是这些）。
   *
   * 现在只补缺口：`旧路口面 − 新沥青` 这一块，用铺装色填回去。
   * 它的外边界天然就是旧人行道内沿，所以与旧人行道严丝合缝；
   * 内边界是新沥青边界，也与新路面严丝合缝。零新建、零错位。
   */
  const oldJ = (base.debug.road.junction ?? []).filter((q) => {
    const b = { minX: 1e9, minY: 1e9, maxX: -1e9, maxY: -1e9 };
    let bb = b;
    for (const v of q.outer) {
      bb = { minX: Math.min(bb.minX, v.x), minY: Math.min(bb.minY, v.y), maxX: Math.max(bb.maxX, v.x), maxY: Math.max(bb.maxY, v.y) };
    }
    return bb.maxX > center.x - U(45) && bb.minX < center.x + U(45) && bb.maxY > center.y - U(45) && bb.minY < center.y + U(45);
  });
  const oldJUnion = surfaceUnionPS(oldJ.map((q) => ({ outer: q.outer, holes: q.holes ?? [] })));
  const newDriveAll = [...junction, ...road];
  const gapFill = surfaceSubtract(oldJUnion, newDriveAll).filter((q) => q.outer.length >= 3);
  const walkBand = gapFill;
  void swJ;

  /**
   * **路缘石：按新路面形状偏移生成，0.35 m**。
   *
   * three-roads 不提供 curb 层（`laneTypeSurfaces` 只有 driving / sidewalk），
   * 所以旧路缘被裁掉后不能"什么都不画"，也不能留旧形状的月牙 —— 必须由我们自己
   * 沿**新**车行道边界偏移一条带出来：
   *
   *   curb = offset(新车行面, 0.35) − 新车行面
   *
   * 这样它的内外边界天然贴合新路面与新路面外侧，形状随路口变。
   */
  const merged0 = surfaceUnionPS(newDriveAll);
  let solidRoad = merged0;
  try {
    // 闭运算填掉片间窄缝（≤0.7 m），否则偏移会把内部缝也描成一圈路缘
    const closed = closeSurfaceSet(merged0, U(0.7));
    if (closed.length) solidRoad = closed;
  } catch {
    /* 失败就用原并集 */
  }
  /**
   * 路缘与人行道用**同一族 offset** 生成：
   *   curb = off(0.35) − off(0)
   *   walk = off(2.95) − off(0.35)
   * 两者共享 0.35 那条边界 → 没有缝隙；外弧与内弧同源 → 弧度一致（都随新路面）。
   */
  const off035 = (() => { try { return offsetSurfaceSet(solidRoad, U(0.35)); } catch { return [] as PlanSurface[]; } })();
  const offK = (() => { try { return offsetSurfaceSet(solidRoad, U(2.95)); } catch { return [] as PlanSurface[]; } })();
  const curbBand = surfaceSubtract(off035, solidRoad).filter((q) => q.outer.length >= 3);
  const walkNew = surfaceSubtract(offK, off035).filter((q) => q.outer.length >= 3);

  /**
   * **切掉"分段处的横断路缘"**：车道面是按 stroke 长度截断的，
   * 偏移到端点会绕出横跨路面的一小段路缘（截图里那三条白杠）。
   * 在每条臂的端点处放一条薄带，从路缘里减掉。
   */
  /**
   * **内部接缝不切**：只有"伸向未替换区域"的臂端才需要切掉端帽。
   *
   * 相邻两个被替换的路口，臂端正好抵住对方的口线 —— 那里切一刀就会留下
   * 一个 V 形缺口（截图里那三个）。判据：臂端附近（同向 60 m 内）还有另一个
   * 已成功编译的路口 → 视为内部接缝，跳过。
   */
  const centers = built.map((b) => b.centerAt);
  const isInternalSeam = (p: Pt, dir: Pt): boolean =>
    centers.some((c) => {
      const dx = c.x - p.x, dy = c.y - p.y;
      const along = (dx * dir.x + dy * dir.y) * 7;
      const across = Math.abs(dx * dir.y - dy * dir.x) * 7;
      return along > 0 && along < 70 && across < 12;
    });

  const endStrips: PlanSurface[] = armEnds.filter(({ p, dir }) => !isInternalSeam(p, dir)).map(({ p, dir }) => {
    const n = new Pt(-dir.y, dir.x);
    const T = U(3.2), W = U(16);
    return {
      outer: [
        new Pt(p.x + n.x * W - dir.x * T, p.y + n.y * W - dir.y * T),
        new Pt(p.x + n.x * W + dir.x * T, p.y + n.y * W + dir.y * T),
        new Pt(p.x - n.x * W + dir.x * T, p.y - n.y * W + dir.y * T),
        new Pt(p.x - n.x * W - dir.x * T, p.y - n.y * W - dir.y * T),
      ], holes: [],
    };
  });
  const curbClean = uniq(surfaceSubtract(curbBand, endStrips).filter((q) => q.outer.length >= 3 && M2(Math.abs(surfaceArea(q))) > 0.2));
  const walkClean = uniq(surfaceSubtract(walkNew, endStrips).filter((q) => q.outer.length >= 3 && M2(Math.abs(surfaceArea(q))) > 0.2));

  /**
   * **旧人行道按"新路面 + 路缘"的外沿裁一刀**。
   *
   * 旧人行道的圆角半径来自旧路口（比新的宽），新路面转角收紧后，
   * 那圈旧圆角就摊成一片米色扇形（截图里框的弧形）。
   * 用 `offset(新路面, 0.4)` 当刀，把它裁到新形状的内沿 —— 弧线自然跟随新转角。
   */
  const walkCut = offK;   // 与新人行道带外沿同一条线，接缝为零

  const newAll = [...junction, ...road, ...walkBand];
  // 1) 旧道路面减去新几何（真正的所有权裁剪）
  // 先用新几何的包围盒筛掉肯定不相交的旧面（否则要对每条路做一次大布尔，3 秒级）
  let nb = { minX: 1e9, minY: 1e9, maxX: -1e9, maxY: -1e9 };
  for (const q of newAll) for (const v of q.outer) {
    nb = { minX: Math.min(nb.minX, v.x), minY: Math.min(nb.minY, v.y), maxX: Math.max(nb.maxX, v.x), maxY: Math.max(nb.maxY, v.y) };
  }
  const PAD = U(2);
  nb = { minX: nb.minX - PAD, minY: nb.minY - PAD, maxX: nb.maxX + PAD, maxY: nb.maxY + PAD };

  const kept: SurfaceFeature[] = [];
  let clipped = 0;
  for (const s of base.scene.surfaces) {
    // role 只有 ground/overlay/road 三种；路口面靠 group（road/junction）区分
    /**
     * **只裁车行面与路口面，不动人行道**。
     *
     * 旧人行道的边界是旧圆角算出来的，新的人行道带是按新路口外扩 2.95 m 算的 ——
     * 两条偏移线对不上，裁开就会在交界处出现"台阶"。
     * 人行道同材质同色，留着不动、让新带压在上面，视觉上更连续；
     * 新带 y 取 0.0225（略低于旧人行道 0.023），避免共面闪烁。
     */
    /**
     * **按材质裁，不按 group**。
     *
     * 路缘条（mat `curb`）挂在 `road/sidewalk` 组里 —— 上一步排除整个 group，
     * 把它一起放过了：旧路缘留在原地、新车行面已退开，就成了悬空的白色月牙。
     * 现在只留铺装/草（paver / grass），沥青与路缘一律参与裁剪。
     */
    /**
     * 人行道（paver）不整片保留：被"新路面 + 路缘"外沿裁一刀，
     * 这样它的内沿跟着新转角走，不会留一圈旧半径的扇形。
     */
    if (s.mat === 'paver' && walkCut.length) {
      const pieces = surfaceSubtract([{ outer: s.ring, holes: s.holes ?? [] }], walkCut);
      if (pieces.length) {
        for (const q of pieces) if (q.outer.length >= 3) kept.push({ ...s, name: `${s.name}_cw${kept.length}`, ring: q.outer, holes: q.holes });
        continue;
      }
    }
    const keepMat = s.mat === 'paver' || s.mat === 'grass' || s.mat === 'grassLight';
    const isRoad = s.role === 'road' && !keepMat;
    if (!isRoad) {
      kept.push(s);
      continue;
    }
    let sb = { minX: 1e9, minY: 1e9, maxX: -1e9, maxY: -1e9 };
    for (const v of s.ring) {
      sb = { minX: Math.min(sb.minX, v.x), minY: Math.min(sb.minY, v.y), maxX: Math.max(sb.maxX, v.x), maxY: Math.max(sb.maxY, v.y) };
    }
    const far = sb.maxX < nb.minX || sb.minX > nb.maxX || sb.maxY < nb.minY || sb.minY > nb.maxY;
    if (far) {
      kept.push(s);
      continue;
    }
    const ring = { outer: s.ring, holes: s.holes ?? [] };
    const pieces = surfaceSubtract([ring], newAll);
    if (pieces.length === 1 && pieces[0].outer.length === s.ring.length) {
      kept.push(s); // 没被裁到
      continue;
    }
    clipped++;
    for (const q of pieces) {
      if (q.outer.length < 3) continue;
      kept.push({ ...s, name: `${s.name}_cut${kept.length}`, ring: q.outer, holes: q.holes });
    }
  }
  // 2) 追加新面（与旧面同高，靠裁剪保证不重叠，不靠抬高）
  const added: SurfaceFeature[] = [
    ...junction.map((q, i) => ({
      name: `three_junction_${i}`,
      group: 'road/junction',
      ring: q.outer,
      holes: q.holes,
      mat: 'asphalt' as const,
      y: 0.021,
      role: 'road' as const,
    })),
    ...road.map((q, i) => ({
      name: `three_road_${i}`,
      group: 'road/surface',
      ring: q.outer,
      holes: q.holes,
      mat: 'asphalt' as const,
      y: 0.02,
      role: 'road' as const,
    })),
    // 路缘石：独立图层 `road/curb`，可与人行道分别开关
    ...curbClean.map((q, i) => ({
      name: `three_curb_${i}`,
      group: 'road/curb',
      ring: q.outer,
      holes: q.holes,
      mat: 'curb' as const,
      y: 0.0235,
      role: 'road' as const,
    })),
    // 新人行道带（与路缘同源 offset，弧度一致）
    ...walkClean.map((q, i) => ({
      name: `three_walk_${i}`,
      group: 'road/sidewalk',
      ring: q.outer,
      holes: q.holes,
      mat: 'paver' as const,
      y: 0.0225,
      role: 'road' as const,
    })),
    // 缺口回填（通常很小）
    ...walkBand.map((q, i) => ({
      name: `three_walk_${i}`,
      group: 'road/sidewalk',
      ring: q.outer,
      holes: q.holes,
      mat: 'paver' as const,
      y: 0.0225,
      role: 'road' as const,
    })),
  ];
  void disc;

  // 控制台直接给出"怎么找到它"：世界坐标 + 两种单位的特写链接（focusxy 的单位约定历史上不统一）
  const wx = center.x, wy = center.y;
  console.info(
    `[f3roads] 已替换路口 ${TARGET_JUNCTION} @ 世界 (${(wx * 7).toFixed(0)}, ${(wy * 7).toFixed(0)}) m` +
      `\n  特写（米制）？f3roads=three&focusxy=${(wx * 7).toFixed(1)},${(wy * 7).toFixed(1)}&span=140&view=top` +
      `\n  特写（世界单位）？f3roads=three&focusxy=${wx.toFixed(2)},${wy.toFixed(2)}&span=20&view=top` +
      `\n  分层：路口面 group=road/junction · 道路面 group=road/surface（左侧图层栏可单独开关核对）`
  );

  // 浏览器里挂一个"定位"按钮（Node 下 document 不存在，自动跳过）
  try {
    mountLocateButton(center);
  } catch {
    /* 只是便利功能，失败不影响几何 */
  }

  const out: CityResult = {
    ...base,
    scene: { ...base.scene, surfaces: [...kept, ...added] },
    notes: [...(base.notes ?? []), `three-roads 预览：${okIds}/${cand.length} 个路口 · setback ${setbackM} m · 裁剪旧面 ${clipped} 片 · 新增 ${added.length} 片`],
  } as CityResult;
  (out as any).__f3Stats = { total: cand.length, ok: okIds, blocked };
  return out;
}

/**
 * 一键定位按钮（仅 `?f3roads=three` 时出现）。
 *
 * 放在左下角固定定位，不改 HUD 布局；点击后把镜头推到被替换的路口。
 * 位置来自真实 RoadGraph 的该节点，不写死坐标。
 */
export function mountLocateButton(center: { x: number; y: number }): void {
  if (typeof document === 'undefined' || mode !== 'three') return;
  if (document.getElementById('f3roads-locate')) return;
  const btn = document.createElement('button');
  btn.id = 'f3roads-locate';
  btn.textContent = '定位 three-roads 路口';
  btn.style.cssText = [
    'position:fixed', 'left:14px', 'bottom:14px', 'z-index:9999',
    'padding:8px 12px', 'border-radius:8px', 'cursor:pointer',
    'background:#1f6feb', 'color:#fff', 'border:0',
    'font:13px/1.2 system-ui,sans-serif', 'box-shadow:0 2px 8px rgba(0,0,0,.35)',
  ].join(';');
  btn.onclick = () => {
    const f = (window as any).__f3FocusAt;
    if (typeof f === 'function') f(center.x, center.y, 24);
    else console.warn('[f3roads] 视图还没就绪，稍后再点；或用 ?focusxy= 直接进');
  };
  document.body.appendChild(btn);
}
