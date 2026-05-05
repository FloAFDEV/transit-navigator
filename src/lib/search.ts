import type { ParsedGtfs, TransportMode } from './gtfs-types';
import type { AnalysisResult } from './network-analysis';

export interface SearchStop {
  stopId: string;
  stopName: string;
  stopLat: number;
  stopLon: number;
}

export interface SearchRoute {
  routeId: string;
  name: string;
  mode: TransportMode;
  color: string;
}

export interface SearchResults {
  stops: SearchStop[];
  routes: SearchRoute[];
}

// Internal index entries carry a pre-normalized key for fast substring matching.
interface IndexedStop extends SearchStop { _n: string }
interface IndexedRoute extends SearchRoute { _n: string }

export interface SearchIndex {
  stops: IndexedStop[];
  routes: IndexedRoute[];
}

/** Accent-insensitive, lowercase normalisation. */
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

const FR_COLLATOR = new Intl.Collator('fr', { sensitivity: 'base', ignorePunctuation: true });

/**
 * Build a sorted, normalised search index from parsed GTFS + analysis.
 * Call once after loading a GTFS file; reuse for all queries.
 */
export function buildSearchIndex(gtfs: ParsedGtfs, analysis: AnalysisResult): SearchIndex {
  const stops: IndexedStop[] = gtfs.stops
    .filter(s => s.stop_lat !== 0 || s.stop_lon !== 0)
    .map(s => ({
      stopId: s.stop_id,
      stopName: s.stop_name,
      stopLat: s.stop_lat,
      stopLon: s.stop_lon,
      _n: normalize(s.stop_name),
    }))
    .sort((a, b) => FR_COLLATOR.compare(a.stopName, b.stopName));

  const routes: IndexedRoute[] = analysis.routes
    .map(r => ({
      routeId: r.routeId,
      name: r.name,
      mode: r.mode,
      color: r.color || '#6b7280',
      _n: normalize(r.name),
    }))
    .sort((a, b) => FR_COLLATOR.compare(a.name, b.name));

  return { stops, routes };
}

/**
 * Filter the index for a raw user query string.
 * Returns stops then routes, each alphabetically pre-sorted, capped at maxStops / maxRoutes.
 */
export function filterSearch(
  index: SearchIndex,
  query: string,
  maxStops = 8,
  maxRoutes = 5,
): SearchResults {
  const q = normalize(query.trim());
  if (q.length < 2) return { stops: [], routes: [] };

  const stops: SearchStop[] = [];
  for (const s of index.stops) {
    if (s._n.includes(q)) {
      stops.push({ stopId: s.stopId, stopName: s.stopName, stopLat: s.stopLat, stopLon: s.stopLon });
      if (stops.length >= maxStops) break;
    }
  }

  const routes: SearchRoute[] = [];
  for (const r of index.routes) {
    if (r._n.includes(q)) {
      routes.push({ routeId: r.routeId, name: r.name, mode: r.mode, color: r.color });
      if (routes.length >= maxRoutes) break;
    }
  }

  return { stops, routes };
}
