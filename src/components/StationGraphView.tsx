/**
 * StationGraphView — inter-station network connectivity graph.
 *
 * Two modes:
 *   Strategic mode (default): full network as 1 node = 1 logical station.
 *     Shows the complete GTFS network in one view with role-based coloring.
 *   Raw mode (debug toggle): neighborhood subgraph around a selected stop.
 *     Keeps the original behavior for raw GTFS stop_id-level exploration.
 *
 * 3-click interaction (both modes):
 *   Click 1 → select origin (blue)
 *   Click 2 → select destination (green) → shows path
 *   Click 3 (or click origin) → reset
 */
import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import * as d3 from 'd3';
import type { ParsedGtfs, InterStationGraph, InterStationNode, InterStationEdge } from '@/lib/gtfs-types';
import { buildInterStationGraph } from '@/lib/inter-station-graph';
import { getStationCandidates } from '@/lib/station-graph';
import {
  analyzeNetworkConnectivity,
  analyzeStrategicConnectivity,
  componentColor,
  CAUSE_LABELS,
  STRATEGIC_CAUSE_LABELS,
} from '@/lib/network-connectivity';
import { findShortestPath, dijkstraFrom, type PathResult } from '@/lib/path-dijkstra';
import { computeJES, jesLabel } from '@/lib/jes';
import { modeColors, modeLabels } from '@/lib/gtfs-types';
import { findAlternativeJourneys, type AlternativeJourney } from '@/lib/journey-alternatives';
import { buildStrategicGraph, type StrategicNode, type StrategicEdge } from '@/lib/strategic-graph';
import { MinHeap } from '@/lib/min-heap';

// ─── Color helpers ────────────────────────────────────────────────────────────

function travelTimeColor(seconds: number, maxSeconds: number): string {
  const t = Math.min(1, seconds / Math.max(1, maxSeconds));
  if (t < 0.5) {
    const h = 142 - (142 - 38) * (t / 0.5);
    return `hsl(${h.toFixed(0)}, 71%, ${(45 + 5 * (t / 0.5)).toFixed(0)}%)`;
  }
  const h = 38 - 38 * ((t - 0.5) / 0.5);
  return `hsl(${h.toFixed(0)}, 80%, 50%)`;
}

function roleColor(role: StrategicNode['role']): string {
  switch (role) {
    case 'hub':      return 'hsl(215, 70%, 55%)';
    case 'terminus': return 'hsl(142, 60%, 45%)';
    case 'branch':   return 'hsl(215, 40%, 60%)';
    case 'isolated': return 'hsl(0, 65%, 55%)';
  }
}

function roleLabel(role: StrategicNode['role']): string {
  switch (role) {
    case 'hub':      return 'Hub';
    case 'terminus': return 'Terminus';
    case 'branch':   return 'Branche';
    case 'isolated': return 'Isolée';
  }
}

// ─── Strategic Dijkstra ───────────────────────────────────────────────────────

interface StrategicPathResult {
  found: boolean;
  totalSeconds: number;
  transferCount: number;
  hops: number;
  segments: Array<{
    fromId: string; toId: string;
    fromName: string; toName: string;
    travelSeconds: number;
    routeIds: string[];
    isTransfer: boolean;
  }>;
  usedRouteIds: string[];
}

function findStrategicPath(
  nodes: Map<string, StrategicNode>,
  adjacency: Map<string, StrategicEdge[]>,
  fromId: string,
  toId: string,
): StrategicPathResult {
  const NOT_FOUND: StrategicPathResult = {
    found: false, totalSeconds: 0, transferCount: 0, hops: 0, segments: [], usedRouteIds: [],
  };
  if (fromId === toId || !nodes.has(fromId) || !nodes.has(toId)) return NOT_FOUND;

  const dist = new Map<string, number>([[fromId, 0]]);
  const prev = new Map<string, { nodeId: string; edge: StrategicEdge }>();
  const heap = new MinHeap<string>();
  heap.push(0, fromId);

  while (heap.size > 0) {
    const { key: d, value: id } = heap.pop()!;
    if (d > (dist.get(id) ?? Infinity)) continue;
    if (id === toId) break;
    for (const edge of adjacency.get(id) ?? []) {
      const neighbor = edge.from === id ? edge.to : edge.from;
      const nd = d + edge.avgSeconds;
      if (nd < (dist.get(neighbor) ?? Infinity)) {
        dist.set(neighbor, nd);
        prev.set(neighbor, { nodeId: id, edge });
        heap.push(nd, neighbor);
      }
    }
  }

  if (!dist.has(toId)) return NOT_FOUND;

  const edgePath: StrategicEdge[] = [];
  const nodePath: string[] = [toId];
  let curr = toId;
  while (prev.has(curr)) {
    const { nodeId, edge } = prev.get(curr)!;
    edgePath.unshift(edge);
    nodePath.unshift(nodeId);
    curr = nodeId;
  }

  const segments: StrategicPathResult['segments'] = [];
  const usedRouteSet = new Set<string>();

  for (let i = 0; i < edgePath.length; i++) {
    const edge = edgePath[i];
    const fromNode = nodes.get(nodePath[i]);
    const toNode = nodes.get(nodePath[i + 1]);

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
      fromName: fromNode?.name ?? nodePath[i],
      toName: toNode?.name ?? nodePath[i + 1],
      travelSeconds: edge.avgSeconds,
      routeIds: edge.routeIds,
      isTransfer,
    });
  }

  return {
    found: true,
    totalSeconds: dist.get(toId)!,
    transferCount: segments.filter(s => s.isTransfer).length,
    hops: edgePath.length,
    segments,
    usedRouteIds: [...usedRouteSet],
  };
}

function dijkstraFromStrategic(
  adjacency: Map<string, StrategicEdge[]>,
  sourceId: string,
): Map<string, number> {
  const dist = new Map<string, number>([[sourceId, 0]]);
  const heap = new MinHeap<string>();
  heap.push(0, sourceId);
  while (heap.size > 0) {
    const { key: d, value: id } = heap.pop()!;
    if (d > (dist.get(id) ?? Infinity)) continue;
    for (const edge of adjacency.get(id) ?? []) {
      const neighbor = edge.from === id ? edge.to : edge.from;
      const nd = d + edge.avgSeconds;
      if (nd < (dist.get(neighbor) ?? Infinity)) {
        dist.set(neighbor, nd);
        heap.push(nd, neighbor);
      }
    }
  }
  return dist;
}

// ─── Raw mode types ───────────────────────────────────────────────────────────

interface RawSimNode extends d3.SimulationNodeDatum {
  id: string;
  node: InterStationNode;
}

interface RawSimLink extends d3.SimulationLinkDatum<RawSimNode> {
  edge: InterStationEdge;
}

// ─── Strategic mode types ─────────────────────────────────────────────────────

interface StrSimNode extends d3.SimulationNodeDatum {
  id: string;
  node: StrategicNode;
}

interface StrSimLink extends d3.SimulationLinkDatum<StrSimNode> {
  edge: StrategicEdge;
}

type SelectionState = 'idle' | 'origin-selected' | 'path-shown';

interface Props {
  gtfs: ParsedGtfs;
}

// ─── Component ───────────────────────────────────────────────────────────────

const StationGraphView: React.FC<Props> = ({ gtfs }) => {
  const rawSvgRef = useRef<SVGSVGElement>(null);
  const strSvgRef = useRef<SVGSVGElement>(null);
  const rawSimRef = useRef<d3.Simulation<RawSimNode, RawSimLink> | null>(null);
  const strSimRef = useRef<d3.Simulation<StrSimNode, StrSimLink> | null>(null);

  // Mode toggle
  const [rawMode, setRawMode] = useState(false);

  // Raw mode state
  const [selectedStationId, setSelectedStationId] = useState<string>('');
  const [maxMinutes, setMaxMinutes] = useState(15);
  const [interGraph, setInterGraph] = useState<InterStationGraph | null>(null);

  // Shared selection state
  const [selState, setSelState] = useState<SelectionState>('idle');
  const [originId, setOriginId] = useState<string | null>(null);
  const [destId, setDestId] = useState<string | null>(null);
  const [showDiagnostic, setShowDiagnostic] = useState(false);
  const [showAlternatives, setShowAlternatives] = useState(false);

  const candidates = useMemo(() => getStationCandidates(gtfs, 30), [gtfs]);
  const routeNames = useMemo(
    () => new Map(gtfs.routes.map(r => [r.route_id, r.route_short_name || r.route_long_name])),
    [gtfs],
  );

  // Strategic graph — computed once per GTFS load
  const strategicGraph = useMemo(() => buildStrategicGraph(gtfs), [gtfs]);

  // Strategic connectivity — computed once
  const strategicConnectivity = useMemo(
    () => analyzeStrategicConnectivity(strategicGraph, gtfs),
    [strategicGraph, gtfs],
  );

  // Raw-mode connectivity — computed once
  const rawConnectivity = useMemo(() => analyzeNetworkConnectivity(gtfs), [gtfs]);

  // Raw mode station selector init
  useEffect(() => {
    if (candidates.length > 0 && !selectedStationId) setSelectedStationId(candidates[0].stopId);
  }, [candidates, selectedStationId]);

  useEffect(() => {
    if (!selectedStationId || !rawMode) return;
    setSelState('idle');
    setOriginId(null);
    setDestId(null);
    setInterGraph(buildInterStationGraph(gtfs, selectedStationId, maxMinutes));
  }, [selectedStationId, maxMinutes, gtfs, rawMode]);

  // Reset selection when switching modes
  useEffect(() => {
    setSelState('idle');
    setOriginId(null);
    setDestId(null);
  }, [rawMode]);

  // ─── Raw mode pathfinding ───────────────────────────────────────────────────

  const rawOriginDist = useMemo(() => {
    if (!interGraph || !originId || !rawMode) return null;
    return dijkstraFrom(interGraph, originId);
  }, [interGraph, originId, rawMode]);

  const rawPathResult = useMemo((): PathResult | null => {
    if (!interGraph || !originId || !destId || !rawMode) return null;
    return findShortestPath(interGraph, originId, destId);
  }, [interGraph, originId, destId, rawMode]);

  const rawAlternatives = useMemo((): AlternativeJourney[] => {
    if (!interGraph || !originId || !destId || selState !== 'path-shown' || !rawMode) return [];
    return findAlternativeJourneys(interGraph, originId, destId, routeNames, 3);
  }, [interGraph, originId, destId, selState, routeNames, rawMode]);

  const rawJesResult = useMemo(() => {
    if (!rawPathResult?.found) return null;
    return computeJES([originId!, destId!], rawPathResult.totalSeconds, [], 0);
  }, [rawPathResult, originId, destId]);

  const rawPathNodeSet = useMemo(() => {
    if (!rawPathResult?.found) return new Set<string>();
    const s = new Set<string>();
    s.add(originId!); s.add(destId!);
    for (const seg of rawPathResult.segments) { s.add(seg.fromId); s.add(seg.toId); }
    return s;
  }, [rawPathResult, originId, destId]);

  const rawPathEdgeSet = useMemo(() => {
    if (!rawPathResult?.found) return new Set<string>();
    return new Set(rawPathResult.segments.map(s => `${s.fromId}|||${s.toId}`));
  }, [rawPathResult]);

  // ─── Strategic mode pathfinding ─────────────────────────────────────────────

  const strOriginDist = useMemo(() => {
    if (!originId || rawMode) return null;
    return dijkstraFromStrategic(strategicGraph.adjacency, originId);
  }, [strategicGraph, originId, rawMode]);

  const strPathResult = useMemo((): StrategicPathResult | null => {
    if (!originId || !destId || rawMode) return null;
    return findStrategicPath(strategicGraph.nodes, strategicGraph.adjacency, originId, destId);
  }, [strategicGraph, originId, destId, rawMode]);

  const strJesResult = useMemo(() => {
    if (!strPathResult?.found) return null;
    return computeJES([originId!, destId!], strPathResult.totalSeconds, [], 0);
  }, [strPathResult, originId, destId]);

  const strPathNodeSet = useMemo(() => {
    if (!strPathResult?.found) return new Set<string>();
    const s = new Set<string>();
    s.add(originId!); s.add(destId!);
    for (const seg of strPathResult.segments) { s.add(seg.fromId); s.add(seg.toId); }
    return s;
  }, [strPathResult, originId, destId]);

  const strPathEdgeSet = useMemo(() => {
    if (!strPathResult?.found) return new Set<string>();
    return new Set(strPathResult.segments.map(s => `${s.fromId}|||${s.toId}`));
  }, [strPathResult]);

  // Max travel seconds for strategic coloring from origin
  const strMaxOriginDist = useMemo(() => {
    if (!strOriginDist) return 1;
    let m = 1;
    for (const v of strOriginDist.values()) if (v > m) m = v;
    return m;
  }, [strOriginDist]);

  // ─── Click handler ──────────────────────────────────────────────────────────
  const handleNodeClick = useCallback((nodeId: string) => {
    setSelState(prev => {
      if (prev === 'idle') {
        setOriginId(nodeId);
        setDestId(null);
        return 'origin-selected';
      }
      if (prev === 'origin-selected') {
        if (nodeId === originId) {
          setOriginId(null);
          return 'idle';
        }
        setDestId(nodeId);
        return 'path-shown';
      }
      setOriginId(null);
      setDestId(null);
      return 'idle';
    });
  }, [originId]);

  // ─── Strategic D3 graph ─────────────────────────────────────────────────────
  useEffect(() => {
    if (rawMode || !strSvgRef.current) return;
    const svg = d3.select(strSvgRef.current);
    svg.selectAll('*').remove();
    if (strategicGraph.nodes.size === 0) return;

    const width = strSvgRef.current.clientWidth || 800;
    const height = strSvgRef.current.clientHeight || 520;
    const container = svg.append('g').attr('class', 'zoom-container');
    svg.call(
      d3.zoom<SVGSVGElement, unknown>()
        .scaleExtent([0.05, 10])
        .on('zoom', ev => container.attr('transform', ev.transform.toString()))
    );

    // Build sim nodes
    const simNodes: StrSimNode[] = [...strategicGraph.nodes.values()].map(node => ({
      id: node.id,
      node,
      x: width / 2 + (Math.random() - 0.5) * width * 0.8,
      y: height / 2 + (Math.random() - 0.5) * height * 0.8,
    }));

    // Build sim links — one per edge (undirected display)
    const seenEdgeKeys = new Set<string>();
    const simLinks: StrSimLink[] = [];
    for (const edge of strategicGraph.edges) {
      const key = [edge.from, edge.to].sort().join('|||');
      if (seenEdgeKeys.has(key)) continue;
      seenEdgeKeys.add(key);
      simLinks.push({ source: edge.from, target: edge.to, edge });
    }

    strSimRef.current = d3.forceSimulation<StrSimNode, StrSimLink>(simNodes)
      .force('link', d3.forceLink<StrSimNode, StrSimLink>(simLinks)
        .id(d => d.id)
        .distance(d => Math.max(40, 120 - d.edge.tripCount * 0.5))
        .strength(0.4))
      .force('charge', d3.forceManyBody().strength(-300))
      .force('center', d3.forceCenter(width / 2, height / 2).strength(0.05))
      .force('collision', d3.forceCollide(20));

    // Edges
    const linkEl = container.append('g').attr('class', 'links')
      .selectAll<SVGLineElement, StrSimLink>('line')
      .data(simLinks)
      .join('line')
      .attr('stroke', d => {
        const key = `${d.edge.from}|||${d.edge.to}`;
        const keyR = `${d.edge.to}|||${d.edge.from}`;
        if (strPathEdgeSet.has(key) || strPathEdgeSet.has(keyR)) return 'hsl(234, 90%, 65%)';
        return d.edge.source === 'transfer' ? 'hsl(280, 60%, 55%)' : 'hsl(215, 16%, 55%)';
      })
      .attr('stroke-width', d => {
        const key = `${d.edge.from}|||${d.edge.to}`;
        const keyR = `${d.edge.to}|||${d.edge.from}`;
        if (strPathEdgeSet.has(key) || strPathEdgeSet.has(keyR)) return 3;
        return Math.max(0.8, Math.min(5, 0.8 + Math.log1p(d.edge.tripCount) * 0.6));
      })
      .attr('stroke-opacity', d => {
        const key = `${d.edge.from}|||${d.edge.to}`;
        const keyR = `${d.edge.to}|||${d.edge.from}`;
        if (strPathEdgeSet.has(key) || strPathEdgeSet.has(keyR)) return 0.9;
        if (selState === 'path-shown') return 0.1;
        return d.edge.source === 'transfer' ? 0.5 : 0.35;
      })
      .attr('stroke-dasharray', d => d.edge.source === 'transfer' ? '4 2' : '');

    // Nodes
    const nodeRadius = (d: StrSimNode) => Math.max(5, Math.min(18, 4 + Math.sqrt(d.node.degree) * 2.5));

    const nodeEl = container.append('g').attr('class', 'nodes')
      .selectAll<SVGGElement, StrSimNode>('g')
      .data(simNodes)
      .join('g')
      .attr('cursor', 'pointer')
      .call(
        d3.drag<SVGGElement, StrSimNode>()
          .on('start', (event, d) => {
            if (!event.active) strSimRef.current?.alphaTarget(0.3).restart();
            d.fx = d.x; d.fy = d.y;
          })
          .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
          .on('end', (event, d) => {
            if (!event.active) strSimRef.current?.alphaTarget(0);
            d.fx = null; d.fy = null;
          })
      );

    // Hub outer ring
    nodeEl.filter(d => d.node.role === 'hub')
      .append('circle')
      .attr('r', d => nodeRadius(d) + 5)
      .attr('fill', 'none')
      .attr('stroke', d => {
        const cid = d.node.componentId;
        return cid > 0 ? componentColor(cid) : roleColor(d.node.role);
      })
      .attr('stroke-width', 1.5)
      .attr('stroke-dasharray', '4 2')
      .attr('pointer-events', 'none');

    // Main circle
    nodeEl.append('circle')
      .attr('class', 'main-circle')
      .attr('r', nodeRadius)
      .attr('fill', d => {
        const cid = d.node.componentId;
        if (cid > 0) return componentColor(cid);
        // If origin selected → color by distance
        if (selState !== 'idle' && strOriginDist && d.id !== originId) {
          const dist = strOriginDist.get(d.id);
          if (dist !== undefined) return travelTimeColor(dist, strMaxOriginDist);
        }
        return roleColor(d.node.role);
      })
      .attr('fill-opacity', d => {
        if (selState === 'path-shown') return strPathNodeSet.has(d.id) ? 1 : 0.2;
        return 0.9;
      })
      .attr('stroke', d => {
        if (d.id === originId) return 'hsl(234, 90%, 65%)';
        if (d.id === destId) return 'hsl(142, 71%, 45%)';
        return 'hsl(var(--background))';
      })
      .attr('stroke-width', d => (d.id === originId || d.id === destId) ? 3.5 : 2);

    // Mode dots (up to 3)
    nodeEl.filter(d => d.node.modes.length > 0)
      .each(function(d) {
        const g = d3.select(this);
        const r = nodeRadius(d);
        d.node.modes.slice(0, 3).forEach((mode, i) => {
          g.append('rect')
            .attr('x', -4 + i * 5 - (Math.min(d.node.modes.length, 3) - 1) * 2.5)
            .attr('y', r - 3)
            .attr('width', 4).attr('height', 4).attr('rx', 1)
            .attr('fill', modeColors[mode] ?? '#888')
            .attr('pointer-events', 'none');
        });
      });

    // Labels — show for degree ≥ 3
    nodeEl.filter(d => d.node.degree >= 3)
      .append('text')
      .attr('dy', d => nodeRadius(d) + (d.node.modes.length > 0 ? 15 : 12))
      .attr('text-anchor', 'middle')
      .attr('font-size', d => d.node.degree >= 6 ? 10 : 9)
      .attr('font-weight', d => d.node.degree >= 6 ? '700' : '500')
      .attr('fill', 'hsl(var(--foreground))')
      .attr('fill-opacity', d => selState === 'path-shown' && !strPathNodeSet.has(d.id) ? 0.2 : 1)
      .attr('pointer-events', 'none')
      .text(d => { const n = d.node.name; return n.length > 20 ? n.slice(0, 18) + '…' : n; });

    // Tooltip title
    nodeEl.append('title')
      .text(d => {
        const cid = d.node.componentId;
        const compLabel = cid === 0 ? 'Principale' : `Isolée #${cid}`;
        return [
          d.node.name,
          `Lignes: ${d.node.routeIds.length} · Modes: ${d.node.modes.map(m => modeLabels[m]).join(', ') || '—'}`,
          `Degré: ${d.node.degree} connexion${d.node.degree !== 1 ? 's' : ''}`,
          `Rôle: ${roleLabel(d.node.role)}`,
          `Composante: ${compLabel}`,
        ].join('\n');
      });

    nodeEl.on('click', (event, d) => { event.stopPropagation(); handleNodeClick(d.id); });

    svg.on('click', () => {
      setSelState('idle');
      setOriginId(null);
      setDestId(null);
    });

    strSimRef.current.on('tick', () => {
      linkEl
        .attr('x1', d => (d.source as StrSimNode).x ?? 0)
        .attr('y1', d => (d.source as StrSimNode).y ?? 0)
        .attr('x2', d => (d.target as StrSimNode).x ?? 0)
        .attr('y2', d => (d.target as StrSimNode).y ?? 0);
      nodeEl.attr('transform', d => `translate(${d.x ?? 0},${d.y ?? 0})`);
    });

    return () => { strSimRef.current?.stop(); };
  }, [
    rawMode, strategicGraph, strategicConnectivity,
    selState, strPathEdgeSet, strPathNodeSet, strOriginDist,
    strMaxOriginDist, originId, destId, handleNodeClick,
  ]);

  // Selection ring update (no full re-render) — strategic
  useEffect(() => {
    if (rawMode || !strSvgRef.current) return;
    d3.select(strSvgRef.current).selectAll<SVGCircleElement, StrSimNode>('.nodes g .main-circle')
      .attr('stroke', (d: StrSimNode) => {
        if (d.id === originId) return 'hsl(234, 90%, 65%)';
        if (d.id === destId) return 'hsl(142, 71%, 45%)';
        return 'hsl(var(--background))';
      })
      .attr('stroke-width', (d: StrSimNode) => (d.id === originId || d.id === destId) ? 3.5 : 2);
  }, [originId, destId, rawMode]);

  // ─── Raw D3 graph ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!rawMode || !interGraph || !rawSvgRef.current) return;
    const svg = d3.select(rawSvgRef.current);
    svg.selectAll('*').remove();
    if (interGraph.nodes.size === 0) return;

    const width = rawSvgRef.current.clientWidth || 800;
    const height = rawSvgRef.current.clientHeight || 520;
    const container = svg.append('g').attr('class', 'zoom-container');
    svg.call(
      d3.zoom<SVGSVGElement, unknown>()
        .scaleExtent([0.15, 8])
        .on('zoom', ev => container.attr('transform', ev.transform.toString()))
    );

    const seenKeys = new Set<string>();
    const simLinks: RawSimLink[] = [];
    for (const edge of interGraph.edges) {
      const key = [edge.from, edge.to].sort().join('|||');
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      simLinks.push({ source: edge.from, target: edge.to, edge });
    }

    const simNodes: RawSimNode[] = [...interGraph.nodes.values()].map(node => ({
      id: node.nodeId,
      node,
      x: node.isCenter
        ? width / 2
        : width / 2 + (node.travelSeconds / interGraph.maxTravelSeconds) *
          (Math.min(width, height) * 0.4) * Math.cos(Math.random() * 2 * Math.PI),
      y: node.isCenter
        ? height / 2
        : height / 2 + (node.travelSeconds / interGraph.maxTravelSeconds) *
          (Math.min(width, height) * 0.4) * Math.sin(Math.random() * 2 * Math.PI),
    }));

    const centerSim = simNodes.find(n => n.node.isCenter);
    if (centerSim) { centerSim.fx = width / 2; centerSim.fy = height / 2; }

    rawSimRef.current = d3.forceSimulation<RawSimNode, RawSimLink>(simNodes)
      .force('link', d3.forceLink<RawSimNode, RawSimLink>(simLinks)
        .id(d => d.id)
        .distance(d => Math.max(50, Math.min(200, d.edge.avgSeconds * 0.15)))
        .strength(0.3))
      .force('charge', d3.forceManyBody().strength(-180))
      .force('center', d3.forceCenter(width / 2, height / 2).strength(0.05))
      .force('collision', d3.forceCollide(18));

    const linkEl = container.append('g').attr('class', 'links')
      .selectAll<SVGLineElement, RawSimLink>('line')
      .data(simLinks)
      .join('line')
      .attr('stroke', d => {
        const key = `${d.edge.from}|||${d.edge.to}`;
        const keyR = `${d.edge.to}|||${d.edge.from}`;
        if (rawPathEdgeSet.has(key) || rawPathEdgeSet.has(keyR)) return 'hsl(234, 90%, 65%)';
        return d.edge.source === 'transfer' ? 'hsl(280, 60%, 55%)' : 'hsl(215, 16%, 60%)';
      })
      .attr('stroke-width', d => {
        const key = `${d.edge.from}|||${d.edge.to}`;
        const keyR = `${d.edge.to}|||${d.edge.from}`;
        if (rawPathEdgeSet.has(key) || rawPathEdgeSet.has(keyR)) return 3;
        return Math.max(0.8, Math.min(3, 80 / Math.max(30, d.edge.avgSeconds / 60)));
      })
      .attr('stroke-opacity', d => {
        const key = `${d.edge.from}|||${d.edge.to}`;
        const keyR = `${d.edge.to}|||${d.edge.from}`;
        if (rawPathEdgeSet.has(key) || rawPathEdgeSet.has(keyR)) return 0.9;
        if (selState === 'path-shown') return 0.15;
        return d.edge.source === 'transfer' ? 0.5 : 0.35;
      })
      .attr('stroke-dasharray', d => d.edge.source === 'transfer' ? '4 2' : '');

    const edgeLabelEl = container.append('g').attr('class', 'edge-labels')
      .selectAll<SVGTextElement, RawSimLink>('text')
      .data(simLinks.filter(l => l.edge.avgSeconds < 300 && selState !== 'path-shown'))
      .join('text')
      .attr('text-anchor', 'middle')
      .attr('font-size', 8)
      .attr('fill', 'hsl(215, 16%, 45%)')
      .attr('pointer-events', 'none')
      .text(d => `${Math.round(d.edge.avgSeconds / 60)} min`);

    const nodeRadius = (d: RawSimNode) => d.node.isCenter ? 14 : Math.max(6, Math.min(12, 5 + d.node.routeCount * 1.2));

    const nodeEl = container.append('g').attr('class', 'nodes')
      .selectAll<SVGGElement, RawSimNode>('g')
      .data(simNodes)
      .join('g')
      .attr('cursor', 'pointer')
      .call(
        d3.drag<SVGGElement, RawSimNode>()
          .on('start', (event, d) => {
            if (!event.active) rawSimRef.current?.alphaTarget(0.3).restart();
            d.fx = d.x; d.fy = d.y;
          })
          .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
          .on('end', (event, d) => {
            if (!event.active) rawSimRef.current?.alphaTarget(0);
            if (!d.node.isCenter) { d.fx = null; d.fy = null; }
          })
      );

    nodeEl.filter(d => d.node.isCenter)
      .append('circle')
      .attr('r', d => nodeRadius(d) + 7)
      .attr('fill', 'none')
      .attr('stroke', 'hsl(234, 90%, 65%)')
      .attr('stroke-width', 2)
      .attr('stroke-dasharray', '5 3');

    nodeEl.append('circle')
      .attr('class', 'main-circle')
      .attr('r', nodeRadius)
      .attr('fill', d => {
        const cid = rawConnectivity.componentMap.get(d.id) ?? 0;
        if (cid > 0) return componentColor(cid);
        return travelTimeColor(d.node.travelSeconds, interGraph.maxTravelSeconds);
      })
      .attr('fill-opacity', d => {
        if (selState === 'path-shown') return rawPathNodeSet.has(d.id) ? 1 : 0.25;
        return d.node.isCenter ? 1 : 0.85;
      })
      .attr('stroke', 'hsl(var(--background))')
      .attr('stroke-width', 2);

    nodeEl.filter(d => d.node.modes.length > 0)
      .each(function(d) {
        const g = d3.select(this);
        const r = nodeRadius(d);
        d.node.modes.slice(0, 3).forEach((mode, i) => {
          g.append('rect')
            .attr('x', -4 + i * 5 - (Math.min(d.node.modes.length, 3) - 1) * 2.5)
            .attr('y', r - 3)
            .attr('width', 4).attr('height', 4).attr('rx', 1)
            .attr('fill', modeColors[mode] ?? '#888')
            .attr('pointer-events', 'none');
        });
      });

    nodeEl.append('text')
      .attr('dy', d => nodeRadius(d) + (d.node.modes.length > 0 ? 15 : 12))
      .attr('text-anchor', 'middle')
      .attr('font-size', d => d.node.isCenter ? 11 : 9)
      .attr('font-weight', d => d.node.isCenter ? '700' : '500')
      .attr('fill', 'hsl(var(--foreground))')
      .attr('fill-opacity', d => selState === 'path-shown' && !rawPathNodeSet.has(d.id) ? 0.3 : 1)
      .attr('pointer-events', 'none')
      .text(d => { const n = d.node.stopName; return n.length > 22 ? n.slice(0, 20) + '…' : n; });

    nodeEl.filter(d => !d.node.isCenter)
      .append('text')
      .attr('dy', d => nodeRadius(d) + (d.node.modes.length > 0 ? 24 : 21))
      .attr('text-anchor', 'middle')
      .attr('font-size', 8)
      .attr('fill', 'hsl(215, 16%, 55%)')
      .attr('pointer-events', 'none')
      .text(d => `${Math.round(d.node.travelSeconds / 60)} min réseau`);

    nodeEl.on('click', (event, d) => { event.stopPropagation(); handleNodeClick(d.id); });

    svg.on('click', () => {
      setSelState('idle');
      setOriginId(null);
      setDestId(null);
    });

    rawSimRef.current.on('tick', () => {
      linkEl
        .attr('x1', d => (d.source as RawSimNode).x ?? 0)
        .attr('y1', d => (d.source as RawSimNode).y ?? 0)
        .attr('x2', d => (d.target as RawSimNode).x ?? 0)
        .attr('y2', d => (d.target as RawSimNode).y ?? 0);
      edgeLabelEl
        .attr('x', d => (((d.source as RawSimNode).x ?? 0) + ((d.target as RawSimNode).x ?? 0)) / 2)
        .attr('y', d => (((d.source as RawSimNode).y ?? 0) + ((d.target as RawSimNode).y ?? 0)) / 2);
      nodeEl.attr('transform', d => `translate(${d.x ?? 0},${d.y ?? 0})`);
    });

    return () => { rawSimRef.current?.stop(); };
  }, [
    rawMode, interGraph, rawConnectivity,
    selState, rawPathEdgeSet, rawPathNodeSet, handleNodeClick,
  ]);

  // Selection ring update — raw mode
  useEffect(() => {
    if (!rawMode || !rawSvgRef.current) return;
    d3.select(rawSvgRef.current).selectAll<SVGCircleElement, RawSimNode>('.nodes g .main-circle')
      .attr('stroke', (d: RawSimNode) => {
        if (d.id === originId) return 'hsl(234, 90%, 65%)';
        if (d.id === destId) return 'hsl(142, 71%, 45%)';
        return 'hsl(var(--background))';
      })
      .attr('stroke-width', (d: RawSimNode) => (d.id === originId || d.id === destId) ? 3.5 : 2);
  }, [originId, destId, rawMode]);

  // ─── UI ─────────────────────────────────────────────────────────────────────

  const hasPathways = (gtfs.pathways?.length ?? 0) > 0;

  const selectionHint =
    selState === 'idle'            ? 'Cliquer une station pour définir l\'origine' :
    selState === 'origin-selected' ? 'Cliquer une station destination (ou recliquer pour annuler)' :
    'Cliquer n\'importe où pour réinitialiser';

  // Strategic sidebar data
  const strOriginNode = !rawMode ? strategicGraph.nodes.get(originId ?? '') : undefined;
  const strDestNode   = !rawMode ? strategicGraph.nodes.get(destId ?? '')   : undefined;

  // Raw sidebar data
  const rawOriginNode = rawMode ? interGraph?.nodes.get(originId ?? '') : undefined;
  const rawDestNode   = rawMode ? interGraph?.nodes.get(destId ?? '')   : undefined;

  const activeJesResult = rawMode ? rawJesResult : strJesResult;
  const activePathResult = rawMode ? rawPathResult : strPathResult;
  const jesInfo = activeJesResult ? jesLabel(activeJesResult.normalizedScore) : null;

  return (
    <div className="flex gap-4 h-[660px]">
      {/* Graph panel */}
      <div className="flex-1 flex flex-col gap-3 min-w-0">
        {/* Controls */}
        <div className="flex items-center gap-3 flex-wrap">
          {/* Mode toggle */}
          <button
            onClick={() => setRawMode(v => !v)}
            className={`h-8 px-3 text-xs rounded-md border font-medium transition-colors ${
              rawMode
                ? 'border-amber-500/50 bg-amber-500/10 text-amber-600 dark:text-amber-400'
                : 'border-primary/40 bg-primary/8 text-primary'
            }`}
          >
            {rawMode ? 'Vue brute GTFS' : 'Vue stratégique'}
          </button>

          {rawMode && (
            <>
              <label className="text-xs font-medium text-muted-foreground whitespace-nowrap">Station :</label>
              <select
                value={selectedStationId}
                onChange={e => setSelectedStationId(e.target.value)}
                className="flex-1 min-w-0 h-8 text-xs rounded-md border border-border bg-background px-2 focus:outline-none focus:ring-1 focus:ring-primary"
              >
                {candidates.map(c => (
                  <option key={c.stopId} value={c.stopId}>
                    {c.stopName} ({c.childCount} arrêt{c.childCount > 1 ? 's' : ''})
                  </option>
                ))}
              </select>

              <label className="text-xs font-medium text-muted-foreground whitespace-nowrap">Rayon :</label>
              <select
                value={maxMinutes}
                onChange={e => setMaxMinutes(Number(e.target.value))}
                className="w-24 h-8 text-xs rounded-md border border-border bg-background px-2 focus:outline-none focus:ring-1 focus:ring-primary"
              >
                {[5, 10, 15, 20, 30].map(m => <option key={m} value={m}>{m} min</option>)}
              </select>
            </>
          )}

          {!rawMode && (
            <span className="text-[10px] text-muted-foreground ml-1">
              {strategicGraph.totalNodes} stations · {strategicGraph.totalEdges} connexions
              {strategicConnectivity.geoInferredEdges > 0 && ` · ${strategicConnectivity.geoInferredEdges} arcs géo inférés`}
            </span>
          )}
        </div>

        {/* Interaction hint */}
        <div className="text-[10px] text-muted-foreground px-1">
          <span className={`font-medium ${selState !== 'idle' ? 'text-primary' : ''}`}>{selectionHint}</span>
        </div>

        {/* D3 canvas */}
        <div className="relative flex-1 rounded-md border border-border bg-card overflow-hidden">
          {/* Strategic SVG */}
          <svg
            ref={strSvgRef}
            className={`w-full h-full ${rawMode ? 'hidden' : ''}`}
          />
          {/* Raw SVG */}
          <svg
            ref={rawSvgRef}
            className={`w-full h-full ${rawMode ? '' : 'hidden'}`}
          />

          {rawMode && (!interGraph || interGraph.nodes.size === 0) && (
            <div className="absolute inset-0 flex items-center justify-center">
              <p className="text-xs text-muted-foreground">Ce stop_id n'apparaît pas dans stop_times.</p>
            </div>
          )}

          {/* Raw mode badge */}
          {rawMode && (
            <div className="absolute top-2 left-2 text-[10px] bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30 px-2 py-1 rounded font-medium">
              Vue technique GTFS brute — niveau stop_id
            </div>
          )}

          {/* Stats overlay */}
          <div className="absolute bottom-2 left-2 text-[10px] text-muted-foreground bg-background/80 px-2 py-1 rounded">
            {rawMode
              ? interGraph && interGraph.nodes.size > 0
                ? `${interGraph.nodes.size} stations · ${interGraph.totalStopTimesEdges} arcs GTFS${interGraph.transferEdgeCount > 0 ? ` · ${interGraph.transferEdgeCount} transfers` : ''}`
                : null
              : `${strategicGraph.totalNodes} nœuds · ${strategicGraph.totalEdges} arcs`
            }
          </div>
        </div>

        {/* Legend */}
        {!rawMode ? (
          <div className="flex flex-wrap gap-3 text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ backgroundColor: roleColor('hub') }} />Hub (≥4)
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ backgroundColor: roleColor('terminus') }} />Terminus
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ backgroundColor: roleColor('branch') }} />Branche
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ backgroundColor: roleColor('isolated') }} />Isolée
            </span>
            <span className="flex items-center gap-1 ml-2">
              <span className="inline-block w-5 border-t border-dashed border-purple-400" />Transfer
            </span>
          </div>
        ) : (
          <div className="flex flex-wrap gap-3 text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <span className="inline-block w-2.5 h-2.5 rounded-full bg-green-500" />Proche
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-2.5 h-2.5 rounded-full bg-amber-400" />Moyen
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-2.5 h-2.5 rounded-full bg-red-500" />Loin ({maxMinutes} min)
            </span>
            <span className="flex items-center gap-1 ml-2">
              <span className="inline-block w-2.5 h-2.5 rounded-full bg-blue-400" />Composant isolé
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-5 border-t border-dashed border-purple-400" />Transfer
            </span>
            <span className="text-[9px] italic ml-auto">Temps transport GTFS — pas des temps piétons</span>
          </div>
        )}
      </div>

      {/* Sidebar */}
      <div className="w-72 flex flex-col gap-3 overflow-y-auto">

        {/* GTFS simplifié badge */}
        {!hasPathways && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/8 px-3 py-2">
            <p className="text-[10px] text-amber-600 dark:text-amber-400 font-medium">
              Mode GTFS simplifié
            </p>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              pathways.txt absent — JES basé uniquement sur temps transport, correspondances et attentes. Pas de topologie physique.
            </p>
          </div>
        )}

        {/* Raw mode station stats */}
        {rawMode && interGraph && (
          <div className="rounded-md border border-border bg-card p-4">
            <h3 className="text-xs font-semibold mb-3 text-foreground">{interGraph.centerName}</h3>
            <div className="grid grid-cols-2 gap-2 text-xs mb-3">
              <div className="bg-secondary/40 rounded p-2">
                <div className="text-muted-foreground">Stations</div>
                <div className="font-medium text-lg">{interGraph.nodes.size}</div>
              </div>
              <div className="bg-secondary/40 rounded p-2">
                <div className="text-muted-foreground">Connexions</div>
                <div className="font-medium text-lg">{interGraph.totalStopTimesEdges}</div>
              </div>
            </div>

            <div className="pt-3 border-t border-border">
              <div className="text-[10px] text-muted-foreground mb-2">Plus proches (temps transport GTFS)</div>
              {[...interGraph.nodes.values()]
                .filter(n => !n.isCenter)
                .sort((a, b) => a.travelSeconds - b.travelSeconds)
                .slice(0, 5)
                .map(n => (
                  <button
                    key={n.nodeId}
                    onClick={() => handleNodeClick(n.nodeId)}
                    className="w-full flex items-center justify-between py-1 text-[10px] hover:text-foreground text-muted-foreground transition-colors text-left"
                  >
                    <span className="truncate flex-1">{n.stopName}</span>
                    <span className="ml-2 flex-shrink-0 font-medium"
                      style={{ color: travelTimeColor(n.travelSeconds, interGraph.maxTravelSeconds) }}>
                      {Math.round(n.travelSeconds / 60)} min
                    </span>
                  </button>
                ))
              }
            </div>
          </div>
        )}

        {/* Journey analysis */}
        {(rawMode ? rawOriginNode : strOriginNode) && (
          <div className="rounded-md border border-border bg-card p-4">
            <h3 className="text-xs font-semibold mb-3 text-foreground">Analyse trajet</h3>

            {/* Origin */}
            <div className="flex items-start gap-2 text-[10px] mb-2">
              <span className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0 mt-0.5" />
              <div>
                <span className="font-medium">Origine : </span>
                <span className="text-muted-foreground">
                  {rawMode ? rawOriginNode?.stopName : strOriginNode?.name}
                </span>
                <div className="text-muted-foreground/60 mt-0.5">
                  {rawMode
                    ? `${rawOriginNode?.routeCount} ligne${(rawOriginNode?.routeCount ?? 0) > 1 ? 's' : ''}${rawOriginNode?.modes.length ? ` · ${rawOriginNode.modes.map(m => modeLabels[m]).join(', ')}` : ''}`
                    : `${strOriginNode?.routeIds.length} ligne${(strOriginNode?.routeIds.length ?? 0) > 1 ? 's' : ''}${strOriginNode?.modes.length ? ` · ${strOriginNode.modes.map(m => modeLabels[m]).join(', ')}` : ''}`
                  }
                </div>
              </div>
            </div>

            {/* Destination */}
            {(rawMode ? rawDestNode : strDestNode) ? (
              <div className="flex items-start gap-2 text-[10px] mb-3">
                <span className="w-2 h-2 rounded-full bg-green-500 flex-shrink-0 mt-0.5" />
                <div>
                  <span className="font-medium">Destination : </span>
                  <span className="text-muted-foreground">
                    {rawMode ? rawDestNode?.stopName : strDestNode?.name}
                  </span>
                  <div className="text-muted-foreground/60 mt-0.5">
                    {rawMode
                      ? `${rawDestNode?.routeCount} ligne${(rawDestNode?.routeCount ?? 0) > 1 ? 's' : ''}`
                      : `${strDestNode?.routeIds.length} ligne${(strDestNode?.routeIds.length ?? 0) > 1 ? 's' : ''}`
                    }
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-[10px] text-muted-foreground italic mb-3">
                Cliquer une station destination…
              </p>
            )}

            {/* Path result */}
            {activePathResult && (
              <>
                {activePathResult.found ? (
                  <div className="space-y-3">
                    <div className="bg-secondary/40 rounded p-3 space-y-1.5 text-[10px]">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Temps transport GTFS</span>
                        <span className="font-medium">{Math.round(activePathResult.totalSeconds / 60)} min</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Correspondances</span>
                        <span className="font-medium">{activePathResult.transferCount}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Étapes</span>
                        <span className="font-medium">{activePathResult.hops}</span>
                      </div>
                      {activePathResult.usedRouteIds.length > 0 && (
                        <div className="pt-1 border-t border-border/50">
                          <span className="text-muted-foreground">Lignes : </span>
                          <span className="font-medium">
                            {activePathResult.usedRouteIds.slice(0, 5)
                              .map(id => routeNames.get(id) ?? id)
                              .join(', ')}
                          </span>
                        </div>
                      )}
                    </div>

                    {/* JES */}
                    {activeJesResult && jesInfo && (
                      <div className="rounded p-3"
                        style={{ backgroundColor: `${jesInfo.color}18`, border: `1px solid ${jesInfo.color}40` }}>
                        <div className="flex items-center justify-between mb-2">
                          <span
                            className="text-[10px] font-semibold cursor-help relative group"
                            aria-label="Score JES"
                          >
                            Score JES
                            <span className="absolute left-1/2 -translate-x-1/2 top-5 hidden group-hover:block text-[10px] font-normal bg-black text-white px-2 py-1 rounded whitespace-nowrap z-50">
                              Journey Event System — modèle basé sur temps de trajet (GTFS simplifié)
                            </span>
                          </span>
                          <span className="text-sm font-bold" style={{ color: jesInfo.color }}>
                            {Math.round(activeJesResult.normalizedScore)}/100
                          </span>
                        </div>
                        <div className="w-full h-1.5 rounded-full bg-secondary/60 overflow-hidden">
                          <div className="h-full rounded-full"
                            style={{ width: `${activeJesResult.normalizedScore}%`, backgroundColor: jesInfo.color }} />
                        </div>
                        <div className="text-[10px] mt-1.5 font-medium" style={{ color: jesInfo.color }}>
                          {jesInfo.label}
                        </div>
                      </div>
                    )}

                    {/* Segments */}
                    {activePathResult.segments.length > 0 && (
                      <div>
                        <div className="text-[10px] font-semibold mb-1.5">Détail des segments</div>
                        <div className="space-y-1">
                          {activePathResult.segments.map((seg, i) => (
                            <div key={i} className={`text-[10px] flex items-start gap-2 py-1 border-b border-border/40 last:border-0 ${seg.isTransfer ? 'text-amber-500' : 'text-muted-foreground'}`}>
                              {seg.isTransfer ? <span className="flex-shrink-0">⇄</span> : <span className="flex-shrink-0">→</span>}
                              <div className="flex-1 min-w-0">
                                <span className="truncate block">{seg.fromName} → {seg.toName}</span>
                                <span className="text-muted-foreground/70">
                                  {Math.round(seg.travelSeconds / 60)} min transport
                                  {seg.routeIds.length > 0 && ` · ${seg.routeIds.slice(0, 2).map(id => routeNames.get(id) ?? id).join(', ')}`}
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-[10px] text-destructive">
                    {rawMode
                      ? 'Aucun chemin trouvé dans ce rayon. Essayer un rayon plus grand.'
                      : 'Aucun chemin trouvé entre ces deux stations.'}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Alternative journeys (raw mode only) */}
        {rawMode && selState === 'path-shown' && rawAlternatives.length > 1 && (
          <div className="rounded-md border border-border bg-card p-4">
            <button
              onClick={() => setShowAlternatives(v => !v)}
              className="w-full flex items-center justify-between text-xs font-semibold text-foreground"
            >
              <span>Comparer les options ({rawAlternatives.length})</span>
              <span className="text-muted-foreground">{showAlternatives ? '▲' : '▼'}</span>
            </button>

            {showAlternatives && (
              <div className="mt-3 space-y-2">
                {rawAlternatives.map((alt, i) => {
                  const info = jesLabel(alt.jes.normalizedScore);
                  return (
                    <div key={alt.id}
                      className={`rounded-lg border p-3 text-[10px] ${alt.isOptimal ? 'border-primary/40 bg-primary/5' : 'border-border bg-secondary/20'}`}
                    >
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="font-semibold text-foreground">
                          {alt.isOptimal ? 'Optimal' : `Option ${i}`}
                        </span>
                        <div className="flex items-center gap-2">
                          {!alt.isOptimal && alt.timeDeltaPct !== 0 && (
                            <span className={`font-mono ${alt.timeDeltaPct > 0 ? 'text-amber-500' : 'text-green-500'}`}>
                              {alt.timeDeltaPct > 0 ? '+' : ''}{alt.timeDeltaPct}%
                            </span>
                          )}
                          <span className="font-bold" style={{ color: info.color }}>
                            JES {Math.round(alt.jes.normalizedScore)}
                          </span>
                        </div>
                      </div>
                      <div className="grid grid-cols-3 gap-1.5 mb-1.5 text-center">
                        <div className="bg-background/60 rounded px-1 py-1">
                          <div className="text-muted-foreground">Temps</div>
                          <div className="font-medium">{Math.round(alt.path.totalSeconds / 60)} min</div>
                        </div>
                        <div className="bg-background/60 rounded px-1 py-1">
                          <div className="text-muted-foreground">Correspond.</div>
                          <div className="font-medium">{alt.path.transferCount}</div>
                        </div>
                        <div className="bg-background/60 rounded px-1 py-1">
                          <div className="text-muted-foreground">Étapes</div>
                          <div className="font-medium">{alt.path.hops}</div>
                        </div>
                      </div>
                      {alt.path.usedRouteIds.length > 0 && (
                        <div className="text-muted-foreground mb-1">
                          Lignes : {alt.path.usedRouteIds.slice(0, 4).map(id => routeNames.get(id) ?? id).join(', ')}
                        </div>
                      )}
                      <div className="italic text-muted-foreground/70">{alt.comment}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Connectivity diagnostic */}
        <div className="rounded-md border border-border bg-card p-4">
          <button
            onClick={() => setShowDiagnostic(v => !v)}
            className="w-full flex items-center justify-between text-xs font-semibold text-foreground"
          >
            <span>Diagnostic réseau</span>
            <span className="text-muted-foreground">{showDiagnostic ? '▲' : '▼'}</span>
          </button>

          {/* Summary (always visible) */}
          {!showDiagnostic && (
            <div className="mt-2 grid grid-cols-2 gap-2 text-[10px]">
              <div className="bg-secondary/40 rounded p-2">
                <div className="text-muted-foreground">Composantes</div>
                <div className="font-medium text-base">
                  {rawMode ? rawConnectivity.connectedComponents : strategicConnectivity.connectedComponents}
                </div>
              </div>
              <div className="bg-secondary/40 rounded p-2">
                <div className="text-muted-foreground">Plus grand</div>
                <div className="font-medium text-base">
                  {rawMode ? rawConnectivity.largestComponentSize : strategicConnectivity.mainComponentSize} nœuds
                </div>
              </div>
            </div>
          )}

          {showDiagnostic && !rawMode && (
            <div className="mt-3 space-y-2 text-[10px]">
              <div className="grid grid-cols-2 gap-2">
                <div className="bg-secondary/40 rounded p-2">
                  <div className="text-muted-foreground">Composantes</div>
                  <div className="font-medium">{strategicConnectivity.connectedComponents}</div>
                </div>
                <div className="bg-secondary/40 rounded p-2">
                  <div className="text-muted-foreground">Stations total</div>
                  <div className="font-medium">{strategicGraph.totalNodes}</div>
                </div>
                <div className="bg-secondary/40 rounded p-2">
                  <div className="text-muted-foreground">Composante principale</div>
                  <div className="font-medium">{strategicConnectivity.mainComponentSize}</div>
                </div>
                <div className="bg-secondary/40 rounded p-2">
                  <div className="text-muted-foreground">Orphelins</div>
                  <div className="font-medium">{strategicConnectivity.orphanStations.length}</div>
                </div>
              </div>

              {strategicConnectivity.isolatedClusters.length > 0 && (
                <div className="pt-2 border-t border-border">
                  <div className="text-muted-foreground font-medium mb-1.5">
                    {strategicConnectivity.isolatedClusters.length} cluster{strategicConnectivity.isolatedClusters.length > 1 ? 's' : ''} isolé{strategicConnectivity.isolatedClusters.length > 1 ? 's' : ''}
                  </div>
                  <div className="space-y-1.5 max-h-40 overflow-y-auto">
                    {strategicConnectivity.isolatedClusters.slice(0, 10).map((cl, i) => {
                      const cause = STRATEGIC_CAUSE_LABELS[cl.probableCause];
                      return (
                        <div key={i} className="flex items-start gap-2 py-1 border-b border-border/40 last:border-0">
                          <span className="w-2 h-2 rounded-full flex-shrink-0 mt-0.5"
                            style={{ backgroundColor: cause?.color ?? '#888' }} />
                          <div className="flex-1 min-w-0">
                            <div className="truncate text-foreground">
                              {cl.stations.slice(0, 2).join(', ')}
                              {cl.size > 2 && ` +${cl.size - 2}`}
                            </div>
                            <div className="text-muted-foreground/70" style={{ color: cause?.color }}>
                              {cause?.label ?? cl.probableCause} · {cl.size} nœud{cl.size > 1 ? 's' : ''}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {strategicConnectivity.orphanStations.length > 0 && (
                <div className="pt-2 border-t border-border">
                  <div className="text-muted-foreground mb-1">Stations orphelines (ex.)</div>
                  <div className="text-foreground/70 leading-relaxed">
                    {strategicConnectivity.orphanStations.slice(0, 5).join(', ')}
                    {strategicConnectivity.orphanStations.length > 5 && ` … +${strategicConnectivity.orphanStations.length - 5}`}
                  </div>
                </div>
              )}
            </div>
          )}

          {showDiagnostic && rawMode && (
            <div className="mt-3 space-y-2 text-[10px]">
              <div className="grid grid-cols-2 gap-2">
                <div className="bg-secondary/40 rounded p-2">
                  <div className="text-muted-foreground">Composantes</div>
                  <div className="font-medium">{rawConnectivity.connectedComponents}</div>
                </div>
                <div className="bg-secondary/40 rounded p-2">
                  <div className="text-muted-foreground">Nœuds total</div>
                  <div className="font-medium">{rawConnectivity.totalRepresentatives}</div>
                </div>
                <div className="bg-secondary/40 rounded p-2">
                  <div className="text-muted-foreground">Plus grand</div>
                  <div className="font-medium">{rawConnectivity.largestComponentSize}</div>
                </div>
                <div className="bg-secondary/40 rounded p-2">
                  <div className="text-muted-foreground">Orphelins</div>
                  <div className="font-medium">{rawConnectivity.orphanCount}</div>
                </div>
              </div>

              {rawConnectivity.isolatedSubgraphs.length > 0 && (
                <div className="pt-2 border-t border-border">
                  <div className="text-muted-foreground font-medium mb-1.5">
                    {rawConnectivity.isolatedSubgraphs.length} sous-réseau{rawConnectivity.isolatedSubgraphs.length > 1 ? 'x' : ''} isolé{rawConnectivity.isolatedSubgraphs.length > 1 ? 's' : ''}
                  </div>
                  <div className="space-y-1.5 max-h-40 overflow-y-auto">
                    {rawConnectivity.isolatedSubgraphs.slice(0, 10).map((sg, i) => {
                      const cause = CAUSE_LABELS[sg.probableCause];
                      return (
                        <div key={i} className="flex items-start gap-2 py-1 border-b border-border/40 last:border-0">
                          <span className="w-2 h-2 rounded-full flex-shrink-0 mt-0.5"
                            style={{ backgroundColor: cause?.color ?? '#888' }} />
                          <div className="flex-1 min-w-0">
                            <div className="truncate text-foreground">
                              {sg.stationNames.slice(0, 2).join(', ')}
                              {sg.size > 2 && ` +${sg.size - 2}`}
                            </div>
                            <div className="text-muted-foreground/70" style={{ color: cause?.color }}>
                              {cause?.label ?? sg.probableCause} · {sg.size} nœud{sg.size > 1 ? 's' : ''}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {rawConnectivity.orphanNames.length > 0 && (
                <div className="pt-2 border-t border-border">
                  <div className="text-muted-foreground mb-1">Arrêts orphelins (ex.)</div>
                  <div className="text-foreground/70 leading-relaxed">
                    {rawConnectivity.orphanNames.slice(0, 5).join(', ')}
                    {rawConnectivity.orphanNames.length > 5 && ` … +${rawConnectivity.orphanNames.length - 5}`}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

      </div>
    </div>
  );
};

export default StationGraphView;
