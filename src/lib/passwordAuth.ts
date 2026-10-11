/**
 * Вход и регистрация без подтверждения почты.
 *
 * Письмо со ссылкой и экран проверки почты не используются. Edge-функция
 * auth-register создаёт уже подтверждённый аккаунт и не вызывает публичный
 * signUp — тот как раз и отправляет письмо. Сессию выдаёт обычный
 * signInWithPassword: пароль по-прежнему нужен.
 */

import { supabase } from "@/integrations/supabase/client";
import { EdgeRequestError, edgeJson } from "@/lib/edgeAuth";

export const EMAIL_LINK_DISABLED_MESSAGE =
  "Подтверждение по ссылке из письма отключено. Попробуйте войти ещё раз.";

const ALREADY_REGISTERED_MESSAGE = "Пользователь с таким email уже зарегистрирован";

export type AuthAttempt = { ok: true } | { ok: false; message: string };

export interface EnsureAccountInput {
  email: string;
  password?: string;
  action: "register" | "confirm";
}

export type EnsureAccountResult =
  | { ok: true; created: boolean }
  | { ok: false; unavailable: boolean; message: string };

export interface PasswordAuthClient {
  signIn(email: string, password: string): Promise<{ errorMessage: string | null; hasSession: boolean }>;
  ensureAccount(input: EnsureAccountInput): Promise<EnsureAccountResult>;
}

export function isEmailNotConfirmedMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("email not confirmed") ||
    normalized.includes("email_not_confirmed") ||
    normalized.includes("email confirmations required") ||
    normalized.includes("confirm your email") ||
    /проверьте почту/i.test(message) ||
    /check your email/i.test(message)
  );
}

function isInvalidCredentials(message: string): boolean {
  return message.toLowerCase().includes("invalid login credentials");
}

export function mapAuthError(message: string): string {
  if (isEmailNotConfirmedMessage(message)) return EMAIL_LINK_DISABLED_MESSAGE;
  const errors: Record<string, string> = {
    "Invalid login credentials": "Неверный email или пароль",
    "User already registered": ALREADY_REGISTERED_MESSAGE,
    "Password should be at least 6 characters": "Пароль должен быть минимум 6 символов",
    "Invalid email": "Неверный формат email",
    "Email rate limit exceeded": "Слишком много запросов. Попробуйте позже.",
    "Signup disabled": "Регистрация отключена",
    invalid_email: "Введите корректный email адрес",
    weak_password: "Пароль должен быть минимум 6 символов",
    rate_limited: "Слишком много запросов. Попробуйте позже.",
    signup_failed: "Не удалось создать аккаунт. Попробуйте ещё раз.",
    confirm_failed: EMAIL_LINK_DISABLED_MESSAGE,
  };
  for (const [key, value] of Object.entries(errors)) {
    if (message.includes(key)) return value;
  }
  return message;
}

function mapEnsureError(error: string | undefined): string {
  return mapAuthError(error || "signup_failed");
}

export async function ensureConfirmedAccount(input: EnsureAccountInput): Promise<EnsureAccountResult> {
  try {
    const data = await edgeJson<{ ok?: boolean; created?: boolean; error?: string }>(
      "auth-register",
      {
        email: input.email,
        action: input.action,
        ...(input.action === "register" ? { password: input.password } : {}),
      },
      undefined,
      { timeoutMs: 20_000 },
    );
    if (data?.ok) return { ok: true, created: Boolean(data.created) };
    return { ok: false, unavailable: false, message: mapEnsureError(data?.error) };
  } catch (error) {
    if (error instanceof EdgeRequestError) {
      // 404 шлюза — функции ещё нет. Наш confirm_failed тоже 404, но это не
      // «функция отсутствует»: публичный signUp тогда снова отправит письмо.
      const missingFunction =
        error.network ||
        (error.status === 404 && !error.message.includes("confirm_failed"));
      return { ok: false, unavailable: missingFunction, message: mapEnsureError(error.message) };
    }
    return { ok: false, unavailable: true, message: EMAIL_LINK_DISABLED_MESSAGE };
  }
}

async function finishSignIn(
  client: PasswordAuthClient,
  email: string,
  password: string,
  alreadyRegisteredOnBadPassword: boolean,
): Promise<AuthAttempt> {
  const first = await client.signIn(email, password);
  if (first.hasSession) return { ok: true };

  if (first.errorMessage && isEmailNotConfirmedMessage(first.errorMessage)) {
    await client.ensureAccount({ email, action: "confirm" });
    const second = await client.signIn(email, password);
    if (second.hasSession) return { ok: true };
    if (second.errorMessage && !isEmailNotConfirmedMessage(second.errorMessage)) {
      return { ok: false, message: mapAuthError(second.errorMessage) };
    }
    return { ok: false, message: EMAIL_LINK_DISABLED_MESSAGE };
  }

  if (
    alreadyRegisteredOnBadPassword &&
    first.errorMessage &&
    isInvalidCredentials(first.errorMessage)
  ) {
    return { ok: false, message: ALREADY_REGISTERED_MESSAGE };
  }

  return { ok: false, message: mapAuthError(first.errorMessage || "Не удалось войти") };
}

export async function signInWithoutEmailLink(
  client: PasswordAuthClient,
  email: string,
  password: string,
): Promise<AuthAttempt> {
  return finishSignIn(client, email, password, false);
}

export async function signUpWithoutEmailLink(
  client: PasswordAuthClient,
  email: string,
  password: string,
): Promise<AuthAttempt> {
  const ensured = await client.ensureAccount({ email, password, action: "register" });
  // `ok === false`: при strict: false отрицательное сужение `!ok` не работает.
  if (ensured.ok === false) {
    // Публичный signUp не вызываем: при включённом Confirm email он шлёт ссылку.
    return {
      ok: false,
      message: ensured.unavailable
        ? "Регистрация без письма сейчас недоступна. Попробуйте позже."
        : ensured.message,
    };
  }
  return finishSignIn(client, email, password, !ensured.created);
}

export function createSupabasePasswordAuthClient(): PasswordAuthClient {
  return {
    async signIn(email, password) {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      return { errorMessage: error?.message ?? null, hasSession: Boolean(data.session) };
    },
    ensureAccount: ensureConfirmedAccount,
  };
}
