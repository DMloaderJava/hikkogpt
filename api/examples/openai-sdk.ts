/**
 * Пример 5 — подключение «как к OpenAI»: официальный SDK `openai`, LangChain,
 * Cline, Cursor, Continue и прочие клиенты режима OpenAI Compatible.
 *
 * Запуск (SDK нужен только для этого примера, самому API он не требуется):
 *   npm i --no-save openai
 *   node api/examples/openai-sdk.ts
 */
import OpenAI from "openai";
import { loadEnvFiles } from "../src/env.ts";
import { apiKeyForEmail } from "../src/token.ts";

loadEnvFiles();

const baseUrl = process.env.API_BASE_URL ?? "http://127.0.0.1:8787";
const secret = process.env.HIKKO_API_SECRET ?? "hikko-dev-secret-change-me";
const email = process.env.HIKKO_ALLOWED_EMAIL ?? "babaevafarida8@gmail.com";

const client = new OpenAI({
  // Важно: именно с суффиксом /v1 — SDK сам добавит /chat/completions и /models.
  baseURL: `${baseUrl}/v1`,
  apiKey: process.env.HIKKO_API_KEY || apiKeyForEmail(email, secret),
});

// 1. Список моделей (его же запрашивает Cline при настройке провайдера).
const models = await client.models.list();
console.log("модели:", models.data.map((model) => model.id).join(", "));

// 2. Обычный чат.
const completion = await client.chat.completions.create({
  model: "hikko-gpt",
  messages: [
    { role: "system", content: "Отвечай одним предложением." },
    { role: "user", content: "Что ты за API?" },
  ],
});
console.log("\nчат:", completion.choices[0]?.message.content);

// 3. Function calling — то, ради чего Cline и работает.
const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Узнать погоду в городе",
      parameters: {
        type: "object",
        properties: { city: { type: "string", description: "Город" } },
        required: ["city"],
      },
    },
  },
];

const withTools = await client.chat.completions.create({
  model: "hikko-gpt",
  messages: [{ role: "user", content: "Какая погода в Аше?" }],
  tools,
  tool_choice: "auto",
});
const call = withTools.choices[0]?.message.tool_calls?.[0];
console.log(
  call
    ? `модель вызвала инструмент: ${call.function.name}(${call.function.arguments})`
    : "модель ответила текстом (в режиме echo инструменты не вызываются — нужны GEMINI_API_KEYS):",
);
if (!call) console.log(withTools.choices[0]?.message.content);

// 4. Поток.
const stream = await client.chat.completions.create({
  model: "hikko-gpt",
  messages: [{ role: "user", content: "Коротко: зачем нужен этот API?" }],
  stream: true,
});
process.stdout.write("\nпоток: ");
for await (const part of stream) {
  process.stdout.write(part.choices[0]?.delta?.content ?? "");
}
console.log();
