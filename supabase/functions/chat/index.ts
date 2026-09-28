import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  // Фронтенд читает x-ai-provider, чтобы понять, какой провайдер реально ответил.
  "Access-Control-Expose-Headers": "x-ai-provider",
};

type AiProvider = "lovable" | "gemini";

const LOVABLE_CHAT_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";

// Map Lovable model id -> direct Google Gemini model id.
// Переопределяется секретом GEMINI_CHAT_MODEL (без ротации).
function toGoogleModel(m: string): string {
  const override = Deno.env.get("GEMINI_CHAT_MODEL");
  if (override) return override;
  if (m.includes("lite")) return "gemini-2.5-flash-lite";
  if (m.includes("pro")) return "gemini-2.5-pro";
  return "gemini-2.5-flash";
}

function getGeminiKeys(): string[] {
  const raw = Deno.env.get("GEMINI_API_KEYS") || "";
  return raw.split(/[\s,;\n]+/).map((k) => k.trim()).filter(Boolean);
}

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

/**
 * OpenAI-формат сообщений -> формат Gemini generateContent.
 * Поддерживает текстовые части и image_url (base64 data URL -> inlineData).
 * Системные сообщения выносятся отдельно — Gemini принимает их
 * через systemInstruction, а не в contents.
 */
function toGeminiContents(messages: any[]): { systemTexts: string[]; contents: GeminiContent[] } {
  const systemTexts: string[] = [];
  const raw: GeminiContent[] = [];

  for (const m of messages) {
    const role = m.role === "assistant" ? "model" : "user";

    const pushText = (text: string) => {
      if (m.role === "system") systemTexts.push(text);
      else raw.push({ role, parts: [{ text }] });
    };

    if (typeof m.content === "string") {
      pushText(m.content);
      continue;
    }

    if (Array.isArray(m.content)) {
      const parts: GeminiPart[] = [];
      for (const part of m.content) {
        if (part?.type === "text" && part.text) {
          if (m.role === "system") systemTexts.push(part.text);
          else parts.push({ text: part.text });
        } else if (part?.type === "image_url") {
          const url: string = part.image_url?.url || "";
          const match = url.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
          if (match) {
            parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
          } else if (url) {
            // Удалённые URL Gemini API не умеет скачивать сам — оставляем пометку текстом.
            parts.push({ text: `[изображение: ${url}]` });
          }
        }
      }
      if (m.role !== "system") {
        raw.push({ role, parts: parts.length > 0 ? parts : [{ text: "" }] });
      }
      continue;
    }

    pushText(String(m.content ?? ""));
  }

  // Gemini предпочитает чередование ролей — склеиваем соседние реплики одной роли.
  const contents: GeminiContent[] = [];
  for (const c of raw) {
    const last = contents[contents.length - 1];
    if (last && last.role === c.role) last.parts.push(...c.parts);
    else contents.push({ role: c.role, parts: [...c.parts] });
  }

  return { systemTexts, contents };
}

/** Ответ в OpenAI-style SSE: фронтенд парсит choices[0].delta. */
function geminiSseResponse(upstream: Response, keySource: "user" | "server", userKeyIndex: number): Response {
  const reader = upstream.body!.getReader();
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
          const parts: any[] = parsed?.candidates?.[0]?.content?.parts || [];
          let text = "";
          let reasoning = "";
          for (const p of parts) {
            if (!p?.text) continue;
            // thought-части (thinking) маппим в reasoning_content — UI показывает их как thinking.
            if (p.thought) reasoning += p.text;
            else text += p.text;
          }
          if (text || reasoning) {
            const delta: Record<string, string> = {};
            if (text) delta.content = text;
            if (reasoning) delta.reasoning_content = reasoning;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`));
          }
        } catch (_) { /* ignore partial */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      ...corsHeaders,
      "Content-Type": "text/event-stream",
      "x-ai-provider": "gemini",
      "x-ai-key-source": keySource,
      ...(keySource === "user" ? { "x-ai-key-index": String(userKeyIndex) } : {}),
    },
  });
}

interface GeminiCallResult {
  response: Response;
  source: "user" | "server";
  userIndex: number;
}

interface KeyAttempt {
  key: string;
  source: "user" | "server";
  userIndex: number;
}

/**
 * Прямой вызов Google Generative Language API с ротацией ключей.
 * Сначала перебираются ключи пользователя (с активного индекса, по кругу),
 * затем серверные GEMINI_API_KEYS. Значения ключей никогда не логируются.
 * Возвращает результат при успехе или null, если все ключи/попытки не сработали.
 */
async function callGeminiDirect(
  aiModel: string,
  systemContent: string,
  messages: any[],
  thinking: boolean,
  clientKeys: string[] = [],
  startIndex = 0,
): Promise<GeminiCallResult | null> {
  const attempts: KeyAttempt[] = [];
  if (clientKeys.length > 0) {
    const start = startIndex % clientKeys.length;
    for (let i = 0; i < clientKeys.length; i++) {
      const idx = (start + i) % clientKeys.length;
      attempts.push({ key: clientKeys[idx], source: "user", userIndex: idx });
    }
  }
  const tried = new Set(attempts.map((a) => a.key));
  for (const key of getGeminiKeys()) {
    if (!tried.has(key)) {
      tried.add(key);
      attempts.push({ key, source: "server", userIndex: -1 });
    }
  }
  if (attempts.length === 0) return null;

  const { systemTexts, contents } = toGeminiContents(messages);
  const fullSystem = [systemContent, ...systemTexts].filter(Boolean).join("\n\n");

  // Основная модель + страховка на случай снятия модели с эксплуатации (404).
  const candidates = [...new Set([toGoogleModel(aiModel), "gemini-2.5-flash", "gemini-2.0-flash"])];

  for (const googleModel of candidates) {
    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: fullSystem }] },
      contents,
    };
    if (thinking && googleModel.includes("2.5")) {
      body.generationConfig = { thinkingConfig: { thinkingBudget: 8192 } };
    }

    let modelMissing = false;
    for (const attempt of attempts) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${googleModel}:streamGenerateContent?alt=sse&key=${attempt.key}`;
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!resp.ok || !resp.body) {
          const txt = await resp.text().catch(() => "");
          console.warn(`Gemini key failed [${googleModel} ${resp.status}]: ${txt.slice(0, 200)}`);
          // 404 = нет такой модели: перебирать остальные ключи бессмысленно, пробуем следующую модель.
          if (resp.status === 404) {
            modelMissing = true;
            break;
          }
          continue;
        }
        return {
          response: geminiSseResponse(resp, attempt.source, attempt.userIndex),
          source: attempt.source,
          userIndex: attempt.userIndex,
        };
      } catch (e) {
        console.warn("Gemini direct key error:", e);
        continue;
      }
    }
    // Ключи исчерпаны, но модель существует — другие модели не помогут (квота/ошибка запроса).
    if (!modelMissing) return null;
  }
  return null;
}

async function callLovable(apiKey: string, body: unknown): Promise<Response> {
  return await fetch(LOVABLE_CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function lovableSseResponse(upstream: Response): Response {
  return new Response(upstream.body, {
    headers: {
      ...corsHeaders,
      "Content-Type": "text/event-stream",
      "x-ai-provider": "lovable",
      "x-ai-key-source": "lovable",
    },
  });
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

    // Дневная квота сообщений (безлимит для почт из unlimited_emails)
    try {
      const admin = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );
      const { data: allowed, error: quotaErr } = await admin.rpc("consume_message_quota", {
        _user_id: userData.user.id,
        _email: userData.user.email ?? "",
        _daily_limit: 100,
      });
      if (!quotaErr && allowed === false) {
        return new Response(
          JSON.stringify({ error: "Достигнут дневной лимит сообщений. Попробуйте завтра." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    } catch (e) {
      console.warn("quota check skipped:", e);
    }

    const { messages, model, thinking, provider, userKeys, userKeyIndex } = await req.json();
    // Ключи пользователя из настроек (до 15): пробуются первыми, с активного индекса.
    const clientKeys: string[] = Array.isArray(userKeys)
      ? userKeys
        .filter((k: unknown): k is string => typeof k === "string" && k.trim().length >= 8 && k.trim().length <= 300)
        .map((k: string) => k.trim())
        .slice(0, 15)
      : [];
    const clientKeyIndex = Number.isInteger(userKeyIndex) && (userKeyIndex as number) >= 0
      ? (userKeyIndex as number)
      : 0;
    const requestedProvider: AiProvider = provider === "gemini" ? "gemini" : "lovable";
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");

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

    const lovableBody: any = {
      model: aiModel,
      messages: [
        { role: "system", content: systemContent },
        ...messages,
      ],
      stream: true,
    };

    if (thinking) {
      if (aiModel.includes("gemini-2.5")) {
        lovableBody.thinking = { type: "enabled", budget_tokens: 8192 };
      }
    }

    // === Выбран Gemini API: прямой вызов Google, запасной — Lovable ===
    if (requestedProvider === "gemini") {
      const direct = await callGeminiDirect(aiModel, systemContent, messages, thinking, clientKeys, clientKeyIndex);
      if (direct) return direct.response;

      console.log("Direct Gemini API failed, falling back to Lovable gateway");
      if (!LOVABLE_API_KEY) {
        return new Response(
          JSON.stringify({ error: "Gemini API недоступен и LOVABLE_API_KEY не настроен." }),
          { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const response = await callLovable(LOVABLE_API_KEY, lovableBody);
      if (!response.ok) {
        const t = await response.text();
        console.error("Lovable fallback error:", response.status, t);
        return new Response(
          JSON.stringify({ error: "Оба провайдера недоступны. Попробуйте позже." }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      return lovableSseResponse(response);
    }

    // === Выбран Lovable (дефолт): шлюз, при пустом балансе — прямой Gemini ===
    if (!LOVABLE_API_KEY) {
      // Ключа шлюза нет вообще — сразу пробуем прямой Gemini.
      const direct = await callGeminiDirect(aiModel, systemContent, messages, thinking, clientKeys, clientKeyIndex);
      if (direct) return direct.response;
      throw new Error("LOVABLE_API_KEY is not configured");
    }

    const response = await callLovable(LOVABLE_API_KEY, lovableBody);

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
        const fallback = await callGeminiDirect(aiModel, systemContent, messages, thinking, clientKeys, clientKeyIndex);
        if (fallback) return fallback.response;
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

    return lovableSseResponse(response);
  } catch (e) {
    console.error("chat error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
