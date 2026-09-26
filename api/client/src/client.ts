/**
 * TypeScript-клиент для приватного API hikkoGPT.
 *
 * Работает везде, где есть `fetch` (Node ≥ 18, Deno, Bun, браузер).
 * Зависимостей нет — можно скопировать один файл в свой проект.
 *
 * ```ts
 * import { HikkoApiClient } from "./client.ts";
 *
 * const api = new HikkoApiClient({
 *   baseUrl: "http://localhost:8787",
 *   apiKey: "hk1.…",            // ключ, выданный для babaevafarida8@gmail.com
 * });
 *
 * const answer = await api.chat([
 *   { role: "user", content: "Привет! Что ты умеешь?" },
 * ]);
 * console.log(answer.choices[0].message.content);
 * ```
 */
import type {
  AccountResponse,
  ApiErrorBody,
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  HealthResponse,
  HikkoModel,
  ModelsResponse,
  ToolCall,
  ToolChoice,
  ToolDefinition,
} from "../../src/types.ts";

export type {
  AccountResponse,
  ApiErrorBody,
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  HealthResponse,
  HikkoModel,
  ModelsResponse,
  ToolCall,
  ToolChoice,
  ToolDefinition,
};

export interface HikkoApiClientOptions {
  /** Базовый URL сервера, например `http://localhost:8787`. */
  baseUrl: string;
  /** Ключ доступа. Альтернатива — `email` (режим разработки). */
  apiKey?: string;
  /**
   * E-mail для доступа. Используется только если сервер разрешает вход
   * по заголовку `X-Hikko-Email` (`ALLOW_HEADER_AUTH=true`, локальная разработка).
   */
  email?: string;
  /** Модель по умолчанию для всех запросов. */
  model?: HikkoModel;
  /** Таймаут одного запроса в мс (по умолчанию 120 000; стриминг не ограничивает). */
  timeoutMs?: number;
  /** Дополнительные заголовки. */
  headers?: Record<string, string>;
  /** Своя реализация fetch (тесты, прокси, кастомный агент). */
  fetch?: typeof fetch;
}

/** Ошибка API с разобранным телом и HTTP-статусом. */
export class HikkoApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;
  readonly allowedEmails?: string[];

  constructor(status: number, body: ApiErrorBody | null, fallbackMessage: string) {
    super(body?.error?.message ?? fallbackMessage);
    this.name = "HikkoApiError";
    this.status = status;
    this.code = body?.error?.code ?? "internal_error";
    this.requestId = body?.error?.request_id;
    this.allowedEmails = body?.error?.allowed_emails;
  }

  /** 401/403 — проблема с доступом (не тот e-mail, протух ключ). */
  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

/** Разобранный ответ: удобно, когда нужен только текст. */
export interface ChatResult {
  text: string;
  model: string;
  provider: ChatCompletionResponse["provider"];
  usage: ChatCompletionResponse["usage"];
  requestId: string;
  raw: ChatCompletionResponse;
}

export class HikkoApiClient {
  readonly baseUrl: string;
  readonly defaultModel?: HikkoModel;
  private readonly apiKey?: string;
  private readonly email?: string;
  private readonly timeoutMs: number;
  private readonly extraHeaders: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HikkoApiClientOptions) {
    if (!options.baseUrl) throw new Error("HikkoApiClient: baseUrl обязателен");
    if (!options.apiKey && !options.email) {
      throw new Error("HikkoApiClient: нужен apiKey (или email для локального режима разработки)");
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.email = options.email?.trim().toLowerCase();
    this.defaultModel = options.model;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.extraHeaders = { ...(options.headers ?? {}) };
    this.fetchImpl = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  }

  /* ------------------------------------------------------------- публичное */

  /** Жив ли сервер и в каком режиме работает. */
  health(): Promise<HealthResponse> {
    return this.request<HealthResponse>("GET", "/api/v1/health", { auth: false });
  }

  /** Кто я с точки зрения сервера + остаток лимита. */
  account(): Promise<AccountResponse> {
    return this.request<AccountResponse>("GET", "/api/v1/account");
  }

  /**
   * Список моделей в формате OpenAI (`GET /v1/models`) — тот же эндпоинт,
   * который дёргают Cline/Cursor/Continue при подключении «OpenAI Compatible».
   */
  models(): Promise<ModelsResponse> {
    return this.request<ModelsResponse>("GET", "/v1/models");
  }

  /** Обычный (не потоковый) запрос: весь ответ сразу. */
  async chat(
    messages: ChatMessage[],
    options: Omit<ChatCompletionRequest, "messages" | "stream"> = {},
  ): Promise<ChatResult> {
    const response = await this.request<ChatCompletionResponse>("POST", "/api/v1/chat/completions", {
      body: { ...options, ...(options.model ?? this.defaultModel ? { model: options.model ?? this.defaultModel } : {}), messages, stream: false },
    });
    return {
      text: response.choices[0]?.message.content ?? "",
      model: response.model,
      provider: response.provider,
      usage: response.usage,
      requestId: response.request_id,
      raw: response,
    };
  }

  /**
   * Потоковый запрос: асинхронный итератор по текстовым кусочкам ответа.
   *
   * ```ts
   * for await (const piece of api.chatStream([{ role: "user", content: "Расскажи про Марс" }])) {
   *   process.stdout.write(piece);
   * }
   * ```
   */
  async *chatStream(
    messages: ChatMessage[],
    options: Omit<ChatCompletionRequest, "messages" | "stream"> = {},
  ): AsyncGenerator<string, void, void> {
    for await (const chunk of this.streamChunks(messages, options)) {
      const piece = chunk.choices[0]?.delta?.content;
      if (piece) yield piece;
    }
  }

  /** То же, что `chatStream`, но отдаёт сырые SSE-чанки (нужны finish_reason/usage). */
  async *streamChunks(
    messages: ChatMessage[],
    options: Omit<ChatCompletionRequest, "messages" | "stream"> = {},
  ): AsyncGenerator<ChatCompletionChunk, void, void> {
    const response = await this.send("POST", "/api/v1/chat/completions", {
      body: { ...options, ...(options.model ?? this.defaultModel ? { model: options.model ?? this.defaultModel } : {}), messages, stream: true },
      streaming: true,
    });

    if (!response.body) {
      throw new HikkoApiError(response.status, null, "Сервер не вернул тело потока.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          let line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
          if (line.endsWith("\r")) line = line.slice(0, -1);
          line = line.trim();
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          if (payload === "[DONE]") return;
          let parsed: ChatCompletionChunk & { error?: ApiErrorBody["error"] };
          try {
            parsed = JSON.parse(payload) as ChatCompletionChunk & { error?: ApiErrorBody["error"] };
          } catch {
            continue;
          }
          if (parsed.error) {
            throw new HikkoApiError(502, { error: parsed.error }, "Поток прерван ошибкой апстрима.");
          }
          yield parsed;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /* -------------------------------------------------------------- внутреннее */

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = { ...this.extraHeaders };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    else if (this.email) headers["X-Hikko-Email"] = this.email;
    return headers;
  }

  private async send(
    method: "GET" | "POST",
    pathname: string,
    init: { body?: unknown; auth?: boolean; streaming?: boolean } = {},
  ): Promise<Response> {
    const auth = init.auth ?? true;
    const headers: Record<string, string> = {
      Accept: init.streaming ? "text/event-stream" : "application/json",
      ...(auth ? this.authHeaders() : this.extraHeaders),
    };
    let body: string | undefined;
    if (init.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.body);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        // Стриминг не режем таймаутом: ответ может идти минутами.
        ...(init.streaming ? {} : { signal: AbortSignal.timeout(this.timeoutMs) }),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new HikkoApiError(0, null, `Не удалось связаться с ${this.baseUrl}${pathname}: ${reason}`);
    }
    return response;
  }

  private async request<T>(
    method: "GET" | "POST",
    pathname: string,
    init: { body?: unknown; auth?: boolean } = {},
  ): Promise<T> {
    const response = await this.send(method, pathname, init);
    const text = await response.text();
    if (!response.ok) {
      let parsed: ApiErrorBody | null = null;
      try {
        parsed = JSON.parse(text) as ApiErrorBody;
      } catch {
        parsed = null;
      }
      throw new HikkoApiError(response.status, parsed, `HTTP ${response.status} ${response.statusText}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }
}

export default HikkoApiClient;

/* ------------------------------------------------------------------ хелперы */

/** Адрес, для которого API открыт по умолчанию (тот же, что в белом списке сервера). */
export const PRIVATE_API_EMAIL = "babaevafarida8@gmail.com";

