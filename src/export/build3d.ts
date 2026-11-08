// 从 Scene 构建 3D 网格数据。
// 坐标系：地图平面 (x, y) → 3D (x, 0, y)，高度沿 +Y。这样从上方俯视与 2D 编辑器完全一致。

import { Pt } from '../core/geom';
import type { Model } from '../town/model';
import { buildScene, type SceneOptions } from '../scene/build';
import type { Scene } from '../scene/types';
import {
  hiliteMatOf,
  isInternalRoadLayer,
  layerOfPath,
  layerOfProp,
  layerOfSolid,
  layerOfSurface,
  type LayerId,
} from '../scene/layers';
import { MAT } from '../scene/palette';
import type { Primitive } from './mesh';
import { flatPolygon, extrudeSolid, cylinder, wallSolid, mergePrimitives } from './mesh';
import { buildProp } from './props';
import { bandBetween } from '../road/system';

export type { Primitive } from './mesh';

export interface Build3DOptions extends SceneOptions {
  /**
   * 图层显隐过滤。给了它，看不见的图层**不进三角网格** ——
   * 三维预览和 GLB 导出因此在语义上完全一致：导出所见即所得。
   */
  layers?: (id: LayerId) => boolean;
  /**
   * 高亮地块内部道路（与 2D 同一套判定，走 `scene/layers` 的
   * `isInternalRoadLayer`）。纯表现层：只换颜色，不动几何、不动图层显隐。
   */
  hiliteLotRoad?: boolean;
}

/** 场景 → 三角形。这是 2D 预览与 GLB 导出的唯一出口 */
export function buildTownMeshes(model: Model, opts: Build3DOptions = {}): Primitive[] {
  const scene = buildScene(model, opts);
  return sceneToPrimitives(scene, {
    layers: opts.layers,
    hiliteLotRoad: opts.hiliteLotRoad,
    cityRadius: model.cityRadius || 100,
  });
}

export interface SceneToPrimsOpts {
  layers?: (id: LayerId) => boolean;
  hiliteLotRoad?: boolean;
  /** 城市半径：只用来拦"离谱坐标"的尖刺三角形 */
  cityRadius?: number;
}

/**
 * 已经是 Scene 时的出口（F3 城市合成器走这条）。
 *
 * 抽出来是为了让"新链路"和"旧链路"在**导出**这一步完全同源：
 * 两者都只产 Scene，之后走同一段三角形化代码，不可能出现
 * "预览是一种形状、导出的 GLB 是另一种"。
 */
export function sceneToPrimitives(scene: Scene, opts: SceneToPrimsOpts = {}): Primitive[] {
  const out: Primitive[] = [];
  /** 高亮时换色；判定与 2D 完全相同（同一份 layerOfSurface） */
  const colorOf = (layer: LayerId, mat: keyof typeof MAT) =>
    opts.hiliteLotRoad && isInternalRoadLayer(layer) ? MAT[hiliteMatOf(layer)] : MAT[mat];

  // 铺装 / 标线 / 车位线 / 道具按 (分组, 颜色) 合并成大网格。
  // 不合并的话一座 124 街区的城会导出上万个节点，GLB 体积几乎全花在节点开销上
  // （三角形只有四万，文件却接近 10 MB）。建筑保持独立，方便在 Blender 里逐栋选。
  const flats = new Map<string, Primitive[]>();
  const addFlat = (prim: Primitive | null) => {
    if (!prim) return;
    const key = `${prim.group}|${prim.color.join(',')}`;
    const list = flats.get(key);
    if (list) list.push(prim);
    else flats.set(key, [prim]);
  };

  const vis = opts.layers ?? (() => true);

  /**
   * 几何合法性兜底：任何一个环里出现 NaN / 无穷大 / 离谱坐标，
   * 三角化出来的就是一根本扎穿整个场景的"尖刺"三角形。
   * 这些环来自布尔运算的退化分支，源头难堵全，所以在导出前统一拦掉。
   */
  const cityR = (opts.cityRadius ?? 100) * 3;
  const saneRing = (ring: { x: number; y: number }[]): boolean => {
    for (const p of ring) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return false;
      if (Math.abs(p.x) > cityR || Math.abs(p.y) > cityR) return false;
    }
    return true;
  };

  // 贴地要素：铺装、路面、标线、车位线
  for (const s of scene.surfaces) {
    if (!vis(layerOfSurface(s))) continue;
    if (!saneRing(s.ring)) continue;
    // 三角化前的环塌缩（去近重合点 / 共线点）在 flatPolygon 内部统一做
    addFlat(flatPolygon(s.ring, s.y, s.name, s.group, colorOf(layerOfSurface(s), s.mat), s.holes ?? []));
  }

  // 建筑与围墙体块
  for (const s of scene.solids) {
    if (!vis(layerOfSolid(s))) continue;
    if (!saneRing(s.ring)) continue;
    out.push(...extrudeSolid(s.ring, s.y0, s.h, s.name, s.group, MAT[s.roofMat], MAT[s.wallMat]));
  }

  // 线性要素：内部道路、入口路、园路、围栏
  for (const p of scene.paths) {
    if (!vis(layerOfPath(p))) continue;
    // 判定改成"有高度就立起来"。原来是 `height > 0.05`，本意是区分
    // "薄贴地线"和"立起来的围栏"；但栏杆被拆成两根 5 cm 截面的横杆之后，
    // 高度只有 0.007 单位，按老条件会被铺成贴地白条 —— 整根栏杆消失。
    if (p.height && p.height > 0) {
      const w = wallSolid(p.pts, p.width, p.y, p.height, p.name, p.group, colorOf(layerOfPath(p), p.mat), false);
      if (w) out.push(w);
    } else {
      const band = bandBetween(p.pts, p.width / 2, -p.width / 2);
      if (!band) continue;
      addFlat(flatPolygon(band, p.y, p.name, p.group, colorOf(layerOfPath(p), p.mat)));
    }
  }

  // 道具
  for (const p of scene.props) {
    if (!vis(layerOfProp(p))) continue;
    for (const prim of buildProp(p, 0.022)) addFlat(prim);
  }

  for (const [key, list] of flats) {
    const group = list[0].group;
    const merged = mergePrimitives(list, `${group}_${list.length}`, group);
    if (merged) out.push(merged);
    void key;
  }

  return out;
}

/** 兼容旧调用：只要平面几何时给一个空实现 */
export function flatOnly(ring: Pt[], y: number, name: string, group: string, color: [number, number, number]) {
  return flatPolygon(ring, y, name, group, color);
}
