import { Sparkles, Code, Lightbulb, BookOpen } from "lucide-react";

interface EmptyStateProps {
  onSuggestionClick: (text: string) => void;
}

const suggestions = [
  { icon: Code, text: "Напиши функцию сортировки на Python", label: "Код" },
  { icon: Lightbulb, text: "Придумай идеи для стартапа в 2025 году", label: "Идеи" },
  { icon: BookOpen, text: "Объясни квантовые вычисления простыми словами", label: "Обучение" },
  { icon: Sparkles, text: "Составь контент-план для Instagram на месяц", label: "Контент" },
];

export function EmptyState({ onSuggestionClick }: EmptyStateProps) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4">
      <div className="mb-8 flex h-16 w-16 items-center justify-center rounded-full bg-secondary">
        <Sparkles className="h-8 w-8 text-foreground" />
      </div>

      <h1 className="mb-8 text-2xl font-semibold text-foreground">
        Чем могу помочь?
      </h1>

      <div className="grid w-full max-w-2xl grid-cols-2 gap-3">
        {suggestions.map((s) => (
          <button
            key={s.label}
            onClick={() => onSuggestionClick(s.text)}
            className="flex items-start gap-3 rounded-xl border border-border p-4 text-left transition-colors hover:bg-secondary/80"
          >
            <s.icon className="mt-0.5 h-5 w-5 flex-shrink-0 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium text-foreground">{s.label}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{s.text}</p>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
