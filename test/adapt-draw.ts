// F2.4-A 报告出图（test 侧专用）
//
// 一套图 = 六格：① 地块切分 ② 有效可建区与锚点 ③ 建筑定位与方向 ④ 总平面
//                  ⑤ 基线（机械居中） ⑥ 改进（本层结果）
// 所有格子共用同一比例尺与配色 —— 与 F2.1 的图保持同一套视觉语言。

import type { Pt } from '../src/core/geom';
import type { PlanSurface } from '../src/town/planning/core/surface';
import type { SiteRoadEdge } from '../src/town/planning/core/types';

const FONT = "'Segoe UI','Microsoft YaHei','Noto Sans SC',sans-serif";

export const APAL = {
  bg: '#ffffff',
  panel: '#fcfdfe',
  panelLine: '#e2e7ed',
  boundary: '#171b20',
  road: '#9aa4b0',
  roadEdge: '#616b78',
  hole: '#ffffff',
  holeLine: '#aeb5be',
  // 地块
  parcel: '#d3e3f2',
  parcelLine: '#2c6a99',
  compound: '#dbe8d2',
  compoundLine: '#557a40',
  fragment: '#f7d7cf',
  fragmentLine: '#b04a35',
  reserved: '#efe8d6',
  reservedLine: '#87764e',
  // 空地
  court: '#cfe8c4',
  courtLine: '#5d8a4a',
  front: '#e9eff8',
  frontLine: '#8fa6c4',
  loading: '#e8e1d3',
  loadingLine: '#9a8a6a',
  parking: '#e4e7ec',
  parkingLine: '#8b95a3',
  lane: '#d6dae1',
  laneLine: '#7d8794',
  green: '#dff0d5',
  greenLine: '#6d9460',
  // 建筑（新增 = 深色实心；既有 = 浅灰描边，必须一眼能分开）
  building: '#3f4a57',
  buildingLine: '#1b2129',
  existing: '#c3ccd6',
  existingLine: '#5b6675',
  door: '#e0621f',
  core: '#c98a1e',
  access: '#1a7f4b',
  ink: '#171b20',
  muted: '#69727e',
};

export interface AdaptPanel {
  title: string;
  subtitle?: string;
  boundary: PlanSurface;
  roads: SiteRoadEdge[];
  pieces?: { surface: PlanSurface; role: string }[];
  zones?: { surface: PlanSurface; kind: string; label?: string }[];
  /** 既有固定建筑（不可移动）：浅灰，与新增建筑区分 */
  fixed?: PlanSurface[];
  buildings?: { surface: PlanSurface; ang: number; label: string; door?: { at: Pt; normal: Pt } }[];
  marks?: { at: Pt; kind: 'core' | 'access'; label?: string }[];
  foot?: string[];
}

const PAD = 12;
const HEAD = 40;
const FOOT = 46;

function zoneStyle(kind: string): { fill: string; stroke: string } {
  switch (kind) {
    case 'courtyard':
      return { fill: APAL.court, stroke: APAL.courtLine };
    case 'front_yard':
      return { fill: APAL.front, stroke: APAL.frontLine };
    case 'loading':
      return { fill: APAL.loading, stroke: APAL.loadingLine };
    case 'parking':
      return { fill: APAL.parking, stroke: APAL.parkingLine };
    case 'lane':
      return { fill: APAL.lane, stroke: APAL.laneLine };
    default:
      return { fill: APAL.green, stroke: APAL.greenLine };
  }
}

function pieceStyle(role: string): { fill: string; stroke: string; dash?: string } {
  switch (role) {
    case 'compound':
      return { fill: APAL.compound, stroke: APAL.compoundLine };
    case 'fragment':
      return { fill: APAL.fragment, stroke: APAL.fragmentLine, dash: '4 3' };
    case 'reserved':
      return { fill: APAL.reserved, stroke: APAL.reservedLine, dash: '6 4' };
    default:
      return { fill: APAL.parcel, stroke: APAL.parcelLine };
  }
}

export interface AdaptSheetOpts {
  title: string;
  note?: string;
  width?: number;
  panelH?: number;
  cols?: number;
}

export function renderAdaptSheet(panels: AdaptPanel[], opts: AdaptSheetOpts): string {
  const W = opts.width ?? 1200;
  const cols = opts.cols ?? 3;
  const panelH = opts.panelH ?? 350;
  const rows = Math.ceil(panels.length / cols);
  const gap = 14;
  const headH = 62;
  const pw = (W - PAD * (cols + 1) - gap * (cols - 1)) / cols;
  const H = headH + rows * (panelH + gap) + PAD;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const acc = (q: { x: number; y: number }) => {
    if (q.x < minX) minX = q.x;
    if (q.y < minY) minY = q.y;
    if (q.x > maxX) maxX = q.x;
    if (q.y > maxY) maxY = q.y;
  };
  for (const p of panels) {
    for (const q of p.boundary.outer) acc(q);
    for (const r of p.roads) {
      acc(r.a);
      acc(r.b);
    }
  }
  {
    const mx = Math.max((maxX - minX) * 0.05, 0.4);
    const my = Math.max((maxY - minY) * 0.05, 0.4);
    minX -= mx;
    maxX += mx;
    minY -= my;
    maxY += my;
  }
  const spanX = Math.max(1e-6, maxX - minX);
  const spanY = Math.max(1e-6, maxY - minY);
  const cw = pw - PAD * 2;
  const ch = panelH - HEAD - FOOT;
  const scale = Math.min(cw / spanX, ch / spanY);
  const ox = PAD + (cw - spanX * scale) / 2;
  const oy = HEAD + (ch - spanY * scale) / 2;
  const py = (y: number) => maxY - y;
  // 必须减去包围盒原点：世界坐标有正有负（生产地块常在 -60 附近），
  // 不减去的话负坐标会被推到画布外 —— 正坐标的样本看不出来，负坐标的整张图空白。
  const X = (x: number) => (x - minX) * scale + ox;
  const Y = (y: number) => py(y) * scale + oy;

  const path = (ring: Pt[], fill: string, stroke: string, w: number, dash = '', opacity = 1) =>
    `<path d="${ring.map((p, i) => `${i === 0 ? 'M' : 'L'}${X(p.x).toFixed(2)},${Y(p.y).toFixed(2)}`).join(' ')} Z" fill="${fill}" fill-opacity="${opacity}" stroke="${stroke}" stroke-width="${w}"${
      dash ? ` stroke-dasharray="${dash}"` : ''
    }/>`;

  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
  out.push(`<rect width="${W}" height="${H}" fill="${APAL.bg}"/>`);
  out.push(
    `<text x="${PAD}" y="30" font-family="${FONT}" font-size="19" font-weight="600" fill="${APAL.ink}">${esc(opts.title)}</text>`
  );
  if (opts.note) {
    out.push(`<text x="${PAD}" y="50" font-family="${FONT}" font-size="11" fill="${APAL.muted}">${esc(opts.note)}</text>`);
  }
  // 图例
  const legend: [string, string, string][] = [
    ['新增建筑', APAL.building, APAL.buildingLine],
    ['既有建筑', APAL.existing, APAL.existingLine],
    ['院落', APAL.court, APAL.courtLine],
    ['前场', APAL.front, APAL.frontLine],
    ['装卸', APAL.loading, APAL.loadingLine],
    ['停车', APAL.parking, APAL.parkingLine],
    ['内部通道', APAL.lane, APAL.laneLine],
    ['绿地', APAL.green, APAL.greenLine],
  ];
  const lw = 80;
  const lx0 = Math.max(300, W - PAD - legend.length * lw - 26);
  legend.forEach(([name, fill, stroke], i) => {
    const x = lx0 + i * lw;
    out.push(`<rect x="${x}" y="20" width="11" height="9" fill="${fill}" stroke="${stroke}"/>`);
    out.push(`<text x="${x + 15}" y="28" font-family="${FONT}" font-size="9.5" fill="${APAL.muted}">${esc(name)}</text>`);
  });
  out.push(
    `<g font-family="${FONT}" font-size="9.5" fill="${APAL.muted}">` +
      `<circle cx="${lx0 + 4}" cy="44" r="3.4" fill="${APAL.core}"/><text x="${lx0 + 14}" y="47">可用空间核心（锚点）</text>` +
      `<circle cx="${lx0 + 148}" cy="44" r="3.4" fill="${APAL.door}"/><text x="${lx0 + 158}" y="47">建筑门位</text>` +
      `<circle cx="${lx0 + 232}" cy="44" r="3.4" fill="${APAL.access}"/><text x="${lx0 + 242}" y="47">地块接入点</text>` +
      `</g>`
  );

  panels.forEach((panel, idx) => {
    const gx = PAD + (idx % cols) * (pw + gap);
    const gy = headH + Math.floor(idx / cols) * (panelH + gap);
    const cid = `aclip${idx}`;
    out.push(`<g transform="translate(${gx},${gy})">`);
    out.push(`<defs><clipPath id="${cid}"><rect x="0" y="0" width="${pw}" height="${panelH - FOOT}"/></clipPath></defs>`);
    out.push(`<rect width="${pw}" height="${panelH}" fill="${APAL.panel}" stroke="${APAL.panelLine}"/>`);
    out.push(
      `<text x="${PAD}" y="18" font-family="${FONT}" font-size="12.5" font-weight="600" fill="${APAL.ink}">${esc(panel.title)}</text>`
    );
    if (panel.subtitle) {
      out.push(`<text x="${PAD}" y="31" font-family="${FONT}" font-size="10" fill="${APAL.muted}">${esc(panel.subtitle)}</text>`);
    }
    out.push(`<g clip-path="url(#${cid})">`);

    // 边界 + 洞
    out.push(path(panel.boundary.outer, 'none', APAL.boundary, 1.5));
    for (const h of panel.boundary.holes) out.push(path(h, APAL.hole, APAL.holeLine, 1.1, '5 3'));

    // 道路
    for (const r of panel.roads) {
      const wU = r.carriageSide * 2 + r.sidewalk * 2 + r.median;
      out.push(
        `<line x1="${X(r.a.x).toFixed(1)}" y1="${Y(r.a.y).toFixed(1)}" x2="${X(r.b.x).toFixed(1)}" y2="${Y(r.b.y).toFixed(
          1
        )}" stroke="${APAL.road}" stroke-width="${Math.max(2.5, wU * scale).toFixed(1)}" stroke-linecap="butt"/>`
      );
      out.push(
        `<line x1="${X(r.a.x).toFixed(1)}" y1="${Y(r.a.y).toFixed(1)}" x2="${X(r.b.x).toFixed(1)}" y2="${Y(r.b.y).toFixed(
          1
        )}" stroke="${APAL.roadEdge}" stroke-width="0.7" stroke-dasharray="7 5" opacity="0.8"/>`
      );
    }

    // 地块
    for (const p of panel.pieces ?? []) {
      const st = pieceStyle(p.role);
      out.push(path(p.surface.outer, st.fill, st.stroke, 1.1, st.dash, 0.95));
      for (const h of p.surface.holes) out.push(path(h, APAL.hole, st.stroke, 0.9, '4 3'));
    }

    // 空地
    for (const z of panel.zones ?? []) {
      const st = zoneStyle(z.kind);
      out.push(path(z.surface.outer, st.fill, st.stroke, 0.8, '', 0.95));
      for (const h of z.surface.holes) out.push(path(h, APAL.hole, st.stroke, 0.7, '3 3'));
    }

    // 既有建筑（先画，压在地块之上、新增建筑之下）
    for (const fb of panel.fixed ?? []) {
      out.push(path(fb.outer, APAL.existing, APAL.existingLine, 1.0));
      for (const h of fb.holes) out.push(path(h, APAL.panel, APAL.existingLine, 0.8));
    }

    // 新增建筑
    for (const b of panel.buildings ?? []) {
      out.push(path(b.surface.outer, APAL.building, APAL.buildingLine, 1.1));
      // 长轴方向箭头（长度取建筑短边的 60%）
      const cx = b.surface.outer.reduce((s, q) => s + q.x, 0) / b.surface.outer.length;
      const cy = b.surface.outer.reduce((s, q) => s + q.y, 0) / b.surface.outer.length;
      let minD = Infinity;
      let maxD = 0;
      for (let i = 0; i < b.surface.outer.length; i++) {
        const d = Math.hypot(b.surface.outer[i].x - cx, b.surface.outer[i].y - cy);
        minD = Math.min(minD, d);
        maxD = Math.max(maxD, d);
      }
      const len = Math.max(minD, maxD * 0.55);
      out.push(
        `<line x1="${(X(cx) - Math.cos(b.ang) * len * scale).toFixed(1)}" y1="${(Y(cy) + Math.sin(b.ang) * len * scale).toFixed(
          1
        )}" x2="${(X(cx) + Math.cos(b.ang) * len * scale).toFixed(1)}" y2="${(Y(cy) - Math.sin(b.ang) * len * scale).toFixed(
          1
        )}" stroke="#ffffff" stroke-width="1.2" opacity="0.75"/>`
      );
      // 尺寸标注：只在建筑够大时写，避免糊成一团
      let bx0 = Infinity;
      let bx1 = -Infinity;
      let by0 = Infinity;
      let by1 = -Infinity;
      for (const q of b.surface.outer) {
        bx0 = Math.min(bx0, q.x);
        bx1 = Math.max(bx1, q.x);
        by0 = Math.min(by0, q.y);
        by1 = Math.max(by1, q.y);
      }
      if ((bx1 - bx0) * scale > 30 && b.label) {
        out.push(
          `<text x="${X(cx).toFixed(1)}" y="${(Y(cy) + 3).toFixed(1)}" text-anchor="middle" font-family="${FONT}" font-size="7" fill="#e8eef6">${esc(
            b.label
          )}</text>`
        );
      }

      // 门
      if (b.door) {
        out.push(`<circle cx="${X(b.door.at.x).toFixed(1)}" cy="${Y(b.door.at.y).toFixed(1)}" r="3" fill="${APAL.door}" stroke="#fff" stroke-width="1"/>`);
      }
    }

    // 锚点 / 接入点
    for (const m of panel.marks ?? []) {
      const c = m.kind === 'core' ? APAL.core : APAL.access;
      out.push(`<circle cx="${X(m.at.x).toFixed(1)}" cy="${Y(m.at.y).toFixed(1)}" r="3.6" fill="none" stroke="${c}" stroke-width="1.6"/>`);
      out.push(`<circle cx="${X(m.at.x).toFixed(1)}" cy="${Y(m.at.y).toFixed(1)}" r="1.2" fill="${c}"/>`);
    }
    out.push(`</g>`);

    (panel.foot ?? []).forEach((line, i) => {
      out.push(
        `<text x="${PAD}" y="${panelH - FOOT + 15 + i * 11}" font-family="${FONT}" font-size="9.3" fill="${
          line.startsWith('✗') ? '#b04a35' : line.startsWith('✓') ? '#1a7f4b' : APAL.muted
        }">${esc(line)}</text>`
      );
    });
    out.push(`</g>`);
  });

  out.push(`</svg>`);
  return out.join('\n');
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
