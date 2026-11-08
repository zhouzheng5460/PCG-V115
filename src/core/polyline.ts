// 折线缓冲（斜接）—— 纯几何，不依赖任何 Node 能力。
//
// 从 `town/parking/placemaker.ts` 抽出来的原因：那个文件为了调 dotnet 求解器
// `import { execFileSync } from 'node:child_process'`，而浏览器里这行会直接把
// 整个模块标成 externalized 并**抛错**。Compose 的 roads/ground/parking 都要用这条
// 折线缓冲，一引就把浏览器实验台整页打死（实测：页面只剩侧栏，3D 全黑）。
// 放到 `core/` 之后，浏览器与 Node 用的是同一份实现。

import { Pt } from './geom';

export function bufferPolyline(input: Pt[], h: number): Pt[] | null {
  if (input.length < 2) return null;
  // 先去重：下面用 `segN[i-1] / segN[i]` 索引法线，中间只要有一个
  // 零长度段（重复点），segN 就比点序列短一格，取到 undefined 直接抛
  // `Cannot read properties of undefined (reading 'ny')`。
  // 图节点吸附 / 悬挂端投影都会制造这种重复点，所以在这里兜住。
  const pts: Pt[] = [input[0]];
  for (let i = 1; i < input.length; i++) {
    if (Pt.distance(input[i], pts[pts.length - 1]) > 1e-9) pts.push(input[i]);
  }
  if (pts.length < 2) return null;
  const left: Pt[] = [];
  const right: Pt[] = [];
  const segN: { nx: number; ny: number }[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const dx = pts[i + 1].x - pts[i].x;
    const dy = pts[i + 1].y - pts[i].y;
    const L = Math.hypot(dx, dy);
    if (L < 1e-9) continue;
    segN.push({ nx: -dy / L, ny: dx / L });
  }
  if (segN.length === 0) return null;
  // 首点：第一段的法线
  left.push(new Pt(pts[0].x + segN[0].nx * h, pts[0].y + segN[0].ny * h));
  right.push(new Pt(pts[0].x - segN[0].nx * h, pts[0].y - segN[0].ny * h));
  // 中间点：斜接（两条平移线求交），近共线时退化为平均法线
  for (let i = 1; i + 1 < pts.length; i++) {
    const a = segN[i - 1];
    const b = segN[i];
    const cross = a.nx * b.ny - a.ny * b.nx;
    if (Math.abs(cross) < 1e-6) {
      const nx = (a.nx + b.nx) / 2;
      const ny = (a.ny + b.ny) / 2;
      const k = h / (Math.hypot(nx, ny) || 1);
      left.push(new Pt(pts[i].x + nx * k, pts[i].y + ny * k));
      right.push(new Pt(pts[i].x - nx * k, pts[i].y - ny * k));
    } else {
      // 角平分线方向上取 h / cos(θ/2)
      const nx = a.nx + b.nx;
      const ny = a.ny + b.ny;
      const nl = Math.hypot(nx, ny) || 1;
      const ux = nx / nl;
      const uy = ny / nl;
      const cosHalf = ux * a.nx + uy * a.ny || 1;
      const k = h / Math.max(0.35, cosHalf);
      left.push(new Pt(pts[i].x + ux * k, pts[i].y + uy * k));
      right.push(new Pt(pts[i].x - ux * k, pts[i].y - uy * k));
    }
  }
  const last = segN[segN.length - 1];
  left.push(new Pt(pts[pts.length - 1].x + last.nx * h, pts[pts.length - 1].y + last.ny * h));
  right.push(new Pt(pts[pts.length - 1].x - last.nx * h, pts[pts.length - 1].y - last.ny * h));
  return left.concat(right.reverse());
}
