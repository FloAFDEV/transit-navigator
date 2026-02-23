import React, { useState } from 'react';
import { HelpCircle, X, Lightbulb } from 'lucide-react';

interface Props {
  title: string;
  what: string;
  deduce: string;
  caution: string;
  examples?: string[];
}

const HowToRead: React.FC<Props> = ({ title, what, deduce, caution, examples }) => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="mb-4 w-full max-w-3xl">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <HelpCircle className="w-3.5 h-3.5" />
        Comment lire ce graphique
      </button>

      {isOpen && (
        <div className="mt-3 p-4 bg-secondary/50 border border-border rounded-md text-xs leading-relaxed space-y-3 max-w-3xl">
          <div className="flex items-start justify-between">
            <h4 className="font-semibold text-foreground text-sm">{title}</h4>
            <button onClick={() => setIsOpen(false)} className="p-0.5 text-muted-foreground hover:text-foreground">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div>
            <p className="font-medium text-foreground mb-0.5">Ce que montre ce visuel</p>
            <p className="text-muted-foreground">{what}</p>
          </div>
          <div>
            <p className="font-medium text-foreground mb-0.5">Ce que l'on peut en déduire</p>
            <p className="text-muted-foreground">{deduce}</p>
          </div>
          {examples && examples.length > 0 && (
            <div>
              <p className="font-medium text-foreground mb-1 flex items-center gap-1">
                <Lightbulb className="w-3 h-3 text-yellow-500" />
                Exemples concrets
              </p>
              <ul className="text-muted-foreground space-y-1.5 ml-4">
                {examples.map((ex, i) => (
                  <li key={i} className="list-disc">{ex}</li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <p className="font-medium text-foreground mb-0.5">⚠ Limites d'interprétation</p>
            <p className="text-muted-foreground">{caution}</p>
          </div>
        </div>
      )}
    </div>
  );
};

export default HowToRead;
