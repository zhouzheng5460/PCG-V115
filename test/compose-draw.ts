// F2.4-B · 出图（2D 总平面 + 正交轴测 3D）
//
// 一张图要能回答：路在哪、地在哪、每块地干什么、楼怎么摆、门开向哪、
// 停车和铺装/绿地怎么分。所以图层顺序是固定的，颜色是**功能**而不是装饰：
//   · 路面最底 → 地块底色 → 地面铺装/绿地 → 建筑 → 门 → 标注
// 3D 用工程里已有的软件光栅器（`test/soft3d.ts` + `export/mesh.ts`），
// 不引三方渲染库，保证离屏可复现。

import { Pt } from '../src/core/geom';
import type { PlanSurface } from '../src/town/planning/core/surface';
import type {
  GroundKind,
  InternalRoad,
  ParcelFunction,
  SiteComposition,
  SiteDoor,
  SiteBuilding,
} from '../src/town/planning/compose';
import { flatPolygon, extrudeSolid } from '../src/export/mesh';
import type { Primitive } from '../src/export/mesh';

const FONT = "'Noto Sans SC','PingFang SC','Microsoft YaHei',sans-serif";

/** 功能配色（地块底色）。低饱和，保证叠加的线和建筑能读出来 */
const FN_FILL: Record<ParcelFunction, string> = {
  building: '#dfe8f3',
  compound: '#cfe3e0',
  parking: '#d8d8dc',
  plaza: '#f3e6d2',
  green: '#d9ead3',
  service: '#e8dccd',
  reserve: '#eceef1',
};
const FN_EDGE: Record<ParcelFunction, string> = {
  building: '#8ba8c9',
  compound: '#79a9a2',
  parking: '#9a9aa2',
  plaza: '#c9a877',
  green: '#8fb383',
  service: '#bda184',
  reserve: '#b8bcc4',
};

const GROUND_FILL: Record<GroundKind, string> = {
  plaza: '#f0e2c8',
  forecourt: '#e9e5dc',
  courtyard: '#dfe9d6',
  loading: '#cfd3d8',
  'parking-deck': '#c9cbd0',
  footpath: '#f5efe3',
  driveway: '#b9bcc2',
  sidewalk: '#e6e6e4',
  green: '#cfe4c4',
  planting: '#bcd6ac',
  planter: '#8fb383',
  unassigned: '#f6d5e4',
};

const ROAD_FILL: Record<InternalRoad['cls'], string> = {
  primary: '#6f747c',
  secondary: '#7d828a',
  service: '#8a8f96',
  pedestrian: '#a9a49a',
};

export interface DrawPanel {
  title: string;
  subtitle: string;
  /** 显示所有地块（底色按用途） */
  parcels?: boolean;
  /** 只显示这些用途的地块 */
  onlyFn?: ParcelFunction[];
  roads?: boolean;
  roadHints?: { pts: Pt[]; label: string }[];
  buildings?: boolean;
  doors?: boolean;
  parking?: boolean;
  ground?: boolean;
  groundKinds?: GroundKind[];
  anchors?: boolean;
  gates?: boolean;
  entranceLabels?: boolean;
  labels?: boolean;
  /** 旧算法对照层（只出现在对比图里） */
  legacy?: { surface: PlanSurface; kind: 'building' | 'ground' }[];
  foot?: string[];
  /** 内嵌图片（3D 渲染结果），dataURI */
  image?: string;
}

interface SheetOpts {
  title: string;
  subtitle: string;
  panels: DrawPanel[];
  /** 每行面板数 */
  cols?: number;
  width?: number;
  panelH?: number;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 整张图 */
export function renderSheet(c: SiteComposition, o: SheetOpts): string {
  const W = o.width ?? 1680;
  const cols = o.cols ?? (o.panels.length >= 4 ? 2 : o.panels.length);
  const gap = 14;
  const pad = 16;
  const pw = (W - pad * 2 - gap * (cols - 1)) / cols;
  const ph = o.panelH ?? 380;
  const rows = Math.ceil(o.panels.length / cols);
  const H = 92 + rows * (ph + 34) + 20;

  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">`
  );
  out.push(`<rect width="${W}" height="${H}" fill="#0f1216"/>`);
  out.push(
    `<text x="${pad}" y="34" font-size="19" fill="#e9eef5" font-weight="600">${esc(o.title)}</text>`
  );
  out.push(`<text x="${pad}" y="56" font-size="12" fill="#8f9bab">${esc(o.subtitle)}</text>`);
  out.push(legend(pad, 70));

  o.panels.forEach((p, i) => {
    const cx = pad + (i % cols) * (pw + gap);
    const cy = 92 + Math.floor(i / cols) * (ph + 34);
    out.push(panel(c, p, cx, cy, pw, ph));
  });
  out.push('</svg>');
  return out.join('\n');
}

function legend(x: number, y: number): string {
  const items: [string, string][] = [
    ['建筑地块', FN_FILL.building],
    ['建筑组团', FN_FILL.compound],
    ['集中停车', FN_FILL.parking],
    ['广场', FN_FILL.plaza],
    ['绿地', GROUND_FILL.green],
    ['后勤', FN_FILL.service],
    ['铺装/前场', GROUND_FILL.forecourt],
    ['未设计', GROUND_FILL.unassigned],
  ];
  const out: string[] = [];
  let cx = x;
  for (const [label, fill] of items) {
    out.push(`<rect x="${cx}" y="${y - 8}" width="11" height="11" rx="2" fill="${fill}" stroke="#3a4149" stroke-width="0.7"/>`);
    out.push(`<text x="${cx + 15}" y="${y + 1}" font-size="10.5" fill="#9aa6b5">${esc(label)}</text>`);
    cx += 15 + label.length * 11 + 12;
  }
  return out.join('\n');
}

function panel(c: SiteComposition, p: DrawPanel, x: number, y: number, w: number, h: number): string {
  const out: string[] = [];
  out.push(`<g transform="translate(${x},${y})">`);
  out.push(`<rect width="${w}" height="${h}" rx="6" fill="#171b21" stroke="#252b33"/>`);
  out.push(`<text x="12" y="21" font-size="12.5" fill="#dbe3ec" font-weight="600">${esc(p.title)}</text>`);
  out.push(`<text x="12" y="37" font-size="10.5" fill="#7f8b9a">${esc(p.subtitle)}</text>`);

  if (p.image) {
    out.push(`<image x="8" y="44" width="${w - 16}" height="${h - 86}" href="${p.image}" preserveAspectRatio="xMidYMid meet"/>`);
  } else {
    out.push(plot(c, p, 8, 44, w - 16, h - 86));
  }
  (p.foot ?? []).forEach((t, i) => {
    out.push(`<text x="12" y="${h - 30 + i * 13}" font-size="10" fill="#8794a4">${esc(t)}</text>`);
  });
  out.push('</g>');
  return out.join('\n');
}

/** 图面（世界坐标 → 屏幕） */
function plot(c: SiteComposition, p: DrawPanel, ox: number, oy: number, w: number, h: number): string {
  const bb = bboxOf([c.input.boundary, ...c.infra.roadGround]);
  const spanX = Math.max(1e-6, bb.maxX - bb.minX);
  const spanY = Math.max(1e-6, bb.maxY - bb.minY);
  const pad = 8;
  const scale = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY);
  const dx = ox + (w - spanX * scale) / 2;
  const dy = oy + (h - spanY * scale) / 2;
  const X = (v: number) => dx + (v - bb.minX) * scale;
  const Y = (v: number) => dy + (bb.maxY - v) * scale;

  const ring = (r: Pt[]) => r.map((q, i) => `${i === 0 ? 'M' : 'L'}${X(q.x).toFixed(2)},${Y(q.y).toFixed(2)}`).join('') + 'Z';
  const surf = (s: PlanSurface, fill: string, stroke: string, sw = 0.8, op = 1) => {
    let d = ring(s.outer);
    for (const q of s.holes) d += ring(q);
    return `<path d="${d}" fill="${fill}" fill-opacity="${op}" fill-rule="evenodd" stroke="${stroke}" stroke-width="${sw}"/>`;
  };

  const out: string[] = [];

  // ① 街区底面 + 洞（洞是"不属于街区"的空间，画成底色并加边）
  out.push(surf(c.input.boundary, '#1d222a', '#3b434d', 1.2));

  // ② 地块底色（按用途）
  if (p.parcels) {
    for (const q of c.parcels.parcels) {
      if (p.onlyFn && !p.onlyFn.includes(q.fn)) continue;
      out.push(surf(q.surface, FN_FILL[q.fn], FN_EDGE[q.fn], 0.7, 0.92));
    }
  }

  // ③ 地面（铺装 / 绿地 / 停车）
  if (p.ground) {
    for (const g of c.ground) {
      if (p.groundKinds && !p.groundKinds.includes(g.kind)) continue;
      out.push(surf(g.surface, GROUND_FILL[g.kind], 'none', 0, 0.95));
    }
    for (const v of c.voids) out.push(surf(v.surface, GROUND_FILL.courtyard, '#6f8a63', 1.0));
  }

  // ④ 内部道路
  if (p.roads) {
    for (const r of c.infra.roads) out.push(surf(r.surface, ROAD_FILL[r.cls], '#2f353d', 0.9, 1));
    for (const h of p.ground === undefined ? [] : []) void h;
  }
  for (const h of p.roadHints ?? []) {
    const d = h.pts.map((q, i) => `${i === 0 ? 'M' : 'L'}${X(q.x).toFixed(2)},${Y(q.y).toFixed(2)}`).join('');
    out.push(`<path d="${d}" fill="none" stroke="#f0c674" stroke-width="2" stroke-dasharray="7 5" stroke-opacity="0.9"/>`);
  }

  // ⑤ 停车场：车位线 + 通道
  if (p.parking) {
    for (const k of c.parking) {
      for (const a of k.layout.aisles) out.push(surf({ outer: a, holes: [] }, '#9ea3ab', 'none', 0, 0.9));
      for (const [a, b] of k.layout.dividers) {
        out.push(
          `<line x1="${X(a.x).toFixed(2)}" y1="${Y(a.y).toFixed(2)}" x2="${X(b.x).toFixed(2)}" y2="${Y(b.y).toFixed(2)}" stroke="#e8ebef" stroke-width="0.6" stroke-opacity="0.75"/>`
        );
      }
      for (const isl of k.layout.islands) out.push(surf({ outer: isl, holes: [] }, '#8fb383', 'none', 0, 0.8));
    }
  }

  // ⑥ 旧算法对照
  for (const l of p.legacy ?? []) {
    out.push(
      l.kind === 'building'
        ? surf(l.surface, '#7b8794', '#41474f', 0.7, 0.9)
        : surf(l.surface, '#4c5560', 'none', 0, 0.55)
    );
  }

  // ⑦ 建筑
  if (p.buildings) {
    for (const b of c.buildings) {
      const t = Math.min(1, b.heightM / 34);
      const fill = shade(b.heightM);
      void t;
      out.push(surf(b.surface, fill, '#20242a', 1.0));
      // 长轴细线：一眼看出朝向
      const ux = Math.cos(b.ang);
      const uy = Math.sin(b.ang);
      const hw = (b.widthM / 7) * 0.42;
      out.push(
        `<line x1="${X(b.center.x - ux * hw).toFixed(2)}" y1="${Y(b.center.y - uy * hw).toFixed(2)}" x2="${X(
          b.center.x + ux * hw
        ).toFixed(2)}" y2="${Y(b.center.y + uy * hw).toFixed(2)}" stroke="#f2f5f9" stroke-width="0.8" stroke-opacity="0.55"/>`
      );
    }
  }

  // ⑧ 门
  if (p.doors) {
    for (const b of c.buildings) {
      for (const d of b.doors) {
        const col = d.kind === 'main' ? '#e4553d' : d.kind === 'freight' ? '#d98a2b' : d.kind === 'service' ? '#6f7c8c' : '#3d7fb8';
        const r = d.kind === 'main' ? 3.4 : 2.4;
        out.push(`<circle cx="${X(d.at.x).toFixed(2)}" cy="${Y(d.at.y).toFixed(2)}" r="${r}" fill="${col}" stroke="#0f1216" stroke-width="0.6"/>`);
        if (d.kind === 'main') {
          const l = 6;
          out.push(
            `<line x1="${X(d.at.x).toFixed(2)}" y1="${Y(d.at.y).toFixed(2)}" x2="${(X(d.at.x) + d.normal.x * l).toFixed(2)}" y2="${(
              Y(d.at.y) - d.normal.y * l
            ).toFixed(2)}" stroke="${col}" stroke-width="1.6"/>`
          );
        }
      }
    }
  }

  // ⑨ 锚点（可用空间核心）
  if (p.anchors) {
    for (const q of c.parcels.parcels) {
      const core = anchorOf(q.usable ?? q.surface);
      if (!core) continue;
      out.push(
        `<circle cx="${X(core.x).toFixed(2)}" cy="${Y(core.y).toFixed(2)}" r="4.2" fill="none" stroke="#f0c674" stroke-width="1.6"/>` +
          `<line x1="${(X(core.x) - 6).toFixed(2)}" y1="${Y(core.y).toFixed(2)}" x2="${(X(core.x) + 6).toFixed(2)}" y2="${Y(core.y).toFixed(2)}" stroke="#f0c674" stroke-width="1"/>` +
          `<line x1="${X(core.x).toFixed(2)}" y1="${(Y(core.y) - 6).toFixed(2)}" x2="${X(core.x).toFixed(2)}" y2="${(Y(core.y) + 6).toFixed(2)}" stroke="#f0c674" stroke-width="1"/>`
      );
    }
  }

  // ⑩ 街口
  if (p.gates) {
    for (const g of c.infra.gates) {
      out.push(
        `<circle cx="${X(g.at.x).toFixed(2)}" cy="${Y(g.at.y).toFixed(2)}" r="5" fill="none" stroke="#5ab0f0" stroke-width="1.8"/>`
      );
      if (p.entranceLabels) {
        out.push(
          `<text x="${(X(g.at.x) + 7).toFixed(1)}" y="${(Y(g.at.y) - 5).toFixed(1)}" font-size="9" fill="#7fc4f5">${esc(g.kind)}</text>`
        );
      }
    }
  }

  // ⑪ 标注（地块 id / 用途）
  if (p.labels) {
    for (const q of c.parcels.parcels) {
      const ctr = centroidOf(q.surface.outer);
      const short = q.id.split('/').pop() ?? q.id;
      out.push(
        `<text x="${X(ctr.x).toFixed(1)}" y="${Y(ctr.y).toFixed(1)}" font-size="8.5" text-anchor="middle" fill="#3d4652">${esc(
          short
        )}</text>`
      );
    }
  }

  return out.join('\n');
}

function shade(heightM: number): string {
  // 越高越深：读图时高度差可以直接看出来
  const t = Math.max(0, Math.min(1, (heightM - 6) / 30));
  const a = [58, 68, 82];
  const b = [26, 32, 40];
  const m = a.map((v, i) => Math.round(v + (b[i] - v) * t));
  return `rgb(${m[0]},${m[1]},${m[2]})`;
}

function bboxOf(ss: (PlanSurface | undefined)[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of ss) {
    if (!s) continue;
    for (const p of s.outer) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  const pad = 2;
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

function centroidOf(ring: Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const q of ring) {
    x += q.x;
    y += q.y;
  }
  return new Pt(x / Math.max(1, ring.length), y / Math.max(1, ring.length));
}

function anchorOf(s: PlanSurface): Pt | null {
  // 复用 clearance：与布局层同一把尺子
  const mod = clearanceRef;
  const f = mod(s, 3);
  return f.core ? f.core.at : null;
}

import { clearanceField as clearanceRef } from '../src/town/planning/adapt/geom';

// ---------------------------------------------------------------- 3D

const C3 = {
  bg: [0.09, 0.1, 0.12] as [number, number, number],
  ground: [0.62, 0.6, 0.56] as [number, number, number],
  green: [0.62, 0.76, 0.55] as [number, number, number],
  paving: [0.78, 0.75, 0.69] as [number, number, number],
  road: [0.34, 0.35, 0.38] as [number, number, number],
  parking: [0.55, 0.56, 0.58] as [number, number, number],
  wall: [0.86, 0.86, 0.85] as [number, number, number],
  roof: [0.42, 0.45, 0.5] as [number, number, number],
  hall: [0.7, 0.72, 0.75] as [number, number, number],
  hallRoof: [0.5, 0.53, 0.57] as [number, number, number],
};

/**
 * 把一份合成方案变成 3D 图元。
 *
 * 高度按真实米数换算（1 世界单位 = 7 m），所以 30 m 的住宅在图上就是
 * 地块宽度的 1/5 —— 不是随手拉高的"示意体块"。
 */
export function buildPrims(c: SiteComposition): Primitive[] {
  const prims: Primitive[] = [];
  const push = (p: Primitive | null) => {
    if (p) prims.push(p);
  };
  // 地面底色
  push(flatPolygon(c.input.boundary.outer, 0.005, 'ground', 'ground', C3.ground, c.input.boundary.holes));
  for (const g of c.ground) {
    const col =
      g.kind === 'green' || g.kind === 'planting' || g.kind === 'planter' || g.kind === 'courtyard'
        ? C3.green
        : g.kind === 'parking-deck' || g.kind === 'driveway' || g.kind === 'loading'
          ? C3.parking
          : C3.paving;
    push(flatPolygon(g.surface.outer, 0.02, `g-${g.kind}`, 'ground', col, g.surface.holes));
  }
  for (const v of c.voids) push(flatPolygon(v.surface.outer, 0.03, 'void', 'ground', C3.green, v.surface.holes));
  for (const r of c.infra.roads) push(flatPolygon(r.surface.outer, 0.03, `road-${r.id}`, 'road', C3.road, r.surface.holes));
  // 建筑
  for (const b of c.buildings) {
    const isHall = b.grammar === 'hall';
    const roof = isHall ? C3.hallRoof : C3.roof;
    const wall = isHall ? C3.hall : C3.wall;
    prims.push(...extrudeSolid(b.surface.outer, 0.04, b.heightM / 7, `b-${b.id}`, 'building', roof, wall));
  }
  return prims;
}

/** 3D 面板的 dataURI 由调用方用 sharp 生成后传入（这里只管 2D 与图元） */
export type { SiteBuilding, SiteDoor, InternalRoad };
