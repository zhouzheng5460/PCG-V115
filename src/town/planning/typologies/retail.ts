// Typology · Retail（PRD §9 / §P2 freeze §6）
//
// 第三套语法，和前两套都不同：
//   工业：建筑在前、后勤在后（纵深分区）
//   住宅：院子在中间、建筑围着（围合）
//   零售：**建筑一条 + 前方大停车 + 顾客动线 + 后侧服务**（多流线并行）
//
// 零售的命门不是"围合"，也不是"客货分离"，而是：
//   · 店铺能不能被看见（frontageQuality）；
//   · 顾客从停车走到店门顺不顺（pedestrianClarity）；
//   · 卸货会不会穿过顾客区（serviceSeparation）；
//   · 停车够不够、车道连不连（parkingQuality + circulationQuality）。

import type { LayoutDiagnostics, SiteContext } from '../core/types';
import type { GroundProgram, SitePlanCandidate } from '../core/candidate';
import { surfaceArea, surfaceIntersect, pointInRing } from '../core/surface';
import { Pt } from '../../../core/geom';

/** Phase 2 允许的零售地面程序 */
export const RETAIL_GROUND_WHITELIST: GroundProgram[] = [
  'parking',
  'pedestrian',
  'entrance_forecourt',
  'service',
  'landscape',
  'residual',
  // S1（场地布局骨架）：**场地内部的机动车主通道**。
  // 复用 `driveway` 而不是新造一个 program —— 它在 ground-ownership 里
  // 已经是优先级最高（100）的 overlay，天然压过绿地和停车，
  // 语义也正是"地块内的车道"。
  'driveway',
];

/** 店铺进深（米）：太深顾客走不进去，太浅放不下货架 */
export const SHOP_DEPTH_M = 22;

/**
 * 零售的**强度目标带**（R7.7）。
 *
 * 零售是单层大盒，所以"覆盖率 ≈ FAR"这条换算直接成立。近郊 strip center 的
 * FAR 常态就是 0.15~0.30；低于 12% 基本是"停车场为主、商业界面很弱"的空场，
 * 高于 34% 的 strip 通常要上楼或做停车楼 —— 那是 PAD / 城市商业的活，不是 STRIP。
 *
 * 这条带的作用不是"把数拉到和 Legacy 一样"（Legacy 中位数只有 13%，那是偏低的），
 * 而是给 Evaluator 一个**两侧都扣分**的靶子，避免"盖得越满 typologyFit 越高"。
 */
export const RETAIL_INTENSITY = {
  min: 0.12,
  preferredMin: 0.16,
  preferredMax: 0.26,
  max: 0.34,
};

/**
 * 覆盖度拟合（0~1）：带内满分、带外两侧都扣。
 * 不新增 Diagnostic，只折算进现有 `typologyFit`（Freeze §6）。
 */
export function retailCoverageFit(actual: number, band = RETAIL_INTENSITY): number {
  if (actual >= band.preferredMin && actual <= band.preferredMax) {
    // 带内仍轻微偏好靠中间，否则贴上限和中间同分，winner 会被推向上限
    const center = (band.preferredMin + band.preferredMax) / 2;
    const half = Math.max(0.01, (band.preferredMax - band.preferredMin) / 2);
    return clamp01(1 - (Math.abs(actual - center) / half) * 0.12);
  }
  if (actual < band.preferredMin) {
    const span = Math.max(0.02, band.preferredMin - band.min);
    return clamp01(1 - (band.preferredMin - actual) / span);
  }
  const span = Math.max(0.02, band.max - band.preferredMax);
  return clamp01(1 - ((actual - band.preferredMax) / span) * 0.9);
}

/**
 * 三段式饱和曲线（与 Industrial 同一套口径）。
 * < lo 明显不足；lo~knee 快速加分；knee~hi 缓慢加分；> hi 不再加分。
 */
function saturate(v: number, lo: number, knee: number, hi: number): number {
  if (v <= lo) return clamp01((v / Math.max(1e-6, lo)) * 0.35);
  if (v <= knee) return 0.35 + ((v - lo) / Math.max(1e-6, knee - lo)) * 0.55;
  if (v <= hi) return 0.9 + ((v - knee) / Math.max(1e-6, hi - knee)) * 0.1;
  return 1;
}

/**
 * 顾客停车拟合。
 *
 * 旧口径是 `parkRatio / 0.32` 封顶 —— 也就是"停车越多分越高"，实测 61% 的块
 * 也拿满分。那等于把"停车场配一间店"判成最优。现在 26%~42% 给满分区，
 * 超过 50% 开始轻微扣（城市性变差，店铺界面被车位吞掉）。
 */
export function retailParkingFit(parkRatio: number): number {
  const base = saturate(parkRatio, 0.12, 0.26, 0.42);
  if (parkRatio <= 0.5) return base;
  // 50% → 60% 掉 0.3，65% 以后封底 0.55：停车吃掉店铺界面是真实的质量损失
  return clamp01(base * (1 - Math.min(0.6, ((parkRatio - 0.5) / 0.2) * 0.6)));
}

/**
 * 零售诊断。
 *
 * 注意"可见性"这一项**没有**新开字段：它映射到 `frontageQuality`
 * —— Freeze §6 明确要求新类型优先复用现有诊断。
 */
export function retailDiagnostics(ctx: SiteContext, c: SitePlanCandidate): LayoutDiagnostics {
  const lotArea = Math.max(1e-6, surfaceArea(ctx.parcel));
  const shop = c.buildings.find((b) => b.role === 'podium' || b.role === 'office');
  // 停车场可能被穿场步行道切成两片（真实超市就是这样），
  // 所以**面积要按所有 parking 块合计**，不能只取第一块 ——
  // 只取一块会让停车面积凭空减半，R05 直接判"停车区过小"。
  const parkParts = c.ground.filter((g) => g.program === 'parking');
  const parking = parkParts[0];
  // 停车楼：地面停车被立体化之后，地面面积会少掉 2/3，但**车位没少**。
  // 按"等效地面面积"折算（一栋 3 层停车楼 = 3 倍地面面积，其中 1 层仍在地面），
  // 否则 parkingQuality 会因为"立体化"而掉分 —— 那等于惩罚正确做法。
  const garage = c.buildings.find((b) => (b.notes ?? []).some((n) => n.includes('停车楼')));
  const garageEquiv = garage ? surfaceArea(garage.footprint) * 2 : 0;
  const parkArea = parkParts.reduce((a, g) => a + g.area, 0) + garageEquiv;
  const fore = c.ground.find((g) => g.program === 'entrance_forecourt');
  const pedRegion = c.ground.find((g) => g.program === 'pedestrian');
  const service = c.ground.find((g) => g.program === 'service');
  const residual = c.ground.find((g) => g.program === 'residual');
  void service;

  // ① 可见性：店铺沿主街的长度 / 地块临街面宽（映射到 frontageQuality）
  //
  // 旧口径 `shopLen / (lotLen * 0.75)` 在"店铺占满临街"时恒 ≥1，clamp 后全是 1.00，
  // 这一项完全没有区分度（实测 27 块地里 25 块是 1.00 / 2 块 0.94）。
  // 改成三段式：占到临街 65% 就该满分，占到 100% 不再额外奖励。
  const frontShare =
    shop && ctx.primaryFrontage ? longestSideM(shop.footprint.outer) / Math.max(1, ctx.primaryFrontage.edge.len * 7) : 0;

  // ② 店面**贴街**程度：从临街边到店铺 footprint 的最短距离（米）。
  //
  //    `frontShare` 只说明"店有多长"，说明不了"看不看得见店"。
  //    front-park 变体把 24~30 m 的停车场摆在店前面，frontShare 仍然接近 1，
  //    于是"街道被停车场占满"在评分上完全不受惩罚 —— 实测街墙率
  //    front-park 17% / rear-park 75%，而两者当期得分几乎一样。
  //    这是度量测错了对象，不是"想要某个 winner"。
  const shopSetbackM = (() => {
    if (!shop || !ctx.primaryFrontage) return 99;
    const [ea, eb] = ctx.primaryFrontage.parcelEdge;
    const dx = eb.x - ea.x;
    const dy = eb.y - ea.y;
    const L2 = dx * dx + dy * dy;
    let best = Infinity;
    for (const p of shop.footprint.outer) {
      const t = L2 > 0 ? clamp01(((p.x - ea.x) * dx + (p.y - ea.y) * dy) / L2) : 0;
      const qx = ea.x + dx * t;
      const qy = ea.y + dy * t;
      best = Math.min(best, Math.hypot(p.x - qx, p.y - qy));
    }
    return best * 7;
  })();
  // 贴街度：<= 6 m 满分（5 m 退线 + 1 m 余量），到 20 m（一个停车进深）为 0
  const streetFront = clamp01(1 - (shopSetbackM - 6) / 14);
  const frontageVisible = clamp01(0.55 * saturate(frontShare, 0.35, 0.65, 1.0) + 0.45 * streetFront);
  const frontageQuality = clamp01(0.6 * frontageVisible + 0.4 * (ctx.primaryFrontage?.score ?? 0));

  // ② 顾客动线：从停车区/街到店门有没有被车流切断
  const ped = c.access.find((a) => a.role === 'pedestrian');
  let pedestrianClarity = 0;
  if (ped && shop) {
    const door = centroid(shop.footprint.outer);
    const steps = 10;
    let blockedByCars = 0;
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const p = new Pt(ped.at.x + (door.x - ped.at.x) * t, ped.at.y + (door.y - ped.at.y) * t);
      // 穿过停车区且没有专门的步行带 → 扣分
      if (parkParts.some((g) => pointInRing(p, g.surface.outer)) && !pedRegion) blockedByCars++;
    }
    pedestrianClarity = clamp01(1 - blockedByCars / (steps - 1));
    if (pedRegion) pedestrianClarity = clamp01(pedestrianClarity + 0.12);
    if (fore) pedestrianClarity = clamp01(pedestrianClarity + 0.1);
  }

  // ③ 停车质量：面积落在经验带内 + 是否连成一片
  const parkRatio = parkArea / lotArea;
  const parkFit = parkParts.length > 0 ? retailParkingFit(parkRatio) : 0;
  const parkingQuality = parkFit;

  // ④ 人车货分离：服务口不能和顾客口同一条边
  const car = c.access.find((a) => a.role === 'car');
  const svc = c.access.find((a) => a.role === 'service');
  const serviceSeparation = !car ? 0.2 : svc ? (svc.frontage !== car.frontage ? 1 : 0.35) : 0.7;

  // ⑤ 循环：有没有贯通的车道（停车区是不是一整块、能不能绕）
  const circulationQuality = clamp01(0.4 + (parkParts.length > 0 ? 0.4 : 0) + (c.circulation.length > 0 ? 0.2 : 0));

  // ⑤b 开发强度：零售是单层，覆盖率≈FAR，按目标带拟合（R7.7）
  const buildingArea = c.buildings.reduce((a, b) => a + surfaceArea(b.footprint), 0);
  const coverage = buildingArea / lotArea;
  const coverageFit = retailCoverageFit(coverage);

  // ⑥ 建筑规整度 / 地面可用性 / 开放空间
  const buildingRegularity = shop ? rectness(shop.footprint.outer) : 0;
  const has = (p: GroundProgram) => c.ground.some((g) => g.program === p);
  const keyPrograms: GroundProgram[] = ['parking', 'pedestrian', 'entrance_forecourt', 'service'];
  const groundUsability = keyPrograms.filter(has).length / keyPrograms.length;
  const openSpaceQuality = clamp01(
    ((fore?.area ?? 0) + c.ground.filter((g) => g.program === 'landscape').reduce((a, g) => a + g.area, 0)) /
      lotArea /
      0.12
  );

  // ⑦ 惩罚
  const deadSpacePenalty = clamp01((residual ? residual.area / lotArea : 0) / 0.2);
  const tiny = c.ground.filter((g) => g.program !== 'residual' && g.area / lotArea < 0.012).length;
  const fragmentationPenalty = clamp01(tiny / 3);
  const narrowResidualPenalty = residual ? clamp01((3 - shortestSideM(residual.surface.outer)) / 3) : 0;
  // 顾客入口与服务口叠在一起 = 卸货穿顾客区
  const accessConflictPenalty = car && svc && car.frontage === svc.frontage ? 0.7 : 0;

  return {
    accessClarity: clamp01((ped ? 0.5 : 0) + (car ? 0.5 : 0)),
    frontageQuality,
    buildingRegularity,
    groundUsability,
    circulationQuality,
    parkingQuality,
    openSpaceQuality,
    pedestrianClarity,
    serviceSeparation,
    // 零售的核心空间就是"店前广场"，复用通用项（旧口径 6% 就封顶 → 同样靠 saturate）
    spatialCoreQuality: fore ? clamp01(0.55 + 0.45 * saturate(fore.area / lotArea, 0.02, 0.05, 0.09)) : 0.2,
    // 四条腿：临街界面 / 停车 / 顾客动线 / 开发强度
    typologyFit: clamp01(
      0.35 * frontageVisible + 0.25 * parkFit + 0.2 * pedestrianClarity + 0.2 * coverageFit
    ),
    deadSpacePenalty,
    fragmentationPenalty,
    narrowResidualPenalty,
    accessConflictPenalty,
  };
}

/** 白名单校验 */
export function retailProgramViolations(c: SitePlanCandidate): GroundProgram[] {
  return c.ground.map((g) => g.program).filter((p) => !RETAIL_GROUND_WHITELIST.includes(p));
}

/** 停车压不压店铺（生成器自检 + 测试用） */
export function parkingOverlapsShop(c: SitePlanCandidate): number {
  const shop = c.buildings[0];
  // 停车场可能被穿场步行道切成两片（真实超市就是这样），
  // 所以**面积要按所有 parking 块合计**，不能只取第一块 ——
  // 只取一块会让停车面积凭空减半，R05 直接判"停车区过小"。
  const parkParts = c.ground.filter((g) => g.program === 'parking');
  const parking = parkParts[0];
  // 停车楼：地面停车被立体化之后，地面面积会少掉 2/3，但**车位没少**。
  // 按"等效地面面积"折算（一栋 3 层停车楼 = 3 倍地面面积，其中 1 层仍在地面），
  // 否则 parkingQuality 会因为"立体化"而掉分 —— 那等于惩罚正确做法。
  const garage = c.buildings.find((b) => (b.notes ?? []).some((n) => n.includes('停车楼')));
  const garageEquiv = garage ? surfaceArea(garage.footprint) * 2 : 0;
  const parkArea = parkParts.reduce((a, g) => a + g.area, 0) + garageEquiv;
  if (!shop || !parking) return 0;
  return surfaceIntersect([parking.surface], [shop.footprint]).reduce((a, q) => a + surfaceArea(q), 0);
}

// ---------------------------------------------------------------- 工具

function centroid(ring: Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p.x;
    y += p.y;
  }
  return new Pt(x / Math.max(1, ring.length), y / Math.max(1, ring.length));
}

function bbox(ring: Pt[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of ring) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

function longestSideM(ring: Pt[]): number {
  let best = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    best = Math.max(best, Math.hypot(b.x - a.x, b.y - a.y));
  }
  return best * 7;
}

function shortestSideM(ring: Pt[]): number {
  const b = bbox(ring);
  return Math.min(b.maxX - b.minX, b.maxY - b.minY) * 7;
}

function rectness(ring: Pt[]): number {
  const b = bbox(ring);
  const box = (b.maxX - b.minX) * (b.maxY - b.minY);
  if (box < 1e-9) return 0;
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    s += p.x * q.y - q.x * p.y;
  }
  return clamp01(Math.abs(s / 2) / box);
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}
