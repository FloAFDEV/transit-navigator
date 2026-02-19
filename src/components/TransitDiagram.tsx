import React, { useEffect, useRef, useMemo } from 'react';
import * as d3 from 'd3';
import type { AnalysisResult } from '@/lib/network-analysis';
import { modeColors } from '@/lib/gtfs-types';
import { exportSvg } from '@/lib/svg-export';
import { Download } from 'lucide-react';

interface Props {
  analysis: AnalysisResult;
}

interface Node {
  id: string;
  name: string;
  mode: string;
  color: string;
  stopCount: number;
  x?: number;
  y?: number;
  fx?: number | null;
  fy?: number | null;
}

interface Link {
  source: string;
  target: string;
  weight: number;
}

const TransitDiagram: React.FC<Props> = ({ analysis }) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const size = 600;

  const { nodes, links } = useMemo(() => {
    const nodes: Node[] = analysis.routes.map(r => ({
      id: r.routeId,
      name: r.name,
      mode: r.mode,
      color: r.color || modeColors[r.mode],
      stopCount: r.stopCount,
    }));

    // Only top 200 correspondences to keep it readable
    const sorted = [...analysis.correspondences].sort((a, b) => b.weight - a.weight);
    const links: Link[] = sorted.slice(0, 200).map(c => ({
      source: c.routeA,
      target: c.routeB,
      weight: c.weight,
    }));

    return { nodes, links };
  }, [analysis]);

  useEffect(() => {
    if (!svgRef.current || nodes.length === 0) return;
    const svg = d3.select(svgRef.current);
    svg.selectAll('g.graph').remove();
    const g = svg.append('g').attr('class', 'graph');

    const nodeIds = new Set(nodes.map(n => n.id));
    const validLinks = links.filter(l => nodeIds.has(l.source) && nodeIds.has(l.target));

    const maxWeight = Math.max(...validLinks.map(l => l.weight), 1);
    const widthScale = d3.scaleLinear().domain([1, maxWeight]).range([0.5, 4]);
    const opacityScale = d3.scaleLinear().domain([1, maxWeight]).range([0.15, 0.6]);

    const simulation = d3.forceSimulation(nodes as d3.SimulationNodeDatum[])
      .force('link', d3.forceLink(validLinks).id((d: any) => d.id).distance(80))
      .force('charge', d3.forceManyBody().strength(-120))
      .force('center', d3.forceCenter(size / 2, size / 2))
      .force('collision', d3.forceCollide().radius(12));

    const link = g.selectAll('line.link')
      .data(validLinks)
      .enter().append('line')
      .attr('class', 'link')
      .attr('stroke', 'hsl(220, 10%, 70%)')
      .attr('stroke-width', (d: any) => widthScale(d.weight))
      .attr('stroke-opacity', (d: any) => opacityScale(d.weight));

    const node = g.selectAll('circle.node')
      .data(nodes)
      .enter().append('circle')
      .attr('class', 'node')
      .attr('r', (d: any) => Math.max(4, Math.min(10, Math.sqrt(d.stopCount))))
      .attr('fill', (d: any) => d.color)
      .attr('stroke', 'white')
      .attr('stroke-width', 1);

    const label = g.selectAll('text.label')
      .data(nodes)
      .enter().append('text')
      .attr('class', 'label')
      .attr('font-size', '8px')
      .attr('font-family', 'IBM Plex Mono, monospace')
      .attr('fill', 'hsl(220, 20%, 14%)')
      .attr('text-anchor', 'middle')
      .attr('dy', -10)
      .text((d: any) => d.name);

    simulation.on('tick', () => {
      link
        .attr('x1', (d: any) => d.source.x)
        .attr('y1', (d: any) => d.source.y)
        .attr('x2', (d: any) => d.target.x)
        .attr('y2', (d: any) => d.target.y);
      node
        .attr('cx', (d: any) => d.x)
        .attr('cy', (d: any) => d.y);
      label
        .attr('x', (d: any) => d.x)
        .attr('y', (d: any) => d.y);
    });

    // Drag behavior
    const drag = d3.drag<SVGCircleElement, any>()
      .on('start', (event, d) => {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on('drag', (event, d) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on('end', (event, d) => {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      });

    node.call(drag as any);

    return () => { simulation.stop(); };
  }, [nodes, links, size]);

  return (
    <div className="flex flex-col items-center">
      <div className="viz-container p-4 relative">
        <button
          onClick={() => svgRef.current && exportSvg(svgRef.current, 'transit-diagram')}
          className="absolute top-3 right-3 p-2 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
          title="Exporter SVG"
        >
          <Download className="w-4 h-4" />
        </button>
        <svg
          ref={svgRef}
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          className="block mx-auto"
        />
      </div>
      <div className="mt-3 text-xs text-muted-foreground font-mono">
        {nodes.length} lignes · {links.length} correspondances affichées
      </div>
    </div>
  );
};

export default TransitDiagram;
