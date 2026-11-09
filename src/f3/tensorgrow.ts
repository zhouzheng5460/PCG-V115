// F3 · 路网创建的**第一步**：用 legacy 的张量场生成道路
//
// 用户口径（本轮）：
//   「将 legacy 部分的张量场生成道路设定为路网创建的第一步，然后切分街道围成的
//     地块，使用当前 F3 城市处理后续，道路的建模部分算法继续当前的 F3 的方式」
//
// 所以这里是明确的**先后关系**，不是两套路网并列：
//   ① 张量场（legacy 的 TensorField + RK4 流线）先生成整张路网的中心线；
//   ② 输出转成 F3 的 RawRoad → buildPathGraph → PathGraph（沿用 F3 的分级口径）；
//   ③ 之后 F3 才用 buildRoadGeom 铺路、用 site − 路网面 扣出街区，
//      再交给张量一级粗切 / splitParcels / landuse / layout / height 处理街区内；
//      这些后续流程一行都不改。
//
// 张量场一侧复用 `town/planning/roadgraph/skeleton/tensor.ts` 的 `tensorLines`：
// 它本身就是 legacy `town/field/**` 的 TensorField + traceFamily 套到真实场地轮廓
// 上的版本，输出 CutLine[]，并处理了延伸红线、跨族去重、按长度分级。
//
// 【噪波机制已移除】`deterministic: true` 关掉流线播种网格的随机抖动与洗牌，
// 设计层也不再加任何 fbm 位移；路网形态完全由张量场与场地轮廓决定。

import { Pt } from '../core/geom';
import { Rng } from '../core/rng';
import { bufferPolyline } from '../core/polyline';
import { M2, U, cleanRing, distPointToPolyline, shapeOf } from './geom';
import { bboxOf, insideSurface, surfaceArea, surfaceSubtract, type PlanSurface } from '../town/planning/core/surface';
import { tensorLines } from '../town/planning/roadgraph/skeleton/tensor';
import { buildPathGraph } from './streets';
import { simplifyGraph } from './graphclean';
import { classifyStreets, designGraph } from './design';
import { growStreets, snapEnds, type GrowResult } from './grow';
import type { CitySpec, RawRoad, RoadClass3, StylePreset } from './types';

/** 小场地不生成城市道路（与递归切分链路完全同一判据） */
function tooSmall(spec: CitySpec): boolean {
  return M2(surfaceArea(spec.boundary)) < 12000 || shapeOf(spec.boundary).minorM < 45;
}

function emptyDesign(): GrowResult['design'] {
  return {
    maxOffsetM: 0,
    meanOffsetM: 0,
    kinksBefore: 0,
    kinksAfter: 0,
    mix: { arterial: 0, collector: 0, local: 0 },
    thresholds: { arterialM: 0, collectorM: 0 },
    chains: 0,
    arterialChains: 0,
  };
}

/**
 * 张量流线围出的面（残块）。
 *
 * 用一个**很薄**的缓冲（±0.75 m）去减：面因此比真实街区向内缩 0.75 m，
 * 第二级递归切分在面内下的刀，端点离张量中心线也只有这么多 ——
 * `snapEnds(1.5 m)` 正好把它们拉回中心线，T 口成立。
 * 缓冲给厚了会把面啃小，给薄了布尔不稳。
 */
function residualFaces(spec: CitySpec, raws: RawRoad[]): PlanSurface[] {
  const buffers: PlanSurface[] = [];
  for (const r of raws) {
    const ring = bufferPolyline(r.pts, U(0.75));
    if (ring && ring.length >= 3) buffers.push({ outer: cleanRing(ring), holes: [] });
  }
  if (buffers.length === 0) return [];
  try {
    return surfaceSubtract([spec.boundary], buffers).filter((q) => M2(surfaceArea(q)) > 400);
  } catch {
    return [];
  }
}

/**
 * 断头线接到红线上：**每条张量线都要贯穿地块**。
 *
 * 流线在曲率大 / 相邻线逼近时会提前终止，围出的闭合面就带上一条"半截街"：
 *   · 街区多边形变得又长又碎（实测 organic 下出现 346 个顶点的街区）；
 *   · 二级切分拿到一个带凹口的怪面，切出来的地块矩形度直接崩掉；
 *   · 街景上表现为断头路 —— 真实路网里除了尽端式支路不该有。
 *
 * 做法：沿端点切线方向前进（2 m 步长），走到红线外，再二分回退到边界上。
 * 只改端点、不改中间点；延伸后会与别的线交叉，建图时自然变成十字路口。
 */
function extendEnds(raws: RawRoad[], boundary: PlanSurface): RawRoad[] {
  const STEP = U(2);
  // 上限必须大于场地对角线：切线方向贴着圆弧边界走时，400 m 都出不了红线
  const MAXLEN = U(1400);

  const march = (from: Pt, end: Pt): Pt => {
    const dx = end.x - from.x;
    const dy = end.y - from.y;
    const L = Math.hypot(dx, dy);
    if (L < 1e-6) return end;
    const ux = dx / L;
    const uy = dy / L;
    let prev = end;
    let travelled = 0;
    while (travelled < MAXLEN) {
      const q = new Pt(prev.x + ux * STEP, prev.y + uy * STEP);
      travelled += STEP;
      if (!insideSurface(q, boundary)) {
        // 二分：prev 在界内、q 在界外 → 收到边界上（±3 cm）
        let lo = prev;
        let hi = q;
        for (let i = 0; i < 12; i++) {
          const mid = new Pt((lo.x + hi.x) / 2, (lo.y + hi.y) / 2);
          if (insideSurface(mid, boundary)) lo = mid;
          else hi = mid;
        }
        return lo;
      }
      prev = q;
    }
    return prev;
  };

  return raws.map((r) => {
    const pts = r.pts.map((p) => new Pt(p.x, p.y));
    if (pts.length < 2) return r;
    const n = pts.length;
    // 界外的端点是张量线**故意延伸出红线**的尾巴，建图时会被裁掉，不要往回拉
    const needs = (p: Pt): boolean => insideSurface(p, boundary) && distPointToPolyline(p, boundary.outer) > U(0.5);
    if (needs(pts[0])) pts[0] = march(pts[1], pts[0]);
    if (needs(pts[n - 1])) pts[n - 1] = march(pts[n - 2], pts[n - 1]);
    return { ...r, pts };
  });
}

/**
 * 断头端补接：沿端点切线找**最近的一条别的路**，把端点挪到交点上。
 *
 * `extendEnds` 只负责把张量线接到红线；第二级递归切分的弦端点落在残块面
 * （比中心线内缩 0.75 m）上，偶尔会差一点点没接上，留下 20~140 m 的断头。
 * 这里按射线求交精确补齐（只在端点确实悬空时动手，已接上的不动）。
 */
function extendToNearest(raws: RawRoad[], boundary: PlanSurface): RawRoad[] {
  const segs: { a: Pt; b: Pt; owner: number }[] = [];
  raws.forEach((r, idx) => {
    for (let i = 0; i + 1 < r.pts.length; i++) segs.push({ a: r.pts[i], b: r.pts[i + 1], owner: idx });
  });

  /** 点到线段距离 */
  const segDist = (p: Pt, a: Pt, b: Pt): number => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    if (l2 < 1e-12) return Pt.distance(p, a);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
  };

  /** 射线 p + t·d 与线段求交，返回 t（>0）或 null */
  const hit = (p: Pt, dx: number, dy: number, s: { a: Pt; b: Pt }): number | null => {
    const ex = s.b.x - s.a.x;
    const ey = s.b.y - s.a.y;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) return null;
    const wx = s.a.x - p.x;
    const wy = s.a.y - p.y;
    const t = (wx * ey - wy * ex) / den;
    const u = (wx * dy - wy * dx) / den;
    if (t <= 0 || u < -1e-9 || u > 1 + 1e-9) return null;
    return t;
  };

  return raws.map((r, idx) => {
    const pts = r.pts.map((p) => new Pt(p.x, p.y));
    const n = pts.length;
    if (n < 2) return r;
    for (const end of [0, n - 1]) {
      const p = pts[end];
      if (!insideSurface(p, boundary)) continue;
      if (distPointToPolyline(p, boundary.outer) < U(0.6)) continue;
      const q = end === 0 ? pts[1] : pts[n - 2];
      const L = Pt.distance(p, q);
      if (L < 1e-6) continue;
      const dx = (p.x - q.x) / L;
      const dy = (p.y - q.y) / L;
      /**
       * 端点**已经**贴在别的路上（≤1.5 m）就不要外推。
       *
       * 上一版是先 snapEnds 把端点吸到最近的路上，再沿切向外推 —— 这时
       * 切线往往几乎平行于那条路，于是"外推"变成了沿着它复制一条 6 m 外的
       * 平行路（实测 74/1163 盏路灯的最近中心线是这条重影路，而不是它自己）。
       */
      /**
       * 已经贴住别的路（≤1.2 m）：**投影上去**，不外推。
       *
       * 外推会沿着那条路复制出一条 6 m 外的重影路（实测 74/1163 盏路灯的
       * "最近中心线"是重影而不是自己那条）；而单纯跳过又会在弦端点留下
       * 断头（实测 17 条）。投影让端点精确落在对方中心线上，建图时自然
       * 合并成 T 口 —— 既不重影也不断头。
       */
      let attached = false;
      for (const sg of segs) {
        if (sg.owner === idx) continue;
        if (segDist(p, sg.a, sg.b) >= U(1.2)) continue;
        const ex = sg.b.x - sg.a.x;
        const ey = sg.b.y - sg.a.y;
        const l2 = ex * ex + ey * ey;
        if (l2 < 1e-12) continue;
        let t = ((p.x - sg.a.x) * ex + (p.y - sg.a.y) * ey) / l2;
        t = Math.max(0, Math.min(1, t));
        pts[end] = new Pt(sg.a.x + ex * t, sg.a.y + ey * t);
        attached = true;
        break;
      }
      if (attached) continue;
      let best = U(260);
      let bestPt: Pt | null = null;
      for (const s of segs) {
        if (s.owner === idx) continue;
        const t = hit(p, dx, dy, s);
        if (t !== null && t > U(0.15) && t < best) {
          best = t;
          bestPt = new Pt(p.x + dx * t, p.y + dy * t);
        }
      }
      if (bestPt) {
        pts[end] = bestPt;
      } else {
        // 260 m 内没有可接的路：至少接到红线上，不留悬空端点
        let prev = p;
        for (let i = 0; i < 900; i++) {
          const q2 = new Pt(prev.x + dx * U(2), prev.y + dy * U(2));
          if (!insideSurface(q2, boundary)) break;
          prev = q2;
        }
        if (Pt.distance(prev, p) > U(1)) pts[end] = prev;
      }
    }
    return { ...r, pts };
  });
}

/**
 * 张量线里的**平行重影**合并成一条。
 *
 * 两族流线在曲率大的地方会靠到一起（organic 实测同一片街区被两条只隔 15 m
 * 的平行线夹住）。这时保留两条没有意义 —— 中间那块地放不下建筑，图上读成
 * "双线"，二级切分再切也只会切出更碎的条。用户口径：过近就合并成一条。
 *
 * 判据：两条线有 ≥ 40 m 的行程互相在 30 m 以内且方向近乎平行，就丢掉**较短**
 * 的那条（等长时丢后出现的），保留的那条已经承担了同样的连通作用。
 */
function mergeParallel(raws: RawRoad[], minGapM = 30, minRunM = 40): RawRoad[] {
  const gapU = U(minGapM);
  const alive = raws.map((r) => ({
    r,
    len: polyLenOf(r.pts),
    box: boxOf(r.pts),
    drop: false,
  }));
  const dist = (p: Pt, a: Pt, b: Pt): number => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
  };
  for (let i = 0; i < alive.length; i++) {
    if (alive[i].drop) continue;
    for (let j = i + 1; j < alive.length; j++) {
      if (alive[j].drop) continue;
      const A = alive[i];
      const B = alive[j];
      if (
        A.box.minX > B.box.maxX + gapU ||
        B.box.minX > A.box.maxX + gapU ||
        A.box.minY > B.box.maxY + gapU ||
        B.box.minY > A.box.maxY + gapU
      )
        continue;
      let run = 0;
      for (let k = 0; k + 1 < A.r.pts.length; k++) {
        const a = A.r.pts[k];
        const b = A.r.pts[k + 1];
        const L = Pt.distance(a, b);
        const segLenM = L * 7;
        const mid = new Pt((a.x + b.x) / 2, (a.y + b.y) / 2);
        const adx = (b.x - a.x) / (L || 1);
        const ady = (b.y - a.y) / (L || 1);
        let best = Infinity;
        let bdx = 0;
        let bdy = 0;
        for (let m = 0; m + 1 < B.r.pts.length; m++) {
          const p0 = B.r.pts[m];
          const p1 = B.r.pts[m + 1];
          const ex = p1.x - p0.x;
          const ey = p1.y - p0.y;
          const el = Math.hypot(ex, ey) || 1;
          const t = Math.max(0, Math.min(1, ((mid.x - p0.x) * ex + (mid.y - p0.y) * ey) / (el * el)));
          const d = Math.hypot(mid.x - (p0.x + ex * t), mid.y - (p0.y + ey * t));
          if (d < best) {
            best = d;
            bdx = ex / el;
            bdy = ey / el;
          }
        }
        if (best > gapU) continue;
        if (Math.abs(adx * bdy - ady * bdx) > 0.34) continue;
        run += segLenM;
      }
      if (run < minRunM) continue;
      // 丢短的那条（等长时丢后出现的）
      const dropB = B.len <= A.len;
      if (dropB) B.drop = true;
      else {
        A.drop = true;
        break;
      }
    }
  }
  return alive.filter((q) => !q.drop).map((q) => q.r);
}

function polyLenOf(pts: Pt[]): number {
  let L = 0;
  for (let i = 0; i + 1 < pts.length; i++) L += Pt.distance(pts[i], pts[i + 1]);
  return L;
}

function boxOf(pts: Pt[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

export function growStreetsTensor(spec: CitySpec, preset: StylePreset): GrowResult {
  const notes: string[] = [];
  const siteArea = M2(surfaceArea(spec.boundary));
  const minorM = shapeOf(spec.boundary).minorM;
  if (tooSmall(spec)) {
    notes.push(
      `判定：不需要内部道路。场地 ${siteArea.toFixed(0)} m² / 窄边 ${minorM.toFixed(0)} m —— 按单个院落处理（不是生成失败）`
    );
    return {
      raws: [],
      graph: buildPathGraph([], spec.boundary),
      axisRad: spec.axisRad ?? 0,
      notes,
      faces: [{ ring: spec.boundary.outer, depth: 0, areaM2: +siteArea.toFixed(0) }],
      design: emptyDesign(),
    };
  }

  // ---------------- ① 张量场生成道路（路网创建第一步）
  // `tensorLines` 内部会 Rng.reset(seed)；F3 用局部 makeRng，必须把全局序列还原，
  // 否则同页面来回切 Legacy / F3 时 legacy 的随机序列会被悄悄改掉。
  /**
   * 流线间距：张量场围出的街区面积约 `0.55 × 间距²`（同族间距 s、跨族也近似 s，
   * 加上邻域裁剪后取中位）。预设里的 `spacingM` 是给 legacy 格网用的 —— 那套
   * 格网会成对生成平行街，实际街区只有 `0.6 × spacingM²` 的一半左右。
   * 所以这里按 `blockM2` 反算，让张量围出的街区与「面切分」的街区同一尺度：
   *   s = √(blockM2 / 0.55) × 0.72 ≈ spacingM × 0.69（三者恰好同源）
   */
  /**
   * 间距 = **主干路**级：张量只负责城市最宽那一级道路的整体形态。
   *
   * 目标：张量围出的"超街区"约 8 个标准街区大小（≈ 8 × blockM2），
   * 于是第二次切分（现有递归面切分）必须真的动刀，才能把 4 个街区切出来
   * —— 这才看得见「二级产生的低一级道路系统」。
   * 之前间距按单个街区反算（structured 123 m），张量自己就把街区切完了，
   * 二级只剩补切几个超大残块，视觉上等于没有二级。
   *   s = √(4·blockM2 / 0.55) × 0.72 ≈ 1.44 × 旧值
   */
    // 超街区 ≈ 8 个标准街区（≈ 8 × blockM2）：这样二级能稳定切出 2 个等级
  // （第一刀次干把超街区对半，第二刀支路再对半），主干不至于像现在这样
  // 每 250 m 一条（真实城市主干 500~800 m 一条）。
  const spacingM = Math.max(90, Math.min(600, Math.sqrt((preset.blockM2 * 8) / 0.55) * 0.72));
  /**
   * 场地放不下**两个主干间距**时，张量主干网格根本不成立 —— 退回递归面切分。
   *
   * 实测 R01（真实小住宅地块）在 313 m 间距下只追出 1 条线，围不出一个
   * 完整街区，最后是 1 街区 / 0 建筑。主干网格是给"城"用的，不是给"院"用的；
   * 这种尺度本来就该走递归切分（它按街区模数自适应）。
   */
  const bbSite = bboxOf(spec.boundary.outer);
  const spanMinM = Math.min(bbSite.maxX - bbSite.minX, bbSite.maxY - bbSite.minY) * 7;
  if (spanMinM < spacingM * 2.2) {
    const fallback = growStreets(spec, preset);
    notes.push(
      `场地窄边 ${spanMinM.toFixed(0)} m < 2.2 个主干间距（${spacingM.toFixed(0)} m）→ 主干网格放不下，` +
        '退回递归面切分（同一套街区模数，自适应小场地）'
    );
    notes.push(...fallback.notes);
    return { ...fallback, notes };
  }

  const prevSeed = Rng.getSeed();
  const t = tensorLines(spec.boundary, spec.style, {
    spacingM,
    seed: spec.seed,
    axisRad: spec.axisRad,
    deterministic: true,
    maxLines: 140,
    guides: spec.guides,
  });
  Rng.reset(prevSeed);
  notes.push(...t.notes);
  notes.push(
    `路网第一步：legacy 张量场生成 ${t.lines.length} 条道路中心线（确定性播种，无噪波）；` +
      `之后才切分街道围成的地块，街区内流程与道路建模仍走 F3 现有算法`
  );

  /**
   * 等级**按来源**定，不再按长度重排（原来 classifyStreets 会把二级切出来的
   * 长街也升成主干，三级路网塌成一级，图上只剩张量那套网格）：
   *   张量流线 = 主干级（城市最宽一级，决定整体形态）；
   *   张量里较短的流线 = 次干（它们本来就是同一套骨架的次要方向）；
   *   递归面切分 = 从不产生主干，第一刀次干、更深支路。
   *
   * 为什么不把张量线**全部**做成主干：17 m 车行 + 两侧人行绿带铺满 347 m
   * 一张网，路口圆弧补偿在宽断面下会被短边限幅压平（实测内层半径 4.13 m
   * vs 街角 6.00 m），层间布尔也开始退化。主干只取张量里够长的那一批，
   * 断面几何才稳定。
   */
  let raws: RawRoad[] = t.lines.map((l, i) => ({
    id: `T${i}`,
    pts: l.pts.map((p) => new Pt(p.x, p.y)),
    cls: (l.cls === 'arterial' ? 'arterial' : 'collector') as RoadClass3,
    from: 'fracture',
  }));
  // 每条线贯穿地块：断头端沿切向接到红线（不留半截街，闭合面才干净）
  raws = extendEnds(raws, spec.boundary);
  // 平行重影合并成一条（两族流线在曲率大的地方会并到一起）
  const beforeMerge = raws.length;
  raws = mergeParallel(raws);
  if (raws.length < beforeMerge) {
    notes.push(`张量线平行合并：${beforeMerge} → ${raws.length} 条（< 30 m 且平行 ≥ 40 m 的重影只留一条）`);
  }

  // ---------------- ② 第二次切分：残块交给现有递归面切分（当前的方式）
  //
  // 张量流线是**稀疏**的主干骨架：organic 风貌下场弯曲得厉害，流线会在
  // 曲率大的地方提前终止，围出一个 36 万 m² 的空洞（实测占场地 36%）——
  // 那个街区后面会整块变成一个"civic 大院"，覆盖率从 46% 掉到 30%。
  // 所以这一步不是可选的：凡是面积超过 1.8 × 目标街区面积的残块，
  // 都用现有 growStreets 的递归切分再切一次（depthBase=1，等级从次干起）。
  // 机制、判据、弦方向全部沿用原实现，一行规则都没新发明。
  const targetM2 = preset.blockM2 * (spec.density === 'high' ? 0.82 : spec.density === 'low' ? 1.22 : 1);
  const residual = residualFaces(spec, raws);
  /**
   * **每一个**张量超街区都交给递归面切分，切到街区模数为止。
   *
   * 只切"超大残块"（>1.8×target）时，绝大多数超街区原样穿过 —— 于是图上
   * 只有张量那一套网格，二级的低一级道路系统根本不存在。
   * 现在张量间距按 4 个街区给，这里就能稳定切出两级：
   *   第一刀（depth 1）= 次干，穿过整个超街区；
   *   第二刀起（depth 2+）= 支路，把半个超街区再对半分。
   */
  const seeds = residual.filter((q) => M2(surfaceArea(q)) > targetM2 * 1.12);
  if (seeds.length) {
    const sub = growStreets(spec, preset, { seeds, depthBase: 1 });
    raws = [...raws, ...sub.raws];
    const nC = sub.raws.filter((r) => r.cls === 'collector').length;
    notes.push(
      `第二次切分（现有递归面切分）：${seeds.length} 个张量超街区（共 ${seeds
        .reduce((a, q) => a + M2(surfaceArea(q)), 0)
        .toFixed(0)} m²）→ 次干 ${nC} 条 / 支路 ${sub.raws.length - nC} 条`
    );
  }

  // ---------------- ③ F3 自己的建图 / 修形 / 分级（口径不变）
  let merged = snapEnds(raws, U(3));
  for (let i = 0; i < 2; i++) merged = snapEnds(extendToNearest(merged, spec.boundary), U(1.2));
  /**
   * 最后再合并一次平行重影。
   *
   * 前面的避让是在"下刀之前"判的，但端点吸附 / 外推 / 平滑会把中心线挪 1~3 m，
   * 实测仍有 T×gf 的两条线在 60~70 m 行程里贴到 28 m 以内。这里在**最终几何**
   * 上再判一次：只留长的那条，短的（支路）直接并进去。
   */
  const beforeFinal = merged.length;
  merged = mergeParallel(merged, 34, 60);
  if (merged.length < beforeFinal) {
    notes.push(`平行街最终合并：${beforeFinal} → ${merged.length} 条（最终几何上 < 34 m 且平行 ≥ 60 m）`);
  }
  const graph = buildPathGraph(merged, spec.boundary);
  // 多线相交的第一道对策：把"同一处被切成几个路口"合回去（见 graphclean.ts）
  if (spec.noGraphClean) notes.push('路网图清理：已按调试开关关闭（?f3clean=0）');
  else notes.push(...simplifyGraph(graph).notes);
  const design = designGraph(graph, spec.style, spec.seed, spec.boundary);
  const cls = classifyStreets(graph, notes);
  design.mix = cls.mix;
  design.thresholds = cls.thresholds;
  design.chains = cls.chains;
  design.arterialChains = cls.arterialChains;

  notes.push(
    `PathGraph：节点 ${graph.nodes.size} · 边 ${graph.edges.size} · 路径 ${graph.paths.length} · 路口 ${graph.junctions.length}（度≥3）`
  );
  notes.push(
    `中心线只做重采样 + 平滑（噪波已移除）：平均位移 ${design.meanOffsetM.toFixed(2)} m / 最大 ${design.maxOffsetM.toFixed(2)} m`
  );

  return {
    raws,
    graph,
    axisRad: t.axisRad,
    notes,
    faces: residual.map((q) => ({ ring: cleanRing(q.outer), depth: 1, areaM2: +M2(surfaceArea(q)).toFixed(0) })),
    design,
  };
}
