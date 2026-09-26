/**
 * Интеграционные тесты HTTP-слоя: поднимаем настоящий сервер на свободном порту
 * и ходим в него fetch-ом. Режим `echo` — ключи апстрима не нужны.
 *
 * Запуск: node --test api/test/
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { createServer, validateChatRequest, ApiError } from "../src/server.ts";
import { apiKeyForEmail, issueToken } from "../src/token.ts";
import type { ApiConfig } from "../src/config.ts";
import type { AccountResponse, ChatCompletionResponse, HealthResponse } from "../src/types.ts";

const SECRET = "test-secret";
const OWNER = "babaevafarida8@gmail.com";

function makeConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    version: "test",
    isProduction: false,
    allowlist: [OWNER],
    secret: SECRET,
    staticApiKey: "",
    adminToken: "",
    geminiKeys: [],
    openaiBaseUrl: "",
    openaiKey: "",
    mode: "echo",
    models: ["hikko-gpt", "hikko-gpt-turbo", "hikko-gpt-smart"],
    defaultModel: "hikko-gpt",
    allowUnknownModel: true,
    systemPrompt: "Ты — hikkoGPT.",
    rateLimitPerMinute: 0, // в тестах лимит по умолчанию выключен
    maxBodyBytes: 100_000,
    requestTimeoutMs: 5_000,
    allowHeaderAuth: false, // доступ только по ключу, как в бою
    supabaseUrl: "",
    supabaseAnonKey: "",
    corsOrigin: "*",
    healthShowAllowlist: true,
    servePlayground: true,
    sseKeepAliveMs: 0,
    logLevel: "silent",
    ...overrides,
  };
}

async function withServer<T>(config: ApiConfig, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server: http.Server = createServer(config);
  await new Promise<void>((resolve) => server.listen(0, config.host, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
}

test("GET /api/v1/health открыт без авторизации и показывает белый список", async () => {
  await withServer(makeConfig(), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/v1/health`);
    assert.equal(res.status, 200);
    const health = (await res.json()) as HealthResponse;
    assert.equal(health.status, "ok");
    assert.equal(health.mode, "echo");
    assert.deepEqual(health.allowlist, [OWNER]);
    assert.ok(health.models.includes("hikko-gpt"));
  });
});

test("без ключа → 401, с чужим e-mail → 403", async () => {
  await withServer(makeConfig(), async (baseUrl) => {
    const anon = await fetch(`${baseUrl}/api/v1/account`);
    assert.equal(anon.status, 401);
    const anonBody = (await anon.json()) as { error: { code: string; allowed_emails: string[] } };
    assert.equal(anonBody.error.code, "unauthorized");
    assert.deepEqual(anonBody.error.allowed_emails, [OWNER]);

    const strangerKey = apiKeyForEmail("someone.else@example.com", SECRET);
    const stranger = await fetch(`${baseUrl}/api/v1/account`, {
      headers: { Authorization: `Bearer ${strangerKey}` },
    });
    assert.equal(stranger.status, 403);
    const body = (await stranger.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "forbidden");
    assert.match(body.error.message, /приватный|разрешён/i);
  });
});

test("ключ владельца адреса проходит и описан в /account", async () => {
  await withServer(makeConfig(), async (baseUrl) => {
    const key = apiKeyForEmail(OWNER, SECRET);
    const res = await fetch(`${baseUrl}/api/v1/account`, { headers: { Authorization: `Bearer ${key}` } });
    assert.equal(res.status, 200);
    const account = (await res.json()) as AccountResponse;
    assert.equal(account.email, OWNER);
    assert.equal(account.allowed, true);
    assert.equal(account.auth_method, "token");
    assert.equal(account.key_kind, "derived");
    assert.equal(account.unlimited, true);
    assert.ok(res.headers.get("x-request-id"));
  });
});

test("статический ключ HIKKO_API_KEY работает и привязан к разрешённому адресу", async () => {
  await withServer(makeConfig({ staticApiKey: "sk-static-test" }), async (baseUrl) => {
    const ok = await fetch(`${baseUrl}/api/v1/account`, {
      headers: { Authorization: "Bearer sk-static-test" },
    });
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as AccountResponse).auth_method, "api_key");

    const bad = await fetch(`${baseUrl}/api/v1/account`, {
      headers: { Authorization: "Bearer sk-wrong" },
    });
    assert.equal(bad.status, 401);
  });
});

test("истёкший ключ отклоняется", async () => {
  await withServer(makeConfig(), async (baseUrl) => {
    // выпущен 2 минуты назад со сроком жизни 60 секунд
    const expired = issueToken(OWNER, SECRET, 60, Math.floor(Date.now() / 1000) - 120).token;
    const res = await fetch(`${baseUrl}/api/v1/account`, { headers: { Authorization: `Bearer ${expired}` } });
    assert.equal(res.status, 401);
    assert.match(((await res.json()) as { error: { message: string } }).error.message, /истёк/i);
  });
});

test("POST /api/v1/chat/completions возвращает OpenAI-подобный ответ", async () => {
  await withServer(makeConfig(), async (baseUrl) => {
    const res = await post(
      `${baseUrl}/api/v1/chat/completions`,
      { model: "hikko-gpt", messages: [{ role: "user", content: "Привет!" }] },
      { Authorization: `Bearer ${apiKeyForEmail(OWNER, SECRET)}` },
    );
    assert.equal(res.status, 200);
    const data = (await res.json()) as ChatCompletionResponse;
    assert.equal(data.object, "chat.completion");
    assert.equal(data.provider, "echo");
    assert.equal(data.account.email, OWNER);
    assert.equal(data.choices[0].message.role, "assistant");
    assert.match(data.choices[0].message.content ?? "", /Привет!/);
    assert.equal(data.usage.prompt_messages, 1);
  });
});

test("stream: true отдаёт SSE-чанки и завершается [DONE]", async () => {
  await withServer(makeConfig(), async (baseUrl) => {
    const res = await post(
      `${baseUrl}/api/v1/chat/completions`,
      { messages: [{ role: "user", content: "Расскажи что-нибудь" }], stream: true },
      { Authorization: `Bearer ${apiKeyForEmail(OWNER, SECRET)}` },
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);

    const text = await res.text();
    const events = text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6).trim());
    assert.equal(events.at(-1), "[DONE]");

    const chunks = events.slice(0, -1).map((event) => JSON.parse(event)) as Array<{
      object: string;
      choices: Array<{ delta: { content?: string }; finish_reason: string | null }>;
    }>;
    assert.ok(chunks.every((chunk) => chunk.object === "chat.completion.chunk"));
    const assembled = chunks.map((chunk) => chunk.choices[0]?.delta?.content ?? "").join("");
    assert.match(assembled, /echo/);
    assert.equal(chunks.at(-1)?.choices[0]?.finish_reason, "stop");
  });
});

test("валидация тела: пустые messages и мусор в роли → 400", async () => {
  await withServer(makeConfig(), async (baseUrl) => {
    const headers = { Authorization: `Bearer ${apiKeyForEmail(OWNER, SECRET)}` };

    const empty = await post(`${baseUrl}/api/v1/chat/completions`, { messages: [] }, headers);
    assert.equal(empty.status, 400);
    assert.equal(((await empty.json()) as { error: { code: string } }).error.code, "bad_request");

    const badRole = await post(
      `${baseUrl}/api/v1/chat/completions`,
      { messages: [{ role: "wizard", content: "hi" }] },
      headers,
    );
    assert.equal(badRole.status, 400);

    const badTemperature = await post(
      `${baseUrl}/api/v1/chat/completions`,
      { messages: [{ role: "user", content: "hi" }], temperature: 7 },
      headers,
    );
    assert.equal(badTemperature.status, 400);
  });
});

test("rate limit: сверх лимита → 429 с Retry-After", async () => {
  await withServer(makeConfig({ rateLimitPerMinute: 2 }), async (baseUrl) => {
    const headers = { Authorization: `Bearer ${apiKeyForEmail(OWNER, SECRET)}` };
    const body = { messages: [{ role: "user", content: "ping" }] };
    assert.equal((await post(`${baseUrl}/api/v1/chat/completions`, body, headers)).status, 200);
    assert.equal((await post(`${baseUrl}/api/v1/chat/completions`, body, headers)).status, 200);

    const third = await post(`${baseUrl}/api/v1/chat/completions`, body, headers);
    assert.equal(third.status, 429);
    assert.ok(Number(third.headers.get("retry-after") ?? "0") >= 1);
    assert.equal(((await third.json()) as { error: { code: string } }).error.code, "rate_limited");
  });
});

test("выпуск ключа через /admin/token: без ADMIN_TOKEN — 404, с токеном — 201", async () => {
  await withServer(makeConfig(), async (baseUrl) => {
    const res = await post(`${baseUrl}/api/v1/admin/token`, { email: OWNER }, {});
    assert.equal(res.status, 404);
  });

  await withServer(makeConfig({ adminToken: "admin-secret" }), async (baseUrl) => {
    const denied = await post(`${baseUrl}/api/v1/admin/token`, { email: OWNER }, { Authorization: "Bearer nope" });
    assert.equal(denied.status, 403);

    const wrongEmail = await post(
      `${baseUrl}/api/v1/admin/token`,
      { email: "intruder@example.com" },
      { Authorization: "Bearer admin-secret" },
    );
    assert.equal(wrongEmail.status, 403);

    const issued = await post(
      `${baseUrl}/api/v1/admin/token`,
      { email: OWNER, ttl_seconds: 3600 },
      { Authorization: "Bearer admin-secret" },
    );
    assert.equal(issued.status, 201);
    const { token, expires_at } = (await issued.json()) as { token: string; expires_at: string | null };
    assert.ok(token.startsWith("hk1."));
    assert.ok(expires_at);

    // Выпущенным ключом можно пользоваться.
    const account = await fetch(`${baseUrl}/api/v1/account`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(account.status, 200);
  });
});

test("режим разработки: вход по заголовку X-Hikko-Email (только для разрешённого адреса)", async () => {
  await withServer(makeConfig({ allowHeaderAuth: true }), async (baseUrl) => {
    const owner = await fetch(`${baseUrl}/api/v1/account`, {
      headers: { "X-Hikko-Email": "  BabaevaFarida8@Gmail.com " },
    });
    assert.equal(owner.status, 200);
    const account = (await owner.json()) as AccountResponse;
    assert.equal(account.email, OWNER);
    assert.equal(account.auth_method, "dev_header");

    const stranger = await fetch(`${baseUrl}/api/v1/account`, {
      headers: { "X-Hikko-Email": "intruder@example.com" },
    });
    assert.equal(stranger.status, 403);
  });

  // По умолчанию (allowHeaderAuth: false) заголовок не является пропуском.
  await withServer(makeConfig(), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/v1/account`, {
      headers: { "X-Hikko-Email": OWNER },
    });
    assert.equal(res.status, 401);
  });
});

test("CORS: OPTIONS отвечает 204 и разрешает нужные заголовки", async () => {
  await withServer(makeConfig(), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/v1/chat/completions`, { method: "OPTIONS" });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.match(res.headers.get("access-control-allow-headers") ?? "", /x-hikko-email/);
  });
});

test("неизвестный маршрут → 404, неверный метод → 405", async () => {
  await withServer(makeConfig(), async (baseUrl) => {
    const missing = await fetch(`${baseUrl}/api/v1/nope`);
    assert.equal(missing.status, 404);

    const wrongMethod = await fetch(`${baseUrl}/api/v1/health`, { method: "POST" });
    assert.equal(wrongMethod.status, 405);
  });
});

test("validateChatRequest — чистая функция валидации", () => {
  const valid = validateChatRequest({ messages: [{ role: "user", content: "hi" }], temperature: 0.4 });
  assert.equal(valid.messages.length, 1);
  assert.equal(valid.temperature, 0.4);

  assert.throws(() => validateChatRequest({}), ApiError);
  assert.throws(() => validateChatRequest({ messages: [{ role: "user", content: "   " }] }), ApiError);
  assert.throws(() => validateChatRequest({ messages: [{ role: "user", content: "hi" }], max_tokens: 0 }), ApiError);
});
