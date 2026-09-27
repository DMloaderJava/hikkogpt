import { Heart, Sparkles } from "lucide-react";
import { AI_PROVIDERS, type AiProvider } from "@/types/ai-provider";
import { cn } from "@/lib/utils";

interface ProviderSelectorProps {
  value: AiProvider;
  onChange: (provider: AiProvider) => void;
  /** `full` — две карточки с описаниями (настройки), `compact` — сегмент-контрол (шапка). */
  variant?: "full" | "compact";
}

const PROVIDER_ICONS: Record<AiProvider, typeof Sparkles> = {
  lovable: Heart,
  gemini: Sparkles,
};

export function ProviderSelector({ value, onChange, variant = "full" }: ProviderSelectorProps) {
  if (variant === "compact") {
    return (
      <div
        role="radiogroup"
        aria-label="API-провайдер"
        className="flex items-center gap-0.5 rounded-xl bg-secondary/50 p-1"
      >
        {(Object.keys(AI_PROVIDERS) as AiProvider[]).map((id) => {
          const meta = AI_PROVIDERS[id];
          const Icon = PROVIDER_ICONS[id];
          const active = value === id;
          return (
            <button
              key={id}
              role="radio"
              aria-checked={active}
              title={meta.description}
              onClick={() => onChange(id)}
              className={cn(
                "flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium transition-all active:scale-95",
                active
                  ? "bg-interactive text-interactive-foreground shadow-sm shadow-interactive/20"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{meta.shortLabel}</span>
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div role="radiogroup" aria-label="API-провайдер" className="grid grid-cols-2 gap-1.5">
      {(Object.keys(AI_PROVIDERS) as AiProvider[]).map((id) => {
        const meta = AI_PROVIDERS[id];
        const Icon = PROVIDER_ICONS[id];
        const active = value === id;
        return (
          <button
            key={id}
            role="radio"
            aria-checked={active}
            onClick={() => onChange(id)}
            className={cn(
              "rounded-xl px-3 py-2.5 text-left transition-all active:scale-[0.97]",
              active
                ? "bg-interactive text-interactive-foreground ring-2 ring-interactive/30 shadow-sm shadow-interactive/10"
                : "bg-secondary/50 text-foreground hover:bg-secondary"
            )}
          >
            <p className="flex items-center gap-1.5 text-sm font-medium">
              <Icon className="h-4 w-4" />
              {meta.label}
            </p>
            <p
              className={cn(
                "mt-0.5 text-xs",
                active ? "text-interactive-foreground/70" : "text-muted-foreground"
              )}
            >
              {meta.description}
            </p>
          </button>
        );
      })}
    </div>
  );
}
