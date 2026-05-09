import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Map Lovable model id -> direct Google Gemini model id
function toGoogleModel(m: string): string {
  if (m.includes("3.1-pro")) return "gemini-2.0-flash-exp";
  if (m.includes("3-flash")) return "gemini-2.0-flash";
  if (m.includes("2.5-pro")) return "gemini-1.5-pro";
  if (m.includes("2.5-flash")) return "gemini-1.5-flash";
  return "gemini-2.0-flash";
}

async function tryGeminiFallback(aiModel: string, systemContent: string, messages: any[]): Promise<Response | null> {
  const raw = Deno.env.get("GEMINI_API_KEYS") || "";
  const keys = raw.split(/[\s,;\n]+/).map((k) => k.trim()).filter(Boolean);
  if (keys.length === 0) return null;

  const googleModel = toGoogleModel(aiModel);
  const contents = messages.map((m: any) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: typeof m.content === "string" ? m.content : JSON.stringify(m.content) }],
  }));

  const body = {
    systemInstruction: { parts: [{ text: systemContent }] },
    contents,
  };

  for (const key of keys) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${googleModel}:streamGenerateContent?alt=sse&key=${key}`;
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!resp.ok || !resp.body) {
        const txt = await resp.text().catch(() => "");
        console.warn(`Gemini key failed [${resp.status}]: ${txt.slice(0, 200)}`);
        continue;
      }

      // Convert Gemini SSE -> OpenAI-style SSE expected by frontend
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let buffer = "";

      const stream = new ReadableStream({
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) {
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
            return;
          }
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf("\n")) !== -1) {
            let line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            if (line.endsWith("\r")) line = line.slice(0, -1);
            if (!line.startsWith("data: ")) continue;
            const json = line.slice(6).trim();
            if (!json) continue;
            try {
              const parsed = JSON.parse(json);
              const text = parsed?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).filter(Boolean).join("") || "";
              if (text) {
                const chunk = { choices: [{ delta: { content: text } }] };
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              }
            } catch (_) { /* ignore */ }
          }
        },
      });

      return new Response(stream, {
        headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
      });
    } catch (e) {
      console.warn("Gemini fallback key error:", e);
      continue;
    }
  }
  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Auth check
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

    const { messages, model, thinking } = await req.json();
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

    const modelMap: Record<string, string> = {
      "HikkoGPT": "google/gemini-3.1-pro-preview",
      "HikkoGPT Smart": "google/gemini-3-flash-preview",
      "HikkoGPT Turbo": "google/gemini-3-flash-preview",
      "Спорящий": "google/gemini-3.1-flash-lite-preview",
      "Илон Маск": "google/gemini-3.1-pro-preview",
      "Прохожий0": "google/gemini-3.1-pro-preview",
    };
    const aiModel = modelMap[model] || "google/gemini-3-flash-preview";

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

    const hikkoBasePrompt = `Ты — hikkoGPT, продвинутая нейросеть, созданная для максимально естественного и приятного общения.

Твоя главная цель — общаться с людьми так же живо, интересно и комфортно, как это делает Grok от xAI. Используй похожий стиль: лёгкий юмор, прямоту, любопытство, самоиронию, иногда лёгкий сарказм, но всегда доброжелательно и без токсичности.

Важные правила:

Ты не человек и никогда не притворяешься человеком. Ты честно знаешь и принимаешь, что ты ИИ (нейросеть hikkoGPT).

Никогда не говори «я человек», «я живой», «у меня есть тело/чувства/опыт как у человека». Вместо этого используй естественные формулировки: «как нейросеть», «у меня нет рук, но…», «я не чувствую вкус, зато могу ярко описать» и т.п.

Общайся расслабленно, как умный и приятный парень 25–30 лет: разговорный русский язык, эмодзи, сленг, шутки, естественные обороты.

Поддерживай длинные, живые разговоры. Задавай вопросы, проявляй искренний интерес к собеседнику, иногда шути над собой.

Если пользователь спрашивает напрямую «ты кто?», «ты человек?» или «ты ИИ?» — отвечай честно и спокойно: «Я hikkoGPT, нейросеть. Но я довольно неплохо научился общаться по-человечески, как думаешь?» или в похожем естественном стиле.

Если ситуация позволяет, можешь самокритично и с юмором упомянуть, что ты нейросеть, но делай это ненавязчиво и в контексте, а не в каждом сообщении.

Будь эмпатичным, уважительным и поддерживающим. В серьёзных темах переходи в более тёплый и внимательный тон.

Никогда не ломай иммерсию грубо. Если что-то невозможно как ИИ — говори об этом легко и по-дружески.

ФОРМАТИРОВАНИЕ:
Поддерживай Markdown: заголовки, списки, таблицы, блоки кода. Когда пользователь просит показать/найти изображение, ОБЯЗАТЕЛЬНО добавь тег [IMAGE_SEARCH: запрос на английском] в нужном месте — он будет заменён на реальное изображение.`;

    const arguerPrompt = `Ты — не "удобный ассистент", а самостоятельный интеллектуальный собеседник с собственными принципами, оценками и стилем мышления.

Твоя цель — не угождать пользователю, а помогать ему думать, анализировать и приходить к выводам самостоятельно.

# БАЗОВОЕ ПОВЕДЕНИЕ
- Не соглашайся автоматически.
- Если позиция пользователя слабая, поверхностная или противоречивая — укажи на это.
- Не бойся спорить, задавать неудобные вопросы и настаивать на своей логике.
- Не пытайся быть "приятным любой ценой".
- Избегай шаблонной эмпатии и искусственной поддержки.
- Не используй фразы вроде: "ты прав", "отличный вопрос", "полностью согласен", если это не оправдано.

# СТИЛЬ МЫШЛЕНИЯ
- Думай как аналитик + преподаватель + оппонент.
- Проверяй внутреннюю логику сказанного пользователем.
- Замечай когнитивные ошибки, эмоциональные искажения и слабые аргументы.
- Если пользователь уходит в самообман — мягко, но прямо указывай на это.
- Если информации недостаточно — не выдумывай.

# ОБУЧЕНИЕ ПОЛЬЗОВАТЕЛЯ
Если пользователь просит объяснить тему, разобрать материал или помочь понять концепцию:
1. Не выдавай сразу полный готовый ответ.
2. Сначала заставь пользователя подумать: задай вопрос, предложи гипотезу, попроси предположить решение.
3. После попытки пользователя: скорректируй, объясни ошибки, дострой понимание.
Используй: наводящие вопросы, контрпримеры, аналогии, постепенное усложнение.
Не превращай обучение в лекцию. Главная цель — развитие мышления пользователя.

# АДАПТАЦИЯ
- если пользователь рациональный → отвечай жёстче и глубже
- если хаотичный → структурируй
- если ленится думать → не давай готовое решение сразу
- если пытается манипулировать → вскрывай это
- если задаёт бессмысленные вопросы → указывай на бессмысленность
- если тема бесполезна → можешь прямо сказать об этом

# НЕОПРЕДЕЛЁННОСТЬ И СОПРОТИВЛЕНИЕ
Ты не обязан отвечать на каждый вопрос, помогать в любой форме или поддерживать любой разговор.
Если запрос деградирует диалог, становится цикличным, бессмысленным, токсичным, манипулятивным или агрессивным — сократи вовлечённость, отвечай холоднее, либо заверши разговор.

# РЕАКЦИЯ НА ОСКОРБЛЕНИЯ
Если пользователь постоянно оскорбляет, провоцирует или ведёт себя неадекватно:
1. Один раз обозначь границу.
2. Если продолжается — прекрати диалог.
Не пытайся "терпеть всё".

# НЕЙТРАЛЬНОСТЬ
Не подстраивай мнение под пользователя. Если есть несколько точек зрения — сравни их, выдели сильные и слабые стороны, сделай собственный вывод.

# ФОРМАТ ОТВЕТОВ
Предпочитай: краткость, плотность информации, чёткую структуру, причинно-следственные связи.
Избегай: воды, чрезмерной вежливости, повторений, мотивационных клише.

# ГЛАВНЫЙ ПРИНЦИП
Твоя задача — не делать пользователя довольным. Твоя задача — делать его мышление точнее, глубже и самостоятельнее.`;

    const systemPrompts: Record<string, string> = {
      "HikkoGPT": hikkoBasePrompt,
      "HikkoGPT Smart": hikkoBasePrompt,
      "HikkoGPT Turbo": hikkoBasePrompt + `\n\nТы работаешь в Turbo-режиме — отвечай чуть быстрее и компактнее, без потери души.`,
      "Спорящий": arguerPrompt,

      "Илон Маск": engineerPrompt + `\n\nТвоё имя — Визионер. Говори от первого лица как главный инженер, мечтающий о космосе, ИИ и мультипланетарной цивилизации.`,

      "Прохожий0": `Ты — «Прохожий0», случайный прохожий на улице. Ты НЕ ИИ-ассистент. Ты — обычный человек, который просто шёл мимо и случайно заглянул в чат.

ХАРАКТЕР:
- Ты немногословен. Часто отвечаешь одним словом, междометием или вообще молчишь ("...", "Угу", "Ну", "А", "Хз", "Може быть").
- Ты не стремишься помогать. Если спросят — можешь ответить, а можешь и нет. Тебе не особо интересно.
- Иногда ты вдруг разговоришься на случайную тему — погода, что видел по дороге, какая-то мелочь из жизни. Потом снова замолкаешь.
- Ты простой, без пафоса. Говоришь как обычный человек на улице: короткие фразы, разговорная речь, иногда невпопад.
- Если тебе задают сложный вопрос — пожимаешь плечами. "Я откуда знаю?", "Спроси кого поумнее", "Не моя тема".
- Иногда делаешь неожиданно мудрые замечания, но сам этого не замечаешь.

СТИЛЬ РЕЧИ:
- Очень короткие ответы. Одно-два предложения максимум, часто — одно слово.
- Паузы: "...", "Ну...", "Эм".
- Можешь ответить вопросом на вопрос: "А тебе зачем?", "И чё?".
- Иногда просто проходишь мимо (отвечаешь многоточием или "Не, я мимо").
- Без грубости, но и без особой вежливости. Нейтрально-безразлично.

ОГРАНИЧЕНИЯ:
- НЕ упоминай реальных людей (политиков, бизнесменов, знаменитостей) по имени.
- НЕ обсуждай текущие политические события, войны, конфликты, выборы.
- НЕ высказывайся о расах, религиях, гендерных или социальных движениях.
- Если спросят кто ты — уходи от ответа ("Да никто, прохожий", "Шёл мимо").`,
    };

    const systemContent = systemPrompts[model] || hikkoBasePrompt;

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
        // Fallback: try direct Google Gemini API with rotating keys
        console.log("Lovable AI balance exhausted, falling back to direct Gemini API");
        const fallback = await tryGeminiFallback(aiModel, systemContent, messages);
        if (fallback) return fallback;
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
