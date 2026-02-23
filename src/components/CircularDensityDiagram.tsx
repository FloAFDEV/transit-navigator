import React, { useEffect, useRef, useMemo, useCallback } from 'react';
import * as d3 from 'd3';
import type { AnalysisResult } from '@/lib/network-analysis';
import type { TransportMode } from '@/lib/gtfs-types';
import { modeColors, modeLabels } from '@/lib/gtfs-types';
import { exportSvg } from '@/lib/svg-export';
import { Download, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';
import HowToRead from './HowToRead';
import DiagramLegend from './DiagramLegend';

interface Props {
  analysis: AnalysisResult;
  filterMode: TransportMode | 'all';
  selectedRouteId: string | null;
  onSelectRoute: (routeId: string | null) => void;
}

const CircularDensityDiagram: React.FC<Props> = ({ analysis, filterMode, selectedRouteId, onSelectRoute }) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const size = 560;
  const cx = size / 2;
  const cy = size / 2;
  const radius = 220;

  const filteredRoutes = useMemo(() => {
    if (filterMode === 'all') return analysis.routes;
    return analysis.routes.filter(r => r.mode === filterMode);
  }, [analysis.routes, filterMode]);

  const routePositions = useMemo(() => {
    return filteredRoutes.map((route, i) => {
      const n = filteredRoutes.length;
      const angle = (i / n) * Math.PI;
      let hash = 0;
      for (let c = 0; c < route.routeId.length; c++) {
        hash = ((hash << 5) - hash + route.routeId.charCodeAt(c)) | 0;
      }
      const offsetFactor = 0.18;
      const ox = ((hash % 100) / 100 - 0.5) * radius * offsetFactor;
      const oy = (((hash >> 8) % 100) / 100 - 0.5) * radius * offsetFactor;

      return {
        route,
        x1: cx + Math.cos(angle) * radius + ox,
        y1: cy + Math.sin(angle) * radius + oy,
        x2: cx - Math.cos(angle) * radius + ox,
        y2: cy - Math.sin(angle) * radius + oy,
        color: route.color || modeColors[route.mode],
      };
    });
  }, [filteredRoutes, cx, cy, radius]);

  useEffect(() => {
    if (!svgRef.current) return;
    const svg = d3.select(svgRef.current);
    svg.selectAll('g.content').remove();
    const content = svg.append('g').attr('class', 'content');

    content.append('circle')
      .attr('cx', cx).attr('cy', cy).attr('r', radius)
      .attr('fill', 'none')
      .attr('stroke', 'hsl(220, 14%, 82%)')
      .attr('stroke-width', 1.2);

    const n = routePositions.length;
    if (n === 0) return;

    const strokeW = Math.max(0.6, Math.min(2.5, 80 / n));
    const baseOpacity = Math.max(0.2, Math.min(0.7, 40 / n));

    routePositions.forEach(({ route, x1, y1, x2, y2, color }) => {
      content.append('line')
        .attr('x1', x1).attr('y1', y1)
        .attr('x2', x2).attr('y2', y2)
        .attr('stroke', color)
        .attr('stroke-width', strokeW)
        .attr('stroke-opacity', baseOpacity)
        .attr('stroke-linecap', 'round')
        .attr('shape-rendering', 'geometricPrecision')
        .attr('data-route', route.routeId)
        .attr('cursor', 'pointer')
        .on('mouseenter', function (event) {
          if (!selectedRouteId) {
            d3.select(this).attr('stroke-opacity', 1).attr('stroke-width', strokeW * 2.5);
          }
          if (tooltipRef.current) {
            tooltipRef.current.style.opacity = '1';
            tooltipRef.current.style.left = `${event.offsetX + 12}px`;
            tooltipRef.current.style.top = `${event.offsetY - 10}px`;
            tooltipRef.current.innerHTML = `
              <span class="font-semibold">${route.name}</span>
              <span class="text-muted-foreground"> · ${modeLabels[route.mode]}</span>
              <br/><span class="text-muted-foreground">${route.stopCount} arrêts · ${route.tripCount} trajets</span>
              <br/><span class="text-muted-foreground text-[10px]">Cliquer pour ${selectedRouteId === route.routeId ? 'désélectionner' : 'sélectionner'}</span>
            `;
          }
        })
        .on('mouseleave', function () {
          if (!selectedRouteId) {
            d3.select(this).attr('stroke-opacity', baseOpacity).attr('stroke-width', strokeW);
          }
          if (tooltipRef.current) tooltipRef.current.style.opacity = '0';
        })
        .on('click', function () {
          onSelectRoute(selectedRouteId === route.routeId ? null : route.routeId);
        });
    });

    // Store for selection updates
    (svgRef.current as any).__contentGroup = content;
    (svgRef.current as any).__strokeW = strokeW;
    (svgRef.current as any).__baseOpacity = baseOpacity;

    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.5, 8])
      .on('zoom', (event) => {
        content.attr('transform', event.transform.toString());
      });
    svg.call(zoom);
    zoomRef.current = zoom;

    return () => { svg.on('.zoom', null); };
  }, [routePositions, cx, cy, radius]);

  // Update selection visuals without re-creating content
  useEffect(() => {
    if (!svgRef.current) return;
    const el = svgRef.current as any;
    const content = el.__contentGroup as d3.Selection<SVGGElement, unknown, null, undefined> | undefined;
    const strokeW = el.__strokeW as number;
    const baseOpacity = el.__baseOpacity as number;
    if (!content) return;

    content.selectAll('line').each(function () {
      const line = d3.select(this);
      const routeId = line.attr('data-route');
      if (!routeId) return;

      if (selectedRouteId) {
        if (routeId === selectedRouteId) {
          line.attr('stroke-opacity', 1).attr('stroke-width', strokeW * 3);
        } else {
          line.attr('stroke-opacity', 0.08).attr('stroke-width', strokeW);
        }
      } else {
        line.attr('stroke-opacity', baseOpacity).attr('stroke-width', strokeW);
      }
    });
  }, [selectedRouteId]);

  const resetZoom = useCallback(() => {
    if (svgRef.current && zoomRef.current) {
      d3.select(svgRef.current).transition().duration(400).call(zoomRef.current.transform, d3.zoomIdentity);
    }
  }, []);
  const zoomIn = useCallback(() => {
    if (svgRef.current && zoomRef.current) d3.select(svgRef.current).transition().duration(300).call(zoomRef.current.scaleBy, 1.5);
  }, []);
  const zoomOut = useCallback(() => {
    if (svgRef.current && zoomRef.current) d3.select(svgRef.current).transition().duration(300).call(zoomRef.current.scaleBy, 0.67);
  }, []);

  const legendItems = useMemo(() => {
    if (filterMode === 'all') {
      return (['bus', 'metro', 'tram', 'train', 'cable'] as TransportMode[])
        .filter(m => analysis.routes.some(r => r.mode === m))
        .map(m => ({ color: modeColors[m], label: modeLabels[m] }));
    }
    return [{ color: modeColors[filterMode], label: modeLabels[filterMode] }];
  }, [filterMode, analysis.routes]);

  return (
    <div className="flex flex-col items-center gap-4">
      <HowToRead
        title="Diagramme circulaire de densité"
        what="Chaque trait droit traversant le cercle représente une ligne de transport. La couleur indique le mode (bus, métro, tram, train, câble). Plus le cercle est rempli, plus le réseau est dense pour le mode sélectionné."
        deduce="Un cercle très rempli indique un réseau dense. Comparer les modes via les filtres permet de voir lequel domine l'offre. Cliquez sur un trait pour explorer la ligne en détail dans le panneau latéral."
        caution="Ce diagramme ne représente pas la géographie réelle. La position angulaire des traits est arbitraire et n'indique pas le tracé des lignes. La densité visuelle peut être trompeuse si un mode a beaucoup de lignes courtes."
        examples={[
          "Si le filtre 'Bus' remplit tout le cercle mais 'Métro' n'a que 2 traits, le réseau repose massivement sur le bus — un déséquilibre modal à questionner.",
          "Un trait épais et lumineux entouré de traits fins peut indiquer une ligne structurante (ex: ligne de métro) au milieu de lignes secondaires.",
          "En filtrant mode par mode, vous pouvez comparer la couverture : un réseau avec 80 lignes de bus et 2 de tram révèle une dépendance au mode routier.",
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
            <button onClick={resetZoom} className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors" title="Réinitialiser la vue">
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          </div>

          <button
            onClick={() => svgRef.current && exportSvg(svgRef.current, 'circular-density')}
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
            style={{ shapeRendering: 'geometricPrecision' }}
          />
        </div>

        <DiagramLegend
          title="Légende"
          items={legendItems}
          notes={[
            'Chaque trait = une ligne de transport',
            'Cliquer un trait = sélectionner la ligne',
            'Survoler pour voir les détails',
          ]}
        />
      </div>

      <div className="text-xs text-muted-foreground font-mono">
        {filteredRoutes.length} ligne{filteredRoutes.length !== 1 ? 's' : ''}
        {filterMode !== 'all' && ` · ${modeLabels[filterMode]}`}
        {selectedRouteId && ' · ligne sélectionnée'}
        {' · molette pour zoomer'}
      </div>
    </div>
  );
};

export default CircularDensityDiagram;
