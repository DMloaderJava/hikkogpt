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

## Дальше (идеи, не начато)

- [ ] Синхронная транскрипция реплик рядом со сферой (input/output transcription в Live API)
- [ ] Автопауза голосового режима при уходе вкладки в фон (visibilitychange)
- [ ] Выбор голоса Live-сессии отдельно от голоса озвучки сообщений
