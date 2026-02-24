import React, { useState, useCallback, useRef, useEffect } from 'react';
import GtfsUpload from '@/components/GtfsUpload';
import CircularDensityDiagram from '@/components/CircularDensityDiagram';
import TransitDiagram from '@/components/TransitDiagram';
import FrictionAnalysis from '@/components/FrictionAnalysis';
import TopologicalView from '@/components/TopologicalView';
import NetworkNarrative from '@/components/NetworkNarrative';
import SignageGuide from '@/components/SignageGuide';
import RouteDetailPanel from '@/components/RouteDetailPanel';
import GlossaryPanel from '@/components/GlossaryPanel';
import PdfExportButton from '@/components/PdfExportButton';
import { parseGtfsZip } from '@/lib/gtfs-parser';
import { analyzeNetwork, type AnalysisResult } from '@/lib/network-analysis';
import type { TransportMode } from '@/lib/gtfs-types';
import { modeLabels } from '@/lib/gtfs-types';
import { exportPngFromSvg } from '@/lib/csv-export';
import { toast } from 'sonner';
import { Share2, Image } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { modeColors } from '@/lib/gtfs-types';

type ViewTab = 'density' | 'transit' | 'topology' | 'friction';

const Index: React.FC = () => {
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<ViewTab>('density');
  const [filterMode, setFilterMode] = useState<TransportMode | 'all'>('all');
  const [fileName, setFileName] = useState('');
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const densityRef = useRef<HTMLDivElement>(null);
  const transitRef = useRef<HTMLDivElement>(null);
  const frictionRef = useRef<HTMLDivElement>(null);
  const topologyRef = useRef<HTMLDivElement>(null);

  // Restore state from URL on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tab = params.get('tab') as ViewTab | null;
    const mode = params.get('mode') as TransportMode | 'all' | null;
    const route = params.get('route');
    if (tab && ['density', 'transit', 'topology', 'friction'].includes(tab)) setActiveTab(tab);
    if (mode) setFilterMode(mode);
    if (route) setSelectedRouteId(route);
  }, []);

  // Sync state to URL
  useEffect(() => {
    if (!analysis) return;
    const params = new URLSearchParams();
    params.set('tab', activeTab);
    if (filterMode !== 'all') params.set('mode', filterMode);
    if (selectedRouteId) params.set('route', selectedRouteId);
    const newUrl = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState({}, '', newUrl);
  }, [activeTab, filterMode, selectedRouteId, analysis]);

  const handleFile = useCallback(async (file: File) => {
    setIsLoading(true);
    try {
      const gtfs = await parseGtfsZip(file);
      const result = analyzeNetwork(gtfs);
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

  const handleSelectRoute = useCallback((routeId: string | null) => {
    setSelectedRouteId(routeId);
  }, []);

  const handleShare = useCallback(() => {
    navigator.clipboard.writeText(window.location.href);
    toast.success('Lien copié dans le presse-papier');
  }, []);

  const handleExportPng = useCallback(() => {
    const refMap: Record<ViewTab, React.RefObject<HTMLDivElement>> = {
      density: densityRef,
      transit: transitRef,
      topology: topologyRef,
      friction: frictionRef,
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

  const tabs: { key: ViewTab; label: string }[] = [
    { key: 'density', label: 'Densité circulaire' },
    { key: 'transit', label: 'Correspondances' },
    { key: 'topology', label: 'Topologie' },
    { key: 'friction', label: 'Analyse friction' },
  ];

  const modes: (TransportMode | 'all')[] = ['all', 'bus', 'metro', 'tram', 'train', 'cable'];

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h1 className="text-sm font-semibold text-foreground tracking-tight">GTFS Analyzer</h1>
          <span className="text-xs text-muted-foreground font-mono">{fileName}</span>
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
                    <span
                      className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0"
                      style={{ backgroundColor: modeColors[r.mode] }}
                    />
                    {r.name} ({modeLabels[r.mode]})
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
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
          />
          <button
            onClick={handleShare}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-secondary text-secondary-foreground hover:bg-accent transition-colors"
            title="Copier le lien partageable"
          >
            <Share2 className="w-3.5 h-3.5" />
            Partager
          </button>
          <button
            onClick={() => { setAnalysis(null); setFileName(''); setSelectedRouteId(null); window.history.replaceState({}, '', window.location.pathname); }}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Nouveau fichier
          </button>
        </div>
      </header>

      {/* Tabs */}
      <nav className="border-b border-border px-6 flex gap-6">
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`py-3 text-sm font-medium transition-colors ${
              activeTab === tab.key ? 'tab-active' : 'tab-inactive'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {/* Content + Detail Panel */}
      <div className="flex">
        <main className="flex-1 p-6 min-w-0">
          {/* Mode filter for density view */}
          {activeTab === 'density' && (
            <div className="flex items-center gap-2 mb-6 justify-center">
              {modes.map(mode => {
                const isActive = filterMode === mode;
                return (
                  <button
                    key={mode}
                    onClick={() => setFilterMode(mode)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                      isActive
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-secondary text-secondary-foreground hover:bg-accent'
                    }`}
                  >
                    {mode === 'all' ? 'Tout' : modeLabels[mode]}
                  </button>
                );
              })}
            </div>
          )}

          <div ref={densityRef} style={{ display: activeTab === 'density' ? 'block' : 'none' }}>
            <CircularDensityDiagram
              analysis={analysis}
              filterMode={filterMode}
              selectedRouteId={selectedRouteId}
              onSelectRoute={handleSelectRoute}
            />
          </div>
          <div ref={transitRef} style={{ display: activeTab === 'transit' ? 'block' : 'none' }}>
            <TransitDiagram
              analysis={analysis}
              selectedRouteId={selectedRouteId}
              onSelectRoute={handleSelectRoute}
            />
          </div>
          <div ref={topologyRef} style={{ display: activeTab === 'topology' ? 'block' : 'none' }}>
            <TopologicalView
              analysis={analysis}
              selectedRouteId={selectedRouteId}
              onSelectRoute={handleSelectRoute}
            />
          </div>
          <div ref={frictionRef} style={{ display: activeTab === 'friction' ? 'block' : 'none' }}>
            <FrictionAnalysis
              analysis={analysis}
              selectedRouteId={selectedRouteId}
              onSelectRoute={handleSelectRoute}
            />
          </div>

          {/* Signage guide */}
          <div className="mt-8">
            <SignageGuide analysis={analysis} />
          </div>

          {/* Network narrative */}
          <div className="mt-8">
            <NetworkNarrative analysis={analysis} selectedRouteId={selectedRouteId} />
          </div>
        </main>

        {/* Route Detail Panel */}
        {selectedRouteId && (
          <RouteDetailPanel
            routeId={selectedRouteId}
            analysis={analysis}
            onClose={() => setSelectedRouteId(null)}
          />
        )}
      </div>
    </div>
  );
};

export default Index;
