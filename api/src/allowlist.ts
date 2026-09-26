/**
 * Дверь в API: пускаем только e-mail из белого списка.
 *
 * По умолчанию список состоит из одного адреса — того же, который уже
 * используется в проекте как «безлимитный» (`CAMERA_LIMIT_BYPASS_EMAILS`
 * в `src/lib/imageAttachments.ts` и таблица `unlimited_emails` в drizzle).
 * Переопределяется переменной окружения `ALLOWED_EMAILS` (через запятую).
 */

/** Адрес, для которого API открыт по умолчанию. */
export const DEFAULT_ALLOWED_EMAIL = "babaevafarida8@gmail.com";

/** Приводим e-mail к сравнимому виду: пробелы и регистр не важны. */
export function normalizeEmail(email: string | null | undefined): string {
  if (!email) return "";
  return email.trim().toLowerCase();
}

export function isAllowedEmail(
  email: string | null | undefined,
  allowlist: readonly string[],
): boolean {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  return allowlist.some((allowed) => normalizeEmail(allowed) === normalized);
}

export type GateVerdict =
  | { ok: true; email: string }
  | { ok: false; status: 401 | 403; code: "unauthorized" | "forbidden"; message: string };

/**
 * Проверяет предъявленный e-mail.
 *
 * - e-mail не передан вовсе → 401 (мы не знаем, кто это);
 * - передан, но не из списка → 403 (знаем и не пускаем).
 */
export function checkEmailAccess(
  email: string | null | undefined,
  allowlist: readonly string[],
): GateVerdict {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    return {
      ok: false,
      status: 401,
      code: "unauthorized",
      message: "Не переданы учётные данные: укажите Authorization: Bearer <ключ> или заголовок X-Hikko-Email.",
    };
  }
  if (!isAllowedEmail(normalized, allowlist)) {
    return {
      ok: false,
      status: 403,
      code: "forbidden",
      message: `Доступ к API разрешён только для ${allowlist.join(", ")}.`,
    };
  }
  return { ok: true, email: normalized };
}
