import { ChevronDown, Check, Zap, Brain, Sparkles, User, Rocket } from "lucide-react";
import { useState, useRef, useEffect } from "react";

interface ModelSelectorProps {
  selectedModel: string;
  onSelect: (model: string) => void;
}

const models = [
  { id: "HikkoGPT", label: "HikkoGPT", description: "Самый умный", icon: Sparkles },
  { id: "Илья", label: "Илья", description: "Тёплый и спокойный", icon: Brain },
  { id: "Арсений", label: "Арсений", description: "Быстрый", icon: Zap },
];

const characters = [
  { id: "Илон Маск", label: "Илон Маск", description: "Техно-визионер", icon: Rocket },
  { id: "Прохожий0", label: "Прохожий0", description: "Техно-визионер", icon: User },
];

export function ModelSelector({ selectedModel, onSelect }: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const allItems = [...models, ...characters];
  const current = allItems.find((m) => m.id === selectedModel);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-secondary"
      >
        {selectedModel}
        <ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-64 rounded-xl border border-border bg-popover p-1 shadow-lg">
          <p className="px-3 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Модели</p>
          {models.map((m) => (
            <button
              key={m.id}
              onClick={() => { onSelect(m.id); setOpen(false); }}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-accent"
            >
              <m.icon className="h-4 w-4 text-muted-foreground" />
              <div className="flex-1">
                <p className="text-sm font-medium text-popover-foreground">{m.label}</p>
                <p className="text-xs text-muted-foreground">{m.description}</p>
              </div>
              {selectedModel === m.id && <Check className="h-4 w-4 text-foreground" />}
            </button>
          ))}

          <div className="my-1 border-t border-border" />
          <p className="px-3 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Персонажи</p>
          {characters.map((c) => (
            <button
              key={c.id}
              onClick={() => { onSelect(c.id); setOpen(false); }}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-accent"
            >
              <c.icon className="h-4 w-4 text-muted-foreground" />
              <div className="flex-1">
                <p className="text-sm font-medium text-popover-foreground">{c.label}</p>
                <p className="text-xs text-muted-foreground">{c.description}</p>
              </div>
              {selectedModel === c.id && <Check className="h-4 w-4 text-foreground" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
