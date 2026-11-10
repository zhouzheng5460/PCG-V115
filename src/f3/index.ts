// F3 · 主链路：城市边界 → 张量方向 → 破碎/合并 → PathGraph → 道路面 → 街区
//        → 用途切分 → 最大内接矩形 → 建筑内退 → 体量 → 复合地面 → Scene
//
// 一条路走到底，中间没有"候选集"也没有"评分器"。
// 任何一步做不出来，都在 `notes` 里留一句人话说明降级到了什么，不静默当成功。

import { Pt } from '../core/geom';
import { surfaceArea, surfaceIntersect, surfaceOffset, surfaceSubtract, type PlanSurface } from '../town/planning/core/surface';
import { makeRng } from '../town/planning/subdivision/geom';
import type { LandUse, LotInfo, PathFeature, PropFeature, Scene, SolidFeature, SurfaceFeature } from '../scene/types';
import { emptyScene } from '../scene/types';
import type { MatKey } from '../scene/palette';
import { buildBlocks, centroidOf, frontRadOf, nearestPath, splitParcels } from './blocks';
import { buildParcelTensor, splitBlockByTensor, type TensorRegion, type TensorSplit } from './tensorsplit';
import { footprintOf, maxInscribedRect, realizeBuildings } from './build';
import { realizeLayout } from './layout';
import { buildLandUseField } from './landuse';
import { M2, U, areaM2, cleanRing, polyLen } from './geom';
import { groundForParcel, groundStats, parkGround, treeProp } from './ground';
import { buildRoadGeom, unionPolys, type RoadGeom } from './roadgeom';
import { growStreets } from './grow';
import { growStreetsTensor } from './tensorgrow';
import { applyZonesToCity } from './zoneapply';
import { splitPinched } from '../core/clipper';
import { insideSurface, selfIntersects, surfaceUnionLegacy } from '../town/planning/core/surface';
import {
  DENSITY_PRESETS,
  STYLE_PRESETS,
  type BuildingParcel,
  type CityBlock,
  type CitySpec,
  type CityStats,
  type InscribedRect,
  type PathGraph,
  type StylePreset,
} from './types';

export interface CityDebug {
  graph: PathGraph;
  /** 递归切分出来的面（= 街区的前身） */
  faces: { ring: Pt[]; depth: number; areaM2: number }[];
  blocks: CityBlock[];
  /** 张量场一级切分出来的大分区（街区 → 大分区 → 地块） */
  tensorRegions: TensorRegion[];
  /** 一级缝铺成的内部步行街 */
  tensorLanes: PlanSurface[];
  parcels: (BuildingParcel & { rect: InscribedRect | null; footprint: Pt[] | null; note: string })[];
  road: RoadGeom;
}

export interface CityResult {
  spec: CitySpec;
  preset: StylePreset;
  scene: Scene;
  stats: CityStats;
  debug: CityDebug;
  notes: string[];
}

export function runF3City(input: CitySpec): CityResult {
  const t0 = Date.now();
  const notes: string[] = [];
  /**
   * 场地边界（**未扣禁区**）：底盘、面积账、禁区铺装都用它。
   * 生成边界（`spec.boundary`）会被禁区扣掉，见 `planZones()`。
   */
  const siteBoundary = input.boundary;
  let spec = input;
  const preset = STYLE_PRESETS[spec.style];
  const dense = DENSITY_PRESETS[spec.density];
  const heightScale = spec.heightScale ?? 1;
  const rng = makeRng(spec.seed, 'f3city');

  /**
   * 禁区**不参与生成**：它改到生成之后做局部后处理（见 `zoneapply.ts`）。
   *
   * 以前是在这里把禁区从城市边界里扣掉，结果"动一块禁区 → 整城重算 2~6 s"，
   * 而且路网会因为边界变了而整体重排。现在路网完全不受禁区影响。
   */

  // 注意：浏览器里没有 `process`。写 `process.env.F3_DEBUG` 会让整条链路在页面上
  // 直接 ReferenceError（Node 里跑得好好的脚本，一进浏览器就白屏，这是最常见的坑）。
  const dbg = typeof process !== 'undefined' && !!process.env?.F3_DEBUG;
  const clock = (tag: string): void => {
    if (dbg) console.log(`[f3] ${tag} ${Date.now() - t0} ms`);
  };
  const _T0 = Date.now();
  let _Tp = _T0;
  const stage = (tag: string): void => {
    if (typeof process !== 'undefined' && process.env?.F3_TC) {
      console.log(`[st] ${tag} ${Date.now() - _Tp} ms`);
      _Tp = Date.now();
    }
  };

  // ---------------- ① 路网创建第一步：legacy 张量场生成道路
  //
  // 先后关系：张量场先给出整张路网的中心线 → F3 建图 / 分级 → 道路建模
  // → 从唯一路网面扣出街区 → 街区内才做张量一级粗切 + splitParcels。
  // 街区内处理与道路建模算法一律不改；`?f3road=split` 可回到递归面切分做对比。
  const streets = spec.roadMode === 'split' ? growStreets(spec, preset) : growStreetsTensor(spec, preset);
  notes.push(...streets.notes);
  clock('streets');

  stage('① 张量路网');
  // ---------------- ② 道路几何
  const road = buildRoadGeom({ boundary: spec.boundary }, streets.graph, preset);
  notes.push(...road.notes);
  clock('roadgeom');

  stage('② 道路几何');
  // ---------------- ③ 街区：从**唯一那张已圆角的路网面**扣出闭合范围
  //
  // 路口、转角圆弧、尽端回车场全都在 road.domain 里，一次布尔差即可；
  // 不再有「reserve 之外再单独减 corner 片」这种两套几何各算各的做法。
  // 扣街区用未裁的那一份：切口是正面积，街区不会顺着红线上的发丝缝连成一片
  const blockRes = buildBlocks(spec, preset, road.cutDomain ?? road.domain, streets.graph);
  notes.push(...blockRes.notes);
  clock('blocks');

  /**
   * 人工覆盖：先把"地块类型"落到街区上，再做切分 ——
   * 切分尺度是由 block.use 查表决定的（住宅 420~700 m²、工业 3200~6000 m²），
   * 先改用途再切，地块尺度才跟着变。切完再改用途只会得到"商业用途的住宅尺度地块"。
   */
  const overrides = spec.blockOverrides ?? {};
  const reservedIds = new Set<string>();
  let useOverrideN = 0;
  for (const b of blockRes.blocks) {
    const ov = overrides[b.id];
    if (!ov?.use) continue;
    useOverrideN++;
    if (ov.use === 'reserved') {
      reservedIds.add(b.id);
      // 保留地按"公园"的切分规则走（整块不切），但地面铺硬地、不排建筑
      b.use = 'park';
      b.why = '人工指定：保留地（不盖楼、铺硬地）';
    } else {
      b.use = ov.use;
      b.why = `人工指定用途：${ov.use}`;
    }
  }
  if (useOverrideN) notes.push(`人工覆盖 ${useOverrideN} 个街区的地块类型`);

  stage('③ 街区');
  // ---------------- ④ 地块 + 建筑 + 地面
  //
  // 三阶段（用户要求「张量场 → 现有切分」是**先后**关系，不是并列的两套路网）：
  //   ① 张量场一级切分：街区 → 少量大分区 + 沿一级缝的内部步行街；
  //   ② 现有 splitParcels：在**每个大分区内部**做正交二叉 / 排×户，机制不动；
  //   ③ 地块粒度统一重贴用途（landuse.ts 的多中心可达性场竞租概率）。
  // 街区级 `assignUses` 仍只决定切分尺度与分区先验，不等于整块街区一个用途。
  const field = buildLandUseField(spec, preset, streets.graph);
  const parcelTensor = buildParcelTensor(spec, streets.graph, streets.axisRad);
  const splits = blockRes.blocks.map((block) => {
    /**
     * 人工指定了"切分数量"的街区：**跳过张量一级切分**，整块直接进二级切分。
     *
     * 不跳的话，一级先把街区切成 3~5 个大分区，每个分区再切 N 块，
     * 面板上填 4 会得到 17 块 —— 数字对不上，用户没法用。
     * 跳过之后 "N" 就是这块地的目标块数（二叉分割按面积逼近，实测量级 ±30%）。
     */
    const ov0 = overrides[block.id];
    if (ov0?.parcels && ov0.parcels > 0) {
      const whole: TensorSplit = { regions: [], lanes: [], seams: [], notes: [] };
      const s = splitParcels(
        block,
        preset,
        dense.parcelScale,
        spec.seed,
        spec.buildMode ?? 'binary',
        block.id,
        { axisRad: ov0.axisRad, parcels: ov0.parcels }
      );
      return { block, first: whole, split: s };
    }
    const first: TensorSplit = splitBlockByTensor(block, parcelTensor, spec, preset);
    const second = first.regions.map((region, i) => {
      // 分区带一个由张量场给出的主轴向；二级切分仍走原来的 splitParcels，
      // 只是作用域从「整块街区」缩到「一个大分区」，id 前缀保证不撞车。
      const regionBlock: CityBlock = {
        ...block,
        id: block.id, // landuse.assign 靠 blockId 找街区先验，不能改成分区 id
        surface: region.surface,
        areaM2: region.areaM2,
        frontRad: region.axisRad,
      };
      const ov = overrides[block.id];
      const s = splitParcels(
        regionBlock,
        preset,
        dense.parcelScale,
        spec.seed,
        spec.buildMode ?? 'binary',
        `${block.id}-T${i + 1}`,
        ov ? { axisRad: ov.axisRad, parcels: ov.parcels } : undefined
      );
      return s;
    });
    return {
      block,
      first,
      split: {
        parcels: second.flatMap((s) => s.parcels),
        notes: [...first.notes, ...second.flatMap((s) => s.notes)],
      },
    };
  });
  for (const s of splits) notes.push(...s.split.notes);
  const landUse = field.assign(
    splits.flatMap((s) => s.split.parcels),
    blockRes.blocks
  );
  notes.push(...landUse.notes);
  /**
   * landuse.assign 会按"竞租概率"重写每个地块的用途，人工指定的用途必须**在它之后**
   * 再盖一次，否则面板上选了"工业"、画面上还是住宅。只改用途，不动任何几何。
   */
  for (const { split } of splits) {
    for (const p of split.parcels) {
      const ov = overrides[p.blockId];
      if (!ov?.use) continue;
      p.use = ov.use === 'reserved' ? 'park' : ov.use;
      p.useWhy = '人工指定';
    }
  }
  // 子地块的临街方向必须按**它自己**离哪条路最近来定。一级分区内靠内侧的
  // 地块往往面向另一条街，整块分区共用一个 axisRad 会把「临街低 / 内侧高」
  // 和高度带判反。切分已经完成，这里只改正方向，不动任何切分几何。
  let radFixed = 0;
  for (const { split } of splits) {
    for (const p of split.parcels) {
      const c = centroidOf(p.surface.outer);
      const rad = frontRadOf(p.surface, c, nearestPath(streets.graph, c));
      if (Math.abs(Math.sin(rad - p.frontRad)) > 0.08) radFixed++;
      p.frontRad = rad;
    }
  }
  const tensorRegions = splits.flatMap((s) => s.first.regions);
  const tensorLanes = splits.flatMap((s) => s.first.lanes);
  notes.push(
    `地块层级：${blockRes.blocks.length} 街区 → 张量一级 ${tensorRegions.length} 个大分区 → 二级切分 ${splits.reduce((a, s) => a + s.split.parcels.length, 0)} 个地块；一级缝铺内部步行街 ${tensorLanes.length} 片`
  );
  notes.push(`子地块临街方向按最近道路重算：${radFixed} / ${splits.reduce((a, s) => a + s.split.parcels.length, 0)} 块朝向有修正`);
  clock('landuse');

  const scene = emptyScene();
  const parcelsOut: CityDebug['parcels'] = [];
  const lots: LotInfo[] = [];
  let parcelArea = 0;
  let buildingCount = 0;
  let bays = 0;
  let trees = 0;
  let footprintArea = 0;
  let gfa = 0;
  /** 阶段④的分项耗时（F3_TC 时打印）：布局 / 地面 / 其余 */
  const prof = { layout: 0, ground: 0, park: 0 };

  /**
   * 街区切分丢下的 <60 m² 碎渣也是「场地 − 路网面」的一部分。
   * 以前它们被静默丢弃，面积账就常年差几十 m²（现在街区边界带圆弧，
   * 角的碎渣更常见）。铺成口袋绿地并计入地块面积，账才真的闭合。
   */
  blockRes.crumbs.forEach((q, i) => {
    parcelArea += M2(surfaceArea(q));
    scene.surfaces.push({
      name: `city_crumb_${i}`,
      group: 'lot/green',
      ring: q.outer,
      holes: q.holes,
      mat: 'lawn',
      y: 0.0112,
      role: 'ground',
    });
  });

  for (const { block, split, first } of splits) {
    /**
     * L0 · 硬质底：**整个街区面**原样铺一层硬质铺装，不做任何布尔。
     *
     * 这是地面结构的第 0 层：上面再叠草地 / 停车场地坪 / 水面 / 内部路。
     * 三个理由：
     *   ① 任何上层（草地、停车、通路）算失败或算漏，露出来的是硬质铺装，
     *      而不是底色或黑洞 —— "地块缺一块"从结构上不可能再发生；
     *   ② 街区边界已经是路网圆角化之后的面，天然贴着人行道，不需要再裁；
     *   ③ 免掉原来"兜底把边角补成草地"的一堆小布尔（那些碎片还常常补不上）。
     * y 取全场地最低（0.0095），保证任何地物都压在它上面，不打架。
     */
    scene.surfaces.push({
      name: `${block.id}_base`,
      group: `lot/${block.use}`,
      ring: block.surface.outer,
      holes: block.surface.holes,
      mat: 'lotBase',
      y: 0.0095,
      role: 'ground',
    });

    /** 这个街区已经认领的地块面（用来兜底收边角） */
    const claimedByBlock: PlanSurface[] = [];
    let blockBuildings = 0;
    let blockBays = 0;
    let blockTrees = 0;

    /**
     * 张量一级缝 = 地块内部步行街（不是马路）。
     *
     * 《houdini 路网 (3)》「或把内部分割线当步行街」：一级分区之间的这条缝
     * 铺 3 m 石铺，既让层级在总平面上读得出来，也补上了 HUD 里一直为 0 的
     * 「内部道路 / 步行街」。分区在切二级之前已经把这条带子扣掉，
     * 所以建筑不会压在上面。
     */
    let laneArea = 0;
    /** 街区级步行街（也是"地块通路"这一类），要参与每个地块的地面避让 */
    const laneSurfaces: PlanSurface[] = [];
    first.lanes.forEach((lane, i) => {
      laneArea += M2(surfaceArea(lane));
      claimedByBlock.push(lane);
      laneSurfaces.push({ outer: lane.outer, holes: lane.holes ?? [] });
      scene.surfaces.push({
        name: `${block.id}_tensor_walk_${i}`,
        group: `lot/${block.use}`,
        ring: lane.outer,
        holes: lane.holes,
        mat: 'lotPath',
        y: 0.0126,
        role: 'ground',
      });
    });
    parcelArea += laneArea;

    for (const parcel of split.parcels) {
      parcelArea += parcel.areaM2;
      claimedByBlock.push(parcel.surface);
      /**
       * 保留地：整块铺硬地，不排建筑、不排停车、不种树。
       * 它跟禁区不是一回事 —— 禁区在生成前就把边界挖掉了（路网绕行），
       * 保留地是"路网照旧、这块地空着"，用来手动留出广场 / 待建地。
       */
      if (reservedIds.has(block.id)) {
        scene.surfaces.push({
          name: `${parcel.id}_reserved`,
          group: 'lot/reserved',
          ring: parcel.surface.outer,
          holes: parcel.surface.holes,
          mat: 'lotBase',
          y: 0.0126,
          role: 'ground',
        });
        parcelsOut.push({ ...parcel, rect: null, footprint: null, note: '保留地：铺硬地，不盖楼' });
        continue;
      }

      // 太小的地块放不下建筑：当绿地处理（不丢，账才闭得上）
      const isPark = parcel.use === 'park' || parcel.use === 'green' || parcel.areaM2 < 80;
      const groundOpts = { preset, seed: spec.seed, entrances: [] as Pt[], heightScale };

      if (isPark) {
        const g = parkGround(parcel, groundOpts);
        pushGround(scene, g, parcel);
        blockTrees += g.trees.length;
        trees += g.trees.length;
        parcelsOut.push({ ...parcel, rect: null, footprint: null, note: g.note });
        continue;
      }

      /**
       * 建筑布局（默认）：按《houdini 路网 (3)》的场景分流 ——
       * 规则矩形地块两排、大地块配内部路网、不规则地块沿路随机填充。
       * 地块本身由 `splitParcels` 的二叉分割给出。
       */
      if ((spec.buildMode ?? 'binary') === 'binary') {
        const _tLayout = Date.now();
        const bb = realizeLayout(parcel, {
          density: spec.density,
          heightScale: heightScale * (overrides[block.id]?.heightScale ?? 1),
          centerDist: block.centerDist,
          access: parcel.access,
          localIntensity: parcel.localIntensity,
          streetCls: parcel.streetCls ?? block.nearestCls,
          preset,
          coverage: preset.coverage,
          seed: spec.seed,
        });
        prof.layout += Date.now() - _tLayout;
        for (const s of bb.solids) {
          scene.solids.push(s);
          footprintArea += M2(surfaceArea({ outer: s.ring, holes: [] }));
        }
        /**
         * 内部路网 / 步行街：**属于"地块通路"这一类**（不是停车坪、也不是自有颜色）。
         *
         * 之前用 `asphaltLot`（同一个材质当停车坪）+ `stonePave`（步行），于是
         *   · 它被算进"停车场地坪"，跟草地对不上账（实测重叠 3.4 万 m²）；
         *   · 地块里出现第四、第五种颜色。
         * 现在统一 `lotPath`，并且把它们的面**回传给地面计算**去避让（见 groundOpts.innerRoads）。
         */
        const innerRoadSurfaces: PlanSurface[] = [];
        for (const ir of bb.innerRoads) {
          innerRoadSurfaces.push({ outer: ir.surface.outer, holes: ir.surface.holes ?? [] });
          scene.surfaces.push({
            name: `${parcel.id}_inner_${ir.kind}`,
            group: `lot/${parcel.use}`,
            ring: ir.surface.outer,
            holes: ir.surface.holes,
            mat: 'lotPath',
            y: 0.0126,
            role: 'ground',
          });
        }
        buildingCount += bb.solids.length;
        blockBuildings += bb.solids.length;
        gfa += bb.gfaM2;

        // 入口取"最靠街那一栋"在街道方向投影最小的点（不规则轮廓没有"临街边中点"）
        const entrances: Pt[] = [];
        if (bb.frontRing && bb.frontRing.length >= 3) {
          const ux = Math.cos(parcel.frontRad);
          const uy = Math.sin(parcel.frontRad);
          let best = bb.frontRing[0];
          let bu = Infinity;
          for (const p of bb.frontRing) {
            const u = p.x * ux + p.y * uy;
            if (u < bu) {
              bu = u;
              best = p;
            }
          }
          entrances.push(best);
        }
        const _tGround = Date.now();
        const g = groundForParcel(parcel, null, bb.frontRing, bb.footprints, {
          ...groundOpts,
          entrances,
          courtyard: bb.courtyard,
          innerRoads: innerRoadSurfaces,
        });
        prof.ground += Date.now() - _tGround;
        pushGround(scene, g, parcel);
        blockBays += g.bays;
        blockTrees += g.trees.length;
        bays += g.bays;
        trees += g.trees.length;
        parcelsOut.push({ ...parcel, rect: null, footprint: bb.frontRing, note: `${bb.note}｜${g.note}` });
        continue;
      }

      // 最大内接矩形：局部 +v 必须指向街道，所以 frame = frontRad − 90°
      const frame = parcel.frontRad - Math.PI / 2;
      const search = maxInscribedRect(parcel.surface, frame, [frame + Math.PI / 4, frame - Math.PI / 4]);
      const rect = search.rect;
      if (!rect) {
        parcelsOut.push({ ...parcel, rect: null, footprint: null, note: '找不到合法的内接矩形（地块过窄或形状异常）' });
        notes.push(`${parcel.id}（${parcel.areaM2.toFixed(0)} m²）找不到内接矩形 —— 未生成建筑，地块留作空地`);
        const g = groundForParcel(parcel, null, null, [], groundOpts);
        pushGround(scene, g, parcel);
        continue;
      }

      const footprint = footprintOf(rect, parcel.use);
      if (!footprint) {
        parcelsOut.push({ ...parcel, rect, footprint: null, note: '内退后无有效轮廓' });
        const g = groundForParcel(parcel, rect, null, [], groundOpts);
        pushGround(scene, g, parcel);
        continue;
      }

      const b = realizeBuildings(parcel, footprint, {
        density: spec.density,
        heightScale: heightScale * (overrides[block.id]?.heightScale ?? 1),
        rng,
        centerDist: block.centerDist,
        coverage: preset.coverage,
      });
      for (const s of b.solids) {
        scene.solids.push(s);
        footprintArea += M2(surfaceArea({ outer: s.ring, holes: [] }));
      }
      buildingCount += b.solids.length;
      blockBuildings += b.solids.length;
      gfa += b.gfaM2;

      // 入口：Footprint 临街边的中点（地面绿化 / 停车都要避开）
      const entrances: Pt[] = [];
      if (footprint.length === 4) {
        entrances.push(new Pt((footprint[2].x + footprint[3].x) / 2, (footprint[2].y + footprint[3].y) / 2));
      }
      const g = groundForParcel(parcel, rect, footprint, b.footprints, { ...groundOpts, entrances });
      pushGround(scene, g, parcel);
      blockBuildings += 0;
      blockBays += g.bays;
      blockTrees += g.trees.length;
      bays += g.bays;
      trees += g.trees.length;
      parcelsOut.push({ ...parcel, rect, footprint, note: `${b.note}｜${g.note}` });
    }

    /**
     * 兜底：街区里没被任何地块认领的边角，铺成绿地。
     *
     * 不做这一步的话，切分过程丢掉的碎片会让"场地 = 道路 + 地块"差出 3%
     * （R01 这种 2 万 m² 的弯月地块实测 747 m²）。这些边角本来就该是绿化，
     * 认领了既补上账，也不会在图上留下一块没有归属的底板。
     */
    let leftoverArea = 0;
    try {
      const rest = surfaceSubtract([block.surface], claimedByBlock);
      for (const q of rest) {
        const a = M2(surfaceArea(q));
        leftoverArea += a; // 碎片小到不值得渲染也要入账，否则场地 ≠ 道路 + 地块
        if (a < 1.5) continue;
        scene.surfaces.push({
          name: `${block.id}_leftover`,
          group: `lot/${block.use}`,
          ring: q.outer,
          holes: q.holes,
          mat: 'lawn',
          y: 0.0112,
          role: 'ground',
        });
      }
    } catch {
      /* 兜底失败就不补，账里会体现出来 */
    }
    parcelArea += leftoverArea;

    // HUD 的用地统计改为读**实际地块用途的众数**：街区主导用途已经不再等于
    // 整块街区的用途，继续用 block.use 会让统计与画面不符。
    const useCount = new Map<BuildingParcel['use'], number>();
    for (const p of split.parcels) useCount.set(p.use, (useCount.get(p.use) ?? 0) + 1);
    let dominant: BuildingParcel['use'] = block.use;
    let bestN = -1;
    for (const [u, n] of useCount) {
      if (n > bestN) {
        bestN = n;
        dominant = u;
      }
    }
    lots.push({
      index: lots.length,
      use: dominant as LandUse,
      area: block.areaM2,
      far: 0,
      buildings: blockBuildings,
      parkingBays: blockBays,
      trees: blockTrees,
    });
  }


  clock('parcels+buildings+ground');
  if (dbg)
    console.log(
      `[f3] 阶段④分项：布局 ${prof.layout} ms / 地面 ${prof.ground} ms；其中认领 ${groundStats.takeN} 次 ${groundStats.takeMs} ms；` +
      `去重叠 草 ${groundStats.lawnBefore.toFixed(0)} → ${groundStats.lawnAfter.toFixed(0)} m²`
    );
  stage('④ 地块/建筑/地面');
  // ---------------- ⑤ 道路图层（放在地块之后 push，绘制顺序由 y 决定，不靠顺序）
  pushRoads(scene, road, streets.graph);

  // ---------------- ⑥ 底盘
  scene.surfaces.unshift({
    name: 'city_base',
    group: 'ground',
    ring: siteBoundary.outer,
    holes: siteBoundary.holes,
    mat: 'ground',
    y: -0.03,
    role: 'ground',
  });

  // ---------------- ⑦ 统计
  const siteArea = areaM2(siteBoundary);
  /**
   * 路网面的净面积就是真实道路占地：它已经把路口、圆角、人行道、绿带
   * 全部并成一张面，各层是它的差集分割，不存在路口重叠重复统计。
   */
  const roadArea = road.reserveAreaM2;
  // 路口行人平台铺的是铺装，属于人行道口径
  const apronAreaM2 = road.apron.reduce((a, s) => a + M2(surfaceArea(s)), 0);
  /**
   * 街区 = 场地 − 路网面，理论上恰好闭合。所有碎渣（<60 m² 的街区边角、
   * <1.5 m² 的切分残片）都已认领并铺成绿地，剩下 1 m² 量级只可能是
   * polygon-clipping 的浮点缝。按场地面积的 0.002% 设容差，超过才算真漏地。
   */
  const rawUnclaimed = siteArea - roadArea - parcelArea;
  const tolM2 = Math.max(1, siteArea * 2e-5);
  const unclaimed = rawUnclaimed > tolM2 ? rawUnclaimed : 0;
  const stats: CityStats = {
    roadLengthM: +road.lengthM.toFixed(0),
    roadAreaM2: +road.roadAreaM2.toFixed(0),
    junctionAreaM2: +road.junctionAreaM2.toFixed(0),
    sidewalkAreaM2: +road.walkAreaM2.toFixed(0),
    greenAreaM2: +(road.vergeAreaM2 + scene.surfaces.filter((s) => s.mat === 'lawn' || s.mat === 'grass').reduce((a, s) => a + M2(surfaceArea({ outer: s.ring, holes: s.holes ?? [] })), 0)).toFixed(0),
    blockCount: blockRes.blocks.length,
    parcelCount: parcelsOut.length,
    buildingCount,
    parkingBays: bays,
    treeCount: trees,
    footprintAreaM2: +footprintArea.toFixed(0),
    parcelAreaM2: +parcelArea.toFixed(0),
    siteAreaM2: +siteArea.toFixed(0),
    // 街区 = 场地 − 路网面，数值缝已在上面按 0.002% 归零
    unclaimedM2: +unclaimed.toFixed(0),
    gfaM2: +gfa.toFixed(0),
  };

  scene.lots = lots;
  const byUse: Record<string, number> = {};
  for (const l of lots) byUse[l.use] = (byUse[l.use] ?? 0) + 1;
  const propsByKind: Record<string, number> = {};
  for (const p of scene.props) propsByKind[p.kind] = (propsByKind[p.kind] ?? 0) + 1;
  scene.stats = {
    surfaces: scene.surfaces.length,
    solids: scene.solids.length,
    props: scene.props.length,
    paths: scene.paths.length,
    byUse,
    propsByKind,
  };

  notes.push(
    `合计：道路 ${stats.roadLengthM} m / ${roadArea.toFixed(0)} m²，街区 ${stats.blockCount}，地块 ${stats.parcelCount}，建筑 ${buildingCount} 栋（占地 ${footprintArea.toFixed(
      0
    )} m²），车位 ${bays}，树 ${trees}，用时 ${Date.now() - t0} ms`
  );
  const diff = siteArea - roadArea - parcelArea;
  notes.push(
    `面积对账（并集口径）：场地 ${siteArea.toFixed(0)} m² = 道路用地 ${roadArea.toFixed(0)} + 地块 ${parcelArea.toFixed(0)} + 未归属 ${unclaimed.toFixed(0)} m²` +
      (rawUnclaimed > 0 && unclaimed === 0 ? `（布尔数值缝 ${rawUnclaimed.toFixed(1)} m² < 容差 ${tolM2.toFixed(0)} m²，已归零）` : '') +
      (diff < -1 ? `（差额 ${(-diff).toFixed(0)} m² = ${((-diff / siteArea) * 100).toFixed(2)}%，来自地块与道路用地的边界重叠）` : '')
  );
  notes.push(
    `道路分层面积（同一张路网面的差集，互不重叠）：车行 ${road.roadAreaM2.toFixed(0)} / 路口 ${road.junctionAreaM2.toFixed(0)} / 人行 ${road.walkAreaM2.toFixed(0)}（其中转角平台 ${apronAreaM2.toFixed(0)}）/ 绿带 ${road.vergeAreaM2.toFixed(0)} m²；路缘 ${road.curb.length} 片`
  );

  /**
   * **场景卫生：自交的面必须归一化。**
   *
   * 自交环（"8"字、或者带子两端互相压过去）在三角化时会把自交围出来的区域当作
   * 内部填满 —— 渲染出来是一块**盖住邻接街区的面**。而它的 shoelace 面积可能
   * 很小（实测标线那 217 段，面积都只有几十 m²），所以"面积别太大"这类校验
   * 根本发现不了。
   *
   * 统一在这里过一遍：自交的环交给 Clipper 用非零绕数归一化成简单环，拆成多片
   * 就逐片放回（每片都保留原来的 group / mat / name / y）。
   */
  {
    const clean: typeof scene.surfaces = [];
    let fixedCount = 0;
    let splitCount = 0;
    const hasDup = (r: Pt[]): boolean => {
      const seen = new Set<string>();
      for (const q of r) {
        const k = `${q.x.toFixed(5)},${q.y.toFixed(5)}`;
        if (seen.has(k)) return true;
        seen.add(k);
      }
      return false;
    };
    const push = (sf: (typeof scene.surfaces)[number], ring: Pt[], holes: Pt[][]): void => {
      clean.push({ ...sf, ring, holes });
    };
    for (const sf of scene.surfaces) {
      const holes = sf.holes ?? [];
      const dirty = selfIntersects(sf.ring) || hasDup(sf.ring) || holes.some((h) => selfIntersects(h) || hasDup(h));
      if (!dirty) {
        clean.push(sf);
        continue;
      }
      /**
       * 自触环（顶点重复）**必须先拆**，再谈归一化。
       *
       * Clipper 的非零绕数并集**不拆自触环**：一个"8"字环交进去、原样还回来，
       * 而 `earcut` 三角化这种环会吐出**跨越整片区域的大三角** —— 场景里表现为
       * 一块路面/铺装莫名其妙变成大三角形（用户截图里那两块）。
       * 按重复顶点拆成简单环之后，每一片都是合法多边形。
       */
      const parts = splitPinched(sf.ring);
      if (parts.length > 1) {
        splitCount++;
        for (const r of parts) {
          if (r.length < 3) continue;
          // 洞按"洞心落在哪个片里"归属
          const keep = holes.filter((h) => {
            const cx = h.reduce((a, q) => a + q.x, 0) / h.length;
            const cy = h.reduce((a, q) => a + q.y, 0) / h.length;
            return insideSurface(new Pt(cx, cy), { outer: r, holes: [] });
          });
          push(sf, r, keep);
        }
        continue;
      }
      /**
       * 真正的**自交**（边与边交叉，但没有重复顶点）必须用**旧引擎**拆。
       *
       * 实测对比同一片坏面（20 点）：
       *   · Clipper 的非零绕数并集 → 1 片，**仍然自交**；
       *   · martinez（polygon-clipping）→ 3 片简单环，自交消失。
       * 自交环进 `earcut` 会吐出跨越整片区域的大三角（用户截图里那两块铺装三角）。
       * 这是 martinez 在本项目里唯一还被保留的用途 —— 拆环，不是算布尔。
       */
      const fixed = surfaceUnionLegacy([{ outer: sf.ring, holes }]).filter((q) => q.outer.length >= 3);
      if (fixed.length === 0) continue;
      fixedCount++;
      for (const q of fixed) {
        // martinez 拆出来的片之间可能只是"单点相接"，再按重复顶点拆一次
        const sub = splitPinched(q.outer);
        if (sub.length > 1) {
          for (const r of sub) if (r.length >= 3) push(sf, r, []);
        } else {
          push(sf, q.outer, q.holes);
        }
      }
    }
    if (splitCount > 0 || fixedCount > 0) {
      scene.surfaces = clean;
      notes.push(
        `场景卫生：拆自触环 ${splitCount} 片 · 归一化自交环 ${fixedCount} 片（自触/自交会被三角化填成跨区大三角）`
      );
    }
  }

  const base: CityResult = {
    spec,
    preset,
    scene,
    stats,
    debug: {
      graph: streets.graph,
      faces: streets.faces,
      blocks: blockRes.blocks,
      tensorRegions,
      tensorLanes,
      parcels: parcelsOut,
      road,
    },
    notes,
  };

  /**
   * 禁区在这里**补一刀**。
   *
   * 禁区本身不参与生成（它改到生成之后做局部后处理，见 `zoneapply.ts`），
   * 编辑界面的做法是：基础城市按"无禁区"缓存 → 改禁区只重跑后处理。
   * 但 `CitySpec.zones` 是个公开字段，直接调 `runF3City({ zones })` 的调用方
   * （测试、导出脚本、以后接 CLI 的人）会以为禁区生效了，实际拿到的是全城。
   * 这种"静默无效"正是之前踩过的坑，所以入口这里兜一层：传了禁区就一定生效。
   *
   * 交互界面走 `f3/ui.ts`，它显式传 `zones: []` 并自己调 `applyZonesToCity`，
   * 所以不会在这里重复做一遍。
   */
  if (input.zones && input.zones.some((z) => z.enabled)) {
    return applyZonesToCity(base, input.zones, {
      padM: input.zonePadM ?? 6,
      padPave: input.zonePadPave ?? true,
    });
  }
  return base;
}

// ---------------------------------------------------------------- Scene 装配

/**
 * 草地的**四种深浅**。
 *
 * 用户要求：孤立的绿地分片随机 2~4 种绿，别整座城一个绿。
 * 取 hash(环) 选材质 —— 同一块地每次生成都一样（确定性），但相邻地块深浅不同。
 */
const GREEN_MATS: MatKey[] = ['lawn', 'grassLight', 'grass', 'grassDark'];

function ringHash(ring: Pt[]): number {
  let h = 0;
  for (let i = 0; i < ring.length; i++) {
    h = (h * 31 + Math.round(ring[i].x * 97 + ring[i].y * 13)) | 0;
  }
  return Math.abs(h);
}

function pushGround(scene: Scene, g: ReturnType<typeof groundForParcel>, parcel: BuildingParcel): void {
  const group = `lot/${parcel.use}`;
  for (const p of g.patches) {
    const isGreen = p.mat === 'lawn' || p.mat === 'grass' || p.mat === 'grassLight' || p.mat === 'grassDark';
    const mat = isGreen ? GREEN_MATS[ringHash(p.ring) % GREEN_MATS.length] : p.mat;
    scene.surfaces.push({
      name: `${parcel.id}_${p.kind}`,
      group,
      ring: p.ring,
      holes: p.holes,
      mat,
      y: p.y,
      role: 'ground',
    });
  }
  for (const [a, b] of g.stallLines) {
    scene.paths.push({
      name: `${parcel.id}_stall`,
      group: 'parking/marking',
      pts: [a, b],
      width: U(0.12),
      mat: 'markWhite',
      y: 0.03,
    });
  }
  for (const t of g.trees) scene.props.push(treeProp(t.at, t.scale, t.seed, group));
}

function pushRoads(scene: Scene, road: RoadGeom, graph: PathGraph): void {
  const add = (
    list: PlanSurface[],
    group: string,
    mat: SurfaceFeature['mat'],
    y: number,
    role: SurfaceFeature['role'],
    name: string
  ): void => {
    list.forEach((s, i) => {
      scene.surfaces.push({ name: `${name}_${i}`, group, ring: s.outer, holes: s.holes, mat, y, role });
    });
  };
  add(road.carriage, 'road/surface', 'asphalt', 0.02, 'road', 'road');
  add(road.junction, 'road/junction', 'asphalt', 0.021, 'road', 'junction');
  // 路口行人平台：与人行道同材质，边界来自同一张路网面（含圆角片）
  // 转角铺装与人行道同材质同高度：它们是同一块地面的不同记账口径，
  // 差 1 cm 高度会在 3D 里读成"转角缺了一块"
  add(road.apron, 'road/sidewalk', 'paver', 0.023, 'road', 'apron');
  add(road.curb, 'road/sidewalk', 'curb', 0.022, 'road', 'curb');
  add(road.sidewalk, 'road/sidewalk', 'paver', 0.023, 'road', 'walk');
  add(road.verge, 'road/verge', 'grassLight', 0.0235, 'road', 'verge');

  for (const m of road.markings) {
    scene.surfaces.push({
      name: 'marking',
      group: 'road/marking',
      ring: m.ring,
      mat: m.yellow ? 'markYellow' : 'markWhite',
      y: 0.031,
      role: 'overlay',
    });
  }

  /**
   * 路灯：两侧各一排、按弧长等距、错开半个间距，灯臂指向车行道中线。
   *
   * 截图里"整条街常常一盏都没有、偶尔一根横在绿带外侧"，是三个原因叠出来的：
   *   ① `junctionNodes` 拿 `widthU`（**车行全幅**）当半幅，再加固定 U(11)=11 m，
   *      让开半径虚高到 ~18 m；短街两端各删一片，中间一盏不剩；
   *   ② `count = max(2, floor(totalM/step))` 再均分弧长：短街被硬塞 2 盏，
   *      长街的实际间距又随街长漂移，读不出"等距"；
   *   ③ `rot` 用的是**外法线**方向，灯臂沿道路方向平伸，没有朝向中线
   *      （`export/props.ts` 明确约定 rot 是"灯臂伸向道路中线"）。
   * 现在直接按米沿弧长步进；两端只按半幅 + 3 m 让开路口核心；
   * rot 取位置偏移向量的反向，即从灯位指回车行道中线。
   */
  const junctionNodes: { at: Pt; r: number }[] = [];
  for (const nid of graph.junctions) {
    const n = graph.nodes.get(nid);
    if (!n) continue;
    let half = 0;
    for (const eid of new Set(n.edges)) half = Math.max(half, (graph.edges.get(eid)?.widthU ?? 0) / 2);
    junctionNodes.push({ at: n.at, r: half + U(3) });
  }
  const nearJunction = (p: Pt): boolean => junctionNodes.some((j) => Pt.distance(p, j.at) < j.r);

  for (const p of graph.paths) {
    if (p.pts.length < 2) continue;
    const sec = road.sections[p.cls];
    const half = p.widthU / 2;
    // 立在人行道靠内侧（路缘与人行道中线之间），不进绿带、不压车行道
    const off = half + U(sec.curb + sec.walk * 0.5);
    const stepM = p.cls === 'arterial' ? 28 : p.cls === 'collector' ? 34 : 42;
    const lenU = polyLen(p.pts);
    const stepU = U(stepM);
    if (lenU * 7 < 16) continue;
    const startU = Math.min(lenU * 0.5, stepU * 0.5);
    // 两侧错开半个间距：正对的两盏灯会让街道看起来像跑道。
    // 短街把错开量压到街长的 22%，保证两侧都至少落得下一盏。
    const stagger = Math.min(stepU * 0.5, lenU * 0.22);
    for (const side of [1, -1]) {
      for (let s = startU + (side > 0 ? 0 : stagger); s <= lenU * 0.94; s += stepU) {
        const at = pointAtArc(p.pts, s);
        if (!at) continue;
        const px = at.at.x - at.dir.y * off * side;
        const py = at.at.y + at.dir.x * off * side;
        const pos = new Pt(px, py);
        if (nearJunction(pos)) continue;
        scene.props.push({
          name: 'lamp',
          group: 'street',
          kind: p.cls === 'arterial' ? 'lampDouble' : 'lamp',
          at: pos,
          // 位置偏移 = side·off·(-dir.y, dir.x)，指回中线就是它的反向
          rot: Math.atan2(-at.dir.x * side, at.dir.y * side),
          scale: 1,
          seed: 0,
        });
      }
    }
  }
}

/** 折线上按弧长取点（世界单位），返回点与切线 */
function pointAtArc(pts: Pt[], sU: number): { at: Pt; dir: Pt } | null {
  let acc = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const L = Pt.distance(pts[i], pts[i + 1]);
    if (L < 1e-9) continue;
    if (acc + L >= sU) {
      const t = Math.max(0, Math.min(1, (sU - acc) / L));
      const dx = (pts[i + 1].x - pts[i].x) / L;
      const dy = (pts[i + 1].y - pts[i].y) / L;
      return { at: new Pt(pts[i].x + dx * L * t, pts[i].y + dy * L * t), dir: new Pt(dx, dy) };
    }
    acc += L;
  }
  const n = pts.length;
  const last = pts[n - 1];
  const prev = pts[n - 2] ?? last;
  const L = Pt.distance(prev, last) || 1;
  return { at: new Pt(last.x, last.y), dir: new Pt((last.x - prev.x) / L, (last.y - prev.y) / L) };
}


// ---------------------------------------------------------------- 便捷入口

/** 用多边形环构造 spec（UI 与测试都走这里） */
export function specOfRing(
  outer: Pt[],
  holes: Pt[][],
  opts: { style: CitySpec['style']; density: CitySpec['density']; program: CitySpec['program']; seed: number; heightScale?: number }
): CitySpec {
  return {
    boundary: { outer, holes },
    style: opts.style,
    density: opts.density,
    program: opts.program,
    seed: opts.seed,
    heightScale: opts.heightScale,
  };
}

/** 城市轮廓：从半径生成一个不规则多边形（页面上的"城市边界"） */
export function cityOutline(radius: number, seed: number, sides = 11): Pt[] {
  const rng = makeRng(seed, 'outline');
  const out: Pt[] = [];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    const r = radius * (0.78 + rng() * 0.26);
    out.push(new Pt(Math.cos(a) * r, Math.sin(a) * r));
  }
  return out;
}

/** 合并道路用地（导出用）：这张面已含完整路口与圆角 */
export function roadReserveOf(result: CityResult): PlanSurface[] {
  return unionPolys(result.debug.road.domain);
}

void polyLen;
