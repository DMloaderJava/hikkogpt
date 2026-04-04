import { Sparkles, Code, Lightbulb, BookOpen, Zap } from "lucide-react";

interface EmptyStateProps {
  onSuggestionClick: (text: string) => void;
  isMobile?: boolean;
}

const suggestions = [
  { icon: Code, text: "Напиши функцию сортировки на Python", label: "Код", color: "text-interactive" },
  { icon: Lightbulb, text: "Придумай идеи для стартапа в 2025 году", label: "Идеи", color: "text-interactive" },
  { icon: BookOpen, text: "Объясни квантовые вычисления простыми словами", label: "Обучение", color: "text-interactive" },
  { icon: Zap, text: "Составь контент-план для Instagram на месяц", label: "Контент", color: "text-interactive" },
];

export function EmptyState({ onSuggestionClick, isMobile }: EmptyStateProps) {
  return (
    <div className={`flex flex-1 flex-col items-center justify-center px-4 ${isMobile ? "pt-16 pb-4" : "py-6 sm:py-8"}`}>
      <div className="mb-4 sm:mb-6 flex h-14 w-14 sm:h-16 sm:w-16 items-center justify-center rounded-2xl bg-interactive shadow-lg shadow-interactive/20 animate-pop">
        <Sparkles className="h-7 w-7 sm:h-8 sm:w-8 text-interactive-foreground" />
      </div>

      <h1 className="mb-2 text-xl sm:text-2xl font-bold text-foreground animate-fade-in-up">
        Чем могу помочь?
      </h1>
      <p className="mb-6 sm:mb-8 text-sm text-muted-foreground text-center animate-fade-in-up" style={{ animationDelay: "0.1s" }}>
        Задайте любой вопрос или выберите идею ниже
      </p>

      {isMobile ? (
        <div className="w-full overflow-x-auto pb-1 -mx-4 px-4">
          <div className="flex gap-2" style={{ width: "max-content" }}>
            {suggestions.map((s, i) => (
              <button
                key={s.label}
                onClick={() => onSuggestionClick(s.text)}
                className="flex flex-col items-start gap-2 rounded-2xl border border-border bg-card p-3 text-left transition-all hover:border-interactive/30 hover:shadow-sm hover:shadow-interactive/5 active:scale-[0.97] animate-fade-in-up"
                style={{ width: "160px", minWidth: "160px", animationDelay: `${i * 0.05}s` }}
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-interactive/10">
                  <s.icon className={`h-4 w-4 ${s.color}`} />
                </div>
                <div>
                  <p className="text-sm font-semibold text-foreground">{s.label}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">{s.text}</p>
                </div>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="grid w-full max-w-2xl grid-cols-2 gap-2">
          {suggestions.map((s, i) => (
            <button
              key={s.label}
              onClick={() => onSuggestionClick(s.text)}
              className="group flex items-start gap-3 rounded-xl border border-border bg-card p-4 text-left transition-all hover:border-interactive/30 hover:shadow-md hover:shadow-interactive/5 active:scale-[0.98] animate-fade-in-up"
              style={{ animationDelay: `${i * 0.08}s` }}
            >
              <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-interactive/10 group-hover:bg-interactive/20 transition-colors">
                <s.icon className={`h-4 w-4 ${s.color}`} />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">{s.label}</p>
                <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">{s.text}</p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
