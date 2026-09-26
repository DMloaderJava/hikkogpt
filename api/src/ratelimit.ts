/**
 * Простейший in-memory rate limit «фиксированное окно» на e-mail.
 *
 * Белый список адресов один, поэтому ограничение нужно не для монетизации,
 * а чтобы ушедший в цикл клиент не сжёг ключи апстрима.
 * `limit <= 0` отключает проверку.
 */

interface Window {
  count: number;
  startedAt: number;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
}

export interface RateLimiter {
  hit(key: string): RateLimitResult;
  peek(key: string): RateLimitResult;
  reset(): void;
}

export function createRateLimiter(limit: number, windowMs = 60_000, now: () => number = Date.now): RateLimiter {
  const buckets = new Map<string, Window>();

  function bucket(key: string): Window {
    const current = now();
    const existing = buckets.get(key);
    if (!existing || current - existing.startedAt >= windowMs) {
      const fresh = { count: 0, startedAt: current };
      buckets.set(key, fresh);
      return fresh;
    }
    return existing;
  }

  function describe(count: number, startedAt: number): RateLimitResult {
    const resetAt = startedAt + windowMs;
    const remaining = limit > 0 ? Math.max(0, limit - count) : Number.POSITIVE_INFINITY;
    return {
      allowed: limit <= 0 || count <= limit,
      limit,
      remaining: Number.isFinite(remaining) ? remaining : Number.MAX_SAFE_INTEGER,
      resetAt,
      retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now()) / 1000)),
    };
  }

  return {
    hit(key: string): RateLimitResult {
      if (limit <= 0) return describe(0, now());
      const entry = bucket(key);
      entry.count += 1;
      return describe(entry.count, entry.startedAt);
    },
    peek(key: string): RateLimitResult {
      const entry = buckets.get(key);
      if (!entry || now() - entry.startedAt >= windowMs) return describe(0, now());
      return describe(entry.count, entry.startedAt);
    },
    reset(): void {
      buckets.clear();
    },
  };
}
