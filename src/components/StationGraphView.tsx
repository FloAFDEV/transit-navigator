/**
 * StationGraphView — intra-station graph visualization with JES panel.
 *
 * Nodes:
 *   - Size ∝ 1/(1+frictionScore) → larger = more fluid
 *   - Color = nodeType
 *   - Badge = childCount when >1 (merged stop_ids)
 *   - Dashed orange halo = frictionScore > 0.3
 *
 * Edges:
 *   - Stroke-width ∝ costSeconds
 *   - Color = pathway mode (red if slope/width issue)
 *
 * Cluster force: nodes in the same group attract each other.
 *
 * Click node A → node B: shows TransferCost breakdown + JES.
 */
import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import * as d3 from 'd3';
import type { ParsedGtfs, StationGraph, StationNode, StationEdge, TransferCost } from '@/lib/gtfs-types';
import { buildStationGraph, getStationCandidates } from '@/lib/station-graph';
import { computeTransferCosts, getTransferCost } from '@/lib/transfer-costs';
import { computeJES, jesLabel, jesImprovementActions } from '@/lib/jes';

// --- Visual constants ---

const NODE_TYPE_COLOR: Record<string, string> = {
  stop:          'hsl(234, 62%, 60%)',
  station:       'hsl(0, 72%, 51%)',
  entrance:      'hsl(142, 71%, 45%)',
  generic_node:  'hsl(215, 16%, 55%)',
  boarding_area: 'hsl(38, 92%, 50%)',
};

const PATHWAY_MODE_COLOR: Record<number, string> = {
  0: 'hsl(215, 16%, 55%)',
  1: 'hsl(215, 16%, 70%)',
  2: 'hsl(24, 90%, 52%)',
  3: 'hsl(215, 16%, 70%)',
  4: 'hsl(38, 92%, 50%)',
  5: 'hsl(280, 60%, 55%)',
  6: 'hsl(0, 72%, 51%)',
  7: 'hsl(0, 72%, 51%)',
};

const PATHWAY_MODE_LABEL: Record<number, string> = {
  0: 'Correspondance',
  1: 'Couloir',
  2: 'Escalier',
  3: 'Tapis roulant',
  4: 'Escalator',
  5: 'Ascenseur',
  6: 'Portique',
  7: 'Sortie',
};

interface SimNode extends d3.SimulationNodeDatum {
  id: string;
  node: StationNode;
}

interface SimLink extends d3.SimulationLinkDatum<SimNode> {
  edge: StationEdge;
}

// Stable group-centroid index built once per render
function buildGroupCentroids(simNodes: SimNode[]): Map<string, { x: number; y: number }> {
  const acc = new Map<string, { sx: number; sy: number; n: number }>();
  for (const sn of simNodes) {
    const g = sn.node.group;
    const prev = acc.get(g) ?? { sx: 0, sy: 0, n: 0 };
    acc.set(g, { sx: prev.sx + (sn.x ?? 0), sy: prev.sy + (sn.y ?? 0), n: prev.n + 1 });
  }
  const result = new Map<string, { x: number; y: number }>();
  for (const [g, { sx, sy, n }] of acc) {
    result.set(g, { x: sx / n, y: sy / n });
  }
  return result;
}

interface Props {
  gtfs: ParsedGtfs;
}

// Debug info produced by buildStationGraph
interface DebugInfo {
  rawStopCount: number;
  groupCount: number;
  dupRatio: number;
  hasPathways: boolean;
}

const StationGraphView: React.FC<Props> = ({ gtfs }) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const simRef = useRef<d3.Simulation<SimNode, SimLink> | null>(null);

  const [selectedStationId, setSelectedStationId] = useState<string>('');
  const [graph, setGraph] = useState<StationGraph | null>(null);
  const [transferCosts, setTransferCosts] = useState<TransferCost[]>([]);
  const [fromNodeId, setFromNodeId] = useState<string | null>(null);
  const [toNodeId, setToNodeId] = useState<string | null>(null);
  const [debugInfo, setDebugInfo] = useState<DebugInfo | null>(null);

  const candidates = useMemo(() => getStationCandidates(gtfs, 30), [gtfs]);

  useEffect(() => {
    if (candidates.length > 0 && !selectedStationId) {
      setSelectedStationId(candidates[0].stopId);
    }
  }, [candidates, selectedStationId]);

  useEffect(() => {
    if (!selectedStationId) return;

    // Count raw stop_ids before buildStationGraph to produce debug info
    const rawStopIds = new Set<string>([selectedStationId]);
    for (const s of gtfs.stops) {
      if (s.parent_station === selectedStationId) rawStopIds.add(s.stop_id);
    }

    const g = buildStationGraph(gtfs, selectedStationId);
    setGraph(g);
    setFromNodeId(null);
    setToNodeId(null);

    if (g) {
      setTransferCosts(computeTransferCosts(g, gtfs));
      const groupCount = g.nodes.size;
      const rawCount = rawStopIds.size;
      setDebugInfo({
        rawStopCount: rawCount,
        groupCount,
        dupRatio: rawCount > 0 ? Math.round(((rawCount - groupCount) / rawCount) * 100) : 0,
        hasPathways: g.edges.some(e => e.pathwayMode > 0),
      });
    } else {
      setTransferCosts([]);
      setDebugInfo(null);
    }
  }, [selectedStationId, gtfs]);

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

  const selectedTransfer = useMemo<TransferCost | undefined>(() => {
    if (!fromNodeId || !toNodeId) return undefined;
    return getTransferCost(transferCosts, fromNodeId, toNodeId);
  }, [transferCosts, fromNodeId, toNodeId]);

  const selectedJES = useMemo(() => {
    if (!selectedTransfer) return null;
    return computeJES(
      [selectedTransfer.fromStopId, selectedTransfer.toStopId],
      0,
      [selectedTransfer],
      graph?.nodes.get(selectedTransfer.toStopId)?.accessibilityScore === 1 ? 0 : 90,
    );
  }, [selectedTransfer, graph]);

  // --- D3 rendering ---
  useEffect(() => {
    if (!graph || !svgRef.current) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    const width = svgRef.current.clientWidth || 800;
    const height = svgRef.current.clientHeight || 560;

    const defs = svg.append('defs');
    defs.append('marker')
      .attr('id', 'arrow')
      .attr('viewBox', '0 -4 8 8')
      .attr('refX', 14)
      .attr('refY', 0)
      .attr('markerWidth', 6)
      .attr('markerHeight', 6)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-4L8,0L0,4')
      .attr('fill', 'hsl(215, 16%, 55%)');

    const container = svg.append('g').attr('class', 'zoom-container');

    svg.call(
      d3.zoom<SVGSVGElement, unknown>()
        .scaleExtent([0.3, 6])
        .on('zoom', (event) => container.attr('transform', event.transform.toString()))
    );

    // Deduplicate edges for D3 visualization
    const seenEdgeKeys = new Set<string>();
    const simLinks: SimLink[] = [];
    for (const edge of graph.edges) {
      const key = [edge.from, edge.to].sort().join('|||');
      if (seenEdgeKeys.has(key)) continue;
      seenEdgeKeys.add(key);
      simLinks.push({ source: edge.from, target: edge.to, edge });
    }

    const simNodes: SimNode[] = [...graph.nodes.values()].map(node => ({ id: node.nodeId, node }));

    // Assign initial positions in a circle to help the simulation converge faster
    const nodeCount = simNodes.length;
    simNodes.forEach((sn, i) => {
      const angle = (2 * Math.PI * i) / nodeCount;
      sn.x = width / 2 + (Math.min(width, height) * 0.3) * Math.cos(angle);
      sn.y = height / 2 + (Math.min(width, height) * 0.3) * Math.sin(angle);
    });

    // Compute stable group positions (used by cluster force)
    const groupCount = new Map<string, number>();
    for (const sn of simNodes) {
      groupCount.set(sn.node.group, (groupCount.get(sn.node.group) ?? 0) + 1);
    }
    const multiGroupIds = new Set([...groupCount.entries()].filter(([, c]) => c > 1).map(([g]) => g));

    simRef.current = d3.forceSimulation<SimNode, SimLink>(simNodes)
      .force('link', d3.forceLink<SimNode, SimLink>(simLinks)
        .id(d => d.id)
        .distance(d => Math.max(60, d.edge.costSeconds * 0.5))
      )
      .force('charge', d3.forceManyBody().strength(-280))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide(22))
      // Cluster force: pull same-group nodes toward their group centroid
      .force('cluster', () => {
        const centroids = buildGroupCentroids(simNodes);
        for (const sn of simNodes) {
          if (!multiGroupIds.has(sn.node.group)) continue;
          const c = centroids.get(sn.node.group);
          if (!c) continue;
          const alpha = 0.05; // gentle pull
          sn.vx = (sn.vx ?? 0) + (c.x - (sn.x ?? 0)) * alpha;
          sn.vy = (sn.vy ?? 0) + (c.y - (sn.y ?? 0)) * alpha;
        }
      });

    // Edges
    const linkEl = container.append('g').attr('class', 'links')
      .selectAll<SVGLineElement, SimLink>('line')
      .data(simLinks)
      .join('line')
      .attr('stroke', d => {
        if (d.edge.hasSlopeIssue || d.edge.hasWidthIssue) return 'hsl(0, 72%, 51%)';
        return PATHWAY_MODE_COLOR[d.edge.pathwayMode] ?? 'hsl(215, 16%, 55%)';
      })
      .attr('stroke-width', d => Math.max(1, Math.min(5, d.edge.costSeconds / 20)))
      .attr('stroke-opacity', 0.65)
      .attr('marker-end', d => d.edge.isBidirectional ? '' : 'url(#arrow)');

    // Edge cost labels
    const edgeLabelEl = container.append('g').attr('class', 'edge-labels')
      .selectAll<SVGTextElement, SimLink>('text')
      .data(simLinks)
      .join('text')
      .attr('text-anchor', 'middle')
      .attr('font-size', 9)
      .attr('fill', 'hsl(215, 16%, 40%)')
      .attr('pointer-events', 'none')
      .text(d => `${d.edge.costSeconds}s`);

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
            d.fx = d.x; d.fy = d.y;
          })
          .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
          .on('end', (event, d) => {
            if (!event.active) simRef.current?.alphaTarget(0);
            d.fx = null; d.fy = null;
          })
      );

    const nodeRadius = (d: SimNode) => Math.max(7, 16 / (1 + d.node.frictionScore));

    // Friction halo (insert before circle so it renders behind)
    nodeEl.filter(d => d.node.frictionScore > 0.3)
      .append('circle')
      .attr('class', 'friction-halo')
      .attr('r', d => nodeRadius(d) + 6)
      .attr('fill', 'none')
      .attr('stroke', 'hsl(24, 90%, 52%)')
      .attr('stroke-width', 1)
      .attr('stroke-opacity', d => d.node.frictionScore * 0.8)
      .attr('stroke-dasharray', '3 2');

    // Main circle
    nodeEl.append('circle')
      .attr('class', 'main-circle')
      .attr('r', nodeRadius)
      .attr('fill', d => NODE_TYPE_COLOR[d.node.nodeType] ?? 'hsl(215, 16%, 55%)')
      .attr('fill-opacity', 0.88)
      .attr('stroke', 'hsl(var(--background))')
      .attr('stroke-width', 1.5);

    // childCount badge (when >1, shows number of merged stop_ids)
    nodeEl.filter(d => d.node.childCount > 1)
      .append('text')
      .attr('class', 'badge')
      .attr('dy', d => -nodeRadius(d) + 1)
      .attr('dx', d => nodeRadius(d) - 1)
      .attr('text-anchor', 'middle')
      .attr('font-size', 8)
      .attr('font-weight', '700')
      .attr('fill', 'hsl(var(--background))')
      .attr('pointer-events', 'none')
      .text(d => `×${d.node.childCount}`);

    // Label below circle
    nodeEl.append('text')
      .attr('class', 'node-label')
      .attr('dy', d => nodeRadius(d) + 11)
      .attr('text-anchor', 'middle')
      .attr('font-size', 10)
      .attr('font-weight', '500')
      .attr('fill', 'hsl(var(--foreground))')
      .attr('pointer-events', 'none')
      .text(d => {
        const name = d.node.stopName;
        return name.length > 24 ? name.slice(0, 22) + '…' : name;
      });

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
  }, [graph, handleNodeClick]);

  // Selection ring update (no full re-render)
  useEffect(() => {
    if (!svgRef.current) return;
    d3.select(svgRef.current).selectAll<SVGCircleElement, SimNode>('.nodes g .main-circle')
      .attr('stroke', (d: SimNode) => {
        if (d.id === fromNodeId) return 'hsl(234, 90%, 65%)';
        if (d.id === toNodeId) return 'hsl(142, 71%, 45%)';
        return 'hsl(var(--background))';
      })
      .attr('stroke-width', (d: SimNode) => (d.id === fromNodeId || d.id === toNodeId) ? 3.5 : 1.5);
  }, [fromNodeId, toNodeId]);

  const fromNode = graph?.nodes.get(fromNodeId ?? '');
  const toNode = graph?.nodes.get(toNodeId ?? '');
  const jesInfo = selectedJES ? jesLabel(selectedJES.normalizedScore) : null;
  const improvements = selectedJES ? jesImprovementActions(selectedJES) : [];

  const avgFriction = graph
    ? [...graph.nodes.values()].reduce((s, n) => s + n.frictionScore, 0) / Math.max(1, graph.nodes.size)
    : 0;
  const criticalNodes = graph
    ? [...graph.nodes.values()].filter(n => n.frictionScore > 0.4).length
    : 0;

  return (
    <div className="flex gap-4 h-[640px]">
      {/* Graph panel */}
      <div className="flex-1 flex flex-col gap-3 min-w-0">
        {/* Station selector */}
        <div className="flex items-center gap-3">
          <label className="text-xs font-medium text-muted-foreground whitespace-nowrap">Station :</label>
          <select
            value={selectedStationId}
            onChange={e => setSelectedStationId(e.target.value)}
            className="flex-1 h-8 text-xs rounded-md border border-border bg-background px-2 focus:outline-none focus:ring-1 focus:ring-primary"
          >
            {candidates.map(c => (
              <option key={c.stopId} value={c.stopId}>
                {c.stopName} ({c.childCount} arrêt{c.childCount > 1 ? 's' : ''})
              </option>
            ))}
          </select>
        </div>

        {/* D3 canvas */}
        <div className="relative flex-1 rounded-md border border-border bg-card overflow-hidden">
          <svg ref={svgRef} className="w-full h-full" />
          {(!graph || graph.nodes.size === 0) && (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
              Aucun graphe disponible pour cette station.
            </div>
          )}
          {graph && graph.nodes.size > 0 && (
            <div className="absolute bottom-2 left-2 text-[10px] text-muted-foreground bg-background/80 px-2 py-1 rounded">
              Cliquer un nœud = départ · cliquer un second = destination
            </div>
          )}
        </div>

        {/* Legend */}
        <div className="flex flex-wrap gap-3 text-[10px] text-muted-foreground">
          {Object.entries(NODE_TYPE_COLOR).map(([type, color]) => (
            <span key={type} className="flex items-center gap-1">
              <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }} />
              {type === 'stop' ? 'Arrêt' : type === 'station' ? 'Station' : type === 'entrance' ? 'Entrée' : type === 'generic_node' ? 'Nœud' : 'Quai'}
            </span>
          ))}
          <span className="flex items-center gap-1 ml-2">
            <span className="inline-block w-4 border-t-2 border-dashed border-orange-400" />
            Friction élevée
          </span>
          <span className="flex items-center gap-1 ml-2">
            <span className="inline-block text-[9px] font-bold text-background bg-blue-500 rounded px-0.5">×N</span>
            Stop_ids fusionnés
          </span>
        </div>
      </div>

      {/* Sidebar */}
      <div className="w-72 flex flex-col gap-3 overflow-y-auto">

        {/* Debug panel */}
        {debugInfo && (
          <div className="rounded-md border border-border bg-secondary/20 p-3">
            <div className="text-[10px] font-semibold text-muted-foreground mb-2 uppercase tracking-wide">Diagnostic graphe</div>
            <div className="grid grid-cols-2 gap-1.5 text-[10px]">
              <div className="flex justify-between col-span-2">
                <span className="text-muted-foreground">Stop_ids bruts</span>
                <span className="font-mono font-medium">{debugInfo.rawStopCount}</span>
              </div>
              <div className="flex justify-between col-span-2">
                <span className="text-muted-foreground">Nœuds logiques</span>
                <span className="font-mono font-medium">{debugInfo.groupCount}</span>
              </div>
              <div className="flex justify-between col-span-2">
                <span className="text-muted-foreground">Ratio déduplication</span>
                <span className={`font-mono font-medium ${debugInfo.dupRatio > 50 ? 'text-amber-500' : 'text-green-500'}`}>
                  {debugInfo.dupRatio}%
                </span>
              </div>
              <div className="flex justify-between col-span-2">
                <span className="text-muted-foreground">Source</span>
                <span className={`font-medium ${debugInfo.hasPathways ? 'text-green-500' : 'text-amber-500'}`}>
                  {debugInfo.hasPathways ? 'pathways.txt' : 'fallback géo/transfers'}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Station stats */}
        {graph && (
          <div className="rounded-md border border-border bg-card p-4">
            <h3 className="text-xs font-semibold mb-3 text-foreground">{graph.stationName}</h3>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="bg-secondary/40 rounded p-2">
                <div className="text-muted-foreground">Nœuds</div>
                <div className="font-medium text-lg">{graph.nodes.size}</div>
              </div>
              <div className="bg-secondary/40 rounded p-2">
                <div className="text-muted-foreground">Arcs</div>
                <div className="font-medium text-lg">{graph.edges.length}</div>
              </div>
              <div className="bg-secondary/40 rounded p-2">
                <div className="text-muted-foreground">Friction moy.</div>
                <div className={`font-medium text-lg ${avgFriction > 0.4 ? 'text-destructive' : avgFriction > 0.2 ? 'text-amber-500' : 'text-green-500'}`}>
                  {(avgFriction * 100).toFixed(0)}%
                </div>
              </div>
              <div className="bg-secondary/40 rounded p-2">
                <div className="text-muted-foreground">Nœuds critiques</div>
                <div className={`font-medium text-lg ${criticalNodes > 0 ? 'text-destructive' : 'text-green-500'}`}>
                  {criticalNodes}
                </div>
              </div>
            </div>

            {graph.edges.length > 0 && (
              <div className="mt-3 pt-3 border-t border-border">
                <div className="text-[10px] text-muted-foreground mb-2">Types de parcours</div>
                {[...new Set(graph.edges.map(e => e.pathwayMode))].sort().map(mode => {
                  const count = graph.edges.filter(e => e.pathwayMode === mode).length;
                  return (
                    <div key={mode} className="flex items-center gap-2 text-[10px] mb-1">
                      <span className="w-2.5 h-2.5 rounded-sm inline-block flex-shrink-0"
                        style={{ backgroundColor: PATHWAY_MODE_COLOR[mode] ?? '#888' }} />
                      <span className="flex-1">{PATHWAY_MODE_LABEL[mode] ?? `Mode ${mode}`}</span>
                      <span className="text-muted-foreground">{count}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Transfer cost + JES panel */}
        {fromNode && (
          <div className="rounded-md border border-border bg-card p-4">
            <h3 className="text-xs font-semibold mb-3 text-foreground">Analyse de correspondance</h3>
            <div className="text-[10px] space-y-2">
              <div className="flex items-start gap-2">
                <span className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0 mt-0.5" />
                <div>
                  <span className="font-medium">Départ : </span>
                  <span className="text-muted-foreground">{fromNode.stopName}</span>
                  {fromNode.childCount > 1 && (
                    <span className="ml-1 text-muted-foreground/60">(×{fromNode.childCount} arrêts)</span>
                  )}
                </div>
              </div>
              {toNode ? (
                <div className="flex items-start gap-2">
                  <span className="w-2 h-2 rounded-full bg-green-500 flex-shrink-0 mt-0.5" />
                  <div>
                    <span className="font-medium">Arrivée : </span>
                    <span className="text-muted-foreground">{toNode.stopName}</span>
                    {toNode.childCount > 1 && (
                      <span className="ml-1 text-muted-foreground/60">(×{toNode.childCount} arrêts)</span>
                    )}
                  </div>
                </div>
              ) : (
                <div className="text-muted-foreground italic">Cliquer un nœud destination…</div>
              )}
            </div>

            {selectedTransfer && selectedJES && jesInfo && (
              <div className="mt-3 space-y-3">
                <div className="bg-secondary/40 rounded p-3 space-y-1.5 text-[10px]">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Marche</span>
                    <span className="font-medium">{selectedTransfer.walkSeconds}s</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Attente estimée</span>
                    <span className="font-medium">{selectedTransfer.waitSeconds}s</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Pénalité friction</span>
                    <span className={`font-medium ${selectedTransfer.frictionPenalty > 30 ? 'text-amber-500' : ''}`}>
                      +{selectedTransfer.frictionPenalty}s
                    </span>
                  </div>
                  <div className="flex justify-between border-t border-border pt-1.5 mt-1.5">
                    <span className="font-medium">Total perçu</span>
                    <span className="font-semibold">
                      {selectedTransfer.totalCostSeconds}s ({Math.round(selectedTransfer.totalCostSeconds / 60)}min)
                    </span>
                  </div>
                </div>

                <div className="rounded p-3" style={{ backgroundColor: `${jesInfo.color}20`, border: `1px solid ${jesInfo.color}40` }}>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[10px] font-semibold">Score JES</span>
                    <span className="text-sm font-bold" style={{ color: jesInfo.color }}>
                      {Math.round(selectedJES.normalizedScore)}/100
                    </span>
                  </div>
                  <div className="w-full h-1.5 rounded-full bg-secondary/60 overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{ width: `${selectedJES.normalizedScore}%`, backgroundColor: jesInfo.color }}
                    />
                  </div>
                  <div className="text-[10px] mt-1.5 font-medium" style={{ color: jesInfo.color }}>
                    {jesInfo.label}
                  </div>
                </div>

                {improvements.length > 0 && (
                  <div>
                    <div className="text-[10px] font-semibold mb-1.5 text-foreground">Recommandations</div>
                    <ul className="space-y-1">
                      {improvements.map((action, i) => (
                        <li key={i} className="text-[10px] text-muted-foreground flex gap-1.5">
                          <span className="text-amber-500 flex-shrink-0">›</span>
                          {action}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {fromNodeId && toNodeId && !selectedTransfer && (
              <div className="mt-3 text-[10px] text-destructive">
                Aucun chemin trouvé entre ces deux nœuds.
              </div>
            )}
          </div>
        )}

        {/* Transfer costs table */}
        {transferCosts.length > 0 && (
          <div className="rounded-md border border-border bg-card p-4">
            <h3 className="text-xs font-semibold mb-3 text-foreground">
              Correspondances ({transferCosts.length})
            </h3>
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {transferCosts.slice(0, 20).map((c, i) => {
                const jes = computeJES([c.fromStopId, c.toStopId], 0, [c]);
                const label = jesLabel(jes.normalizedScore);
                const isSelected = c.fromStopId === fromNodeId && c.toStopId === toNodeId;
                return (
                  <button
                    key={i}
                    onClick={() => { setFromNodeId(c.fromStopId); setToNodeId(c.toStopId); }}
                    className={`w-full text-left rounded px-2 py-1.5 text-[10px] transition-colors ${
                      isSelected ? 'bg-primary/10 ring-1 ring-primary/30' : 'hover:bg-secondary/50'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-muted-foreground flex-1">
                        {graph?.nodes.get(c.fromStopId)?.stopName ?? c.fromStopId}
                        {' → '}
                        {graph?.nodes.get(c.toStopId)?.stopName ?? c.toStopId}
                      </span>
                      <span className="flex-shrink-0 font-medium" style={{ color: label.color }}>
                        {Math.round(jes.normalizedScore)}
                      </span>
                    </div>
                    <div className="text-muted-foreground/70 mt-0.5">
                      {c.walkSeconds}s marche · {c.waitSeconds}s attente
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {graph && graph.nodes.size <= 1 && (
          <div className="rounded-md border border-border bg-card p-4 text-xs text-muted-foreground">
            <p className="font-medium mb-1">Données intra-station insuffisantes</p>
            <p>
              Ce GTFS ne contient pas de <code>pathways.txt</code> ni de <code>transfers.txt</code> pour
              cette station. Le graphe ne peut pas être construit.
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default StationGraphView;
