// 从 Scene 构建 3D 网格数据。
// 坐标系：地图平面 (x, y) → 3D (x, 0, y)，高度沿 +Y。这样从上方俯视与平面视图完全一致。
//
// 这个文件是**唯一**的三角形化出口：三维预览、GLB 导出都走它，
// 差别只在 `merge`（导出时的合并方式）与图层过滤。

import { Pt } from '../core/geom';
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
import { flatPolygon, extrudeSolid, cylinder, mergePrimitives, wallSolid } from './mesh';
import { buildProp } from './props';

export type { Primitive } from './mesh';

/**
 * GLB 的合并方式（导出面板上可选）。
 *
 * 城市尺度下"每个要素一个节点"没有意义：一座城 1.2 万个面、2200 栋楼，
 * 节点开销比三角形本身还大，进 Blender 卡到没法选。但合并得太狠又没法编辑，
 * 所以给四种，按用途挑：
 *
 *   · `layer`    按图层合并（默认）——铺装按 group+材质并成一片，建筑保持独立，
 *                DCC 里能逐栋选、按材质替换；
 *   · `material` 按材质合并 —— 全城同一材质一个网格，面数最少、文件最小，
 *                适合进渲染器 / 引擎当静态场景；
 *   · `block`    按街区 + 内部类型合并 —— 一个街区一组（建筑 / 地面 / 道路 / 设施），
 *                适合逐街区替换、做 LOD 或分区编辑；
 *   · `none`     不合并，每个要素一个节点 —— 只在排查几何问题时用。
 */
export type GlbMerge = 'layer' | 'material' | 'block' | 'none';

export interface SceneToPrimsOpts {
  layers?: (id: LayerId) => boolean;
  hiliteLotRoad?: boolean;
  /** 城市半径：只用来拦"离谱坐标"的尖刺三角形 */
  cityRadius?: number;
  merge?: GlbMerge;
}

/** 三类归属：一个要素归到哪个街区、属于哪一大类 */
type Cat = 'building' | 'ground' | 'road' | 'street';

interface Entry {
  prim: Primitive;
  blockId: string;
  cat: Cat;
  /** 材质键（导出分组要按材质再分一层） */
  mat: string;
  /** 是否是「植物」（树 / 灌木），导出时归到"植物"而不是"街道设施" */
  plant: boolean;
}

/**
 * 导出分组的目录树。
 *
 * 用户给的层级是：`城市 / 街道-街道设施-街区 / 建筑-地面铺装-植物 / 单个建筑`
 * （`-` 同级、`/` 下一级）。翻译成实际目录：
 *
 * ```
 * 城市
 * ├─ 街道           车行道 / 路口 / 人行道 / 标线
 * ├─ 街道设施       路灯 / 护栏 / 行道树 / 车位线
 * └─ 街区
 *    ├─ B01
 *    │  ├─ 建筑      ← 每栋楼一个节点（"单个建筑"这一层）
 *    │  ├─ 地面铺装   硬质底 / 地块通路 / 草地 / 停车坪 / 水面
 *    │  └─ 植物
 *    └─ B02 …
 * ```
 *
 * 补充（原描述里没覆盖，我按 DCC 使用习惯补的）：
 *   · 城市底图放在「街区 / 城市底图」，不跟着某个街区走；
 *   · 「单个建筑」= 「建筑」目录下的叶子节点，名字保留 `B12-T1-P3_house_0`
 *     这种可追溯的编号，而不是另起一层同名目录（否则每栋楼一个目录，Blender 里没法选）。
 */
function pathOf(e: Entry): string[] {
  const g = e.prim.group;
  if (e.cat === 'building') return ['街区', e.blockId || '未分街区', '建筑'];
  if (g === 'ground') return ['街区', '城市底图'];
  if (g.startsWith('lot/')) {
    if (e.plant) return ['街区', e.blockId || '未分街区', '植物'];
    const sub =
      e.mat === 'lotBase'
        ? '硬质底'
        : e.mat === 'lotPath'
          ? '地块通路'
          : e.mat === 'asphaltLot'
            ? '停车坪'
            : e.mat === 'water'
              ? '水面'
              : ['lawn', 'grass', 'grassLight', 'grassDark', 'grassEdge'].includes(e.mat)
                ? '草地'
                : '其他';
    return ['街区', e.blockId || '未分街区', '地面铺装', sub];
  }
  if (g === 'parking/marking') return ['街道设施', '车位线'];
  if (g === 'road/surface') return ['街道', '车行道'];
  if (g === 'road/junction') return ['街道', '路口'];
  if (g === 'road/sidewalk') return ['街道', '人行道'];
  if (g === 'road/marking') return ['街道', '标线'];
  if (g === 'street') {
    if (e.plant) return ['街道设施', '行道树'];
    if (e.mat === 'metal') return ['街道设施', '护栏'];
    return ['街道设施', '路灯'];
  }
  return ['其他'];
}

/** 从要素名/分组里认街区号（F3 的命名是 `B12-T1-P3_house_0`） */
function blockOfName(name: string, group: string): string {
  const m = /^(B\d+)/.exec(name);
  if (m) return m[1];
  if (group === 'ground') return '';
  return '';
}

function catOf(group: string, isSolid: boolean): Cat {
  if (isSolid) return 'building';
  if (group.startsWith('road/')) return 'road';
  if (group.startsWith('lot/')) return 'ground';
  if (group === 'ground') return 'ground';
  return 'street';
}

/**
 * 场景 → 三角形。
 *
 * `merge` 决定合并粒度（见 GlbMerge）。图层显隐在**生成三角形之前**过滤掉，
 * 所以"看不见的东西不进 GLB"是结构性保证，不是导出时再删。
 */
export function sceneToPrimitives(scene: Scene, opts: SceneToPrimsOpts = {}): Primitive[] {
  const merge = opts.merge ?? 'layer';
  const entries: Entry[] = [];
  const vis = opts.layers ?? (() => true);
  /** 高亮时换色；判定与图层判定同源（同一份 layerOfSurface） */
  const colorOf = (layer: LayerId, mat: keyof typeof MAT) =>
    opts.hiliteLotRoad && isInternalRoadLayer(layer) ? MAT[hiliteMatOf(layer)] : MAT[mat];

  /**
   * 几何合法性兜底：任何一个环里出现 NaN / 无穷大 / 离谱坐标，
   * 三角化出来的就是一根本扎穿整个场景的"尖刺"三角形。
   */
  const cityR = (opts.cityRadius ?? 100) * 3;
  const saneRing = (ring: { x: number; y: number }[]): boolean => {
    for (const p of ring) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return false;
      if (Math.abs(p.x) > cityR || Math.abs(p.y) > cityR) return false;
    }
    return true;
  };

  // ---- 贴地要素：铺装、路面、标线、车位线
  for (const s of scene.surfaces) {
    const layer = layerOfSurface(s);
    if (!vis(layer)) continue;
    if (!saneRing(s.ring)) continue;
    const prim = flatPolygon(s.ring, s.y, s.name, s.group, colorOf(layer, s.mat), s.holes ?? []);
    if (prim) entries.push({ prim, blockId: blockOfName(s.name, s.group), cat: catOf(s.group, false), mat: s.mat, plant: false });
  }

  // ---- 建筑与围墙体块
  for (const s of scene.solids) {
    const layer = layerOfSolid(s);
    if (!vis(layer)) continue;
    if (!saneRing(s.ring)) continue;
    for (const prim of extrudeSolid(s.ring, s.y0, s.h, s.name, s.group, MAT[s.roofMat], MAT[s.wallMat])) {
      entries.push({ prim, blockId: blockOfName(s.name, s.group), cat: 'building', mat: 'roof', plant: false });
    }
  }

  // ---- 线性要素：内部道路、入口路、园路、围栏
  for (const p of scene.paths) {
    const layer = layerOfPath(p);
    if (!vis(layer)) continue;
    // 判定改成"有高度就立起来"（栏杆横杆只有 7 mm，按旧阈值会被铺成贴地白条）
    if (p.height && p.height > 0) {
      const w = wallSolid(p.pts, p.width, p.y, p.height, p.name, p.group, colorOf(layer, p.mat), false);
      if (w) entries.push({ prim: w, blockId: blockOfName(p.name, p.group), cat: 'street', mat: p.mat, plant: false });
    } else {
      const band = ringOfBand(p.pts, p.width);
      if (!band) continue;
      const prim = flatPolygon(band, p.y, p.name, p.group, colorOf(layer, p.mat));
      if (prim) entries.push({ prim, blockId: blockOfName(p.name, p.group), cat: catOf(p.group, false), mat: p.mat, plant: false });
    }
  }

  // ---- 道具（树 / 路灯）
  for (const p of scene.props) {
    const layer = layerOfProp(p);
    if (!vis(layer)) continue;
    for (const prim of buildProp(p, 0.022)) {
      entries.push({
        prim,
        blockId: blockOfName(p.name, p.group),
        cat: 'street',
        mat: p.kind.startsWith('tree') || p.kind.startsWith('conifer') || p.kind === 'hedge' ? 'trunk' : 'metal',
        plant: p.kind.startsWith('tree') || p.kind.startsWith('conifer') || p.kind === 'hedge',
      });
    }
  }

  if (merge === 'none') {
    for (const e of entries) e.prim.path = pathOf(e);
    return entries.map((e) => e.prim);
  }

  // ---- 分桶
  /**
   * `block` 模式以前是"按 街区 + 四大类"分桶，**把不属于任何街区的要素也塞进
   * `街区/city`**（街道、街道设施、城市底图全被吞掉）—— 用户在 Blender 里只看到
   * `城市/街区/B1/地面铺装|建筑|设施`，街道整棵子树都没了。
   *
   * 现在：
   *   · 有街区归属的要素 → `街区/Bxx/<类型>`（类型取目录最后一级：建筑 / 地面铺装 / 植物）；
   *   · 没有街区归属的（街道、街道设施、底图）→ 用它自己的目录（`街道/车行道` 等）。
   */
  /**
   * 街区要素在 `街区/Bxx/` 之下要保留的**剩余层级**：
   * 建筑 → `建筑`；植物 → `植物`；地面 → `地面铺装/硬质底`（两层都留，
   * 否则地面被拆成一堆同级目录，看不出它们同属"地面铺装"）。
   */
  const subPathOf = (e: Entry): string[] => {
    const p = pathOf(e);
    return p.length > 2 ? p.slice(2) : [p[p.length - 1] ?? '其他'];
  };
  const buckets = new Map<string, Entry[]>();
  for (const e of entries) {
    let key: string;
    if (merge === 'material') key = `mat|${e.prim.color.join(',')}`;
    else if (merge === 'block') {
      key = e.blockId
        ? `blk|${e.blockId}|${subPathOf(e).join('/')}`
        : `lyr|${pathOf(e).join('/')}|${e.prim.color.join(',')}`;
    } else {
      // layer：铺装按目录+颜色并，建筑不并（DCC 里要能逐栋选）
      key = e.cat === 'building' ? `one|${e.prim.name}` : `lyr|${pathOf(e).join('/')}|${e.prim.color.join(',')}`;
    }
    const list = buckets.get(key);
    if (list) list.push(e);
    else buckets.set(key, [e]);
  }

  const out: Primitive[] = [];
  for (const [key, list] of buckets) {
    const group = list[0].prim.group;
    if (merge === 'material') {
      const c = list[0].prim.color;
      const name = `mat_${c.map((v) => Math.round(v * 255)).join('_')}`;
      const merged = mergePrimitives(list.map((e) => e.prim), name, 'material');
      if (merged) {
        merged.path = ['按材质', name];
        out.push(merged);
      }
      continue;
    }
    if (merge === 'block') {
      const blockId = list[0].blockId;
      if (blockId) {
        const rest = subPathOf(list[0]);
        const path = ['街区', blockId, ...rest];
        const name = `${blockId}_${rest.join('_')}`;
        const merged = mergePrimitives(list.map((e) => e.prim), name, `block/${blockId}/${rest.join('/')}`);
        if (merged) {
          merged.path = path;
          out.push(merged);
        }
      } else {
        // 非街区要素：跟 layer 模式一样按自己的目录并
        const path = pathOf(list[0]);
        if (list.length === 1) {
          list[0].prim.path = path;
          out.push(list[0].prim);
        } else {
          const merged = mergePrimitives(list.map((e) => e.prim), `${path.join('_')}_${list.length}`, group);
          if (merged) {
            merged.path = path;
            out.push(merged);
          }
        }
      }
      continue;
    }
    // layer
    if (list.length === 1) {
      list[0].prim.path = pathOf(list[0]);
      out.push(list[0].prim);
      continue;
    }
    const path = pathOf(list[0]);
    const merged = mergePrimitives(list.map((e) => e.prim), `${path.join('_')}_${list.length}`, group);
    if (merged) {
      merged.path = path;
      out.push(merged);
    }
    void key;
  }
  return out;
}

/** 折线 → 等宽带环（贴地线性要素的三角形化输入） */
function ringOfBand(pts: Pt[], width: number): Pt[] {
  if (pts.length < 2) return [];
  const h = width / 2;
  const left: Pt[] = [];
  const right: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L = Math.hypot(dx, dy) || 1;
    const nx = -dy / L;
    const ny = dx / L;
    left.push(new Pt(pts[i].x + nx * h, pts[i].y + ny * h));
    right.push(new Pt(pts[i].x - nx * h, pts[i].y - ny * h));
  }
  return [...left, ...right.reverse()];
}

/** 兼容旧调用：只要平面几何时给一个空实现 */
export function flatOnly(ring: Pt[], y: number, name: string, group: string, color: [number, number, number]) {
  return flatPolygon(ring, y, name, group, color);
}

void cylinder;
