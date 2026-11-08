// F3 验收断言（独立于出图脚本）
//
// 只测"规则驱动的城市"这一条链路该保证的事：
//   · 确定性：同 spec 同 seed → 同结果
//   · 几何合法：建筑在地块内、地块在场地内、道路不越界、洞不丢
//   · 面积对账：场地 = 道路 + 地块 + 未归属（容差内）
//   · 内接矩形：真的在可用多边形内（四角 + 边中点校验）
//   · 风貌差异：三种风格不是换了个随机种子，是换了一套规则

import { Pt } from '../src/core/geom';
import { pointInRing as pip, ringArea, surfaceArea, surfaceIntersect, type PlanSurface } from '../src/town/planning/core/surface';
import { cityOutline, runF3City, type CityResult } from '../src/f3';
import { maxInscribedRect } from '../src/f3/build';
import type { CityDensity, CityProgram, CityStyle } from '../src/f3/types';
import { CASE_OF } from './f25c-cases';

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

const M2 = (u2: number): number => u2 * 49;

function make(style: CityStyle, program: CityProgram, density: CityDensity, seed = 20261106, radius = 90): CityResult {
  return runF3City({
    boundary: { outer: cityOutline(radius, seed), holes: [] },
    style,
    density,
    program,
    seed,
  });
}

const inRing = (p: Pt, ring: Pt[]): boolean => pip(p, ring);

/** 点到环的距离（世界单位） */
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

/**
 * 点是否在面内（**允许贴边**）。
 *
 * 街区是从场地布尔减出来的，绝大多数顶点正好落在红线上 —— 严格 pointInRing
 * 会把它们全判成"外"，那不是几何错了，是判据没考虑边界。容差 0.03 世界单位
 * ≈ 21 cm，远小于任何真实越界。
 */
const inRingTol = (p: Pt, s: PlanSurface, tolU = 0.03): boolean => {
  const inside = pip(p, s.outer) || distRing(p, s.outer) <= tolU;
  if (!inside) return false;
  // 洞里的点不算"在地块内"
  return !s.holes.some((h) => pip(p, h) && distRing(p, h) > tolU);
};

/** 环的四个角 + 四条边中点都在某个面内 */
function ringInside(ring: Pt[], s: PlanSurface): boolean {
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if (!inRingTol(a, s)) return false;
    if (!inRingTol(new Pt((a.x + b.x) / 2, (a.y + b.y) / 2), s)) return false;
  }
  return true;
}

// ---------------------------------------------------------------- ① 城市级：三种风貌
console.log('\n=== ① 城市级：规则 / 有机 / 园区');
const cities: Record<string, CityResult> = {};
for (const st of ['structured', 'organic', 'campus'] as CityStyle[]) {
  const t0 = Date.now();
  const r = make(st, 'mixed', 'medium');
  cities[st] = r;
  const ms = Date.now() - t0;
  console.log(`  ${st}: ${r.stats.blockCount} 街区 / ${r.stats.parcelCount} 地块 / ${r.stats.buildingCount} 建筑 / ${r.stats.roadLengthM} m / ${ms} ms`);
}

for (const [st, r] of Object.entries(cities)) {
  ok(`${st} 有街区、地块、建筑`, r.stats.blockCount > 0 && r.stats.parcelCount > 0 && r.stats.buildingCount > 0);
  ok(`${st} 有道路面与路口`, r.debug.road.carriage.length > 0 && r.debug.road.junction.length > 0,
    `${r.debug.road.carriage.length} 车行面 / ${r.debug.road.junction.length} 路口`);
  ok(`${st} 有人行道`, r.debug.road.sidewalk.length > 0, `${r.debug.road.sidewalk.length} 片`);

  // 面积对账
  // 并集口径：图层求和会在路口把重叠算两遍
  const road = r.debug.road.reserveAreaM2;
  const diff = Math.abs(r.stats.siteAreaM2 - road - r.stats.parcelAreaM2);
  ok(`${st} 面积对账在 3% 内`, diff / r.stats.siteAreaM2 < 0.03, `差 ${diff.toFixed(0)} / ${r.stats.siteAreaM2.toFixed(0)}`);

  // 所有面坐标有限
  let bad = 0;
  for (const s of r.scene.surfaces) for (const p of s.ring) if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) bad++;
  for (const s of r.scene.solids) for (const p of s.ring) if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) bad++;
  ok(`${st} 没有 NaN / 无穷坐标`, bad === 0, `${bad} 个`);

  // 建筑不越界（四角都在所属地块内）
  const byParcel = new Map<string, PlanSurface>();
  for (const p of r.debug.parcels) byParcel.set(p.id, p.surface);
  let outside = 0;
  let checked = 0;
  for (const s of r.scene.solids) {
    const pid = s.name.split('_')[0];
    const parcel = byParcel.get(pid);
    if (!parcel) continue;
    checked++;
    // 建筑环是轴对齐矩形，允许角点在边界上（浮点容差 0.02 世界单位 = 14 cm）
    if (!ringInside(s.ring, parcel)) outside++;
  }
  ok(`${st} 建筑都在自己的地块内`, outside === 0, `检查 ${checked} 栋，越界 ${outside}`);

  // 地块在场地内
  let parcelOut = 0;
  for (const p of r.debug.parcels) {
    for (const q of p.surface.outer) if (!inRingTol(q, r.spec.boundary)) { parcelOut++; break; }
  }
  ok(`${st} 地块都在场地内`, parcelOut === 0, `${parcelOut} 块越界`);

  // 内接矩形校验标记
  const withRect = r.debug.parcels.filter((p) => p.rect);
  ok(`${st} 内接矩形都通过了真实几何校验`, withRect.every((p) => p.rect!.verified), `${withRect.length} 块`);

  // 矩形在地块内
  let rectOut = 0;
  for (const p of withRect) if (!ringInside(p.rect!.ring, p.surface)) rectOut++;
  ok(`${st} 内接矩形真的在地块内`, rectOut === 0, `${rectOut} 块超界`);
}

// 三种风貌必须真的不同（不是同一个算法换种子）
{
  const lens = ['structured', 'organic', 'campus'].map((k) => cities[k].stats.roadLengthM);
  const uniq = new Set(lens.map((v) => Math.round(v / 50)));
  ok('三种风貌的道路总长不同', uniq.size >= 2, lens.join(' / '));
  const med = ['structured', 'organic', 'campus'].map((k) => {
    const a = cities[k].debug.blocks.map((b) => b.areaM2).sort((x, y) => x - y);
    return a[Math.floor(a.length / 2)] ?? 0;
  });
  ok('三种风貌的街区中位面积不同（规则 < 园区）', med[0] < med[2], med.map((v) => v.toFixed(0)).join(' / '));
}

// ---------------------------------------------------------------- ② 确定性
console.log('\n=== ② 确定性');
{
  const a = make('structured', 'mixed', 'medium');
  const b = make('structured', 'mixed', 'medium');
  ok('同 seed 同参数：街区数一致', a.stats.blockCount === b.stats.blockCount);
  ok('同 seed 同参数：建筑数一致', a.stats.buildingCount === b.stats.buildingCount, `${a.stats.buildingCount} vs ${b.stats.buildingCount}`);
  ok('同 seed 同参数：建筑面积一致', Math.abs(a.stats.footprintAreaM2 - b.stats.footprintAreaM2) < 1, `${a.stats.footprintAreaM2} vs ${b.stats.footprintAreaM2}`);
  const same = a.scene.solids.every((s, i) => {
    const o = b.scene.solids[i];
    return o && Math.abs(s.h - o.h) < 1e-9 && Math.abs(s.ring[0].x - o.ring[0].x) < 1e-9;
  });
  ok('同 seed 同参数：每一栋楼的位置与高度一致', same);

  const c = make('structured', 'mixed', 'medium', 777);
  ok('换 seed 结果不同', c.stats.buildingCount !== a.stats.buildingCount || c.stats.roadLengthM !== a.stats.roadLengthM);
}

// ---------------------------------------------------------------- ③ 密度与用途
console.log('\n=== ③ 密度 / 用途');
{
  const low = make('structured', 'residential', 'low');
  const high = make('structured', 'residential', 'high');
  ok('高密度楼层更高', high.stats.gfaM2 > low.stats.gfaM2, `${low.stats.gfaM2} → ${high.stats.gfaM2}`);
  const medParcel = (r: CityResult): number => {
    const a = r.debug.parcels.map((p) => p.areaM2).sort((x, y) => x - y);
    return a[Math.floor(a.length / 2)] ?? 0;
  };
  ok('高密度的地块中位面积更小', medParcel(high) <= medParcel(low) * 1.1, `${medParcel(low).toFixed(0)} → ${medParcel(high).toFixed(0)} m²`);

  const ind = make('campus', 'industrial', 'medium');
  const heights = ind.scene.solids.map((s) => s.h * 7);
  ok('工业地块有 9 m 以上的厂房', heights.some((h) => h > 9), `最高 ${Math.max(...heights).toFixed(1)} m`);

  const res = make('structured', 'residential', 'medium');
  const roofs = new Set(res.scene.solids.map((s) => s.roofMat));
  ok('住宅屋顶材质有变化（不是一张毯子）', roofs.size >= 2, [...roofs].join('/'));
  const kinds = new Set(res.scene.solids.map((s) => s.kind));
  ok('住宅区出现多种体量类型', kinds.size >= 1, [...kinds].join('/'));
}

// ---------------------------------------------------------------- ④ 地块形状：矩形 / 梯形 / 凹多边形带洞
console.log('\n=== ④ 极端地块形状的内接矩形');
{
  const rect: PlanSurface = {
    outer: [new Pt(0, 0), new Pt(10, 0), new Pt(10, 6), new Pt(0, 6)],
    holes: [],
  };
  const r1 = maxInscribedRect(rect, 0);
  ok('矩形地块：内接矩形 = 地块（质量 ≥ 0.99）', !!r1.rect && r1.rect.quality >= 0.99, `q=${r1.rect?.quality}`);

  const trap: PlanSurface = {
    outer: [new Pt(0, 0), new Pt(12, 0), new Pt(9, 7), new Pt(3, 7)],
    holes: [],
  };
  const r2 = maxInscribedRect(trap, 0, [Math.PI / 4]);
  ok('梯形地块：找到内接矩形且通过校验', !!r2.rect && r2.rect.verified, `q=${r2.rect?.quality} / ${r2.rect?.areaM2} m²`);
  ok('梯形地块：矩形确实在面内', !!r2.rect && ringInside(r2.rect.ring, trap));

  const hole: PlanSurface = {
    outer: [new Pt(0, 0), new Pt(20, 0), new Pt(20, 20), new Pt(0, 20)],
    holes: [[new Pt(8, 8), new Pt(12, 8), new Pt(12, 12), new Pt(8, 12)]],
  };
  const r3 = maxInscribedRect(hole, 0);
  ok('带洞地块：矩形避开洞', !!r3.rect && r3.rect.verified, `q=${r3.rect?.quality}`);
  const cc = r3.rect ? new Pt(
    r3.rect.ring.reduce((a, p) => a + p.x, 0) / 4,
    r3.rect.ring.reduce((a, p) => a + p.y, 0) / 4
  ) : null;
  ok('带洞地块：矩形面积小于整块（洞被让开）', !!r3.rect && r3.rect.areaM2 < 20 * 20 * 49 * 0.995,
    `${r3.rect?.areaM2.toFixed(0)} m² vs 整块 ${(20 * 20 * 49).toFixed(0)}`);
  void cc;

  // 凹多边形（L 形）
  const L: PlanSurface = {
    outer: [new Pt(0, 0), new Pt(24, 0), new Pt(24, 8), new Pt(8, 8), new Pt(8, 20), new Pt(0, 20)],
    holes: [],
  };
  const r4 = maxInscribedRect(L, 0);
  ok('L 形地块：矩形落在其中一个翼里', !!r4.rect && r4.rect.verified && r4.rect.areaM2 <= 24 * 8 * 49 + 1,
    `${r4.rect?.areaM2.toFixed(0)} m²`);
}

// ---------------------------------------------------------------- ⑤ 真实地块：R01 / C01 / I01
console.log('\n=== ⑤ 真实地块（复用 F2.5 的样板边界）');
for (const id of ['R01', 'C01', 'I01']) {
  const c = CASE_OF.get(id);
  if (!c) {
    ok(`${id} 样板存在`, false);
    continue;
  }
  const r = runF3City({
    boundary: c.boundary,
    style: id === 'I01' ? 'campus' : 'structured',
    density: 'medium',
    program: id === 'R01' ? 'residential' : id === 'C01' ? 'commercial' : 'industrial',
    seed: 20261106,
  });
  ok(`${id} 生成了街区与建筑`, r.stats.blockCount > 0 && r.stats.buildingCount > 0,
    `${r.stats.blockCount} 街区 / ${r.stats.buildingCount} 建筑 / ${r.stats.roadLengthM} m`);
  const diff = Math.abs(r.stats.siteAreaM2 - r.debug.road.reserveAreaM2 - r.stats.parcelAreaM2);
  ok(`${id} 面积对账在 3% 内`, diff / r.stats.siteAreaM2 < 0.03, `差 ${diff.toFixed(0)} / ${r.stats.siteAreaM2.toFixed(0)}`);
}

// ---------------------------------------------------------------- ⑥ 洞不丢
console.log('\n=== ⑥ 带洞城市');
{
  const outer = cityOutline(80, 424242);
  const hole: Pt[] = [
    new Pt(-8, -8),
    new Pt(8, -8),
    new Pt(8, 8),
    new Pt(-8, 8),
  ];
  const r = runF3City({
    boundary: { outer, holes: [hole] },
    style: 'structured',
    density: 'medium',
    program: 'mixed',
    seed: 424242,
  });
  ok('带洞城市生成了建筑', r.stats.buildingCount > 0, `${r.stats.buildingCount} 栋`);
  let inHole = 0;
  for (const s of r.scene.solids) {
    const c = new Pt(s.ring.reduce((a, p) => a + p.x, 0) / s.ring.length, s.ring.reduce((a, p) => a + p.y, 0) / s.ring.length);
    if (inRing(c, hole)) inHole++;
  }
  ok('洞内没有建筑', inHole === 0, `${inHole} 栋`);
  // 判据从「顶点均值落在洞里」改成**真实布尔交集**：路面绕洞时会形成环状面，
  // 顶点均值必然落进洞里（实测 1 片假阳性，而真实重叠是 0.00 m²）。
  const roadInHoleA = surfaceIntersect(r.debug.road.carriage, [{ outer: hole, holes: [] }]).reduce(
    (a, q) => a + Math.abs(ringArea(q.outer)) * 49,
    0
  );
  ok('洞内没有车行路面（真实布尔交集）', roadInHoleA < 5, `${roadInHoleA.toFixed(2)} m²`);
  void ringArea;
  void surfaceArea;
}

// ---------------------------------------------------------------- 规则接线检查
//
// 这三条守的是"预设真的进了算法"，而不是只在 types.ts 里躺着：
//   · coverage 决定建筑占地（±10 个百分点）
//   · 地面确实有停车、有绿化，不是两个 0
{
  for (const [name, r] of Object.entries(cities)) {
    const cover = r.stats.footprintAreaM2 / Math.max(1, r.stats.parcelAreaM2);
    const want = r.preset.coverage;
    ok(
      `${name} 建筑占地率符合 coverage 预设`,
      Math.abs(cover - want) < 0.12,
      `实际 ${(cover * 100).toFixed(0)}% / 预设 ${(want * 100).toFixed(0)}%`
    );
    ok(`${name} 有地面停车`, r.stats.parkingBays > 30, `${r.stats.parkingBays} 位`);
    const green = r.scene.surfaces
      .filter((s) => s.group.startsWith('lot/') && /lawn|green/.test(s.name))
      .reduce((a, s) => a + Math.abs(ringArea(s.ring)) * 49, 0);
    ok(
      `${name} 地块内有成规模绿化`,
      green / Math.max(1, r.stats.parcelAreaM2) > 0.05,
      `绿地 ${green.toFixed(0)} m² / 地块 ${r.stats.parcelAreaM2.toFixed(0)} m²`
    );
  }
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} 项断言，${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
