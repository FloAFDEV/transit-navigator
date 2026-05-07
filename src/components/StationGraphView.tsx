/**
 * StationGraphView — intra-station graph visualization with JES panel.
 *
 * Rendering:
 *   - D3 force layout, zoom/pan
 *   - Node size ∝ 1/(1+frictionScore)  → larger = more fluid
 *   - Node color = nodeType
 *   - Edge stroke-width ∝ costSeconds  → thicker = slower
 *   - Edge color = pathway mode
 *   - Click node A then node B → shows TransferCost + JES in sidebar
 */
import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import * as d3 from 'd3';
import type { ParsedGtfs, StationGraph, StationNode, StationEdge, TransferCost } from '@/lib/gtfs-types';
import { buildStationGraph, getStationCandidates, dijkstraStation } from '@/lib/station-graph';
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
  0: 'hsl(215, 16%, 55%)',  // logical transfer
  1: 'hsl(215, 16%, 70%)',  // walkway
  2: 'hsl(24, 90%, 52%)',   // stairs
  3: 'hsl(215, 16%, 70%)',  // moving walkway
  4: 'hsl(38, 92%, 50%)',   // escalator
  5: 'hsl(280, 60%, 55%)',  // elevator
  6: 'hsl(0, 72%, 51%)',    // fare gate
  7: 'hsl(0, 72%, 51%)',    // exit gate
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

interface Props {
  gtfs: ParsedGtfs;
}

const StationGraphView: React.FC<Props> = ({ gtfs }) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const simRef = useRef<d3.Simulation<SimNode, SimLink> | null>(null);

  const [selectedStationId, setSelectedStationId] = useState<string>('');
  const [graph, setGraph] = useState<StationGraph | null>(null);
  const [transferCosts, setTransferCosts] = useState<TransferCost[]>([]);
  const [fromNodeId, setFromNodeId] = useState<string | null>(null);
  const [toNodeId, setToNodeId] = useState<string | null>(null);

  // Station candidates list
  const candidates = useMemo(() => getStationCandidates(gtfs, 30), [gtfs]);

  // Auto-select first candidate
  useEffect(() => {
    if (candidates.length > 0 && !selectedStationId) {
      setSelectedStationId(candidates[0].stopId);
    }
  }, [candidates, selectedStationId]);

  // Build graph + transfer costs when station changes
  useEffect(() => {
    if (!selectedStationId) return;
    const g = buildStationGraph(gtfs, selectedStationId);
    setGraph(g);
    setFromNodeId(null);
    setToNodeId(null);
    if (g) {
      setTransferCosts(computeTransferCosts(g, gtfs));
    } else {
      setTransferCosts([]);
    }
  }, [selectedStationId, gtfs]);

  // Handle node click: first click = from, second = to, third = reset
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

  // Derive the selected transfer cost + JES
  const selectedTransfer = useMemo<TransferCost | undefined>(() => {
    if (!fromNodeId || !toNodeId) return undefined;
    return getTransferCost(transferCosts, fromNodeId, toNodeId);
  }, [transferCosts, fromNodeId, toNodeId]);

  const selectedJES = useMemo(() => {
    if (!selectedTransfer) return null;
    return computeJES(
      [selectedTransfer.fromStopId, selectedTransfer.toStopId],
      0, // walk only — no in-vehicle time for intra-station
      [selectedTransfer],
      graph?.nodes.get(selectedTransfer.toStopId)?.accessibilityScore === 1 ? 0 : 90,
    );
  }, [selectedTransfer, graph]);

  // D3 rendering
  useEffect(() => {
    if (!graph || !svgRef.current) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    const width = svgRef.current.clientWidth || 800;
    const height = svgRef.current.clientHeight || 560;

    const defs = svg.append('defs');
    // Arrow marker for directed edges
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
        .scaleExtent([0.3, 5])
        .on('zoom', (event) => container.attr('transform', event.transform.toString()))
    );

    // Deduplicate edges for D3 (show one visual per physical pathway)
    const seenEdgeKeys = new Set<string>();
    const simLinks: SimLink[] = [];
    for (const edge of graph.edges) {
      const key = [edge.from, edge.to].sort().join('|||');
      if (seenEdgeKeys.has(key)) continue;
      seenEdgeKeys.add(key);
      simLinks.push({ source: edge.from, target: edge.to, edge });
    }

    const simNodes: SimNode[] = [...graph.nodes.values()].map(node => ({ id: node.nodeId, node }));
    const nodeById = new Map(simNodes.map(n => [n.id, n]));

    // Force simulation
    simRef.current = d3.forceSimulation<SimNode, SimLink>(simNodes)
      .force('link', d3.forceLink<SimNode, SimLink>(simLinks)
        .id(d => d.id)
        .distance(d => Math.max(60, d.edge.costSeconds * 0.5))
      )
      .force('charge', d3.forceManyBody().strength(-250))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide(20));

    // Edge lines
    const linkGroup = container.append('g').attr('class', 'links');
    const linkEl = linkGroup.selectAll<SVGLineElement, SimLink>('line')
      .data(simLinks)
      .join('line')
      .attr('stroke', d => {
        if (d.edge.hasSlopeIssue || d.edge.hasWidthIssue) return 'hsl(0, 72%, 51%)';
        return PATHWAY_MODE_COLOR[d.edge.pathwayMode] ?? 'hsl(215, 16%, 55%)';
      })
      .attr('stroke-width', d => Math.max(1, Math.min(5, d.edge.costSeconds / 20)))
      .attr('stroke-opacity', 0.7)
      .attr('marker-end', d => d.edge.isBidirectional ? '' : 'url(#arrow)');

    // Edge labels (cost)
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
    const nodeGroup = container.append('g').attr('class', 'nodes');
    const nodeEl = nodeGroup.selectAll<SVGGElement, SimNode>('g')
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

    // Node circles
    nodeEl.append('circle')
      .attr('r', d => Math.max(6, 16 / (1 + d.node.frictionScore)))
      .attr('fill', d => NODE_TYPE_COLOR[d.node.nodeType] ?? 'hsl(215, 16%, 55%)')
      .attr('fill-opacity', 0.85)
      .attr('stroke', 'hsl(var(--background))')
      .attr('stroke-width', 1.5);

    // Node labels
    nodeEl.append('text')
      .attr('dy', d => Math.max(6, 16 / (1 + d.node.frictionScore)) + 11)
      .attr('text-anchor', 'middle')
      .attr('font-size', 10)
      .attr('font-weight', '500')
      .attr('fill', 'hsl(var(--foreground))')
      .attr('pointer-events', 'none')
      .text(d => d.node.stopName.length > 22 ? d.node.stopName.slice(0, 20) + '…' : d.node.stopName);

    // Friction halo for high-friction nodes
    nodeEl.filter(d => d.node.frictionScore > 0.3)
      .insert('circle', 'circle')
      .attr('r', d => Math.max(6, 16 / (1 + d.node.frictionScore)) + 5)
      .attr('fill', 'none')
      .attr('stroke', 'hsl(24, 90%, 52%)')
      .attr('stroke-width', 1)
      .attr('stroke-opacity', d => d.node.frictionScore * 0.8)
      .attr('stroke-dasharray', '3 2');

    nodeEl.on('click', (event, d) => {
      event.stopPropagation();
      handleNodeClick(d.id);
    });

    // Tick
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

  // Update selection rings without re-rendering the whole graph
  useEffect(() => {
    if (!svgRef.current) return;
    d3.select(svgRef.current).selectAll<SVGCircleElement, SimNode>('.nodes g circle:first-of-type')
      .attr('stroke', (d: SimNode) => {
        if (d.id === fromNodeId) return 'hsl(234, 90%, 65%)';
        if (d.id === toNodeId) return 'hsl(142, 71%, 45%)';
        return 'hsl(var(--background))';
      })
      .attr('stroke-width', (d: SimNode) => (d.id === fromNodeId || d.id === toNodeId) ? 3 : 1.5);
  }, [fromNodeId, toNodeId]);

  const fromNode = graph?.nodes.get(fromNodeId ?? '');
  const toNode = graph?.nodes.get(toNodeId ?? '');
  const jesInfo = selectedJES ? jesLabel(selectedJES.normalizedScore) : null;
  const improvements = selectedJES ? jesImprovementActions(selectedJES) : [];

  // Station stats
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
                {c.stopName} ({c.childCount} nœud{c.childCount > 1 ? 's' : ''})
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
        </div>
      </div>

      {/* Sidebar */}
      <div className="w-72 flex flex-col gap-4 overflow-y-auto">
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

            {/* Pathway mode legend */}
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
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0" />
                <span className="font-medium">Départ :</span>
                <span className="text-muted-foreground truncate">{fromNode.stopName}</span>
              </div>
              {toNode ? (
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-green-500 flex-shrink-0" />
                  <span className="font-medium">Arrivée :</span>
                  <span className="text-muted-foreground truncate">{toNode.stopName}</span>
                </div>
              ) : (
                <div className="text-muted-foreground italic">Cliquer un nœud destination…</div>
              )}
            </div>

            {selectedTransfer && selectedJES && jesInfo && (
              <div className="mt-3 space-y-3">
                {/* Cost breakdown */}
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
                    <span className="font-semibold">{selectedTransfer.totalCostSeconds}s ({Math.round(selectedTransfer.totalCostSeconds / 60)}min)</span>
                  </div>
                </div>

                {/* JES score */}
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

                {/* Improvement actions */}
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
            <div className="space-y-1 max-h-52 overflow-y-auto">
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

        {/* No graph fallback */}
        {graph && graph.nodes.size <= 1 && (
          <div className="rounded-md border border-border bg-card p-4 text-xs text-muted-foreground">
            <p className="font-medium mb-1">Données intra-station insuffisantes</p>
            <p>Ce GTFS ne contient pas de <code>pathways.txt</code> ni de <code>transfers.txt</code> pour cette station. Le graphe ne peut pas être construit.</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default StationGraphView;
