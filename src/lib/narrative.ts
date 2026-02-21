/**
 * Auto-generated network narrative — produces human-readable analysis text
 */
import type { AnalysisResult } from './network-analysis';
import { modeLabels } from './gtfs-types';
import type { TransportMode } from './gtfs-types';

export function generateNarrative(analysis: AnalysisResult, selectedRouteId?: string | null): string {
  const { routes, stationMetrics, networkMetrics, correspondences } = analysis;
  const m = networkMetrics;

  // Mode distribution
  const modeCounts = new Map<string, number>();
  routes.forEach(r => modeCounts.set(r.mode, (modeCounts.get(r.mode) || 0) + 1));
  const modeStr = Array.from(modeCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([mode, count]) => `${count} ${modeLabels[mode as TransportMode] || mode}`)
    .join(', ');

  // Top central stations
  const topStations = stationMetrics.slice(0, 3);
  const topStationNames = topStations.map(s => s.stopName).join(', ');

  // Route connection counts
  const routeConnections = new Map<string, number>();
  for (const c of correspondences) {
    routeConnections.set(c.routeA, (routeConnections.get(c.routeA) || 0) + c.weight);
    routeConnections.set(c.routeB, (routeConnections.get(c.routeB) || 0) + c.weight);
  }
  const topRoutes = routes
    .map(r => ({ ...r, conn: routeConnections.get(r.routeId) || 0 }))
    .sort((a, b) => b.conn - a.conn);

  // Fragility: routes with high connections but low redundancy
  const fragileRoutes = topRoutes.filter(r => {
    const routeCorrs = correspondences.filter(c => c.routeA === r.routeId || c.routeB === r.routeId);
    const uniqueConnected = new Set(routeCorrs.flatMap(c => [c.routeA, c.routeB]));
    uniqueConnected.delete(r.routeId);
    return uniqueConnected.size <= 2 && r.conn > 5;
  }).slice(0, 3);

  let text = `Le réseau analysé comprend **${m.totalRoutes} lignes** (${modeStr}) desservant **${m.totalStops} arrêts** avec **${m.totalCorrespondences} correspondances** identifiées.\n\n`;

  // Centrality
  if (topStations.length > 0) {
    text += `**Centralité :** Le réseau présente une forte centralité autour de ${topStationNames}. `;
    text += `Ces stations concentrent respectivement ${topStations.map(s => `${s.routeCount} lignes`).join(', ')}. `;
    const maxFriction = topStations[0];
    if (maxFriction.frictionIndex > 2) {
      text += `La station ${maxFriction.stopName} affiche un indice de friction de ${maxFriction.frictionIndex.toFixed(2)}, ce qui en fait un point critique du réseau.\n\n`;
    } else {
      text += '\n\n';
    }
  }

  // Redundancy
  text += `**Redondance :** ${(m.networkRedundancy * 100).toFixed(1)}% des paires de lignes possibles sont interconnectées. `;
  if (m.networkRedundancy > 0.5) {
    text += 'Le réseau offre de nombreux itinéraires alternatifs, ce qui le rend résilient aux perturbations.\n\n';
  } else if (m.networkRedundancy > 0.2) {
    text += 'Le maillage est modéré : certaines zones bénéficient de bonnes alternatives, d\'autres sont plus vulnérables.\n\n';
  } else {
    text += 'Le réseau est peu redondant, ce qui le rend fragile face aux interruptions de service.\n\n';
  }

  // Fragility
  if (fragileRoutes.length > 0) {
    text += `**Fragilité :** Les lignes ${fragileRoutes.map(r => r.name).join(', ')} sont identifiées comme critiques car elles combinent un fort volume de correspondances avec peu de redondance. Leur interruption impacterait significativement la connectivité du réseau.\n\n`;
  }

  // Readability
  text += `**Lisibilité :** Le score de lisibilité est de ${(m.readabilityScore * 100).toFixed(0)}%. `;
  if (m.readabilityScore > 0.7) {
    text += 'Le réseau est relativement simple à comprendre pour un usager.\n\n';
  } else if (m.readabilityScore > 0.4) {
    text += 'La complexité du réseau peut nécessiter une signalétique renforcée.\n\n';
  } else {
    text += 'Le réseau est complexe et pourrait bénéficier d\'une simplification ou d\'outils d\'aide à la navigation.\n\n';
  }

  // Selected route narrative
  if (selectedRouteId) {
    const route = routes.find(r => r.routeId === selectedRouteId);
    if (route) {
      const routeCorrs = correspondences.filter(c => c.routeA === selectedRouteId || c.routeB === selectedRouteId);
      const connCount = routeConnections.get(selectedRouteId) || 0;
      const connectedIds = new Set(routeCorrs.flatMap(c => [c.routeA, c.routeB]));
      connectedIds.delete(selectedRouteId);

      text += `---\n\n**Ligne sélectionnée : ${route.name}** (${modeLabels[route.mode]})\n\n`;
      text += `Cette ligne dessert ${route.stopCount} arrêts et partage ${routeCorrs.length} correspondances avec ${connectedIds.size} autres lignes (poids total : ${connCount}). `;

      const centrality = correspondences.length > 0 ? routeCorrs.length / correspondences.length : 0;
      if (centrality > 0.1) {
        text += `Avec ${(centrality * 100).toFixed(1)}% des correspondances du réseau, c'est une ligne structurante.\n`;
      } else {
        text += `Sa centralité (${(centrality * 100).toFixed(1)}%) en fait une ligne secondaire dans le maillage.\n`;
      }
    }
  }

  return text;
}

export function generateStationExplanation(
  stationName: string,
  routeCount: number,
  correspondences: number,
  friction: number,
  totalRoutes: number
): string {
  const lines: string[] = [];

  lines.push(`**${stationName}** est desservi(e) par ${routeCount} lignes de transport.`);

  if (correspondences > 5) {
    lines.push(`Avec ${correspondences} correspondances possibles, cette station est un hub majeur du réseau.`);
  } else if (correspondences > 2) {
    lines.push(`${correspondences} correspondances y sont possibles, un niveau d'interconnexion modéré.`);
  }

  if (friction > 3) {
    lines.push(`L'indice de friction élevé (${friction.toFixed(2)}) signale une complexité importante : de nombreux échanges se concentrent ici, ce qui peut créer de la congestion.`);
  } else if (friction > 1.5) {
    lines.push(`L'indice de friction modéré (${friction.toFixed(2)}) indique un volume d'échanges significatif mais gérable.`);
  } else {
    lines.push(`L'indice de friction faible (${friction.toFixed(2)}) indique une charge d'échanges maîtrisée.`);
  }

  const share = totalRoutes > 0 ? (routeCount / totalRoutes * 100) : 0;
  if (share > 15) {
    lines.push(`Cette station concentre ${share.toFixed(0)}% des lignes du réseau : sa défaillance impacterait fortement la mobilité.`);
  }

  return lines.join(' ');
}
