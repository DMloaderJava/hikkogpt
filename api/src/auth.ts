/**
 * Кто стучится в API.
 *
 * Поддерживаются четыре способа (проверяются по порядку):
 *
 * | # | Способ | Заголовок | Когда использовать |
 * |---|--------|-----------|--------------------|
 * | 1 | Статический ключ | `Authorization: Bearer <HIKKO_API_KEY>` | Скрипты/интеграции, ключ задан в env |
 * | 2 | Производный HMAC-ключ | `Authorization: Bearer hk1.…` | Выдаётся владельцу e-mail, базы не требует |
 * | 3 | Supabase JWT | `Authorization: Bearer <access_token>` | Тот же пользователь, что в веб-приложении |
 * | 4 | Заголовок e-mail | `X-Hikko-Email: …` | Только локальная разработка (`ALLOW_HEADER_AUTH`) |
 *
 * Любой из способов в итоге даёт e-mail, который проверяется белым списком.
 */
import { isAllowedEmail, normalizeEmail } from "./allowlist.ts";
import type { ApiConfig } from "./config.ts";
import { isExpired, parseToken, verifySignature } from "./token.ts";

export type AuthMethod = "api_key" | "token" | "supabase_jwt" | "dev_header";

export interface Identity {
  email: string;
  method: AuthMethod;
  keyKind: "static" | "derived" | "jwt";
}

export class AuthError extends Error {
  status: 401 | 403;
  code: "unauthorized" | "forbidden";
  constructor(status: 401 | 403, code: "unauthorized" | "forbidden", message: string) {
    super(message);
    this.name = "AuthError";
    this.status = status;
    this.code = code;
  }
}

export function bearerOf(headers: Headers): string {
  const header = headers.get("authorization") ?? headers.get("Authorization") ?? "";
  const value = header.trim();
  if (!value) return "";
  return value.replace(/^Bearer\s+/i, "").trim();
}

/**
 * Валидация Supabase JWT через `auth/v1/user` (тот же приём, что в edge-функциях).
 * Возвращает e-mail пользователя или `null`, если токен не прошёл.
 */
export async function resolveSupabaseEmail(
  jwt: string,
  config: ApiConfig,
): Promise<string | null> {
  if (!config.supabaseUrl || !config.supabaseAnonKey) return null;
  if (jwt.split(".").length !== 3) return null; // не похоже на JWT
  try {
    const response = await fetch(`${config.supabaseUrl.replace(/\/$/, "")}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        apikey: config.supabaseAnonKey,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const json = (await response.json()) as { email?: string };
    return normalizeEmail(json.email ?? "");
  } catch {
    return null;
  }
}

export interface AuthenticateOptions {
  headers: Headers;
  config: ApiConfig;
  /** Отключить поход в Supabase (нужно для быстрых юнит-тестов). */
  skipSupabase?: boolean;
}

/**
 * Разобрать учётные данные и проверить e-mail белым списком.
 * Бросает `AuthError` с готовым статусом (401/403).
 */
export async function authenticate(options: AuthenticateOptions): Promise<Identity> {
  const { headers, config } = options;
  const bearer = bearerOf(headers);

  if (bearer) {
    // 1. статический ключ из env
    if (config.staticApiKey && bearer === config.staticApiKey) {
      const email = config.allowlist[0] ?? "";
      assertAllowed(email, config);
      return { email: normalizeEmail(email), method: "api_key", keyKind: "static" };
    }

    // 2. производный HMAC-ключ
    const parsed = parseToken(bearer);
    if (parsed.kind === "derived") {
      if (!verifySignature(bearer, config.secret)) {
        throw new AuthError(401, "unauthorized", "Ключ доступа повреждён или выдан для другого секрета.");
      }
      if (isExpired(parsed.expiresAt)) {
        throw new AuthError(401, "unauthorized", "Срок действия ключа истёк — выпустите новый.");
      }
      assertAllowed(parsed.email, config);
      return { email: parsed.email, method: "token", keyKind: "derived" };
    }

    // 3. Supabase JWT (проверяем только если похож на JWT — иначе лишний сетевой поход)
    if (!options.skipSupabase && bearer.split(".").length === 3) {
      const email = await resolveSupabaseEmail(bearer, config);
      if (email) {
        assertAllowed(email, config);
        return { email, method: "supabase_jwt", keyKind: "jwt" };
      }
    }
  }

  // 4. заголовок e-mail — только для разработки
  const headerEmail = normalizeEmail(headers.get("x-hikko-email"));
  if (headerEmail && config.allowHeaderAuth) {
    assertAllowed(headerEmail, config);
    return { email: headerEmail, method: "dev_header", keyKind: "derived" };
  }

  if (!bearer) {
    throw new AuthError(
      401,
      "unauthorized",
      "Нет ключа доступа. Передайте Authorization: Bearer <ключ> (см. api/README.md).",
    );
  }
  throw new AuthError(401, "unauthorized", "Ключ доступа не распознан.");
}

function assertAllowed(email: string, config: ApiConfig): void {
  if (!isAllowedEmail(email, config.allowlist)) {
    throw new AuthError(
      403,
      "forbidden",
      `Этот API приватный: доступ разрешён только для ${config.allowlist.join(", ")}.`,
    );
  }
}
