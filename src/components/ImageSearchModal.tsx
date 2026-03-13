import { useState } from "react";
import { Search, X, ExternalLink } from "lucide-react";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

interface ImageResult {
  url: string;
  title: string;
  sourceUrl: string;
}

interface ImageSearchModalProps {
  onSelect: (images: string[]) => void;
  onClose: () => void;
}

export function ImageSearchModal({ onSelect, onClose }: ImageSearchModalProps) {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<ImageResult[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [error, setError] = useState("");

  const search = async () => {
    if (!query.trim()) return;
    setLoading(true);
    setError("");
    setResults([]);
    setSelected(new Set());
    try {
      const resp = await fetch(`${SUPABASE_URL}/functions/v1/image-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
        body: JSON.stringify({ query: query.trim() }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "Ошибка поиска");

      // Build image list from raw search data
      const imgs: ImageResult[] = [];
      if (data.results?.length > 0) {
        imgs.push(...data.results);
      } else if (data.rawData?.length > 0) {
        // Fallback: extract og images or any images from results
        for (const r of data.rawData) {
          if (r.metadata?.ogImage) {
            imgs.push({ url: r.metadata.ogImage, title: r.title || query, sourceUrl: r.url || "" });
          }
          if (r.metadata?.image) {
            imgs.push({ url: r.metadata.image, title: r.title || query, sourceUrl: r.url || "" });
          }
        }
      }

      if (imgs.length === 0) {
        setError("Изображения не найдены. Попробуйте другой запрос.");
      } else {
        setResults(imgs);
      }
    } catch (e: any) {
      setError(e.message || "Ошибка");
    } finally {
      setLoading(false);
    }
  };

  const toggleSelect = (i: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else if (next.size < 5) next.add(i);
      return next;
    });
  };

  const handleInsert = () => {
    const urls = Array.from(selected).map((i) => results[i].url);
    if (urls.length > 0) onSelect(urls);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-background/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-lg rounded-t-3xl sm:rounded-2xl bg-card border border-border shadow-2xl mx-0 sm:mx-4 flex flex-col animate-fade-in-up" style={{ maxHeight: "85vh" }}>
        {/* Header */}
        <div className="flex items-center gap-2 p-4 border-b border-border flex-shrink-0">
          <Search className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && search()}
            placeholder="Найти изображения..."
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
            autoFocus
          />
          <button onClick={onClose} className="rounded-full p-1 text-muted-foreground hover:bg-secondary">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Search button */}
        <div className="px-4 py-3 border-b border-border flex-shrink-0">
          <button
            onClick={search}
            disabled={loading || !query.trim()}
            className="w-full rounded-xl bg-primary py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-50 transition-opacity hover:opacity-90 active:scale-[0.98]"
          >
            {loading ? "Поиск..." : "Найти изображения"}
          </button>
        </div>

        {/* Results */}
        <div className="flex-1 overflow-y-auto p-4 scrollbar-thin">
          {error && <p className="text-center text-sm text-muted-foreground py-8">{error}</p>}
          {!error && results.length === 0 && !loading && (
            <p className="text-center text-sm text-muted-foreground py-8">Введите запрос и нажмите «Найти»</p>
          )}
          {results.length > 0 && (
            <div className="grid grid-cols-3 gap-1.5">
              {results.map((img, i) => (
                <div key={i} className="relative aspect-square rounded-xl overflow-hidden cursor-pointer" onClick={() => toggleSelect(i)}>
                  <img
                    src={img.url}
                    alt={img.title}
                    className={`w-full h-full object-cover transition-all ${selected.has(i) ? "opacity-75 scale-95" : "hover:opacity-90"}`}
                    onError={(e) => { (e.target as HTMLImageElement).closest("div")!.style.display = "none"; }}
                  />
                  {selected.has(i) && (
                    <div className="absolute inset-0 flex items-center justify-center bg-primary/30 rounded-xl">
                      <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold">
                        {Array.from(selected).indexOf(i) + 1}
                      </div>
                    </div>
                  )}
                  {img.sourceUrl && (
                    <a
                      href={img.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="absolute bottom-1 right-1 rounded-full bg-background/70 p-0.5"
                    >
                      <ExternalLink className="h-2.5 w-2.5 text-foreground" />
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        {selected.size > 0 && (
          <div className="border-t border-border p-4 flex-shrink-0">
            <button
              onClick={handleInsert}
              className="w-full rounded-xl bg-primary py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90 active:scale-[0.98] transition-all"
            >
              Вставить {selected.size} {selected.size === 1 ? "изображение" : "изображения"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
