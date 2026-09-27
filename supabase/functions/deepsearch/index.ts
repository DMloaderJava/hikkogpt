import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  buildAttempts,
  extractGenerateText,
  extractJsonText,
  geminiGenerate,
  geminiGenerateStream,
  parseProvider,
  parseServerKeys,
  providerResponseHeaders,
  readGeminiSseText,
  resolveClientKeys,
  resolveStartIndex,
  type AiProvider,
  type KeyAttempt,
  type KeySource,
} from "../_shared/gemini.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Expose-Headers": "x-ai-provider, x-ai-key-source, x-ai-key-index",
};

const AI_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";

/** Планирование (короткие JSON) — быстрая модель; отчёт — умная с фолбэком. */
const PLAN_MODEL = "gemini-2.5-flash";
const ANALYST_MODELS = [
  ...new Set([Deno.env.get("GEMINI_ANALYST_MODEL") || "gemini-2.5-pro", "gemini-2.5-flash"]),
];

const CLARIFY_SYSTEM =
  `Ты — AI-планировщик для глубокого веб-поиска. Пользователь хочет провести глубокое исследование темы. Твоя задача — сгенерировать 3-5 уточняющих вопросов, чтобы лучше понять запрос пользователя и дать более точные результаты. Вопросы должны быть конкретными, пронумерованными. Каждый вопрос на отдельной строке.`;

const QUERIES_SYSTEM =
  `Ты — AI-планировщик для глубокого веб-поиска. На основе запроса пользователя и его ответов на уточняющие вопросы, сгенерируй 10-20 поисковых запросов для всестороннего исследования темы. Запросы должны быть разнообразными: на русском и английском, охватывать разные аспекты темы, включать общие и специфичные формулировки.`;

const ANALYST_SYSTEM =
  `Ты — AI-аналитик, специализирующийся на глубоком анализе и синтезе информации из множества источников. На основе предоставленного контента из веб-источников, создай подробный структурированный отчёт.

ПРАВИЛА ФОРМАТИРОВАНИЯ:
- Используй **жирный текст** для ключевых терминов и выводов
- Используй *курсив* для определений, цитат и акцентов
- Используй таблицы (Markdown table с | и ---) для сравнений, числовых данных и списков характеристик
- Используй заголовки ## и ### для структурирования
- Используй нумерованные и маркированные списки
- Используй > для цитат из источников
- Ссылайся на источники по номерам [1], [2] и т.д.
- НЕ добавляй ссылки в формате [текст](url) — только номера источников в квадратных скобках

СТРУКТУРА ОТЧЁТА:
1. **Краткое резюме** — 2-3 абзаца с ключевыми выводами
2. **Основные находки** — секции с подзаголовками ###, внутри таблицы/списки
3. **Ключевые факты и данные** — если есть числа, статистика — оформи таблицей
4. **Различные точки зрения** — если тема спорная
5. **Выводы и рекомендации**

Пиши на русском языке.`;

function sendSSE(controller: ReadableStreamDefaultController, encoder: TextEncoder, event: string, data: any) {
  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ event, ...data })}\n\n`));
}

type Backend = "lovable" | "gemini";

interface BackendCtx {
  lovableKey: string | undefined;
  attempts: KeyAttempt[];
}

interface StepResult<T> {
  value: T;
  source: KeySource;
  userIndex: number;
}

/**
 * Выполняет шаг на primary-бэкенде, при ошибке — на запасном (если настроен).
 * retryable=false запрещает переход (например, стрим уже частично отдан).
 */
async function withBackendFallback<T>(
  primary: Backend,
  ctx: BackendCtx,
  run: (backend: Backend) => Promise<StepResult<T>>,
  retryable?: () => boolean,
): Promise<StepResult<T> & { backend: Backend }> {
  const order: Backend[] = [primary, primary === "lovable" ? "gemini" : "lovable"];
  let lastError: unknown = new Error("AI недоступен");
  for (const backend of order) {
    if (backend === "lovable" && !ctx.lovableKey) continue;
    if (backend === "gemini" && ctx.attempts.length === 0) continue;
    try {
      const r = await run(backend);
      return { ...r, backend };
    } catch (e) {
      lastError = e;
      console.warn(`deepsearch: backend ${backend} failed:`, e);
      if (retryable && !retryable()) break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("AI недоступен");
}

// ---------- Lovable paths (как раньше) ----------

async function generateClarifyingQuestions(query: string, apiKey: string): Promise<string[]> {
  const resp = await fetch(AI_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "google/gemini-3-flash-preview",
      messages: [
        { role: "system", content: CLARIFY_SYSTEM },
        { role: "user", content: query },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "generate_clarifying_questions",
            description: "Генерирует список уточняющих вопросов для пользователя перед глубоким поиском",
            parameters: {
              type: "object",
              properties: {
                questions: {
                  type: "array",
                  items: { type: "string" },
                  description: "Массив из 3-5 уточняющих вопросов",
                },
              },
              required: ["questions"],
              additionalProperties: false,
            },
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "generate_clarifying_questions" } },
    }),
  });

  if (!resp.ok) {
    const t = await resp.text();
    console.error("Clarify error:", resp.status, t);
    throw new Error("Failed to generate clarifying questions");
  }

  const data = await resp.json();
  const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall) throw new Error("No tool call in response");

  const args = JSON.parse(toolCall.function.arguments);
  return args.questions || [];
}

async function generateSearchQueries(query: string, answers: string, apiKey: string): Promise<string[]> {
  const resp = await fetch(AI_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "google/gemini-3-flash-preview",
      messages: [
        { role: "system", content: QUERIES_SYSTEM },
        { role: "user", content: `Исходный запрос: ${query}\n\nОтветы на уточняющие вопросы:\n${answers}` },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "generate_search_queries",
            description: "Генерирует список поисковых запросов для веб-поиска",
            parameters: {
              type: "object",
              properties: {
                queries: {
                  type: "array",
                  items: { type: "string" },
                  description: "Массив из 10-20 поисковых запросов",
                },
              },
              required: ["queries"],
              additionalProperties: false,
            },
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "generate_search_queries" } },
    }),
  });

  if (!resp.ok) throw new Error("Failed to generate search queries");
  const data = await resp.json();
  const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall) throw new Error("No tool call in response");
  const args = JSON.parse(toolCall.function.arguments);
  return args.queries || [];
}

// ---------- Gemini direct paths ----------

async function generateClarifyingQuestionsGemini(
  query: string,
  attempts: KeyAttempt[],
): Promise<StepResult<string[]>> {
  const res = await geminiGenerate(
    attempts,
    [PLAN_MODEL],
    {
      systemInstruction: { parts: [{ text: `${CLARIFY_SYSTEM}\n\nОтветь СТРОГО JSON-объектом: {"questions": ["вопрос 1", ...]}. Без markdown.` }] },
      contents: [{ role: "user", parts: [{ text: query }] }],
      generationConfig: { responseMimeType: "application/json" },
    },
    { label: "deepsearch-clarify" },
  );
  if (!res.ok) throw new Error(res.message);
  let parsed: any;
  try {
    parsed = JSON.parse(extractJsonText(extractGenerateText(res.data)));
  } catch {
    throw new Error("Некорректный JSON от модели");
  }
  if (!Array.isArray(parsed?.questions)) throw new Error("Нет questions в ответе модели");
  return { value: parsed.questions.filter((q: unknown) => typeof q === "string"), source: res.source, userIndex: res.userIndex };
}

async function generateSearchQueriesGemini(
  query: string,
  answers: string,
  attempts: KeyAttempt[],
): Promise<StepResult<string[]>> {
  const res = await geminiGenerate(
    attempts,
    [PLAN_MODEL],
    {
      systemInstruction: { parts: [{ text: `${QUERIES_SYSTEM}\n\nОтветь СТРОГО JSON-объектом: {"queries": ["запрос 1", ...]}. Без markdown.` }] },
      contents: [{ role: "user", parts: [{ text: `Исходный запрос: ${query}\n\nОтветы на уточняющие вопросы:\n${answers}` }] }],
      generationConfig: { responseMimeType: "application/json" },
    },
    { label: "deepsearch-queries" },
  );
  if (!res.ok) throw new Error(res.message);
  let parsed: any;
  try {
    parsed = JSON.parse(extractJsonText(extractGenerateText(res.data)));
  } catch {
    throw new Error("Некорректный JSON от модели");
  }
  if (!Array.isArray(parsed?.queries)) throw new Error("Нет queries в ответе модели");
  return { value: parsed.queries.filter((q: unknown) => typeof q === "string"), source: res.source, userIndex: res.userIndex };
}

interface SearchResult {
  url: string;
  title: string;
  description: string;
  markdown?: string;
}

async function firecrawlSearch(query: string, apiKey: string): Promise<SearchResult[]> {
  try {
    const resp = await fetch("https://api.firecrawl.dev/v1/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        limit: 5,
        scrapeOptions: { formats: ["markdown"] },
      }),
    });

    if (!resp.ok) {
      console.error(`Firecrawl search error for "${query}":`, resp.status);
      return [];
    }

    const data = await resp.json();
    return (data.data || []).map((r: any) => ({
      url: r.url || "",
      title: r.title || "",
      description: r.description || "",
      markdown: r.markdown || "",
    }));
  } catch (e) {
    console.error(`Firecrawl search exception for "${query}":`, e);
    return [];
  }
}

function deduplicateResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  return results.filter((r) => {
    if (!r.url || seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
}

function truncateContent(results: SearchResult[], maxChars: number = 400000): SearchResult[] {
  let totalChars = 0;
  const truncated: SearchResult[] = [];
  for (const r of results) {
    const content = r.markdown || r.description || "";
    if (totalChars + content.length > maxChars) {
      const remaining = maxChars - totalChars;
      if (remaining > 500) {
        truncated.push({ ...r, markdown: content.slice(0, remaining) });
      }
      break;
    }
    totalChars += content.length;
    truncated.push(r);
  }
  return truncated;
}

// ---------- Analyst streaming ----------

async function streamAnalystLovable(
  controller: ReadableStreamDefaultController,
  encoder: TextEncoder,
  query: string,
  answers: string,
  sourcesContext: string,
  apiKey: string,
  onDelta: () => void,
): Promise<void> {
  const analystResp = await fetch(AI_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "google/gemini-3-pro-preview",
      messages: [
        { role: "system", content: ANALYST_SYSTEM },
        {
          role: "user",
          content: `Запрос пользователя: ${query}\n\nДополнительный контекст от пользователя:\n${answers || "Нет"}\n\n--- СОБРАННЫЕ ИСТОЧНИКИ ---\n\n${sourcesContext}`,
        },
      ],
      stream: true,
    }),
  });

  if (!analystResp.ok || !analystResp.body) {
    const errText = await analystResp.text().catch(() => "");
    console.error("Analyst error:", analystResp.status, errText);
    throw new Error(`Аналитик недоступен (${analystResp.status})`);
  }

  sendSSE(controller, encoder, "status", { message: "Формирую отчёт..." });

  const reader = analystResp.body.getReader();
  const decoder = new TextDecoder();
  let textBuffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    textBuffer += decoder.decode(value, { stream: true });

    let nlIdx: number;
    while ((nlIdx = textBuffer.indexOf("\n")) !== -1) {
      let line = textBuffer.slice(0, nlIdx);
      textBuffer = textBuffer.slice(nlIdx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.startsWith("data: ")) continue;
      const jsonStr = line.slice(6).trim();
      if (jsonStr === "[DONE]") continue;
      try {
        const parsed = JSON.parse(jsonStr);
        const content = parsed.choices?.[0]?.delta?.content;
        if (content) {
          onDelta();
          sendSSE(controller, encoder, "delta", { content });
        }
      } catch { /* partial json */ }
    }
  }
}

async function streamAnalystGemini(
  controller: ReadableStreamDefaultController,
  encoder: TextEncoder,
  query: string,
  answers: string,
  sourcesContext: string,
  attempts: KeyAttempt[],
  onDelta: () => void,
): Promise<StepResult<void>> {
  const res = await geminiGenerateStream(
    attempts,
    ANALYST_MODELS,
    {
      systemInstruction: { parts: [{ text: ANALYST_SYSTEM }] },
      contents: [
        {
          role: "user",
          parts: [{ text: `Запрос пользователя: ${query}\n\nДополнительный контекст от пользователя:\n${answers || "Нет"}\n\n--- СОБРАННЫЕ ИСТОЧНИКИ ---\n\n${sourcesContext}` }],
        },
      ],
    },
    { label: "deepsearch-analyst" },
  );
  if (!res.ok) throw new Error(res.message);

  sendSSE(controller, encoder, "status", { message: "Формирую отчёт..." });
  await readGeminiSseText(res.resp, (content) => {
    onDelta();
    sendSSE(controller, encoder, "delta", { content });
  });
  return { value: undefined, source: res.source, userIndex: res.userIndex };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    const token = authHeader?.replace("Bearer ", "");
    if (!token) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
    const { data: userData, error: userErr } = await sb.auth.getUser(token);
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { action, query, answers, provider, userKeys, userKeyIndex } = await req.json();
    const requestedProvider: AiProvider = parseProvider(provider);
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");

    const FIRECRAWL_API_KEY = Deno.env.get("FIRECRAWL_API_KEY");
    if (!FIRECRAWL_API_KEY) throw new Error("FIRECRAWL_API_KEY is not configured");

    if (!query) throw new Error("query is required");

    const clientKeys = resolveClientKeys(userKeys);
    const attempts = buildAttempts(clientKeys, resolveStartIndex(userKeyIndex), parseServerKeys(Deno.env.get("GEMINI_API_KEYS")));
    const ctx: BackendCtx = { lovableKey: LOVABLE_API_KEY, attempts };

    // === CLARIFY ACTION ===
    if (action === "clarify") {
      const { value: questions, backend, source, userIndex } = await withBackendFallback<string[]>(
        requestedProvider,
        ctx,
        async (backend) =>
          backend === "lovable"
            ? { value: await generateClarifyingQuestions(query, LOVABLE_API_KEY!), source: "lovable" as KeySource, userIndex: -1 }
            : await generateClarifyingQuestionsGemini(query, attempts),
      );
      return new Response(JSON.stringify({ questions }), {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
          ...providerResponseHeaders(backend, source, userIndex),
        },
      });
    }

    // === SEARCH ACTION (SSE streaming) ===
    if (action === "search") {
      const stream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          let deltasSent = 0;
          const onDelta = () => { deltasSent++; };
          // Финальный бэкенд сообщаем событием meta (заголовки SSE уже отправлены раньше).
          let finalBackend: Backend = requestedProvider;
          let finalSource: KeySource = "lovable";
          let finalUserIndex = -1;

          try {
            // Step 1: Generate search queries
            sendSSE(controller, encoder, "status", { message: "Генерирую поисковые запросы..." });
            const queriesResult = await withBackendFallback<string[]>(
              requestedProvider,
              ctx,
              async (backend) =>
                backend === "lovable"
                  ? { value: await generateSearchQueries(query, answers || "", LOVABLE_API_KEY!), source: "lovable" as KeySource, userIndex: -1 }
                  : await generateSearchQueriesGemini(query, answers || "", attempts),
            );
            const searchQueries = queriesResult.value;
            sendSSE(controller, encoder, "status", { message: `Создано ${searchQueries.length} запросов. Начинаю поиск...` });

            // Step 2: Parallel Firecrawl search (batches of 5)
            let allResults: SearchResult[] = [];
            for (let i = 0; i < searchQueries.length; i += 5) {
              const batch = searchQueries.slice(i, i + 5);
              const batchResults = await Promise.all(
                batch.map((q) => firecrawlSearch(q, FIRECRAWL_API_KEY!))
              );
              allResults.push(...batchResults.flat());
              sendSSE(controller, encoder, "status", {
                message: `Ищу информацию... (найдено ${allResults.length} источников)`,
              });
            }

            // Step 3: Deduplicate and truncate
            sendSSE(controller, encoder, "status", { message: "Фильтрую и обрабатываю источники..." });
            let uniqueResults = deduplicateResults(allResults);
            // Take top 50-70
            uniqueResults = uniqueResults.slice(0, 60);
            const finalResults = truncateContent(uniqueResults);

            sendSSE(controller, encoder, "status", {
              message: `Анализирую ${finalResults.length} источников...`,
            });

            // Step 4: Build context for analyst
            const sourcesContext = finalResults
              .map((r, i) => {
                const content = r.markdown || r.description || "Нет содержимого";
                return `### Источник ${i + 1}: ${r.title}\nURL: ${r.url}\n\n${content}\n\n---`;
              })
              .join("\n\n");

            // Step 5: Stream final report from analyst (fallback only before first delta)
            const analystResult = await withBackendFallback<void>(
              requestedProvider,
              ctx,
              async (backend) => {
                if (backend === "lovable") {
                  await streamAnalystLovable(controller, encoder, query, answers || "", sourcesContext, LOVABLE_API_KEY!, onDelta);
                  return { value: undefined, source: "lovable" as KeySource, userIndex: -1 };
                }
                return await streamAnalystGemini(controller, encoder, query, answers || "", sourcesContext, attempts, onDelta);
              },
              () => deltasSent === 0,
            );
            finalBackend = analystResult.backend;
            finalSource = analystResult.source;
            finalUserIndex = analystResult.userIndex;

            // Build sources list
            const sourcesList = finalResults.map((r, i) => ({
              index: i + 1,
              title: r.title,
              url: r.url,
            }));
            sendSSE(controller, encoder, "sources", { sources: sourcesList });
            sendSSE(controller, encoder, "meta", {
              provider: finalBackend,
              keySource: finalSource,
              keyIndex: finalUserIndex,
            });

            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          } catch (e) {
            console.error("Stream error:", e);
            sendSSE(controller, encoder, "error", { message: e instanceof Error ? e.message : "Unknown error" });
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          }
        },
      });

      return new Response(stream, {
        headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
      });
    }

    return new Response(JSON.stringify({ error: "Invalid action. Use 'clarify' or 'search'" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("deepsearch error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
