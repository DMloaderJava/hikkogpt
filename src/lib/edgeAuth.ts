/**
 * Доступ к Supabase Edge Functions.
 *
 * Всё, что ходит в `functions/v1/*`, делает это одним способом — тем же, что и
 * отправка сообщения в чате (`useChat.sendMessage`): POST с JSON-телом,
 * заголовки `Authorization: Bearer <access_token>` + `apikey`, сигнал
 * `AbortController` (кнопка «Стоп») и одна обработка ошибок: сначала пытаемся
 * прочитать `{ error }` от сервера, иначе показываем код ответа.
 *
 * Раньше каждый вызов собирал fetch сам и ошибки обрабатывал по-своему: где-то
 * текст сервера терялся, где-то запрос нельзя было прервать. Теперь точки
 * вызова получают готовый ответ, а причина отказа всегда лежит в
 * `EdgeRequestError.message` — её можно показывать пользователю как есть.
 */

import { supabase } from "@/integrations/supabase/client";

/** База edge-функций: `https://<project>.supabase.co/functions/v1`. */
export const EDGE_FUNCTIONS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

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

  constructor(message: string, status: number, fn: string, network = false) {
    super(message);
    this.name = "EdgeRequestError";
    this.status = status;
    this.fn = fn;
    this.network = network;
  }
}

/**
 * `TypeError: Failed to fetch` — единственная ошибка браузера без внятной
 * причины: так выглядят и отсутствие сети, и блокировка CORS, и незадеплоенная
 * функция. Показывать её как есть бессмысленно, поэтому формулируем сами.
 */
export const NETWORK_ERROR_MESSAGE =
  "Не удалось отправить запрос: сервер недоступен (сеть, блокировщик рекламы или функция не развернута)";

function isNetworkFailure(e: unknown): boolean {
  return e instanceof TypeError;
}

/** Отмена запроса пользователем ошибкой не считается (как `AbortError` в чате). */
export function isAbortError(e: unknown, signal?: AbortSignal | null): boolean {
  if (signal?.aborted) return true;
  if (e instanceof DOMException && e.name === "AbortError") return true;
  return e instanceof Error && e.name === "AbortError";
}

export interface EdgeRequestOptions {
  /** Тело запроса: объект уходит как JSON, `FormData`/`Blob` — как есть. */
  body?: unknown;
  /** Сигнал остановки — тот же `AbortController`, что в `stopStreaming`. */
  signal?: AbortSignal;
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

/**
 * Запрос к edge-функции: тот же набор заголовков и тот же `signal`, что при
 * отправке сообщения. Ответ отдаётся как есть — стрим его читает сам вызывающий.
 */
export async function edgeRequest(fn: string, options: EdgeRequestOptions = {}): Promise<Response> {
  const isJson =
    options.body === undefined ||
    options.body === null ||
    typeof options.body === "string" ||
    (typeof options.body === "object" &&
      !(options.body instanceof FormData) &&
      !(options.body instanceof Blob) &&
      !(options.body instanceof ArrayBuffer));

  const url = `${EDGE_FUNCTIONS_URL}/${fn}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        ...(isJson ? { "Content-Type": "application/json" } : {}),
        ...(await getEdgeAuthHeaders()),
      },
      ...(options.body !== undefined
        ? { body: typeof options.body === "string" ? options.body : isJson ? JSON.stringify(options.body) : (options.body as BodyInit) }
        : {}),
      signal: options.signal,
    });
  } catch (e) {
    // Отмену оставляем как есть: `isAbortError` отличит её от сбоя.
    if (isAbortError(e, options.signal) || !isNetworkFailure(e)) throw e;
    console.error(`edgeRequest(${fn}): запрос не дошёл до ${url}`, e);
    throw new EdgeRequestError(NETWORK_ERROR_MESSAGE, 0, fn, true);
  }

  if (!res.ok) throw await describeFailure(res, fn);
  return res;
}

/** Ответ edge-функции как JSON (`manga-analyze`, `image-search`, `deepsearch`). */
export async function edgeJson<T = unknown>(fn: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await edgeRequest(fn, { body, signal });
  try {
    return (await res.json()) as T;
  } catch {
    throw new EdgeRequestError("Сервер вернул ответ в неверном формате", res.status, fn);
  }
}

/** Ответ edge-функции как blob (`dialog-tts` отдаёт audio/wav). */
export async function edgeBlob(fn: string, body?: unknown, signal?: AbortSignal): Promise<Blob> {
  const res = await edgeRequest(fn, { body, signal });
  try {
    return await res.blob();
  } catch {
    throw new EdgeRequestError("Не удалось получить аудио от сервера", res.status, fn);
  }
}
