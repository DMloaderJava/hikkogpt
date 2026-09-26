# Подключение из Cline (и других «OpenAI Compatible» клиентов)

API говорит на языке OpenAI: `GET /v1/models`, `POST /v1/chat/completions`,
SSE-поток с `data: {…}` и `data: [DONE]`, инструменты (`tools`, `tool_choice`,
`tool_calls`, сообщения `role: "tool"`). Поэтому он подключается как обычный
OpenAI-совместимый провайдер — ключом выступает тот же ключ доступа для
`babaevafarida8@gmail.com`.

## 1. Поднять сервер

```bash
npm run api                 # http://localhost:8787, ключ напечатается в консоли
# или сразу с настоящей моделью:
GEMINI_API_KEYS=AIza… npm run api
```

Деплой: на свой сервер — [`deploy.md`](deploy.md), на Vercel — [`vercel.md`](vercel.md)
(Base URL станет `https://<ваш-проект>.vercel.app/v1`).

Для боевого использования задайте свой секрет и (опционально) статический ключ:

```bash
HIKKO_API_SECRET='случайная-дли-и-нная-строка' \
HIKKO_API_KEY='sk-hikko-…' \
ALLOW_HEADER_AUTH=false \
NODE_ENV=production \
npm run api
```

## 2. Настроить Cline

В Cline: **Settings → API Provider → «OpenAI Compatible»**.

| Поле | Значение |
|---|---|
| Base URL | `http://localhost:8787/v1` |
| API Key | ключ из консоли сервера (`hk1.…`) или `HIKKO_API_KEY` |
| Model ID | `hikko-gpt` (или `hikko-gpt-turbo`, `hikko-gpt-smart`, `gemini-2.5-pro`) |

Если Cline запущен на другой машине/контейнере — вместо `localhost` укажите адрес
хоста (сервер слушает `0.0.0.0`), например `http://192.168.1.20:8787/v1` или
`https://<ваш-домен>/v1`.

Тот же набор полей — в Cursor (Settings → Models → Override OpenAI Base URL),
Continue (`apiBase`), Roo Code, Kilo Code, LangChain (`baseURL` у
`ChatOpenAI`), LiteLLM (`api_base`) и SDK `openai`.

## 3. Что именно поддерживает API

| Возможность OpenAI | Статус |
|---|---|
| `POST /v1/chat/completions` | ✅ |
| `GET /v1/models` | ✅ (формат `{object:"list",data:[{id,object:"model",…}]}`) |
| `stream: true` (SSE) | ✅ чанки `chat.completion.chunk` + `data: [DONE]` |
| `tools`, `tool_choice` | ✅ маппятся в function calling Gemini |
| `tool_calls` в ответе | ✅ и в обычном ответе, и дельтами в потоке |
| `role: "tool"` (результат вызова) | ✅ |
| `system`, `temperature`, `top_p`, `max_tokens`, `stop` | ✅ |
| `n`, `user`, `seed`, `logit_bias`, `response_format`, `stream_options`, `parallel_tool_calls` | принимаются и игнорируются (запрос не отклоняется) |
| `prompt_tokens`/`completion_tokens` | ✅ когда их отдаёт апстрим |
| `POST /v1/completions` (legacy text) | алиас на chat/completions |
| Fine-tuning, files, embeddings, assistants | ❌ не реализовано |

Базовый URL можно указывать в трёх вариантах — сервер понимает все:

| Base URL в клиенте | Путь, который получится |
|---|---|
| `http://host:8787` | `/v1/chat/completions`, `/v1/models` |
| `http://host:8787/v1` | `/chat/completions`, `/models` |
| `http://host:8787/api/v1` | `/chat/completions`, `/models` |

## 4. Важные детали

- **Доступ.** Ключ обязан соответствовать `babaevafarida8@gmail.com`: чужой
  адрес получит `403`, отсутствие ключа — `401`. Cline хранит ключ в своём
  конфиге, так что секрет `HIKKO_API_SECRET` ему не нужен.
- **Незнакомый Model ID не ломает подключение.** Cline подставляет то, что ввёл
  пользователь; по умолчанию неизвестная модель молча заменяется на
  `DEFAULT_MODEL`. Если хочется строгости — `ALLOW_UNKNOWN_MODEL=false`, тогда
  ответ будет `400` с подсказкой.
- **Системный промпт агента важнее нашего.** Если в запросе есть `system`-сообщение
  (а Cline его всегда присылает), встроенный «характер hikkoGPT» не подмешивается —
  иначе он конфликтовал бы с инструкциями агента.
- **Инструменты работают только с настоящей моделью.** В режиме `echo`
  (ключи не заданы) API честно отвечает текстом и в сообщении указывает, что
  инструменты видны, но не вызываются. Для Cline обязательно задайте
  `GEMINI_API_KEYS` или `OPENAI_BASE_URL` + `OPENAI_API_KEY`.
- **HTTPS и удалённый доступ.** За reverse-proxy (nginx/Caddy/Traefik) включите
  проксирование SSE без буферизации: `proxy_buffering off`, `proxy_read_timeout 600s`,
  `X-Accel-Buffering: no` сервер уже отдаёт сам.
- **Лимит.** `RATE_LIMIT_PER_MINUTE` (по умолчанию 600) — агент в цикле упрётся
  в `429` + `Retry-After`, а не сожжёт ключи.

## 5. Быстрая проверка без Cline

```bash
KEY='hk1.…'   # из консоли сервера

curl -s localhost:8787/v1/models -H "Authorization: Bearer $KEY"

curl -s localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{
        "model": "hikko-gpt",
        "messages": [{"role":"user","content":"Какая погода в Аше?"}],
        "tools": [{"type":"function","function":{
          "name":"get_weather",
          "parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}
        }}],
        "tool_choice": "auto"
      }'
```

Или официальный SDK: `npm i --no-save openai && node api/examples/openai-sdk.ts`
(пример печатает модели, чат, вызов инструмента и поток).

## 6. Проверено

`npm run api:test` включает `api/test/openai-compat.test.ts`: пути `/v1/*`,
`/v1/models`, полный «агентский» пейлоад (system + assistant с `tool_calls` +
`role:"tool"` + `tools`/`tool_choice`/`stop`/`top_p`/`stream_options`),
маппинг инструментов в Gemini и обратно, а при установленном пакете `openai` —
прогон настоящего SDK (`models.list`, `chat.completions.create`, `stream: true`)
против этого сервера.

`api/test/upstream-openai.test.ts` дополнительно поднимает поддельный
OpenAI-совместимый шлюз и проверяет сквозной проход: текст и `usage`, проброс
ключа апстрима, `tool_calls` в обычном ответе и сборку `tool_calls` из дельт в
потоке, а также `502 upstream_error` при отказе шлюза. Итого 64 теста (`api/test/production.test.ts` добавляет проверки production-режима: отказ запуска с дефолтным секретом, приватность `/health`, SSE-пинги, обрыв потока клиентом).
