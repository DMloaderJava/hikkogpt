# Деплой приватного API

Сервис самодостаточный: один процесс Node, ноль npm-зависимостей, состояния в
памяти немного (счётчик лимита). Ниже — минимум, без которого наружу выставлять
нельзя, и готовые конфиги.

## 0. Чек-лист перед деплоем

| Пункт | Как | Обязательно? |
|---|---|---|
| Node ≥ 22.18 (или ≥ 23.6) | `node -v` — сервер исполняет `.ts` напрямую | ✅ |
| Свой `HIKKO_API_SECRET` | `openssl rand -hex 32` | ✅ иначе сервер **не стартует** с `NODE_ENV=production` |
| `ALLOWED_EMAILS` | ваш адрес (по умолчанию `babaevafarida8@gmail.com`) | ✅ |
| Ключи модели | `GEMINI_API_KEYS=…` или `OPENAI_BASE_URL` + `OPENAI_API_KEY` | ✅ иначе режим `echo` |
| `NODE_ENV=production` | выключает вход по заголовку, песочницу и показ e-mail в `/health` | ✅ |
| HTTPS | reverse-proxy (Caddy/nginx) — Cline и браузеры не любят смесь http/https | ✅ для внешнего доступа |
| `CORS_ORIGIN` | свои источники вместо `*` | рекомендуется |
| Файрвол | наружу только 443 (и 80 → редирект); порт API закрыть | рекомендуется |

При старте сервер сам печатает список замечаний (`ВНИМАНИЕ: …`) — это и есть
готовый аудит конфига. С дефолтным секретом в production он падает с
`Отказ запуска: HIKKO_API_SECRET не задан …`.

## 1. Установка

```bash
git clone https://github.com/DMloaderJava/hikkogpt.git
cd hikkogpt
node -v                     # ≥ 22.18
cp api/.env.example api/.env
nano api/.env               # секреты, ключи модели, NODE_ENV=production
npm run api                 # пробный запуск в консоли
```

`api/.env` в git не попадает (он не отслеживается), а вот `.env.example` —
шаблон без секретов. Секрет и ключи модели можно задать и через окружение
процесса — оно приоритетнее файла.

```bash
# сгенерировать секрет и сразу ключ для своего адреса
openssl rand -hex 32
HIKKO_API_SECRET='<секрет>' node -e '
  import("./api/src/token.ts").then(({ apiKeyForEmail }) =>
    console.log(apiKeyForEmail("babaevafarida8@gmail.com", process.env.HIKKO_API_SECRET)));
'
```

Тот же ключ печатается в консоли при старте сервера.

## 2. systemd

`/etc/systemd/system/hikko-api.service`:

```ini
[Unit]
Description=hikkoGPT private API (OpenAI-compatible)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=hikko
WorkingDirectory=/opt/hikkogpt
Environment=NODE_ENV=production
Environment=HOST=127.0.0.1
Environment=PORT=8787
ExecStart=/usr/bin/node api/src/server.ts
Restart=always
RestartSec=3
# Секреты — в файле, а не в юните: api/.env читается самим сервером.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/hikkogpt
MemoryMax=512M

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now hikko-api
journalctl -u hikko-api -f      # логи: по строке на запрос
```

`HOST=127.0.0.1` — намеренно: наружу сервис смотрит только через reverse-proxy.
Если прокси на другой машине, укажите нужный интерфейс и закройте порт файрволом.

## 3. Reverse-proxy с HTTPS

### Caddy (проще всего, сертификат сам)

```caddyfile
api.example.com {
    reverse_proxy 127.0.0.1:8787 {
        flush_interval -1        # обязательно для SSE
    }
}
```

### nginx

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;

    # SSE: без буферизации и с длинными таймаутами, иначе поток «залипнет»
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;
    chunked_transfer_encoding on;
}
```

Сервер со своей стороны уже отдаёт `X-Accel-Buffering: no` и шлёт SSE-пинги
`: ping` каждые `SSE_KEEP_ALIVE_MS` (15 с по умолчанию) — это страхует от
обрыва, когда модель думает дольше idle-таймаута прокси.

## 4. Подключение Cline к задеплоенному API

| Поле | Значение |
|---|---|
| API Provider | OpenAI Compatible |
| Base URL | `https://api.example.com/v1` |
| API Key | ключ для разрешённого адреса |
| Model ID | `hikko-gpt` |

Проверка без Cline:

```bash
curl -s https://api.example.com/api/v1/health          # allowlist пустой — так и должно быть
curl -s https://api.example.com/v1/models -H "Authorization: Bearer $KEY"
curl -sN https://api.example.com/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"hikko-gpt","stream":true,"messages":[{"role":"user","content":"Привет"}]}'
```

## 5. Обновление и откат

```bash
cd /opt/hikkogpt && git pull && sudo systemctl restart hikko-api
npm run api:test          # 56 тестов — прогнать до рестарта, если есть сомнения
```

Сервис stateless (кроме счётчика лимита в памяти), поэтому рестарт безопасен:
незавершённые потоки просто оборвутся, клиент переспросит.

## 6. Что проверить после деплоя

1. `GET /api/v1/health` → `200`, `mode` = `gemini`/`openai` (не `echo`!), `allowlist: []`.
2. Без ключа → `401`; с чужим адресом → `403`; со своим → `200`.
3. `GET /` → `404` (песочница в production выключена).
4. Потоковый запрос идёт кусочками, а не одним ответом в конце (проверка прокси).
5. Запрос с `tools` возвращает `tool_calls` (проверка function calling на живой модели).
6. `journalctl -u hikko-api` — по строке на запрос, без необработанных ошибок.

## 7. Чего в сервисе нет (осознанно)

- **Персистентности**: лимит и ключи — в памяти одного процесса. Несколько
  инстансов за балансировщиком дадут каждому свой счётчик; если это станет
  важно — выносите в Redis или читайте `unlimited_emails`/счётчики из Postgres.
- **Истории диалогов**: клиент сам передаёт `messages` (как в OpenAI API).
- **Белого списка в БД**: адрес задан конфигом. Логика изолирована в
  `api/src/allowlist.ts`, так что замена на запрос к `unlimited_emails` —
  правка одного места.
- **Метрик и трейсинга**: только текстовый лог (`LOG_LEVEL=debug` — подробнее).
