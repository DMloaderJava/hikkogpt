import { DeepSearchState, DeepSearchPhase } from "@/hooks/useDeepSearch";
import { Search, Loader2, HelpCircle, List, Globe, Brain, FileText, CheckCircle2 } from "lucide-react";
import { Progress } from "@/components/ui/progress";

interface DeepSearchPanelProps {
  deepSearch: DeepSearchState;
}

interface StepConfig {
  key: string;
  label: string;
  icon: React.ElementType;
}

const STEPS: StepConfig[] = [
  { key: "clarifying", label: "Уточнение", icon: HelpCircle },
  { key: "generating_queries", label: "Запросы", icon: List },
  { key: "searching", label: "Поиск", icon: Globe },
  { key: "analyzing", label: "Анализ", icon: Brain },
  { key: "report", label: "Отчёт", icon: FileText },
];

function getActiveStepIndex(phase: DeepSearchPhase): number {
  switch (phase) {
    case "clarifying": return 0;
    case "waiting_answers": return 0;
    case "generating_queries": return 1;
    case "searching": return 2;
    case "analyzing": return 3;
    case "done": return 5;
    default: return -1;
  }
}

export function DeepSearchPanel({ deepSearch }: DeepSearchPanelProps) {
  if (deepSearch.phase === "idle" || deepSearch.phase === "error") return null;

  const activeIdx = getActiveStepIndex(deepSearch.phase);
  const isDone = deepSearch.phase === "done";
  const progressValue = isDone ? 100 : Math.min(((activeIdx + 0.5) / STEPS.length) * 100, 95);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-2 animate-slide-up">
      <div className="rounded-xl border border-border bg-secondary/30 p-3 space-y-3">
        {/* Step indicators */}
        <div className="flex items-center justify-between gap-1">
          {STEPS.map((step, i) => {
            const Icon = step.icon;
            const isActive = i === activeIdx;
            const isCompleted = i < activeIdx || isDone;

            return (
              <div key={step.key} className="flex flex-col items-center gap-1 flex-1 min-w-0">
                <div
                  className={`flex h-8 w-8 items-center justify-center rounded-full transition-all duration-300 ${
                    isCompleted
                      ? "bg-interactive text-interactive-foreground"
                      : isActive
                      ? "bg-interactive/20 text-interactive ring-2 ring-interactive/40"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {isCompleted ? (
                    <CheckCircle2 className="h-4 w-4" />
                  ) : isActive ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Icon className="h-4 w-4" />
                  )}
                </div>
                <span
                  className={`text-[10px] leading-tight text-center truncate w-full ${
                    isActive ? "text-interactive font-medium" : isCompleted ? "text-foreground" : "text-muted-foreground"
                  }`}
                >
                  {step.label}
                </span>
              </div>
            );
          })}
        </div>

        <Progress value={progressValue} className="h-1.5" />

        {deepSearch.statusMessage && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {!isDone && <Loader2 className="h-3 w-3 animate-spin text-interactive flex-shrink-0" />}
            <span className="truncate">{deepSearch.statusMessage}</span>
          </div>
        )}
      </div>
    </div>
  );
}
