// GLB 导出回归（F3 链路 + 四种合并方式）
//
// 这一版没有 legacy 城市了，所以验证对象是 F3 直接产出的 Scene：
//   ① 三角形绕序：绕反了在三维里是"背面朝上"的黑块，必须为 0；
//   ② GLB 容器结构：magic / 版本 / chunk 长度 / accessor 不越界；
//   ③ **合并方式确实起作用**：material ≤ block ≤ layer ≤ none 的网格数必须单调，
//      而不是"选了按材质，导出来还是上万个节点"；
//   ④ 禁区的面确实进了场景（否则"禁区对 F3 无效"会悄悄复发）。

import { writeFileSync, mkdirSync } from 'node:fs';
import sharp from 'sharp';
import { Pt } from '../src/core/geom';
import { cityOutline, runF3City } from '../src/f3';
import { sceneToPrimitives, type GlbMerge } from '../src/export/build3d';
import { exportGLB, checkWinding } from '../src/export/glb';
import { makeZone } from '../src/town/zones';
import { renderPrimitives } from './soft3d';

mkdirSync('out', { recursive: true });

let failures = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (!cond) {
    failures++;
    console.log(`  FAIL ${name} ${detail}`);
  }
};

const radius = 62;
const seed = 20261109;
const zone = makeZone('z1', '禁区', { kind: 'circle', c: new Pt(0, 0), r: 14 }, 'park');
const city = runF3City({
  boundary: { outer: cityOutline(radius, seed, 11), holes: [] as Pt[][] },
  style: 'structured',
  density: 'medium',
  program: 'mixed',
  seed,
  zones: [zone],
  zonePadM: 6,
});
console.log(
  `F3 城：${city.stats.blockCount} 街区 / ${city.stats.parcelCount} 地块 / ${city.stats.buildingCount} 建筑 · 面 ${city.scene.surfaces.length} · 体 ${city.scene.solids.length}`
);

// 禁区的面进了场景
const zoneFaces = city.scene.surfaces.filter((s) => s.name.startsWith('zone_'));
check('禁区铺装进了场景', zoneFaces.length > 0, `${zoneFaces.length} 片`);
// 禁区铺装的材质口径（用户后来说定的）：
//   · 主体是草地，但**随机 2~4 种深浅**，不再整片一个 `lawn`；
//   · 每隔几片插一条内部路 `lotPath`（把禁区切细，不然一大块草太假）。
// 所以这里校验的是"只有草/内部路，且草确实分了深浅"，不是"全是 lawn"。
const zoneGreens = zoneFaces.filter((s) => s.mat.startsWith('grass') || s.mat === 'lawn');
check(
  '禁区铺装只有草地与内部路',
  zoneFaces.every((s) => zoneGreens.includes(s) || s.mat === 'lotPath'),
  [...new Set(zoneFaces.map((s) => s.mat))].join(',')
);
check('禁区里有草地', zoneGreens.length > 0, `${zoneGreens.length} 片`);
check(
  '禁区草地分了深浅（不是整片一个色）',
  new Set(zoneGreens.map((s) => s.mat)).size >= 2,
  [...new Set(zoneGreens.map((s) => s.mat))].join(',')
);
// 禁区里的建筑必须整栋消失（不是布尔切一半）
const inZone = (x: number, y: number): boolean => Math.hypot(x, y) < 13.2;
const ringCenter = (r: Pt[]): { x: number; y: number } => ({
  x: r.reduce((a, p) => a + p.x, 0) / Math.max(1, r.length),
  y: r.reduce((a, p) => a + p.y, 0) / Math.max(1, r.length),
});
const strayBuildings = city.scene.solids.filter((s) => {
  if (s.kind !== 'building') return false;
  const c = ringCenter(s.ring);
  return inZone(c.x, c.y);
});
check('禁区里没有建筑（整栋剔除）', strayBuildings.length === 0, `${strayBuildings.length} 栋`);

const counts: Record<string, number> = {};
const modes: GlbMerge[] = ['layer', 'material', 'block', 'none'];
for (const merge of modes) {
  const prims = sceneToPrimitives(city.scene, { cityRadius: radius, merge });

  let badTris = 0;
  for (const p of prims) badTris += checkWinding(p);
  const totalTris = prims.reduce((s, p) => s + p.indices.length / 3, 0);
  counts[merge] = prims.length;
  console.log(`  ${merge}: ${prims.length} 网格 / ${totalTris} 三角形 / 绕序异常 ${badTris}`);
  check(`${merge} 绕序全部正确`, badTris === 0, `${badTris}`);

  const glb = exportGLB(prims, `townforge-f3-${merge}`);
  writeFileSync(`out/glb-${merge}.glb`, glb.bytes);

  const dv = new DataView(glb.bytes.buffer, glb.bytes.byteOffset, glb.bytes.byteLength);
  check('GLB magic', dv.getUint32(0, true) === 0x46546c67);
  check('GLB version=2', dv.getUint32(4, true) === 2);
  check('GLB length 字段正确', dv.getUint32(8, true) === glb.bytes.byteLength, `${dv.getUint32(8, true)} vs ${glb.bytes.byteLength}`);

  const jsonLen = dv.getUint32(12, true);
  check('JSON chunk 类型', dv.getUint32(16, true) === 0x4e4f534a);
  const gltf = JSON.parse(new TextDecoder().decode(glb.bytes.subarray(20, 20 + jsonLen)));
  check('glTF 版本 2.0', gltf.asset.version === '2.0');
  check('mesh 数与基元数一致', gltf.meshes.length === prims.length, `${gltf.meshes.length} vs ${prims.length}`);

  let oob = 0;
  for (const acc of gltf.accessors) {
    const bv = gltf.bufferViews[acc.bufferView];
    const numComp = acc.type === 'VEC3' ? 3 : 1;
    if (bv.byteOffset + bv.byteLength > gltf.buffers[0].byteLength) oob++;
    if (acc.byteOffset + acc.count * numComp * 4 > bv.byteLength) oob++;
  }
  check('accessor 未越界', oob === 0, `${oob}`);
  console.log(`    GLB ${(glb.bytes.byteLength / 1024 / 1024).toFixed(2)} MB / ${glb.meshes} 网格`);
}

// 合并的单调性：material 最粗、none 最细
check('按材质比按图层更少网格', counts.material <= counts.layer, `${counts.material} vs ${counts.layer}`);
check('按街区+类型不比按图层多', counts.block <= counts.layer, `${counts.block} vs ${counts.layer}`);
check('不合并的网格数最多', counts.none >= counts.layer, `${counts.none} vs ${counts.layer}`);

// 软件渲染：轴测 + 俯视（顶上视角 = 产品里的"正交顶视"）
const prims = sceneToPrimitives(city.scene, { cityRadius: radius, merge: 'layer' });
const iso = renderPrimitives(prims, { size: 900, azimuth: 40, elevation: 32 });
await sharp(Buffer.from(iso.rgba), { raw: { width: iso.width, height: iso.height, channels: 4 } })
  .png()
  .toFile('out/glb-iso.png');
const top = renderPrimitives(prims, { size: 900, azimuth: 0, elevation: 89, zoom: 1.4 });
await sharp(Buffer.from(top.rgba), { raw: { width: top.width, height: top.height, channels: 4 } })
  .png()
  .toFile('out/glb-top.png');
console.log('  rendered out/glb-iso.png / out/glb-top.png');

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
