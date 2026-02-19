import React, { useCallback, useState, useRef } from 'react';
import { Upload, FileArchive } from 'lucide-react';

interface GtfsUploadProps {
  onFileLoaded: (file: File) => void;
  isLoading: boolean;
}

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
    <div className="flex flex-col items-center justify-center min-h-[60vh]">
      <div className="max-w-lg w-full">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground mb-2">
            GTFS Network Analyzer
          </h1>
          <p className="text-sm text-muted-foreground">
            Déposez un fichier GTFS (.zip) pour explorer la structure du réseau
          </p>
        </div>

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
              <p className="text-sm text-muted-foreground">Analyse en cours…</p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3">
              <div className="w-12 h-12 rounded-full bg-secondary flex items-center justify-center">
                <FileArchive className="w-5 h-5 text-muted-foreground" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground mb-1">
                  Glisser-déposer un fichier GTFS
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

        <div className="mt-6 flex items-center gap-4 text-xs text-muted-foreground justify-center">
          <span>routes.txt</span>
          <span>·</span>
          <span>trips.txt</span>
          <span>·</span>
          <span>stop_times.txt</span>
          <span>·</span>
          <span>stops.txt</span>
        </div>
      </div>
    </div>
  );
};

export default GtfsUpload;
