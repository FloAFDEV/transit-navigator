/** GTFS data types */

export interface GtfsRoute {
  route_id: string;
  route_short_name: string;
  route_long_name: string;
  route_type: number; // 0=tram, 1=metro, 2=train, 3=bus
  route_color?: string;
}

export interface GtfsTrip {
  trip_id: string;
  route_id: string;
  service_id: string;
  direction_id?: string;
}

export interface GtfsStopTime {
  trip_id: string;
  stop_id: string;
  stop_sequence: number;
  arrival_time?: string;
  departure_time?: string;
}

export interface GtfsStop {
  stop_id: string;
  stop_name: string;
  stop_lat: number;
  stop_lon: number;
}

export type TransportMode = 'bus' | 'metro' | 'tram' | 'train';

export interface ParsedGtfs {
  routes: GtfsRoute[];
  trips: GtfsTrip[];
  stopTimes: GtfsStopTime[];
  stops: GtfsStop[];
}

/** Map GTFS route_type to our transport mode */
export function routeTypeToMode(routeType: number): TransportMode {
  switch (routeType) {
    case 0: return 'tram';
    case 1: return 'metro';
    case 2: return 'train';
    case 3: return 'bus';
    default: return 'bus';
  }
}

/** Color for each transport mode (HSL CSS variable names) */
export const modeColors: Record<TransportMode, string> = {
  bus: 'hsl(174, 62%, 42%)',
  metro: 'hsl(0, 72%, 51%)',
  tram: 'hsl(38, 92%, 50%)',
  train: 'hsl(234, 62%, 50%)',
};

export const modeLabels: Record<TransportMode, string> = {
  bus: 'Bus',
  metro: 'Métro',
  tram: 'Tram',
  train: 'Train',
};
