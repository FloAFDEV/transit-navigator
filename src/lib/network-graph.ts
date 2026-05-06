/**
 * Network graph metrics for dependency analysis.
 * Computes hub scores, vulnerability, attractivity, and articulation points
 * from an existing AnalysisResult + raw GTFS data.
 */
import type { ParsedGtfs, TransportMode } from './gtfs-types';
import type { AnalysisResult } from './network-analysis';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GraphNode {
  id: string;
  name: string;
  lat: number;
  lon: number;
  // Raw metrics
  routeCount: number;
  degree: number;
  correspondences: number;
  modes: TransportMode[];
  // Normalized scores (0–1)
  betweenness: number;
  hubScore: number;
  vulnerabilityScore: number;
  attractivityScore: number;
  frictionScore: number;
  // Classification
  isArticulation: boolean;
  tier: 'hub' | 'secondary' | 'peripheral' | 'isolated';
  // D3 simulation positions (mutable)
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
}

export interface GraphEdge {
  sourceId: string;
  targetId: string;
  weight: number;
  modes: TransportMode[];
  // D3 link fields (populated by simulation)
  source?: string | GraphNode;
  target?: string | GraphNode;
}

export interface NetworkGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: {
    hubCount: number;
    secondaryCount: number;
    peripheralCount: number;
    isolatedCount: number;
    articulationCount: number;
    avgDegree: number;
    maxDegree: number;
    density: number;
  };
}

// ─── Articulation point detection (iterative Tarjan DFS) ─────────────────────

function findArticulationPoints(adj: Map<string, string[]>): Set<string> {
  const disc    = new Map<string, number>();
  const low     = new Map<string, number>();
  const parent  = new Map<string, string | null>();
  const nChild  = new Map<string, number>(); // DFS tree children count
  const ap      = new Set<string>();
  let timer     = 0;

  for (const start of adj.keys()) {
    if (disc.has(start)) continue;

    disc.set(start, timer);
    low.set(start, timer++);
    parent.set(start, null);
    nChild.set(start, 0);

    const stack: { node: string; ni: number }[] = [{ node: start, ni: 0 }];

    while (stack.length > 0) {
      const frame    = stack[stack.length - 1];
      const u        = frame.node;
      const nbrs     = adj.get(u) ?? [];

      if (frame.ni < nbrs.length) {
        const v = nbrs[frame.ni++];
        if (!disc.has(v)) {
          // Tree edge
          parent.set(v, u);
          nChild.set(u, (nChild.get(u) ?? 0) + 1);
          disc.set(v, timer);
          low.set(v, timer++);
          nChild.set(v, 0);
          stack.push({ node: v, ni: 0 });
        } else if (v !== parent.get(u)) {
          // Back edge
          low.set(u, Math.min(low.get(u)!, disc.get(v)!));
        }
      } else {
        stack.pop();
        const p = parent.get(u);
        if (p !== null && p !== undefined) {
          low.set(p, Math.min(low.get(p)!, low.get(u)!));
          if (parent.get(p) === null) {
            // p is root: AP iff it has 2+ DFS-tree children
            if ((nChild.get(p) ?? 0) > 1) ap.add(p);
          } else {
            // Non-root: AP iff low[u] >= disc[p]
            if (low.get(u)! >= disc.get(p)!) ap.add(p);
          }
        }
      }
    }
  }

  return ap;
}

// ─── Main builder ─────────────────────────────────────────────────────────────

export function buildNetworkGraph(gtfs: ParsedGtfs, analysis: AnalysisResult): NetworkGraph {
  const { stationMetrics, correspondences, routes } = analysis;

  // Stop positions
  const stopPos = new Map(gtfs.stops.map(s => [s.stop_id, [s.stop_lat, s.stop_lon] as [number, number]]));

  // Route → mode map
  const routeMode = new Map(routes.map(r => [r.routeId, r.mode]));

  // Station → routes map (built from correspondences)
  const stationRoutes = new Map<string, Set<string>>();
  for (const corr of correspondences) {
    for (const sid of corr.sharedStops) {
      if (!stationRoutes.has(sid)) stationRoutes.set(sid, new Set());
      stationRoutes.get(sid)!.add(corr.routeA);
      stationRoutes.get(sid)!.add(corr.routeB);
    }
  }

  // Top stations (multi-route, capped for performance)
  const topStations = stationMetrics
    .filter(s => s.routeCount >= 2)
    .slice(0, 160);
  const stationSet = new Set(topStations.map(s => s.stopId));

  // Build edges: stations connected when they share a route
  const edgeMap = new Map<string, { sourceId: string; targetId: string; weight: number; modes: Set<TransportMode> }>();

  for (const route of routes) {
    const mode    = routeMode.get(route.routeId) ?? 'bus';
    const onRoute = topStations.filter(s => stationRoutes.get(s.stopId)?.has(route.routeId));
    for (let i = 0; i < onRoute.length; i++) {
      for (let j = i + 1; j < onRoute.length; j++) {
        const key = [onRoute[i].stopId, onRoute[j].stopId].sort().join('|||');
        if (!edgeMap.has(key)) {
          edgeMap.set(key, { sourceId: onRoute[i].stopId, targetId: onRoute[j].stopId, weight: 0, modes: new Set() });
        }
        const e = edgeMap.get(key)!;
        e.weight++;
        e.modes.add(mode);
      }
    }
  }

  const edges: GraphEdge[] = Array.from(edgeMap.values())
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 500)
    .map(e => ({ ...e, modes: Array.from(e.modes) as TransportMode[] }));

  // Adjacency for articulation points
  const adj = new Map<string, string[]>(topStations.map(s => [s.stopId, []]));
  for (const e of edges) {
    adj.get(e.sourceId)?.push(e.targetId);
    adj.get(e.targetId)?.push(e.sourceId);
  }
  const artPoints = findArticulationPoints(adj);

  // Normalization helpers
  const maxRC   = Math.max(...topStations.map(s => s.routeCount), 1);
  const maxDeg  = Math.max(...topStations.map(s => s.degree), 1);
  const maxBtw  = Math.max(...topStations.map(s => s.betweenness), 0.001);
  const maxFric = Math.max(...topStations.map(s => s.frictionIndex), 0.001);
  const maxCorr = Math.max(...topStations.map(s => s.correspondences), 1);

  const norm = (v: number, max: number) => Math.max(0, Math.min(1, v / max));

  // Build GraphNode[]
  const nodes: GraphNode[] = topStations.map(s => {
    const pos  = stopPos.get(s.stopId) ?? [0, 0];
    const nRC  = norm(s.routeCount, maxRC);
    const nDeg = norm(s.degree, maxDeg);
    const nBtw = norm(s.betweenness, maxBtw);
    const nFr  = norm(s.frictionIndex, maxFric);
    const nCor = norm(s.correspondences, maxCorr);
    const isAP = artPoints.has(s.stopId);

    const hubScore         = 0.4 * nRC + 0.3 * nDeg + 0.3 * nBtw;
    const vulnerabilityScore = Math.min(1, (isAP ? 0.45 : 0) + 0.35 * nBtw + 0.20 * nRC);
    const attractivityScore  = 0.45 * nRC + 0.35 * nCor + 0.20 * nDeg;
    const frictionScore      = nFr;

    const tier: GraphNode['tier'] =
      hubScore >= 0.65 ? 'hub' :
      hubScore >= 0.35 ? 'secondary' :
      s.degree >= 2    ? 'peripheral' : 'isolated';

    // Modes served at this station
    const modesSet = new Set<TransportMode>();
    for (const [routeId, mode] of routeMode) {
      if (stationRoutes.get(s.stopId)?.has(routeId)) modesSet.add(mode);
    }

    return {
      id: s.stopId,
      name: s.stopName,
      lat:  pos[0],
      lon:  pos[1],
      routeCount:    s.routeCount,
      degree:        s.degree,
      correspondences: s.correspondences,
      modes: Array.from(modesSet) as TransportMode[],
      betweenness:       nBtw,
      hubScore,
      vulnerabilityScore,
      attractivityScore,
      frictionScore,
      isArticulation: isAP,
      tier,
    };
  });

  const n              = nodes.length;
  const maxPossible    = (n * (n - 1)) / 2;
  const hubCount       = nodes.filter(nd => nd.tier === 'hub').length;
  const secondaryCount = nodes.filter(nd => nd.tier === 'secondary').length;
  const peripheralCount= nodes.filter(nd => nd.tier === 'peripheral').length;
  const isolatedCount  = nodes.filter(nd => nd.tier === 'isolated').length;

  return {
    nodes,
    edges,
    stats: {
      hubCount,
      secondaryCount,
      peripheralCount,
      isolatedCount,
      articulationCount: artPoints.size,
      avgDegree: n > 0 ? nodes.reduce((s, nd) => s + nd.degree, 0) / n : 0,
      maxDegree: maxDeg,
      density:   maxPossible > 0 ? edges.length / maxPossible : 0,
    },
  };
}
