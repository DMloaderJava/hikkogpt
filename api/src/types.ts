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

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ToolFunctionSchema {
  type?: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: ToolFunctionSchema;
  };
}

export type ToolChoice =
  | "none"
  | "auto"
  | "required"
  | { type: "function"; function: { name: string } };

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    /** JSON-строка аргументов (как в OpenAI). */
    arguments: string;
  };
}

export interface ChatMessage {
  role: ChatRole;
  /**
   * Текст сообщения. Для `assistant` с `tool_calls` может отсутствовать,
   * для `tool` — обязательно (это результат вызова инструмента).
   */
  content?: string | null;
  /** Только для `assistant`: какие инструменты модель решила вызвать. */
  tool_calls?: ToolCall[];
  /** Только для `tool`: id вызова, на который отвечаем. */
  tool_call_id?: string;
  /** Только для `tool`: имя функции (необязательно, как в OpenAI). */
  name?: string;
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
  /** Инструменты (function calling) — нужны Cline, Cursor, LangChain и т.п. */
  tools?: ToolDefinition[];
  tool_choice?: ToolChoice;
  top_p?: number;
  stop?: string | string[] | null;
  /** Поля ниже принимаются и игнорируются — OpenAI-клиенты шлют их по умолчанию. */
  n?: number;
  user?: string;
  presence_penalty?: number;
  frequency_penalty?: number;
  logit_bias?: Record<string, number>;
  seed?: number;
  response_format?: { type: string; [key: string]: unknown };
  stream_options?: { include_usage?: boolean; [key: string]: unknown };
  parallel_tool_calls?: boolean;
  max_completion_tokens?: number;
}

export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter" | "error";

export interface ChatChoice {
  index: number;
  message: ChatMessage;
  finish_reason: FinishReason;
}

export interface UsageInfo {
  prompt_messages: number;
  completion_chars: number;
  total_chars: number;
  /** Токены — только если апстрим их отдал (Gemini/OpenAI-шлюз). */
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/**
 * Ответ `GET /v1/models` — формат OpenAI, его ждут Cline, Cursor, Continue,
 * LiteLLM и прочие клиенты с режимом «OpenAI Compatible».
 */
export interface ModelsResponse {
  object: "list";
  data: Array<{
    id: string;
    object: "model";
    created: number;
    owned_by: string;
    /** Не OpenAI-поле, но клиенты его игнорируют, а нам полезно. */
    context_window?: number;
    supports_tools?: boolean;
    private?: boolean;
  }>;
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

/** Кусочек потока. `tool_calls` приходят частями — как в OpenAI. */
export interface ChunkToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: ChatRole; content?: string | null; tool_calls?: ChunkToolCallDelta[] };
    finish_reason: FinishReason | null;
  }>;
  /** Присутствует, если клиент попросил `stream_options.include_usage`. */
  usage?: UsageInfo | null;
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
