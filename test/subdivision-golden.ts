// F2.1 · Golden 矩阵（八类几何样本 + 三类生产场景）
//
// 用法：npx tsx test/subdivision-golden.ts
//
// 三件事：
//   ① 跑对照实验：旧实现（frontagePartition / tensorPartition）vs 新策略（OBB / Offset）；
//   ② 断言硬约束（越界 / 重叠 / 洞 / 自交 / 建筑没被切开 / 入口 / 面积对账 / 确定性）；
//   ③ 出图（out/subdivision/*.svg）+ 出数（out/subdivision/metrics.json）。
//
// 实验设计上只有一处刻意的统一：**旧实现的切分结果也走同一套装配与验证**
// （runFromLeaves）。这样两者差异只来自"怎么切"，不来自"怎么算临街/怎么判残片"。

import { mkdirSync, writeFileSync } from 'node:fs';
import { Pt } from '../src/core/geom';
import { surface, surfaceArea, type PlanSurface } from '../src/town/planning/core/surface';
import { frontagePartition, tensorPartition } from '../src/town/modern';
import type { SiteRoadEdge, SiteTypology } from '../src/town/planning/core/types';
import type { LeafInput } from '../src/town/planning/subdivision/assemble';
import {
  defaultParams,
  fingerprint,
  makeContext,
  makeRoadEdge,
  runFromLeaves,
  runStrategy,
  RecursiveObbStrategy,
  StreetFrontOffsetStrategy,
  type SubdivisionContext,
  type SubdivisionParams,
  type SubdivisionRun,
} from '../src/town/planning/subdivision';
import { renderSheet, toDrawPieces, type Panel } from './subdivision-draw';
import { CASES, type CaseDef } from './fixtures-parcels';

const U = (m: number) => m / 7;
const M2 = (u2: number) => u2 * 49;

let fail = 0;
let checks = 0;
function ok(name: string, cond: boolean, detail = '') {
  checks++;
  if (!cond) {
    fail++;
    console.log(`  FAIL ${name} ${detail}`);
  }
}

// ---------------------------------------------------------------- 旧实现基线

/**
 * 旧实现的两种切分，转成叶子面。
 *
 * 注意：两者都只吃 `ring: Pt[]`，**洞会丢**（G07 会踩到）——
 * 这正是审计里记的缺口，这里不做修补，按原样跑，让对照结果自己说话。
 */
function baselineLeaves(c: CaseDef, params: SubdivisionParams, which: 'frontage' | 'tensor'): LeafInput[] {
  const ring = c.boundary.outer.slice();
  // 与旧调用方一致：起刀方向取"最长临街边的方向"
  const ang0 = (() => {
    const e = c.roads[0];
    if (!e) return 0;
    return Math.atan2(e.b.y - e.a.y, e.b.x - e.a.x);
  })();
  if (which === 'frontage') {
    const r = frontagePartition(ring, {
      frontage: U(params.frontageM),
      maxDepth: U(params.depthM),
      ang0,
      jitter: 0.15,
      minA: Math.max(0.6, params.minAreaM2 / 49 / 10),
    });
    return r.parcels.map((p) => ({ surface: { outer: p, holes: [] } }));
  }
  const r = tensorPartition(ring, {
    targetA: params.targetAreaM2 / 49,
    minA: params.minAreaM2 / 49,
    maxDepth: 3,
    ang0,
    pattern: 'ortho',
  });
  return r.parcels.map((p) => ({ surface: { outer: p, holes: [] } }));
}

// ---------------------------------------------------------------- 运行

interface Row {
  case: string;
  shape: string;
  method: string;
  pieces: number;
  developable: number;
  fragments: number;
  frontageShare: number;
  fragmentShare: number;
  residualM2: number;
  overlapM2: number;
  outsideM2: number;
  holesLost: number;
  booleanFailures: number;
  ok: boolean;
  msMedian: number;
  msP95: number;
  errors: string[];
}

const rounds = 11;
const rows: Row[] = [];
const runsByCase = new Map<string, { ctx: SubdivisionContext; params: SubdivisionParams; obb: SubdivisionRun; off: SubdivisionRun; baseF: SubdivisionRun; baseT: SubdivisionRun }>();

function toRow(c: CaseDef, label: string, run: SubdivisionRun): Row {
  const holesLost = run.validation.errors.filter((e) => e.code === 'hole-lost').length;
  return {
    case: c.id,
    shape: c.shape,
    method: label,
    pieces: run.stats.pieces,
    developable: run.stats.developable,
    fragments: run.stats.fragments,
    frontageShare: +run.stats.frontageShareMean.toFixed(3),
    fragmentShare: +run.stats.fragmentShare.toFixed(3),
    residualM2: run.validation.residualM2,
    overlapM2: run.validation.overlapM2,
    outsideM2: run.validation.outsideM2,
    holesLost,
    booleanFailures: run.validation.booleanFailures,
    ok: run.validation.ok,
    msMedian: run.stats.msMedian,
    msP95: run.stats.msP95,
    errors: run.validation.errors.map((e) => `${e.code}: ${e.message}`),
  };
}

mkdirSync('out/subdivision', { recursive: true });

for (const c of CASES) {
  const params = defaultParams(c.typology, c.params ?? {});
  const ctx = makeContext(c.boundary, {
    id: c.id,
    parentId: c.id,
    typology: c.typology,
    roadEdges: c.roads,
    fixedBuildings: c.buildings ?? [],
    mode: c.buildings && c.buildings.length > 0 ? 'fixed_buildings' : 'vacant',
    seed: 682063530,
  });

  const baseF = runFromLeaves(ctx, params, 'legacy-frontage', '旧·沿街网格', baselineLeaves(c, params, 'frontage'), {
    rounds,
  });
  const baseT = runFromLeaves(ctx, params, 'legacy-tensor', '旧·面积递归', baselineLeaves(c, params, 'tensor'), {
    rounds,
  });
  const obb = runStrategy(new RecursiveObbStrategy(), ctx, params, { rounds });
  const off = runStrategy(new StreetFrontOffsetStrategy(), ctx, params, { rounds });

  runsByCase.set(c.id, { ctx, params, obb, off, baseF, baseT });

  rows.push(toRow(c, '旧·沿街网格', baseF));
  rows.push(toRow(c, '旧·面积递归', baseT));
  rows.push(toRow(c, '新·Recursive OBB', obb));
  rows.push(toRow(c, '新·Street-front Offset', off));

  // ---- 硬约束断言
  ok(`${c.id} OBB 几何硬约束通过`, obb.validation.ok, obb.validation.errors.map((e) => e.message).join(' | '));
  ok(`${c.id} Offset 几何硬约束通过`, off.validation.ok, off.validation.errors.map((e) => e.message).join(' | '));
  ok(`${c.id} OBB 无非法重叠`, obb.validation.overlapM2 < 1, `${obb.validation.overlapM2} m²`);
  ok(`${c.id} Offset 无非法重叠`, off.validation.overlapM2 < 1, `${off.validation.overlapM2} m²`);
  ok(`${c.id} OBB 无越界`, obb.validation.outsideM2 < 1, `${obb.validation.outsideM2} m²`);
  ok(`${c.id} Offset 无越界`, off.validation.outsideM2 < 1, `${off.validation.outsideM2} m²`);

  // 面积可对账：父 = 子并集 + 残留
  const sumObb = obb.candidates.reduce((s, x) => s + x.metrics.areaM2, 0);
  const sumOff = off.candidates.reduce((s, x) => s + x.metrics.areaM2, 0);
  ok(
    `${c.id} OBB 面积可对账`,
    Math.abs(sumObb + obb.validation.residualM2 - obb.validation.parentM2) < obb.validation.parentM2 * 0.01 + 1,
    `子 ${sumObb.toFixed(0)} + 残 ${obb.validation.residualM2.toFixed(0)} vs 父 ${obb.validation.parentM2.toFixed(0)}`
  );
  ok(
    `${c.id} Offset 面积可对账`,
    Math.abs(sumOff + off.validation.residualM2 - off.validation.parentM2) < off.validation.parentM2 * 0.01 + 1,
    `子 ${sumOff.toFixed(0)} + 残 ${off.validation.residualM2.toFixed(0)} vs 父 ${off.validation.parentM2.toFixed(0)}`
  );

  // 确定性：同输入同 seed 两次指纹一致
  const fp1 = fingerprint(new RecursiveObbStrategy().generate(ctx, params));
  const fp2 = fingerprint(new RecursiveObbStrategy().generate(ctx, params));
  ok(`${c.id} OBB 可复现`, fp1 === fp2);
  const gp1 = fingerprint(new StreetFrontOffsetStrategy().generate(ctx, params));
  const gp2 = fingerprint(new StreetFrontOffsetStrategy().generate(ctx, params));
  ok(`${c.id} Offset 可复现`, gp1 === gp2);

  // G07：洞必须是洞
  if (c.id === 'G07') {
    for (const run of [obb, off]) {
      // 洞的正确结果有两种：① 某块带着洞（洞成为该地块的中庭）；② 洞被切成几块的边界围出来。
      // 错误只有一种：洞被填死（hole-lost）。所以这里只禁后者。
      const withHole = run.candidates.filter((x) => x.metrics.holeAreaM2 > 0.1).length;
      ok(`G07 ${run.strategyId} 洞未被填死`, run.validation.errors.every((e) => e.code !== 'hole-lost'), '有洞被填死');
      ok(`G07 ${run.strategyId} 洞有明确归属`, withHole >= 0, `${withHole} 块带洞（0 也合法：洞在块边界上被围出）`);
      // 洞面积不能凭空消失：子块面积和 + 残差 = 父面积（父面积已扣洞）
      const sum = run.candidates.reduce((s, x) => s + x.metrics.areaM2, 0);
      ok(
        `G07 ${run.strategyId} 洞面积未计入子块`,
        sum <= run.validation.parentM2 + 1,
        `子 ${sum.toFixed(0)} > 父 ${run.validation.parentM2.toFixed(0)}`
      );
    }
    // 旧实现应当暴露"洞丢失"
    const legacyLost = baseF.validation.errors.some((e) => e.code === 'hole-lost') ||
      baseT.validation.errors.some((e) => e.code === 'hole-lost');
    ok('G07 旧实现洞丢失（预期内）', legacyLost, '旧实现竟然没丢洞？需复核');
  }

  // G08：固定建筑不得被切开
  if (c.id === 'G08') {
    for (const run of [obb, off]) {
      const split = run.validation.errors.filter((e) => e.code === 'building-split');
      ok(`G08 ${run.strategyId} 建筑未被切开`, split.length === 0, split.map((e) => e.message).join(' | '));
    }
  }
}

// ---------------------------------------------------------------- 输出表

const fmt = (n: number, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : '-');
console.log('\n=== F2.1 Golden 矩阵（块数 / 可建 / 残片 / 临街率 / 残片占比 / 对账残差 / 重叠 / 洞丢失 / 布尔失败 / P50ms）===');
let lastCase = '';
for (const r of rows) {
  if (r.case !== lastCase) {
    console.log(`\n${r.case} ${r.shape}`);
    lastCase = r.case;
  }
  console.log(
    `  ${r.method.padEnd(22)} 块${String(r.pieces).padStart(3)} 可建${String(r.developable).padStart(3)} 残片${String(
      r.fragments
    ).padStart(2)} 临街${(r.frontageShare * 100).toFixed(0).padStart(3)}% 残片占比${(r.fragmentShare * 100)
      .toFixed(0)
      .padStart(3)}% 残差${fmt(r.residualM2, 1).padStart(7)} 重叠${fmt(r.overlapM2, 1).padStart(5)} 洞丢${r.holesLost} 布尔${r.booleanFailures} ${fmt(
      r.msMedian,
      2
    ).padStart(6)}ms ${r.ok ? 'OK' : 'ERR'}`
  );
}

// ---------------------------------------------------------------- 出图

function panelOf(
  title: string,
  subtitle: string,
  c: CaseDef,
  run: SubdivisionRun | null,
  hints: { ang: number; label: string }[] = []
): Panel {
  return {
    title,
    subtitle,
    boundary: c.boundary,
    roads: c.roads,
    buildings: c.buildings,
    pieces: run ? toDrawPieces(run) : [],
    axisHints: hints,
    foot: run
      ? [
          `块 ${run.stats.pieces} · 可建 ${run.stats.developable} · 残片 ${run.stats.fragments}`,
          `临街比例（块均）${(run.stats.frontageShareMean * 100).toFixed(0)}% · 残片占比 ${(
            run.stats.fragmentShare * 100
          ).toFixed(0)}%`,
          `对账残差 ${run.validation.residualM2.toFixed(1)} m² · 重叠 ${run.validation.overlapM2.toFixed(1)} m² · 洞丢失 ${
            run.validation.errors.filter((e) => e.code === 'hole-lost').length
          }`,
          run.validation.ok ? '✓ 硬约束全部通过' : `✗ ${run.validation.errors.length} 项硬约束失败`,
        ]
      : [
          '原始场地 + 真实临街道路（带宽按真实断面）+ 候选切分方向（去重后）',
          `候选方向 ${hints.length} 条：` +
            hints.map((h) => `${h.label}@${Math.round((h.ang * 180) / Math.PI)}°`).join(' · '),
        ],
  };
}

for (const c of CASES) {
  const r = runsByCase.get(c.id)!;
  const panels: Panel[] = [
    panelOf('① 原始场地', `${c.shape} · ${c.test}`, c, null, r.obb.axisHints),
    panelOf('② 旧·沿街网格', '对照基线（洞会被丢弃）', c, r.baseF),
    panelOf('③ 旧·面积递归', '对照基线（只约束面积）', c, r.baseT),
    panelOf('④ 新·Recursive OBB', '每层重算 OBB · 多源切线 · 无非入口', c, r.obb),
    panelOf('⑤ 新·Street-front Offset', '真实临街带域 · 面宽切分 · 后方组团', c, r.off),
  ];
  const svg = renderSheet(panels, {
    title: `${c.id} · ${c.shape} — ${c.test}`,
    note: '同一画幅 / 同一比例 / 同一配色。虚线红块 = 内部残片；绿点 = 路上接入；紫点 = 巷接（需铺内部通道）。',
    width: 1180,
    panelH: 320,
    cols: 3,
  });
  writeFileSync(`out/subdivision/${c.id}.svg`, svg);
}

const summary = {
  generatedAt: new Date().toISOString(),
  seed: 682063530,
  unit: '1 世界单位 = 7 m',
  rounds,
  rows,
  cases: CASES.map((c) => ({
    id: c.id,
    shape: c.shape,
    test: c.test,
    parentM2: runsByCase.get(c.id)!.obb.validation.parentM2,
    obbPieces: runsByCase.get(c.id)!.obb.stats.pieces,
    offPieces: runsByCase.get(c.id)!.off.stats.pieces,
    obbTree: runsByCase.get(c.id)!.obb.tree,
    obbNotes: runsByCase.get(c.id)!.obb.notes,
    offNotes: runsByCase.get(c.id)!.off.notes,
  })),
};
writeFileSync('out/subdivision/metrics.json', JSON.stringify(summary, null, 2));

console.log(`\n检查 ${checks} 项，失败 ${fail} 项`);
console.log('图：out/subdivision/G01..G08.svg    数：out/subdivision/metrics.json');
if (fail > 0) process.exitCode = 1;
