import React, { useState } from 'react';
import { Info, X } from 'lucide-react';
import { glossaryEntries } from '@/lib/glossary';

const GlossaryPanel: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-secondary text-secondary-foreground hover:bg-accent transition-colors"
        title="Glossaire des termes"
      >
        <Info className="w-3.5 h-3.5" />
        Glossaire
      </button>

      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-end">
          <div className="absolute inset-0 bg-foreground/10" onClick={() => setIsOpen(false)} />
          <div className="relative w-full max-w-md h-full bg-background border-l border-border shadow-lg overflow-y-auto">
            <div className="sticky top-0 bg-background border-b border-border px-5 py-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-foreground uppercase tracking-wider">Glossaire</h2>
              <button
                onClick={() => setIsOpen(false)}
                className="p-1 rounded-md hover:bg-secondary text-muted-foreground"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5 space-y-6">
              {glossaryEntries.map(entry => (
                <div key={entry.term}>
                  <h3 className="text-sm font-semibold text-foreground mb-1.5">{entry.term}</h3>
                  <p className="text-xs text-muted-foreground leading-relaxed mb-1">{entry.simple}</p>
                  <p className="text-xs text-foreground/70 leading-relaxed italic">
                    → {entry.decision}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default GlossaryPanel;
