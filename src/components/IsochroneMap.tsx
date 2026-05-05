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
  /** Shift the isochrone origin to this stop and recompute. */
  onSetCenter?: (stopId: string) => void;
  stopPositions?: Map<string, [number, number]>;
}

// ─── Colours ─────────────────────────────────────────────────────────────────

const BAND_COLORS = ['#22c55e', '#84cc16', '#eab308', '#f97316', '#ef4444', '#a855f7'];

function bandColor(band: number): string {
  return BAND_COLORS[Math.max(0, Math.min(Math.floor(band / 5) - 1, BAND_COLORS.length - 1))];
}

// ─── Geometry ─────────────────────────────────────────────────────────────────

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
  const l = dpSimplify(pts.slice(0, maxIdx + 1), tol);
  const r = dpSimplify(pts.slice(maxIdx), tol);
  return [...l.slice(0, -1), ...r];
}

/** One cumulative convex hull per time band, outer → inner order. */
function buildBandZones(nodes: IsochroneNode[]): { band: number; hull: [number, number][] }[] {
  const bands = [...new Set(nodes.map(n => n.band))].sort((a, b) => b - a);
  return bands
    .map(band => ({
      band,
      hull: convexHull(nodes.filter(n => n.band <= band).map(n => [n.lat, n.lon])),
    }))
    .filter(z => z.hull.length >= 3);
}

// ─── Contour LOD (stroke only — zero fill) ────────────────────────────────────
//
// Dashed contour lines mark time boundaries without obscuring the base map.
// minBandMult controls how many ring levels are visible at each zoom:
//   = 30 → 1 contour  (outermost boundary only)
//   = 15 → 2 contours (15 + 30 min rings)
//   = 10 → 3 contours (10 + 20 + 30 min)
//   =  5 → all rings
//
// Contours fade (lower opacity, thinner dash) as zoom increases
// because stop markers become the dominant reading layer.

interface ContourLod {
  minBandMult: number;
  weight: number;
  opacity: number;
  dashArray: string;
  dpTol: number;
}

const CONTOUR_LOD_TABLE: [number, ContourLod][] = [
  [ 9, { minBandMult: 30, weight: 1.8, opacity: 0.70, dashArray: '6 4', dpTol: 0.006 }],
  [11, { minBandMult: 15, weight: 1.6, opacity: 0.58, dashArray: '5 4', dpTol: 0.003 }],
  [13, { minBandMult: 10, weight: 1.5, opacity: 0.48, dashArray: '4 3', dpTol: 0.001 }],
  [15, { minBandMult:  5, weight: 1.3, opacity: 0.36, dashArray: '3 3', dpTol: 0     }],
  [99, { minBandMult:  5, weight: 1.0, opacity: 0.22, dashArray: '3 3', dpTol: 0     }],
];

function getContourLod(zoom: number): ContourLod {
  for (const [thresh, lod] of CONTOUR_LOD_TABLE) {
    if (zoom < thresh) return lod;
  }
  return CONTOUR_LOD_TABLE[CONTOUR_LOD_TABLE.length - 1][1];
}

// ─── Stop marker visual encoding ─────────────────────────────────────────────
//
// Stops ARE the primary information layer.
// Visual weight is inversely proportional to travel time:
//   inner stops (5 min) → large, fully opaque, thick border
//   outer stops (30 min) → small, semi-transparent, hairline border
//
// This produces a natural "heat" gradient without any polygon fill.

function markerScale(zoom: number): number {
  if (zoom < 11) return 0.65;
  if (zoom < 13) return 0.82;
  if (zoom < 15) return 1.0;
  return 1.2;
}

function stopVisual(band: number, maxBand: number, scale: number) {
  // t ∈ [0,1]: 0 = innermost (most accessible), 1 = outermost
  const t = Math.max(0, Math.min(1, (band - 5) / Math.max(maxBand - 5, 1)));
  return {
    radius:      Math.max(2, Math.round((9 - t * 6) * scale)), // 9 → 3
    fillOpacity: 1.0 - t * 0.45,                               // 1.0 → 0.55
    weight:      2.0 - t * 1.5,                                // 2.0 → 0.5
  };
}

// ─── Stop LOD filtering ───────────────────────────────────────────────────────
//
// No tier classification needed: accessibility rank drives visual weight directly.
// Spatial deduplication keeps the most accessible stop per grid cell so the
// map stays readable at low zoom without hiding important hubs.

const LOD_CAPS  = { low: 25, mid: 100, high: 300 } as const;
const LOD_CELLS = { low: 0.018, mid: 0.006, high: 0 } as const; // degrees

function filterStops(
  nodes: IsochroneNode[],
  zoom: number,
  selectedStopId?: string | null,
): IsochroneNode[] {
  const level = zoom >= 14 ? 'high' : zoom >= 12 ? 'mid' : 'low';
  const cap      = LOD_CAPS[level];
  const cellSize = LOD_CELLS[level];

  // Sort by travelTime asc so the most accessible stop wins each spatial cell
  // and therefore gets the largest marker at any given zoom.
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

// ─── Component ────────────────────────────────────────────────────────────────

const IsochroneMap: React.FC<Props> = ({
  nodes, centerStop, selectedStopId, onSelectStop, onSetCenter, stopPositions,
}) => {
  const [hoveredStopId, setHoveredStopId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(12);

  const defaultCenter: [number, number] = centerStop
    ? [centerStop.stop_lat, centerStop.stop_lon]
    : [43.6, 1.44];

  // ── Computed once per node dataset, never on zoom ─────────────────────────
  const maxBand   = useMemo(() => Math.max(...nodes.map(n => n.band), 5), [nodes]);
  const bandZones = useMemo(() => buildBandZones(nodes), [nodes]);

  // ── Cheap zoom-reactive derivations ──────────────────────────────────────
  const contourLod   = useMemo(() => getContourLod(zoom), [zoom]);
  const scale        = useMemo(() => markerScale(zoom), [zoom]);
  const visibleNodes = useMemo(() => filterStops(nodes, zoom, selectedStopId), [nodes, zoom, selectedStopId]);

  /**
   * Contour polygons: band-filtered + DP-simplified on the pre-built hulls.
   * Fallback to outermost band so at least one contour is always visible.
   */
  const visibleContours = useMemo(() => {
    const filtered = bandZones.filter(z => z.band % contourLod.minBandMult === 0);
    const toRender = filtered.length > 0 ? filtered : bandZones.slice(0, 1);
    return toRender.map(z => ({ band: z.band, pts: dpSimplify(z.hull, contourLod.dpTol) }));
  }, [bandZones, contourLod]);

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
          Time-band contours — stroke only, no fill.
          Mark the accessibility boundary for each time threshold without
          hiding map features or stop markers underneath.
        */}
        {visibleContours.map(({ band, pts }) => (
          <Polygon
            key={`contour-${band}`}
            positions={pts}
            pathOptions={{
              color:      bandColor(band),
              fillOpacity: 0,
              weight:     contourLod.weight,
              opacity:    contourLod.opacity,
              dashArray:  contourLod.dashArray,
            }}
          />
        ))}

        {/*
          Stop markers — PRIMARY information layer.
          Encoding: color = time band, size + opacity = proximity (inner = large + opaque).
          Click = recompute isochrone from this stop as new origin.
        */}
        {visibleNodes.map(node => {
          const isSelected = node.stopId === selectedStopId;
          const isHovered  = node.stopId === hoveredStopId;
          const color = bandColor(node.band);
          const vis   = stopVisual(node.band, maxBand, scale);
          const mins  = Math.floor(node.travelTime / 60);
          const secs  = node.travelTime % 60;
          return (
            <CircleMarker
              key={node.stopId}
              center={[node.lat, node.lon]}
              radius={isSelected ? vis.radius + 3 : isHovered ? vis.radius + 1 : vis.radius}
              pathOptions={{
                color:       isSelected ? '#ffffff' : color,
                fillColor:   color,
                fillOpacity: isSelected || isHovered ? 1 : vis.fillOpacity,
                weight:      isSelected ? 3 : vis.weight,
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

        {/* Origin stop — visually distinct from all other stops */}
        {centerStop && (
          <CircleMarker
            center={[centerStop.stop_lat, centerStop.stop_lon]}
            radius={Math.round(12 * Math.min(scale, 1))}
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
