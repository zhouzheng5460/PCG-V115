// F2.4-D · 3D 渲染器（只读 SiteScene）
//
// 复用工程里已有的软件光栅器（`soft3d.ts`）与网格构造函数（`export/mesh.ts`），
// 几何全部来自 `scene.ts` 那份 IR —— 与 2D 同源，所以两个视图必然一致。

import { Pt } from '../src/core/geom';
import { flatPolygon, extrudeSolid, type Primitive } from '../src/export/mesh';
import { PALETTE, solidPaint, type SceneTree, type SiteScene } from '../src/town/planning/compose/scene';
import { renderPrimitives } from './soft3d';

/** 1 世界单位 = 7 m */
const U = (m: number) => m / 7;

/**
 * 场景 → 图元。
 *
 * 层次（`y` 单位 = 世界单位，1 u = 7 m）：
 *   底板 0 → 地面 0.06~0.22 m → 建筑从 0 起。
 * 地面之间的抬升按**米**算再换算，所以 2D 的叠压顺序在 3D 里也是同一个顺序，
 * 不会出现"路被草地压住"这种两边不一致。
 */
export function scenePrims(scene: SiteScene): Primitive[] {
  const prims: Primitive[] = [];
  const add = (p: Primitive | null) => {
    if (p) prims.push(p);
  };

  for (const g of scene.ground) {
    add(flatPolygon(g.ring, U(g.yM), `g-${g.tag}-${g.mat}`, 'ground', PALETTE[g.mat], g.holes));
  }

  for (const t of scene.trees) treeAt(t, prims);

  for (const s of scene.solids) {
    const paint = solidPaint(s.kind);
    prims.push(...extrudeSolid(s.ring, 0.001, U(s.heightM), `b-${s.id}`, 'building', paint.roof, paint.wall));
  }
  return prims;
}

/**
 * 一棵树 = 树干（四棱柱）+ 树冠（八棱柱）。
 *
 * 用棱柱而不是圆锥：光栅器只有平光着色，棱柱的八个侧面会自然形成明暗分级，
 * 远看像一团有体积的树冠；圆锥在平光下会变成一片死板的色块。
 */
function treeAt(t: SceneTree, out: Primitive[]): void {
  const trunkH = U(2.2);
  const trunkR = Math.max(0.012, U(0.32));
  const box = [
    new Pt(t.at.x - trunkR, t.at.y - trunkR),
    new Pt(t.at.x + trunkR, t.at.y - trunkR),
    new Pt(t.at.x + trunkR, t.at.y + trunkR),
    new Pt(t.at.x - trunkR, t.at.y + trunkR),
  ];
  out.push(...extrudeSolid(box, 0.001, trunkH, 'trunk', 'tree', PALETTE.trunk, PALETTE.trunk));

  const r = U(t.rM);
  const h = U(t.hM) - trunkH;
  const crown: Pt[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    crown.push(new Pt(t.at.x + Math.cos(a) * r, t.at.y + Math.sin(a) * r));
  }
  const c0 = PALETTE.canopy;
  const tone = 0.85 + t.tone * 0.3;
  const col: [number, number, number] = [Math.min(1, c0[0] * tone), Math.min(1, c0[1] * tone), Math.min(1, c0[2] * tone)];
  out.push(...extrudeSolid(crown, trunkH, h, 'crown', 'tree', col, col));
}

export interface Render3DOpts {
  size?: number;
  azimuth?: number;
  elevation?: number;
  background?: [number, number, number];
  zoom?: number;
}

export interface RasterImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/** 正交鸟瞰（俯视） */
export function renderOrtho(scene: SiteScene, o: Render3DOpts = {}): RasterImage {
  return renderPrimitives(scenePrims(scene), {
    size: o.size ?? 900,
    azimuth: o.azimuth ?? -90,
    elevation: o.elevation ?? 89.5,
    background: o.background ?? [0.09, 0.1, 0.12],
    zoom: o.zoom ?? 1,
  });
}

/** 倾斜视角（默认 35° 俯角，45° 方位） */
export function renderOblique(scene: SiteScene, o: Render3DOpts = {}): RasterImage {
  return renderPrimitives(scenePrims(scene), {
    size: o.size ?? 900,
    azimuth: o.azimuth ?? 40,
    elevation: o.elevation ?? 32,
    background: o.background ?? [0.09, 0.1, 0.12],
    zoom: o.zoom ?? 1,
  });
}
