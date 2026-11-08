// F3 质量诊断（临时）：把"路网/地块/路口/标线"的问题量化出来
import { Pt } from '../src/core/geom';
import { insideSurface, pointInRing, surfaceArea } from '../src/town/planning/core/surface';
import { cityOutline, runF3City } from '../src/f3';
import { M2 } from '../src/f3/geom';

const r = runF3City({
  boundary: { outer: cityOutline(90, 20261106), holes: [] },
  style: 'structured',
  density: 'medium',
  program: 'mixed',
  seed: 20261106,
});
const g = r.debug.graph;
const road = r.debug.road;

// ① 路网拓扑
const deg1 = [...g.nodes.values()].filter((n) => n.degree === 1);
const deg1Inner = deg1.filter((n) => !n.onBoundary);
const deg3 = [...g.nodes.values()].filter((n) => n.degree >= 3);
console.log(`\n【路网】节点 ${g.nodes.size} · 边 ${g.edges.size} · 路径 ${g.paths.length}`);
console.log(`  度1 端点 ${deg1.length}（其中不在红线上 = ${deg1Inner.length} 根"断头路"）`);
console.log(`  度3+ 交叉 ${deg3.length} · 路口多边形 ${road.junction.length}`);
const arterialPaths = g.paths.filter((p) => p.cls === 'arterial');
const collPaths = g.paths.filter((p) => p.cls === 'collector');
console.log(
  `  主干 ${arterialPaths.length} 段 / ${arterialPaths.reduce((a, p) => a + ptLen(p.pts), 0).toFixed(0)} m · ` +
    `次干 ${collPaths.length} 段 / ${collPaths.reduce((a, p) => a + ptLen(p.pts), 0).toFixed(0)} m`
);
// 主干是否连续：把主干路径首尾相接看能做几条链
console.log(`  主干连成的链数（跨路口的"一条主街"）: ${chains(arterialPaths.map((p) => p.pts))}`);

// ② 街区与红线的关系（有没有被路网围合）
const roadPolys = [...road.carriage, ...road.junction];
const site = r.spec.boundary.outer;
let onRedline = 0;
const sides: number[] = [];
for (const b of r.debug.blocks) {
  if (b.surface.outer.some((v) => distRing(v, site) < 0.05)) onRedline++;
  let n = 0;
  for (const p of g.paths) {
    let near = false;
    for (let i = 0; i < b.surface.outer.length && !near; i++) {
      const a = b.surface.outer[i];
      const c = b.surface.outer[(i + 1) % b.surface.outer.length];
      for (let k = 1; k <= 4 && !near; k++) {
        const q = new Pt(a.x + ((c.x - a.x) * k) / 5, a.y + ((c.y - a.y) * k) / 5);
        if (distPoint(q, p.pts) < p.widthU / 2 + 6.5 / 7) near = true;
      }
    }
    if (near) n++;
  }
  sides.push(n);
}
console.log(`\n【街区】${r.debug.blocks.length} 块`);
console.log(`  靠红线收边（没被路围合）${onRedline} 块 · 围合街道数 中位 ${median(sides)} · ≥3 条 ${sides.filter((x) => x >= 3).length} 块`);

// ③ 路口形状
let sharp = 0;
let tiny = 0;
const jAreas: number[] = [];
for (const j of road.junction) {
  const n = j.outer.length;
  jAreas.push(M2(surfaceArea(j)));
  if (n <= 4) tiny++;
  for (let i = 0; i < n; i++) {
    const a = j.outer[(i - 1 + n) % n];
    const b = j.outer[i];
    const c = j.outer[(i + 1) % n];
    const v1 = Math.atan2(b.y - a.y, b.x - a.x);
    const v2 = Math.atan2(c.y - b.y, c.x - b.x);
    let t = Math.abs(((v2 - v1 + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    t = (Math.PI - t) * (180 / Math.PI);
    if (t < 35) sharp++;
  }
}
console.log(`\n【路口】${road.junction.length} 个 · 面积中位 ${median(jAreas).toFixed(0)} m² · 顶点≤4 的 ${tiny} 个 · 内角<35° 的尖角 ${sharp} 处`);

// ④ 标线是否落在车行面上
let markOut = 0;
for (const m of road.markings) {
  const c = centroid(m.ring);
  if (!road.carriage.some((s) => insideSurface(c, s)) && !road.junction.some((s) => insideSurface(c, s))) markOut++;
}
console.log(`\n【标线】${road.markings.length} 段 · 中心不在路面上 ${markOut} 段（${((markOut / road.markings.length) * 100).toFixed(1)}%）`);

// ⑤ 地块的"临街面宽"分布（决定它像不像沿街地块）
const fronts: number[] = [];
for (const p of r.debug.parcels) {
  const ab = p.surface.outer;
  // 取与最近路同向的那条边当临街边
  let best = 0;
  for (let i = 0; i < ab.length; i++) {
    const a = ab[i];
    const b = ab[(i + 1) % ab.length];
    best = Math.max(best, Pt.distance(a, b) * 7);
  }
  fronts.push(best);
}
console.log(`\n【地块】${r.debug.parcels.length} 块 · 最长边中位 ${median(fronts).toFixed(0)} m · 10% 分位 ${quant(fronts, 0.1).toFixed(0)} m · 90% 分位 ${quant(fronts, 0.9).toFixed(0)} m`);

// ⑥ 停车是否接得到路
let islanded = 0;
let lots = 0;
for (const s of r.scene.surfaces.filter((x) => x.mat === 'asphaltLot')) {
  lots++;
  const c = centroid(s.ring);
  let d = Infinity;
  for (const p of roadPolys) d = Math.min(d, distToSurface(c, p));
  if (d > 0.5) islanded++;
}
console.log(`【停车】${lots} 片 · 与车行面不相接（没有任何进出车道）的 ${islanded} 片`);

function ptLen(pts: Pt[]): number {
  let s = 0;
  for (let i = 0; i + 1 < pts.length; i++) s += Pt.distance(pts[i], pts[i + 1]) * 7;
  return s;
}

function distRing(p: Pt, ring: Pt[]): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    let t = l2 < 1e-12 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)));
  }
  return best;
}

function distPoint(p: Pt, pts: Pt[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    let t = l2 < 1e-12 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)));
  }
  return best;
}

function distToSurface(p: Pt, s: { outer: Pt[] }): number {
  let best = Infinity;
  for (let i = 0; i < s.outer.length; i++) {
    const a = s.outer[i];
    const b = s.outer[(i + 1) % s.outer.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    let t = l2 < 1e-12 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)));
  }
  return best;
}

function centroid(ring: Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p.x;
    y += p.y;
  }
  return new Pt(x / ring.length, y / ring.length);
}

function median(a: number[]): number {
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)] ?? 0;
}

function quant(a: number[], q: number): number {
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))] ?? 0;
}

void pointInRing;

/** 把"各自的路径"按端点相接并成链，返回链数 */
function chains(lines: Pt[][]): number {
  const key = (p: Pt): string => `${Math.round(p.x * 20)},${Math.round(p.y * 20)}`;
  const ends = lines.map((l) => [key(l[0]), key(l[l.length - 1])]);
  const parent = lines.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (let i = 0; i < ends.length; i++) {
    for (let j = i + 1; j < ends.length; j++) {
      if (ends[i].some((a) => ends[j].includes(a))) {
        const a = find(i);
        const b = find(j);
        if (a !== b) parent[a] = b;
      }
    }
  }
  return new Set(lines.map((_, i) => find(i))).size;
}
