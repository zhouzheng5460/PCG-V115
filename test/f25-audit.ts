// F2.5-A · 从**真实现有场景**里把中心线抽出来看
//
// 目的：证明旧系统到底有没有中心线。结论是"有，但只有直线段"：
//   RoadEdge{a,b,dir,len} —— a→b 就是中心线；RoadNet.nodeEdges 就是邻接表。
// 所以这次重构不是"从零造中心线"，而是把"两点直线 + 匿名顶点"升级成
// "有序路径 + 命名节点 + 等级/宽度自带"。
import { mkdirSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { Pt } from '../src/core/geom';
import { surface, surfaceArea } from '../src/town/planning/core/surface';
import { buildRoadNet } from '../src/road/system';
import { townModel, siteOfPatch } from './compose-inputs';
import { renderF25, F25_COLORS as C } from './f25-draw';

mkdirSync('out/f25', { recursive: true });
const net = buildRoadNet(townModel());
const site = siteOfPatch('-469:284');

// 取 R01 周围 260 m 范围内的边
const cx = site.parcel.outer.reduce((s, p) => s + p.x, 0) / site.parcel.outer.length;
const cy = site.parcel.outer.reduce((s, p) => s + p.y, 0) / site.parcel.outer.length;
const R = 260 / 7;
const near = net.edges.filter((e) => Math.hypot((e.a.x + e.b.x) / 2 - cx, (e.a.y + e.b.y) / 2 - cy) < R);

const pad = R * 1.05;
const frame = surface([
  new Pt(cx - pad, cy - pad),
  new Pt(cx + pad, cy - pad),
  new Pt(cx + pad, cy + pad),
  new Pt(cx - pad, cy + pad),
]);

const lines = near.map((e) => ({
  pts: [e.a, e.b],
  stroke: e.cls === 'arterial' ? C.arterial : e.cls === 'collector' ? C.collector : C.local,
  width: e.cls === 'arterial' ? 2.6 : e.cls === 'collector' ? 1.9 : 1.3,
}));
// 顶点 = RoadNet 的图节点（Map 键就是 Pt 对象）
const nodePts = [...net.nodeEdges.keys()].filter((p) => Math.hypot(p.x - cx, p.y - cy) < R);
const dots = [
  ...nodePts.map((p) => ({ at: p, r: (net.nodeEdges.get(p)?.length ?? 0) >= 3 ? 3 : 1.7, fill: C.node, ring: C.nodeRing })),
  ...net.junctions.filter((j) => Math.hypot(j.center.x - cx, j.center.y - cy) < R).map((j) => ({
    at: j.center,
    r: 6,
    fill: 'none',
    ring: C.arterial,
  })),
];

// 地块轮廓（说明道路来自"地块之间的缝"）
const patchLines = townModel()
  .patches.filter((p) => p.withinCity)
  .map((p) => ({ pts: [...Array.from(p.shape), Array.from(p.shape)[0]], stroke: '#3a424c', width: 0.7, opacity: 0.9 }));

const svg = renderF25(
  [
    {
      title: '① 旧系统：地块网格 + 道路中心线',
      subtitle: `${near.length} 条边 · ${nodePts.length} 个图顶点 · ${net.junctions.filter((j) => Math.hypot(j.center.x - cx, j.center.y - cy) < R).length} 个路口`,
      boundary: frame,
      lines: [...patchLines, ...lines],
      dots,
      foot: [
        '灰线 = 地块边界；彩色线 = RoadEdge 的 a→b（旧系统的"中心线"）',
        '节点 = nodeEdges 的 Map 键（匿名 Pt，没有 id/类型）',
      ],
    },
    {
      title: '② 只有中心线（去掉地块边界）',
      subtitle: '旧系统的中心线 = 两点直线，没有有序路径点、没有曲率',
      boundary: frame,
      lines,
      dots,
      foot: [
        `主干 ${near.filter((e) => e.cls === 'arterial').length} · 次干 ${near.filter((e) => e.cls === 'collector').length} · 支路 ${near.filter((e) => e.cls === 'local').length}`,
        '宽度来自 insetL/insetR（两侧地块退让反推），不是中心线自带',
      ],
    },
  ],
  { width: 1300, cols: 2, title: 'F2.5-A · 旧系统道路几何审计（真实场景 R01 周边 260 m）', subtitle: '结论：中心线存在，但只是 a→b 直线；拓扑是匿名顶点 Map' }
);
writeFileSync('out/f25/A_legacy_centerlines.svg', svg);
sharp(Buffer.from(svg), { density: 110 })
  .png()
  .toFile('out/f25/A_legacy_centerlines.png')
  .then(() => console.log('ok'))
  .catch((e) => console.log('png fail', e.message.slice(0, 80)));
void surfaceArea;
