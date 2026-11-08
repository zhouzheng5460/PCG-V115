// F2.5-A/B/C · 第一轮验收出图
//
// 每个样板 5 层 + 1 张 3D：
//   ① 原始街区范围
//   ② 破碎产生的全部候选切线（全选就是一堆碎块，所以这不是路）
//   ③ 合并之后留下来的边 → 中心线图（打断/吸附/清理/平滑后的拓扑）
//   ④ 道路面 + 被路围合的街区
//   ⑤ 合并前后对照（cell → 街区）
//   ⑥ 3D 正交（街区抬起 6 m，路平铺）

import { mkdirSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { Pt } from '../src/core/geom';
import { surface, surfaceArea, type PlanSurface } from '../src/town/planning/core/surface';
import {
  buildGraph,
  buildRegions,
  classifyRoads,
  graphStats,
  mergeCells,
  STYLES,
  widthOfClass,
  type Cut,
  type CutLine,
  type Fracture,
  type MergeResult,
  type RegionResult,
  type RoadGraph,
  type StyleId,
} from '../src/town/planning/roadgraph';
import { fractureVoronoi } from '../src/town/planning/roadgraph';
import { flatPolygon, extrudeSolid } from '../src/export/mesh';
import { renderPrimitives } from './soft3d';
import { renderF25, F25_COLORS as C, type Panel } from './f25-draw';
import { CASE_BY_ID } from './fixtures-parcels';
import { inputOf } from './compose-inputs';

const OUT = 'out/f25';
mkdirSync(OUT, { recursive: true });
const M2 = (u2: number) => u2 * 49;

const pngOf = async (w: number, h: number, rgba: Uint8Array): Promise<Buffer> =>
  sharp(Buffer.from(rgba), { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();

/** 狭长楔形：160 m 长、一端 26 m 一端 12 m */
function wedge(): PlanSurface {
  const m = (v: number) => v / 7;
  return surface([new Pt(m(0), m(0)), new Pt(m(160), m(6)), new Pt(m(160), m(18)), new Pt(m(0), m(26))]);
}

interface Case {
  id: string;
  label: string;
  boundary: PlanSurface;
  style: StyleId;
  /** 期望 cell 面积（m²）：决定破碎密度 */
  cellM2: number;
}

const CASES: Case[] = [
  { id: 'F01', label: '规则矩形 140×98 m', boundary: CASE_BY_ID.get('G01')!.boundary, style: 'organic', cellM2: 1800 },
  { id: 'F02', label: '狭长楔形 160×26 m', boundary: wedge(), style: 'organic', cellM2: 3000 },
  { id: 'F03', label: '不规则 L 形（G05）', boundary: CASE_BY_ID.get('G05')!.boundary, style: 'organic', cellM2: 1800 },
  { id: 'F04', label: '带洞街区（G07）', boundary: CASE_BY_ID.get('G07')!.boundary, style: 'organic', cellM2: 1800 },
  { id: 'R01', label: 'R01 住宅 -469:284', boundary: inputOf('R01').boundary, style: 'organic', cellM2: 1800 },
  { id: 'C01', label: 'C01 商业 176:176', boundary: inputOf('C01').boundary, style: 'structured', cellM2: 1700 },
  { id: 'I01', label: 'I01 工业 252:-578', boundary: inputOf('I01').boundary, style: 'campus', cellM2: 3600 },
];

interface Result {
  c: Case;
  frac: Fracture;
  merge: MergeResult;
  cls: ReturnType<typeof classifyRoads>;
  graph: RoadGraph;
  regions: RegionResult;
  ms: { fracture: number; merge: number; graph: number; regions: number; total: number };
}

function run(c: Case, opt: { style?: StyleId } = {}): Result {
  const style = STYLES[opt.style ?? c.style];
  const t0 = Date.now();
  const rings = [c.boundary.outer, ...c.boundary.holes];
  const areaM2 = M2(surfaceArea(c.boundary));

  const count = Math.max(4, Math.min(52, Math.round(areaM2 / c.cellM2)));
  const frac = fractureVoronoi(c.boundary, { seed: 20261106, count, minDistM: 0, relax: 3, jitter: 0.35 });
  const t1 = Date.now();

  // ②→③ 的关键一步：合并（删掉弱边）。删完还在的边才成为道路
  //
  // `strictUnion` 固定为 true：这是 F2.5 第一轮的**对照组**，必须保持当年的
  // 布尔行为不变（C.1 里加的"5 mm 微偏移重试"见 regions.tryUnion 注释）。
  // 否则这一份数据每轮都会被下游的修复带着漂移，就没法当基线了。
  const merge = mergeCells(frac, frac.cuts, {
    targetM2: style.blockM2,
    weakEdgeM: style.weakEdgeM,
    strongEdgeM: style.strongEdgeM,
    strictUnion: true,
  });
  const t2 = Date.now();

  const cls = classifyRoads(merge.keptCuts, { style, boundaryRings: rings, areaM2 });
  const cutLines: CutLine[] = cls.cuts.map((k) => ({
    pts: [k.a, k.b],
    cls: k.cls,
    widthM: k.widthM ?? style.width[k.cls],
    source: 'fracture',
  }));
  const graph = buildGraph(cutLines, { boundary: rings, smooth: 2, minEdgeM: 8, snapM: 1.8 });
  const t3 = Date.now();

  const regions = buildRegions(c.boundary, merge, (k: Cut) => k.widthM ?? widthOfClass(k.cls), { minPartM2: 60 });
  const t4 = Date.now();

  return { c, frac, merge, cls, graph, regions, ms: { fracture: t1 - t0, merge: t2 - t1, graph: t3 - t2, regions: t4 - t3, total: t4 - t0 } };
}

function panelsOf(r: Result): Panel[] {
  const g = r.graph;
  const st = graphStats(g);
  const clsStroke = (cls: string) =>
    cls === 'arterial' ? C.arterial : cls === 'collector' ? C.collector : C.local;
  return [
    {
      title: '① 原始街区范围',
      subtitle: r.c.label,
      boundary: r.c.boundary,
      foot: [`面积 ${M2(surfaceArea(r.c.boundary)).toFixed(0)} m²`, `洞 ${r.c.boundary.holes.length} 个`],
    },
    {
      title: '② 破碎候选切线',
      subtitle: `${r.frac.cuts.length} 条候选 · ${r.frac.cells.length} 个 cell`,
      boundary: r.c.boundary,
      lines: r.frac.cuts.map((k) => ({ pts: [k.a, k.b], stroke: C.candidate, width: 0.9, opacity: 0.9 })),
      foot: ['全选会切成一堆碎块 —— 所以这不是路', `破碎 ${r.ms.fracture} ms`],
    },
    {
      title: '③ 合并后留下的边 → 中心线图',
      subtitle: `保留 ${r.cls.cuts.length}/${r.frac.cuts.length} 条 · 密度 ${r.cls.density.toFixed(0)} m/ha`,
      boundary: r.c.boundary,
      lines: [...g.edges.values()].map((e) => ({
        pts: e.centerline,
        stroke: clsStroke(e.roadClass),
        width: e.roadClass === 'arterial' ? 2.8 : e.roadClass === 'collector' ? 2.1 : 1.5,
      })),
      dots: [...g.nodes.values()].map((n) => ({
        at: n.position,
        r: n.nodeType === 'intersection' ? 3.2 : n.nodeType === 'boundary' ? 2.6 : 1.8,
        fill: n.nodeType === 'boundary' ? 'none' : C.node,
        ring: n.nodeType === 'boundary' ? C.node : C.nodeRing,
      })),
      foot: [
        `节点 ${st.nodes}（交叉 ${st.intersections} / 尽端 ${st.terminals} / 边界 ${st.boundaries}）`,
        `悬空 ${st.dangling} · 分量 ${st.components} · 路长 ${st.lengthM.toFixed(0)} m`,
      ],
    },
    {
      title: '④ 道路面 + 被路围合的街区',
      subtitle: `${r.regions.after} 块街区`,
      boundary: r.c.boundary,
      polys: [
        ...r.regions.regions.map((rg, i) => ({ ring: rg.surface.outer, holes: rg.surface.holes, fill: i % 2 ? C.block : C.blockAlt })),
        ...r.regions.roadRibbons.map((rd) => ({ ring: rd.outer, holes: rd.holes, fill: C.road })),
      ],
      foot: [
        `路面 ${M2(r.regions.roads.reduce((s, x) => s + surfaceArea(x), 0)).toFixed(0)} m²`,
        `街区中位数 ${median(r.regions.regions.map((x) => x.areaM2)).toFixed(0)} m²`,
      ],
    },
    {
      title: '⑤ 合并前后',
      subtitle: `cell ${r.merge.before} → 街区 ${r.merge.after}（合并 ${r.merge.merges.length} 次）`,
      boundary: r.c.boundary,
      polys: r.regions.regions.map((rg, i) => ({ ring: rg.surface.outer, holes: rg.surface.holes, fill: i % 2 ? C.block : C.blockAlt })),
      lines: r.regions.preMerge.map((p) => ({
        pts: [...p.surface.outer, p.surface.outer[0]],
        stroke: C.merged,
        width: 0.8,
        dash: '3 2',
        opacity: 0.9,
      })),
      foot: ['绿虚线 = 合并前的 cell 边界（消失的边就是"不是路"的边）', `合并 ${r.ms.merge} ms`],
    },
  ];
}

function median(v: number[]): number {
  if (v.length === 0) return 0;
  const s = v.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

async function render3D(r: Result): Promise<Buffer> {
  const prims = [];
  const base = flatPolygon(r.c.boundary.outer, 0, 'base', 'ground', [0.16, 0.18, 0.2], r.c.boundary.holes);
  if (base) prims.push(base);
  for (const rg of r.regions.regions) {
    prims.push(...extrudeSolid(rg.surface.outer, 0.02, 6 / 7, `blk-${rg.id}`, 'block', [0.42, 0.46, 0.52], [0.55, 0.58, 0.62]));
  }
  for (const rd of r.regions.roadRibbons) {
    const p = flatPolygon(rd.outer, 0.05, 'road', 'road', [0.1, 0.11, 0.13], rd.holes);
    if (p) prims.push(p);
  }
  const img = renderPrimitives(prims, { size: 1000, azimuth: -90, elevation: 88, background: [0.055, 0.062, 0.075] });
  return pngOf(img.width, img.height, img.rgba);
}

// ---------------------------------------------------------------- 主流程

const summary: Record<string, unknown>[] = [];

for (const c of CASES) {
  const r = run(c);
  const st = graphStats(r.graph);
  writeFileSync(
    `${OUT}/${c.id}_layers.svg`,
    renderF25(panelsOf(r), {
      width: 1620,
      cols: 3,
      title: `F2.5 · ${c.id} ${c.label} · ${STYLES[c.style].label}`,
      subtitle: '② 候选不是路 → 合并删掉弱边 → ③ 剩下的边才是路网 → ④ 挖出街区 → ⑤ 合并前后',
    })
  );
  writeFileSync(`${OUT}/${c.id}_3d.png`, await render3D(r));
  summary.push({
    id: c.id,
    label: c.label,
    style: c.style,
    cells: r.frac.cells.length,
    cuts: r.frac.cuts.length,
    kept: r.cls.cuts.length,
    merged: r.merge.merges.length,
    blocks: r.merge.after,
    regions: r.regions.after,
    nodes: st.nodes,
    intersections: st.intersections,
    dangling: st.dangling,
    boundaries: st.boundaries,
    components: st.components,
    roadLenM: st.lengthM,
    density: +r.cls.density.toFixed(0),
    roadsM2: +M2(r.regions.roads.reduce((s, x) => s + surfaceArea(x), 0)).toFixed(0),
    ms: r.ms,
  });
  console.log(
    `${c.id} ${c.label} | cell ${r.frac.cells.length} 候选 ${r.frac.cuts.length} → 保留 ${r.cls.cuts.length}` +
      ` | 节点 ${st.nodes}(交叉 ${st.intersections} 悬空 ${st.dangling} 边界 ${st.boundaries}) 分量 ${st.components} 密度 ${r.cls.density.toFixed(0)}` +
      ` | 街区 ${r.merge.after} | ${r.ms.total}ms`
  );
}

// 三种街区并排（第 ④ 层成品）
{
  const picks = ['F01', 'F02', 'F03'].map((id) => run(CASES.find((x) => x.id === id)!));
  writeFileSync(
    `${OUT}/COMPARE.svg`,
    renderF25(
      picks.map((r) => ({
        title: r.c.label,
        subtitle: `街区 ${r.regions.after} 块 · 路 ${r.cls.cuts.length} 条 · ${r.cls.density.toFixed(0)} m/ha`,
        boundary: r.c.boundary,
        polys: [
          ...r.regions.regions.map((rg, i) => ({ ring: rg.surface.outer, holes: rg.surface.holes, fill: i % 2 ? C.block : C.blockAlt })),
          ...r.regions.roadRibbons.map((rd) => ({ ring: rd.outer, holes: rd.holes, fill: C.road })),
        ],
        foot: [`cell ${r.frac.cells.length} → 街区 ${r.regions.after}`],
      })),
      { width: 1500, cols: 3, title: 'F2.5 · 三种街区形态对照（规则 / 楔形 / 不规则）', subtitle: '同一套破碎-合并-分级机制，没有为任何样板写死切线' }
    )
  );
}

// 三种风格（同一块地）
{
  const base = CASES.find((x) => x.id === 'F01')!;
  const labels = ['A · Organic District', 'B · Structured Urban', 'C · Campus / Industrial'];
  const picks = (['organic', 'structured', 'campus'] as StyleId[]).map((sid, i) => ({ label: labels[i], r: run(base, { style: sid }) }));
  writeFileSync(
    `${OUT}/STYLES.svg`,
    renderF25(
      picks.map((p) => ({
        title: p.label,
        subtitle: `路 ${p.r.cls.cuts.length} 条 · 密度 ${p.r.cls.density.toFixed(0)} m/ha`,
        boundary: p.r.c.boundary,
        polys: [
          ...p.r.regions.regions.map((rg, k) => ({ ring: rg.surface.outer, holes: rg.surface.holes, fill: k % 2 ? C.block : C.blockAlt })),
          ...p.r.regions.roadRibbons.map((rd) => ({ ring: rd.outer, holes: rd.holes, fill: C.road })),
        ],
        foot: [`街区 ${p.r.regions.after} 块 · 中位数 ${median(p.r.regions.regions.map((x) => x.areaM2)).toFixed(0)} m²`],
      })),
      { width: 1500, cols: 3, title: 'F2.5-E · 三种路网风格（同一块地，只换策略）', subtitle: '策略只改参数与权重，不复制三套几何引擎' }
    )
  );
}

writeFileSync(`${OUT}/summary.json`, JSON.stringify({ cases: summary }, null, 1));
console.log('\n输出', OUT);
