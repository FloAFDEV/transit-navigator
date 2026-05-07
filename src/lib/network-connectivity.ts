/**
 * Network connectivity analysis.
 *
 * Operates on the full GTFS network (not just a neighborhood).
 * Aggregates all stops to parent_station representatives, then runs BFS
 * to identify connected components, orphan stops, and isolated subgraphs.
 *
 * Returns a ConnectivityDiagnostic that can be used to:
 *   - Color nodes in the graph by component
 *   - Show isolation causes in the strategic analysis
 *   - Identify network gaps and missing transfers
 */
import type { ParsedGtfs, ConnectivityDiagnostic, IsolatedSubgraph, IsolationCause } from './gtfs-types';
import { buildTravelGraph } from './isochrone';

function resolveRep(stopId: string, stopMap: Map<string, { parent_station?: string }>): string {
  return stopMap.get(stopId)?.parent_station ?? stopId;
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function componentCentroid(
  reps: string[],
  stopMap: Map<string, { stop_lat: number; stop_lon: number }>,
): { lat: number; lon: number } | null {
  let sumLat = 0, sumLon = 0, count = 0;
  for (const id of reps) {
    const s = stopMap.get(id);
    if (s && isFinite(s.stop_lat) && isFinite(s.stop_lon) && !(s.stop_lat === 0 && s.stop_lon === 0)) {
      sumLat += s.stop_lat; sumLon += s.stop_lon; count++;
    }
  }
  return count > 0 ? { lat: sumLat / count, lon: sumLon / count } : null;
}

function classifyIsolation(
  reps: string[],
  gtfs: ParsedGtfs,
  stopMap: Map<string, { stop_lat: number; stop_lon: number; parent_station?: string }>,
  allNames: Map<string, string>,
  stopsInStopTimes: Set<string>,
  mainCentroid: { lat: number; lon: number } | null,
  allOtherCentroids: { lat: number; lon: number }[],
  routesPerRep: Map<string, Set<string>>,
): IsolationCause {
  // 1. No stop_times link: none of the reps (or their children) appear in stop_times
  const hasLink = reps.some(id => {
    if (stopsInStopTimes.has(id)) return true;
    return gtfs.stops.some(s => s.parent_station === id && stopsInStopTimes.has(s.stop_id));
  });
  if (!hasLink) return 'no_stop_times_link';

  // 2. Single route branch: exactly 1 distinct route serves all reps in this component
  const allRoutes = new Set<string>();
  for (const id of reps) for (const r of routesPerRep.get(id) ?? []) allRoutes.add(r);
  if (allRoutes.size === 1) return 'single_route_branch';

  // 3. Parent station mismatch: stops share names with stops in other components
  const compNames = new Set(reps.map(id => allNames.get(id) ?? '').filter(Boolean));
  // (can't easily check against all components here; heuristic: skip)

  // 4. Geographic isolation: centroid is far from the main component centroid
  const centroid = componentCentroid(reps, stopMap);
  if (centroid && mainCentroid) {
    const distToMain = haversineKm(centroid.lat, centroid.lon, mainCentroid.lat, mainCentroid.lon);
    if (distToMain > 20) return 'geo_isolation';
  }

  // 5. Geographically close to another component but no transfer → missing_transfers
  if (centroid && allOtherCentroids.length > 0) {
    const minDist = Math.min(...allOtherCentroids.map(c => haversineKm(centroid.lat, centroid.lon, c.lat, c.lon)));
    if (minDist < 2) return 'missing_transfers';
  }

  return 'missing_transfers';
}

export function analyzeNetworkConnectivity(gtfs: ParsedGtfs): ConnectivityDiagnostic {
  const stopMap = new Map(gtfs.stops.map(s => [s.stop_id, s]));

  // Collect all representative stop_ids (parent_station or stop_id itself)
  const allReps = new Set<string>();
  for (const stop of gtfs.stops) {
    allReps.add(resolveRep(stop.stop_id, stopMap));
  }

  // Build bidirectional adjacency at the representative level
  const adj = new Map<string, Set<string>>();
  for (const rep of allReps) adj.set(rep, new Set());

  const travelGraph = buildTravelGraph(gtfs);
  for (const [from, edges] of travelGraph) {
    const fromRep = resolveRep(from, stopMap);
    if (!allReps.has(fromRep)) continue;
    for (const edge of edges) {
      const toRep = resolveRep(edge.to, stopMap);
      if (!allReps.has(toRep) || fromRep === toRep) continue;
      adj.get(fromRep)!.add(toRep);
      adj.get(toRep)!.add(fromRep);
    }
  }

  // Add transfer edges
  for (const t of gtfs.transfers) {
    if (t.transfer_type === 3) continue;
    const fromRep = resolveRep(t.from_stop_id, stopMap);
    const toRep = resolveRep(t.to_stop_id, stopMap);
    if (!allReps.has(fromRep) || !allReps.has(toRep) || fromRep === toRep) continue;
    adj.get(fromRep)!.add(toRep);
    adj.get(toRep)!.add(fromRep);
  }

  // BFS to find connected components
  const componentOf = new Map<string, number>();
  const componentMembers: string[][] = [];

  for (const start of allReps) {
    if (componentOf.has(start)) continue;
    const id = componentMembers.length;
    const members: string[] = [];
    const queue = [start];
    componentOf.set(start, id);
    while (queue.length > 0) {
      const curr = queue.shift()!;
      members.push(curr);
      for (const nb of adj.get(curr) ?? []) {
        if (!componentOf.has(nb)) {
          componentOf.set(nb, id);
          queue.push(nb);
        }
      }
    }
    componentMembers.push(members);
  }

  // Sort components by size (largest = index 0)
  const sorted = componentMembers
    .map((members, originalId) => ({ members, originalId }))
    .sort((a, b) => b.members.length - a.members.length);

  // Build final componentMap (repId → new componentId where 0 = largest)
  const componentMap = new Map<string, number>();
  for (let newId = 0; newId < sorted.length; newId++) {
    for (const rep of sorted[newId].members) componentMap.set(rep, newId);
  }

  // Collect diagnostics
  const stopsInStopTimes = new Set(gtfs.stopTimes.map(st => resolveRep(st.stop_id, stopMap)));
  const allNames = new Map(gtfs.stops.map(s => [resolveRep(s.stop_id, stopMap), s.stop_name]));

  // Routes per representative
  const tripRoute = new Map(gtfs.trips.map(t => [t.trip_id, t.route_id]));
  const routesPerRep = new Map<string, Set<string>>();
  for (const st of gtfs.stopTimes) {
    const rep = resolveRep(st.stop_id, stopMap);
    const routeId = tripRoute.get(st.trip_id);
    if (!routeId) continue;
    if (!routesPerRep.has(rep)) routesPerRep.set(rep, new Set());
    routesPerRep.get(rep)!.add(routeId);
  }

  const mainComponent = sorted[0]?.members ?? [];
  const mainCentroid = mainComponent.length > 0 ? componentCentroid(mainComponent, stopMap) : null;

  const isolatedSubgraphs: IsolatedSubgraph[] = [];
  const orphanNames: string[] = [];

  for (let newId = 1; newId < sorted.length; newId++) {
    const { members } = sorted[newId];
    const isOrphan = members.length === 1 && (adj.get(members[0])?.size ?? 0) === 0;

    const stationNames = members.map(id => allNames.get(id) ?? id);
    if (isOrphan) {
      orphanNames.push(stationNames[0]);
      continue;
    }

    // Get centroids of all other components (excluding this one and largest)
    const otherCentroids = sorted
      .filter((_, i) => i !== newId && i !== 0)
      .map(({ members: m }) => componentCentroid(m, stopMap))
      .filter((c): c is { lat: number; lon: number } => c !== null);

    const probableCause = classifyIsolation(
      members, gtfs, stopMap, allNames,
      stopsInStopTimes, mainCentroid, otherCentroids, routesPerRep,
    );

    isolatedSubgraphs.push({
      componentId: newId,
      size: members.length,
      stationIds: members,
      stationNames,
      probableCause,
    });
  }

  return {
    connectedComponents: sorted.length,
    largestComponentSize: sorted[0]?.members.length ?? 0,
    totalRepresentatives: allReps.size,
    orphanCount: orphanNames.length,
    orphanNames: orphanNames.slice(0, 20),
    isolatedSubgraphs: isolatedSubgraphs.slice(0, 50),
    componentMap,
  };
}

/** Generate a distinct HSL color for a component index. Component 0 (largest) is neutral blue. */
export function componentColor(componentId: number): string {
  if (componentId === 0) return 'hsl(215, 45%, 55%)';
  const hue = Math.round((componentId * 137.508) % 360);
  return `hsl(${hue}, 65%, 52%)`;
}

export const CAUSE_LABELS: Record<string, { label: string; color: string }> = {
  no_stop_times_link:       { label: 'Hors stop_times', color: 'hsl(215, 16%, 50%)' },
  single_route_branch:      { label: 'Branche mono-ligne', color: 'hsl(38, 92%, 50%)' },
  geo_isolation:            { label: 'Isolement géographique', color: 'hsl(280, 60%, 55%)' },
  missing_transfers:        { label: 'Correspondances manquantes', color: 'hsl(0, 72%, 55%)' },
  parent_station_mismatch:  { label: 'Désalignement parent_station', color: 'hsl(24, 90%, 52%)' },
};
