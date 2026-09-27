import { useState } from "react";
import { Key, Plus, X, Eye, EyeOff, ChevronDown, Trash2 } from "lucide-react";
import { MAX_USER_GEMINI_KEYS, maskApiKey } from "@/lib/userApiKeys";
import { cn } from "@/lib/utils";

interface UserApiKeysEditorProps {
  keys: string[];
  activeIndex: number;
  onAdd: (text: string) => void;
  onRemove: (index: number) => void;
  onClear: () => void;
}

/**
 * Редактор пользовательских Gemini API ключей для настроек.
 * Компактная сворачиваемая секция: список + поле вставки (можно несколько сразу).
 */
export function UserApiKeysEditor({ keys, activeIndex, onAdd, onRemove, onClear }: UserApiKeysEditorProps) {
  const [open, setOpen] = useState(keys.length > 0);
  const [draft, setDraft] = useState("");
  const [showKeys, setShowKeys] = useState(false);

  const activeNormalized = keys.length > 0 ? activeIndex % keys.length : -1;
  const isFull = keys.length >= MAX_USER_GEMINI_KEYS;

  const submit = () => {
    if (!draft.trim() || isFull) return;
    onAdd(draft);
    setDraft("");
  };

  return (
    <div className="rounded-xl bg-secondary/50">
      {/* Заголовок-спойлер */}
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-3 text-left transition-all active:scale-[0.99]"
      >
        <Key className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
        <span className="flex-1 text-sm font-medium text-foreground">Мои Gemini ключи</span>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums",
            keys.length > 0 ? "bg-interactive/15 text-interactive" : "bg-muted text-muted-foreground"
          )}
        >
          {keys.length}/{MAX_USER_GEMINI_KEYS}
        </span>
        <ChevronDown
          className={cn("h-4 w-4 text-muted-foreground transition-transform duration-200", open && "rotate-180")}
        />
      </button>

      {open && (
        <div className="px-3 pb-3 animate-fade-in">
          {/* Список ключей */}
          {keys.length > 0 && (
            <div className="mb-2 max-h-48 space-y-1 overflow-y-auto pr-0.5 scrollbar-thin">
              {keys.map((key, i) => (
                <div
                  key={`${key.slice(0, 8)}-${i}`}
                  className={cn(
                    "flex items-center gap-2 rounded-lg px-2.5 py-1.5",
                    i === activeNormalized ? "bg-interactive/10" : "bg-background/60"
                  )}
                  title={i === activeNormalized ? "Активный ключ — перебор начнётся с него" : `Ключ ${i + 1}`}
                >
                  <span
                    className={cn(
                      "h-1.5 w-1.5 flex-shrink-0 rounded-full",
                      i === activeNormalized ? "bg-interactive" : "bg-muted-foreground/30"
                    )}
                  />
                  <span className="text-[11px] tabular-nums text-muted-foreground">{i + 1}.</span>
                  <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                    {showKeys ? key : maskApiKey(key)}
                  </code>
                  <button
                    onClick={() => onRemove(i)}
                    aria-label={`Удалить ключ ${i + 1}`}
                    className="flex-shrink-0 rounded-md p-1 text-muted-foreground transition-all hover:text-destructive active:scale-90"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Вставка новых */}
          {!isFull ? (
            <div className="flex items-center gap-1.5">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submit();
                }}
                placeholder="Вставьте ключ или несколько через пробел"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                aria-label="Новые Gemini API ключи"
                className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2.5 py-2 font-mono text-xs text-foreground placeholder:font-sans placeholder:text-muted-foreground focus:border-interactive/50 focus:outline-none"
              />
              <button
                onClick={submit}
                disabled={!draft.trim()}
                aria-label="Добавить ключи"
                className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-interactive text-interactive-foreground transition-all hover:opacity-90 active:scale-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Plus className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <p className="rounded-lg bg-background/60 px-2.5 py-2 text-xs text-muted-foreground">
              Достигнут лимит — {MAX_USER_GEMINI_KEYS} ключей. Удалите лишний, чтобы добавить новый.
            </p>
          )}

          {/* Нижняя строка: показать/скрыть + очистить */}
          <div className="mt-2 flex items-center justify-between">
            <button
              onClick={() => setShowKeys(!showKeys)}
              className="flex items-center gap-1 rounded-md px-1 py-0.5 text-[11px] text-muted-foreground transition-all hover:text-foreground"
            >
              {showKeys ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              {showKeys ? "Скрыть" : "Показать"}
            </button>
            {keys.length > 0 && (
              <button
                onClick={onClear}
                className="flex items-center gap-1 rounded-md px-1 py-0.5 text-[11px] text-muted-foreground transition-all hover:text-destructive"
              >
                <Trash2 className="h-3 w-3" />
                Очистить все
              </button>
            )}
          </div>

          <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
            Ключи хранятся только на этом устройстве. При исчерпании квоты запрос автоматически
            переключится на следующий ключ, затем — на серверные.
          </p>
        </div>
      )}
    </div>
  );
}
