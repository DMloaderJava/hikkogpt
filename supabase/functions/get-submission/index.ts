// Edge-функция: статус заявки по публичному токену (+ withdraw в первые 5 мин).
//
// POST { token, action? }:
//   action по умолчанию 'get'      → { status, type, created_at, resolved_at, reason }
//   action = 'withdraw'            → отмена своей pending-заявки (≤5 минут),
//                                    строка удаляется, токен становится 404.
//
// Payload заявки НЕ отдаётся (приватность анонима и защита контента) —
// только статусные поля, см. pickSubmissionStatus в _shared/submissionCore.ts.
// Rate limit: 30/мин на IP (защита от брутфорса токенов).
//
// Деплой: supabase functions deploy get-submission

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  pickSubmissionStatus,
  pickClientIp,
  canWithdraw,
} from '../_shared/submissionCore.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function sha256hex(value: string): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(h), (b) => b.toString(16).padStart(2, '0')).join('');
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

  let requestBody: unknown;
  try {
    requestBody = await req.json();
  } catch {
    return json(400, { ok: false, error: 'invalid_json' });
  }
  if (typeof requestBody !== 'object' || requestBody === null || Array.isArray(requestBody)) {
    return json(400, { ok: false, error: 'invalid_request' });
  }
  const body = requestBody as Record<string, unknown>;
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  const action = typeof body.action === 'string' ? body.action.trim().toLowerCase() : 'get';
  if (!/^[a-f0-9]{32}$/i.test(token) || (action !== 'get' && action !== 'withdraw')) {
    return json(400, { ok: false, error: 'token_and_valid_action_required' });
  }

  // cf-connecting-ip — приоритет (ставит CF, не подделывается); XFF —
  // fallback ПОСЛЕДНИМ элементом (первый контролирует клиент → спуфинг).
  const ip = pickClientIp(
    req.headers.get('cf-connecting-ip'),
    req.headers.get('x-forwarded-for')
  );

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 30/мин на IP: токен — 32 hex-символа, но брутфорс лучше не облегчать.
  const ipHash = await sha256hex(ip + salt);
  const { data: allowed, error: rlError } = await admin.rpc('check_ip_rate_limit', {
    p_ip_hash: ipHash,
    p_limit: 30,
    p_window_seconds: 60,
  });
  if (rlError) return json(500, { ok: false, error: 'rate_limit_rpc' });
  if (allowed !== true) {
    return new Response(JSON.stringify({ ok: false, error: 'rate_limited' }), {
      status: 429,
      headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Retry-After': '60' },
    });
  }

  const { data: row, error } = await admin
    .from('admin_requests')
    .select('status, type, created_at, resolved_at, reject_reason')
    .eq('public_token', token)
    .maybeSingle();

  if (error) return json(500, { ok: false, error: 'lookup_failed' });
  if (!row) return json(404, { ok: false, error: 'not_found' });

  if (action === 'withdraw') {
    if (!canWithdraw(row as { status: string; created_at: string }, Date.now())) {
      return json(409, {
        ok: false,
        error: 'withdraw_unavailable',
        message: 'Отменить можно только pending-заявку в первые 5 минут.',
      });
    }
    const { error: delError } = await admin
      .from('admin_requests')
      .delete()
      .eq('public_token', token);
    if (delError) return json(500, { ok: false, error: 'withdraw_failed' });
    return json(200, { ok: true, withdrawn: true });
  }

  return json(200, { ok: true, ...pickSubmissionStatus(row as never) });
});
