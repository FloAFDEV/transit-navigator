/**
 * Isochrone computation from GTFS stop_times.
 * Builds a travel-time graph and runs Dijkstra from a center stop.
 */
import type { ParsedGtfs } from './gtfs-types';
import { MinHeap } from './min-heap';

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
export function buildTravelGraph(gtfs: ParsedGtfs, allowedTripIds?: Set<string>): Map<string, TravelEdge[]> {
  // Group stop_times by trip, sorted by sequence
  const tripStops = new Map<string, { stop_id: string; arrival: number | null; departure: number | null; seq: number }[]>();

  for (const st of gtfs.stopTimes) {
    if (allowedTripIds && !allowedTripIds.has(st.trip_id)) continue;
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
 * O(n log n) via min-heap — replaces the previous O(n²) array-sort version.
 * Returns travel time in seconds to all reachable stops.
 */
export function dijkstra(graph: Map<string, TravelEdge[]>, startId: string): Map<string, number> {
  const dist = new Map<string, number>();
  dist.set(startId, 0);
  const heap = new MinHeap<string>();
  heap.push(0, startId);

  while (heap.size > 0) {
    const { key: d, value: id } = heap.pop()!;
    // Stale entry: a shorter path was already settled
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

// --- In-memory caches (module-level, per browser session) ---
// Dijkstra results keyed by startId: avoids recomputing when only maxMin changes.
// Isochrone results keyed by `${startId}:${maxMin}`: avoids recomputing on revisit.
// Both caches are invalidated together when a new GTFS file is loaded.

const _dijkstraCache = new Map<string, Map<string, number>>();
const _isochroneCache = new Map<string, IsochroneNode[]>();
const CACHE_MAX = 40;

function _evict<K, V>(cache: Map<K, V>): void {
  if (cache.size >= CACHE_MAX) {
    // Remove the oldest entry (Maps preserve insertion order).
    cache.delete(cache.keys().next().value!);
  }
}

/** Clear both caches — call this when a new GTFS dataset is loaded. */
export function clearIsochroneCache(): void {
  _dijkstraCache.clear();
  _isochroneCache.clear();
}

/**
 * Compute isochrone nodes from a center station.
 * Results are cached: Dijkstra by startId, final nodes by startId+maxMin.
 */
export function computeIsochrone(
  gtfs: ParsedGtfs,
  graph: Map<string, TravelEdge[]>,
  centerStopId: string,
  maxMinutes: number = 30,
): IsochroneNode[] {
  const isoKey = `${centerStopId}:${maxMinutes}`;
  const cached = _isochroneCache.get(isoKey);
  if (cached) return cached;

  // Reuse Dijkstra result if available (e.g. user only changed maxMin).
  let distances = _dijkstraCache.get(centerStopId);
  if (!distances) {
    distances = dijkstra(graph, centerStopId);
    _evict(_dijkstraCache);
    _dijkstraCache.set(centerStopId, distances);
  }

  const stopMap = new Map(gtfs.stops.map(s => [s.stop_id, s]));
  const maxSeconds = maxMinutes * 60;

  const nodes: IsochroneNode[] = [];
  for (const [stopId, seconds] of distances) {
    if (seconds > maxSeconds || seconds === 0) continue;
    const stop = stopMap.get(stopId);
    if (!stop) continue;
    const { stop_lat: lat, stop_lon: lon } = stop;
    if (!isFinite(lat) || !isFinite(lon) || (lat === 0 && lon === 0) ||
        lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;

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

  _evict(_isochroneCache);
  _isochroneCache.set(isoKey, nodes);
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
