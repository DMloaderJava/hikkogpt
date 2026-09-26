import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  EDGE_FUNCTIONS_URL,
  EDGE_TIMEOUT_MS,
  EdgeRequestError,
  NETWORK_ERROR_MESSAGE,
  TIMEOUT_ERROR_MESSAGE,
  edgeBlob,
  edgeJson,
  edgeRequest,
  isAbortError,
  withRequestTimeout,
  type SignalLinkage,
} from "@/lib/edgeAuth";

/**
 * Слой запросов к edge-функциям: то, из-за чего «Failed to fetch» перестаёт
 * быть диагнозом. Проверяются заголовки (как при отправке сообщения), таймаут,
 * единственный повтор на сетевой сбой, отсутствие повтора на отмену и на
 * прикладную ошибку сервера.
 */

interface Attempt {
  url: string;
  init: RequestInit;
}

const attempts: Attempt[] = [];
let respond: (attempt: number, url: string, init: RequestInit) => Promise<unknown>;

const jsonResponse = (data: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => data,
  text: async () => JSON.stringify(data),
});

const audioResponse = () => ({
  ok: true,
  status: 200,
  blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" }),
});

/** Запрос, который висит до отмены сигнала. */
const hanging = (init: RequestInit) =>
  new Promise((_resolve, reject) => {
    if (init.signal?.aborted) reject(new DOMException("Aborted", "AbortError"));
    init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
  });

/** Таймер, который можно «прокрутить» вручную. */
function manualTimeoutLinkage() {
  const timers = new Map<number, () => void>();
  let seq = 0;
  const linkage: SignalLinkage = {
    setTimeoutFn: (fn) => {
      seq += 1;
      timers.set(seq, fn);
      return seq;
    },
    clearTimeoutFn: (handle) => {
      timers.delete(Number(handle));
    },
  };
  return {
    linkage,
    /** Сколько таймеров сейчас живо (не снято). */
    active: () => timers.size,
    fireAll: () => {
      [...timers.values()].forEach((fn) => fn());
      timers.clear();
    },
  };
}

beforeEach(() => {
  attempts.length = 0;
  respond = async () => jsonResponse({ ok: true });
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    attempts.push({ url, init: init ?? {} });
    return respond(attempts.length, url, init ?? {}) as never;
  }) as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("edgeRequest: форма запроса", () => {
  it("в dev идёт на свой origin — через прокси Vite", () => {
    expect(EDGE_FUNCTIONS_URL).toBe("/functions/v1");
    expect(import.meta.env.DEV).toBe(true);
  });

  it("шлёт POST с Authorization, apikey и JSON-телом", async () => {
    await edgeRequest("manga-analyze", { body: { images: ["data:image/png;base64,AA"] } });

    const { url, init } = attempts[0];
    const headers = init.headers as Record<string, string>;
    expect(url).toBe("/functions/v1/manga-analyze");
    expect(init.method).toBe("POST");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Authorization).toMatch(/^Bearer /);
    expect(headers.apikey).toBe(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY);
    expect(JSON.parse(String(init.body))).toEqual({ images: ["data:image/png;base64,AA"] });
  });

  it("каждый запрос уходит со своим AbortSignal (таймаут + остановка)", async () => {
    const external = new AbortController();
    await edgeRequest("chat", { body: { messages: [] }, signal: external.signal });

    const signal = attempts[0].init.signal as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal).not.toBe(external.signal); // внутренний контроллер объединяет таймаут и «Стоп»

    external.abort();
    expect(signal.aborted).toBe(true);
  });

  it("edgeJson и edgeBlob разбирают ответ своего типа", async () => {
    respond = async (_n, url) => (url.endsWith("dialog-tts") ? audioResponse() : jsonResponse({ pages: [] }));

    await expect(edgeJson<{ pages?: unknown[] }>("manga-analyze", {})).resolves.toEqual({ pages: [] });
    const blob = await edgeBlob("dialog-tts", {});
    expect(blob.type).toBe("audio/wav");
  });
});

describe("edgeRequest: таймаут", () => {
  it("снимает таймер, как только получен ответ", async () => {
    const clock = manualTimeoutLinkage();
    await edgeRequest("chat", { body: {}, linkage: clock.linkage });
    expect(clock.active()).toBe(0);
  });

  it("по таймауту сообщает «сервер не ответил вовремя», а не «Failed to fetch»", async () => {
    const clock = manualTimeoutLinkage();
    respond = async (_n, _url, init) => hanging(init);

    const promise = edgeRequest("manga-analyze", { body: {}, linkage: clock.linkage, retryDelayMs: 0 });
    await vi.waitFor(() => expect(attempts.length).toBe(1));
    clock.fireAll(); // первый запрос «отвис» таймаутом
    await vi.waitFor(() => expect(attempts.length).toBe(2)); // таймаут — тоже повод для повтора
    clock.fireAll();

    await expect(promise).rejects.toMatchObject({
      name: "EdgeRequestError",
      message: TIMEOUT_ERROR_MESSAGE,
      timedOut: true,
      network: false,
    });
    expect(attempts).toHaveLength(2);
  });

  it("таймаут по умолчанию больше серверного (120 с у manga-analyze)", () => {
    expect(EDGE_TIMEOUT_MS).toBeGreaterThan(120_000);
  });

  it("withRequestTimeout соединяет внешний сигнал и таймер", () => {
    const external = new AbortController();
    const clock = manualTimeoutLinkage();
    const linked = withRequestTimeout(external.signal, 1000, clock.linkage);

    expect(linked.timedOut()).toBe(false);
    expect(clock.active()).toBe(1);

    clock.fireAll();
    expect(linked.signal.aborted).toBe(true);
    expect(linked.timedOut()).toBe(true);

    linked.dispose();
    expect(clock.active()).toBe(0);
  });

  it("withRequestTimeout не держит таймер после dispose и повторяет внешний abort", () => {
    const external = new AbortController();
    const clock = manualTimeoutLinkage();
    const linked = withRequestTimeout(external.signal, 1000, clock.linkage);

    external.abort();
    expect(linked.signal.aborted).toBe(true);
    expect(linked.timedOut()).toBe(false); // это остановка, а не таймаут

    linked.dispose();
    expect(clock.active()).toBe(0);
  });

  it("уже отменённый сигнал не даёт запросу уйти", async () => {
    const external = new AbortController();
    external.abort();

    await expect(edgeRequest("chat", { body: {}, signal: external.signal })).rejects.toSatisfy((e: unknown) =>
      isAbortError(e, external.signal)
    );
    expect(attempts).toHaveLength(0);
  });
});

describe("edgeRequest: сетевой сбой и повтор", () => {
  it("«Failed to fetch» повторяется один раз и называется понятно", async () => {
    respond = async () => {
      throw new TypeError("Failed to fetch");
    };

    await expect(edgeRequest("manga-analyze", { body: {}, retryDelayMs: 0 })).rejects.toMatchObject({
      name: "EdgeRequestError",
      message: NETWORK_ERROR_MESSAGE,
      network: true,
      status: 0,
    });
    expect(attempts).toHaveLength(2); // исходный запрос + один повтор
    expect(attempts[1].url).toBe(attempts[0].url);
  });

  it("разовый обрыв сети проходит незаметно: повтор успевает", async () => {
    respond = async (attempt) => {
      if (attempt === 1) throw new TypeError("Failed to fetch");
      return jsonResponse({ pages: [{ description: "Кадр", transcript: "Speaker 1: Привет" }] });
    };

    const data = await edgeJson<{ pages?: { description?: string }[] }>("manga-analyze", {}, undefined, {
      retryDelayMs: 0,
    });

    expect(attempts).toHaveLength(2);
    expect(data.pages?.[0].description).toBe("Кадр");
  });

  it("ошибка сервера не повторяется: это не сетевой сбой", async () => {
    respond = async () => jsonResponse({ error: "AI не настроен" }, 500);

    await expect(edgeRequest("manga-analyze", { body: {}, retryDelayMs: 0 })).rejects.toMatchObject({
      message: "AI не настроен",
      status: 500,
      network: false,
      timedOut: false,
    });
    expect(attempts).toHaveLength(1);
  });

  it("отмена пользователем не повторяется и не считается ошибкой", async () => {
    const external = new AbortController();
    respond = async (_n, _url, init) => hanging(init);

    const promise = edgeRequest("dialog-tts", { body: {}, signal: external.signal, retryDelayMs: 0 });
    await vi.waitFor(() => expect(attempts.length).toBe(1));
    external.abort();

    await expect(promise).rejects.toSatisfy((e: unknown) => isAbortError(e, external.signal));
    expect(attempts).toHaveLength(1);
  });

  it("без JSON-тела ответ с ошибкой показывает код", async () => {
    respond = async () => ({ ok: false, status: 404, json: async () => { throw new Error("нет тела"); }, text: async () => "" });

    await expect(edgeJson("deepsearch", {})).rejects.toMatchObject({ message: "Ошибка 404", status: 404 });
  });

  it("EdgeRequestError помечает вид отказа", () => {
    expect(new EdgeRequestError("сеть", 0, "chat", "network").network).toBe(true);
    expect(new EdgeRequestError("время", 0, "chat", "timeout").timedOut).toBe(true);
    expect(new EdgeRequestError("ответ", 500, "chat").network).toBe(false);
  });
});
