// Edge-функция: уведомление заявителя о решении по его анонимной заявке.
// Вызывается из /admin/requests после resolve, fire-and-forget (ошибка не
// срывает модерацию). Письмо шлёт только если заявитель оставил email.
//
// POST { email, status: 'approved'|'rejected'|'spam', title?, reason?, siteUrl? }
// Auth: только админ/owner (проверка через has_role, как в login-notify).
//
// Секреты: RESEND_API_KEY, OWNER_NOTIFY_FROM (опц.).
// Деплой: supabase functions deploy notify-submitter

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json(401, { ok: false, error: 'Unauthorized' });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: authHeader } } }
  );
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return json(401, { ok: false, error: 'Unauthorized' });
  const { data: isAdmin } = await supabase.rpc('has_role', {
    uid: user.id,
    role_to_check: 'admin',
  });
  if (!isAdmin) return json(403, { ok: false, error: 'Forbidden' });

  let body: { email?: string; status?: string; title?: string; reason?: string; siteUrl?: string } = {};
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: 'invalid_json' });
  }

  const email = (body.email ?? '').trim();
  const status = (body.status ?? '').trim();
  if (!email || !['approved', 'rejected', 'spam'].includes(status)) {
    return json(400, { ok: false, error: 'email and status=approved|rejected|spam required' });
  }

  const apiKey = Deno.env.get('RESEND_API_KEY');
  if (!apiKey) {
    // Уведомления — вспомогательная функция: без ключа это не ошибка модерации.
    return json(200, { ok: true, skipped: 'RESEND_API_KEY not set' });
  }
  const from = Deno.env.get('OWNER_NOTIFY_FROM') || 'Hikkomanga <onboarding@resend.dev>';

  const title = (body.title ?? 'ваш тайтл').slice(0, 200);
  const subject =
    status === 'approved'
      ? `Hikkomanga: «${title}» принят — тайтл создан`
      : `Hikkomanga: «${title}» отклонён`;
  const main =
    status === 'approved'
      ? `<p>Здравствуйте!</p><p>Ваша заявка на тайтл <b>${title}</b> одобрена. Тайтл создан как черновик и скоро появится в каталоге.</p><p>Спасибо за вклад в Hikkomanga!</p>`
      : `<p>Здравствуйте!</p><p>К сожалению, заявка на тайтл <b>${title}</b> была отклонена.${body.reason ? ` Причина: <i>${body.reason}</i>` : ''}</p><p>Вы можете подать новую заявку с исправлениями.</p>`;
  // Email заявителя не верифицируется: дисклеймер снимает «репутационный»
  // риск, когда кто-то указал чужой адрес при подаче фейковой заявки.
  const html = `${main}<p style="color:#888;font-size:12px">Если вы не подавали заявку на Hikkomanga — проигнорируйте это письмо: возможно, кто-то указал ваш адрес по ошибке.</p>`;

  try {
    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [email], subject, html }),
    });
    const data = await resendRes.json().catch(() => null);
    if (!resendRes.ok) {
      return json(502, { ok: false, error: (data as { message?: string })?.message || `Resend HTTP ${resendRes.status}` });
    }
    return json(200, { ok: true, id: (data as { id?: string })?.id });
  } catch (e) {
    return json(502, { ok: false, error: (e as Error).message });
  }
});
