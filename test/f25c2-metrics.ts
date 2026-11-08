// F2.5-C.2 · 从 summary.json 生成选型用的度量表（markdown）
import { readFileSync, writeFileSync } from 'node:fs';

interface S {
  stats: {
    nodes: number; edges: number; components: number; lengthM: number;
    byClass: { arterial: number; collector: number; local: number; internal: number };
    deadEnds: number; shortSegments: number; sharpTurns: number; meanTurnDeg: number; sharpPer100m: number;
    roadAreaM2: number; roadRatio: number;
    compounds: { count: number; medianM2: number; meanShapeQ: number; slivers: number; buildable: number; buildableShare: number; meanFrontageRatio: number };
    access: { city: number; boundaryOnly: number; none: number };
  };
  notes: string[];
}

const j = JSON.parse(readFileSync('out/f25c2/summary.json', 'utf8')) as Record<string, {
  label: string; shape: string; areaM2: number;
  noRoad: { needed: boolean; why: string };
  candidates: Record<string, S>;
}>;

const ORDER = ['tensor', 'fracture', 'hybrid'];
const NAME: Record<string, string> = { tensor: 'A 张量场', fracture: 'B Fracture', hybrid: 'C Hybrid' };
const lines: string[] = [];
lines.push('| 样板 | 方案 | 路长 m | 路占 | 主/次/支 | 分量 | 急转 | 短段 | Compound | 中位 m² | 狭长 | 可建 | 形状 | 临街率 | 接入(真/红) |');
lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const [id, c] of Object.entries(j)) {
  for (const algo of ORDER) {
    const s = c.candidates[algo].stats;
    const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
    const cls = s.lengthM > 0 ? `${pct(s.byClass.arterial / s.lengthM)}/${pct(s.byClass.collector / s.lengthM)}/${pct(s.byClass.local / s.lengthM)}` : '—';
    lines.push(
      `| ${id} | ${NAME[algo]} | ${s.lengthM.toFixed(0)} | ${pct(s.roadRatio)} | ${cls} | ${s.components} | ${s.sharpTurns} | ${s.shortSegments} | ${s.compounds.count} | ${s.compounds.medianM2} | ${s.compounds.slivers} | ${s.compounds.buildable}/${s.compounds.count} | ${s.compounds.meanShapeQ} | ${pct(s.compounds.meanFrontageRatio)} | ${s.access.city}/${s.access.boundaryOnly} |`
    );
  }
}
const md = lines.join('\n');
writeFileSync('out/f25c2/metrics.md', md);
console.log(md);
