/**
 * Минимальный логгер: без зависимостей, уровень задаётся `LOG_LEVEL`.
 *
 * - `silent` — ничего не печатать;
 * - `info`   — строка на каждый запрос (метод, маршрут, статус, время, e-mail);
 * - `debug`  — то же + предупреждения (например, тело ошибки апстрима).
 */
import type { ApiConfig } from "./config.ts";

export type Logger = (message: string) => void;

export function createLogger(config: Pick<ApiConfig, "logLevel">): Logger {
  if (config.logLevel === "silent") return () => {};
  return (message: string) => {
    const line = `${new Date().toISOString()} ${message}`;
    if (message.startsWith("WARN") || message.startsWith("ERROR")) console.error(line);
    else console.log(line);
  };
}

export interface LogRequestParams {
  method: string;
  route: string;
  status: number;
  startedAt: number;
  requestId: string;
  email?: string;
  authMethod?: string;
  model?: string;
  stream?: boolean;
}

export function formatRequestLog(params: LogRequestParams): string {
  const duration = `${Math.max(0, Date.now() - params.startedAt)}ms`;
  const who = params.email ? `${params.email}${params.authMethod ? `/${params.authMethod}` : ""}` : "anonymous";
  const extra = [
    params.model ? `model=${params.model}` : "",
    params.stream ? "stream" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `${params.method} ${params.route} → ${params.status} ${duration} [${params.requestId}] ${who}${extra ? ` ${extra}` : ""}`;
}
