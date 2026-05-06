import React, { useEffect, useRef, useMemo, useState, useCallback } from 'react';
import * as d3 from 'd3';
import type { AnalysisResult } from '@/lib/network-analysis';
import type { ParsedGtfs, TransportMode } from '@/lib/gtfs-types';
import { modeColors, modeLabels } from '@/lib/gtfs-types';
import { buildNetworkGraph, type GraphNode, type GraphEdge, type NetworkGraph } from '@/lib/network-graph';
import { ZoomIn, ZoomOut, RotateCcw, AlertTriangle, Bus, Info } from 'lucide-react';

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
    case 'structure':     return modeColors[node.modes[0] ?? 'bus'];
    case 'intelligence':  return d3.interpolateRdYlBu(1 - node.hubScore);
    case 'opportunities': return TIER_COLORS[node.tier];
  }
}

function nodeRadius(node: GraphNode, view: ViewMode): number {
  switch (view) {
    case 'structure':     return Math.max(3, Math.sqrt(node.routeCount) * 3.2);
    case 'intelligence':  return Math.max(3, node.betweenness * 16 + 3);
    case 'opportunities': return Math.max(3, node.attractivityScore * 13 + 3);
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

// ─── Domain analysis helpers ──────────────────────────────────────────────────

interface BreakpointImpact {
  isolatedCount: number;
  componentCount: number;
}

function computeBreakpointImpact(node: GraphNode, graph: NetworkGraph): BreakpointImpact {
  // BFS on the graph minus this node
  const adj = new Map<string, Set<string>>();
  for (const n of graph.nodes) {
    if (n.id === node.id) continue;
    adj.set(n.id, new Set());
  }
  for (const e of graph.edges) {
    if (e.sourceId === node.id || e.targetId === node.id) continue;
    adj.get(e.sourceId)?.add(e.targetId);
    adj.get(e.targetId)?.add(e.sourceId);
  }

  const visited = new Set<string>();
  const sizes: number[] = [];

  for (const id of adj.keys()) {
    if (visited.has(id)) continue;
    const queue = [id];
    visited.add(id);
    let size = 0;
    while (queue.length) {
      const curr = queue.shift()!;
      size++;
      for (const nb of adj.get(curr) ?? []) {
        if (!visited.has(nb)) { visited.add(nb); queue.push(nb); }
      }
    }
    sizes.push(size);
  }

  sizes.sort((a, b) => b - a);
  const total = adj.size;
  const largest = sizes[0] ?? 0;
  return { isolatedCount: total - largest, componentCount: sizes.length };
}

interface RelayRoute {
  routeId: string;
  name: string;
  mode: TransportMode;
  sharedStops: number;
}

function findRelayBuses(node: GraphNode, analysis: AnalysisResult): RelayRoute[] {
  const primaryModes = new Set<TransportMode>(['metro', 'tram', 'train']);
  const primaryRouteIds = new Set(
    analysis.routes
      .filter(r => primaryModes.has(r.mode))
      .filter(r =>
        analysis.correspondences.some(c =>
          (c.routeA === r.routeId || c.routeB === r.routeId) &&
          c.sharedStops.includes(node.id),
        ),
      )
      .map(r => r.routeId),
  );

  if (primaryRouteIds.size === 0) return [];

  const busWeight = new Map<string, number>();
  for (const corr of analysis.correspondences) {
    const aIsPrimary = primaryRouteIds.has(corr.routeA);
    const bIsPrimary = primaryRouteIds.has(corr.routeB);
    if (aIsPrimary && !primaryRouteIds.has(corr.routeB))
      busWeight.set(corr.routeB, (busWeight.get(corr.routeB) ?? 0) + corr.weight);
    if (bIsPrimary && !primaryRouteIds.has(corr.routeA))
      busWeight.set(corr.routeA, (busWeight.get(corr.routeA) ?? 0) + corr.weight);
  }

  return Array.from(busWeight.entries())
    .map(([routeId, w]) => {
      const r = analysis.routes.find(rt => rt.routeId === routeId);
      return { routeId, name: r?.name ?? routeId, mode: r?.mode ?? 'bus' as TransportMode, sharedStops: w };
    })
    .sort((a, b) => b.sharedStops - a.sharedStops)
    .slice(0, 5);
}

// ─── Shared UI components ─────────────────────────────────────────────────────

const GLOSSARY: Record<string, string> = {
  'Hub': 'Station à très forte centralité : nombreuses lignes convergentes, degré élevé dans le graphe. Sa suppression impacterait massivement la connectivité.',
  'Point de rupture': 'Station dont la suppression déconnecte physiquement des parties du réseau. Identifiée par l\'algorithme de Tarjan (points d\'articulation du graphe).',
  'Centralité betweenness': 'Proportion des chemins les plus courts du réseau qui passent par cette station. Haut score = nœud "de passage" incontournable.',
  'Score d\'attractivité': 'Composite : nb de lignes × correspondances × multimodalité. Proxy pour la valeur commerciale d\'un point du réseau.',
  'Score de vulnérabilité': 'Combinaison : point d\'articulation (0/1) + betweenness + nb de lignes. Évalue le risque en cas de défaillance.',
  'Bus relais': 'Ligne de bus dont le tracé couvre des arrêts communs avec une ligne structurante (métro/tram). Peut assurer une continuité de service en cas de panne.',
  'Zone isolée': 'Station avec degré ≤ 1 dans le graphe multi-lignes — faible maillage, souvent en bout de ligne. Signal d\'opportunité pour de nouvelles liaisons.',
  'Densité réseau': 'Ratio liaisons existantes / liaisons possibles (graphe complet). Mesure le maillage global : 100% = réseau maillé, 0% = arbre sans redondance.',
};

const InfoTip: React.FC<{ term: string }> = ({ term }) => {
  const [open, setOpen] = useState(false);
  const def = GLOSSARY[term];
  if (!def) return <span>{term}</span>;
  return (
    <span className="relative inline-flex items-center gap-0.5">
      <span>{term}</span>
      <button
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onClick={() => setOpen(v => !v)}
        className="text-muted-foreground/50 hover:text-muted-foreground transition-colors"
        aria-label={`Définition de ${term}`}
      >
        <Info className="w-2.5 h-2.5" />
      </button>
      {open && (
        <span className="absolute bottom-full left-0 mb-1 w-56 p-2.5 bg-popover border border-border rounded-lg text-[10px] shadow-xl z-50 leading-relaxed font-normal text-foreground">
          <span className="font-semibold text-xs block mb-1">{term}</span>
          {def}
        </span>
      )}
    </span>
  );
};

const ScoreBar: React.FC<{ label: string; value: number; color: string; glossary?: string }> = ({ label, value, color, glossary }) => (
  <div className="flex flex-col gap-1">
    <div className="flex justify-between text-[10px] font-mono text-muted-foreground">
      <span>{glossary ? <InfoTip term={glossary} /> : label}</span>
      <span style={{ color }}>{(value * 100).toFixed(0)}</span>
    </div>
    <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
      <div className="h-full rounded-full transition-all duration-500" style={{ width: `${value * 100}%`, background: color }} />
    </div>
  </div>
);

// ─── Breakpoint panel (view 3 only) ──────────────────────────────────────────

const BreakpointPanel: React.FC<{ node: GraphNode; graph: NetworkGraph; analysis: AnalysisResult }> = ({ node, graph, analysis }) => {
  const impact   = useMemo(() => computeBreakpointImpact(node, graph), [node, graph]);
  const relays   = useMemo(() => findRelayBuses(node, analysis), [node, analysis]);
  const hasPrimary = node.modes.some(m => ['metro', 'tram', 'train'].includes(m));

  return (
    <div className="flex flex-col gap-3 mt-2">

      {/* Breakpoint alert */}
      <div className="flex gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30">
        <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
        <div className="text-xs leading-relaxed">
          <div className="font-semibold text-amber-300 mb-1">
            <InfoTip term="Point de rupture" /> réseau
          </div>
          <div className="text-amber-200/80">
            Sa suppression isolerait <strong className="text-amber-200">{impact.isolatedCount} station{impact.isolatedCount > 1 ? 's' : ''}</strong> dans{' '}
            <strong className="text-amber-200">{impact.componentCount}</strong> sous-réseau{impact.componentCount > 1 ? 'x' : ''} distincts.
          </div>
        </div>
      </div>

      {/* What to plan */}
      <div className="p-3 rounded-lg border border-border bg-card/50 text-xs">
        <div className="font-semibold text-foreground mb-2">Ce qu'il faut prévoir</div>
        <ul className="flex flex-col gap-1.5 text-muted-foreground">
          <li className="flex gap-1.5">
            <span className="text-primary shrink-0">→</span>
            Plan de continuité (itinéraires de substitution)
          </li>
          <li className="flex gap-1.5">
            <span className="text-primary shrink-0">→</span>
            Redondance physique (voie / quai alternatif)
          </li>
          {impact.isolatedCount > 5 && (
            <li className="flex gap-1.5">
              <span className="text-destructive shrink-0">⚠</span>
              Impact fort : {impact.isolatedCount} stations exposées
            </li>
          )}
        </ul>
      </div>

      {/* Relay bus suggestions */}
      {hasPrimary && (
        <div className="p-3 rounded-lg border border-border bg-card/50 text-xs">
          <div className="font-semibold text-foreground mb-2 flex items-center gap-1">
            <Bus className="w-3 h-3" />
            <InfoTip term="Bus relais" /> potentiels
          </div>
          {relays.length === 0 ? (
            <div className="text-muted-foreground italic">Aucun bus relais détecté sur ce corridor.</div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {relays.map(r => (
                <div key={r.routeId} className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: modeColors[r.mode] }} />
                    <span className="font-medium">{r.name}</span>
                    <span className="text-[9px] text-muted-foreground">{modeLabels[r.mode]}</span>
                  </div>
                  <span className="text-[10px] text-muted-foreground font-mono">{r.sharedStops} corr.</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ─── Node panel ───────────────────────────────────────────────────────────────

const NodePanel: React.FC<{ node: GraphNode; view: ViewMode; graph: NetworkGraph; analysis: AnalysisResult }> = ({ node, view, graph, analysis }) => (
  <div className="flex flex-col gap-3 p-3 rounded-lg border border-border bg-card text-xs">
    <div>
      <div className="font-semibold text-foreground text-sm leading-tight">{node.name}</div>
      <div className="text-muted-foreground mt-0.5">
        {node.routeCount} ligne{node.routeCount > 1 ? 's' : ''} · {node.modes.map(m => modeLabels[m]).join(', ')}
      </div>
    </div>

    {view === 'structure' && (
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono">
        <span className="text-muted-foreground">Degré</span>       <span className="text-right">{node.degree}</span>
        <span className="text-muted-foreground">Corr.</span>       <span className="text-right">{node.correspondences}</span>
        <span className="text-muted-foreground">Modes</span>       <span className="text-right">{node.modes.length}</span>
      </div>
    )}

    {view === 'intelligence' && (
      <div className="flex flex-col gap-2">
        <ScoreBar label="Hub"           glossary="Hub"                       value={node.hubScore}           color="#ef4444" />
        <ScoreBar label="Centralité"    glossary="Centralité betweenness"    value={node.betweenness}        color="#f97316" />
        <ScoreBar label="Vulnérabilité" glossary="Score de vulnérabilité"    value={node.vulnerabilityScore} color="#eab308" />
        <ScoreBar label="Friction"      value={node.frictionScore}           color="#a855f7" />
        {node.isArticulation && (
          <div className="mt-1 px-2 py-1 rounded bg-red-500/10 text-red-400 text-[10px] font-mono">
            ⚠ <InfoTip term="Point de rupture" />
          </div>
        )}
      </div>
    )}

    {view === 'opportunities' && (
      <div className="flex flex-col gap-2">
        <ScoreBar label="Attractivité"  glossary="Score d'attractivité"   value={node.attractivityScore}  color="#22c55e" />
        <ScoreBar label="Hub score"     glossary="Hub"                    value={node.hubScore}           color="#f97316" />
        <ScoreBar label="Vulnérabilité" glossary="Score de vulnérabilité" value={node.vulnerabilityScore} color="#ef4444" />
        <div className="mt-1 px-2 py-1 rounded text-[10px] font-mono"
          style={{ background: `${TIER_COLORS[node.tier]}18`, color: TIER_COLORS[node.tier] }}>
          {node.tier === 'hub'        && '🔴 Hub établi — nœud critique'}
          {node.tier === 'secondary'  && '🟠 Secondaire — potentiel de croissance'}
          {node.tier === 'peripheral' && '⚫ Périphérique — couverture faible'}
          {node.tier === 'isolated'   && <><InfoTip term="Zone isolée" /> — opportunité réseau</>}
        </div>
        {node.isArticulation && (
          <BreakpointPanel node={node} graph={graph} analysis={analysis} />
        )}
      </div>
    )}
  </div>
);

// ─── Global stats bar ─────────────────────────────────────────────────────────

const StatsBar: React.FC<{ graph: NetworkGraph; view: ViewMode }> = ({ graph, view }) => {
  const { stats } = graph;
  const items =
    view === 'structure' ? [
      { label: 'Stations',        value: graph.nodes.length.toString() },
      { label: 'Liaisons',        value: graph.edges.length.toString() },
      { label: 'Deg. moyen',      value: stats.avgDegree.toFixed(1) },
      { label: 'Densité réseau',  value: (stats.density * 100).toFixed(1) + '%', glossary: 'Densité réseau' },
    ] :
    view === 'intelligence' ? [
      { label: 'Hubs',             value: stats.hubCount.toString(),        glossary: 'Hub' },
      { label: 'Points de rupture',value: stats.articulationCount.toString(),glossary: 'Point de rupture' },
      { label: 'Deg. max',         value: stats.maxDegree.toString() },
      { label: 'Secondaires',      value: stats.secondaryCount.toString() },
    ] :
    [
      { label: 'Hubs critiques',   value: stats.hubCount.toString(),         glossary: 'Hub' },
      { label: 'Zones périph.',    value: stats.peripheralCount.toString() },
      { label: 'Zones isolées',    value: stats.isolatedCount.toString(),     glossary: 'Zone isolée' },
      { label: 'Pts de rupture',   value: stats.articulationCount.toString(), glossary: 'Point de rupture' },
    ];

  return (
    <div className="flex gap-6 px-4 py-2 rounded-lg border border-border bg-card text-xs font-mono">
      {items.map(item => (
        <div key={item.label} className="flex flex-col items-center gap-0.5">
          <span className="text-foreground font-semibold text-sm">{item.value}</span>
          <span className="text-muted-foreground text-[10px]">
            {(item as any).glossary ? <InfoTip term={(item as any).glossary} /> : item.label}
          </span>
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

  const svgRef     = useRef<SVGSVGElement>(null);
  const zoomRef    = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const viewRef    = useRef<ViewMode>('structure');
  const simRef     = useRef<d3.Simulation<GraphNode, GraphEdge> | null>(null);

  useEffect(() => { viewRef.current = view; }, [view]);

  const graph      = useMemo(() => buildNetworkGraph(gtfs, analysis), [gtfs, analysis]);
  const maxWeight  = useMemo(() => Math.max(...graph.edges.map(e => e.weight), 1), [graph]);

  // ── Initial D3 setup ────────────────────────────────────────────────────────

  useEffect(() => {
    if (!svgRef.current || graph.nodes.length === 0) return;

    const svg   = d3.select(svgRef.current);
    svg.selectAll('g.ndv').remove();
    const g = svg.append('g').attr('class', 'ndv');

    const nodes = graph.nodes.map(n => ({ ...n }));
    const edges = graph.edges.map(e => ({ ...e, source: e.sourceId, target: e.targetId }));

    const sim = d3.forceSimulation<GraphNode>(nodes)
      .force('link', d3.forceLink<GraphNode, GraphEdge>(edges as any)
        .id((d: any) => d.id)
        .distance((d: any) => 50 + (d.weight ?? 1) * 8)
        .strength(0.4))
      .force('charge', d3.forceManyBody<GraphNode>().strength(-120))
      .force('center',  d3.forceCenter(SIZE / 2, SIZE / 2))
      .force('collide', d3.forceCollide<GraphNode>().radius((d: any) => nodeRadius(d, viewRef.current) + 3));
    simRef.current = sim;

    const link = g.selectAll<SVGLineElement, GraphEdge>('line.ndv-link')
      .data(edges)
      .enter().append('line')
      .attr('class', 'ndv-link')
      .attr('stroke', '#475569')
      .attr('stroke-opacity', (d: any) => edgeOpacity(d.weight, maxWeight, viewRef.current))
      .attr('stroke-width',   (d: any) => edgeWidth(d.weight, viewRef.current));

    // Articulation point rings (behind nodes)
    const apRing = g.selectAll<SVGCircleElement, GraphNode>('circle.ndv-ap')
      .data(nodes.filter(n => n.isArticulation))
      .enter().append('circle')
      .attr('class', 'ndv-ap')
      .attr('fill', 'none')
      .attr('stroke', '#fbbf24')
      .attr('stroke-width', 2)
      .attr('stroke-dasharray', '4 2')
      .attr('pointer-events', 'none');

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
          const badge = d.isArticulation ? ' ⚠ rupture' : '';
          const score =
            viewRef.current === 'structure'     ? `Degré ${d.degree}` :
            viewRef.current === 'intelligence'  ? `Hub ${(d.hubScore * 100).toFixed(0)}  Vuln. ${(d.vulnerabilityScore * 100).toFixed(0)}` :
                                                  `Attract. ${(d.attractivityScore * 100).toFixed(0)}`;
          tt.innerHTML = `<strong>${d.name}</strong>${badge}<br/><span style="opacity:.7">${d.routeCount} lignes · ${score}</span>`;
        }
      })
      .on('mouseleave', function () {
        const el  = d3.select<SVGCircleElement, GraphNode>(this as SVGCircleElement);
        const dat = el.datum();
        const isSel = selectedStopId === dat.id;
        el.attr('stroke', isSel ? '#6366f1' : '#0f172a').attr('stroke-width', isSel ? 2.5 : 1);
        if (tooltipRef.current) tooltipRef.current.style.opacity = '0';
      });

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

    sim.on('tick', () => {
      link
        .attr('x1', (d: any) => (d.source as GraphNode).x ?? 0)
        .attr('y1', (d: any) => (d.source as GraphNode).y ?? 0)
        .attr('x2', (d: any) => (d.target as GraphNode).x ?? 0)
        .attr('y2', (d: any) => (d.target as GraphNode).y ?? 0);
      apRing
        .attr('cx', (d: any) => d.x ?? 0).attr('cy', (d: any) => d.y ?? 0)
        .attr('r',  (d: any) => nodeRadius(d, viewRef.current) + 5);
      node
        .attr('cx', (d: any) => d.x ?? 0).attr('cy', (d: any) => d.y ?? 0);
      label
        .attr('x', (d: any) => d.x ?? 0).attr('y', (d: any) => d.y ?? 0);
    });

    const drag = d3.drag<SVGCircleElement, GraphNode>()
      .on('start', (ev, d) => { if (!ev.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag',  (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
      .on('end',   (ev, d) => { if (!ev.active) sim.alphaTarget(0); d.fx = null; d.fy = null; });
    node.call(drag as any);

    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 10])
      .on('zoom', ev => g.attr('transform', ev.transform.toString()));
    svg.call(zoom);
    zoomRef.current = zoom;

    return () => { sim.stop(); svg.on('.zoom', null); };
  }, [graph, maxWeight, onSelectStop]);

  // ── Re-style when view changes ─────────────────────────────────────────────

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

  // ── Highlight selected stop ────────────────────────────────────────────────

  useEffect(() => {
    if (!svgRef.current) return;
    d3.select(svgRef.current)
      .selectAll<SVGCircleElement, GraphNode>('circle.ndv-node')
      .attr('stroke',       d => d.id === selectedStopId ? '#6366f1' : '#0f172a')
      .attr('stroke-width', d => d.id === selectedStopId ? 2.5 : 1);
  }, [selectedStopId]);

  const zoomIn  = useCallback(() => {
    if (svgRef.current && zoomRef.current) d3.select(svgRef.current).transition().duration(280).call(zoomRef.current.scaleBy, 1.5);
  }, []);
  const zoomOut = useCallback(() => {
    if (svgRef.current && zoomRef.current) d3.select(svgRef.current).transition().duration(280).call(zoomRef.current.scaleBy, 0.67);
  }, []);
  const reset   = useCallback(() => {
    if (svgRef.current && zoomRef.current) d3.select(svgRef.current).transition().duration(380).call(zoomRef.current.transform, d3.zoomIdentity);
  }, []);

  const VIEW_META: Record<ViewMode, { label: string; subtitle: string; color: string }> = {
    structure:     { label: '① Structure brute',  subtitle: 'Topologie · modes · distribution des liaisons', color: '#3b82f6' },
    intelligence:  { label: '② Analyse réseau',   subtitle: 'Centralité · hubs · points de rupture · friction', color: '#f59e0b' },
    opportunities: { label: '③ Opportunités',     subtitle: 'Zones faibles · hubs critiques · bus relais · scoring', color: '#22c55e' },
  };

  return (
    <div className="flex flex-col gap-5">

      {/* ── View selector ─────────────────────────────────────────────────── */}
      <div className="flex gap-2">
        {(Object.keys(VIEW_META) as ViewMode[]).map(v => (
          <button key={v} onClick={() => setView(v)}
            className={`flex-1 text-left px-4 py-3 rounded-lg border transition-all text-xs ${
              view === v
                ? 'border-transparent text-foreground font-semibold'
                : 'border-border text-muted-foreground hover:border-border/80 hover:text-foreground'
            }`}
            style={view === v ? { background: `${VIEW_META[v].color}18`, borderColor: VIEW_META[v].color } : {}}>
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
          <div className="absolute top-3 left-3 flex flex-col gap-1 z-10">
            {[
              { icon: ZoomIn,    fn: zoomIn,  title: 'Zoom +' },
              { icon: ZoomOut,   fn: zoomOut, title: 'Zoom −' },
              { icon: RotateCcw, fn: reset,   title: 'Reset'   },
            ].map(({ icon: Icon, fn, title }) => (
              <button key={title} onClick={fn} title={title}
                className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors">
                <Icon className="w-3.5 h-3.5" />
              </button>
            ))}
          </div>

          <div className="absolute top-3 right-3 z-10 px-2 py-1 rounded text-[10px] font-mono font-semibold"
            style={{ background: `${VIEW_META[view].color}20`, color: VIEW_META[view].color }}>
            {view}
          </div>

          <div ref={tooltipRef}
            className="absolute pointer-events-none bg-card border border-border rounded-md px-3 py-2 text-xs shadow-md z-20 max-w-xs"
            style={{ opacity: 0, transition: 'opacity 0.15s' }}
          />

          <svg ref={svgRef} width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className="block" />
        </div>

        {/* Sidebar */}
        <div className="flex flex-col gap-3 w-64 shrink-0 max-h-[740px] overflow-y-auto pr-1">

          <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest">Légende</div>

          {view === 'structure' && (
            <div className="flex flex-col gap-1.5">
              {Object.entries(modeColors).map(([mode, color]) => (
                <div key={mode} className="flex items-center gap-2 text-xs">
                  <span className="w-3 h-3 rounded-full shrink-0" style={{ background: color }} />
                  <span className="text-muted-foreground">{modeLabels[mode as keyof typeof modeLabels]}</span>
                </div>
              ))}
              <p className="mt-2 text-[10px] text-muted-foreground leading-relaxed">
                Taille = nb de lignes · Trait = liaison partagée
              </p>
            </div>
          )}

          {view === 'intelligence' && (
            <div className="flex flex-col gap-1.5">
              {[
                { color: '#3b82f6', label: 'Centralité faible' },
                { color: '#f59e0b', label: 'Centralité moyenne' },
                { color: '#ef4444', label: <InfoTip term="Hub" /> },
              ].map(({ color, label }, i) => (
                <div key={i} className="flex items-center gap-2 text-xs">
                  <span className="w-3 h-3 rounded-full shrink-0" style={{ background: color }} />
                  <span className="text-muted-foreground">{label}</span>
                </div>
              ))}
              <div className="flex items-center gap-2 text-xs mt-1">
                <span className="w-3 h-3 rounded-full border-2 border-dashed shrink-0" style={{ borderColor: '#fbbf24' }} />
                <span className="text-muted-foreground"><InfoTip term="Point de rupture" /></span>
              </div>
              <p className="mt-2 text-[10px] text-muted-foreground">
                Taille = <InfoTip term="Centralité betweenness" />
              </p>
            </div>
          )}

          {view === 'opportunities' && (
            <div className="flex flex-col gap-1.5">
              {(Object.entries(TIER_COLORS) as [keyof typeof TIER_COLORS, string][]).map(([tier, color]) => (
                <div key={tier} className="flex items-center gap-2 text-xs">
                  <span className="w-3 h-3 rounded-full shrink-0" style={{ background: color }} />
                  <span className="text-muted-foreground">
                    {tier === 'hub'        ? <InfoTip term="Hub" /> :
                     tier === 'secondary'  ? 'Secondaire' :
                     tier === 'peripheral' ? 'Périphérique' :
                                            <InfoTip term="Zone isolée" />}
                  </span>
                </div>
              ))}
              <p className="mt-2 text-[10px] text-muted-foreground">
                Taille = <InfoTip term="Score d'attractivité" /> · cliquer un nœud pour l'analyse
              </p>
            </div>
          )}

          {/* Selected node panel */}
          {selectedNode && (
            <div className="mt-1">
              <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mb-2">Analyse</div>
              <NodePanel node={selectedNode} view={view} graph={graph} analysis={analysis} />
            </div>
          )}

          {/* Quick lists (view 3, no selection) */}
          {view === 'opportunities' && !selectedNode && (
            <div className="mt-1 flex flex-col gap-3">
              <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest">
                Top <InfoTip term="Hub" />s critiques
              </div>
              {graph.nodes
                .sort((a, b) => b.hubScore - a.hubScore)
                .slice(0, 3)
                .map((n, i) => (
                  <button key={n.id} onClick={() => { setSelectedNode(n); onSelectStop?.(n.id); }}
                    className="text-left p-2 rounded-md border border-border hover:bg-secondary transition-colors">
                    <div className="flex items-center gap-1.5 text-xs">
                      <span className="text-muted-foreground font-mono">#{i + 1}</span>
                      <span className="font-medium truncate">{n.name}</span>
                      {n.isArticulation && <AlertTriangle className="w-3 h-3 text-amber-400 shrink-0" />}
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-0.5 font-mono">
                      Attract. {(n.attractivityScore * 100).toFixed(0)} · Vuln. {(n.vulnerabilityScore * 100).toFixed(0)}
                    </div>
                  </button>
                ))}

              <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mt-1">
                <InfoTip term="Zone isolée" />s — opportunités
              </div>
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
        {graph.nodes.length} stations · {graph.edges.length} liaisons · {graph.stats.articulationCount}{' '}
        <InfoTip term="Point de rupture" />s · molette pour zoomer
      </div>
    </div>
  );
};

export default NetworkDependencyView;
