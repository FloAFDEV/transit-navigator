/**
 * Isochrone computation from GTFS stop_times.
 * Builds a travel-time graph and runs Dijkstra from a center stop.
 */
import type { ParsedGtfs } from './gtfs-types';

/** Parse HH:MM:SS (GTFS allows >24h) into seconds */
function timeToSeconds(t: string | undefined): number | null {
  if (!t) return null;
  const parts = t.split(':').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return null;
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

export interface TravelEdge {
  from: string;
  to: string;
  seconds: number; // average travel time
}

export interface IsochroneNode {
  stopId: string;
  stopName: string;
  lat: number;
  lon: number;
  travelTime: number; // seconds from center
  band: number; // isochrone band in minutes (5, 10, 15…)
}

/**
 * Build a weighted graph of average travel times between consecutive stops.
 * Groups by (from, to) and averages.
 */
export function buildTravelGraph(gtfs: ParsedGtfs): Map<string, TravelEdge[]> {
  // Group stop_times by trip, sorted by sequence
  const tripStops = new Map<string, { stop_id: string; arrival: number | null; departure: number | null; seq: number }[]>();

  for (const st of gtfs.stopTimes) {
    if (!tripStops.has(st.trip_id)) tripStops.set(st.trip_id, []);
    tripStops.get(st.trip_id)!.push({
      stop_id: st.stop_id,
      arrival: timeToSeconds(st.arrival_time),
      departure: timeToSeconds(st.departure_time),
      seq: st.stop_sequence,
    });
  }

  // Compute edge travel times
  const edgeSums = new Map<string, { total: number; count: number }>();

  for (const [, stops] of tripStops) {
    stops.sort((a, b) => a.seq - b.seq);
    for (let i = 0; i < stops.length - 1; i++) {
      const dep = stops[i].departure ?? stops[i].arrival;
      const arr = stops[i + 1].arrival ?? stops[i + 1].departure;
      if (dep == null || arr == null) continue;
      let diff = arr - dep;
      if (diff < 0) diff += 86400; // handle day wrap
      if (diff > 7200) continue; // skip unreasonable >2h
      if (diff === 0) diff = 60; // minimum 1 min

      const key = `${stops[i].stop_id}|||${stops[i + 1].stop_id}`;
      const existing = edgeSums.get(key);
      if (existing) {
        existing.total += diff;
        existing.count++;
      } else {
        edgeSums.set(key, { total: diff, count: 1 });
      }
    }
  }

  // Build adjacency list (bidirectional)
  const graph = new Map<string, TravelEdge[]>();
  const addEdge = (from: string, to: string, seconds: number) => {
    if (!graph.has(from)) graph.set(from, []);
    graph.get(from)!.push({ from, to, seconds });
  };

  for (const [key, { total, count }] of edgeSums) {
    const [from, to] = key.split('|||');
    const avg = Math.round(total / count);
    addEdge(from, to, avg);
    addEdge(to, from, avg); // bidirectional
  }

  return graph;
}

/**
 * Dijkstra shortest path from a center stop.
 * Returns travel time in seconds to all reachable stops.
 */
export function dijkstra(graph: Map<string, TravelEdge[]>, startId: string): Map<string, number> {
  const dist = new Map<string, number>();
  dist.set(startId, 0);

  // Simple priority queue (array-based, fine for transit networks)
  const queue: { id: string; d: number }[] = [{ id: startId, d: 0 }];
  const visited = new Set<string>();

  while (queue.length > 0) {
    queue.sort((a, b) => a.d - b.d);
    const { id, d } = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);

    const edges = graph.get(id);
    if (!edges) continue;

    for (const edge of edges) {
      const newDist = d + edge.seconds;
      const current = dist.get(edge.to);
      if (current === undefined || newDist < current) {
        dist.set(edge.to, newDist);
        queue.push({ id: edge.to, d: newDist });
      }
    }
  }

  return dist;
}

/**
 * Compute isochrone nodes from a center station.
 */
export function computeIsochrone(
  gtfs: ParsedGtfs,
  graph: Map<string, TravelEdge[]>,
  centerStopId: string,
  maxMinutes: number = 30,
): IsochroneNode[] {
  const distances = dijkstra(graph, centerStopId);
  const stopMap = new Map(gtfs.stops.map(s => [s.stop_id, s]));
  const maxSeconds = maxMinutes * 60;

  const nodes: IsochroneNode[] = [];
  for (const [stopId, seconds] of distances) {
    if (seconds > maxSeconds || seconds === 0) continue;
    const stop = stopMap.get(stopId);
    if (!stop || (stop.stop_lat === 0 && stop.stop_lon === 0)) continue;

    const minutes = seconds / 60;
    const band = Math.ceil(minutes / 5) * 5; // 5-minute bands

    nodes.push({
      stopId,
      stopName: stop.stop_name,
      lat: stop.stop_lat,
      lon: stop.stop_lon,
      travelTime: seconds,
      band,
    });
  }

  nodes.sort((a, b) => a.travelTime - b.travelTime);
  return nodes;
}

/**
 * Get candidate center stations (most connected stops, hubs).
 */
export function getCenterCandidates(gtfs: ParsedGtfs, graph: Map<string, TravelEdge[]>, topN: number = 20): { stopId: string; stopName: string; edgeCount: number }[] {
  const stopMap = new Map(gtfs.stops.map(s => [s.stop_id, s]));
  const candidates: { stopId: string; stopName: string; edgeCount: number }[] = [];

  for (const [stopId, edges] of graph) {
    const stop = stopMap.get(stopId);
    if (!stop) continue;
    candidates.push({ stopId, stopName: stop.stop_name, edgeCount: edges.length });
  }

  candidates.sort((a, b) => b.edgeCount - a.edgeCount);

  // Deduplicate by name (keep most connected)
  const seen = new Set<string>();
  const unique: typeof candidates = [];
  for (const c of candidates) {
    const key = c.stopName.toLowerCase().trim();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(c);
    if (unique.length >= topN) break;
  }

  return unique;
}
