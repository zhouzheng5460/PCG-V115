// F2.4-A · 各类型的建筑程序（program）
//
// "程序"= 这块地该放几栋、每栋多大、什么姿态。
// 它回答的正是任务书禁止的那件事：**不能所有类型都机械居中放一栋**。
//
// 尺度不新拍：商业 22 m 进深用 `SHOP_DEPTH_M`，院落 18×16 用 `COURT_MIN_W/D_M`，
// 工业 55 m 厂房沿用 `adapters/subdivide.ts` 注释里的口径。

import type { Pt } from '../../../core/geom';
import type { SiteTypology } from '../core/types';
import { COURT_MIN_D_M, COURT_MIN_W_M } from '../typologies/multifamily';
import { SHOP_DEPTH_M } from '../typologies/retail';
import type { BuildingKind, LayoutParams } from './types';

/** 建筑相对场地的姿态：决定它的**偏好中心**由什么几何量推出 */
export type Posture = 'street' | 'rear' | 'center' | 'court-n' | 'court-s' | 'court-e' | 'court-w';

export interface SlotSpec {
  kind: BuildingKind;
  /** 目标面宽 / 进深（米） */
  widthM: number;
  depthM: number;
  posture: Posture;
  /** 同分时的稳定序（数字小的先放） */
  priority: number;
  /** 人话：为什么要这样摆（进报告） */
  why: string;
  /** 显式目标偏移（米，沿 u / 沿 inward）。Compound 的网格排布用它 */
  offsetU?: number;
  offsetV?: number;
}

export interface Program {
  id: string;
  slots: SlotSpec[];
  /** 是否要组织院落（院落本身是公共空间，不是"空地"） */
  courtyard: boolean;
  /** 是否需要装卸场 */
  loading: boolean;
  /** 前场最小深度（米） */
  frontYardM: number;
  /** 设计意图，逐条可读 */
  rationale: string[];
}

export interface ProgramInput {
  typology: SiteTypology;
  /** 有效布局区的 OBB 尺寸（米） */
  widthM: number;
  depthM: number;
  /** 是否有真实临街面 */
  hasFrontage: boolean;
}

/**
 * 生成建筑程序。
 *
 * 四条分型规则（分别对应住宅 / 商业 / 工业 / 其余）：
 *   · 住宅：深够就围合院落（N/S/E/W 四条 bar），不够就沿街一排；
 *   · 商业：沿街一排店面，进深极深时加后排；
 *   · 工业：一栋大厂房 + 后方装卸场；
 *   · 酒店/公共：一栋塔楼 + 落客前场。
 */
export function programFor(input: ProgramInput, p: LayoutParams): Program {
  const { widthM, depthM } = input;
  const side = 3; // 侧向退让（米），建筑不贴地块边
  const usableW = Math.max(0, widthM - side * 2);
  const barD = p.barDepthM;
  const needW = COURT_MIN_W_M + barD * 2;
  const needD = COURT_MIN_D_M + barD * 2;

  const rationale: string[] = [];
  const slots: SlotSpec[] = [];

  const courtProgram = (): Program => {
    const barW = Math.min(usableW, Math.max(COURT_MIN_W_M + barD * 2, 0));
    rationale.push(`围合院落：院子 ${COURT_MIN_W_M}×${COURT_MIN_D_M} m，四周 ${barD} m 进深 bar`);
    rationale.push('四条 bar 先定院子的四至，再各自落位 —— 不是四栋楼各自居中');
    return {
      id: 'courtyard-ring',
      slots: [
        { kind: 'courtyard_bar', widthM: barW, depthM: barD, posture: 'court-s', priority: 1, why: '南侧 bar：朝街的主立面' },
        { kind: 'courtyard_bar', widthM: barW, depthM: barD, posture: 'court-n', priority: 2, why: '北侧 bar：背街，靠后巷' },
        { kind: 'courtyard_bar', widthM: barD, depthM: COURT_MIN_D_M, posture: 'court-e', priority: 3, why: '东侧 bar：封住院子' },
        { kind: 'courtyard_bar', widthM: barD, depthM: COURT_MIN_D_M, posture: 'court-w', priority: 4, why: '西侧 bar：封住院子' },
      ],
      courtyard: true,
      loading: false,
      frontYardM: p.frontYardM,
      rationale,
    };
  };

  if (input.typology === 'multi_family' || input.typology === 'single_family') {
    if (input.typology === 'multi_family' && usableW >= needW && depthM >= needD + p.frontYardM) {
      return courtProgram();
    }
    const w = Math.min(usableW, Math.max(COURT_MIN_W_M, 24));
    rationale.push(
      input.typology === 'single_family'
        ? '独栋：一栋住宅 + 前后院，进深方向留出院落感'
        : `进深/面宽不足以围合（需 ${needW.toFixed(0)}×${(needD + p.frontYardM).toFixed(0)} m），改为一排板楼`
    );
    slots.push({
      kind: input.typology === 'single_family' ? 'house' : 'street_bar',
      widthM: w,
      depthM: input.typology === 'single_family' ? Math.min(12, depthM * 0.35) : barD,
      posture: 'street',
      priority: 1,
      why: '沿街一排：主立面朝街，后院进深留给住户',
    });
    return { id: 'street-row', slots, courtyard: false, loading: false, frontYardM: p.frontYardM, rationale };
  }

  if (input.typology === 'retail') {
    const w = Math.min(usableW, Math.max(12, 60));
    rationale.push(`沿街店面：进深 ${SHOP_DEPTH_M} m（SHOP_DEPTH_M），面宽取 ${w.toFixed(0)} m`);
    rationale.push('入口前场在建筑与红线之间，不占用店面进深');
    slots.push({ kind: 'street_bar', widthM: w, depthM: Math.min(SHOP_DEPTH_M, Math.max(12, depthM - p.frontYardM - 6)), posture: 'street', priority: 1, why: '主店面朝街' });
    if (depthM > SHOP_DEPTH_M * 2 + p.frontYardM + 14) {
      slots.push({
        kind: 'rear_bar',
        widthM: w,
        depthM: p.shopDepthM,
        posture: 'rear',
        priority: 2,
        why: '进深富余：后排再一进，中间由后巷串起',
      });
      rationale.push('进深 > 2 倍店深 + 前场：加一排后排，中间留后巷');
    }
    return { id: 'retail-street', slots, courtyard: false, loading: false, frontYardM: p.frontYardM, rationale };
  }

  if (input.typology === 'industrial' || input.typology === 'data_center') {
    const w = Math.min(usableW, 60);
    const d = Math.min(p.hallDepthM, Math.max(20, depthM - p.frontYardM - 18));
    rationale.push(`一栋大厂房：${w.toFixed(0)}×${d.toFixed(0)} m（进深上限 ${p.hallDepthM} m）`);
    rationale.push('前方留车行前场，后方留装卸/堆场 —— 装卸不跨建筑');
    slots.push({ kind: 'hall', widthM: w, depthM: d, posture: 'center', priority: 1, why: '厂房居中偏后，前场走车、后场装卸' });
    return { id: 'industrial-hall', slots, courtyard: false, loading: true, frontYardM: p.frontYardM, rationale };
  }

  // hotel / civic / park / green / generic：一栋主体 + 前场
  const w = Math.min(usableW, Math.max(16, Math.min(45, usableW)));
  const d = Math.min(Math.max(14, p.barDepthM), Math.max(12, depthM * 0.45));
  rationale.push(`单体建筑 ${w.toFixed(0)}×${d.toFixed(0)} m，前场 ${p.frontYardM} m`);
  slots.push({ kind: 'tower', widthM: w, depthM: d, posture: 'center', priority: 1, why: '主体量居中，前场承接落客/集散' });
  return { id: 'single-block', slots, courtyard: false, loading: false, frontYardM: p.frontYardM, rationale };
}

/**
 * Compound 的程序：**一组建筑 + 共享空间**，而不是"一个大房子"。
 *
 * 为什么不留一个巨构：F2.1 把大后区标成 `compound` 的意思是"这里是一组建筑"，
 * 不是"这里盖一栋"。用一个巨构去填，覆盖率低得离谱，还会被绿地掩盖 ——
 * 正是任务书禁止的那种"看上去有东西，其实什么都没有"。
 *
 * 网格按类型取块尺度（住宅条、店铺、厂房），块间留 gap；共享空间由"扣完建筑剩下"决定。
 */
export function compoundProgram(
  typology: SiteTypology,
  widthM: number,
  depthM: number,
  p: LayoutParams
): Program {
  const gap = Math.max(p.gapM, 8);
  let bw = 45;
  let bd = 20;
  if (typology === 'multi_family' || typology === 'single_family') {
    bw = 55;
    bd = p.barDepthM;
  } else if (typology === 'retail') {
    bw = 40;
    bd = p.shopDepthM;
  } else if (typology === 'industrial' || typology === 'data_center') {
    bw = 60;
    bd = Math.min(p.hallDepthM, 50);
  }
  const nCols = Math.max(1, Math.min(4, Math.round(widthM / (bw + gap))));
  const nRows = Math.max(1, Math.min(3, Math.round(depthM / (bd + gap))));
  const cellW = widthM / nCols - gap;
  const cellD = depthM / nRows - gap;
  const slots: SlotSpec[] = [];
  let pri = 1;
  for (let j = 0; j < nRows; j++) {
    for (let i = 0; i < nCols; i++) {
      slots.push({
        kind: typology === 'industrial' || typology === 'data_center' ? 'hall' : 'rear_bar',
        widthM: Math.max(16, cellW),
        depthM: Math.max(12, cellD),
        posture: 'center',
        priority: pri++,
        // 网格中心偏移（米）：沿 u 铺开，沿进深方向铺开
        offsetU: (i + 0.5) / nCols * widthM - widthM / 2,
        offsetV: (j + 0.5) / nRows * depthM - depthM / 2,
        why: `组团第 ${j + 1} 排第 ${i + 1} 列（${Math.max(16, cellW).toFixed(0)}×${Math.max(12, cellD).toFixed(0)} m）`,
      });
    }
  }
  return {
    id: 'compound-grid',
    slots,
    courtyard: false,
    loading: typology === 'industrial' || typology === 'data_center',
    frontYardM: p.frontYardM,
    rationale: [
      `组团排布 ${nCols}×${nRows} 块（块间净距 ${gap} m），不是一栋巨构`,
      '先把共享空间（前场/装卸/绿地）让出来，再落每一块 —— 每块都各自找位置，但不各自居中',
    ],
  };
}

/** 院落矩形（世界单位）——院子的四至先定，四边 bar 才有共同的边界 */
export function courtyardRect(center: Pt, ang: number, p: LayoutParams) {
  return {
    w: Math.max(COURT_MIN_W_M, 12) / 7,
    d: Math.max(COURT_MIN_D_M, 12) / 7,
    ang,
    center,
  };
}

export const ADAPT_DEFAULTS = {
  shopDepthM: SHOP_DEPTH_M,
  barDepthM: 15,
  hallDepthM: 55,
  courtMinWM: COURT_MIN_W_M,
  courtMinDM: COURT_MIN_D_M,
};
