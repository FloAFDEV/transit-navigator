import React, { useState } from 'react';
import { MapPin, AlertTriangle, Route, Eye, ArrowRight, ChevronDown, ChevronUp } from 'lucide-react';
import type { AnalysisResult } from '@/lib/network-analysis';

interface Props {
  analysis: AnalysisResult;
}

interface SignageRecommendation {
  station: string;
  friction: number;
  routeCount: number;
  correspondences: number;
  level: 'critical' | 'warning' | 'info';
  actions: string[];
}

export function generateSignageRecommendations(analysis: AnalysisResult): SignageRecommendation[] {
  return analysis.stationMetrics.slice(0, 10).map(s => {
    const level: 'critical' | 'warning' | 'info' =
      s.frictionIndex > 3 ? 'critical' : s.frictionIndex > 1.5 ? 'warning' : 'info';

    const actions: string[] = [];

    if (s.frictionIndex > 3) {
      actions.push('Installer des totems d\'orientation multi-directionnels');
      actions.push('Renforcer le jalonnement au sol entre quais/arrêts');
      actions.push('Prévoir du personnel d\'accueil aux heures de pointe');
    }
    if (s.routeCount >= 5) {
      actions.push('Afficher un plan de quartier avec toutes les lignes desservies');
      actions.push('Mettre en place des écrans dynamiques d\'information voyageur');
    }
    if (s.correspondences > 5) {
      actions.push('Flécher clairement chaque correspondance avec pictogrammes modes');
      actions.push('Prévoir des itinéraires de substitution fléchés en cas de perturbation');
    }
    if (s.routeCount >= 3 && s.routeCount < 5) {
      actions.push('Installer une signalétique directionnelle standard (panneaux, flèches)');
    }
    if (s.frictionIndex <= 1.5 && s.routeCount <= 2) {
      actions.push('Signalétique minimale suffisante');
      actions.push('Indiquer clairement le hub de correspondance le plus proche');
    }

    return {
      station: s.stopName,
      friction: s.frictionIndex,
      routeCount: s.routeCount,
      correspondences: s.correspondences,
      level,
      actions,
    };
  });
}

const levelConfig = {
  critical: {
    bg: 'bg-destructive/10',
    border: 'border-destructive/30',
    badge: 'bg-destructive/20 text-destructive',
    icon: AlertTriangle,
    label: 'Critique',
  },
  warning: {
    bg: 'bg-friction-mid/10',
    border: 'border-friction-mid/30',
    badge: 'bg-friction-mid/20 text-friction-mid',
    icon: Eye,
    label: 'Attention',
  },
  info: {
    bg: 'bg-friction-low/10',
    border: 'border-friction-low/30',
    badge: 'bg-friction-low/20 text-friction-low',
    icon: MapPin,
    label: 'Standard',
  },
};

const SignageGuide: React.FC<Props> = ({ analysis }) => {
  const [expanded, setExpanded] = useState(true);
  const recommendations = generateSignageRecommendations(analysis);

  const criticalCount = recommendations.filter(r => r.level === 'critical').length;
  const warningCount = recommendations.filter(r => r.level === 'warning').length;

  return (
    <div className="bg-secondary/30 border border-border rounded-md max-w-3xl mx-auto">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-5"
      >
        <div className="flex items-center gap-3">
          <Route className="w-5 h-5 text-primary" />
          <div className="text-left">
            <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">
              Guide terrain — Recommandations signalétiques
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Traduction des métriques en actions concrètes pour le terrain
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {criticalCount > 0 && (
            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-destructive/20 text-destructive">
              {criticalCount} critique{criticalCount > 1 ? 's' : ''}
            </span>
          )}
          {warningCount > 0 && (
            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-friction-mid/20 text-friction-mid">
              {warningCount} attention
            </span>
          )}
          {expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
        </div>
      </button>

      {expanded && (
        <div className="px-5 pb-5 space-y-6">
          {/* Translation table */}
          <div className="overflow-hidden rounded-md border border-border">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-secondary/60">
                  <th className="text-left p-2 font-medium text-foreground">Ce que montre l'app</th>
                  <th className="text-left p-2 font-medium text-foreground">Traduction terrain</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                <tr>
                  <td className="p-2 text-muted-foreground">Station avec friction {'>'} 3.0</td>
                  <td className="p-2 text-foreground">Nœud critique → <strong>renforcer signalétique directionnelle</strong> (panneaux, jalonnement au sol, écrans)</td>
                </tr>
                <tr>
                  <td className="p-2 text-muted-foreground">Station avec beaucoup de correspondances</td>
                  <td className="p-2 text-foreground">Hub de transfert → <strong>ajouter plans de quartier, totems, personnel aux heures de pointe</strong></td>
                </tr>
                <tr>
                  <td className="p-2 text-muted-foreground">Ligne avec beaucoup de correspondances</td>
                  <td className="p-2 text-foreground">Ligne structurante → <strong>prévoir itinéraires de substitution fléchés</strong></td>
                </tr>
                <tr>
                  <td className="p-2 text-muted-foreground">Station périphérique isolée</td>
                  <td className="p-2 text-foreground">Desserte locale → <strong>info voyageur vers le hub le plus proche</strong></td>
                </tr>
                <tr>
                  <td className="p-2 text-muted-foreground">Redondance réseau {'<'} 20%</td>
                  <td className="p-2 text-foreground">Peu d'alternatives → <strong>communiquer itinéraires bis en cas de perturbation</strong></td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Station-by-station recommendations */}
          <div>
            <h4 className="text-xs font-semibold text-foreground uppercase tracking-wider mb-3">
              Top 10 stations — Actions recommandées
            </h4>
            <div className="space-y-2">
              {recommendations.map((rec, i) => {
                const config = levelConfig[rec.level];
                const Icon = config.icon;
                return (
                  <div key={i} className={`${config.bg} border ${config.border} rounded-md p-3`}>
                    <div className="flex items-center gap-2 mb-2">
                      <Icon className="w-3.5 h-3.5" />
                      <span className="text-xs font-semibold text-foreground">{rec.station}</span>
                      <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${config.badge}`}>
                        {config.label}
                      </span>
                      <span className="text-[10px] text-muted-foreground font-mono ml-auto">
                        friction {rec.friction.toFixed(2)} · {rec.routeCount} lignes · {rec.correspondences} corr.
                      </span>
                    </div>
                    <ul className="space-y-1 ml-5">
                      {rec.actions.map((action, j) => (
                        <li key={j} className="text-[11px] text-muted-foreground flex items-start gap-1.5">
                          <ArrowRight className="w-3 h-3 mt-0.5 flex-shrink-0 text-muted-foreground/60" />
                          {action}
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SignageGuide;
