// S1 报告 · 三个 Golden：原版布局 vs S1 骨架布局
//
// 用法：npx tsx test/s1-report.ts
//
// 两边用的是**同一把尺子**（`mfDiagnostics` / `retailDiagnostics` /
// `industrialDiagnostics` + `evaluateLayout`），S1 不开小灶。
// 另外单列 S1 自己的可解释分项（`s1Metrics`），因为现有 diagnostics 里
// 没有"建筑到道路间距""停车贴不贴车道"这几项 —— 而那正是本轮要改的东西。
//
// 铺装层面的数字（道路面积 / 贴墙铺装）取自 **SceneIR**，不是 candidate：
// 落到 Scene 之后还要过 ownership 切割与退线带认领，只有 Scene 才是看到的。

import { Model } from '../src/town/model';
import { buildRoadNet } from '../src/road/system';
import { buildPlannerBundle } from '../src/scene/planner-bridge';
import { surfaceArea, surfaceIntersect } from '../src/town/planning/core/surface';
import { patchKey } from '../src/town/patch';
import { siteContextFromModel } from '../src/town/planning/adapters/model';
import { generateCandidates } from '../src/town/planning/generators';
import { s1Metrics, type S1Metrics } from '../src/town/planning/skeleton';
import type { SitePlanCandidate } from '../src/town/planning/core/candidate';

const SEED = 682063530;
const GOLDEN: { key: string; label: string }[] = [
  { key: '-469:284', label: 'MF' },
  { key: '176:176', label: 'retail' },
  { key: '252:-578', label: 'industrial' },
];

const m = new Model({ nPatches: 15, seed: SEED, plaza: true });
m.generate();
const net = buildRoadNet(m);

const f1 = (n: number, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '-');
const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
const m2 = (s: { ring: unknown[]; holes?: unknown[] }) =>
  surfaceArea({ outer: s.ring as never, holes: (s.holes ?? []) as never }) * 49;

// ---------------------------------------------------------------- 铺装统计

interface Pavement {
  /** 内部车行路面（solve 出来的 + 骨架车道） */
  roadPieces: number;
  roadM2: number;
  laneM2: number;
  /** 贴着建筑（< 2.5 m）的路面面积 */
  huggingM2: number;
  /** 地块内所有硬质铺装 */
  hardM2: number;
}

function dRing(a: { x: number; y: number }[], b: { x: number; y: number }[]): number {
  const dp = (p: { x: number; y: number }, ring: { x: number; y: number }[]) => {
    let best = Infinity;
    for (let i = 0; i < ring.length; i++) {
      const q = ring[i];
      const r = ring[(i + 1) % ring.length];
      const dx = r.x - q.x;
      const dy = r.y - q.y;
      const L = dx * dx + dy * dy;
      let t = L > 1e-12 ? ((p.x - q.x) * dx + (p.y - q.y) * dy) / L : 0;
      t = Math.max(0, Math.min(1, t));
      best = Math.min(best, Math.hypot(p.x - (q.x + dx * t), p.y - (q.y + dy * t)));
    }
    return best;
  };
  let best = Infinity;
  for (const p of a) best = Math.min(best, dp(p, b));
  for (const p of b) best = Math.min(best, dp(p, a));
  return best * 7;
}

/** 精确非法重叠：只算非 overlay 面（overlay 本来就允许压在别的东西上） */
function illegalOverlap(bundle: ReturnType<typeof buildPlannerBundle>, key: string): number {
  const feats = bundle.byParcel.get(key);
  if (!feats) return 0;
  const list = feats.surfaces.filter((s) => s.group.startsWith('lot/') && s.role !== 'overlay');
  let sum = 0;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      try {
        const inter = surfaceIntersect(
          [{ outer: list[i].ring, holes: list[i].holes ?? [] }],
          [{ outer: list[j].ring, holes: list[j].holes ?? [] }]
        ).reduce((a, p) => a + surfaceArea(p), 0) * 49;
        if (inter > 5) sum += inter;
      } catch {
        /* 布尔失败跳过 */
      }
    }
  }
  return sum;
}

function pavementsOf(bundle: ReturnType<typeof buildPlannerBundle>, key: string): Pavement | null {
  const feats = bundle.byParcel.get(key);
  if (!feats) return null;
  const roads = feats.surfaces.filter((s) => /_road_\d+_(surf|pad)/.test(s.name));
  const lanes = feats.surfaces.filter((s) => s.group.startsWith('lot/') && /^sk|_lane_|driveway/i.test(s.name));
  // 骨架车道在 Scene 里是 lot/ 组下的 driveway 面，名字由 realizeGround 给；
  // 用材质 concrete + 面尺寸判不稳，所以直接从 bundle 的 candidate 里取不到 ——
  // 改用"所有 lot/ 组里 concrete 材质的长条面"，这里只做面积统计（见下）。
  const blds = feats.solids.map((s) => s.ring);
  // 只算**车行沥青**：店前人行带贴着店面是正常的，不能算"路贴着建筑走"
  let hugging = 0;
  for (const r of roads) {
    if (r.mat !== 'asphalt') continue;
    const near = blds.some((b) => dRing(r.ring, b) < 2.5);
    if (near) hugging += m2(r);
  }
  const hardPrograms = new Set(['asphalt', 'concrete', 'stonePave', 'paver', 'curb', 'gravel', 'asphaltLot']);
  const hardM2 = feats.surfaces
    .filter((s) => s.group.startsWith('lot/') && hardPrograms.has(s.mat))
    .reduce((a, s) => a + m2(s), 0);
  return {
    roadPieces: roads.length,
    roadM2: roads.reduce((a, s) => a + m2(s), 0),
    laneM2: lanes.reduce((a, s) => a + m2(s), 0),
    huggingM2: hugging,
    hardM2,
  };
}

// ---------------------------------------------------------------- 主流程

const bundles = {
  legacy: buildPlannerBundle(m, net, 'planner', { circulation: 'all', s1: 'off' }),
  s1: buildPlannerBundle(m, net, 'planner', { circulation: 'all', s1: 'golden' }),
};

function winnerOf(ctx: ReturnType<typeof siteContextFromModel>, s1: 'off' | 'golden'): SitePlanCandidate | null {
  const cands = generateCandidates(ctx, { s1 });
  return cands.length ? cands.reduce((a, b) => ((b.score ?? 0) > (a.score ?? 0) ? b : a)) : null;
}

console.log(`\n═══ S1 场地布局骨架 · 三块 Golden 对比 · seed ${SEED} ═══`);

const summary: string[] = [];
for (const g of GOLDEN) {
  const patch = m.patches.find((x) => patchKey(x) === g.key)!;
  const ctx = siteContextFromModel(m, patch, { net });
  const leg = winnerOf(ctx, 'off');
  const s1 = winnerOf(ctx, 'golden');
  const legPV = pavementsOf(bundles.legacy, g.key);
  const s1PV = pavementsOf(bundles.s1, g.key);

  console.log(`\n──────── ${g.label}  ${g.key}  (${ctx.typology})`);
  if (!leg) { console.log('  原版：无候选'); continue; }
  if (!s1) { console.log('  原版：', leg.id, '｜ S1：**没有产出候选**（应回落原版）'); continue; }

  const mLeg = s1Metrics(ctx, leg);
  const mS1 = s1Metrics(ctx, s1);

  const row = (label: string, a: string, b: string, better?: 'up' | 'down') => {
    const tag = better === undefined ? '' : a === b ? '  ' : '';
    console.log(`  ${label.padEnd(18)} ${a.padStart(12)} → ${b.padStart(12)} ${tag}`);
  };

  console.log(`  选中方案           ${leg.id.padStart(12)} → ${s1.id.padStart(12)}`);
  row('评分', f1(leg.score ?? 0, 2), f1(s1.score ?? 0, 2));
  row('建筑栋数', String(leg.buildings.length), String(s1.buildings.length));
  row('建筑基底 m²', f1(mLeg.buildingM2, 0), f1(mS1.buildingM2, 0));
  row('覆盖率', pct(mLeg.coverage), pct(mS1.coverage));
  row('建筑-道路间距 m', f1(mLeg.clearanceM), f1(mS1.clearanceM));
  row('门→车道 m', f1(mLeg.gateToLaneM), f1(mS1.gateToLaneM));
  row('地块内路面 m²', f1(legPV?.roadM2 ?? 0, 0), f1(s1PV?.roadM2 ?? 0, 0));
  row('路面片数', String(legPV?.roadPieces ?? 0), String(s1PV?.roadPieces ?? 0));
  row('贴墙铺装 m²', f1(legPV?.huggingM2 ?? 0, 0), f1(s1PV?.huggingM2 ?? 0, 0));
  row('硬质铺装合计 m²', f1(legPV?.hardM2 ?? 0, 0), f1(s1PV?.hardM2 ?? 0, 0));
  row('绿地最大块占比', pct(mLeg.greenContinuity), pct(mS1.greenContinuity));
  row('空间碎片率', pct(mLeg.fragmentRate), pct(mS1.fragmentRate));
  row('候选内地面叠放 m²', f1(mLeg.conflictM2, 1), f1(mS1.conflictM2, 1));
  row('SceneIR 非法重叠 m²', f1(illegalOverlap(bundles.legacy, g.key), 1), f1(illegalOverlap(bundles.s1, g.key), 1));

  console.log('  S1 意图：');
  for (const t of s1.notes.slice(1, 5)) console.log(`    · ${t}`);
  if (!mS1.hard.ok) console.log(`  ⚠ S1 硬约束未过：${mS1.hard.failures.join(' | ')}`);

  summary.push(
    `${g.label}: 覆盖率 ${pct(mLeg.coverage)}→${pct(mS1.coverage)}` +
      ` · 间距 ${f1(mLeg.clearanceM)}→${f1(mS1.clearanceM)} m` +
      ` · 贴墙铺装 ${f1(legPV?.huggingM2 ?? 0, 0)}→${f1(s1PV?.huggingM2 ?? 0, 0)} m²` +
      ` · 路面片 ${legPV?.roadPieces ?? 0}→${s1PV?.roadPieces ?? 0}`
  );
}

console.log('\n──────── 摘要');
for (const s of summary) console.log('  ' + s);
console.log('');
