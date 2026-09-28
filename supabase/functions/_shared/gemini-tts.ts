/**
 * Gemini: сборка запросов TTS и анализ ответов.
 *
 * Модуль намеренно чистый (никаких Deno/Node API, кроме глобальных
 * `atob`/`btoa`, которые есть и в Deno, и в Node ≥16, и в браузере):
 * его импортируют ОБА исполнителя — edge-функция `gemini-proxy` (прод) и
 * dev-middleware `/api/gemini/*` в `vite.config.ts` (`npm run dev`), — а тесты
 * дергают его напрямую через vite-SSR. Одна копия формы запроса = прод и dev
 * не разъезжаются.
 *
 * ── Что здесь важно знать про Gemini TTS (доки, сентябрь 2026) ──────────────
 *
 * 1. Модель `gemini-3.8-flash-tts` — GA-замена `gemini-2.5-flash-preview-tts`
 *    (тот остался только у тех, кто им уже пользовался; в докáх помечен как
 *    legacy, для новых проектов рекомендуют 3.8).
 * 2. Аудио приходит ровно туда же, куда и раньше:
 *    `candidates[0].content.parts[0].inlineData.data` (base64 PCM 24 kHz mono
 *    16-bit), поэтому клиент (`src/data/gemini.ts`) не меняется.
 * 3. Multi-speaker режим — максимум ДВА голоса на запрос. Каждая реплика идёт
 *    отдельным `part` с `speech_metadata.speaker`, а голоса — в
 *    `generationConfig.speechConfig.multiSpeakerVoiceConfig.speakerVoiceConfigs`
 *    (`voiceConfig.prebuiltVoiceConfig.voiceName`, поле не переименовано).
 *    Больше двух персонажей → несколько запросов и склейка PCM (см.
 *    `planTtsRequests` + `mergeTtsAudio`).
 * 4. Ключ передаётся заголовком `x-goog-api-key`, а НЕ `?key=`: новые
 *    auth-ключи (`AQ.…`) с query-параметром не работают вовсе (Google отдаёт
 *    404). Работает и для старых `AIza…`, поэтому ветки «если ключ старый» нет.
 *
 * 5. Секция `dialog-tts` внизу — второй сценарий озвучки: на вход готовая
 *    расшифровка `Speaker N: текст`, на выход один WAV (см. комментарий у
 *    секции). Она использует свою TTS-модель (`DIALOG_TTS_MODEL`) и не
 *    трогает чанковый план глав выше.
 *
 * Плейнтекст ключа сюда не приходит: модуль получает уже готовый apiKey от
 * вызывающего кода и никогда его не логирует/не возвращает.
 */

/** База REST: `<base>/<model>:generateContent`. */
export const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Vision-модель для анализа страниц (`/analyze`). */
export const GEMINI_ANALYZE_MODEL = 'gemini-3.8-flash';

/** TTS-модель (`/tts`). GA, без суффикса `-preview`. */
export const GEMINI_TTS_MODEL = 'gemini-3.8-flash-tts';

/** Жёсткий лимит Gemini TTS: в multi-speaker режиме максимум 2 голоса. */
export const TTS_MAX_SPEAKERS_PER_REQUEST = 2;

/**
 * Сколько запросов разрешено на одну озвучку. Каждый запрос — это отдельный
 * вызов Gemini (5–20 с); без потолка глава с десятком персонажей упрётся в
 * wall-clock edge-функции. 8 чанков × 2 голоса = 16 персонажей, дальше честная
 * ошибка вместо таймаута в 150 с.
 */
export const TTS_MAX_REQUESTS = 8;

/** Голоса по умолчанию: разные тембры, чтобы диалог не сливался в один голос. */
export const DEFAULT_TTS_VOICES = ['Kore', 'Puck'] as const;

/** Голос, если персонаж в главе один. */
export const SINGLE_SPEAKER_TTS_VOICE = 'Kore';

/** Имя говорящего по умолчанию — как в analyzer и в UI (`line.speaker`). */
export const DEFAULT_SPEAKER = 'Narrator';

/**
 * 30 prebuilt-голосов Gemini TTS (доки: speech-generation → Voice options).
 * Список нужен, чтобы не отправить в API опечатку из UI: неизвестное имя
 * Gemini отклоняет 400-й ошибкой, а мы тихо откатываемся на дефолт.
 */
export const PREBUILT_TTS_VOICES = [
  'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda',
  'Orus', 'Aoede', 'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus',
  'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi',
  'Laomedeia', 'Achernar', 'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima',
  'Achird', 'Zubenelgenubi', 'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat',
] as const;

const VOICE_SET = new Set<string>(PREBUILT_TTS_VOICES);

/** Коды ошибок сборки плана — исполнители мапят их в HTTP-статусы. */
export type TtsPlanErrorCode = 'tts_no_lines' | 'tts_too_many_requests';

export class TtsPlanError extends Error {
  readonly code: TtsPlanErrorCode;

  constructor(code: TtsPlanErrorCode, message: string) {
    super(message);
    this.name = 'TtsPlanError';
    this.code = code;
  }
}

export interface TtsLine {
  speaker?: string | null;
  text?: string | null;
}

export interface TtsRequestPlan {
  /** Уникальные персонажи чанка — 1 или 2 (лимит Gemini). */
  speakers: string[];
  /** speaker → voiceName, по одному на каждого персонажа чанка. */
  voices: Record<string, string>;
  /** Готовое тело POST-запроса (форма generateContent). */
  body: Record<string, unknown>;
}

/** Голос из UI принимаем только если он есть в списке prebuilt; иначе null. */
export function normalizeTtsVoice(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const value = name.trim();
  if (!value) return null;
  // Регистр в API значим, но в UI люди пишут «kore» — приведём к канону.
  const canonical = [...VOICE_SET].find((voice) => voice.toLowerCase() === value.toLowerCase());
  return canonical ?? null;
}

function speakerOf(line: TtsLine): string {
  return (line?.speaker ?? '').toString().trim() || DEFAULT_SPEAKER;
}

function textOf(line: TtsLine): string {
  return (line?.text ?? '').toString().trim();
}

/**
 * План запросов к Gemini TTS.
 *
 * Алгоритм:
 *  1. Пустые реплики выбрасываем (Gemini на пустой `part` спотыкается, а
 *     платить за них нечем).
 *  2. Голоса: `voiceMap[speaker]` (если это валидный prebuilt-голос) → иначе
 *     дефолт по порядку появления персонажа (Kore / Puck / Kore…), так один и
 *     тот же персонаж звучит одинаково во всех чанках.
 *  3. Реплики идут по порядку, чанк набирает максимум 2 персонажа; реплика
 *     третьего персонажа начинает новый чанк. Порядок и текст реплик при этом
 *     не меняются — склейка PCM (mergeTtsAudio) даёт ту же последовательность,
 *     что и однослотовый запрос.
 *
 * @throws {TtsPlanError} `tts_no_lines` — все реплики пустые;
 *                         `tts_too_many_requests` — персонажей больше, чем
 *                         влезает в TTS_MAX_REQUESTS запросов.
 */
export function planTtsRequests(
  lines: readonly TtsLine[] | null | undefined,
  voiceMap: Record<string, string> | null | undefined = {}
): TtsRequestPlan[] {
  const usable = (Array.isArray(lines) ? lines : []).filter((line) => textOf(line).length > 0);

  if (usable.length === 0) {
    throw new TtsPlanError('tts_no_lines', 'Нет непустых реплик для озвучки');
  }

  // Голос персонажа фиксируем глобально: валидный из voiceMap, иначе дефолт по
  // порядку первого появления.
  const voices: Record<string, string> = {};
  let defaults = 0;

  const voiceFor = (speaker: string): string => {
    if (voices[speaker]) return voices[speaker];
    const fromMap = normalizeTtsVoice(voiceMap?.[speaker]);
    const assigned = fromMap
      ?? DEFAULT_TTS_VOICES[defaults++ % DEFAULT_TTS_VOICES.length]
      ?? SINGLE_SPEAKER_TTS_VOICE;
    voices[speaker] = assigned;
    return assigned;
  };

  const groups: { speakers: string[]; lines: TtsLine[] }[] = [];

  for (const line of usable) {
    const speaker = speakerOf(line);
    let group = groups[groups.length - 1];

    if (!group || (!group.speakers.includes(speaker) && group.speakers.length >= TTS_MAX_SPEAKERS_PER_REQUEST)) {
      group = { speakers: [], lines: [] };
      groups.push(group);
    }

    if (!group.speakers.includes(speaker)) group.speakers.push(speaker);
    group.lines.push(line);
  }

  if (groups.length > TTS_MAX_REQUESTS) {
    throw new TtsPlanError(
      'tts_too_many_requests',
      `Слишком много персонажей для одной озвучки: нужно ${groups.length} запросов к Gemini TTS, ` +
        `лимит — ${TTS_MAX_REQUESTS} (по ${TTS_MAX_SPEAKERS_PER_REQUEST} голоса в каждом). ` +
        'Сократите число говорящих или озвучьте главу частями.'
    );
  }

  return groups.map((group) => {
    const groupVoices: Record<string, string> = {};
    for (const speaker of group.speakers) groupVoices[speaker] = voiceFor(speaker);

    const isSingleSpeaker = group.speakers.length === 1;

    // Каждая реплика — отдельный part; в multi-speaker режиме к нему
    // прикладывается speech_metadata.speaker, по которому Gemini выбирает
    // голос. В single-speaker режиме `speaker` не передаём: там атрибуция не
    // нужна, а лишнее поле — повод для 400.
    const parts = group.lines.map((line) =>
      isSingleSpeaker
        ? { text: textOf(line) }
        : { text: textOf(line), speech_metadata: { speaker: speakerOf(line) } }
    );

    return {
      speakers: [...group.speakers],
      voices: groupVoices,
      body: {
        contents: [{ role: 'user', parts }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: isSingleSpeaker
            ? {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: groupVoices[group.speakers[0]] },
                },
              }
            : {
                multiSpeakerVoiceConfig: {
                  speakerVoiceConfigs: group.speakers.map((speaker) => ({
                    speaker,
                    voiceConfig: {
                      prebuiltVoiceConfig: { voiceName: groupVoices[speaker] },
                    },
                  })),
                },
              },
        },
      },
    };
  });
}

/** URL конкретной модели: `<base>/<model>:generateContent`. */
export function geminiEndpoint(model: string): string {
  return `${GEMINI_API_BASE}/${model}:generateContent`;
}

/**
 * Заголовки запроса к Gemini. Ключ — только в `x-goog-api-key`: новые
 * auth-ключи (`AQ.…`) с `?key=` отдают 404, и даже для старых `AIza…` так
 * ключ не оседает в URL-логах/прокси.
 */
export function geminiHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-goog-api-key': apiKey,
  };
}

function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/\s+/g, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  // Чанками: String.fromCharCode(...bytes) на мегабайтах переполняет стек.
  const STEP = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += STEP) {
    binary += String.fromCharCode(...bytes.subarray(i, i + STEP));
  }
  return btoa(binary);
}

/**
 * Склейка PCM-аудио нескольких ответов Gemini в один base64.
 * Все чанки — 24 kHz mono 16-bit PCM, поэтому «сложить байты» == «сложить
 * звук по времени»: клиент оборачивает результат в один WAV.
 */
export function mergeTtsAudio(chunks: readonly string[]): string {
  const decoded = chunks.filter((chunk) => typeof chunk === 'string' && chunk.length > 0);
  if (decoded.length === 0) return '';
  if (decoded.length === 1) return decoded[0].replace(/\s+/g, '');

  const parts = decoded.map((chunk) => base64ToBytes(chunk));
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const merged = new Uint8Array(total);

  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }

  return bytesToBase64(merged);
}

/** Достаёт base64-аудио из ответа Gemini (`inlineData.data`). */
export function extractTtsAudio(payload: unknown): string | null {
  const data = (payload as { candidates?: { content?: { parts?: { inlineData?: { data?: string } }[] } }[] })
    ?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  return typeof data === 'string' && data.length > 0 ? data : null;
}

/**
 * Ответ `/tts` в той же форме, что отдаёт Gemini: клиент читает
 * `candidates[0].content.parts[0].inlineData.data` и не знает, сколько было
 * запросов. `modelVersion` оставляем своим, он не парсится.
 */
export function buildTtsResponse(audioBase64: string, model = GEMINI_TTS_MODEL): Record<string, unknown> {
  return {
    candidates: [
      {
        content: {
          role: 'model',
          parts: [
            {
              inlineData: {
                mimeType: 'audio/L16;codec=pcm;rate=24000',
                data: audioBase64,
              },
            },
          ],
        },
        finishReason: 'STOP',
      },
    ],
    modelVersion: model,
  };
}

/**
 * Человекочитаемое сообщение об ошибке Gemini из тела ответа.
 * Ключ никогда не попадает в текст (в телах Google его и нет).
 */
export function geminiErrorMessage(payload: unknown, fallback: string): string {
  const error = (payload as { error?: { message?: string; status?: string } } | null)?.error;
  const message = typeof error?.message === 'string' ? error.message.trim() : '';
  if (message) return message;
  const status = typeof error?.status === 'string' ? error.status.trim() : '';
  return status ? `${fallback} (${status})` : fallback;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * dialog-tts: озвучка расшифровки диалога (edge-функция `dialog-tts`).
 *
 * Тот же Gemini TTS, но другой сценарий: на вход приходит ГОТОВАЯ расшифровка
 * с префиксами `Speaker N:` (её отдаёт AI-анализ страниц), а на выход —
 * один WAV-файл. Логика режется по числу спикеров:
 *
 *   1 спикер  — один запрос, `speechConfig.voiceConfig`;
 *   2 спикера — один запрос, `multiSpeakerVoiceConfig` c именами ровно
 *               `Speaker 1` / `Speaker 2` (Gemini матчит их с префиксами
 *               в тексте, поэтому строки должны совпадать буквально);
 *   3+        — по одному запросу на реплику, ПОСЛЕДОВАТЕЛЬНО (один ключ на
 *               аккаунт → параллельные вызовы упираются в rate limit),
 *               `parts[0].text` — только текст реплики, без префикса.
 *
 * Ответы приходят сырым PCM (24 kHz mono 16-bit) без RIFF-заголовка, но
 * бывает и WAV с заголовком — поэтому байты сначала нормализуются
 * (`readRiffAudio`), склеиваются с паузами 220 мс и оборачиваются в один
 * WAV (`pcmToWav`). Ни частоты, ни алгоритм склейки не дублируются в
 * edge-функции: она только вызывает эти функции (см. dialog-tts/index.ts).
 * ═══════════════════════════════════════════════════════════════════════════ */

/** TTS-модель диалогов: своя, отдельная от глав (GEMINI_TTS_MODEL). */
export const DIALOG_TTS_MODEL = 'gemini-3.1-flash-tts-preview';

/**
 * Голоса dialog-tts — 8 тембров, по одному на спикера (больше 8 спикеров
 * функция всё равно отклоняет). Все имена есть в списке prebuilt-голосов Gemini;
 * неизвестное имя Gemini отклоняет 400-й ошибкой, поэтому здесь белый список,
 * а не «что передал клиент».
 */
export const DIALOG_TTS_VOICES = [
  'Charon', 'Kore', 'Puck', 'Aoede', 'Fenrir', 'Leda', 'Zephyr', 'Orus',
] as const;

/** Лимиты dialog-tts: они же — контракт ошибок 400 (см. таблицу в ТЗ/доках). */
export const DIALOG_TTS_LIMITS = {
  /** Обрезка расшифровки до запроса (символы). */
  maxChars: 6000,
  /** Максимум разных спикеров. */
  maxSpeakers: 8,
  /** Максимум реплик в режиме 3+ спикеров (каждая реплика = запрос). */
  maxReplies: 40,
  /** Тишина между репликами при склейке WAV, мс. */
  pauseMs: 220,
  /** Формат по умолчанию, если Gemini не назвал его ни в mimeType, ни в RIFF. */
  sampleRate: 24000,
  channels: 1,
  bitsPerSample: 16,
} as const;

/** Коды ошибок входа: edge-функция отдаёт их как 400 + текст на русском. */
export type DialogTtsErrorCode =
  | 'empty_text'
  | 'no_lines'
  | 'too_many_speakers'
  | 'too_many_replies';

export class DialogTtsError extends Error {
  readonly code: DialogTtsErrorCode;

  constructor(code: DialogTtsErrorCode, message: string) {
    super(message);
    this.name = 'DialogTtsError';
    this.code = code;
  }
}

export interface DialogLine {
  /** Номер спикера из префикса `Speaker N:` (1…N). */
  speaker: number;
  text: string;
}

/** Префикс реплики. Строки без него — продолжение предыдущей реплики. */
const DIALOG_LINE_RE = /^Speaker\s+(\d+)\s*:\s*(.*)$/;

/**
 * Парсит расшифровку в реплики.
 *
 *  - `trim()` до проверки: пустой/пробельный текст → `empty_text` («Текст пуст»);
 *  - обрезка до 6000 символов ДО построчного разбора — лимит на запрос к Gemini,
 *    а не на то, что успел прислать браузер;
 *  - строки без `Speaker N:` приклеиваются к предыдущей реплике через пробел
 *    (модель анализа часто переносит длинную реплику на две строки);
 *  - строки до первой реплики игнорируются (заголовок, служебные пометки).
 *
 * @throws {DialogTtsError} `empty_text` | `no_lines` | `too_many_speakers` | `too_many_replies`
 */
export function parseDialogTranscript(raw: unknown): DialogLine[] {
  const transcript = typeof raw === 'string' ? raw.trim() : '';
  if (!transcript) {
    throw new DialogTtsError('empty_text', 'Текст пуст');
  }

  const lines: DialogLine[] = [];
  for (const rawLine of transcript.slice(0, DIALOG_TTS_LIMITS.maxChars).split(/\r?\n/)) {
    const match = rawLine.match(DIALOG_LINE_RE);
    if (match) {
      lines.push({ speaker: Number(match[1]), text: match[2].trim() });
      continue;
    }

    const continuation = rawLine.trim();
    const last = lines[lines.length - 1];
    if (!last || !continuation) continue;
    last.text = last.text ? `${last.text} ${continuation}` : continuation;
  }

  if (lines.length === 0) {
    throw new DialogTtsError('no_lines', 'Не найдено реплик');
  }

  const speakers = new Set(lines.map((line) => line.speaker));
  if (speakers.size > DIALOG_TTS_LIMITS.maxSpeakers) {
    throw new DialogTtsError(
      'too_many_speakers',
      `Слишком много спикеров (макс. ${DIALOG_TTS_LIMITS.maxSpeakers})`
    );
  }

  // Лимит реплик защищает только режим 3+: там каждая реплика — отдельный
  // последовательный запрос к Gemini, и 40 реплик уже близко к таймауту
  // edge-функции. Один-два спикера укладываются в один запрос, им лимит не нужен.
  if (speakers.size > 2 && lines.length > DIALOG_TTS_LIMITS.maxReplies) {
    throw new DialogTtsError(
      'too_many_replies',
      `Слишком много реплик (макс. ${DIALOG_TTS_LIMITS.maxReplies})`
    );
  }

  return lines;
}

/** Голос из `voices` принимаем только если он есть в белом списке; иначе null. */
export function normalizeDialogVoice(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const value = name.trim();
  if (!value) return null;
  const canonical = DIALOG_TTS_VOICES.find((voice) => voice.toLowerCase() === value.toLowerCase());
  return canonical ?? null;
}

/** Номера спикеров по порядку появления (стабильный порядок, без дублей). */
export function dialogSpeakers(lines: readonly DialogLine[]): number[] {
  const seen: number[] = [];
  for (const line of lines) {
    if (!seen.includes(line.speaker)) seen.push(line.speaker);
  }
  return seen;
}

/**
 * Раскладывает 8 голосов по спикерам: сначала явные (и валидные) имена из
 * клиентского `voices`, остальным — по кругу (speaker 1 → Charon, 2 → Kore,
 * 3 → Puck…), пропуская уже занятые. Один голос не повторяется у двух
 * спикеров: иначе диалог звучит как монолог.
 */
export function resolveDialogVoices(
  lines: readonly DialogLine[],
  voices: Record<string, unknown> | null | undefined = {}
): Record<number, string> {
  const speakers = dialogSpeakers(lines);
  const used = new Set<string>();
  const resolved = new Map<number, string>();

  for (const speaker of speakers) {
    const requested = normalizeDialogVoice(voices?.[String(speaker)]);
    if (requested && !used.has(requested)) {
      resolved.set(speaker, requested);
      used.add(requested);
    }
  }

  for (const speaker of speakers) {
    if (resolved.has(speaker)) continue;

    // Позиция в круге считается по номеру спикера: 1 → Charon, 2 → Kore…
    // Номер может быть любым (модель нумерует как хочет), поэтому берём
    // остаток, а не индекс в массиве реплик.
    const start = Math.abs(speaker - 1) % DIALOG_TTS_VOICES.length;
    let picked = DIALOG_TTS_VOICES[start];
    for (let step = 0; step < DIALOG_TTS_VOICES.length; step += 1) {
      const candidate = DIALOG_TTS_VOICES[(start + step) % DIALOG_TTS_VOICES.length];
      if (!used.has(candidate)) {
        picked = candidate;
        break;
      }
    }

    resolved.set(speaker, picked);
    used.add(picked);
  }

  const result: Record<number, string> = {};
  for (const speaker of speakers) result[speaker] = resolved.get(speaker) as string;
  return result;
}

/** Режим запроса к Gemini: 1 спикер, ровно 2, 3+. */
export type DialogTtsMode = 'single' | 'duet' | 'multi';

export interface DialogTtsRequest {
  /** Кому принадлежит аудио этой реплики (для логов/склейки). */
  speaker: number;
  voice: string;
  /** Текст, который реально уходит в Gemini (с префиксом или без). */
  text: string;
  /** Готовое тело POST-запроса (форма generateContent). */
  body: Record<string, unknown>;
}

export interface DialogTtsPlan {
  mode: DialogTtsMode;
  /** speaker → voiceName. */
  voices: Record<number, string>;
  /** Порядок запросов = порядок реплик; режим 3+ — по одному на реплику. */
  requests: DialogTtsRequest[];
}

/** Сборка `contents` для одного текста с одним голосом (single / multi). */
function singleVoiceBody(text: string, voice: string): Record<string, unknown> {
  return {
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
  };
}

/**
 * План запросов к Gemini TTS для расшифровки диалога.
 *
 * Текст всегда склеивается с префиксами `Speaker N:` — и в single, и в duet
 * режиме Gemini ждёт именно «транскрипт», а в режиме 3+ префикс не нужен:
 * там на каждую реплику отдельный запрос со своим единственным голосом.
 */
export function planDialogTts(
  lines: readonly DialogLine[],
  voices: Record<string, unknown> | null | undefined = {}
): DialogTtsPlan {
  const speakers = dialogSpeakers(lines);
  const resolved = resolveDialogVoices(lines, voices);
  const mode: DialogTtsMode = speakers.length > 2 ? 'multi' : speakers.length === 2 ? 'duet' : 'single';

  // Пустые реплики (`Speaker 2:` без текста) в запрос не идут: это либо
  // продолжение предыдущей, либо мусор, а Gemini на пустой текст отвечает
  // ошибкой. Если ничего не осталось — это те же «нет реплик», что и у
  // транскрипта без префиксов.
  const spoken = lines.filter((line) => line.text.length > 0);
  if (spoken.length === 0) {
    throw new DialogTtsError('no_lines', 'Не найдено реплик');
  }

  if (mode === 'multi') {
    return {
      mode,
      voices: resolved,
      requests: spoken.map((line) => ({
        speaker: line.speaker,
        voice: resolved[line.speaker],
        text: line.text,
        body: singleVoiceBody(line.text, resolved[line.speaker]),
      })),
    };
  }

  // Заголовок `## Transcript:` — конвенция промптинга Gemini TTS: модель
  // понимает, что дальше идёт расшифровка диалога, и не озвучивает
  // служебные префиксы как часть текста.
  const transcript = `## Transcript:\n${spoken
    .map((line) => `Speaker ${line.speaker}: ${line.text}`)
    .join('\n')}`;

  if (mode === 'single') {
    const speaker = speakers[0];
    const voice = resolved[speaker];
    return {
      mode,
      voices: resolved,
      requests: [
        { speaker, voice, text: transcript, body: singleVoiceBody(transcript, voice) },
      ],
    };
  }

  const [first, second] = speakers as [number, number];
  return {
    mode,
    voices: resolved,
    requests: [
      {
        speaker: first,
        voice: resolved[first],
        text: transcript,
        body: {
          contents: [{ parts: [{ text: transcript }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              multiSpeakerVoiceConfig: {
                // Имена спикеров обязаны буквально совпадать с префиксами в
                // транскрипте — иначе Gemini не понимает, кто говорит.
                speakerVoiceConfigs: [first, second].map((speaker) => ({
                  speaker: `Speaker ${speaker}`,
                  voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: resolved[speaker] },
                  },
                })),
              },
            },
          },
        },
      },
    ],
  };
}

/* ── Аудио: формат, RIFF и сборка WAV ─────────────────────────────────────── */

export interface AudioFormat {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

/** Формат асинхронного аудио Gemini по умолчанию: 24 kHz mono 16-bit PCM. */
export const DEFAULT_PCM_FORMAT: AudioFormat = {
  sampleRate: DIALOG_TTS_LIMITS.sampleRate,
  channels: DIALOG_TTS_LIMITS.channels,
  bitsPerSample: DIALOG_TTS_LIMITS.bitsPerSample,
};

/** Аудио из ответа Gemini: base64 + mimeType (обычно `audio/L16; rate=24000`). */
export interface InlineAudio {
  data: string;
  mimeType: string;
}

/**
 * Достаёт base64-аудио вместе с mimeType.
 *
 * `extractTtsAudio` отдаёт только data — для gemini-proxy этого хватало
 * (клиент оборачивает PCM сам), а dialog-tts нужен ещё и mimeType: частота
 * дискретизации и число каналов берутся именно оттуда.
 */
export function extractInlineAudio(payload: unknown): InlineAudio | null {
  const inline = (payload as {
    candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] } }[];
  })?.candidates?.[0]?.content?.parts?.[0]?.inlineData;

  const data = typeof inline?.data === 'string' ? inline.data : '';
  if (!data) return null;

  return {
    data,
    mimeType: typeof inline?.mimeType === 'string' ? inline.mimeType : '',
  };
}

/**
 * Разбор mimeType аудио Gemini: `audio/L16; codec=pcm; rate=24000`,
 * `audio/wav`, `audio/pcm;rate=24000` и т.п. Неизвестные части остаются
 * undefined — вызывающий подставит дефолт.
 */
export function parseAudioFormat(mimeType: unknown): Partial<AudioFormat> {
  if (typeof mimeType !== 'string' || !mimeType) return {};

  const format: Partial<AudioFormat> = {};
  const rate = mimeType.match(/rate\s*=\s*(\d+)/i);
  if (rate) format.sampleRate = Number(rate[1]);

  const channels = mimeType.match(/channels?\s*=\s*(\d+)/i);
  if (channels) format.channels = Number(channels[1]);

  const subtype = mimeType.match(/audio\/([a-z0-9.+-]+)/i)?.[1]?.toLowerCase() ?? '';
  if (subtype === 'l16') format.bitsPerSample = 16;
  else if (subtype === 'l8') format.bitsPerSample = 8;
  else if (subtype === 'l24') format.bitsPerSample = 24;

  return format;
}

/** RIFF/WAVE-заголовок всегда 44 байта (fmt 16 + data) — столько же и пишем. */
const WAV_HEADER_BYTES = 44;

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(bytes[offset + i] ?? 0);
  return out;
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

/**
 * Разбирает RIFF/WAVE: часть ответов Gemini приходит уже с заголовком, и если
 * склеить такие байты «как есть», в середине файла окажется мусорный RIFF.
 * Возвращает PCM-данные (`data`-чанк) и формат; null — если это не RIFF.
 */
export function readRiffAudio(
  bytes: Uint8Array
): { pcm: Uint8Array; format: Partial<AudioFormat> } | null {
  if (bytes.length < WAV_HEADER_BYTES) return null;
  if (readAscii(bytes, 0, 4) !== 'RIFF' || readAscii(bytes, 8, 4) !== 'WAVE') return null;

  const format: Partial<AudioFormat> = {};
  let offset = 12;

  while (offset + 8 <= bytes.length) {
    const chunkId = readAscii(bytes, offset, 4);
    const chunkSize = readUint32LE(bytes, offset + 4);
    const body = offset + 8;

    if (chunkId === 'fmt ' && chunkSize >= 16 && body + 16 <= bytes.length) {
      format.channels = readUint16LE(bytes, body + 2) || undefined;
      format.sampleRate = readUint32LE(bytes, body + 4) || undefined;
      format.bitsPerSample = readUint16LE(bytes, body + 14) || undefined;
    }

    if (chunkId === 'data') {
      const end = Math.min(body + chunkSize, bytes.length);
      return { pcm: bytes.subarray(body, end), format };
    }

    // Чанки выравниваются по чётной границе.
    offset = body + chunkSize + (chunkSize % 2);
  }

  return null;
}

/**
 * Оборачивает сырой PCM в RIFF/WAVE (заголовок 44 байта), чтобы браузер
 * проиграл ответ (`<audio src=blob:…>`): сырой PCM он не декодирует.
 */
export function pcmToWav(pcm: Uint8Array, format: AudioFormat = DEFAULT_PCM_FORMAT): Uint8Array {
  const { sampleRate, channels, bitsPerSample } = format;
  const blockAlign = Math.max(1, (channels * bitsPerSample) / 8);
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm.length;

  const wav = new Uint8Array(WAV_HEADER_BYTES + dataSize);
  const view = new DataView(wav.buffer);

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // audioFormat = PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataSize, true);
  wav.set(pcm, WAV_HEADER_BYTES);

  return wav;
}

/** Байты тишины длительностью `ms` в заданном формате. */
export function silenceBytes(ms: number, format: AudioFormat = DEFAULT_PCM_FORMAT): Uint8Array {
  const blockAlign = Math.max(1, (format.channels * format.bitsPerSample) / 8);
  return new Uint8Array(Math.round(format.sampleRate * (ms / 1000)) * blockAlign);
}

/**
 * Склейка нескольких ответов Gemini в один WAV.
 *
 * Формат берётся из ПЕРВОГО разобранного ответа (RIFF-заголовок важнее
 * mimeType), остальное — по дефолту 24 kHz mono 16-bit. Между чанками
 * вставляется тишина `pauseMs` (220 мс): без неё реплики звучат слитно.
 */
export function buildDialogWav(
  chunks: readonly InlineAudio[],
  options: { pauseMs?: number; format?: AudioFormat } = {}
): Uint8Array {
  const pauseMs = options.pauseMs ?? DIALOG_TTS_LIMITS.pauseMs;

  let format: AudioFormat | null = options.format ?? null;
  const parts: Uint8Array[] = [];

  for (const chunk of chunks) {
    const bytes = base64ToBytes(chunk.data);
    const riff = readRiffAudio(bytes);

    if (!format) {
      const fromMime = parseAudioFormat(chunk.mimeType);
      format = {
        sampleRate: riff?.format.sampleRate ?? fromMime.sampleRate ?? DEFAULT_PCM_FORMAT.sampleRate,
        channels: riff?.format.channels ?? fromMime.channels ?? DEFAULT_PCM_FORMAT.channels,
        bitsPerSample:
          riff?.format.bitsPerSample ?? fromMime.bitsPerSample ?? DEFAULT_PCM_FORMAT.bitsPerSample,
      };
    }

    parts.push(riff ? riff.pcm : bytes);
  }

  const resolved = format ?? DEFAULT_PCM_FORMAT;
  const pause = silenceBytes(pauseMs, resolved);
  const total =
    parts.reduce((sum, part) => sum + part.length, 0) + pause.length * Math.max(0, parts.length - 1);

  const pcm = new Uint8Array(total);
  let offset = 0;
  parts.forEach((part, index) => {
    if (index > 0) {
      pcm.set(pause, offset);
      offset += pause.length;
    }
    pcm.set(part, offset);
    offset += part.length;
  });

  return pcmToWav(pcm, resolved);
}
