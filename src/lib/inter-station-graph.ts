/**
 * Inter-station graph builder.
 *
 * Constructs a neighborhood subgraph centered on a station, using stop_times
 * as the primary edge source (same data as isochrone computation).
 *
 * Algorithm:
 *   1. Resolve center stop_ids (parent_station → all its children)
 *   2. Multi-source Dijkstra from ALL center stop_ids simultaneously
 *   3. Filter to stops within maxMinutes
 *   4. Aggregate stop_ids → parent_station representative nodes
 *   5. Build edges from the full travel graph (stop_times + transfers)
 *   6. Track dominant route_ids per edge (for transfer detection)
 *   7. Cap at maxNodes closest nodes for D3 performance
 */
import type { ParsedGtfs, InterStationGraph, InterStationNode, InterStationEdge, TransportMode } from './gtfs-types';
import { buildTravelGraph } from './isochrone';
import { MinHeap } from './min-heap';
import { routeTypeToMode } from './gtfs-types';

const MAX_NODES_DEFAULT = 80;

function multiSourceDijkstra(
  graph: Map<string, { to: string; seconds: number }[]>,
  sourceIds: Iterable<string>,
): Map<string, number> {
  const dist = new Map<string, number>();
  const heap = new MinHeap<string>();
  for (const id of sourceIds) {
    dist.set(id, 0);
    heap.push(0, id);
  }
  while (heap.size > 0) {
    const { key: d, value: id } = heap.pop()!;
    if (d > (dist.get(id) ?? Infinity)) continue;
    for (const edge of graph.get(id) ?? []) {
      const nd = d + edge.seconds;
      if (nd < (dist.get(edge.to) ?? Infinity)) {
        dist.set(edge.to, nd);
        heap.push(nd, edge.to);
      }
    }
  }
  return dist;
}

function buildStopRouteIndex(gtfs: ParsedGtfs): Map<string, { routeId: string; routeType: number }[]> {
  const tripRoute = new Map(gtfs.trips.map(t => [t.trip_id, t.route_id]));
  const routeType = new Map(gtfs.routes.map(r => [r.route_id, r.route_type]));
  const result = new Map<string, { routeId: string; routeType: number }[]>();
  for (const st of gtfs.stopTimes) {
    const routeId = tripRoute.get(st.trip_id);
    if (!routeId) continue;
    if (!result.has(st.stop_id)) result.set(st.stop_id, []);
    const list = result.get(st.stop_id)!;
    if (!list.some(r => r.routeId === routeId)) {
      list.push({ routeId, routeType: routeType.get(routeId) ?? 3 });
    }
  }
  return result;
}

function resolveRepresentative(stopId: string, stopMap: Map<string, { parent_station?: string }>): string {
  return stopMap.get(stopId)?.parent_station ?? stopId;
}

/**
 * Build a representative-pair → routes index from stop_times.
 * Only includes pairs where both reps are in `includedReps`.
 */
function buildRepPairRouteIndex(
  gtfs: ParsedGtfs,
  stopMap: Map<string, { parent_station?: string }>,
  includedReps: Set<string>,
): Map<string, Set<string>> {
  const tripRoute = new Map(gtfs.trips.map(t => [t.trip_id, t.route_id]));

  const tripStops = new Map<string, { stop_id: string; seq: number }[]>();
  for (const st of gtfs.stopTimes) {
    if (!tripStops.has(st.trip_id)) tripStops.set(st.trip_id, []);
    tripStops.get(st.trip_id)!.push({ stop_id: st.stop_id, seq: st.stop_sequence });
  }

  const repPairRoutes = new Map<string, Set<string>>();
  for (const [tripId, stops] of tripStops) {
    const routeId = tripRoute.get(tripId);
    if (!routeId) continue;
    stops.sort((a, b) => a.seq - b.seq);
    for (let i = 0; i < stops.length - 1; i++) {
      const fromRep = resolveRepresentative(stops[i].stop_id, stopMap);
      const toRep = resolveRepresentative(stops[i + 1].stop_id, stopMap);
      if (fromRep === toRep) continue;
      if (!includedReps.has(fromRep) || !includedReps.has(toRep)) continue;
      const key = `${fromRep}|||${toRep}`;
      if (!repPairRoutes.has(key)) repPairRoutes.set(key, new Set());
      repPairRoutes.get(key)!.add(routeId);
    }
  }
  return repPairRoutes;
}

/**
 * Build inter-station neighborhood graph centered on `centerStopId`.
 */
export function buildInterStationGraph(
  gtfs: ParsedGtfs,
  centerStopId: string,
  maxMinutes = 20,
  maxNodes = MAX_NODES_DEFAULT,
): InterStationGraph | null {
  const stopMap = new Map(gtfs.stops.map(s => [s.stop_id, s]));
  const centerStop = stopMap.get(centerStopId);
  if (!centerStop) return null;

  const centerStopIds = new Set<string>([centerStopId]);
  for (const s of gtfs.stops) {
    if (s.parent_station === centerStopId) centerStopIds.add(s.stop_id);
  }

  const travelGraph = buildTravelGraph(gtfs);
  const maxSeconds = maxMinutes * 60;
  const rawDistances = multiSourceDijkstra(travelGraph, centerStopIds);

  const repGroups = new Map<string, { minDist: number; children: string[] }>();
  for (const [stopId, dist] of rawDistances) {
    if (dist > maxSeconds) continue;
    const rep = resolveRepresentative(stopId, stopMap);
    const existing = repGroups.get(rep);
    if (existing) {
      if (dist < existing.minDist) existing.minDist = dist;
      existing.children.push(stopId);
    } else {
      repGroups.set(rep, { minDist: dist, children: [stopId] });
    }
  }

  const centerRep = resolveRepresentative(centerStopId, stopMap);
  if (!repGroups.has(centerRep)) {
    repGroups.set(centerRep, { minDist: 0, children: [centerStopId] });
  } else {
    repGroups.get(centerRep)!.minDist = 0;
  }

  const sortedReps = [...repGroups.entries()]
    .sort((a, b) => a[1].minDist - b[1].minDist)
    .slice(0, maxNodes);

  const includedReps = new Set(sortedReps.map(([rep]) => rep));
  const stopRouteIndex = buildStopRouteIndex(gtfs);

  // Build nodes
  const nodes = new Map<string, InterStationNode>();
  for (const [rep, { minDist, children }] of sortedReps) {
    const repStop = stopMap.get(rep);
    if (!repStop) continue;
    let sumLat = 0, sumLon = 0, validCount = 0;
    for (const sid of children) {
      const s = stopMap.get(sid);
      if (s && isFinite(s.stop_lat) && isFinite(s.stop_lon) && !(s.stop_lat === 0 && s.stop_lon === 0)) {
        sumLat += s.stop_lat; sumLon += s.stop_lon; validCount++;
      }
    }
    const lat = validCount > 0 ? sumLat / validCount : repStop.stop_lat;
    const lon = validCount > 0 ? sumLon / validCount : repStop.stop_lon;

    const routeSet = new Map<string, number>();
    for (const sid of children) {
      for (const { routeId, routeType } of stopRouteIndex.get(sid) ?? []) {
        routeSet.set(routeId, routeType);
      }
    }
    const modes: TransportMode[] = [...new Set([...routeSet.values()].map(rt => routeTypeToMode(rt)))];
    nodes.set(rep, {
      nodeId: rep, stopName: repStop.stop_name, lat, lon,
      isCenter: rep === centerRep, travelSeconds: minDist,
      routeCount: routeSet.size, modes, childStopIds: children,
    });
  }

  // Build rep-pair route index after includedReps is known
  const repPairRoutes = buildRepPairRouteIndex(gtfs, stopMap, includedReps);

  // Aggregate edges at representative level
  const edgeSums = new Map<string, { total: number; count: number; bidirectional: boolean; routes: Set<string> }>();

  const collectEdge = (fromRep: string, edge: { to: string; seconds: number }) => {
    const toRep = resolveRepresentative(edge.to, stopMap);
    if (!includedReps.has(toRep) || fromRep === toRep) return;
    const key = `${fromRep}|||${toRep}`;
    const rev = `${toRep}|||${fromRep}`;
    if (edgeSums.has(rev)) { edgeSums.get(rev)!.bidirectional = true; return; }
    const existing = edgeSums.get(key);
    if (existing) { existing.total += edge.seconds; existing.count++; }
    else { edgeSums.set(key, { total: edge.seconds, count: 1, bidirectional: false, routes: new Set() }); }
  };

  for (const [fromRep] of nodes) {
    for (const edge of travelGraph.get(fromRep) ?? []) collectEdge(fromRep, edge);
    const group = repGroups.get(fromRep);
    if (group) {
      for (const childId of group.children) {
        if (childId === fromRep) continue;
        for (const edge of travelGraph.get(childId) ?? []) collectEdge(fromRep, edge);
      }
    }
  }

  // Attach route info from rep-pair route index
  for (const [key, data] of edgeSums) {
    const [a, b] = key.split('|||');
    for (const r of repPairRoutes.get(key) ?? []) data.routes.add(r);
    for (const r of repPairRoutes.get(`${b}|||${a}`) ?? []) data.routes.add(r);
  }

  const edges: InterStationEdge[] = [];
  const adjacency = new Map<string, InterStationEdge[]>();
  const addEdge = (e: InterStationEdge): void => {
    edges.push(e);
    if (!adjacency.has(e.from)) adjacency.set(e.from, []);
    adjacency.get(e.from)!.push(e);
  };

  let stopTimesEdgeCount = 0;
  for (const [key, { total, count, bidirectional, routes }] of edgeSums) {
    const [from, to] = key.split('|||');
    if (!nodes.has(from) || !nodes.has(to)) continue;
    const avg = Math.round(total / count);
    const routeIds = [...routes];
    addEdge({ from, to, avgSeconds: avg, tripCount: count, isBidirectional: bidirectional, source: 'stop_times', routeIds });
    if (bidirectional) {
      addEdge({ from: to, to: from, avgSeconds: avg, tripCount: count, isBidirectional: true, source: 'stop_times', routeIds });
    }
    stopTimesEdgeCount++;
  }

  let transferEdgeCount = 0;
  for (const t of gtfs.transfers) {
    if (t.transfer_type === 3) continue;
    const fromRep = resolveRepresentative(t.from_stop_id, stopMap);
    const toRep = resolveRepresentative(t.to_stop_id, stopMap);
    if (!includedReps.has(fromRep) || !includedReps.has(toRep) || fromRep === toRep) continue;
    const cost = t.min_transfer_time ?? 120;
    const e: InterStationEdge = {
      from: fromRep, to: toRep, avgSeconds: cost, tripCount: 0,
      isBidirectional: true, source: 'transfer', routeIds: [],
    };
    addEdge(e);
    addEdge({ ...e, from: toRep, to: fromRep });
    transferEdgeCount++;
  }

  console.debug(
    `[InterStationGraph] "${centerStop.stop_name}": ` +
    `${nodes.size} nœuds, ${stopTimesEdgeCount} arcs stop_times, ${transferEdgeCount} arcs transfer ` +
    `(${maxMinutes} min, ${[...centerStopIds].length} stop_ids source)`,
  );

  return {
    centerNodeId: centerRep, centerName: centerStop.stop_name,
    nodes, edges, adjacency, maxTravelSeconds: maxSeconds,
    totalStopTimesEdges: stopTimesEdgeCount, transferEdgeCount,
  };
}
