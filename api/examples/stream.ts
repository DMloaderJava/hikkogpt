/**
 * Пример 2 — потоковый ответ (SSE) из TypeScript.
 *
 * Запуск:  node api/examples/stream.ts
 */
import { loadEnvFiles } from "../src/env.ts";
import { apiKeyForEmail } from "../src/token.ts";
import { HikkoApiClient, PRIVATE_API_EMAIL } from "../client/src/client.ts";

loadEnvFiles();

const api = new HikkoApiClient({
  baseUrl: process.env.API_BASE_URL ?? "http://127.0.0.1:8787",
  apiKey: process.env.HIKKO_API_KEY || apiKeyForEmail(PRIVATE_API_EMAIL, process.env.HIKKO_API_SECRET ?? "hikko-dev-secret-change-me"),
});

console.log("— Расскажите коротко, зачем человечеству Марс.\n");

let chunks = 0;
process.stdout.write("ответ: ");
for await (const piece of api.chatStream([
  { role: "user", content: "Зачем человечеству Марс? Ответь в 3 предложениях." },
])) {
  chunks += 1;
  process.stdout.write(piece);
}
console.log(`\n\n(получено кусочков: ${chunks})`);
