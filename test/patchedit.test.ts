// 单块地块编辑回归：走「选中一块地 → 改用途 / 高度 / 切分」这条链路。
//
// 这条链路的关键在于**它是加法**：自动分档（planLandUse）照常跑完整座城，
// 覆盖只在那之后把某几块的结果换掉。于是有三条不变量必须成立：
//   ① 改一块 = 只影响这一块，别的地块一栋楼都不能动；
//   ② 清掉覆盖 = 回到原样（否则用户"手滑改了又撤销"永远回不去）；
//   ③ 三个旋钮各自真的管事：用途换 ward、高度翻倍、切分块数变多。
// 第 ③ 条最容易出现"面板能点、模型不理"的假接线，所以必须逐项验量。

import { Model } from '../src/town/model';
import { patchKey, type PatchEdit } from '../src/town/patch';
import type { LandUse } from '../src/scene/types';
import { ROAD_SPECS, u } from '../src/road/spec';
import type { Pt } from '../src/core/geom';

let fail = 0;
let n = 0;
function ok(cond: boolean, msg: string) {
  n++;
  if (!cond) {
    console.log(`  FAIL ${msg}`);
    fail++;
  }
}

const STYLE = {
  mainStreetWidth: u(ROAD_SPECS.arterial.redLine),
  regularStreetWidth: u(ROAD_SPECS.collector.redLine),
  alleyWidth: u(ROAD_SPECS.local.redLine),
};

/** 一块地上实际盖出来的东西（从 ward 的 lot 读，渲染和导出都读同一个） */
interface Built {
  use: LandUse;
  count: number;
  /** 所有体量的高度总和：只改高度倍率时，这个数应该整体等比放大 */
  hSum: number;
  /** 每栋的高度，用来比对"一栋都没多一栋都没少" */
  hs: number[];
}

type WardLike = { use: LandUse; lot: { solids: { ring: Pt[]; h: number }[] } | null };

function builtOf(m: Model, key: string): Built | null {
  const p = m.patches.find((q) => patchKey(q) === key);
  if (!p) return null;
  const w = p.ward as unknown as WardLike | null;
  if (!w) return null;
  const solids = w.lot?.solids ?? [];
  return {
    use: w.use,
    count: solids.length,
    hSum: solids.reduce((a, s) => a + s.h, 0),
    hs: solids.map((s) => s.h),
  };
}

function run(edits: Map<string, PatchEdit>, seed = 682063530): Model {
  const m = new Model({ nPatches: 15, seed, plaza: true, style: STYLE, patchEdits: edits });
  m.generate();
  return m;
}

const base = run(new Map());
ok(base.patches.length > 10, `基准城有 ${base.patches.length} 块地`);

// 挑一块"真的盖了楼、又不是禁建区"的地当探针。挑最大的一栋，量最清楚。
let probeKey = '';
let probeMax = 0;
for (const p of base.patches) {
  if (p.blocked) continue;
  const b = builtOf(base, patchKey(p));
  if (!b || b.count === 0) continue;
  if (b.hSum > probeMax) {
    probeMax = b.hSum;
    probeKey = patchKey(p);
  }
}
ok(probeKey !== '', `找到探针地块 ${probeKey}（总高 ${probeMax.toFixed(2)}u）`);

const b0 = builtOf(base, probeKey)!;
console.log(
  `  探针基线：用途 ${b0.use} / ${b0.count} 栋 / 总高 ${b0.hSum.toFixed(2)}u / 单栋 ${b0.hs
    .map((h) => h.toFixed(1))
    .join(',')}`
);

/** 除探针之外所有地块的建筑指纹：任何一项变了就说明"改一块动了全城" */
function othersFingerprint(m: Model): string {
  const parts: string[] = [];
  for (const p of m.patches) {
    const k = patchKey(p);
    if (k === probeKey) continue;
    const b = builtOf(m, k);
    parts.push(`${k}|${b ? `${b.use}|${b.count}|${b.hSum.toFixed(3)}` : 'none'}`);
  }
  return parts.join(';');
}
const others0 = othersFingerprint(base);

// ---------------------------------------------------------------- ① 改用途
{
  const m = run(new Map([[probeKey, { use: 'commercial' }]]));
  const b = builtOf(m, probeKey)!;
  ok(b.use === 'commercial', `用途改成 commercial（得到 ${b.use}）`);
  ok(b.use !== b0.use, `用途确实变了（${b0.use} → ${b.use}）`);
  ok(b.count > 0, `改用途后仍然盖得出楼（${b.count} 栋）`);
  ok(othersFingerprint(m) === others0, '别的 60 多块地一栋都没动');
  const p = m.patches.find((q) => patchKey(q) === probeKey)!;
  ok(p.override?.use === 'commercial', 'patch.override 上留了痕（面板据此回显）');
}

// ---------------------------------------------------------------- ② 改高度倍率
{
  const m = run(new Map([[probeKey, { heightK: 2 }]]));
  const b = builtOf(m, probeKey)!;
  ok(b.count === b0.count, `栋数不变（${b.count} = ${b0.count}，只拔高不新增）`);
  const ratio = b0.hSum > 1e-6 ? b.hSum / b0.hSum : 0;
  ok(Math.abs(ratio - 2) < 1e-6, `总高精确翻倍（×${ratio.toFixed(3)}）`);
  ok(b.hs.every((h, i) => Math.abs(h - b0.hs[i] * 2) < 1e-6), '每一栋都翻倍，不是只拔高了最高的那栋');
  ok(othersFingerprint(m) === others0, '别的地块高度不受影响');
}

// ---------------------------------------------------------------- ③ 改切分块数
{
  // 「切得更碎 → 多出小地块 → 多出楼」这条只对**住宅**成立。
  // cbd / commercial 的小地块走"塔楼 + 裙房"，切碎之后塔楼放不下，栋数反而变少
  // （实测同一块 cbd：16 块 13 栋、24 块 10 栋）。所以切分这条不能拿
  // "总高最大的地块"当探针（它常常是 cbd），要单独挑一块面积最大的住宅。
  //
  // 另外：自动切分按**沿街面宽**（住宅 `parcelPitchM` 26 m）+ 进深 40 m 上限排布，
  // 一块 300~470 单位²（1.5~2.3 万 m²）的住宅街区自动就切出 15~20 个地块。
  // 所以"切成 16 块"反而比自动更粗，栋数不会增加 —— 目标块数要比自动细一档。
  let splitKey = '';
  let splitA = 0;
  for (const q of base.patches) {
    if (q.blocked) continue;
    const w = q.ward as unknown as WardLike | null;
    if (!w || w.use !== 'residential') continue;
    if (!builtOf(base, patchKey(q))?.count) continue;
    let s = 0;
    const ring = Array.from(q.shape);
    for (let i = 0; i < ring.length; i++) {
      const n2 = ring[(i + 1) % ring.length];
      s += ring[i].x * n2.y - n2.x * ring[i].y;
    }
    const a = Math.abs(s) / 2;
    if (a > splitA) {
      splitA = a;
      splitKey = patchKey(q);
    }
  }
  ok(splitKey !== '', `找到住宅切分探针 ${splitKey}（${splitA.toFixed(0)} 单位²）`);

  const s0 = builtOf(base, splitKey)!;
  // 32 块 ≈ 每块 13~15 单位²（约 650~730 m²），比自动细一档
  const m = run(new Map([[splitKey, { parcelTargetA: splitA / 32 }]]));
  const b = builtOf(m, splitKey)!;
  ok(b.count > s0.count, `切成 32 块后栋数变多（${s0.count} → ${b.count}）`);
  ok(builtOf(m, probeKey)!.hSum === b0.hSum, '别的探针地块一栋都没动');

  // 目标面积给得越大 → 块数越少，直到 1 块
  const big = run(new Map([[splitKey, { parcelTargetA: splitA * 4 }]]));
  const bb = builtOf(big, splitKey)!;
  ok(bb.count <= b.count, `目标面积越大块数越少（${b.count} → ${bb.count}）`);
  ok(bb.count >= 1, `再大也至少留 1 栋（${bb.count}）`);
}

// ---------------------------------------------------------------- ④ 清掉覆盖 = 回原样
{
  const m = run(new Map());
  ok(builtOf(m, probeKey)!.hSum === b0.hSum, '同样的参数再跑一遍，结果逐位相同（可复现）');

  // 先改再删：删除等于"这张表里没有这一条"
  const edits = new Map<string, PatchEdit>([[probeKey, { use: 'commercial', heightK: 1.8 }]]);
  const changed = run(edits);
  ok(builtOf(changed, probeKey)!.use === 'commercial', '改过之后确实是商业');
  edits.delete(probeKey);
  const back = run(edits);
  ok(builtOf(back, probeKey)!.use === b0.use, `删掉覆盖后用途回到 ${b0.use}`);
  ok(Math.abs(builtOf(back, probeKey)!.hSum - b0.hSum) < 1e-9, '删掉覆盖后高度回到原样');
  ok(othersFingerprint(back) === others0, '删掉覆盖后全城回到原样');
}

// ---------------------------------------------------------------- ⑤ 禁建区地块不吃覆盖
{
  // 找一个被禁建区压住的地块（有禁区才有；没有就跳过，不算失败）
  const zone1 = run(new Map(), 991337);
  const blocked = zone1.patches.filter((q) => q.blocked);
  if (blocked.length > 0) {
    const k = patchKey(blocked[0]);
    const m = new Model({
      nPatches: 15,
      seed: 991337,
      plaza: true,
      style: STYLE,
      patchEdits: new Map([[k, { use: 'cbd', heightK: 2 }]]),
    });
    m.generate();
    const p = m.patches.find((q) => patchKey(q) === k)!;
    ok(p.blocked, '禁区内的地块重建后仍然是禁建态');
    ok(!p.ward, '禁建地块不排建筑 —— 覆盖也变不出楼来');
  } else {
    console.log('  （这个种子没有禁建地块，跳过 ⑤）');
  }
}

console.log(fail === 0 ? `\n# PASS — ${n} 项断言，0 项失败` : `\n# FAIL — ${n} 项断言，${fail} 项失败`);
if (fail > 0) process.exit(1);
