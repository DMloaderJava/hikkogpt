/**
 * Приватный API hikkoGPT — HTTP-сервер на чистом Node (без зависимостей).
 *
 * Запуск:  node api/src/server.ts        (Node ≥ 22.18 выполняет TS напрямую)
 *          bun api/src/server.ts         (если используется bun)
 *
 * Эндпоинты:
 *   GET  /api/v1/health          — статус, режим, белый список, список моделей
 *   GET  /api/v1/account         — кто я и сколько осталось запросов
 *   POST /api/v1/chat/completions — OpenAI-совместимый чат (+ stream: true)
 *   POST /api/v1/admin/token     — выпуск ключа (нужен ADMIN_TOKEN)
 *   GET  /                       — песочница (playground) для ручной проверки
 *
 * Доступ: только e-mail из белого списка (по умолчанию babaevafarida8@gmail.com).
 */
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { authenticate, AuthError } from "./auth.ts";
import type { Identity } from "./auth.ts";
import { isAllowedEmail, normalizeEmail } from "./allowlist.ts";
import { assertProductionReady, loadConfig, readinessIssues } from "./config.ts";
import type { ApiConfig } from "./config.ts";
import { createLogger, formatRequestLog } from "./log.ts";
import type { Logger } from "./log.ts";
import { apiKeyForEmail, issueToken } from "./token.ts";
import { createRateLimiter } from "./ratelimit.ts";
import { selectProvider, UpstreamError } from "./upstream.ts";
import type { UpstreamRequest } from "./upstream.ts";
import { repoRoot } from "./env.ts";
import type {
  AccountResponse,
  ApiErrorBody,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  ChatRole,
  HealthResponse,
  IssueTokenRequest,
  ModelsResponse,
  ToolChoice,
  ToolDefinition,
} from "./types.ts";

/* ------------------------------------------------------------ ошибки/утилиты */

export class ApiError extends Error {
  status: number;
  code: ApiErrorBody["error"]["code"];
  /**
   * `true`, если ответ клиенту уже отправлен (например, 429 с заголовком
   * Retry-After) — тогда роутер не должен писать тело второй раз.
   */
  skipResponse: boolean;
  constructor(status: number, code: ApiErrorBody["error"]["code"], message: string, skipResponse = false) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.skipResponse = skipResponse;
  }
}

/**
 * CORS. По умолчанию `*` (ключ всё равно обязателен), но для боевого сервера
 * лучше перечислить свои источники: `CORS_ORIGIN=https://app.example.com`.
 */
function corsHeaders(config: ApiConfig): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": config.corsOrigin,
    "Access-Control-Allow-Headers":
      "authorization, content-type, x-hikko-email, x-request-id, apikey, x-client-info",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    ...(config.corsOrigin !== "*" ? { Vary: "Origin" } : {}),
  };
}

/** Комментарий SSE — держит соединение живым, пока модель «думает». */
const SSE_PING = Buffer.from(": ping\n\n");

function safeWrite(res: http.ServerResponse, data: Buffer | string): boolean {
  if (res.writableEnded || res.destroyed) return false;
  try {
    return res.write(data);
  } catch {
    return false;
  }
}

function json(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  requestId: string,
  config: ApiConfig,
  extra: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "X-Request-Id": requestId,
    ...corsHeaders(config),
    ...extra,
  });
  res.end(payload);
}

function fail(res: http.ServerResponse, requestId: string, status: number, code: ApiErrorBody["error"]["code"], message: string, config: ApiConfig): void {
  const body: ApiErrorBody = {
    error: {
      message,
      code,
      request_id: requestId,
      ...(code === "forbidden" || code === "unauthorized" ? { allowed_emails: config.allowlist } : {}),
    },
  };
  json(res, status, body, requestId, config);
}

async function readBody(req: http.IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) throw new ApiError(413, "payload_too_large", `Тело запроса больше ${limit} байт.`);
    chunks.push(buffer);
  }
  if (size === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError(400, "bad_request", "Ожидался JSON в теле запроса.");
  }
}

function toHeaders(req: http.IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(", "));
  }
  return headers;
}

/* ------------------------------------------------------------- валидация ---- */

const ROLES: ChatRole[] = ["system", "user", "assistant", "tool"];

const TOOL_CHOICE_STRINGS = new Set(["none", "auto", "required"]);

function validateTools(input: unknown): ToolDefinition[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new ApiError(400, "bad_request", "Поле tools должно быть массивом.");
  return input.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new ApiError(400, "bad_request", `tools[${index}] должен быть объектом { type: "function", function: {…} }.`);
    }
    const tool = item as Record<string, unknown>;
    const fn = tool.function as Record<string, unknown> | undefined;
    if (tool.type !== "function" || !fn || typeof fn.name !== "string" || fn.name.trim() === "") {
      throw new ApiError(400, "bad_request", `tools[${index}]: нужен type "function" и function.name.`);
    }
    if (fn.description !== undefined && typeof fn.description !== "string") {
      throw new ApiError(400, "bad_request", `tools[${index}].function.description должен быть строкой.`);
    }
    if (fn.parameters !== undefined && (typeof fn.parameters !== "object" || fn.parameters === null)) {
      throw new ApiError(400, "bad_request", `tools[${index}].function.parameters должен быть JSON Schema объектом.`);
    }
    return {
      type: "function",
      function: {
        name: fn.name,
        ...(typeof fn.description === "string" ? { description: fn.description } : {}),
        ...(fn.parameters ? { parameters: fn.parameters as ToolDefinition["function"]["parameters"] } : {}),
      },
    } satisfies ToolDefinition;
  });
}

function validateToolChoice(input: unknown): ToolChoice | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input === "string") {
    if (!TOOL_CHOICE_STRINGS.has(input)) {
      throw new ApiError(400, "bad_request", `tool_choice должен быть одним из: ${[...TOOL_CHOICE_STRINGS].join(", ")} или объектом.`);
    }
    return input as ToolChoice;
  }
  if (typeof input === "object") {
    const choice = input as { type?: unknown; function?: { name?: unknown } };
    if (choice.type !== "function" || typeof choice.function?.name !== "string") {
      throw new ApiError(400, "bad_request", 'tool_choice-объект должен быть { type: "function", function: { name } }.');
    }
    return { type: "function", function: { name: choice.function.name } };
  }
  throw new ApiError(400, "bad_request", "tool_choice должен быть строкой или объектом.");
}

function validateStop(input: unknown): string[] | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input === "string") return [input];
  if (Array.isArray(input) && input.every((item) => typeof item === "string")) return input as string[];
  throw new ApiError(400, "bad_request", "Поле stop должно быть строкой, массивом строк или null.");
}

export function validateChatRequest(input: unknown): Required<Pick<ChatCompletionRequest, "messages">> & ChatCompletionRequest {
  if (!input || typeof input !== "object") throw new ApiError(400, "bad_request", "Тело запроса должно быть объектом.");
  const body = input as Record<string, unknown>;

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new ApiError(400, "bad_request", "Поле messages обязательно: непустой массив { role, content }.");
  }

  const messages: ChatMessage[] = body.messages.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new ApiError(400, "bad_request", `messages[${index}] должен быть объектом.`);
    }
    const message = item as Record<string, unknown>;
    const role = message.role;
    if (typeof role !== "string" || !ROLES.includes(role as ChatRole)) {
      throw new ApiError(400, "bad_request", `messages[${index}].role должен быть одним из: ${ROLES.join(", ")}.`);
    }
    const content = message.content;
    const hasText = typeof content === "string" && content.trim() !== "";
    const toolCalls = message.tool_calls;

    // assistant c tool_calls имеет право быть без текста — это норма для OpenAI.
    if (role === "assistant" && Array.isArray(toolCalls) && toolCalls.length > 0) {
      const calls = toolCalls.map((call, callIndex) => {
        const item2 = call as Record<string, unknown> | null;
        const fn = item2?.function as Record<string, unknown> | undefined;
        if (!item2 || typeof fn?.name !== "string") {
          throw new ApiError(400, "bad_request", `messages[${index}].tool_calls[${callIndex}]: нужна function.name.`);
        }
        return {
          id: typeof item2.id === "string" ? item2.id : `call_${index}_${callIndex}`,
          type: "function" as const,
          function: {
            name: fn.name,
            arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
          },
        };
      });
      return {
        role: "assistant" as const,
        ...(hasText ? { content: content as string } : {}),
        tool_calls: calls,
      } satisfies ChatMessage;
    }

    if (role === "tool") {
      if (typeof message.tool_call_id !== "string" || message.tool_call_id === "") {
        throw new ApiError(400, "bad_request", `messages[${index}]: для роли tool обязателен tool_call_id.`);
      }
      return {
        role: "tool" as const,
        content: typeof content === "string" ? content : JSON.stringify(content ?? ""),
        tool_call_id: message.tool_call_id,
        ...(typeof message.name === "string" ? { name: message.name } : {}),
      } satisfies ChatMessage;
    }

    if (!hasText) {
      throw new ApiError(400, "bad_request", `messages[${index}].content должен быть непустой строкой.`);
    }
    return { role: role as ChatRole, content: content as string };
  });

  if (body.model !== undefined && typeof body.model !== "string") {
    throw new ApiError(400, "bad_request", "Поле model должно быть строкой.");
  }
  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    throw new ApiError(400, "bad_request", "Поле stream должно быть boolean.");
  }
  if (body.temperature !== undefined) {
    const temperature = Number(body.temperature);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      throw new ApiError(400, "bad_request", "temperature должен быть числом в диапазоне 0…2.");
    }
  }
  if (body.max_tokens !== undefined) {
    const maxTokens = Number(body.max_tokens);
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 32_768) {
      throw new ApiError(400, "bad_request", "max_tokens должен быть целым числом 1…32768.");
    }
  }
  if (body.system !== undefined && typeof body.system !== "string") {
    throw new ApiError(400, "bad_request", "Поле system должно быть строкой.");
  }
  if (body.top_p !== undefined) {
    const topP = Number(body.top_p);
    if (!Number.isFinite(topP) || topP < 0 || topP > 1) {
      throw new ApiError(400, "bad_request", "top_p должен быть числом в диапазоне 0…1.");
    }
  }

  const tools = validateTools(body.tools);
  const toolChoice = validateToolChoice(body.tool_choice);
  const stop = validateStop(body.stop);

  return {
    messages,
    ...(typeof body.model === "string" ? { model: body.model } : {}),
    ...(typeof body.stream === "boolean" ? { stream: body.stream } : {}),
    ...(body.temperature !== undefined ? { temperature: Number(body.temperature) } : {}),
    ...(body.max_tokens !== undefined ? { max_tokens: Number(body.max_tokens) } : {}),
    ...(typeof body.system === "string" ? { system: body.system } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(body.top_p !== undefined ? { top_p: Number(body.top_p) } : {}),
    ...(stop !== undefined ? { stop } : {}),
    // n, user, seed, logit_bias, response_format, stream_options, parallel_tool_calls
    // принимаются, но не влияют на ответ — OpenAI-клиенты шлют их по умолчанию.
  };
}

/* ----------------------------------------------------------------- роутер ---- */

/**
 * OpenAI-клиенты по-разному понимают «базовый URL», поэтому один и тот же
 * эндпоинт доступен по трём вариантам пути:
 *
 * | Базовый URL в клиенте | Путь запроса |
 * |---|---|
 * | `http://host:8787`          | `/v1/chat/completions`, `/v1/models` |
 * | `http://host:8787/v1`       | `/chat/completions`, `/models` |
 * | `http://host:8787/api/v1`   | `/chat/completions`, `/models` |
 */
const ROUTE_ALIASES: Record<string, string> = {
  "/v1/chat/completions": "/api/v1/chat/completions",
  "/chat/completions": "/api/v1/chat/completions",
  "/v1/completions": "/api/v1/chat/completions",
  "/completions": "/api/v1/chat/completions",
  "/v1/models": "/api/v1/models",
  "/models": "/api/v1/models",
  "/v1/account": "/api/v1/account",
  "/account": "/api/v1/account",
  "/health": "/api/v1/health",
};

const KNOWN_ROUTES = new Set([
  "/",
  "/api/v1/health",
  "/api/v1/account",
  "/api/v1/chat/completions",
  "/api/v1/models",
  "/api/v1/admin/token",
]);

export interface ServerDeps {
  config: ApiConfig;
  limiter: ReturnType<typeof createRateLimiter>;
  provider: ReturnType<typeof selectProvider>;
  log: Logger;
}

function buildUpstreamRequest(request: ChatCompletionRequest, config: ApiConfig, requestId: string): UpstreamRequest {
  // Если клиент (Cline, Cursor, LangChain…) прислал свой системный промпт —
  // он важнее встроенного: не подмешиваем «характер» hikkoGPT поверх инструкций агента.
  const hasClientSystem =
    typeof request.system === "string" || request.messages.some((message) => message.role === "system");
  const system = [hasClientSystem ? "" : config.systemPrompt, request.system ?? ""].filter(Boolean).join("\n\n");

  const requested = request.model ?? config.defaultModel;
  const model = isKnownModel(requested, config) ? requested : config.defaultModel;
  const stop = normalizeStop(request.stop);

  return {
    messages: request.messages,
    model,
    ...(system ? { system } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.top_p !== undefined ? { topP: request.top_p } : {}),
    ...(request.max_tokens !== undefined ? { maxTokens: request.max_tokens } : {}),
    ...(stop ? { stop } : {}),
    ...(request.tools && request.tools.length > 0 ? { tools: request.tools } : {}),
    ...(request.tool_choice !== undefined ? { toolChoice: request.tool_choice } : {}),
    requestId,
    timeoutMs: config.requestTimeoutMs,
  };
}

/** `stop` приходит строкой, массивом или null — апстриму нужен массив. */
function normalizeStop(stop: string | string[] | null | undefined): string[] | undefined {
  if (!stop) return undefined;
  const list = Array.isArray(stop) ? stop : [stop];
  return list.length > 0 ? list : undefined;
}

/** Знаком ли серверу id модели (псевдонимы hikko-* или любое имя gemini-*). */
export function isKnownModel(model: string, config: ApiConfig): boolean {
  const normalized = model.trim().toLowerCase();
  if (config.models.some((known) => known.toLowerCase() === normalized)) return true;
  return normalized.startsWith("gemini");
}

/**
 * Незнакомая модель: по умолчанию молча берём дефолтную (клиент вроде Cline
 * вводит id руками), при `ALLOW_UNKNOWN_MODEL=false` — честная ошибка 400.
 */
function assertModelAllowed(request: ChatCompletionRequest, config: ApiConfig): void {
  if (!request.model) return;
  if (config.allowUnknownModel || isKnownModel(request.model, config)) return;
  throw new ApiError(
    400,
    "bad_request",
    `Модель "${request.model}" неизвестна. Доступны: ${config.models.join(", ")} (и gemini-*).`,
  );
}

/**
 * `allowlist` в /health — только если разрешено публично
 * (`HEALTH_SHOW_ALLOWLIST=true`) или запрос пришёл с ключом разрешённого адреса:
 * показывать чужой e-mail всем подряд не стоит.
 */
function healthPayload(config: ApiConfig, allowedViewer: boolean): HealthResponse {
  return {
    status: "ok",
    service: "hikko-private-api",
    version: config.version,
    mode: config.mode,
    allowlist: config.healthShowAllowlist || allowedViewer ? config.allowlist : [],
    models: config.models,
    streaming: true,
    time: new Date().toISOString(),
  };
}

/** `GET /v1/models` — список моделей в формате OpenAI (его ждут Cline/Cursor/Continue). */
function modelsPayload(config: ApiConfig): ModelsResponse {
  const created = Math.floor(Date.now() / 1000);
  return {
    object: "list",
    data: config.models.map((id) => ({
      id,
      object: "model" as const,
      created,
      owned_by: "hikkogpt",
      context_window: 1_000_000,
      supports_tools: true,
      private: true,
    })),
  };
}

function accountPayload(identity: Identity, deps: ServerDeps, requestId: string): AccountResponse {
  const { email } = identity;
  const snapshot = deps.limiter.peek(email);
  return {
    email,
    allowed: true,
    auth_method: identity.method,
    key_kind: identity.keyKind,
    unlimited: isAllowedEmail(email, deps.config.allowlist),
    rate_limit: {
      limit: snapshot.limit,
      window_seconds: 60,
      remaining: snapshot.remaining,
      reset_at: new Date(snapshot.resetAt).toISOString(),
    },
    request_id: requestId,
  };
}

async function handleChat(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ServerDeps,
  requestId: string,
): Promise<Identity> {
  const identity = await authenticate({ headers: toHeaders(req), config: deps.config });
  const limit = deps.limiter.hit(identity.email);
  if (!limit.allowed) {
    json(
      res,
      429,
      { error: { message: `Превышен лимит ${limit.limit} запросов в минуту.`, code: "rate_limited", request_id: requestId } } satisfies ApiErrorBody,
      requestId,
      deps.config,
      { "Retry-After": String(limit.retryAfterSeconds) },
    );
    // Ответ уже ушёл клиенту — сообщаем роутеру не писать тело повторно.
    throw new ApiError(429, "rate_limited", "Превышен лимит запросов.", true);
  }

  const request = validateChatRequest(await readBody(req, deps.config.maxBodyBytes));
  assertModelAllowed(request, deps.config);
  const upstreamRequest = buildUpstreamRequest(request, deps.config, requestId);
  const model = upstreamRequest.model;

  if (request.stream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Request-Id": requestId,
      "X-Accel-Buffering": "no",
      ...corsHeaders(deps.config),
    });
    res.flushHeaders?.();

    const reader = deps.provider.completeStream(upstreamRequest).getReader();
    // Пинги нужны, когда модель думает дольше idle-таймаута прокси: Cline и
    // nginx/Caddy иначе рвут «молчащее» соединение. Интервал — SSE_KEEP_ALIVE_MS.
    const keepAliveMs = deps.config.sseKeepAliveMs;
    let timer: ReturnType<typeof setInterval> | undefined;
    if (keepAliveMs > 0) {
      timer = setInterval(() => {
        if (!safeWrite(res, SSE_PING) && timer) clearInterval(timer);
      }, keepAliveMs);
      timer.unref?.();
    }

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!safeWrite(res, Buffer.from(value as Uint8Array))) break; // клиент отвалился
        if (!res.writableEnded && (res as unknown as { writableNeedDrain?: boolean }).writableNeedDrain) {
          await new Promise<void>((resolve) => res.once("drain", resolve));
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.log(`WARN [${requestId}] поток прерван: ${message}`);
      safeWrite(
        res,
        Buffer.from(
          `data: ${JSON.stringify({ error: { message, code: "upstream_error", request_id: requestId } })}\n\n`,
        ),
      );
    } finally {
      if (timer) clearInterval(timer);
      try {
        await reader.cancel().catch(() => {});
      } catch {
        /* поток уже закрыт */
      }
      reader.releaseLock();
      if (!res.writableEnded) res.end();
    }
    return identity;
  }

  const result = await deps.provider.complete(upstreamRequest);
  const assistantMessage: ChatMessage = {
    role: "assistant",
    content: result.text,
    ...(result.toolCalls.length > 0 ? { tool_calls: result.toolCalls } : {}),
  };
  const promptChars = request.messages.reduce(
    (sum, message) => sum + (typeof message.content === "string" ? message.content.length : 0),
    0,
  );
  const response: ChatCompletionResponse = {
    id: requestId,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: result.model || model,
    choices: [{ index: 0, message: assistantMessage, finish_reason: result.finishReason }],
    usage: {
      prompt_messages: request.messages.length,
      completion_chars: result.text.length,
      total_chars: promptChars + result.text.length,
      ...(result.usage?.promptTokens !== undefined ? { prompt_tokens: result.usage.promptTokens } : {}),
      ...(result.usage?.completionTokens !== undefined ? { completion_tokens: result.usage.completionTokens } : {}),
      ...(result.usage?.totalTokens !== undefined ? { total_tokens: result.usage.totalTokens } : {}),
    },
    provider: result.provider,
    account: { email: identity.email },
    request_id: requestId,
  };
  json(res, 200, response, requestId, deps.config);
  return identity;
}

async function handleAdminToken(req: http.IncomingMessage, res: http.ServerResponse, deps: ServerDeps, requestId: string): Promise<void> {
  const { config } = deps;
  if (!config.adminToken) {
    fail(res, requestId, 404, "not_found", "Эндпоинт выпуска ключей отключён (не задан ADMIN_TOKEN).", config);
    return;
  }
  const presented = toHeaders(req).get("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? "";
  const expected = Buffer.from(config.adminToken);
  const actual = Buffer.from(presented);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    fail(res, requestId, 403, "forbidden", "Неверный ADMIN_TOKEN.", config);
    return;
  }

  const body = (await readBody(req, config.maxBodyBytes)) as IssueTokenRequest;
  const email = normalizeEmail(body.email ?? config.allowlist[0] ?? "");
  if (!isAllowedEmail(email, config.allowlist)) {
    fail(res, requestId, 403, "forbidden", `Ключ можно выпустить только для ${config.allowlist.join(", ")}.`, config);
    return;
  }
  const ttl = Number.isFinite(body.ttl_seconds ?? Number.NaN) ? Number(body.ttl_seconds ?? 0) : 0;
  const issued = issueToken(email, config.secret, ttl);
  json(
    res,
    201,
    {
      token: issued.token,
      email: issued.email,
      expires_at: issued.expiresAt ? new Date(issued.expiresAt * 1000).toISOString() : null,
      request_id: requestId,
    },
    requestId,
    config,
  );
}

function servePlayground(res: http.ServerResponse, requestId: string, config: ApiConfig): void {
  const file = path.join(repoRoot, "api", "playground.html");
  fs.readFile(file, (error, data) => {
    if (error) {
      res.writeHead(404, {
        "Content-Type": "text/plain; charset=utf-8",
        "X-Request-Id": requestId,
        ...corsHeaders(config),
      });
      res.end("playground.html не найден");
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": data.length,
      "X-Request-Id": requestId,
      ...corsHeaders(config),
    });
    res.end(data);
  });
}

/** Чистая функция маршрутизации — удобно тестировать без поднятого порта. */
export async function routeRequest(req: http.IncomingMessage, res: http.ServerResponse, deps: ServerDeps): Promise<void> {
  const headers = toHeaders(req);
  const requestId = (headers.get("x-request-id") ?? crypto.randomUUID()).slice(0, 64);
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://internal");
  const rawRoute = url.pathname.replace(/\/+$/, "") || "/";
  const route = ROUTE_ALIASES[rawRoute] ?? rawRoute;
  const startedAt = Date.now();
  // Кто обратился и что запросил — попадает в лог одной строкой в конце.
  const ctx: { email?: string; authMethod?: string; model?: string; stream?: boolean } = {};
  const finish = (status: number): void => {
    deps.log(
      formatRequestLog({
        method,
        route: rawRoute,
        status,
        startedAt,
        requestId,
        ...(ctx.email ? { email: ctx.email } : {}),
        ...(ctx.authMethod ? { authMethod: ctx.authMethod } : {}),
        ...(ctx.model ? { model: ctx.model } : {}),
        ...(ctx.stream !== undefined ? { stream: ctx.stream } : {}),
      }),
    );
  };
  const respond = (status: number): number => {
    finish(status);
    return status;
  };

  if (method === "OPTIONS") {
    res.writeHead(respond(204), corsHeaders(deps.config));
    res.end();
    return;
  }

  try {
    if (route === "/" && (method === "GET" || method === "HEAD")) {
      if (!deps.config.servePlayground) {
        fail(res, requestId, 404, "not_found", "Маршрут / не найден.", deps.config);
        respond(404);
        return;
      }
      servePlayground(res, requestId, deps.config);
      respond(200);
      return;
    }
    if (route === "/api/v1/health" && (method === "GET" || method === "HEAD")) {
      // /health открыт без ключа (нужен для health-check прокси), но e-mail из
      // белого списка показываем только своим — иначе адрес утекает всем.
      const viewer = await authenticate({ headers, config: deps.config, skipSupabase: true }).catch(() => null);
      if (viewer) {
        ctx.email = viewer.email;
        ctx.authMethod = viewer.method;
      }
      json(res, respond(200), healthPayload(deps.config, Boolean(viewer)), requestId, deps.config);
      return;
    }
    if (route === "/api/v1/account" && method === "GET") {
      const identity = await authenticate({ headers, config: deps.config });
      ctx.email = identity.email;
      ctx.authMethod = identity.method;
      json(res, respond(200), accountPayload(identity, deps, requestId), requestId, deps.config);
      return;
    }
    if (route === "/api/v1/models" && (method === "GET" || method === "HEAD")) {
      // Список моделей — за ключом: адрес из белого списка видно только своим.
      const identity = await authenticate({ headers, config: deps.config });
      ctx.email = identity.email;
      ctx.authMethod = identity.method;
      json(res, respond(200), modelsPayload(deps.config), requestId, deps.config);
      return;
    }
    if (route === "/api/v1/chat/completions" && method === "POST") {
      const identity = await handleChat(req, res, deps, requestId);
      ctx.email = identity.email;
      ctx.authMethod = identity.method;
      respond(res.statusCode || 200);
      return;
    }
    if (route === "/api/v1/admin/token" && method === "POST") {
      await handleAdminToken(req, res, deps, requestId);
      respond(res.statusCode || 201);
      return;
    }

    if (!KNOWN_ROUTES.has(route)) {
      fail(
        res,
        requestId,
        404,
        "not_found",
        `Маршрут ${rawRoute} не найден. OpenAI-совместимые: GET /v1/models, POST /v1/chat/completions (то же самое доступно как /api/v1/…).`,
        deps.config,
      );
      respond(404);
      return;
    }
    fail(res, requestId, 405, "method_not_allowed", `Метод ${method} не поддерживается маршрутом ${route}.`, deps.config);
    respond(405);
  } catch (error) {
    if (error instanceof AuthError) {
      fail(res, requestId, error.status, error.code, error.message, deps.config);
      respond(error.status);
      return;
    }
    if (error instanceof ApiError) {
      if (!error.skipResponse) {
        fail(res, requestId, error.status, error.code, error.message, deps.config);
      }
      respond(error.status);
      return;
    }
    if (error instanceof UpstreamError) {
      fail(res, requestId, error.status, "upstream_error", error.message, deps.config);
      respond(error.status);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    deps.log(`ERROR [${requestId}] необработанная ошибка: ${message}`);
    fail(res, requestId, 500, "internal_error", message, deps.config);
    respond(500);
  }
}

/* ------------------------------------------------------------------ запуск ---- */

/**
 * Собрать сервер. `overrides` нужен тестам: подменить провайдер (фейковый шлюз)
 * или логгер (тишина), не трогая остальное.
 */
export function createServer(config: ApiConfig = loadConfig(), overrides: Partial<ServerDeps> = {}): http.Server {
  // В production с дефолтным секретом из репозитория стартовать нельзя:
  // ключ для разрешённого адреса тогда может вычислить кто угодно.
  assertProductionReady(config);
  const deps: ServerDeps = {
    config,
    limiter: createRateLimiter(config.rateLimitPerMinute),
    provider: selectProvider(config),
    log: createLogger(config),
    ...overrides,
  };
  return http.createServer((req, res) => {
    void routeRequest(req, res, deps);
  });
}

function isMain(): boolean {
  const entry = process.argv[1] ?? "";
  return entry.endsWith("server.ts") || entry.endsWith("server.js");
}

if (isMain()) {
  const config = loadConfig();
  for (const issue of readinessIssues(config)) {
    const label = issue.level === "error" ? "ОШИБКА" : "ВНИМАНИЕ";
    console.warn(`  ${label}: ${issue.message}`);
  }

  let server: http.Server;
  try {
    server = createServer(config);
  } catch (error) {
    // Например, production с дефолтным секретом: падем чисто, без простыни стека.
    console.error(`\n  ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
  server.listen(config.port, config.host, () => {
    const shown = config.host === "0.0.0.0" ? "localhost" : config.host;
    console.log(`\n  hikkoGPT private API v${config.version}`);
    console.log(`  ➜  http://${shown}:${config.port}  (интерфейс ${config.host})`);
    console.log(`  ➜  режим модели: ${config.mode}${config.mode === "echo" ? " — ключи не заданы, ответы локальные" : ""}`);
    console.log(`  ➜  доступ разрешён: ${config.allowlist.join(", ")}`);
    for (const email of config.allowlist) {
      console.log(`  ➜  ключ для ${email}: ${apiKeyForEmail(email, config.secret, config.staticApiKey)}`);
    }
    if (config.servePlayground) {
      console.log(`  ➜  песочница: http://${shown}:${config.port}/`);
    } else {
      console.log("  ➜  песочница на GET / выключена (SERVE_PLAYGROUND=false)");
    }
    console.log("  ➜  OpenAI Compatible (Cline, Cursor, Continue, LangChain):");
    console.log(`       Base URL: http://${shown}:${config.port}/v1   (ключ — тот же, что выше)`);
    console.log(`       Model ID: ${config.defaultModel}\n`);
  });

  const shutdown = (signal: string) => {
    console.log(`\n${signal}: останавливаю сервер…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
