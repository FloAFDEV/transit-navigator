import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Search, MapPin } from 'lucide-react';
import type { SearchIndex, SearchResults, SearchStop, SearchRoute } from '@/lib/search';
import { filterSearch } from '@/lib/search';
import { modeLabels } from '@/lib/gtfs-types';

interface Props {
  index: SearchIndex | null;
  onSelectStop: (stop: SearchStop) => void;
  onSelectRoute: (route: SearchRoute) => void;
}

const GlobalSearch: React.FC<Props> = ({ index, onSelectStop, onSelectRoute }) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResults>({ stops: [], routes: [] });
  const [open, setOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setQuery(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (!index || val.trim().length < 2) {
        setResults({ stops: [], routes: [] });
        setOpen(false);
        return;
      }
      const r = filterSearch(index, val);
      setResults(r);
      setOpen(r.stops.length > 0 || r.routes.length > 0);
    }, 200);
  }, [index]);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleStop = useCallback((s: SearchStop) => {
    setOpen(false);
    setQuery('');
    onSelectStop(s);
  }, [onSelectStop]);

  const handleRoute = useCallback((r: SearchRoute) => {
    setOpen(false);
    setQuery('');
    onSelectRoute(r);
  }, [onSelectRoute]);

  const hasResults = results.stops.length > 0 || results.routes.length > 0;

  return (
    <div ref={containerRef} className="relative">
      <div className="relative flex items-center">
        <Search className="absolute left-2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
        <input
          type="text"
          value={query}
          onChange={handleChange}
          onFocus={() => hasResults && setOpen(true)}
          placeholder="Rechercher arrêt ou ligne…"
          className="h-8 w-56 pl-7 pr-2 text-xs rounded-md border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      {open && hasResults && (
        <div className="absolute top-full left-0 mt-1 w-80 max-h-96 overflow-y-auto rounded-lg border border-border bg-popover shadow-xl z-[9999]">

          {results.stops.length > 0 && (
            <>
              <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                Arrêts
              </div>
              {results.stops.map(s => (
                <button
                  key={s.stopId}
                  onClick={() => handleStop(s)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-xs text-left text-foreground hover:bg-accent transition-colors"
                >
                  <MapPin className="w-3 h-3 text-muted-foreground shrink-0" />
                  <span className="truncate">{s.stopName}</span>
                </button>
              ))}
            </>
          )}

          {results.routes.length > 0 && (
            <>
              <div className={`px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground${results.stops.length > 0 ? ' border-t border-border mt-1' : ''}`}>
                Lignes
              </div>
              {results.routes.map(r => (
                <button
                  key={r.routeId}
                  onClick={() => handleRoute(r)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-xs text-left text-foreground hover:bg-accent transition-colors"
                >
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: r.color }} />
                  <span className="truncate">{r.name}</span>
                  <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{modeLabels[r.mode]}</span>
                </button>
              ))}
            </>
          )}

        </div>
      )}
    </div>
  );
};

export default GlobalSearch;
