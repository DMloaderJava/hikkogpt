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
import { isAllowedEmail, normalizeEmail } from "./allowlist.ts";
import { loadConfig } from "./config.ts";
import type { ApiConfig } from "./config.ts";
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
} from "./types.ts";

/* ------------------------------------------------------------ ошибки/утилиты */

export class ApiError extends Error {
  status: number;
  code: ApiErrorBody["error"]["code"];
  constructor(status: number, code: ApiErrorBody["error"]["code"], message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, content-type, x-hikko-email, x-request-id, apikey, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

function json(res: http.ServerResponse, status: number, body: unknown, requestId: string, extra: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "X-Request-Id": requestId,
    ...CORS_HEADERS,
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
  json(res, status, body, requestId);
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

const ROLES: ChatRole[] = ["system", "user", "assistant"];

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
    if (typeof content !== "string" || content.trim() === "") {
      throw new ApiError(400, "bad_request", `messages[${index}].content должен быть непустой строкой.`);
    }
    return { role: role as ChatRole, content };
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

  return {
    messages,
    ...(typeof body.model === "string" ? { model: body.model } : {}),
    ...(typeof body.stream === "boolean" ? { stream: body.stream } : {}),
    ...(body.temperature !== undefined ? { temperature: Number(body.temperature) } : {}),
    ...(body.max_tokens !== undefined ? { max_tokens: Number(body.max_tokens) } : {}),
    ...(typeof body.system === "string" ? { system: body.system } : {}),
  };
}

/* ----------------------------------------------------------------- роутер ---- */

export interface ServerDeps {
  config: ApiConfig;
  limiter: ReturnType<typeof createRateLimiter>;
  provider: ReturnType<typeof selectProvider>;
}

function buildUpstreamRequest(request: ChatCompletionRequest, config: ApiConfig, requestId: string): UpstreamRequest {
  const system = [config.systemPrompt, request.system ?? ""].filter(Boolean).join("\n\n");
  return {
    messages: [{ role: "system", content: system }, ...request.messages.filter((message) => message.role !== "system")],
    model: request.model ?? config.defaultModel,
    system,
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.max_tokens !== undefined ? { maxTokens: request.max_tokens } : {}),
    requestId,
    timeoutMs: config.requestTimeoutMs,
  };
}

function healthPayload(config: ApiConfig): HealthResponse {
  return {
    status: "ok",
    service: "hikko-private-api",
    version: config.version,
    mode: config.mode,
    allowlist: config.allowlist,
    models: config.models,
    streaming: true,
    time: new Date().toISOString(),
  };
}

function accountPayload(email: string, method: AccountResponse["auth_method"], keyKind: AccountResponse["key_kind"], deps: ServerDeps, requestId: string): AccountResponse {
  const snapshot = deps.limiter.peek(email);
  return {
    email,
    allowed: true,
    auth_method: method,
    key_kind: keyKind,
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

async function handleChat(req: http.IncomingMessage, res: http.ServerResponse, deps: ServerDeps, requestId: string): Promise<void> {
  const identity = await authenticate({ headers: toHeaders(req), config: deps.config });
  const limit = deps.limiter.hit(identity.email);
  if (!limit.allowed) {
    json(
      res,
      429,
      { error: { message: `Превышен лимит ${limit.limit} запросов в минуту.`, code: "rate_limited", request_id: requestId } } satisfies ApiErrorBody,
      requestId,
      { "Retry-After": String(limit.retryAfterSeconds) },
    );
    return;
  }

  const request = validateChatRequest(await readBody(req, deps.config.maxBodyBytes));
  const upstreamRequest = buildUpstreamRequest(request, deps.config, requestId);
  const model = upstreamRequest.model;

  if (request.stream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Request-Id": requestId,
      "X-Accel-Buffering": "no",
      ...CORS_HEADERS,
    });
    res.flushHeaders?.();
    const reader = deps.provider.completeStream(upstreamRequest).getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const ok = res.write(Buffer.from(value as Uint8Array));
        if (!ok) await new Promise<void>((resolve) => res.once("drain", resolve));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.write(Buffer.from(`data: ${JSON.stringify({ error: { message, code: "upstream_error", request_id: requestId } })}\n\n`));
    } finally {
      reader.releaseLock();
      res.end();
    }
    return;
  }

  const result = await deps.provider.complete(upstreamRequest);
  const response: ChatCompletionResponse = {
    id: requestId,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: result.model || model,
    choices: [{ index: 0, message: { role: "assistant", content: result.text }, finish_reason: result.finishReason }],
    usage: {
      prompt_messages: request.messages.length,
      completion_chars: result.text.length,
      total_chars: request.messages.reduce((sum, message) => sum + message.content.length, 0) + result.text.length,
    },
    provider: result.provider,
    account: { email: identity.email },
    request_id: requestId,
  };
  json(res, 200, response, requestId);
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
  );
}

function servePlayground(res: http.ServerResponse, requestId: string): void {
  const file = path.join(repoRoot, "api", "playground.html");
  fs.readFile(file, (error, data) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "X-Request-Id": requestId, ...CORS_HEADERS });
      res.end("playground.html не найден");
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": data.length,
      "X-Request-Id": requestId,
      ...CORS_HEADERS,
    });
    res.end(data);
  });
}

/** Чистая функция маршрутизации — удобно тестировать без поднятого порта. */
export async function routeRequest(req: http.IncomingMessage, res: http.ServerResponse, deps: ServerDeps): Promise<void> {
  const requestId = (toHeaders(req).get("x-request-id") ?? crypto.randomUUID()).slice(0, 64);
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://internal");
  const route = url.pathname.replace(/\/+$/, "") || "/";

  if (method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  try {
    if (route === "/" && (method === "GET" || method === "HEAD")) {
      servePlayground(res, requestId);
      return;
    }
    if (route === "/api/v1/health" && (method === "GET" || method === "HEAD")) {
      json(res, 200, healthPayload(deps.config), requestId);
      return;
    }
    if (route === "/api/v1/account" && method === "GET") {
      const identity = await authenticate({ headers: toHeaders(req), config: deps.config });
      json(res, 200, accountPayload(identity.email, identity.method, identity.keyKind, deps, requestId), requestId);
      return;
    }
    if (route === "/api/v1/chat/completions" && method === "POST") {
      await handleChat(req, res, deps, requestId);
      return;
    }
    if (route === "/api/v1/admin/token" && method === "POST") {
      await handleAdminToken(req, res, deps, requestId);
      return;
    }

    const allowed = route === "/api/v1/health" || route === "/api/v1/account" || route === "/api/v1/chat/completions" || route === "/api/v1/admin/token" || route === "/";
    if (!allowed) {
      fail(res, requestId, 404, "not_found", `Маршрут ${route} не найден. Список: GET /api/v1/health, GET /api/v1/account, POST /api/v1/chat/completions.`, deps.config);
      return;
    }
    fail(res, requestId, 405, "method_not_allowed", `Метод ${method} не поддерживается маршрутом ${route}.`, deps.config);
  } catch (error) {
    if (error instanceof AuthError) {
      fail(res, requestId, error.status, error.code, error.message, deps.config);
      return;
    }
    if (error instanceof ApiError) {
      fail(res, requestId, error.status, error.code, error.message, deps.config);
      return;
    }
    if (error instanceof UpstreamError) {
      fail(res, requestId, error.status, "upstream_error", error.message, deps.config);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[${requestId}] необработанная ошибка:`, error);
    fail(res, requestId, 500, "internal_error", message, deps.config);
  }
}

/* ------------------------------------------------------------------ запуск ---- */

export function createServer(config: ApiConfig = loadConfig()): http.Server {
  const deps: ServerDeps = {
    config,
    limiter: createRateLimiter(config.rateLimitPerMinute),
    provider: selectProvider(config),
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
  const server = createServer(config);
  server.listen(config.port, config.host, () => {
    const shown = config.host === "0.0.0.0" ? "localhost" : config.host;
    console.log(`\n  hikkoGPT private API v${config.version}`);
    console.log(`  ➜  http://${shown}:${config.port}  (интерфейс ${config.host})`);
    console.log(`  ➜  режим модели: ${config.mode}${config.mode === "echo" ? " — ключи не заданы, ответы локальные" : ""}`);
    console.log(`  ➜  доступ разрешён: ${config.allowlist.join(", ")}`);
    for (const email of config.allowlist) {
      console.log(`  ➜  ключ для ${email}: ${apiKeyForEmail(email, config.secret, config.staticApiKey)}`);
    }
    console.log(`  ➜  песочница: http://${shown}:${config.port}/\n`);
  });

  const shutdown = (signal: string) => {
    console.log(`\n${signal}: останавливаю сервер…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
