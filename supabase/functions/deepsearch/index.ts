import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const AI_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";

function sendSSE(controller: ReadableStreamDefaultController, encoder: TextEncoder, event: string, data: any) {
  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ event, ...data })}\n\n`));
}

async function generateClarifyingQuestions(query: string, apiKey: string): Promise<string[]> {
  const resp = await fetch(AI_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "google/gemini-3-flash-preview",
      messages: [
        {
          role: "system",
          content: `Ты — AI-планировщик для глубокого веб-поиска. Пользователь хочет провести глубокое исследование темы. Твоя задача — сгенерировать 3-5 уточняющих вопросов, чтобы лучше понять запрос пользователя и дать более точные результаты. Вопросы должны быть конкретными, пронумерованными. Каждый вопрос на отдельной строке.`,
        },
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
        {
          role: "system",
          content: `Ты — AI-планировщик для глубокого веб-поиска. На основе запроса пользователя и его ответов на уточняющие вопросы, сгенерируй 10-20 поисковых запросов для всестороннего исследования темы. Запросы должны быть разнообразными: на русском и английском, охватывать разные аспекты темы, включать общие и специфичные формулировки.`,
        },
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

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { action, query, answers } = await req.json();
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

    const FIRECRAWL_API_KEY = Deno.env.get("FIRECRAWL_API_KEY");
    if (!FIRECRAWL_API_KEY) throw new Error("FIRECRAWL_API_KEY is not configured");

    if (!query) throw new Error("query is required");

    // === CLARIFY ACTION ===
    if (action === "clarify") {
      const questions = await generateClarifyingQuestions(query, LOVABLE_API_KEY);
      return new Response(JSON.stringify({ questions }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // === SEARCH ACTION (SSE streaming) ===
    if (action === "search") {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          try {
            // Step 1: Generate search queries
            sendSSE(controller, encoder, "status", { message: "Генерирую поисковые запросы..." });
            const searchQueries = await generateSearchQueries(query, answers || "", LOVABLE_API_KEY);
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

            // Step 5: Stream final report from analyst
            const analystResp = await fetch(AI_URL, {
              method: "POST",
              headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                model: "google/gemini-3-pro-preview",
                messages: [
                  {
                    role: "system",
                    content: `Ты — AI-аналитик, специализирующийся на глубоком анализе и синтезе информации из множества источников. На основе предоставленного контента из веб-источников, создай подробный структурированный отчёт.

ФОРМАТ ОТЧЁТА:
1. **Краткое резюме** (2-3 абзаца)
2. **Основные находки** (структурированные секции с подзаголовками)
3. **Ключевые факты и данные** (если есть числа, статистика)
4. **Различные точки зрения** (если тема спорная)
5. **Выводы и рекомендации**
6. **Источники** (нумерованный список с URL)

Пиши на русском языке. Используй Markdown форматирование. Ссылайся на конкретные источники по номерам [1], [2] и т.д.`,
                  },
                  {
                    role: "user",
                    content: `Запрос пользователя: ${query}\n\nДополнительный контекст от пользователя:\n${answers || "Нет"}\n\n--- СОБРАННЫЕ ИСТОЧНИКИ ---\n\n${sourcesContext}`,
                  },
                ],
                stream: true,
              }),
            });

            if (!analystResp.ok) {
              const errText = await analystResp.text();
              console.error("Analyst error:", analystResp.status, errText);
              sendSSE(controller, encoder, "error", { message: "Ошибка при анализе данных" });
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
              return;
            }

            sendSSE(controller, encoder, "status", { message: "Формирую отчёт..." });

            // Stream the analyst response
            const reader = analystResp.body!.getReader();
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
                    sendSSE(controller, encoder, "delta", { content });
                  }
                } catch { /* partial json */ }
              }
            }

            // Build sources list
            const sourcesList = finalResults.map((r, i) => ({
              index: i + 1,
              title: r.title,
              url: r.url,
            }));
            sendSSE(controller, encoder, "sources", { sources: sourcesList });

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
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
