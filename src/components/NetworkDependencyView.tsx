import React, { useEffect, useRef, useMemo, useState, useCallback } from 'react';
import * as d3 from 'd3';
import type { AnalysisResult } from '@/lib/network-analysis';
import type { ParsedGtfs } from '@/lib/gtfs-types';
import { modeColors, modeLabels } from '@/lib/gtfs-types';
import { buildNetworkGraph, type GraphNode, type GraphEdge, type NetworkGraph } from '@/lib/network-graph';
import { ZoomIn, ZoomOut, RotateCcw } from 'lucide-react';

interface Props {
  analysis: AnalysisResult;
  gtfs: ParsedGtfs;
  selectedStopId?: string | null;
  onSelectStop?: (id: string) => void;
}

// ─── Visual encoding per view ─────────────────────────────────────────────────

type ViewMode = 'structure' | 'intelligence' | 'opportunities';

const TIER_COLORS = {
  hub:        '#ef4444',
  secondary:  '#f97316',
  peripheral: '#64748b',
  isolated:   '#3b82f6',
} as const;

function nodeColor(node: GraphNode, view: ViewMode): string {
  switch (view) {
    case 'structure':
      return modeColors[node.modes[0] ?? 'bus'];
    case 'intelligence':
      // cold (blue) → warm (yellow) → hot (red) based on hubScore
      return d3.interpolateRdYlBu(1 - node.hubScore);
    case 'opportunities':
      return TIER_COLORS[node.tier];
  }
}

function nodeRadius(node: GraphNode, view: ViewMode): number {
  switch (view) {
    case 'structure':
      return Math.max(3, Math.sqrt(node.routeCount) * 3.2);
    case 'intelligence':
      return Math.max(3, node.betweenness * 16 + 3);
    case 'opportunities':
      return Math.max(3, node.attractivityScore * 13 + 3);
  }
}

function edgeOpacity(weight: number, maxWeight: number, view: ViewMode): number {
  const base = weight / maxWeight;
  return view === 'structure' ? base * 0.45 + 0.10 : base * 0.30 + 0.08;
}

function edgeWidth(weight: number, view: ViewMode): number {
  const w = Math.max(0.5, Math.min(4, weight * 0.8));
  return view === 'intelligence' ? w * 1.2 : w;
}

// ─── Sidebar content ──────────────────────────────────────────────────────────

const ScoreBar: React.FC<{ label: string; value: number; color: string }> = ({ label, value, color }) => (
  <div className="flex flex-col gap-1">
    <div className="flex justify-between text-[10px] font-mono text-muted-foreground">
      <span>{label}</span>
      <span style={{ color }}>{(value * 100).toFixed(0)}</span>
    </div>
    <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
      <div className="h-full rounded-full transition-all duration-500" style={{ width: `${value * 100}%`, background: color }} />
    </div>
  </div>
);

const NodePanel: React.FC<{ node: GraphNode; view: ViewMode }> = ({ node, view }) => (
  <div className="flex flex-col gap-3 p-3 rounded-lg border border-border bg-card text-xs">
    <div>
      <div className="font-semibold text-foreground text-sm leading-tight">{node.name}</div>
      <div className="text-muted-foreground mt-0.5">
        {node.routeCount} ligne{node.routeCount > 1 ? 's' : ''} ·{' '}
        {node.modes.map(m => modeLabels[m]).join(', ')}
      </div>
    </div>

    {view === 'structure' && (
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono">
        <span className="text-muted-foreground">Degré</span>
        <span className="text-right">{node.degree}</span>
        <span className="text-muted-foreground">Corr.</span>
        <span className="text-right">{node.correspondences}</span>
        <span className="text-muted-foreground">Modes</span>
        <span className="text-right">{node.modes.length}</span>
      </div>
    )}

    {view === 'intelligence' && (
      <div className="flex flex-col gap-2">
        <ScoreBar label="Hub"           value={node.hubScore}          color="#ef4444" />
        <ScoreBar label="Centralité"    value={node.betweenness}       color="#f97316" />
        <ScoreBar label="Vulnérabilité" value={node.vulnerabilityScore}color="#eab308" />
        <ScoreBar label="Friction"      value={node.frictionScore}     color="#a855f7" />
        {node.isArticulation && (
          <div className="mt-1 px-2 py-1 rounded bg-red-500/10 text-red-400 text-[10px] font-mono">
            ⚠ Point de rupture réseau
          </div>
        )}
      </div>
    )}

    {view === 'opportunities' && (
      <div className="flex flex-col gap-2">
        <ScoreBar label="Attractivité"  value={node.attractivityScore} color="#22c55e" />
        <ScoreBar label="Hub score"     value={node.hubScore}          color="#f97316" />
        <ScoreBar label="Vulnérabilité" value={node.vulnerabilityScore}color="#ef4444" />
        <div className="mt-1 px-2 py-1 rounded text-[10px] font-mono"
          style={{ background: `${TIER_COLORS[node.tier]}18`, color: TIER_COLORS[node.tier] }}>
          {node.tier === 'hub' && '🔴 Hub établi — nœud critique'}
          {node.tier === 'secondary' && '🟠 Secondaire — potentiel de croissance'}
          {node.tier === 'peripheral' && '⚫ Périphérique — couverture faible'}
          {node.tier === 'isolated' && '🔵 Isolé — zone d\'opportunité'}
        </div>
      </div>
    )}
  </div>
);

// ─── Global stats bar ─────────────────────────────────────────────────────────

const StatsBar: React.FC<{ graph: NetworkGraph; view: ViewMode }> = ({ graph, view }) => {
  const { stats } = graph;
  const items =
    view === 'structure' ? [
      { label: 'Stations',   value: graph.nodes.length.toString() },
      { label: 'Liaisons',   value: graph.edges.length.toString() },
      { label: 'Deg. moyen', value: stats.avgDegree.toFixed(1) },
      { label: 'Densité',    value: (stats.density * 100).toFixed(1) + '%' },
    ] :
    view === 'intelligence' ? [
      { label: 'Hubs (top tier)',       value: stats.hubCount.toString() },
      { label: 'Points de rupture',     value: stats.articulationCount.toString() },
      { label: 'Deg. max',              value: stats.maxDegree.toString() },
      { label: 'Secondaires',           value: stats.secondaryCount.toString() },
    ] :
    [
      { label: 'Hubs critiques',        value: stats.hubCount.toString() },
      { label: 'Zones périph.',         value: stats.peripheralCount.toString() },
      { label: 'Zones isolées',         value: stats.isolatedCount.toString() },
      { label: 'Points de rupture',     value: stats.articulationCount.toString() },
    ];

  return (
    <div className="flex gap-6 px-4 py-2 rounded-lg border border-border bg-card text-xs font-mono">
      {items.map(item => (
        <div key={item.label} className="flex flex-col items-center gap-0.5">
          <span className="text-foreground font-semibold text-sm">{item.value}</span>
          <span className="text-muted-foreground text-[10px]">{item.label}</span>
        </div>
      ))}
    </div>
  );
};

// ─── Component ────────────────────────────────────────────────────────────────

const SIZE = 720;

const NetworkDependencyView: React.FC<Props> = ({ analysis, gtfs, selectedStopId, onSelectStop }) => {
  const [view, setView] = useState<ViewMode>('structure');
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);

  const svgRef    = useRef<SVGSVGElement>(null);
  const zoomRef   = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const tooltipRef= useRef<HTMLDivElement>(null);
  const viewRef   = useRef<ViewMode>('structure');
  const simRef    = useRef<d3.Simulation<GraphNode, GraphEdge> | null>(null);

  // Keep refs in sync to avoid stale closures in D3 handlers
  useEffect(() => { viewRef.current = view; }, [view]);

  const graph = useMemo(() => buildNetworkGraph(gtfs, analysis), [gtfs, analysis]);
  const maxWeight = useMemo(() => Math.max(...graph.edges.map(e => e.weight), 1), [graph]);

  // ── Initial D3 setup ────────────────────────────────────────────────────────

  useEffect(() => {
    if (!svgRef.current || graph.nodes.length === 0) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll('g.ndv').remove();
    const g = svg.append('g').attr('class', 'ndv');

    // Clone nodes/edges so D3 can mutate them
    const nodes = graph.nodes.map(n => ({ ...n }));
    const edges = graph.edges.map(e => ({ ...e, source: e.sourceId, target: e.targetId }));

    // Force simulation
    const sim = d3.forceSimulation<GraphNode>(nodes)
      .force('link', d3.forceLink<GraphNode, GraphEdge>(edges as any)
        .id((d: any) => d.id)
        .distance((d: any) => 50 + (d.weight ?? 1) * 8)
        .strength(0.4))
      .force('charge', d3.forceManyBody<GraphNode>().strength(-120))
      .force('center',  d3.forceCenter(SIZE / 2, SIZE / 2))
      .force('collide', d3.forceCollide<GraphNode>().radius((d: any) => nodeRadius(d, viewRef.current) + 3));
    simRef.current = sim;

    // Links
    const link = g.selectAll<SVGLineElement, GraphEdge>('line.ndv-link')
      .data(edges)
      .enter().append('line')
      .attr('class', 'ndv-link')
      .attr('stroke', '#475569')
      .attr('stroke-opacity', (d: any) => edgeOpacity(d.weight, maxWeight, viewRef.current))
      .attr('stroke-width',   (d: any) => edgeWidth(d.weight, viewRef.current));

    // Articulation point rings (drawn behind nodes)
    const apRing = g.selectAll<SVGCircleElement, GraphNode>('circle.ndv-ap')
      .data(nodes.filter(n => n.isArticulation))
      .enter().append('circle')
      .attr('class', 'ndv-ap')
      .attr('fill', 'none')
      .attr('stroke', '#fbbf24')
      .attr('stroke-width', 2)
      .attr('stroke-dasharray', '4 2')
      .attr('pointer-events', 'none');

    // Nodes
    const node = g.selectAll<SVGCircleElement, GraphNode>('circle.ndv-node')
      .data(nodes)
      .enter().append('circle')
      .attr('class', 'ndv-node')
      .attr('data-id', d => d.id)
      .attr('r',      d => nodeRadius(d, viewRef.current))
      .attr('fill',   d => nodeColor(d, viewRef.current))
      .attr('stroke', '#0f172a')
      .attr('stroke-width', 1)
      .attr('cursor', 'pointer')
      .on('click', (_ev: any, d: any) => {
        setSelectedNode(d);
        onSelectStop?.(d.id);
      })
      .on('mouseenter', function (ev: any, d: any) {
        d3.select(this).attr('stroke', '#ffffff').attr('stroke-width', 2.5);
        if (tooltipRef.current) {
          const tt = tooltipRef.current;
          tt.style.opacity = '1';
          tt.style.left = `${ev.offsetX + 14}px`;
          tt.style.top  = `${ev.offsetY - 10}px`;
          const score =
            viewRef.current === 'structure'     ? `Degré ${d.degree}` :
            viewRef.current === 'intelligence'  ? `Hub ${(d.hubScore * 100).toFixed(0)} · Vuln. ${(d.vulnerabilityScore * 100).toFixed(0)}` :
                                                  `Attract. ${(d.attractivityScore * 100).toFixed(0)}`;
          tt.innerHTML = `<strong>${d.name}</strong><br/><span style="opacity:.7">${d.routeCount} lignes · ${score}</span>`;
        }
      })
      .on('mouseleave', function () {
        const el  = d3.select<SVGCircleElement, GraphNode>(this as SVGCircleElement);
        const dat = el.datum();
        const isSel = selectedStopId === dat.id;
        el.attr('stroke', isSel ? '#6366f1' : '#0f172a').attr('stroke-width', isSel ? 2.5 : 1);
        if (tooltipRef.current) tooltipRef.current.style.opacity = '0';
      });

    // Labels (only for hubs)
    const label = g.selectAll<SVGTextElement, GraphNode>('text.ndv-label')
      .data(nodes.filter(n => n.tier === 'hub' || n.routeCount >= 4))
      .enter().append('text')
      .attr('class', 'ndv-label')
      .attr('font-size', '7px')
      .attr('font-family', 'IBM Plex Mono, monospace')
      .attr('fill', '#94a3b8')
      .attr('text-anchor', 'middle')
      .attr('dy', d => -(nodeRadius(d, viewRef.current) + 5))
      .attr('pointer-events', 'none')
      .text(d => d.name.length > 22 ? d.name.slice(0, 20) + '…' : d.name);

    // Tick
    sim.on('tick', () => {
      link
        .attr('x1', (d: any) => (d.source as GraphNode).x ?? 0)
        .attr('y1', (d: any) => (d.source as GraphNode).y ?? 0)
        .attr('x2', (d: any) => (d.target as GraphNode).x ?? 0)
        .attr('y2', (d: any) => (d.target as GraphNode).y ?? 0);
      apRing
        .attr('cx', (d: any) => d.x ?? 0)
        .attr('cy', (d: any) => d.y ?? 0)
        .attr('r',  (d: any) => nodeRadius(d, viewRef.current) + 5);
      node
        .attr('cx', (d: any) => d.x ?? 0)
        .attr('cy', (d: any) => d.y ?? 0);
      label
        .attr('x', (d: any) => d.x ?? 0)
        .attr('y', (d: any) => d.y ?? 0);
    });

    // Drag
    const drag = d3.drag<SVGCircleElement, GraphNode>()
      .on('start', (ev, d) => { if (!ev.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag',  (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
      .on('end',   (ev, d) => { if (!ev.active) sim.alphaTarget(0); d.fx = null; d.fy = null; });
    node.call(drag as any);

    // Zoom
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 10])
      .on('zoom', ev => g.attr('transform', ev.transform.toString()));
    svg.call(zoom);
    zoomRef.current = zoom;

    return () => { sim.stop(); svg.on('.zoom', null); };
  }, [graph, maxWeight, onSelectStop]);

  // ── Re-style when view changes (no re-simulation) ──────────────────────────

  useEffect(() => {
    if (!svgRef.current) return;
    const svg = d3.select(svgRef.current);

    svg.selectAll<SVGCircleElement, GraphNode>('circle.ndv-node')
      .transition().duration(380)
      .attr('r',    d => nodeRadius(d, view))
      .attr('fill', d => nodeColor(d, view));

    svg.selectAll<SVGTextElement, GraphNode>('text.ndv-label')
      .attr('dy', d => -(nodeRadius(d, view) + 5));

    svg.selectAll<SVGCircleElement, GraphNode>('circle.ndv-ap')
      .attr('display', view === 'intelligence' ? 'block' : 'none');

    svg.selectAll<SVGLineElement, GraphEdge>('line.ndv-link')
      .transition().duration(280)
      .attr('stroke-opacity', (d: any) => edgeOpacity(d.weight, maxWeight, view))
      .attr('stroke-width',   (d: any) => edgeWidth(d.weight, view));
  }, [view, maxWeight]);

  // ── Highlight selected stop ───────────────────────────────────────────────

  useEffect(() => {
    if (!svgRef.current) return;
    d3.select(svgRef.current)
      .selectAll<SVGCircleElement, GraphNode>('circle.ndv-node')
      .attr('stroke',       d => d.id === selectedStopId ? '#6366f1' : '#0f172a')
      .attr('stroke-width', d => d.id === selectedStopId ? 2.5 : 1);
  }, [selectedStopId]);

  // ── Zoom controls ─────────────────────────────────────────────────────────

  const zoomIn  = useCallback(() => {
    if (svgRef.current && zoomRef.current) d3.select(svgRef.current).transition().duration(280).call(zoomRef.current.scaleBy, 1.5);
  }, []);
  const zoomOut = useCallback(() => {
    if (svgRef.current && zoomRef.current) d3.select(svgRef.current).transition().duration(280).call(zoomRef.current.scaleBy, 0.67);
  }, []);
  const reset   = useCallback(() => {
    if (svgRef.current && zoomRef.current) d3.select(svgRef.current).transition().duration(380).call(zoomRef.current.transform, d3.zoomIdentity);
  }, []);

  // ─── View metadata ─────────────────────────────────────────────────────────

  const VIEW_META: Record<ViewMode, { label: string; subtitle: string; color: string }> = {
    structure: {
      label: '① Structure brute',
      subtitle: 'Topologie · modes de transport · distribution des liaisons',
      color: '#3b82f6',
    },
    intelligence: {
      label: '② Analyse réseau',
      subtitle: 'Centralité · hubs · points de rupture · friction',
      color: '#f59e0b',
    },
    opportunities: {
      label: '③ Opportunités',
      subtitle: 'Zones faibles · hubs critiques · scoring attractivité',
      color: '#22c55e',
    },
  };

  return (
    <div className="flex flex-col gap-5">

      {/* ── View selector ─────────────────────────────────────────────────── */}
      <div className="flex gap-2">
        {(Object.keys(VIEW_META) as ViewMode[]).map(v => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={`flex-1 text-left px-4 py-3 rounded-lg border transition-all text-xs ${
              view === v
                ? 'border-transparent text-foreground font-semibold'
                : 'border-border text-muted-foreground hover:border-border/80 hover:text-foreground'
            }`}
            style={view === v ? { background: `${VIEW_META[v].color}18`, borderColor: VIEW_META[v].color } : {}}
          >
            <div className="font-medium text-sm mb-0.5">{VIEW_META[v].label}</div>
            <div className="opacity-70 text-[10px] leading-tight">{VIEW_META[v].subtitle}</div>
          </button>
        ))}
      </div>

      {/* ── Stats bar ─────────────────────────────────────────────────────── */}
      <StatsBar graph={graph} view={view} />

      {/* ── Main canvas + sidebar ─────────────────────────────────────────── */}
      <div className="flex gap-4 items-start">

        {/* SVG canvas */}
        <div className="viz-container p-4 relative" style={{ touchAction: 'none' }}>
          {/* Zoom controls */}
          <div className="absolute top-3 left-3 flex flex-col gap-1 z-10">
            {[
              { icon: ZoomIn,   fn: zoomIn,  title: 'Zoom +' },
              { icon: ZoomOut,  fn: zoomOut, title: 'Zoom −' },
              { icon: RotateCcw,fn: reset,   title: 'Reset'   },
            ].map(({ icon: Icon, fn, title }) => (
              <button key={title} onClick={fn} title={title}
                className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors">
                <Icon className="w-3.5 h-3.5" />
              </button>
            ))}
          </div>

          {/* View badge */}
          <div className="absolute top-3 right-3 z-10 px-2 py-1 rounded text-[10px] font-mono font-semibold"
            style={{ background: `${VIEW_META[view].color}20`, color: VIEW_META[view].color }}>
            {view}
          </div>

          {/* Tooltip */}
          <div ref={tooltipRef}
            className="absolute pointer-events-none bg-card border border-border rounded-md px-3 py-2 text-xs shadow-md z-20 max-w-xs"
            style={{ opacity: 0, transition: 'opacity 0.15s' }}
          />

          <svg ref={svgRef} width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className="block" />
        </div>

        {/* Sidebar */}
        <div className="flex flex-col gap-3 w-56 shrink-0">

          {/* Legend */}
          <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest">Légende</div>

          {view === 'structure' && (
            <div className="flex flex-col gap-1.5">
              {Object.entries(modeColors).map(([mode, color]) => (
                <div key={mode} className="flex items-center gap-2 text-xs">
                  <span className="w-3 h-3 rounded-full shrink-0" style={{ background: color }} />
                  <span className="text-muted-foreground">{modeLabels[mode as keyof typeof modeLabels]}</span>
                </div>
              ))}
              <div className="mt-2 text-[10px] text-muted-foreground leading-relaxed">
                Taille = nb de lignes<br />
                Trait = liaison partagée
              </div>
            </div>
          )}

          {view === 'intelligence' && (
            <div className="flex flex-col gap-1.5">
              {[
                { color: '#3b82f6', label: 'Centralité faible' },
                { color: '#f59e0b', label: 'Centralité moyenne' },
                { color: '#ef4444', label: 'Hub critique' },
              ].map(({ color, label }) => (
                <div key={label} className="flex items-center gap-2 text-xs">
                  <span className="w-3 h-3 rounded-full shrink-0" style={{ background: color }} />
                  <span className="text-muted-foreground">{label}</span>
                </div>
              ))}
              <div className="flex items-center gap-2 text-xs mt-1">
                <span className="w-3 h-3 rounded-full border-2 border-dashed shrink-0" style={{ borderColor: '#fbbf24' }} />
                <span className="text-muted-foreground">Point de rupture</span>
              </div>
              <div className="mt-2 text-[10px] text-muted-foreground">
                Taille = centralité betweenness
              </div>
            </div>
          )}

          {view === 'opportunities' && (
            <div className="flex flex-col gap-1.5">
              {(Object.entries(TIER_COLORS) as [keyof typeof TIER_COLORS, string][]).map(([tier, color]) => (
                <div key={tier} className="flex items-center gap-2 text-xs">
                  <span className="w-3 h-3 rounded-full shrink-0" style={{ background: color }} />
                  <span className="text-muted-foreground capitalize">{
                    tier === 'hub'        ? 'Hub établi' :
                    tier === 'secondary'  ? 'Secondaire' :
                    tier === 'peripheral' ? 'Périphérique' :
                                           'Isolé (opportunité)'
                  }</span>
                </div>
              ))}
              <div className="mt-2 text-[10px] text-muted-foreground">
                Taille = score d'attractivité
              </div>
            </div>
          )}

          {/* Selected node panel */}
          {selectedNode && (
            <div className="mt-2">
              <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mb-2">Sélection</div>
              <NodePanel node={selectedNode} view={view} />
            </div>
          )}

          {/* Top 3 opportunities (view 3 only) */}
          {view === 'opportunities' && !selectedNode && (
            <div className="mt-2 flex flex-col gap-3">
              <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest">Top hubs</div>
              {graph.nodes
                .sort((a, b) => b.hubScore - a.hubScore)
                .slice(0, 3)
                .map((n, i) => (
                  <button key={n.id} onClick={() => { setSelectedNode(n); onSelectStop?.(n.id); }}
                    className="text-left p-2 rounded-md border border-border hover:bg-secondary transition-colors">
                    <div className="flex items-center gap-1.5 text-xs">
                      <span className="text-muted-foreground font-mono">#{i + 1}</span>
                      <span className="font-medium truncate">{n.name}</span>
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-0.5 font-mono">
                      Attract. {(n.attractivityScore * 100).toFixed(0)} · Vuln. {(n.vulnerabilityScore * 100).toFixed(0)}
                    </div>
                  </button>
                ))}

              <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mt-1">Zones isolées</div>
              {graph.nodes
                .filter(n => n.tier === 'isolated')
                .sort((a, b) => a.degree - b.degree)
                .slice(0, 3)
                .map(n => (
                  <button key={n.id} onClick={() => { setSelectedNode(n); onSelectStop?.(n.id); }}
                    className="text-left p-2 rounded-md border border-border hover:bg-secondary transition-colors">
                    <div className="text-xs font-medium truncate">{n.name}</div>
                    <div className="text-[10px] text-muted-foreground mt-0.5 font-mono">
                      Degré {n.degree} · {n.routeCount} ligne{n.routeCount > 1 ? 's' : ''}
                    </div>
                  </button>
                ))}
            </div>
          )}
        </div>
      </div>

      <div className="text-xs text-muted-foreground font-mono">
        {graph.nodes.length} stations · {graph.edges.length} liaisons ·{' '}
        {graph.stats.articulationCount} points de rupture · molette pour zoomer
      </div>
    </div>
  );
};

export default NetworkDependencyView;
