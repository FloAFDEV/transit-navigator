import React, { useMemo } from 'react';
import { X, MapPin, Clock, Activity, BarChart2 } from 'lucide-react';
import type { AnalysisResult } from '@/lib/network-analysis';
import type { GtfsStop } from '@/lib/gtfs-types';
import type { IsochroneNode } from '@/lib/isochrone';
import IsochroneMap from './IsochroneMap';
import { generateNarrative } from '@/lib/narrative';

interface Props {
  analysis: AnalysisResult;
  stops: GtfsStop[];
  isochroneNodes: IsochroneNode[];
  centerStop: GtfsStop | null;
  maxMin: number;
  fileName: string;
  onExit: () => void;
}

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function polygonAreaM2(pts: [number, number][]): number {
  let area = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const latM = ((pts[i][0] + pts[j][0]) / 2) * Math.PI / 180;
    const dx = haversine(pts[i][0], pts[i][1], pts[i][0], pts[j][1]);
    const dy = haversine(pts[i][0], pts[i][1], pts[j][0], pts[i][1]);
    const signedDx = pts[j][1] > pts[i][1] ? dx : -dx;
    const signedDy = pts[j][0] > pts[i][0] ? dy : -dy;
    area += signedDx * signedDy;
    void latM;
  }
  return Math.abs(area) / 2;
}

function convexHullArea(nodes: IsochroneNode[]): number {
  if (nodes.length < 3) return 0;
  const pts: [number, number][] = nodes.map(n => [n.lat, n.lon]);
  const sorted = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (const p of [...sorted].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  const hull = [...lower, ...upper];
  return polygonAreaM2(hull);
}

const MetricCard: React.FC<{ icon: React.ReactNode; label: string; value: string; sub?: string }> = ({ icon, label, value, sub }) => (
  <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-5 flex flex-col gap-2">
    <div className="flex items-center gap-2 text-slate-400 text-xs font-medium uppercase tracking-wide">
      {icon}
      {label}
    </div>
    <div className="text-3xl font-bold text-slate-900">{value}</div>
    {sub && <div className="text-xs text-slate-400">{sub}</div>}
  </div>
);

const PresentationView: React.FC<Props> = ({
  analysis,
  isochroneNodes,
  centerStop,
  maxMin,
  fileName,
  onExit,
}) => {
  const m = analysis.networkMetrics;

  const coverageKm2 = useMemo(() => {
    const area = convexHullArea(isochroneNodes);
    return (area / 1_000_000).toFixed(1);
  }, [isochroneNodes]);

  const medianTravelMin = useMemo(() => {
    if (isochroneNodes.length === 0) return null;
    const sorted = [...isochroneNodes].sort((a, b) => a.travelTime - b.travelTime);
    return Math.round(sorted[Math.floor(sorted.length / 2)].travelTime / 60);
  }, [isochroneNodes]);

  const narrative = useMemo(() => generateNarrative(analysis, null), [analysis]);
  const shortNarrative = useMemo(() => {
    const lines = narrative.split('\n').filter(l => l.trim() && l !== '---');
    return lines.slice(0, 6).join('\n');
  }, [narrative]);

  const renderLine = (line: string, i: number) => {
    if (line.trim() === '') return <br key={i} />;
    const parts = line.split(/(\*\*[^*]+\*\*)/g);
    return (
      <p key={i} className="text-sm text-slate-600 leading-relaxed">
        {parts.map((part, j) =>
          part.startsWith('**') && part.endsWith('**')
            ? <strong key={j} className="text-slate-800">{part.slice(2, -2)}</strong>
            : part
        )}
      </p>
    );
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-5xl mx-auto px-6 py-10">
        <div className="flex items-start justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Analyse d'accessibilité transport</h1>
            <p className="text-sm text-slate-400 mt-1 font-mono">{fileName}</p>
          </div>
          <button
            onClick={onExit}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-slate-200 hover:bg-slate-300 text-slate-600 transition-colors"
          >
            <X className="w-3.5 h-3.5" />
            Quitter la présentation
          </button>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <MetricCard
            icon={<MapPin className="w-3.5 h-3.5" />}
            label="Arrêts accessibles"
            value={String(isochroneNodes.length || m.totalStops)}
            sub={isochroneNodes.length ? `en ≤ ${maxMin} min` : 'total réseau'}
          />
          <MetricCard
            icon={<Clock className="w-3.5 h-3.5" />}
            label="Temps médian"
            value={medianTravelMin !== null ? `${medianTravelMin} min` : `${maxMin} min`}
            sub="temps de trajet médian"
          />
          <MetricCard
            icon={<Activity className="w-3.5 h-3.5" />}
            label="Couverture"
            value={`${coverageKm2} km²`}
            sub="zone desservie (hull)"
          />
          <MetricCard
            icon={<BarChart2 className="w-3.5 h-3.5" />}
            label="Score réseau"
            value={`${(m.readabilityScore * 100).toFixed(0)}%`}
            sub={`${m.totalRoutes} lignes · ${m.totalCorrespondences} corr.`}
          />
        </div>

        {isochroneNodes.length > 0 && (
          <div className="rounded-2xl overflow-hidden shadow-md mb-8">
            <IsochroneMap nodes={isochroneNodes} centerStop={centerStop} />
          </div>
        )}

        <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-6">
          <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wide mb-4">Synthèse réseau</h2>
          <div className="flex flex-col gap-1">
            {shortNarrative.split('\n').map((line, i) => renderLine(line, i))}
          </div>
          <div className="mt-4 pt-4 border-t border-slate-100 grid grid-cols-3 gap-4 text-center">
            <div>
              <div className="text-xl font-bold text-slate-900">{m.totalRoutes}</div>
              <div className="text-xs text-slate-400 mt-0.5">Lignes</div>
            </div>
            <div>
              <div className="text-xl font-bold text-slate-900">{m.totalStops}</div>
              <div className="text-xs text-slate-400 mt-0.5">Arrêts</div>
            </div>
            <div>
              <div className="text-xl font-bold text-slate-900">{m.averageFriction.toFixed(2)}</div>
              <div className="text-xs text-slate-400 mt-0.5">Friction moy.</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PresentationView;
