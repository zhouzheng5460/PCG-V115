/** TownForge Skeleton v0.1 — independent, pure-data types. Units in meters. */
export type SiteTypology =
  | 'multi_family' | 'single_family' | 'retail' | 'industrial'
  | 'hotel' | 'data_center' | 'civic' | 'park' | 'green' | 'generic';

export type ShapeHint = 'wide'|'compact'|'narrow'|'multi_wing'|'irregular_ok';
export type PatternOperation =
  'analyze_site' | 'reserve_gates' | 'reserve_circulation'
  | 'reserve_building_zones' | 'place_building_grammar'
  | 'reserve_parking' | 'allocate_open_space' | 'validate_layout';
export interface SourceInfo { title:string; kind:string; url:string; license:string }
export interface PatternFit {
  minAreaM2:number;
  minEffectiveWidthM:number;
  minAspectRatio:number;
  maxAspectRatio:number;
  maxConcavity:number;
  shapeHint:ShapeHint;
  acceptsHole:boolean;
  areaNote:string;
}
export interface SkeletonPattern {
  id:string;
  typology:SiteTypology;
  labelZh:string;
  labelEn:string;
  provenance:{basisSourceIds:string[];relationship:'derived_composition';status:string};
  implementation:{state:'declarative_only';requires:string[];notProductionReady:true};
  fit:PatternFit;
  signature:{circulation:string;buildingGrammar:string;parkingPatternIds:string[];openSpace:string};
  zonePriority:string[];
  operators:Array<{op:PatternOperation;args?:Record<string,unknown>}>;
  adaptation:{prefer:string[];forConcavity:string;forTaper:string;forHoles:string;fallbackPatternId:string|null};
  hardChecks:string[];
  visualMetrics:string[];
  notesZh:string;
}
export interface SkeletonCatalogue {
  schemaVersion:string;
  name:string;
  compiledOn:string;
  units:'meter';
  status:'CATALOGUE_ONLY_NOT_EXECUTABLE_GEOMETRY';
  coordinateRule:string;
  sourceRefs:Record<string,SourceInfo>;
  patterns:SkeletonPattern[];
}
export interface ParkingPattern {
  id:string;
  labelZh:string;
  family:'surface_parking';
  provenance:{basisSourceIds:string[];relationship:'derived_composition';status:string};
  implementation:{state:'declarative_only';preferredProvider:string;fallbackProvider:string;providerCapabilityMustBeProbed:true};
  siteFit:{acceptsIrregularPolygon:boolean;acceptsHolesWithPreprocessing:boolean;minAreaM2:number;shapeHint:string};
  layout:{topology:string;rowMode:string;placementMethod:string;mustConnectAllAisles:boolean;mustReachAllStallFrontages:boolean;
    entryPinned:boolean;resolveAnglesDeg:number[];allowMultiAxis:boolean;turnaroundRule:string;greenIslands:boolean;greenIslandRule:string};
  parameterPolicy:Record<string,unknown>;
  operators:Array<{op:string;args?:Record<string,unknown>}>;
  hardChecks:string[];
  fallbackPatternId:string|null;
  noteZh:string;
}
export interface ParkingCatalogue {
  schemaVersion:string;
  name:string;
  status:'CATALOGUE_ONLY_NOT_EXECUTABLE_GEOMETRY';
  units:'meter';
  sourceRefs:Record<string,SourceInfo>;
  patterns:ParkingPattern[];
}
/** Coarse metrics computed from actual polygon; never feed bbox-only widths. */
export interface SiteMeasurements {
  typology:SiteTypology;
  areaM2:number;
  effectiveWidthM:number;
  aspectRatio:number;
  /** 0=convex, approaching 1=strongly concave. Estimate from area / convex hull. */
  concavity:number;
  frontageCount:number;
  hasHoles:boolean;
}
export interface PatternRanking {
  id:string;
  labelZh:string;
  score:number;
  candidate:boolean;
  reasons:string[];
  pattern:SkeletonPattern;
}
