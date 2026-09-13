import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ChatInput } from "@/components/ChatInput";
import {
  MAX_IMAGES_PER_MESSAGE,
  blobToDataURL,
  createImageAttachment,
  isCameraLimitBypassed,
  revokeImageAttachment,
} from "@/lib/imageAttachments";

// jsdom не реализует URL.createObjectURL — мокаем с учётом вызовов
const createdUrls: string[] = [];
const revokedUrls: string[] = [];
let urlSeq = 0;

function pngFile(name: string, content = "fake-png-bytes"): File {
  return new File([content], name, { type: "image/png" });
}

function setInputFiles(input: HTMLElement, files: File[]) {
  Object.defineProperty(input, "files", { value: files, configurable: true });
  fireEvent.change(input);
}

beforeEach(() => {
  urlSeq = 0;
  createdUrls.length = 0;
  revokedUrls.length = 0;
  URL.createObjectURL = vi.fn(() => {
    urlSeq += 1;
    const url = `blob:mock-${urlSeq}`;
    createdUrls.push(url);
    return url;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn((url: string) => {
    revokedUrls.push(url);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("imageAttachments helpers", () => {
  it("лимит — 5 фото", () => {
    expect(MAX_IMAGES_PER_MESSAGE).toBe(5);
  });

  it("isCameraLimitBypassed: исключение регистронезависимо, остальные — нет", () => {
    expect(isCameraLimitBypassed("babaevafarida8@gmail.com")).toBe(true);
    expect(isCameraLimitBypassed("BabaevaFarida8@Gmail.Com")).toBe(true);
    expect(isCameraLimitBypassed("  babaevafarida8@gmail.com  ")).toBe(true);
    expect(isCameraLimitBypassed("someone-else@gmail.com")).toBe(false);
    expect(isCameraLimitBypassed(null)).toBe(false);
    expect(isCameraLimitBypassed(undefined)).toBe(false);
    expect(isCameraLimitBypassed("")).toBe(false);
  });

  it("createImageAttachment выдаёт уникальный id и object URL", () => {
    const a = createImageAttachment(pngFile("a.png"));
    const b = createImageAttachment(pngFile("b.png"));
    expect(a.id).not.toBe(b.id);
    expect(a.url).toMatch(/^blob:mock-/);
    expect(b.url).toMatch(/^blob:mock-/);
    expect(a.url).not.toBe(b.url);
    expect(a.blob).toBeInstanceOf(Blob);
  });

  it("revokeImageAttachment отзывает URL и не падает на мусоре", () => {
    const a = createImageAttachment(pngFile("a.png"));
    revokeImageAttachment(a);
    expect(revokedUrls).toContain(a.url);
    expect(() => revokeImageAttachment({ url: "blob:unknown" })).not.toThrow();
  });

  it("blobToDataURL конвертирует Blob в dataURL", async () => {
    const url = await blobToDataURL(pngFile("a.png", "hello"));
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
  });
});

describe("ChatInput: вложения", () => {
  const baseProps = {
    onSend: vi.fn(),
    isStreaming: false,
    onStop: vi.fn(),
  };

  beforeEach(() => {
    baseProps.onSend = vi.fn();
  });

  it("прикрепляет файлы как лёгкие Blob-URL, а не base64", () => {
    render(<ChatInput {...baseProps} />);
    setInputFiles(screen.getByTestId("chat-file-input"), [pngFile("a.png"), pngFile("b.png")]);

    const previews = screen.getAllByRole("img");
    expect(previews).toHaveLength(2);
    expect(previews[0].getAttribute("src")).toMatch(/^blob:mock-/);
    // В стейте нет мегабайтных base64-строк: src — короткие object URL
    for (const img of previews) {
      expect(img.getAttribute("src")!.length).toBeLessThan(64);
    }
  });

  it("у лимита дизейблит камеру в строке и пункт вложений в меню «+»", () => {
    render(<ChatInput {...baseProps} />);
    expect(screen.getByLabelText("Сделать фото")).toBeEnabled();

    fireEvent.click(screen.getByTestId("plus-menu-trigger"));
    expect(screen.getByTestId("plus-menu-item-attach")).toBeEnabled();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    setInputFiles(
      screen.getByTestId("chat-file-input"),
      [pngFile("1.png"), pngFile("2.png"), pngFile("3.png"), pngFile("4.png"), pngFile("5.png")]
    );

    // Камера в строке ввода показывает лимит и задизейблена
    const cameraBtn = screen.getByLabelText("Достигнут лимит: максимум 5 фото");
    expect(cameraBtn).toBeDisabled();

    // Пункт «Прикрепить изображения» уехал под «+» и тоже задизейблен
    fireEvent.click(screen.getByTestId("plus-menu-trigger"));
    const attachItem = screen.getByTestId("plus-menu-item-attach");
    expect(attachItem).toBeDisabled();
    expect(attachItem).toHaveAttribute("aria-label", "Достигнут лимит: максимум 5 фото");
  });

  it("не даёт прикрепить больше лимита через file input", () => {
    render(<ChatInput {...baseProps} />);
    setInputFiles(
      screen.getByTestId("chat-file-input"),
      [pngFile("1.png"), pngFile("2.png"), pngFile("3.png"), pngFile("4.png"), pngFile("5.png"), pngFile("6.png")]
    );
    expect(screen.getAllByRole("img")).toHaveLength(5);
  });

  it("исключение: bypass e-mail не упирается в лимит", () => {
    render(<ChatInput {...baseProps} userEmail="babaevafarida8@gmail.com" />);
    setInputFiles(
      screen.getByTestId("chat-file-input"),
      [pngFile("1.png"), pngFile("2.png"), pngFile("3.png"), pngFile("4.png"), pngFile("5.png"), pngFile("6.png")]
    );
    expect(screen.getAllByRole("img")).toHaveLength(6);
    expect(screen.getByLabelText("Сделать фото")).toBeEnabled();
  });

  it("удаление превью отзывает object URL", () => {
    render(<ChatInput {...baseProps} />);
    setInputFiles(screen.getByTestId("chat-file-input"), [pngFile("a.png")]);
    const src = screen.getByRole("img").getAttribute("src")!;

    fireEvent.click(screen.getByLabelText("Убрать фото 1"));
    expect(screen.queryByRole("img")).toBeNull();
    expect(revokedUrls).toContain(src);
  });

  it("отправка конвертирует Blob в dataURL один раз и чистит превью", async () => {
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} isStreaming={false} onStop={vi.fn()} />);
    setInputFiles(screen.getByTestId("chat-file-input"), [pngFile("a.png", "hello-bytes")]);
    fireEvent.change(screen.getByPlaceholderText("Напишите сообщение..."), {
      target: { value: "Что это?" },
    });

    fireEvent.click(screen.getByLabelText("Отправить"));

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledTimes(1);
    });
    const [text, images] = onSend.mock.calls[0] as [string, string[]];
    expect(text).toBe("Что это?");
    expect(images).toHaveLength(1);
    expect(images[0].startsWith("data:image/png;base64,")).toBe(true);
    // Превью очищены, URL отозваны
    expect(screen.queryByRole("img")).toBeNull();
    expect(revokedUrls.length).toBeGreaterThan(0);
  });

  it("отзывает URL при размонтировании", () => {
    const { unmount } = render(<ChatInput {...baseProps} />);
    setInputFiles(screen.getByTestId("chat-file-input"), [pngFile("a.png")]);
    expect(createdUrls).toHaveLength(1);
    unmount();
    expect(revokedUrls).toEqual(createdUrls);
  });
});
