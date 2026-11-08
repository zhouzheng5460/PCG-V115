// F2.4-D · 三个真实地块 + 不规则抽查地块的输入构造（多个脚本共用）
//
// 抽出来的原因和 `fixtures-parcels` 一样：输入口径一旦不一致，
// 图上的差异就分不清是算法改动还是输入改动。

import { Pt } from '../src/core/geom';
import { surfaceInset } from '../src/town/planning/core/surface';
import type { PlanSurface } from '../src/town/planning/core/surface';
import { buildSiteContext } from '../src/town/planning/core/context';
import type { SiteContext, SiteRoadEdge } from '../src/town/planning/core/types';
import { Model } from '../src/town/model';
import { buildRoadNet } from '../src/road/system';
import { patchKey } from '../src/town/patch';
import { siteContextFromModel } from '../src/town/planning/adapters/model';
import type { ComposeInput } from '../src/town/planning/compose';
import { CASE_BY_ID } from './fixtures-parcels';

export const SEED = 682063530;

let cachedModel: Model | null = null;
let cachedNet: ReturnType<typeof buildRoadNet> | null = null;

export function townModel(): Model {
  if (!cachedModel) {
    cachedModel = new Model({ nPatches: 15, seed: SEED, plaza: true });
    cachedModel.generate();
  }
  return cachedModel;
}

export function townNet(): ReturnType<typeof buildRoadNet> {
  if (!cachedNet) cachedNet = buildRoadNet(townModel());
  return cachedNet;
}

/** 地块 → SiteContext（真实红线、真实道路、合法接入） */
export function siteOfPatch(key: string): SiteContext {
  const patch = townModel().patches.find((x) => patchKey(x) === key)!;
  return siteContextFromModel(townModel(), patch, { net: townNet() });
}

function entrancesFromRoads(boundary: PlanSurface, roads: SiteRoadEdge[]): Pt[] {
  const out: Pt[] = [];
  for (const e of roads) {
    const mid = new Pt((e.a.x + e.b.x) / 2, (e.a.y + e.b.y) / 2);
    let best = mid;
    let bd = Infinity;
    for (let i = 0; i < boundary.outer.length; i++) {
      const a = boundary.outer[i];
      const c = boundary.outer[(i + 1) % boundary.outer.length];
      const dx = c.x - a.x;
      const dy = c.y - a.y;
      const l2 = dx * dx + dy * dy || 1;
      let t = ((mid.x - a.x) * dx + (mid.y - a.y) * dy) / l2;
      t = Math.max(0, Math.min(1, t));
      const q = new Pt(a.x + dx * t, a.y + dy * t);
      const d = Pt.distance(mid, q);
      if (d < bd) {
        bd = d;
        best = q;
      }
    }
    if (!out.some((p) => Pt.distance(p, best) < 3)) out.push(best);
  }
  return out;
}

/** 合成输入 */
export function inputOf(id: string): ComposeInput {
  if (CASE_BY_ID.has(id)) {
    const c = CASE_BY_ID.get(id)!;
    const ins = surfaceInset(c.boundary, 5 / 7);
    const ent = entrancesFromRoads(c.boundary, c.roads);
    return {
      id,
      typology: c.typology,
      boundary: c.boundary,
      buildable: ins.length > 0 ? ins[0] : c.boundary,
      roadEdges: c.roads,
      vehicleEntrances: ent,
      pedestrianEntrances: ent.slice(0, 1),
      seed: SEED,
    };
  }
  const site = siteOfPatch(KEY_OF[id] ?? id);
  return {
    id,
    typology: site.typology,
    boundary: site.parcel,
    buildable: site.buildableArea,
    roadEdges: site.roadEdges,
    vehicleEntrances: site.vehicleAccessCandidates.slice(0, 2).map((a) => a.at),
    pedestrianEntrances: site.pedestrianAccessCandidates.slice(0, 2).map((a) => a.at),
    seed: SEED,
  };
}

/** 展示名 → 真实 patchKey */
export const KEY_OF: Record<string, string> = {
  R01: '-469:284',
  C01: '176:176',
  I01: '252:-578',
};

/** 保持与 core 版一致的退线口径（供需要 SiteContext 的旧算法对照使用） */
export function legacyContext(id: string): SiteContext | null {
  const key = KEY_OF[id];
  if (!key) {
    const c = CASE_BY_ID.get(id);
    if (!c) return null;
    const ins = surfaceInset(c.boundary, 5 / 7);
    return buildSiteContext({
      parcelId: id,
      parcel: c.boundary,
      buildableArea: ins.length > 0 ? ins[0] : c.boundary,
      roadEdges: c.roads,
      typology: c.typology,
      accessPoints: entrancesFromRoads(c.boundary, c.roads),
    } as unknown as Parameters<typeof buildSiteContext>[0]);
  }
  return siteOfPatch(key);
}
