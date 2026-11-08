// F2.5-B · 道路等级与路幅分级
//
// 谁是路，由 F2.5-C 的**合并**决定（合并掉一条边 = 这条边不是路）。
// 这一层只回答另一个问题：留下来的边里，哪条是主干、哪条是支路。
//
// 分级的依据是"这条边在网络里承担多少"：
//   · 长度
//   · 是否接进生成范围边界（接边 = 对城市开放，通常是主路）
//   · 两端还有多少条别的边（枢纽度）
//   · 风格偏好（structured 偏好对齐主方向）

import { Pt } from '../../../core/geom';
import type { Cut } from './fracture';
import { CLASS_RANK, type RoadClass } from './types';

export type StyleId = 'organic' | 'structured' | 'campus';

export interface StylePreset {
  id: StyleId;
  label: string;
  /** 合并目标街区面积区间（m²） */
  blockM2: [number, number];
  /** 短于此长度的边优先合并掉（米） */
  weakEdgeM: number;
  /** 长于此长度的边视为主路，不合并（米） */
  strongEdgeM: number;
  /** 偏好对齐的方向（不填则取 0） */
  alignWeight: number;
  width: Record<RoadClass, number>;
}

export const STYLES: Record<StyleId, StylePreset> = {
  organic: {
    id: 'organic',
    label: 'A · Organic District（住宅园区 / 老城）',
    blockM2: [900, 5200],
    weakEdgeM: 36,
    strongEdgeM: 100,
    alignWeight: 0,
    width: { arterial: 13, collector: 9, local: 7, internal: 5 },
  },
  structured: {
    id: 'structured',
    label: 'B · Structured Urban（商业 / CBD）',
    blockM2: [700, 4200],
    weakEdgeM: 30,
    strongEdgeM: 115,
    alignWeight: 0.22,
    width: { arterial: 16, collector: 11, local: 8, internal: 6 },
  },
  campus: {
    id: 'campus',
    label: 'C · Campus / Industrial（产业园 / 学校）',
    blockM2: [2600, 14000],
    weakEdgeM: 55,
    strongEdgeM: 150,
    alignWeight: 0.1,
    width: { arterial: 14, collector: 10, local: 8, internal: 7 },
  },
};

export interface ClassifyOpts {
  style: StylePreset;
  boundaryRings: Pt[][];
  areaM2: number;
  mainAxis?: number;
  /**
   * 连通骨架边：同样的长度与位置，它在网络里承担得更多（要接住整片场地的
   * 服务距离），所以评分加权。加权只影响"哪条更像主路"，不改几何。
   */
  spineCuts?: Set<string>;
  spineBonus?: number;
  /** 真实城市道路开口附近的半径（米）：从这里出去的路天然是主路 */
  accessAt?: Pt[];
  accessRadiusM?: number;
}

export interface ClassifyResult {
  cuts: Cut[];
  density: number;
  byClass: Record<RoadClass, number>;
  lengthM: number;
}

export function classifyRoads(cuts: Cut[], opts: ClassifyOpts): ClassifyResult {
  const st = opts.style;
  const axis = opts.mainAxis ?? 0;
  const maxLen = Math.max(1, ...cuts.map((c) => c.lenM));
  const hubGrid = new Map<string, number>();
  const hubKey = (p: Pt) => `${Math.round(p.x / 1.2)},${Math.round(p.y / 1.2)}`;
  for (const c of cuts) for (const p of [c.a, c.b]) hubGrid.set(hubKey(p), (hubGrid.get(hubKey(p)) ?? 0) + 1);

  const spineBonus = opts.spineBonus ?? 0.28;
  const accessAt = opts.accessAt ?? [];
  const accessR = (opts.accessRadiusM ?? 30) / 7;

  const scored = cuts.map((c) => {
    const lenNorm = c.lenM / maxLen;
    const touch = (onBoundary(c.a, opts.boundaryRings) ? 1 : 0) + (onBoundary(c.b, opts.boundaryRings) ? 1 : 0);
    const hub = Math.min(1, ((hubGrid.get(hubKey(c.a)) ?? 1) + (hubGrid.get(hubKey(c.b)) ?? 1)) / 7);
    const ang = Math.atan2(c.b.y - c.a.y, c.b.x - c.a.x);
    let dev = Math.abs(((ang - axis + Math.PI / 2) % (Math.PI / 2)) - Math.PI / 4);
    dev = Math.abs(Math.PI / 4 - dev) / (Math.PI / 4);
    // 骨架边 & 真实开口：两项都是"这条边在网络里的地位"，与长度无关
    const isSpine = opts.spineCuts?.has(c.id) ? 1 : 0;
    const nearAccess = accessAt.some((p) => Pt.distance(p, c.a) <= accessR || Pt.distance(p, c.b) <= accessR) ? 1 : 0;
    const score =
      0.46 * lenNorm + 0.24 * (touch / 2) + 0.18 * hub + st.alignWeight * (1 - dev) + spineBonus * isSpine + 0.12 * nearAccess;
    return { c, score };
  });
  scored.sort((a, b) => b.score - a.score || a.c.id.localeCompare(b.c.id));

  const byClass: Record<RoadClass, number> = { arterial: 0, collector: 0, local: 0, internal: 0 };
  scored.forEach((item, i) => {
    const t = i / Math.max(1, scored.length);
    const touches = onBoundary(item.c.a, opts.boundaryRings) || onBoundary(item.c.b, opts.boundaryRings);
    const cls: RoadClass = t < 0.16 || (touches && item.c.lenM > 55) ? 'arterial' : t < 0.46 ? 'collector' : 'local';
    item.c.cls = cls;
    item.c.widthM = st.width[cls];
    byClass[cls]++;
  });

  const lengthM = cuts.reduce((s, c) => s + c.lenM, 0);
  return { cuts, density: (lengthM / opts.areaM2) * 10000, byClass, lengthM };
}

/** 主方向：取所有边长度加权的方向（按 90° 折叠），给 structured 用 */
export function dominantAxis(cuts: Cut[]): number {
  let sx = 0;
  let sy = 0;
  for (const c of cuts) {
    const a = Math.atan2(c.b.y - c.a.y, c.b.x - c.a.x) * 2; // 折叠到 180°
    sx += Math.cos(a) * c.lenM;
    sy += Math.sin(a) * c.lenM;
  }
  return Math.atan2(sy, sx) / 2;
}

export { CLASS_RANK };

function onBoundary(p: Pt, rings: Pt[][]): boolean {
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l2 = dx * dx + dy * dy;
      if (l2 < 1e-12) continue;
      let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
      t = Math.max(0, Math.min(1, t));
      if (Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)) * 7 <= 2.5) return true;
    }
  }
  return false;
}
