// F2.5-C.1 · §1 断连来源审计
//
// 对 F01/F02/F03/F04/R01/C01/I01 逐个跑**修复前**（legacy）与**修复后**两遍，
// 输出每个道路分量的节点/边、接入情况、被删的关键边、服务的 Compound 数，
// 并判定它是哪一类：
//
//   city-access    接进真实城市道路
//   boundary-only  只贴红线（红线外假定公共空间）
//   hole-ring      绕洞闭环且有外部接入
//   isolated-loop  绕洞或无洞的闭环，但没有外部接入  ← 非法
//   isolated       悬空在城市内部                    ← 非法
//
// 写 out/f25c/audit.md（人读）与 out/f25c/audit.json（机读）。

import { mkdirSync, writeFileSync } from 'node:fs';
import { Pt } from '../src/core/geom';
import { componentsOf, runPipeline, type PipelineResult } from '../src/town/planning/roadgraph';
import { F25_CASES } from './f25c-cases';

mkdirSync('out/f25c', { recursive: true });

interface Row {
  id: string;
  label: string;
  shape: string;
  mode: 'before' | 'after';
  cells: number;
  cuts: number;
  kept: number;
  comps: number;
  isolated: number;
  unserved: number;
  slivers: number;
  shortEdges: number;
  lengthM: number;
  roadAreaM2: number;
  compounds: number;
  keyEdges: number;
  nearMiss: number;
  ms: number;
}

const rows: Row[] = [];
const detail: Record<string, unknown> = {};

const fmt = (v: number): string => (Number.isFinite(v) ? v.toFixed(1) : '—');

function auditCase(id: string): void {
  const c = F25_CASES.find((x) => x.id === id)!;
  const before = runPipeline(
    { id: c.id, boundary: c.boundary, style: c.style, cellM2: c.cellM2, roads: c.roads, entrances: c.entrances },
    { legacy: true }
  );
  const after = runPipeline({ id: c.id, boundary: c.boundary, style: c.style, cellM2: c.cellM2, roads: c.roads, entrances: c.entrances });

  for (const [mode, r] of [
    ['before', before],
    ['after', after],
  ] as [Row['mode'], PipelineResult][]) {
    rows.push({
      id: c.id,
      label: c.label,
      shape: c.shape,
      mode,
      cells: r.frac.cells.length,
      cuts: r.frac.cuts.length,
      kept: r.merge.keptCuts.length,
      comps: r.diag.totals.comps,
      isolated: r.diag.isolated,
      unserved: r.diag.unserved,
      slivers: r.diag.totals.slivers,
      shortEdges: r.diag.totals.shortEdges,
      lengthM: r.diag.totals.lengthM,
      roadAreaM2: r.diag.totals.roadAreaM2,
      compounds: r.diag.totals.compounds,
      keyEdges: r.diag.keyEdges.length,
      nearMiss: r.diag.nearMiss.length,
      ms: r.ms.total,
    });
  }

  // fracture 自带的分量（合并之前）：用来区分"断在破碎"还是"断在合并"
  const rawComps = componentsOf(after.topo, null);

  detail[c.id] = {
    label: c.label,
    shape: c.shape,
    raw: {
      comps: rawComps.length,
      withBoundary: rawComps.filter((x) => x.onBoundary || x.hasAccess).length,
      lengths: rawComps.map((x) => x.lengthM),
    },
    before: compact(before),
    after: compact(after),
    policy: after.policy,
    backbone: after.backbone
      ? {
          protected: [...after.backbone.protectedCuts.values()].map((p) => ({ cut: p.cutId, role: p.role, lenM: +p.lengthM.toFixed(1), why: p.why })),
          steps: after.backbone.steps,
          notes: after.backbone.notes,
          noRoadReason: after.backbone.noRoadReason,
          uncovered: after.backbone.uncovered,
        }
      : null,
  };

  console.log(`\n=== ${c.id} ${c.label}（${c.shape}）  破碎自带分量 ${rawComps.length}（接得到外部 ${rawComps.filter((x) => x.onBoundary || x.hasAccess).length}）`);
  for (const [nm, r] of [
    ['before', before],
    ['after', after],
  ] as [string, PipelineResult][]) {
    console.log(
      `  ${nm.padEnd(6)} cell ${r.frac.cells.length} 候选 ${r.frac.cuts.length} 保留 ${r.merge.keptCuts.length}` +
        ` | 分量 ${r.diag.totals.comps}（孤立 ${r.diag.isolated}）| Compound ${r.diag.totals.compounds}（不可达 ${r.diag.unserved}）` +
        ` | 路长 ${r.diag.totals.lengthM.toFixed(0)} m / 面 ${r.diag.totals.roadAreaM2.toFixed(0)} m² | 关键边 ${r.diag.keyEdges.length} | ${r.ms.total} ms`
    );
    for (const cp of r.diag.components) {
      console.log(
        `      ${cp.id} ${cp.verdict.padEnd(13)} 节点 ${cp.nodes.length} 边 ${cp.edges.length} 长 ${cp.lengthM.toFixed(0)} m` +
          ` 服务 Compound ${cp.compounds.length}${cp.closedLoop ? ' 闭环' : ''}：${cp.note}`
      );
    }
  }
}

function compact(r: PipelineResult): unknown {
  return {
    totals: r.diag.totals,
    isolated: r.diag.isolated,
    unserved: r.diag.unserved,
    components: r.diag.components.map((cp) => ({
      id: cp.id,
      verdict: cp.verdict,
      note: cp.note,
      nodes: cp.nodes,
      edges: cp.edges,
      lengthM: cp.lengthM,
      touchesBoundary: cp.touchesBoundary,
      touchesCityRoad: cp.touchesCityRoad,
      closedLoop: cp.closedLoop,
      aroundHole: cp.aroundHole,
      compounds: cp.compounds,
      cells: cp.cells,
    })),
    keyEdges: r.diag.keyEdges,
    nearMiss: r.diag.nearMiss,
    compounds: r.diag.compounds,
    pruned: r.graph.diagnostics,
    merge: {
      before: r.merge.before,
      after: r.merge.after,
      merges: r.merge.merges.length,
      forced: r.merge.forced,
      islandRepairs: r.merge.islandRepairs,
      protectedCount: r.merge.protectedCuts.length,
      rejects: r.merge.rejects.slice(0, 40),
    },
    coverage: r.backbone?.coverage,
  };
}

for (const c of F25_CASES) auditCase(c.id);

const head = [
  '# F2.5-C.1 · §1 断连来源审计',
  '',
  '固定 seed；`before` = F2.5 第一轮（无骨架 / 无策略 / 无守卫），`after` = 本轮（连通骨架 + 受约束合并 + 服务距离密度）。',
  '',
  '| 样板 | 形态 | 阶段 | cell | 候选 | 保留 | 分量 | 孤立 | Compound | 不可达 | 狭长 | 短路段 | 路长 m | 路面 m² | 关键边 | 近似缺口 | ms |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
];
for (const r of rows) {
  head.push(
    `| ${r.id} | ${r.shape} | ${r.mode} | ${r.cells} | ${r.cuts} | ${r.kept} | ${r.comps} | ${r.isolated} | ${r.compounds} | ${r.unserved} | ${r.slivers} | ${r.shortEdges} | ${fmt(r.lengthM)} | ${r.roadAreaM2.toFixed(0)} | ${r.keyEdges} | ${r.nearMiss} | ${r.ms} |`
  );
}

// 分量清单（只列 before / after 的差异点）
head.push('', '## 分量清单', '');
for (const r of rows.filter((x) => x.mode === 'after')) {
  const d = detail[r.id] as { before: { components: { id: string; verdict: string; note: string; lengthM: number; compounds: string[] }[] }; after: { components: { id: string; verdict: string; note: string; lengthM: number; compounds: string[] }[] } };
  head.push(`### ${r.id} ${r.label}`, '');
  head.push('| 阶段 | 分量 | 判定 | 长度 m | 服务 Compound | 说明 |', '|---|---|---|---|---|---|');
  for (const [nm, list] of [
    ['before', d.before.components],
    ['after', d.after.components],
  ] as const) {
    if (list.length === 0) head.push(`| ${nm} | — | — | 0 | 0 | 没有内部道路 |`);
    for (const cp of list) head.push(`| ${nm} | ${cp.id} | ${cp.verdict} | ${cp.lengthM.toFixed(0)} | ${cp.compounds.length} | ${cp.note} |`);
  }
  head.push('');
}

head.push('## 被 Merge 删除的关键 Cell 边（before）', '');
head.push('加回去能接起两个不同分量的边才算"关键"；`sidesWithoutAccess` = 两侧里接不到外部的数量。', '');
head.push('| 样板 | 边 | 长度 m | 接起的分量 | 无接入侧 | cell 对 |', '|---|---|---|---|---|---|');
for (const r of rows.filter((x) => x.mode === 'before')) {
  const d = detail[r.id] as { before: { keyEdges: { cutId: string; lengthM: number; joins: [string, string]; sidesWithoutAccess: number; left: string; right: string }[] } };
  for (const k of d.before.keyEdges) {
    head.push(`| ${r.id} | ${k.cutId} | ${k.lengthM} | ${k.joins.join(' ↔ ')} | ${k.sidesWithoutAccess} | ${k.left}/${k.right} |`);
  }
}

head.push('', '## 近似相接但未连接（before）', '');
head.push('| 样板 | 缺口 m | 位置 A | 位置 B |', '|---|---|---|---|');
for (const r of rows.filter((x) => x.mode === 'before')) {
  const d = detail[r.id] as { before: { nearMiss: { gapM: number; a: [number, number]; b: [number, number] }[] } };
  for (const n of d.before.nearMiss) head.push(`| ${r.id} | ${n.gapM} | ${n.a.join(', ')} | ${n.b.join(', ')} |`);
}

writeFileSync('out/f25c/audit.md', head.join('\n'));
writeFileSync('out/f25c/audit.json', JSON.stringify({ rows, detail }, null, 1));
console.log('\n写出 out/f25c/audit.md / audit.json');
void Pt;
