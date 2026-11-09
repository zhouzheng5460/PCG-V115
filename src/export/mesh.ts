// 网格基元：把 2D 要素变成 3D 三角形。
//
// 坐标系固定：地图 (x, y) → 3D (x, 0, y)，高度沿 +Y。
// 这样从上方俯视和 2D 编辑器完全一致，导进 DCC 也不用转轴。
//
// 手性提醒（踩过坑）：earcut 对 CCW 输入输出 CCW 三角形，映射到 XZ 平面后
// 外法线朝 −Y，所以索引必须两两交换；侧面顶点的顺序同理必须是
// a_bot → b_top → b_bot。

import earcut from 'earcut';
import * as poly2tri from 'poly2tri';
import polygonClipping from 'polygon-clipping';
import { Pt } from '../core/geom';

export interface Primitive {
  name: string;
  group: string;
  positions: number[];
  normals: number[];
  indices: number[];
  /** sRGB 0~1 */
  color: [number, number, number];
  doubleSided?: boolean;
  /**
   * 导出到 GLB 时的**目录层级**（不含自身名字）。
   * 例如 `['街区','B12','建筑']` → `城市/街区/B12/建筑/<mesh>`。
   */
  path?: string[];
}

/**
 * 退化三角形阈值（面积的一半，世界单位²）。
 *
 * earcut 在近共线的三个点上会吐出零面积三角形 —— 渲染上什么都不画，
 * 但它的面法线是零向量，绕序自检 `dot <= 0` 会判成翻转。
 * 一条 5 km 的中心线被切成 5000 段虚线时，这种三角一两块是常态，
 * 与其放宽断言，不如在这里就不产出无用的三角形。
 */
const DEGEN_AREA2 = 1e-9;

/**
 * 三角化一个面（可选洞）。
 *
 * PRD §3 P0：earcut 的 `holeIndices` 必须真正用上 —— 原来写死 `undefined`，
 * 洞环只能被丢掉，中庭 / 环路 / 停车岛在 3D 里永远是实心。
 * 顶点按 [外环…, 洞1…, 洞2…] 拼接，holeIndices 记录每个洞的起始索引。
 */
interface SweepContextLike {
  addHole(polyline: { x: number; y: number }[]): SweepContextLike;
  triangulate(): SweepContextLike;
  getTriangles(): { getPoint(i: number): { x: number; y: number } }[];
}

/** 点的坐标键：微米级。collapseRing 已保证相邻点间距 > 0.7 mm，所以不会撞。 */
function ptKey(p: { x: number; y: number }): string {
  return `${Math.round(p.x * 1e6)}|${Math.round(p.y * 1e6)}`;
}

/**
 * 约束 Delaunay 三角化（poly2tri）。失败返回 null，由 earcut 兜底。
 *
 * 为什么需要：earcut 是耳切法，遇到「一条长直边对一串密集弧点」（我们的路网面
 * 到处都是：直边几十米 + 转角 6 段圆弧）会沿环拉出窄三角扇 —— 单三角形面积
 * 接近 0、法线相同，3D 里就是路面上细长的明暗条纹。
 * CDT 会**最大化最小角**，同样的环切出来接近等边，这是 three-roads 用它的原因
 * （也正因为如此，那套"按长度均分长边"的采样平衡只有配 CDT 才有意义）。
 *
 * poly2tri 的要求在这里都已满足：环不自交、无重复点（`collapseRing` + `healRing`），
 * 外环 CCW、洞 CW（下面按需反转）。它遇到病态输入会抛 PointError，直接兜底。
 */
function triangulateCDT(ring: Pt[], holes: Pt[][]): number[] | null {
  if (ring.length < 3) return null;
  try {
    /**
     * 索引必须**严格等于** `flatPolygon` 里 positions 的顺序：外环在前、
     * 洞依次跟上（**原始顺序**，不是反转后的顺序）。
     *
     * 踩过的坑：这里曾经用 `next++` 给"反转后的洞点"顺次编号，而 flat 里的
     * 洞点仍是原始顺序 —— 于是洞内第 0 个点被映射成了洞内最后一个点。
     * 三角形顶点被整体错位，切出来的就是**横跨街区的大三角**：俯视看是
     * 转角上的尖刺，3D 看是路面上一块缺失/发黑的补丁（用户三张截图）。
     * 外环没有洞时编号恰好一致，所以只有"带洞的面"才出问题 ——
     * 也正好只有街区内侧那些环带（人行道 / 路缘 / 道路用地）带洞。
     */
    const index = new Map<string, number>();
    let next = 0;
    for (const p of ring) {
      const k = ptKey(p);
      if (!index.has(k)) index.set(k, next);
      next++;
    }
    const holeInput: { x: number; y: number }[][] = [];
    for (const h of holes) {
      if (h.length < 3) continue;
      for (const p of h) {
        const k = ptKey(p);
        if (!index.has(k)) index.set(k, next);
        next++;
      }
      // poly2tri 习惯：外环逆时针、洞顺时针（只是喂给它的绕向，索引照旧）
      holeInput.push(h.slice().reverse().map((p) => ({ x: p.x, y: p.y })));
    }
    /**
     * 用**命名空间导入**而不是 `import { SweepContext }`：poly2tri 是 UMD 包，
     * vite 的 CJS 互操作对它的具名导出识别不稳，具名导入在浏览器里会直接
     * `undefined` —— 整个 mesh 模块连带挂掉，3D 一片全黑。
     */
    const Ctx = (poly2tri as unknown as { SweepContext: new (c: { x: number; y: number }[]) => SweepContextLike })
      .SweepContext;
    if (!Ctx) return null;
    const ctx = new Ctx(ring.map((p) => ({ x: p.x, y: p.y })));
    for (const h of holeInput) ctx.addHole(h);
    ctx.triangulate();
    const out: number[] = [];
    for (const t of ctx.getTriangles()) {
      const a = index.get(ptKey(t.getPoint(0)));
      const b = index.get(ptKey(t.getPoint(1)));
      const c = index.get(ptKey(t.getPoint(2)));
      if (a === undefined || b === undefined || c === undefined) continue;
      if (a === b || b === c || a === c) continue;
      out.push(a, b, c);
    }
    return out.length >= 3 ? out : null;
  } catch {
    return null;
  }
}

/**
 * 三角化：CDT 优先，earcut 兜底。
 *
 * 两者的三角形绕序不同，统一按「面积符号」校正成与输入环一致的 CCW 正面，
 * 否则一半三角形背面朝上，3D 里会出现"斑驳"的路面。
 */
export function triangulate(ring: Pt[], holes: Pt[][] = []): number[] {
  if (ring.length < 3) return [];
  const flat: number[] = [];
  for (const p of ring) flat.push(p.x, p.y);
  const holeIndices: number[] = [];
  for (const h of holes) {
    if (h.length < 3) continue;
    holeIndices.push(flat.length / 2);
    for (const p of h) flat.push(p.x, p.y);
  }

  const fromCDT = triangulateCDT(ring, holes);
  const idx = fromCDT ?? earcut(flat, holeIndices.length > 0 ? holeIndices : undefined, 2);

  const out: number[] = [];
  for (let i = 0; i < idx.length; i += 3) {
    // 绕序：**保持历史口径 `(i, i+2, i+1)`**。
    // three.js 里平面的正向是 +y，而 (x, z) 与屏幕坐标的 y 轴相反，
    // 所以数学意义上的逆时针在这里要反着给。earcut 与 poly2tri 输出的
    // 绕序一致（都是数学 CCW），这一套对两者都成立；改成"按面积符号校正"
    // 会让所有朝上的面变成背面被剔除 —— 3D 直接全黑。
    const a = idx[i];
    const b = idx[i + 2];
    const c = idx[i + 1];
    const ax = flat[a * 2];
    const ay = flat[a * 2 + 1];
    const area2 = (flat[b * 2] - ax) * (flat[c * 2 + 1] - ay) - (flat[c * 2] - ax) * (flat[b * 2 + 1] - ay);
    if (Math.abs(area2) <= DEGEN_AREA2) continue;
    out.push(a, b, c);
  }
  return out;
}

export function ensureCCW(ring: Pt[]): Pt[] {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s < 0 ? ring.slice().reverse() : ring;
}

function dedupeRing(ring: Pt[]): Pt[] {
  return ring.filter((p, i, arr) => i === 0 || Pt.distance(p, arr[i - 1]) > 1e-6);
}

/** 贴地平面多边形 */
/**
 * 环是否自交（O(n²)，n 一般 < 12，代价可以忽略）。
 *
 * 自交环交给 earcut 会吐出**跨到多边形外的三角形** —— 俯视图和三维里
 * 就是地面上伸出去的细长"尖刺"。这跟相机近平面裁剪无关：正交俯视、
 * 透视视图里都长一样，因为它本来就是几何错误。
 */
function selfIntersects(r: Pt[]): boolean {
  const n = r.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    const a = r[i];
    const b = r[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = r[j];
      const d = r[(j + 1) % n];
      const d1 = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      const d2 = (b.x - a.x) * (d.y - a.y) - (b.y - a.y) * (d.x - a.x);
      const d3 = (d.x - c.x) * (a.y - c.y) - (d.y - c.y) * (a.x - c.x);
      const d4 = (d.x - c.x) * (b.y - c.y) - (d.y - c.y) * (b.x - c.x);
      if (d1 * d2 < 0 && d3 * d4 < 0) return true;
    }
  }
  return false;
}

/**
 * 自交环 → 用布尔并集规范化成简单环（可能返回多块，取最大的）。
 * 布尔库对单个自交环做 union 等价于"抹掉自交形成的重叠区"，结果边数可能变化。
 */
function healRing(r: Pt[]): Pt[] | null {
  try {
    const res = polygonClipping.union([r.map((p) => [p.x, p.y])] as never) as unknown as number[][][][];
    let best: Pt[] | null = null;
    let bestA = 0;
    for (const poly of res) {
      const ring = poly[0];
      if (!ring) continue;
      const pts = ring.map((q) => new Pt(q[0], q[1]));
      const a = Math.abs(pts.reduce((acc, p, i) => {
        const n2 = pts[(i + 1) % pts.length];
        return acc + p.x * n2.y - n2.x * p.y;
      }, 0) / 2);
      if (a > bestA) {
        bestA = a;
        best = pts;
      }
    }
    return best;
  } catch {
    return null;
  }
}

/**
 * 三角化前的**环采样平衡**（借鉴 three-roads 的 junction ring sampling）。
 *
 * 【当前未启用 —— 实测在我们的 earcut 上无效，见下】
 * three-roads 用它 + CDT 三角化来消除「长边对一串短边」的窄三角扇；我们这边
 * 换成 earcut 之后，插进去的共线中点反而给耳切提供了更多"一端长、一端短"的
 * 候选：实测细长三角占比 41.4% → 67.1%，更差。
 * 这个函数留着是因为一旦换成 CDT（three-roads 的 packages/cdt），它是必需的。
 * 现在的替代方案是下面的 `collapseRing`（只做减法）。
 *
 * 布尔并集出来的环，常见形态是「一侧是几十米的长直边，另一侧是每 0.5 m 一个
 * 采样点的圆弧」—— 比如一条街的人行道面：直边 120 m、转角圆弧 6 段。
 * earcut 只能沿这种环拉出「一条长边对一串短边」的窄三角扇：单个三角形面积
 * 接近 0、法线却完全相同，于是 3D 里路面会出现**细长的明暗条纹**，远处还会
 * 闪成锯齿。
 *
 * 处理方式：把长边按 `maxLen` 均分，让相邻边的采样密度接近。
 * 分配用**最大余数法**（three-roads 同一套）：先按长度比例给预算，余数按小数
 * 部分从大到小补 —— 同一份预算下长边不会被饿死，短边也不会被过度细分。
 *
 * 只在边上插中点，**不改变形状**（点都落在原线段上），所以对几何是零风险。
 */
export function balanceRing(ring: Pt[], maxLen: number, budget = 192): Pt[] {
  const n = ring.length;
  if (n < 3 || maxLen <= 1e-6) return ring;
  const len: number[] = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    len.push(L);
    total += L;
  }
  if (total < 1e-9) return ring;
  const want = len.map((L) => Math.max(1, Math.min(64, Math.ceil(L / maxLen))));
  const desired = want.reduce((a, b) => a + b, 0) - n;
  const avail = Math.max(0, budget - n);
  if (desired <= 0) return ring;
  const seg = want.slice();
  if (desired > avail) {
    for (let i = 0; i < n; i++) {
      seg[i] = 1 + Math.floor(((want[i] - 1) * avail) / desired);
    }
    let left = avail - seg.reduce((a, b) => a + b - 1, 0);
    const order = len
      .map((_L, i) => ({ i, rem: ((want[i] - 1) * avail) / desired - (seg[i] - 1) }))
      .sort((x, y) => y.rem - x.rem || x.i - y.i);
    let k = 0;
    while (left > 0 && k < order.length * 66) {
      const o = order[k % order.length];
      if (seg[o.i] - 1 < want[o.i] - 1) {
        seg[o.i]++;
        left--;
      }
      k++;
    }
  }
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    out.push(a);
    for (let k = 1; k < seg[i]; k++) {
      const t = k / seg[i];
      out.push(new Pt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t));
    }
  }
  return out;
}

/**
 * 三角化前的**环塌缩**：去掉近重合点与共线点。
 *
 * 这是「细长三角」的真正解药，不是采样平衡。
 *
 * earcut 是耳切法：它靠"凸点 + 不含其他点"找耳，对**共线点**和**间距 1e-5 的
 * 点**极其敏感 —— 三个共线点会被切成面积 ~1e-12 的针，法线仍算 (0,1,0)，
 * 于是 3D 里就是路面上一条细到看不见、却会在远处闪的高光/暗线；
 * 而在带洞的多边形里，这种针还会让 earcut 把耳找到洞的另一侧。
 *
 * （试过 three-roads 那套"按长度均分长边"的采样平衡：在他们的 CDT 下有效，
 *  在我们的 earcut 下反而把细长三角从 41% 提到 67% —— 因为插入的共线中点
 *  给耳切提供了更多"一端长、一端短"的候选。所以这里只做减法。）
 *
 * 容差 1e-4 世界单位 = 0.7 mm：远低于任何可见尺度，但足够吃掉布尔输出的毛刺。
 */
function collapseRing(ring: Pt[], eps = 1e-4): Pt[] {
  let cur = ring.slice();
  for (let pass = 0; pass < 4; pass++) {
    const n = cur.length;
    if (n < 3) return cur;
    const out: Pt[] = [];
    let removed = 0;
    for (let i = 0; i < n; i++) {
      const prev = out.length ? out[out.length - 1] : cur[n - 1];
      const p = cur[i];
      if (Pt.distance(prev, p) <= eps) {
        removed++;
        continue;
      }
      out.push(p);
    }
    cur = out.length >= 3 ? out : cur;
    // 共线：点 i 到 (i-1, i+1) 连线的距离 <= eps 且落在中间
    const m = cur.length;
    const keep: Pt[] = [];
    for (let i = 0; i < m; i++) {
      const a = cur[(i - 1 + m) % m];
      const b = cur[i];
      const c = cur[(i + 1) % m];
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const acx = c.x - a.x;
      const acy = c.y - a.y;
      const L = Math.hypot(acx, acy);
      if (L > 1e-9) {
        const dist = Math.abs(abx * acy - aby * acx) / L;
        const dot = abx * acx + aby * acy;
        if (dist <= eps && dot > 0 && dot < L * L) {
          removed++;
          continue;
        }
      }
      keep.push(b);
    }
    if (keep.length >= 3) cur = keep;
    if (removed === 0) break;
  }
  return cur;
}

/** 采样平衡的默认粒度（世界单位）：5 m ≈ 一个路缘石的尺度 */
export const BALANCE_MAX_LEN = 5 / 7;

export function flatPolygon(
  ring: Pt[],
  y: number,
  name: string,
  group: string,
  color: [number, number, number],
  holes: Pt[][] = []
): Primitive | null {
  let clean = ensureCCW(collapseRing(dedupeRing(ring)));
  if (clean.length < 3) return null;
  // 自交兜底：earcut 对自交环会吐出跨到多边形外的三角形（地面上的"尖刺"）
  if (selfIntersects(clean)) {
    const healed = healRing(clean);
    if (!healed) return null;
    clean = ensureCCW(collapseRing(dedupeRing(healed)));
    if (clean.length < 3 || selfIntersects(clean)) return null;
  }
  // 洞也要过同样的自交 / 去重处理，否则三角化会跨洞画出"盖住中庭"的三角形
  const cleanHoles: Pt[][] = [];
  for (const h of holes) {
    let hh = ensureCCW(collapseRing(dedupeRing(h)));
    if (hh.length < 3) continue;
    if (selfIntersects(hh)) {
      const healed = healRing(hh);
      if (!healed) continue;
      hh = ensureCCW(collapseRing(dedupeRing(healed)));
      if (hh.length < 3 || selfIntersects(hh)) continue;
    }
    cleanHoles.push(hh);
  }


  const idx = triangulate(clean, cleanHoles);
  if (idx.length === 0) return null;

  const positions: number[] = [];
  const normals: number[] = [];
  for (const p of clean) {
    positions.push(p.x, y, p.y);
    normals.push(0, 1, 0);
  }
  for (const h of cleanHoles) {
    for (const p of h) {
      positions.push(p.x, y, p.y);
      normals.push(0, 1, 0);
    }
  }
  return { name, group, positions, normals, indices: idx, color };
}

/** 挤出体块：顶面与侧面分成两个图元，便于分别换材质 */
export function extrudeSolid(
  ring: Pt[],
  y0: number,
  height: number,
  name: string,
  group: string,
  roofColor: [number, number, number],
  wallColor: [number, number, number],
  noRoof = false
): Primitive[] {
  const clean = ensureCCW(dedupeRing(ring));
  if (clean.length < 3 || height <= 1e-6) return [];
  const top = triangulate(clean);
  if (top.length === 0) return [];

  const n = clean.length;
  const out: Primitive[] = [];

  if (!noRoof) {
    const topPos: number[] = [];
    const topNrm: number[] = [];
    for (const p of clean) {
      topPos.push(p.x, y0 + height, p.y);
      topNrm.push(0, 1, 0);
    }
    out.push({ name: `${name}_roof`, group, positions: topPos, normals: topNrm, indices: top.slice(), color: roofColor });
  }

  const pos: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = clean[i];
    const b = clean[(i + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    const nx = dy / len;
    const ny = -dx / len;

    const base = pos.length / 3;
    pos.push(a.x, y0, a.y, b.x, y0, b.y, b.x, y0 + height, b.y, a.x, y0 + height, a.y);
    for (let k = 0; k < 4; k++) normals.push(nx, 0, ny);
    indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }

  if (indices.length > 0) out.push({ name: `${name}_wall`, group, positions: pos, normals, indices, color: wallColor });
  return out;
}

/** 圆柱（灯杆、树干、水塔） */
export function cylinder(
  c: Pt,
  r: number,
  y0: number,
  h: number,
  name: string,
  group: string,
  color: [number, number, number],
  seg = 8
): Primitive {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i <= seg; i++) {
    const ang = (i / seg) * Math.PI * 2;
    const nx = Math.cos(ang);
    const ny = Math.sin(ang);
    positions.push(c.x + nx * r, y0, c.y + ny * r);
    normals.push(nx, 0, ny);
    positions.push(c.x + nx * r, y0 + h, c.y + ny * r);
    normals.push(nx, 0, ny);
  }
  for (let i = 0; i < seg; i++) {
    const a = i * 2;
    indices.push(a, a + 3, a + 2, a, a + 1, a + 3);
  }

  const centerIdx = positions.length / 3;
  positions.push(c.x, y0 + h, c.y);
  normals.push(0, 1, 0);
  for (let i = 0; i <= seg; i++) {
    const ang = (i / seg) * Math.PI * 2;
    positions.push(c.x + Math.cos(ang) * r, y0 + h, c.y + Math.sin(ang) * r);
    normals.push(0, 1, 0);
  }
  for (let i = 0; i < seg; i++) indices.push(centerIdx, centerIdx + i + 2, centerIdx + i + 1);

  return { name, group, positions, normals, indices, color };
}

/** 圆锥（树冠、塔顶）。tipUp=false 时锥尖朝下，做双层树冠的第二层 */
export function cone(
  c: Pt,
  r: number,
  y0: number,
  h: number,
  name: string,
  group: string,
  color: [number, number, number],
  seg = 6,
  tipUp = true
): Primitive {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  const apexY = tipUp ? y0 + h : y0;
  const baseY = tipUp ? y0 : y0 + h;
  const apex = positions.length / 3;
  positions.push(c.x, apexY, c.y);
  normals.push(0, tipUp ? 1 : -1, 0);

  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2;
    const a1 = ((i + 1) / seg) * Math.PI * 2;
    const p0 = new Pt(c.x + Math.cos(a0) * r, c.y + Math.sin(a0) * r);
    const p1 = new Pt(c.x + Math.cos(a1) * r, c.y + Math.sin(a1) * r);

    // 侧面法线：水平方向取两点平均外法线，竖直分量 = 锥面斜率 r/h。
    // 尖朝上时法线朝外上方（+Y），尖朝下时朝外下方。
    const mx = (Math.cos(a0) + Math.cos(a1)) / 2;
    const my = (Math.sin(a0) + Math.sin(a1)) / 2;
    const ml = Math.hypot(mx, my) || 1;
    const slope = r / Math.max(h, 1e-6);
    const nx = mx / ml;
    const ny = my / ml;
    const up = tipUp ? slope : -slope;
    const nl = Math.hypot(nx, up, ny) || 1;

    const base = positions.length / 3;
    positions.push(p0.x, baseY, p0.y, p1.x, baseY, p1.y);
    normals.push(nx / nl, up / nl, ny / nl, nx / nl, up / nl, ny / nl);

    // 手性：XZ 平面上角度增大是顺时针，所以 (apex, p1, p0) 才是外向
    if (tipUp) indices.push(apex, base + 1, base);
    else indices.push(apex, base, base + 1);
  }

  return { name, group, positions, normals, indices, color };
}

/** 轴对齐（可绕 Y 旋转）长方体 */
export function box(
  c: Pt,
  w: number,
  d: number,
  y0: number,
  h: number,
  rot: number,
  name: string,
  group: string,
  color: [number, number, number],
  roofColor?: [number, number, number]
): Primitive[] {
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const cs: Pt[] = [
    new Pt(-w / 2, -d / 2),
    new Pt(w / 2, -d / 2),
    new Pt(w / 2, d / 2),
    new Pt(-w / 2, d / 2),
  ];
  const ring = cs.map((p) => new Pt(c.x + p.x * cos - p.y * sin, c.y + p.x * sin + p.y * cos));
  return extrudeSolid(ring, y0, h, name, group, roofColor ?? color, color);
}

/**
 * 沿折线生成有厚度的墙体。
 * 不能把整圈当成一个环带去三角化 —— 闭合环带是自交的，earcut 会吐出
 * 横穿全图的大三角形。这里按段生成再合并，两端各延长一点防裂缝。
 */
export function wallSolid(
  path: Pt[],
  thickness: number,
  y0: number,
  h: number,
  name: string,
  group: string,
  color: [number, number, number],
  closed = true
): Primitive | null {
  const pos: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];
  const hw = thickness / 2;

  const appendBox = (ring: Pt[]) => {
    const clean = ensureCCW(ring);
    if (clean.length < 3) return;
    const topIdx = triangulate(clean);
    if (topIdx.length === 0) return;

    const topBase = pos.length / 3;
    for (const p of clean) {
      pos.push(p.x, y0 + h, p.y);
      nrm.push(0, 1, 0);
    }
    for (const i of topIdx) idx.push(topBase + i);

    const n = clean.length;
    for (let i = 0; i < n; i++) {
      const a = clean[i];
      const b = clean[(i + 1) % n];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) continue;
      const nx = dy / len;
      const ny = -dx / len;
      const base = pos.length / 3;
      pos.push(a.x, y0, a.y, b.x, y0, b.y, b.x, y0 + h, b.y, a.x, y0 + h, a.y);
      for (let k = 0; k < 4; k++) nrm.push(nx, 0, ny);
      idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }
  };

  const last = closed ? path.length : path.length - 1;
  for (let i = 0; i < last; i++) {
    const a = path[i];
    const b = path[(i + 1) % path.length];
    const d = b.subtract(a);
    const len = d.length;
    if (len < 1e-6) continue;
    const nx = -d.y / len;
    const ny = d.x / len;
    const ext = d.norm(hw * 0.7);
    const a2 = a.subtract(ext);
    const b2 = b.add(ext);

    appendBox([
      new Pt(a2.x + nx * hw, a2.y + ny * hw),
      new Pt(b2.x + nx * hw, b2.y + ny * hw),
      new Pt(b2.x - nx * hw, b2.y - ny * hw),
      new Pt(a2.x - nx * hw, a2.y - ny * hw),
    ]);
  }

  if (idx.length === 0) return null;
  return { name, group, positions: pos, normals: nrm, indices: idx, color };
}

/** 合并多个图元（减少 draw call / 节点数） */
export function mergePrimitives(prims: Primitive[], name: string, group: string): Primitive | null {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  let color: [number, number, number] = [0.7, 0.7, 0.7];
  for (const p of prims) {
    const base = positions.length / 3;
    positions.push(...p.positions);
    normals.push(...p.normals);
    for (const i of p.indices) indices.push(base + i);
    color = p.color;
  }
  if (indices.length === 0) return null;
  return { name, group, positions, normals, indices, color };
}
