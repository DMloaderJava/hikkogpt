import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import {
  MAX_IMAGES,
  extractJson,
  normalizePages,
  upstreamErrorMessage,
  validateImages,
} from './parse.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

/** Сколько ждём модель: wall-clock лимит edge-функции на Free — 150 с. */
const UPSTREAM_TIMEOUT_MS = 120_000;

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  try {
    const token = req.headers.get('Authorization')?.replace('Bearer ', '');
    if (!token) return json({ error: 'Unauthorized' }, 401);
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!);
    const { data, error } = await sb.auth.getUser(token);
    if (error || !data.user) return json({ error: 'Unauthorized' }, 401);

    const { images } = await req.json();
    const validated = validateImages(images);
    if (!validated.ok) return json({ error: validated.error }, 400);

    const key = Deno.env.get('LOVABLE_API_KEY');
    if (!key) return json({ error: 'AI не настроен' }, 500);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: 'google/gemini-3-flash-preview',
          stream: false,
          messages: [
            {
              role: 'system',
              content:
                'Ты анализируешь мангу. Ответь ТОЛЬКО валидным JSON: {"pages":[{"description":"краткое описание сцены на русском","transcript":"Speaker 1: текст\\nSpeaker 2: текст"}]}. Ровно один элемент pages на каждое изображение в том же порядке. Сохраняй номера говорящих персонажей между страницами. Передай видимые реплики на русском; если текста нет, придумай краткую реплику по сцене и обозначь это в description. Не более 8 персонажей. Без markdown.',
            },
            {
              role: 'user',
              content: [
                { type: 'text', text: `Проанализируй ${validated.images.length} страниц манги по порядку.` },
                ...validated.images.map((url: string) => ({ type: 'image_url', image_url: { url } })),
              ],
            },
          ],
        }),
      });
    } catch (e) {
      const timedOut = e instanceof Error && e.name === 'AbortError';
      return json({ error: timedOut ? 'Анализ занял слишком много времени, попробуйте снова.' : 'Сервис анализа недоступен' }, 504);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      console.error(`manga-analyze upstream [${response.status}]:`, detail.slice(0, 2000));
      return json({ error: upstreamErrorMessage(response.status) }, response.status === 429 ? 429 : 502);
    }

    const result = await response.json();
    const raw = result?.choices?.[0]?.message?.content;
    if (typeof raw !== 'string' || !raw.trim()) {
      console.error('manga-analyze: пустой content от модели');
      return json({ error: 'Модель не вернула описание страниц, попробуйте снова' }, 502);
    }

    let parsed: unknown;
    try {
      parsed = extractJson(raw);
    } catch (e) {
      console.error('manga-analyze: не удалось разобрать JSON:', raw.slice(0, 2000));
      return json({ error: 'Модель вернула разбор в неверном формате, попробуйте снова' }, 502);
    }

    const pages = normalizePages(parsed, validated.images.length);
    if (!pages) {
      console.error(`manga-analyze: ждали ${validated.images.length} страниц, получили:`, raw.slice(0, 2000));
      return json({ error: `Неверный ответ анализа: нужно ровно ${validated.images.length} страниц (до ${MAX_IMAGES} за раз). Попробуйте снова` }, 502);
    }

    return json({ pages });
  } catch (e) {
    console.error('manga-analyze error:', e);
    return json({ error: e instanceof Error ? e.message : 'Ошибка анализа' }, 500);
  }
});
