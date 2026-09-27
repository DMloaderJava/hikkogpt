/**
 * Общий слой прямого доступа к Google Generative Language API для edge-функций.
 *
 * - Ротация ключей: сначала ключи пользователя из настроек (с активного
 *   индекса, по кругу), затем серверные GEMINI_API_KEYS.
 * - Фолбэк моделей: 404 → следующая модель; 400 → фатально (битый запрос).
 * - Значения ключей никогда не логируются.
 *
 * Модуль специально без внешних импортов (кроме fetch), чтобы его можно было
 * тестировать в vitest: см. src/test/geminiShared.test.ts.
 */

export type AiProvider = "lovable" | "gemini";
export type KeySource = "user" | "server" | "lovable";

export interface KeyAttempt {
  key: string;
  source: "user" | "server";
  /** Индекс в массиве ключей пользователя (-1 для серверных). */
  userIndex: number;
}

export interface GeminiSuccess<T> {
  ok: true;
  data: T;
  source: "user" | "server";
  userIndex: number;
  model: string;
}

export interface GeminiFailure {
  ok: false;
  status: number;
  message: string;
}

export interface GeminiStreamSuccess {
  ok: true;
  resp: Response;
  source: "user" | "server";
  userIndex: number;
  model: string;
}

export const MAX_CLIENT_KEYS = 15;

/** Выбор провайдера из тела запроса; дефолт — lovable. */
export function parseProvider(value: unknown): AiProvider {
  return value === "gemini" ? "gemini" : "lovable";
}

/** Санитизация ключей пользователя из тела запроса (до 15). */
export function resolveClientKeys(userKeys: unknown, max: number = MAX_CLIENT_KEYS): string[] {
  if (!Array.isArray(userKeys)) return [];
  return userKeys
    .filter((k): k is string => typeof k === "string" && k.trim().length >= 8 && k.trim().length <= 300)
    .map((k) => k.trim())
    .slice(0, max);
}

export function resolveStartIndex(userKeyIndex: unknown): number {
  return Number.isInteger(userKeyIndex) && (userKeyIndex as number) >= 0
    ? (userKeyIndex as number)
    : 0;
}

/** Серверные ключи из секрета GEMINI_API_KEYS (разделители: пробел/запятая/перенос). */
export function parseServerKeys(raw: string | undefined | null): string[] {
  return (raw || "").split(/[\s,;\n]+/).map((k) => k.trim()).filter(Boolean);
}

/**
 * Упорядоченный список попыток: ключи пользователя с активного индекса
 * по кругу, затем серверные (без дублей уже перебранных).
 */
export function buildAttempts(
  clientKeys: string[],
  startIndex: number,
  serverKeys: string[],
): KeyAttempt[] {
  const attempts: KeyAttempt[] = [];
  if (clientKeys.length > 0) {
    const start = ((startIndex % clientKeys.length) + clientKeys.length) % clientKeys.length;
    for (let i = 0; i < clientKeys.length; i++) {
      const idx = (start + i) % clientKeys.length;
      attempts.push({ key: clientKeys[idx], source: "user", userIndex: idx });
    }
  }
  const tried = new Set(attempts.map((a) => a.key));
  for (const key of serverKeys) {
    if (!tried.has(key)) {
      tried.add(key);
      attempts.push({ key, source: "server", userIndex: -1 });
    }
  }
  return attempts;
}

type FetchFn = typeof fetch;

interface RotationInternal {
  resp: Response;
  source: "user" | "server";
  userIndex: number;
  model: string;
}

async function rotateFetch(
  attempts: KeyAttempt[],
  models: string[],
  buildUrl: (model: string, key: string) => string,
  init: RequestInit,
  fetchFn: FetchFn,
  label: string,
): Promise<RotationInternal | GeminiFailure> {
  let lastStatus = 503;
  let lastMessage = "Нет доступных ключей Gemini API";

  for (const model of models) {
    let modelMissing = false;
    for (const attempt of attempts) {
      let resp: Response;
      try {
        resp = await fetchFn(buildUrl(model, attempt.key), init);
      } catch (e) {
        lastStatus = 503;
        lastMessage = e instanceof Error ? e.message : "Network error";
        console.warn(`[gemini:${label}] ${model} network error:`, lastMessage);
        continue;
      }
      if (resp.ok) {
        return { resp, source: attempt.source, userIndex: attempt.userIndex, model };
      }
      const snippet = await resp.text().catch(() => "").then((t) => t.slice(0, 200));
      console.warn(`[gemini:${label}] ${model} [${resp.status}]: ${snippet}`);
      // 404 = модели нет: перебирать остальные ключи бессмысленно.
      if (resp.status === 404) {
        modelMissing = true;
        lastStatus = 404;
        lastMessage = `Модель ${model} недоступна`;
        break;
      }
      // 400 = битый запрос: одинаков для всех ключей и моделей.
      if (resp.status === 400) {
        return { ok: false, status: 400, message: snippet || "Некорректный запрос к Gemini API" };
      }
      lastStatus = resp.status;
      lastMessage = snippet || `Gemini API error ${resp.status}`;
    }
    // Ключи исчерпаны, но модель существует — пробуем следующую модель
    // (у моделей раздельные квоты), иначе выходим.
    if (!modelMissing) {
      // Все ключи перебраны: следующая модель — новый шанс, продолжаем цикл.
    }
  }

  return { ok: false, status: lastStatus, message: lastMessage };
}

/**
 * Нестриминговый generateContent с ротацией ключей и фолбэком моделей.
 * Возвращает распарсенный JSON успешного ответа.
 */
export async function geminiGenerate(
  attempts: KeyAttempt[],
  models: string[],
  payload: Record<string, unknown>,
  opts: { signal?: AbortSignal | null; fetchFn?: FetchFn; label?: string } = {},
): Promise<GeminiSuccess<any> | GeminiFailure> {
  if (attempts.length === 0 || models.length === 0) {
    return { ok: false, status: 503, message: "Нет доступных ключей Gemini API" };
  }
  const fetchFn = opts.fetchFn ?? fetch;
  const result = await rotateFetch(
    attempts,
    models,
    (model, key) =>
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      ...(opts.signal ? { signal: opts.signal } : {}),
    },
    fetchFn,
    opts.label ?? "generate",
  );
  if (!("resp" in result)) return result;
  try {
    const data = await result.resp.json();
    return { ok: true, data, source: result.source, userIndex: result.userIndex, model: result.model };
  } catch {
    return { ok: false, status: 502, message: "Некорректный ответ Gemini API" };
  }
}

/**
 * Стриминговый streamGenerateContent (SSE) с ротацией ключей.
 * Возвращает upstream-ответ для построчного чтения вызывающим кодом.
 */
export async function geminiGenerateStream(
  attempts: KeyAttempt[],
  models: string[],
  payload: Record<string, unknown>,
  opts: { signal?: AbortSignal | null; fetchFn?: FetchFn; label?: string } = {},
): Promise<GeminiStreamSuccess | GeminiFailure> {
  if (attempts.length === 0 || models.length === 0) {
    return { ok: false, status: 503, message: "Нет доступных ключей Gemini API" };
  }
  const fetchFn = opts.fetchFn ?? fetch;
  const result = await rotateFetch(
    attempts,
    models,
    (model, key) =>
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      ...(opts.signal ? { signal: opts.signal } : {}),
    },
    fetchFn,
    opts.label ?? "stream",
  );
  if (!("resp" in result)) return result;
  if (!result.resp.body) return { ok: false, status: 502, message: "Пустой ответ Gemini API" };
  return { ok: true, resp: result.resp, source: result.source, userIndex: result.userIndex, model: result.model };
}

/** Читает SSE-поток generateContent, отдавая текстовые дельты (и thought отдельно). */
export async function readGeminiSseText(
  resp: Response,
  onText: (text: string) => void,
  onThought?: (text: string) => void,
): Promise<void> {
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const handleLine = (line: string) => {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line.startsWith("data: ")) return;
    const json = line.slice(6).trim();
    if (!json) return;
    try {
      const parsed = JSON.parse(json);
      const parts: any[] = parsed?.candidates?.[0]?.content?.parts || [];
      let text = "";
      let thought = "";
      for (const p of parts) {
        if (typeof p?.text !== "string" || !p.text) continue;
        if (p.thought) thought += p.text;
        else text += p.text;
      }
      if (text) onText(text);
      if (thought && onThought) onThought(thought);
    } catch {
      /* partial — игнорируем */
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      handleLine(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 1);
    }
  }
  if (buffer.trim()) {
    for (const line of buffer.split("\n")) handleLine(line);
  }
}

/** Текст первой кандидатуры generateContent (без thought-частей). */
export function extractGenerateText(data: any): string {
  const parts: any[] = data?.candidates?.[0]?.content?.parts || [];
  return parts
    .filter((p) => typeof p?.text === "string" && p.text && !p.thought)
    .map((p) => p.text as string)
    .join("");
}

/** Снимает markdown-обёртку ```json ... ``` если модель её добавила. */
export function extractJsonText(raw: string): string {
  const t = (raw || "").trim();
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return (m ? m[1] : t).trim();
}

/** OpenAI-style image_url → Gemini part (base64 data URL → inlineData). */
export function imageUrlToPart(imageUrl: string): Record<string, unknown> {
  const m = /^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/.exec(imageUrl || "");
  if (m) return { inlineData: { mimeType: m[1], data: m[2] } };
  return { text: `[изображение: ${imageUrl}]` };
}

export interface TtsPcm {
  bytes: Uint8Array;
  sampleRate: number;
  channels: number;
  bits: number;
}

/** Достаёт PCM из ответа TTS-модели (inlineData.base64, обычно L16/24k/mono). */
export function extractTtsPcm(data: any): TtsPcm | null {
  const parts: any[] = data?.candidates?.[0]?.content?.parts || [];
  for (const p of parts) {
    const b64 = p?.inlineData?.data;
    if (typeof b64 !== "string" || b64.length === 0) continue;
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const mime: string = p?.inlineData?.mimeType || "";
    const rate = /rate=(\d+)/i.exec(mime)?.[1];
    return {
      bytes,
      sampleRate: rate ? parseInt(rate, 10) : 24000,
      channels: 1,
      bits: 16,
    };
  }
  return null;
}

/** Заголовки ответа, сообщающие фронтенду фактический провайдер и ключ. */
export function providerResponseHeaders(
  provider: AiProvider,
  source: KeySource,
  userIndex: number,
): Record<string, string> {
  const headers: Record<string, string> = {
    "x-ai-provider": provider,
    "x-ai-key-source": source,
  };
  if (source === "user" && userIndex >= 0) headers["x-ai-key-index"] = String(userIndex);
  return headers;
}
