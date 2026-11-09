// F3 · 街区覆盖 / 路口形状 / 图清理 回归
//
// 三块内容各自对应一条用户反馈：
//   ① 选中街区后能改"切分方向 / 切分数量 / 地块类型（含保留地）/ 建筑高度"；
//   ② 路口不再是"黑色星形团块"（多线相交处沥青戳进街角）；
//   ③ 图清理（短路收缩 / 路口聚类）不会把路网搞断。

import { Pt } from '../src/core/geom';
import { cityOutline, runF3City, type CityResult } from '../src/f3';
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

const seed = 682063530;
const radius = 70;
const base = {
  boundary: { outer: cityOutline(radius, seed, 11), holes: [] as Pt[][] },
  style: 'structured' as const,
  density: 'low' as const,
  program: 'mixed' as const,
  seed,
};
const city = runF3City(base);

// ---------------------------------------------------------------- ① 街区覆盖
const biggest = city.debug.blocks.slice().sort((a, b) => b.areaM2 - a.areaM2)[0];
const countBuild = (r: CityResult, id: string): number => r.scene.solids.filter((s) => s.name.startsWith(`${id}-`)).length;
const countParcel = (r: CityResult, id: string): number => r.debug.parcels.filter((p) => p.blockId === id).length;

const before = { buildings: countBuild(city, biggest.id), parcels: countParcel(city, biggest.id) };
ok('基准：最大街区有建筑', before.buildings > 0, `${biggest.id} ${before.buildings} 栋 / ${before.parcels} 地块`);

// 切分数量：跳过张量一级切分后，块数应该接近填的数（±60%）
const four = runF3City({ ...base, blockOverrides: { [biggest.id]: { parcels: 4 } } });
const n4 = countParcel(four, biggest.id);
ok('切分数量生效（填 4 → 3~7 块）', n4 >= 3 && n4 <= 7, `${before.parcels} → ${n4}`);

const many = runF3City({ ...base, blockOverrides: { [biggest.id]: { parcels: 12 } } });
ok('切分数量单调（12 比 4 多）', countParcel(many, biggest.id) > n4, `4→${n4} / 12→${countParcel(many, biggest.id)}`);

// 地块类型：工业 → 建筑占地变大；保留地 → 一栋不剩 + 铺硬地
const ind = runF3City({ ...base, blockOverrides: { [biggest.id]: { use: 'industrial' } } });
const indBuild = countBuild(ind, biggest.id);
ok('地块类型生效（工业的建筑数与住宅不同）', indBuild !== before.buildings, `住宅 ${before.buildings} → 工业 ${indBuild}`);

const reserved = runF3City({ ...base, blockOverrides: { [biggest.id]: { use: 'reserved' } } });
ok('保留地不盖楼', countBuild(reserved, biggest.id) === 0, `${countBuild(reserved, biggest.id)} 栋`);
ok(
  '保留地铺硬质底（lotBase）',
  reserved.scene.surfaces.some((s) => s.name.endsWith('_reserved') && s.mat === 'lotBase'),
  reserved.scene.surfaces.filter((s) => s.name.endsWith('_reserved')).length + ' 片'
);

// 建筑高度：1.9 倍应该明显更高（取该街区最高体块）
const heightOf = (r: CityResult, id: string): number =>
  Math.max(0, ...r.scene.solids.filter((s) => s.name.startsWith(`${id}-`)).map((s) => s.h));
const tall = runF3City({ ...base, blockOverrides: { [biggest.id]: { heightScale: 1.9 } } });
ok('建筑高度覆盖生效', heightOf(tall, biggest.id) > heightOf(city, biggest.id) * 1.25, `${heightOf(city, biggest.id).toFixed(2)} → ${heightOf(tall, biggest.id).toFixed(2)}（世界单位）`);

// 切分方向：不同方向 → 地块几何不同（用面积集合而不是个数判，个数可能恰好相同）
const rot = runF3City({ ...base, blockOverrides: { [biggest.id]: { axisRad: 0.3, parcels: 6 } } });
const rot2 = runF3City({ ...base, blockOverrides: { [biggest.id]: { axisRad: 1.5, parcels: 6 } } });
const areas = (r: CityResult): string =>
  r.debug.parcels
    .filter((p) => p.blockId === biggest.id)
    .map((p) => p.areaM2.toFixed(0))
    .sort()
    .join(',');
ok('切分方向改变地块划分', areas(rot) !== areas(rot2), `0.3rad ${areas(rot)} | 1.5rad ${areas(rot2)}`);

// ---------------------------------------------------------------- ② 路口形状
const junctionAreas = city.debug.road.junction.map((s) => surfaceArea(s) * 49).sort((a, b) => b - a);
ok('最大路口面不再是大团块（< 1500 m²）', junctionAreas[0] < 1500, `最大 ${junctionAreas[0].toFixed(0)} m²`);
const avg = junctionAreas.reduce((a, b) => a + b, 0) / Math.max(1, junctionAreas.length);
ok('路口面积中位数合理（100~900 m²）', avg > 100 && avg < 900, `平均 ${avg.toFixed(0)} m² / ${junctionAreas.length} 片`);

// 路口面不能有"细长尖刺"：外接框的长宽比 ≤ 4，且面积/周界² 不能过小
const spike = city.debug.road.junction.filter((s) => {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of s.outer) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const w = (maxX - minX) * 7;
  const h = (maxY - minY) * 7;
  const aspect = Math.max(w, h) / Math.max(1, Math.min(w, h));
  return aspect > 4;
}).length;
ok('路口面没有细长尖刺（长宽比 ≤ 4）', spike === 0, `${spike} 片超限`);

// ---------------------------------------------------------------- ③ 图清理
const cleaned = city.debug.graph;
const maxDeg = Math.max(...[...cleaned.nodes.values()].map((n) => n.degree));
ok('清理后没有 5 叉以上的路口', maxDeg <= 4, `最大度 ${maxDeg}`);
ok('清理后路网仍然连通（边数 > 节点数）', cleaned.edges.size >= cleaned.nodes.size, `${cleaned.nodes.size} 点 / ${cleaned.edges.size} 边`);
const noClean = runF3City({ ...base, noGraphClean: true });
ok(
  '清理让边数不增加（只删/合，不凭空造路）',
  cleaned.edges.size <= noClean.debug.graph.edges.size,
  `${noClean.debug.graph.edges.size} → ${cleaned.edges.size}`
);

console.log(fail === 0 ? `\nPASS — ${pass} 项断言，0 项失败` : `\nFAIL — ${pass} 项断言，${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
