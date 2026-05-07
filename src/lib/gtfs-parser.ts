/**
 * GTFS ZIP parser — extracts and parses routes, trips, stop_times, stops
 */
import JSZip from 'jszip';
import type { GtfsRoute, GtfsTrip, GtfsStopTime, GtfsStop, GtfsPathway, GtfsTransfer, ParsedGtfs } from './gtfs-types';

/** Parse a CSV string into an array of objects */
function parseCsv<T>(csv: string): T[] {
  const lines = csv.replace(/\r\n/g, '\n').split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const rows: T[] = [];
  
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    if (values.length !== headers.length) continue;
    
    const obj: Record<string, string | number> = {};
    headers.forEach((h, idx) => {
      obj[h] = values[idx].replace(/^"|"$/g, '').trim();
    });
    rows.push(obj as T);
  }
  
  return rows;
}

/** Parse a CSV line handling quoted fields */
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

/** Find a file in the ZIP (may be in a subfolder) */
function findFile(zip: JSZip, name: string): JSZip.JSZipObject | null {
  let found: JSZip.JSZipObject | null = null;
  zip.forEach((relativePath, file) => {
    if (!file.dir && relativePath.endsWith(name)) {
      found = file;
    }
  });
  return found;
}

/** Parse a GTFS ZIP file and return structured data */
export async function parseGtfsZip(file: File): Promise<ParsedGtfs> {
  const arrayBuffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);

  const routesFile = findFile(zip, 'routes.txt');
  const tripsFile = findFile(zip, 'trips.txt');
  const stopTimesFile = findFile(zip, 'stop_times.txt');
  const stopsFile = findFile(zip, 'stops.txt');
  // Optional files — absence is not an error
  const pathwaysFile = findFile(zip, 'pathways.txt');
  const transfersFile = findFile(zip, 'transfers.txt');

  if (!routesFile || !tripsFile || !stopTimesFile || !stopsFile) {
    const missing = [
      !routesFile && 'routes.txt',
      !tripsFile && 'trips.txt',
      !stopTimesFile && 'stop_times.txt',
      !stopsFile && 'stops.txt',
    ].filter(Boolean);
    throw new Error(`Fichiers GTFS manquants : ${missing.join(', ')}`);
  }

  const [routesCsv, tripsCsv, stopTimesCsv, stopsCsv, pathwaysCsv, transfersCsv] = await Promise.all([
    routesFile.async('string'),
    tripsFile.async('string'),
    stopTimesFile.async('string'),
    stopsFile.async('string'),
    pathwaysFile ? pathwaysFile.async('string') : Promise.resolve(''),
    transfersFile ? transfersFile.async('string') : Promise.resolve(''),
  ]);

  const routes = parseCsv<GtfsRoute>(routesCsv).map(r => ({
    ...r,
    route_type: Number(r.route_type) || 3,
  }));

  const trips = parseCsv<GtfsTrip>(tripsCsv);

  const stopTimes = parseCsv<GtfsStopTime>(stopTimesCsv).map(st => ({
    ...st,
    stop_sequence: Number(st.stop_sequence) || 0,
  }));

  const stops = parseCsv<GtfsStop>(stopsCsv).map(s => ({
    ...s,
    stop_lat: Number(s.stop_lat) || 0,
    stop_lon: Number(s.stop_lon) || 0,
    location_type: s.location_type !== undefined ? Number(s.location_type) : 0,
  }));

  const pathways: GtfsPathway[] = pathwaysCsv
    ? parseCsv<GtfsPathway>(pathwaysCsv).map(p => ({
        ...p,
        pathway_mode: Number(p.pathway_mode) || 1,
        is_bidirectional: Number(p.is_bidirectional) || 0,
        length: p.length !== undefined && p.length !== ('' as unknown) ? Number(p.length) : undefined,
        traversal_time: p.traversal_time !== undefined && p.traversal_time !== ('' as unknown) ? Number(p.traversal_time) : undefined,
        stair_count: p.stair_count !== undefined && p.stair_count !== ('' as unknown) ? Number(p.stair_count) : undefined,
        max_slope: p.max_slope !== undefined && p.max_slope !== ('' as unknown) ? Number(p.max_slope) : undefined,
        min_width: p.min_width !== undefined && p.min_width !== ('' as unknown) ? Number(p.min_width) : undefined,
      }))
    : [];

  const transfers: GtfsTransfer[] = transfersCsv
    ? parseCsv<GtfsTransfer>(transfersCsv).map(t => ({
        ...t,
        transfer_type: Number(t.transfer_type) || 0,
        min_transfer_time: t.min_transfer_time !== undefined && t.min_transfer_time !== ('' as unknown) ? Number(t.min_transfer_time) : undefined,
      }))
    : [];

  return { routes, trips, stopTimes, stops, pathways, transfers };
}
