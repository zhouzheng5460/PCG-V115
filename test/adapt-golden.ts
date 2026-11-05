// F2.4-A · Golden：建筑服从地块（分割 → 布局 → 门/地面 → 对照）
//
// 用法：npx tsx test/adapt-golden.ts
//
// 样本：G01 / G03 / G04 / G07（合成几何）+ R01 / C01 / I01（真实固定建筑）
// 每个样本输出六格图：切分 / 可建区+锚点 / 建筑定位 / 总平面 / 基线 / 对照
//
// 断言（任务书 §任务5 硬约束）：
//   ① 建筑不越出有效可建区  ② 不切开不移动固定建筑  ③ 建筑之间不重叠
//   ④ 每个门接得上合法通行  ⑤ 面积可对账  ⑥ 既有 F2.1 / 生产回归不退化

import { mkdirSync, writeFileSync } from 'node:fs';
import { Pt } from '../src/core/geom';
import { surfaceArea, type PlanSurface } from '../src/town/planning/core/surface';
import { Model } from '../src/town/model';
import { buildRoadNet } from '../src/road/system';
import { patchKey } from '../src/town/patch';
import { siteContextFromModel } from '../src/town/planning/adapters/model';
import {
  contextFromSite,
  defaultParams,
  makeContext,
  runStrategy,
  StreetFrontOffsetStrategy,
  type SubdivisionCandidate,
  type SubdivisionContext,
  type SubdivisionRun,
} from '../src/town/planning/subdivision';
import {
  defaultLayoutParams,
  layoutParcel,
  validateLayout,
  U,
  toM,
  rectSurface,
  vertexCentroid,
  type LayoutParams,
  type LayoutValidation,
  type ParcelLayout,
} from '../src/town/planning/adapt';
import { obbOf } from '../src/town/planning/subdivision/geom';
import { CASES, type CaseDef } from './fixtures-parcels';
import { renderAdaptSheet, type AdaptPanel } from './adapt-draw';
import type { SiteTypology } from '../src/town/planning/core/types';

let fail = 0;
let checks = 0;
function ok(name: string, cond: boolean, detail = '') {
  checks++;
  if (!cond) {
    fail++;
    console.log(`  FAIL ${name} ${detail}`);
  }
}

const SEED = 682063530;
const M2 = (u2: number) => u2 * 49;

interface Sample {
  id: string;
  label: string;
  typology: SiteTypology;
  ctx: SubdivisionContext;
  roads: SubdivisionContext['roadEdges'];
  boundary: PlanSurface;
  fixed: PlanSurface[];
}

function sampleFromCase(c: CaseDef): Sample {
  const ctx = makeContext(c.boundary, {
    id: c.id,
    parentId: c.id,
    typology: c.typology,
    roadEdges: c.roads,
    fixedBuildings: c.buildings ?? [],
    seed: SEED,
  });
  return {
    id: c.id,
    label: `${c.id} ${c.shape}`,
    typology: c.typology,
    ctx,
    roads: c.roads,
    boundary: c.boundary,
    fixed: c.buildings ?? [],
  };
}

// ---------------------------------------------------------------- 样本

const samples: Sample[] = [];
for (const id of ['G01', 'G03', 'G04', 'G07']) {
  const c = CASES.find((x) => x.id === id);
  if (c) samples.push(sampleFromCase(c));
}

// 生产场景
const PROD: { key: string; label: string }[] = [
  { key: '-469:284', label: 'R01 住宅' },
  { key: '176:176', label: 'C01 商业' },
  { key: '252:-578', label: 'I01 工业' },
];
{
  const m = new Model({ nPatches: 15, seed: SEED, plaza: true });
  m.generate();
  const net = buildRoadNet(m);
  for (const g of PROD) {
    const patch = m.patches.find((x) => patchKey(x) === g.key);
    if (!patch) continue;
    const site = siteContextFromModel(m, patch, { net });
    const buildings: PlanSurface[] = (patch.ward?.geometry ?? [])
      .map((ring) => ({ outer: Array.from(ring).map((q) => new Pt(q.x, q.y)), holes: [] }))
      .filter((s) => surfaceArea(s) > 1e-6);
    const ctx = contextFromSite(site, { seed: SEED, buildings });
    samples.push({
      id: g.key,
      label: `${g.label} ${g.key}`,
      typology: site.typology,
      ctx,
      roads: site.roadEdges,
      boundary: site.parcel,
      fixed: buildings,
    });
  }
}

// ---------------------------------------------------------------- 基线（机械居中）

// ---------------------------------------------------------------- 运行

interface Row {
  sample: string;
  label: string;
  mode: string;
  parcels: number;
  buildings: number;
  coverage: number;
  centerOffsetM: number;
  orientationDevDeg: number;
  envelopeFill: number;
  greenShare: number;
  doors: number;
  doorFailM: number;
  outsideM2: number;
  overlapM2: number;
  fixedM2: number;
  reconcileM2: number;
  ok: boolean;
  reasons: string[];
}

const rows: Row[] = [];
const sheets: { id: string; title: string; panels: AdaptPanel[] }[] = [];
const paramsByTypology = new Map<SiteTypology, LayoutParams>();

mkdirSync('out/adapt', { recursive: true });
const rounds = 3;

for (const s of samples) {
  const subParams = defaultParams(s.typology);
  const run: SubdivisionRun = runStrategy(new StreetFrontOffsetStrategy(), s.ctx, subParams, { rounds });
  const layouts: ParcelLayout[] = [];
  let skippedNoLand = 0;
  for (const c of run.candidates) {
    if (c.role === 'fragment' || c.role === 'reserved') continue;
    // 可建用地为 0 = 这块地全是既有建筑（固定建筑模式下很常见），不参与新增建筑
    if (M2(surfaceArea(c.usable)) < 60) {
      skippedNoLand++;
      continue;
    }
    const lp = paramsByTypology.get(s.typology) ?? defaultLayoutParams();
    layouts.push(layoutParcel(c, lp, { typology: s.typology }));
  }
  const lp = paramsByTypology.get(s.typology) ?? defaultLayoutParams();
  const val: LayoutValidation = validateLayout(layouts, s.fixed);

  // 基线
  const baseLayouts: ParcelLayout[] = run.candidates
    .filter((c) => c.role !== 'fragment' && c.role !== 'reserved' && M2(surfaceArea(c.usable)) >= 60)
    .map((c) => layoutParcel(c, lp, { typology: s.typology, baseline: true }));
  const baseVal = validateLayout(baseLayouts, s.fixed);

  // ---- 汇总（无新增用地的地块单独计数，不计入覆盖率分母）

  const agg = (ls: ParcelLayout[]) => {
    const bs = ls.flatMap((l) => l.buildings);
    const tot = ls.reduce((a, l) => a + l.metrics.usableM2, 0);
    const bm = ls.reduce((a, l) => a + l.metrics.buildingM2, 0);
    const doors = bs.filter((b) => b.door).length;
    return {
      parcels: ls.length,
      buildings: bs.length,
      coverage: tot > 0 ? bm / tot : 0,
      centerOffsetM: bs.length ? ls.reduce((a, l) => a + l.metrics.centerOffsetM, 0) / ls.length : 0,
      orientationDevDeg: bs.length ? ls.reduce((a, l) => a + l.metrics.orientationDevDeg, 0) / ls.length : 0,
      envelopeFill: bs.length ? ls.reduce((a, l) => a + l.metrics.envelopeFill, 0) / ls.length : 0,
      greenShare: tot > 0 ? ls.reduce((a, l) => a + l.metrics.greenM2, 0) / tot : 0,
      doors,
      doorFailM: bs.filter((b) => b.door && b.door.reachM > 30).length,
    };
  };
  const A = agg(layouts);
  const B = agg(baseLayouts);

  const mk = (mode: string, a: typeof A, v: LayoutValidation, ls: ParcelLayout[]): Row => ({
    sample: s.id,
    label: s.label,
    mode,
    parcels: a.parcels,
    buildings: a.buildings,
    coverage: a.coverage,
    centerOffsetM: a.centerOffsetM,
    orientationDevDeg: a.orientationDevDeg,
    envelopeFill: a.envelopeFill,
    greenShare: a.greenShare,
    doors: a.doors,
    doorFailM: a.doorFailM,
    outsideM2: v.outsideM2,
    overlapM2: v.overlapM2,
    fixedM2: v.fixedTouchedM2,
    reconcileM2: v.reconciliationM2,
    ok: v.ok,
    reasons: ls.flatMap((l) => l.reasons),
  });

  rows.push(mk('机械居中（基线）', B, baseVal, baseLayouts));
  rows.push(mk('按地块适配（本层）', A, val, layouts));

  // ---- 硬约束断言（只对本层；基线本来就允许失败，它是反例）
  ok(`${s.id} 布局硬约束`, val.ok, val.errors.slice(0, 4).map((e) => e.message).join(' | '));
  ok(`${s.id} 建筑不越界`, val.outsideM2 < 1, `${val.outsideM2} m²`);
  ok(`${s.id} 建筑不重叠`, val.overlapM2 < 1, `${val.overlapM2} m²`);
  ok(`${s.id} 不压固定建筑`, val.fixedTouchedM2 < 1, `${val.fixedTouchedM2} m²`);
  ok(`${s.id} 门都接得上`, val.doorFailures === 0, `${val.doorFailures} 个门失败`);
  ok(`${s.id} 面积可对账`, val.reconciliationM2 < Math.max(20, run.validation.parentM2 * 0.02), `${val.reconciliationM2} m²`);
  ok(
    `${s.id} 覆盖率合理`,
    A.coverage > 0.15,
    `覆盖 ${(A.coverage * 100).toFixed(0)}%（基线 ${(B.coverage * 100).toFixed(0)}%）`
  );
  // 中心偏移/方向偏差只出数不断言：任务书明确要求"不允许用单一阈值替代不同建筑类型的设计判断"。
  ok(`${s.id} 有成功地块`, layouts.some((l) => l.ok), `${layouts.filter((l) => l.ok).length}/${layouts.length}`);

  // G07：建筑不能落在洞里
  if (s.id === 'G07') {
    const holes = s.boundary.holes;
    let inHole = 0;
    for (const l of layouts) for (const b of l.buildings) for (const h of holes) if (insideRing(b.center, h)) inHole++;
    ok('G07 建筑不落在中庭里', inHole === 0, `${inHole} 栋`);
  }

  // ---- 出图
  const parcelsPanel: AdaptPanel = {
    title: '① 地块切分',
    subtitle: `${run.stats.pieces} 块（可建 ${run.stats.developable}）· ${run.strategyLabel}`,
    boundary: s.boundary,
    roads: s.roads,
    fixed: s.fixed,
    pieces: run.candidates.map((c) => ({ surface: c.surface, role: c.role })),
    foot: [
      `切分：块 ${run.stats.pieces} / 可建 ${run.stats.developable} / 残片 ${run.stats.fragments}` +
        (skippedNoLand > 0 ? ` · 另有 ${skippedNoLand} 块可建用地被既有建筑占满` : ''),
      `临街比例（块均）${(run.stats.frontageShareMean * 100).toFixed(0)}% · 残差 ${run.validation.residualM2.toFixed(1)} m²`,
    ],
  };

  const zonesAll = layouts.flatMap((l) => l.spaces);
  // 锚点 = 可用空间核心（clearance 最大点），不是建筑中心 —— 图上要看的是"场地想让你把楼放哪"
  const coreMarks = layouts.map((l) => ({ at: l.core, kind: 'core' as const }));

  const anchorPanel: AdaptPanel = {
    title: '② 可建区 · 交通走廊 · 锚点',
    subtitle: '浅色 = 可建区，灰色 = 预留内部通道，圈 = 可用空间核心',
    boundary: s.boundary,
    roads: s.roads,
    fixed: s.fixed,
    zones: [
      ...layouts.map((l) => ({ surface: l.usable, kind: 'front_yard' as const })),
      ...zonesAll.filter((z) => z.kind === 'lane').map((z) => ({ surface: z.surface, kind: 'lane' as const })),
    ],
    marks: coreMarks,
    foot: [
      `可建区合计 ${layouts.reduce((a, l) => a + l.metrics.usableM2, 0).toFixed(0)} m²`,
      `内部通道 ${zonesAll.filter((z) => z.kind === 'lane').length} 条（来自真实接入点）`,
    ],
  };

  const buildingPanel: AdaptPanel = {
    title: '③ 建筑定位与方向',
    subtitle: '白线 = 建筑长轴（对齐临街方向）',
    boundary: s.boundary,
    roads: s.roads,
    fixed: s.fixed,
    buildings: layouts.flatMap((l) =>
      l.buildings.map((b) => ({ surface: b.surface, ang: b.ang, label: `${b.widthM.toFixed(0)}×${b.depthM.toFixed(0)}` }))
    ),
    foot: [
      `建筑 ${A.buildings} 栋 · 占地 ${layouts.reduce((a, l) => a + l.metrics.buildingM2, 0).toFixed(0)} m²`,
      `中心偏移 ${A.centerOffsetM.toFixed(1)} m · 方向偏差 ${A.orientationDevDeg.toFixed(0)}° · 包络 ${(A.envelopeFill * 100).toFixed(0)}%`,
    ],
  };

  const planPanel: AdaptPanel = {
    title: '④ 总平面（门 / 通道 / 功能地面）',
    subtitle: '橙点 = 建筑门位，全部接向真实通道或街道',
    boundary: s.boundary,
    roads: s.roads,
    fixed: s.fixed,
    zones: zonesAll.map((z) => ({ surface: z.surface, kind: z.kind })),
    buildings: layouts.flatMap((l) =>
      l.buildings.map((b) => ({ surface: b.surface, ang: b.ang, label: '', door: b.door ?? undefined }))
    ),
    foot: [
      `建筑 ${A.buildings} 栋 / 门 ${A.doors} 个 · 覆盖 ${(A.coverage * 100).toFixed(0)}%`,
      `绿地 ${(A.greenShare * 100).toFixed(0)}% · 面积对账偏差 ${val.reconciliationM2.toFixed(1)} m²`,
      val.ok ? '✓ 硬约束全部通过' : `✗ ${val.errors.length} 项硬约束失败`,
    ],
  };

  const basePanel: AdaptPanel = {
    title: '⑤ 对照 · 机械居中',
    subtitle: '每块地一栋，位置取多边形顶点质心',
    boundary: s.boundary,
    roads: s.roads,
    fixed: s.fixed,
    buildings: baseLayouts.flatMap((l) =>
      l.buildings.map((b) => ({ surface: b.surface, ang: b.ang, label: `${b.widthM.toFixed(0)}×${b.depthM.toFixed(0)}` }))
    ),
    foot: [
      `建筑 ${B.buildings} 栋 · 覆盖 ${(B.coverage * 100).toFixed(0)}% · 中心偏移 ${B.centerOffsetM.toFixed(1)} m`,
      `越界 ${baseVal.outsideM2.toFixed(1)} m² · 重叠 ${baseVal.overlapM2.toFixed(1)} m² · 门失败 ${baseVal.doorFailures}`,
      baseVal.ok ? '（基线恰好也没违约）' : `✗ ${baseVal.errors.length} 项硬约束失败 —— 这正是"机械居中"的代价`,
    ],
  };

  const improvedPanel: AdaptPanel = {
    title: '⑥ 对照 · 按地块条件适配',
    subtitle: '程序按类型定几栋/多大/什么姿态，位置由可用空间核心决定',
    boundary: s.boundary,
    roads: s.roads,
    fixed: s.fixed,
    buildings: layouts.flatMap((l) =>
      l.buildings.map((b) => ({ surface: b.surface, ang: b.ang, label: `${b.widthM.toFixed(0)}×${b.depthM.toFixed(0)}` }))
    ),
    foot: [
      `建筑 ${A.buildings} 栋 · 覆盖 ${(A.coverage * 100).toFixed(0)}% · 中心偏移 ${A.centerOffsetM.toFixed(1)} m`,
      `越界 ${val.outsideM2.toFixed(1)} m² · 重叠 ${val.overlapM2.toFixed(1)} m² · 门失败 ${val.doorFailures}`,
      val.ok ? '✓ 硬约束全部通过' : `✗ ${val.errors.length} 项硬约束失败`,
    ],
  };

  sheets.push({
    id: s.id,
    title: `${s.label} · 建筑服从地块`,
    panels: [parcelsPanel, anchorPanel, buildingPanel, planPanel, basePanel, improvedPanel],
  });
}

// ---------------------------------------------------------------- 输出

const f = (n: number, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '-');
console.log('\n=== F2.4-A 建筑布局：基线 vs 按地块适配 ===');
let last = '';
for (const r of rows) {
  if (r.sample !== last) {
    console.log(`\n${r.label}`);
    last = r.sample;
  }
  console.log(
    `  ${r.mode.padEnd(18)} 地${String(r.parcels).padStart(3)} 栋${String(r.buildings).padStart(3)} ` +
      `覆盖${(r.coverage * 100).toFixed(0).padStart(3)}% 中心偏移${f(r.centerOffsetM).padStart(6)}m ` +
      `方向${f(r.orientationDevDeg, 0).padStart(3)}° 包络${(r.envelopeFill * 100).toFixed(0).padStart(3)}% ` +
      `绿地${(r.greenShare * 100).toFixed(0).padStart(3)}% 门${String(r.doors).padStart(3)} ` +
      `越界${f(r.outsideM2).padStart(6)} 重叠${f(r.overlapM2).padStart(5)} 固定${f(r.fixedM2).padStart(5)} ${r.ok ? 'OK' : 'ERR'}`
  );
}

writeFileSync(
  'out/adapt/metrics.json',
  JSON.stringify({ seed: SEED, rows, generatedAt: new Date().toISOString() }, null, 2)
);

for (const sh of sheets) {
  writeFileSync(
    `out/adapt/${sh.id.replace(':', '_')}.svg`,
    renderAdaptSheet(sh.panels, {
      title: sh.title,
      note: '同一比例 / 同一配色。⑤ 与 ⑥ 只画建筑，用来直接对比"机械居中"和"按地块条件定位"。',
      width: 1200,
      panelH: 340,
      cols: 3,
    })
  );
}

console.log(`\n检查 ${checks} 项，失败 ${fail} 项`);
console.log('图：out/adapt/*.svg   数：out/adapt/metrics.json');
if (fail > 0) process.exitCode = 1;

function insideRing(p: Pt, ring: Pt[]): boolean {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y || 1e-12) + a.x) c = !c;
  }
  return c;
}

void M2;
