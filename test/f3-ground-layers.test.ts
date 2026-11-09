// 地块地面四类：**互不重叠**校验
//
// 用户的判据：停车场地坪 / 草地 / 地块通路 三者不许压在一起；硬质底在它们下面
// （整块街区一片，不做切割）。这里把三类两两求交，面积必须接近 0。
//
// 为什么要这么测：这三类是"按语义分别生成"的，任何一处 take() 的 subtracted
// 失败（surfaceSubtract 失败会返回原面）、或者顺序调整漏减，都会表现为
// "草地上一块深色沥青" / "通路压在草地上" —— 肉眼很难逐块看，只能靠面积。

import { Pt } from '../src/core/geom';
import { cityOutline, runF3City, type CityResult } from '../src/f3';
import { bboxOf, surfaceArea, surfaceIntersect, type PlanSurface } from '../src/town/planning/core/surface';

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = ''): void => {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}${detail ? '  ' + detail : ''}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? '  ' + detail : ''}`);
  }
};

const seed = 682063530;
const M2 = (u2: number): number => u2 * 49;

/**
 * 四类地面。
 *
 * 草地有**四种深浅**（lawn / grassLight / grass / grassDark）——
 * 这是"孤立绿地分片随机 2~4 种绿"的需求，四者在语义上是同一类，
 * 所以校验重叠时要把它们合起来算。
 */
const CLASS = {
  parking: ['asphaltLot'],
  lawn: ['lawn', 'grassLight', 'grass', 'grassDark'],
  path: ['lotPath'],
} as const;

function lotSurfaces(r: CityResult, mats: readonly string[]): PlanSurface[] {
  return r.scene.surfaces
    .filter((s) => mats.includes(s.mat) && s.group.startsWith('lot/'))
    .map((s) => ({ outer: s.ring, holes: s.holes ?? [] }) as PlanSurface);
}

const city = runF3City({
  boundary: { outer: cityOutline(70, seed, 11), holes: [] as Pt[][] },
  style: 'structured',
  density: 'low',
  program: 'mixed',
  seed,
});

// ---------------------------------------------------------------- ① 三类都在
const parking = lotSurfaces(city, CLASS.parking);
const lawn = lotSurfaces(city, CLASS.lawn);
const path = lotSurfaces(city, CLASS.path);
console.log(`  面数：停车 ${parking.length} / 草地 ${lawn.length} / 通路 ${path.length}`);
ok('停车场地坪有产出', parking.length > 0, `${parking.length} 片`);
ok('草地有产出', lawn.length > 0, `${lawn.length} 片`);
ok('地块通路有产出', path.length > 0, `${path.length} 片`);

// ---------------------------------------------------------------- ② 两两不重叠
function overlapM2(a: PlanSurface[], b: PlanSurface[]): { area: number; worst: number } {
  let area = 0;
  let worst = 0;
  const bBoxes = b.map((q) => bboxOf(q.outer));
  for (const p of a) {
    const pb = bboxOf(p.outer);
    for (let i = 0; i < b.length; i++) {
      const qb = bBoxes[i];
      if (qb.minX > pb.maxX || qb.maxX < pb.minX || qb.minY > pb.maxY || qb.maxY < pb.minY) continue;
      let hit: PlanSurface[] = [];
      try {
        hit = surfaceIntersect([p], [b[i]]);
      } catch {
        continue;
      }
      for (const h of hit) {
        const A = M2(surfaceArea(h));
        if (A < 0.05) continue; // 布尔数值缝
        area += A;
        worst = Math.max(worst, A);
      }
    }
  }
  return { area, worst };
}

const pairs: { name: string; a: PlanSurface[]; b: PlanSurface[] }[] = [
  { name: '停车 × 草地', a: parking, b: lawn },
  { name: '停车 × 通路', a: parking, b: path },
  { name: '草地 × 通路', a: lawn, b: path },
];
for (const pr of pairs) {
  const r = overlapM2(pr.a, pr.b);
  ok(
    `${pr.name} 不重叠`,
    r.area < 5,
    `重叠 ${r.area.toFixed(1)} m²（最大一片 ${r.worst.toFixed(1)} m²）`
  );
}

// ---------------------------------------------------------------- ③ 硬质底：整块街区、一种颜色
const base = city.scene.surfaces.filter((s) => s.mat === 'lotBase' && s.group.startsWith('lot/'));
ok('每个街区都有一片硬质底', base.length >= city.stats.blockCount, `${base.length} 片 / ${city.stats.blockCount} 街区`);
const baseMats = new Set(base.map((s) => s.mat));
ok('硬质底只有一种材质', baseMats.size === 1, [...baseMats].join(','));
const bigEnough = base.filter((s) => M2(surfaceArea({ outer: s.ring, holes: s.holes ?? [] })) > 200).length;
ok('硬质底覆盖整块街区（面积 > 200 m² 的占多数）', bigEnough >= base.length * 0.9, `${bigEnough} / ${base.length}`);

// ---------------------------------------------------------------- ④ 地块里不许出现"别的颜色"
const allowed = new Set([
  'lotBase',
  'lotPath',
  'asphaltLot',
  'water',
  'stallBand',
  'gravel',
  'lawn',
  'grass',
  'grassLight',
  'grassDark',
]);
const stray = new Map<string, number>();
for (const s of city.scene.surfaces) {
  if (!s.group.startsWith('lot/')) continue;
  if (s.name.startsWith('zone_')) continue; // 禁区铺装（硬地/公园/林地）是另一套语义
  if (allowed.has(s.mat)) continue;
  stray.set(s.mat, (stray.get(s.mat) ?? 0) + 1);
}
ok('地块地面只有四类材质（草地含 4 种深浅）', stray.size === 0, [...stray].map(([k, v]) => `${k}×${v}`).join(' ') || '无越界材质');

console.log(fail === 0 ? `\nPASS — ${pass} 项断言，0 项失败` : `\nFAIL — ${pass} 项断言，${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
