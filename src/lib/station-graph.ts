/**
 * Builds an intra-station traversal graph from GTFS pathways and transfers.
 *
 * Priority:
 *   1. pathways.txt — precise physical graph; individual stop_ids kept as-is
 *   2. transfers.txt — logical transfer fallback; nodes deduplicated by group
 *   3. Geographic proximity — last resort; nodes deduplicated by group
 *
 * Deduplication (passes 2 & 3):
 *   Multiple stop_ids under the same parent_station share the same logical
 *   location (e.g., "Jean Jaurès dir. Basso Cambo" and "Jean Jaurès dir. Balma"
 *   are the same platform from the traveler's perspective). They are collapsed
 *   into a single representative node whose lat/lon is the centroid of the group.
 *   The representative nodeId is the parent_station stop_id when it is itself
 *   present in stops.txt, otherwise the lexicographically first child stop_id.
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
  5: 0.15,
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

function isValidCoord(lat: number, lon: number): boolean {
  return isFinite(lat) && isFinite(lon) && !(lat === 0 && lon === 0);
}

/** Haversine distance in metres */
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
 * Build deduplication indices for a set of stop_ids.
 *
 * Returns:
 *   groupOf:  stopId → groupKey (= parent_station if present, else stop_id itself)
 *   groupMembers: groupKey → sorted stopId[]
 *   groupRep: groupKey → representative stopId
 *             (parent_station stop_id if it exists in stopMap, else first member)
 */
function buildGroupIndex(
  stopIds: Iterable<string>,
  stopMap: Map<string, { stop_name: string; parent_station?: string; stop_lat: number; stop_lon: number }>,
): {
  groupOf: Map<string, string>;
  groupMembers: Map<string, string[]>;
  groupRep: Map<string, string>;
} {
  const groupOf = new Map<string, string>();
  const groupMembers = new Map<string, string[]>();

  for (const sid of [...stopIds].sort()) {
    const stop = stopMap.get(sid);
    // Group key: use parent_station when available, otherwise the stop_id itself.
    // This ensures children with the same parent collapse to one node.
    const gk = stop?.parent_station ?? sid;
    groupOf.set(sid, gk);
    if (!groupMembers.has(gk)) groupMembers.set(gk, []);
    groupMembers.get(gk)!.push(sid);
  }

  // Representative = parent_station stop_id if it exists in stopMap, else first member
  const groupRep = new Map<string, string>();
  for (const [gk, members] of groupMembers) {
    groupRep.set(gk, stopMap.has(gk) ? gk : members[0]);
  }

  return { groupOf, groupMembers, groupRep };
}

/**
 * Build deduplicated nodes — one per group.
 * lat/lon = centroid of the group's valid coordinates.
 */
function buildDedupNodes(
  groupMembers: Map<string, string[]>,
  groupRep: Map<string, string>,
  stopMap: Map<string, { stop_id: string; stop_name: string; stop_lat: number; stop_lon: number; location_type?: number; parent_station?: string }>,
): Map<string, StationNode> {
  const nodes = new Map<string, StationNode>();

  for (const [gk, members] of groupMembers) {
    const repId = groupRep.get(gk)!;
    const repStop = stopMap.get(repId) ?? stopMap.get(members[0]);
    if (!repStop) continue;

    // Centroid
    let sumLat = 0, sumLon = 0, validCount = 0;
    for (const sid of members) {
      const s = stopMap.get(sid);
      if (s && isValidCoord(s.stop_lat, s.stop_lon)) {
        sumLat += s.stop_lat;
        sumLon += s.stop_lon;
        validCount++;
      }
    }
    const lat = validCount > 0 ? sumLat / validCount : repStop.stop_lat;
    const lon = validCount > 0 ? sumLon / validCount : repStop.stop_lon;

    nodes.set(repId, {
      nodeId: repId,
      stopId: repId,
      stopName: repStop.stop_name,
      nodeType: locationTypeToNodeType(repStop.location_type),
      lat,
      lon,
      group: gk,
      childCount: members.length,
      frictionScore: 0,
      accessibilityScore: 1,
    });
  }

  return nodes;
}

/**
 * Build the intra-station graph for one station hub.
 */
export function buildStationGraph(gtfs: ParsedGtfs, stationStopId: string): StationGraph | null {
  const stopMap = new Map(gtfs.stops.map(s => [s.stop_id, s]));
  const rootStop = stopMap.get(stationStopId);
  if (!rootStop) return null;

  // --- Collect all stop_ids that belong to this station ---
  const stationStopIds = new Set<string>([stationStopId]);

  // Children declared via parent_station
  for (const s of gtfs.stops) {
    if (s.parent_station === stationStopId) stationStopIds.add(s.stop_id);
  }

  // Flood-fill via pathways
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

  // --- Build group index (used by all fallback passes) ---
  const { groupOf, groupMembers, groupRep } = buildGroupIndex(stationStopIds, stopMap);

  // stopId → representative nodeId (used to remap edge endpoints in fallback)
  const stopIdToRep = new Map<string, string>();
  for (const [sid, gk] of groupOf) {
    stopIdToRep.set(sid, groupRep.get(gk) ?? sid);
  }

  // Debug log
  const uniqueGroups = groupMembers.size;
  const dupRatio = stationStopIds.size > 0
    ? (((stationStopIds.size - uniqueGroups) / stationStopIds.size) * 100).toFixed(1)
    : '0';
  console.debug(
    `[StationGraph] "${rootStop.stop_name}": ${stationStopIds.size} stop_id(s) → ` +
    `${uniqueGroups} groupe(s) logique(s) (${dupRatio}% dédupliqués)`,
  );

  // --- Pass 1: pathways.txt — individual nodes, no dedup ---
  const edges: StationEdge[] = [];
  const adjacency = new Map<string, StationEdge[]>();

  const addEdge = (e: StationEdge): void => {
    edges.push(e);
    if (!adjacency.has(e.from)) adjacency.set(e.from, []);
    adjacency.get(e.from)!.push(e);
  };

  let pathwayEdgeCount = 0;

  // Build individual nodes for pathways mode
  const physicalNodes = new Map<string, StationNode>();
  for (const sid of stationStopIds) {
    const stop = stopMap.get(sid);
    if (!stop) continue;
    physicalNodes.set(sid, {
      nodeId: sid,
      stopId: sid,
      stopName: stop.stop_name,
      nodeType: locationTypeToNodeType(stop.location_type),
      lat: stop.stop_lat,
      lon: stop.stop_lon,
      group: stop.parent_station ?? sid,
      childCount: 1,
      frictionScore: 0,
      accessibilityScore: 1,
    });
  }

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

    if (p.pathway_mode === 2 && !isElevator) {
      const fn = physicalNodes.get(p.from_stop_id);
      const tn = physicalNodes.get(p.to_stop_id);
      if (fn) fn.accessibilityScore = Math.min(fn.accessibilityScore, 0.5);
      if (tn) tn.accessibilityScore = Math.min(tn.accessibilityScore, 0.5);
    }

    const applyFriction = (id: string) => {
      const n = physicalNodes.get(id);
      if (n) n.frictionScore = Math.min(1, n.frictionScore + friction * 0.5);
    };
    applyFriction(p.from_stop_id);
    applyFriction(p.to_stop_id);

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
    pathwayEdgeCount++;
    if (p.is_bidirectional === 1) addEdge({ ...edge, from: p.to_stop_id, to: p.from_stop_id });
  }

  // If pathways found → return physical graph (no dedup)
  if (pathwayEdgeCount > 0) {
    return { stationId: stationStopId, stationName: rootStop.stop_name, nodes: physicalNodes, edges, adjacency };
  }

  // --- Fallback: build deduplicated nodes ---
  const nodes = buildDedupNodes(groupMembers, groupRep, stopMap);

  const applyFrictionDedup = (repId: string, delta: number): void => {
    const n = nodes.get(repId);
    if (n) n.frictionScore = Math.min(1, n.frictionScore + delta * 0.5);
  };

  // Pass 2: transfers.txt
  for (const t of gtfs.transfers) {
    if (t.transfer_type === 3) continue;
    const fromRep = stopIdToRep.get(t.from_stop_id);
    const toRep = stopIdToRep.get(t.to_stop_id);

    // At least one end must belong to this station
    const fromInStation = fromRep !== undefined && nodes.has(fromRep);
    const toInStation = toRep !== undefined && nodes.has(toRep);
    if (!fromInStation && !toInStation) continue;

    // Ensure nodes exist for both ends (the external end may be from another station)
    const resolvedFrom = fromRep ?? t.from_stop_id;
    const resolvedTo = toRep ?? t.to_stop_id;
    if (resolvedFrom === resolvedTo) continue; // same representative → no self-loop

    if (!nodes.has(resolvedFrom)) {
      const s = stopMap.get(t.from_stop_id);
      if (s) nodes.set(resolvedFrom, {
        nodeId: resolvedFrom, stopId: resolvedFrom, stopName: s.stop_name,
        nodeType: 'stop', lat: s.stop_lat, lon: s.stop_lon,
        group: resolvedFrom, childCount: 1, frictionScore: 0, accessibilityScore: 1,
      });
    }
    if (!nodes.has(resolvedTo)) {
      const s = stopMap.get(t.to_stop_id);
      if (s) nodes.set(resolvedTo, {
        nodeId: resolvedTo, stopId: resolvedTo, stopName: s.stop_name,
        nodeType: 'stop', lat: s.stop_lat, lon: s.stop_lon,
        group: resolvedTo, childCount: 1, frictionScore: 0, accessibilityScore: 1,
      });
    }

    const cost = t.min_transfer_time ?? 120;
    const edge: StationEdge = {
      from: resolvedFrom, to: resolvedTo,
      pathwayMode: 0, costSeconds: cost, isBidirectional: true,
      hasSlopeIssue: false, hasWidthIssue: false, isElevator: false, isEscalator: false,
    };
    addEdge(edge);
    addEdge({ ...edge, from: resolvedTo, to: resolvedFrom });
    applyFrictionDedup(resolvedFrom, 0.1);
    applyFrictionDedup(resolvedTo, 0.1);
  }

  // Pass 3: geographic proximity on representative nodes
  if (edges.length === 0 && nodes.size > 1) {
    const nodeList = [...nodes.values()].filter(n => isValidCoord(n.lat, n.lon));
    for (let i = 0; i < nodeList.length; i++) {
      for (let j = i + 1; j < nodeList.length; j++) {
        const a = nodeList[i];
        const b = nodeList[j];
        if (a.group === b.group) continue; // same logical group → no self-loop
        const metres = haversineMetres(a.lat, a.lon, b.lat, b.lon);
        if (metres > 500) continue;
        const cost = Math.round(metres / 1.2); // walking speed ~1.2 m/s
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
 * Top-N station candidates for buildStationGraph().
 * Priority: parent_station declarations → pathway connectivity → transfer hubs.
 */
export function getStationCandidates(
  gtfs: ParsedGtfs,
  topN = 20,
): { stopId: string; stopName: string; childCount: number }[] {
  const stopMap = new Map(gtfs.stops.map(s => [s.stop_id, s]));

  // Prefer explicit parent_station declarations
  const parentCount = new Map<string, number>();
  for (const s of gtfs.stops) {
    if (s.parent_station) {
      parentCount.set(s.parent_station, (parentCount.get(s.parent_station) ?? 0) + 1);
    }
  }

  if (parentCount.size > 0) {
    return [...parentCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([stopId, childCount]) => ({
        stopId,
        stopName: stopMap.get(stopId)?.stop_name ?? stopId,
        childCount,
      }));
  }

  // Fallback: pathway connectivity
  const pathwayDegree = new Map<string, number>();
  for (const p of gtfs.pathways) {
    pathwayDegree.set(p.from_stop_id, (pathwayDegree.get(p.from_stop_id) ?? 0) + 1);
    pathwayDegree.set(p.to_stop_id, (pathwayDegree.get(p.to_stop_id) ?? 0) + 1);
  }

  if (pathwayDegree.size > 0) {
    return [...pathwayDegree.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([stopId, deg]) => ({
        stopId,
        stopName: stopMap.get(stopId)?.stop_name ?? stopId,
        childCount: deg,
      }));
  }

  // Last resort: transfer hubs, deduplicated by stop_name
  const transferDegree = new Map<string, number>();
  for (const t of gtfs.transfers) {
    if (t.transfer_type === 3) continue;
    transferDegree.set(t.from_stop_id, (transferDegree.get(t.from_stop_id) ?? 0) + 1);
    transferDegree.set(t.to_stop_id, (transferDegree.get(t.to_stop_id) ?? 0) + 1);
  }

  const seen = new Set<string>();
  const result: { stopId: string; stopName: string; childCount: number }[] = [];
  for (const [stopId, deg] of [...transferDegree.entries()].sort((a, b) => b[1] - a[1])) {
    const name = stopMap.get(stopId)?.stop_name ?? stopId;
    const key = name.toLowerCase().trim();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ stopId, stopName: name, childCount: deg });
    if (result.length >= topN) break;
  }
  return result;
}
