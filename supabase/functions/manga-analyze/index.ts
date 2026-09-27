import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import {
  MAX_IMAGES,
  extractJson,
  geminiAnalyzeBody,
  geminiText,
  normalizePages,
  shouldSwitchApi,
  toAiModel,
  toGoogleModel,
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

/**
 * Системный промпт анализа — один и для основного api (шлюз Lovable), и для
 * запасного (прямой Google Gemini), чтобы смена api не меняла формат реплик.
 */
const SYSTEM_PROMPT = [
  'Ты анализируешь страницы манги и возвращаешь ТОЛЬКО валидный JSON вида:',
  '{"pages":[{"description":"...","transcript":"..."}]}',
  '',
  'Поле transcript — это реплики страницы, СТРОГО в таком формате (номер — реальная цифра, не буква N):',
  'Speaker 1: Ребята, начинаем?',
  '',
  'Speaker 2: Я сказала тебе прекратить!',
  '',
  'Speaker 3: Ладно, ладно, понял.',
  '',
  'Speaker 4: Вы оба довольно забавные.',
  '',
  'Правила transcript:',
  '- каждая реплика начинается с новой строки как «Speaker <номер>: <текст>» — номер от 1 до 8, конкретные цифры;',
  '- между репликами одна пустая строка;',
  '- персонажи без слов получают «Speaker <номер>: (без слов)»;',
  '- номера одного и того же персонажа одинаковы на всех страницах;',
  '- все видимые реплики передай на русском; если текста в кадре нет — придумай краткую реплику по сцене;',
  '- никаких описаний, комментариев, имён вида «Рассказчик:», тире в начале строки, markdown, кавычек вокруг реплик и переводов строк внутри реплики;',
  '- максимум 8 персонажей.',
  '',
  'Поле description — краткое описание сцены на русском (кто где, что происходит, кто говорит). Оно нужно только для стабильных номеров персонажей: в transcript его текст попадать не должен.',
  '',
  'Ответ — только JSON: без markdown-заборов, без пояснений до и после, без полей кроме description и transcript. Ровно один элемент pages на каждое изображение, в том же порядке.',
].join('\n');

/**
 * Запасной api: прямой Google Gemini по ключам `GEMINI_API_KEYS` (те же ключи и
 * тот же маппинг моделей, что в `chat`). Дёргается только когда основной api
 * ответил лимитом/оплатой/сбоем (`shouldSwitchApi`) — иначе ошибка клиента
 * бессмысленно дублировалась бы вторым запросом.
 *
 * Возвращает текст разбора или '' — тогда вызывающий код отвечает прежней
 * понятной ошибкой основного api.
 */
async function tryGeminiAnalyze(systemPrompt: string, images: string[], aiModel: string): Promise<string> {
  const keys = (Deno.env.get('GEMINI_API_KEYS') || '')
    .split(/[\s,;\n]+/)
    .map((k) => k.trim())
    .filter(Boolean);
  if (keys.length === 0) return '';

  const body = geminiAnalyzeBody(systemPrompt, images, images.length);
  if (!body) {
    console.warn('manga-analyze: страницы не перевелись в inline_data — запасной api пропущен');
    return '';
  }

  const googleModel = toGoogleModel(aiModel);
  for (const key of keys) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${googleModel}:generateContent?key=${key}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify(body),
        }
      );
      if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        console.warn(`manga-analyze: запасной api [${resp.status}]: ${txt.slice(0, 200)}`);
        continue;
      }
      const text = geminiText(await resp.json());
      if (text.trim()) {
        console.log(`manga-analyze: разбор получен через запасной api (${googleModel})`);
        return text;
      }
    } catch (e) {
      console.warn('manga-analyze: запасной api недоступен:', e instanceof Error ? e.message : e);
    } finally {
      clearTimeout(timer);
    }
  }

  return '';
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  try {
    const token = req.headers.get('Authorization')?.replace('Bearer ', '');
    if (!token) return json({ error: 'Unauthorized' }, 401);
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!);
    const { data, error } = await sb.auth.getUser(token);
    if (error || !data.user) return json({ error: 'Unauthorized' }, 401);

    const { images, model } = await req.json();
    const validated = validateImages(images);
    if (!validated.ok) return json({ error: validated.error }, 400);

    /** Смена api: имя из переключателя клиента → конкретная модель шлюза. */
    const aiModel = toAiModel(model);

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
          // Модель выбирает клиент (переключатель api); имя уже проверено в toAiModel.
          model: aiModel,
          stream: false,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
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

    let raw = '';
    if (response.ok) {
      const result = await response.json();
      const content = result?.choices?.[0]?.message?.content;
      raw = typeof content === 'string' ? content : '';
    } else {
      const detail = await response.text().catch(() => '');
      console.error(`manga-analyze upstream [${response.status}] (api: ${aiModel}):`, detail.slice(0, 2000));
      // Смена api: основной ответил лимитом, оплатой или сбоем — пробуем запасной.
      if (shouldSwitchApi(response.status)) raw = await tryGeminiAnalyze(SYSTEM_PROMPT, validated.images, aiModel);
      if (!raw.trim()) {
        return json({ error: upstreamErrorMessage(response.status) }, response.status === 429 ? 429 : 502);
      }
    }

    if (!raw.trim()) {
      console.error(`manga-analyze: пустой content от модели (api: ${aiModel})`);
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
