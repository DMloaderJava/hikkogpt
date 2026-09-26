/**
 * Точка входа для Vercel Functions (Node.js runtime).
 *
 * Vercel не запускает долгоживущий сервер: он вызывает handler на каждый
 * запрос. Поэтому здесь тонкий адаптер — вся логика (доступ по e-mail,
 * OpenAI-совместимые роуты, SSE, инструменты) остаётся в `api/src/`,
 * и локальный `node api/src/server.ts` и деплой на Vercel ведут себя одинаково.
 *
 * Раскладка (Root Directory проекта на Vercel = `api/`):
 *
 *   api/                    ← корень деплоя
 *   ├─ api/[[...path]].ts   ← этот файл: единственная функция, ловит все пути
 *   ├─ src/…                ← сервер, доступ, апстрим
 *   └─ vercel.json          ← routes + runtime nodejs22.x, maxDuration, includeFiles
 *
 * Путь запроса приходит в `req.url`, поэтому `/v1/chat/completions`,
 * `/v1/models`, `/api/v1/health` и `/` работают ровно как на локальном сервере.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import type http from "node:http";

import { loadConfig } from "../src/config.ts";
import type { ApiConfig } from "../src/config.ts";
import { createLogger } from "../src/log.ts";
import { createRateLimiter } from "../src/ratelimit.ts";
import { routeRequest } from "../src/server.ts";
import type { ServerDeps } from "../src/server.ts";
import { selectProvider } from "../src/upstream.ts";

/**
 * Конфиг и зависимости создаём один раз на инстанс: при Fluid Compute функция
 * обрабатывает много запросов подряд, значит и счётчик лимита живёт между ними
 * (в рамках одного инстанса — на serverless это best-effort, см. docs/vercel.md).
 */
let cached: ServerDeps | null = null;

/**
 * Конфиг для serverless-среды.
 *
 * На Vercel `NODE_ENV=production` выставляется сам, но мы не полагаемся на это:
 * строгие дефолты включаются всегда, кроме явного `NODE_ENV=development`
 * (локальный прогон адаптера). Отдельные флаги возвращаются переменными
 * `ALLOW_HEADER_AUTH`, `SERVE_PLAYGROUND`, `HEALTH_SHOW_ALLOWLIST`.
 */
export function resolveConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const development = env.NODE_ENV === "development";
  const base = loadConfig();
  if (development) return base;
  return {
    ...base,
    isProduction: true,
    allowHeaderAuth: env.ALLOW_HEADER_AUTH === "true",
    servePlayground: env.SERVE_PLAYGROUND === "true",
    healthShowAllowlist: env.HEALTH_SHOW_ALLOWLIST === "true",
  };
}

function adapterDeps(): ServerDeps {
  if (cached) return cached;
  const config = resolveConfig();
  cached = {
    config,
    limiter: createRateLimiter(config.rateLimitPerMinute),
    provider: selectProvider(config),
    log: createLogger(config),
  };
  return cached;
}

/** Сбросить кэш конфига (нужно тестам: переменные окружения меняются на лету). */
export function resetAdapterCache(): void {
  cached = null;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  // Типы Vercel структурно совпадают с node:http — приводим без копирования логики.
  const nodeReq = req as unknown as http.IncomingMessage;
  const nodeRes = res as unknown as http.ServerResponse;
  await routeRequest(nodeReq, nodeRes, adapterDeps());
}
