// F3 尖刺诊断：走真实渲染路径（flatPolygon），找出「跑到多边形外面」的三角形
import { Pt } from '../src/core/geom';
import { pointInRing, surfaceArea, type PlanSurface } from '../src/town/planning/core/surface';
import { cityOutline, runF3City } from '../src/f3';
import { M2 } from '../src/f3/geom';
import { flatPolygon } from '../src/export/mesh';

const r = runF3City({
  boundary: { outer: cityOutline(95, 20261106), holes: [] },
  style: 'structured',
  density: 'medium',
  program: 'mixed',
  seed: 20261106,
});
const road = r.debug.road;

const layers: Record<string, PlanSurface[]> = {
  carriage: road.carriage,
  junction: road.junction,
  curb: road.curb,
  sidewalk: road.sidewalk,
  verge: road.verge,
  apron: road.apron,
  domain: road.domain,
};

interface Bad {
  layer: string;
  kind: 'outside' | 'sliver';
  areaM2: number;
  ratio: number;
  at: Pt;
}
const bad: Bad[] = [];
let missing = 0;
let missingA = 0;

for (const [name, list] of Object.entries(layers)) {
  for (const s of list) {
    const prim = flatPolygon(s.outer, 0, 'x', 'x', [1, 1, 1], s.holes);
    if (!prim) {
      missing++;
      missingA += M2(surfaceArea(s));
      continue;
    }
    const P = prim.positions;
    let triA = 0;
    for (let i = 0; i < prim.indices.length; i += 3) {
      const ia = prim.indices[i] * 3;
      const ib = prim.indices[i + 1] * 3;
      const ic = prim.indices[i + 2] * 3;
      const ax = P[ia], ay = P[ia + 2];
      const bx = P[ib], by = P[ib + 2];
      const cx = P[ic], cy = P[ic + 2];
      const area2 = Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay));
      triA += area2 / 2;
      const p = new Pt((ax + bx + cx) / 3, (ay + by + cy) / 3);
      const inside = pointInRing(p, s.outer) && !s.holes.some((h) => pointInRing(p, h));
      const longest = Math.max(Math.hypot(bx - ax, by - ay), Math.hypot(cx - bx, cy - by), Math.hypot(ax - cx, ay - cy));
      const ratio = area2 > 1e-12 ? (longest * longest) / area2 : 1e9;
      if (!inside) bad.push({ layer: name, kind: 'outside', areaM2: M2(area2 / 2), ratio, at: p });
      else if (ratio > 30 && M2(area2 / 2) > 0.3) bad.push({ layer: name, kind: 'sliver', areaM2: M2(area2 / 2), ratio, at: p });
    }
    const polyA = Math.abs(surfaceArea(s));
    if (polyA - triA > 1) {
      missing++;
      missingA += M2(polyA - triA);
      if (M2(polyA - triA) > 30)
        console.log(`[缺面] ${name} ${M2(polyA).toFixed(1)} vs ${M2(triA).toFixed(1)} m² @${s.outer[0].x.toFixed(2)},${s.outer[0].y.toFixed(2)} 洞 ${s.holes.length}`);
    }
  }
}

const byLayer: Record<string, { outside: number; sliver: number; outsideA: number }> = {};
for (const b of bad) {
  const e = (byLayer[b.layer] ??= { outside: 0, sliver: 0, outsideA: 0 });
  if (b.kind === 'outside') {
    e.outside++;
    e.outsideA += b.areaM2;
  } else e.sliver++;
}
console.log('\n=== 三角化越界 / 细长统计（flatPolygon 真实路径） ===');
for (const [k, v] of Object.entries(byLayer))
  console.log(`${k.padEnd(10)} 越界 ${String(v.outside).padStart(4)} 个 / ${v.outsideA.toFixed(1)} m²   细长 ${String(v.sliver).padStart(5)} 个`);
console.log(`未出三角形 / 缺面 ${missing} 片，缺 ${missingA.toFixed(1)} m²`);

const top = bad.filter((b) => b.kind === 'outside').sort((a, b) => b.areaM2 - a.areaM2).slice(0, 12);
console.log('\n最大越界三角形:');
for (const b of top) console.log(`  ${b.layer} ${b.areaM2.toFixed(3)} m² ratio ${b.ratio.toFixed(0)} @ (${b.at.x.toFixed(2)}, ${b.at.y.toFixed(2)})`);
