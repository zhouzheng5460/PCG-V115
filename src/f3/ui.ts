// F3 · 浏览器侧的入口：把页面上的城市半径 / 种子 / 风貌换成一份 CityResult
//
// 只做两件事：缓存（切视角 / 改显隐时不要重复生成同一座城）和"从页面参数到 spec"的翻译。
// 生成本身在 `src/f3/index.ts`，和测试脚本走的是同一条链路。

import { cityOutline, runF3City, type CityResult } from './index';
import type { FieldGuide } from '../town/guide';
import type { Zone } from '../town/zones';
import { applyZonesToCity } from './zoneapply';
import type { BlockOverride, CityDensity, CityProgram, CityStyle } from './types';

export interface F3Settings {
  style: CityStyle;
  program: CityProgram;
  density: CityDensity;
}

export interface F3Input extends F3Settings {
  radius: number;
  seed: number;
  heightScale?: number;
  guides?: FieldGuide[];
  zones?: Zone[];
  zonePadM?: number;
  /** 让距范围内是否生成衔接铺装（关掉 = 只按禁区本体铺） */
  zonePadPave?: boolean;
  blockOverrides?: Record<string, BlockOverride>;
  noGraphClean?: boolean;
}

let cache: { key: string; result: CityResult } | null = null;

/**
 * 地块内建筑生成方式：默认二叉分割；`?f3build=row` 回到"内接矩形 + 排 × 段"。
 * 留这个开关是为了同屏对比两条路径，不是给生产用的。
 */
function buildMode(): 'binary' | 'row' {
  if (typeof location === 'undefined') return 'binary';
  return new URLSearchParams(location.search).get('f3build') === 'row' ? 'row' : 'binary';
}

/**
 * 路网创建方式：默认张量场第一步；`?f3road=split` 回到递归面切分做同屏对比。
 * 只切换「第一步」，后续道路建模与街区内处理完全共用。
 */
function roadMode(): 'tensor' | 'split' {
  if (typeof location === 'undefined') return 'tensor';
  return new URLSearchParams(location.search).get('f3road') === 'split' ? 'split' : 'tensor';
}

/** 缓存键：**所有**会改变几何的输入都要进来，否则会出现"改了参数画面没变" */
export function f3Key(inp: F3Input): string {
  const g = (inp.guides ?? [])
    .filter((q) => q.enabled && q.pts.length >= 2)
    .map((q) => `${q.id}@${q.strength.toFixed(2)}:${q.pts.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(';')}`)
    .join('~');
  const bo = Object.entries(inp.blockOverrides ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${v.axisRad?.toFixed(3) ?? ''}/${v.parcels ?? ''}/${v.use ?? ''}/${v.heightScale?.toFixed(2) ?? ''}`)
    .join('~');
  return [
    inp.radius.toFixed(1),
    inp.seed,
    inp.style,
    inp.program,
    inp.density,
    (inp.heightScale ?? 1).toFixed(2),
    buildMode(),
    roadMode(),
    g,
    bo,
  ].join('|');
}

/** 生成（或取缓存）。同步 —— 一座 1 km² 的城在 2~5 s 内出完 */
/**
 * 生成（或取缓存）。
 *
 * **禁区不在缓存键里**：基础城市一律按"无禁区"生成并缓存，禁区再作为一层
 * 后处理叠上去（`applyZonesToCity`）。所以拖动/改名/改用途只是重跑后处理
 * （几十毫秒），不会重新算路网和整城建筑。
 */
export function f3City(inp: F3Input): CityResult {
  const key = f3Key(inp);
  let base: CityResult;
  if (cache && cache.key === key) {
    base = cache.result;
  } else {
    base = runF3City({
    boundary: { outer: cityOutline(inp.radius, inp.seed, 11), holes: [] },
    style: inp.style,
    density: inp.density,
    program: inp.program,
    seed: inp.seed,
    heightScale: inp.heightScale ?? 1,
    buildMode: buildMode(),
    roadMode: roadMode(),
    guides: inp.guides ?? [],
      zones: [],
      zonePadM: 0,
      blockOverrides: inp.blockOverrides ?? {},
      noGraphClean: inp.noGraphClean ?? false,
    });
    cache = { key, result: base };
  }
  return applyZonesToCity(base, inp.zones ?? [], {
    padM: inp.zonePadM ?? 6,
    padPave: inp.zonePadPave ?? true,
  });
}

export function clearF3Cache(): void {
  cache = null;
}
