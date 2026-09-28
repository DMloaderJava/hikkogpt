// Абстракция капчи: Turnstile ↔ hCaptcha переключаются секретом
// CAPTCHA_PROVIDER без изменения кода (см. SETUP_SUPABASE.md, «Приём заявок»).
export type CaptchaProvider = 'turnstile' | 'hcaptcha';

const PROVIDER: CaptchaProvider =
  (Deno.env.get('CAPTCHA_PROVIDER') as CaptchaProvider) ?? 'turnstile';

export async function verifyCaptcha(
  token: string,
  remoteip: string
): Promise<{ ok: boolean; error?: string }> {
  if (PROVIDER === 'turnstile') {
    return verifyTurnstile(token, remoteip);
  }
  return verifyHCaptcha(token, remoteip);
}

async function verifyTurnstile(token: string, remoteip: string) {
  const secret = Deno.env.get('TURNSTILE_SECRET_KEY');
  if (!secret) return { ok: false, error: 'turnstile_secret_missing' };
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ secret, response: token, remoteip }),
  });
  const data = await res.json();
  return { ok: !!data.success, error: data.success ? undefined : 'turnstile_failed' };
}

async function verifyHCaptcha(token: string, remoteip: string) {
  const secret = Deno.env.get('HCAPTCHA_SECRET_KEY');
  if (!secret) return { ok: false, error: 'hcaptcha_secret_missing' };
  const res = await fetch('https://hcaptcha.com/siteverify', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ secret, response: token, remoteip }),
  });
  const data = await res.json();
  return { ok: !!data.success, error: data.success ? undefined : 'hcaptcha_failed' };
}
