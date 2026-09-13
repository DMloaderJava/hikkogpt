import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Image as ImageIcon, Search, Volume2 } from "lucide-react";
import { PlusMenu } from "@/components/PlusMenu";
import type { PlusMenuItem } from "@/components/PlusMenu";
import { ChatInput } from "@/components/ChatInput";

// Radix/vaul используют ResizeObserver и pointer-события, которых нет в jsdom.
function stubBrowserApis() {
  if (typeof window.ResizeObserver === "undefined") {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
}

/** Эмулируем ширину экрана для useIsMobile (breakpoint 768px). */
function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true, writable: true });
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: width < 768,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => {},
    }),
  });
}

beforeEach(() => {
  stubBrowserApis();
  setViewport(1280);
  URL.createObjectURL = vi.fn(() => "blob:mock") as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function makeItems(overrides: Partial<PlusMenuItem>[] = []): PlusMenuItem[] {
  const base: PlusMenuItem[] = [
    { id: "attach", label: "Прикрепить изображения", icon: ImageIcon, onSelect: vi.fn() },
    { id: "deep-search", label: "Глубокий поиск", icon: Search, onSelect: vi.fn() },
    { id: "tts", label: "Озвучка диалога", icon: Volume2, onSelect: vi.fn() },
  ];
  return base.map((item, i) => ({ ...item, ...(overrides[i] ?? {}) }));
}

describe("PlusMenu", () => {
  it("по умолчанию меню закрыто — видна только кнопка «+»", () => {
    render(<PlusMenu items={makeItems()} />);
    expect(screen.getByTestId("plus-menu-trigger")).toBeTruthy();
    expect(screen.queryByTestId("plus-menu-item-attach")).toBeNull();
  });

  it("клик по «+» раскрывает все пункты (десктоп — поповер)", () => {
    render(<PlusMenu items={makeItems()} />);
    fireEvent.click(screen.getByTestId("plus-menu-trigger"));

    expect(screen.getByTestId("plus-menu-content")).toBeTruthy();
    expect(screen.getByText("Прикрепить изображения")).toBeTruthy();
    expect(screen.getByText("Глубокий поиск")).toBeTruthy();
    expect(screen.getByText("Озвучка диалога")).toBeTruthy();
  });

  it("на мобильных открывается нижняя шторка, а не поповер", () => {
    setViewport(390);
    render(<PlusMenu items={makeItems()} />);
    fireEvent.click(screen.getByTestId("plus-menu-trigger"));

    expect(screen.getByTestId("plus-menu-sheet")).toBeTruthy();
    expect(screen.queryByTestId("plus-menu-content")).toBeNull();
    expect(screen.getByText("Прикрепить изображения")).toBeTruthy();
  });

  it("выбор пункта вызывает onSelect и закрывает меню", () => {
    const onSelect = vi.fn();
    render(<PlusMenu items={makeItems([{ onSelect }])} />);

    fireEvent.click(screen.getByTestId("plus-menu-trigger"));
    fireEvent.click(screen.getByTestId("plus-menu-item-attach"));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("plus-menu-item-attach")).toBeNull();
  });

  it("задизейбленный пункт не вызывает onSelect и объясняет причину", () => {
    const onSelect = vi.fn();
    render(
      <PlusMenu
        items={makeItems([{}, { onSelect, disabled: true, disabledReason: "Лимит исчерпан" }])}
      />
    );

    fireEvent.click(screen.getByTestId("plus-menu-trigger"));
    const item = screen.getByTestId("plus-menu-item-deep-search");
    expect(item).toBeDisabled();
    expect(item).toHaveAttribute("title", "Лимит исчерпан");

    fireEvent.click(item);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("активный пункт помечен «Вкл», а на кнопке «+» есть точка-индикатор", () => {
    render(<PlusMenu items={makeItems([{}, { active: true }])} />);

    // Точка-индикатор: что-то внутри меню включено
    const trigger = screen.getByTestId("plus-menu-trigger");
    expect(trigger.querySelector(".bg-interactive")).toBeTruthy();

    fireEvent.click(trigger);
    expect(screen.getByText("Вкл")).toBeTruthy();
  });
});

describe("ChatInput: раскладка кнопок вокруг «+»", () => {
  const baseProps = { onSend: vi.fn(), isStreaming: false, onStop: vi.fn() };

  it("в строке остаются камера, голосовой режим и диктовка", () => {
    render(<ChatInput {...baseProps} onToggleVoiceMode={vi.fn()} />);

    expect(screen.getByLabelText("Сделать фото")).toBeTruthy();
    expect(screen.getByTitle("Голосовой режим Gemini Live")).toBeTruthy();
    expect(screen.getByTestId("plus-menu-trigger")).toBeTruthy();

    // Вложения и поиск больше не занимают место в строке
    expect(screen.queryByTitle("Прикрепить изображения")).toBeNull();
    expect(screen.queryByTitle("Глубокий поиск")).toBeNull();
  });

  it("«Прикрепить изображения» из меню открывает выбор файла", () => {
    render(<ChatInput {...baseProps} />);
    const fileInput = screen.getByTestId("chat-file-input");
    const clickSpy = vi.spyOn(fileInput, "click").mockImplementation(() => {});

    fireEvent.click(screen.getByTestId("plus-menu-trigger"));
    fireEvent.click(screen.getByTestId("plus-menu-item-attach"));

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("«Глубокий поиск» из меню включает режим и показывает плашку", () => {
    render(<ChatInput {...baseProps} onDeepSearch={vi.fn()} />);

    fireEvent.click(screen.getByTestId("plus-menu-trigger"));
    fireEvent.click(screen.getByTestId("plus-menu-item-deep-search"));

    expect(screen.getByText("Режим глубокого поиска")).toBeTruthy();
    expect(screen.getByPlaceholderText("Введите запрос для поиска...")).toBeTruthy();
  });

  it("исчерпанный глубокий поиск приходит в меню задизейбленным", () => {
    render(<ChatInput {...baseProps} deepSearchUsed onDeepSearch={vi.fn()} />);

    fireEvent.click(screen.getByTestId("plus-menu-trigger"));
    const item = screen.getByTestId("plus-menu-item-deep-search");
    expect(item).toBeDisabled();
    expect(item).toHaveAttribute("title", "Лимит глубокого поиска исчерпан");
  });

  it("при deepSearchEnabled=false пункта поиска в меню нет", () => {
    render(<ChatInput {...baseProps} deepSearchEnabled={false} />);

    fireEvent.click(screen.getByTestId("plus-menu-trigger"));
    expect(screen.queryByTestId("plus-menu-item-deep-search")).toBeNull();
    expect(screen.getByTestId("plus-menu-item-attach")).toBeTruthy();
    expect(screen.getByTestId("plus-menu-item-tts")).toBeTruthy();
  });

  it("«Озвучка диалога» из меню открывает модалку", () => {
    render(<ChatInput {...baseProps} />);

    fireEvent.click(screen.getByTestId("plus-menu-trigger"));
    fireEvent.click(screen.getByTestId("plus-menu-item-tts"));

    expect(screen.getByText("Озвучка диалога", { selector: "h2, h3" })).toBeTruthy();
  });
});
