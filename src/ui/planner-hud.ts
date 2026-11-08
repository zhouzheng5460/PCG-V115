// R8 · Planner Debug HUD（最小可用版）
//
// ## 为什么先做这个，而不是先做 palette
//
// 用户的要求很明确：**"我在前端工具上要能看到变化"**。
// 所以第一版 HUD 只回答四个问题：
//
//   Mode       —— 现在跑的是哪条链
//   Typology   —— 这块地被判成什么
//   Archetype  —— 用了哪个候选
//   Score/Margin —— 选优有多确定
//   Intensity  —— 强度落在目标带的哪一段
//
// LOW_SELECTION_CONFIDENCE 要显眼（黄色）：64 个样本里还有 20 个选优 margin < 0.15，
// 这个信号在开发期必须随时看得见，否则"Planner 选得不对"会变成一件看不到的事。
//
// 不做复杂面板：字段能加就加，但排版要能一眼扫完。

import type { PlanningMode, PlannerBundle, PlannerParcelReport } from '../scene/planner-bridge';

export interface PlannerHudState {
  mode: PlanningMode;
  /** 当前关注的地块（选中态）；没有就显示全局摘要 */
  report?: PlannerParcelReport | null;
  bundle?: PlannerBundle | null;
}

const MODE_LABEL: Record<PlanningMode, string> = {
  legacy: 'Legacy',
  planner: 'Planner',
  f3: 'F3 城市',
};

const STATE_LABEL: Record<string, string> = {
  below: '偏稀',
  in_hard: '带内',
  in_preferred: '带内(优)',
  above: '偏密',
};

/** 把 HUD 渲染成一段 HTML（塞进 #stats 之类的地方） */
export function plannerHudHtml(st: PlannerHudState): string {
  const rows: string[] = [];
  rows.push(
    `<div class="hud-row hud-mode"><span class="hud-k">Mode</span><span class="hud-v hud-${st.mode}">${MODE_LABEL[st.mode]}</span></div>`
  );

  const r = st.report;
  if (!r) {
    const b = st.bundle;
    rows.push(
      `<div class="hud-row"><span class="hud-k">地块</span><span class="hud-v">未选中</span></div>`
    );
    if (b) {
      const covered = b.stats.covered;
      const total = b.stats.total;
      rows.push(
        `<div class="hud-row"><span class="hud-k">接管</span><span class="hud-v">${covered}/${total} 块</span></div>`
      );
      for (const [t, v] of Object.entries(b.stats.byTypology)) {
        if (v.covered === 0 && v.total === 0) continue;
        rows.push(
          `<div class="hud-sub">${t} ${v.covered}/${v.total}</div>`
        );
      }
    }
    if (st.mode === 'legacy') {
      rows.push(`<div class="hud-note">切到 Planner 看真实产出</div>`);
    }
    return `<div class="planner-hud">${rows.join('')}</div>`;
  }

  rows.push(`<div class="hud-row"><span class="hud-k">Typology</span><span class="hud-v">${r.typologyLabel}</span></div>`);
  rows.push(`<div class="hud-row"><span class="hud-k">Parcel</span><span class="hud-v">${r.parcelId}</span></div>`);

  if (!r.covered) {
    rows.push(`<div class="hud-note">${r.reason ?? '未被 Planner 接管'}</div>`);
    return `<div class="planner-hud">${rows.join('')}</div>`;
  }

  rows.push(`<div class="hud-row"><span class="hud-k">Archetype</span><span class="hud-v">${r.candidateId ?? '-'}</span></div>`);
  rows.push(
    `<div class="hud-row"><span class="hud-k">Score</span><span class="hud-v">${r.score?.toFixed(2) ?? '-'}</span></div>`
  );
  const marginTxt = r.margin === null || r.margin === undefined ? '-' : r.margin.toFixed(2);
  rows.push(
    `<div class="hud-row"><span class="hud-k">Margin</span><span class="hud-v${r.lowConfidence ? ' hud-warn' : ''}">${marginTxt}${
      r.lowConfidence ? ' ⚠ LOW' : ''
    }</span></div>`
  );
  if (r.intensity) {
    const st = r.intensity.state;
    const cls = st === 'below' || st === 'above' ? 'hud-warn' : '';
    rows.push(
      `<div class="hud-row"><span class="hud-k">Intensity</span><span class="hud-v ${cls}">${r.intensity.label} · ${STATE_LABEL[st] ?? st}</span></div>`
    );
  }
  if (r.buildings !== undefined) {
    rows.push(
      `<div class="hud-row"><span class="hud-k">体量</span><span class="hud-v">${r.buildings} 栋 · 覆盖 ${(
        (r.coverage ?? 0) * 100
      ).toFixed(0)}%</span></div>`
    );
  }
  if (r.candidateCount !== undefined && r.candidateCount > 1) {
    rows.push(`<div class="hud-sub">候选 ${r.candidateCount} 个</div>`);
  }
  return `<div class="planner-hud">${rows.join('')}</div>`;
}

/** 把 HUD 挂到某个容器上 */
export function mountPlannerHud(container: HTMLElement): (st: PlannerHudState) => void {
  container.classList.add('planner-hud-host');
  return (st: PlannerHudState) => {
    container.innerHTML = plannerHudHtml(st);
  };
}
