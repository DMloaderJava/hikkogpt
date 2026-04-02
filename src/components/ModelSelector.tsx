import { ChevronDown, Check, Zap, Brain, Sparkles, User, Rocket } from "lucide-react";
import { useState, useRef, useEffect } from "react";

interface ModelSelectorProps {
  selectedModel: string;
  onSelect: (model: string) => void;
}

const models = [
  { id: "HikkoGPT", label: "HikkoGPT", description: "Самый умный", icon: Sparkles },
  { id: "Илья", label: "Илья", description: "Тёплый и спокойный", icon: Brain },
  { id: "HikkoGPT Turbo", label: "HikkoGPT Turbo", description: "Быстрый", icon: Zap },
];

const characters = [
  { id: "Илон Маск", label: "Илон Маск", description: "Техно-визионер", icon: Rocket },
  { id: "Прохожий0", label: "Прохожий0", description: "Загадочный персонаж", icon: User },
];

export function ModelSelector({ selectedModel, onSelect }: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("touchstart", handler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("touchstart", handler);
    };
  }, []);

  const allItems = [...models, ...characters];
  const current = allItems.find((m) => m.id === selectedModel);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 sm:gap-1.5 rounded-xl px-2.5 sm:px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-secondary active:scale-95"
      >
        <span className="max-w-[120px] sm:max-w-none truncate">{selectedModel}</span>
        <ChevronDown className={`h-3.5 w-3.5 flex-shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div
          className="fixed sm:absolute left-1/2 sm:left-0 -translate-x-1/2 sm:translate-x-0 top-auto sm:top-full z-[100] mt-2 w-[280px] sm:w-64 rounded-2xl border border-border bg-popover p-1.5 shadow-xl"
          style={{ top: ref.current ? ref.current.getBoundingClientRect().bottom + 8 : undefined }}
          onClick={(e) => e.stopPropagation()}
        >
          <p className="px-3 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Модели</p>
          {models.map((m) => (
            <button
              key={m.id}
              onClick={() => { onSelect(m.id); setOpen(false); }}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-accent active:scale-[0.98]"
            >
              <m.icon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-popover-foreground">{m.label}</p>
                <p className="text-xs text-muted-foreground truncate">{m.description}</p>
              </div>
              {selectedModel === m.id && <Check className="h-4 w-4 flex-shrink-0 text-primary" />}
            </button>
          ))}

          <div className="my-1 border-t border-border" />
          <p className="px-3 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Персонажи</p>
          {characters.map((c) => (
            <button
              key={c.id}
              onClick={() => { onSelect(c.id); setOpen(false); }}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-accent active:scale-[0.98]"
            >
              <c.icon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-popover-foreground">{c.label}</p>
                <p className="text-xs text-muted-foreground truncate">{c.description}</p>
              </div>
              {selectedModel === c.id && <Check className="h-4 w-4 flex-shrink-0 text-primary" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
