// 主界面：左栏（显示控制） / 中间画布 / 右栏（生成参数）
//
// 布局为什么改成三栏
// ------------------
// 原来所有东西挤在一个左栏里：显隐开关夹在路宽滑杆和禁建区工具之间，
// 调一次显隐要滚三次屏。而这两类操作的使用频率差别很大 ——
//   看图时高频：显隐、覆盖层、看指标   → 左栏，随画面一起看
//   生成时低频：种子、规模、参数       → 右栏，调完就不再动
// 所以左栏放"看"，右栏放"做"。

import './style.css';
import { Pt } from '../core/geom';
import { Model, type TownStyle } from '../town/model';
import type { ParkLevel } from '../town/parking';
import type { LayoutKind } from '../town/grid';
import { Zone, makeZone, area as polyArea } from '../town/zones';
import { Patch, patchKey, type PatchEdit } from '../town/patch';
import { USE_LABEL } from '../town/landuse';
import type { LandUse } from '../scene/types';
import { type FieldGuide, makeGuide } from '../town/guide';
import { View2D, type DrawMode, type RoadPick, type SelKind } from './view2d';
import { applySnapshot, decodeSnapshot, encodeSnapshot } from './snapshot';
import { View3D } from './view3d';
import { buildTownMeshes } from '../export/build3d';
import { applyScalePreset, isScalePreset } from '../road/scale-preset';
import { ROAD_SPECS, u } from '../road/spec';
import {
  type TownParams,
  type ParamSpec,
  type ParamTopic,
  type ParcelPattern,
  BLOCK_SPECS,
  BUILDING_SPECS,
  SPECS_BY_TOPIC,
  PARCEL_PATTERN_META,
  DEFAULT_PARCEL_PATTERNS,
  BUILDING_PRESETS,
  defaultParams,
  patternPercents,
  resolveParams,
} from '../town/params';
import { exportGLB } from '../export/glb';
import {
  LAYER_GROUPS,
  OVERLAY_GROUPS,
  type LayerGroupDef,
  defaultVisibility,
  makeFilter,
} from '../scene/layers';
// 只留 `diagnose`：左栏每行图层后面的数字靠它数。HUD 那个"场景体检"面板已删
// （用户核对意见：面板上的结论没人看，反而把显示控制挤出首屏）。
import { type Diagnostics, diagnose } from './hud';
import { mountPlannerHud, type PlannerHudState } from './planner-hud';
import type { PlanningMode } from '../scene/planner-bridge';

/** 街网形态的中文名（与 grid.ts 的 LayoutKind 一一对应） */
const LAYOUT_LABEL: Record<LayoutKind, string> = {
  grid: '方格网',
  field: '场线',
  radial: '放射环',
  tensor: '张量场',
};

const LAYOUT_TIP: Record<LayoutKind, string> = {
  grid: '方格网：全局正交街网 + 低频弯曲，主干道 / 次干道 / 支路三级。北美棋盘城形态。',
  field: '场线：旋涡张量场，街道绕中心连续弯曲，街廓仍是闭合地块。巴塞罗那扩展区形态。',
  radial: '放射环：同心环线 + 放射辐条，环半径带谐波起伏并轻微螺旋。华盛顿 / 堪培拉形态。',
  tensor: '张量场：基准方向 + 边界切向 + 中心旋涡/放射 + 禁建区轮廓合成场，沿场追流线，求交后切出封闭街区。全局一致、局部弯曲。',
};

/** 规模预设。选了只改 nPatches，滑杆仍可继续微调 */
const SIZE_PRESETS: { n: number; label: string; desc: string }[] = [
  { n: 6, label: '小镇', desc: '6 片街区' },
  { n: 10, label: '大镇', desc: '10 片街区' },
  { n: 15, label: '小城', desc: '15 片街区' },
  { n: 24, label: '大城', desc: '24 片街区' },
  { n: 40, label: '特大', desc: '40 片街区' },
];

/** 规模滑杆范围 */
const SIZE_MIN = 4;
const SIZE_MAX = 120;

// 错误提示条：白屏时至少能看见原因
let errorShown = false;
window.addEventListener('error', (e) => {
  if (errorShown) return;
  errorShown = true;
  const d = document.createElement('div');
  d.style.cssText =
    'position:fixed;left:0;right:0;bottom:0;background:#c4553f;color:#fff;padding:10px;font:12px ui-monospace,monospace;z-index:999;white-space:pre-wrap';
  d.textContent = `JS ERROR: ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}\n${(e.error as Error)?.stack ?? ''}`;
  document.body.appendChild(d);
});

interface State {
  nPatches: number;
  seed: number;
  plaza: boolean;
  style: TownStyle;
  zones: Zone[];
  guides: FieldGuide[];
  guideStrength: number;
  heightScale: number;
  zoneThreshold: number;
  layout: LayoutKind;
  /** 停车配比：界面上不再提供预设，保留字段以免打乱快照与模型契约 */
  parkingLevel: ParkLevel;
  /**
   * 规划模式（R8）：
   *   · legacy  —— 全部走现有链路（默认，行为不变）
   *   · planner —— industrial / multi_family / retail 三类由 Planner 接管
   *   · shadow  —— 渲染仍是 legacy，Planner 的方案叠成红色虚线
   */
  planningMode: PlanningMode;
  params: TownParams;
  /** 图层显隐（scene/layers.ts 的 id → 可见） */
  vis: Record<string, boolean>;
  /** 高亮地块内部道路（纯表现层，不参与生成与导出几何） */
  hiliteLotRoad: boolean;
  /** R1.4 内部交通开关：off / golden / all（本地开发默认 all） */
  circulationMode: 'off' | 'golden' | 'all';
  /** S1 场地布局骨架开关（默认 off，本轮只做三个 Golden 的方案对比） */
  s1Mode: 'off' | 'golden' | 'all';
  /** Pattern Registry 开关（与 s1 同构） */
  patternMode: 'off' | 'golden' | 'all';
  /** 停车求解器：legacy / placemaker / compare */
  parkingProvider: 'legacy' | 'placemaker' | 'compare';
  /** 单块地块的手动覆盖（键 = patchKey），跟着种子一起保存到 localStorage */
  patchEdits: Map<string, PatchEdit>;
  /**
   * 建筑高度档位（`BUILDING_PRESETS` 的 key）。
   *
   * 它只是一个**回显标记**：选了哪档就亮哪个按钮。真正的高度值直接写进
   * `params.building`，档位本身不参与生成 —— 所以手拖过任何一根建筑滑杆后，
   * 这里会退回 'custom'（四档都不亮），面板不撒谎。
   */
  buildingPreset: string;
}

const state: State = {
  nPatches: 15,
  seed: 682063530,
  plaza: true,
  // 三档红线宽直接取 road/spec.ts 的规范表：主干路 28 m（双向六车道）、
  // 次干路 20 m（双向四车道）、支路 10.5 m（双向两车道）。
  style: {
    mainStreetWidth: u(ROAD_SPECS.arterial.redLine),
    regularStreetWidth: u(ROAD_SPECS.collector.redLine),
    alleyWidth: u(ROAD_SPECS.local.redLine),
  },
  zones: [],
  hiliteLotRoad: false,
  circulationMode: 'all',
  s1Mode: 'off',
  patternMode: 'off',
  parkingProvider: 'legacy',
  guides: [],
  guideStrength: 0.8,
  heightScale: 1,
  zoneThreshold: 0.35,
  layout: 'tensor',
  parkingLevel: 'normal',
  planningMode: 'legacy',
  params: defaultParams(),
  vis: defaultVisibility(),
  patchEdits: new Map(),
  buildingPreset: 'mixed',
};

let model: Model;
let view2d: View2D;
let view3d: View3D | null = null;
/** 三维镜头已经聚焦过的地块键：同一个地块不重复推镜头 */
let focusedPatchKey: string | null = null;
let currentView: '2d' | '3d' = '2d';
/** 自动化截图用：`?patch` + `?zoom` 记下的地块中心，切到三维时让镜头跟过去 */
let lastFocus: { x: number; y: number; span: number } | null = null;
/** 当前在 2D 里点中的那条路（右栏"选中路"滑杆作用的对象） */
let currentRoad: RoadPick | null = null;
/** 最近一次体检结果（左栏 HUD 与图层计数都读它） */
let diag: Diagnostics | null = null;

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;
const vis = (id: string): boolean => state.vis[id] !== false;

/** 红线宽显示：世界单位 ≈ 7 m */
function formatWidth(w: number): string {
  return `${w.toFixed(1)} (${Math.round(w * 7)}m)`;
}

/**
 * 把"选中的路"同步到右栏滑杆。
 * 滑杆上下限随道路等级变（主干道下限 24 m、次干道 17 m、支路 8.5 m，
 * 低于下限街角圆角就画不出来）。
 */
function syncRoadRow(road: RoadPick | null): void {
  currentRoad = road;
  const row = document.getElementById('row-artery');
  const input = document.querySelector<HTMLInputElement>('#rng-artery');
  const val = document.getElementById('val-artery');
  const reset = document.querySelector<HTMLButtonElement>('#btn-artery-reset');
  if (!row || !input) return;
  if (!road) {
    row.style.opacity = '.45';
    input.disabled = true;
    if (reset) reset.disabled = true;
    if (val) val.textContent = '—';
    return;
  }
  row.style.opacity = '1';
  input.disabled = false;
  if (reset) reset.disabled = false;
  input.min = road.min.toFixed(1);
  input.max = String(road.max);
  input.value = String(Math.min(road.max, Math.max(road.min, road.width)));
  if (val) val.textContent = formatWidth(road.width) + (road.custom ? ' *' : '');
}

// ---------------------------------------------------------------- 生成

function createModel(): Model {
  return (() => {
    const m = new Model({
      nPatches: state.nPatches,
      seed: state.seed,
      plaza: state.plaza,
      zones: state.zones,
      guides: state.guides,
      style: state.style,
      zoneBlockThreshold: state.zoneThreshold,
      layout: state.layout,
      parkingLevel: state.parkingLevel,
      params: state.params,
      patchEdits: state.patchEdits,
    });
    m.generate();
    return m;
  })();
}

/**
 * 选中地块的稳定标识。
 *
 * 重建模型会造一批新的 Patch 对象，`view2d.selPatch` 那个引用就失效了。
 * 所以选中态在 app 层用 `patchKey`（质心取整）记着，重建之后按同一个键找回来 ——
 * 用户改完高度，高亮不会跳走。
 */
let selectedPatchKey: string | null = null;

function findPatchByKey(key: string): Patch | null {
  for (const p of model.patches) if (patchKey(p) === key) return p;
  return null;
}

/** 地块的平面中心（三维聚焦用；2D 的 y 就是三维的 z） */
function patchCenter(p: Patch): { x: number; y: number } {
  let sx = 0;
  let sy = 0;
  for (const q of p.shape) {
    sx += q.x;
    sy += q.y;
  }
  const n = Math.max(1, p.shape.length);
  return { x: sx / n, y: sy / n };
}

/**
 * 城内面积最大、且真盖了楼的那块地。
 *
 * 只给 `?patch=1` 用：截图和手测时得有一块"明显看得出变化"的地，
 * 挑小的改完看不出区别，等于白测。
 */
function biggestPatch(): Patch | null {
  let best: Patch | null = null;
  let bestA = 0;
  for (const p of model.patches) {
    if (p.blocked || !p.ward) continue;
    if (p.ward.geometry.length === 0) continue;
    const a = Math.abs(polyArea(Array.from(p.shape)));
    if (a > bestA) {
      bestA = a;
      best = p;
    }
  }
  return best;
}

/**
 * 重建之后把选中态找回来。
 *
 * `view2d.selPatch` 存的是对象引用，模型一换就指向旧世界；这里按 key 重新
 * 解析成新对象再塞回去，高亮的还是同一块地。真找不到了（改规模/换种子把
 * 它切没了）就静默取消选中 —— 留着一个指向不存在地块的 key 只会让面板显示
 * 一块"幽灵地块"。
 */
function syncPatchSelection(): void {
  if (!selectedPatchKey) return;
  const p = findPatchByKey(selectedPatchKey);
  if (p) {
    view2d.setSelectedPatch(p);
  } else {
    selectedPatchKey = null;
    view2d.setSelectedPatch(null);
  }
}

/** 统一的 3D 刷新入口：楼高 + 图层过滤 + 规划模式一起传，避免各处漏传 */
function refresh3D(): void {
  if (currentView !== '3d' || !view3d) return;
  view3d.setModel(model, {
    heightScale: state.heightScale,
    layers: makeFilter(state.vis),
    planningMode: state.planningMode,
    hiliteLotRoad: state.hiliteLotRoad,
    circulation: state.circulationMode,
    s1: state.s1Mode,
    pattern: state.patternMode,
    parkingProvider: state.parkingProvider,
  });
}

// ---------------------------------------------------------------- R8 · 规划模式

/** HUD 的渲染句柄（boot 里挂上） */
let renderPlannerHud: ((st: PlannerHudState) => void) | null = null;

/**
 * 切换规划模式。
 *
 * 关键点：**只改渲染链，不重跑城市生成**。
 * Planner 的方案是在 `buildScene` 里按地块现算的（SiteContext → Candidates →
 * realizeSitePlan），所以切模式只是换一个 Scene 装配方式，不需要重新生成城市。
 */
function applyPlanningMode(mode: PlanningMode): void {
  state.planningMode = mode;
  document.querySelectorAll<HTMLButtonElement>('.mode-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.mode === mode)
  );
  view2d.setSceneOptions({
    planningMode: mode,
    circulation: state.circulationMode,
    s1: state.s1Mode,
    pattern: state.patternMode,
    parkingProvider: state.parkingProvider,
  });
  view2d.draw();
  // 图层计数跟着换过的场景重算（buildLeft 内部会重新绑一遍事件）
  buildLeft();
  if (currentView === '3d') refresh3D();
  updateStats();
  updatePlannerHud();
  const n = view2d.plannerBundle?.stats.covered ?? 0;
  toast(
    mode === 'legacy'
      ? 'Legacy：全部走现有链路'
      : mode === 'planner'
        ? `Planner：接管 ${n} 块地（工业 / 多层住宅 / 零售）`
        : `Shadow：Planner 方案叠在 legacy 之上（${n} 块）`
  );
}

/** 刷新 Debug HUD：显示选中地块（或全局摘要）的 Planner 报告 */
function updatePlannerHud(): void {
  if (!renderPlannerHud) return;
  const bundle = view2d.plannerBundle ?? null;
  const report = selectedPatchKey ? bundle?.reports.get(selectedPatchKey) ?? null : null;
  renderPlannerHud({ mode: state.planningMode, report, bundle });
}

function regenerate(): void {
  try {
    model = createModel();
    view2d.setModel(model, { keepView: true });
    syncPatchSelection();
    applyViewFlags();
    if (currentView === '3d') refresh3D();
    updateStats();
    refreshDiag();
    updatePlannerHud();
    syncHashSoon();
  } catch (e) {
    toast(`生成失败：${(e as Error).message}`, true);
  }
}

/** 只重建几何，不重跑 Voronoi（拖点、改路宽走这条） */
function rebuildGeometry(): void {
  try {
    model.rebuild();
    syncPatchSelection();
    view2d.draw();
    if (currentView === '3d') refresh3D();
    updateStats();
    refreshDiag();
    updatePlannerHud();
  } catch (e) {
    toast(`重建失败：${(e as Error).message}`, true);
    view2d.draw();
  }
}

function updateZones(zones: Zone[]): void {
  state.zones = zones;
  model.zones = zones;
  model.setZones(zones);
  view2d.setZones(zones);
  view2d.draw();
  renderZoneList();
  updateStats();
  refreshDiag();
  if (currentView === '3d') refresh3D();
}

function updateGuides(guides: FieldGuide[]): void {
  state.guides = guides;
  view2d.setGuides(guides);
  renderGuideList();
  regenerate();
}

function updateStats(): void {
  const s = model.stats();
  // 建筑数取**场景**里的实际值：Planner 模式下场景和 model 不是一回事
  // （model 统计的是 legacy 生成的建筑），显示 model 的数字会让人以为没生效。
  const nBuildings = view2d?.sceneBuildingCount ?? s.buildings;
  const parts = [`${s.patches} 地块`, `${nBuildings} 建筑`];
  if (s.blocked > 0) parts.push(`<span style="color:#c4553f">${s.blocked} 禁建</span>`);

  // 第二行是"场景指纹"：同一座城 = 同一组（种子 + 主开关 + 手画物件）。
  const P = state.params.block;
  const fp = [
    `种子 ${state.seed}`,
    `${state.nPatches} 街区`,
    LAYOUT_LABEL[state.layout],
    P.parcelize ? `小地块 ${P.parcelPitchM}m` : '整块地块',
    P.zoneAvoid ? `避让 ${P.zoneAvoidPadM}m${P.zoneAvoidBend ? '·弧线' : ''}` : '避让关',
    P.serviceLoop ? '服务环路' : '',
    state.guides.length > 0 ? `方向线 ${state.guides.length}` : '',
    state.zones.length > 0 ? `禁建 ${state.zones.length}` : '',
  ].filter(Boolean);

  $('#stats').innerHTML =
    `<div>${parts.join(' · ')}</div>` +
    `<div style="opacity:.62;margin-top:2px;font-size:10px">${fp.join(' · ')}</div>`;
}

// ---------------------------------------------------------------- 左栏：显示控制 + HUD

function layerItemHtml(id: string, label: string, color: string | undefined, n: number | undefined): string {
  const on = vis(id);
  return `<label class="lyr-item ${on ? '' : 'off'}" data-for="${id}" title="${label}">
      <input type="checkbox" data-layer="${id}" ${on ? 'checked' : ''}/>
      ${color ? `<span class="sw" style="background:${color}"></span>` : ''}
      <span class="lb">${label}</span>
      ${n !== undefined ? `<span class="n" data-count="${id}">${n}</span>` : ''}
    </label>`;
}

/**
 * 一个图层分组。
 *
 * 做成 `<details>` 可折叠：分组有 8 个，全展开会把下面的 HUD 顶到屏幕外 ——
 * 而显隐和 HUD 是同一件事的两面（改完显隐就想立刻看指标变化）。
 * 默认只展开最常动的几组（建筑 / 道路 / 覆盖层）。
 */
function layerGroupHtml(g: LayerGroupDef, counts: Record<string, number>, withCount: boolean): string {
  const items = g.items
    .map((it) => layerItemHtml(it.id, it.label, it.color, withCount ? (counts[it.id] ?? 0) : undefined))
    .join('');
  const total = withCount ? g.items.reduce((a, it) => a + (counts[it.id] ?? 0), 0) : null;
  const onCnt = g.items.filter((it) => vis(it.id)).length;
  return `<details class="lyr-group" ${g.open ? 'open' : ''}>
      <summary class="lyr-head">
        <b>${g.label}</b>
        <span class="cnt">${onCnt}/${g.items.length}${total !== null ? ` · ${total}` : ''}</span>
        <span class="mini">
          ${
            g.id === 'lotroad'
              ? `<button data-hact="hilite" class="${state.hiliteLotRoad ? 'on' : ''}" title="把内部道路临时染成橙红，便于辨认">高亮</button>`
              : ''
          }
          <button data-gact="all" data-group="${g.id}">全显</button>
          <button data-gact="none" data-group="${g.id}">全隐</button>
        </span>
      </summary>
      ${items}
    </details>`;
}

/**
 * 左栏。
 *
 * 左栏只有一块：显示控制。
 *
 * 原来它上面还有一块"HUD 分析"（场景总量 / 用地构成 / 规则体检 / 里程），
 * 默认展开置顶，九组图层一展开就把它挤出首屏 —— 用户核对时说的是"这块没人看"。
 * 已整块删除，`src/ui/hud.ts` 里只留 `diagnose`（左栏每行后面的数字靠它数）。
 */
function buildLeft(): void {
  // 数字跟**当前渲染的场景**走：切到 Planner 之后地块内部多了几十块路面，
  // 还用 boot 时 legacy 的计数就会出现"内部车行路面 0、画面上却有路"。
  const counts = view2d?.layerCounts() ?? diag?.layerCounts ?? {};
  const sceneGroups = LAYER_GROUPS.map((g) => layerGroupHtml(g, counts, true)).join('');
  const overGroups = OVERLAY_GROUPS.map((g) => layerGroupHtml(g, counts, false)).join('');

  $('#leftbar').innerHTML = `
    <details class="sec" open>
      <summary><span class="dot"></span>显示控制<span class="sec-tag">画布 · 三维 · 导出</span></summary>
      <div class="sec-body">
        <div class="lyr-tools">
          <button data-cact="all">要素全显</button>
          <button data-cact="none">要素全隐</button>
          <button data-cact="reset" title="恢复出厂显隐">默认</button>
        </div>
        ${sceneGroups}
        ${overGroups}
      </div>
    </details>`;

  bindLeft();
}

/** 重数一遍各图层有多少个要素，刷到左栏每行后面的数字上 */
function refreshDiag(): void {
  try {
    diag = diagnose(model);
  } catch (e) {
    diag = null;
    console.warn('要素统计失败', e);
  }
  if (diag) {
    for (const g of LAYER_GROUPS) {
      for (const it of g.items) {
        const el = document.querySelector<HTMLElement>(`[data-count="${it.id}"]`);
        if (el) el.textContent = String(diag.layerCounts[it.id] ?? 0);
      }
    }
  }
}

function bindLeft(): void {
  const bar = $('#leftbar');

  // 单个图层
  bar.querySelectorAll<HTMLInputElement>('input[data-layer]').forEach((el) => {
    el.addEventListener('change', () => {
      const id = el.dataset.layer as string;
      state.vis[id] = el.checked;
      el.closest('.lyr-item')?.classList.toggle('off', !el.checked);
      onVisibilityChanged();
    });
  });

  // 组级附加动作：目前只有「内部道路 → 高亮」
  bar.querySelectorAll<HTMLButtonElement>('button[data-hact]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.hiliteLotRoad = !state.hiliteLotRoad;
      btn.classList.toggle('on', state.hiliteLotRoad);
      onVisibilityChanged();
      toast(state.hiliteLotRoad ? '内部道路已高亮（橙红）' : '内部道路高亮已关闭');
    });
  });

  // 整组全显 / 全隐
  bar.querySelectorAll<HTMLButtonElement>('button[data-gact]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const gid = btn.dataset.group as string;
      const g = [...LAYER_GROUPS, ...OVERLAY_GROUPS].find((q) => q.id === gid);
      if (!g) return;
      const on = btn.dataset.gact === 'all';
      for (const it of g.items) state.vis[it.id] = on;
      // 只刷这一组的勾选状态，不重建整栏（否则滚动位置会跳）
      for (const it of g.items) {
        const cb = bar.querySelector<HTMLInputElement>(`input[data-layer="${it.id}"]`);
        if (cb) {
          cb.checked = on;
          cb.closest('.lyr-item')?.classList.toggle('off', !on);
        }
      }
      onVisibilityChanged();
    });
  });

  // 要素总控：只作用于 LAYER_GROUPS（覆盖层与 HUD 不动）
  bar.querySelectorAll<HTMLButtonElement>('button[data-cact]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const act = btn.dataset.cact as 'all' | 'none' | 'reset';
      const def = defaultVisibility();
      for (const g of LAYER_GROUPS) {
        for (const it of g.items) {
          state.vis[it.id] = act === 'all' ? true : act === 'none' ? false : def[it.id] !== false;
          const cb = bar.querySelector<HTMLInputElement>(`input[data-layer="${it.id}"]`);
          if (cb) {
            cb.checked = state.vis[it.id];
            cb.closest('.lyr-item')?.classList.toggle('off', !state.vis[it.id]);
          }
        }
      }
      onVisibilityChanged();
      if (act === 'none') toast('要素全隐了，看指标时点「要素全显」恢复', true);
      else if (act === 'reset') toast('要素显隐已恢复默认');
    });
  });
}

/** 显隐变化：同步到 2D / 3D / HUD，并把偏好存下来 */
function onVisibilityChanged(): void {
  applyViewFlags();
  if (currentView === '3d') refresh3D();
  saveLayers();
}

/** 把 state.vis 铺到 View2D 的各开关上 */
function applyViewFlags(): void {
  view2d.setLayerVisibility(makeFilter(state.vis));
  view2d.hiliteLotRoad = state.hiliteLotRoad;
  view2d.showBlocks = vis('ov:blocks');
  view2d.showVertices = vis('ov:vertices');
  view2d.showZones = vis('ov:zones');
  view2d.showGuides = vis('ov:guides');
  view2d.showRedline = vis('ov:redline');
  view2d.showCenterline = vis('ov:centerline');
  view2d.showJunctions = vis('ov:junctions');
  view2d.showUse = vis('ov:use');
  view2d.showCirExisting = vis('ov:cir-existing');
  view2d.showCirNew = vis('ov:cir-new');
  view2d.showCirMerged = vis('ov:cir-merged');
  view2d.showCirPortals = vis('ov:cir-portals');
  view2d.showCirUnreachable = vis('ov:cir-unreachable');
  view2d.draw();
}

// ---------------------------------------------------------------- 右栏：生成参数

/** `?open=1` 把右栏所有分区一次展开 —— 截图核对版式、以及一次性调一堆参数时用 */
const FORCE_OPEN = new URLSearchParams(location.search).get('open') === '1';

function details(title: string, body: string, open = false): string {
  return `<details class="sec" ${open || FORCE_OPEN ? 'open' : ''}><summary><span class="dot"></span>${title}</summary><div class="sec-body">${body}</div></details>`;
}

/**
 * 一行参数滑杆。
 * `input` 只更新数字标签（拖动时不该每帧重跑生成，一次生成 ~400 ms）；
 * 真正的重生成挂在 `change`（松手）上。
 */
function paramRow(group: 'block' | 'building', sp: ParamSpec): string {
  const v = (state.params[group] as unknown as Record<string, number>)[sp.key];
  const id = `p-${group}-${sp.key}`;
  return `<div class="row"><label>${sp.label}</label>
      <input type="range" class="grow" id="rng-${id}" min="${sp.min}" max="${sp.max}" step="${sp.step}"
             value="${v}" data-pgroup="${group}" data-pkey="${sp.key}"/>
      <span class="val" id="val-${id}">${v}${sp.unit ?? ''}</span>
    </div>${sp.hint ? `<div class="tip" style="margin:-2px 0 6px 0">${sp.hint}</div>` : ''}`;
}

/**
 * 某个主题下的全部参数行。
 *
 * 以前这 21 个参数平铺在一个「地块与建筑参数」里：要调巷道宽，得先滚过
 * 塔楼比例、退线系数；要调避障让距，得滚过寻路代价。参数和它真正影响的
 * 那块功能离得太远，改一个值得来回找。
 * 现在按主题拆开，挂到街道 / 禁建区 / 地块 / 建筑各自的分区下面。
 */
function specRows(topic: ParamTopic, adv = false): string {
  return SPECS_BY_TOPIC[topic]
    .filter(({ sp }) => Boolean(sp.adv) === adv)
    .map(({ ns, sp }) => paramRow(ns, sp))
    .join('');
}

/**
 * 「高级参数」折叠区：把这个分区里的 `adv` 参数收起来，默认不展开。
 *
 * 用户核对意见是"移除或者预设化一些复杂的参数"。这些参数都满足同一条：
 * 默认值已经很难调坏，动它只改变精细度，不改变城市读起来合不合理
 * （巷道宽 3.5 m 还是 4.5 m、裙房进深 6 m 还是 8 m）。留在主面板上只会
 * 让人不敢动主面板。真正要抠细节的人点开就有，一个都没删。
 */
function advBox(topics: ParamTopic[], title = '高级参数', extra = ''): string {
  const rows = topics.map((t) => specRows(t, true)).join('');
  if (!rows.trim() && !extra.trim()) return '';
  return `<details class="lyr-sub adv-sub">
      <summary>${title}</summary>
      <div class="lyr-sub-body">${extra}${rows}</div>
    </details>`;
}

/**
 * 「切分模式比重」那一组：堆叠条 + 五行滑杆 + 两个快捷按钮。
 *
 * 权重是**相对值**，所以每行右边给的不是权重本身（0.28 读不出"占三成"），
 * 而是归一化后的百分比；堆叠条画的是同一份百分比，拖滑杆时条子实时跟着变。
 * 全 0 时 `patternPercents` 会按"退回 ortho 100%"回报 —— 这与引擎里
 * `pickParcelPattern` 的兜底是同一条规则，面板不撒谎。
 */
function parcelPatternGroup(): string {
  const w = state.params.block.parcelPatterns;
  const pct = patternPercents(w);
  const on = state.params.block.parcelize;

  const bar = PARCEL_PATTERN_META.map(
    (m) =>
      `<i class="k-${m.key}${pct[m.key] === 0 ? ' zero' : ''}" data-seg="${m.key}" style="width:${pct[m.key]}%" title="${m.label} ${pct[m.key]}%"></i>`
  ).join('');

  const rows = PARCEL_PATTERN_META.map(
    (m) => `<div class="pat-row">
        <span class="swatch k-${m.key}"></span>
        <label title="${m.desc}">${m.label}</label>
        <input type="range" min="0" max="1" step="0.02" value="${w[m.key]}" data-pattern="${m.key}"/>
        <span class="val" id="val-pat-${m.key}">${pct[m.key]}%</span>
      </div>`
  ).join('');

  return `<div class="grp-label">切分模式比重</div>
    <div class="pat-group${on ? '' : ' off'}" id="pat-group">
      <div class="pat-bar" id="pat-bar">${bar}</div>
      ${rows}
      <div class="row" style="margin-top:8px">
        <button class="ghost grow" id="btn-pat-even">均分</button>
        <button class="ghost grow" id="btn-pat-reset">默认配比</button>
      </div>
      <div class="tip" style="margin-top:6px">
        每个街区按这个比重<b>抽</b>一种切法，百分比是全城的大致配比（不是逐块指定 —— 要指定就点中那块地）。
        ${on ? '' : '<br/><b>当前「街区切成小地块」是关的，这组比重对普通街区不起作用。</b>'}
      </div>
    </div>`;
}

/**
 * 手动切分的块数上限。
 *
 * 自动路径封顶 2 刀（4 块，见 modern.ts planParcels）；面板允许到 8 块，
 * 是因为这是**用户明确下达**的指令，引擎会给手动指定放开到 3 刀。
 * 再往上（16 块）每块只剩 13 m 见方，退线完盖不出楼，纯属骗人。
 */
const MANUAL_MAX_BLOCKS = 8;

/**
 * 「选中地块」面板。
 *
 * 只在 2D 里点中一块地时出现，放在右栏最上面 —— 它和下面的全局参数是
 * **不同层级**的东西：全局参数一改全城重来，这里只改这一块。
 *
 * 四个旋钮分别对应 PatchEdit 的四个字段：用途 / 高度倍率 / 切分目标面积 / 切分模式。
 * 面板上「切分」一栏给的是**块数**（1~8），提交时换算成目标面积
 * （地块面积 ÷ 块数）—— 用户想的是"这块地切成几栋"，不是"目标多少平米"。
 * 「模式」一栏是单选：留空就跟全局比重抽签，选了就固定这一种切法。
 */
function patchPanel(): string {
  const p = model.patches.find((q) => patchKey(q) === selectedPatchKey);
  if (!p) return '';
  const areaU = Math.abs(polyArea(Array.from(p.shape)));
  const edit = state.patchEdits.get(selectedPatchKey as string) ?? {};
  const use = p.override?.use ?? (p.ward as unknown as { use?: LandUse } | null)?.use ?? 'residential';
  const hk = edit.heightK ?? 1;
  // 当前切分块数：把目标面积反算回"块数"（下限 1）。
  //
  // 没手动指定时必须按**自动路径的真实上限**（4 块）来报数，不能拿
  // "面积 ÷ 目标面积"直接算 —— 那个商数只是理论值，自动切分的深度封顶
  // 2 刀，一块 280 u² 的地算出来 13 块、实际只切 4 块。面板报 13 而画面上
  // 站着 4 栋，用户只会觉得这个滑杆是坏的。
  const baseTarget = state.params.block.parcelPitchM ** 2 / 49;
  const manual = typeof edit.parcelTargetA === 'number' && edit.parcelTargetA > 1;
  const autoBlocks = Math.max(1, Math.min(4, Math.round(areaU / baseTarget)));
  const nBlocks = manual
    ? Math.max(1, Math.min(MANUAL_MAX_BLOCKS, Math.round(areaU / (edit.parcelTargetA as number))))
    : autoBlocks;
  const isBlocked = p.blocked;

  // 切分模式：留一个「跟随全局」的空选项。空值在 PatchEdit 里就表示"这一项没改过"，
  // 分享链接的序列化也会跳过它 —— 所以默认值必须是空串，不能写成 'ortho'。
  const patternOptions =
    `<option value="" ${edit.pattern ? '' : 'selected'}>跟随全局配比</option>` +
    PARCEL_PATTERN_META.map(
      (m) => `<option value="${m.key}" ${edit.pattern === m.key ? 'selected' : ''}>${m.label} · ${m.desc}</option>`
    ).join('');

  // 「这块到底切成了什么样」要报真话：usedPattern 是生成时记下的实际结果。
  // 不在这里重跑抽签 —— 抽签依赖随机流，面板重跑一次就和画面不是同一座城了。
  const usedMeta = PARCEL_PATTERN_META.find((m) => m.key === p.usedPattern);
  const usedLabel = usedMeta ? usedMeta.label : '未切分';
  const usedNote = usedMeta
    ? edit.pattern
      ? '（手动指定）'
      : '（按全局配比抽到）'
    : // 没切分却选了模式：切法无从谈起，必须说清，否则用户以为选择器坏了
      edit.pattern
      ? '<span style="color:var(--accent)">（这块目前没有切成小地块，选的模式不会生效）</span>'
      : '（整块规划：面积没到切分门槛、用途不切、或「街区切成小地块」关着）';

  const useOptions = (Object.keys(USE_LABEL) as LandUse[])
    .map((k) => `<option value="${k}" ${k === use ? 'selected' : ''}>${USE_LABEL[k]}</option>`)
    .join('');

  return `<details class="sec sel-patch" open>
      <summary><span class="dot"></span>选中地块<span class="sec-tag">${(areaU * 49).toFixed(0)} m²</span></summary>
      <div class="sec-body">
        ${
          isBlocked
            ? `<div class="tip" style="margin-bottom:8px">这块被禁建区整块占据，只出地坪、不排建筑。要盖楼请先改禁区。</div>`
            : `<div class="row"><label>用地</label>
                <select id="sel-use" class="grow">${useOptions}</select>
              </div>
              <div class="row"><label>高度</label>
                <div class="range-inline grow">
                  <input type="range" id="sel-hk" min="0.3" max="2.5" step="0.05" value="${hk}"/>
                  <span class="val" id="sel-hk-val">×${hk.toFixed(2)}</span>
                </div>
              </div>
              <div class="row"><label>切分</label>
                <div class="range-inline grow">
                  <input type="range" id="sel-nb" min="1" max="${MANUAL_MAX_BLOCKS}" step="1" value="${nBlocks}"/>
                  <span class="val" id="sel-nb-val">${nBlocks} 栋${manual ? '' : '·自动'}</span>
                </div>
              </div>
              <div class="row"><label>模式</label>
                <select id="sel-pattern" class="grow">${patternOptions}</select>
              </div>
              <div class="tip" style="margin-top:6px">当前这块实际切法：<b>${usedLabel}</b>${usedNote}</div>
              <div class="tip" style="margin-top:6px">「切分」= 这块地切成几个小地块（每块一栋楼），1 就是整块一栋。不拖这个滑杆时跟着全局「小地块边长」走（自动最多 4 块）；拖过之后这一块单独按你给的块数切，最多 ${MANUAL_MAX_BLOCKS} 块。生效前提是城市参数里开着「街区切成小地块」。</div>
              <div class="tip" style="margin-top:6px">「模式」这一栏只作用于这块地：不选就跟全局「切分模式比重」一起抽签，选了就固定用那一种。想看清某种切法长什么样，选一个再对比就最快。</div>`
        }
        <div class="row" style="margin-top:8px">
          <button class="ghost grow" id="sel-clear">清除这块的改动</button>
        </div>
        <div class="tip" style="margin-top:6px">按住 Shift 拖动画布可以平移，滚轮缩放。点空白处取消选中。</div>
      </div>
    </details>`;
}

/** 把选中地块面板接到事件上（每次重建右栏后调用） */
function bindPatchPanel(): void {
  const useSel = document.getElementById('sel-use') as HTMLSelectElement | null;
  if (useSel) {
    useSel.addEventListener('change', () => {
      applyPatchEdit({ use: useSel.value as LandUse });
    });
  }
  const hk = document.getElementById('sel-hk') as HTMLInputElement | null;
  if (hk) {
    hk.addEventListener('input', () => {
      const el = document.getElementById('sel-hk-val');
      if (el) el.textContent = `×${Number(hk.value).toFixed(2)}`;
    });
    hk.addEventListener('change', () => applyPatchEdit({ heightK: Number(hk.value) }));
  }
  const nb = document.getElementById('sel-nb') as HTMLInputElement | null;
  if (nb) {
    nb.addEventListener('input', () => {
      const el = document.getElementById('sel-nb-val');
      if (el) el.textContent = `${nb.value} 栋`;
    });
    nb.addEventListener('change', () => {
      const p = findPatchByKey(selectedPatchKey ?? '');
      if (!p) return;
      const areaU = Math.abs(polyArea(Array.from(p.shape)));
      const n = Math.max(1, Math.min(MANUAL_MAX_BLOCKS, Number(nb.value)));
      applyPatchEdit({ parcelTargetA: areaU / n });
    });
  }
  // 切分模式：选空串 = "这一项没改过"，要把字段从覆盖里删掉（不是存个空值），
  // 否则分享链接会带一个没意义的字段，清除按钮也清不干净。
  const pat = document.getElementById('sel-pattern') as HTMLSelectElement | null;
  if (pat) {
    pat.addEventListener('change', () => {
      const key = selectedPatchKey;
      if (!key) return;
      const cur = { ...(state.patchEdits.get(key) ?? {}) };
      if (pat.value) cur.pattern = pat.value as ParcelPattern;
      else delete cur.pattern;
      if (Object.keys(cur).length > 0) state.patchEdits.set(key, cur);
      else state.patchEdits.delete(key);
      regenerate();
      buildRight();
    });
  }
  const clear = document.getElementById('sel-clear');  if (clear) {
    clear.addEventListener('click', () => {
      if (selectedPatchKey) state.patchEdits.delete(selectedPatchKey);
      regenerate();
      buildRight();
      bindRight();
      toast('这块地的改动已清除');
    });
  }
}

/** 记一条覆盖并重建。用途变了要重跑用途层，所以走 regenerate（不是 rebuild） */
function applyPatchEdit(patch: Partial<PatchEdit>): void {
  if (!selectedPatchKey) return;
  const cur = state.patchEdits.get(selectedPatchKey) ?? {};
  state.patchEdits.set(selectedPatchKey, { ...cur, ...patch });
  regenerate();
  // buildRight 内部已经接了 bindRight / bindPatchPanel —— 这里再补一次会让
  // 每个控件挂两套监听（改一次滑杆重生成两遍城）。之前就是这么写的。
  buildRight();
}

function buildRight(): void {
  const sel = selectedPatchKey ? patchPanel() : '';
  // ---- 城市
  const city = details(
    '城市',
    `
    <div class="row"><label>预设</label>
      <div class="seg" id="seg-size">
        ${SIZE_PRESETS.map(
          (s) => `<button data-n="${s.n}" title="${s.desc}" class="${s.n === state.nPatches ? 'active' : ''}">${s.label}</button>`
        ).join('')}
      </div>
    </div>
    <div class="row"><label>规模</label>
      <div class="range-inline grow">
        <input type="range" id="rng-size" min="${SIZE_MIN}" max="${SIZE_MAX}" step="1" value="${state.nPatches}"/>
        <span class="val" id="val-size">${state.nPatches}</span>
      </div>
    </div>
    <div class="row"><label>布局</label>
      <div class="seg" id="seg-layout">
        ${(Object.keys(LAYOUT_LABEL) as LayoutKind[])
          .map((k) => `<button data-layout="${k}" class="${k === state.layout ? 'active' : ''}">${LAYOUT_LABEL[k]}</button>`)
          .join('')}
      </div>
    </div>
    <div class="row"><label>种子</label>
      <input type="number" id="inp-seed" value="${state.seed}" class="grow" />
      <button class="ghost" id="btn-dice" title="随机种子">随机</button>
    </div>
    <div class="row"><label class="check"><input type="checkbox" id="chk-plaza" ${state.plaza ? 'checked' : ''}/>中心广场</label></div>
    <div class="row" style="margin-top:10px"><button class="ghost grow" id="btn-regen">重新生成</button></div>
    <div class="tip" style="margin-top:8px">${LAYOUT_TIP[state.layout]}</div>
    `,
    true
  );

  // ---- 街道：全局路宽 + 巷道 / 内部路 / 寻路代价
  const road = details(
    '街道',
    `
    <div class="row"><label>主干道</label>
      <input type="range" id="rng-main" min="0.6" max="8" step="0.2" value="${state.style.mainStreetWidth}" class="grow"/>
      <span class="val" id="val-main">${state.style.mainStreetWidth.toFixed(1)}</span>
    </div>
    <div class="row"><label>次干道</label>
      <input type="range" id="rng-regular" min="0.4" max="6" step="0.2" value="${state.style.regularStreetWidth}" class="grow"/>
      <span class="val" id="val-regular">${state.style.regularStreetWidth.toFixed(1)}</span>
    </div>
    <div class="row"><label>支路</label>
      <input type="range" id="rng-alley" min="0.2" max="4" step="0.1" value="${state.style.alleyWidth}" class="grow"/>
      <span class="val" id="val-alley">${state.style.alleyWidth.toFixed(1)}</span>
    </div>
    <div class="row" id="row-artery" style="opacity:.45">
      <label>选中路</label>
      <input type="range" id="rng-artery" min="1" max="6" step="0.1" value="2" class="grow" disabled/>
      <span class="val" id="val-artery">—</span>
      <button class="ghost" id="btn-artery-reset" title="恢复按道路等级默认宽度" disabled>↺</button>
    </div>
    <div class="tip" style="margin-top:6px">红线宽按 1 单位 ≈ 7 m 折算：主干道 ${u(
      ROAD_SPECS.arterial.redLine
    ).toFixed(1)} ≈ ${ROAD_SPECS.arterial.redLine} m（双向六车道），次干道 ${u(ROAD_SPECS.collector.redLine).toFixed(
      1
    )} ≈ ${ROAD_SPECS.collector.redLine} m（双向四车道），支路 ${u(ROAD_SPECS.local.redLine).toFixed(1)} ≈ ${
      ROAD_SPECS.local.redLine
    } m（双向两车道）。在图上点任意一条路可单独调宽。</div>
    <div class="grp-label">地块内巷道与内部路</div>
    ${specRows('road')}
    ${advBox(
      ['road'],
      '巷道 / 内部路 / 寻路',
      `<div class="row"><label>内部路网</label>
        <div class="seg" id="seg-inner">
          <button data-inner="tensor" class="${state.params.block.internalRoads === 'tensor' ? 'active' : ''}">张量主轴</button>
          <button data-inner="path" class="${state.params.block.internalRoads === 'path' ? 'active' : ''}">A* 寻路</button>
        </div>
      </div>`
    )}
    <div class="tip" style="margin-top:6px">巷道是把一个街区切成小地块时留下的缝：一级巷（沿街方向的分界）能进车，铺沥青带虚线；二级巷（前后排之间）是后巷，铺混凝土不带标线。</div>
    `
  );

  // ---- 禁建区：工具 + 四类开关 + 环路 / 避障参数
  const zone = details(
    '禁建区',
    `
    <div class="row"><label>工具</label>
      <div class="seg" id="seg-mode">
        <button data-mode="select" class="active">选择</button>
        <button data-mode="rect">矩形</button>
        <button data-mode="circle">圆</button>
        <button data-mode="poly">多边形</button>
      </div>
    </div>
    <div class="zone-list" id="zone-list"></div>
    <div class="grp-label">区域内处理</div>
    <div class="row"><label class="check"><input type="checkbox" id="chk-zone-pad" ${state.params.block.zonePad ? 'checked' : ''}/>只铺硬地，不排建筑</label></div>
    <div class="row"><label class="check"><input type="checkbox" id="chk-loop" ${state.params.block.serviceLoop ? 'checked' : ''}/>区内服务环路</label></div>
    ${specRows('loop')}
    ${advBox(['loop'], '环路尺寸')}
    <div class="grp-label">周边路网避让</div>
    <div class="row"><label class="check"><input type="checkbox" id="chk-zone-avoid" ${state.params.block.zoneAvoid ? 'checked' : ''}/>路网避让禁建区</label></div>
    <div class="row"><label class="check"><input type="checkbox" id="chk-zone-bend" ${state.params.block.zoneAvoidBend ? 'checked' : ''}/>弧线绕障（实验）</label></div>
    ${specRows('avoid')}
    ${advBox(['avoid'], '避障让距')}
    <div class="tip" style="margin-top:8px">禁建区是一个封闭地块：整块轮廓切出来单独成块，区内不排建筑、不做用途分档，但照常有地坪、内部路与绿化。「避让让距」指的是马路牙子离禁建区边界至少留多少米 —— 默认直着让开，勾「弧线绕障」才用势流圆弧绕过去。</div>
    `
  );

  // ---- 方向控制（只在张量场下有意义）
  const guide =
    state.layout === 'tensor'
      ? details(
          '方向控制',
          `
    <div class="row"><label>工具</label>
      <div class="seg" id="seg-guide">
        <button data-mode="select" class="active">选择</button>
        <button data-mode="guide">画方向线</button>
      </div>
    </div>
    <div class="row"><label>强度</label>
      <input type="range" id="rng-gstrength" min="0.1" max="1" step="0.05" value="${state.guideStrength}" class="grow"/>
      <span class="val" id="val-gstrength">${state.guideStrength.toFixed(2)}</span>
    </div>
    <div class="zone-list" id="guide-list"></div>
    <div class="tip" style="margin-top:8px">沿"希望街道顺着走"的方向点几个点，双击结束。线两侧约 3 个街区宽的带内，街道会转向这条线；越远越回到全局方向。</div>
    `
        )
      : details(
          '方向控制',
          `<div class="tip">方向线只在「张量场」布局下参与切块，当前是「${LAYOUT_LABEL[state.layout]}」。</div>
           <div class="row" style="margin-top:8px"><button class="ghost grow" id="btn-to-tensor">切到张量场</button></div>`
        );

  // ---- 地块：切成什么形状
  const parcel = details(
    '地块切分',
    `
    <div class="row"><label class="check"><input type="checkbox" id="chk-parcel" ${state.params.block.parcelize ? 'checked' : ''}/>街区切成小地块</label></div>
    ${specRows('parcel')}
    ${advBox(['parcel'])}
    ${parcelPatternGroup()}
    <div class="tip" style="margin-top:6px">
      <b>开</b>：街区先按<b>沿街面宽</b>切成一排临街地块（面宽 26 m 时，74 m 见方的街区
      每边 3 块），进深超过 40 m 再横切一刀分出前排 / 后排 →
      每块地单独排楼（住宅院内还会排成 2 栋前后串联的板楼）→
      一级缝铺<b>沥青巷 + 中心虚线</b>（能进车），二级缝铺<b>混凝土后巷</b>（不带标线）。
      <br/><b>关</b>：整块地按用途排<b>一组体量</b>（塔楼 + 裙房，或一栋大楼），
      绿地只剩沿路一条收边，楼数掉到 1/3 左右。
      <br/><b>两个参数各管一件事</b>：「沿街面宽」= 沿街切几块；「街区尺度系数」= 街区本身多大。
    </div>
    `
  );

  // ---- 建筑形态
  const building = details(
    '建筑形态',
    `
    <div class="row"><label>高度档位</label>
      <div class="seg" id="seg-bpreset">
        ${BUILDING_PRESETS.map(
          (b) =>
            `<button data-bp="${b.key}" title="${b.desc}" class="${b.key === state.buildingPreset ? 'active' : ''}">${b.label}</button>`
        ).join('')}
      </div>
    </div>
    ${specRows('building')}
    ${advBox(['building'], '塔楼 / 裙房 / 退线')}
    <div class="tip" style="margin-top:6px">
      先选<b>高度档位</b>：低层 / 多层 / 中高层 / 高层，一档把这十来个数一起调好
      （低层 ≈ 1~3 层，高层 ≈ 16 层以上且中心成簇）。
      选「混合」不动任何值 —— 从别的档切回来不会丢掉手调过的数。
      下面两根是<b>楼栋怎么排</b>：间距是同一块地里两栋楼之间的距离，上限是一块地最多排几栋。
      手拖过任何一根塔楼 / 裙房滑杆后，档位按钮会松开（面板不假装还是那一档）。
    </div>
    <div class="row" style="margin-top:8px"><button class="ghost grow" id="btn-param-reset">恢复默认参数</button></div>
    `
  );

  // ---- 显示与导出
  const io = details(
    '视图与导出',
    `
    <div class="row"><label>楼高</label>
      <input type="range" id="rng-height" min="0.5" max="3" step="0.1" value="${state.heightScale}" class="grow"/>
      <span class="val" id="val-height">${state.heightScale.toFixed(1)}×</span>
    </div>
    <div class="row" style="margin-top:10px"><button class="ghost grow" id="btn-export2">导出 GLB（按当前显隐）</button></div>
    <div class="row" style="margin-top:6px"><button class="ghost grow" id="btn-share">复制场景链接</button></div>
    <div class="tip" style="margin-top:8px">导出按层分组：ground / road/{路面,人行道,路口,标线} / lot/&lt;用途&gt; / street。看不见的图层不会进 GLB。</div>
    <div class="tip" style="margin-top:8px">「复制场景链接」把当前这一整座城编进地址栏，对方打开看到的就是同一座城。</div>
    `
  );

  $('#rightbar').innerHTML = sel + city + road + guide + zone + parcel + building + io;

  bindRight();
  renderZoneList();
  renderGuideList();
  if (sel) bindPatchPanel();
}

function renderZoneList(): void {
  const list = $('#zone-list');
  if (!list) return;
  if (state.zones.length === 0) {
    list.innerHTML = `<div class="empty">还没有禁建区。选矩形 / 圆 / 多边形后在图上拖拽或点击绘制。</div>`;
    return;
  }
  list.innerHTML = state.zones
    .map(
      (z, i) => `
      <div class="zone-item ${z.enabled ? 'on' : ''}" data-i="${i}">
        <input type="checkbox" class="chk-zone" data-i="${i}" ${z.enabled ? 'checked' : ''}/>
        <span class="swatch"></span>
        <span class="name">${z.label}</span>
        <button class="icon-btn del-zone" data-i="${i}" title="删除">✕</button>
      </div>`
    )
    .join('');

  list.querySelectorAll<HTMLInputElement>('.chk-zone').forEach((el) => {
    el.addEventListener('change', () => {
      const i = Number(el.dataset.i);
      updateZones(state.zones.map((z, k) => (k === i ? { ...z, enabled: el.checked } : z)));
    });
  });
  list.querySelectorAll<HTMLButtonElement>('.del-zone').forEach((el) => {
    el.addEventListener('click', () => {
      const i = Number(el.dataset.i);
      updateZones(state.zones.filter((_, k) => k !== i));
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
      (g, i) => `
      <div class="zone-item guide-item ${g.enabled ? 'on' : ''}" data-i="${i}">
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
      updateGuides(state.guides.map((g, k) => (k === i ? { ...g, enabled: el.checked } : g)));
    });
  });
  list.querySelectorAll<HTMLButtonElement>('.del-guide').forEach((el) => {
    el.addEventListener('click', () => {
      const i = Number(el.dataset.i);
      updateGuides(state.guides.filter((_, k) => k !== i));
    });
  });
}

/**
 * 改 `block` 里的若干参数。
 *
 * 必须把整份 `state.params` 递进去：`resolveParams({ block })` 会拿**默认值**
 * 补齐缺失的 building / green 两节。只传 block 就等于"顺手把建筑参数和绿地参数
 * 重置回默认" —— 用户调完塔楼比例，再点一下「区内服务环路」就白调了。
 */
function setBlockParam(patch: Partial<TownParams['block']>): void {
  state.params = resolveParams({ ...state.params, block: { ...state.params.block, ...patch } });
}

/**
 * 「切分模式比重」的交互。
 *
 * 拖滑杆时**不重生成**：只更新百分比文字和堆叠条，松手（change）才 regenerate。
 * 全城重生成 ~0.9 s，挂在 input 上会变成"拖一格卡一次"，滑杆根本拖不动 ——
 * 这与其它参数滑杆的处理口径一致。
 */
function bindParcelPatterns(): void {
  const root = document.getElementById('pat-group');
  if (!root) return;

  /** 重画百分比文字 + 堆叠条（值变了但城市还没重算时也要跟上） */
  const paint = () => {
    const pct = patternPercents(state.params.block.parcelPatterns);
    for (const m of PARCEL_PATTERN_META) {
      const v = document.getElementById(`val-pat-${m.key}`);
      if (v) v.textContent = `${pct[m.key]}%`;
      const seg = root.querySelector<HTMLElement>(`[data-seg="${m.key}"]`);
      if (seg) {
        seg.style.width = `${pct[m.key]}%`;
        seg.classList.toggle('zero', pct[m.key] === 0);
        seg.title = `${m.label} ${pct[m.key]}%`;
      }
    }
  };

  root.querySelectorAll<HTMLInputElement>('input[data-pattern]').forEach((el) => {
    el.addEventListener('input', () => {
      const k = el.dataset.pattern as ParcelPattern;
      const w = { ...state.params.block.parcelPatterns, [k]: Number(el.value) };
      state.params = resolveParams({ ...state.params, block: { ...state.params.block, parcelPatterns: w } });
      paint();
    });
    el.addEventListener('change', () => {
      paint();
      regenerate();
    });
  });

  // 均分 / 默认：一次改五个值，滑杆位置也得跟着回去，所以整栏重画
  const setAll = (w: Record<ParcelPattern, number>, msg: string) => {
    state.params = resolveParams({ ...state.params, block: { ...state.params.block, parcelPatterns: { ...w } } });
    buildRight();
    regenerate();
    toast(msg);
  };
  document.getElementById('btn-pat-even')?.addEventListener('click', () => {
    setAll({ ortho: 0.25, diag: 0.25, free: 0.25, field: 0.25 }, '切分模式已均分');
  });
  document.getElementById('btn-pat-reset')?.addEventListener('click', () => {
    setAll({ ...DEFAULT_PARCEL_PATTERNS }, '切分模式已恢复默认配比');
  });
}

function bindRight(): void {
  const bar = $('#rightbar');

  // ---- 规模：预设 + 滑杆
  $('#seg-size')
    .querySelectorAll<HTMLButtonElement>('button')
    .forEach((btn) => {
      btn.addEventListener('click', () => {
        setSize(Number(btn.dataset.n));
      });
    });

  const sizeRng = document.querySelector<HTMLInputElement>('#rng-size');
  const sizeVal = document.getElementById('val-size');
  sizeRng?.addEventListener('input', () => {
    if (sizeVal) sizeVal.textContent = sizeRng.value;
  });
  sizeRng?.addEventListener('change', () => {
    setSize(Number(sizeRng.value));
  });

  // ---- 布局
  const segLayout = document.querySelector<HTMLElement>('#seg-layout');
  if (segLayout) {
    segLayout.querySelectorAll<HTMLButtonElement>('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const k = btn.dataset.layout as LayoutKind;
        if (state.layout === k) return;
        state.layout = k;
        regenerate();
        buildRight();
      });
    });
  }

  // ---- 内部路网形态
  const segInner = document.querySelector<HTMLElement>('#seg-inner');
  if (segInner) {
    segInner.querySelectorAll<HTMLButtonElement>('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const k = btn.dataset.inner as 'tensor' | 'path';
        if (state.params.block.internalRoads === k) return;
        setBlockParam({ internalRoads: k });
        segInner.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
        regenerate();
      });
    });
  }

  // ---- 建筑高度档位
  //
  // 一档 = 一组高度参数。选「混合」时 `apply` 是 undefined，一个值都不动 ——
  // 这是"从低层切回混合"不丢手调值的唯一办法。
  const segBp = document.querySelector<HTMLElement>('#seg-bpreset');
  if (segBp) {
    segBp.querySelectorAll<HTMLButtonElement>('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const k = btn.dataset.bp as string;
        const preset = BUILDING_PRESETS.find((b) => b.key === k);
        if (!preset || !preset.apply) return;
        state.buildingPreset = k;
        const next = JSON.parse(JSON.stringify(state.params)) as TownParams;
        Object.assign(next.building, preset.apply);
        state.params = resolveParams(next);
        buildRight();
        regenerate();
      });
    });
  }

  // ---- 布尔开关
  const bool = (id: string, apply: (on: boolean) => void) => {
    const el = document.querySelector<HTMLInputElement>(id);
    el?.addEventListener('change', (e) => {
      apply((e.target as HTMLInputElement).checked);
      regenerate();
    });
  };
  bool('#chk-plaza', (on) => {
    state.plaza = on;
  });
  bool('#chk-parcel', (on) => {
    setBlockParam({ parcelize: on });
    // 比重那组只在切分开启时对普通街区起作用，压暗状态要跟着开关走
    document.getElementById('pat-group')?.classList.toggle('off', !on);
  });
  bool('#chk-zone-pad', (on) => {
    setBlockParam({ zonePad: on });
  });
  bool('#chk-zone-avoid', (on) => {
    setBlockParam({ zoneAvoid: on });
  });
  bool('#chk-zone-bend', (on) => {
    setBlockParam({ zoneAvoidBend: on });
  });
  bool('#chk-loop', (on) => {
    setBlockParam({ serviceLoop: on });
  });

  // ---- 参数滑杆
  /** 档位预设覆盖到的字段：拖了其中任何一根，档位就不再是那一档了 */
  const PRESET_KEYS = new Set<string>();
  for (const b of BUILDING_PRESETS) for (const k of Object.keys(b.apply ?? {})) PRESET_KEYS.add(k);

  const applyParam = (el: HTMLInputElement) => {
    const g = el.dataset.pgroup as 'block' | 'building';
    const k = el.dataset.pkey as string;
    const v = Number(el.value);
    const next = JSON.parse(JSON.stringify(state.params)) as TownParams;
    (next[g] as unknown as Record<string, number>)[k] = v;
    state.params = resolveParams(next);
    const val = document.getElementById(`val-${el.id.replace(/^rng-/, '')}`);
    if (val) {
      const sp = (g === 'block' ? BLOCK_SPECS : BUILDING_SPECS).find((x) => x.key === k);
      const shown = (state.params[g] as unknown as Record<string, number>)[k];
      val.textContent = `${shown}${sp?.unit ?? ''}`;
    }
    // 拖到档位管的那几个数 → 档位按钮全部松开，不假装还是"低层"
    if (PRESET_KEYS.has(k) && state.buildingPreset !== 'custom') {
      state.buildingPreset = 'custom';
      document.querySelectorAll<HTMLButtonElement>('#seg-bpreset button').forEach((b) => {
        b.classList.toggle('active', b.dataset.bp === state.buildingPreset);
      });
    }
  };
  bar.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement;
    if (el.dataset.pgroup) applyParam(el);
  });
  bar.addEventListener('change', (e) => {
    const el = e.target as HTMLInputElement;
    if (el.dataset.pgroup) {
      applyParam(el);
      regenerate();
    }
  });
  // 参数可能被钳制，重生成后把滑杆值同步回真实值
  bar.addEventListener('pointerup', () => {
    for (const g of ['block', 'building'] as const) {
      const specs = g === 'block' ? BLOCK_SPECS : BUILDING_SPECS;
      for (const sp of specs) {
        const el = document.querySelector<HTMLInputElement>(`#rng-p-${g}-${sp.key}`);
        if (!el) continue;
        const v = (state.params[g] as unknown as Record<string, number>)[sp.key];
        if (Math.abs(Number(el.value) - v) > 1e-9) el.value = String(v);
      }
    }
  });
  document.querySelector<HTMLButtonElement>('#btn-param-reset')?.addEventListener('click', () => {
    state.params = defaultParams();
    buildRight();
    regenerate();
  });

  bindParcelPatterns();

  // ---- 种子
  const seedInput = $<HTMLInputElement>('#inp-seed');
  seedInput.addEventListener('change', () => {
    const v = Math.abs(parseInt(seedInput.value, 10) || 1) % 2147483647;
    state.seed = v || 1;
    seedInput.value = String(state.seed);
    regenerate();
  });
  $('#btn-dice').addEventListener('click', () => {
    state.seed = Math.floor(Math.random() * 2_000_000_000) + 1;
    seedInput.value = String(state.seed);
    regenerate();
  });

  $('#btn-regen').addEventListener('click', regenerate);

  // ---- 禁建区 / 方向线工具
  bindModeSeg('#seg-mode');
  bindModeSeg('#seg-guide');

  const gstr = document.querySelector<HTMLInputElement>('#rng-gstrength');
  if (gstr) {
    gstr.addEventListener('input', () => {
      state.guideStrength = Number(gstr.value);
      const val = document.getElementById('val-gstrength');
      if (val) val.textContent = state.guideStrength.toFixed(2);
      view2d.guideStrength = state.guideStrength;
    });
    gstr.addEventListener('change', () => {
      if (state.guides.length === 0) return;
      updateGuides(state.guides.map((g) => ({ ...g, strength: state.guideStrength })));
    });
  }

  const toTensor = document.querySelector<HTMLButtonElement>('#btn-to-tensor');
  if (toTensor) {
    toTensor.addEventListener('click', () => {
      state.layout = 'tensor';
      regenerate();
      buildRight();
      toast('已切到张量场布局，可以画方向线了');
    });
  }

  // ---- 路宽
  const bindWidth = (id: string, valId: string, key: keyof TownStyle) => {
    const input = $<HTMLInputElement>(id);
    input.addEventListener('input', () => {
      $(valId).textContent = Number(input.value).toFixed(1);
    });
    input.addEventListener('change', () => {
      state.style[key] = Number(input.value);
      model.style[key] = Number(input.value);
      model.rebuild();
      view2d.draw();
      updateStats();
      refreshDiag();
      if (currentView === '3d') refresh3D();
    });
  };
  bindWidth('#rng-main', '#val-main', 'mainStreetWidth');
  bindWidth('#rng-regular', '#val-regular', 'regularStreetWidth');
  bindWidth('#rng-alley', '#val-alley', 'alleyWidth');

  // ---- 选中路单独调宽
  const artery = $<HTMLInputElement>('#rng-artery');
  const arteryVal = document.getElementById('val-artery');
  artery.addEventListener('input', () => {
    if (arteryVal) arteryVal.textContent = formatWidth(Number(artery.value));
  });
  const commitArtery = (w: number | null) => {
    const road = currentRoad;
    if (!road) return;
    model.setEdgeWidth(road.a, road.b, w);
    model.rebuild();
    view2d.invalidate();
    view2d.refreshRoadSelection();
    view2d.draw();
    updateStats();
    refreshDiag();
    if (currentView === '3d') refresh3D();
  };
  artery.addEventListener('change', () => commitArtery(Number(artery.value)));
  document.querySelector<HTMLButtonElement>('#btn-artery-reset')?.addEventListener('click', () => commitArtery(null));

  // ---- 楼高
  const height = $<HTMLInputElement>('#rng-height');
  height.addEventListener('input', () => {
    state.heightScale = Number(height.value);
    $('#val-height').textContent = `${state.heightScale.toFixed(1)}×`;
  });
  height.addEventListener('change', () => {
    if (currentView === '3d') refresh3D();
  });

  // ---- 导出 / 分享
  $('#btn-export2').addEventListener('click', doExport);
  document.querySelector<HTMLButtonElement>('#btn-share')?.addEventListener('click', () => {
    const url = sceneUrl();
    try {
      history.replaceState(null, '', url);
    } catch {
      /* ignore */
    }
    const done = () => toast(`场景链接已复制（${url.length} 字符）`);
    const fail = () => toast(url, false);
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(done, fail);
    else fail();
  });

  syncRoadRow(currentRoad);
}

/** 改规模：预设与滑杆共用 */
function setSize(n: number): void {
  const v = Math.max(SIZE_MIN, Math.min(SIZE_MAX, Math.round(n)));
  if (v === state.nPatches) return;
  state.nPatches = v;
  const rng = document.querySelector<HTMLInputElement>('#rng-size');
  if (rng) rng.value = String(v);
  const val = document.getElementById('val-size');
  if (val) val.textContent = String(v);
  document.querySelectorAll<HTMLButtonElement>('#seg-size button').forEach((b) => {
    b.classList.toggle('active', Number(b.dataset.n) === v);
  });
  regenerate();
  toast(`规模 ${v} 街区`);
}

function setHint(mode: DrawMode): void {
  const hints: Record<DrawMode, string> = {
    select: '点选禁绘区 / 方向线后用浮动工具条移动·旋转·缩放·改形状 · 滚轮缩放 · 右键平移',
    rect: '按住左键拖出矩形禁区 · Esc 取消',
    circle: '按住左键，从圆心拖出半径 · Esc 取消',
    poly: '依次点击顶点，双击闭合 · Esc 取消',
    guide: '沿想控制的走向依次点击，双击结束 · 方向线只影响线两侧一条带',
  };
  $('#hint').textContent = hints[mode];
}

function setDrawMode(mode: DrawMode): void {
  view2d.setMode(mode);
}

function syncModeButtons(mode: DrawMode): void {
  document.querySelectorAll<HTMLButtonElement>('#seg-mode button, #seg-guide button').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
  setHint(mode);
}

function bindModeSeg(sel: string): void {
  const seg = document.querySelector<HTMLElement>(sel);
  if (!seg) return;
  seg.querySelectorAll<HTMLButtonElement>('button').forEach((btn) => {
    btn.addEventListener('click', () => setDrawMode(btn.dataset.mode as DrawMode));
  });
}

// ---------------------------------------------------------------- 导出

function doExport(): void {
  try {
    const prims = buildTownMeshes(model, {
      heightScale: state.heightScale,
      layers: makeFilter(state.vis),
      // 导出所见即所得：当前是哪个规划模式就导出哪个
      planningMode: state.planningMode,
    });
    const glb = exportGLB(prims, 'TownForge');
    const blob = new Blob([glb.bytes as unknown as BlobPart], { type: 'model/gltf-binary' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `town_${state.nPatches}_${state.seed}_${state.planningMode}.glb`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast(`已导出 ${(glb.bytes.byteLength / 1024 / 1024).toFixed(2)} MB · ${glb.triangles} 三角形 · ${glb.meshes} 网格`);
  } catch (e) {
    toast(`导出失败：${(e as Error).message}`, true);
  }
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
  }, 2600);
}

// ---------------------------------------------------------------- 视图切换

function switchView(view: '2d' | '3d'): void {
  currentView = view;
  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((b) => b.classList.toggle('active', b.dataset.view === view));

  const canvas = $('#canvas2d');
  const mount = $('#view3d');

  if (view === '3d') {
    canvas.style.display = 'none';
    mount.classList.add('on');
    view2d.setActive(false);
    if (!view3d) view3d = new View3D(mount);
    refresh3D();
    // 平面里**选中过一块地**再切过来 → 镜头聚焦到那块地；
    // 没选中（或选中的还是上一次已经聚焦过的）就完全不动相机 ——
    // 来回切页签不该把用户转好的视角重置掉。
    if (selectedPatchKey && selectedPatchKey !== focusedPatchKey) {
      const p = findPatchByKey(selectedPatchKey);
      if (p) {
        const ctr = patchCenter(p);
        view3d.focusOn(ctr.x, ctr.y);
        focusedPatchKey = selectedPatchKey;
      }
    }
  } else {
    mount.classList.remove('on');
    canvas.style.display = 'block';
    view2d.setActive(true);
    view2d.draw();
  }
}

// ---------------------------------------------------------------- 场景快照

const LS_KEY = 'townforge.scene.v1';
/** 图层显隐的偏好单独存：它跟"是哪座城"无关，换城池也不该重置 */
const LS_LAYERS = 'townforge.layers.v1';

function hashSnapshot(): string | null {
  const h = location.hash.replace(/^#/, '');
  return h.startsWith('s=') ? h.slice(2) : null;
}

function sceneUrl(): string {
  return `${location.origin}${location.pathname}#s=${encodeSnapshot(state)}`;
}

let hashSyncTimer = 0;
function syncHashSoon(): void {
  window.clearTimeout(hashSyncTimer);
  hashSyncTimer = window.setTimeout(() => {
    const code = encodeSnapshot(state);
    try {
      history.replaceState(null, '', `${location.origin}${location.pathname}#s=${code}`);
    } catch {
      /* file:// 下 replaceState 会抛，忽略 */
    }
    try {
      localStorage.setItem(LS_KEY, code);
    } catch {
      /* 隐私模式 / 配额满，忽略 */
    }
  }, 350);
}

function saveLayers(): void {
  try {
    localStorage.setItem(LS_LAYERS, JSON.stringify(state.vis));
  } catch {
    /* ignore */
  }
}

function loadLayers(): void {
  try {
    const raw = localStorage.getItem(LS_LAYERS);
    if (!raw) return;
    const obj = JSON.parse(raw) as Record<string, boolean>;
    const base = defaultVisibility();
    for (const k of Object.keys(base)) {
      if (typeof obj[k] === 'boolean') state.vis[k] = obj[k];
    }
  } catch {
    /* 旧格式 / 损坏，用默认 */
  }
}

// ---------------------------------------------------------------- 启动

function applyUrlParams(): boolean {
  const snap = hashSnapshot();
  if (snap) {
    const decoded = decodeSnapshot(snap);
    if (decoded && applySnapshot(state, decoded)) return true;
    toast('场景链接解析失败，已退回默认场景', true);
  }
  if (location.search.length > 1) return false;
  try {
    const saved = localStorage.getItem(LS_KEY);
    const decoded = saved ? decodeSnapshot(saved) : null;
    if (decoded && applySnapshot(state, decoded)) return true;
  } catch {
    /* 隐私模式读不到，忽略 */
  }
  return false;
}

function applyQueryParams(): void {
  const p = new URLSearchParams(location.search);
  const num = (k: string) => (p.has(k) ? Number(p.get(k)) : null);

  const n = num('n');
  if (n) state.nPatches = n;
  const seed = num('seed');
  if (seed) state.seed = seed;

  // ?hilite=1 默认打开「内部道路高亮」（截图 / 核对用，和 ?mode 同类）
  if (p.get('hilite') === '1') state.hiliteLotRoad = true;

  // ?cir=existing,new,merged,portals,unreach 打开 R1 诊断覆盖层（截图 / 核对用）
  {
    const raw = p.get('cir');
    if (raw) {
      const map: Record<string, string> = {
        existing: 'ov:cir-existing',
        new: 'ov:cir-new',
        merged: 'ov:cir-merged',
        portals: 'ov:cir-portals',
        unreach: 'ov:cir-unreachable',
      };
      for (const part of raw.split(',')) {
        const id = map[part.trim()];
        if (id) state.vis[id] = true;
      }
    }
  }

  // ?circulation=off|golden|all —— R1.4 开关。默认 all（本地开发全城启用）
  {
    const c = p.get('circulation');
    if (c === 'off' || c === 'golden' || c === 'all') state.circulationMode = c;
  }

  // ?s1=off|golden|all —— S1 场地布局骨架（截图对比用）
  {
    const v = p.get('s1');
    if (v === 'off' || v === 'golden' || v === 'all') state.s1Mode = v;
  }

  // ?pattern=off|golden|all —— Pattern Registry 筛选
  {
    const v = p.get('pattern');
    if (v === 'off' || v === 'golden' || v === 'all') state.patternMode = v;
  }

  // ?parkingProvider=legacy|placemaker|compare —— 停车求解器（placemaker 走离线烘焙表）
  {
    const v = p.get('parkingProvider');
    if (v === 'legacy' || v === 'placemaker' || v === 'compare') state.parkingProvider = v;
  }

  if (p.get('zone') === '1') {
    state.zones = [
      makeZone('demo-rect', '矩形禁区 1', {
        kind: 'rect',
        a: new Pt(-52, -18),
        b: new Pt(-14, 26),
      }),
      makeZone('demo-circle', '圆形禁区 2', { kind: 'circle', c: new Pt(38, 34), r: 22 }),
    ];
  }
  if (p.get('guides') === '1') {
    state.guides = [
      makeGuide('demo-a', '方向线 1', [new Pt(-66, -34), new Pt(-20, 6), new Pt(4, 40)]),
      makeGuide('demo-b', '方向线 2', [new Pt(30, -46), new Pt(58, 6)]),
    ];
  }
  const lay = p.get('layout');
  if (lay === 'grid' || lay === 'field' || lay === 'radial' || lay === 'tensor') state.layout = lay;
  // ?layers=off 一次性关掉所有覆盖层（截图用）
  if (p.get('layers') === 'off') {
    for (const g of OVERLAY_GROUPS) for (const it of g.items) state.vis[it.id] = it.id === 'ov:zones' || it.id === 'ov:guides';
  }
  // ?ov=blocks,redline,... 打开指定覆盖层
  const ov = p.get('ov');
  if (ov) {
    const want = new Set(ov.split(',').map((s) => `ov:${s.trim()}`));
    for (const g of OVERLAY_GROUPS) for (const it of g.items) state.vis[it.id] = want.has(it.id);
  }
}

/**
 * `?scale=base|A|B|C` —— 道路断面 / 街区尺度的对照开关（诊断用，和 `?mode` 同类）。
 *
 * 必须在**第一次 createModel 之前**跑：Model 的路宽默认值就是从 ROAD_SPECS 取的，
 * 晚一步就只能改到"下一次生成"，当前画面还是旧断面。
 */
function applyScaleFromQuery(): void {
  const v = new URLSearchParams(location.search).get('scale');
  if (!isScalePreset(v)) return;
  const cfg = applyScalePreset(v);
  if (cfg.spacingK !== undefined) state.params.block.spacingK = cfg.spacingK;
  state.style = {
    mainStreetWidth: u(ROAD_SPECS.arterial.redLine),
    regularStreetWidth: u(ROAD_SPECS.collector.redLine),
    alleyWidth: u(ROAD_SPECS.local.redLine),
  };
}

function boot(): void {
  loadLayers();
  applyScaleFromQuery();
  // hash 与 query 不是二选一：
  //   `#s=` 是"这是哪座城"（seed / 断面 / 参数），
  //   `?s1= ?pattern= ?parkingProvider= ?patch= ?zoom= ?view=` 是"这次怎么看、开哪个实验开关"。
  // 早先写成 `if (!applyUrlParams()) applyQueryParams()` —— 只要 URL 带 `#s=`，
  // query 全部失效，表现为"我加了 ?parkingProvider=placemaker，页面上一点变化都没有"。
  applyUrlParams();
  applyQueryParams();

  const canvas = $<HTMLCanvasElement>('#canvas2d');

  try {
    model = createModel();
  } catch (e) {
    toast(`初始生成失败：${(e as Error).message}`, true);
    model = createModel();
  }

  // 先算一遍体检：左栏的图层计数要用
  try {
    diag = diagnose(model);
  } catch {
    diag = null;
  }

  buildLeft();
  buildRight();
  setHint('select');

  view2d = new View2D(canvas, model, {
    onRebuild: rebuildGeometry,
    onZonesChanged: updateZones,
    onGuidesChanged: (guides) => updateGuides(guides),
    onSelection: (p) => syncRoadRow(p.road),
    // 点中地块：选中态记在 app 层（key），面板重建后滚回顶部不影响画布
    onPatchSelect: (p) => {
      selectedPatchKey = p ? patchKey(p) : null;
      buildRight();
      if (selectedPatchKey) $('#rightbar').scrollTop = 0;
      updatePlannerHud();
    },
    onStatus: (text) => {
      $('#hint').textContent = text;
    },
    onModeChanged: (mode) => syncModeButtons(mode),
  });
  // 装配参数必须在第一次 draw 之前给：circulation 决定 Planner 跑不跑求解器，
  // 而 2D / 3D / 导出都从同一份 Scene 取数
  view2d.setSceneOptions({
    planningMode: state.planningMode,
    circulation: state.circulationMode,
    s1: state.s1Mode,
    pattern: state.patternMode,
    parkingProvider: state.parkingProvider,
  });
  view2d.setZones(state.zones);
  view2d.setGuides(state.guides);
  view2d.guideStrength = state.guideStrength;
  applyViewFlags();
  updateStats();
  syncHashSoon();

  const q = new URLSearchParams(location.search);
  // ?patch=1 预选一块地（截图 / 手测用）：取城内最大、盖了楼的那块。
  // ?patch=<key> 直接按 patchKey 选，用来复现"我在这一块上遇到的问题"。
  if (q.has('patch')) {
    const want = q.get('patch') ?? '';
    const p = want === '1' ? biggestPatch() : findPatchByKey(want);
    if (p) {
      selectedPatchKey = patchKey(p);
      view2d.setSelectedPatch(p);
      view2d.draw();
      // ?zoom=<px/单位> 把镜头拉到地块尺度（全城视图看不出路面、路缘、树）。
      // 不给就是原来的全城视图，行为不变。
      const zoom = Number(q.get('zoom') ?? 0);
      if (zoom > 0) {
        // ?cx=&cy= 直接给世界坐标中心（地块内部的要素常常不在地块中心，
        // 比如内部道路贴着一条边 —— 验收要看的是路，不是地块重心）
        const hasXY = q.has('cx') && q.has('cy');
        const cx = hasXY ? Number(q.get('cx')) : p.shape.reduce((s, v) => s + v.x, 0) / p.shape.length;
        const cy = hasXY ? Number(q.get('cy')) : p.shape.reduce((s, v) => s + v.y, 0) / p.shape.length;
        lastFocus = { x: cx, y: cy, span: 420 / zoom };
        view2d.focusOn(cx, cy, zoom);
        view2d.draw();
      }
      buildRight();
      $('#rightbar').scrollTop = 0;
    }
  }
  if (q.get('sel') === '1' || q.get('selftest') === '1') {
    const pick: { kind: SelKind; id: string } | null =
      state.zones.length > 0
        ? { kind: 'zone', id: state.zones[0].id }
        : state.guides.length > 0
          ? { kind: 'guide', id: state.guides[0].id }
          : null;
    if (pick) {
      view2d.selectById(pick.kind, pick.id);
      view2d.draw();
    }
  }
  if (q.get('selftest') === '1') {
    void import('./selftest').then((m) =>
      m.runSelfTest({ view: view2d, canvas, zones: () => state.zones, guides: () => state.guides })
    );
  }

  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view as '2d' | '3d'));
  });
  $('#btn-export').addEventListener('click', doExport);

  // ---- R8 · 规划模式
  renderPlannerHud = mountPlannerHud($('#planner-hud'));
  document.querySelectorAll<HTMLButtonElement>('.mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => applyPlanningMode(btn.dataset.mode as PlanningMode));
  });
  // URL 参数 ?mode=planner / ?mode=shadow（自动化截图 / 手测用）
  {
    const m = new URLSearchParams(location.search).get('mode');
    if (m === 'planner' || m === 'shadow' || m === 'legacy') applyPlanningMode(m);
    else updatePlannerHud();
  }
  // URL 参数 ?view=3d / ?view=2d（自动化截图用：不用点 tab 就能进三维）
  {
    const v = new URLSearchParams(location.search).get('view');
    if (v === '3d' || v === '2d') switchView(v);
    // 2D 那边已经 focusOn 到地块了，三维也要跟过去，否则截图还是一片全城
    if (v === '3d' && lastFocus && view3d) {
      view3d.focusOn(lastFocus.x, lastFocus.y, lastFocus.span);
    }
  }

  document.addEventListener('keydown', (e) => {
    const tag = (document.activeElement?.tagName ?? '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (e.key === 'Escape') {
      setDrawMode('select');
      // Esc 顺带取消地块选中：面板跟着消失，画布高亮一起收
      if (selectedPatchKey) {
        selectedPatchKey = null;
        view2d.setSelectedPatch(null);
        view2d.draw();
        buildRight();
      }
    }
    if (e.key === 'v') {
      const cb = document.querySelector<HTMLInputElement>('input[data-layer="ov:vertices"]');
      if (cb) {
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event('change'));
      }
    }
    if (e.key === 'j') {
      const cb = document.querySelector<HTMLInputElement>('input[data-layer="ov:junctions"]');
      if (cb) {
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event('change'));
      }
    }
  });

  // ?focusxy=<x>,<y>&zoom=<n>：按世界坐标聚焦（看路口 / 任意位置）
  //
  // 2D 和 3D 是两套相机，都要喂。早先只调了 view2d，于是 ?view=3d&focusxy=…
  // 打开还是全城 —— 3D 特写根本没法截。
  {
    const fx = q.get('focusxy');
    if (fx) {
      const [x, y] = fx.split(',').map(Number);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        view2d.focusOn(x, y, Number(q.get('zoom') ?? 40));
      }
    }
  }
  // ?focus=<patchKey>：把镜头拉到那块地（R8 前端验收要看地块尺度）
  {
    const fk = q.get('focus');
    if (fk) {
      const p = findPatchByKey(fk);
      if (p) {
        const c = patchCenter(p);
        view2d.focusOn(c.x, c.y, Number(q.get('zoom') ?? 26));
        selectedPatchKey = fk;
        view2d.setSelectedPatch(p);
        buildRight();
      }
    }
  }

  if (q.get('view') === '3d') switchView('3d');

  // 3D 的聚焦必须排在 switchView 之后 —— view3d 是那里面才创建的，
  // 提前调等于喂给一个还不存在的相机。
  // span 是"取景半径（世界单位）"，2D 的 zoom 是像素/单位，两者语义不同。
  {
    const fx = q.get('focusxy');
    if (fx && q.get('view') === '3d' && view3d) {
      const [x, y] = fx.split(',').map(Number);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        view3d.focusOn(x, y, Number(q.get('span') ?? 1.4));
      }
    }
  }

  toast('左栏控制显隐与指标，右栏调生成参数');
}

boot();
