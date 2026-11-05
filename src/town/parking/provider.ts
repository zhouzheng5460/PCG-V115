// 停车 Provider · 统一入口
//
// 两套实现，同一份契约（`ParkLayout`）、同一套边界/单位/入口口径：
//
//   legacy      → `solveParking()`（现有矩形排布求解器）
//   placemaker  → C# Core（离线烘焙的 JSON，见 `tools/bake-parking.ts`）
//
// ## 为什么 placemaker 走"烘焙"而不是实时调用
//
// 浏览器不能起 .NET 进程。这条限制是硬的，不是偷懒：
// 场景在浏览器里装配（2D/3D/GLB 都从 buildScene 取数），
// 所以 Placemaker 的结果必须**先离线算好**，运行时按几何哈希查表。
//
// 好处是三个视图天然一致（同一份烘焙数据），代价是改了地块/候选之后要重烘 ——
// 所以每次查表失败都必须**明确告警并回退 legacy**，绝不能静默用旧数据。

import { Pt } from '../../core/geom';
import type { ParkLayout } from '../parking';
// 烘焙表在**本模块加载时**就注册。
//
// 早先是让 `scene/build.ts` 做一次 side-effect import —— 结果凡是没经过 buildScene 的
// 调用方（探针、单测、直接调 planner-bridge 的脚本）查表永远 MISS，
// 表现为"明明烘焙过却全部回退"。能力不该依赖"调用方恰好 import 了某个文件"。
import bakedJson from './baked/layouts.json';

export type ParkingProviderId = 'legacy' | 'placemaker' | 'compare';

export interface BakedParking {
  /** `pm:<hash>` */
  key: string;
  provider: 'placemaker';
  /**
   * `true` = Placemaker 跑过但**排不出车位**（能力边界，不是缓存问题）。
   *
   * 这类条目要存下来，否则运行时只能报"未烘焙"，把"它算过、它说不行"
   * 误报成"我们没算" —— 归因就会全错（S2.5 之前 35 个请求里有 2 个是这种）。
   * 存了之后仍然**不参与排布**，只是把理由说出来。
   */
  empty?: boolean;
  /** 车位朝向（弧度） */
  angle: number;
  count: number;
  dividers: [number, number, number, number][];
  fronts: [number, number, number, number][];
  /** 车道**路面多边形**（按 aisleWidth 生成，不是中心线） */
  aisles: [number, number][][];
  /**
   * Placemaker 真正铺了沥青的区域（= 车位 + 车道，**不含整个 ParkingZone**）。
   * 运行时用 `zone − asphalt` 算"它没用的那部分"，只有那部分才可能转绿地。
   */
  asphalt?: [number, number][][];
  /**
   * 停车场里**没有功能**的沥青（离任何车道中心线都 > 8.65 m、也不是景观岛）。
   * 烘焙时算好：运行时只负责把它铺成绿地，不再自己推算语义。
   */
  lawn?: [number, number][][];
  /** 每一排车位的外包（车位带的底）。运行时铺一层浅色，让"排"读得出来 */
  rowBands?: [number, number][][];
  islands: [number, number][][];
  /** 诊断（报告用，不参与几何） */
  diag: {
    stalls: number;
    evStalls: number;
    accessible: number;
    aisleSegments: number;
    aisleLengthM: number;
    aislePolyM2: number;
    aislePolyComponents: number;
    aisleWidthOk: number;
    stallFrontPolyRate: number;
    ready: boolean;
    /** 停车区内被判定为"无功能铺装"的面积（转绿前） */
    deadPavingM2?: number;
    /**
     * 同一块区域上 legacy 求解器能排多少位（烘焙时算好存下来）。
     *
     * 为什么需要它：Placemaker 不是无条件更好。窄带 / 凹形区域上它的
     * 排布语法（单排 + 端头回车）会明显少于 legacy 的密排 —— 实测
     * 18 m 宽的零售带 PM 15 位 / legacy 29 位。没有这个对照，
     * "启用 Placemaker"就等于"悄悄掉了 48% 的车位"。
     */
    legacyStalls: number;
    aisleComponents: number;
    connectedToEntry: number;
    connectors: number;
    jointRate: number;
    stallFrontRate: number;
    trees: number;
    grassM2: number;
    asphaltM2: number;
    ms: number;
    notes: string[];
  };
}

export interface BakedParkingFile {
  schema: 1;
  generatedAt: string;
  driver: string;
  seedNote: string;
  entries: BakedParking[];
}

/**
 * 几何哈希：把可用停车面（世界单位）量化到 0.01 单位后取指纹。
 *
 * 为什么不用 `parcelId` 当 key：同一块地换一个候选，停车区就变了；
 * 用几何做 key 才能保证"查到的就是这块区域的排布"，否则会画出对不上的车位。
 */
export function ringHash(ring: { x: number; y: number }[]): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  for (const p of ring) {
    const a = Math.round(p.x * 100);
    const b = Math.round(p.y * 100);
    for (const v of [a, b]) {
      h1 ^= v & 0xffff;
      h1 = Math.imul(h1, 16777619) >>> 0;
      h1 ^= (v >> 16) & 0xffff;
      h1 = Math.imul(h1, 16777619) >>> 0;
      h2 = (Math.imul(h2 ^ v, 2654435761) >>> 0) + 1;
      h2 >>>= 0;
    }
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

export function bakedKey(ring: { x: number; y: number }[]): string {
  return `pm:${ringHash(ring)}`;
}

let cache: Map<string, BakedParking> | null = null;
/** 空结果（跑过但 0 位）：只用于归因，不参与排布 */
let emptyCache: Map<string, BakedParking> | null = null;

export function setBakedParking(entries: BakedParking[]): void {
  const ok = entries.filter((e) => !e.empty);
  cache = new Map(ok.map((e) => [e.key, e]));
  emptyCache = new Map(entries.filter((e) => e.empty).map((e) => [e.key, e]));
}

/** 烘焙元信息（报告与面板用） */
export const BAKED_META = (() => {
  const f = bakedJson as unknown as BakedParkingFile;
  return { entries: f.entries.length, generatedAt: f.generatedAt, driver: f.driver, seedNote: f.seedNote };
})();

setBakedParking((bakedJson as unknown as BakedParkingFile).entries);

export function lookupBaked(ring: { x: number; y: number }[]): BakedParking | null {
  if (!cache) return null;
  return cache.get(bakedKey(ring)) ?? null;
}

/**
 * 这块区域 Placemaker 是否"算过但排不出"。
 * 返回理由字符串（空条目存在时），否则 null。
 */
export function lookupBakedMiss(ring: { x: number; y: number }[]): string | null {
  const e = emptyCache?.get(bakedKey(ring));
  if (!e) return null;
  return `Placemaker 判定排不下（0 位，区域 ${(e.diag.asphaltM2 + e.diag.grassM2).toFixed(0)} m²，Core ready=${e.diag.ready}）`;
}

/** 烘焙数据 → `ParkLayout`（世界单位） */
export function bakedToLayout(b: BakedParking): ParkLayout {
  return {
    angle: b.angle,
    dividers: b.dividers.map(([x1, y1, x2, y2]) => [new Pt(x1, y1), new Pt(x2, y2)]),
    fronts: b.fronts.map(([x1, y1, x2, y2]) => [new Pt(x1, y1), new Pt(x2, y2)]),
    aisles: (b.aisles ?? []).map((r) => r.map(([x, y]) => new Pt(x, y))),
    islands: b.islands.map((r) => r.map(([x, y]) => new Pt(x, y))),
    walks: [],
    count: b.count,
    aisleRatio: (b.diag.aisleLengthM * 7) / Math.max(1, b.diag.asphaltM2 + b.diag.grassM2),
  };
}
