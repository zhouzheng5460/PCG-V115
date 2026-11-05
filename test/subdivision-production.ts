// F2.1 · 生产场景验证（R01 住宅 / C01 商业 / I01 工业）
//
// 用法：npx tsx test/subdivision-production.ts
//
// 目的不是"切得好看"，而是三件事：
//   ① 在**真实地块**（真实 Road Graph、真实红线、真实退线）上，两个策略不炸；
//   ② 固定建筑模式：既有建筑不被切开、不丢失归属；
//   ③ 既有合法出入口仍然落在某一块地内（分割不能把门切到别人家里）。
//
// 数据源与 s1-report / planning-frontend 完全一致（seed 682063530 · nPatches 15 · plaza）。

import { mkdirSync, writeFileSync } from 'node:fs';
import { Model } from '../src/town/model';
import { buildRoadNet } from '../src/road/system';
import { patchKey } from '../src/town/patch';
import { siteContextFromModel } from '../src/town/planning/adapters/model';
import { distToSurfaceEdge, pointInRing, surfaceArea, type PlanSurface } from '../src/town/planning/core/surface';
import { Pt } from '../src/core/geom';
import {
  contextFromSite,
  defaultParams,
  fingerprint,
  runStrategy,
  RecursiveObbStrategy,
  StreetFrontOffsetStrategy,
  type SubdivisionRun,
} from '../src/town/planning/subdivision';
import { renderSheet, toDrawPieces, type Panel } from './subdivision-draw';

const SEED = 682063530;
const GOLDEN: { key: string; label: string }[] = [
  { key: '-469:284', label: 'R01 住宅' },
  { key: '176:176', label: 'C01 商业' },
  { key: '252:-578', label: 'I01 工业' },
];

let fail = 0;
let checks = 0;
function ok(name: string, cond: boolean, detail = '') {
  checks++;
  if (!cond) {
    fail++;
    console.log(`  FAIL ${name} ${detail}`);
  }
}

console.log('生成城市…');
const m = new Model({ nPatches: 15, seed: SEED, plaza: true });
m.generate();
const net = buildRoadNet(m);

const rows: {
  case: string;
  method: string;
  pieces: number;
  developable: number;
  fragments: number;
  parentM2: number;
  ok: boolean;
  errors: string[];
  ms: number;
}[] = [];
const sheets: { key: string; label: string; panels: Panel[] }[] = [];

for (const g of GOLDEN) {
  const patch = m.patches.find((x) => patchKey(x) === g.key);
  if (!patch) {
    console.log(`  SKIP ${g.label} ${g.key}（本次种子下不存在）`);
    continue;
  }
  const site = siteContextFromModel(m, patch, { net });
  const buildings: PlanSurface[] = (patch.ward?.geometry ?? [])
    .map((ring) => ({ outer: Array.from(ring).map((q) => new Pt(q.x, q.y)), holes: [] }))
    .filter((s) => surfaceArea(s) > 1e-6);

  const ctx = contextFromSite(site, { seed: SEED, buildings });
  const params = defaultParams(site.typology);

  const t0 = Date.now();
  const obb = runStrategy(new RecursiveObbStrategy(), ctx, params, { rounds: 5 });
  const off = runStrategy(new StreetFrontOffsetStrategy(), ctx, params, { rounds: 5 });
  const ms = Date.now() - t0;

  console.log(
    `\n${g.label} ${g.key} · typology=${site.typology} · 红线 ${(surfaceArea(site.parcel) * 49).toFixed(0)} m² · 建筑 ${buildings.length} 栋`
  );
  for (const run of [obb, off]) {
    console.log(
      `  ${run.strategyLabel.padEnd(20)} 块${String(run.stats.pieces).padStart(3)} 可建${String(
        run.stats.developable
      ).padStart(3)} 残片${String(run.stats.fragments).padStart(2)} 临街${(run.stats.frontageShareMean * 100)
        .toFixed(0)
        .padStart(3)}% 残差${run.validation.residualM2.toFixed(1).padStart(7)} 重叠${run.validation.overlapM2
        .toFixed(1)
        .padStart(5)} 布尔${run.validation.booleanFailures} ${run.validation.ok ? 'OK' : 'ERR'}`
    );
    for (const e of run.validation.errors.slice(0, 4)) console.log(`     ✗ ${e.code}: ${e.message}`);
    rows.push({
      case: g.key,
      method: run.strategyLabel,
      pieces: run.stats.pieces,
      developable: run.stats.developable,
      fragments: run.stats.fragments,
      parentM2: run.validation.parentM2,
      ok: run.validation.ok,
      errors: run.validation.errors.map((e) => `${e.code}: ${e.message}`),
      ms: run.stats.msMedian,
    });
  }

  // ---- 断言
  for (const run of [obb, off]) {
    ok(`${g.key} ${run.strategyId} 硬约束`, run.validation.ok, run.validation.errors.map((e) => e.message).join(' | '));
    ok(`${g.key} ${run.strategyId} 无重叠`, run.validation.overlapM2 < 1, `${run.validation.overlapM2} m²`);
    ok(`${g.key} ${run.strategyId} 无越界`, run.validation.outsideM2 < 1, `${run.validation.outsideM2} m²`);
    ok(`${g.key} ${run.strategyId} 建筑未被切开`,
      run.validation.errors.every((e) => e.code !== 'building-split'),
      run.validation.errors.filter((e) => e.code === 'building-split').map((e) => e.message).join(' | '));
    // 既有出入口必须仍在某一块地内（分割不能把门丢掉）
    const closed = (site.parcel.outer.length ?? 0) >= 3;
    if (closed) {
      for (const a of site.vehicleAccessCandidates.slice(0, 2)) {
        // 出入口点落在**红线**上，严格 inside 会判 false。这里按"落在某块地内或贴其边界 ≤2 单位"判。
        const held = run.candidates.some(
          (c) =>
            (pointInRing(a.at, c.surface.outer) && !c.surface.holes.some((h) => pointInRing(a.at, h))) ||
            distToSurfaceEdge(a.at, c.surface) <= 2
        );
        ok(`${g.key} ${run.strategyId} 既有车行口未丢失`, held, `(${a.at.x.toFixed(1)},${a.at.y.toFixed(1)})`);
      }
    }
  }
  const f1 = fingerprint(new RecursiveObbStrategy().generate(ctx, params));
  const f2 = fingerprint(new RecursiveObbStrategy().generate(ctx, params));
  ok(`${g.key} 可复现`, f1 === f2);

  sheets.push({
    key: g.key,
    label: g.label,
    panels: [
      {
        title: '① 真实地块（红线 + 真实道路 + 既有建筑）',
        subtitle: `${g.label} · typology ${site.typology}`,
        boundary: site.parcel,
        roads: site.roadEdges,
        buildings,
        pieces: [],
        axisHints: obb.axisHints,
        foot: [
          `红线 ${(surfaceArea(site.parcel) * 49).toFixed(0)} m² · 可建区 ${(surfaceArea(site.buildableArea) * 49).toFixed(0)} m²`,
          `真实道路边 ${site.roadEdges.length} 条 · 既有建筑 ${buildings.length} 栋`,
        ],
      },
      ...(
        [
          ['② Recursive OBB', obb],
          ['③ Street-front Offset', off],
        ] as [string, SubdivisionRun][]
      ).map(([title, run]) => ({
        title,
        subtitle: `${run.stats.pieces} 块 · 可建 ${run.stats.developable} · 残片 ${run.stats.fragments}`,
        boundary: site.parcel,
        roads: site.roadEdges,
        buildings,
        pieces: toDrawPieces(run),
        foot: [
          `临街比例（块均）${(run.stats.frontageShareMean * 100).toFixed(0)}% · 残片占比 ${(
            run.stats.fragmentShare * 100
          ).toFixed(0)}%`,
          `残差 ${run.validation.residualM2.toFixed(1)} m² · 重叠 ${run.validation.overlapM2.toFixed(1)} m² · P50 ${run.stats.msMedian.toFixed(1)} ms`,
          run.validation.ok ? '✓ 硬约束全部通过' : `✗ ${run.validation.errors.length} 项硬约束失败`,
        ],
      })),
    ],
  });
  void ms;
}

mkdirSync('out/subdivision', { recursive: true });
for (const s of sheets) {
  writeFileSync(
    `out/subdivision/prod-${s.key.replace(':', '_')}.svg`,
    renderSheet(s.panels, {
      title: `${s.label} ${s.key} · 生产场景分割`,
      note: '同一画幅 / 同一比例 / 同一配色。灰点状线 = 城市道路中心线；黑色实心 = 既有建筑（不可移动）。',
      width: 1180,
      panelH: 360,
      cols: 3,
    })
  );
}
writeFileSync(
  'out/subdivision/production.json',
  JSON.stringify({ seed: SEED, rows, generatedAt: new Date().toISOString() }, null, 2)
);

console.log(`\n检查 ${checks} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;
