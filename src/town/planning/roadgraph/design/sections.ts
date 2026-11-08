// F2.5-D · 断面配置（游戏风格参数，不冒充法定规范）
//
// 车行道宽度**不在这里**：它来自 C.1 的 RoadEdge.widthM（可追溯到等级表），
// 这里只给"路缘之外的附属面"：人行道、绿带、收边。
// 这样"路面宽度"只有一个来源，不会出现两套数字互相打架。

import type { RoadClass } from '../types';
import type { StyleId } from '../select';

export type { StyleId };

export interface SectionSpec {
  /** 单侧人行道（米） */
  walkM: number;
  /** 单侧绿带（米） */
  vergeM: number;
  /** 路缘收边（米，纯视觉） */
  curbM: number;
}

const TABLE: Record<StyleId, Record<RoadClass, SectionSpec>> = {
  organic: {
    arterial: { walkM: 2.4, vergeM: 1.8, curbM: 0.3 },
    collector: { walkM: 2.0, vergeM: 1.4, curbM: 0.25 },
    local: { walkM: 1.5, vergeM: 1.0, curbM: 0.2 },
    internal: { walkM: 0.8, vergeM: 0.6, curbM: 0.15 },
  },
  structured: {
    arterial: { walkM: 3.4, vergeM: 1.0, curbM: 0.3 },
    collector: { walkM: 2.6, vergeM: 0.9, curbM: 0.25 },
    local: { walkM: 2.0, vergeM: 0.7, curbM: 0.2 },
    internal: { walkM: 1.0, vergeM: 0.5, curbM: 0.15 },
  },
  campus: {
    arterial: { walkM: 1.8, vergeM: 3.0, curbM: 0.3 },
    collector: { walkM: 1.6, vergeM: 2.4, curbM: 0.25 },
    local: { walkM: 1.2, vergeM: 1.8, curbM: 0.2 },
    internal: { walkM: 0.8, vergeM: 1.2, curbM: 0.15 },
  },
};

export function sectionFor(cls: RoadClass, style: StyleId): SectionSpec & { carriageM: number } {
  const s = TABLE[style][cls] ?? TABLE.organic.local;
  return { ...s, carriageM: 0 };
}

/** 路侧总宽（单侧）：人行道 + 绿带 */
export function sideWidthM(section: { walkM: number; vergeM: number }): number {
  return section.walkM + section.vergeM;
}
