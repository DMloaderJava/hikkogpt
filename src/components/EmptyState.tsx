import { Sparkles, Code, Lightbulb, BookOpen, Zap } from "lucide-react";

interface EmptyStateProps {
  onSuggestionClick: (text: string) => void;
}

const suggestions = [
  { icon: Code, text: "Напиши функцию сортировки на Python", label: "Код", color: "text-blue-500" },
  { icon: Lightbulb, text: "Придумай идеи для стартапа в 2025 году", label: "Идеи", color: "text-yellow-500" },
  { icon: BookOpen, text: "Объясни квантовые вычисления простыми словами", label: "Обучение", color: "text-green-500" },
  { icon: Zap, text: "Составь контент-план для Instagram на месяц", label: "Контент", color: "text-purple-500" },
];

export function EmptyState({ onSuggestionClick }: EmptyStateProps) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 py-8">
      <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary shadow-sm">
        <Sparkles className="h-8 w-8 text-primary-foreground" />
      </div>

      <h1 className="mb-2 text-2xl font-bold text-foreground">
        Чем могу помочь?
      </h1>
      <p className="mb-8 text-sm text-muted-foreground">Задайте любой вопрос или выберите идею ниже</p>

      <div className="grid w-full max-w-2xl grid-cols-1 gap-2 sm:grid-cols-2">
        {suggestions.map((s) => (
          <button
            key={s.label}
            onClick={() => onSuggestionClick(s.text)}
            className="group flex items-start gap-3 rounded-xl border border-border bg-card p-4 text-left transition-all hover:bg-secondary/80 hover:border-border/50 hover:shadow-sm active:scale-[0.98]"
          >
            <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-secondary group-hover:bg-background transition-colors">
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
  );
}
