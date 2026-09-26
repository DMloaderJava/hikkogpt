# Приватный API hikkoGPT

Небольшой HTTP-API «для одного адреса»: доступ разрешён **только** e-mail из белого
списка — по умолчанию `babaevafarida8@gmail.com` (та же схема, что уже используется
в проекте: `CAMERA_LIMIT_BYPASS_EMAILS` в `src/lib/imageAttachments.ts` и таблица
`unlimited_emails` в `drizzle/migrations/`).

API **OpenAI-совместимый**: его можно подключить как провайдер «OpenAI Compatible»
в Cline, Cursor, Roo Code, Continue, LangChain или через официальный SDK `openai`.
Пошаговая инструкция — [`docs/openai-compatible.md`](docs/openai-compatible.md).

Сервер и клиент написаны на **TypeScript без единой зависимости**:

- сервер — `node:http` (Node ≥ 22.18 исполняет `.ts` напрямую, ничего собирать не нужно);
- клиент — чистый `fetch`, файл `client/src/client.ts` можно скопировать в любой проект.

```
api/
├─ src/
│  ├─ server.ts        # HTTP-сервер, роутинг, SSE, playground
│  ├─ auth.ts          # 4 способа входа → e-mail → белый список
│  ├─ allowlist.ts     # сама «дверь»: нормализация и проверка адреса
│  ├─ token.ts         # HMAC-ключи hk1.<email>.<exp>.<sig> (+ срок жизни)
│  ├─ ratelimit.ts     # лимит запросов в минуту на адрес
│  ├─ upstream.ts      # Gemini / OpenAI-совместимый шлюз / echo-заглушка (+ function calling)
│  ├─ config.ts, env.ts, types.ts
├─ client/src/client.ts  # TypeScript-SDK (HikkoApiClient, HikkoApiError)
├─ examples/             # 5 готовых примеров подключения (включая SDK `openai`)
├─ docs/openai-compatible.md  # как подключить Cline/Cursor/Continue
├─ playground.html       # страничка для ручной проверки (отдаётся на GET /)
└─ test/                 # 45 тестов, node --test
```

---

## Быстрый старт (30 секунд)

```bash
npm run api                 # поднять сервер (порт 8787)
node api/examples/basic.ts  # подключиться из TypeScript и задать вопрос
npm run api:test            # тесты
npm run api:typecheck       # tsc --noEmit
```

При старте сервер печатает готовый ключ для разрешённого адреса:

```
➜  режим модели: echo — ключи не заданы, ответы локальные
➜  доступ разрешён: babaevafarida8@gmail.com
➜  ключ для babaevafarida8@gmail.com: hk1.YmFiYWV2YWZhcmlkYThAZ21haWwuY29t..GAV75…
➜  песочница: http://localhost:8787/
```

Без ключей модели сервер работает в режиме `echo`: доступ, валидация, лимиты и
стриминг настоящие, а текст ответа — локальная заглушка. То есть всё можно
проверить, не имея ни одного секрета.

---

## Эндпоинты

| Метод | Путь | Доступ | Что делает |
|---|---|---|---|
| GET | `/api/v1/health` | публично | статус, режим, белый список, модели |
| GET | `/api/v1/account` | ключ | кто я, способ входа, остаток лимита |
| POST | `/api/v1/chat/completions` | ключ | чат в формате OpenAI, `stream: true` → SSE |
| GET | `/api/v1/models` | ключ | список моделей в формате OpenAI |
| POST | `/api/v1/admin/token` | `ADMIN_TOKEN` | выпустить ключ для разрешённого адреса |
| GET | `/` | публично | песочница (HTML) |

OpenAI-клиенты по-разному понимают базовый URL, поэтому каждый эндпоинт доступен
в трёх написаниях — `…/api/v1/…`, `…/v1/…` и `…/…`:

| Base URL в клиенте | Что дёргается |
|---|---|
| `http://localhost:8787` | `/v1/chat/completions`, `/v1/models` |
| `http://localhost:8787/v1` | `/chat/completions`, `/models` |
| `http://localhost:8787/api/v1` | `/chat/completions`, `/models` |

### `POST /api/v1/chat/completions`

```jsonc
{
  "model": "hikko-gpt",              // hikko-gpt | hikko-gpt-turbo | hikko-gpt-smart | gemini-2.5-pro …
  "messages": [
    { "role": "system", "content": "Отвечай кратко." },
    { "role": "user",   "content": "Почему небо голубое?" }
  ],
  "stream": false,                   // true → text/event-stream, чанки как в OpenAI
  "temperature": 0.7,                // 0…2
  "top_p": 0.9,                      // 0…1
  "max_tokens": 1024,                // 1…32768
  "stop": ["</task>"],               // строка или массив строк
  "system": "…",                     // добавка к встроенному системному промпту

  // function calling — то, ради чего подключаются Cline/Cursor/LangChain:
  "tools": [{ "type": "function", "function": { "name": "read_file", "parameters": { "type": "object" } } }],
  "tool_choice": "auto"              // none | auto | required | { type:"function", function:{ name } }
}
```

Ответы на вызовы инструментов возвращаются как в OpenAI — `choices[0].message.tool_calls`
и `finish_reason: "tool_calls"`, а в потоке приходят дельтами
(`delta.tool_calls[i].function.arguments` по кусочкам). Результаты клиент досылает
сообщениями `{ "role": "tool", "tool_call_id": "…", "content": "…" }`.

Поля `n`, `user`, `seed`, `logit_bias`, `response_format`, `stream_options`,
`parallel_tool_calls` принимаются и игнорируются — запрос из-за них не отклоняется.

Ответ — привычный OpenAI-объект (`choices[0].message.content`, `usage`) плюс
`provider` (`gemini` / `openai-compatible` / `echo`), `account.email` и `request_id`.

Ошибки всегда одного формата:

```json
{ "error": { "message": "…", "code": "forbidden", "request_id": "…", "allowed_emails": ["babaevafarida8@gmail.com"] } }
```

| Код HTTP | `code` | Когда |
|---|---|---|
| 400 | `bad_request` | битый JSON, пустые `messages`, `temperature` вне 0…2 |
| 401 | `unauthorized` | нет ключа, ключ чужой/повреждён/истёк |
| 403 | `forbidden` | адрес не из белого списка |
| 404 / 405 | `not_found` / `method_not_allowed` | нет такого маршрута/метода |
| 413 | `payload_too_large` | тело больше `MAX_BODY_BYTES` |
| 429 | `rate_limited` | превышен `RATE_LIMIT_PER_MINUTE` (+ заголовок `Retry-After`) |
| 502 | `upstream_error` | модель/шлюз не ответили ни с одним ключом |

---

## Как устроен доступ

Любой способ входа в итоге даёт e-mail, который сверяется с белым списком.

| # | Способ | Заголовок | Когда применять |
|---|---|---|---|
| 1 | Статический ключ | `Authorization: Bearer <HIKKO_API_KEY>` | интеграции, где ключ задан в env |
| 2 | Производный HMAC-ключ | `Authorization: Bearer hk1.<email-b64>.<exp>.<sig>` | основной вариант: ключ выводится из адреса и секрета |
| 3 | Supabase JWT | `Authorization: Bearer <access_token>` | тот же пользователь, что в веб-приложении |
| 4 | `X-Hikko-Email` | `X-Hikko-Email: babaevafarida8@gmail.com` | **только разработка** (`ALLOW_HEADER_AUTH`, в `NODE_ENV=production` выключено) |

Проверка e-mail регистронезависимая и терпит пробелы, поэтому
`BabaevaFarida8@Gmail.com` == `babaevafarida8@gmail.com`.

Способ 3 работает, если заданы `SUPABASE_URL` и `SUPABASE_ANON_KEY` (или
`VITE_SUPABASE_*` из корневого `.env`): сервер дёргает `auth/v1/user` — тот же
приём, что в `supabase/functions/chat/index.ts` — и берёт e-mail из профиля.
Так в API можно ходить из приложения под текущим пользователем, не раздавая секрет.

**Важно про секрет.** `HIKKO_API_SECRET` нужен только чтобы вывести ключ. В браузер
и мобильное приложение его класть нельзя — там используйте готовый ключ или JWT.

---

## Подключение из TypeScript

SDK — один файл без зависимостей: `api/client/src/client.ts`.

```ts
import { HikkoApiClient, HikkoApiError } from "./api/client/src/client.ts";

const api = new HikkoApiClient({
  baseUrl: "http://localhost:8787",
  apiKey: process.env.HIKKO_API_KEY,   // ключ для babaevafarida8@gmail.com
  model: "hikko-gpt",                  // модель по умолчанию
});

// 1. Обычный запрос
const answer = await api.chat([
  { role: "system", content: "Отвечай одним предложением." },
  { role: "user", content: "Объясни, почему небо голубое." },
]);
console.log(answer.text, answer.provider, answer.usage.completion_chars);

// 2. Поток
for await (const piece of api.chatStream([{ role: "user", content: "Расскажи про Марс" }])) {
  process.stdout.write(piece);
}

// 3. Ошибки типизированы
try {
  await api.account();
} catch (error) {
  if (error instanceof HikkoApiError && error.isAuthError) {
    console.error("Нет доступа:", error.status, error.code, error.allowedEmails);
  }
}
```

Полный список методов: `health()`, `account()`, `chat()`, `chatStream()`,
`streamChunks()` (сырые SSE-чанки, если нужны `finish_reason`/`request_id`).

Готовые примеры:

| Файл | Что показывает |
|---|---|
| `examples/basic.ts` | health → account → chat → отказ чужому адресу |
| `examples/stream.ts` | потоковый вывод кусочков в консоль |
| `examples/react-hook.tsx` | хук для React + Supabase JWT + Vite-прокси |
| `examples/raw-fetch.ts` | то же самое «голым» `fetch` и печать curl-команды |
| `examples/openai-sdk.ts` | официальный SDK `openai`: модели, чат, tools, поток |

### Из React-приложения (этот репозиторий)

Браузер не должен знать секрет, поэтому берём JWT текущего пользователя и идём
относительным URL через прокси Vite (иначе CORS/смешанный контент). Прокси уже
прописан в `vite.config.ts` и включается переменной окружения:

```bash
node api/src/server.ts                                   # терминал 1 — API
VITE_PRIVATE_API_URL=http://127.0.0.1:8787 npm run dev    # терминал 2 — фронтенд
```

```ts
const { data: { session } } = await supabase.auth.getSession();
const api = new HikkoApiClient({ baseUrl: "/private-api", apiKey: session!.access_token });
```

Готовый хук-шаблон — `examples/react-hook.tsx`.

### Из Cline / Cursor / Continue / SDK `openai`

```
Base URL:  http://localhost:8787/v1
API Key:   ключ из консоли сервера (hk1.… или HIKKO_API_KEY)
Model ID:  hikko-gpt
```

Подробности, список поддержанных полей OpenAI и подводные камни —
в [`docs/openai-compatible.md`](docs/openai-compatible.md). Готовый пример на
официальном SDK: `examples/openai-sdk.ts` (`npm i --no-save openai`).

---

## Переменные окружения

Все необязательные: без них сервер поднимается в режиме `echo`. Читаются из
`process.env`, корневого `.env` и `api/.env` (последний приоритетнее). Шаблон — `api/.env.example`.

| Переменная | По умолчанию | Зачем |
|---|---|---|
| `HOST` / `PORT` | `0.0.0.0` / `8787` | на чём слушать |
| `ALLOWED_EMAILS` | `babaevafarida8@gmail.com` | белый список, через запятую |
| `HIKKO_API_SECRET` | `hikko-dev-secret-change-me` | подпись производных ключей — **сменить в бою** |
| `HIKKO_API_KEY` | — | готовый статический ключ (способ 1) |
| `ADMIN_TOKEN` | — | включает `POST /api/v1/admin/token` |
| `GEMINI_API_KEYS` | — | ключи Google AI Studio (перебор списка, как в edge-функции `chat`) |
| `OPENAI_BASE_URL` + `OPENAI_API_KEY` | — | любой OpenAI-совместимый шлюз (напр. Lovable AI Gateway → `LOVABLE_API_KEY`) |
| `SUPABASE_URL` + `SUPABASE_ANON_KEY` | из `.env` | проверка Supabase JWT (способ 3) |
| `ALLOW_HEADER_AUTH` | `true` в dev, `false` в production | вход по `X-Hikko-Email` |
| `ALLOW_UNKNOWN_MODEL` | `true` | незнакомый `model` молча заменяется дефолтным; `false` → 400 |
| `RATE_LIMIT_PER_MINUTE` | `600` | `0` отключает лимит |
| `MAX_BODY_BYTES` | `1000000` | потолок размера запроса |
| `UPSTREAM_TIMEOUT_MS` | `120000` | таймаут похода в модель |
| `HIKKO_SYSTEM_PROMPT` | встроенный | системный промпт по умолчанию |
| `DEFAULT_MODEL` | `hikko-gpt` | модель, если в запросе не указана |

Режим выбирается автоматически: `GEMINI_API_KEYS` → **gemini**, иначе
`OPENAI_BASE_URL`+`OPENAI_API_KEY` → **openai**, иначе **echo**. Текущий режим
виден в `GET /api/v1/health` и в поле `provider` каждого ответа.

---

## curl

```bash
KEY='hk1.YmFiYWV2YWZhcmlkYThAZ21haWwuY29t..GAV75…'   # из консоли сервера

curl -s localhost:8787/api/v1/health

curl -s localhost:8787/api/v1/account -H "Authorization: Bearer $KEY"

curl -s localhost:8787/api/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Привет!"}]}'

curl -sN localhost:8787/api/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Расскажи про Марс"}],"stream":true}'

# чужой адрес → 403
curl -s -o /dev/null -w '%{http_code}\n' localhost:8787/api/v1/account \
  -H 'X-Hikko-Email: someone.else@gmail.com'
```

Выпустить ключ с сервера (если задан `ADMIN_TOKEN`):

```bash
curl -s -X POST localhost:8787/api/v1/admin/token \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"email":"babaevafarida8@gmail.com","ttl_seconds":86400}'
```

---

## Тесты и типы

```bash
npm run api:test        # node --test api/test/*.test.ts → 45 тестов
npm run api:typecheck   # tsc -p tsconfig.api.json --noEmit
```

Покрыто: белый список (регистр/пробелы/похожие адреса), подпись и срок жизни
ключа, подмена e-mail в ключе, 401 vs 403, статический ключ, вход по заголовку,
валидация тела, SSE-поток до `[DONE]`, rate limit + `Retry-After`, выпуск ключа
через admin, CORS, 404/405. Плюс OpenAI-совместимость (`test/openai-compat.test.ts`):
`/v1/models`, все три варианта базового URL, «агентский» пейлоад с `tool_calls`
и `role: "tool"`, маппинг инструментов в Gemini и обратно, а при установленном
пакете `openai` — прогон настоящего SDK против этого сервера (иначе тест
автоматически пропускается). Фронтенд-тесты (`npm test`, vitest) не затрагиваются:
`api/` лежит вне `src/` и в сборку Vite не попадает.

---

## Ограничения (осознанные)

- Rate limit и состояние — в памяти одного процесса; для нескольких инстансов нужен Redis/БД.
- История диалога не хранится: клиент сам передаёт `messages` (как в OpenAI API).
- Белый список зашит в конфиг; чтобы он жил в БД, читайте `unlimited_emails`
  через service-role ключ в `config.ts` — место помечено типом `allowlist`.
- `stream_options.include_usage` принимается, но отдельный чанк с usage в конце
  потока не отдаётся (токены есть в обычном ответе, когда их сообщает апстрим).
- Не реализованы `/v1/embeddings`, `/v1/files`, Assistants API и legacy-`/v1/completions`
  (последний — алиас на chat).
- Это отдельный сервис, а не Supabase Edge Function. Если нужен именно деплой
  в Supabase (`supabase/functions/…`), логика из `allowlist.ts`/`token.ts`
  переносится один в один — скажите, добавлю вариант функции.
