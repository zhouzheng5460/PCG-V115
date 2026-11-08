// F2.5-C.2 · 三方案同尺度对照出图
//
// 每个样板一张三联图（A / B / C 共用同一取景与比例尺），
// 面板内容：道路真实占地（深色）+ Compound（浅色、带描边）+ 中心线（按等级着色）。
// 脚注给：路长 / 主次支比 / 分量 / Compound / 路占 / 急转 / 狭长。

import { mkdirSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { Pt } from '../src/core/geom';
import { surfaceArea, type PlanSurface } from '../src/town/planning/core/surface';
import { ALGO_LABEL, runSkeleton, type SkeletonAlgo, type SkeletonResult } from '../src/town/planning/roadgraph/skeleton';
import { F25_CASES } from './f25c-cases';
import { renderF25, type Panel } from './f25-draw';

const OUT = 'out/f25c2';
mkdirSync(OUT, { recursive: true });
const M2 = (u2: number) => u2 * 49;
const ALGOS: SkeletonAlgo[] = ['tensor', 'fracture', 'hybrid'];
const ALGO_SHORT: Record<SkeletonAlgo, string> = { tensor: 'A', fracture: 'B', hybrid: 'C' };

const clsStroke = (c: string): string => (c === 'arterial' ? '#e06c4a' : c === 'collector' ? '#d9a13f' : c === 'local' ? '#6fa8dc' : '#8f98a3');

function panelsOf(caseId: string, label: string, boundary: PlanSurface, results: SkeletonResult[]): Panel[] {
  return results.map((r) => {
    const s = r.stats;
    const polys: Panel['polys'] = [
      ...r.compounds.compounds.map((k, i) => ({
        ring: k.surface.outer,
        holes: k.surface.holes,
        fill: i % 2 ? '#55606e' : '#46505c',
        stroke: '#aab6c4',
        strokeW: 0.7,
      })),
      ...r.roadSurface.map((rd) => ({ ring: rd.outer, holes: rd.holes, fill: '#191d23', stroke: '#2b323b', strokeW: 0.4 })),
    ];
    const lines = [...r.graph.edges.values()].map((e) => ({
      pts: e.centerline,
      stroke: clsStroke(e.roadClass),
      width: e.roadClass === 'arterial' ? 2.2 : e.roadClass === 'collector' ? 1.7 : 1.3,
    }));
    const labels = r.compounds.compounds
      .filter((k) => k.areaM2 >= 500)
      .map((k) => ({
        at: anchorOf(k.surface),
        text: `${k.areaM2}`,
        fill: '#e8eef5',
        size: 7.5,
      }));
    return {
      group: caseId,
      title: `${ALGO_LABEL[r.algo]}`,
      subtitle:
        s.edges === 0
          ? '无内部道路（见下方判定）'
          : `路 ${s.lengthM.toFixed(0)} m · ${s.edges} 段 · 分量 ${s.components} · Compound ${s.compounds.count}`,
      boundary,
      polys,
      lines,
      labels,
      foot: [
        s.edges === 0
          ? '判定：整片场地即一个街区，无需内部道路'
          : `主${(s.byClass.arterial / Math.max(1, s.lengthM) * 100).toFixed(0)}% 次${(
              (s.byClass.collector / Math.max(1, s.lengthM)) * 100
            ).toFixed(0)}% 支${((s.byClass.local / Math.max(1, s.lengthM)) * 100).toFixed(0)}% · 路占 ${(s.roadRatio * 100).toFixed(0)}%`,
        `急转 ${s.sharpTurns} · 短段 ${s.shortSegments} · 狭长 ${s.compounds.slivers} · 可建 ${s.compounds.buildable}/${s.compounds.count}`,
        `中位 ${s.compounds.medianM2} m² · 形状 ${s.compounds.meanShapeQ}`,
      ],
    };
  });
}

function anchorOf(s: PlanSurface): Pt {
  let x = 0;
  let y = 0;
  for (const p of s.outer) {
    x += p.x;
    y += p.y;
  }
  return new Pt(x / Math.max(1, s.outer.length), y / Math.max(1, s.outer.length));
}

const SUMMARY: Record<string, unknown> = {};

for (const c of F25_CASES) {
  const results = ALGOS.map((a) =>
    runSkeleton(a, { id: c.id, boundary: c.boundary, style: c.style, cellM2: c.cellM2, roads: c.roads, entrances: c.entrances, seed: 20261106 })
  );
  const svg = renderF25(panelsOf(c.id, c.label, c.boundary, results), {
    width: 1680,
    cols: 3,
    title: `F2.5-C.2 · ${c.id} ${c.label}（${c.shape}）· 三种道路骨架同尺度对照`,
    subtitle: 'A 张量场流线 · B Fracture+Merge+Backbone · C 主路先切 + 剩余区域用 B 补支路（同一取景）',
  });
  writeFileSync(`${OUT}/${c.id}_abc.svg`, svg);
  await sharp(Buffer.from(svg), { density: 120 }).png().toFile(`${OUT}/${c.id}_abc.png`);

  SUMMARY[c.id] = {
    label: c.label,
    shape: c.shape,
    areaM2: +M2(surfaceArea(c.boundary)).toFixed(0),
    noRoad: results[0].noRoad,
    candidates: Object.fromEntries(
      results.map((r) => [
        r.algo,
        {
          stats: r.stats,
          notes: r.notes,
          trace: { tensorLines: r.trace.tensorLines, main: r.trace.mainLines, branch: r.trace.branchLines, attached: r.trace.attached.length, pruned: r.trace.prunedEdges },
        },
      ])
    ),
  };
  const line = results
    .map((r) => `${ALGO_SHORT[r.algo]} ${r.stats.lengthM.toFixed(0)}m/${r.stats.compounds.count}块/占${(r.stats.roadRatio * 100).toFixed(0)}%`)
    .join(' | ');
  console.log(`${c.id} ${line}`);
}

writeFileSync(`${OUT}/summary.json`, JSON.stringify(SUMMARY, null, 1));
console.log('\n输出', OUT);
