# Деплой на Vercel

Vercel не запускает долгоживущий Node-сервер: он вызывает функцию на каждый
запрос. Поэтому в `api/api/[[...path]].ts` лежит тонкий адаптер — он принимает
`VercelRequest`/`VercelResponse` и передаёт их в тот же роутер, что и локальный
сервер (`api/src/server.ts`). Поведение одинаковое: те же пути, тот же доступ по
e-mail, тот же SSE и function calling.

```
api/                     ← Root Directory проекта на Vercel
├─ api/[[...path]].ts    ← единственная функция (ловит все пути)
├─ src/…                 ← логика: доступ, роуты, апстрим
├─ vercel.json           ← @vercel/node, routes, maxDuration, includeFiles
└─ playground.html
```

> **Почему Root Directory = `api/`.** Vercel считает каждый файл в каталоге
> `api/` отдельной функцией. Если оставить корнем весь репозиторий, он сделает
> «функции» из `api/src/server.ts`, `api/test/*.test.ts` и т.д. С корнем `api/`
> функцией будет только `api/api/[[...path]].ts`, а `vercel.json` из `api/`
> направит на неё все запросы.

## 1. Через GitHub (рекомендуется)

1. [vercel.com/new](https://vercel.com/new) → импорт репозитория `DMloaderJava/hikkogpt`, ветка `arena/01a0dd09-hikkogpt` (или `main` после мержа).
2. **Root Directory** → `api` (это ключевой шаг).
3. Framework Preset: **Other**. Build Command: **пусто** (или `exit 0`), Output Directory: **пусто** — статика не собирается, `vercel.json` всё описывает сам.
4. Environment Variables (Settings → Environment Variables):

| Переменная | Значение | Обязательно |
|---|---|---|
| `HIKKO_API_SECRET` | `openssl rand -hex 32` | ✅ без него сервер откажется стартовать |
| `ALLOWED_EMAILS` | `babaevafarida8@gmail.com` | ✅ (иначе возьмётся значение по умолчанию) |
| `GEMINI_API_KEYS` | ключ(и) Google AI Studio | ✅ иначе режим `echo` |
| `OPENAI_BASE_URL` + `OPENAI_API_KEY` | альтернатива Gemini | — |
| `CORS_ORIGIN` | `https://<домен-фронтенда>` | рекомендуется |
| `RATE_LIMIT_PER_MINUTE` | `600` | — |
| `LOG_LEVEL` | `info` | — |
| `SERVE_PLAYGROUND` | не задавать (= `false`) | — |
| `ALLOW_HEADER_AUTH` | не задавать (= `false`) | — |
| `NODE_ENV` | Vercel выставляет сам | — |

5. Deploy. Дальше — проверка (раздел 3).

## 2. Через CLI

```bash
npm i -g vercel
cd api
vercel link            # создать/привязать проект
vercel env add HIKKO_API_SECRET production
vercel env add ALLOWED_EMAILS production
vercel env add GEMINI_API_KEYS production
vercel build           # локальная проверка сборки (необязательно, но полезно)
vercel deploy --prod
```

`vercel build` покажет, что получилась одна функция и что все `.ts`-импорты
разрешились, — дешевле поймать проблему здесь, чем в логах деплоя.

## 3. Проверка после деплоя

```bash
node api/scripts/smoke.ts https://<ваш-проект>.vercel.app --api-key hk1.…
# или, если секрет тот же, что в переменных Vercel:
HIKKO_API_SECRET='<секрет>' npm run api:smoke -- https://<ваш-проект>.vercel.app
```

Скрипт проходит 15 проверок (доступ, приватность `/health`, `/v1/models`, чат,
поток, инструменты, ошибки, задержки) и печатает отчёт ✅/⚠️/❌; при наличии ❌
возвращает код 1. Ожидаемая картина на Vercel:

- `mode=gemini` (не `echo`) — иначе не заданы ключи модели;
- `allowlist скрыт`, `песочница 404`, `вход по заголовку 401` — production-дефолты;
- поток: несколько SSE-событий, `data: [DONE]` в конце.

## 4. Подключение Cline к Vercel-адресу

| Поле | Значение |
|---|---|
| API Provider | OpenAI Compatible |
| Base URL | `https://<ваш-проект>.vercel.app/v1` |
| API Key | ключ для `babaevafarida8@gmail.com` |
| Model ID | `hikko-gpt` |

Ключ печатается в логах функции при первом запросе (Runtime Logs) — или выведите
его локально: `HIKKO_API_SECRET='<секрет>' node -e '…'` (команда в `docs/deploy.md`).

## 5. Особенности Vercel, о которых нужно знать

| Ограничение | Что делает API | Что сделать вам |
|---|---|---|
| **Лимит времени функции**: Hobby — 10 с по умолчанию (макс. 60), Pro — до 300 с; с Fluid Compute выше | `maxDuration: 60` в `api/vercel.json`, SSE-пинги каждые 15 с | На Hobby проверьте, что 60 с применилось (Settings → Functions). Для длинных ответов агента нужен Pro |
| **Стриминг** | Node.js runtime стримит по умолчанию, `supportsResponseStreaming: true` | ничего |
| **Память/состояние** | rate limit живёт в памяти инстанса | для жёстких квот нужен внешний стор (Upstash/Redis); сейчас это защита от runaway-цикла, не биллинг |
| **Обрыв соединения клиентом** | функция может доработать до `maxDuration` | включите `supportsCancellation` в Settings → Functions, если хотите экономить вычисления |
| **Холодный старт** | конфиг и провайдер кэшируются на инстанс | ничего; смоук-скрипт показывает задержку |
| **Секреты** | читаются только из `process.env` | `.env` в репозиторий не коммитить; `api/.env` на Vercel не нужен |
| **Песочница `GET /`** | по умолчанию выключена | `SERVE_PLAYGROUND=true`, если хотите её на проде (файл включён через `includeFiles`) |

## 6. Если что-то пошло не так

| Симптом | Причина | Лечение |
|---|---|---|
| `FUNCTION_INVOCATION_FAILED` / ошибка сборки про `.ts`-импорт | Vercel не собрал TS-цепочку | проверьте `vercel build` локально; убедитесь, что Root Directory = `api` |
| В логах `Отказ запуска: HIKKO_API_SECRET не задан…` | дефолтный секрет | задайте переменную в проекте |
| Все ответы — «отвечаю в режиме echo» | нет ключей модели | `GEMINI_API_KEYS` или `OPENAI_BASE_URL` + `OPENAI_API_KEY` |
| Cline получает 401 | ключ от другого секрета | перевыпустите ключ тем же `HIKKO_API_SECRET`, что на Vercel |
| Cline получает 403 | адрес не из белого списка | `ALLOWED_EMAILS` на Vercel должен совпадать с адресом ключа |
| Поток приходит одним куском | буферизация/таймаут | смоук-скрипт покажет число SSE-событий; проверьте `maxDuration` |
| 504 на длинном ответе | упёрлись в `maxDuration` | поднимите до 300 (Pro) или включите Fluid Compute |

## 7. Альтернатива: свой сервер

Если нужны долгие сессии, WebSocket или жёсткие квоты — Vercel не лучшая площадка.
Тот же код без изменений работает как обычный процесс: `api/docs/deploy.md`
(systemd + Caddy/nginx). Переключение не требует правок в клиенте: меняется
только Base URL.
