// F2.4-D · 场景生成验收（实际运行出图，不是人工目标图）
//
// 每个场地输出：
//   ① 2D 彩色总平面      <id>_plan.png
//   ② 正交 3D 鸟瞰        <id>_ortho.png
//   ③ 3D 倾斜视角         <id>_oblique.png
//   ④ 候选对照（2 个）     <id>_cands.png
//   ⑤ 与旧 Archetype 同尺度对照 <id>_vs_legacy.png
//
// 2D 与 3D 都从同一份 `SiteScene` 出发，所以"2D 有路 3D 没路"这种问题从结构上不会发生。

import { mkdirSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { surfaceArea } from '../src/town/planning/core/surface';
import type { PlanSurface } from '../src/town/planning/core/surface';
import { generateCandidates } from '../src/town/planning/generators';
import { composeCandidates, sceneFromSite, visualScore } from '../src/town/planning/compose';
import { PALETTE, type ScenePoly, type SceneSolid, type SiteScene } from '../src/town/planning/compose/scene';
import { renderPlan, renderCompare } from './scene2d';
import { renderOblique, renderOrtho } from './scene3d';
import { KEY_OF, inputOf, siteOfPatch } from './compose-inputs';

const OUT = 'out/d';
mkdirSync(OUT, { recursive: true });
const M2 = (u2: number) => u2 * 49;

const png = async (w: number, h: number, rgba: Uint8Array): Promise<Buffer> =>
  sharp(Buffer.from(rgba), { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();

// ---------------------------------------------------------------- 旧算法（只做视觉对照）

interface LegacyScene {
  scene: SiteScene;
  buildings: number;
  footprintM2: number;
  coverage: number;
  far: number;
}

/**
 * 把旧 Archetype 的结果也压成同一份 `SiteScene`。
 *
 * 这样对照图是"同一个渲染器画两张图"，比例尺、配色、阴影完全一致 ——
 * 不然新旧两张图的观感差异里会混进渲染差异，看不出算法本身的好坏。
 */
function sceneFromLegacy(inputId: string): LegacyScene | null {
  const site = siteOfPatch(KEY_OF[inputId] ?? inputId);
  let cands;
  try {
    cands = generateCandidates(site);
  } catch {
    return null;
  }
  if (cands.length === 0) return null;
  const c = cands[0];
  const ground: ScenePoly[] = [
    { mat: 'base', ring: site.parcel.outer, holes: site.parcel.holes, yM: 0, tag: '底板', areaM2: M2(surfaceArea(site.parcel)) },
  ];
  const matOf = (program: string): ScenePoly['mat'] => {
    const p = program.toLowerCase();
    if (p.includes('park')) return 'parking';
    if (p.includes('green') || p.includes('lawn') || p.includes('grass')) return 'green';
    if (p.includes('plaza') || p.includes('paving') || p.includes('court')) return 'plaza';
    return 'forecourt';
  };
  for (const g of c.ground) {
    ground.push({
      mat: matOf(g.program),
      ring: g.surface.outer,
      holes: g.surface.holes,
      yM: 0.1,
      tag: g.program,
      areaM2: M2(surfaceArea(g.surface)),
    });
  }
  const solids: SceneSolid[] = c.buildings.map((b, i) => ({
    id: `old-${i + 1}`,
    name: '旧建筑',
    kind: b.height * 7 > 20 ? 'residential' : 'shop',
    ring: b.footprint.outer,
    yM: 0,
    // 旧候选的 height 是**世界单位**（1 u = 7 m）
    heightM: +(b.height * 7).toFixed(1),
    floors: Math.max(1, Math.round((b.height * 7) / 3)),
    parcelId: 'legacy',
  }));
  const foot = solids.reduce((s, b) => s + M2(surfaceArea({ outer: b.ring, holes: [] })), 0);
  const gfa = solids.reduce((s, b) => s + M2(surfaceArea({ outer: b.ring, holes: [] })) * b.floors, 0);
  const bb = bboxOf(site.parcel);
  return {
    scene: {
      id: `${inputId}·legacy`,
      typology: site.typology,
      boundary: site.parcel,
      ground,
      solids,
      trees: [],
      stalls: [],
      legend: [],
      stats: {
        blockM2: M2(surfaceArea(site.parcel)),
        baseM2: 0,
        buildingM2: +foot.toFixed(0),
        greenM2: 0,
        pavedM2: 0,
        roadM2: 0,
        trees: 0,
        maxHeightM: solids.reduce((m, s) => Math.max(m, s.heightM), 0),
        byMat: {},
      },
      bbox: bb,
    },
    buildings: solids.length,
    footprintM2: +foot.toFixed(0),
    coverage: M2(surfaceArea(site.buildableArea)) > 0 ? foot / M2(surfaceArea(site.buildableArea)) : 0,
    far: M2(surfaceArea(site.buildableArea)) > 0 ? gfa / M2(surfaceArea(site.buildableArea)) : 0,
  };
}

function bboxOf(s: PlanSurface): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of s.outer) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

// ---------------------------------------------------------------- 主流程

const SITES: { id: string; label: string }[] = [
  { id: 'R01', label: 'R01 · 住宅园区' },
  { id: 'C01', label: 'C01 · 商业街区' },
  { id: 'I01', label: 'I01 · 工业园区' },
  { id: 'G04', label: 'G04 · 三角形地块（抽查）' },
  { id: 'G05', label: 'G05 · L 形凹地块（抽查）' },
];

const rows: Record<string, unknown>[] = [];

for (const s of SITES) {
  const input = inputOf(s.id);
  const r = composeCandidates(input, { max: 3 });
  if (r.cands.length === 0) {
    console.log(`✗ ${s.id} 没有可用候选`);
    continue;
  }
  const best = r.cands[0];
  const scene = best.scene;
  const m = best.comp.metrics;

  // ① 2D 总平面
  writeFileSync(
    `${OUT}/${s.id}_plan.svg`,
    renderPlan(scene, {
      width: 1240,
      title: `${s.label} · ${best.label}`,
      subtitle:
        `自动生成 · 视觉总分 ${best.score.total.toFixed(3)} · 地块 ${m.parcels} · 建筑 ${best.comp.buildings.length} 栋 · ` +
        `覆盖 ${(m.coverage * 100).toFixed(0)}% · FAR ${m.far.toFixed(2)} · 车位 ${m.stalls}`,
      foot: [
        `绿地 ${scene.stats.greenM2} m² · 铺装 ${scene.stats.pavedM2} m² · 道路 ${scene.stats.roadM2} m² · 树 ${scene.stats.trees} 棵 · 未设计 ${m.unassignedM2} m²`,
        best.score.verdict,
      ],
    })
  );

  // ② ③ 3D
  const o = renderOrtho(scene, { size: 1000 });
  writeFileSync(`${OUT}/${s.id}_ortho.png`, await png(o.width, o.height, o.rgba));
  const b3 = renderOblique(scene, { size: 1000 });
  writeFileSync(`${OUT}/${s.id}_oblique.png`, await png(b3.width, b3.height, b3.rgba));

  // ④ 候选对照
  if (r.cands.length > 1) {
    writeFileSync(
      `${OUT}/${s.id}_cands.svg`,
      renderCompare(
        r.cands.slice(0, 3).map((c) => ({
          scene: c.scene,
          title: `${c.key} · ${c.label}`,
          subtitle: `视觉总分 ${c.score.total.toFixed(3)}`,
          foot: [
            `建筑 ${c.comp.buildings.length} 栋 · 覆盖 ${(c.comp.metrics.coverage * 100).toFixed(0)}% · 车 ${c.comp.metrics.stalls}`,
            `道路 ${c.comp.metrics.roadM2.toFixed(0)} m² · 绿地 ${(c.comp.metrics.greenShare * 100).toFixed(0)}% · 树 ${c.scene.trees.length}`,
          ],
        })),
        {
          width: 1560,
          title: `${s.label} · 候选对照（同一份输入，只换道路骨架）`,
          subtitle: '三张图共用比例尺与配色；评分只用于排序，最终由人工视觉判断',
        }
      )
    );
  }

  // ⑤ 与旧算法同尺度对照
  if (['R01', 'C01', 'I01'].includes(s.id)) {
    const old = sceneFromLegacy(s.id);
    if (old) {
      writeFileSync(
        `${OUT}/${s.id}_vs_legacy.svg`,
        renderCompare(
          [
            {
              scene: old.scene,
              title: '旧 Archetype',
              subtitle: `${old.buildings} 栋`,
              foot: [`覆盖 ${(old.coverage * 100).toFixed(0)}% · FAR ${old.far.toFixed(2)}`, '按旧算法原样绘制'],
            },
            {
              scene,
              title: '新 Compose（本轮）',
              subtitle: `${best.comp.buildings.length} 栋 · ${best.label}`,
              foot: [
                `覆盖 ${(m.coverage * 100).toFixed(0)}% · FAR ${m.far.toFixed(2)}`,
                `道路 ${m.roadM2.toFixed(0)} m² · 树 ${scene.stats.trees} 棵`,
              ],
            },
          ],
          { width: 1280, title: `${s.label} · 旧 Archetype vs 新 Compose`, subtitle: '同一边界、同一外部道路、同一比例尺' }
        )
      );
    }
  }

  rows.push({
    id: s.id,
    label: s.label,
    chosen: best.key,
    score: best.score.total,
    scoreTerms: best.score.terms,
    parcels: m.parcels,
    buildings: best.comp.buildings.length,
    coverage: +(m.coverage * 100).toFixed(1),
    far: +m.far.toFixed(2),
    stalls: m.stalls,
    roadM2: +m.roadM2.toFixed(0),
    greenShare: +(m.greenShare * 100).toFixed(0),
    trees: scene.stats.trees,
    unassignedM2: +m.unassignedM2.toFixed(0),
    ms: best.ms,
    candidates: r.cands.map((c) => ({ key: c.key, score: +c.score.total.toFixed(3), buildings: c.comp.buildings.length })),
    validation: { ok: best.comp.validation.ok, errors: best.comp.validation.errors.length, warnings: best.comp.validation.warnings.length },
  });
  console.log(
    `${s.id} 选 ${best.key} 分${best.score.total.toFixed(3)} 建筑${best.comp.buildings.length} 覆盖${(m.coverage * 100).toFixed(0)}% 绿${(m.greenShare * 100).toFixed(0)}% 树${scene.stats.trees} 校验${best.comp.validation.ok ? 'OK' : 'ERR'} ${best.ms}ms`
  );
}

writeFileSync(`${OUT}/metrics.json`, JSON.stringify({ sites: rows }, null, 1));
console.log('\n输出目录', OUT);
