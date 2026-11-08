// F3 · 单地块"英雄图"：中央建筑 + 真实道路带 + 停车场 + L 形绿化 + 转角花坛 + 硬铺
//
// 全部由代码生成（同一份 Scene），不做任何手工绘制。
// 输出：out/f3/hero_lot.png（总平面 + 图层分解）、hero_lot_3d.png（正交轴测）

import { mkdirSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { Pt } from '../src/core/geom';
import { sceneToPrimitives } from '../src/export/build3d';
import { cityOutline, runF3City } from '../src/f3';
import type { Scene } from '../src/scene/types';
import { bboxOf } from '../src/town/planning/core/surface';
import { renderF3, scenePanel, type F3Panel, type F3Poly } from './f3-draw';
import { renderPrimitives } from './soft3d';

const OUT = 'out/f3';
mkdirSync(OUT, { recursive: true });

const style = (process.argv[2] ?? 'structured') as 'structured' | 'organic' | 'campus';
/** courtyard 模式专挑带近矩形内院的地块，用来对照《houdini 路网(3)》截图 2 */
const mode = process.argv[3] ?? 'commercial';
const suffix = mode === 'courtyard' ? '_courtyard' : '';
const r = runF3City({
  boundary: { outer: cityOutline(95, 20261106), holes: [] },
  style,
  density: 'medium',
  program: 'mixed',
  seed: 20261106,
});

/**
 * 选主角地块：**必须带地面停车场**（否则英雄图讲不出"停车 + 车道 + 绿化"的组合），
 * 优先商业/CBD，其次住宅；面积适中（太小放不下组合，太大看不清）。
 */
const withParking = new Set(
  r.scene.surfaces.filter((s) => s.name.endsWith('_parking')).map((s) => s.name.split('_')[0])
);
const rank = (u: string): number => (u === 'commercial' ? 0 : u === 'cbd' ? 1 : u === 'civic' ? 2 : u === 'residential' ? 3 : 4);
const commercial = r.debug.parcels
  .filter((p) => withParking.has(p.id) && (p.use === 'commercial' || p.use === 'cbd') && p.areaM2 > 500 && p.areaM2 < 5000)
  .sort((a, b) => rank(a.use) - rank(b.use) || b.areaM2 - a.areaM2);
const allRing = r.debug.parcels.filter((p) => p.note.includes('内院') && p.areaM2 > 600 && p.areaM2 < 2500);
const ringCands =
  mode === 'courtyard'
    ? [
        // 住宅围合院落最能代表截图 2，工业大跨地块反而看不出"院子"
        ...allRing.filter((p) => p.use === 'residential').sort((a, b) => b.areaM2 - a.areaM2),
        ...allRing.filter((p) => p.use !== 'residential').sort((a, b) => b.areaM2 - a.areaM2),
      ]
    : [];
const cands = ringCands.length
  ? ringCands
  : commercial.length
    ? commercial
    : r.debug.parcels.filter((p) => withParking.has(p.id) && p.areaM2 > 600 && p.areaM2 < 5000).sort((a, b) => rank(a.use) - rank(b.use) || b.areaM2 - a.areaM2);
const cand = cands[0] ?? r.debug.parcels.sort((a, b) => b.areaM2 - a.areaM2)[0];
if (!cand) throw new Error('没有合适的地块');
const pb = bboxOf(cand.surface.outer);
const pad = 34 / 7;
const box = {
  outer: [
    new Pt(pb.minX - pad, pb.minY - pad),
    new Pt(pb.maxX + pad, pb.minY - pad),
    new Pt(pb.maxX + pad, pb.maxY + pad),
    new Pt(pb.minX - pad, pb.maxY + pad),
  ],
  holes: [],
};

// ---------------- 图层分解（按地面语法上色，用来核对"是不是真的有 L 形/花坛/停车"）
const KIND_FILL: Record<string, string> = {
  paving: '#b9b2a4',
  hard: '#98938a',
  parking: '#4a4f57',
  drive: '#5b6169',
  lawn: '#7fae5e',
  greenL: '#4f9a4a',
  greenEdge: '#63a95a',
  planter: '#2f7d3a',
};
const kindOf = (name: string): string => {
  const k = name.split('_').slice(-1)[0];
  return KIND_FILL[k] ? k : '';
};
// 只保留这个框里的东西：出图取景就不会被整座城撑开
const inBox = (p: Pt): boolean =>
  p.x > box.outer[0].x && p.x < box.outer[2].x && p.y > box.outer[0].y && p.y < box.outer[2].y;
const near = (s: { ring: Pt[] }): boolean => s.ring.some(inBox);

const polys: F3Poly[] = [];
for (const s of r.scene.surfaces) {
  if (!near(s)) continue;
  if (s.group.startsWith('road/')) {
    const fill = s.group === 'road/surface' || s.group === 'road/junction' ? '#23272d' : s.group === 'road/verge' ? '#87b06a' : '#c9c2b3';
    polys.push({ ring: s.ring, holes: s.holes, fill });
    continue;
  }
  if (!s.group.startsWith('lot/')) continue;
  const k = kindOf(s.name);
  if (!k) continue;
  polys.push({ ring: s.ring, holes: s.holes, fill: KIND_FILL[k] });
}
for (const s of r.scene.solids) if (near(s)) polys.push({ ring: s.ring, fill: '#d8d3c8', stroke: '#6d6a63', strokeW: 0.35 });

const labels = [
  { text: '停车', kind: 'parking' },
  { text: '车道', kind: 'drive' },
  { text: 'L 形绿化', kind: 'greenL' },
  { text: '沿边种植', kind: 'greenEdge' },
  { text: '花坛', kind: 'planter' },
];
const dots = labels
  .map((l) => {
    const s = r.scene.surfaces.find((q) => q.group.startsWith('lot/') && kindOf(q.name) === l.kind);
    if (!s) return null;
    const bb = bboxOf(s.ring);
    return { at: new Pt((bb.minX + bb.maxX) / 2, (bb.minY + bb.maxY) / 2), r: 1.2, fill: KIND_FILL[l.kind], ring: '#111' };
  })
  .filter((x): x is { at: Pt; r: number; fill: string; ring: string } => !!x);

const p1: F3Panel = {
  title: `① 场地总平面（${style} · ${cand.use} · ${cand.areaM2.toFixed(0)} m²）`,
  subtitle: cand.note.slice(0, 70),
  boundary: box,
  polys,
  foot: ['深灰 = 停车 / 车道 · 深绿 = L 形绿化 · 中绿 = 沿边种植 · 浅色 = 硬铺 / 前场'],
};
const sub: Scene = {
  ...r.scene,
  surfaces: r.scene.surfaces.filter(near),
  solids: r.scene.solids.filter(near),
  props: r.scene.props.filter((q) => inBox(q.at)),
  paths: r.scene.paths.filter((q) => q.pts.some(inBox)),
};
const p2 = scenePanel(sub, '② 真实材质（同一份 Scene）', '道路面 · 人行道 · 建筑 · 地面', box, {});

const svg = renderF3([p1, p2], { width: 1680, cols: 2 });
writeFileSync(`${OUT}/hero_lot${suffix}.svg`, svg);
await sharp(Buffer.from(svg), { density: 120 }).png().toFile(`${OUT}/hero_lot${suffix}.png`);

// ---------------- 3D：同一份裁剪后的 Scene，相机自动框住
const prims = sceneToPrimitives(sub, { cityRadius: 40 });
const img = renderPrimitives(prims, { size: 1100, azimuth: 40, elevation: 33 });
await sharp(Buffer.from(img.rgba), { raw: { width: img.width, height: img.height, channels: 4 } }).png().toFile(`${OUT}/hero_lot${suffix}_3d.png`);

console.log('hero lot', cand.id, cand.use, cand.areaM2.toFixed(0), 'm²', '· polys', polys.length, '· dots', dots.length);
