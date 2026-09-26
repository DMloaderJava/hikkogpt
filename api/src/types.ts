/**
 * Общие типы API hikkoGPT.
 *
 * Файл намеренно не содержит рантайм-кода: его импортируют и сервер (Node),
 * и клиентский SDK (браузер/Node), поэтому здесь только `type`/`interface`.
 */

/** Псевдонимы моделей, которые понимает API. */
export type HikkoModel =
  | "hikko-gpt"
  | "hikko-gpt-turbo"
  | "hikko-gpt-smart"
  | (string & {});

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatCompletionRequest {
  model?: HikkoModel;
  messages: ChatMessage[];
  /** Открыть SSE-поток (OpenAI-совместимо: `data: {...}` + `data: [DONE]`). */
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  /** Дополнительный системный промпт поверх встроенного. */
  system?: string;
}

export interface ChatChoice {
  index: number;
  message: ChatMessage;
  finish_reason: "stop" | "length" | "error";
}

export interface UsageInfo {
  prompt_messages: number;
  completion_chars: number;
  total_chars: number;
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatChoice[];
  usage: UsageInfo;
  /** Кто ответил: реальная модель или локальный echo-режим без ключей. */
  provider: "gemini" | "openai-compatible" | "echo";
  account: {
    email: string;
  };
  request_id: string;
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: ChatRole; content?: string };
    finish_reason: "stop" | "length" | "error" | null;
  }>;
  request_id?: string;
}

export type ApiMode = "gemini" | "openai" | "echo";

export interface HealthResponse {
  status: "ok";
  service: "hikko-private-api";
  version: string;
  mode: ApiMode;
  /** E-mail, которым разрешён доступ (список может быть переопределён через env). */
  allowlist: string[];
  models: string[];
  streaming: true;
  time: string;
}

export interface AccountResponse {
  email: string;
  allowed: true;
  /** Как сервер понял, кто обращается. */
  auth_method: "api_key" | "token" | "supabase_jwt" | "dev_header";
  /** Статический ключ из env или `derived` — вычисленный из e-mail HMAC-ключ. */
  key_kind: "static" | "derived" | "jwt";
  unlimited: boolean;
  rate_limit: {
    limit: number;
    window_seconds: number;
    remaining: number;
    reset_at: string;
  };
  request_id: string;
}

export interface IssueTokenRequest {
  email?: string;
  /** Срок жизни токена в секундах; 0 или пусто — бессрочный. */
  ttl_seconds?: number;
}

export interface IssueTokenResponse {
  token: string;
  email: string;
  expires_at: string | null;
  request_id: string;
}

/** Единый формат ошибки для всех эндпоинтов. */
export interface ApiErrorBody {
  error: {
    message: string;
    code:
      | "unauthorized"
      | "forbidden"
      | "bad_request"
      | "not_found"
      | "method_not_allowed"
      | "payload_too_large"
      | "rate_limited"
      | "upstream_error"
      | "internal_error";
    request_id: string;
    /** Присутствует только для `forbidden`/`unauthorized` по e-mail. */
    allowed_emails?: string[];
  };
}
