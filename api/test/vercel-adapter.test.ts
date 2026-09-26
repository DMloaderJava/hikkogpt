/**
 * Vercel-адаптер (`api/api/[[...path]].ts`) проверяется без Vercel: подсовываем
 * объекты, которые ведут себя как платформа — тело уже разобрано и лежит в
 * `req.body`, а поток запроса вычитан, ответ умеет `writeHead`/`write`/`end`
 * (на этом держится SSE).
 *
 * Запуск: node --test api/test/
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type http from "node:http";
import type { VercelRequest, VercelResponse } from "@vercel/node";

import handler, { resolveConfig, resetAdapterCache } from "../api/[[...path]].ts";
import { apiKeyForEmail } from "../src/token.ts";
import type { AccountResponse, ChatCompletionResponse, HealthResponse } from "../src/types.ts";

const OWNER = "babaevafarida8@gmail.com";

interface MockResponse {
  status: number;
  headers: Record<string, string | number | string[]>;
  chunks: Buffer[];
  ended: boolean;
  res: http.ServerResponse;
  text: () => string;
  json: <T>() => T;
}

function envWith(overrides: Record<string, string>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  resetAdapterCache();
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetAdapterCache();
  };
}

function mockRequest(path: string, options: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): VercelRequest {
  // Vercel отдаёт handler-у уже разобранный JSON, а сам поток к этому моменту
  // закрыт — именно это и имитируем.
  const stream = Readable.from([]) as unknown as http.IncomingMessage;
  const request = stream as http.IncomingMessage & { body?: unknown; method: string; url: string; headers: Record<string, string> };
  request.method = options.method ?? "GET";
  request.url = path;
  request.headers = { host: "api.example.com", ...(options.headers ?? {}) };
  if (options.body !== undefined) request.body = options.body;
  return request as unknown as VercelRequest;
}

function mockResponse(): MockResponse {
  const state = {
    status: 200,
    headers: {} as Record<string, string | number | string[]>,
    chunks: [] as Buffer[],
    ended: false,
  };

  // Объект собираем как свободный набор полей и приводим к ServerResponse:
  // наш сервер работает с ним через writeHead/write/end/flushHeaders.
  const impl: Record<string, unknown> = {
    statusCode: 200,
    writableEnded: false,
    destroyed: false,
    writeHead(status: number, headers?: Record<string, string | number | string[]>) {
      state.status = status;
      res.statusCode = status;
      if (headers) Object.assign(state.headers, headers);
      return impl;
    },
    setHeader(name: string, value: string | number | string[]) {
      state.headers[name.toLowerCase()] = value;
    },
    getHeader(name: string) {
      return state.headers[name.toLowerCase()];
    },
    flushHeaders() {},
    write(chunk: string | Buffer) {
      state.chunks.push(Buffer.from(chunk));
      return true;
    },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) state.chunks.push(Buffer.from(chunk));
      state.ended = true;
      impl.writableEnded = true;
      return impl;
    },
    once(_event: string, callback: () => void) {
      setImmediate(callback);
      return impl;
    },
  };
  const res = impl as unknown as http.ServerResponse;

  const text = (): string => Buffer.concat(state.chunks).toString("utf8");
  return {
    get status() {
      return state.status;
    },
    get headers() {
      return state.headers;
    },
    get chunks() {
      return state.chunks;
    },
    get ended() {
      return state.ended;
    },
    res,
    text,
    json: <T,>(): T => JSON.parse(text()) as T,
  };
}

/* --------------------------------------------------------------- конфиг ---- */

test("resolveConfig: строгие production-дефолты и явные переопределения", () => {
  const restore = envWith({
    NODE_ENV: "production",
    HIKKO_API_SECRET: "smoke-vercel-secret",
    ALLOWED_EMAILS: OWNER,
  });
  try {
    const config = resolveConfig();
    assert.equal(config.isProduction, true);
    assert.equal(config.allowHeaderAuth, false);
    assert.equal(config.servePlayground, false);
    assert.equal(config.healthShowAllowlist, false);
    assert.equal(config.secret, "smoke-vercel-secret");
  } finally {
    restore();
  }

  const restore2 = envWith({
    NODE_ENV: "production",
    HIKKO_API_SECRET: "smoke-vercel-secret",
    SERVE_PLAYGROUND: "true",
    ALLOW_HEADER_AUTH: "true",
  });
  try {
    const config = resolveConfig();
    assert.equal(config.servePlayground, true);
    assert.equal(config.allowHeaderAuth, true);
  } finally {
    restore2();
  }
});

/* ------------------------------------------------------------- эндпоинты ---- */

async function call(path: string, options: Parameters<typeof mockRequest>[1] = {}): Promise<MockResponse> {
  const restore = envWith({
    NODE_ENV: "production",
    HIKKO_API_SECRET: "smoke-vercel-secret",
    ALLOWED_EMAILS: OWNER,
    RATE_LIMIT_PER_MINUTE: "0",
    SSE_KEEP_ALIVE_MS: "0",
    LOG_LEVEL: "silent",
  });
  try {
    const response = mockResponse();
    await handler(mockRequest(path, options), response.res as unknown as VercelResponse);
    return response;
  } finally {
    restore();
  }
}

const KEY = apiKeyForEmail(OWNER, "smoke-vercel-secret");

test("адаптер: /api/v1/health без ключа и со скрытым allowlist", async () => {
  const response = await call("/api/v1/health");
  assert.equal(response.status, 200);
  const health = response.json<HealthResponse>();
  assert.equal(health.status, "ok");
  assert.deepEqual(health.allowlist, []);
  assert.equal(response.headers["Content-Type"], "application/json; charset=utf-8");
  assert.ok(response.headers["X-Request-Id"]);
});

test("адаптер: доступ по ключу и отказ чужому адресу", async () => {
  const owner = await call("/api/v1/account", { headers: { Authorization: `Bearer ${KEY}` } });
  assert.equal(owner.status, 200);
  assert.equal(owner.json<AccountResponse>().email, OWNER);

  const stranger = await call("/api/v1/account", {
    headers: { Authorization: `Bearer ${apiKeyForEmail("other@example.com", "smoke-vercel-secret")}` },
  });
  assert.equal(stranger.status, 403);

  const anon = await call("/api/v1/account");
  assert.equal(anon.status, 401);

  const headerOnly = await call("/api/v1/account", { headers: { "X-Hikko-Email": OWNER } });
  assert.equal(headerOnly.status, 401, "в production заголовок не является пропуском");
});

test("адаптер: POST /v1/chat/completions c уже разобранным телом (как на Vercel)", async () => {
  const response = await call("/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: { model: "hikko-gpt", messages: [{ role: "user", content: "Проверка связи" }] },
  });
  assert.equal(response.status, 200);
  const data = response.json<ChatCompletionResponse>();
  assert.equal(data.object, "chat.completion");
  assert.equal(data.account.email, OWNER);
  assert.match(data.choices[0].message.content ?? "", /Проверка связи/);
});

test("адаптер: валидация тела работает и на разобранном JSON", async () => {
  const response = await call("/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}` },
    body: { messages: [] },
  });
  assert.equal(response.status, 400);
});

test("адаптер: SSE-поток доходит до [DONE]", async () => {
  const response = await call("/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}` },
    body: { messages: [{ role: "user", content: "Поток на Vercel" }], stream: true },
  });
  assert.equal(response.status, 200);
  assert.match(String(response.headers["Content-Type"]), /text\/event-stream/);
  const text = response.text();
  assert.ok(text.split("data: ").length > 3, "ожидали несколько чанков");
  assert.ok(text.trimEnd().endsWith("data: [DONE]"));
});

test("адаптер: песочница закрыта, но включается SERVE_PLAYGROUND=true", async () => {
  const closed = await call("/");
  assert.equal(closed.status, 404);

  const restore = envWith({
    NODE_ENV: "production",
    HIKKO_API_SECRET: "smoke-vercel-secret",
    SERVE_PLAYGROUND: "true",
    LOG_LEVEL: "silent",
  });
  try {
    const response = mockResponse();
    await handler(mockRequest("/"), response.res as unknown as VercelResponse);
    assert.equal(response.status, 200);
    assert.match(String(response.headers["Content-Type"]), /text\/html/);
    assert.match(response.text(), /приватный API/i);
  } finally {
    restore();
  }
});

test("адаптер: OpenAI-пути и OPTIONS-префлайс", async () => {
  const models = await call("/v1/models", { headers: { Authorization: `Bearer ${KEY}` } });
  assert.equal(models.status, 200);
  assert.equal(models.json<{ object: string }>().object, "list");

  const preflight = await call("/v1/chat/completions", { method: "OPTIONS" });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers["Access-Control-Allow-Origin"], "*");
});
