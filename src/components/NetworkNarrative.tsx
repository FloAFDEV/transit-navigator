import React, { useMemo } from 'react';
import type { AnalysisResult } from '@/lib/network-analysis';
import { generateNarrative } from '@/lib/narrative';
import { BookOpen, Download } from 'lucide-react';

interface Props {
  analysis: AnalysisResult;
  selectedRouteId: string | null;
}

const NetworkNarrative: React.FC<Props> = ({ analysis, selectedRouteId }) => {
  const narrative = useMemo(
    () => generateNarrative(analysis, selectedRouteId),
    [analysis, selectedRouteId]
  );

  const handleExportText = () => {
    const blob = new Blob([narrative.replace(/\*\*/g, '')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'analyse-reseau.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Simple markdown-to-JSX renderer for bold and line breaks
  const renderMarkdown = (text: string) => {
    return text.split('\n').map((line, i) => {
      if (line === '---') return <hr key={i} className="my-3 border-border" />;
      if (line.trim() === '') return <br key={i} />;

      const parts = line.split(/(\*\*[^*]+\*\*)/g);
      return (
        <span key={i}>
          {parts.map((part, j) => {
            if (part.startsWith('**') && part.endsWith('**')) {
              return <strong key={j} className="text-foreground">{part.slice(2, -2)}</strong>;
            }
            return <span key={j}>{part}</span>;
          })}
        </span>
      );
    });
  };

  return (
    <div className="bg-secondary/30 border border-border rounded-md p-5 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <BookOpen className="w-4 h-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">
            Synthèse automatique
          </h3>
        </div>
        <button
          onClick={handleExportText}
          className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors rounded-md hover:bg-secondary"
          title="Exporter en texte"
        >
          <Download className="w-3 h-3" />
          Exporter
        </button>
      </div>
      <div className="text-xs text-muted-foreground leading-relaxed space-y-0">
        {renderMarkdown(narrative)}
      </div>
    </div>
  );
};

export default NetworkNarrative;
