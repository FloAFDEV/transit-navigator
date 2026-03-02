import React, { useEffect, useRef, useMemo, useCallback, useState } from 'react';
import * as d3 from 'd3';
import type { ParsedGtfs } from '@/lib/gtfs-types';
import type { TravelEdge, IsochroneNode } from '@/lib/isochrone';
import { buildTravelGraph, computeIsochrone, getCenterCandidates } from '@/lib/isochrone';
import { exportSvg } from '@/lib/svg-export';
import { Download, RotateCcw, ZoomIn, ZoomOut, Clock, MapPin } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import HowToRead from './HowToRead';

interface Props {
  gtfs: ParsedGtfs;
}

const BAND_COLORS = [
  'hsl(142, 70%, 45%)', // 5 min — green
  'hsl(80, 65%, 48%)',  // 10 min
  'hsl(48, 85%, 50%)',  // 15 min — yellow
  'hsl(28, 80%, 52%)',  // 20 min — orange
  'hsl(0, 72%, 50%)',   // 25 min — red
  'hsl(280, 55%, 48%)', // 30 min — purple
];

const IsochroneDiagram: React.FC<Props> = ({ gtfs }) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const size = 600;
  const cx = size / 2;
  const cy = size / 2;

  const graph = useMemo(() => buildTravelGraph(gtfs), [gtfs]);
  const candidates = useMemo(() => getCenterCandidates(gtfs, graph, 30), [gtfs, graph]);
  const [centerId, setCenterId] = useState<string | null>(null);
  const [maxMin, setMaxMin] = useState(30);

  // Auto-select first candidate
  useEffect(() => {
    if (!centerId && candidates.length > 0) {
      // Try to find Toulouse hubs by name
      const preferred = ['capitole', 'jean-jaurès', 'jean jaurès', 'jeanne d\'arc', 'jeanne-d\'arc', 'marengo'];
      const found = candidates.find(c => preferred.some(p => c.stopName.toLowerCase().includes(p)));
      setCenterId(found?.stopId ?? candidates[0].stopId);
    }
  }, [candidates, centerId]);

  const nodes = useMemo(() => {
    if (!centerId) return [];
    return computeIsochrone(gtfs, graph, centerId, maxMin);
  }, [gtfs, graph, centerId, maxMin]);

  const centerStop = useMemo(() => {
    if (!centerId) return null;
    return gtfs.stops.find(s => s.stop_id === centerId) ?? null;
  }, [gtfs.stops, centerId]);

  const bands = useMemo(() => {
    const b: number[] = [];
    for (let m = 5; m <= maxMin; m += 5) b.push(m);
    return b;
  }, [maxMin]);

  useEffect(() => {
    if (!svgRef.current || !centerStop || nodes.length === 0) return;
    const svg = d3.select(svgRef.current);
    svg.selectAll('g.content').remove();
    const content = svg.append('g').attr('class', 'content');

    const maxRadius = size / 2 - 40;
    const maxSeconds = maxMin * 60;

    // Radial scale: travel time → radius
    const rScale = d3.scaleLinear().domain([0, maxSeconds]).range([0, maxRadius]);

    // Isochrone rings
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
        .attr('x', cx + r + 3)
        .attr('y', cy - 4)
        .attr('fill', BAND_COLORS[i % BAND_COLORS.length])
        .attr('font-size', '10px')
        .attr('font-family', 'monospace')
        .text(`${m} min`);
    });

    // Angular distribution: use geographic bearing from center
    const centerLat = centerStop.stop_lat;
    const centerLon = centerStop.stop_lon;

    const toRad = (d: number) => d * Math.PI / 180;
    const bearingTo = (lat: number, lon: number) => {
      const dLon = toRad(lon - centerLon);
      const y = Math.sin(dLon) * Math.cos(toRad(lat));
      const x = Math.cos(toRad(centerLat)) * Math.sin(toRad(lat)) -
        Math.sin(toRad(centerLat)) * Math.cos(toRad(lat)) * Math.cos(dLon);
      return Math.atan2(y, x); // radians, 0 = north
    };

    // Plot stops
    const n = nodes.length;
    const dotRadius = Math.max(2, Math.min(5, 200 / Math.sqrt(n)));

    nodes.forEach((node) => {
      const r = rScale(node.travelTime);
      const angle = bearingTo(node.lat, node.lon) - Math.PI / 2; // rotate so north is up
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;
      const bandIdx = Math.min(Math.floor(node.band / 5) - 1, BAND_COLORS.length - 1);
      const color = BAND_COLORS[Math.max(0, bandIdx)];

      content.append('circle')
        .attr('cx', x).attr('cy', y).attr('r', dotRadius)
        .attr('fill', color)
        .attr('fill-opacity', 0.75)
        .attr('stroke', color)
        .attr('stroke-width', 0.5)
        .attr('cursor', 'pointer')
        .on('mouseenter', function (event) {
          d3.select(this).attr('r', dotRadius * 2).attr('fill-opacity', 1);
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
          d3.select(this).attr('r', dotRadius).attr('fill-opacity', 0.75);
          if (tooltipRef.current) tooltipRef.current.style.opacity = '0';
        });
    });

    // Center dot
    content.append('circle')
      .attr('cx', cx).attr('cy', cy).attr('r', 6)
      .attr('fill', 'hsl(var(--foreground))')
      .attr('stroke', 'hsl(var(--background))')
      .attr('stroke-width', 2);

    content.append('text')
      .attr('x', cx).attr('y', cy + 20)
      .attr('text-anchor', 'middle')
      .attr('fill', 'hsl(var(--foreground))')
      .attr('font-size', '11px')
      .attr('font-weight', '600')
      .text(centerStop.stop_name);

    // Compass directions
    const directions = [
      { label: 'N', angle: -Math.PI / 2 },
      { label: 'E', angle: 0 },
      { label: 'S', angle: Math.PI / 2 },
      { label: 'O', angle: Math.PI },
    ];
    directions.forEach(({ label, angle }) => {
      const dr = maxRadius + 18;
      content.append('text')
        .attr('x', cx + Math.cos(angle) * dr)
        .attr('y', cy + Math.sin(angle) * dr + 4)
        .attr('text-anchor', 'middle')
        .attr('fill', 'hsl(var(--muted-foreground))')
        .attr('font-size', '10px')
        .attr('font-weight', '500')
        .text(label);
    });

    // Zoom
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.5, 6])
      .on('zoom', (event) => content.attr('transform', event.transform.toString()));
    svg.call(zoom);
    zoomRef.current = zoom;

    return () => { svg.on('.zoom', null); };
  }, [nodes, centerStop, bands, maxMin, cx, cy, size]);

  const resetZoom = useCallback(() => {
    if (svgRef.current && zoomRef.current) d3.select(svgRef.current).transition().duration(400).call(zoomRef.current.transform, d3.zoomIdentity);
  }, []);
  const zoomIn = useCallback(() => {
    if (svgRef.current && zoomRef.current) d3.select(svgRef.current).transition().duration(300).call(zoomRef.current.scaleBy, 1.5);
  }, []);
  const zoomOut = useCallback(() => {
    if (svgRef.current && zoomRef.current) d3.select(svgRef.current).transition().duration(300).call(zoomRef.current.scaleBy, 0.67);
  }, []);

  // Stats
  const bandStats = useMemo(() => {
    const stats = new Map<number, number>();
    for (const n of nodes) {
      stats.set(n.band, (stats.get(n.band) ?? 0) + 1);
    }
    return Array.from(stats.entries()).sort((a, b) => a[0] - b[0]);
  }, [nodes]);

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

      {/* Controls */}
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
          {/* Zoom controls */}
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

          <svg
            ref={svgRef}
            width={size}
            height={size}
            viewBox={`0 0 ${size} ${size}`}
            className="block mx-auto"
          />
        </div>

        {/* Legend + stats */}
        <div className="flex flex-col gap-3 min-w-[180px]">
          <div className="bg-card border border-border rounded-lg p-3">
            <h4 className="text-xs font-semibold text-foreground mb-2">Bandes isochrones</h4>
            <div className="flex flex-col gap-1.5">
              {bands.map((m, i) => (
                <div key={m} className="flex items-center gap-2 text-xs">
                  <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: BAND_COLORS[i % BAND_COLORS.length] }} />
                  <span className="text-muted-foreground">{m - 4}–{m} min</span>
                  <span className="ml-auto font-mono text-foreground">{bandStats.find(([b]) => b === m)?.[1] ?? 0}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-card border border-border rounded-lg p-3">
            <h4 className="text-xs font-semibold text-foreground mb-2">Statistiques</h4>
            <div className="flex flex-col gap-1 text-xs text-muted-foreground">
              <div>Arrêts accessibles : <span className="font-mono text-foreground">{nodes.length}</span></div>
              <div>Temps médian : <span className="font-mono text-foreground">
                {nodes.length > 0 ? `${Math.round(nodes[Math.floor(nodes.length / 2)].travelTime / 60)} min` : '—'}
              </span></div>
              <div>Couverture : <span className="font-mono text-foreground">
                {graph.size > 0 ? `${Math.round((nodes.length / graph.size) * 100)}%` : '—'}
              </span></div>
            </div>
          </div>
        </div>
      </div>

      <div className="text-xs text-muted-foreground font-mono">
        {nodes.length} arrêts accessibles en ≤ {maxMin} min depuis {centerStop?.stop_name ?? '—'}
        {' · molette pour zoomer'}
      </div>
    </div>
  );
};

export default IsochroneDiagram;
