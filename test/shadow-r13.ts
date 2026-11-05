// R1.3 · 全城 Shadow 统计（不是测试，是量尺）
//
// 用法：npx tsx test/shadow-r13.ts
//
// 在**完整 44 块城内地块**上跑两遍 Planner：
//   A = 开关全关（= 只有 R1.2-C 之前的旧 circulation，作为基线）
//   B = 开关全放开（= 所有被接管地块都换求解器网络）
// 对比：生成时间、失败率、道路面积、地面覆盖变化。
//
// 为什么要 A/B 而不是只看默认那三块：三个 Golden 通过不代表全城能上。
// 放开之前必须先知道"最坏会长什么样"。

import { Model } from '../src/town/model';
import { buildRoadNet } from '../src/road/system';
import { buildPlannerBundle, type PlannerBundle } from '../src/scene/planner-bridge';
import { patchKey } from '../src/town/patch';
import { surfaceArea } from '../src/town/planning/core/surface';

const SEED = 682063530;

interface Stat {
  label: string;
  ms: number;
  parcels: number;
  covered: number;
  roadM2: number;
  surfM2: number;
  parcelM2: number;
  circApplied: number;
  circFailed: { key: string; reason: string }[];
  topFail: [string, number][];
}

function measure(label: string, bundle: PlannerBundle, ms: number, cityParcels: Set<string>): Stat {
  let roadM2 = 0;
  let surfM2 = 0;
  let parcelM2 = 0;
  let circApplied = 0;
  const circFailed: { key: string; reason: string }[] = [];
  const fails = new Map<string, number>();

  for (const [key, r] of bundle.reports) {
    if (!cityParcels.has(key)) continue;
    if (!r.covered) {
      const why = (r.reason ?? '未知').replace(/（.*?）/g, '');
      fails.set(why, (fails.get(why) ?? 0) + 1);
      continue;
    }
    const feats = bundle.byParcel.get(key);
    if (!feats) continue;
    for (const s of feats.surfaces) {
      const a = surfaceArea({ outer: s.ring, holes: s.holes ?? [] }) * 49;
      surfM2 += a;
      if (/_road_\d+_surf_/.test(s.name)) roadM2 += a;
    }
    if (r.circulation) {
      if (r.circulation.applied) circApplied++;
      else circFailed.push({ key, reason: r.circulation.reason ?? '未说明' });
    }
  }
  // 地块面积：从 reports 里拿不到，用 byParcel 的几何外包近似不靠谱 —— 直接用 patches
  parcelM2 = 0;

  const covered = [...bundle.reports.entries()].filter(([k, r]) => cityParcels.has(k) && r.covered).length;
  return {
    label,
    ms,
    parcels: cityParcels.size,
    covered,
    roadM2,
    surfM2,
    parcelM2,
    circApplied,
    circFailed,
    topFail: [...fails.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
  };
}

const m = new Model({ nPatches: 15, seed: SEED, plaza: true });
m.generate();
const net = buildRoadNet(m);

const cityParcels = new Set<string>();
for (const p of m.patches) if (!p.blocked && p.withinCity) cityParcels.add(patchKey(p));

console.log(`场景 seed ${SEED} · 城内 ${cityParcels.size} 块\n`);

const runs: Stat[] = [];
for (const [label, gate] of [
  ['A 开关全关（基线）', new Set<string>()],
  ['B 全城启用', null],
] as [string, Set<string> | null][]) {
  const t0 = performance.now();
  const b = buildPlannerBundle(m, net, 'planner', { circulationParcels: gate });
  const ms = performance.now() - t0;
  runs.push(measure(label, b, ms, cityParcels));
}

const row = (s: Stat) =>
  `${s.label.padEnd(20)} ${s.ms.toFixed(0).padStart(5)} ms · 接管 ${s.covered}/${s.parcels} · ` +
  `道路 ${s.roadM2.toFixed(0).padStart(6)} m² · 全部铺装 ${s.surfM2.toFixed(0).padStart(7)} m²`;

for (const s of runs) {
  console.log(row(s));
  if (s.circFailed.length) {
    console.log(`  求解器拒绝 ${s.circFailed.length} 块：`);
    for (const f of s.circFailed.slice(0, 6)) console.log(`    · ${f.key}: ${f.reason}`);
  }
  if (s.topFail.length) {
    console.log(`  未接管原因：${s.topFail.map(([w, n]) => `${w} ×${n}`).join(' · ')}`);
  }
}

const [a, b] = runs;
console.log('\n—— 变化 ——');
console.log(`生成时间   ${a.ms.toFixed(0)} → ${b.ms.toFixed(0)} ms（${(((b.ms - a.ms) / a.ms) * 100).toFixed(1)}%）`);
console.log(`道路面积   ${a.roadM2.toFixed(0)} → ${b.roadM2.toFixed(0)} m²（${(b.roadM2 - a.roadM2).toFixed(0)} m²，${(((b.roadM2 - a.roadM2) / Math.max(a.roadM2, 1)) * 100).toFixed(1)}%）`);
console.log(`全部铺装   ${a.surfM2.toFixed(0)} → ${b.surfM2.toFixed(0)} m²（${(b.surfM2 - a.surfM2).toFixed(0)} m²）`);
console.log(`接管地块   ${a.covered} → ${b.covered}`);
console.log(`换用新网   ${a.circApplied} → ${b.circApplied} 块`);
if (b.circFailed.length) {
  console.log(`\n⚠ 全城启用时 ${b.circFailed.length} 块换不上新网络（会回落到旧 circulation）：`);
  for (const f of b.circFailed) console.log(`  · ${f.key}: ${f.reason.slice(0, 90)}`);
}
