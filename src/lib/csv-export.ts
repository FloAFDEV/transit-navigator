import type { AnalysisResult, RouteInfo } from './network-analysis';

function downloadCsv(content: string, filename: string) {
  const bom = '﻿';
  const blob = new Blob([bom + content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function exportRouteStationsCsv(route: RouteInfo, analysis: AnalysisResult) {
  const stopNames = new Map(analysis.stationMetrics.map(s => [s.stopId, s.stopName]));
  const rows = Array.from(route.stops).map(stopId => {
    const name = stopNames.get(stopId) || stopId;
    const metrics = analysis.stationMetrics.find(s => s.stopId === stopId);
    return [stopId, name, metrics?.routeCount ?? '', metrics?.correspondences ?? '', metrics?.frictionIndex?.toFixed(2) ?? ''].join(',');
  });
  downloadCsv(['stop_id,stop_name,lignes,correspondances,friction', ...rows].join('\n'), `${route.name}-stations.csv`);
}

export function exportRouteCorrespondencesCsv(routeId: string, analysis: AnalysisResult) {
  const routeNames = new Map(analysis.routes.map(r => [r.routeId, r.name]));
  const corrs = analysis.correspondences
    .filter(c => c.routeA === routeId || c.routeB === routeId)
    .map(c => {
      const otherId = c.routeA === routeId ? c.routeB : c.routeA;
      return [otherId, routeNames.get(otherId) || otherId, c.sharedStops.length, c.weight].join(',');
    });
  downloadCsv(['route_id,route_name,stations_partagees,poids', ...corrs].join('\n'), `${routeNames.get(routeId) || routeId}-correspondances.csv`);
}

export function exportNetworkCsv(analysis: AnalysisResult) {
  const rows = analysis.stationMetrics.map(s =>
    [s.stopId, `"${s.stopName}"`, s.routeCount, s.correspondences, s.frictionIndex.toFixed(2), s.betweenness.toFixed(4)].join(','),
  );
  downloadCsv(['stop_id,stop_name,lignes,correspondances,friction,centralite', ...rows].join('\n'), 'reseau-stations.csv');
}

function inlineSvgComputedStyles(orig: SVGSVGElement, clone: SVGSVGElement): void {
  const origEls = [orig as SVGElement, ...Array.from(orig.querySelectorAll<SVGElement>('*'))];
  const cloneEls = [clone as SVGElement, ...Array.from(clone.querySelectorAll<SVGElement>('*'))];
  origEls.forEach((origEl, i) => {
    const cloneEl = cloneEls[i];
    if (!cloneEl) return;
    const cs = getComputedStyle(origEl);
    for (const attr of ['fill', 'stroke', 'color'] as const) {
      const raw = cloneEl.getAttribute(attr) ?? '';
      if (raw.includes('var(')) {
        const resolved = cs.getPropertyValue(attr).trim();
        if (resolved) cloneEl.setAttribute(attr, resolved);
      }
    }
  });
}

export function exportPngFromSvg(svgElement: SVGSVGElement, filename: string): void {
  const w = svgElement.clientWidth || Number(svgElement.getAttribute('width')) || 600;
  const h = svgElement.clientHeight || Number(svgElement.getAttribute('height')) || 600;

  const clone = svgElement.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('width', String(w));
  clone.setAttribute('height', String(h));
  inlineSvgComputedStyles(svgElement, clone);

  const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;

  img.onload = () => {
    canvas.width = w * 2;
    canvas.height = h * 2;
    ctx.scale(2, 2);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = `${filename}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };
  img.onerror = () => URL.revokeObjectURL(url);
  img.src = url;
}
