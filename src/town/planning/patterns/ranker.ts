import type { SkeletonCatalogue, SiteMeasurements, PatternRanking, SkeletonPattern } from './skeleton-types';

/**
 * Preselect a small list of candidate skeletons without geometry operations.
 * A selected item is NOT a valid layout. Only downstream candidate generation,
 * polygon boolean checks, road connectivity and evaluator may mark it viable.
 */
export function selectSkeletons(
  catalog:SkeletonCatalogue,
  site:SiteMeasurements,
  maxCandidates=3
):PatternRanking[] {
  const ranked:PatternRanking[]=[];
  for (const p of catalog.patterns) {
    if (p.typology!==site.typology && p.typology!=='generic') continue;
    const f=p.fit;
    const reasons:string[]=[];
    let score=p.typology===site.typology ? 100 : 25;
    // Hard gate severe lack of space, not a building regulation; generic fallback remains.
    let candidate=true;
    if (site.areaM2<f.minAreaM2) {
      const deficit=(f.minAreaM2-site.areaM2)/f.minAreaM2;
      score-=Math.round(45*deficit+10);
      reasons.push(`面积不足推荐值：${Math.round(site.areaM2)}/${f.minAreaM2}㎡`);
      if (deficit>.35 && p.typology!=='generic') candidate=false;
    }
    if (site.effectiveWidthM<f.minEffectiveWidthM) {
      const deficit=(f.minEffectiveWidthM-site.effectiveWidthM)/f.minEffectiveWidthM;
      score-=Math.round(65*deficit+10);
      reasons.push(`有效宽度偏窄：${site.effectiveWidthM.toFixed(1)}/${f.minEffectiveWidthM}m`);
      if (deficit>.28 && p.typology!=='generic') candidate=false;
    }
    if (site.aspectRatio<f.minAspectRatio || site.aspectRatio>f.maxAspectRatio) {
      score-=18;reasons.push('长宽比不在优选区间');
    }
    if (site.concavity>f.maxConcavity) {
      score-=14;reasons.push('地块凹度较高，需要多翼分区和连接验证');
    }
    if (site.hasHoles && !f.acceptsHole) {
      score-=60; candidate=false; reasons.push('模式不支持内洞');
    }
    // Preference heuristics; use actual polygon metrics, not number of edges.
    if (f.shapeHint==='narrow' && site.aspectRatio>=2) score+=8;
    if (f.shapeHint==='compact' && site.aspectRatio<1.8) score+=8;
    if (f.shapeHint==='wide' && site.effectiveWidthM>50) score+=7;
    if (f.shapeHint==='multi_wing' && site.concavity>.25) score+=7;
    if (site.frontageCount===0 && p.signature.circulation!=='minimal_paths') {
      score-=30;reasons.push('无已确认的合法临街入口');
    }
    if (reasons.length===0) reasons.push('初筛条件吻合；仍需实际几何与连通检验');
    ranked.push({id:p.id,labelZh:p.labelZh,score,candidate,reasons,pattern:p});
  }
  return ranked.sort((a,b)=>Number(b.candidate)-Number(a.candidate)||b.score-a.score||a.id.localeCompare(b.id)).slice(0,Math.max(1,maxCandidates));
}
