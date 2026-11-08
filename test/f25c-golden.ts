// F2.5-C.1 · 五联图 + 前后对照
//
// 每个 Golden 出五张同视角的图，回答"道路骨架到底是怎么长出来的"：
//   ① 全部 Fracture Cell
//   ② 完整邻接网络与外部入口
//   ③ 被锁定的 Connectivity Backbone（带形成顺序）
//   ④ Region Merge 后的保留道路（含被删掉的边，虚线）
//   ⑤ 最终 Compound 与内部路网（带分量编号）
//
// 每张图都标：分量数 / 道路总长度 / 道路面积预估 / Compound 数 / 外部接入。
// 另外出一张「当前 F2.5-B/C vs 修复后」的同视角对照（同一比例尺、同一取景）。

import { mkdirSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { Pt } from '../src/core/geom';
import { surfaceAnchor, surfaceArea, type PlanSurface } from '../src/town/planning/core/surface';
import { runPipeline, STYLES, type PipelineResult } from '../src/town/planning/roadgraph';
import { renderF25, F25_COLORS as C, type Panel } from './f25-draw';
import { F25_CASES, type F25Case } from './f25c-cases';

const OUT = 'out/f25c';
mkdirSync(OUT, { recursive: true });
const M2 = (u2: number) => u2 * 49;

const STYLE_LABEL: Record<string, string> = { organic: 'A·Organic', structured: 'B·Structured', campus: 'C·Campus' };

const clsStroke = (cls: string): string => (cls === 'arterial' ? C.arterial : cls === 'collector' ? C.collector : C.local);

function run(c: F25Case, legacy: boolean): PipelineResult {
  return runPipeline({ id: c.id, boundary: c.boundary, style: c.style, cellM2: c.cellM2, roads: c.roads, entrances: c.entrances }, { legacy });
}

/** 每张图都要带的四个数 */
function statsLines(r: PipelineResult): string[] {
  const comps = r.diag.totals.comps;
  const acc = r.diag.components.filter((c) => c.verdict === 'city-access').length;
  const bnd = r.diag.components.filter((c) => c.verdict === 'boundary-only' || c.verdict === 'hole-ring').length;
  const iso = r.diag.isolated;
  return [
    `分量 ${comps}（真实道路 ${acc} / 仅红线 ${bnd} / 孤立 ${iso}）`,
    `路长 ${r.diag.totals.lengthM.toFixed(0)} m · 路面 ${r.diag.totals.roadAreaM2.toFixed(0)} m² · Compound ${r.diag.totals.compounds}`,
  ];
}

function centroid(ring: Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p.x;
    y += p.y;
  }
  return new Pt(x / Math.max(1, ring.length), y / Math.max(1, ring.length));
}

function midOf(a: Pt, b: Pt): Pt {
  return new Pt((a.x + b.x) / 2, (a.y + b.y) / 2);
}

function panelsOf(r: PipelineResult): Panel[] {
  const bb = r.input.boundary;
  const cutById = new Map(r.frac.cuts.map((k) => [k.id, k]));
  const stats = statsLines(r);

  // ① cell
  const CELL_FILL = ['#6b7585', '#59616e', '#7a8496', '#4e5764', '#657082'];
  const cellPolys = r.frac.cells.map((c, i) => ({
    ring: c.surface.outer,
    holes: c.surface.holes,
    fill: CELL_FILL[i % CELL_FILL.length],
    stroke: '#2f363e',
  }));

  // ② 全邻接 + 入口
  const allCuts = r.frac.cuts.map((k) => ({ pts: [k.a, k.b], stroke: '#8d97a3', width: 1.1, opacity: 0.85 }));
  const topoDots = [...r.topo.nodes.values()].map((n) => ({
    at: n.at,
    r: (r.topo.adj.get(n.id)?.length ?? 0) >= 3 ? 2.6 : 1.5,
    fill: n.onBoundary ? 'none' : C.node,
    ring: n.onBoundary ? '#e8ecf1' : C.nodeRing,
  }));
  const accDots = r.access.map((a) => ({
    at: a.at,
    r: a.kind === 'cityRoad' ? 4.2 : a.kind === 'entrance' ? 3.4 : 2.2,
    fill: 'none',
    ring: a.kind === 'cityRoad' ? '#7fd1a6' : a.kind === 'entrance' ? '#d9a13f' : '#7b8794',
  }));
  const accLabels =
    r.access[0]?.kind === 'siteBoundary'
      ? []
      : r.access.map((a, i) => ({ at: a.at, text: `入${i + 1}`, fill: '#7fd1a6', size: 7.5, dy: -7 }));

  // ③ 骨架
  const spineOrder = new Map<string, number>();
  r.backbone?.steps.forEach((s, i) => {
    if (!spineOrder.has(s.cutId)) spineOrder.set(s.cutId, i + 1);
  });
  const faint = r.frac.cuts.filter((k) => !r.backbone?.protectedCuts.has(k.id)).map((k) => ({ pts: [k.a, k.b], stroke: '#4a525c', width: 1, opacity: 0.75 }));
  const spineLines = r.backbone ? [...r.backbone.protectedCuts.values()].map((p) => {
    const k = cutById.get(p.cutId)!;
    return {
      pts: [k.a, k.b],
      stroke: p.role === 'accessLink' ? '#d9a13f' : '#7fb069',
      width: p.role === 'accessLink' ? 3.4 : 4,
      dash: p.role === 'accessLink' ? '6 3' : undefined,
    };
  }) : [];
  const spineLabels = r.backbone
    ? [...r.backbone.protectedCuts.keys()].map((cid) => {
        const k = cutById.get(cid)!;
        const m = midOf(k.a, k.b);
        return { at: m, text: `${spineOrder.get(cid) ?? '·'}`, fill: '#e9f7de', size: 12 };
      })
    : [];

  // ④ 合并后的道路
  const keptLines = r.merge.keptCuts.map((k) => ({ pts: [k.a, k.b], stroke: clsStroke(k.cls), width: k.cls === 'arterial' ? 3 : k.cls === 'collector' ? 2.3 : 1.6 }));
  const removedLines = r.merge.removedCuts.map((k) => ({ pts: [k.a, k.b], stroke: '#5b636e', width: 0.9, dash: '3 3', opacity: 0.75 }));

  // ⑤ 最终图 + 分量编号
  const graphLines = [...r.graph.edges.values()].map((e) => ({
    pts: e.centerline,
    stroke: clsStroke(e.roadClass),
    width: e.roadClass === 'arterial' ? 3.2 : e.roadClass === 'collector' ? 2.4 : 1.7,
  }));
  const graphDots = [...r.graph.nodes.values()].map((n) => ({
    at: n.position,
    r: n.nodeType === 'intersection' ? 3.2 : n.nodeType === 'boundary' ? 2.6 : 1.6,
    fill: n.nodeType === 'boundary' ? 'none' : C.node,
    ring: n.nodeType === 'boundary' ? '#e8ecf1' : C.nodeRing,
  }));
  const compLabels = r.diag.components.map((cp) => {
    const e = cp.edges[0];
    const edge = r.graph.edges.get(e.id);
    const at = edge ? midOf(edge.centerline[0], edge.centerline[edge.centerline.length - 1]) : new Pt();
    return {
      at,
      text: `${cp.id.replace('cp', 'C')}·${cp.lengthM.toFixed(0)}m`,
      fill: cp.verdict === 'isolated' || cp.verdict === 'isolated-loop' ? '#e06c75' : '#e8ecf1',
      size: 8.5,
      dy: -5,
    };
  });

  const outline = [bb.outer, ...bb.holes].map((ring) => ({
    pts: [...ring, ring[0]],
    stroke: '#a8b6c6',
    width: 1.2,
    dash: '5 3',
    opacity: 0.9,
  }));
  const blocksFill = (fillA: string, fillB: string) =>
    r.regions.regions.map((rg, i) => ({
      ring: rg.surface.outer,
      holes: rg.surface.holes,
      fill: i % 2 ? fillA : fillB,
      stroke: '#dfe6ee',
      strokeW: 0.9,
      opacity: 0.95,
    }));
  const blockLabels = r.regions.regions.map((rg, i) => ({
    // 顶点平均值在 L 形/凹多边形里可能落在多边形外（F03 上标签跑到路上），用内部锚点
    at: surfaceAnchor(rg.surface, 40),
    text: `B${i + 1} ${rg.areaM2.toFixed(0)}`,
    fill: '#f2f6fb',
    size: 8,
    dy: 3,
  }));

  return [
    {
      title: '① 全部 Fracture Cell',
      subtitle: `${r.frac.cells.length} 个 cell · 目标 ${r.input.cellM2} m²`,
      boundary: bb,
      polys: cellPolys,
      lines: r.frac.cuts.map((k) => ({ pts: [k.a, k.b], stroke: '#9aa4b0', width: 0.8, opacity: 0.8 })),
      foot: [`cell 面积 ${Math.min(...r.frac.cells.map((c) => c.areaM2)).toFixed(0)}~${Math.max(...r.frac.cells.map((c) => c.areaM2)).toFixed(0)} m²`, `场地 ${M2(surfaceArea(bb)).toFixed(0)} m² · 洞 ${bb.holes.length}`],
    },
    {
      title: '② 完整邻接网络 + 外部入口',
      subtitle: `${r.frac.cuts.length} 条候选共享边 · ${r.topo.nodes.size} 个拓扑节点 · 入口 ${r.access.length}`,
      boundary: bb,
      lines: allCuts,
      dots: [...topoDots, ...accDots],
      labels: accLabels,
      foot: [
        r.access[0]?.kind === 'siteBoundary'
          ? '小白圈 = 红线节点（合成样板：红线外假定公共空间）· 无真实道路输入'
          : '绿圈 = 真实城市道路开口 · 橙圈 = 车行开口',
        ...stats,
      ],
    },
    {
      title: '③ 被锁定的 Connectivity Backbone',
      subtitle: r.backbone
        ? r.backbone.protectedCuts.size === 0
          ? `判定：无需内部路（覆盖率 ${(r.backbone.coverageRatio * 100).toFixed(0)}%，最大服务距离 ${r.backbone.worstServiceM.toFixed(0)} m ≤ ${r.backbone.policy.serviceRadiusM} m）`
          : `锁定 ${r.backbone.protectedCuts.size} 条（spine ${[...r.backbone.protectedCuts.values()].filter((p) => p.role === 'spine').length} / accessLink ${[...r.backbone.protectedCuts.values()].filter((p) => p.role === 'accessLink').length}）`
        : 'legacy：无骨架',
      boundary: bb,
      lines: [...faint, ...spineLines],
      labels:
        spineLabels.length > 0
          ? spineLabels
          : [{ at: surfaceAnchor(bb, 60), text: '判定：无需内部路', fill: '#9fb3c8', size: 12 }],
      foot: r.backbone
        ? [
            `服务半径 ${r.backbone.policy.serviceRadiusM} m · 覆盖率 ${(r.backbone.coverageRatio * 100).toFixed(0)}% · 最大服务距离 ${r.backbone.worstServiceM.toFixed(0)} m`,
            `编号 = 补线顺序 · 绿 = spine · 黄虚线 = accessLink（无出口时补的最短链）`,
          ]
        : [''],
    },
    {
      title: '④ Region Merge 后保留的道路',
      subtitle: `保留 ${r.merge.keptCuts.length}/${r.frac.cuts.length} 条 · 合并 ${r.merge.merges.length} 次`,
      boundary: bb,
      polys: blocksFill('#3c4550', '#4d5763'),
      lines: [...removedLines, ...keptLines, ...outline],
      labels: r.backbone ? [] : [],
      foot: [
        r.merge.keptCuts.length === 0 ? '内部路 0 条 —— 密度策略判定无需内部路（见 ③）' : '虚线 = 被合并删掉的边（不是路）',
        `路长 ${r.diag.totals.lengthM.toFixed(0)} m · 路面 ${r.diag.totals.roadAreaM2.toFixed(0)} m² · Compound ${r.diag.totals.compounds}`,
      ],
    },
    {
      title: '⑤ 最终 Compound + 内部路网',
      subtitle: `${r.diag.totals.comps} 个分量 · ${r.diag.totals.compounds} 块 Compound`,
      boundary: bb,
      polys: [...blocksFill('#4a5562', '#5d6875'), ...r.regions.roadRibbons.map((rd) => ({ ring: rd.outer, holes: rd.holes, fill: '#15191f', stroke: '#2a313a', strokeW: 0.5 }))],
      lines: [...graphLines, ...outline],
      dots: [...graphDots, ...accDots],
      labels: [...blockLabels, ...compLabels],
      foot: [...stats],
    },
  ];
}

// ---------------------------------------------------------------- 主流程

const summary: Record<string, unknown> = {};

for (const c of F25_CASES) {
  const before = run(c, true);
  const after = run(c, false);
  const svg = renderF25(panelsOf(after), {
    width: 1860,
    cols: 3,
    title: `F2.5-C.1 · ${c.id} ${c.label}（${c.shape}）· ${STYLE_LABEL[c.style]}`,
    subtitle: '① cell → ② 邻接+入口 → ③ 锁定骨架 → ④ 合并后的路 → ⑤ 最终 Compound（同一比例尺）',
  });
  writeFileSync(`${OUT}/${c.id}_five.svg`, svg);
  await sharp(Buffer.from(svg), { density: 120 }).png().toFile(`${OUT}/${c.id}_five.png`);

  summary[c.id] = {
    label: c.label,
    shape: c.shape,
    style: c.style,
    areaM2: +M2(surfaceArea(c.boundary)).toFixed(0),
    before: brief(before),
    after: brief(after),
    policy: after.policy,
    backbone: after.backbone
      ? {
          protectedCount: after.backbone.protectedCuts.size,
          coverageRatio: after.backbone.coverageRatio,
          worstServiceM: after.backbone.worstServiceM,
          notes: after.backbone.notes,
          steps: after.backbone.steps,
        }
      : null,
    merge: {
      forced: after.merge.forced,
      islandRepairs: after.merge.islandRepairs,
      protectedCount: after.merge.protectedCuts.length,
      rejectTop: topRejects(after),
    },
  };
  console.log(
    `${c.id} 前: 分量 ${before.diag.totals.comps} 路 ${before.diag.totals.lengthM.toFixed(0)} m 街区 ${before.diag.totals.compounds}` +
      ` → 后: 分量 ${after.diag.totals.comps} 路 ${after.diag.totals.lengthM.toFixed(0)} m 街区 ${after.diag.totals.compounds}` +
      ` | 孤立 ${after.diag.isolated} 不可达 ${after.diag.unserved}`
  );
}

function brief(r: PipelineResult): unknown {
  return {
    comps: r.diag.totals.comps,
    isolated: r.diag.isolated,
    unserved: r.diag.unserved,
    kept: r.merge.keptCuts.length,
    compounds: r.diag.totals.compounds,
    lengthM: r.diag.totals.lengthM,
    roadAreaM2: r.diag.totals.roadAreaM2,
    medianBlockM2: median(r.regions.regions.map((x) => x.areaM2)),
    verdicts: r.diag.components.map((c) => c.verdict),
  };
}

function topRejects(r: PipelineResult): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of r.merge.rejects) {
    const k = x.why.replace(/[0-9.]+/g, '#');
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function median(v: number[]): number {
  if (!v.length) return 0;
  const s = v.slice().sort((a, b) => a - b);
  return +s[Math.floor(s.length / 2)].toFixed(0);
}

// ---------------------------------------------------------------- 前后对照

{
  const pairs = F25_CASES.map((c) => ({ c, before: run(c, true), after: run(c, false) }));
  const panels: Panel[] = [];
  for (const p of pairs) {
    panels.push({
      group: p.c.id,
      title: `${p.c.id} 修复前（F2.5-B/C）`,
      subtitle: `分量 ${p.before.diag.totals.comps} · 路 ${p.before.diag.totals.lengthM.toFixed(0)} m · Compound ${p.before.diag.totals.compounds} · 孤立 ${p.before.diag.isolated}`,
      boundary: p.c.boundary,
      polys: [
        ...p.before.regions.regions.map((rg, i) => ({ ring: rg.surface.outer, holes: rg.surface.holes, fill: i % 2 ? C.block : C.blockAlt })),
        ...p.before.regions.roadRibbons.map((rd) => ({ ring: rd.outer, holes: rd.holes, fill: '#14181d' })),
      ],
      lines: [...p.before.graph.edges.values()].map((e) => ({ pts: e.centerline, stroke: clsStroke(e.roadClass), width: 1.6 })),
      foot: [`悬空 ${p.before.graph.diagnostics?.prunedEdges ?? 0} 段被剪 · 中位街区 ${median(p.before.regions.regions.map((x) => x.areaM2))} m²`],
    });
    panels.push({
      group: p.c.id,
      title: `${p.c.id} 修复后（C.1）`,
      subtitle: `分量 ${p.after.diag.totals.comps} · 路 ${p.after.diag.totals.lengthM.toFixed(0)} m · Compound ${p.after.diag.totals.compounds} · 孤立 ${p.after.diag.isolated}`,
      boundary: p.c.boundary,
      polys: [
        ...p.after.regions.regions.map((rg, i) => ({ ring: rg.surface.outer, holes: rg.surface.holes, fill: i % 2 ? C.block : C.blockAlt })),
        ...p.after.regions.roadRibbons.map((rd) => ({ ring: rd.outer, holes: rd.holes, fill: '#14181d' })),
      ],
      lines: [...p.after.graph.edges.values()].map((e) => ({ pts: e.centerline, stroke: clsStroke(e.roadClass), width: 1.6 })),
      foot: [`不可达 Compound ${p.after.diag.unserved} · 中位街区 ${median(p.after.regions.regions.map((x) => x.areaM2))} m²`],
    });
  }
  const svg = renderF25(panels, {
    width: 1480,
    cols: 2,
    title: 'F2.5-C.1 · 当前 F2.5-B/C vs 修复后（同视角、同比例尺）',
    subtitle: '左：先合并后看剩下什么 · 右：先锁骨架再受约束合并',
  });
  writeFileSync(`${OUT}/COMPARE_BEFORE_AFTER.svg`, svg);
  await sharp(Buffer.from(svg), { density: 100 }).png().toFile(`${OUT}/COMPARE_BEFORE_AFTER.png`);
}

writeFileSync(`${OUT}/summary.json`, JSON.stringify(summary, null, 1));
console.log('\n输出', OUT);
