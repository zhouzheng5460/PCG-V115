// F2.4-B2 · 地块功能分配
//
// 原则（任务书第四节）：
//   · 每块地都要能解释"为什么是这个用途" —— 所以打分项必须落成数字，不能只给结论；
//   · **不得因为某块地不适合建筑就直接全部变成绿地** —— 所以分配顺序是
//     停车 → 广场 → 服务 → 建筑/组团 → 最后才是绿地，且绿地要写清用途；
//   · 配额由用地类型与总面积推，不是"每块地各来一点"。
//
// 这层只读地块的空间事实（面积 / 宽深 / 临街 / 接入 / 距街口），不改几何。

import { Pt } from '../../../core/geom';
import { surfaceArea, type PlanSurface } from '../core/surface';
import type { SiteTypology } from '../core/types';
import type { ComposeNote, FunctionScore, ParcelFunction, ParcelPlan } from './types';

const M2 = (u2: number) => u2 * 49;
const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

interface Facts {
  areaM2: number;
  bottleneckM: number;
  obbWM: number;
  obbDM: number;
  aspect: number;
  /** 真实城市道路临街（米） */
  streetM: number;
  /** 含内部道路的临街（米） */
  frontageM: number;
  /** 最强临街道路的等级分（arterial 1 / collector 0.72 / local 0.46） */
  clsScore: number;
  /** 0 = 没有车行接入，1 = 有 */
  vehicle: number;
  /** 到最近真实街口的距离（米） */
  gateM: number;
  /** 到最近内部道路中心线的距离（米） */
  internalM: number;
}

function factsOf(p: ParcelPlan): Facts {
  const m = p.candidate.metrics;
  return {
    areaM2: m.areaM2,
    bottleneckM: m.bottleneckM,
    obbWM: m.obbWM,
    obbDM: m.obbDM,
    aspect: m.aspect,
    streetM: p.streetFrontageM,
    frontageM: p.frontageM,
    clsScore: p.candidate.frontages.some((f) => f.cls === 'arterial')
      ? 1
      : p.candidate.frontages.some((f) => f.cls === 'collector')
        ? 0.72
        : 0.46,
    vehicle: p.access.some((a) => a.vehicular) ? 1 : 0,
    gateM: p.gateM,
    internalM: p.access.filter((a) => a.via === 'internal').reduce((s, a) => Math.min(s || 1e9, a.lengthM), 1e9) || 1e9,
  };
}

/**
 * 七个用途各自的适宜度。
 *
 * 每一项都是"这个用途要什么"的直接翻译：
 *   建筑要面宽和可达；组团要面积和净宽；停车要能进车但不要占着主街；
 *   广场要贴着街口和主街；绿地是**兜底**（所以它的分数里含建筑适宜度的反面）；
 *   服务要能接内部路、且不临街最好。
 */
function scoreAll(f: Facts, typology: SiteTypology): FunctionScore[] {
  const out: FunctionScore[] = [];
  const push = (fn: ParcelFunction, terms: { k: string; v: number }[]) => {
    out.push({ fn, score: terms.reduce((s, t) => s + t.v, 0), terms });
  };

  push('building', [
    { k: '面宽 0.5×min(1,临街/25)', v: 0.5 * clamp(f.streetM / 25) },
    { k: '道路等级 0.3×', v: 0.3 * f.clsScore },
    { k: '面积适中 0.5×', v: 0.5 * clamp((f.areaM2 - 250) / 1200) },
    { k: '过大不利于单栋 -0.6×', v: -0.6 * clamp((f.areaM2 - 4200) / 4200) },
    { k: '净宽 0.3×min(1,瓶颈/22)', v: 0.3 * clamp(f.bottleneckM / 22) },
    { k: '车行可达 0.15×', v: 0.15 * f.vehicle },
  ]);

  push('compound', [
    { k: '面积 0.7×clamp((A-1500)/3500)', v: 0.7 * clamp((f.areaM2 - 1500) / 3500) },
    { k: '净宽 0.45×clamp(瓶颈/34)', v: 0.45 * clamp(f.bottleneckM / 34) },
    { k: '形状紧凑 0.2×(1-|长宽比-1.6|/2)', v: 0.2 * clamp(1 - Math.abs(f.aspect - 1.6) / 2) },
    { k: '过大 -0.35×', v: -0.35 * clamp((f.areaM2 - 9000) / 6000) },
    { k: '车行可达 0.1×', v: 0.1 * f.vehicle },
  ]);

  push('parking', [
    { k: '车行可达 0.6×', v: 0.6 * f.vehicle },
    { k: '面积 0.5×clamp((A-450)/1500)', v: 0.5 * clamp((f.areaM2 - 450) / 1500) },
    { k: '占主街 -0.75×cls', v: -0.75 * f.clsScore },
    { k: '过大 -0.45×', v: -0.45 * clamp((f.areaM2 - 3200) / 3000) },
    { k: '贴街口 0.3×(1-gateM/150)', v: 0.3 * clamp(1 - f.gateM / 150) },
    { k: '净宽足够 0.2×clamp(瓶颈/20)', v: 0.2 * clamp(f.bottleneckM / 20) },
  ]);

  push('plaza', [
    { k: '贴街口 0.8×(1-gateM/80)', v: 0.8 * clamp(1 - f.gateM / 80) },
    { k: '主街可见 0.4×cls', v: 0.4 * f.clsScore },
    { k: '面积 0.3×clamp(A/1500)', v: 0.3 * clamp(f.areaM2 / 1500) },
    { k: '过大 -0.4×', v: -0.4 * clamp((f.areaM2 - 2500) / 2000) },
    { k: '面宽 0.2×clamp(临街/20)', v: 0.2 * clamp(f.streetM / 20) },
  ]);

  push('green', [
    { k: '不宜建 0.5×(1-min(1,面积/2000))', v: 0.5 * (1 - clamp(f.areaM2 / 2000)) },
    { k: '窄长 0.4×clamp((22-瓶颈)/10)', v: 0.4 * clamp((22 - f.bottleneckM) / 10) },
    { k: '不临主街 0.2×(1-cls)', v: 0.2 * (1 - f.clsScore) },
    { k: '规模 0.15×clamp(A/1200)', v: 0.15 * clamp(f.areaM2 / 1200) },
  ]);

  push('service', [
    { k: '接内部路 0.6×', v: 0.6 * clamp(1 - f.internalM / 60) },
    { k: '不占临街 0.35×(1-min(1,街道临街/20))', v: 0.35 * (1 - clamp(f.streetM / 20)) },
    { k: '面积 0.3×clamp((A-200)/800)', v: 0.3 * clamp((f.areaM2 - 200) / 800) },
    { k: '过大 -0.4×', v: -0.4 * clamp((f.areaM2 - 1600) / 1200) },
    { k: '车行可达 0.2×', v: 0.2 * f.vehicle },
  ]);

  push('reserve', [
    { k: '面积极小 0.6×(1-clamp(A/400))', v: 0.6 * (1 - clamp(f.areaM2 / 400)) },
    { k: '无接入 0.8×(1-车行)', v: 0.8 * (1 - f.vehicle) },
    { k: '基值 -0.3', v: -0.3 },
  ]);

  // 工业 / 商业对"服务"和"停车"的偏好不同：工业的后勤场地是生产的一部分，
  // 商业的集中停车是客流配套。这里只做小幅修正，不改变上面各项的含义。
  if (typology === 'industrial' || typology === 'data_center') {
    const s = out.find((x) => x.fn === 'service')!;
    s.score += 0.25;
    s.terms.push({ k: '工业需要装卸/后勤场地 +0.25', v: 0.25 });
  }
  if (typology === 'retail') {
    const s = out.find((x) => x.fn === 'parking')!;
    s.score += 0.2;
    s.terms.push({ k: '商业需要集中停车 +0.20', v: 0.2 });
  }
  if (typology === 'multi_family' || typology === 'single_family') {
    const s = out.find((x) => x.fn === 'green')!;
    s.score += 0.15;
    s.terms.push({ k: '住宅需要集中绿地 +0.15', v: 0.15 });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/** 各类用地的配额（按可建区面积的比例与最少块数） */
export interface AssignQuota {
  parkingShare: number;
  greenShare: number;
  plazaMin: number;
  serviceMin: number;
}

export function quotaFor(typology: SiteTypology): AssignQuota {
  switch (typology) {
    case 'retail':
      return { parkingShare: 0.16, greenShare: 0.07, plazaMin: 1, serviceMin: 1 };
    case 'industrial':
    case 'data_center':
      return { parkingShare: 0.08, greenShare: 0.08, plazaMin: 0, serviceMin: 1 };
    case 'civic':
      return { parkingShare: 0.12, greenShare: 0.1, plazaMin: 1, serviceMin: 0 };
    default:
      return { parkingShare: 0.1, greenShare: 0.12, plazaMin: 1, serviceMin: 0 };
  }
}

const LABEL: Record<ParcelFunction, string> = {
  building: '建筑地块',
  compound: '建筑组团',
  parking: '集中停车',
  plaza: '公共广场',
  green: '公共绿地',
  service: '服务后勤',
  reserve: '保留空间',
};

/**
 * 分配用途。
 *
 * 顺序即政策（每一条都对应任务书的一条要求）：
 *   ① 先落实"必须有的设施"（停车 / 广场 / 服务），但**只从两块地都不算好的地块里挑**
 *      —— 早先按"设施得分最高"挑，结果广场抢走了最好的临街地块（G01 实际发生过：
 *      广场 1.35 分赢过建筑 1.41 分，因为广场配额先执行）。设施是配套，不该占 C 位。
 *   ② 剩下的按 building / compound 二选一（面积与净宽决定）。
 *   ③ 绿地**不再靠配额强行转化**：早先为了让绿地占比达标，把 29%~72% 的地块改成绿地，
 *      那不是设计而是凑数。绿地改由"这块地确实不适合建（窄 / 碎 / 无法接入）"触发，
 *      街区级绿地率不足时只报告、不硬改 —— 差额由 C 阶段的组团内部绿地补。
 *   ④ 谁也放不下的（面积过小 / 无接入）才 reserve，并写明原因。
 *
 * 设施尺寸上限也是政策：停车地块不该是街区里最大的一块地
 * （实测未设上限时 G01 出现 8255 m² 的"停车场"，占可建区 72%）。
 */
export function assignFunctions(
  parcels: ParcelPlan[],
  typology: SiteTypology,
  buildableM2: number,
  notes: ComposeNote[]
): ParcelPlan[] {
  const quota = quotaFor(typology);
  const facts = new Map(parcels.map((p) => [p.id, factsOf(p)]));
  const scores = new Map(parcels.map((p) => [p.id, scoreAll(facts.get(p.id)!, typology)]));
  const scoreOf = (id: string, fn: ParcelFunction) => scores.get(id)!.find((s) => s.fn === fn)!.score;
  /** 这块地"当建筑用"的净价值：building 与 compound 取高者 */
  const quality = (id: string) => Math.max(scoreOf(id, 'building'), scoreOf(id, 'compound'));
  const taken = new Set<string>();

  const assign = (p: ParcelPlan, fn: ParcelFunction, prefix = '') => {
    taken.add(p.id);
    const ranked = scores.get(p.id)!;
    const mine = ranked.find((s) => s.fn === fn)!;
    const runner = ranked.filter((s) => s.fn !== fn)[0];
    p.fn = fn;
    p.ranked = ranked;
    const f = facts.get(p.id)!;
    p.reason =
      `${prefix}${LABEL[fn]}：${f.areaM2.toFixed(0)} m² · 瓶颈净宽 ${f.bottleneckM.toFixed(1)} m · ` +
      `临街 ${f.streetM.toFixed(1)} m（${f.clsScore >= 1 ? '主干道' : f.clsScore >= 0.7 ? '次干道' : '支路'}）· ` +
      `距街口 ${f.gateM.toFixed(0)} m · ` +
      `${fn} 得分 ${mine.score.toFixed(2)}${runner ? `，次选 ${runner.fn} ${runner.score.toFixed(2)}` : ''}`;
    notes.push({ code: 'function', severity: 'info', message: `${p.id} → ${LABEL[fn]}（${mine.score.toFixed(2)}）` });
  };

  /**
   * 挑一块地做设施。
   *
   * 两遍：先只在"当建筑用不划算"的地块里挑（quality < 0.95），
   * 挑不到才放开 —— 放开也要按"建筑价值升序"排，尽量别抢临街面。
   */
  const pickFacility = (fn: ParcelFunction, ok: (f: Facts) => boolean): ParcelPlan | null => {
    const pool = parcels.filter((p) => !taken.has(p.id) && ok(facts.get(p.id)!));
    if (pool.length === 0) return null;
    const sortBy = (a: ParcelPlan, b: ParcelPlan) =>
      quality(a.id) - quality(b.id) || scoreOf(b.id, fn) - scoreOf(a.id, fn) || a.id.localeCompare(b.id);
    const cheap = pool.filter((p) => quality(p.id) < 0.95).sort(sortBy);
    if (cheap.length > 0) return cheap[0];
    return pool.sort(sortBy)[0];
  };

  // ① 必须有的设施
  const parkingTarget = buildableM2 * quota.parkingShare;
  const parkMax = Math.min(3200, Math.max(900, parkingTarget * 1.4));
  const parkMin = Math.max(420, Math.min(900, parkingTarget * 0.55));
  let parkingM2 = 0;
  /**
   * 停车地块的规模窗口，两档。
   *
   * 第一档是"正常规模"（约 20~90 个车位）。但街区的地块是分割出来的，
   * 不一定恰好落在窗口里（实测 G07 的地块要么 500 m² 要么 5450 m²，一档全落空，
   * 结果整个街区 0 车位）。第二档把下界放宽到 320 m²（约 12 个位），
   * 宁可停车偏小，也不能"没有停车"。
   */
  const parkRanges: [number, number][] = [
    [parkMin, parkMax],
    [Math.max(320, parkMin * 0.45), Math.min(4200, parkMax * 1.35)],
  ];
  for (const [lo, hi] of parkRanges) {
    for (let guard = 0; guard < 4 && parkingM2 < parkingTarget * 0.8; guard++) {
      const left = parkingTarget - parkingM2;
      const p = pickFacility('parking', (f) => f.vehicle > 0 && f.areaM2 >= lo && f.areaM2 <= Math.max(hi, left * 1.25) && f.bottleneckM >= 13);
      if (!p) break;
      assign(p, 'parking', `停车需求 ${parkingTarget.toFixed(0)} m²（${(quota.parkingShare * 100).toFixed(0)}% 可建区）：`);
      parkingM2 += facts.get(p.id)!.areaM2;
    }
    if (parkingM2 > 0) break;
  }
  if (parkingM2 < parkingTarget * 0.5) {
    notes.push({
      code: 'function',
      severity: 'warn',
      message: `集中停车只落实 ${parkingM2.toFixed(0)} m² / 目标 ${parkingTarget.toFixed(0)} m²：没有合适规模的地块，余量留给建筑地块的路侧停车`,
    });
  }
  for (let i = 0; i < quota.plazaMin; i++) {
    const p = pickFacility('plaza', (f) => f.areaM2 >= 350 && f.areaM2 <= 2600 && f.streetM >= 8);
    if (p) assign(p, 'plaza', '需要一处有街面可见性的公共广场：');
  }
  for (let i = 0; i < quota.serviceMin; i++) {
    const p = pickFacility('service', (f) => f.vehicle > 0 && f.areaM2 >= 250 && f.areaM2 <= 1800);
    if (p) assign(p, 'service', '需要一处接内部路的后勤场地：');
  }

  // ② 剩下的：建筑 / 组团
  const rest = parcels.filter((p) => !taken.has(p.id)).sort((a, b) => b.candidate.metrics.areaM2 - a.candidate.metrics.areaM2);
  for (const p of rest) {
    const f = facts.get(p.id)!;
    if (f.vehicle === 0 && f.areaM2 > 300) {
      const alt: ParcelFunction = scoreOf(p.id, 'service') >= scoreOf(p.id, 'green') ? 'service' : 'green';
      assign(p, alt, '无车行接入，不能当独立建筑地块：');
      notes.push({ code: 'access-fail', severity: 'warn', message: `${p.id} 无可车行接入，未按建筑地块分配` });
      continue;
    }
    const sB = scoreOf(p.id, 'building');
    const sC = scoreOf(p.id, 'compound');
    if (sC > sB && f.areaM2 >= 1800) assign(p, 'compound');
    else assign(p, 'building');
  }

  // ③ 确实不适合建的地块 → 绿地 / 保留（不是配额驱动，是空间事实驱动）
  for (const p of parcels) {
    if (taken.has(p.id)) continue;
    const f = facts.get(p.id)!;
    if (f.areaM2 < 260 || f.bottleneckM < 11) {
      assign(p, 'reserve', '面积/净宽不足以承载任何独立用途：');
    }
  }
  return parcels;
}

/** 供出图用：取一块地的"临街参考边"（最长的那条城市道路临街） */
export function primeFrontageEdge(p: ParcelPlan): [Pt, Pt] | null {
  let best: { len: number; e: [Pt, Pt] } | null = null;
  for (const f of p.candidate.frontages) {
    if (!best || f.lengthM > best.len) best = { len: f.lengthM, e: f.edge };
  }
  return best ? best.e : null;
}

/** 地块面积（m²） */
export function parcelAreaM2(p: ParcelPlan): number {
  return M2(surfaceArea(p.surface));
}

export type { PlanSurface };
