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
}

const TransitDiagram: React.FC<Props> = ({ analysis }) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const size = 640;

  const { nodes, links } = useMemo(() => {
    const nodes = analysis.routes.map(r => ({
      id: r.routeId,
      name: r.name,
      mode: r.mode as TransportMode,
      color: r.color || modeColors[r.mode],
      stopCount: r.stopCount,
      tripCount: r.tripCount,
      x: undefined as number | undefined,
      y: undefined as number | undefined,
      fx: null as number | null,
      fy: null as number | null,
    }));

    const sorted = [...analysis.correspondences].sort((a, b) => b.weight - a.weight);
    const links = sorted.slice(0, 200).map(c => ({
      source: c.routeA,
      target: c.routeB,
      weight: c.weight,
      sharedCount: c.sharedStops.length,
    }));

    return { nodes, links };
  }, [analysis]);

  useEffect(() => {
    if (!svgRef.current || nodes.length === 0) return;
    const svg = d3.select(svgRef.current);
    svg.selectAll('g.graph').remove();
    const g = svg.append('g').attr('class', 'graph');

    const nodeIds = new Set(nodes.map(n => n.id));
    const validLinks = links.filter(l => nodeIds.has(l.source as string) && nodeIds.has(l.target as string));
    const maxWeight = Math.max(...validLinks.map(l => l.weight), 1);
    const widthScale = d3.scaleLinear().domain([1, maxWeight]).range([0.4, 5]);
    const opacityScale = d3.scaleLinear().domain([1, maxWeight]).range([0.1, 0.5]);

    const simulation = d3.forceSimulation(nodes as any[])
      .force('link', d3.forceLink(validLinks).id((d: any) => d.id).distance(90))
      .force('charge', d3.forceManyBody().strength(-140))
      .force('center', d3.forceCenter(size / 2, size / 2))
      .force('collision', d3.forceCollide().radius(14));

    const link = g.selectAll('line.link')
      .data(validLinks)
      .enter().append('line')
      .attr('class', 'link')
      .attr('stroke', 'hsl(220, 10%, 72%)')
      .attr('stroke-width', (d: any) => widthScale(d.weight))
      .attr('stroke-opacity', (d: any) => opacityScale(d.weight))
      .attr('shape-rendering', 'geometricPrecision')
      .on('mouseenter', function (event, d: any) {
        d3.select(this).attr('stroke-opacity', 0.8).attr('stroke', 'hsl(220, 18%, 40%)');
        if (tooltipRef.current) {
          const srcName = nodes.find(n => n.id === (d.source.id || d.source))?.name || '';
          const tgtName = nodes.find(n => n.id === (d.target.id || d.target))?.name || '';
          tooltipRef.current.style.opacity = '1';
          tooltipRef.current.style.left = `${event.offsetX + 12}px`;
          tooltipRef.current.style.top = `${event.offsetY - 10}px`;
          tooltipRef.current.innerHTML = `
            <span class="font-semibold">${srcName} ↔ ${tgtName}</span><br/>
            <span class="text-muted-foreground">${d.sharedCount} station${d.sharedCount > 1 ? 's' : ''} commune${d.sharedCount > 1 ? 's' : ''}</span>
          `;
        }
      })
      .on('mouseleave', function (_, d: any) {
        d3.select(this).attr('stroke-opacity', opacityScale(d.weight)).attr('stroke', 'hsl(220, 10%, 72%)');
        if (tooltipRef.current) tooltipRef.current.style.opacity = '0';
      });

    const node = g.selectAll('circle.node')
      .data(nodes)
      .enter().append('circle')
      .attr('class', 'node')
      .attr('r', (d: any) => Math.max(4, Math.min(12, Math.sqrt(d.stopCount) * 1.2)))
      .attr('fill', (d: any) => d.color)
      .attr('fill-opacity', 0.85)
      .attr('stroke', 'hsl(0, 0%, 100%)')
      .attr('stroke-width', 1.2)
      .attr('cursor', 'grab')
      .on('mouseenter', function (event, d: any) {
        d3.select(this).attr('fill-opacity', 1).attr('stroke-width', 2);
        // Highlight connected links
        link.attr('stroke-opacity', (l: any) => {
          const sId = l.source.id || l.source;
          const tId = l.target.id || l.target;
          return (sId === d.id || tId === d.id) ? 0.7 : 0.05;
        });
        if (tooltipRef.current) {
          tooltipRef.current.style.opacity = '1';
          tooltipRef.current.style.left = `${event.offsetX + 12}px`;
          tooltipRef.current.style.top = `${event.offsetY - 10}px`;
          tooltipRef.current.innerHTML = `
            <span class="font-semibold">${d.name}</span>
            <span class="text-muted-foreground"> · ${modeLabels[d.mode as TransportMode]}</span><br/>
            <span class="text-muted-foreground">${d.stopCount} arrêts · ${d.tripCount} trajets</span>
          `;
        }
      })
      .on('mouseleave', function () {
        d3.select(this).attr('fill-opacity', 0.85).attr('stroke-width', 1.2);
        link.attr('stroke-opacity', (d: any) => opacityScale(d.weight));
        if (tooltipRef.current) tooltipRef.current.style.opacity = '0';
      });

    const label = g.selectAll('text.label')
      .data(nodes)
      .enter().append('text')
      .attr('class', 'label')
      .attr('font-size', '7px')
      .attr('font-family', 'IBM Plex Mono, monospace')
      .attr('fill', 'hsl(220, 20%, 30%)')
      .attr('fill-opacity', 0.7)
      .attr('text-anchor', 'middle')
      .attr('dy', -12)
      .attr('pointer-events', 'none')
      .text((d: any) => d.name);

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
      .on('zoom', (event) => {
        g.attr('transform', event.transform.toString());
      });
    svg.call(zoom);
    zoomRef.current = zoom;

    return () => { simulation.stop(); svg.on('.zoom', null); };
  }, [nodes, links, size]);

  const resetZoom = useCallback(() => {
    if (svgRef.current && zoomRef.current) {
      d3.select(svgRef.current).transition().duration(400).call(zoomRef.current.transform, d3.zoomIdentity);
    }
  }, []);
  const zoomInFn = useCallback(() => {
    if (svgRef.current && zoomRef.current) d3.select(svgRef.current).transition().duration(300).call(zoomRef.current.scaleBy, 1.5);
  }, []);
  const zoomOutFn = useCallback(() => {
    if (svgRef.current && zoomRef.current) d3.select(svgRef.current).transition().duration(300).call(zoomRef.current.scaleBy, 0.67);
  }, []);

  // Legend
  const modes = useMemo(() => {
    const seen = new Set<TransportMode>();
    analysis.routes.forEach(r => seen.add(r.mode));
    return Array.from(seen);
  }, [analysis.routes]);

  return (
    <div className="flex flex-col items-center gap-4">
      <HowToRead
        title="Diagramme de correspondances"
        what="Chaque cercle (nœud) représente une ligne de transport. Les traits entre eux montrent les correspondances : deux lignes sont reliées si elles partagent au moins une station. L'épaisseur du trait indique le nombre de stations partagées."
        deduce="Les nœuds très connectés sont des lignes structurantes du réseau. Les clusters de nœuds reliés révèlent des sous-réseaux cohérents. Une ligne isolée peut signaler un défaut de maillage."
        caution="La position des nœuds est calculée par un algorithme de force et ne représente pas la géographie. Seules les 200 correspondances les plus fortes sont affichées. Le nombre de trajets n'est pas reflété ici."
      />

      <div className="flex gap-4 items-start">
        <div className="viz-container p-4 relative" style={{ touchAction: 'none' }}>
          <div className="absolute top-3 left-3 flex flex-col gap-1 z-10">
            <button onClick={zoomInFn} className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors" title="Zoom +">
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
            <button onClick={zoomOutFn} className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors" title="Zoom −">
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <button onClick={resetZoom} className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors" title="Réinitialiser">
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          </div>

          <button
            onClick={() => svgRef.current && exportSvg(svgRef.current, 'transit-diagram')}
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
          items={modes.map(m => ({ color: modeColors[m], label: modeLabels[m] }))}
          notes={[
            'Taille du nœud = nombre d\'arrêts de la ligne',
            'Épaisseur du lien = stations communes',
            'Opacité du lien = force de la correspondance',
            'Glisser un nœud pour réorganiser',
          ]}
        />
      </div>

      <div className="text-xs text-muted-foreground font-mono">
        {nodes.length} lignes · {links.length} correspondances · molette pour zoomer
      </div>
    </div>
  );
};

export default TransitDiagram;
