# Roadmap

- [x] Markdown-таблицы в сообщениях (уже были) + подсветка синтаксиса кода (highlight.js)
- [x] Sidebar: группировка по датам, поиск по истории, анимации
- [x] Voice Mode (Gemini Live API, speech-to-speech) с function calling `play_sound`
  - [x] WS-прокси через edge-функцию (ключ не в браузере) + фрейм `proxyInfo` с фактической моделью
  - [x] audioEngine.ts (плейбек PCM 24 кГц, очередь буферов встык, barge-in, analyser для сферы)
  - [x] soundboard.ts (4 SFX mp3 в /public/sounds, предзагрузка в AudioBuffer + мгновенный play)
  - [x] захват микрофона 16 кГц: pcm-recorder-worklet.js (ресемплинг из 44.1/48/96 кГц, чанки 32 мс, flush)
  - [x] useGeminiLive.ts (сокет, setup по proxyInfo, пре-ролл аудио, barge-in, toolCall -> саундборд, mute)
  - [x] VoiceVisualizer.tsx (Canvas 2D + analyser, 4 состояния агента) и кнопка AudioLines в ChatInput

## Этап 1: блокеры прода (сделано 2026-09-11)

Причина была не в коде, а в конфигурации и устаревших константах — см. `docs/voice-mode.md`.

- [x] `[functions.gemini-live] verify_jwt = false` в `supabase/config.toml`: платформенная проверка JWT отклоняла браузерный WS (нет заголовка `Authorization`) до запуска функции
- [x] Актуальные модели Live: дефолт `models/gemini-3.1-flash-live-preview`, второй — `models/gemini-2.5-flash-native-audio-preview-12-2025`; снятые с эксплуатации 2.0/2.5-preview оставлены только в хвосте ротации
- [x] `realtimeInput.audio` вместо устаревшего `mediaChunks` (в референсе Live API помечен DEPRECATED)
- [x] Прокси считает сессию поднятой только по `setupComplete` + watchdog 6 с — ротация «модель × ключ» заработала и для случая «Google принял апгрейд и промолчал»
- [x] Внятные ошибки вместо «Сессия закрыта»: фреймы `upstreamError` / `sessionClosed` и коды 4408/4410
- [x] Тесты: `geminiLive.test.ts` (хук с фейковым WebSocket: пре-ролл, `audio`-кадры, mute, toolCall, ошибки) и `voiceModeConfig.test.ts` (стражи конфига и моделей) — 107 тестов

## Дальше (идеи, не начато)

- [ ] Синхронная транскрипция реплик рядом со сферой (input/output transcription в Live API)
- [ ] Автопауза голосового режима при уходе вкладки в фон (visibilitychange)
- [ ] Выбор голоса Live-сессии отдельно от голоса озвучки сообщений
- [ ] `audioStreamEnd` при mute — чтобы серверный VAD понимал, что фраза окончена
- [ ] `sessionResumption` + `contextWindowCompression` + обработка `goAway`: без них сессия обрывается на ~10–15 минутах (сейчас показываем честную ошибку)
