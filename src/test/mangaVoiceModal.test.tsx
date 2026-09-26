import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MangaVoiceModal } from "@/components/MangaVoiceModal";
import { ANALYZE_BATCH_SIZE } from "@/lib/mangaPages";

/**
 * Озвучиватель манги целиком: добавление страниц, анализ по батчам, правка
 * реплик, озвучка кадра и уборка object URL.
 */

const created: string[] = [];
const revoked: string[] = [];
let urlSeq = 0;

interface RecordedCall {
  url: string;
  body: Record<string, unknown> & { images?: string[]; transcript?: string; voices?: Record<string, string> };
}

const calls: RecordedCall[] = [];
let fetchImpl: (url: string, init: RequestInit) => Promise<unknown>;

function pngFile(name: string) {
  return new File([`bytes-of-${name}`], name, { type: "image/png" });
}

function setInputFiles(input: HTMLElement, files: File[]) {
  Object.defineProperty(input, "files", { value: files, configurable: true });
  fireEvent.change(input);
}

const jsonResponse = (data: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => data,
});

const audioResponse = () => ({
  ok: true,
  status: 200,
  blob: async () => new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/wav" }),
});

/** Анализирует все добавленные страницы (по батчам) через реальный обработчик. */
async function analyzeAll(times = 3) {
  for (let i = 0; i < times; i += 1) {
    const button = screen.getByTestId("manga-analyze");
    if (button.hasAttribute("disabled")) break;
    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() => expect(screen.getByTestId("manga-analyze").hasAttribute("disabled") || screen.queryByRole("alert")).toBeTruthy());
  }
}

beforeEach(() => {
  urlSeq = 0;
  created.length = 0;
  revoked.length = 0;
  calls.length = 0;

  URL.createObjectURL = vi.fn(() => {
    urlSeq += 1;
    const url = `blob:mock-${urlSeq}`;
    created.push(url);
    return url;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn((url: string) => {
    revoked.push(url);
  });

  // jsdom не умеет ни createImageBitmap, ни canvas: даём лёгкий декодер,
  // чтобы toPageDataURL шла по пути «страница уже маленькая».
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 900, height: 1200, close() {} })));

  fetchImpl = async () => jsonResponse({ pages: [] });
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : {} });
    return fetchImpl(url, init ?? {}) as never;
  }) as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function open() {
  return render(<MangaVoiceModal open onClose={vi.fn()} />);
}

describe("MangaVoiceModal: страницы", () => {
  it("закрытая модалка ничего не рендерит", () => {
    render(<MangaVoiceModal open={false} onClose={vi.fn()} />);
    expect(screen.queryByTestId("manga-modal")).toBeNull();
  });

  it("показывает добавленные страницы по порядку", () => {
    open();
    setInputFiles(screen.getByTestId("manga-file-input"), [pngFile("p1.png"), pngFile("p2.png")]);

    expect(screen.getByTestId("manga-page-1")).toBeTruthy();
    expect(screen.getByTestId("manga-page-2")).toBeTruthy();
    expect(screen.getByTestId("manga-analyze").textContent).toContain("1–2");
  });

  it("чужой формат не добавляется, причина видна", () => {
    open();
    setInputFiles(screen.getByTestId("manga-file-input"), [new File(["x"], "a.gif", { type: "image/gif" })]);

    expect(screen.queryByTestId("manga-page-1")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("нужен PNG, JPEG или WebP");
  });

  it("удаление страницы убирает её из списка и отзывает object URL", () => {
    open();
    setInputFiles(screen.getByTestId("manga-file-input"), [pngFile("p1.png")]);
    const url = created[created.length - 1];

    fireEvent.click(screen.getByLabelText("Убрать страницу 1"));

    expect(screen.queryByTestId("manga-page-1")).toBeNull();
    expect(revoked).toContain(url);
  });

  it("Escape закрывает модалку", () => {
    const onClose = vi.fn();
    render(<MangaVoiceModal open onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("MangaVoiceModal: анализ", () => {
  it("шлёт dataURL страниц в manga-analyze и раскладывает ответ по страницам", async () => {
    open();
    setInputFiles(screen.getByTestId("manga-file-input"), [pngFile("p1.png"), pngFile("p2.png")]);

    fetchImpl = async () =>
      jsonResponse({
        pages: [
          { description: "Первый кадр", transcript: "Speaker 1: Привет" },
          { description: "Второй кадр", transcript: "Speaker 2: Пока" },
        ],
      });

    await act(async () => {
      fireEvent.click(screen.getByTestId("manga-analyze"));
    });

    await waitFor(() => expect(screen.getByText("Первый кадр")).toBeTruthy());
    expect(screen.getByText("Второй кадр")).toBeTruthy();

    const analyzeCall = calls.find((c) => c.url.endsWith("/manga-analyze"));
    expect(analyzeCall?.url).toBe(`${"https://xnhtuhvcrozgzcytnnco.supabase.co"}/functions/v1/manga-analyze`);
    expect(analyzeCall?.body.images).toHaveLength(2);
    expect(analyzeCall?.body.images[0].startsWith("data:image/png;base64,")).toBe(true);

    expect(screen.getByTestId("manga-transcript-1")).toHaveValue("Speaker 1: Привет");
    expect(screen.getByTestId("manga-analyze").textContent).toContain("Все страницы обработаны");
  });

  it("одно нажатие разбирает все страницы, но в запросе не больше 5", async () => {
    open();
    setInputFiles(
      screen.getByTestId("manga-file-input"),
      Array.from({ length: 7 }, (_, i) => pngFile(`p${i + 1}.png`))
    );

    let batch = 0;
    fetchImpl = async () => {
      batch += 1;
      return jsonResponse({
        pages: Array.from({ length: batch === 1 ? ANALYZE_BATCH_SIZE : 2 }, (_, i) => ({
          description: `Кадр ${batch}.${i + 1}`,
          transcript: "Speaker 1: текст",
        })),
      });
    };

    await act(async () => {
      fireEvent.click(screen.getByTestId("manga-analyze"));
    });
    await waitFor(() => expect(screen.getByText("Кадр 2.2")).toBeTruthy());

    const analyzeCalls = calls.filter((c) => c.url.endsWith("/manga-analyze"));
    expect(analyzeCalls).toHaveLength(2);
    expect(analyzeCalls[0].body.images).toHaveLength(ANALYZE_BATCH_SIZE);
    expect(analyzeCalls[1].body.images).toHaveLength(2);

    expect(screen.getByText("Кадр 1.1")).toBeTruthy();
    expect(screen.getByTestId("manga-analyze").textContent).toContain("Все страницы обработаны");
  });

  it("«Стоп» прерывает анализ: запрос отменён, страницы снова готовы к отправке", async () => {
    open();
    setInputFiles(screen.getByTestId("manga-file-input"), [pngFile("p1.png")]);

    let signal: AbortSignal | undefined;
    fetchImpl = async (_url, init) => {
      signal = init.signal ?? undefined;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
    };

    fireEvent.click(screen.getByTestId("manga-analyze"));
    await waitFor(() => expect(screen.getByTestId("manga-stop")).toBeTruthy());
    // Ждём сам запрос: кнопка «Стоп» появляется раньше, чем страница сжата и отправлена.
    await waitFor(() => expect(signal).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByTestId("manga-stop"));
    });

    expect(signal?.aborted).toBe(true);
    // Отмена — не ошибка: ни плашки, ни toast, страница снова в очереди.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByTestId("manga-stop")).toBeNull();
    expect(screen.getByTestId("manga-analyze").hasAttribute("disabled")).toBe(false);
    expect(screen.getByTestId("manga-analyze").textContent).toContain("1–1");
  });

  it("упавший батч не мешает отправить страницы снова", async () => {
    open();
    setInputFiles(screen.getByTestId("manga-file-input"), [pngFile("p1.png")]);

    let attempt = 0;
    fetchImpl = async () => {
      attempt += 1;
      return attempt === 1
        ? jsonResponse({ error: "Сервис анализа недоступен" }, 502)
        : jsonResponse({ pages: [{ description: "Со второго раза", transcript: "Speaker 1: да" }] });
    };

    await act(async () => {
      fireEvent.click(screen.getByTestId("manga-analyze"));
    });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Сервис анализа недоступен"));

    await act(async () => {
      fireEvent.click(screen.getByTestId("manga-analyze"));
    });
    await waitFor(() => expect(screen.getByText("Со второго раза")).toBeTruthy());
    expect(calls.filter((c) => c.url.endsWith("/manga-analyze"))).toHaveLength(2);
  });

  it("ошибка анализа показывается текстом сервера, страницы остаются доступными", async () => {
    open();
    setInputFiles(screen.getByTestId("manga-file-input"), [pngFile("p1.png")]);
    fetchImpl = async () => jsonResponse({ error: "AI не настроен" }, 500);

    await act(async () => {
      fireEvent.click(screen.getByTestId("manga-analyze"));
    });

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("AI не настроен"));
    expect(screen.getByTestId("manga-analyze").hasAttribute("disabled")).toBe(false);
  });

  it("не падает, если модель вернула меньше страниц, чем просили", async () => {
    open();
    setInputFiles(screen.getByTestId("manga-file-input"), [pngFile("p1.png"), pngFile("p2.png")]);
    fetchImpl = async () => jsonResponse({ pages: [{ description: "Только первая", transcript: "Speaker 1: раз" }] });

    await act(async () => {
      fireEvent.click(screen.getByTestId("manga-analyze"));
    });

    await waitFor(() => expect(screen.getByText("Только первая")).toBeTruthy());
    expect(screen.queryByTestId("manga-transcript-2")).toBeNull();
  });
});

describe("MangaVoiceModal: озвучка", () => {
  async function withAnalyzedPage(transcript = "Speaker 1: Привет\nSpeaker 2: Пока") {
    open();
    setInputFiles(screen.getByTestId("manga-file-input"), [pngFile("p1.png")]);
    fetchImpl = async (url) =>
      url.endsWith("/manga-analyze")
        ? jsonResponse({ pages: [{ description: "Кадр", transcript }] })
        : audioResponse();
    await act(async () => {
      fireEvent.click(screen.getByTestId("manga-analyze"));
    });
    await waitFor(() => expect(screen.getByTestId("manga-speak-1")).toBeTruthy());
  }

  it("нормализует реплики в формат dialog-tts и передаёт голоса", async () => {
    await withAnalyzedPage("Рассказчик: Токио\nАки: Ты опоздал");

    await act(async () => {
      fireEvent.click(screen.getByTestId("manga-speak-1"));
    });

    const tts = calls.find((c) => c.url.endsWith("/dialog-tts"));
    expect(tts?.body.transcript).toBe("Speaker 1: Токио\nSpeaker 2: Ты опоздал");
    expect(tts?.body.voices["1"]).toBeTruthy();
    expect(tts?.body.voices["2"]).toBeTruthy();
  });

  it("после озвучки появляется плеер с автозапуском только для свежей записи", async () => {
    await withAnalyzedPage();

    await act(async () => {
      fireEvent.click(screen.getByTestId("manga-speak-1"));
    });

    await waitFor(() => expect(document.querySelector("audio")).toBeTruthy());
    const audio = document.querySelector("audio")!;
    expect(audio.hasAttribute("autoplay")).toBe(true);
    expect(audio.getAttribute("src")).toMatch(/^blob:mock-/);
    expect(screen.getByTestId("manga-speak-1").textContent).toContain("Переозвучить");
  });

  it("переозвучка отзывает прежний object URL", async () => {
    await withAnalyzedPage();

    await act(async () => {
      fireEvent.click(screen.getByTestId("manga-speak-1"));
    });
    const first = document.querySelector("audio")!.getAttribute("src")!;

    await act(async () => {
      fireEvent.click(screen.getByTestId("manga-speak-1"));
    });
    await waitFor(() => expect(revoked).toContain(first));

    const second = document.querySelector("audio")!.getAttribute("src")!;
    expect(second).not.toBe(first);
  });

  it("при повторном открытии записи не стартуют сами", async () => {
    const { unmount } = render(<MangaVoiceModal open onClose={vi.fn()} />);
    setInputFiles(screen.getByTestId("manga-file-input"), [pngFile("p1.png")]);
    fetchImpl = async (url) =>
      url.endsWith("/manga-analyze")
        ? jsonResponse({ pages: [{ description: "Кадр", transcript: "Speaker 1: Привет" }] })
        : audioResponse();

    await act(async () => {
      fireEvent.click(screen.getByTestId("manga-analyze"));
    });
    await waitFor(() => expect(screen.getByTestId("manga-speak-1")).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByTestId("manga-speak-1"));
    });
    await waitFor(() => expect(document.querySelector("audio")).toBeTruthy());
    expect(document.querySelector("audio")!.hasAttribute("autoplay")).toBe(true);

    unmount();
    render(<MangaVoiceModal open onClose={vi.fn()} />);
    // Новое окно — чистый стейт, озвученных страниц нет: автозапускаться нечему.
    expect(document.querySelector("audio")).toBeNull();
  });

  it("ошибка озвучки показывается пользователю", async () => {
    await withAnalyzedPage();
    fetchImpl = async (url) =>
      url.endsWith("/dialog-tts") ? jsonResponse({ error: "Слишком много запросов, попробуйте чуть позже." }, 429) : jsonResponse({});

    await act(async () => {
      fireEvent.click(screen.getByTestId("manga-speak-1"));
    });

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Слишком много запросов"));
  });

  it("пустые реплики не уходят на сервер", async () => {
    await withAnalyzedPage();
    fireEvent.change(screen.getByTestId("manga-transcript-1"), { target: { value: "   " } });

    expect(screen.getByTestId("manga-speak-1").hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/Нет реплик для озвучки/)).toBeTruthy();
    expect(calls.filter((c) => c.url.endsWith("/dialog-tts"))).toHaveLength(0);
  });

  it("слишком много персонажей — понятная подсказка вместо 400 от сервера", async () => {
    await withAnalyzedPage(Array.from({ length: 9 }, (_, i) => `Имя${i + 1}: реплика`).join("\n"));

    expect(screen.getByText(/до 8 голосов/)).toBeTruthy();
    expect(screen.getByTestId("manga-speak-1").hasAttribute("disabled")).toBe(true);
  });

  it("выбранный голос уходит в следующем запросе", async () => {
    await withAnalyzedPage();

    fireEvent.change(screen.getByTestId("manga-voice-2"), { target: { value: "Fenrir" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("manga-speak-1"));
    });

    const tts = calls.find((c) => c.url.endsWith("/dialog-tts"));
    expect(tts?.body.voices["2"]).toBe("Fenrir");
  });

  it("«Озвучить всё» озвучивает страницы по очереди", async () => {
    open();
    setInputFiles(screen.getByTestId("manga-file-input"), [pngFile("p1.png"), pngFile("p2.png")]);
    fetchImpl = async (url) =>
      url.endsWith("/manga-analyze")
        ? jsonResponse({
            pages: [
              { description: "Кадр 1", transcript: "Speaker 1: раз" },
              { description: "Кадр 2", transcript: "Speaker 1: два" },
            ],
          })
        : audioResponse();

    await act(async () => {
      fireEvent.click(screen.getByTestId("manga-analyze"));
    });
    await waitFor(() => expect(screen.getByTestId("manga-speak-all")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByTestId("manga-speak-all"));
    });

    await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/dialog-tts"))).toHaveLength(2));
    expect(document.querySelectorAll("audio")).toHaveLength(2);
  });

  it("сбой одной страницы не останавливает «Озвучить всё», причина видна на кадре", async () => {
    open();
    setInputFiles(screen.getByTestId("manga-file-input"), [pngFile("p1.png"), pngFile("p2.png")]);
    fetchImpl = async (url) =>
      url.endsWith("/manga-analyze")
        ? jsonResponse({
            pages: [
              { description: "Кадр 1", transcript: "Speaker 1: раз" },
              { description: "Кадр 2", transcript: "Speaker 1: два" },
            ],
          })
        : audioResponse();

    await act(async () => {
      fireEvent.click(screen.getByTestId("manga-analyze"));
    });
    await waitFor(() => expect(screen.getByTestId("manga-speak-all")).toBeTruthy());

    let ttsCalls = 0;
    fetchImpl = async (url) => {
      if (!url.endsWith("/dialog-tts")) return jsonResponse({});
      ttsCalls += 1;
      return ttsCalls === 1
        ? jsonResponse({ error: "Слишком много запросов, попробуйте чуть позже." }, 429)
        : audioResponse();
    };

    await act(async () => {
      fireEvent.click(screen.getByTestId("manga-speak-all"));
    });

    await waitFor(() => expect(ttsCalls).toBe(2));
    // Вторая страница озвучена, первая помечена причиной отказа.
    expect(document.querySelectorAll("audio")).toHaveLength(1);
    expect(screen.getByTestId("manga-voice-error-1").textContent).toContain("Слишком много запросов");
    expect(screen.getByRole("alert").textContent).toContain("Не озвучена страница 1");
  });

  it("«Стоп» прерывает озвучку кадра без сообщения об ошибке", async () => {
    await withAnalyzedPage();

    let signal: AbortSignal | undefined;
    fetchImpl = async (url, init) => {
      if (!url.endsWith("/dialog-tts")) return jsonResponse({});
      signal = init.signal ?? undefined;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
    };

    fireEvent.click(screen.getByTestId("manga-speak-1"));
    await waitFor(() => expect(screen.getByTestId("manga-stop-1")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByTestId("manga-stop-1"));
    });

    expect(signal?.aborted).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByTestId("manga-stop-1")).toBeNull();
    expect(screen.getByTestId("manga-speak-1").hasAttribute("disabled")).toBe(false);
  });

  it("при закрытии окна страницы и озвучка сохраняются, но сами не стартуют", async () => {
    const onClose = vi.fn();
    const view = render(<MangaVoiceModal open onClose={onClose} />);
    setInputFiles(screen.getByTestId("manga-file-input"), [pngFile("p1.png")]);
    fetchImpl = async (url) =>
      url.endsWith("/manga-analyze")
        ? jsonResponse({ pages: [{ description: "Кадр", transcript: "Speaker 1: Привет" }] })
        : audioResponse();

    await act(async () => {
      fireEvent.click(screen.getByTestId("manga-analyze"));
    });
    await waitFor(() => expect(screen.getByTestId("manga-speak-1")).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByTestId("manga-speak-1"));
    });
    await waitFor(() => expect(document.querySelector("audio")).toBeTruthy());
    expect(document.querySelector("audio")!.hasAttribute("autoplay")).toBe(true);

    view.rerender(<MangaVoiceModal open={false} onClose={onClose} />);
    expect(screen.queryByTestId("manga-modal")).toBeNull();

    view.rerender(<MangaVoiceModal open onClose={onClose} />);
    // Результат работы на месте, автозапуска нет.
    expect(screen.getByTestId("manga-page-1")).toBeTruthy();
    expect(screen.getByTestId("manga-speak-1").textContent).toContain("Переозвучить");
    expect(document.querySelector("audio")!.hasAttribute("autoplay")).toBe(false);
  });
});
