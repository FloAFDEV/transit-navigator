import React from 'react';
import { Info } from 'lucide-react';
import { glossaryEntries } from '@/lib/glossary';

interface Props {
  term: string;
}

/** Inline info icon with tooltip for a glossary term */
const InfoTooltip: React.FC<Props> = ({ term }) => {
  const entry = glossaryEntries.find(e => e.term.toLowerCase() === term.toLowerCase());
  if (!entry) return null;

  return (
    <span className="group relative inline-flex items-center ml-1 cursor-help">
      <Info className="w-3 h-3 text-muted-foreground" />
      <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 p-3 bg-foreground text-background text-[10px] leading-relaxed rounded-md shadow-lg opacity-0 group-hover:opacity-100 transition-opacity z-50">
        <span className="font-semibold block mb-1">{entry.term}</span>
        {entry.simple}
      </span>
    </span>
  );
};

export default InfoTooltip;
