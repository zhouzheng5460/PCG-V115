// S2.5 · 停车请求归因诊断
//
// 用法：npx tsx test/s2-5-diag.ts [--mode=s1|legacy]
//
// 目的：回答"31 个停车请求里只有 6 个用上 Placemaker，剩下的卡在哪一步"。
// 逐条归因，七类互斥：
//
//   1 区域太小          —— 面积低于「单排最小可用」（不是 440 那种魔数，见下方推导）
//   2 形状不适合        —— 最窄方向放不下「双面排」所需的进深
//   3 C# 返回 0 位      —— Core 跑了但没排出车位（ready 可能是 true）
//   4 烘焙未命中        —— 几何指纹不在表里（换了候选 / 改了障碍规则 / 没烘）
//   5 拓扑验收失败      —— 有车位但车道不连通或车位前缘不贴车道
//   6 联合评分选了别人  —— 命中且合格，但最终候选的停车不是它（同地块另一方案胜出）
//   7 小停车区，legacy 更合适
//
// 关键：**面积阈值从参数推导，不是抄 440**。
//   车位 2.52 × 5.04 m，车道 6.3 m。
//   双面排进深 = 5.04×2 + 6.3 = 16.38 m；单面排进深 = 5.04 + 6.3 = 11.34 m。
//   Placemaker 需要至少一个「转弯/回车」空间，实测单面排最小可用约 15×12 m ≈ 180 m²。

import { Model } from '../src/town/model';
import { buildRoadNet } from '../src/road/system';
import { patchKey } from '../src/town/patch';
import { siteContextFromModel } from '../src/town/planning/adapters/model';
import { generateCandidates } from '../src/town/planning/generators';
import { selectBestCandidate } from '../src/town/shadow/runner';
import { buildPlannerBundle } from '../src/scene/planner-bridge';
import { surfaceSubtract, surfaceArea, type PlanSurface } from '../src/town/planning/core/surface';
import { parkingObstaclesOf } from '../src/town/realize/parking';
import { lookupBaked, lookupBakedMiss, bakedKey } from '../src/town/parking/provider';
import { Pt } from '../src/core/geom';
import type { S1Mode, PatternMode } from '../src/town/planning/skeleton';

const U = (m: number) => m / 7;
const SEED = 682063530;

// ---- 从参数推导的阈值（每轮随车位/车道尺寸自动跟着变）
const STALL_W = 2.52;
const STALL_L = 5.04;
const AISLE = 6.3;
const DEPTH_DOUBLE = STALL_L * 2 + AISLE; // 16.38
const DEPTH_SINGLE = STALL_L + AISLE; // 11.34
/** 单排最小可用：够 4 个位（≈10 m 长）+ 端头转弯（≈5 m） */
const MIN_SINGLE_AREA = (4 * STALL_W + 6) * (DEPTH_SINGLE + 3); // ≈ 236 m²
/** 双排最小可用 */
const MIN_DOUBLE_AREA = (4 * STALL_W + 6) * (DEPTH_DOUBLE + 3); // ≈ 313 m²

const mode = process.argv.includes('--mode=legacy') ? 'legacy' : 's1';
const S1: S1Mode = mode === 's1' ? 'all' : 'off';
const PT: PatternMode = mode === 's1' ? 'all' : 'off';

/** 凸包（单调链） */
function hull(pts: Pt[]): Pt[] {
  const p = pts.slice().sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  if (p.length <= 2) return p;
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Pt[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** 最小宽度（旋转卡尺，米）：最窄方向上多边形能延伸多宽 */
function minWidthM(ring: { x: number; y: number }[]): number {
  const h = hull(ring as Pt[]);
  if (h.length < 3) return 0;
  let best = Infinity;
  for (let i = 0; i < h.length; i++) {
    const a = h[i];
    const b = h[(i + 1) % h.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L = Math.hypot(dx, dy) || 1;
    const nx = -dy / L;
    const ny = dx / L;
    let lo = Infinity;
    let hi = -Infinity;
    for (const q of h) {
      const d = q.x * nx + q.y * ny;
      lo = Math.min(lo, d);
      hi = Math.max(hi, d);
    }
    best = Math.min(best, (hi - lo) * 7);
  }
  return best;
}

/** 最长边 / bbox 面积（形状描述） */
function shapeOf(ring: { x: number; y: number }[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  let maxEdge = 0;
  for (let i = 0; i < ring.length; i++) {
    const q = ring[i];
    const r = ring[(i + 1) % ring.length];
    x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x);
    y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y);
    maxEdge = Math.max(maxEdge, Math.hypot(r.x - q.x, r.y - q.y));
  }
  return { bw: (x1 - x0) * 7, bh: (y1 - y0) * 7, maxEdgeM: maxEdge * 7, verts: ring.length };
}

interface Row {
  parcel: string;
  typology: string;
  cand: string;
  pattern: string;
  req: number;
  areaM2: number;
  usableM2: number;
  minW: number;
  verts: number;
  hole: boolean;
  baked: boolean;
  pmStalls: number;
  pmComps: number;
  pmFront: number;
  applied: boolean;
  reason: string;
}

const m = new Model({ nPatches: 15, seed: SEED, plaza: true });
m.generate();
const net = buildRoadNet(m);
const bundle = buildPlannerBundle(m, net, 'planner', { circulation: 'all', s1: S1, pattern: PT, parkingProvider: 'placemaker' });

const rows: Row[] = [];
const cityKeys = m.patches.filter((p) => p.withinCity && !p.blocked).map((p) => patchKey(p));

for (const key of cityKeys) {
  const patch = m.patches.find((x) => patchKey(x) === key);
  if (!patch) continue;
  const ctx = siteContextFromModel(m, patch, { net });
  const cands = generateCandidates(ctx, { s1: S1, pattern: PT });
  if (!cands.length) continue;
  const best = selectBestCandidate(cands);
  const cand = best.winner;
  if (!cand || cand.parkingRequests.length === 0) continue;
  const rep = bundle.reports.get(key);
  const appliedProviders = rep?.parking?.providers ?? [];

  for (const [i, req] of cand.parkingRequests.entries()) {
    const ring = req.region.outer as unknown as Pt[];
    const areaM2 = surfaceArea(req.region) * 49;
    const obs = parkingObstaclesOf(cand);
    const parts = surfaceSubtract([req.region], obs).filter((p) => surfaceArea(p) > U(4) * U(4));
    const usable: PlanSurface | null = parts.length
      ? parts.reduce((a, b) => (surfaceArea(a) >= surfaceArea(b) ? a : b))
      : null;
    const usableM2 = usable ? surfaceArea(usable) * 49 : 0;
    const w = usable ? minWidthM(usable.outer as unknown as Pt[]) : 0;
    const sh = shapeOf((usable ?? req.region).outer as unknown as Pt[]);
    const hole = (req.region.holes ?? []).length > 0;
    const baked = usable ? lookupBaked(usable.outer) : null;
    const emptyWhy = usable ? lookupBakedMiss(usable.outer) : null;
    const applied = appliedProviders.includes('placemaker');

    let reason: string;
    if (!usable || usableM2 < MIN_SINGLE_AREA) reason = '1 区域太小';
    else if (w < DEPTH_SINGLE) reason = '2 形状不适合';
    else if (emptyWhy) reason = '3 C# 返回 0 位';
    else if (!baked) {
      reason = usableM2 < MIN_DOUBLE_AREA ? '7 小停车区（legacy 更合适）' : '4 烘焙未命中';
    }
    else if (baked.diag.aisleComponents > 1 || baked.diag.stallFrontRate < 0.9) reason = '5 拓扑验收失败';
    else if (baked.diag.legacyStalls > 0 && baked.count < baked.diag.legacyStalls * 0.85) {
      // 烘焙成功、拓扑也合格，但同区域它比 legacy 少排 15% 以上 —— 运行时闸门会退回 legacy
      reason = '8 PM 车位更少（合法回退）';
    } else if (!applied) reason = '6 联合评分选了别人';
    else reason = '✓ 采用 Placemaker';

    rows.push({
      parcel: key,
      typology: cand.typology ?? ctx.typology,
      cand: cand.id,
      pattern: (cand as unknown as { patternId?: string }).patternId ?? '-',
      req: i,
      areaM2,
      usableM2,
      minW: w,
      verts: sh.verts,
      hole,
      baked: !!baked,
      pmStalls: baked?.diag.stalls ?? -1,
      pmComps: baked?.diag.aisleComponents ?? -1,
      pmFront: baked?.diag.stallFrontRate ?? -1,
      applied,
      reason,
    });
  }
}

const f1 = (x: number) => x.toFixed(0).padStart(6);
console.log(`\n═══ S2.5 停车请求归因 · seed ${SEED} · s1=${S1} pattern=${PT} ═══`);
console.log(`阈值（从尺寸推导）：单面排 ${DEPTH_SINGLE.toFixed(1)} m 深 / 双面排 ${DEPTH_DOUBLE.toFixed(1)} m 深`);
console.log(`                      单排最小 ${MIN_SINGLE_AREA.toFixed(0)} m² / 双排最小 ${MIN_DOUBLE_AREA.toFixed(0)} m²\n`);

console.log('地块        用地       请求 区域m² 可用m² 最窄m 顶点 洞 烘焙 车位 分量 前缘 采用 归因');
for (const r of rows) {
  console.log(
    r.parcel.padEnd(11) +
      r.typology.padEnd(12) +
      String(r.req).padStart(3) +
      f1(r.areaM2) + f1(r.usableM2) +
      r.minW.toFixed(1).padStart(7) +
      String(r.verts).padStart(4) +
      (r.hole ? ' 有' : '  ·') +
      (r.baked ? '  ✓ ' : '  ✗ ') +
      String(r.pmStalls).padStart(5) +
      String(r.pmComps).padStart(5) +
      (r.pmFront < 0 ? '   -' : `${(r.pmFront * 100).toFixed(0)}%`.padStart(4)) +
      (r.applied ? '  ✓ ' : '  · ') +
      ' ' + r.reason
  );
}

const byReason = new Map<string, number>();
for (const r of rows) byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);
console.log(`\n合计 ${rows.length} 个停车请求：`);
for (const [k, v] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(26)} ${String(v).padStart(3)}  ${((v / rows.length) * 100).toFixed(0)}%`);
}

const small = rows.filter((r) => r.reason.startsWith('7')).length;
const tooSmall = rows.filter((r) => r.reason.startsWith('1')).length;
const wrongShape = rows.filter((r) => r.reason.startsWith('2')).length;
const miss = rows.filter((r) => r.reason.startsWith('4')).length;
const used = rows.filter((r) => r.applied).length;
console.log(`\n采用率 ${used}/${rows.length} = ${((used / Math.max(rows.length, 1)) * 100).toFixed(0)}%`);
console.log(`其中「面积/形状本来就不适合」 ${tooSmall + wrongShape + small} 个 = ${(((tooSmall + wrongShape + small) / rows.length) * 100).toFixed(0)}%（不该算失败）`);
console.log(`「烘焙未命中」 ${miss} 个（可修）`);
console.log(`Placemaker 烘焙表条目 ${(await import('../src/town/parking/provider')).BAKED_META.entries} 条`);

// 按停车区规模分组 —— "全城采用率"这个单一数字没有意义：
// Placemaker 在大块地上优势明显，在小而紧凑的场地上反而不如 legacy 密排。
const buckets: { label: string; lo: number; hi: number }[] = [
  { label: '<600 m²', lo: 0, hi: 600 },
  { label: '600~1200 m²', lo: 600, hi: 1200 },
  { label: '1200~2000 m²', lo: 1200, hi: 2000 },
  { label: '≥2000 m²', lo: 2000, hi: 1e9 },
];
console.log('\n按停车区规模分组：');
for (const b of buckets) {
  const inB = rows.filter((r) => r.usableM2 >= b.lo && r.usableM2 < b.hi);
  if (!inB.length) continue;
  const used2 = inB.filter((r) => r.applied).length;
  console.log(`  ${b.label.padEnd(14)} ${String(used2).padStart(3)}/${String(inB.length).padStart(3)} = ${((used2 / inB.length) * 100).toFixed(0)}%`);
}
void bakedKey;
