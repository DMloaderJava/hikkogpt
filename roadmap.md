# Roadmap

- [ ] Markdown-таблицы в сообщениях (уже были) + подсветка синтаксиса кода (highlight.js)
- [ ] Sidebar: группировка по датам, поиск по истории, анимации
- [ ] Voice Mode (Gemini Live API, speech-to-speech) с function calling `play_sound`
  - [ ] WS-прокси через edge-функцию (ключ не в браузере)
  - [ ] audioEngine.ts (PCM 16k in / 24k out, очередь буферов, barge-in)
  - [ ] soundboard.ts (4 SFX mp3 в /public/sounds)
  - [ ] useGeminiLive.ts, VoiceVisualizer.tsx, кнопка запуска в UI
