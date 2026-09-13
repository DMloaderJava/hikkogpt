import { useCallback, useState } from "react";
import { Drawer } from "vaul";
import { Plus } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useIsMobile } from "@/hooks/use-mobile";

export interface PlusMenuItem {
  id: string;
  label: string;
  /** Подпись под названием — что делает пункт. */
  description?: string;
  icon: LucideIcon;
  onSelect: () => void;
  disabled?: boolean;
  /** Причина блокировки: заменяет описание и уходит в title/aria-label. */
  disabledReason?: string;
  /** Пункт-переключатель во включённом состоянии (подсветка + «Вкл»). */
  active?: boolean;
}

export interface PlusMenuProps {
  items: PlusMenuItem[];
  /** Заголовок шторки на мобильных. */
  title?: string;
}

const SHEET_RADIUS = 28;

/**
 * Кнопка «+» с меню дополнительных действий.
 *
 * Смысл: в строке ввода остаются только частые действия (камера, голос,
 * диктовка), а всё остальное прячется сюда — интерфейс перестаёт быть
 * лентой из шести иконок.
 *
 * Адаптивно: на десктопе — компактный поповер над кнопкой, на мобильных —
 * нижняя шторка, до которой дотягивается большой палец.
 */
export function PlusMenu({ items, title = "Действия" }: PlusMenuProps) {
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();

  const hasActive = items.some((item) => item.active && !item.disabled);

  const handleSelect = useCallback((item: PlusMenuItem) => {
    if (item.disabled) return;
    // Сначала действие, потом закрытие: клик по пункту должен оставаться
    // «пользовательским жестом» (иначе браузер не откроет выбор файла).
    item.onSelect();
    setOpen(false);
  }, []);

  const triggerClassName = `relative flex-shrink-0 rounded-lg p-2 sm:p-2.5 transition-all ${
    open ? "text-interactive bg-interactive/10" : "btn-interactive text-muted-foreground"
  }`;

  const triggerInner = (
    <>
      <Plus
        style={{ width: "18px", height: "18px" }}
        className={`transition-transform duration-200 ${open ? "rotate-45" : ""}`}
      />
      {hasActive && !open && (
        <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-interactive" />
      )}
    </>
  );

  const list = (
    <div role="menu" aria-label={title} className="flex flex-col gap-0.5">
      {items.map((item) => {
        const Icon = item.icon;
        const hint = item.disabled ? item.disabledReason ?? item.description : item.description;
        return (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            onClick={() => handleSelect(item)}
            disabled={item.disabled}
            title={item.disabled ? item.disabledReason ?? item.label : item.label}
            aria-label={item.disabled ? item.disabledReason ?? item.label : item.label}
            data-testid={`plus-menu-item-${item.id}`}
            className={`flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left transition-all ${
              item.disabled
                ? "cursor-not-allowed text-muted-foreground/40"
                : item.active
                  ? "bg-interactive/10 text-interactive"
                  : "text-foreground hover:bg-interactive/10 hover:text-interactive active:scale-[0.98]"
            }`}
          >
            <span
              className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full ${
                item.disabled ? "bg-muted/50" : item.active ? "bg-interactive/15" : "bg-muted"
              }`}
            >
              <Icon style={{ width: "18px", height: "18px" }} />
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-medium">{item.label}</span>
              {hint && <span className="truncate text-xs text-muted-foreground">{hint}</span>}
            </span>
            {item.active && !item.disabled && (
              <span className="ml-auto flex-shrink-0 rounded-full bg-interactive/15 px-2 py-0.5 text-[11px] font-medium text-interactive">
                Вкл
              </span>
            )}
          </button>
        );
      })}
    </div>
  );

  if (isMobile) {
    return (
      <Drawer.Root open={open} onOpenChange={setOpen} shouldScaleBackground={false}>
        <Drawer.Trigger
          className={triggerClassName}
          title={title}
          aria-label={title}
          data-testid="plus-menu-trigger"
        >
          {triggerInner}
        </Drawer.Trigger>

        <Drawer.Portal>
          <Drawer.Overlay className="fixed inset-0 z-[100] bg-black/40 backdrop-blur-[2px]" />
          <Drawer.Content
            className="fixed inset-x-0 bottom-0 z-[101] flex flex-col bg-background outline-none"
            style={{ borderTopLeftRadius: SHEET_RADIUS, borderTopRightRadius: SHEET_RADIUS }}
            aria-label={title}
            data-testid="plus-menu-sheet"
          >
            <div className="mx-auto mt-3 h-1.5 w-10 flex-shrink-0 rounded-full bg-muted-foreground/30" />
            <Drawer.Title className="px-4 pb-1 pt-3 text-sm font-semibold text-foreground">
              {title}
            </Drawer.Title>
            <Drawer.Description className="sr-only">
              Дополнительные действия для сообщения
            </Drawer.Description>
            <div
              className="px-2 pt-1"
              style={{ paddingBottom: "max(16px, env(safe-area-inset-bottom, 16px))" }}
            >
              {list}
            </div>
          </Drawer.Content>
        </Drawer.Portal>
      </Drawer.Root>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={triggerClassName}
        title={title}
        aria-label={title}
        data-testid="plus-menu-trigger"
      >
        {triggerInner}
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-72 rounded-2xl border-border bg-popover p-1.5 shadow-lg"
        data-testid="plus-menu-content"
      >
        {list}
      </PopoverContent>
    </Popover>
  );
}
