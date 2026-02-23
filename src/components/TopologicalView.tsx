import React, { useEffect, useRef, useMemo, useCallback } from 'react';
import * as d3 from 'd3';
import type { AnalysisResult } from '@/lib/network-analysis';
import { modeColors, modeLabels } from '@/lib/gtfs-types';
import type { TransportMode } from '@/lib/gtfs-types';
import { exportSvg } from '@/lib/svg-export';
import { Download, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';
import HowToRead from './HowToRead';
import DiagramLegend from './DiagramLegend';

interface Props {
  analysis: AnalysisResult;
  selectedRouteId: string | null;
  onSelectRoute: (routeId: string | null) => void;
}

const TopologicalView: React.FC<Props> = ({ analysis, selectedRouteId, onSelectRoute }) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const size = 700;

  // Build station nodes and route edges
  const { stationNodes, routeEdges } = useMemo(() => {
    // Use top stations by friction (max 120 to keep performant)
    const topStations = analysis.stationMetrics
      .filter(s => s.routeCount >= 2)
      .slice(0, 120);

    const stationSet = new Set(topStations.map(s => s.stopId));

    const stationNodes = topStations.map(s => ({
      id: s.stopId,
      name: s.stopName,
      routeCount: s.routeCount,
      friction: s.frictionIndex,
      correspondences: s.correspondences,
      x: undefined as number | undefined,
      y: undefined as number | undefined,
      fx: null as number | null,
      fy: null as number | null,
    }));

    // Build edges: stations connected if they share a route
    const edgeMap = new Map<string, { source: string; target: string; routes: Set<string> }>();
    
    for (const route of analysis.routes) {
      // Find stations from stationMetrics that are in this route's correspondences
      const routeStations = topStations.filter(s => {
        return analysis.correspondences.some(c => {
          if (c.routeA !== route.routeId && c.routeB !== route.routeId) return false;
          return c.sharedStops.includes(s.stopId);
        });
      });

      for (let i = 0; i < routeStations.length; i++) {
        for (let j = i + 1; j < routeStations.length; j++) {
          const key = [routeStations[i].stopId, routeStations[j].stopId].sort().join('|||');
          if (!edgeMap.has(key)) {
            edgeMap.set(key, {
              source: routeStations[i].stopId,
              target: routeStations[j].stopId,
              routes: new Set(),
            });
          }
          edgeMap.get(key)!.routes.add(route.routeId);
        }
      }
    }

    const routeEdges = Array.from(edgeMap.values())
      .map(e => ({ ...e, weight: e.routes.size, routeIds: Array.from(e.routes) }))
      .filter(e => stationSet.has(e.source) && stationSet.has(e.target))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 300);

    return { stationNodes, routeEdges };
  }, [analysis]);

  useEffect(() => {
    if (!svgRef.current || stationNodes.length === 0) return;
    const svg = d3.select(svgRef.current);
    svg.selectAll('g.topo').remove();
    const g = svg.append('g').attr('class', 'topo');

    const maxFriction = Math.max(...stationNodes.map(n => n.friction), 1);
    const radiusScale = d3.scaleLinear().domain([1, Math.max(...stationNodes.map(n => n.routeCount), 2)]).range([4, 16]);
    const colorScale = d3.scaleSequential(d3.interpolateYlOrRd).domain([0, maxFriction]);

    const simulation = d3.forceSimulation(stationNodes as any[])
      .force('link', d3.forceLink(routeEdges as any[]).id((d: any) => d.id).distance(50))
      .force('charge', d3.forceManyBody().strength(-80))
      .force('center', d3.forceCenter(size / 2, size / 2))
      .force('collision', d3.forceCollide().radius((d: any) => radiusScale(d.routeCount) + 2));

    const link = g.selectAll('line.edge')
      .data(routeEdges)
      .enter().append('line')
      .attr('class', 'edge')
      .attr('stroke', 'hsl(220, 10%, 72%)')
      .attr('stroke-width', (d: any) => Math.max(0.5, Math.min(4, d.weight)))
      .attr('stroke-opacity', 0.3);

    const node = g.selectAll('circle.station')
      .data(stationNodes)
      .enter().append('circle')
      .attr('class', 'station')
      .attr('r', (d: any) => radiusScale(d.routeCount))
      .attr('fill', (d: any) => colorScale(d.friction))
      .attr('stroke', 'hsl(0, 0%, 100%)')
      .attr('stroke-width', 1.5)
      .attr('cursor', 'pointer')
      .on('mouseenter', function (event, d: any) {
        d3.select(this).attr('stroke-width', 3).attr('stroke', 'hsl(220, 20%, 20%)');
        if (tooltipRef.current) {
          tooltipRef.current.style.opacity = '1';
          tooltipRef.current.style.left = `${event.offsetX + 14}px`;
          tooltipRef.current.style.top = `${event.offsetY - 10}px`;
          tooltipRef.current.innerHTML = `
            <span class="font-semibold">${d.name}</span><br/>
            <span class="text-muted-foreground">${d.routeCount} lignes · ${d.correspondences} corr.</span><br/>
            <span class="text-muted-foreground">Friction: ${d.friction.toFixed(2)}</span>
          `;
        }
      })
      .on('mouseleave', function () {
        d3.select(this).attr('stroke-width', 1.5).attr('stroke', 'hsl(0, 0%, 100%)');
        if (tooltipRef.current) tooltipRef.current.style.opacity = '0';
      });

    const label = g.selectAll('text.stlabel')
      .data(stationNodes.filter(n => n.routeCount >= 3))
      .enter().append('text')
      .attr('class', 'stlabel')
      .attr('font-size', '6px')
      .attr('font-family', 'IBM Plex Mono, monospace')
      .attr('fill', 'hsl(220, 20%, 30%)')
      .attr('fill-opacity', 0.8)
      .attr('text-anchor', 'middle')
      .attr('dy', (d: any) => -(radiusScale(d.routeCount) + 4))
      .attr('pointer-events', 'none')
      .text((d: any) => d.name.length > 20 ? d.name.slice(0, 18) + '…' : d.name);

    simulation.on('tick', () => {
      link
        .attr('x1', (d: any) => d.source.x).attr('y1', (d: any) => d.source.y)
        .attr('x2', (d: any) => d.target.x).attr('y2', (d: any) => d.target.y);
      node.attr('cx', (d: any) => d.x).attr('cy', (d: any) => d.y);
      label.attr('x', (d: any) => d.x).attr('y', (d: any) => d.y);
    });

    // Drag
    const drag = d3.drag<SVGCircleElement, any>()
      .on('start', (event, d) => {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x; d.fy = d.y;
      })
      .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
      .on('end', (event, d) => {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null; d.fy = null;
      });
    node.call(drag as any);

    // Zoom
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.3, 8])
      .on('zoom', (event) => { g.attr('transform', event.transform.toString()); });
    svg.call(zoom);
    zoomRef.current = zoom;

    return () => { simulation.stop(); svg.on('.zoom', null); };
  }, [stationNodes, routeEdges, size]);

  const resetZoom = useCallback(() => {
    if (svgRef.current && zoomRef.current)
      d3.select(svgRef.current).transition().duration(400).call(zoomRef.current.transform, d3.zoomIdentity);
  }, []);
  const zoomIn = useCallback(() => {
    if (svgRef.current && zoomRef.current) d3.select(svgRef.current).transition().duration(300).call(zoomRef.current.scaleBy, 1.5);
  }, []);
  const zoomOut = useCallback(() => {
    if (svgRef.current && zoomRef.current) d3.select(svgRef.current).transition().duration(300).call(zoomRef.current.scaleBy, 0.67);
  }, []);

  return (
    <div className="flex flex-col items-center gap-4">
      <HowToRead
        title="Vue topologique du réseau"
        what="Chaque cercle représente une station desservie par 2+ lignes. La taille indique le nombre de lignes qui s'y croisent. La couleur varie du jaune (friction faible) au rouge (friction élevée). Les traits entre stations montrent qu'elles partagent au moins une ligne commune."
        deduce="Les gros nœuds rouges sont des goulots d'étranglement potentiels. Les clusters denses révèlent des pôles d'échange majeurs. Les stations isolées en périphérie indiquent des zones mal maillées nécessitant de nouvelles connexions."
        caution="Seules les stations multi-lignes sont affichées (max 120). La position est calculée algorithmiquement et ne reflète pas la géographie réelle. La friction seule ne suffit pas à conclure — croisez avec les données de fréquentation."
        examples={[
          "Un gros nœud rouge central (ex: gare principale) connecté à 8+ lignes confirme un hub majeur — mais aussi un point de vulnérabilité si la station tombe en panne.",
          "Un chapelet de petits nœuds jaunes reliés en ligne droite révèle un corridor de transport linéaire (ex: ligne de tram) sans alternatives parallèles.",
          "Deux clusters denses non reliés entre eux signalent deux sous-réseaux indépendants — une opportunité pour une nouvelle ligne de liaison.",
        ]}
      />

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
            onClick={() => svgRef.current && exportSvg(svgRef.current, 'topological-view')}
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

        <DiagramLegend
          title="Légende"
          items={[
            { color: 'hsl(60, 80%, 55%)', label: 'Friction faible' },
            { color: 'hsl(30, 90%, 50%)', label: 'Friction modérée' },
            { color: 'hsl(0, 72%, 51%)', label: 'Friction élevée' },
          ]}
          notes={[
            'Taille du nœud = nombre de lignes',
            'Couleur = indice de friction',
            'Traits = lignes partagées entre stations',
            'Glisser un nœud pour réorganiser',
          ]}
        />
      </div>

      <div className="text-xs text-muted-foreground font-mono">
        {stationNodes.length} stations · {routeEdges.length} liaisons · molette pour zoomer
      </div>
    </div>
  );
};

export default TopologicalView;
