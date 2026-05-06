import React, { useCallback, useState, useRef } from 'react';
import { Upload, FileArchive, Map, Network, Zap, AlertTriangle } from 'lucide-react';

interface GtfsUploadProps {
  onFileLoaded: (file: File) => void;
  isLoading: boolean;
}

const FEATURES = [
  {
    icon: Map,
    color: '#22c55e',
    title: 'Zones accessibles en X minutes',
    desc: 'Visualisez depuis n\'importe quel arrêt combien de stations vous pouvez atteindre en 10, 20 ou 30 minutes.',
  },
  {
    icon: Network,
    color: '#3b82f6',
    title: 'Points critiques du réseau',
    desc: 'Identifiez les stations dont la fermeture bloquerait des milliers de voyageurs — et trouvez des alternatives.',
  },
  {
    icon: Zap,
    color: '#f59e0b',
    title: 'Hubs et nœuds stratégiques',
    desc: 'Repérez les arrêts qui concentrent le plus de lignes et de correspondances, cibles prioritaires d\'investissement.',
  },
  {
    icon: AlertTriangle,
    color: '#ef4444',
    title: 'Zones sous-desservies',
    desc: 'Détectez les secteurs avec peu de liaisons ou de correspondances — opportunités pour de nouvelles lignes.',
  },
];

const GtfsUpload: React.FC<GtfsUploadProps> = ({ onFileLoaded, isLoading }) => {
  const [isDragOver, setIsDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback((file: File) => {
    if (file.name.endsWith('.zip')) {
      onFileLoaded(file);
    }
  }, [onFileLoaded]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const onDragLeave = useCallback(() => setIsDragOver(false), []);

  const onChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  }, [handleFile]);

  return (
    <div className="flex flex-col items-center justify-center min-h-[80vh] gap-12">

      {/* Header */}
      <div className="text-center max-w-xl">
        <h1 className="text-3xl font-bold tracking-tight text-foreground mb-3">
          Analysez votre réseau de transport
        </h1>
        <p className="text-base text-muted-foreground leading-relaxed">
          Chargez les données de votre réseau (format GTFS) et obtenez en quelques secondes
          une analyse visuelle complète : accessibilité, fragilités, opportunités.
        </p>
      </div>

      {/* What you'll discover */}
      <div className="grid grid-cols-2 gap-4 max-w-2xl w-full">
        {FEATURES.map(({ icon: Icon, color, title, desc }) => (
          <div key={title} className="flex gap-3 p-4 rounded-xl border border-border bg-card">
            <div className="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center" style={{ background: `${color}18` }}>
              <Icon className="w-4 h-4" style={{ color }} />
            </div>
            <div>
              <div className="text-sm font-semibold text-foreground mb-1">{title}</div>
              <div className="text-xs text-muted-foreground leading-relaxed">{desc}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Upload zone */}
      <div className="max-w-lg w-full">
        <div
          className={`upload-zone ${isDragOver ? 'drag-over' : ''}`}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onClick={() => inputRef.current?.click()}
        >
          {isLoading ? (
            <div className="flex flex-col items-center gap-3">
              <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              <p className="text-sm text-muted-foreground">Analyse du réseau en cours…</p>
              <p className="text-xs text-muted-foreground/60">Cela peut prendre quelques secondes</p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3">
              <div className="w-14 h-14 rounded-full bg-secondary flex items-center justify-center">
                <FileArchive className="w-6 h-6 text-muted-foreground" />
              </div>
              <div className="text-center">
                <p className="text-sm font-semibold text-foreground mb-1">
                  Glisser-déposer votre fichier GTFS ici
                </p>
                <p className="text-xs text-muted-foreground">
                  ou cliquer pour sélectionner · format .zip
                </p>
              </div>
            </div>
          )}
          <input
            ref={inputRef}
            type="file"
            accept=".zip"
            className="hidden"
            onChange={onChange}
          />
        </div>

        <div className="mt-4 p-3 rounded-lg bg-secondary/50 border border-border text-xs text-muted-foreground text-center leading-relaxed">
          <span className="font-medium text-foreground">Qu'est-ce que le format GTFS ?</span>
          {' '}C'est le format standard utilisé par les agences de transport pour décrire leurs lignes, arrêts et horaires.
          Votre opérateur de transport le publie généralement en open data.
        </div>
      </div>

    </div>
  );
};

export default GtfsUpload;
