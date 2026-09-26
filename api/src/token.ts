/**
 * Ключи доступа и токены.
 *
 * Два вида «bearer»-строк:
 *
 * 1. **Статический ключ** `HIKKO_API_KEY` из окружения — просто совпадает побайтово.
 * 2. **Производный ключ** `hk1.<email-base64url>.<exp>.<подпись>` — вычисляется из
 *    e-mail и секрета `HIKKO_API_SECRET`. Такой ключ можно выдать владельцу адреса
 *    без похода в базу: сервер проверяет подпись и сверяет e-mail с белым списком.
 *
 * Подпись — HMAC-SHA256, сравнение — через `timingSafeEqual` (без timing-атак).
 *
 * ⚠️ Разделитель именно `.`: алфавит base64url включает `-` и `_`, поэтому
 * разделитель `_` резал бы подпись на части (проверено тестом «чужой e-mail → 403»).
 */
import crypto from "node:crypto";
import { normalizeEmail } from "./allowlist.ts";

const PREFIX = "hk1";
const SEP = ".";

export interface IssuedToken {
  token: string;
  email: string;
  /** `null` — бессрочный. */
  expiresAt: number | null;
}

function base64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function hmac(secret: string, payload: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

/**
 * Собрать ключ/токен для e-mail.
 * `ttlSeconds <= 0` → бессрочный; `nowSeconds` полезен в тестах.
 */
export function issueToken(email: string, secret: string, ttlSeconds = 0, nowSeconds = Math.floor(Date.now() / 1000)): IssuedToken {
  const normalized = normalizeEmail(email);
  const expiresAt = ttlSeconds > 0 ? nowSeconds + ttlSeconds : null;
  const payload = `${base64url(normalized)}${SEP}${expiresAt ?? ""}`;
  return {
    token: [PREFIX, payload, hmac(secret, payload)].join(SEP),
    email: normalized,
    expiresAt,
  };
}

export type ParsedToken =
  | { kind: "derived"; email: string; expiresAt: number | null }
  | { kind: "opaque"; raw: string };

export function parseToken(token: string): ParsedToken {
  const trimmed = token.trim();
  if (!trimmed.startsWith(`${PREFIX}${SEP}`)) return { kind: "opaque", raw: trimmed };
  const parts = trimmed.split(SEP);
  if (parts.length !== 4) return { kind: "opaque", raw: trimmed };
  const email = normalizeEmail(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
  if (!email) return { kind: "opaque", raw: trimmed };
  const expRaw = parts[2] ?? "";
  const expiresAt = expRaw === "" ? null : Number.parseInt(expRaw, 10);
  return { kind: "derived", email, expiresAt: Number.isFinite(expiresAt) ? expiresAt : null };
}

/** Проверить подпись производного ключа. */
export function verifySignature(token: string, secret: string): boolean {
  const parts = token.trim().split(SEP);
  if (parts.length !== 4 || parts[0] !== PREFIX) return false;
  const expected = hmac(secret, `${parts[1]}${SEP}${parts[2]}`);
  const a = Buffer.from(parts[3] ?? "");
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function isExpired(expiresAt: number | null, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  return expiresAt !== null && expiresAt <= nowSeconds;
}

/**
 * Готовый ключ для e-mail — то, что нужно положить в `Authorization: Bearer …`.
 * Если задан статический `HIKKO_API_KEY`, возвращается он, иначе — производный.
 */
export function apiKeyForEmail(email: string, secret: string, staticKey = ""): string {
  if (staticKey) return staticKey;
  return issueToken(email, secret).token;
}
