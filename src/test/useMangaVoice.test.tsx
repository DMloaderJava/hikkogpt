import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { toast } from "sonner";
import { useMangaVoice, type VoicesMap } from "@/hooks/useMangaVoice";
import { ANALYZE_BATCH_SIZE, ANALYZE_PAYLOAD_BUDGET } from "@/lib/mangaPages";
import { EDGE_FUNCTIONS_URL, SUPABASE_FUNCTIONS_URL, withRequestTimeout } from "@/lib/edgeAuth";
import { DEFAULT_MANGA_API, MANGA_API_OPTIONS } from "@/lib/mangaApi";

/**
 * Метод запросов озвучивателя манги (`useMangaVoice`).
 *
 * Проверяется то же, что и в отправке сообщения: заголовки Authorization +
 * apikey, signal в каждом запросе, батчи не больше лимита сервера, отмена без
 * сообщения об ошибке, текст ошибки сервера в плашке и в toast, очередь
 * озвучки не рвётся на первой неудаче.
 */

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const hookSource = readFileSync(resolve(process.cwd(), "src/hooks/useMangaVoice.ts"), "utf8");
const modalSource = readFileSync(resolve(process.cwd(), "src/components/MangaVoiceModal.tsx"), "utf8");
const chatSource = readFileSync(resolve(process.cwd(), "src/hooks/useChat.ts"), "utf8");

/** Тело запроса: `images`+`model` у manga-analyze, `transcript`/`voices` у dialog-tts. */
interface RecordedBody {
  images?: string[];
  /** Имя api из переключателя — его мапит сервер (`toAiModel`). */
  model?: string;
  transcript?: string;
  voices?: VoicesMap;
}

interface RecordedCall {
  fn: string;
  url: string;
  init: RequestInit;
  body: RecordedBody;
}

const created: string[] = [];
const revoked: string[] = [];
const calls: RecordedCall[] = [];

let urlSeq = 0;
type Handler = (fn: string, body: RecordedBody, init: RequestInit) => Promise<unknown>;
let handler: Handler;

function pngFile(name: string) {
  return new File([`bytes-of-${name}`], name, { type: "image/png" });
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

/** Запрос, который висит до отмены сигнала — как долгая озвучка/анализ. */
const hangingResponse = (init: RequestInit) =>
  new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
  });

/** Ответ `manga-analyze` на n страниц. */
const analyzePagesResponse = (n: number, prefix = "Кадр") =>
  jsonResponse({
    pages: Array.from({ length: n }, (_, i) => ({
      description: `${prefix} ${i + 1}`,
      transcript: `Speaker 1: ${prefix.toLowerCase()} ${i + 1}`,
    })),
  });

beforeEach(() => {
  // Выбор api хранится в localStorage — каждый тест начинает с чистого листа.
  window.localStorage.clear();
  urlSeq = 0;
  created.length = 0;
  revoked.length = 0;
  calls.length = 0;
  vi.mocked(toast.error).mockClear();

  URL.createObjectURL = vi.fn(() => {
    urlSeq += 1;
    const url = `blob:mock-${urlSeq}`;
    created.push(url);
    return url;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn((url: string) => {
    revoked.push(url);
  });

  // jsdom не умеет createImageBitmap/canvas: даём лёгкий декодер, чтобы
  // toPageDataURL шла по пути «страница уже маленькая».
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 900, height: 1200, close() {} })));

  handler = async (fn) => (fn === "dialog-tts" ? audioResponse() : analyzePagesResponse(1));
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const fn = url.split("/").pop() ?? url;
    const rawBody = init?.body ? (JSON.parse(String(init.body)) as RecordedBody) : {};
    calls.push({ fn, url, init: init ?? {}, body: rawBody });
    return handler(fn, rawBody, init ?? {}) as never;
  }) as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup() {
  return renderHook(() => useMangaVoice());
}

/** Добавляет страницы и возвращает их id в порядке добавления. */
async function addPages(hook: ReturnType<typeof setup>, count: number) {
  await act(async () => {
    hook.result.current.addFiles(Array.from({ length: count }, (_, i) => pngFile(`p${i + 1}.png`)));
  });
  return hook.result.current.pages.map((p) => p.id);
}

/** Доводит страницы до `ready` реальным вызовом анализа. */
async function analyze(hook: ReturnType<typeof setup>, count: number) {
  const ids = await addPages(hook, count);
  await act(async () => {
    await hook.result.current.analyzePages();
  });
  return ids;
}

describe("useMangaVoice: запрос анализа", () => {
  it("шлёт manga-analyze с заголовками как при отправке сообщения", async () => {
    const hook = setup();
    await analyze(hook, 2);

    const call = calls.find((c) => c.fn === "manga-analyze");
    expect(call?.url).toBe(`${EDGE_FUNCTIONS_URL}/manga-analyze`);
    expect(call?.init.method).toBe("POST");
    const headers = call?.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Authorization).toMatch(/^Bearer /);
    expect(headers.apikey).toBe(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY);
    expect(call?.body.images).toHaveLength(2);
    expect(call?.body.images?.[0].startsWith("data:image/png;base64,")).toBe(true);
  });

  it("передаёт signal, чтобы запрос можно было прервать", async () => {
    const hook = setup();
    await analyze(hook, 1);
    expect(calls.find((c) => c.fn === "manga-analyze")?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("страницы сразу уходят в analyzing, а после ответа — в ready", async () => {
    const hook = setup();
    handler = async (fn, _body, init) => {
      // Ответ отдаём только после отмены: успеваем посмотреть промежуточное состояние.
      await Promise.race([
        new Promise((r) => setTimeout(r, 30)),
        new Promise((r) => init.signal?.addEventListener("abort", r)),
      ]);
      return analyzePagesResponse(2);
    };

    const ids = await addPages(hook, 2);
    let finished!: Promise<boolean>;
    act(() => {
      finished = hook.result.current.analyzePages();
    });

    await waitFor(() => expect(hook.result.current.isAnalyzing).toBe(true));
    expect(hook.result.current.pages.every((p) => p.status === "analyzing")).toBe(true);
    expect(ids).toHaveLength(2);

    await act(async () => {
      await finished;
    });
    expect(hook.result.current.isAnalyzing).toBe(false);
    expect(hook.result.current.pages.every((p) => p.status === "ready")).toBe(true);
    expect(hook.result.current.pages[0].transcript).toContain("Speaker 1:");
  });

  it("больше 5 страниц уходят несколькими батчами за один вызов", async () => {
    const hook = setup();
    handler = async (fn, body) =>
      fn === "manga-analyze" ? analyzePagesResponse(body.images?.length ?? 0) : audioResponse();

    await analyze(hook, 7);

    const analyzeCalls = calls.filter((c) => c.fn === "manga-analyze");
    expect(analyzeCalls).toHaveLength(2);
    expect(analyzeCalls[0].body.images).toHaveLength(ANALYZE_BATCH_SIZE);
    expect(analyzeCalls[1].body.images).toHaveLength(2);
    expect(hook.result.current.pages.filter((p) => p.status === "ready")).toHaveLength(7);
  });

  it("stop() прерывает запрос, и это не считается ошибкой", async () => {
    const hook = setup();
    handler = async (_fn, _body, init) => hangingResponse(init);

    await addPages(hook, 1);
    let finished!: Promise<boolean>;
    act(() => {
      finished = hook.result.current.analyzePages();
    });
    await waitFor(() => expect(calls.some((c) => c.fn === "manga-analyze")).toBe(true));

    act(() => hook.result.current.stop());
    await act(async () => {
      expect(await finished).toBe(false);
    });

    const signal = calls.find((c) => c.fn === "manga-analyze")?.init.signal as AbortSignal;
    expect(signal.aborted).toBe(true);
    expect(hook.result.current.isAnalyzing).toBe(false);
    expect(hook.result.current.error).toBe("");
    expect(toast.error).not.toHaveBeenCalled();
    // Страница вернулась в очередь — её можно отправить снова.
    expect(hook.result.current.pages[0].status).toBe("new");
  });

  it("текст ошибки сервера доезжает до плашки и до toast", async () => {
    const hook = setup();
    handler = async () => jsonResponse({ error: "AI не настроен" }, 500);

    await analyze(hook, 1);

    expect(hook.result.current.error).toBe("Ошибка запроса api (ответ api анализа манги: AI не настроен)");
    expect(hook.result.current.failure?.stage).toBe("analyze-api");
    expect(hook.result.current.failure?.status).toBe(500);
    expect(hook.result.current.pages[0].status).toBe("new");
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("AI не настроен"));
  });

  it("сетевой сбой без тела ответа показывает код", async () => {
    const hook = setup();
    handler = async () => ({ ok: false, status: 502, json: async () => { throw new Error("no body"); }, text: async () => "" });

    await analyze(hook, 1);

    expect(hook.result.current.error).toContain("Ошибка 502");
    expect(hook.result.current.error).toContain("ответ api анализа манги");
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("Ошибка 502"));
  });

  it("тело каждого запроса не превышает бюджет payload", async () => {
    const hook = setup();
    handler = async (fn, body) =>
      fn === "manga-analyze" ? analyzePagesResponse(body.images?.length ?? 0) : audioResponse();

    await analyze(hook, 7);

    const analyzeCalls = calls.filter((c) => c.fn === "manga-analyze");
    expect(analyzeCalls.length).toBeGreaterThan(0);
    for (const call of analyzeCalls) {
      const json = JSON.stringify({ images: call.body.images });
      expect(call.body.images!.length).toBeLessThanOrEqual(ANALYZE_BATCH_SIZE);
      // +2 — кавычки вокруг всего тела запроса.
      expect(json.length + 2).toBeLessThanOrEqual(ANALYZE_PAYLOAD_BUDGET);
    }
  });

  it("«Failed to fetch» превращается в понятную причину, а не в текст из браузера", async () => {
    const hook = setup();
    handler = async () => {
      throw new TypeError("Failed to fetch");
    };

    await analyze(hook, 1);

    expect(hook.result.current.error).toContain("Ошибка запроса api (отправка запроса:");
    expect(hook.result.current.error).not.toContain("Failed to fetch");
    expect(hook.result.current.failure?.stage).toBe("send-request");
    expect(hook.result.current.pages[0].status).toBe("new");
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("не дошёл до сервера"));
  });

  it("упавший батч не отменяет уже разобранные страницы", async () => {
    const hook = setup();
    let batch = 0;
    handler = async (fn, body) => {
      if (fn !== "manga-analyze") return audioResponse();
      batch += 1;
      return batch === 1
        ? analyzePagesResponse(body.images?.length ?? 0)
        : jsonResponse({ error: "Сервис анализа недоступен" }, 502);
    };

    const ok = await (async () => {
      await addPages(hook, 7);
      let result!: boolean;
      await act(async () => {
        result = await hook.result.current.analyzePages();
      });
      return result;
    })();

    expect(ok).toBe(false);
    expect(hook.result.current.pages.filter((p) => p.status === "ready")).toHaveLength(ANALYZE_BATCH_SIZE);
    expect(hook.result.current.pages.filter((p) => p.status === "new")).toHaveLength(2);
    expect(hook.result.current.error).toContain("батч 2 из 2");
    expect(hook.result.current.error).toContain("Сервис анализа недоступен");
  });
});

describe("useMangaVoice: озвучка кадра", () => {
  it("нормализует реплики и отправляет выбранную карту голосов", async () => {
    const hook = setup();
    handler = async (fn, body) =>
      fn === "manga-analyze"
        ? jsonResponse({ pages: [{ description: "Кадр", transcript: "Рассказчик: Токио\nАки: Ты опоздал" }] })
        : audioResponse();

    const [id] = await analyze(hook, 1);
    let ok!: boolean;
    await act(async () => {
      ok = await hook.result.current.speakPage(id);
    });

    const tts = calls.find((c) => c.fn === "dialog-tts");
    expect(ok).toBe(true);
    // Ответ модели приведён к формату из промпта: только реплики, через пустую строку.
    // Номера персонажей выдаёт planTranscript — в запросе уже «Speaker N».
    expect(hook.result.current.pages[0].transcript).toBe("Рассказчик: Токио\n\nАки: Ты опоздал");
    expect(tts?.body.transcript).toBe("Speaker 1: Токио\nSpeaker 2: Ты опоздал");
    expect(tts?.body.voices["1"]).toBeTruthy();
    expect(tts?.body.voices["2"]).toBeTruthy();
    expect(tts?.init.signal).toBeInstanceOf(AbortSignal);
    expect(hook.result.current.pages[0].audio).toMatch(/^blob:mock-/);
    expect(hook.result.current.autoPlayKey).toBe(`${id}:${hook.result.current.pages[0].audio}`);
  });

  it("переозвучка отзывает прежний object URL", async () => {
    const hook = setup();
    const [id] = await analyze(hook, 1);

    await act(async () => {
      await hook.result.current.speakPage(id);
    });
    const first = hook.result.current.pages[0].audio!;

    await act(async () => {
      await hook.result.current.speakPage(id);
    });
    const second = hook.result.current.pages[0].audio!;

    expect(second).not.toBe(first);
    expect(revoked).toContain(first);
  });

  it("реплики, которые не примет dialog-tts, не уходят на сервер", async () => {
    const hook = setup();
    const [id] = await analyze(hook, 1);

    act(() => hook.result.current.setTranscript(id, "   "));
    let ok!: boolean;
    await act(async () => {
      ok = await hook.result.current.speakPage(id);
    });

    expect(ok).toBe(false);
    expect(calls.filter((c) => c.fn === "dialog-tts")).toHaveLength(0);
    expect(hook.result.current.error).toContain("проверка реплик перед озвучкой");
    expect(hook.result.current.error).toContain("Нет реплик для озвучки");
    expect(hook.result.current.failure?.stage).toBe("dialog-check");
    expect(toast.error).toHaveBeenCalled(); // причину видно и если окно закрыто
  });

  it("stop() прерывает озвучку без ошибки", async () => {
    const hook = setup();
    const [id] = await analyze(hook, 1);
    handler = async (fn, _body, init) => (fn === "dialog-tts" ? hangingResponse(init) : jsonResponse({}));

    let finished!: Promise<boolean>;
    act(() => {
      finished = hook.result.current.speakPage(id);
    });
    await waitFor(() => expect(calls.some((c) => c.fn === "dialog-tts")).toBe(true));
    expect(hook.result.current.speakingId).toBe(id);

    act(() => hook.result.current.stop());
    await act(async () => {
      expect(await finished).toBe(false);
    });

    expect((calls.find((c) => c.fn === "dialog-tts")?.init.signal as AbortSignal).aborted).toBe(true);
    expect(hook.result.current.speakingId).toBeNull();
    expect(hook.result.current.error).toBe("");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("ошибка озвучки помечает страницу и показывает причину", async () => {
    const hook = setup();
    const [id] = await analyze(hook, 1);
    handler = async (fn) =>
      fn === "dialog-tts" ? jsonResponse({ error: "Недостаточно средств Lovable AI." }, 402) : jsonResponse({});

    let ok!: boolean;
    await act(async () => {
      ok = await hook.result.current.speakPage(id);
    });

    expect(ok).toBe(false);
    expect(hook.result.current.pages[0].voiceError).toBe("ответ api озвучки: Недостаточно средств Lovable AI.");
    expect(hook.result.current.error).toBe("Ошибка запроса api (ответ api озвучки: Недостаточно средств Lovable AI.)");
    expect(hook.result.current.failure?.stage).toBe("tts-api");
    expect(hook.result.current.failure?.status).toBe(402);
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("Недостаточно средств Lovable AI."));
  });

  it("выбранный голос уходит в следующем запросе", async () => {
    const hook = setup();
    handler = async (fn) =>
      fn === "manga-analyze"
        ? jsonResponse({ pages: [{ description: "Кадр", transcript: "Аки: раз\nРэй: два" }] })
        : audioResponse();
    const [id] = await analyze(hook, 1);

    act(() => hook.result.current.setVoice(2, "Fenrir"));
    await act(async () => {
      await hook.result.current.speakPage(id);
    });

    const voices = calls.find((c) => c.fn === "dialog-tts")?.body.voices;
    expect(voices["2"]).toBe("Fenrir");
  });
});

describe("useMangaVoice: формат реплик из ответа модели", () => {
  it("описание сцены и служебный текст не попадают в диалог", async () => {
    const hook = setup();
    handler = async (fn) =>
      fn === "manga-analyze"
        ? jsonResponse({
            pages: [
              {
                description: "Аки стоит у ворот академии, Денджи опаздывает.",
                transcript: [
                  "```",
                  "Описание: сцена у ворот.",
                  "Speaker 1: Ребята, начинаем?",
                  "",
                  "Speaker 2: Я сказала тебе прекратить!",
                  "Примечание: кадр 3",
                  "```",
                ].join("\n"),
              },
            ],
          })
        : audioResponse();

    await analyze(hook, 1);

    expect(hook.result.current.pages[0].transcript).toBe(
      "Speaker 1: Ребята, начинаем?\n\nSpeaker 2: Я сказала тебе прекратить!"
    );
    expect(hook.result.current.pages[0].description).toContain("Аки стоит у ворот"); // храним, но не показываем
  });

  it("имена персонажей получают номера, если модель забыла Speaker N", async () => {
    const hook = setup();
    handler = async (fn) =>
      fn === "manga-analyze"
        ? jsonResponse({ pages: [{ description: "Кадр", transcript: "Аки: Ты опоздал\nРассказчик: Он всегда опаздывал." }] })
        : audioResponse();

    await analyze(hook, 1);
    expect(hook.result.current.pages[0].transcript).toBe("Аки: Ты опоздал\n\nРассказчик: Он всегда опаздывал.");

    await act(async () => {
      await hook.result.current.speakPage(hook.result.current.pages[0].id);
    });
    expect(calls.find((c) => c.fn === "dialog-tts")?.body.transcript).toBe(
      "Speaker 1: Ты опоздал\nSpeaker 2: Он всегда опаздывал."
    );
  });
});

describe("useMangaVoice: озвучить всё", () => {
  async function threeReadyPages(hook: ReturnType<typeof setup>) {
    handler = async (fn, body) =>
      fn === "manga-analyze"
        ? jsonResponse({
            pages: Array.from({ length: body.images?.length ?? 0 }, (_, i) => ({
              description: `Кадр ${i + 1}`,
              transcript: `Speaker 1: реплика ${i + 1}`,
            })),
          })
        : audioResponse();
    return analyze(hook, 3);
  }

  it("озвучивает страницы по очереди одним вызовом", async () => {
    const hook = setup();
    await threeReadyPages(hook);

    let ok!: boolean;
    await act(async () => {
      ok = await hook.result.current.speakAll();
    });

    expect(ok).toBe(true);
    expect(calls.filter((c) => c.fn === "dialog-tts")).toHaveLength(3);
    expect(hook.result.current.pages.every((p) => !!p.audio)).toBe(true);
    expect(hook.result.current.speakingId).toBeNull();
  });

  it("сбой страницы не останавливает очередь, итог показывает причину", async () => {
    const hook = setup();
    await threeReadyPages(hook);

    let tts = 0;
    handler = async (fn) => {
      if (fn !== "dialog-tts") return jsonResponse({});
      tts += 1;
      return tts === 2 ? jsonResponse({ error: "Слишком много запросов, попробуйте чуть позже." }, 429) : audioResponse();
    };

    let ok!: boolean;
    await act(async () => {
      ok = await hook.result.current.speakAll();
    });

    expect(ok).toBe(false);
    expect(tts).toBe(3); // очередь дошла до конца
    expect(hook.result.current.pages[1].voiceError).toContain("Слишком много запросов");
    expect(hook.result.current.pages[1].voiceError).toContain("ответ api озвучки");
    expect(hook.result.current.pages[0].audio).toBeTruthy();
    expect(hook.result.current.pages[2].audio).toBeTruthy();
    expect(hook.result.current.error).toBe(
      "Ошибка запроса api (ответ api озвучки: страница 2 — Слишком много запросов, попробуйте чуть позже.)"
    );
  });

  it("страницы без реплик помечаются и не уходят на сервер", async () => {
    const hook = setup();
    await threeReadyPages(hook);
    act(() => hook.result.current.setTranscript(hook.result.current.pages[1].id, "   "));

    let ok!: boolean;
    await act(async () => {
      ok = await hook.result.current.speakAll();
    });

    expect(ok).toBe(false);
    expect(calls.filter((c) => c.fn === "dialog-tts")).toHaveLength(2);
    expect(hook.result.current.pages[1].voiceError).toContain("Нет реплик для озвучки");
    expect(hook.result.current.error).toContain("страница 2");
    expect(hook.result.current.error).toContain("проверка реплик перед озвучкой");
    expect(hook.result.current.failure?.stage).toBe("dialog-check");
  });

  it("stop() обрывает очередь: оставшиеся страницы не озвучиваются", async () => {
    const hook = setup();
    await threeReadyPages(hook);

    let tts = 0;
    handler = async (fn, _body, init) => {
      if (fn !== "dialog-tts") return jsonResponse({});
      tts += 1;
      if (tts === 2) return hangingResponse(init);
      return audioResponse();
    };

    let finished!: Promise<boolean>;
    act(() => {
      finished = hook.result.current.speakAll();
    });
    await waitFor(() => expect(tts).toBe(2));

    act(() => hook.result.current.stop());
    await act(async () => {
      expect(await finished).toBe(false);
    });

    expect(tts).toBe(2);
    expect(hook.result.current.pages[0].audio).toBeTruthy();
    expect(hook.result.current.pages[2].audio).toBeUndefined();
    expect(hook.result.current.error).toBe("");
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe("useMangaVoice: уборка", () => {
  it("размонтирование гасит незакрытый запрос", async () => {
    const hook = setup();
    handler = async (_fn, _body, init) => hangingResponse(init);
    await addPages(hook, 1);

    act(() => {
      void hook.result.current.analyzePages();
    });
    await waitFor(() => expect(calls.some((c) => c.fn === "manga-analyze")).toBe(true));

    hook.unmount();
    expect((calls[0].init.signal as AbortSignal).aborted).toBe(true);
  });

  it("reset() отзывает object URL страниц и их озвучки", async () => {
    const hook = setup();
    const [id] = await analyze(hook, 1);
    await act(async () => {
      await hook.result.current.speakPage(id);
    });
    const preview = hook.result.current.pages[0].url;
    const audio = hook.result.current.pages[0].audio!;

    act(() => hook.result.current.reset());

    expect(hook.result.current.pages).toHaveLength(0);
    expect(revoked).toContain(preview);
    expect(revoked).toContain(audio);
  });

  it("removePage отзывает превью и озвучку страницы", async () => {
    const hook = setup();
    const [id] = await analyze(hook, 1);
    await act(async () => {
      await hook.result.current.speakPage(id);
    });
    const audio = hook.result.current.pages[0].audio!;

    act(() => hook.result.current.removePage(id));

    expect(hook.result.current.pages).toHaveLength(0);
    expect(revoked).toContain(audio);
  });
});

describe("useMangaVoice: смена api анализа", () => {
  it("по умолчанию шлёт api из списка переключателя", async () => {
    const hook = setup();
    expect(hook.result.current.apiModel).toBe(DEFAULT_MANGA_API);

    await analyze(hook, 1);
    const model = calls.find((c) => c.fn === "manga-analyze")?.body.model;
    expect(model).toBe(DEFAULT_MANGA_API);
    expect(MANGA_API_OPTIONS.map((o) => o.id)).toContain(model);
  });

  it("выбранное api уходит в следующем запросе и запоминается", async () => {
    const hook = setup();
    await addPages(hook, 1);

    act(() => {
      hook.result.current.setApiModel("HikkoGPT");
    });
    expect(hook.result.current.apiModel).toBe("HikkoGPT");

    await act(async () => {
      await hook.result.current.analyzePages();
    });
    expect(calls.find((c) => c.fn === "manga-analyze")?.body.model).toBe("HikkoGPT");
    expect(window.localStorage.getItem("hikkogpt.manga.api")).toBe("HikkoGPT");
  });

  it("имя не из списка на сервер не уходит", async () => {
    const hook = setup();
    act(() => {
      hook.result.current.setApiModel("gpt-5-mini");
      hook.result.current.setApiModel("");
    });
    expect(hook.result.current.apiModel).toBe(DEFAULT_MANGA_API);

    await analyze(hook, 1);
    expect(MANGA_API_OPTIONS.map((o) => o.id)).toContain(
      calls.find((c) => c.fn === "manga-analyze")?.body.model
    );
  });

  it("модель чата становится api, пока своего выбора нет", () => {
    const hook = renderHook(({ preferredApi }: { preferredApi?: string }) => useMangaVoice({ preferredApi }), {
      initialProps: { preferredApi: "HikkoGPT Turbo" },
    });
    expect(hook.result.current.apiModel).toBe("HikkoGPT Turbo");

    // Модель переключили в чате — окно манги следует за ней.
    hook.rerender({ preferredApi: "Спорящий" });
    expect(hook.result.current.apiModel).toBe("Спорящий");

    // Чужое имя (персонаж, опечатка) api анализа не ломает.
    hook.rerender({ preferredApi: "Илон Маск" });
    expect(hook.result.current.apiModel).toBe("Спорящий");
  });

  it("свой выбор важнее модели чата и переживает переоткрытие окна", () => {
    const hook = renderHook(({ preferredApi }: { preferredApi?: string }) => useMangaVoice({ preferredApi }), {
      initialProps: { preferredApi: "HikkoGPT Turbo" },
    });
    act(() => {
      hook.result.current.setApiModel("HikkoGPT");
    });
    hook.rerender({ preferredApi: "Спорящий" });
    expect(hook.result.current.apiModel).toBe("HikkoGPT");

    hook.unmount();
    const next = renderHook(() => useMangaVoice({ preferredApi: "Спорящий" }));
    expect(next.result.current.apiModel).toBe("HikkoGPT");
  });

  it("смена api посреди запуска не смешивает батчи: весь запуск на одной модели", async () => {
    const hook = setup();
    await addPages(hook, ANALYZE_BATCH_SIZE + 1); // два батча

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    handler = async (fn, body) => {
      await gate;
      return fn === "dialog-tts" ? audioResponse() : analyzePagesResponse(body.images?.length ?? 0);
    };

    let finished!: Promise<boolean>;
    act(() => {
      finished = hook.result.current.analyzePages();
    });
    // Пользователь переключил api, пока запрос в пути.
    await act(async () => {
      hook.result.current.setApiModel("HikkoGPT");
    });
    await act(async () => {
      release();
      await finished;
    });

    const analyzeCalls = calls.filter((c) => c.fn === "manga-analyze");
    expect(analyzeCalls).toHaveLength(2);
    expect(analyzeCalls.every((c) => c.body.model === DEFAULT_MANGA_API)).toBe(true);
    expect(hook.result.current.apiModel).toBe("HikkoGPT");

    // Следующий запуск — уже на новом api.
    await act(async () => {
      hook.result.current.reset();
    });
    calls.length = 0;
    await analyze(hook, 1);
    expect(calls.find((c) => c.fn === "manga-analyze")?.body.model).toBe("HikkoGPT");
  });

  it("процесс показывает, какое api разбирает страницы", async () => {
    const hook = setup();
    handler = async (_fn, _body, init) => hangingResponse(init);
    await addPages(hook, 2);

    let finished!: Promise<boolean>;
    act(() => {
      finished = hook.result.current.analyzePages();
    });
    await waitFor(() => expect(hook.result.current.analyzeProgress?.model).toBe(DEFAULT_MANGA_API));
    await act(async () => {
      hook.result.current.stop();
      await finished;
    });
  });

  it("страж: api уходит полем model, а не хардкодом в теле запроса", () => {
    expect(hookSource).toContain("const model = apiModelRef.current");
    expect(hookSource).toContain("{ images: batch.images, model, ...aiRequestFields() }");
    // Модель берётся один раз на запуск — батчи не разъезжаются по разным api.
    expect(hookSource).not.toMatch(/images: batch\.images\s*\}/);
  });
});

describe("стражи: метод тот же, что при отправке сообщения", () => {
  it("модалка работает через useMangaVoice и не собирает fetch сама", () => {
    expect(modalSource).toMatch(/useMangaVoice\(\{/);
    expect(modalSource).not.toMatch(/\bfetch\(/);
    expect(modalSource).not.toContain("getEdgeAuthHeaders");
  });

  it("модалка передаёт в хук api и показывает переключатель", () => {
    // Модель чата — api по умолчанию, свой выбор окна манги важнее.
    expect(modalSource).toContain("useMangaVoice({ preferredApi: chatModel })");
    expect(modalSource).toContain("<MangaApiSelector");
    expect(modalSource).toContain("onChange={setApiModel}");
    // Пока запрос идёт, api не переключается: батч должен пройти на одной модели.
    expect(modalSource).toMatch(/disabled=\{isRequesting\}/);
  });

  it("в модалке есть остановка запросов", () => {
    expect(modalSource).toContain('data-testid="manga-stop"');
    expect(modalSource).toMatch(/onClick=\{stop\}/);
  });

  it("хук называет этап сбоя, а не показывает «Failed to fetch»", () => {
    expect(hookSource).toContain("classifyEdgeFailure");
    expect(hookSource).toContain("classifyPrepareFailure");
    expect(hookSource).toContain("dialogCheckFailure");
    expect(hookSource).toContain("normalizeModelTranscript");
    expect(hookSource).toContain('setPhase("voicing")');
  });

  it("хук передаёт signal и показывает причину отказа так же, как чат", () => {
    expect(hookSource).toContain("edgeJson");
    expect(hookSource).toContain("edgeBlob");
    expect(hookSource).toContain("controller.signal");
    expect(hookSource).toContain("isAbortError");
    expect(hookSource).toContain("toast.error");
    expect(hookSource).toContain('MANGA_ANALYZE_FN = "manga-analyze"');
    expect(hookSource).toContain('DIALOG_TTS_FN = "dialog-tts"');
  });

  it("отправка сообщения использует тот же слой запросов", () => {
    expect(chatSource).toContain("edgeRequest(CHAT_FN");
    expect(chatSource).toContain("isAbortError(e, controller.signal)");
    expect(chatSource).not.toMatch(/fetch\(CHAT_URL/);
  });
});
