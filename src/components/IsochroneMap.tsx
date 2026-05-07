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

// ─── Time-bucket visual encoding ──────────────────────────────────────────────
//
// Mandatory strong differentiation: every bucket has a unique combination of
// color + radius + opacity. Closer = larger, brighter, more opaque.
// Radius values are BASE values — they are multiplied by zoomScale() before rendering.

interface BucketStyle {
  color: string;
  baseRadius: number;
  fillOpacity: number;
  weight: number;
}

const BUCKET_STYLES: Record<number, BucketStyle> = {
   5: { color: '#16a34a', baseRadius: 7, fillOpacity: 1.00, weight: 2.0 }, // green  — 0–5 min
  10: { color: '#65a30d', baseRadius: 6, fillOpacity: 0.92, weight: 1.8 }, // lime   — 5–10
  15: { color: '#d97706', baseRadius: 5, fillOpacity: 0.82, weight: 1.6 }, // amber  — 10–15
  20: { color: '#ea580c', baseRadius: 5, fillOpacity: 0.72, weight: 1.4 }, // orange — 15–20
  25: { color: '#dc2626', baseRadius: 4, fillOpacity: 0.62, weight: 1.2 }, // red    — 20–25
  99: { color: '#7c3aed', baseRadius: 4, fillOpacity: 0.52, weight: 1.0 }, // violet — 25+
};

function bucketStyle(band: number): BucketStyle {
  if (band <=  5) return BUCKET_STYLES[5];
  if (band <= 10) return BUCKET_STYLES[10];
  if (band <= 15) return BUCKET_STYLES[15];
  if (band <= 20) return BUCKET_STYLES[20];
  if (band <= 25) return BUCKET_STYLES[25];
  return BUCKET_STYLES[99];
}

// ─── Zoom → radius scaling (INVERSE relationship) ─────────────────────────────
//
// Low zoom (overview) → larger dots visible at a glance.
// High zoom (street) → dots shrink to avoid blob but never disappear.
//
// Floor at 4px radius ensures dots stay legible against white map tiles.
// Curve flattens after z14 so zooming in reveals stop positions without
// making them invisible.
//
//   z  9 → ×1.55  |  z 12 → ×0.90  |  z 15 → ×0.52
//   z 10 → ×1.28  |  z 13 → ×0.72  |  z 16 → ×0.44
//   z 11 → ×1.08  |  z 14 → ×0.60  |

function zoomScale(zoom: number): number {
  if (zoom <=  9) return 1.55;
  if (zoom <= 10) return 1.28;
  if (zoom <= 11) return 1.08;
  if (zoom <= 12) return 0.90;
  if (zoom <= 13) return 0.72;
  if (zoom <= 14) return 0.60;
  if (zoom <= 15) return 0.52;
  return 0.44;
}

function scaledRadius(base: number, zoom: number): number {
  return Math.max(4, Math.round(base * zoomScale(zoom)));
}

// ─── Reachable LOD ────────────────────────────────────────────────────────────
//
// Spatial grid deduplication keeps the most accessible stop per cell.
// The selected stop is always preserved regardless of LOD cap.

const REACH_CAPS  = { low: 50, mid: 180, high: 600 } as const;
const REACH_CELLS = { low: 0.018, mid: 0.006, high: 0 } as const;

function filterReachable(
  nodes: IsochroneNode[],
  zoom: number,
  selectedStopId?: string | null,
): IsochroneNode[] {
  const level    = zoom >= 14 ? 'high' : zoom >= 12 ? 'mid' : 'low';
  const cap      = REACH_CAPS[level];
  const cellSize = REACH_CELLS[level];
  const sorted   = [...nodes].sort((a, b) => a.travelTime - b.travelTime);

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

// ─── Unreachable (background) network sampling ────────────────────────────────
//
// ⚠️  These stops must ALWAYS be visible — they are the "poor zone" signal.
// Holes in this layer reveal areas with no transit at all.
// The contrast between muted-grey unreachable and colored reachable IS the map story.
//
// They are clickable: any network stop can become a new isochrone origin.
// Sampling adjusts density per zoom — never hides the layer completely.

const BG_CELLS = { low: 0.025, mid: 0.010, high: 0 } as const;
const BG_CAPS  = { low: 220, mid: 380, high: 700 } as const;

function sampleBackground(
  allStops: GtfsStop[],
  reachableIds: Set<string>,
  centerId: string | null,
  zoom: number,
): GtfsStop[] {
  const level    = zoom >= 14 ? 'high' : zoom >= 11 ? 'mid' : 'low';
  const cellSize = BG_CELLS[level];
  const cap      = BG_CAPS[level];

  let candidates = allStops.filter(
    s => !reachableIds.has(s.stop_id) &&
         s.stop_id !== centerId &&
         validLatLon(s.stop_lat, s.stop_lon),
  );

  if (cellSize > 0) {
    const grid = new Map<string, GtfsStop>();
    for (const s of candidates) {
      const key = `${Math.floor(s.stop_lat / cellSize)},${Math.floor(s.stop_lon / cellSize)}`;
      if (!grid.has(key)) grid.set(key, s);
    }
    candidates = Array.from(grid.values());
  }

  return candidates.slice(0, cap);
}

// ─── Coordinate validation ────────────────────────────────────────────────────

function validLatLon(lat: unknown, lon: unknown): lat is number {
  return (
    typeof lat === 'number' && typeof lon === 'number' &&
    isFinite(lat) && isFinite(lon) &&
    !(lat === 0 && lon === 0) &&
    lat >= -90 && lat <= 90 &&
    lon >= -180 && lon <= 180
  );
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
    const pts: [number, number][] = nodes
      .filter(n => validLatLon(n.lat, n.lon))
      .map(n => [n.lat, n.lon]);
    if (centerStop && validLatLon(centerStop.stop_lat, centerStop.stop_lon)) {
      pts.push([centerStop.stop_lat, centerStop.stop_lon]);
    }
    if (pts.length === 0) return;
    if (pts.length === 1) { map.setView(pts[0], 13); return; }
    const lats = pts.map(p => p[0]);
    const lons = pts.map(p => p[1]);
    try {
      map.fitBounds(
        [[Math.min(...lats), Math.min(...lons)], [Math.max(...lats), Math.max(...lons)]],
        { padding: [40, 40] },
      );
    } catch { /* ignore stale map ref */ }
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
    if (node && validLatLon(node.lat, node.lon)) {
      try { map.flyTo([node.lat, node.lon], Math.max(map.getZoom(), 14), { duration: 0.6 }); } catch { /* ignore */ }
      return;
    }
    const pos = stopPositions?.get(selectedStopId);
    if (pos && validLatLon(pos[0], pos[1])) {
      try { map.flyTo([pos[0], pos[1]], Math.max(map.getZoom(), 14), { duration: 0.6 }); } catch { /* ignore */ }
    }
  }, [selectedStopId, nodes, stopPositions, map]);

  return null;
}

// ─── Legend ───────────────────────────────────────────────────────────────────

const LEGEND_ITEMS: { label: string; key: number }[] = [
  { label: '0–5 min',   key:  5 },
  { label: '5–10 min',  key: 10 },
  { label: '10–15 min', key: 15 },
  { label: '15–20 min', key: 20 },
  { label: '20–25 min', key: 25 },
  { label: '25+ min',   key: 99 },
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

  // Derive centerId from centerStop for background exclusion.
  // We match by coordinates since we only have CenterStop (no id on this type).
  const centerId = useMemo(() => {
    if (!centerStop || !allStops) return null;
    return allStops.find(
      s => s.stop_lat === centerStop.stop_lat && s.stop_lon === centerStop.stop_lon,
    )?.stop_id ?? null;
  }, [centerStop, allStops]);

  const reachableIds = useMemo(() => new Set(nodes.map(n => n.stopId)), [nodes]);

  // Layer 1: unreachable network stops — always present, always clickable.
  const backgroundStops = useMemo(
    () => (allStops ? sampleBackground(allStops, reachableIds, centerId, zoom) : []),
    [allStops, reachableIds, centerId, zoom],
  );

  // Layer 2: reachable stops, LOD-filtered per zoom.
  const visibleReachable = useMemo(
    () => filterReachable(nodes, zoom, selectedStopId),
    [nodes, zoom, selectedStopId],
  );

  const scale = zoomScale(zoom);
  const hasIsochrone = nodes.length > 0;

  return (
    <div style={{ position: 'relative', height: 480, borderRadius: 12, overflow: 'hidden', boxShadow: '0 2px 20px rgba(0,0,0,0.16)' }}>
      <MapContainer center={defaultCenter} zoom={12} style={{ height: '100%', width: '100%' }} scrollWheelZoom>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <ZoomTracker onZoom={setZoom} />
        <FitBounds nodes={nodes} centerStop={centerStop} />
        <FlyToSelected selectedStopId={selectedStopId} nodes={nodes} stopPositions={stopPositions} />

        {/*
          ── LAYER 1 : réseau complet (unreachable) ─────────────────────────────
          Toujours visible à tous les niveaux de zoom.
          Les trous dans cette couche = zones sans transit = signal "zone pauvre".
          Chaque point est cliquable → recentre l'isochrone sur cet arrêt.
        */}
        <LayerGroup>
          {backgroundStops.map(s => {
            const isHov = s.stop_id === hoveredStopId;
            // Background stops: always at least 3px so they remain clickable and
            // legible against white map tiles even at high zoom.
            const bgR = isHov ? Math.max(4, Math.round(4 * scale)) : Math.max(3, Math.round(3 * scale));
            return (
              <CircleMarker
                key={`bg-${s.stop_id}`}
                center={[s.stop_lat, s.stop_lon]}
                radius={bgR}
                pathOptions={{
                  color:       '#64748b',
                  fillColor:   '#94a3b8',
                  fillOpacity: isHov ? 0.65 : (hasIsochrone ? 0.35 : 0.50),
                  weight:      isHov ? 1.2 : 0.8,
                }}
                eventHandlers={{
                  click:     () => { onSetCenter?.(s.stop_id); onSelectStop?.(s.stop_id); },
                  mouseover: () => setHoveredStopId(s.stop_id),
                  mouseout:  () => setHoveredStopId(null),
                }}
              >
                <Tooltip>
                  <strong>{s.stop_name}</strong><br />
                  <span style={{ fontSize: 10, opacity: 0.7 }}>↩ Recentrer depuis ici</span>
                </Tooltip>
              </CircleMarker>
            );
          })}
        </LayerGroup>

        {/*
          ── LAYER 2 : arrêts accessibles (reachable) ──────────────────────────
          Rendu par tranche de temps avec différenciation forte :
          couleur + taille + opacité varient strictement par bucket.
          Zoom-inverse scaling : grands points à vue d'ensemble, fins au zoom fort.
        */}
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
                  color:       isSelected ? '#ffffff' : (isHovered ? '#ffffff' : bs.color),
                  fillColor:   bs.color,
                  fillOpacity: isSelected || isHovered ? 1 : bs.fillOpacity,
                  weight:      isSelected ? 2.5 : (isHovered ? 2 : Math.max(1.5, bs.weight)),
                  opacity:     1,
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

        {/*
          ── LAYER 3 : origine sélectionnée (priorité maximale) ────────────────
          Double cercle : anneau extérieur (glow) + disque intérieur (focus).
          Le glow signale visuellement le point de décision actuel.
          Rendu en dernier = z-index le plus élevé dans le SVG Leaflet.
        */}
        <LayerGroup>
          {centerStop && (
            <>
              {/* Glow ring — scales down with zoom to stay proportional */}
              <CircleMarker
                center={[centerStop.stop_lat, centerStop.stop_lon]}
                radius={Math.max(8, Math.round(14 * scale))}
                pathOptions={{
                  color:       '#0f172a',
                  fillColor:   '#0f172a',
                  fillOpacity: 0.12,
                  weight:      1.5,
                  opacity:     0.30,
                  dashArray:   '3 2',
                }}
                interactive={false}
              />
              {/* Origin dot */}
              <CircleMarker
                center={[centerStop.stop_lat, centerStop.stop_lon]}
                radius={Math.max(5, Math.round(8 * scale))}
                pathOptions={{ color: '#ffffff', fillColor: '#0f172a', fillOpacity: 1, weight: 2.5 }}
              >
                <Tooltip permanent direction="top" offset={[0, -6]}>
                  <strong>{centerStop.stop_name}</strong>
                </Tooltip>
              </CircleMarker>
            </>
          )}
        </LayerGroup>
      </MapContainer>

      {/* ── Légende des tranches de temps ─────────────────────────────────── */}
      {hasIsochrone && (
        <div style={{
          position: 'absolute', bottom: 28, right: 10, zIndex: 1000,
          background: 'rgba(15,23,42,0.85)', backdropFilter: 'blur(6px)',
          borderRadius: 8, padding: '8px 12px',
          display: 'flex', flexDirection: 'column', gap: 5,
          boxShadow: '0 2px 12px rgba(0,0,0,0.3)',
        }}>
          <div style={{ fontSize: 9, color: '#94a3b8', fontFamily: 'monospace', letterSpacing: 1, marginBottom: 2, textTransform: 'uppercase' }}>
            Accessibilité
          </div>
          {LEGEND_ITEMS.map(({ label, key }) => {
            const s = BUCKET_STYLES[key];
            return (
              <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{
                  display: 'inline-block',
                  width: Math.round(s.baseRadius * 1.4),
                  height: Math.round(s.baseRadius * 1.4),
                  borderRadius: '50%',
                  background: s.color,
                  opacity: s.fillOpacity,
                  flexShrink: 0,
                }} />
                <span style={{ fontSize: 10, color: '#e2e8f0', fontFamily: 'monospace' }}>{label}</span>
              </div>
            );
          })}
          <div style={{ borderTop: '1px solid rgba(148,163,184,0.2)', marginTop: 3, paddingTop: 5, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#94a3b8', opacity: 0.4, flexShrink: 0 }} />
            <span style={{ fontSize: 10, color: '#64748b', fontFamily: 'monospace' }}>Hors portée</span>
          </div>
        </div>
      )}

      {/* ── Indicateur de zoom ─────────────────────────────────────────────── */}
      <div style={{
        position: 'absolute', bottom: 28, left: 10, zIndex: 1000,
        background: 'rgba(15,23,42,0.75)', backdropFilter: 'blur(4px)',
        borderRadius: 6, padding: '4px 8px',
        fontSize: 9, color: '#64748b', fontFamily: 'monospace',
      }}>
        zoom {zoom} · ×{zoomScale(zoom).toFixed(2)}
      </div>
    </div>
  );
};

export default IsochroneMap;
