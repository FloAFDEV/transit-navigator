import React, { useState } from 'react';
import type { AnalysisResult, RouteInfo } from '@/lib/network-analysis';
import { modeColors, modeLabels } from '@/lib/gtfs-types';
import { X, Download, ChevronDown, ChevronRight } from 'lucide-react';
import InfoTooltip from './InfoTooltip';
import { exportRouteStationsCsv, exportRouteCorrespondencesCsv } from '@/lib/csv-export';

interface Props {
  routeId: string;
  analysis: AnalysisResult;
  onClose: () => void;
}

const RouteDetailPanel: React.FC<Props> = ({ routeId, analysis, onClose }) => {
  const [showStations, setShowStations] = useState(false);
  const route = analysis.routes.find(r => r.routeId === routeId);
  if (!route) return null;

  const routeCorrespondences = analysis.correspondences
    .filter(c => c.routeA === routeId || c.routeB === routeId)
    .sort((a, b) => b.weight - a.weight);

  const totalCorrespondenceWeight = routeCorrespondences.reduce((s, c) => s + c.weight, 0);

  const connectedRoutes = routeCorrespondences.map(c => {
    const otherId = c.routeA === routeId ? c.routeB : c.routeA;
    const otherRoute = analysis.routes.find(r => r.routeId === otherId);
    // Find station names for shared stops
    const stationNames = c.sharedStops.map(sid => {
      const sm = analysis.stationMetrics.find(s => s.stopId === sid);
      return sm?.stopName || sid;
    });
    return { route: otherRoute, sharedStops: c.sharedStops.length, weight: c.weight, stationNames };
  }).filter(cr => cr.route);

  // Analytical metrics
  const allConnectionCounts = new Map<string, number>();
  for (const c of analysis.correspondences) {
    allConnectionCounts.set(c.routeA, (allConnectionCounts.get(c.routeA) || 0) + c.weight);
    allConnectionCounts.set(c.routeB, (allConnectionCounts.get(c.routeB) || 0) + c.weight);
  }
  const myConnections = allConnectionCounts.get(routeId) || 0;
  const maxConnections = Math.max(...Array.from(allConnectionCounts.values()), 1);
  const complexityIndex = route.stopCount > 0 ? totalCorrespondenceWeight / route.stopCount : 0;
  const totalNetworkCorr = analysis.correspondences.length;
  const centrality = totalNetworkCorr > 0 ? routeCorrespondences.length / totalNetworkCorr : 0;
  const redundancy = analysis.routes.length > 1 ? connectedRoutes.length / (analysis.routes.length - 1) : 0;

  // Station list from route stops
  const stationList = Array.from(route.stops).map(stopId => {
    const sm = analysis.stationMetrics.find(s => s.stopId === stopId);
    return {
      stopId,
      name: sm?.stopName || stopId,
      routeCount: sm?.routeCount ?? 0,
      friction: sm?.frictionIndex ?? 0,
    };
  }).sort((a, b) => b.routeCount - a.routeCount);

  const criticalStations = analysis.stationMetrics
    .filter(sm => sm.routeCount >= 2)
    .slice(0, 8);

  const color = route.color || modeColors[route.mode];

  return (
    <div className="w-80 border-l border-border bg-card overflow-y-auto max-h-[calc(100vh-7rem)]">
      {/* Header */}
      <div className="sticky top-0 bg-card border-b border-border px-4 py-3 flex items-center justify-between z-10">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
          <span className="text-sm font-semibold text-foreground truncate">{route.name}</span>
          <span className="text-xs text-muted-foreground flex-shrink-0">{modeLabels[route.mode]}</span>
        </div>
        <button onClick={onClose} className="p-1 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors flex-shrink-0" title="Fermer">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="p-4 space-y-5">
        {/* General info */}
        <Section title="Informations générales">
          <InfoRow label="Identifiant" value={route.routeId} />
          <InfoRow label="Mode" value={modeLabels[route.mode]} />
          <InfoRow label="Stations" value={route.stopCount} />
          <InfoRow label="Trajets" value={route.tripCount} />
          <InfoRow label="Correspondances" value={routeCorrespondences.length} />
        </Section>

        {/* Analytical metrics */}
        <Section title="Indicateurs analytiques">
          <MetricRow label="Complexité perçue" value={complexityIndex.toFixed(2)} tooltip="Indice de friction" description="Ratio correspondances / stations" />
          <MetricRow label="Centralité" value={`${(centrality * 100).toFixed(1)}%`} tooltip="Centralité" description="Part des correspondances réseau" />
          <MetricRow label="Redondance" value={`${(redundancy * 100).toFixed(1)}%`} tooltip="Redondance" description="Proportion de lignes connectées" />
          <MetricRow label="Poids connexion" value={myConnections} description={`Sur un max de ${maxConnections}`} />
          <div className="mt-1">
            <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
              <div className="h-full bg-primary/70 rounded-full" style={{ width: `${(myConnections / maxConnections) * 100}%` }} />
            </div>
          </div>
        </Section>

        {/* Station list (collapsible) */}
        <Section title={
          <button onClick={() => setShowStations(!showStations)} className="flex items-center gap-1 w-full text-left">
            {showStations ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            Stations ({stationList.length})
          </button>
        }>
          {showStations && (
            <>
              <div className="flex justify-end mb-1">
                <button
                  onClick={() => exportRouteStationsCsv(route, analysis)}
                  className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Download className="w-3 h-3" /> CSV
                </button>
              </div>
              <div className="space-y-0.5 max-h-56 overflow-y-auto">
                {stationList.map(s => (
                  <div key={s.stopId} className="flex items-center gap-2 py-0.5 text-xs">
                    <span className="text-foreground truncate flex-1">{s.name}</span>
                    <span className="text-muted-foreground font-mono flex-shrink-0 text-[10px]">
                      {s.routeCount > 1 ? `${s.routeCount} lg` : ''}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </Section>

        {/* Connected routes with station names */}
        <Section title={
          <div className="flex items-center justify-between w-full">
            <span>Correspondances ({connectedRoutes.length})</span>
            {connectedRoutes.length > 0 && (
              <button
                onClick={() => exportRouteCorrespondencesCsv(routeId, analysis)}
                className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors font-normal normal-case tracking-normal"
              >
                <Download className="w-3 h-3" /> CSV
              </button>
            )}
          </div>
        }>
          {connectedRoutes.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">Aucune correspondance détectée</p>
          ) : (
            <div className="space-y-2 max-h-56 overflow-y-auto">
              {connectedRoutes.map(cr => (
                <div key={cr.route!.routeId} className="py-1">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: cr.route!.color || modeColors[cr.route!.mode] }} />
                    <span className="text-foreground truncate flex-1">{cr.route!.name}</span>
                    <span className="text-muted-foreground font-mono flex-shrink-0">{cr.sharedStops} st.</span>
                  </div>
                  {cr.stationNames.length > 0 && (
                    <p className="text-[10px] text-muted-foreground ml-4 mt-0.5 truncate">
                      via {cr.stationNames.slice(0, 3).join(', ')}{cr.stationNames.length > 3 ? '…' : ''}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* Critical stations */}
        <Section title="Stations critiques">
          <p className="text-xs text-muted-foreground mb-2">
            Stations à forte centralité — rôle de hub ou goulot.
          </p>
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {criticalStations.map(s => (
              <div key={s.stopId} className="flex items-center gap-2 py-1 text-xs">
                <span className="text-foreground truncate flex-1">{s.stopName}</span>
                <span className="text-muted-foreground font-mono flex-shrink-0">
                  {s.routeCount} lg · {s.correspondences.toFixed(0)} corr.
                </span>
              </div>
            ))}
          </div>
        </Section>
      </div>
    </div>
  );
};

const Section: React.FC<{ title: string | React.ReactNode; children: React.ReactNode }> = ({ title, children }) => (
  <div>
    <h4 className="text-xs font-semibold text-foreground uppercase tracking-wider mb-2">
      {title}
    </h4>
    {children}
  </div>
);

const InfoRow: React.FC<{ label: string; value: string | number }> = ({ label, value }) => (
  <div className="flex justify-between py-0.5 text-xs">
    <span className="text-muted-foreground">{label}</span>
    <span className="text-foreground font-mono">{value}</span>
  </div>
);

const MetricRow: React.FC<{ label: string; value: string | number; tooltip?: string; description?: string }> = ({ label, value, tooltip, description }) => (
  <div className="py-1">
    <div className="flex justify-between text-xs">
      <span className="text-muted-foreground">
        {label}
        {tooltip && <InfoTooltip term={tooltip} />}
      </span>
      <span className="text-foreground font-semibold font-mono">{value}</span>
    </div>
    {description && <p className="text-[10px] text-muted-foreground mt-0.5">{description}</p>}
  </div>
);

export default RouteDetailPanel;
