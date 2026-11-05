// R1.5-B · 停车场内部交通的可达性核查
//
// 用法：npx tsx test/r1-5-b.ts
//
// 复用现有 Parking Solver 的 `ParkLayout.aisles`，只**核查**拓扑，不改布局：
//   ① 每个停车场有几块 aisle、并成几个连通分量（通道自己是不是连成一片）
//   ② 车行 Portal 到最近通道的距离（Portal 有没有真的接上通道）
//   ③ 车位前缘（fronts）是否贴着已连通的通道（车位能不能开出来）
//
// 不把"停车场边界上的任意一点"当成合法车行入口：只用 R1 的 parking Portal 判定。

import { Model } from '../src/town/model';
import { buildRoadNet } from '../src/road/system';
import { patchKey } from '../src/town/patch';
import { siteContextFromModel } from '../src/town/planning/adapters/model';
import { generateCandidates } from '../src/town/planning/generators';
import { selectBestCandidate } from '../src/town/shadow/runner';
import { solveParking, CAR_STALL } from '../src/town/parking';
import { buildPlannerBundle } from '../src/scene/planner-bridge';
import { Pt } from '../src/core/geom';

const SEED = 682063530;
const m = new Model({ nPatches: 15, seed: SEED, plaza: true });
m.generate();
const net = buildRoadNet(m);
const bundle = buildPlannerBundle(m, net, 'planner', { circulation: 'all' });

const distToRing = (p: Pt, ring: Pt[]): number => {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], c = ring[(i + 1) % ring.length];
    const dx = c.x - a.x, dy = c.y - a.y;
    const L = dx * dx + dy * dy;
    let t = L > 1e-12 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / L : 0;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)));
  }
  return best;
};
const touch = (a: Pt[], b: Pt[]) => a.some((p) => distToRing(p, b) <= 0.02) || b.some((p) => distToRing(p, a) <= 0.02);

console.log(`\n═══ R1.5-B 停车场内部交通 · seed ${SEED} ═══\n`);
console.log('地块        车位  aisle 分量  最大分量占比  Portal→通道  结论');

let lots = 0, aisleOk = 0, portalOk = 0, frontOk = 0, totalFront = 0;
for (const p of m.patches) {
  if (p.blocked || !p.withinCity) continue;
  const ctx = siteContextFromModel(m, p, { net });
  const cands = generateCandidates(ctx);
  if (!cands.length) continue;
  const cand = selectBestCandidate(cands).winner;
  if (cand.parkingRequests.length === 0) continue;

  for (const [ri, pr] of cand.parkingRequests.entries()) {
    const lay = solveParking(Array.from(pr.region.outer), {
      angles: [0, Math.PI / 2],
    });
    if (!lay) continue;
    lots++;

    // ① 通道连通分量
    const n = lay.aisles.length;
    const dsu = Array.from({ length: n }, (_, i) => i);
    const find = (x: number): number => (dsu[x] === x ? x : (dsu[x] = find(dsu[x])));
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (touch(lay.aisles[i], lay.aisles[j])) dsu[find(i)] = find(j);
    const comps = new Set(Array.from({ length: n }, (_, i) => find(i)));
    const areas = new Map<number, number>();
    for (let i = 0; i < n; i++) areas.set(find(i), (areas.get(find(i)) ?? 0) + 1);
    const biggest = Math.max(0, ...areas.values()) / Math.max(n, 1);

    // ② Portal → 最近通道
    // **必须用 R1 的停车 Portal**，不是场地车行入口 —— 后者离车位排几十米是正常的
    // （要先进场地、再过装卸区）。两者混用会把"合理"判成"没接上"。
    const dbg = bundle.circulationDebug.get(patchKey(p));
    const parkNode = dbg?.nodes.find((n) => n.kind === 'parking');
    const portal = parkNode ? { at: parkNode.at } : null;
    const dMin = portal ? Math.min(...lay.aisles.map((a) => distToRing(portal.at, a))) * 7 : Infinity;
    // 横向缝（walks，2.6 m 硬地）是车位排之间的连接 —— 只算 aisles 会天然分裂
    const linkPolys = [...lay.aisles, ...lay.walks];
    const ln = linkPolys.length;
    const ldsu = Array.from({ length: ln }, (_, i) => i);
    const lfind = (x: number): number => (ldsu[x] === x ? x : (ldsu[x] = lfind(ldsu[x])));
    for (let i = 0; i < ln; i++) for (let j = i + 1; j < ln; j++) if (touch(linkPolys[i], linkPolys[j])) ldsu[lfind(i)] = lfind(j);
    const linkComps = new Set(Array.from({ length: ln }, (_, i) => lfind(i)));

    // ③ 车位前缘贴不贴已连通的通道
    let frontsOk = 0;
    for (const f of lay.fronts) {
      const mid = new Pt((f[0].x + f[1].x) / 2, (f[0].y + f[1].y) / 2);
      const near = lay.aisles.some((a) => distToRing(mid, a) * 7 <= 1.2);
      if (near) frontsOk++;
    }
    totalFront += lay.fronts.length;
    frontOk += frontsOk;

    const okAisle = comps.size === 1 || biggest >= 0.8;
    const okLinked = linkComps.size === 1;
    const okPortal = dMin <= 3;
    if (okAisle) aisleOk++;
    if (okPortal) portalOk++;
    if (ri === 0) {
      console.log(
        `${patchKey(p).padEnd(10)} ${String(lay.count).padStart(4)} ${String(n).padStart(6)} ${String(comps.size).padStart(5)} ` +
        `${(biggest * 100).toFixed(0).padStart(9)}% ${(dMin === Infinity ? '无' : dMin.toFixed(1) + 'm').padStart(9)}  ` +
        `${okAisle ? '通道连通' : '通道分裂'} · 含横缝 ${linkComps.size} 分量${okPortal ? ' · Portal 接上' : ' · Portal 没接上'}`
      );
    }
  }
}

console.log(`\n停车场 ${lots} 个`);
console.log(`通道连通（单分量或主分量≥80%） ${aisleOk}/${lots} = ${((aisleOk / Math.max(lots, 1)) * 100).toFixed(0)}%`);
console.log(`车行 Portal 接上通道（≤3 m）    ${portalOk}/${lots} = ${((portalOk / Math.max(lots, 1)) * 100).toFixed(0)}%`);
console.log(`车位前缘贴通道                   ${frontOk}/${totalFront} 条前缘线`);
console.log(`\n注：车位"逐位可达"没有做 —— 需要把 aisle 图与每个车位的开口做图搜索，`);
console.log(`    目前只证明"车位排的前缘贴着已连通的通道"，这是必要条件，不是充分条件。`);
console.log(`    CAR_STALL = ${CAR_STALL.w * 7}m × ${CAR_STALL.l * 7}m，通道 ${CAR_STALL.aisle * 7}m`);
console.log('');
