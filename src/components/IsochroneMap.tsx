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

// ─── Colours ────────────────────────────────────────────────────────────────

const BAND_COLORS = ['#22c55e', '#84cc16', '#eab308', '#f97316', '#ef4444', '#a855f7'];

function bandColor(band: number): string {
  return BAND_COLORS[Math.max(0, Math.min(Math.floor(band / 5) - 1, BAND_COLORS.length - 1))];
}

// ─── Geometry ────────────────────────────────────────────────────────────────

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

/**
 * Douglas-Peucker simplification on an open polyline.
 * tol is in coordinate units (degrees). tol=0 → identity.
 * Convex hull vertices are already few (~6-25), so this is O(n log n) and trivial.
 */
function dpSimplify(pts: [number, number][], tol: number): [number, number][] {
  if (tol <= 0 || pts.length <= 2) return pts;

  const [x1, y1] = pts[0];
  const [x2, y2] = pts[pts.length - 1];
  const lineLen = Math.hypot(x2 - x1, y2 - y1);

  let maxDist = 0;
  let maxIdx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const [x, y] = pts[i];
    const dist = lineLen === 0
      ? Math.hypot(x - x1, y - y1)
      : Math.abs((y2 - y1) * x - (x2 - x1) * y + x2 * y1 - y2 * x1) / lineLen;
    if (dist > maxDist) { maxDist = dist; maxIdx = i; }
  }

  if (maxDist <= tol) return [pts[0], pts[pts.length - 1]];

  const left = dpSimplify(pts.slice(0, maxIdx + 1), tol);
  const right = dpSimplify(pts.slice(maxIdx), tol);
  return [...left.slice(0, -1), ...right];
}

/** Build one cumulative convex hull per time band (outer → inner order). */
function buildBandZones(nodes: IsochroneNode[]): { band: number; hull: [number, number][] }[] {
  const bands = [...new Set(nodes.map(n => n.band))].sort((a, b) => b - a);
  return bands
    .map(band => ({
      band,
      hull: convexHull(nodes.filter(n => n.band <= band).map(n => [n.lat, n.lon])),
    }))
    .filter(z => z.hull.length >= 3);
}

// ─── Zone LOD table ───────────────────────────────────────────────────────────
//
// minBandMultiple: only render bands divisible by this value.
//   = 30 → show only the outermost band (network footprint overview)
//   = 15 → show bands 15, 30   = 10 → 10, 20, 30   = 5 → all bands
//
// dpTol: Douglas-Peucker tolerance in degrees (0 = keep all hull vertices).
//   At zoom 8 the whole city fits on screen; 0.006° ≈ 650 m is imperceptible.
//   At zoom 14+ we want full precision, so tol = 0.
//
// fillOpacity: per polygon; cumulative overlap produces darker inner zones.
// strokeOpacity / weight: ring boundary visibility.

interface ZoneLod {
  minBandMultiple: number;
  fillOpacity: number;
  strokeOpacity: number;
  weight: number;
  dpTol: number;
}

// Each entry: [maxZoom (exclusive), config]
const ZONE_LOD_TABLE: [number, ZoneLod][] = [
  //  zoom <  9  →  overview: 1 zone, aggressive DP, opaque enough to read
  [  9, { minBandMultiple: 30, fillOpacity: 0.14, strokeOpacity: 0.60, weight: 1.2, dpTol: 0.006 }],
  // zoom 9–10  →  2 zones (15 + 30 min bands)
  [ 11, { minBandMultiple: 15, fillOpacity: 0.11, strokeOpacity: 0.52, weight: 1.4, dpTol: 0.003 }],
  // zoom 11–12 →  3 zones (10 + 20 + 30 min), medium simplification
  [ 13, { minBandMultiple: 10, fillOpacity: 0.08, strokeOpacity: 0.44, weight: 1.5, dpTol: 0.001 }],
  // zoom 13–14 →  all bands, light touch (zones recede, markers take over)
  [ 15, { minBandMultiple:  5, fillOpacity: 0.05, strokeOpacity: 0.30, weight: 1.2, dpTol: 0     }],
  // zoom 15+   →  all bands, almost transparent — street context dominant
  [ 99, { minBandMultiple:  5, fillOpacity: 0.03, strokeOpacity: 0.18, weight: 0.8, dpTol: 0     }],
];

function getZoneLod(zoom: number): ZoneLod {
  for (const [thresh, lod] of ZONE_LOD_TABLE) {
    if (zoom < thresh) return lod;
  }
  return ZONE_LOD_TABLE[ZONE_LOD_TABLE.length - 1][1];
}

// ─── Stop tier classification ─────────────────────────────────────────────────

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

// ─── Stop LOD filtering ───────────────────────────────────────────────────────

const STOP_LOD_HIGH = 14;
const STOP_LOD_MID  = 12;
const CELL_MID = 0.008; // ~800 m
const CELL_LOW = 0.020; // ~2 km
const CAP_HIGH = 150;
const CAP_MID  =  75;
const CAP_LOW  =  15;

function filterByLod(
  nodes: IsochroneNode[],
  tiers: Map<string, StopTier>,
  zoom: number,
  selectedStopId?: string | null,
): IsochroneNode[] {
  const isHigh = zoom >= STOP_LOD_HIGH;
  const isMid  = zoom >= STOP_LOD_MID;

  const allowed: Set<StopTier> = isHigh
    ? new Set(['hub', 'secondary', 'peripheral'])
    : isMid
      ? new Set(['hub', 'secondary'])
      : new Set(['hub']);

  const cap      = isHigh ? CAP_HIGH : isMid ? CAP_MID : CAP_LOW;
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

// ─── Marker visual constants + zoom scale ────────────────────────────────────

const TIER_BASE_RADIUS: Record<StopTier, number> = { hub: 8, secondary: 5, peripheral: 3 };
const TIER_WEIGHT:      Record<StopTier, number> = { hub: 2, secondary: 1, peripheral: 0.5 };
const TIER_OPACITY:     Record<StopTier, number> = { hub: 1, secondary: 0.85, peripheral: 0.7 };

/** Scale marker radii with zoom so they never dominate at low zoom. */
function markerScale(zoom: number): number {
  if (zoom < 11) return 0.65;
  if (zoom < 13) return 0.82;
  if (zoom < 15) return 1.0;
  return 1.2;
}

// ─── Map helpers ──────────────────────────────────────────────────────────────

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

// ─── Component ────────────────────────────────────────────────────────────────

const IsochroneMap: React.FC<Props> = ({ nodes, centerStop, selectedStopId, onSelectStop, stopPositions }) => {
  const [hoveredStopId, setHoveredStopId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(12);

  const defaultCenter: [number, number] = centerStop
    ? [centerStop.stop_lat, centerStop.stop_lon]
    : [43.6, 1.44];

  // ── Heavy work: run once per node dataset, never on zoom ──────────────────
  const tiers    = useMemo(() => classifyTiers(nodes), [nodes]);
  const bandZones = useMemo(() => buildBandZones(nodes), [nodes]);

  // ── Zoom-reactive: O(1) table lookup + light filtering ────────────────────
  const zoneLod = useMemo(() => getZoneLod(zoom), [zoom]);
  const scale   = useMemo(() => markerScale(zoom), [zoom]);

  const visibleNodes = useMemo(
    () => filterByLod(nodes, tiers, zoom, selectedStopId),
    [nodes, tiers, zoom, selectedStopId],
  );

  /**
   * visibleZones applies two cheap transforms on the pre-built hulls:
   *   1. Band filter — keeps only bands that are visible at this zoom.
   *   2. DP simplification — reduces vertex count on each hull polygon.
   * Both are O(zones × hull_vertices), typically < 200 iterations total.
   * Guaranteed at least one zone via fallback to outermost band.
   */
  const visibleZones = useMemo(() => {
    const filtered = bandZones.filter(z => z.band % zoneLod.minBandMultiple === 0);
    const toRender = filtered.length > 0 ? filtered : bandZones.slice(0, 1);
    return toRender.map(z => ({
      band: z.band,
      pts: dpSimplify(z.hull, zoneLod.dpTol),
    }));
  }, [bandZones, zoneLod]);

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

        {/*
          Isochrone zones — outer to inner so inner bands overlay outer ones.
          Style is fully driven by zoneLod; geometry is DP-simplified per zoom.
        */}
        {visibleZones.map(({ band, pts }) => {
          const color = bandColor(band);
          return (
            <Polygon
              key={`zone-${band}`}
              positions={pts}
              pathOptions={{
                color,
                fillColor: color,
                fillOpacity: zoneLod.fillOpacity,
                weight: zoneLod.weight,
                opacity: zoneLod.strokeOpacity,
              }}
            />
          );
        })}

        {/* Markers: tier hierarchy + zoom-scaled radius */}
        {visibleNodes.map(node => {
          const isSelected = node.stopId === selectedStopId;
          const isHovered  = node.stopId === hoveredStopId;
          const tier = tiers.get(node.stopId) ?? 'peripheral';
          const base = bandColor(node.band);
          const r    = Math.max(2, Math.round(TIER_BASE_RADIUS[tier] * scale));
          return (
            <CircleMarker
              key={node.stopId}
              center={[node.lat, node.lon]}
              radius={isSelected ? r + 3 : isHovered ? r + 1 : r}
              pathOptions={{
                color:       isSelected ? '#ffffff' : tier === 'hub' ? '#0f172a' : base,
                fillColor:   base,
                fillOpacity: isSelected || isHovered ? 1 : TIER_OPACITY[tier],
                weight:      isSelected ? 3 : TIER_WEIGHT[tier],
              }}
              eventHandlers={{
                click:     () => onSelectStop?.(node.stopId),
                mouseover: () => setHoveredStopId(node.stopId),
                mouseout:  () => setHoveredStopId(null),
              }}
            >
              <Tooltip>
                <strong>{node.stopName}</strong><br />
                {Math.floor(node.travelTime / 60)} min
                {node.travelTime % 60 > 0 ? ` ${node.travelTime % 60}s` : ''}
              </Tooltip>
            </CircleMarker>
          );
        })}

        {/* Center stop — scaled but capped so it never disappears */}
        {centerStop && (
          <CircleMarker
            center={[centerStop.stop_lat, centerStop.stop_lon]}
            radius={Math.round(11 * Math.min(scale, 1))}
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
