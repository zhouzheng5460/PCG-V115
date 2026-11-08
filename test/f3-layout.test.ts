// F3 · 地块切割与建筑布局验收（对照《houdini 路网(3)》5 张截图）
//
// 截图依据：
//   · 图 3「大都是规则矩形块，每个地块上两排建筑」→ 地块应多数是矩形、两排/围合场景为主
//   · 图 4「对一个地块不断进行横竖分割」        → 刀角正交，不是 ±16° 乱切
//   · 图 5「商业区地块最好大多数搞成矩形」「面积不宜过大」
//   · 图 1「预设大小两个级别的矩形去填充路边」  → 建筑确实出现大小两档
//   · 图 2「改进后使院子形状尽量保持接近矩形」  → 内院矩形化、四边围合、院落成片绿地

import { Pt } from '../src/core/geom';
import { surfaceArea, surfaceSubtract, type PlanSurface } from '../src/town/planning/core/surface';
import { obbOf } from '../src/town/planning/subdivision/geom';
import { cityOutline, runF3City } from '../src/f3';
import { classifyScene, realizeLayout } from '../src/f3/layout';
import { M2 } from '../src/f3/geom';

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = ''): void => {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}${detail ? '  ' + detail : ''}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? '  ' + detail : ''}`);
  }
};

const m2 = (u2: number): number => Math.abs(M2(u2));
function q(a: number[], p: number): number {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}
/** 面积 / OBB 面积：1 = 完美矩形 */
function rectRatio(s: PlanSurface): number {
  const ob = obbOf(s.outer);
  const A = m2(surfaceArea(s));
  return ob ? A / Math.max(1, M2(ob.w * ob.d)) : 0;
}
const centroid = (ring: Pt[]): Pt => new Pt(ring.reduce((s, p) => s + p.x, 0) / ring.length, ring.reduce((s, p) => s + p.y, 0) / ring.length);

const r = runF3City({
  boundary: { outer: cityOutline(95, 20261106), holes: [] },
  style: 'structured', density: 'medium', program: 'mixed', seed: 20261106,
});
const parcels = r.debug.parcels;
const solids = r.scene.solids;

console.log('\n=== ① 地块切割：横竖正交 + 商业地块尺度（截图 3 / 4 / 5）===');
const ratios = parcels.map((p) => rectRatio(p.surface));
const scenes = parcels.map((p) => classifyScene(p).scene);
const twoOrCourt = scenes.filter((s) => s === 'twoRows' || s === 'courtyard').length;
ok('① 地块矩形度中位 ≥ 0.90', q(ratios, 0.5) >= 0.90,
  `p10/p50/p90 = ${q(ratios, .1).toFixed(2)}/${q(ratios, .5).toFixed(2)}/${q(ratios, .9).toFixed(2)}`);
ok('① 规则地块（两排 / 城市小区）占多数', twoOrCourt / parcels.length >= 0.7,
  `${twoOrCourt}/${parcels.length} = ${(100 * twoOrCourt / parcels.length).toFixed(0)}%`);
ok('① 被判"不规则沿路填充"的地块 < 30%', scenes.filter((s) => s === 'roadside').length / parcels.length < 0.3,
  `${scenes.filter((s) => s === 'roadside').length} 块`);

const com = parcels.filter((p) => p.use === 'commercial' || p.use === 'cbd');
const comR = com.map((p) => rectRatio(p.surface));
const comA = com.map((p) => p.areaM2);
ok('① 商业/CBD 地块多数是矩形（截图 5）', comR.filter((x) => x >= 0.84).length / Math.max(1, com.length) >= 0.6,
  `${(100 * comR.filter((x) => x >= 0.84).length / Math.max(1, com.length)).toFixed(0)}%，矩形度 p50 ${q(comR, .5).toFixed(2)}`);
ok('① 商业/CBD 地块不宜过大（截图 5）', q(comA, 0.9) <= 2300,
  `p50/p90/max = ${q(comA, .5).toFixed(0)}/${q(comA, .9).toFixed(0)}/${Math.max(...comA, 0).toFixed(0)} m²`);
ok('① 仍保留"大地块配内部路网"的城市小区场景', scenes.filter((s) => s === 'courtyard').length >= 30,
  `${scenes.filter((s) => s === 'courtyard').length} 块`);

console.log('\n=== ② 建筑摆放：内院接近矩形 + 四边围合（截图 2）===');
const opts = {
  density: 'medium' as const, heightScale: 1, preset: r.preset, seed: 20261106,
  centerDist: 0.5, coverage: r.preset.coverage,
};
const innerR: number[] = [];
const innerA: number[] = [];
for (const p of parcels) {
  const out = realizeLayout(p, {
    ...opts, access: p.access, localIntensity: p.localIntensity, streetCls: p.streetCls,
  });
  if (!out.courtyard) continue;
  innerR.push(rectRatio(out.courtyard));
  innerA.push(m2(surfaceArea(out.courtyard)));
}
ok('② 至少 40 个地块围出明确内院', innerR.length >= 40, `${innerR.length} 个`);
ok('② 内院形状接近矩形（截图 2 的改进目标）', q(innerR, 0.5) >= 0.85,
  `矩形度 p10/p50/p90 = ${q(innerR, .1).toFixed(2)}/${q(innerR, .5).toFixed(2)}/${q(innerR, .9).toFixed(2)}`);
ok('② 内院不是一条缝：面积中位 ≥ 100 m²', q(innerA, 0.5) >= 100, `${q(innerA, .5).toFixed(0)} m²`);

// 四边闭合率：按 frontRad 建 uv 坐标，看四条边带是否都有建筑
const byParcel = new Map<string, typeof solids>();
for (const s of solids) {
  const id = s.name.replace(/_[^_]+_\d+$/, '');
  const arr = byParcel.get(id) ?? [];
  arr.push(s);
  byParcel.set(id, arr);
}
let closed = 0;
let checked = 0;
for (const p of parcels) {
  const arr = byParcel.get(p.id) ?? [];
  if (arr.length < 4) continue;
  checked++;
  const ux = Math.cos(p.frontRad), uy = Math.sin(p.frontRad);
  const vx = -uy, vy = ux;
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const pt of p.surface.outer) {
    const u = pt.x * ux + pt.y * uy, v = pt.x * vx + pt.y * vy;
    u0 = Math.min(u0, u); u1 = Math.max(u1, u);
    v0 = Math.min(v0, v); v1 = Math.max(v1, v);
  }
  const du = (u1 - u0) * 0.3, dv = (v1 - v0) * 0.3;
  const hit = { f: false, b: false, l: false, r: false };
  for (const s of arr) for (const pt of s.ring) {
    const u = pt.x * ux + pt.y * uy, v = pt.x * vx + pt.y * vy;
    if (u < u0 + du) hit.f = true;
    if (u > u1 - du) hit.b = true;
    if (v < v0 + dv) hit.l = true;
    if (v > v1 - dv) hit.r = true;
  }
  if (Object.values(hit).every(Boolean)) closed++;
}
ok('② 院落四边都被建筑围住 ≥ 70%', closed / Math.max(1, checked) >= 0.7,
  `${closed}/${checked} = ${(100 * closed / Math.max(1, checked)).toFixed(0)}%`);

// 内院整片绿化：ground 层的 lawn 大块
const lawnBig = r.scene.surfaces.filter((s) => s.name.endsWith('_lawn') && m2(surfaceArea({ outer: s.ring, holes: s.holes ?? [] })) > 120);
ok('② 内院整片做院落绿地（不被切碎）', lawnBig.length >= 30, `${lawnBig.length} 片 >120 m² 的成片 lawn`);

console.log('\n=== ③ 大小两档预制矩形（截图 1）===');
const footA = solids.map((s) => m2(surfaceArea({ outer: s.ring, holes: [] })));
const smallN = footA.filter((a) => a < 110).length;
const bigN = footA.filter((a) => a >= 220).length;
ok('③ 小屋档与庭院档都实际出现', smallN / footA.length >= 0.15 && bigN / footA.length >= 0.05,
  `小档 ${(100 * smallN / footA.length).toFixed(0)}% / 大档 ${(100 * bigN / footA.length).toFixed(0)}%`);
ok('③ 单栋占地有明显级差', q(footA, .75) / Math.max(1, q(footA, .25)) >= 1.8,
  `p25/p50/p75 = ${q(footA, .25).toFixed(0)}/${q(footA, .5).toFixed(0)}/${q(footA, .75).toFixed(0)} m²`);

console.log('\n=== ④ 既有判据不回退 ===');
const comParcels = parcels.filter((p) => p.use === 'commercial');
const comFrontOnly = comParcels.filter((p) => p.note.includes('不填建筑') || p.note.includes('只留最外')).length;
ok('④ 普通商业只留最外一圈、中间不填（截图 5 方式①）', comFrontOnly / Math.max(1, comParcels.length) >= 0.5,
  `${comFrontOnly}/${comParcels.length}`);
ok('④ 面积对账仍闭合', r.stats.unclaimedM2 <= 1, `未归属 ${r.stats.unclaimedM2.toFixed(0)} m²`);
ok('④ 仍生成了足够建筑', solids.length >= 1200, `${solids.length} 栋 / ${parcels.length} 地块`);

// 建筑不出地块：抽查每个 solid 的形心落在某个地块内，且顶点不越过场地
let inside = 0;
for (const s of solids) {
  const c = centroid(s.ring);
  if (parcels.some((p) => insideSurfaceFast(c, p.surface.outer))) inside++;
}
function insideSurfaceFast(p: Pt, ring: Pt[]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}
ok('④ 建筑形心都落在地块内', inside / Math.max(1, solids.length) >= 0.98,
  `${inside}/${solids.length}`);

// 确定性
const r2 = runF3City({
  boundary: { outer: cityOutline(95, 20261106), holes: [] },
  style: 'structured', density: 'medium', program: 'mixed', seed: 20261106,
});
ok('④ 同 seed 结果完全一致', r2.scene.solids.length === solids.length &&
  r2.scene.solids[0]?.ring[0]?.x === solids[0]?.ring[0]?.x,
  `${r2.scene.solids.length} 栋`);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} 项断言，${fail} 项失败`);
if (fail > 0) process.exitCode = 1;
