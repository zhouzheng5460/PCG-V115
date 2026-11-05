// F2.4-B · Golden 验收
//
// 六个场景：G01 规则矩形 / G04 三角形 / G07 带洞街区 / R01 住宅 / C01 商业 / I01 工业。
// 每个场景出三张图（阶段 A / B / C）加一份指标；R01·C01·I01 额外出旧算法同机位对比。
//
// 断言分两类：
//   · 硬约束（几何与交通）—— 一条不过就算失败；
//   · 质量下限（覆盖度、临街连续性、未设计占比）——按类型给区间，不作评分。

import { mkdirSync, writeFileSync } from 'node:fs';
import { Pt } from '../src/core/geom';
import { surfaceArea, surfaceInset, surfaceIntersect } from '../src/town/planning/core/surface';
import type { PlanSurface } from '../src/town/planning/core/surface';
import { buildSiteContext } from '../src/town/planning/core/context';
import { generateCandidates } from '../src/town/planning/generators';
import type { SiteContext, SiteRoadEdge, SiteTypology } from '../src/town/planning/core/types';
import { Model } from '../src/town/model';
import { buildRoadNet } from '../src/road/system';
import { patchKey } from '../src/town/patch';
import { siteContextFromModel } from '../src/town/planning/adapters/model';
import { composeSite, type ComposeInput, type SiteComposition } from '../src/town/planning/compose';
import { CASE_BY_ID } from './fixtures-parcels';
import { renderSheet, buildPrims, type DrawPanel } from './compose-draw';
import { renderPrimitives } from './soft3d';
import sharp from 'sharp';

const OUT = 'out/compose';
mkdirSync(OUT, { recursive: true });
const M2 = (u2: number) => u2 * 49;

let fails = 0;
let checks = 0;
function ok(name: string, cond: boolean, detail = ''): void {
  checks++;
  if (!cond) {
    fails++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ---------------------------------------------------------------- 输入

function entrancesFromRoads(boundary: PlanSurface, roads: SiteRoadEdge[]): Pt[] {
  const out: Pt[] = [];
  for (const e of roads) {
    const mid = new Pt((e.a.x + e.b.x) / 2, (e.a.y + e.b.y) / 2);
    let best = mid;
    let bd = Infinity;
    for (let i = 0; i < boundary.outer.length; i++) {
      const a = boundary.outer[i];
      const c = boundary.outer[(i + 1) % boundary.outer.length];
      const dx = c.x - a.x;
      const dy = c.y - a.y;
      const l2 = dx * dx + dy * dy || 1;
      let t = ((mid.x - a.x) * dx + (mid.y - a.y) * dy) / l2;
      t = Math.max(0, Math.min(1, t));
      const q = new Pt(a.x + dx * t, a.y + dy * t);
      const d = Pt.distance(mid, q);
      if (d < bd) {
        bd = d;
        best = q;
      }
    }
    if (!out.some((p) => Pt.distance(p, best) < 3)) out.push(best);
  }
  return out;
}

function fixtureInput(id: string): ComposeInput {
  const c = CASE_BY_ID.get(id)!;
  const ins = surfaceInset(c.boundary, 5 / 7);
  const ent = entrancesFromRoads(c.boundary, c.roads);
  return {
    id,
    typology: c.typology,
    boundary: c.boundary,
    buildable: ins.length > 0 ? ins[0] : c.boundary,
    roadEdges: c.roads,
    vehicleEntrances: ent,
    pedestrianEntrances: ent.slice(0, 1),
    seed: 682063530,
  };
}

const model = new Model({ nPatches: 15, seed: 682063530, plaza: true });
model.generate();
const net = buildRoadNet(model);

function patchSite(key: string): { input: ComposeInput; site: SiteContext } {
  const patch = model.patches.find((x) => patchKey(x) === key)!;
  const site = siteContextFromModel(model, patch, { net });
  return {
    input: {
      id: key.replace(':', '_'),
      typology: site.typology,
      boundary: site.parcel,
      buildable: site.buildableArea,
      roadEdges: site.roadEdges,
      vehicleEntrances: site.vehicleAccessCandidates.slice(0, 2).map((a) => a.at),
      pedestrianEntrances: site.pedestrianAccessCandidates.slice(0, 2).map((a) => a.at),
      seed: 682063530,
    },
    site,
  };
}

// ---------------------------------------------------------------- 旧算法（只用于对比）

interface Legacy {
  buildings: PlanSurface[];
  ground: { surface: PlanSurface; program: string }[];
  coverage: number;
  gfa: number;
  blocks: number;
}

function legacyOf(site: SiteContext): Legacy | null {
  try {
    const cands = generateCandidates(site);
    if (cands.length === 0) return null;
    const c = cands[0];
    const foot = c.buildings.reduce((s, b) => s + surfaceArea(b.footprint), 0);
    // 旧候选的 height 是**世界单位**（1 u = 7 m），层高 3 m
    const floorsOf = (b: { height: number }) => Math.max(1, Math.round((b.height * 7) / 3));
    const gfa = c.buildings.reduce((s, b) => s + surfaceArea(b.footprint) * floorsOf(b), 0);
    const buildable = surfaceArea(site.buildableArea);
    return {
      buildings: c.buildings.map((b) => b.footprint),
      ground: c.ground.map((g) => ({ surface: g.surface, program: g.program })),
      coverage: buildable > 0 ? foot / buildable : 0,
      gfa: M2(gfa),
      blocks: c.buildings.length,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 3D

async function render3D(c: SiteComposition, name: string): Promise<string> {
  const prims = buildPrims(c);
  const img = renderPrimitives(prims, { size: 760, azimuth: 38, elevation: 34, background: [0.08, 0.09, 0.11] });
  const png = await sharp(Buffer.from(img.rgba), { raw: { width: img.width, height: img.height, channels: 4 } })
    .png()
    .toBuffer();
  writeFileSync(`${OUT}/${name}-3d.png`, png);
  return `data:image/png;base64,${png.toString('base64')}`;
}

// ---------------------------------------------------------------- 出图

const CASES: { id: string; label: string; input: ComposeInput; legacyKey?: string }[] = [
  { id: 'G01', label: 'G01 · 规则矩形 140×98 m', input: fixtureInput('G01') },
  { id: 'G04', label: 'G04 · 直角三角形 182×112 m', input: fixtureInput('G04') },
  { id: 'G07', label: 'G07 · 带中庭洞街区 168×126 m', input: fixtureInput('G07') },
  { id: 'R01', label: 'R01 · 住宅 -469:284（全新组团）', input: patchSite('-469:284').input, legacyKey: '-469:284' },
  { id: 'C01', label: 'C01 · 商业 176:176（全新商业街区）', input: patchSite('176:176').input, legacyKey: '176:176' },
  { id: 'I01', label: 'I01 · 工业 252:-578（全新厂房与货运）', input: patchSite('252:-578').input, legacyKey: '252:-578' },
];

const rows: Record<string, unknown>[] = [];
const legacyRows: Record<string, unknown>[] = [];
const fps = new Map<string, string>();

function fingerprintOf(c: SiteComposition): string {
  return c.buildings
    .map((b) => `${b.id}:${b.widthM.toFixed(1)}x${b.depthM.toFixed(1)}@${b.center.x.toFixed(2)},${b.center.y.toFixed(2)}`)
    .join('|');
}

for (const cs of CASES) {
  console.log(`\n=== ${cs.label}`);
  const t0 = Date.now();
  const c = composeSite(cs.input);
  const ms = Date.now() - t0;
  const short = cs.id;

  // ---- 硬约束
  ok(`${short} 硬约束全过`, c.validation.ok, c.validation.errors.map((e) => e.message).slice(0, 3).join(' / '));
  ok(`${short} 建筑不越界`, c.validation.buildingOutsideM2 <= 1, `${c.validation.buildingOutsideM2} m²`);
  ok(`${short} 建筑不互压`, c.validation.buildingOverlapM2 <= 1, `${c.validation.buildingOverlapM2} m²`);
  ok(`${short} 道路不穿建筑`, c.validation.buildingOnRoadM2 <= 1, `${c.validation.buildingOnRoadM2} m²`);
  ok(`${short} 地面不互压`, c.validation.groundOverlapM2 <= 2, `${c.validation.groundOverlapM2} m²`);
  ok(`${short} 洞未被填死`, c.validation.holeFilledM2 <= 1, `${c.validation.holeFilledM2} m²`);
  ok(`${short} 面积可对账`, c.validation.reconciliationM2 <= Math.max(c.metrics.buildableM2 * 0.01, 40), `${c.validation.reconciliationM2} m²`);
  ok(`${short} 门全部接通`, c.validation.doorFailures === 0, `${c.validation.doorFailures} 个`);
  ok(`${short} 停车验证通过`, c.validation.parkingFailures === 0, `${c.validation.parkingFailures} 处`);

  // ---- 规模与构成
  ok(`${short} 地块 ≥ 2`, c.metrics.parcels >= 2, `${c.metrics.parcels}`);
  ok(`${short} 有建筑`, c.metrics.buildings > 0, `${c.metrics.buildings}`);
  ok(
    `${short} 每块地都有用途与理由`,
    c.parcels.parcels.every((p) => p.fn && p.reason.length > 20)
  );
  ok(`${short} 覆盖度在合理区间`, c.metrics.coverage >= 0.05 && c.metrics.coverage <= 0.62, `${(c.metrics.coverage * 100).toFixed(0)}%`);
  ok(`${short} 临街界面连续 ≥ 40%`, c.metrics.frontageContinuity >= 0.4, `${(c.metrics.frontageContinuity * 100).toFixed(0)}%`);
  ok(`${short} 未设计 ≤ 20%`, c.metrics.unassignedShare <= 0.2, `${(c.metrics.unassignedShare * 100).toFixed(1)}%`);
  ok(`${short} 绿地 ≥ 3%`, c.metrics.greenShare >= 0.03, `${(c.metrics.greenShare * 100).toFixed(0)}%`);
  // 停车：有停车地块就必须排得出车位（这是硬约束）；没有停车地块只作提示
  const parkParcels = c.parcels.parcels.filter((p) => p.fn === 'parking').length;
  if (parkParcels > 0) ok(`${short} 停车地块排出车位`, c.metrics.stalls > 0, `${c.metrics.stalls} 位`);
  else console.log(`  NOTE ${short} 没有停车地块（停车配额落空，见报告"已知局限"）`);
  if (parkParcels > 0 && c.metrics.stalls === 0) {
    for (const n of c.notes.filter((x) => x.code === 'parking')) console.log('   停车诊断:', n.message.slice(0, 110));
  }

  // ---- 道路必须说清服务对象
  ok(
    `${short} 内部道路都有服务对象`,
    c.infra.roads.every((r) => r.serves.length > 0),
    c.infra.roads.filter((r) => r.serves.length === 0).map((r) => r.id).join(',')
  );

  // ---- 不继承旧建筑（R01/C01/I01）
  let legacy: Legacy | null = null;
  if (cs.legacyKey) {
    legacy = legacyOf(patchSite(cs.legacyKey).site);
    if (legacy) {
      const oldArea = legacy.buildings.reduce((s, b) => s + surfaceArea(b), 0) * 49;
      let overlap = 0;
      for (const b of c.buildings) {
        for (const o of legacy.buildings) {
          const q = surfaceIntersect([b.surface], [o]).filter((x) => surfaceArea(x) > 1e-6);
          overlap += q.reduce((s, r) => s + surfaceArea(r), 0) * 49;
        }
      }
      legacyRows.push({
        case: cs.id,
        oldBuildings: legacy.blocks,
        newBuildings: c.metrics.buildings,
        oldCoverage: +(legacy.coverage * 100).toFixed(1),
        newCoverage: +(c.metrics.coverage * 100).toFixed(1),
        oldGfa: +legacy.gfa.toFixed(0),
        newGfa: +c.metrics.gfaM2.toFixed(0),
        oldFootprint: +oldArea.toFixed(0),
        newFootprint: +c.metrics.footprintM2.toFixed(0),
        inheritShare: +(overlap / Math.max(1, c.metrics.footprintM2) * 100).toFixed(1),
        oldParcels: 1,
        newParcels: c.metrics.parcels,
      });
      console.log(`  旧算法：${legacy.blocks} 栋 / 覆盖 ${(legacy.coverage * 100).toFixed(0)}% / GFA ${legacy.gfa.toFixed(0)} m²；新旧 footprint 重叠 ${(
        (overlap / Math.max(1, c.metrics.footprintM2)) * 100
      ).toFixed(0)}%`);
    }
  }

  // ---- 确定性
  const fp = fingerprintOf(c);
  if (!fps.has(cs.id)) {
    fps.set(cs.id, fp);
    const again = composeSite(cs.input);
    ok(`${short} 相同输入输出一致`, fingerprintOf(again) === fp, '两次结果不同');
  }

  // ---- 出图
  const img3d = await render3D(c, short);
  const base = `\n阶段 A（道路与地块协同）· ${c.infra.chosen} · 道路 ${c.metrics.roadM2.toFixed(0)} m²（${(c.metrics.roadShare * 100).toFixed(1)}%）· 地块 ${c.metrics.parcels} 块`;

  const sheetA = renderSheet(c, {
    title: `${cs.label} · 阶段 A：道路与地块协同`,
    subtitle: `${base} ｜ 内部道路由真实街口插入深内区，占地已从可建域扣除`,
    cols: 3,
    panels: [
      {
        title: '① 原始街区',
        subtitle: '红线 + 真实城市道路 + 街口候选',
        roads: false,
        gates: true,
        entranceLabels: true,
        foot: [`红线 ${c.metrics.blockM2.toFixed(0)} m²（含中庭 ${(c.metrics as unknown as { voidM2: number }).voidM2} m²）`, `可建区 ${c.metrics.buildableM2.toFixed(0)} m²（退线 5 m）`],
      },
      {
        title: '② 分割 + 内部道路',
        subtitle: '道路先铺、地块后切；地块边界即路面边界',
        parcels: true,
        roads: true,
        gates: true,
        labels: true,
        foot: [
          `内部道路 ${c.infra.roads.length} 条：` + c.infra.roads.map((r) => `${r.cls} ${r.widthM.toFixed(1)}m`).join(' / '),
          `骨架候选 ${c.infra.options.length} 组，选定 ${c.infra.chosen}`,
        ],
      },
      {
        title: '③ 功能分配',
        subtitle: '七类用途，每块地的理由写进报告',
        parcels: true,
        roads: true,
        labels: true,
        foot: Object.entries(c.metrics.byFunction)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 4)
          .map(([k, v]) => `${k} ${v.toFixed(0)} m²`),
      },
    ],
  });
  writeFileSync(`${OUT}/${short}_A.svg`, sheetA);

  const sheetB = renderSheet(c, {
    title: `${cs.label} · 阶段 B：按新地块生成建筑群`,
    subtitle: `建筑 ${c.metrics.buildings} 栋 · 占地 ${c.metrics.footprintM2.toFixed(0)} m² · 覆盖 ${(c.metrics.coverage * 100).toFixed(0)}% · GFA ${c.metrics.gfaM2.toFixed(0)} m² · FAR ${c.metrics.far}`,
    cols: 3,
    panels: [
      {
        title: '④ 有效可建域与布局锚点',
        subtitle: '锚点 = clearance 最大点（不是质心）',
        parcels: true,
        onlyFn: ['building', 'compound'],
        roads: true,
        anchors: true,
        foot: ['每块可建地一个锚点；斜边/凹形地块的锚点会偏离几何中心'],
      },
      {
        title: '⑤ 建筑定位与朝向',
        subtitle: '越高越深；白线 = 长轴',
        ground: true,
        groundKinds: ['green', 'planting', 'courtyard'],
        roads: true,
        buildings: true,
        foot: [`方向偏差（对地块主轴，面积加权）${c.metrics.orientDevDeg}°`],
      },
      {
        title: '⑥ 入口与道路接入',
        subtitle: '红 = 主入口，橙 = 货运，灰 = 服务，蓝 = 次入口',
        ground: true,
        roads: true,
        buildings: true,
        doors: true,
        foot: [`主入口到通行网络平均 ${c.metrics.doorReachM} m`],
      },
    ],
  });
  writeFileSync(`${OUT}/${short}_B.svg`, sheetB);

  const panelOld: DrawPanel | null = legacy
    ? {
        title: '⑦ 旧算法同机位对照',
        subtitle: `旧 archetype：${legacy.blocks} 栋，覆盖 ${(legacy.coverage * 100).toFixed(0)}%`,
        ground: false,
        roads: true,
        legacy: [
          ...legacy.ground.map((g) => ({ surface: g.surface, kind: 'ground' as const })),
          ...legacy.buildings.map((b) => ({ surface: b, kind: 'building' as const })),
        ],
        foot: [`旧建筑 ${legacy.blocks} 栋 / ${(legacy.gfa).toFixed(0)} m² 建筑面积（按 3 m 层高折算）`],
      }
    : {
        title: '⑦ 旧算法对照',
        subtitle: '该样本为合成几何，生产生成器无对应 archetype',
        foot: ['旧算法只出现在对照图里，不参与新方案任何输入'],
      };

  const sheetC = renderSheet(c, {
    title: `${cs.label} · 阶段 C：完整场地总平面`,
    subtitle: `停车 ${c.metrics.stalls} 位 · 绿地 ${(c.metrics.greenShare * 100).toFixed(0)}% · 广场/铺装 ${c.metrics.plazaM2.toFixed(0)} m² · 未设计 ${(c.metrics.unassignedShare * 100).toFixed(1)}%`,
    cols: 2,
    panelH: 430,
    panels: [
      {
        title: '⑧ 停车 · 铺装 · 绿地分区',
        subtitle: '每类地面带用途；未设计区如实标出',
        parcels: false,
        ground: true,
        roads: true,
        parking: true,
        foot: [
          `绿地 ${c.metrics.greenM2.toFixed(0)} m² / 广场铺装 ${c.metrics.plazaM2.toFixed(0)} m² / 未设计 ${c.metrics.unassignedM2.toFixed(0)} m²`,
          ...c.ground
            .filter((g) => g.kind === 'unassigned')
            .slice(0, 1)
            .map((g) => `未设计：${g.purpose.slice(0, 40)}`),
        ],
      },
      {
        title: '⑨ 最终 2D 总平面',
        subtitle: '道路 · 建筑群 · 公共空间的主次关系',
        ground: true,
        roads: true,
        buildings: true,
        doors: true,
        parking: true,
        foot: [
          `建筑 ${c.metrics.buildings} 栋 / GFA ${c.metrics.gfaM2.toFixed(0)} m² / FAR ${c.metrics.far.toFixed(2)}`,
          `临街界面连续度 ${(c.metrics.frontageContinuity * 100).toFixed(0)}%`,
        ],
      },
      {
        title: '⑩ 正交轴测 3D',
        subtitle: '同一份几何，高度按真实米数',
        image: img3d,
        foot: [`${c.metrics.buildings} 栋，最高 ${Math.max(...c.buildings.map((b) => b.heightM)).toFixed(0)} m`],
      },
      panelOld,
    ],
  });
  writeFileSync(`${OUT}/${short}_C.svg`, sheetC);

  rows.push({
    case: cs.id,
    typology: c.typology,
    skeleton: c.infra.chosen,
    parcels: c.metrics.parcels,
    buildings: c.metrics.buildings,
    blockM2: c.metrics.blockM2,
    buildableM2: c.metrics.buildableM2,
    roadM2: c.metrics.roadM2,
    roadShare: +(c.metrics.roadShare * 100).toFixed(1),
    coverage: +(c.metrics.coverage * 100).toFixed(1),
    gfa: c.metrics.gfaM2,
    far: c.metrics.far,
    stalls: c.metrics.stalls,
    stallsPer100: c.metrics.stallsPer100,
    greenShare: +(c.metrics.greenShare * 100).toFixed(1),
    plazaM2: c.metrics.plazaM2,
    unassignedShare: +(c.metrics.unassignedShare * 100).toFixed(1),
    frontageContinuity: +(c.metrics.frontageContinuity * 100).toFixed(0),
    orientDevDeg: c.metrics.orientDevDeg,
    doorReachM: c.metrics.doorReachM,
    byFunction: c.metrics.byFunction,
    unowned: c.validation.reconciliationM2,
    double: c.validation.groundOverlapM2,
    ok: c.validation.ok,
    ms,
  });

  console.log(
    `  地块 ${c.metrics.parcels} · 建筑 ${c.metrics.buildings} · 覆盖 ${(c.metrics.coverage * 100).toFixed(0)}% · FAR ${c.metrics.far} · ` +
      `车位 ${c.metrics.stalls} · 绿 ${(c.metrics.greenShare * 100).toFixed(0)}% · 未设计 ${(c.metrics.unassignedShare * 100).toFixed(1)}% · ${ms} ms`
  );
}

writeFileSync(`${OUT}/metrics.json`, JSON.stringify({ rows, legacy: legacyRows }, null, 1));
console.log(`\n检查 ${checks} 项，失败 ${fails} 项`);
console.log(fails === 0 ? 'PASS' : `FAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
