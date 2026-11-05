// R1.5-A · 最终道路面的真实连通性（多边形级，不看中心线）
//
// 用法：npx tsx test/r1-5-a.ts
//
// 为什么不能用中心线验收：`solver` 验的是**中心线**连通，`Realizer` 铺的是
// **多边形**，中间隔着"建筑裁剪 / 去重 / 段端退让"三道工序。中心线通 ≠ 路面能走。
//
// 这里直接对 SceneIR 里的最终路面做图论检查：
//   ① 同一地块的路面多边形按"接触"关系并成连通分量；
//   ② 每个需求入口（门 / 停车口 / 后勤口）脚下有没有路面；
//   ③ 有路面的话，它所在分量是否也碰到了街区出口（= 真的接上城市道路）。
//
// 输出四项，互不替代：中心线连通 / 路面可通行 / 入口没路面 / 有路面但孤立。

import { Model } from '../src/town/model';
import { buildRoadNet } from '../src/road/system';
import { buildPlannerBundle } from '../src/scene/planner-bridge';
import { surfaceArea } from '../src/town/planning/core/surface';
import { Pt } from '../src/core/geom';
import type { SurfaceFeature } from '../src/scene/types';

const SEED = 682063530;
const GOLDEN = ['-469:284', '176:176', '252:-578'];
/**
 * 路面与入口"接触"的判定距离：2.0 m。
 *
 * 不能取 0：入口是**建筑外墙上的一个开口**，3 m 支路的半宽就是 1.5 m，
 * 路面本来就贴不到门框上；实测门到最近路面的距离中位就在 1.8 m 左右。
 * 取 2.0 m = 半宽 1.5 + 0.5 容差，再远就是真的没铺到。
 */
const TOUCH_U = 2.0 / 7;

const m = new Model({ nPatches: 15, seed: SEED, plaza: true });
m.generate();
const net = buildRoadNet(m);
const b = buildPlannerBundle(m, net, 'planner', { circulation: 'all' });

interface Piece {
  name: string;
  ring: Pt[];
  box: { x0: number; y0: number; x1: number; y1: number };
  areaM2: number;
}

const boxOf = (ring: Pt[]) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of ring) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return { x0, y0, x1, y1 };
};
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
const touching = (a: Piece, c: Piece, tol: number): boolean => {
  if (a.box.x1 + tol < c.box.x0 || c.box.x1 + tol < a.box.x0) return false;
  if (a.box.y1 + tol < c.box.y0 || c.box.y1 + tol < a.box.y0) return false;
  for (const p of a.ring) if (distToRing(p, c.ring) <= tol) return true;
  for (const p of c.ring) if (distToRing(p, a.ring) <= tol) return true;
  return false;
};

class DSU {
  p: number[];
  constructor(n: number) { this.p = Array.from({ length: n }, (_, i) => i); }
  find(x: number): number { while (this.p[x] !== x) { this.p[x] = this.p[this.p[x]]; x = this.p[x]; } return x; }
  union(a: number, c: number) { const ra = this.find(a), rc = this.find(c); if (ra !== rc) this.p[ra] = rc; }
}

interface Row {
  key: string; typology: string; od: string;
  pieces: number; comps: number; split: number;
  portals: number; reach: number; noPave: number; cutOff: number;
  byTraffic: Map<string, { n: number; ok: number }>;
}

const KIND_TRAFFIC: Record<string, string> = {
  door: 'pedestrian', 'service-door': 'service', parking: 'vehicle',
};

const rows: Row[] = [];
let tPieces = 0, tComps = 0, tSplit = 0, tPortals = 0, tReach = 0, tNoPave = 0, tCut = 0;
const agg = new Map<string, { n: number; ok: number }>();

for (const [key, rep] of b.reports) {
  if (!rep.covered) continue;
  const c = rep.circulation;
  const d = b.circulationDebug.get(key);
  if (!c || !d) continue;
  const feats = b.byParcel.get(key)!;
  const pieces: Piece[] = feats.surfaces
    .filter((s: SurfaceFeature) => /_road_\d+_(surf|pad)/.test(s.name))
    .map((s: SurfaceFeature) => ({
      name: s.name,
      ring: s.ring as unknown as Pt[],
      box: boxOf(s.ring as unknown as Pt[]),
      areaM2: surfaceArea({ outer: s.ring, holes: s.holes ?? [] }) * 49,
    }))
    .filter((p: Piece) => p.areaM2 > 0.5);

  const dsu = new DSU(pieces.length);
  for (let i = 0; i < pieces.length; i++)
    for (let j = i + 1; j < pieces.length; j++)
      if (touching(pieces[i], pieces[j], 0.02)) dsu.union(i, j);
  const comps = new Set(pieces.map((_, i) => dsu.find(i)));

  // 既有可通行铺装（solver 复用的）也算"脚下有路" —— 否则会把"复用"误判成"没路"
  const adopted = (d.adopted ?? []).map((a) => a.outer as unknown as Pt[]);
  const nearAdopted = (p: Pt) => adopted.some((ring) => distToRing(p, ring) <= TOUCH_U);

  const streetComps = new Set<number>();
  for (const n of d.nodes) {
    if (n.kind !== 'street') continue;
    pieces.forEach((p, i) => { if (distToRing(n.at, p.ring) <= TOUCH_U) streetComps.add(dsu.find(i)); });
  }

  let portals = 0, reach = 0, noPave = 0, cutOff = 0;
  const byTraffic = new Map<string, { n: number; ok: number }>();
  for (const n of d.nodes) {
    const tr = KIND_TRAFFIC[n.kind];
    if (!tr) continue;
    portals++;
    const idx = pieces.findIndex((p) => distToRing(n.at, p.ring) <= TOUCH_U);
    const a = byTraffic.get(tr) ?? { n: 0, ok: 0 };
    a.n++;
    if (idx < 0) noPave++;
    else if (streetComps.has(dsu.find(idx))) { reach++; a.ok++; }
    else cutOff++;
    byTraffic.set(tr, a);
  }

  const split = pieces.filter((p) => /_surf_\d+_\d+$/.test(p.name)).length;
  tPieces += pieces.length; tComps += comps.size; tSplit += split;
  tPortals += portals; tReach += reach; tNoPave += noPave; tCut += cutOff;
  for (const [k, v] of byTraffic) {
    const g = agg.get(k) ?? { n: 0, ok: 0 };
    g.n += v.n; g.ok += v.ok;
    agg.set(k, g);
  }

  rows.push({ key, typology: rep.typology, od: `${c.odConnected}/${c.odTotal}`,
    pieces: pieces.length, comps: comps.size, split,
    portals, reach, noPave, cutOff, byTraffic });
}

const odTotal = [...b.reports.values()].reduce((s, r) => s + (r.circulation?.odTotal ?? 0), 0);
const odConn = [...b.reports.values()].reduce((s, r) => s + (r.circulation?.odConnected ?? 0), 0);

console.log(`\n═══ R1.5-A 最终路面连通性 · seed ${SEED} ═══\n`);
console.log(`① 中心线连通率（OD 解出来没）        ${odConn}/${odTotal} = ${((odConn / Math.max(odTotal, 1)) * 100).toFixed(1)}%`);
console.log(`② 最终路面可通行率（入口→街口连通）  ${tReach}/${tPortals} = ${((tReach / Math.max(tPortals, 1)) * 100).toFixed(1)}%`);
console.log(`③ 入口脚下没有路面                  ${tNoPave} 处`);
console.log(`④ 有路面但没接到街口（被裁断/孤立）  ${tCut} 处`);
console.log(`   路面碎块 ${tPieces} 块 / 连通分量 ${tComps} 个 / 被裁成多块 ${tSplit} 块`);

console.log('\n按交通类型（入口口径）：');
for (const [t, v] of agg) console.log(`  ${t.padEnd(12)} 入口 ${String(v.n).padStart(3)} · 可达 ${String(v.ok).padStart(3)} (${((v.ok / Math.max(v.n, 1)) * 100).toFixed(0)}%)`);

console.log('\n三个 Golden：');
for (const key of GOLDEN) {
  const r = rows.find((x) => x.key === key);
  if (!r) { console.log(`  ${key} 未接管`); continue; }
  const t = [...r.byTraffic.entries()].map(([k, v]) => `${k} ${v.ok}/${v.n}`).join(' · ');
  console.log(`  ${key.padEnd(10)} OD ${r.od} · 面 ${r.pieces}块/${r.comps}分量 · 入口可达 ${r.reach}/${r.portals} · 无路面 ${r.noPave} · 孤立 ${r.cutOff} · ${t}`);
}

console.log('\n有问题的地块：');
const bad = rows.filter((r) => r.cutOff > 0 || r.noPave > 0).sort((a, c) => (c.cutOff + c.noPave) - (a.cutOff + a.noPave));
if (bad.length === 0) console.log('  无');
for (const r of bad.slice(0, 10)) console.log(`  ${r.key.padEnd(10)} ${r.typology.padEnd(12)} 入口 ${r.portals} · 无路面 ${r.noPave} · 孤立 ${r.cutOff} · 面 ${r.pieces}/${r.comps}`);
console.log('');
