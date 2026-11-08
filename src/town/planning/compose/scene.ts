// F2.4-D · 统一场景 IR
//
// 一份 `SiteScene` 同时喂给 2D 平面图和 3D 鸟瞰图 —— 这是任务书任务 C 的硬要求：
// "不能出现 2D 有道路、3D 没道路，或者两个视图建筑不一致的情况"。
// 所以这里不是"给 2D 画一遍、再给 3D 画一遍"，而是**先把场地压成一份带材质的几何**，
// 两个渲染器都只做投影：
//
//   SiteComposition ──sceneFromSite()──▶ SiteScene ──┬──▶ scene2d.ts  （SVG 总平面）
//                                                   └──▶ scene3d.ts  （软件光栅 3D）
//
// 材质的 RGB 只定义一次（`PALETTE`），2D 的十六进制颜色从同一份 RGB 推出来，
// 于是"2D 的草地绿"和"3D 的草地绿"永远是同一个绿。

import { Pt } from '../../../core/geom';
import { insideSurface, distToSurfaceEdge, surfaceArea, type PlanSurface } from '../core/surface';
import type { GroundKind, SiteComposition } from './types';
import { makeRng } from '../subdivision/geom';

// ---------------------------------------------------------------- 材质

export type MatKey =
  | 'base'
  | 'road'
  | 'sidewalk'
  | 'plaza'
  | 'forecourt'
  | 'courtyard'
  | 'green'
  | 'lawn'
  | 'planting'
  | 'loading'
  | 'parking'
  | 'footpath'
  | 'driveway'
  | 'unassigned'
  | 'roof'
  | 'wall'
  | 'roofHall'
  | 'wallHall'
  | 'roofShop'
  | 'wallShop'
  | 'roofTower'
  | 'wallTower'
  | 'trunk'
  | 'canopy';

/**
 * 全部材质色（sRGB 0~1）。
 *
 * 取色原则：整体偏灰、饱和度低，靠**明度差**分层而不是靠艳色对比 ——
 * 游戏里一眼能读出"这是路、那是铺装、那是草"，但不会像分析图那样花。
 */
export const PALETTE: Record<MatKey, [number, number, number]> = {
  base: [0.55, 0.55, 0.53],
  road: [0.26, 0.27, 0.3],
  sidewalk: [0.72, 0.7, 0.66],
  plaza: [0.78, 0.73, 0.64],
  forecourt: [0.82, 0.78, 0.7],
  courtyard: [0.75, 0.7, 0.62],
  green: [0.42, 0.55, 0.32],
  lawn: [0.5, 0.63, 0.37],
  planting: [0.34, 0.46, 0.28],
  loading: [0.58, 0.58, 0.6],
  parking: [0.45, 0.46, 0.48],
  footpath: [0.8, 0.75, 0.66],
  driveway: [0.3, 0.31, 0.34],
  unassigned: [0.6, 0.5, 0.42],
  roof: [0.62, 0.58, 0.53],
  wall: [0.86, 0.83, 0.78],
  roofHall: [0.5, 0.53, 0.58],
  wallHall: [0.75, 0.77, 0.8],
  roofShop: [0.72, 0.62, 0.52],
  wallShop: [0.88, 0.84, 0.76],
  roofTower: [0.45, 0.5, 0.58],
  wallTower: [0.82, 0.85, 0.9],
  trunk: [0.3, 0.24, 0.18],
  canopy: [0.28, 0.42, 0.24],
};

export const MAT_LABEL: Partial<Record<MatKey, string>> = {
  road: '道路',
  sidewalk: '人行道',
  plaza: '广场',
  forecourt: '建筑前场',
  courtyard: '庭院铺装',
  green: '绿地',
  lawn: '草坪',
  planting: '种植带',
  loading: '货运/装卸',
  parking: '停车铺装',
  footpath: '步行道',
  driveway: '车行道',
  unassigned: '未设计',
};

/** 同一份 RGB → CSS 颜色（2D 与 3D 用同一个绿） */
export function hex(k: MatKey): string {
  const c = PALETTE[k];
  const f = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  return `#${f(c[0])}${f(c[1])}${f(c[2])}`;
}

/** 明暗调整（2D 描边 / 阴影用） */
export function shade(k: MatKey, d: number): string {
  const c = PALETTE[k];
  const f = (v: number) => Math.round(Math.min(1, Math.max(0, v + d)) * 255).toString(16).padStart(2, '0');
  return `#${f(c[0])}${f(c[1])}${f(c[2])}`;
}

// ---------------------------------------------------------------- IR

export interface ScenePoly {
  mat: MatKey;
  ring: Pt[];
  holes: Pt[][];
  /** 抬升高度（米）。同层地面用小偏移压住下层，避免 z-fighting */
  yM: number;
  /** 语义标签（2D 图例与命中测试用） */
  tag: string;
  /** 面积（m²） */
  areaM2: number;
}

export interface SceneSolid {
  id: string;
  /** 体块名（厂房 / 板楼 / 店面 …） */
  name: string;
  /** 语法来源：决定 3D 材质 */
  kind: 'residential' | 'shop' | 'hall' | 'office' | 'tower' | 'box';
  ring: Pt[];
  /** 底标高（米） */
  yM: number;
  /** 高度（米） */
  heightM: number;
  /** 层数（2D 标注用） */
  floors: number;
  /** 所属地块 */
  parcelId: string;
}

export interface SceneTree {
  at: Pt;
  /** 冠幅半径（米） */
  rM: number;
  /** 树高（米） */
  hM: number;
  /** 色相扰动 0~1 */
  tone: number;
}

export interface SiteScene {
  id: string;
  typology: string;
  /** 街区红线（底板轮廓） */
  boundary: PlanSurface;
  ground: ScenePoly[];
  solids: SceneSolid[];
  trees: SceneTree[];
  /** 车位分隔线（2D 画线；3D 不画，尺度太小反而脏） */
  stalls: { a: Pt; b: Pt }[];
  /** 图例（按出现顺序） */
  legend: { mat: MatKey; label: string; areaM2: number }[];
  /** 统计（渲染与报告共用） */
  stats: {
    blockM2: number;
    baseM2: number;
    buildingM2: number;
    greenM2: number;
    pavedM2: number;
    roadM2: number;
    trees: number;
    maxHeightM: number;
    /** 各用途面积（2D 饼图/图例） */
    byMat: Partial<Record<MatKey, number>>;
  };
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
}

// ---------------------------------------------------------------- 映射

const KIND_TO_MAT: Record<GroundKind, MatKey> = {
  plaza: 'plaza',
  forecourt: 'forecourt',
  courtyard: 'courtyard',
  loading: 'loading',
  'parking-deck': 'parking',
  footpath: 'footpath',
  driveway: 'driveway',
  sidewalk: 'sidewalk',
  green: 'green',
  planting: 'planting',
  planter: 'planting',
  unassigned: 'unassigned',
};

const M2 = (u2: number) => u2 * 49;

function kindOfGrammar(g: string): SceneSolid['kind'] {
  if (g === 'hall') return 'hall';
  if (g === 'street-shop-line' || g === 'big-box') return 'shop';
  if (g === 'office') return 'office';
  if (g === 'tower') return 'tower';
  if (g === 'compound-mixed') return 'box';
  return 'residential';
}

function solidMats(k: SceneSolid['kind']): { roof: MatKey; wall: MatKey } {
  if (k === 'hall') return { roof: 'roofHall', wall: 'wallHall' };
  if (k === 'shop' || k === 'box') return { roof: 'roofShop', wall: 'wallShop' };
  if (k === 'tower' || k === 'office') return { roof: 'roofTower', wall: 'wallTower' };
  return { roof: 'roof', wall: 'wall' };
}

export function solidPaint(k: SceneSolid['kind']): { roof: [number, number, number]; wall: [number, number, number]; roofHex: string; wallHex: string } {
  const m = solidMats(k);
  return { roof: PALETTE[m.roof], wall: PALETTE[m.wall], roofHex: hex(m.roof), wallHex: hex(m.wall) };
}

/**
 * 把一份合成方案压成场景。
 *
 * 地面的绘制顺序（`yM` 递增）就是叠压关系：
 *   底板 → 绿地/铺装 → 道路 → 步行 → 花坛。
 * 2D 按 `yM` 排序画（后画的压在上面），3D 用 `yM` 当 z 偏移 —— 两边同一个顺序。
 */
export function sceneFromSite(c: SiteComposition): SiteScene {
  const ground: ScenePoly[] = [];
  const solids: SceneSolid[] = [];
  const trees: SceneTree[] = [];
  const stalls: { a: Pt; b: Pt }[] = [];
  for (const pa of c.parking) {
    for (const f of pa.layout?.fronts ?? []) stalls.push({ a: f[0], b: f[1] });
  }
  const rng = makeRng(20261106, `scene:${c.id}`);

  // ① 底板：整块红线。上色按用地类型，但都压得很暗，只在地面层没盖到的缝里露出来
  ground.push({
    mat: 'base',
    ring: c.input.boundary.outer,
    holes: c.input.boundary.holes,
    yM: 0,
    tag: '街区底板',
    areaM2: M2(surfaceArea(c.input.boundary)),
  });

  // ② 绿地 / 铺装（先铺，路压在上面）
  const greens: PlanSurface[] = [];
  for (const g of c.ground) {
    if (g.kind === 'planter') continue; // 花坛最后画
    const mat = KIND_TO_MAT[g.kind];
    ground.push({
      mat,
      ring: g.surface.outer,
      holes: g.surface.holes,
      yM: mat === 'green' || mat === 'lawn' || mat === 'planting' ? 0.06 : 0.1,
      tag: g.purpose.slice(0, 28),
      areaM2: g.areaM2,
    });
    if (mat === 'green' || mat === 'planting' || mat === 'lawn') greens.push(g.surface);
    if (g.kind === 'courtyard' && c.typology !== 'retail') greens.push(g.surface);
  }

  // ③ 道路（含街区中庭）
  for (const r of c.infra.roads) {
    ground.push({ mat: 'road', ring: r.surface.outer, holes: r.surface.holes, yM: 0.16, tag: r.reason.slice(0, 24), areaM2: M2(surfaceArea(r.surface)) });
  }
  for (const v of c.voids) {
    ground.push({ mat: 'green', ring: v.surface.outer, holes: v.surface.holes, yM: 0.08, tag: v.purpose.slice(0, 24), areaM2: v.areaM2 });
    greens.push(v.surface);
  }

  // ④ 花坛（最上层地面）
  for (const g of c.ground) {
    if (g.kind !== 'planter') continue;
    ground.push({ mat: 'planting', ring: g.surface.outer, holes: g.surface.holes, yM: 0.22, tag: '花坛', areaM2: g.areaM2 });
  }

  // ⑤ 建筑体块
  for (const b of c.buildings) {
    const k = kindOfGrammar(b.grammar);
    solids.push({
      id: b.id,
      name: b.name,
      kind: k,
      ring: b.surface.outer,
      yM: 0,
      heightM: b.heightM,
      floors: b.floors,
      parcelId: b.parcelId,
    });
  }

  // ⑥ 树：绿地与道路两侧各撒一遍
  const occupied = solids.map((s) => ({ outer: s.ring, holes: [] as Pt[][] }));
  for (const g of greens) {
    if (M2(surfaceArea(g)) < 90) continue;
    plantIn(ground, g, occupied, trees, rng);
  }
  for (const r of c.infra.roads) {
    // 步行主轴两侧同样种树：商业街的林荫步道就是靠它撑起来的
    plantAlong(r, c.input.boundary, occupied, trees, rng);
  }

  // ⑦ 统计与图例
  const byMat: Partial<Record<MatKey, number>> = {};
  for (const g of ground) byMat[g.mat] = (byMat[g.mat] ?? 0) + g.areaM2;
  const legend = (Object.keys(byMat) as MatKey[])
    .filter((m) => MAT_LABEL[m] && (byMat[m] ?? 0) > 40)
    .map((m) => ({ mat: m, label: MAT_LABEL[m]!, areaM2: +(byMat[m] ?? 0).toFixed(0) }));

  const buildingM2 = solids.reduce((s, b) => s + M2(surfaceArea({ outer: b.ring, holes: [] })), 0);
  const roadM2 = c.infra.roads.reduce((s, r) => s + M2(surfaceArea(r.surface)), 0);
  const greenM2 = (byMat.green ?? 0) + (byMat.lawn ?? 0) + (byMat.planting ?? 0);
  const pavedM2 = (byMat.plaza ?? 0) + (byMat.forecourt ?? 0) + (byMat.courtyard ?? 0) + (byMat.footpath ?? 0) + (byMat.sidewalk ?? 0);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of c.input.boundary.outer) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }

  return {
    id: c.id,
    typology: c.typology,
    boundary: c.input.boundary,
    ground,
    solids,
    trees,
    stalls,
    legend,
    stats: {
      blockM2: M2(surfaceArea(c.input.boundary)),
      baseM2: byMat.base ?? 0,
      buildingM2: +buildingM2.toFixed(0),
      greenM2: +greenM2.toFixed(0),
      pavedM2: +pavedM2.toFixed(0),
      roadM2: +roadM2.toFixed(0),
      trees: trees.length,
      maxHeightM: solids.reduce((m, s) => Math.max(m, s.heightM), 0),
      byMat,
    },
    bbox: { minX, minY, maxX, maxY },
  };
}

/**
 * 在绿地里撒树。
 *
 * 网格 + 抖动，而不是纯随机：纯随机会结块（有的地方一片林、有的地方光秃），
 * 游戏场景里那种"看起来是设计的绿化"恰恰需要均匀中有变化。
 * 树冠半径与树高都随位置微变，避免整片同样大小。
 */
function plantIn(
  ground: ScenePoly[],
  area: PlanSurface,
  occupied: PlanSurface[],
  out: SceneTree[],
  rng: () => number
): void {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of area.outer) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const stepM = 6;
  const step = stepM / 7;
  const limit = Math.min(360, Math.max(8, Math.floor(M2(surfaceArea(area)) / 55)));
  let n = 0;
  for (let x = minX + step / 2; x < maxX && n < limit; x += step) {
    for (let y = minY + step / 2; y < maxY && n < limit; y += step) {
      const jx = x + (rng() - 0.5) * step * 0.55;
      const jy = y + (rng() - 0.5) * step * 0.55;
      const p = new Pt(jx, jy);
      if (!insideSurface(p, area)) continue;
      if (distToSurfaceEdge(p, area) * 7 < 2.0) continue;
      if (occupied.some((o) => insideSurface(p, o))) continue;
      const rM = 2.4 + rng() * 1.7;
      out.push({ at: p, rM, hM: 6.5 + rng() * 4.5, tone: rng() });
      n++;
    }
  }
  void ground;
}

/** 沿内部道路两侧撒行道树（间距 11 m，离路缘 4.5 m） */
function plantAlong(
  road: { centerline: Pt[]; carriageM: number },
  boundary: PlanSurface,
  occupied: PlanSurface[],
  out: SceneTree[],
  rng: () => number
): void {
  const offU = (road.carriageM / 2 + 4.2) / 7;
  for (let i = 0; i + 1 < road.centerline.length; i++) {
    const a = road.centerline[i];
    const b = road.centerline[i + 1];
    const L = Pt.distance(a, b);
    if (L < 1e-6) continue;
    const ux = (b.x - a.x) / L;
    const uy = (b.y - a.y) / L;
    const nx = -uy;
    const ny = ux;
    const count = Math.max(1, Math.floor((L * 7) / 11));
    for (let k = 0; k < count; k++) {
      const t = (k + 0.5) / count;
      const bx = a.x + (b.x - a.x) * t;
      const by = a.y + (b.y - a.y) * t;
      for (const sgn of [1, -1]) {
        if (rng() < 0.25) continue; // 有些位置留给灯杆/路口
        const p = new Pt(bx + nx * offU * sgn, by + ny * offU * sgn);
        if (!insideSurface(p, boundary)) continue;
        if (occupied.some((o) => insideSurface(p, o))) continue;
        let bad = false;
        for (const t2 of out) {
          if (Pt.distance(t2.at, p) < 0.9) {
            bad = true;
            break;
          }
        }
        if (bad) continue;
        out.push({ at: p, rM: 2.1 + rng() * 0.8, hM: 5.8 + rng() * 2.6, tone: rng() });
      }
    }
  }
}
