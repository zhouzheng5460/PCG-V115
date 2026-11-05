// 城市尺度 A/B/C 对照（同一 seed，只改断面 / 街区参数）
//
// 用法：npx tsx test/scale-shadow.ts
//
// 每组都完整跑一遍「建模 → 路网」，量的是同一批指标，避免"只报告道路变窄了"。

import { Model } from '../src/town/model';
import { buildRoadNet, roadSurfaces } from '../src/road/system';
import { surfaceArea } from '../src/town/planning/core/surface';
import { siteContextFromModel } from '../src/town/planning/adapters/model';
import { area } from '../src/town/zones';
import { applyScalePreset, SCALE_PRESETS, type ScalePresetName } from '../src/road/scale-preset';
import { specOf } from '../src/road/spec';
import type { SurfaceFeature } from '../src/scene/types';
import type { RoadClass } from '../src/road/system';

const SEED = 682063530;
const NP = 15;
const m2 = (u2: number) => u2 * 49;
const med = (xs: number[]) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
const quant = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
};

interface Row {
  name: string;
  spec: string;
  label: string;
  ms: number;
  blocks: number;
  blockP50: number;
  shortP50: number;
  roadM2: number;
  roadShare: number;
  carriageM2: number;
  juncCount: number;
  juncM2: number;
  juncP50: number;
  buildableM2: number;
  bldCover: number;
  lenByCls: Record<RoadClass, number>;
}

function run(name: ScalePresetName): Row {
  const cfg = applyScalePreset(name);
  const t0 = performance.now();
  const m = new Model({ nPatches: NP, seed: SEED, plaza: true });
  if (cfg.spacingK !== undefined) m.params.block.spacingK = cfg.spacingK;
  m.generate();
  const net = buildRoadNet(m);
  const ms = performance.now() - t0;

  const feats: SurfaceFeature[] = [];
  roadSurfaces(net, feats);
  let roadM2 = 0, juncM2 = 0, carriageM2 = 0;
  const jAreas = new Map<string, number>();
  for (const s of feats) {
    const a = surfaceArea({ outer: s.ring, holes: s.holes ?? [] }) * 49;
    roadM2 += a;
    if (s.group === 'road/junction') {
      juncM2 += a;
      const mm = /^junc_(\d+)_/.exec(s.name);
      if (mm) jAreas.set(mm[1], (jAreas.get(mm[1]) ?? 0) + a);
    } else if (s.group === 'road/surface') carriageM2 += a;
  }
  // 车行道宽度合计（含路口吞掉的部分，用于跟路口面积对齐）
  const lenByCls: Record<RoadClass, number> = { arterial: 0, collector: 0, local: 0 };
  for (const e of net.edges) lenByCls[e.cls] += e.len * 7;

  const blocks = m.patches.filter((p) => p.withinCity && !p.blocked);
  const blockAreas: number[] = [];
  const shortSides: number[] = [];
  let buildable = 0;
  for (const p of blocks) {
    const ring = Array.from(p.shape);
    blockAreas.push(Math.abs(area(ring)) * 49);
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const q of ring) { x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
    shortSides.push(Math.min(x1 - x0, y1 - y0) * 7);
    const ctx = siteContextFromModel(m, p, { net });
    buildable += surfaceArea(ctx.buildableArea) * 49;
  }

  const cityArea = Math.PI * m.cityRadius * m.cityRadius * 49;
  const lotArea = blockAreas.reduce((a, b) => a + b, 0);
  return {
    name,
    spec: `${specOf('arterial').redLine}/${specOf('collector').redLine}/${specOf('local').redLine}`,
    label: SCALE_PRESETS[name].label,
    ms,
    blocks: blocks.length,
    blockP50: med(blockAreas),
    shortP50: med(shortSides),
    roadM2,
    roadShare: roadM2 / cityArea,
    carriageM2,
    juncCount: jAreas.size,
    juncM2,
    juncP50: med([...jAreas.values()]),
    buildableM2: buildable,
    bldCover: buildable / lotArea,
    lenByCls,
  };
}

const rows = (['base', 'A', 'B', 'C'] as ScalePresetName[]).map(run);

const base = rows[0];
const d = (v: number, b: number, unit = '') => {
  const dv = v - b;
  const s = dv >= 0 ? '+' : '';
  return `${s}${dv.toFixed(0)}${unit} (${((dv / b) * 100).toFixed(0)}%)`;
};

console.log(`\n═══ 尺度 A/B/C · seed ${SEED} · n=${NP} · tensor ═══\n`);
console.log('组  断面(红线 m)                 耗时   街区数  中位面积   中位短边  城市道路      占比     路口数  路口面积  中位路口');
for (const r of rows) {
  console.log(
    `${r.name.padEnd(4)} ${r.spec.padEnd(26)} ${r.ms.toFixed(0).padStart(5)}ms ` +
    `${String(r.blocks).padStart(5)}  ${r.blockP50.toFixed(0).padStart(8)}m² ${r.shortP50.toFixed(0).padStart(6)}m ` +
    `${r.roadM2.toFixed(0).padStart(7)}m² ${(r.roadShare * 100).toFixed(1).padStart(6)}% ` +
    `${String(r.juncCount).padStart(5)}  ${r.juncM2.toFixed(0).padStart(7)}m² ${r.juncP50.toFixed(0).padStart(7)}m²`
  );
}
applyScalePreset('base');

console.log('\n—— 相对基线 ——');
for (const r of rows.slice(1)) {
  console.log(`${r.name}: 城市道路 ${d(r.roadM2, base.roadM2, 'm²')} · 路口 ${d(r.juncM2, base.juncM2, 'm²')} · ` +
    `中位街区 ${d(r.blockP50, base.blockP50, 'm²')} · 中位短边 ${d(r.shortP50, base.shortP50, 'm')} · ` +
    `可建面积 ${d(r.buildableM2, base.buildableM2, 'm²')} · 耗时 ${d(r.ms, base.ms, 'ms')}`);
}

console.log('\n—— 各等级道路长度占比 ——');
for (const r of rows) {
  const tot = r.lenByCls.arterial + r.lenByCls.collector + r.lenByCls.local;
  console.log(`${r.name.padEnd(4)} 主 ${(r.lenByCls.arterial / tot * 100).toFixed(0)}% · 次 ${(r.lenByCls.collector / tot * 100).toFixed(0)}% · 支 ${(r.lenByCls.local / tot * 100).toFixed(0)}%  (总 ${(tot / 1000).toFixed(1)} km)`);
}

console.log('\n—— 关键比值 ——');
for (const r of rows) {
  console.log(`${r.name.padEnd(4)} 道路/城市 ${(r.roadShare * 100).toFixed(1)}% · 可建/地块 ${(r.bldCover * 100).toFixed(0)}% · ` +
    `路口/车行道 ${(r.juncM2 / r.carriageM2 * 100).toFixed(0)}% · 城市道路 ${(r.roadM2 / 1000).toFixed(0)}k m²`);
}
console.log('');
