/**
 * Продакшен-готовность: дефолты, которые нельзя выпускать наружу, и поведение
 * под нагрузкой/при обрыве соединения.
 *
 * Запуск: node --test api/test/
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { createServer } from "../src/server.ts";
import { assertProductionReady, DEFAULT_SECRET, readinessIssues } from "../src/config.ts";
import type { ApiConfig } from "../src/config.ts";
import type { Provider, UpstreamRequest, UpstreamResult } from "../src/upstream.ts";
import { createLogger, formatRequestLog } from "../src/log.ts";
import { apiKeyForEmail } from "../src/token.ts";
import type { HealthResponse } from "../src/types.ts";

const OWNER = "babaevafarida8@gmail.com";
const SECRET = "test-secret";
const KEY = apiKeyForEmail(OWNER, SECRET);

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
    models: ["hikko-gpt"],
    defaultModel: "hikko-gpt",
    allowUnknownModel: true,
    systemPrompt: "",
    rateLimitPerMinute: 0,
    maxBodyBytes: 100_000,
    requestTimeoutMs: 5_000,
    allowHeaderAuth: false,
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

async function withServer<T>(config: ApiConfig, run: (baseUrl: string) => Promise<T>, overrides = {}): Promise<T> {
  const server: http.Server = createServer(config, overrides);
  await new Promise<void>((resolve) => server.listen(0, config.host, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/* --------------------------------------------------- дефолты и production ---- */

test("дефолтный секрет из репозитория блокирует production-запуск", () => {
  const insecure = makeConfig({ isProduction: true, secret: DEFAULT_SECRET });
  assert.throws(() => createServer(insecure), /HIKKO_API_SECRET/);
  assert.throws(() => assertProductionReady(insecure), /Отказ запуска/);

  // С собственным секретом — запускается.
  assert.doesNotThrow(() => createServer(makeConfig({ isProduction: true, secret: "own-long-secret" })));
});

test("в dev дефолтный секрет — предупреждение, а не блокировка", () => {
  const issues = readinessIssues(makeConfig({ secret: DEFAULT_SECRET }));
  assert.equal(issues.length, 1);
  assert.equal(issues[0].level, "warn");
  assert.doesNotThrow(() => createServer(makeConfig({ secret: DEFAULT_SECRET })));
});

test("production-чеклист: вход по заголовку, песочница, CORS, echo", () => {
  const issues = readinessIssues(
    makeConfig({
      isProduction: true,
      secret: "own-long-secret",
      allowHeaderAuth: true,
      servePlayground: true,
      healthShowAllowlist: true,
      corsOrigin: "*",
      mode: "echo",
    }),
  );
  const messages = issues.map((issue) => issue.message).join(" | ");
  assert.match(messages, /ALLOW_HEADER_AUTH/);
  assert.match(messages, /SERVE_PLAYGROUND/);
  assert.match(messages, /HEALTH_SHOW_ALLOWLIST/);
  assert.match(messages, /CORS_ORIGIN/);
  assert.match(messages, /echo/);
  assert.ok(issues.every((issue) => issue.level === "warn"));
});

/* ------------------------------------------------------- приватность health ---- */

test("/health не раскрывает e-mail без ключа, но показывает его владельцу", async () => {
  await withServer(makeConfig({ healthShowAllowlist: false }), async (baseUrl) => {
    const anon = (await (await fetch(`${baseUrl}/api/v1/health`)).json()) as HealthResponse;
    assert.equal(anon.status, "ok");
    assert.deepEqual(anon.allowlist, []);

    const owner = await (
      await fetch(`${baseUrl}/api/v1/health`, { headers: { Authorization: `Bearer ${KEY}` } })
    ).json();
    assert.deepEqual((owner as HealthResponse).allowlist, [OWNER]);

    // Чужой ключ адрес не увидит (и health при этом останется 200 — это проверка живости).
    const stranger = await (
      await fetch(`${baseUrl}/api/v1/health`, {
        headers: { Authorization: `Bearer ${apiKeyForEmail("other@gmail.com", SECRET)}` },
      })
    ).json();
    assert.deepEqual((stranger as HealthResponse).allowlist, []);
  });
});

test("SERVE_PLAYGROUND=false убирает страницу-песочницу", async () => {
  await withServer(makeConfig({ servePlayground: false }), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 404);
  });
  await withServer(makeConfig({ servePlayground: true }), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  });
});

test("CORS_ORIGIN задаёт конкретный источник и добавляет Vary", async () => {
  await withServer(makeConfig({ corsOrigin: "https://app.example.com" }), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/v1/health`);
    assert.equal(res.headers.get("access-control-allow-origin"), "https://app.example.com");
    assert.equal(res.headers.get("vary"), "Origin");

    const preflight = await fetch(`${baseUrl}/v1/chat/completions`, { method: "OPTIONS" });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "https://app.example.com");
  });

  await withServer(makeConfig({ corsOrigin: "*" }), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/v1/health`);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.equal(res.headers.get("vary"), null);
  });
});

/* --------------------------------------------------------------- потоки ---- */

function fakeProvider(streamBody: ReadableStream<Uint8Array>): Provider {
  return {
    async complete(request: UpstreamRequest): Promise<UpstreamResult> {
      return { text: "ok", toolCalls: [], model: request.model, provider: "echo", finishReason: "stop" };
    },
    completeStream: () => streamBody,
  };
}

test("SSE keep-alive шлёт пинги, пока модель молчит", async () => {
  const silent = new ReadableStream<Uint8Array>({ start() {} }); // никогда не закрывается
  await withServer(
    makeConfig({ sseKeepAliveMs: 30 }),
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ messages: [{ role: "user", content: "думай долго" }], stream: true }),
        signal: AbortSignal.timeout(5_000),
      });
      assert.equal(res.status, 200);
      const reader = res.body!.getReader();
      const { value } = await reader.read();
      assert.equal(Buffer.from(value as Uint8Array).toString("utf8"), ": ping\n\n");
      await reader.cancel();
      reader.releaseLock();
    },
    { provider: fakeProvider(silent) },
  );
});

test("обрыв потока клиентом не роняет сервер", async () => {
  let endlessTimer: ReturnType<typeof setInterval> | undefined;
  const endless = new ReadableStream<Uint8Array>({
    start(controller) {
      endlessTimer = setInterval(() => {
        try {
          controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
        } catch {
          if (endlessTimer) clearInterval(endlessTimer); // поток отменили — больше не пишем
        }
      }, 5);
      endlessTimer.unref?.();
    },
    cancel() {
      if (endlessTimer) clearInterval(endlessTimer);
    },
  });
  await withServer(
    makeConfig(),
    async (baseUrl) => {
      const controller = new AbortController();
      const attempt = fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ messages: [{ role: "user", content: "поток" }], stream: true }),
        signal: controller.signal,
      }).catch(() => null);
      await new Promise((resolve) => setTimeout(resolve, 60));
      controller.abort();
      await attempt;

      // Сервер жив и отвечает дальше.
      const health = await fetch(`${baseUrl}/api/v1/health`);
      assert.equal(health.status, 200);
      if (endlessTimer) clearInterval(endlessTimer);
    },
    { provider: fakeProvider(endless) },
  );
});

/* ------------------------------------------------------------- лимиты ---- */

test("429 приходит один раз, с Retry-After и валидным JSON", async () => {
  await withServer(makeConfig({ rateLimitPerMinute: 1 }), async (baseUrl) => {
    const body = JSON.stringify({ messages: [{ role: "user", content: "ping" }] });
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` };
    const first = await fetch(`${baseUrl}/v1/chat/completions`, { method: "POST", headers, body });
    assert.equal(first.status, 200);

    const second = await fetch(`${baseUrl}/v1/chat/completions`, { method: "POST", headers, body });
    assert.equal(second.status, 429);
    assert.ok(Number(second.headers.get("retry-after") ?? "0") >= 1);
    const text = await second.text();
    const parsed = JSON.parse(text) as { error: { code: string; message: string } };
    assert.equal(parsed.error.code, "rate_limited");
    assert.match(parsed.error.message, /лимит/i);
    // тело не задублировано
    assert.equal(text.split('"code"').length - 1, 1);
  });
});

/* ---------------------------------------------------------------- логгер ---- */

test("createLogger: silent молчит, info — пишет", () => {
  const silentLines: string[] = [];
  const original = console.log;
  console.log = (line: string) => silentLines.push(line);
  try {
    createLogger({ logLevel: "silent" })("не должно попасть в вывод");
  } finally {
    console.log = original;
  }
  assert.deepEqual(silentLines, []);

  assert.match(
    formatRequestLog({
      method: "POST",
      route: "/v1/chat/completions",
      status: 200,
      startedAt: Date.now() - 12,
      requestId: "req-1",
      email: OWNER,
      authMethod: "token",
      model: "hikko-gpt",
      stream: true,
    }),
    /POST \/v1\/chat\/completions → 200 .*\[req-1\] babaevafarida8@gmail\.com\/token model=hikko-gpt stream/,
  );
});

test("логгер пишет строку на запрос и молчит при LOG_LEVEL=silent", async () => {
  const lines: string[] = [];
  await withServer(
    makeConfig(),
    async (baseUrl) => {
      await fetch(`${baseUrl}/api/v1/account`, { headers: { Authorization: `Bearer ${KEY}` } });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(lines.length, 1);
      assert.match(lines[0], /GET \/api\/v1\/account → 200/);
      assert.match(lines[0], new RegExp(OWNER));
      assert.match(lines[0], /token/);
    },
    { log: (message: string) => lines.push(message) },
  );

  const silent = createLogger(makeConfig({ logLevel: "silent" }));
  assert.doesNotThrow(() => silent("ничего не должно напечататься"));
});
