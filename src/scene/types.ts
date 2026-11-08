// 场景要素：整个生成器只产出这四种要素，2D 画布、three.js 预览、GLB 导出都是它的消费者。
// 这样"编辑器里看到的"与"导出的"不可能不一致 —— 它们读的是同一份数组。

import { Pt } from '../core/geom';
import type { MatKey } from './palette';

/** 贴地薄面：路面、铺装、绿地、标线、车位线 */
export interface SurfaceFeature {
  name: string;
  /** 分组路径，导出后是 glTF 节点名，供 DCC 里整体选中 */
  group: string;
  ring: Pt[];
  /**
   * 洞（中庭 / 环路 / 停车岛 / 中央绿地）。
   *
   * PRD §3 P0 的落点：面的唯一结构是「外环 + 洞」。留成可选是为了让
   * 现有两百多处 `addSurface(ring)` 不用一次性改完 —— 不传就等于没有洞。
   */
  holes?: Pt[][];
  mat: MatKey;
  /** 高度偏移，用来解决共面 z-fighting；语义上代表"这一层比地面高多少" */
  y: number;
  /**
   * 这一层的**语义角色**（阶段 D5）。
   *
   * 之前审计靠名字前缀（`_pk_` / `_parkreq_`）判断"这是不是表达层"——
   * 那是拿命名当契约，改个名字就崩。现在由产出方直接声明：
   *
   *   · `ground`   规划出来的功能面，**同一点只能有一个**（独占）
   *   · `overlay`  表达层：车位线、车位/树岛、停车请求面、退线带、道路细节、
   *                地块内部路径。它们本来就叠在 `ground` 之上，允许重叠。
   *   · `road`     城市道路（自有层级，不参与地块独占判定）
   *
   * 不填 = `ground`（向后兼容，老代码不用改）。
   */
  role?: 'ground' | 'overlay' | 'road';
}

export type SolidKind =
  | 'tower'
  | 'slab'
  | 'podium'
  | 'house'
  | 'warehouse'
  | 'canopy'
  /**
   * 配套商业 / 沿街店铺：1~2 层的矮体量。
   *
   * 为什么要单独一类：地块被张量切出细长条或楔形时，按"塔楼"去盖就是一栋
   * 六层高的纸片楼。这种位置在真实城市里本来就是沿街小商业 —— 矮、贴边、
   * 进深小。给它一个独立的 kind，才能在图层里单独开关，也才能单独校核
   * 最小进深（见 modern.ts 的 shapeFit）。
   */
  | 'retail';

/** 体块：建筑、雨棚、围墙、树冠以外的实体 */
export interface SolidFeature {
  name: string;
  group: string;
  ring: Pt[];
  y0: number;
  h: number;
  wallMat: MatKey;
  roofMat: MatKey;
  kind: SolidKind;
}

export type PropKind =
  | 'tree'
  | 'treeSmall'
  | 'conifer'
  | 'lamp'
  | 'lampDouble'
  | 'bench'
  | 'bin'
  | 'sign'
  | 'planter'
  | 'shelter'
  | 'fountain'
  | 'bollard'
  | 'hedge'
  | 'post'
  | 'car'
  | 'flagpole';

/**
 * 已停用的道具类型。
 *
 * 用户的判断：这些小件（长椅 / 垃圾桶 / 指示牌 / 花坛 / 公交亭 / 喷泉 /
 * 护柱 / 车辆 / 旗杆）在**城市尺度**下不但看不清，还抢行道树和路灯的视线 ——
 * 一座上万栋楼的城市里，一把 1.2 m 的长椅连一个像素都占不满，纯粹是面数负担。
 *
 * 保留类型定义和低模，只在生成出口统一拦掉：将来做街区级细看时，
 * 把某个 kind 从这里删掉就回来了，不用重写建模。
 */
export const DROPPED_PROPS: ReadonlySet<PropKind> = new Set<PropKind>([
  'bench',
  'bin',
  'sign',
  'planter',
  'shelter',
  'fountain',
  'bollard',
  'car',
  'flagpole',
]);

/** 点状道具：树、路灯、绿篱…… 几何在 props.ts 里按 kind 生成，坐标只在这里存一份 */
export interface PropFeature {
  name: string;
  group: string;
  kind: PropKind;
  at: Pt;
  /** 朝向（弧度），0 = +X */
  rot: number;
  /** 尺寸倍率 */
  scale: number;
  /**
   * **仅高度**的额外倍率（默认 1）。
   *
   * 绿篱这类构件平面尺寸和高度必须分开调：想让它长到和栏杆齐平（1.1 m）
   * 又不能变宽，等比缩放在几何上做不到 —— 一放就宽 2.4 倍。
   */
  hz?: number;
  /** 是否随机翻转，让树冠不整齐 */
  seed: number;
}

/** 线性要素：内部道路、建筑入口路、园路、围栏 */
export interface PathFeature {
  name: string;
  group: string;
  pts: Pt[];
  width: number;
  mat: MatKey;
  y: number;
  /** 围栏是竖起来的，需要高度；道路为 0 */
  height?: number;
  /**
   * 这条线在 2D 俯视图里不画。
   *
   * 栏杆被拆成两根横杆（上下各一根）之后，俯视时两根完全重合 ——
   * 画两遍只是让线更深、更粗，白吃一次描边开销。3D / GLB 照样两根都出。
   */
  hidden2d?: boolean;
}

export type LandUse =
  | 'cbd'
  | 'commercial'
  | 'residential'
  | 'industrial'
  | 'civic'
  | 'park'
  | 'parking'
  | 'green'
  /**
   * 禁建 / 保留地：用户画的固定形状区域。
   * 不做分区规划（不参与 CBD/商业/住宅的分档），也不产出建筑，
   * 但它仍然是一个"封闭地块"——照样有地坪、有边界、四周的路照常连。
   */
  | 'reserved';

/** 单个地块的规划结果，UI 要按用途统计与着色 */
export interface LotInfo {
  index: number;
  use: LandUse;
  area: number;
  far: number;
  buildings: number;
  parkingBays: number;
  trees: number;
}

export interface SceneStats {
  surfaces: number;
  solids: number;
  props: number;
  paths: number;
  byUse: Record<string, number>;
  propsByKind: Record<string, number>;
}

export interface Scene {
  surfaces: SurfaceFeature[];
  solids: SolidFeature[];
  props: PropFeature[];
  paths: PathFeature[];
  lots: LotInfo[];
  stats: SceneStats;

  /**
   * Planner 模式的逐地块报告（R8 Debug HUD 用）。
   * legacy 模式下为空 —— 前端据此判断"现在到底跑的是哪条链"。
   */
  planner?: import('./planner-bridge').PlannerBundle;
}

export function emptyScene(): Scene {
  return {
    surfaces: [],
    solids: [],
    props: [],
    paths: [],
    lots: [],
    stats: { surfaces: 0, solids: 0, props: 0, paths: 0, byUse: {}, propsByKind: {} },
  };
}

// ---------------------------------------------------------------- 几何小工具

export function ringArea(ring: Pt[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

export function ringCenter(ring: Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p.x;
    y += p.y;
  }
  return new Pt(x / ring.length, y / ring.length);
}

/** 把 p 绕 c 旋转 a 弧度 */
export function rotateAbout(p: Pt, c: Pt, a: number): Pt {
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  const cs = Math.cos(a);
  const sn = Math.sin(a);
  return new Pt(c.x + dx * cs - dy * sn, c.y + dx * sn + dy * cs);
}

/** 逆时针（有向面积为正） */
export function toCCW(ring: Pt[]): Pt[] {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s < 0 ? ring.slice().reverse() : ring;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
