import type { AnalysisResult, RouteInfo, Correspondence, StationMetrics, NetworkMetrics } from './network-analysis';
import type { GtfsStop } from './gtfs-types';
import type { IsochroneNode } from './isochrone';

interface SerializedRoute extends Omit<RouteInfo, 'stops'> {
  stops: string[];
}

interface SerializedAnalysis {
  routes: SerializedRoute[];
  correspondences: Correspondence[];
  stationMetrics: StationMetrics[];
  networkMetrics: NetworkMetrics;
}

export interface ShareData {
  v: 1;
  fileName: string;
  analysis: SerializedAnalysis;
  stops: GtfsStop[];
  isochroneNodes: IsochroneNode[];
  centerId: string | null;
  maxMin: number;
}

function uid(): string {
  return Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
}

function serialize(analysis: AnalysisResult): SerializedAnalysis {
  return {
    ...analysis,
    routes: analysis.routes.map(r => ({ ...r, stops: Array.from(r.stops) })),
  };
}

export function deserializeAnalysis(data: ShareData): AnalysisResult {
  return {
    ...data.analysis,
    routes: data.analysis.routes.map(r => ({ ...r, stops: new Set(r.stops) })),
  };
}

export function saveShare(
  analysis: AnalysisResult,
  stops: GtfsStop[],
  fileName: string,
  isochroneNodes: IsochroneNode[],
  centerId: string | null,
  maxMin: number,
): string {
  const id = uid();
  const payload: ShareData = {
    v: 1,
    fileName,
    analysis: serialize(analysis),
    stops,
    isochroneNodes,
    centerId,
    maxMin,
  };
  localStorage.setItem(`share:${id}`, JSON.stringify(payload));
  return id;
}

export function loadShare(id: string): ShareData | null {
  const raw = localStorage.getItem(`share:${id}`);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as ShareData;
    if (data.v !== 1) return null;
    return data;
  } catch {
    return null;
  }
}
