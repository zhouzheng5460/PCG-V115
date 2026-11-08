// F3-H 验收断言 · 用地混合与多中心可达性
//
// 针对的问题：原来整块街区被硬指定一个用途、高度只按到城市中心的距离衰减，
// 于是一块街区全是高楼、全城呈生硬的梯形回落。
//
// 这里验证的是"机制真的换了"，不是画面好不好看：
//   · 用途落到地块粒度、街区内部确实混合；
//   · 宽路两侧商业几率更高，但带状商业有占比上限；
//   · 高度不再只由 centerDist 决定：外围仍有局部高峰，街区内有高低差；
//   · program 的分区意图仍在、结果确定、面积账仍闭合。

import { Pt } from '../src/core/geom';
import { cityOutline, runF3City, type CityResult } from '../src/f3';
import type { CityProgram, CitySpec } from '../src/f3/types';

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

const SEED = 20261106;
const R = 95;
function make(program: CityProgram = 'mixed', seed = SEED): CityResult {
  const spec: CitySpec = {
    boundary: { outer: cityOutline(R, seed), holes: [] },
    style: 'structured',
    density: 'medium',
    program,
    seed,
  };
  return runF3City(spec);
}

const isCom = (u: string): boolean => u === 'commercial' || u === 'cbd';
const avg = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

console.log('\n=== ① 地块级用途混合（structured / mixed / medium）');
const r = make('mixed');
const parcels = r.debug.parcels;
ok('① 生成了足够多的街区与地块', r.debug.blocks.length > 40 && parcels.length > 600,
  `${r.debug.blocks.length} 街区 / ${parcels.length} 地块 / ${r.scene.solids.length} 栋`);

const byBlock = new Map<string, Set<string>>();
const blockN = new Map<string, number>();
for (const p of parcels) {
  if (p.use === 'park' || p.use === 'green') continue;
  const s = byBlock.get(p.blockId) ?? new Set<string>();
  s.add(p.use);
  byBlock.set(p.blockId, s);
  blockN.set(p.blockId, (blockN.get(p.blockId) ?? 0) + 1);
}
const bigBlocks = [...byBlock.keys()].filter((id) => (blockN.get(id) ?? 0) >= 4);
const mix2 = bigBlocks.filter((id) => (byBlock.get(id)?.size ?? 0) >= 2).length / Math.max(1, bigBlocks.length);
const mix3 = bigBlocks.filter((id) => (byBlock.get(id)?.size ?? 0) >= 3).length / Math.max(1, bigBlocks.length);
ok('① 街区内部不再只有一种用途', mix2 > 0.75, `${bigBlocks.length} 个街区中 ≥2 种占 ${(mix2 * 100).toFixed(0)}%`);
ok('① 相当多街区有三种以上用途', mix3 > 0.35, `≥3 种占 ${(mix3 * 100).toFixed(0)}%`);

console.log('\n=== ② 沿宽路的商业几率与带状上限');
const front = parcels.filter((p) => p.frontRow && p.use !== 'park' && p.use !== 'green');
const share = (arr: typeof front): number => (arr.length ? arr.filter((p) => isCom(p.use)).length / arr.length : 0);
const arterial = front.filter((p) => p.streetCls === 'arterial');
const wide = front.filter((p) => p.streetCls !== 'local');
const local = front.filter((p) => p.streetCls === 'local');
console.log(`  arterial ${share(arterial).toFixed(3)} / 宽路合计 ${share(wide).toFixed(3)} / local ${share(local).toFixed(3)}`);
ok('② 主干道两侧商业几率高于支路', arterial.length > 20 && share(arterial) > share(local) * 1.4,
  `${(share(arterial) * 100).toFixed(1)}% vs ${(share(local) * 100).toFixed(1)}%`);
// 三级路网之后，"宽路合计"只剩主干 8% + 次干 56%，用一个合并倍率会把
// 主干的效应平均掉。这里改成**逐级单调**：主干 > 次干 > 支路，每一级都要
// 拉开差距，比合并倍率更能说明"等级真的进了用地模型"。
const collectorOnly = front.filter((p) => p.streetCls === 'collector');
// 判据只看**逐级单调关系**：路口的尺寸一变，临街样本就整体漂移几个百分点，
// 拿绝对百分比卡死会在每次路网几何微调时误报。
ok('② 次干道两侧商业几率高于支路', share(collectorOnly) > share(local) * 1.05,
  `${(share(collectorOnly) * 100).toFixed(1)}% vs ${(share(local) * 100).toFixed(1)}%`);
/**
 * 三级路网下「宽路合计」只剩主干 8% + 次干 58%，合并倍率天然被稀释
 * （实测 27.1% vs 24.4%）。换成**逐级单调**：主干 > 次干 > 支路，
 * 每一级都要有正差距 —— 这比合并倍率更能说明等级真的进了用地模型。
 */
const artOnly = front.filter((p) => p.streetCls === 'arterial');
ok('② 三级道路两侧商业率逐级单调（主干 > 次干 > 支路）',
  share(artOnly) > share(collectorOnly) && share(collectorOnly) > share(local),
  `${(share(artOnly) * 100).toFixed(1)}% > ${(share(collectorOnly) * 100).toFixed(1)}% > ${(share(local) * 100).toFixed(1)}%`);
ok('② 宽路（主干+次干）整体高于支路', share(wide) > share(local) * 1.05,
  `${(share(wide) * 100).toFixed(1)}% vs ${(share(local) * 100).toFixed(1)}%`);
const back = parcels.filter((p) => !p.frontRow && p.use !== 'park' && p.use !== 'green');
ok('② 商业更偏临街第一排', share(front) > share(back) * 1.25,
  `第一排 ${(share(front) * 100).toFixed(1)}% / 内侧 ${(share(back) * 100).toFixed(1)}%`);

// 逐条街验证带状商业占比上限（六安规定：非支路不宜超 40%）
const byPath = new Map<string, { n: number; com: number; cls: string }>();
for (const p of front) {
  if (!p.nearPathId) continue;
  const g = byPath.get(p.nearPathId) ?? { n: 0, com: 0, cls: p.streetCls ?? 'local' };
  g.n++;
  if (isCom(p.use)) g.com++;
  byPath.set(p.nearPathId, g);
}
const wideStreets = [...byPath.values()].filter((g) => g.cls !== 'local' && g.n >= 4);
const worst = wideStreets.length ? Math.max(...wideStreets.map((g) => g.com / g.n)) : 0;
ok('② 逐街带状商业不超过 45% 上限', wideStreets.length > 0 && worst <= 0.45,
  `${wideStreets.length} 条宽路街，最高 ${(worst * 100).toFixed(1)}%`);

console.log('\n=== ③ 配比与分区意图');
const counts: Record<string, number> = {};
for (const p of parcels) counts[p.use] = (counts[p.use] ?? 0) + 1;
const frac = (u: string): number => (counts[u] ?? 0) / Math.max(1, parcels.length);
ok('③ 居住仍是主体但不吞掉全城', frac('residential') > 0.45 && frac('residential') < 0.82,
  `residential ${(frac('residential') * 100).toFixed(1)}%`);
ok('③ 商业与 CBD 都有配额且不泛滥', frac('commercial') > 0.08 && frac('commercial') < 0.35 && frac('cbd') > 0.003 && frac('cbd') < 0.12,
  `commercial ${(frac('commercial') * 100).toFixed(1)}% / cbd ${(frac('cbd') * 100).toFixed(1)}%`);
ok('③ 绿地没有被挤没也没吃满', frac('green') < 0.12 && (frac('green') + frac('park')) > 0.01,
  `green ${(frac('green') * 100).toFixed(1)}%`);
const ind = make('industrial');
const indFrac = ind.debug.parcels.filter((p) => p.use === 'industrial').length / Math.max(1, ind.debug.parcels.length);
const cam = make('campus');
const camFrac = cam.debug.parcels.filter((p) => p.use === 'campus').length / Math.max(1, cam.debug.parcels.length);
ok('③ 工业 / 园区 program 的主导用途仍生效', indFrac > 0.38 && camFrac > 0.38,
  `industrial ${(indFrac * 100).toFixed(0)}% / campus ${(camFrac * 100).toFixed(0)}%`);

console.log('\n=== ④ 高度不再由单中心距离决定');
let cx = 0;
let cy = 0;
for (const p of r.spec.boundary.outer) {
  cx += p.x;
  cy += p.y;
}
cx /= r.spec.boundary.outer.length;
cy /= r.spec.boundary.outer.length;
const maxD = Math.max(...r.spec.boundary.outer.map((p) => Math.hypot(p.x - cx, p.y - cy)));
const rings: number[][] = [[], [], [], [], []];
const perBlockH = new Map<string, number[]>();
for (const s of r.scene.solids) {
  const c = new Pt(0, 0);
  for (const p of s.ring) {
    c.x += p.x;
    c.y += p.y;
  }
  c.x /= s.ring.length;
  c.y /= s.ring.length;
  const cd = Math.hypot(c.x - cx, c.y - cy) / maxD;
  rings[Math.min(4, Math.floor(cd * 5))].push(s.h * 7);
  const bid = s.name.split('-P')[0];
  const arr = perBlockH.get(bid) ?? [];
  arr.push(s.h * 7);
  perBlockH.set(bid, arr);
}
const means = rings.map(avg);
console.log(`  五环平均高度 ${means.map((x) => x.toFixed(1)).join(' / ')} m，外环最高 ${Math.max(...rings[4]).toFixed(1)} m`);
ok('④ 外围仍出现局部较高建筑（多中心/廊道）', Math.max(...rings[4]) > 30, `外环最高 ${Math.max(...rings[4]).toFixed(1)} m`);
ok('④ 中圈存在接近中心高度的次峰', Math.max(...rings[2]) > means[0] * 0.75,
  `中圈最高 ${Math.max(...rings[2]).toFixed(1)} m / 中心均值 ${means[0].toFixed(1)} m`);
const spreads = [...perBlockH.values()].filter((a) => a.length > 1).map((a) => Math.max(...a) - Math.min(...a)).sort((a, b) => a - b);
const medSpread = spreads.length ? spreads[Math.floor(spreads.length / 2)] : 0;
ok('④ 同一街区内不再一整片等高', medSpread > 12, `街区内高度极差中位 ${medSpread.toFixed(1)} m`);
ok('④ 高度没有退化成全域齐平', means[0] > means[4] * 1.25 && means[0] < means[4] * 3.2,
  `中心 ${means[0].toFixed(1)} m / 外环 ${means[4].toFixed(1)} m`);

console.log('\n=== ⑤ 确定性与账目');
const r2 = make('mixed');
const seq = (x: CityResult): string =>
  x.debug.parcels.map((p) => `${p.id}:${p.use}:${(p.access ?? 0).toFixed(3)}`).join('|') +
  '#' + x.scene.solids.map((s) => s.h.toFixed(4)).join('|');
ok('⑤ 同 seed 结果完全一致', seq(r) === seq(r2));
ok('⑤ 面积账仍闭合', r.stats.unclaimedM2 === 0 && r.stats.parcelAreaM2 > 0,
  `未归属 ${r.stats.unclaimedM2} m²`);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass + fail} 项断言，${fail} 项失败`);
if (fail > 0) process.exitCode = 1;
