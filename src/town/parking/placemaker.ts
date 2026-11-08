// Placemaker Provider · C# Core 的 JSON 桥
//
// ## 这条链是怎么来的
//
// 旧项目 `PCG-CITYSKYLINE/placemaker-core-lib` 已经把 Placemaker 的 465 个 Core 文件
// 从 CS2 的 ECS 环境里抽成纯 .NET 6 类库，并且带一个 `--emit <case.json> <plan.json>` 驱动器。
// 本轮**不重新翻译 C#**，只做三件事：
//   ① 把 TownForge 的 ParkingRequest（世界单位）写成它认识的 case JSON（米）
//   ② 调本地 dotnet 跑一次
//   ③ 把 plan JSON 转回 `ParkLayout`（世界单位），让现有 Realizer 原样消费
//
// ## 为什么必须先摸清它的真实输出，而不是照 README 写
//
// 实测（`cases/parking-150x100.json`，150×100 m 矩形，seed 1234）：
//   · `stats[Stat.Stalls]=313`，但 `objects[parkingBay]` 也是 313；
//     加上障碍物之后 `stats` 仍是 313 而 `objects` 只剩 248 —— **stats 是生成量不是存活量**，
//     所以车位数必须数 objects，不能读 stats。这条差点让 A/B 数字错得理所当然。
//   · `nets[].a/b/c/d` 是中心线被切成三段，**相邻车道共享端点**（[39,10.4] 同现于两段）。
//     所以车道拓扑只能靠端点配对重建，`startAttach/endAttach` 实测恒为 -1。
//   · `obstacles` 是**定向四边形**（A/B/C/D），不是环上的洞；处理方式是
//     `SiteSafety.Apply` 事后裁剪（日志会写"丢 134 条 / 裁 13 环"）。
//     因此 S1 必须先交出**不含建筑的合法 ParkingZone**，不能指望它自己避让。
//   · `surfaces` 只有 `asphalt` / `grass` 两类；`grass` 就是车道之间的景观岛。
//     没有标记线几何，标记只能从 `objects[parkingBay]` 反推。

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pt } from '../../core/geom';
import type { ParkLayout } from '../parking';

/** 1 世界单位 = 7 m。Placemaker 全程用米 */
const M = 7;

// ---------------------------------------------------------------- 输入

export interface PmObstacle {
  /** 四边形（世界单位），Core 的 Obstacle 就是 A/B/C/D 四个点 */
  quad: [Pt, Pt, Pt, Pt];
  kind?: string;
}

export interface PmInput {
  /** 停车区环（世界单位） */
  ring: Pt[];
  /** 障碍（建筑底面）。**每块必须是四边形**，多边形要在调用侧先拆开 */
  obstacles?: PmObstacle[];
  /** 相邻城市道路：一段线段 + 宽度（世界单位） */
  streets?: { a: Pt; b: Pt; widthM: number; sidewalk?: boolean; speed?: number }[];
  seed: number;
  aisleM?: number;
  stallWM?: number;
  stallLM?: number;
  /**
   * Core 的「周边环路」开关。默认 true —— 它会在停车区里先绕一圈路，
   * 顺带吃掉 6~7 m 进深。**窄带地块上这一圈等于让停车减半**（实测 18 m 宽带
   * 从 15 位变 29 位），所以在有效宽度 < 24 m 时关掉它。
   */
  perimeterRoad?: boolean;
  angleDeg?: 45 | 60 | 90;
}

/** 换算到 Placemaker 的局部米坐标系（原点取环的 bbox 角，数值小、好读日志） */
export function pmOrigin(ring: Pt[]): Pt {
  let x = Infinity;
  let y = Infinity;
  for (const p of ring) {
    if (p.x < x) x = p.x;
    if (p.y < y) y = p.y;
  }
  return new Pt(x, y);
}

const toM = (p: Pt, o: Pt): [number, number] => [+(( p.x - o.x) * M).toFixed(3), +((p.y - o.y) * M).toFixed(3)];
const toU = (x: number, z: number, o: Pt): Pt => new Pt(o.x + x / M, o.y + z / M);

export function buildCaseJson(q: PmInput, o: Pt): Record<string, unknown> {
  const settings: Record<string, unknown> = {
    // 车道 7 m 是 CS2 "Invisible Road Path 2xTwoway" 的实测可行驶宽度，
    // 也是 Placemaker 的 DefaultAisle。这里显式写出来，免得以后默认值变了 A/B 不可比。
    aisleWidth: q.aisleM ?? 7,
    stallWidth: q.stallWM ?? 3,
    stallLength: q.stallLM ?? 5.9,
  };
  if (q.angleDeg) settings.stallAngle = String(q.angleDeg);
  if (q.perimeterRoad !== undefined) settings.perimeterRoad = q.perimeterRoad;
  return {
    generator: 'parking',
    seed: q.seed,
    shape: { ring: q.ring.map((p) => toM(p, o)) },
    streets: (q.streets ?? []).map((s, i) => ({
      id: 9000 + i,
      a: toM(s.a, o),
      b: toM(s.b, o),
      width: s.widthM,
      sidewalk: s.sidewalk ?? true,
      speed: s.speed ?? 50,
    })),
    obstacles: (q.obstacles ?? []).map((ob) => ({
      kind: ob.kind ?? 'building',
      quad: ob.quad.map((p) => toM(p, o)),
    })),
    settings,
  };
}

// ---------------------------------------------------------------- 运行

export interface PmRunResult {
  ok: boolean;
  plan: PmPlan | null;
  ms: number;
  log: string;
  error?: string;
}

/** 默认驱动器位置（仓库内自带一份编译产物） */
export function defaultDriver(): string {
  return process.env.PLACEMAKER_DRIVER ?? 'tools/placemaker/bin/PlacemakerDriver.dll';
}

/**
 * 跑一次 Placemaker。
 *
 * 用 `execFileSync` 直接调 dotnet：离线、无服务、一次一进程（实测冷启动 ~90 ms，
 * 求解本身 16~21 ms）。等真的需要常驻再换 IPC —— 现在没必要。
 */
export function runPlacemaker(q: PmInput, opts: { driver?: string; timeoutMs?: number } = {}): PmRunResult {
  const o = pmOrigin(q.ring);
  const dir = mkdtempSync(join(tmpdir(), 'pm-'));
  const casePath = join(dir, 'case.json');
  const outPath = join(dir, 'plan.json');
  writeFileSync(casePath, JSON.stringify(buildCaseJson(q, o)), 'utf8');
  const driver = opts.driver ?? defaultDriver();
  const t0 = Date.now();
  try {
    const log = execFileSync('dotnet', [driver, '--emit', casePath, outPath], {
      encoding: 'utf8',
      timeout: opts.timeoutMs ?? 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const plan = JSON.parse(readFileSync(outPath, 'utf8')) as PmPlan;
    return { ok: true, plan, ms: Date.now() - t0, log };
  } catch (e) {
    return { ok: false, plan: null, ms: Date.now() - t0, log: '', error: String(e).slice(0, 400) };
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 临时目录删不掉不影响结果 */
    }
  }
}

// ---------------------------------------------------------------- 输出类型

export interface PmPlan {
  protocol: string;
  generator: string;
  units: string;
  seed: number;
  area: unknown;
  ready: boolean;
  elapsedMs: number;
  surfaces: { role: string; y?: number; ring: [number, number][] }[];
  nets: { role: string; a: [number, number]; b: [number, number]; c: [number, number]; d: [number, number]; startAttach?: number; endAttach?: number }[];
  objects: { role: string; x: number; z: number; yaw?: number; scale?: number }[];
  areas: { role?: string; ring: [number, number][] }[];
  regions: unknown[];
  stats: { key: string; value: number; unit: string }[];
  facts: Record<string, unknown>;
  issues: unknown[];
  unknownRoles?: string[];
}

// ---------------------------------------------------------------- 转换

export interface PmDiag {
  /** 车位数（**数 objects，不读 stats**） */
  stalls: number;
  evStalls: number;
  accessible: number;
  /** 车道段数与总长（米） */
  aisleSegments: number;
  aisleLengthM: number;
  /** 车道多边形（按真实宽度）的面积总 m² */
  aislePolyM2: number;
  /** **多边形级**连通分量：两段车道真的叠在一起才算连通 */
  aislePolyComponents: number;
  /** 车道多边形里，宽度达到两车交汇要求（≥5.5 m）的比例 */
  aisleWidthOk: number;
  /** 车位前缘中点在车道多边形内的比例（多边形口径，不是中心线距离） */
  stallFrontPolyRate: number;
  /** 车道网的连通分量数（端点配对重建） */
  aisleComponents: number;
  /** 与"接驳口"同分量的车道段 / 全部车道段 */
  connectedToEntry: number;
  /** driveConnector 条数 */
  connectors: number;
  /** 车道端点里被配对上的比例（1 = 完全连成网） */
  jointRate: number;
  /** 每段车道的两端各有多少车位贴着（前缘 2 m 内） */
  stallFrontRate: number;
  trees: number;
  grassM2: number;
  asphaltM2: number;
  ready: boolean;
  notes: string[];
}

export interface PmConverted {
  layout: ParkLayout;
  diag: PmDiag;
  /**
   * Placemaker 的 `asphalt` 面（世界单位）。
   *
   * **实测：asphalt = 车位 + 车道，不等于整个 ParkingZone。**
   * 几个样本：1522 m² asphalt vs 车位 864 + 车道 674 = 1538；2017 vs 889 + 1150 = 2039。
   * 这条事实决定了两件事：
   *   ① `ParkingZone − asphalt` 是**它没有铺的区域**，不是"没用的沥青"；
   *   ② 只有这部分才有资格谈"转成绿地"，而且要排除车辆进出喉咙。
   */
  asphalt: Pt[][];
  /**
   * 车道中心线按 `半宽 + 5.5 m` 扩出来的"车辆真正够得着"的带子。
   *
   * 5.5 m 的依据：车位深 5.04 m（PM 用 scale 0.928 后 4.68 m），加上开关车门的
   * 余量。也就是说**车位、通道、转弯都在这些带子里**，带子以外的大片沥青
   * 既不是车位也不是车道 —— 那才是可以谈"转成绿化"的区域。
   */
  bands: Pt[][];
  /** 每个车位的矩形（世界单位）。烘焙时用它算"车位占用范围"，运行时不用 */
  stallRects: Pt[][];
  /**
   * 每一**排**车位的外包多边形。
   *
   * 为什么不用全体车位的凸包：凸包会把"两排之间的锥形空地"一起包进去，
   * 于是 `Zone − 凸包` 恒为空，尾端死铺装永远识别不出来（实测 retail 就是这样）。
   * 逐排外包是凹形的，尾端才留得下来。
   */
  rowBands: Pt[][];
}

/**
 * 折线 → 带宽度的多边形（斜接转角）。
 *
 * Placemaker 的 `driveAisle` 是**中心线**（a,b,c,d 四点），不带宽度的几何。
 * 但"中心线端点重合"不等于"车开得过去"：两段车道可能只是端点相接，
 * 实际路面在转角处断成 0 宽；也可能车道宽度不足 5.5 m，两车交汇就卡死。
 *
 * 所以这里按 `settings.aisleWidth` 生成真实路面多边形：
 * 逐段平移 ±h，相邻段的平移线求交（斜接），首尾加平头端帽。
 */
// 实现已移到 core/polyline（浏览器安全），这里保留同名导出以免调用方改动。
// 注意还要 import 一次：本文件内部也用它，单纯 `export ... from` 不会引入局部绑定。
import { bufferPolyline } from '../../core/polyline';
export { bufferPolyline };

/** 把折线两端各沿自身方向延长 d（端头回车空间） */
function extendEnds(pts: Pt[], d: number): Pt[] {
  if (pts.length < 2 || d <= 0) return pts;
  const out = pts.slice();
  const a0 = out[0];
  const a1 = out[1];
  const l0 = Math.hypot(a1.x - a0.x, a1.y - a0.y) || 1;
  out.unshift(new Pt(a0.x + ((a0.x - a1.x) / l0) * d, a0.y + ((a0.y - a1.y) / l0) * d));
  const b0 = out[out.length - 1];
  const b1 = out[out.length - 2];
  const l1 = Math.hypot(b0.x - b1.x, b0.y - b1.y) || 1;
  out.push(new Pt(b0.x + ((b0.x - b1.x) / l1) * d, b0.y + ((b0.y - b1.y) / l1) * d));
  return out;
}

/** 两个多边形是否真的重叠（边相交或顶点互含） */
function polysOverlap(a: Pt[], b: Pt[]): boolean {
  const cross = (o: Pt, p: Pt, q: Pt) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const segX = (p1: Pt, p2: Pt, p3: Pt, p4: Pt) => {
    const d1 = cross(p3, p4, p1);
    const d2 = cross(p3, p4, p2);
    const d3 = cross(p1, p2, p3);
    const d4 = cross(p1, p2, p4);
    return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
  };
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      if (segX(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])) return true;
    }
  }
  const inside = (p: Pt, ring: Pt[]) => {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const pi = ring[i];
      const pj = ring[j];
      if (pi.y > p.y !== pj.y > p.y && p.x < ((pj.x - pi.x) * (p.y - pi.y)) / (pj.y - pi.y) + pi.x) c = !c;
    }
    return c;
  };
  return inside(a[0], b) || inside(b[0], a);
}

/**
 * plan JSON → `ParkLayout`（世界单位）。
 *
 * `aisles` 现在是**真实路面多边形**（按 `settings.aisleWidth` 生成），
 * 不再是空数组：
 *   · 只靠中心线端点判断"车能过去"，会把 T 型口 0 宽的路面也算通；
 *   · 车道面写成 `role: 'overlay'` 叠在停车底色上，2D/3D 都能看出"路在哪儿"，
 *     又不会因为压住车位底色而被计成非法重叠。
 */
export function pmPlanToParkLayout(plan: PmPlan, o: Pt): PmConverted {
  const notes: string[] = [];
  const bays = plan.objects.filter((x) => x.role === 'parkingBay');

  // ---- 车位矩形：中心 ± 宽/2（沿排）± 深/2（朝车头）
  // 实测：同一排相邻车位 dx = 3.0（= stallWidth），scale 0.928 是深度折扣
  //（5.9 × 0.928 ≈ 5.48），两组车位行间距 12.9 = 2×5.48 + 7.4 车道。
  const wM = Number((plan as unknown as { settings?: Record<string, unknown> }).settings?.stallWidth ?? 3) || 3;
  const rows: { yaw: number; scale: number; depthM: number; bays: typeof bays }[] = [];
  const byKey = new Map<string, typeof bays>();
  for (const b of bays) {
    const yaw = b.yaw ?? 0;
    const sc = b.scale ?? 0.928;
    const k = `${yaw.toFixed(3)}|${sc.toFixed(3)}`;
    const arr = byKey.get(k) ?? [];
    arr.push(b);
    byKey.set(k, arr);
  }
  for (const [k, arr] of byKey) {
    const [y, s] = k.split('|');
    rows.push({ yaw: Number(y), scale: Number(s), depthM: 5.9 * Number(s), bays: arr });
  }

  const stallRects: Pt[][] = [];
  const rowBands: Pt[][] = [];
  const dividers: [Pt, Pt][] = [];
  const fronts: [Pt, Pt][] = [];
  const seen = new Set<string>();
  const key = (a: Pt, b: Pt) => {
    const r = (n: number) => n.toFixed(2);
    const k1 = `${r(a.x)},${r(a.y)}|${r(b.x)},${r(b.y)}`;
    const k2 = `${r(b.x)},${r(b.y)}|${r(a.x)},${r(a.y)}`;
    return k1 < k2 ? k1 : k2;
  };

  // 车道中心线（世界单位）——用来判"车位前缘朝哪边"
  const aisleLines: [Pt, Pt][] = [];
  for (const n of plan.nets) {
    if (n.role !== 'driveAisle' && n.role !== 'driveConnector') continue;
    const pts = [n.a, n.b, n.c, n.d].map(([x, z]) => toU(x, z, o));
    for (let i = 0; i + 1 < pts.length; i++) aisleLines.push([pts[i], pts[i + 1]]);
  }
  const distToAisles = (p: Pt): number => {
    let best = Infinity;
    for (const [a, b] of aisleLines) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const L = dx * dx + dy * dy;
      let t = L > 1e-12 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / L : 0;
      t = Math.max(0, Math.min(1, t));
      best = Math.min(best, Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)));
    }
    return best;
  };

  for (const row of rows) {
    const halfW = wM / 2 / M;
    const halfL = row.depthM / 2 / M;
    // yaw 是车头朝向：facing = (sin, cos)，排方向 = facing 逆时针 90°
    const fx = Math.sin(row.yaw);
    const fz = Math.cos(row.yaw);
    const px = fz;
    const pz = -fx;
    for (const b of row.bays) {
      const c = toU(b.x, b.z, o);
      // 车位矩形（沿排 ±halfW，沿车头 ±halfL）：烘焙时用来算"车位占用范围"
      stallRects.push([
        new Pt(c.x - px * halfW - fx * halfL, c.y - pz * halfW - fz * halfL),
        new Pt(c.x + px * halfW - fx * halfL, c.y + pz * halfW - fz * halfL),
        new Pt(c.x + px * halfW + fx * halfL, c.y + pz * halfW + fz * halfL),
        new Pt(c.x - px * halfW + fx * halfL, c.y - pz * halfW + fz * halfL),
      ]);
      {
        // 与分隔线同一套推导：沿排 ±halfW，沿车头 ±halfL
        const fx0 = Math.sin(row.yaw);
        const fz0 = Math.cos(row.yaw);
        const px0 = fz0;
        const pz0 = -fx0;
        const hw = wM / 2 / M;
        const hl = row.depthM / 2 / M;
        stallRects.push([
          new Pt(c.x - px0 * hw - fx0 * hl, c.y - pz0 * hw - fz0 * hl),
          new Pt(c.x + px0 * hw - fx0 * hl, c.y + pz0 * hw - fz0 * hl),
          new Pt(c.x + px0 * hw + fx0 * hl, c.y + pz0 * hw + fz0 * hl),
          new Pt(c.x - px0 * hw + fx0 * hl, c.y - pz0 * hw + fz0 * hl),
        ]);
      }
      // 方向向量的长度必须是 1（世界轴与米轴同向，只差比例），
      // 除以 M 会让车位边长缩成 0.8 m —— 第一版就是这么错的
      const f = new Pt(fx, fz);
      const p = new Pt(px, pz);
      // 边界线：沿车头方向的一条边（相邻车位共用，去重后正好是 n+1 条）
      const a0 = new Pt(c.x - p.x * halfW - f.x * halfL, c.y - p.y * halfW - f.y * halfL);
      const a1 = new Pt(c.x - p.x * halfW + f.x * halfL, c.y - p.y * halfW + f.y * halfL);
      const k = key(a0, a1);
      if (!seen.has(k)) {
        seen.add(k);
        dividers.push([a0, a1]);
      }
      // 前缘：两条短边的中点里，离车道更近的那条
      const s1 = { m: new Pt(c.x - f.x * halfL, c.y - f.y * halfL), a: new Pt(c.x - f.x * halfL - p.x * halfW, c.y - f.y * halfL - p.y * halfW), b: new Pt(c.x - f.x * halfL + p.x * halfW, c.y - f.y * halfL + p.y * halfW) };
      const s2 = { m: new Pt(c.x + f.x * halfL, c.y + f.y * halfL), a: new Pt(c.x + f.x * halfL - p.x * halfW, c.y + f.y * halfL - p.y * halfW), b: new Pt(c.x + f.x * halfL + p.x * halfW, c.y + f.y * halfL + p.y * halfW) };
      const pick = distToAisles(s1.m) <= distToAisles(s2.m) ? s1 : s2;
      const fk = key(pick.a, pick.b);
      if (!seen.has('F' + fk)) {
        seen.add('F' + fk);
        fronts.push([pick.a, pick.b]);
      }
    }
  }

  // ---- 逐排外包（用 bays 的中心在 (p, f) 坐标系里的范围）
  for (const row of rows) {
    const fx = Math.sin(row.yaw);
    const fz = Math.cos(row.yaw);
    const px = fz;
    const pz = -fx;
    let minP = Infinity, maxP = -Infinity, minF = Infinity, maxF = -Infinity;
    for (const b of row.bays) {
      const c = toU(b.x, b.z, o);
      const dp = c.x * px + c.y * pz;
      const df = c.x * fx + c.y * fz;
      minP = Math.min(minP, dp); maxP = Math.max(maxP, dp);
      minF = Math.min(minF, df); maxF = Math.max(maxF, df);
    }
    if (!Number.isFinite(minP)) continue;
    const hw = wM / 2 / M;
    const hl = row.depthM / 2 / M;
    const corner = (p: number, f: number) => new Pt(px * p + fx * f, pz * p + fz * f);
    rowBands.push([
      corner(minP - hw, minF - hl),
      corner(maxP + hw, minF - hl),
      corner(maxP + hw, maxF + hl),
      corner(minP - hw, maxF + hl),
    ]);
  }

  // ---- 景观岛：Placemaker 的 grass 面，直接就是我们要的多边形
  const islands: Pt[][] = [];
  const asphaltRings: Pt[][] = [];
  let grassM2 = 0;
  let asphaltM2 = 0;
  for (const s of plan.surfaces) {
    if (s.role === 'grass') {
      if (s.ring.length >= 3) islands.push(s.ring.map(([x, z]) => toU(x, z, o)));
      grassM2 += ringAreaM2(s.ring);
    } else if (s.role === 'asphalt') {
      if (s.ring.length >= 3) asphaltRings.push(s.ring.map(([x, z]) => toU(x, z, o)));
      asphaltM2 += ringAreaM2(s.ring);
    }
  }

  // ---- 车道网拓扑：端点配对（Placemaker 不填 startAttach/endAttach）
  const segs = plan.nets
    .filter((n) => n.role === 'driveAisle')
    .map((n) => [n.a, n.b, n.c, n.d] as [number, number][]);
  const connectors = plan.nets.filter((n) => n.role === 'driveConnector');
  const eps = segs.map((s) => [s[0], s[3]]);
  const round = (p: [number, number]) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;
  const adj = new Array(segs.length).fill(0).map(() => [] as number[]);
  const atPoint = new Map<string, number[]>();
  eps.forEach((pair, i) => {
    for (const q of pair) {
      const k = round(q);
      const arr = atPoint.get(k) ?? [];
      arr.push(i);
      atPoint.set(k, arr);
    }
  });
  let joints = 0;
  let jointed = 0;
  for (const [, ids] of atPoint) {
    for (const i of ids) for (const j of ids) if (i !== j) adj[i].push(j);
    if (ids.length >= 2) jointed++;
    joints++;
  }
  // 连通分量
  const comp = new Array(segs.length).fill(-1);
  let nComp = 0;
  for (let i = 0; i < segs.length; i++) {
    if (comp[i] >= 0) continue;
    const stack = [i];
    comp[i] = nComp;
    while (stack.length) {
      const u = stack.pop()!;
      for (const v of adj[u]) if (comp[v] < 0) { comp[v] = nComp; stack.push(v); }
    }
    nComp++;
  }
  // 有 driveConnector 的一端算"接上了外部"
  const entryComps = new Set<number>();
  for (const c of connectors) {
    const end = round([c.d[0], c.d[1]]);
    const ids = atPoint.get(end) ?? [];
    for (const i of ids) entryComps.add(comp[i]);
  }
  let connectedToEntry = 0;
  for (let i = 0; i < segs.length; i++) if (entryComps.has(comp[i])) connectedToEntry++;

  const aisleLengthM = segs.reduce((a, s) => a + segLen(s), 0);
  const stallFrontRate = bays.length
    ? bays.filter((b) => {
        const c = toU(b.x, b.z, o);
        return distToAisles(c) * M <= 5.9 * (b.scale ?? 0.928) + 1.2;
      }).length / bays.length
    : 0;

  // ---- 车道面：按 settings.aisleWidth 把中心线加成带
  const aisleWM = Number((plan as unknown as { settings?: Record<string, unknown> }).settings?.aisleWidth ?? 7) || 7;
  const halfW = aisleWM / 2 / M;
  const aislePolys: Pt[][] = [];
  const bands: Pt[][] = [];
  for (const n of plan.nets) {
    if (n.role !== 'driveAisle' && n.role !== 'driveConnector') continue;
    const line = [n.a, n.b, n.c, n.d].map(([x, z]) => toU(x, z, o));
    const poly = bufferPolyline(line, halfW);
    if (poly && poly.length >= 4) aislePolys.push(poly);
    // 「车辆够得着」的带子：横向 = 半宽 + 车位深（4.68）+ 开门余量，
    // 纵向 = 车道两端各多留 6 m 回车（这是端头转弯半径的常用下限）。
    //
    // 只按同一半径扩是不够的：端头转弯是**沿车道方向**多出来的距离，
    // 用圆形 buffer 会把整个锥形尾端都算进"够得着"，尾端的死铺装永远剩不下来。
    const band = bufferPolyline(extendEnds(line, 6 / M), halfW + 5.0 / M);
    if (band && band.length >= 4) bands.push(band);
  }
  // 多边形级连通：两段路面真的叠在一起才算连通（中心线端点相接不算）
  const polyComp = new Array(aislePolys.length).fill(-1);
  let polyN = 0;
  for (let i = 0; i < aislePolys.length; i++) {
    if (polyComp[i] >= 0) continue;
    polyComp[i] = polyN;
    const stack = [i];
    while (stack.length) {
      const u = stack.pop()!;
      for (let v = 0; v < aislePolys.length; v++) {
        if (polyComp[v] >= 0) continue;
        if (polysOverlap(aislePolys[u], aislePolys[v])) {
          polyComp[v] = polyN;
          stack.push(v);
        }
      }
    }
    polyN++;
  }
  let aislePolyM2 = 0;
  for (const p of aislePolys) {
    let a2 = 0;
    for (let i = 0; i < p.length; i++) {
      const q = p[i];
      const r = p[(i + 1) % p.length];
      a2 += q.x * r.y - r.x * q.y;
    }
    aislePolyM2 += Math.abs(a2 / 2) * M * M;
  }
  // 车位前缘中点是否落在某段车道面里（多边形口径）
  const inPoly = (p: Pt, ring: Pt[]) => {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const pi = ring[i];
      const pj = ring[j];
      if (pi.y > p.y !== pj.y > p.y && p.x < ((pj.x - pi.x) * (p.y - pi.y)) / (pj.y - pi.y) + pi.x) c = !c;
    }
    return c;
  };
  // 车位前缘中点**正好落在车道面边界上**（车位深度按车道边线起算），
  // 严格 point-in-polygon 会全判 false（实测 3%）。所以判据是
  // "在面内 或 离面边界 ≤ 0.6 m" —— 这才是"车位贴着这条车道"的真实含义。
  const distToPoly = (p: Pt, ring: Pt[]): number => {
    let best = Infinity;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const L = dx * dx + dy * dy;
      let t = L > 1e-12 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / L : 0;
      t = Math.max(0, Math.min(1, t));
      best = Math.min(best, Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)));
    }
    return best;
  };
  const TOUCH = 0.6 / M;
  let frontPolyHits = 0;
  for (const [a, b] of fronts) {
    const mid = new Pt((a.x + b.x) / 2, (a.y + b.y) / 2);
    if (aislePolys.some((poly) => inPoly(mid, poly) || distToPoly(mid, poly) <= TOUCH)) frontPolyHits++;
  }
  const stallFrontPolyRate = fronts.length ? frontPolyHits / fronts.length : 0;

  const statOf = (k: string) => plan.stats.find((s) => s.key === k)?.value ?? 0;
  const diag: PmDiag = {
    stalls: bays.length,
    evStalls: plan.objects.filter((x) => x.role === 'charger').length,
    accessible: statOf('Stat.AccessibleStalls'),
    aisleSegments: segs.length,
    aisleLengthM,
    aislePolyM2,
    aislePolyComponents: polyN,
    aisleWidthOk: aisleWM >= 5.5 ? 1 : 0,
    stallFrontPolyRate,
    aisleComponents: nComp,
    connectedToEntry,
    connectors: connectors.length,
    jointRate: joints ? jointed / joints : 0,
    stallFrontRate,
    trees: plan.objects.filter((x) => x.role === 'tree').length,
    grassM2,
    asphaltM2,
    ready: plan.ready,
    notes,
  };
  if (statOf('Stat.Stalls') !== bays.length) {
    notes.push(`stats.Stalls=${statOf('Stat.Stalls')} 与 objects=${bays.length} 不一致（stats 是生成量，含被障碍裁掉的）`);
  }
  if (!plan.ready) notes.push('plan.ready = false（Core 自己认为不具备条件）');
  if (nComp > 1) notes.push(`车道网 ${nComp} 个连通分量（未完全连成一片）`);
  if (polyN > 1) notes.push(`车道**面** ${polyN} 个连通分量（中心线口径 ${nComp} 个）`);
  if (stallFrontPolyRate < 0.98) notes.push(`车位前缘落在车道面内 ${(stallFrontPolyRate * 100).toFixed(0)}%`);

  const layout: ParkLayout = {
    angle: rows.length ? rows[0].yaw : 0,
    dividers,
    fronts,
    aisles: aislePolys,
    islands,
    walks: [],
    count: bays.length,
    // 车道占场地比例：车道面积 / 场地面积（沥青 + 绿岛 = 场地）
    aisleRatio: (aisleLengthM * 7) / Math.max(1, diag.asphaltM2 + diag.grassM2),
  };
  return { layout, diag, asphalt: asphaltRings, bands, stallRects, rowBands };
}

function segLen(s: [number, number][]): number {
  let a = 0;
  for (let i = 0; i + 1 < s.length; i++) a += Math.hypot(s[i + 1][0] - s[i][0], s[i + 1][1] - s[i][1]);
  return a;
}

function ringAreaM2(ring: [number, number][]): number {
  let a2 = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a2 += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a2 / 2);
}
