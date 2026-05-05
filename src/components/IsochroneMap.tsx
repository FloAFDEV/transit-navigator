import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, CircleMarker, Polygon, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import type { IsochroneNode } from '@/lib/isochrone';

interface CenterStop {
  stop_lat: number;
  stop_lon: number;
  stop_name: string;
}

interface Props {
  nodes: IsochroneNode[];
  centerStop: CenterStop | null;
  selectedStopId?: string | null;
  onSelectStop?: (id: string) => void;
  stopPositions?: Map<string, [number, number]>;
}

const BAND_COLORS = ['#22c55e', '#84cc16', '#eab308', '#f97316', '#ef4444', '#a855f7'];

function bandColor(band: number): string {
  return BAND_COLORS[Math.max(0, Math.min(Math.floor(band / 5) - 1, BAND_COLORS.length - 1))];
}

function convexHull(pts: [number, number][]): [number, number][] {
  if (pts.length < 3) return pts;
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
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

// --- Stop tier classification based on accessibility rank ---
type StopTier = 'hub' | 'secondary' | 'peripheral';

const HUB_COUNT = 15;
const SECONDARY_COUNT = 60;

function classifyTiers(nodes: IsochroneNode[]): Map<string, StopTier> {
  const sorted = [...nodes].sort((a, b) => a.travelTime - b.travelTime);
  const tiers = new Map<string, StopTier>();
  sorted.forEach((n, i) => {
    if (i < HUB_COUNT) tiers.set(n.stopId, 'hub');
    else if (i < HUB_COUNT + SECONDARY_COUNT) tiers.set(n.stopId, 'secondary');
    else tiers.set(n.stopId, 'peripheral');
  });
  return tiers;
}

// --- LOD-aware stop filtering with spatial deduplication ---
const LOD_HIGH = 14;
const LOD_MID = 12;
const CELL_MID = 0.008; // ~800m
const CELL_LOW = 0.020; // ~2km
const CAP_HIGH = 150;
const CAP_MID = 75;
const CAP_LOW = 15;

function filterByLod(
  nodes: IsochroneNode[],
  tiers: Map<string, StopTier>,
  zoom: number,
  selectedStopId?: string | null,
): IsochroneNode[] {
  const isHigh = zoom >= LOD_HIGH;
  const isMid = zoom >= LOD_MID;

  const allowed: Set<StopTier> = isHigh
    ? new Set(['hub', 'secondary', 'peripheral'])
    : isMid
      ? new Set(['hub', 'secondary'])
      : new Set(['hub']);

  const cap = isHigh ? CAP_HIGH : isMid ? CAP_MID : CAP_LOW;
  const cellSize = isHigh ? 0 : isMid ? CELL_MID : CELL_LOW;

  const eligible = [...nodes]
    .filter(n => allowed.has(tiers.get(n.stopId) ?? 'peripheral'))
    .sort((a, b) => a.travelTime - b.travelTime);

  let result: IsochroneNode[];
  if (cellSize > 0) {
    const grid = new Map<string, IsochroneNode>();
    for (const node of eligible) {
      const key = `${Math.floor(node.lat / cellSize)},${Math.floor(node.lon / cellSize)}`;
      if (!grid.has(key)) grid.set(key, node);
    }
    result = Array.from(grid.values()).slice(0, cap);
  } else {
    result = eligible.slice(0, cap);
  }

  if (selectedStopId && !result.some(n => n.stopId === selectedStopId)) {
    const sel = nodes.find(n => n.stopId === selectedStopId);
    if (sel) result.push(sel);
  }

  return result;
}

// --- Visual style per tier ---
const TIER_RADIUS: Record<StopTier, number> = { hub: 8, secondary: 5, peripheral: 3 };
const TIER_WEIGHT: Record<StopTier, number> = { hub: 2, secondary: 1, peripheral: 0.5 };
const TIER_OPACITY: Record<StopTier, number> = { hub: 1, secondary: 0.85, peripheral: 0.7 };

// --- Per-band cumulative convex hulls for zone visualization ---
// Builds zones from outermost band inward so inner layers render on top.
function buildBandZones(nodes: IsochroneNode[]): { band: number; hull: [number, number][] }[] {
  const bands = [...new Set(nodes.map(n => n.band))].sort((a, b) => b - a);
  return bands
    .map(band => ({
      band,
      hull: convexHull(nodes.filter(n => n.band <= band).map(n => [n.lat, n.lon])),
    }))
    .filter(z => z.hull.length >= 3);
}

function ZoomTracker({ onZoom }: { onZoom: (z: number) => void }) {
  const map = useMap();
  useMapEvents({ zoom: () => onZoom(map.getZoom()) });
  useEffect(() => { onZoom(map.getZoom()); }, [map, onZoom]);
  return null;
}

function FitBounds({ nodes, centerStop }: { nodes: IsochroneNode[]; centerStop: CenterStop | null }) {
  const map = useMap();
  useEffect(() => {
    const pts: [number, number][] = nodes.map(n => [n.lat, n.lon]);
    if (centerStop) pts.push([centerStop.stop_lat, centerStop.stop_lon]);
    if (pts.length === 0) return;
    if (pts.length === 1) { map.setView(pts[0], 13); return; }
    const lats = pts.map(p => p[0]);
    const lons = pts.map(p => p[1]);
    map.fitBounds(
      [[Math.min(...lats), Math.min(...lons)], [Math.max(...lats), Math.max(...lons)]],
      { padding: [40, 40] },
    );
  }, [nodes, centerStop, map]);
  return null;
}

function FlyToSelected({
  selectedStopId,
  nodes,
  stopPositions,
}: {
  selectedStopId?: string | null;
  nodes: IsochroneNode[];
  stopPositions?: Map<string, [number, number]>;
}) {
  const map = useMap();
  const prevId = useRef<string | null | undefined>(null);

  useEffect(() => {
    if (!selectedStopId || selectedStopId === prevId.current) return;
    prevId.current = selectedStopId;
    const node = nodes.find(n => n.stopId === selectedStopId);
    if (node) {
      map.flyTo([node.lat, node.lon], Math.max(map.getZoom(), 14), { duration: 0.7 });
      return;
    }
    const pos = stopPositions?.get(selectedStopId);
    if (pos) map.flyTo(pos, Math.max(map.getZoom(), 14), { duration: 0.7 });
  }, [selectedStopId, nodes, stopPositions, map]);

  return null;
}

const IsochroneMap: React.FC<Props> = ({ nodes, centerStop, selectedStopId, onSelectStop, stopPositions }) => {
  const [hoveredStopId, setHoveredStopId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(12);

  const defaultCenter: [number, number] = centerStop
    ? [centerStop.stop_lat, centerStop.stop_lon]
    : [43.6, 1.44];

  const tiers = useMemo(() => classifyTiers(nodes), [nodes]);
  const bandZones = useMemo(() => buildBandZones(nodes), [nodes]);
  const visibleNodes = useMemo(
    () => filterByLod(nodes, tiers, zoom, selectedStopId),
    [nodes, tiers, zoom, selectedStopId],
  );

  return (
    <div style={{ height: 450, borderRadius: 12, overflow: 'hidden', boxShadow: '0 2px 16px rgba(0,0,0,0.13)' }}>
      <MapContainer center={defaultCenter} zoom={12} style={{ height: '100%', width: '100%' }} scrollWheelZoom>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <ZoomTracker onZoom={setZoom} />
        <FitBounds nodes={nodes} centerStop={centerStop} />
        <FlyToSelected selectedStopId={selectedStopId} nodes={nodes} stopPositions={stopPositions} />

        {/* Isochrone time-band zones — outer to inner, each layer adds depth */}
        {bandZones.map(({ band, hull }) => {
          const color = bandColor(band);
          return (
            <Polygon
              key={`zone-${band}`}
              positions={hull}
              pathOptions={{
                color,
                fillColor: color,
                fillOpacity: 0.08,
                weight: 1.5,
                opacity: 0.45,
              }}
            />
          );
        })}

        {/* Stop markers with 3-tier visual hierarchy */}
        {visibleNodes.map(node => {
          const isSelected = node.stopId === selectedStopId;
          const isHovered = node.stopId === hoveredStopId;
          const tier = tiers.get(node.stopId) ?? 'peripheral';
          const base = bandColor(node.band);
          const r = TIER_RADIUS[tier];
          return (
            <CircleMarker
              key={node.stopId}
              center={[node.lat, node.lon]}
              radius={isSelected ? r + 3 : isHovered ? r + 1 : r}
              pathOptions={{
                color: isSelected ? '#ffffff' : tier === 'hub' ? '#0f172a' : base,
                fillColor: base,
                fillOpacity: isSelected || isHovered ? 1 : TIER_OPACITY[tier],
                weight: isSelected ? 3 : TIER_WEIGHT[tier],
              }}
              eventHandlers={{
                click: () => onSelectStop?.(node.stopId),
                mouseover: () => setHoveredStopId(node.stopId),
                mouseout: () => setHoveredStopId(null),
              }}
            >
              <Tooltip>
                <strong>{node.stopName}</strong><br />
                {Math.floor(node.travelTime / 60)} min{node.travelTime % 60 > 0 ? ` ${node.travelTime % 60}s` : ''}
              </Tooltip>
            </CircleMarker>
          );
        })}

        {/* Center stop — always prominent */}
        {centerStop && (
          <CircleMarker
            center={[centerStop.stop_lat, centerStop.stop_lon]}
            radius={11}
            pathOptions={{ color: '#fff', fillColor: '#0f172a', fillOpacity: 1, weight: 2.5 }}
          >
            <Tooltip permanent direction="top">{centerStop.stop_name}</Tooltip>
          </CircleMarker>
        )}
      </MapContainer>
    </div>
  );
};

export default IsochroneMap;
