// 2D 平面编辑器：渲染 + 交互（缩放/平移、拖拽拓扑点、拾取道路、绘制禁建区）

import { Pt, distToSegment } from '../core/geom';
import { Rng } from '../core/rng';
import type { Model } from '../town/model';
import type { Patch } from '../town/patch';
import { Zone, makeZone, zoneToPolygon, pointInPolygon, area as polyArea } from '../town/zones';
import { FieldGuide, makeGuide, guideIsUsable } from '../town/guide';
import { roadBand } from '../render/road';
import { buildRoadNet, type RoadEdge, type RoadNet } from '../road/system';
import { edgeKey } from '../town/edgeclass';
import { buildScene } from '../scene/build';
import type { PlannerBundle, PlanningMode } from '../scene/planner-bridge';
import type { Scene } from '../scene/types';
import { USE_COLOR, css, treeGreenCss } from '../scene/palette';
import {
  hiliteMatOf,
  isInternalRoadLayer,
  layerOfPath,
  layerOfProp,
  layerOfSolid,
  layerOfSurface,
  type LayerId,
} from '../scene/layers';
import { USE_LABEL } from '../town/landuse';
import type { LandUse } from '../scene/types';
import {
  type PointMap,
  centerOf,
  mapGuide,
  mapZone,
  rotateMap,
  scaleMap,
  setGuideVertex,
  setZoneVertex,
  translateMap,
} from './zoneedit';

const PAPER = '#ccc5b8';
const LIGHT = '#99948a';
const MEDIUM = '#67635c';
const DARK = '#1a1917';
const DANGER = '#c4553f';
const LAMP = '#5c6066';
/** 方向控制线用蓝紫，和禁建区红拉开；纸色 #ccc5b8 上对比够 */
const GUIDE = '#3f6bb0';
const GUIDE_SOFT = 'rgba(63,107,176,0.07)';
/** 选中态与把手用主题橙，和禁区红、方向线蓝都能区分 */
const ACCENT = '#d98c4a';

const STROKE = 0.3;

export type DrawMode = 'select' | 'rect' | 'circle' | 'poly' | 'guide';

/** 浮动工具条的三种编辑工具（第四种"改形状"直接拖把手，见 pickSelHandle） */
export type EditTool = 'move' | 'rotate' | 'scale' | 'shape';

export type SelKind = 'zone' | 'guide';

export interface ObjSel {
  kind: SelKind;
  id: string;
}

/** 选中的那条路：侧栏"选中路"滑杆需要的一切 */
export interface RoadPick {
  /** 边的坐标键，写回模型时用 */
  key: string;
  a: Pt;
  b: Pt;
  cls: string;
  /** 当前红线宽（世界单位） */
  width: number;
  min: number;
  max: number;
  /** 是否被单独调过 */
  custom: boolean;
}

interface ObjDrag {
  kind: SelKind;
  id: string;
  tool: EditTool;
  /** 按下时的世界坐标 */
  start: Pt;
  /** 旋转 / 缩放的支点（对象中心） */
  pivot: Pt;
  startAng: number;
  startDist: number;
  /** 拖拽开始时的对象快照：每一帧都从它重新变换，避免误差累积 */
  zone: Zone | null;
  guide: FieldGuide | null;
  /** "改形状"抓到的把手序号 */
  index: number | null;
  dirty: boolean;
}

interface Cam {
  x: number;
  y: number;
  scale: number;
}

/** 去掉相邻重复点（多段线双击收尾时最后两下会落在一处） */
function dedupePoints(pts: Pt[], eps = 1e-3): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(last.x - p.x, last.y - p.y) > eps) out.push(p);
  }
  return out;
}

export interface View2DCallbacks {
  onRebuild: () => void;
  onZonesChanged: (zones: Zone[]) => void;
  onGuidesChanged: (guides: FieldGuide[]) => void;
  onSelection: (payload: { artery: number | null; vertex: Pt | null; road: RoadPick | null }) => void;
  onStatus: (text: string) => void;
  /** 绘制模式被内部改掉时通知（画完一条线会自动回到"选择"），用来同步侧栏按钮高亮 */
  onModeChanged?: (mode: DrawMode) => void;
  /** 选中 / 取消选中一块地块（点街区内空白处） */
  onPatchSelect?: (p: Patch | null) => void;
}

export class View2D {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private model: Model;
  private cb: View2DCallbacks;

  private cam: Cam = { x: 0, y: 0, scale: 4 };
  private dpr = 1;

  zones: Zone[] = [];
  guides: FieldGuide[] = [];
  mode: DrawMode = 'select';

  showZones = true;
  showGuides = true;
  showVertices = false;
  showBlocks = false;
  /** 用地红线（道路红线两侧边线） */
  showRedline = false;
  /** 道路中线（按等级着色） */
  showCenterline = false;
  /** 路口点：度≥3 画圆点，度=1（断头）画红叉 */
  showJunctions = false;
  /** 用地类型着色（按 LandUse 铺半透明色 + 标注） */
  showUse = false;

  // ---- R1.4 内部交通诊断（只给开发核对用，默认全关）
  /** 既有可通行道路（被并进网络的场地铺装） */
  showCirExisting = false;
  /** A* 新增连接（按交通类型着色） */
  showCirNew = false;
  /** 合并后的完整 PathGraph */
  showCirMerged = false;
  /** 入口与街区出口（按类型着色） */
  showCirPortals = false;
  /** 接不上的需求点（红叉 + 原因） */
  showCirUnreachable = false;

  /**
   * 图层显隐过滤（scene/layers.ts 的 id）。
   * 场景本身永远是**全量生成**的，看不见的要素在绘制时跳过 ——
   * 这样任何要素都必然受控，不会出现"关掉行道树，地块里的树还在"。
   */
  private layerVis: (id: LayerId) => boolean = () => true;

  /** 换显隐后调用：场景要重建（三维与导出共用同一份过滤） */
  setLayerVisibility(fn: (id: LayerId) => boolean): void {
    this.layerVis = fn;
    this.scene = null;
    this.requestDraw();
  }

  private vis(id: LayerId): boolean {
    return this.layerVis(id);
  }

  /** 新画方向线的默认强度，侧栏滑杆改这里 */
  guideStrength = 0.8;

  private hoverVertex: Pt | null = null;
  private dragVertex: Pt | null = null;
  private dragOrigin: Pt | null = null;
  private panning = false;
  private panStart = { x: 0, y: 0, cx: 0, cy: 0 };

  selectedArtery: number | null = null;
  /** 选中路的坐标键：重建后边的顺序可能变，靠它把选中态找回来 */
  private selectedKey: string | null = null;
  /** 道路网缓存（拾取与高亮都要用），随模型 revision 失效 */
  private net: RoadNet | null = null;
  private netRev = -1;

  /** 当前选中的禁绘区 / 方向线（浮动工具条跟着它走） */
  private sel: ObjSel | null = null;
  /** 当前的编辑工具 */
  tool: EditTool = 'move';
  private objDrag: ObjDrag | null = null;
  private toolbar: HTMLDivElement | null = null;
  private toolbarFor: string | null = null;
  /** 2D 视图是否处于激活状态（切到三维时把浮动条收起来） */
  private active = true;

  // 绘制中的临时形状
  private draft: { kind: DrawMode; points: Pt[]; cursor: Pt | null } | null = null;

  private needsDraw = false;
  private rafHandle = 0;

  /** 与 3D 共用的场景快照；模型 revision 变了才重建 */
  private scene: Scene | null = null;
  /**
   * 外部直接给的场景（F3 城市合成器）。
   *
   * 有它的时候整个 2D 画布只画这一份 Scene：不再读 model.patches 的轮廓 /
   * 用地着色 / 路网调试层，因为那些都是**另一条链路**的东西，混着画就是两层城市。
   */
  private override: Scene | null = null;
  private sceneRev = -1;
  /** 场景开关：标线 / 街道设施 / 规划模式（R8） */
  private sceneOpts: {
    markings?: boolean;
    furniture?: boolean;
    planningMode?: PlanningMode;
    circulation?: 'off' | 'golden' | 'all';
    s1?: 'off' | 'golden' | 'all';
    pattern?: 'off' | 'golden' | 'all';
    parkingProvider?: 'legacy' | 'placemaker' | 'compare';
  } = {};

  /** 高亮内部道路（纯表现层，不改场景数据） */
  hiliteLotRoad = false;

  constructor(canvas: HTMLCanvasElement, model: Model, cb: View2DCallbacks) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    this.model = model;
    this.cb = cb;

    this.resize();
    this.fit();
    window.addEventListener('resize', () => {
      this.resize();
      this.requestDraw();
    });

    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
    canvas.addEventListener('pointerleave', () => {
      this.hoverVertex = null;
      this.requestDraw();
    });
    canvas.addEventListener('dblclick', (e) => this.onDoubleClick(e));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // 浮动工具条：挂在 #stage 上（它已经是 position:relative），
    // 这样按钮的坐标可以直接用"相对画布左上角"的屏幕坐标定位。
    this.toolbar = document.createElement('div');
    this.toolbar.className = 'float-bar';
    this.toolbar.style.display = 'none';
    (canvas.parentElement ?? document.body).appendChild(this.toolbar);

    // Delete / Backspace 删除选中对象。输入框里打字时不能抢键。
    window.addEventListener('keydown', (e) => {
      const tag = (document.activeElement?.tagName ?? '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (!this.sel || this.mode !== 'select') return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        this.deleteSel();
      }
    });
  }

  /**
   * 换模型。默认重新 fit，但 regenerate 传 keepView 时会保住当前视角 ——
   * 画一条方向线就整城重生，如果每次都跳回全图视野，用户没法接着微调。
   * 城市尺寸变化超过 20% 时仍然重排，否则从大城切到小镇会只剩一小块。
   */
  setModel(model: Model, opts: { keepView?: boolean } = {}): void {
    const prevR = this.model?.cityRadius ?? 0;
    this.model = model;
    this.scene = null;
    this.override = null;
    this.selectedArtery = null;
    this.hoverVertex = null;
    const sameScale = prevR > 0 && Math.abs(model.cityRadius - prevR) / prevR < 0.2;
    if (opts.keepView && sameScale) this.requestDraw();
    else this.fit();
  }

  /** 模型重建后调用，下次绘制会重新组装场景 */
  invalidate(): void {
    this.scene = null;
  }

  /**
   * 换成外部场景（F3）。传 null 回到"从 model 现算"。
   *
   * 这里不清 `model`：切回 legacy 时还要用；但视口保持不动，
   * 因为 F3 的城市半径和 legacy 是同一档，用户不用重新对位。
   */
  setSceneOverride(scene: Scene | null): void {
    this.override = scene;
    this.scene = null;
    this.requestDraw();
  }

  get hasOverride(): boolean {
    return this.override !== null;
  }

  /**
   * 最近一次绘制时用到的 Planner 报告（R8 Debug HUD）。
   * draw() 是同步的，所以 draw() 之后立刻读得到。
   */
  get plannerBundle(): PlannerBundle | null {
    return this.scene?.planner ?? null;
  }

  /**
   * 场景快照（模型变了就重建）。
   *
   * 抽出来是为了让"读场景"和"画场景"走同一条路 ——
   * 右栏的建筑数要显示 Planner 模式下的真实值，就必须能**先**拿到场景，
   * 而不是等下一次绘制。
   */
  ensureScene(): Scene {
    if (this.override) return this.override;
    if (!this.scene || this.sceneRev !== this.model.revision) {
      this.scene = buildScene(this.model, this.sceneOpts);
      this.sceneRev = this.model.revision;
    }
    return this.scene;
  }

  /** 场景里的实际建筑数（Planner 模式下和 legacy 不一样，右栏要显示这个而不是 model 的） */
  get sceneBuildingCount(): number {
    return this.ensureScene().solids.length;
  }

  /** 切换标线 / 街道设施 / 规划模式后调用 */
  setSceneOptions(opts: {
    markings?: boolean;
    furniture?: boolean;
    planningMode?: PlanningMode;
    circulation?: 'off' | 'golden' | 'all';
    s1?: 'off' | 'golden' | 'all';
    pattern?: 'off' | 'golden' | 'all';
    parkingProvider?: 'legacy' | 'placemaker' | 'compare';
  }): void {
    this.sceneOpts = { ...this.sceneOpts, ...opts };
    this.scene = null;
    this.requestDraw();
  }

  /**
   * 当前**实际渲染**的场景里，每个图层有多少个要素。
   *
   * 左栏每行后面的数字原来取的是 boot 时那一次 `diagnose()` 的结果 —— 切到
   * Planner / Shadow 之后场面已经换了，数字却还是 legacy 的，于是"内部车行路面 0"
   * 这种看着自相矛盾的行就出现了（画面上明明有内部路）。改成从当前场景现数。
   */
  layerCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    let sc: Scene;
    try {
      sc = this.ensureScene();
    } catch {
      return out;
    }
    const bump = (id: string) => { out[id] = (out[id] ?? 0) + 1; };
    for (const s of sc.surfaces) bump(layerOfSurface(s));
    for (const s of sc.solids) bump(layerOfSolid(s));
    for (const p of sc.props) bump(layerOfProp(p));
    for (const p of sc.paths) bump(layerOfPath(p));
    return out;
  }

  setZones(zones: Zone[]): void {
    this.zones = zones;
    this.requestDraw();
  }

  setGuides(guides: FieldGuide[]): void {
    this.guides = guides;
    this.requestDraw();
  }

  /** 切到三维视图时把浮动工具条收起来（画布都藏了，条子还浮着就很不合理） */
  setActive(on: boolean): void {
    this.active = on;
    if (!on && this.toolbar) this.toolbar.style.display = 'none';
    else this.requestDraw();
  }

  /** 按 id 选中对象（URL 参数 / 自动化脚本用，侧栏与画布交互走内部 select） */
  selectById(kind: SelKind, id: string): void {
    this.mode = 'select';
    this.canvas.style.cursor = 'default';
    this.select({ kind, id });
  }

  // ------------------------------------------------------------ 视图

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.round(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * this.dpr));
  }

  /**
   * 首屏时 CSS 可能还没生效，getBoundingClientRect 会拿到 0，
   * 导致画布被初始化成 1×1。这里在绘制前兜底检查一次尺寸。
   */
  private ensureSize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      const firstReal = this.canvas.width <= 2 || this.canvas.height <= 2;
      this.canvas.width = w;
      this.canvas.height = h;
      this.dpr = dpr;
      if (firstReal && rect.width > 2) this.fit();
    }
  }

  fit(): void {
    const rect = this.canvas.getBoundingClientRect();
    const radius = this.model.cityRadius || 100;
    const size = Math.min(rect.width, rect.height);
    if (size < 2) return;
    this.cam.scale = (size * 0.42) / radius;
    this.cam.x = 0;
    this.cam.y = 0;
    this.requestDraw();
  }

  /**
   * 把镜头移到某个世界坐标（3D 那边早就有 focusOn，2D 这边补上）。
   *
   * 用途：R8 的前端验收要能"凑近看一块地"——
   * 全城视图看不出停车线、树、路缘这些细节，必须能拉到地块尺度。
   */
  focusOn(x: number, y: number, scale = 26): void {
    this.cam.x = x;
    this.cam.y = y;
    this.cam.scale = Math.max(0.4, Math.min(120, scale));
    this.requestDraw();
  }

  private worldToScreen(p: Pt): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (p.x - this.cam.x) * this.cam.scale + rect.width / 2,
      y: (p.y - this.cam.y) * this.cam.scale + rect.height / 2,
    };
  }

  private screenToWorld(sx: number, sy: number): Pt {
    const rect = this.canvas.getBoundingClientRect();
    return new Pt(
      (sx - rect.width / 2) / this.cam.scale + this.cam.x,
      (sy - rect.height / 2) / this.cam.scale + this.cam.y
    );
  }

  private localPoint(e: PointerEvent | WheelEvent | MouseEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  // ------------------------------------------------------------ 交互

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const { x, y } = this.localPoint(e);
    const before = this.screenToWorld(x, y);
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    this.cam.scale = Math.max(0.4, Math.min(120, this.cam.scale * factor));
    const after = this.screenToWorld(x, y);
    this.cam.x += before.x - after.x;
    this.cam.y += before.y - after.y;
    this.requestDraw();
  }

  /** 当前选中的地块（点街区内部空白处选中，右栏出现属性面板） */
  selPatch: Patch | null = null;

  /** 外部清掉地块选中（换城市、改参数时） */
  setSelectedPatch(p: Patch | null): void {
    if (this.selPatch === p) return;
    this.selPatch = p;
    this.requestDraw();
  }

  /**
   * 命中测试：这个点落在哪个街区里。
   *
   * 地块是 Voronoi 切出来的、互不重叠，所以第一个命中的就是唯一答案；
   * 但边界上点可能同时落在两块的外扩里，取**面积最小**的那块 ——
   * 小地块通常是被大块包住的那个，选它更符合"我点的是这一小片"的直觉。
   */
  private pickPatch(world: Pt): Patch | null {
    let best: Patch | null = null;
    let bestA = Infinity;
    for (const p of this.model.patches) {
      const ring = Array.from(p.shape);
      if (ring.length < 3) continue;
      if (!pointInPolygon(world, ring)) continue;
      const a = Math.abs(polyArea(ring));
      if (a < bestA) {
        bestA = a;
        best = p;
      }
    }
    return best;
  }

  private onPointerDown(e: PointerEvent): void {
    // 指针捕获让"拖出画布"也能继续收到 move / up。
    // 合成事件（自测脚本）没有真实指针，这里会抛 NotFoundError，忽略即可。
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* 合成指针：忽略 */
    }
    const { x, y } = this.localPoint(e);
    const world = this.screenToWorld(x, y);

    // 中键 / 右键 / 空格 → 平移
    if (e.button === 1 || e.button === 2 || e.shiftKey) {
      this.panning = true;
      this.panStart = { x, y, cx: this.cam.x, cy: this.cam.y };
      return;
    }

    if (e.button !== 0) return;

    if (this.mode === 'select') {
      // ① "改形状"的把手优先：它一定在选中对象上，命中就该拖顶点而不是整体挪
      const handle = this.pickSelHandle(x, y);
      if (handle !== null && this.sel) {
        this.canvas.style.cursor = 'grabbing';
        this.beginObjDrag(this.sel, world, handle);
        return;
      }
      // ② 拓扑点（模型顶点）拖拽 —— 改动路网走向
      const v = this.pickVertex(x, y);
      if (v) {
        this.dragVertex = v;
        this.dragOrigin = new Pt(v.x, v.y);
        return;
      }
      // ③ 方向线：只有一条细线，最优先
      const guide = this.pickGuide(world);
      if (guide) {
        this.select(guide);
        this.canvas.style.cursor = 'grabbing';
        this.beginObjDrag(guide, world, null);
        return;
      }
      // ④ 路：点在路上就是要单独调这条路的宽度（比禁区优先，见 pickZone 上的注释）
      const road = this.pickRoad(world);
      if (road) {
        this.select(null);
        this.selectRoad(road);
        this.cb.onStatus(
          `已选中 ${road.cls === 'arterial' ? '主干道' : road.cls === 'collector' ? '次干道' : '支路'} · 侧栏「选中路」可单独调宽`
        );
        return;
      }
      // ⑤ 禁绘区
      const zone = this.pickZone(world);
      if (zone) {
        this.select(zone);
        this.selectArtery(null);
        this.canvas.style.cursor = 'grabbing';
        this.beginObjDrag(zone, world, null);
        return;
      }
      // ⑥ 地块：点在街区内部（既不是路、也不是禁区）→ 选中该地块，
      //    右栏会出现「选中地块」面板（用途 / 高度 / 切分）。
      const patch = this.pickPatch(world);
      if (patch) {
        this.select(null);
        this.selectArtery(null);
        this.selPatch = patch;
        this.cb.onPatchSelect?.(patch);
        this.requestDraw();
        return;
      }
      if (this.selPatch) {
        this.selPatch = null;
        this.cb.onPatchSelect?.(null);
      }
      this.select(null);
      this.selectArtery(null);
      return;
    }

    // 绘制禁建区
    if (this.mode === 'rect' || this.mode === 'circle') {
      this.draft = { kind: this.mode, points: [world], cursor: world };
    } else if (this.mode === 'poly' || this.mode === 'guide') {
      // 多段线：逐点点击累加，双击结束（见 onDoubleClick）
      if (!this.draft || this.draft.kind !== this.mode) this.draft = { kind: this.mode, points: [world], cursor: world };
      else this.draft.points.push(world);
    }
    this.requestDraw();
  }

  private onPointerMove(e: PointerEvent): void {
    const { x, y } = this.localPoint(e);
    const world = this.screenToWorld(x, y);
    this.shiftDown = e.shiftKey;

    if (this.panning) {
      this.cam.x = this.panStart.cx - (x - this.panStart.x) / this.cam.scale;
      this.cam.y = this.panStart.cy - (y - this.panStart.y) / this.cam.scale;
      this.requestDraw();
      return;
    }

    if (this.objDrag) {
      this.updateObjDrag(world);
      return;
    }

    if (this.dragVertex) {
      this.model.moveVertex(this.dragVertex, world.x, world.y);
      this.cb.onStatus(`顶点 (${world.x.toFixed(1)}, ${world.y.toFixed(1)})`);
      this.requestDraw();
      return;
    }

    if (this.draft) {
      this.draft.cursor = world;
      // 矩形 / 圆是"按下拖出"，多段线是"逐点点击"，不能中途改第二个点
      if (this.draft.kind === 'rect' || this.draft.kind === 'circle') this.draft.points[1] = world;
      this.requestDraw();
      return;
    }

    const v = this.mode === 'select' ? this.pickVertex(x, y) : null;
    if (v !== this.hoverVertex) {
      this.hoverVertex = v;
      this.canvas.style.cursor = v ? 'grab' : this.mode === 'select' ? 'default' : 'crosshair';
      this.requestDraw();
    }
  }

  private onPointerUp(e: PointerEvent): void {
    if (this.panning) {
      this.panning = false;
      return;
    }

    if (this.objDrag) {
      this.canvas.style.cursor = 'default';
      this.endObjDrag();
      this.requestDraw();
      return;
    }

    if (this.dragVertex) {
      const moved = this.dragOrigin && (Math.abs(this.dragOrigin.x - this.dragVertex.x) > 1e-6 || Math.abs(this.dragOrigin.y - this.dragVertex.y) > 1e-6);
      this.dragVertex = null;
      this.dragOrigin = null;
      if (moved) this.cb.onRebuild();
      this.requestDraw();
      return;
    }

    if (this.draft) {
      // 多段线靠双击收尾，抬起鼠标时不能提交（否则每点一下就重开一条）
      if (this.draft.kind === 'poly' || this.draft.kind === 'guide') return;
      this.commitDraft();
      return;
    }

    // 空白处点击的取消选中已经在 pointerdown 里做完了。
    // 这里原来还有一段"点空白 selectArtery(null)"，会把刚点中的路立刻取消，
    // 现在全部交给 pointerdown，pointerup 不再改选中态。
  }

  private onDoubleClick(e: MouseEvent): void {
    if (this.draft && (this.draft.kind === 'poly' || this.draft.kind === 'guide')) {
      this.commitDraft();
    }
  }

  private commitDraft(): void {
    const d = this.draft;
    this.draft = null;
    if (!d) return;

    // 双击时最后两下会落在同一个位置，先去重再判定
    const pts = dedupePoints(d.points, 1e-3);

    if (d.kind === 'guide') {
      if (!guideIsUsable(pts)) {
        this.cb.onStatus('方向线太短，至少画一小段（双击结束）');
        this.requestDraw();
        return;
      }
      const index = this.guides.length + 1;
      const g = makeGuide(`guide-${Date.now().toString(36)}`, `方向线 ${index}`, pts, this.guideStrength);
      this.guides = this.guides.concat([g]);
      this.cb.onGuidesChanged(this.guides);
      this.setMode('select');
      this.cb.onStatus(`已添加 ${g.label} · ${pts.length} 个点，街道会沿它排列`);
      return;
    }

    const id = `zone-${Date.now().toString(36)}`;
    const index = this.zones.length + 1;
    let zone: Zone | null = null;

    if (d.kind === 'rect') {
      const a = d.points[0];
      const b = d.points[1] ?? d.cursor;
      if (!b) return;
      const w = Math.abs(a.x - b.x);
      const h = Math.abs(a.y - b.y);
      if (w < 4 || h < 4) return;
      zone = makeZone(id, `矩形禁区 ${index}`, {
        kind: 'rect',
        a: new Pt(Math.min(a.x, b.x), Math.min(a.y, b.y)),
        b: new Pt(Math.max(a.x, b.x), Math.max(a.y, b.y)),
      });
    } else if (d.kind === 'circle') {
      const c = d.points[0];
      const edge = d.points[1] ?? d.cursor;
      if (!edge) return;
      const r = Pt.distance(c, edge);
      if (r < 3) return;
      zone = makeZone(id, `圆形禁区 ${index}`, { kind: 'circle', c, r });
    } else if (d.kind === 'poly') {
      if (pts.length < 3) return;
      zone = makeZone(id, `多边形禁区 ${index}`, { kind: 'poly', pts });
    }

    if (zone) {
      this.zones = this.zones.concat([zone]);
      this.cb.onZonesChanged(this.zones);
      this.setMode('select');
      this.cb.onStatus(`已添加 ${zone.label}`);
    }
    this.requestDraw();
  }

  setMode(mode: DrawMode): void {
    this.mode = mode;
    this.draft = null;
    this.objDrag = null;
    // 进绘制模式就收起工具条：这时候再浮着一块"移动/旋转"会挡住要画的地方
    if (mode !== 'select') this.select(null);
    this.canvas.style.cursor = mode === 'select' ? 'default' : 'crosshair';
    this.cb.onModeChanged?.(mode);
    this.requestDraw();
  }

  private selectArtery(index: number | null): void {
    this.selectedArtery = index;
    const e = index === null ? null : this.roadNet().edges[index] ?? null;
    this.selectedKey = e ? edgeKey(e.a, e.b) : null;
    this.cb.onSelection({ artery: index, vertex: this.dragVertex, road: e ? this.roadPickOf(e) : null });
    this.requestDraw();
  }

  /** 直接按边对象选中（点路时用） */
  selectRoad(e: RoadEdge | null): void {
    if (!e) {
      this.selectArtery(null);
      return;
    }
    const idx = this.roadNet().edges.indexOf(e);
    this.selectArtery(idx >= 0 ? idx : null);
  }

  /** 改完宽度后重建，靠键把选中态与滑杆数值同步回来 */
  refreshRoadSelection(): void {
    if (!this.selectedKey) return;
    const e = this.roadEdge();
    if (!e) {
      this.selectArtery(null);
      return;
    }
    this.cb.onSelection({ artery: this.selectedArtery, vertex: null, road: this.roadPickOf(e) });
  }

  private roadPickOf(e: RoadEdge): RoadPick {
    const r = this.model.edgeWidthRange(e.a, e.b);
    const key = edgeKey(e.a, e.b);
    return {
      key,
      a: e.a,
      b: e.b,
      cls: r.cls,
      width: this.model.edgeWidthAt(e.a, e.b),
      min: r.min,
      max: r.max,
      custom: this.model.widthOverrides.has(key),
    };
  }

  private roadNet(): RoadNet {
    if (!this.net || this.netRev !== this.model.revision) {
      this.net = buildRoadNet(this.model);
      this.netRev = this.model.revision;
    }
    return this.net;
  }

  private roadEdge(): RoadEdge | null {
    const net = this.roadNet();
    if (this.selectedKey) {
      const i = net.edges.findIndex((e) => edgeKey(e.a, e.b) === this.selectedKey);
      if (i >= 0) {
        this.selectedArtery = i;
        return net.edges[i];
      }
    }
    return this.selectedArtery !== null ? net.edges[this.selectedArtery] ?? null : null;
  }

  private pickRoad(world: Pt): RoadEdge | null {
    const net = this.roadNet();
    let best: RoadEdge | null = null;
    let bestD = 4 / this.cam.scale; // 4 屏幕像素
    for (const e of net.edges) {
      const d = distToSegment(world, e.a, e.b);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  // ------------------------------------------------------------ 选中 / 浮动工具条

  /**
   * 选中一个禁绘区或方向线，浮动工具条随即出现在它上方。
   *
   * 为什么要有这个：禁绘区现在是一块**固定的封闭地块**（挖块之后区内没有任何
   * 城市道路），它的形状必须能随时改 —— 重新画一遍意味着整城重新切块，
   * 用户此前的微调全没了。方向线同理：改完就得整城重生，更要能按需挪。
   */
  private select(sel: ObjSel | null): void {
    const same = !!sel && !!this.sel && sel.kind === this.sel.kind && sel.id === this.sel.id;
    this.sel = sel;
    if (!same) this.toolbarFor = null;
    this.renderToolbar();
    this.requestDraw();
  }

  private selObject(): { kind: SelKind; id: string; label: string; enabled: boolean } | null {
    const sel = this.sel;
    if (!sel) return null;
    if (sel.kind === 'zone') {
      const z = this.zones.find((q) => q.id === sel.id);
      return z ? { kind: 'zone', id: z.id, label: z.label, enabled: z.enabled } : null;
    }
    const g = this.guides.find((q) => q.id === sel.id);
    return g ? { kind: 'guide', id: g.id, label: g.label, enabled: g.enabled } : null;
  }

  /** 选中对象的轮廓（世界坐标）：禁绘区看成多边形，方向线就是折线 */
  private selOutline(): Pt[] | null {
    const sel = this.sel;
    if (!sel) return null;
    if (sel.kind === 'zone') {
      const z = this.zones.find((q) => q.id === sel.id);
      return z ? zoneToPolygon(z) : null;
    }
    return this.guides.find((q) => q.id === sel.id)?.pts ?? null;
  }

  /**
   * "改形状"模式的把手。
   * 矩形给 4 个角、多边形给全部顶点、圆只给 1 个半径把手（半径就一个自由度，
   * 圆周上摆 40 个点除了看着乱没有任何意义）、方向线给每个节点。
   */
  private selHandles(): Pt[] {
    const sel = this.sel;
    if (!sel) return [];
    if (sel.kind === 'guide') return this.guides.find((q) => q.id === sel.id)?.pts ?? [];
    const z = this.zones.find((q) => q.id === sel.id);
    if (!z) return [];
    if (z.shape.kind === 'circle') return [new Pt(z.shape.c.x + z.shape.r, z.shape.c.y)];
    return zoneToPolygon(z);
  }

  /** 点到折线 / 环的屏幕像素距离 */
  private distPx(pts: Pt[], world: Pt, closed: boolean): number {
    const n = pts.length;
    if (n === 0) return Infinity;
    if (n === 1) return Pt.distance(pts[0], world) * this.cam.scale;
    const segs = closed ? n : n - 1;
    let d = Infinity;
    for (let i = 0; i < segs; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      const dd = distToSegment(world, a, b);
      if (dd < d) d = dd;
    }
    return d * this.cam.scale;
  }

  /**
   * 拾取对象。顺序是刻意的：方向线 → 路 → 禁绘区。
   *
   * 方向线最先，因为它只有一条细线，落在区内就永远点不到；
   * 路比禁区先，是因为禁区的边线正好压在道路中线上 —— 若禁区优先，
   * 贴着禁区走的那条路（连它两侧整条路面）就再也没法点中单独调宽了。
   * 禁区内部没有城市道路（挖块之后区内只有内部路，不进 RoadNet），
   * 所以街区内部随便点都能选中禁区。
   */
  private pickGuide(world: Pt): ObjSel | null {
    if (!this.showGuides) return null;
    let best: ObjSel | null = null;
    let bestD = 10;
    for (let i = this.guides.length - 1; i >= 0; i--) {
      const g = this.guides[i];
      const d = this.distPx(g.pts, world, false);
      if (d <= bestD) {
        bestD = d;
        best = { kind: 'guide', id: g.id };
      }
    }
    return best;
  }

  private pickZone(world: Pt): ObjSel | null {
    if (!this.showZones) return null;
    for (let i = this.zones.length - 1; i >= 0; i--) {
      const z = this.zones[i];
      const ring = zoneToPolygon(z);
      if (z.enabled && pointInPolygon(world, ring)) return { kind: 'zone', id: z.id };
      // 细长的禁区（比如一条 1 单位宽的长条）内部很难点中，允许点边线
      if (this.distPx(ring, world, true) <= 7) return { kind: 'zone', id: z.id };
    }
    return null;
  }

  /** "改形状"时命中的把手序号 */
  private pickSelHandle(sx: number, sy: number): number | null {
    if (this.tool !== 'shape' || !this.sel) return null;
    const hs = this.selHandles();
    let best: number | null = null;
    let bestD = 10;
    for (let i = 0; i < hs.length; i++) {
      const s = this.worldToScreen(hs[i]);
      const d = Math.hypot(s.x - sx, s.y - sy);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  private beginObjDrag(sel: ObjSel, world: Pt, index: number | null): void {
    const outline = this.selOutline();
    if (!outline || outline.length === 0) return;
    const pivot = centerOf(outline);
    if (sel.kind === 'zone') {
      const z = this.zones.find((q) => q.id === sel.id);
      if (!z) return;
      this.objDrag = {
        kind: 'zone', id: sel.id, tool: this.tool, start: world, pivot,
        startAng: Math.atan2(world.y - pivot.y, world.x - pivot.x),
        startDist: Math.max(0.01, Pt.distance(world, pivot)),
        zone: z, guide: null, index, dirty: false,
      };
    } else {
      const g = this.guides.find((q) => q.id === sel.id);
      if (!g) return;
      this.objDrag = {
        kind: 'guide', id: sel.id, tool: this.tool, start: world, pivot,
        startAng: Math.atan2(world.y - pivot.y, world.x - pivot.x),
        startDist: Math.max(0.01, Pt.distance(world, pivot)),
        zone: null, guide: g, index, dirty: false,
      };
    }
  }

  private updateObjDrag(world: Pt): void {
    const d = this.objDrag;
    if (!d) return;

    let f: PointMap | null = null;
    let hint = '';
    if (d.tool === 'move') {
      const dx = world.x - d.start.x;
      const dy = world.y - d.start.y;
      f = translateMap(dx, dy);
      hint = `移动 Δ(${dx.toFixed(1)}, ${dy.toFixed(1)})`;
    } else if (d.tool === 'rotate') {
      const ang = Math.atan2(world.y - d.pivot.y, world.x - d.pivot.x);
      let deg = ((ang - d.startAng) * 180) / Math.PI;
      deg = ((deg % 360) + 540) % 360 - 180;
      // Shift 吸附到 15°，摆正矩形时不用靠手感
      const step = this.snapAngles ? Math.round(deg / 15) * 15 : deg;
      f = rotateMap(d.pivot, (step * Math.PI) / 180);
      hint = `旋转 ${step.toFixed(0)}°`;
    } else if (d.tool === 'scale') {
      const k = Math.max(0.1, Math.min(12, Pt.distance(world, d.pivot) / d.startDist));
      const kk = this.snapAngles ? Math.max(0.1, Math.round(k * 10) / 10) : k;
      f = scaleMap(d.pivot, kk);
      hint = `缩放 ${kk.toFixed(2)}×`;
    } else if (d.index === null) {
      return;
    }

    if (d.kind === 'zone') {
      const i = this.zones.findIndex((z) => z.id === d.id);
      if (i < 0 || !d.zone) return;
      this.zones[i] = f
        ? mapZone(d.zone, f)
        : setZoneVertex(d.zone, d.index as number, world);
    } else {
      const i = this.guides.findIndex((g) => g.id === d.id);
      if (i < 0 || !d.guide) return;
      this.guides[i] = f
        ? mapGuide(d.guide, f)
        : setGuideVertex(d.guide, d.index as number, world);
      if (d.tool === 'shape') hint = `节点 (${world.x.toFixed(1)}, ${world.y.toFixed(1)})`;
    }

    d.dirty = true;
    if (hint) this.cb.onStatus(hint);
    this.requestDraw();
  }

  private endObjDrag(): void {
    const d = this.objDrag;
    this.objDrag = null;
    if (!d || !d.dirty) return;
    // 松开鼠标才提交：拖拽过程中每帧都整城重生的话，手一抖就是几秒钟的卡顿
    this.zones = this.zones.slice();
    this.guides = this.guides.slice();
    if (d.kind === 'zone') this.cb.onZonesChanged(this.zones);
    else this.cb.onGuidesChanged(this.guides);
  }

  /** Shift 按下时旋转按 15° 吸附、缩放按 0.1 吸附 */
  private get snapAngles(): boolean {
    return this.shiftDown;
  }

  private shiftDown = false;

  private setTool(t: EditTool): void {
    this.tool = t;
    this.toolbarFor = null;
    this.renderToolbar();
    this.requestDraw();
  }

  private deleteSel(): void {
    const o = this.selObject();
    if (!o) return;
    if (o.kind === 'zone') {
      this.zones = this.zones.filter((z) => z.id !== o.id);
      this.sel = null;
      this.toolbarFor = null;
      this.renderToolbar();
      this.cb.onZonesChanged(this.zones);
    } else {
      this.guides = this.guides.filter((g) => g.id !== o.id);
      this.sel = null;
      this.toolbarFor = null;
      this.renderToolbar();
      this.cb.onGuidesChanged(this.guides);
    }
    this.cb.onStatus(`已删除 ${o.label}`);
    this.requestDraw();
  }

  private toggleSel(): void {
    const o = this.selObject();
    if (!o) return;
    if (o.kind === 'zone') {
      this.zones = this.zones.map((z) => (z.id === o.id ? { ...z, enabled: !z.enabled } : z));
      this.toolbarFor = null;
      this.renderToolbar();
      this.cb.onZonesChanged(this.zones);
    } else {
      this.guides = this.guides.map((g) => (g.id === o.id ? { ...g, enabled: !g.enabled } : g));
      this.toolbarFor = null;
      this.renderToolbar();
      this.cb.onGuidesChanged(this.guides);
    }
  }

  private renderToolbar(): void {
    const el = this.toolbar;
    if (!el) return;
    const o = this.selObject();
    if (!o || this.mode !== 'select' || !this.active) {
      el.style.display = 'none';
      this.toolbarFor = null;
      return;
    }

    const key = `${o.kind}:${o.id}:${this.tool}:${o.enabled}`;
    if (key !== this.toolbarFor) {
      this.toolbarFor = key;
      el.innerHTML =
        `<div class="fb-head" title="${o.label}">${o.label}</div>` +
        `<div class="fb-row">` +
        `<button data-tool="move" class="${this.tool === 'move' ? 'on' : ''}" title="拖动对象移动位置">移动</button>` +
        `<button data-tool="rotate" class="${this.tool === 'rotate' ? 'on' : ''}" title="拖动绕中心旋转（按住 Shift 吸附 15°）">旋转</button>` +
        `<button data-tool="scale" class="${this.tool === 'scale' ? 'on' : ''}" title="拖动以中心为基准缩放（按住 Shift 吸附 0.1）">缩放</button>` +
        `<button data-tool="shape" class="${this.tool === 'shape' ? 'on' : ''}" title="拖动顶点改形状">改形状</button>` +
        `</div>` +
        `<div class="fb-row">` +
        `<button data-act="toggle">${o.enabled ? '禁用' : '启用'}</button>` +
        `<button data-act="delete" class="danger">删除</button>` +
        `<button data-act="close" class="close" title="取消选中 (Esc)">✕</button>` +
        `</div>`;

      el.querySelectorAll<HTMLButtonElement>('button[data-tool]').forEach((b) => {
        b.addEventListener('click', () => this.setTool(b.dataset.tool as EditTool));
      });
      el.querySelectorAll<HTMLButtonElement>('button[data-act]').forEach((b) => {
        b.addEventListener('click', () => {
          const act = b.dataset.act;
          if (act === 'toggle') this.toggleSel();
          else if (act === 'delete') this.deleteSel();
          else this.select(null);
        });
      });
    }

    el.style.display = '';
    this.placeToolbar();
  }

  /**
   * 工具条的挂点。
   * 禁绘区挂在**外接框顶边中点**上方（形状方方正正，这样最贴）；
   * 方向线不能这么挂 —— 一条斜线的外接框顶边中点可能离线本身很远，
   * 工具条会飘在无关的地方，所以改挂在折线**长度一半处**。
   */
  private selAnchor(): { x: number; y: number } | null {
    const ring = this.selOutline();
    if (!ring || ring.length === 0) return null;
    if (this.sel?.kind === 'zone' || ring.length < 2) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      for (const p of ring) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
      }
      return this.worldToScreen(new Pt((minX + maxX) / 2, minY));
    }
    let total = 0;
    for (let i = 0; i + 1 < ring.length; i++) total += Pt.distance(ring[i], ring[i + 1]);
    let acc = 0;
    for (let i = 0; i + 1 < ring.length; i++) {
      const seg = Pt.distance(ring[i], ring[i + 1]);
      if (acc + seg >= total / 2 && seg > 1e-9) {
        const t = (total / 2 - acc) / seg;
        return this.worldToScreen(
          new Pt(ring[i].x + (ring[i + 1].x - ring[i].x) * t, ring[i].y + (ring[i + 1].y - ring[i].y) * t)
        );
      }
      acc += seg;
    }
    return this.worldToScreen(ring[0]);
  }

  /** 贴着挂点摆；上方放不下就翻到下面 */
  private placeToolbar(): void {
    const el = this.toolbar;
    const anchor = this.selAnchor();
    if (!el || !anchor) return;
    const rect = this.canvas.getBoundingClientRect();
    const bw = el.offsetWidth || 210;
    const bh = el.offsetHeight || 70;
    let left = anchor.x - bw / 2;
    let top = anchor.y - bh - 14;
    if (top < 6) top = anchor.y + 22;
    left = Math.max(6, Math.min(rect.width - bw - 6, left));
    top = Math.max(6, Math.min(rect.height - bh - 6, top));
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  }

  // ------------------------------------------------------------ 拾取

  private pickVertex(sx: number, sy: number): Pt | null {
    if (!this.showVertices) return null;
    const verts = new Set<Pt>();
    for (const patch of this.model.patches) {
      // 禁绘区那块地的边界顶点不给拖：
      // 它同时是禁区的轮廓，拖了会和用户画的形状对不上（下次重生又回到原处）。
      // 改禁区请用浮动工具条的"改形状"，那边会同步改 Zone 本身。
      if (!patch.withinCity || patch.blocked) continue;
      for (const v of patch.shape) verts.add(v);
    }
    if (verts.size === 0) return null;

    let best: Pt | null = null;
    let bestD = 10; // px
    for (const v of verts) {
      if (v === this.model.center) continue;
      const s = this.worldToScreen(v);
      const d = Math.hypot(s.x - sx, s.y - sy);
      if (d < bestD) {
        bestD = d;
        best = v;
      }
    }
    return best;
  }

  // ------------------------------------------------------------ 绘制

  requestDraw(): void {
    if (this.needsDraw) return;
    this.needsDraw = true;
    this.rafHandle = requestAnimationFrame(() => {
      this.needsDraw = false;
      this.draw();
    });
  }

  /**
   * R1.4 诊断图层：把求解器的完整网络画出来。
   *
   * 分五层不是炫技，是**必须分开看**：
   *   · 既有可通行道路（蓝）—— 被并进网络的场地铺装，网络主体常常是它；
   *   · A* 新增连接（橙）—— 真正由求解器铺出来的那几条，往往只是补丁；
   *   · 合并后的完整网络 —— 两者叠在一起，才能回答"是不是一条连通的通路"；
   *   · 入口（按交通类型分色）—— 街区出口 / 建筑门 / 停车口 / 后勤口；
   *   · 接不上的需求点（红叉）—— 失败要看得见，不能只写进 warnings。
   *
   * 坐标已经在 draw() 里做过平移缩放，这里一律用世界单位。
   */
  private drawCirculationDebug(ctx: CanvasRenderingContext2D, px: number): void {
    const b = this.plannerBundle;
    if (!b) return;
    const TRAFFIC: Record<string, string> = {
      vehicle: '#e0762e',
      service: '#8a5fb0',
      pedestrian: '#2f8f9d',
    };
    const PORTAL: Record<string, string> = {
      street: '#ffffff',
      door: '#2f8f9d',
      'service-door': '#8a5fb0',
      parking: '#e0762e',
    };

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    for (const [, d] of b.circulationDebug) {
      // ① 既有可通行道路
      if ((this.showCirExisting || this.showCirMerged) && d.adopted.length > 0) {
        for (const a of d.adopted) {
          ctx.beginPath();
          this.tracePath(a.outer);
          ctx.fillStyle = this.showCirMerged ? 'rgba(70,130,180,0.20)' : 'rgba(70,130,180,0.30)';
          ctx.fill();
          if (this.showCirExisting) {
            ctx.strokeStyle = 'rgba(52,100,145,0.75)';
            ctx.lineWidth = 0.55 * px;
            ctx.stroke();
          }
        }
      }

      // ② A* 新增连接 / ③ 合并后的完整网络
      if (this.showCirNew || this.showCirMerged) {
        for (const e of d.edges) {
          if (e.pts.length < 2) continue;
          ctx.strokeStyle = this.showCirMerged ? '#c85a1e' : (TRAFFIC[e.traffic] ?? '#e0762e');
          // 屏幕线宽跟着真实路宽走，但保底 2 px，否则小城缩放后看不见
          ctx.lineWidth = Math.max(1.6 * px, (e.widthM / 7) * 0.5);
          ctx.beginPath();
          ctx.moveTo(e.pts[0].x, e.pts[0].y);
          for (let i = 1; i < e.pts.length; i++) ctx.lineTo(e.pts[i].x, e.pts[i].y);
          ctx.stroke();
        }
      }

      // ④ 入口与街区出口
      if (this.showCirPortals) {
        for (const n of d.nodes) {
          const r = (n.kind === 'street' ? 3.4 : 2.8) * px;
          ctx.beginPath();
          ctx.arc(n.at.x, n.at.y, r, 0, Math.PI * 2);
          ctx.fillStyle = PORTAL[n.kind] ?? '#ffffff';
          ctx.fill();
          ctx.strokeStyle = 'rgba(20,18,15,0.85)';
          ctx.lineWidth = 0.7 * px;
          ctx.stroke();
        }
      }

      // ⑤ 接不上的需求点
      if (this.showCirUnreachable) {
        for (const u of d.unreachable) {
          const r = 4.2 * px;
          ctx.strokeStyle = '#d8341f';
          ctx.lineWidth = 1.4 * px;
          ctx.beginPath();
          ctx.moveTo(u.at.x - r, u.at.y - r);
          ctx.lineTo(u.at.x + r, u.at.y + r);
          ctx.moveTo(u.at.x + r, u.at.y - r);
          ctx.lineTo(u.at.x - r, u.at.y + r);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(u.at.x, u.at.y, r * 1.5, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(216,52,31,0.55)';
          ctx.lineWidth = 0.8 * px;
          ctx.stroke();
        }
      }
    }

    ctx.restore();
  }

  draw(): void {
    this.ensureSize();
    const ctx = this.ctx;
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(this.cam.scale, this.cam.scale);
    ctx.translate(-this.cam.x, -this.cam.y);

    const px = 1 / this.cam.scale; // 1 屏幕像素对应的世界单位

    // 地块轮廓（结构覆盖层）—— F3 模式下没有 model.patches 这回事
    if (this.showBlocks && !this.override) {
      // 地块轮廓：浅色晕圈 + 深色主线两遍描。
      //
      // 原来一道 rgba(120,116,106,0.45) 的灰线，在米色铺装上几乎看不见 ——
      // 单色描边不可能同时在浅铺装和深沥青上都够反差（这两块的明度差了 60%）。
      // 所以先用浅色描粗一遍当"分离带"，再压一道近黑的细线：
      // 浅底上读到的是深线，深底上读到的是浅圈，两边都清楚。
      ctx.save();
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(255,251,242,0.62)';
      ctx.lineWidth = 2.8 * px;
      for (const patch of this.model.patches) {
        this.tracePath(patch.shape);
        ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(26,23,20,0.88)';
      ctx.lineWidth = 1.05 * px;
      for (const patch of this.model.patches) {
        this.tracePath(patch.shape);
        ctx.stroke();
      }
      ctx.restore();
    }

    // ---- 场景图层：与 3D 共用同一份数据，按高度从低到高铺
    const scene = this.ensureScene();

    const surfaces = scene.surfaces.slice().sort((a, b) => a.y - b.y);
    for (const s of surfaces) {
      const layer = layerOfSurface(s);
      if (!this.vis(layer)) continue;
      ctx.fillStyle = css(this.hiliteLotRoad && isInternalRoadLayer(layer) ? hiliteMatOf(layer) : s.mat);
      this.tracePath(s.ring);
      ctx.fill();
    }

    // 用地类型着色：按 LandUse 铺一层半透明色，放得够大时再标名字。
    // 放在铺装之上、建筑之下 —— 建筑盖住的地方本来也不需要读用地色，
    // 而空地和绿地被染上色之后，"哪里是 CBD、哪里是绿地"一眼就能分出来。
    if (this.showUse && !this.override) {
      ctx.save();
      ctx.globalAlpha = 0.42;
      for (const patch of this.model.patches) {
        if (!patch.withinCity) continue;
        const use = (patch.blocked
          ? 'reserved'
          : ((patch.ward as { use?: string } | null)?.use ?? 'green')) as LandUse;
        const c = USE_COLOR[use] ?? [0.5, 0.5, 0.5];
        ctx.fillStyle = `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;
        this.tracePath(Array.from(patch.shape));
        ctx.fill();
      }
      ctx.restore();

      // 标注：只给"屏幕上真放得下这两个字"的地块画。
      //
      // 原来用的是 `cam.scale > 2.2` —— 拿全局缩放当门槛。可是缩放是相对于
      // 城市尺度的：9 个街区的小城一进来 scale 就超过 2.2，于是 99 个地块
      // 全部插上"住宅 / 绿地 / 中央商务"，字比街区还大，把道路中线全糊住了。
      // 改成按地块自己的屏幕尺寸判定：宽度不够放字就不画。
      ctx.save();
      const fsPx = 9.5; // 字号（屏幕像素）
      ctx.font = `600 ${fsPx * px}px ui-sans-serif, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      for (const patch of this.model.patches) {
        if (!patch.withinCity) continue;
        const use = (patch.blocked
          ? 'reserved'
          : ((patch.ward as { use?: string } | null)?.use ?? 'green')) as LandUse;
        const label = USE_LABEL[use] ?? use;
        // 住宅是底色（占近一半），每块都标"住宅"等于什么都没标 —— 图例已经说明。
        // 只标注少数派用途：中央商务、商业、公共设施、工业、公园、停车场、绿地。
        if (use === 'residential') continue;
        const tw = ctx.measureText(label).width;
        // 地块的世界坐标 bbox（字体也在世界坐标里，直接比）
        let x0 = Infinity;
        let y0 = Infinity;
        let x1 = -Infinity;
        let y1 = -Infinity;
        let cx = 0;
        let cy = 0;
        const ring = Array.from(patch.shape);
        for (const v of ring) {
          if (v.x < x0) x0 = v.x;
          if (v.x > x1) x1 = v.x;
          if (v.y < y0) y0 = v.y;
          if (v.y > y1) y1 = v.y;
          cx += v.x;
          cy += v.y;
        }
        cx /= ring.length;
        cy /= ring.length;
        // 要"富裕"才画：横向能放下两倍字宽、纵向能放下两倍字高。
        // 门槛放宽一点点，半个城市就全是"住宅"两个大字 —— 那是噪音，不是信息。
        if (x1 - x0 < tw * 2 || y1 - y0 < fsPx * px * 2.2) continue;
        ctx.strokeStyle = 'rgba(18,16,14,0.75)';
        ctx.lineWidth = 2.4 * px;
        ctx.strokeText(label, cx, cy);
        ctx.fillStyle = 'rgba(255,252,246,0.94)';
        ctx.fillText(label, cx, cy);
      }
      ctx.restore();
    }

    // 线性要素：内部道路、园路、围栏
    for (const p of scene.paths) {
      if (p.pts.length < 2) continue;
      // 栏杆被拆成上下两根横杆，俯视完全重合 —— 只画第一根，省一次描边
      if (p.hidden2d) continue;
      if (!this.vis(layerOfPath(p))) continue;
      ctx.strokeStyle = css(
        this.hiliteLotRoad && isInternalRoadLayer(layerOfPath(p)) ? hiliteMatOf(layerOfPath(p)) : p.mat
      );
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (p.height) {
        ctx.lineWidth = Math.max(p.width, 0.5 * px);
        ctx.setLineDash([1.6 * px * 2, 1.6 * px * 2]);
      } else {
        ctx.lineWidth = Math.max(p.width, 0.7 * px);
      }
      ctx.beginPath();
      ctx.moveTo(p.pts[0].x, p.pts[0].y);
      for (let k = 1; k < p.pts.length; k++) ctx.lineTo(p.pts[k].x, p.pts[k].y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 道具：树画成**不同绿的方块**（和三维里的立方体一一对应），
    // 路灯画「杆点 + 短灯臂」（rot 指向车行道中线）。
    // 原来树是一个统一绿点，看不出是树、也分不清品种；方块 + 6 档绿之后
    // 俯视图上直接能读出"这是一片林子"。
    for (const pr of scene.props) {
      if (!this.vis(layerOfProp(pr))) continue;
      if (pr.kind === 'tree' || pr.kind === 'treeSmall' || pr.kind === 'conifer') {
        const half = (pr.kind === 'conifer' ? 0.26 : pr.kind === 'treeSmall' ? 0.24 : 0.32) * pr.scale;
        ctx.fillStyle = treeGreenCss(pr.seed, pr.kind === 'treeSmall' ? -0.04 : 0);
        ctx.fillRect(pr.at.x - half, pr.at.y - half, half * 2, half * 2);
      } else if (pr.kind === 'lamp' || pr.kind === 'lampDouble') {
        // 灯臂朝向（rot 指向车行道中线）在 2D 里也要看得见：
        // 杆位一个圆点 + 一根短灯臂 + 灯头小方块，与 3D / SVG 同一份 rot。
        const arm = 0.44 * pr.scale;
        const ex = pr.at.x + Math.cos(pr.rot) * arm;
        const ey = pr.at.y + Math.sin(pr.rot) * arm;
        ctx.strokeStyle = LAMP;
        ctx.lineWidth = 0.07;
        ctx.beginPath();
        ctx.moveTo(pr.at.x, pr.at.y);
        ctx.lineTo(ex, ey);
        ctx.stroke();
        ctx.fillStyle = LAMP;
        ctx.beginPath();
        ctx.arc(pr.at.x, pr.at.y, 0.14 * pr.scale, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillRect(ex - 0.075 * pr.scale, ey - 0.075 * pr.scale, 0.15 * pr.scale, 0.15 * pr.scale);
      } else if (pr.kind === 'hedge') {
        // 绿篱：和三维里同一块矮方块（1.5 × 0.9 m），按朝向转一下。
        // 画成短矩形而不是圆点，俯视图上才读得出"一排修剪过的灌木"。
        const hw = 0.107 * pr.scale;
        const hd = 0.0645 * pr.scale;
        ctx.save();
        ctx.translate(pr.at.x, pr.at.y);
        ctx.rotate(pr.rot);
        ctx.fillStyle = '#3c5b33';
        ctx.fillRect(-hw, -hd, hw * 2, hd * 2);
        ctx.restore();
      } else if (pr.kind === 'post') {
        // 栏杆立柱：6 cm 的东西，放大到 1.6 px 才看得见，颜色压暗不抢视线
        ctx.fillStyle = '#4c5058';
        const r = Math.max(1.6 * px, 0.02);
        ctx.fillRect(pr.at.x - r, pr.at.y - r, r * 2, r * 2);
      }
    }

    // 建筑：屋顶色填充 + 墙色描边 + 假投影。拖点时隐藏，避免显示上一帧的旧轮廓。
    //
    // 假投影是 R8 视觉复核加的：Planner 的体块是**大板楼**（一栋几百平米），
    // 而 legacy 是**一堆小房子**。同样一块屋顶色，大板楼读起来就是"一块铺装"，
    // 小房子读起来才像"房子" —— 因为没有厚度线索。
    // 沿右下方向压一层半透明深色，体块立刻立起来；这是纯表现层的事，
    // 不碰任何规划几何。
    if (!this.dragVertex) {
      const shadow = Math.max(0.6, 1.4 * px);
      for (const s of scene.solids) {
        if (!this.vis(layerOfSolid(s))) continue;
        ctx.save();
        ctx.translate(shadow, shadow);
        ctx.fillStyle = 'rgba(24, 22, 18, 0.20)';
        this.tracePath(s.ring);
        ctx.fill();
        ctx.restore();
      }
      for (const s of scene.solids) {
        if (!this.vis(layerOfSolid(s))) continue;
        ctx.fillStyle = css(s.roofMat);
        ctx.strokeStyle = css(s.wallMat);
        // 描边跟着体量走：大板楼的边缘要更实，否则和旁边的铺装糊在一起
        ctx.lineWidth = STROKE * px * (s.h > 1.4 ? 1.9 : 1.2);
        ctx.lineJoin = 'miter';
        this.tracePath(s.ring);
        ctx.fill();
        ctx.stroke();
      }
    }

    // ---- 道路结构覆盖：红线 / 中线 / 路口点
    // 这三样是"读懂路网规则"的关键：红线告诉你每条路占多宽、中线告诉你等级分布、
    // 路口点告诉你连通性（顺带把断头路标成红叉）。
    if (!this.override && (this.showCirExisting || this.showCirNew || this.showCirMerged || this.showCirPortals || this.showCirUnreachable)) {
      this.drawCirculationDebug(ctx, px);
    }

    if (!this.override && (this.showRedline || this.showCenterline || this.showJunctions)) {
      const net = this.roadNet();
      const hue: Record<string, string> = {
        arterial: '#c4553f',
        collector: '#2c6fbf',
        local: '#6f747c',
      };

      if (this.showRedline) {
        ctx.strokeStyle = 'rgba(196,84,63,0.75)';
        ctx.lineWidth = 0.9 * px;
        for (const e of net.edges) {
          const band = roadBand([e.a, e.b], e.insetL + e.insetR);
          if (!band) continue;
          this.tracePath(band);
          ctx.stroke();
        }
      }

      if (this.showCenterline) {
        ctx.lineCap = 'round';
        for (const e of net.edges) {
          ctx.strokeStyle = hue[e.cls] ?? hue.local;
          ctx.lineWidth = (e.cls === 'arterial' ? 1.1 : e.cls === 'collector' ? 0.85 : 0.6) * px * 1.4;
          ctx.beginPath();
          ctx.moveTo(e.a.x, e.a.y);
          ctx.lineTo(e.b.x, e.b.y);
          ctx.stroke();
        }
      }

      if (this.showJunctions) {
        const deg = new Map<Pt, number>();
        for (const e of net.edges) {
          deg.set(e.a, (deg.get(e.a) ?? 0) + 1);
          deg.set(e.b, (deg.get(e.b) ?? 0) + 1);
        }
        const r = 2.6 * px * 1.6;
        for (const [v, d] of deg) {
          if (d >= 3) {
            ctx.beginPath();
            ctx.arc(v.x, v.y, r, 0, Math.PI * 2);
            ctx.fillStyle = d >= 4 ? '#e0a02c' : '#f0d08a';
            ctx.fill();
            ctx.strokeStyle = 'rgba(30,26,22,0.55)';
            ctx.lineWidth = 0.7 * px;
            ctx.stroke();
          } else if (d === 1) {
            // 断头：红叉。这是"路网不完整"最直接的信号
            const k = r * 1.5;
            ctx.strokeStyle = '#c4553f';
            ctx.lineWidth = 1.5 * px * 1.6;
            ctx.beginPath();
            ctx.moveTo(v.x - k, v.y - k);
            ctx.lineTo(v.x + k, v.y + k);
            ctx.moveTo(v.x + k, v.y - k);
            ctx.lineTo(v.x - k, v.y + k);
            ctx.stroke();
          }
        }
      }
    }

    // 禁建区
    if (this.showZones) {
      for (const z of this.zones) {
        if (!z.enabled) continue;
        const ring = zoneToPolygon(z);
        this.tracePath(ring);
        ctx.fillStyle = 'rgba(196,84,63,0.20)';
        ctx.fill();
        ctx.strokeStyle = DANGER;
        ctx.lineWidth = 0.7 * px * 2;
        ctx.setLineDash([4 * px * 2, 3 * px * 2]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // 方向控制线：蓝紫双虚线 + 顺向箭头，表示"这一带的街道朝这个方向排"
    if (this.showGuides) {
      for (const g of this.guides) {
        const pts = g.pts;
        if (pts.length < 2) continue;
        ctx.globalAlpha = g.enabled ? 1 : 0.35;

        // 影响带：宽度 = 场源半径的两倍（两侧各一个 radius），让用户看到一条线管多宽
        const band = Math.max(this.model.cityRadius * 0.26, 8);
        ctx.strokeStyle = GUIDE_SOFT;
        ctx.lineWidth = band * 2;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.stroke();

        ctx.strokeStyle = GUIDE;
        ctx.lineWidth = 1.1 * px * 2;
        ctx.setLineDash([7 * px * 2, 4 * px * 2]);
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.stroke();
        ctx.setLineDash([]);

        // 顶点小方块
        ctx.fillStyle = GUIDE;
        for (const p of pts) {
          const s = 2.2 * px * 2;
          ctx.fillRect(p.x - s, p.y - s, s * 2, s * 2);
        }
        // 末端箭头：说明"顺向"，张量场是双向的，这里只作视觉指引
        const tip = pts[pts.length - 1];
        const prev = pts[pts.length - 2];
        const ang = Math.atan2(tip.y - prev.y, tip.x - prev.x);
        const L = 9 * px * 2;
        ctx.strokeStyle = GUIDE;
        ctx.lineWidth = 1.1 * px * 2;
        ctx.beginPath();
        ctx.moveTo(tip.x - Math.cos(ang - 0.42) * L, tip.y - Math.sin(ang - 0.42) * L);
        ctx.lineTo(tip.x, tip.y);
        ctx.lineTo(tip.x - Math.cos(ang + 0.42) * L, tip.y - Math.sin(ang + 0.42) * L);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    // 选中地块的高亮。放在场景图层**之后**画：先画会被楼和路面盖住，
    // 而用户点这块地的目的就是"我要改它"，选中态必须压在最上面。
    // 半透明填充 + 深色晕圈 + 亮线三遍，压在深色沥青和浅色铺装上都清楚。
    if (this.selPatch) {
      ctx.save();
      ctx.globalAlpha = 0.14;
      ctx.fillStyle = '#e0a02c';
      this.tracePath(this.selPatch.shape);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(18,14,10,0.78)';
      ctx.lineWidth = 4.2 * px;
      this.tracePath(this.selPatch.shape);
      ctx.stroke();
      ctx.strokeStyle = '#f5b73f';
      ctx.lineWidth = 1.9 * px;
      this.tracePath(this.selPatch.shape);
      ctx.stroke();
      ctx.restore();
    }

    // 选中的路：橙色铺满红线范围，侧栏的宽度滑杆改的就是它
    if (this.selectedArtery !== null && this.mode === 'select') this.drawRoadSelection(px);

    // 选中的禁绘区 / 方向线：橙色虚线 + 把手
    if (this.sel && this.mode === 'select') this.drawSelection(px);

    // 绘制中的形状
    if (this.draft) {
      const isGuide = this.draft.kind === 'guide';
      const ink = isGuide ? GUIDE : DANGER;
      ctx.strokeStyle = ink;
      ctx.lineWidth = 0.7 * px * 2;
      ctx.setLineDash([4 * px * 2, 3 * px * 2]);
      if (this.draft.kind === 'rect') {
        const a = this.draft.points[0];
        const b = this.draft.cursor ?? a;
        ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(a.x - b.x), Math.abs(a.y - b.y));
      } else if (this.draft.kind === 'circle') {
        const c = this.draft.points[0];
        const edge = this.draft.cursor ?? c;
        ctx.beginPath();
        ctx.arc(c.x, c.y, Pt.distance(c, edge), 0, Math.PI * 2);
        ctx.stroke();
      } else if (this.draft.kind === 'poly' || isGuide) {
        ctx.beginPath();
        const p = this.draft.points;
        ctx.moveTo(p[0].x, p[0].y);
        for (let i = 1; i < p.length; i++) ctx.lineTo(p[i].x, p[i].y);
        if (this.draft.cursor) ctx.lineTo(this.draft.cursor.x, this.draft.cursor.y);
        ctx.stroke();
        ctx.fillStyle = ink;
        for (const pt of p) {
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 3 * px * 2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.setLineDash([]);
    }

    // 拓扑点（只显示城内，城外地块太密且没意义）
    if (this.showVertices) {
      const cityVerts = new Set<Pt>();
      for (const patch of this.model.patches) {
        if (!patch.withinCity) continue;
        for (const v of patch.shape) cityVerts.add(v);
      }
      const r = 2.6 * px * 1.2;
      for (const v of cityVerts) {
        if (v === this.model.center) continue;
        const isHover = v === this.hoverVertex;
        const isDrag = v === this.dragVertex;
        ctx.beginPath();
        ctx.arc(v.x, v.y, isHover || isDrag ? r * 1.7 : r, 0, Math.PI * 2);
        ctx.fillStyle = isDrag ? DANGER : isHover ? '#e8c58a' : 'rgba(35,31,28,0.72)';
        ctx.fill();
        if (isHover || isDrag) {
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 0.4 * px * 2;
          ctx.stroke();
        }
      }
    }

    ctx.restore();

    // 工具条是 DOM，位置每次重绘跟着对象走（缩放/平移后就地改变）
    this.renderToolbar();
  }

  /**
   * 选中态：橙色虚线描出对象，按当前工具再画出支点或把手。
   *
   * 把手画成小方块而不是圆点：两条线交叉处圆点看着像路口，方块一眼就是"可拖的东西"。
   */  private drawSelection(px: number): void {
    const ring = this.selOutline();
    if (!ring || ring.length === 0) return;
    const ctx = this.ctx;
    const isGuide = this.sel?.kind === 'guide';

    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 2 * px;
    ctx.setLineDash([6 * px, 4 * px]);
    if (isGuide) {
      if (ring.length >= 2) {
        ctx.beginPath();
        ctx.moveTo(ring[0].x, ring[0].y);
        for (let i = 1; i < ring.length; i++) ctx.lineTo(ring[i].x, ring[i].y);
        ctx.stroke();
      }
    } else {
      this.tracePath(ring);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    const ctr = centerOf(ring);

    // 旋转 / 缩放：把支点画出来，否则用户不知道绕哪儿转
    if (this.tool === 'rotate' || this.tool === 'scale') {
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1 * px;
      ctx.beginPath();
      ctx.arc(ctr.x, ctr.y, 9 * px, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(ctr.x - 5 * px, ctr.y);
      ctx.lineTo(ctr.x + 5 * px, ctr.y);
      ctx.moveTo(ctr.x, ctr.y - 5 * px);
      ctx.lineTo(ctr.x, ctr.y + 5 * px);
      ctx.stroke();
    }

    // 改形状：顶点把手
    if (this.tool === 'shape') {
      const hs = this.selHandles();
      const r = 3.4 * px;
      for (const p of hs) {
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 1.4 * px;
        ctx.beginPath();
        ctx.rect(p.x - r, p.y - r, r * 2, r * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
  }


  private tracePath(poly: Array<Pt>): void {
    const ctx = this.ctx;
    ctx.beginPath();
    if (poly.length === 0) return;
    ctx.moveTo(poly[0].x, poly[0].y);
    for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
    ctx.closePath();
  }

  /**
   * 选中路的反馈：整条红线范围铺橙、中线打虚线。
   *
   * 只画中线不够 —— 用户调的是**红线宽**，要让他看见"这条路占多宽"，
   * 所以按 insetL+insetR 铺一条带，宽度一变带子立刻跟着变。
   */
  private drawRoadSelection(px: number): void {
    const e = this.roadEdge();
    if (!e) return;
    const ctx = this.ctx;
    const w = e.insetL + e.insetR;
    const band = roadBand([e.a, e.b], w);
    if (band) {
      ctx.fillStyle = 'rgba(217,140,74,0.30)';
      this.tracePath(band);
      ctx.fill();
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1.6 * px;
      this.tracePath(band);
      ctx.stroke();
    }
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.6 * px;
    ctx.setLineDash([5 * px, 4 * px]);
    ctx.beginPath();
    ctx.moveTo(e.a.x, e.a.y);
    ctx.lineTo(e.b.x, e.b.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}
