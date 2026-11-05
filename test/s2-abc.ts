// S2 · A/B/C 实测对照
//
// 用法：npx tsx test/s2-abc.ts
//
//   A  当前 TownForge 旧布局（s1=off）+ 旧停车求解器
//   B  S1 骨架（s1=golden）+ 旧停车求解器
//   C  Pattern Registry（pattern=golden）+ S1 + Placemaker（parkingProvider=placemaker）
//
// 三条都在**同一个 seed、同一块地、同一套建筑/车位尺寸**下跑。
// 数字全部取自 SceneIR（不是 candidate），因为落到场景之后还要过 ownership 切割。

import { Model } from '../src/town/model';
import { buildRoadNet } from '../src/road/system';
import { buildPlannerBundle } from '../src/scene/planner-bridge';
import { surfaceArea, surfaceIntersect } from '../src/town/planning/core/surface';
import { patchKey } from '../src/town/patch';
import { BAKED_PARKING_META } from '../src/town/parking/baked';

const SEED = 682063530;
const GOLDEN = [
  { key: '-469:284', label: 'MF' },
  { key: '176:176', label: 'retail' },
  { key: '252:-578', label: 'industrial' },
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
  bldM2: number;
  cov: number;
  stallLines: number;
  stalls: number;
  providers: string;
  islands: number;
  islandM2: number;
  roadPieces: number;
  roadM2: number;
  overlap: number;
  laneM2: number;
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
  const lotM2 = Math.abs(lot.shape.reduce((a: number, q: any, i: number) => {
    const r2 = lot.shape[(i + 1) % lot.shape.length];
    return a + (q.x * r2.y - r2.x * q.y);
  }, 0) / 2) * 49;

  const blds = f.solids;
  const bldM2 = blds.reduce((a, s) => a + surfaceArea({ outer: s.ring, holes: [] }) * 49, 0);
  const stallLines = f.paths.filter((p) => /_stall_/.test(p.name)).length;
  const islands = f.surfaces.filter((s) => s.mat === 'grass' && /parkreq|island/.test(s.name));
  const roads = f.surfaces.filter((s) => /_road_\d+_(surf|pad)/.test(s.name));
  const lanes = f.surfaces.filter((s) => s.mat === 'concrete');
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

  return {
    cand: rep.candidateId ?? '-',
    bld: blds.length,
    bldM2,
    cov: bldM2 / lotM2,
    stallLines,
    stalls: rep.parking?.stalls ?? -1,
    providers: (rep.parking?.providers ?? []).join('+'),
    islands: islands.length,
    islandM2: islands.reduce((a, s) => a + m2(s), 0),
    roadPieces: roads.length,
    roadM2: roads.reduce((a, s) => a + m2(s), 0),
    overlap,
    laneM2: lanes.reduce((a, s) => a + m2(s), 0),
    ms,
  };
}

console.log(`\n═══ S2 A/B/C 对照 · seed ${SEED} ═══`);
console.log(`烘焙表：${BAKED_PARKING_META.entries} 条 · ${BAKED_PARKING_META.generatedAt}`);

for (const g of GOLDEN) {
  console.log(`\n──────── ${g.label}  ${g.key}`);
  const rows = VARIANTS.map((v) => ({ v, r: measure(v, g.key) }));
  const hdr = ['方案', '候选', '建筑', '覆盖率', '车位', 'provider', '绿岛', '绿岛m²', '路面片', '路面m²', '车道m²', '重叠m²', 'ms'];
  console.log('  ' + hdr.map((h, i) => (i === 0 ? h.padEnd(4) : h.padStart(10))).join(' '));
  for (const { v, r } of rows) {
    if (!r) { console.log(`  ${v.id}  （未接管）`); continue; }
    const cells = [
      v.id,
      r.cand.slice(0, 9),
      String(r.bld),
      `${(r.cov * 100).toFixed(0)}%`,
      String(r.stalls),
      r.providers,
      String(r.islands),
      r.islandM2.toFixed(0),
      String(r.roadPieces),
      r.roadM2.toFixed(0),
      r.laneM2.toFixed(0),
      r.overlap.toFixed(0),
      r.ms.toFixed(0),
    ];
    console.log('  ' + cells.map((c, i) => (i === 0 ? c.padEnd(4) : c.padStart(10))).join(' '));
  }
}

console.log('');
