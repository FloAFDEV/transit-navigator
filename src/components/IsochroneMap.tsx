import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, CircleMarker, Tooltip, useMap, useMapEvents } from 'react-leaflet';
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

// ─── Colours ──────────────────────────────────────────────────────────────────

const BAND_COLORS = ['#22c55e', '#84cc16', '#eab308', '#f97316', '#ef4444', '#a855f7'];

function bandColor(band: number): string {
  return BAND_COLORS[Math.max(0, Math.min(Math.floor(band / 5) - 1, BAND_COLORS.length - 1))];
}

// ─── Visual encoding (FIXED radii — no zoom scaling) ─────────────────────────
//
// Three exclusive visual states, strongly differentiated:
//   unreachable  → radius 2,  slate,  low opacity  (background context layer)
//   reachable    → radius 4–7, band color, high opacity  (primary info layer)
//   selected     → radius 10, dark fill / white border   (origin, always on top)
//
// Reachable style is keyed to isochrone band only — never to zoom.

interface BandStyle {
  radius: number;
  fillOpacity: number;
  weight: number;
}

const BAND_STYLE_TABLE: [number, BandStyle][] = [
  [ 5, { radius: 7, fillOpacity: 1.00, weight: 1.5 }],
  [10, { radius: 6, fillOpacity: 0.88, weight: 1.2 }],
  [15, { radius: 5, fillOpacity: 0.78, weight: 1.0 }],
  [20, { radius: 5, fillOpacity: 0.65, weight: 0.8 }],
  [25, { radius: 4, fillOpacity: 0.55, weight: 0.6 }],
  [99, { radius: 4, fillOpacity: 0.45, weight: 0.5 }],
];

function bandStyle(band: number): BandStyle {
  for (const [thresh, style] of BAND_STYLE_TABLE) {
    if (band <= thresh) return style;
  }
  return BAND_STYLE_TABLE[BAND_STYLE_TABLE.length - 1][1];
}

// ─── Background stop sampling ─────────────────────────────────────────────────
//
// At low zoom the full allStops set would paint a solid mass of dots.
// Spatial grid deduplication keeps at most one stop per cell, capped at 400.

const BG_CELL_LOW = 0.025; // ~2.5 km grid at zoom < 11
const BG_CELL_MID = 0.008; // ~0.8 km grid at zoom 11–13
const BG_CAP      = 400;

function sampleBackground(
  allStops: GtfsStop[],
  reachableIds: Set<string>,
  zoom: number,
): GtfsStop[] {
  const cellSize = zoom < 11 ? BG_CELL_LOW : zoom < 14 ? BG_CELL_MID : 0;

  let candidates = allStops.filter(
    s => !reachableIds.has(s.stop_id) && !(s.stop_lat === 0 && s.stop_lon === 0),
  );

  if (cellSize > 0) {
    const grid = new Map<string, GtfsStop>();
    for (const s of candidates) {
      const key = `${Math.floor(s.stop_lat / cellSize)},${Math.floor(s.stop_lon / cellSize)}`;
      if (!grid.has(key)) grid.set(key, s);
    }
    candidates = Array.from(grid.values());
  }

  return candidates.slice(0, BG_CAP);
}

// ─── Reachable stop LOD filtering ────────────────────────────────────────────
//
// Shows the most accessible stop per spatial cell at low/mid zoom,
// always preserving the selected stop.

const LOD_CAPS  = { low: 30, mid: 120, high: 400 } as const;
const LOD_CELLS = { low: 0.018, mid: 0.006, high: 0 } as const;

function filterReachable(
  nodes: IsochroneNode[],
  zoom: number,
  selectedStopId?: string | null,
): IsochroneNode[] {
  const level    = zoom >= 14 ? 'high' : zoom >= 12 ? 'mid' : 'low';
  const cap      = LOD_CAPS[level];
  const cellSize = LOD_CELLS[level];

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
  nodes, allStops, centerStop, selectedStopId, onSelectStop, onSetCenter, stopPositions,
}) => {
  const [hoveredStopId, setHoveredStopId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(12);

  const defaultCenter: [number, number] = centerStop
    ? [centerStop.stop_lat, centerStop.stop_lon]
    : [43.6, 1.44];

  const hasIsochrone = nodes.length > 0;

  // Set of reachable stop IDs — excludes them from the background layer.
  const reachableIds = useMemo(
    () => new Set(nodes.map(n => n.stopId)),
    [nodes],
  );

  // Layer 1 — background (unreachable stops). Zoom-reactive sampling only.
  const backgroundStops = useMemo(
    () => (allStops ? sampleBackground(allStops, reachableIds, zoom) : []),
    [allStops, reachableIds, zoom],
  );

  // Layer 2 — reachable stops. Zoom-reactive LOD only.
  const visibleReachable = useMemo(
    () => filterReachable(nodes, zoom, selectedStopId),
    [nodes, zoom, selectedStopId],
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

        {/*
          LAYER 1 — Unreachable stops (background context).
          Muted slate dots drawn first so every other layer renders on top.
          Opacity is lower when an isochrone is active to keep focus on reachable stops.
        */}
        {backgroundStops.map(s => (
          <CircleMarker
            key={`bg-${s.stop_id}`}
            center={[s.stop_lat, s.stop_lon]}
            radius={2}
            pathOptions={{
              color:       '#64748b',
              fillColor:   '#94a3b8',
              fillOpacity: hasIsochrone ? 0.20 : 0.40,
              weight:      0,
            }}
          />
        ))}

        {/*
          LAYER 2 — Reachable stops (primary information layer).
          Color = time band. Size + opacity = proximity (inner = large + opaque).
          Fixed radii — no zoom scaling — so visual weight is purely data-driven.
          Click recenters the isochrone on this stop.
        */}
        {visibleReachable.map(node => {
          const isSelected = node.stopId === selectedStopId;
          const isHovered  = node.stopId === hoveredStopId;
          const color = bandColor(node.band);
          const style = bandStyle(node.band);
          const mins  = Math.floor(node.travelTime / 60);
          const secs  = node.travelTime % 60;
          return (
            <CircleMarker
              key={node.stopId}
              center={[node.lat, node.lon]}
              radius={isSelected ? style.radius + 3 : isHovered ? style.radius + 1 : style.radius}
              pathOptions={{
                color:       isSelected ? '#ffffff' : color,
                fillColor:   color,
                fillOpacity: isSelected || isHovered ? 1 : style.fillOpacity,
                weight:      isSelected ? 2.5 : style.weight,
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

        {/*
          LAYER 3 — Origin stop (isochrone center).
          Rendered last (topmost z-order). Fixed radius 10, strongly distinct style.
        */}
        {centerStop && (
          <CircleMarker
            center={[centerStop.stop_lat, centerStop.stop_lon]}
            radius={10}
            pathOptions={{ color: '#ffffff', fillColor: '#0f172a', fillOpacity: 1, weight: 2.5 }}
          >
            <Tooltip permanent direction="top">{centerStop.stop_name}</Tooltip>
          </CircleMarker>
        )}
      </MapContainer>
    </div>
  );
};

export default IsochroneMap;
