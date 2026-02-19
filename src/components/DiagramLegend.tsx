import React from 'react';

interface LegendItem {
  color: string;
  label: string;
  description?: string;
}

interface Props {
  title: string;
  items: LegendItem[];
  notes?: string[];
}

const DiagramLegend: React.FC<Props> = ({ title, items, notes }) => {
  return (
    <div className="p-3 bg-secondary/30 border border-border rounded-md text-xs max-w-xs">
      <h4 className="font-semibold text-foreground mb-2 uppercase tracking-wider text-[10px]">{title}</h4>
      <div className="space-y-1.5">
        {items.map((item, i) => (
          <div key={i} className="flex items-center gap-2">
            <span
              className="w-4 h-1 rounded-full flex-shrink-0"
              style={{ backgroundColor: item.color }}
            />
            <span className="text-foreground">{item.label}</span>
            {item.description && (
              <span className="text-muted-foreground ml-auto">{item.description}</span>
            )}
          </div>
        ))}
      </div>
      {notes && notes.length > 0 && (
        <div className="mt-2 pt-2 border-t border-border space-y-1">
          {notes.map((note, i) => (
            <p key={i} className="text-muted-foreground text-[10px] leading-relaxed">{note}</p>
          ))}
        </div>
      )}
    </div>
  );
};

export default DiagramLegend;
