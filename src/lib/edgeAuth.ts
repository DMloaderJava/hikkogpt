/**
 * Доступ к Supabase Edge Functions.
 *
 * Всё, что ходит в `functions/v1/*`, делает это одним способом — тем же, что и
 * отправка сообщения в чате (`useChat.sendMessage`): POST с JSON-телом,
 * заголовки `Authorization: Bearer <access_token>` + `apikey`, сигнал
 * `AbortController` (кнопка «Стоп») и одна обработка ошибок: сначала пытаемся
 * прочитать `{ error }` от сервера, иначе показываем код ответа.
 *
 * Запрос настроен так, чтобы доходить до сервера в любых условиях:
 * - в dev URL относительный (`/functions/v1/...`) и идёт через прокси Vite —
 *   тот же origin, что и страница, поэтому CORS, блокировщики рекламы и
 *   ограничения песочниц на запрос не влияют (см. vite.config.ts);
 * - у каждого запроса есть свой таймаут на установку ответа: без него `fetch`
 *   висит, пока соединение не оборвёт прокси, и пользователь видит «Failed to
 *   fetch» вместо причины. Тело ответа (SSE-стрим) таймаут не ограничивает;
 * - сетевой сбой (`TypeError: Failed to fetch`) и таймаут один раз
 *   повторяются — обрыв на плохой сети обычно разовый;
 * - отмена пользователем ошибкой не считается и не повторяется.
 */

import { supabase } from "@/integrations/supabase/client";

/** Публичный адрес edge-функций проекта. */
export const SUPABASE_FUNCTIONS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

/**
 * База для запросов: в dev — относительный путь (его проксирует Vite),
 * в сборке — абсолютный адрес Supabase.
 */
export const EDGE_FUNCTIONS_URL = import.meta.env.DEV ? "/functions/v1" : SUPABASE_FUNCTIONS_URL;

/**
 * Сколько ждём ответ. Серверный таймаут `manga-analyze` — 120 с, поэтому клиент
 * ждёт чуть дольше: первым должен сдаться сервер и прислать понятную ошибку.
 */
export const EDGE_TIMEOUT_MS = 140_000;
/** Пауза перед единственным повтором сетевого сбоя. */
export const EDGE_RETRY_DELAY_MS = 500;

export const NETWORK_ERROR_MESSAGE =
  "Не удалось отправить запрос: сервер недоступен (сеть, блокировщик рекламы или функция не развернута)";
export const TIMEOUT_ERROR_MESSAGE = "Сервер не ответил вовремя. Попробуйте снова или уменьшите число страниц.";

export async function getEdgeAuthHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  const anon = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  return {
    Authorization: `Bearer ${session?.access_token ?? anon}`,
    apikey: anon,
  };
}

/** Ошибка запроса к edge-функции с человекочитаемой причиной. */
export class EdgeRequestError extends Error {
  /** HTTP-код ответа; 0 — до сервера не дошли (сеть, CORS, функция не задеплоена). */
  readonly status: number;
  /** Имя функции (`manga-analyze`, `dialog-tts`, …) — для логов. */
  readonly fn: string;
  /** true, когда запрос не дошёл до сервера вовсе (браузерный `TypeError: Failed to fetch`). */
  readonly network: boolean;
  /** true, когда сработал наш таймаут. */
  readonly timedOut: boolean;

  constructor(message: string, status: number, fn: string, kind: "network" | "timeout" | "response" = "response") {
    super(message);
    this.name = "EdgeRequestError";
    this.status = status;
    this.fn = fn;
    this.network = kind === "network";
    this.timedOut = kind === "timeout";
  }
}

/** Отмена запроса пользователем ошибкой не считается (как `AbortError` в чате). */
export function isAbortError(e: unknown, signal?: AbortSignal | null): boolean {
  if (signal?.aborted) return true;
  if (e instanceof DOMException && e.name === "AbortError") return true;
  return e instanceof Error && e.name === "AbortError";
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface LinkedSignal {
  signal: AbortSignal;
  /** Наш ли таймер оборвал запрос (а не внешний `stop()`). */
  timedOut: () => boolean;
  /**
   * Снимает таймер, но оставляет связь с внешним сигналом: после заголовков
   * ответа живёт тело (у стримов — долго), и «Стоп» обязан его обрывать.
   */
  clearTimeout: () => void;
  /** Полный разбор связки: звать, когда тело ответа больше не нужно. */
  release: () => void;
  /** Совместимость/удобство: то же, что `release`. */
  dispose: () => void;
}

/** Внедряемые часы — нужны, чтобы проверить таймаут в тестах без ожидания. */
export interface SignalLinkage {
  controller?: () => AbortController;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

/**
 * Таймаут запроса + внешний сигнал остановки в одном `AbortSignal`.
 *
 * Таймер ограничен установкой ответа и всегда снимается (иначе вкладка держит
 * его всё время ожидания), а вот связь с внешним сигналом живёт до конца чтения
 * тела: у SSE-стрима оно долгое, и «Стоп» обязан обрывать его, а не только
 * заголовки.
 */
export function withRequestTimeout(
  external: AbortSignal | undefined | null,
  ms: number,
  linkage: SignalLinkage = {}
): LinkedSignal {
  const controller = (linkage.controller ?? (() => new AbortController()))();
  const setTimeoutFn = linkage.setTimeoutFn ?? ((fn: () => void, delay: number) => setTimeout(fn, delay));
  const clearTimeoutFn = linkage.clearTimeoutFn ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let timedOut = false;
  const handle = setTimeoutFn(() => {
    timedOut = true;
    controller.abort();
  }, ms);

  const onExternalAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener("abort", onExternalAbort, { once: true });
  }

  let timerCleared = false;
  const clearTimeout_ = () => {
    if (timerCleared) return;
    timerCleared = true;
    clearTimeoutFn(handle);
  };
  const release = () => {
    clearTimeout_();
    external?.removeEventListener("abort", onExternalAbort);
  };

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    clearTimeout: clearTimeout_,
    release,
    dispose: release,
  };
}

export interface EdgeRequestOptions {
  /** Тело запроса: объект уходит как JSON, `FormData`/`Blob` — как есть. */
  body?: unknown;
  /** Сигнал остановки — тот же `AbortController`, что в `stopStreaming`. */
  signal?: AbortSignal;
  /** Таймаут запроса; `0` отключает его (для стримов без ограничения). */
  timeoutMs?: number;
}

/** Внутренние ручки для тестов: пауза повтора и часы таймаута. */
export interface EdgeInternals extends EdgeRequestOptions {
  retryDelayMs?: number;
  linkage?: SignalLinkage;
}

/** Причина отказа: `{ error }` от сервера → текст → `Ошибка <код>`. */
async function describeFailure(res: Response, fn: string): Promise<EdgeRequestError> {
  let detail = "";
  try {
    const data = await res.json();
    if (data && typeof data.error === "string") detail = data.error;
  } catch {
    try {
      detail = (await res.text()).trim().slice(0, 200);
    } catch {
      /* тело недоступно */
    }
  }
  return new EdgeRequestError(detail || `Ошибка ${res.status}`, res.status, fn);
}

/** Сетевой уровень чиним повтором, прикладную ошибку сервера — нет. */
function isTransient(e: unknown): boolean {
  return e instanceof TypeError || (e instanceof EdgeRequestError && (e.network || e.timedOut));
}

/**
 * Запрос к edge-функции: тот же набор заголовков и тот же `signal`, что при
 * отправке сообщения. Ответ отдаётся как есть — стрим его читает сам вызывающий.
 */
export async function edgeRequest(fn: string, options: EdgeInternals = {}): Promise<Response> {
  const isJson =
    options.body === undefined ||
    options.body === null ||
    typeof options.body === "string" ||
    (typeof options.body === "object" &&
      !(options.body instanceof FormData) &&
      !(options.body instanceof Blob) &&
      !(options.body instanceof ArrayBuffer));

  const url = `${EDGE_FUNCTIONS_URL}/${fn}`;
  const headers = {
    ...(isJson ? { "Content-Type": "application/json" } : {}),
    ...(await getEdgeAuthHeaders()),
  };
  const body =
    options.body === undefined
      ? undefined
      : typeof options.body === "string"
        ? options.body
        : isJson
          ? JSON.stringify(options.body)
          : (options.body as BodyInit);

  // Уже отменённый сигнал: запрос не уходит вовсе (как «Стоп» до отправки).
  if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");

  const timeoutMs = options.timeoutMs ?? EDGE_TIMEOUT_MS;
  // Один повтор на сетевой сбой/таймаут: обрыв на плохой сети обычно разовый.
  const attempts = 2;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const linked = withRequestTimeout(options.signal, timeoutMs, options.linkage);
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers, body, signal: linked.signal });
    } catch (e) {
      const timedOut = linked.timedOut();
      linked.release();

      // Отмена пользователем: выходим сразу и без сообщений об ошибке.
      if (!timedOut && isAbortError(e, options.signal)) throw e;

      lastError = timedOut
        ? new EdgeRequestError(TIMEOUT_ERROR_MESSAGE, 0, fn, "timeout")
        : e instanceof TypeError
          ? new EdgeRequestError(NETWORK_ERROR_MESSAGE, 0, fn, "network")
          : e;

      if (!isTransient(lastError) || attempt === attempts) throw lastError;
      console.warn(`edgeRequest(${fn}): повтор после сбоя (${(lastError as Error).message})`);
      await wait(options.retryDelayMs ?? EDGE_RETRY_DELAY_MS);
      continue;
    }

    // Заголовок ответа получен: таймер больше не нужен, а связь с внешним
    // сигналом оставляем — тело (SSE-стрим) должно обрываться по «Стоп».
    linked.clearTimeout();
    if (!res.ok) {
      linked.release();
      throw await describeFailure(res, fn);
    }
    return res;
  }

  throw lastError instanceof Error ? lastError : new EdgeRequestError(NETWORK_ERROR_MESSAGE, 0, fn, "network");
}

/** Ответ edge-функции как JSON (`manga-analyze`, `image-search`, `deepsearch`). */
export async function edgeJson<T = unknown>(
  fn: string,
  body?: unknown,
  signal?: AbortSignal,
  options: Omit<EdgeInternals, "body" | "signal"> = {}
): Promise<T> {
  const res = await edgeRequest(fn, { ...options, body, signal });
  try {
    return (await res.json()) as T;
  } catch {
    throw new EdgeRequestError("Сервер вернул ответ в неверном формате", res.status, fn);
  }
}


/** Ответ edge-функции как blob (`dialog-tts` отдаёт audio/wav). */
export async function edgeBlob(
  fn: string,
  body?: unknown,
  signal?: AbortSignal,
  options: Omit<EdgeInternals, "body" | "signal"> = {}
): Promise<Blob> {
  const res = await edgeRequest(fn, { ...options, body, signal });
  try {
    return await res.blob();
  } catch {
    throw new EdgeRequestError("Не удалось получить аудио от сервера", res.status, fn);
  }
}
