// F2 报告出图（只在 test 侧用，不进 src）
//
// 要求（任务书 §十）：
//   · 每个样本输出：原始面 / 真实临街边 / 可选切分方向 / OBB 结果 / Offset 结果 /
//     碎片与接入 / 审计结论；
//   · **所有方案使用相同画幅、比例、场地边界和配色**；
//   · 明确区分：可建地块 / 内部 Fragment / 道路 / 公共预留 / 不可用残片；
//   · 每个子地块标出有效宽深与接入点；
//   · 不能只交 JSON。
//
// 版式：一条几何样本 = 一张图 = 多格并排。比例尺由本层统一算（全图一个），
// 每格内容区固定、页脚单独留白，避免标注压线。

import type { Pt } from '../src/core/geom';
import type { PlanSurface } from '../src/town/planning/core/surface';
import type { SiteRoadEdge } from '../src/town/planning/core/types';
import type { PieceRole, SubdivisionCandidate, SubdivisionRun } from '../src/town/planning/subdivision/types';

const FONT = "'Segoe UI','Microsoft YaHei','Noto Sans SC',sans-serif";

export const PALETTE = {
  bg: '#ffffff',
  panel: '#fcfdfe',
  panelLine: '#e2e7ed',
  parcel: '#d3e3f2',
  parcelLine: '#2c6a99',
  fragment: '#f7d7cf',
  fragmentLine: '#b04a35',
  compound: '#dbe8d2',
  compoundLine: '#557a40',
  reserved: '#efe8d6',
  reservedLine: '#87764e',
  road: '#9aa4b0',
  roadEdge: '#616b78',
  hole: '#ffffff',
  holeLine: '#aeb5be',
  building: '#464b53',
  axis: '#c98a1e',
  access: '#1a7f4b',
  alley: '#7a3f9d',
  ink: '#171b20',
  muted: '#69727e',
};

export interface DrawPiece {
  surface: PlanSurface;
  role: PieceRole;
  label: string;
  access?: { x: number; y: number; via: 'road' | 'alley' | 'existing' }[];
}

export interface Panel {
  title: string;
  subtitle?: string;
  boundary: PlanSurface;
  roads: SiteRoadEdge[];
  pieces?: DrawPiece[];
  axisHints?: { ang: number; label: string }[];
  buildings?: PlanSurface[];
  foot?: string[];
}

const PAD = 12;
const HEAD = 40;
const FOOT = 48;

function roleStyle(role: PieceRole): { fill: string; stroke: string; dash?: string } {
  switch (role) {
    case 'fragment':
      return { fill: PALETTE.fragment, stroke: PALETTE.fragmentLine, dash: '4 3' };
    case 'compound':
      return { fill: PALETTE.compound, stroke: PALETTE.compoundLine };
    case 'reserved':
      return { fill: PALETTE.reserved, stroke: PALETTE.reservedLine, dash: '6 4' };
    default:
      return { fill: PALETTE.parcel, stroke: PALETTE.parcelLine };
  }
}

export interface SheetOpts {
  width?: number;
  panelH?: number;
  cols?: number;
  title: string;
  note?: string;
}

/** 一张图 = 同一几何样本的多方案并排；比例尺与配色由这一层统一给出 */
export function renderSheet(panels: Panel[], opts: SheetOpts): string {
  const W = opts.width ?? 1200;
  const cols = opts.cols ?? Math.min(3, panels.length);
  const panelH = opts.panelH ?? 360;
  const rows = Math.ceil(panels.length / cols);
  const gap = 14;
  const headH = 66;
  const pw = (W - PAD * (cols + 1) - gap * (cols - 1)) / cols;
  const H = headH + rows * (panelH + gap) + PAD;

  // 全图统一比例：所有面板的场地 + 道路包围盒并集
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
  // 留 6% 边距：道路中心线常在包围盒最外侧，不留边会被裁掉一半，看起来"没有路"
  {
    const mx = Math.max((maxX - minX) * 0.06, 0.4);
    const my = Math.max((maxY - minY) * 0.06, 0.4);
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

  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
  out.push(`<rect width="${W}" height="${H}" fill="${PALETTE.bg}"/>`);
  out.push(
    `<text x="${PAD}" y="32" font-family="${FONT}" font-size="19" font-weight="600" fill="${PALETTE.ink}">${esc(opts.title)}</text>`
  );
  if (opts.note) {
    out.push(`<text x="${PAD}" y="52" font-family="${FONT}" font-size="11" fill="${PALETTE.muted}">${esc(opts.note)}</text>`);
  }

  const legend: [string, string, string][] = [
    ['可建地块', PALETTE.parcel, PALETTE.parcelLine],
    ['Fragment 残片', PALETTE.fragment, PALETTE.fragmentLine],
    ['Compound 组团', PALETTE.compound, PALETTE.compoundLine],
    ['Reserved 预留', PALETTE.reserved, PALETTE.reservedLine],
    ['城市道路', PALETTE.road, PALETTE.roadEdge],
    ['固定建筑', PALETTE.building, PALETTE.building],
  ];
  const lw = 92;
  const lx0 = Math.max(320, W - PAD - legend.length * lw - 30);
  legend.forEach(([name, fill, stroke], i) => {
    const x = lx0 + i * lw;
    out.push(`<rect x="${x}" y="22" width="11" height="9" fill="${fill}" stroke="${stroke}" stroke-width="1"/>`);
    out.push(`<text x="${x + 15}" y="30" font-family="${FONT}" font-size="9.5" fill="${PALETTE.muted}">${esc(name)}</text>`);
  });
  out.push(
    `<g font-family="${FONT}" font-size="9.5" fill="${PALETTE.muted}">` +
      `<circle cx="${lx0 + 4}" cy="47" r="3.2" fill="${PALETTE.access}"/><text x="${lx0 + 14}" y="50">路上接入</text>` +
      `<circle cx="${lx0 + 78}" cy="47" r="3.2" fill="${PALETTE.alley}"/><text x="${lx0 + 88}" y="50">巷接（需内部通道）</text>` +
      `<line x1="${lx0 + 226}" y1="47" x2="${lx0 + 250}" y2="47" stroke="${PALETTE.axis}" stroke-width="2" stroke-dasharray="5 3"/><text x="${lx0 + 256}" y="50">候选切分方向</text>` +
      `</g>`
  );

  panels.forEach((panel, idx) => {
    const gx = PAD + (idx % cols) * (pw + gap);
    const gy = headH + Math.floor(idx / cols) * (panelH + gap);
    const cid = `clip${idx}`;
    out.push(`<g transform="translate(${gx},${gy})">`);
    out.push(`<defs><clipPath id="${cid}"><rect x="0" y="0" width="${pw}" height="${panelH - FOOT}"/></clipPath></defs>`);
    out.push(`<rect width="${pw}" height="${panelH}" fill="${PALETTE.panel}" stroke="${PALETTE.panelLine}"/>`);
    out.push(
      `<text x="${PAD}" y="18" font-family="${FONT}" font-size="12.5" font-weight="600" fill="${PALETTE.ink}">${esc(panel.title)}</text>`
    );
    if (panel.subtitle) {
      out.push(
        `<text x="${PAD}" y="31" font-family="${FONT}" font-size="10" fill="${PALETTE.muted}">${esc(panel.subtitle)}</text>`
      );
    }

    out.push(`<g clip-path="url(#${cid})">`);

    const path = (ring: Pt[], fill: string, stroke: string, w: number, dash = '') =>
      `<path d="${ring
        .map((p, i) => `${i === 0 ? 'M' : 'L'}${((p.x - minX) * scale + ox).toFixed(2)},${(py(p.y) * scale + oy).toFixed(2)}`)
        .join(' ')} Z" fill="${fill}" stroke="${stroke}" stroke-width="${w}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;

    // 场地边界（含洞）
    out.push(path(panel.boundary.outer, 'none', PALETTE.ink, 1.5));
    for (const h of panel.boundary.holes) out.push(path(h, PALETTE.hole, PALETTE.holeLine, 1.1, '5 3'));

    // 道路（压在地块之下，带宽按等级）
    for (const r of panel.roads) {
      const x1 = (r.a.x - minX) * scale + ox;
      const y1 = py(r.a.y) * scale + oy;
      const x2 = (r.b.x - minX) * scale + ox;
      const y2 = py(r.b.y) * scale + oy;
      // 真实断面宽：车行道 + 两侧人行道 + 中央分隔带（世界单位）× 比例尺
      const wU = r.carriageSide * 2 + r.sidewalk * 2 + r.median;
      const w = Math.max(2.5, wU * scale);
      out.push(
        `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${
          PALETTE.road
        }" stroke-width="${w.toFixed(1)}" stroke-linecap="butt"/>`
      );
      out.push(
        `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(
          1
        )}" stroke="${PALETTE.roadEdge}" stroke-width="0.7" stroke-dasharray="7 5" opacity="0.85"/>`
      );
    }

    // 地块
    for (const p of panel.pieces ?? []) {
      const st = roleStyle(p.role);
      out.push(path(p.surface.outer, st.fill, st.stroke, 1.1, st.dash));
      for (const h of p.surface.holes) out.push(path(h, PALETTE.hole, st.stroke, 0.9, '4 3'));
    }

    // 固定建筑
    for (const b of panel.buildings ?? []) {
      out.push(path(b.outer, PALETTE.building, '#1b1f24', 1));
      for (const h of b.holes) out.push(path(h, PALETTE.panel, '#1b1f24', 0.8));
    }

    // 候选切分方向
    if (panel.axisHints?.length) {
      const cx = ((minX + maxX) / 2 - minX) * scale + ox;
      const cy = py((minY + maxY) / 2) * scale + oy;
      const len = Math.min(spanX, spanY) * scale * 0.42;
      for (const h of panel.axisHints) {
        const dx = Math.cos(h.ang) * len;
        const dy = -Math.sin(h.ang) * len;
        out.push(
          `<line x1="${(cx - dx).toFixed(1)}" y1="${(cy - dy).toFixed(1)}" x2="${(cx + dx).toFixed(1)}" y2="${(
            cy + dy
          ).toFixed(1)}" stroke="${PALETTE.axis}" stroke-width="1.5" stroke-dasharray="5 3" opacity="0.9"/>`
        );
      }
    }

    // 有效宽深（只在地块够大时标，避免糊）
    for (const p of panel.pieces ?? []) {
      const xs = p.surface.outer.map((q) => q.x);
      const ys = p.surface.outer.map((q) => q.y);
      const wPx = (Math.max(...xs) - Math.min(...xs)) * scale;
      const hPx = (Math.max(...ys) - Math.min(...ys)) * scale;
      if (wPx * hPx < 1400 || wPx < 32) continue;
      const cx = (p.surface.outer.reduce((s, q) => s + q.x, 0) / p.surface.outer.length - minX) * scale + ox;
      const cy = py(p.surface.outer.reduce((s, q) => s + q.y, 0) / p.surface.outer.length) * scale + oy;
      const areaU2 = Math.abs(
        p.surface.outer.reduce((s, q, i) => {
          const nx2 = p.surface.outer[(i + 1) % p.surface.outer.length];
          return s + (q.x * nx2.y - nx2.x * q.y);
        }, 0) / 2
      );
      const wM = ((Math.max(...xs) - Math.min(...xs)) * 7).toFixed(0);
      const hM = ((Math.max(...ys) - Math.min(...ys)) * 7).toFixed(0);
      out.push(
        `<text x="${cx.toFixed(1)}" y="${cy.toFixed(1)}" text-anchor="middle" font-family="${FONT}" font-size="7.6" fill="#2a323c">${wM}×${hM}</text>`
      );
      if (wPx * hPx > 2800) {
        out.push(
          `<text x="${cx.toFixed(1)}" y="${(cy + 9).toFixed(1)}" text-anchor="middle" font-family="${FONT}" font-size="7.2" fill="${
            PALETTE.muted
          }">${(areaU2 * 49).toFixed(0)} m²</text>`
        );
      }
    }

    // 接入点
    for (const p of panel.pieces ?? []) {
      for (const a of p.access ?? []) {
        const x = (a.x - minX) * scale + ox;
        const y = py(a.y) * scale + oy;
        const c = a.via === 'alley' ? PALETTE.alley : PALETTE.access;
        out.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.1" fill="${c}" stroke="#ffffff" stroke-width="1"/>`);
      }
    }
    out.push(`</g>`);

    // 页脚（独立留白区）
    (panel.foot ?? []).forEach((line, i) => {
      out.push(
        `<text x="${PAD}" y="${panelH - FOOT + 16 + i * 11.5}" font-family="${FONT}" font-size="9.4" fill="${
          line.startsWith('✗') ? '#b04a35' : line.startsWith('✓') ? '#1a7f4b' : PALETTE.muted
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

/** 候选 → 绘图块 */
export function toDrawPieces(run: SubdivisionRun): DrawPiece[] {
  return run.candidates.map((c: SubdivisionCandidate) => ({
    surface: c.surface,
    role: c.role,
    label: c.id,
    access: c.access.map((a) => ({ x: a.at.x, y: a.at.y, via: a.via })),
  }));
}
