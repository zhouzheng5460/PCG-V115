// Clipper2 封装（`src/core/clipper.ts`）的验收。
//
// 这一层是"把不可靠的偏移换掉"的地基，所以测的不是"能不能跑"，而是
// **几何是否真的对**：面积、拓扑（洞有没有被当成实体）、以及四种会打垮
// 上一版实现的病态输入：
//   ① 顶点压在另一条边上（T 形，路口嘴部就是这个形态）
//   ② 锐角分叉（V 形 20°，小城市路网里到处都是）
//   ③ 相邻面之间只隔几厘米的缝（缓冲并集之后必然出现）
//   ④ 几万顶点、上百个洞的合并面（上一版直接返回空）

import { Pt } from '../src/core/geom';
import {
  CLIP_SCALE,
  intersectSurfaceSet,
  offsetSurfaceSet,
  subtractSurfaceSet,
  unionSurfaceSet,
  type RingSurface,
} from '../src/core/clipper';

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = ''): void => {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}${detail ? '  ' + detail : ''}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? '  ' + detail : ''}`);
  }
};

const M2 = (u2: number): number => u2 * 49;
const P = (x: number, y: number): Pt => new Pt(x, y);
const rect = (x0: number, y0: number, x1: number, y1: number): Pt[] => [
  P(x0, y0),
  P(x1, y0),
  P(x1, y1),
  P(x0, y1),
];

/** 有向面积（世界单位²，CCW 为正） */
const areaOf = (r: Pt[]): number => {
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const p = r[i];
    const q = r[(i + 1) % r.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
};
/** 面集合的净面积（外环 − 洞） */
const netArea = (list: RingSurface[]): number =>
  list.reduce((a, s) => a + Math.abs(areaOf(s.outer)) - s.holes.reduce((h, r) => h + Math.abs(areaOf(r)), 0), 0);

console.log('Clipper2 封装 · 偏移与布尔');

// ---------------------------------------------------------------- ① 矩形外扩
{
  const r = rect(0, 0, 10, 10);
  const out = offsetSurfaceSet([{ outer: r, holes: [] }], 1);
  // 斜接外扩 1：10×10 → 12×12
  ok('矩形外扩 1：结果只有一片', out.length === 1, `${out.length} 片`);
  const a = netArea(out);
  ok('矩形外扩 1：面积 = 144', Math.abs(a - 144) < 0.05, `${a.toFixed(3)}`);
  ok('矩形外扩 1：外环仍是 4 个点（斜接不吃角）', out[0]?.outer.length === 4, `${out[0]?.outer.length} 点`);
  ok('矩形外扩 1：绕向 CCW', areaOf(out[0].outer) > 0);
}

// ---------------------------------------------------------------- ② 内缩
{
  const out = offsetSurfaceSet([{ outer: rect(0, 0, 10, 10), holes: [] }], -1);
  const a = netArea(out);
  ok('矩形内缩 1：面积 = 64', Math.abs(a - 64) < 0.05, `${a.toFixed(3)}`);
  // 内缩超过半宽 → 消失（不能吐出负面积的面）
  const gone = offsetSurfaceSet([{ outer: rect(0, 0, 10, 10), holes: [] }], -6);
  ok('内缩过头：结果为空（不吐翻转环）', gone.length === 0 || netArea(gone) < 1, `${gone.length} 片`);
}

// ---------------------------------------------------------------- ③ 带洞：洞要收缩
{
  const s: RingSurface = { outer: rect(0, 0, 20, 20), holes: [rect(7, 7, 13, 13)] };
  const out = offsetSurfaceSet([s], 1);
  ok('带洞外扩：仍是 1 片带 1 洞', out.length === 1 && out[0].holes.length === 1, `${out.length} 片 / ${out[0]?.holes.length} 洞`);
  // 22×22 − 4×4 = 484 − 16 = 468
  const a = netArea(out);
  ok('带洞外扩 1：净面积 = 468', Math.abs(a - 468) < 0.1, `${a.toFixed(3)}`);
  ok('带洞外扩 1：洞变小了（4×4）', Math.abs(Math.abs(areaOf(out[0].holes[0])) - 16) < 0.05, `${Math.abs(areaOf(out[0].holes[0])).toFixed(3)}`);
  ok('洞的绕向与外环相反', areaOf(out[0].outer) * areaOf(out[0].holes[0]) < 0);

  // 洞被"填死"：外扩到洞完全闭合（外环 20+2×4 = 28 → 784，6 宽的洞被吃没）
  const filled = offsetSurfaceSet([s], 4);
  ok('洞被填死：净面积 = 28²（无洞）', filled.every((q) => q.holes.length === 0) && Math.abs(netArea(filled) - 784) < 0.2, `${netArea(filled).toFixed(3)}`);
}

// ---------------------------------------------------------------- ④ 顶点压在边上（T 形）
{
  // L 形，且在竖直边的中点上多插一个顶点 —— 它正好压在下一条边上
  const L: Pt[] = [P(0, 0), P(10, 0), P(10, 10), P(5, 10), P(5, 0), P(0, 0)];
  // 把最后一点去掉，改成"顶点落在边 (0,0)-(10,0) 上"的退化环
  const T: Pt[] = [P(0, 0), P(4, 0), P(10, 0), P(10, 10), P(0, 10)];
  const out = offsetSurfaceSet([{ outer: L, holes: [] }], 0.5);
  ok('L 形外扩：非空', out.length >= 1, `${out.length} 片`);
  ok('L 形外扩：面积增幅合理', netArea(out) > Math.abs(areaOf(L)) && netArea(out) < Math.abs(areaOf(L)) * 2.2, `${netArea(out).toFixed(2)} vs ${Math.abs(areaOf(L)).toFixed(2)}`);
  const outT = offsetSurfaceSet([{ outer: T, holes: [] }], 0.5);
  ok('压边顶点外扩：非空（上一版会返回空）', outT.length >= 1, `${outT.length} 片`);
  ok('压边顶点外扩：面积 = 11×11', Math.abs(netArea(outT) - 121) < 0.1, `${netArea(outT).toFixed(3)}`);
}

// ---------------------------------------------------------------- ⑤ 锐角分叉
{
  // 20° 的 V 形尖角（小城市里的锐角路口就是这个形状）
  const th = (20 * Math.PI) / 180;
  const V: Pt[] = [P(0, 0), P(20 * Math.cos(th / 2), 20 * Math.sin(th / 2)), P(20 * Math.cos(th / 2), -20 * Math.sin(th / 2))];
  const out = offsetSurfaceSet([{ outer: V, holes: [] }], 1);
  ok('V 形（20°）外扩：非空', out.length >= 1, `${out.length} 片`);
  ok('V 形外扩：面积增加（尖角不塌）', netArea(out) > Math.abs(areaOf(V)), `${netArea(out).toFixed(2)} vs ${Math.abs(areaOf(V)).toFixed(2)}`);
  // 尖角处 miter 长度约 1/sin(10°) = 5.8 倍 delta，超过 miterLimit=2 会自动削平
  const a = netArea(out);
  const naive = Math.abs(areaOf(V));
  ok('V 形外扩：没有爆出天文数字（miter 被限住）', a < naive * 5, `${(a / naive).toFixed(2)}×`);
}

// ---------------------------------------------------------------- ⑥ 缝被合并
{
  // 两个矩形之间留 5 cm 的缝：外扩 10 cm 之后必须连成一片
  const a: RingSurface = { outer: rect(0, 0, 10, 10), holes: [] };
  const b: RingSurface = { outer: rect(10.05, 0, 20, 10), holes: [] };
  const out = offsetSurfaceSet([a, b], 0.1);
  ok('相邻面外扩：缝被吃成一片', out.length === 1, `${out.length} 片`);
  ok('相邻面外扩：面积 ≈ 并集 + 一圈', Math.abs(netArea(out) - (20.2 * 10.2)) < 0.5, `${netArea(out).toFixed(2)}`);
}

// ---------------------------------------------------------------- ⑦ 集合整体偏移（不做预先 union）
{
  // 三个首尾相接的矩形，用"整体 offset"直接得到外轮廓
  const list: RingSurface[] = [
    { outer: rect(0, 0, 10, 4), holes: [] },
    { outer: rect(10, 0, 20, 4), holes: [] },
    { outer: rect(20, 0, 30, 4), holes: [] },
  ];
  const out = offsetSurfaceSet(list, 1);
  ok('分段矩形整体外扩：一片', out.length === 1, `${out.length} 片`);
  ok('分段矩形整体外扩：面积 = 32×6', Math.abs(netArea(out) - 192) < 0.2, `${netArea(out).toFixed(2)}`);
}

// ---------------------------------------------------------------- ⑧ 大输入（上一版死在这里）
{
  // 网格状并集：40×40 个 1.5 单位的小方块，间隙 0.3 —— 上万顶点、上百个洞
  const list: RingSurface[] = [];
  for (let i = 0; i < 40; i++) {
    for (let j = 0; j < 40; j++) {
      const x = i * 1.8;
      const y = j * 1.8;
      list.push({ outer: rect(x, y, x + 1.5, y + 1.5), holes: [] });
    }
  }
  ok('大输入：1600 个面', list.length === 1600);
  const t0 = Date.now();
  const out = offsetSurfaceSet(list, 0.25);
  const ms = Date.now() - t0;
  ok('大输入外扩：非空（上一版这里返回空）', out.length > 0, `${out.length} 片 / ${ms} ms`);
  const before = 1600 * 1.5 * 1.5;
  ok('大输入外扩：面积增加 > 0', netArea(out) > before, `${netArea(out).toFixed(1)} vs ${before.toFixed(1)}`);
  ok('大输入外扩：耗时 < 400 ms', ms < 400, `${ms} ms`);

  // 内缩 0.25：1.5 宽的方块变成 1.0，仍然是 1600 片（不合并）
  const t1 = Date.now();
  const ins = offsetSurfaceSet(list, -0.25);
  ok('大输入内缩：片数不变', ins.length === 1600, `${ins.length} 片 / ${Date.now() - t1} ms`);
}

// ---------------------------------------------------------------- ⑨ 布尔
{
  const a: RingSurface = { outer: rect(0, 0, 10, 10), holes: [] };
  const b: RingSurface = { outer: rect(5, 0, 15, 10), holes: [] };
  ok('并集面积 = 150', Math.abs(netArea(unionSurfaceSet([a, b])) - 150) < 0.05);
  ok('交集面积 = 50', Math.abs(netArea(intersectSurfaceSet([a], [b])) - 50) < 0.05);
  ok('差集面积 = 50', Math.abs(netArea(subtractSurfaceSet([a], [b])) - 50) < 0.05);
  // 差集把面切成两片
  const cut = subtractSurfaceSet([{ outer: rect(0, 0, 10, 10), holes: [] }], [{ outer: rect(4, -1, 6, 11), holes: [] }]);
  ok('差集切口：切成两片', cut.length === 2, `${cut.length} 片`);
  ok('差集切口：净面积 80', Math.abs(netArea(cut) - 80) < 0.05, `${netArea(cut).toFixed(2)}`);
}

// ---------------------------------------------------------------- ⑩ 精度
{
  ok('缩放常数 = 10000（1 格 = 0.7 mm）', CLIP_SCALE === 10000);
  // 0.05 单位（35 cm）的小偏移仍然有效
  const out = offsetSurfaceSet([{ outer: rect(0, 0, 10, 10), holes: [] }], 0.05);
  ok('0.05 单位小偏移：面积 = 10.1²', Math.abs(netArea(out) - 102.01) < 0.02, `${netArea(out).toFixed(4)}`);
  // 5 mm 的"破退化微偏移"必须能被表示（1 格 7 mm 的实现会把它抹成 0）
  const tiny = offsetSurfaceSet([{ outer: rect(0, 0, 10, 10), holes: [] }], 0.0007);
  ok('5 mm 微偏移：确实长出去了', netArea(tiny) > 100.01, `${netArea(tiny).toFixed(5)}`);
  // 不足半格（< 0.35 mm）应直接返回原面，不产生空结果
  const same = offsetSurfaceSet([{ outer: rect(0, 0, 10, 10), holes: [] }], 0.00002);
  ok('小于半格：返回原面', same.length === 1 && Math.abs(netArea(same) - 100) < 1e-6);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} 项断言，${fail} 项失败`);
if (fail > 0) process.exit(1);
