// Edge-функция: анонимная заявка на новый тайтл.
//
// POST multipart/form-data:
//   turnstileToken — токен капчи (Turnstile/hCaptcha, см. _shared/captcha.ts)
//   payload        — JSON-строка { original_title, type, description, genres[], ... }
//   email?         — опционально: уведомления о решении (Resend, без верификации в v1)
//   cover          — файл ≤5 MB, jpeg/png/webp, 3:4 ±10%
//
// Порядок проверки: rate limit (15/мин, 100/час, 300/сутки по
// sha256(ip+salt)) → капча → payload → обложка → upload в бакет submissions
// (service_role) → INSERT в admin_requests. Вся логика — в _shared/submissionCore.ts
// (тот же модуль покрывается scripts/unit-submissions.mjs).
//
// Секреты: CAPTCHA_PROVIDER, TURNSTILE_SECRET_KEY | HCAPTCHA_SECRET_KEY,
// RATE_LIMIT_SALT. SUPABASE_SERVICE_ROLE_KEY доступен автоматически.
//
// Деплой: supabase functions deploy submit-title

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verifyCaptcha } from '../_shared/captcha.ts';
import {
  processSubmission,
  pickClientIp,
  type SubmissionDeps,
} from '../_shared/submissionCore.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(status: number, body: unknown, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', ...extraHeaders },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return json(405, { ok: false, error: 'method_not_allowed' });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const salt = Deno.env.get('RATE_LIMIT_SALT') ?? '';
  if (!supabaseUrl || !serviceKey || !salt) {
    return json(500, { ok: false, error: 'config_missing' });
  }

  // service_role: единственный писатель в admin_requests от анонима
  // (RLS «no anon insert»), а также в бакет submissions и ip_rate_limit.
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json(400, { ok: false, error: 'invalid_form' });
  }

  const captchaToken = String(form.get('turnstileToken') ?? form.get('captchaToken') ?? '');
  const email = String(form.get('email') ?? '');
  const payloadRaw = (() => {
    try {
      return JSON.parse(String(form.get('payload') ?? 'null'));
    } catch {
      return null;
    }
  })();
  const cover = form.get('cover');
  const coverBytes =
    cover && typeof cover === 'object' && 'arrayBuffer' in (cover as File)
      ? new Uint8Array(await (cover as File).arrayBuffer())
      : undefined;

  // cf-connecting-ip — приоритет (ставит CF, не подделывается); XFF —
  // fallback ПОСЛЕДНИМ элементом (первый контролирует клиент → спуфинг).
  const ip = pickClientIp(
    req.headers.get('cf-connecting-ip'),
    req.headers.get('x-forwarded-for')
  );

  const deps: SubmissionDeps = {
    verifyCaptcha,
    ipSalt: salt,
    checkLimit: async (windowSeconds, limit) => {
      const { data, error } = await admin.rpc('check_ip_rate_limit', {
        p_ip_hash: await crypto.subtle
          .digest('SHA-256', new TextEncoder().encode(ip + salt))
          .then((h) => Array.from(new Uint8Array(h), (b) => b.toString(16).padStart(2, '0')).join('')),
        // Имя параметра RPC: JS-переменная называется limit (параметр checkLimit),
        // поэтому сокращённая запись `p_limit` давала ReferenceError в Deno.
        p_limit: limit,
        p_window_seconds: windowSeconds,
      });
      if (error) {
        // Fail-closed: RPC недоступен → не принимаем заявку.
        throw new Error(`rate_limit_rpc: ${error.message}`);
      }
      return data === true;
    },
    uploadCover: async (bytes, token, ext) => {
      const path = `${token}/cover.${ext}`;
      const contentType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
      const { error } = await admin.storage
        .from('submissions')
        .upload(path, bytes, { contentType, upsert: true });
      if (error) throw new Error(error.message);
      // Полный публичный URL: триггер копирует его в titles.cover_url как есть.
      return `${supabaseUrl}/storage/v1/object/public/submissions/${path}`;
    },
    insertRequest: async (row) => {
      const { data, error } = await admin
        .from('admin_requests')
        .insert(row)
        .select('id')
        .single();
      if (error) throw new Error(error.message);
      return { id: data.id as string };
    },
  };

  try {
    const result = await processSubmission(deps, {
      captchaToken,
      payloadRaw,
      email,
      coverBytes,
      ip,
      userAgent: req.headers.get('user-agent') ?? undefined,
    });
    return json(
      result.status,
      result.body,
      result.retryAfter ? { 'Retry-After': String(result.retryAfter) } : {}
    );
  } catch (e) {
    // Fail-closed: любые ошибки инфраструктуры — 500, заявки нет.
    return json(500, {
      ok: false,
      error: 'internal',
      detail: e instanceof Error ? e.message : String(e),
    });
  }
});
