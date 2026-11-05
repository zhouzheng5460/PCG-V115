// S2.6 · 停车场地面语义诊断
//
// 用法：npx tsx test/s2-6-ground.ts [patchKey]
//
// 输出两件事：
//   ① 每个停车请求的**语义分区面积**：ParkingZone / 车位带 / 车道面 / 景观岛 /
//      转景观的空地 / 保留铺装（无功能）；
//   ② 一张 SVG 分区图（`out/s26/<key>-zones.svg`），颜色按语义，用于肉眼核对
//      "颜色 = 功能"是否一致。
//
// 这里只读 SceneIR（`buildPlannerBundle` 的结果），不重新算几何 ——
// 图上看到的和 2D/3D 渲染的是同一批面。

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Model } from '../src/town/model';
import { buildRoadNet } from '../src/road/system';
import { buildPlannerBundle } from '../src/scene/planner-bridge';
import { surfaceArea } from '../src/town/planning/core/surface';
import { patchKey } from '../src/town/patch';

const SEED = 682063530;
const KEYS = process.argv[2] ? [process.argv[2]] : ['176:176', '-469:284', '252:-578'];

const m = new Model({ nPatches: 15, seed: SEED, plaza: true });
m.generate();
const bundle = buildPlannerBundle(m, buildRoadNet(m), 'planner', {
  circulation: 'all',
  s1: 'golden',
  pattern: 'golden',
  parkingProvider: 'placemaker',
});

const m2 = (s: { ring: unknown[]; holes?: unknown[] }) =>
  surfaceArea({ outer: s.ring as never, holes: (s.holes ?? []) as never }) * 49;

const COLOR = {
  stall: '#d8d3c4', // 车位带（浅）
  aisle: '#6f747f', // 车道面（深）
  island: '#6fa84f', // 景观岛
  lawn: '#8fc46a', // 转景观的空地
  base: '#3f4249', // 停车底色（无功能铺装留在这一层）
};

console.log(`\n═══ S2.6 停车场地面语义 · seed ${SEED} ═══`);
console.log('地块        停车区m²  车位带  车道面  景观岛  转景观  底色余量  车位数');

for (const key of KEYS) {
  const f = bundle.byParcel.get(key);
  const rep = bundle.reports.get(key);
  if (!f || !rep?.covered) {
    console.log(`${key} 未接管`);
    continue;
  }
  const has = (n: string, re: RegExp) => f.surfaces.filter((s) => re.test(s.name) && n === n);
  const bands = has('band', /_pk_band_/);
  const aisles = has('aisle', /_pk_aisle_/);
  const islands = f.surfaces.filter((s) => /_pk_island_|parkreq/.test(s.name) && s.mat === 'grass');
  const lawns = has('lawn', /_pk_lawn_/);
  const base = f.surfaces.filter((s) => /_parkreq_/.test(s.name) && s.mat === 'asphaltLot');

  const zoneM2 = base.reduce((a, s) => a + m2(s), 0);
  const bandM2 = bands.reduce((a, s) => a + m2(s), 0);
  const aisleM2 = aisles.reduce((a, s) => a + m2(s), 0);
  const islandM2 = islands.reduce((a, s) => a + m2(s), 0);
  const lawnM2 = lawns.reduce((a, s) => a + m2(s), 0);
  const deadM2 = Math.max(0, zoneM2 - bandM2 - aisleM2 - islandM2 - lawnM2);

  console.log(
    key.padEnd(11) +
      zoneM2.toFixed(0).padStart(8) +
      bandM2.toFixed(0).padStart(8) +
      aisleM2.toFixed(0).padStart(7) +
      islandM2.toFixed(0).padStart(8) +
      lawnM2.toFixed(0).padStart(8) +
      deadM2.toFixed(0).padStart(10) +
      String(rep.parking?.stalls ?? -1).padStart(7)
  );

  // ---- SVG（1 单位 = 1 px 缩放后）
  const pts: { x: number; y: number }[] = [];
  for (const s of [...base, ...bands, ...aisles, ...islands, ...lawns]) {
    for (const p of s.ring as unknown as { x: number; y: number }[]) pts.push(p);
  }
  if (pts.length === 0) continue;
  const x0 = Math.min(...pts.map((p) => p.x));
  const x1 = Math.max(...pts.map((p) => p.x));
  const y0 = Math.min(...pts.map((p) => p.y));
  const y1 = Math.max(...pts.map((p) => p.y));
  const S = Math.min(900 / Math.max(1e-6, x1 - x0), 900 / Math.max(1e-6, y1 - y0));
  const tx = (p: { x: number; y: number }) => `${((p.x - x0) * S).toFixed(1)},${((y1 - p.y) * S).toFixed(1)}`;
  const poly = (ring: { x: number; y: number }[], fill: string, op = 1) =>
    `<polygon points="${ring.map(tx).join(' ')}" fill="${fill}" fill-opacity="${op}" stroke="none"/>`;

  const parts: string[] = [];
  parts.push(`<rect x="0" y="0" width="${((x1 - x0) * S).toFixed(0)}" height="${((y1 - y0) * S).toFixed(0)}" fill="${COLOR.base}"/>`);
  for (const s of bands) parts.push(poly(s.ring as never, COLOR.stall));
  for (const s of aisles) parts.push(poly(s.ring as never, COLOR.aisle, 0.95));
  for (const s of islands) parts.push(poly(s.ring as never, COLOR.island, 0.95));
  for (const s of lawns) parts.push(poly(s.ring as never, COLOR.lawn, 0.95));

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${((x1 - x0) * S).toFixed(0)}" height="${((y1 - y0) * S).toFixed(0)}">` +
    `<rect width="100%" height="100%" fill="#2a2c31"/>` +
    parts.join('') +
    `</svg>`;
  const dir = join(process.cwd(), 'out/s26');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${key.replace(':', '_')}-zones.svg`), svg, 'utf8');
}
console.log('\n图例：车位带(浅米) · 车道面(深灰) · 景观岛(深绿) · 转景观空地(浅绿) · 底色余量(最深)');
console.log('SVG 写在 out/s26/<key>-zones.svg');
