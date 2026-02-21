/**
 * CSV export utility
 */
import type { AnalysisResult, RouteInfo } from './network-analysis';

function downloadCsv(content: string, filename: string) {
  const bom = '\uFEFF'; // UTF-8 BOM for Excel
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
    return [
      stopId,
      name,
      metrics?.routeCount ?? '',
      metrics?.correspondences ?? '',
      metrics?.frictionIndex?.toFixed(2) ?? '',
    ].join(',');
  });

  const header = 'stop_id,stop_name,lignes,correspondances,friction';
  downloadCsv([header, ...rows].join('\n'), `${route.name}-stations.csv`);
}

export function exportRouteCorrespondencesCsv(routeId: string, analysis: AnalysisResult) {
  const routeNames = new Map(analysis.routes.map(r => [r.routeId, r.name]));

  const corrs = analysis.correspondences
    .filter(c => c.routeA === routeId || c.routeB === routeId)
    .map(c => {
      const otherId = c.routeA === routeId ? c.routeB : c.routeA;
      return [
        otherId,
        routeNames.get(otherId) || otherId,
        c.sharedStops.length,
        c.weight,
      ].join(',');
    });

  const header = 'route_id,route_name,stations_partagees,poids';
  const routeName = routeNames.get(routeId) || routeId;
  downloadCsv([header, ...corrs].join('\n'), `${routeName}-correspondances.csv`);
}

export function exportNetworkCsv(analysis: AnalysisResult) {
  // All stations
  const stationRows = analysis.stationMetrics.map(s =>
    [s.stopId, `"${s.stopName}"`, s.routeCount, s.correspondences, s.frictionIndex.toFixed(2), s.betweenness.toFixed(4)].join(',')
  );
  const stationHeader = 'stop_id,stop_name,lignes,correspondances,friction,centralite';
  downloadCsv([stationHeader, ...stationRows].join('\n'), 'reseau-stations.csv');
}

export function exportPngFromSvg(svgElement: SVGSVGElement, filename: string) {
  const serializer = new XMLSerializer();
  const svgString = serializer.serializeToString(svgElement);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const img = new Image();
  const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);

  img.onload = () => {
    canvas.width = img.width * 2;
    canvas.height = img.height * 2;
    ctx.scale(2, 2);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, img.width, img.height);
    ctx.drawImage(img, 0, 0);
    
    const pngUrl = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = pngUrl;
    a.download = `${filename}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  img.src = url;
}
