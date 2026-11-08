// 局部放大出图：把某个路口周围 160 m 的画出来，用来看标线 / 圆角 / 人行道
import { mkdirSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { Pt } from '../src/core/geom';
import type { PlanSurface } from '../src/town/planning/core/surface';
import { cityOutline, runF3City } from '../src/f3';

const args = process.argv.slice(2);
const cx = Number(args[0] ?? 0);
const cy = Number(args[1] ?? 0);
const halfM = Number(args[2] ?? 80);

const r = runF3City({
  boundary: { outer: cityOutline(95, 20261106), holes: [] },
  style: 'structured',
  density: 'medium',
  program: 'mixed',
  seed: 20261106,
});
const road = r.debug.road;
const scene = r.scene;

const U = (m: number): number => m / 7;
const H = U(halfM);
const x0 = cx - H;
const y0 = cy - H;
const W = H * 2;

const pathOf = (ring: Pt[], holes: Pt[][] = []): string => {
  const p = (q: Pt): string => `${(q.x - x0).toFixed(3)},${(q.y - y0).toFixed(3)}`;
  const main = `M${ring.map(p).join('L')}Z`;
  const hs = holes.map((h) => `M${h.map(p).join('L')}Z`).join('');
  return main + hs;
};

const layers: { list: PlanSurface[]; fill: string; stroke?: string }[] = [
  { list: road.sidewalk, fill: '#efe8d8', stroke: '#a89e88' },
  { list: road.curb, fill: '#b9b2a1' },
  { list: road.carriage, fill: '#33373d' },
  { list: road.junction, fill: '#3a3e45' },
  { list: road.verge, fill: '#6d8a53' },
];

const parts: string[] = [];
parts.push(`<rect x="0" y="0" width="${W}" height="${W}" fill="#b9b3a3"/>`);
// 街区块（路网面之外）
parts.push(`<path d="${pathOf(road.domain[0]?.outer ?? [], road.domain.flatMap((s) => s.holes))}" fill="none"/>`);
for (const L of layers) {
  for (const s of L.list) {
    parts.push(`<path d="${pathOf(s.outer, s.holes)}" fill="${L.fill}" ${L.stroke ? `stroke="${L.stroke}" stroke-width="0.04"` : ''} fill-rule="evenodd"/>`);
  }
}
for (const m of road.markings) {
  parts.push(`<path d="${pathOf(m.ring)}" fill="${m.yellow ? '#e9c34d' : '#f4f4f0'}" fill-rule="evenodd"/>`);
}
// 路口中心 / 过街点
for (const c of road.crossings) parts.push(`<circle cx="${(c.x - x0).toFixed(2)}" cy="${(c.y - y0).toFixed(2)}" r="0.25" fill="#ff3b30"/>`);
void scene;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${halfM * 2 * 16}" height="${halfM * 2 * 16}" viewBox="0 0 ${W} ${W}">
<g transform="translate(0,${W}) scale(1,-1)">${parts.join('')}</g></svg>`;

mkdirSync('out', { recursive: true });
const base = `out/zoom_${Math.round(cx)}_${Math.round(cy)}`;
writeFileSync(`${base}.svg`, svg);
await sharp(Buffer.from(svg)).png().toFile(`${base}.png`);
console.log('ok', `${base}.png`, `窗口 ${halfM * 2} m`);
console.log('crossings', road.crossings.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).slice(0, 8).join(' '));
