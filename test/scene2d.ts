// F2.4-D · 2D 总平面渲染器（只读 SiteScene）
//
// 这里**不再做任何布局决策**，只做投影与上色。所有几何来自 `scene.ts` 压好的
// 那份 IR，所以 2D 与 3D 不可能不一致。

import { Pt } from '../src/core/geom';
import { hex, shade, solidPaint, type MatKey, type ScenePoly, type SiteScene } from '../src/town/planning/compose/scene';

export interface PlanOpts {
  /** 画布宽度（px） */
  width?: number;
  title?: string;
  subtitle?: string;
  /** 页脚若干行 */
  foot?: string[];
  /** 是否画图例 */
  legend?: boolean;
  /** 是否标注建筑名 */
  labels?: boolean;
  /** 暗色底（用于和 3D 面板并排时统一观感） */
  dark?: boolean;
}

// 注意：属性值用双引号包着，字体名里不能再用双引号 —— 否则 SVG 解析直接失败
// （librsvg 报 "Couldn't find end of Start Tag svg"）。
const FONT = "ui-sans-serif, -apple-system, 'Segoe UI', 'Noto Sans SC', 'Microsoft YaHei', sans-serif";

interface Frame {
  X: (x: number) => number;
  Y: (y: number) => number;
  scale: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function ringPath(ring: Pt[], f: Frame): string {
  if (ring.length < 3) return '';
  const d = ring.map((p, i) => `${i === 0 ? 'M' : 'L'}${f.X(p.x).toFixed(2)},${f.Y(p.y).toFixed(2)}`).join('');
  return `${d}Z`;
}

function polyPath(p: ScenePoly, f: Frame): string {
  const parts = [ringPath(p.ring, f)];
  for (const h of p.holes) parts.push(ringPath(h, f));
  return parts.join('');
}

/** 环面积（世界单位²），用于过滤退化面 */
function ringArea(ring: Pt[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 渲染一张总平面。
 *
 * 画序固定为：底板 → 地面（按 yM）→ 树 → 建筑（带投影）→ 标注 → 图例。
 * 建筑最后画，保证任何地面都不会盖到楼面上 —— 看图时"楼是不是压在路上"一眼可辨。
 */
export function renderPlan(scene: SiteScene, o: PlanOpts = {}): string {
  const W = o.width ?? 1180;
  const pad = 26;
  const headH = o.title ? 62 : 20;
  const footH = (o.foot?.length ?? 0) * 16 + (o.foot?.length ? 18 : 0);
  const legendH = o.legend === false ? 0 : legendBlockHeight(scene);
  const H = Math.round(W * 0.78) + headH + footH + legendH;

  const bb = scene.bbox;
  const spanX = Math.max(1e-6, bb.maxX - bb.minX);
  const spanY = Math.max(1e-6, bb.maxY - bb.minY);
  const availW = W - pad * 2;
  const availH = H - headH - footH - legendH - pad * 2;
  const scale = Math.min(availW / spanX, availH / spanY);
  const ox = pad + (availW - spanX * scale) / 2;
  const oy = headH + pad + (availH - spanY * scale) / 2;
  const f: Frame = {
    X: (x) => (x - bb.minX) * scale + ox,
    Y: (y) => oy + (bb.maxY - y) * scale,
    scale,
    minX: bb.minX,
    minY: bb.minY,
    maxX: bb.maxX,
    maxY: bb.maxY,
  };

  const bg = o.dark ? '#141619' : '#f4f1ea';
  const ink = o.dark ? '#e8e6e0' : '#2b2f33';
  const faint = o.dark ? '#8d939b' : '#7b7f85';
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">`);
  out.push(`<rect width="${W}" height="${H}" fill="${bg}"/>`);

  if (o.title) {
    out.push(`<text x="${pad}" y="34" font-size="19" font-weight="600" fill="${ink}">${esc(o.title)}</text>`);
    if (o.subtitle) out.push(`<text x="${pad}" y="53" font-size="11.5" fill="${faint}">${esc(o.subtitle)}</text>`);
  }

  // ---- 地面：按 yM 升序（底板最先）
  const groundSorted = scene.ground.slice().sort((a, b) => a.yM - b.yM);
  for (const g of groundSorted) {
    if (Math.abs(ringArea(g.ring)) < 1e-6) continue;
    out.push(
      `<path d="${polyPath(g, f)}" fill="${hex(g.mat)}" fill-rule="evenodd" stroke="${shade(g.mat, -0.16)}" stroke-width="0.6"/>`
    );
  }

  // ---- 车位线：短白线，一块停车场的"可读性"全靠它
  for (const st of scene.stalls) {
    out.push(
      `<line x1="${f.X(st.a.x).toFixed(1)}" y1="${f.Y(st.a.y).toFixed(1)}" x2="${f.X(st.b.x).toFixed(1)}" y2="${f.Y(st.b.y).toFixed(1)}" stroke="#f2efe8" stroke-width="0.9" opacity="0.75"/>`
    );
  }

  // ---- 树：投影小圆 + 冠幅
  for (const t of scene.trees) {
    const cx = f.X(t.at.x);
    const cy = f.Y(t.at.y);
    // rM 是**米**，scale 是"像素 / 世界单位"，中间要除 7。
    // 早先直接把米当单位乘，树冠半径画成了 30 m —— 整片绿地被几个巨大的绿圆糊住。
    const r = Math.max(1.1, (t.rM / 7) * scale);
    const g1 = shade('canopy', 0.05 + t.tone * 0.12);
    out.push(
      `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(2)}" fill="${g1}" stroke="${shade('canopy', -0.12)}" stroke-width="0.45" opacity="0.95"/>`
    );
  }

  // ---- 建筑：投影 → 体块 → 描边
  for (const s of scene.solids) {
    const p = solidPaint(s.kind);
    const d = ringPath(s.ring, f);
    // 投影：按高度偏移，越高影子越长（游戏化处理，但方向一致）
    const sh = Math.min(9, 2 + (s.heightM / 7) * 0.55);
    out.push(
      `<path d="${d}" fill="rgba(0,0,0,${(0.16 + Math.min(0.12, s.heightM / 500)).toFixed(2)})" transform="translate(${(sh * 0.7).toFixed(1)},${sh.toFixed(1)})"/>`
    );
    out.push(`<path d="${d}" fill="${p.roofHex}" stroke="${shade(s.kind === 'hall' ? 'roofHall' : s.kind === 'shop' || s.kind === 'box' ? 'roofShop' : 'roof', -0.35)}" stroke-width="1"/>`);
    // 屋顶内圈：给出"女儿墙"的层次，避免一块死板的色块
    out.push(`<path d="${d}" fill="none" stroke="${shade(s.kind === 'hall' ? 'roofHall' : s.kind === 'shop' || s.kind === 'box' ? 'roofShop' : 'roof', 0.12)}" stroke-width="3"/>`);
  }

  // ---- 标注
  if (o.labels !== false) {
    for (const s of scene.solids) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const q of s.ring) {
        minX = Math.min(minX, q.x);
        maxX = Math.max(maxX, q.x);
        minY = Math.min(minY, q.y);
        maxY = Math.max(maxY, q.y);
      }
      const wpx = (maxX - minX) * scale;
      const hpx = (maxY - minY) * scale;
      if (wpx < 34 || hpx < 14) continue;
      const cx = f.X((minX + maxX) / 2);
      const cy = f.Y((minY + maxY) / 2);
      const label = s.floors > 1 ? `${s.floors}F` : s.name.slice(0, 4);
      out.push(
        `<text x="${cx.toFixed(1)}" y="${(cy + 3.6).toFixed(1)}" font-size="9.5" text-anchor="middle" fill="#1e2226" opacity="0.72">${esc(label)}</text>`
      );
    }
  }

  // ---- 比例尺 + 指北针
  const scaleBarM = niceScale(120 / scale * 7);
  const barPx = (scaleBarM / 7) * scale;
  const bx = pad + 4;
  const by = H - footH - legendH - 34;
  out.push(
    `<g><rect x="${bx}" y="${by}" width="${barPx.toFixed(1)}" height="5" fill="${ink}" opacity="0.8"/>` +
      `<rect x="${bx}" y="${by}" width="${(barPx / 2).toFixed(1)}" height="5" fill="${bg}"/>` +
      `<rect x="${bx}" y="${by}" width="${barPx.toFixed(1)}" height="5" fill="none" stroke="${ink}" stroke-width="0.8" opacity="0.8"/>` +
      `<text x="${bx}" y="${(by - 5).toFixed(1)}" font-size="9.5" fill="${faint}">0</text>` +
      `<text x="${(bx + barPx).toFixed(1)}" y="${(by - 5).toFixed(1)}" font-size="9.5" text-anchor="end" fill="${faint}">${scaleBarM} m</text></g>`
  );
  {
    const nx = W - pad - 16;
    const ny = headH + pad + 12;
    out.push(
      `<g opacity="0.75"><path d="M${nx},${ny - 13} L${nx - 5},${ny + 5} L${nx},${ny + 1} L${nx + 5},${ny + 5} Z" fill="${ink}"/>` +
        `<text x="${nx}" y="${ny + 17}" font-size="9.5" text-anchor="middle" fill="${faint}">N</text></g>`
    );
  }

  // ---- 图例
  if (o.legend !== false) out.push(legendBlock(scene, W, H - footH - legendH + 6, pad, ink, faint));

  // ---- 页脚
  if (o.foot?.length) {
    let y = H - footH + 14;
    for (const line of o.foot) {
      out.push(`<text x="${pad}" y="${y}" font-size="10.5" fill="${faint}">${esc(line)}</text>`);
      y += 16;
    }
  }

  out.push('</svg>');
  return out.join('\n');
}

function legendBlockHeight(scene: SiteScene): number {
  return 18 + Math.ceil(scene.legend.length / 5) * 15 + 10;
}

function legendBlock(scene: SiteScene, W: number, top: number, pad: number, ink: string, faint: string): string {
  const out: string[] = [];
  out.push(`<g><text x="${pad}" y="${top + 10}" font-size="10" font-weight="600" fill="${ink}" opacity="0.8">图例（地面用途 · m²）</text></g>`);
  let x = pad;
  let y = top + 26;
  const colW = (W - pad * 2) / 5;
  for (const l of scene.legend) {
    out.push(`<rect x="${x}" y="${y - 9}" width="12" height="9" rx="1.5" fill="${hex(l.mat)}" stroke="${shade(l.mat, -0.2)}" stroke-width="0.6"/>`);
    out.push(
      `<text x="${x + 17}" y="${y - 1}" font-size="10" fill="${ink}" opacity="0.85">${esc(l.label)} <tspan fill="${faint}">${l.areaM2}</tspan></text>`
    );
    x += colW;
    if (x > W - pad - colW * 0.5) {
      x = pad;
      y += 15;
    }
  }
  return out.join('\n');
}

/** 取一个"整"的比例尺长度（米） */
function niceScale(v: number): number {
  const cands = [10, 20, 25, 50, 100, 150, 200, 300, 500];
  let best = cands[0];
  for (const c of cands) if (c <= v) best = c;
  return best;
}

// ---------------------------------------------------------------- 多面板

export interface PlanPanel {
  scene: SiteScene;
  title: string;
  subtitle?: string;
  foot?: string[];
}

/**
 * 把多个场景并排成一张对照图（用于"两个候选"与"新旧对照"）。
 *
 * 所有面板共用同一画幅比例与同一套配色 —— 不然并排看会误判"哪个更密"。
 */
export function renderCompare(panels: PlanPanel[], o: { width?: number; title?: string; subtitle?: string } = {}): string {
  const W = o.width ?? 1480;
  const n = Math.max(1, panels.length);
  const gap = 14;
  const pad = 20;
  const headH = 58;
  const cellW = (W - pad * 2 - gap * (n - 1)) / n;
  const cellH = Math.round(cellW * 0.82);
  const H = headH + cellH + pad + 26;

  // 统一比例尺：取所有面板 bbox 的最大跨度
  let spanX = 0;
  let spanY = 0;
  for (const p of panels) {
    spanX = Math.max(spanX, p.scene.bbox.maxX - p.scene.bbox.minX);
    spanY = Math.max(spanY, p.scene.bbox.maxY - p.scene.bbox.minY);
  }
  const inner = cellW - 22;
  const innerH = cellH - 46;
  const scale = Math.min(inner / Math.max(1e-6, spanX), innerH / Math.max(1e-6, spanY));

  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">`);
  out.push(`<rect width="${W}" height="${H}" fill="#f4f1ea"/>`);
  if (o.title) out.push(`<text x="${pad}" y="30" font-size="17" font-weight="600" fill="#2b2f33">${esc(o.title)}</text>`);
  if (o.subtitle) out.push(`<text x="${pad}" y="48" font-size="11" fill="#7b7f85">${esc(o.subtitle)}</text>`);

  panels.forEach((p, i) => {
    const x0 = pad + i * (cellW + gap);
    const y0 = headH;
    out.push(`<rect x="${x0}" y="${y0}" width="${cellW}" height="${cellH}" rx="4" fill="#fbf9f4" stroke="#d8d3c8" stroke-width="1"/>`);
    out.push(`<text x="${x0 + 11}" y="${y0 + 19}" font-size="12" font-weight="600" fill="#2b2f33">${esc(p.title)}</text>`);
    if (p.subtitle) out.push(`<text x="${x0 + 11}" y="${y0 + 33}" font-size="10" fill="#7b7f85">${esc(p.subtitle)}</text>`);

    const bb = p.scene.bbox;
    const ox = x0 + (cellW - (bb.maxX - bb.minX) * scale) / 2;
    const oy = y0 + 40 + (innerH - (bb.maxY - bb.minY) * scale) / 2 + 6;
    const f: Frame = {
      X: (x) => (x - bb.minX) * scale + ox,
      Y: (y) => oy + (bb.maxY - y) * scale,
      scale,
      minX: bb.minX,
      minY: bb.minY,
      maxX: bb.maxX,
      maxY: bb.maxY,
    };
    out.push(`<g>`);
    for (const g of p.scene.ground.slice().sort((a, b) => a.yM - b.yM)) {
      if (Math.abs(ringArea(g.ring)) < 1e-6) continue;
      out.push(`<path d="${polyPath(g, f)}" fill="${hex(g.mat)}" fill-rule="evenodd" stroke="${shade(g.mat, -0.16)}" stroke-width="0.5"/>`);
    }
    for (const st of p.scene.stalls) {
      out.push(
        `<line x1="${f.X(st.a.x).toFixed(1)}" y1="${f.Y(st.a.y).toFixed(1)}" x2="${f.X(st.b.x).toFixed(1)}" y2="${f.Y(st.b.y).toFixed(1)}" stroke="#faf8f2" stroke-width="0.7" opacity="0.7"/>`
      );
    }
    for (const t of p.scene.trees) {
      out.push(
        `<circle cx="${f.X(t.at.x).toFixed(1)}" cy="${f.Y(t.at.y).toFixed(1)}" r="${Math.max(0.9, (t.rM / 7) * scale).toFixed(2)}" fill="${shade('canopy', 0.05 + t.tone * 0.1)}"/>`
      );
    }
    for (const s of p.scene.solids) {
      const paint = solidPaint(s.kind);
      const d = ringPath(s.ring, f);
      const sh = Math.min(7, 1.5 + (s.heightM / 7) * 0.5);
      out.push(`<path d="${d}" fill="rgba(0,0,0,0.17)" transform="translate(${(sh * 0.7).toFixed(1)},${sh.toFixed(1)})"/>`);
      out.push(`<path d="${d}" fill="${paint.roofHex}" stroke="${shade('roof', -0.3)}" stroke-width="0.8"/>`);
    }
    out.push(`</g>`);
    if (p.foot?.length) {
      let y = y0 + cellH - 8 - (p.foot.length - 1) * 13;
      for (const line of p.foot) {
        out.push(`<text x="${x0 + 11}" y="${y}" font-size="9.5" fill="#6b6f75">${esc(line)}</text>`);
        y += 13;
      }
    }
  });

  out.push('</svg>');
  return out.join('\n');
}

export type { MatKey };
