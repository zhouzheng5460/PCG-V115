// 现代城市材质调色板。
// 全流程只有一套颜色：2D 画布、three.js 预览、GLB 导出都从这里取，
// 保证"编辑时看到的路面色"就是"导出的路面色"。
// 数值是 sRGB 0~1（glTF baseColorFactor 与 canvas fillStyle 通用）。

export type MatKey =
  // 地面 / 硬质铺装
  | 'ground'
  | 'asphalt'
  | 'asphaltLot'
  | 'concrete'
  | 'paver'
  | 'brickPave'
  | 'stonePave'
  | 'gravel'
  | 'curb'
  /**
   * 「高亮内部道路」用的两种临时色。
   *
   * 不是真实材质 —— 只在 `state.hiliteLotRoad` 打开时替换掉内部路面的原色，
   * 让"哪一段是地块内部的路"一眼可辨。关掉之后仍按原材质渲染，
   * 导出 GLB 时也不会带上（导出走的是同一条替换逻辑，见 build3d 的 hiliteLotRoad）。
   */
  | 'lotRoadHi'
  | 'lotRoadHiWalk'
  /**
   * 车位带：停车场里"整排车位"的底。
   *
   * 停车场的读法应该是**车位浅、车道深**（TestFit / 专业总图都这样）：
   * 一排车位是一整条浅色带，白色分隔线画在上面；车道是深一档的整条。
   * 之前只有 `asphaltLot` 一层底 + 细白线，远看就是"一块深灰上撒了几根线"，
   * 锥形处尤其像没人用的空地。
   */
  | 'stallBand'
  /**
   * 地块的两层"硬"：**硬质底**与**地块通路**。
   *
   * 这一版把地块地面拆成四类、各给一个专属材质，不再借用市政那套
   * （原来硬底用 paver、通路用 paver/stonePave/concrete，草地上根本分不清
   * "这块浅色到底是底还是路"）：
   *   · `lotBase`  硬质底：整块街区一片，**一种颜色、不做任何切割**
   *   · `lotPath`  地块通路：内部路 + 入口连接带 + 前场（同一类）
   *   · `lawn`     草地（唯一的一种绿，不再有 lawn/grass 两种混用）
   *   · `asphaltLot` 停车场地坪
   * 四类之外不允许再出现别的"地块地面色"。
   */
  | 'lotBase'
  | 'lotPath'
  // 软质
  | 'grass'
  /**
   * 修剪草坪（亮一档）。
   *
   * 公园要按"不同的绿地类型"细分地块，而原来只有 grass / grassDark 两种绿 ——
   * 一块公园切成八格也只有两种颜色，俯视图上读不出"这里换了一种绿地"。
   * 加这一档之后，草坪 / 草甸 / 密林是三级递减的绿，切分痕迹才看得出来。
   */
  | 'grassLight'
  | 'grassDark'
  /**
   * 修剪草坪（住宅围合院专用）。
   *
   * 和 grass / grassLight 的区别是**低饱和**：院子占围合式住宅地块的 67%，
   * 用饱和的草绿铺满之后，整座城读起来是"公园里散着几栋楼"，
   * 不像规划图。专业总图上的草坪是**浅而灰**的绿，绿只用来和铺装区分，
   * 不用来抢视线。
   */
  | 'lawn'
  | 'soil'
  | 'water'
  // 标线
  | 'markWhite'
  | 'markYellow'
  // 屋面
  | 'roofFlat'
  | 'roofLight'
  | 'roofDark'
  | 'roofMetal'
  // 墙面
  | 'wallConcrete'
  | 'wallBrick'
  | 'wallGlass'
  | 'wallPanel'
  | 'wallStone'
  // 设施
  | 'metal'
  | 'wood'
  | 'trunk'
  | 'leaf'
  | 'leafDark'
  | 'fence';

export const MAT: Record<MatKey, [number, number, number]> = {
  ground: [0.408, 0.396, 0.372],
  asphalt: [0.243, 0.253, 0.275],
  // 停车场沥青比车行道略深一点点就够，再深就从"停车"读成"空洞"了
  asphaltLot: [0.268, 0.278, 0.302],
  stallBand: [0.335, 0.342, 0.360],
  concrete: [0.663, 0.655, 0.628],
  paver: [0.706, 0.667, 0.604],
  brickPave: [0.588, 0.404, 0.333],
  stonePave: [0.757, 0.733, 0.690],
  /** 硬质底：中性浅灰，比铺装冷一点、比混凝土亮一点，整块街区一个色 */
  lotBase: [0.640, 0.632, 0.616],
  /** 地块通路：浅土黄，和硬质底拉开明度，一眼看出"这是能走的路" */
  lotPath: [0.792, 0.741, 0.640],
  gravel: [0.549, 0.529, 0.482],
  curb: [0.800, 0.788, 0.757],

  // 高亮色：橙红足够扎眼，又不和"用地类型着色"的青绿撞
  lotRoadHi: [0.98, 0.36, 0.22],
  lotRoadHiWalk: [1.0, 0.72, 0.45],

  grass: [0.361, 0.502, 0.271],
  grassLight: [0.435, 0.565, 0.302],
  grassDark: [0.278, 0.404, 0.212],
  // 浅灰绿。注意这些值是**线性**的，转 sRGB 会明显变亮：
  // 0.706/0.780/0.627 出来是 #DBE6D1，浅到发白，和米色铺装糊在一起。
  // 压到 0.60/0.70/0.50（≈ #CCD9BA）才是"看得出是草、又不抢视线"的那一档。
  lawn: [0.600, 0.700, 0.500],
  soil: [0.412, 0.353, 0.267],
  water: [0.286, 0.443, 0.522],

  markWhite: [0.925, 0.925, 0.902],
  markYellow: [0.851, 0.706, 0.239],

  roofFlat: [0.400, 0.412, 0.431],
  // 浅色屋面必须和石材铺装拉开差距：原来的 0.78/0.769/0.741 和 stonePave
  // (0.757/0.733/0.690) 几乎是同一个颜色，2D 上一片浅色地块分不清"这是楼"
  // 还是"这是空地"，整块封闭地读起来像一格一格的空场。压到中性灰并略微偏冷。
  roofLight: [0.615, 0.622, 0.638],
  roofDark: [0.298, 0.310, 0.329],
  roofMetal: [0.522, 0.549, 0.580],

  wallConcrete: [0.800, 0.780, 0.749],
  wallBrick: [0.702, 0.549, 0.467],
  wallGlass: [0.471, 0.600, 0.659],
  wallPanel: [0.620, 0.635, 0.635],
  wallStone: [0.859, 0.831, 0.769],

  metal: [0.561, 0.580, 0.612],
  wood: [0.541, 0.380, 0.251],
  trunk: [0.322, 0.251, 0.192],
  leaf: [0.298, 0.451, 0.239],
  leafDark: [0.220, 0.353, 0.180],
  fence: [0.471, 0.494, 0.529],
};

/** 画布用 CSS 颜色 */
export function css(k: MatKey, alpha = 1): string {
  const c = MAT[k];
  const r = Math.round(c[0] * 255);
  const g = Math.round(c[1] * 255);
  const b = Math.round(c[2] * 255);
  return alpha >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`;
}

/**
 * 树的一撮绿。
 *
 * 树在 2D 画布、三维预览、GLB 里都是**立方体**（不是锥体），
 * 颜色从下面这几档里按 seed 取一个，再叠一点点亮度抖动。
 * 三处共用同一张表、同一个取值函数，所以"画布上的树"和"导出的树"颜色一致。
 *
 * 为什么用立方体：一座城的树是几百到上千棵，锥体每棵 18 面、立方体只要 12 面，
 * 而且方头方脑的树在俯视图里更容易和灌木 / 路灯分开 —— 细看锥体顶在 2D 上
 * 只是一个圆点，压根看不出是树。
 */
export const TREE_GREENS: [number, number, number][] = [
  [0.235, 0.412, 0.196],
  [0.298, 0.451, 0.239],
  [0.353, 0.494, 0.251],
  [0.196, 0.353, 0.169],
  [0.271, 0.478, 0.290],
  [0.404, 0.522, 0.259],
];

/** seed → 一档绿（确定性：同一个 seed 永远同一个颜色，重建不会跳） */
export function treeGreen(seed: number): [number, number, number] {
  const i = Math.abs(Math.floor(seed * 7.31)) % TREE_GREENS.length;
  return TREE_GREENS[i];
}

/** 同上，但要 CSS 字符串（2D 画布用） */
export function treeGreenCss(seed: number, lift = 0): string {
  const c = treeGreen(seed);
  const f = (v: number) => Math.round(Math.min(1, v + lift) * 255);
  return `rgb(${f(c[0])},${f(c[1])},${f(c[2])})`;
}

/** 按用途给出地坪基调，2D 里用来区分地块性质 */
export const USE_COLOR: Record<string, [number, number, number]> = {
  cbd: [0.62, 0.63, 0.66],
  commercial: [0.68, 0.63, 0.58],
  residential: [0.63, 0.66, 0.56],
  industrial: [0.60, 0.59, 0.55],
  civic: [0.72, 0.70, 0.65],
  park: [0.40, 0.54, 0.30],
  parking: [0.30, 0.31, 0.33],
  green: [0.36, 0.50, 0.27],
  // 禁建 / 保留：比绿地灰、比铺装暖，读起来是"这块地留着没用起来"
  reserved: [0.58, 0.56, 0.50],
};
