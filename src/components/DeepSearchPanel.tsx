import { DeepSearchState } from "@/hooks/useDeepSearch";
import { Search, Loader2 } from "lucide-react";

interface DeepSearchPanelProps {
  deepSearch: DeepSearchState;
}

export function DeepSearchPanel({ deepSearch }: DeepSearchPanelProps) {
  if (deepSearch.phase === "idle" || deepSearch.phase === "done") return null;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-2">
      <div className="flex items-center gap-2 rounded-lg border border-border bg-secondary/30 px-3 py-2 text-sm text-muted-foreground">
        {deepSearch.phase === "searching" || deepSearch.phase === "clarifying" ? (
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
        ) : (
          <Search className="h-4 w-4 text-primary" />
        )}
        <span>{deepSearch.statusMessage || "Глубокий поиск..."}</span>
      </div>
    </div>
  );
}
