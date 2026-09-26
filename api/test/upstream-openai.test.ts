/**
 * Проверка сквозного прохода через OpenAI-совместимый апстрим.
 *
 * Поднимаем поддельный «шлюз» (как Lovable AI Gateway или OpenRouter), который
 * умеет и text, и function calling, и SSE — и смотрим, что наш API корректно
 * прокидывает `tool_calls` наружу, в том числе дельтами в потоке. Сеть не нужна:
 * оба сервера на 127.0.0.1.
 *
 * Запуск: node --test api/test/
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { createServer } from "../src/server.ts";
import { apiKeyForEmail } from "../src/token.ts";
import type { ApiConfig } from "../src/config.ts";
import type { ChatCompletionResponse } from "../src/types.ts";

const SECRET = "test-secret";
const OWNER = "babaevafarida8@gmail.com";
const KEY = apiKeyForEmail(OWNER, SECRET);
const UPSTREAM_KEY = "upstream-secret";

interface UpstreamLog {
  lastBody: Record<string, unknown> | null;
  lastAuth: string | null;
  hits: number;
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Поддельный OpenAI-совместимый шлюз. */
function startFakeUpstream(log: UpstreamLog): http.Server {
  return http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      log.hits += 1;
      log.lastAuth = req.headers.authorization ?? null;
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
      log.lastBody = body;

      const wantsTools = Array.isArray(body.tools) && body.tools.length > 0;
      const model = String(body.model ?? "upstream-model");

      if (body.stream === true) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
        if (wantsTools) {
          send({
            object: "chat.completion.chunk",
            model,
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [
                    { index: 0, id: "call_upstream_1", type: "function", function: { name: "get_weather", arguments: "" } },
                  ],
                },
                finish_reason: null,
              },
            ],
          });
          send({
            object: "chat.completion.chunk",
            model,
            choices: [
              { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }, finish_reason: null },
            ],
          });
          send({
            object: "chat.completion.chunk",
            model,
            choices: [
              { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Asha"}' } }] }, finish_reason: null },
            ],
          });
          send({ object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
        } else {
          for (const piece of ["При", "вет ", "из ", "шлюза"]) {
            send({ object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
          }
          send({ object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
        }
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      const payload = wantsTools
        ? {
            object: "chat.completion",
            model,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_upstream_1",
                      type: "function",
                      function: { name: "get_weather", arguments: '{"city":"Asha"}' },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 },
          }
        : {
            object: "chat.completion",
            model,
            choices: [{ index: 0, message: { role: "assistant", content: "Привет из шлюза" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
          };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
}

function apiConfig(upstreamPort: number): ApiConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    version: "test",
    allowlist: [OWNER],
    secret: SECRET,
    staticApiKey: "",
    adminToken: "",
    geminiKeys: [],
    openaiBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    openaiKey: UPSTREAM_KEY,
    mode: "openai",
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
  };
}

async function run(log: UpstreamLog, body: unknown): Promise<{ status: number; text: string }> {
  const upstream = startFakeUpstream(log);
  const upstreamPort = await listen(upstream);
  const api = createServer(apiConfig(upstreamPort));
  const apiPort = await listen(api);
  try {
    const res = await fetch(`http://127.0.0.1:${apiPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    return { status: res.status, text: await res.text() };
  } finally {
    await close(api);
    await close(upstream);
  }
}

const tools = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Погода",
      parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    },
  },
];

test("шлюз: текст, usage и проброс ключа апстрима", async () => {
  const log: UpstreamLog = { lastBody: null, lastAuth: null, hits: 0 };
  const { status, text } = await run(log, { model: "hikko-gpt", messages: [{ role: "user", content: "Привет" }] });
  assert.equal(status, 200);

  const data = JSON.parse(text) as ChatCompletionResponse;
  assert.equal(data.provider, "openai-compatible");
  assert.equal(data.choices[0].message.content, "Привет из шлюза");
  assert.equal(data.choices[0].finish_reason, "stop");
  assert.equal(data.usage.prompt_tokens, 10);
  assert.equal(data.usage.total_tokens, 14);
  assert.equal(data.account.email, OWNER);

  assert.equal(log.hits, 1);
  assert.equal(log.lastAuth, `Bearer ${UPSTREAM_KEY}`);
  assert.equal(log.lastBody?.model, "hikko-gpt");
});

test("шлюз: tool_calls приходят наружу в формате OpenAI", async () => {
  const log: UpstreamLog = { lastBody: null, lastAuth: null, hits: 0 };
  const { status, text } = await run(
    log,
    {
      model: "hikko-gpt",
      messages: [{ role: "user", content: "Погода в Аше?" }],
      tools,
      tool_choice: "auto",
      temperature: 0.2,
      stop: ["</task>"],
    },
  );
  assert.equal(status, 200);

  const data = JSON.parse(text) as ChatCompletionResponse;
  assert.equal(data.choices[0].finish_reason, "tool_calls");
  const calls = data.choices[0].message.tool_calls ?? [];
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, "call_upstream_1");
  assert.equal(calls[0].type, "function");
  assert.equal(calls[0].function.name, "get_weather");
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { city: "Asha" });

  // инструменты и параметры дошли до апстрима без искажений
  assert.deepEqual(log.lastBody?.tools, tools);
  assert.equal(log.lastBody?.tool_choice, "auto");
  assert.equal(log.lastBody?.temperature, 0.2);
  assert.deepEqual(log.lastBody?.stop, ["</task>"]);
});

test("шлюз: поток с tool_calls собирается из дельт", async () => {
  const log: UpstreamLog = { lastBody: null, lastAuth: null, hits: 0 };
  const { status, text } = await run(
    log,
    { messages: [{ role: "user", content: "Погода?" }], tools, stream: true },
  );
  assert.equal(status, 200);

  const events = text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6).trim());
  assert.equal(events.at(-1), "[DONE]");

  type Delta = { content?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> };
  const chunks = events.slice(0, -1).map((event) => JSON.parse(event)) as Array<{ choices: Array<{ delta: Delta; finish_reason: string | null }> }>;

  let assembled = "";
  const calls = new Map<number, { id?: string; name?: string; args: string }>();
  for (const chunk of chunks) {
    const delta = chunk.choices[0].delta;
    if (delta.content) assembled += delta.content;
    for (const call of delta.tool_calls ?? []) {
      const index = call.index ?? 0;
      const entry = calls.get(index) ?? { args: "" };
      if (call.id) entry.id = call.id;
      if (call.function?.name) entry.name = call.function.name;
      if (call.function?.arguments) entry.args += call.function.arguments;
      calls.set(index, entry);
    }
  }

  assert.equal(assembled, "");
  assert.equal(calls.size, 1);
  const call = calls.get(0);
  assert.equal(call?.id, "call_upstream_1");
  assert.equal(call?.name, "get_weather");
  assert.deepEqual(JSON.parse(call?.args ?? "{}"), { city: "Asha" });
  assert.equal(chunks.at(-1)?.choices[0].finish_reason, "tool_calls");
});

test("шлюз: обычный поток склеивается в текст", async () => {
  const log: UpstreamLog = { lastBody: null, lastAuth: null, hits: 0 };
  const { status, text } = await run(
    log,
    { messages: [{ role: "user", content: "Привет" }], stream: true },
  );
  assert.equal(status, 200);
  const chunks = text
    .split("\n")
    .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
    .map((line) => JSON.parse(line.slice(6))) as Array<{ choices: Array<{ delta: { content?: string } }> }>;
  const assembled = chunks.map((chunk) => chunk.choices[0].delta.content ?? "").join("");
  assert.equal(assembled, "Привет из шлюза");
});

test("апстрим отказал → 502 upstream_error с его текстом", async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "invalid api key" } }));
  });
  const upstreamPort = await listen(upstream);
  const api = createServer(apiConfig(upstreamPort));
  const apiPort = await listen(api);
  try {
    const res = await fetch(`http://127.0.0.1:${apiPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ messages: [{ role: "user", content: "Привет" }] }),
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(res.status, 502);
    const body = (await res.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "upstream_error");
    assert.match(body.error.message, /invalid api key/);
  } finally {
    await close(api);
    await close(upstream);
  }
});
