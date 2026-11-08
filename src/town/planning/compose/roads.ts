// F2.4-B1 · 道路与地块共同确定空间骨架
//
// 任务书要求（第三节）：
//   · 先提出"道路骨架 + 子地块划分"的组合候选，而不是先切地再补路；
//   · 道路占地必须从建筑可用域中扣除；
//   · 不能在建筑全部生成之后用 A* 强行穿插；
//   · 保留大型 Compound，不强制每块子地都独立开路。
//
// 所以这里的顺序是反的：
//   ① 从真实街口与"深内区"提出骨架候选（0 条 / 单脊 / 脊 + 支）；
//   ② 骨架 → 真实路面 → 从可建域扣掉；
//   ③ 在**扣完路的可建域**上跑 F2.1 分割（内部道路同时作为合成道路边参与临街判定）；
//   ④ 每个组合按同一把尺子打分，择优。
//
// 第 ③ 步是关键：分割看到的路是**已经存在**的路面，而不是事后补的通道。

import { Pt } from '../../../core/geom';
import {
  insideSurface,
  surface,
  surfaceArea,
  surfaceIntersect,
  surfaceSubtract,
  surfaceUnion,
  type PlanSurface,
} from '../core/surface';
import type { SiteRoadEdge } from '../core/types';
import { U } from '../subdivision/types';
import { obbOf } from '../subdivision/geom';
import { clearanceField, toM } from '../adapt/geom';
import { bufferPolyline } from '../../../core/polyline';
import type { ComposeInput, InternalRoad, RoadClass, SiteGate } from './types';

/**
 * 内部道路断面（米）。
 *
 * 宽度是**通行需求的直接表达**，不是审美选择：
 *   · primary 7.0 m 车行道 —— 双向各一条 3.5 m 车道，消防车 4 m 净宽的两倍余量；
 *   · secondary 5.5 m —— 单车道双向交替，住宅组团内部路的标准做法；
 *   · service 6.5 m —— 货车（2.5 m 宽）双向会车 + 0.75 m 余量；
 *   · pedestrian 4.0 m —— 步行主轴，兼做消防通道（4 m 是消防车最小净宽）。
 */
const SECTION: Record<RoadClass, { carriage: number; sidewalk: number }> = {
  primary: { carriage: 7.0, sidewalk: 1.6 },
  secondary: { carriage: 5.5, sidewalk: 1.2 },
  service: { carriage: 6.5, sidewalk: 0.9 },
  // 步行主轴 6 m：4 m 只是宅间路，撑不起"园区主脉络"的视觉分量
  pedestrian: { carriage: 6.0, sidewalk: 0 },
};

/** 临街带深度（米）：一块地"靠街就能用好"的最大进深。超过它，后侧必须另找接入 */
const FRONT_DEPTH_M: Record<string, number> = {
  multi_family: 34,
  single_family: 30,
  retail: 32,
  office: 34,
  industrial: 40,
  data_center: 45,
  mixed: 32,
  generic: 34,
};

export interface SkeletonSpine {
  cls: RoadClass;
  /** 中心线（世界坐标） */
  pts: Pt[];
  /** 服务说明（进 InternalRoad.reason） */
  why: string;
}

export interface SkeletonCandidate {
  id: string;
  label: string;
  spines: SkeletonSpine[];
  /** 这条骨架的意图（报告用） */
  intent: string;
}

// ---------------------------------------------------------------- 几何小工具

function bbox(ss: PlanSurface[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of ss) {
    for (const p of s.outer) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  return { minX, minY, maxX, maxY };
}

function insideAny(ss: PlanSurface[], p: Pt): boolean {
  for (const s of ss) if (insideSurface(p, s)) return true;
  return false;
}

/** 把一条无限长的"线"裁成在区域内的若干段（按采样 + 二分细化） */
function chordThrough(region: PlanSurface[], c: Pt, ang: number, spanU: number): { a: Pt; b: Pt; len: number }[] {
  const ux = Math.cos(ang);
  const uy = Math.sin(ang);
  const step = 0.4;
  const out: { a: Pt; b: Pt; len: number }[] = [];
  let runStart: number | null = null;
  const at = (t: number) => new Pt(c.x + ux * t, c.y + uy * t);
  for (let t = -spanU / 2; t <= spanU / 2 + 1e-9; t += step) {
    const ok = insideAny(region, at(t));
    if (ok && runStart === null) runStart = t;
    if (!ok && runStart !== null) {
      out.push({ a: at(runStart), b: at(t - step), len: t - step - runStart });
      runStart = null;
    }
  }
  if (runStart !== null) out.push({ a: at(runStart), b: at(spanU / 2), len: spanU / 2 - runStart });
  return out.filter((s) => s.len > 0.5).sort((x, y) => y.len - x.len);
}

/**
 * 区域内 clearance 最大的点（"深内区的脊"）。
 *
 * 用 clearance field 而不是形心：深内区常常是 L 形或带缺口，
 * 形心会落在区域外，脊点一定在区域内且离边界最远 —— 路铺在这里才不压边角。
 */
function ridgeOf(region: PlanSurface[]): { at: Pt; clear: number } | null {
  let best: { at: Pt; clear: number } | null = null;
  for (const r of region) {
    const f = clearanceField(r, 3);
    if (!f.core) continue;
    if (!best || f.core.clear > best.clear) best = { at: f.core.at, clear: f.core.clear };
  }
  return best;
}

/** 区域内离某点最近的点（用环上采样近似，够用且确定） */
function nearestOnRegion(region: PlanSurface[], p: Pt): Pt {
  let best = p;
  let bestD = Infinity;
  for (const r of region) {
    const rings = [r.outer, ...r.holes];
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        for (let k = 0; k <= 8; k++) {
          const t = k / 8;
          const q = new Pt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
          const d = Pt.distance(q, p);
          if (d < bestD) {
            bestD = d;
            best = q;
          }
        }
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------- 街口

/**
 * 街区出入口：把"车辆候选点"落成真实街口。
 *
 * 只认 `roadEdges` 上的点 —— 出入口必须开在城市道路上，不能开在街区内部。
 * 同一道路相邻 25 m 内只保留一个（两个门对着开在一条街上没有意义）。
 */
export function makeGates(input: ComposeInput): SiteGate[] {
  const out: SiteGate[] = [];
  const push = (kind: SiteGate['kind'], p: Pt, widthM: number) => {
    let best: { e: SiteRoadEdge; d: number } | null = null;
    for (const e of input.roadEdges) {
      const d = distToSeg(p, e.a, e.b);
      if (!best || d < best.d) best = { e, d };
    }
    if (!best) return;
    // 法线：垂直于道路，指向街区外（用街区形心判方向）
    const dx = best.e.b.x - best.e.a.x;
    const dy = best.e.b.y - best.e.a.y;
    const L = Math.hypot(dx, dy) || 1;
    let n = new Pt(-dy / L, dx / L);
    const c = centroidOf(input.boundary.outer);
    if ((c.x - p.x) * n.x + (c.y - p.y) * n.y > 0) n = new Pt(-n.x, -n.y);
    for (const g of out) {
      if (g.roadKey === best.e.key && Pt.distance(g.at, p) * 7 < 25) return;
    }
    out.push({ id: `${kind}-${out.length + 1}`, kind, at: p, normal: n, roadKey: best.e.key, widthM });
  };
  for (const p of input.vehicleEntrances.slice(0, 2)) push('vehicle', p, 7);
  for (const p of input.pedestrianEntrances.slice(0, 2)) push('pedestrian', p, 4);
  return out;
}

function centroidOf(ring: Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p.x;
    y += p.y;
  }
  return new Pt(x / Math.max(1, ring.length), y / Math.max(1, ring.length));
}

function distToSeg(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-12) return Pt.distance(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

// ---------------------------------------------------------------- 深内区

/** 沿每条真实道路的临街带（米 → 世界单位） */
export function frontStrips(input: ComposeInput): PlanSurface[] {
  const depth = U(FRONT_DEPTH_M[input.typology] ?? 34);
  const out: PlanSurface[] = [];
  for (const e of input.roadEdges) {
    const ring = bufferPolyline([e.a, e.b], depth);
    if (!ring) continue;
    const s = surface(ring);
    const clipped = surfaceIntersect([s], [input.buildable]).filter((q) => surfaceArea(q) > 1e-6);
    out.push(...clipped);
  }
  return mergeAll(out);
}

/** 深内区 = 可建区 − 临街带。这块地靠街用不到，必须另找接入 */
export function deepRegion(input: ComposeInput): PlanSurface[] {
  const strips = frontStrips(input);
  return surfaceSubtract([input.buildable], strips).filter((q) => surfaceArea(q) > 1e-6);
}

// ---------------------------------------------------------------- 骨架候选

/**
 * 提出骨架候选。
 *
 * 这里**不做全局最优搜索**，只枚举三种真实存在的空间语法：
 *   ① 无内部路：街区够浅，沿街地块自己就能组织（小地块 / 单排地块）；
 *   ② 单脊：一条主车行道从真实街口插入深内区，尽端回车；
 *   ③ 脊 + 支：脊太长或深内区太胖时，加一条次干道横向分开。
 *
 * 判据用"深内区"而不是"整个可建区"：既然临街带里的地块靠街就能成立，
 * 就不该为了"每块地都临路"去铺一条无人需要的路（那会白白吃掉 8~12% 的用地）。
 */

/**
 * 让主轴**顺着场地的形状弯**，而不是一条直线弦。
 *
 * 月牙形地块（R01 是 327 m 长、弧高 90 m 的月牙）上，一条直线弦必然贴着内弧走，
 * 两端离建筑很远、中间又切进绿地 —— 画出来不像"主轴"，像一条硬塞进去的路。
 * 做法：沿弦等距取 5 个站点，每站吸附到附近 clearance 最大的点（场地自己的脊线），
 * 再连成折线。这条路就是"场地本来想让路走的地方"。
 */
function bendToCore(seg: { a: Pt; b: Pt }, field: { pts: { at: Pt; clear: number }[] }, n = 5): Pt[] {
  const out: Pt[] = [];
  const radius = 26 / 7; // 吸附半径 26 m
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const base = new Pt(seg.a.x + (seg.b.x - seg.a.x) * t, seg.a.y + (seg.b.y - seg.a.y) * t);
    let best: Pt = base;
    let bestClear = -1;
    for (const q of field.pts) {
      if (Pt.distance(q.at, base) > radius) continue;
      // 越靠两端的站点越要贴回原位，否则主轴会缩成一小段
      const pull = 1 - Math.abs(t - 0.5) * 0.8;
      const score = q.clear * pull - Pt.distance(q.at, base) * 0.35;
      if (score > bestClear) {
        bestClear = score;
        best = q.at;
      }
    }
    if (out.length === 0 || Pt.distance(out[out.length - 1], best) > 1.5) out.push(new Pt(best.x, best.y));
  }
  return out;
}

export function proposeSkeletons(input: ComposeInput): SkeletonCandidate[] {
  const buildableM2 = surfaceArea(input.buildable) * 49;
  const deep = deepRegion(input);
  const deepM2 = deep.reduce((s, q) => s + surfaceArea(q), 0) * 49;
  const out: SkeletonCandidate[] = [
    { id: 'S0', label: '无内部路', spines: [], intent: '沿街地块直接靠城市道路组织，内部不新增车行道' },
  ];

  const minDeepM2 = Math.max(380, buildableM2 * 0.05);
  const ridge = ridgeOf(deep);
  /**
   * 车行骨架的准入门槛。
   *
   * 早先门槛不过就 `return out`，于是小场地（工业 142×56）连一条货运道都提不出来 ——
   * 而"工业园区一条主要货运道路"是布局语法里必须有的。现在改成**只影响车行骨架**，
   * 后面仍然会提"主轴"候选（工业按货运道算，住宅按步行主轴算）。
   */
  const deepOk = !(deepM2 < minDeepM2 || !ridge || ridge.clear * 7 < 11);
  if (!deepOk) {
    out[0].intent =
      `深内区 ${deepM2.toFixed(0)} m²（阈值 ${minDeepM2.toFixed(0)}）` +
      (ridge ? `，最大内切半径 ${(ridge.clear * 7).toFixed(1)} m` : '') +
      ' → 不足以支撑独立车行骨架，改提"主轴"候选（工业按货运道 / 住宅按步行主轴）';
  }

  const ob = (deep[0] ? obbOf(deep[0].outer) : null) ?? obbOf(input.buildable.outer);
  const axis = ob ? Math.atan2(ob.uy, ob.ux) : 0;
  const bb = bbox([input.buildable]);
  const span = Math.hypot(bb.maxX - bb.minX, bb.maxY - bb.minY);
  const corePt = ob ? new Pt(ob.cx, ob.cy) : new Pt((bb.minX + bb.maxX) / 2, (bb.minY + bb.maxY) / 2);

  // 主脊：过深内区脊点、沿长轴的弦。深内区不够大时退到"整个可建区"的长轴弦，
  // 否则 300 m 长条地块会因为深内区只有 60 m 而提不出任何主轴。
  let chord = deepOk && ridge ? chordThrough(deep, ridge.at, axis, span)[0] : null;
  if (!chord || chord.len * 7 < 70) {
    const alt = chordThrough([input.buildable], corePt, axis, span)[0];
    if (alt && (!chord || alt.len > chord.len)) chord = alt;
  }
  const gates = makeGates(input).filter((g) => g.kind === 'vehicle');
  if (deepOk && chord && chord.len * 7 >= 30) {
    const gate = pickGateFor(gates, chord, input.boundary);
    /**
     * 街口要接到**弦上最近的点**，不是弦的端点。
     *
     * 接端点会让路从街口斜穿半个街区过去（实测 G01 出现一条 45° 的斜路，
     * 从东南角直接切到西北），那既不是最短路径，也切碎了临街地块。
     * 接最近点则是一段短的引入 + 一段沿长轴的主脊，形态正常。
     */
    const q = gate ? projectOn(chord, gate.at) : chord.a;
    const far = Pt.distance(q, chord.a) > Pt.distance(q, chord.b) ? chord.a : chord.b;
    const pts = gate ? [gate.at, q, far] : [q, far];
    out.push({
      id: 'S1',
      label: '单脊主路',
      spines: [
        {
          cls: 'primary',
          pts: dedupePts(pts),
          why: `从 ${gate ? gate.roadKey + ' 街口' : '深内区边缘'} 插入，沿地块长轴贯穿深内区（弦长 ${(chord.len * 7).toFixed(0)} m），尽端可回车`,
        },
      ],
      intent: '把深内区（靠街用不到的部分）用一条主车行道串起来，后排地块获得真实车行接入',
    });
  }

  // 脊 + 支：深内区超过可建区 28% 且弦长超过 80 m 时才值得
  if (deepOk && chord && deepM2 > buildableM2 * 0.28 && chord.len * 7 > 80) {
    const gate = pickGateFor(gates, chord, input.boundary);
    const q2 = gate ? projectOn(chord, gate.at) : chord.a;
    const far2 = Pt.distance(q2, chord.a) > Pt.distance(q2, chord.b) ? chord.a : chord.b;
    const near = q2;
    const far = far2;
    const mid = new Pt((near.x + far.x) / 2, (near.y + far.y) / 2);
    const cross = chordThrough(deep, mid, axis + Math.PI / 2, span).filter((c) => c.len * 7 > 26)[0];
    if (cross) {
      out.push({
        id: 'S2',
        label: '脊 + 横向支路',
        spines: [
          {
            cls: 'primary',
            pts: dedupePts(gate ? [gate.at, q2, far2] : [q2, far2]),
            why: '主脊：从真实街口插入深内区并贯穿长轴',
          },
          {
            cls: 'secondary',
            pts: [cross.a, cross.b],
            why: `横向支路（${(cross.len * 7).toFixed(0)} m）：在深内区中部把过长的单排地块一分为二，缩短每块地的进深`,
          },
        ],
        intent: '深内区过大，单脊会切出超长条地块；加一条横向支路形成"一主一支"的骨架',
      });
    }
  }
  /**
   * S1p · 步行主轴。
   *
   * 为什么需要它：住宅园区里"一条 6 m 步道 + 两侧入户"是完全成立的布局语法，
   * 但它不满足车行骨架的深内区门槛（`ridge.clear` 与 `deepM2`），于是候选集里
   * 只剩 S0 —— 结果 300 m 长的月牙地块被画成一整片草地，没有任何可读的脉络。
   *
   * 这条主轴**不是**车行道（`cls: 'pedestrian'`），所以：
   *   · 不声称服务车辆，也不参与"无接入地块"的判定；
   *   · 但它真实占地，地块分割必须让开它（与 S1/S2 同一条装配流程）；
   *   · 沿线的建筑主入口可以正对它开门，这就是园区里那条"主路"。
   */
  if (chord && buildableM2 > 4000 && chord.len * 7 >= 60) {
    const industrial = input.typology === 'industrial' || input.typology === 'data_center';
    const gate = pickGateFor(gates, chord, input.boundary);
    const q3 = gate ? projectOn(chord, gate.at) : chord.a;
    const far3 = Pt.distance(q3, chord.a) > Pt.distance(q3, chord.b) ? chord.a : chord.b;
    if (!out.some((o) => o.id === 'S1p')) {
      /**
       * 工业园区的货运主轴要**贴着一侧走**，不能走中线。
       *
       * 142×56 m 的厂区，中线一条 7 m 路把场地切成两条 24 m 的窄带 ——
       * 厂房（进深 22~24 m）+ 装卸坪（12 m）根本放不下，实测直接产出 0 栋建筑。
       * 真实厂区是"路靠边、一侧厂房、一侧办公"：把主轴沿法线平移半个进深，
       * 一侧留 38 m（厂房 + 装卸），另一侧留 16 m（办公 + 员工停车）。
       */
      /**
       * 主轴走"脊线"而不是直线弦（见 `bendToCore`）。
       * 街口那一小段仍然保留，路才有真实的起点。
       */
      const field = clearanceField(input.buildable, 2);
      const bent = bendToCore({ a: q3, b: far3 }, field, 6);
      let pts = dedupePts(gate ? [gate.at, ...(bent.length >= 2 ? bent : [q3, far3])] : bent.length >= 2 ? bent : [q3, far3]);
      if (industrial) {
        const shortSideM = ob ? Math.min(toM(ob.w), toM(ob.d)) : 0;
        const shiftM = Math.min(12, Math.max(0, shortSideM / 2 - 16));
        if (shiftM > 0.5) {
          const nx2 = -Math.sin(axis);
          const ny2 = Math.cos(axis);
          const du = shiftM / 7;
          pts = pts.map((q) => new Pt(q.x + nx2 * du, q.y + ny2 * du));
        }
      }
      out.push({
        id: 'S1p',
        label: industrial ? '货运主轴' : '步行主轴',
        spines: [
          {
            cls: industrial ? 'service' : 'pedestrian',
            pts,
            why: industrial
              ? `7 m 货运主轴（${(chord.len * 7).toFixed(0)} m）：贯穿厂区，办公室与厂房分列两侧，装卸面朝路`
              : `6 m 步行主轴（${(chord.len * 7).toFixed(0)} m）：贯穿地块长轴，两端接街口，沿线建筑正向入户`,
          },
        ],
        intent: industrial
          ? '厂区必须有一条能组织货运的道路：不追求货车转弯仿真，但装卸面与它直接相邻'
          : '不新增车行道，但给园区一条可读的主脉络：步道 + 两侧入户 + 沿线绿地被它切成有尺度的段落',
      });
    }
  }
  return out;
}

/** 点到线段的最近点（夹在 8%~92%，避免正好落在端点上） */
function projectOn(seg: { a: Pt; b: Pt }, p: Pt): Pt {
  const dx = seg.b.x - seg.a.x;
  const dy = seg.b.y - seg.a.y;
  const l2 = dx * dx + dy * dy || 1;
  let t = ((p.x - seg.a.x) * dx + (p.y - seg.a.y) * dy) / l2;
  t = Math.max(0.08, Math.min(0.92, t));
  return new Pt(seg.a.x + dx * t, seg.a.y + dy * t);
}

function pickGateFor(gates: SiteGate[], chord: { a: Pt; b: Pt }, boundary: PlanSurface): SiteGate | null {
  let best: SiteGate | null = null;
  let bestD = Infinity;
  for (const g of gates) {
    // 街口必须在街区边界上（允许 6 m 误差）
    if (distToRing(g.at, boundary) * 7 > 6) continue;
    const d = Math.min(Pt.distance(g.at, chord.a), Pt.distance(g.at, chord.b));
    if (d < bestD) {
      bestD = d;
      best = g;
    }
  }
  return best;
}

function distToRing(p: Pt, s: PlanSurface): number {
  let d = Infinity;
  for (const ring of [s.outer, ...s.holes]) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      d = Math.min(d, distToSeg(p, a, b));
    }
  }
  return d;
}

function dedupePts(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    if (out.length === 0 || Pt.distance(out[out.length - 1], p) > 0.4) out.push(p);
  }
  return out.length >= 2 ? out : [];
}

// ---------------------------------------------------------------- 路面

export function sectionOf(cls: RoadClass): { total: number; carriage: number } {
  const s = SECTION[cls];
  return { total: s.carriage + s.sidewalk * 2, carriage: s.carriage };
}

/**
 * 骨架 → 真实路面。
 *
 * 路面 = 中心线按总宽缓冲 ∩ 红线。裁到红线内是硬要求：
 * 内部道路不得占城市道路的用地（那部分已经在地块红线外了）。
 */
/**
 * 折线路面 = 逐段矩形 ∪ 节点补块。
 *
 * 为什么不用 `bufferPolyline`（斜接）：
 * 骨架是先"从街口插进去"再"沿长轴贯穿"，两条段的夹角常常接近 90° 甚至更尖，
 * 斜接会把转角拉成一根 200 m 长的尖刺（实测 G01 出现一条横穿街区的深色楔形），
 * 那是几何噪声，不是路。逐段矩形 + 节点圆角不会产生任何尖刺，也天然支持岔口。
 */
function ribbonOf(pts: Pt[], halfU: number, headR = 0): PlanSurface[] {
  const out: PlanSurface[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const ring = bufferPolyline([pts[i], pts[i + 1]], halfU);
    if (ring) out.push(surface(ring));
  }
  for (let i = 1; i < pts.length - 1; i++) out.push(surface(octagon(pts[i], halfU)));
  if (headR > 0) out.push(surface(octagon(pts[pts.length - 1], headR)));
  if (out.length === 0) return [];
  try {
    const u = surfaceUnion(out);
    return u.length > 0 ? u : out;
  } catch {
    return out;
  }
}

/** 路到了街区内部而无处可去 → 需要回车场 */
function needsTurningHead(pts: Pt[], boundary: PlanSurface, cls: RoadClass): boolean {
  if (cls === 'pedestrian') return false;
  const end = pts[pts.length - 1];
  return distToRing(end, boundary) * 7 > 12;
}

function octagon(c: Pt, r: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    out.push(new Pt(c.x + Math.cos(a) * r, c.y + Math.sin(a) * r));
  }
  return out;
}

export function buildRoads(
  input: ComposeInput,
  sk: SkeletonCandidate,
  gates: SiteGate[]
): { roads: InternalRoad[]; ground: PlanSurface[]; notes: string[] } {
  void input;
  const roads: InternalRoad[] = [];
  const ground: PlanSurface[] = [];
  const notes: string[] = [];
  for (let i = 0; i < sk.spines.length; i++) {
    const sp = sk.spines[i];
    if (sp.pts.length < 2) continue;
    const sec = sectionOf(sp.cls);
    // 尽端主路要有回车场：一条 10 m 宽的路走到头不给掉头空间，消防车进不去
    const head = needsTurningHead(sp.pts, input.boundary, sp.cls) ? sp.pts[sp.pts.length - 1] : null;
    const ribbon = ribbonOf(sp.pts, U(sec.total) / 2, head ? U(9) : 0);
    if (ribbon.length === 0) continue;
    const clipped = surfaceIntersect(ribbon, [input.boundary]).filter((q) => surfaceArea(q) > 1e-6);
    if (clipped.length === 0) {
      notes.push(`内部道路 ${sk.id}/${i + 1} 裁到红线后为空，丢弃`);
      continue;
    }
    for (let k = 0; k < clipped.length; k++) {
      const id = clipped.length > 1 ? `int-${sk.id}-${i + 1}-${k + 1}` : `int-${sk.id}-${i + 1}`;
      const from = gates.find((g) => sp.pts.some((p) => Pt.distance(p, g.at) < 1.5))?.id ?? gates[0]?.id ?? 'none';
      roads.push({
        id,
        cls: sp.cls,
        widthM: sec.total,
        carriageM: sec.carriage,
        centerline: sp.pts.slice(),
        surface: clipped[k],
        serves: [],
        from,
        reason: sp.why,
      });
      ground.push(clipped[k]);
    }
  }
  return { roads, ground, notes };
}

// ---------------------------------------------------------------- 合成道路边

/**
 * 把内部道路包装成 `SiteRoadEdge`，交给 F2.1 的临街判定。
 *
 * 这是"道路先于地块"能成立的技术前提：分割器不认识"内部道路"这种新概念，
 * 它只认 `SiteRoadEdge`。与其改分割器的合同，不如让内部道路**说它的话**。
 * 注意这些边**不会**写回城市 Road Graph —— 它们是这块街区私有的。
 */
export function synthesicEdges(roads: InternalRoad[]): SiteRoadEdge[] {
  const out: SiteRoadEdge[] = [];
  for (const r of roads) {
    const a = r.centerline[0];
    const b = r.centerline[r.centerline.length - 1];
    out.push({
      key: r.id,
      a,
      b,
      len: Pt.distance(a, b),
      cls: 'local',
      // carriageSide / sidewalk 是**半宽**（世界单位）；与真实道路同一口径
      carriageSide: U(r.carriageM) / 2,
      sidewalk: U((r.widthM - r.carriageM) / 2 / 2),
      median: 0,
    });
  }
  return out;
}

/** 道路占用的地面是否真的从可建域里扣掉了（验证用） */
export function subtractRoads(buildable: PlanSurface, roadGround: PlanSurface[]): PlanSurface[] {
  if (roadGround.length === 0) return [buildable];
  return surfaceSubtract([buildable], roadGround).filter((s) => surfaceArea(s) > 0.05);
}

/**
 * 巷道补线：给仍然没有接入的地块，沿共享边界提一条窄巷道。
 *
 * 这是任务书"对没有接入的地块，优先调整切分或提出内部支路"的实现：
 * 巷道宽 4 m（消防 + 步行 + 服务），只沿**与已接入地块的共享边界**铺，
 * 所以它服务谁、为什么在这里，都能说清楚。
 */
export function laneForParcel(
  parcel: PlanSurface,
  donor: PlanSurface,
  widthM = 4
): { ring: Pt[]; serves: string; from: string } | null {
  const seg = sharedBoundarySegment(parcel, donor);
  if (!seg) return null;
  const len = Pt.distance(seg.a, seg.b) * 7;
  if (len < 12) return null;
  // 沿共享边界中点、法线方向向内 1/2 巷道宽，得到一条贴在共享边界上的路
  const mid = new Pt((seg.a.x + seg.b.x) / 2, (seg.a.y + seg.b.y) / 2);
  const dx = seg.b.x - seg.a.x;
  const dy = seg.b.y - seg.a.y;
  const L = Math.hypot(dx, dy) || 1;
  const n = new Pt(-dy / L, dx / L);
  const c = centroidOf(parcel.outer);
  const sgn = (c.x - mid.x) * n.x + (c.y - mid.y) * n.y > 0 ? 1 : -1;
  const off = U(widthM) / 2;
  const shifted: Pt[] = [seg.a, seg.b].map((p) => new Pt(p.x + n.x * sgn * off, p.y + n.y * sgn * off));
  const ring = bufferPolyline(shifted, off);
  if (!ring) return null;
  return { ring, serves: '', from: '' };
}

/** 两块面共享边界上最长的一段（用来提巷道 / 判相邻） */
export function sharedBoundarySegment(a: PlanSurface, b: PlanSurface): { a: Pt; b: Pt; lenU: number } | null {
  let best: { a: Pt; b: Pt; lenU: number } | null = null;
  for (let i = 0; i < a.outer.length; i++) {
    const p0 = a.outer[i];
    const p1 = a.outer[(i + 1) % a.outer.length];
    const mx = (p0.x + p1.x) / 2;
    const my = (p0.y + p1.y) / 2;
    // 中点在对方边界上（允许 0.6 m）→ 视为共享边
    if (distToRing(new Pt(mx, my), b) * 7 > 4.5) continue;
    const lenU = Pt.distance(p0, p1);
    if (!best || lenU > best.lenU) best = { a: p0, b: p1, lenU };
  }
  for (let i = 0; i < b.outer.length; i++) {
    const p0 = b.outer[i];
    const p1 = b.outer[(i + 1) % b.outer.length];
    const mx = (p0.x + p1.x) / 2;
    const my = (p0.y + p1.y) / 2;
    if (distToRing(new Pt(mx, my), a) * 7 > 4.5) continue;
    const lenU = Pt.distance(p0, p1);
    if (!best || lenU > best.lenU) best = { a: p0, b: p1, lenU };
  }
  return best;
}

/**
 * 一条内部道路服务了几块地。
 *
 * 判据是"地块与路面（外加 6 m 退让）有交集"，不是"地块 centroid 在附近" ——
 * 后者对长条地块完全失效：一条 140 m 长的地块 centroid 离路 40 m，但它整条都贴着路。
 */
export function parcelsAlongRoad(road: InternalRoad, parcels: PlanSurface[]): number {
  const ring = bufferPolyline(road.centerline, U(road.carriageM) / 2 + U(6));
  if (!ring) return 0;
  const widened = surface(ring);
  let n = 0;
  for (const p of parcels) {
    try {
      if (surfaceIntersect([p], [widened]).some((q) => surfaceArea(q) > 0.02)) n++;
    } catch {
      /* 单次失败不计 */
    }
  }
  return n;
}

/** 合并一组面（保留洞），失败时返回原列表 */
export function mergeAll(ss: PlanSurface[]): PlanSurface[] {
  if (ss.length <= 1) return ss;
  try {
    const u = surfaceUnion(ss);
    return u.length > 0 ? u : ss;
  } catch {
    return ss;
  }
}
