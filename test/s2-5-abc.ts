// S2.5 · A/B/C 真实场景对照 + 停车网络验收
//
// 用法：npx tsx test/s2-5-abc.ts
//
//   A  旧 archetype + legacy 停车
//   B  S1 骨架（pattern 不筛）+ legacy 停车
//   C  Pattern + S1 + Placemaker
//
// 三个 Golden + 五个真实多边形地块，同 seed、同尺寸。
// 指标全部取自 **SceneIR**（过完 ownership 切割之后），不是 candidate。
//
// 停车网络分四层，互不替代（这是 S2.5 的核心）：
//   ① 车位数            有效车位（Placemaker 数 objects，不读 stats）
//   ② 车道面            真实路面 m²（按 aisleWidth 生成的 poly，不是中心线）
//   ③ 车道面连通        分量数 = 1 才是"连成一片"
//   ④ 车位前缘贴车道    前缘中点落在车道面内（或 ≤0.6 m）的比例

import { Model } from '../src/town/model';
import { buildRoadNet } from '../src/road/system';
import { buildPlannerBundle } from '../src/scene/planner-bridge';
import { surfaceArea, surfaceIntersect } from '../src/town/planning/core/surface';
import { patchKey } from '../src/town/patch';
import { BAKED_PARKING_META } from '../src/town/parking/baked';

const SEED = 682063530;
const CASES = [
  { key: '-469:284', label: 'MF' },
  { key: '176:176', label: 'retail' },
  { key: '252:-578', label: 'industrial' },
  { key: '-195:158', label: 'retail-多边形 7 边' },
  { key: '-2:-15', label: 'civic 小地块' },
  { key: '-10:-194', label: 'retail 18 m 窄带' },
  { key: '186:-87', label: 'retail 7 边 43 m' },
  { key: '191:-281', label: 'retail 11 边碎界' },
];

type Variant = { id: 'A' | 'B' | 'C'; s1: 'off' | 'golden'; pattern: 'off' | 'golden'; parking: 'legacy' | 'placemaker' };
const VARIANTS: Variant[] = [
  { id: 'A', s1: 'off', pattern: 'off', parking: 'legacy' },
  { id: 'B', s1: 'golden', pattern: 'off', parking: 'legacy' },
  { id: 'C', s1: 'golden', pattern: 'golden', parking: 'placemaker' },
];

const m = new Model({ nPatches: 15, seed: SEED, plaza: true });
m.generate();
const net = buildRoadNet(m);

const m2 = (s: { ring: unknown[]; holes?: unknown[] }) =>
  surfaceArea({ outer: s.ring as never, holes: (s.holes ?? []) as never }) * 49;

interface Row {
  cand: string;
  bld: number;
  cov: number;
  stalls: number;
  provider: string;
  aisleM2: number;
  comps: number;
  front: number;
  islands: number;
  islandM2: number;
  roadM2: number;
  overlap: number;
  ms: number;
}

function measure(v: Variant, key: string): Row | null {
  const t = performance.now();
  const b = buildPlannerBundle(m, net, 'planner', {
    circulation: 'all',
    s1: v.s1,
    pattern: v.pattern,
    parkingProvider: v.parking,
  });
  const ms = performance.now() - t;
  const rep = b.reports.get(key);
  const f = b.byParcel.get(key);
  if (!rep?.covered || !f) return null;

  const lot = m.patches.find((x) => patchKey(x) === key)!;
  const lotM2 =
    Math.abs(
      lot.shape.reduce((a: number, q: any, i: number) => {
        const r2 = lot.shape[(i + 1) % lot.shape.length];
        return a + (q.x * r2.y - r2.x * q.y);
      }, 0) / 2
    ) * 49;

  const bldM2 = f.solids.reduce((a, s) => a + surfaceArea({ outer: s.ring, holes: [] }) * 49, 0);
  const islands = f.surfaces.filter((s) => s.mat === 'grass' && /parkreq|island/.test(s.name));
  const roads = f.surfaces.filter((s) => /_road_\d+_(surf|pad)/.test(s.name));
  const ground = f.surfaces.filter((s) => s.group.startsWith('lot/') && s.role !== 'overlay' && s.role !== 'road');

  let overlap = 0;
  for (let i = 0; i < ground.length; i++) {
    for (let j = i + 1; j < ground.length; j++) {
      try {
        const inter = surfaceIntersect(
          [{ outer: ground[i].ring, holes: ground[i].holes ?? [] }],
          [{ outer: ground[j].ring, holes: ground[j].holes ?? [] }]
        ).reduce((a, p) => a + surfaceArea(p), 0) * 49;
        if (inter > 5) overlap += inter;
      } catch {
        /* 布尔失败跳过 */
      }
    }
  }

  const pk = rep.parking;
  return {
    cand: rep.candidateId ?? '-',
    bld: f.solids.length,
    cov: bldM2 / lotM2,
    stalls: pk?.stalls ?? -1,
    provider: (pk?.providers ?? []).join('+'),
    aisleM2: pk?.aisleM2 ?? 0,
    comps: pk?.aisleComps ?? 0,
    front: pk?.frontRate ?? 0,
    islands: islands.length,
    islandM2: islands.reduce((a, s) => a + m2(s), 0),
    roadM2: roads.reduce((a, s) => a + m2(s), 0),
    overlap,
    ms,
  };
}

console.log(`\n═══ S2.5 A/B/C · seed ${SEED} ═══`);
console.log(`烘焙表 ${BAKED_PARKING_META.entries} 条 · ${BAKED_PARKING_META.generatedAt}\n`);

const HDR = ['方案', '候选', '建筑', '覆盖', '车位', 'provider', '车道m²', '分量', '前缘', '绿岛', '绿岛m²', '路面m²', '重叠', 'ms'];
const line = (cells: string[]) => '  ' + cells.map((c, i) => (i === 0 ? c.padEnd(4) : c.padStart(8))).join(' ');

for (const c of CASES) {
  console.log(`──────── ${c.label}  ${c.key}`);
  console.log(line(HDR));
  for (const v of VARIANTS) {
    const r = measure(v, c.key);
    if (!r) {
      console.log(`  ${v.id}    （未接管）`);
      continue;
    }
    console.log(
      line([
        v.id,
        r.cand.slice(0, 10),
        String(r.bld),
        `${(r.cov * 100).toFixed(0)}%`,
        String(r.stalls),
        r.provider,
        r.aisleM2.toFixed(0),
        r.comps ? String(r.comps) : '-',
        r.front ? `${(r.front * 100).toFixed(0)}%` : '-',
        String(r.islands),
        r.islandM2.toFixed(0),
        r.roadM2.toFixed(0),
        r.overlap.toFixed(0),
        r.ms.toFixed(0),
      ])
    );
  }
  console.log('');
}

// ---------------------------------------------------------------- 全城分组统计
const bundle = buildPlannerBundle(m, net, 'planner', {
  circulation: 'all',
  s1: 'all',
  pattern: 'all',
  parkingProvider: 'placemaker',
});
const byType = new Map<string, { n: number; pm: number; stallsPm: number; stallsLg: number }>();
let pmReq = 0;
let allReq = 0;
let pmStalls = 0;
for (const [key, rep] of bundle.reports) {
  if (!rep.covered || !rep.parking) continue;
  const g = byType.get(rep.typology) ?? { n: 0, pm: 0, stallsPm: 0, stallsLg: 0 };
  for (const r of rep.parking.perRequest) {
    allReq++;
    g.n++;
    if (r.provider === 'placemaker') {
      pmReq++;
      g.pm++;
      pmStalls += r.stalls;
      g.stallsPm += r.stalls;
    }
  }
  byType.set(rep.typology, g);
  void key;
}
console.log('── 全城采用率（按用地类型）');
console.log('  用地'.padEnd(16) + '请求'.padStart(6) + 'Placemaker'.padStart(12) + '采用率'.padStart(9));
for (const [t, g] of [...byType.entries()].sort((a, b) => b[1].n - a[1].n)) {
  console.log('  ' + t.padEnd(14) + String(g.n).padStart(6) + String(g.pm).padStart(12) + `${((g.pm / g.n) * 100).toFixed(0)}%`.padStart(9));
}
console.log(`  合计           ${String(allReq).padStart(6)}${String(pmReq).padStart(12)}${`${((pmReq / allReq) * 100).toFixed(0)}%`.padStart(9)}`);
console.log(`  Placemaker 承担的车位 ${pmStalls} 个`);
console.log('');
