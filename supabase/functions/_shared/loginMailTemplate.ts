/**
 * Шаблон письма-подтверждения входа админа (Login Guard / 2FA-light).
 * Чистый модуль без зависимостей: лежит в supabase/functions/_shared/,
 * чтобы попадать в бандл Edge Function. Его же импортирует Vite
 * (dev-транспорт /api/login-notify).
 *
 * Без перехода по ссылке «Подтвердить» вход в админку не открывается.
 */

export interface LoginMailPayload {
  adminEmail?: string;
  loginAt?: string;
  userAgent?: string;
  siteUrl?: string;
  ip?: string;
  /** Секретный токен challenge — без него ссылки подтверждения не собрать. */
  confirmToken?: string;
}

export function buildLoginMailSubject(p: LoginMailPayload): string {
  return `Подтвердите вход в Hikkomanga: ${p.adminEmail || 'неизвестный аккаунт'}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('ru-RU', {
      dateStyle: 'full',
      timeStyle: 'long',
    });
  } catch {
    return iso;
  }
}

function shortAgent(ua?: string): string {
  if (!ua) return '—';
  const clean = ua.length > 120 ? ua.slice(0, 117) + '…' : ua;
  return clean;
}

function confirmHref(siteUrl: string | undefined, token: string | undefined, action: 'approve' | 'deny'): string {
  const site = (siteUrl || '').replace(/\/$/, '');
  if (!site || !token) return '#';
  const q = new URLSearchParams({ token, action });
  return `${site}/admin/login/confirm?${q.toString()}`;
}

export function buildLoginMailHtml(p: LoginMailPayload): string {
  const ackHref = confirmHref(p.siteUrl, p.confirmToken, 'approve');
  const denyHref = confirmHref(p.siteUrl, p.confirmToken, 'deny');

  return `
<!doctype html>
<html lang="ru">
<body style="margin:0;padding:0;background:#0a0a0a;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0"
             style="max-width:560px;width:100%;background:#171717;border:1px solid #262626;border-radius:16px;overflow:hidden;">
        <tr>
          <td style="padding:24px 28px 8px;">
            <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#f43f5e;font-weight:700;">
              Hikkomanga · Login Guard
            </div>
            <h1 style="margin:10px 0 4px;font-size:20px;color:#fafafa;">
              Подтвердите вход в админ-панель
            </h1>
            <p style="margin:0;font-size:14px;line-height:1.6;color:#a3a3a3;">
              Кто-то ввёл пароль администратора. <strong style="color:#e5e5e5;">Без вашего
              подтверждения вход не откроется.</strong> Если это были вы — нажмите «Подтвердить».
              Если нет — нажмите «Это не я» и смените пароль.
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:8px 28px 4px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
                   style="background:#0a0a0a;border:1px solid #262626;border-radius:12px;font-size:14px;">
              <tr>
                <td style="padding:10px 16px;color:#737373;width:110px;">Аккаунт</td>
                <td style="padding:10px 16px;color:#fafafa;font-weight:600;">${escapeHtml(p.adminEmail || '—')}</td>
              </tr>
              <tr>
                <td style="padding:10px 16px;color:#737373;border-top:1px solid #1f1f1f;">Когда</td>
                <td style="padding:10px 16px;color:#e5e5e5;border-top:1px solid #1f1f1f;">${escapeHtml(formatDate(p.loginAt))}</td>
              </tr>
              <tr>
                <td style="padding:10px 16px;color:#737373;border-top:1px solid #1f1f1f;">IP</td>
                <td style="padding:10px 16px;color:#e5e5e5;border-top:1px solid #1f1f1f;font-family:ui-monospace,monospace;">${escapeHtml(p.ip || 'не определён')}</td>
              </tr>
              <tr>
                <td style="padding:10px 16px;color:#737373;border-top:1px solid #1f1f1f;">Браузер</td>
                <td style="padding:10px 16px;color:#a3a3a3;border-top:1px solid #1f1f1f;font-size:12px;">${escapeHtml(shortAgent(p.userAgent))}</td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 28px 8px;" align="center">
            <a href="${escapeHtml(ackHref)}"
               style="display:inline-block;background:#16a34a;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 22px;border-radius:10px;margin:4px 6px;">
              Подтвердить — это я
            </a>
            <a href="${escapeHtml(denyHref)}"
               style="display:inline-block;background:#dc2626;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 22px;border-radius:10px;margin:4px 6px;">
              Это не я
            </a>
          </td>
        </tr>
        <tr>
          <td style="padding:8px 28px 24px;">
            <p style="margin:0;font-size:12px;line-height:1.6;color:#737373;">
              Ссылка действует 15 минут. Если вход совершили не вы: нажмите «Это не я»,
              затем смените пароль администратора (Supabase → Authentication → Users)
              и завершите активные сессии. Письмо отправлено автоматически.
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`.trim();
}
