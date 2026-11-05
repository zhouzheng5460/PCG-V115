// F2.4-C · Target Plan 出图
//
// 与 `compose-draw` 分开：那份画的是生成结果（SiteComposition），
// 这份画的是**人画的方案**（TargetPlan），图层与配色要与生成结果可比。

import { Pt } from '../src/core/geom';
import type { PlanSurface } from '../src/town/planning/core/surface';
import type { Frame } from '../src/town/planning/compose/frame';
import { rectAt, roadRing, zoneRing, type TargetPlan, type ZoneKind } from './targets';

const FONT = "'Noto Sans SC','PingFang SC','Microsoft YaHei',sans-serif";

const ZONE_FILL: Record<ZoneKind, string> = {
  plaza: '#f0e2c8',
  forecourt: '#e9e5dc',
  green: '#cfe4c4',
  buffer: '#bcd6ac',
  loading: '#cfd3d8',
  parking: '#c9cbd0',
  walk: '#f5efe3',
};

const ROAD_FILL: Record<string, string> = {
  primary: '#6f747c',
  secondary: '#7d828a',
  service: '#8a8f96',
  pedestrian: '#a9a49a',
};

export interface TargetPanel {
  title: string;
  subtitle: string;
  /** 只画结构（分区 + 路 + 口），不画建筑 */
  structureOnly?: boolean;
  showLabels?: boolean;
  foot?: string[];
}

export function renderTargetSheet(plan: TargetPlan, f: Frame, parcel: PlanSurface, panels: TargetPanel[], opts: { width?: number } = {}): string {
  const W = opts.width ?? 1560;
  const cols = panels.length;
  const gap = 14;
  const pad = 16;
  const pw = (W - pad * 2 - gap * (cols - 1)) / cols;
  const ph = 560;
  const H = 96 + ph + 24;
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">`);
  out.push(`<rect width="${W}" height="${H}" fill="#0f1216"/>`);
  out.push(`<text x="${pad}" y="34" font-size="19" fill="#e9eef5" font-weight="600">${esc(plan.label)} · C0 人工 Target Plan</text>`);
  out.push(`<text x="${pad}" y="56" font-size="12" fill="#8f9bab">${esc(plan.intent[0] ?? '')}</text>`);
  // 意图清单
  plan.intent.slice(1).forEach((t, i) => {
    out.push(`<text x="${pad}" y="${72 + i * 13}" font-size="10.5" fill="#7f8b9a">· ${esc(t)}</text>`);
  });
  panels.forEach((p, i) => {
    out.push(panel(plan, f, parcel, p, pad + i * (pw + gap), 96 + Math.max(0, plan.intent.length - 1) * 0, pw, ph));
  });
  out.push('</svg>');
  return out.join('\n');
}

function panel(plan: TargetPlan, f: Frame, parcel: PlanSurface, p: TargetPanel, x: number, y: number, w: number, h: number): string {
  const out: string[] = [];
  const oy = 96 + 0;
  void oy;
  out.push(`<g transform="translate(${x},${Math.max(y, 108)})">`);
  out.push(`<rect width="${w}" height="${h}" rx="6" fill="#171b21" stroke="#252b33"/>`);
  out.push(`<text x="12" y="21" font-size="12.5" fill="#dbe3ec" font-weight="600">${esc(p.title)}</text>`);
  out.push(`<text x="12" y="37" font-size="10.5" fill="#7f8b9a">${esc(p.subtitle)}</text>`);

  const bb = bounds(parcel, f);
  const pad = 10;
  const scale = Math.min((w - pad * 2) / (bb.maxX - bb.minX), (h - 92 - pad * 2) / (bb.maxY - bb.minY));
  const dx = (w - (bb.maxX - bb.minX) * scale) / 2;
  const dy = 44 + (h - 92 - (bb.maxY - bb.minY) * scale) / 2;
  const X = (v: number) => dx + (v - bb.minX) * scale;
  const Y = (v: number) => dy + (bb.maxY - v) * scale;
  const ring = (r: Pt[]) => r.map((q, i) => `${i === 0 ? 'M' : 'L'}${X(q.x).toFixed(2)},${Y(q.y).toFixed(2)}`).join('') + 'Z';
  const surf = (s: PlanSurface, fill: string, stroke: string, sw = 0.8, op = 1) => {
    let d = ring(s.outer);
    for (const q of s.holes) d += ring(q);
    return `<path d="${d}" fill="${fill}" fill-opacity="${op}" fill-rule="evenodd" stroke="${stroke}" stroke-width="${sw}"/>`;
  };

  out.push(surf(parcel, '#1d222a', '#3b434d', 1.2));

  // 分区
  for (const z of plan.zones) {
    out.push(surf(zoneRing(f, z), ZONE_FILL[z.kind], 'none', 0, 0.85));
  }
  // 道路
  for (const r of plan.roads) {
    for (const s of roadRing(f, r)) out.push(surf(s, ROAD_FILL[r.cls], '#2f353d', 0.6, 1));
  }
  // 建筑
  if (!p.structureOnly) {
    for (const b of plan.buildings) {
      const s = rectAt(f, b);
      const t = Math.min(1, Math.max(0, (b.floors * 3 - 6) / 30));
      const a = [58, 68, 82];
      const c = [26, 32, 40];
      const m = a.map((v, i) => Math.round(v + (c[i] - v) * t));
      out.push(surf(s, `rgb(${m[0]},${m[1]},${m[2]})`, '#20242a', 1.0));
      if (p.showLabels) {
        const ctr = s.outer.reduce((acc, q) => new Pt(acc.x + q.x / 4, acc.y + q.y / 4), new Pt(0, 0));
        out.push(
          `<text x="${X(ctr.x).toFixed(1)}" y="${Y(ctr.y).toFixed(1)}" font-size="7.5" text-anchor="middle" fill="#dfe6ee">${esc(
            b.name
          )}</text>`
        );
      }
    }
  }
  // 街口
  for (const g of plan.gates) {
    const q = f.at(g.s, g.t);
    const col = g.kind === 'freight' ? '#d98a2b' : g.kind === 'vehicle' ? '#5ab0f0' : '#e4553d';
    out.push(`<circle cx="${X(q.x).toFixed(2)}" cy="${Y(q.y).toFixed(2)}" r="5.5" fill="none" stroke="${col}" stroke-width="2"/>`);
  }
  // 主轴端点小箭头（结构图用，强调"从哪里进"）
  if (p.structureOnly) {
    for (const r of plan.roads.filter((x) => x.cls === 'pedestrian')) {
      const a = f.at(r.pts[0][0], r.pts[0][1]);
      const b = f.at(r.pts[r.pts.length - 1][0], r.pts[r.pts.length - 1][1]);
      out.push(`<circle cx="${X(a.x).toFixed(1)}" cy="${Y(a.y).toFixed(1)}" r="3" fill="#e8eef6"/>`);
      out.push(`<circle cx="${X(b.x).toFixed(1)}" cy="${Y(b.y).toFixed(1)}" r="3" fill="#e8eef6"/>`);
    }
  }

  (p.foot ?? []).forEach((t, i) => {
    out.push(`<text x="12" y="${h - 26 + i * 12}" font-size="10" fill="#8794a4">${esc(t)}</text>`);
  });
  out.push('</g>');
  return out.join('\n');
}

function bounds(parcel: PlanSurface, f: Frame) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of parcel.outer) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  void f;
  const pad = 2;
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
