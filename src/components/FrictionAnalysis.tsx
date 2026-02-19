import React from 'react';
import type { AnalysisResult } from '@/lib/network-analysis';

interface Props {
  analysis: AnalysisResult;
}

const FrictionAnalysis: React.FC<Props> = ({ analysis }) => {
  const { stationMetrics, networkMetrics, routes } = analysis;
  const topStations = stationMetrics.slice(0, 15);

  // Lines with most connections
  const routeConnectionCount = new Map<string, number>();
  for (const c of analysis.correspondences) {
    routeConnectionCount.set(c.routeA, (routeConnectionCount.get(c.routeA) || 0) + c.weight);
    routeConnectionCount.set(c.routeB, (routeConnectionCount.get(c.routeB) || 0) + c.weight);
  }
  const topRoutes = routes
    .map(r => ({ ...r, connections: routeConnectionCount.get(r.routeId) || 0 }))
    .sort((a, b) => b.connections - a.connections)
    .slice(0, 10);

  // Under-served: routes with fewest connections relative to stops
  const underServed = routes
    .map(r => ({
      ...r,
      connections: routeConnectionCount.get(r.routeId) || 0,
      ratio: (routeConnectionCount.get(r.routeId) || 0) / Math.max(r.stopCount, 1),
    }))
    .filter(r => r.stopCount > 2)
    .sort((a, b) => a.ratio - b.ratio)
    .slice(0, 10);

  const frictionColor = (value: number, max: number) => {
    const ratio = value / Math.max(max, 1);
    if (ratio > 0.6) return 'bg-friction-high/20 text-friction-high';
    if (ratio > 0.3) return 'bg-friction-mid/20 text-friction-mid';
    return 'bg-friction-low/20 text-friction-low';
  };

  const maxFriction = topStations[0]?.frictionIndex || 1;

  return (
    <div className="space-y-8 max-w-4xl mx-auto">
      {/* Network-level metrics */}
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-3 uppercase tracking-wider">
          Indicateurs réseau
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <MetricCard label="Lignes" value={networkMetrics.totalRoutes} />
          <MetricCard label="Arrêts" value={networkMetrics.totalStops} />
          <MetricCard label="Correspondances" value={networkMetrics.totalCorrespondences} />
          <MetricCard label="Friction moyenne" value={networkMetrics.averageFriction.toFixed(2)} />
          <MetricCard label="Redondance" value={`${(networkMetrics.networkRedundancy * 100).toFixed(1)}%`} />
          <MetricCard label="Lisibilité" value={`${(networkMetrics.readabilityScore * 100).toFixed(0)}%`} />
        </div>
      </div>

      {/* Top friction stations */}
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-3 uppercase tracking-wider">
          Stations à forte friction
        </h3>
        <div className="space-y-1">
          {topStations.map(s => (
            <div key={s.stopId} className="flex items-center gap-3 py-1.5 text-sm">
              <span className={`font-mono text-xs px-2 py-0.5 rounded ${frictionColor(s.frictionIndex, maxFriction)}`}>
                {s.frictionIndex.toFixed(2)}
              </span>
              <span className="text-foreground flex-1 truncate">{s.stopName}</span>
              <span className="text-xs text-muted-foreground font-mono">
                {s.routeCount} lignes · {s.correspondences} corr.
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Overloaded routes */}
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-3 uppercase tracking-wider">
          Lignes surchargées
        </h3>
        <div className="space-y-1">
          {topRoutes.map(r => (
            <div key={r.routeId} className="flex items-center gap-3 py-1.5 text-sm">
              <span className="font-mono text-xs font-medium text-foreground w-16 truncate">
                {r.name}
              </span>
              <div className="flex-1 bg-secondary rounded-full h-2 overflow-hidden">
                <div
                  className="h-full bg-primary/60 rounded-full"
                  style={{ width: `${Math.min(100, (r.connections / (topRoutes[0]?.connections || 1)) * 100)}%` }}
                />
              </div>
              <span className="text-xs text-muted-foreground font-mono w-16 text-right">
                {r.connections} conn.
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Under-served routes */}
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-3 uppercase tracking-wider">
          Lignes sous-desservies
        </h3>
        <div className="space-y-1">
          {underServed.map(r => (
            <div key={r.routeId} className="flex items-center gap-3 py-1.5 text-sm">
              <span className="font-mono text-xs font-medium text-foreground w-16 truncate">
                {r.name}
              </span>
              <span className="text-xs text-muted-foreground">
                {r.stopCount} arrêts · {r.connections} conn. · ratio {r.ratio.toFixed(2)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

const MetricCard: React.FC<{ label: string; value: string | number }> = ({ label, value }) => (
  <div className="metric-card">
    <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">{label}</p>
    <p className="text-lg font-semibold font-mono text-foreground">{value}</p>
  </div>
);

export default FrictionAnalysis;
