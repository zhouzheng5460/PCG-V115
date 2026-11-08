// F2.5-C.1 · 验收断言
//
// 与出图脚本走同一条 pipeline，断言的是**任务书 §5/§7 的可验证项**：
//   · 没有接不到外部的道路分量（孤立 = 0）
//   · 没有不可达的 Compound（不可服务 = 0）
//   · 没有过短的无意义路段、没有狭长街区
//   · 楔形窄端不再被横路切断
//   · 三类真实地块的道路组织逻辑互不相同
//   · 固定 seed 可复现
//   · Fracture / Merge / Graph 三层互相可追溯

import { Pt } from '../src/core/geom';
import { surfaceArea } from '../src/town/planning/core/surface';
import { runPipeline, type PipelineResult } from '../src/town/planning/roadgraph';
import { F25_CASES, type F25Case } from './f25c-cases';

let failures = 0;
let total = 0;

function check(name: string, cond: boolean, detail = ''): void {
  total++;
  if (!cond) {
    failures++;
    console.log(`  FAIL ${name} ${detail}`);
  } else {
    console.log(`  ok   ${name} ${detail}`);
  }
}

const cache = new Map<string, PipelineResult>();
function run(c: F25Case, legacy = false): PipelineResult {
  const key = `${c.id}:${legacy ? 'b' : 'a'}`;
  if (!cache.has(key)) {
    cache.set(
      key,
      runPipeline({ id: c.id, boundary: c.boundary, style: c.style, cellM2: c.cellM2, roads: c.roads, entrances: c.entrances }, { legacy })
    );
  }
  return cache.get(key)!;
}

console.log('F2.5-C.1 · 连通骨架与受约束合并');

for (const c of F25_CASES) {
  console.log(`\n[${c.id}] ${c.label}`);
  const r = run(c);
  const d = r.diag;

  // ---- §7 必需服务不存在孤立分量
  check('孤立道路分量 = 0', d.isolated === 0, `实际 ${d.isolated}`);
  check('不可达 Compound = 0', d.unserved === 0, `实际 ${d.unserved}`);

  // ---- §5 没有过短的无意义路段 / 狭长街区
  check('无 <12 m 的中间路段', d.totals.shortEdges === 0, `实际 ${d.totals.shortEdges}`);
  check('无狭长 Compound', d.totals.slivers === 0, `实际 ${d.totals.slivers}`);

  // ---- 拓扑自洽
  const g = r.graph;
  let badPair = 0;
  for (const e of g.edges.values()) {
    if (e.from === e.to) badPair++;
    if (!g.nodes.has(e.from) || !g.nodes.has(e.to)) badPair++;
  }
  check('图的边两端都存在且非自环', badPair === 0, `异常 ${badPair}`);

  let dupNode = 0;
  const seen = new Set<string>();
  for (const n of g.nodes.values()) {
    const k = `${n.position.x.toFixed(2)},${n.position.y.toFixed(2)}`;
    if (seen.has(k)) dupNode++;
    seen.add(k);
  }
  check('无重合节点', dupNode === 0, `重合 ${dupNode}`);

  // ---- 三层可追溯
  const cutIds = new Set(r.frac.cuts.map((k) => k.id));
  const keptTrace = r.merge.keptCuts.every((k) => cutIds.has(k.id));
  check('保留边可追溯到 fracture 的 Cut', keptTrace);
  const edgeTrace = [...g.edges.values()].every((e) => !e.cutId || cutIds.has(e.cutId));
  check('图边可追溯到 fracture 的 Cut', edgeTrace);
  const cellIds = new Set(r.frac.cells.map((x) => x.id));
  const blockTrace = r.merge.blocks.every((b) => b.cells.every((cid) => cellIds.has(cid)));
  check('Compound 可追溯到 Cell', blockTrace);
  const regionTrace = r.regions.regions.every((rg) => r.merge.blocks.some((b) => b.id === rg.blockId));
  check('Region 可追溯到 Compound', regionTrace);

  // ---- 面积守恒（洞结构不变）
  const blockArea = r.merge.blocks.reduce((s, b) => s + b.areaM2, 0);
  const siteArea = surfaceArea(c.boundary) * 49;
  check('街区面积守恒（±2%）', Math.abs(blockArea - siteArea) / siteArea < 0.02, `${blockArea.toFixed(0)} vs ${siteArea.toFixed(0)} m²`);
  // 洞不是"被街区包住"而是"不被任何街区覆盖"—— Voronoi 在洞处不产生 cell，
  // 所以正确的不变量是：洞的形心不落在任何 Compound 里（面积守恒已经覆盖了洞面积）
  let holeCovered = 0;
  for (const h of c.boundary.holes) {
    const c0 = h.reduce((a, q) => new Pt(a.x + q.x / h.length, a.y + q.y / h.length), new Pt());
    for (const b of r.merge.blocks) if (inRing(c0, b.surface.outer) && !b.surface.holes.some((hh) => inRing(c0, hh))) holeCovered++;
  }
  check('洞没有被街区覆盖', holeCovered === 0, `覆盖 ${holeCovered}`);
}

console.log('\n[横切] 楔形 / 工业 / 组织差异 / 复现');

// ---- 楔形：窄端不再被宽道路切断
{
  const r = run(F25_CASES.find((c) => c.id === 'F02')!);
  const bad = r.merge.keptCuts.filter((k) => k.lenM < r.policy.minRoadableSpanM);
  check('F02 无短于可布置跨度的路', bad.length === 0, `${bad.map((k) => k.lenM.toFixed(0)).join(',')}`);
  check('F02 内部路总长 ≤ 40 m（不再被宽道路切割）', r.diag.totals.lengthM <= 40, `${r.diag.totals.lengthM} m`);
  check('F02 给出了"是否需要内部路"的明确判断', !!r.backbone?.noRoadReason || (r.backbone?.protectedCuts.size ?? 0) > 0);
}

// ---- 工业：保持完整大组团
{
  const r = run(F25_CASES.find((c) => c.id === 'I01')!);
  check('I01 内部路 = 0（优先完整大组团）', r.diag.totals.lengthM === 0, `${r.diag.totals.lengthM} m`);
  check('I01 判定理由已写明', !!r.backbone?.noRoadReason);
  check('I01 全部 Compound 直接临街', r.diag.unserved === 0);
}

// ---- 三类真实地块的组织逻辑不同
{
  const r01 = run(F25_CASES.find((c) => c.id === 'R01')!);
  const c01 = run(F25_CASES.find((c) => c.id === 'C01')!);
  const i01 = run(F25_CASES.find((c) => c.id === 'I01')!);
  const dens = (r: PipelineResult): number => r.diag.totals.lengthM / (r.diag.totals.compounds || 1);
  check('R01/C01/I01 的街区数不同', new Set([r01.diag.totals.compounds, c01.diag.totals.compounds, i01.diag.totals.compounds]).size === 3, `${r01.diag.totals.compounds}/${c01.diag.totals.compounds}/${i01.diag.totals.compounds}`);
  check('R01/C01/I01 的每街区路长不同', new Set([dens(r01).toFixed(1), dens(c01).toFixed(1), dens(i01).toFixed(1)]).size === 3);
  check('C01 用 structured 且密度高于 R01', c01.cls.density > r01.cls.density, `${c01.cls.density.toFixed(0)} vs ${r01.cls.density.toFixed(0)} m/ha`);
}

// ---- 固定 seed 复现
{
  const c = F25_CASES[0];
  const a = run(c);
  const b = runPipeline({ id: c.id, boundary: c.boundary, style: c.style, cellM2: c.cellM2 }, {});
  const key = (r: PipelineResult): string =>
    `${r.frac.cells.length}|${r.merge.keptCuts.map((k) => k.id).join(',')}|${r.diag.totals.lengthM.toFixed(2)}|${r.diag.totals.compounds}`;
  check('同 seed 两次结果完全一致', key(a) === key(b), key(a).slice(0, 60));
}

// ---- 修复前后：本轮确实消除了"碎段/不可达"，且没有靠加路硬凑
{
  let beforeComps = 0;
  let afterComps = 0;
  for (const c of F25_CASES) {
    beforeComps += run(c, true).diag.totals.comps;
    afterComps += run(c).diag.totals.comps;
  }
  check('修复后总分量数不增加', afterComps <= beforeComps, `${beforeComps} → ${afterComps}`);
  const totalLenBefore = F25_CASES.reduce((s, c) => s + run(c, true).diag.totals.lengthM, 0);
  const totalLenAfter = F25_CASES.reduce((s, c) => s + run(c).diag.totals.lengthM, 0);
  console.log(`  （参考）路长合计 ${totalLenBefore.toFixed(0)} → ${totalLenAfter.toFixed(0)} m`);
  check('修复后没有整体加路（≤ +15%）', totalLenAfter <= totalLenBefore * 1.15, `${totalLenAfter.toFixed(0)} vs ${totalLenBefore.toFixed(0)}`);
}

function inRing(p: Pt, ring: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y || 1e-12) + a.x) inside = !inside;
  }
  return inside;
}
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${total} 项断言，${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
