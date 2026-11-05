// S1 审计 · 三个 Golden 的**空间决策顺序**与现状数字
//
// 用法：npx tsx test/s1-audit.ts
//
// 这份脚本不评估好坏，只回答"现在的布局是怎么决定的"：
//   ① 建筑位置由谁决定（archetype 里的哪几行常量）
//   ② 地面分区的碎片率、覆盖率
//   ③ 内部路是怎么来的（archetype 手画 or solver 补丁）
//   ④ 道路与建筑的关系（贴墙率 / 绕行系数）
//
// 数字都是同一个 seed、同一个地块，改之前跑一次、改之后跑一次。

import { Model } from '../src/town/model';
import { buildRoadNet } from '../src/road/system';
import { buildPlannerBundle } from '../src/scene/planner-bridge';
import { surface, surfaceArea, surfaceIntersect } from '../src/town/planning/core/surface';
import { patchKey } from '../src/town/patch';
import { Pt } from '../src/core/geom';

const SEED = 682063530;
const GOLDEN: { key: string; label: string }[] = [
  { key: '-469:284', label: 'MF' },
  { key: '176:176', label: 'retail' },
  { key: '252:-578', label: 'industrial' },
];

const m = new Model({ nPatches: 15, seed: SEED, plaza: true });
m.generate();
const net = buildRoadNet(m);
const b = buildPlannerBundle(m, net, 'planner', { circulation: 'all' });

const boxOf = (ring: { x: number; y: number }[]) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of ring) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return { x0, y0, x1, y1, w: (x1 - x0) * 7, h: (y1 - y0) * 7 };
};

console.log(`\n═══ S1 规划顺序审计 · seed ${SEED} ═══`);

for (const g of GOLDEN) {
  const p = m.patches.find((x) => patchKey(x) === g.key);
  const rep = b.reports.get(g.key);
  const f = b.byParcel.get(g.key);
  if (!p || !rep || !f) { console.log(`\n${g.label} ${g.key}：未接管`); continue; }

  const lotM2 = surfaceArea(surface(p.shape as unknown as Pt[])) * 49;
  const bb = boxOf(p.shape as unknown as { x: number; y: number }[]);

  // ---- 地面分区
  const byProgram = new Map<string, { n: number; m2: number }>();
  for (const s of f.surfaces) {
    if (!s.group.startsWith('lot/')) continue;
    // 只统计 ground 类（有 program 记在名字里不好认，改用 role 与 mat 之外的信息：
    // 这里用平面数量与面积，program 从 report 拿不到，所以按 mat 归类做参考）
    const k = s.mat;
    const e = byProgram.get(k) ?? { n: 0, m2: 0 };
    e.n++; e.m2 += surfaceArea({ outer: s.ring, holes: s.holes ?? [] }) * 49;
    byProgram.set(k, e);
  }

  // ---- 建筑
  const blds = f.solids;
  let bA = 0;
  let minGap = Infinity;
  const roads = f.surfaces.filter((s) => /_road_\d+_(surf|pad)/.test(s.name));
  for (const x of blds) bA += surfaceArea({ outer: x.ring, holes: [] }) * 49;

  // ---- 内部路
  const roadM2 = roads.reduce((a, s) => a + surfaceArea({ outer: s.ring, holes: s.holes ?? [] }) * 49, 0);
  const circ = rep.circulation;
  const oldPaths = circ?.keptLegacy ?? 0;
  const newPaths = circ?.paths ?? 0;

  // ---- 路压建筑（模型里应为 0）
  let hit = 0;
  for (const r of roads) for (const x of blds) {
    const inter = surfaceIntersect(
      [{ outer: r.ring, holes: r.holes ?? [] }],
      [{ outer: x.ring, holes: [] }]
    ).reduce((s, q) => s + surfaceArea(q), 0) * 49;
    if (inter > 1) hit += inter;
  }

  // ---- 建筑到最近内部路面的距离（贴墙率）
  const d2ring = (pt: { x: number; y: number }, ring: { x: number; y: number }[]) => {
    let best = Infinity;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], c = ring[(i + 1) % ring.length];
      const dx = c.x - a.x, dy = c.y - a.y;
      const L = dx * dx + dy * dy;
      let t = L > 1e-12 ? ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / L : 0;
      t = Math.max(0, Math.min(1, t));
      best = Math.min(best, Math.hypot(pt.x - (a.x + dx * t), pt.y - (a.y + dy * t)));
    }
    return best * 7;
  };
  for (const x of blds) for (const q of x.ring) for (const r of roads) minGap = Math.min(minGap, d2ring(q, r.ring));

  console.log(`\n── ${g.label} ${g.key} · ${rep.typology}`);
  console.log(`   地块 ${lotM2.toFixed(0)} m² · 外接 ${bb.w.toFixed(0)}×${bb.h.toFixed(0)} m · 评分 ${(rep.score ?? 0).toFixed(2)} · 候选 ${rep.candidateCount ?? 0} 个`);
  console.log(`   建筑 ${blds.length} 栋 · 基底 ${bA.toFixed(0)} m² · 覆盖率 ${((bA / lotM2) * 100).toFixed(1)}%`);
  console.log(`   内部路面 ${roads.length} 块 / ${roadM2.toFixed(0)} m² · 旧手画路 ${oldPaths} 条 · solver 新路 ${newPaths} 条`);
  console.log(`   路压建筑 ${hit.toFixed(1)} m² · 建筑角点离最近路面 最小 ${minGap === Infinity ? '无路' : minGap.toFixed(1) + ' m'}`);
  console.log(`   地面面片按材质：`);
  for (const [k, v] of [...byProgram.entries()].sort((a, c) => c[1].m2 - a[1].m2)) {
    console.log(`     ${k.padEnd(16)} ${String(v.n).padStart(4)} 面 ${v.m2.toFixed(0).padStart(7)} m²`);
  }
  console.log(`   选中的形态：${rep.candidateId} / ${rep.archetype}`);
  if (rep.lowConfidence) console.log('   注意：候选之间差距过小（LOW_SELECTION_CONFIDENCE）');
}

console.log('\n—— 全城口径 ——');
let covers = 0;
for (const [, r] of b.reports) if (r.covered) covers++;
console.log(`Planner 接管 ${covers} 块（城内 ${m.patches.filter((x) => x.withinCity && !x.blocked).length}，patch ${m.patches.length}）`);
console.log('');
