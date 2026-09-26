/**
 * Пример 4 — то же самое «голым» fetch (Node/Deno/Bun/браузер) и эквивалент в curl.
 *
 * Запуск:  node api/examples/raw-fetch.ts
 */
import { loadEnvFiles } from "../src/env.ts";
import { apiKeyForEmail } from "../src/token.ts";
import type { ChatCompletionResponse } from "../src/types.ts";

loadEnvFiles();

const baseUrl = process.env.API_BASE_URL ?? "http://127.0.0.1:8787";
const email = process.env.HIKKO_ALLOWED_EMAIL ?? "babaevafarida8@gmail.com";
const apiKey = apiKeyForEmail(email, process.env.HIKKO_API_SECRET ?? "hikko-dev-secret-change-me");

console.log("curl-эквивалент этого запроса:\n");
console.log(
  [
    `curl -s ${baseUrl}/api/v1/chat/completions \\`,
    `     -H 'Authorization: Bearer ${apiKey}' \\`,
    `     -H 'Content-Type: application/json' \\`,
    `     -d '{"model":"hikko-gpt","messages":[{"role":"user","content":"Напиши хайку про TypeScript"}]}'`,
  ].join("\n"),
);

const response = await fetch(`${baseUrl}/api/v1/chat/completions`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "hikko-gpt",
    messages: [{ role: "user", content: "Напиши хайку про TypeScript" }],
  }),
});

if (!response.ok) {
  console.error("\nHTTP", response.status, await response.text());
  process.exitCode = 1;
} else {
  const data = (await response.json()) as ChatCompletionResponse;
  console.log("\nответ сервера:\n" + data.choices[0].message.content);
}
