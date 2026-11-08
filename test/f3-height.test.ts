// F3-G 验收断言：建筑高度分层
//
// 锁住用户给的三条判据 + 本轮补充的确定性规则，防止以后又被"同一个层数 × 中心梯度"改回去：
//   1. CBD 沿街高、占地大（合并大栋后自动拔高，且不越界）；
//   2. 普通商业沿街高、内侧不填建筑（内侧交给广场/停车/绿化）；
//   3. 住宅沿街低、内部高层；
//   4. 街角 > 同排中间、主干道 > 支路、工业不随进城长高、园区核心带更高；
//   5. 同一街区内出现真实高低差，而不是"一张等高线的毯子"。

import { cityOutline, runF3City } from '../src/f3';
import { heightOf, type HeightCtx } from '../src/f3/height';
import { M2 } from '../src/f3/geom';
import { surfaceArea } from '../src/town/planning/core/surface';

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

const base = (over: Partial<HeightCtx> = {}): HeightCtx => ({
  use: 'commercial',
  density: 'medium',
  heightScale: 1,
  centerDist: 0.8,
  streetCls: 'local',
  band: 'front',
  footprintM2: 400,
  frontageM: 20,
  parcelM2: 420,
  parcelTargetM2: 380,
  ...over,
});

console.log('\n=== ① 高度规则（单元）');
{
  const small = heightOf(base({ use: 'cbd', frontageM: 20, footprintM2: 400 }));
  const merged = heightOf(base({ use: 'cbd', frontageM: 48, footprintM2: 1100 }));
  ok('① CBD 沿街合并大栋后更高', merged.floors > small.floors, `${small.floors} → ${merged.floors} 层`);

  const cf = heightOf(base({ use: 'commercial', band: 'front' }));
  const ci = heightOf(base({ use: 'commercial', band: 'inner' }));
  ok('② 普通商业沿街高于内侧', cf.floors > ci.floors, `沿街 ${cf.floors} / 内侧 ${ci.floors} 层`);

  const rf = heightOf(base({ use: 'residential', band: 'front' }));
  const ri = heightOf(base({ use: 'residential', band: 'inner' }));
  const rc = heightOf(base({ use: 'residential', band: 'core' }));
  ok('③ 住宅沿街 < 内侧 < 核心', rf.floors < ri.floors && ri.floors <= rc.floors,
    `${rf.floors} / ${ri.floors} / ${rc.floors} 层`);

  const corner = heightOf(base({ use: 'commercial', band: 'corner' }));
  ok('④ 街角高于同排中间', corner.floors >= cf.floors, `${cf.floors} → ${corner.floors} 层`);
  const arterial = heightOf(base({ use: 'commercial', band: 'front', streetCls: 'arterial' }));
  ok('④ 临主干道高于临支路', arterial.floors >= cf.floors, `支路 ${cf.floors} → 主干 ${arterial.floors} 层`);

  const near = heightOf(base({ use: 'industrial', centerDist: 0, footprintM2: 400 }));
  const far = heightOf(base({ use: 'industrial', centerDist: 1, footprintM2: 400 }));
  ok('④ 工业厂房不随进城长高', near.hU * 7 / (far.hU * 7) < 1.35 && near.floors === 1,
    `中心 ${(near.hU * 7).toFixed(1)} m / 边缘 ${(far.hU * 7).toFixed(1)} m，${far.floors} 层`);
  const bigShed = heightOf(base({ use: 'industrial', footprintM2: 2400 }));
  ok('④ 大跨厂房檐高更高', bigShed.hU > far.hU, `${(far.hU * 7).toFixed(1)} → ${(bigShed.hU * 7).toFixed(1)} m`);

  const cpf = heightOf(base({ use: 'campus', band: 'front' }));
  const cpc = heightOf(base({ use: 'campus', band: 'core' }));
  ok('④ 园区核心带高于沿街', cpc.floors > cpf.floors, `${cpf.floors} → ${cpc.floors} 层`);

  const capped = heightOf(base({ use: 'cbd', band: 'core', frontageM: 120, footprintM2: 9000, parcelM2: 20000 }));
  ok('④ 高度有上界', capped.floors <= 40, `极端输入 → ${capped.floors} 层 / ${(capped.hU * 7).toFixed(0)} m`);
}

console.log('\n=== ② 真实城市（集成，structured / mixed / medium）');
{
  const r = runF3City({
    boundary: { outer: cityOutline(90, 20261106), holes: [] },
    style: 'structured',
    program: 'mixed',
    density: 'medium',
    seed: 20261106,
  });

  const byParcel = new Map(r.debug.parcels.map((p) => [p.id, p]));
  type Row = { use: string; blockId: string; uT: number; hM: number; areaM2: number };
  const rows: Row[] = [];
  for (const s of r.scene.solids) {
    const p = byParcel.get(s.name.split('_')[0]);
    if (!p) continue;
    const ux = Math.cos(p.frontRad);
    const uy = Math.sin(p.frontRad);
    let u0 = Infinity;
    let u1 = -Infinity;
    for (const q of p.surface.outer) {
      const u = q.x * ux + q.y * uy;
      u0 = Math.min(u0, u);
      u1 = Math.max(u1, u);
    }
    let cu = 0;
    for (const q of s.ring) cu += q.x * ux + q.y * uy;
    cu /= Math.max(1, s.ring.length);
    rows.push({
      use: p.use,
      blockId: p.blockId,
      uT: (cu - u0) / Math.max(0.001, u1 - u0),
      hM: s.h * 7,
      areaM2: M2(surfaceArea({ outer: s.ring, holes: [] })),
    });
  }

  const avg = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const heightsByUse = new Map<string, number[]>();
  for (const x of rows) {
    if (!heightsByUse.has(x.use)) heightsByUse.set(x.use, []);
    heightsByUse.get(x.use)!.push(x.hM);
  }
  console.log('  用途        栋数   最低 m   平均 m   最高 m');
  for (const [use, hs] of [...heightsByUse].sort()) {
    console.log(`  ${use.padEnd(12)} ${String(hs.length).padStart(4)}   ${Math.min(...hs).toFixed(1).padStart(6)}   ${avg(hs).toFixed(1).padStart(6)}   ${Math.max(...hs).toFixed(1).padStart(6)}`);
  }

  const resFront = rows.filter((x) => x.use === 'residential' && x.uT < 0.42).map((x) => x.hM);
  const resInner = rows.filter((x) => x.use === 'residential' && x.uT > 0.58).map((x) => x.hM);
  console.log(`  住宅：临街 ${resFront.length} 栋 / ${avg(resFront).toFixed(1)} m，内侧 ${resInner.length} 栋 / ${avg(resInner).toFixed(1)} m`);
  ok('③ 住宅临街明显低于内侧', resFront.length > 20 && resInner.length > 20 && avg(resFront) < avg(resInner) * 0.85,
    `${avg(resFront).toFixed(1)} → ${avg(resInner).toFixed(1)} m`);

  const comFront = rows.filter((x) => x.use === 'commercial' && x.uT < 0.42).map((x) => x.hM);
  const comInner = rows.filter((x) => x.use === 'commercial' && x.uT > 0.58).map((x) => x.hM);
  console.log(`  商业：临街 ${comFront.length} 栋 / ${avg(comFront).toFixed(1)} m，内侧 ${comInner.length} 栋 / ${avg(comInner).toFixed(1)} m`);
  ok('② 普通商业内侧基本不填建筑', comFront.length > 10 && comInner.length < comFront.length * 0.3,
    `临街 ${comFront.length} / 内侧 ${comInner.length}`);
  const plazaM2 = r.scene.surfaces
    // `lot/internal` 是张量一级缝的内部步行街（也是 stonePave），
    // 它不算「商业内侧让出来的广场」，必须排除，否则这条断言会被新层级虚增。
    .filter((s) => s.group.startsWith('lot/') && s.group !== 'lot/internal' && s.mat === 'stonePave')
    .reduce((a, s) => a + Math.abs(M2(surfaceArea({ outer: s.ring, holes: s.holes ?? [] }))), 0);
  ok('② 让出来的内侧铺成广场空地', plazaM2 > 200, `广场 ${plazaM2.toFixed(0)} m²`);

  const cbd = rows.filter((x) => x.use === 'cbd');
  const com = rows.filter((x) => x.use === 'commercial');
  const maxCbd = Math.max(...cbd.map((x) => x.areaM2));
  const sortedAll = rows.map((x) => x.areaM2).sort((a, b) => a - b);
  const medAll = sortedAll[Math.floor(sortedAll.length / 2)] || 1;
  console.log(`  单栋占地：CBD 最大 ${maxCbd.toFixed(0)} m² / 平均 ${avg(cbd.map((x) => x.areaM2)).toFixed(0)} m²；商业平均 ${avg(com.map((x) => x.areaM2)).toFixed(0)} m²；全城中位 ${medAll.toFixed(0)} m²`);
  // 阈值随层级更新：多了「张量一级分区」之后每个二级地块比原来小，
  // CBD 大底盘从 ~930 m² 收到 ~670 m²。判据改成**相对全城中位 ≥ 4 倍**，
  // 仍然锁住「CBD 单栋明显更大」，且不会把结构变化误判成回退。
  ok('① CBD 单栋占地明显更大', cbd.length > 0 && maxCbd > 600 && maxCbd >= medAll * 4,
    `最大 ${maxCbd.toFixed(0)} m² = 全城中位的 ${(maxCbd / medAll).toFixed(1)} 倍`);

  // 同一个街区内，住宅楼之间必须出现真实高低差
  const byBlock = new Map<string, number[]>();
  for (const x of rows) {
    if (x.use !== 'residential') continue;
    if (!byBlock.has(x.blockId)) byBlock.set(x.blockId, []);
    byBlock.get(x.blockId)!.push(x.hM);
  }
  const spreads = [...byBlock.values()].filter((hs) => hs.length >= 3).map((hs) => Math.max(...hs) - Math.min(...hs));
  spreads.sort((a, b) => a - b);
  const medSpread = spreads[Math.floor(spreads.length / 2)] ?? 0;
  ok('⑤ 同一街区内住宅有高低差（不再是等高线毯子）', medSpread > 8,
    `${spreads.length} 个街区，中位极差 ${medSpread.toFixed(1)} m`);

  const allH = rows.map((x) => x.hM);
  const distinct = new Set(allH.map((h) => Math.round(h * 2))).size;
  ok('⑤ 全城高度档数足够多', distinct > 25, `${distinct} 档（0.5 m 精度）`);
  ok('城市仍闭合', r.stats.unclaimedM2 === 0 && r.stats.buildingCount > 500,
    `未归属 ${r.stats.unclaimedM2} m² / ${r.stats.buildingCount} 栋`);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} 项断言，${fail} 项失败\n`);
if (fail > 0) process.exitCode = 1;
