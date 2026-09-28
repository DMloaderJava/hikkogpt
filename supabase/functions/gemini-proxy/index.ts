import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CryptoError, decryptSecret, secretAad } from "../_shared/crypto.ts";
import {
  GEMINI_ANALYZE_MODEL,
  TtsPlanError,
  buildTtsResponse,
  extractTtsAudio,
  geminiEndpoint,
  geminiErrorMessage,
  geminiHeaders,
  mergeTtsAudio,
  planTtsRequests,
} from "../_shared/gemini-tts.ts";

/**
 * gemini-proxy — AI-анализ страниц (/analyze) и озвучка (/tts).
 *
 * Ключ Gemini берётся у пользователя, который вызвал функцию
 * (`public.user_api_keys`, шифротекст AES-256-GCM), и расшифровывается
 * внутри функции секретом USER_KEY_ENC_SECRET.
 *
 * Общего секрета GEMINI_API_KEY здесь НЕТ намеренно: фолбэк на один ключ
 * на всех означал бы, что заявленный «свой ключ админа» ни на что не влияет,
 * а лимиты и биллинг Gemini размазываются по всем аккаунтам сразу. Нет
 * ключа — 403 с кодом `gemini_key_missing`, UI отправляет в /admin/settings.
 *
 * Ключ уходит в Gemini заголовком `x-goog-api-key` (см. _shared/gemini-tts.ts):
 * новые auth-ключи `AQ.…` с `?key=` не работают (404), а старые `AIza…`
 * работают и так. Формат ключа здесь не проверяется — он опаковый.
 *
 * Модели: `gemini-3.8-flash` (vision) и `gemini-3.8-flash-tts` (озвучка).
 * Форма запроса/ответа TTS — в `_shared/gemini-tts.ts`, он же используется
 * dev-middleware в vite.config.ts.
 *
 * Запросы (одна функция, действие — полем в теле; сабпасы в URL давали 404):
 *   POST { action: 'analyze', imageBase64, mimeType }
 *   POST { action: 'tts', lines, voiceMap }
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

type KeyResult = { ok: true; key: string } | { ok: false; response: Response };

/** Читает и расшифровывает ключ вызывающего. Чужие строки недоступны (RLS). */
async function resolveGeminiKey(
  supabase: ReturnType<typeof createClient>,
  userId: string
): Promise<KeyResult> {
  const { data, error } = await supabase
    .from('user_api_keys')
    .select('provider, ciphertext, iv')
    .eq('user_id', userId)
    .eq('provider', 'gemini')
    .maybeSingle();

  if (error) {
    // 42P01 = relation does not exist: миграция с user_api_keys не применена.
    const message = error.code === '42P01'
      ? 'Таблица public.user_api_keys не найдена — примените миграцию 00000000000017_user_api_keys.sql.'
      : error.message;

    return {
      ok: false,
      response: json({ error: 'db_error', code: 'db_error', message }, 500),
    };
  }

  if (!data) {
    return {
      ok: false,
      response: json(
        {
          error: 'gemini_key_missing',
          code: 'gemini_key_missing',
          message: 'Gemini API key не задан. Добавьте свой ключ: /admin/settings',
        },
        403
      ),
    };
  }

  try {
    const key = await decryptSecret(
      { ciphertext: data.ciphertext as string, iv: data.iv as string },
      { aad: secretAad(userId, data.provider as string) }
    );

    if (!key.trim()) {
      throw new CryptoError('decrypt_failed', 'Расшифрованный ключ пуст');
    }

    return { ok: true, key };
  } catch (error) {
    const code = error instanceof CryptoError ? error.code : 'decrypt_failed';
    // ciphertext/plaintext в ответе нет — только код и подсказка.
    return {
      ok: false,
      response: json(
        {
          error: 'gemini_key_unreadable',
          code: 'gemini_key_unreadable',
          reason: code,
          message:
            code === 'enc_secret_missing' || code === 'enc_secret_invalid'
              ? 'Проверьте Edge Secret USER_KEY_ENC_SECRET в проекте Supabase.'
              : 'Ключ не расшифровывается (сменён USER_KEY_ENC_SECRET?). Сохраните ключ заново: /admin/settings',
        },
        500
      ),
    };
  }
}

/**
 * Ошибка Gemini превращается в нормализованный ответ (вместо «200 с телом
 * error»): клиент читает `code`/`message` и показывает их админу, а не
 * бесполезное «ошибка сервиса».
 */
function upstreamErrorResponse(payload: unknown, status: number, scope: string): Response {
  return json(
    {
      error: 'gemini_upstream_error',
      code: 'gemini_upstream_error',
      status,
      message: `${scope}: ${geminiErrorMessage(payload, `Gemini API вернул ${status}`)}`,
    },
    502
  );
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return json({ error: 'unauthorized' }, 401);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return json({ error: 'unauthorized' }, 401);
  }

  const { data: isAdmin } = await supabase.rpc('has_role', {
    uid: user.id,
    role_to_check: 'admin',
  });

  if (!isAdmin) {
    return json({ error: 'forbidden' }, 403);
  }

  // Действие берём из ТЕЛА запроса, а не из пути: supabase-js собирает URL
  // как /functions/v1/<имя функции>, поэтому вызов `gemini-proxy/analyze`
  // превращался в /functions/v1/gemini-proxy/analyze — шлюз Supabase трактует
  // это как функцию с именем «gemini-proxy/analyze» и отдаёт 404 ещё до нашей
  // функции. Формат: { action: 'analyze' | 'tts', ...остальные поля }.
  const body = await req.json().catch(() => ({}));
  const { action, ...payload } = body;
  const isAnalyze = action === 'analyze';
  const isTts = action === 'tts';

  // 1. Analyze Endpoint (Vision)
  if (req.method === 'POST' && isAnalyze) {
    const key = await resolveGeminiKey(supabase, user.id);
    if (!key.ok) return key.response;

    const { imageBase64, mimeType } = payload;
    const promptText = `Ты — анализатор манги. Извлеки все диалоговые облака и закадровый текст со страницы.
Верни СТРОГО чистый JSON массив без разметки: [{"speaker":"Speaker1","text":"..."}]`;

    const response = await fetch(geminiEndpoint(GEMINI_ANALYZE_MODEL), {
      method: 'POST',
      headers: geminiHeaders(key.key),
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: promptText },
              { inlineData: { mimeType: mimeType || 'image/jpeg', data: imageBase64 } },
            ],
          },
        ],
      }),
    });

    const data = await response.json().catch(() => null);
    if (!response.ok) {
      return upstreamErrorResponse(data, response.status, 'Анализ страницы не удался');
    }

    return json(data, 200);
  }

  // 2. TTS Endpoint (Speech Synthesis)
  if (req.method === 'POST' && isTts) {
    const key = await resolveGeminiKey(supabase, user.id);
    if (!key.ok) return key.response;

    const { lines, voiceMap } = payload;

    let plan: ReturnType<typeof planTtsRequests>;
    try {
      plan = planTtsRequests(lines, voiceMap);
    } catch (error) {
      if (error instanceof TtsPlanError) {
        return json({ error: error.code, code: error.code, message: error.message }, 400);
      }
      throw error;
    }

    // Чанк = максимум 2 голоса (лимит Gemini 3.8 TTS). Реплики идут по
    // порядку, поэтому склейка PCM даёт ту же последовательность, что и один
    // большой запрос.
    const audioChunks: string[] = [];

    for (let index = 0; index < plan.length; index++) {
      const chunk = plan[index];
      const response = await fetch(geminiEndpoint(GEMINI_TTS_MODEL), {
        method: 'POST',
        headers: geminiHeaders(key.key),
        body: JSON.stringify(chunk.body),
      });

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        const scope = plan.length > 1
          ? `Озвучка не удалась (фрагмент ${index + 1} из ${plan.length}, голоса: ${chunk.speakers.join(', ')})`
          : 'Озвучка не удалась';
        return upstreamErrorResponse(data, response.status, scope);
      }

      const audio = extractTtsAudio(data);
      if (!audio) {
        return json(
          {
            error: 'gemini_tts_empty',
            code: 'gemini_tts_empty',
            message: 'Gemini вернул ответ без аудио. Попробуйте ещё раз или замените ключ в /admin/settings.',
          },
          502
        );
      }

      audioChunks.push(audio);
    }

    return json(buildTtsResponse(mergeTtsAudio(audioChunks)), 200);
  }

  return new Response('Not Found', { status: 404, headers: corsHeaders });
});
