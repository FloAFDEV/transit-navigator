/**
 * Network analysis: correspondences, friction, centrality
 * Uses proximity-based correspondence detection (50m radius)
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

/** Haversine distance in meters between two lat/lon points */
function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000; // Earth radius in meters
  const toRad = (deg: number) => deg * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const PROXIMITY_RADIUS_M = 200;

/**
 * Build clusters of stops that are within PROXIMITY_RADIUS_M of each other.
 * Returns a map: stop_id → cluster_id
 */
function buildStopClusters(stops: ParsedGtfs['stops']): Map<string, string> {
  const stopCluster = new Map<string, string>();
  const clusters: string[][] = [];

  for (const stop of stops) {
    if (stop.stop_lat === 0 && stop.stop_lon === 0) continue;
    let assigned = false;

    for (const cluster of clusters) {
      // Check distance to the first stop in the cluster (representative)
      const rep = stops.find(s => s.stop_id === cluster[0]);
      if (!rep) continue;
      if (haversineMeters(stop.stop_lat, stop.stop_lon, rep.stop_lat, rep.stop_lon) <= PROXIMITY_RADIUS_M) {
        cluster.push(stop.stop_id);
        stopCluster.set(stop.stop_id, cluster[0]); // cluster id = first stop id
        assigned = true;
        break;
      }
    }

    if (!assigned) {
      clusters.push([stop.stop_id]);
      stopCluster.set(stop.stop_id, stop.stop_id);
    }
  }

  return stopCluster;
}

/** Build full network analysis from parsed GTFS data */
export function analyzeNetwork(gtfs: ParsedGtfs): AnalysisResult {
  // 0. Build proximity clusters
  const stopCluster = buildStopClusters(gtfs.stops);

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
  
  // Map stops to routes using cluster IDs for proximity matching
  const clusterToRoutes = new Map<string, Set<string>>();
  
  for (const st of gtfs.stopTimes) {
    const routeId = tripToRoute.get(st.trip_id);
    if (!routeId) continue;
    
    const ri = routeMap.get(routeId);
    if (ri) ri.stops.add(st.stop_id);
    
    const clusterId = stopCluster.get(st.stop_id) || st.stop_id;
    if (!clusterToRoutes.has(clusterId)) {
      clusterToRoutes.set(clusterId, new Set());
    }
    clusterToRoutes.get(clusterId)!.add(routeId);
  }
  
  // Update stop counts
  for (const ri of routeMap.values()) {
    ri.stopCount = ri.stops.size;
  }
  
  const routes = Array.from(routeMap.values()).filter(r => r.stopCount > 0);
  
  // 2. Find correspondences using proximity clusters
  const corrMap = new Map<string, Set<string>>();
  
  for (const [clusterId, routeIds] of clusterToRoutes.entries()) {
    const arr = Array.from(routeIds);
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const key = [arr[i], arr[j]].sort().join('|||');
        if (!corrMap.has(key)) corrMap.set(key, new Set());
        corrMap.get(key)!.add(clusterId);
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
  
  // 3. Station metrics (using clusters)
  const stopNameMap = new Map(gtfs.stops.map(s => [s.stop_id, s.stop_name]));
  
  const stationMetrics: StationMetrics[] = [];
  
  for (const [clusterId, routeIds] of clusterToRoutes.entries()) {
    const routeCount = routeIds.size;
    if (routeCount < 1) continue;
    
    const corr = (routeCount * (routeCount - 1)) / 2;
    
    stationMetrics.push({
      stopId: clusterId,
      stopName: stopNameMap.get(clusterId) || clusterId,
      routeCount,
      correspondences: corr,
      degree: routeCount,
      betweenness: 0,
      frictionIndex: routeCount > 0 ? corr / routeCount : 0,
    });
  }
  
  // Simplified betweenness
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
  
  const maxCorr = (routes.length * (routes.length - 1)) / 2;
  const networkRedundancy = maxCorr > 0 ? correspondences.length / maxCorr : 0;
  
  const maxFriction = Math.max(...stationMetrics.map(m => m.frictionIndex), 1);
  const readabilityScore = Math.max(0, 1 - avgFriction / maxFriction);
  
  return {
    routes,
    correspondences,
    stationMetrics,
    networkMetrics: {
      totalRoutes: routes.length,
      totalStops: clusterToRoutes.size,
      totalCorrespondences,
      averageFriction: avgFriction,
      networkRedundancy,
      readabilityScore,
    },
  };
}
