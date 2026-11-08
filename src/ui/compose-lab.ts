// F2.4-D · 浏览器实验台
//
// 这个页面**不参与生产输出**：index.html 仍走原来的 app.ts，一行未改。
//
//   http://127.0.0.1:5190/compose.html?site=R01
//   ?site=C01|I01|G04|G05   ?cand=0..2   ?view=2d|3d
//
// 3D 用的是**软件光栅器**（`test/soft3d.ts`），和 `test/compose-d.ts` 出 PNG 用的是
// 同一个渲染器。为什么不上 three.js / WebGL：
//   · 在无头浏览器、远程桌面、关闭硬件加速的环境里，WebGL 会创建失败，甚至让整个渲染
//     进程崩掉（实测报 "Abnormal renderer termination"，页面直接黑屏）；
//   · 软件渲染是纯 JS，任何环境都能出图，而且**与报告里的 PNG 完全一致** ——
//     评审在浏览器里看到的画面就是交付图，不存在两套渲染对不上的问题。
// 代价是拖动时不是 60fps：拖动中降分辨率，松手后补一张全分辨率。

import { composeCandidates, type ComposeCandidate } from '../town/planning/compose';
import { inputOf } from '../../test/compose-inputs';
import { renderPlan } from '../../test/scene2d';
import { scenePrims } from '../../test/scene3d';
import { renderPrimitives } from '../../test/soft3d';
import type { Primitive } from '../export/mesh';

const SITES: { id: string; label: string }[] = [
  { id: 'R01', label: 'R01 住宅' },
  { id: 'C01', label: 'C01 商业' },
  { id: 'I01', label: 'I01 工业' },
  { id: 'G04', label: 'G04 三角形' },
  { id: 'G05', label: 'G05 L 形凹地' },
];

const q = new URLSearchParams(location.search);
const state = {
  site: q.get('site') ?? 'R01',
  cand: Number(q.get('cand') ?? 0),
  view: (q.get('view') ?? '3d') as '2d' | '3d',
  az: 40,
  el: 32,
  zoom: 1,
};

const $ = (s: string) => document.querySelector(s) as HTMLElement;
const host = $('#three');
const svgBox = $('#svg');
const hud = $('#hud');
const busy = $('#busy');
const errBox = $('#err');
const stats = $('#stats');

// ---------------------------------------------------------------- 画布

const canvas = document.createElement('canvas');
canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;cursor:grab';
host.appendChild(canvas);
const ctx = canvas.getContext('2d');
if (!ctx) throw new Error('浏览器不支持 2D canvas');

function fitCanvas(): void {
  const w = host.clientWidth || 900;
  const h = host.clientHeight || 700;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const side = Math.min(1200, Math.round(Math.min(w, h) * dpr));
  canvas.width = side;
  canvas.height = side;
}
fitCanvas();

// ---------------------------------------------------------------- 渲染

let cands: ComposeCandidate[] = [];
/** 每个候选的图元缓存：生成一次，旋转时只重投影 */
const primCache = new Map<number, Primitive[]>();

function current(): ComposeCandidate | undefined {
  return cands[Math.min(state.cand, cands.length - 1)];
}

function render(): void {
  const c = current();
  if (!c) return;
  if (state.view === '2d') {
    host.style.visibility = 'hidden';
    svgBox.style.display = 'block';
    svgBox.innerHTML = renderPlan(c.scene, {
      width: 1500,
      title: `F2.4-D · ${c.comp.id} · ${c.label}`,
      subtitle:
        `视觉总分 ${c.score.total.toFixed(3)} · 建筑 ${c.comp.buildings.length} 栋 · ` +
        `覆盖 ${(c.comp.metrics.coverage * 100).toFixed(0)}% · FAR ${c.comp.metrics.far.toFixed(2)}`,
      foot: [c.score.verdict],
    });
    renderStats(c);
    return;
  }
  host.style.visibility = 'visible';
  svgBox.style.display = 'none';
  draw3d(true);
  const spanM = Math.round(
    Math.max(c.scene.bbox.maxX - c.scene.bbox.minX, c.scene.bbox.maxY - c.scene.bbox.minY) * 7
  );
  hud.innerHTML =
    `<b>${c.comp.id}</b> · ${c.label} · 总分 <b>${c.score.total.toFixed(3)}</b><br>` +
    `建筑 ${c.comp.buildings.length} 栋 · 地块 ${c.comp.metrics.parcels} · 树 ${c.scene.trees.length} 棵 · 场地 ${spanM} m<br>` +
    `拖动旋转 · 滚轮缩放 · 双击复位`;
  renderStats(c);
}

let pending = false;

/**
 * 软件光栅出一帧并贴到画布。
 *
 * `hi=false` 用在拖动过程中：分辨率砍到 500²，松手后再补一张 900²。
 * 这台机器上 900² 一帧约 0.3~0.9 s，拖动时全分辨率会明显跟手不上。
 */
function draw3d(hi: boolean): void {
  const c = current();
  if (!c) return;
  const key = state.cand;
  let prims = primCache.get(key);
  if (!prims) {
    prims = scenePrims(c.scene);
    primCache.set(key, prims);
  }
  const img = renderPrimitives(prims, {
    size: hi ? 900 : 500,
    azimuth: state.az,
    elevation: state.el,
    zoom: state.zoom,
    background: [0.055, 0.065, 0.08],
  });
  const off = document.createElement('canvas');
  off.width = img.width;
  off.height = img.height;
  const octx = off.getContext('2d');
  if (!octx) return;
  octx.putImageData(new ImageData(new Uint8ClampedArray(img.rgba), img.width, img.height), 0, 0);
  ctx!.imageSmoothingEnabled = true;
  ctx!.imageSmoothingQuality = 'high';
  ctx!.drawImage(off, 0, 0, canvas.width, canvas.height);
}

function scheduleDraw(hi: boolean): void {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    draw3d(hi);
  });
}

// ---------------------------------------------------------------- 交互

let drag: { x: number; y: number; az: number; el: number } | null = null;

canvas.addEventListener('pointerdown', (e) => {
  if (state.view !== '3d') return;
  drag = { x: e.clientX, y: e.clientY, az: state.az, el: state.el };
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    /* 某些环境不支持捕获，忽略 */
  }
  canvas.style.cursor = 'grabbing';
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  state.az = drag.az - (e.clientX - drag.x) * 0.35;
  // 俯角夹在 8°~89°：0° 只剩一片立面，90° 就退回平面图
  state.el = Math.max(8, Math.min(89, drag.el + (e.clientY - drag.y) * 0.25));
  scheduleDraw(false);
});
canvas.addEventListener('pointerup', (e) => {
  if (!drag) return;
  drag = null;
  canvas.style.cursor = 'grab';
  try {
    canvas.releasePointerCapture(e.pointerId);
  } catch {
    /* 已释放 */
  }
  draw3d(true);
});
canvas.addEventListener('wheel', (e) => {
  if (state.view !== '3d') return;
  e.preventDefault();
  state.zoom = Math.max(0.45, Math.min(2.6, state.zoom * (e.deltaY > 0 ? 0.92 : 1.08)));
  scheduleDraw(false);
  const w = canvas as unknown as { __t?: number };
  window.clearTimeout(w.__t);
  w.__t = window.setTimeout(() => draw3d(true), 220);
});
canvas.addEventListener('dblclick', () => {
  state.az = 40;
  state.el = 32;
  state.zoom = 1;
  draw3d(true);
});

// ---------------------------------------------------------------- 侧栏

function renderStats(c: ComposeCandidate): void {
  const m = c.comp.metrics;
  const terms = c.score.terms
    .map(
      (t) =>
        `<div style="display:flex;justify-content:space-between"><span>${t.k}</span><span>${(t.raw * 100).toFixed(0)}</span></div>`
    )
    .join('');
  stats.innerHTML =
    `<div style="margin-bottom:6px"><b>${c.comp.id}</b> · ${c.label}</div>` +
    `<div style="display:flex;justify-content:space-between"><span>建筑 / 地块</span><span><b>${c.comp.buildings.length}</b> / ${m.parcels}</span></div>` +
    `<div style="display:flex;justify-content:space-between"><span>覆盖 / FAR</span><span>${(m.coverage * 100).toFixed(0)}% / ${m.far.toFixed(2)}</span></div>` +
    `<div style="display:flex;justify-content:space-between"><span>车位</span><span>${m.stalls}</span></div>` +
    `<div style="display:flex;justify-content:space-between"><span>道路</span><span>${m.roadM2.toFixed(0)} m²</span></div>` +
    `<div style="display:flex;justify-content:space-between"><span>绿地 / 树</span><span>${(m.greenShare * 100).toFixed(0)}% / ${c.scene.trees.length}</span></div>` +
    `<div style="margin:8px 0 4px">评分分项（原始 0~100）</div>${terms}`;
}

function buildSiteButtons(): void {
  const box = $('#sites');
  box.innerHTML = '';
  for (const s of SITES) {
    const b = document.createElement('button');
    b.textContent = s.label;
    b.className = s.id === state.site ? 'on' : '';
    b.onclick = () => {
      state.site = s.id;
      state.cand = 0;
      primCache.clear();
      buildSiteButtons();
      generate();
    };
    box.appendChild(b);
  }
}

function buildCandidateButtons(): void {
  const box = $('#cands');
  box.innerHTML = '';
  cands.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = `cand${i === state.cand ? ' on' : ''}`;
    b.innerHTML =
      `<b>${c.label}</b><span class="sc">${c.score.total.toFixed(3)}</span>` +
      `<small>建筑 ${c.comp.buildings.length} 栋 · 覆盖 ${(c.comp.metrics.coverage * 100).toFixed(0)}% · 车位 ${c.comp.metrics.stalls} · ${c.ms} ms</small>` +
      `<small>${c.comp.validation.ok ? '✓ 硬约束通过' : `✗ ${c.comp.validation.errors.length} 项未通过`}</small>`;
    b.onclick = () => {
      state.cand = i;
      buildCandidateButtons();
      render();
    };
    box.appendChild(b);
  });
}

function error(msg: string): void {
  errBox.style.display = 'block';
  errBox.textContent = msg;
}

function generate(): void {
  busy.style.display = 'block';
  errBox.style.display = 'none';
  // 先让浏览器把"生成中"画出来：compose 是同步的，几百毫秒会占满主线程
  requestAnimationFrame(() =>
    setTimeout(() => {
      try {
        const r = composeCandidates(inputOf(state.site), { max: 3 });
        cands = r.cands;
        if (cands.length === 0) throw new Error('没有可用候选');
        state.cand = Math.min(state.cand, cands.length - 1);
        buildCandidateButtons();
        render();
      } catch (e) {
        error(`生成失败：${(e as Error).message}`);
      } finally {
        busy.style.display = 'none';
      }
    }, 30)
  );
}

document.querySelectorAll<HTMLButtonElement>('.views button[data-view]').forEach((btn) => {
  if (btn.dataset.view === state.view) {
    document.querySelectorAll('.views button[data-view]').forEach((x) => x.classList.remove('on'));
    btn.classList.add('on');
  }
  btn.onclick = () => {
    state.view = btn.dataset.view as '2d' | '3d';
    document.querySelectorAll('.views button[data-view]').forEach((x) => x.classList.remove('on'));
    btn.classList.add('on');
    render();
  };
});

$('#regen').onclick = () => {
  primCache.clear();
  generate();
};
$('#reset').onclick = () => {
  state.az = 40;
  state.el = 32;
  state.zoom = 1;
  render();
};

addEventListener('resize', () => {
  fitCanvas();
  render();
});

buildSiteButtons();
generate();
(window as unknown as { __labBooted: boolean }).__labBooted = true;
