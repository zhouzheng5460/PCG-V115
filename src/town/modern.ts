// 现代城市地块内容生成。
//
// 保留原项目的空间生成（Voronoi 分地块 → 拓扑寻路 → 地块内缩），
// 只替换"内缩之后往里放什么"这一层：中世纪 ward 的递归切分换成用途驱动的建筑群。
//
// 每个地块的处理顺序固定：
//   1. 内缩得到可建区 block（与道路横断面同源，保证不压路）
//   2. 铺基底（按用途决定硬化率）
//   3. 摆建筑群（矩形原型 → 与 block 求交 → 面积不够就丢）
//   4. 内部道路 / 建筑入口路
//   5. 停车场 + 车位线
//   6. 绿地、树、围栏
//
// 建筑一律先在世界坐标摆矩形，再与 block 求交 —— 这样建筑永远在红线内，
// 而且形状是规整的直角矩形（现代建筑该有的样子），不会跟着地块边界长出歪斜的角。

import { Pt } from '../core/geom';
import { Polygon } from '../core/polygon';
import { Rng } from '../core/rng';
import type { Model } from './model';
import type { Patch } from './patch';
import { Ward } from './wards';
import { USE_LABEL } from './landuse';
import { intersect, subtract, unionParts, pointInPolygon, area, insetRing, isSimpleRing, simplifyRing } from './zones';
import type { LandUse, PathFeature, PropFeature, PropKind, SolidFeature, SolidKind, SurfaceFeature } from '../scene/types';
import { clamp, ringCenter, toCCW, DROPPED_PROPS } from '../scene/types';
import type { MatKey } from '../scene/palette';
import { u } from '../road/spec';
import { RAIL_PARK, addHedgeRun, addRail } from './rails';
import type { RailSpec } from './rails';
import { subdivideGreen } from './greenspace';
import { surface as planSurface } from './planning/core/surface';
import type { ParcelPattern } from './params';
import { fbm } from '../core/noise';
import { type Family, type FieldSource, TensorField } from './field/tensor';
import { buildLattice, connectEntries, pickEntryPoints } from './field/lattice';
import {
  solveParking,
  parkingDemand,
  CAR_STALL,
  TRUCK_STALL,
  type ParkLayout,
  type ParkLevel,
  type ParkingDemand,
  type StallDims,
} from './parking';

// ---------------------------------------------------------------- 局部坐标

interface Frame {
  o: Pt;
  u: Pt;
  v: Pt;
}

/** 以地块最长边为建筑主朝向 —— 现代街区里楼通常平行于街道 */
function frameOf(block: Polygon): Frame {
  let best = 0;
  let dir = new Pt(1, 0);
  for (let i = 0; i < block.length; i++) {
    const a = block[i];
    const b = block[(i + 1) % block.length];
    const l = Pt.distance(a, b);
    if (l > best) {
      best = l;
      dir = b.subtract(a).norm(1);
    }
  }
  return { o: block.centroid, u: dir, v: new Pt(-dir.y, dir.x) };
}

function loc(f: Frame, p: Pt): Pt {
  const dx = p.x - f.o.x;
  const dy = p.y - f.o.y;
  return new Pt(dx * f.u.x + dy * f.u.y, dx * f.v.x + dy * f.v.y);
}

function world(f: Frame, lu: number, lv: number): Pt {
  return new Pt(f.o.x + f.u.x * lu + f.v.x * lv, f.o.y + f.u.y * lu + f.v.y * lv);
}

interface BBox {
  u0: number;
  u1: number;
  v0: number;
  v1: number;
  w: number;
  h: number;
}

function bboxOf(ring: Pt[], f: Frame): BBox {
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (const p of ring) {
    const q = loc(f, p);
    if (q.x < u0) u0 = q.x;
    if (q.x > u1) u1 = q.x;
    if (q.y < v0) v0 = q.y;
    if (q.y > v1) v1 = q.y;
  }
  return { u0, u1, v0, v1, w: u1 - u0, h: v1 - v0 };
}

/** 局部坐标下的轴对齐矩形 → 世界坐标 4 点 */
function rect(f: Frame, u0: number, u1: number, v0: number, v1: number): Pt[] {
  return [world(f, u0, v0), world(f, u1, v0), world(f, u1, v1), world(f, u0, v1)];
}

// ---------------------------------------------------------------- 地块上下文

export interface LotResult {
  patch: Patch;
  use: LandUse;
  radius: number;
  block: Polygon | null;
  surfaces: SurfaceFeature[];
  solids: SolidFeature[];
  props: PropFeature[];
  paths: PathFeature[];
  bays: number;
  trees: number;
  buildings: number;
}

const TREE_LIMIT = 26;

interface Ctx {
  model: Model;
  patch: Patch;
  use: LandUse;
  block: Polygon;
  f: Frame;
  bb: BBox;
  res: LotResult;
  /** 建筑轮廓，用来避免在楼里种树 */
  footprints: Pt[][];
  /** 停车配比档位（low / normal / high），用户只控这三档 */
  parkingLevel: ParkLevel;
  /** 本块地已经铺掉的停车面积（单位²），用来做"多次调用合计不过硬上限"的闸门 */
  parkUsed: number;
  /** 基底材质（各用途规划第一句铺的那层），孤儿地带兜底时沿用 */
  baseMat: MatKey;
  /**
   * 本街区已经铺下的草地区块（`pavingPartition` 的产物）。
   *
   * 存在的唯一理由是**让后铺的中间层躲开它**：散水 / 路缘带 / 巷道这些层在
   * `planParcel` 之后才画，高度也更低，但面积上会把草坪啃掉一大半
   * （实测商业地块切出 24% 的草地，散水一铺只剩 8%）。
   * 有了这张清单，`groundLayers` 就能把散水从草地上减掉，而不是靠"谁高谁赢"。
   */
  green: Pt[][];
  /**
   * 街区内部路的路面（禁建多边形）。
   *
   * 不开「街区切成小地块」时，街区里会铺一条内部路，但建筑仍走整块街区的
   * 用途规划（塔楼 + 裙房 + 副楼那一套），它不知道路在哪。与其去改十几处摆楼
   * 逻辑，不如在**建筑出口**（`addSolid`）统一拦一道：压到路面的体块直接不放。
   */
  noBuild?: Pt[][];
  /**
   * 可建范围（= 地面规划里"建筑格"的**退线环**）。
   *
   * 地面现在先被切成互斥的格、每格定一个角色（见 `groundPlan`），建筑就只许长在
   * "建筑格"内缩出来的那块地上。把这条约束放在**出口**（`addSolid` / `clipBuilding`）
   * 而不是每个 `plan*` 里各写一遍：摆楼逻辑有十几处（塔楼 / 裙房 / 板楼排布 /
   * 厂房 / 沿街商业），漏一处就是一栋楼压在草地上。
   */
  buildZones?: Pt[][];
  /**
   * 本街区里**停车格**的范围。
   *
   * 植栽（`scatter`）必须躲开它：旧版只躲建筑轮廓，于是树被撒在车位线上
   * （用户截图里"停车场里长树"就是这个）。地已经分好了角色，种树就不许越界。
   */
  park?: Pt[][];
  /**
   * 本块地**贴着街区边界**的那些边（= 临街边）。
   *
   * 由 `planParcels` 切完之后算出来，往下传给每个地块的 `groundPlan`：
   * 地面规划要靠它铺"沿街带"（临街那一圈硬质前场），否则临街面归属只能
   * 由张量二分碰运气决定 —— 实测沿路缘 1.8 m 内侧有 23% 是绿地、
   * 10% 是停车坪，商业街区的正面是草坪，这就是"不合理"的来源。
   */
  streetEdges?: { a: Pt; b: Pt }[];
  /**
   * 本街区已经铺过"沿街带"。
   *
   * `groundLayers` 据此跳过路缘过渡带（0.8 m 混凝土收边）：沿街带本来
   * 就是那块地的临街面，再压一条窄边只会在铺装上多一道色差缝。
   */
  frontaged?: boolean;
}

/**
 * 铺装前的最终自交判定 —— 比 `zones.isSimpleRing` 更严一档。
 *
 * zones 那版对"某顶点恰好落在另一条边上"（cross < 1e-9）放过，因为布尔量化
 * 之后这种贴合很常见。但铺装是要三角化的面：一个顶点压在对面边上，
 * earcut 出来的就是一条零宽裂缝，导出 glTF 后是绕序异常。
 * 这里按"符号严格相异"判，不留 epsilon，与 test/gen.test.ts 的断言同源。
 */
function simpleRing(ring: Pt[]): boolean {
  const n = ring.length;
  if (n < 3) return false;
  const cr = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    if (Pt.distance(a, b) < 1e-9) return false;
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = ring[j];
      const d = ring[(j + 1) % n];
      const d1 = cr(a, b, c);
      const d2 = cr(a, b, d);
      const d3 = cr(c, d, a);
      const d4 = cr(c, d, b);
      if (d1 * d2 < 0 && d3 * d4 < 0) return false;
    }
  }
  return true;
}

/**
 * 折线 / 环的 RDP 简化：去掉近共线的中间点。
 *
 * 布尔运算的结果里经常出现"两条几乎重合的边 + 中间几个几乎共线的点"，
 * 这些点本身无害，但三角化时会退化成针状三角形 —— 俯视图上是地面上一根细刺。
 */
function simplifyRingRDP(ring: Pt[], eps: number): Pt[] {
  const n = ring.length;
  if (n <= 4) return ring;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length > 0) {
    const [i0, i1] = stack.pop()!;
    let maxD = 0;
    let idx = -1;
    const a = ring[i0];
    const b = ring[i1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L = Math.hypot(dx, dy) || 1;
    for (let i = i0 + 1; i < i1; i++) {
      const p = ring[i];
      const d = Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / L;
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx >= 0 && maxD > eps) {
      keep[idx] = 1;
      stack.push([i0, idx], [idx, i1]);
    }
  }
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(ring[i]);
  return out;
}

function addSurface(
  c: Ctx,
  name: string,
  ring: Pt[],
  mat: MatKey,
  y: number,
  clip = true,
  allowThin = false,
  holes: Pt[][] = []
): SurfaceFeature | undefined {
  let r = ring;
  if (clip) {
    const k = clipRing(c, ring);
    if (!k) return;
    r = k;
  }
  if (r.length < 3) return;
  if (area(r) < 1e-4) return;
  // 布尔运算在斜边上会吐出"退化的极短边 + 近共线点"，earcut 三角化时
  // 这些点会拉出细长的尖刺三角形（俯视 / 三维里都是明显的地面穿帮）。
  // 所以在**唯一出口**先做一次 RDP 简化，再判自交与纤薄度。
  r = simplifyRingRDP(r, 0.035);
  if (r.length < 3) return;
  if (!simpleRing(r)) return;
  // 细长碎片（面积不到外接矩形 12%）不铺：它们就是尖刺的来源。
  //
  // 但**路面不能用这条尺子**：一条十字 / 丁字路口并集出来的路面，外接矩形
  // 是整个路口范围，面积占比常常只有 3~8%，按这里判会整条路消失
  // （并集成面之后踩过一次：内部路网直接不见）。所以路面走 allowThin。
  if (!allowThin) {
    const box = minAreaRect(r);
    if (box && Math.abs(area(r)) < Math.abs(area(box)) * 0.12) return;
  }
  // 停车坪被地块裁完之后只剩几平米：一个车位都排不下（≈13 m²/车位），
  // 画出来就是沥青上一块小脏斑，不如不画。
  if (name.startsWith('parking_') && Math.abs(area(r)) < 0.28) return;
  // 返回写出的那个要素：调用方偶尔需要**事后改它**（例如停车格排不下车位时
  // 把沥青改回硬地 —— 见 fillParkCells）。返回 undefined 表示没铺出去。
  // 洞统一成 CCW，和 2D 的填充方向保持一套
  const cleanHoles = holes.filter((h) => h.length >= 3).map((h) => toCCW(h));
  const feat: SurfaceFeature = {
    name,
    group: groupOf(c.use),
    ring: toCCW(r),
    mat,
    y,
    ...(cleanHoles.length > 0 ? { holes: cleanHoles } : {}),
  };
  c.res.surfaces.push(feat);
  return feat;
}

/**
 * 把地块内的铺装裁到建筑红线内。
 * 广场/堆场这些是"按包围盒摆的矩形"，凹地块上必然有个角伸到路上；
 * 不裁的话就会出现铺装压人行道（2D 里看是路被咬掉一块）。
 */
function clipRing(c: Ctx, ring: Pt[]): Pt[] | null {
  const blockRing = Array.from(c.block);
  let inside = true;
  for (const p of ring) {
    if (!pointInPolygon(p, blockRing)) {
      inside = false;
      break;
    }
  }
  if (inside) return ring;
  const parts = intersect(ring, blockRing, 0.06);
  if (parts.length === 0) return null;
  return parts.reduce((a, b) => (area(a) > area(b) ? a : b));
}

/**
 * 落一栋楼。返回**实际进场景的那个轮廓**（`gateSolid` 会把锐角轮廓"扶正"成
 * 主轴外接矩形，甚至拆成几块），拿不到就返回 null。
 *
 * 返回值的用处：入口硬地必须挂在**真正立起来的那面墙**上。调用方原来用的是
 * 处方轮廓 / 裁过的轮廓，跟扶正之后的轮廓差出 0.3~0.5 u，于是门口那块铺装
 * 悬在楼前空地上（实测 58/663 块离楼 > 0.35 u）。
 */
function addSolid(
  c: Ctx,
  name: string,
  ring: Pt[],
  h: number,
  wall: MatKey,
  roof: MatKey,
  kind: SolidKind,
  y0 = 0.05
): Pt[] | null {
  if (ring.length < 3 || h <= 0.02) return null;
  if (area(ring) < 1e-4) return null;
  const g = gateSolid(ring, h, kind, Array.from(c.block));
  // 最后一道保险：建筑不许贴到**街区边界**（街区边界 = 道路中线）。
  //
  // 地块本身已经按半条红线宽内缩过，正常情况建筑离路中线还有 0.4 单位以上。
  // 但凹街区的 `buffer` 会在锐角处斜接出一个凸点，`intersect` 自愈之后留下的
  // "最大块"可能把这个点带进来 —— 于是一栋楼的一个角贴在路中线上
  // （实测 d=0.046，测试里报"建筑压路中线"）。
  // 这种情况下宁可不放这栋楼：一个街角少一栋房子没人看得出来，
  // 楼角戳进车行道是一眼就能看出来的错。
  const pr = c.patch?.shape;
  const prRing = pr && pr.length >= 3 ? Array.from(pr) : null;
  // 压到街区内部路面的体块也不放（见 Ctx.noBuild）
  if (c.noBuild && c.noBuild.some((nb) => ringsOverlap(ring, nb))) return null;
  // 体块不许跑出**当前地块**。
  //
  // `gateSolid` 第一步会把斜边轮廓"扶正"成主轴外接矩形（为了消掉锐角楼），
  // 这一步允许面积涨到 1.45 倍 —— 在凹地块 / L 形地块上，扶正后的矩形可能
  // 整个跑到地块外面去（实测有楼角戳到路中线上 0.06）。地面的角色是分好的，
  // 楼跨出自己那一格就等于压在别人的绿地 / 车位上，所以这里直接不放这一块。
  const blockRing = Array.from(c.block);
  const escapes = (p: Pt) => !pointInPolygon(p, blockRing) && distToRing(p, blockRing) > 0.02;
  // 一个地块可能被拆成**多个规整体块**（见 gateSolid 的 ⓪b）：每个体块单独进场景，
  // 名字加后缀，高度按 hScale 错落 —— 这就是"多个四边形立方体"的布局。
  let placed: Pt[] | null = null;
  for (let i = 0; i < g.rings.length; i++) {
    const r = g.rings[i];
    if (prRing && r.some((p) => distToRing(p, prRing) < 0.1)) continue;
    if (r.some(escapes)) continue;
    const out = toCCW(r);
    if (!placed) placed = out;
    c.res.solids.push({
      name: i === 0 ? name : `${name}_${i}`,
      group: groupOf(c.use),
      ring: out,
      y0,
      h: g.h * (g.hScale?.[i] ?? 1),
      wallMat: wall,
      roofMat: roof,
      kind: g.kind,
    });
  }
  return placed;
}

function addProp(c: Ctx, kind: PropKind, at: Pt, scale = 1, rot = 0, group = 'vegetation') {
  // 停用的道具（长椅 / 垃圾桶 / 指示牌 / 花坛 / 公交亭 / 喷泉 / 护柱 / 车辆 / 旗杆）
  // 统一在这一个出口拦掉 —— 调它们的生成点散在十几个 plan 里，逐个删既容易漏，
  // 将来想恢复还得再挖一遍。
  if (DROPPED_PROPS.has(kind)) return;
  c.res.props.push({
    name: `${kind}_${c.res.props.length}`,
    group: `${groupOf(c.use)}/${group}`,
    kind,
    at,
    rot,
    scale,
    seed: Rng.int(0, 9999),
  });
  if (kind === 'tree' || kind === 'treeSmall' || kind === 'conifer') c.res.trees++;
}

function addPath(c: Ctx, name: string, pts: Pt[], width: number, mat: MatKey, y: number, height?: number) {
  if (pts.length < 2) return;
  c.res.paths.push({ name, group: groupOf(c.use), pts, width, mat, y, height });
}

function groupOf(use: LandUse): string {
  return `lot/${use}`;
}

/**
 * 与可建区求交；面积占比不够就丢弃（避免沿斜边生成细长碎片）。
 *
 * `target` 显式传入"可建范围"，默认是本 block —— 封闭地块里的地块会传入
 * 内缩过的退线环（建筑退线 ≠ 地块红线），这样相邻地块的楼之间才留得出通道。
 */
function clipBuilding(c: Ctx, ring: Pt[], minRatio = 0.52, target?: Pt[]): Pt[] | null {
  const base = area(ring);
  if (base < 1e-5) return null;
  // 可建范围：显式指定 > 地面规划给的"建筑格退线环" > 整块可建区（老路径）
  //
  // 中间那一档是这一轮的关键：地面先被切成互斥的格、每格定了角色，
  // 建筑就只许落在"建筑格"的内缩范围里 —— 于是"楼压在草地上 / 压在自己的
  // 停车坪上"这一类问题，在**落位口径**上就不可能再出现。
  const zones =
    target !== undefined
      ? [target]
      : c.buildZones && c.buildZones.length > 0
        ? c.buildZones
        : [Array.from(c.block)];
  let best: Pt[] | null = null;
  let bestA = 0;
  for (const z of zones) {
    let parts: Pt[][] = [];
    try {
      parts = intersect(ring, z, 0.3);
    } catch {
      continue;
    }
    for (const p of parts) {
      const a = area(p);
      if (a > bestA) {
        bestA = a;
        best = p;
      }
    }
  }
  if (!best || bestA < base * minRatio) return null;
  return best;
}

// ---------------------------------------------------------------- 建筑原型

interface Proto {
  ring: Pt[];
  h: number;
  wall: MatKey;
  roof: MatKey;
  kind: SolidKind;
}

function placeProto(c: Ctx, p: Proto, name: string): Pt[] | null {
  const ring = clipBuilding(c, p.ring);
  if (!ring) return null;
  const placed = addSolid(c, name, ring, p.h, p.wall, p.roof, p.kind);
  if (!placed) return null;
  c.footprints.push(placed);
  c.res.buildings++;
  return placed;
}

/**
 * 建筑入口铺装：门廊前的一小块硬地，**整个落在地块里**。
 *
 * 用户核对意见（本轮，图 3）："建筑物的门与道路的衔接方式太直接了，
 * 直接就接到了道路上，模型重叠 —— 直接算到地块上吧，颜色和道路颜色一致。"
 *
 * 旧版是 `addPath` 一条从**楼心**拉到最近的**地块边界点**的路：
 *   · 从楼心拉，等于把一半的铺装埋在楼底下，只剩楼外那截露出来，
 *     看上去就像"从墙里伸出来一条舌头"；
 *   · 终点在地块边界上 —— 而地块边界就是人行道边（有的地方直接是路缘），
 *     于是这条 2 m 宽的浅色铺装**贴着、压着**人行道收头，压进车行道收头的也有
 *     （`entrance` 中线落在车行道上的实测 3 处，最多的一处 27%）；
 *   · 材质是 `paver`（暖米色），压在混凝土人行道旁边，一眼就看出是另贴的一层。
 *
 * 现在：
 *   · 起点从**楼体轮廓**上算（沿射线求与楼的交点 = 门口），不再从楼心画；
 *   · 长度封顶 7 m，并且**离地块边界留 0.06 的退让**，绝不越出地块；
 *   · 再与地块求交一次（斜边上条带的两个角会翘出去）；
 *   · 材质用 `asphalt`，与车行道同一个色阶 —— 读起来是"这条路顺进院子"，
 *     而不是"院里贴了一块别的铺装"。
 */
function addEntrance(c: Ctx, building: Pt[], zone?: Pt[]) {
  const plot = zone && zone.length >= 3 ? zone : Array.from(c.block);
  const ctr = ringCenter(building);

  // ① 门的方向：楼心 → 地块边界最近点
  let bestD = Infinity;
  let bestQ: Pt | null = null;
  const n = plot.length;
  for (let i = 0; i < n; i++) {
    const a = plot[i];
    const b = plot[(i + 1) % n];
    const q = closestOnSegment(ctr, a, b);
    const d = Pt.distance(ctr, q);
    if (d < bestD) {
      bestD = d;
      bestQ = q;
    }
  }
  if (!bestQ || bestD < 0.2) return;
  const dir = unitOf(new Pt(bestQ.x - ctr.x, bestQ.y - ctr.y));

  // ② 门口：射线从楼心出去，第一个穿出楼体轮廓的点
  let tWall = Infinity;
  for (let i = 0; i < building.length; i++) {
    const a = building[i];
    const b = building[(i + 1) % building.length];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const den = dir.x * ey - dir.y * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((a.x - ctr.x) * ey - (a.y - ctr.y) * ex) / den;
    const s = ((a.x - ctr.x) * dir.y - (a.y - ctr.y) * dir.x) / den;
    if (t > 0.01 && s >= -0.001 && s <= 1.001) tWall = Math.min(tWall, t);
  }
  if (!Number.isFinite(tWall)) return;

  // ③ 条带：门口 → 往地块边界方向 7 m，但**不许顶到边界**
  const t0 = tWall + 0.015;
  const t1 = Math.min(tWall + ENTRANCE_LEN, bestD - 0.08);
  // 门口前面本来就有一圈散水（apron）。地块太紧、连 0.3 u 都挤不出来时
  // 干脆不画 —— 一块 0.1 u 的深色小方片贴在墙上，比没有更像"贴错了"。
  if (t1 - t0 < 0.3) return;
  const p0 = new Pt(ctr.x + dir.x * t0, ctr.y + dir.y * t0);
  const p1 = new Pt(ctr.x + dir.x * t1, ctr.y + dir.y * t1);
  // 宽度按用途分：住宅是**入户步道**（1.2 m 宽），商业 / 工业是**门口硬地**
  // （2.1 m 宽，要落客和卸货）。住宅这条现在穿过的是前院草坪，
  // 2 m 宽的沥青舌头压在草坪上会读成"车道"，1.2 m 的混凝土才读得出是走人的。
  const walk = c.use === 'residential';
  const raw = stripe(p0, p1, walk ? u(1.2) : ENTRANCE_W);
  if (!raw) return;

  // ④ 与地块求交（斜边上两个角会翘出地块），取最大块
  let ring = raw;
  if (!raw.every((p) => pointInPolygon(p, plot))) {
    const parts = intersect(raw, plot, 0.02);
    if (parts.length === 0) return;
    ring = parts.reduce((a, b) => (Math.abs(area(a)) > Math.abs(area(b)) ? a : b));
  }
  if (Math.abs(area(ring)) < 0.02) return;

  // ⑤ 贴在门前的这层地面上（比该处地面高 4 mm，不与非地面层打架）
  const y = groundYAt(c, p0) + 0.0004;
  addSurface(c, 'entrance', ring, walk ? 'concrete' : 'asphalt', y, false, true);

}

/** 入口硬地的长度 / 宽度（u）：7 m 长、2 m 宽的门口硬地 */
const ENTRANCE_LEN = 1.0;
const ENTRANCE_W = 0.3;

/** 某点处最高的"地面层"标高（只认 y < 0.02 的铺装层，标线 / 车位线不算） */
function groundYAt(c: Ctx, p: Pt): number {
  let y = 0.0072;
  for (const s of c.res.surfaces) {
    if (s.y < 0.002 || s.y > 0.02) continue;
    if (s.y > y && pointInPolygon(p, s.ring)) y = s.y;
  }
  return y;
}

function closestOnSegment(p: Pt, a: Pt, b: Pt): Pt {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  if (len2 < 1e-9) return a;
  let t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2;
  t = clamp(t, 0, 1);
  return new Pt(a.x + vx * t, a.y + vy * t);
}

/** 两条直线的交点（平行返回 null） */
function hitLines(p1: Pt, d1: Pt, p2: Pt, d2: Pt): Pt | null {
  const cr = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(cr) < 1e-9) return null;
  const t = ((p2.x - p1.x) * d2.y - (p2.y - p1.y) * d2.x) / cr;
  return new Pt(p1.x + d1.x * t, p1.y + d1.y * t);
}

/** 沿外法线把环放大 d（斜接），用在建筑外沿铺装上 */
function outset(ring: Pt[], d: number): Pt[] {
  const n = ring.length;
  if (n < 3) return ring;
  const s = area(ring) >= 0 ? 1 : -1;
  const lines: { p: Pt; dir: Pt }[] = [];
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return ring;
    const nx = ((s > 0 ? dy : -dy) / len) * d;
    const ny = ((s > 0 ? -dx : dx) / len) * d;
    lines.push({ p: new Pt(a.x + nx, a.y + ny), dir: new Pt(dx / len, dy / len) });
  }
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const prev = lines[(i - 1 + n) % n];
    const cur = lines[i];
    out.push(hitLines(prev.p, prev.dir, cur.p, cur.dir) ?? cur.p);
  }
  return out;
}

// ---------------------------------------------------------------- 中间层铺装
//
// 地块的"中间层"是基底和功能面之间的过渡：
//   ① BuildingApron   —— 建筑外沿硬质铺装（把楼"落地"，不留一圈草）
//   ② RoadEdgeGround  —— 路缘 → 人行道过渡带（沿地块红线的一道窄铺装）
//   ③ ServiceYard     —— 后场服务院（装卸 / 垃圾 / 设备），只在工业与商业出现
// 这三层都在"基底之上、停车与广场之下"的高度，所以永远垫在功能面底下，
// 只负责把空旷的基底"收边"，不会盖掉别的东西。

/**
 * 建筑外沿铺装深度（≈1.6 m）。
 *
 * 早先是 3 m（0.42 单位）。切出小地块之后，一个街区有 3~5 栋楼，
 * 每栋楼一圈 3 m 散水加起来能吃掉街区 14% 的地 —— 绿地全被这圈米色吃掉，
 * 俯视图上就是"楼 + 一圈水泥 + 一条草缝"。压到 1.6 m 后散水还在
 * （楼照样落地，不会浮在草上），但院子回到草坪。
 */
const APRON = 0.22;
/** 路缘过渡带宽度（≈0.8 m） */
const EDGE_W = 0.11;

/**
 * 把环里属于草地的部分减掉（`c.green` 是 pavingPartition 已经定下的草坪）。
 *
 * 只对真跟这个环包围盒相交的草地做布尔，避免给每栋楼都跑一遍全街区求差。
 */
function subtractGreen(c: Ctx, ring: Pt[]): Pt[][] {
  if (c.green.length === 0) return [ring];
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (const p of ring) {
    if (p.x < u0) u0 = p.x;
    if (p.x > u1) u1 = p.x;
    if (p.y < v0) v0 = p.y;
    if (p.y > v1) v1 = p.y;
  }
  const hits = c.green.filter((g) =>
    g.some((p) => p.x >= u0 && p.x <= u1 && p.y >= v0 && p.y <= v1)
  );
  if (hits.length === 0) return [ring];
  return subtract(ring, hits);
}

function groundLayers(c: Ctx) {
  // ① 建筑外沿
  for (const fp of c.footprints) {
    if (fp.length < 3) continue;
    const ring = outset(fp, APRON);
    // 先裁可建区，再把已经定下来的草地减掉 —— 顺序不能反：
    // 反过来的话草地会参与一次多余的布尔，而且洞会被 `fromGeom` 丢掉
    // （它只返回外环），楼正下方那块草地会整块消失。
    const parts = intersect(ring, Array.from(c.block), 0.2);
    for (const p of parts) {
      if (Math.abs(area(p)) < 0.06) continue;
      for (const piece of subtractGreen(c, p)) {
        if (Math.abs(area(piece)) < 0.03) continue;
        addSurface(c, 'apron', piece, 'concrete', 0.0085, false);
      }
    }
  }

  // ② 路缘过渡带：软质基底（公园 / 车场）不加，否则绿边会被削掉一圈。
  //
  // 已经铺过「沿街带」的街区也跳过：沿街带本身就是那块地的临街面，
  // 再压一条 0.8 m 的窄边只会在铺装上多一道色差缝。
  if (!c.frontaged && c.use !== 'park' && c.use !== 'parking') {
    const block = Array.from(c.block);
    const inner = insetRing(block, EDGE_W);
    // 逐边生成梯形四边形，而不是 subtract(block, inner) 求环形带：
    // 环形带带一个洞，而铺装是单环多边形 —— 洞那部分会被当成实心再铺一遍，
    // 面积直接翻倍，整块基底被盖成水泥色。逐边梯形天然无洞，
    // 相邻两块共用 p_i–q_i 这条缝，正好铺满整圈。
    if (inner.length === block.length && inner.length >= 3) {
      for (let i = 0; i < block.length; i++) {
        const j = (i + 1) % block.length;
        const quad = [block[i], block[j], inner[j], inner[i]];
        if (Math.abs(area(quad)) < 1e-4) continue;
        // 尖锐凸角处内缩点会越过相邻顶点，梯形退化成蝴蝶结（两条边真相交）。
        // 一块 1.8 m 宽的碎片在图上就是一撮水泥渣，不如不铺。
        if (!isSimpleRing(quad)) continue;
        addSurface(c, 'roadedge', quad, 'concrete', 0.0092, false);
      }
    }
  }

  // ② 路缘石：沿临街边内侧压一条 0.15 m 的浅色石带
  //
  // 这一版之前，"路缘石"只有宽度概念（`EDGE_W` 那条 0.8 m 的过渡带），
  // 没有**材质**：铺装与车行道之间只有颜色差，从三维视角看是两块薄片贴在一起，
  // 没有"高一档"的读法。真实街道上，路缘石是唯一一条连续的、比两侧都亮的窄线，
  // 它一出现，人行道 / 前场 / 车行道三层立刻分开。
  //
  // 只画在**临街边**（`c.streetEdges`）：地块之间的巷道不做路缘石，
  // 那里的高差由巷子自己的横断面解决。
  if ((c.streetEdges?.length ?? 0) > 0 && c.use !== 'park' && c.use !== 'parking') {
    const ctr0 = ringCenter(Array.from(c.block));
    for (const e of c.streetEdges ?? []) {
      const L = Pt.distance(e.a, e.b);
      if (L < u(2)) continue;
      let nx = -(e.b.y - e.a.y) / L;
      let ny = (e.b.x - e.a.x) / L;
      const mx = (e.a.x + e.b.x) / 2;
      const my = (e.a.y + e.b.y) / 2;
      if ((ctr0.x - mx) * nx + (ctr0.y - my) * ny < 0) {
        nx = -nx;
        ny = -ny;
      }
      const w = u(0.15);
      const quad = [
        e.a,
        e.b,
        new Pt(e.b.x + nx * w, e.b.y + ny * w),
        new Pt(e.a.x + nx * w, e.a.y + ny * w),
      ];
      if (!isSimpleRing(quad)) continue;
      addSurface(c, 'curb_line', quad, 'curb', 0.0099, false, true);
    }
  }

  // ③ 后场服务院：工业 / 商业 / 市政才有，且必须已经排过建筑
  if (c.footprints.length === 0) return;
  if (c.use !== 'industrial' && c.use !== 'commercial' && c.use !== 'civic') return;
  const yard = serviceYard(c);
  if (!yard) return;
  addSurface(c, 'service_yard', yard, 'asphaltLot', 0.0094, false);
  const p = ringCenter(yard);
  if (pointInPolygon(p, Array.from(c.block))) addProp(c, 'bin', p, 1, 0, 'furniture');
}

/**
 * 孤儿地带兜底：地块内既不属于可建区、也没被道路覆盖的残余面。
 *
 * 可建区是按"每条边各自的红线宽"内缩出来的，凹地块（张量场切出来的多是这种）
 * 内缩后可能整块塌掉一瓣，而那一瓣上又没有路 —— 路面只铺在相邻地块的公共边上。
 * 结果就是俯视图里一块既没有铺装、没有建筑、也没有路的"底色空洞"，
 * 面积能到四百多平米，位于城市正中间非常扎眼。
 *
 * 这里把"地块 − 可建区"的残余补一层基底材质。路面高度在 0.012 以上，
 * 仍然盖在这些补面之上，所以不会侵吞任何车行道。
 */
function orphanGround(c: Ctx) {
  const patch = Array.from(c.patch.shape);
  const block = Array.from(c.block);
  if (patch.length < 3 || block.length < 3) return;

  const rest = subtract(patch, [block]);
  for (const p of rest) {
    if (p.length < 3 || Math.abs(area(p)) < 1.2) continue;
    // 大片残地不整片刷一个底色：切成块 + 园路（和 Planner 地块同一套读法）。
    // 城市外圈那些整块的大草地就是从这里来的，不切的话俯视图上是一整片纯绿。
    const green = subdivideGreen(planSurface(p), 'landscape');
    if (green) {
      for (const [k, s] of green.paths.entries()) {
        addSurface(c, `orphan_ground_c${k}`, s.outer as Pt[], 'gravel', 0.0055, false, false, s.holes as Pt[][]);
      }
      for (const [k, s] of green.plots.entries()) {
        addSurface(c, `orphan_ground_c${k}`, s.surface.outer as Pt[], s.mat, 0.0057, false, false, s.surface.holes as Pt[][]);
      }
      continue;
    }
    addSurface(c, 'orphan_ground', p, c.baseMat, 0.0055, false);
  }
}

/** 后场服务院：取地块里离红线最远的那块空地，给一块约 8×6 m 的硬地 */
function serviceYard(c: Ctx): Pt[] | null {
  const { bb, f } = c;
  const w = 0.9;
  const h = 0.7;
  const du = Math.max(0.05, bb.w - w - 0.1);
  const dv = Math.max(0.05, bb.h - h - 0.1);
  // 服务院必须落在**建筑格**里。
  //
  // 旧版只在"不与建筑重叠"上做判断：它是按包围盒四个角试出来的固定矩形，
  // 和地块内部的切分毫无关系 —— 于是那块沥青硬地会横跨草地格 / 停车格，
  // 在半边草坪上切出一块 6×5 m 的直角沥青补丁（一次生成里 600 多处）。
  // 现在先裁到建筑格的内缩环；**没有地面规划就没有得裁**（例如"地块再切成
  // 小地块"的父级上下文，它的 buildZones 在各子地块里），那一层干脆不放服务院 ——
  // 按包围盒猜一个位置必然会落在别人的地块或草坪上。
  const zones = c.buildZones;
  if (!zones || zones.length === 0) return null;
  let best: { a: number; ring: Pt[] } | null = null;
  // 四个角各试一次：选"离建筑最远、且贴合地块"的那个
  for (let i = 0; i < 4; i++) {
    const u0 = bb.u0 + 0.05 + (i % 2) * du;
    const v0 = bb.v0 + 0.05 + (i >> 1) * dv;
    const ring = rect(f, u0, u0 + w, v0, v0 + h);
    for (const z of zones) {
      const parts = intersect(ring, z, 0.55);
      if (parts.length === 0) continue;
      const cand = parts.reduce((a, b) => (area(a) > area(b) ? a : b));
      const ca = Math.abs(area(cand));
      if (ca < 0.2) continue;
      // 与建筑重叠的直接弃掉
      let hit = false;
      const ctr = ringCenter(cand);
      for (const fp of c.footprints) {
        if (pointInPolygon(ctr, fp) || withinRing(ctr, fp, -0.05)) {
          hit = true;
          break;
        }
      }
      if (hit) continue;
      if (!best || ca > best.a) best = { a: ca, ring: cand };
    }
  }
  return best ? best.ring : null;
}

// ---------------------------------------------------------------- 基底

function baseSurface(c: Ctx, mat: MatKey) {
  // base 本身就是可建区，已经规范化过，不需要再裁
  c.baseMat = mat;
  // 绿地基底不整片刷：公园 / 林地 / 低密度住宅的基底动辄上万平米，
  // 一整块纯色就是用户说的"大片绿地没有分块规划"。切成块 + 园路。
  if (mat === 'grass' || mat === 'grassDark' || mat === 'lawn') {
    const green = subdivideGreen(planSurface(Array.from(c.block)), 'landscape');
    if (green) {
      for (const [k, s] of green.paths.entries()) {
        addSurface(c, `base_c${k}`, s.outer as Pt[], 'gravel', 0.006, false, false, s.holes as Pt[][]);
      }
      for (const [k, s] of green.plots.entries()) {
        addSurface(c, `base_c${k}`, s.surface.outer as Pt[], s.mat, 0.0062, false, false, s.surface.holes as Pt[][]);
      }
      return;
    }
  }
  addSurface(c, 'base', Array.from(c.block), mat, 0.006, false);
}

// ---------------------------------------------------------------- 各用途

function planCbd(c: Ctx) {
  // 商务地块：硬质为主（前场 + 大堂落客），内部切出 16% 绿化 + 少量停车。
  //
  // 前广场 / 塔楼 / 裙房原来都是各自算的包围盒矩形，前广场那块 paver 直接
  // 压在铺装格上。现在前广场就是临街的硬地格本身（材质相同，不需要第二层），
  // 塔楼 + 裙房只落在建筑格的内缩范围里。
  const cells = groundPlan(c, {
    greenRatio: 0.16,
    parkRatio: 0.05,
    hard: 'stonePave',
    buildMat: 'stonePave',
  });
  massCells(c, cells, PARCEL_STYLE.cbd, { podium: true });
  fillGreenCells(c, cells);
  fillParkCells(c, cells);
}

function planCommercial(c: Ctx) {
  // 沿街商业：临街硬质前场 + 内部 20% 草地 + 后场停车。
  //
  // 用户截图里那一块（红圈）就是旧版这里：铺装是九宫格，后场停车是另一个包围盒
  // 矩形直接压在九宫格上（沥青 0.0136 > 铺装 0.006），树又撒在车位线上。
  // 现在地面是一次切分成互斥的格：临街格是硬地、内部是绿地、靠边一格是停车格，
  // 建筑只落在建筑格的内缩范围里。
  const cells = groundPlan(c, {
    greenRatio: 0.2,
    parkRatio: 0.1,
    hard: 'paver',
    buildMat: 'paver',
  });
  massCells(c, cells, PARCEL_STYLE.commercial, { podium: true });
  fillGreenCells(c, cells);
  fillParkCells(c, cells);
}

// ---------------------------------------------------------------- 地面 = 地块的子切割
//
// 用户口径（本轮，图 1）：
//   ·「不同地面铺装应该基于区块切割和多次下细分切割后的，不应该互相重叠」
//   ·「地上建筑也应该切割地块中被定义为建筑的地块内缩的位置生成」
//
// 上一版（`pavingPartition`）的问题，正是截图里红圈那一块：
//   ① 地面是**外接矩形上的九宫格**（等分 + 抖动），跟这个地块怎么被切开毫无关系；
//   ② 停车坪、内院绿带、前广场都是**另外算的包围盒矩形**，直接叠在九宫格上：
//      沥青 0.0136 压在铺装 0.006 上、内院绿带 0.013 又压在沥青上 —— 同一块地面
//      三层铺装互相盖，"这块地的地面到底是什么"取决于谁的 y 大；
//   ③ 建筑按包围盒排，它不知道哪一格已经是绿地 / 停车坪，于是楼角伸进草地；
//      `scatter` 只躲了建筑轮廓、没躲停车坪，树直接撒在车位线上。
//
// 现在合成一层：**地块 → 递归二分出来的格 → 每格一个角色**。
//   · 切分复用街区切割的同一套 `tensorPartition`（每一刀都是多边形布尔分割），
//     所以切出来的格**严格铺满、互不重叠** —— 重叠在数据层就不可能发生；
//   · 每格只有一个角色：建筑 / 绿地 / 停车 / 硬质前场；地面每格只铺一次，
//     不存在"先铺一层再贴一层"；
//   · 建筑只落在"建筑"格的**内缩环**里（`plot`），楼出不了自己那一格；
//   · 植栽只种在绿地格里，车位只排在停车格里 —— 各用各的地，不越界。

export type CellRole = 'build' | 'green' | 'park' | 'pave';

export interface GroundCell {
  ring: Pt[];
  a: number;
  role: CellRole;
  /** 内切半径近似 2A/P（u），用来判断"这一格放不放得下一栋楼 / 一排车位" */
  inr: number;
  /** 格心到地块边界的距离（u）：越小越临街 */
  edge: number;
  /** build 格：建筑可落位的退线环 */
  plot?: Pt[];
  /** green 格：绿化类型 */
  gkind?: 'lawn' | 'grove' | 'bed';
  /**
   * park 格：这一格的铺装要素。
   *
   * 停车格是先按面积划出来、再排车位的。排下来不足 `MIN_LOT_BAYS` 个车位时
   * （斜边窄条、被绿岛切碎），这一格就不该是停车场 —— 直接把它改成硬地。
   * 要改就得有引用，所以在铺地时把它存下来，别在 `res.surfaces` 里按名字反查。
   */
  feat?: SurfaceFeature;
}

interface GroundOpts {
  /** 绿地面积占比目标 */
  greenRatio: number;
  /** 停车面积占比目标（0 = 不划停车格） */
  parkRatio?: number;
  /** 硬地材质 */
  hard: MatKey;
  /** 建筑格的基底（住宅是草坪、商务是石材；默认跟硬地一致） */
  buildMat?: MatKey;
  /** 目标格数 1 / 2 / 4 / 8；不给就按地块面积推 */
  cells?: number;
}

/** 建筑进深下限（u）：与后文 `MIN_DEPTH_M`（8 m）同一个口径，提前到能用的位置 */
const MIN_INR_U = 8 / 7;

/**
 * 各地块的地面配比与材质。
 *
 * 绿地 / 停车是**面积占比目标**，硬地是"非绿地格"的铺装材质。
 * 数值沿用各用途原来的处方（商业 20% 草、市政 34%、工业 13%…），
 * 只是从"贴在铺装上的一层"变成了"切出来的某几格"。
 */
const GREEN_OF: Partial<Record<LandUse, number>> = {
  cbd: 0.16,
  commercial: 0.2,
  civic: 0.34,
  industrial: 0.13,
  residential: 0.34,
};
const PARK_OF: Partial<Record<LandUse, number>> = {
  cbd: 0.05,
  commercial: 0.1,
  civic: 0.04,
  industrial: 0.14,
  residential: 0.12,
};
const HARD_OF: Partial<Record<LandUse, MatKey>> = {
  cbd: 'stonePave',
  commercial: 'paver',
  civic: 'paver',
  industrial: 'gravel',
  residential: 'concrete',
};

/**
 * 沿街带的宽度（u）：临街那一圈硬质前场。
 *
 * 不是随手取的：商业 / 商务要容得下"店面 + 落客 + 树池"，所以 4 m 上下；
 * 住宅只要一条入户前场，2.7 m 就够；工业要进叉车，3.5 m。
 */
const FRONTAGE_W: Partial<Record<LandUse, number>> = {
  cbd: 0.62,
  commercial: 0.55,
  civic: 0.55,
  industrial: 0.5,
  residential: 0.38,
};

/**
 * 沿街带：这一块地里**贴着街区边界**的那一圈，按临街边逐条生成梯形。
 *
 * 逐边生成而不用 `subtract(ring, insetRing(ring, w))`：后者是一个带洞的环，
 * 而铺装是单环多边形 —— 洞会被当成实心再铺一遍，整块地被盖成前场色
 * （这个坑在 `groundLayers` 的路缘过渡带里踩过一次，注释还在）。
 *
 * 转角怎么收口（这一版改的）：相邻两条临街边的带子**都往外多探一截**（`w*0.6`），
 * 让它们在角上重叠，然后再 `unionAll` 合成一块。
 * 上一版是反过来"各向内收 `w*0.55`"，看似不重叠，实际在角上留了逐个台阶状的缺口 ——
 * `subtract(ring, fronts)` 之后地块内部变成一个**带 2~3 m 锯齿的梳子**，
 * 张量二分把这个梳子再切一次，切出来的格子全是带刺的环，`insetRing` 一偏移就自交、
 * 面积塌成 0，`plotOf` 判 null，整块地一格建筑都盖不出来（实测 61% 的地块空着）。
 *
 * 重叠不用担心铺装重复：调用方拿到的是 `unionAll` 之后的结果，同一块地只铺一次。
 */
function frontageBands(c: Ctx, ring: Pt[]): Pt[][] {
  const edges = c.streetEdges;
  if (!edges || edges.length === 0 || ring.length < 3) return [];
  const w = FRONTAGE_W[c.use] ?? 0.45;
  const ctr = ringCenter(ring);
  const raw: Pt[][] = [];
  for (const e of edges) {
    const L = Pt.distance(e.a, e.b);
    if (L < w * 1.6) continue;
    // 内法线（指向环心）
    let nx = -(e.b.y - e.a.y) / L;
    let ny = (e.b.x - e.a.x) / L;
    const mx = (e.a.x + e.b.x) / 2;
    const my = (e.a.y + e.b.y) / 2;
    if ((ctr.x - mx) * nx + (ctr.y - my) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    // 沿边**向外**多探一截，保证转角被盖住（重叠部分稍后裁掉）
    const ux = (e.b.x - e.a.x) / L;
    const uy = (e.b.y - e.a.y) / L;
    const t = w;
    const a0 = new Pt(e.a.x - ux * t, e.a.y - uy * t);
    const b0 = new Pt(e.b.x + ux * t, e.b.y + uy * t);
    const quad = [a0, b0, new Pt(b0.x + nx * w, b0.y + ny * w), new Pt(a0.x + nx * w, a0.y + ny * w)];
    if (!isSimpleRing(quad)) continue;
    const parts = intersect(quad, ring, 0.02);
    for (const p of parts) {
      if (Math.abs(area(p)) < 0.05) continue;
      const cl = cleanRing(p);
      if (cl.length >= 3) raw.push(cl);
    }
  }
  if (raw.length <= 1) return raw;
  // 裁掉转角的重叠：第 i 条减掉前 i-1 条。铺装因此**既不重叠也不留缝** ——
  // 留缝会在核心里长出小凸块，重叠会在同一个 y 上 z-fighting。
  const out: Pt[][] = [];
  for (let i = 0; i < raw.length; i++) {
    const pieces = i === 0 ? [raw[i]] : subtract(raw[i], raw.slice(0, i));
    for (const p of pieces) {
      const cl = cleanRing(p);
      if (cl.length >= 3 && Math.abs(area(cl)) > 0.05) out.push(cl);
    }
  }
  return out.length > 0 ? out : raw;
}

/**
 * 街区 / 地块的地面规划：切格 → 定角色 → 逐格铺一次。
 *
 * 返回值给上层用来"在建筑格里摆楼、在绿地格里种树、在停车格里排车位"，
 * 上层**不需要**再自己算任何铺装面 —— 地面这件事到此为止。
 */
function groundPlan(c: Ctx, o: GroundOpts): GroundCell[] {
  const ring = Array.from(c.block);
  const A = Math.abs(area(ring));
  if (A < 1e-4) return [];
  const BP = c.model.params.block;

  // ---- ⓪ 沿街带：先把临街那一圈摘出去，剩下的才是"内部"
  //
  // 用户核对意见："地面铺装和街区内部的地面铺装在合理性上不够"。
  // 实测（5 个种子 419 个街区，距路缘 1.8 m 内侧采样）：
  //   绿地草 22.9% / 停车沥青 10.5% / 建筑格草皮 9.7% / 各级铺装 30%。
  // 也就是说临街面上是什么，完全取决于张量二分把哪一格切到了边上 ——
  // 商业街区的正面可以是一片草坪，住宅的正面可以是一个停车场。
  //
  // 修法：**临街那一圈先定死为硬质前场**（宽度按用途 2.7~4.3 m），
  // 绿地、停车、建筑格全部退到它后面。这是真实街区最不可动摇的一条层次：
  // 车行道 → 人行道 → 前场 → 建筑，四层从不由抽签决定。
  const fronts = frontageBands(c, ring);
  let core = ring;
  let coreA = A;
  if (fronts.length > 0) {
    const rest = subtract(ring, fronts).filter((p) => p.length >= 3);
    const best = rest.length > 0 ? rest.reduce((x, y) => (Math.abs(area(x)) >= Math.abs(area(y)) ? x : y)) : null;
    const bestA = best ? Math.abs(area(best)) : 0;
    // 内部剩不到三成（窄条地块 / 沿街带几乎吃满）：这一块放弃沿街带，
    // 否则剩下的"内部"放不下一栋楼，整块地变成一条硬地。
    if (best && bestA > A * 0.3) {
      core = cleanRing(best);
      coreA = bestA;
      // 住宅的前场是**前院草坪**，不是硬地。
      //
      // 商业 / 商务 / 市政 / 工业的临街面要站人、落客、摆货，铺硬的是对的；
      // 住宅按同一条规则铺硬，读出来就成了"自家门前一块水泥场" —— 而真实的
      // 独栋 / 联排是：人行道 → 2~3 m 前草坪 → 入户步道 → 房子。
      // 这里把住宅的沿街带换成草（标高跟着其他绿地走 0.0086），
      // 入户步道由 `addEntrance` 单独穿过去，三段关系才成立。
      const frontSoft = c.use === 'residential';
      const frontMat: MatKey = frontSoft ? 'grassLight' : o.hard;
      const frontY = frontSoft ? 0.0086 : 0.0096;
      for (const f of fronts) addSurface(c, 'frontage', f, frontMat, frontY, false, true);
      c.frontaged = true;
    }
  }

  // ---- ① 切格：地块 → 2 / 4 / 8 个子地块（与街区切割完全同一套递归二分）
  //
  // 不用"包围盒等分"：那样切出来的格与地块的真实斜边、与相邻地块的分割线都
  // 对不上，铺装看起来是一张盖在地块上的网格毯（这就是用户说的"拼凑"）。
  const n = o.cells ?? (coreA > 500 ? 8 : coreA > 200 ? 4 : coreA > 90 ? 2 : 1);
  const depth = Math.max(0, Math.round(Math.log2(n)));
  const targetA = coreA * (depth <= 0 ? 2 : depth === 1 ? 0.62 : depth === 2 ? 0.34 : 0.2);
  const part = tensorPartition(core, {
    targetA,
    minA: Math.max(coreA * 0.05, 0.5),
    maxDepth: depth,
    ang0: parcelAngle(c),
    pattern: 'ortho',
  });

  const cells: GroundCell[] = [];
  for (const r of part.parcels) {
    const a = Math.abs(area(r));
    if (a < 1e-4) continue;
    // 先把环洗干净（去重合点 / 共线点 / 往返尖刺）。
    //
    // `bisectRing` 切出来的环带着割线上的共线顶点，一块四边形常常是 7~12 个点。
    // 直接拿它做斜接偏移（`insetRing`），那些 179.9° 的"角"会被当成锐角斜接，
    // 偏移量沿法线方向被放大 1/sin(θ/2) 倍，环自己翻出去 —— 面积塌到不足一半，
    // `plotOf` 判 null，整块地一格建筑都没有。实测 61% 的地块因此空着。
    const cr = cleanRing(r);
    if (cr.length < 3) continue;
    const fit = shapeFit(cr);
    cells.push({
      ring: toCCW(cr),
      a: Math.abs(area(cr)),
      role: 'pave',
      inr: fit.inradius,
      edge: distToRing(ringCenter(cr), ring),
    });
  }
  // 一刀都没切开 / 布尔失败：整块当一个格，角色照样按预算走
  if (cells.length === 0) {
    const fit = shapeFit(core);
    cells.push({ ring: toCCW(core), a: coreA, role: 'pave', inr: fit.inradius, edge: 0 });
  }

  // ---- ② 定角色
  const total = cells.reduce((s, x) => s + x.a, 0);
  const wantGreen = total * o.greenRatio;
  const wantPark = total * (o.parkRatio ?? 0);
  let gotGreen = 0;
  let gotPark = 0;

  /**
   * 退线环：建筑不能贴着自己那一格的边界盖，否则相邻两格的楼又贴在一起了。
   * 退线按格尺度给，退完剩下不到一半就整格让给硬地（宁可不盖，也不盖"纸片"）。
   */
  const plotOf = (cell: GroundCell): Pt[] | null => {
    const base = cleanRing(cell.ring);
    if (base.length < 3) return null;
    const sb = clamp(Math.sqrt(cell.a) * BP.setbackK, 0.1, 0.4);
    const r = cell.inr > sb * 2.2 ? insetRing(base, sb) : base;
    if (r.length < 3 || !isSimpleRing(r)) return base;
    if (Math.abs(area(r)) < cell.a * 0.5) return null;
    // 退线环必须**真的在格里**：斜接偏移在锐角 / 细条上会把自己翻到环外
    // （实测有一栋楼因此压到了路中线）。顶点不全在格内就退回整格。
    const inside = r.every((p) => pointInPolygon(p, cell.ring));
    const ring = inside ? r : base;
    return shapeFit(ring).inradius >= MIN_INR_U * 0.75 ? ring : null;
  };

  // 绿地：最靠内的格先吃预算（绿地自然聚成内部口袋，而不是沿街一条条）
  for (const cell of cells.slice().sort((p, q) => q.edge - p.edge)) {
    if (cell.a > wantGreen * 2.2) continue;
    if (gotGreen + cell.a > wantGreen * 1.45) continue;
    cell.role = 'green';
    cell.gkind = pickGreenKind(c.use, cell.a * 49);
    gotGreen += cell.a;
  }

  // 单格地块（小地块，切不动）：整块按配比**抽签**当绿地。
  //
  // 为什么要有这一步：一格就是一个地块时，`cell.a > wantGreen * 2.2` 这条
  // "别把整块地变成草坪"的闸永远成立，于是小地块永远拿不到绿地 —— 而地块
  // 尺度的绿地本来就该是"这一片是口袋公园"，不是"一块地上贴一条草带"。
  // 抽签概率直接取绿地配比，面积的期望值正好落在 `greenRatio` 上。
  //
  // 单格占满整块地、面积远超预算时，改成**再切一刀**（见下面的 splitCellToArea）：
  // 割线位置按剩余预算二分，切出来的一块刚好是绿地，另一块照旧可建。
  if (gotGreen < wantGreen * 0.7) {
    const host = cells.filter((x) => x.role === 'pave').sort((p, q) => q.a - p.a)[0];
    if (host) {
      const target = Math.max(wantGreen - gotGreen, host.a * 0.1);
      const cut = splitCellToArea(host.ring, target);
      if (cut) {
        const g: GroundCell = {
          ring: toCCW(cut.part),
          a: Math.abs(area(cut.part)),
          role: 'green',
          gkind: pickGreenKind(c.use, Math.abs(area(cut.part)) * 49),
          inr: shapeFit(cut.part).inradius,
          edge: distToRing(ringCenter(cut.part), ring),
        };
        host.ring = toCCW(cut.rest);
        host.a = Math.abs(area(cut.rest));
        host.inr = shapeFit(host.ring).inradius;
        host.edge = distToRing(ringCenter(host.ring), ring);
        cells.push(g);
        gotGreen += g.a;
      }
    }
  }

  // 停车：整格划拨（一排车位要整块地才排得下），优先靠近地块边界 —— 车要开得出去
  if (wantPark > 0.5) {
    for (const cell of cells.slice().sort((p, q) => p.edge - q.edge)) {
      if (cell.role !== 'pave') continue;
      if (cell.inr < MIN_INR_U) continue;
      if (cell.a > wantPark * 2.4) continue;
      if (gotPark + cell.a > wantPark * 1.6) continue;
      cell.role = 'park';
      gotPark += cell.a;
      if (gotPark >= wantPark) break;
    }
    // 还是没划出停车格：从最靠外的格里切一小块出来（同样按面积二分找割线）
    if (gotPark === 0) {
      const host = cells.filter((x) => x.role === 'pave').sort((p, q) => p.edge - q.edge)[0];
      if (host) {
        const want0 = Math.max(wantPark, host.a * 0.14);
        // 切出来的带子有多宽？割线垂直于主轴，割线的**弦长**约等于短边
        // （矩形上就是 2×内切半径），所以带子的宽度 ≈ 目标面积 / 弦长。
        //
        // 这一条是"只有一个车位的停车场"的另一半根因（用户图 1 / 图 2）：
        // 预算只有 5 u²、而宿主格是 20×10，按面积二分切出来的是
        // **20 u 长 × 0.5 u 宽**的一条线 —— 连一排车都停不下，却照样铺沥青、
        // 围栏、灯，画出来就是一块带一两道白线的空沥青。
        //
        // 修法不是"切不出就不给"（那样整块地就没有停车了），而是**把带子加宽到
        // 刚好停得下一排**：车位进深 5 m + 通道 6.3 m + 两侧退让 ≈ 1.9 u。
        // 停车预算是**下限**不是上限 —— 沿后墙一排车位，本来就是这类地块
        // 该有的东西。加宽后仍超过宿主格一半面积的才放弃。
        const chord = Math.max(2 * host.inr, 0.1);
        // 加宽有上限：最多把这一格的 30% 让给停车，且不超过预算的 3 倍。
        // 不然"一排车位"会把宿主格吃掉一大半，剩下的建筑格退线后站不住，
        // 整块地的楼全被降级成 1~2 层沿街小铺（shape 测试会报"主流体量被吃掉"）。
        const cap = Math.min(host.a * 0.3, want0 * 3);
        const want = Math.min(Math.max(want0, chord * MIN_PARK_BAND), cap);
        if (want / chord >= MIN_PARK_BAND * 0.8) {
          const cut = splitCellToArea(host.ring, want);
          if (cut) {
            const p: GroundCell = {
              ring: toCCW(cut.part),
              a: Math.abs(area(cut.part)),
              role: 'park',
              inr: shapeFit(cut.part).inradius,
              edge: distToRing(ringCenter(cut.part), ring),
            };
            host.ring = toCCW(cut.rest);
            host.a = Math.abs(area(cut.rest));
            host.inr = shapeFit(host.ring).inradius;
            host.edge = distToRing(ringCenter(host.ring), ring);
            cells.push(p);
            gotPark += p.a;
          }
        }
      }
    }
  }

  // ---- ②.5 住宅后院：最远离临街面的那一格定成草坪
  //
  // 上面按预算分绿地是"面积够不够"，这里补的是**位置对不对**：
  // 住宅的后院一定在背街那一侧，不能因为面积抽签抽到临街的第一格。
  // 判据用"到临街边的距离"而不是"到地块边界的距离" —— 后者把后院和前院
  // 算成一样远（两者都在地块边界上），选出来的可能是门口那块地。
  //
  // 两个前提：格子 ≥2（只有一格时把它变草地等于这块地不盖房了），
  // 且这块草地不超过总面积的 55%（后院不该比房子还大）。
  if (c.use === 'residential' && cells.length >= 2 && (c.streetEdges?.length ?? 0) > 0) {
    const edges = c.streetEdges ?? [];
    const rearDist = (cell: GroundCell): number => {
      const p = ringCenter(cell.ring);
      let d = Infinity;
      for (const e of edges) d = Math.min(d, Pt.distance(p, closestOnSegment(p, e.a, e.b)));
      return d;
    };
    const free = cells.filter((x) => x.role === 'pave' && x.a > 0.2);
    if (free.length >= 2) {
      const rear = free.reduce((p, q) => (rearDist(q) > rearDist(p) ? q : p));
      const sum = cells.reduce((s, x) => s + x.a, 0);
      if (rear.a < sum * 0.55) {
        rear.role = 'green';
        rear.gkind = 'lawn';
        gotGreen += rear.a;
      }
    }
  }

  // 建筑：剩下的格里，退线后还站得住的才是"建筑格"
  for (const cell of cells) {
    if (cell.role !== 'pave') continue;
    const plot = plotOf(cell);
    if (!plot) continue;
    cell.role = 'build';
    cell.plot = plot;
  }

  // 一格建筑都没剩下（地块太小 / 全被绿地停车吃掉）：把最大的一格改回建筑格。
  // 一个"地块"必须至少能放一栋楼，否则它在城市里就是个纯景观的空地。
  if (!cells.some((x) => x.role === 'build') && A > 1.6) {
    const cand = cells.filter((x) => x.role !== 'build').sort((p, q) => q.a - p.a)[0];
    if (cand) {
      const base = cleanRing(cand.ring);
      cand.role = 'build';
      cand.plot = cand.inr > 0.25 && base.length >= 3 ? insetRing(base, 0.12) : base;
      if (!cand.plot || cand.plot.length < 3) cand.plot = base;
    }
  }

  // ---- ③ 铺地：每格只铺一次（这就是"不会互相重叠"的保证）
  const buildMat = o.buildMat ?? o.hard;
  for (const cell of cells) {
    if (cell.role === 'green') {
      const mat = cell.gkind === 'bed' ? 'grassDark' : Rng.bool(0.28) ? 'grassDark' : 'grass';
      addSurface(c, 'cell_green', cell.ring, mat, 0.0086, false);
      c.green.push(cell.ring);
    } else if (cell.role === 'park') {
      cell.feat = addSurface(c, 'cell_park', cell.ring, 'asphaltLot', 0.0094, false);
      // 先登进"停车坪范围"：`scatter` 要躲开它。真排不下车位时这一格会改回
      // 硬地（见 fillParkCells），但那仍然不是能种树的草坪。
      (c.park ??= []).push(cell.ring);
    } else if (cell.role === 'build') {
      addSurface(c, 'cell_plot', cell.ring, buildMat, 0.0072, false);
    } else {
      addSurface(c, 'cell_pave', cell.ring, o.hard, 0.0072, false);
    }
  }

  // 建筑可落位范围：交给 `addSolid` / `clipBuilding` 这道出口闸，
  // 于是"楼只能长在建筑格里、并且已经退过线"是出口保证，不靠上层自觉。
  c.buildZones = cells.filter((x) => x.role === 'build' && x.plot).map((x) => x.plot!);

  return cells;
}

/**
 * 从一格地切出一块指定面积的子块（割线与主轴垂直，位置二分求解）。
 *
 * 用途：绿地 / 停车的面积预算是**整块区域**的比例，而格是按地块尺度切的 ——
 * 经常出现"整格都当绿地太多、一格都不给又太少"。这时候不该退回"贴一条草带"
 * （那是两层铺装），而应该**再切一刀**：割线位置二分到预算面积，
 * 切出来的两块各自还是一个完整子地块，地面照样只铺一次。
 *
 * 返回 `{part, rest}`；切不准（斜接退化 / 面积差太多）返回 null，调用方保持原样。
 */
function splitCellToArea(ring: Pt[], target: number): { part: Pt[]; rest: Pt[] } | null {
  const A = Math.abs(area(ring));
  if (ring.length < 3 || target <= 0.02 || target >= A * 0.8) return null;
  const ax = ringAxis(ring);
  // 割线垂直于主轴（沿短向切），切出来是两条顺长轴的带子
  const dir = new Pt(Math.cos(ax.ang + Math.PI / 2), Math.sin(ax.ang + Math.PI / 2));
  const nrm = new Pt(-dir.y, dir.x);
  const ctr = ringCenter(ring);
  const span = spanOf(ring);
  const at = (off: number) => bisectRing(ring, new Pt(ctr.x + nrm.x * off, ctr.y + nrm.y * off), dir);
  const areaOfA = (off: number) => {
    const c = at(off);
    return c ? Math.abs(area(c.a)) : NaN;
  };
  // 二分之前先扫一遍拿到"可用区间"：割线跑到环外时 `bisectRing` 会返回 null
  // （一瓣为空），直接拿 ±span/2 当端点必然 NaN。
  const span2 = span * 0.45;
  const N = 16;
  let lo = NaN;
  let hi = NaN;
  let prevOff = 0;
  let prevA = NaN;
  for (let i = 0; i <= N; i++) {
    const off = -span2 + (2 * span2 * i) / N;
    const a = areaOfA(off);
    if (!Number.isFinite(a)) continue;
    if (Number.isFinite(prevA) && (prevA - target) * (a - target) <= 0 && prevA !== a) {
      lo = prevOff;
      hi = off;
      break;
    }
    prevOff = off;
    prevA = a;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    const am = areaOfA(mid);
    if (!Number.isFinite(am)) return null;
    if ((am - target) * (areaOfA(lo) - target) > 0) lo = mid;
    else hi = mid;
  }
  const cut = at((lo + hi) / 2);
  if (!cut) return null;
  const aA = Math.abs(area(cut.a));
  const aB = Math.abs(area(cut.b));
  if (aA < 0.05 || aB < 0.05) return null;
  const partFirst = Math.abs(aA - target) <= Math.abs(aB - target);
  const part = partFirst ? cut.a : cut.b;
  const rest = partFirst ? cut.b : cut.a;
  if (Math.abs(area(part)) < target * 0.45) return null;
  return { part: cleanRing(part), rest: cleanRing(rest) };
}

/** 这一格该种几棵树（绿地格的植栽，只在绿地格里发生） */
function fillGreenCells(c: Ctx, cells: GroundCell[]): void {
  for (const cell of cells) {
    if (cell.role !== 'green' || !cell.gkind) continue;
    greenCellContent(c, cell.ring, cell.gkind, cell.a);
  }
}

/**
 * 在"建筑格"里摆楼。
 *
 * 处方顺序沿用各处原来的做法：塔楼 + 裙房（商务 / 商业 / 市政且地块够大）
 * → 行列式板楼（住宅）→ 通用处方（`bricksFor`）。
 * 与旧版唯一的区别只有输入：**这一格内缩出来的那块地**。
 * 于是"楼落在被定义为建筑的地块的内缩位置"是构造保证，不靠上层自觉。
 */
function massCells(c: Ctx, cells: GroundCell[], st: ParcelStyle, opt: { podium?: boolean } = {}): void {
  const build = cells
    .filter((x) => x.role === 'build' && x.plot && x.plot.length >= 3)
    .sort((p, q) => q.a - p.a);
  for (let i = 0; i < build.length; i++) {
    const cell = build[i];
    const plot = cell.plot!;
    const sub = subCtx(c, plot);
    if (!sub) continue;
    // 已经在建筑格的内缩范围里，出口闸不必再裁一层（否则会把裙房裁穿）
    sub.buildZones = undefined;
    const A = Math.abs(area(plot));
    // 三段式（塔楼 + 连续裙房 + 内院）只给**最大的一格**，而且按 `podiumChance`
    // 抽签：它是"这个街区的主楼"，不是每块地都要来一套。
    // 每一格都套一遍的话，一个街区会冒出十几片 1~2 层的小裙房，
    // 主力体量反而没了（实测降级体量占到 74%）。
    const wantPodium = opt.podium && i === 0 && A > 8 && Rng.bool(c.model.params.building.podiumChance);
    const bricks =
      (wantPodium ? towerPodium(sub, plot, A, st) : null) ??
      rowLayout(sub, plot, A, st) ??
      bricksFor(plot, A, st, c.use);
    // 记下**实际落位**的第一栋（裁过的那块），入口硬地要挂在它身上：
    // 拿处方轮廓去算门口，会画出"墙里伸出舌头"的那种半截铺装。
    let firstFp: Pt[] | null = null;
    for (const b of bricks) {
      // 落位再裁一次：处方函数（尤其是"切两半各放一栋"那一档）偶尔会把轮廓
      // 拉到格外的斜边上。裁到这一格的内缩范围，楼就一定在格里。
      const fp = clipBuilding(c, b.fp, 0.55, plot);
      if (!fp) continue;
      const h = b.hMin + Rng.float() * (b.hMax - b.hMin);
      // 入口硬地要挂在**实际立起来的那面墙**上（`addSolid` 会把锐角轮廓扶正，
      // 返回值才是场景里那个体块）；拿裁过的轮廓去算，铺装会悬在楼前空地上。
      const placed = addSolid(c, `parcel_${c.use}${b.low ? '_low' : ''}`, fp, h, b.wall, b.roof, b.kind);
      if (!placed) continue;
      c.footprints.push(placed);
      c.res.buildings++;
      if (!firstFp) firstFp = placed;
    }
    // 住宅的入户步道要一直走到**地块边**（临街那一侧），不能只到建筑格边——
    // 只到格边的话，它被前院草坪隔断，门口的铺装成了一块"孤岛"，
    // 俯视图上完全看不出"从人行道走回家"这条路。商业 / 工业仍然只铺门口那块
    // 硬地：它们的建筑格外面本来就是硬质前场，不需要再连一条带子。
    if (firstFp) {
      addEntrance(c, firstFp, c.use === 'residential' ? Array.from(c.block) : plot);
    }
  }
}


/**
 * 停车格 → 车位：只排车位线，**不铺沥青**。
 *
 * 沥青在 `groundPlan` 里已经铺过（那一格就是沥青格）。这里再铺一次就是
 * "同一块地面上两层沥青" —— 正是用户截图里那种"拼凑"的来源，所以禁止。
 */
function fillParkCells(c: Ctx, cells: GroundCell[]): void {
  let k = 0;
  for (const cell of cells) {
    if (cell.role !== 'park') continue;
    const ctr = ringCenter(cell.ring);
    // 出入口方向：格心 → 最近的地块边界点（车从这里开上街）
    let best: Pt | null = null;
    let bestD = Infinity;
    const n = c.block.length;
    for (let i = 0; i < n; i++) {
      const a = c.block[i];
      const b = c.block[(i + 1) % n];
      const q = closestOnSegment(ctr, a, b);
      const d = Pt.distance(ctr, q);
      if (d < bestD) {
        bestD = d;
        best = q;
      }
    }
    const bays = emitParkingRing(c, cell.ring, `cell_${k++}`, { w: 0.38, l: 0.75 }, true, best ? [ctr, best] : [ctr], {
      surface: false,
      y: 0.0098,
    });
    // 排不下车位：这一格不该是停车场。
    //
    // `groundPlan` 已经把这格铺成沥青了（一格一层，不能凭空消失），
    // 所以这里把它**改回硬地**：一块干净的院子 / 后院，比一个只有一两道
    // 车位线的空沥青场像样（用户图 1 / 图 2 说的就是这种）。
    if (bays === 0 && cell.feat) {
      cell.feat.mat = HARD_OF[c.use] ?? 'concrete';
      pushZoneDbg({ key: 'parkCellToHard', a: +cell.a.toFixed(2), use: c.use });
    }
  }
}

/**
 * 绿地块的植物配置。
 *
 * 只有草没有植物，从空中看还是一块绿纸片 —— 商业街和市政广场的绿化
 * 之所以读得出来，靠的是**树和绿篱的排布**，不是草坪的颜色。
 */
function greenCellContent(c: Ctx, ring: Pt[], kind: 'lawn' | 'grove' | 'bed', a: number): void {
  const g = toCCW(ring);
  const aM2 = a * 49;
  if (kind === 'grove') {
    // 树阵：行列树，最小间距 0.55 单位（≈3.9 m），最多 4×4
    const gb = bboxOf(g, c.f);
    const cols = clamp(Math.round(gb.w / 0.62), 2, 4);
    const rows = clamp(Math.round(gb.h / 0.62), 2, 4);
    const du = gb.w / cols;
    const dv = gb.h / rows;
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        const p = world(c.f, gb.u0 + du * (i + 0.5), gb.v0 + dv * (j + 0.5));
        if (!pointInPolygon(p, g)) continue;
        if (distToRing(p, g) < 0.1) continue;
        addProp(c, 'tree', p, 0.74 + Rng.float() * 0.2, Rng.float() * Math.PI * 2);
      }
    }
    return;
  }
  if (kind === 'bed') {
    // 种植池：**只放植物，不放绿篱**。
    //
    // 用户核对意见（本轮，图 2）：绿篱原来沿绿地内缩一圈铺开，读起来是
    // "每块草地自己也长了一圈围边"，和临街那道绿篱完全是两条线。
    // 现在的口径是：绿篱只属于**地块边界**（和栏杆同一条路径混排，
    // 见 boundaryFence / railings），内部绿地就只是绿地 ——
    // 平面上用几棵乔木点出层次，不再绕边。
    const gb = bboxOf(g, c.f);
    const n = aM2 > 200 ? 3 : aM2 > 90 ? 2 : 1;
    for (let i = 0; i < n; i++) {
      const uu = n === 1 ? 0.5 : 0.24 + (0.52 * i) / Math.max(1, n - 1);
      const vv = 0.3 + 0.4 * ((i * 7 + 3) % 5) / 4;
      const p = world(c.f, gb.u0 + gb.w * uu, gb.v0 + gb.h * vv);
      if (!pointInPolygon(p, g)) continue;
      if (distToRing(p, g) < 0.12) continue;
      addProp(c, i === 0 ? 'treeSmall' : 'tree', p, 0.8 + Rng.float() * 0.2, Rng.float() * Math.PI * 2);
    }
    return;
  }
  // 草坪 / 后院：树按面积铺开（约每 150 m² 一棵，最多 6 棵）
  //
  // 旧版是"大于 55 m² 放一棵、大于 190 m² 再补一棵"，等于不管多大都只有两棵 ——
  // 住宅的后院草坪动辄三四百平米，一片空草地上杵一棵树，读出来是"没建完"。
  // 按面积给的密度才符合"院内密"：院子是私人绿地，树本来就比街上密。
  const n = clamp(Math.round(aM2 / 150), aM2 > 55 ? 1 : 0, 6);
  if (n > 0) {
    const gb = bboxOf(g, c.f);
    const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
    const rows = Math.max(1, Math.ceil(n / cols));
    let put = 0;
    for (let i = 0; i < cols && put < n; i++) {
      for (let j = 0; j < rows && put < n; j++) {
        const uu = (i + 0.5) / cols + (Rng.float() - 0.5) * 0.18;
        const vv = (j + 0.5) / rows + (Rng.float() - 0.5) * 0.18;
        const p = world(c.f, gb.u0 + gb.w * uu, gb.v0 + gb.h * vv);
        if (!pointInPolygon(p, g)) continue;
        if (distToRing(p, g) < 0.12) continue;
        addProp(c, put === 0 ? 'tree' : Rng.bool(0.55) ? 'tree' : 'treeSmall', p, 0.8 + Rng.float() * 0.35, Rng.float() * Math.PI * 2);
        put++;
      }
    }
  }
}

/**
 * 绿化块的类型：草坪 / 种植池 / 树阵。
 *
 * 比例按用途给 —— 商务地块多树阵（硬底上点几棵树），商业地块多种植池，
 * 市政地块草坪为主（广场绿地），工业地块基本只有草坪。
 */
function pickGreenKind(use: LandUse, aM2: number): 'lawn' | 'bed' | 'grove' {
  if (aM2 < 90) return Rng.bool(0.3) ? 'bed' : 'lawn';
  switch (use) {
    case 'cbd':
      return Rng.bool(0.45) ? 'grove' : Rng.bool(0.3) ? 'bed' : 'lawn';
    case 'commercial':
      return Rng.bool(0.32) ? 'bed' : Rng.bool(0.4) ? 'grove' : 'lawn';
    case 'civic':
      return Rng.bool(0.3) ? 'grove' : Rng.bool(0.25) ? 'bed' : 'lawn';
    default:
      return Rng.bool(0.18) ? 'bed' : 'lawn';
  }
}

/** 点到环边界的最短距离（顶点/边都要算，凹角处才正确） */
function distToRing(p: Pt, ring: Pt[]): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L2 = dx * dx + dy * dy;
    if (L2 < 1e-12) continue;
    const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / L2, 0, 1);
    const d = Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
    if (d < best) best = d;
  }
  return best;
}

/** 环里最长的一条边（返回两端点） */
function longestEdge(ring: Pt[]): [Pt, Pt] | null {
  let best: [Pt, Pt] | null = null;
  let bestL = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const L = Pt.distance(a, b);
    if (L > bestL) {
      bestL = L;
      best = [a, b];
    }
  }
  return bestL > 1e-6 ? best : null;
}

function planResidential(c: Ctx) {
  // 住宅：绿地为主 + 硬质通道收边。
  //
  // 上一版是"整块铺草 → 按包围盒排板楼 → 楼间再贴一条内院绿带和一条混凝土通道
  // → 最后在角上摆一块后场停车"。内院绿带和通道都是**叠在草坪上的第二层**，
  // 停车又是另一个包围盒矩形，压着刚铺的绿带 —— 树还撒在车位线上。
  //
  // 现在只有一层：地块切成 1~8 个格，住宅的建筑格基底就是草坪（楼坐草地上，
  // 四周是散水），绿地格是草坪 + 树，停车格是沥青 + 车位线。
  const cells = groundPlan(c, {
    greenRatio: 0.34,
    parkRatio: 0.12,
    hard: 'concrete',
    buildMat: 'grass',
  });
  massCells(c, cells, PARCEL_STYLE.residential);
  fillGreenCells(c, cells);
  fillParkCells(c, cells);
}

function planIndustrial(c: Ctx) {
  // 工业：堆场必须硬质（重车碾压），但仍切出 13% 的绿化隔离带。
  //
  // 原来"主厂房 + 堆场 + 装卸院 + 货运停车"是四块各自算的包围盒矩形，
  // 互相之间叠着压着（装卸院的沥青压在堆场的混凝土上、车位压在堆场里）。
  // 现在堆场就是"硬地格"本身（砾石，不需要第二层），厂房是"建筑格"，
  // 货运停车是"停车格" —— 互斥，谁都不会盖到别人头上。
  const cells = groundPlan(c, {
    greenRatio: 0.13,
    parkRatio: 0.14,
    hard: 'gravel',
    buildMat: 'gravel',
  });
  massCells(c, cells, PARCEL_STYLE.industrial);
  fillGreenCells(c, cells);
  fillParkCells(c, cells);
  boundaryFence(c);
}

function planCivic(c: Ctx) {
  // 市政：硬质广场为主，四周切出 34% 草地（这类地块绿地率最高）
  //
  // 主楼、前广场、树列全部落在 groundPlan 划出来的格里：
  // 建筑格 → 主楼（可由塔楼 + 裙房三段式给出）；
  // 绿地格 → 草坪 + 树列；硬地格 → 广场（本来就是 paver，不需要再叠一层）。
  const cells = groundPlan(c, {
    greenRatio: 0.34,
    parkRatio: 0.04,
    hard: 'paver',
    buildMat: 'paver',
  });
  massCells(c, cells, PARCEL_STYLE.civic, { podium: true });
  fillGreenCells(c, cells);
  fillParkCells(c, cells);
  boundaryFence(c);
}

/**
 * 公园：**先切地块，园路就是切出来的那条缝**。
 *
 * 用户核对意见（本轮，图 4）："公园的道路是叠加的模型，不是划分了公园的地块，
 * 导致道路模型会超出公园范围 —— 建议分隔公园地块，并生成真的道路，
 * 公园草坪可以规划不同绿地类型。"
 *
 * 旧版的问题很清楚：园路是**按包围盒 `bb` 算出来的折线**（`bb.u0 + bb.w * t`），
 * 而 `bb` 是地块的外接矩形。张量地块几乎都是斜边多边形，外接矩形的端点必然
 * 在公园外面 —— 于是越斜的公园，园路戳出去的越多（截图里那条横穿马路的
 * 浅色带子就是这么来的）。而且它只是一条 `path`，跟"地块怎么划分"毫无关系，
 * 所以叠在草坪上像贴上去的一条胶带。
 *
 * 现在的口径（与街区切割、与 `groundPlan` 完全同一套）：
 *   ① 公园按 `tensorPartition` 递归二分出 1/2/4/8 个子地块 —— 每一刀的
 *      切线本身就是"园路", 它按构造落在公园内部（`bisectRing` 的割线是
 *      多边形内部的弦），所以**不可能超出公园范围**；
 *   ② 每个子地块定一种绿地类型：草坪（亮）/ 草甸（中）/ 密林（暗），
 *      另有一格当硬质小广场 —— 这就是"不同绿地类型"；
 *   ③ 铺装、园路都走 `clipPath(…, block)`，双保险。
 */
function planPark(c: Ctx) {
  const ring = Array.from(c.block);
  const A = Math.abs(area(ring));
  if (A < 1e-3) return;

  // 基底材质：公园不再铺一整块 `baseSurface(path_grass)`（那会跟下面的
  // 分格绿地叠在一起），但 `orphanGround` 还要用 `baseMat` 给"地块 − 可建区"
  // 的斜边残余补一层 —— 这里显式指定草色，免得它跟着用地类型变成硬地。
  c.baseMat = 'grass';

  // ---- ① 切分
  const depth = A > 320 ? 3 : A > 96 ? 2 : A > 26 ? 1 : 0;
  const part = tensorPartition(ring, {
    targetA: A / Math.max(1, 1 << depth),
    minA: Math.max(A * 0.05, 0.45),
    maxDepth: depth,
    ang0: parcelAngle(c),
    pattern: 'ortho',
  });

  type PKind = 'lawn' | 'meadow' | 'grove' | 'plaza';
  const cells: { ring: Pt[]; a: number; kind: PKind }[] = [];
  for (const r of part.parcels) {
    const a = Math.abs(area(r));
    if (a < 1e-3) continue;
    cells.push({ ring: toCCW(r), a, kind: 'lawn' });
  }
  if (cells.length === 0) cells.push({ ring: toCCW(ring), a: A, kind: 'lawn' });
  // 窄长 / 三角地块上张量切分可能一刀都切不出来（`minA` 卡住），
  // 那样整块公园只有一种绿 —— 用户要的是"草坪可以规划不同绿地类型"，
  // 所以这里补一刀对半切，保证至少两格。
  if (cells.length === 1 && A > 26) {
    const half = splitCellToArea(ring, A * 0.5);
    if (half && Math.abs(area(half.rest)) > 1) {
      cells.length = 0;
      cells.push({ ring: toCCW(half.part), a: Math.abs(area(half.part)), kind: 'lawn' });
      cells.push({ ring: toCCW(half.rest), a: Math.abs(area(half.rest)), kind: 'lawn' });
    }
  }

  // ---- ② 定类型
  //
  // 最大的那一格留作**大草坪**（公园得有一片能躺人的开阔草地），
  // 其余按面积从大到小轮换 草甸 / 密林，保证两种都出现；
  // 中心附近面积适中的一格改成硬质小广场（公园的铺装节点）。
  cells.sort((p, q) => q.a - p.a);
  const ctr = ringCenter(ring);
  for (let i = 1; i < cells.length; i++) {
    cells[i].kind = i % 2 === 1 ? 'meadow' : 'grove';
  }
  if (cells.length >= 2) cells[cells.length - 1].kind = 'grove';

  // 广场：**从中心那一格里再切一小块**，不是整格铺成硬地。
  //
  // 一格往往占公园的 1/4（公园大时一格就上千平米），整格铺 paver 从空中看
  // 是一片大广场，公园反而读不出"绿地"。所以按面积再切一刀，切出
  // 11%（6~22 u²）的一小块当铺装节点 —— 这也是"再下细分"的同一套口径，
  // 广场占据的那块地从草坪里让出来，而不是叠在草坪上。
  if (A > 30 && cells.length >= 2) {
    let best = -1;
    let bestD = Infinity;
    for (let i = 1; i < cells.length; i++) {
      const d = Pt.distance(ringCenter(cells[i].ring), ctr);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best > 0 && bestD < Math.sqrt(A) * 0.5) {
      const host = cells[best];
      const cut = splitCellToArea(host.ring, clamp(A * 0.11, 6, 22));
      if (cut) {
        cells.push({ ring: toCCW(cut.part), a: Math.abs(area(cut.part)), kind: 'plaza' });
        host.ring = toCCW(cut.rest);
        host.a = Math.abs(area(cut.rest));
      }
    }
  }

  // ---- ③ 铺地：每格铺一次（同 `groundPlan` 的口径，一格一层）
  const MAT_OF: Record<PKind, MatKey> = {
    lawn: 'grassLight',
    meadow: 'grass',
    grove: 'grassDark',
    plaza: 'paver',
  };
  for (const cell of cells) {
    addSurface(c, `park_${cell.kind}`, cell.ring, MAT_OF[cell.kind], cell.kind === 'plaza' ? 0.0088 : 0.0086, false);
  }

  // ---- ④ 园路：沿分割线铺（分割线是切分算出来的弦，天然在公园里）
  //
  // 一级缝（depth 0，把公园切成两半的那一刀）当主园路，宽 2.4 m；
  // 二级缝当支路，宽 1.7 m。数量封顶，免得小公园里铺出一张网格。
  const seams = part.seams
    .slice()
    .sort((p, q) => p.depth - q.depth || polyLen(q.pts) - polyLen(p.pts))
    .slice(0, 6);
  const bands: RoadBand[] = [];
  for (const s of seams) {
    if (polyLen(s.pts) < 0.6) continue;
    const top = s.depth === 0;
    bands.push({
      pts: s.pts,
      w: top ? 0.42 : 0.3,
      // 混凝土而不是砾石：园路铺在深浅三档绿之间，砾石那一档
      // （0.549/0.529/0.482）比草坪只亮一点点，俯视图上就是一条灰缝。
      mat: 'concrete',
      // 园路压在草地之上、车位线之下；比旧版的 0.014 低一档，
      // 因为它现在是"铺在地块上的一条路"，不是飘在最上面的胶带
      y: 0.0096,
      mark: false,
      name: 'park_path',
    });
  }
  drawSeams(c, bands);

  // ---- ⑤ 植栽：按绿地类型给
  for (const cell of cells) {
    if (cell.kind === 'plaza') {
      // 广场四角点几棵树，别让它读成一块空地
      const g = cell.ring;
      for (let i = 0; i < 4; i++) {
        const p = g[Math.floor((i / 4) * g.length) % g.length];
        if (!p) continue;
        const q = new Pt(ctr.x + (p.x - ctr.x) * 0.82, ctr.y + (p.y - ctr.y) * 0.82);
        if (pointInPolygon(q, g)) addProp(c, 'tree', q, 0.85, Rng.float() * Math.PI * 2);
      }
      continue;
    }
    if (cell.kind === 'grove') {
      greenCellContent(c, cell.ring, 'grove', cell.a);
      continue;
    }
    if (cell.kind === 'meadow') {
      // 草甸：散点小乔木 + 一丛灌木，密度比树阵低，读起来是"野一点的那块绿"
      const gb = bboxOf(cell.ring, c.f);
      const n = clamp(Math.round((cell.a * 49) / 420), 2, 7);
      for (let i = 0; i < n; i++) {
        const p = world(c.f, gb.u0 + gb.w * (0.2 + 0.6 * Rng.float()), gb.v0 + gb.h * (0.2 + 0.6 * Rng.float()));
        if (!pointInPolygon(p, cell.ring)) continue;
        if (distToRing(p, cell.ring) < 0.16) continue;
        addProp(c, Rng.bool(0.3) ? 'conifer' : 'treeSmall', p, 0.72 + Rng.float() * 0.25, Rng.float() * Math.PI * 2);
      }
      continue;
    }
    // 草坪：一两棵孤植树
    greenCellContent(c, cell.ring, 'lawn', cell.a);
  }
}

function planParkingUse(c: Ctx) {
  // 底色用草地而不是沥青：停车坪只铺"需求额度"那么大一块，
  // 余下的地方留草 + 树，整块地才读得出"车场 + 边缘绿化"，
  // 而不是一坨分不出边界的黑色沥青。
  baseSurface(c, 'grass');
  const { bb } = c;
  const alongU = bb.w >= bb.h;

  // 多边形候选区：直接拿地块轮廓（张量地块是斜边多边形，不套外接矩形）
  parkingRegion(c, Array.from(c.block), 'main', { w: 0.38, l: 0.75 });

  // 地块太窄时车位一条都排不下，铺一条中央通道，别让整块地读成"空草地"
  if (c.res.bays === 0) {
    const mid = alongU ? (bb.v0 + bb.v1) / 2 : (bb.u0 + bb.u1) / 2;
    const half = Math.max(0.3, (alongU ? bb.h : bb.w) * 0.14);
    const band = alongU
      ? rect(c.f, bb.u0 + 0.1, bb.u1 - 0.1, mid - half, mid + half)
      : rect(c.f, mid - half, mid + half, bb.v0 + 0.1, bb.v1 - 0.1);
    addSurface(c, 'parking_aisle', band, 'concrete', 0.012);
  }

  // 边缘绿化：沿地块轮廓内侧种一圈，不压车位
  //
  // 这里**不再**在地块中心放那棵"大树"：专用停车用地的停车坪几乎占满整块地，
  // 中心点落在沥青上，种出来就是"停车场正中间长了一棵树"。
  const ring = Array.from(c.block);
  const inset = insetRing(ring, 0.34);
  if (inset.length >= 3) {
    let carry = 0;
    const step = 1.7;
    for (let i = 0; i < inset.length; i++) {
      const a = inset[i];
      const b = inset[(i + 1) % inset.length];
      const len = Pt.distance(a, b);
      let t = carry;
      while (t < len) {
        const p = new Pt(a.x + ((b.x - a.x) * t) / len, a.y + ((b.y - a.y) * t) / len);
        // 只种在"没被停车坪吃掉"的地面上：车场占满整块地时，原来这一圈
        // 边缘树会全部落在车位线上（用户截图里的"停车场里长树"）。
        const inLot = (c.park ?? []).some((r) => pointInPolygon(p, r));
        if (!inLot && pointInPolygon(p, ring)) {
          addProp(c, 'tree', p, 0.85 + Rng.float() * 0.3, Rng.float() * 6.28, 'vegetation');
        }
        t += step + Rng.float() * 0.5;
      }
      carry = t - len;
    }
  }
  // 专用车场：围栏沿**地块边缘**封一圈（parkingFence），灯柱在停车坪里。
  // 地块里那块沥青坪不再单独围 —— 两圈栏杆叠在一起只会更乱。
  parkingFence(c);
}

/**
 * 停车场围栏开口宽度（米）：一条车道 + 两侧余量。
 * 参考图里停车场只有一个开口，车辆从街上直接拐进去 —— 不是"缺一整条边"。
 */
const PARK_OPEN_M = 5.4;

/**
 * 把一段直线里压到建筑的部分裁掉，返回剩下的那一段（最多两段，取较长的一段）。
 *
 * 停车坪围栏用：贴着楼的那一小段不能不要（要不然这条边就完全没有栏杆），
 * 也不能整段保留（栏杆横穿楼体）。所以先裁，裁完还剩一截才用。
 */
function trimByFootprint(seg: Pt[], fps: Pt[][]): Pt[] | null {
  const a = seg[0];
  const b = seg[1];
  const L = Pt.distance(a, b);
  if (L < 1e-6) return null;
  const ux = (b.x - a.x) / L;
  const uy = (b.y - a.y) / L;
  const steps = 24;
  let runStart = -1;
  let best: [number, number] | null = null;
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * L;
    const p = new Pt(a.x + ux * t, a.y + uy * t);
    const inside = fps.some((fp) => pointInPolygon(p, fp));
    if (!inside && runStart < 0) runStart = t;
    if (inside && runStart >= 0) {
      if (!best || t - runStart > best[1] - best[0]) best = [runStart, t];
      runStart = -1;
    }
  }
  if (runStart >= 0 && (!best || L - runStart > best[1] - best[0])) best = [runStart, L];
  if (!best) return null;
  const len = best[1] - best[0];
  if (len < 0.5) return null;
  return [
    new Pt(a.x + ux * best[0], a.y + uy * best[0]),
    new Pt(a.x + ux * best[1], a.y + uy * best[1]),
  ];
}

/**
 * 专用停车用地的围栏：沿**地块边界**封一圈，只在临街那条边留一个车道开口。
 *
 * 用户核对意见（图 3）："停车场围栏有的有有的没有，我希望全都有，
 * 并给停车场地块封一个边用来放栏杆"。
 * 所以专用车场不再只围那块沥青坪，而是**沿地块边缘整齐排一圈栏杆** ——
 * 围住的是整个车场（含边缘绿化带），读起来才像"一个被圈起来的停车场"。
 */
function parkingFence(c: Ctx) {
  const ring = Array.from(c.block);
  if (ring.length < 3) return;
  const openLen = u(PARK_OPEN_M);
  const paths: PathFeature[] = [];
  const props: PropFeature[] = [];

  // 开口开在最长边（通常就是临街面）的中段
  let li = 0;
  let longest = -1;
  for (let i = 0; i < ring.length; i++) {
    const L = Pt.distance(ring[i], ring[(i + 1) % ring.length]);
    if (L > longest) {
      longest = L;
      li = i;
    }
  }

  let k = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const L = Pt.distance(a, b);
    if (L < 0.4) continue;
    const at = (t: number) => new Pt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);

    let segs: Pt[][] = [[a, b]];
    if (i === li && L > openLen * 2.2) {
      const half = openLen / 2 / L;
      const t0 = Math.max(0.1, 0.5 - half);
      const t1 = Math.min(0.9, 0.5 + half);
      segs = [
        [a, at(t0)],
        [at(t1), b],
      ].filter((q) => Pt.distance(q[0], q[1]) > 0.25);
    }
    for (const seg of segs) {
      const mid = new Pt((seg[0].x + seg[1].x) / 2, (seg[0].y + seg[1].y) / 2);
      if (c.footprints.some((fp) => pointInPolygon(mid, fp))) continue;
      addRail({
        pts: seg,
        namePrefix: `parkfence_${i}_${k++}`,
        group: groupOf(c.use),
        y: 0.02,
        spec: RAIL_PARK,
        paths,
        props,
      });
    }
  }
  c.res.paths.push(...paths);
  c.res.props.push(...props);
}

/**
 * 禁建 / 保留地。
 *
 * 用户画的封闭区域（禁绘区）：**整块地照常参与规划**，只是不套用途分档。
 * 它有自己的内部路，内部路再把地块切成 2~4 个街坊，每个街坊各配内容。
 *
 * 顺序：
 *   ① 内部路：从等级最高的那条界边进，穿过地块中心从对边出去；
 *      面积够大就加一条垂直支路（"十"字或"丁"字）。
 *   ② 切分：用内部路的带状多边形做布尔差集 → 2~4 个子地块。
 *   ③ 内容：建筑沿内部路两侧退让排布，停车场接内部路，余下给草地 / 林地 / 广场。
 */
/**
 * 诊断钩子：`tmp/zone-*.ts` 这些脚本会先挂一个全局数组，再跑一次生成，
 * 从这里把"子街坊怎么切的、口袋分了多少、内部路几条多长"收回去。
 * 生产环境下全局变量不存在，`pushZoneDbg` 就是个空函数。
 */
function pushZoneDbg(row: Record<string, unknown>) {
  const dbg = (globalThis as any).__zoneDbg as Record<string, unknown>[] | undefined;
  if (dbg) dbg.push(row);
}

/**
 * 林地 / 公园：把一块闭合区域种成**树群**。
 *
 * 用的是"簇"模型，不是"撒点 + 噪声"：先布簇心（泊松盘，间距 = clusterScale），
 * 每个簇心周围按距离衰减种 6~24 棵，再补少量散生木。
 * 之所以不用噪声调制密度：噪声在均匀撒点上只是把密度抹匀，出来的还是"一片噪点"；
 * 簇模型才看得出"一丛一丛"和丛与丛之间的林窗 —— 也就是用户说的"树木群组"。
 *
 * 三层约束：
 *   ① 株距：全局泊松盘（occupancy grid），任意两棵不小于 r；
 *   ② 林窗：簇与簇之间天然留空，簇心的泊松半径决定林窗大小；
 *   ③ 林缘：靠近边界按"离边界的距离比例"概率拒绝，边缘逐渐变稀，不会切出刀切直边。
 *
 * 株数上限 1600/块：一株树在 GLB 里约 200 面，再往上单块地能吃掉 30 万面。
 */
function planForest(c: Ctx, mode: 'forest' | 'park') {
  const ring = Array.from(c.block);
  const a = Math.abs(area(ring));
  if (a < 0.06) return;
  const G = c.model.params.green;

  // 地被：林地深草、公园草。baseSurface 会把 baseMat 定下来，
  // 后面 orphanGround 补"地块 − 可建区"的残余面时沿用（否则会给森林镶一圈水泥）。
  baseSurface(c, mode === 'forest' ? 'grassDark' : 'grass');

  const areaM2 = a * 49;
  const perM2 = (G.treeDensity / 1000) * (mode === 'park' ? 0.45 : 1);
  const target = Math.min(1600, Math.round(areaM2 * perM2));
  if (target <= 0) return;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of ring) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const randIn = () => new Pt(minX + Rng.float() * (maxX - minX), minY + Rng.float() * (maxY - minY));

  // 林缘：按"离边界多远"给通过概率（等于把直边磨成渐变林缘）
  const feather = u(G.edgeFeather);
  const nearEdge = (p: Pt) => feather > 1e-6 && withinRing(p, ring, feather * Rng.float());

  // ---- 占用栅格：cell = r/√2 时每格最多一个点，判重只看周围 5×5 格
  //
  // 株距**不按总面积均摊**，而是跟着簇尺度走（簇半径的 1/3）。
  // 早先按"面积/目标株数"反推株距，等于强制把树均匀铺满整块地 ——
  // 簇再怎么做也糊成一片。现在株距小（簇内密）、簇间距大（簇间空），
  // 疏密对比才出得来；总株数由 target 单独封顶。
  const rc = u(Math.max(G.clusterScale, 8));
  const rU = rc * 0.14;
  const cell = rU / Math.SQRT2;
  const occ = new Map<string, Pt[]>();
  const tooClose = (p: Pt, r: number): boolean => {
    const gx = Math.floor(p.x / cell);
    const gy = Math.floor(p.y / cell);
    for (let i = -2; i <= 2; i++) {
      for (let j = -2; j <= 2; j++) {
        const arr = occ.get(`${gx + i}:${gy + j}`);
        if (!arr) continue;
        for (const q of arr) if (Pt.distance(p, q) < r) return true;
      }
    }
    return false;
  };
  const occupy = (p: Pt) => {
    const k = `${Math.floor(p.x / cell)}:${Math.floor(p.y / cell)}`;
    const arr = occ.get(k);
    if (arr) arr.push(p);
    else occ.set(k, [p]);
  };

  let placed = 0;
  const plant = (p: Pt, r = rU): boolean => {
    if (placed >= target) return false;
    if (!pointInPolygon(p, ring)) return false;
    if (nearEdge(p)) return false;
    if (tooClose(p, r)) return false;
    const t = Rng.float();
    const kind: PropKind = t < G.pineRatio ? 'conifer' : t < G.pineRatio + G.shrubRatio ? 'treeSmall' : 'tree';
    addProp(c, kind, p, 0.8 + Rng.float() * (kind === 'tree' ? 0.6 : 0.35), Rng.float() * 6.283, 'vegetation');
    occupy(p);
    placed++;
    return true;
  };

  // ---- ① 簇心：泊松盘，间距 = clusterScale
  const centers: Pt[] = [];
  const maxCenters = Math.max(1, Math.min(220, Math.round(a / Math.max(6, G.clusterScale * 0.09))));
  for (let k = 0; k < maxCenters * 30 && centers.length < maxCenters; k++) {
    const p = randIn();
    if (!pointInPolygon(p, ring)) continue;
    if (nearEdge(p)) continue;
    if (centers.some((q) => Pt.distance(p, q) < rc)) continue;
    centers.push(p);
  }

  // ---- ② 每簇种多少棵：由**总数目标反推**，不是写死 8~26
  //
  // 写死每簇棵数时，"密度"这个参数其实是废的：株数 = 簇数 × 写死的常数，
  // 调 treeDensity 只会挪动 target 上限，实际种下去的还是那么多
  // （34 m 档实测 266 棵 / 目标 436，永远差 40%）。
  // 现在先留出散生木的份额，剩下的按簇数均分，每簇再乘一个 0.45~1.55 的抖动 ——
  // 簇有大小之分，但总数是密度说了算。
  const singleShare = mode === 'park' ? 0.3 : 0.12;
  const perCluster = Math.max(
    3,
    Math.round((target * (1 - singleShare)) / Math.max(1, centers.length))
  );
  const clusterR = rc * 0.5;
  for (const ctr of centers) {
    const n = Math.max(3, Math.round(perCluster * (0.45 + Rng.float() * 1.1)));
    for (let k = 0, tries = 0; k < n && tries < n * 14; tries++) {
      const ang = Rng.float() * Math.PI * 2;
      const rad = clusterR * Math.sqrt(Rng.float());
      const p = new Pt(ctr.x + Math.cos(ang) * rad, ctr.y + Math.sin(ang) * rad);
      // 密度向外衰减：0 环中心必中，1 环边缘只剩 35%
      if (Rng.float() > 1 - 0.65 * (rad / clusterR)) continue;
      if (plant(p)) k++;
    }
  }

  // ---- ③ 散生木：只补 12%（公园 30%）。散生木一多，簇与簇之间就被填满，
  // 又回到"均匀撒点"的观感 —— 这一项是簇能不能被看出来的关键。
  const singles = Math.round(target * singleShare);
  for (let k = 0, tries = 0; k < singles && tries < singles * 20; tries++) {
    if (plant(randIn())) k++;
  }

  if (mode === 'park') {
    const nb = Math.max(1, Math.min(6, Math.round(a * 0.05)));
    const ctr = ringCenter(ring);
    for (let i = 0; i < nb; i++) {
      const ang = (i / nb) * Math.PI * 2 + Rng.float();
      const rad = Math.sqrt(a) * (0.2 + Rng.float() * 0.25);
      const p = new Pt(ctr.x + Math.cos(ang) * rad, ctr.y + Math.sin(ang) * rad);
      if (pointInPolygon(p, ring) && !withinRing(p, ring, u(2))) addProp(c, 'bench', p, 1, ang, 'furniture');
    }
  }

  pushZoneDbg({
    key: `forest:${mode}`,
    blockA: a,
    trees: placed,
    target,
    clusters: centers.length,
    rM: +(rU * 7).toFixed(1),
  });
}


/**
 * 禁建区 = 用户自建模型的场地。
 *
 * 这里**不排任何城市内容**：没有建筑、没有内部路、没有地块分割、没有绿地率预算。
 * 理由很直接 —— 用户要在这块地上放自己的模型，任何自动生成的东西都是要拆掉的垃圾：
 *   · 建筑挡视线、挡模型；
 *   · 内部路把场地切成碎块，模型的落位就没有一块完整的平面；
 *   · 环路 / 街巷 / 停车位这些更只是在"替用户做决定"。
 *
 * 剩下只做一件事：
 *   内收红线后的沥青硬地。`c.block` 本身就是地块轮廓按红线内缩（insetForEdge）
 *      之后的结果，也就是建筑红线以内、人行道以外的那块地；直接铺满即可。
 *
 * 曾经还有第二件事：沿整圈红线一道围栏，用来标记"这块地是用户的场地"。
 * 现在去掉了 —— 自建场地的边界由**路缘石高差 + 铺装材质变化**已经读得出来，
 * 再加一圈 1.35 m 的栏杆，从空中看就是大空地上一条莫名其妙的墙，
 * 而且它挡视线、在剖面图上还得单独解释。用户明确要求移除。
 *
 * 停车 / 行道树 / 铺装分带一律不给：这些都是内容的"默认答案"，而这里没有默认答案。
 */
function planZonePad(c: Ctx) {
  const ring = Array.from(c.block);
  const A = Math.abs(area(ring));

  // 内收 2.5 m 铺沥青，露出来的一圈混凝土读作路缘石 / 场地边缘。
  //
  // 内收必须用 `offsetRing`（两线求交）而不是 `insetRing`（Polygon.shrink）：
  // shrink 逐边平移再求交，在**凹角**上会自交 —— L 形禁区上实测退化成一个
  // 1/4 大的矩形，于是整块地上只剩一角沥青、其余全裸露成混凝土广场。
  // 内收结果还要复核：自交、或面积掉了一半以上，就当内收失败。
  const sg = area(ring) < 0 ? -1 : 1;
  const inner = offsetRing(ring, sg * u(2.5));
  const okInset = inner.length >= 3 && simpleRing(inner) && Math.abs(area(inner)) > A * 0.5;

  // 用"先铺满、再叠一块内收的"而不是画一条环带：环带要拼内圈 + 反向外圈，
  // 凹轮廓上必自交（服务环路那轮踩过），嵌套两块面则永远是良性的。
  baseSurface(c, okInset ? 'concrete' : 'asphalt');
  if (okInset) addSurface(c, 'zone_pad', inner, 'asphalt', 0.0065, false);
}

// ---------------------------------------------------------------- 街区 → 小地块
//
// 这一层解决的是"一个街区只有一栋楼"。原来的管线是：
//   patch（一个街区） → 一个用途 → 一次 planCbd / planCommercial / planResidential。
// 街区中位面积 112 单位²（≈74 m 见方），而 planCbd 会在这个尺寸里摆
// 主塔（短向 46%）+ 裙房（塔宽 1.64 倍）+ 副楼，三块体量互相咬合，
// 俯视图上读成"一整块巨型屋顶"；基底又是 stonePave / paver 的整片硬质。
// 实测：绿地 6.4%、屋面 15%、硬质 33%、每街区 1 栋楼。
//
// 参考城市的同一部位是：绿地 35%、屋面 28%、硬质 19%、每街区 4~6 栋小楼。
// 差别不在参数，在**有没有地块这一层**。
//
// 所以这里补上：街区 → 张量分割 → 若干地块 → 每个地块一栋楼 + 院子草坪。
// 禁建区内部（planReserved）早就走这条路，这里是把同一条路推广到全城。

/** 会被切成小地块的用途。公园 / 绿地 / 停车场 / 禁建区不切 —— 它们本来就是整块的。 */
const PARCEL_USES = new Set<LandUse>(['cbd', 'commercial', 'residential', 'industrial', 'civic']);

interface ParcelStyle {
  hMin: number;
  hMax: number;
  wall: MatKey;
  roof: MatKey;
  kind: SolidKind;
  /** 建筑占地块面积的比例 */
  cover: number;
  /** 临街一侧退出来的硬质前场深度占地块进深的比例（0 = 不设前场，全是草坪） */
  fore: number;
}

const PARCEL_STYLE: Record<string, ParcelStyle> = {
  // 屋面统一走浅色系：参考城市的俯视图里楼是"浅灰板 + 深色细描边"，
  // 深色屋面（roofDark / roofFlat）会让整片街区读成一片沥青，看不出"这是楼"。
  cbd: { hMin: 3.2, hMax: 7.0, wall: 'wallGlass', roof: 'roofLight', kind: 'tower', cover: 0.42, fore: 0.18 },
  commercial: { hMin: 1.7, hMax: 3.0, wall: 'wallPanel', roof: 'roofLight', kind: 'slab', cover: 0.46, fore: 0.2 },
  residential: { hMin: 2.1, hMax: 3.6, wall: 'wallConcrete', roof: 'roofLight', kind: 'house', cover: 0.4, fore: 0 },
  industrial: { hMin: 1.2, hMax: 2.4, wall: 'wallPanel', roof: 'roofMetal', kind: 'warehouse', cover: 0.5, fore: 0.24 },
  civic: { hMin: 1.5, hMax: 2.9, wall: 'wallStone', roof: 'roofLight', kind: 'slab', cover: 0.4, fore: 0.24 },
};

/**
 * 禁区边 → 走向角。给"贴着禁区的地块"用：地块分割线跟着禁区走向，
 * 而不是跟着全城主轴向 —— 这样禁区边上的地块是**平行于禁区**的条带，
 * 而不是被城市网格斜着切一刀。
 *
 * 键是边的坐标键（与 road/system 的 edgeKey 同一套取整方式）。
 * 按 Model 缓存：一次生成里几十个地块都要查同一张表。
 */
const zoneEdgeCache = new WeakMap<Model, Map<string, number>>();

function edgeKeyOf(a: Pt, b: Pt): string {
  const k1 = `${Math.round(a.x * 100)},${Math.round(a.y * 100)}`;
  const k2 = `${Math.round(b.x * 100)},${Math.round(b.y * 100)}`;
  return k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
}

function zoneEdgeAngles(m: Model): Map<string, number> {
  const hit = zoneEdgeCache.get(m);
  if (hit) return hit;
  const map = new Map<string, number>();
  for (const p of m.patches) {
    if (!p.blocked) continue;
    const ring = Array.from(p.shape);
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      // 短于 10 m 的边没有"走向"，收了只会让半条街区歪掉
      if (Pt.distance(a, b) < 1.4) continue;
      map.set(edgeKeyOf(a, b), Math.atan2(b.y - a.y, b.x - a.x));
    }
  }
  zoneEdgeCache.set(m, map);
  return map;
}

/**
 * 这个街区的分割方向。
 *
 * 贴禁区的街区：取"与禁区共用的那条最长边"的走向 —— 地块沿禁区排条。
 * 其它街区：沿用全城主轴向（`cityAxis`），保证远处肌理不碎。
 */
function parcelAngle(c: Ctx): number {
  const axis = c.model.cityAxis ?? new Pt(1, 0);
  const zoneEdges = zoneEdgeAngles(c.model);
  if (zoneEdges.size === 0) return Math.atan2(axis.y, axis.x);

  const ring = Array.from(c.patch.shape);
  let best = 0;
  let ang: number | null = null;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const L = Pt.distance(a, b);
    if (L <= best) continue;
    const z = zoneEdges.get(edgeKeyOf(a, b));
    if (z === undefined) continue;
    best = L;
    ang = z;
  }
  return ang ?? Math.atan2(axis.y, axis.x);
}

/**
 * 街区切成小地块。成功返回 true（此后这个街区就归本函数管，不再走用途层）。
 *
 * 顺序刻意写成"先算分割、再落面"：切分不改任何状态，切不动（<2 块）时
 * 直接交回原管线 —— 若先铺了草坪基底再退出，后面的 planCbd 又铺一层
 * stonePave 在同一个 y 上，会 z-fighting。
 *
 * 切分规则（本轮重写，见 `frontagePartition`）：按**沿街面宽**排布，
 * 进深超限再横切一刀。旧的"按面积递归二分"只约束面积，能切出 60×7 m 的
 * 窄条 —— 退线完就是一栋超长的薄楼，这就是用户说的"不合理"。
 */
function planParcels(c: Ctx, targetA: number, depthMax = 2): boolean {
  const ring = Array.from(c.block);
  if (ring.length < 3) return false;
  const A = Math.abs(area(ring));
  // 面积太小（≈ 40 m 见方以下）切了也没意义：一块地本来就该是一栋楼
  if (A < 24) return false;
  const BP = c.model.params.block;

  // 沿街面宽按用途微调：工业地块大、住宅地块窄，这是城市里最稳的一条规律。
  const FRONTAGE_K: Partial<Record<LandUse, number>> = {
    cbd: 1.25,
    commercial: 1.1,
    civic: 1.15,
    industrial: 1.4,
  };
  // 进深上限（米）：超过就在中间横切一刀，切出前排 / 后排。
  // 住宅 40 m 对应"一个院落进深"；工业厂房要 55 m 才排得下。
  const MAX_DEPTH_M: Partial<Record<LandUse, number>> = {
    cbd: 42,
    commercial: 38,
    civic: 40,
    industrial: 55,
  };
  const frontage = u(BP.parcelPitchM * (FRONTAGE_K[c.use] ?? 1));
  const maxDepth = u(MAX_DEPTH_M[c.use] ?? 40);

  // 面板/单块覆盖给的还是"地块目标面积"：换回等效面宽，保持那只旋钮的手感。
  // （选中地块 → 切成 N 块 → targetA = A/N，这里再开方成面宽。）
  const ov = c.patch.override?.parcelTargetA;
  const effFrontage = ov && ov > 2 ? Math.max(Math.sqrt(ov), u(14)) : frontage;

  // 按权重抽切分模式；选中地块里单块指定了模式时直接用它。
  const pattern = pickParcelPattern(c);
  c.patch.usedPattern = pattern;

  // 起刀方向与抖动：**四种模式必须真的走出四种形态**，否则面板上那四个按钮
  // 就是四个长得一样的摆设（上一版 ortho / field 用的是同一个角度和同一个抖动，
  // 只是名字不同）。
  //
  //   ortho  严格沿街区主轴等分，抖 0       → 尺规方格，最规整
  //   field  沿街区主轴，但抖 ±15%、进深上限收紧 → 跟着街区走但肌理更碎（长条街区里
  //          会自己多切一刀，读起来像"顺着街道自然长出来的"）
  //   diag   主轴 + 45°                     → 斜街
  //   free   主轴，抖 ±30%                   → 不规则地块
  //
  // 所有模式都锚在**街区主轴**（= 一条真的城市道路）上：
  // 拿城市全局轴或张量场采样去切，街区是斜的时候地块边界与街区边界夹角 20~40°，
  // 每一块地都变成楔形，退线后楼是斜的、巷道斜穿街区 —— 用户说的"张量场模式对
  // 街区内路和建筑的形态影响不正确"就是这个。
  //
  // 主轴取 `streetAxis`（临街边）而不是 `blockAxis`（最长边）：贴着禁建区的
  // 街区，最长边常常是禁区轮廓，按它切就会顺着禁区切出一溜楔形碎块。
  const baseAng = streetAxis(c, ring);
  const ang0 = pattern === 'diag' ? baseAng + Math.PI / 4 : baseAng;
  const jitter = pattern === 'free' ? 0.3 : pattern === 'field' ? 0.15 : pattern === 'diag' ? 0.16 : 0;
  // field 的进深上限收紧一档：它要的是"顺着街道长出来的一排排浅院子"
  const depthCap = pattern === 'field' ? maxDepth * 0.78 : maxDepth;

  const part = frontagePartition(ring, {
    frontage: effFrontage,
    maxDepth: depthCap,
    ang0,
    jitter,
    count: ov && ov > 2 ? A / ov : undefined,
    minA: Math.max(A * 0.02, 0.6),
  });
  if (part.parcels.length < 2) return false;

  if (typeof process !== 'undefined' && process.env.PARCEL_DEBUG) {
    const sizes = part.parcels.map((p) => Math.abs(area(p)).toFixed(1)).join('/');
    console.log(
      `[parcel] A=${A.toFixed(0)} 面宽=${(effFrontage * 7).toFixed(0)}m 进深<=${(maxDepth * 7).toFixed(0)}m ${pattern} 块数=${part.parcels.length} 线=${part.seams.length} 面积=${sizes}`
    );
  }

  // 街区基底：**只记材质，不铺面**。它只剩一个用途：给 `orphanGround`
  // （街区轮廓与可建区之间的残片）取材质。
  // 基底材质按用途给：**只有住宅是草**，其余用途是硬质。
  //
  // 原来只写了 residential 一条，其余全落在 `?? 'grass'` 上 —— 于是商业 / 商务
  // 街区里"街区轮廓 − 可建区"的那圈红线残片（`orphanGround` 用它取材质）
  // 全被铺成草，贴着禁建区那一圈尤其明显：一条绿色带顺着禁区斜边长出来，
  // 夹在禁区和铺装之间，读起来既不整齐也不像隔离带。
  const BASE_OF_USE: Partial<Record<LandUse, MatKey>> = {
    residential: 'grass',
    cbd: 'stonePave',
    commercial: 'paver',
    civic: 'paver',
    industrial: 'gravel',
  };
  c.baseMat = BASE_OF_USE[c.use] ?? 'grass';

  // ---- 街区内部的巷
  //
  // 两级，但两级都不是"马路"：
  //   · depth 0（沿街方向的分界线，从临街边切进街区）→ 沥青巷 3.5~5 m，
  //     带中心虚线：它是真正接进地块的那条路；
  //   · depth 1（进深方向的分界线，前后排之间）→ **混凝土巷** 3 m，不带标线：
  //     它是后巷 / 服务通道，不是车行道。
  //
  // 旧版把所有缝都铺成沥青 + 一级带虚线，于是 74 m 见方的街区里长出
  // 三四条"小马路"，读起来像被道路切碎的地块群。真实的街区内部只有
  // 一条能进车的巷，其余是院墙、绿篱、铺装缝。
  const P = c.model.params.block;
  if (part.seams.length > 0) {
    // 让距：和道路同一条规则。
    //
    // `road/system.ts` 里已经规定"落在禁区让距带里的路段一律不铺"，所以车行道
    // 会干净地停在禁区外一圈。但**地块缝**走的是这里，之前没接这条规则：贴着
    // 禁区的街区被切分后，depth 0 的那条沥青巷正好压在禁区边上，读出来就是
    // "一条路沿着禁区跑"—— 车行道让开了、巷子没让，整体看上去反而更乱。
    const pad = u(c.model.params.block.zoneAvoidPadM);
    const zones = c.model.params.block.zoneAvoid ? c.model.zonePolys : [];
    const nearZone = (pts: Pt[]): boolean => {
      if (zones.length === 0) return false;
      for (let i = 0; i + 1 < pts.length; i++) {
        const mid = new Pt((pts[i].x + pts[i + 1].x) / 2, (pts[i].y + pts[i + 1].y) / 2);
        for (const ring of zones) if (distToRing(mid, ring) < pad * 0.75) return true;
      }
      return false;
    };
    const seams = part.seams.filter((s) => !nearZone(s.pts));
    drawSeams(
      c,
      seams.map((s) => {
        const top = s.depth === 0;
        return {
          pts: s.pts,
          w: u(top ? P.seamWideM : P.seamNarrowM),
          mat: (top ? 'asphalt' : 'concrete') as MatKey,
          y: top ? 0.012 : 0.0118,
          mark: top,
          name: top ? 'zone_road' : 'zone_lane',
        };
      })
    );
  }

  // ---- 每个地块：把"临街边"一起传下去
  //
  // 没有这一步，地块内部的地面只能按张量二分碰运气决定谁贴街，
  // 实测沿路缘 1.8 m 内侧 23% 是绿地、10% 是停车坪。
  //
  // 禁区让距带一并传下去：贴禁区的那条边不算临街（见 `streetEdgesOf`）。
  const zonePads = c.model.params.block.zoneAvoid ? c.model.zonePolys : [];
  const zonePadW = u(c.model.params.block.zoneAvoidPadM);
  let painted = 0;
  for (const p of part.parcels) {
    if (Math.abs(area(p)) < Math.max(A * 0.03, 0.5)) continue;
    const sub = subCtx(c, p);
    if (!sub) continue;
    sub.streetEdges = streetEdgesOf(p, ring, zonePads, zonePadW);
    planParcel(sub);
    painted++;
  }
  if (painted > 0) c.frontaged = true;
  return true;
}

/**
 * 一个地块的内容：**一栋**楼 + 院子草坪 + 入户路 + 树下。
 *
 * 硬质只出现在两处：楼外沿散水（`groundLayers` 那层 APRON）和临街前场。
 * 其余全是草坪 —— 这是"绿地 6% → 30%"的唯一来源，
 * 靠缩小建筑或加密树是做不到的。
 */
// ---------------------------------------------------------------- 建筑形状体检
//
// 张量切出来的地块是**任意四边形**（顶角 40° 的楔形、20 m × 4 m 的窄条都常见）。
// 原来的做法是"把地块环内缩到 0.4 倍面积，然后按用途给它 3~7 个单位的高度"，
// 于是同一套规则产出两类畸形建筑：
//   · 纸片楼：窄条地块内缩后是 1.5 m 进深、20 m 长的薄片，却盖了六层；
//   · 锐角楼：楔形地块内缩后仍保留 30° 的尖角，3D 里是一片立起来的刀。
// 这两类都不是"参数没调好"，是**缺少形状约束** —— 地块能切出来，不等于能盖楼。
//
// 所以这里补三道闸（顺序有讲究，越靠前越轻）：
//   ① 倒角去尖：把 < 62° 的角削平，形状不动、面积少几个百分点，能救就救；
//   ② 二次切分：进深还是不够但面积够大 → 沿长轴垂直切一刀，各放一栋小楼；
//   ③ 降级配套：最后一档，改放 1~2 层的沿街商业（retail）或裙房（podium），
//      宁矮勿尖 —— 真实城市里这种细长地块就是沿街小商业，不是十几层的楼。

/** 进深（内切半径）下限，米。住宅进深 9~14 m，低于 8 m 摆不下房间 */
const MIN_DEPTH_M = 8.0;
/** 内角下限，度。再尖就是"锐角楼" */
const MIN_ANGLE_DEG = 62;
/** 各类型的最小占地，m² */
const MIN_AREA_M2: Record<string, number> = {
  tower: 260,
  slab: 170,
  house: 80,
  warehouse: 240,
  podium: 120,
  retail: 55,
};

/** 地块形状体检结果 */
interface ShapeFit {
  /** 世界单位² */
  area: number;
  /** 内切半径近似 2A/P（世界单位） */
  inradius: number;
  /** 最小内角（度） */
  minAngle: number;
  /** 最短边（世界单位） */
  minEdge: number;
}

function shapeFit(ring: Pt[]): ShapeFit {
  const n = ring.length;
  if (n < 3) return { area: 0, inradius: 0, minAngle: 0, minEdge: 0 };
  let per = 0;
  let minEdge = Infinity;
  for (let i = 0; i < n; i++) {
    const L = Pt.distance(ring[i], ring[(i + 1) % n]);
    per += L;
    if (L < minEdge) minEdge = L;
  }
  const A = Math.abs(area(ring));
  const inradius = per > 1e-6 ? (2 * A) / per : 0;
  const sg = area(ring) > 0 ? 1 : -1;
  let minAngle = 180;
  for (let i = 0; i < n; i++) {
    const p = ring[(i + n - 1) % n];
    const q = ring[i];
    const r = ring[(i + 1) % n];
    const ax = p.x - q.x;
    const ay = p.y - q.y;
    const bx = r.x - q.x;
    const by = r.y - q.y;
    const la = Math.hypot(ax, ay);
    const lb = Math.hypot(bx, by);
    if (la < 1e-6 || lb < 1e-6) continue;
    const dot = (ax * bx + ay * by) / (la * lb);
    const base = (Math.acos(clamp(dot, -1, 1)) * 180) / Math.PI;
    // 叉积定凸凹：凹点（reflex）的真实内角是 360 − base，
    // 不区分的话每个凹点都会被误判成"锐角"，于是到处乱倒角。
    const cross = ax * by - ay * bx;
    const ang = cross * sg > 0 ? base : 360 - base;
    if (ang < minAngle) minAngle = ang;
  }
  return { area: A, inradius, minAngle, minEdge };
}

/**
 * 削掉过尖的角（chamfer）。尖角替换成一条短边，形状不动、面积只少几个点。
 * 削口长度取 `min(bevelMax, 0.42 × 相邻较短边)`，保证相邻两个削口不会互相吃掉。
 */
function bevelSharpCorners(ring: Pt[], minAngleDeg: number, bevelMax: number): Pt[] | null {
  const n = ring.length;
  if (n < 3) return null;
  const sg = area(ring) > 0 ? 1 : -1;
  const out: Pt[] = [];
  let cut = 0;
  for (let i = 0; i < n; i++) {
    const p = ring[(i + n - 1) % n];
    const q = ring[i];
    const r = ring[(i + 1) % n];
    const ax = p.x - q.x;
    const ay = p.y - q.y;
    const bx = r.x - q.x;
    const by = r.y - q.y;
    const la = Math.hypot(ax, ay);
    const lb = Math.hypot(bx, by);
    if (la < 1e-6 || lb < 1e-6) {
      out.push(q);
      continue;
    }
    const dot = (ax * bx + ay * by) / (la * lb);
    const base = (Math.acos(clamp(dot, -1, 1)) * 180) / Math.PI;
    const cross = ax * by - ay * bx;
    const ang = cross * sg > 0 ? base : 360 - base;
    if (ang >= minAngleDeg) {
      out.push(q);
      continue;
    }
    const t = Math.min(bevelMax, la * 0.42, lb * 0.42);
    if (t < 1e-3) {
      out.push(q);
      continue;
    }
    cut++;
    out.push(new Pt(q.x + (ax * t) / la, q.y + (ay * t) / la));
    out.push(new Pt(q.x + (bx * t) / lb, q.y + (by * t) / lb));
  }
  return cut > 0 && out.length >= 3 ? out : null;
}

/**
 * 沿长轴垂直方向把地块切成两半。
 *
 * 为什么切"垂直长轴"而不是"沿长轴"：窄条地块的问题在**长度**，
 * 沿长轴切只会得到两条更窄的条（更糟）；横着切一刀，每半都变短，
 * 长宽比才回到能盖房子的范围。
 */
function splitAcrossLongAxis(ring: Pt[]): Pt[][] {
  const c = ringCenter(ring);
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of ring) {
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  // 最大特征值对应的特征向量 = 长轴
  const tr = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const l1 = tr / 2 + Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  let ax = sxy;
  let ay = l1 - sxx;
  if (Math.hypot(ax, ay) < 1e-9) {
    ax = sxx >= syy ? 1 : 0;
    ay = sxx >= syy ? 0 : 1;
  }
  const L = Math.hypot(ax, ay);
  ax /= L;
  ay /= L;

  const R = 400;
  const px = -ay;
  const py = ax;
  const halfPlane = (sign: number): Pt[] => [
    new Pt(c.x + px * R, c.y + py * R),
    new Pt(c.x - px * R, c.y - py * R),
    new Pt(c.x - px * R + ax * sign * R * 2, c.y - py * R + ay * sign * R * 2),
    new Pt(c.x + px * R + ax * sign * R * 2, c.y + py * R + ay * sign * R * 2),
  ];
  const pick = (parts: Pt[][]): Pt[] | null =>
    parts.length === 0 ? null : parts.reduce((x, y) => (Math.abs(area(x)) >= Math.abs(area(y)) ? x : y));
  const a = pick(intersect(ring, halfPlane(1), 0.02));
  const b = pick(intersect(ring, halfPlane(-1), 0.02));
  if (!a || !b) return [];
  if (Math.abs(area(a)) < 1e-3 || Math.abs(area(b)) < 1e-3) return [];
  return [a, b];
}

/** 一栋楼的"处方"：轮廓 + 类型 + 高度区间 */
interface Brick {
  fp: Pt[];
  kind: SolidKind;
  wall: MatKey;
  roof: MatKey;
  hMin: number;
  hMax: number;
  /** 降级来的（配套商业 / 裙房），统计与调试用 */
  low: boolean;
}

/** 地块环 → 内缩到目标占地面积的轮廓，并与地块求交收边（原逻辑，抽出来复用） */
function shrinkFootprint(ring: Pt[], A: number, cover: number): Pt[] | null {
  let fp = shrinkToArea(ring, A * cover);
  if (!fp) return null;
  const parts = intersect(fp, ring, 0.05);
  const best = parts.length > 0 ? parts.reduce((x, y) => (Math.abs(area(x)) > Math.abs(area(y)) ? x : y)) : null;
  return best && Math.abs(area(best)) > A * cover * 0.5 ? best : null;
}

/** 低层配套的两档处方：先沿街商业，再裙房 */
const LOW_STYLES: { kind: SolidKind; wall: MatKey; roof: MatKey; hMin: number; hMax: number; cover: number }[] = [
  { kind: 'retail', wall: 'wallPanel', roof: 'roofLight', hMin: 0.45, hMax: 1.0, cover: 0.58 },
  { kind: 'podium', wall: 'wallConcrete', roof: 'roofLight', hMin: 0.85, hMax: 1.7, cover: 0.5 },
];

/**
 * 轮廓的**短边**（m）：最小外接矩形的两条边长取小的那个。
 *
 * 这是"进深"的正确量法。旧版用内切半径 `2A/P` 当进深 —— 对正方形来说
 * 内切半径是边长的一半，于是"进深 ≥ 8 m"实际变成了"两边都 ≥ 16 m"：
 * 一栋 12×14 m 的房子进深 14 m 明明正常，却因为内切半径 6.5 m 被判死，
 * 整块地掉进"沿街矮商业"。实测住宅有 52% 的楼因此被降级。
 */
function shortSideM(fp: Pt[]): number {
  const r = minAreaRect(fp);
  if (!r || r.length < 4) return 0;
  const a = Pt.distance(r[0], r[1]);
  const b = Pt.distance(r[1], r[2]);
  return Math.min(a, b) * 7;
}

/** 这个轮廓够不够格盖 `kind` 这一类的楼 */
function fitsKind(fp: Pt[], kind: string, minDepthU: number): ShapeFit | null {
  const fit = shapeFit(fp);
  if (shortSideM(fp) < minDepthU * 7) return null;
  if (fit.minAngle < MIN_ANGLE_DEG) return null;
  if (fit.area * 49 < (MIN_AREA_M2[kind] ?? 60)) return null;
  return fit;
}

/**
 * 地块 → 一到两栋楼。
 *
 * 返回空数组表示"这块地不放建筑"，只留草坪 —— 这比放一栋纸片楼体面。
 */
function bricksFor(ring: Pt[], A: number, st: ParcelStyle, use: string): Brick[] {
  const minDepthU = MIN_DEPTH_M / 7;

  const attempt = (r: Pt[], cover: number): Pt[] | null => {
    const fp0 = shrinkFootprint(r, Math.abs(area(r)), cover);
    if (!fp0) return null;
    // 先倒角：面积代价极小，能救回大部分楔形地块
    if (shapeFit(fp0).minAngle < MIN_ANGLE_DEG) {
      const bev = bevelSharpCorners(fp0, MIN_ANGLE_DEG, u(3.4));
      if (bev) {
        const parts = intersect(bev, r, 0.02);
        const best = parts.length > 0 ? parts.reduce((x, y) => (Math.abs(area(x)) > Math.abs(area(y)) ? x : y)) : null;
        if (best && Math.abs(area(best)) > Math.abs(area(fp0)) * 0.6) return best;
      }
    }
    return fp0;
  };

  /**
   * 扶正：斜边四边形内缩之后常常带着 40~55° 的尖角，`fitsKind` 的 62° 闸会
   * 把整栋楼判死、直接掉到"沿街矮商业"。但 `gateSolid` 本来就会把体块扶正成
   * 主轴外接矩形（用户要的"规整立方体"），所以这里先按**扶正之后**的形状判一次，
   * 判得过就用扶正形状 —— 楼还是那栋楼，只是不再是斜的。
   */
  const rectify = (fp: Pt[], inside: Pt[]): Pt[] | null => {
    const r0 = minAreaRect(fp);
    if (!r0) return null;
    const fitted = inside.length >= 3 ? fitRectInBlock(r0, inside) : r0;
    const r = fitted ?? r0;
    if (Math.abs(area(r)) < Math.abs(area(fp)) * 0.5) return null;
    return fitsKind(r, st.kind, minDepthU) ? r : null;
  };

  // ① 直接盖得下 → 按用途的原处方
  //
  // 覆盖率是"占这块地的比例"，而地块现在按**沿街面宽**切（26~36 m），
  // 单块地从 43 单位² 缩到 12~15 单位²。原来固定的 cover（住宅 0.4）
  // 在这块地上只得到 220 m² 的占地 —— 内切半径 7.5 m，卡在 8 m 的进深闸
  // 外面，于是整块地掉进"沿街矮商业"，实测 87.8% 的楼被降级。
  //
  // 真实的做法正好相反：**小地块的楼占得更满**（联排 60~75%），
  // 大地块才有院子。所以这里按覆盖率**阶梯试**：先按处方，站不住就加大，
  // 直到进深闸过得去。大块地第一次就过，行为完全不变。
  for (const cov of [st.cover, st.cover + 0.12, 0.66, 0.74]) {
    if (cov > 0.78) break;
    const fp = attempt(ring, cov);
    if (!fp) continue;
    if (fitsKind(fp, st.kind, minDepthU)) {
      return [{ fp, kind: st.kind, wall: st.wall, roof: st.roof, hMin: st.hMin, hMax: st.hMax, low: false }];
    }
    const rf = rectify(fp, ring);
    if (rf) {
      return [{ fp: rf, kind: st.kind, wall: st.wall, roof: st.roof, hMin: st.hMin, hMax: st.hMax, low: false }];
    }
  }

  // ② 面积够大但形状不行 → 横切一刀，两半各放一栋（矮两档）
  const halfMinU2 = (MIN_AREA_M2[st.kind] / 49) * 0.55;
  if (A >= halfMinU2 * 2) {
    const halves = splitAcrossLongAxis(ring);
    if (halves.length === 2) {
      const out: Brick[] = [];
      for (const h of halves) {
        const ha = Math.abs(area(h));
        if (ha < halfMinU2 * 0.5) continue;
        const f = attempt(h, Math.min(st.cover + 0.06, 0.62));
        if (!f) continue;
        if (fitsKind(f, st.kind, minDepthU)) {
          // 切出来的半块，高度压到原来的 0.85 —— 同一开发地块里后切的总是矮一些
          out.push({
            fp: f,
            kind: st.kind,
            wall: st.wall,
            roof: st.roof,
            hMin: st.hMin * 0.85,
            hMax: st.hMax * 0.85,
            low: false,
          });
          continue;
        }
        const lowBrick = pickLow(f, ha);
        if (lowBrick) out.push(lowBrick);
      }
      if (out.length > 0) return out;
    }
  }

  // ③ 最后一档：整块降级成沿街商业 / 裙房
  const base = attempt(ring, LOW_STYLES[0].cover);
  if (base) {
    const lb = pickLow(base, A);
    if (lb) return [lb];
  }
  if (typeof process !== 'undefined' && process.env.PARCEL_DEBUG) {
    console.log(`[parcel] 放弃放楼 use=${use} A=${(A * 49).toFixed(0)}m²`);
  }
  return [];
}

/** 在低层处方里挑一档这个轮廓受得住的 */
function pickLow(fp: Pt[], A: number): Brick | null {
  for (const s of LOW_STYLES) {
    const fit = shapeFit(fp);
    if (fit.inradius < 4.2 / 7) continue;
    if (fit.area * 49 < (MIN_AREA_M2[s.kind] ?? 55) * 0.7) continue;
    // 降级楼不追求占地比例，按轮廓现成的形状来
    return { fp, kind: s.kind, wall: s.wall, roof: s.roof, hMin: s.hMin, hMax: s.hMax, low: true };
  }
  void A;
  return null;
}

/**
 * 全局形状闸 —— 所有体量的最后一关。
 *
 * `bricksFor` 只管"街区切成小地块"这条路。可城市还有别的产楼路径：
 * 街区太小退回 `planCommercial`（直接摆矩形）、禁建区里走 `planCbdZone`、
 * 厂房走 `planIndustrial`。它们各自都可能产出 4.3 m 进深、30 m 高的纸片，
 * 或者 30° 的刀片 —— 实测 874 栋里有 171 栋进深不足 8 m。
 *
 * 与其在每个 plan* 里各写一遍检查（写漏一个就漏一路），不如在**唯一的出口**
 * `addSolid` 上放一道闸：形状不合格就先倒角去尖，还不够就把高度压到 1 层楼，
 * 类型改成配套商业。于是"纸片楼/锐角楼"在数据层就不可能再出现。
 *
 * 雨棚（canopy）不走这个闸：它本来就是薄片，薄是对的。
 */
/**
 * 轮廓的最小外接矩形（主轴取最长边方向）。
 *
 * 用来把斜边楼"扶正"：张量切出来的地块是任意四边形，楼体内缩之后带着斜边，
 * 倒角只会把锐角变成 45° 斜边 —— 用户核对时指出的就是这个：
 * "锐角问题还是在开启切分后出现"（楼顶是个切掉一角的五边形）。
 * 真正干净的做法是让楼**本来就是矩形**：沿主轴取外接矩形，斜角自然消失。
 */
function minAreaRect(ring: Pt[]): Pt[] | null {
  if (ring.length < 3) return null;
  let bi = 0;
  let bl = 0;
  for (let i = 0; i < ring.length; i++) {
    const L = Pt.distance(ring[i], ring[(i + 1) % ring.length]);
    if (L > bl) {
      bl = L;
      bi = i;
    }
  }
  if (bl < 1e-6) return null;
  const a = ring[bi];
  const b = ring[(bi + 1) % ring.length];
  const ux = (b.x - a.x) / bl;
  const uy = (b.y - a.y) / bl;
  const vx = -uy;
  const vy = ux;
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (const p of ring) {
    const du = (p.x - a.x) * ux + (p.y - a.y) * uy;
    const dv = (p.x - a.x) * vx + (p.y - a.y) * vy;
    if (du < u0) u0 = du;
    if (du > u1) u1 = du;
    if (dv < v0) v0 = dv;
    if (dv > v1) v1 = dv;
  }
  const corner = (du: number, dv: number) => new Pt(a.x + du * ux + dv * vx, a.y + du * uy + dv * vy);
  return [corner(u0, v0), corner(u1, v0), corner(u1, v1), corner(u0, v1)];
}

/**
 * 把矩形等比缩小到刚好落在可建区里（沿中心收缩）。
 *
 * 斜边地块上的楼要"扶正"成矩形，但外接矩形会有一角压出红线 ——
 * 压出去就压到巷道 / 车道上了（gen 测试的"建筑不压路中线"就是盯这个）。
 * 所以扶正之后还要**内接**：以中心为基准等比收缩，二分找最大的合法尺寸。
 */
function fitRectInBlock(rect: Pt[], block: Pt[]): Pt[] | null {
  if (rect.length !== 4 || block.length < 3) return null;
  const cx = (rect[0].x + rect[1].x + rect[2].x + rect[3].x) / 4;
  const cy = (rect[0].y + rect[1].y + rect[2].y + rect[3].y) / 4;
  // 除了"在可建区内"，还要离可建区边界留出余量 ——
  // 可建区的边界本身就贴着路的外沿，楼角贴上去就等于压到车道了
  //（gen 测试断言"建筑角点距路中线 ≥ 0.12 单位"）。
  const EDGE_KEEP = 0.1;
  const inside = (r: Pt[]): boolean => {
    for (let i = 0; i < 4; i++) {
      const p = r[i];
      if (!pointInPolygon(p, block)) return false;
      if (distToRing(p, block) < EDGE_KEEP) return false;
      const m = new Pt((p.x + r[(i + 1) % 4].x) / 2, (p.y + r[(i + 1) % 4].y) / 2);
      if (!pointInPolygon(m, block)) return false;
    }
    return true;
  };
  const scaled = (t: number): Pt[] =>
    rect.map((p) => new Pt(cx + (p.x - cx) * t, cy + (p.y - cy) * t));
  if (inside(rect)) return rect;
  let lo = 0;
  let hi = 1;
  let best: Pt[] | null = null;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    if (inside(scaled(mid))) {
      best = scaled(mid);
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return best;
}

function gateSolid(
  ring: Pt[],
  h: number,
  kind: SolidKind,
  block?: Pt[]
): { rings: Pt[][]; h: number; kind: SolidKind; hScale?: number[] } {
  if (kind === 'canopy') return { rings: [ring], h, kind };
  const minDepthU = MIN_DEPTH_M / 7;
  let out = ring;
  let fit = shapeFit(out);

  // ⓪ 斜边 → 规整矩形（主轴外接矩形）。
  //
  // 面积涨幅控制在 45% 以内：涨幅再大说明这块地本来就是楔形，
  // 扶正会明显压出红线，那就保持原样交给 ① 倒角。
  const rect = typeof process !== 'undefined' && process.env.NORECTIFY ? null : minAreaRect(out);

  // ⓪b 不规则 / 过长 → 拆成**一串规整矩形**（用户："尽量用多个四边形立方体进行布局"）。
  //
  // 两块地方最需要这一步：
  //   · 被禁建区 / 斜边地块切完之后剩下的三角形、多边形体量；
  //   · 横跨整个街区的超长板楼（长 > 38 m），它本身就该断成几栋。
  // 拆出来的每块都内接到自己的切片里，所以互不重叠、也不会压出红线。
  const rectArea = rect ? Math.abs(area(rect)) : 0;
  const rectish = !!rect && rectArea <= fit.area * 1.06;
  const longSide = rect ? Pt.distance(rect[0], rect[1]) : 0;
  const tooLong = longSide > u(38);
  if (!rectish || tooLong) {
    const parts = decomposeToRects(out, u(38), block);
    if (parts.length >= 2) {
      const sum = parts.reduce((a, r) => a + Math.abs(area(r)), 0);
      if (sum > fit.area * 0.5) {
        return {
          rings: parts,
          h,
          kind,
          // 每段高度错落一点点：一串等高方块读起来仍然是一整片枕头
          hScale: parts.map((_, i) => 0.88 + ((i * 7) % 5) * 0.035),
        };
      }
    }
  }

  if (rect) {
    const ra = Math.abs(area(rect));
    if (ra > fit.area * 0.95) {
      // 外接矩形要**内接到可建区里**：扶正后的角会吃掉退线，直接压到巷道 / 车道上。
      // 楔形地内接后可能很小 —— 只要还剩三成面积就用它：
      // "小一点的规整矩形"永远比"带斜角的多边形"好看（用户核对时的原话）。
      const fitted = block && block.length >= 3 ? fitRectInBlock(rect, block) : rect;
      if (fitted && Math.abs(area(fitted)) > fit.area * 0.3) {
        out = fitted;
        fit = shapeFit(out);
      }
    }
  }

  // ① 锐角 → 倒角。面积只少几个点，几何仍然在原来的轮廓里。
  if (fit.minAngle < MIN_ANGLE_DEG) {
    const bev = bevelSharpCorners(out, MIN_ANGLE_DEG, Math.min(u(3.4), Math.sqrt(fit.area) * 0.25));
    if (bev && Math.abs(area(bev)) > fit.area * 0.62) {
      out = bev;
      fit = shapeFit(out);
    }
  }

  // ② 进深还是不足 → 压成低层配套。高度上限按 1 层商业（≈7 m）给。
  //
  // 这里量的是**短边**而不是内切半径（见 `shortSideM`）：内切半径对正方形
  // 只有半边长，8 m 的门槛实际变成"两边都 ≥ 16 m"，一栋 14×12 m 的正常
  // 住宅会被当成纸片，直接被压成 1 层矮商业 —— 实测住宅有 52% 的楼
  // 是这样被降级的，不是因为它们真的畸形。
  if (shortSideM(out) < minDepthU * 7 + 1e-6) {
    // 连 3.2 m 都没有的碎条（地块角上的残渣）不盖楼：放上去只是根柱子。
    if (shortSideM(out) < 3.2) return { rings: [out], h: 0, kind };
    const hCap = Math.min(h, 1.0);
    const kind2: SolidKind = kind === 'retail' || kind === 'podium' ? kind : 'retail';
    return { rings: [out], h: hCap, kind: kind2 };
  }
  // 最后一档：扶正 / 拆分都没成，轮廓仍然明显不是矩形（外接矩形比它大 20% 以上）
  // → **不盖楼**，这块地长草。用户口径："尽量不要有这种切割后形态"，
  // 一个畸形体量比一块空地难看得多。
  const last = minAreaRect(out);
  if (last && Math.abs(area(last)) > Math.abs(area(out)) * 1.2) {
    return { rings: [], h: 0, kind };
  }

  // 最后一道：轮廓短边不到 8 m 还想起高层 → 压成低层配套。
  // 扶正 / 拆分都可能产出"又薄又高"的条子，这一道兜住所有路径
  //（shape 测试的"没有纸片楼"断言盯的就是它）。
  if (last && h > 1.0) {
    const a1 = Pt.distance(last[0], last[1]);
    const a2 = Pt.distance(last[1], last[2]);
    if (Math.min(a1, a2) < u(8)) {
      const kind2: SolidKind = kind === 'retail' || kind === 'podium' ? kind : 'retail';
      return { rings: [out], h: 1.0, kind: kind2 };
    }
  }

  return { rings: [out], h, kind };
}

/**
 * 把不规则轮廓拆成**一串规整矩形**。
 *
 * 主轴取轮廓的最小外接矩形；沿主轴切成 n 段（每段 ≈ maxLen），
 * 每段与轮廓求交 → 在切片里取内接矩形（`fitRectInBlock`）。
 * 切片之间互不重叠，所以拆出来的矩形也不会打架。
 */
function decomposeToRects(ring: Pt[], maxLenU: number, block?: Pt[]): Pt[][] {
  const box = minAreaRect(ring);
  if (!box) return [];
  const L = Pt.distance(box[0], box[1]);
  const W = Pt.distance(box[1], box[2]);
  if (L < u(12) || W < u(6)) return [];
  const ux = (box[1].x - box[0].x) / L;
  const uy = (box[1].y - box[0].y) / L;
  const vx = (box[3].x - box[0].x) / W;
  const vy = (box[3].y - box[0].y) / W;
  const at = (s: number, t: number) => new Pt(box[0].x + ux * s + vx * t, box[0].y + uy * s + vy * t);

  // 段数：按"每段不超过 maxLenU"来，最多 4 段（再多就全是碎块了）
  const n = Math.max(2, Math.min(4, Math.ceil(L / maxLenU)));
  const out: Pt[][] = [];
  for (let i = 0; i < n; i++) {
    const s0 = (L * i) / n;
    const s1 = (L * (i + 1)) / n;
    const strip = [at(s0, 0), at(s1, 0), at(s1, W), at(s0, W)];
    const parts = intersect(toCCW(strip), toCCW(ring), 0.08);
    if (parts.length === 0) continue;
    const slice = parts.reduce((a, b) => (Math.abs(area(a)) > Math.abs(area(b)) ? a : b));
    const sliceA = Math.abs(area(slice));
    if (sliceA < 0.2) continue;
    const r0 = minAreaRect(slice);
    if (!r0) continue;
    const fitted = block && block.length >= 3 ? fitRectInBlock(r0, slice) : r0;
    const fr = fitted ?? r0;
    const fa = Math.abs(area(fr));
    // 内接后还要占住切片的一半，否则这一块就是一根柱子，不如空着长草
    if (fa < sliceA * 0.5 || fa < 0.2) continue;
    // 进深不足 8 m 的条子不盖楼：拆出来的块如果又薄又高就是"纸片楼"，
    // 换了形状也还是难看。这里用和 shape 测试同一口径的 inradius（2A/P），
    // 不是外接矩形的短边 —— 二者对斜条子差别很大。
    if (shapeFit(fr).inradius < u(8)) continue;
    out.push(fr);
  }
  return out;
}

/**
 * 商业 / 商务 / 市政地块的**「塔楼 + 连续裙房 + 内院」**三段式。
 *
 * 参考图（Grasshopper 那组商业街区）的读法是：
 *   · 沿地块四边一条**连续的低层裙房带**（商业界面，围合成"口"或"U"）；
 *   · 裙房围出来的**内院**是铺装广场 + 中心绿地；
 *   · 塔楼坐在内院里，1~2 栋，沿地块主轴居中排。
 *
 * 实现顺序：内缩出"环路"→ 逐边生成裙房梯形（留 1~2 条边做出入口）→
 * 内院铺装与绿地 → 内院里放塔楼。
 * 排不出来（地块太小 / 形状太碎）就返回 null，退回原来的"一地块一栋"。
 */
function towerPodium(c: Ctx, ring: Pt[], A: number, st: ParcelStyle): Brick[] | null {
  if (c.use !== 'cbd' && c.use !== 'commercial' && c.use !== 'civic') return null;
  const BP = c.model.params.building;
  if (BP.podiumDepthM < 4) return null;

  const inner = insetRing(ring, u(4.5));
  if (inner.length < 3) return null;
  if (Math.abs(area(inner)) < 8) return null;
  // 裙房进深自适应：最多吃掉短边的 28%（每侧），否则小地块里内院会被挤没
  const gbi = bboxOf(inner, c.f);
  const shortSide = Math.min(gbi.w, gbi.h);
  const depth = Math.min(u(BP.podiumDepthM), shortSide * 0.28);
  if (depth < u(4)) return null;
  const court = insetRing(inner, depth);
  if (court.length < 3) return null;
  const courtA = Math.abs(area(court));
  if (courtA < 1.5) return null;

  const out: Brick[] = [];
  // 裙房高度**整块地统一**：一段高一段矮会读成"几栋小楼"，
  // 不是参考图里那条连续的商业界面。
  const podiumH = BP.podiumHMin + Rng.float() * (BP.podiumHMax - BP.podiumHMin);
  const n = inner.length;
  // 留出 1~2 条最长边当出入口 / 开口（临街主面不摆裙房）
  const gapCount = n > 4 ? 2 : 1;
  const order = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) =>
      Pt.distance(inner[b], inner[(b + 1) % n]) - Pt.distance(inner[a], inner[(a + 1) % n])
  );
  const skip = new Set(order.slice(0, gapCount));

  for (let i = 0; i < n; i++) {
    if (skip.has(i)) continue;
    const a = inner[i];
    const b = inner[(i + 1) % n];
    const a2 = court[i];
    const b2 = court[(i + 1) % n];
    if (!a2 || !b2) continue;
    const quad = [a, b, b2, a2];
    if (!isSimpleRing(quad)) continue;
    const parts = intersect(toCCW(quad), toCCW(ring), 0.3);
    if (parts.length === 0) continue;
    const fp = parts.reduce((x, y) => (Math.abs(area(x)) > Math.abs(area(y)) ? x : y));
    if (Math.abs(area(fp)) < 0.3) continue;
    out.push({
      fp,
      kind: 'podium',
      wall: c.use === 'civic' ? 'wallStone' : 'wallGlass',
      roof: 'roofLight',
      hMin: podiumH,
      hMax: podiumH,
      low: false,
    });
  }
  if (out.length < 2) return null;

  // 内院：**不再铺第二层地面**。
  //
  // 旧版在这里铺 court_pave（0.013）+ 中心一块 court_green（0.0134）——
  // 而"这一格的地面"已经由 `groundPlan` 铺过了，再铺一层就是同一块地上两层铺装，
  // 也正是用户说的"不同地面铺装互相重叠"。内院想要草地，应该在内院**所在的那一格**
  // 定角色时就定成绿地，而不是后贴。
  void court;

  // 塔楼：放在 **inner 的中心**（不是内院），允许底面压到裙房上 ——
  // 参考图里的塔楼就是从裙房里长出来的，而不是孤零零坐在院心。
  // 只锁在内院里的话，内院一小塔楼就放不下（12 m 见方的院心 inradius 只有 6 m）。
  const ib = bboxOf(inner, c.f);
  const iu = (ib.u0 + ib.u1) / 2;
  const iv = (ib.v0 + ib.v1) / 2;
  const towerW = clamp(ib.w * 0.5, u(12), u(34));
  const towerD = clamp(ib.h * 0.5, u(12), u(34));
  const two = courtA > 18 && BP.maxPerParcel >= 2;
  const spots = two
    ? ib.w >= ib.h
      ? [
          new Pt(iu - ib.w * 0.2, iv),
          new Pt(iu + ib.w * 0.2, iv),
        ]
      : [
          new Pt(iu, iv - ib.h * 0.2),
          new Pt(iu, iv + ib.h * 0.2),
        ]
    : [new Pt(iu, iv)];

  for (const q of spots) {
    const fp0 = rect(c.f, q.x - towerW / 2, q.x + towerW / 2, q.y - towerD / 2, q.y + towerD / 2);
    const parts = intersect(toCCW(fp0), toCCW(inner), 0.4);
    if (parts.length === 0) continue;
    const fp = parts.reduce((x, y) => (Math.abs(area(x)) > Math.abs(area(y)) ? x : y));
    if (Math.abs(area(fp)) < 0.3) continue;
    if (!fitsKind(fp, st.kind, MIN_DEPTH_M / 7)) continue;
    out.push({
      fp,
      kind: st.kind,
      wall: st.wall,
      roof: st.roof,
      // 三段式里的塔楼要比"一地块一栋"那套高出一档，否则只比裙房高一倍，
      // 读起来是"大一号的裙房"而不是塔楼（商业 12~21 m → 21~38 m）
      hMin: st.hMin * 1.8,
      hMax: st.hMax * 1.8,
      low: false,
    });
  }

  return out.length >= 2 ? out : null;
}

/**
 * 一个地块里排**多栋平行板楼**（参考图里住宅组团的做法）。
 *
 * 现状是"一个地块一栋楼、楼居中、其余全是草坪"——从空中读是"草坪上散着几栋楼"，
 * 参考图读的是"几栋平行的板楼 + 楼间院子 + 两端绿地"。差的就是这一层。
 *
 * 规则：
 *   · 沿地块**长向**排 N 栋，进深固定 12 m，栋间净距 = `building.spacingM`；
 *   · N = min(每地块楼栋上限, 能排下的栋数)，排不下 2 栋就返回 null（走旧路径）；
 *   · 楼带整体在短向居中，两端各留一块院子；
 *   · 每栋楼仍走形状体检（进深下限 / 倒角），不合格的整栋丢掉。
 *
 * 只对板楼类体量生效（住宅 / 商业 / 市政）；塔楼类（CBD）留给裙房 + 内院那一步。
 */
function rowLayout(c: Ctx, ring: Pt[], A: number, st: ParcelStyle): Brick[] | null {
  const BP = c.model.params.building;
  if (BP.maxPerParcel < 2) return null;
  // 先只在住宅上开：商业 / 市政地块的地面要留给绿化分区与内院
  // （实测多栋排布会把商业绿地率从 29% 压到 23%），它们等 P2 的
  // "塔楼 + 裙房 + 内院"那一步再单独处理。
  if (c.use !== 'residential') return null;
  if (st.kind === 'tower' || st.kind === 'warehouse') return null;

  const { bb, f } = c;
  const depth = u(14); // 板楼进深 14 m
  const gap = u(BP.spacingM);
  const setback = u(1.2); // 楼端退线
  // 排成多栋时进深下限放宽到 7 m：条带被斜边地块裁掉一角后，
  // 8 m 的通用门槛会把一半条带判死（实测住宅只有一栋能通过）。
  const minDepthU = u(7);
  // 楼在带里占多满：旧口径 cover 是"一栋楼居中"的占地率（住宅 0.4），
  // 排成多栋时每栋要占满自己的带（0.78），否则楼与楼之间会空出一条大缝。
  const cover = Math.min(0.78, st.cover + 0.38);

  // 两种朝向都试：板楼长边顺着地块长向（宽地块），或垂直（狭长地块），
  // 取能排下更多栋的那一种 —— 狭长地块照样能排成两栋前后串联。
  const tryDir = (alongU: boolean): Brick[] | null => {
    const long = alongU ? bb.w : bb.h;
    const short = alongU ? bb.h : bb.w;
    const avail = short - setback * 2;
    const n = Math.min(BP.maxPerParcel, Math.floor((avail + gap) / (depth + gap)));
    if (n < 2) return null;
    // 太长的楼读成"一栋大楼"，参考图里的板楼长度在 90 m 以内
    if (long > u(90)) return null;

    const used = n * depth + (n - 1) * gap;
    const start = (short - used) / 2;
    const out: Brick[] = [];

    for (let i = 0; i < n; i++) {
      const s0 = start + i * (depth + gap);
      const s1 = s0 + depth;
      // ① 先在**长向通到地块外**切出一条带，再与可建区求交 ——
      //    这样带子是顺着地块的真实斜边裁出来的，而不是"矩形减一圈"，
      //    斜边地块上不会切掉一多半。
      const strip = alongU
        ? rect(f, bb.u0 - 1, bb.u1 + 1, bb.v0 + s0, bb.v0 + s1)
        : rect(f, bb.u0 + s0, bb.u0 + s1, bb.v0 - 1, bb.v1 + 1);
      const parts = intersect(toCCW(strip), Array.from(c.block), 0.15);
      if (parts.length === 0) continue;
      const band = parts.reduce((a, b) => (Math.abs(area(a)) > Math.abs(area(b)) ? a : b));
      const bandA = Math.abs(area(band));
      if (bandA < 0.12) continue;

      // ② 带子里的楼：沿长向居中，长度 = 带长 × cover，进深保持带深
      const gb = bboxOf(band, f);
      const bandLong = alongU ? gb.w : gb.h;
      const bandShort = alongU ? gb.h : gb.w;
      const lenC = clamp(bandLong * cover, u(16), Math.max(u(10), bandLong - u(2)));
      const off = (bandLong - lenC) / 2;
      const fpRect = alongU
        ? rect(f, gb.u0 + off, gb.u0 + off + lenC, gb.v0, gb.v0 + bandShort)
        : rect(f, gb.u0, gb.u0 + bandShort, gb.v0 + off, gb.v0 + off + lenC);
      const fpParts = intersect(toCCW(fpRect), band, 0.3);
      if (fpParts.length === 0) continue;
      const fp = fpParts.reduce((a, b) => (Math.abs(area(a)) > Math.abs(area(b)) ? a : b));
      const fpA = Math.abs(area(fp));
      if (fpA < 0.12) continue;
      if (!fitsKind(fp, st.kind, minDepthU)) continue;
      out.push({
        fp,
        kind: st.kind,
        wall: st.wall,
        roof: st.roof,
        hMin: st.hMin,
        hMax: st.hMax,
        low: false,
      });
    }
    return out.length >= 2 ? out : null;
  };

  const a = tryDir(bb.w >= bb.h);
  const b = tryDir(bb.w < bb.h);
  if (a && b) return a.length >= b.length ? a : b;
  return a ?? b;
}
function planParcel(c: Ctx) {
  const ring = Array.from(c.block);
  const A = Math.abs(area(ring));
  if (A < 0.5) return;

  const st = PARCEL_STYLE[c.use] ?? PARCEL_STYLE.residential;
  // 一个地块切 1~2 格（大的切 4 格）：地块本身就是"一个开发地块"的尺度，
  // 再切碎就变成"巷道比院子还宽"。
  //
  // 这里不再自己算地面、自己摆停车 —— 全交给 groundPlan：地块 → 格 → 每格一个角色。
  // 铺装只画一次（不会重叠），建筑只落在"建筑格"的内缩范围里（不会压草地 / 车位）。
  const cells = groundPlan(c, {
    greenRatio: GREEN_OF[c.use] ?? 0.2,
    parkRatio: PARK_OF[c.use] ?? 0.05,
    hard: HARD_OF[c.use] ?? 'paver',
    buildMat: c.use === 'residential' ? 'grass' : HARD_OF[c.use] ?? 'paver',
    cells: A > 100 ? 4 : A > 48 ? 2 : 1,
  });
  if (cells.length === 0) return;

  massCells(c, cells, st, { podium: c.use !== 'residential' });
  fillGreenCells(c, cells);
  fillParkCells(c, cells);
  // 院墙 / 绿篱：住宅地块自己那圈界线（临街边不围，见 `lotLineHedge`）
  if (c.use === 'residential' && A > 24) lotLineHedge(c);
  // 街角：两条临街边交汇的那个角，退 1.6 m 摆一棵树
  if ((c.streetEdges?.length ?? 0) >= 2 && c.use !== 'industrial' && A > 20) cornerTrees(c);
}

/**
 * 街角处理：地块的**转角**退进来一棵树。
 *
 * 转角是城市里唯一"两条街同时看见"的位置，也是切分算法最容易切歪的地方 ——
 * 张量二分切到角上经常给出一块三角碎地，铺装、建筑、绿地都摆不进去，
 * 最后在角上留一小块什么都没有的空地。摆一棵冠幅大的树，这个角就成立了：
 * 从两条街望过去都是"路口有棵大树"，不再是"这里算法没想好"。
 *
 * 判据：环上的顶点同时落在两条以上临街边上（距离 < 0.03）= 真的转角。
 * 缩进来的距离要盖住退线（1.6 m），否则树冠会压在路缘石上。
 */
function cornerTrees(c: Ctx): void {
  const ring = Array.from(c.block);
  const street = c.streetEdges ?? [];
  if (ring.length < 3 || street.length < 2) return;
  const ctr = ringCenter(ring);
  const inset = u(1.6);
  for (const v of ring) {
    let hits = 0;
    for (const e of street) if (Pt.distance(v, closestOnSegment(v, e.a, e.b)) < 0.03) hits++;
    if (hits < 2) continue;
    // 从角点朝地块中心退 1.6 m
    const d = Pt.distance(v, ctr);
    if (d < inset * 1.5) continue;
    const p = new Pt(v.x + ((ctr.x - v.x) / d) * inset, v.y + ((ctr.y - v.y) / d) * inset);
    if (!pointInPolygon(p, ring)) continue;
    addProp(c, 'tree', p, 1.05 + Rng.float() * 0.2, Rng.float() * Math.PI * 2);
  }
}

/**
 * 把环内缩到目标面积。二分求内缩距离，返回内缩后的环。
 *
 * 结果达不到目标面积的 55% 就返回 null（凹得太狠，内缩会碎成两瓣）——
 * 这种情况下宁可这个地块空着，也不要在地块中间放一颗"楼渣"。
 */
function shrinkToArea(ring: Pt[], target: number): Pt[] | null {
  if (target <= 0.05 || ring.length < 3) return null;
  const sg = area(ring) < 0 ? -1 : 1;
  let lo = 0.02;
  let hi = Math.max(0.4, Math.sqrt(Math.abs(area(ring))) * 0.42);
  let best: Pt[] | null = null;

  for (let i = 0; i < 12; i++) {
    const d = (lo + hi) / 2;
    const r = offsetRing(ring, sg * d);
    const ok = r.length >= 3 && simpleRing(r);
    const a = ok ? Math.abs(area(r)) : 0;
    if (!ok || a < target * 0.25) {
      hi = d;
      continue;
    }
    best = r;
    if (Math.abs(a - target) <= target * 0.04) break;
    if (a > target) lo = d;
    else hi = d;
  }
  if (!best) return null;
  return Math.abs(area(best)) > target * 0.55 ? best : null;
}

function planReserved(c: Ctx) {
  // 三者共用同一条"被挖成独立地块"的管线，分叉只发生在内容层。
  const purpose = c.patch.purpose ?? 'cbd';
  if (purpose === 'forest' || purpose === 'park') {
    planForest(c, purpose);
    return;
  }
  if (c.model.params.block.zonePad) {
    planZonePad(c);
    return;
  }
  baseSurface(c, 'grass');
  const ring = Array.from(c.block);
  const a = Math.abs(c.block.square);
  if (ring.length < 3) return;

  // 两种骨架都走 `internalSpine`：
  //   · 没有环路 → 内部主路就是这一片唯一的车行道；
  //   · 有环路   → 内部主路从环路内侧出发、横穿核心区，等于"接入环路的支路"。
  // 不要把有环路的情况改成"不切主路"：那样核心区只剩一次张量分割，
  // 地块数会从 16 掉到 8、建筑少三成，禁建区内部直接空掉（实测 L 形禁区 23 栋 → 0 栋）。
  const spine = internalSpine(c, ring, a);
  if (!spine) {
    // 连内部路都排不出来（地块太小 / 太扁）：退回"待建空地"
    const d = Math.min(1.2, Math.sqrt(Math.max(a, 0.02)) * 0.16);
    const inner = insetRing(ring, d);
    if (inner.length >= 3) addSurface(c, 'reserved_yard', inner, 'gravel', 0.012);
    scatter(c, Math.min(12, Math.max(2, Math.round(a / 34))), { minDist: 0.9 });
    return;
  }

  // ① 一级：内部路把地块切成 2~4 个子街坊。
  //    停车不再单占一个街坊（那是"整块地变车场"的老做法），
  //    改成每个地块内部留 5% 的访客车位 —— 用户要的是"少量停车位"。
  const roadBands: RoadBand[] = [];
  const quads = subBlocks(c, spine);
  const A = Math.abs(area(Array.from(c.block)));
  pushZoneDbg({
    key: 'parent',
    blockA: A,
    lines: spine.lines.length,
    lens: spine.lines.map((l) => +polyLen(l).toFixed(1)),
  });
  const blocks = (globalThis as any).__zoneBlocks as Pt[][] | undefined;
  if (blocks) blocks.push(Array.from(c.block));

  drawInternalRoad(c, spine, roadBands);
  spineFurniture(c, spine, []);

  // ② 二级：每个子街坊**再做一次张量分割**，切出 2~4 个"地块"（parcel）。
  //
  //    之前这里直接从子街坊起 28 m 栅格排楼，结果是：一个 190 m 见方的封闭区域
  //    里只有 4 个子街坊，每个子街坊被格子填满、格子之间只有 0.7 m 缝 ——
  //    放大看就是一整块连成片的巨型建筑，既没有地块边界，也没有沿边界修的路。
  //
  //    现在分割线在几何上是真切的：每一刀都是一个多边形布尔切分，
  //    切完把**割线**原样铺成 3.2 m 巷道。于是"分割线 → 路"是同一份数据，
  //    不存在"模型看起来叠在一起"。
  const parcels: Pt[][] = [];
  const seams: { pts: Pt[]; depth: number }[] = [];
  for (const quad of quads) {
    const qa = Math.abs(area(quad));
    if (qa < 26) {
      parcels.push(quad); // 小块：一刀都不切，整块当地块用
      continue;
    }
    // 地块规模：CBD 一个开发地块 2500~4000 m² ≈ 50~80 u²。
    // 目标面积按子街坊面积自适应，但不低于 34 u²（否则切出 15 m 宽的窄条，
    // 一个 24 m 的格子都放不下）。
    const pt = c.model.params.block.parcelTargetA;
    const targetA = clamp(qa / 2.6, pt * 0.57, pt * 1.2);
    // 递归深度也跟着目标面积走：只按面积判"够大了就停"会被深度上限卡住，
    // 于是 targetA 调小也不多切一刀，参数看着是死的。
    const depthCap = clamp(Math.ceil(Math.log2(Math.max(qa / targetA, 1))), 1, 3);
    const part = tensorPartition(quad, {
      targetA,
      minA: 24,
      maxDepth: depthCap,
      ang0: spine.ang + Math.PI / 2,
    });
    parcels.push(...part.parcels);
    seams.push(...part.seams);
  }
  // 一级分割线铺**沥青**（5 m 服务车道）：它是"分割线即内部路"的那条路，
  // 必须一眼看得出是路；二级分割线同样是车行道，只是窄一档。
  //
  // 这里**不再**给二级巷道上混凝土：同一块地里一半沥青一半混凝土，俯视图上
  // 读起来是"两种路面拼在一起"，而且混凝土那条比车行道高 0.0003，路口处
  // 正好浮在沥青上 —— 用户截图里那几块浅色小方块就是它。
  // 现在统一：同材质、同标高，路口靠并集成面（drawRoadBands）收口。
  for (const s of seams) {
    const P = c.model.params.block;
    spine.lanes.push({
      pts: s.pts,
      w: u(s.depth === 0 ? P.seamWideM : P.seamNarrowM),
      mat: 'asphalt',
      y: Y_INNER_ROAD,
    });
  }
  pushZoneDbg({
    key: `parcels:${parcels.length}`,
    blockA: parcels.reduce((s, q) => s + Math.abs(area(q)), 0),
    lines: seams.length,
    lens: seams.map((s) => +polyLen(s.pts).toFixed(1)),
  });

  // 内部主路 + 一级/二级分割线一起成面：只并一次，路口才是连续的一整块
  roadBands.push(...spine.lanes.map((ln) => ({ ...ln, mat: 'asphalt' as MatKey, y: Y_INNER_ROAD })));
  drawRoadBands(c, roadBands);

  // ③ 配比预算：绿地 10% / 停车 5% 是**整块封闭区域**的比例。
  //    按地块各自算会累积超标（13 个地块各留一格绿地就是 18%），
  //    所以预算只做一份，地块按"离整块地中心由近到远"消耗它 ——
  //    绿地自然聚成中央口袋公园，停车顺带落在穿中心的内部路旁边。
  const ctrAll = ringCenter(ring);
  parcels.sort((p, q) => Pt.distance(ringCenter(p), ctrAll) - Pt.distance(ringCenter(q), ctrAll));
  const budget: ZoneBudget = {
    green: A * 0.1,
    lot: A * 0.05,
    greenUsed: 0,
    lotUsed: 0,
    ctr: ctrAll,
  };
  parcels.forEach((part, i) => {
    if (Math.abs(area(part)) < 0.32) return;
    const sub = subCtx(c, part);
    if (!sub) return;
    planCbdZone(sub, i, spine, budget);
  });

  // 围栏沿地块边界走，必须在内部路的端口处断开
  const mouths: { at: Pt; r: number }[] = [];
  for (const line of spine.lines) {
    for (const p of [line[0], line[line.length - 1]]) {
      if (p) mouths.push({ at: p, r: spine.w / 2 + u(1.5) });
    }
  }
  // 这里原本还有一道"沿地块边界、在内部路端口断开"的围栏。
  // 禁建区不再有围栏：它的边界由车行道 + 人行道的路缘已经交代清楚，
  // 再围一圈栏杆只会在剖面图上多出一道要解释的墙（用户明确要移除）。
  // `mouths` 仍算出来，留着给以后可能回来的"围栏只围临街段"用。
  void mouths;
}


/** 内部路：若干条中线折线（主路 + 支路）+ 车行道宽 */
interface Spine {
  lines: Pt[][];
  w: number;
  /** 张量场追踪出来的（真"分割线"）；false = 退回了折线兜底 */
  field: boolean;
  /**
   * 主轴角（张量场角度折叠到"最长的界边"之后）。
   *
   * 一级内部路沿这个方向通长打穿地块；二级的地块分割线与它**正交** ——
   * 于是每个地块都有一段临街面（面朝内部路），而不是一圈朝内的内向地块。
   */
  ang: number;
  /** 二级巷道：沿地块分割线铺的窄带，把子街坊再切成地块 */
  lanes: { pts: Pt[]; w: number; mat: MatKey; y: number }[];
}

/**
 * 地块内部的张量场。
 *
 * 场源的配比是这段代码里最要命的参数：
 *   - `grid`（整城主朝向）必须占主导。封闭区域内部的路是"这一片街网的延续"，
 *     朝向一歪，接缝处就跟外部路网差出十几度，画面上是两个路网硬怼在一起。
 *   - 中心 `vortex` 只给很轻的一点（0.22）：纯粹平行的直线切凹地块会切出
 *     尖楔子，让线在中心附近微微弯一下，内部路才读得出"顺着地块走"。
 *   - 刻意**不放** `boundary`（贴着地块轮廓的那种场源）：它会让流线平行于界边，
 *     而内部路恰恰要**垂直**穿过界边才能接上外部主路 —— 放了就接不上了。
 */
function localField(c: Ctx, ctr: Pt, span: number): TensorField {
  const axis = c.model.cityAxis ?? new Pt(1, 0);
  const sources: FieldSource[] = [
    { id: 'grid', type: 'grid', direction: axis, radius: span, strength: 1.0 },
  ];
  if (span > 5) {
    sources.push({
      id: 'core',
      type: 'vortex',
      position: ctr,
      radius: span * 0.55,
      strength: 0.22,
      falloff: 2.4,
    });
  }
  return new TensorField(sources, Array.from(c.block));
}

/** 环上最远两点距离，作为"地块跨度" */
function spanOf(ring: Pt[]): number {
  let best = 0;
  for (let i = 0; i < ring.length; i++) {
    for (let j = i + 2; j < ring.length; j++) {
      if (i === 0 && j === ring.length - 1) continue;
      const d = Pt.distance(ring[i], ring[j]);
      if (d > best) best = d;
    }
  }
  return best;
}

/**
 * 内部路 = **张量场分割线**。
 *
 * 做法完全对齐城市级那条链（场 → 流线 → 面），只是换了作用域：
 *   ① 以"整城主朝向 + 中心一点旋涡"建地块内部的张量场；
 *   ② 种子取在**界边中点**，朝地块内侧积分 —— 于是追出来的线两端
 *      天然落在地块轮廓上，而地块轮廓就是外部道路的中线，
 *      内部路与外部路网的连接是几何上的必然，不需要事后对接；
 *   ③ 主路取等级最高（同级最长）那条界边出发的线；面积够大再收一条
 *      离它够远的分支，形成"十"字 / "丁"字；
 *   ④ 追不出合格线（地块太小、场太弱）才退回"入口 → 质心 → 对边"的折线。
 */
function internalSpine(
  c: Ctx,
  ring: Pt[],
  areaU: number,
  opts: { alignToCity?: boolean; budgetK?: number } = {}
): Spine | null {
  const n = ring.length;
  if (n < 3) return null;

  const w = u(c.model.params.block.internalRoadW); // 内部路车行道（小区路一档）
  const rank = (v0: Pt, v1: Pt) => {
    const cls = c.model.roadClassOf(v0, v1);
    return cls === 'arterial' ? 3 : cls === 'collector' ? 2 : 1;
  };

  // ---- 界边：等级高的优先当入口，同级取长的
  interface Edge {
    a: Pt;
    b: Pt;
    len: number;
    score: number;
    rank: number;
  }
  const edges: Edge[] = [];
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const len = Pt.distance(a, b);
    const r = rank(a, b);
    edges.push({ a, b, len, rank: r, score: r * 1000 + len });
  }
  edges.sort((p, q) => q.score - p.score);

  const ctr = ringCenter(ring);
  const span = spanOf(ring);

  // ---- ① 主轴：张量场定"朝向"，但**不沿场积分**
  //
  // 场是缓变的，沿场追一条 200 m 的线会绕出一倍多的长度（两条 7 m 路实测吃掉
  // 整块地 17% 的用地），而且斜穿 CBD 栅格，把地块切成一大堆三角碎块 ——
  // 建筑覆盖率被压到 52%，放大看是一条条斜着划过去的疤。
  // 真实街区里的内部路是直的：与外围街道平行或垂直。所以这里只用场决定"主轴角"，
  // 再用射线打穿地块，两个端点自然落在界边上 —— 连通外部道路是几何上的必然，
  // 不靠事后对接，也不会留下"两块模型叠在一起"的错觉。
  const field = localField(c, ctr, span);
  const longest = edges.reduce((p, q) => (q.len > p.len ? q : p), edges[0]);
  const frontAng = Math.atan2(longest.b.y - longest.a.y, longest.b.x - longest.a.x);
  const foldTo = (x: number, base: number) => {
    let d = x - base;
    while (d > Math.PI / 2) d -= Math.PI;
    while (d < -Math.PI / 2) d += Math.PI;
    return base + d;
  };
  const fieldAng = foldTo(field.sample(ctr.x, ctr.y).a, frontAng);
  // 场与界边差得不多就随场（城区整体转过一个角度时内部路也该跟着转）；
  // 差太多说明场在块内是虚的（X 型退化节点），老实跟界边平行。
  //
  // `alignToCity`：普通街区（不切小地块）走这条 —— 直接对齐**城市主轴**。
  // 那一档街区里没有"地块"这一层，内部路是唯一一条能读出来的路，
  // 跟着场走会切出一条与周边街网差十几度的斜路，看着像"有人在街心划了一刀"。
  let ang = opts.alignToCity
    ? Math.atan2((c.model.cityAxis ?? new Pt(1, 0)).y, (c.model.cityAxis ?? new Pt(1, 0)).x)
    : Math.abs(fieldAng - frontAng) < Math.PI / 8
      ? fieldAng
      : frontAng;
  ang += (Rng.float() - 0.5) * 0.1;

  const dir = new Pt(Math.cos(ang), Math.sin(ang));
  const perp = new Pt(-dir.y, dir.x);

  // 路网规模按**跨度**定：170 m 以内一条，320 m 以内两条，再大才三条。
  // 一条 7 m 路横穿一次就是 4~5% 的用地，之前按面积给">14 u² 就三条"，
  // 200 m 见方的禁绘区必然吃满三条，沥青占 17%，建筑覆盖率掉到 52%。
  const spanM = span * 7;
  const maxLines = spanM > 320 ? 3 : spanM > 170 ? 2 : 1;
  const roadBudget = areaU * (opts.budgetK ?? 0.1);

  // ---- ② A* 寻路（`internalRoads = 'path'`）
  //
  // 与张量直切的区别只在"路怎么走"：张量是过质心打一条直线，A* 是从界边
  // 的既有路口出发、在栅格图上按"最短 + 少转弯 + 顺街网"的代价找一条。
  // 下游完全不动 —— 拿到的还是 `Spine.lines`（折线中线数组），
  // `subBlocks` / 张量二次分割 / 铺装 / 家具全都照旧。
  // 失败（地块太小、栅格被界边净空吃掉、找不到路）就落回张量直切，
  // 不会整块地变成空地。
  if (c.model.params.block.internalRoads === 'path') {
    const nets = pathSpine(c, ring, dir, spanM, w, areaU);
    if (nets && nets.length > 0) return { lines: nets, w, field: false, ang, lanes: [] };
  }

  const lines: Pt[][] = [];
  let roadUsed = 0;
  /** 过 p 沿 d 打一条直路，两端都顶到界边 */
  const cut = (p: Pt, d: Pt) => {
    const e1 = rayExit(ring, p, d);
    const e2 = rayExit(ring, p, new Pt(-d.x, -d.y));
    if (!e1 || !e2) return;
    const len = Pt.distance(e1, e2);
    // 太短的路没用：一条 10 m 的路只是把地切出一条缝，谁也用不上。
    // 但门槛不能按跨度的一半来给 —— L 形 / 凹核心区的过质心弦本来就短
    // （跨度 214 m，弦只有 56 m），按 0.5 判会被整条拒掉，
    // 于是整块核心区退化成"待建空地"：23 栋楼一间不剩。
    // 改成"至少 6 条路宽"且"不到跨度的 22% 就别切"这两条同时成立。
    if (len < Math.min(w * 6, span * 0.22)) return;
    if (roadUsed + len * w > roadBudget) return;
    roadUsed += len * w;
    lines.push([e1, e2]);
  };

  // 主路：过质心，带一点偏移 —— 每条路都正好把地块四等分，整片读起来像练习册
  const o1 = (Rng.float() - 0.5) * span * 0.14;
  const m0 = new Pt(ctr.x + perp.x * o1, ctr.y + perp.y * o1);
  cut(m0, dir);

  if (maxLines >= 2) {
    const o2 = (Rng.float() - 0.5) * span * 0.14;
    cut(new Pt(ctr.x + dir.x * o2, ctr.y + dir.y * o2), perp);
  }
  if (maxLines >= 3) cut(new Pt(m0.x + perp.x * span * 0.33, m0.y + perp.y * span * 0.33), dir);

  if (lines.length > 0) return { lines, w, field: false, ang, lanes: [] };

  // ---- ② 兜底：极扁 / 极小的块，从最长边的中点朝质心方向打一条，顶到对边为止
  //
  // 注意**起点必须是界边上的那个角**（entry），不能从质心起射线：
  // 凹地块（L 形核心区、带缺口的封闭轮廓）的"顶点平均"会落在缺口里，
  // 也就是落在多边形**外面**，从外面打射线可以一个交点都碰不到 —— 返回 null，
  // 整块核心区直接退化成"待建空地"，一栋楼都不排。
  const e0 = edges[0];
  const entry = new Pt((e0.a.x + e0.b.x) / 2, (e0.a.y + e0.b.y) / 2);
  let dd = new Pt(ctr.x - entry.x, ctr.y - entry.y);
  const dl = Math.hypot(dd.x, dd.y) || 1;
  dd = new Pt(dd.x / dl, dd.y / dl);
  const exit = rayExit(ring, entry, dd) ?? rayExit(ring, ctr, dd);
  if (!exit) return null;
  const mid = pointInPolygon(ctr, ring) ? [ctr] : [];
  return { lines: [dedupePath([entry, ...mid, exit])], w, field: false, ang, lanes: [] };
}

/**
 * 地块内部路网（A* 版）。
 *
 * 三步：
 *   ① **入口**：界边按"道路等级优先、同级取长"排序，取中点。
 *      这与张量版的 `edges.sort` 同源 —— 内部路必须接在**等级最高的那条界边**上，
 *      接到一条 2 车道小路上，车流是走不出去的。
 *   ② **栅格 A***（`field/lattice.ts`）：状态带朝向，代价含转弯惩罚 + 顺轴折扣 +
 *      随机扰动。三个"反退化"项缺一不可，详见该模块的注释。
 *   ③ **主干 + T 支路**：相距最远的一对入口连成主干，其余入口向主干投点做支路。
 *
 * 与张量直切共用 `roadBudget`（地块面积的 10%）：A* 求出来的路更长，
 * 不设预算的话一块 200 m 见方的地能被两条弯来弯去的路吃掉 20% 的用地。
 */
function pathSpine(
  c: Ctx,
  ring: Pt[],
  axis: Pt,
  spanM: number,
  w: number,
  areaU: number
): Pt[][] | null {
  const P = c.model.params.block;
  const span = spanM / 7;
  // 入口数：与张量版的路条数对齐（1 / 2 条路 → 2 / 3 个口）
  const want = spanM > 170 ? 3 : 2;
  const entries = pickEntryPoints(
    ring,
    want,
    (a, b) => {
      const cls = c.model.roadClassOf(a, b);
      const r = cls === 'arterial' ? 3 : cls === 'collector' ? 2 : 1;
      return r * 1000 + Pt.distance(a, b);
    },
    span * 0.4
  );
  if (entries.length < 2) return null;

  // ---- 换到"街道坐标系"再寻路
  //
  // 栅格的 8 个方向是**屏幕**方向，而真正合法的是"顺街 / 垂直街"两个方向。
  // 如果城市整体转过 20°，屏幕坐标系里的正交步全都斜着穿过街网，
  // 斜穿惩罚算出来的 align 也就没意义了。所以先把多边形绕原点转 -ang
  // （ang 已经折叠到最长的界边上，也就是街道方向），
  // 转完之后屏幕的 x/y 轴就是街道的两条轴，栅格自带对齐。
  //
  // 只转几何，不动 `roadClassOf` 的历史：入口点在世界坐标里挑好再转过去，
  // 因为道路等级查的是世界坐标的边。
  const ca = Math.cos(axis.atan());
  const sa = Math.sin(axis.atan());
  const toLocal = (p: Pt) => new Pt(p.x * ca + p.y * sa, -p.x * sa + p.y * ca);
  const toWorld = (p: Pt) => new Pt(p.x * ca - p.y * sa, p.x * sa + p.y * ca);

  const lat = buildLattice(ring.map(toLocal), {
    cell: u(P.pathCellM),
    // 净空 = 半个路宽 + 6 m。
    // 这个值不能小：A* 只避开"节点本身不合法"，而路的**带宽**会往两侧各伸 w/2。
    // 净空只留 2 m 时，路会贴着界边平行地走，减掉这条带子就在界边侧留下一条
    // 2 m 的碎条 —— 子街坊被切成折返的怪多边形，那一整片就再也放不进楼。
    // 6 m 是"路缘到红线"的常见退距，同时保证切完还剩下能放一栋楼的完整地块。
    clear: w / 2 + u(6),
    turn: P.pathTurn,
    jitter: P.pathJitter,
    axis: new Pt(1, 0),
    gridPenalty: 2,
    seed: Math.floor(Rng.float() * 99991) + 7,
  });

  const entriesLocal = entries.map(toLocal);
  const nets = connectEntries(lat, entriesLocal);
  if (nets.length === 0) return null;

  // 预算：按长度从长到短保留，超预算的丢掉（丢的是支路，主干在最前面）
  const budget = areaU * 0.1;
  const kept: Pt[][] = [];
  let used = 0;
  for (const l of nets) {
    const len = polyLen(l);
    if (used + len * w > budget) continue;
    used += len * w;
    kept.push(l.map(toWorld));
  }
  if (kept.length === 0) kept.push(nets[0].map(toWorld));

  pushZoneDbg({
    key: 'path',
    entries: entries.length,
    lines: kept.length,
    lens: kept.map((l) => +polyLen(l).toFixed(1)),
    cellM: P.pathCellM,
  });
  return kept;
}

/**
 * 折线两头各收掉 len（按弧长），收没了就返回空。
 *
 * 旧实现是"边遍历边判断该不该收"，末尾再用最后一段的中点覆盖 `out` 的最后一项。
 * 直线（只有两段点）时看不出问题；一旦折线有拐弯（A* 内部路的 L 形主干），
 * 遍历到最后一段时 `total - (acc+L) > len` 不成立、于是不 push，
 * 但末尾那句覆盖仍然执行 —— **拐点被替换成最后一段上的一个点**，
 * 折线于是退化成一条从起点直连终点的弦。渲染出来的效果就是：
 * 内部路的沥青和标线不是一条路，而是"一条路 + 一条斜穿全块地的虚线"。
 *
 * 现在改成"从头收一次、再反转从头收一次"，拐点始终保留。
 */
function trimEnds(pts: Pt[], len: number): Pt[] {
  if (pts.length < 2) return pts;
  if (polyLen(pts) <= len * 2 + 1e-6) return [];
  /** 从头部收掉 l 的弧长，保留后面的所有顶点 */
  const cutHead = (list: Pt[], l: number): Pt[] => {
    let acc = 0;
    for (let i = 0; i + 1 < list.length; i++) {
      const a = list[i];
      const b = list[i + 1];
      const L = Pt.distance(a, b);
      if (acc + L <= l) {
        acc += L;
        continue;
      }
      const t = (l - acc) / (L || 1);
      const out: Pt[] = [new Pt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)];
      for (let k = i + 1; k < list.length; k++) out.push(list[k]);
      return out;
    }
    return [];
  };
  const head = cutHead(pts, len);
  if (head.length < 2) return [];
  const tail = cutHead(head.slice().reverse(), len);
  if (tail.length < 2) return [];
  return tail.reverse();
}

function polyLen(pts: Pt[]): number {
  let s = 0;
  for (let i = 0; i + 1 < pts.length; i++) s += Pt.distance(pts[i], pts[i + 1]);
  return s;
}

function distToSegLocal(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L = dx * dx + dy * dy;
  if (L < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / L;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

/**
 * 穿过 p 沿 dir 方向与多边形边的交点里，最远的那个。
 *
 * 交点参量必须用叉积求 **两条边各自的参量** 再分别判 [0,1]。
 * 早先的写法只把 t 代回去除以 ex 求 u0（`(p.x + d.x*t - a.x)/ex`），
 * 遇到竖直边（ex≈0）就除以 1e-9，u0 变成天文数字照样通过区间判定，
 * 于是返回一个离地块上百单位的"出口"，内部路被拉成一条斜穿全城的长条。
 */
function rayExit(ring: Pt[], p: Pt, dir: Pt): Pt | null {
  const L = Math.hypot(dir.x, dir.y) || 1;
  const d = new Pt(dir.x / L, dir.y / L);
  const cross = (vx: number, vy: number, wx: number, wy: number) => vx * wy - vy * wx;
  let best: Pt | null = null;
  let bestT = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const den = cross(d.x, d.y, ex, ey);
    if (Math.abs(den) < 1e-9) continue;
    const ax = a.x - p.x;
    const ay = a.y - p.y;
    const t = cross(ax, ay, ex, ey) / den;
    const u0 = cross(ax, ay, d.x, d.y) / den;
    if (u0 < -1e-6 || u0 > 1 + 1e-6) continue;
    if (t > bestT) {
      bestT = t;
      best = new Pt(p.x + d.x * t, p.y + d.y * t);
    }
  }
  return best;
}

function dedupePath(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const l = out[out.length - 1];
    if (!l || Pt.distance(l, p) > 0.25) out.push(p);
  }
  return out;
}

/**
 * 两个多边形是否重叠（分离轴定理）。
 * 对凸多边形是精确判定；遇到凹多边形可能误判成"相交"，
 * 那只导致少放一栋楼，不会让楼叠在一起，方向上安全。
 */
function ringsOverlap(a: Pt[], b: Pt[]): boolean {
  for (const ring of [a, b]) {
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % ring.length];
      const nx = -(q.y - p.y);
      const ny = q.x - p.x;
      let a0 = Infinity;
      let a1 = -Infinity;
      let b0 = Infinity;
      let b1 = -Infinity;
      for (const t of a) {
        const d = t.x * nx + t.y * ny;
        if (d < a0) a0 = d;
        if (d > a1) a1 = d;
      }
      for (const t of b) {
        const d = t.x * nx + t.y * ny;
        if (d < b0) b0 = d;
        if (d > b1) b1 = d;
      }
      if (a1 <= b0 || b1 <= a0) return false;
    }
  }
  return true;
}

/**
 * 把折线裁到多边形内，端点落在边界上。
 *
 * 内部路的中线为了把带状多边形"切透"，两端各向外多伸了 0.6 单位；
 * 铺装面（多边形）可以被 clipRing 裁掉，但人行道是**描边**的折线（addPath），
 * 不裁就会顺着延长线溢到外面主路上，画面里表现为几条细白线横穿街道。
 */
function clipPath(pts: Pt[], ring: Pt[]): Pt[] {
  if (pts.length < 2 || ring.length < 3) return [];
  const n = ring.length;
  // 从 a 朝 b 走，与环的第一个交点
  const hit = (a: Pt, b: Pt): Pt | null => {
    const rx = b.x - a.x;
    const ry = b.y - a.y;
    let best: Pt | null = null;
    let bt = Infinity;
    for (let i = 0; i < n; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % n];
      const sx = q.x - p.x;
      const sy = q.y - p.y;
      const den = rx * sy - ry * sx;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((p.x - a.x) * sy - (p.y - a.y) * sx) / den;
      const w = ((p.x - a.x) * ry - (p.y - a.y) * rx) / den;
      if (t < -1e-9 || t > 1 + 1e-9 || w < -1e-9 || w > 1 + 1e-9) continue;
      if (t < bt) {
        bt = t;
        best = new Pt(a.x + rx * t, a.y + ry * t);
      }
    }
    return best;
  };

  // 端点/顶点**恰好落在环边界上**时不能只看 `pointInPolygon`：射线法对
  // 边界上的点结果是"看运气"的（取决于这条边的走向），地块切分的割线
  // 两端正好压在街区轮廓上，于是整条巷道会被判成"全在外面"直接丢掉 ——
  // 实测工业街区 76% 的巷子因此消失，地块切开了却没有路。
  const insideOrOn = (p: Pt) => pointInPolygon(p, ring) || distToRing(p, ring) < 1e-3;
  const out: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (insideOrOn(p)) {
      out.push(p);
      continue;
    }
    const prevIn = i > 0 && insideOrOn(pts[i - 1]);
    const nextIn = i + 1 < pts.length && insideOrOn(pts[i + 1]);
    if (prevIn) {
      const h = hit(pts[i - 1], p);
      if (h) out.push(h);
    } else if (nextIn) {
      const h = hit(pts[i + 1], p);
      if (h) out.push(h);
    }
  }
  return out;
}

/**
 * 内部路断面：沥青车行道（7 m）+ 两侧人行道（1.5 m）+ 虚线中线 + 端头停止线。
 *
 * 铺装高度分层（同一块地范围内，只靠 y 差避免 z-fighting）：
 *   0.0115 人行道 / 绿地 / 其他地块铺装
 *   0.0125 车行道
 *   0.017  内部路标线
 *   0.03   车位线 / 装卸位标线
 *
 * 车行道不再"逐段一块块铺"，而是交给 `drawRoadBands` 并集成一块 —— 路口
 * 是一整片连续沥青，和城市路网的路口是同一套建模思路。
 */
/**
 * 内部路车行道的统一标高。
 *
 * 必须高于**地块自己铺的东西**：硬质基底 0.012、绿地 0.0126。
 * 内部路是把地块切开的，但地块多边形是按"中线切"的 —— 切完的两块地
 * 各自还会在整块范围内铺基底 / 绿格，路口和路边就这么被盖住了。
 * 之前这里是 0.0125，压不过 0.0126 的绿地，于是路面上长出一块块草绿色
 * （用户截图里那些"浅色小块"）。抬到 0.0134：越过绿地和硬质，仍在
 * 车位线（0.0305）与标线（0.017）之下。
 */
const Y_INNER_ROAD = 0.0134;

function drawInternalRoad(c: Ctx, sp: Spine, sink?: RoadBand[]) {
  const ring = Array.from(c.block);
  const Y_MARK = 0.017;
  const W_CENTER = 0.026;

  // 路面必须裁到地块内：内部路只在封闭区域里存在，不能溢出到邻居地块上
  //
  // 传了 sink 就只登记、不当场铺 —— 调用方要把内部主路和后面切出来的巷道
  // 放在**同一个并集**里成面，否则"巷道 ↔ 主路"的路口仍然是两张共面平面叠着。
  const bands: RoadBand[] = sp.lines.map((pts) => ({
    pts,
    w: sp.w,
    mat: 'asphalt' as MatKey,
    y: Y_INNER_ROAD,
  }));
  if (sink) sink.push(...bands);
  else drawRoadBands(c, bands);

  // 人行道：沿中线两侧各一条 1.5 m 的窄带（先裁到地块内再描边）
  for (const raw of sp.lines) {
    const line = clipPath(raw, ring);
    for (let i = 0; i + 1 < line.length; i++) {
      const a = line[i];
      const b = line[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const L = Math.hypot(dx, dy) || 1;
      const nx = (-dy / L) * (sp.w / 2 + u(1.5) / 2);
      const ny = (dx / L) * (sp.w / 2 + u(1.5) / 2);
      // 人行道压在沥青**之下**（0.0115 < 0.0125）：两条内部路交叉处，
      // 人行道必然横穿对方车行道，若画在上面就会在路口撕出一道浅色楔子，
      // 看上去像路口铺了一块错位的混凝土。
      addPath(c, 'zone_walk', [new Pt(a.x + nx, a.y + ny), new Pt(b.x + nx, b.y + ny)], u(1.5), 'concrete', 0.0115);
      addPath(c, 'zone_walk', [new Pt(a.x - nx, a.y - ny), new Pt(b.x - nx, b.y - ny)], u(1.5), 'concrete', 0.0115);
    }
  }

  // 中线虚线：只给主路（第一条）画。支路各画一条就成了满图短线，
  // 而且 7 m 的内部路本来也不需要双侧车道线。
  // 中线虚线两头各退 2.5 m：退到停止线之前，不能一直画到街心去
  //
  // `lines` 可以是空的（地块小到打不出主路时），这时中线整段跳过。
  const main = sp.lines.length > 0 ? trimEnds(clipPath(sp.lines[0], ring), u(2.5)) : [];
  for (const [a, b] of dashPath(main, 0.5, 0.42)) {
    const s = stripe(a, b, W_CENTER);
    if (s) addSurface(c, 'zone_center', s, 'markWhite', Y_MARK, false);
  }

  // 端头停止线：内部路是"接入外部路"的支路，出口处画一条横贯车行道的白实线
  // （GB 5768.3：支路进主干路设停止线）。不画的话，内部路到了界边就断成一截灰带，
  // 接不接得上全靠读者自己脑补。
  for (const line of sp.lines) {
    for (const end of [0, 1]) {
      const p = end === 0 ? line[0] : line[line.length - 1];
      const q = end === 0 ? line[1] : line[line.length - 2];
      if (!p || !q) continue;
      const dx = p.x - q.x;
      const dy = p.y - q.y;
      const L = Math.hypot(dx, dy) || 1;
      const back = new Pt(p.x - (dx / L) * u(1.2), p.y - (dy / L) * u(1.2));
      const s = stripe(back, new Pt(p.x, p.y), sp.w * 0.92);
      if (!s) continue;
      // 停止线是"横贯车道"的一条细带，不是一条粗棒：取 stripe 的两个远端点内缩
      const dx2 = dx / L;
      const dy2 = dy / L;
      const nx = -dy2;
      const ny = dx2;
      const half = (sp.w * 0.92) / 2;
      const w2 = 0.075;
      const quad = [
        new Pt(back.x + nx * half, back.y + ny * half),
        new Pt(back.x - nx * half, back.y - ny * half),
        new Pt(back.x - nx * half + dx2 * w2, back.y - ny * half + dy2 * w2),
        new Pt(back.x + nx * half + dx2 * w2, back.y + ny * half + dy2 * w2),
      ];
      addSurface(c, 'zone_stop', quad, 'markWhite', Y_MARK, false);

      // ---- 出入口：把内部路真的接到外部车行道上。
      //
      // 地块边界 = 外部道路的**红线**，从红线到车行道之间还隔着一条人行道 +
      // 一条绿化带（2~5 m）。之前这里铺一块 2.6 m 的混凝土就收工，结果内部路
      // 的沥青到红线就断了，后面靠一块浅色混凝土"搭桥"—— 放大看正像两块
      // 模型叠在一起，而不是一条路连出去。
      //
      // 现在做两件事：
      //   1. 引道用**沥青**，长度直接压到车行道边沿（sw + vg 最多 5 m），
      //      颜色和车行道连续，读起来是同一条路面；
      //   2. 把开口登记到 model.driveways，道路层铺人行道 / 绿化带时在这里断开。
      //      不断开的话，绿色带和灰色人行道会横穿引道，沥青被压成一段"地下通道"。
      const apron = new Pt(p.x + (dx / L) * u(5.4), p.y + (dy / L) * u(5.4));
      const ap = stripe(back, apron, sp.w * 0.98);
      if (ap) addSurface(c, 'zone_mouth', ap, 'asphalt', Y_INNER_ROAD + 0.0002, false);

      if (withinRing(p, ring, u(0.5))) {
        const ox = dx / L;
        const oy = dy / L;
        const nx = -oy;
        const ny = ox;
        const halfW = sp.w * 0.5 + u(0.55);
        const inb = u(0.9);
        const outb = u(3.6);
        c.model.driveways.push([
          new Pt(p.x - ox * inb + nx * halfW, p.y - oy * inb + ny * halfW),
          new Pt(p.x + ox * outb + nx * halfW, p.y + oy * outb + ny * halfW),
          new Pt(p.x + ox * outb - nx * halfW, p.y + oy * outb - ny * halfW),
          new Pt(p.x - ox * inb - nx * halfW, p.y - oy * inb - ny * halfW),
        ]);
      }
    }
  }
}

/** 折线按弧长打成虚线，返回若干短线段 */
function dashPath(pts: Pt[], dash: number, gap: number): [Pt, Pt][] {
  const out: [Pt, Pt][] = [];
  if (pts.length < 2) return out;
  let phase = 0; // 0..dash 在实线段里，(dash+dash+gap) 用取模循环
  const period = dash + gap;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const L = Pt.distance(a, b);
    if (L < 1e-9) continue;
    const dir = new Pt((b.x - a.x) / L, (b.y - a.y) / L);
    let s = 0;
    while (s < L) {
      const ph = phase % period;
      const inDash = ph < dash;
      const rest = inDash ? dash - ph : period - ph;
      const step = Math.min(rest, L - s);
      if (inDash && step > 1e-3) {
        out.push([
          new Pt(a.x + dir.x * s, a.y + dir.y * s),
          new Pt(a.x + dir.x * (s + step), a.y + dir.y * (s + step)),
        ]);
      }
      s += step;
      phase += step;
      if (step < 1e-6) break;
    }
  }
  return out;
}


/**
 * 沿内部路两侧排建筑：退让 clear（建筑外墙到车行道边缘），
 * 每栋的四个角必须都在大地块内、且不压已有建筑。
 * `skip` 是留给停车场的那块子街坊 —— 落进去的楼直接不排。
 */
interface RowOpts {
  /** 建筑退让（外墙到车行道边缘） */
  clear: number;
  /** 沿街排布的步距 */
  step: number;
  /** 面宽范围 */
  bw: [number, number];
  /** 进深范围 */
  bd: [number, number];
  /** 层高范围 */
  h: [number, number];
  /** 随机空当概率：连排贴满会读成一堵墙 */
  gap: number;
  /** 不许压的走廊（组团路的路口 / 引道），楼不能堵住路口 */
  avoid?: Pt[][];
}

function buildingsAlongSpine(c: Ctx, sp: Spine, skip: Pt[] | null, opts: Partial<RowOpts> = {}) {
  const o: RowOpts = {
    // 6~7 层的板楼：内部主路两侧的楼应该比小区内部的楼更"实"一点
    clear: u(3.0),
    step: 1.9,
    bw: [1.15, 1.85],
    bd: [1.0, 1.6],
    h: [1.3, 3.5],
    gap: 0.22,
    ...opts,
  };
  const skipRing = skip ? Array.from(skip) : null;
  const blockRing = Array.from(c.block);
  let placed = 0;
  for (const line of sp.lines)
    for (let i = 0; i + 1 < line.length; i++) {
      const a = line[i];
      const b = line[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const L = Math.hypot(dx, dy) || 1;
      const dir = new Pt(dx / L, dy / L);
      const nrm = new Pt(-dir.y, dir.x);
      for (let t = 0.9; t < L - 0.7; t += o.step) {
        const base = new Pt(a.x + dir.x * t, a.y + dir.y * t);
        for (const side of [-1, 1]) {
          if (Rng.bool(o.gap)) continue; // 留空当：不是连排贴满，中间要有出入口和空地
          const bw = o.bw[0] + Rng.float() * (o.bw[1] - o.bw[0]);
          const bd = o.bd[0] + Rng.float() * (o.bd[1] - o.bd[0]);
          const off = sp.w / 2 + o.clear + bd / 2;
          const ctrB = new Pt(base.x + nrm.x * off * side, base.y + nrm.y * off * side);
          if (skipRing && skipRing.length >= 3 && pointInPolygon(ctrB, skipRing)) continue;
          const cor = [
            new Pt(ctrB.x - dir.x * bw * 0.5 - nrm.x * bd * 0.5, ctrB.y - dir.y * bw * 0.5 - nrm.y * bd * 0.5),
            new Pt(ctrB.x + dir.x * bw * 0.5 - nrm.x * bd * 0.5, ctrB.y + dir.y * bw * 0.5 - nrm.y * bd * 0.5),
            new Pt(ctrB.x + dir.x * bw * 0.5 + nrm.x * bd * 0.5, ctrB.y + dir.y * bw * 0.5 + nrm.y * bd * 0.5),
            new Pt(ctrB.x - dir.x * bw * 0.5 + nrm.x * bd * 0.5, ctrB.y - dir.y * bw * 0.5 + nrm.y * bd * 0.5),
          ];
          if (!cor.every((p) => pointInPolygon(p, blockRing))) continue;
          if (o.avoid && o.avoid.some((av) => ringsOverlap(cor, av))) continue;
          // 压盖判定用分离轴定理：只测"角点在多边形内"会漏掉十字交叉、
          // 或一栋楼的边穿过另一栋但四个角都在外面的情况，排出来就是连成一片的疙瘩。
          if (c.footprints.some((fp) => ringsOverlap(cor, fp))) continue;
          const ok = placeProto(
            c,
            {
              ring: cor,
              h: o.h[0] + Rng.float() * (o.h[1] - o.h[0]),
              wall: Rng.bool(0.5) ? 'wallBrick' : 'wallConcrete',
              roof: Rng.bool(0.5) ? 'roofLight' : 'roofFlat',
              kind: 'house',
            },
            `zone_bld_${placed++}`
          );
          if (ok) c.footprints.push(ok);
        }
      }
    }
}

/**
 * 用内部路的带状多边形把大地块切成 2~4 个子街坊，按面积降序。
 * 每个子街坊都至少有一边贴着内部路 —— 这是"建筑沿内部路边缘摆放"的几何前提。
 */
function subBlocks(c: Ctx, sp: Spine): Pt[][] {
  const ring = Array.from(c.block);
  const strips: Pt[][] = [];
  for (const line of sp.lines) {
    for (let i = 0; i + 1 < line.length; i++) {
      const s = stripe(line[i], line[i + 1], sp.w);
      if (s) strips.push(s);
    }
  }

  // 逐条切，不要一次把全部带状多边形丢给布尔运算。
  // polygon-clipping 的扫描线在多条互相穿插的带子上容易收不出完整输出环：
  // 要么只吐出其中几块（地块总面积凭空少一半），要么直接抛错退回"没切"。
  // 一条一条切，每次的被减对象都更小更规整，失败也只丢一刀，不会全盘作废。
  let cur: Pt[][] = [ring];
  for (const s of strips) {
    const next: Pt[][] = [];
    for (const piece of cur) {
      const cut = subtract(piece, [s]).filter((p) => p.length >= 3 && Math.abs(area(p)) > 0.5);
      if (cut.length === 0) next.push(piece); // 这一刀没切开或切失败，保留原块
      else next.push(...cut);
    }
    cur = next;
  }

  // 清洗：布尔运算会把"几乎共线的两段"切成一个 1e-3 宽的尖刺
  // （顶点 A→B→A 这种往返对），这些尖刺让 insetRing 的斜接偏移炸出上百单位的尖角，
  // 偏移环自交，面积算出两三个平方，下游任何"按面积内缩"的算法全部失效。
  //
  // 还要再验一次自交：A* 内部路有可能贴着一侧的界边走（路中心离界边只有一个净空），
  // 于是减掉这条带子后会在界边侧留下一条 2 m 宽的碎条，布尔运算在这种"两瓣都极窄"
  // 的输入上会吐出折返的环。这种环面积是正的、点数看着也正常（7~9 个），
  // 但后面 `intersect` 一律返回空 —— 表现出来就是"这一大片子街坊一栋楼都没有"。
  const parts = cur
    .map((p) => cleanRing(p))
    .filter((p) => p.length >= 3 && Math.abs(area(p)) > 0.6 && isSimpleRing(p));
  parts.sort((p, q) => Math.abs(area(q)) - Math.abs(area(p)));
  // 切不出来（布尔失败 / 路太窄）也得给一块，否则整个禁绘区只剩草地
  return parts.length > 0 ? parts : [ring];
}

/**
 * 用一条无限长直线（过 p 沿 dir）把多边形切成两瓣。
 *
 * 返回两瓣 + **落在多边形内的那条割线**。割线不是事后求出来的辅助数据：
 * 它是两瓣的公共边界，直接拿去铺巷道，所以"地块分界线"和"地块内的路"
 * 在几何上是同一条线，永远不会错开。
 *
 * 半平面用"两倍跨度的大矩形"表达（而不是把每条边延长求交）：
 * 凹多边形延长边会切出多瓣，`intersect` 收出几条散片，parcel 就丢了；
 * 大矩形是凸的且必然包住整个多边形，布尔结果一定是恰好两瓣。
 */
function bisectRing(ring: Pt[], p: Pt, dir: Pt): { a: Pt[]; b: Pt[]; seg: Pt[] } | null {
  const L = Math.hypot(dir.x, dir.y);
  if (L < 1e-9) return null;
  const d = new Pt(dir.x / L, dir.y / L);
  const n = new Pt(-d.y, d.x);
  const R = Math.max(spanOf(ring) * 2.2, 1);
  const half = (sign: number): Pt[] => {
    // 沿法向让开 1e-4：线正好压在多边形顶点上时，布尔运算会吐出一个零宽碎瓣
    const ox = p.x + n.x * sign * 1e-4;
    const oy = p.y + n.y * sign * 1e-4;
    const tx = d.x * R;
    const ty = d.y * R;
    const sx = n.x * sign * R;
    const sy = n.y * sign * R;
    return [
      new Pt(ox - tx, oy - ty),
      new Pt(ox + tx, oy + ty),
      new Pt(ox + tx + sx, oy + ty + sy),
      new Pt(ox - tx + sx, oy - ty + sy),
    ];
  };
  const biggest = (parts: Pt[][]): Pt[] | null => {
    let best: Pt[] | null = null;
    let bestA = 0;
    for (const q of parts) {
      if (q.length < 3) continue;
      const a = Math.abs(area(q));
      if (a > bestA) {
        bestA = a;
        best = q;
      }
    }
    return best;
  };
  const A = biggest(intersect(ring, half(1), 0.05));
  const B = biggest(intersect(ring, half(-1), 0.05));
  if (!A || !B) return null;
  if (Math.abs(area(A)) < 0.05 || Math.abs(area(B)) < 0.05) return null;
  const e1 = rayExit(ring, p, d);
  const e2 = rayExit(ring, p, new Pt(-d.x, -d.y));
  if (!e1 || !e2) return null;
  const a = cleanRing(A);
  const b = cleanRing(B);
  if (a.length < 3 || b.length < 3) return null;
  return { a, b, seg: [e2, e1] };
}

// ---------------------------------------------------------------- 沿街面宽切分

/**
 * 街区主轴（弧度）：**最长的那条边界边**的方向。
 *
 * 地块切分只认这一个方向。旧版用的是"城市全局轴 + 禁建区边角"，可张量场
 * 切出来的街区经常是斜的平行四边形 —— 拿全局轴去切，地块边界与街区边界
 * 夹角 20~40°，于是每一块地都是楔形，退线后楼是斜的，巷道也斜穿街区。
 *
 * 最长边是街区里最稳定的一根参照：它一定是一条城市道路，地块沿它排布，
 * 就等于"沿街"。
 */
function blockAxis(ring: Pt[]): number {
  let best = 0;
  let ang = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const L = Pt.distance(a, b);
    if (L > best) {
      best = L;
      ang = Math.atan2(b.y - a.y, b.x - a.x);
    }
  }
  // 折到 (-90°, 90°]：一条边的方向与反向是同一条轴
  while (ang > Math.PI / 2) ang -= Math.PI;
  while (ang <= -Math.PI / 2) ang += Math.PI;
  return ang;
}

/**
 * 街区主轴，**优先取真的临街边**。
 *
 * `blockAxis` 取最长边，前提是"最长的那条边一定是一条城市道路"。这个前提在
 * **贴着禁建区**的街区上不成立：街区被禁区切掉一角之后，最长边往往就是禁区
 * 那条斜轮廓线，于是整块地被顺着禁区方向切成一条条楔形带 —— 从空中看就是
 * "禁区拿一条直线把城市切开"，也就是"禁建区的直线避让变差了"。
 *
 * 这里先挑出真正压在 patch 边界上的边（= 城市道路的红线），用其中最长的一条
 * 定方向；一条都没有（封闭地块 / 内部街区）才退回 `blockAxis`。
 *
 * 对普通街区完全无副作用：它们的最长边本来就是临街边，两种取法结果相同。
 */
function streetAxis(c: Ctx, ring: Pt[]): number {
  const patch = Array.from(c.patch.shape);
  if (patch.length < 3) return blockAxis(ring);
  const tol = u(1.5);
  let best = 0;
  let ang = NaN;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const L = Pt.distance(a, b);
    if (L <= best) continue;
    const mid = new Pt((a.x + b.x) / 2, (a.y + b.y) / 2);
    if (distToRing(mid, patch) > tol) continue;
    best = L;
    ang = Math.atan2(b.y - a.y, b.x - a.x);
  }
  if (!Number.isFinite(ang)) return blockAxis(ring);
  while (ang > Math.PI / 2) ang -= Math.PI;
  while (ang <= -Math.PI / 2) ang += Math.PI;
  return ang;
}

/**
 * 按**沿街面宽**切分街区。取代旧的"按面积递归二分"。
 *
 * 为什么换算法（用户核对意见）：
 *   · 旧算法只约束面积，同样 40 单位² 的地块可以是 22×22 m，也可以是
 *     60×7 m 的窄条 —— 后者退线完就是一栋超长的薄楼。`strip` 平行条带
 *     模式更是把这条路径走到极致，所以整个模式被删掉了。
 *   · 真实地块的划分依据是**面宽**：沿街 20~35 m 一块，进深 30~45 m。
 *     所以这里先在沿街方向按面宽排布，再在进深方向按上限横切一刀。
 *
 * 结果是一张跟着街区主轴走的网格：
 *   · 沿街方向每 `frontage` 一刀 → 每块地都有一条临街边（这是可达性的前提）；
 *   · 进深超过 `maxDepth` 就横切一刀 → 后排地块（有后巷接进来）；
 *   · 每个切点可以带 ±15% 的抖动，避免全城是尺规画出来的方格。
 */
export function frontagePartition(
  ring: Pt[],
  o: {
    /** 沿街面宽（u） */
    frontage: number;
    /** 进深上限（u），超过就横切一刀 */
    maxDepth: number;
    /** 沿街方向（rad） */
    ang0: number;
    /** 切点抖动比例 0~0.4：0 = 严格等分 */
    jitter?: number;
    /** 目标块数（手动指定"这块地切成 N 块"时用）：有它就按块数反推网格 */
    count?: number;
    /** 单块最小面积，小于它的碎块并回邻居 */
    minA?: number;
  }
): { parcels: Pt[][]; seams: { pts: Pt[]; depth: number }[] } {
  const seams: { pts: Pt[]; depth: number }[] = [];
  if (ring.length < 3) return { parcels: [ring], seams };
  const ux = Math.cos(o.ang0);
  const uy = Math.sin(o.ang0);
  // 进深方向 = 沿街方向逆时针转 90°
  const vx = -uy;
  const vy = ux;
  const projU = (p: Pt) => p.x * ux + p.y * uy;
  const projV = (p: Pt) => p.x * vx + p.y * vy;
  const jit = clamp(o.jitter ?? 0.15, 0, 0.4);
  const minA = o.minA ?? 0.4;

  const rangeOf = (r: Pt[], ax: (p: Pt) => number) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of r) {
      const q = ax(p);
      if (q < lo) lo = q;
      if (q > hi) hi = q;
    }
    return [lo, hi] as [number, number];
  };

  /** 沿 `u = U` 切一刀（刀口方向是进深方向） */
  const cutAtU = (r: Pt[], U: number) => {
    const ctr = ringCenter(r);
    const off = U - projU(ctr);
    return bisectRing(r, new Pt(ctr.x + ux * off, ctr.y + uy * off), new Pt(vx, vy));
  };
  /** 沿 `v = V` 切一刀（刀口方向是沿街方向） */
  const cutAtV = (r: Pt[], V: number) => {
    const ctr = ringCenter(r);
    const off = V - projV(ctr);
    return bisectRing(r, new Pt(ctr.x + vx * off, ctr.y + vy * off), new Pt(ux, uy));
  };

  const [u0, u1] = rangeOf(ring, projU);
  const [v0, v1] = rangeOf(ring, projV);
  const W = u1 - u0;
  const D = v1 - v0;
  if (!(W > 1e-3) || !(D > 1e-3)) return { parcels: [ring], seams };
  // 块数取"装得下几个面宽"再四舍五入，偏向上取整半档：
  // W/面宽 = 1.4 时该切两块（各 0.7 面宽 ≈ 18 m），不该退回一整块。
  // 只用 round 的话 1.4 会向下取成 1，整块地不切分 —— 实测工业街区
  // 有 80% 因此退回"整块一栋"，沿街带铺了、地块却没分开。
  let nU = clamp(Math.round(W / o.frontage + 0.15), 1, 8);
  let nV = clamp(Math.round(D / Math.max(o.maxDepth, 1e-3) + 0.15), 1, 6);
  // 手动指定块数：面宽 / 进深都给不出这个数时，按块数反推网格，
  // 并保持地块的长宽比接近街区本身（否则 8 块会变成 8 条细带）。
  if (o.count && o.count > 1) {
    const want = clamp(Math.round(o.count), 2, 24);
    nU = clamp(Math.round(Math.sqrt((want * W) / Math.max(D, 1e-3))), 1, 8);
    nV = clamp(Math.round(want / nU), 1, 6);
    // 乘积离目标还远时补一档（例如 want=8 但只排到 6）
    while (nU * nV < want && nU < 8) nU++;
  }

  // ① 沿街方向切：每条刀都从临街边切进街区，切完得到 nU 条"纵条"
  let strips: Pt[][] = [ring];
  for (let i = 1; i < nU; i++) {
    const U = u0 + (W * (i + (Rng.float() - 0.5) * jit * 2)) / nU;
    const next: Pt[][] = [];
    for (const st of strips) {
      const cut = cutAtU(st, U);
      if (!cut) {
        next.push(st);
        continue;
      }
      const lo = projU(ringCenter(cut.a)) < projU(ringCenter(cut.b)) ? cut.a : cut.b;
      const hi = lo === cut.a ? cut.b : cut.a;
      if (Math.abs(area(lo)) < minA || Math.abs(area(hi)) < minA) {
        next.push(st);
        continue;
      }
      next.push(lo, hi);
      seams.push({ pts: cut.seg, depth: 0 });
    }
    strips = next;
  }

  // ② 进深方向切：纵条太长就横一刀，切出前 / 后排
  const parcels: Pt[][] = [];
  for (const st of strips) {
    let rows: Pt[][] = [st];
    for (let j = 1; j < nV; j++) {
      const next: Pt[][] = [];
      for (const r of rows) {
        const [r0, r1] = rangeOf(r, projV);
        const rd = r1 - r0;
        // 自动路径：这一条本来就够浅就不切（进深上限是"别切出深院子"的闸）。
        // 手动指定块数时不设这道闸 —— 用户明确要求"这块地切成 N 块"，
        // 再按进深把它挡住，滑杆就成了摆设。
        if (!o.count && rd < o.maxDepth * 1.15) {
          next.push(r);
          continue;
        }
        const V = r0 + (rd * (j + (Rng.float() - 0.5) * jit * 2)) / nV;
        const cut = cutAtV(r, V);
        if (!cut) {
          next.push(r);
          continue;
        }
        const lo = projV(ringCenter(cut.a)) < projV(ringCenter(cut.b)) ? cut.a : cut.b;
        const hi = lo === cut.a ? cut.b : cut.a;
        if (Math.abs(area(lo)) < minA || Math.abs(area(hi)) < minA) {
          next.push(r);
          continue;
        }
        next.push(lo, hi);
        seams.push({ pts: cut.seg, depth: 1 });
      }
      rows = next;
    }
    parcels.push(...rows);
  }

  if (parcels.length < 2) return { parcels: [ring], seams: [] };
  return { parcels, seams };
}

/**
 * 这一块地里**贴着街区边界**的那些边 = 临街边。
 *
 * 判定靠"边的中点到街区轮廓的距离"。地块的边只有两个来源：街区轮廓本身，
 * 或者切分刀口。刀口落在街区内部，中点离轮廓有相当距离，所以这个判据足够稳。
 * 唯一的漏网是刀口正好擦过轮廓角点，那种边界上的碎边也会被算进来 ——
 * 它的长度通常 < 0.5 u，用一个长度下限挡掉。
 */
function streetEdgesOf(parcel: Pt[], blockRing: Pt[], zones: Pt[][] = [], pad = 0): { a: Pt; b: Pt }[] {
  const out: { a: Pt; b: Pt }[] = [];
  for (let i = 0; i < parcel.length; i++) {
    const a = parcel[i];
    const b = parcel[(i + 1) % parcel.length];
    if (Pt.distance(a, b) < 0.5) continue;
    const mid = new Pt((a.x + b.x) / 2, (a.y + b.y) / 2);
    if (distToRing(mid, blockRing) >= 0.08) continue;
    // 贴禁建区的那条边**不是街**。
    //
    // 街区被禁区裁掉一角后，剩下那条斜边也"压在街区轮廓上"，按上面的判据会被
    // 当成临街面 —— 于是前场带、路缘石线、街角树全沿着禁区那条斜线长出来，
    // 车行道明明已经让开了，禁区边上却多出一圈装饰，读起来就是"禁区拿直线
    // 把城市切了一刀、还镶了道牙子"。用户说的"直线避让变差"就是它。
    //
    // 车行道那边早就有这条规则（`road/system.ts` 按让距丢边），这里补齐。
    if (zones.length > 0) {
      let near = false;
      for (const ring of zones) {
        if (distToRing(mid, ring) < Math.max(pad, 0)) {
          near = true;
          break;
        }
      }
      if (near) continue;
    }
    out.push({ a, b });
  }
  return out;
}

/**
 * 张量分割：把一个子街坊递归二分到"一个开发地块的大小"。
 *
 * 与城市级那条链（场 → 流线 → 面）的对应关系：
 *   - **方向**来自张量场：第一刀取 `spine.ang + 90°`（垂直于一级内部路），
 *     之后逐级正交 —— 真实街区的中层结构就是正交的，场只负责把"这一片整体
 *     转到哪个角度"定下来。让每一刀都重新采样场的代价是切出歪七扭八的尖楔子，
 *     上一版沿场积分就是这样把建筑覆盖率打到 52% 的。
 *   - **位置**由"面积 + 抖动"定：每刀都过质心切，切出来是练习册；
 *     偏 26% 跨度以内随机，大小瓣悬殊一点，读起来才像地籍划分。
 *   - **分割线**是 `bisectRing` 的公共边界，原样拿去铺巷道。
 */
/**
 * 地块切分模式。
 *
 * 类型本身定义在 `params.ts`：参数面板要按比重分配、选中地块要单选一块、
 * 链接快照要序列化，三处都得认识它，放在生成器里会绕出循环依赖。
 * 这里重导出一次，老调用方（`import type { ParcelPattern } from './modern'`）不受影响。
 */
export type { ParcelPattern } from './params';

/**
 * 这一块地该用哪种切法。
 *
 * **单块指定优先**：用户在「选中地块 → 切分模式」里点了某种切法，就用它，
 * 不再掷骰子。不指定时按 `block.parcelPatterns` 的相对权重抽一个。
 *
 * 注意：不抽签时**不消耗随机数**。地块几何各自跑在按 `种子+地块键` 派生的
 * 私有流里（见 model.buildGeometry），所以少抽一次只影响这一块，邻居照旧。
 */
function pickParcelPattern(c: Ctx): ParcelPattern {
  const forced = c.patch.override?.pattern;
  if (forced) return forced;
  const w = c.model.params.block.parcelPatterns;
  // 只有四种模式。`strip`（平行条带）已被移除：同向连切只会切出贯通全街区的
  // 窄条，进深 60~90 m，退线后就是一栋超长薄楼 —— 用户核对意见里的"不合理"。
  // `field` 也不再是"每刀重采样张量场"，而是"跟随街区主轴"。
  const items: [ParcelPattern, number][] = [
    ['ortho', w.ortho],
    ['diag', w.diag],
    ['free', w.free],
    ['field', w.field ?? 0],
  ];
  const total = items.reduce((s, [, v]) => s + Math.max(0, v ?? 0), 0);
  if (!(total > 0)) return 'ortho';
  let r = Rng.float() * total;
  for (const [k, v] of items) {
    r -= Math.max(0, v ?? 0);
    if (r <= 0) return k;
  }
  return 'ortho';
}

export function tensorPartition(
  ring: Pt[],
  opts: {
    targetA: number;
    minA: number;
    maxDepth: number;
    ang0: number;
    pattern?: ParcelPattern;
  }
): { parcels: Pt[][]; seams: { pts: Pt[]; depth: number }[] } {
  const parcels: Pt[][] = [];
  const seams: { pts: Pt[]; depth: number }[] = [];
  const pattern = opts.pattern ?? 'ortho';

  // 斜切：入口那层先偏 45°，之后照常正交 —— 这样切出来的是"斜向街坊里
  // 一格格正交地块"，而不是把整个街区转 45° 后切出满屏菱形。
  const baseAng = pattern === 'diag' ? opts.ang0 + Math.PI / 4 : opts.ang0;

  /**
   * 这一刀切完之后，下一刀该朝哪。
   *
   * 只有 `free` 会在这里偏：每刀在正交方向上抖 ±20°，切出楔形 / 不规则地块。
   * 其余模式一律严格交替 90°。
   *
   * 旧版的 `field` 分支会在这里重新采样城市张量场，让地块边界跟着场转 ——
   * 用户核对意见："张量场模式对街区内路和建筑的形态影响不正确"。
   * 场在街区内部是虚的（X 型退化节点），采出来的方向常与街区四边斜交，
   * 于是内部巷道斜穿街区、建筑被掰成斜的平行四边形。已删除这条分支，
   * 地块切分只认"街区自己的方向"（`planParcels` 里由 `blockAxis` 给出）。
   */
  const nextAng = (ang: number): number => {
    if (pattern === 'free') return ang + Math.PI / 2 + (Rng.float() - 0.5) * 0.7;
    return ang + Math.PI / 2;
  };

  const walk = (r: Pt[], depth: number, ang: number) => {
    const a = Math.abs(area(r));
    if (a < 1e-6) return;
    if (depth >= opts.maxDepth || a <= opts.targetA) {
      parcels.push(r);
      return;
    }
    const ctr = ringCenter(r);
    const dir = new Pt(Math.cos(ang), Math.sin(ang));
    const span = spanOf(r);
    // 抖动幅度：正交保留 26% 的"地籍感"抖动（刀口不总在正中），
    // `free` 再放开到 30%。
    const jitterK = pattern === 'free' ? 0.3 : 0.26;
    const off = (Rng.float() - 0.5) * span * jitterK;
    const cut = bisectRing(r, new Pt(ctr.x + dir.x * off, ctr.y + dir.y * off), dir);
    if (!cut) {
      pushZoneDbg({ key: 'bisectFail', a: +a.toFixed(1), depth, pts: r.length });
      parcels.push(r);
      return;
    }
    // 切出一瓣比 minA 还小：这一刀不值（一条巷道换来一块放不下楼的碎片）
    if (Math.min(Math.abs(area(cut.a)), Math.abs(area(cut.b))) < opts.minA) {
      pushZoneDbg({ key: 'bisectThin', a: +a.toFixed(1), depth, small: +Math.min(Math.abs(area(cut.a)), Math.abs(area(cut.b))).toFixed(1) });
      parcels.push(r);
      return;
    }
    seams.push({ pts: cut.seg, depth });
    const nAng = nextAng(ang);
    walk(cut.a, depth + 1, nAng);
    walk(cut.b, depth + 1, nAng);
  };

  walk(ring, 0, baseAng);
  return { parcels, seams };
}

/**
 * 沿分割线铺巷道。
 *
 * 材料是混凝土（不是沥青）：它是一条"地块之间的服务性通道"，不是城市道路，
 * 颜色压得比车行道浅一档，俯视图上一眼能分清"路 / 巷 / 铺装"三层。
 *
 * 高度 0.0128：石材底是 0.012，巷道必须压在它上面 ——
 * 第一版写成 0.012（和底图同层），12 条巷子一条都看不见，白改了。
 * 巷道的端点是子街坊的边界，也就是一层内部路的**路边**，
 * 所以不会盖到沥青上去，不必担心 0.0128 > 0.0125 这件事。
 */
/**
 * 铺一段折线带（**整条一次成形**）。
 *
 * 用户核对意见："内部路的颜色统一，最好也和路网一样，统一生成，
 * 不要这样拼凑在一起" —— 原来是**逐段**各画一条矩形，段与段之间留着
 * 抗锯齿的缝，俯视图上一段一段像拼贴；而且每段独立着色，光照略有差别。
 * 现在整条折线一次生成一个多边形，颜色与接缝都跟城市道路一致。
 */
function bandPolygon(pts: Pt[], w: number): Pt[] | null {
  if (pts.length < 2) return null;
  const hw = w / 2;
  const left: Pt[] = [];
  const right: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    // 每个点取前后两段法线的平均（拐角处用斜接，避免出现缺口）
    const prev = pts[i - 1] ?? pts[i];
    const next = pts[i + 1] ?? pts[i];
    let nx = 0;
    let ny = 0;
    const segs: [Pt, Pt][] = [];
    if (i > 0) segs.push([prev, pts[i]]);
    if (i + 1 < pts.length) segs.push([pts[i], next]);
    for (const [a, b] of segs) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const L = Math.hypot(dx, dy);
      if (L < 1e-9) continue;
      nx += -dy / L;
      ny += dx / L;
    }
    const nl = Math.hypot(nx, ny);
    if (nl < 1e-9) continue;
    nx /= nl;
    ny /= nl;
    // 斜接补偿：法线夹角越大，偏移要按 1/cos 放大
    const prevN = i > 0 ? norm(pts[i - 1], pts[i]) : null;
    const nextN = i + 1 < pts.length ? norm(pts[i], pts[i + 1]) : null;
    let scale = 1;
    if (prevN && nextN) {
      const dot = Math.max(-1, Math.min(1, prevN.x * nextN.x + prevN.y * nextN.y));
      const cosHalf = Math.sqrt((1 + dot) / 2);
      scale = cosHalf > 0.35 ? 1 / cosHalf : 2.8;
    }
    left.push(new Pt(pts[i].x + nx * hw * scale, pts[i].y + ny * hw * scale));
    right.push(new Pt(pts[i].x - nx * hw * scale, pts[i].y - ny * hw * scale));
  }
  if (left.length < 2) return null;
  return [...left, ...right.reverse()];
}

function norm(a: Pt, b: Pt): Pt {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L = Math.hypot(dx, dy) || 1;
  return new Pt(dx / L, dy / L);
}

/** 一条待铺的内部路：中线 + 宽 + 材质 + 标高 */
interface RoadBand {
  pts: Pt[];
  w: number;
  mat: MatKey;
  y: number;
  /** 画中心虚线（只有一级内部路 / 街区主巷要） */
  mark?: boolean;
  /** 落面时的名字（默认 `zone_road`；公园的园路要叫 `park_path`） */
  name?: string;
}

/**
 * 内部路成面：**先把同层同材质的带子并成一块，再一次性铺出去**。
 *
 * 旧做法是"一条带子一个面，各自 addSurface"。路口处两条带子在同一标高上
 * 互相叠压 —— 两张共面平面，显卡只能二选一，俯视/三维里就是路口那几块
 * 忽明忽暗的小方块（用户截图里红框圈的位置）。而且逐条铺时，转角外侧会
 * 因为两端都是平口而露出一块底色，"拼凑"感就是这么来的。
 *
 * 并集之后路口是**一块连续的路面**，和城市路网（road/system 的
 * roadSurfaces + junctionSurfaces）是同一套思路：先算几何，再一次成面。
 *
 * 有洞的并集（几条巷道围出一圈）不能当实心面铺 —— 那会把中间的地块
 * 一起铺成沥青，这时退回逐条铺（宁可留缝，不要铺错）。
 */
function drawRoadBands(c: Ctx, bands: RoadBand[]): void {
  if (bands.length === 0) return;
  const ring = Array.from(c.block);

  // 按「材质@标高」分组：同组的并成一块，不同组之间本来就该有明确分界
  const groups = new Map<string, { mat: MatKey; y: number; polys: Pt[][]; name: string }>();
  const marks: { pts: Pt[]; y: number }[] = [];

  for (const b of bands) {
    const pts = clipPath(b.pts, ring);
    if (pts.length < 2) continue;
    const key = `${b.mat}@${b.y}@${b.name ?? 'zone_road'}`;
    let g = groups.get(key);
    if (!g) {
      g = { mat: b.mat, y: b.y, polys: [], name: b.name ?? 'zone_road' };
      groups.set(key, g);
    }
    const band = bandPolygon(pts, b.w);
    if (band && simpleRing(band)) {
      g.polys.push(band);
    } else {
      // 退化（折线自交 / 极短）时退回逐段：宁可分段，也不要出现破面
      for (let i = 0; i + 1 < pts.length; i++) {
        const s = stripe(pts[i], pts[i + 1], b.w);
        if (s) g.polys.push(s);
      }
    }
    if (b.mark) marks.push({ pts, y: b.y });
  }

  for (const g of groups.values()) {
    if (g.polys.length === 0) continue;
    const parts = g.polys.length > 1 ? unionParts(g.polys) : [{ outer: g.polys[0], holes: 0 }];
    const usable = parts.filter((p) => p.outer && p.outer.length >= 3 && p.holes === 0 && simpleRing(p.outer));
    if (usable.length === parts.length && usable.length > 0) {
      for (const p of usable) addSurface(c, g.name, p.outer, g.mat, g.y, false, true);
    } else {
      // 有洞 / 并集失败：逐条铺，靠 1e-6 的层差把共面重叠岔开
      g.polys.forEach((p, i) => addSurface(c, g.name, p, g.mat, g.y + i * 1e-6, false, true));
    }
  }

  for (const m of marks) {
    for (let i = 0; i + 1 < m.pts.length; i++) addCenterDash(c, m.pts[i], m.pts[i + 1], m.y);
  }
}

function drawSeams(c: Ctx, lanes: RoadBand[]) {
  drawRoadBands(c, lanes);
}



/**
 * 一段路面上的中心虚线（白色短划）。
 *
 * 划的长度与间隔按 1:2（3 m 实 / 6 m 空），和城市道路的标线节奏一致。
 * 路面宽度只有 3.5 m 时，中间那条线就是这条路唯一的标线。
 */
function addCenterDash(c: Ctx, a: Pt, b: Pt, y: number) {
  const L = Pt.distance(a, b);
  if (L < u(4)) return;
  const ux = (b.x - a.x) / L;
  const uy = (b.y - a.y) / L;
  const dash = u(3);
  const gap = u(6);
  const w = u(0.16);
  for (let t = u(1.5); t + dash <= L; t += dash + gap) {
    const p0 = new Pt(a.x + ux * t, a.y + uy * t);
    const p1 = new Pt(a.x + ux * (t + dash), a.y + uy * (t + dash));
    const s = stripe(p0, p1, w);
    if (!s) continue;
    addSurface(c, 'alley_mark', s, 'markWhite', y + 0.0006, false);
  }
}

/** 封闭区域的配比预算（整块一份，各地块共用） */
// 地块形态参数（cellM / gapM / setbackK / 巷道宽 / 地块目标面积）全部来自
// `model.params.block` —— 见 src/town/params.ts。这里不再放常量，
// 否则面板上调完，代码里还有一份"真正的值"，改了也没用。

interface ZoneBudget {
  /** 绿地目标面积（单位²） */
  green: number;
  /** 停车目标面积（单位²） */
  lot: number;
  greenUsed: number;
  lotUsed: number;
  /** 整块封闭区域的中心：绿地要往这里聚 */
  ctr: Pt;
}

/**
 * 用子街坊造一个临时 Ctx：几何裁切、局部坐标系都按这块小地重算。
 *
 * 内容是"按局部包围盒摆矩形"的（塔楼、广场、车位排），必须让 c.block / c.f / c.bb
 * 三者指向**子街坊**而不是整个封闭地块，否则每栋楼都会被裁到大块地的包围盒里，
 * 摆出来的位置全歪。
 */
function subCtx(c: Ctx, ring: Pt[]): Ctx | null {
  const cleaned = cleanRing(ring);
  if (cleaned.length < 3) return null;
  if (Math.abs(area(cleaned)) < 0.3) return null;
  const block = new Polygon(toCCW(cleaned));
  if (block.length < 3) return null;
  const f = frameOf(block);
  return { ...c, block, f, bb: bboxOf(Array.from(block), f) };
}

/**
 * 一个**地块**（parcel）的内容 —— 按 CBD 的配比填满。
 *
 *   建筑 ≈ 70%    绿地 ≈ 10%    停车 ≈ 5%    各类硬质铺装 ≈ 15%
 *
 * 配比是整块封闭区域的总量，所以绿地和停车走 `budget`（一份共享预算），
 * 不是每个地块各留一份 —— 13 个地块各留一格绿地就是 18%，比例会一路超标。
 *
 * 三版踩过的坑写在这里，免得再犯：
 *   ① 初版"沿组团路排两排楼 + 其余全种草" → 建筑 8%、绿地 73%，读起来是草坪上散落几栋楼；
 *   ② 第二版改成栅格 + "从中心最近的单格里抠一块口袋"，但口袋目标面积（块面积的 13%）
 *      恒大于**单格**面积，判据 `cellA >= targetA * 0.55` 于是每格都不过、直接返回 null，
 *      实测绿地只落 2.8%、停车 0.8% —— 只有最小的那几块地勉强塞进去；
 *   ③ 第三版：口袋按**整格划拨**。先切格子，再决定哪些格归绿地 / 停车，剩下的格才排楼。
 *      比例由"格子数"直接决定，不再依赖单格能否装下目标面积。
 *
 * 第二个坑：格子被内部路 / 巷道切掉一角时，旧 `carve()` 只留**最大的一块**，
 * 另一半就光秃秃露着石材底，一片看上去是棋盘格。现在返回全部碎块，每块各排一栋。
 *
 * 第三个坑（本轮）：格子 28 m + 缝 0.7 m，几乎所有邻格都只隔一条 7 px 的白边，
 * 俯视图上读成"一整块连片的巨型建筑"。现在：格子 24 m、缝 2.6 m、
 * 地块边界再退 2 m 红线，一栋楼 21.4 m 见方，楼与楼之间、地块与地块之间都看得出间隙。
 */
function planCbdZone(c: Ctx, key: number, sp: Spine, budget: ZoneBudget) {
  const block = Array.from(c.block);
  const blockA = Math.abs(area(block));
  if (blockA < 0.3) return;

  // 硬质地面：**这里不再整块铺一层**。等绿地格 / 停车格 / 补位绿带都定下来之后，
  // 铺装按"地块减去它们"的补集来铺（见 ②b），一块地只留一层硬质面。

  // 建筑退线：地块边不是建筑边。不退的话，相邻地块的楼隔着一条 3.2 m 巷道对峙，
  // 但两边的楼面几乎贴着，视觉上还是"一整块"。退线按地块尺度给（小地块退太多就没楼了）。
  const BP = c.model.params.block;
  const BD = c.model.params.building;
  const sb = clamp(Math.sqrt(blockA) * BP.setbackK, 0.12, 0.38);
  // 退线环必须是"能用"的：`insetRing` 是斜接偏移，遇到 U 形 / 带细长臂的地块
  // （内部路只有一端顶到界边时就会切出这种形状）会自交。
  // 自交的退线环会让**这一整块地的每一格**都在 `clipBuilding` 里被拒 ——
  // 表面上是"36 格、0 栋"，一整片地白白空着，而且一点报错都没有。
  // 退线只是观感优化，退化时直用可建区。
  let buildable = blockA > 8 ? insetRing(block, sb) : block;
  if (
    buildable.length < 3 ||
    !isSimpleRing(buildable) ||
    Math.abs(area(buildable)) < blockA * 0.5
  ) {
    buildable = block;
  }

  const { bb, f } = c;
  const cell = u(BP.cellM); // ≈ 一个开发单元（一栋塔楼 / 一栋板楼）
  const nu = Math.max(1, Math.round(bb.w / cell));
  const nv = Math.max(1, Math.round(bb.h / cell));
  const cw = bb.w / nu;
  const ch = bb.h / nv;

  // ---- ① 切格子，每格裁到子街坊内
  interface Cell {
    i: number;
    j: number;
    ring: Pt[];
    a: number;
  }
  const cells: Cell[] = [];
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const raw = rect(f, bb.u0 + cw * i, bb.u0 + cw * (i + 1), bb.v0 + ch * j, bb.v0 + ch * (j + 1));
      const parts = intersect(raw, block, 0.12).filter((p) => p.length >= 3);
      if (parts.length === 0) continue;
      const ring = parts.reduce((x, y) => (Math.abs(area(x)) >= Math.abs(area(y)) ? x : y), parts[0]);
      const a = Math.abs(area(ring));
      if (a < 0.2) continue; // 不到 10 m² 的碎角，放不下任何东西
      cells.push({ i, j, ring, a });
    }
  }
  if (cells.length === 0) return;
  const cellA = cells.reduce((s, q) => s + q.a, 0);

  // ---- ② 划口袋：绿地贴中心（CBD 的"中央口袋公园"），停车贴内部路（出入口接得上）
  const ctr = ringCenter(block);
  const distC = (p: Pt) => Pt.distance(p, ctr);
  /** 点到折线的最短距离（挑"最近内部路"的格子用） */
  const lineDist = (p: Pt, line: Pt[]) => {
    let best = Infinity;
    for (let i = 0; i + 1 < line.length; i++) {
      const a = line[i];
      const b = line[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const L2 = dx * dx + dy * dy || 1;
      let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const q = new Pt(a.x + dx * t, a.y + dy * t);
      const d = Pt.distance(p, q);
      if (d < best) best = d;
    }
    return best;
  };
  const roadRef = sp.lines[0] ?? [];

  const green: Cell[] = [];
  const lot: Cell[] = [];
  // 地块太小（只有一两格）就别划口袋了：一格绿地会把整块地变成草坪
  const canPocket = cells.length >= 3;
  if (canPocket) {
    // 绿地：按"离整块封闭区域中心"由近到远吃预算。
    // 每个地块最多两格，否则一块地上半边全是草坪、另半边一间绿地都没有。
    const gMax = cells.length >= 8 ? 2 : 1;
    for (const cl of cells.slice().sort((p, q) => Pt.distance(ringCenter(p.ring), budget.ctr) - Pt.distance(ringCenter(q.ring), budget.ctr))) {
      if (green.length >= gMax) break;
      if (budget.greenUsed + cl.a > budget.green * 1.02 + 1e-9) continue;
      green.push(cl);
      budget.greenUsed += cl.a;
    }
    const isGreen = new Set(green.map((k) => `${k.i}:${k.j}`));
    const lMax = cells.length >= 8 ? 2 : 1;
    const byRoad = cells
      .filter((k) => !isGreen.has(`${k.i}:${k.j}`))
      .sort((p, q) => {
        const dp = roadRef.length > 1 ? lineDist(ringCenter(p.ring), roadRef) : distC(ringCenter(p.ring));
        const dq = roadRef.length > 1 ? lineDist(ringCenter(q.ring), roadRef) : distC(ringCenter(q.ring));
        return dp - dq;
      });
    for (const cl of byRoad) {
      if (lot.length >= lMax) break;
      if (budget.lotUsed + cl.a > budget.lot * 1.02 + 1e-9) continue;
      lot.push(cl);
      budget.lotUsed += cl.a;
    }
  }

  // 地块划不出整格口袋（格子太大 / 只有一两格）时，改成在包围盒中部切一条绿带，
  // 从建筑格子里挖掉 —— 面积可控，也不会把整块地变成草坪。
  //
  // 触发条件不是"格子数 < 3"，而是"这一格没落上绿地"：
  // 预算只剩 6 u²、单格 8 u² 时整格判据永远不通过，整块区域会一块绿地都没有
  // （实测小块 seed=12 绿地 0%）。此时绿带按**剩余预算**取，既补上绿地也不超支。
  const tightGreen: Pt[][] = [];
  const greenLeft = budget.green - budget.greenUsed;
  if (green.length === 0 && blockA > 2.2 && greenLeft > blockA * 0.035) {
    const cw2 = bb.w * 0.5;
    const want = Math.min(blockA * 0.12, greenLeft);
    const cd2 = Math.min(bb.h, want / Math.max(cw2, 0.1));
    const cu = (bb.u0 + bb.u1) / 2;
    const cv = (bb.v0 + bb.v1) / 2;
    const rawG = rect(f, cu - cw2 / 2, cu + cw2 / 2, cv - cd2 / 2, cv + cd2 / 2);
    const parts = intersect(rawG, block, 0.08).filter((p) => p.length >= 3);
    if (parts.length > 0) {
      const g = parts.reduce((x, y) => (Math.abs(area(x)) >= Math.abs(area(y)) ? x : y), parts[0]);
      if (Math.abs(area(g)) > 0.08) {
        tightGreen.push(g);
        budget.greenUsed += Math.abs(area(g));
        addSurface(c, `zone_green_${key}_strip`, g, 'grass', 0.0126, false);
        const gc = ringCenter(g);
        for (let k = -1; k <= 1; k++) {
          const p = new Pt(gc.x + k * u(7), gc.y);
          if (pointInPolygon(p, g)) addProp(c, 'tree', p, 0.85, Rng.float() * 6.28, 'vegetation');
        }
      }
    }
  }

  // ---- ②b 硬质地面 = 地块 − 绿地格 − 停车格 − 补位绿带
  //
  // 旧版是"整块地块先铺一层石材底（zone_pave_${key}），绿地格 / 停车坪再画在它上面"，
  // 于是同一块地有 2~3 层铺装，俯视图上露出哪一层完全取决于谁的 y 大 ——
  // 这就是用户截图里"不同地面铺装互相重叠 / 边缘互相盖压"的来源。
  // 现在铺装是那几块的**补集**：一块地只有一层硬质面，既不盖住别人也不被别人盖住。
  {
    let rest: Pt[][] = [block];
    const holes = [...green.map((k) => k.ring), ...lot.map((k) => k.ring), ...tightGreen];
    for (const h of holes) {
      const next: Pt[][] = [];
      for (const p of rest) {
        let sub: Pt[][] = [];
        try {
          sub = subtract(p, [h]);
        } catch {
          next.push(p);
          continue;
        }
        next.push(...sub);
      }
      rest = next;
      if (rest.length === 0) break;
    }
    let pi = 0;
    for (const p of rest) {
      if (p.length < 3 || Math.abs(area(p)) < 0.02) continue;
      addSurface(c, `zone_pave_${key}_${pi++}`, p, 'stonePave', 0.012, false);
    }
  }

  // ---- ③ 绿地：草地 + 树 + 长椅。tree 用格内网格摆，不能用 scatter（那是按整块地撒的）
  for (const cl of green) {
    addSurface(c, `zone_green_${key}_${cl.i}_${cl.j}`, cl.ring, 'grass', 0.0126, false);
    const gc = ringCenter(cl.ring);
    const step = u(9);
    for (let gx = -1; gx <= 1; gx++) {
      for (let gy = -1; gy <= 1; gy++) {
        const p = new Pt(gc.x + gx * step, gc.y + gy * step);
        if (!pointInPolygon(p, cl.ring)) continue;
        if (Rng.bool(0.3)) continue;
        addProp(c, 'tree', p, 0.85 + Rng.float() * 0.3, Rng.float() * 6.28, 'vegetation');
      }
    }
    addProp(c, 'bench', new Pt(gc.x + u(2.4), gc.y - u(2.4)), 1, Rng.float() * 6.28, 'furniture');
    addProp(c, 'lamp', new Pt(gc.x - u(3), gc.y + u(3)), 0.9, 0, 'furniture');
  }

  // ---- ④ 停车：整格交给我停车场求解器（车位线 / 通道 / 出入口都在里面）
  for (const cl of lot) {
    emitParkingRing(
      c,
      cl.ring,
      `zone_lot_${key}_${cl.i}_${cl.j}`,
      { w: 0.36, l: 0.72 },
      false,
      roadRef.length > 1 ? roadRef : [ringCenter(cl.ring), ctr]
    );
  }

  // ---- ⑤ 建筑：剩下的格子逐格排楼
  const blocked = new Set<string>([...green, ...lot].map((k) => `${k.i}:${k.j}`));
  const obstacles: Pt[][] = [];
  for (const fp of c.footprints) obstacles.push(outset(fp, 0.12));
  for (const g of tightGreen) obstacles.push(outset(g, u(0.4)));

  /** 减掉障碍，返回**全部**剩余碎块（只留最大一块会留下棋盘格空地） */
  const carveAll = (ring: Pt[]): Pt[][] => {
    let cur: Pt[][] = [ring];
    for (const r of obstacles) {
      const next: Pt[][] = [];
      for (const piece of cur) {
        let parts: Pt[][] = [];
        try {
          parts = subtract(piece, [r]);
        } catch {
          next.push(piece);
          continue;
        }
        if (parts.length === 0) continue;
        next.push(...parts);
      }
      cur = next;
      if (cur.length === 0) break;
    }
    return cur.filter((p) => p.length >= 3 && Math.abs(area(p)) > 0.04);
  };

  // 楼间距：1.2 m 的缝在俯视图上是可见的一条底色，0.7 m 时几乎糊成一片。
  // 再宽就要从覆盖率里出：缝每加 0.5 m，建筑覆盖率掉 4 个百分点。
  const gap = u(BP.gapM);
  const gu = Math.min(gap * 0.5, cw * 0.08);
  const gv = Math.min(gap * 0.5, ch * 0.08);
  const tight = c.patch.ward instanceof ModernWard ? (c.patch.ward as ModernWard).radius < BD.tightRadius : true;
  let built = 0;
  // 满铺等大的方格是"看起来是程序生成"的最大来源。抽 22% 的格子吃掉右邻，
  // 变成长边 2 格的板楼 —— 覆盖率不变，但地块内部立刻有了大小对比。
  const eaten = new Set<string>();
  for (const cl of cells) {
    const key = `${cl.i}:${cl.j}`;
    if (blocked.has(key) || eaten.has(key)) continue;
    let iEnd = cl.i;
    if (Rng.float() < BD.mergeChance) {
      const nb = cells.find((k) => k.i === cl.i + 1 && k.j === cl.j);
      const nbKey = nb ? `${nb.i}:${nb.j}` : '';
      if (nb && !blocked.has(nbKey) && !eaten.has(nbKey)) {
        iEnd = nb.i;
        eaten.add(nbKey);
      }
    }
    const raw = rect(
      f,
      bb.u0 + cw * cl.i + gu,
      bb.u0 + cw * (iEnd + 1) - gu,
      bb.v0 + ch * cl.j + gv,
      bb.v0 + ch * (cl.j + 1) - gv
    );
    for (const piece of carveAll(raw)) {
      const ring = clipBuilding(c, piece, 0.34, buildable);
      if (!ring) continue;
      const ra = Math.abs(area(ring));
      if (ra < 0.07) continue;
      const name = `zone_bld_${key}_${cl.i}_${cl.j}_${built}`;
      // CBD 的高度梯度：越靠城市中心越高，同格里再抖一点。
      // "是不是塔楼"不能拿面积判：一栋 24 m 见方的楼在任何阈值下都是"大"的，
      // 结果整个 CBD 全是 100 m 高的塔楼。改成按位置给概率（中心高、外围矮）。
      const pTower = tight ? BD.towerChanceCore : BD.towerChance;
      if (Rng.float() < pTower) {
        // 塔楼 = 裙房 + 退台的塔身。2D 上看到的是"一块大屋顶里嵌一个小屋顶"，
        // 这正是真实 CBD 的样子；只画一个大方块，无论多高都读作"一栋巨构"。
        addSolid(c, name, ring, BD.podiumHMin + Rng.float() * (BD.podiumHMax - BD.podiumHMin), Rng.bool(0.7) ? 'wallPanel' : 'wallConcrete', 'roofLight', 'slab');
        const core = insetRing(ring, Math.sqrt(ra) * 0.19);
        const coreA = Math.abs(area(core));
        if (core.length >= 3 && coreA > ra * 0.2) {
          // 塔身高度受**塔身宽度**约束（6:1 以内）：地块小的时候 100 m 的细杆子
          // 不是塔楼，是根筷子。塔身窄了就自动矮下来。
          const cap = Math.sqrt(coreA) * 6;
          const top = tight ? BD.towerHMaxCore : BD.towerHMaxEdge;
          const hT = Math.min(BD.towerHMin + Rng.float() * (top - BD.towerHMin), cap);
          addSolid(
            c,
            `${name}_t`,
            core,
            Math.max(3, hT),
            Rng.bool(0.7) ? 'wallGlass' : 'wallPanel',
            'roofFlat',
            'tower',
            0.05 + 2.7
          );
        }
      } else {
        // 板楼：3~7 层，贴着地块边线排，形成连续的沿街界面
        addSolid(c, name, ring, BD.slabHMin + Rng.float() * (BD.slabHMax - BD.slabHMin), Rng.bool(0.6) ? 'wallConcrete' : 'wallPanel', Rng.bool(0.5) ? 'roofLight' : 'roofFlat', 'slab');
      }
      c.footprints.push(ring);
      c.res.buildings++;
      built++;
    }
  }

  pushZoneDbg({
    key,
    blockA,
    cellA,
    green: green.reduce((s, k) => s + k.a, 0),
    lot: lot.reduce((s, k) => s + k.a, 0),
    cells: cells.length,
    built,
  });
}


/**
 * 内部路的街道家具：行道树 + 路灯。
 *
 * 间距按《城市道路工程设计规范》同一条规则取（行道树 8 m、路灯 30 m），
 * 只是从"城市级路网"搬到了地块内部 —— 内部路也是路，空着一条没有任何
 * 附属设施的双向车道，在空中看就是一条灰漆带。
 */
function spineFurniture(c: Ctx, sp: Spine, avoid: Pt[][] = []) {
  const ring = Array.from(c.block);
  const offTree = sp.w / 2 + u(1.5) + u(0.5);
  const offLamp = sp.w / 2 + u(1.5) + u(0.15);
  const treeStep = u(8);
  const lampStep = u(30);

  for (const line of sp.lines) {
    let accT = treeStep * 0.5;
    let accL = lampStep * 0.5;
    let side = 1;
    for (let i = 0; i + 1 < line.length; i++) {
      const a = line[i];
      const b = line[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const L = Math.hypot(dx, dy) || 1;
      const ux = dx / L;
      const uy = dy / L;
      const nx = -uy;
      const ny = ux;
      let s = 0;
      while (s < L) {
        const stepT = treeStep - accT;
        const stepL = lampStep - accL;
        const step = Math.min(stepT, stepL, L - s);
        s += step;
        accT += step;
        accL += step;
        const at = new Pt(a.x + ux * s, a.y + uy * s);
        if (accT >= treeStep - 1e-6) {
          accT = 0;
          side = -side;
          const p = new Pt(at.x + nx * offTree * side, at.y + ny * offTree * side);
          // 必须在可建区内、且离界边还有一点余量：行道树贴着红线种，
          // 树冠会伸到外部道路的人行道上方，2D 上也会和路缘糊在一起。
          if (pointInPolygon(p, ring) && !withinRing(p, ring, u(0.4)) && !avoid.some((av) => pointInPolygon(p, av))) {
            if (!c.footprints.some((fp) => pointInPolygon(p, fp))) {
              addProp(
                c,
                Rng.bool(0.75) ? 'tree' : 'treeSmall',
                p,
                0.8 + Rng.float() * 0.3,
                Rng.float() * 6.283,
                'vegetation'
              );
            }
          }
        }
        if (accL >= lampStep - 1e-6) {
          accL = 0;
          const p = new Pt(at.x - nx * offLamp, at.y - ny * offLamp);
          if (pointInPolygon(p, ring) && !withinRing(p, ring, u(0.25))) {
            if (!c.footprints.some((fp) => pointInPolygon(p, fp))) {
              addProp(c, 'lamp', p, 1, Math.atan2(ny, nx), 'furniture');
            }
          }
        }
      }
    }
  }
}

function planGreen(c: Ctx) {
  baseSurface(c, Rng.bool(0.4) ? 'grassDark' : 'grass');

  const ring = Array.from(c.block);
  if (ring.length < 3) return;
  const aM2 = Math.abs(c.block.square) * 49;

  // 色块：撒几块有机形状的草甸 / 深草，把大绿块切成深浅不一的片。
  //
  // 一整块同色的 9000 m² 绿地在俯视图上就是"没做完的草地"—— 树本身也是深绿，
  // 落在深绿底上几乎看不见，整片读成一个纯色块。真实的郊野是被田埂、灌丛、
  // 地形切成一片片深浅不同的草甸。
  //
  // 试过用 `tensorPartition` 再切 2~4 刀：种子 8 里那块 1.4 万 m² 的绿地上，
  // 二分一次都没切开（返回整块），色块完全没生效。所以改成**直接铺不规则斑块**：
  // 半径 60~180 m 的抖动多边形，与地块求交后铺上去。不管切分算法给什么形状，
  // 这一步的形状都由自己定，结果稳定。
  const PATCH_GREENS: MatKey[] = ['grassLight', 'grassDark', 'grassLight', 'soil'];
  const blobs = clamp(Math.round(aM2 / 2600), 2, 6);
  for (let i = 0; i < blobs; i++) {
    const ctr = ringCenter(ring);
    const spread = Math.sqrt(aM2) * 0.32;
    const cx = ctr.x + (Rng.float() - 0.5) * spread * 1.7;
    const cy = ctr.y + (Rng.float() - 0.5) * spread * 1.7;
    const r0 = u(26 + Rng.float() * 34);
    const poly: Pt[] = [];
    for (let k = 0; k < 9; k++) {
      const ang = (k / 9) * Math.PI * 2;
      const rr = r0 * (0.65 + Rng.float() * 0.7);
      poly.push(new Pt(cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr));
    }
    if (!isSimpleRing(poly)) continue;
    const clip = intersect(poly, ring, 0.02);
    for (const piece of clip) {
      if (Math.abs(area(piece)) < 0.6) continue;
      addSurface(c, 'green_patch', piece, PATCH_GREENS[Rng.int(0, PATCH_GREENS.length - 1)], 0.0066, false);
    }
  }

  // 林带：沿**每一条边**内侧退 0.5 u 种一排，株距 9 m。
  //
  // 上一版只种"最长的两条边"，而 `c.block` 是被张量切过的多边形 ——
  // 一块 9300 m² 的绿带，最长边只有 4.1 u（≈29 m，十几段短边拼起来的），
  // `floor(4.1 / 2.6) = 1`：两条边一共种 2 棵，剩下靠 `scatter` 补 3 棵。
  // 于是占城市面积 14% 的外圈绿带上，一块地只有 5 棵树，俯视图里就是
  // 一片纯色绿楔 —— "城郊没做完"最扎眼的一处。
  //
  // 改成逐边种：短边也各出 1 棵，整圈绿带才真的围上树，
  // 而且林带贴着地块边界，从空中看是"有边界的林地"，不是一坨草地。
  const ctr = ringCenter(ring);
  const step = u(9);
  const inset = u(0.5);
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const L = Pt.distance(a, b);
    const n = Math.max(1, Math.floor(L / step));
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      const px = a.x + (b.x - a.x) * t;
      const py = a.y + (b.y - a.y) * t;
      const dl = Math.hypot(ctr.x - px, ctr.y - py) || 1;
      const at = new Pt(px + ((ctr.x - px) / dl) * inset, py + ((ctr.y - py) / dl) * inset);
      if (withinRing(at, ring, u(0.3))) continue;
      addProp(c, 'tree', at, 0.9 + Rng.float() * 0.35, Rng.float() * Math.PI * 2);
    }
  }

  // 内部：疏林 / 草甸。密度按面积给（约每 1100 m² 一棵，封顶 30）——
  // 上一版写的是 `max(3, round(a / 200))`，但 `a` 是**单位面积**不是平方米，
  // 除以 200 之后永远落在 1 附近，`max(3, …)` 就把它钉死在 3 棵了。
  const inner = clamp(Math.round(aM2 / 1100), 2, 30);
  scatter(c, inner, { minDist: 1.6, kind: 'tree' });
}

// ---------------------------------------------------------------- 公共部件

function shortDim(bb: BBox): number {
  return Math.min(bb.w, bb.h);
}

type Box4 = [number, number, number, number];

/**
 * 停车场：先按用途算需求，再用需求额度去裁盒子；剩下的地方不再铺车位。
 *
 * 顺序（对应停车场规范 §1 / §7）：
 *   AvailableGround → ParkingCandidateRegion → 只消费满足需求的部分 → 余下进广场 / 绿地 / 服务院
 *
 * 三道闸门：硬上限（用途比例）→ 建筑支撑比（≤ 建筑占地 × 0.6~1.8）→ 单块坪上限。
 * 超单块上限就拆簇，簇间强制留绿化 / 步道分隔（§11）；坪内按比例留绿化岛（§10）。
 */
function parkingBlock(
  c: Ctx,
  box: Box4,
  alongU: boolean,
  name: string,
  dims: Partial<StallDims> = {},
  share = 1
) {
  const [u0, v0, u1, v1] = box;
  if (u1 - u0 < 0.5 || v1 - v0 < 0.5) return;

  const d = parkingDemand(
    c.use,
    Math.abs(area(Array.from(c.block))),
    footprintArea(c),
    c.use === 'industrial' ? 'industrial' : 'urban',
    c.parkingLevel
  );
  if (d.target < 0.3) return;

  // §8 主入口前禁停：只在"盒子明显大于需求"时退让，避免把本来就紧张的车位又削掉
  const boxArea = (u1 - u0) * (v1 - v0);
  const body = boxArea > d.target * share * 1.6 ? clearFrontage(c, box, d.entryClear) : box;
  if (body[2] - body[0] < 0.5 || body[3] - body[1] < 0.5) return;

  // 需求封顶：额度之内才铺车位。这里同时是 §18 的生成后闸门 ——
  // 一个地块可能分几次铺车位（后场 + 专用场），合计不能突破硬上限。
  const quota = Math.min(d.target * share, d.cap - c.parkUsed);
  if (quota < 0.3) return;
  const allow = Math.min((body[2] - body[0]) * (body[3] - body[1]), quota);
  if (allow < 0.35) return;

  const parts = splitClusters(capBox(body, allow), d.maxLot, d.clusters);


  // 簇间分隔：绿化带 + 一条步道（§11 不允许两片停车坪直接贴在一起）
  for (let i = 1; i < parts.length; i++) {
    const gap = gapBetween(parts[i - 1], parts[i]);
    if (!gap || gap[1] - gap[0] < 0.02) continue;
    const g = alongU ? rect(c.f, gap[0], gap[1], body[1], body[3]) : rect(c.f, body[0], body[2], gap[0], gap[1]);
    addSurface(c, `parking_${name}_buffer_${i}`, g, 'grass', 0.014);
  }

  parts.forEach((p, i) =>
    emitParkingLot(c, p, alongU, parts.length > 1 ? `${name}_${i}` : name, dims, d.islandRatio > 0)
  );
}

/** 建筑占地合计（单位²） */
function footprintArea(c: Ctx): number {
  let a = 0;
  for (const fp of c.footprints) a += Math.abs(area(fp));
  return a;
}

// ---------------------------------------------------------------- 多边形停车区
//
// 张量场切出来的地块是**多边形**（四到六边、边长不等、常有锐角），
// 用外接矩形去铺车位一定会浪费掉一半边缘。这里改成直接把多边形当候选区：
//   ① 面积封顶 → 按面积二分内缩多边形（不是切一个矩形）
//   ② 拆簇     → 沿主轴等分切开，切口留绿化带
//   ③ 排布     → 交给 parking.ts 的求解器（stripe → clip → score）
// 求解器本身就吃任意简单多边形，所以斜边、锐角都由它自己裁。

/**
 * 停车坪与地块红线的退让（≈1.5 m）。
 *
 * §9 要求"停车前场比例 ≤ 0.35"，即沿街立面上停车场开口不能占掉大半个街面。
 * 与其事后量长度再削面积（多边形上很难削得干净），不如从一开始就让停车坪
 * 不贴红线：退让出来的一圈由基底（草地/铺装）填着，人行道边就是绿化，
 * 车场的"临街开口"直接归零，比例约束自然满足，街景也不再是"车场怼着马路"。
 *
 * 两种情况下不退：坪本身小于一个车位排布的最小面积（退了就排不出车位）、
 * 或者退完面积掉一半以上（细长地块退一圈就没了）。
 */
const PARK_FRONT_SETBACK = u(1.5);

function lotFrontSetback(_c: Ctx, lot: Pt[]): Pt[] {
  const a0 = Math.abs(area(lot));
  if (a0 < 2.2) return lot;
  const ins = insetRing(lot, PARK_FRONT_SETBACK);
  if (ins.length < 3) return lot;
  const a1 = Math.abs(area(ins));
  if (a1 < a0 * 0.5) return lot;
  return ins;
}

/** 多边形按面积内缩到 target（二分；不改变形状语义） */
function insetToArea(ring: Pt[], target: number): Pt[] {
  const a0 = Math.abs(area(ring));
  if (a0 <= target) return ring;
  let lo = 0;
  let hi = Math.sqrt(a0) * 0.5;
  // 只在"不超过配额"的一侧取最接近的那个。
  // 早先的写法把每轮算出的结果都覆盖到 best，最后一次往往刚好落在配额之下很多，
  // 于是配额 14 u² 的坪被内缩成 6 u² —— 停车位少一大半，还查不出是哪一步丢的。
  let best: Pt[] | null = null;
  let bestA = 0;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) * 0.5;
    const r = insetRing(ring, mid);
    if (r.length < 3) {
      hi = mid;
      continue;
    }
    const a = Math.abs(area(r));
    if (a > target) {
      lo = mid;
      continue;
    }
    if (a > bestA) {
      best = r;
      bestA = a;
    }
    hi = mid;
    if (a > target * 0.96) break;
  }
  // 一个满足条件的都没找到（形状一缩就崩）：宁可超配额也用原形状，
  // 交给后面的拆簇去消化，总比铺一块排不出车位的碎地强。
  return best ?? ring;
}

/**
 * 把一块地"限额"到 target 面积，且**保证还剩下能用的形状**。
 *
 * 先试按面积内缩（形状不变，最理想）。但内缩在多边形上不稳定：
 * 布尔运算切出来的多边形常有 20+ 个顶点和几个很尖的角，斜接偏移在尖角处
 * 会炸出几百单位的尖刺，偏移环自交，面积算出来只剩两三个平方 ——
 * 这时二分搜索会把"缩成一根线"当成满足条件的最优解，
 * 于是一块 100 u² 的地最后只铺出 3 个车位。
 *
 * 内缩做不出六七成面积就改切条：沿主轴切成 n 条，取面积最接近额度的那条。
 * 切条只保证宽度，不保证形状，但它绝不会把地缩没。
 */
function capRegion(ring: Pt[], target: number): Pt[] {
  const a0 = Math.abs(area(ring));
  if (a0 <= target * 1.02) return ring;

  const ins = insetToArea(ring, target);
  const ai = Math.abs(area(ins));
  // 上限也要卡：insetToArea 在"一个满足条件的都没找到"时会把原形状原样退回来，
  // 不卡上限就会把 183 u² 的地当成"限额成功"，广场直接铺满整个街坊。
  if (ai >= target * 0.55 && ai <= target * 1.25) return ins;

  // 内缩做不出来 → 切条：沿主轴切成 n 条，取面积最接近额度的那条。
  // 切条不保证形状，但保证宽度，绝不会把地缩成一根线。
  const n = Math.min(5, Math.max(2, Math.ceil(a0 / target)));
  const sl = sliceRing(ring, n);
  if (sl.length === 0) return ai <= target * 1.25 ? ins : ring;
  let best = sl[0];
  let bestD = Math.abs(Math.abs(area(best)) - target);
  for (const p of sl) {
    const d = Math.abs(Math.abs(area(p)) - target);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

/**
 * 去掉环上的共线点与"往返尖刺"。
 *
 * 判据：顶点到「前后两点连线」的距离小于 eps 就删掉这个点。
 * 共线点（转向角≈0）距离≈0；尖刺的尖端离连线也≈0 —— 两类退化一起清掉。
 * 反复扫到没有可删的为止，因为删掉一个点可能让下一个点变成新的退化点。
 */
function cleanRing(ring: Pt[], eps = 0.03): Pt[] {
  const dedupe = (r: Pt[]): Pt[] => {
    const out: Pt[] = [];
    for (const p of r) {
      if (out.length === 0 || Pt.distance(out[out.length - 1], p) > eps) out.push(p);
    }
    while (out.length > 1 && Pt.distance(out[0], out[out.length - 1]) < eps) out.pop();
    return out;
  };

  let cur = dedupe(ring);
  for (let pass = 0; pass < 5; pass++) {
    if (cur.length <= 3) break;
    const out: Pt[] = [];
    let removed = 0;
    for (let i = 0; i < cur.length; i++) {
      const a = cur[(i - 1 + cur.length) % cur.length];
      const b = cur[i];
      const c = cur[(i + 1) % cur.length];
      const dx = c.x - a.x;
      const dy = c.y - a.y;
      const L = Math.hypot(dx, dy);
      // 前后两点几乎重合（A→B→A）：B 是往返尖刺的尖端，删掉
      if (L < eps) {
        removed++;
        continue;
      }
      const d = Math.abs((b.x - a.x) * dy - (b.y - a.y) * dx) / L;
      const t = ((b.x - a.x) * dx + (b.y - a.y) * dy) / (L * L);
      // 共线点（距离≈0）直接删；投影落在 a→c 之外的说明是折角，只有当它比两端都贴近直线时才删
      if (d < eps && t > -0.05 && t < 1.05) {
        removed++;
        continue;
      }
      out.push(b);
    }
    cur = dedupe(out);
    if (removed === 0) break;
  }
  return cur.length >= 3 ? cur : ring;
}

/** 环的主轴方向（取最长边，张量地块的最长边就是它的"正面"） */
function ringAxis(ring: Pt[]): { dir: Pt; ang: number } {
  let best = 0;
  let bi = 0;
  for (let i = 0; i < ring.length; i++) {
    const l = Pt.distance(ring[i], ring[(i + 1) % ring.length]);
    if (l > best) {
      best = l;
      bi = i;
    }
  }
  const a = ring[bi];
  const b = ring[(bi + 1) % ring.length];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return { dir: new Pt(dx / len, dy / len), ang: Math.atan2(dy, dx) };
}

/** 沿主轴把多边形等分成 n 份（切口宽 gap），返回面积从大到小 */
function sliceRing(ring: Pt[], n: number, gap = 0.24): Pt[][] {
  if (n <= 1) return [ring];
  const { dir } = ringAxis(ring);
  const nrm = new Pt(-dir.y, dir.x);
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of ring) {
    const t = p.x * dir.x + p.y * dir.y;
    lo = Math.min(lo, t);
    hi = Math.max(hi, t);
  }
  const span = hi - lo;
  if (span < 0.6) return [ring];
  const L = span * 1.5;
  const strips: Pt[][] = [];
  for (let k = 1; k < n; k++) {
    const t = lo + (span * k) / n;
    const o = new Pt(dir.x * t, dir.y * t);
    const a = new Pt(o.x - nrm.x * L, o.y - nrm.y * L);
    const b = new Pt(o.x + nrm.x * L, o.y + nrm.y * L);
    const s = stripe(a, b, gap);
    if (s) strips.push(s);
  }
  const parts = strips.length ? subtract(ring, strips) : [ring];
  return parts
    .filter((p) => p.length >= 3 && Math.abs(area(p)) > 0.22)
    .sort((a, b) => Math.abs(area(b)) - Math.abs(area(a)));
}

/**
 * 多边形停车区。`entry` 给出要接入的那条路的中线点（内部路 / 主路），
 * 不给就按"离地块红线最近的边"接。
 */
function parkingRegion(
  c: Ctx,
  region: Pt[],
  name: string,
  dims: Partial<StallDims> = {},
  share = 1,
  entry: Pt[] = []
) {
  if (region.length < 3) return;
  const avail = Math.abs(area(region));
  if (avail < 0.35) return;

  const d = parkingDemand(
    c.use,
    Math.abs(area(Array.from(c.block))),
    footprintArea(c),
    c.use === 'industrial' ? 'industrial' : 'urban',
    c.parkingLevel
  );
  if (d.target < 0.3) return;

  // §18 闸门：同一地块多次铺车位，合计不能突破硬上限
  const quota = Math.min(d.target * share, d.cap - c.parkUsed);
  if (quota < 0.3) return;

  // ① 面积封顶（内缩失败就切条，见 capRegion）
  const body = capRegion(region, quota);
  if (body.length < 3 || Math.abs(area(body)) < 0.3) return;

  // ② 拆簇（§5）：超过单块上限就切成两簇，中间留绿化带；
  //    切完仍然超标的，再切一层（最多三份）—— 一簇 4000 m² 的车场
  //    无论怎么划分车位都读不出"几块车场"，用户提的就是这个问题。
  const want = Math.abs(area(body)) > d.maxLot * 1.15 ? Math.max(2, d.clusters) : d.clusters;
  let parts = sliceRing(body, Math.max(1, Math.min(3, Math.round(want))));
  if (parts.some((p) => Math.abs(area(p)) > d.maxLot * 1.15) && parts.length < 3) {
    const second: Pt[][] = [];
    for (const p of parts) {
      if (Math.abs(area(p)) > d.maxLot * 1.15 && second.length + parts.length < 3) {
        const sub = sliceRing(p, 2);
        if (sub.length >= 2) {
          second.push(...sub.slice(0, 2));
          continue;
        }
      }
      second.push(p);
    }
    parts = second.slice(0, 3);
  }
  if (parts.length === 0) return;

  // ③ 逐簇排布
  parts.forEach((p, i) =>
    emitParkingRing(c, p, parts.length > 1 ? `${name}_${i}` : name, dims, d.islandRatio > 0, entry)
  );
}

/** 一个停车坪至少要排下这么多车位才算"场"。少于此数一律不生成（见 emitParkingRing）。 */
const MIN_LOT_BAYS = 3;
/**
 * 一块坪被绿岛切成两片时，**单片刻度**的车位下限。
 *
 * 只判整块（`MIN_LOT_BAYS`）挡不住用户截图里那种"边上孤零零一道白线"：
 * 一条 7 排 + 1 个的坪合计 8 位，闸门放行，末端那片仍然只有 1 个车位。
 * 单片少于 2 个的那一片直接不排 —— 那一小块退回坪面（沥青），看起来是
 * 一块规整的路肩，而不是画错的线。
 */
const MIN_PIECE_BAYS = 2;
/** 用"切一刀"补停车格时，切出来的带子最小宽度（u）：一排车位 + 通道 + 退让。 */
const MIN_PARK_BAND = 1.9;

/**
 * 一块多边形停车坪：求解 → 车位线 / 通道 / 绿化岛 / 出入口
 */
function emitParkingRing(
  c: Ctx,
  lotRaw: Pt[],
  name: string,
  dims: Partial<StallDims>,
  island: boolean,
  entry: Pt[],
  opt: {
    /**
     * 是否铺沥青。`groundPlan` 划出来的停车格**已经是沥青格**了，
     * 再铺一次就是同一块地面上两层沥青 —— 所以那里传 false。
     */
    surface?: boolean;
    /** 车位线 / 绿岛的高度（默认沿用旧的 0.0136 那一层的上方） */
    y?: number;
  } = {}
): number {
  const lot = lotFrontSetback(c, lotRaw);
  if (lot.length < 3 || Math.abs(area(lot)) < 0.3) return 0;
  const yBase = opt.y ?? 0.0136;

  const ax = ringAxis(lot);
  const d = Math.PI / 180;
  const angles = [ax.ang, ax.ang + Math.PI / 2, ax.ang + 45 * d, ax.ang + 30 * d, ax.ang + 60 * d].slice(
    0,
    5
  );
  // 绿岛走"先挖掉、再排车位"：先把那条绿带从坪里减掉，剩下的两块各自排车位，
  // 绿带最后铺在**挖出来的那个缺口**上。
  //
  // 旧做法是先把车位铺满整块坪、再把绿带盖在车位线上（0.032 > 车位线 0.0305），
  // 于是俯视图里出现一条"横穿车位、把两排车位切断"的草带 —— 用户截图里那条
  // 绿带就是这个。它本质上是"两层铺装叠在同一处"，不是设计意图。
  let band = island ? islandBand(lot, ax.dir) : null;
  let pieces = band ? subtract(lot, [band]).filter((p) => p.length >= 3 && Math.abs(area(p)) > 0.12) : [lot];

  // ---- 先求解、再决定要不要落面
  //
  // 用户核对意见（本轮，图 1 / 图 2）："有一部分停车场生成的结果不理想，
  // 只有一个车位" —— 那些地块上就是孤零零一两道白线，配一圈围栏几盏灯，
  // 读起来像一个画错的空场。
  //
  // 根因是**落面早于求解**：旧顺序是"先铺沥青、登记停车坪、摆围栏",
  // 最后才排车位 —— 于是求解一个都没排下（斜边格子、被绿岛切碎的窄条），
  // 沥青和围栏照样留在图上。现在把求解提到最前面：车位不够就整块不做，
  // 沥青不铺、范围不登记、围栏和灯不生成，调用方（`fillParkCells`）会把
  // 那一格改回硬地 —— 一块规整的后院，比一个一车位的停车场像样得多。
  const attempt = (ps: Pt[][]) => {
    const out: { lay: ParkLayout; tag: string }[] = [];
    let sum = 0;
    let dropped = 0;
    for (let i = 0; i < ps.length; i++) {
      const one = solveParking(ps[i], { ...CAR_STALL, ...dims, angles });
      // 只排下 1 个车位的那一片不要（见 MIN_PIECE_BAYS 的注释）：那一片退回
      // 坪面沥青，读起来是一块路肩，比一车位孤线干净。
      if (!one || one.count < MIN_PIECE_BAYS) {
        dropped++;
        continue;
      }
      sum += one.count;
      out.push({ lay: one, tag: ps.length > 1 ? `${name}_${i}` : name });
    }
    return { out, sum, dropped };
  };

  let res = attempt(pieces);
  // 绿岛把坪切碎（有片排不下 / 整块不够数）时**放弃绿岛重排一次**：
  // 小坪上割一条绿化带，两片各剩一两个车位，反而是用户截图里那种碎场。
  if (band && (res.dropped > 0 || res.sum < MIN_LOT_BAYS)) {
    const flat = attempt([lot]);
    if (flat.sum > res.sum) {
      band = null;
      pieces = [lot];
      res = flat;
      pushZoneDbg({ key: 'parkIslandDrop', bays: flat.sum, name });
    }
  }
  const solved = res.out;
  const total = res.sum;
  if (total < MIN_LOT_BAYS) {
    pushZoneDbg({ key: 'parkTiny', bays: total, a: +Math.abs(area(lot)).toFixed(2), name });
    return 0;
  }

  // ---- 求解通过，这时候才落面 / 登记
  if (opt.surface !== false) addSurface(c, `parking_${name}`, lot, 'asphaltLot', yBase);
  c.parkUsed += Math.abs(area(lot));
  // 登记成"停车坪范围"：植栽与围栏都要躲开它（`scatter` 读的就是这张表）
  (c.park ??= []).push(lot);

  for (const s of solved) emitParking(c, s.lay, s.tag);

  if (total >= 8) parkAccess(c, lot, name, entry);

  // 绿带既然已经挖掉了，就必须铺回去 —— 否则坪面上留一条空槽（沥青色）
  if (band) addIsland(c, lot, name, ax.dir, band, yBase);

  // 围栏：每块停车坪自己围一圈（原来只有专用停车用地围，商业 / 工业地块里的
  // 停车坪是敞着的 —— 用户核对时发现"停车场的围栏没有生成"）。
  // 专用停车用地例外：那里沿**地块边缘**围（parkingFence），不重复围坪。
  if (c.use !== 'parking') parkingLotFence(c, lot, entry, name);
  pushZoneDbg({ key: 'parkLot', bays: total, a: +Math.abs(area(lot)).toFixed(2), name });
  return total;
}

/**
 * 停车坪围栏：闭环 + 一个车道宽的开口。
 *
 * 开口位置：优先取 `entry`（出入口）最近的那条边；没有出入口就取最长边。
 * 围栏段落里若压到建筑（楼贴着停车坪），那一段直接跳过 —— 栏杆横穿楼体
 * 在三维里是穿模。
 *
 * **场内不立灯**（用户核对，本轮截图红框）："停车场里不要有小路灯"。
 * 原来这里还配了一段 `parkingLamps`：沿坪的长轴均布 2~3 根 0.42 缩放的细杆灯，
 * 立在通道上、贴着车位线 —— 近景就是两根突兀的黑杆。真实的场地照明装在
 * 围栏立柱或高杆灯上，不在车位之间，所以整段删掉，坪里只留铺装 + 车位线。
 */
function parkingLotFence(c: Ctx, lot: Pt[], entry: Pt[], name: string) {
  if (lot.length < 3) return;
  const openLen = u(PARK_OPEN_M);
  const paths: PathFeature[] = [];
  const props: PropFeature[] = [];

  // 找开口边：出入口所在的那条边；没有就取最长边
  let bestEdge = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < lot.length; i++) {
    const a = lot[i];
    const b = lot[(i + 1) % lot.length];
    const L = Pt.distance(a, b);
    if (L < 0.4) continue;
    const mid = new Pt((a.x + b.x) / 2, (a.y + b.y) / 2);
    let score = L * 0.2;
    for (const e of entry) score -= Pt.distance(mid, e) * 2;
    if (score > bestScore) {
      bestScore = score;
      bestEdge = i;
    }
  }
  if (bestEdge < 0) return;

  let k = 0;
  for (let i = 0; i < lot.length; i++) {
    const a = lot[i];
    const b = lot[(i + 1) % lot.length];
    const L = Pt.distance(a, b);
    if (L < 0.3) continue;

    let segs: Pt[][] = [[a, b]];
    if (i === bestEdge && L > openLen * 2.2) {
      const at = (t: number) => new Pt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
      const half = openLen / 2 / L;
      const t0 = Math.max(0.1, 0.5 - half);
      const t1 = Math.min(0.9, 0.5 + half);
      segs = [
        [a, at(t0)],
        [at(t1), b],
      ].filter((s) => Pt.distance(s[0], s[1]) > 0.25);
    }

    for (const seg of segs) {
      // 压到建筑的那一小段**截短**而不是整段跳过 ——
      // 整段跳过会让这条边完全没有栏杆，俯视图上就是"围栏有的有、有的没有"。
      let pts = seg;
      const mid = new Pt((seg[0].x + seg[1].x) / 2, (seg[0].y + seg[1].y) / 2);
      if (c.footprints.some((fp) => pointInPolygon(mid, fp))) {
        const trimmed = trimByFootprint(seg, c.footprints);
        if (!trimmed) continue;
        pts = trimmed;
      }
      addRail({
        pts,
        namePrefix: `parkfence_${name}_${i}_${k++}`,
        group: groupOf(c.use),
        y: 0.02,
        spec: RAIL_PARK,
        paths,
        props,
      });
    }
  }
  c.res.paths.push(...paths);
  c.res.props.push(...props);
}

/** 坪内绿化岛：沿主轴切一条窄带，裁到坪轮廓内 */
/**
 * 坪内绿岛的**几何**（不含铺地）。
 *
 * 单独拆出来，是因为它必须先参与"挖洞"：绿带从坪里减掉之后，剩下的两块
 * 才拿去排车位 —— 否则车位线会被草带横穿（旧版就是这样）。
 */
function islandBand(lot: Pt[], dir: Pt): Pt[] | null {
  const ctr = ringCenter(lot);
  const nrm = new Pt(-dir.y, dir.x);
  const L = Math.sqrt(Math.abs(area(lot))) * 1.5;
  const w = Math.sqrt(Math.abs(area(lot))) * 0.08;
  const band = stripe(
    new Pt(ctr.x - nrm.x * L, ctr.y - nrm.y * L),
    new Pt(ctr.x + nrm.x * L, ctr.y + nrm.y * L),
    w * 2
  );
  if (!band) return null;
  const parts = intersect(band, lot, 0.05).filter((g) => Math.abs(area(g)) > 0.12);
  if (parts.length === 0) return null;
  return parts.reduce((a, b) => (Math.abs(area(a)) >= Math.abs(area(b)) ? a : b));
}

/**
 * 铺绿岛：**只铺在挖出来的缺口上**（`band` 是 `emitParkingRing` 先减掉的那条带），
 * 高度压在车位线之上（草是地面，线是标线，草不该被线穿过去）。
 */
function addIsland(c: Ctx, lot: Pt[], name: string, dir: Pt, band: Pt[] | null, y: number) {
  const g = band ?? islandBand(lot, dir);
  if (!g) return;
  addSurface(c, `parking_${name}_island`, g, 'grass', y + 0.0004, false);
  // 树只种得下就种：小坪上挖出来的那条绿带往往只有一条缝，
  // 树冠（半径 ~0.5 u）会伸到车位线上去
  if (Math.abs(area(g)) < 0.5) return;
  const ctr = ringCenter(g);
  if (pointInPolygon(ctr, g)) addProp(c, 'tree', ctr, 0.9, 0, 'vegetation');
}


/** 贴到地块红线的那几条边各退 clear（主入口前场不能停车，§8） */
function clearFrontage(c: Ctx, box: Box4, clear: number): Box4 {
  const [u0, v0, u1, v1] = box;
  const { bb } = c;
  if (clear <= 0.05) return box;
  const tol = 0.14;
  // 单边最多吃掉该方向的三成，防止小地块被"入口禁停"整块吃掉
  const limU = Math.min(clear, (u1 - u0) * 0.3);
  const limV = Math.min(clear, (v1 - v0) * 0.3);
  let a = u0;
  let b = v0;
  let e = u1;
  let f2 = v1;
  if (Math.abs(u0 - bb.u0) < tol) a = u0 + limU;
  else if (Math.abs(u1 - bb.u1) < tol) e = u1 - limU;
  if (Math.abs(v0 - bb.v0) < tol) b = v0 + limV;
  else if (Math.abs(v1 - bb.v1) < tol) f2 = v1 - limV;
  return [a, b, e, f2];
}

/** 把局部矩形按面积缩到 allow 以内（缩短边，保证贴住地块一侧） */
function capBox(box: Box4, allow: number): Box4 {
  const [u0, v0, u1, v1] = box;
  const w = u1 - u0;
  const h = v1 - v0;
  if (w * h <= allow) return box;
  if (w >= h) {
    const nw = Math.max(0.6, allow / h);
    return [u0, v0, u0 + Math.min(nw, w), v1];
  }
  const nh = Math.max(0.6, allow / w);
  return [u0, v0, u1, v0 + Math.min(nh, h)];
}

/** 沿长边对半拆一次；拆不动（太窄）返回 null */
function halve(box: Box4): [Box4, Box4] | null {
  const [u0, v0, u1, v1] = box;
  const w = u1 - u0;
  const h = v1 - v0;
  if (Math.max(w, h) < 1.6) return null;
  const GAP = 0.24;
  if (w >= h) {
    const mid = (u0 + u1) / 2;
    return [
      [u0, v0, mid - GAP / 2, v1],
      [mid + GAP / 2, v0, u1, v1],
    ];
  }
  const mid = (v0 + v1) / 2;
  return [
    [u0, v0, u1, mid - GAP / 2],
    [u0, mid + GAP / 2, u1, v1],
  ];
}

/**
 * 拆簇：先按单块坪上限拆，再按建议簇数补拆。
 * 最多 3 块 —— 再多每块都排不出两排车位，反而更碎（§5 上限、§6 簇数）。
 */
function splitClusters(box: Box4, maxLot: number, clusters: number): Box4[] {
  const areaOf = (b: Box4) => (b[2] - b[0]) * (b[3] - b[1]);
  const want = Math.max(1, Math.min(3, Math.round(clusters)));

  let parts: Box4[] = [box];
  // ① 单块超上限 → 对半
  if (areaOf(box) > maxLot * 1.15) {
    const s = halve(box);
    if (s) parts = [s[0], s[1]];
  }
  // ② 簇数不够 → 反复拆当前最大且拆得动的那块
  let guard = 0;
  while (parts.length < want && guard++ < 4) {
    const order = [...parts].sort((a, b) => areaOf(b) - areaOf(a));
    let done = false;
    for (const p of order) {
      const s = halve(p);
      if (!s) continue;
      parts = parts.filter((q) => q !== p).concat(s);
      done = true;
      break;
    }
    if (!done) break;
  }
  // ③ 每块仍然超上限 → 各自再拆一次（不做递归，避免碎片化）
  parts = parts.flatMap((p) => {
    if (areaOf(p) <= maxLot * 1.15) return [p];
    const s = halve(p);
    return s ? [s[0], s[1]] : [p];
  });
  return parts.filter((p) => p[2] - p[0] > 0.4 && p[3] - p[1] > 0.4);
}

/** 两簇之间的缝隙（绿化带位置） */
function gapBetween(a: Box4, b: Box4): [number, number] | null {
  if (Math.abs(a[1] - b[1]) < 1e-6) {
    return b[0] > a[2] ? [a[2], b[0]] : null;
  }
  if (Math.abs(a[0] - b[0]) < 1e-6) {
    return b[1] > a[3] ? [a[3], b[1]] : null;
  }
  return null;
}

/** 一块停车坪：裁到地块内 → 排布求解 → 落车位线与通道 → 绿化岛 */
function emitParkingLot(
  c: Ctx,
  box: Box4,
  alongU: boolean,
  name: string,
  dims: Partial<StallDims>,
  island: boolean
) {
  const [u0, v0, u1, v1] = box;
  if (u1 - u0 < 0.45 || v1 - v0 < 0.45) return;
  const ring = alongU ? rect(c.f, u0, u1, v0, v1) : rect(c.f, v0, v1, u0, u1);

  const clipped = intersect(ring, Array.from(c.block), 0.25);
  if (clipped.length === 0) return;
  const raw = clipped.reduce((a, b) => (area(a) > area(b) ? a : b));
  const lot = lotFrontSetback(c, raw);
  if (area(lot) < 0.3) return;

  // 先求解再落面：排不下 `MIN_LOT_BAYS` 个车位的窄条，整块不做。
  // （与 `emitParkingRing` 同一条闸门 —— 见那里的注释。）
  const lay = solveParking(lot, { ...CAR_STALL, ...dims, angles: candidateAngles(c) });
  if (!lay || lay.count < MIN_LOT_BAYS) {
    pushZoneDbg({ key: 'parkTiny', bays: lay?.count ?? 0, a: +Math.abs(area(lot)).toFixed(2), name });
    return;
  }
  addSurface(c, `parking_${name}`, lot, 'asphaltLot', 0.0136);
  c.parkUsed += Math.abs(area(lot));
  emitParking(c, lay, name);
  pushZoneDbg({ key: 'parkLot', bays: lay.count, a: +Math.abs(area(lot)).toFixed(2), name });

  // §12 车场必须有出入口，且通道能一路走到道路：从坪边拉一条引道到地块红线，
  // 引道上点一条白色导向箭头，俯视图里就能读出"车从哪里进出"。
  if (lay.count >= 8) parkAccess(c, lot, name);

  // §10 绿化岛：车位 > 20 或面积 > 1000 m² 时留 5%~12%。
  // 画在车位线之上，视觉上就是"这一排被岛子打断了"，和真实停车场读起来一致。
  // 必须裁到这块坪自己的轮廓内，否则岛子会溢到还没铺车位的余地里。
  if (island && lay.count >= 20) {
    const du = u1 - u0;
    const dv = v1 - v0;
    const frac = 0.08;
    const iu: [number, number] = alongU
      ? [u0 + du * 0.08, u0 + du * 0.92]
      : [u0 + du * 0.5 - du * frac * 0.5, u0 + du * 0.5 + du * frac * 0.5];
    const iv: [number, number] = alongU
      ? [v0 + dv * 0.5 - dv * frac * 0.5, v0 + dv * 0.5 + dv * frac * 0.5]
      : [v0 + dv * 0.08, v0 + dv * 0.92];
    const ir = rect(c.f, iu[0], iu[1], iv[0], iv[1]);
    const inside = intersect(ir, lot, 0.05);
    for (const g of inside) {
      if (Math.abs(area(g)) < 0.12) continue;
      addSurface(c, `parking_${name}_island`, g, 'grass', 0.032, false);
    }
    const mid = world(c.f, (iu[0] + iu[1]) / 2, (iv[0] + iv[1]) / 2);
    if (pointInPolygon(mid, lot)) addProp(c, 'tree', mid, 0.9, 0, 'vegetation');
  }
}

/**
 * 车场引道：从坪轮廓离地块红线最近的那条边中点拉一条引道到红线，
 * 再在引道上点一条白色导向箭头。
 */
function parkAccess(c: Ctx, lot: Pt[], name: string, entry: Pt[] = []) {
  const center = ringCenter(lot);
  let bestD = Infinity;
  let bestQ: Pt | null = null;

  // 优先接给定的那条路（内部路）：从坪心往路上找最近点
  const road = entry.length >= 2 ? entry : c.block;
  const closed = entry.length < 2;
  const n = road.length;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const q = closestOnSegment(center, road[i], road[(i + 1) % n]);
    const d = Pt.distance(center, q);
    if (d < bestD) {
      bestD = d;
      bestQ = q;
    }
  }
  if (!bestQ || bestD < 0.25) return;

  // 引道起点：从红线点朝坪心方向走，第一次进入坪轮廓的地方就是出入口
  const dir = new Pt(center.x - bestQ.x, center.y - bestQ.y);
  const len = Math.hypot(dir.x, dir.y) || 1;
  const inward = new Pt(dir.x / len, dir.y / len);
  let start: Pt | null = null;
  for (let t = 0.02; t < len; t += 0.04) {
    const p = new Pt(bestQ.x + inward.x * t, bestQ.y + inward.y * t);
    if (pointInPolygon(p, lot)) {
      start = p;
      break;
    }
  }
  if (!start) return;

  const gap = Pt.distance(bestQ, start);
  // 坪紧贴红线（余地里没有绿带）时没有引道可画，只标出入口箭头
  // 引道用沥青、压在标线之下（0.0128 < 0.017）：
  // 老版是 0.62 宽的混凝土带画在 y=0.02，等于把一块浅色"药丸"盖在路面上，
  // 放大看像路中间多了个不明构件。停车场的进出口本来就是车行道的延续。
  if (gap > 0.22) addPath(c, `parking_${name}_drive`, [bestQ, start], 0.55, 'asphalt', 0.0128);

  // 导向箭头：沿"入口 → 场内"方向，落在引道中段（无引道时落在入口内侧一点点）
  const step = gap > 0.22 ? gap * 0.55 : 0.35;
  const mid = new Pt(bestQ.x + inward.x * step, bestQ.y + inward.y * step);
  const ux = inward.x;
  const uy = inward.y;
  const shaft = stripe(new Pt(mid.x - ux * 0.2, mid.y - uy * 0.2), new Pt(mid.x + ux * 0.05, mid.y + uy * 0.05), 0.055);
  if (shaft) addSurface(c, `parking_${name}_arr`, shaft, 'markWhite', 0.027, false);
  const nx = -uy;
  const ny = ux;
  const tip = new Pt(mid.x + ux * 0.16, mid.y + uy * 0.16);
  const head = [tip, new Pt(mid.x + nx * 0.085, mid.y + ny * 0.085), new Pt(mid.x - nx * 0.085, mid.y - ny * 0.085)];
  addSurface(c, `parking_${name}_arh`, head, 'markWhite', 0.027, false);
}

/** 候选角度：地块主朝向 + 常见斜列角度（弧度） */
function candidateAngles(c: Ctx): number[] {
  const a0 = Math.atan2(c.f.u.y, c.f.u.x);
  const d = Math.PI / 180;
  return [a0, a0 + Math.PI / 2, a0 + 45 * d, a0 + 30 * d, a0 + 60 * d, a0 + 90 * d, a0 + 75 * d, a0 + 15 * d];
}

const BAY_LINE = 0.026;

/** 一条线 → 细长矩形（车位分隔线） */
function stripe(a: Pt, b: Pt, t: number): Pt[] | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return null;
  const nx = (-dy / len) * t * 0.5;
  const ny = (dx / len) * t * 0.5;
  return [
    new Pt(a.x + nx, a.y + ny),
    new Pt(b.x + nx, b.y + ny),
    new Pt(b.x - nx, b.y - ny),
    new Pt(a.x - nx, a.y - ny),
  ];
}

/** 把共线的线段合并成整条（一排车位 → 一条长线），否则车位线会多出几千个图元 */
function mergeCollinear(segs: [Pt, Pt][]): [Pt, Pt][] {
  interface Bucket {
    nx: number;
    ny: number;
    tMin: number;
    tMax: number;
    s0: Pt;
    s1: Pt;
  }
  const buckets = new Map<string, Bucket>();
  for (const [a, b] of segs) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    let ux = dx / len;
    let uy = dy / len;
    // 方向规范到上半平面，避免同一条线因端点顺序不同被分到两个桶
    if (ux < -1e-9 || (Math.abs(ux) <= 1e-9 && uy < 0)) {
      ux = -ux;
      uy = -uy;
    }
    const off = a.x * uy - a.y * ux;
    const key = `${Math.round(ux * 2048)},${Math.round(uy * 2048)},${Math.round(off * 512)}`;
    const t0 = a.x * ux + a.y * uy;
    const t1 = b.x * ux + b.y * uy;
    const lo = Math.min(t0, t1);
    const hi = Math.max(t0, t1);
    const bk = buckets.get(key);
    if (!bk) buckets.set(key, { nx: ux, ny: uy, tMin: lo, tMax: hi, s0: a, s1: b });
    else {
      bk.tMin = Math.min(bk.tMin, lo);
      bk.tMax = Math.max(bk.tMax, hi);
    }
  }
  const out: [Pt, Pt][] = [];
  for (const bk of buckets.values()) {
    const off = bk.s0.x * bk.ny - bk.s0.y * bk.nx;
    // 点 = off * n + t * n⊥
    const px = bk.ny * off;
    const py = -bk.nx * off;
    out.push([
      new Pt(px + bk.nx * bk.tMin, py + bk.ny * bk.tMin),
      new Pt(px + bk.nx * bk.tMax, py + bk.ny * bk.tMax),
    ]);
  }
  return out;
}

/** 把求解结果落地：每排一条车位封口线 + 通道铺装 */
function emitParking(c: Ctx, lay: ParkLayout, prefix: string) {
  c.res.bays += lay.count;

  // 车位分隔线：一格一条。单个 quad，两个三角面，一城加起来约两千面 ——
  // 比"每排只画一条封口线"贵一点，但俯视图里正是这些竖线让停车场读得出来。
  for (let i = 0; i < lay.dividers.length; i++) {
    const ring = stripe(lay.dividers[i][0], lay.dividers[i][1], BAY_LINE);
    if (ring) addSurface(c, `${prefix}_bay_${i}`, ring, 'markWhite', 0.0305, false);
  }
  // 每排一条封口线（沿通道那一侧），合并共线后只落几条
  const rows = mergeCollinear(lay.fronts);
  for (let i = 0; i < rows.length; i++) {
    const ring = stripe(rows[i][0], rows[i][1], BAY_LINE);
    if (ring) addSurface(c, `${prefix}_row_${i}`, ring, 'markWhite', 0.031, false);
  }
  // 通道比停车坪略深一点，让"车道"从车位线里读得出来
  for (let i = 0; i < lay.aisles.length; i++) {
    addSurface(c, `${prefix}_lane_${i}`, lay.aisles[i], 'asphalt', 0.013, false);
  }
}

/** 在可建区里随机取点，避开建筑 */
function sampleIn(c: Ctx, avoid: Pt[][], minDist: number): Pt | null {
  const ring = Array.from(c.block);
  for (let i = 0; i < 60; i++) {
    const p = world(c.f, c.bb.u0 + Rng.float() * c.bb.w, c.bb.v0 + Rng.float() * c.bb.h);
    if (!pointInPolygon(p, ring)) continue;
    let ok = true;
    for (const b of avoid) {
      if (pointInPolygon(p, b)) {
        ok = false;
        break;
      }
      // 离轮廓太近也不要（会被建筑盖住）
      if (withinRing(p, b, minDist)) {
        ok = false;
        break;
      }
    }
    if (ok) return p;
  }
  return null;
}

function withinRing(p: Pt, ring: Pt[], d: number): boolean {
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-9) continue;
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    t = clamp(t, 0, 1);
    const qx = a.x + dx * t;
    const qy = a.y + dy * t;
    if (Math.hypot(p.x - qx, p.y - qy) < d) return true;
  }
  return false;
}

function scatter(c: Ctx, count: number, opts: { avoid?: Pt[][]; minDist?: number; kind?: PropKind }) {
  const n = Math.min(count, TREE_LIMIT);
  // 停车格永远不种树：地面已经分好角色了，树只能种在草地 / 院子里。
  // 旧版只躲建筑轮廓，于是树被撒在车位线上（用户截图里"停车场里长树"）。
  const avoid = [...(opts.avoid ?? []), ...(c.park ?? [])];
  for (let i = 0; i < n; i++) {
    const p = sampleIn(c, avoid, opts.minDist ?? 0.4);
    if (!p) continue;
    if ((c.park ?? []).some((r) => pointInPolygon(p, r))) continue;
    addProp(c, opts.kind ?? 'tree', p, 0.85 + Rng.float() * 0.4, Rng.float() * Math.PI * 2);
  }
}

/**
 * 地块边界"取段"：挑最长的几条边，按内部路口的位置切成若干可用的直线段。
 *
 * 抽出来是因为两种边界构件都用它 —— 厂区围栏（栏杆）和广场边界（低矮绿篱）。
 * 内部路的进出口必须挖口子：围栏沿地块边界走，而内部路的端口也在边界上，
 * 不挖就会出现"栏杆横在车行道上"。
 */
function boundaryRuns(c: Ctx, segments: number, gaps: { at: Pt; r: number }[] = []): Pt[][] {
  const ring = Array.from(c.block);
  const edges: { a: Pt; b: Pt; l: number }[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    edges.push({ a, b, l: Pt.distance(a, b) });
  }
  edges.sort((p, q) => q.l - p.l);
  const take = edges.slice(0, Math.max(1, Math.min(segments, edges.length)));
  const out: Pt[][] = [];

  for (const e of take) {
    const dx = e.b.x - e.a.x;
    const dy = e.b.y - e.a.y;
    const L = Math.hypot(dx, dy) || 1;
    const ux = dx / L;
    const uy = dy / L;
    const cuts: [number, number][] = [];
    for (const g of gaps) {
      const t = (g.at.x - e.a.x) * ux + (g.at.y - e.a.y) * uy;
      const off = Math.abs((g.at.x - e.a.x) * -uy + (g.at.y - e.a.y) * ux);
      if (off > g.r) continue;
      cuts.push([Math.max(0, t - g.r), Math.min(L, t + g.r)]);
    }
    cuts.sort((p, q) => p[0] - q[0]);
    let s = 0;
    const push = (s0: number, s1: number) => {
      if (s1 - s0 < 0.25) return;
      out.push([new Pt(e.a.x + ux * s0, e.a.y + uy * s0), new Pt(e.a.x + ux * s1, e.a.y + uy * s1)]);
    };
    for (const [c0, c1] of cuts) {
      if (c0 > s) push(s, c0);
      s = Math.max(s, c1);
    }
    if (s < L) push(s, L);
  }
  return out;
}

/** 厂区 / 停车场边界围栏：通透栏杆（双横杆 + 立柱），不是实心矮墙 */
function boundaryRail(c: Ctx, segments: number, spec = RAIL_PARK, gaps: { at: Pt; r: number }[] = []) {
  const paths: PathFeature[] = [];
  const props: PropFeature[] = [];
  boundaryRuns(c, segments, gaps).forEach((seg, i) => {
    addRail({
      pts: seg,
      namePrefix: `bounds_${i}`,
      group: groupOf(c.use),
      y: 0.02,
      spec,
      paths,
      props,
    });
  });
  c.res.paths.push(...paths);
  c.res.props.push(...props);
}

/**
 * 公共 / 广场边界：低矮绿篱（分块，块间留缝）。
 *
 * 原来这里是 "围栏" —— 一堵 4 m 高的实心墙围住市政地块的两条边，从街上完全看
 * 不进广场。参考图里广场边界是**修剪过的低矮灌木**：视线能过、人能看见里面。
 */
function boundaryHedge(c: Ctx, segments: number, gaps: { at: Pt; r: number }[] = []) {
  const props: PropFeature[] = [];
  boundaryRuns(c, segments, gaps).forEach((seg, i) => {
    addHedgeRun({
      pts: seg,
      namePrefix: `edgehedge_${i}`,
      group: groupOf(c.use),
      props,
    });
  });
  c.res.props.push(...props);
}

/**
 * 地块边界围边：**绿篱与栏杆在同一条路径上交替排布**，路口不摆。
 *
 * 用户核对意见（本轮，图 1）：
 *   "绿篱应该和围栏在同一个路径上被克隆，按间距混合间隔摆放，
 *    这里路径是指地块的绿地与人行道之间的地面围线"。
 *
 * 之前的问题：绿篱和栏杆各占**整段**（2 段栏杆 + 3 段绿篱，每段 5.5 m），
 * 于是沿边界看过去是"一长溜栏杆…一长溜绿篱…"两块截然不同的东西；
 * 而绿篱自己又在别处（种植池 / 广场边界）另起一条线，两条线一错开，
 * 就读成"绿篱没跟上围栏"。
 *
 * 现在的口径：
 *   · **一条路径**：就是临街那段地块边界（绿地外侧 = 人行道内侧的那条围线），
 *     两种构件都在这条线上，零横向偏移，共用同一个游标；
 *   · **按间距混排**：以 `EDGE_SEQ` 为循环单元，一个单元 = 一段栏杆(2.6 m)
 *     或一块绿篱(1.5 m 块 + 0.35 m 缝)，沿路径依次摆放 ——
 *     栏杆、绿篱、绿篱、栏杆、绿篱… 视觉上是"两种东西交替着把边界围起来"；
 *   · **路口不摆**：离地块环的转角 2.5 m 以内整块跳过；显式出入口（gaps）同样跳过。
 */
const FENCE_PANEL_M = 2.6; // 一段栏杆：两根立柱 + 双横杆
const HEDGE_BLOCK_M = 1.5; // 一块绿篱长
const HEDGE_GAP_M = 0.35; // 绿篱块间留缝
/** 混排循环：栏杆 → 绿篱 → 绿篱 → 栏杆 → 绿篱（栏杆≈5.2 m / 绿篱≈5.6 m，约 1:1） */
const EDGE_SEQ: ('rail' | 'hedge')[] = ['rail', 'hedge', 'hedge', 'rail', 'hedge'];

function boundaryFence(c: Ctx, opts: { spec?: RailSpec; gaps?: { at: Pt; r: number }[] } = {}) {
  const ring = Array.from(c.block);
  if (ring.length < 3) return;
  const spec = opts.spec ?? RAIL_PARK;
  const gaps = opts.gaps ?? [];

  // 只在**靠近路的地块边缘**摆：街区的外沿就是城市道路，
  // 所以"离 patch（街区）边界 3.5 m 以内的那条边"就是临街面。
  // 地块内部的分割线两侧不放 —— 那些地方本该是院子，不是围栏。
  const patchRing = c.patch.shape.length >= 3 ? c.patch.shape : null;
  const nearRoad = (a: Pt, b: Pt): boolean => {
    if (!patchRing) return false;
    const mid = new Pt((a.x + b.x) / 2, (a.y + b.y) / 2);
    return distToRing(mid, patchRing) < u(3.5);
  };

  const railLen = u(FENCE_PANEL_M);
  const hedgeLen = u(HEDGE_BLOCK_M + HEDGE_GAP_M);
  const cornerClear = u(2.5);

  const paths: PathFeature[] = [];
  const props: PropFeature[] = [];
  let hedgeRun = 0;
  let railRun = 0;
  // 起点相位随机，否则每块地的围边长得一模一样
  let seqIdx = Rng.int(0, EDGE_SEQ.length - 1);

  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const L = Pt.distance(a, b);
    if (L < u(2)) continue;
    if (!nearRoad(a, b)) continue; // 只有临街的边才摆

    const at = (t: number) => new Pt(a.x + ((b.x - a.x) * t) / L, a.y + ((b.y - a.y) * t) / L);

    // 一条边一个游标：栏杆和绿篱共用它，所以两者必然首尾相接、同在一条线上
    let s = 0;
    let guard = 0;
    while (s < L - u(0.6) && guard++ < 400) {
      const kind = EDGE_SEQ[seqIdx % EDGE_SEQ.length];
      const len = kind === 'rail' ? railLen : hedgeLen;
      const s1 = Math.min(L, s + len);
      if (s1 - s < u(0.5)) break;

      const p0 = at(s / L);
      const p1 = at(s1 / L);
      const mid = new Pt((p0.x + p1.x) / 2, (p0.y + p1.y) / 2);

      const blocked =
        ring.some((q) => Pt.distance(mid, q) < cornerClear) ||
        gaps.some((g) => Pt.distance(mid, g.at) < g.r);

      if (!blocked) {
        if (kind === 'hedge') {
          addHedgeRun({
            pts: [p0, p1],
            namePrefix: `edgehedge_${hedgeRun++}`,
            group: groupOf(c.use),
            props,
          });
        } else {
          addRail({
            pts: [p0, p1],
            namePrefix: `bounds_${railRun++}`,
            group: groupOf(c.use),
            y: 0.02,
            spec,
            paths,
            props,
          });
        }
      }

      s = s1;
      seqIdx++;
    }
  }
  c.res.paths.push(...paths);
  c.res.props.push(...props);
}

/**
 * 地块边线：住宅院子里**自己那圈界线**（绿篱）。
 *
 * 为什么需要它：住宅地块的地面本来就是草，沿街一条前院草坪也是草，
 * 于是整片街区从空中看就是一整块大草坪上摆了几栋楼 —— 地块之间只剩
 * 沥青巷子的黑白对比，读不出"这是一户人家"。
 *
 * 真实住宅区的界线是看得见的：院子之间有 1 m 上下的绿篱 / 木栅。
 * 所以这里只在**非临街**的边上摆（临街那侧是前院开口，围起来就把门堵了），
 * 两端各让 2.2 m 给转角，中间按 1.5 m 块 + 0.35 m 缝排过去。
 *
 * 只给住宅用：商业 / 工业的地块界线是围墙或本来就不该有（店面要通透），
 * 市政是广场，界线交给 `boundaryFence`。
 */
function lotLineHedge(c: Ctx): void {
  const ring = Array.from(c.block);
  if (ring.length < 3) return;
  const street = c.streetEdges ?? [];
  const ctr = ringCenter(ring);
  const inset = u(0.35);
  const cornerClear = u(2.2);
  const props: PropFeature[] = [];
  let k = 0;

  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const L = Pt.distance(a, b);
    if (L < u(5)) continue;
    // 临街边跳过：那是前院朝向马路的一侧
    const mid = new Pt((a.x + b.x) / 2, (a.y + b.y) / 2);
    if (street.some((e) => Pt.distance(mid, closestOnSegment(mid, e.a, e.b)) < u(0.8))) continue;

    const ux = (b.x - a.x) / L;
    const uy = (b.y - a.y) / L;
    let nx = -uy;
    let ny = ux;
    if ((ctr.x - mid.x) * nx + (ctr.y - mid.y) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    const a0 = new Pt(a.x + ux * cornerClear + nx * inset, a.y + uy * cornerClear + ny * inset);
    const b0 = new Pt(b.x - ux * cornerClear + nx * inset, b.y - uy * cornerClear + ny * inset);
    if (Pt.distance(a0, b0) < u(3)) continue;
    addHedgeRun({
      pts: [a0, b0],
      namePrefix: `lothedge_${k++}`,
      group: groupOf(c.use),
      props,
    });
  }
  c.res.props.push(...props);
}


// ---------------------------------------------------------------- 街区内部环路

const MITER_LIM = 3.0;

/** 单位向量 */
function unitOf(p: Pt): Pt {
  const l = Math.hypot(p.x, p.y);
  return l < 1e-9 ? new Pt(1, 0) : new Pt(p.x / l, p.y / l);
}

/** 左法线（沿前进方向左手边；CCW 多边形的内侧就是左手边） */
function leftOf(d: Pt): Pt {
  return new Pt(-d.y, d.x);
}

/**
 * 闭合折线按有符号距离偏移（正 = 内侧，前提是多边形 CCW）。
 *
 * 与 `road/system.ts` 的 `offsetLine` 同式，但那边把折线当开放序列处理
 * （首尾点只用端段法线），这里按环处理 —— 每个顶点都拿前后两段求斜接，
 * 于是接缝处不会缺一块楔形。单独一份是为了避开 town → road 的循环依赖。
 */
function offsetRing(ring: Pt[], d: number): Pt[] {
  const n = ring.length;
  if (n < 3) return ring.slice();
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const p = ring[i];
    const prev = ring[(i + n - 1) % n];
    const next = ring[(i + 1) % n];
    const e0 = unitOf(new Pt(p.x - prev.x, p.y - prev.y));
    const e1 = unitOf(new Pt(next.x - p.x, next.y - p.y));
    const a = new Pt(p.x + leftOf(e0).x * d, p.y + leftOf(e0).y * d);
    const b = new Pt(p.x + leftOf(e1).x * d, p.y + leftOf(e1).y * d);
    // 两条偏移线的交点 —— 这才是"偏移"的定义。
    //
    // 之前用的是"平均法线 × d/cos(半角)"那套：它对角平分线对称的角是对的，
    // 但在**凹角**上 cos(半角) 是负的，`Math.max(cos, 1/3)` 会把它钳成 +1/3，
    // 于是交点被甩到 3d 之外、方向还反了 —— L 形轮廓的凹角上就是一大块
    // 糊到地块外面的沥青。改成解方程，凸凹都成立。
    const den = e0.x * e1.y - e0.y * e1.x;
    if (Math.abs(den) < 1e-6) {
      // 调头（≈180°）：两条偏移线平行，直接斜切
      out.push(a, b);
      continue;
    }
    const s = ((b.x - a.x) * e1.y - (b.y - a.y) * e1.x) / den;
    const m = new Pt(a.x + e0.x * s, a.y + e0.y * s);
    // 尖角保护：交点跑出 MITER_LIM·|d| 就不做斜接，改用两个偏移点斜切，
    // 免得细长尖角把条带拉出一条几百米长的楔子。
    if (Math.hypot(m.x - p.x, m.y - p.y) > MITER_LIM * Math.abs(d)) {
      out.push(a, b);
      continue;
    }
    out.push(m);
  }
  return out;
}

/**
 * 环带按**逐边四边形**铺，不要拼"内圈 + 反向外圈"的一整个环。
 *
 * 拼接法在凹口上必翻车：内圈局部会顶到外圈外面，两条边真的相交，而 earcut /
 * nonzero 填充遇到自交环时会把重叠区**抵消**掉 —— 表现成一条从外圈直通内圈的
 * 楔形缺口，看上去就是环路断了一截。自交检测抓不到（它只判"真相交"，这种
 * 折叠经常刚好相切），面积检测也抓不到（只掉一成）。
 * `zones.subtract` 也救不了：它把多边形的洞扔掉，环带差完只剩下外圈。
 *
 * 逐边四边形没有这个问题：每条边的四个角都用**同一个斜接点**（相邻边共享），
 * 缝是严丝合缝的；凹角处两块会轻微重叠，同材质同高度，看不见。
 *
 * @param a 外边界相对界边的偏移（0 = 直接压在界边上）
 * @param b 内边界相对界边的偏移（带符号，朝环内为正）
 */
function edgeBands(ring: Pt[], a: number, b: number): Pt[][] {
  const n = ring.length;
  if (n < 3) return [];
  const A = offsetRing(ring, a);
  const B = offsetRing(ring, b);
  const out: Pt[][] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const quad = [A[i], A[j], B[j], B[i]];
    if (quad.some((p) => !p)) continue;
    if (Math.abs(area(quad)) < 1e-4) continue;
    if (!simpleRing(quad)) continue;
    out.push(quad);
  }
  return out;
}

/** 禁建区里"该有车行道"的内容类型。林地/公园不铺环路 —— 那里本来就只走园路。 */
const LOOP_PURPOSES = new Set(['cbd', 'industrial', 'residential', 'commercial']);

/**
 * **禁建区专用**的服务环路。
 *
 * 为什么只给禁建区铺：
 * 城市路网是"张量场追流线 → 平面图 → 布尔切面"解出来的，绝大多数街区它都解得动，
 * 而且解得对 —— 给普通街区硬套一圈环路，只会把街区再切小一层，把路网密度推回去。
 * 真正解不动的是**禁建区**：那是一整块用户画的自定义轮廓，形状必须原样保留，
 * 路网不能穿它、不能简化它，只能在它外面绕。硬绕的结果就是环绕它的城市路
 * 被挤成一条条又短又碎、入射角恨不得 90° 的街 —— 路口畸形、碎边遍地的根源。
 *
 * 所以这里的取舍是：禁建区**不参与城市路网的求解**，改成自己内部的一条服务环路。
 * 它不是城市路：断面窄（5.5 m）、没有交叉口、不画标线、只从一处开口接出去。
 * 路网从此不用在禁区边界上凑形状，"绕禁区一圈的生硬道路"这个问题在源头上消失。
 *
 * 做法：把禁区轮廓往里退出一条带（绿带 → 车行道 → 人行道），铺成闭合环路，
 * 然后把 `c.block` 换成环路内侧的核心区，各用途规划照旧在里面排楼 ——
 * 下游一行都不用改。
 *
 * 三道闸门（少一道就会铺出自交面或者把可建地吃光）：
 *   1. 跨度 ≥ `loopMinM`（默认 80 m）：太小的禁区退完三条带就没剩什么了；
 *   2. 退完之后核心区还剩 ≥ 24 单位²：太瘦/太碎的轮廓不硬套；
 *   3. 三条带都必须成简单环：凹得厉害的轮廓偏移后自交，逐档收窄绿带再试。
 */
function applyServiceLoop(c: Ctx): void {
  const P = c.model.params.block;
  if (!P.serviceLoop) return;
  // 自建场地（zonePad）里没有任何"要被服务"的内容：环路只会在这块本该空着的
  // 地上画一圈路 + 绿带 + 人行道，把用户要的那块完整硬地切碎。
  if (P.zonePad && (c.patch.purpose ?? 'cbd') !== 'forest' && (c.patch.purpose ?? 'cbd') !== 'park') return;
  // 只给禁建区：`blocked` 的地块就是禁区本身（或几乎整块落在禁区里的残块）。
  // 普通街区的可达性交给城市路网，这里一行都不碰 —— 全城铺环路只会把街区
  // 再切小一层，等于换个名字继续加密路网。
  if (!c.patch.blocked) return;
  if (!LOOP_PURPOSES.has(c.patch.purpose ?? 'cbd')) return;

  const ring = Array.from(c.block);
  if (ring.length < 3 || !isSimpleRing(ring)) return;
  const span = spanOf(ring);
  if (span * 7 < P.loopMinM) {
    pushZoneDbg({ key: 'loopSkip', why: 'span', spanM: +(span * 7).toFixed(1), need: P.loopMinM });
    return;
  }

  // 地块环上有很多 0.1 m 级的碎边（内缩 + 布尔留下的），直接按 12 m 偏移会自己
  // 折回去。先做一次温和简化（只合 <1.75 m 的短边、只删 <5° 的近平角），
  // 偏移才稳定。副作用是边界最多内移 1~2 m —— 这条缝由下面第一圈的绿带吃掉
  // （绿带的外边界用的是**原始**地块环，不是简化后的）。
  const clean = simplifyRing(ring, { minEdge: 0.25, maxTurn: 5 });
  if (clean.length < 3 || !isSimpleRing(clean)) {
    pushZoneDbg({ key: 'loopSkip', why: 'cleanBad', n: clean.length });
    return;
  }

  let perim = 0;
  for (let i = 0; i < clean.length; i++) perim += Pt.distance(clean[i], clean[(i + 1) % clean.length]);
  const aOut = Math.abs(area(clean));
  // 真正该判的不是"最长对角线"，是**内切半径** —— 一条 150×40 m 的带形地块
  // 跨度 155 m，可它垂直于长轴只有 40 m，退三条带之后核心区就没了。
  // r_in ≈ 2A / P（正方形退化成 a/2，与真实内切半径一致）。
  const rIn = perim > 1e-6 ? (2 * aOut) / perim : 0;

  const w = u(P.loopW);
  const sw = u(1.5);
  const sg = area(clean) < 0 ? -1 : 1;

  // 三条带都从**简化后的环**上逐边铺出来（见 edgeBands）。偏移量都带 sg 符号：
  // `clean` 若为顺时针，左法线朝外，乘 -1 才朝环内。
  const inw = (d: number) => sg * d;

  // 绿带宽度按 1 → 0.6 → 0.3 逐档退让。
  //
  // 不再有"绿带归零、环路直接压红线"这一档：那样铺出来的环路和城市路的人行道
  // 只隔一条 1.5 m 的硬质带，从空中看是一条 15 m 宽的宽路，读不出"地块内部有
  // 环路"这件事 —— 而这正是这一层要解决的问题。宁可这块地不铺环路。
  const vgMax = u(P.loopVergeM);
  const vgSteps = vgMax > 1e-4 ? [vgMax, vgMax * 0.6, vgMax * 0.3] : [0];
  let verge: Pt[][] = [];
  let road: Pt[][] = [];
  let walk: Pt[][] = [];
  let core: Pt[] | null = null;
  let usedVg = 0;
  for (const vg of vgSteps) {
    const cut = vg + w + sw;
    if (cut > rIn * 0.34) continue;
    const p1 = offsetRing(clean, sg * vg);
    const p2 = offsetRing(clean, sg * (vg + w));
    const p3 = offsetRing(clean, sg * cut);
    if (!isSimpleRing(p3)) continue;
    const rd = edgeBands(clean, inw(vg), inw(vg + w));
    if (rd.length === 0) continue;
    const wk = edgeBands(clean, inw(vg + w), inw(cut));
    if (wk.length === 0) continue;
    // 绿带的外边界取**原始**环：简化把边界往里挪了多少，这条带就补回来多少，
    // 不会在红线边上留一条没铺到的缝。所以这里外边界用的偏移是 0。
    const vgBands = vg > 1e-4 ? edgeBands(ring, 0, inw(vg)) : [];
    if (vg > 1e-4 && vgBands.length === 0) continue;
    verge = vgBands;
    road = rd;
    walk = wk;
    core = p3;
    usedVg = vg;
    break;
  }
  if (road.length === 0 || walk.length === 0 || !core) {
    pushZoneDbg({ key: 'loopSkip', why: 'bandBad', n: clean.length, rInM: +(rIn * 7).toFixed(1) });
    return;
  }
  const aIn = Math.abs(area(core));
  if (aIn < 24) {
    pushZoneDbg({ key: 'loopSkip', why: 'coreSmall', aOut: +aOut.toFixed(1), aIn: +aIn.toFixed(1) });
    return;
  }

  // 差集可能把一条带切成几块（凹口处），逐块铺，名字用后缀区分。
  const lay = (parts: Pt[][], base: string, mat: MatKey, y: number) => {
    parts.forEach((r, i) => addSurface(c, i === 0 ? base : `${base}_${i}`, r, mat, y, false));
  };
  lay(verge, 'loop_verge', 'grass', 0.010);
  // 人行道压在沥青之下：环路拐角处两条带会轻微重叠，画在上面会撕出浅色楔子
  lay(walk, 'loop_walk', 'concrete', 0.0115);
  lay(road, 'loop_road', 'asphalt', 0.0125);

  // ---- 出入口：环路自己是个闭合圈，必须有一处接到城市路上
  //
  // 取最长的那条界边（等级最高、最可能是主路）的中点，从红线往内铺一条
  // 横穿绿带的引道，同时登记到 model.driveways —— 道路层铺人行道 / 绿化带时
  // 会在那里断开，接出去才是同一条路面，而不是两块叠在一起的模型。
  let bi = 0;
  let bl = 0;
  for (let i = 0; i < ring.length; i++) {
    const L = Pt.distance(ring[i], ring[(i + 1) % ring.length]);
    if (L > bl) {
      bl = L;
      bi = i;
    }
  }
  const ea = ring[bi];
  const eb = ring[(bi + 1) % ring.length];
  const mid = new Pt((ea.x + eb.x) / 2, (ea.y + eb.y) / 2);
  const along = unitOf(new Pt(eb.x - ea.x, eb.y - ea.y));
  let outN = leftOf(along);
  const ctr = ringCenter(ring);
  // 左法线指向内侧还是外侧，由质心判定（不依赖绕向）
  if ((ctr.x - mid.x) * outN.x + (ctr.y - mid.y) * outN.y > 0) outN = new Pt(-outN.x, -outN.y);

  const ap = stripe(mid, new Pt(mid.x - outN.x * (usedVg + w), mid.y - outN.y * (usedVg + w)), w * 0.96);
  if (ap) addSurface(c, 'loop_mouth', ap, 'asphalt', 0.0132, false);
  const halfW = w * 0.5 + u(0.55);
  const nx = -outN.y;
  const ny = outN.x;
  const inb = u(0.9);
  const outb = u(3.6);
  c.model.driveways.push([
    new Pt(mid.x + outN.x * inb + nx * halfW, mid.y + outN.y * inb + ny * halfW),
    new Pt(mid.x - outN.x * outb + nx * halfW, mid.y - outN.y * outb + ny * halfW),
    new Pt(mid.x - outN.x * outb - nx * halfW, mid.y - outN.y * outb - ny * halfW),
    new Pt(mid.x + outN.x * inb - nx * halfW, mid.y + outN.y * inb - ny * halfW),
  ]);

  pushZoneDbg({
    key: 'loop',
    blockA: +aOut.toFixed(1),
    innerA: +aIn.toFixed(1),
    spanM: +(span * 7).toFixed(1),
    wM: P.loopW,
    vgM: +(usedVg * 7).toFixed(1),
  });

  // 下游全部在核心区里排楼
  c.block = new Polygon(core);
  c.f = frameOf(c.block);
  c.bb = bboxOf(core, c.f);
}

// ---------------------------------------------------------------- 入口

/** 街区内部路：把整块街区切开、落一层车行道，再让每块各自走用途规划 */
function planBlockRoad(c: Ctx): boolean {
  const ring = Array.from(c.block);
  const A = Math.abs(area(ring));
  // 太小的街区不切：一条 7 m 宽的路在 30 m 见方的街区里占掉四分之一，
  // 切完两个子块各剩十几米，一栋楼都排不下 —— 这档街区保持原来的整块规划。
  // 门槛 55 u²（≈52 m 见方）是按"切完还能放下两栋楼"反推的。
  if (A < 55) return false;

  // 预算放宽到 22%：这条街区的内部路是**唯一**能开进去的路（不像 parcelize
  // 那样还有一地地块间的巷道），按 10% 算，一条 40 m 长的穿心路就是 14%，
  // 直接超预算被拒 —— 表现出来就是"这个街区明明有 4 栋楼，却一条路都没有"。
  const spine = internalSpine(c, ring, A, { alignToCity: true, budgetK: 0.22 });
  if (!spine || spine.lines.length === 0) return false;

  // 先算切分再落面：切不开（路贴着街区边、或街区太扁）就整块交回用途层，
  // 不要留下一条"铺了路却没人用"的沥青带。
  const quads = subBlocks(c, spine);
  if (typeof process !== 'undefined' && process.env.PARCEL_DEBUG) {
    console.log(`[blockroad] A=${A.toFixed(0)} lines=${spine.lines.length} quads=${quads.length} use=${c.use}`);
  }
  if (quads.length < 2) return false;

  // 路面先落：子块是按"中线切"扣掉路带宽度的，基底与建筑随后都排在这层之上
  drawInternalRoad(c, spine, undefined);
  spineFurniture(c, spine, []);

  // 路面登记成禁建带（比实际路面放宽 10%）：楼允许贴着路边站，但不许压上去。
  c.noBuild = spine.lines
    .map((l) => bandPolygon(l, spine.w * 1.1))
    .filter((p): p is Pt[] => !!p && p.length >= 3);

  for (const q of quads) {
    const sub = subCtx(c, q);
    if (!sub) continue;
    planUse(sub);
    // 子块里排完楼，把楼与楼之间的空当补一层（否则露出底图）
    groundLayers(sub);
    // 注意：**不要**在这里调 `orphanGround`。它算的是 `patch.shape - c.block`，
    // 而子块的 `c.block` 只是街区的一角 —— 每个子块都会把"整个街区减去自己"
    // 当成孤儿地带铺一遍草，实测草地面积直接冲到街区面积的 139%
    // （铺装层大面积重叠）。父级在 `buildLot` 里已经统一调过一次了。
  }
  return true;
}

/** 按用途分派。街区级与"街区切开后的小块"共用同一套内容层 */
function planUse(ctx: Ctx): void {
  switch (ctx.use) {
    case 'cbd':
      planCbd(ctx);
      break;
    case 'commercial':
      planCommercial(ctx);
      break;
    case 'residential':
      planResidential(ctx);
      break;
    case 'industrial':
      planIndustrial(ctx);
      break;
    case 'civic':
      planCivic(ctx);
      break;
    case 'park':
      planPark(ctx);
      break;
    case 'parking':
      planParkingUse(ctx);
      break;
    case 'reserved':
      planReserved(ctx);
      break;
    default:
      planGreen(ctx);
      break;
  }
}

/**
 * 街区（`buildLot`）：把一块 patch 变成一整套地面 / 建筑 / 道具。
 */
export function buildLot(model: Model, patch: Patch, use: LandUse, radius: number): LotResult {
  const res: LotResult = {
    patch,
    use,
    radius,
    block: null,
    surfaces: [],
    solids: [],
    props: [],
    paths: [],
    bays: 0,
    trees: 0,
    buildings: 0,
  };

  const insetDist: number[] = [];
  patch.shape.forEdge((v0, v1) => insetDist.push(model.insetForEdge(patch, v0, v1)));
  let block = patch.shape.isConvex() ? patch.shape.shrink(insetDist) : patch.shape.buffer(insetDist);

  // 自愈：凹地块的 buffer 会返回自交多边形。原版只把它当"可建区域"继续切分，
  // 从没直接三角化过；我们把它当地坪铺，自交就会在 earcut 里变成横跨地块的碎片。
  // 做一次自身求交，让 polygon-clipping 重新规范化。
  const healed = intersect(Array.from(block), Array.from(block), 0);
  if (healed.length > 0) {
    const best = healed.reduce((a, b) => (area(a) > area(b) ? a : b));
    if (best.length >= 3) block = new Polygon(best);
  }

  if (block.length < 3 || area(Array.from(block)) < 0.12) return res;
  res.block = block;

  const f = frameOf(block);
  const ctx: Ctx = {
    model,
    patch,
    use,
    block,
    f,
    bb: bboxOf(Array.from(block), f),
    res,
    footprints: [],
    parkingLevel: model.parkingLevel,
    parkUsed: 0,
    baseMat: 'concrete',
    green: [],
  };

  // 中心广场不走用途分配
  if (patch === model.plaza) {
    planCityPlaza(ctx);
    return res;
  }

  // 大块地先铺一圈内部环路，再把可建范围收到环路内侧
  // —— 让服务街区的路退出城市路网，而不是靠"再切一条城市路"去解决可达性。
  applyServiceLoop(ctx);

  // 街区 → 小地块。这条路走通了就不再进用途层：
  // 地块级规划（planParcel）已经产出"一栋楼 + 院子"，用途层那套
  // "一个街区摆一片楼群"的构图会把地块边界吃掉。
  const BP = ctx.model.params.block;
  if (BP.parcelize && PARCEL_USES.has(use)) {
    // 商业 / 商务 / 市政要跑"塔楼 + 裙房 + 内院"三段式，地块得比住宅大一圈 ——
    // 46 m 的地块减掉退线与裙房进深，内院只剩 11 m，塔楼根本放不下。
    const PITCH_K: Partial<Record<LandUse, number>> = { cbd: 1.5, commercial: 1.45, civic: 1.4 };
    const pitch = u(BP.parcelPitchM * (PITCH_K[use] ?? 1));
    // 单块地块可以被单独调"切成几块"：面板给的是目标面积，这里直接用它，
    // 没给就跟全局「小地块边长」走。下限 2 u²（≈100 m²）挡住切成碎渣。
    const ov = ctx.patch.override?.parcelTargetA;
    const targetA = ov && ov > 2 ? ov : pitch * pitch;
    if (planParcels(ctx, targetA, ov && ov > 2 ? 3 : 2)) {
      groundLayers(ctx);
      orphanGround(ctx);
      return res;
    }
    if (typeof process !== 'undefined' && process.env.PARCEL_DEBUG) {
      console.log(`[parcel] 退回旧管线 use=${use} A=${Math.abs(area(Array.from(ctx.block))).toFixed(1)} 阈值=${(targetA * 1.5).toFixed(1)}`);
    }
  }

  // 不开「街区切成小地块」时，街区里同样可能有几栋楼（塔楼 + 裙房 + 副楼，
  // 甚至 planCbd 的"多栋平行板楼"），但原来这里一条内部路都没有 ——
  // 几栋楼之间只有铺装缝，车开不进去，读起来是"一整块屋顶上摆了几块白板"
  // （用户核对意见，图 5/6）。
  //
  // 现在补一条真正的内部路，把街区切成 2~3 块，每块各自走用途规划：
  // 建筑尺度不变（不按 46 m 的小地块切碎，那是 parcelize 的事），
  // 但"一个街区几栋楼"终于被一条路串起来了。
  if (!BP.parcelize && PARCEL_USES.has(use) && planBlockRoad(ctx)) {
    groundLayers(ctx);
    orphanGround(ctx);
    return res;
  }

  planUse(ctx);
  // 中间层铺装：建筑外沿 / 路缘过渡带 / 后场服务院。
  // 放在各用途规划之后、兜底之前 —— 它只往"还空着"的基底上垫，不抢功能面。
  groundLayers(ctx);
  orphanGround(ctx);

  // 兜底：地块内缩 + 各处裁剪之后什么都没剩下（张量场切块会出现锐角很大的四边形，
  // 内缩后整块被吃掉）。至少把地坪铺上，否则俯视图上这里就是一个洞。
  if (res.surfaces.length === 0 && res.solids.length === 0) {    const mat: MatKey = use === 'park' || use === 'green' ? 'grass' : 'concrete';
    const fallback =
      ctx.bb.w > 0 && ctx.bb.h > 0 ? rect(ctx.f, ctx.bb.u0, ctx.bb.u1, ctx.bb.v0, ctx.bb.v1) : Array.from(block);
    addSurface(ctx, 'fallback_ground', fallback, mat, 0);
  }

  return res;
}

/**
 * 城市中心广场：整块硬质铺装 + 中央水景 + 环形树列 + 座椅。
 * 这个地块由 Model.plaza 指定，不走用途分配，否则中心会长出一栋办公楼。
 */
function planCityPlaza(c: Ctx) {
  baseSurface(c, 'stonePave');
  const { bb, f } = c;
  const center = ringCenter(Array.from(c.block));

  const r = Math.max(0.6, Math.min(bb.w, bb.h) * 0.26);
  const disc: Pt[] = [];
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2;
    disc.push(new Pt(center.x + Math.cos(a) * r, center.y + Math.sin(a) * r));
  }
  addSurface(c, 'plaza_disc', disc, 'paver', 0.014);

  // 广场分格：四条径向缝，视觉上把大块铺装切开
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const hw = 0.035;
    const len = Math.min(bb.w, bb.h) * 0.46;
    const seam = [
      new Pt(center.x - dx * len - dy * hw, center.y - dy * len + dx * hw),
      new Pt(center.x + dx * len - dy * hw, center.y + dy * len + dx * hw),
      new Pt(center.x + dx * len + dy * hw, center.y + dy * len - dx * hw),
      new Pt(center.x - dx * len + dy * hw, center.y - dy * len - dx * hw),
    ];
    addSurface(c, `plaza_seam_${k}`, seam, 'concrete', 0.013);
  }

  addProp(c, 'fountain', center, 1.15, 0, 'furniture');

  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.2;
    const rr = Math.min(bb.w, bb.h) * 0.4;
    const p = new Pt(center.x + Math.cos(a) * rr, center.y + Math.sin(a) * rr);
    if (pointInPolygon(p, Array.from(c.block))) addProp(c, 'tree', p, 1.0, a, 'vegetation');
  }
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.55;
    const p = new Pt(center.x + Math.cos(a) * (r + 0.5), center.y + Math.sin(a) * (r + 0.5));
    if (pointInPolygon(p, Array.from(c.block))) addProp(c, 'bench', p, 1, a + Math.PI / 2, 'furniture');
  }
  const bin = sampleIn(c, [], 0.3);
  if (bin) addProp(c, 'bin', bin, 1, 0, 'furniture');
}

/** 现代地块：Ward 的接口保持不变（geometry = 建筑轮廓），附带完整内容数据 */
export class ModernWard extends Ward {
  readonly use: LandUse;
  readonly radius: number;
  lot: LotResult | null = null;

  constructor(model: Model, patch: Patch, use: LandUse, radius: number) {
    super(model, patch);
    this.use = use;
    this.radius = radius;
  }

  override createGeometry(): void {
    this.lot = buildLot(this.model, this.patch, this.use, this.radius);
    this.geometry = this.lot.solids.map((s) => new Polygon(s.ring));
    // 单块地块的高度倍率在**这一层**乘：三维预览和 GLB 都读同一个 lot，
    // 放在渲染端会漏掉导出，放在这里两边一起变。
    const k = this.patch.override?.heightK;
    if (k && Math.abs(k - 1) > 1e-3) {
      for (const s of this.lot.solids) s.h *= k;
    }
  }

  getLabel(): string | null {
    return USE_LABEL[this.use] ?? null;
  }
}
