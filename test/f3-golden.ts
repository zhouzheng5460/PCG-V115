// F3 Golden：三种城市风貌的完整出图（2D 十联 + 3D 轴测 + 前后对照）
//
// 产物（out/f3/）：
//   <STYLE>_panels.png   城市切分 → 街区 → 路网 → 最大内接矩形 → 建筑 → 地面 的十联图
//   <STYLE>_3d.png       正交轴测（软件光栅，和浏览器里同一个三角形出口）
//   COMPARE.png          三种风貌同尺度并排
//   summary.json         统计与面积对账

import { mkdirSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { Pt } from '../src/core/geom';
import { sceneToPrimitives } from '../src/export/build3d';
import { cityOutline, runF3City, type CityResult } from '../src/f3';
import type { CityStyle } from '../src/f3/types';
import { renderF3, scenePanel, type F3Panel } from './f3-draw';
import { renderPrimitives } from './soft3d';

const USE_FILL: Record<string, string> = {
  residential: '#8a9a6b',
  commercial: '#c29a6a',
  cbd: '#a98bc0',
  industrial: '#8d8f96',
  campus: '#7f9aa8',
  park: '#5f8a4e',
  green: '#527a44',
  civic: '#b8a06a',
};

const OUT = 'out/f3';
mkdirSync(OUT, { recursive: true });

const SITE_R = 95;
const SEED = 20261106;
const STYLES: { id: CityStyle; program: 'mixed' | 'residential' | 'industrial'; label: string }[] = [
  { id: 'structured', program: 'mixed', label: '规则城区 / 混合用途' },
  { id: 'organic', program: 'residential', label: '有机城区 / 居住' },
  { id: 'campus', program: 'industrial', label: '园区 / 工业' },
];

const summary: Record<string, unknown> = {};

for (const st of STYLES) {
  const boundary = { outer: cityOutline(SITE_R, SEED), holes: [] };
  const t0 = Date.now();
  const r = runF3City({
    boundary,
    style: st.id,
    density: 'medium',
    program: st.program,
    seed: SEED,
  });
  const ms = Date.now() - t0;
  console.log(`${st.id}: ${ms} ms`, r.stats);

  const panels = buildPanels(r, st.label);
  const svg = renderF3(panels, { width: 1500, cols: 2 });
  writeFileSync(`${OUT}/${st.id}_panels.svg`, svg);
  await sharp(Buffer.from(svg), { density: 110 }).png().toFile(`${OUT}/${st.id}_panels.png`);

  // 3D 轴测：与浏览器走同一个 sceneToPrimitives
  const prims = sceneToPrimitives(r.scene, { cityRadius: SITE_R });
  const img = renderPrimitives(prims, { size: 1100, azimuth: 38, elevation: 34 });
  const png = await sharp(Buffer.from(img.rgba), { raw: { width: img.width, height: img.height, channels: 4 } })
    .png()
    .toFile(`${OUT}/${st.id}_3d.png`);
  void png;

  summary[st.id] = {
    label: st.label,
    ms,
    stats: r.stats,
    notes: r.notes,
  };
  writeFileSync(`${OUT}/${st.id}_summary.json`, JSON.stringify({ stats: r.stats, notes: r.notes }, null, 2));
}

writeFileSync(`${OUT}/summary.json`, JSON.stringify(summary, null, 2));
console.log('done →', OUT);
void Pt;

function buildPanels(r: CityResult, label: string): F3Panel[] {
  const boundary = r.spec.boundary;
  const bb = boundary.outer;
  const st = r.stats;
  const g = r.debug.graph;

  const p1: F3Panel = {
    title: '① 路网：递归面切分（街区 = 面）',
    subtitle: `${r.spec.style} · 场地 ${st.siteAreaM2.toFixed(0)} m² · 面 ${r.debug.faces.length} · 切分深度 ${Math.max(...r.debug.faces.map((f) => (f.depth === 999 ? 0 : f.depth)))}`,
    boundary,
    polys: [{ ring: bb, fill: '#262b33' }],
    lines: g.edges.size
      ? [...g.edges.values()].map((e) => ({
          pts: e.pts,
          stroke: e.cls === 'arterial' ? '#e0762e' : e.cls === 'collector' ? '#7fa8d8' : '#7c8593',
          width: e.cls === 'arterial' ? 2.6 : e.cls === 'collector' ? 1.8 : 1.2,
        }))
      : [],
    foot: [`路径 ${g.paths.length} · 节点 ${g.nodes.size} · 路口 ${g.junctions.length}`],
  };

  const p2: F3Panel = {
    title: '② 街区（= 路的围合面）按用途着色',
    subtitle: `街区 ${st.blockCount} 块 · 中位 ${median(r.debug.blocks.map((b) => b.areaM2)).toFixed(0)} m²`,
    boundary,
    polys: [
      { ring: bb, fill: '#20252c' },
      ...r.debug.blocks.map((b) => ({
        ring: b.surface.outer,
        holes: b.surface.holes,
        fill: USE_FILL[b.use],
        stroke: '#1b1f25',
        strokeW: 0.5,
      })),
    ],
    foot: [`${r.debug.blocks.map((b) => b.use).filter((v, i, a) => a.indexOf(v) === i).join(' / ')}`],
  };

  const p3 = scenePanel(r.scene, '③ 分级道路面 + 真实路口多边形', `道路 ${st.roadLengthM} m · 路面 ${(st.roadAreaM2 + st.junctionAreaM2).toFixed(0)} m²`, boundary, {
    only: (group) => group.startsWith('road/'),
  });
  p3.polys.unshift({ ring: bb, fill: '#23282f' });
  p3.foot = [`车行 ${st.roadAreaM2.toFixed(0)} m² · 路口 ${st.junctionAreaM2.toFixed(0)} m² · 人行 ${st.sidewalkAreaM2.toFixed(0)} m²`];

  const p4 = scenePanel(r.scene, '④ 道路 + 人行道 + 绿带', '断面：车行 / 路缘 / 人行 / 路侧绿带', boundary, {
    only: (group) => group.startsWith('road/'),
  });
  p4.polys.unshift({ ring: bb, fill: '#23282f' });
  p4.foot = [`绿带与绿地合计 ${st.greenAreaM2.toFixed(0)} m²`];

  const p5: F3Panel = {
    title: '⑤ 最大内接矩形（BuildingControlRect）',
    subtitle: `地块 ${st.parcelCount} · 有矩形 ${r.debug.parcels.filter((p) => p.rect).length}`,
    boundary,
    polys: [
      { ring: bb, fill: '#20252c' },
      ...r.debug.parcels.map((p) => ({
        ring: p.surface.outer,
        holes: p.surface.holes,
        fill: 'rgba(120,140,160,0.16)',
        stroke: '#5b6775',
        strokeW: 0.4,
      })),
      ...r.debug.parcels
        .filter((p) => p.rect)
        .map((p) => ({ ring: p.rect!.ring, fill: 'rgba(224,118,46,0.30)', stroke: '#f0a35c', strokeW: 0.6 })),
    ],
    foot: [`矩形质量中位 ${median(r.debug.parcels.filter((p) => p.rect).map((p) => p.rect!.quality)).toFixed(2)}（矩形面积 / 地块面积）`],
  };

  const p6 = scenePanel(r.scene, '⑥ 建筑体量 + 建筑占地', `建筑 ${st.buildingCount} 栋 · 占地 ${st.footprintAreaM2.toFixed(0)} m²`, boundary, {
    only: (group) => group.startsWith('lot/') || group === 'ground',
  });
  p6.foot = [`GFA ${(st.gfaM2 / 1000).toFixed(0)} k m²`];

  const p7 = scenePanel(r.scene, '⑦ 复合地面：铺装 / 停车 / 绿化', `车位 ${st.parkingBays} · 树 ${st.treeCount}`, boundary, {
    only: (group) => group.startsWith('lot/') || group === 'ground' || group === 'parking/marking',
  });
  p7.foot = ['停车在剩余面里按最大内接矩形排，绿化主动避让建筑入口与通道'];

  const p8 = scenePanel(r.scene, '⑧ 完整总平面（2D）', `${r.spec.style} · ${label} · seed ${r.spec.seed}`, boundary);
  p8.foot = [
    `道路 ${st.roadLengthM} m · 街区 ${st.blockCount} · 地块 ${st.parcelCount} · 建筑 ${st.buildingCount}`,
    `面积对账：场地 ${st.siteAreaM2.toFixed(0)} = 道路 ${(st.roadAreaM2 + st.junctionAreaM2 + st.sidewalkAreaM2).toFixed(0)} + 地块 ${st.parcelAreaM2.toFixed(0)} + 未归属 ${st.unclaimedM2.toFixed(0)} m²`,
  ];

  return [p1, p2, p3, p4, p5, p6, p7, p8];
}

function median(list: number[]): number {
  if (list.length === 0) return 0;
  const s = list.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
