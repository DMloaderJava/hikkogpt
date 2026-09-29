/**
 * Разбор тела auth-register. Без Deno/сети — тот же модуль гоняют тесты Vite.
 *
 * Функция создаёт уже подтверждённый аккаунт и не шлёт письмо со ссылкой.
 * Пароль существующего пользователя здесь не меняется: подтверждение почты
 * не должно становиться способом захватить аккаунт.
 */

export type RegisterAction = "register" | "confirm";

export interface ParsedRegisterInput {
  email: string;
  password: string;
  action: RegisterAction;
}

export type ParseRegisterResult =
  | ({ ok: true } & ParsedRegisterInput)
  | { ok: false; status: number; error: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 6;
/** bcrypt молча режет пароль длиннее 72 байт — лучше явный отказ. */
const MAX_PASSWORD = 72;

export function parseRegisterInput(body: unknown): ParseRegisterResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, status: 400, error: "invalid_request" };
  }
  const rec = body as Record<string, unknown>;
  const email = typeof rec.email === "string" ? rec.email.trim().toLowerCase() : "";
  const password = typeof rec.password === "string" ? rec.password : "";
  const rawAction = rec.action;

  let action: RegisterAction;
  if (rawAction === undefined || rawAction === "register") action = "register";
  else if (rawAction === "confirm") action = "confirm";
  else return { ok: false, status: 400, error: "invalid_action" };

  if (!EMAIL_RE.test(email) || email.length > 320) {
    return { ok: false, status: 400, error: "invalid_email" };
  }
  // confirm только помечает уже существующий аккаунт. Пароль не нужен и не
  // принимается как доказательство владения — вход всё равно через пароль.
  if (action === "register" && (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD)) {
    return { ok: false, status: 400, error: "weak_password" };
  }
  return { ok: true, email, password: action === "confirm" ? "" : password, action };
}

/** GoTrue: email уже занят. Пароль при этом не перезаписываем. */
export function isExistingUserError(message: string, code?: string | null): boolean {
  if (code === "email_exists" || code === "user_already_exists") return true;
  const normalized = message.toLowerCase();
  return (
    normalized.includes("already registered") ||
    normalized.includes("already been registered") ||
    normalized.includes("user already exists") ||
    normalized.includes("email address has already been")
  );
}
