import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ChatInput } from "@/components/ChatInput";

/**
 * Вход в студию видео-историй из чата: пункт меню «+», открытие окна и отправка
 * готового результата обычным сообщением (текст + постер).
 *
 * Сборку видео проверяют тесты студии (`videoStoryStudio.test.tsx`), поэтому
 * здесь окно подменено заглушкой, которая зовёт `onShare` — важен только стык
 * с `onSend` чата и то, что окно закрывается после отправки.
 */

vi.mock("@/components/VideoStoryStudio", () => ({
  VideoStoryStudio: ({
    open,
    onClose,
    onShare,
  }: {
    open: boolean;
    onClose: () => void;
    onShare?: (payload: { text: string; images: string[] }) => void;
  }) =>
    open ? (
      <div data-testid="story-modal">
        <button
          type="button"
          data-testid="stub-share"
          onClick={() =>
            onShare?.({
              text: "Видео-история «Тест»: 2 слайдов, 2 озвучено.",
              images: ["data:image/jpeg;base64,POSTER"],
            })
          }
        >
          отправить
        </button>
        <button type="button" data-testid="stub-close" onClick={onClose}>
          закрыть
        </button>
      </div>
    ) : null,
}));

const baseProps = {
  onSend: vi.fn(),
  isStreaming: false,
  onStop: vi.fn(),
};

function openPlusMenu() {
  fireEvent.click(screen.getByTestId("plus-menu-trigger"));
  return screen.getByTestId("plus-menu-item-video-story");
}

beforeEach(() => {
  baseProps.onSend = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("чат: вход в студию видео-историй", () => {
  it("студия закрыта, пока её не открыли из меню «+»", () => {
    render(<ChatInput {...baseProps} />);
    expect(screen.queryByTestId("story-modal")).toBeNull();
  });

  it("в меню «+» есть пункт студии с понятным описанием", () => {
    render(<ChatInput {...baseProps} />);
    const item = openPlusMenu();
    expect(item.textContent).toContain("Студия видео-историй");
    expect(item.textContent).toMatch(/слайд|голос|сценар|видео/i);
    expect(item.hasAttribute("disabled")).toBe(false);
  });

  it("пункт меню открывает студию", () => {
    render(<ChatInput {...baseProps} />);
    fireEvent.click(openPlusMenu());
    expect(screen.getByTestId("story-modal")).toBeTruthy();
    expect(baseProps.onSend).not.toHaveBeenCalled();
  });

  it("результат студии уходит в чат сообщением с постером, окно закрывается", () => {
    render(<ChatInput {...baseProps} />);
    fireEvent.click(openPlusMenu());
    fireEvent.click(screen.getByTestId("stub-share"));

    expect(baseProps.onSend).toHaveBeenCalledTimes(1);
    const [text, images] = baseProps.onSend.mock.calls[0] as [string, string[]];
    expect(text).toContain("Видео-история «Тест»");
    expect(images).toEqual(["data:image/jpeg;base64,POSTER"]);
    expect(screen.queryByTestId("story-modal")).toBeNull();
  });

  it("закрытие студии ничего не отправляет", () => {
    render(<ChatInput {...baseProps} />);
    fireEvent.click(openPlusMenu());
    fireEvent.click(screen.getByTestId("stub-close"));

    expect(screen.queryByTestId("story-modal")).toBeNull();
    expect(baseProps.onSend).not.toHaveBeenCalled();
  });

  it("студию можно открыть снова после отправки", () => {
    render(<ChatInput {...baseProps} />);
    fireEvent.click(openPlusMenu());
    fireEvent.click(screen.getByTestId("stub-share"));
    fireEvent.click(openPlusMenu());

    expect(screen.getByTestId("story-modal")).toBeTruthy();
    expect(baseProps.onSend).toHaveBeenCalledTimes(1);
  });
});
