// F2.4-C · 设计标尺（station frame）
//
// 手工 Target Plan 不能直接在世界坐标里摆数字 —— 三个场地的红线都是弧形的，
// 一条"沿街 80 m"的店面在直线坐标里会很快跑出红线。
//
// 所以先建立一把**弧形标尺**：沿地块长轴按等距取样，每个站点求出
// 该处的法向跨度，取中点与半宽。之后所有设计元素都用 (s, t) 表达：
//   s = 沿长轴的里程（米，从西端算），t = 相对中心线的横向偏移（米，正 = 北/左）
// 这把尺子只描述"场地怎么长"，不做任何布局决策 —— 决策全在 Target Plan 的数字里。

import { Pt } from '../../../core/geom';
import { insideSurface, surfaceArea, type PlanSurface } from '../core/surface';
import { obbOf } from '../subdivision/geom';

export interface Station {
  /** 里程（米，从长轴一端算） */
  s: number;
  /** 中心点（世界坐标） */
  at: Pt;
  /** 切向（弧度，指向 s 增大方向） */
  tangent: number;
  /** 法向（= tangent + 90°，指向 t 增大方向） */
  normal: Pt;
  /** 该站点的可用半宽（米） */
  halfW: number;
}

export interface Frame {
  /** 长轴角度（弧度） */
  ang: number;
  stations: Station[];
  /** 总长（米） */
  lengthM: number;
  /** 由 (s,t) 求世界坐标 */
  at(s: number, t: number): Pt;
  /** 由 (s,t) 求该处切向角 */
  angAt(s: number): number;
}

/**
 * 建标尺。
 *
 * 取样密度 3 m：比任何建筑进深都细一个量级，插值误差可以忽略。
 * 每个站点沿法向扫描求"最长内部区间"—— L 形/弧形的场地因此也能得到
 * 一条真正落在场地里的中心线，而不是包围盒的中线。
 */
export function makeFrame(parcel: PlanSurface, stationStepM = 3): Frame {
  const ob = obbOf(parcel.outer);
  if (!ob) throw new Error('frame: 无法求外接矩形');
  const ang = Math.atan2(ob.uy, ob.ux);
  const ux = Math.cos(ang);
  const uy = Math.sin(ang);
  const vx = -uy;
  const vy = ux;
  const halfL = ob.w / 2;
  const halfD = ob.d / 2;
  const stepU = (stationStepM / 7);

  const raw: { at: Pt; tangent: number; halfW: number }[] = [];
  for (let u = -halfL; u <= halfL + 1e-9; u += stepU) {
    // 沿法向扫描，找落在场地内的区间（可能有多个，取最长）
    const base = new Pt(ob.cx + ux * u, ob.cy + uy * u);
    const runs: [number, number][] = [];
    let start: number | null = null;
    const scan = 0.25; // 世界单位步长（≈1.75 m）
    for (let v = -halfD - 0.5; v <= halfD + 0.5; v += scan / 7) {
      const q = new Pt(base.x + vx * v, base.y + vy * v);
      const ins = insideSurface(q, parcel);
      if (ins && start === null) start = v;
      if (!ins && start !== null) {
        runs.push([start, v - scan / 7]);
        start = null;
      }
    }
    if (start !== null) runs.push([start, halfD + 0.5]);
    if (runs.length === 0) continue;
    runs.sort((a, b) => b[1] - b[0] - (a[1] - a[0]));
    const [v0, v1] = runs[0];
    const vc = (v0 + v1) / 2;
    const halfW = ((v1 - v0) / 2) * 7;
    if (halfW * 2 < 6) continue;
    raw.push({
      at: new Pt(base.x + vx * vc, base.y + vy * vc),
      tangent: ang,
      halfW,
    });
  }
  if (raw.length < 2) throw new Error('frame: 取样不足');

  // 里程积分
  const stations: Station[] = [];
  let s = 0;
  for (let i = 0; i < raw.length; i++) {
    if (i > 0) s += Pt.distance(raw[i - 1].at, raw[i].at) * 7;
    // 切向用相邻站点差分（弧形的真实走向），端点退化为长轴方向
    let tangent = ang;
    if (i > 0 && i < raw.length - 1) {
      tangent = Math.atan2(raw[i + 1].at.y - raw[i - 1].at.y, raw[i + 1].at.x - raw[i - 1].at.x);
    } else if (i === 0) {
      tangent = Math.atan2(raw[1].at.y - raw[0].at.y, raw[1].at.x - raw[0].at.x);
    } else {
      tangent = Math.atan2(raw[i].at.y - raw[i - 1].at.y, raw[i].at.x - raw[i - 1].at.x);
    }
    const n = new Pt(-Math.sin(tangent), Math.cos(tangent));
    stations.push({ s, at: raw[i].at, tangent, normal: n, halfW: raw[i].halfW });
  }
  const total = stations[stations.length - 1].s;

  const findIdx = (sv: number): number => {
    if (sv <= stations[0].s) return 0;
    if (sv >= total) return stations.length - 2;
    let lo = 0;
    let hi = stations.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (stations[mid].s <= sv) lo = mid;
      else hi = mid;
    }
    return lo;
  };

  return {
    ang,
    stations,
    lengthM: total,
    at(sv: number, t: number): Pt {
      const i = findIdx(sv);
      const a = stations[i];
      const b = stations[i + 1] ?? a;
      const f = Math.max(0, Math.min(1, (sv - a.s) / Math.max(1e-9, b.s - a.s)));
      const cx = a.at.x + (b.at.x - a.at.x) * f;
      const cy = a.at.y + (b.at.y - a.at.y) * f;
      const nx = a.normal.x + (b.normal.x - a.normal.x) * f;
      const ny = a.normal.y + (b.normal.y - a.normal.y) * f;
      const nl = Math.hypot(nx, ny) || 1;
      return new Pt(cx + (nx / nl) * (t / 7), cy + (ny / nl) * (t / 7));
    },
    angAt(sv: number): number {
      const i = findIdx(sv);
      const a = stations[i];
      const b = stations[i + 1] ?? a;
      const f = Math.max(0, Math.min(1, (sv - a.s) / Math.max(1e-9, b.s - a.s)));
      let d = b.tangent - a.tangent;
      while (d > Math.PI / 2) d -= Math.PI;
      while (d < -Math.PI / 2) d += Math.PI;
      return a.tangent + d * f;
    },
  };
}

/** 站点处的可用半宽（米），用于判断元素是否放得下 */
export function halfWAt(f: Frame, sv: number): number {
  if (f.stations.length === 0) return 0;
  let best = f.stations[0];
  for (const st of f.stations) if (Math.abs(st.s - sv) < Math.abs(best.s - sv)) best = st;
  return best.halfW;
}

/** 场地面积（m²），供设计校核 */
export function areaM2(s: PlanSurface): number {
  return surfaceArea(s) * 49;
}
