/**
 * Конфигурация API. Всё читается из окружения, значения по умолчанию —
 * рабочие: сервер поднимается без единого секрета и отвечает в режиме `echo`.
 */
import { envInt, envList, envString, loadEnvFiles } from "./env.ts";
import { DEFAULT_ALLOWED_EMAIL } from "./allowlist.ts";
import type { ApiMode, HikkoModel } from "./types.ts";

export interface ApiConfig {
  host: string;
  port: number;
  version: string;
  /** NODE_ENV=production — включает строгие дефолты (см. assertProductionReady). */
  isProduction: boolean;
  allowlist: string[];
  /** Секрет для подписи производных ключей/токенов. */
  secret: string;
  /** Готовый статический ключ (если задан — работает как есть). */
  staticApiKey: string;
  /** Ключ администратора для POST /api/v1/admin/token. Пусто — эндпоинт закрыт. */
  adminToken: string;
  /** Ключи Gemini (перебор по списку, как в supabase/functions/chat). */
  geminiKeys: string[];
  /** Любой OpenAI-совместимый апстрим (например, Lovable AI Gateway). */
  openaiBaseUrl: string;
  openaiKey: string;
  mode: ApiMode;
  models: HikkoModel[];
  defaultModel: HikkoModel;
  /**
   * Пускать ли запросы с незнакомым `model`. По умолчанию да: Cline/Cursor
   * подставляют тот id, который ввёл пользователь, и жёсткий отказ ломал бы
   * подключение. `ALLOW_UNKNOWN_MODEL=false` включает строгую проверку.
   */
  allowUnknownModel: boolean;
  systemPrompt: string;
  rateLimitPerMinute: number;
  maxBodyBytes: number;
  requestTimeoutMs: number;
  /** Разрешить вход по заголовку X-Hikko-Email без ключа (только для локальной разработки). */
  allowHeaderAuth: boolean;
  supabaseUrl: string;
  supabaseAnonKey: string;
  /** `*` — любой источник; иначе список origin через запятую. */
  corsOrigin: string;
  /** Показывать ли белый список адресов в публичном /health. */
  healthShowAllowlist: boolean;
  /** Отдавать ли playground.html на GET /. */
  servePlayground: boolean;
  /** Период SSE-пингов, чтобы прокси не рвал «задумавшийся» поток; 0 — выключить. */
  sseKeepAliveMs: number;
  /** `info` | `silent` | `debug` (debug добавляет тело ответа в лог). */
  logLevel: string;
}

const SYSTEM_PROMPT = [
  "Ты — hikkoGPT, нейросеть для живого и приятного общения.",
  "Отвечай на языке собеседника, по существу, с лёгким дружелюбным юмором.",
  "Поддерживай Markdown: заголовки, списки, таблицы, блоки кода.",
].join(" ");

export const DEFAULT_SECRET = "hikko-dev-secret-change-me";

export function loadConfig(): ApiConfig {
  loadEnvFiles();

  const isProduction = process.env.NODE_ENV === "production";
  const allowlistEnv = envList("ALLOWED_EMAILS");
  const allowlist = (allowlistEnv.length > 0 ? allowlistEnv : [DEFAULT_ALLOWED_EMAIL]).map((email) =>
    email.trim().toLowerCase(),
  );

  const secret = envString("HIKKO_API_SECRET", envString("API_SECRET", DEFAULT_SECRET));
  const geminiKeys = envList("GEMINI_API_KEYS");
  const openaiBaseUrl = envString("OPENAI_BASE_URL", "");
  const openaiKey = envString("OPENAI_API_KEY", envString("LOVABLE_API_KEY", ""));

  const mode: ApiMode = geminiKeys.length > 0 ? "gemini" : openaiKey && openaiBaseUrl ? "openai" : "echo";

  return {
    host: envString("HOST", "0.0.0.0"),
    port: envInt("PORT", envInt("API_PORT", 8787)),
    version: envString("API_VERSION", "1.0.0"),
    isProduction,
    allowlist,
    secret,
    staticApiKey: envString("HIKKO_API_KEY", ""),
    adminToken: envString("ADMIN_TOKEN", ""),
    geminiKeys,
    openaiBaseUrl,
    openaiKey,
    mode,
    models: ["hikko-gpt", "hikko-gpt-turbo", "hikko-gpt-smart"],
    defaultModel: envString("DEFAULT_MODEL", "hikko-gpt"),
    allowUnknownModel: envString("ALLOW_UNKNOWN_MODEL", "true") !== "false",
    systemPrompt: envString("HIKKO_SYSTEM_PROMPT", SYSTEM_PROMPT),
    rateLimitPerMinute: envInt("RATE_LIMIT_PER_MINUTE", 600),
    maxBodyBytes: envInt("MAX_BODY_BYTES", 1_000_000),
    requestTimeoutMs: envInt("UPSTREAM_TIMEOUT_MS", 120_000),
    // Вход по заголовку X-Hikko-Email — только для разработки: в production
    // (NODE_ENV=production) по умолчанию выключен, чтобы адрес нельзя было
    // просто написать в заголовке. Переопределяется ALLOW_HEADER_AUTH=true|false.
    allowHeaderAuth: envString("ALLOW_HEADER_AUTH", isProduction ? "false" : "true") !== "false",
    supabaseUrl: envString("SUPABASE_URL", envString("VITE_SUPABASE_URL", "")),
    supabaseAnonKey: envString("SUPABASE_ANON_KEY", envString("VITE_SUPABASE_PUBLISHABLE_KEY", "")),
    corsOrigin: envString("CORS_ORIGIN", "*"),
    healthShowAllowlist: envString("HEALTH_SHOW_ALLOWLIST", isProduction ? "false" : "true") === "true",
    servePlayground: envString("SERVE_PLAYGROUND", isProduction ? "false" : "true") === "true",
    sseKeepAliveMs: envInt("SSE_KEEP_ALIVE_MS", 15_000),
    logLevel: envString("LOG_LEVEL", "info"),
  };
}

export interface ReadinessIssue {
  level: "warn" | "error";
  message: string;
}

/**
 * Что не так с конфигурацией.
 *
 * `error` в production блокирует запуск: например, дефолтный секрет лежит в
 * открытом репозитории, значит любой может сам себе выписать ключ для
 * разрешённого адреса — стартовать с ним наружу нельзя.
 */
export function readinessIssues(config: ApiConfig): ReadinessIssue[] {
  const issues: ReadinessIssue[] = [];

  if (config.secret === DEFAULT_SECRET) {
    const message =
      "HIKKO_API_SECRET не задан — используется значение из репозитория, а значит ключ для разрешённого адреса может вычислить кто угодно.";
    issues.push({ level: config.isProduction ? "error" : "warn", message });
  }
  if (!config.isProduction) return issues;

  if (config.allowHeaderAuth) {
    issues.push({ level: "warn", message: "ALLOW_HEADER_AUTH=true: вход по заголовку X-Hikko-Email без ключа." });
  }
  if (config.servePlayground) {
    issues.push({ level: "warn", message: "SERVE_PLAYGROUND=true: страница-песочница на GET / доступна без ключа." });
  }
  if (config.healthShowAllowlist) {
    issues.push({ level: "warn", message: "HEALTH_SHOW_ALLOWLIST=true: /health показывает e-mail без авторизации." });
  }
  if (config.corsOrigin === "*") {
    issues.push({ level: "warn", message: "CORS_ORIGIN=*: запросы разрешены с любого сайта (ключ по-прежнему обязателен)." });
  }
  if (config.mode === "echo") {
    issues.push({
      level: "warn",
      message: "Ключи модели не заданы (GEMINI_API_KEYS / OPENAI_BASE_URL+OPENAI_API_KEY) — API отвечает заглушкой echo.",
    });
  }
  return issues;
}

/** Бросает ошибку, если с конфигурацией нельзя выходить в production. */
export function assertProductionReady(config: ApiConfig): void {
  const blocking = readinessIssues(config).filter((issue) => issue.level === "error");
  if (blocking.length === 0) return;
  throw new Error(`Отказ запуска: ${blocking.map((issue) => issue.message).join(" ")}`);
}

/** Карта «псевдоним модели в API → модель Google Gemini» (как в edge-функции chat). */
export function toGeminiModel(model: string | undefined, fallback: string): string {
  const requested = (model ?? fallback).toLowerCase();
  if (requested.includes("turbo")) return "gemini-2.5-flash";
  if (requested.includes("smart")) return "gemini-2.5-flash";
  if (requested.includes("gemini")) return requested;
  if (requested.includes("pro")) return "gemini-2.5-pro";
  return "gemini-2.5-flash";
}
