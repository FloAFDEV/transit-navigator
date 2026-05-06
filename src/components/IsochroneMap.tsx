import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, CircleMarker, Tooltip, LayerGroup, useMap, useMapEvents } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import type { IsochroneNode } from '@/lib/isochrone';
import type { GtfsStop } from '@/lib/gtfs-types';

interface CenterStop {
  stop_lat: number;
  stop_lon: number;
  stop_name: string;
}

interface Props {
  nodes: IsochroneNode[];
  allStops?: GtfsStop[];
  centerStop: CenterStop | null;
  selectedStopId?: string | null;
  onSelectStop?: (id: string) => void;
  onSetCenter?: (stopId: string) => void;
  stopPositions?: Map<string, [number, number]>;
}

// ─── Time bucket visual mapping ───────────────────────────────────────────────
//
// Each band maps to a UNIQUE combination of color + base radius + opacity.
// Strong visual differentiation is mandatory — no two bands share the same style.
//
// baseRadius is scaled by zoomScale() before rendering.

interface BucketStyle {
  color: string;
  baseRadius: number;
  fillOpacity: number;
  weight: number;
}

const BUCKET_STYLES: Record<number, BucketStyle> = {
   5: { color: '#15803d', baseRadius: 12, fillOpacity: 1.00, weight: 2.0 }, // vert foncé — immédiat
  10: { color: '#65a30d', baseRadius:  9, fillOpacity: 0.88, weight: 1.6 }, // lime
  15: { color: '#ca8a04', baseRadius:  7, fillOpacity: 0.75, weight: 1.3 }, // ambre
  20: { color: '#ea580c', baseRadius:  6, fillOpacity: 0.60, weight: 1.0 }, // orange
  25: { color: '#dc2626', baseRadius:  5, fillOpacity: 0.46, weight: 0.8 }, // rouge
  99: { color: '#7c3aed', baseRadius:  4, fillOpacity: 0.32, weight: 0.6 }, // violet — lointain
};

function bucketStyle(band: number): BucketStyle {
  if (band <=  5) return BUCKET_STYLES[5];
  if (band <= 10) return BUCKET_STYLES[10];
  if (band <= 15) return BUCKET_STYLES[15];
  if (band <= 20) return BUCKET_STYLES[20];
  if (band <= 25) return BUCKET_STYLES[25];
  return BUCKET_STYLES[99];
}

// ─── Zoom → radius scaling ────────────────────────────────────────────────────
//
// Inverse relationship: lower zoom (overview) = larger dots for legibility,
// higher zoom (street detail) = smaller dots to avoid overplotting.
//
//   zoom  9 → ×1.70   zoom 12 → ×1.10   zoom 15 → ×0.62
//   zoom 10 → ×1.50   zoom 13 → ×0.90   zoom 16 → ×0.50
//   zoom 11 → ×1.28   zoom 14 → ×0.75

function zoomScale(zoom: number): number {
  if (zoom <=  9) return 1.70;
  if (zoom <= 10) return 1.50;
  if (zoom <= 11) return 1.28;
  if (zoom <= 12) return 1.10;
  if (zoom <= 13) return 0.90;
  if (zoom <= 14) return 0.75;
  if (zoom <= 15) return 0.62;
  return 0.50;
}

function scaledRadius(base: number, zoom: number): number {
  return Math.max(2, Math.round(base * zoomScale(zoom)));
}

// ─── Reachable stop LOD filtering ────────────────────────────────────────────
//
// Grid deduplication: keeps the most accessible stop per spatial cell.
// Cap rises with zoom so dense areas reveal more detail on close inspection.

const REACH_CAPS  = { low: 40, mid: 150, high: 500 } as const;
const REACH_CELLS = { low: 0.020, mid: 0.007, high: 0 } as const;

function filterReachable(
  nodes: IsochroneNode[],
  zoom: number,
  selectedStopId?: string | null,
): IsochroneNode[] {
  const level    = zoom >= 14 ? 'high' : zoom >= 12 ? 'mid' : 'low';
  const cap      = REACH_CAPS[level];
  const cellSize = REACH_CELLS[level];

  const sorted = [...nodes].sort((a, b) => a.travelTime - b.travelTime);

  let result: IsochroneNode[];
  if (cellSize > 0) {
    const grid = new Map<string, IsochroneNode>();
    for (const node of sorted) {
      const key = `${Math.floor(node.lat / cellSize)},${Math.floor(node.lon / cellSize)}`;
      if (!grid.has(key)) grid.set(key, node);
    }
    result = Array.from(grid.values()).slice(0, cap);
  } else {
    result = sorted.slice(0, cap);
  }

  if (selectedStopId && !result.some(n => n.stopId === selectedStopId)) {
    const sel = nodes.find(n => n.stopId === selectedStopId);
    if (sel) result.push(sel);
  }

  return result;
}

// ─── Background (unreachable) stop sampling ───────────────────────────────────
//
// Hidden at zoom < 12 — at low zoom they add noise without value.
// Grid-sampled at mid zoom, uncapped at high zoom.

const BG_CELL_MID = 0.010;
const BG_CAP      = 300;

function sampleBackground(
  allStops: GtfsStop[],
  reachableIds: Set<string>,
  zoom: number,
): GtfsStop[] {
  if (zoom < 12) return []; // hidden at overview zoom

  let candidates = allStops.filter(
    s => !reachableIds.has(s.stop_id) && !(s.stop_lat === 0 && s.stop_lon === 0),
  );

  if (zoom < 14) {
    const grid = new Map<string, GtfsStop>();
    for (const s of candidates) {
      const key = `${Math.floor(s.stop_lat / BG_CELL_MID)},${Math.floor(s.stop_lon / BG_CELL_MID)}`;
      if (!grid.has(key)) grid.set(key, s);
    }
    candidates = Array.from(grid.values());
  }

  return candidates.slice(0, BG_CAP);
}

// ─── Map utilities ────────────────────────────────────────────────────────────

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

// ─── Legend ───────────────────────────────────────────────────────────────────

const LEGEND_ITEMS = [
  { label: '0–5 min',  style: BUCKET_STYLES[5]  },
  { label: '5–10 min', style: BUCKET_STYLES[10] },
  { label: '10–15 min',style: BUCKET_STYLES[15] },
  { label: '15–20 min',style: BUCKET_STYLES[20] },
  { label: '20–25 min',style: BUCKET_STYLES[25] },
  { label: '25+ min',  style: BUCKET_STYLES[99] },
];

// ─── Component ────────────────────────────────────────────────────────────────

const IsochroneMap: React.FC<Props> = ({
  nodes, allStops, centerStop, selectedStopId, onSelectStop, onSetCenter, stopPositions,
}) => {
  const [hoveredStopId, setHoveredStopId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(12);

  const defaultCenter: [number, number] = centerStop
    ? [centerStop.stop_lat, centerStop.stop_lon]
    : [43.6, 1.44];

  const reachableIds = useMemo(() => new Set(nodes.map(n => n.stopId)), [nodes]);

  // Layer 1 — unreachable background (hidden at zoom < 12).
  const backgroundStops = useMemo(
    () => (allStops ? sampleBackground(allStops, reachableIds, zoom) : []),
    [allStops, reachableIds, zoom],
  );

  // Layer 2 — reachable stops, LOD-filtered per zoom.
  const visibleReachable = useMemo(
    () => filterReachable(nodes, zoom, selectedStopId),
    [nodes, zoom, selectedStopId],
  );

  const scale = zoomScale(zoom);

  return (
    <div style={{ position: 'relative', height: 450, borderRadius: 12, overflow: 'hidden', boxShadow: '0 2px 16px rgba(0,0,0,0.13)' }}>
      <MapContainer center={defaultCenter} zoom={12} style={{ height: '100%', width: '100%' }} scrollWheelZoom>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <ZoomTracker onZoom={setZoom} />
        <FitBounds nodes={nodes} centerStop={centerStop} />
        <FlyToSelected selectedStopId={selectedStopId} nodes={nodes} stopPositions={stopPositions} />

        {/* ── LAYER 1 : unreachable (contexte réseau, masqué à faible zoom) ── */}
        <LayerGroup>
          {backgroundStops.map(s => (
            <CircleMarker
              key={`bg-${s.stop_id}`}
              center={[s.stop_lat, s.stop_lon]}
              radius={Math.max(1, Math.round(2 * scale))}
              pathOptions={{
                color:       'transparent',
                fillColor:   '#94a3b8',
                fillOpacity: 0.18,
                weight:      0,
              }}
            />
          ))}
        </LayerGroup>

        {/* ── LAYER 2 : reachable (stylé par tranche de temps) ─────────────── */}
        <LayerGroup>
          {visibleReachable.map(node => {
            const isSelected = node.stopId === selectedStopId;
            const isHovered  = node.stopId === hoveredStopId;
            const bs         = bucketStyle(node.band);
            const r          = scaledRadius(bs.baseRadius, zoom);
            const mins       = Math.floor(node.travelTime / 60);
            const secs       = node.travelTime % 60;
            return (
              <CircleMarker
                key={node.stopId}
                center={[node.lat, node.lon]}
                radius={isHovered ? r + 2 : r}
                pathOptions={{
                  color:       isSelected ? '#ffffff' : bs.color,
                  fillColor:   bs.color,
                  fillOpacity: isSelected || isHovered ? 1 : bs.fillOpacity,
                  weight:      isSelected ? 2.5 : bs.weight,
                }}
                eventHandlers={{
                  click:     () => { onSelectStop?.(node.stopId); onSetCenter?.(node.stopId); },
                  mouseover: () => setHoveredStopId(node.stopId),
                  mouseout:  () => setHoveredStopId(null),
                }}
              >
                <Tooltip>
                  <strong>{node.stopName}</strong><br />
                  {mins} min{secs > 0 ? ` ${secs}s` : ''}<br />
                  <span style={{ fontSize: 10, opacity: 0.6 }}>↩ Recentrer depuis ici</span>
                </Tooltip>
              </CircleMarker>
            );
          })}
        </LayerGroup>

        {/* ── LAYER 3 : selected / origine (priorité maximale, toujours au-dessus) ── */}
        <LayerGroup>
          {centerStop && (
            <CircleMarker
              center={[centerStop.stop_lat, centerStop.stop_lon]}
              radius={Math.max(8, Math.round(13 * scale))}
              pathOptions={{ color: '#ffffff', fillColor: '#0f172a', fillOpacity: 1, weight: 2.5 }}
            >
              <Tooltip permanent direction="top">{centerStop.stop_name}</Tooltip>
            </CircleMarker>
          )}
        </LayerGroup>
      </MapContainer>

      {/* ── Légende des tranches ──────────────────────────────────────────────── */}
      {nodes.length > 0 && (
        <div style={{
          position: 'absolute', bottom: 24, right: 10, zIndex: 1000,
          background: 'rgba(15,23,42,0.82)', backdropFilter: 'blur(4px)',
          borderRadius: 8, padding: '8px 12px',
          display: 'flex', flexDirection: 'column', gap: 4,
        }}>
          {LEGEND_ITEMS.map(({ label, style: s }) => (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span style={{
                display: 'inline-block',
                width: Math.round(s.baseRadius * 1.3),
                height: Math.round(s.baseRadius * 1.3),
                borderRadius: '50%',
                background: s.color,
                opacity: s.fillOpacity,
                flexShrink: 0,
              }} />
              <span style={{ fontSize: 10, color: '#e2e8f0', fontFamily: 'monospace' }}>{label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default IsochroneMap;
