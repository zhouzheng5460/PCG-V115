// three.js 场景视图 —— **唯一**的视口。
//
// 两套相机共用同一个场景与同一份网格数据（`sceneToPrimitives`）：
//   · `persp` 透视 + 阴影 = "三维预览"
//   · `top`   正交俯视、关阴影 = 原来的"平面编辑"视角
//
// 为什么不再单独维护一个 Canvas 2D 渲染器：
//   一城 1.2 万个面 + 2200 栋楼，2D 那套每帧遍历全量要素、逐环描边，
//   缩放时要重画一遍描边宽度、选中断言还要再走一次；而三维视图本来就有
//   深度缓冲和实例化材质。两个渲染器 = 两份绘制成本 + 两套选中逻辑 +
//   两套显隐判定，且两者看到的东西总有一处不一致。
//   现在把"平面视图"降级成正交投影，**选中 / 高亮 / 标记全部落在三维场景里**
//   （见 overlayGroup），于是"看到的"和"导出的"永远是同一份几何。
//
// 交互（画禁区 / 画方向线 / 点选街区）都在这里做，因为只有它知道屏幕点
// 落在世界坐标的哪里；结果通过回调交给 app 层，不在视图里改业务状态。

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Pt } from '../core/geom';
import type { Scene } from '../scene/types';
import { sceneToPrimitives, type Primitive } from '../export/build3d';
import type { Zone, ZoneShape } from '../town/zones';

export type CameraMode = 'persp' | 'top';
export type Tool = 'select' | 'rect' | 'circle' | 'poly' | 'guide';

export interface BlockPick {
  id: string;
  ring: Pt[];
  use: string;
}

export type SelKind = 'block' | 'zone' | 'guide' | 'none';

export interface Handle {
  /** 调用方自己的语义 id，例如 `g1:2`（方向线 1 的第 2 个点） */
  id: string;
  at: Pt;
  /** 控制点类型，只影响颜色：顶点橙 / 旋转蓝 / 缩放绿 */
  kind?: 'point' | 'rotate' | 'scale' | 'move';
}

export interface View3DCallbacks {
  /** 点选：街区 / 禁区 / 方向线 */
  onSelect?: (sel: { kind: SelKind; id: string }) => void;
  onZoneDrawn?: (shape: ZoneShape) => void;
  onGuideDrawn?: (pts: Pt[]) => void;
  /** 拖动控制点：只改状态，不触发重建（重建由调用方在"应用"时做） */
  onHandleDrag?: (id: string, at: Pt) => void;
  onHandleDragEnd?: () => void;
  /** 右键点中某个控制点（用来删除节点） */
  onHandleDelete?: (id: string) => void;
  onStatus?: (text: string) => void;
}

const OVERLAY_Y = 0.9;

export class View3D {
  private container: HTMLElement;
  private cb: View3DCallbacks;
  private renderer: THREE.WebGLRenderer;
  private scene3 = new THREE.Scene();
  private persp: THREE.PerspectiveCamera;
  private ortho: THREE.OrthographicCamera;
  private controls: OrbitControls;
  private sun: THREE.DirectionalLight;
  private cityGroup = new THREE.Group();
  private overlayGroup = new THREE.Group();
  private draftGroup = new THREE.Group();
  private cameraMode: CameraMode = 'persp';
  private tool: Tool = 'select';
  private cityRadius = 100;
  private camReady = false;
  private dirty = true;
  private disposed = false;
  private raf = 0;
  private mats = new Map<string, THREE.MeshStandardMaterial>();

  // ---- 选中与拾取用的平面数据
  private blocks: BlockPick[] = [];
  private guides: { id: string; pts: Pt[]; enabled: boolean }[] = [];
  private zones: Zone[] = [];
  private zoneRings: { id: string; ring: Pt[] }[] = [];
  private selected: { kind: SelKind; id: string } = { kind: 'none', id: '' };
  private handles: Handle[] = [];
  /** 控制点的渲染对象（本体 + 描边），每帧按"屏幕像素大小恒定"重算缩放 */
  private handleMeshes: { mesh: THREE.Mesh; halo: THREE.Mesh; base: number }[] = [];
  /** 选中街区的切分方向（弧度），只用于画指示线 */
  private blockAxisRad: number | null = null;
  private handleGroup = new THREE.Group();
  private dragHandle: string | null = null;
  private selectionGroup = new THREE.Group();

  // ---- 绘制中的草稿
  private drafting = false;
  private dragStart: Pt | null = null;
  private dragNow: Pt | null = null;
  private polyPts: Pt[] = [];

  private hintCb: ((t: string) => void) | null = null;

  constructor(container: HTMLElement, cb: View3DCallbacks = {}) {
    this.container = container;
    this.cb = cb;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // 色调映射：不做这一步，半球光 + 主光 + 补光的强度直接相加，
    // 浅色建筑和铺装会一起过曝成一片白（截图里"整城发灰"就是这个）
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene3.background = new THREE.Color('#0f1115');
    this.scene3.fog = null;

    this.persp = new THREE.PerspectiveCamera(38, 1, 1, 6000);
    this.persp.position.set(120, 130, 150);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -2000, 4000);
    this.ortho.position.set(0, 400, 0);
    this.ortho.up.set(0, 0, -1);
    this.ortho.lookAt(0, 0, 0);

    this.controls = new OrbitControls(this.persp, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.1;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    /**
     * 屏幕空间平移。
     *
     * 默认（false）时 OrbitControls 用 `camera.up × 视线` 算平移方向；正交顶视里
     * up = (0,0,-1) 与视线近乎平行，叉积退化，于是只能水平拖、垂直拖不动
     * （用户反馈"顶视图平移只能水平"）。改成屏幕空间后，平移直接按屏幕的
     * 右 / 上两个方向走，透视与顶视都正常。
     */
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener('change', () => this.requestRender());

    // 强度按"朝上的平面刚好不过曝"配：主光 1.25×cos + 半球 0.5 ≈ 1.2，
    // 再交给 ACES 压高光。之前 1.75 + 0.85 会把铺装和屋顶一起推到纯白。
    const hemi = new THREE.HemisphereLight('#cfd8e6', '#2a2620', 0.5);
    this.scene3.add(hemi);

    this.sun = new THREE.DirectionalLight('#fff3dd', 1.25);
    this.sun.position.set(90, 160, 70);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const d = 220;
    this.sun.shadow.camera.left = -d;
    this.sun.shadow.camera.right = d;
    this.sun.shadow.camera.top = d;
    this.sun.shadow.camera.bottom = -d;
    this.sun.shadow.camera.far = 900;
    this.sun.shadow.bias = -0.0006;
    this.scene3.add(this.sun);

    const fill = new THREE.DirectionalLight('#8fa4c4', 0.3);
    fill.position.set(-110, 70, -90);
    this.scene3.add(fill);

    this.scene3.add(this.cityGroup, this.overlayGroup, this.selectionGroup, this.draftGroup, this.handleGroup);
    this.attachPointer();

    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.loop();
  }

  // ---------------------------------------------------------------- 渲染循环

  /** 只在"脏了"的时候出一帧：城市是静态的，没必要 60 fps 空转烧 GPU */
  requestRender(): void {
    this.dirty = true;
  }

  private loop = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    // 阻尼要每帧推进；相机一动 OrbitControls 就派发 'change'，把 dirty 置上
    this.controls.update();
    if (!this.dirty) return;
    this.updateHandleScale();
    this.dirty = false;
    this.renderer.render(this.scene3, this.camera());
  };

  private camera(): THREE.Camera {
    return this.cameraMode === 'top' ? this.ortho : this.persp;
  }

  private resize(): void {
    const rect = this.container.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    this.renderer.setSize(w, h, false);
    const aspect = w / h;
    this.persp.aspect = aspect;
    this.persp.updateProjectionMatrix();
    this.updateOrthoFrustum(aspect);
    this.requestRender();
  }

  private updateOrthoFrustum(aspect = this.renderer.domElement.clientWidth / Math.max(1, this.renderer.domElement.clientHeight)): void {
    // 取景高度 = 城市直径 × 0.62：全城刚好占满画面，四周留一点边
    const halfH = Math.max(12, this.cityRadius * 1.28);
    const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1.6;
    this.ortho.left = -halfH * a;
    this.ortho.right = halfH * a;
    this.ortho.top = halfH;
    this.ortho.bottom = -halfH;
    this.ortho.near = -3000;
    this.ortho.far = 6000;
    this.ortho.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------- 场景装配

  setScene(scene: Scene, opts: { layers?: (id: string) => boolean; hiliteLotRoad?: boolean; cityRadius?: number } = {}): void {
    this.clearCity();
    const radius = opts.cityRadius ?? 100;
    this.cityRadius = radius;
    const prims = sceneToPrimitives(scene, {
      layers: opts.layers as never,
      hiliteLotRoad: opts.hiliteLotRoad,
      cityRadius: radius,
    });
    this.buildMeshes(prims);
    this.updateOrthoFrustum();

    // 地面接收阴影的底盘
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(radius * 1.9, 64),
      new THREE.MeshStandardMaterial({ color: '#171a1f', roughness: 1 })
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = -0.35;
    disc.receiveShadow = true;
    this.cityGroup.add(disc);

    if (!this.camReady) {
      this.fitAll();
      this.camReady = true;
    }
    this.persp.far = Math.max(radius * 40, 1200);
    this.persp.updateProjectionMatrix();
    this.requestRender();
  }

  private buildMeshes(prims: Primitive[]): void {
    for (const prim of prims) {
      if (!prim || prim.indices.length === 0) continue;
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.Float32BufferAttribute(prim.positions, 3));
      geom.setAttribute('normal', new THREE.Float32BufferAttribute(prim.normals, 3));
      geom.setIndex(prim.indices);

      const key = prim.color.join(',');
      let mat = this.mats.get(key);
      if (!mat) {
        mat = new THREE.MeshStandardMaterial({
          color: new THREE.Color(prim.color[0], prim.color[1], prim.color[2]),
          roughness: 0.94,
          metalness: 0,
          side: prim.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
        });
        this.mats.set(key, mat);
      }
      const mesh = new THREE.Mesh(geom, mat);
      // 只让有体积、且不是街道贴地件的要素投影：标线投出来是放射状黑刺
      const flat = prim.group === 'ground' || prim.group === 'street' || prim.group.startsWith('road/');
      mesh.castShadow = !flat;
      mesh.receiveShadow = true;
      mesh.name = prim.name;
      mesh.userData.group = prim.group;
      this.cityGroup.add(mesh);
    }
  }

  private clearCity(): void {
    for (const child of this.cityGroup.children.slice()) {
      this.cityGroup.remove(child);
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose();
    }
    // 材质留在缓存里复用（城市重生成上千个网格，不复用会把 GPU 上的程序重新编译一遍）
  }

  // ---------------------------------------------------------------- 相机

  setCameraMode(mode: CameraMode): void {
    if (this.cameraMode === mode) return;
    const prev = this.camera();
    const target = this.controls.target.clone();
    this.cameraMode = mode;

    const cam = this.camera();
    if (mode === 'top') {
      // 保持平面中心：俯视时屏幕上的"上下"就是地图的 −y → +y
      this.ortho.zoom = Math.max(0.4, Math.min(4, this.ortho.zoom));
      this.ortho.position.set(target.x, 600, target.z);
      this.ortho.up.set(0, 0, -1);
      this.ortho.lookAt(target.x, 0, target.z);
      this.controls.object = this.ortho;
      this.controls.enableRotate = false;
      this.controls.enablePan = true;
      // 顶视必须用屏幕空间平移（否则垂直方向拖不动，见构造函数里的说明）
      this.controls.screenSpacePanning = true;
      // 俯视没有阴影，全靠明暗关系读图：曝光压一档，路面 / 铺装 / 草地的分层才看得出来
      this.renderer.toneMappingExposure = 0.8;
      this.setShadows(false);
    } else {
      this.persp.position.copy(prev.position);
      this.controls.object = this.persp;
      this.controls.enableRotate = true;
      // 透视回到"沿地面平移"：3/4 视角下这才是城市编辑器该有的手感
      this.controls.screenSpacePanning = false;
      this.renderer.toneMappingExposure = 0.95;
      this.setShadows(true);
    }
    this.controls.target.copy(target);
    this.controls.update();
    this.requestRender();
  }

  getCameraMode(): CameraMode {
    return this.cameraMode;
  }

  private setShadows(on: boolean): void {
    if (this.renderer.shadowMap.enabled === on) return;
    this.renderer.shadowMap.enabled = on;
    this.sun.castShadow = on;
    // 开关 shadowMap 后材质要重新编译，否则光照里还留着阴影采样
    for (const m of this.mats.values()) m.needsUpdate = true;
  }

  /** 全城取景 */
  fitAll(): void {
    const r = this.cityRadius || 100;
    const dist = r * 2.05;
    if (this.cameraMode === 'persp') {
      this.persp.position.set(dist * 0.62, dist * 0.72, dist * 0.78);
      this.controls.target.set(0, 0, 0);
    } else {
      this.ortho.position.set(0, 600, 0);
      this.ortho.lookAt(0, 0, 0);
      this.controls.target.set(0, 0, 0);
      this.ortho.zoom = 1;
    }
    this.controls.update();
    this.requestRender();
  }

  /** 把镜头对准某个平面坐标（2D 的 x / y 就是三维的 x / z） */
  /**
   * 把镜头对准某个平面坐标，并让"尺寸为 `size` 的东西"占画面的 `fill` 比例。
   *
   * 以前是按一个含糊的 `span`（取景高度）算的，调用方给 `rad * 1.7`，
   * 结果选中地块几乎顶满画面（用户："聚焦离得太近"）。现在改成按
   * **占视窗比例**反算：
   *   · 顶视（正交）：可见高度 = size / fill，zoom = 视锥高度 / 可见高度
   *   · 透视：距离 = 可见高度 / (2·tan(fov/2))
   * 这样无论正交还是透视、无论地块多大，选中物都稳定占 `fill`（默认 30%）。
   */
  focusOn(x: number, y: number, size = 60, fill = 0.3): void {
    const r = this.cityRadius || 100;
    const needH = Math.max(6, size / Math.max(0.05, fill));
    if (this.cameraMode === 'top') {
      this.ortho.position.set(x, 600, y);
      this.ortho.lookAt(x, 0, y);
      this.controls.target.set(x, 0, y);
      const frustumH = 2 * Math.max(12, r * 1.28);
      this.ortho.zoom = Math.max(0.4, Math.min(24, frustumH / needH));
      this.ortho.updateProjectionMatrix();
      this.controls.update();
      this.requestRender();
      return;
    }
    const persp = this.persp;
    const d = needH / (2 * Math.tan((persp.fov * Math.PI) / 360));
    const off = persp.position.clone().sub(this.controls.target);
    const len = off.length() || d;
    off.multiplyScalar(d / len);
    this.controls.target.set(x, 0, y);
    persp.position.set(x + off.x, Math.max(off.y, d * 0.45), y + off.z);
    this.controls.update();
    this.requestRender();
  }

  // ---------------------------------------------------------------- 覆盖层：选中 / 禁区 / 方向线

  setBlocks(blocks: BlockPick[]): void {
    this.blocks = blocks;
  }

  setZones(zones: Zone[], rings: { id: string; ring: Pt[] }[]): void {
    this.zones = zones;
    this.zoneRings = rings;
    this.rebuildOverlay();
  }

  setGuides(list: { id: string; pts: Pt[]; enabled: boolean }[]): void {
    this.guides = list;
    this.rebuildOverlay();
  }

  /**
   * 控制点（禁区角点 / 圆心 / 半径点 / 方向线折点）。
   *
   * 只在"选中某个对象"时给——控制点太多会盖住图，也会让点选变难。
   * 拖动只回调 `onHandleDrag`，**不触发重建**：生成是 2~5 s 的事，
   * 边拖边算会把界面拖死（用户明确要求编辑与重建分离）。
   */
  setHandles(list: Handle[]): void {
    this.handles = list;
    this.handleMeshes = [];
    for (const c of this.handleGroup.children.slice()) {
      this.handleGroup.remove(c);
      const m = c as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose();
    }
    /**
     * 控制点的几何半径固定为 1，实际大小由 `updateHandleScale()` 每帧按
     * **屏幕像素**换算 —— 否则拉近镜头时球会变成大圆饼（用户："点太大了"）。
     */
    const r = 1;
    const COLOR = { point: 0xffb066, rotate: 0x63a2ff, scale: 0x6ddc9a, move: 0xffe066 } as const;
    for (const h of list) {
      const rr = h.kind && h.kind !== 'point' ? r * 1.15 : r;
      /**
       * 每个控制点带一圈**深色描边**。
       *
       * 之前"移动一次白点就不见了"不是逻辑问题，是可见性问题：白点在浅色铺装/草地上
       * 白压白，看着就像消失了。现在先画一个 1.7 倍的深色球当描边，再画本体，
       * 无论下面是沥青、草还是硬质底都能看清。
       */
      /**
       * 描边必须**不透明**：three.js 先画不透明队列、再画透明队列，
       * 半透明的描边会整体盖在实心球上面（试过 opacity 0.85，结果所有控制点变成黑点）。
       */
      const halo = new THREE.Mesh(
        new THREE.SphereGeometry(rr * 1.55, 12, 10),
        new THREE.MeshBasicMaterial({ color: 0x14161a, depthTest: false })
      );
      halo.position.set(h.at.x, OVERLAY_Y + 0.44, h.at.y);
      halo.renderOrder = 6;
      this.handleGroup.add(halo);

      const mat = new THREE.MeshBasicMaterial({ color: COLOR[h.kind ?? 'point'], depthTest: false });
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(rr, 12, 10), mat);
      mesh.position.set(h.at.x, OVERLAY_Y + 0.45, h.at.y);
      mesh.renderOrder = 7;
      this.handleGroup.add(mesh);
      this.handleMeshes.push({ mesh, halo, base: h.kind && h.kind !== 'point' ? 1.15 : 1 });
    }
    this.updateHandleScale();
    this.requestRender();
  }

  /**
   * 控制点尺寸 = **屏幕像素恒定**（半径约 7 px）。
   *
   * 三维球体是透视投影：不按距离缩放的话，拉近镜头直径能到几十像素，
   * 拉远又小得看不见。顶视（正交）用 `视口高度 / zoom` 换算，
   * 透视用"该点到相机的距离 × 视锥比例"。命中测试也用同一个半径。
   */
  private updateHandleScale(): void {
    if (this.handleMeshes.length === 0) return;
    const dom = this.renderer.domElement;
    const h = Math.max(1, dom.clientHeight);
    const PX = 7;
    const cam = this.camera();
    if (this.cameraMode === 'top') {
      const worldPerPx = (this.ortho.top - this.ortho.bottom) / this.ortho.zoom / h;
      const s = PX * worldPerPx;
      for (const hm of this.handleMeshes) {
        hm.mesh.scale.setScalar(s * hm.base);
        hm.halo.scale.setScalar(s * hm.base);
      }
      return;
    }
    const persp = cam as THREE.PerspectiveCamera;
    const tan = Math.tan((persp.fov * Math.PI) / 360);
    for (const hm of this.handleMeshes) {
      const dist = persp.position.distanceTo(hm.mesh.position);
      const worldPerPx = (2 * dist * tan) / h;
      const s = PX * worldPerPx;
      hm.mesh.scale.setScalar(s * hm.base);
      hm.halo.scale.setScalar(s * hm.base);
    }
  }

  /** 世界点 → 画布像素（控制点命中用，阈值按像素算） */
  private screenOf(p: Pt, y = OVERLAY_Y): { x: number; y: number } {
    const dom = this.renderer.domElement;
    const v = new THREE.Vector3(p.x, y, p.y).project(this.camera());
    return { x: ((v.x + 1) / 2) * dom.clientWidth, y: ((1 - v.y) / 2) * dom.clientHeight };
  }

  private hitHandle(ev: PointerEvent): string | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const sx = ev.clientX - rect.left;
    const sy = ev.clientY - rect.top;
    let best: string | null = null;
    // 命中范围 = 视觉半径 7 px + 6 px 容差
    let bestD = 13;
    for (const h of this.handles) {
      const sp = this.screenOf(h.at);
      const d = Math.hypot(sp.x - sx, sp.y - sy);
      if (d < bestD) {
        bestD = d;
        best = h.id;
      }
    }
    return best;
  }

  /** 选中街区的切分方向（面板滑杆改动时同步，画一条虚线指示） */
  setBlockAxis(rad: number | null): void {
    this.blockAxisRad = rad;
    if (this.selected.kind === 'block') this.rebuildSelection();
  }

  setSelection(sel: { kind: SelKind; id: string }): void {
    this.selected = sel;
    if (sel.kind === 'none') {
      this.setHandles([]);
      this.blockAxisRad = null;
    }
    this.rebuildSelection();
  }

  private rebuildSelection(): void {
    for (const c of this.selectionGroup.children.slice()) {
      this.selectionGroup.remove(c);
      const any = c as THREE.Mesh;
      any.geometry?.dispose();
    }
    if (this.selected.kind === 'none') {
      this.requestRender();
      return;
    }
    if (this.selected.kind === 'guide') {
      const g = this.guides.find((q) => q.id === this.selected.id);
      if (g && g.pts.length >= 2) {
        const pos: number[] = [];
        for (const p of g.pts) pos.push(p.x, OVERLAY_Y + 0.25, p.y);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        this.selectionGroup.add(new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffb066, depthTest: false })));
      }
      this.requestRender();
      return;
    }
    const ring =
      this.selected.kind === 'block'
        ? this.blocks.find((b) => b.id === this.selected.id)?.ring
        : this.zoneRings.find((z) => z.id === this.selected.id)?.ring;
    if (!ring || ring.length < 3) {
      this.requestRender();
      return;
    }
    // 禁区选中时淡一点：它内部有切分内容，盖太厚就看不见了
    this.selectionGroup.add(this.ringFill(ring, 1.15, 0x2f6df6, this.selected.kind === 'zone' ? 0.12 : 0.26));
    this.selectionGroup.add(this.ringLine(ring, 1.2, 0x63a2ff));
    if (this.selected.kind === 'block') {
      // 切分方向指示：穿过街区质心的一条长线（面板上调方向时能直接看到）
      let cx = 0;
      let cy = 0;
      for (const p of ring) {
        cx += p.x;
        cy += p.y;
      }
      cx /= ring.length;
      cy /= ring.length;
      const span = Math.max(...ring.map((p) => Math.hypot(p.x - cx, p.y - cy))) * 1.15;
      const d = this.blockAxisRad ?? 0;
      const pos = [cx - Math.cos(d) * span, 1.3, cy - Math.sin(d) * span, cx + Math.cos(d) * span, 1.3, cy + Math.sin(d) * span];
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const line = new THREE.Line(geo, new THREE.LineDashedMaterial({ color: 0xffd0a0, dashSize: 1.6, gapSize: 1.1, depthTest: false }));
      line.computeLineDistances();
      this.selectionGroup.add(line);
    }
    this.requestRender();
  }

  private rebuildOverlay(): void {
    for (const c of this.overlayGroup.children.slice()) {
      this.overlayGroup.remove(c);
      const any = c as THREE.Mesh;
      any.geometry?.dispose();
    }
    // 禁区：半透明红面 + 轮廓（强调"这里什么都不长"）
    for (const z of this.zones) {
      if (z.enabled === false) continue;
      const ring = this.zoneRings.find((q) => q.id === z.id)?.ring;
      if (!ring || ring.length < 3) continue;
      this.overlayGroup.add(this.ringFill(ring, OVERLAY_Y, 0xc4553f, 0.2));
      this.overlayGroup.add(this.ringLine(ring, OVERLAY_Y + 0.05, 0xe86a4f));
    }
    // 方向线：蓝线 + 折点
    for (const g of this.guides) {
      if (!g.enabled || g.pts.length < 2) continue;
      const pos: number[] = [];
      for (const p of g.pts) pos.push(p.x, OVERLAY_Y + 0.2, p.y);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x4a86ff }));
      this.overlayGroup.add(line);
      for (const p of g.pts) {
        const dot = new THREE.Mesh(
          new THREE.SphereGeometry(Math.max(0.55, this.cityRadius * 0.006), 10, 8),
          new THREE.MeshBasicMaterial({ color: 0x9dc0ff })
        );
        dot.position.set(p.x, OVERLAY_Y + 0.2, p.y);
        this.overlayGroup.add(dot);
      }
    }
    this.requestRender();
  }

  /** 环 → 半透明贴地面（ShapeGeometry 需要把 y 取反，见文件头坐标约定） */
  private ringFill(ring: Pt[], y: number, color: number, opacity: number): THREE.Mesh {
    const shape = new THREE.Shape(ring.map((p) => new THREE.Vector2(p.x, -p.y)));
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = y;
    mesh.renderOrder = 3;
    return mesh;
  }

  /** 环 → 闭合线框 */
  private ringLine(ring: Pt[], y: number, color: number): THREE.Line {
    const pos: number[] = [];
    for (const p of ring) pos.push(p.x, y, p.y);
    pos.push(ring[0].x, y, ring[0].y);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, depthTest: false }));
    line.renderOrder = 4;
    return line;
  }

  // ---------------------------------------------------------------- 工具与拾取

  setTool(tool: Tool): void {
    this.tool = tool;
    this.drafting = false;
    this.dragStart = null;
    this.dragNow = null;
    this.polyPts = [];
    this.clearDraft();
    this.controls.enabled = tool === 'select';
    this.renderer.domElement.style.cursor = tool === 'select' ? 'default' : 'crosshair';
    this.hint(this.defaultHint());
  }

  /** app 层可以接管提示条（例如"已选中 B12"） */
  setHintHook(cb: (t: string) => void): void {
    this.hintCb = cb;
  }

  private hint(t: string): void {
    if (this.hintCb) this.hintCb(t);
    else this.cb.onStatus?.(t);
  }

  private defaultHint(): string {
    switch (this.tool) {
      case 'rect':
        return '在图上拖出一个矩形禁区 · Esc 取消';
      case 'circle':
        return '按住左键，从圆心拖出半径 · Esc 取消';
      case 'poly':
        return '依次点击顶点，双击（或点回起点）闭合 · Esc 取消';
      case 'guide':
        return '沿街道希望走的方向依次点击，双击结束 · Esc 取消';
      default:
        return this.cameraMode === 'top' ? '左键点选街区 · 拖拽平移 · 滚轮缩放' : '左键点选街区 · 拖拽旋转 · 右键平移 · 滚轮缩放';
    }
  }

  private ndc(ev: PointerEvent): { x: number; y: number } {
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: ((ev.clientX - r.left) / r.width) * 2 - 1, y: -((ev.clientY - r.top) / r.height) * 2 + 1 };
  }

  /** 屏幕点 → 地面（y = 0）上的世界坐标 */
  private groundAt(ev: PointerEvent): Pt | null {
    const { x, y } = this.ndc(ev);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(x, y), this.camera());
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hit = new THREE.Vector3();
    if (!ray.ray.intersectPlane(plane, hit)) return null;
    return new Pt(hit.x, hit.z);
  }

  private attachPointer(): void {
    const dom = this.renderer.domElement;
    dom.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (this.tool !== 'select') return;
      const id = this.hitHandle(e as unknown as PointerEvent);
      if (id) this.cb.onHandleDelete?.(id);
    });

    dom.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      // 控制点优先：命中就进入拖拽，同时把 OrbitControls 关掉（否则会一起转镜头）
      if (this.tool === 'select') {
        const hid = this.hitHandle(ev);
        if (hid) {
          this.dragHandle = hid;
          this.controls.enabled = false;
          dom.setPointerCapture(ev.pointerId);
          this.requestRender();
          return;
        }
      }
      const at = this.groundAt(ev);
      if (!at) return;
      if (this.tool === 'select') return; // 交给 OrbitControls

      if (this.tool === 'rect' || this.tool === 'circle') {
        this.drafting = true;
        this.dragStart = at;
        this.dragNow = at;
        dom.setPointerCapture(ev.pointerId);
      } else {
        // 折线 / 方向线：点一下加一个点，点回起点或双击闭合
        const first = this.polyPts[0];
        if (this.polyPts.length >= (this.tool === 'poly' ? 3 : 2) && first && Pt.distance(first, at) < this.cityRadius * 0.02) {
          this.finishPath();
          return;
        }
        const prev = this.polyPts[this.polyPts.length - 1];
        if (!prev || Pt.distance(prev, at) > Math.max(1.2, this.cityRadius * 0.015)) {
          this.polyPts.push(at);
          this.paintDraft();
        }
      }
    });

    dom.addEventListener('pointermove', (ev) => {
      if (this.dragHandle) {
        const at = this.groundAt(ev);
        if (at) this.cb.onHandleDrag?.(this.dragHandle, at);
        return;
      }
      if (!this.drafting || !this.dragStart) return;
      const at = this.groundAt(ev);
      if (!at) return;
      this.dragNow = at;
      this.paintDraft();
    });

    dom.addEventListener('pointerup', (ev) => {
      if (this.dragHandle) {
        this.dragHandle = null;
        this.controls.enabled = this.tool === 'select';
        this.cb.onHandleDragEnd?.();
        this.requestRender();
        return;
      }
      if (!this.drafting || !this.dragStart || !this.dragNow) return;
      this.drafting = false;
      const a = this.dragStart;
      const b = this.dragNow;
      this.dragStart = null;
      this.dragNow = null;
      this.clearDraft();
      const minU = Math.max(1.2, this.cityRadius * 0.02);
      if (this.tool === 'rect') {
        if (Math.abs(b.x - a.x) < minU || Math.abs(b.y - a.y) < minU) {
          this.hint('矩形太小了，重画一个');
          return;
        }
        this.cb.onZoneDrawn?.({ kind: 'rect', a, b });
      } else if (this.tool === 'circle') {
        const r = Pt.distance(a, b);
        if (r < minU) {
          this.hint('半径太小了，重画一个');
          return;
        }
        this.cb.onZoneDrawn?.({ kind: 'circle', c: a, r });
      }
      void ev;
    });

    dom.addEventListener('dblclick', () => {
      if (this.tool === 'poly' || this.tool === 'guide') this.finishPath();
    });

    // 点选：只有 select 工具、且没在拖动时才拾取（OrbitControls 转完镜头不算点选）
    let down: { x: number; y: number } | null = null;
    dom.addEventListener('pointerdown', (ev) => {
      if (this.tool !== 'select' || ev.button !== 0) return;
      // 正在拖控制点：这次按下不是"点选"，别把它记成一次点击
      if (this.dragHandle) return;
      down = { x: ev.clientX, y: ev.clientY };
    });
    dom.addEventListener('pointerup', (ev) => {
      if (this.tool !== 'select' || ev.button !== 0 || !down) return;
      const moved = Math.hypot(ev.clientX - down.x, ev.clientY - down.y);
      down = null;
      if (moved > 4) return;
      const at = this.groundAt(ev);
      if (at) this.pickAt(at);
    });
  }

  private pickAt(at: Pt): void {
    // 禁区优先：它在图上是最强的"这里不能动"的标记
    const zr = this.zoneRings.find((z) => {
      const zone = this.zones.find((q) => q.id === z.id);
      return zone?.enabled !== false && pointInRing(at, z.ring);
    });
    if (zr) {
      this.cb.onSelect?.({ kind: 'zone', id: zr.id });
      return;
    }
    // 方向线：按"到折线的距离"拾取（线本身很细，纯点内测试点不中）
    const g = this.guides.find((q) => q.enabled && q.pts.length >= 2 && distToPolyline(at, q.pts) < Math.max(2.2, this.cityRadius * 0.03));
    if (g) {
      this.cb.onSelect?.({ kind: 'guide', id: g.id });
      return;
    }
    const blk = this.blocks.find((b) => pointInRing(at, b.ring));
    if (blk) {
      this.cb.onSelect?.({ kind: 'block', id: blk.id });
      return;
    }
    this.cb.onSelect?.({ kind: 'none', id: '' });
  }

  private finishPath(): void {
    const need = this.tool === 'poly' ? 3 : 2;
    if (this.polyPts.length < need) {
      this.hint(this.tool === 'poly' ? '多边形至少 3 个点' : '方向线至少 2 个点');
      return;
    }
    const pts = this.polyPts.slice();
    this.polyPts = [];
    this.clearDraft();
    if (this.tool === 'poly') this.cb.onZoneDrawn?.({ kind: 'poly', pts });
    else this.cb.onGuideDrawn?.(pts);
  }

  cancelDraft(): void {
    this.drafting = false;
    this.dragStart = null;
    this.dragNow = null;
    this.polyPts = [];
    this.clearDraft();
  }

  private clearDraft(): void {
    for (const c of this.draftGroup.children.slice()) {
      this.draftGroup.remove(c);
      const any = c as THREE.Mesh;
      any.geometry?.dispose();
      const mat = any.material as THREE.Material | undefined;
      mat?.dispose();
    }
    this.requestRender();
  }

  private paintDraft(): void {
    this.clearDraft();
    const color = 0xff8a4f;
    if (this.drafting && this.dragStart && this.dragNow) {
      const a = this.dragStart;
      const b = this.dragNow;
      if (this.tool === 'rect') {
        const ring = [new Pt(a.x, a.y), new Pt(b.x, a.y), new Pt(b.x, b.y), new Pt(a.x, b.y)];
        this.draftGroup.add(this.ringFill(ring, OVERLAY_Y + 0.1, color, 0.22));
        this.draftGroup.add(this.ringLine(ring, OVERLAY_Y + 0.15, color));
      } else {
        const r = Pt.distance(a, b);
        const ring: Pt[] = [];
        for (let i = 0; i < 48; i++) {
          const ang = (i / 48) * Math.PI * 2;
          ring.push(new Pt(a.x + Math.cos(ang) * r, a.y + Math.sin(ang) * r));
        }
        this.draftGroup.add(this.ringFill(ring, OVERLAY_Y + 0.1, color, 0.22));
        this.draftGroup.add(this.ringLine(ring, OVERLAY_Y + 0.15, color));
      }
    }
    if (this.polyPts.length) {
      const pos: number[] = [];
      for (const p of this.polyPts) pos.push(p.x, OVERLAY_Y + 0.15, p.y);
      if (this.polyPts.length >= 2) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        this.draftGroup.add(new THREE.Line(geo, new THREE.LineBasicMaterial({ color })));
      }
      for (const p of this.polyPts) {
        const dot = new THREE.Mesh(
          new THREE.SphereGeometry(Math.max(0.4, this.cityRadius * 0.005), 8, 6),
          new THREE.MeshBasicMaterial({ color: 0xffd0a8 })
        );
        dot.position.set(p.x, OVERLAY_Y + 0.15, p.y);
        this.draftGroup.add(dot);
      }
      if (this.tool === 'poly' && this.polyPts.length >= 3) {
        this.draftGroup.add(this.ringLine(this.polyPts, OVERLAY_Y + 0.12, 0xffc59a));
      }
    }
    this.requestRender();
  }

  // ---------------------------------------------------------------- 其他

  /** 导出前取一张快照（自检 / 报告用） */
  snapshot(): string {
    this.renderer.render(this.scene3, this.camera());
    return this.renderer.domElement.toDataURL('image/png');
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.clearCity();
    for (const m of this.mats.values()) m.dispose();
    this.renderer.dispose();
  }
}

/** 点到折线的最短距离（世界单位） */
function distToPolyline(p: Pt, pts: Pt[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L2 = dx * dx + dy * dy;
    const t = L2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
    best = Math.min(best, Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)));
  }
  return best;
}

/** 点是否在多边形内（射线法，用于地面拾取） */
export function pointInRing(p: Pt, ring: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y || 1e-12) + a.x) inside = !inside;
  }
  return inside;
}
