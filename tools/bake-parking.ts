// 烘焙 Placemaker 停车布局
//
// 用法：
//   npx tsx tools/bake-parking.ts                 # 三个 Golden
//   npx tsx tools/bake-parking.ts --all           # 城内全部地块
//   npx tsx tools/bake-parking.ts --all --configs=all   # 只烘 s1=all/pattern=all
//
// ## 为什么必须烘焙
//
// 场景在浏览器里装配（2D / 3D / GLB 都从 buildScene 取数），而 Placemaker 是 .NET 进程 ——
// 浏览器起不了。所以 C# 的结果先离线算成 JSON，运行时按**可用停车面**的几何指纹查表。
//
// ## 为什么必须烘"配置矩阵"
//
// 几何指纹是**停车面几何**，而停车面取决于候选。`s1=golden` 只对三个 Golden 产骨架，
// 其余地块回退原 archetype —— 于是 `s1=golden` 烘出来的表在 `s1=all` 下**全部查不到**。
// 这是 S2 采用率只有 18% 的主因（35 个请求里 17 个 MISS，其中绝大多数区域 1600~2800 m²、
// 最窄 18~45 m，本来完全排得下）。
//
// 现在默认就烘「运行时可能用到的全部组合」，缺哪个组合就会在报告里直接暴露。

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Model } from '../src/town/model';
import { buildRoadNet } from '../src/road/system';
import { patchKey } from '../src/town/patch';
import { siteContextFromModel } from '../src/town/planning/adapters/model';
import { generateCandidates } from '../src/town/planning/generators';
import { selectBestCandidate } from '../src/town/shadow/runner';
import {
  surfaceSubtract,
  surfaceIntersect,
  surfaceArea,
  surface,
  type PlanSurface,
} from '../src/town/planning/core/surface';
import { Pt } from '../src/core/geom';
import { parkingObstaclesOf, globalParkingAxis } from '../src/town/realize/parking';
import { runPlacemaker, pmPlanToParkLayout, pmOrigin } from '../src/town/parking/placemaker';
import { solveParking } from '../src/town/parking';
import { bakedKey, type BakedParking, type BakedParkingFile } from '../src/town/parking/provider';
import type { SiteContext } from '../src/town/planning/core/types';
import type { S1Mode, PatternMode } from '../src/town/planning/skeleton';

const U = (m: number) => m / 7;

/** 凸包（单调链） */
function hullOf(pts: Pt[]): Pt[] {
  const p = pts.slice().sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  if (p.length <= 2) return p;
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lo: Pt[] = [];
  for (const q of p) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  const up: Pt[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop();
    up.push(q);
  }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

/** 凸多边形向外偏移 d（斜接），用于"车位占用范围 + 端头回车" */
function expandConvex(ring: Pt[], d: number): Pt[] {
  const n = ring.length;
  if (n < 3) return ring;
  const out: Pt[] = [];
  // 保证逆时针
  let a2 = 0;
  for (let i = 0; i < n; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % n];
    a2 += p.x * q.y - q.x * p.y;
  }
  const ccw = a2 > 0 ? ring : ring.slice().reverse();
  for (let i = 0; i < n; i++) {
    const prev = ccw[(i - 1 + n) % n];
    const cur = ccw[i];
    const next = ccw[(i + 1) % n];
    const n1 = normOf(prev, cur);
    const n2 = normOf(cur, next);
    const ux = n1.x + n2.x;
    const uy = n1.y + n2.y;
    const ul = Math.hypot(ux, uy) || 1;
    const cosHalf = (ux / ul) * n1.x + (uy / ul) * n1.y || 1;
    const k = d / Math.max(0.35, cosHalf);
    out.push(new Pt(cur.x + (ux / ul) * k, cur.y + (uy / ul) * k));
  }
  return out;
}
/** 逆时针凸环上某条边的外法线 */
function normOf(a: Pt, b: Pt): Pt {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L = Math.hypot(dx, dy) || 1;
  return new Pt(dy / L, -dx / L);
}
const SEED = 682063530;
const GOLDEN = ['-469:284', '176:176', '252:-578'];

function usableRegion(c: Parameters<typeof parkingObstaclesOf>[0], region: PlanSurface): PlanSurface | null {
  const obs = parkingObstaclesOf(c);
  const parts = surfaceSubtract([region], obs).filter((p) => surfaceArea(p) > U(4) * U(4));
  if (parts.length === 0) return null;
  return parts.reduce((a, b) => (surfaceArea(a) >= surfaceArea(b) ? a : b));
}

/**
 * 给 Placemaker 一条"紧贴停车区"的虚拟街道。
 *
 * 为什么不直接用城市道路：停车区常常在场地深处（离红线 30~200 m），
 * Placemaker 的 `EntranceSuggest` 找不到入口就直接 `ready=false`、一个车位都不出。
 *
 * 而 S1 已经保证"有一条车行主通道通到这块停车区"—— 那条通道就是它的入口街。
 * 所以这里取**环上最靠近主临街面的那条边**，向外偏 8 m 当街道。
 */
function streetForRing(
  ctx: SiteContext,
  ring: { x: number; y: number }[]
): { a: { x: number; y: number }; b: { x: number; y: number }; widthM: number } | null {
  const f = ctx.primaryFrontage ?? ctx.secondaryFrontage ?? ctx.serviceFrontage;
  if (!f || ring.length < 3) return null;
  const [fa, fb] = f.parcelEdge;

  const segDist = (p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L = dx * dx + dy * dy;
    let t = L > 1e-12 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / L : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
  };

  let cx = 0;
  let cy = 0;
  for (const q of ring) {
    cx += q.x;
    cy += q.y;
  }
  cx /= ring.length;
  cy /= ring.length;

  let best = -1;
  let bestScore = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < U(8)) continue;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const score = segDist(mid, fa, fb) - len * 0.02;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  if (best < 0) best = 0;

  const a = ring[best];
  const b = ring[(best + 1) % ring.length];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  // 向外偏：**用"从环心指向边中点"的向量定方向**，不依赖环的绕向。
  const mx = (a.x + b.x) / 2 - cx;
  const my = (a.y + b.y) / 2 - cy;
  let nx = dy / len;
  let ny = -dx / len;
  if (nx * mx + ny * my < 0) {
    nx = -nx;
    ny = -ny;
  }
  nx *= U(8);
  ny *= U(8);
  return { a: { x: a.x + nx, y: a.y + ny }, b: { x: b.x + nx, y: b.y + ny }, widthM: 7 };
}

/** 默认烘运行时可能用到的全部组合（s1 / pattern 两轴） */
const DEFAULT_CONFIGS: [S1Mode, PatternMode][] = [
  ['off', 'off'],
  ['golden', 'off'],
  ['golden', 'golden'],
  ['all', 'off'],
  ['all', 'golden'],
  ['all', 'all'],
];

async function main(): Promise<void> {
  const all = process.argv.includes('--all');
  const cfgArg = process.argv.find((a) => a.startsWith('--configs='));
  const configs: [S1Mode, PatternMode][] = cfgArg
    ? (cfgArg.slice('--configs='.length).split(',') as S1Mode[]).map((s1) => [s1, s1 === 'off' ? 'off' : 'all'])
    : DEFAULT_CONFIGS;

  const m = new Model({ nPatches: 15, seed: SEED, plaza: true });
  m.generate();
  const net = buildRoadNet(m);

  const keys: string[] = all ? m.patches.filter((p) => p.withinCity && !p.blocked).map((p) => patchKey(p)) : GOLDEN;

  const entries: BakedParking[] = [];
  const byKey = new Set<string>();
  const missing: string[] = [];
  const t0 = Date.now();
  let requests = 0;

  for (const key of keys) {
    const patch = m.patches.find((x) => patchKey(x) === key);
    if (!patch) continue;
    const ctx = siteContextFromModel(m, patch, { net });
    for (const [s1, pattern] of configs) {
      const cands = generateCandidates(ctx, { s1, pattern });
      if (!cands.length) continue;
      const cand = selectBestCandidate(cands).winner;
      if (!cand || cand.parkingRequests.length === 0) continue;
      for (const [i, req] of cand.parkingRequests.entries()) {
        requests++;
        const usable = usableRegion(cand, req.region);
        if (!usable) {
          missing.push(`${key}/${s1}/${pattern}/${i}: 停车区被障碍吃光`);
          continue;
        }
        const k = bakedKey(usable.outer);
        if (byKey.has(k)) continue;
        // 车位与车道尺寸必须和 legacy 完全一致，否则 A/B 比的是尺寸不是算法
        const r = runPlacemaker({
          ring: usable.outer,
          seed: SEED + i,
          aisleM: 6.3,
          stallWM: 2.52,
          stallLM: 5.04,
          streets: streetForRing(ctx, usable.outer) ? [streetForRing(ctx, usable.outer)!] : [],
        });
        if (!r.ok || !r.plan) {
          missing.push(`${key}/${s1}/${pattern}/${i}: ${r.error ?? '求解失败'}`);
          continue;
        }
        const o = pmOrigin(usable.outer);
        const conv = pmPlanToParkLayout(r.plan, o);
        // 同一区域上 legacy 能排多少：运行时用它做"别比旧方案更差"的闸门。
        //
        // **必须用和运行时完全相同的角度集**（整个候选统一朝向 + 30/45/60 兜底），
        // 否则对照的就不是"legacy 会排多少"，而是一个更差的变体 ——
        // 那样会误判 PM 更优（S2 里 116 vs 78 有一部分就是这个原因）。
        const obs = parkingObstaclesOf(cand);
        const axis = globalParkingAxis(cand, obs);
        const lg = solveParking(usable.outer, {
          angles: [axis, axis + Math.PI / 6, axis + Math.PI / 4, axis + Math.PI / 3],
        });
        conv.diag.legacyStalls = lg?.count ?? 0;
        const { layout, diag } = conv;
        if (diag.stalls === 0) {
          // 0 个车位：**要存成空条目**，但不能参与排布。
          //
          // 不存 → 运行时只能报"未烘焙"，把"它算过、它说不行"误报成"我们没算"，
          //        归因全错（S2.5 之前就是靠这个把 2 块 MF 记成了缓存问题）。
          // 存成正常条目 → 运行时会画出 0 个车位，反而是空结果把 legacy 挡掉了。
          // 所以：单独存、只在 `lookupBakedMiss` 里读。
          entries.push({
            key: k,
            provider: 'placemaker',
            empty: true,
            angle: 0,
            count: 0,
            dividers: [],
            fronts: [],
            aisles: [],
            asphalt: [],
            lawn: [],
            rowBands: [],
            islands: [],
            diag: { ...diag, ms: r.ms },
          });
          byKey.add(k);
          missing.push(
            `${key}/${s1}/${pattern}/${i}: ${(surfaceArea(usable) * 49).toFixed(0)} m² 排不出车位（Core ready=${r.plan.ready}）`
          );
          continue;
        }
        // 车道面裁到停车区里：Placemaker 的入口车道会探出环外一点点，
        // 不裁的话它会画到相邻铺装/绿地上。
        // ---- 停车场地面语义：`Zone − 可达带 − 景观岛` = 没有功能的铺装
        //
        // 判据是"车辆够不够得着"：车道中心线 ± (半宽 + 5.5 m) 覆盖车位、
        // 通道和转弯；带子以外的沥青既不是车位也不是车道。
        // 但**不是一律变绿**：
        //   · 与场地车行道/内部路相接的块 = 进出喉咙，留铺装；
        //   · 面积 < 8 m² 或等效宽度 < 3.5 m 的碎片 = 绿噪点，也留铺装。
        // 两类保留量都记进 `diag.deadPavingM2`，报告里如实列。
        const aislePolysSurf = conv.layout.aisles.map((r) => surface(r));
        // 占用范围 = 所有车位矩形的凸包，向外扩 6 m（端头回车 + 开门余量）。
        // 用凸包而不是"车道 ± r"：车道中线一直铺到地块尽头，按中线扩会把
        // 锥形尾端整块算成"够得着"，尾端的死铺装永远剩不下来（实测 0 块）。
        // 逐排扣除（不是全体凸包）：凸包会把两排之间的锥形空地一起包进去，
        // 于是 `Zone − 占用` 恒为空，尾端死铺装永远识别不出来。
        const occBands = conv.rowBands.filter((r) => r.length >= 3).map((r) => surface(r));
        let rest = occBands.length
          ? surfaceSubtract([usable], [...occBands, ...aislePolysSurf]).filter((q) => surfaceArea(q) > U(1.5) * U(1.5))
          : [];
        if (rest.length && layout.islands.length) {
          rest = surfaceSubtract(rest, layout.islands.map((r) => surface(r))).filter(
            (q) => surfaceArea(q) > U(1.5) * U(1.5)
          );
        }
        const ACCESS = new Set(['driveway', 'service_lane', 'parking_aisle', 'loading_apron', 'truck_court']);
        const accessRings = cand.ground
          .filter((g) => ACCESS.has(g.program))
          .map((g) => g.surface.outer as unknown as Pt[]);
        const distToRings = (q: Pt, rings: Pt[][]): number => {
          let best = Infinity;
          for (const a of rings) {
            for (let i = 0; i < a.length; i++) {
              const u = a[i];
              const v = a[(i + 1) % a.length];
              const dx = v.x - u.x;
              const dy = v.y - u.y;
              const L = dx * dx + dy * dy;
              let t = L > 1e-12 ? ((q.x - u.x) * dx + (q.y - u.y) * dy) / L : 0;
              t = Math.max(0, Math.min(1, t));
              best = Math.min(best, Math.hypot(q.x - (u.x + dx * t), q.y - (u.y + dy * t)));
            }
          }
          return best;
        };
        const lawnRings: PtL[][] = [];
        let deadM2 = 0;
        for (const piece of rest) {
          const a2 = surfaceArea(piece) * 49;
          let per = 0;
          const ring = piece.outer;
          for (let i = 0; i < ring.length; i++) {
            const a = ring[i];
            const b = ring[(i + 1) % ring.length];
            per += Math.hypot(b.x - a.x, b.y - a.y) * 7;
          }
          const width = per > 1e-6 ? (2 * a2) / per : 0;
          const nearAccess =
            accessRings.length > 0 && distToRings(ring[0], accessRings) * 7 <= 2;
          // 端头回车：整块只要有一角离某个车位 ≤ 6 m，就当作转弯空间保留
          const nearStall = conv.stallRects.some((r) => distToRings(ring[0], [r]) * 7 <= 6);
          if (a2 < 8 || width < 3.5 || nearAccess || nearStall) {
            deadM2 += a2;
            continue;
          }
          lawnRings.push(ring.map((q) => [+q.x.toFixed(4), +q.y.toFixed(4)] as PtL));
        }

        const aisles: PtL[][] = [];
        for (const poly of layout.aisles) {
          const clipped = surfaceIntersect([surface(poly)], [usable]).filter((q) => surfaceArea(q) > U(2) * U(2));
          for (const q of clipped) aisles.push(q.outer.map((p) => [+p.x.toFixed(4), +p.y.toFixed(4)] as [number, number]));
        }

        entries.push({
          key: k,
          provider: 'placemaker',
          angle: layout.angle,
          count: layout.count,
          dividers: layout.dividers.map(([a, b]) => [+a.x.toFixed(4), +a.y.toFixed(4), +b.x.toFixed(4), +b.y.toFixed(4)] as [number, number, number, number]),
          fronts: layout.fronts.map(([a, b]) => [+a.x.toFixed(4), +a.y.toFixed(4), +b.x.toFixed(4), +b.y.toFixed(4)] as [number, number, number, number]),
          aisles,
          asphalt: conv.asphalt.map((r) => r.map((q) => [+q.x.toFixed(4), +q.y.toFixed(4)] as PtL)),
          lawn: lawnRings,
          rowBands: conv.rowBands.map((r) => r.map((q) => [+q.x.toFixed(4), +q.y.toFixed(4)] as PtL)),
          islands: layout.islands.map((ring) => ring.map((q) => [+q.x.toFixed(4), +q.y.toFixed(4)] as [number, number])),
          diag: { ...diag, deadPavingM2: deadM2, ms: r.ms },
        });
        byKey.add(k);
        console.log(
          `  ${key.padEnd(10)} s1=${s1.padEnd(6)} pt=${pattern.padEnd(6)} req${i}  ${(surfaceArea(usable) * 49).toFixed(0).padStart(6)}m² → ` +
            `${String(diag.stalls).padStart(4)} 位 · 车道面 ${diag.aislePolyM2.toFixed(0)}m²` +
            ` · 转景观 ${lawnRings.length} 块 / 留铺装 ${deadM2.toFixed(0)}m²` +
            ` · 面分量 ${diag.aislePolyComponents} · 前缘入面 ${(diag.stallFrontPolyRate * 100).toFixed(0)}% · ${r.ms}ms`
        );
      }
    }
  }

  const out: BakedParkingFile = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    driver: 'tools/placemaker/bin/PlacemakerDriver.dll',
    seedNote: `seed ${SEED} · aisle 6.3 m / stall 2.52×5.04 m（与 legacy CAR_STALL 同尺寸）· 配置矩阵 ${configs.length} 组`,
    entries,
  };
  const dir = join(process.cwd(), 'src/town/parking/baked');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'layouts.json');
  writeFileSync(p, JSON.stringify(out), 'utf8');
  console.log(`\n写入 ${p}`);
  console.log(
    `配置 ${configs.length} 组 · 请求 ${requests} 次 · 唯一几何 ${entries.length} 条 · 失败 ${missing.length} · 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`
  );
  for (const s of missing) console.log('  ! ' + s);
}

type PtL = [number, number];

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
