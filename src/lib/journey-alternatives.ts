/**
 * Alternative journey finder and parallel corridor analyzer.
 *
 * Builds up to N alternative paths between two nodes in an inter-station graph
 * by exploring first-hop variations and single-edge removals from the optimal path.
 *
 * Algorithm:
 *   1. Find optimal path P* with findShortestPath
 *   2. For each direct neighbor of origin that differs from P*'s first hop:
 *      - Dijkstra from that neighbor to destination
 *      - Total = firstEdge.avgSeconds + dijkstra result
 *   3. For each edge on P*: find path that avoids that edge (via penalty)
 *   4. Filter: keep alternatives within 120% of P*.totalSeconds
 *   5. Deduplicate by route signature; keep top maxAlternatives by JES
 *
 * Corridor analysis:
 *   Finds route pairs that serve overlapping station sequences,
 *   comparing frequency and fragmentation.
 */
import type { InterStationGraph, ParsedGtfs } from './gtfs-types';
import { findShortestPath, dijkstraFrom, type PathResult } from './path-dijkstra';
import { computeJES, jesLabel, type JES } from './jes';
import type { TransferCost } from './gtfs-types';
import { MinHeap } from './min-heap';

// ─── Alternative journey ──────────────────────────────────────────────────────

export interface AlternativeJourney {
  id: number;
  path: PathResult;
  jes: JES;
  comment: string;
  isOptimal: boolean;
  timeDeltaPct: number;   // % vs optimal (0 = same, positive = slower)
  jesGain: number;        // JES - optimalJES (positive = better)
}

function pathSignature(path: PathResult): string {
  return path.segments.map(s => `${s.fromId}→${s.toId}`).join('|');
}

function autoComment(alt: PathResult, optimal: PathResult, optimalJes: JES): string {
  const timePct = (alt.totalSeconds - optimal.totalSeconds) / optimal.totalSeconds;
  const transferDiff = alt.transferCount - optimal.transferCount;

  if (transferDiff < 0) return 'Moins de correspondances — trajet plus simple';
  if (transferDiff > 0) return 'Plus de correspondances mais autre corridor possible';
  if (timePct < -0.05) return 'Légèrement plus rapide sur ce corridor';
  if (timePct > 0.10) return `+${Math.round(timePct * 100)}% plus long — alternative de secours`;
  if (alt.usedRouteIds.some(r => !optimal.usedRouteIds.includes(r))) return 'Lignes différentes, même destination';
  return 'Trajet comparable — niveau de service similaire';
}

/**
 * Build a modified adjacency that penalizes a specific edge (for detour search).
 */
function dijkstraAvoidingEdge(
  graph: InterStationGraph,
  fromId: string,
  toId: string,
  avoidFrom: string,
  avoidTo: string,
): number | null {
  const dist = new Map<string, number>([[fromId, 0]]);
  const heap = new MinHeap<string>();
  heap.push(0, fromId);

  while (heap.size > 0) {
    const { key: d, value: id } = heap.pop()!;
    if (d > (dist.get(id) ?? Infinity)) continue;
    if (id === toId) return d;
    for (const edge of graph.adjacency.get(id) ?? []) {
      // Skip the avoided edge
      if (id === avoidFrom && edge.to === avoidTo) continue;
      const nd = d + edge.avgSeconds;
      if (nd < (dist.get(edge.to) ?? Infinity)) {
        dist.set(edge.to, nd);
        heap.push(nd, edge.to);
      }
    }
  }
  return dist.get(toId) ?? null;
}

export function findAlternativeJourneys(
  graph: InterStationGraph,
  fromId: string,
  toId: string,
  routeNames: Map<string, string>,
  maxAlternatives = 4,
): AlternativeJourney[] {
  const optimal = findShortestPath(graph, fromId, toId);
  if (!optimal.found) return [];

  const optimalJes = computeJES([fromId, toId], optimal.totalSeconds, [], 0);
  const maxSeconds = optimal.totalSeconds * 1.20;
  const seen = new Set<string>([pathSignature(optimal)]);
  const candidates: PathResult[] = [];

  // 1. First-hop alternatives: try each neighbor of origin as first step
  const optimalFirstHop = optimal.segments[0]?.toId;
  for (const edge of graph.adjacency.get(fromId) ?? []) {
    if (edge.to === optimalFirstHop) continue;
    if (edge.to === toId) {
      // Direct edge to destination
      const dist = dijkstraAvoidingEdge(graph, edge.to, toId, '', '');
      if (dist !== null) {
        const totalSec = edge.avgSeconds + (dist === 0 ? 0 : dist);
        if (totalSec <= maxSeconds) {
          const altPath = findShortestPath(graph, edge.to, toId);
          if (altPath.found) {
            const combined: PathResult = {
              found: true,
              totalSeconds: edge.avgSeconds + altPath.totalSeconds,
              transferCount: altPath.transferCount + (edge.routeIds.some(r => altPath.usedRouteIds.includes(r)) ? 0 : 1),
              hops: 1 + altPath.hops,
              segments: [
                {
                  fromId, toId: edge.to,
                  fromName: graph.nodes.get(fromId)?.stopName ?? fromId,
                  toName: graph.nodes.get(edge.to)?.stopName ?? edge.to,
                  travelSeconds: edge.avgSeconds, routeIds: edge.routeIds, isTransfer: false,
                },
                ...altPath.segments,
              ],
              usedRouteIds: [...new Set([...edge.routeIds, ...altPath.usedRouteIds])],
            };
            const sig = pathSignature(combined);
            if (!seen.has(sig)) { seen.add(sig); candidates.push(combined); }
          }
        }
      }
    } else {
      const afterNeighbor = findShortestPath(graph, edge.to, toId);
      if (afterNeighbor.found) {
        const totalSec = edge.avgSeconds + afterNeighbor.totalSeconds;
        if (totalSec <= maxSeconds) {
          const combined: PathResult = {
            found: true,
            totalSeconds: totalSec,
            transferCount: afterNeighbor.transferCount,
            hops: 1 + afterNeighbor.hops,
            segments: [
              {
                fromId, toId: edge.to,
                fromName: graph.nodes.get(fromId)?.stopName ?? fromId,
                toName: graph.nodes.get(edge.to)?.stopName ?? edge.to,
                travelSeconds: edge.avgSeconds, routeIds: edge.routeIds, isTransfer: false,
              },
              ...afterNeighbor.segments,
            ],
            usedRouteIds: [...new Set([...edge.routeIds, ...afterNeighbor.usedRouteIds])],
          };
          const sig = pathSignature(combined);
          if (!seen.has(sig)) { seen.add(sig); candidates.push(combined); }
        }
      }
    }
  }

  // 2. Edge-removal alternatives: avoid each edge on optimal path
  for (const seg of optimal.segments) {
    const altSec = dijkstraAvoidingEdge(graph, fromId, toId, seg.fromId, seg.toId);
    if (altSec !== null && altSec <= maxSeconds) {
      // Re-run full path finding without that edge (approximate)
      const alt = findShortestPath(
        { ...graph, adjacency: new Map([...graph.adjacency].map(([k, edges]) =>
          [k, edges.filter(e => !(k === seg.fromId && e.to === seg.toId))])) },
        fromId, toId,
      );
      if (alt.found) {
        const sig = pathSignature(alt);
        if (!seen.has(sig)) { seen.add(sig); candidates.push(alt); }
      }
    }
  }

  // Sort by totalSeconds, score, deduplicate
  const results: AlternativeJourney[] = [
    {
      id: 0, path: optimal, jes: optimalJes,
      comment: 'Trajet optimal — temps transport GTFS minimal',
      isOptimal: true, timeDeltaPct: 0, jesGain: 0,
    },
    ...candidates
      .sort((a, b) => a.totalSeconds - b.totalSeconds)
      .slice(0, maxAlternatives)
      .map((path, i) => {
        const jes = computeJES([fromId, toId], path.totalSeconds, [], 0);
        return {
          id: i + 1,
          path,
          jes,
          comment: autoComment(path, optimal, optimalJes),
          isOptimal: false,
          timeDeltaPct: Math.round((path.totalSeconds - optimal.totalSeconds) / optimal.totalSeconds * 100),
          jesGain: Math.round(jes.normalizedScore - optimalJes.normalizedScore),
        };
      }),
  ];

  return results.slice(0, maxAlternatives + 1);
}

// ─── Parallel corridor analysis ───────────────────────────────────────────────

export interface CorridorRoute {
  routeId: string;
  routeShortName: string;
  sharedStopCount: number;
  estimatedTravelSeconds: number;
  stopsOnCorridor: string[]; // representative stop names
  jesScore: number;
}

export interface ParallelCorridor {
  corridorId: string;
  termini: [string, string];  // start/end station names
  sharedStops: string[];
  routes: CorridorRoute[];
  insight: string;
}

export function analyzeParallelCorridors(
  gtfs: ParsedGtfs,
  routeNames: Map<string, string>,
  maxCorridors = 10,
): ParallelCorridor[] {
  const stopMap = new Map(gtfs.stops.map(s => [s.stop_id, s]));
  const resolveRep = (id: string) => stopMap.get(id)?.parent_station ?? id;

  const tripRoute = new Map(gtfs.trips.map(t => [t.trip_id, t.route_id]));

  // Build route → ordered sequence of representative stops
  const routeStopSeqs = new Map<string, string[][]>(); // routeId → array of trip sequences
  const tripStops = new Map<string, { stop_id: string; seq: number }[]>();
  for (const st of gtfs.stopTimes) {
    if (!tripStops.has(st.trip_id)) tripStops.set(st.trip_id, []);
    tripStops.get(st.trip_id)!.push({ stop_id: st.stop_id, seq: st.stop_sequence });
  }

  for (const [tripId, stops] of tripStops) {
    const routeId = tripRoute.get(tripId);
    if (!routeId) continue;
    stops.sort((a, b) => a.seq - b.seq);
    const repSeq = [...new Set(stops.map(s => resolveRep(s.stop_id)))];
    if (!routeStopSeqs.has(routeId)) routeStopSeqs.set(routeId, []);
    // Only keep first occurrence (representative trip)
    if ((routeStopSeqs.get(routeId)?.length ?? 0) < 3) {
      routeStopSeqs.get(routeId)!.push(repSeq);
    }
  }

  // For each route, get its primary stop sequence (longest trip)
  const routePrimary = new Map<string, string[]>();
  for (const [routeId, seqs] of routeStopSeqs) {
    const longest = seqs.reduce((a, b) => a.length >= b.length ? a : b, []);
    if (longest.length >= 3) routePrimary.set(routeId, longest);
  }

  // Find pairs of routes that share ≥4 stops in sequence
  const corridors: ParallelCorridor[] = [];
  const routeIds = [...routePrimary.keys()];

  for (let i = 0; i < routeIds.length; i++) {
    for (let j = i + 1; j < routeIds.length; j++) {
      const seqA = routePrimary.get(routeIds[i])!;
      const seqB = routePrimary.get(routeIds[j])!;

      // Find longest common subsequence (approximate: intersection in order)
      const setB = new Set(seqB);
      const shared = seqA.filter(s => setB.has(s));
      if (shared.length < 3) continue;

      // Estimate travel time from avg stop_times (# stops × 90s as proxy if no direct data)
      const estimateSeconds = (stops: string[]) => Math.max(stops.length * 90, 180);

      const insight = (() => {
        const aDense = seqA.length > seqB.length;
        const fasterRoute = estimateSeconds(seqA) < estimateSeconds(seqB) ? routeIds[i] : routeIds[j];
        const simpler = seqA.length < seqB.length ? routeIds[i] : routeIds[j];
        if (routeIds[i] === routeIds[j]) return '';
        if (seqA.length > seqB.length * 1.4) return `${routeNames.get(routeIds[j]) ?? routeIds[j]} est plus directe sur ce corridor (moins d'arrêts)`;
        if (shared.length === seqA.length) return `${routeNames.get(routeIds[i]) ?? routeIds[i]} est entièrement contenue dans le corridor de ${routeNames.get(routeIds[j]) ?? routeIds[j]}`;
        return `Deux lignes partagent ${shared.length} arrêts — alternatives possibles sur ce corridor`;
      })();

      corridors.push({
        corridorId: `${routeIds[i]}_${routeIds[j]}`,
        termini: [
          stopMap.get(shared[0])?.stop_name ?? shared[0],
          stopMap.get(shared[shared.length - 1])?.stop_name ?? shared[shared.length - 1],
        ],
        sharedStops: shared.slice(0, 8).map(id => stopMap.get(id)?.stop_name ?? id),
        routes: [routeIds[i], routeIds[j]].map(rid => ({
          routeId: rid,
          routeShortName: routeNames.get(rid) ?? rid,
          sharedStopCount: shared.length,
          estimatedTravelSeconds: estimateSeconds(routePrimary.get(rid) ?? []),
          stopsOnCorridor: (routePrimary.get(rid) ?? [])
            .filter(s => new Set(shared).has(s))
            .slice(0, 5)
            .map(id => stopMap.get(id)?.stop_name ?? id),
          jesScore: Math.round(Math.max(0, Math.min(100, 100 - (routePrimary.get(rid)?.length ?? 10) * 1.2))),
        })),
        insight,
      });

      if (corridors.length >= maxCorridors) return corridors;
    }
  }

  return corridors.sort((a, b) => b.sharedStops.length - a.sharedStops.length);
}
