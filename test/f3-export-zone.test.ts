// 导出层级 + 禁区剔除建筑
//
// ① GLB 的节点必须是一棵**目录树**：城市 / 街道-街道设施-街区 / 建筑-地面铺装-植物，
//    不能再是"2000 个 mesh 平铺在根下"（那样进 Blender 没法按街区选中）。
// ② 禁区与建筑重叠时：**整栋不生成**，而不是把楼切成半截；被让出来的地由禁区铺装接管。

import { Pt } from '../src/core/geom';
import { cityOutline, runF3City, type CityResult } from '../src/f3';
import { makeZone, zoneToPolygon } from '../src/town/zones';
import { applyZonesToCity } from '../src/f3/zoneapply';
import { sceneToPrimitives } from '../src/export/build3d';
import { exportGLB } from '../src/export/glb';
import { insideSurface, surfaceArea, surfaceIntersect, type PlanSurface } from '../src/town/planning/core/surface';

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
const seed = 682063530;
const base = {
  boundary: { outer: cityOutline(60, seed, 11), holes: [] as Pt[][] },
  style: 'structured' as const,
  density: 'low' as const,
  program: 'mixed' as const,
  seed,
};

// ---------------------------------------------------------------- ① 导出层级
const city = runF3City(base);
const prims = sceneToPrimitives(city.scene, { cityRadius: 60, merge: 'layer' });
const glb = exportGLB(prims, 'townforge-test');
const dv = new DataView(glb.bytes.buffer, glb.bytes.byteOffset, glb.bytes.byteLength);
const jsonLen = dv.getUint32(12, true);
const gltf = JSON.parse(new TextDecoder().decode(glb.bytes.subarray(20, 20 + jsonLen))) as {
  scenes: { nodes: number[] }[];
  nodes: { name: string; children?: number[]; mesh?: number }[];
};
const nodes = gltf.nodes;

ok('场景只有一个根节点', gltf.scenes[0].nodes.length === 1, `${gltf.scenes[0].nodes.length}`);
ok('根节点叫「城市」', nodes[gltf.scenes[0].nodes[0]]?.name === '城市', nodes[gltf.scenes[0].nodes[0]]?.name ?? '?');

/** 收集所有"从根到叶子"的路径 */
const paths: string[][] = [];
const walk = (i: number, acc: string[]): void => {
  const n = nodes[i];
  const next = [...acc, n.name];
  if (n.mesh !== undefined) {
    paths.push(next);
    return;
  }
  for (const c of n.children ?? []) walk(c, next);
};
walk(gltf.scenes[0].nodes[0], []);

const hasPrefix = (pre: string[]): boolean => paths.some((p) => pre.every((seg, i) => p[i] === seg));
const blocks = city.debug.blocks.slice(0, 3).map((b) => b.id);
console.log(`  叶子节点 ${paths.length} 个；示例：${paths.slice(0, 3).map((p) => p.join('/')).join(' | ')}`);

ok('有「城市/街道/车行道」', hasPrefix(['城市', '街道', '车行道']));
ok('有「城市/街道/标线」', hasPrefix(['城市', '街道', '标线']));
ok('有「城市/街道设施/…」', hasPrefix(['城市', '街道设施']));
ok('有「城市/街区/<街区号>/建筑」', hasPrefix(['城市', '街区', blocks[0], '建筑']), blocks[0]);
ok('有「城市/街区/<街区号>/地面铺装」', hasPrefix(['城市', '街区', blocks[0], '地面铺装']));
// 植物不是每个街区都有（有的街区一棵树都没有），所以断言"至少某个街区有"
const plantLeaves = paths.filter((p) => p[1] === '街区' && p[3] === '植物');
ok('有「城市/街区/<街区号>/植物」', plantLeaves.length > 0, `${plantLeaves.length} 个植物节点`);

/**
 * **每种合并方式都不能丢内容**。
 *
 * 之前 `block` 合并把"不属于任何街区的要素"（街道 / 街道设施 / 城市底图）
 * 全塞进 `街区/city`，Blender 里只看到 `城市/街区/B1/...`，街道整棵子树消失。
 * 这里直接用"三角形总数一致 + 关键子树存在"来守。
 */
{
  const triOf = (prims: { indices: number[] }[]): number => prims.reduce((a, p) => a + p.indices.length / 3, 0);
  const base = triOf(prims);
  for (const mode of ['block', 'material'] as const) {
    const p2 = sceneToPrimitives(city.scene, { cityRadius: 60, merge: mode });
    ok(`${mode} 合并不丢三角形`, triOf(p2) === base, `${base} vs ${triOf(p2)}`);
  }
  const blockPrims = sceneToPrimitives(city.scene, { cityRadius: 60, merge: 'block' });
  const g2 = exportGLB(blockPrims, 'x');
  const dv2 = new DataView(g2.bytes.buffer, g2.bytes.byteOffset, g2.bytes.byteLength);
  const len2 = dv2.getUint32(12, true);
  const gltf2 = JSON.parse(new TextDecoder().decode(g2.bytes.subarray(20, 20 + len2))) as {
    scenes: { nodes: number[] }[];
    nodes: { name: string; children?: number[]; mesh?: number }[];
  };
  const paths2: string[][] = [];
  const walk2 = (idx: number, acc: string[]): void => {
    const n2 = gltf2.nodes[idx];
    const next = [...acc, n2.name];
    if (n2.mesh !== undefined) {
      paths2.push(next);
      return;
    }
    for (const c of n2.children ?? []) walk2(c, next);
  };
  walk2(gltf2.scenes[0].nodes[0], []);
  ok('block 合并保留「街道」子树', paths2.some((p) => p[1] === '街道'));
  ok('block 合并保留「街道设施」子树', paths2.some((p) => p[1] === '街道设施'));
  ok('block 合并保留「地面铺装」子树', paths2.some((p) => p[3] === '地面铺装'));
  ok('block 合并保留「植物」子树', paths2.some((p) => p[3] === '植物'));
}

// 建筑必须是一栋一个叶子（不能整片街区并成一个）
const buildingLeaves = paths.filter((p) => p.length >= 5 && p[2] === blocks[0] && p[3] === '建筑');
ok('建筑是一栋一个节点（不是并成一片）', buildingLeaves.length > 3, `${buildingLeaves.length} 栋`);

// ---------------------------------------------------------------- ② 禁区剔楼
const zone = makeZone('z1', '禁区', { kind: 'rect', a: new Pt(-26, -18), b: new Pt(6, 18) }, 'cbd');
const zr = { outer: zoneToPolygon(zone), holes: [] as Pt[][] };
const overlapOf = (r: CityResult): { n: number; areaM2: number } => {
  let n = 0;
  let areaM2 = 0;
  for (const s of r.scene.solids) {
    const bb = {
      minX: Math.min(...s.ring.map((p) => p.x)),
      maxX: Math.max(...s.ring.map((p) => p.x)),
      minY: Math.min(...s.ring.map((p) => p.y)),
      maxY: Math.max(...s.ring.map((p) => p.y)),
    };
    if (!insideSurface(new Pt((bb.minX + bb.maxX) / 2, (bb.minY + bb.maxY) / 2), zr)) continue;
    let hit;
    try {
      hit = surfaceIntersect([{ outer: s.ring, holes: [] }], [zr]);
    } catch {
      continue;
    }
    const A = hit.reduce((x, q) => x + M2(surfaceArea(q)), 0);
    if (A > 1) {
      n++;
      areaM2 += A;
    }
  }
  return { n, areaM2 };
};

const noZone = overlapOf(city);
// 禁区现在是**后处理**（不动路网、不重算整城），所以这里直接叠加一层
const withZone = applyZonesToCity(city, [zone], { padM: 0, padPave: true });
const zoned = overlapOf(withZone);
/**
 * 路面：**禁区本体**要挖掉（用户："与禁区重叠的道路还是要影响的"），
 * 但**让距**不能碰路（"让距范围影响的道路不要调整"）。
 */
{
  const padZone = applyZonesToCity(city, [zone], { padM: 10, padPave: true });
  const roads = padZone.scene.surfaces.filter((s) => s.group.startsWith('road/'));
  const roadAt = (p: Pt): boolean =>
    roads.some((s) => insideSurface(p, { outer: s.ring, holes: s.holes ?? [] } as PlanSurface));
  let coreHits = 0;
  let padHits = 0;
  for (let x = -34; x <= 14; x += 2) {
    for (let y = -24; y <= 24; y += 2) {
      const p = new Pt(x, y);
      if (!roadAt(p)) continue;
      const inCore = x > -26 && x < 6 && y > -18 && y < 18;
      const inPad = !inCore && x > -36 && x < 16 && y > -28 && y < 28;
      if (inCore) coreHits++;
      else if (inPad) padHits++;
    }
  }
  console.log(`  路面采样：禁区本体 ${coreHits} / 让距环带 ${padHits}`);
  ok('禁区本体范围内的路面被挖掉', coreHits === 0, `${coreHits} 个采样点仍有路面`);
  ok('让距范围内的路面不受影响', padHits > 0, `${padHits} 个采样点仍是路面`);
}

console.log(`  与禁区重叠建筑：无禁区 ${noZone.n} 栋 / ${noZone.areaM2.toFixed(0)} m² → 有禁区 ${zoned.n} 栋 / ${zoned.areaM2.toFixed(0)} m²`);
ok('基线确实有建筑压在禁区内（否则这条校验没意义）', noZone.n > 0, `${noZone.n} 栋`);
ok('禁区内的建筑被整栋剔除', zoned.n === 0, `${zoned.n} 栋 / ${zoned.areaM2.toFixed(1)} m²`);
ok('剔除后建筑数减少', withZone.stats.buildingCount < city.stats.buildingCount, `${city.stats.buildingCount} → ${withZone.stats.buildingCount}`);
ok(
  '禁区铺装接管了那块地（有 zone_ 面）',
  withZone.scene.surfaces.some((s) => s.name.startsWith('zone_')),
  withZone.scene.surfaces.filter((s) => s.name.startsWith('zone_')).length + ' 片'
);

console.log(fail === 0 ? `\nPASS — ${pass} 项断言，0 项失败` : `\nFAIL — ${pass} 项断言，${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
