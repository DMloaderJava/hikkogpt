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
 * Внешний контракт один и тот же: `complete()` возвращает текст,
 * `completeStream()` — `ReadableStream<Uint8Array>` c OpenAI-SSE-чанками.
 */
import { toGeminiModel } from "./config.ts";
import type { ApiConfig } from "./config.ts";
import type { ChatCompletionChunk, ChatMessage } from "./types.ts";

export interface UpstreamRequest {
  messages: ChatMessage[];
  model: string;
  system?: string;
  temperature?: number;
  maxTokens?: number;
  requestId: string;
  timeoutMs: number;
}

export interface UpstreamResult {
  text: string;
  model: string;
  provider: "gemini" | "openai-compatible" | "echo";
  finishReason: "stop" | "length" | "error";
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

export function makeChunk(
  id: string,
  model: string,
  delta: { role?: "assistant"; content?: string },
  finishReason: "stop" | "length" | "error" | null,
  requestId?: string,
): ChatCompletionChunk {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
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

/* ----------------------------------------------------------------- echo ---- */

function echoReply(messages: ChatMessage[]): string {
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  const question = lastUser?.content?.trim() ?? "";
  return [
    "**API работает, но ключи модели не заданы** — отвечаю в режиме `echo`.",
    "",
    question ? `> ${question}` : "> (сообщение пустое)",
    "",
    "Чтобы получать настоящие ответы, задайте `GEMINI_API_KEYS` (или `OPENAI_BASE_URL` + `OPENAI_API_KEY`) и перезапустите сервер.",
  ].join("\n");
}

function echoProvider() {
  return {
    async complete(request: UpstreamRequest): Promise<UpstreamResult> {
      return {
        text: echoReply(request.messages),
        model: request.model,
        provider: "echo",
        finishReason: "stop",
      };
    },
    completeStream(request: UpstreamRequest): ReadableStream<Uint8Array> {
      const words = echoReply(request.messages).split(/(\s+)/);
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
}

function toGeminiContents(messages: ChatMessage[]): { system: string; contents: Array<{ role: string; parts: GeminiPart[] }> } {
  const systemParts = messages.filter((message) => message.role === "system").map((message) => message.content);
  const contents = messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }],
    }));
  return { system: systemParts.join("\n\n"), contents };
}

function geminiProvider(keys: string[]) {
  async function call(
    request: UpstreamRequest,
    key: string,
    stream: boolean,
  ): Promise<Response> {
    const model = toGeminiModel(request.model, "gemini-2.5-flash");
    const { system, contents } = toGeminiContents(request.messages);
    const action = stream ? "streamGenerateContent?alt=sse" : "generateContent";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:${action}&key=${key}`;
    const body = {
      contents,
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      generationConfig: {
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.maxTokens !== undefined ? { maxOutputTokens: request.maxTokens } : {}),
      },
    };
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(request.timeoutMs),
    });
  }

  return {
    async complete(request: UpstreamRequest): Promise<UpstreamResult> {
      let lastError = "не удалось получить ответ Gemini";
      for (const key of keys) {
        try {
          const response = await call(request, key, false);
          if (!response.ok) {
            lastError = `${response.status}: ${(await response.text()).slice(0, 300)}`;
            continue;
          }
          const json = (await response.json()) as {
            candidates?: Array<{
              content?: { parts?: GeminiPart[] };
              finishReason?: string;
            }>;
          };
          const candidate = json.candidates?.[0];
          const text = candidate?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
          if (!text) {
            lastError = "Gemini вернул пустой ответ";
            continue;
          }
          return {
            text,
            model: toGeminiModel(request.model, "gemini-2.5-flash"),
            provider: "gemini",
            finishReason: candidate?.finishReason === "MAX_TOKENS" ? "length" : "stop",
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
          try {
            const source = await open();
            const lines = sseJsonLines(source).getReader();
            for (;;) {
              const { done, value } = await lines.read();
              if (done) break;
              try {
                const parsed = JSON.parse(value as string) as {
                  candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
                };
                const text =
                  parsed.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
                if (text) {
                  controller.enqueue(chunkToSse(makeChunk(request.requestId, model, { content: text }, null)));
                }
              } catch {
                /* битый чанк апстрима — пропускаем */
              }
            }
            controller.enqueue(chunkToSse(makeChunk(request.requestId, model, {}, "stop")));
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

function openaiProvider(baseUrl: string, apiKey: string) {
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;

  async function call(request: UpstreamRequest, stream: boolean): Promise<Response> {
    return fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: request.model,
        stream,
        messages: request.messages,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
      }),
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
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
        model?: string;
      };
      return {
        text: json.choices?.[0]?.message?.content ?? "",
        model: json.model ?? request.model,
        provider: "openai-compatible",
        finishReason: json.choices?.[0]?.finish_reason === "length" ? "length" : "stop",
      };
    },

    completeStream(request: UpstreamRequest): ReadableStream<Uint8Array> {
      let opened: Response | null = null;
      return new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            opened = await call(request, true);
            if (!opened.ok || !opened.body) {
              throw new UpstreamError(`${opened.status}: ${(await opened.text().catch(() => ""))?.slice(0, 300)}`, 502);
            }
            const lines = sseJsonLines(opened.body).getReader();
            for (;;) {
              const { done, value } = await lines.read();
              if (done) break;
              try {
                const parsed = JSON.parse(value as string) as {
                  choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
                };
                const text = parsed.choices?.[0]?.delta?.content ?? "";
                if (text) {
                  controller.enqueue(chunkToSse(makeChunk(request.requestId, request.model, { content: text }, null)));
                }
                if (parsed.choices?.[0]?.finish_reason) break;
              } catch {
                /* пропускаем битый чанк */
              }
            }
            controller.enqueue(chunkToSse(makeChunk(request.requestId, request.model, {}, "stop")));
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
