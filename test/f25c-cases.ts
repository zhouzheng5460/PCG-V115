// F2.5-C.1 · 七个 Golden 的统一定义
//
// 上游输入一旦不一致，图上的差异就分不清是算法改动还是输入改动。
// 与 f25-golden.ts 用的是同一批样板，只是把真实道路与开口也带进来
// （诊断要回答"有没有接进真实城市道路"，没有道路输入就答不了）。

import { Pt } from '../src/core/geom';
import { surface, type PlanSurface } from '../src/town/planning/core/surface';
import type { SiteRoadEdge } from '../src/town/planning/core/types';
import type { StyleId } from '../src/town/planning/roadgraph';
import { CASE_BY_ID } from './fixtures-parcels';
import { inputOf } from './compose-inputs';

export interface F25Case {
  id: string;
  label: string;
  /** 这一片的形态说明（报告与图上都用） */
  shape: string;
  boundary: PlanSurface;
  style: StyleId;
  /** 破碎目标 cell 面积（m²）——只影响 cell 大小 */
  cellM2: number;
  /** 真实城市道路（真实地块才有） */
  roads?: SiteRoadEdge[];
  entrances?: Pt[];
}

/** 狭长楔形：160 m 长、一端 26 m 一端 12 m */
function wedge(): PlanSurface {
  const m = (v: number) => v / 7;
  return surface([new Pt(m(0), m(0)), new Pt(m(160), m(6)), new Pt(m(160), m(18)), new Pt(m(0), m(26))]);
}

const real = (id: string): { roads: SiteRoadEdge[]; entrances: Pt[] } => {
  const inp = inputOf(id);
  return { roads: inp.roadEdges, entrances: inp.vehicleEntrances };
};

export const F25_CASES: F25Case[] = [
  { id: 'F01', label: '规则矩形 140×98 m', shape: '规则', boundary: CASE_BY_ID.get('G01')!.boundary, style: 'organic', cellM2: 1800 },
  { id: 'F02', label: '狭长楔形 160×26 m', shape: '楔形', boundary: wedge(), style: 'organic', cellM2: 3000 },
  { id: 'F03', label: '不规则 L 形（G05）', shape: 'L 形', boundary: CASE_BY_ID.get('G05')!.boundary, style: 'organic', cellM2: 1800 },
  { id: 'F04', label: '带洞街区（G07）', shape: '带洞', boundary: CASE_BY_ID.get('G07')!.boundary, style: 'organic', cellM2: 1800 },
  { id: 'R01', label: 'R01 住宅 -469:284', shape: '真实住宅', boundary: inputOf('R01').boundary, style: 'organic', cellM2: 1800, ...real('R01') },
  { id: 'C01', label: 'C01 商业 176:176', shape: '真实商业', boundary: inputOf('C01').boundary, style: 'structured', cellM2: 1700, ...real('C01') },
  { id: 'I01', label: 'I01 工业 252:-578', shape: '真实工业', boundary: inputOf('I01').boundary, style: 'campus', cellM2: 3600, ...real('I01') },
];

export const CASE_OF = new Map(F25_CASES.map((c) => [c.id, c]));
