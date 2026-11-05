// three.js 三维预览：与 GLB 使用同一套网格数据（buildTownMeshes）

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Model } from '../town/model';
import { buildTownMeshes, type Primitive } from '../export/build3d';
import type { PlanningMode } from '../scene/planner-bridge';

export class View3D {
  private container: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  /** 相机是否已经给过默认机位（重建场景时不再重置） */
  private camReady = false;
  /** 城市半径（聚焦时用来估算距离） */
  private cityRadius = 100;
  private controls: OrbitControls;
  private group = new THREE.Group();
  private raf = 0;
  private disposed = false;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color('#101216');
    this.scene.fog = new THREE.Fog('#101216', 260, 620);

    this.camera = new THREE.PerspectiveCamera(38, 1, 1, 4000);
    this.camera.position.set(120, 130, 150);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.target.set(0, 0, 0);

    // 光
    const hemi = new THREE.HemisphereLight('#cfd8e6', '#2a2620', 1.05);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight('#fff3dd', 2.1);
    sun.position.set(90, 160, 70);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const d = 180;
    sun.shadow.camera.left = -d;
    sun.shadow.camera.right = d;
    sun.shadow.camera.top = d;
    sun.shadow.camera.bottom = -d;
    sun.shadow.camera.far = 620;
    sun.shadow.bias = -0.0008;
    this.scene.add(sun);

    const fill = new THREE.DirectionalLight('#8fa4c4', 0.45);
    fill.position.set(-110, 70, -90);
    this.scene.add(fill);

    this.scene.add(this.group);

    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.loop();
  }

  private resize(): void {
    const rect = this.container.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private loop = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  setModel(
    model: Model,
    opts: {
      heightScale?: number;
      markings?: boolean;
      furniture?: boolean;
      layers?: (id: string) => boolean;
      /** 规划模式（R8）：planner / shadow 走 Planner 链路 */
      planningMode?: PlanningMode;
      /** 高亮地块内部道路（与 2D 同一套判定） */
      hiliteLotRoad?: boolean;
      /** R1.4 内部交通开关：off / golden / all */
      circulation?: 'off' | 'golden' | 'all';
      /** S1 场地布局骨架：off / golden / all */
      s1?: 'off' | 'golden' | 'all';
      pattern?: 'off' | 'golden' | 'all';
      parkingProvider?: 'legacy' | 'placemaker' | 'compare';
    } = {}
  ): void {
    this.clear();

    const prims = buildTownMeshes(model, {
      heightScale: opts.heightScale ?? 1,
      markings: opts.markings ?? true,
      furniture: opts.furniture ?? true,
      layers: opts.layers,
      planningMode: opts.planningMode ?? 'legacy',
      hiliteLotRoad: opts.hiliteLotRoad ?? false,
      circulation: opts.circulation ?? 'all',
      s1: opts.s1 ?? 'off',
      pattern: opts.pattern ?? 'off',
      parkingProvider: opts.parkingProvider ?? 'legacy',
    });
    const matCache = new Map<string, THREE.MeshStandardMaterial>();

    for (const prim of prims) {
      if (!prim || prim.indices.length === 0) continue;
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.Float32BufferAttribute(prim.positions, 3));
      geom.setAttribute('normal', new THREE.Float32BufferAttribute(prim.normals, 3));
      geom.setIndex(prim.indices);

      const key = prim.color.join(',');
      let mat = matCache.get(key);
      if (!mat) {
        mat = new THREE.MeshStandardMaterial({
          color: new THREE.Color(prim.color[0], prim.color[1], prim.color[2]),
          roughness: 0.94,
          metalness: 0,
        });
        matCache.set(key, mat);
      }
      const mesh = new THREE.Mesh(geom, mat);
      mesh.castShadow = prim.group !== 'ground' && prim.group !== 'street' && prim.group !== 'plaza';
      mesh.receiveShadow = true;
      mesh.name = prim.name;
      mesh.userData.group = prim.group;
      this.group.add(mesh);
    }

    // 地面接收阴影的底盘
    const radius = model.cityRadius || 100;
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(radius * 1.9, 64),
      new THREE.MeshStandardMaterial({ color: '#1c1f24', roughness: 1 })
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = -0.35;
    disc.receiveShadow = true;
    this.group.add(disc);

    // 相机只在**第一次**建场景时定位。
    //
    // 原来每次 build（切页签、改任意参数都会重建）都把 target 拉回原点、
    // 相机推回默认机位 —— 用户转好的视角一转眼就重置了。
    // 现在只在 `camReady` 为假时给默认机位；之后重建只更新近远裁剪面。
    this.cityRadius = radius;
    if (!this.camReady) {
      this.controls.target.set(0, 0, 0);
      const dist = radius * 2.6;
      this.camera.position.set(dist * 0.62, dist * 0.72, dist * 0.78);
      this.camReady = true;
    }
    this.camera.near = 1;
    this.camera.far = Math.max(radius * 40, 1200);
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  /**
   * 把镜头对准某个平面坐标（2D 的 x / y 就是三维的 x / z）。
   *
   * 只平移机位，不改变俯仰角 —— 用户在平面里点了一块地，切到三维就是想
   * 从同一个角度看这块地，而不是被换成一个新的观察角度。
   */
  focusOn(x: number, y: number, span?: number): void {
    const r = this.cityRadius || 100;
    const d = span ?? Math.max(r * 0.55, 30);
    const off = this.camera.position.clone().sub(this.controls.target);
    const len = off.length() || d;
    off.multiplyScalar(d / len);
    this.controls.target.set(x, 0, y);
    this.camera.position.set(x + off.x, Math.max(off.y, d * 0.35), y + off.z);
    this.controls.update();
  }

  private clear(): void {
    for (const child of this.group.children.slice()) {
      this.group.remove(child);
      const mesh = child as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    }
  }

  /** 导出用：返回与预览一致的网格数据 */
  static meshes(model: Model, opts: { heightScale?: number } = {}): Primitive[] {
    return buildTownMeshes(model, opts);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.clear();
    this.renderer.dispose();
  }
}
