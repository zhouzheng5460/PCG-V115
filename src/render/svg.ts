// 用 SVG 复刻原版 CityMap 的绘制效果（调试 / 静态导出用，主界面走 Canvas）

import { Pt } from '../core/geom';
import { Polygon } from '../core/polygon';
import type { Model } from '../town/model';
import type { Zone } from '../town/zones';
import { zoneToPolygon } from '../town/zones';
import { roadBand } from './road';
import { buildScene } from '../scene/build';
import { css } from '../scene/palette';

export const PALETTE = {
  paper: '#ccc5b8',
  light: '#99948a',
  medium: '#67635c',
  dark: '#1a1917',
};

const STROKE = 0.3;
const THICK = 1.8;

function pts(p: Polygon | Pt[], close = true): string {
  const arr = Array.from(p as Pt[]);
  if (arr.length === 0) return '';
  const d = arr.map((v) => `${v.x.toFixed(2)},${v.y.toFixed(2)}`).join(' ');
  return close ? `${d} ${arr[0].x.toFixed(2)},${arr[0].y.toFixed(2)}` : d;
}

export interface SvgOptions {
  showPatches?: boolean;
  showZones?: boolean;
  zones?: Zone[];
  blocked?: [number, number, number][];
  padding?: number;
  /** 强制视口（世界坐标），用来出路口 / 地块的局部放大图 */
  bounds?: { minX: number; minY: number; maxX: number; maxY: number };
  /** 每单位像素数，局部放大时调大 */
  scale?: number;
}

export function renderSVG(model: Model, opts: SvgOptions = {}): string {
  return renderModernSVG(model, opts);
}


// ---------------------------------------------------------------- 现代城市

/** 现代模式：直接铺 Scene 图层，2D 编辑器 / SVG / GLB 三者同一份数据 */
function renderModernSVG(model: Model, opts: SvgOptions): string {
  const pad = opts.padding ?? 10;
  const scene = buildScene(model);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of scene.surfaces) {
    for (const p of s.ring) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }
  if (!Number.isFinite(minX)) {
    minX = -100;
    minY = -100;
    maxX = 100;
    maxY = 100;
  }
  minX -= pad;
  minY -= pad;
  maxX += pad;
  maxY += pad;
  if (opts.bounds) {
    minX = opts.bounds.minX;
    minY = opts.bounds.minY;
    maxX = opts.bounds.maxX;
    maxY = opts.bounds.maxY;
  }

  const w = maxX - minX;
  const h = maxY - minY;
  const px = opts.scale ?? 6;
  const out: string[] = [];

  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX.toFixed(2)} ${minY.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)}" width="${Math.round(w * px)}" height="${Math.round(h * px)}">`
  );
  out.push(`<rect x="${minX}" y="${minY}" width="${w}" height="${h}" fill="${css('ground')}"/>`);

  // 铺装与线性要素插在同一个按高度排序的通道里画。
  //
  // 早先是"先把所有铺装铺完，再统一画所有线"，结果是线的 y 完全不参与层次：
  // 内部路两侧的人行道（1.5 m 宽的描边折线）必然压在两条内部路交叉处的车行道上，
  // 路口中间就多出一块错位的浅色楔子。合并成一个通道后，y 低的人行道会被
  // y 高的沥青盖掉，高度差才真正起到"层次"作用。
  type Layer = { y: number; poly?: (typeof scene.surfaces)[number]; line?: (typeof scene.paths)[number] };
  const layers: Layer[] = [];
  for (const s of scene.surfaces) layers.push({ y: s.y, poly: s });
  for (const p of scene.paths) if (p.pts.length >= 2) layers.push({ y: p.y, line: p });
  layers.sort((a, b) => a.y - b.y);

  for (const L of layers) {
    const s = L.poly;
    if (s) {
      out.push(`<polygon points="${pts(s.ring)}" fill="${css(s.mat)}" stroke="none"/>`);
      continue;
    }
    const p = L.line as (typeof scene.paths)[number];
    const col = css(p.mat);
    if (!p.height) {
      out.push(
        `<polyline points="${pts(p.pts, false)}" fill="none" stroke="${col}" stroke-width="${p.width.toFixed(3)}" stroke-linecap="round" stroke-linejoin="round"/>`
      );
    } else {
      out.push(
        `<polyline points="${pts(p.pts, false)}" fill="none" stroke="${col}" stroke-width="${p.width.toFixed(3)}" stroke-linecap="butt"/>`
      );
    }
  }

  // 建筑：屋顶填充 + 墙面描边
  for (const s of scene.solids) {
    out.push(
      `<polygon points="${pts(s.ring)}" fill="${css(s.roofMat)}" stroke="${css(s.wallMat)}" stroke-width="0.12" stroke-linejoin="miter"/>`
    );
  }

  // 道具：树画圆点，路灯画小点
  for (const p of scene.props) {
    if (p.kind === 'tree' || p.kind === 'treeSmall' || p.kind === 'conifer') {
      out.push(`<circle cx="${p.at.x.toFixed(2)}" cy="${p.at.y.toFixed(2)}" r="${(0.28 * p.scale).toFixed(2)}" fill="${css(p.kind === 'conifer' ? 'leafDark' : 'leaf')}"/>`);
    } else if (p.kind === 'lamp' || p.kind === 'lampDouble') {
      /**
       * 路灯在 2D 里也要表现朝向。
       *
       * 旧版只画一个白圆点，灯臂`rot`（约定指向车行道中线）完全看不出来，
       * 于是"灯是不是装在正确一侧 / 有没有朝向马路"只能去 3D 里核对。
       * 这里按与 `export/props.ts` 相同的 rot 画一根短灯臂 + 灯头：
       * 杆位一个小圆点，末端一个更小的白点，方向与 3D 完全一致。
       */
      const arm = 0.44 * (p.scale || 1);
      const ex = p.at.x + Math.cos(p.rot) * arm;
      const ey = p.at.y + Math.sin(p.rot) * arm;
      const white = css('markWhite');
      out.push(
        `<line x1="${p.at.x.toFixed(2)}" y1="${p.at.y.toFixed(2)}" x2="${ex.toFixed(2)}" y2="${ey.toFixed(2)}" stroke="${white}" stroke-width="0.045" stroke-linecap="round"/>`
      );
      out.push(`<circle cx="${p.at.x.toFixed(2)}" cy="${p.at.y.toFixed(2)}" r="0.075" fill="${white}"/>`);
      out.push(`<circle cx="${ex.toFixed(2)}" cy="${ey.toFixed(2)}" r="0.055" fill="${white}"/>`);
    }
  }

  if (opts.showPatches) {
    for (const patch of model.patches) {
      out.push(
        `<polygon points="${pts(patch.shape)}" fill="none" stroke="${PALETTE.dark}" stroke-width="0.2" opacity="0.45"/>`
      );
    }
  }

  if (opts.showZones && opts.zones) {
    for (const z of opts.zones) {
      if (!z.enabled) continue;
      const ring = zoneToPolygon(z);
      out.push(
        `<polygon points="${pts(ring)}" fill="rgba(196,72,60,0.22)" stroke="#c4483c" stroke-width="0.6" stroke-dasharray="3 2"/>`
      );
    }
  }

  out.push('</svg>');
  return out.join('\n');
}
