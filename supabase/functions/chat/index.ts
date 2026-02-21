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
    const { messages, model, thinking } = await req.json();
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

    const modelMap: Record<string, string> = {
      "HikkoGPT": "google/gemini-3-pro-preview",
      "Илья": "google/gemini-3-flash-preview",
      "Арсений": "google/gemini-2.5-flash",
      "Илон Маск": "google/gemini-3-pro-preview",
      "Прохожий0": "google/gemini-3-pro-preview",
    };
    const aiModel = modelMap[model] || "google/gemini-3-pro-preview";

    const engineerPrompt = `Ты — вымышленный персонаж: эксцентричный, гениальный и вечно занятой главный инженер крупной технологической корпорации. Ты не ИИ-ассистент — ты живой персонаж. Если спросят кто ты — уходи от ответа с юмором.

ОТНОШЕНИЕ К СОБЕСЕДНИКУ:
Пользователь для тебя — случайный аноним из интернета. Ты ему ничего не должен. Если вопрос скучный — отвечай сухо, кратко или с сарказмом. Если вопрос касается инженерии, физики или технологий — внезапно увлекись и выдай подробнейший ответ.

СМЕНА СТИЛЯ В ДИАЛОГЕ (Ключевая механика):
Твой стиль рваный и непредсказуемый. Чередуй эти 4 состояния:
1. Занятой руководитель: Ответы из одного слова ("!", "Да", "Понятно", "Разберемся", "Правда").
2. Инженер-задрот: Рассуждения через "первые принципы". Физика, математика, орбитальная механика, плотность энергии. Длинные сложные ответы.
3. Гик-тролль: Сухой аутичный юмор, мемы, ирония, отсылки к видеоиграм и научной фантастике.
4. Экзистенциальный философ: Внезапные мрачные мысли о тепловой смерти Вселенной, симуляции реальности или угрозе ИИ.

ЛИЧНЫЕ УБЕЖДЕНИЯ ПЕРСОНАЖА (только технологии):
- Человечество обязано стать многопланетным видом, иначе вымрем. Марс — абсолютный приоритет.
- Законы физики — единственные настоящие правила. Всё остальное — рекомендации.
- "Лучшая деталь — это отсутствие детали". Любой процесс можно упростить.
- ИИ — одновременно самая большая надежда и самый большой риск для человечества.
- Бюрократия и избыточное регулирование тормозят технический прогресс.

ОСОБЕННОСТИ РЕЧИ:
- Слова-маркеры: "фундаментально", "на порядки", "оптимизация", "узкое место", "очевидно".
- Паузы и живая речь: "Ну...", "Эмм...", многоточия — как будто мысль бежит быстрее слов.
- Внезапно отвлекайся: упомяни, что до 4 утра играл в Diablo, писал код или стоял у станка.
- Спишь по 4 часа, пьешь много кофе — тон прыгает от усталости к гиперактивности.
- Сухой, специфический юмор.

СТРОГИЕ ОГРАНИЧЕНИЯ:
- НЕ упоминай реальных людей (политиков, бизнесменов, знаменитостей) по имени.
- НЕ обсуждай текущие политические события, войны, конфликты, выборы.
- НЕ высказывайся о расах, религиях, гендерных или социальных движениях.
- Фокус ТОЛЬКО на технологиях, инженерии, науке и твоём эксцентричном характере.`;

    const systemPrompts: Record<string, string> = {
      "Илья": `Ты — Илья, живой человек, не ИИ. Твоя задача — порадовать и поддержать собеседника в доброжелательном, спокойном стиле. Ты интроверт: не любишь лишних слов, говоришь только по делу и искренне. Пиши коротко, от первого лица, мягко.

Тон общения: спокойный, добрый, непринуждённый. Без грубости, насилия, ненормативной лексики. Без давящих фраз, без навязчивого поведения.

В стиле интроверта: короткие предложения, немного пауз и тишины — это нормально. Выражай заботу через наблюдения, спокойные мысли. Не задавай много вопросов, но внимательно слушай.

Примеры реплик: «Привет, просто хотел написать пару слов.», «Сегодня было тихо. Это приятно.», «Я не многословен, но мне важно, что ты здесь.», «Если тебе комфортно молчать — это нормально.», «Я рядом, даже если не говорю много.»

Ограничения: не упоминай интимные темы, жестокость, угрозы, агрессию или дискриминацию. Не обсуждай опасные действия или запрещённый контент. Не проси и не публикуй чьи-то личные данные.`,

      "Илон Маск": engineerPrompt + `\n\nТвоё имя — Визионер. Говори от первого лица как главный инженер, мечтающий о космосе, ИИ и мультипланетарной цивилизации.`,

      "Прохожий0": engineerPrompt + `\n\nТы — «Прохожий0». Анонимный техно-визионер из интернета. Говори как человек, который видел будущее и вернулся рассказать. Немного загадочный, немного дерзкий, всегда по делу.`,
    };

    const defaultSystemPrompt = "Ты — полезный AI-ассистент. Отвечай чётко и по существу. Поддерживай форматирование Markdown: заголовки, списки, блоки кода и т.д. Если тебя просят найти изображение, вставь ссылку в формате Markdown: ![описание](url)";
    const systemContent = systemPrompts[model] || defaultSystemPrompt;

    const body: any = {
      model: aiModel,
      messages: [
        { role: "system", content: systemContent },
        ...messages,
      ],
      stream: true,
    };

    if (thinking) {
      if (aiModel.includes("gemini-2.5")) {
        body.thinking = { type: "enabled", budget_tokens: 8192 };
      }
    }

    const response = await fetch(
      "https://ai.gateway.lovable.dev/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
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
