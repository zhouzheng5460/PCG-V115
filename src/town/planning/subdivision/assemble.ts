// F2 · 候选装配（策略之后的统一收口）
//
// 策略只产出"叶子面"，把面变成合法候选的每一步都在这里，且**只有一份**：
// 临街、接入、可用区、指标、邻接、角色。
//
// 这样做的原因很直接：如果 Recursive OBB 自己算一套临街、Street-front 再算一套，
// 两边的"有效临街比例"就不可比，报告里的对照表也就失去意义。

import { Pt } from '../../../core/geom';
import {
  surfaceArea,
  surfaceIntersect,
  surfaceSubtract,
  type PlanSurface,
} from '../core/surface';
import { mergeParts, overlapAreaM2, sharedBoundaryLength } from './geom';
import { unionConnected } from './repair';
import { isFragment, metricsOf, type MetricsFrame } from './metrics';

const M2 = (u2: number) => u2 * 49;
import { alleyAccessOf, frontagesOf, roadAccessOf, sharedBoundaryWith } from './relations';
import type {
  PieceRole,
  SubdivisionCandidate,
  SubdivisionContext,
  SubdivisionNote,
  SubdivisionParams,
  CutRecord,
  AccessRef,
} from './types';

export interface LeafInput {
  surface: PlanSurface;
  /** 指定角色（Compound / Reserved 用），不给则按规则推断 */
  role?: PieceRole;
  cut?: CutRecord;
  notes?: SubdivisionNote[];
  frame?: MetricsFrame;
  /** 显式标记：这块是主动保留的空间，不要求接入 */
  reservedReason?: string;
}

/** 单次装配的临时记录 */
interface Temp {
  leaf: LeafInput;
  id: string;
  frontages: ReturnType<typeof frontagesOf>;
  access: AccessRef[];
  notes: SubdivisionNote[];
}

export interface AssembleResult {
  candidates: SubdivisionCandidate[];
  /** 装配阶段的策略级备注（例如"带被裁剪损失 3 m²"） */
  notes: SubdivisionNote[];
}

/**
 * 把叶子面装配成候选。
 *
 * 接入规则（硬约束，顺序固定、可复现）：
 *   ① 有真实临街（共享长度 ≥ alleyM）→ 路上开口：车行 + 人行；
 *   ② 没有临街，但与某块**有临街**的兄弟共享边界 ≥ alleyM → 巷接（显式标记）；
 *   ③ 都没有 → 不给入口（由验证层报 no-access，绝不自造道路）。
 */
export function assemble(
  ctx: SubdivisionContext,
  params: SubdivisionParams,
  method: string,
  leaves: LeafInput[]
): AssembleResult {
  const notes: SubdivisionNote[] = [];
  // 固定建筑先定归属（整栋只归一块地），再谈临街与接入 —— 顺序反了会让"挖楼"改变临街判据
  const assigned = assignFixedBuildings(leaves, ctx);
  const temps: Temp[] = assigned.map((leaf, i) => ({
    leaf,
    id: `${ctx.id}/${method === 'recursive-obb' ? 'obb' : 'off'}/${i + 1}`,
    frontages: frontagesOf(leaf.surface, ctx.roadEdges),
    access: [],
    notes: [...(leaf.notes ?? [])],
  }));

  // ① 直接临路
  for (const t of temps) {
    t.access = roadAccessOf(t.leaf.surface, t.frontages, { minWidthM: params.alleyM });
  }

  // ② 巷接网络（BFS）
  //
  // 早先的写法是"每个后排块都去找一个**直接临街**的兄弟"，两个问题：
  //   · 深地块的第三排找不到直接临街的兄弟 → 被判定"无入口"，只能整块不切
  //     （实测 G01 50% 的面积因此被标成"预留"）；
  //   · 结果依赖遍历顺序，同一块地换个顺序判出来的接入不一样。
  //
  // 真实形态是一条巷道串起几排：第一排临街，第二排接第一排，第三排接第二排。
  // 所以这里建成**图**：边 = 共享边界 ≥ alleyM，种子 = 有路上接入的块，
  // BFS 依次把"巷接"分配下去，并记录链路深度（深度 > 1 说明要串两条巷，必须报出来）。
  const byId = new Map(temps.map((t) => [t.id, t]));
  const visited = new Set<string>(temps.filter((t) => t.access.length > 0).map((t) => t.id));
  let frontier = temps.filter((t) => t.access.length > 0);
  const depthOf = new Map<string, number>(frontier.map((t) => [t.id, 0]));
  while (frontier.length > 0) {
    const next: Temp[] = [];
    for (const cur of frontier) {
      const cands = temps
        .filter((o) => !visited.has(o.id) && byId.get(o.id))
        .map((o) => ({ o, shared: sharedBoundaryWith(cur.leaf.surface, o.leaf.surface).lengthM }))
        .filter((d) => d.shared >= params.alleyM)
        .sort((x, y) => y.shared - x.shared || x.o.id.localeCompare(y.o.id));
      for (const c of cands) {
        const a = alleyAccessOf(c.o.leaf.surface, cur.leaf.surface, cur.id, params.alleyM);
        if (!a) continue;
        const depth = (depthOf.get(cur.id) ?? 0) + 1;
        depthOf.set(c.o.id, depth);
        c.o.access.push(a);
        c.o.notes.push({
          code: 'alley-access',
          severity: depth > 1 ? 'warn' : 'info',
          message:
            `${c.o.id} 经 ${cur.id} 的共享边界接入（${c.shared.toFixed(1)} m）` +
            (depth > 1 ? `，巷接链第 ${depth} 跳：需要连续两段以上内部通道` : '，需铺内部通道'),
          at: a.at,
        });
        visited.add(c.o.id);
        next.push(c.o);
      }
    }
    frontier = next;
  }
  for (const t of temps) {
    if (t.access.length === 0) {
      t.notes.push({
        code: 'no-access',
        severity: 'error',
        message: `${t.id} 无临街面，巷接网络也覆盖不到（共享边界均不足 ${params.alleyM} m）`,
        at: t.leaf.surface.outer[0],
      });
    }
  }

  // ③ 既有出入口（固定建筑模式）：点落在本块内就承接
  if (ctx.existingAccess) {
    for (const t of temps) {
      for (const ea of ctx.existingAccess) {
        if (!pointIn(t.leaf.surface, ea.at)) continue;
        if (t.access.some((a) => Pt.distance(a.at, ea.at) < 1)) continue;
        t.access.push({
          kind: ea.kind,
          at: ea.at,
          normal: new Pt(0, 0),
          via: 'existing',
          requiresInternalLane: false,
        });
        t.notes.push({ code: 'access-rejected', severity: 'info', message: `${t.id} 承接既有出入口`, at: ea.at });
      }
    }
  }

  // 邻接关系
  const neighborsOf = (i: number) =>
    temps
      .map((o, j) => ({ j, o }))
      .filter(({ j }) => j !== i)
      .map(({ j, o }) => ({ id: o.id, sharedBoundaryM: sharedBoundaryLength(temps[i].leaf.surface, o.leaf.surface), j }))
      .filter((n) => n.sharedBoundaryM >= 1)
      .map(({ id, sharedBoundaryM }) => ({ id, sharedBoundaryM: +sharedBoundaryM.toFixed(1) }));

  const candidates: SubdivisionCandidate[] = temps.map((t, i) => {
    const metrics = metricsOf(t.leaf.surface, t.frontages, t.leaf.frame);
    const frag = isFragment(metrics, params.minAreaM2, params.minWidthM);
    let role: PieceRole = t.leaf.role ?? 'parcel';
    // 接不进去的块**不是** reserved（reserved 指主动保留的公共/生态空间）。
    // 它只能算 fragment，并且带着 no-access 的 error 记录进验证报告。
    if (!t.leaf.role) role = t.access.length === 0 || frag ? 'fragment' : 'parcel';
    const developable = role === 'parcel' || role === 'compound' ? t.access.length > 0 && !frag : false;

    if (frag && role === 'parcel') {
      t.notes.push({
        code: 'sliver',
        severity: 'warn',
        message: `${t.id} 残片：瓶颈宽 ${metrics.bottleneckM.toFixed(1)} m / 面积 ${metrics.areaM2.toFixed(0)} m²`,
      });
    }
    if (role === 'compound') {
      t.notes.push({ code: 'rear-compound', severity: 'info', message: `${t.id} 保留为组团（不切分）` });
    }

    // 可用区 = 本块 ∩ 可建区 − 固定建筑
    let usable: PlanSurface = { outer: [], holes: [] };
    try {
      const inter = surfaceIntersect([t.leaf.surface], [ctx.buildable]);
      const minus = ctx.fixedBuildings.length > 0 ? surfaceSubtract(inter, ctx.fixedBuildings) : inter;
      const best = mergeParts(minus);
      if (best) usable = best;
      if (minus.length > 1) {
        t.notes.push({
          code: 'fragment-merged',
          severity: 'info',
          message: `${t.id} 可用区被固定建筑切成 ${minus.length} 块，取最大块（${(surfaceArea(best ?? minus[0]) * 49).toFixed(0)} m²）`,
        });
      }
    } catch {
      t.notes.push({ code: 'boolean-failed', severity: 'warn', message: `${t.id} 可用区布尔运算失败` });
    }

    return {
      id: t.id,
      parentId: ctx.parentId,
      method,
      methodParams: {
        targetAreaM2: params.targetAreaM2,
        frontageM: params.frontageM,
        depthM: params.depthM,
        minAreaM2: params.minAreaM2,
        minWidthM: params.minWidthM,
        alleyM: params.alleyM,
        ratio: params.ratio ?? null,
        maxRecursion: params.maxRecursion,
      },
      surface: t.leaf.surface,
      usable,
      frontages: t.frontages,
      access: t.access,
      neighbors: neighborsOf(i),
      metrics,
      role,
      developable,
      notes: t.notes,
      cut: t.leaf.cut,
    };
  });

  return { candidates, notes };
}

function pointIn(s: PlanSurface, p: Pt): boolean {
  const inside = (ring: Pt[]) => {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i];
      const b = ring[j];
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y || 1e-12) + a.x) c = !c;
    }
    return c;
  };
  if (!inside(s.outer)) return false;
  for (const h of s.holes) if (inside(h)) return false;
  return true;
}

/**
 * 固定建筑归属：整栋只归一块地，其余地块把它挖掉。
 *
 * 为什么必须在装配阶段统一做（而不是让策略各自避让）：
 *   · OBB 已经尽量不切线穿楼，但 Offset 的沿街带域天然会压到沿街建筑；
 *   · 只要"归属唯一"，下游"楼不能被切开 / 楼必须有归属"两条硬约束同时成立；
 *   · 两个策略共用一份规则，报告里的"建筑保护"数字才有可比性。
 *
 * 规则是确定性的：重叠面积最大者得；其余地块从楼边上让开。
 * **让开时产生的多个连通块必须全部保留** —— 只留最大块会凭空丢面积，
 * 实测 G08 因此掉了 2316 m²（约半个建筑群），面积对账立刻失败。
 */
function assignFixedBuildings(leaves: LeafInput[], ctx: SubdivisionContext): LeafInput[] {
  if (ctx.fixedBuildings.length === 0) return leaves;
  let list: LeafInput[] = leaves.map((l) => ({ ...l, notes: [...(l.notes ?? [])] }));
  for (let bi = 0; bi < ctx.fixedBuildings.length; bi++) {
    const b = ctx.fixedBuildings[bi];
    const ov = list.map((l) => overlapAreaM2(b, l.surface).m2);
    let owner = -1;
    let best = 0;
    ov.forEach((a, i) => {
      if (a > best) {
        best = a;
        owner = i;
      }
    });
    if (owner < 0) continue;
    list[owner].notes!.push({
      code: 'building-crossed',
      severity: 'info',
      message: `承接固定建筑 #${bi + 1}（${best.toFixed(0)} m² 落在地块内）`,
    });
    const extras: LeafInput[] = [];
    for (let i = 0; i < list.length; i++) {
      if (i === owner || ov[i] < 0.5) continue;
      try {
        const rest = surfaceSubtract([list[i].surface], [b]).filter((q) => surfaceArea(q) > 1e-6);
        if (rest.length === 0) continue;
        rest.sort((x, y) => surfaceArea(y) - surfaceArea(x));
        list[i] = {
          ...list[i],
          surface: rest[0],
          notes: [
            ...(list[i].notes ?? []),
            { code: 'building-crossed', severity: 'info', message: `从固定建筑 #${bi + 1} 边上让开（该楼归属另一地块）` },
          ],
        };
        for (let k = 1; k < rest.length; k++) {
          extras.push({
            surface: rest[k],
            role: 'fragment',
            notes: [
              { code: 'building-crossed', severity: 'info', message: `让开固定建筑 #${bi + 1} 后脱落的一小块，按残片保留` },
            ],
          });
        }
      } catch {
        /* 让不开就原样保留，验证层会报重叠 */
      }
    }
    if (extras.length > 0) list = list.concat(extras);

    // 归属块要**吃下整栋楼**，不能只留在它自己的那半个。
    //
    // 这一步是面积对账的关键：邻块把楼挖掉之后，如果归属块只覆盖楼的 60%，
    // 剩下 40% 就成了"谁都不管"的缺口 —— 实测 G08 三栋楼因此凭空少了 2062 m²，
    // 面积对账立刻失败（而视觉上完全看不出来，因为缺口正好被建筑的黑色盖住）。
    // 只吃**红线以内**的那部分：既有建筑压在红线上是常态（实测 I01 有楼探出 738 m²），
    // 直接并入整栋会把地块顶到父边界外 —— 那就从"面积对不上"变成"越界"了。
    let bIn: PlanSurface[] = [];
    try {
      bIn = surfaceIntersect([b], [ctx.boundary]).filter((q) => surfaceArea(q) > 1e-9);
    } catch {
      bIn = [];
    }
    const absorbed = bIn.length > 0 ? unionConnected(list[owner].surface, bIn[0]) : null;
    if (absorbed) {
      list[owner] = { ...list[owner], surface: absorbed };
    } else {
      list[owner].notes!.push({
        code: 'boolean-failed',
        severity: 'warn',
        message: `固定建筑 #${bi + 1} 无法并入归属地块（并集失败），保持原状`,
      });
    }
  }
  return list;
}
