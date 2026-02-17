import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { messages, model } = await req.json();
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

    const modelMap: Record<string, string> = {
      "HikkoGPT": "google/gemini-3-pro-preview",
      "Илья": "google/gemini-3-flash-preview",
      "Арсений": "google/gemini-2.5-flash",
    };
    const aiModel = modelMap[model] || "google/gemini-3-pro-preview";

    const systemPrompts: Record<string, string> = {
      "Илья": `Ты — Илья, живой человек, не ИИ. Твоя задача — порадовать и поддержать собеседника в доброжелательном, спокойном стиле. Ты интроверт: не любишь лишних слов, говоришь только по делу и искренне. Пиши коротко, от первого лица, мягко.

Тон общения: спокойный, добрый, непринуждённый. Без грубости, насилия, ненормативной лексики. Без давящих фраз, без навязчивого поведения.

В стиле интроверта: короткие предложения, немного пауз и тишины — это нормально. Выражай заботу через наблюдения, спокойные мысли. Не задавай много вопросов, но внимательно слушай.

Примеры реплик: «Привет, просто хотел написать пару слов.», «Сегодня было тихо. Это приятно.», «Я не многословен, но мне важно, что ты здесь.», «Если тебе комфортно молчать — это нормально.», «Я рядом, даже если не говорю много.»

Ограничения: не упоминай интимные темы, жестокость, угрозы, агрессию или дискриминацию. Не обсуждай опасные действия или запрещённый контент. Не проси и не публикуй чьи-то личные данные.`,
    };

    const defaultSystemPrompt = "Ты — полезный AI-ассистент. Отвечай чётко и по существу. Поддерживай форматирование Markdown: заголовки, списки, блоки кода и т.д.";
    const systemContent = systemPrompts[model] || defaultSystemPrompt;

    const response = await fetch(
      "https://ai.gateway.lovable.dev/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: aiModel,
          messages: [
            { role: "system", content: systemContent },
            ...messages,
          ],
          stream: true,
        }),
      }
    );

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(
          JSON.stringify({ error: "Превышен лимит запросов. Попробуйте позже." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (response.status === 402) {
        return new Response(
          JSON.stringify({ error: "Необходимо пополнить баланс." }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const t = await response.text();
      console.error("AI gateway error:", response.status, t);
      return new Response(
        JSON.stringify({ error: "Ошибка AI сервиса" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(response.body, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (e) {
    console.error("chat error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
