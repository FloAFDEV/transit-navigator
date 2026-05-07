/**
 * Path Dijkstra for inter-station graph.
 *
 * Finds the shortest path between two representative nodes in an InterStationGraph,
 * reconstructs the sequence of edges, and groups consecutive same-route segments
 * to count transfers and list lines used.
 *
 * Transfer detection:
 *   - Explicit transfer edge (source === 'transfer') → always a transfer
 *   - Consecutive stop_times edges whose routeIds have no overlap → line change = transfer
 *   - If routeIds is empty on either edge, the hop is treated as same-line (unknown)
 */
import type { InterStationGraph, InterStationEdge } from './gtfs-types';
import { MinHeap } from './min-heap';

export interface PathSegment {
  fromId: string;
  toId: string;
  fromName: string;
  toName: string;
  travelSeconds: number;
  routeIds: string[];
  isTransfer: boolean;
}

export interface PathResult {
  found: boolean;
  totalSeconds: number;
  transferCount: number;
  hops: number;
  segments: PathSegment[];
  usedRouteIds: string[];
}

export function findShortestPath(
  graph: InterStationGraph,
  fromId: string,
  toId: string,
): PathResult {
  const NOT_FOUND: PathResult = { found: false, totalSeconds: 0, transferCount: 0, hops: 0, segments: [], usedRouteIds: [] };

  if (fromId === toId || !graph.nodes.has(fromId) || !graph.nodes.has(toId)) return NOT_FOUND;

  const dist = new Map<string, number>([[fromId, 0]]);
  const prev = new Map<string, { nodeId: string; edge: InterStationEdge }>();
  const heap = new MinHeap<string>();
  heap.push(0, fromId);

  while (heap.size > 0) {
    const { key: d, value: id } = heap.pop()!;
    if (d > (dist.get(id) ?? Infinity)) continue;
    if (id === toId) break;
    for (const edge of graph.adjacency.get(id) ?? []) {
      const nd = d + edge.avgSeconds;
      if (nd < (dist.get(edge.to) ?? Infinity)) {
        dist.set(edge.to, nd);
        prev.set(edge.to, { nodeId: id, edge });
        heap.push(nd, edge.to);
      }
    }
  }

  if (!dist.has(toId)) return NOT_FOUND;

  // Reconstruct path (reverse order)
  const edgePath: InterStationEdge[] = [];
  const nodePath: string[] = [toId];
  let curr = toId;
  while (prev.has(curr)) {
    const { nodeId, edge } = prev.get(curr)!;
    edgePath.unshift(edge);
    nodePath.unshift(nodeId);
    curr = nodeId;
  }

  // Build segments
  const segments: PathSegment[] = [];
  const usedRouteSet = new Set<string>();

  for (let i = 0; i < edgePath.length; i++) {
    const edge = edgePath[i];
    const fromNode = graph.nodes.get(nodePath[i]);
    const toNode = graph.nodes.get(nodePath[i + 1]);

    const isTransfer = edge.source === 'transfer' || (
      i > 0 &&
      edge.source === 'stop_times' &&
      edgePath[i - 1].source === 'stop_times' &&
      edge.routeIds.length > 0 &&
      edgePath[i - 1].routeIds.length > 0 &&
      !edge.routeIds.some(r => edgePath[i - 1].routeIds.includes(r))
    );

    for (const r of edge.routeIds) usedRouteSet.add(r);

    segments.push({
      fromId: nodePath[i],
      toId: nodePath[i + 1],
      fromName: fromNode?.stopName ?? nodePath[i],
      toName: toNode?.stopName ?? nodePath[i + 1],
      travelSeconds: edge.avgSeconds,
      routeIds: edge.routeIds,
      isTransfer,
    });
  }

  const transferCount = segments.filter(s => s.isTransfer).length;

  return {
    found: true,
    totalSeconds: dist.get(toId)!,
    transferCount,
    hops: edgePath.length,
    segments,
    usedRouteIds: [...usedRouteSet],
  };
}

/**
 * Run Dijkstra from a source node and return all distances.
 * Used to re-color the graph when a user selects an origin.
 */
export function dijkstraFrom(graph: InterStationGraph, sourceId: string): Map<string, number> {
  const dist = new Map<string, number>([[sourceId, 0]]);
  const heap = new MinHeap<string>();
  heap.push(0, sourceId);
  while (heap.size > 0) {
    const { key: d, value: id } = heap.pop()!;
    if (d > (dist.get(id) ?? Infinity)) continue;
    for (const edge of graph.adjacency.get(id) ?? []) {
      const nd = d + edge.avgSeconds;
      if (nd < (dist.get(edge.to) ?? Infinity)) {
        dist.set(edge.to, nd);
        heap.push(nd, edge.to);
      }
    }
  }
  return dist;
}
