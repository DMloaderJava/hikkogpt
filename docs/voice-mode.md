# Голосовой режим hikkoGPT: карта, аудит и точки роста

Аудит от 2026-09-11, ветка `arena/01a090f2-hikkogpt` (база — `d3752a3`, PR #1 «Voice Mode»).

> **Статус на конец дня 2026-09-11: Этап 1 закрыт.** Исправлены P0-1 (деплой-флаг), P0-2 (мёртвые модели),
> P1-3 (`mediaChunks` → `audio`) и P1-5 (слепая ротация ключей + непонятные ошибки); в оверлее появился бейдж фактической модели сессии. Подробности — в разделе 9
> (пункты помечены «ИСПРАВЛЕНО»). Этапы 2–4 (session resumption, транскрипция, `audioStreamEnd`) — не начаты.

Проверено в этом репозитории:

| Проверка | Результат |
| --- | --- |
| `npx vitest run` | **110/110 зелёных** (8 файлов); было 86 — добавились `geminiLive.test.ts` и `voiceModeConfig.test.ts` |
| `npx tsc -p tsconfig.app.json --noEmit` | чисто |
| `npx vite build` | успешно, один чанк 845 кБ (gzip 258 кБ) |
| `npx eslint .` | 17 ошибок в репозитории, **ни одна — в файлах голосового режима** (это `any` в `chat`/`deepsearch`/`ui/*`, `useSounds.ts`, `Index.tsx`) |
| Живой прогон против Google | невозможен из песочницы: исходящие HTTPS из bash заблокированы, ключей `GEMINI_*` локально нет. Непроверенное помечено ниже словом **«проверить»** |

---

## 0. TL;DR

Голосовой режим — самая проработанная часть кода в проекте: аккуратная работа с Web Audio, честный WS-прокси, 86 тестов, включая песочницу AudioWorklet. Логика barge-in, пре-ролла и саундборда сделана по-взрослому.

Но **«как задеплоить» и «на какой модели» — сейчас не сходится с реальностью 2026 года**:

1. ~~**P0. Деплой `gemini-live` без флага не поднимется.**~~ **ИСПРАВЛЕНО:** секция добавлена в `config.toml`. В `supabase/config.toml` нет секции `[functions.gemini-live]`, а Supabase по умолчанию (`verify_jwt = true`) требует JWT в заголовке `Authorization`. Браузерный WebSocket заголовки задать не может — значит, платформа отклонит апгрейд до того, как код функции вообще выполнится. В комментарии к PR и в roadmap написано просто `supabase functions deploy gemini-live` — этого мало.
2. ~~**P0. Все три модели в списке прокси сняты Google с эксплуатации.**~~ **ИСПРАВЛЕНО:** дефолт `models/gemini-3.1-flash-live-preview` + актуальный фолбэк. По changelog Gemini API `gemini-2.0-flash-live-001` и `gemini-live-2.5-flash-preview` отключены 09.12.2025, `gemini-2.0-flash-exp` — из той же отменённой линейки. Даже с ключом и правильным `verify_jwt` сессия не поднимется, пока `GEMINI_LIVE_MODEL` не переопределён вручную на актуальную модель.
3. **P1 (частично исправлено).** ~~Устаревшее поле `realtimeInput.mediaChunks`~~ → заменено на `audio`. Управления сессией по-прежнему нет: без `sessionResumption`/`contextWindowCompression` диалог упрётся в лимит (~15 минут аудио, ~10 минут на соединение) — но теперь об этом честно сообщается, а не просто «Сессия закрыта».
4. ~~**P1.** Ротация ключей/моделей в прокси работает только если апстрим **не** открылся.~~ **ИСПРАВЛЕНО:** сессия считается поднятой только после `setupComplete`, добавлен watchdog на 6 с, причины отдаются клиенту. А типичные ошибки Google (неверный ключ, недоступная модель) приходят **после** успешного апгрейда — то есть ротация не сработает, а клиент увидит аккуратный `close(1000)`, то есть «сессия закрыта», а не ошибку.

Ниже — полная карта, все находки с приоритетами и конкретные патчи.

---

## 1. В приложении четыре разных «голоса» — их легко перепутать

| # | Что это | Где | Транспорт | Статус |
| --- | --- | --- | --- | --- |
| 1 | **Voice Mode** — живой диалог с Gemini (speech-to-speech) + саундборд `play_sound` | `useGeminiLive`, `audioEngine`, `soundboard`, `VoiceModeOverlay`, `VoiceVisualizer`, `gemini-live` (edge) | WebSocket через edge-прокси + Web Audio | Ядро аудита |
| 2 | **Диктовка** — распознать речь в текст в поле ввода | `useVoice.ts`, `elevenlabs-stt` (Scribe v2) | `MediaRecorder` → HTTP multipart | Работает независимо, тестов нет |
| 3 | **Озвучка ответа** — кнопка «динамик» у сообщения | `MessageBubble` → `useTTS` → `gemini-tts` (внутри — OpenAI `tts-1` через Lovable AI Gateway) | HTTP → mp3 → `<audio>` | Отдельный `<audio>`; глушится событием `hikkoGPT:stop-speech` при старте голосового режима |
| 4 | **Озвучка диалога** — модалка «Озвучить диалог» со Speaker 1..8 | `DialogTtsModal` → `dialog-tts` → `google/gemini-3.1-flash-tts-preview` | HTTP → wav | Не пересекается с режимом 1 |

Плюс два «звуковых» слоя: UI-блипы `useSounds` (send/receive) и **саундборд** из 4 mp3 (`/public/sounds`) — единственный источник звука, которым управляет сама модель через function calling.

В настройках один общий селектор «Голос озвучки» (`TTS_VOICES`, включая Leda) — он же подставляется в Live-сессию через `resolveLiveVoiceName()`. Это компромисс, зафиксированный в roadmap как «выбор голоса Live-сессии отдельно от голоса озвучки».

---

## 2. Поток данных голосового режима

```
 КЛИК AudioLines (ChatInput.tsx:164)
        │
        ▼
 Index.handleToggleVoiceMode (Index.tsx:52) ──► useGeminiLive.connect()
        │
        ├─ 1. supabase.auth.getSession()            ← настоящий JWT пользователя
        ├─ 2. AudioPlaybackEngine() + resume()      ← выход: 24 кГц, masterGain → analyser → destination
        │      └─ createSoundboard()                ← саундборд на ту же шину
        ├─ 3. getUserMedia({echoCancellation, noiseSuppression, autoGainControl})
        │      └─ AudioWorklet "pcm-recorder"       ← ресемплинг native(44.1/48/96) → 16 кГц, кадры 512 сэмплов (32 мс)
        ├─ 4. new WebSocket(`${SUPABASE_URL}/functions/v1/gemini-live?token=JWT`)
        │
        ▼
 EDGE-ФУНКЦИЯ gemini-live (Deno)
        ├─ auth.getUser(token) → 401 при невалидном
        ├─ перебор (модель × ключ) из GEMINI_API_KEYS
        └─ релей кадров в/из wss://generativelanguage.googleapis.com/...BidiGenerateContent?key=…&model=…
                │
                ▼
        GOOGLE GEMINI LIVE
                │
        ┌───────┴─────────────────────────────────────────────┐
        │ serverContent.modelTurn.parts[].inlineData.data      │ PCM16 24 кГц base64
        │ serverContent.interrupted / turnComplete             │
        │ toolCall: play_sound(sound_name)                     │
        │ setupComplete                                        │
        └──────────────────────────────────────────────────────┘
                │
                ▼
 useGeminiLive.onmessage
        ├─ PCM → AudioPlaybackEngine.enqueuePcmChunk()  ← встык, без пауз и наложений
        ├─ interrupted → engine.stopAndClearQueue() + soundboard.stopAll()   (barge-in, фейд 20 мс)
        ├─ toolCall → soundboard.play(name) + ответ functionResponse
        └─ локальный VoiceActivityTracker (RMS, 32 мс) → статус UI: listening / thinking
```

Важная деталь порядка запуска: **аудио не теряется на старте**. До `setupComplete` Gemini принимает только `setup`, поэтому первые кадры микрофона копятся в пре-ролл (до 25 кадров ≈ 800 мс) и досылаются сразу после подтверждения (`useGeminiLive.ts:295-306, 362-368`). Если прокси не прислал `proxyInfo` за 2 с, клиент поднимает сессию на модели по умолчанию (`SETUP_FALLBACK_MS`, там же :25, :340).

---

## 3. Карта модулей

| Файл | Строк | Роль |
| --- | --- | --- |
| `src/hooks/useGeminiLive.ts` | 573 | Дирижёр: сокет, setup, пре-ролл, barge-in, toolCall → саундборд, mute, состояния; разбор `upstreamError`/`sessionClosed` и `describeSocketClose` |
| `src/lib/audioEngine.ts` | 272 | Очередь PCM 24 кГц, base64→Float32, barge-in, общая шина, `createSoundboard()` |
| `src/lib/soundboard.ts` | 211 | Предзагрузка 4 mp3 в `AudioBuffer`, мгновенный `play()`, `stopAll()`, метки для UI |
| `src/lib/audioVisualization.ts` | 152 | Чистая математика сферы: тон из CSS, RMS/спектр, сглаживание, reduced-motion |
| `src/lib/orbRenderer.ts` | 125 | Кадр сферы (64 столбика, ядро, кольцо микрофона, дуги «думаю») |
| `src/lib/voiceActivity.ts` | 88 | Локальный VAD: RMS, порог 0.02, onset 2 кадра, пауза 550 мс |
| `src/lib/speechEvents.ts` | 19 | Событие «стоп озвучке сообщений» + `speechSynthesis.cancel()` |
| `src/types/gemini-live.ts` | 196 | Типы, `PLAY_SOUND_TOOL`, `VOICE_SYSTEM_INSTRUCTION`, список голосов, `DEFAULT_LIVE_MODEL` + `DEFAULT_LIVE_MODEL_FALLBACKS` |
| `public/pcm-recorder-worklet.js` | 112 | Захват микрофона: ресемплинг с антиалиасингом, кадры 32 мс, `flush` |
| `src/components/VoiceModeOverlay.tsx` | 153 | Оверлей: статус, mute, «Повторить», Esc, вспышка названия эффекта |
| `src/components/VoiceVisualizer.tsx` | 183 | Canvas + RAF: анализатор движка (внутри) и микрофона (кольцо) |
| `src/components/dev/VoiceVisualizerDemo.tsx` | 194 | Дев-стенд сферы по хэшу `#voice-preview` (только DEV) |
| `supabase/functions/gemini-live/index.ts` | 228 | WS-прокси: auth по JWT, ротация ключ/модель со watchdog, `proxyInfo`, `upstreamError`, `sessionClosed` |
| `src/components/ChatInput.tsx` | — | Кнопка `AudioLines` (:164-183) + индикатор активной сессии |
| `src/pages/Index.tsx` | — | Связка хука с чатом (:41-56, оверлей :353-368), состояние `lastSound` |
| `src/components/SettingsPanel.tsx` | — | Селектор «Голос озвучки» (6 голосов, включая Leda) |

Смежное (не ядро): `useVoice.ts` (диктовка), `MessageBubble.tsx` (`useTTS`), `DialogTtsModal.tsx` + `AudioPlayer.tsx`, `gemini-tts`, `elevenlabs-stt`, `dialog-tts`, `useSounds.ts`.

Суммарно ядро ≈ 2 250 строк кода + ≈ 1 600 строк тестов.

---

## 4. Константы и форматы (что важно не сломать)

| Константа | Значение | Где | Почему так |
| --- | --- | --- | --- |
| Вход | PCM16 LE, mono, **16 000 Гц** | `INPUT_MIME_TYPE`, worklet | Требование Live API |
| Кадр микрофона | 512 сэмплов = **32 мс** | `MIC_FRAME_SAMPLES` | Рекомендованный диапазон 20–40 мс |
| Выход | PCM16 LE, mono, **24 000 Гц** | `GEMINI_OUTPUT_SAMPLE_RATE` | Требование Live API |
| Пре-ролл | 25 кадров ≈ **800 мс** | `MAX_PRE_ROLL_CHUNKS` | Не терять начало фразы до `setupComplete` |
| Фолбэк setup | **2 с** | `SETUP_FALLBACK_MS` | Прокси старой версии без `proxyInfo` |
| Фейд barge-in | **20 мс** | `BARGE_IN_FADE_SECONDS` | Короче — щелчок, длиннее — «эхо» перебитой реплики |
| Ротация в прокси | 3 модели × N ключей | `MODELS`, `GEMINI_API_KEYS` | Пока апстрим не открылся ни разу |
| VAD | порог 0.02 RMS, старт через 2 кадра, конец через 550 мс | `voiceActivity.ts` | Gemini не сообщает «пользователь замолчал» |
| Саундборд | 4 mp3, громкость 0.9, фейд стопа 20 мс | `soundboard.ts` | Эффект должен перекрывать речь |
| Сфера | 64 столбика, Canvas 2D, dpr ≤ 2, fftSize 256 | `orbRenderer.ts`, `VoiceVisualizer.tsx` | 60 fps без ре-рендера React |

---

## 5. Протокол: что именно уходит и приходит

**Setup (при `proxyInfo` или по таймеру):**

```json
{ "setup": {
  "model": "models/…",                       // из proxyInfo, а не из своего списка — правильно
  "generationConfig": { "responseModalities": ["AUDIO"],
    "speechConfig": { "voiceConfig": { "prebuiltVoiceConfig": { "voiceName": "Aoede" } } } },
  "systemInstruction": { "parts": [{ "text": "Ты — мой въедливый научный ментор…" }] },
  "tools": [{ "functionDeclarations": [PLAY_SOUND_TOOL] }]
} }
```

**Микрофон (32 мс):** `{ "realtimeInput": { "audio": { "mimeType": "audio/pcm;rate=16000", "data": "<base64>" } } }`

**Ответ на toolCall:** `{ "toolResponse": { "functionResponses": [{ "id": "...", "name": "play_sound", "response": { "output": { "success": true, "sound_name": "…" } } }] } }`

**Обрабатывается из server-сообщений:** `proxyInfo`, `setupComplete`, `proxyError`, `serverContent.interrupted`, `serverContent.modelTurn.parts[].inlineData`, `serverContent.turnComplete`, `toolCall.functionCalls[]`.

**Игнорируется (есть в API):** `goAway`, `sessionResumptionUpdate`, `generationComplete`, `serverContent.inputTranscription` / `outputTranscription` / `interimInputTranscription`, `usageMetadata`, `toolCallCancellation`.

---

## 6. Жизненный цикл

```
disconnected ──connect()──► connecting ──setupComplete──► connected ──disconnect/Esc/ошибка──► disconnected|error
                                │
                                └─(исключение: нет сессии / нет микрофона / прокси не поднялся)─► error

agentState: idle ─► listening ─(VAD speech-end, не играет движок)─► thinking ─(audio parts)─► speaking
                     ▲                                                                          │
                     └──────────────── interrupted / turnComplete ──────────────────────────────┘
```

- `voiceModeActive = status !== "disconnected"` (`Index.tsx:49`) → оверлей живёт всё время соединения, включая `error`.
- Ошибки дублируются в тосты (`onError` → `toast.error`), локальный текст — в оверлее.
- `Esc` закрывает сессию (`VoiceModeOverlay.tsx:60-66`).
- При `cleanup()` глушится и озвучка сообщений чата (`announceStopSpeech`), чтобы не говорили два голоса.

---

## 7. Тестовое покрытие

| Файл тестов | Тестов | Что реально проверяется |
| --- | --- | --- |
| `pcmRecorderWorklet.test.ts` | 16 | Песочница `AudioWorkletProcessor`: 16 кГц на 44.1/48/96 кГц, отсутствие дрейфа фазы на 10 с, кадры ровно по 512, `flush`, антиалиасинг, Int16-клиппинг |
| `audioEngine.test.ts` | 18 | base64→Float32 LE, укладка встык, догон при отставании, пробуждение контекста, barge-in с фейдом, освобождение нод, `setVolume`, общая шина с саундбордом, закрытие своего/чужого контекста |
| `soundboard.test.ts` | 15 | Предзагрузка и идемпотентность, докачка упавшего файла, Safari-`decodeAudioData`, мгновенный старт, стоп по barge-in, `dispose` |
| `voiceUi.test.ts` | 26 | Тон/цвет, уровни, сглаживание, VAD (щелчки, паузы, сброс), выбор голоса Live, подпись и «устаревание» модели в оверлее, подписи звуков |
| `voiceVisualizer.test.tsx` | 12 | RAF-цикл, размеры буферов, отсутствие 2D-контекста, микрофонное кольцо, «думаю», вписывание в холст, доступность |
| `geminiLive.test.ts` | 14 | Хук с фейковым WebSocket и стеком Web Audio: setup по `proxyInfo`, пре-ролл до `setupComplete`, поле `audio`, mute, ответы на toolCall, разбор `upstreamError`/`sessionClosed`, пересылка setup после ротации на прокси, отсутствие дублирующих ошибок, `describeSocketClose` |
| `voiceModeConfig.test.ts` | 8 | Стражи блокеров: `verify_jwt = false`, апгрейд даёт 426, модели не откатываются на снятые, сессия поднимается только по `setupComplete`, в кадре нет `mediaChunks` |
| **Итого** | **110** | |

**Не покрыто после Этапа 1:** edge-функция `gemini-live` (ротация, watchdog, auth) — проверяется только тестами конфигурации и `describeSocketClose` на клиенте; `VoiceModeOverlay` (Esc, кнопки); `useVoice` (диктовка). Ротация и watchdog пока проверяются чтением кода и ревью — их стоит покрыть Deno-тестами, когда появится отдельный CI для функций.

---

## 8. Что сделано хорошо (не сломать при доработках)

- **Ключ Gemini не попадает в браузер**, а `proxyInfo` синхронизирует `setup.model` с моделью в URL апстрима — иначе Google отверг бы setup.
- **Ресемплинг в AudioWorklet**, а не `new AudioContext({sampleRate: 16000})`: работает на Safari/iOS, где принудительная частота либо бросает, либо молча игнорируется. Антиалиасинг — скользящее среднее по окну децимации, а не «каждый третий сэмпл».
- **Пре-ролл и barge-in** закрывают две самые заметные болячки голосовых ассистентов: «проглотил начало фразы» и «тараторит поверх меня».
- **Саундборд декодирует mp3 заранее** и живёт на общей шине с речью: нет задержки fetch+decode в момент шутки, сфера реагирует и на голос, и на свисток, громкость одна.
- **Сфера** вынесена в чистый `drawOrbFrame`, тестируется без canvas, уважает `prefers-reduced-motion`, тон берёт из темы.
- **Локальный VAD** компенсирует отсутствие в Live API события «пользователь замолчал» — и не спамит `speech-start`.
- **Гигиена ресурсов:** `onended` снимает ноды с шины, `dispose()` чистит буферы, `cleanup()` идемпотентен и снимает `onclose` до `close()`, чтобы не уйти в рекурсию.

---

## 9. Находки

### P0 — блокеры живой проверки

#### P0-1. `gemini-live` не пройдёт платформенную проверку JWT — ИСПРАВЛЕНО

`supabase/config.toml` содержит `verify_jwt = false` для `chat`, `deepsearch`, `elevenlabs-stt`, `gemini-tts`, `image-search`, `dialog-tts` — и **не содержит записи для `gemini-live`**. По умолчанию Supabase требует валидный JWT в заголовке `Authorization`, а браузерный WebSocket заголовки выставлять не умеет; официальный гайд Supabase «Handling WebSockets» прямо говорит: «You can skip the default authorization header checks by explicitly providing `--no-verify-jwt`». Итог: платформа отклонит handshake до запуска кода, `useGeminiLive` покажет «Ошибка соединения» / «Сессия не поднялась», и это будет выглядеть как проблема Google, хотя дело в деплое.

**Фикс (применён):**

```toml
# supabase/config.toml
[functions.gemini-live]
verify_jwt = false
```

и обычный `supabase functions deploy gemini-live` (config.toml подхватится) либо разово `--no-verify-jwt`. Проверка после деплоя: `curl -i https://<project>.supabase.co/functions/v1/gemini-live` должен вернуть **426** `Expected WebSocket upgrade` (значит, функция достижима и вопрос только в upgrade), а не 401.

#### P0-2. Все модели в списке прокси сняты с эксплуатации — ИСПРАВЛЕНО

```ts
// supabase/functions/gemini-live/index.ts:6-10
const MODELS = [
  Deno.env.get("GEMINI_LIVE_MODEL") || "models/gemini-2.0-flash-live-001", // shut down 09.12.2025
  "models/gemini-live-2.5-flash-preview",                                  // shut down 09.12.2025
  "models/gemini-2.0-flash-exp",                                           // мёртвая ветка 2.0
];
```

Клиентский фолбэк `DEFAULT_LIVE_MODEL` (`src/types/gemini-live.ts:123`) — та же мёртвая модель.

Актуальные варианты на сентябрь 2026 (по официальному списку моделей и Live API reference):

| Модель | Когда брать |
| --- | --- |
| `models/gemini-3.1-flash-live-preview` | Рекомендуемая для новых голосовых сценариев: низкая задержка, `thinkingLevel` вместо `thinkingBudget`, 128k контекст; **синхронный** function calling — наш `play_sound` подходит |
| `models/gemini-2.5-flash-native-audio-preview-12-2025` | Если нужны proactive audio / affective dialog / асинхронные tool calls; но у сообщества есть открытые баги с преждевременным `turnComplete` |

**Фикс (применён):** дефолт — 3.1-live, 2.5 native audio — вторым номером; `GEMINI_API_KEYS`-независимое переопределение через `GEMINI_LIVE_MODEL` оставить; `DEFAULT_LIVE_MODEL` в типах синхронизировать со первым элементом списка.

```ts
const MODELS = [
  Deno.env.get("GEMINI_LIVE_MODEL") || "models/gemini-3.1-flash-live-preview",
  "models/gemini-2.5-flash-native-audio-preview-12-2025",
].filter((m, i, a) => a.indexOf(m) === i);
```

Мелочь на будущее: при переходе на 3.1 модель может присылать **несколько parts в одном событии** — клиент уже перебирает `modelTurn.parts` циклом, так что здесь всё готово.

### P1 — сломается в реальной эксплуатации

#### P1-3. `mediaChunks` — deprecated, надо `audio` — ИСПРАВЛЕНО

Референс Live API помечает `media_chunks` как `DEPRECATED: Use one of audio, video, or text instead` и предупреждает, что несколько `mediaChunks` в одном сообщении не поддерживаются (у нас один — поэтому работало).

**Фикс (применён):**

```ts
function audioChunkMessage(data: string): LiveRealtimeInputMessage {
  return { realtimeInput: { audio: { mimeType: INPUT_MIME_TYPE, data } } };
}
```

Заодно в `useGeminiLive.ts` появился экспорт `describeSocketClose(code, reason)` — единая точка правды о том, какие коды закрытия считать нормальными; на неё же опираются тесты.

#### P1-4. Нет управления сессией: она оборвётся сама

Live API ограничивает сессию по времени: **~15 минут аудио** и **~2 минуты аудио+видео** без сжатия контекста, **~10 минут на соединение** (даже с ресамплингом). Единственный рецепт от Google — `contextWindowCompression` + `sessionResumption` + обработка `goAway`. Сейчас не включено ничего: `goAway` и `sessionResumptionUpdate` игнорируются, а когда Google закроет соединение, пользователь увидит «Сессия закрыта» посреди фразы (см. также P1-5).

**Фикс (setup + обработчики):**

```ts
setup: {
  model: modelName,
  generationConfig: { responseModalities: ["AUDIO"], speechConfig: {…} },
  systemInstruction: {…}, tools: [{ functionDeclarations: [PLAY_SOUND_TOOL] }],
  sessionResumption: {},                                                   // → sessionResumptionUpdate.handle
  contextWindowCompression: { slidingWindow: { targetTokens: 16000 }, triggerTokens: 24000 },
  inputAudioTranscription: {},                                             // бонусом — транскрипция (roadmap)
  outputAudioTranscription: {},
}
```

- `serverContent.sessionResumptionUpdate.handle` → хранить в рефе, передавать при переподключении как `setup.sessionResumption.resumeHandle`.
- `goAway.timeLeft` → мягко предупредить в оверлее и пересоздать сессию с тем же `resumeHandle`.
- Токен резюмирования живёт 2 часа с момента последнего завершения сессии.

Заодно это закрывает пункт roadmap «Автопауза при уходе вкладки в фон»: на `visibilitychange` логично слать `audioStreamEnd` и ставить микрофон на паузу, а при возврате — продолжать.

#### P1-5. Ротация ключей/моделей в прокси не срабатывает в типичном случае — ИСПРАВЛЕНО

```ts
ws.onopen = () => { openedOnce = true; … }      // :66
ws.onerror = () => { if (!openedOnce) connect(); }   // :90-91
ws.onclose = (ev) => {
  if (!openedOnce) { connect(); return; }            // :95
  try { client.close(1000, ev.reason || "upstream closed"); } catch {}   // :96
};
```

Google почти всегда сначала принимает WS-апгрейд, а ошибку (неверный ключ, модель недоступна для ключа/региона, квота) присылает уже внутри или закрывает соединение **после** `onopen`. Тогда `openedOnce === true`, перебора следующей пары «модель × ключ» не будет, а клиент получит `close(1000)` — то есть `useGeminiLive` обработает это как **нормальное** завершение: `cleanup()` без ошибки, статус `disconnected`, никакого тоста. Диагностировать невозможно.

**Фикс (применён):** сессия считается поднятой только после `setupComplete`; добавлен watchdog `SETUP_TIMEOUT_MS = 6000`, который закрывает «молчащую» попытку и запускает следующую пару; причины отдаются клиенту фреймами `upstreamError` (все пары исчерпаны) и `sessionClosed` (Google закрыл рабочую сессию), а прокси закрывает сокет кодами 4408/4410. Клиент показывает причину и не дублирует тост, когда причина уже пришла фреймом.

Два подводных камня, найденных при реализации (закрыты там же): сокет, закрытый watchdog'ом, не должен запускать **вторую** ротацию — поэтому все обработчики апстрима начинаются с проверки `ws !== upstream`; а клиент обязан переслать `setup` на новый `proxyInfo`, иначе после ротации сессия осталась бы без конфигурации (`setupSentRef` сбрасывается в ветке `proxyInfo`). Оба случая покрыты тестами.

#### P1-6. Диалог не связан с чатом и не показывает транскрипцию

Ни `clientContent` с историей чата, ни сохранения реплик: голосовая сессия полностью эфемерна, а roadmap-пункт «синхронная транскрипция рядом со сферой» не начат. В API это почти бесплатно: `inputAudioTranscription`/`outputAudioTranscription` в setup, дальше поля `serverContent.inputTranscription.text` / `outputTranscription.text` (и `interimInputTranscription` для «живого» текста). Практический минимум: показывать пару последних реплик под сферой, а после `turnComplete` — опционально дописывать их в текущий чат.

#### P1-7. Mute и границы реплики: сервер не знает, что мы замолчали

`toggleMute()` только перестаёт слать кадры (`mutedRef` в `sendAudio`). При этом:

- Включили mute посреди фразы → серверный VAD «висит» в ожидании продолжения, модель не отвечает, пока пользователь не снимет mute (и тогда ответ приходит на давно сказанное).
- Выключили микрофон / закрыли оверлей → на сервер не уходит никакого сигнала конца речи.
- Микрофонный конвейер продолжает работать (и шуметь в анализаторе), хотя кадры никуда не идут.

В Live API для этого есть `realtimeInput.audioStreamEnd: true` (hybrid VAD) и/или полностью ручной режим `realtimeInputConfig.automaticActivityDetection: { disabled: true }` + `activityStart`/`activityEnd`. Для «звонка» естественнее оставить серверный VAD, но **досылать `audioStreamEnd`** при mute, при уходе вкладки в фон и при `cleanup()`.

#### P1-8. Риск само-перебивания из-за саундборда

Эффекты играют с громкостью 0.9 в колонки того же устройства, а микрофон открыт. `echoCancellation: true` помогает не всегда (речь модели + громкий хохот при AGC могут распознаться как активность пользователя) → модель перебьёт саму себя или оборвёт хохот своим же `interrupted`. Google в best practices прямо советует наушники. Минимум — предупреждение в оверлее; надёжнее — приглушать вход (не слать кадры) на время звучания эффекта или выставлять `startOfSpeechSensitivity` пониже.

### P2 — качество и устойчивость

| # | Находка | Где | Что сделать |
| --- | --- | --- | --- |
| P2-9 | **Safari/iOS-риск жеста.** `connect()` создаёт `AudioPlaybackEngine` и микрофонный `AudioContext` **после** `await cleanup()` и `await getSession()`. Safari теряет «жест пользователя» на await, контекст может остаться `suspended` | `useGeminiLive.ts:188-232` (движок — :208, микрофонный контекст — :227) | создать и `resume()` оба контекста синхронно в обработчике клика, а в хук передавать готовые (`AudioPlaybackEngineOptions.audioContext` уже есть) |
| P2-10 | **Заявленный разброс темпа не реализован.** `PlayOptions.playbackRate` документирован как «0.95..1.05, чтобы хохот не звучал одинаково», но `play()` подставляет ровно `options.playbackRate ?? 1`, а хук вызывает `play(soundName)` без опций | `soundboard.ts:29-35, 141`; `useGeminiLive.ts:420` | либо рандомить в `play()` по умолчанию, либо убрать обещание из док-комментария |
| P2-11 | **Настройка «Звуковые эффекты» не влияет на голосовой режим.** `soundsEnabled` относится только к send/receive-блипам | `SettingsPanel`/`useChat` vs саундборд | прокидывать флаг в `useGeminiLive` и уважать его в `play()` |
| P2-12 | **Ёмкость движка не выведена в UI:** `setVolume()`, `queuedSeconds`, `loadedCount`, `isLoaded()` не используются нигде, кроме тестов | `audioEngine.ts:119-127, 136`; `soundboard.ts:67-77` | добавить громкость/индикатор очереди в оверлей — код уже готов |
| P2-13 | **Хвост записи выбрасывается.** В `cleanup()` после `flush` сразу снимается `port.onmessage`, поэтому последние <32 мс теряются | `useGeminiLive.ts:130-134` | отложить снятие обработчика или забрать кадр промисом |
| P2-14 | **JWT в query-параметре.** Токен длиной в килобайты уходит в логи edge-функции и может попасть в трейсы. Нет проверки `Origin` и лимитов на пользователя | `useGeminiLive.ts:268`; `gemini-live/index.ts:28-38` | передавать токен сабпротоколом (`Sec-WebSocket-Protocol`, официально упомянутый вариант), добавить allow-list origin и простой rate-limit; стратегически — ephemeral tokens |
| P2-15 | **Мёртвый фолбэк.** `DEFAULT_LIVE_MODEL` + таймер на 2 с существуют «на случай прокси без proxyInfo», но такая версия прокси уже неактуальна сама по себе | `types:123`, `useGeminiLive.ts:18-19` | либо обновить модель, либо удалить фолбэк и падать с понятной ошибкой |
| P2-16 | **Нет тестов на хук и прокси** — самая ветвистая логика без покрытия | `useGeminiLive`, `supabase/functions/gemini-live` | фейковый `WebSocket` + `getUserMedia` + worklet: пре-ролл, toolCall-ответ, mute, ошибки |
| P2-17 | **Голосов меньше, чем поддерживает API.** В `LIVE_VOICE_NAMES` 5 имён, `Leda` (есть в списке 30 голосов Gemini) принудительно подменяется на `Aoede` | `types:17-30` | расширить список и/или сделать отдельный селектор Live-голоса (пункт roadmap) |
| P2-18 | **Не задан `speechConfig.languageCode`.** Диалог русский, инструкция русская, а язык голоса выбирается автоматически | `types:VOICE_SYSTEM_INSTRUCTION` | задать `languageCode: "ru-RU"` и проверить на 3.1-live (**проверить**: для native audio поведение может отличаться) |

### P3 — мелочи

- `VOICE_SYSTEM_INSTRUCTION` не просит модель произносить команды саундборда «параллельно» с корректной грамматикой пауз (сейчас «Издавай вздохи (*вздыхает*)») — на native audio это работает, на 3.1 может читаться вслух буквально.
- Кнопка диктовки (`useVoice`) и кнопка голосового режима стоят рядом и визуально похожи (Mic vs AudioLines).
- Весь UI приложения — один чанк 845 кБ; оверлей и хук можно грузить лениво (`React.lazy`), как уже сделано для дев-стенда.
- `.env` в репозитории — только публичный anon-ключ, утечки нет, но привычка плохая; секреты (`GEMINI_API_KEYS`, `ELEVENLABS_API_KEY`, `LOVABLE_API_KEY`) хранятся в Supabase — это правильно.
- `useVoice` (диктовка) при неподдерживаемом `MediaRecorder` никак об этом не сообщает: `recorder.start()` бросит исключение в консоль, пользователь не увидит ничего.

---

## 10. План работ

**Шаг 1 (деплой, 15 минут) — СДЕЛАНО в коде.** `[functions.gemini-live] verify_jwt = false` добавлен в `config.toml`; дефолтная модель обновлена; тесты-стражи не дадут откатить.
Осталось выполнить на проекте: `supabase functions deploy gemini-live` → при желании `supabase secrets set GEMINI_LIVE_MODEL=models/…` → `curl -i` (ждём 426) → живой прогон.

**Шаг 2 (совместимость с текущим API) — СДЕЛАНО частично.** Модели обновлены, `mediaChunks` → `audio`, причины ошибок доезжают до UI.
Осталось: `inputAudioTranscription`/`outputAudioTranscription` + вывод текста под сферой (roadmap-пункт 1) и `audioStreamEnd` при mute/фоне/закрытии.

**Шаг 3 (долгие сессии, ~день).** `sessionResumption` + `contextWindowCompression`; обработка `goAway`/`sessionResumptionUpdate`; корректная трансляция ошибок апстрима в `proxyError`; ротация с условием «`setupComplete` не пришёл за N секунд».

**Шаг 4 (продукт).** Отдельный селектор Live-голоса (roadmap-пункт 3) + расширенный список голосов; громкость и индикатор очереди в оверлее из уже готового API движка; уважение `soundsEnabled`; рандомизация темпа саундборда.

**Шаг 5 (надёжность).** Тесты на `useGeminiLive` с фейковым WebSocket; создание AudioContext в жесте пользователя для Safari; сабпротокол вместо `?token=`.

---

## 11. Чек-лист живой проверки (когда есть ключи)

1. `GEMINI_API_KEYS` — ключ(и) AI Studio с доступом к Live API; `GEMINI_LIVE_MODEL` — при желании переопределить дефолт.
2. Задеплоить функцию и убедиться, что `[functions.gemini-live] verify_jwt = false` уехало вместе с кодом (иначе платформа отклонит рукопожатие до входа в функцию).
3. `curl -i .../functions/v1/gemini-live` → **426**, не 401.
4. Войти в аккаунт (без JWT режим сознательно не работает), нажать `AudioLines` → звёздочка в кнопке, оверлей, сфера синяя.
5. «Слушаю…» → говорите: сфера реагирует на вас кольцом, после паузы — «Думаю…», затем «Говорю…».
6. Перебивание: начать говорить во время ответа — речь должна оборваться в течение ~20 мс, без щелчка.
7. Саундборд: спровоцировать шутку/фактическую ошибку → вспышка названия эффекта в оверлее + звук поверх речи; на перебивании хохот тоже должен замолкать.
8. Mute → микрофон не идёт на сервер; речь модели слышна.
9. Негативный сценарий: подставить заведомо неверный `GEMINI_API_KEYS` → оверлей должен показать причину («Голосовая сессия не поднялась: …»), а не «Сессия закрыта».
10. Долгий сеанс (>10 минут) — сейчас ожидаемо оборвётся с честным сообщением; после Этапа 3 должен продолжиться.
11. Safari/iOS: проверить, что звук вообще стартует после клика (см. P2-9).
12. Наушники — иначе риск само-перебивания (P1-8).

---

## 12. Источники

- Gemini API changelog — отключение `gemini-2.0-flash-live-001` и `gemini-live-2.5-flash-preview` 09.12.2025: <https://ai.google.dev/gemini-api/docs/changelog>
- Актуальные модели Live (3.1 Flash Live, 2.5 Flash Live, 3.5 Live Translate): <https://ai.google.dev/gemini-api/docs/models>
- Live API — WebSocket-референс: `mediaChunks` deprecated, `audio`, `activityStart/End`, `AudioTranscriptionConfig`, session resumption, ephemeral tokens: <https://ai.google.dev/api/live>
- Live API best practices — лимиты сессии, компрессия контекста, `goAway`, резюмирование: <https://ai.google.dev/gemini-api/docs/live-api/best-practices>
- Live API capabilities guide — транскрипция, `audioStreamEnd`, VAD: <https://ai.google.dev/gemini-api/docs/live-guide>
- Supabase, Handling WebSockets — «skip the default authorization header checks … `--no-verify-jwt`»: <https://supabase.com/docs/guides/functions/websockets>
- Supabase CLI config — `functions.<name>.verify_jwt`, по умолчанию `true`: <https://supabase.com/docs/guides/cli/config>
