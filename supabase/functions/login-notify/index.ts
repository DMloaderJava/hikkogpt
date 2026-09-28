// Supabase Edge Function: обязательное подтверждение входа администратора.
//
// 1) Создаёт login_challenge (RPC create_login_challenge) под JWT пользователя.
// 2) Шлёт письмо владельцу со ссылками approve/deny (токен только в письме).
// 3) Без успешной отправки письма клиент обязан откатить вход (signOut).
//
// Секреты (Supabase → Edge Functions → Secrets, или `supabase secrets set`):
//   RESEND_API_KEY     — ключ Resend
//   OWNER_NOTIFY_EMAIL — адрес владельца, куда слать письмо
//   OWNER_NOTIFY_FROM  — опционально, по умолчанию onboarding@resend.dev
//
// Деплой: supabase functions deploy login-notify --project-ref <ref>

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  buildLoginMailHtml,
  buildLoginMailSubject,
  type LoginMailPayload,
} from "../_shared/loginMailTemplate.ts";
import { generateLoginChallengeToken } from "../_shared/loginChallengeToken.ts";

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

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return json(405, { ok: false, error: 'Method not allowed' });
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return json(401, { ok: false, error: 'Unauthorized' });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: authHeader } } }
  );

  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return json(401, { ok: false, error: 'Unauthorized' });
  }

  const { data: isAdmin } = await supabase.rpc('has_role', {
    uid: user.id,
    role_to_check: 'admin',
  });
  if (!isAdmin) {
    return json(403, { ok: false, error: 'Forbidden' });
  }

  let payload: LoginMailPayload = {};
  try {
    payload = (await req.json()) as LoginMailPayload;
  } catch {
    // пустое тело допустимо
  }

  const to = Deno.env.get('OWNER_NOTIFY_EMAIL');
  const apiKey = Deno.env.get('RESEND_API_KEY');
  if (!to) {
    return json(500, { ok: false, error: 'OWNER_NOTIFY_EMAIL secret is not set' });
  }
  if (!apiKey) {
    return json(503, { ok: false, error: 'RESEND_API_KEY secret is not set' });
  }
  const from =
    Deno.env.get('OWNER_NOTIFY_FROM') || 'Hikkomanga Login Guard <onboarding@resend.dev>';

  // session_id из JWT (GoTrue) — multi-device Login Guard.
  // Без claim RPC возьмёт auth.jwt()->>'session_id' сам; явная передача надёжнее.
  // authHeader уже проверен выше (401 без Authorization).
  let sessionId: string | null = null;
  try {
    const rawJwt = authHeader.replace(/^Bearer\s+/i, '').trim();
    const mid = rawJwt.split('.')[1];
    if (mid) {
      // atob требует длину, кратную 4 — JWT payload часто без '='.
      const b64 = mid.replace(/-/g, '+').replace(/_/g, '/');
      const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
      const json = JSON.parse(atob(padded)) as {
        session_id?: string;
        sessionId?: string;
      };
      sessionId = json.session_id || json.sessionId || null;
    }
  } catch {
    // fallback: create_login_challenge возьмёт auth.jwt()->>'session_id'
    sessionId = null;
  }

  const confirmToken = generateLoginChallengeToken();
  const ip =
    payload.ip || req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || undefined;

  const { data: challengeId, error: challengeError } = await supabase.rpc(
    'create_login_challenge',
    {
      p_token: confirmToken,
      p_admin_email: payload.adminEmail || user.email || null,
      p_user_agent: payload.userAgent || null,
      p_ip: ip || null,
      p_ttl_minutes: 15,
      p_session_id: sessionId,
    }
  );
  if (challengeError || !challengeId) {
    return json(500, {
      ok: false,
      error: challengeError?.message || 'не удалось создать challenge',
    });
  }

  const enriched: LoginMailPayload = {
    ...payload,
    adminEmail: payload.adminEmail || user.email || undefined,
    ip,
    confirmToken,
  };

  try {
    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: buildLoginMailSubject(enriched),
        html: buildLoginMailHtml(enriched),
      }),
    });
    const data = await resendRes.json().catch(() => null);
    if (!resendRes.ok) {
      return json(502, {
        ok: false,
        error: (data as { message?: string })?.message || `Resend HTTP ${resendRes.status}`,
      });
    }
    // Токен клиенту не отдаём — только id challenge для отладки.
    return json(200, {
      ok: true,
      challengeId,
      id: (data as { id?: string })?.id,
    });
  } catch (e) {
    return json(502, { ok: false, error: (e as Error).message });
  }
});
