import React, { useEffect, useRef, useState } from 'react';
import { MapContainer, TileLayer, CircleMarker, Polygon, Tooltip, useMap } from 'react-leaflet';
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
  const hull = convexHull(nodes.map(n => [n.lat, n.lon]));
  const defaultCenter: [number, number] = centerStop
    ? [centerStop.stop_lat, centerStop.stop_lon]
    : [43.6, 1.44];

  return (
    <div style={{ height: 450, borderRadius: 12, overflow: 'hidden', boxShadow: '0 2px 16px rgba(0,0,0,0.13)' }}>
      <MapContainer center={defaultCenter} zoom={12} style={{ height: '100%', width: '100%' }} scrollWheelZoom>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <FitBounds nodes={nodes} centerStop={centerStop} />
        <FlyToSelected selectedStopId={selectedStopId} nodes={nodes} stopPositions={stopPositions} />

        {hull.length >= 3 && (
          <Polygon
            positions={hull}
            pathOptions={{ color: '#6366f1', fillColor: '#6366f1', fillOpacity: 0.07, weight: 1.5, dashArray: '6 4' }}
          />
        )}

        {nodes.map(node => {
          const isSelected = node.stopId === selectedStopId;
          const isHovered = node.stopId === hoveredStopId;
          const base = bandColor(node.band);
          return (
            <CircleMarker
              key={node.stopId}
              center={[node.lat, node.lon]}
              radius={isSelected ? 9 : isHovered ? 7 : 5}
              pathOptions={{
                color: isSelected ? '#ffffff' : base,
                fillColor: base,
                fillOpacity: isSelected || isHovered ? 1 : 0.85,
                weight: isSelected ? 3 : 1,
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

        {centerStop && (
          <CircleMarker
            center={[centerStop.stop_lat, centerStop.stop_lon]}
            radius={9}
            pathOptions={{ color: '#fff', fillColor: '#1e293b', fillOpacity: 1, weight: 2.5 }}
          >
            <Tooltip permanent direction="top">{centerStop.stop_name}</Tooltip>
          </CircleMarker>
        )}
      </MapContainer>
    </div>
  );
};

export default IsochroneMap;
