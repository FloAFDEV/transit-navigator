/**
 * AnalysisGuidePanel — panneau pédagogique de l'outil.
 *
 * Explique clairement :
 * - ce que l'application analyse (positionnement)
 * - les calculs utilisés
 * - le JES (Journey Effort Score)
 * - ce que l'application ne calcule PAS
 *
 * Accessible depuis le header via un bouton "À propos de l'analyse".
 */
import React, { useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { HelpCircle, CheckCircle2, XCircle, Info, BarChart3 } from 'lucide-react';

// ─── JES gauge ───────────────────────────────────────────────────────────────

const JES_LEVELS = [
  { range: '80–100', label: 'Fluide', color: 'hsl(142, 71%, 45%)', bg: 'bg-green-500', example: 'Trajet direct, 0 correspondance, <15 min' },
  { range: '60–79',  label: 'Modéré', color: 'hsl(174, 62%, 42%)', bg: 'bg-teal-500',  example: '1 correspondance simple, attente raisonnable' },
  { range: '40–59',  label: 'Complexe', color: 'hsl(38, 92%, 50%)', bg: 'bg-amber-500', example: '2 correspondances ou attente prolongée' },
  { range: '20–39',  label: 'Difficile', color: 'hsl(24, 90%, 52%)', bg: 'bg-orange-500', example: 'Parcours fragmenté, forte attente, >40 min' },
  { range: '0–19',   label: 'Critique',  color: 'hsl(0, 72%, 51%)',  bg: 'bg-red-500',  example: 'Multiples ruptures, attente >30 min par tronçon' },
];

const JesGauge: React.FC = () => (
  <div className="space-y-2">
    <div className="flex h-3 rounded-full overflow-hidden">
      {JES_LEVELS.map(l => (
        <div key={l.label} className={`flex-1 ${l.bg}`} />
      ))}
    </div>
    <div className="flex justify-between text-[9px] text-muted-foreground">
      <span>0 — Critique</span>
      <span>50 — Complexe</span>
      <span>100 — Fluide</span>
    </div>
    <div className="grid gap-1.5 mt-2">
      {JES_LEVELS.map(l => (
        <div key={l.label} className="flex items-start gap-2 text-[10px]">
          <span className="w-16 flex-shrink-0 font-mono text-muted-foreground">{l.range}</span>
          <span className="font-semibold" style={{ color: l.color }}>{l.label}</span>
          <span className="text-muted-foreground">— {l.example}</span>
        </div>
      ))}
    </div>
  </div>
);

// ─── Sections ─────────────────────────────────────────────────────────────────

type GuideTab = 'presentation' | 'calculs' | 'jes' | 'limites';

const TAB_LABELS: { key: GuideTab; label: string }[] = [
  { key: 'presentation', label: 'Présentation' },
  { key: 'calculs',      label: 'Calculs' },
  { key: 'jes',          label: 'Score JES' },
  { key: 'limites',      label: 'Limites' },
];

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="space-y-2">
    <h3 className="text-sm font-semibold text-foreground">{title}</h3>
    {children}
  </div>
);

const Item: React.FC<{ icon?: React.ReactNode; children: React.ReactNode }> = ({ icon, children }) => (
  <div className="flex items-start gap-2 text-xs text-muted-foreground leading-relaxed">
    <span className="flex-shrink-0 mt-0.5">{icon ?? <span className="w-3.5 h-3.5 inline-block" />}</span>
    <span>{children}</span>
  </div>
);

// ─── Main component ───────────────────────────────────────────────────────────

const AnalysisGuidePanel: React.FC = () => {
  const [tab, setTab] = useState<GuideTab>('presentation');

  return (
    <Sheet>
      <SheetTrigger asChild>
        <button
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-secondary text-secondary-foreground hover:bg-accent transition-colors"
          title="Comprendre l'analyse — positionnement, calculs, limites"
        >
          <HelpCircle className="w-3.5 h-3.5" />
          Guide
        </button>
      </SheetTrigger>

      <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader className="mb-4">
          <SheetTitle className="text-base font-semibold">Guide d'analyse</SheetTitle>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Comprendre ce que l'application calcule, comment interpréter les résultats,
            et ce qu'elle ne fait pas.
          </p>
        </SheetHeader>

        {/* Tab bar */}
        <div className="flex gap-1 mb-5 bg-secondary/40 rounded-lg p-0.5">
          {TAB_LABELS.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${
                tab === t.key
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Présentation */}
        {tab === 'presentation' && (
          <div className="space-y-5">
            <Section title="Positionnement de l'outil">
              <p className="text-xs text-muted-foreground leading-relaxed">
                Cet outil analyse la <strong className="text-foreground">structure, la connectivité et la complexité perçue</strong> d'un réseau de transport à partir de données GTFS brutes.
              </p>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Il ne s'agit pas d'un calculateur d'itinéraire grand public ni d'un GPS piéton.
                C'est un <strong className="text-foreground">outil d'analyse opérationnelle réseau</strong> à destination des professionnels du transport et de la signalétique.
              </p>
            </Section>

            <Section title="Ce que l'application identifie">
              {[
                'Les hubs structurants du réseau (centralité, betweenness)',
                'Les correspondances à fort coût perçu pour le voyageur',
                'Les ruptures de connectivité et branches isolées',
                'Les zones de friction sur les trajets fréquents',
                'Les lignes et corridors qui dominent le réseau',
                'Les trajets cognitivement complexes (trop de changements)',
                'Les composantes connexes et sous-réseaux déconnectés',
              ].map(item => (
                <Item key={item} icon={<CheckCircle2 className="w-3.5 h-3.5 text-green-500" />}>{item}</Item>
              ))}
            </Section>

            <Section title="Cas d'usage professionnels">
              <div className="grid grid-cols-2 gap-2">
                {[
                  { title: 'Audit réseau', desc: 'Identifier les points faibles structurels' },
                  { title: 'Refonte signalétique', desc: 'Prioriser les nœuds de complexité élevée' },
                  { title: 'Études de cas PMR', desc: 'Repérer les ruptures de parcours accessible' },
                  { title: 'Benchmarking', desc: 'Comparer la qualité de correspondance entre réseaux' },
                ].map(c => (
                  <div key={c.title} className="bg-secondary/40 rounded-lg p-3">
                    <div className="text-xs font-semibold text-foreground mb-0.5">{c.title}</div>
                    <div className="text-[10px] text-muted-foreground">{c.desc}</div>
                  </div>
                ))}
              </div>
            </Section>
          </div>
        )}

        {/* Calculs */}
        {tab === 'calculs' && (
          <div className="space-y-5">
            <Section title="Données sources">
              <Item icon={<Info className="w-3.5 h-3.5 text-blue-400" />}>
                Tous les calculs sont dérivés <strong className="text-foreground">exclusivement des fichiers GTFS</strong> : stop_times.txt, trips.txt, routes.txt, stops.txt, et optionnellement transfers.txt et pathways.txt.
              </Item>
              <Item icon={<Info className="w-3.5 h-3.5 text-blue-400" />}>
                Aucune donnée externe n'est utilisée. Aucune IA générative. Les résultats sont <strong className="text-foreground">100% déterministes</strong>.
              </Item>
            </Section>

            <Section title="Calculs utilisés">
              {[
                { name: 'Temps réseau GTFS',         desc: 'Temps de trajet entre arrêts consécutifs extrait de stop_times (departure_time − arrival_time)' },
                { name: 'Graphe de connectivité',    desc: 'Graphe non orienté agrégé à la maille parent_station, avec détection de composantes connexes par BFS' },
                { name: 'Dijkstra multi-source',     desc: 'Chemin optimal depuis une station centrale vers toutes les stations accessibles dans un rayon-temps donné' },
                { name: 'Centralité (betweenness)',  desc: 'Fréquence à laquelle une station se trouve sur le chemin le plus court entre deux autres stations' },
                { name: 'Correspondances',           desc: 'Changements de ligne détectés via l\'overlap des route_ids sur les arêtes consécutives du chemin' },
                { name: 'Score JES',                 desc: 'Coût perçu normalisé 0–100 combinant temps, correspondances, attente et friction (si pathways disponibles)' },
                { name: 'Alternatives de trajet',    desc: 'Chemins alternatifs via exploration des voisins du nœud origine et suppression sélective d\'arêtes' },
                { name: 'Corridors parallèles',      desc: 'Paires de lignes partageant ≥3 arrêts représentatifs en séquence' },
              ].map(item => (
                <div key={item.name} className="border-b border-border/50 pb-2 last:border-0 last:pb-0">
                  <div className="text-xs font-semibold text-foreground">{item.name}</div>
                  <div className="text-[10px] text-muted-foreground mt-0.5 leading-relaxed">{item.desc}</div>
                </div>
              ))}
            </Section>

            <Section title="Agrégation des arrêts">
              <Item icon={<Info className="w-3.5 h-3.5 text-blue-400" />}>
                Les stop_ids enfants (quais, directions) sont agrégés à leur parent_station.
                Les coordonnées affichées sont le <strong className="text-foreground">centroïde</strong> des arrêts physiques de la station.
              </Item>
            </Section>
          </div>
        )}

        {/* JES */}
        {tab === 'jes' && (
          <div className="space-y-5">
            <Section title="Journey Effort Score (JES)">
              <p className="text-xs text-muted-foreground leading-relaxed">
                Le JES mesure le <strong className="text-foreground">coût cognitif et physique perçu</strong> d'un trajet.
                Il ne dépend pas uniquement du temps réel, mais intègre les facteurs qui augmentent la charge mentale du voyageur.
              </p>
            </Section>

            <Section title="Composantes du score">
              {[
                { label: 'Temps de trajet',          weight: 'poids ×1.0', desc: 'Base neutre — la durée réelle du transport' },
                { label: 'Correspondances',           weight: 'poids ×1.8', desc: 'Chaque changement de ligne est perçu plus long (cognitive load)' },
                { label: 'Temps d\'attente',          weight: 'poids ×2.0', desc: 'L\'attente sur quai est sur-évaluée par le voyageur' },
                { label: 'Friction physique',         weight: 'poids ×2.5', desc: 'Escaliers étroits, couloirs longs (si pathways.txt disponible)' },
                { label: 'Barrières accessibilité',  weight: 'poids ×3.0', desc: 'Absence d\'ascenseur, pentes, largeurs insuffisantes (si pathways.txt)' },
              ].map(c => (
                <div key={c.label} className="flex items-start gap-3 text-[10px] border-b border-border/40 pb-2 last:border-0">
                  <div className="flex-1">
                    <span className="font-semibold text-foreground">{c.label}</span>
                    <span className="ml-2 text-muted-foreground/60 font-mono text-[9px]">{c.weight}</span>
                    <div className="text-muted-foreground mt-0.5">{c.desc}</div>
                  </div>
                </div>
              ))}
            </Section>

            <Section title="Niveaux de score">
              <JesGauge />
            </Section>

            <Section title="Interprétation opérationnelle">
              <p className="text-xs text-muted-foreground leading-relaxed">
                Un JES inférieur à 40 indique un trajet qui nécessite une <strong className="text-foreground">attention signalétique prioritaire</strong> :
                jalonnement directionnel aux nœuds de correspondance, affichage temps réel,
                personnel d'orientation aux heures de pointe.
              </p>
            </Section>
          </div>
        )}

        {/* Limites */}
        {tab === 'limites' && (
          <div className="space-y-5">
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/8 p-4">
              <div className="flex items-center gap-2 mb-2">
                <XCircle className="w-4 h-4 text-amber-500 flex-shrink-0" />
                <span className="text-sm font-semibold text-foreground">Ce que l'app ne calcule pas</span>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                L'application <strong className="text-foreground">ne calcule pas</strong> les cheminements piétons réels sauf présence explicite de <code className="font-mono text-[10px] bg-secondary px-1 rounded">pathways.txt</code> dans le GTFS.
              </p>
            </div>

            <Section title="Non calculé sans pathways.txt">
              {[
                'Escaliers et couloirs internes à la station',
                'Distances physiques réelles entre quais',
                'Parcours PMR certifié (accessibilité fauteuil)',
                'Temps de marche entre arrêts distincts',
                'Hauteur des marches, pentes, largeurs réelles',
              ].map(item => (
                <Item key={item} icon={<XCircle className="w-3.5 h-3.5 text-red-400" />}>{item}</Item>
              ))}
            </Section>

            <Section title="Approximations à connaître">
              {[
                'Les temps réseau GTFS reflètent les horaires planifiés, pas le trafic réel.',
                'Les temps d\'attente estimés sont des moyennes théoriques (fréquence / 2) — pas les attentes réelles.',
                'Les correspondances sont détectées via les route_ids — une même ligne avec deux IDs distincts sera vue comme un changement.',
                'Le JES est un indicateur comparatif, pas une mesure absolue certifiée.',
                'Les composantes connexes reflètent les données GTFS, pas nécessairement la réalité terrain (arrêts non renseignés, etc.).',
              ].map(item => (
                <Item key={item} icon={<Info className="w-3.5 h-3.5 text-blue-400" />}>{item}</Item>
              ))}
            </Section>

            <Section title="Confiance des données">
              <div className="grid grid-cols-3 gap-2 text-center">
                {[
                  { file: 'stop_times.txt', trust: 'Haute', color: 'text-green-500' },
                  { file: 'transfers.txt',  trust: 'Moyenne', color: 'text-amber-500' },
                  { file: 'pathways.txt',   trust: 'Haute si présent', color: 'text-blue-400' },
                ].map(f => (
                  <div key={f.file} className="bg-secondary/40 rounded p-2">
                    <div className="text-[9px] font-mono text-muted-foreground">{f.file}</div>
                    <div className={`text-[10px] font-semibold mt-0.5 ${f.color}`}>{f.trust}</div>
                  </div>
                ))}
              </div>
            </Section>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
};

export default AnalysisGuidePanel;
