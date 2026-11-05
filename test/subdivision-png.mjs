// SVG → PNG（报告用；sharp 是既有 devDependency，topng.mjs 同款做法）
//
// 同时处理两套图：
//   out/subdivision/  F2.1 地块分割
//   out/adapt/        F2.4-A 建筑布局
import sharp from 'sharp';
import { readdirSync, existsSync } from 'node:fs';

for (const dir of ['out/subdivision', 'out/adapt']) {
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.svg'))) {
    const name = f.replace('.svg', '.png');
    await sharp(`${dir}/${f}`, { density: 120 }).resize({ width: 1400 }).png().toFile(`${dir}/${name}`);
    console.log('ok', `${dir}/${name}`);
  }
}
