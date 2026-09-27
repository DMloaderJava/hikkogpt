/**
 * Видео-история: чистая логика слайдов, реплик и таймлайна.
 *
 * Главное правило сборки (из задания): изображение показывается ровно столько,
 * сколько звучит его реплика, — «реплика под изображение закончилась → следующий
 * слайд». Поэтому таймлайн считается от фактической длительности озвучки
 * (`audioSeconds`), а не «на глаз»: `planTimeline` раскладывает начало и конец
 * каждого слайда, а `splitCues` режет реплику на субтитры внутри её же окна.
 *
 * Модуль ничего не знает про DOM: canvas, Web Audio и MediaRecorder живут в
 * `videoRecorder.ts`, а состояния студии — в `useVideoStory`. Всё, что здесь,
 * покрыто тестами как обычные функции.
 */

import { TTS_VOICES, type TtsVoice } from "@/lib/mangaTranscript";

/** Пределы сценария. */
export const MAX_STORY_SLIDES = 30;
export const MAX_SLIDE_TEXT_CHARS = 600;

/**
 * Сколько показываем слайд после конца реплики: короткая пауза, чтобы фраза
 * «дожила» и смена кадра не выглядела обрывом. Длительность всё равно считается
 * от озвучки — это добавка к ней, а не замена.
 */
export const TAIL_SECONDS = 0.5;
/** Слайд без озвучки (сбой TTS) не мелькает: держим хотя бы столько. */
export const MIN_SLIDE_SECONDS = 1.2;

/** Субтитры. */
export const MAX_CUE_CHARS = 42;
export const MIN_CUE_SECONDS = 0.9;
/** Отступ блока субтитров от низа кадра, px. */
export const SUBTITLE_BOTTOM_OFFSET = 72;

/** Параметры рендера (Canvas + MediaRecorder, без внешних очередей). */
export const VIDEO_WIDTH = 1280;
export const VIDEO_HEIGHT = 720;
export const VIDEO_FPS = 30;
/** 8 Мбит/с — «высокое качество» для 720p30 и вменяемый размер файла. */
export const VIDEO_BITRATE = 8_000_000;

/** Слайд: изображение и его превью. Порядок в массиве = порядок в таймлайне. */
export interface StorySlide {
  id: string;
  file: File;
  /** Object URL превью — отзывается при удалении слайда и на unmount. */
  url: string;
  /** Размер картинки (нужен для cover/letterbox без искажений). */
  width?: number;
  height?: number;
}

/** Профиль говорящего: голос TTS + характер, который влияет на интонации. */
export interface CharacterProfile {
  /** Номер говорящего — тот же, что в «Speaker N». */
  speaker: number;
  voice: TtsVoice;
  /** Подпись в субтитрах и в списке персонажей. */
  name: string;
  /** «Представление / контекст персонажа»: уходит в TTS как стиль речи. */
  context: string;
}

/**
 * Пресеты из задания: Speaker 1 — Charon (глубокий, харизматичный, уверенный),
 * Speaker 2 — Kore (живой, выразительный, тёплый женский).
 */
export const CHARACTER_PRESETS: readonly CharacterProfile[] = [
  {
    speaker: 1,
    voice: "Charon",
    name: "Charon",
    context: "глубокий, харизматичный, уверенный тембр; говорит спокойно и веско, как рассказчик",
  },
  {
    speaker: 2,
    voice: "Kore",
    name: "Kore",
    context: "живой, выразительный, тёплый женский голос; мягкие интонации с эмоцией",
  },
] as const;

/** Голоса, которые примет `dialog-tts` (список тот же, что у сервера). */
export const STORY_VOICES = TTS_VOICES;

/** Свежие копии пресетов: профиль персонажа редактируется, пресеты — нет. */
export function defaultCharacters(): CharacterProfile[] {
  return CHARACTER_PRESETS.map((preset) => ({ ...preset }));
}

export function isTtsVoice(value: unknown): value is TtsVoice {
  return typeof value === "string" && (TTS_VOICES as readonly string[]).includes(value);
}

let slideSeq = 0;
export function makeSlideId(): string {
  slideSeq += 1;
  return `story-slide-${Date.now().toString(36)}-${slideSeq}`;
}

/** Реплика слайда: кто говорит и что. */
export interface SlideScript {
  slideId: string;
  speaker: number;
  text: string;
}

export interface ScriptIssue {
  slideId: string;
  reason: string;
}

/** Фрагмент субтитров внутри окна слайда. */
export interface SubtitleCue {
  /** Секунды от начала слайда. */
  start: number;
  end: number;
  text: string;
}

/** Слайд в собранном таймлайне. */
export interface StoryFrame {
  slideId: string;
  speaker: number;
  text: string;
  /** Реальная длительность озвучки (0 — слайд не озвучен). */
  audioSeconds: number;
  /** Сколько показываем слайд: озвучка + пауза, но не короче минимума. */
  seconds: number;
  /** Начало в общем таймлайне. */
  start: number;
  cues: SubtitleCue[];
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Проверка сценария перед генерацией: пустые реплики, чужие номера говорящих и
 * слишком длинный текст не должны доходить до TTS (сервер вернёт 400, а
 * пользователь получит «ошибку озвучки» без внятной причины).
 */
export function validateScript(
  slides: Pick<StorySlide, "id">[],
  script: SlideScript[],
  characters: Pick<CharacterProfile, "speaker">[]
): ScriptIssue[] {
  const issues: ScriptIssue[] = [];
  const bySlide = new Map(script.map((item) => [item.slideId, item]));
  const speakers = new Set(characters.map((c) => c.speaker));

  if (slides.length > MAX_STORY_SLIDES) {
    issues.push({ slideId: "", reason: `больше ${MAX_STORY_SLIDES} слайдов — сократите историю` });
  }

  for (const slide of slides) {
    const item = bySlide.get(slide.id);
    const text = item?.text.trim() ?? "";
    if (!item || !text) {
      issues.push({ slideId: slide.id, reason: "нет реплики — слайд нечего озвучивать" });
      continue;
    }
    if (text.length > MAX_SLIDE_TEXT_CHARS) {
      issues.push({
        slideId: slide.id,
        reason: `реплика длиннее ${MAX_SLIDE_TEXT_CHARS} символов — разбейте на два слайда`,
      });
    }
    if (!speakers.has(item.speaker)) {
      issues.push({ slideId: slide.id, reason: `говорящий Speaker ${item.speaker} не задан в персонажах` });
    }
  }

  return issues;
}

/**
 * Тело запроса к `dialog-tts` на одну реплику слайда.
 *
 * Формат тот же, что в озвучивателе манги («Speaker N: текст» + карта голосов),
 * поэтому серверная функция не меняется по контракту. Поле `styles` — характер
 * персонажа: сервер подмешивает его как указание на манеру речи, а в текст
 * реплики он не попадает (иначе был бы прочитан вслух).
 */
export function buildTtsRequest(
  text: string,
  character: CharacterProfile
): { transcript: string; voices: Record<string, TtsVoice>; styles?: Record<string, string> } {
  const clean = text.replace(/\s+/g, " ").trim();
  const context = character.context.replace(/\s+/g, " ").trim();
  return {
    transcript: `Speaker ${character.speaker}: ${clean}`,
    voices: { [String(character.speaker)]: character.voice },
    ...(context ? { styles: { [String(character.speaker)]: context } } : {}),
  };
}

/**
 * Режет реплику на субтитры внутри окна слайда.
 *
 * Куски — по границам предложений, длинные фразы — по словам, каждый не длиннее
 * `MAX_CUE_CHARS`. Время между кусками распределяется пропорционально длине, с
 * полом `MIN_CUE_SECONDS`; если текста много, все куски сжимаются, чтобы сумма
 * точно уложилась в длительность слайда (последний всегда кончается в `seconds`).
 */
export function splitCues(text: string, seconds: number): SubtitleCue[] {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  const total = Number.isFinite(seconds) ? Math.max(0.1, seconds) : 0.1;
  if (!clean) return [];

  const phrases = clean
    .split(/(?<=[.!?…;:])\s+/)
    .map((phrase) => phrase.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  for (const phrase of phrases) {
    if (phrase.length <= MAX_CUE_CHARS) {
      chunks.push(phrase);
      continue;
    }
    let current = "";
    for (const word of phrase.split(" ")) {
      const next = current ? `${current} ${word}` : word;
      if (next.length > MAX_CUE_CHARS && current) {
        chunks.push(current);
        current = word;
      } else {
        current = next;
      }
    }
    if (current) chunks.push(current);
  }

  const weights = chunks.map((chunk) => Math.max(chunk.length, 1));
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const floor = Math.min(MIN_CUE_SECONDS, total / chunks.length);

  let durations = weights.map((weight) => Math.max(floor, (weight / weightSum) * total));
  const durationSum = durations.reduce((a, b) => a + b, 0);
  // Точно укладываем сумму в окно слайда — иначе субтитры «уедут» от голоса.
  durations = durations.map((duration) => (duration * total) / durationSum);

  const cues: SubtitleCue[] = [];
  let at = 0;
  durations.forEach((duration, index) => {
    const start = round2(at);
    const end = index === durations.length - 1 ? round2(total) : round2(at + duration);
    cues.push({ start, end: Math.max(end, start + 0.05), text: chunks[index] });
    at += duration;
  });

  return cues;
}

/**
 * Таймлайн истории: каждый слайд живёт столько, сколько звучит его реплика
 * (плюс короткая пауза), а начало следующего считается от конца предыдущего.
 * `audioSeconds` — длительности озвучки по id слайда, полученные из
 * декодированного аудио, а не оценка по числу слов.
 */
export function planTimeline(script: SlideScript[], audioSeconds: Record<string, number>): StoryFrame[] {
  const frames: StoryFrame[] = [];
  let start = 0;

  for (const item of script) {
    const raw = audioSeconds[item.slideId];
    const audio = Number.isFinite(raw) ? Math.max(0, raw) : 0;
    const seconds = audio > 0 ? Math.max(MIN_SLIDE_SECONDS, audio + TAIL_SECONDS) : MIN_SLIDE_SECONDS;
    frames.push({
      slideId: item.slideId,
      speaker: item.speaker,
      text: item.text.trim(),
      audioSeconds: round2(audio),
      seconds: round2(seconds),
      start: round2(start),
      cues: splitCues(item.text, seconds),
    });
    start += seconds;
  }

  return frames;
}

/** Общая длительность видео. */
export function totalSeconds(frames: StoryFrame[]): number {
  if (!frames.length) return 0;
  const last = frames[frames.length - 1];
  return round2(last.start + last.seconds);
}

/** Какой слайд на экране в момент `time` (секунды от начала видео). */
export function frameAt(frames: StoryFrame[], time: number): StoryFrame | null {
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    const frame = frames[i];
    if (time >= frame.start && time < frame.start + frame.seconds) return frame;
  }
  return null;
}

/** Активная строка субтитров внутри слайда. */
export function cueAt(frame: StoryFrame, localTime: number): SubtitleCue | null {
  for (const cue of frame.cues) {
    if (localTime >= cue.start && localTime < cue.end) return cue;
  }
  return frame.cues.length ? frame.cues[frame.cues.length - 1] : null;
}

/** Как вписываем изображение в кадр: заполнение или с полями. */
export type FitMode = "cover" | "letterbox";

export interface DrawRect {
  /** Источник (вся картинка). */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** Куда рисуем в кадре. */
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

/**
 * Прямоугольник отрисовки без искажений.
 *
 * `cover` — картинка заполняет кадр, лишнее уходит за края (соотношение сторон
 * сохраняется, `dx`/`dy` могут быть отрицательными); `letterbox` — целиком
 * вписывается в кадр с полями сверху/снизу или слева/справа.
 */
export function fitRect(
  imageWidth: number,
  imageHeight: number,
  boxWidth: number,
  boxHeight: number,
  mode: FitMode = "cover"
): DrawRect {
  const empty: DrawRect = { sx: 0, sy: 0, sw: 0, sh: 0, dx: 0, dy: 0, dw: boxWidth, dh: boxHeight };
  if (!(imageWidth > 0) || !(imageHeight > 0) || !(boxWidth > 0) || !(boxHeight > 0)) return empty;

  const scale =
    mode === "cover"
      ? Math.max(boxWidth / imageWidth, boxHeight / imageHeight)
      : Math.min(boxWidth / imageWidth, boxHeight / imageHeight);
  const dw = round2(imageWidth * scale);
  const dh = round2(imageHeight * scale);

  return {
    sx: 0,
    sy: 0,
    sw: imageWidth,
    sh: imageHeight,
    dx: round2((boxWidth - dw) / 2),
    dy: round2((boxHeight - dh) / 2),
    dw,
    dh,
  };
}

/** Кандидаты формата: сначала MP4 (Safari/новый Chrome), затем WebM. */
export const VIDEO_MIME_CANDIDATES: readonly { mime: string; ext: string }[] = [
  { mime: "video/mp4;codecs=avc1.42E01E,mp4a.40.2", ext: "mp4" },
  { mime: "video/webm;codecs=vp9,opus", ext: "webm" },
  { mime: "video/webm;codecs=vp8,opus", ext: "webm" },
  { mime: "video/webm", ext: "webm" },
] as const;

/**
 * Рабочий формат записи: `MediaRecorder` умеет разное в разных браузерах,
 * поэтому выбираем первый поддерживаемый, а не надеемся на mp4.
 * null — браузер не умеет запись вовсе (тогда студия честно сообщает об этом).
 */
export function pickVideoMime(canRecord: (mime: string) => boolean): { mime: string; ext: string } | null {
  for (const candidate of VIDEO_MIME_CANDIDATES) {
    if (canRecord(candidate.mime)) return { mime: candidate.mime, ext: candidate.ext };
  }
  return null;
}

const SLUG_RE = /[^a-z0-9\-_]+/gi;

/** Имя файла для скачивания: безопасный slug + дата + верное расширение. */
export function videoFileName(ext: string, title?: string): string {
  const safeExt = /^(mp4|webm)$/i.test(ext ?? "") ? ext.toLowerCase() : "webm";
  const slug = (title ?? "").trim().replace(SLUG_RE, "-").replace(/^-+|-+$/g, "").slice(0, 40).toLowerCase();
  const date = new Date().toISOString().slice(0, 10);
  return slug ? `hikko-${slug}-${date}.${safeExt}` : `hikko-story-${date}.${safeExt}`;
}

/** Секунды в «0:07» / «1:23» — для плеера и таймлайна. */
export function formatClock(seconds: number): string {
  const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const rest = value % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);
  return `${hours > 0 ? `${hours}:` : ""}${mm}:${String(rest).padStart(2, "0")}`;
}

/** Проценты генерации: озвучено слайдов / всего. */
export function generationPercent(done: number, total: number): number {
  if (!(total > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}
