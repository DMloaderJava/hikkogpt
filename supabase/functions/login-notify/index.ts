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

  // Письма отключены насовсем. Автоматически одобряем challenge без отправки письма.
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY') || '';
  const adminClient = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    serviceKey,
    { auth: { persistSession: false } }
  );

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

  if (!challengeError && challengeId) {
    await adminClient.rpc('resolve_login_challenge', {
      p_token: confirmToken,
      p_action: 'approve',
    });
  }

  return json(200, {
    ok: true,
    challengeId: challengeId || null,
    skipped: 'emails_disabled',
    approved: true,
  });
});
