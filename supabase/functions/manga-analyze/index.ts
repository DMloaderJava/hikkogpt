import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import {
  extractJson,
  MAX_IMAGES,
  normalizePages,
  upstreamErrorMessage,
  validateImages,
} from './parse.ts';
import {
  buildAttempts,
  extractGenerateText,
  geminiGenerate,
  imageUrlToPart,
  parseProvider,
  parseServerKeys,
  providerResponseHeaders,
  resolveClientKeys,
  resolveStartIndex,
  type AiProvider,
  type KeySource,
} from '../_shared/gemini.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Expose-Headers': 'x-ai-provider, x-ai-key-source, x-ai-key-index',
};
const json = (body: unknown, status = 200, extraHeaders: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json', ...extraHeaders } });

/** Сколько ждём модель: wall-clock лимит edge-функции на Free — 150 с. */
const UPSTREAM_TIMEOUT_MS = 120_000;

const SYSTEM_PROMPT =
  'Ты анализируешь мангу. Ответь ТОЛЬКО валидным JSON: {"pages":[{"description":"краткое описание сцены на русском","transcript":"Speaker 1: текст\\nSpeaker 2: текст"}]}. Ровно один элемент pages на каждое изображение в том же порядке. Сохраняй номера говорящих персонажей между страницами. Передай видимые реплики на русском; если текста нет, придумай краткую реплику по сцене и обозначь это в description. Не более 8 персонажей. Без markdown.';

const VISION_MODELS = [
  ...new Set([Deno.env.get("GEMINI_VISION_MODEL") || "gemini-2.5-flash", "gemini-2.0-flash"]),
];

type Backend = "lovable" | "gemini";

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  try {
    const token = req.headers.get('Authorization')?.replace('Bearer ', '');
    if (!token) return json({ error: 'Unauthorized' }, 401);
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!);
    const { data, error } = await sb.auth.getUser(token);
    if (error || !data.user) return json({ error: 'Unauthorized' }, 401);

    const { images, provider, userKeys, userKeyIndex } = await req.json();
    const validated = validateImages(images);
    if (!validated.ok) return json({ error: validated.error }, 400);

    const requestedProvider: AiProvider = parseProvider(provider);
    const key = Deno.env.get('LOVABLE_API_KEY');
    const attempts = buildAttempts(
      resolveClientKeys(userKeys),
      resolveStartIndex(userKeyIndex),
      parseServerKeys(Deno.env.get('GEMINI_API_KEYS')),
    );
    if (!key && attempts.length === 0) return json({ error: 'AI не настроен' }, 500);

    const userText = `Проанализируй ${validated.images.length} страниц манги по порядку.`;
    const lovableBody = {
      model: 'google/gemini-3-flash-preview',
      stream: false,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: userText },
            ...validated.images.map((url: string) => ({ type: 'image_url', image_url: { url } })),
          ],
        },
      ],
    };
    const geminiBody = {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [
        {
          role: 'user',
          parts: [{ text: userText }, ...validated.images.map((url: string) => imageUrlToPart(url))],
        },
      ],
      generationConfig: { responseMimeType: 'application/json' },
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      const order: Backend[] = [requestedProvider, requestedProvider === "lovable" ? "gemini" : "lovable"];
      let lastError = 'Сервис анализа недоступен';
      let lastStatus = 502;

      for (const backend of order) {
        let raw: string | null = null;
        let source: KeySource = "lovable";
        let keyIndex = -1;

        try {
          if (backend === 'lovable' && key) {
            let response: Response;
            try {
              response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
                method: 'POST',
                headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
                signal: controller.signal,
                body: JSON.stringify(lovableBody),
              });
            } catch (e) {
              if (e instanceof Error && e.name === 'AbortError') {
                return json({ error: 'Анализ занял слишком много времени, попробуйте снова.' }, 504);
              }
              throw new Error('Сервис анализа недоступен');
            }
            if (!response.ok) {
              const detail = await response.text().catch(() => '');
              console.error(`manga-analyze lovable [${response.status}]:`, detail.slice(0, 2000));
              lastStatus = response.status === 429 ? 429 : 502;
              throw new Error(upstreamErrorMessage(response.status));
            }
            const result = await response.json();
            const content = result?.choices?.[0]?.message?.content;
            if (typeof content !== 'string' || !content.trim()) {
              console.error('manga-analyze: пустой content от модели');
              lastStatus = 502;
              throw new Error('Модель не вернула описание страниц, попробуйте снова');
            }
            raw = content;
          } else if (backend === 'gemini' && attempts.length > 0) {
            const res = await geminiGenerate(attempts, VISION_MODELS, geminiBody, {
              signal: controller.signal,
              label: "manga-analyze",
            });
            if (controller.signal.aborted) {
              return json({ error: 'Анализ занял слишком много времени, попробуйте снова.' }, 504);
            }
            if (!res.ok) {
              lastStatus = res.status === 429 ? 429 : 502;
              throw new Error(res.message);
            }
            const content = extractGenerateText(res.data);
            if (!content.trim()) {
              console.error('manga-analyze: пустой content от Gemini');
              lastStatus = 502;
              throw new Error('Модель не вернула описание страниц, попробуйте снова');
            }
            raw = content;
            source = res.source;
            keyIndex = res.userIndex;
          } else {
            continue;
          }

          let parsed: unknown;
          try {
            parsed = extractJson(raw);
          } catch {
            console.error('manga-analyze: не удалось разобрать JSON:', raw.slice(0, 2000));
            lastStatus = 502;
            throw new Error('Модель вернула разбор в неверном формате, попробуйте снова');
          }

          const pages = normalizePages(parsed, validated.images.length);
          if (!pages) {
            console.error(`manga-analyze: ждали ${validated.images.length} страниц, получили:`, raw.slice(0, 2000));
            lastStatus = 502;
            throw new Error(`Неверный ответ анализа: нужно ровно ${validated.images.length} страниц (до ${MAX_IMAGES} за раз). Попробуйте снова`);
          }

          return json({ pages }, 200, providerResponseHeaders(backend, source, keyIndex));
        } catch (e) {
          lastError = e instanceof Error ? e.message : 'Сервис анализа недоступен';
          console.warn(`manga-analyze: backend ${backend} failed:`, lastError);
        }
      }

      return json({ error: lastError }, lastStatus);
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    console.error('manga-analyze error:', e);
    return json({ error: e instanceof Error ? e.message : 'Ошибка анализа' }, 500);
  }
});
