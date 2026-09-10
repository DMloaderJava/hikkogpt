# Roadmap

- [x] Markdown-таблицы в сообщениях (уже были) + подсветка синтаксиса кода (highlight.js)
- [x] Sidebar: группировка по датам, поиск по истории, анимации
- [ ] Voice Mode (Gemini Live API, speech-to-speech) с function calling `play_sound`
  - [ ] WS-прокси через edge-функцию (ключ не в браузере)
  - [x] audioEngine.ts (плейбек PCM 24 кГц, очередь буферов встык, barge-in, analyser для сферы)
  - [x] soundboard.ts (4 SFX mp3 в /public/sounds, предзагрузка в AudioBuffer + мгновенный play)
  - [ ] захват микрофона 16 кГц (AudioWorklet `pcm-recorder-worklet.js` уже лежит в /public)
  - [ ] useGeminiLive.ts, VoiceVisualizer.tsx, кнопка запуска в UI
