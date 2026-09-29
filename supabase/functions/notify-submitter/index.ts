// Edge-функция оставлена для совместимости с админ-клиентом, но email отключён.
// Вызывается из /admin/requests после resolve и всегда завершает обработку без письма.
//
// POST { email, status: 'approved'|'rejected'|'spam', title?, reason?, siteUrl? }
// Auth: только админ/owner (проверка через has_role).
//
// Внешние email-секреты не требуются.
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

  // Отправка писем отключена насовсем
  return json(200, { ok: true, skipped: 'emails_disabled' });
});
