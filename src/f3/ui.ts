// F3 · 浏览器侧的入口：把页面上的城市半径 / 种子 / 风貌换成一份 CityResult
//
// 只做两件事：缓存（切模式时不要重复生成同一座城）和"从页面参数到 spec"的翻译。
// 生成本身在 `src/f3/index.ts`，和测试脚本走的是同一条链路。

import { cityOutline, runF3City, type CityResult } from './index';
import type { FieldGuide } from '../town/guide';
import type { CityDensity, CityProgram, CityStyle } from './types';

export interface F3Settings {
  style: CityStyle;
  program: CityProgram;
  density: CityDensity;
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

export function f3Key(
  radius: number,
  seed: number,
  s: F3Settings,
  heightScale: number,
  guides: FieldGuide[] = []
): string {
  // 方向线必须进缓存键：画完线要重建，否则用户会觉得"画了没反应"
  const g = guides
    .filter((q) => q.enabled && q.pts.length >= 2)
    .map((q) => `${q.id}@${q.strength.toFixed(2)}:${q.pts.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(';')}`)
    .join('~');
  return [radius.toFixed(1), seed, s.style, s.program, s.density, heightScale.toFixed(2), buildMode(), roadMode(), g].join('|');
}

/** 生成（或取缓存）。同步 —— 一座 1 km² 的城在 1~6 s 内出完，够快，不用做异步 */
export function f3City(
  radius: number,
  seed: number,
  s: F3Settings,
  heightScale = 1,
  guides: FieldGuide[] = []
): CityResult {
  const key = f3Key(radius, seed, s, heightScale, guides);
  if (cache && cache.key === key) return cache.result;
  const result = runF3City({
    boundary: { outer: cityOutline(radius, seed, 11), holes: [] },
    style: s.style,
    density: s.density,
    program: s.program,
    seed,
    heightScale,
    buildMode: buildMode(),
    roadMode: roadMode(),
    guides,
  });
  cache = { key, result };
  return result;
}

export function clearF3Cache(): void {
  cache = null;
}
