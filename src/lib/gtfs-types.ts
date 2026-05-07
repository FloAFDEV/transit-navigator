/** GTFS data types */

// pathway_mode values from GTFS spec
// 1=walkway 2=stairs 3=moving walkway 4=escalator 5=elevator 6=fare gate 7=exit gate
export interface GtfsPathway {
  pathway_id: string;
  from_stop_id: string;
  to_stop_id: string;
  pathway_mode: number;
  is_bidirectional: number; // 0 or 1
  length?: number;          // metres
  traversal_time?: number;  // seconds
  stair_count?: number;
  max_slope?: number;
  min_width?: number;       // metres
  signposted_as?: string;
  reversed_signposted_as?: string;
}

// transfer_type: 0=recommended 1=timed 2=min_time_required 3=impossible
export interface GtfsTransfer {
  from_stop_id: string;
  to_stop_id: string;
  transfer_type: number;
  min_transfer_time?: number; // seconds (only for transfer_type=2)
}

// location_type values in stops.txt
// 0=stop 1=station 2=entrance/exit 3=generic_node 4=boarding_area
export interface GtfsStop {
  stop_id: string;
  stop_name: string;
  stop_lat: number;
  stop_lon: number;
  location_type?: number;
  parent_station?: string;
}

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

export type TransportMode = 'bus' | 'metro' | 'tram' | 'train' | 'cable';

export interface ParsedGtfs {
  routes: GtfsRoute[];
  trips: GtfsTrip[];
  stopTimes: GtfsStopTime[];
  stops: GtfsStop[];
  pathways: GtfsPathway[];
  transfers: GtfsTransfer[];
}

// --- Intra-station graph types ---

export type StationNodeType = 'stop' | 'station' | 'entrance' | 'generic_node' | 'boarding_area';

export interface StationNode {
  nodeId: string;
  stopId: string;
  stopName: string;
  nodeType: StationNodeType;
  lat: number;
  lon: number;
  // Grouping: parent_station id (or stop_id when no parent).
  // Multiple stop_ids with the same group are merged into one node in fallback mode.
  group: string;
  childCount: number;       // number of merged stop_ids (>1 = deduplicated)
  frictionScore: number;    // 0–1 (0=fluid, 1=blocking)
  accessibilityScore: number; // 0–1 (1=fully accessible)
}

export interface StationEdge {
  from: string;             // nodeId
  to: string;               // nodeId
  pathwayMode: number;      // 1–7, or 0 for transfer fallback
  costSeconds: number;
  isBidirectional: boolean;
  hasSlopeIssue: boolean;   // max_slope > 8%
  hasWidthIssue: boolean;   // min_width < 0.9m
  isElevator: boolean;
  isEscalator: boolean;
}

export interface StationGraph {
  stationId: string;
  stationName: string;
  nodes: Map<string, StationNode>;
  edges: StationEdge[];
  adjacency: Map<string, StationEdge[]>;
}

export interface TransferCost {
  fromStopId: string;
  toStopId: string;
  walkSeconds: number;
  waitSeconds: number;
  totalCostSeconds: number;
  transferType: number;
  frictionPenalty: number;
}

export interface JESBreakdown {
  travelTimeWeight: number;
  transferPenaltyWeight: number;
  frictionPenaltyWeight: number;
  accessibilityPenaltyWeight: number;
}

export interface JES {
  pathStopIds: string[];
  totalTravelSeconds: number;
  transferCount: number;
  totalTransferCostSeconds: number;
  frictionPenaltySeconds: number;
  accessibilityPenaltySeconds: number;
  rawScore: number;
  normalizedScore: number;  // 0–100 (100=perfect)
  breakdown: JESBreakdown;
}

/** Map GTFS route_type to our transport mode */
export function routeTypeToMode(routeType: number): TransportMode {
  switch (routeType) {
    case 0: return 'tram';
    case 1: return 'metro';
    case 2: return 'train';
    case 3: return 'bus';
    case 5: // Cable tram
    case 6: // Gondola / Aerial lift (Téléo)
    case 7: return 'cable'; // Funicular
    default: return 'bus';
  }
}

/** Color for each transport mode (HSL CSS variable names) */
export const modeColors: Record<TransportMode, string> = {
  bus: 'hsl(174, 62%, 42%)',
  metro: 'hsl(0, 72%, 51%)',
  tram: 'hsl(38, 92%, 50%)',
  train: 'hsl(234, 62%, 50%)',
  cable: 'hsl(280, 60%, 50%)',
};

export const modeLabels: Record<TransportMode, string> = {
  bus: 'Bus',
  metro: 'Métro',
  tram: 'Tram',
  train: 'Train',
  cable: 'Téléo / Câble',
};
