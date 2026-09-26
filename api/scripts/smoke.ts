/**
 * Смоук-проверка задеплоенного API.
 *
 *   node api/scripts/smoke.ts https://hikkogpt-api.vercel.app
 *   node api/scripts/smoke.ts --base-url http://localhost:8787 --api-key hk1.…
 *
 * Ключ берётся из `--api-key`, `HIKKO_API_KEY` или выводится из
 * `HIKKO_API_SECRET` + `--email` (тем же HMAC, что считает сервер).
 *
 * Проходит по чек-листу из api/docs/deploy.md и печатает отчёт:
 * ✅ — ок, ⚠️ — работает, но стоит поправить конфиг, ❌ — не работает.
 * Код возврата 1, если есть ❌ (удобно в CI и в скриптах деплоя).
 */
import { loadEnvFiles } from "../src/env.ts";
import { apiKeyForEmail } from "../src/token.ts";
import { DEFAULT_ALLOWED_EMAIL } from "../src/allowlist.ts";
import type {
  AccountResponse,
  ChatCompletionResponse,
  HealthResponse,
  ModelsResponse,
} from "../src/types.ts";

loadEnvFiles();

/* ------------------------------------------------------------------ аргументы */

interface Args {
  baseUrl: string;
  apiKey: string;
  email: string;
  foreignEmail: string;
  playground: boolean;
  expectHeaderAuth: boolean;
  timeoutMs: number;
}

function printHelp(): void {
  console.log(`
Смоук-проверка приватного API hikkoGPT

  node api/scripts/smoke.ts <base-url> [опции]

Опции:
  -u, --base-url <url>      адрес API (или переменная API_BASE_URL)
  -k, --api-key <key>       ключ доступа (или HIKKO_API_KEY)
      --email <e-mail>      адрес для вывода ключа из HIKKO_API_SECRET
      --foreign-email <…>   каким адресом проверять отказ (по умолчанию тестовый)
      --expect-playground   ожидать, что GET / отдаёт песочницу (dev-режим)
      --expect-header-auth  ожидать, что вход по X-Hikko-Email разрешён (dev-режим)
      --timeout <мс>        таймаут одного запроса (по умолчанию 45000)
`);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    baseUrl: process.env.API_BASE_URL ?? "",
    apiKey: process.env.HIKKO_API_KEY ?? "",
    email: process.env.HIKKO_ALLOWED_EMAIL ?? DEFAULT_ALLOWED_EMAIL,
    foreignEmail: "smoke-stranger@example.com",
    playground: false,
    expectHeaderAuth: false,
    timeoutMs: 45_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string => argv[++index] ?? "";
    switch (arg) {
      case "--base-url":
      case "-u":
        args.baseUrl = next();
        break;
      case "--api-key":
      case "-k":
        args.apiKey = next();
        break;
      case "--email":
        args.email = next();
        break;
      case "--foreign-email":
        args.foreignEmail = next();
        break;
      case "--expect-playground":
        args.playground = true;
        break;
      case "--expect-header-auth":
        args.expectHeaderAuth = true;
        break;
      case "--timeout":
        args.timeoutMs = Number.parseInt(next(), 10) || args.timeoutMs;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        if (arg && !arg.startsWith("-") && !args.baseUrl) args.baseUrl = arg;
    }
  }
  if (!args.baseUrl) {
    console.error("Не задан адрес API. Пример: node api/scripts/smoke.ts https://api.example.com");
    printHelp();
    process.exit(2);
  }
  args.baseUrl = args.baseUrl.replace(/\/+$/, "");
  if (!args.apiKey) {
    const secret = process.env.HIKKO_API_SECRET ?? "";
    if (!secret) {
      console.error("Нет ключа: передайте --api-key hk1.… или HIKKO_API_SECRET — тогда ключ выведется сам.");
      process.exit(2);
    }
    args.apiKey = apiKeyForEmail(args.email, secret);
  }
  return args;
}

/* -------------------------------------------------------------------- отчёт */

type Status = "ok" | "warn" | "fail" | "skip";
const ICON: Record<Status, string> = { ok: "✅", warn: "⚠️ ", fail: "❌", skip: "⏭️ " };

interface Result {
  name: string;
  status: Status;
  detail: string;
  ms: number;
}

const results: Result[] = [];

async function check(name: string, run: () => Promise<{ status: Status; detail: string }>): Promise<void> {
  const started = Date.now();
  try {
    const outcome = await run();
    results.push({ name, status: outcome.status, detail: outcome.detail, ms: Date.now() - started });
  } catch (error) {
    results.push({
      name,
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
      ms: Date.now() - started,
    });
  }
}

function skip(name: string, detail: string): void {
  results.push({ name, status: "skip", detail, ms: 0 });
}

interface ProbeResult {
  status: number;
  body: unknown;
  text: string;
  ms: number;
}

async function probe(url: string, init: RequestInit = {}, timeoutMs = 45_000): Promise<ProbeResult> {
  const started = Date.now();
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: response.status, body, text, ms: Date.now() - started };
}

/** Короткая выжимка из ответа — для сообщений об ошибках. */
function brief(res: ProbeResult): string {
  const oneLine = res.text.replace(/\s+/g, " ").trim();
  return oneLine.length > 160 ? `${oneLine.slice(0, 160)}…` : oneLine || "(пустое тело)";
}

/* ------------------------------------------------------------------- проверка */

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const auth = { Authorization: `Bearer ${args.apiKey}` };
  console.log(`\nСмоук-проверка: ${args.baseUrl}`);
  console.log(`Адрес для доступа: ${args.email}\n`);

  let mode = "unknown";

  await check("GET /health отвечает без ключа", async () => {
    const res = await probe(`${args.baseUrl}/api/v1/health`);
    if (res.status !== 200) return { status: "fail", detail: `HTTP ${res.status}` };
    const health = res.body as HealthResponse;
    if (health?.status !== "ok") return { status: "fail", detail: "в ответе нет status: ok" };
    mode = health.mode;
    return { status: "ok", detail: `service=${health.service} version=${health.version} mode=${health.mode}` };
  });

  await check("Модель подключена (не echo)", async () => {
    if (mode === "echo") {
      return {
        status: "warn",
        detail: "ключи модели не заданы — API отвечает заглушкой; для Cline нужны GEMINI_API_KEYS либо OPENAI_BASE_URL+OPENAI_API_KEY",
      };
    }
    return { status: "ok", detail: `mode=${mode}` };
  });

  await check("/health не раскрывает e-mail без ключа", async () => {
    const res = await probe(`${args.baseUrl}/api/v1/health`);
    const health = res.body as HealthResponse;
    const list = health?.allowlist ?? [];
    if (list.length === 0) return { status: "ok", detail: "allowlist скрыт" };
    return { status: "warn", detail: `allowlist виден всем: ${list.join(", ")} (HEALTH_SHOW_ALLOWLIST=true)` };
  });

  await check("Без ключа → 401", async () => {
    const res = await probe(`${args.baseUrl}/api/v1/account`);
    return res.status === 401
      ? { status: "ok", detail: "401 unauthorized" }
      : { status: "fail", detail: `ожидали 401, получили ${res.status}` };
  });

  await check("Чужой адрес → 403 или 401", async () => {
    const strangerKey = apiKeyForEmail(args.foreignEmail, "smoke-foreign-secret");
    const res = await probe(`${args.baseUrl}/api/v1/account`, {
      headers: { Authorization: `Bearer ${strangerKey}` },
    });
    return res.status === 403 || res.status === 401
      ? { status: "ok", detail: `${res.status} для ${args.foreignEmail}` }
      : { status: "fail", detail: `ожидали 401/403, получили ${res.status}` };
  });

  await check(
    args.expectHeaderAuth ? "Вход по X-Hikko-Email разрешён (dev)" : "Вход по заголовку X-Hikko-Email закрыт",
    async () => {
      const res = await probe(`${args.baseUrl}/api/v1/account`, { headers: { "X-Hikko-Email": args.email } });
      if (args.expectHeaderAuth) {
        return res.status === 200
          ? { status: "ok", detail: "200 по заголовку" }
          : { status: "fail", detail: `ожидали 200, получили ${res.status}` };
      }
      return res.status === 401
        ? { status: "ok", detail: "401 — заголовок не является пропуском" }
        : { status: "warn", detail: `HTTP ${res.status}: ALLOW_HEADER_AUTH включён, для production выключите` };
    },
  );

  await check(
    args.playground ? "Песочница на GET / доступна" : "Песочница на GET / закрыта",
    async () => {
      const res = await probe(`${args.baseUrl}/`);
      if (args.playground) {
        return res.status === 200
          ? { status: "ok", detail: "200 text/html" }
          : { status: "fail", detail: `HTTP ${res.status}` };
      }
      return res.status === 404
        ? { status: "ok", detail: "404 — SERVE_PLAYGROUND=false" }
        : { status: "warn", detail: `HTTP ${res.status}: страница открыта без ключа` };
    },
  );

  await check("Ключ владельца → 200 /account", async () => {
    const res = await probe(`${args.baseUrl}/api/v1/account`, { headers: auth });
    if (res.status !== 200) return { status: "fail", detail: `HTTP ${res.status}: ${brief(res)}` };
    const account = res.body as AccountResponse;
    if (account?.email?.toLowerCase() !== args.email.toLowerCase()) {
      return { status: "fail", detail: `сервер увидел ${account?.email ?? "?"} вместо ${args.email}` };
    }
    return {
      status: "ok",
      detail: `email=${account.email} auth=${account.auth_method} key=${account.key_kind} remaining=${account.rate_limit.remaining}`,
    };
  });

  await check("GET /v1/models (формат OpenAI)", async () => {
    const anon = await probe(`${args.baseUrl}/v1/models`);
    if (anon.status !== 401) return { status: "warn", detail: `без ключа HTTP ${anon.status} (ожидали 401)` };
    const res = await probe(`${args.baseUrl}/v1/models`, { headers: auth });
    if (res.status !== 200) return { status: "fail", detail: `HTTP ${res.status}: ${brief(res)}` };
    const models = res.body as ModelsResponse;
    if (models?.object !== "list" || !Array.isArray(models.data) || models.data.length === 0) {
      return { status: "fail", detail: "ответ не похож на {object:list,data:[…]}" };
    }
    return { status: "ok", detail: models.data.map((model) => model.id).join(", ") };
  });

  let chatMs = 0;
  await check("POST /v1/chat/completions", async () => {
    const res = await probe(
      `${args.baseUrl}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...auth },
        body: JSON.stringify({
          model: "hikko-gpt",
          messages: [{ role: "user", content: "Ответь одним словом: работаешь?" }],
        }),
      },
      args.timeoutMs,
    );
    chatMs = res.ms;
    if (res.status !== 200) return { status: "fail", detail: `HTTP ${res.status}: ${brief(res)}` };
    const data = res.body as ChatCompletionResponse;
    const text = data?.choices?.[0]?.message?.content ?? "";
    if (!text) return { status: "fail", detail: "пустой ответ" };
    return {
      status: "ok",
      detail: `provider=${data.provider} ${res.ms}ms «${text.slice(0, 60).replace(/\n/g, " ")}…»`,
    };
  });

  await check("Поток (stream: true) идёт чанками", async () => {
    const started = Date.now();
    const response = await fetch(`${args.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ messages: [{ role: "user", content: "Сосчитай до пяти словами" }], stream: true }),
      signal: AbortSignal.timeout(args.timeoutMs),
    });
    if (response.status !== 200) return { status: "fail", detail: `HTTP ${response.status}` };
    if (!response.body) return { status: "fail", detail: "нет тела ответа" };

    // Считаем не сетевые чанки (их склеивает и Node, и прокси), а SSE-события
    // и время до первого — это и есть признак живого потока.
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let events = 0;
    let firstEventMs = -1;
    let finished = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (firstEventMs < 0) firstEventMs = Date.now() - started;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === "[DONE]") {
          finished = true;
          continue;
        }
        events += 1;
      }
    }
    const totalMs = Date.now() - started;
    if (!finished) return { status: "fail", detail: "поток оборвался без data: [DONE]" };
    if (events < 2) {
      return { status: "warn", detail: `всего ${events} SSE-событий за ${totalMs}ms — поток похож на буферизованный` };
    }
    return {
      status: "ok",
      detail: `${events} SSE-событий, первое через ${firstEventMs}ms, всего ${totalMs}ms`,
    };
  });

  if (mode === "echo") {
    skip("Инструменты (tool_calls)", "в режиме echo модель не вызывает инструменты — задайте ключи и повторите");
  } else {
    await check("Инструменты (function calling)", async () => {
      const res = await probe(
        `${args.baseUrl}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...auth },
          body: JSON.stringify({
            model: "hikko-gpt",
            messages: [{ role: "user", content: "Узнай погоду в городе Аша. Обязательно используй инструмент." }],
            tools: [
              {
                type: "function",
                function: {
                  name: "get_weather",
                  description: "Погода в городе",
                  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
                },
              },
            ],
            tool_choice: "auto",
          }),
        },
        args.timeoutMs,
      );
      if (res.status !== 200) return { status: "fail", detail: `HTTP ${res.status}: ${brief(res)}` };
      const data = res.body as ChatCompletionResponse;
      const calls = data?.choices?.[0]?.message?.tool_calls ?? [];
      if (calls.length === 0) {
        return {
          status: "warn",
          detail: `модель ответила текстом вместо вызова инструмента (finish_reason=${data.choices[0].finish_reason})`,
        };
      }
      return { status: "ok", detail: `${calls[0].function.name}(${calls[0].function.arguments})` };
    });
  }

  await check("Неверный запрос → 400", async () => {
    const res = await probe(`${args.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ messages: [] }),
    });
    return res.status === 400
      ? { status: "ok", detail: "400 bad_request" }
      : { status: "fail", detail: `ожидали 400, получили ${res.status}` };
  });

  await check("Неизвестный маршрут → 404", async () => {
    const res = await probe(`${args.baseUrl}/v1/embeddings`, { headers: auth });
    return res.status === 404
      ? { status: "ok", detail: "404 not_found" }
      : { status: "warn", detail: `HTTP ${res.status}` };
  });

  await check("Задержка (прогрев/холодный старт)", async () => {
    const warm = (await probe(`${args.baseUrl}/api/v1/health`)).ms;
    const detail = `chat ${chatMs}ms, health ${warm}ms`;
    if (chatMs > 10_000) {
      return { status: "warn", detail: `${detail} — похоже на холодный старт serverless, проверьте maxDuration` };
    }
    return { status: "ok", detail };
  });

  /* --------------------------------------------------------------- итог ---- */

  const width = Math.max(...results.map((result) => result.name.length));
  const line = "─".repeat(Math.min(100, width + 60));
  console.log(line);
  for (const result of results) {
    console.log(`${ICON[result.status]} ${result.name.padEnd(width)}  ${result.detail}`);
  }
  const failed = results.filter((result) => result.status === "fail").length;
  const warned = results.filter((result) => result.status === "warn").length;
  const passed = results.filter((result) => result.status === "ok").length;
  const skipped = results.filter((result) => result.status === "skip").length;
  console.log(line);
  console.log(`Итого: ${passed} ✅, ${warned} ⚠️, ${failed} ❌, ${skipped} ⏭️  (режим модели: ${mode})`);
  if (failed > 0) {
    console.log("\nДеплоить рано — сначала исправьте ❌.");
    process.exitCode = 1;
  } else if (warned > 0) {
    console.log("\nРаботает, но загляните в ⚠️ — обычно это незаполненные переменные окружения.");
  } else {
    console.log("\nВсё зелёное — можно подключать Cline.");
  }
  console.log();
}

await main();
