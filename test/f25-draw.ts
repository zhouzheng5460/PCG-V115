// F2.5 · 调试图渲染（2D）
//
// 这一轮的验收靠图，所以渲染器要能画四类东西：
//   多边形（街区/路面）、折线（候选切线、中心线）、点（拓扑节点）、文字。
// 六个图层共用同一套比例尺与配色，同一块地在不同图层里位置才对得上。

import { Pt } from '../src/core/geom';
import type { PlanSurface } from '../src/town/planning/core/surface';

const FONT = "ui-sans-serif, -apple-system, 'Segoe UI', 'Noto Sans SC', 'Microsoft YaHei', sans-serif";

export interface Panel {
  title: string;
  subtitle?: string;
  /**
   * 取景分组：同组的图共用一套比例尺与取景（可以叠着比），
   * 不同组各自取景（多场地并排时不至于把小场地画成一个点）。默认所有面板一组。
   */
  group?: string;
  boundary: PlanSurface;
  polys?: { ring: Pt[]; holes?: Pt[][]; fill: string; stroke?: string; strokeW?: number; opacity?: number }[];
  lines?: { pts: Pt[]; stroke: string; width?: number; dash?: string; opacity?: number }[];
  dots?: { at: Pt; r: number; fill: string; ring?: string }[];
  /** 文字标注（编号、分量号、cell id）：出图要能"看出骨架怎么形成" */
  labels?: { at: Pt; text: string; fill?: string; size?: number; dy?: number; anchor?: 'start' | 'middle' | 'end' }[];
  foot?: string[];
}

interface Frame {
  X: (x: number) => number;
  Y: (y: number) => number;
  scale: number;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function pathOf(ring: Pt[], holes: Pt[][], f: Frame): string {
  const one = (r: Pt[]) =>
    r.map((p, i) => `${i === 0 ? 'M' : 'L'}${f.X(p.x).toFixed(2)},${f.Y(p.y).toFixed(2)}`).join('') + 'Z';
  return [one(ring), ...holes.map(one)].join('');
}

/**
 * 渲染一张多面板图。
 *
 * 所有面板共用**同一个比例尺**（按最大跨度算），这样"候选切线"和"最终街区"
 * 两张图能直接叠着比 —— 否则读者会以为线条位置变了。
 */
export function renderF25(panels: Panel[], opts: { width?: number; title?: string; subtitle?: string; cols?: number } = {}): string {
  const W = opts.width ?? 1500;
  const n = Math.max(1, panels.length);
  const cols = Math.min(n, opts.cols ?? n);
  const rows = Math.ceil(n / cols);
  const pad = 20;
  const gap = 12;
  const headH = opts.title ? 56 : 16;
  const cellW = (W - pad * 2 - gap * (cols - 1)) / cols;
  const cellH = Math.round(cellW * 0.8);
  const H = headH + rows * (cellH + gap) + 22;

  const innerW = cellW - 22;
  // 留出底部两行脚注的位置：不留的话场地一大，图就压到字上
  const innerH = cellH - 76;

  // 取景范围（按组各算一套）
  interface Box {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    scale: number;
  }
  const boxes = new Map<string, Box>();
  for (const p of panels) {
    const key = p.group ?? '_';
    let b = boxes.get(key);
    if (!b) {
      b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, scale: 1 };
      boxes.set(key, b);
    }
    for (const q of p.boundary.outer) {
      b.minX = Math.min(b.minX, q.x);
      b.minY = Math.min(b.minY, q.y);
      b.maxX = Math.max(b.maxX, q.x);
      b.maxY = Math.max(b.maxY, q.y);
    }
  }
  for (const b of boxes.values()) {
    if (!Number.isFinite(b.minX)) {
      b.minX = 0;
      b.minY = 0;
      b.maxX = 1;
      b.maxY = 1;
    }
    b.scale = Math.min(innerW / Math.max(1e-6, b.maxX - b.minX), innerH / Math.max(1e-6, b.maxY - b.minY));
  }

  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">`);
  out.push(`<rect width="${W}" height="${H}" fill="#14171b"/>`);
  if (opts.title) out.push(`<text x="${pad}" y="30" font-size="17" font-weight="600" fill="#e8ecf1">${esc(opts.title)}</text>`);
  if (opts.subtitle) out.push(`<text x="${pad}" y="47" font-size="11" fill="#8f98a3">${esc(opts.subtitle)}</text>`);

  panels.forEach((p, i) => {
    const cx = i % cols;
    const cy = Math.floor(i / cols);
    const x0 = pad + cx * (cellW + gap);
    const y0 = headH + cy * (cellH + gap);
    out.push(`<rect x="${x0}" y="${y0}" width="${cellW}" height="${cellH}" rx="4" fill="#1b1f25" stroke="#2c323a"/>`);
    out.push(`<text x="${x0 + 11}" y="${y0 + 19}" font-size="12" font-weight="600" fill="#e8ecf1">${esc(p.title)}</text>`);
    if (p.subtitle) out.push(`<text x="${x0 + 11}" y="${y0 + 33}" font-size="10" fill="#8f98a3">${esc(p.subtitle)}</text>`);

    const bx = boxes.get(p.group ?? '_')!;
    const spanX = bx.maxX - bx.minX;
    const spanY = bx.maxY - bx.minY;
    const scale = bx.scale;
    const ox = x0 + (cellW - spanX * scale) / 2;
    const oy = y0 + 40 + (innerH - spanY * scale) / 2 + 4;
    const f: Frame = { X: (x) => (x - bx.minX) * scale + ox, Y: (y) => oy + (bx.maxY - y) * scale, scale };

    // 底板：生成范围
    out.push(`<path d="${pathOf(p.boundary.outer, p.boundary.holes, f)}" fill="#39424e" fill-rule="evenodd" stroke="#5a6675" stroke-width="1"/>`);
    for (const poly of p.polys ?? []) {
      out.push(
        `<path d="${pathOf(poly.ring, poly.holes ?? [], f)}" fill="${poly.fill}" fill-rule="evenodd"${
          poly.stroke ? ` stroke="${poly.stroke}" stroke-width="${poly.strokeW ?? 0.6}"` : ''
        }${poly.opacity !== undefined ? ` opacity="${poly.opacity}"` : ''}/>`
      );
    }
    for (const ln of p.lines ?? []) {
      if (ln.pts.length < 2) continue;
      const d = ln.pts.map((q, k) => `${k === 0 ? 'M' : 'L'}${f.X(q.x).toFixed(2)},${f.Y(q.y).toFixed(2)}`).join('');
      out.push(
        `<path d="${d}" fill="none" stroke="${ln.stroke}" stroke-width="${ln.width ?? 1}" stroke-linecap="round"${
          ln.dash ? ` stroke-dasharray="${ln.dash}"` : ''
        }${ln.opacity !== undefined ? ` opacity="${ln.opacity}"` : ''}/>`
      );
    }
    for (const dt of p.dots ?? []) {
      out.push(
        `<circle cx="${f.X(dt.at.x).toFixed(1)}" cy="${f.Y(dt.at.y).toFixed(1)}" r="${dt.r}" fill="${dt.fill}"${
          dt.ring ? ` stroke="${dt.ring}" stroke-width="1"` : ''
        }/>`
      );
    }
    for (const lb of p.labels ?? []) {
      out.push(
        `<text x="${f.X(lb.at.x).toFixed(1)}" y="${(f.Y(lb.at.y) + (lb.dy ?? -3)).toFixed(1)}" font-size="${lb.size ?? 8.5}" fill="${
          lb.fill ?? '#e8ecf1'
        }" text-anchor="${lb.anchor ?? 'middle'}" paint-order="stroke" stroke="#14171b" stroke-width="2.2">${esc(lb.text)}</text>`
      );
    }
    if (p.foot?.length) {
      let y = y0 + cellH - 8 - (p.foot.length - 1) * 12;
      for (const line of p.foot) {
        out.push(`<text x="${x0 + 11}" y="${y}" font-size="9.5" fill="#8f98a3">${esc(line)}</text>`);
        y += 12;
      }
    }
  });

  out.push('</svg>');
  return out.join('\n');
}

export const F25_COLORS = {
  block: '#5a6472',
  blockAlt: '#4b5563',
  road: '#20242a',
  arterial: '#c96a4a',
  collector: '#d9a13f',
  local: '#6fa8dc',
  candidate: '#7b8794',
  rejected: '#3f464f',
  node: '#f0e6c8',
  nodeRing: '#2b3138',
  merged: '#7fb069',
  sliver: '#b06f8a',
};
