import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CryptoError, encryptSecret, secretAad } from "../_shared/crypto.ts";

/**
 * admin-api-keys — персональный Gemini API key админа.
 *
 *   GET    → статус своей записи: { key: { provider, last4, updated_at } | null }
 *   POST   { key } → шифрует и upsert'ит ключ: { ok: true, last4 }
 *   DELETE → удаляет свою запись: { ok: true }
 *
 * Плейнтекст ключа не пишется в БД и не возвращается ни в одном ответе:
 * в таблице только AES-256-GCM шифротекст (ключ — Edge Secret
 * USER_KEY_ENC_SECRET, см. _shared/crypto.ts), наружу отдаём `last4`.
 *
 * Доступ: валидный JWT + роль admin (owner проходит has_role(..., 'admin')).
 * Чужую строку нельзя ни прочитать, ни записать — RLS `user_api_keys_*`
 * плюс фильтр `.eq('user_id', user.id)` (сервисная роль RLS обходит).
 */

// CORS 1:1 из gemini-proxy (те же origin/headers), расширены только методы:
// у admin-api-keys есть GET и DELETE.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
};

const PROVIDER = 'gemini';

/**
 * Gemini API key: опаковая строка, БЕЗ проверки префикса.
 *
 * Проверять «AIza + 35 = 39» нельзя: с мая 2026 AI Studio выдаёт auth-ключи
 * `AQ.…`, а Google прямо предупреждает, что формат ключа — не контракт.
 * Здесь та же регулярка, что в src/data/apiKeys.ts (валидация до сети в форме);
 * расхождение ловит scripts/unit-api-keys.mjs. По-настоящему ключ проверяет
 * только сам Gemini — при первом же запросе (см. gemini-proxy).
 */
const GEMINI_KEY_RE = /^[A-Za-z0-9_.-]{20,100}$/;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
      // Статус ключа (last4/updated_at) не должен оседать в кэшах/прокси.
      'Cache-Control': 'no-store',
    },
  });
}

/** Ошибки шифрования — это не 400 пользователя, а неверная конфигурация деплоя. */
function configErrorResponse(error: unknown): Response | null {
  if (error instanceof CryptoError) {
    return json({ error: error.code, code: error.code, message: error.message }, 500);
  }
  return null;
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
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

  // Клиент пользователя: и аутентификация, и проверка роли идут под его JWT —
  // как в gemini-proxy, без обращения к сервисной роли на этом шаге.
  const userClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: { user }, error: userError } = await userClient.auth.getUser();
  if (userError || !user) {
    return json({ error: 'unauthorized' }, 401);
  }

  const { data: isAdmin } = await userClient.rpc('has_role', {
    uid: user.id,
    role_to_check: 'admin',
  });
  if (!isAdmin) {
    return json({ error: 'forbidden' }, 403);
  }

  if (req.method === 'GET') {
    // ciphertext/iv читаются только внутри edge-функций (gemini-proxy).
    const { data, error } = await userClient
      .from('user_api_keys')
      .select('provider, last4, updated_at')
      .eq('user_id', user.id)
      .eq('provider', PROVIDER)
      .maybeSingle();

    if (error) {
      return json({ error: 'db_error', message: error.message }, 500);
    }

    return json({ key: data ?? null });
  }

  if (req.method === 'POST') {
    const body = await req.json().catch(() => null) as { key?: unknown } | null;
    const key = typeof body?.key === 'string' ? body.key.trim() : '';

    if (!GEMINI_KEY_RE.test(key)) {
      // Сам ключ в ответе/логах не повторяем.
      return json({
        error: 'invalid_key_format',
        message: 'Ключ выглядит некорректно: нужна строка из 20–512 символов без пробелов (AQ.… или AIza…)',
      }, 400);
    }

    const serviceClient = createClient(supabaseUrl, serviceRoleKey);

    let encrypted: EncryptedSecret;
    try {
      encrypted = await encryptSecret(key, { aad: secretAad(user.id, PROVIDER) });
    } catch (error) {
      const response = configErrorResponse(error);
      if (response) return response;
      throw error;
    }

    const { error } = await serviceClient
      .from('user_api_keys')
      .upsert(
        {
          user_id: user.id,
          provider: PROVIDER,
          ciphertext: encrypted.ciphertext,
          iv: encrypted.iv,
          last4: key.slice(-4),
        },
        { onConflict: 'user_id' }
      );

    if (error) {
      return json({ error: 'db_error', message: error.message }, 500);
    }

    return json({ ok: true, last4: key.slice(-4), provider: PROVIDER });
  }

  if (req.method === 'DELETE') {
    const serviceClient = createClient(supabaseUrl, serviceRoleKey);

    const { error } = await serviceClient
      .from('user_api_keys')
      .delete()
      .eq('user_id', user.id)
      .eq('provider', PROVIDER);

    if (error) {
      return json({ error: 'db_error', message: error.message }, 500);
    }

    return json({ ok: true });
  }

  return json({ error: 'method_not_allowed' }, 405);
});
