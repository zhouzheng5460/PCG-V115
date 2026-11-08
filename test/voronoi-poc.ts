// F2.4-E 试验：Voronoi 有机路网（纯布尔实现）
//
// 对应视频里的 Houdini 做法：Grid → scatter → Voronoi fracture → 单元边界当路网
// → polyextrude/boolean 把路"刻"出来。这里不含任何 Houdini，全部落在现有的
// PlanSurface 布尔上，所以浏览器和 Node 都能跑。
//
// 输出 out/vor/：G01 / G07（含洞）/ R01 对照 / 城区尺度 DIST。

import { mkdirSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { surfaceArea } from '../src/town/planning/core/surface';
import type { PlanSurface } from '../src/town/planning/core/surface';
import { voronoiBlock } from '../src/town/planning/compose/voronoi';
import type { SiteScene, ScenePoly } from '../src/town/planning/compose/scene';
import { renderCompare } from './scene2d';
import { CASE_BY_ID } from './fixtures-parcels';
import { inputOf } from './compose-inputs';
import { composeCandidates } from '../src/town/planning/compose';

const M2 = (u2: number) => u2 * 49;
mkdirSync('out/vor', { recursive: true });

function bbox(s: PlanSurface) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of s.outer) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  return { minX, minY, maxX, maxY };
}

function sceneOf(id: string, boundary: PlanSurface, parcels: PlanSurface[], roads: PlanSurface[]): SiteScene {
  const ground: ScenePoly[] = [
    { mat: 'base', ring: boundary.outer, holes: boundary.holes, yM: 0, tag: '红线', areaM2: M2(surfaceArea(boundary)) },
    ...roads.map((r) => ({ mat: 'road' as const, ring: r.outer, holes: r.holes, yM: 0.16, tag: '道路', areaM2: M2(surfaceArea(r)) })),
    ...parcels.map((p) => ({ mat: 'forecourt' as const, ring: p.outer, holes: p.holes, yM: 0.1, tag: '地块', areaM2: M2(surfaceArea(p)) })),
  ];
  const bb = bbox(boundary);
  return {
    id, typology: 'generic', boundary, ground, solids: [], trees: [], stalls: [], legend: [],
    stats: { blockM2: M2(surfaceArea(boundary)), baseM2: 0, buildingM2: 0, greenM2: 0, pavedM2: 0, roadM2: 0, trees: 0, maxHeightM: 0, byMat: {} },
    bbox: bb,
  };
}

for (const id of ['G01', 'G07']) {
  const c = CASE_BY_ID.get(id)!;
  const t0 = Date.now();
  const areaM2 = M2(surfaceArea(c.boundary));
  const v = voronoiBlock(c.boundary, { seed: 20261106, count: Math.max(3, Math.round(areaM2 / 2600)), roadM: 9, sidewalkM: 2 });
  const ms = Date.now() - t0;
  console.log(`${id} cell ${v.cells.length} 地块 ${v.parcels.length} 路 ${v.roads.length} 路面积 ${M2(v.roads.reduce((s, r) => s + surfaceArea(r), 0)).toFixed(0)}m² ${ms}ms`);
  writeFileSync(`out/vor/${id}.svg`, renderCompare([
    { scene: sceneOf(`${id}·原始`, c.boundary, [], []), title: '① 红线', subtitle: '（含洞）', foot: [`面积 ${M2(surfaceArea(c.boundary)).toFixed(0)} m²`] },
    { scene: sceneOf(`${id}·voronoi`, c.boundary, v.parcels, v.roads), title: '② Voronoi 街区', subtitle: `cell ${v.cells.length} · 地块 ${v.parcels.length}`, foot: [`路 ${M2(v.roads.reduce((s, r) => s + surfaceArea(r), 0)).toFixed(0)} m² · ${ms} ms`] },
  ], { width: 1200, title: `${id} · Voronoi 有机路网（纯布尔实现）` }));
}

// R01：与现有方案对照
{
  const input = inputOf('R01');
  const t0 = Date.now();
  const v = voronoiBlock(input.boundary, { seed: 20261106, count: 8, roadM: 9, sidewalkM: 2 });
  const ms = Date.now() - t0;
  const cur = composeCandidates(input, { max: 1 }).cands[0];
  console.log(`R01 cell ${v.cells.length} 地块 ${v.parcels.length} ${ms}ms；现有 ${cur.comp.buildings.length} 栋`);
  writeFileSync('out/vor/R01.svg', renderCompare([
    { scene: sceneOf('R01·voronoi', input.boundary, v.parcels, v.roads), title: '① Voronoi 有机街区', subtitle: `cell ${v.cells.length} · 地块 ${v.parcels.length} · ${ms} ms`, foot: [`路 ${M2(v.roads.reduce((s, r) => s + surfaceArea(r), 0)).toFixed(0)} m²`] },
    { scene: cur.scene, title: '② 当前 Compose', subtitle: `${cur.label} · ${cur.comp.buildings.length} 栋`, foot: [`总分 ${cur.score.total.toFixed(3)}`] },
  ], { width: 1240, title: 'R01 · Voronoi 与当前方案对照（同比例尺）' }));
}

// 城区尺度：600×420 m 的新区（对标视频里的"整片城市"）
{
  const { Pt } = await import('../src/core/geom');
  const { surface } = await import('../src/town/planning/core/surface');
  const b = surface([new Pt(-42, -30), new Pt(42, -30), new Pt(42, 30), new Pt(-42, 30)]);
  const t0 = Date.now();
  const v = voronoiBlock(b, { seed: 7, count: 64, roadM: 8, sidewalkM: 2, relax: 2, minDistM: 34 });
  const ms = Date.now() - t0;
  const roadA = M2(v.roads.reduce((s2, r) => s2 + surfaceArea(r), 0));
  console.log(`城区 588×420 cell ${v.cells.length} 地块 ${v.parcels.length} 路 ${roadA.toFixed(0)}m² ${ms}ms`);
  writeFileSync('out/vor/DIST.svg', renderCompare([
    { scene: sceneOf('DIST·voronoi', b, v.parcels, v.roads), title: '① Voronoi 城区', subtitle: `cell ${v.cells.length} · 地块 ${v.parcels.length} · ${ms} ms`, foot: [`路网 ${roadA.toFixed(0)} m²（${(roadA / M2(surfaceArea(b)) * 100).toFixed(0)}%）`] },
  ], { width: 900, title: '城区尺度试跑：588×420 m，64 个 Voronoi 街区' }));
}
