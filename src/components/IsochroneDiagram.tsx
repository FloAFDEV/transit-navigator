import React, { useEffect, useRef, useMemo, useCallback, useState } from 'react';
import * as d3 from 'd3';
import type { ParsedGtfs, GtfsStop } from '@/lib/gtfs-types';
import type { IsochroneNode } from '@/lib/isochrone';
import { buildTravelGraph, computeIsochrone, getCenterCandidates } from '@/lib/isochrone';
import { routeTypeToMode, modeColors } from '@/lib/gtfs-types';
import { exportSvg } from '@/lib/svg-export';
import { Download, RotateCcw, ZoomIn, ZoomOut, Clock, MapPin } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import HowToRead from './HowToRead';
import IsochroneMap from './IsochroneMap';

interface Props {
  gtfs: ParsedGtfs;
  onNodesChange?: (nodes: IsochroneNode[], centerId: string | null, maxMin: number, centerStop: GtfsStop | null) => void;
  selectedStopId?: string | null;
  onSelectStop?: (id: string) => void;
  /** When set, overrides the internal center selection (e.g. from global search). */
  forceCenterId?: string | null;
}

const BAND_COLORS = [
  'hsl(142, 70%, 45%)',
  'hsl(80, 65%, 48%)',
  'hsl(48, 85%, 50%)',
  'hsl(28, 80%, 52%)',
  'hsl(0, 72%, 50%)',
  'hsl(280, 55%, 48%)',
];

const IsochroneDiagram: React.FC<Props> = ({ gtfs, onNodesChange, selectedStopId, onSelectStop, forceCenterId }) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const dotRadiusRef = useRef(4);
  const selectedStopIdRef = useRef(selectedStopId);
  const onSelectStopRef = useRef(onSelectStop);
  const size = 600;
  const cx = size / 2;
  const cy = size / 2;

  useEffect(() => { selectedStopIdRef.current = selectedStopId; }, [selectedStopId]);
  useEffect(() => { onSelectStopRef.current = onSelectStop; }, [onSelectStop]);

  const filteredRouteIds = useMemo(() => {
    return new Set(gtfs.routes.map(r => r.route_id));
  }, [gtfs.routes]);

  const allowedTripIds = useMemo(() => {
    const ids = new Set<string>();
    for (const trip of gtfs.trips) {
      if (filteredRouteIds.has(trip.route_id)) ids.add(trip.trip_id);
    }
    return ids;
  }, [gtfs.trips, filteredRouteIds]);

  const graph = useMemo(() => buildTravelGraph(gtfs, allowedTripIds), [gtfs, allowedTripIds]);
  const candidates = useMemo(() => getCenterCandidates(gtfs, graph, 30), [gtfs, graph]);
  const [centerId, setCenterId] = useState<string | null>(null);
  const [maxMin, setMaxMin] = useState(30);

  useEffect(() => {
    if (!centerId && candidates.length > 0) {
      const preferred = ['jean-jaurès', 'jean jaurès', 'jean jaures', 'jaurès', 'jaures'];
      const found = candidates.find(c => preferred.some(p => c.stopName.toLowerCase().includes(p)));
      setCenterId(found?.stopId ?? candidates[0].stopId);
    }
  }, [candidates, centerId]);

  // Honour external center override (e.g. from global search selecting an arbitrary stop).
  useEffect(() => {
    if (forceCenterId && forceCenterId !== centerId) setCenterId(forceCenterId);
  }, [forceCenterId]); // eslint-disable-line react-hooks/exhaustive-deps

  const nodes = useMemo(() => {
    if (!centerId) return [];
    return computeIsochrone(gtfs, graph, centerId, maxMin);
  }, [gtfs, graph, centerId, maxMin]);

  const centerStop = useMemo(() => {
    if (!centerId) return null;
    return gtfs.stops.find(s => s.stop_id === centerId) ?? null;
  }, [gtfs.stops, centerId]);

  useEffect(() => {
    onNodesChange?.(nodes, centerId, maxMin, centerStop);
  }, [nodes, centerId, maxMin, centerStop, onNodesChange]);

  const stopPositions = useMemo(() => {
    const map = new Map<string, [number, number]>();
    for (const s of gtfs.stops) map.set(s.stop_id, [s.stop_lat, s.stop_lon]);
    return map;
  }, [gtfs.stops]);

  const bands = useMemo(() => {
    const b: number[] = [];
    for (let m = 5; m <= maxMin; m += 5) b.push(m);
    return b;
  }, [maxMin]);

  const routeColorMap = useMemo(() => {
    const map = new Map<string, { color: string; priority: number }>();
    for (const r of gtfs.routes) {
      if (!filteredRouteIds.has(r.route_id)) continue;
      const mode = routeTypeToMode(Number(r.route_type));
      const color = r.route_color ? `#${r.route_color}` : modeColors[mode];
      const priority = mode === 'metro' ? 4 : mode === 'tram' ? 3 : mode === 'cable' ? 3 : mode === 'bus' ? 2 : 1;
      map.set(r.route_id, { color, priority });
    }
    return map;
  }, [gtfs.routes, filteredRouteIds]);

  const stopRouteColor = useMemo(() => {
    const tripRoute = new Map<string, string>();
    for (const t of gtfs.trips) {
      if (filteredRouteIds.has(t.route_id)) tripRoute.set(t.trip_id, t.route_id);
    }
    const stopColor = new Map<string, string>();
    for (const st of gtfs.stopTimes) {
      const routeId = tripRoute.get(st.trip_id);
      if (!routeId) continue;
      const rc = routeColorMap.get(routeId);
      if (!rc) continue;
      const existing = stopColor.get(st.stop_id);
      if (!existing) {
        stopColor.set(st.stop_id, rc.color);
      } else {
        const existingRoute = [...routeColorMap.values()].find(v => v.color === existing);
        if (existingRoute && rc.priority > existingRoute.priority) stopColor.set(st.stop_id, rc.color);
      }
    }
    return stopColor;
  }, [gtfs, filteredRouteIds, routeColorMap]);

  const routeLines = useMemo(() => {
    const tripRoute = new Map<string, string>();
    for (const t of gtfs.trips) {
      if (filteredRouteIds.has(t.route_id)) tripRoute.set(t.trip_id, t.route_id);
    }
    const tripStops = new Map<string, { stop_id: string; seq: number }[]>();
    for (const st of gtfs.stopTimes) {
      if (!tripRoute.has(st.trip_id)) continue;
      if (!tripStops.has(st.trip_id)) tripStops.set(st.trip_id, []);
      tripStops.get(st.trip_id)!.push({ stop_id: st.stop_id, seq: st.stop_sequence });
    }
    const bestTrips = new Map<string, { stop_id: string; seq: number }[]>();
    for (const [tripId, stops] of tripStops) {
      const routeId = tripRoute.get(tripId)!;
      const trip = gtfs.trips.find(t => t.trip_id === tripId);
      const dirKey = `${routeId}__${trip?.direction_id ?? '0'}`;
      const existing = bestTrips.get(dirKey);
      if (!existing || stops.length > existing.length) bestTrips.set(dirKey, stops);
    }
    const lines: { routeId: string; color: string; stopIds: string[] }[] = [];
    for (const [dirKey, stops] of bestTrips) {
      const routeId = dirKey.split('__')[0];
      const rc = routeColorMap.get(routeId);
      if (!rc) continue;
      stops.sort((a, b) => a.seq - b.seq);
      lines.push({ routeId, color: rc.color, stopIds: stops.map(s => s.stop_id) });
    }
    return lines;
  }, [gtfs, filteredRouteIds, routeColorMap]);

  useEffect(() => {
    if (!svgRef.current || !centerStop || nodes.length === 0) return;
    const svg = d3.select(svgRef.current);
    svg.selectAll('g.content').remove();
    const content = svg.append('g').attr('class', 'content');

    const maxRadius = size / 2 - 40;
    const maxSeconds = maxMin * 60;
    const rScale = d3.scaleLinear().domain([0, maxSeconds]).range([0, maxRadius]);

    bands.forEach((m, i) => {
      const r = rScale(m * 60);
      content.append('circle')
        .attr('cx', cx).attr('cy', cy).attr('r', r)
        .attr('fill', 'none')
        .attr('stroke', BAND_COLORS[i % BAND_COLORS.length])
        .attr('stroke-width', 1.5)
        .attr('stroke-dasharray', '6,3')
        .attr('opacity', 0.5);
      content.append('text')
        .attr('x', cx + r + 3).attr('y', cy - 4)
        .attr('fill', BAND_COLORS[i % BAND_COLORS.length])
        .attr('font-size', '10px').attr('font-family', 'monospace')
        .text(`${m} min`);
    });

    const centerLat = centerStop.stop_lat;
    const centerLon = centerStop.stop_lon;
    const toRad = (d: number) => d * Math.PI / 180;
    const bearingTo = (lat: number, lon: number) => {
      const dLon = toRad(lon - centerLon);
      const y = Math.sin(dLon) * Math.cos(toRad(lat));
      const x = Math.cos(toRad(centerLat)) * Math.sin(toRad(lat)) -
        Math.sin(toRad(centerLat)) * Math.cos(toRad(lat)) * Math.cos(dLon);
      return Math.atan2(y, x);
    };

    const nodePositions = new Map<string, { x: number; y: number }>();
    for (const node of nodes) {
      const r = rScale(node.travelTime);
      const angle = bearingTo(node.lat, node.lon) - Math.PI / 2;
      nodePositions.set(node.stopId, { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r });
    }
    nodePositions.set(centerId!, { x: cx, y: cy });

    const line = d3.line<{ x: number; y: number }>().x(d => d.x).y(d => d.y).curve(d3.curveCatmullRom.alpha(0.5));
    for (const rl of routeLines) {
      const points: { x: number; y: number }[] = [];
      for (const stopId of rl.stopIds) {
        const pos = nodePositions.get(stopId);
        if (pos) points.push(pos);
      }
      if (points.length < 2) continue;
      content.append('path')
        .attr('d', line(points)!)
        .attr('fill', 'none').attr('stroke', rl.color)
        .attr('stroke-width', 2.5).attr('stroke-opacity', 0.7)
        .attr('stroke-linecap', 'round').attr('stroke-linejoin', 'round');
    }

    const n = nodes.length;
    const dotRadius = Math.max(3, Math.min(5, 200 / Math.sqrt(n)));
    dotRadiusRef.current = dotRadius;

    nodes.forEach((node) => {
      const pos = nodePositions.get(node.stopId);
      if (!pos) return;
      const { x, y } = pos;
      const color = stopRouteColor.get(node.stopId) ??
        BAND_COLORS[Math.max(0, Math.min(Math.floor(node.band / 5) - 1, BAND_COLORS.length - 1))];
      const isSelected = node.stopId === selectedStopIdRef.current;

      content.append('circle')
        .attr('class', 'stop-dot')
        .attr('data-stop-id', node.stopId)
        .attr('cx', x).attr('cy', y).attr('r', dotRadius)
        .attr('fill', color).attr('fill-opacity', 0.9)
        .attr('stroke', isSelected ? '#ffffff' : 'hsl(var(--background))')
        .attr('stroke-width', isSelected ? 2.5 : 1)
        .attr('cursor', 'pointer')
        .on('click', () => onSelectStopRef.current?.(node.stopId))
        .on('mouseenter', function (event) {
          d3.select(this).attr('r', dotRadiusRef.current * 2).attr('fill-opacity', 1);
          if (tooltipRef.current) {
            tooltipRef.current.style.opacity = '1';
            tooltipRef.current.style.left = `${event.offsetX + 12}px`;
            tooltipRef.current.style.top = `${event.offsetY - 10}px`;
            const min = Math.floor(node.travelTime / 60);
            const sec = node.travelTime % 60;
            tooltipRef.current.innerHTML = `
              <span class="font-semibold">${node.stopName}</span>
              <br/><span class="text-muted-foreground">${min}m${sec > 0 ? ` ${sec}s` : ''} depuis ${centerStop.stop_name}</span>
              <br/><span class="text-muted-foreground text-[10px]">Bande ${node.band} min</span>
            `;
          }
        })
        .on('mouseleave', function () {
          const isSel = d3.select(this).attr('data-stop-id') === selectedStopIdRef.current;
          d3.select(this)
            .attr('r', dotRadiusRef.current)
            .attr('fill-opacity', 0.9)
            .attr('stroke', isSel ? '#ffffff' : 'hsl(var(--background))')
            .attr('stroke-width', isSel ? 2.5 : 1);
          if (tooltipRef.current) tooltipRef.current.style.opacity = '0';
        });
    });

    content.append('circle')
      .attr('cx', cx).attr('cy', cy).attr('r', 6)
      .attr('fill', 'hsl(var(--foreground))').attr('stroke', 'hsl(var(--background))').attr('stroke-width', 2);
    content.append('text')
      .attr('x', cx).attr('y', cy + 20).attr('text-anchor', 'middle')
      .attr('fill', 'hsl(var(--foreground))').attr('font-size', '11px').attr('font-weight', '600')
      .text(centerStop.stop_name);

    [
      { label: 'N', angle: -Math.PI / 2 },
      { label: 'E', angle: 0 },
      { label: 'S', angle: Math.PI / 2 },
      { label: 'O', angle: Math.PI },
    ].forEach(({ label, angle }) => {
      const dr = maxRadius + 18;
      content.append('text')
        .attr('x', cx + Math.cos(angle) * dr).attr('y', cy + Math.sin(angle) * dr + 4)
        .attr('text-anchor', 'middle').attr('fill', 'hsl(var(--muted-foreground))')
        .attr('font-size', '10px').attr('font-weight', '500').text(label);
    });

    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.5, 6])
      .on('zoom', (event) => content.attr('transform', event.transform.toString()));
    svg.call(zoom);
    zoomRef.current = zoom;

    return () => { svg.on('.zoom', null); };
  }, [nodes, centerStop, bands, maxMin, cx, cy, size, stopRouteColor, routeLines, centerId]);

  useEffect(() => {
    if (!svgRef.current) return;
    d3.select(svgRef.current).selectAll<SVGCircleElement, unknown>('.stop-dot').each(function () {
      const el = d3.select(this);
      const isSel = el.attr('data-stop-id') === selectedStopId;
      el.attr('stroke', isSel ? '#ffffff' : 'hsl(var(--background))')
        .attr('stroke-width', isSel ? 2.5 : 1);
    });
  }, [selectedStopId, nodes]);

  const resetZoom = useCallback(() => {
    if (svgRef.current && zoomRef.current)
      d3.select(svgRef.current).transition().duration(400).call(zoomRef.current.transform, d3.zoomIdentity);
  }, []);
  const zoomIn = useCallback(() => {
    if (svgRef.current && zoomRef.current)
      d3.select(svgRef.current).transition().duration(300).call(zoomRef.current.scaleBy, 1.5);
  }, []);
  const zoomOut = useCallback(() => {
    if (svgRef.current && zoomRef.current)
      d3.select(svgRef.current).transition().duration(300).call(zoomRef.current.scaleBy, 0.67);
  }, []);

  const bandStats = useMemo(() => {
    const stats = new Map<number, number>();
    for (const n of nodes) stats.set(n.band, (stats.get(n.band) ?? 0) + 1);
    return Array.from(stats.entries()).sort((a, b) => a[0] - b[0]);
  }, [nodes]);

  const filteredRouteLegend = useMemo(() => {
    return gtfs.routes
      .filter(r => filteredRouteIds.has(r.route_id))
      .map(r => {
        const mode = routeTypeToMode(Number(r.route_type));
        const name = r.route_short_name || r.route_long_name || r.route_id;
        const color = r.route_color ? `#${r.route_color}` : modeColors[mode];
        const isLineo = (r.route_short_name || r.route_long_name || '').toLowerCase().includes('lineo') ||
          (r.route_short_name || r.route_long_name || '').toLowerCase().includes('linéo') ||
          /^l\d+$/i.test((r.route_short_name || '').trim());
        const type = mode === 'metro' ? 'Métro' : mode === 'tram' ? 'Tram' : mode === 'cable' ? 'Téléo / Câble' : isLineo ? 'Linéo' : 'Autre';
        return { name, color, type };
      })
      .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  }, [gtfs.routes, filteredRouteIds]);

  return (
    <div className="flex flex-col items-center gap-4">
      <HowToRead
        title="Carte isochrone radiale"
        what="Chaque point représente un arrêt du réseau, positionné selon sa direction géographique et sa distance en temps de trajet depuis la station centrale. Les cercles concentriques marquent les bandes isochrones (5, 10, 15, 20 min…)."
        deduce="Les zones denses proches du centre indiquent une bonne desserte. Les directions sans points révèlent des « déserts de transport ». Comparez les bandes : si peu d'arrêts sont à 5 min mais beaucoup à 20 min, le réseau est étalé."
        caution="Les temps sont calculés à partir des horaires planifiés GTFS (théoriques). Ils ne tiennent pas compte des temps de correspondance, d'attente ou de marche. La position angulaire reflète la direction géographique réelle."
        examples={[
          "Un cluster d'arrêts au nord à 10 min mais rien au sud à moins de 25 min révèle un déséquilibre d'accessibilité directionnelle.",
          "Si la station « Capitole » a 50 arrêts dans la bande 5 min, c'est un hub fortement maillé.",
          "Comparez deux stations centrales : celle qui « couvre » le plus de directions uniformément est la plus structurante.",
        ]}
      />

      <div className="flex items-center gap-4 flex-wrap justify-center">
        <div className="flex items-center gap-2">
          <MapPin className="w-3.5 h-3.5 text-muted-foreground" />
          <Select value={centerId ?? ''} onValueChange={setCenterId}>
            <SelectTrigger className="w-[250px] h-8 text-xs">
              <SelectValue placeholder="Station centrale…" />
            </SelectTrigger>
            <SelectContent>
              {candidates.map(c => (
                <SelectItem key={c.stopId} value={c.stopId}>
                  {c.stopName} ({c.edgeCount} connexions)
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <Clock className="w-3.5 h-3.5 text-muted-foreground" />
          <Select value={String(maxMin)} onValueChange={(v) => setMaxMin(Number(v))}>
            <SelectTrigger className="w-[120px] h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[15, 20, 25, 30, 45, 60].map(m => (
                <SelectItem key={m} value={String(m)}>{m} minutes</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex gap-4 items-start">
        <div className="viz-container p-4 relative" style={{ touchAction: 'none' }}>
          <div className="absolute top-3 left-3 flex flex-col gap-1 z-10">
            <button onClick={zoomIn} className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors" title="Zoom +">
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
            <button onClick={zoomOut} className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors" title="Zoom −">
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <button onClick={resetZoom} className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors" title="Réinitialiser">
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          </div>
          <button
            onClick={() => svgRef.current && exportSvg(svgRef.current, 'isochrone')}
            className="absolute top-3 right-3 p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors z-10"
            title="Exporter SVG"
          >
            <Download className="w-3.5 h-3.5" />
          </button>
          <div
            ref={tooltipRef}
            className="absolute pointer-events-none bg-card border border-border rounded-md px-3 py-2 text-xs shadow-md opacity-0 transition-opacity z-20 max-w-xs"
            style={{ opacity: 0 }}
          />
          <svg ref={svgRef} width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="block mx-auto" />
        </div>

        <div className="flex flex-col gap-3 min-w-[200px]">
          <div className="bg-card border border-border rounded-lg p-3">
            <h4 className="text-xs font-semibold text-foreground mb-2">Lignes affichées</h4>
            <div className="flex flex-col gap-1.5 max-h-[160px] overflow-y-auto">
              {filteredRouteLegend.map((r, i) => (
                <div key={i} className="flex items-center gap-2 text-xs">
                  <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: r.color }} />
                  <span className="text-foreground font-medium">{r.name}</span>
                  <span className="text-muted-foreground text-[10px]">{r.type}</span>
                </div>
              ))}
            </div>
            <p className="text-[10px] text-muted-foreground mt-2">Tous modes inclus</p>
          </div>

          <div className="bg-card border border-border rounded-lg p-3">
            <h4 className="text-xs font-semibold text-foreground mb-2">Bandes isochrones</h4>
            <div className="flex flex-col gap-1.5">
              {bands.map((m, i) => (
                <div key={m} className="flex items-center gap-2 text-xs">
                  <span className="w-3 h-3 rounded-full flex-shrink-0 border border-border" style={{ backgroundColor: BAND_COLORS[i % BAND_COLORS.length], opacity: 0.4 }} />
                  <span className="text-muted-foreground">{m - 4}–{m} min</span>
                  <span className="ml-auto font-mono text-foreground">{bandStats.find(([b]) => b === m)?.[1] ?? 0}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-card border border-border rounded-lg p-3">
            <h4 className="text-xs font-semibold text-foreground mb-1.5">Arrêts</h4>
            <div className="flex flex-col gap-0.5 max-h-[220px] overflow-y-auto">
              {nodes.slice(0, 120).map(node => {
                const isSelected = node.stopId === selectedStopId;
                return (
                  <button
                    key={node.stopId}
                    onClick={() => onSelectStop?.(node.stopId)}
                    className={`flex items-center justify-between gap-2 px-1.5 py-1 rounded text-xs text-left transition-colors ${
                      isSelected
                        ? 'bg-primary text-primary-foreground'
                        : 'hover:bg-secondary text-foreground'
                    }`}
                  >
                    <span className="truncate">{node.stopName}</span>
                    <span className="font-mono text-[10px] flex-shrink-0 opacity-60">
                      {Math.floor(node.travelTime / 60)}m
                    </span>
                  </button>
                );
              })}
              {nodes.length > 120 && (
                <p className="text-[10px] text-muted-foreground px-1.5 pt-1">+{nodes.length - 120} arrêts</p>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="text-xs text-muted-foreground font-mono">
        {nodes.length} arrêts accessibles en ≤ {maxMin} min depuis {centerStop?.stop_name ?? '—'}
        {' · molette pour zoomer'}
      </div>

      {nodes.length > 0 && (
        <div className="w-full max-w-3xl">
          <IsochroneMap
            nodes={nodes}
            centerStop={centerStop}
            selectedStopId={selectedStopId}
            onSelectStop={onSelectStop}
            onSetCenter={setCenterId}
            stopPositions={stopPositions}
          />
        </div>
      )}
    </div>
  );
};

export default IsochroneDiagram;
