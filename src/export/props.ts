// 道具低模：树、路灯、长椅、垃圾桶、指示牌、花坛、公交亭、喷泉、护柱、汽车。
//
// 每个道具都按"能认出是什么"的最低面数来做：
//   树 24 面、路灯 33 面、长椅 24 面、垃圾桶 15 面。
// 城市里道具数量是几百到上千，单件多花 20 面就会多出几万个三角形。

import { Pt } from '../core/geom';
import type { PropFeature } from '../scene/types';
import { MAT, treeGreen } from '../scene/palette';
import type { Primitive } from './mesh';
import { box, cylinder, cone, flatPolygon } from './mesh';

const WHITE: [number, number, number] = [0.94, 0.94, 0.9];

export function buildProp(p: PropFeature, baseY = 0.01): Primitive[] {
  const g = p.group;
  const c = p.at;
  const s = p.scale;
  const rot = p.rot;
  const y0 = baseY;
  const out: Primitive[] = [];
  const dirX = Math.cos(rot);
  const dirY = Math.sin(rot);

  switch (p.kind) {
    // 树：**立方体树冠**（用户要求：所有植物换成方块树，只改形状，其他规则不变）。
    //
    // 之前是"两层锥形树冠"，换成方块之后：位置、朝向、尺寸倍率、颜色（按 seed 取绿）
    // 全部沿用原规则，只把树冠的几何从锥体换成长方体 —— 低多边形风格更统一，
    // 面数也从 ~14 面降到 6 面。
    case 'tree': {
      const th = 0.42 * s;
      const g1 = treeGreen(p.seed);
      const cr = 0.4 * s;
      const ch = 0.84 * s;
      out.push(cylinder(c, 0.032 * s, y0, th, `${p.name}_t`, g, MAT.trunk, 3));
      out.push(...box(c, cr * 2, cr * 2, y0 + th * 0.86, ch, rot, `${p.name}_c0`, g, g1));
      break;
    }
    case 'treeSmall': {
      const th = 0.28 * s;
      const g1 = treeGreen(p.seed);
      out.push(cylinder(c, 0.028 * s, y0, th, `${p.name}_t`, g, MAT.trunk, 3));
      out.push(...box(c, 0.62 * s, 0.62 * s, y0 + th * 0.8, 0.72 * s, rot, `${p.name}_c0`, g, g1));
      break;
    }
    case 'conifer': {
      // 针叶树：窄高的方块，仍比圆叶树细一圈、颜色更冷
      const th = 0.2 * s;
      const g1 = treeGreen(p.seed);
      out.push(cylinder(c, 0.026 * s, y0, th, `${p.name}_t`, g, MAT.trunk, 3));
      out.push(...box(c, 0.5 * s, 0.5 * s, y0 + th * 0.85, 1.0 * s, rot, `${p.name}_c0`, g, g1));
      break;
    }
    case 'lamp':
    case 'lampDouble': {
      const h = 1.8 * s;
      out.push(cylinder(c, 0.026 * s, y0, h, `${p.name}_p`, g, MAT.metal, 3));
      // 灯臂沿 rot 方向伸向**道路中线**，杆上只有**一个**灯头。
      // 双头灯（一杆两灯）已按用户要求取消：俯视图里读成"杆顶两个白块"，
      // 且总有一个灯头不在车道上方。
      const arms = [0.44];
      for (const t of arms) {
        const ax = c.x + dirX * t * s;
        const ay = c.y + dirY * t * s;
        out.push(
          ...box(
            new Pt(c.x + dirX * (t / 2) * s, c.y + dirY * (t / 2) * s),
            t * s,
            0.045 * s,
            y0 + h - 0.03,
            0.045 * s,
            rot,
            `${p.name}_a`,
            g,
            MAT.metal
          )
        );
        out.push(
          ...box(new Pt(ax, ay), 0.15 * s, 0.09 * s, y0 + h - 0.08, 0.06 * s, rot, `${p.name}_h`, g, WHITE, WHITE)
        );
      }
      break;
    }
    case 'bench': {
      out.push(...box(c, 0.36 * s, 0.1 * s, y0 + 0.09 * s, 0.03 * s, rot, `${p.name}_s`, g, MAT.wood));
      out.push(...box(new Pt(c.x - dirX * 0.02, c.y - dirY * 0.02), 0.36 * s, 0.03 * s, y0 + 0.16 * s, 0.16 * s, rot, `${p.name}_b`, g, MAT.wood));
      out.push(cylinder(new Pt(c.x - 0.13, c.y), 0.014, y0, 0.1, `${p.name}_l1`, g, MAT.metal, 3));
      out.push(cylinder(new Pt(c.x + 0.13, c.y), 0.014, y0, 0.1, `${p.name}_l2`, g, MAT.metal, 3));
      break;
    }
    case 'bin': {
      out.push(cylinder(c, 0.055 * s, y0, 0.24 * s, `${p.name}_b`, g, MAT.metal, 5));
      break;
    }
    case 'sign': {
      out.push(cylinder(c, 0.018 * s, y0, 0.9 * s, `${p.name}_p`, g, MAT.metal, 3));
      out.push(...box(new Pt(c.x, c.y), 0.26 * s, 0.03 * s, y0 + 0.78 * s, 0.2 * s, rot, `${p.name}_s`, g, WHITE, WHITE));
      break;
    }
    case 'planter': {
      out.push(...box(c, 0.5 * s, 0.34 * s, y0, 0.2 * s, rot, `${p.name}_p`, g, MAT.stonePave, MAT.grass));
      break;
    }
    case 'shelter': {
      const h = 0.52 * s;
      out.push(...box(c, 1.15 * s, 0.52 * s, y0 + h, 0.05 * s, rot, `${p.name}_roof`, g, MAT.metal));
      out.push(...box(new Pt(c.x - dirX * 0.5 * s, c.y - dirY * 0.5 * s), 0.05 * s, 0.05 * s, y0, h, rot, `${p.name}_c1`, g, MAT.metal));
      out.push(...box(new Pt(c.x + dirX * 0.5 * s, c.y + dirY * 0.5 * s), 0.05 * s, 0.05 * s, y0, h, rot, `${p.name}_c2`, g, MAT.metal));
      out.push(...box(new Pt(c.x - dirY * 0.2 * s, c.y + dirX * 0.2 * s), 1.1 * s, 0.03 * s, y0 + 0.1, h - 0.14, rot, `${p.name}_b`, g, MAT.wallGlass));
      break;
    }
    case 'fountain': {
      out.push(cylinder(c, 0.55 * s, y0, 0.12 * s, `${p.name}_basin`, g, MAT.stonePave, 10));
      out.push(cylinder(c, 0.36 * s, y0 + 0.12 * s, 0.02, `${p.name}_water`, g, MAT.water, 10));
      out.push(cylinder(c, 0.06 * s, y0 + 0.12 * s, 0.3 * s, `${p.name}_jet`, g, MAT.stonePave, 5));
      break;
    }
    case 'bollard': {
      out.push(cylinder(c, 0.035 * s, y0, 0.14 * s, `${p.name}_b`, g, MAT.metal, 4));
      break;
    }
    case 'hedge': {
      // 修剪过的灌木块：1.5 m 长 × 0.9 m 宽，高度由 `hz` 单独给
      // （默认 1.1 m，与栏杆齐平；原来 0.45 m 读起来像草皮）。
      const hz = p.hz ?? 1;
      out.push(...box(c, 0.214 * s, 0.129 * s, y0, 0.064 * s * hz, rot, `${p.name}_h`, g, MAT.leafDark, MAT.leaf));
      break;
    }
    case 'post': {
      // 栏杆立柱：6 cm 见方、1.1 m 高。把它单独成一种道具而不是靠 path 拉伸，
      // 是因为俯视图里 path 只有线宽，立柱必须有"一节一节"的节奏。
      const t = 0.0086 * s;
      out.push(...box(c, t, t, y0, 0.157 * s, rot, `${p.name}_p`, g, MAT.fence));
      break;
    }
    case 'car': {
      out.push(...box(c, 0.44 * s, 0.19 * s, y0, 0.09 * s, rot, `${p.name}_b`, g, MAT.wallPanel));
      out.push(...box(new Pt(c.x - dirX * 0.03, c.y - dirY * 0.03), 0.24 * s, 0.17 * s, y0 + 0.09 * s, 0.07 * s, rot, `${p.name}_r`, g, MAT.wallGlass));
      break;
    }
    case 'flagpole': {
      out.push(cylinder(c, 0.02 * s, y0, 1.6 * s, `${p.name}_p`, g, MAT.stonePave, 3));
      const flag = [
        new Pt(c.x, c.y),
        new Pt(c.x + 0.32 * s, c.y),
        new Pt(c.x + 0.32 * s, c.y + 0.2 * s),
        new Pt(c.x, c.y + 0.2 * s),
      ];
      const f = flatPolygon(flag, y0 + 1.4 * s, `${p.name}_f`, g, MAT.markYellow);
      if (f) {
        f.doubleSided = true;
        out.push(f);
      }
      break;
    }
    default:
      break;
  }

  return out;
}
