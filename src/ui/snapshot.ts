// 场景快照：把"眼前这一座城"压成一个可以塞进地址栏的字符串。
//
// 为什么需要它：
// 这座城由三类东西共同决定 —— ①种子 / 规模 / 布局这种一次性选择，②面板上
// 二十来个参数滑杆，③手画的禁建区和方向线。任何一项不同，出来的就不是同一座
// 城。靠截图对话时，人眼只能比出"绿多绿少"，比不出"种子差了一位""少了两条
// 方向线"。实际已经踩过这个坑：同一套代码、同一组面板数字，因为种子记成
// 620263530（真值 682063530）、又漏了用户手画的两条方向线，复现出来的街网
// 走向完全是另一副样子。
//
// 所以把三样一起编进 `#s=`：谁打开这个链接，看到的就是同一座城，截图可以
// 逐像素对。编码用 base64(JSON)，体积参考：默认参数 + 2 条方向线 ≈ 900 字符，
// 完全在 URL 长度限制之内。
//
// 这个模块不碰 DOM，方便在 node 里直接跑回归（test/snapshot.test.ts）。

import { Pt } from '../core/geom';
import { type Zone, type ZoneShape, makeZone } from '../town/zones';
import { type FieldGuide, makeGuide } from '../town/guide';
import type { LayoutKind } from '../town/grid';
import type { ParkLevel } from '../town/parking';
import type { PatchEdit } from '../town/patch';
import type { LandUse } from '../scene/types';
import { type TownParams, resolveParams, isParcelPattern } from '../town/params';
import type { ParcelPattern } from '../town/params';

/**
 * 单块地块覆盖的紧凑写法。
 *
 * 键是 `patchKey`（质心取整，形如 `123:-45`），值只带**真正改过**的字段：
 * 用途 u / 高度倍率 h / 切分目标面积 a / 切分模式 pt。不改就不写 ——
 * 分享链接里一条覆盖大约 20 字符，改十块地也只是两百字符的量级。
 */
export interface PatchEditSnap {
  u?: LandUse;
  h?: number;
  a?: number;
  /** 切分模式单块指定 */
  pt?: ParcelPattern;
}

/** 快照覆盖的那部分界面状态（app.ts 的 State 是它的超集） */
export interface SceneState {
  nPatches: number;
  seed: number;
  plaza: boolean;
  style: { mainStreetWidth: number; regularStreetWidth: number; alleyWidth: number };
  zones: Zone[];
  guides: FieldGuide[];
  guideStrength: number;
  layout: LayoutKind;
  parkingLevel: ParkLevel;
  params: TownParams;
  /** 单块地块的手动覆盖（键 = patchKey） */
  patchEdits: Map<string, PatchEdit>;
  /** 实验开关（S1 / Pattern / 停车 provider / R1）—— 也要进快照，否则分享链接看到的是旧算法 */
  s1Mode?: 'off' | 'golden' | 'all';
  patternMode?: 'off' | 'golden' | 'all';
  parkingProvider?: 'legacy' | 'placemaker' | 'compare';
  circulationMode?: 'off' | 'golden' | 'all';
}

// 快照格式版本。字段含义变了就 +1，老链接会被安全忽略而不是解析出半座城
export const SNAPSHOT_VERSION = 1;

type ZoneShapeSnap =
  | { kind: 'rect'; a: [number, number]; b: [number, number] }
  | { kind: 'circle'; c: [number, number]; r: number }
  | { kind: 'poly'; pts: number[] };

export interface Snapshot {
  v: number;
  /** nPatches，街区数 */
  n: number;
  /** seed */
  s: number;
  /** plaza 0/1 */
  pz: 0 | 1;
  l: LayoutKind;
  pk: ParkLevel;
  /** 三档红线宽 [主干, 次干, 支路]，世界单位 */
  st: [number, number, number];
  /** guideStrength */
  gs: number;
  g: { id: string; label: string; on: 0 | 1; s: number; pts: number[] }[];
  z: { id: string; label: string; on: 0 | 1; p: string; shape: ZoneShapeSnap }[];
  pr: TownParams;
  /** 单块地块的手动覆盖（可选：老链接没有这一段） */
  pe?: Record<string, PatchEditSnap>;
  /**
   * 实验开关（都可选，老链接没有这几项）。
   *
   * 为什么必须进快照：`?s1=` `?pattern=` `?parkingProvider=` 原来只走 query，
   * 而快照链接（`#s=…`）是"把当前这一屏存下来"的语义 —— 分享出去之后
   * 对方看到的还是旧算法，于是"地址导致版本不对"。现在它们和 seed 一样，
   * 是这一屏的一部分。
   */
  s1?: 'off' | 'golden' | 'all';
  ptn?: 'off' | 'golden' | 'all';
  pp?: 'legacy' | 'placemaker' | 'compare';
  cm?: 'off' | 'golden' | 'all';
}

/** 两位小数：1 世界单位 ≈ 7 m，0.01 单位 ≈ 7 cm，够用且能压掉浮点噪声 */
const r2 = (v: number): number => Math.round(v * 100) / 100;

// base64url：标准 base64 里的 `+` `/` 塞进 URL 会被各类工具二次转义/截断，
// 换成 `-` `_` 并去掉尾部 `=`，链接复制到哪儿都不会变形。
function b64encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64decode(b: string): string {
  const t = b.replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (t.length % 4)) % 4;
  const bin = atob(t + '='.repeat(pad));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function shapeOut(s: ZoneShape): ZoneShapeSnap {
  if (s.kind === 'rect') return { kind: 'rect', a: [r2(s.a.x), r2(s.a.y)], b: [r2(s.b.x), r2(s.b.y)] };
  if (s.kind === 'circle') return { kind: 'circle', c: [r2(s.c.x), r2(s.c.y)], r: r2(s.r) };
  return { kind: 'poly', pts: s.pts.flatMap((p) => [r2(p.x), r2(p.y)]) };
}

function shapeIn(s: ZoneShapeSnap): ZoneShape {
  if (s.kind === 'rect') return { kind: 'rect', a: new Pt(s.a[0], s.a[1]), b: new Pt(s.b[0], s.b[1]) };
  if (s.kind === 'circle') return { kind: 'circle', c: new Pt(s.c[0], s.c[1]), r: s.r };
  const pts: Pt[] = [];
  for (let i = 0; i + 1 < s.pts.length; i += 2) pts.push(new Pt(s.pts[i], s.pts[i + 1]));
  return { kind: 'poly', pts };
}

export function snapshotOf(st: SceneState): Snapshot {
  const pe: Record<string, PatchEditSnap> = {};
  for (const [key, e] of st.patchEdits ?? []) {
    if (!e) continue;
    const o: PatchEditSnap = {};
    if (e.use) o.u = e.use;
    if (typeof e.heightK === 'number' && Math.abs(e.heightK - 1) > 1e-3) o.h = r2(e.heightK);
    if (typeof e.parcelTargetA === 'number' && e.parcelTargetA > 0) o.a = r2(e.parcelTargetA);
    if (e.pattern) o.pt = e.pattern;
    // 字段都没改就别写进链接（"我点过这块地但什么都没改"不该占字符）
    if (Object.keys(o).length > 0) pe[key] = o;
  }

  return {
    v: SNAPSHOT_VERSION,
    n: st.nPatches,
    s: st.seed,
    pz: st.plaza ? 1 : 0,
    l: st.layout,
    pk: st.parkingLevel,
    st: [r2(st.style.mainStreetWidth), r2(st.style.regularStreetWidth), r2(st.style.alleyWidth)],
    gs: r2(st.guideStrength),
    g: st.guides.map((g) => ({
      id: g.id,
      label: g.label,
      on: g.enabled ? 1 : 0,
      s: r2(g.strength),
      pts: g.pts.flatMap((p) => [r2(p.x), r2(p.y)]),
    })),
    z: st.zones.map((z) => ({
      id: z.id,
      label: z.label,
      on: z.enabled ? 1 : 0,
      p: z.purpose ?? 'cbd',
      shape: shapeOut(z.shape),
    })),
    pr: st.params,
    ...(Object.keys(pe).length > 0 ? { pe } : {}),
    // 只写"非默认"的值：默认组合不占字符，老链接也不受影响
    ...(st.s1Mode && st.s1Mode !== 'off' ? { s1: st.s1Mode } : {}),
    ...(st.patternMode && st.patternMode !== 'off' ? { ptn: st.patternMode } : {}),
    ...(st.parkingProvider && st.parkingProvider !== 'legacy' ? { pp: st.parkingProvider } : {}),
    ...(st.circulationMode && st.circulationMode !== 'all' ? { cm: st.circulationMode } : {}),
  };
}

/** 场景 → 地址栏片段（不含 `#s=` 前缀） */
export function encodeSnapshot(st: SceneState): string {
  return b64encode(JSON.stringify(snapshotOf(st)));
}

/** 地址栏片段 → 快照。解析失败返回 null（调用方退回默认场景，不要抛） */
export function decodeSnapshot(text: string): Snapshot | null {
  try {
    const sn = JSON.parse(b64decode(text)) as Snapshot;
    if (!sn || sn.v !== SNAPSHOT_VERSION) return null;
    return sn;
  } catch {
    return null;
  }
}

/**
 * 把快照写回状态对象。
 *
 * 容错原则：缺字段就用状态里原来的值，绝不因为一个字段缺失把整座城扔掉 ——
 * 分享链接跨版本打开时要能"尽量接近"，而不是白屏。
 */
export function applySnapshot(st: SceneState, sn: Snapshot): boolean {
  if (!sn || sn.v !== SNAPSHOT_VERSION) return false;

  if (Number.isFinite(sn.n)) st.nPatches = sn.n;
  if (Number.isFinite(sn.s)) st.seed = sn.s;
  st.plaza = sn.pz === 1;
  if (sn.l) st.layout = sn.l;
  if (sn.pk) st.parkingLevel = sn.pk;

  if (Array.isArray(sn.st) && sn.st.length === 3) {
    st.style = {
      mainStreetWidth: sn.st[0],
      regularStreetWidth: sn.st[1],
      alleyWidth: sn.st[2],
    };
  }
  if (Number.isFinite(sn.gs)) st.guideStrength = sn.gs;

  if (sn.s1 === 'off' || sn.s1 === 'golden' || sn.s1 === 'all') st.s1Mode = sn.s1;
  if (sn.ptn === 'off' || sn.ptn === 'golden' || sn.ptn === 'all') st.patternMode = sn.ptn;
  if (sn.pp === 'legacy' || sn.pp === 'placemaker' || sn.pp === 'compare') st.parkingProvider = sn.pp;
  if (sn.cm === 'off' || sn.cm === 'golden' || sn.cm === 'all') st.circulationMode = sn.cm;

  if (Array.isArray(sn.g)) {
    const out: FieldGuide[] = [];
    for (const g of sn.g) {
      if (!Array.isArray(g.pts) || g.pts.length < 4) continue;
      const pts: Pt[] = [];
      for (let i = 0; i + 1 < g.pts.length; i += 2) pts.push(new Pt(g.pts[i], g.pts[i + 1]));
      const gd = makeGuide(g.id, g.label, pts, g.s ?? 0.8);
      gd.enabled = g.on !== 0;
      out.push(gd);
    }
    st.guides = out;
  }

  if (Array.isArray(sn.z)) {
    const out: Zone[] = [];
    for (const z of sn.z) {
      if (!z.shape) continue;
      const zone = makeZone(z.id, z.label, shapeIn(z.shape), (z.p as Zone['purpose']) ?? 'cbd');
      zone.enabled = z.on !== 0;
      out.push(zone);
    }
    st.zones = out;
  }

  if (sn.pr?.block && sn.pr?.building && sn.pr?.green) st.params = resolveParams(sn.pr);

  // 单块地块覆盖：只认能解析出来的字段，坏一条不影响别的地块
  if (sn.pe && typeof sn.pe === 'object') {
    const m = new Map<string, PatchEdit>();
    for (const [key, v] of Object.entries(sn.pe)) {
      if (!v || typeof v !== 'object') continue;
      const e: PatchEdit = {};
      if (typeof v.u === 'string') e.use = v.u as LandUse;
      if (typeof v.h === 'number' && Number.isFinite(v.h) && v.h > 0) e.heightK = v.h;
      if (typeof v.a === 'number' && Number.isFinite(v.a) && v.a > 0) e.parcelTargetA = v.a;
      if (isParcelPattern(v.pt)) e.pattern = v.pt;
      if (Object.keys(e).length > 0) m.set(key, e);
    }
    st.patchEdits = m;
  }
  return true;
}
