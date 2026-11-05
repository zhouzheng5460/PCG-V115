// R1.3 · 内部交通网络接入生产 —— 场景级验收
//
// 这个文件只问一个问题：**浏览器里真的会看到新路吗**，而不是"求解器算对了"。
// 所以断言全部落在 `buildPlannerBundle()` 产出的 SceneIR 特征上，不看 solver 的中间量。
//
// 验收口径（对应任务书 §5）：
//   ① 三块 Golden 的新网络真的换上了（report.circulation.applied）；
//   ② 全部必要 OD 连通；
//   ③ 新路确实进入 SceneIR（有 `_road_*_surf_*` 面，且面积 > 0）；
//   ④ 无重复道路：同地块内任意两条路面不相交；
//   ⑤ 精确非法重叠 = 0（跑正式 auditOverlap）；
//   ⑥ 2D / 3D 同一份规划结果（同输入两次装配必须逐项一致）；
//   ⑦ 未被开关覆盖的地块一行代码都没变（report.circulation 不存在）。

import { Model } from '../src/town/model';
import { buildRoadNet } from '../src/road/system';
import { buildPlannerBundle } from '../src/scene/planner-bridge';
import { buildScene } from '../src/scene/build';
import { patchKey } from '../src/town/patch';
import { surfaceArea, surfaceIntersect } from '../src/town/planning/core/surface';
import { auditOverlap } from '../src/diagnostics/geometry-audit';
import type { SurfaceFeature } from '../src/scene/types';

let fail = 0;
let n = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  n++;
  if (!cond) {
    fail++;
    console.log(`  FAIL ${name} ${detail}`);
  }
};

const GOLDEN = [
  { key: '-469:284', label: 'MF', typology: 'multi_family' },
  { key: '176:176', label: 'retail', typology: 'retail' },
  { key: '252:-578', label: 'industrial', typology: 'industrial' },
];

console.log('=== R1.3 生产接入验收 ===');
const t0 = performance.now();
const m = new Model({ nPatches: 15, seed: 682063530, plaza: true });
m.generate();
const net = buildRoadNet(m);
// 这个文件验的是 R1.3 的**受控开关**契约（只开三块）。
// R1.4 起全局默认改成了 all，所以这里必须显式钉回 golden，否则
// "未开开关的地块没有新网络" 这条断言会失效。
const bundle = buildPlannerBundle(m, net, 'planner', { circulation: 'golden' });
console.log(`建模 + Planner 全量 ${(performance.now() - t0).toFixed(0)} ms\n`);

/** 路面面（realizeRoads 铺的，不是中心线） */
const roadSurfacesOf = (feats: { surfaces: SurfaceFeature[] }) =>
  feats.surfaces.filter((s) => /_road_\d+_surf_/.test(s.name));

for (const g of GOLDEN) {
  const patch = m.patches.find((p) => patchKey(p) === g.key);
  ok(`${g.label} 地块存在`, !!patch, g.key);
  if (!patch) continue;

  const report = bundle.reports.get(g.key);
  ok(`${g.label} 被 Planner 接管`, !!report?.covered, JSON.stringify(report?.reason));
  const circ = report?.circulation;
  ok(`${g.label} 新交通网络已启用`, circ?.applied === true, circ?.reason ?? '无 circulation 报告');
  if (!circ?.applied) continue;

  // ② 全部必要 OD 连通（报告里的数字，不是求解器自述）
  ok(
    `${g.label} 必要 OD 全连通`,
    circ.odConnected === circ.odTotal && circ.odTotal > 0,
    `${circ.odConnected}/${circ.odTotal}`
  );
  ok(`${g.label} 新路有长度`, circ.lengthM > 0, `${circ.lengthM} m`);

  // ③ 新路进入 SceneIR
  const feats = bundle.byParcel.get(g.key);
  ok(`${g.label} 在 byParcel 里`, !!feats);
  if (!feats) continue;
  const roads = roadSurfacesOf(feats);
  const roadM2 = roads.reduce((s, r) => s + surfaceArea({ outer: r.ring, holes: r.holes ?? [] }), 0) * 49;
  ok(`${g.label} 路面进入 SceneIR`, roads.length > 0, `${roads.length} 块`);
  ok(`${g.label} 路面有实际铺装`, roadM2 > 20, `${roadM2.toFixed(0)} m²`);

  // ④ 无重复道路：同地块内任意两块路面不许相交
  let dupPairs = 0;
  let dupM2 = 0;
  for (let i = 0; i < roads.length; i++) {
    for (let j = i + 1; j < roads.length; j++) {
      const inter = surfaceIntersect(
        [{ outer: roads[i].ring, holes: roads[i].holes ?? [] }],
        [{ outer: roads[j].ring, holes: roads[j].holes ?? [] }]
      );
      const a = inter.reduce((s, p) => s + surfaceArea(p), 0) * 49;
      if (a > 1) { dupPairs++; dupM2 += a; }
    }
  }
  ok(`${g.label} 无重复路面`, dupPairs === 0, `${dupPairs} 对 / ${dupM2.toFixed(1)} m²`);

  console.log(
    `${g.label.padEnd(11)} ${g.key.padEnd(10)} 新路 ${circ.paths} 条 / ${circ.lengthM} m · ` +
    `共享 ${(circ.sharedRate * 100).toFixed(0)}% · 去重 ${circ.dedupedM} m · ` +
    `旧路 保留 ${circ.keptLegacy} / 替换 ${circ.replacedLegacy} · ` +
    `路面 ${roads.length} 块 ${roadM2.toFixed(0)} m² · ${circ.ms} ms`
  );
}

// ⑦ 开关之外的地块：不应该有任何 circulation 报告（一行都没变）
{
  let untouched = 0;
  let leaked = 0;
  for (const [key, r] of bundle.reports) {
    if (!r.covered) continue;
    if (GOLDEN.some((g) => g.key === key)) continue;
    if (r.circulation) leaked++;
    else untouched++;
  }
  ok('未开开关的地块没有新交通网络', leaked === 0, `${leaked} 块被误开`);
  ok('开关之外的地块确实被接管（对照非空）', untouched > 0, `${untouched} 块`);
}

// ⑥ 2D / 3D 同一份规划结果：同输入两次装配必须逐项一致
{
  const a = buildScene(m, { planningMode: 'planner' });
  const b = buildScene(m, { planningMode: 'planner' });
  ok('2D/3D 装配：面数一致', a.surfaces.length === b.surfaces.length, `${a.surfaces.length} vs ${b.surfaces.length}`);
  ok('2D/3D 装配：线数一致', a.paths.length === b.paths.length, `${a.paths.length} vs ${b.paths.length}`);
  const areaA = a.surfaces.reduce((s, x) => s + surfaceArea({ outer: x.ring, holes: x.holes ?? [] }), 0);
  const areaB = b.surfaces.reduce((s, x) => s + surfaceArea({ outer: x.ring, holes: x.holes ?? [] }), 0);
  ok('2D/3D 装配：总面积一致', Math.abs(areaA - areaB) < 1e-6, `${areaA.toFixed(4)} vs ${areaB.toFixed(4)}`);
  const namesA = a.surfaces.map((s) => s.name).join('|');
  const namesB = b.surfaces.map((s) => s.name).join('|');
  ok('2D/3D 装配：逐面同名', namesA === namesB);
}

// ⑤ 精确非法重叠 = 0（正式审计，阈值 5 m²）
{
  const t = performance.now();
  const audit = auditOverlap(m, net);
  console.log(
    `\n精确重叠审计：${audit.blocks} 块 · ${audit.surfaces} 面 · ${audit.conflicts.length} 处冲突` +
    `（${(performance.now() - t).toFixed(0)} ms）`
  );
  for (const c of audit.conflicts.slice(0, 5)) {
    console.log(`  ✗ ${c.block} ${c.a} × ${c.b} = ${c.areaM2} m²`);
  }
  ok('精确非法重叠 0 处', audit.conflicts.length === 0, `${audit.conflicts.length} 处`);
  const totalM2 = audit.conflicts.reduce((s, c) => s + c.areaM2, 0);
  ok('精确非法重叠 0 m²', totalM2 < 0.5, `${totalM2.toFixed(1)} m²`);
}

console.log(`\n${n - fail}/${n} 通过${fail ? ` · ${fail} 失败` : ''}`);
if (fail) process.exitCode = 1;
