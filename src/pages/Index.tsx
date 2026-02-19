import React, { useState, useCallback } from 'react';
import GtfsUpload from '@/components/GtfsUpload';
import CircularDensityDiagram from '@/components/CircularDensityDiagram';
import TransitDiagram from '@/components/TransitDiagram';
import FrictionAnalysis from '@/components/FrictionAnalysis';
import { parseGtfsZip } from '@/lib/gtfs-parser';
import { analyzeNetwork, type AnalysisResult } from '@/lib/network-analysis';
import type { TransportMode } from '@/lib/gtfs-types';
import { modeLabels, modeColors } from '@/lib/gtfs-types';
import { toast } from 'sonner';

type ViewTab = 'density' | 'transit' | 'friction';

const Index: React.FC = () => {
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<ViewTab>('density');
  const [filterMode, setFilterMode] = useState<TransportMode | 'all'>('all');
  const [fileName, setFileName] = useState('');

  const handleFile = useCallback(async (file: File) => {
    setIsLoading(true);
    try {
      const gtfs = await parseGtfsZip(file);
      const result = analyzeNetwork(gtfs);
      setAnalysis(result);
      setFileName(file.name);
      toast.success(`${result.routes.length} lignes analysées`);
    } catch (err: any) {
      toast.error(err.message || 'Erreur lors du parsing GTFS');
    } finally {
      setIsLoading(false);
    }
  }, []);

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
    { key: 'friction', label: 'Analyse friction' },
  ];

  const modes: (TransportMode | 'all')[] = ['all', 'bus', 'metro', 'tram', 'train'];

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h1 className="text-sm font-semibold text-foreground tracking-tight">GTFS Analyzer</h1>
          <span className="text-xs text-muted-foreground font-mono">{fileName}</span>
        </div>
        <button
          onClick={() => { setAnalysis(null); setFileName(''); }}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          Nouveau fichier
        </button>
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

      {/* Content */}
      <main className="p-6">
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

        {activeTab === 'density' && (
          <CircularDensityDiagram analysis={analysis} filterMode={filterMode} />
        )}
        {activeTab === 'transit' && (
          <TransitDiagram analysis={analysis} />
        )}
        {activeTab === 'friction' && (
          <FrictionAnalysis analysis={analysis} />
        )}
      </main>
    </div>
  );
};

export default Index;
