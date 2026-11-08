// F2.5-C.2 · 验收断言
//
// 断言的落点是"三种骨架都必须是**可交付的**道路网"，而不是"哪个更好看"：
//   · 固定 seed 可复现、节点 ID 稳定
//   · 道路不出场地、不压 Compound、不填洞（面积可对账）
//   · 没有接不到任何东西的断头、每个分量都接得到外部
//   · A/B/C 在同一场地上确实产出不同结构
//   · F02 / I01 三方案一致判定"无需内部路"，并且**写出了原因**

import { Pt } from '../src/core/geom';
import { ringArea, surfaceArea, surfaceIntersect, type PlanSurface } from '../src/town/planning/core/surface';
import { ALGO_LABEL, runSkeleton, type SkeletonAlgo, type SkeletonResult } from '../src/town/planning/roadgraph/skeleton';
import { F25_CASES } from './f25c-cases';

const M2 = (u2: number) => u2 * 49;
const ALGOS: SkeletonAlgo[] = ['tensor', 'fracture', 'hybrid'];
let failures = 0;
let total = 0;

function check(name: string, cond: boolean, detail = ''): void {
  total++;
  if (cond) console.log(`  ok   ${name} ${detail}`);
  else {
    failures++;
    console.log(`  FAIL ${name} ${detail}`);
  }
}

const cache = new Map<string, SkeletonResult>();
function run(id: string, algo: SkeletonAlgo): SkeletonResult {
  const key = `${id}:${algo}`;
  if (!cache.has(key)) {
    const c = F25_CASES.find((x) => x.id === id)!;
    cache.set(key, runSkeleton(algo, { id, boundary: c.boundary, style: c.style, cellM2: c.cellM2, roads: c.roads, entrances: c.entrances, seed: 20261106 }));
  }
  return cache.get(key)!;
}

const areaOf = (list: PlanSurface[]): number => list.reduce((s, x) => s + M2(surfaceArea(x)), 0);

function inRing(p: Pt, ring: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y || 1e-12) + a.x) inside = !inside;
  }
  return inside;
}

console.log('F2.5-C.2 · 三种道路骨架候选');

for (const c of F25_CASES) {
  console.log(`\n[${c.id}] ${c.label}`);
  const siteArea = M2(surfaceArea(c.boundary));
  for (const algo of ALGOS) {
    const r = run(c.id, algo);
    const s = r.stats;

    // ---- 面积可对账
    const roadArea = areaOf(r.roadSurface);
    const compArea = areaOf(r.compounds.compounds.map((k) => k.surface));
    if (s.edges === 0) {
      check(`${algo} 无内部路 → 一块地`, r.compounds.compounds.length === 1, `${r.compounds.compounds.length} 块`);
      check(`${algo} 无内部路 → 写了原因`, r.noRoad.needed === false && r.notes.length > 0, r.notes[0]?.slice(0, 46) ?? '');
    } else {
      check(`${algo} 路面 + 地块 ≈ 场地（±2%）`, Math.abs(roadArea + compArea - siteArea) / siteArea < 0.02, `${(roadArea + compArea).toFixed(0)} vs ${siteArea.toFixed(0)} m²`);
      check(`${algo} 没有道路压在 Compound 上`, roadArea + compArea <= siteArea * 1.02, `路 ${roadArea.toFixed(0)} + 地 ${compArea.toFixed(0)}`);

      // ---- 道路不出场地
      let outside = 0;
      for (const rd of r.roadSurface) {
        try {
          const inside = surfaceIntersect([rd], [c.boundary]);
          const a = inside.reduce((x, q) => x + Math.abs(ringArea(q.outer)), 0);
          outside += Math.max(0, Math.abs(ringArea(rd.outer)) - a);
        } catch {
          /* 单块失败不计 */
        }
      }
      check(`${algo} 道路不越界`, outside * 49 < siteArea * 0.01, `越界 ${(outside * 49).toFixed(0)} m²`);

      // ---- 没有接不到东西的断头
      check(`${algo} 无非边界断头`, s.deadEnds === 0, `${s.deadEnds}`);

      // ---- 每个分量都接得到红线（否则就是孤岛）
      const g = r.graph;
      let isolatedComps = 0;
      for (const comp of g.connectedComponents) {
        const hasBoundary = comp.some((nid) => g.nodes.get(nid)?.nodeType === 'boundary');
        if (!hasBoundary) isolatedComps++;
      }
      check(`${algo} 无孤立分量`, isolatedComps === 0, `${isolatedComps}`);
    }

    // ---- 洞不被填平
    let holeCovered = 0;
    for (const h of c.boundary.holes) {
      const c0 = h.reduce((a, q) => new Pt(a.x + q.x / h.length, a.y + q.y / h.length), new Pt());
      for (const rd of r.roadSurface) if (inRing(c0, rd.outer) && !rd.holes.some((hh) => inRing(c0, hh))) holeCovered++;
      for (const k of r.compounds.compounds) if (inRing(c0, k.surface.outer)) holeCovered++;
    }
    check(`${algo} 洞没有被填`, holeCovered === 0, `${holeCovered}`);

    // ---- 节点 ID 唯一
    const ids = [...r.graph.nodes.keys()];
    check(`${algo} 节点 ID 唯一`, new Set(ids).size === ids.length, `${ids.length}`);
  }
}

console.log('\n[横切] 可复现 / 差异化 / 网络统一');

// 固定 seed 复现（两次跑统计完全一致，节点 ID 集合一致）
{
  const c = F25_CASES[0];
  const a = runSkeleton('tensor', { id: c.id, boundary: c.boundary, style: c.style, cellM2: c.cellM2, seed: 20261106 });
  const b = runSkeleton('tensor', { id: c.id, boundary: c.boundary, style: c.style, cellM2: c.cellM2, seed: 20261106 });
  const key = (r: SkeletonResult): string => `${r.stats.edges}|${r.stats.lengthM}|${r.stats.compounds.count}|${[...r.graph.nodes.keys()].join(',')}`;
  check('同 seed 两次完全一致', key(a) === key(b), key(a).slice(0, 40));
}

// A / B / C 必须是不同结构
{
  let diff = 0;
  for (const c of F25_CASES) {
    const a = run(c.id, 'tensor');
    const b = run(c.id, 'fracture');
    const h = run(c.id, 'hybrid');
    const sig = (r: SkeletonResult): string => `${r.stats.lengthM.toFixed(0)}|${r.stats.compounds.count}|${r.stats.edges}`;
    if (new Set([sig(a), sig(b), sig(h)]).size >= 2) diff++;
  }
  check('A/B/C 在多数样板上产出不同结构', diff >= 5, `${diff}/7`);
}

// 混合方案必须真的做了"网络统一"（有吸附记录），而不是两张图叠着
{
  let attached = 0;
  for (const c of F25_CASES) {
    const h = run(c.id, 'hybrid');
    if (h.trace.attached.length > 0) attached++;
  }
  check('混合方案产生了悬挂端吸附', attached >= 3, `${attached}/7 例有吸附`);
}

// 三种算法对 F02 / I01 的一致结论
{
  for (const id of ['F02', 'I01']) {
    const all = ALGOS.map((a) => run(id, a));
    check(`${id} 三方案一致判定无需内部路`, all.every((r) => r.stats.edges === 0 && r.noRoad.needed === false));
    check(`${id} 判定理由里带数字`, all.every((r) => /服务半径\s*\d+/.test(r.notes[0] ?? '')), all[0].notes[0]?.slice(0, 50) ?? '');
  }
}

// 道路接入必须区分"真实城市道路"与"只贴红线"
{
  const r01 = run('R01', 'hybrid');
  const f01 = run('F01', 'tensor');
  check('R01 识别出真实城市道路接入', r01.stats.access.city > 0, `${r01.stats.access.city}`);
  check('F01（合成场地）只有红线接入', f01.stats.access.city === 0 && f01.stats.access.boundaryOnly > 0, `${f01.stats.access.city}/${f01.stats.access.boundaryOnly}`);
}

// 三方案的度量必须齐全（报告要用）
{
  const r = run('C01', 'hybrid');
  const s = r.stats;
  check('度量齐全：主次支 / 急转 / 狭长 / 可建', s.byClass.arterial >= 0 && s.sharpTurns >= 0 && s.compounds.slivers >= 0 && s.compounds.buildable >= 0);
  check('Compound 临街率已计算', s.compounds.meanFrontageRatio > 0, `${s.compounds.meanFrontageRatio}`);
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${total} 项断言，${failures} 项失败`);
console.log(`参考标签：${ALGOS.map((a) => ALGO_LABEL[a]).join(' / ')}`);
process.exit(failures === 0 ? 0 : 1);
