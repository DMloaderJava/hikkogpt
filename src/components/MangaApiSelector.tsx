/**
 * Переключатель api в окне «Озвучиватель манги».
 *
 * Компактный аналог `ModelSelector` из чата: тот же список имён (общий модуль
 * `mangaApi`), но без персонажей — для разбора страниц они смысла не имеют — и
 * с подписью «Api анализа», чтобы было видно, что именно переключается.
 *
 * Список сделан вручную (кнопка + панель), а не на Radix DropdownMenu: панель
 * позиционируется `fixed` от прямоугольника кнопки, поэтому не обрезается
 * краями диалога и открывается даже когда окно манги почти во весь экран.
 */

import { Brain, Check, ChevronDown, Cpu, Sparkles, Swords, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { MANGA_API_OPTIONS, describeMangaApi } from "@/lib/mangaApi";

const ICONS: Record<string, typeof Brain> = {
  HikkoGPT: Brain,
  "HikkoGPT Smart": Sparkles,
  "HikkoGPT Turbo": Zap,
  Спорящий: Swords,
};

interface MangaApiSelectorProps {
  /** Выбранное api (имя из `MANGA_API_OPTIONS`). */
  value: string;
  onChange: (id: string) => void;
  /** Пока идёт запрос, api не меняем: батч должен пройти на одной модели. */
  disabled?: boolean;
}

export function MangaApiSelector({ value, onChange, disabled = false }: MangaApiSelectorProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const Icon = ICONS[value] ?? Cpu;

  useEffect(() => {
    if (!open) return;
    const onOutside = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("touchstart", onOutside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onOutside);
      document.removeEventListener("touchstart", onOutside);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const panelStyle = (() => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return { top: 0, right: 8 } as const;
    // Панель прижата к правому краю кнопки и уходит вниз; у дна экрана — вверх.
    const spaceBelow = window.innerHeight - rect.bottom;
    return {
      ...(spaceBelow < 260 ? { bottom: window.innerHeight - rect.top + 8 } : { top: rect.bottom + 8 }),
      right: Math.max(8, window.innerWidth - rect.right),
    } as const;
  })();

  return (
    <div ref={ref} className="relative" data-testid="manga-api-selector">
      <button
        type="button"
        onClick={() => !disabled && setOpen((prev) => !prev)}
        disabled={disabled}
        aria-label="Api анализа манги"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={describeMangaApi(value) || "Api анализа манги"}
        className="flex items-center gap-1.5 rounded-xl border border-border bg-muted/50 px-2.5 py-1.5 text-xs font-medium text-foreground transition-all btn-interactive disabled:cursor-not-allowed disabled:opacity-60"
      >
        <Icon className="h-3.5 w-3.5 flex-shrink-0 text-interactive" />
        <span className="max-w-[110px] truncate">{value}</span>
        <ChevronDown className={`h-3 w-3 flex-shrink-0 transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="Api анализа манги"
          className="fixed z-[100] w-[248px] rounded-2xl border border-border bg-popover p-1.5 shadow-xl animate-scale-in"
          style={panelStyle}
          onClick={(e) => e.stopPropagation()}
        >
          <p className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Api анализа
          </p>
          {MANGA_API_OPTIONS.map((option) => {
            const OptionIcon = ICONS[option.id] ?? Cpu;
            const selected = option.id === value;
            return (
              <button
                key={option.id}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  onChange(option.id);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-all active:scale-[0.98] ${
                  selected ? "bg-interactive/10 text-interactive" : "hover:bg-accent"
                }`}
              >
                <OptionIcon
                  className={`h-4 w-4 flex-shrink-0 ${selected ? "text-interactive" : "text-muted-foreground"}`}
                />
                <span className="min-w-0 flex-1">
                  <span
                    className={`block text-sm font-medium ${selected ? "text-interactive" : "text-popover-foreground"}`}
                  >
                    {option.label}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">{option.description}</span>
                </span>
                {selected && <Check className="h-4 w-4 flex-shrink-0 text-interactive" />}
              </button>
            );
          })}
          <p className="px-3 pb-1 pt-1.5 text-[11px] leading-snug text-muted-foreground">
            Api выбирается один раз: дальше все страницы главы анализируются им же.
          </p>
        </div>
      )}
    </div>
  );
}
