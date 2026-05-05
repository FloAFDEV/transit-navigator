import React, { useState } from 'react';
import { FileText, Loader2 } from 'lucide-react';
import { exportPdfReport } from '@/lib/pdf-export';
import type { AnalysisResult } from '@/lib/network-analysis';
import { toast } from 'sonner';

interface Props {
  analysis: AnalysisResult;
  fileName: string;
  densityRef: React.RefObject<HTMLElement>;
  transitRef: React.RefObject<HTMLElement>;
  frictionRef: React.RefObject<HTMLElement>;
  isochroneRef?: React.RefObject<HTMLElement>;
}

const PdfExportButton: React.FC<Props> = ({ analysis, fileName, densityRef, transitRef, frictionRef, isochroneRef }) => {
  const [isExporting, setIsExporting] = useState(false);
  const [progress, setProgress] = useState('');

  const handleExport = async () => {
    setIsExporting(true);
    try {
      await exportPdfReport({
        analysis,
        fileName,
        densityRef: densityRef.current,
        transitRef: transitRef.current,
        frictionRef: frictionRef.current,
        isochroneRef: isochroneRef?.current,
        onProgress: setProgress,
      });
      toast.success('Rapport PDF exporté');
    } catch (err: any) {
      toast.error(err.message || 'Erreur export PDF');
    } finally {
      setIsExporting(false);
      setProgress('');
    }
  };

  return (
    <button
      onClick={handleExport}
      disabled={isExporting}
      className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
      title="Exporter le rapport PDF complet"
    >
      {isExporting ? (
        <>
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          <span>{progress || 'Export...'}</span>
        </>
      ) : (
        <>
          <FileText className="w-3.5 h-3.5" />
          <span>Rapport PDF</span>
        </>
      )}
    </button>
  );
};

export default PdfExportButton;
