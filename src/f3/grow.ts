// F3 · 路网图生长（递归面切分）—— 替换掉"先画线再布尔减出街区"的做法
//
// 为什么必须换
// ------------
// 上一版是：格网线 / Voronoi 边 → 裁到多边形 → 缓冲 → **场地减路面 = 街区**。
// 街区是"布尔的余数"，所以形状跟路网拓扑无关：会出现四边贴路但形状随机的地块，
// 交界处被路幅宽度啃出直角，等级只能靠"离形心最近"硬挑。
//
// Houdini / CityEngine / Parish–Müller 那一套的核心不是"线画得好看"，而是**顺序**：
//   路网先成**图** → 街区是**图的面** → 面再递归切地块。
//
// 这里用最稳的一种实现：**递归面切分**。
//   · 初始只有一个面（城市边界）
//   · 每次挑最大的面，用一条**穿过它全宽的弦**切成两个面
//   · 弦的端点必然落在已有路（或红线）上 → 天然是 T 口，不会悬空
//   · 弦不可能与别的路相交（它在自己的面内）→ 平面性由构造保证
//   · 递归深度 = 街道等级（0 = 主干，深 = 支路），这是**拓扑给等级**，不是量出来的
//   · 面积达标就停 → 街区尺度由一个旋钮控制，且不会产生碎条
//
// 这一版没有 Voronoi、没有格网裁剪、没有骨架评分。
// 【噪波机制已移除】切分角度/位置抖动一律为 0：路网形态只由张量场方向与目标街区面积决定。
// 该文件保留为「递归切分」回退链路（?f3road=split），F3 默认第一步已改为张量场生成道路。

import { Pt } from '../core/geom';
import { insideSurface, surfaceArea, surfaceIntersect, type PlanSurface } from '../town/planning/core/surface';
import { makeRng, obbOf } from '../town/planning/subdivision/geom';
import { M2, U, cleanRing, clipLineToSurface, polyLen, shapeOf } from './geom';
import { buildPathGraph, cityField, mainAxisOf } from './streets';
import { simplifyGraph } from './graphclean';
import { classifyStreets, designGraph, type DesignStats } from './design';
import type { CitySpec, PathGraph, RawRoad, RoadClass3, StylePreset } from './types';

export interface GrowResult {
  raws: RawRoad[];
  graph: PathGraph;
  axisRad: number;
  notes: string[];
  /** 递归切分出来的面（诊断/出图用：地块就是从这些面里长出来的） */
  faces: { ring: Pt[]; depth: number; areaM2: number }[];
  /** 修形与分级统计（报告与断言用） */
  design: DesignStats;
}

/** 两条**平行**道路之间的最小间距（米）：再近就会切出一条放不下建筑的窄条 */
const MIN_PARALLEL_GAP_M = 38;
/** |sinθ| 小于它就算"平行"（≈20°） */
const PARALLEL_SIN = 0.34;

/** 风貌参数：决定"怎么切" */
interface GrowStyle {
  /** 目标街区面积（m²） */
  targetM2: number;
  /** 切分角相对"垂直长轴"的抖动（弧度） */
  angleJitter: number;
  /** 切分位置相对中点的抖动（占该方向跨度的比例） */
  offsetJitter: number;
  /** 面再小就不切了：短边小于它（米）就停 */
  minWidthM: number;
  /** 切出来的弦短于它（米）就不承认这一刀 */
  minChordM: number;
  /** 最多切多少刀（安全阀） */
  maxCuts: number;
}

function styleOf(spec: CitySpec, preset: StylePreset): GrowStyle {
  const high = spec.density === 'high' ? 0.82 : spec.density === 'low' ? 1.22 : 1;
  switch (spec.style) {
    case 'organic':
      return {
        targetM2: preset.blockM2 * high,
        angleJitter: 0,
        offsetJitter: 0,
        minWidthM: 34,
        minChordM: 24,
        maxCuts: 900,
      };
    case 'campus':
      return {
        targetM2: preset.blockM2 * high,
        angleJitter: 0,
        offsetJitter: 0,
        minWidthM: 90,
        minChordM: 40,
        maxCuts: 200,
      };
    default:
      return {
        targetM2: preset.blockM2 * high,
        angleJitter: 0,
        offsetJitter: 0,
        minWidthM: 42,
        minChordM: 26,
        maxCuts: 600,
      };
  }
}

export interface GrowOpts {
  /**
   * 从这些面开始递归切（而不是整个场地）。用于「张量主干路先切、残块再切」：
   * 张量流线围出的面就是第二级的起点，切完才得到真正的街区。
   */
  seeds?: PlanSurface[];
  /** 起始递归深度：0 = 贯穿全城的主干刀；1 = 街区内部的次干/支路刀 */
  depthBase?: number;
  /** 覆盖目标面面积（m²）：残块补切时用街区模数，而不是全城模数 */
  targetM2?: number;
}

export function growStreets(spec: CitySpec, preset: StylePreset, opts: GrowOpts = {}): GrowResult {
  const notes: string[] = [];
  const st = styleOf(spec, preset);
  if (opts.targetM2) st.targetM2 = opts.targetM2;
  const depthBase = opts.depthBase ?? 0;
  const axisRad = spec.axisRad ?? mainAxisOf(spec.boundary);
  // 用带 tag 的局部队列：Rng 是全局单例，多条链路同时跑会互相污染序列
  const rng = makeRng(spec.seed, 'f3grow');

  const raws: RawRoad[] = [];
  /** 平行避让统计：挪位置 / 换方向 / 放弃这一刀 */
  const seeds = opts.seeds && opts.seeds.length ? opts.seeds : [spec.boundary];
  const faces: { poly: PlanSurface; depth: number; ring: Pt[] }[] = seeds.map((s) => ({
    poly: s,
    depth: depthBase,
    ring: cleanRing(s.outer),
  }));

  const siteArea = M2(surfaceArea(spec.boundary));

  /**
   * 太小或太窄的场地**不切路**。
   *
   * 5000 m² 的地块上跑一条 18 m 的主干（含人行道绿带 32 m 断面），
   * 剩下的地连一栋厂房都放不下（I01 实测 0 栋建筑）。真实世界也是这个结论：
   * 这样的地块本身就是"一个院"，进出口接市政路，内部没有城市道路。
   * 这不是"生成失败"，是应当写进结论的判断。
   */
  const minorM = shapeOf(spec.boundary).minorM;
  if (siteArea < 12000 || minorM < 45) {
    notes.push(
      `判定：不需要内部道路。场地 ${siteArea.toFixed(0)} m² / 窄边 ${minorM.toFixed(0)} m —— 放不下一整条断面（车行+人行+绿带），`
        + '按单个院落处理（不是生成失败）'
    );
    const emptyGraph = buildPathGraph([], spec.boundary);
    return {
      raws,
      graph: emptyGraph,
      axisRad,
      notes,
      faces: faces.map((f) => ({ ring: f.ring, depth: 0, areaM2: +M2(surfaceArea(f.poly)).toFixed(0) })),
      design: {
        maxOffsetM: 0,
        meanOffsetM: 0,
        kinksBefore: 0,
        kinksAfter: 0,
        mix: { arterial: 0, collector: 0, local: 0 },
        thresholds: { arterialM: 0, collectorM: 0 },
        chains: 0,
        arterialChains: 0,
      },
    };
  }
  /**
   * 张量场：只用来**给方向**，不参与"路怎么长"。
   *
   * 递归面切分的机制不变（挑最大的面 → 一刀切两半 → 递归），
   * 但"刀口朝哪"不再只看这个面自己的 OBB 长轴 —— 而是问张量场当前的主方向。
   * 这样全城的方向是连续的：一条街切到下一个面时仍然顺着同一个场，
   * 靠近城市边界时场被边界源带弯，街道也就自然地跟着弯过去。
   * （这正是 Houdini/CityEngine 里 tensor field 的角色：只提供方向场。）
   */
  const field = cityField(spec.boundary, axisRad, spec.style === 'organic' ? 0.9 : spec.style === 'campus' ? 0.35 : 0.55);
  const diagM = Math.hypot(...((): [number, number] => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of spec.boundary.outer) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    return [maxX - minX, maxY - minY];
  })()) * 7;

  // ---------------- 第 0 刀：主干，沿场地长轴，靠近形心
  //
  // 城市主干是"沿着城市走"的，不是横切一刀。切完得到两条长条，
  // 后面每一刀都在更小的面里做，等级自然层层下降。
  //
  // 从 seeds 起切（张量残块）时不打这一刀：那些面本来就是被主干路围出来的。
  let cuts = 0;
  const gapStat = { shifted: 0, reangled: 0, skipped: 0 };
  if (!opts.seeds || opts.seeds.length === 0) {
    cutFace(faces[0], 0);
    cuts = 1;
  }

  // ---------------- 递归：每次切最大的面
  for (let iter = 0; iter < st.maxCuts; iter++) {
    // 找最大的、还值得切的面
    /**
     * 停止门槛 1.5 而不是 1.08。
     *
     * 切一刀只会把面**对半**，所以用 1.08 作门槛时，一块 1.2×目标的面也会
     * 被切成 0.6× —— 结果永远比目标小一档（实测目标 16,000 m² 的街区实际
     * 只有 6,600 m²，街区碎成 80 m 见方，路网密度翻倍）。
     * 1.5 倍门槛的收敛区间是 [0.75, 1.5]×目标：不会再"多切一刀"。
     */
    let best = -1;
    let bestArea = st.targetM2 * 1.5;
    for (let i = 0; i < faces.length; i++) {
      const a = M2(surfaceArea(faces[i].poly));
      if (a > bestArea && wideEnough(faces[i].poly, st.minWidthM)) {
        bestArea = a;
        best = i;
      }
    }
    if (best < 0) break;
    const face = faces[best];
    const ok = cutFace(face, face.depth);
    if (!ok) {
      // 这个面切不动（太窄 / 弦太短）：标记成"不再切"，避免死循环
      face.depth = 999;
      continue;
    }
    cuts++;
  }

  if (gapStat.shifted + gapStat.reangled + gapStat.skipped > 0) {
    notes.push(
      `平行街避让（≥ ${MIN_PARALLEL_GAP_M} m）：挪位置 ${gapStat.shifted} 刀 / 换方向 ${gapStat.reangled} 刀 / 放弃 ${gapStat.skipped} 刀`
    );
  }
  notes.push(
    `${spec.style}：递归切分 ${cuts} 刀 → 面 ${faces.filter((f) => f.depth !== 999).length} 个（目标街区 ${st.targetM2.toFixed(0)} m²，最短弦 ${st.minChordM} m，最窄面 ${st.minWidthM} m）`
  );

  // 端点吸附：切分出来的弦，端点理论上落在上一刀的中心线上，
  // 但布尔运算会带来 1e-4 级偏差，交点判据（3.5 cm 量化）偶尔抓不住，
  // 于是留下 60~145 m 的孤立"断头路"（实测 10 根）。这里把端点拉回 1.5 m 内最近的路。
  const snapped = snapEnds(raws, U(1.5));
  const graph = buildPathGraph(snapped, spec.boundary);
  if (!spec.noGraphClean) notes.push(...simplifyGraph(graph).notes);

  /**
   * 修形 + 分级。
   *
   * 顺序不能反：先修形（几何），再分级（长度）—— 修形会改变各条街的长度
   * 一点（1%~3%），分级要按修形后的真实长度算，否则阈值和实际对不上。
   * 修形不动节点坐标，所以分级之后所有下游（路口、地块）读到的仍是同一套拓扑。
   */
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
    `中心线修形：平均位移 ${design.meanOffsetM.toFixed(2)} m / 最大 ${design.maxOffsetM.toFixed(2)} m · ` +
      `折角 ${design.kinksBefore} → ${design.kinksAfter} 个（端点不动，拓扑不变）`
  );

  return {
    raws,
    graph,
    axisRad,
    notes,
    faces: faces.map((f) => ({ ring: f.ring, depth: f.depth, areaM2: +M2(surfaceArea(f.poly)).toFixed(0) })),
    design,
  };

  // ---------------------------------------------------------------- 内部

  /**
   * 把面切成两半：一条穿过全宽的弦。
   *
   * 返回 false 表示"这一刀不该下"（面太窄、弦太短、两侧任一侧面积过小）。
   */
  function cutFace(face: { poly: PlanSurface; depth: number; ring: Pt[] }, depth: number): boolean {
    const ob = obbOf(face.ring);
    if (!ob) return false;
    const faceArea = M2(surfaceArea(face.poly));
    const c = new Pt(ob.cx, ob.cy);

    /**
     * 弦的方向：**取张量场的主/次方向里，跟自己长轴更近的那一个**。
     *
     * 这一步是"刀口顺着场走"，不是"场决定一切"：
     *   · 只保留与长轴夹角更小的那个候选（另一个会切出细条）；
     *   · 场给的是局部方向，所以相邻两块面会拿到几乎一样的方向 —— 街道因此连贯。
     */
    const longAng = Math.atan2(ob.uy, ob.ux);
    const fld = field.angleAt(c.x, c.y, 'major').a;
    const modPi = (a: number): number => {
      let v = a % Math.PI;
      if (v < 0) v += Math.PI;
      return v;
    };
    const dField = (() => {
      const a = modPi(fld);
      const b = modPi(fld + Math.PI / 2);
      const la = modPi(longAng);
      const diff = (x: number, y: number): number => {
        let d = Math.abs(x - y) % Math.PI;
        return Math.min(d, Math.PI - d);
      };
      /**
       * 目标方向：主干沿长轴切（把城一分为二），其余**垂直于长轴**切
       * （缩短长边，让面越切越方）。
       *
       * 这里踩过一次坑：两级都"取离长轴最近的方向"时，刀口始终平行于长轴，
       * 于是 200×80 的面被切成 200×40、200×20、200×10…… 全城变成一排
       * 20 m 宽的平行条带（路面从 13 万 m² 涨到 53 万 m²）。
       */
      const target = depth === 0 ? la : la + Math.PI / 2;
      return diff(a, target) <= diff(b, target) ? a : b;
    })();
    const chordAng = dField;

    // 位置：沿弦的法线方向偏移（即沿"被切掉的那条轴"挪）
    const spanU = Math.max(ob.w, ob.d);
    const jitter = depth === 0 ? 0 : (rng() - 0.5) * 2 * st.offsetJitter;
    const angJit = depth === 0 ? 0 : (rng() - 0.5) * 2 * st.angleJitter;
    const baseAng = chordAng + angJit;

    /**
     * 选刀口：**先试场给的方向，贴太近就换位置，还不行就换方向**。
     *
     * 相邻两个面各自下刀时，很容易在同一片区域切出两条只隔 10~20 m 的平行街，
     * 中间那条窄条放不下建筑，图上还读成"双线"。用户口径：过近就合并成一条
     * 或者换个切法。这里的顺序是：
     *   ① 原位够开（≥ MIN_PARALLEL_GAP_M）→ 切；
     *   ② 不够开 → 沿法线把刀口推开"差多少 + 1 m"再试；
     *   ③ 还不行 → 换方向（90°、±45°）再走一遍 ①②；
     *   ④ 都不达标 → 取"最不那么糟"的那个候选，实在不行才放弃这一刀。
     * 只"跳过"不"换向"会让街区数直接腰斩（实测 51 → 23 个街区），
     * 因为一个面被放弃就没有第二次机会了。
     */
    type Pick = { at: Pt; ang: number; chord: Pt[]; gapM: number };
    const angles = [baseAng, baseAng + Math.PI / 2, baseAng + Math.PI / 4, baseAng - Math.PI / 4];
    let chosen: Pick | null = null;
    let fallback: Pick | null = null;
    for (const angTry of angles) {
      const nx = -Math.sin(angTry);
      const ny = Math.cos(angTry);
      const chordAt = (pos: Pt): Pt[] | null => {
        const segs = clipLineToSurface(face.poly, pos, angTry);
        if (segs.length === 0) return null;
        let best = segs[0];
        for (const sg of segs) if (polyLen(sg) > polyLen(best)) best = sg;
        return polyLen(best) * 7 >= st.minChordM ? best : null;
      };
      const base = new Pt(c.x + nx * spanU * jitter * 0.5, c.y + ny * spanU * jitter * 0.5);
      const chord0 = chordAt(base);
      if (!chord0) continue;
      let cand: Pick = { at: base, ang: angTry, chord: chord0, gapM: nearestParallel(chord0, angTry).gapM };
      if (cand.gapM >= MIN_PARALLEL_GAP_M) {
        chosen = cand;
        break;
      }
      // ② 沿法线推开，躲到那条街的另一侧
      const par = nearestParallel(chord0, angTry);
      const push = U(MIN_PARALLEL_GAP_M - par.gapM + 1);
      const dir = par.signed > 0 ? -1 : 1;
      const moved = new Pt(base.x + nx * push * dir, base.y + ny * push * dir);
      const alt = chordAt(moved);
      if (alt) {
        const g = nearestParallel(alt, angTry).gapM;
        if (g > cand.gapM) cand = { at: moved, ang: angTry, chord: alt, gapM: g };
        if (g >= MIN_PARALLEL_GAP_M) {
          chosen = cand;
          break;
        }
      }
      if (!fallback || cand.gapM > fallback.gapM) fallback = cand;
    }
    // ④ 兜底：宁可留一条略窄的街，也别让整个面再也切不动
    const pick = chosen ?? (fallback && fallback.gapM >= MIN_PARALLEL_GAP_M * 0.92 ? fallback : null);
    if (!pick) {
      gapStat.skipped++;
      return false;
    }
    const at = pick.at;
    const ang = pick.ang;
    const chord = pick.chord;
    if (pick.gapM < MIN_PARALLEL_GAP_M) gapStat.reangled++;
    else if (pick.at.x !== c.x && Math.abs(pick.ang - baseAng) < 1e-6) gapStat.shifted++;

    // 真的切
    let a: PlanSurface[] = [];
    let b: PlanSurface[] = [];
    try {
      const r = splitByLine(face.poly, at, ang);
      if (!r) return false;
      a = r.a;
      b = r.b;
    } catch {
      return false;
    }
    const areaA = a.reduce((s, q) => s + M2(surfaceArea(q)), 0);
    const areaB = b.reduce((s, q) => s + M2(surfaceArea(q)), 0);
    // 一侧塌掉（切在边界上）→ 不下这一刀
    if (areaA < 90 || areaB < 90) return false;

    // 等级：弦长相对场地对角线 —— 这是"这条路承载多少"的代理指标，
    // 比"离形心最近"讲得通：贯穿全城的是主干，切半块的是支路。
    // 等级由**递归深度**给：depth 0 = 贯穿全城的主干，depth 1 = 次干，再深就是支路。
    // 长弦可以升一档（贯穿半个城的路本来就不该是支路），但不再让"长度"决定主干 ——
    // 上一版 share>0.62 就升主干，结果一条主街被切成 8 段、还多出 3 条"主干"。
    const share = (polyLen(chord) * 7) / diagM;
    const cls: RoadClass3 =
      depth === 0 ? 'arterial' : depth === 1 || share > 0.66 ? 'collector' : 'local';

    raws.push({
      id: `gf${raws.length}`,
      pts: [new Pt(chord[0].x, chord[0].y), new Pt(chord[chord.length - 1].x, chord[chord.length - 1].y)],
      cls,
      from: depth === 0 ? 'spine' : 'grid',
    });

    if (typeof process !== 'undefined' && process.env?.F3_GROW) {
      console.log(
        `[cut] depth ${depth} face ${M2(surfaceArea(face.poly)).toFixed(0)} m² → ${areaA.toFixed(0)} + ${areaB.toFixed(0)} · chord ${(polyLen(chord) * 7).toFixed(0)} m · ang ${((ang * 180) / Math.PI).toFixed(0)}°`
      );
    }
    // 两侧成为新面
    replaceFace(face, a, b, depth + 1);
    return true;
  }

  /**
   * 这条弦与已有道路里**近乎平行**的那条之间的最小间距（米）以及对方在弦的哪一侧。
   *
   * 只看弦的中段（两端 1/6 让开）：弦端必然落在已有路上，量端点等于永远"贴住"。
   */
  function nearestParallel(chord: Pt[], ang: number): { gapM: number; signed: number } {
    const a = chord[0];
    const b = chord[chord.length - 1];
    const ux = Math.cos(ang);
    const uy = Math.sin(ang);
    const nx = -uy;
    const ny = ux;
    let best = Infinity;
    let signed = 0;
    for (const r of raws) {
      for (let i = 0; i + 1 < r.pts.length; i++) {
        const p = r.pts[i];
        const q = r.pts[i + 1];
        const ex = q.x - p.x;
        const ey = q.y - p.y;
        const el = Math.hypot(ex, ey) || 1;
        if (Math.abs((ux * ey - uy * ex) / el) > PARALLEL_SIN) continue;
        for (let k = 1; k <= 5; k++) {
          const t = k / 6;
          const sx = a.x + (b.x - a.x) * t;
          const sy = a.y + (b.y - a.y) * t;
          const d = ptSegDist(sx, sy, p, q);
          if (d < best) {
            best = d;
            signed = (sx - p.x) * nx + (sy - p.y) * ny;
          }
        }
      }
    }
    return { gapM: best * 7, signed };
  }

  function replaceFace(face: { poly: PlanSurface; depth: number; ring: Pt[] }, a: PlanSurface[], b: PlanSurface[], depth: number): void {
    const idx = faces.indexOf(face as never);
    const add = (list: PlanSurface[]): void => {
      for (const q of list) {
        if (M2(surfaceArea(q)) < 80) continue;
        faces.push({ poly: q, depth, ring: cleanRing(q.outer) });
      }
    };
    if (idx >= 0) faces.splice(idx, 1);
    add(a);
    add(b);
  }

  function wideEnough(s: PlanSurface, minM: number): boolean {
    const ob = obbOf(s.outer);
    if (!ob) return false;
    const shortM = Math.min(ob.w, ob.d) * 7;
    return shortM >= minM;
  }
}

/** 点到线段距离 */
function ptSegDist(px: number, py: number, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-12) return Math.hypot(px - a.x, py - a.y);
  let t = ((px - a.x) * dx + (py - a.y) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a.x + dx * t), py - (a.y + dy * t));
}

/**
 * 端点吸附：把每条路的端点拉到 1.5 m 内最近的那条路上。
 *
 * 只端点、不动中间点：中间点跑了会把路扯弯，端点跑 1.5 m 看不出来，
 * 但足以让 T 口成立。
 */
export function snapEnds(raws: RawRoad[], snapU: number): RawRoad[] {
  return raws.map((r) => {
    const pts = r.pts.map((p) => new Pt(p.x, p.y));
    for (const end of [0, pts.length - 1]) {
      const p = pts[end];
      let best = snapU;
      let target: Pt | null = null;
      for (const other of raws) {
        if (other === r) continue;
        for (let i = 0; i + 1 < other.pts.length; i++) {
          const a = other.pts[i];
          const b = other.pts[i + 1];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const l2 = dx * dx + dy * dy;
          if (l2 < 1e-12) continue;
          let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
          t = Math.max(0, Math.min(1, t));
          const q = new Pt(a.x + dx * t, a.y + dy * t);
          const d = Pt.distance(p, q);
          if (d < best) {
            best = d;
            target = q;
          }
        }
      }
      /**
       * 只在"端点确实浮着"时才吸（> 5 cm）。
       *
       * 无条件吸会把本来已经贴在某条路上的端点，吸到旁边另一条更近的路上，
       * 于是原来那个 T 口反而断了 —— 实测断头从 0 根涨到 55 根。
       */
      if (target && best > 0.007) pts[end] = target;
    }
    return { ...r, pts };
  });
}

/** 用一条无限直线切面（返回两侧，各自可能是多块） */
function splitByLine(s: PlanSurface, at: Pt, ang: number): { a: PlanSurface[]; b: PlanSurface[] } | null {
  const ux = Math.cos(ang);
  const uy = Math.sin(ang);
  const nx = -uy;
  const ny = ux;
  const R = 400;
  /**
   * 两侧的半平面要**互相重叠** 2e-4，而不是各自退开。
   *
   * 退开的话，两个面之间会留一条 2e-4 宽的缝：后半刀裁到面边界上的点，
   * 与前半刀的中心线差 1e-4，超过了交点判据的容差 —— 于是 T 口全部丢失，
   * 80 条街变成 160 个孤立端点、0 个路口（实测）。
   * 重叠只会让两块面各多 1e-4 宽的一条，面积误差 < 0.1 m²。
   */
  const half = (sign: number): PlanSurface => {
    const ox = at.x - nx * sign * 2e-4;
    const oy = at.y - ny * sign * 2e-4;
    const tx = ux * R;
    const ty = uy * R;
    const sx = nx * sign * R;
    const sy = ny * sign * R;
    return {
      outer: [
        new Pt(ox - tx, oy - ty),
        new Pt(ox + tx, oy + ty),
        new Pt(ox + tx + sx, oy + ty + sy),
        new Pt(ox - tx + sx, oy - ty + sy),
      ],
      holes: [],
    };
  };
  try {
    const A = surfaceIntersect([s], [half(1)]).filter((q) => M2(surfaceArea(q)) > 1);
    const B = surfaceIntersect([s], [half(-1)]).filter((q) => M2(surfaceArea(q)) > 1);
    if (A.length === 0 || B.length === 0) return null;
    return { a: A, b: B };
  } catch {
    return null;
  }
}

void insideSurface;
void U;
void cityField;
