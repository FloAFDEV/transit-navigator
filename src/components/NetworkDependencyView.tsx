import React, { useEffect, useRef, useMemo, useState, useCallback } from 'react';
import * as d3 from 'd3';
import type { AnalysisResult } from '@/lib/network-analysis';
import type { ParsedGtfs, TransportMode } from '@/lib/gtfs-types';
import { modeColors, modeLabels } from '@/lib/gtfs-types';
import { buildNetworkGraph, type GraphNode, type GraphEdge, type NetworkGraph } from '@/lib/network-graph';
import { ZoomIn, ZoomOut, RotateCcw, AlertTriangle, Bus, Info, HelpCircle, TrendingUp, Shield, MapPin } from 'lucide-react';

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

// ─── Plain language helpers ───────────────────────────────────────────────────

function scoreLabel(value: number): string {
  if (value >= 0.8) return 'Très élevé';
  if (value >= 0.6) return 'Élevé';
  if (value >= 0.4) return 'Moyen';
  if (value >= 0.2) return 'Faible';
  return 'Très faible';
}

function tierPlain(tier: GraphNode['tier']): { emoji: string; label: string; explain: string } {
  switch (tier) {
    case 'hub':
      return { emoji: '🔴', label: 'Hub majeur', explain: 'Station centrale du réseau : beaucoup de lignes convergent ici. Sa fermeture aurait un impact fort.' };
    case 'secondary':
      return { emoji: '🟠', label: 'Station secondaire', explain: 'Bien connectée mais pas critique. Potentiel de développement pour renforcer le maillage.' };
    case 'peripheral':
      return { emoji: '⚫', label: 'Station périphérique', explain: 'Peu de connexions. Peut indiquer une zone à améliorer ou une fin de ligne.' };
    case 'isolated':
      return { emoji: '🔵', label: 'Station isolée', explain: 'Très peu de connexions avec le reste du réseau. Opportunité pour créer de nouvelles liaisons.' };
  }
}

// ─── Shared UI components ─────────────────────────────────────────────────────

const GLOSSARY: Record<string, { short: string; long: string }> = {
  'Hub': {
    short: 'Station où convergent beaucoup de lignes',
    long: 'Un hub est une station très centrale : de nombreuses lignes s\'y croisent. Sa fermeture ou perturbation impacte massivement tous les voyageurs qui en dépendent.',
  },
  'Point de rupture': {
    short: 'Station dont la fermeture isole une partie du réseau',
    long: 'Si cette station est fermée ou en panne, certains quartiers se retrouvent coupés du reste du réseau. C\'est un point de fragilité critique à surveiller et à sécuriser.',
  },
  'Betweenness': {
    short: 'Fréquence à laquelle une station est sur le chemin le plus court',
    long: 'Mesure combien de trajets dans le réseau passent obligatoirement par cette station. Un score élevé = nœud "de transit" indispensable.',
  },
  'Attractivité': {
    short: 'Valeur commerciale et stratégique d\'une station',
    long: 'Combine le nombre de lignes, les correspondances disponibles et la diversité des modes. Un score élevé indique un point à fort potentiel de fréquentation.',
  },
  'Vulnérabilité': {
    short: 'Risque en cas de panne ou fermeture',
    long: 'Évalue les conséquences d\'une fermeture de cette station : nombre de voyageurs impactés, alternatives disponibles, importance dans le maillage global.',
  },
  'Bus relais': {
    short: 'Bus pouvant remplacer une ligne structurante en cas de panne',
    long: 'Ligne de bus dont le trajet couvre des arrêts proches d\'une ligne de métro ou tram. En cas de perturbation, ce bus peut assurer partiellement la continuité de service.',
  },
  'Zone isolée': {
    short: 'Quartier peu relié au reste du réseau',
    long: 'Station avec très peu de connexions : souvent en bout de ligne ou dans une zone peu dense. Représente une opportunité pour créer de nouvelles liaisons.',
  },
  'Densité réseau': {
    short: 'Degré de maillage global du réseau',
    long: 'Proportion de liaisons existantes par rapport au maximum théorique. 100% = chaque station reliée à toutes les autres (impossible en pratique). Un réseau maillé offre plus d\'alternatives.',
  },
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
        className="text-muted-foreground/50 hover:text-primary transition-colors"
        aria-label={`Définition de ${term}`}
      >
        <Info className="w-2.5 h-2.5" />
      </button>
      {open && (
        <span className="absolute bottom-full left-0 mb-1 w-64 p-3 bg-popover border border-border rounded-xl text-[11px] shadow-xl z-50 leading-relaxed font-normal text-foreground">
          <span className="font-semibold text-sm block mb-1">{term}</span>
          <span className="text-muted-foreground">{def.long}</span>
        </span>
      )}
    </span>
  );
};

const ScoreBar: React.FC<{ label: string; value: number; color: string; plain?: string }> = ({ label, value, color, plain }) => (
  <div className="flex flex-col gap-1">
    <div className="flex justify-between items-baseline text-[10px] text-muted-foreground">
      <span className="font-medium">{label}</span>
      <span style={{ color }} className="font-semibold">{plain ?? scoreLabel(value)}</span>
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
  const severity = impact.isolatedCount > 10 ? 'critique' : impact.isolatedCount > 4 ? 'élevé' : 'modéré';

  return (
    <div className="flex flex-col gap-3 mt-2">

      {/* Breakpoint alert */}
      <div className="flex gap-2 p-3 rounded-xl bg-amber-500/10 border border-amber-500/30">
        <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
        <div className="text-xs leading-relaxed">
          <div className="font-bold text-amber-300 mb-1">⚠ Station fragile</div>
          <div className="text-amber-200/90">
            Si cette station est fermée, <strong className="text-amber-100">{impact.isolatedCount} station{impact.isolatedCount > 1 ? 's' : ''}</strong> seraient
            coupées du reste du réseau — risque <strong className="text-amber-100">{severity}</strong>.
          </div>
        </div>
      </div>

      {/* Plain severity badge */}
      <div className="flex gap-2 text-xs">
        {impact.componentCount > 1 && (
          <span className="px-2 py-0.5 rounded-full bg-red-500/10 text-red-400 border border-red-500/20">
            {impact.componentCount} sous-réseaux séparés
          </span>
        )}
        <span className={`px-2 py-0.5 rounded-full border ${
          severity === 'critique' ? 'bg-red-500/10 text-red-400 border-red-500/20' :
          severity === 'élevé' ? 'bg-orange-500/10 text-orange-400 border-orange-500/20' :
          'bg-yellow-500/10 text-yellow-400 border-yellow-500/20'
        }`}>Impact {severity}</span>
      </div>

      {/* What to plan */}
      <div className="p-3 rounded-xl border border-border bg-card/50 text-xs">
        <div className="font-semibold text-foreground mb-2 flex items-center gap-1.5">
          <Shield className="w-3.5 h-3.5 text-primary" />
          Ce qu'il faut prévoir
        </div>
        <ul className="flex flex-col gap-2 text-muted-foreground">
          <li className="flex gap-2">
            <span className="text-primary shrink-0 mt-0.5">→</span>
            <span>Définir un plan de continuité : quels itinéraires alternatifs en cas de fermeture ?</span>
          </li>
          <li className="flex gap-2">
            <span className="text-primary shrink-0 mt-0.5">→</span>
            <span>Prévoir une redondance physique (quai ou voie de substitution)</span>
          </li>
          {impact.isolatedCount > 5 && (
            <li className="flex gap-2">
              <span className="text-destructive shrink-0 mt-0.5">!</span>
              <span className="text-foreground/80">{impact.isolatedCount} stations exposées — à traiter en priorité</span>
            </li>
          )}
        </ul>
      </div>

      {/* Relay bus suggestions */}
      {hasPrimary && (
        <div className="p-3 rounded-xl border border-border bg-card/50 text-xs">
          <div className="font-semibold text-foreground mb-1 flex items-center gap-1.5">
            <Bus className="w-3.5 h-3.5 text-blue-400" />
            Bus de substitution possibles
          </div>
          <p className="text-muted-foreground mb-2 text-[10px] leading-relaxed">
            Ces lignes de bus passent par des arrêts proches et pourraient assurer une continuité partielle.
          </p>
          {relays.length === 0 ? (
            <div className="text-muted-foreground italic">Aucun bus relais détecté — corridor sans alternative.</div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {relays.map(r => (
                <div key={r.routeId} className="flex items-center justify-between py-1 border-b border-border/40 last:border-0">
                  <div className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: modeColors[r.mode] }} />
                    <span className="font-medium">{r.name}</span>
                    <span className="text-[9px] text-muted-foreground px-1 py-0.5 bg-secondary rounded">{modeLabels[r.mode]}</span>
                  </div>
                  <span className="text-[10px] text-muted-foreground">{r.sharedStops} arrêts communs</span>
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

const NodePanel: React.FC<{ node: GraphNode; view: ViewMode; graph: NetworkGraph; analysis: AnalysisResult }> = ({ node, view, graph, analysis }) => {
  const tier = tierPlain(node.tier);
  return (
    <div className="flex flex-col gap-3 p-3 rounded-xl border border-border bg-card text-xs">
      <div>
        <div className="font-bold text-foreground text-sm leading-tight">{node.name}</div>
        <div className="text-muted-foreground mt-0.5">
          {node.routeCount} ligne{node.routeCount > 1 ? 's' : ''} · {node.modes.map(m => modeLabels[m]).join(', ')}
        </div>
      </div>

      {view === 'structure' && (
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            <div>
              <div className="text-[10px] text-muted-foreground">Connexions directes</div>
              <div className="font-semibold text-foreground">{node.degree} lignes voisines</div>
            </div>
            <div>
              <div className="text-[10px] text-muted-foreground">Correspondances</div>
              <div className="font-semibold text-foreground">{node.correspondences} possibles</div>
            </div>
            <div>
              <div className="text-[10px] text-muted-foreground">Modes disponibles</div>
              <div className="font-semibold text-foreground">{node.modes.length} mode{node.modes.length > 1 ? 's' : ''}</div>
            </div>
          </div>
          <div className="mt-1 p-2 rounded-lg bg-secondary/50 text-muted-foreground leading-relaxed">
            {node.routeCount >= 4
              ? '✓ Station bien maillée — plusieurs lignes disponibles.'
              : node.routeCount === 1
              ? '⚠ Station avec une seule ligne — peu d\'alternatives.'
              : '~ Station modérément connectée.'}
          </div>
        </div>
      )}

      {view === 'intelligence' && (
        <div className="flex flex-col gap-2.5">
          <ScoreBar label="Importance dans le réseau" value={node.hubScore}           color="#ef4444" />
          <ScoreBar label="Station de passage obligé"  value={node.betweenness}        color="#f97316" />
          <ScoreBar label="Risque en cas de fermeture" value={node.vulnerabilityScore} color="#eab308" />
          <ScoreBar label="Complexité des échanges"    value={node.frictionScore}      color="#a855f7" />
          {node.isArticulation && (
            <div className="mt-1 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/25 text-amber-300 text-[10px] flex items-center gap-1.5">
              <AlertTriangle className="w-3 h-3 shrink-0" />
              Station fragile : sa fermeture couperait une partie du réseau
            </div>
          )}
        </div>
      )}

      {view === 'opportunities' && (
        <div className="flex flex-col gap-2.5">
          {/* Tier badge */}
          <div className="flex items-center gap-2 p-2.5 rounded-lg border"
            style={{ background: `${TIER_COLORS[node.tier]}10`, borderColor: `${TIER_COLORS[node.tier]}30` }}>
            <span className="text-lg">{tier.emoji}</span>
            <div>
              <div className="font-semibold text-xs" style={{ color: TIER_COLORS[node.tier] }}>{tier.label}</div>
              <div className="text-[10px] text-muted-foreground leading-snug mt-0.5">{tier.explain}</div>
            </div>
          </div>
          <ScoreBar label="Valeur stratégique"     value={node.attractivityScore}  color="#22c55e" />
          <ScoreBar label="Importance hub"         value={node.hubScore}           color="#f97316" />
          <ScoreBar label="Risque de fermeture"    value={node.vulnerabilityScore} color="#ef4444" />
          {node.isArticulation && (
            <BreakpointPanel node={node} graph={graph} analysis={analysis} />
          )}
          {!node.isArticulation && node.tier === 'isolated' && (
            <div className="p-2.5 rounded-lg border border-blue-500/20 bg-blue-500/5 text-[10px] text-blue-300 leading-relaxed">
              <TrendingUp className="w-3 h-3 inline mr-1" />
              Opportunité : créer une nouvelle liaison depuis cette station améliorerait l'accessibilité du secteur.
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ─── Reading guide (shown when nothing is selected) ───────────────────────────

const ReadingGuide: React.FC<{ view: ViewMode }> = ({ view }) => {
  const guides: Record<ViewMode, { question: string; how: string[]; tip: string }> = {
    structure: {
      question: 'Comment lire cette carte ?',
      how: [
        'Chaque point = une station. La taille indique combien de lignes s\'y arrêtent.',
        'La couleur indique le mode de transport principal (bus, métro, tram…).',
        'Les traits entre les points représentent des liaisons partagées entre stations.',
      ],
      tip: 'Cherchez les gros points colorés : ce sont vos stations les plus actives.',
    },
    intelligence: {
      question: 'Comment lire cette carte ?',
      how: [
        'Chaque point = une station. La taille montre son importance dans les trajets du réseau.',
        'Rouge = station très centrale, Bleu = station secondaire.',
        'Les cercles en pointillés jaunes signalent les stations fragiles (fermeture = coupure réseau).',
      ],
      tip: 'Cliquez sur un point rouge ou entouré de pointillés pour voir son analyse détaillée.',
    },
    opportunities: {
      question: 'Comment lire cette carte ?',
      how: [
        '🔴 Rouge = Hub majeur : station critique, priorité absolue de maintenance.',
        '🟠 Orange = Station secondaire : bien connectée, potentiel de croissance.',
        '⚫ Gris = Périphérique : peu connectée, souvent en bout de ligne.',
        '🔵 Bleu = Station isolée : opportunité pour créer de nouvelles liaisons.',
      ],
      tip: 'Cliquez sur un hub rouge pour voir ce qu\'il faudrait prévoir en cas de panne.',
    },
  };

  const g = guides[view];
  return (
    <div className="p-3 rounded-xl border border-border bg-card/40 text-xs">
      <div className="flex items-center gap-1.5 font-semibold text-foreground mb-2">
        <HelpCircle className="w-3.5 h-3.5 text-primary" />
        {g.question}
      </div>
      <ul className="flex flex-col gap-1.5 text-muted-foreground mb-2">
        {g.how.map((h, i) => <li key={i} className="leading-relaxed">{h}</li>)}
      </ul>
      <div className="flex gap-1.5 p-2 rounded-lg bg-primary/5 border border-primary/10 text-foreground/70 leading-relaxed">
        <span className="shrink-0">💡</span>
        <span>{g.tip}</span>
      </div>
    </div>
  );
};

// ─── Global stats bar ─────────────────────────────────────────────────────────

const StatsBar: React.FC<{ graph: NetworkGraph; view: ViewMode }> = ({ graph, view }) => {
  const { stats } = graph;

  const items =
    view === 'structure' ? [
      { label: 'Stations analysées', value: graph.nodes.length.toString(), note: 'avec ≥ 2 lignes' },
      { label: 'Liaisons détectées', value: graph.edges.length.toString(), note: 'connexions entre stations' },
      { label: 'Degré moyen', value: stats.avgDegree.toFixed(1), note: 'lignes par station en moyenne' },
      { label: 'Maillage global', value: (stats.density * 100).toFixed(1) + '%', note: 'densité du réseau', glossary: 'Densité réseau' },
    ] :
    view === 'intelligence' ? [
      { label: 'Hubs majeurs',       value: stats.hubCount.toString(),         note: 'stations très centrales', glossary: 'Hub' },
      { label: 'Stations fragiles',  value: stats.articulationCount.toString(), note: 'points de rupture',      glossary: 'Point de rupture' },
      { label: 'Connexions max',     value: stats.maxDegree.toString(),         note: 'lignes sur 1 station' },
      { label: 'Stations sec.',      value: stats.secondaryCount.toString(),    note: 'potentiel de croissance' },
    ] :
    [
      { label: 'Hubs critiques',     value: stats.hubCount.toString(),          note: 'à surveiller en priorité', glossary: 'Hub' },
      { label: 'Zones périph.',      value: stats.peripheralCount.toString(),   note: 'peu connectées' },
      { label: 'Stations isolées',   value: stats.isolatedCount.toString(),     note: 'opportunités réseau',      glossary: 'Zone isolée' },
      { label: 'Points fragiles',    value: stats.articulationCount.toString(), note: 'risque de coupure',        glossary: 'Point de rupture' },
    ];

  return (
    <div className="grid grid-cols-4 gap-3">
      {items.map(item => (
        <div key={item.label} className="flex flex-col gap-0.5 p-3 rounded-xl border border-border bg-card text-center">
          <span className="text-foreground font-bold text-lg leading-none">{item.value}</span>
          <span className="text-muted-foreground text-[10px] leading-tight mt-1">
            {(item as any).glossary ? <InfoTip term={(item as any).glossary} /> : item.label}
          </span>
          <span className="text-muted-foreground/50 text-[9px] leading-tight">{item.note}</span>
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
          const badge = d.isArticulation ? ' ⚠ fragile' : '';
          const plain =
            viewRef.current === 'structure'
              ? `${d.routeCount} lignes · ${d.degree} connexions`
              : viewRef.current === 'intelligence'
              ? `Importance ${scoreLabel(d.hubScore)} · Risque ${scoreLabel(d.vulnerabilityScore)}`
              : `Valeur stratégique ${scoreLabel(d.attractivityScore)} · ${tierPlain(d.tier).label}`;
          tt.innerHTML = `<strong>${d.name}</strong>${badge}<br/><span style="opacity:.7;font-size:10px">${plain}</span>`;
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

  const VIEW_META: Record<ViewMode, { label: string; question: string; color: string; icon: React.ReactNode }> = {
    structure:     {
      label: '① Carte du réseau',
      question: 'Où sont les stations et comment sont-elles connectées ?',
      color: '#3b82f6',
      icon: <MapPin className="w-4 h-4" />,
    },
    intelligence:  {
      label: '② Points clés',
      question: 'Quelles stations sont les plus importantes ou les plus fragiles ?',
      color: '#f59e0b',
      icon: <Shield className="w-4 h-4" />,
    },
    opportunities: {
      label: '③ Améliorations',
      question: 'Où investir pour renforcer ou étendre le réseau ?',
      color: '#22c55e',
      icon: <TrendingUp className="w-4 h-4" />,
    },
  };

  return (
    <div className="flex flex-col gap-5">

      {/* ── View selector ─────────────────────────────────────────────────── */}
      <div className="flex gap-3">
        {(Object.keys(VIEW_META) as ViewMode[]).map(v => (
          <button key={v} onClick={() => { setView(v); setSelectedNode(null); }}
            className={`flex-1 text-left px-4 py-3 rounded-xl border transition-all ${
              view === v
                ? 'border-transparent text-foreground font-semibold shadow-sm'
                : 'border-border text-muted-foreground hover:border-border/80 hover:text-foreground'
            }`}
            style={view === v ? { background: `${VIEW_META[v].color}15`, borderColor: VIEW_META[v].color } : {}}>
            <div className="flex items-center gap-2 mb-1" style={view === v ? { color: VIEW_META[v].color } : {}}>
              {VIEW_META[v].icon}
              <span className="font-semibold text-sm">{VIEW_META[v].label}</span>
            </div>
            <div className="text-[11px] leading-snug opacity-70">{VIEW_META[v].question}</div>
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
              { icon: RotateCcw, fn: reset,   title: 'Réinitialiser la vue' },
            ].map(({ icon: Icon, fn, title }) => (
              <button key={title} onClick={fn} title={title}
                className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors">
                <Icon className="w-3.5 h-3.5" />
              </button>
            ))}
          </div>

          <div className="absolute top-3 right-3 z-10 px-2.5 py-1 rounded-lg text-[10px] font-semibold flex items-center gap-1"
            style={{ background: `${VIEW_META[view].color}20`, color: VIEW_META[view].color }}>
            {VIEW_META[view].icon}
            {VIEW_META[view].label}
          </div>

          <div ref={tooltipRef}
            className="absolute pointer-events-none bg-card border border-border rounded-lg px-3 py-2 text-xs shadow-lg z-20 max-w-xs"
            style={{ opacity: 0, transition: 'opacity 0.15s' }}
          />

          <svg ref={svgRef} width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className="block" />

          {/* Bottom hint */}
          <div className="absolute bottom-3 left-0 right-0 flex justify-center">
            <span className="text-[10px] text-muted-foreground/50 bg-background/70 px-2 py-0.5 rounded-full">
              Cliquer sur un point · Molette pour zoomer · Glisser pour déplacer
            </span>
          </div>
        </div>

        {/* Sidebar */}
        <div className="flex flex-col gap-3 w-72 shrink-0 max-h-[760px] overflow-y-auto pr-1">

          {/* Legend */}
          <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">Légende</div>

          {view === 'structure' && (
            <div className="p-3 rounded-xl border border-border bg-card text-xs">
              <div className="flex flex-col gap-2">
                {Object.entries(modeColors).map(([mode, color]) => (
                  <div key={mode} className="flex items-center gap-2">
                    <span className="w-3 h-3 rounded-full shrink-0" style={{ background: color }} />
                    <span className="text-muted-foreground">{modeLabels[mode as keyof typeof modeLabels]}</span>
                  </div>
                ))}
              </div>
              <div className="mt-3 pt-2 border-t border-border text-muted-foreground leading-relaxed text-[10px]">
                <div>● Taille du point = nombre de lignes</div>
                <div>― Trait entre deux points = stations reliées</div>
              </div>
            </div>
          )}

          {view === 'intelligence' && (
            <div className="p-3 rounded-xl border border-border bg-card text-xs flex flex-col gap-2">
              {[
                { color: '#3b82f6', label: 'Station secondaire', note: 'peu centrale' },
                { color: '#f59e0b', label: 'Station importante', note: 'hub intermédiaire' },
                { color: '#ef4444', label: 'Hub majeur',         note: 'station très centrale' },
              ].map(({ color, label, note }) => (
                <div key={label} className="flex items-start gap-2">
                  <span className="w-3 h-3 rounded-full shrink-0 mt-0.5" style={{ background: color }} />
                  <div>
                    <span className="text-foreground font-medium">{label}</span>
                    <span className="text-muted-foreground ml-1 text-[10px]">— {note}</span>
                  </div>
                </div>
              ))}
              <div className="flex items-start gap-2 mt-1 pt-2 border-t border-border">
                <span className="w-3 h-3 rounded-full border-2 border-dashed shrink-0 mt-0.5" style={{ borderColor: '#fbbf24' }} />
                <div>
                  <span className="text-amber-300 font-medium">Station fragile</span>
                  <span className="text-muted-foreground ml-1 text-[10px]">— fermeture = coupure réseau</span>
                </div>
              </div>
              <div className="text-[10px] text-muted-foreground mt-1">Taille = degré d'importance dans les trajets</div>
            </div>
          )}

          {view === 'opportunities' && (
            <div className="p-3 rounded-xl border border-border bg-card text-xs flex flex-col gap-2">
              {(Object.entries(TIER_COLORS) as [keyof typeof TIER_COLORS, string][]).map(([tier, color]) => {
                const t = tierPlain(tier);
                return (
                  <div key={tier} className="flex items-start gap-2">
                    <span className="text-base leading-none">{t.emoji}</span>
                    <div>
                      <span className="font-medium" style={{ color }}>{t.label}</span>
                      <div className="text-muted-foreground text-[10px] leading-snug mt-0.5">{t.explain.split('—')[0]}</div>
                    </div>
                  </div>
                );
              })}
              <div className="text-[10px] text-muted-foreground mt-1 pt-2 border-t border-border">
                Taille = valeur stratégique de la station
              </div>
            </div>
          )}

          {/* Reading guide or selected node */}
          {!selectedNode ? (
            <>
              <ReadingGuide view={view} />

              {/* Quick lists (view 3, no selection) */}
              {view === 'opportunities' && (
                <div className="flex flex-col gap-3 mt-1">
                  <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">
                    Hubs à surveiller
                  </div>
                  {graph.nodes
                    .sort((a, b) => b.hubScore - a.hubScore)
                    .slice(0, 3)
                    .map((n, i) => (
                      <button key={n.id} onClick={() => { setSelectedNode(n); onSelectStop?.(n.id); }}
                        className="text-left p-2.5 rounded-xl border border-border hover:bg-secondary transition-colors">
                        <div className="flex items-center gap-1.5 text-xs">
                          <span className="text-muted-foreground font-mono">#{i + 1}</span>
                          <span className="font-semibold truncate">{n.name}</span>
                          {n.isArticulation && <AlertTriangle className="w-3 h-3 text-amber-400 shrink-0" title="Station fragile" />}
                        </div>
                        <div className="text-[10px] text-muted-foreground mt-0.5">
                          Valeur stratégique {scoreLabel(n.attractivityScore)} · Risque {scoreLabel(n.vulnerabilityScore)}
                        </div>
                      </button>
                    ))}

                  <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mt-1">
                    Zones à améliorer
                  </div>
                  {graph.nodes
                    .filter(n => n.tier === 'isolated')
                    .sort((a, b) => a.degree - b.degree)
                    .slice(0, 3)
                    .map(n => (
                      <button key={n.id} onClick={() => { setSelectedNode(n); onSelectStop?.(n.id); }}
                        className="text-left p-2.5 rounded-xl border border-border hover:bg-secondary transition-colors">
                        <div className="text-xs font-semibold truncate">🔵 {n.name}</div>
                        <div className="text-[10px] text-muted-foreground mt-0.5">
                          {n.routeCount} ligne{n.routeCount > 1 ? 's' : ''} · peu connectée — opportunité de liaison
                        </div>
                      </button>
                    ))}
                </div>
              )}
            </>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">Analyse</div>
                <button onClick={() => setSelectedNode(null)}
                  className="text-[10px] text-muted-foreground hover:text-foreground transition-colors">
                  ← Retour
                </button>
              </div>
              <NodePanel node={selectedNode} view={view} graph={graph} analysis={analysis} />
            </div>
          )}
        </div>
      </div>

      <div className="text-xs text-muted-foreground/50 text-center">
        {graph.nodes.length} stations · {graph.edges.length} liaisons · {graph.stats.articulationCount} station{graph.stats.articulationCount > 1 ? 's' : ''} fragile{graph.stats.articulationCount > 1 ? 's' : ''} détectée{graph.stats.articulationCount > 1 ? 's' : ''}
      </div>
    </div>
  );
};

export default NetworkDependencyView;
