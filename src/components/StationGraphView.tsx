/**
 * StationGraphView — dual-mode station graph visualization.
 *
 * PRIMARY (always non-empty): inter-station neighborhood graph
 *   - Nodes = stops reachable within N minutes via stop_times
 *   - Edges = average travel times from stop_times + transfers
 *   - Node color = transport mode; size = route count; hue = travel time
 *   - Center node highlighted with ring
 *
 * SECONDARY (toggle, only when pathways.txt present): intra-station physical graph
 *   - Physical layout of platforms, stairs, elevators inside ONE station
 *
 * Click A → click B: shows transfer cost + JES between the two nodes.
 */
import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import * as d3 from 'd3';
import type { ParsedGtfs, InterStationGraph, InterStationNode, InterStationEdge, TransferCost } from '@/lib/gtfs-types';
import { buildInterStationGraph } from '@/lib/inter-station-graph';
import { buildStationGraph, getStationCandidates } from '@/lib/station-graph';
import { computeTransferCosts, getTransferCost } from '@/lib/transfer-costs';
import { computeJES, jesLabel, jesImprovementActions } from '@/lib/jes';
import { modeColors } from '@/lib/gtfs-types';

// Travel-time color scale: green (0 min) → amber (10 min) → red (20 min)
function travelTimeColor(seconds: number, maxSeconds: number): string {
  const t = Math.min(1, seconds / maxSeconds);
  if (t < 0.5) {
    // green → amber
    const h = 142 - (142 - 38) * (t / 0.5);
    const l = 45 + (50 - 45) * (t / 0.5);
    return `hsl(${h.toFixed(0)}, 71%, ${l.toFixed(0)}%)`;
  }
  // amber → red
  const t2 = (t - 0.5) / 0.5;
  const h = 38 - (38 - 0) * t2;
  return `hsl(${h.toFixed(0)}, 80%, 50%)`;
}

interface SimNode extends d3.SimulationNodeDatum {
  id: string;
  node: InterStationNode;
}

interface SimLink extends d3.SimulationLinkDatum<SimNode> {
  edge: InterStationEdge;
}

interface Props {
  gtfs: ParsedGtfs;
}

type ViewMode = 'inter' | 'intra';

const StationGraphView: React.FC<Props> = ({ gtfs }) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const simRef = useRef<d3.Simulation<SimNode, SimLink> | null>(null);

  const [selectedStationId, setSelectedStationId] = useState<string>('');
  const [maxMinutes, setMaxMinutes] = useState(15);
  const [viewMode, setViewMode] = useState<ViewMode>('inter');
  const [fromNodeId, setFromNodeId] = useState<string | null>(null);
  const [toNodeId, setToNodeId] = useState<string | null>(null);

  // Inter-station graph state
  const [interGraph, setInterGraph] = useState<InterStationGraph | null>(null);

  // Intra-station graph state (pathways)
  const [intraTransferCosts, setIntraTransferCosts] = useState<TransferCost[]>([]);
  const [hasPathways, setHasPathways] = useState(false);

  const candidates = useMemo(() => getStationCandidates(gtfs, 30), [gtfs]);

  useEffect(() => {
    if (candidates.length > 0 && !selectedStationId) {
      setSelectedStationId(candidates[0].stopId);
    }
  }, [candidates, selectedStationId]);

  useEffect(() => {
    if (!selectedStationId) return;
    setFromNodeId(null);
    setToNodeId(null);

    // Build inter-station graph (always)
    const ig = buildInterStationGraph(gtfs, selectedStationId, maxMinutes);
    setInterGraph(ig);

    // Check for intra-station pathways
    const intra = buildStationGraph(gtfs, selectedStationId);
    const pwEdges = intra ? intra.edges.filter(e => e.pathwayMode > 0).length : 0;
    setHasPathways(pwEdges > 0);
    if (intra && pwEdges > 0) {
      setIntraTransferCosts(computeTransferCosts(intra, gtfs));
    } else {
      setIntraTransferCosts([]);
    }

    // Default to inter mode (always has content)
    setViewMode('inter');
  }, [selectedStationId, maxMinutes, gtfs]);

  const handleNodeClick = useCallback((nodeId: string) => {
    if (!fromNodeId) {
      setFromNodeId(nodeId);
      setToNodeId(null);
    } else if (nodeId === fromNodeId) {
      setFromNodeId(null);
      setToNodeId(null);
    } else {
      setToNodeId(nodeId);
    }
  }, [fromNodeId]);

  // JES for inter-station pair
  const interJES = useMemo(() => {
    if (!interGraph || !fromNodeId || !toNodeId) return null;
    const fromNode = interGraph.nodes.get(fromNodeId);
    const toNode = interGraph.nodes.get(toNodeId);
    if (!fromNode || !toNode) return null;

    // Find shortest-path cost using adjacency
    const visited = new Set<string>();
    const dist = new Map<string, number>([[fromNodeId, 0]]);
    const heap: { d: number; id: string }[] = [{ d: 0, id: fromNodeId }];
    heap.sort((a, b) => a.d - b.d);
    while (heap.length > 0) {
      heap.sort((a, b) => a.d - b.d);
      const { d, id } = heap.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      for (const edge of interGraph.adjacency.get(id) ?? []) {
        const nd = d + edge.avgSeconds;
        if (nd < (dist.get(edge.to) ?? Infinity)) {
          dist.set(edge.to, nd);
          heap.push({ d: nd, id: edge.to });
        }
      }
    }
    const travelSeconds = dist.get(toNodeId);
    if (travelSeconds === undefined) return null;

    return computeJES([fromNodeId, toNodeId], travelSeconds, [], 0);
  }, [interGraph, fromNodeId, toNodeId]);

  // D3 rendering — inter-station
  useEffect(() => {
    if (viewMode !== 'inter' || !interGraph || !svgRef.current) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    if (interGraph.nodes.size === 0) return;

    const width = svgRef.current.clientWidth || 800;
    const height = svgRef.current.clientHeight || 520;

    const container = svg.append('g').attr('class', 'zoom-container');
    svg.call(
      d3.zoom<SVGSVGElement, unknown>()
        .scaleExtent([0.2, 6])
        .on('zoom', ev => container.attr('transform', ev.transform.toString()))
    );

    // Deduplicate edges for display
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
      // Radial initial position: center at canvas center, others by travel time
      x: node.isCenter
        ? width / 2
        : width / 2 + (node.travelSeconds / interGraph.maxTravelSeconds) * (Math.min(width, height) * 0.4) * Math.cos(Math.random() * 2 * Math.PI),
      y: node.isCenter
        ? height / 2
        : height / 2 + (node.travelSeconds / interGraph.maxTravelSeconds) * (Math.min(width, height) * 0.4) * Math.sin(Math.random() * 2 * Math.PI),
    }));

    // Fix center node at canvas center initially
    const centerSim = simNodes.find(n => n.node.isCenter);
    if (centerSim) { centerSim.fx = width / 2; centerSim.fy = height / 2; }

    simRef.current = d3.forceSimulation<SimNode, SimLink>(simNodes)
      .force('link', d3.forceLink<SimNode, SimLink>(simLinks)
        .id(d => d.id)
        .distance(d => Math.max(50, Math.min(200, d.edge.avgSeconds * 0.15)))
        .strength(0.3)
      )
      .force('charge', d3.forceManyBody().strength(-180))
      .force('center', d3.forceCenter(width / 2, height / 2).strength(0.05))
      .force('collision', d3.forceCollide(18));

    // Edges
    const linkEl = container.append('g').attr('class', 'links')
      .selectAll<SVGLineElement, SimLink>('line')
      .data(simLinks)
      .join('line')
      .attr('stroke', d => d.edge.source === 'transfer' ? 'hsl(280, 60%, 55%)' : 'hsl(215, 16%, 60%)')
      .attr('stroke-width', d => {
        // Thicker = faster (more capacity)
        const inv = 1 / Math.max(30, d.edge.avgSeconds / 60);
        return Math.max(0.8, Math.min(3.5, inv * 100));
      })
      .attr('stroke-opacity', d => d.edge.source === 'transfer' ? 0.5 : 0.4)
      .attr('stroke-dasharray', d => d.edge.source === 'transfer' ? '4 2' : '');

    // Edge travel time labels (only for shorter edges to avoid clutter)
    const edgeLabelEl = container.append('g').attr('class', 'edge-labels')
      .selectAll<SVGTextElement, SimLink>('text')
      .data(simLinks.filter(l => l.edge.avgSeconds < 300))
      .join('text')
      .attr('text-anchor', 'middle')
      .attr('font-size', 8)
      .attr('fill', 'hsl(215, 16%, 45%)')
      .attr('pointer-events', 'none')
      .text(d => `${Math.round(d.edge.avgSeconds / 60)}min`);

    // Node groups
    const nodeEl = container.append('g').attr('class', 'nodes')
      .selectAll<SVGGElement, SimNode>('g')
      .data(simNodes)
      .join('g')
      .attr('cursor', 'pointer')
      .call(
        d3.drag<SVGGElement, SimNode>()
          .on('start', (event, d) => {
            if (!event.active) simRef.current?.alphaTarget(0.3).restart();
            // Unfix center on manual drag
            d.fx = d.x; d.fy = d.y;
          })
          .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
          .on('end', (event, d) => {
            if (!event.active) simRef.current?.alphaTarget(0);
            if (!d.node.isCenter) { d.fx = null; d.fy = null; }
          })
      );

    const nodeRadius = (d: SimNode) => {
      if (d.node.isCenter) return 14;
      return Math.max(6, Math.min(12, 5 + d.node.routeCount * 1.2));
    };

    // Center ring
    nodeEl.filter(d => d.node.isCenter)
      .append('circle')
      .attr('r', d => nodeRadius(d) + 7)
      .attr('fill', 'none')
      .attr('stroke', 'hsl(234, 90%, 65%)')
      .attr('stroke-width', 2)
      .attr('stroke-dasharray', '5 3');

    // Main circle — color by travel time
    nodeEl.append('circle')
      .attr('class', 'main-circle')
      .attr('r', nodeRadius)
      .attr('fill', d => travelTimeColor(d.node.travelSeconds, interGraph.maxTravelSeconds))
      .attr('fill-opacity', d => d.node.isCenter ? 1 : 0.82)
      .attr('stroke', 'hsl(var(--background))')
      .attr('stroke-width', 2);

    // Mode dots (small squares below center indicating modes)
    nodeEl.filter(d => d.node.modes.length > 0)
      .each(function(d) {
        const g = d3.select(this);
        const r = nodeRadius(d);
        d.node.modes.slice(0, 3).forEach((mode, i) => {
          g.append('rect')
            .attr('x', -4 + i * 5 - (Math.min(d.node.modes.length, 3) - 1) * 2.5)
            .attr('y', r - 3)
            .attr('width', 4)
            .attr('height', 4)
            .attr('rx', 1)
            .attr('fill', modeColors[mode] ?? '#888')
            .attr('pointer-events', 'none');
        });
      });

    // Labels
    nodeEl.append('text')
      .attr('class', 'node-label')
      .attr('dy', d => nodeRadius(d) + (d.node.modes.length > 0 ? 15 : 12))
      .attr('text-anchor', 'middle')
      .attr('font-size', d => d.node.isCenter ? 11 : 9)
      .attr('font-weight', d => d.node.isCenter ? '700' : '500')
      .attr('fill', 'hsl(var(--foreground))')
      .attr('pointer-events', 'none')
      .text(d => {
        const n = d.node.stopName;
        return n.length > 20 ? n.slice(0, 18) + '…' : n;
      });

    // Travel time label for non-center nodes
    nodeEl.filter(d => !d.node.isCenter)
      .append('text')
      .attr('dy', d => nodeRadius(d) + (d.node.modes.length > 0 ? 24 : 21))
      .attr('text-anchor', 'middle')
      .attr('font-size', 8)
      .attr('fill', 'hsl(215, 16%, 55%)')
      .attr('pointer-events', 'none')
      .text(d => `${Math.round(d.node.travelSeconds / 60)}min`);

    nodeEl.on('click', (event, d) => {
      event.stopPropagation();
      handleNodeClick(d.id);
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
  }, [interGraph, viewMode, handleNodeClick]);

  // Selection ring update
  useEffect(() => {
    if (!svgRef.current || viewMode !== 'inter') return;
    d3.select(svgRef.current).selectAll<SVGCircleElement, SimNode>('.nodes g .main-circle')
      .attr('stroke', (d: SimNode) => {
        if (d.id === fromNodeId) return 'hsl(234, 90%, 65%)';
        if (d.id === toNodeId) return 'hsl(142, 71%, 45%)';
        return 'hsl(var(--background))';
      })
      .attr('stroke-width', (d: SimNode) => (d.id === fromNodeId || d.id === toNodeId) ? 3.5 : 2);
  }, [fromNodeId, toNodeId, viewMode]);

  const fromNode = interGraph?.nodes.get(fromNodeId ?? '');
  const toNode = interGraph?.nodes.get(toNodeId ?? '');
  const jesInfo = interJES ? jesLabel(interJES.normalizedScore) : null;
  const improvements = interJES ? jesImprovementActions(interJES) : [];

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
            {[5, 10, 15, 20, 30].map(m => (
              <option key={m} value={m}>{m} min</option>
            ))}
          </select>

          {hasPathways && (
            <div className="flex rounded-md border border-border overflow-hidden text-xs">
              <button
                onClick={() => setViewMode('inter')}
                className={`px-3 py-1.5 transition-colors ${viewMode === 'inter' ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground hover:bg-secondary'}`}
              >
                Réseau
              </button>
              <button
                onClick={() => setViewMode('intra')}
                className={`px-3 py-1.5 transition-colors ${viewMode === 'intra' ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground hover:bg-secondary'}`}
              >
                Physique
              </button>
            </div>
          )}
        </div>

        {/* D3 canvas */}
        <div className="relative flex-1 rounded-md border border-border bg-card overflow-hidden">
          <svg ref={svgRef} className="w-full h-full" />

          {viewMode === 'inter' && (!interGraph || interGraph.nodes.size === 0) && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="text-xs text-muted-foreground text-center p-4">
                <p className="font-medium mb-1">Aucune donnée disponible</p>
                <p>Ce stop_id n'apparaît pas dans stop_times.</p>
              </div>
            </div>
          )}

          {viewMode === 'inter' && interGraph && interGraph.nodes.size > 0 && (
            <div className="absolute bottom-2 left-2 text-[10px] text-muted-foreground bg-background/80 px-2 py-1 rounded">
              {interGraph.nodes.size} stations · {interGraph.totalStopTimesEdges} arcs stop_times
              {interGraph.transferEdgeCount > 0 && ` · ${interGraph.transferEdgeCount} transfers`}
              &nbsp;· Cliquer A puis B pour analyser
            </div>
          )}
        </div>

        {/* Legend */}
        {viewMode === 'inter' && (
          <div className="flex flex-wrap gap-3 text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <span className="inline-block w-2.5 h-2.5 rounded-full bg-green-500" />
              Proche (0 min)
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-2.5 h-2.5 rounded-full bg-amber-400" />
              Moyen
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-2.5 h-2.5 rounded-full bg-red-500" />
              Loin ({maxMinutes} min)
            </span>
            <span className="flex items-center gap-1 ml-2">
              <span className="inline-block w-5 border-t border-dashed border-purple-400" />
              Correspondance
            </span>
            <span className="flex items-center gap-1">
              <span className="text-blue-400">⬤</span> = station centre
            </span>
          </div>
        )}
      </div>

      {/* Sidebar */}
      <div className="w-72 flex flex-col gap-3 overflow-y-auto">

        {/* Stats */}
        {interGraph && viewMode === 'inter' && (
          <div className="rounded-md border border-border bg-card p-4">
            <h3 className="text-xs font-semibold mb-3 text-foreground">{interGraph.centerName}</h3>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="bg-secondary/40 rounded p-2">
                <div className="text-muted-foreground">Stations</div>
                <div className="font-medium text-lg">{interGraph.nodes.size}</div>
              </div>
              <div className="bg-secondary/40 rounded p-2">
                <div className="text-muted-foreground">Connexions</div>
                <div className="font-medium text-lg">{interGraph.totalStopTimesEdges}</div>
              </div>
              <div className="bg-secondary/40 rounded p-2 col-span-2">
                <div className="text-muted-foreground">Source</div>
                <div className="font-medium text-sm mt-0.5">
                  {interGraph.totalStopTimesEdges > 0 ? '✓ stop_times' : '—'}
                  {interGraph.transferEdgeCount > 0 ? ` · ${interGraph.transferEdgeCount} transfers` : ''}
                  {hasPathways ? ' · pathways.txt' : ''}
                </div>
              </div>
            </div>

            {/* Top neighbors */}
            <div className="mt-3 pt-3 border-t border-border">
              <div className="text-[10px] text-muted-foreground mb-2">Stations les plus proches</div>
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

        {/* A → B analysis */}
        {fromNode && viewMode === 'inter' && (
          <div className="rounded-md border border-border bg-card p-4">
            <h3 className="text-xs font-semibold mb-3 text-foreground">Analyse de trajet</h3>

            <div className="text-[10px] space-y-2">
              <div className="flex items-start gap-2">
                <span className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0 mt-0.5" />
                <div>
                  <span className="font-medium">Départ : </span>
                  <span className="text-muted-foreground">{fromNode.stopName}</span>
                  <div className="text-muted-foreground/60 mt-0.5">
                    {fromNode.routeCount} ligne{fromNode.routeCount > 1 ? 's' : ''}
                    {fromNode.isCenter ? ' · station centre' : ` · ${Math.round(fromNode.travelSeconds / 60)} min`}
                  </div>
                </div>
              </div>

              {toNode ? (
                <div className="flex items-start gap-2">
                  <span className="w-2 h-2 rounded-full bg-green-500 flex-shrink-0 mt-0.5" />
                  <div>
                    <span className="font-medium">Arrivée : </span>
                    <span className="text-muted-foreground">{toNode.stopName}</span>
                    <div className="text-muted-foreground/60 mt-0.5">
                      {toNode.routeCount} ligne{toNode.routeCount > 1 ? 's' : ''}
                      {` · ${Math.round(toNode.travelSeconds / 60)} min depuis centre`}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="text-muted-foreground italic">Cliquer une station de destination…</div>
              )}
            </div>

            {interJES && jesInfo && toNode && (
              <div className="mt-3 space-y-3">
                <div className="bg-secondary/40 rounded p-3 space-y-1.5 text-[10px]">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Temps trajet</span>
                    <span className="font-medium">{Math.round(interJES.totalTravelSeconds / 60)} min</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Correspondances</span>
                    <span className="font-medium">{interJES.transferCount}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Score perçu brut</span>
                    <span className="font-medium">{Math.round(interJES.rawScore / 60)} min perçues</span>
                  </div>
                </div>

                <div className="rounded p-3" style={{ backgroundColor: `${jesInfo.color}20`, border: `1px solid ${jesInfo.color}40` }}>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[10px] font-semibold">Score JES</span>
                    <span className="text-sm font-bold" style={{ color: jesInfo.color }}>
                      {Math.round(interJES.normalizedScore)}/100
                    </span>
                  </div>
                  <div className="w-full h-1.5 rounded-full bg-secondary/60 overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${interJES.normalizedScore}%`, backgroundColor: jesInfo.color }} />
                  </div>
                  <div className="text-[10px] mt-1.5 font-medium" style={{ color: jesInfo.color }}>
                    {jesInfo.label}
                  </div>
                </div>

                {improvements.length > 0 && (
                  <div>
                    <div className="text-[10px] font-semibold mb-1.5">Recommandations</div>
                    <ul className="space-y-1">
                      {improvements.map((a, i) => (
                        <li key={i} className="text-[10px] text-muted-foreground flex gap-1.5">
                          <span className="text-amber-500 flex-shrink-0">›</span>{a}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {fromNodeId && toNodeId && !interJES && (
              <div className="mt-3 text-[10px] text-destructive">
                Aucun chemin trouvé dans le rayon sélectionné.
              </div>
            )}
          </div>
        )}

        {/* Intra-station transfer costs (only in intra mode) */}
        {viewMode === 'intra' && intraTransferCosts.length > 0 && (
          <div className="rounded-md border border-border bg-card p-4">
            <h3 className="text-xs font-semibold mb-3 text-foreground">
              Correspondances physiques ({intraTransferCosts.length})
            </h3>
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {intraTransferCosts.slice(0, 15).map((c, i) => {
                const jes = computeJES([c.fromStopId, c.toStopId], 0, [c]);
                const label = jesLabel(jes.normalizedScore);
                return (
                  <div key={i} className="flex items-center justify-between text-[10px] py-1 border-b border-border/50 last:border-0">
                    <span className="text-muted-foreground truncate flex-1">
                      {c.fromStopId} → {c.toStopId}
                    </span>
                    <span className="ml-2 font-medium" style={{ color: label.color }}>
                      {c.walkSeconds}s · JES {Math.round(jes.normalizedScore)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* No data fallback */}
        {viewMode === 'inter' && interGraph && interGraph.nodes.size <= 1 && (
          <div className="rounded-md border border-border bg-card p-4 text-xs text-muted-foreground">
            <p className="font-medium mb-1">Station introuvable dans stop_times</p>
            <p>Ce stop_id n'apparaît ni directement ni via ses enfants dans les horaires. Vérifier que le GTFS contient bien des stop_times pour cette station.</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default StationGraphView;
