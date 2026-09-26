/**
 * Апстрим-провайдеры: куда API ходит за ответом модели.
 *
 * 1. `gemini`  — Google Gemini API напрямую, ключи из `GEMINI_API_KEYS`
 *               (перебор списка, как в `supabase/functions/chat/index.ts`).
 * 2. `openai`  — любой OpenAI-совместимый шлюз (`OPENAI_BASE_URL` + `OPENAI_API_KEY`,
 *               подходит Lovable AI Gateway).
 * 3. `echo`    — ключей нет: честная заглушка, чтобы пайплайн (доступ, валидация,
 *               стриминг, клиент) проверялся без единого секрета.
 *
 * Внешний контракт один и тот же — OpenAI-подобный: `complete()` возвращает текст
 * и/или `tool_calls`, `completeStream()` — `ReadableStream<Uint8Array>` c SSE-чанками.
 * Поэтому Cline/Cursor/Continue/LangChain могут ходить сюда как в обычный
 * «OpenAI Compatible»-эндпоинт, включая function calling.
 */
import { toGeminiModel } from "./config.ts";
import type { ApiConfig } from "./config.ts";
import type {
  ChatCompletionChunk,
  ChatMessage,
  ChunkToolCallDelta,
  FinishReason,
  ToolCall,
  ToolChoice,
  ToolDefinition,
} from "./types.ts";

export interface UpstreamRequest {
  messages: ChatMessage[];
  model: string;
  system?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stop?: string[];
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  requestId: string;
  timeoutMs: number;
}

export interface UpstreamResult {
  text: string;
  toolCalls: ToolCall[];
  model: string;
  provider: "gemini" | "openai-compatible" | "echo";
  finishReason: FinishReason;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
}

export class UpstreamError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
  }
}

/* ------------------------------------------------------------------ SSE ---- */

const encoder = new TextEncoder();

export function chunkToSse(chunk: ChatCompletionChunk): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`);
}

export const DONE_SSE: Uint8Array = encoder.encode("data: [DONE]\n\n");

export interface ChunkDelta {
  role?: "assistant";
  content?: string | null;
  toolCalls?: ChunkToolCallDelta[];
}

export function makeChunk(
  id: string,
  model: string,
  delta: ChunkDelta,
  finishReason: FinishReason | null,
  requestId?: string,
): ChatCompletionChunk {
  const deltaPayload: ChatCompletionChunk["choices"][number]["delta"] = {};
  if (delta.role !== undefined) deltaPayload.role = delta.role;
  if (delta.content !== undefined) deltaPayload.content = delta.content;
  if (delta.toolCalls !== undefined) deltaPayload.tool_calls = delta.toolCalls;
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: deltaPayload, finish_reason: finishReason }],
    ...(requestId ? { request_id: requestId } : {}),
  };
}

/** Разрезает поток байтов на SSE-строки `data: …` и отдаёт JSON-поле каждой. */
export function sseJsonLines(source: ReadableStream<Uint8Array>): ReadableStream<string> {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  return new ReadableStream<string>({
    async pull(controller) {
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline !== -1) {
          let line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          controller.enqueue(payload);
          return;
        }
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/* ------------------------------------------------- общий маппинг OpenAI ---- */

function mapFinishReason(reason: string | null | undefined, hadToolCalls: boolean): FinishReason {
  if (hadToolCalls) return "tool_calls";
  switch ((reason ?? "").toUpperCase()) {
    case "MAX_TOKENS":
    case "LENGTH":
      return "length";
    case "SAFETY":
    case "CONTENT_FILTER":
      return "content_filter";
    case "TOOL_CALLS":
    case "FUNCTION_CALL":
      return "tool_calls";
    default:
      return "stop";
  }
}

function callId(model: string, index: number, name: string): string {
  return `call_${model.replace(/[^a-z0-9]/gi, "").slice(0, 12)}_${index}_${name}`.slice(0, 64);
}

/* ----------------------------------------------------------------- echo ---- */

function echoReply(messages: ChatMessage[], tools: ToolDefinition[] = []): string {
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  const question = typeof lastUser?.content === "string" ? lastUser.content.trim() : "";
  const toolNote = tools.length > 0
    ? `Инструменты в запросе видны (${tools.map((tool) => tool.function?.name).filter(Boolean).join(", ")}), но в режиме \`echo\` модель их не вызывает.`
    : "";
  const lines = [
    "**API работает, но ключи модели не заданы** — отвечаю в режиме `echo`.",
    "",
    question ? `> ${question}` : "> (сообщение пустое)",
  ];
  if (toolNote) lines.push("", toolNote);
  lines.push(
    "",
    "Чтобы получать настоящие ответы (и function calling для Cline), задайте `GEMINI_API_KEYS` или `OPENAI_BASE_URL` + `OPENAI_API_KEY` и перезапустите сервер.",
  );
  return lines.join("\n");
}

function echoProvider() {
  return {
    async complete(request: UpstreamRequest): Promise<UpstreamResult> {
      return {
        text: echoReply(request.messages, request.tools),
        toolCalls: [],
        model: request.model,
        provider: "echo",
        finishReason: "stop",
      };
    },
    completeStream(request: UpstreamRequest): ReadableStream<Uint8Array> {
      const words = echoReply(request.messages, request.tools).split(/(\s+)/);
      let index = 0;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (index >= words.length) {
            controller.enqueue(chunkToSse(makeChunk(request.requestId, request.model, {}, "stop")));
            controller.enqueue(DONE_SSE);
            controller.close();
            return;
          }
          const piece = words[index++];
          if (piece) {
            controller.enqueue(
              chunkToSse(makeChunk(request.requestId, request.model, { content: piece }, null)),
            );
          }
        },
      });
    },
  };
}

/* --------------------------------------------------------------- gemini ---- */

interface GeminiPart {
  text?: string;
  functionCall?: { name?: string; args?: Record<string, unknown> };
  functionResponse?: { name?: string; response?: Record<string, unknown> };
}

interface GeminiContent {
  role: string;
  parts: GeminiPart[];
}

interface GeminiCandidate {
  content?: { parts?: GeminiPart[] };
  finishReason?: string;
}

/**
 * OpenAI-сообщения → contents Gemini.
 *
 * - `system`            → `systemInstruction`
 * - `assistant` c текстом → `model` + `text`
 * - `assistant` c `tool_calls` → `model` + `functionCall` (по одному на вызов)
 * - `tool` (результат)  → `user` + `functionResponse`; подряд идущие результаты
 *                         склеиваются в одно сообщение — Gemini этого требует
 */
export function toGeminiRequest(request: UpstreamRequest): {
  system: string;
  contents: GeminiContent[];
  tools?: unknown[];
  toolConfig?: unknown;
} {
  const systemParts: string[] = [];
  if (request.system) systemParts.push(request.system);
  const contents: GeminiContent[] = [];

  const pushFunctionResponse = (name: string, response: Record<string, unknown>) => {
    const last = contents.at(-1);
    const part: GeminiPart = { functionResponse: { name, response } };
    if (last && last.role === "user" && last.parts.every((item) => item.functionResponse)) {
      last.parts.push(part);
    } else {
      contents.push({ role: "user", parts: [part] });
    }
  };

  for (const message of request.messages) {
    const text = typeof message.content === "string" ? message.content : "";
    switch (message.role) {
      case "system":
        if (text) systemParts.push(text);
        break;
      case "user":
        contents.push({ role: "user", parts: [{ text: text || "(пусто)" }] });
        break;
      case "assistant": {
        const parts: GeminiPart[] = [];
        if (text) parts.push({ text });
        for (const call of message.tool_calls ?? []) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
          } catch {
            args = { _raw: call.function.arguments };
          }
          parts.push({ functionCall: { name: call.function.name, args } });
        }
        if (parts.length > 0) contents.push({ role: "model", parts });
        break;
      }
      case "tool": {
        let response: Record<string, unknown>;
        try {
          const parsed = JSON.parse(text || "{}") as unknown;
          response = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : { result: parsed };
        } catch {
          response = { result: text };
        }
        pushFunctionResponse(message.name ?? "tool", response);
        break;
      }
    }
  }

  const declarations = (request.tools ?? [])
    .filter((tool) => tool?.type === "function" && tool.function?.name)
    .map((tool) => ({
      name: tool.function.name,
      ...(tool.function.description ? { description: tool.function.description } : {}),
      ...(tool.function.parameters ? { parameters: tool.function.parameters } : {}),
    }));

  const choice = request.toolChoice;
  const mode =
    choice === "none"
      ? "NONE"
      : choice === "required"
        ? "ANY"
        : typeof choice === "object" && choice?.function?.name
          ? "ANY"
          : "AUTO";
  const allowedNames =
    typeof choice === "object" && choice?.function?.name ? [choice.function.name] : undefined;

  return {
    system: systemParts.join("\n\n"),
    contents: contents.length > 0 ? contents : [{ role: "user", parts: [{ text: "(пусто)" }] }],
    ...(declarations.length > 0 ? { tools: [{ functionDeclarations: declarations }] } : {}),
    ...(declarations.length > 0
      ? {
          toolConfig: {
            functionCallingConfig: {
              mode,
              ...(allowedNames ? { allowedFunctionNames: allowedNames } : {}),
            },
          },
        }
      : {}),
  };
}

/** parts ответа Gemini → текст + tool_calls в формате OpenAI. */
export function fromGeminiParts(parts: GeminiPart[] | undefined, model: string): { text: string; toolCalls: ToolCall[] } {
  let text = "";
  const toolCalls: ToolCall[] = [];
  for (const part of parts ?? []) {
    if (typeof part.text === "string") text += part.text;
    if (part.functionCall?.name) {
      toolCalls.push({
        id: callId(model, toolCalls.length, part.functionCall.name),
        type: "function",
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args ?? {}),
        },
      });
    }
  }
  return { text, toolCalls };
}

function geminiProvider(keys: string[]) {
  function body(request: UpstreamRequest): Record<string, unknown> {
    const mapped = toGeminiRequest(request);
    const generationConfig: Record<string, unknown> = {};
    if (request.temperature !== undefined) generationConfig.temperature = request.temperature;
    if (request.topP !== undefined) generationConfig.topP = request.topP;
    if (request.maxTokens !== undefined) generationConfig.maxOutputTokens = request.maxTokens;
    if (request.stop && request.stop.length > 0) generationConfig.stopSequences = request.stop;

    return {
      contents: mapped.contents,
      ...(mapped.system ? { systemInstruction: { parts: [{ text: mapped.system }] } } : {}),
      ...(mapped.tools ? { tools: mapped.tools } : {}),
      ...(mapped.toolConfig ? { toolConfig: mapped.toolConfig } : {}),
      ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
    };
  }

  async function call(request: UpstreamRequest, key: string, stream: boolean): Promise<Response> {
    const model = toGeminiModel(request.model, "gemini-2.5-flash");
    const action = stream ? "streamGenerateContent?alt=sse" : "generateContent";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:${action}&key=${key}`;
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body(request)),
      signal: AbortSignal.timeout(request.timeoutMs),
    });
  }

  return {
    async complete(request: UpstreamRequest): Promise<UpstreamResult> {
      const model = toGeminiModel(request.model, "gemini-2.5-flash");
      let lastError = "не удалось получить ответ Gemini";
      for (const key of keys) {
        try {
          const response = await call(request, key, false);
          if (!response.ok) {
            lastError = `${response.status}: ${(await response.text()).slice(0, 300)}`;
            continue;
          }
          const json = (await response.json()) as {
            candidates?: GeminiCandidate[];
            usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
          };
          const candidate = json.candidates?.[0];
          const { text, toolCalls } = fromGeminiParts(candidate?.content?.parts, model);
          if (!text && toolCalls.length === 0) {
            lastError = "Gemini вернул пустой ответ";
            continue;
          }
          return {
            text,
            toolCalls,
            model,
            provider: "gemini",
            finishReason: mapFinishReason(candidate?.finishReason, toolCalls.length > 0),
            usage: {
              ...(json.usageMetadata?.promptTokenCount !== undefined
                ? { promptTokens: json.usageMetadata.promptTokenCount }
                : {}),
              ...(json.usageMetadata?.candidatesTokenCount !== undefined
                ? { completionTokens: json.usageMetadata.candidatesTokenCount }
                : {}),
              ...(json.usageMetadata?.totalTokenCount !== undefined
                ? { totalTokens: json.usageMetadata.totalTokenCount }
                : {}),
            },
          };
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
      }
      throw new UpstreamError(`Gemini: ${lastError}`, 502);
    },

    completeStream(request: UpstreamRequest): ReadableStream<Uint8Array> {
      const model = toGeminiModel(request.model, "gemini-2.5-flash");
      let upstream: ReadableStream<Uint8Array> | null = null;
      let toolCallIndex = 0;

      const open = async (): Promise<ReadableStream<Uint8Array>> => {
        if (upstream) return upstream;
        let lastError = "не удалось открыть поток Gemini";
        for (const key of keys) {
          try {
            const response = await call(request, key, true);
            if (!response.ok || !response.body) {
              lastError = `${response.status}: ${(await response.text().catch(() => ""))?.slice(0, 300)}`;
              continue;
            }
            upstream = response.body;
            return upstream;
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
          }
        }
        throw new UpstreamError(`Gemini stream: ${lastError}`, 502);
      };

      return new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(chunkToSse(makeChunk(request.requestId, model, { role: "assistant" }, null)));
          let sawToolCalls = false;
          let finish: FinishReason = "stop";
          try {
            const source = await open();
            const lines = sseJsonLines(source).getReader();
            for (;;) {
              const { done, value } = await lines.read();
              if (done) break;
              try {
                const parsed = JSON.parse(value as string) as {
                  candidates?: GeminiCandidate[];
                };
                const candidate = parsed.candidates?.[0];
                const { text, toolCalls } = fromGeminiParts(candidate?.content?.parts, model);
                if (text) {
                  controller.enqueue(chunkToSse(makeChunk(request.requestId, model, { content: text }, null)));
                }
                for (const call of toolCalls) {
                  sawToolCalls = true;
                  // OpenAI-контракт: сначала id+имя, затем аргументы отдельным чанком.
                  controller.enqueue(
                    chunkToSse(
                      makeChunk(
                        request.requestId,
                        model,
                        {
                          toolCalls: [
                            {
                              index: toolCallIndex,
                              id: call.id,
                              type: "function",
                              function: { name: call.function.name, arguments: "" },
                            },
                          ],
                        },
                        null,
                      ),
                    ),
                  );
                  controller.enqueue(
                    chunkToSse(
                      makeChunk(
                        request.requestId,
                        model,
                        { toolCalls: [{ index: toolCallIndex, function: { arguments: call.function.arguments } }] },
                        null,
                      ),
                    ),
                  );
                  toolCallIndex += 1;
                }
                if (candidate?.finishReason) {
                  finish = mapFinishReason(candidate.finishReason, sawToolCalls);
                }
              } catch {
                /* битый чанк апстрима — пропускаем */
              }
            }
            controller.enqueue(chunkToSse(makeChunk(request.requestId, model, {}, sawToolCalls ? "tool_calls" : finish)));
            controller.enqueue(DONE_SSE);
            controller.close();
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            controller.enqueue(
              chunkToSse(makeChunk(request.requestId, model, { content: `\n[ошибка апстрима: ${message}]` }, "error")),
            );
            controller.enqueue(DONE_SSE);
            controller.close();
          }
        },
      });
    },
  };
}

/* --------------------------------------------------------------- openai ---- */

interface OpenAiToolCallWire {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
  index?: number;
}

function hasFunctionName(call: OpenAiToolCallWire | undefined): call is OpenAiToolCallWire & { function: { name: string; arguments?: string } } {
  return Boolean(call?.function?.name);
}

function normalizeToolCalls(calls: OpenAiToolCallWire[] | undefined): ToolCall[] {
  return (calls ?? [])
    .filter(hasFunctionName)
    .map((call, index) => ({
      id: call.id ?? `call_${index}`,
      type: "function" as const,
      function: {
        name: call.function.name,
        arguments: call.function.arguments ?? "{}",
      },
    }));
}

function openaiProvider(baseUrl: string, apiKey: string) {
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;

  async function call(request: UpstreamRequest, stream: boolean): Promise<Response> {
    const payload: Record<string, unknown> = {
      model: request.model,
      stream,
      messages: request.messages,
    };
    if (request.temperature !== undefined) payload.temperature = request.temperature;
    if (request.topP !== undefined) payload.top_p = request.topP;
    if (request.maxTokens !== undefined) payload.max_tokens = request.maxTokens;
    if (request.stop && request.stop.length > 0) payload.stop = request.stop;
    if (request.tools && request.tools.length > 0) {
      payload.tools = request.tools;
      if (request.toolChoice !== undefined) payload.tool_choice = request.toolChoice;
    }
    return fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(request.timeoutMs),
    });
  }

  return {
    async complete(request: UpstreamRequest): Promise<UpstreamResult> {
      const response = await call(request, false);
      if (!response.ok) {
        throw new UpstreamError(`${response.status}: ${(await response.text()).slice(0, 300)}`, 502);
      }
      const json = (await response.json()) as {
        choices?: Array<{
          message?: { content?: string | null; tool_calls?: OpenAiToolCallWire[] };
          finish_reason?: string;
        }>;
        model?: string;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      const toolCalls = normalizeToolCalls(json.choices?.[0]?.message?.tool_calls);
      return {
        text: json.choices?.[0]?.message?.content ?? "",
        toolCalls,
        model: json.model ?? request.model,
        provider: "openai-compatible",
        finishReason: mapFinishReason(json.choices?.[0]?.finish_reason, toolCalls.length > 0),
        usage: {
          ...(json.usage?.prompt_tokens !== undefined ? { promptTokens: json.usage.prompt_tokens } : {}),
          ...(json.usage?.completion_tokens !== undefined ? { completionTokens: json.usage.completion_tokens } : {}),
          ...(json.usage?.total_tokens !== undefined ? { totalTokens: json.usage.total_tokens } : {}),
        },
      };
    },

    completeStream(request: UpstreamRequest): ReadableStream<Uint8Array> {
      return new ReadableStream<Uint8Array>({
        async start(controller) {
          let sawToolCalls = false;
          let finish: FinishReason = "stop";
          try {
            const response = await call(request, true);
            if (!response.ok || !response.body) {
              throw new UpstreamError(
                `${response.status}: ${(await response.text().catch(() => ""))?.slice(0, 300)}`,
                502,
              );
            }
            const lines = sseJsonLines(response.body).getReader();
            for (;;) {
              const { done, value } = await lines.read();
              if (done) break;
              try {
                const parsed = JSON.parse(value as string) as {
                  choices?: Array<{
                    delta?: { content?: string | null; tool_calls?: OpenAiToolCallWire[] };
                    finish_reason?: string | null;
                  }>;
                };
                const choice = parsed.choices?.[0];
                const text = choice?.delta?.content ?? "";
                if (text) {
                  controller.enqueue(chunkToSse(makeChunk(request.requestId, request.model, { content: text }, null)));
                }
                for (const call of choice?.delta?.tool_calls ?? []) {
                  sawToolCalls = true;
                  const delta: ChunkToolCallDelta = { index: call.index ?? 0 };
                  if (call.id) delta.id = call.id;
                  if (call.type) delta.type = "function";
                  if (call.function?.name || call.function?.arguments) {
                    delta.function = {
                      ...(call.function?.name ? { name: call.function.name } : {}),
                      ...(call.function?.arguments ? { arguments: call.function.arguments } : {}),
                    };
                  }
                  controller.enqueue(chunkToSse(makeChunk(request.requestId, request.model, { toolCalls: [delta] }, null)));
                }
                if (choice?.finish_reason) finish = mapFinishReason(choice.finish_reason, sawToolCalls);
              } catch {
                /* пропускаем битый чанк */
              }
            }
            controller.enqueue(chunkToSse(makeChunk(request.requestId, request.model, {}, sawToolCalls ? "tool_calls" : finish)));
            controller.enqueue(DONE_SSE);
            controller.close();
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            controller.enqueue(
              chunkToSse(makeChunk(request.requestId, request.model, { content: `\n[ошибка апстрима: ${message}]` }, "error")),
            );
            controller.enqueue(DONE_SSE);
            controller.close();
          }
        },
      });
    },
  };
}

/* ------------------------------------------------------------- выборник ---- */

export type Provider = ReturnType<typeof echoProvider>;

export function selectProvider(config: ApiConfig): Provider {
  if (config.mode === "gemini" && config.geminiKeys.length > 0) {
    return geminiProvider(config.geminiKeys) as Provider;
  }
  if (config.mode === "openai" && config.openaiKey && config.openaiBaseUrl) {
    return openaiProvider(config.openaiBaseUrl, config.openaiKey) as Provider;
  }
  return echoProvider();
}
