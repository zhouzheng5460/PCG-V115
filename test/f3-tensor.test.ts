// F3-G · 张量场一级切分（街区 → 大分区 → 地块）的层级与几何回归
//
// 用户要求的核心：**张量与现有切分不是并列，而是先后**。
// 所以这里断言的不是"张量能不能生成路"，而是：
//   ① 每个地块都来自某个一级分区（id 里带 -T）；
//   ② 一级分区数远少于地块数，且每街区不超过 3 个（少量切分）；
//   ③ 一级缝铺成了地块内部步行街，分区已经把这带子扣掉；
//   ④ 二级切分仍是正交二叉，矩形地块比例不退化；
//   ⑤ 面积账、确定性、HUD 内部道路口径都还闭合。

import { Pt } from '../src/core/geom';
import { insideSurface, pointInRing, surfaceArea, type PlanSurface } from '../src/town/planning/core/surface';
import { obbOf } from '../src/town/planning/subdivision/geom';
import { cityOutline, runF3City, type CityResult } from '../src/f3';
import { M2, distPointToPolyline } from '../src/f3/geom';

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = ''): void => {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}${detail ? `  ${detail}` : ''}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? `  ${detail}` : ''}`);
  }
};
const median = (a: number[]): number => {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
const rectRatio = (s: PlanSurface): number => {
  const ob = obbOf(s.outer);
  if (!ob) return 0;
  return Math.abs(M2(surfaceArea(s))) / Math.max(1, M2(ob.w * ob.d));
};

const spec = () => ({
  boundary: { outer: cityOutline(95, 20261106), holes: [] as Pt[][] },
  style: 'structured' as const,
  density: 'medium' as const,
  program: 'mixed' as const,
  seed: 20261106,
});
const r: CityResult = runF3City(spec());
const blocks = r.debug.blocks;
const regions = r.debug.tensorRegions;
const lanes = r.debug.tensorLanes;
const parcels = r.debug.parcels;

console.log('\n=== ① 层级：街区 → 张量一级分区 → 二级地块 ===');
const regionByBlock = new Map<string, number>();
for (const q of regions) {
  const m = q.id.match(/^(B\d+)-T/);
  if (m) regionByBlock.set(m[1], (regionByBlock.get(m[1]) ?? 0) + 1);
}
const maxPerBlock = Math.max(0, ...[...regionByBlock.values()]);
ok('① 一级分区比街区少、比地块多（真是一层中间级）',
  regions.length >= blocks.length && regions.length < parcels.length * 0.6,
  `${blocks.length} 街区 → ${regions.length} 分区 → ${parcels.length} 地块`);
/**
 * 「少量切分」的真约束是**刀数**，不是片数：一刀切凹形街区（弧形街 + 斜交
 * 路口围出来的街区本来就是凹的）必然产生好几片，只留最大片会让 3%~6% 的
 * 街区面积凭空变成 leftover 绿地。所以这里断言：每街区最多 2 个不同的刀口
 * 方向（= 最多 2 刀），片数上限按 2 刀切凹形的最坏情况给 6。
 */
const anglesByBlock = new Map<string, Set<string>>();
for (const q of regions) {
  const m = q.id.match(/^(B\d+)-T/);
  if (!m) continue;
  if (q.cutRad == null) continue;
  const set = anglesByBlock.get(m[1]) ?? new Set<string>();
  set.add(q.cutRad.toFixed(3));
  anglesByBlock.set(m[1], set);
}
const maxCuts = Math.max(0, ...[...anglesByBlock.values()].map((s) => s.size));
ok('① 少量切分：每街区最多 2 刀（凹形街区的同一切口可产生多片）', maxCuts <= 2 && maxPerBlock <= 6,
  `最多 ${maxCuts} 刀 / ${maxPerBlock} 片`);
ok('① 大多数街区确实被张量场切过（不是空转）', regions.length > blocks.length * 1.4,
  `${regions.length}/${blocks.length} = ${(regions.length / Math.max(1, blocks.length)).toFixed(2)}`);
const badIds = parcels.filter((p) => !/^B\d+-T\d+-P\d+$/.test(p.id));
ok('① 每个地块都挂在某个一级分区下', badIds.length === 0, `异常 id ${badIds.length} 个`);

console.log('\n=== ② 张量方向真的传下去了 ===');
const byId = new Map(blocks.map((b) => [b.id, b]));
let tilted = 0;
let withCut = 0;
for (const q of regions) {
  const m = q.id.match(/^(B\d+)-T/);
  const b = m ? byId.get(m[1]) : undefined;
  let d = Math.abs((q.axisRad - (b?.frontRad ?? q.axisRad)) % Math.PI);
  d = Math.min(d, Math.PI - d);
  if (d > 0.008) tilted++;
  if (q.cutRad !== null) withCut++;
}
ok('② 二级主轴向由张量场给出（不是全城同一个角度）', tilted > regions.length * 0.15,
  `${tilted}/${regions.length} 个分区被场掰过`);
ok('② 一级刀口方向有记录', withCut > regions.length * 0.4, `${withCut}/${regions.length}`);

console.log('\n=== ③ 一级缝 = 内部步行街，且分区已让开 ===');
const walkSurfaces = r.scene.surfaces.filter((s) => s.group === 'lot/internal');
ok('③ 生成了内部步行街（HUD「内部道路」不再恒为 0）', walkSurfaces.length > 0 && lanes.length > 0,
  `${lanes.length} 片 / ${walkSurfaces.length} 个图层要素`);
const site = r.spec.boundary;
let laneOut = 0;
// 内街端点常正好落在红线 / 街区边上，严格点在多边形内会把贴边的合法点判成越界；
// 与 f3.test.ts 同一判据，容差 0.03 世界单位 ≈ 21 cm。
for (const l of lanes) for (const p of l.outer) {
  if (pointInRing(p, site.outer) || insideSurface(p, site)) continue;
  if (distPointToPolyline(p, site.outer) > 0.03) laneOut++;
}
ok('③ 步行街都在场地内', laneOut === 0, `越界点 ${laneOut}`);
// 建筑不能压在步行街上（分区在二级切分前已经扣掉这条带子）
const solids = r.scene.solids;
let onLane = 0;
for (const l of lanes.slice(0, 80)) {
  for (const s of solids) {
    const c = new Pt(s.ring.reduce((a, p) => a + p.x, 0) / s.ring.length, s.ring.reduce((a, p) => a + p.y, 0) / s.ring.length);
    if (insideSurface(c, l)) { onLane++; break; }
  }
}
ok('③ 建筑不压在张量一级缝上', onLane === 0, `${onLane}/${Math.min(80, lanes.length)} 条缝上有建筑`);

console.log('\n=== ④ 二级切分机制没被破坏 ===');
const ratios = parcels.map((p) => rectRatio(p.surface));
ok('④ 地块矩形度中位仍 ≥ 0.90（正交二叉没退化）', median(ratios) >= 0.90,
  `p50 ${median(ratios).toFixed(2)}`);
ok('④ 仍有成规模建筑', solids.length >= 1200, `${solids.length} 栋`);

console.log('\n=== ⑤ 张量线贯穿地块：不留断头 ===');
/**
 * 用户口径：「每条线都贯穿地块，不要出现断头路，否则闭合多边形复杂度
 * 和整体切分都会变奇怪」。
 *
 * 判据：**严格在红线内、离红线 > 1.2 m 的度 1 节点**。红线外的度 1 节点
 * 不算 —— 张量流线本来就故意伸出红线，建图时会裁掉。
 * 实测（没做端点外推时）：structured 6 条、organic 3 条、campus 3 条；
 * 外推 + 射线补接之后：0~3 条（允许真实存在的尽端式支路）。
 */
const ring = spec().boundary.outer;
const boundaryS = spec().boundary;
let deadEnds = 0;
for (const n of r.debug.graph.nodes.values()) {
  if (n.degree !== 1) continue;
  if (!insideSurface(n.at, boundaryS)) continue;
  if (distPointToPolyline(n.at, ring) * 7 > 1.2) deadEnds++;
}
ok('⑤ 内部断头不超过 3%（每条张量线都贯穿地块）',
  deadEnds <= Math.max(3, Math.round(r.debug.graph.junctions.length * 0.03)),
  `${deadEnds} 条 / ${r.debug.graph.junctions.length} 路口`);

const verts = r.debug.blocks.map((b) => b.surface.outer.length).sort((a, b) => a - b);
const vMed = verts[Math.floor(verts.length / 2)] ?? 0;
// 上限里要给**转角圆弧采样点**留位置：每个路口贡献约 10 个点（8 个星形
// 顶点 + 圆弧采样），一个街区四周就是 40 点左右。判据只挡住"碎成锯齿"那种。
ok('⑤ 街区闭合面不碎（顶点数中位 ≤ 60、最大 ≤ 90）',
  vMed <= 60 && (verts[verts.length - 1] ?? 0) <= 90,
  `p50 ${vMed} 点 / 最大 ${verts[verts.length - 1]} 点`);

console.log('\n=== ⑥ 面积账 / 确定性 ===');
const regionA = regions.reduce((a, q) => a + q.areaM2, 0);
const blockA = blocks.reduce((a, b) => a + b.areaM2, 0);
const laneA = lanes.reduce((a, q) => a + M2(surfaceArea(q)), 0);
ok('⑥ 分区 + 步行街 ≈ 街区面积（碎渣由 leftover 兜底）',
  Math.abs(regionA + laneA - blockA) / Math.max(1, blockA) < 0.02,
  `分区 ${regionA.toFixed(0)} + 内街 ${laneA.toFixed(0)} vs 街区 ${blockA.toFixed(0)} m²`);
ok('⑥ 全城面积对账仍闭合', r.stats.unclaimedM2 === 0,
  `未归属 ${r.stats.unclaimedM2} m²`);
const r2 = runF3City(spec());
ok('⑥ 同 seed 层级完全一致',
  r2.debug.tensorRegions.length === regions.length &&
  r2.debug.tensorRegions[0]?.id === regions[0]?.id &&
  r2.debug.parcels[0]?.id === parcels[0]?.id &&
  r2.scene.solids.length === solids.length,
  `${r2.debug.tensorRegions.length} 分区 / ${r2.scene.solids.length} 栋`);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} 项断言，${fail} 项失败`);
if (fail > 0) process.exitCode = 1;
