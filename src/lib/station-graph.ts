/**
 * Builds an intra-station traversal graph from GTFS pathways and transfers.
 *
 * Priority:
 *   1. pathways.txt — precise physical graph with real traversal times
 *   2. transfers.txt — fallback when pathways absent (logical transfer only)
 *   3. Geographic proximity — last resort when neither file exists
 */
import type {
  ParsedGtfs,
  StationGraph,
  StationNode,
  StationEdge,
  StationNodeType,
} from './gtfs-types';
import { MinHeap } from './min-heap';

// Default cost per pathway_mode when traversal_time is absent
const MODE_DEFAULT_COST: Record<number, number> = {
  1: 60,  // walkway
  2: 45,  // stairs
  3: 30,  // moving walkway
  4: 20,  // escalator
  5: 30,  // elevator (includes waiting)
  6: 15,  // fare gate
  7: 15,  // exit gate
};

// Base friction contribution per mode (0–1)
const MODE_FRICTION: Record<number, number> = {
  1: 0.05,
  2: 0.20,
  3: 0.05,
  4: 0.10,
  5: 0.15, // elevator: single-file, perceived wait
  6: 0.20,
  7: 0.15,
};

// location_type → StationNodeType
function locationTypeToNodeType(lt: number | undefined): StationNodeType {
  switch (lt) {
    case 1: return 'station';
    case 2: return 'entrance';
    case 3: return 'generic_node';
    case 4: return 'boarding_area';
    default: return 'stop';
  }
}

/** Haversine distance in metres between two lat/lon points */
function haversineMetres(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

/**
 * Build the intra-station graph for one station hub.
 *
 * @param gtfs       Parsed GTFS data (pathways + transfers must be present, may be empty arrays)
 * @param stationStopId  The stop_id of the parent station hub (location_type=1 or main platform)
 * @returns StationGraph or null if the stop_id doesn't exist
 */
export function buildStationGraph(gtfs: ParsedGtfs, stationStopId: string): StationGraph | null {
  const stopMap = new Map(gtfs.stops.map(s => [s.stop_id, s]));
  const rootStop = stopMap.get(stationStopId);
  if (!rootStop) return null;

  // --- Collect all stop_ids that belong to this station ---
  // Start from stationStopId and expand via pathways (flood-fill)
  const stationStopIds = new Set<string>([stationStopId]);

  // Also include child stops declared via parent_station
  for (const s of gtfs.stops) {
    if (s.parent_station === stationStopId) {
      stationStopIds.add(s.stop_id);
    }
  }

  // Flood-fill via pathways to capture nodes not declared with parent_station
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of gtfs.pathways) {
      const hasFrom = stationStopIds.has(p.from_stop_id);
      const hasTo = stationStopIds.has(p.to_stop_id);
      if (hasFrom && !hasTo) { stationStopIds.add(p.to_stop_id); changed = true; }
      if (hasTo && !hasFrom) { stationStopIds.add(p.from_stop_id); changed = true; }
    }
  }

  // --- Build nodes ---
  const nodes = new Map<string, StationNode>();
  for (const sid of stationStopIds) {
    const stop = stopMap.get(sid);
    if (!stop) continue;
    nodes.set(sid, {
      nodeId: sid,
      stopId: sid,
      stopName: stop.stop_name,
      nodeType: locationTypeToNodeType(stop.location_type),
      lat: stop.stop_lat,
      lon: stop.stop_lon,
      frictionScore: 0,
      accessibilityScore: 1,
    });
  }

  // --- Build edges ---
  const edges: StationEdge[] = [];
  const adjacency = new Map<string, StationEdge[]>();

  const addEdge = (e: StationEdge): void => {
    edges.push(e);
    if (!adjacency.has(e.from)) adjacency.set(e.from, []);
    adjacency.get(e.from)!.push(e);
  };

  const applyFrictionToNodes = (fromId: string, toId: string, delta: number): void => {
    const fn = nodes.get(fromId);
    if (fn) fn.frictionScore = Math.min(1, fn.frictionScore + delta * 0.5);
    const tn = nodes.get(toId);
    if (tn) tn.frictionScore = Math.min(1, tn.frictionScore + delta * 0.5);
    // Elevator/escalator reduces accessibility for PMR when absent
    // (accessibility score reduced only if slope/width issue)
  };

  // Pass 1: pathways.txt
  let pathwayEdgeCount = 0;
  for (const p of gtfs.pathways) {
    if (!stationStopIds.has(p.from_stop_id) || !stationStopIds.has(p.to_stop_id)) continue;

    const cost = p.traversal_time ?? MODE_DEFAULT_COST[p.pathway_mode] ?? 60;
    const hasSlopeIssue = (p.max_slope ?? 0) > 0.08;
    const hasWidthIssue = (p.min_width ?? 2) < 0.9;
    const isElevator = p.pathway_mode === 5;
    const isEscalator = p.pathway_mode === 4;

    let friction = MODE_FRICTION[p.pathway_mode] ?? 0.1;
    if (hasSlopeIssue) friction += 0.20;
    if (hasWidthIssue) friction += 0.30;

    // Accessibility: stairs without elevator alternative reduces score
    if (p.pathway_mode === 2 && !isElevator) {
      const fn = nodes.get(p.from_stop_id);
      const tn = nodes.get(p.to_stop_id);
      if (fn) fn.accessibilityScore = Math.min(fn.accessibilityScore, 0.5);
      if (tn) tn.accessibilityScore = Math.min(tn.accessibilityScore, 0.5);
    }

    const edge: StationEdge = {
      from: p.from_stop_id,
      to: p.to_stop_id,
      pathwayMode: p.pathway_mode,
      costSeconds: cost,
      isBidirectional: p.is_bidirectional === 1,
      hasSlopeIssue,
      hasWidthIssue,
      isElevator,
      isEscalator,
    };

    addEdge(edge);
    applyFrictionToNodes(p.from_stop_id, p.to_stop_id, friction);
    pathwayEdgeCount++;

    if (p.is_bidirectional === 1) {
      addEdge({ ...edge, from: p.to_stop_id, to: p.from_stop_id });
    }
  }

  // Pass 2: transfers.txt fallback (only when no pathways found for this station)
  if (pathwayEdgeCount === 0) {
    for (const t of gtfs.transfers) {
      if (t.transfer_type === 3) continue; // impossible transfer
      if (!stationStopIds.has(t.from_stop_id) && !stationStopIds.has(t.to_stop_id)) continue;

      // Ensure both ends exist in nodes (the other stop may be in a different station)
      if (!nodes.has(t.from_stop_id)) {
        const s = stopMap.get(t.from_stop_id);
        if (s) {
          nodes.set(t.from_stop_id, {
            nodeId: t.from_stop_id, stopId: t.from_stop_id, stopName: s.stop_name,
            nodeType: 'stop', lat: s.stop_lat, lon: s.stop_lon,
            frictionScore: 0, accessibilityScore: 1,
          });
        }
      }
      if (!nodes.has(t.to_stop_id)) {
        const s = stopMap.get(t.to_stop_id);
        if (s) {
          nodes.set(t.to_stop_id, {
            nodeId: t.to_stop_id, stopId: t.to_stop_id, stopName: s.stop_name,
            nodeType: 'stop', lat: s.stop_lat, lon: s.stop_lon,
            frictionScore: 0, accessibilityScore: 1,
          });
        }
      }

      const cost = t.min_transfer_time ?? 120;
      const edge: StationEdge = {
        from: t.from_stop_id,
        to: t.to_stop_id,
        pathwayMode: 0, // logical transfer, no physical mode
        costSeconds: cost,
        isBidirectional: true,
        hasSlopeIssue: false,
        hasWidthIssue: false,
        isElevator: false,
        isEscalator: false,
      };
      addEdge(edge);
      addEdge({ ...edge, from: t.to_stop_id, to: t.from_stop_id });
      applyFrictionToNodes(t.from_stop_id, t.to_stop_id, 0.1);
    }
  }

  // Pass 3: geographic proximity fallback (no pathways, no transfers for this station)
  if (edges.length === 0 && stationStopIds.size > 1) {
    const nodeList = [...nodes.values()].filter(
      n => isFinite(n.lat) && isFinite(n.lon) && !(n.lat === 0 && n.lon === 0)
    );
    for (let i = 0; i < nodeList.length; i++) {
      for (let j = i + 1; j < nodeList.length; j++) {
        const a = nodeList[i];
        const b = nodeList[j];
        const metres = haversineMetres(a.lat, a.lon, b.lat, b.lon);
        if (metres > 500) continue; // too far — different stations
        // Walking speed ~1.2 m/s
        const cost = Math.round(metres / 1.2);
        const edge: StationEdge = {
          from: a.nodeId, to: b.nodeId,
          pathwayMode: 1, costSeconds: cost, isBidirectional: true,
          hasSlopeIssue: false, hasWidthIssue: false, isElevator: false, isEscalator: false,
        };
        addEdge(edge);
        addEdge({ ...edge, from: b.nodeId, to: a.nodeId });
      }
    }
  }

  return { stationId: stationStopId, stationName: rootStop.stop_name, nodes, edges, adjacency };
}

/**
 * Dijkstra over a StationGraph.
 * Returns shortest path cost in seconds from startId to all reachable nodes.
 */
export function dijkstraStation(graph: StationGraph, startId: string): Map<string, number> {
  const dist = new Map<string, number>([[startId, 0]]);
  const heap = new MinHeap<string>();
  heap.push(0, startId);

  while (heap.size > 0) {
    const { key: d, value: id } = heap.pop()!;
    if (d > (dist.get(id) ?? Infinity)) continue;
    for (const edge of graph.adjacency.get(id) ?? []) {
      const nd = d + edge.costSeconds;
      if (nd < (dist.get(edge.to) ?? Infinity)) {
        dist.set(edge.to, nd);
        heap.push(nd, edge.to);
      }
    }
  }

  return dist;
}

/**
 * Returns the stop_ids of the top-N most connected stations in the network
 * suitable as candidates for buildStationGraph().
 */
export function getStationCandidates(
  gtfs: ParsedGtfs,
  topN = 20,
): { stopId: string; stopName: string; childCount: number }[] {
  // Prefer explicit parent_station declarations
  const parentCount = new Map<string, number>();
  for (const s of gtfs.stops) {
    if (s.parent_station) {
      parentCount.set(s.parent_station, (parentCount.get(s.parent_station) ?? 0) + 1);
    }
  }

  if (parentCount.size > 0) {
    const stopMap = new Map(gtfs.stops.map(s => [s.stop_id, s]));
    return [...parentCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([stopId, childCount]) => ({
        stopId,
        stopName: stopMap.get(stopId)?.stop_name ?? stopId,
        childCount,
      }));
  }

  // Fallback: use pathway connectivity as proxy
  const pathwayDegree = new Map<string, number>();
  for (const p of gtfs.pathways) {
    pathwayDegree.set(p.from_stop_id, (pathwayDegree.get(p.from_stop_id) ?? 0) + 1);
    pathwayDegree.set(p.to_stop_id, (pathwayDegree.get(p.to_stop_id) ?? 0) + 1);
  }

  if (pathwayDegree.size > 0) {
    const stopMap = new Map(gtfs.stops.map(s => [s.stop_id, s]));
    return [...pathwayDegree.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([stopId, deg]) => ({
        stopId,
        stopName: stopMap.get(stopId)?.stop_name ?? stopId,
        childCount: deg,
      }));
  }

  // Last resort: transfer hubs
  const transferDegree = new Map<string, number>();
  for (const t of gtfs.transfers) {
    if (t.transfer_type === 3) continue;
    transferDegree.set(t.from_stop_id, (transferDegree.get(t.from_stop_id) ?? 0) + 1);
    transferDegree.set(t.to_stop_id, (transferDegree.get(t.to_stop_id) ?? 0) + 1);
  }

  const stopMap = new Map(gtfs.stops.map(s => [s.stop_id, s]));
  return [...transferDegree.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([stopId, deg]) => ({
      stopId,
      stopName: stopMap.get(stopId)?.stop_name ?? stopId,
      childCount: deg,
    }));
}
