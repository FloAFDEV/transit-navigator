/**
 * Network analysis: correspondences, friction, centrality
 */
import type { ParsedGtfs, TransportMode } from './gtfs-types';
import { routeTypeToMode } from './gtfs-types';

export interface RouteInfo {
  routeId: string;
  name: string;
  mode: TransportMode;
  color: string;
  tripCount: number;
  stopCount: number;
  stops: Set<string>;
}

export interface Correspondence {
  routeA: string;
  routeB: string;
  sharedStops: string[];
  weight: number;
}

export interface StationMetrics {
  stopId: string;
  stopName: string;
  routeCount: number;
  correspondences: number;
  degree: number;
  betweenness: number;
  frictionIndex: number;
}

export interface NetworkMetrics {
  totalRoutes: number;
  totalStops: number;
  totalCorrespondences: number;
  averageFriction: number;
  networkRedundancy: number;
  readabilityScore: number;
}

export interface AnalysisResult {
  routes: RouteInfo[];
  correspondences: Correspondence[];
  stationMetrics: StationMetrics[];
  networkMetrics: NetworkMetrics;
}

/** Build full network analysis from parsed GTFS data */
export function analyzeNetwork(gtfs: ParsedGtfs): AnalysisResult {
  // 1. Build route info with stops per route
  const routeMap = new Map<string, RouteInfo>();
  const tripToRoute = new Map<string, string>();
  
  for (const route of gtfs.routes) {
    routeMap.set(route.route_id, {
      routeId: route.route_id,
      name: route.route_short_name || route.route_long_name || route.route_id,
      mode: routeTypeToMode(route.route_type),
      color: route.route_color ? `#${route.route_color}` : '',
      tripCount: 0,
      stopCount: 0,
      stops: new Set<string>(),
    });
  }
  
  for (const trip of gtfs.trips) {
    tripToRoute.set(trip.trip_id, trip.route_id);
    const ri = routeMap.get(trip.route_id);
    if (ri) ri.tripCount++;
  }
  
  // Map stops to routes
  const stopToRoutes = new Map<string, Set<string>>();
  
  for (const st of gtfs.stopTimes) {
    const routeId = tripToRoute.get(st.trip_id);
    if (!routeId) continue;
    
    const ri = routeMap.get(routeId);
    if (ri) ri.stops.add(st.stop_id);
    
    if (!stopToRoutes.has(st.stop_id)) {
      stopToRoutes.set(st.stop_id, new Set());
    }
    stopToRoutes.get(st.stop_id)!.add(routeId);
  }
  
  // Update stop counts
  for (const ri of routeMap.values()) {
    ri.stopCount = ri.stops.size;
  }
  
  const routes = Array.from(routeMap.values()).filter(r => r.stopCount > 0);
  
  // 2. Find correspondences (routes sharing stops)
  const corrMap = new Map<string, Set<string>>();
  
  for (const [stopId, routeIds] of stopToRoutes.entries()) {
    const arr = Array.from(routeIds);
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const key = [arr[i], arr[j]].sort().join('|||');
        if (!corrMap.has(key)) corrMap.set(key, new Set());
        corrMap.get(key)!.add(stopId);
      }
    }
  }
  
  const correspondences: Correspondence[] = Array.from(corrMap.entries()).map(([key, stops]) => {
    const [routeA, routeB] = key.split('|||');
    return {
      routeA,
      routeB,
      sharedStops: Array.from(stops),
      weight: stops.size,
    };
  });
  
  // 3. Station metrics
  const stopNameMap = new Map(gtfs.stops.map(s => [s.stop_id, s.stop_name]));
  
  // Calculate degree for each stop (number of routes)
  const stationMetrics: StationMetrics[] = [];
  
  for (const [stopId, routeIds] of stopToRoutes.entries()) {
    const routeCount = routeIds.size;
    if (routeCount < 1) continue;
    
    // Correspondences = number of route pairs at this stop
    const corr = (routeCount * (routeCount - 1)) / 2;
    
    stationMetrics.push({
      stopId,
      stopName: stopNameMap.get(stopId) || stopId,
      routeCount,
      correspondences: corr,
      degree: routeCount,
      betweenness: 0, // Will compute simplified betweenness below
      frictionIndex: routeCount > 0 ? corr / routeCount : 0,
    });
  }
  
  // Simplified betweenness: proportion of routes going through this stop
  const totalRouteCount = routes.length;
  for (const sm of stationMetrics) {
    sm.betweenness = totalRouteCount > 0 ? sm.routeCount / totalRouteCount : 0;
  }
  
  // Sort by friction descending
  stationMetrics.sort((a, b) => b.frictionIndex - a.frictionIndex);
  
  // 4. Network-level metrics
  const totalCorrespondences = correspondences.reduce((s, c) => s + c.weight, 0);
  const avgFriction = stationMetrics.length > 0
    ? stationMetrics.reduce((s, m) => s + m.frictionIndex, 0) / stationMetrics.length
    : 0;
  
  // Redundancy: ratio of correspondences to possible correspondences
  const maxCorr = (routes.length * (routes.length - 1)) / 2;
  const networkRedundancy = maxCorr > 0 ? correspondences.length / maxCorr : 0;
  
  // Readability: inverse of average friction normalized
  const maxFriction = Math.max(...stationMetrics.map(m => m.frictionIndex), 1);
  const readabilityScore = Math.max(0, 1 - avgFriction / maxFriction);
  
  return {
    routes,
    correspondences,
    stationMetrics,
    networkMetrics: {
      totalRoutes: routes.length,
      totalStops: stopToRoutes.size,
      totalCorrespondences,
      averageFriction: avgFriction,
      networkRedundancy,
      readabilityScore,
    },
  };
}
