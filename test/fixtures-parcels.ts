// F2 · Golden 几何样本（分割与布局两套测试共用）
//
// 抽出来的原因：F2.4-A 的建筑布局测试要用同一批场地，
// 两处各抄一份必然漂移（尺寸、道路等级、固定建筑位置一旦不一致，报告里的对照就失效）。

import { Pt } from '../src/core/geom';
import { surface, type PlanSurface } from '../src/town/planning/core/surface';
import { makeRoadEdge, type SubdivisionParams } from '../src/town/planning/subdivision';
import type { SiteRoadEdge, SiteTypology } from '../src/town/planning/core/types';

export // ---------------------------------------------------------------- 几何样本

const P = (x: number, y: number) => new Pt(x, y);

function rect(x0: number, y0: number, x1: number, y1: number): PlanSurface {
  return surface([P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)]);
}

/** 沿一条水平边下方 1.5 单位（≈10.5 m）放一条路中心线 */
function roadSouth(x0: number, x1: number, y: number, cls: SiteRoadEdge['cls'], key: string): SiteRoadEdge {
  return makeRoadEdge(key, P(x0, -(1.5 - y)), P(x1, -(1.5 - y)), cls);
}

export interface CaseDefRaw {
  id: string;
  shape: string;
  test: string;
  typology: SiteTypology;
  boundary: PlanSurface;
  roads: SiteRoadEdge[];
  buildings?: PlanSurface[];
  params?: Partial<SubdivisionParams>;
}

const G01: CaseDefRaw = {
  id: 'G01',
  shape: '规则矩形 140×98 m',
  test: 'OBB 多层递归',
  typology: 'generic',
  boundary: rect(0, 0, 20, 14),
  roads: [roadSouth(-0.5, 20.5, 0, 'arterial', 'south')],
};

const G02: CaseDefRaw = {
  id: 'G02',
  shape: '狭长矩形 210×49 m',
  test: '临街分排与进深',
  typology: 'generic',
  boundary: rect(0, 0, 30, 7),
  roads: [roadSouth(-0.5, 30.5, 0, 'collector', 'south')],
  params: { frontageM: 30, depthM: 32 },
};

const G03: CaseDefRaw = {
  id: 'G03',
  shape: '梯形（底 168 / 顶 98 / 深 98 m）',
  test: '非均匀面宽与退台',
  typology: 'generic',
  boundary: surface([P(0, 0), P(24, 0), P(19, 14), P(5, 14)]),
  roads: [roadSouth(-0.5, 24.5, 0, 'collector', 'south')],
};

const G04: CaseDefRaw = {
  id: 'G04',
  shape: '直角三角形（182×112 m）',
  test: '角地与尖角残片',
  typology: 'generic',
  boundary: surface([P(0, 0), P(26, 0), P(0, 16)]),
  roads: [
    roadSouth(-0.5, 26.5, 0, 'collector', 'south'),
    makeRoadEdge('west', P(-1.5, -0.5), P(-1.5, 16.5), 'local'),
  ],
  params: { frontageM: 20, depthM: 30 },
};

const G05: CaseDefRaw = {
  id: 'G05',
  shape: 'L 形凹多边形',
  test: '局部方向与残片',
  typology: 'generic',
  boundary: surface([P(0, 0), P(24, 0), P(24, 10), P(14, 10), P(14, 18), P(0, 18)]),
  roads: [roadSouth(-0.5, 24.5, 0, 'collector', 'south')],
};

const G06: CaseDefRaw = {
  id: 'G06',
  shape: '多道路围合街区（主干 + 次干 + 支路）',
  test: '主次临街归属',
  typology: 'generic',
  boundary: surface([P(0, 0), P(22, 0), P(22, 9), P(14, 15), P(0, 15)]),
  roads: [
    roadSouth(-0.5, 22.5, 0, 'arterial', 'south'),
    makeRoadEdge('east', P(23.5, -0.5), P(23.5, 9.5), 'collector'),
    makeRoadEdge('north', P(-0.5, 16.5), P(14.5, 16.5), 'local'),
  ],
  params: { frontageM: 26, depthM: 32 },
};

const G07: CaseDefRaw = {
  id: 'G07',
  shape: '带洞街区（中庭 42×42 m）',
  test: '洞与拓扑完整性',
  typology: 'generic',
  boundary: surface(
    [P(0, 0), P(24, 0), P(24, 18), P(0, 18)],
    // 洞按 CW 给（与外环相反），与 polygon-clipping 的期望一致
    [[P(9, 6), P(9, 12), P(15, 12), P(15, 6)]]
  ),
  roads: [roadSouth(-0.5, 24.5, 0, 'arterial', 'south')],
};

const G08: CaseDefRaw = {
  id: 'G08',
  shape: '固定建筑群（3 栋不可移动）',
  test: '建筑保护与功能子区',
  typology: 'generic',
  boundary: rect(0, 0, 26, 20),
  roads: [
    roadSouth(-0.5, 26.5, 0, 'arterial', 'south'),
    makeRoadEdge('east', P(27.5, -0.5), P(27.5, 20.5), 'collector'),
  ],
  buildings: [rect(2, 12, 9, 18), rect(11, 12, 17, 18), rect(19, 13, 24, 18)],
  params: { frontageM: 30, depthM: 36 },
};

export type CaseDef = CaseDefRaw;
export const CASES: CaseDef[] = [G01, G02, G03, G04, G05, G06, G07, G08];
export const CASE_BY_ID = new Map(CASES.map((c) => [c.id, c]));


