import { mkdirSync, writeFileSync } from 'node:fs';
import { Model } from '../src/town/model';
import { buildRoadNet } from '../src/road/system';
import { patchKey } from '../src/town/patch';
import { siteContextFromModel } from '../src/town/planning/adapters/model';
import { makeFrame } from '../src/town/planning/compose/frame';
import { TARGETS, checkTarget } from './targets';
import { renderTargetSheet } from './target-draw';

mkdirSync('out/target', { recursive: true });
const m = new Model({ nPatches: 15, seed: 682063530, plaza: true });
m.generate();
const net = buildRoadNet(m);
const KEY: Record<string, string> = { R01: '-469:284', C01: '176:176', I01: '252:-578' };
for (const plan of TARGETS) {
  const patch = m.patches.find((x) => patchKey(x) === KEY[plan.id])!;
  const site = siteContextFromModel(m, patch, { net });
  const f = makeFrame(site.parcel, 3);
  const c = checkTarget(plan, f, site.parcel);
  console.log(`\n=== ${plan.id} 校验 ${c.ok ? '通过' : '未通过'} 建筑${c.buildings} 占地${c.footprintM2.toFixed(0)} 覆盖${(c.coverage*100).toFixed(0)}% FAR${c.far} 路${c.roadM2.toFixed(0)} 停车${c.parkM2.toFixed(0)} 绿${c.greenM2.toFixed(0)} 最小间距${c.minGapM}`);
  for (const n of c.notes) console.log('   ✗', n);
  const svg = renderTargetSheet(plan, f, site.parcel, [
    { title: '① Target Plan（人工）', subtitle: '建筑 · 道路 · 分区 · 街口', showLabels: true,
      foot: [`建筑 ${c.buildings} 栋 · 占地 ${c.footprintM2.toFixed(0)} m² · 覆盖 ${(c.coverage * 100).toFixed(0)}% · FAR ${c.far}`,
             `路 ${c.roadM2.toFixed(0)} m² · 停车 ${c.parkM2.toFixed(0)} m² · 绿地 ${c.greenM2.toFixed(0)} m²`] },
    { title: '② 空间结构（去掉建筑）', subtitle: '主轴 · 分区 · 出入口', structureOnly: true,
      foot: [`最小建筑净距 ${c.minGapM} m（设计目标 ≥ 6 m）`] },
  ]);
  writeFileSync(`out/target/${plan.id}_target.svg`, svg);
}
