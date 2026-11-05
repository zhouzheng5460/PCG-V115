// 城市道路 / 街区尺度诊断（R-Scale 第 1 步：只测量，不改动）
//
// 用法：npx tsx test/scale-diag.ts [--seed 682063530] [--n 15]
//
// 输出任务书 §1 要求的每一项，并明确区分：
//   城市道路（红线 / 车行道 / 人行道 / 绿带 / 交叉口）
//   地块内部道路（R1 solver 产出的，只有开了开关的地块才有）
//   建筑 / 停车 / 绿地
//
// 单位约定：内部算世界单位（1u = 7m），打印时一律换算成米 / 平方米。

import { Model } from '../src/town/model';
import { buildRoadNet, roadSurfaces, type RoadNet, type RoadClass } from '../src/road/system';
import { buildScene } from '../src/scene/build';
import { surfaceArea } from '../src/town/planning/core/surface';
import { Pt } from '../src/core/geom';
import { specOf, meters } from '../src/road/spec';
import { area } from '../src/town/zones';
import type { SurfaceFeature } from '../src/scene/types';

const argv = process.argv.slice(2);
const arg = (k: string, d: number) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? Number(argv[i + 1]) : d;
};
const SEED = arg('seed', 682063530);
const NP = arg('n', 15);

const m2 = (u2: number) => u2 * 49; // u² → m²
const pct = (a: number, b: number) => (b > 0 ? ((a / b) * 100).toFixed(1) + '%' : '-');
const med = (xs: number[]) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
const quant = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
};

const t0 = performance.now();
const m = new Model({ nPatches: NP, seed: SEED, plaza: true });
m.generate();
const genMs = performance.now() - t0;
const net = buildRoadNet(m);
const scene = buildScene(m, { planningMode: 'legacy' });
const cityR = m.cityRadius;

console.log(`\n═══ 尺度诊断 · seed ${SEED} · n=${NP} · layout=${m.layout} ═══`);
console.log(`城市半径 ${cityR.toFixed(1)} u = ${meters(cityR).toFixed(0)} m · 建模 ${genMs.toFixed(0)} ms\n`);

// ---------------------------------------------------------------- ① 三类道路红线
interface Row {
  cls: RoadClass;
  n: number;
  lenM: number;
  widths: number[];
  carriage: number;
  sw: number;
  vg: number;
}
const rows = new Map<RoadClass, Row>();
for (const e of net.edges) {
  const cls = e.cls;
  let r = rows.get(cls);
  if (!r) { r = { cls, n: 0, lenM: 0, widths: [], carriage: 0, sw: 0, vg: 0 }; rows.set(cls, r); }
  r.n++;
  r.lenM += e.len * 7;
  r.widths.push((e.insetL + e.insetR) * 7);
  r.carriage += (e.carL + e.carR) * e.len * 49;
  r.sw += (e.swL + e.swR) * e.len * 49;
  r.vg += (e.vgL + e.vgR) * e.len * 49;
}

console.log('① 城市道路：实际红线宽 / 长度 / 占比');
console.log('   等级      条数   总长(m)   长度占比   红线宽 min/中位/max (m)   规范标称');
for (const cls of ['arterial', 'collector', 'local'] as RoadClass[]) {
  const r = rows.get(cls);
  const spec = specOf(cls);
  if (!r) { console.log(`   ${spec.label}      0       0            -`); continue; }
  const lenShare = r.lenM / [...rows.values()].reduce((s, x) => s + x.lenM, 0);
  console.log(
    `   ${spec.label}   ${String(r.n).padStart(4)}  ${r.lenM.toFixed(0).padStart(7)}  ` +
    `${pct(r.lenM, [...rows.values()].reduce((s, x) => s + x.lenM, 0)).padStart(8)}   ` +
    `${quant(r.widths, 0).toFixed(1)} / ${med(r.widths).toFixed(1)} / ${quant(r.widths, 0.999).toFixed(1)}` +
    `        ${spec.redLine} m (min ${spec.minRedLine})`
  );
  void lenShare;
}

// ---------------------------------------------------------------- ② smoothRoadClass 前后
{
  let up = 0, down = 0, same = 0;
  const trans = new Map<string, number>();
  for (const [k, before] of m.roadClassRaw) {
    const after = m.edgeClass.get(k);
    if (!after) continue;
    if (before === after) same++;
    else {
      if (after === 'arterial' || (after === 'collector' && before === 'local')) up++;
      else down++;
      const t = `${before}→${after}`;
      trans.set(t, (trans.get(t) ?? 0) + 1);
    }
  }
  console.log('\n② smoothRoadClass：等级变化');
  console.log(`   边总数 ${m.roadClassRaw.size} · 不变 ${same} · 变化 ${up + down}（升级 ${up} / 降级 ${down}）`);
  for (const [t, n] of [...trans.entries()].sort((a, b) => b[1] - a[1])) console.log(`     ${t}: ${n} 条`);
}

// ---------------------------------------------------------------- ③ 交叉口
{
  const jfeats: SurfaceFeature[] = [];
  const all: SurfaceFeature[] = [];
  roadSurfaces(net, all);
  for (const s of all) if (s.group === 'road/junction') jfeats.push(s);
  const jAreas = new Map<number, number>();
  for (const s of jfeats) {
    const mm = /^junc_(\d+)_/.exec(s.name);
    if (!mm) continue;
    const ji = Number(mm[1]);
    jAreas.set(ji, (jAreas.get(ji) ?? 0) + surfaceArea({ outer: s.ring, holes: s.holes ?? [] }));
  }
  const areasM2 = [...jAreas.values()].map(m2);
  const totalJ = areasM2.reduce((a, b) => a + b, 0);
  const totalCarriage = [...rows.values()].reduce((s, r) => s + r.carriage, 0);

  // 相邻路宽：路口各臂所属边的红线宽
  let armW: number[] = [];
  for (const j of net.junctions) {
    for (const a of j.arms) {
      const e = net.edges[a.edge];
      if (e) armW.push((e.insetL + e.insetR) * 7);
    }
  }
  armW = armW.sort((a, b) => a - b);

  console.log('\n③ 交叉口');
  console.log(`   数量 ${net.junctions.length} · 铺装合计 ${totalJ.toFixed(0)} m²` +
    ` · 占车行道面积 ${pct(totalJ, totalCarriage)}`);
  console.log(`   单个路口面积 P10/P50/P90 = ${quant(areasM2, 0.1).toFixed(0)} / ${med(areasM2).toFixed(0)} / ${quant(areasM2, 0.9).toFixed(0)} m²`);
  console.log(`   相邻道路红线宽 P10/P50/P90 = ${quant(armW, 0.1).toFixed(1)} / ${med(armW).toFixed(1)} / ${quant(armW, 0.9).toFixed(1)} m`);
  console.log(`   路口面积 / 中位红线宽² = ${(med(areasM2) / Math.pow(med(armW), 2)).toFixed(2)}（≈1 说明路口就是一个"路面宽度的方形"）`);
}

// ---------------------------------------------------------------- ④ Block 尺度
{
  const inner = m.patches.filter((p) => p.withinCity && !p.blocked);
  const areasM2: number[] = [];
  const shortEdges: number[] = [];
  for (const p of inner) {
    const ring = Array.from(p.shape);
    areasM2.push(Math.abs(area(ring)) * 49);
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const q of ring) { x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
    shortEdges.push(Math.min(x1 - x0, y1 - y0) * 7);
  }
  console.log('\n④ 街区（Block）尺度');
  console.log(`   城内 ${inner.length} 块`);
  console.log(`   面积 P10/P50/P90 = ${quant(areasM2, 0.1).toFixed(0)} / ${med(areasM2).toFixed(0)} / ${quant(areasM2, 0.9).toFixed(0)} m²`);
  console.log(`   中位短边 ${med(shortEdges).toFixed(0)} m · 短边 P10/P90 = ${quant(shortEdges, 0.1).toFixed(0)} / ${quant(shortEdges, 0.9).toFixed(0)} m`);
  const roadW = med([...rows.values()].flatMap((r) => r.widths));
  console.log(`   等效中位道路间距（街区短边 + 一条红线）≈ ${(med(shortEdges) + roadW).toFixed(0)} m`);
}

// ---------------------------------------------------------------- ⑤ 面积构成
{
  const byGroup = new Map<string, number>();
  const greenMats = new Set(['grass', 'grassDark', 'meadow', 'forest', 'scrub', 'gravel']);
  let green = 0;
  let lotRoad = 0;
  let parking = 0;
  for (const s of scene.surfaces) {
    // 底板（group='ground'）铺满全城，算进任何一个分类都会把比例拉爆
    if (s.group === 'ground' || s.group === 'plate') continue;
    const a = surfaceArea({ outer: s.ring, holes: s.holes ?? [] });
    const g = s.group.startsWith('road/') ? 'road' : s.group.startsWith('lot/') ? 'lot' : s.group;
    byGroup.set(g, (byGroup.get(g) ?? 0) + a);
    if (/_road_\d+_(surf|walk|curb|pad)/.test(s.name)) lotRoad += a;
    else if (s.mat === 'asphaltLot') parking += a;
    else if (greenMats.has(s.mat as string)) green += a;
  }
  const cityRoad = byGroup.get('road') ?? 0;
  const bld = scene.solids.reduce((s, x) => s + Math.abs(area(x.ring)), 0);
  const cityArea = Math.PI * cityR * cityR;
  console.log('\n⑤ 面积构成（相对城市圆面积）');
  console.log(`   城市圆 ${m2(cityArea).toFixed(0)} m²`);
  console.log(`   城市道路 ${m2(cityRoad).toFixed(0)} m² (${pct(m2(cityRoad), m2(cityArea))})  [车行道 ${[...rows.values()].reduce((s, r) => s + r.carriage, 0).toFixed(0)} / 人行道 ${[...rows.values()].reduce((s, r) => s + r.sw, 0).toFixed(0)} / 绿带 ${[...rows.values()].reduce((s, r) => s + r.vg, 0).toFixed(0)} / 路口另计]`);
  console.log(`   建筑     ${m2(bld).toFixed(0)} m² (${pct(m2(bld), m2(cityArea))})`);
  console.log(`   停车     ${m2(parking).toFixed(0)} m² (${pct(m2(parking), m2(cityArea))})`);
  console.log(`   绿地     ${m2(green).toFixed(0)} m² (${pct(m2(green), m2(cityArea))})`);
  console.log(`   地块内部道路 ${m2(lotRoad).toFixed(0)} m²（只有开了 R1.3 开关的地块才有，本次 legacy 模式应为 0）`);
}

// ---------------------------------------------------------------- ⑥ 二次切分
{
  const s = m.splitStats;
  console.log('\n⑥ subdivideLargePatches');
  console.log(`   切前 ${s.before} 块 → 切后 ${s.after} 块（+${s.after - s.before}）· 新增支路边 ${s.newEdges} 条`);
}

// ---------------------------------------------------------------- ⑦ spacingK
{
  const k = m.params.block.spacingK;
  const raw = (NP * 5) / (k * k);
  const cells = Math.max(36, Math.round(raw));
  const eff = Math.sqrt((NP * 5) / cells);
  console.log('\n⑦ spacingK');
  console.log(`   参数 ${k} → 原始 cells = ${raw.toFixed(1)} → 实际 ${cells}${raw < 36 ? '（**被 36 下限截断**）' : ''}`);
  console.log(`   有效 k = √(75/${cells}) = ${eff.toFixed(2)}（名义 ${k}，被截断时两者不等）`);
  console.log(`   街区理论边长 = R/√(cells/π) = ${(cityR / Math.sqrt(cells / Math.PI)).toFixed(1)} u = ${meters(cityR / Math.sqrt(cells / Math.PI)).toFixed(0)} m`);
}

// ---------------------------------------------------------------- ⑧ 重复缩放检查
{
  let worst = 0;
  let worstEdge = '';
  for (const e of net.edges) {
    const red = e.insetL + e.insetR;
    const secSum = e.carL + e.swL + e.vgL + e.carR + e.swR + e.vgR;
    const d = Math.abs(red - secSum) * 7;
    if (d > worst) { worst = d; worstEdge = `${e.cls} a=${e.a.toString()} b=${e.b.toString()} red=${(red * 7).toFixed(2)}m sec=${(secSum * 7).toFixed(2)}m`; }
  }
  const styleW = { arterial: m.style.mainStreetWidth, collector: m.style.regularStreetWidth, local: m.style.alleyWidth };
  console.log('\n⑧ 宽度是否重复缩放');
  for (const cls of ['arterial', 'collector', 'local'] as RoadClass[]) {
    console.log(`   ${specOf(cls).label}: style=${styleW[cls].toFixed(2)}u = ${(styleW[cls] * 7).toFixed(1)}m（规范 ${specOf(cls).redLine}m）`);
  }
  console.log(`   红线 = 车行道+人行道+绿带 的最大偏差 ${worst.toFixed(3)} m（应 ≈0）${worst > 0.01 ? ' ← ' + worstEdge : ''}`);
  const minRed = net.edges.filter((e) => (e.insetL + e.insetR) * 7 < specOf(e.cls).minRedLine - 0.01).length;
  console.log(`   低于等级最小红线的边：${minRed} 条`);
}

console.log('');
