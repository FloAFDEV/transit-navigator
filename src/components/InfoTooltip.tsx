import React from 'react';
import { Info } from 'lucide-react';
import { glossaryEntries } from '@/lib/glossary';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

interface Props {
  term: string;
}

const InfoTooltip: React.FC<Props> = ({ term }) => {
  const entry = glossaryEntries.find(e => e.term.toLowerCase() === term.toLowerCase());
  if (!entry) return null;

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex items-center ml-1 cursor-help">
            <Info className="w-3 h-3 text-muted-foreground" />
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-64 text-[10px] leading-relaxed z-[100]">
          <span className="font-semibold block mb-1">{entry.term}</span>
          {entry.simple}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};

export default InfoTooltip;
