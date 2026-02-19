import React, { useEffect, useRef, useMemo } from 'react';
import * as d3 from 'd3';
import type { AnalysisResult, RouteInfo } from '@/lib/network-analysis';
import type { TransportMode } from '@/lib/gtfs-types';
import { modeColors } from '@/lib/gtfs-types';
import { exportSvg } from '@/lib/svg-export';
import { Download } from 'lucide-react';

interface Props {
  analysis: AnalysisResult;
  filterMode: TransportMode | 'all';
}

const CircularDensityDiagram: React.FC<Props> = ({ analysis, filterMode }) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const size = 520;
  const cx = size / 2;
  const cy = size / 2;
  const radius = 210;

  const filteredRoutes = useMemo(() => {
    if (filterMode === 'all') return analysis.routes;
    return analysis.routes.filter(r => r.mode === filterMode);
  }, [analysis.routes, filterMode]);

  useEffect(() => {
    if (!svgRef.current) return;
    const svg = d3.select(svgRef.current);
    svg.selectAll('g.lines').remove();
    
    const g = svg.append('g').attr('class', 'lines');
    const n = filteredRoutes.length;
    if (n === 0) return;

    // Distribute angles evenly, each line crosses the circle
    filteredRoutes.forEach((route, i) => {
      const angle = (i / n) * Math.PI; // 0 to PI (lines go through center area)
      // Slight random offset to avoid all lines going through exact center
      const offsetFactor = 0.15;
      const offsetX = (Math.random() - 0.5) * radius * offsetFactor;
      const offsetY = (Math.random() - 0.5) * radius * offsetFactor;
      
      const x1 = cx + Math.cos(angle) * radius + offsetX;
      const y1 = cy + Math.sin(angle) * radius + offsetY;
      const x2 = cx - Math.cos(angle) * radius + offsetX;
      const y2 = cy - Math.sin(angle) * radius + offsetY;

      const color = route.color || modeColors[route.mode];
      
      g.append('line')
        .attr('x1', x1)
        .attr('y1', y1)
        .attr('x2', x2)
        .attr('y2', y2)
        .attr('stroke', color)
        .attr('stroke-width', Math.max(0.5, Math.min(2, 60 / n)))
        .attr('stroke-opacity', Math.max(0.3, Math.min(0.8, 30 / n)))
        .attr('stroke-linecap', 'round');
    });
  }, [filteredRoutes, cx, cy, radius]);

  return (
    <div className="flex flex-col items-center">
      <div className="viz-container p-4 relative">
        <button
          onClick={() => svgRef.current && exportSvg(svgRef.current, 'circular-density')}
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
        >
          <circle
            cx={cx}
            cy={cy}
            r={radius}
            fill="none"
            stroke="hsl(220, 14%, 80%)"
            strokeWidth={1.5}
          />
        </svg>
      </div>
      <div className="mt-3 text-xs text-muted-foreground font-mono">
        {filteredRoutes.length} ligne{filteredRoutes.length !== 1 ? 's' : ''}
        {filterMode !== 'all' && ` · ${filterMode}`}
      </div>
    </div>
  );
};

export default CircularDensityDiagram;
