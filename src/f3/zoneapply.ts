// 禁区的**局部**作用：在城市生成完之后，只改禁区影响到的那些地块。
//
// 之前禁区的做法是"生成前把它从城市边界里扣掉"，于是一改禁区就整城重算，
// 路网、所有街区、所有建筑全都跟着动 —— 用户看到的却是"我只动了一小块"，
// 而且 2~6 s 的等待全花在没被影响的部分上。
//
// 现在改成后处理：
//   · **路网完全不动**（禁区不切路面，只在街区里生效）；
//   · 只处理"与禁区（含让距）相交"的街区内的东西：
//     建筑整栋删掉、地块地面片删掉、树删掉，然后在这个范围里铺一层地面铺装；
//   · 基础城市按"无禁区"缓存，改禁区时只重跑这一层（毫秒级）。
//
// 语义（用户确认过的）：
//   · 让距（pad）**不影响道路**，只在街区内部扩一圈；
//   · 让距范围内铺地面铺装，让禁区边缘与周边地块衔接自然；
//   · 这个"衔接铺装"是**可选项**，关掉就只按禁区本体铺。

import { Pt } from '../core/geom';
import { M2, U } from './geom';
import { pointInPolygon as pointInRing, zoneToPolygon, type Zone } from '../town/zones';
import { treeProp } from './ground';
import { binarySplit } from './lotsplit';
import {
  surfaceArea,
  surfaceIntersect,
  surfaceOffset,
  surfaceSubtract,
  type PlanSurface,
} from '../town/planning/core/surface';
import type { MatKey } from '../scene/palette';
import type { CityResult } from './index';

/** 禁区用途 → 地面材质（与之前 emitZoneGround 的口径一致） */
const ZONE_MAT: Record<string, MatKey> = {
  cbd: 'stonePave',
  park: 'lawn',
  forest: 'grassDark',
};

const ZONE_GROUP: Record<string, string> = {
  cbd: 'lot/reserved',
  park: 'lot/park',
  forest: 'lot/green',
};

export interface ZoneApplyOpts {
  /** 让距（米）：铺装与"剔除范围"一起外扩这么多 */
  padM: number;
  /** 是否在让距范围内生成衔接铺装（关掉 = 只按禁区本体） */
  padPave: boolean;
}

function centroidOf(ring: Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p.x;
    y += p.y;
  }
  return new Pt(x / Math.max(1, ring.length), y / Math.max(1, ring.length));
}

/** 由禁区 id 派生的稳定种子（同一个禁区每次切分结果一致） */
function zoneSeed(z: Zone): number {
  let h = 2166136261;
  for (let i = 0; i < z.id.length; i++) h = Math.imul(h ^ z.id.charCodeAt(i), 16777619);
  return h >>> 0;
}

function ringHash(ring: Pt[]): number {
  let h = 2166136261;
  for (const p of ring) {
    h = Math.imul(h ^ Math.round(p.x * 100), 16777619);
    h = Math.imul(h ^ Math.round(p.y * 100), 16777619);
  }
  return h >>> 0;
}

interface Area {
  zone: Zone;
  ring: Pt[];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

function toArea(zone: Zone, ring: Pt[]): Area {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of ring) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  return { zone, ring, minX, maxX, minY, maxY };
}

function bboxHit(ring: Pt[], a: Area): boolean {
  let rMinX = Infinity;
  let rMaxX = -Infinity;
  let rMinY = Infinity;
  let rMaxY = -Infinity;
  for (const p of ring) {
    rMinX = Math.min(rMinX, p.x);
    rMaxX = Math.max(rMaxX, p.x);
    rMinY = Math.min(rMinY, p.y);
    rMaxY = Math.max(rMaxY, p.y);
  }
  return !(rMinX > a.maxX || rMaxX < a.minX || rMinY > a.maxY || rMaxY < a.minY);
}

/** 环是否碰到这块禁区范围（先包围盒、再顶点 / 质心判定） */
function ringHits(ring: Pt[], a: Area): boolean {
  let rMinX = Infinity;
  let rMaxX = -Infinity;
  let rMinY = Infinity;
  let rMaxY = -Infinity;
  for (const p of ring) {
    rMinX = Math.min(rMinX, p.x);
    rMaxX = Math.max(rMaxX, p.x);
    rMinY = Math.min(rMinY, p.y);
    rMaxY = Math.max(rMaxY, p.y);
  }
  if (rMinX > a.maxX || rMaxX < a.minX || rMinY > a.maxY || rMaxY < a.minY) return false;
  // 建筑顶点落进禁区 → 算碰到（这样"跨在边界上的楼"整栋删，不会被切一半）
  for (const p of ring) if (pointInRing(p, a.ring)) return true;
  // 禁区顶点落在建筑里（大禁区包住小楼的情况）
  const c = centroidOf(a.ring);
  return pointInRing(c, ring);
}


/**
 * 让距环带的"过渡地"：不是一块光板铺装，而是**内部路 + 绿化 + 停车带**。
 *
 * 用户要的是"(让距范围 − 禁区范围) 这个空心环里生成一些地面铺装、绿化和一个停车场、
 * 内部路"，让禁区边缘和周边地块衔接自然。做法：
 *   · 主轴 = 环带片的最长边（环带基本是长条，最长边就是走向）；
 *   · 中间一条 1.6 m 的内部步道（lotPath）；
 *   · 宽度 ≥ 9 m 时，一侧留 5 m 深的停车带（asphaltLot）+ 每 2.5 m 一根车位线；
 *   · 剩下的部分铺草地（lawn），沿步道两侧每隔 9 m 补一棵树。
 * 所有几何都裁回环带片自身，所以永远不会长到道路或禁区里去。
 */
function ringStrips(
  piece: PlanSurface,
  zoneId: string,
  out: { surfaces: CityResult['scene']['surfaces']; paths: CityResult['scene']['paths']; props: CityResult['scene']['props'] }
): number {
  const ring = piece.outer;
  if (ring.length < 3) return 0;
  const area = M2(surfaceArea(piece));
  if (area < 24) return 0;

  // 主轴取最长边
  let axis = new Pt(1, 0);
  let best = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const L = Pt.distance(a, b);
    if (L > best) {
      best = L;
      axis = new Pt((b.x - a.x) / L, (b.y - a.y) / L);
    }
  }
  const nrm = new Pt(-axis.y, axis.x);
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (const q of ring) {
    const u = q.x * axis.x + q.y * axis.y;
    const v = q.x * nrm.x + q.y * nrm.y;
    u0 = Math.min(u0, u);
    u1 = Math.max(u1, u);
    v0 = Math.min(v0, v);
    v1 = Math.max(v1, v);
  }
  const width = v1 - v0;
  const midV = (v0 + v1) / 2;
  const toW = (u: number, v: number): Pt => new Pt(axis.x * u + nrm.x * v, axis.y * u + nrm.y * v);
  const rect = (ua: number, ub: number, va: number, vb: number): PlanSurface => ({
    outer: [toW(ua, va), toW(ub, va), toW(ub, vb), toW(ua, vb)],
    holes: [],
  });
  const clip = (s: PlanSurface): PlanSurface[] => {
    try {
      return surfaceIntersect([s], [piece]).filter((q) => M2(surfaceArea(q)) > 2);
    } catch {
      return [];
    }
  };

  let done = 0;
  // ---- 内部步道
  const pathPieces = clip(rect(u0 - 1, u1 + 1, midV - 0.8, midV + 0.8));
  for (const q of pathPieces) {
    done += M2(surfaceArea(q));
    out.surfaces.push({
      name: `zone_${zoneId}_padpath`,
      group: 'lot/park',
      ring: q.outer,
      holes: q.holes,
      mat: 'lotPath',
      y: 0.0143,
      role: 'ground',
    });
  }

  // ---- 停车带（够宽才有）
  const parkDepth = Math.min(5, Math.max(0, width - 3.2));
  const parkPieces: PlanSurface[] = [];
  if (width >= 9 && parkDepth >= 4) {
    for (const q of clip(rect(u0 - 1, u1 + 1, v0, v0 + parkDepth))) {
      parkPieces.push(q);
      done += M2(surfaceArea(q));
      out.surfaces.push({
        name: `zone_${zoneId}_padpark`,
        group: 'lot/reserved',
        ring: q.outer,
        holes: q.holes,
        mat: 'asphaltLot',
        y: 0.0142,
        role: 'ground',
      });
    }
    // 车位线：沿主轴每 2.5 m 一根，长度 = 停车带宽
    for (let u = u0 + 1; u < u1 - 0.5; u += 2.5) {
      const a = toW(u, v0 + 0.15);
      const b = toW(u, v0 + parkDepth - 0.15);
      out.paths.push({
        name: `zone_${zoneId}_stall`,
        group: 'parking/marking',
        pts: [a, b],
        width: U(0.12),
        mat: 'markWhite',
        y: 0.0146,
      });
    }
  }

  // ---- 草地 = 环带片 − 步道 − 停车带
  const taken = [...pathPieces, ...parkPieces];
  if (taken.length > 0) {
    try {
      for (const q of surfaceSubtract([piece], taken)) {
        const a = M2(surfaceArea(q));
        if (a < 6) continue;
        done += a;
        out.surfaces.push({
          name: `zone_${zoneId}_padlawn`,
          group: 'lot/park',
          ring: q.outer,
          holes: q.holes,
          mat: 'lawn',
          y: 0.0141,
          role: 'ground',
        });
      }
    } catch {
      /* 减法失败就只留步道与停车带 */
    }
  } else {
    done += area;
    out.surfaces.push({
      name: `zone_${zoneId}_padlawn`,
      group: 'lot/park',
      ring,
      holes: piece.holes,
      mat: 'lawn',
      y: 0.0141,
      role: 'ground',
    });
  }

  // ---- 步道两侧补树（每 9 m 一棵，交替左右）
  let n = 0;
  for (let u = u0 + 1.5; u < u1 - 1; u += 9) {
    const side = n % 2 === 0 ? 1 : -1;
    const v = midV + side * (1.6 + 0.6);
    if (v < v0 + 0.6 || v > v1 - 0.6) continue;
    const p = toW(u, v);
    if (!pointInRing(p, ring)) continue;
    out.props.push(treeProp(p, 0.72 + ((n % 3) / 3) * 0.2, n * 331 + 17, 'lot/park'));
    n++;
  }
  return done;
}

/**
 * 把禁区作用到一座**已经生成好**的城市上，返回新的 CityResult。
 *
 * 不修改入参（`base` 可能是缓存对象），只做浅拷贝 + 数组过滤 + 追加铺装。
 */
export function applyZonesToCity(city: CityResult, zones: Zone[], opts: ZoneApplyOpts): CityResult {
  const active = zones.filter((z) => z.enabled);
  if (active.length === 0) return city;

  /**
   * 两套范围，作用对象不一样：
   *   · `cores` = 禁区**本体**：建筑、地块、**路面**都要让开（用户要求"与禁区重叠的道路要影响"）；
   *   · `areas` = 本体 + 让距：只用于地块层面（剔楼、铺装），**不碰路面**
   *     （用户要求"让距范围影响的道路不要调整"）。
   */
  const cores: Area[] = [];
  const areas: Area[] = [];
  for (const z of active) {
    const coreRing = zoneToPolygon(z);
    if (coreRing.length < 3) continue;
    const core = toArea(z, coreRing);
    cores.push(core);
    let ring = coreRing;
    if (opts.padPave && opts.padM > 0) {
      try {
        const grown = surfaceOffset({ outer: coreRing, holes: [] }, U(opts.padM));
        if (grown.length > 0) ring = grown[0].outer;
      } catch {
        /* 外扩失败就按本体 */
      }
    }
    areas.push(toArea(z, ring));
  }
  if (areas.length === 0) return city;

  const scene = {
    ...city.scene,
    surfaces: [...city.scene.surfaces],
    solids: [...city.scene.solids],
    paths: [...city.scene.paths],
    props: [...city.scene.props],
  };

  // ---- ⓪ 路面：只按**禁区本体**裁（让距不切路）
  const coreSurfaces: PlanSurface[] = cores.map((c) => ({ outer: c.ring, holes: [] }));
  const inCore = (p: Pt): boolean => cores.some((c) => pointInRing(p, c.ring));
  const roadCut: typeof scene.surfaces = [];
  for (const s of scene.surfaces) {
    if (!s.group.startsWith('road/')) {
      roadCut.push(s);
      continue;
    }
    if (!cores.some((c) => bboxHit(s.ring, c))) {
      roadCut.push(s);
      continue;
    }
    // 标线是细碎面：整段丢弃（布尔裁剪会碎成一堆小片，不划算）
    if (s.group === 'road/marking') {
      if (!inCore(centroidOf(s.ring))) roadCut.push(s);
      continue;
    }
    let cut: PlanSurface[] = [];
    try {
      cut = surfaceSubtract([{ outer: s.ring, holes: s.holes ?? [] }], coreSurfaces);
    } catch {
      cut = [];
    }
    for (const q of cut) {
      if (M2(surfaceArea(q)) < 4) continue;
      roadCut.push({ ...s, ring: q.outer, holes: q.holes });
    }
  }
  scene.surfaces = roadCut;

  // ---- ① 建筑：整栋删（不做布尔切分）
  let removedBuildings = 0;
  scene.solids = scene.solids.filter((s) => {
    if (areas.some((a) => ringHits(s.ring, a))) {
      removedBuildings++;
      return false;
    }
    return true;
  });

  // ---- ② 地块地面 / 收边线 / 树：质心落在范围里的删掉（剩下的被铺装盖住）
  const insideAny = (p: Pt): boolean => areas.some((a) => pointInRing(p, a.ring));
  scene.surfaces = scene.surfaces.filter((s) => {
    if (!s.group.startsWith('lot/')) return true; // 路网/底图不动
    if (s.name.startsWith('zone_')) return true; // 旧禁区面（重新计算）
    return !insideAny(centroidOf(s.ring));
  });
  scene.surfaces = scene.surfaces.filter((s) => {
    if (s.group === 'parking/marking') return !inCore(centroidOf(s.ring));
    return true;
  });
  scene.props = scene.props.filter((p) => !insideAny(p.at));

  // ---- ③ 铺装：范围 ∩ 街区面（**不碰路网**，所以不会切到车行道）
  const blocks: PlanSurface[] = city.debug.blocks.map((b) => b.surface);
  /** 城市底盘（用来把禁区铺装裁在红线里） */
  const cityBase = city.scene.surfaces.find((s) => s.name === 'city_base');
  let pavedM2 = 0;
  let treeN = 0;
  for (const a of areas) {
    const purpose = a.zone.purpose ?? 'cbd';
    const mat = ZONE_MAT[purpose] ?? ZONE_MAT.cbd;
    const group = ZONE_GROUP[purpose] ?? ZONE_GROUP.cbd;
    /**
     * 铺装分两块拼：
     *   · **本体**整块铺（路已经在本体里被挖掉了，直接铺到红线）；
     *   · **让距环带**只铺在地块上（那里路面没动，铺上去会盖住沥青）。
     */
    let pieces: PlanSurface[] = [];
    const core = cores.find((c) => c.zone.id === a.zone.id);
    try {
      const corePieces = surfaceIntersect(
        [{ outer: core ? core.ring : a.ring, holes: [] }],
        cityBase ? [{ outer: cityBase.ring, holes: cityBase.holes ?? [] }] : blocks
      );
      pieces.push(...corePieces);
      if (core && a.ring !== core.ring) {
        // 环带：内部路 + 绿化 + 停车带（不再是光板铺装）
        const padRing = surfaceSubtract([{ outer: a.ring, holes: [] }], [{ outer: core.ring, holes: [] }]);
        for (const q of surfaceIntersect(padRing, blocks)) {
          pavedM2 += ringStrips(q, a.zone.id, scene);
        }
      }
    } catch {
      pieces = [];
    }
    /**
     * 禁区本体的**内部切分**：直接借用街区那套二叉分割
     * （`binarySplit`，和地块切分是同一个函数），切到 ~900 m² 一块，
     * 再按用途给每块分配地类 —— 这样禁区读起来是"一片被规划过的地"，
     * 而不是一整块光板。
     */
    let pieceIdx = 0;
    let faceIdx = 0;
    for (const q of pieces) {
      const area = M2(surfaceArea(q));
      if (area < 6) continue;
      const faces =
        area > 1400 && q.outer.length >= 3
          ? binarySplit(q, {
              seed: (zoneSeed(a.zone) + pieceIdx * 7919) >>> 0,
              axisRad: 0,
              // 切得比地块更细一档：街区地块是 600~1200 m²，禁区没有建筑，
              // 只靠地面颜色读切分，块太大就只剩"一整块草地"
              targetM2: 420,
              minM2: 110,
              minSideM: 8,
              maxDepth: 9,
            })
          : [q];
      pieceIdx++;
      for (const f of faces) {
        const fa = M2(surfaceArea(f));
        if (fa < 20) continue;
        const h = ringHash(f.outer);
        let fmat: MatKey = mat;
        let fgroup = group;
        faceIdx++;
        if (purpose === 'cbd') {
          // 硬地：大部分石材铺装，穿插步道，读得出"分块"
          fmat = faceIdx % 5 === 0 ? 'lotPath' : 'stonePave';
        } else {
          /**
           * 绿地：**按下标循环**取四种深浅（不是按 hash），保证相邻块颜色一定不同。
           * 按 hash 取的时候低位分布不均（实测 only lawn / grassLight 两种命中），
           * 一整片禁区看上去还是一块草地。
           */
          /**
           * 绿地：**整块都是草**（三档主色循环 + 偶尔深绿做重音）。
           *
           * 不再把整块面指定成园路 —— 那样会出现几十米见方的一大块铺装，
           * 看着像停车场。园路改成"每个面中间拉一条 1 m 小径"（见下面），
           * 既读得出切分，又是公园步道的样子。
           */
          const greens: MatKey[] = ['lawn', 'grassLight', 'grass'];
          fmat = faceIdx % 11 === 0 ? 'grassDark' : greens[faceIdx % greens.length];
          fgroup = 'lot/park';
        }
        pavedM2 += fa;
        scene.surfaces.push({
          name: `zone_${a.zone.id}_${h % 9973}`,
          group: fgroup,
          ring: f.outer,
          holes: f.holes,
          mat: fmat,
          // 压在一切地块地面之上（地块地面最高 0.013），标线之下
          y: 0.0142,
          role: 'ground',
        });

        // 园路：每 3 块里挑一块，沿它的长边拉一条 1 m 小径（裁回本块）
        if (purpose !== 'cbd' && fa > 150 && faceIdx % 3 === 0) {
          let ax = 1;
          let ay = 0;
          let bestL = 0;
          for (let i = 0; i < f.outer.length; i++) {
            const pa = f.outer[i];
            const pb = f.outer[(i + 1) % f.outer.length];
            const L = Pt.distance(pa, pb);
            if (L > bestL) {
              bestL = L;
              ax = (pb.x - pa.x) / L;
              ay = (pb.y - pa.y) / L;
            }
          }
          const nx = -ay;
          const ny = ax;
          let cxs = 0;
          let cys = 0;
          for (const pt of f.outer) {
            cxs += pt.x;
            cys += pt.y;
          }
          cxs /= f.outer.length;
          cys /= f.outer.length;
          const halfW = U(0.6);
          const L2 = bestL;
          const a1 = new Pt(cxs - ax * L2, cys - ay * L2);
          const b1 = new Pt(cxs + ax * L2, cys + ay * L2);
          const band: PlanSurface = {
            outer: [
              new Pt(a1.x + nx * halfW, a1.y + ny * halfW),
              new Pt(b1.x + nx * halfW, b1.y + ny * halfW),
              new Pt(b1.x - nx * halfW, b1.y - ny * halfW),
              new Pt(a1.x - nx * halfW, a1.y - ny * halfW),
            ],
            holes: [],
          };
          try {
            for (const q of surfaceIntersect([band], [f])) {
              if (M2(surfaceArea(q)) < 6) continue;
              scene.surfaces.push({
                name: `zone_${a.zone.id}_walk`,
                group: 'lot/park',
                ring: q.outer,
                holes: q.holes,
                mat: 'lotPath',
                y: 0.0143,
                role: 'ground',
              });
            }
          } catch {
            /* 小径裁不出来就跳过 */
          }
        }

        // 树：绿地按面积给（每 ~220 m² 一棵），硬地只在够大时点几棵
        const wantTrees = purpose === 'cbd' ? (fa > 700 ? 2 : 0) : Math.round(fa / 220);
        if (wantTrees > 0) {
          let bx0 = Infinity;
          let bx1 = -Infinity;
          let by0 = Infinity;
          let by1 = -Infinity;
          for (const pt of f.outer) {
            bx0 = Math.min(bx0, pt.x);
            bx1 = Math.max(bx1, pt.x);
            by0 = Math.min(by0, pt.y);
            by1 = Math.max(by1, pt.y);
          }
          let placed = 0;
          for (let k = 0; k < wantTrees * 8 && placed < wantTrees; k++) {
            const t = (h + k * 104729) % 1000003;
            const px = bx0 + (((t * 37) % 1000) / 1000) * (bx1 - bx0);
            const py = by0 + (((t * 61) % 1000) / 1000) * (by1 - by0);
            const pt = new Pt(px, py);
            if (!pointInRing(pt, f.outer)) continue;
            scene.props.push(treeProp(pt, 0.8 + ((t % 7) / 7) * 0.35, t, fgroup));
            placed++;
            treeN++;
          }
        }
      }
    }
  }

  const treeCount = scene.props.filter((p) => p.kind.startsWith('tree') || p.kind === 'conifer').length;
  const notes = [...city.notes];
  notes.push(
    `禁区局部生效：剔除建筑 ${removedBuildings} 栋、铺装 ${pavedM2.toFixed(0)} m²` +
      (treeN ? `、补树 ${treeN} 棵` : '') +
      (opts.padPave ? `（含 ${opts.padM} m 让距的衔接铺装）` : '（未生成让距铺装）') +
      '；路网未改动'
  );

  return {
    ...city,
    scene,
    stats: {
      ...city.stats,
      buildingCount: scene.solids.length,
      treeCount,
    },
    notes,
  };
}
