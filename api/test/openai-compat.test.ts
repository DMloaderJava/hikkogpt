/**
 * Проверка OpenAI-совместимости: то, на что смотрят Cline, Cursor, Continue,
 * LiteLLM и SDK `openai`.
 *
 * Запуск: node --test api/test/
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import path from "node:path";

import { createServer, isKnownModel } from "../src/server.ts";
import { apiKeyForEmail } from "../src/token.ts";
import { fromGeminiParts, toGeminiRequest } from "../src/upstream.ts";
import type { ApiConfig } from "../src/config.ts";
import type { ChatCompletionResponse, ChatMessage, ModelsResponse } from "../src/types.ts";
import { HikkoApiClient } from "../client/src/client.ts";

const SECRET = "test-secret";
const OWNER = "babaevafarida8@gmail.com";
const KEY = apiKeyForEmail(OWNER, SECRET);

const weatherTool = {
  type: "function" as const,
  function: {
    name: "get_weather",
    description: "Погода в городе",
    parameters: {
      type: "object" as const,
      properties: { city: { type: "string", description: "Город" } },
      required: ["city"],
    },
  },
};

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
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}`, ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
}

/* ------------------------------------------------------------- /v1/models ---- */

test("GET /v1/models отдаёт список в формате OpenAI (нужен Cline/Cursor)", async () => {
  await withServer(makeConfig(), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/models`, { headers: { Authorization: `Bearer ${KEY}` } });
    assert.equal(res.status, 200);
    const models = (await res.json()) as ModelsResponse;
    assert.equal(models.object, "list");
    assert.ok(models.data.length >= 3);
    for (const model of models.data) {
      assert.equal(model.object, "model");
      assert.equal(typeof model.id, "string");
      assert.equal(model.owned_by, "hikkogpt");
      assert.equal(model.supports_tools, true);
      assert.ok((model.context_window ?? 0) > 0);
    }
    assert.ok(models.data.some((model) => model.id === "hikko-gpt"));
  });
});

test("модели доступны по всем трём базовым URL и закрыты без ключа", async () => {
  await withServer(makeConfig(), async (baseUrl) => {
    for (const route of ["/v1/models", "/models", "/api/v1/models"]) {
      const res = await fetch(`${baseUrl}${route}`, { headers: { Authorization: `Bearer ${KEY}` } });
      assert.equal(res.status, 200, route);
    }
    const anon = await fetch(`${baseUrl}/v1/models`);
    assert.equal(anon.status, 401);
    const stranger = await fetch(`${baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKeyForEmail("other@gmail.com", SECRET)}` },
    });
    assert.equal(stranger.status, 403);
  });
});

/* ------------------------------------------------------- пути без /api/v1 ---- */

test("POST /v1/chat/completions и /chat/completions — те же эндпоинты", async () => {
  await withServer(makeConfig(), async (baseUrl) => {
    for (const route of ["/v1/chat/completions", "/chat/completions", "/api/v1/chat/completions"]) {
      const res = await post(`${baseUrl}${route}`, {
        model: "hikko-gpt",
        messages: [{ role: "user", content: "Привет" }],
      });
      assert.equal(res.status, 200, route);
      const data = (await res.json()) as ChatCompletionResponse;
      assert.equal(data.object, "chat.completion");
      assert.equal(data.choices[0].message.role, "assistant");
    }
  });
});

test("поток по пути /v1/chat/completions тоже работает", async () => {
  await withServer(makeConfig(), async (baseUrl) => {
    const res = await post(`${baseUrl}/v1/chat/completions`, {
      messages: [{ role: "user", content: "Поток" }],
      stream: true,
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const text = await res.text();
    assert.ok(text.trimEnd().endsWith("data: [DONE]"));
  });
});

/* ---------------------------------------------------- типичный запрос Cline ---- */

test("терпит полный OpenAI-пейлоад агента (n, user, top_p, stop, stream_options…)", async () => {
  await withServer(makeConfig(), async (baseUrl) => {
    const res = await post(`${baseUrl}/v1/chat/completions`, {
      model: "hikko-gpt",
      messages: [
        { role: "system", content: "Ты — агент Cline. Используй инструменты." },
        { role: "user", content: "Прочитай файл package.json" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"package.json"}' } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", name: "read_file", content: '{"name":"vite_react_shadcn_ts"}' },
        { role: "user", content: "Что там?" },
      ],
      tools: [
        weatherTool,
        { type: "function", function: { name: "read_file", parameters: { type: "object", properties: {} } } },
      ],
      tool_choice: "auto",
      temperature: 0.3,
      top_p: 0.9,
      max_tokens: 4096,
      stop: ["</task>"],
      n: 1,
      user: "cline",
      stream: false,
      stream_options: { include_usage: true },
      parallel_tool_calls: false,
      response_format: { type: "text" },
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as ChatCompletionResponse;
    assert.equal(data.choices[0].message.role, "assistant");
    assert.equal(data.usage.prompt_messages, 5);
  });
});

test("инструменты валидируются: мусор в tools/tool_choice → 400", async () => {
  await withServer(makeConfig(), async (baseUrl) => {
    const badTools = await post(`${baseUrl}/v1/chat/completions`, {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function" }],
    });
    assert.equal(badTools.status, 400);

    const badChoice = await post(`${baseUrl}/v1/chat/completions`, {
      messages: [{ role: "user", content: "hi" }],
      tools: [weatherTool],
      tool_choice: "sometimes",
    });
    assert.equal(badChoice.status, 400);

    const toolWithoutId = await post(`${baseUrl}/v1/chat/completions`, {
      messages: [{ role: "tool", content: "результат" }],
    });
    assert.equal(toolWithoutId.status, 400);

    const badStop = await post(`${baseUrl}/v1/chat/completions`, {
      messages: [{ role: "user", content: "hi" }],
      stop: 42,
    });
    assert.equal(badStop.status, 400);

    const badTopP = await post(`${baseUrl}/v1/chat/completions`, {
      messages: [{ role: "user", content: "hi" }],
      top_p: 5,
    });
    assert.equal(badTopP.status, 400);
  });
});

test("незнакомая модель: по умолчанию подменяется дефолтной, при строгом режиме — 400", async () => {
  await withServer(makeConfig(), async (baseUrl) => {
    const res = await post(`${baseUrl}/v1/chat/completions`, {
      model: "gpt-4o-из-списка-cline",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as ChatCompletionResponse).model, "hikko-gpt");
  });

  await withServer(makeConfig({ allowUnknownModel: false }), async (baseUrl) => {
    const res = await post(`${baseUrl}/v1/chat/completions`, {
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: { message: string } }).error.message, /неизвестна/);

    const ok = await post(`${baseUrl}/v1/chat/completions`, {
      model: "gemini-2.5-pro",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(ok.status, 200);
  });
});

test("isKnownModel понимает псевдонимы и gemini-*", () => {
  const config = makeConfig();
  assert.equal(isKnownModel("hikko-gpt", config), true);
  assert.equal(isKnownModel("HIKKO-GPT-TURBO", config), true);
  assert.equal(isKnownModel("gemini-2.5-pro", config), true);
  assert.equal(isKnownModel("gpt-4o", config), false);
});

test("CORS-префлайс проходит и для /v1-путей", async () => {
  await withServer(makeConfig(), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, { method: "OPTIONS" });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
  });
});

/* ------------------------------------------- маппинг инструментов Gemini ---- */

test("OpenAI-диалог с tool_calls → contents Gemini (functionCall/functionResponse)", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "Системный промпт клиента" },
    { role: "user", content: "Погода в Осло?" },
    {
      role: "assistant",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Oslo"}' } },
      ],
    },
    { role: "tool", tool_call_id: "call_1", name: "get_weather", content: '{"temp":12}' },
    { role: "tool", tool_call_id: "call_2", name: "get_time", content: "not-json" },
  ];

  const mapped = toGeminiRequest({
    messages,
    model: "hikko-gpt",
    tools: [weatherTool],
    toolChoice: "auto",
    requestId: "test",
    timeoutMs: 1000,
  });

  assert.equal(mapped.system, "Системный промпт клиента");
  assert.deepEqual(mapped.contents[0], { role: "user", parts: [{ text: "Погода в Осло?" }] });
  assert.deepEqual(mapped.contents[1], {
    role: "model",
    parts: [{ functionCall: { name: "get_weather", args: { city: "Oslo" } } }],
  });
  // два результата подряд склеиваются в одно user-сообщение
  assert.equal(mapped.contents[2].role, "user");
  assert.equal(mapped.contents[2].parts.length, 2);
  assert.deepEqual(mapped.contents[2].parts[0], { functionResponse: { name: "get_weather", response: { temp: 12 } } });
  assert.deepEqual(mapped.contents[2].parts[1], { functionResponse: { name: "get_time", response: { result: "not-json" } } });

  assert.deepEqual(mapped.tools, [
    {
      functionDeclarations: [
        {
          name: "get_weather",
          description: "Погода в городе",
          parameters: weatherTool.function.parameters,
        },
      ],
    },
  ]);
  assert.deepEqual(mapped.toolConfig, { functionCallingConfig: { mode: "AUTO" } });
});

test("tool_choice: none/required/конкретная функция → режимы Gemini", () => {
  const base = {
    messages: [{ role: "user", content: "hi" }] as ChatMessage[],
    model: "hikko-gpt",
    tools: [weatherTool],
    requestId: "t",
    timeoutMs: 1000,
  };
  assert.deepEqual(toGeminiRequest({ ...base, toolChoice: "none" }).toolConfig, {
    functionCallingConfig: { mode: "NONE" },
  });
  assert.deepEqual(toGeminiRequest({ ...base, toolChoice: "required" }).toolConfig, {
    functionCallingConfig: { mode: "ANY" },
  });
  assert.deepEqual(
    toGeminiRequest({ ...base, toolChoice: { type: "function", function: { name: "get_weather" } } }).toolConfig,
    { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["get_weather"] } },
  );
  // без инструментов tools/toolConfig не добавляются вовсе
  const { tools, toolConfig } = toGeminiRequest({ ...base, tools: undefined });
  assert.equal(tools, undefined);
  assert.equal(toolConfig, undefined);
});

test("ответ Gemini с functionCall → tool_calls в формате OpenAI", () => {
  const { text, toolCalls } = fromGeminiParts(
    [
      { text: "Сейчас посмотрю." },
      { functionCall: { name: "get_weather", args: { city: "Asha" } } },
    ],
    "gemini-2.5-flash",
  );
  assert.equal(text, "Сейчас посмотрю.");
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].type, "function");
  assert.equal(toolCalls[0].function.name, "get_weather");
  assert.deepEqual(JSON.parse(toolCalls[0].function.arguments), { city: "Asha" });
  assert.ok(toolCalls[0].id.startsWith("call_"));
});

/* -------------------------------------------------------------- SDK/клиент ---- */

test("SDK: models() и чат с инструментами через /v1", async () => {
  await withServer(makeConfig(), async (baseUrl) => {
    const api = new HikkoApiClient({ baseUrl, apiKey: KEY });
    const models = await api.models();
    assert.equal(models.object, "list");
    assert.ok(models.data.length > 0);

    const result = await api.chat([{ role: "user", content: "Привет" }], { tools: [weatherTool] });
    assert.equal(typeof result.text, "string");
    assert.equal(result.raw.object, "chat.completion");
  });
});

/* -------------------------------------------- настоящий SDK `openai` (если есть) */

const openaiInstalled = fs.existsSync(path.join(process.cwd(), "node_modules", "openai"));

test(
  "официальный SDK openai работает против нашего API (baseUrl http://…/v1)",
  { skip: openaiInstalled ? false : "пакет openai не установлен (npm i --no-save openai)" },
  async () => {
    await withServer(makeConfig(), async (baseUrl) => {
      const { default: OpenAI } = await import("openai");
      const client = new OpenAI({ baseURL: `${baseUrl}/v1`, apiKey: KEY, maxRetries: 0 });

      const models = await client.models.list();
      const ids = models.data.map((model) => model.id);
      assert.ok(ids.includes("hikko-gpt"));

      const completion = await client.chat.completions.create({
        model: "hikko-gpt",
        messages: [{ role: "user", content: "Скажи, что ты жив" }],
        tools: [weatherTool],
        tool_choice: "auto",
      });
      assert.equal(completion.object, "chat.completion");
      assert.equal(completion.choices[0].message.role, "assistant");
      assert.ok((completion.choices[0].message.content ?? "").length > 0);

      const stream = await client.chat.completions.create({
        model: "hikko-gpt",
        messages: [{ role: "user", content: "Поток через SDK" }],
        stream: true,
      });
      let assembled = "";
      let chunks = 0;
      for await (const part of stream) {
        chunks += 1;
        assembled += part.choices[0]?.delta?.content ?? "";
      }
      assert.ok(chunks > 1);
      assert.ok(assembled.length > 0);
    });
  },
);
