/**
 * Computes realistic transfer costs between platforms inside a station graph.
 *
 * Each TransferCost represents the full perceived cost of moving from one
 * stop/platform to another: walk time + wait time + friction penalty.
 */
import type { ParsedGtfs, StationGraph, TransferCost } from './gtfs-types';
import { dijkstraStation } from './station-graph';

// Estimated average wait time by GTFS route_type (seconds)
// These are empirical values — to be refined with calendar/frequencies data later.
const WAIT_BY_ROUTE_TYPE: Record<number, number> = {
  0: 300,  // tram
  1: 180,  // metro
  2: 600,  // train
  3: 420,  // bus
  4: 120,  // ferry
  5: 300,  // cable car
  6: 300,  // gondola
  7: 300,  // funicular
};

/**
 * Build a stop → route_type index from stop_times + trips + routes.
 * Returns the dominant route_type for each stop_id.
 */
function buildStopRouteTypeIndex(gtfs: ParsedGtfs): Map<string, number> {
  const tripRoute = new Map(gtfs.trips.map(t => [t.trip_id, t.route_id]));
  const routeType = new Map(gtfs.routes.map(r => [r.route_id, r.route_type]));

  // Count occurrences of each route_type per stop
  const stopTypeCounts = new Map<string, Map<number, number>>();
  for (const st of gtfs.stopTimes) {
    const routeId = tripRoute.get(st.trip_id);
    if (!routeId) continue;
    const rt = routeType.get(routeId) ?? 3;
    if (!stopTypeCounts.has(st.stop_id)) stopTypeCounts.set(st.stop_id, new Map());
    const counts = stopTypeCounts.get(st.stop_id)!;
    counts.set(rt, (counts.get(rt) ?? 0) + 1);
  }

  // Dominant route_type per stop
  const result = new Map<string, number>();
  for (const [stopId, counts] of stopTypeCounts) {
    let best = 3;
    let bestCount = 0;
    for (const [rt, count] of counts) {
      if (count > bestCount) { best = rt; bestCount = count; }
    }
    result.set(stopId, best);
  }
  return result;
}

/**
 * Compute the friction penalty in seconds for a transfer between two nodes.
 *
 * MVP: averages the frictionScore of the two endpoints × a scaling factor.
 * A frictionScore of 1.0 adds up to MAX_FRICTION_PENALTY seconds.
 */
const MAX_FRICTION_PENALTY = 120; // seconds

function frictionPenalty(graph: StationGraph, fromId: string, toId: string): number {
  const fn = graph.nodes.get(fromId);
  const tn = graph.nodes.get(toId);
  const avg = ((fn?.frictionScore ?? 0) + (tn?.frictionScore ?? 0)) / 2;
  return Math.round(avg * MAX_FRICTION_PENALTY);
}

/**
 * Compute all transfer costs within a StationGraph.
 *
 * Runs Dijkstra from each node and builds a cost matrix for all node pairs
 * that are actually reachable. Pairs with walk time > MAX_WALK_SECONDS are
 * dropped (they represent distinct stations, not intra-station transfers).
 */
const MAX_WALK_SECONDS = 600; // 10 minutes — above this it's a separate station

export function computeTransferCosts(
  graph: StationGraph,
  gtfs: ParsedGtfs,
): TransferCost[] {
  const stopRouteType = buildStopRouteTypeIndex(gtfs);
  const costs: TransferCost[] = [];

  for (const [fromId] of graph.nodes) {
    const dist = dijkstraStation(graph, fromId);

    for (const [toId, walkSeconds] of dist) {
      if (toId === fromId) continue;
      if (walkSeconds > MAX_WALK_SECONDS) continue;

      const dominantType = stopRouteType.get(toId) ?? 3;
      const waitSeconds = WAIT_BY_ROUTE_TYPE[dominantType] ?? 420;
      const penalty = frictionPenalty(graph, fromId, toId);

      costs.push({
        fromStopId: fromId,
        toStopId: toId,
        walkSeconds,
        waitSeconds,
        frictionPenalty: penalty,
        totalCostSeconds: walkSeconds + waitSeconds + penalty,
        transferType: 0,
      });
    }
  }

  // Sort by total cost ascending for convenient consumption
  costs.sort((a, b) => a.totalCostSeconds - b.totalCostSeconds);
  return costs;
}

/**
 * Look up the cheapest transfer cost between two specific stops.
 * Returns undefined if no path exists between them.
 */
export function getTransferCost(
  costs: TransferCost[],
  fromStopId: string,
  toStopId: string,
): TransferCost | undefined {
  return costs.find(c => c.fromStopId === fromStopId && c.toStopId === toStopId);
}
