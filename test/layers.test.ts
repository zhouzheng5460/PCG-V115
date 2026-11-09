// 图层显隐回归（F3 链路）。
//
// 这一层只守一件事：**每一个场景要素都必然属于一个登记过的图层**。
// 之前"关掉行道树，地块里的树还在"就是因为有要素在开关之外，用户就会觉得"不受控"。
//
// 断言分四类：
//   ① 无孤儿：四类要素的 layerOf* 结果全部能在清单里找到；
//   ② 无漏项：清单里的每一项都真的能被过滤（false 时确实被剔除）；
//   ③ 植物：地块内 + 街道两侧 + 禁区的树都要受控；
//   ④ 三维与导出一致：图层过滤发生在**三角形化之前**，关掉之后三角形真的变少、全关为空。

import { Pt } from '../src/core/geom';
import { cityOutline, runF3City } from '../src/f3';
import { sceneToPrimitives } from '../src/export/build3d';
import { makeZone } from '../src/town/zones';
import {
  LAYER_GROUPS,
  defaultVisibility,
  layerOfPath,
  layerOfProp,
  layerOfSolid,
  layerOfSurface,
  makeFilter,
  sceneLayerSig,
} from '../src/scene/layers';

let fail = 0;
let n = 0;
function ok(cond: boolean, msg: string): void {
  n++;
  if (!cond) {
    console.log(`  FAIL ${msg}`);
    fail++;
  }
}

const zone = makeZone('z', '禁区', { kind: 'rect', a: new Pt(-40, -14), b: new Pt(-8, 20) }, 'forest');
const seed = 424242;
const radius = 68;
const city = runF3City({
  boundary: { outer: cityOutline(radius, seed, 11), holes: [] as Pt[][] },
  style: 'structured',
  density: 'medium',
  program: 'mixed',
  seed,
  zones: [zone],
  zonePadM: 6,
});
const scene = city.scene;

// ---------------------------------------------------------------- ① 无孤儿
const known = new Set<string>();
for (const g of LAYER_GROUPS) for (const it of g.items) known.add(it.id);

const orphans = new Map<string, number>();
const bump = (id: string): void => {
  if (known.has(id)) return;
  orphans.set(id, (orphans.get(id) ?? 0) + 1);
};
for (const s of scene.surfaces) bump(layerOfSurface(s));
for (const s of scene.solids) bump(layerOfSolid(s));
for (const p of scene.props) bump(layerOfProp(p));
for (const p of scene.paths) bump(layerOfPath(p));

ok(orphans.size === 0, `没有孤儿要素（未登记图层：${[...orphans].map(([k, v]) => `${k}×${v}`).join(', ') || '无'}）`);
console.log(`  要素：面 ${scene.surfaces.length} / 体 ${scene.solids.length} / 道具 ${scene.props.length} / 线 ${scene.paths.length}`);

// ---------------------------------------------------------------- ② 无漏项
const vis = defaultVisibility();
ok(Object.keys(vis).length === known.size, `默认显隐覆盖全部 ${known.size} 个图层`);

const byLayer = new Map<string, number>();
const count = (id: string): void => {
  byLayer.set(id, (byLayer.get(id) ?? 0) + 1);
};
for (const s of scene.surfaces) count(layerOfSurface(s));
for (const s of scene.solids) count(layerOfSolid(s));
for (const p of scene.props) count(layerOfProp(p));
for (const p of scene.paths) count(layerOfPath(p));

let leak = 0;
for (const [id] of byLayer) {
  const f = makeFilter({ ...vis, [id]: false });
  let left = 0;
  for (const s of scene.surfaces) if (layerOfSurface(s) === id && f(layerOfSurface(s))) left++;
  for (const s of scene.solids) if (layerOfSolid(s) === id && f(layerOfSolid(s))) left++;
  for (const p of scene.props) if (layerOfProp(p) === id && f(layerOfProp(p))) left++;
  for (const p of scene.paths) if (layerOfPath(p) === id && f(layerOfPath(p))) left++;
  if (left > 0) {
    leak++;
    console.log(`  FAIL 图层 ${id} 关掉后仍剩 ${left} 个要素`);
  }
}
ok(leak === 0, `每个图层关掉后都真的清空（漏项 ${leak} 个）`);

// ---------------------------------------------------------------- ③ 树：地块 + 街道 + 禁区
const treeKinds = new Set(['prop:tree', 'prop:treeSmall', 'prop:conifer']);
let lotTrees = 0;
let zoneTrees = 0;
for (const p of scene.props) {
  if (!treeKinds.has(layerOfProp(p))) continue;
  if (p.group === 'lot/park' || p.group === 'lot/green') zoneTrees++;
  else lotTrees++;
}
ok(lotTrees > 0, `地块与街道里有树（${lotTrees} 棵）`);
ok(zoneTrees > 0, `禁区（林地）里也有树（${zoneTrees} 棵）`);

const noPlants = makeFilter({ ...vis, 'prop:tree': false, 'prop:treeSmall': false, 'prop:conifer': false, 'prop:hedge': false });
ok(
  scene.props.filter((p) => treeKinds.has(layerOfProp(p)) && noPlants(layerOfProp(p))).length === 0,
  '关掉植物类之后一棵树都不剩（地块 + 街道 + 禁区）'
);

// ---------------------------------------------------------------- ④ 三维与导出一致
const tris = (prims: { indices: number[] }[]): number => prims.reduce((a, p) => a + p.indices.length / 3, 0);
const triFull = tris(sceneToPrimitives(scene, { cityRadius: radius }));
const triNoPlants = tris(sceneToPrimitives(scene, { cityRadius: radius, layers: noPlants }));
ok(triNoPlants < triFull, `三角形确实剔掉了植物（${triFull} → ${triNoPlants}）`);

const allOff = makeFilter(Object.fromEntries([...known].map((k) => [k, false])));
const triEmpty = tris(sceneToPrimitives(scene, { cityRadius: radius, layers: allOff }));
ok(triEmpty === 0, `全部关掉后导出为空（${triEmpty} 三角形）`);

// ---------------------------------------------------------------- ⑤ 显隐签名
const sigA = sceneLayerSig(vis);
const sigB = sceneLayerSig({ ...vis, 'prop:lamp': false });
ok(sigA !== sigB, '显隐签名能反映变化');
ok(sceneLayerSig({ ...vis }) === sigA, '显隐签名稳定');

console.log(fail === 0 ? `\n# PASS — ${n} 项断言，0 项失败` : `\n# FAIL — ${n} 项断言，${fail} 项失败`);
if (fail > 0) process.exit(1);
