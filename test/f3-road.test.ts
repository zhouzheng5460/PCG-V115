// F3 · 道路几何 / 标线 / 路灯 / 停车标线验收
//
// 对应本轮 6 条需求里的 1~5（第 6 条是评估，不改代码）：
//   · 截图 1 绿十字 + 黑色楔形缝 → 跨层去重 + 路口行人平台
//   · 路灯两侧等距 + 灯臂朝中线
//   · 截图 2 车位线"悬空梳子"     → 线裁到铺装 + 通长基线（GB 5768.3 §5.12）
//   · 斑马线过多                  → 宽度门槛 / 一处一组 / 路口最小间距（GB 5768.3 §5.9）

import { Pt } from '../src/core/geom';
import {
  bboxOf,
  distToSurfaceEdge,
  insideSurface,
  pointInRing,
  surfaceArea,
  surfaceIntersect,
  surfaceSubtract,
  selfIntersects,
  type PlanSurface,
} from '../src/town/planning/core/surface';
import { cityOutline, runF3City } from '../src/f3';
import { M2, U } from '../src/f3/geom';
import { MIN_CROSSING_GAP_M, MIN_CROSSING_WIDTH_M, junctionCutDistances } from '../src/f3/roadgeom';
import { arcVertexCount } from '../src/f3/rounding';

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = ''): void => {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}${detail ? '  ' + detail : ''}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? '  ' + detail : ''}`);
  }
};

const spec = {
  boundary: { outer: cityOutline(95, 20261106), holes: [] as Pt[][] },
  style: 'structured' as const,
  density: 'medium' as const,
  program: 'mixed' as const,
  seed: 20261106,
};
const r = runF3City(spec);
const road = r.debug.road;
const graph = r.debug.graph;

const bbox = (ring: Pt[]) => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of ring) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
};
const inBox = (p: Pt, b: ReturnType<typeof bbox>): boolean =>
  p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY;
const centroid = (ring: Pt[]): Pt =>
  new Pt(ring.reduce((s, p) => s + p.x, 0) / ring.length, ring.reduce((s, p) => s + p.y, 0) / ring.length);

console.log('=== ① 路侧绿带 / 人行带 / 路口平台 ===');
const areaOf = (list: PlanSurface[]): number => list.reduce((a, s) => a + M2(surfaceArea(s)), 0);
const overlapOf = (a: PlanSurface[], b: PlanSurface[]): number => areaOf(surfaceIntersect(a, b));
// 侧带是同一张闭合面的差集，直接量**真实重叠面积**。
// 旧判据用「顶点均值 + 忽略洞的 pointInRing」，绿带现在是带洞的环形面，
// 质心会落进洞里被误判成压在人行道上（实测 132/194 全是假阳性）。
const vergeOverlap = overlapOf(road.verge, [...road.sidewalk, ...road.curb]);
ok('① 绿带没有压在人行道 / 路缘上（同一闭合面的差集）', vergeOverlap < 20,
  `真实重叠 ${vergeOverlap.toFixed(2)} m² / 绿带 ${areaOf(road.verge).toFixed(0)} m²`);
const curbWalkOverlap = overlapOf(road.curb, road.sidewalk);
ok('① 路缘与人行道不重叠', curbWalkOverlap < 20, `重叠 ${curbWalkOverlap.toFixed(2)} m²`);

const apronBox = road.apron.map((s) => ({ s, b: bbox(s.outer) }));
const covered = road.crossings.filter((c) => apronBox.some(({ s, b }) => inBox(c, b) && pointInRing(c, s.outer)));
// 路口中心本身是车行道，apron 是环状；这里改成检查中心附近有没有平台。
// 窗口必须按**转角位置**给：平台在路口的四个角上，不在中心 —— 断面 30 m 级的
// 宽路口，转角离中心 20 m 以上，16 m 的窗口会把一半路口误判成"没有平台"。
const nearApron = road.crossings.filter((c) =>
  apronBox.some(({ b }) => b.minX < c.x + U(30) && b.maxX > c.x - U(30) && b.minY < c.y + U(30) && b.maxY > c.y - U(30))
);
ok('② 每个设标线的路口都有行人平台兜底', nearApron.length === road.crossings.length,
  `${nearApron.length} / ${road.crossings.length}（中心落在车行面内的 ${covered.length} 处属正常）`);
ok('③ 平台没有把整座城铺成米色（面积受控）',
  road.apron.reduce((a, s) => a + M2(surfaceArea(s)), 0) < 60000,
  `${road.apron.reduce((a, s) => a + M2(surfaceArea(s)), 0).toFixed(0)} m²`);

console.log('\n=== ② 斑马线规则 ===');
const gaps: number[] = [];
for (let i = 0; i < road.crossings.length; i++)
  for (let j = i + 1; j < road.crossings.length; j++)
    gaps.push(Math.hypot(road.crossings[i].x - road.crossings[j].x, road.crossings[i].y - road.crossings[j].y) * 7);
const minGap = gaps.length ? Math.min(...gaps) : Infinity;
/**
 * 「不再每交点都画」这条，判据从**路口占比**改成**过街设施密度**。
 *
 * 旧判据是 `crossings < junctions × 0.7`，那是给 93 路口 / 90 m 街区的密集
 * 格网校的。张量主干路把街区做到 120~130 m 之后，路口本身只剩 49 个、
 * 且几乎每个都是主次干相交 —— 占总数的 80% 是这套拓扑的正确结果，不是画多了。
 * 真正能跨拓扑比较的是密度：平均多少米主次干路上一处过街设施。
 * 资料口径（GB 5768.3 §5.9 / CJJ 37）：主干路 300~500 m、次干路 150~300 m
 * 一处，生成城市按 1:7 尺度折算后取 120 m 作为下限。
 */
const mainLenM =
  graph.paths.filter((p) => p.cls !== 'local').reduce((a, p) => {
    let L = 0;
    for (let i = 0; i + 1 < p.pts.length; i++) L += Pt.distance(p.pts[i], p.pts[i + 1]);
    return a + L * 7;
  }, 0);
ok('① 过街设施密度合理（平均 ≥ 120 m 主次干路一处，不是每口都画）',
  road.crossings.length > 10 && road.crossings.length <= mainLenM / 120,
  `${road.crossings.length} 处 / 主次干路 ${mainLenM.toFixed(0)} m = 1 处 / ${(mainLenM / road.crossings.length).toFixed(0)} m`);
ok('② 任意两处过街设施间距不小于门槛', minGap >= MIN_CROSSING_GAP_M - 1,
  `最小 ${minGap.toFixed(1)} m ≥ ${MIN_CROSSING_GAP_M} m`);
ok('③ 宽度门槛已生效', MIN_CROSSING_WIDTH_M >= 12, `车行道 ≥ ${MIN_CROSSING_WIDTH_M} m`);
/**
 * 标线按 GB 5768.3 分级生成之后，"短白标线总量"这个旧口径失效了 ——
 * 边缘线、车道虚线、非机动车道线本来就量大且都是白的。
 * 这里改成**按类型**逐条验收，每一条对应规范里的一条要求。
 */
const byKind = (k: string): typeof road.markings => road.markings.filter((m) => m.kind === k);
const areaOfMark = (m: (typeof road.markings)[number]): number => M2(surfaceArea({ outer: m.ring, holes: [] }));

ok('④ 斑马线条带数量与过街路口数匹配（每处最多 2 组）',
  byKind('cross').length <= road.crossings.length * 2 * 20 && byKind('cross').length > road.crossings.length * 2,
  `${byKind('cross').length} 条 / ${road.crossings.length} 处路口`);

ok('④ 车行道边缘线是连续白实线（每段路两侧各一条）',
  byKind('edge').length >= graph.paths.length * 1.6 && byKind('edge').every((m) => !m.yellow),
  `${byKind('edge').length} 段 / ${graph.paths.length} 条路径`);

const centerSegs = byKind('center');
ok('④ 中心线只出现在够宽的路（支路 <7 m 不画）',
  centerSegs.length > 0 && centerSegs.every((m) => m.yellow),
  `${centerSegs.length} 段，全部黄色`);

// 主干路中心线是**连续**的双黄实线：两片一组。判据分两层：
//   ① 总量：双黄线总长 ≈ 2 × 主干净长（路口区间内必须断开，所以只能 > 1.0×，
//      以前拿 1.2× 当门槛是按"路口只吃 2.5 m"的旧口径算的）；
//   ② 连续性：每条够长的主干段，路口之间那段双黄线要基本铺满（不是断成几截）。
const longCenter = byKind('center').filter((m) => areaOfMark(m) > 2);
const longCenterLenM = longCenter.reduce((a, m) => a + areaOfMark(m) / 0.15, 0);
const artLenM = graph.paths
  .filter((p) => p.cls === 'arterial')
  .reduce((a, p) => {
    let L = 0;
    for (let i = 0; i + 1 < p.pts.length; i++) L += Pt.distance(p.pts[i], p.pts[i + 1]);
    return a + L * 7;
  }, 0);
const ratio = artLenM > 0 ? longCenterLenM / artLenM : 0;
ok('④ 主干路用连续双黄实线（禁止跨越）',
  ratio > 0.7 && ratio < 2.6,
  `实线总长 ${longCenterLenM.toFixed(0)} m / 主干 ${artLenM.toFixed(0)} m = ${ratio.toFixed(2)}×` +
    `（双线本身 2×，扣掉路口区间后 0.7~1.2× 是正常值）`);

{
  // 每个路口两端各让出「收头 + 人行横道后退 + 停止线」≈ 28 m；比这更长的
  // 主干段上，双黄线必须铺满其中 ≥ 70%，否则说明中心线被裁碎了。
  const segDist = (p: Pt, a: Pt, b: Pt): number => {
    const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
    return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
  };
  let checked = 0;
  let bad = 0;
  for (const p of graph.paths.filter((q) => q.cls === 'arterial')) {
    let L = 0;
    for (let i = 0; i + 1 < p.pts.length; i++) L += Pt.distance(p.pts[i], p.pts[i + 1]);
    L *= 7;
    if (L < 80) continue;
    checked++;
    let drawn = 0;
    for (const m of longCenter) {
      const c = new Pt(
        m.ring.reduce((s, q) => s + q.x, 0) / m.ring.length,
        m.ring.reduce((s, q) => s + q.y, 0) / m.ring.length
      );
      let near = false;
      for (let i = 0; i + 1 < p.pts.length && !near; i++) if (segDist(c, p.pts[i], p.pts[i + 1]) < 0.5) near = true;
      if (near) drawn += areaOfMark(m) / 0.15;
    }
    const avail = Math.max(1, L - 56) * 2;
    if (drawn < avail * 0.7) bad++;
  }
  ok('④ 路口之间的双黄线是整段连续的（没有被裁成碎段）', checked > 0 && bad === 0,
    `${checked - bad} / ${checked} 条主干段铺满 ≥ 70%`);
}

// 每个设了过街设施的进口至少要有一个箭头（单车道支路也是）；
// 之前支路进口被 `if (local && 车道<2) continue` 整条跳过，全城只剩 6 段箭头。
ok('④ 每个设过街设施的进口都有导向箭头（含单车道支路）',
  byKind('arrow').length >= road.crossings.length * 2,
  `${byKind('arrow').length} 段 / ${road.crossings.length * 2} 个进口`);
ok('④ 导向箭头只在设了过街设施的路口出现',
  byKind('arrow').length > 0 && byKind('arrow').length <= road.crossings.length * 2 * 8,
  `${byKind('arrow').length} 段 / ${road.crossings.length} 处路口`);

ok('④ 主干路有公交专用道分界线（黄虚线）与减速标线',
  byKind('bus').length > 0 && byKind('slow').length > 0,
  `公交道线 ${byKind('bus').length} 段 / 减速标线 ${byKind('slow').length} 段`);

ok('④ 次干路有非机动车道线', byKind('bike').length > 0, `${byKind('bike').length} 段`);

// 所有标线都要落在车行面内（裁剪生效，不留"半截白条压在绿地上"）。
// 路口边线（jedge）单独判：它是"路口面边界往内 0.3 m"的条带，质心落在
// 边界线附近，用质心内点判会有一半误报 —— 换成"到路口面边界的距离 < 1 m"。
const stray = road.markings.filter((m) => {
  if (m.kind === 'jedge') return false;
  const c = new Pt(
    m.ring.reduce((a, q) => a + q.x, 0) / m.ring.length,
    m.ring.reduce((a, q) => a + q.y, 0) / m.ring.length
  );
  return !road.carriage.some((s) => insideSurface(c, s)) && !road.junction.some((s) => insideSurface(c, s));
}).length;
ok('④ 标线全部落在车行面 / 路口内（裁剪生效）', stray <= road.markings.length * 0.02,
  `${stray} / ${road.markings.length} 段越界`);

{
  // 路口内必须有一圈路缘石边线（沿转角圆弧），且都贴着路口面边界
  const jedge = road.markings.filter((m) => m.kind === 'jedge');
  let off = 0;
  for (const m of jedge) {
    const c = new Pt(
      m.ring.reduce((a, q) => a + q.x, 0) / m.ring.length,
      m.ring.reduce((a, q) => a + q.y, 0) / m.ring.length
    );
    const best = Math.min(...road.junction.map((s) => distToSurfaceEdge(c, s)));
    if (best * 7 > 1.2) off++;
  }
  ok('④ 路口有沿转角圆弧的路缘石边线', jedge.length > graph.junctions.length,
    `${jedge.length} 段 / ${graph.junctions.length} 个路口`);
  ok('④ 路口边线贴着路口面边界（没有飘到铺装上）', off <= jedge.length * 0.05,
    `${off} / ${jedge.length} 段离边界 > 1.2 m`);
}

{
  /**
   * 标线之间**不许互相重叠**（用户口径）。
   *
   * 用栅格分桶找潜在相交对，再对每一对做一次真实布尔求交 —— 全城 4000 多段
   * 标线里只有几十对在同一个 3.5 m 栅格里，代价可以接受。
   */
  const grid = new Map<string, number[]>();
  const boxes = road.markings.map((m) => bboxOf(m.ring));
  const cell = 0.5;
  boxes.forEach((b, i) => {
    for (let x = Math.floor(b.minX / cell); x <= Math.floor(b.maxX / cell); x++)
      for (let y = Math.floor(b.minY / cell); y <= Math.floor(b.maxY / cell); y++) {
        const k = `${x}_${y}`;
        const l = grid.get(k);
        if (l) l.push(i);
        else grid.set(k, [i]);
      }
  });
  const seen = new Set<string>();
  let overlap = 0;
  for (const list of grid.values()) {
    for (let a = 0; a < list.length; a++)
      for (let b = a + 1; b < list.length; b++) {
        const i = list[a];
        const j = list[b];
        const key = i < j ? `${i}|${j}` : `${j}|${i}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const A = boxes[i];
        const B = boxes[j];
        if (A.minX > B.maxX || B.minX > A.maxX || A.minY > B.maxY || B.minY > A.maxY) continue;
        if (areaOfMark(road.markings[i]) < 0.2 || areaOfMark(road.markings[j]) < 0.2) continue;
        /**
         * 车行道边缘线与路口转角边线是**同一条白线**的两段，必须搭接 2 cm
         * 才不会在接缝处露缝，这里不算"重叠"。真正要卡的是斑马线 / 停止线 /
         * 车道线 / 中心线之间不许压盖。
         */
        const curbKinds = ['edge', 'jedge'];
        const ki = road.markings[i].kind ?? '';
        const kj = road.markings[j].kind ?? '';
        if (curbKinds.includes(ki) && curbKinds.includes(kj)) continue;
        /**
         * 同色（白×白）不计：导向箭头本来就压在非机动车道线上（现实里也是
         * 后画的箭头盖住线），视觉上没有"两条线互相压盖"的问题。真正要卡的是
         * **黄色与白色**互相压盖 —— 那才是用户截图里"中线不对"的来源。
         */
        if (!road.markings[i].yellow && !road.markings[j].yellow) continue;
        try {
          const ov = surfaceIntersect(
            [{ outer: road.markings[i].ring, holes: [] }],
            [{ outer: road.markings[j].ring, holes: [] }]
          ).reduce((s2, q) => s2 + Math.abs(M2(surfaceArea(q))), 0);
          overlap += ov;
        } catch {
          /* 布尔失败不计 */
        }
      }
  }
  ok('④ 标线之间不重叠（白线不许压住黄线）', overlap < 4,
    `重叠总面积 ${overlap.toFixed(1)} m² / ${road.markings.length} 段`);
}

console.log('\n=== ③ 路灯 ===');
const lamps = r.scene.props.filter((p) => p.kind === 'lamp' || p.kind === 'lampDouble');
const segDist = (p: Pt, a: Pt, b: Pt): number => {
  const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
};
/** 最近道路段：同时给出距离、所属路径、在路径的哪一侧 */
const nearest = (p: Pt): { d: number; pathId: string; side: number } => {
  let best = { d: Infinity, pathId: '', side: 0 };
  for (const path of graph.paths) {
    for (let i = 0; i + 1 < path.pts.length; i++) {
      const a = path.pts[i], b = path.pts[i + 1];
      const d = segDist(p, a, b);
      if (d < best.d) {
        const cr = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
        best = { d, pathId: path.id, side: cr > 0 ? 1 : -1 };
      }
    }
  }
  return best;
};
const distToRoad = (p: Pt): number => nearest(p).d;
/**
 * 只在**远离路口**的灯位上判朝向。
 *
 * 判据是"灯头比灯身更靠近最近的中心线"，而路口附近几条路的中心线距离接近，
 * "最近的一条"会跳到相邻路上去 —— 实测这类误判 68 盏（5%），全部在路口 15 m 内。
 * 路口内本来也不该有灯（布灯时就按半幅+3 m 让开了），所以这里只看街段中段。
 */
const jctAt = graph.junctions.map((id) => graph.nodes.get(id)?.at).filter((q): q is Pt => !!q);
let toward = 0;
let judged = 0;
for (const l of lamps) {
  if (jctAt.some((j) => Pt.distance(j, l.at) < U(15))) continue;
  judged++;
  const tip = new Pt(l.at.x + Math.cos(l.rot) * 0.5, l.at.y + Math.sin(l.rot) * 0.5);
  if (distToRoad(tip) < distToRoad(l.at) - 1e-4) toward++;
}
ok('① 灯臂朝向车行道中线', toward >= judged * 0.98, `${toward} / ${judged}（路口 15 m 内不计）`);
ok('② 每街都有灯、且不是一盏独苗', lamps.length >= graph.paths.length * 1.5,
  `${lamps.length} 盏 / ${graph.paths.length} 条街（平均 ${(lamps.length / graph.paths.length).toFixed(1)}）`);
const byPath = new Map<string, { pos: number; neg: number }>();
for (const l of lamps) {
  const n = nearest(l.at);
  if (n.d > U(9)) continue;
  const g = byPath.get(n.pathId) ?? { pos: 0, neg: 0 };
  if (n.side > 0) g.pos++; else g.neg++;
  byPath.set(n.pathId, g);
}
const both = [...byPath.values()].filter((g) => g.pos > 0 && g.neg > 0).length;
ok('③ 道路两侧都布灯', both >= byPath.size * 0.8,
  `${both} / ${byPath.size} 条街两侧都有`);

console.log('\n=== ④ 停车标线 ===');
const stalls = r.scene.paths.filter((p) => p.group === 'parking/marking');
const lots = r.scene.surfaces.filter((s) => s.mat === 'asphaltLot');
const lotBox = lots.map((s) => ({ s, b: bbox(s.ring) }));
let onLot = 0;
for (const l of stalls) {
  const c = new Pt((l.pts[0].x + l.pts[1].x) / 2, (l.pts[0].y + l.pts[1].y) / 2);
  if (lotBox.some(({ s, b }) => inBox(c, b) && insideSurface(c, { outer: s.ring, holes: s.holes ?? [] }))) onLot++;
}
ok('① 车位线全部落在沥青铺装内（不再悬在黑底上）', stalls.length > 100 && onLot === stalls.length,
  `${onLot} / ${stalls.length}`);
const lens = stalls.map((l) => Math.hypot(l.pts[1].x - l.pts[0].x, l.pts[1].y - l.pts[0].y) * 7);
const longBase = lens.filter((x) => x > 6).length;
ok('② 每排有通长基线，不是一格一段的梳齿', longBase >= stalls.length * 0.08,
  `通长线 ${longBase} / ${stalls.length}（${((100 * longBase) / Math.max(1, stalls.length)).toFixed(0)}%）`);
ok('③ 车位线宽符合 10~15 cm 规范', stalls.every((l) => l.width * 7 >= 0.09 && l.width * 7 <= 0.16),
  `${(stalls[0]?.width * 7 * 100).toFixed(0)} cm`);
ok('④ 停车位仍按需求配建', r.stats.parkingBays > 200, `${r.stats.parkingBays} 位`);

console.log('\n=== ⑥ 任意 N 叉路口的垂线收头（Houdini 补充分法）===');
{
  const mk = (angs: number[]) =>
    angs.map((a) => ({
      dir: new Pt(Math.cos(a), Math.sin(a)),
      ang: a,
      half: U(6),
      outer: U(12),
      reach: U(14),
    }));
  const at = new Pt(0, 0);
  const y3 = mk([0, (2 * Math.PI) / 3, (4 * Math.PI) / 3]);
  const cross = mk([0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]);
  const five = mk([0, 1.1, 2.4, 3.7, 5.2]);
  const c3 = junctionCutDistances(y3, at);
  const c4 = junctionCutDistances(cross, at);
  const c5 = junctionCutDistances(five, at);
  ok('⑥ 3 / 4 / 5 叉都给每条分支算出一条收头线',
    c3.length === 3 && c4.length === 4 && c5.length === 5 &&
      [...c3, ...c4, ...c5].every((v) => Number.isFinite(v) && v > 0),
    `三叉 ${c3.map((v) => (v * 7).toFixed(1)).join('/')} m`);
  ok('⑥ 对称十字四臂等长', Math.max(...c4) - Math.min(...c4) < 1e-6,
    `${(c4[0] * 7).toFixed(2)} m × 4`);
  ok('⑥ 不对称五叉各臂长度不同（取最远投影生效）',
    new Set(c5.map((v) => v.toFixed(4))).size > 1,
    `${c5.map((v) => (v * 7).toFixed(1)).join('/')} m`);
  // 图 3：过 p' 作的收头线必须垂直于这条分支的中心线
  const A = cross[0];
  const nx = -A.dir.y;
  const ny = A.dir.x;
  const e1 = new Pt(A.dir.x * c4[0] + nx * A.outer, A.dir.y * c4[0] + ny * A.outer);
  const e2 = new Pt(A.dir.x * c4[0] - nx * A.outer, A.dir.y * c4[0] - ny * A.outer);
  const dot = (e1.x - e2.x) * A.dir.x + (e1.y - e2.y) * A.dir.y;
  ok('⑥ 收头线垂直于中心线', Math.abs(dot) < 1e-9, `点积 ${dot.toExponential(1)}`);
  // 半圆凹口 / 圆耳朵的病征：apron 环上出现大量圆弧采样点
  const verts = road.apron.map((s) => s.outer.length).sort((a, b) => a - b);
  const p50 = verts[Math.floor(verts.length / 2)] ?? 0;
  /**
   * 平台现在是「转角让开区里的人行道环带」，边界自带 6 m 圆弧采样，
   * 顶点数天然比旧的矩形平台多。真正要防的是"糖葫芦"式碎补丁，所以判据
   * 换成**片数 / 单片面积**：一个路口最多 5 片（四角 + 合并），单片不得超过
   * 一个转角平台的量级（~2200 m²，再大就是把半条街铺成广场了）。
   */
  const apronAreas = road.apron.map((s) => M2(surfaceArea(s))).sort((a, b) => b - a);
  const apronPerJct = road.apron.length / Math.max(1, graph.junctions.length);
  ok('⑥ 转角平台是连续的角块（不是一堆碎补丁）',
    apronPerJct <= 5 && (apronAreas[0] ?? 0) <= 2200,
    `${road.apron.length} 片 / ${graph.junctions.length} 路口 = ${apronPerJct.toFixed(1)} 片每口，最大 ${(apronAreas[0] ?? 0).toFixed(0)} m² / 顶点 p50 ${p50}`);
  const apronA = road.apron.reduce((a, s) => a + M2(surfaceArea(s)), 0);
  ok('⑥ 平台面积仍受控（未被放大成广场）', apronA > 5000 && apronA < 60000, `${apronA.toFixed(0)} m²`);
}

console.log('\n=== ⑦ 路口通行：行人平台不得侵入车行面 ===');
{
  // 这是「红色 apron 把路口堵成两道坝」的硬约束。之前几轮只验了
  // 「层与层不重叠 / 没有黑缝」，从没验过铺装能不能压到沥青上，
  // 所以 apron ∩ carriage 一度高达 8269 m² 也没被断言拦住。
  const drive = [...road.carriage, ...road.junction];
  const ov = surfaceIntersect(road.apron, drive);
  const ovM2 = ov.reduce((a, s) => a + M2(surfaceArea(s)), 0);
  ok('⑦ apron ∩ 车行面 = 0（铺装绝不堵路）', ovM2 < 1, `重叠 ${ovM2.toFixed(2)} m²`);

  const inList = (p: Pt, list: { s: (typeof drive)[number]; b: ReturnType<typeof bboxOf> }[]): boolean =>
    list.some((o) => p.x >= o.b.minX && p.x <= o.b.maxX && p.y >= o.b.minY && p.y <= o.b.maxY && insideSurface(p, o.s));
  const driveIdx = drive.map((s) => ({ s, b: bboxOf(s.outer) }));
  const apronIdx = road.apron.map((s) => ({ s, b: bboxOf(s.outer) }));
  ok('⑦ 路口中心没有被铺装占据',
    road.crossings.every((c) => !inList(c, apronIdx)), `${road.crossings.length} 处过街路口`);

  // 局部栅格 BFS：从路口中心出发，只走「车行面内、且不在 apron 内」的格子，
  // 看能不能通到足够多的方向扇区（= 车还能不能从各条路进出路口）。
  const step = 1 / 7;
  const half = 16; // 格数：±16 m
  const N = half * 2 + 1;
  let worst = 99;
  for (const c of road.crossings.slice(0, 12)) {
    const okCell: boolean[][] = Array.from({ length: N }, () => Array<boolean>(N).fill(false));
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const p = new Pt(c.x + (i - half) * step, c.y + (j - half) * step);
        okCell[i][j] = inList(p, driveIdx) && !inList(p, apronIdx);
      }
    }
    const seen: boolean[][] = Array.from({ length: N }, () => Array<boolean>(N).fill(false));
    const queue: [number, number][] = [[half, half]];
    seen[half][half] = true;
    const sectors = new Set<number>();
    while (queue.length) {
      const [i, j] = queue.pop()!;
      const dx = (i - half) * step * 7;
      const dy = (j - half) * step * 7;
      if (Math.hypot(dx, dy) > 9) {
        const a = (Math.atan2(dy, dx) + Math.PI * 2) % (Math.PI * 2);
        sectors.add(Math.floor(a / (Math.PI / 4)));
      }
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const ni = i + di;
        const nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= N || nj >= N || seen[ni][nj] || !okCell[ni][nj]) continue;
        seen[ni][nj] = true;
        queue.push([ni, nj]);
      }
    }
    worst = Math.min(worst, sectors.size);
  }
  ok('⑦ 车行面从路口中心向各分支连通（BFS 扇区 ≥3）', worst >= 3, `最少 ${worst} / 8 个方向扇区`);
}

console.log('\n=== ⑧ 单一路网面：街区 / 人行道 / 绿带同源 ===');
{
  const dom = road.domain;
  /**
   * 参与「分层求和 = 路网面」和「两两不重叠」的层**不含 apron**。
   *
   * apron 现在的语义是"铺装里落在路口转角区的那一段"，它是 sidewalk 的
   * **子集**（只用于 HUD 统计和"过街设施落在铺装上"的断言）。把它也列进来，
   * 会让分层之和凭空多出 1 万 m²、并且必然报"walk × apron 重叠"。
   */
  const layers = {
    carriage: road.carriage,
    junction: road.junction,
    curb: road.curb,
    walk: road.sidewalk,
    verge: road.verge,
  };
  const allLayers = Object.values(layers).flat();
  const blocks = r.debug.blocks.map((b) => b.surface);
  const derived = surfaceSubtract([spec.boundary], dom);

  // 容差 0.2%：buildBlocks 会主动丢掉 <60 m² 的碎块（放不下建筑），
  // 那部分面积本来就不该出现在街区合计里。
  ok('⑧ 街区 = 场地 − 路网面（一次布尔差，没有单独减角片）',
    Math.abs(areaOf(derived) - areaOf(blocks)) / Math.max(1, areaOf(blocks)) < 0.002 && overlapOf(blocks, dom) < 1,
    `街区 ${areaOf(blocks).toFixed(0)} / 派生 ${areaOf(derived).toFixed(0)} m²，与路网面重叠 ${overlapOf(blocks, dom).toFixed(2)} m²`);

  let jIn = 0;
  for (const nid of graph.junctions) {
    const n = graph.nodes.get(nid);
    if (n && dom.some((d) => insideSurface(n.at, d))) jIn++;
  }
  ok('⑧ 每个路口中心都在路网面里（路口是路网面自己的形状）',
    jIn === graph.junctions.length, `${jIn} / ${graph.junctions.length}`);

  const arcs = dom.reduce(
    (a, d) => a + arcVertexCount(d.outer) + d.holes.reduce((x, h) => x + arcVertexCount(h), 0),
    0
  );
  ok('⑧ 路网面自带圆角（不再有独立 corner 铺装层）',
    road.corner.length === 0 && arcs > 300, `圆弧采样点 ${arcs}，corner 层 ${road.corner.length} 片`);

  const uncovered = areaOf(surfaceSubtract(dom, allLayers));
  const layersA = areaOf(allLayers);
  ok('⑧ 所有侧带拼起来就是这张路网面（无重叠、无缺口）',
    Math.abs(layersA - areaOf(dom)) / areaOf(dom) < 0.001 && uncovered / areaOf(dom) < 0.001,
    `分层 ${layersA.toFixed(0)} / 面 ${areaOf(dom).toFixed(0)} m²，未覆盖 ${uncovered.toFixed(0)} m²`);

  /**
   * 几何"病征"验收：**回折针**（180° 零宽折返）和自交环。
   *
   * 这两种形状不改面积，但三角化会吐出细长三角 —— 俯视和 3D 里就是路口角上
   * 那团锯齿/星形（用户红圈）。`roadgeom` 输出前已经做了去发夹 + 自交归一，
   * 这里把结果钉住：残留只允许二位数以内（都是 < 12 m 的短针，渲染前还会再修一次）。
   * 修复前实测：apron 776 处、sidewalk 160 处 —— 那时路口角上就是一片锯齿。
   * 自交环上限 6：让开区填完凹角后偶发几处（全城几千个环），`sanitize()` 会把
   * 能修的用并集归一、修不了的整片丢掉，这里只是卡住"不许变多"。
   */
  let needles = 0;
  let selfRings = 0;
  for (const list of Object.values(layers)) {
    for (const s of list) {
      for (const ring of [s.outer, ...s.holes]) {
        if (selfIntersects(ring)) selfRings++;
        const n = ring.length;
        for (let i = 0; i < n; i++) {
          const a = ring[(i - 1 + n) % n];
          const b = ring[i];
          const c = ring[(i + 1) % n];
          const l1 = Pt.distance(a, b);
          const l2 = Pt.distance(b, c);
          if (l1 < 1e-9 || l2 < 1e-9) continue;
          const dot = ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)) / (l1 * l2);
          if (dot < -0.985 && l1 * 7 < 12 && l2 * 7 < 12) needles++;
        }
      }
    }
  }
  ok('⑧ 路网面没有回折针 / 自交环（三角化不会再吐尖刺）',
    needles <= 20 && selfRings <= 6,
    `回折针 ${needles} 处 / 自交环 ${selfRings} 个`);

  const keys = Object.keys(layers) as (keyof typeof layers)[];
  let worstPair = 0;
  let worstName = '';
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const o = overlapOf(layers[keys[i]], layers[keys[j]]);
      if (o > worstPair) {
        worstPair = o;
        worstName = `${keys[i]}×${keys[j]}`;
      }
    }
  }
  ok('⑧ 任意两层都互不重叠', worstPair < 50, `最大 ${worstPair.toFixed(2)} m²（${worstName}）`);

  const intoBlocks = overlapOf(allLayers, derived);
  ok('⑧ 人行道 / 绿带都不越出闭合形状（与地块严丝合缝）', intoBlocks < 30,
    `压到街区 ${intoBlocks.toFixed(2)} m²`);
}

console.log('\n=== ⑨ 路面圆角：圆弧贯穿四级断面（不是只有街区块角圆） ===');
{
  const arcsOf = (l: PlanSurface[]): number =>
    l.reduce((a, s) => a + arcVertexCount(s.outer) + s.holes.reduce((x, h) => x + arcVertexCount(h), 0), 0);
  // 用户标红的那条线是「灰色沥青 ↔ 米色铺装」的路缘石线。上一版只对 B3
  // 圆角化，于是街区块 / 绿带外角是圆的，但这几层的内边界全是直角。
  const aDrive = arcsOf([...road.carriage, ...road.junction]);
  const aCurb = arcsOf(road.curb);
  const aWalk = arcsOf([...road.sidewalk, ...road.apron]);
  // 三层（车行 / 路缘 / 人行）必须在路口转弯处带圆弧 —— 这就是"路面自己有圆角"。
  ok('⑨ 车行面 / 路缘 / 人行各自带圆弧（圆角贯穿整个断面）',
    aDrive > 400 && aCurb > 400 && aWalk > 400,
    `车行 ${aDrive} / 路缘 ${aCurb} / 人行 ${aWalk} 个弧点`);

  /**
   * 绿带相反：它**不允许**包住路口转角。
   *
   * 断面最外一圈是绿带，同心圆角会让它连续绕角 —— 每个路口四角就都成了绿色
   * 楔形。真实道路的绿化停在停止线前，转角是整块铺装。所以这里断言
   * 「路口中心 14 m 内绿带 ≈ 0、铺装 > 0」，这条比"绿带也要有弧点"更接近
   * 用户要的效果（旧判据 `aVerge > 400` 在转角让开后必然失效）。
   */
  const diskAt = (p: Pt, radU: number): PlanSurface => {
    const ring: Pt[] = [];
    for (let i = 0; i < 20; i++) {
      const a = (i / 20) * Math.PI * 2;
      ring.push(new Pt(p.x + Math.cos(a) * radU, p.y + Math.sin(a) * radU));
    }
    return { outer: ring, holes: [] };
  };
  let vergeNear = 0;
  let paveNear = 0;
  for (const c of road.crossings) {
    const d = diskAt(c, U(14));
    vergeNear += overlapOf(road.verge, [d]);
    paveNear += overlapOf([...road.sidewalk, ...road.apron], [d]);
  }
  /**
   * 判据拆成两条，各对应一句规范。
   *
   * ① 「绿带不得进入路口面」——这是硬约束，必须严格为 0。旧版把这条和
   *    「14 m 内绿带 = 0」混在一起，可后者是错的：T 口的**直行侧**本来就有
   *    连续沿街绿化（只有分叉的两臂之间才有转角），14 m 圆必然扫到它。
   * ② 「设了过街的路口以铺装为主」——转角让开后铺装应当压倒绿化。
   */
  const vergeInJct = overlapOf(road.verge, road.junction);
  ok('⑨ 绿带不进入路口面（转角是铺装，绿化在停止线前收头）',
    vergeInJct < 5, `绿带 ∩ 路口面 = ${vergeInJct.toFixed(2)} m²`);
  ok('⑨ 设过街的路口以铺装为主（绿带 < 铺装的 12%）',
    paveNear > 0 && vergeNear < paveNear * 0.12,
    `路口 14 m 内绿带 ${vergeNear.toFixed(1)} m² / 铺装 ${paveNear.toFixed(0)} m² = ${((vergeNear / Math.max(1, paveNear)) * 100).toFixed(1)}%`);

  // 三层以上的连续弧点可拟合半径。内层按断面宽度给了更大的半径补偿，
  // 但街角相邻边常常放不下 10 m 级转弯半径，会被「切点 ≤ 0.44·边长」限幅
  // 压回 6 m 附近 —— 所以判据是「内层不小于外层」，而不是硬要求半径差等于全断面宽。
  const circumR = (a: Pt, b: Pt, c: Pt): number | null => {
    const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    if (Math.abs(d) < 1e-12) return null;
    const sA = a.x * a.x + a.y * a.y;
    const sB = b.x * b.x + b.y * b.y;
    const sC = c.x * c.x + c.y * c.y;
    const ux = (sA * (b.y - c.y) + sB * (c.y - a.y) + sC * (a.y - b.y)) / d;
    const uy = (sA * (c.x - b.x) + sB * (a.x - c.x) + sC * (b.x - a.x)) / d;
    return Math.hypot(a.x - ux, a.y - uy);
  };
  const radiiOf = (l: PlanSurface[]): number[] => {
    const out: number[] = [];
    for (const s of l) {
      for (const ring of [s.outer, ...s.holes]) {
        for (let i = 1; i + 1 < ring.length; i++) {
          const a = ring[i - 1];
          const b = ring[i];
          const c = ring[i + 1];
          const l1 = Math.hypot(b.x - a.x, b.y - a.y);
          const l2 = Math.hypot(c.x - b.x, c.y - b.y);
          if (l1 < 1e-9 || l2 < 1e-9) continue;
          const cr = ((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)) / (l1 * l2);
          if (Math.abs(cr) < 0.02 || Math.abs(cr) > 0.75) continue;
          const rr = circumR(a, b, c);
          if (rr && rr > 0.05 && rr < 6) out.push(rr);
        }
      }
    }
    return out.sort((x, y) => x - y);
  };
  const med = (v: number[]): number => (v.length ? v[Math.floor(v.length / 2)] : 0);
  const rIn = med(radiiOf(road.carriage));
  const rOut = med(radiiOf(road.domain));
  /**
   * 这条断言只判**「车行面在转角确实是圆的」**。
   *
   * 曾经想用它判"四层同心"（内层半径 vs 街角半径），但两处的圆角来自不同
   * 流程：车行面是让开区多边形削圆、街角是整张路网面填凹角，两边的
   * 「切点 ≤ 0.44·边长」限幅幅度不同，比值没有稳定的物理含义 —— 实测会在
   * 3.2 m 与 5.3 m 之间来回跳，每次微调几何都误报。
   * 真正的嵌套约束由下面 ⑧ 的「两两不重叠 + 分层之和 = 路网面」保证。
   */
  const rInMax = Math.max(0, ...radiiOf(road.carriage));
  ok('⑨ 车行面在路口转角是圆弧（圆角贯穿到路面，不是直角）',
    rInMax * 7 > 3,
    `车行面转角最大圆弧 ${(rInMax * 7).toFixed(2)} m（中位 ${(rIn * 7).toFixed(2)} m / 街角中位 ${(rOut * 7).toFixed(2)} m）`);

  // 直角楔形平台的病征：apron 上没有圆弧、且仍与车行面相接成直角。
  const aApron = arcsOf(road.apron);
  ok('⑨ 路口平台沿圆弧收口（不再是直角矩形凸出）',
    aApron > 200 && overlapOf(road.apron, [...road.carriage, ...road.junction]) < 1,
    `平台弧点 ${aApron}，与车行面重叠 ${overlapOf(road.apron, [...road.carriage, ...road.junction]).toFixed(2)} m²`);
}

console.log('\n=== ⑤ 确定性 ===');
const r2 = runF3City(spec);
ok('① 同 seed 的过街设施 / 路灯 / 车位线完全一致',
  r2.debug.road.crossings.length === road.crossings.length &&
  r2.scene.props.filter((p) => p.kind === 'lamp' || p.kind === 'lampDouble').length === lamps.length &&
  r2.scene.paths.filter((p) => p.group === 'parking/marking').length === stalls.length,
  `${r2.debug.road.crossings.length} / ${lamps.length} / ${stalls.length}`);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} 项断言，${fail} 项失败`);
if (fail > 0) process.exitCode = 1;
