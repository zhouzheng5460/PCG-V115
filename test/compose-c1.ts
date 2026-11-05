// F2.4-C · C1 骨架候选诊断
//
// 目的（任务书第六节）：不人为指定 S1/S2 获胜，而是把所有候选的原始评分与失分原因摊开，
// 回答四个问题：
//   Q1 S0 胜出是否因为道路成本惩罚过重？
//   Q2 深部建筑是否真的不需要内部通行道路？
//   Q3 OBB 失败是因为分割结果不可用，还是评分机制偏向临街率？
//   Q4 是否存在"几何合法、实际服务不可行却拿到高分"的候选？
//
// 做法：每个候选都**完整跑一遍 A→B→C**（同一套下游代码），再跑 `checkDemand` 六项检查。
// 只有这样才能回答"服务是否可行"—— 只看分割结果答不了这个问题。

import { mkdirSync, writeFileSync } from 'node:fs';
import { Model } from '../src/town/model';
import { buildRoadNet } from '../src/road/system';
import { patchKey } from '../src/town/patch';
import { siteContextFromModel } from '../src/town/planning/adapters/model';
import { composeSite, type ComposeInput, type SiteComposition, type SkeletonOption } from '../src/town/planning/compose';
import { checkDemand, type DemandReport } from '../src/town/planning/compose/demand';

const OUT = 'out/c1';
mkdirSync(OUT, { recursive: true });

const model = new Model({ nPatches: 15, seed: 682063530, plaza: true });
model.generate();
const net = buildRoadNet(model);

function inputOf(key: string): ComposeInput {
  const patch = model.patches.find((x) => patchKey(x) === key)!;
  const site = siteContextFromModel(model, patch, { net });
  return {
    id: key.replace(':', '_'),
    typology: site.typology,
    boundary: site.parcel,
    buildable: site.buildableArea,
    roadEdges: site.roadEdges,
    vehicleEntrances: site.vehicleAccessCandidates.slice(0, 2).map((a) => a.at),
    pedestrianEntrances: site.pedestrianAccessCandidates.slice(0, 2).map((a) => a.at),
    seed: 682063530,
  };
}

interface Cand {
  sk: string;
  st: string;
  option: SkeletonOption;
  composed: SiteComposition | null;
  demand: DemandReport | null;
  error?: string;
  metrics?: {
    parcels: number;
    buildings: number;
    coverage: number;
    roadM2: number;
    stalls: number;
    greenShare: number;
    frontageContinuity: number;
    doorReachM: number;
  };
}

/** 一次跑完某场景的全部候选（每个候选都走完整流水线） */
function diagnose(input: ComposeInput): { chosen: string; cands: Cand[] } {
  // 先用一次正常合成拿到候选清单
  const base = composeSite(input);
  const opts = base.infra.options;
  const cands: Cand[] = [];
  for (const o of opts) {
    const [sk, st] = o.id.split('·');
    try {
      const c = composeSite(input, { onlySkeleton: sk, only: [st] });
      const d = checkDemand(c);
      cands.push({
        sk,
        st,
        option: o,
        composed: c,
        demand: d,
        metrics: {
          parcels: c.metrics.parcels,
          buildings: c.metrics.buildings,
          coverage: +(c.metrics.coverage * 100).toFixed(1),
          roadM2: c.metrics.roadM2,
          stalls: c.metrics.stalls,
          greenShare: +(c.metrics.greenShare * 100).toFixed(1),
          frontageContinuity: +(c.metrics.frontageContinuity * 100).toFixed(0),
          doorReachM: c.metrics.doorReachM,
        },
      });
    } catch (e) {
      cands.push({ sk, st, option: o, composed: null, demand: null, error: (e as Error).message.slice(0, 120) });
    }
  }
  return { chosen: base.infra.chosen, cands };
}

// ---------------------------------------------------------------- 评分重算（回答 Q1）

const WEIGHT_KEYS = {
  通达: '通达',
  道路占地: '道路占地',
  白铺道路: '白铺道路',
  临街率: '临街率',
  残片: '残片',
  巨型地块: '巨型地块',
  组团: '保留组团',
};

function termOf(o: SkeletonOption, prefix: string): number {
  const t = o.scoreTerms.find((x) => x.k.startsWith(prefix));
  return t ? t.v : 0;
}

/** 把"道路占地"这一项的系数从 1.2 改成 k 倍后重算总分（其余不变） */
function scoreWithRoadWeight(o: SkeletonOption, factor: number): number {
  const road = termOf(o, WEIGHT_KEYS.道路占地);
  const idle = termOf(o, WEIGHT_KEYS.白铺道路);
  const base = o.scoreTerms.reduce((s, t) => s + t.v, 0);
  // 原系数 1.2 / 1.0，按 factor 缩放这两项
  return +(base - road - idle + road * factor + idle * factor).toFixed(4);
}

const SITES = [
  { id: 'R01', key: '-469:284', label: 'R01 住宅' },
  { id: 'C01', key: '176:176', label: 'C01 商业' },
  { id: 'I01', key: '252:-578', label: 'I01 工业' },
];

const out: Record<string, unknown>[] = [];

for (const site of SITES) {
  const input = inputOf(site.key);
  const { chosen, cands } = diagnose(input);
  console.log(`\n===== ${site.label}（${site.id}）  当前选定：${chosen}`);
  console.log('候选          总分   通达   路占地  白铺   临街   残片   巨型   组团 | 地块 建筑 覆盖 车位 临街连续 | 需求 失败项');
  for (const c of cands) {
    const o = c.option;
    const f = (p: string) => termOf(o, p).toFixed(3).padStart(6);
    const m = c.metrics;
    const dem = c.demand ? (c.demand.ok ? '✓' : `✗${c.demand.failed.join(',')}`) : `ERR:${c.error ?? ''}`;
    console.log(
      `${(c.sk + '·' + c.st).padEnd(26)} ${o.score.toFixed(3).padStart(5)} ${f('通达')} ${f('道路占地')} ${f('白铺')} ${f('临街')} ${f('残片')} ${f('巨型')} ${f('保留')} | ` +
        `${String(m?.parcels ?? '-').padStart(3)} ${String(m?.buildings ?? '-').padStart(3)} ${String(m?.coverage ?? '-').padStart(4)}% ${String(m?.stalls ?? '-').padStart(3)} ${String(m?.frontageContinuity ?? '-').padStart(4)}% | ${dem}`
    );
    if (c.demand && !c.demand.ok) {
      for (const it of c.demand.items.filter((x) => !x.ok)) console.log(`      ${it.code} ${it.label} → ${it.detail.slice(0, 100)}`);
    }
  }

  // ---- Q1：改权重后的排名
  const byOrig = [...cands].sort((a, b) => b.option.score - a.option.score);
  const rows = [
    { factor: 0, label: '道路成本不计' },
    { factor: 0.5, label: '道路成本减半' },
    { factor: 1, label: '现行' },
    { factor: 2, label: '道路成本加倍' },
  ].map((r) => {
    const rank = [...cands]
      .map((c) => ({ id: `${c.sk}·${c.st}`, s: scoreWithRoadWeight(c.option, r.factor), dem: c.demand?.ok ?? false }))
      .sort((a, b) => b.s - a.s);
    return { ...r, top: rank[0].id, topScore: rank[0].s, topFeasible: rank[0].dem, order: rank.map((x) => `${x.id}:${x.s.toFixed(3)}`).join(' > ') };
  });
  console.log('  Q1 权重敏感性：');
  for (const r of rows) console.log(`    ${r.label.padEnd(8)} 第一名 ${r.top} (${r.topScore}) ${r.topFeasible ? '需求可行' : '需求不可行'}`);

  // ---- Q3：同骨架下 OBB vs offset 的分项差
  const q3: Record<string, unknown>[] = [];
  for (const sk of Array.from(new Set(cands.map((c) => c.sk)))) {
    const off = cands.find((c) => c.sk === sk && c.st === 'street-front-offset');
    const obb = cands.find((c) => c.sk === sk && c.st === 'recursive-obb');
    if (!off || !obb) continue;
    q3.push({
      sk,
      off: { score: off.option.score, frontage: termOf(off.option, '临街'), parcels: off.metrics?.parcels, dem: off.demand?.ok },
      obb: { score: obb.option.score, frontage: termOf(obb.option, '临街'), parcels: obb.metrics?.parcels, dem: obb.demand?.ok },
      delta: +(off.option.score - obb.option.score).toFixed(3),
      deltaFrontage: +(termOf(off.option, '临街') - termOf(obb.option, '临街')).toFixed(3),
    });
  }
  console.log('  Q3 同骨架下 offset − OBB：');
  for (const r of q3 as Record<string, { score: number; frontage: number; parcels?: number; dem?: boolean }>[]) {
    const o = r.off;
    const b = r.obb;
    console.log(
      `    ${String(r.sk).padEnd(3)} 总分差 ${String(r.delta).padStart(6)}（其中临街项 ${String(r.deltaFrontage).padStart(6)}）| 地块 ${b.parcels} → ${o.parcels} | 需求 OBB ${b.dem ? '✓' : '✗'} / offset ${o.dem ? '✓' : '✗'}`
    );
  }

  // ---- Q4：高分但需求不可行
  const winner = cands.find((c) => `${c.sk}·${c.st}` === chosen);
  const bad4 = cands.filter((c) => c.demand && !c.demand.ok && c.option.score >= (winner?.option.score ?? 0) - 0.05);
  console.log(`  Q4 高分但需求不可行：${bad4.length === 0 ? '无' : bad4.map((c) => `${c.sk}·${c.st}(${c.option.score})✗${c.demand!.failed.join(',')}`).join(' ')}`);

  out.push({
    site: site.id,
    typology: input.typology,
    chosen,
    weights: rows,
    obbVsOffset: q3,
    winnerDemand: winner?.demand ?? null,
    cands: cands.map((c) => ({
      id: `${c.sk}·${c.st}`,
      sk: c.sk,
      st: c.st,
      score: c.option.score,
      terms: c.option.scoreTerms,
      metrics: c.option.metrics,
      reason: c.option.reason,
      rejected: c.option.rejected ?? null,
      built: c.metrics ?? null,
      demand: c.demand
        ? { ok: c.demand.ok, failed: c.demand.failed, items: c.demand.items, stats: c.demand.stats }
        : { error: c.error },
    })),
  });
}

writeFileSync(`${OUT}/diagnosis.json`, JSON.stringify({ generatedAt: new Date().toISOString(), sites: out }, null, 1));
console.log(`\n写出 ${OUT}/diagnosis.json`);
