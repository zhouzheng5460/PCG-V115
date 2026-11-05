// R1.4 · 全城内部交通验收报告（不是测试，是量尺）
//
// 用法：npx tsx test/r1-4-report.ts
//
// 回答一个问题：**R1 是否真的在全城形成了一张合理的交通网络**，
// 而不是在既有铺装上又补了几段路。
//
// 输出口径（很重要，上一版报告混过）：
//   52  patch 总数
//   44  城内地块（withinCity && !blocked）—— "全城"指的是这个分母
//   47  Planner 实际接管的地块数（比 44 多 3 块，那 3 块在城外但被 Planner 规划了）
// 所以"38 生效 + 9 拒绝 = 47"的分母是**接管口径**，不是城内 44。

import { Model } from '../src/town/model';
import { buildRoadNet, roadSurfaces } from '../src/road/system';
import { buildPlannerBundle, type CirculationMode } from '../src/scene/planner-bridge';
import { patchKey } from '../src/town/patch';
import { surfaceArea, surfaceIntersect } from '../src/town/planning/core/surface';

const SEED = 682063530;
const NP = 15;
const GOLDEN = new Set(['-469:284', '176:176', '252:-578']);

/** 既有道路按 program 的名义宽度（m），只用于把面积折算成"等效长度" */
const NOMINAL_W: Record<string, number> = {
  service_lane: 7,
  driveway: 6,
  parking_aisle: 7,
  pedestrian: 2.2,
};

const m = new Model({ nPatches: NP, seed: SEED, plaza: true });
m.generate();
const net = buildRoadNet(m);

const cityKeys = new Set<string>();
for (const p of m.patches) if (!p.blocked && p.withinCity) cityKeys.add(patchKey(p));

const roadFeats: { name: string; ring: any[]; holes?: any[] }[] = [];
roadSurfaces(net, roadFeats as any);
const cityRoadM2 = roadFeats.reduce((s, f) => s + surfaceArea({ outer: f.ring, holes: f.holes ?? [] }), 0) * 49;

interface Row {
  mode: CirculationMode;
  ms: number;
  covered: number;
  applied: number;
  rejected: number;
  rejectedInCity: number;
  /** 拒绝里其实"不适用"的（绿地/公园，压根没有通行需求入口） */
  notApplicable: number;
  /** 真的有需求却解不出来的 */
  failed: number;
  newPaths: number;
  newLenM: number;
  newAreaM2: number;
  existingAreaM2: number;
  existingLenM: number;
  odTotal: number;
  odConnected: number;
  onExisting: number;
  p95: number;
  reasons: [string, number][];
}

function run(mode: CirculationMode): Row {
  const t0 = performance.now();
  const b = buildPlannerBundle(m, net, 'planner', { circulation: mode });
  const ms = performance.now() - t0;

  let applied = 0, rejected = 0, rejectedInCity = 0, notApplicable = 0, failed = 0;
  let newPaths = 0, newLenM = 0, newAreaM2 = 0;
  let existingAreaM2 = 0, existingLenM = 0;
  let odTotal = 0, odConnected = 0, onExisting = 0;
  const reasons = new Map<string, number>();
  const times: number[] = [];

  for (const [key, r] of b.reports) {
    if (!r.covered) continue;
    const f = b.byParcel.get(key)!;
    for (const s of f.surfaces) {
      if (/_road_\d+_surf_/.test(s.name)) {
        newAreaM2 += surfaceArea({ outer: s.ring, holes: s.holes ?? [] }) * 49;
      }
    }
    const c = r.circulation;
    if (!c) continue;
    if (c.applied) {
      applied++;
      newPaths += c.paths;
      newLenM += c.lengthM;
      odTotal += c.odTotal;
      odConnected += c.odConnected;
      times.push(c.ms);
    } else {
      rejected++;
      if (cityKeys.has(key)) rejectedInCity++;
      // **分母口径的关键**：绿地/公园没有非街口入口 = 根本没有通行需求，
      // 那是"不适用"，不是"求解失败"。混在一起会把 9 个不适用说成 9 个失败。
      const dd = b.circulationDebug.get(key);
      const demand = dd ? dd.nodes.filter((n) => n.kind !== 'street').length : 0;
      if (demand === 0) {
        notApplicable++;
      } else {
        failed++;
        const why = (c.reason ?? '未说明').replace(/（.*?）/g, '').replace(/：.*$/, '').slice(0, 28);
        reasons.set(why, (reasons.get(why) ?? 0) + 1);
      }
    }
    const d = b.circulationDebug.get(key);
    if (d) {
      onExisting += d.onExisting;
      for (const a of d.adopted) {
        const area = surfaceArea({ outer: a.outer, holes: [] }) * 49;
        existingAreaM2 += area;
        existingLenM += area / (NOMINAL_W[a.program] ?? 6);
      }
    }
  }

  times.sort((x, y) => x - y);
  const p95 = times.length ? times[Math.min(times.length - 1, Math.floor(times.length * 0.95))] : 0;

  return {
    mode, ms,
    covered: [...b.reports.values()].filter((r) => r.covered).length,
    applied, rejected, rejectedInCity, notApplicable, failed,
    newPaths, newLenM: +newLenM.toFixed(0), newAreaM2: +newAreaM2.toFixed(0),
    existingAreaM2: +existingAreaM2.toFixed(0), existingLenM: +existingLenM.toFixed(0),
    odTotal, odConnected, onExisting,
    p95: +p95.toFixed(1),
    reasons: [...reasons.entries()].sort((a, b2) => b2[1] - a[1]),
  };
}

console.log(`\n═══ R1.4 全城内部交通 · seed ${SEED} · n=${NP} ═══`);
console.log(`patch 总数 ${m.patches.length} · 城内 ${cityKeys.size} · Planner 接管口径见下\n`);

const rows = (['off', 'golden', 'all'] as CirculationMode[]).map(run);
/** 体检要用同一份 planner 结果，避免再跑一遍 */
const bundleAll = buildPlannerBundle(m, net, 'planner', { circulation: 'all' });
const base = rows[0];
const all = rows[2];

console.log('模式      耗时    接管   生效   拒绝(城内)  新路(条/m)      新铺(m²)  既有路(m²)  OD连通    P95');
for (const r of rows) {
  console.log(
    `${r.mode.padEnd(8)} ${r.ms.toFixed(0).padStart(5)}ms ${String(r.covered).padStart(5)} ` +
    `${String(r.applied).padStart(5)} ${String(r.rejected).padStart(6)}(${r.rejectedInCity}) ` +
    `${String(r.newPaths).padStart(4)}条/${String(r.newLenM).padStart(5)}m ${String(r.newAreaM2).padStart(9)} ` +
    `${String(r.existingAreaM2).padStart(9)} ${String(r.odConnected + '/' + r.odTotal).padStart(8)} ${String(r.p95).padStart(7)}ms`
  );
}

console.log('\n—— 分母口径 ——');
console.log(`Planner 接管 ${all.covered} 块（含城外）；城内 ${cityKeys.size} 块。`);
console.log(`all 模式：生效 ${all.applied} + 不适用 ${all.notApplicable} + 真失败 ${all.failed} = ${all.applied + all.rejected}（= 接管口径，不是城内 44）`);
console.log(`拒绝里有 ${all.rejectedInCity} 块落在城内。`);
const applicable = all.applied + all.failed;
console.log(`**适用地块 ${applicable} 块，其中生效 ${all.applied} 块 = 覆盖率 ${((all.applied / Math.max(applicable, 1)) * 100).toFixed(0)}%**`);
console.log(`不适用 ${all.notApplicable} 块全部是 green / park：没有任何非街口入口，本来就不该有内部交通。`);

console.log('\n—— 网络规模 ——');
console.log(`新铺路面 ${all.newAreaM2} m² / 新路中心线 ${all.newLenM} m`);
console.log(`既有可通行道路 ${all.existingAreaM2} m²，等效长度约 ${all.existingLenM} m（按 program 名义宽度折算，是估算）`);
console.log(`有效网络总长 ≈ ${all.newLenM + all.existingLenM} m`);
const reuse = all.odTotal > 0 ? (all.onExisting / all.odTotal) * 100 : 0;
console.log(`既有道路复用率（目标直接落在既有路上的 OD 占比）${all.onExisting}/${all.odTotal} = ${reuse.toFixed(0)}%`);
console.log(`新铺路面占城市道路面积 ${((all.newAreaM2 / cityRoadM2) * 100).toFixed(1)}%（城市道路 ${cityRoadM2.toFixed(0)} m²）`);

console.log('\n—— 失败原因分类（只统计真失败）——');
if (all.reasons.length === 0) console.log('  **没有真失败**：所有拒绝都是"无通行需求"');
for (const [w, n] of all.reasons) console.log(`  ${w.padEnd(30)} ${n} 块`);

console.log('\n—— 相对关闭 R1 ——');
console.log(`耗时 ${base.ms.toFixed(0)} → ${all.ms.toFixed(0)} ms（${(((all.ms - base.ms) / base.ms) * 100).toFixed(1)}%）`);
console.log(`单块 P95 ${base.p95} → ${all.p95} ms`);
console.log(`新铺 ${base.newAreaM2} → ${all.newAreaM2} m²`);

// ---------------------------------------------------------------- 全城体检
{
  let edges = 0, attached = 0, shortEdges = 0;
  let detourMax = 0, detourSum = 0, detourN = 0;
  for (const [, d] of bundleAll.circulationDebug) {
    const streets = d.nodes.filter((n) => n.kind === 'street').map((n) => n.at);
    for (const e of d.edges) {
      edges++;
      const p0 = e.pts[0];
      if (streets.some((s) => Math.hypot(s.x - p0.x, s.y - p0.y) * 7 < 4)) attached++;
      const lenM = e.pts.slice(1).reduce((acc, q, i) => acc + Math.hypot(q.x - e.pts[i].x, q.y - e.pts[i].y), 0) * 7;
      if (lenM < 10) shortEdges++;
      const straight = Math.hypot(e.pts[e.pts.length - 1].x - p0.x, e.pts[e.pts.length - 1].y - p0.y) * 7;
      if (straight > 3) { const r = lenM / straight; detourSum += r; detourN++; detourMax = Math.max(detourMax, r); }
    }
  }
  console.log('\n—— 网络体检 ——');
  console.log(`A* 边 ${edges} 条：起点接街口 ${attached}（${((attached / Math.max(edges, 1)) * 100).toFixed(0)}%）`);
  console.log(`短片段（中心线 <10 m）${shortEdges} 条（${((shortEdges / Math.max(edges, 1)) * 100).toFixed(0)}%）`);
  console.log(`绕行系数 平均 ${(detourSum / Math.max(detourN, 1)).toFixed(2)} · 最大 ${detourMax.toFixed(2)}（1.0 = 直线）`);

  // 新路面 vs 建筑：错误穿过建筑是最严重的一类
  let hitBuilding = 0;
  const hitNames: string[] = [];
  for (const [key, feats] of bundleAll.byParcel) {
    const roads = feats.surfaces.filter((s) => /_road_\d+_surf_/.test(s.name));
    if (!roads.length) continue;
    for (const b of feats.solids) {
      for (const r of roads) {
        const inter = surfaceIntersect(
          [{ outer: r.ring, holes: r.holes ?? [] }],
          [{ outer: b.ring, holes: [] }]
        ).reduce((acc, q) => acc + surfaceArea(q), 0) * 49;
        if (inter > 5) { hitBuilding += inter; if (hitNames.length < 5) hitNames.push(`${key} ${r.name} ∩ ${b.name} = ${inter.toFixed(1)} m²`); }
      }
    }
  }
  console.log(`新路面压建筑 ${hitBuilding.toFixed(1)} m²${hitNames.length ? '（前几处：' + hitNames.join('；') + '）' : '（无）'}`);
}

console.log('\n—— 三个 Golden ——');
for (const key of GOLDEN) {
  const r = buildPlannerBundleSafe(key);
  console.log(`  ${key.padEnd(10)} ${r}`);
}

function buildPlannerBundleSafe(key: string): string {
  const b = buildPlannerBundle(m, net, 'planner', { circulation: 'all', circulationParcels: new Set([key]) });
  const rep = b.reports.get(key);
  const d = b.circulationDebug.get(key);
  const c = rep?.circulation;
  if (!c) return '无 circulation 报告（未接管）';
  const edges = d?.edges.length ?? 0;
  const adopted = d?.adopted.length ?? 0;
  const un = d?.unreachable.length ?? 0;
  return `生效=${c.applied} 新路 ${c.paths} 条/${c.lengthM}m · 既有 ${adopted} 块 · 边 ${edges} 条 · 不可达 ${un} · ` +
    `OD ${c.odConnected}/${c.odTotal} · 旧路 保留 ${c.keptLegacy}/替换 ${c.replacedLegacy}`;
}

console.log('');
