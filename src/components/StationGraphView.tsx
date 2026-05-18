/**
 * StationGraphView — inter-station network connectivity graph.
 *
 * Data source: 100% GTFS (stop_times + trips + routes + transfers).
 * No pathways, no inferred pedestrian data, no physical distances.
 *
 * 3-click interaction:
 *   Click 1 → select origin (blue) — re-colors graph by distance from origin
 *   Click 2 → select destination (green) — shows path + JES + segments
 *   Click 3 (or click origin again) → reset
 *
 * Coloring modes:
 *   idle            → travel time from neighborhood center (green→amber→red)
 *   origin-selected → travel time from selected origin (same palette)
 *   path-shown      → path highlighted, others dimmed
 *
 * Components: nodes are colored by connected component in the full network.
 *   Largest component = neutral blue; isolated components = distinct hues.
 */
import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import * as d3 from 'd3';
import type { ParsedGtfs, InterStationGraph, InterStationNode, InterStationEdge } from '@/lib/gtfs-types';
import { buildInterStationGraph } from '@/lib/inter-station-graph';
import { getStationCandidates } from '@/lib/station-graph';
import { analyzeNetworkConnectivity, componentColor, CAUSE_LABELS } from '@/lib/network-connectivity';
import { findShortestPath, dijkstraFrom, type PathResult } from '@/lib/path-dijkstra';
import { computeJES, jesLabel } from '@/lib/jes';
import { modeColors, modeLabels } from '@/lib/gtfs-types';
import { findAlternativeJourneys, type AlternativeJourney } from '@/lib/journey-alternatives';

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

// ─── Types ────────────────────────────────────────────────────────────────────

interface SimNode extends d3.SimulationNodeDatum {
  id: string;
  node: InterStationNode;
}

interface SimLink extends d3.SimulationLinkDatum<SimNode> {
  edge: InterStationEdge;
}

type SelectionState = 'idle' | 'origin-selected' | 'path-shown';

interface Props {
  gtfs: ParsedGtfs;
}

// ─── Component ───────────────────────────────────────────────────────────────

const StationGraphView: React.FC<Props> = ({ gtfs }) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const simRef = useRef<d3.Simulation<SimNode, SimLink> | null>(null);

  const [selectedStationId, setSelectedStationId] = useState<string>('');
  const [maxMinutes, setMaxMinutes] = useState(15);
  const [selState, setSelState] = useState<SelectionState>('idle');
  const [originId, setOriginId] = useState<string | null>(null);
  const [destId, setDestId] = useState<string | null>(null);
  const [interGraph, setInterGraph] = useState<InterStationGraph | null>(null);
  const [showDiagnostic, setShowDiagnostic] = useState(false);
  const [showAlternatives, setShowAlternatives] = useState(false);

  const candidates = useMemo(() => getStationCandidates(gtfs, 30), [gtfs]);
  const routeNames = useMemo(
    () => new Map(gtfs.routes.map(r => [r.route_id, r.route_short_name || r.route_long_name])),
    [gtfs],
  );

  // Full-network connectivity — computed once per GTFS load
  const connectivity = useMemo(() => analyzeNetworkConnectivity(gtfs), [gtfs]);

  useEffect(() => {
    if (candidates.length > 0 && !selectedStationId) setSelectedStationId(candidates[0].stopId);
  }, [candidates, selectedStationId]);

  useEffect(() => {
    if (!selectedStationId) return;
    setSelState('idle');
    setOriginId(null);
    setDestId(null);
    setInterGraph(buildInterStationGraph(gtfs, selectedStationId, maxMinutes));
  }, [selectedStationId, maxMinutes, gtfs]);

  // Distances from origin node (recalculated on click 1)
  const originDist = useMemo(() => {
    if (!interGraph || !originId) return null;
    return dijkstraFrom(interGraph, originId);
  }, [interGraph, originId]);

  // Shortest path result (click 2)
  const pathResult = useMemo((): PathResult | null => {
    if (!interGraph || !originId || !destId) return null;
    return findShortestPath(interGraph, originId, destId);
  }, [interGraph, originId, destId]);

  // Alternative journeys (only when path shown)
  const alternatives = useMemo((): AlternativeJourney[] => {
    if (!interGraph || !originId || !destId || selState !== 'path-shown') return [];
    return findAlternativeJourneys(interGraph, originId, destId, routeNames, 3);
  }, [interGraph, originId, destId, selState, routeNames]);

  // JES for the path
  const jesResult = useMemo(() => {
    if (!pathResult?.found) return null;
    return computeJES(
      [originId!, destId!],
      pathResult.totalSeconds,
      [],
      0,
    );
  }, [pathResult, originId, destId]);

  // Set of node IDs on the path
  const pathNodeSet = useMemo(() => {
    if (!pathResult?.found) return new Set<string>();
    const s = new Set<string>();
    s.add(originId!);
    s.add(destId!);
    for (const seg of pathResult.segments) { s.add(seg.fromId); s.add(seg.toId); }
    return s;
  }, [pathResult, originId, destId]);

  // Set of edge keys on the path ("from|||to" normalized)
  const pathEdgeSet = useMemo(() => {
    if (!pathResult?.found) return new Set<string>();
    return new Set(pathResult.segments.map(s => `${s.fromId}|||${s.toId}`));
  }, [pathResult]);

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
      // path-shown → reset
      setOriginId(null);
      setDestId(null);
      return 'idle';
    });
  }, [originId]);

  // ─── D3 force graph ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!interGraph || !svgRef.current) return;
    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();
    if (interGraph.nodes.size === 0) return;

    const width = svgRef.current.clientWidth || 800;
    const height = svgRef.current.clientHeight || 520;
    const container = svg.append('g').attr('class', 'zoom-container');
    svg.call(
      d3.zoom<SVGSVGElement, unknown>()
        .scaleExtent([0.15, 8])
        .on('zoom', ev => container.attr('transform', ev.transform.toString()))
    );

    // Dedup edges for display
    const seenKeys = new Set<string>();
    const simLinks: SimLink[] = [];
    for (const edge of interGraph.edges) {
      const key = [edge.from, edge.to].sort().join('|||');
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      simLinks.push({ source: edge.from, target: edge.to, edge });
    }

    const simNodes: SimNode[] = [...interGraph.nodes.values()].map(node => ({
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

    simRef.current = d3.forceSimulation<SimNode, SimLink>(simNodes)
      .force('link', d3.forceLink<SimNode, SimLink>(simLinks)
        .id(d => d.id)
        .distance(d => Math.max(50, Math.min(200, d.edge.avgSeconds * 0.15)))
        .strength(0.3))
      .force('charge', d3.forceManyBody().strength(-180))
      .force('center', d3.forceCenter(width / 2, height / 2).strength(0.05))
      .force('collision', d3.forceCollide(18));

    // Edges
    const linkEl = container.append('g').attr('class', 'links')
      .selectAll<SVGLineElement, SimLink>('line')
      .data(simLinks)
      .join('line')
      .attr('class', d => {
        const key = `${d.edge.from}|||${d.edge.to}`;
        const keyR = `${d.edge.to}|||${d.edge.from}`;
        return (pathEdgeSet.has(key) || pathEdgeSet.has(keyR)) ? 'path-edge' : 'bg-edge';
      })
      .attr('stroke', d => {
        const key = `${d.edge.from}|||${d.edge.to}`;
        const keyR = `${d.edge.to}|||${d.edge.from}`;
        if (pathEdgeSet.has(key) || pathEdgeSet.has(keyR)) return 'hsl(234, 90%, 65%)';
        return d.edge.source === 'transfer' ? 'hsl(280, 60%, 55%)' : 'hsl(215, 16%, 60%)';
      })
      .attr('stroke-width', d => {
        const key = `${d.edge.from}|||${d.edge.to}`;
        const keyR = `${d.edge.to}|||${d.edge.from}`;
        if (pathEdgeSet.has(key) || pathEdgeSet.has(keyR)) return 3;
        return Math.max(0.8, Math.min(3, 80 / Math.max(30, d.edge.avgSeconds / 60)));
      })
      .attr('stroke-opacity', d => {
        const key = `${d.edge.from}|||${d.edge.to}`;
        const keyR = `${d.edge.to}|||${d.edge.from}`;
        if (pathEdgeSet.has(key) || pathEdgeSet.has(keyR)) return 0.9;
        if (selState === 'path-shown') return 0.15;
        return d.edge.source === 'transfer' ? 0.5 : 0.35;
      })
      .attr('stroke-dasharray', d => d.edge.source === 'transfer' ? '4 2' : '');

    // Edge travel-time labels (only short edges)
    const edgeLabelEl = container.append('g').attr('class', 'edge-labels')
      .selectAll<SVGTextElement, SimLink>('text')
      .data(simLinks.filter(l => l.edge.avgSeconds < 300 && selState !== 'path-shown'))
      .join('text')
      .attr('text-anchor', 'middle')
      .attr('font-size', 8)
      .attr('fill', 'hsl(215, 16%, 45%)')
      .attr('pointer-events', 'none')
      .text(d => `${Math.round(d.edge.avgSeconds / 60)} min`);

    // Nodes
    const nodeEl = container.append('g').attr('class', 'nodes')
      .selectAll<SVGGElement, SimNode>('g')
      .data(simNodes)
      .join('g')
      .attr('cursor', 'pointer')
      .call(
        d3.drag<SVGGElement, SimNode>()
          .on('start', (event, d) => {
            if (!event.active) simRef.current?.alphaTarget(0.3).restart();
            d.fx = d.x; d.fy = d.y;
          })
          .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
          .on('end', (event, d) => {
            if (!event.active) simRef.current?.alphaTarget(0);
            if (!d.node.isCenter) { d.fx = null; d.fy = null; }
          })
      );

    const nodeRadius = (d: SimNode) => d.node.isCenter ? 14 : Math.max(6, Math.min(12, 5 + d.node.routeCount * 1.2));

    // Center ring
    nodeEl.filter(d => d.node.isCenter)
      .append('circle')
      .attr('r', d => nodeRadius(d) + 7)
      .attr('fill', 'none')
      .attr('stroke', 'hsl(234, 90%, 65%)')
      .attr('stroke-width', 2)
      .attr('stroke-dasharray', '5 3');

    // Main circle — color by component (full network) or by travel time
    nodeEl.append('circle')
      .attr('class', 'main-circle')
      .attr('r', nodeRadius)
      .attr('fill', d => {
        const cid = connectivity.componentMap.get(d.id) ?? 0;
        if (cid > 0) return componentColor(cid); // isolated component → distinct hue
        return travelTimeColor(d.node.travelSeconds, interGraph.maxTravelSeconds);
      })
      .attr('fill-opacity', d => {
        if (selState === 'path-shown') return pathNodeSet.has(d.id) ? 1 : 0.25;
        return d.node.isCenter ? 1 : 0.85;
      })
      .attr('stroke', 'hsl(var(--background))')
      .attr('stroke-width', 2);

    // Mode dots
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

    // Station name label
    nodeEl.append('text')
      .attr('dy', d => nodeRadius(d) + (d.node.modes.length > 0 ? 15 : 12))
      .attr('text-anchor', 'middle')
      .attr('font-size', d => d.node.isCenter ? 11 : 9)
      .attr('font-weight', d => d.node.isCenter ? '700' : '500')
      .attr('fill', 'hsl(var(--foreground))')
      .attr('fill-opacity', d => selState === 'path-shown' && !pathNodeSet.has(d.id) ? 0.3 : 1)
      .attr('pointer-events', 'none')
      .text(d => { const n = d.node.stopName; return n.length > 22 ? n.slice(0, 20) + '…' : n; });

    // Travel-time sub-label
    nodeEl.filter(d => !d.node.isCenter)
      .append('text')
      .attr('dy', d => nodeRadius(d) + (d.node.modes.length > 0 ? 24 : 21))
      .attr('text-anchor', 'middle')
      .attr('font-size', 8)
      .attr('fill', 'hsl(215, 16%, 55%)')
      .attr('pointer-events', 'none')
      .text(d => `${Math.round(d.node.travelSeconds / 60)} min réseau`);

    nodeEl.on('click', (event, d) => { event.stopPropagation(); handleNodeClick(d.id); });

    // Click on background = reset
    svg.on('click', () => {
      setSelState('idle');
      setOriginId(null);
      setDestId(null);
    });

    simRef.current.on('tick', () => {
      linkEl
        .attr('x1', d => (d.source as SimNode).x ?? 0)
        .attr('y1', d => (d.source as SimNode).y ?? 0)
        .attr('x2', d => (d.target as SimNode).x ?? 0)
        .attr('y2', d => (d.target as SimNode).y ?? 0);
      edgeLabelEl
        .attr('x', d => (((d.source as SimNode).x ?? 0) + ((d.target as SimNode).x ?? 0)) / 2)
        .attr('y', d => (((d.source as SimNode).y ?? 0) + ((d.target as SimNode).y ?? 0)) / 2);
      nodeEl.attr('transform', d => `translate(${d.x ?? 0},${d.y ?? 0})`);
    });

    return () => { simRef.current?.stop(); };
  }, [interGraph, connectivity, selState, pathEdgeSet, pathNodeSet, handleNodeClick]);

  // Selection ring update (no full re-render)
  useEffect(() => {
    if (!svgRef.current) return;
    d3.select(svgRef.current).selectAll<SVGCircleElement, SimNode>('.nodes g .main-circle')
      .attr('stroke', (d: SimNode) => {
        if (d.id === originId) return 'hsl(234, 90%, 65%)';
        if (d.id === destId) return 'hsl(142, 71%, 45%)';
        return 'hsl(var(--background))';
      })
      .attr('stroke-width', (d: SimNode) => (d.id === originId || d.id === destId) ? 3.5 : 2);
  }, [originId, destId]);

  // ─── UI ─────────────────────────────────────────────────────────────────────

  const originNode = interGraph?.nodes.get(originId ?? '');
  const destNode = interGraph?.nodes.get(destId ?? '');
  const jesInfo = jesResult ? jesLabel(jesResult.normalizedScore) : null;
  const hasPathways = (gtfs.pathways?.length ?? 0) > 0;

  const selectionHint =
    selState === 'idle'           ? 'Cliquer une station pour définir l\'origine' :
    selState === 'origin-selected'? 'Cliquer une station destination (ou recliquer pour annuler)' :
    'Cliquer n\'importe où pour réinitialiser';

  return (
    <div className="flex gap-4 h-[660px]">
      {/* Graph panel */}
      <div className="flex-1 flex flex-col gap-3 min-w-0">
        {/* Controls */}
        <div className="flex items-center gap-3 flex-wrap">
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
        </div>

        {/* Interaction hint */}
        <div className="text-[10px] text-muted-foreground px-1">
          <span className={`font-medium ${selState !== 'idle' ? 'text-primary' : ''}`}>{selectionHint}</span>
        </div>

        {/* D3 canvas */}
        <div className="relative flex-1 rounded-md border border-border bg-card overflow-hidden">
          <svg ref={svgRef} className="w-full h-full" />

          {(!interGraph || interGraph.nodes.size === 0) && (
            <div className="absolute inset-0 flex items-center justify-center">
              <p className="text-xs text-muted-foreground">Ce stop_id n'apparaît pas dans stop_times.</p>
            </div>
          )}

          {interGraph && interGraph.nodes.size > 0 && (
            <div className="absolute bottom-2 left-2 text-[10px] text-muted-foreground bg-background/80 px-2 py-1 rounded">
              {interGraph.nodes.size} stations · {interGraph.totalStopTimesEdges} arcs GTFS
              {interGraph.transferEdgeCount > 0 && ` · ${interGraph.transferEdgeCount} transfers`}
            </div>
          )}
        </div>

        {/* Legend */}
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

        {/* Station stats */}
        {interGraph && (
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

            {/* Top 5 nearest */}
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
        {originNode && (
          <div className="rounded-md border border-border bg-card p-4">
            <h3 className="text-xs font-semibold mb-3 text-foreground">Analyse trajet</h3>

            {/* Origin */}
            <div className="flex items-start gap-2 text-[10px] mb-2">
              <span className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0 mt-0.5" />
              <div>
                <span className="font-medium">Origine : </span>
                <span className="text-muted-foreground">{originNode.stopName}</span>
                <div className="text-muted-foreground/60 mt-0.5">
                  {originNode.routeCount} ligne{originNode.routeCount > 1 ? 's' : ''}
                  {originNode.modes.length > 0 && ` · ${originNode.modes.map(m => modeLabels[m]).join(', ')}`}
                </div>
              </div>
            </div>

            {/* Destination */}
            {destNode ? (
              <div className="flex items-start gap-2 text-[10px] mb-3">
                <span className="w-2 h-2 rounded-full bg-green-500 flex-shrink-0 mt-0.5" />
                <div>
                  <span className="font-medium">Destination : </span>
                  <span className="text-muted-foreground">{destNode.stopName}</span>
                  <div className="text-muted-foreground/60 mt-0.5">
                    {destNode.routeCount} ligne{destNode.routeCount > 1 ? 's' : ''}
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-[10px] text-muted-foreground italic mb-3">
                Cliquer une station destination…
              </p>
            )}

            {/* Path result */}
            {pathResult && (
              <>
                {pathResult.found ? (
                  <div className="space-y-3">
                    {/* Stats */}
                    <div className="bg-secondary/40 rounded p-3 space-y-1.5 text-[10px]">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Temps transport GTFS</span>
                        <span className="font-medium">{Math.round(pathResult.totalSeconds / 60)} min</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Correspondances</span>
                        <span className="font-medium">{pathResult.transferCount}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Étapes</span>
                        <span className="font-medium">{pathResult.hops}</span>
                      </div>
                      {pathResult.usedRouteIds.length > 0 && (
                        <div className="pt-1 border-t border-border/50">
                          <span className="text-muted-foreground">Lignes : </span>
                          <span className="font-medium">
                            {pathResult.usedRouteIds.slice(0, 5)
                              .map(id => routeNames.get(id) ?? id)
                              .join(', ')}
                          </span>
                        </div>
                      )}
                    </div>

                    {/* JES */}
                    {jesResult && jesInfo && (
                      <div className="rounded p-3"
                        style={{ backgroundColor: `${jesInfo.color}18`, border: `1px solid ${jesInfo.color}40` }}>
                        <div className="flex items-center justify-between mb-2">
<span
  className="text-[10px] font-semibold cursor-help relative group"
  aria-label="Score JES : Journey Event System, modèle GTFS simplifié basé sur les temps de transport"
>
  Score JES

  <span className="absolute left-1/2 -translate-x-1/2 top-5 hidden group-hover:block text-[10px] font-normal bg-black text-white px-2 py-1 rounded whitespace-nowrap z-50">
    Journey Event System — modèle basé sur temps de trajet (GTFS simplifié)
  </span>
</span>                          <span className="text-sm font-bold" style={{ color: jesInfo.color }}>
                            {Math.round(jesResult.normalizedScore)}/100
                          </span>
                        </div>
                        <div className="w-full h-1.5 rounded-full bg-secondary/60 overflow-hidden">
                          <div className="h-full rounded-full"
                            style={{ width: `${jesResult.normalizedScore}%`, backgroundColor: jesInfo.color }} />
                        </div>
                        <div className="text-[10px] mt-1.5 font-medium" style={{ color: jesInfo.color }}>
                          {jesInfo.label}
                        </div>
                        {!hasPathways && (
                          <div className="text-[9px] text-muted-foreground mt-1 italic">
                            Score basé sur temps + correspondances (mode GTFS simplifié)
                          </div>
                        )}
                      </div>
                    )}

                    {/* Segments */}
                    {pathResult.segments.length > 0 && (
                      <div>
                        <div className="text-[10px] font-semibold mb-1.5">Détail des segments</div>
                        <div className="space-y-1">
                          {pathResult.segments.map((seg, i) => (
                            <div key={i} className={`text-[10px] flex items-start gap-2 py-1 border-b border-border/40 last:border-0
                              ${seg.isTransfer ? 'text-amber-500' : 'text-muted-foreground'}`}>
                              {seg.isTransfer
                                ? <span className="flex-shrink-0">⇄</span>
                                : <span className="flex-shrink-0">→</span>}
                              <div className="flex-1 min-w-0">
                                <span className="truncate block">
                                  {seg.fromName} → {seg.toName}
                                </span>
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
                    Aucun chemin trouvé dans ce rayon. Essayer un rayon plus grand.
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Alternative journeys comparison */}
        {selState === 'path-shown' && alternatives.length > 1 && (
          <div className="rounded-md border border-border bg-card p-4">
            <button
              onClick={() => setShowAlternatives(v => !v)}
              className="w-full flex items-center justify-between text-xs font-semibold text-foreground"
            >
              <span>Comparer les options ({alternatives.length})</span>
              <span className="text-muted-foreground">{showAlternatives ? '▲' : '▼'}</span>
            </button>

            {showAlternatives && (
              <div className="mt-3 space-y-2">
                {alternatives.map((alt, i) => {
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

          {!showDiagnostic && (
            <div className="mt-2 grid grid-cols-2 gap-2 text-[10px]">
              <div className="bg-secondary/40 rounded p-2">
                <div className="text-muted-foreground">Composantes</div>
                <div className="font-medium text-base">{connectivity.connectedComponents}</div>
              </div>
              <div className="bg-secondary/40 rounded p-2">
                <div className="text-muted-foreground">Plus grand</div>
                <div className="font-medium text-base">{connectivity.largestComponentSize} nœuds</div>
              </div>
            </div>
          )}

          {showDiagnostic && (
            <div className="mt-3 space-y-2 text-[10px]">
              <div className="grid grid-cols-2 gap-2">
                <div className="bg-secondary/40 rounded p-2">
                  <div className="text-muted-foreground">Composantes</div>
                  <div className="font-medium">{connectivity.connectedComponents}</div>
                </div>
                <div className="bg-secondary/40 rounded p-2">
                  <div className="text-muted-foreground">Nœuds total</div>
                  <div className="font-medium">{connectivity.totalRepresentatives}</div>
                </div>
                <div className="bg-secondary/40 rounded p-2">
                  <div className="text-muted-foreground">Plus grand</div>
                  <div className="font-medium">{connectivity.largestComponentSize}</div>
                </div>
                <div className="bg-secondary/40 rounded p-2">
                  <div className="text-muted-foreground">Orphelins</div>
                  <div className="font-medium">{connectivity.orphanCount}</div>
                </div>
              </div>

              {connectivity.isolatedSubgraphs.length > 0 && (
                <div className="pt-2 border-t border-border">
                  <div className="text-muted-foreground font-medium mb-1.5">
                    {connectivity.isolatedSubgraphs.length} sous-réseau{connectivity.isolatedSubgraphs.length > 1 ? 'x' : ''} isolé{connectivity.isolatedSubgraphs.length > 1 ? 's' : ''}
                  </div>
                  <div className="space-y-1.5 max-h-40 overflow-y-auto">
                    {connectivity.isolatedSubgraphs.slice(0, 10).map((sg, i) => {
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

              {connectivity.orphanNames.length > 0 && (
                <div className="pt-2 border-t border-border">
                  <div className="text-muted-foreground mb-1">Arrêts orphelins (ex.)</div>
                  <div className="text-foreground/70 leading-relaxed">
                    {connectivity.orphanNames.slice(0, 5).join(', ')}
                    {connectivity.orphanNames.length > 5 && ` … +${connectivity.orphanNames.length - 5}`}
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
