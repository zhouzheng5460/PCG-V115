// 图层（Layer）定义 —— 显隐控制的唯一真相来源。
//
// 为什么要有这一层
// ----------------
// 原先显隐是靠两个布尔开关（markings / furniture）在**生成阶段**拦的：
//   buildScene(model, { furniture:false })  → 不调 streetFurniture()
// 这有两个硬伤：
//   ① 地块里的树、绿篱、长椅是 ModernWard 排出来的，走的是 lot.props，
//      压根不经过 streetFurniture —— 于是「关掉行道树」之后地块里的树还在，
//      用户看到的就是"有一部分树不受控制"。
//   ② 只有开 / 关两档，路灯和树挤在同一个 furniture 里，没法分开看。
//
// 现在改成：**场景永远生成全量**，显隐在消费端按图层 id 过滤。
// 于是任何要素都必然属于某一个图层，不存在"漏网的树"；漏了就会被
// test/layers.test.ts 的"无孤儿要素"断言当场抓住。
//
// 图层 id 的命名规则：`类别:子类`。前四段（solid / road / pave / prop / path）
// 对应 Scene 里的四类要素，`ov:` 是 2D 覆盖层（不产出几何）。

import type { PropFeature, PathFeature, SolidFeature, SurfaceFeature } from './types';

export type LayerId = string;

/**
 * 是不是**地块内部**铺出来的路面（Planner/R1 的 `realizeRoads` 产物）。
 *
 * 命名形如 `<candidateId>_road_<路径号>_surf_<段号>`，另有 `_walk_` / `_curb_` / `_pad_`。
 *
 * 为什么这里敢按名字判：这几类面是 `realize/road.ts` **自己**命名的，而它们
 * 带上来的 `group` 是 `lot/<typology>`、`mat` 是 asphalt/concrete —— 与
 * "停车场地坪""硬质铺装"完全同组同材质，靠 group/mat 根本分不开。审计那边
 * 不用名字判（那是为了抗改名），但图层归属必须有办法把它们摘出来，否则
 * 用户把「道路」全隐了，地块内部的沥青还在，看起来就是"有一半路关不掉"。
 */
function isLotRoadName(name: string): boolean {
  return /_road_\d+_(surf|pad|walk|curb)/.test(name);
}

/** 一类要素 → 它的图层 id */
export function layerOfSurface(s: SurfaceFeature): LayerId {
  const g = s.group;
  if (g === 'ground') return 'surface:ground';
  if (g === 'road/surface') return 'road:asphalt';
  if (g === 'road/sidewalk') return 'road:walk';
  if (g === 'road/verge') return 'road:verge';
  if (g === 'road/junction') return 'road:junction';
  if (g === 'road/marking') return 'road:mark';
  if (g === 'parking/marking') return 'road:parkmark';
  // F3 张量场一级分区之间的内部步行街：不进市政道路层，归「内部人行道 / 路缘」
  if (g === 'lot/internal') return 'lotRoad:walk';
  // 地块内部路：必须在下面按材质分类**之前**拦掉
  if (g.startsWith('lot/') && isLotRoadName(s.name)) {
    return /_road_\d+_(walk|curb)/.test(s.name) ? 'lotRoad:walk' : 'lotRoad:surf';
  }
  // 地块内容：按材质分。铺装 / 草地 / 水面是"这一片地是什么"，
  // 用户调图时最常单独关掉的就是草地和铺装。
  switch (s.mat) {
    case 'grass':
    case 'grassLight':
    case 'grassDark':
      return 'pave:grass';
    case 'water':
      return 'pave:water';
    case 'soil':
      return 'pave:soil';
    case 'asphaltLot':
    case 'asphalt':
      return 'pave:asphalt';
    default:
      return 'pave:hard';
  }
}

export function layerOfSolid(s: SolidFeature): LayerId {
  return `solid:${s.kind}`;
}

export function layerOfProp(p: PropFeature): LayerId {
  return `prop:${p.kind}`;
}

export function layerOfPath(p: PathFeature): LayerId {
  // 围栏是竖起来的（有 height），地块内的路 / 园路是贴地的。
  // 阈值必须只判"有没有高度"：栏杆横杆截面只有 5 cm，写成 > 0.05 会把
  // 所有横杆判成贴地小路（然后它们的图层开关就失效了）。
  if (p.height && p.height > 0) return 'path:fence';
  /**
   * 车位划线也是"贴地的线"，但它**不是道路**。
   *
   * `realize/parking.ts` 把每个车位画成一条 `markWhite` 的短线（`*_stall_i_k`），
   * 只按"有没有高度"判定的话，这些线会全部落进「内部道路中线」——
   * 实测 1339 条里 1333 条是车位线，真正的内部路中线只有 3 条。
   * 结果就是"高亮内部道路"把整片停车场刷成橙色，而真正的路几乎看不见。
   *
   * 判材质不判名字：标线材质只有 markWhite / markYellow 两种，
   * 道路中线用的是 asphalt / asphaltLot，天然分得开。
   */
  if (p.mat === 'markWhite' || p.mat === 'markYellow') return 'road:parkmark';
  return 'path:lane';
}

/** 地面标高的"内部道路"三件套：车行面 / 人行-路缘 / 中线 */
export function isInternalRoadLayer(id: LayerId): boolean {
  return id === 'lotRoad:surf' || id === 'lotRoad:walk' || id === 'path:lane';
}

/** 高亮时该用哪个材质色（车行面与步行面分开，否则走向和路缘糊成一片） */
export function hiliteMatOf(id: LayerId): 'lotRoadHi' | 'lotRoadHiWalk' {
  return id === 'lotRoad:walk' ? 'lotRoadHiWalk' : 'lotRoadHi';
}

// ---------------------------------------------------------------- 图层清单

export interface LayerDef {
  id: LayerId;
  label: string;
  /** 侧栏色块；不写就按 fg 走 */
  color?: string;
  /** 默认是否显示 */
  on?: boolean;
}

export interface LayerGroupDef {
  id: string;
  label: string;
  /** 左栏里默认展开（分组多，全展开会把 HUD 顶到屏幕外） */
  open?: boolean;
  items: LayerDef[];
}

/** 场景要素的图层分组（左栏「显示控制」列表由它渲染） */
export const LAYER_GROUPS: LayerGroupDef[] = [
  {
    id: 'building',
    label: '建筑',
    open: true,
    items: [
      { id: 'solid:tower', label: '塔楼', color: '#8d94a3' },
      { id: 'solid:slab', label: '板楼', color: '#7d8492' },
      { id: 'solid:podium', label: '裙房', color: '#6d7480' },
      { id: 'solid:retail', label: '配套商业', color: '#8c7f6a' },
      { id: 'solid:house', label: '独立住宅', color: '#9a8f7d' },
      { id: 'solid:warehouse', label: '厂房 / 仓库', color: '#6b6a66' },
      { id: 'solid:canopy', label: '雨棚', color: '#5f6672' },
    ],
  },
  {
    id: 'road',
    label: '道路',
    open: true,
    items: [
      { id: 'road:asphalt', label: '车行道', color: '#3e424a' },
      { id: 'road:walk', label: '人行道', color: '#a9a49b' },
      { id: 'road:verge', label: '路侧绿带', color: '#5c8045' },
      { id: 'road:junction', label: '路口铺装', color: '#4a4e57' },
      { id: 'road:mark', label: '道路标线', color: '#eae6da' },
      { id: 'road:parkmark', label: '车位线', color: '#cdc7b8' },
    ],
  },
  {
    id: 'lotroad',
    label: '内部道路',
    open: true,
    items: [
      // 这三项原来散落着：「地块内道路」藏在"线性要素"里，Planner/R1 铺的路面
      // 被按材质并进了"铺装与地面"，于是"关掉道路"之后街区里还有沥青。
      // 现在收成一组，就是为了回答"哪一段是内部道路"。
      { id: 'lotRoad:surf', label: '内部车行路面', color: '#2f3540' },
      { id: 'lotRoad:walk', label: '内部人行道 / 路缘', color: '#9a958c' },
      { id: 'path:lane', label: '内部道路中线', color: '#c8a24a' },
    ],
  },
  {
    id: 'pave',
    label: '铺装与地面',
    items: [
      { id: 'surface:ground', label: '城市底图', color: '#68645f' },
      { id: 'pave:hard', label: '硬质铺装', color: '#b4ae9e' },
      { id: 'pave:asphalt', label: '停车场地坪', color: '#44474e' },
      { id: 'pave:grass', label: '草地', color: '#5c8045' },
      { id: 'pave:water', label: '水面', color: '#49718a' },
      { id: 'pave:soil', label: '裸土', color: '#695a44' },
    ],
  },
  {
    id: 'plant',
    label: '植物',
    items: [
      { id: 'prop:tree', label: '大乔木', color: '#4a6b3c' },
      { id: 'prop:treeSmall', label: '小乔木', color: '#3d5c33' },
      { id: 'prop:conifer', label: '针叶树', color: '#2f4a2a' },
      { id: 'prop:hedge', label: '绿篱', color: '#41603a' },
    ],
  },
  {
    id: 'street',
    label: '街道设施',
    items: [
      { id: 'prop:lamp', label: '路灯', color: '#8f939b' },
      { id: 'prop:lampDouble', label: '双头路灯', color: '#a2a6ad' },
      // 长椅 / 垃圾桶 / 指示牌 / 花坛 / 公交亭 / 喷泉 / 护柱 / 车辆 / 旗杆
      // 已按用户要求整体移除（见 types.ts 的 DROPPED_PROPS）。城市尺度下它们
      // 只占面数、看不见，还抢行道树和路灯的视线。
    ],
  },
  {
    id: 'path',
    label: '围栏与其他线',
    items: [
      { id: 'path:fence', label: '围栏 / 栏杆', color: '#79808c' },
      { id: 'prop:post', label: '栏杆立柱', color: '#6f747f' },
    ],
  },
];

/** 2D 覆盖层：不产出几何，只在画布上叠信息 */
export const OVERLAY_GROUPS: LayerGroupDef[] = [
  {
    id: 'ov-struct',
    label: '结构覆盖',
    open: true,
    items: [
      // 地块轮廓默认开着：它是"切得对不对"最直接的证据，线细、不挡图
      { id: 'ov:blocks', label: '地块切分轮廓', color: '#25211d', on: true },
      { id: 'ov:redline', label: '用地红线', color: '#c4553f', on: false },
      { id: 'ov:centerline', label: '道路中线', color: '#2c6fbf', on: false },
      { id: 'ov:junctions', label: '路口点', color: '#e0a02c', on: false },
      { id: 'ov:vertices', label: '拓扑点（可拖）', color: '#8a5fb0', on: false },
    ],
  },
  {
    id: 'ov-cir',
    label: 'R1 交通诊断',
    open: false,
    items: [
      // 五档分开，是因为"只看新增"会得出"内部路是几个断头"的错误结论 ——
      // 网络主体常常是既有铺装，新铺的只是补丁。
      { id: 'ov:cir-existing', label: '既有可通行道路', color: '#4682b4', on: false },
      { id: 'ov:cir-new', label: 'A* 新增连接', color: '#e0762e', on: false },
      { id: 'ov:cir-merged', label: '合并后的完整网络', color: '#c85a1e', on: false },
      { id: 'ov:cir-portals', label: '入口与街区出口', color: '#2f8f9d', on: false },
      { id: 'ov:cir-unreachable', label: '接不上的需求点', color: '#d8341f', on: false },
    ],
  },
  {
    id: 'ov-info',
    label: '信息覆盖',
    open: true,
    items: [
      { id: 'ov:use', label: '用地类型着色', color: '#4a9d7c', on: false },
      { id: 'ov:zones', label: '禁建区', color: '#c4553f', on: true },
      { id: 'ov:guides', label: '方向控制线', color: '#3f6bb0', on: true },
    ],
  },
];

/** 全部图层 id */
export function allLayerIds(): LayerId[] {
  const out: LayerId[] = [];
  for (const g of [...LAYER_GROUPS, ...OVERLAY_GROUPS]) {
    for (const it of g.items) out.push(it.id);
  }
  return out;
}

/** 默认显隐：LayerDef.on 缺省为 true */
export function defaultVisibility(): Record<LayerId, boolean> {
  const v: Record<LayerId, boolean> = {};
  for (const g of [...LAYER_GROUPS, ...OVERLAY_GROUPS]) {
    for (const it of g.items) v[it.id] = it.on !== false;
  }
  return v;
}

/** 图层 id → 是否可见（未登记的 id 一律当作可见，宁可多显示不可凭空丢东西） */
export function makeFilter(vis: Record<LayerId, boolean>): (id: LayerId) => boolean {
  return (id) => vis[id] !== false;
}

/**
 * 显隐签名：变了才需要重建场景 / 重绘三维。
 *
 * 只把**场景要素**的图层算进来 —— 覆盖层（ov:）只是画布上的线，不影响几何，
 * 挪一下覆盖层不至于把三维重建一遍。
 */
export function sceneLayerSig(vis: Record<LayerId, boolean>): string {
  let s = '';
  for (const g of LAYER_GROUPS) for (const it of g.items) s += vis[it.id] === false ? '0' : '1';
  return s;
}
