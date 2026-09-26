/**
 * Пример 1 — базовое подключение из TypeScript.
 *
 * Запуск:  node api/examples/basic.ts
 * (сервер должен быть поднят: `node api/src/server.ts`)
 */
import { loadEnvFiles } from "../src/env.ts";
import { apiKeyForEmail } from "../src/token.ts";
import { HikkoApiClient, HikkoApiError, PRIVATE_API_EMAIL } from "../client/src/client.ts";

loadEnvFiles();

const baseUrl = process.env.API_BASE_URL ?? "http://127.0.0.1:8787";
const secret = process.env.HIKKO_API_SECRET ?? "hikko-dev-secret-change-me";

const api = new HikkoApiClient({
  baseUrl,
  // Ключ выводится из e-mail + секрета. В проде его выдают один раз
  // (POST /api/v1/admin/token) и хранят в переменных окружения.
  apiKey: process.env.HIKKO_API_KEY || apiKeyForEmail(PRIVATE_API_EMAIL, secret),
  model: "hikko-gpt",
});

// 1. Сервер жив?
const health = await api.health();
console.log("health:", health.status, "| режим:", health.mode, "| доступ:", health.allowlist.join(", "));

// 2. Кто я с точки зрения сервера?
const account = await api.account();
console.log("account:", account.email, "| способ входа:", account.auth_method, "| осталось:", account.rate_limit.remaining);

// 3. Обычный запрос.
const result = await api.chat([
  { role: "system", content: "Отвечай одним предложением." },
  { role: "user", content: "Объясни, почему небо голубое." },
]);
console.log("\nответ:", result.text);
console.log("модель:", result.model, "| провайдер:", result.provider, "| символов:", result.usage.completion_chars);

// 4. Обработка отказа в доступе: другой e-mail получит 403.
try {
  const stranger = new HikkoApiClient({ baseUrl, email: "someone.else@example.com" });
  await stranger.account();
} catch (error) {
  if (error instanceof HikkoApiError) {
    console.log("\nпосторонний e-mail →", error.status, error.code, "—", error.message);
  }
}
