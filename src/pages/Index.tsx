import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import GtfsUpload from '@/components/GtfsUpload';
import CircularDensityDiagram from '@/components/CircularDensityDiagram';
import TransitDiagram from '@/components/TransitDiagram';
import FrictionAnalysis from '@/components/FrictionAnalysis';
import TopologicalView from '@/components/TopologicalView';
import NetworkDependencyView from '@/components/NetworkDependencyView';
import IsochroneDiagram from '@/components/IsochroneDiagram';
import NetworkNarrative from '@/components/NetworkNarrative';
import SignageGuide from '@/components/SignageGuide';
import StationGraphView from '@/components/StationGraphView';
import RouteDetailPanel from '@/components/RouteDetailPanel';
import GlossaryPanel from '@/components/GlossaryPanel';
import AnalysisGuidePanel from '@/components/AnalysisGuidePanel';
import PdfExportButton from '@/components/PdfExportButton';
import PresentationView from '@/components/PresentationView';
import GlobalSearch from '@/components/GlobalSearch';
import { parseGtfsZip } from '@/lib/gtfs-parser';
import { analyzeNetwork, type AnalysisResult } from '@/lib/network-analysis';
import type { TransportMode, ParsedGtfs, GtfsStop } from '@/lib/gtfs-types';
import type { IsochroneNode } from '@/lib/isochrone';
import { clearIsochroneCache } from '@/lib/isochrone';
import { buildSearchIndex, type SearchIndex, type SearchStop, type SearchRoute } from '@/lib/search';
import { modeLabels, modeColors } from '@/lib/gtfs-types';
import { exportPngFromSvg } from '@/lib/csv-export';
import { saveShare, loadShare, deserializeAnalysis } from '@/lib/share';
import { toast } from 'sonner';
import { Share2, Image, Monitor } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

type ViewTab = 'density' | 'transit' | 'topology' | 'friction' | 'isochrone' | 'dependencies' | 'station';

interface IsochroneSnapshot {
  nodes: IsochroneNode[];
  centerId: string | null;
  maxMin: number;
  centerStop: GtfsStop | null;
}

const Index: React.FC = () => {
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [gtfsData, setGtfsData] = useState<ParsedGtfs | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<ViewTab>('density');
  const [filterMode, setFilterMode] = useState<TransportMode | 'all'>('all');
  const [fileName, setFileName] = useState('');
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const [presentationMode, setPresentationMode] = useState(false);
  const [isochroneSnapshot, setIsochroneSnapshot] = useState<IsochroneSnapshot>({
    nodes: [],
    centerId: null,
    maxMin: 30,
    centerStop: null,
  });
  const [shareCopied, setShareCopied] = useState(false);
  const [selectedStopId, setSelectedStopId] = useState<string | null>(null);
  const [isochroneForceCenterId, setIsochroneForceCenterId] = useState<string | null>(null);

  const densityRef = useRef<HTMLDivElement>(null);
  const transitRef = useRef<HTMLDivElement>(null);
  const frictionRef = useRef<HTMLDivElement>(null);
  const topologyRef = useRef<HTMLDivElement>(null);
  const isochroneRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);

    const shareId = params.get('share');
    if (shareId) {
      const data = loadShare(shareId);
      if (data) {
        const restored = deserializeAnalysis(data);
        setAnalysis(restored);
        setFileName(data.fileName);
        setIsochroneSnapshot({
          nodes: data.isochroneNodes,
          centerId: data.centerId,
          maxMin: data.maxMin,
          centerStop: data.stops.find(s => s.stop_id === data.centerId) ?? null,
        });
        toast.success('Session restaurée depuis le lien partagé');
      } else {
        toast.error('Lien expiré ou données introuvables');
      }
    }

    if (params.get('mode') === 'present') setPresentationMode(true);

    const tab = params.get('tab') as ViewTab | null;
    const mode = params.get('mode') as TransportMode | 'all' | null;
    const route = params.get('route');
    if (tab && ['density', 'transit', 'topology', 'friction', 'isochrone', 'dependencies', 'station'].includes(tab)) setActiveTab(tab);
    if (mode && mode !== 'present') setFilterMode(mode as TransportMode | 'all');
    if (route) setSelectedRouteId(route);
  }, []);

  useEffect(() => {
    if (!analysis) return;
    const params = new URLSearchParams();
    params.set('tab', activeTab);
    if (filterMode !== 'all') params.set('mode', filterMode);
    if (selectedRouteId) params.set('route', selectedRouteId);
    window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);
  }, [activeTab, filterMode, selectedRouteId, analysis]);

  // Search index: built once per GTFS load, reused for all queries.
  const searchIndex = useMemo<SearchIndex | null>(() => {
    if (!gtfsData || !analysis) return null;
    return buildSearchIndex(gtfsData, analysis);
  }, [gtfsData, analysis]);

  const handleFile = useCallback(async (file: File) => {
    setIsLoading(true);
    clearIsochroneCache();
    setIsochroneForceCenterId(null);
    try {
      const gtfs = await parseGtfsZip(file);
      const result = analyzeNetwork(gtfs);
      setGtfsData(gtfs);
      setAnalysis(result);
      setFileName(file.name);
      setSelectedRouteId(null);
      toast.success(`${result.routes.length} lignes analysées`);
    } catch (err: any) {
      toast.error(err.message || 'Erreur lors du parsing GTFS');
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Search handlers: stop → switch to isochrone tab and set center.
  // Route → highlight in current view.
  const handleSearchStop = useCallback((stop: SearchStop) => {
    setIsochroneForceCenterId(stop.stopId);
    setActiveTab('isochrone');
  }, []);

  const handleSearchRoute = useCallback((route: SearchRoute) => {
    setSelectedRouteId(route.routeId);
  }, []);

  const handleSelectRoute = useCallback((routeId: string | null) => setSelectedRouteId(routeId), []);

  const handleIsochroneChange = useCallback(
    (nodes: IsochroneNode[], centerId: string | null, maxMin: number, centerStop: GtfsStop | null) => {
      setIsochroneSnapshot({ nodes, centerId, maxMin, centerStop });
    },
    [],
  );

  const handleShare = useCallback(() => {
    if (!analysis) return;
    const stops = gtfsData?.stops ?? isochroneSnapshot.nodes.map(n => ({
      stop_id: n.stopId,
      stop_name: n.stopName,
      stop_lat: n.lat,
      stop_lon: n.lon,
    }));
    try {
      const id = saveShare(
        analysis,
        stops,
        fileName,
        isochroneSnapshot.nodes,
        isochroneSnapshot.centerId,
        isochroneSnapshot.maxMin,
      );
      const url = `${window.location.origin}${window.location.pathname}?share=${id}`;
      navigator.clipboard.writeText(url);
      setShareCopied(true);
      toast.success('Lien copié dans le presse-papier');
      setTimeout(() => setShareCopied(false), 2500);
    } catch {
      toast.error('Données trop volumineuses pour le partage');
    }
  }, [analysis, gtfsData, fileName, isochroneSnapshot]);

  const handleExportPng = useCallback(() => {
    const refMap: Partial<Record<ViewTab, React.RefObject<HTMLDivElement>>> = {
      density: densityRef,
      transit: transitRef,
      topology: topologyRef,
      friction: frictionRef,
      isochrone: isochroneRef,
    };
    const container = refMap[activeTab]?.current;
    if (!container) return;
    const svg = container.querySelector('svg');
    if (svg) {
      exportPngFromSvg(svg as SVGSVGElement, `gtfs-${activeTab}`);
      toast.success('PNG exporté');
    }
  }, [activeTab]);

  if (!analysis) {
    return (
      <div className="min-h-screen bg-background p-6">
        <GtfsUpload onFileLoaded={handleFile} isLoading={isLoading} />
      </div>
    );
  }

  if (presentationMode) {
    return (
      <PresentationView
        analysis={analysis}
        stops={gtfsData?.stops ?? []}
        isochroneNodes={isochroneSnapshot.nodes}
        centerStop={isochroneSnapshot.centerStop}
        maxMin={isochroneSnapshot.maxMin}
        fileName={fileName}
        onExit={() => setPresentationMode(false)}
      />
    );
  }

  const tabs: { key: ViewTab; label: string; desc: string }[] = [
    { key: 'density',      label: 'Densité des lignes',     desc: 'Répartition des lignes par heure et par mode de transport' },
    { key: 'transit',      label: 'Correspondances',        desc: 'Stations où plusieurs lignes se croisent et s\'interconnectent' },
    { key: 'topology',     label: 'Topologie du réseau',    desc: 'Structure géographique et hiérarchie des connexions' },
    { key: 'friction',     label: 'Points de congestion',   desc: 'Stations complexes à forte charge — potentiels goulets d\'étranglement' },
    { key: 'isochrone',    label: 'Accessibilité en temps', desc: 'Depuis un arrêt, quelles zones peut-on atteindre en X minutes ?' },
    { key: 'dependencies', label: 'Analyse stratégique',    desc: 'Hubs critiques, stations fragiles et opportunités de développement' },
    { key: 'station',      label: 'Connectivité réseau',    desc: 'Graphe inter-stations, composantes connexes, chemins optimaux et JES — source : stop_times GTFS' },
  ];

  const modes: (TransportMode | 'all')[] = ['all', 'bus', 'metro', 'tram', 'train', 'cable'];

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h1 className="text-sm font-semibold text-foreground tracking-tight">GTFS Network Analyzer</h1>
          <span className="text-xs text-muted-foreground font-mono">{fileName}</span>
          <GlobalSearch
            index={searchIndex}
            onSelectStop={handleSearchStop}
            onSelectRoute={handleSearchRoute}
          />
          <Select
            value={selectedRouteId ?? '__none__'}
            onValueChange={(val) => handleSelectRoute(val === '__none__' ? null : val)}
          >
            <SelectTrigger className="w-[220px] h-8 text-xs">
              <SelectValue placeholder="Sélectionner une ligne…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">Toutes les lignes</SelectItem>
              {analysis.routes.map((r) => (
                <SelectItem key={r.routeId} value={r.routeId}>
                  <span className="flex items-center gap-2">
                    <span className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: modeColors[r.mode] }} />
                    {r.name} ({modeLabels[r.mode]})
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <AnalysisGuidePanel />
          <GlossaryPanel />
          <button
            onClick={handleExportPng}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-secondary text-secondary-foreground hover:bg-accent transition-colors"
            title="Exporter la vue en PNG"
          >
            <Image className="w-3.5 h-3.5" />
            PNG
          </button>
          <PdfExportButton
            analysis={analysis}
            fileName={fileName}
            densityRef={densityRef}
            transitRef={transitRef}
            frictionRef={frictionRef}
            isochroneRef={isochroneRef}
          />
          <button
            onClick={() => setPresentationMode(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-secondary text-secondary-foreground hover:bg-accent transition-colors"
            title="Mode présentation client"
          >
            <Monitor className="w-3.5 h-3.5" />
            Présentation
          </button>
          <button
            onClick={handleShare}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
              shareCopied
                ? 'bg-green-600 text-white'
                : 'bg-secondary text-secondary-foreground hover:bg-accent'
            }`}
            title="Copier le lien partageable"
          >
            <Share2 className="w-3.5 h-3.5" />
            {shareCopied ? 'Lien copié ✔' : 'Partager'}
          </button>
          <button
            onClick={() => {
              setAnalysis(null);
              setGtfsData(null);
              setFileName('');
              setSelectedRouteId(null);
              window.history.replaceState({}, '', window.location.pathname);
            }}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Nouveau fichier
          </button>
        </div>
      </header>

      <nav className="border-b border-border px-6 flex gap-6">
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            title={tab.desc}
            className={`py-3 text-sm font-medium transition-colors ${
              activeTab === tab.key ? 'tab-active' : 'tab-inactive'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {/* Context banner for active tab */}
      {tabs.find(t => t.key === activeTab) && (
        <div className="px-6 py-2 bg-secondary/30 border-b border-border text-xs text-muted-foreground flex items-center gap-2">
          <span className="text-primary font-medium">{tabs.find(t => t.key === activeTab)!.label}</span>
          <span>·</span>
          <span>{tabs.find(t => t.key === activeTab)!.desc}</span>
        </div>
      )}

      <div className="flex">
        <main className="flex-1 p-6 min-w-0">
          {activeTab === 'density' && (
            <div className="flex items-center gap-2 mb-6 justify-center">
              {modes.map(mode => {
                const isActive = filterMode === mode;
                return (
                  <button
                    key={mode}
                    onClick={() => setFilterMode(mode)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                      isActive ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground hover:bg-accent'
                    }`}
                  >
                    {mode === 'all' ? 'Tout' : modeLabels[mode]}
                  </button>
                );
              })}
            </div>
          )}

          <div ref={densityRef} style={{ display: activeTab === 'density' ? 'block' : 'none' }}>
            <CircularDensityDiagram analysis={analysis} filterMode={filterMode} selectedRouteId={selectedRouteId} onSelectRoute={handleSelectRoute} />
          </div>
          <div ref={transitRef} style={{ display: activeTab === 'transit' ? 'block' : 'none' }}>
            <TransitDiagram analysis={analysis} selectedRouteId={selectedRouteId} onSelectRoute={handleSelectRoute} />
          </div>
          <div ref={topologyRef} style={{ display: activeTab === 'topology' ? 'block' : 'none' }}>
            <TopologicalView
              analysis={analysis}
              selectedRouteId={selectedRouteId}
              onSelectRoute={handleSelectRoute}
              selectedStopId={selectedStopId}
              onSelectStop={setSelectedStopId}
            />
          </div>
          <div ref={frictionRef} style={{ display: activeTab === 'friction' ? 'block' : 'none' }}>
            <FrictionAnalysis analysis={analysis} selectedRouteId={selectedRouteId} onSelectRoute={handleSelectRoute} />
          </div>
          {activeTab === 'dependencies' && gtfsData && (
            <NetworkDependencyView
              analysis={analysis}
              gtfs={gtfsData}
              selectedStopId={selectedStopId}
              onSelectStop={setSelectedStopId}
            />
          )}
          {activeTab === 'station' && gtfsData && (
            <StationGraphView gtfs={gtfsData} />
          )}

          <div ref={isochroneRef} style={{ display: activeTab === 'isochrone' ? 'block' : 'none' }}>
            {gtfsData && (
              <IsochroneDiagram
                gtfs={gtfsData}
                onNodesChange={handleIsochroneChange}
                selectedStopId={selectedStopId}
                onSelectStop={setSelectedStopId}
                forceCenterId={isochroneForceCenterId}
              />
            )}
            {!gtfsData && isochroneSnapshot.nodes.length > 0 && (
              <div className="flex flex-col items-center gap-4 pt-4">
                <p className="text-xs text-muted-foreground">Isochrone restauré depuis le lien partagé</p>
                <IsochroneDiagram
                  gtfs={{ routes: [], trips: [], stopTimes: [], stops: isochroneSnapshot.nodes.map(n => ({ stop_id: n.stopId, stop_name: n.stopName, stop_lat: n.lat, stop_lon: n.lon })), pathways: [], transfers: [] }}
                  onNodesChange={handleIsochroneChange}
                />
              </div>
            )}
          </div>

          <div className="mt-8">
            <SignageGuide analysis={analysis} />
          </div>
          <div className="mt-8">
            <NetworkNarrative analysis={analysis} selectedRouteId={selectedRouteId} />
          </div>
        </main>

        {selectedRouteId && (
          <RouteDetailPanel routeId={selectedRouteId} analysis={analysis} onClose={() => setSelectedRouteId(null)} />
        )}
      </div>
    </div>
  );
};

export default Index;
