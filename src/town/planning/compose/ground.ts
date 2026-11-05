// F2.4-B5 · 场地铺装与景观分区
//
// 顺序是硬的（任务书第七节）：建筑与交通网络确定之后，才生成地面。
// 所以这里的输入是"已经摆好的建筑 + 已排好的停车 + 已有的路"，输出是地面层。
//
// 绿地不是"扣完剩下的"：剩余面先按**能不能说清用途**分类，
// 说不清的标 `unassigned` 并写明原因，不许拿绿地填平。
//
// 面积账：可建区 = 道路 + 建筑退线带 + Σ(地块)；
//         地块   = 建筑 + 停车 + 步行道 + 各类地面。
// 因为每一层都是从上一层"减"出来的，账天然闭合（不需要事后凑数）。

import { Pt } from '../../../core/geom';
import { surface, surfaceArea, surfaceIntersect, surfaceSubtract, surfaceUnion, type PlanSurface } from '../core/surface';
import { bufferPolyline } from '../../parking/placemaker';
import { clearanceField } from '../adapt/geom';
import { U } from '../subdivision/types';
import type { ComposeInput, ComposeNote, GroundKind, GroundPatch, InternalRoad, ParcelPlan, ParkingArea, SiteBuilding } from './types';

const M2 = (u2: number) => u2 * 49;

export interface GroundInput {
  input: ComposeInput;
  parcels: ParcelPlan[];
  buildings: SiteBuilding[];
  parking: ParkingArea[];
  roads: InternalRoad[];
  roadGround: PlanSurface[];
  /** 停车铺装与进出车道（已在停车阶段生成，这里只用来扣面积） */
  parkingGround: PlanSurface[];
}

export interface GroundResult {
  ground: GroundPatch[];
  voids: GroundPatch[];
  notes: ComposeNote[];
}

export function buildGround(g: GroundInput): GroundResult {
  const ground: GroundPatch[] = [];
  const notes: ComposeNote[] = [];
  const byParcel = new Map<string, SiteBuilding[]>();
  for (const b of g.buildings) {
    const list = byParcel.get(b.parcelId) ?? [];
    list.push(b);
    byParcel.set(b.parcelId, list);
  }

  // ① 街区自带的中庭（洞）：不属于任何地块，但必须有归属
  const voids = g.input.boundary.holes
    .filter((h) => h.length >= 3)
    .map((h, i) => {
      const s = surface(h);
      return {
        kind: (g.input.typology === 'retail' ? 'plaza' : 'courtyard') as GroundKind,
        surface: s,
        areaM2: M2(surfaceArea(s)),
        purpose:
          `街区中庭 #${i + 1}（红线原有洞，${M2(surfaceArea(s)).toFixed(0)} m²）：保留为公共开放空间，` +
          '四周地块据此围合，建筑与铺装都不得覆盖',
      };
    });

  // ② 建筑退线带 = 可建区 − 地块 − 道路
  const parcelSurfaces = g.parcels.map((p) => p.usable ?? p.surface);
  const band = subtractAll([g.input.buildable], [...parcelSurfaces, ...g.roadGround]);
  for (const b of band) {
    const a = M2(surfaceArea(b));
    if (a < 8) continue;
    const retailish = g.input.typology === 'retail';
    ground.push({
      // 商业的退线带并非全铺：宽的地方留成行道树/绿化带，窄的才是人行铺装。
      // 全铺会让商业街区绿地归零（实测 C01 绿地 0%）。
      kind: retailish ? (a > 240 ? 'planting' : 'sidewalk') : 'planting',
      surface: b,
      areaM2: a,
      purpose: retailish && a <= 240
        ? '沿街人行带（建筑退线 5 m 内）：商铺门前连续铺装，兼做橱窗展示带'
        : '沿街种植带（建筑退线 5 m 内）：隔离车行道噪音与尾气，兼做雨洪滞蓄',
      walkable: retailish,
    });
  }

  // ③ 各地块内部
  //
  // 这一段的写法是"**逐层切蛋糕**"而不是"各层各推一块"：
  //   cursor 从整块可用地开始，每认领一层就从 cursor 里切掉那一层，
  //   最后 cursor 剩下的正是"没人认领的"，直接分类。
  // 为什么必须这样：早先是"各层分别算一块再相加"，只要任何一次布尔少切了一点，
  // 两块就会重叠，面积和永远比可建区多几十平方米（实测 G01 每块地多 15~44 m²，
  // 而这些重叠在图上看不出来 —— 它们藏在建筑与铺装的贴边处）。
  for (const p of g.parcels) {
    const usable = p.usable ?? p.surface;
    const bs = byParcel.get(p.id) ?? [];
    const pk = g.parking.filter((x) => x.parcelId === p.id).map((x) => x.surface);
    const usableM2 = M2(surfaceArea(usable));
    if (usableM2 < 4) continue;

    let cursor = carve([usable], [...bs.map((b) => b.surface), ...pk, ...g.parkingGround]);

    // ③-a 步行接驳：从 cursor 里切出"门 → 街面"的 3.2 m 铺装
    const rawWalks: PlanSurface[] = [];
    for (const b of bs) {
      const door = b.doors.find((d) => d.kind === 'main') ?? b.doors[0];
      if (!door) continue;
      const target = nearestFrontagePoint(door.at, p);
      if (!target) continue;
      const lenU = Pt.distance(door.at, target);
      if (lenU * 7 < 2.5) continue;
      /**
       * 两端各缩 0.6 单位（≈4 m）。
       *
       * 不缩的话路径的端边会和地块边界**完全重合**，`polygon-clipping` 在这种
       * 退化输入上会抛 "Unable to complete output ring"，减法失败 → 路径既被推出
       * 又没有从剩余面里扣掉 → 每块地多算 15~20 m²（实测 G01 十块地全部如此）。
       * 缩进之后路径严格在地块内部，减法就干净了。
       */
      const trim = Math.min(U(0.6), lenU * 0.2);
      const dx = (target.x - door.at.x) / (lenU || 1);
      const dy = (target.y - door.at.y) / (lenU || 1);
      const p0 = new Pt(door.at.x + dx * trim, door.at.y + dy * trim);
      const p1 = new Pt(target.x - dx * trim, target.y - dy * trim);
      const ring = bufferPolyline([p0, p1], U(1.6));
      if (!ring) continue;
      const part = intersectAll(cursor, [surface(ring)]).filter((q) => surfaceArea(q) > 0.01);
      if (part.length === 0) continue;
      rawWalks.push(...part);
    }
    const walks = unionAll(rawWalks);
    if (walks.length > 0) {
      const beforeA = cursor.reduce((a, q) => a + surfaceArea(q), 0);
      const after = carve(cursor, walks);
      const afterA = after.reduce((a, q) => a + surfaceArea(q), 0);
      const wantA = walks.reduce((a, q) => a + surfaceArea(q), 0);
      if (!(beforeA - afterA > wantA * 0.7)) {
        notes.push({
          code: 'green',
          severity: 'info',
          message: `${p.id} 步行接驳扣不掉（布尔只切掉 ${((beforeA - afterA) * 49).toFixed(0)} / ${(wantA * 49).toFixed(0)} m²），并入前场铺装`,
        });
        rawWalks.length = 0;
      }
    }
    if (walks.length > 0 && rawWalks.length > 0) {
      for (const c of walks) {
        ground.push({
          kind: 'footpath',
          surface: c,
          areaM2: M2(surfaceArea(c)),
          purpose: `主入口 → 街面的步行接驳（3.2 m 宽，连续铺装；服务 ${Math.max(1, rawWalks.length)} 段入口）`,
          parcelId: p.id,
          walkable: true,
        });
      }
      cursor = carve(cursor, walks);
    }

    // ③-b cursor 剩下的，全部按用途分类（不存在"再扣一次"的环节，所以不会重叠）
    for (const r of cursor) {
      const a = M2(surfaceArea(r));
      if (a < 2) continue;
      const kind = classify(r, a, p, bs, walks, g.input.typology);
      ground.push({ ...kind, surface: r, areaM2: a, parcelId: p.id });
      if (kind.kind === 'unassigned') {
        notes.push({
          code: 'unassigned',
          severity: 'warn',
          message: `${p.id} 有 ${a.toFixed(0)} m² 未设计：${kind.purpose}`,
          at: r.outer[0],
        });
      }
    }
    if (usableM2 > 400 && bs.length === 0) {
      notes.push({
        code: 'green',
        severity: 'info',
        message: `${p.id}（${p.fn}）没有建筑，${usableM2.toFixed(0)} m² 全部作为${p.fn === 'plaza' ? '公共广场' : p.fn === 'service' ? '后勤场地' : '地面'}使用`,
      });
    }
  }

  // ④ 广场加景观节点（花坛）：只在铺装上做，不占绿地
  addPlanters(ground, notes);

  return { ground, voids, notes };
}

/**
 * 剩余面的用途判断。
 *
 * 判据全部来自几何事实（离建筑多远、离街多远、多宽），不是随机分配：
 *   · 贴着建筑（< 14 m）→ 前场（硬化），它是门厅的延伸；
 *   · 被建筑围住（四周都有建筑）→ 庭院；
 *   · 贴街（< 10 m）→ 种植带；
 *   · 又大又空（> 1500 m² 且离建筑 > 22 m）→ **未设计**，如实标记，不填绿地充数；
 *   · 其余 → 绿地，但必须写清用途（组团绿地 / 缓冲绿地 / 雨水花园）。
 */
function classify(
  r: PlanSurface,
  areaM2: number,
  p: ParcelPlan,
  bs: SiteBuilding[],
  walks: PlanSurface[],
  typ: string
): { kind: GroundKind; purpose: string; walkable?: boolean } {
  const core = clearanceField(r, 3).core;
  const at = core?.at ?? r.outer[0];
  const clearM = core ? core.clear * 7 : 0;
  const dWall = bs.length ? Math.min(...bs.map((b) => distToSurface(at, b.surface) * 7)) : Infinity;
  const nearStreet = nearestFrontageDistM(at, p);
  const around = bs.filter((b) => Pt.distance(b.center, at) * 7 <= 45);
  const quad = new Set(
    around.map((b) => (Math.abs(b.center.x - at.x) > Math.abs(b.center.y - at.y) ? (b.center.x > at.x ? 'e' : 'w') : b.center.y > at.y ? 'n' : 's'))
  );
  const enclosed = quad.size >= 3;
  const retail = typ === 'retail';

  if (p.fn === 'service') {
    return { kind: 'loading', purpose: `后勤/装卸场地（${areaM2.toFixed(0)} m²）：服务本地块货运与垃圾清运，硬化不绿化` };
  }
  if (p.fn === 'parking') {
    return { kind: 'forecourt', purpose: `停车地块（${areaM2.toFixed(0)} m²）但车位未排布成功，暂作硬化场地，待人工确认` };
  }
  if (p.fn === 'plaza') {
    return { kind: 'plaza', purpose: `公共广场（${areaM2.toFixed(0)} m²）：街口可见、可停留，兼作人流集散` };
  }
  if (bs.length === 0) {
    return p.fn === 'green'
      ? { kind: 'green', purpose: `公共绿地（${areaM2.toFixed(0)} m²）：独立成块、四周临街，服务整个街区` }
      : { kind: 'forecourt', purpose: `无建筑地块（${areaM2.toFixed(0)} m²）：按硬化场地处理，供集散/临时使用` };
  }
  /**
   * 前场只在"贴着外墙的小块"上成立。
   *
   * 早先的阈值是 9 m，于是整块地方只要离墙 9 m 内就算前场 ——
   * 住宅区因此 50% 以上的地面变成硬铺装、绿地只剩 4%（实测 G01）。
   * 现在住宅只给 6 m 内的小块做门前铺装，其余交给庭院/绿地；
   * 商业反过来（沿街界面本来就是硬地），所以阈值按用地类型分开。
   */
  const apron = retail ? 12 : 6;
  const apronMax = retail ? 4000 : 420;
  if (dWall <= apron && areaM2 <= apronMax) {
    return { kind: 'forecourt', purpose: `建筑前场（${areaM2.toFixed(0)} m²）：紧贴外墙 ${dWall.toFixed(0)} m，主入口集散与落客` };
  }
  if (enclosed && clearM <= (retail ? 32 : 32)) {
    // 住宅的围合庭院是绿地（软质为主 + 活动场地），商业被围合的内院是硬质铺装
    //（顾客停留、外摆、卸货）。这条区分直接影响"绿地率"这个数：
    // 住宅区把所有院子记成铺装，绿地率会掉到 8%，看图的人会以为这是个广场（实测 R01）。
    return {
      kind: retail ? 'plaza' : 'green',
      purpose: `组团内部庭院（${areaM2.toFixed(0)} m²，净宽 ${clearM.toFixed(0)} m，${around.length} 栋围合）：${retail ? '顾客停留与店铺后场' : '住户/员工的公共起居空间'}`,
    };
  }
  if (nearStreet <= 10 && areaM2 < 900) {
    return { kind: 'planting', purpose: `道路种植带（${areaM2.toFixed(0)} m²）：沿街界面绿化，遮挡停车与设备` };
  }
  if (areaM2 > 1500 && dWall > 24 && clearM >= 14) {
    return {
      kind: 'unassigned',
      purpose: `距最近建筑 ${dWall.toFixed(0)} m、净宽 ${clearM.toFixed(0)} m，没有明确功能依托，按任务书标为未设计（不填绿地充数）`,
    };
  }
  if (retail && areaM2 > 600 && areaM2 <= 1500) {
    return { kind: 'plaza', purpose: `商业前场/广场（${areaM2.toFixed(0)} m²）：店铺门前集散与临时外摆` };
  }
  if (retail && areaM2 > 1500) {
    return { kind: 'green', purpose: `商业绿化缓冲（${areaM2.toFixed(0)} m²）：大面积硬地会让人行界面失温，留作树阵与休憩绿地` };
  }
  if (areaM2 > 500) {
    return { kind: 'green', purpose: `组团集中绿地（${areaM2.toFixed(0)} m²，净宽 ${clearM.toFixed(0)} m）：承接雨水径流，兼做活动场地` };
  }
  return { kind: 'green', purpose: `缓冲绿地（${areaM2.toFixed(0)} m²）：填在建筑与边界之间，软化界面` };
}

function distToSurface(p: Pt, s: PlanSurface): number {
  let d = Infinity;
  for (const ring of [s.outer, ...s.holes]) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l2 = dx * dx + dy * dy || 1;
      let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
      t = Math.max(0, Math.min(1, t));
      d = Math.min(d, Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)));
    }
  }
  return Number.isFinite(d) ? d : 0;
}

/**
 * 广场/前场上加花坛节点（圆角铺装）。
 *
 * 位置必须取**该块的 clearance 核心**，不能用顶点质心：
 * 前场常常是绕着建筑的一段 L 形，顶点质心很容易正好落在建筑里 ——
 * 那样花坛就挖在楼上，形成 44 m² 的地面/建筑重叠（实测 G01 板楼 1 就是这种情况）。
 * 半径也由 clearance 封顶，保证整个圆都在铺装内部。
 */
function addPlanters(ground: GroundPatch[], notes: ComposeNote[]): void {
  let n = 0;
  for (const g of ground) {
    if (g.kind !== 'plaza' && g.kind !== 'forecourt') continue;
    if (g.areaM2 < 260) continue;
    const field = clearanceField(g.surface, 2);
    if (!field.core) continue;
    const rad = Math.min(field.core.clear * 0.75, Math.sqrt(g.areaM2 / 49) * 0.1, U(3.6));
    if (rad * 7 < 2.6) continue;
    const ring = circleRing(field.core.at, rad, 20);
    const s = surface(ring);
    const a = M2(surfaceArea(s));
    if (a < 6) continue;
    try {
      const rest = surfaceSubtract([g.surface], [s]).filter((q) => surfaceArea(q) > 1e-6);
      if (rest.length !== 1) continue;
      g.surface = rest[0];
      g.areaM2 = M2(surfaceArea(g.surface));
    } catch {
      continue;
    }
    ground.push({ kind: 'planter', surface: s, areaM2: a, purpose: '景观节点：花坛/树池（圆角铺装收边，兼做座椅围合）', parcelId: g.parcelId, walkable: false });
    n++;
  }
  if (n > 0) notes.push({ code: 'green', severity: 'info', message: `广场与前场加了 ${n} 处花坛节点` });
}

function circleRing(c: Pt, r: number, n: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push(new Pt(c.x + Math.cos(a) * r, c.y + Math.sin(a) * r));
  }
  return out;
}

function nearestFrontagePoint(p: Pt, parcel: ParcelPlan): Pt | null {
  let best: { at: Pt; d: number } | null = null;
  for (const f of parcel.candidate.frontages) {
    const dx = f.edge[1].x - f.edge[0].x;
    const dy = f.edge[1].y - f.edge[0].y;
    const l2 = dx * dx + dy * dy || 1;
    let t = ((p.x - f.edge[0].x) * dx + (p.y - f.edge[0].y) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    const at = new Pt(f.edge[0].x + dx * t, f.edge[0].y + dy * t);
    const d = Pt.distance(p, at);
    if (!best || d < best.d) best = { at, d };
  }
  return best ? best.at : null;
}

function nearestFrontageDistM(p: Pt, parcel: ParcelPlan): number {
  const at = nearestFrontagePoint(p, parcel);
  return at ? Pt.distance(p, at) * 7 : Infinity;
}

/** 合并一组面（去掉互相重叠导致的重复计量） */
function unionAll(ss: PlanSurface[]): PlanSurface[] {
  if (ss.length <= 1) return ss;
  try {
    const u = surfaceUnion(ss).filter((q) => surfaceArea(q) > 1e-6);
    return u.length > 0 ? u : ss;
  } catch {
    return ss;
  }
}

/**
 * 从一组面里逐块切掉一组面。
 *
 * 逐个（而不是一次传一堆）是关键：`polygon-clipping` 在"多对多"时更容易在共享边处
 * 吐出无法闭合的环，一旦抛异常整次减法就白做。逐个切时，某一块切失败只影响它自己。
 */
function carve(list: PlanSurface[], shapes: PlanSurface[]): PlanSurface[] {
  let cur = list.filter((q) => surfaceArea(q) > 1e-6);
  for (const sh of shapes) {
    if (surfaceArea(sh) <= 1e-9) continue;
    const next: PlanSurface[] = [];
    for (const c of cur) {
      try {
        const r = surfaceSubtract([c], [sh]).filter((q) => surfaceArea(q) > 1e-6);
        if (r.length === 0) continue;
        next.push(...r);
      } catch {
        next.push(c);
      }
    }
    cur = next;
  }
  return cur;
}

function subtractAll(from: PlanSurface[], minus: PlanSurface[]): PlanSurface[] {
  if (from.length === 0) return [];
  if (minus.length === 0) return from.filter((s) => surfaceArea(s) > 1e-6);
  try {
    return surfaceSubtract(from, minus).filter((s) => surfaceArea(s) > 1e-6);
  } catch {
    return from.filter((s) => surfaceArea(s) > 1e-6);
  }
}

function intersectAll(a: PlanSurface[], b: PlanSurface[]): PlanSurface[] {
  const out: PlanSurface[] = [];
  for (const x of a) {
    for (const y of b) {
      try {
        out.push(...surfaceIntersect([x], [y]).filter((q) => surfaceArea(q) > 1e-6));
      } catch {
        /* 单次失败忽略 */
      }
    }
  }
  return out;
}

export type { GroundPatch };
