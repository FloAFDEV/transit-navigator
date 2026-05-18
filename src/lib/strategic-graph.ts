/**
 * Strategic network graph builder.
 *
 * Aggregates raw GTFS stops into logical stations (1 node = 1 parent_station or stop_id).
 * Edges are derived 100% from GTFS stop_times and transfers — no geographic inference.
 */
import type { ParsedGtfs, TransportMode } from './gtfs-types';
import { routeTypeToMode } from './gtfs-types';
import { buildTravelGraph } from './isochrone';

export type StationRole = 'hub' | 'terminus' | 'branch' | 'isolated';

export interface StrategicNode {
  id: string;             // canonical id (parent_station or stop_id)
  name: string;           // cleaned station name
  lat: number;
  lon: number;
  childStopIds: string[]; // all raw stop_ids aggregated here
  routeIds: string[];     // distinct routes serving this node
  modes: TransportMode[];
  degree: number;         // number of unique neighbor nodes (filled after build)
  tripCount: number;      // total trip edges touching this node
  componentId: number;    // filled by analyzeStrategicConnectivity
  role: StationRole;      // filled after build
}

export interface StrategicEdge {
  from: string;
  to: string;
  tripCount: number;       // number of distinct trip-passages on this link
  avgSeconds: number;
  routeIds: string[];
  isBidirectional: boolean;
  source: 'stop_times' | 'transfer';
}

export interface StrategicGraph {
  nodes: Map<string, StrategicNode>;
  edges: StrategicEdge[];
  adjacency: Map<string, StrategicEdge[]>;
  totalNodes: number;
  totalEdges: number;
  maxDegree: number;
  maxTripCount: number; // max tripCount across all edges
}

/** Resolve a stop_id to its canonical station id */
function canonicalId(stopId: string, stopMap: Map<string, { parent_station?: string }>): string {
  return stopMap.get(stopId)?.parent_station ?? stopId;
}

export function buildStrategicGraph(gtfs: ParsedGtfs): StrategicGraph {
  const stopMap = new Map(gtfs.stops.map(s => [s.stop_id, s]));

  // ── 1. Build node stubs ────────────────────────────────────────────────────
  // Only include stops that appear in stop_times (location_type === 0, or unset)
  const stopsInStopTimes = new Set(gtfs.stopTimes.map(st => st.stop_id));

  // Map canonical_id → node (initialise)
  const nodes = new Map<string, StrategicNode>();

  const ensureNode = (cid: string) => {
    if (!nodes.has(cid)) {
      const stop = stopMap.get(cid);
      nodes.set(cid, {
        id: cid,
        name: stop?.stop_name ?? cid,
        lat: 0,
        lon: 0,
        childStopIds: [],
        routeIds: [],
        modes: [],
        degree: 0,
        tripCount: 0,
        componentId: 0,
        role: 'branch',
      });
    }
    return nodes.get(cid)!;
  };

  // Accumulate coords per canonical node
  const coordAccum = new Map<string, { sumLat: number; sumLon: number; count: number }>();

  for (const stop of gtfs.stops) {
    // Only platform/stop nodes (location_type 0 or undefined) that are in stop_times
    const lt = stop.location_type ?? 0;
    if (lt !== 0) continue;
    if (!stopsInStopTimes.has(stop.stop_id)) continue;

    const cid = canonicalId(stop.stop_id, stopMap);
    const node = ensureNode(cid);
    node.childStopIds.push(stop.stop_id);

    // Accumulate coords
    if (isFinite(stop.stop_lat) && isFinite(stop.stop_lon) &&
        !(stop.stop_lat === 0 && stop.stop_lon === 0)) {
      if (!coordAccum.has(cid)) coordAccum.set(cid, { sumLat: 0, sumLon: 0, count: 0 });
      const acc = coordAccum.get(cid)!;
      acc.sumLat += stop.stop_lat;
      acc.sumLon += stop.stop_lon;
      acc.count++;
    }
  }

  // Finalise centroid coords
  for (const [cid, acc] of coordAccum) {
    const node = nodes.get(cid)!;
    node.lat = acc.sumLat / acc.count;
    node.lon = acc.sumLon / acc.count;
  }

  // ── 2. Collect routes per node ─────────────────────────────────────────────
  const tripRoute = new Map(gtfs.trips.map(t => [t.trip_id, t.route_id]));
  const routeType = new Map(gtfs.routes.map(r => [r.route_id, r.route_type]));

  for (const st of gtfs.stopTimes) {
    const cid = canonicalId(st.stop_id, stopMap);
    const node = nodes.get(cid);
    if (!node) continue;
    const rid = tripRoute.get(st.trip_id);
    if (rid && !node.routeIds.includes(rid)) node.routeIds.push(rid);
  }

  // Deduplicate routeIds and resolve modes
  for (const node of nodes.values()) {
    node.routeIds = [...new Set(node.routeIds)];
    const modeSet = new Set<TransportMode>();
    for (const rid of node.routeIds) {
      const rt = routeType.get(rid);
      if (rt !== undefined) modeSet.add(routeTypeToMode(rt));
    }
    node.modes = [...modeSet];
  }

  // ── 3. Build edges from stop_times ─────────────────────────────────────────
  // Use buildTravelGraph to get raw edges between stop_ids
  const travelGraph = buildTravelGraph(gtfs);

  // Accumulate directed canonical edges: key = "fromCid|||toCid"
  interface EdgeAccum {
    totalSeconds: number;
    tripCount: number;
    routeIds: Set<string>;
  }
  const directedEdges = new Map<string, EdgeAccum>();

  for (const [fromStopId, rawEdges] of travelGraph) {
    const fromCid = canonicalId(fromStopId, stopMap);
    if (!nodes.has(fromCid)) continue;

    for (const rawEdge of rawEdges) {
      const toCid = canonicalId(rawEdge.to, stopMap);
      if (!nodes.has(toCid)) continue;
      if (fromCid === toCid) continue; // intra-station

      const key = `${fromCid}|||${toCid}`;
      const existing = directedEdges.get(key);
      if (existing) {
        existing.totalSeconds += rawEdge.seconds;
        existing.tripCount++;
      } else {
        directedEdges.set(key, { totalSeconds: rawEdge.seconds, tripCount: 1, routeIds: new Set() });
      }
    }
  }

  // Attach route ids to directed edges via stop_times
  // We need to know which route produced each directed pair
  // Build a tripStops structure to get per-trip route info for edges
  const tripStopsMap = new Map<string, { stop_id: string; seq: number }[]>();
  for (const st of gtfs.stopTimes) {
    if (!tripStopsMap.has(st.trip_id)) tripStopsMap.set(st.trip_id, []);
    tripStopsMap.get(st.trip_id)!.push({ stop_id: st.stop_id, seq: st.stop_sequence });
  }

  for (const [tripId, stops] of tripStopsMap) {
    const rid = tripRoute.get(tripId);
    if (!rid) continue;
    stops.sort((a, b) => a.seq - b.seq);
    for (let i = 0; i < stops.length - 1; i++) {
      const fromCid = canonicalId(stops[i].stop_id, stopMap);
      const toCid = canonicalId(stops[i + 1].stop_id, stopMap);
      if (fromCid === toCid) continue;
      const key = `${fromCid}|||${toCid}`;
      directedEdges.get(key)?.routeIds.add(rid);
    }
  }

  // Merge bidirectional: if both A→B and B→A exist, merge into one
  const edges: StrategicEdge[] = [];
  const processedPairs = new Set<string>();

  for (const [key, accum] of directedEdges) {
    if (processedPairs.has(key)) continue;
    const [fromCid, toCid] = key.split('|||');
    const reverseKey = `${toCid}|||${fromCid}`;
    const reverseAccum = directedEdges.get(reverseKey);

    processedPairs.add(key);
    processedPairs.add(reverseKey);

    const allRouteIds = [...accum.routeIds];
    if (reverseAccum) {
      for (const rid of reverseAccum.routeIds) {
        if (!allRouteIds.includes(rid)) allRouteIds.push(rid);
      }
    }

    const fwdAvg = accum.totalSeconds / Math.max(1, accum.tripCount);
    const revAvg = reverseAccum
      ? reverseAccum.totalSeconds / Math.max(1, reverseAccum.tripCount)
      : fwdAvg;
    const avgSeconds = reverseAccum ? Math.round((fwdAvg + revAvg) / 2) : Math.round(fwdAvg);
    const totalTrips = accum.tripCount + (reverseAccum?.tripCount ?? 0);

    edges.push({
      from: fromCid,
      to: toCid,
      tripCount: totalTrips,
      avgSeconds,
      routeIds: allRouteIds,
      isBidirectional: !!reverseAccum,
      source: 'stop_times',
    });
  }

  // ── 4. Add transfer edges ──────────────────────────────────────────────────
  const existingEdgePairs = new Set(edges.map(e => [e.from, e.to].sort().join('|||')));

  for (const transfer of gtfs.transfers) {
    if (transfer.transfer_type === 3) continue; // impossible transfer
    const fromCid = canonicalId(transfer.from_stop_id, stopMap);
    const toCid = canonicalId(transfer.to_stop_id, stopMap);
    if (!nodes.has(fromCid) || !nodes.has(toCid)) continue;
    if (fromCid === toCid) continue;

    const pairKey = [fromCid, toCid].sort().join('|||');
    if (existingEdgePairs.has(pairKey)) continue; // already covered

    existingEdgePairs.add(pairKey);
    edges.push({
      from: fromCid,
      to: toCid,
      tripCount: 0,
      avgSeconds: transfer.min_transfer_time ?? 120,
      routeIds: [],
      isBidirectional: true,
      source: 'transfer',
    });
  }

  // ── 5. Build adjacency ─────────────────────────────────────────────────────
  const adjacency = new Map<string, StrategicEdge[]>();
  for (const node of nodes.values()) adjacency.set(node.id, []);

  for (const edge of edges) {
    adjacency.get(edge.from)?.push(edge);
    if (edge.isBidirectional) {
      // Add reverse reference
      const reverseRef: StrategicEdge = {
        ...edge,
        from: edge.to,
        to: edge.from,
      };
      adjacency.get(edge.to)?.push(reverseRef);
    } else {
      adjacency.get(edge.to)?.push(edge);
    }
  }

  // ── 6. Post-processing: degree, tripCount, role ────────────────────────────
  let maxDegree = 0;
  let maxTripCount = 0;

  for (const node of nodes.values()) {
    const neighbors = new Set<string>();
    let nodeTripCount = 0;
    for (const edge of adjacency.get(node.id) ?? []) {
      const neighbor = edge.from === node.id ? edge.to : edge.from;
      neighbors.add(neighbor);
      nodeTripCount += edge.tripCount;
    }
    node.degree = neighbors.size;
    node.tripCount = nodeTripCount;
    if (node.degree > maxDegree) maxDegree = node.degree;
  }

  for (const edge of edges) {
    if (edge.tripCount > maxTripCount) maxTripCount = edge.tripCount;
  }

  // Assign roles
  for (const node of nodes.values()) {
    if (node.degree === 0) node.role = 'isolated';
    else if (node.degree === 1) node.role = 'terminus';
    else if (node.degree >= 4) node.role = 'hub';
    else node.role = 'branch';
  }

  return {
    nodes,
    edges,
    adjacency,
    totalNodes: nodes.size,
    totalEdges: edges.length,
    maxDegree,
    maxTripCount,
  };
}
