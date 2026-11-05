// S2 · 多边形泛化：Placemaker 在不同形状停车区上的真实产出
// 用法：npx tsx test/s2-polygon.ts
//
// 五种形状各跑一次，尺寸与 legacy 完全一致（2.52 / 5.04 / 6.3 m）。
// 这是"不只是矩形"的证据，也是 provider 能力边界的实测表。
import { Pt } from '../src/core/geom';
import { runPlacemaker, pmPlanToParkLayout, pmOrigin } from '../src/town/parking/placemaker';

const U = (m: number) => m / 7;
const P = (x: number, y: number) => new Pt(U(x), U(y));
const DIM = { aisleM: 6.3, stallWM: 2.52, stallLM: 5.04 };

const CASES: { name: string; shape: string; ring: Pt[]; street: [Pt, Pt] }[] = [
  { name: '矩形 150×100', shape: 'rect', ring: [P(0, 0), P(150, 0), P(150, 100), P(0, 100)], street: [P(-15, -8), P(165, -8)] },
  { name: '楔形三角 120×90', shape: 'wedge', ring: [P(0, 0), P(120, 0), P(0, 90)], street: [P(-15, -8), P(130, -8)] },
  {
    name: '凹形 L 120×100',
    shape: 'L',
    ring: [P(0, 0), P(120, 0), P(120, 45), P(55, 45), P(55, 100), P(0, 100)],
    street: [P(-15, -8), P(130, -8)],
  },
  { name: '狭长 160×18', shape: 'narrow', ring: [P(0, 0), P(160, 0), P(160, 18), P(0, 18)], street: [P(-15, -8), P(170, -8)] },
  { name: '含建筑障碍 150×100', shape: 'obstacle', ring: [P(0, 0), P(150, 0), P(150, 100), P(0, 100)], street: [P(-15, -8), P(165, -8)] },
];

console.log('\n═══ S2 多边形泛化（Placemaker，尺寸同 legacy）═══\n');
console.log('形状'.padEnd(22) + '面积m²'.padStart(8) + 'ready'.padStart(7) + '车位'.padStart(6) + '车道段'.padStart(7) + '车道m'.padStart(8) + '分量'.padStart(6) + '前端贴车道'.padStart(11) + '绿岛'.padStart(6) + 'ms'.padStart(7));
for (const c of CASES) {
  const obstacles = c.shape === 'obstacle' ? [{ quad: [P(40, 30), P(90, 30), P(90, 80), P(40, 80)] as [Pt, Pt, Pt, Pt] }] : undefined;
  const r = runPlacemaker({ ring: c.ring, seed: 7, ...DIM, obstacles, streets: [{ a: c.street[0], b: c.street[1], widthM: 8 }] });
  if (!r.plan) { console.log(c.name + '  失败 ' + (r.error ?? '')); continue; }
  const { diag } = pmPlanToParkLayout(r.plan, pmOrigin(c.ring));
  let a = 0;
  for (let i = 0; i < c.ring.length; i++) { const p = c.ring[i]; const q = c.ring[(i + 1) % c.ring.length]; a += (p.x * q.y - q.x * p.y); }
  console.log(
    c.name.padEnd(22) +
      (Math.abs(a / 2) * 49).toFixed(0).padStart(8) +
      String(r.plan.ready).padStart(7) +
      String(diag.stalls).padStart(6) +
      String(diag.aisleSegments).padStart(7) +
      diag.aisleLengthM.toFixed(0).padStart(8) +
      String(diag.aisleComponents).padStart(6) +
      `${(diag.stallFrontRate * 100).toFixed(0)}%`.padStart(11) +
      String(diag.trees).padStart(6) +
      String(r.ms).padStart(7)
  );
}
console.log('');
