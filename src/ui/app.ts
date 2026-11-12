// 主界面 · F3 单链路
//
// 这一版的产品形态：
//   · **只有一个生成器**（F3 规则城市）。legacy 的 Voronoi 城市与 Planner 已经移除，
//     所以"道路生成方式"也只有一套（张量场 → 道路面 → 街区）。
//   · **只有一个视口**（three.js）。正交俯视就是不带动画的"平面视图"，
//     选中 / 高亮 / 禁区 / 方向线全部画在三维场景里。
//   · 右栏只放**对 F3 真生效**的参数。老参数的对应关系写在每节的说明里，
//     能对上就接（种子 / 规模 / 楼高 / 禁区 / 方向线），对不上就不留
//     （街区切分模式、停车 provider、S1/Pattern、单地块用途覆盖）。

import './style.css';
import { Pt } from '../core/geom';
import { f3City, type F3Input } from '../f3/ui';
import type { CityResult } from '../f3';
import { makeZone, zoneToPolygon, type Zone, type ZonePurpose } from '../town/zones';
import { makeGuide, type FieldGuide } from '../town/guide';
import {
  LAYER_GROUPS,
  defaultVisibility,
  makeFilter,
  layerOfPath,
  layerOfProp,
  layerOfSolid,
  layerOfSurface,
} from '../scene/layers';
import type { Scene } from '../scene/types';
import { exportGLB } from '../export/glb';
import { sceneToPrimitives, type GlbMerge } from '../export/build3d';
import { View3D, type BlockPick, type CameraMode, type Handle, type SelKind, type Tool } from './view3d';
import type { BlockOverride, CityDensity, CityProgram, CityStyle, UseChoice } from '../f3/types';

// ---------------------------------------------------------------- 常量

const STYLE_LABEL: Record<CityStyle, string> = {
  structured: '规则',
  organic: '有机',
  campus: '园区',
};
const PROGRAM_LABEL: Record<CityProgram, string> = {
  mixed: '混合',
  residential: '居住',
  commercial: '商业',
  cbd: '商务中心',
  industrial: '工业',
  campus: '园区',
};
const DENSITY_LABEL: Record<CityDensity, string> = { low: '低', medium: '中', high: '高' };
const USE_LABEL: Record<string, string> = {
  residential: '住宅',
  commercial: '商业',
  cbd: '商务',
  industrial: '工业',
  civic: '公共设施',
  campus: '园区',
  park: '公园',
  green: '绿地',
  reserved: '保留地（不盖楼）',
};

/** 属性面板里能改的地块类型（顺序 = 下拉顺序） */
const USE_OPTIONS: UseChoice[] = ['residential', 'commercial', 'cbd', 'industrial', 'civic', 'campus', 'park', 'green', 'reserved'];
const PURPOSE_LABEL: Record<ZonePurpose, string> = { cbd: '硬地（CBD）', park: '公园', forest: '林地' };

const MERGE_LABEL: Record<GlbMerge, string> = {
  layer: '按图层（默认）',
  material: '按材质',
  block: '按街区 + 类型',
  none: '不合并',
};

/** 半径滑杆范围（世界单位 ≈ 7 m/单位）：40 ≈ 280 m，150 ≈ 1.05 km */
const RADIUS_MIN = 40;
const RADIUS_MAX = 150;

// ---------------------------------------------------------------- 状态

interface State {
  seed: number;
  /** 城市半径（世界单位） */
  radius: number;
  style: CityStyle;
  program: CityProgram;
  density: CityDensity;
  heightScale: number;
  /** 路网离禁区的让距（米） */
  zonePadM: number;
  /** 让距范围内是否铺一层衔接铺装（可选项） */
  zonePadPave: boolean;
  zones: Zone[];
  guides: FieldGuide[];
  /** 逐街区覆盖（切分方向 / 数量 / 类型 / 楼高）—— 同样是"改了等应用" */
  blockOverrides: Record<string, BlockOverride>;
  guideStrength: number;
  vis: Record<string, boolean>;
  hiliteLotRoad: boolean;
  merge: GlbMerge;
  camera: CameraMode;
  tool: Tool;
}

const state: State = {
  seed: 682063530,
  // 默认调到最小规模 0.28 km（radius × 7 = 280 m）：调试/回归更快
  radius: 40,
  style: 'structured',
  program: 'mixed',
  density: 'low',
  heightScale: 1,
  zonePadM: 6,
  zonePadPave: true,
  zones: [],
  guides: [],
  blockOverrides: {},
  guideStrength: 0.8,
  vis: defaultVisibility(),
  hiliteLotRoad: false,
  merge: 'layer',
  camera: 'persp',
  tool: 'select',
};

let result: CityResult | null = null;
let view: View3D | null = null;
let selection: { kind: SelKind; id: string } = { kind: 'none', id: '' };
/** 有未应用的编辑（禁区 / 方向线 / 街区覆盖）：只改状态，等用户按"重建" */
let dirty = false;
/** 上次成功生成时的编辑状态快照，"放弃修改"用它回滚 */
let appliedSnapshot = '';
/** 旋转 / 缩放拖动的增量上下文（按一下一帧算相对差，不需要形状快照） */
let zoneDragCtx: {
  id: string;
  kind: 'rotate' | 'scale' | 'move';
  c: Pt;
  lastAng: number;
  lastDist: number;
  lastPt?: Pt;
} | null = null;
let busy = false;
/** `?pick=B12` 预选一个街区（截图 / 手测用，等第一次生成完成后执行） */
let pendingPick: string | null = null;
/** `?focusxy=` 的取景请求，等第一次生成完成后执行 */
let pendingFocus: { x: number; y: number; span: number } | null = null;
/** 上一次生成用的城市半径：半径变了要把镜头重新取景，否则新边界会跑出画面 */
let lastRadius = 0;

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;
const vis = (id: string): boolean => state.vis[id] !== false;

// 白屏兜底：三维初始化失败时至少能看到原因
let errorShown = false;
window.addEventListener('error', (e) => {
  if (errorShown) return;
  errorShown = true;
  const d = document.createElement('div');
  d.className = 'fatal';
  d.textContent = `JS ERROR: ${e.message}\n${(e.error as Error)?.stack ?? ''}`;
  document.body.appendChild(d);
});

// ---------------------------------------------------------------- 生成

function inputOf(): F3Input {
  return {
    radius: state.radius,
    seed: state.seed,
    style: state.style,
    program: state.program,
    density: state.density,
    heightScale: state.heightScale,
    guides: state.guides,
    zones: state.zones,
    zonePadM: state.zonePadM,
    zonePadPave: state.zonePadPave,
    blockOverrides: state.blockOverrides,
  };
}

/**
 * 重算整座城。
 *
 * 生成是同步的（2~5 s），所以必须先让"生成中"这一帧画出去再算 ——
 * 否则主线程一卡，用户看到的是页面直接白掉，不知道程序还活着。
 */
function regenerate(msg = ''): void {
  if (busy) return;
  busy = true;
  setBusy(true, msg || '生成中…');
  requestAnimationFrame(() => {
    window.setTimeout(() => {
      const t0 = performance.now();
      try {
        result = f3City(inputOf());
        applyScene();
        // 生成成功 = 当前编辑状态已经生效，记快照并清掉"未应用"标记
        appliedSnapshot = editSnapshot();
        dirty = false;
        updateApplyBar();
        if (lastRadius !== state.radius) {
          lastRadius = state.radius;
          view?.fitAll();
        }
        if (pendingFocus) {
          view?.focusOn(pendingFocus.x, pendingFocus.y, pendingFocus.span, 1);
          pendingFocus = null;
        }
        /**
         * 给 three-roads 预览用的"一键定位"钩子。
         * 只暴露一个函数，不碰 HUD 布局；按钮由 roadsThree.ts 自己创建。
         */
        (window as any).__f3FocusAt = (x: number, y: number, span = 20) => view?.focusOn(x, y, span, 1);
        if (pendingPick) {
          const id = pendingPick;
          pendingPick = null;
          const zn = state.zones.find((z) => z.id === id);
          if (zn) {
            selection = { kind: 'zone', id };
            view?.setSelection(selection);
            syncHandles();
            buildRight();
          }
          const blk = result.debug.blocks.find((b) => b.id === id);
          if (blk) {
            selection = { kind: 'block', id };
            view?.setSelection(selection);
            const c = blk.surface.outer.reduce((a, q) => ({ x: a.x + q.x, y: a.y + q.y }), { x: 0, y: 0 });
            const bcx = c.x / blk.surface.outer.length;
            const bcy = c.y / blk.surface.outer.length;
            let br = 0;
            for (const q of blk.surface.outer) br = Math.max(br, Math.hypot(q.x - bcx, q.y - bcy));
            view?.focusOn(bcx, bcy, Math.max(24, br * 2), 0.3);
            buildRight();
          }
        }
        const ms = Math.round(performance.now() - t0);
        updateStats(ms);
        refreshLists();
        toast(`${ms} ms · ${result.stats.blockCount} 街区 · ${result.stats.buildingCount} 栋楼`);
      } catch (e) {
        console.error(e);
        toast(`生成失败：${(e as Error).message}`, true);
      } finally {
        busy = false;
        setBusy(false);
      }
    }, 24);
  });
}

/** 把当前这份 CityResult 铺到视口与左栏 */
function applyScene(): void {
  if (!view || !result) return;
  view.setScene(result.scene, {
    layers: makeFilter(state.vis),
    hiliteLotRoad: state.hiliteLotRoad,
    cityRadius: state.radius,
  });
  view.setBlocks(blocksOf(result));
  view.setZones(state.zones, state.zones.map((z) => ({ id: z.id, ring: zoneToPolygon(z) })));
  view.setGuides(state.guides.map((g) => ({ id: g.id, pts: g.pts, enabled: g.enabled })));
  view.setSelection(selection);
  buildLeft();
}

// ---------------------------------------------------------------- 编辑与重建分离

/**
 * 编辑（禁区 / 方向线 / 街区覆盖）**不触发重建**，只置脏标记。
 *
 * 为什么必须这样：一座城生成 2~5 s 且在主线程上同步跑，如果"拖动一个角点就重算"，
 * 用户拖三下就要等十几秒，中间界面完全没响应。现在的约定是：
 *   · 拖动 / 输入 → 只改状态 + 更新三维覆盖层（毫秒级）；
 *   · 顶栏出现「应用并重建」，用户确认后才跑一次生成。
 */
function markDirty(): void {
  dirty = true;
  updateApplyBar();
}

/** 编辑状态快照：放弃修改时回滚到这里（不含城市级参数，那些本来就会重建） */
function editSnapshot(): string {
  return JSON.stringify({
    zones: state.zones,
    guides: state.guides,
    overrides: state.blockOverrides,
    heightScale: state.heightScale,
    zonePadM: state.zonePadM,
  });
}

function restoreSnapshot(): void {
  try {
    const o = JSON.parse(appliedSnapshot) as {
      zones: Zone[];
      guides: FieldGuide[];
      overrides: Record<string, BlockOverride>;
      heightScale: number;
      zonePadM: number;
    };
    state.zones = o.zones ?? [];
    state.guides = o.guides ?? [];
    state.blockOverrides = o.overrides ?? {};
    state.heightScale = o.heightScale ?? state.heightScale;
    state.zonePadM = o.zonePadM ?? state.zonePadM;
  } catch {
    /* 快照坏了就当没有 */
  }
  dirty = false;
  refreshOverlays();
  buildRight();
  updateApplyBar();
}

/** 只刷新三维覆盖层（禁区 / 方向线 / 控制点），不重建城市 */
function refreshOverlays(): void {
  if (!view) return;
  view.setZones(state.zones, state.zones.map((z) => ({ id: z.id, ring: zoneToPolygon(z) })));
  view.setGuides(state.guides.map((g) => ({ id: g.id, pts: g.pts, enabled: g.enabled })));
  view.setSelection(selection);
  syncHandles();
}

function updateApplyBar(): void {
  const bar = document.getElementById('applybar');
  if (!bar) return;
  bar.classList.toggle('on', dirty);
  const n = Object.keys(state.blockOverrides).length;
  const txt = bar.querySelector('.txt');
  if (txt) txt.textContent = dirty ? `有未应用的修改${n ? ` · ${n} 个街区覆盖` : ''}` : '';
}

/** 应用修改 = 跑一次完整生成（唯一会卡几秒的地方，且是用户主动按的） */
function applyEdits(): void {
  if (busy) return;
  regenerate('应用修改，重建城市…');
}

/**
 * 当前选中对象的控制点。
 *
 * 禁区：矩形 4 个角 / 圆 1 个圆心 + 1 个半径点 / 多边形逐顶点；
 * 方向线：逐折点。拖动只改形状本身，不重建。
 */
/** 禁区的包围圆（中心 + 最大半径）：旋转 / 缩放都绕它做 */
function zoneCenterRadius(z: Zone): { c: Pt; r: number } {
  const ring = zoneToPolygon(z);
  let cx = 0;
  let cy = 0;
  for (const p of ring) {
    cx += p.x;
    cy += p.y;
  }
  const c = new Pt(cx / Math.max(1, ring.length), cy / Math.max(1, ring.length));
  let r = 0;
  for (const p of ring) r = Math.max(r, Pt.distance(c, p));
  return { c, r: Math.max(1.5, r) };
}

function rotateAbout(p: Pt, c: Pt, ang: number): Pt {
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  const cs = Math.cos(ang);
  const sn = Math.sin(ang);
  return new Pt(c.x + dx * cs - dy * sn, c.y + dx * sn + dy * cs);
}

function scaleAbout(p: Pt, c: Pt, k: number): Pt {
  return new Pt(c.x + (p.x - c.x) * k, c.y + (p.y - c.y) * k);
}

/** 平移一块禁区（整体移动，形状不变） */
function translateZone(z: Zone, dx: number, dy: number): Zone {
  const mv = (p: Pt): Pt => new Pt(p.x + dx, p.y + dy);
  const sh = z.shape;
  if (sh.kind === 'rect') return { ...z, shape: { kind: 'rect', a: mv(sh.a), b: mv(sh.b) } };
  if (sh.kind === 'circle') return { ...z, shape: { ...sh, c: mv(sh.c) } };
  return { ...z, shape: { kind: 'poly', pts: sh.pts.map(mv) } };
}

/** 旋转一块禁区（矩形会转成 4 点多边形 —— 轴对齐矩形表达不了旋转） */
function rotateZone(z: Zone, c: Pt, ang: number): Zone {
  const sh = z.shape;
  if (sh.kind === 'circle') return z;
  if (sh.kind === 'rect') {
    const x0 = Math.min(sh.a.x, sh.b.x);
    const x1 = Math.max(sh.a.x, sh.b.x);
    const y0 = Math.min(sh.a.y, sh.b.y);
    const y1 = Math.max(sh.a.y, sh.b.y);
    const pts = [new Pt(x0, y0), new Pt(x1, y0), new Pt(x1, y1), new Pt(x0, y1)].map((p) => rotateAbout(p, c, ang));
    return { ...z, shape: { kind: 'poly', pts } };
  }
  return { ...z, shape: { kind: 'poly', pts: sh.pts.map((p) => rotateAbout(p, c, ang)) } };
}

/** 缩放一块禁区（绕包围圆中心，等比） */
function scaleZone(z: Zone, c: Pt, k: number): Zone {
  const sh = z.shape;
  if (sh.kind === 'circle') {
    const r = Math.max(1.5, Math.min(state.radius * 1.2, sh.r * k));
    return { ...z, shape: { ...sh, r } };
  }
  if (sh.kind === 'rect') {
    const a = scaleAbout(sh.a, c, k);
    const b = scaleAbout(sh.b, c, k);
    const minU = Math.max(1.2, state.radius * 0.02);
    if (Math.abs(b.x - a.x) < minU || Math.abs(b.y - a.y) < minU) return z;
    return { ...z, shape: { kind: 'rect', a, b } };
  }
  const pts = sh.pts.map((p) => scaleAbout(p, c, k));
  if (pts.some((p) => Pt.distance(p, c) > state.radius * 3)) return z;
  return { ...z, shape: { kind: 'poly', pts } };
}

/**
 * 拖动控制点：只改形状数据（毫秒级），不动城市。
 * id 的格式：`<对象 id>:<部位>`，部位是 `c0..c3`（矩形角）/ `move` / `rotate` / `scale` / `v<idx>`。
 */
function dragHandle(id: string, at: Pt): void {
  const cut = id.lastIndexOf(':');
  if (cut < 0) return;
  const owner = id.slice(0, cut);
  const part = id.slice(cut + 1);

  if (selection.kind === 'guide') {
    const g = state.guides.find((q) => q.id === owner);
    if (!g || !part.startsWith('v')) return;
    const i = Number(part.slice(1));
    const pts = g.pts.map((p, k) => (k === i ? at : p));
    state.guides = state.guides.map((q) => (q.id === owner ? { ...q, pts } : q));
    markDirty();
    refreshOverlays();
    return;
  }
  if (selection.kind !== 'zone') return;
  const z = state.zones.find((q) => q.id === owner);
  if (!z) return;
  const sh = z.shape;
  let next = z;

  /** 移动：拖包围盒中心点，整块平移（增量：记上一帧落点，只应用这一帧位移） */
  if (part === 'move') {
    if (!zoneDragCtx || zoneDragCtx.id !== id || zoneDragCtx.kind !== 'move' || !zoneDragCtx.lastPt) {
      zoneDragCtx = { id, kind: 'move', c: zoneCenterRadius(z).c, lastAng: 0, lastDist: 0, lastPt: at };
      return;
    }
    const dx = at.x - zoneDragCtx.lastPt.x;
    const dy = at.y - zoneDragCtx.lastPt.y;
    zoneDragCtx.lastPt = at;
    if (Math.abs(dx) + Math.abs(dy) < 1e-6) return;
    state.zones = state.zones.map((q) => (q.id === owner ? translateZone(q, dx, dy) : q));
    markDirty();
    refreshOverlays();
    return;
  }

  /** 旋转 / 缩放同样是增量：只应用这一帧相对上一帧的角度差 / 比例差 */
  if (part === 'rotate' || part === 'scale') {
    const { c } = zoneCenterRadius(z);
    const ang = Math.atan2(at.y - c.y, at.x - c.x);
    const dist = Math.max(0.4, Pt.distance(c, at));
    if (!zoneDragCtx || zoneDragCtx.id !== id) {
      zoneDragCtx = { id, kind: part, c, lastAng: ang, lastDist: dist };
      return;
    }
    if (part === 'rotate') {
      const delta = ang - zoneDragCtx.lastAng;
      zoneDragCtx.lastAng = ang;
      if (Math.abs(delta) > 1e-5) next = rotateZone(z, c, delta);
    } else {
      const k = Math.max(0.5, Math.min(2, dist / zoneDragCtx.lastDist));
      zoneDragCtx.lastDist = dist;
      if (Math.abs(k - 1) > 1e-4) next = scaleZone(z, c, k);
    }
    if (next !== z) {
      state.zones = state.zones.map((q) => (q.id === owner ? next : q));
      markDirty();
      refreshOverlays();
    }
    return;
  }

  if (sh.kind === 'rect') {
    const xs = [sh.a.x, sh.b.x];
    const ys = [sh.a.y, sh.b.y];
    let minX = Math.min(...xs);
    let maxX = Math.max(...xs);
    let minY = Math.min(...ys);
    let maxY = Math.max(...ys);
    if (part === 'c0') {
      minX = at.x;
      minY = at.y;
    } else if (part === 'c1') {
      maxX = at.x;
      minY = at.y;
    } else if (part === 'c2') {
      maxX = at.x;
      maxY = at.y;
    } else if (part === 'c3') {
      minX = at.x;
      maxY = at.y;
    } else return;
    const minU = Math.max(1.2, state.radius * 0.02);
    if (maxX - minX < minU) maxX = minX + minU;
    if (maxY - minY < minU) maxY = minY + minU;
    next = { ...z, shape: { kind: 'rect', a: new Pt(minX, minY), b: new Pt(maxX, maxY) } };
  } else if (sh.kind === 'circle') {
    if (part === 'radius') {
      const r = Math.max(Math.max(1.2, state.radius * 0.02), Pt.distance(sh.c, at));
      next = { ...z, shape: { ...sh, r } };
    } else return;
  } else {
    if (!part.startsWith('v')) return;
    const i = Number(part.slice(1));
    next = { ...z, shape: { kind: 'poly', pts: sh.pts.map((p, k) => (k === i ? at : p)) } };
  }
  state.zones = state.zones.map((q) => (q.id === owner ? next : q));
  markDirty();
  refreshOverlays();
}

/** 右键控制点：删点（方向线 ≥2 点、多边形 ≥3 点；不够就整条删掉） */
function deleteHandle(id: string): void {
  const cut = id.lastIndexOf(':');
  if (cut < 0) return;
  const owner = id.slice(0, cut);
  const part = id.slice(cut + 1);
  if (selection.kind === 'guide') {
    const g = state.guides.find((q) => q.id === owner);
    if (!g || !part.startsWith('v')) return;
    const i = Number(part.slice(1));
    if (g.pts.length > 2) {
      const pts = g.pts.filter((_, k) => k !== i);
      state.guides = state.guides.map((q) => (q.id === owner ? { ...q, pts } : q));
    } else {
      state.guides = state.guides.filter((q) => q.id !== owner);
      selection = { kind: 'none', id: '' };
    }
  } else if (selection.kind === 'zone') {
    const z = state.zones.find((q) => q.id === owner);
    if (!z || z.shape.kind !== 'poly' || !part.startsWith('v')) return;
    const i = Number(part.slice(1));
    if (z.shape.pts.length > 3) {
      const pts = z.shape.pts.filter((_, k) => k !== i);
      state.zones = state.zones.map((q) => (q.id === owner ? { ...q, shape: { kind: 'poly', pts } } : q));
    } else {
      state.zones = state.zones.filter((q) => q.id !== owner);
      selection = { kind: 'none', id: '' };
    }
  } else return;
  markDirty();
  refreshOverlays();
  buildRight();
}

/**
 * 禁区的三个"整块操作"手柄（移动 / 旋转 / 缩放），**贴外接框**放。
 *
 * 之前这段只写在"矩形"分支里：矩形一旦被旋转就会转成多边形，
 * 多边形分支没有移动手柄 —— 于是"转一下，黄点就没了"（用户反馈）。
 * 现在矩形 / 多边形共用同一个函数，形态变了手柄不会丢。
 */
function pushZoneBoxHandles(out: Handle[], z: Zone): void {
  const ring = zoneToPolygon(z);
  if (ring.length < 3) return;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const q of ring) {
    minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x);
    minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y);
  }
  const pad = Math.max(1.6, state.radius * 0.028);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  out.push({ id: `${z.id}:move`, at: new Pt(cx, cy), kind: 'move' });
  out.push({ id: `${z.id}:rotate`, at: new Pt(cx, minY - pad), kind: 'rotate' });
  out.push({ id: `${z.id}:scale`, at: new Pt(maxX + pad, cy), kind: 'scale' });
}

function syncHandles(): void {
  if (!view) return;
  const out: Handle[] = [];
  if (selection.kind === 'zone') {
    const z = state.zones.find((q) => q.id === selection.id);
    if (z) {
      const sh = z.shape;
      if (sh.kind === 'rect') {
        const minX = Math.min(sh.a.x, sh.b.x);
        const maxX = Math.max(sh.a.x, sh.b.x);
        const minY = Math.min(sh.a.y, sh.b.y);
        const maxY = Math.max(sh.a.y, sh.b.y);
        out.push(
          { id: `${z.id}:c0`, at: new Pt(minX, minY), kind: 'point' },
          { id: `${z.id}:c1`, at: new Pt(maxX, minY), kind: 'point' },
          { id: `${z.id}:c2`, at: new Pt(maxX, maxY), kind: 'point' },
          { id: `${z.id}:c3`, at: new Pt(minX, maxY), kind: 'point' }
        );
        pushZoneBoxHandles(out, z);
      } else if (sh.kind === 'circle') {
        // 圆：圆心就是移动手柄（拖它整块平移），半径点负责缩放
        out.push(
          { id: `${z.id}:move`, at: sh.c, kind: 'move' },
          { id: `${z.id}:radius`, at: new Pt(sh.c.x + sh.r, sh.c.y), kind: 'scale' }
        );
      } else {
        sh.pts.forEach((p, i) => out.push({ id: `${z.id}:v${i}`, at: p, kind: 'point' }));
        // 多边形（含"旋转后转成多边形"的矩形）同样有移动 / 旋转 / 缩放
        pushZoneBoxHandles(out, z);
      }
    }
  } else if (selection.kind === 'guide') {
    const g = state.guides.find((q) => q.id === selection.id);
    g?.pts.forEach((p, i) => out.push({ id: `${g.id}:v${i}`, at: p }));
  }
  view.setHandles(out);
}

function blocksOf(r: CityResult): BlockPick[] {
  return r.debug.blocks.map((b) => ({ id: b.id, ring: b.surface.outer, use: b.use }));
}

/** 只换颜色/显隐时走这条：不动生成结果，只重建网格 */
function refreshView(): void {
  if (!view || !result) return;
  view.setScene(result.scene, {
    layers: makeFilter(state.vis),
    hiliteLotRoad: state.hiliteLotRoad,
    cityRadius: state.radius,
  });
  view.setSelection(selection);
}

// ---------------------------------------------------------------- 左栏：显示控制

/** 场景 → 每个图层有多少个要素（F3 没有 Model，直接从 Scene 数） */
function sceneCounts(scene: Scene): Record<string, number> {
  const c: Record<string, number> = {};
  const bump = (id: string): void => {
    c[id] = (c[id] ?? 0) + 1;
  };
  for (const s of scene.surfaces) bump(layerOfSurface(s));
  for (const s of scene.solids) bump(layerOfSolid(s));
  for (const p of scene.props) bump(layerOfProp(p));
  for (const p of scene.paths) bump(layerOfPath(p));
  return c;
}

function layerItemHtml(id: string, label: string, color: string | undefined, n: number | undefined): string {
  const on = vis(id);
  return `<label class="lyr-item ${on ? '' : 'off'}" data-for="${id}" title="${label}">
      <input type="checkbox" data-layer="${id}" ${on ? 'checked' : ''}/>
      ${color ? `<span class="sw" style="background:${color}"></span>` : ''}
      <span class="lb">${label}</span>
      ${n !== undefined ? `<span class="n" data-count="${id}">${n}</span>` : ''}
    </label>`;
}

/** 当前被"整组隐藏"的分组（用来提示"看不见不等于没生成"） */
function hiddenGroups(): { id: string; label: string }[] {
  return LAYER_GROUPS.filter((g) => g.items.every((it) => state.vis[it.id] === false)).map((g) => ({
    id: g.id,
    label: g.label,
  }));
}

function buildLeft(): void {
  const counts = result ? sceneCounts(result.scene) : {};
  const hidden = hiddenGroups();
  const groups = LAYER_GROUPS.map((g) => {
    const items = g.items
      .map((it) => layerItemHtml(it.id, it.label, it.color, counts[it.id] ?? 0))
      .join('');
    const total = g.items.reduce((a, it) => a + (counts[it.id] ?? 0), 0);
    const onCnt = g.items.filter((it) => vis(it.id)).length;
    const allOff = onCnt === 0;
    return `<details class="lyr-group ${allOff ? 'all-off' : ''}" ${g.open ? 'open' : ''}>
        <summary class="lyr-head">
          <b>${g.label}</b>
          ${allOff ? '<span class="hide-tag">已隐藏</span>' : ''}
          <span class="cnt">${onCnt}/${g.items.length} · ${total}</span>
          <span class="mini">
            ${
              g.id === 'lotroad'
                ? `<button data-hact="hilite" class="${state.hiliteLotRoad ? 'on' : ''}" title="把地块内部道路临时染成橙红">高亮</button>`
                : ''
            }
            <button data-gact="all" data-group="${g.id}">全显</button>
            <button data-gact="none" data-group="${g.id}">全隐</button>
          </span>
        </summary>
        ${items}
      </details>`;
  }).join('');

  $('#leftbar').innerHTML = `
    <details class="sec" open>
      <summary><span class="dot"></span>显示控制<span class="sec-tag">三维 · 导出</span></summary>
      <div class="sec-body">
        ${
          hidden.length
            ? `<div class="hide-warn">已隐藏 <b>${hidden.length}</b> 组：${hidden
                .map((h) => h.label)
                .join('、')} —— 画面上"缺东西"多半是这个，不是生成失败
                <button data-cact="all">全部显示</button></div>`
            : ''
        }
        <div class="lyr-tools">
          <button data-cact="all">要素全显</button>
          <button data-cact="none">要素全隐</button>
          <button data-cact="reset" title="恢复出厂显隐">默认</button>
        </div>
        ${groups}
      </div>
    </details>`;
  bindLeft();
}

function bindLeft(): void {
  const bar = $('#leftbar');
  bar.querySelectorAll<HTMLInputElement>('input[data-layer]').forEach((el) => {
    el.addEventListener('change', () => {
      state.vis[el.dataset.layer as string] = el.checked;
      el.closest('.lyr-item')?.classList.toggle('off', !el.checked);
      saveLayers();
      refreshView();
    });
  });
  bar.querySelectorAll<HTMLButtonElement>('button[data-hact]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.hiliteLotRoad = !state.hiliteLotRoad;
      btn.classList.toggle('on', state.hiliteLotRoad);
      refreshView();
    });
  });
  bar.querySelectorAll<HTMLButtonElement>('button[data-gact]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const gid = btn.dataset.group as string;
      const g = LAYER_GROUPS.find((q) => q.id === gid);
      if (!g) return;
      const on = btn.dataset.gact === 'all';
      for (const it of g.items) state.vis[it.id] = on;
      saveLayers();
      buildLeft();
      refreshView();
    });
  });
  bar.querySelectorAll<HTMLButtonElement>('button[data-cact]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const act = btn.dataset.cact as 'all' | 'none' | 'reset';
      const def = defaultVisibility();
      for (const g of LAYER_GROUPS) {
        for (const it of g.items) state.vis[it.id] = act === 'all' ? true : act === 'none' ? false : def[it.id] !== false;
      }
      saveLayers();
      buildLeft();
      refreshView();
    });
  });
}

// ---------------------------------------------------------------- 右栏

function details(title: string, body: string, open = false, tag = ''): string {
  return `<details class="sec" ${open ? 'open' : ''}><summary><span class="dot"></span>${title}${
    tag ? `<span class="sec-tag">${tag}</span>` : ''
  }</summary><div class="sec-body">${body}</div></details>`;
}

function seg(id: string, items: { v: string; label: string; on: boolean }[]): string {
  return `<div class="seg" id="${id}">${items
    .map((it) => `<button data-v="${it.v}" class="${it.on ? 'active' : ''}">${it.label}</button>`)
    .join('')}</div>`;
}

function buildRight(): void {
  // ---- 城市
  const city = details(
    '城市',
    `
    <div class="row"><label>规模</label>
      <div class="range-inline grow">
        <input type="range" id="rng-radius" min="${RADIUS_MIN}" max="${RADIUS_MAX}" step="2" value="${state.radius}"/>
        <span class="val" id="val-radius">${(state.radius * 7 / 1000).toFixed(2)} km</span>
      </div>
    </div>
    <div class="row"><label>种子</label>
      <input type="number" id="inp-seed" value="${state.seed}" class="grow"/>
      <button class="ghost" id="btn-dice" title="随机种子">随机</button>
    </div>
    <div class="row"><label>风貌</label>
      ${seg('seg-style', (Object.keys(STYLE_LABEL) as CityStyle[]).map((k) => ({ v: k, label: STYLE_LABEL[k], on: state.style === k })))}
    </div>
    <div class="row"><label>用途</label>
      ${seg('seg-program', (Object.keys(PROGRAM_LABEL) as CityProgram[]).map((k) => ({ v: k, label: PROGRAM_LABEL[k], on: state.program === k })))}
    </div>
    <div class="row"><label>密度</label>
      ${seg('seg-density', (Object.keys(DENSITY_LABEL) as CityDensity[]).map((k) => ({ v: k, label: DENSITY_LABEL[k], on: state.density === k })))}
    </div>
    <div class="row" style="margin-top:10px"><button class="ghost grow" id="btn-regen">重新生成</button></div>
    <div class="tip" style="margin-top:8px">规模 = 城市半径（改它会重算路网与全部街区）。风貌决定路网形态与断面：规则 / 有机 / 园区。用途决定地块的竞租分配，密度决定层数与地块切分尺度。</div>
    `,
    true,
    `${(state.radius * 2 * 7 / 1000).toFixed(1)} km 见方`
  );

  // ---- 禁区
  const zone = details(
    '禁区',
    `
    <div class="row"><label>工具</label>
      ${seg('seg-zone-tool', [
        { v: 'select', label: '选择', on: state.tool === 'select' },
        { v: 'rect', label: '矩形', on: state.tool === 'rect' },
        { v: 'circle', label: '圆', on: state.tool === 'circle' },
        { v: 'poly', label: '多边形', on: state.tool === 'poly' },
      ])}
    </div>
    <div class="zone-list" id="zone-list"></div>
    <div class="row"><label>让距</label>
      <div class="range-inline grow">
        <input type="range" id="rng-zone-pad" min="0" max="30" step="1" value="${state.zonePadM}"/>
        <span class="val" id="val-zone-pad">${state.zonePadM} m</span>
      </div>
    </div>
    <div class="row">
      <label style="flex:0 0 auto">衔接铺装</label>
      <input type="checkbox" id="chk-zone-padpave" ${state.zonePadPave ? 'checked' : ''}/>
      <span class="tip" style="margin:0 0 0 8px;flex:1">在让距范围内铺一层地面，让禁区边缘和周边地块衔接自然</span>
    </div>
    <div class="tip" style="margin-top:8px">
      禁区是<b>生成之后局部生效</b>的（不重算整城）：
      <b>禁区本体</b>内的建筑整栋剔除、路面挖掉，按用途铺硬地 / 公园草地 / 林地（含树）；
      <b>让距</b>只在地块里外扩、<b>不切路面</b>。
      勾选「衔接铺装」时，让距那一圈也铺上地面，让边缘和周边地块过渡自然；
      不勾则只按禁区本体铺。
    </div>
    `,
    false,
    `${state.zones.length} 处`
  );

  // ---- 方向控制
  const guide = details(
    '方向控制',
    `
    <div class="row"><label>工具</label>
      ${seg('seg-guide-tool', [
        { v: 'select', label: '选择', on: state.tool === 'select' },
        { v: 'guide', label: '画方向线', on: state.tool === 'guide' },
      ])}
    </div>
    <div class="row"><label>强度</label>
      <div class="range-inline grow">
        <input type="range" id="rng-gstrength" min="0.1" max="1" step="0.05" value="${state.guideStrength}"/>
        <span class="val" id="val-gstrength">${state.guideStrength.toFixed(2)}</span>
      </div>
    </div>
    <div class="zone-list" id="guide-list"></div>
    <div class="row" style="margin-top:6px"><button class="ghost grow" id="btn-guides-clear">清空所有方向线</button></div>
    <div class="tip" style="margin-top:8px">沿"希望街道顺着走"的方向点几个点，双击结束。线两侧约 3 个街区宽的带内，街道会转向这条线；越远越回到全局方向。改完按顶栏「应用并重建」生效。</div>
    `,
    false,
    `${state.guides.length} 条`
  );

  // ---- 建筑
  const building = details(
    '建筑',
    `
    <div class="row"><label>楼高</label>
      <div class="range-inline grow">
        <input type="range" id="rng-height" min="0.5" max="2.2" step="0.05" value="${state.heightScale}"/>
        <span class="val" id="val-height">${state.heightScale.toFixed(2)}×</span>
      </div>
    </div>
    <div class="tip" style="margin-top:8px">楼高是一次生成参数（不是渲染缩放）：改完必须重算，因为层数会反过来影响体量、退线与采光间距。</div>
    <div class="row" style="margin-top:8px"><button class="ghost grow" id="btn-reseed">换个种子重算</button></div>
    `,
    false
  );

  // ---- 视图与导出
  const io = details(
    '视图与导出',
    `
    <div class="row"><label>投影</label>
      ${seg('seg-camera', [
        { v: 'persp', label: '透视', on: state.camera === 'persp' },
        { v: 'top', label: '正交顶视', on: state.camera === 'top' },
      ])}
    </div>
    <div class="row"><label>合并</label>
      <select id="sel-merge" class="grow">
        ${(Object.keys(MERGE_LABEL) as GlbMerge[])
          .map((k) => `<option value="${k}" ${state.merge === k ? 'selected' : ''}>${MERGE_LABEL[k]}</option>`)
          .join('')}
      </select>
    </div>
    <div class="row" style="margin-top:10px"><button class="primary grow" id="btn-export">导出 GLB</button></div>
    <div class="row" style="margin-top:6px"><button class="ghost grow" id="btn-share">复制场景链接</button></div>
    <div class="tip" style="margin-top:8px">
      「正交顶视」就是原来的平面视图：同样一份几何、关掉阴影的俯视投影，滚轮缩放 / 拖拽平移。
      选中高亮、禁区、方向线都在三维场景里，两个视角看到的是同一个东西，导出的也是它。
    </div>
    <div class="tip" style="margin-top:6px">看不见的图层不会进 GLB。「按街区 + 类型」会把每个街区并成 建筑 / 地面 / 道路 / 设施 四组，适合逐块替换。</div>
    `,
    false
  );

  $('#rightbar').innerHTML =
    (selection.kind !== 'none' ? selectionPanel() : '') + city + zone + guide + building + io;
  bindRight();
  renderZoneList();
  renderGuideList();
}

/** 选中街区 / 禁区的信息面板 */
function selectionPanel(): string {
  // ---------------- 禁区
  if (selection.kind === 'zone') {
    const z = state.zones.find((q) => q.id === selection.id);
    if (!z) return '';
    return `<details class="sec sel-patch" open>
      <summary><span class="dot"></span>选中禁区<span class="sec-tag">${PURPOSE_LABEL[z.purpose ?? 'cbd']}</span></summary>
      <div class="sec-body">
        <div class="row"><label>用途</label>
          <select id="sel-zone-purpose" class="grow">
            ${(Object.keys(PURPOSE_LABEL) as ZonePurpose[])
              .map((k) => `<option value="${k}" ${(z.purpose ?? 'cbd') === k ? 'selected' : ''}>${PURPOSE_LABEL[k]}</option>`)
              .join('')}
          </select>
        </div>
        <div class="row" style="margin-top:8px">
          <label style="flex:0 0 auto">启用</label>
          <input type="checkbox" id="sel-zone-on" ${z.enabled ? 'checked' : ''}/>
          <button class="ghost grow" id="sel-zone-del" style="margin-left:8px">删除禁区</button>
        </div>
        <div class="tip" style="margin-top:6px">
          拖<b>白色中心点</b>整体移动、<b>橙色点</b>改顶点${z.shape.kind === 'circle' ? '（半径点缩放）' : '，<b>蓝点</b>旋转、<b>绿点</b>整体缩放'}；
          右键顶点可删点（多边形至少 3 点）。矩形一旦旋转会变成 4 点多边形（轴对齐矩形表达不了斜置）。
          改完按顶栏「应用并重建」。
        </div>
      </div>
    </details>`;
  }

  // ---------------- 方向线
  if (selection.kind === 'guide') {
    const g = state.guides.find((q) => q.id === selection.id);
    if (!g) return '';
    return `<details class="sec sel-patch" open>
      <summary><span class="dot"></span>选中方向线<span class="sec-tag">${g.pts.length} 点</span></summary>
      <div class="sec-body">
        <div class="row"><label>强度</label>
          <div class="range-inline grow">
            <input type="range" id="sel-guide-strength" min="0.1" max="1" step="0.05" value="${g.strength}"/>
            <span class="val" id="val-guide-strength">${g.strength.toFixed(2)}</span>
          </div>
        </div>
        <div class="row" style="margin-top:8px">
          <label style="flex:0 0 auto">启用</label>
          <input type="checkbox" id="sel-guide-on" ${g.enabled ? 'checked' : ''}/>
          <button class="ghost grow" id="sel-guide-del" style="margin-left:8px">删除方向线</button>
        </div>
        <div class="tip" style="margin-top:6px">
          拖<b>橙色折点</b>改走向；右键折点删点（至少 2 点）。强度是"压住全局方向的力度"：
          0.2 只是轻轻偏一点，1.0 会让附近 3 个街区宽的街道整条转过来。
        </div>
      </div>
    </details>`;
  }

  // ---------------- 街区
  const b = result?.debug.blocks.find((q) => q.id === selection.id);
  if (!b) return '';
  const ov = state.blockOverrides[b.id] ?? {};
  const nBuild = result ? result.scene.solids.filter((s) => s.name.startsWith(`${b.id}-`)).length : 0;
  const nParcel = result ? result.debug.parcels.filter((p) => p.blockId === b.id).length : 0;
  const axisDeg = Math.round((((ov.axisRad ?? b.frontRad) * 180) / Math.PI + 360) % 180);
  const parcels = ov.parcels ?? nParcel;
  const use = (ov.use ?? b.use) as UseChoice;
  const hs = ov.heightScale ?? 1;
  return `<details class="sec sel-patch" open>
      <summary><span class="dot"></span>选中街区 ${b.id}<span class="sec-tag">${(b.areaM2 / 10000).toFixed(2)} ha</span></summary>
      <div class="sec-body">
        <div class="row"><label>切分方向</label>
          <div class="range-inline grow">
            <input type="range" id="sel-b-axis" min="0" max="179" step="1" value="${axisDeg}"/>
            <span class="val" id="val-b-axis">${axisDeg}°</span>
          </div>
        </div>
        <div class="row"><label>切分数量</label>
          <div class="range-inline grow">
            <input type="range" id="sel-b-parcels" min="1" max="${Math.max(24, parcels)}" step="1" value="${parcels}"/>
            <span class="val" id="val-b-parcels">${parcels} 块${ov.parcels ? '' : '（自动）'}</span>
          </div>
        </div>
        <div class="row"><label>地块类型</label>
          <select id="sel-b-use" class="grow">
            ${USE_OPTIONS.map((k) => `<option value="${k}" ${use === k ? 'selected' : ''}>${USE_LABEL[k]}</option>`).join('')}
          </select>
        </div>
        <div class="row"><label>建筑高度</label>
          <div class="range-inline grow">
            <input type="range" id="sel-b-height" min="0.4" max="2.5" step="0.05" value="${hs}"/>
            <span class="val" id="val-b-height">${hs.toFixed(2)}×</span>
          </div>
        </div>
        <div class="row" style="margin-top:8px">
          <button class="ghost grow" id="sel-b-reset">恢复这块地的自动结果</button>
        </div>
        <div class="tip" style="margin-top:6px">
          当前：${nBuild} 栋 · ${nParcel} 个地块 · 临街 ${
            b.nearestCls === 'arterial' ? '主干道' : b.nearestCls === 'collector' ? '次干道' : '支路'
          }。<br/>
          方向改变刀口朝向，数量是**目标块数**（二叉分割按面积逼近，实测量级 ±30%）；
          「保留地」= 路网照旧、这块地只铺硬地不盖楼（跟禁区不同，禁区是连路都不进去）。
        </div>
      </div>
    </details>`;
}

/** 选中面板的交互（每次重建 HTML 后都要重新绑一次） */
function bindSelectionPanel(): void {
  const zPurpose = document.querySelector<HTMLSelectElement>('#sel-zone-purpose');
  zPurpose?.addEventListener('change', () => {
    state.zones = state.zones.map((z) => (z.id === selection.id ? { ...z, purpose: zPurpose.value as ZonePurpose } : z));
    markDirty();
    refreshOverlays();
    renderZoneList();
  });
  document.querySelector<HTMLInputElement>('#sel-zone-on')?.addEventListener('change', (ev) => {
    const on = (ev.target as HTMLInputElement).checked;
    state.zones = state.zones.map((z) => (z.id === selection.id ? { ...z, enabled: on } : z));
    markDirty();
    refreshOverlays();
    renderZoneList();
  });
  document.getElementById('sel-zone-del')?.addEventListener('click', () => {
    state.zones = state.zones.filter((z) => z.id !== selection.id);
    selection = { kind: 'none', id: '' };
    markDirty();
    refreshOverlays();
    buildRight();
  });

  // ---- 方向线
  const gs = document.querySelector<HTMLInputElement>('#sel-guide-strength');
  gs?.addEventListener('input', () => {
    const v = Number(gs.value);
    const lbl = document.getElementById('val-guide-strength');
    if (lbl) lbl.textContent = v.toFixed(2);
    state.guides = state.guides.map((g) => (g.id === selection.id ? { ...g, strength: v } : g));
    markDirty();
  });
  document.querySelector<HTMLInputElement>('#sel-guide-on')?.addEventListener('change', (ev) => {
    const on = (ev.target as HTMLInputElement).checked;
    state.guides = state.guides.map((g) => (g.id === selection.id ? { ...g, enabled: on } : g));
    markDirty();
    refreshOverlays();
    renderGuideList();
  });
  document.getElementById('sel-guide-del')?.addEventListener('click', () => {
    state.guides = state.guides.filter((g) => g.id !== selection.id);
    selection = { kind: 'none', id: '' };
    markDirty();
    refreshOverlays();
    buildRight();
  });

  // ---- 街区覆盖
  const axis = document.querySelector<HTMLInputElement>('#sel-b-axis');
  axis?.addEventListener('input', () => {
    const deg = Number(axis.value);
    const lbl = document.getElementById('val-b-axis');
    if (lbl) lbl.textContent = `${deg}°`;
    const rad = (deg * Math.PI) / 180;
    patchOverride(selection.id, { axisRad: rad });
    view?.setBlockAxis(rad);
  });
  const parcels = document.querySelector<HTMLInputElement>('#sel-b-parcels');
  parcels?.addEventListener('input', () => {
    const n = Number(parcels.value);
    const lbl = document.getElementById('val-b-parcels');
    if (lbl) lbl.textContent = `${n} 块`;
    patchOverride(selection.id, { parcels: n });
  });
  document.querySelector<HTMLSelectElement>('#sel-b-use')?.addEventListener('change', (ev) => {
    patchOverride(selection.id, { use: (ev.target as HTMLSelectElement).value as UseChoice });
  });
  const hgt = document.querySelector<HTMLInputElement>('#sel-b-height');
  hgt?.addEventListener('input', () => {
    const v = Number(hgt.value);
    const lbl = document.getElementById('val-b-height');
    if (lbl) lbl.textContent = `${v.toFixed(2)}×`;
    patchOverride(selection.id, { heightScale: v });
  });
  document.getElementById('sel-b-reset')?.addEventListener('click', () => {
    const next = { ...state.blockOverrides };
    delete next[selection.id];
    state.blockOverrides = next;
    markDirty();
    buildRight();
    view?.setBlockAxis(null);
  });
}

/** 改/加一个街区覆盖项（自动置脏 + 刷新应用条） */
function patchOverride(blockId: string, patch: Partial<BlockOverride>): void {
  if (selection.kind !== 'block') return;
  const cur = state.blockOverrides[blockId] ?? {};
  state.blockOverrides = { ...state.blockOverrides, [blockId]: { ...cur, ...patch } };
  markDirty();
}

function bindRight(): void {
  const bar = $('#rightbar');

  // ---- 规模
  const radius = document.querySelector<HTMLInputElement>('#rng-radius');
  const radiusVal = document.getElementById('val-radius');
  radius?.addEventListener('input', () => {
    state.radius = Number(radius.value);
    if (radiusVal) radiusVal.textContent = `${((state.radius * 7) / 1000).toFixed(2)} km`;
  });
  radius?.addEventListener('change', () => regenerate());

  // ---- 种子
  const seed = document.querySelector<HTMLInputElement>('#inp-seed');
  seed?.addEventListener('change', () => {
    const v = Math.abs(parseInt(seed.value, 10) || 1) % 2147483647;
    state.seed = v || 1;
    seed.value = String(state.seed);
    regenerate();
  });
  document.getElementById('btn-dice')?.addEventListener('click', () => {
    state.seed = Math.floor(Math.random() * 2_000_000_000) + 1;
    if (seed) seed.value = String(state.seed);
    regenerate();
  });
  document.getElementById('btn-regen')?.addEventListener('click', () => regenerate());
  document.getElementById('btn-reseed')?.addEventListener('click', () => {
    state.seed = Math.floor(Math.random() * 2_000_000_000) + 1;
    const s = document.querySelector<HTMLInputElement>('#inp-seed');
    if (s) s.value = String(state.seed);
    regenerate();
  });

  // ---- 风貌 / 用途 / 密度：改一个重算一次
  const segPick = (id: string, apply: (v: string) => void) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.querySelectorAll<HTMLButtonElement>('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const v = btn.dataset.v as string;
        el.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
        apply(v);
        regenerate();
      });
    });
  };
  segPick('seg-style', (v) => (state.style = v as CityStyle));
  segPick('seg-program', (v) => (state.program = v as CityProgram));
  segPick('seg-density', (v) => (state.density = v as CityDensity));

  // ---- 工具
  segPick('seg-zone-tool', (v) => setTool(v as Tool));
  segPick('seg-guide-tool', (v) => setTool(v as Tool));

  // ---- 禁区让距
  const pad = document.querySelector<HTMLInputElement>('#rng-zone-pad');
  const padVal = document.getElementById('val-zone-pad');
  pad?.addEventListener('input', () => {
    state.zonePadM = Number(pad.value);
    if (padVal) padVal.textContent = `${state.zonePadM} m`;
  });
  // 让距 / 衔接铺装都属"禁区编辑"，改了等应用
  pad?.addEventListener('change', () => markDirty());
  document.querySelector<HTMLInputElement>('#chk-zone-padpave')?.addEventListener('change', (ev) => {
    state.zonePadPave = (ev.target as HTMLInputElement).checked;
    markDirty();
  });
  // ---- 方向线强度
  const gs = document.querySelector<HTMLInputElement>('#rng-gstrength');
  const gsVal = document.getElementById('val-gstrength');
  gs?.addEventListener('input', () => {
    state.guideStrength = Number(gs.value);
    if (gsVal) gsVal.textContent = state.guideStrength.toFixed(2);
  });
  gs?.addEventListener('change', () => {
    if (state.guides.length === 0) return;
    state.guides = state.guides.map((g) => ({ ...g, strength: state.guideStrength }));
    regenerate();
  });

  // ---- 楼高
  const h = document.querySelector<HTMLInputElement>('#rng-height');
  const hVal = document.getElementById('val-height');
  h?.addEventListener('input', () => {
    state.heightScale = Number(h.value);
    if (hVal) hVal.textContent = `${state.heightScale.toFixed(2)}×`;
  });
  // 楼高会反过来影响体量 / 退线 / 间距，属于"重算级"参数 —— 但不立刻跑，等用户确认
  h?.addEventListener('change', () => markDirty());

  // ---- 投影
  const cam = document.getElementById('seg-camera');
  cam?.querySelectorAll<HTMLButtonElement>('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.camera = btn.dataset.v as CameraMode;
      cam.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
      view?.setCameraMode(state.camera);
      syncViewTab();
    });
  });

  // ---- 合并方式
  const merge = document.querySelector<HTMLSelectElement>('#sel-merge');
  merge?.addEventListener('change', () => {
    state.merge = merge.value as GlbMerge;
  });

  document.getElementById('btn-guides-clear')?.addEventListener('click', () => {
    state.guides = [];
    selection = { kind: 'none', id: '' };
    markDirty();
    refreshOverlays();
    buildRight();
    toast('方向线已清空 —— 按顶栏「应用并重建」生效');
  });
  document.getElementById('btn-export')?.addEventListener('click', doExport);
  document.getElementById('btn-share')?.addEventListener('click', () => {
    const url = shareUrl();
    try {
      history.replaceState(null, '', url);
    } catch {
      /* file:// 下会抛 */
    }
    navigator.clipboard?.writeText(url).then(
      () => toast(`场景链接已复制（${url.length} 字符）`),
      () => toast(url)
    );
  });

  bindSelectionPanel();
  // 应用条：改了禁区 / 方向线 / 街区覆盖之后，只有这里（或 Ctrl+Enter）会真正重建
  document.getElementById('btn-apply')?.addEventListener('click', applyEdits);
  document.getElementById('btn-discard')?.addEventListener('click', restoreSnapshot);

  void bar;
}

// ---------------------------------------------------------------- 禁区 / 方向线列表

function renderZoneList(): void {
  const list = $('#zone-list');
  if (!list) return;
  if (state.zones.length === 0) {
    list.innerHTML = `<div class="empty">还没有禁区。选矩形 / 圆 / 多边形，然后在图上拖拽或点击。</div>`;
    return;
  }
  list.innerHTML = state.zones
    .map(
      (z, i) => `<div class="zone-item ${z.enabled ? 'on' : ''} ${selection.kind === 'zone' && selection.id === z.id ? 'sel' : ''}" data-i="${i}">
        <input type="checkbox" class="chk-zone" data-i="${i}" ${z.enabled ? 'checked' : ''}/>
        <span class="swatch"></span>
        <span class="name">${z.label} · ${PURPOSE_LABEL[z.purpose ?? 'cbd']}</span>
        <button class="icon-btn del-zone" data-i="${i}" title="删除">✕</button>
      </div>`
    )
    .join('');
  list.querySelectorAll<HTMLInputElement>('.chk-zone').forEach((el) => {
    el.addEventListener('change', () => {
      const i = Number(el.dataset.i);
      state.zones = state.zones.map((z, k) => (k === i ? { ...z, enabled: el.checked } : z));
      markDirty();
      refreshOverlays();
    });
  });
  list.querySelectorAll<HTMLButtonElement>('.del-zone').forEach((el) => {
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const i = Number(el.dataset.i);
      const z = state.zones[i];
      state.zones = state.zones.filter((_, k) => k !== i);
      if (z && selection.kind === 'zone' && selection.id === z.id) selection = { kind: 'none', id: '' };
      markDirty();
      refreshOverlays();
      buildRight();
    });
  });
  list.querySelectorAll<HTMLElement>('.zone-item').forEach((el) => {
    el.addEventListener('click', (ev) => {
      if ((ev.target as HTMLElement).tagName === 'INPUT') return;
      const z = state.zones[Number(el.dataset.i)];
      if (!z) return;
      selectZone(z.id);
    });
  });
}

function renderGuideList(): void {
  const list = document.getElementById('guide-list');
  if (!list) return;
  if (state.guides.length === 0) {
    list.innerHTML = `<div class="empty">还没有方向线。点「画方向线」后在图上依次点击，双击结束。</div>`;
    return;
  }
  list.innerHTML = state.guides
    .map(
      (g, i) => `<div class="zone-item guide-item ${g.enabled ? 'on' : ''}" data-i="${i}">
        <input type="checkbox" class="chk-guide" data-i="${i}" ${g.enabled ? 'checked' : ''}/>
        <span class="swatch"></span>
        <span class="name">${g.label}</span>
        <span class="gpts">${g.pts.length} 点</span>
        <button class="icon-btn del-guide" data-i="${i}" title="删除">✕</button>
      </div>`
    )
    .join('');
  list.querySelectorAll<HTMLInputElement>('.chk-guide').forEach((el) => {
    el.addEventListener('change', () => {
      const i = Number(el.dataset.i);
      state.guides = state.guides.map((g, k) => (k === i ? { ...g, enabled: el.checked } : g));
      markDirty();
      refreshOverlays();
    });
  });
  list.querySelectorAll<HTMLButtonElement>('.del-guide').forEach((el) => {
    el.addEventListener('click', () => {
      const i = Number(el.dataset.i);
      state.guides = state.guides.filter((_, k) => k !== i);
      markDirty();
      refreshOverlays();
      buildRight();
    });
  });
}

/** 只刷列表与统计，不动滑杆（生成后调它，避免拖到一半的面板被重建） */
function refreshLists(): void {
  renderZoneList();
  renderGuideList();
  const selSec = document.querySelector('#rightbar .sel-patch');
  if (selSec) {
    selSec.outerHTML = selectionPanel() || '';
    bindSelectionPanel();
  }
}

// ---------------------------------------------------------------- 工具

function setTool(tool: Tool): void {
  state.tool = tool;
  view?.setTool(tool);
  document.querySelectorAll<HTMLButtonElement>('#seg-zone-tool button, #seg-guide-tool button').forEach((b) => {
    b.classList.toggle('active', b.dataset.v === tool);
  });
}

function selectZone(id: string): void {
  selection = { kind: 'zone', id };
  view?.setSelection(selection);
  syncHandles();
  buildRight();
  const z = state.zones.find((q) => q.id === id);
  toast(`已选中禁区「${z?.label ?? id}」`);
}

// ---------------------------------------------------------------- 统计 / 说明

function updateStats(ms = 0): void {
  if (!result) return;
  const st = result.stats;
  const km2 = (st.siteAreaM2 / 1e6).toFixed(2);
  $('#stats').innerHTML =
    `<div>${st.blockCount} 街区 · ${st.parcelCount} 地块 · ${st.buildingCount} 建筑 · ${km2} km²</div>` +
    `<div class="sub">道路 ${st.roadLengthM} m · 车位 ${st.parkingBays} · 树 ${st.treeCount} · GFA ${(st.gfaM2 / 1000).toFixed(0)}k m²${
      ms ? ` · ${ms} ms` : ''
    }</div>`;
  renderNotes();
}

/** 说明条目的显示上限：F3 会给出上百条逐地块的降级原因，全铺开会把画面吃掉 */
const NOTES_SHOWN = 20;

function renderNotes(): void {
  const box = document.getElementById('notes');
  if (!box || !result) return;
  // 完整列表挂到 window 上，面板只显示前 20 条（要看全部就开控制台）
  (window as unknown as { __f3Notes?: string[] }).__f3Notes = result.notes;
  /**
   * 逐街区明细（`B12 …` 开头）不上面板：一座城 160+ 条，全是"这块切了几块地"，
   * 面板上真正要看的是"整体降级 / 算不出来 / 面积对不上"这类。明细留在控制台。
   */
  const brief = result.notes.filter((n) => !/^B\d+/.test(n));
  const shown = brief.slice(0, NOTES_SHOWN);
  const rest = result.notes.length - shown.length;
  box.innerHTML = `<details class="sec"><summary><span class="dot"></span>生成说明<span class="sec-tag">${
    result.notes.length
  } 条</span></summary><div class="sec-body">${shown
    .map((n) => `<div class="note">${n}</div>`)
    .join('')}${
    rest > 0 ? `<div class="note">…另有 ${rest} 条（控制台 window.__f3Notes 看全部）</div>` : ''
  }</div></details>`;
}

function setBusy(on: boolean, text = ''): void {
  const el = document.getElementById('busy');
  if (!el) return;
  el.classList.toggle('on', on);
  el.textContent = text;
}

let toastTimer = 0;
function toast(text: string, isErr = false): void {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.className = isErr ? 'on err' : 'on';
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    el!.className = isErr ? 'err' : '';
  }, 2800);
}

// ---------------------------------------------------------------- 导出

function doExport(): void {
  if (!result) return;
  try {
    const prims = sceneToPrimitives(result.scene, {
      layers: makeFilter(state.vis),
      hiliteLotRoad: state.hiliteLotRoad,
      cityRadius: state.radius,
      merge: state.merge,
    });
    const glb = exportGLB(prims, `TownForge F3 · ${MERGE_LABEL[state.merge]}`);
    const blob = new Blob([glb.bytes as unknown as BlobPart], { type: 'model/gltf-binary' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `town_f3_${state.seed}_${state.merge}.glb`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast(
      `已导出 ${(glb.bytes.byteLength / 1024 / 1024).toFixed(2)} MB · ${glb.triangles} 三角形 · ${glb.meshes} 网格`
    );
  } catch (e) {
    console.error(e);
    toast(`导出失败：${(e as Error).message}`, true);
  }
}

// ---------------------------------------------------------------- 链接与偏好

const LS_SCENE = 'townforge.f3.v2';
const LS_LAYERS = 'townforge.layers.v2';

function encodeState(): string {
  const o = {
    s: state.seed,
    r: state.radius,
    st: state.style,
    p: state.program,
    d: state.density,
    h: state.heightScale,
    pd: state.zonePadM,
    gs: state.guideStrength,
    cam: state.camera,
    mg: state.merge,
    z: state.zones.map((z) => ({
      i: z.id,
      l: z.label,
      e: z.enabled,
      u: z.purpose ?? 'cbd',
      sh:
        z.shape.kind === 'rect'
          ? { k: 'r', a: [z.shape.a.x, z.shape.a.y], b: [z.shape.b.x, z.shape.b.y] }
          : z.shape.kind === 'circle'
            ? { k: 'c', c: [z.shape.c.x, z.shape.c.y], r: z.shape.r }
            : { k: 'p', p: z.shape.pts.map((q) => [q.x, q.y]) },
    })),
    g: state.guides.map((g) => ({ i: g.id, l: g.label, e: g.enabled, s: g.strength, p: g.pts.map((q) => [q.x, q.y]) })),
  };
  return btoa(unescape(encodeURIComponent(JSON.stringify(o))));
}

interface Decoded {
  seed?: number;
  radius?: number;
  style?: CityStyle;
  program?: CityProgram;
  density?: CityDensity;
  heightScale?: number;
  zonePadM?: number;
  guideStrength?: number;
  camera?: CameraMode;
  merge?: GlbMerge;
  zones?: Zone[];
  guides?: FieldGuide[];
}

function decodeState(code: string): Decoded | null {
  try {
    const o = JSON.parse(decodeURIComponent(escape(atob(code)))) as Record<string, unknown>;
    const out: Decoded = {
      seed: o.s as number,
      radius: o.r as number,
      style: o.st as CityStyle,
      program: o.p as CityProgram,
      density: o.d as CityDensity,
      heightScale: o.h as number,
      zonePadM: o.pd as number,
      guideStrength: o.gs as number,
      camera: o.cam as CameraMode,
      merge: o.mg as GlbMerge,
      zones: [],
      guides: [],
    };
    type ZJson = { i: string; l: string; e: boolean; u: ZonePurpose; sh: Record<string, unknown> };
    for (const z of (o.z as ZJson[]) ?? []) {
      const sh = z.sh as
        | { k: 'r'; a: [number, number]; b: [number, number] }
        | { k: 'c'; c: [number, number]; r: number }
        | { k: 'p'; p: [number, number][] };
      const shape =
        sh.k === 'r'
          ? { kind: 'rect' as const, a: new Pt(sh.a[0], sh.a[1]), b: new Pt(sh.b[0], sh.b[1]) }
          : sh.k === 'c'
            ? { kind: 'circle' as const, c: new Pt(sh.c[0], sh.c[1]), r: sh.r }
            : { kind: 'poly' as const, pts: sh.p.map(([x, y]) => new Pt(x, y)) };
      out.zones!.push(makeZone(z.i, z.l, shape, z.u));
      const last = out.zones![out.zones!.length - 1];
      last.enabled = z.e;
    }
    type GJson = { i: string; l: string; e: boolean; s: number; p: [number, number][] };
    for (const g of (o.g as GJson[]) ?? []) {
      const made = makeGuide(g.i, g.l, g.p.map(([x, y]) => new Pt(x, y)), g.s);
      made.enabled = g.e;
      out.guides!.push(made);
    }
    return out;
  } catch {
    return null;
  }
}

function applyDecoded(d: Decoded): void {
  if (typeof d.seed === 'number') state.seed = d.seed;
  if (typeof d.radius === 'number') state.radius = Math.max(RADIUS_MIN, Math.min(RADIUS_MAX, d.radius));
  if (d.style) state.style = d.style;
  if (d.program) state.program = d.program;
  if (d.density) state.density = d.density;
  if (typeof d.heightScale === 'number') state.heightScale = d.heightScale;
  if (typeof d.zonePadM === 'number') state.zonePadM = d.zonePadM;
  if (typeof d.guideStrength === 'number') state.guideStrength = d.guideStrength;
  if (d.camera) state.camera = d.camera;
  if (d.merge) state.merge = d.merge;
  if (d.zones) state.zones = d.zones;
  if (d.guides) state.guides = d.guides;
}

function shareUrl(): string {
  return `${location.origin}${location.pathname}#s=${encodeState()}`;
}

function saveLayers(): void {
  try {
    localStorage.setItem(LS_LAYERS, JSON.stringify(state.vis));
  } catch {
    /* 隐私模式 */
  }
}

function loadLayers(): void {
  try {
    const raw = localStorage.getItem(LS_LAYERS);
    if (!raw) return;
    const obj = JSON.parse(raw) as Record<string, boolean>;
    for (const k of Object.keys(defaultVisibility())) if (typeof obj[k] === 'boolean') state.vis[k] = obj[k];
  } catch {
    /* 旧格式 */
  }
}

// ---------------------------------------------------------------- 启动

function syncViewTab(): void {
  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((b) => b.classList.toggle('active', b.dataset.view === state.camera));
}

function applyQuery(): void {
  const q = new URLSearchParams(location.search);
  const num = (k: string): number | null => (q.has(k) ? Number(q.get(k)) : null);
  const r = num('r');
  if (r) state.radius = Math.max(RADIUS_MIN, Math.min(RADIUS_MAX, r));
  const seed = num('seed');
  if (seed) state.seed = seed;
  const st = q.get('style');
  if (st === 'structured' || st === 'organic' || st === 'campus') state.style = st;
  const p = q.get('program');
  if (p && p in PROGRAM_LABEL) state.program = p as CityProgram;
  const d = q.get('density');
  if (d === 'low' || d === 'medium' || d === 'high') state.density = d;
  const cam = q.get('view');
  if (cam === 'top' || cam === '2d') state.camera = 'top';
  if (cam === '3d' || cam === 'persp') state.camera = 'persp';
  // ?focusxy=x,y&span=n：把镜头拉到世界坐标（路口特写 / 截图核对用）
  const fxy = q.get('focusxy');
  if (fxy) {
    const [x, y] = fxy.split(',').map(Number);
    if (Number.isFinite(x) && Number.isFinite(y)) pendingFocus = { x, y, span: Number(q.get('span') ?? 16) };
  }
  const pick = q.get('pick');
  if (pick) pendingPick = pick;
  // ?zone=1 画两个示例禁区（截图 / 自测用，和 ?seed 同类）
  if (q.get('zone') === '1' && state.zones.length === 0) {
    state.zones = [
      makeZone('demo-rect', '矩形禁区', { kind: 'rect', a: new Pt(-52, -18), b: new Pt(-14, 26) }, 'park'),
      makeZone('demo-circle', '圆形禁区', { kind: 'circle', c: new Pt(38, 34), r: 22 }, 'cbd'),
    ];
    // ?zonepad=14：示例禁区的让距（截图核对"衔接铺装"用）
    const zp = Number(q.get('zonepad') ?? 0);
    if (zp > 0) state.zonePadM = zp;
    // ?zonerot=32：把示例矩形禁区旋转一下（截图核对"旋转后手柄还在不在"）
    const zr = Number(q.get('zonerot') ?? 0);
    if (zr) {
      const z0 = state.zones[0];
      state.zones[0] = rotateZone(z0, zoneCenterRadius(z0).c, (zr * Math.PI) / 180);
    }
  }
}

/**
 * 清掉退化的方向线（少于 2 点 / 折线长度 < 2 m）。
 *
 * 之前"场景默认多出一条控制线"多半就是这么来的：双击结束绘制时，两次点击落在
 * 同一位置，得到一条长度为 0 的"线"，界面上却显示成一条横穿全图的蓝线 ——
 * 它既不能改也不能删（旧版列表里没有编辑入口）。现在入口齐了，同时把这种
 * 退化数据在载入时直接丢掉。
 */
function sanitizeGuides(): void {
  state.guides = state.guides.filter((g) => {
    if (g.pts.length < 2) return false;
    let len = 0;
    for (let i = 0; i + 1 < g.pts.length; i++) len += Pt.distance(g.pts[i], g.pts[i + 1]);
    return len > 2;
  });
}

function boot(): void {
  loadLayers();
  // 顺序：先 #s= 快照（这是"哪座城"），再 ?seed 之类的覆盖参数 —— 两者不是二选一
  const hash = location.hash.replace(/^#/, '');
  if (hash.startsWith('s=')) {
    const dec = decodeState(hash.slice(2));
    if (dec) applyDecoded(dec);
  }
  applyQuery();
  sanitizeGuides();

  view = new View3D($('#view3d'), {
    onSelect: (sel) => {
      selection = sel;
      view?.setSelection(sel);
      syncHandles();
      if (sel.kind === 'block') {
        const b = result?.debug.blocks.find((q) => q.id === sel.id);
        // 选中即聚焦：把镜头推到这块地上（顶视走正交缩放，透视走 target + 距离）
        if (b && b.surface.outer.length >= 3) {
          let cx = 0;
          let cy = 0;
          for (const p of b.surface.outer) {
            cx += p.x;
            cy += p.y;
          }
          cx /= b.surface.outer.length;
          cy /= b.surface.outer.length;
          let rad = 0;
          for (const p of b.surface.outer) rad = Math.max(rad, Math.hypot(p.x - cx, p.y - cy));
          // 地块直径占视窗 30%（原来是 rad×1.7 的"取景高度"，几乎顶满屏幕）
          view?.focusOn(cx, cy, Math.max(24, rad * 2), 0.3);
        }
        toast(`街区 ${sel.id} · ${USE_LABEL[b?.use ?? ''] ?? ''} · ${((b?.areaM2 ?? 0) / 10000).toFixed(2)} ha`);
      } else if (sel.kind === 'zone') {
        toast(`已选中禁区「${state.zones.find((z) => z.id === sel.id)?.label ?? sel.id}」`);
      }
      buildRight();
    },
    onZoneDrawn: (shape) => {
      const n = state.zones.length + 1;
      const z = makeZone(`z${Date.now().toString(36)}`, `禁区 ${n}`, shape, 'cbd');
      state.zones = [...state.zones, z];
      setTool('select');
      selection = { kind: 'zone', id: z.id };
      markDirty();
      refreshOverlays();
      buildRight();
      toast('禁区已加入 —— 按顶栏「应用并重建」生效');
    },
    onGuideDrawn: (pts) => {
      const g = makeGuide(`g${Date.now().toString(36)}`, `方向线 ${state.guides.length + 1}`, pts, state.guideStrength);
      state.guides = [...state.guides, g];
      setTool('select');
      selection = { kind: 'guide', id: g.id };
      markDirty();
      refreshOverlays();
      buildRight();
      toast('方向线已加入 —— 按顶栏「应用并重建」生效');
    },
    onHandleDrag: (id, at) => dragHandle(id, at),
    onHandleDelete: (id) => deleteHandle(id),
    onHandleDragEnd: () => {
      zoneDragCtx = null;
      updateApplyBar();
    },
    onStatus: (text) => {
      const el = document.getElementById('hint');
      if (el) el.textContent = text;
    },
  });
  view.setHintHook((t) => {
    const el = document.getElementById('hint');
    if (el) el.textContent = t;
  });
  view.setCameraMode(state.camera);

  // 顶部页签 = 投影切换（透视 / 正交顶视）
  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.camera = btn.dataset.view as CameraMode;
      view?.setCameraMode(state.camera);
      syncViewTab();
      buildRight();
    });
  });
  document.getElementById('btn-export-top')?.addEventListener('click', doExport);
  document.getElementById('btn-fit')?.addEventListener('click', () => view?.fitAll());

  document.addEventListener('keydown', (e) => {
    const tag = (document.activeElement?.tagName ?? '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (e.key === 'Escape') {
      view?.cancelDraft();
      setTool('select');
      if (selection.kind !== 'none') {
        selection = { kind: 'none', id: '' };
        view?.setSelection(selection);
        buildRight();
      }
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      if (dirty) applyEdits();
      return;
    }
    if (e.key === 'z' || e.key === 'Z') {
      state.camera = state.camera === 'top' ? 'persp' : 'top';
      view?.setCameraMode(state.camera);
      syncViewTab();
      buildRight();
    }
  });

  buildRight();
  syncViewTab();
  regenerate();
}

boot();
