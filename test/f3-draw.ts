// F3 出图：Scene → SVG（俯视总平面）。
// 只在测试/报告里用，不进运行时。

import { Pt } from '../src/core/geom';
import type { Scene, SurfaceFeature } from '../src/scene/types';
import { MAT } from '../src/scene/palette';
import type { MatKey } from '../src/scene/palette';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface F3Poly {
  ring: Pt[];
  holes?: Pt[][];
  fill: string;
  stroke?: string;
  strokeW?: number;
  opacity?: number;
}

export interface F3Panel {
  title: string;
  subtitle?: string;
  boundary: { outer: Pt[]; holes: Pt[][] };
  polys: F3Poly[];
  lines?: { pts: Pt[]; stroke: string; width: number; dash?: string; opacity?: number }[];
  dots?: { at: Pt; r: number; fill: string; ring?: string }[];
  labels?: { at: Pt; text: string; fill?: string; size?: number; anchor?: 'start' | 'middle' | 'end' }[];
  foot?: string[];
}

/** 线性色 → sRGB（MAT 里是线性值，直接画会偏暗发灰） */
function srgb(c: [number, number, number], lighten = 1): string {
  const f = (v: number): number => Math.round(Math.min(1, Math.pow(v, 1 / 2.2) * lighten) * 255);
  return `rgb(${f(c[0])},${f(c[1])},${f(c[2])})`;
}

const ROOF: Record<string, string> = {
  roofFlat: srgb(MAT.roofFlat, 1.02),
  roofLight: srgb(MAT.roofLight, 1.02),
  roofDark: srgb(MAT.roofDark, 1.02),
  roofMetal: srgb(MAT.roofMetal, 1.02),
};

const WALL: Record<string, string> = {
  wallConcrete: srgb(MAT.wallConcrete, 0.82),
  wallBrick: srgb(MAT.wallBrick, 0.82),
  wallGlass: srgb(MAT.wallGlass, 0.82),
  wallPanel: srgb(MAT.wallPanel, 0.82),
  wallStone: srgb(MAT.wallStone, 0.82),
};

function surfaceFill(s: SurfaceFeature): { fill: string; stroke?: string; opacity?: number } {
  const g = s.group;
  if (g === 'ground') return { fill: '#8d8779' };
  if (g === 'road/surface' || g === 'road/junction') return { fill: '#3b404a' };
  if (g === 'road/sidewalk') return { fill: s.mat === 'curb' ? '#cfcabd' : '#b8b2a4' };
  if (g === 'road/verge') return { fill: '#5c7f45' };
  if (g === 'road/marking') return { fill: s.mat === 'markYellow' ? '#d8b93f' : '#e8e4d8', opacity: 0.95 };
  switch (s.mat) {
    case 'lawn':
      return { fill: '#7d9657' };
    case 'grass':
      return { fill: '#6a8a4c' };
    case 'grassLight':
      return { fill: '#7fa25b' };
    case 'water':
      return { fill: '#5b8aa5' };
    case 'asphaltLot':
      return { fill: '#4c525c' };
    case 'stonePave':
      return { fill: '#c9c3b5' };
    case 'paver':
      return { fill: '#c2bbaa' };
    case 'concrete':
      return { fill: '#b3ada1' };
    case 'gravel':
      return { fill: '#a49b88' };
    default:
      return { fill: '#b8b1a3' };
  }
}

export interface PanelOpts {
  showBlocks?: boolean;
  showParcels?: boolean;
  showRects?: boolean;
  /** 只画这些图层（null = 全画） */
  only?: (group: string) => boolean;
}

/** Scene → 一份"面板"（俯视图） */
export function scenePanel(scene: Scene, title: string, subtitle: string, boundary: { outer: Pt[]; holes: Pt[][] }, opts: PanelOpts = {}): F3Panel {
  const polys: F3Poly[] = [];
  const surfaces = scene.surfaces.slice().sort((a, b) => a.y - b.y);
  for (const s of surfaces) {
    if (opts.only && !opts.only(s.group)) continue;
    const c = surfaceFill(s);
    polys.push({ ring: s.ring, holes: s.holes, ...c, stroke: undefined });
  }
  // 建筑：屋顶色 + 半透明阴影偏移（叠两遍做厚度）
  for (const s of scene.solids) {
    if (opts.only && !opts.only(s.group)) continue;
    const roof = ROOF[s.roofMat] ?? ROOF.roofFlat;
    const wall = WALL[s.wallMat] ?? WALL.wallConcrete;
    polys.push({ ring: s.ring.map((p) => new Pt(p.x + 0.12, p.y + 0.12)), fill: 'rgba(20,18,16,0.26)', stroke: undefined });
    polys.push({ ring: s.ring, fill: roof, stroke: wall, strokeW: 0.12 });
  }
  const lines = scene.paths
    .filter((p) => !p.hidden2d && (!opts.only || opts.only(p.group)))
    .map((p) => ({ pts: p.pts, stroke: p.mat === 'markWhite' ? '#efeadc' : '#6a6f78', width: Math.max(0.06, p.width) }));
  const dots = scene.props
    .filter((p) => (p.kind === 'tree' || p.kind === 'treeSmall' || p.kind === 'conifer') && (!opts.only || opts.only(p.group)))
    .map((p) => ({ at: p.at, r: 0.42 * p.scale, fill: '#4b6b39' }));
  return { title, subtitle, boundary, polys, lines, dots };
}

export function renderF3(panels: F3Panel[], opts: { width?: number; cols?: number; cellH?: number } = {}): string {
  const W = opts.width ?? 1280;
  const cols = opts.cols ?? 2;
  const rows = Math.ceil(panels.length / cols);
  const cellW = W / cols;
  const cellH = opts.cellH ?? cellW * 0.92;
  const H = rows * cellH + 16;

  const head = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-sans-serif, system-ui, sans-serif">
  <defs><clipPath id="clipAll"><rect x="0" y="0" width="${W}" height="${H}"/></clipPath></defs>
  <rect width="${W}" height="${H}" fill="#171a1f"/>`;

  const body = panels
    .map((p, i) => {
      const x0 = (i % cols) * cellW;
      const y0 = Math.floor(i / cols) * cellH;
      const pad = 10;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const q of p.boundary.outer) {
        minX = Math.min(minX, q.x);
        minY = Math.min(minY, q.y);
        maxX = Math.max(maxX, q.x);
        maxY = Math.max(maxY, q.y);
      }
      const spanX = Math.max(1e-6, maxX - minX);
      const spanY = Math.max(1e-6, maxY - minY);
      const innerW = cellW - pad * 2;
      const innerH = cellH - 62;
      const scale = Math.min(innerW / spanX, innerH / spanY);
      const ox = x0 + pad + (innerW - spanX * scale) / 2;
      const oy = y0 + 40 + (innerH - spanY * scale) / 2;
      const X = (x: number): number => (x - minX) * scale + ox;
      const Y = (y: number): number => oy + (maxY - y) * scale;

      const path = (ring: Pt[], holes?: Pt[][]): string => {
        const loop = (pts: Pt[]): string =>
          pts.length < 3 ? '' : `M${pts.map((q) => `${X(q.x).toFixed(2)},${Y(q.y).toFixed(2)}`).join('L')}Z`;
        let d = loop(ring);
        for (const h of holes ?? []) d += ' ' + loop(h);
        return d;
      };

      const polySvg = p.polys
        .map(
          (q) =>
            `<path d="${path(q.ring, q.holes)}" fill="${q.fill}" fill-rule="evenodd"${
              q.stroke ? ` stroke="${q.stroke}" stroke-width="${q.strokeW ?? 0.4}"` : ''
            }${q.opacity !== undefined ? ` opacity="${q.opacity}"` : ''}/>`
        )
        .join('');
      const lineSvg = (p.lines ?? [])
        .map(
          (l) =>
            `<path d="M${l.pts.map((q) => `${X(q.x).toFixed(2)},${Y(q.y).toFixed(2)}`).join('L')}" fill="none" stroke="${l.stroke}" stroke-width="${(l.width * scale).toFixed(2)}" stroke-linecap="round"${
              l.dash ? ` stroke-dasharray="${l.dash}"` : ''
            }${l.opacity !== undefined ? ` opacity="${l.opacity}"` : ''}/>`
        )
        .join('');
      const dotSvg = (p.dots ?? [])
        .map(
          (d) =>
            `<circle cx="${X(d.at.x).toFixed(2)}" cy="${Y(d.at.y).toFixed(2)}" r="${Math.max(0.7, d.r * scale).toFixed(2)}" fill="${d.fill}"${
              d.ring ? ` stroke="${d.ring}" stroke-width="0.4"` : ''
            }/>`
        )
        .join('');
      const labelSvg = (p.labels ?? [])
        .map(
          (l) =>
            `<text x="${X(l.at.x).toFixed(1)}" y="${Y(l.at.y).toFixed(1)}" font-size="${l.size ?? 10}" fill="${
              l.fill ?? '#f2f5f8'
            }" text-anchor="${l.anchor ?? 'middle'}" paint-order="stroke" stroke="#141619" stroke-width="2.4">${esc(l.text)}</text>`
        )
        .join('');

      const foot = (p.foot ?? [])
        .map((t, k) => `<text x="${x0 + pad}" y="${y0 + cellH - 26 + k * 13}" font-size="10.5" fill="#9aa4b1">${esc(t)}</text>`)
        .join('');

      return `<g>
  <rect x="${x0 + 2}" y="${y0 + 2}" width="${cellW - 4}" height="${cellH - 4}" fill="#1d2127" stroke="#2b313a"/>
  <text x="${x0 + pad}" y="${y0 + 18}" font-size="13" font-weight="600" fill="#e7ecf2">${esc(p.title)}</text>
  <text x="${x0 + pad}" y="${y0 + 33}" font-size="10.5" fill="#8b95a3">${esc(p.subtitle ?? '')}</text>
  <g>${polySvg}${lineSvg}${dotSvg}${labelSvg}</g>
  ${foot}
</g>`;
    })
    .join('\n');

  return `${head}${body}</svg>`;
}

export const MAT_SRGB = { srgb };
