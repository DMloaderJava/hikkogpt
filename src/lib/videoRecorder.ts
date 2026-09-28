/**
 * Движок сборки видео-истории прямо в браузере: Canvas + Web Audio +
 * MediaRecorder. Никаких внешних очередей рендеринга — запись идёт в реальном
 * времени, зато кадр и звук совмещены по одним часам.
 *
 * Как достигается синхронизация «реплика закончилась → следующий слайд»:
 * 1. таймлайн (`planTimeline` из videoStory) уже посчитан от фактической
 *    длительности озвучки, а не от числа слов;
 * 2. все дорожки ставятся в очередь на часах AudioContext
 *    (`source.start(t0 + frame.start)`) — это самый точный таймер в браузере;
 * 3. цикл отрисовки берёт время оттуда же (`audioCtx.currentTime - t0`), поэтому
 *    картинка и субтитры не «уезжают» от голоса даже на длинной истории;
 * 4. звук пишется в `MediaStreamAudioDestinationNode` и не подключается к
 *    колонкам: рендер идёт беззвучно, а в файл попадает чистая дорожка.
 *
 * Все DOM-зависимости приходят через `RecorderDeps`, поэтому движок проверяется
 * тестами на подставных объектах (canvas, AudioContext, MediaRecorder, rAF),
 * а в браузере работают те же самые вызовы через `browserDeps`.
 */

import {
  VIDEO_BITRATE,
  VIDEO_FPS,
  VIDEO_HEIGHT,
  VIDEO_WIDTH,
  fitRect,
  frameAt,
  pickVideoMime,
  totalSeconds,
  videoFileName,
  type FitMode,
  type StoryFrame,
} from "@/lib/videoStory";

/** Декодированная дорожка слайда. */
export interface AudioBufferLike {
  duration: number;
  sampleRate: number;
  numberOfChannels: number;
  length: number;
}

export interface AudioBufferSourceLike {
  buffer: AudioBufferLike | null;
  connect(node: unknown): void;
  start(when?: number): void;
  stop(when?: number): void;
}

export interface AudioContextLike {
  readonly currentTime: number;
  readonly sampleRate: number;
  state: string;
  resume(): Promise<void>;
  close(): Promise<void>;
  createMediaStreamDestination(): { stream: MediaStreamLike };
  createBufferSource(): AudioBufferSourceLike;
}

export interface MediaStreamLike {
  getAudioTracks(): unknown[];
  getVideoTracks(): unknown[];
  addTrack(track: unknown): void;
}

export interface MediaRecorderLike {
  state: string;
  mimeType?: string;
  start(timeslice?: number): void;
  stop(): void;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface Canvas2DLike {
  fillStyle: unknown;
  strokeStyle: unknown;
  font: string;
  textAlign: string;
  textBaseline: string;
  globalAlpha: number;
  shadowColor: string;
  shadowBlur: number;
  lineWidth: number;
  save(): void;
  restore(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, start: number, end: number): void;
  fill(): void;
  stroke(): void;
  drawImage(image: unknown, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void;
  measureText(text: string): { width: number };
  fillText(text: string, x: number, y: number): void;
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): unknown;
}

export interface CanvasLike {
  width: number;
  height: number;
  getContext(type: "2d"): Canvas2DLike | null;
  captureStream(frameRate?: number): MediaStreamLike;
  toDataURL(type?: string, quality?: number): string;
}

/** Картинка слайда: всё, что нужно drawImage. */
export interface ImageSourceLike {
  width: number;
  height: number;
}

export interface RecorderDeps {
  createCanvas(width: number, height: number): CanvasLike;
  loadImage(url: string): Promise<ImageSourceLike>;
  createAudioContext(): AudioContextLike;
  createRecorder(stream: MediaStreamLike, options: { mimeType: string; videoBitsPerSecond: number; audioBitsPerSecond: number }): MediaRecorderLike;
  canRecord(mime: string): boolean;
  requestFrame(callback: () => void): number;
  cancelFrame(handle: number): void;
  decodeAudio(blob: Blob): Promise<AudioBufferLike>;
}

/** Кадр слайда для движка: картинка + её озвучка + подпись говорящего. */
export interface RecorderSlide {
  image: ImageSourceLike;
  /** Подпись в субтитрах: «Speaker 1 · Charon». */
  speakerLabel?: string;
}

export interface RenderOptions {
  /** Таймлайн: порядок слайдов и их длительности от озвучки. */
  frames: StoryFrame[];
  /** Картинки по id слайда. */
  slides: Record<string, RecorderSlide>;
  /** Озвучка по id слайда (декодированная). */
  audio: Record<string, AudioBufferLike>;
  width?: number;
  height?: number;
  fps?: number;
  bitrate?: number;
  /** cover — заполнение кадра, letterbox — с полями. */
  fit?: FitMode;
  title?: string;
  /** Заголовок на первом кадре (необязательно). */
  introTitle?: string;
  onProgress?: (percent: number, info: { index: number; time: number; total: number }) => void;
  signal?: AbortSignal;
}

export interface RenderedVideo {
  blob: Blob;
  mime: string;
  ext: string;
  fileName: string;
  duration: number;
  width: number;
  height: number;
  /** Постер (первый кадр) — dataURL, чтобы отправить видео в чат. */
  poster: string;
}

/** Сколько кусков в секунду просим у MediaRecorder: чаще — ровнее поток. */
const RECORD_TIMESLICE_MS = 200;
/** Запас до первого звука: холст должен начать писаться раньше дорожки. */
const LEAD_IN_SECONDS = 0.2;
/** Длительность появления строки субтитров, с. */
const CUE_FADE_SECONDS = 0.18;
const SUBTITLE_FONT_PX = 30;
const LABEL_FONT_PX = 18;

export const NO_RECORDER_MESSAGE =
  "Браузер не умеет записывать видео (нет MediaRecorder с поддержкой видео) — попробуйте Chrome, Edge, Firefox или Safari";
export const NO_FRAMES_MESSAGE = "Нечего собирать: в истории нет ни одного слайда с репликой";
export const NO_IMAGE_MESSAGE = (slideId: string) => `Для слайда ${slideId} нет изображения — вернитесь к этапу «Материалы»`;
export const NO_CANVAS_MESSAGE = "Не удалось создать холст для сборки видео (2D-контекст недоступен)";

/** Реализация зависимостей для браузера. */
export const browserDeps: RecorderDeps = {
  createCanvas(width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas as unknown as CanvasLike;
  },
  loadImage(url) {
    return new Promise<ImageSourceLike>((resolve, reject) => {
      const image = new Image();
      image.decoding = "async";
      image.onload = () => resolve(image as unknown as ImageSourceLike);
      image.onerror = () => reject(new Error(`Не удалось загрузить изображение слайда (${url.slice(0, 48)}…)`));
      image.src = url;
    });
  },
  createAudioContext() {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) throw new Error("Web Audio API недоступен в этом браузере — собрать видео не получится");
    return new Ctor() as unknown as AudioContextLike;
  },
  createRecorder(stream, options) {
    if (typeof MediaRecorder === "undefined") throw new Error(NO_RECORDER_MESSAGE);
    return new MediaRecorder(stream as unknown as MediaStream, options) as unknown as MediaRecorderLike;
  },
  canRecord(mime) {
    return typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(mime);
  },
  requestFrame(callback) {
    return window.requestAnimationFrame(() => callback());
  },
  cancelFrame(handle) {
    window.cancelAnimationFrame(handle);
  },
  decodeAudio(blob) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return Promise.reject(new Error("Web Audio API недоступен в этом браузере"));
    const context = new Ctor();
    return blob
      .arrayBuffer()
      .then((bytes) => context.decodeAudioData(bytes))
      .then((buffer) => {
        void context.close();
        return buffer as unknown as AudioBufferLike;
      })
      .catch((error) => {
        void context.close();
        throw error instanceof Error ? error : new Error("Не удалось разобрать дорожку озвучки");
      });
  },
};

/**
 * Перенос строки субтитра по ширине: куски из `splitCues` короткие, но на узком
 * кадре или крупном шрифте всё равно может понадобиться вторая строка.
 */
export function wrapText(ctx: Canvas2DLike, text: string, maxWidth: number, maxLines = 2): string[] {
  const words = text.split(" ").filter(Boolean);
  if (!words.length) return [];

  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (current && ctx.measureText(next).width > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);

  if (lines.length <= maxLines) return lines;
  // Не влезло — последнюю строку обрываем многоточием: субтитр не должен расти.
  const kept = lines.slice(0, maxLines);
  const tail = kept[maxLines - 1];
  kept[maxLines - 1] = `${tail.length > 1 ? tail.slice(0, -1) : tail}…`;
  return kept;
}

export interface SlideDrawState {
  width: number;
  height: number;
  fit: FitMode;
  image?: ImageSourceLike;
  /** 0..1 — насколько слайд показан (для плавного появления). */
  reveal: number;
  /** 0..1 — прогресс всей истории (полоса внизу кадра). */
  progress: number;
  speakerLabel?: string;
  subtitle?: string;
  /** 0..1 — возраст строки субтитров (появление/исчезновение). */
  cueAge?: number;
  introTitle?: string;
}

/**
 * Рисует один кадр: фон с полями, изображение без искажений, подпись говорящего,
 * субтитр с появлением и полосу прогресса. Функция не трогает глобальный DOM —
 * всё приходит параметрами, поэтому её можно проверить на подставном контексте.
 */
export function drawSlideFrame(ctx: Canvas2DLike, state: SlideDrawState): void {
  const { width, height, fit, reveal, progress } = state;

  ctx.save();
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#08080c";
  ctx.fillRect(0, 0, width, height);

  if (state.image) {
    const rect = fitRect(state.image.width, state.image.height, width, height, fit);
    // Плавное появление кадра: прозрачность + лёгкий наезд в первые ~0.3 с.
    // Наезд делаем только для cover (края там и так за кадром): в letterbox
    // картинка обязана оставаться в кадре целиком, иначе поля теряют смысл.
    const ease = Math.max(0, Math.min(1, reveal));
    const zoom = fit === "cover" ? 1 + (1 - ease) * 0.03 : 1;
    const dw = rect.dw * zoom;
    const dh = rect.dh * zoom;
    ctx.globalAlpha = ease;
    ctx.drawImage(
      state.image,
      rect.sx,
      rect.sy,
      rect.sw,
      rect.sh,
      rect.dx - (dw - rect.dw) / 2,
      rect.dy - (dh - rect.dh) / 2,
      dw,
      dh
    );
    ctx.globalAlpha = 1;
  }

  // Затемнение снизу — на нём субтитры читаются на любом кадре.
  const gradient = ctx.createLinearGradient(0, height * 0.6, 0, height);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, height * 0.6, width, height * 0.4);

  const centerX = width / 2;
  const subtitleBottom = height - 48;

  if (state.subtitle) {
    const age = state.cueAge ?? 1;
    const alpha = Math.max(0, Math.min(1, age / CUE_FADE_SECONDS));
    const lift = (1 - alpha) * 10;
    const lines = wrapText(ctx, state.subtitle, width * 0.86);

    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.globalAlpha = alpha;
    ctx.font = `600 ${SUBTITLE_FONT_PX}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.shadowColor = "rgba(0, 0, 0, 0.85)";
    ctx.shadowBlur = 12;
    ctx.fillStyle = "#ffffff";
    lines.forEach((line, index) => {
      ctx.fillText(line, centerX, subtitleBottom - (lines.length - 1 - index) * (SUBTITLE_FONT_PX + 6) + lift);
    });
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;

    if (state.speakerLabel) {
      ctx.font = `600 ${LABEL_FONT_PX}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      ctx.fillStyle = "rgba(255, 255, 255, 0.72)";
      ctx.fillText(state.speakerLabel, centerX, subtitleBottom - lines.length * (SUBTITLE_FONT_PX + 6) - 6 + lift);
    }
  }

  if (state.introTitle) {
    ctx.font = `700 40px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
    ctx.textAlign = "center";
    ctx.fillText(state.introTitle, centerX, 72);
  }

  // Полоса прогресса истории — видно, сколько уже сыграно.
  const barHeight = 6;
  ctx.fillStyle = "rgba(255, 255, 255, 0.18)";
  ctx.fillRect(0, height - barHeight, width, barHeight);
  ctx.fillStyle = "rgba(139, 92, 246, 0.95)";
  ctx.fillRect(0, height - barHeight, width * Math.max(0, Math.min(1, progress)), barHeight);

  ctx.restore();
}

/** Какой слайд сейчас на экране и сколько он уже показан (0..1). */
export function locateFrame(frames: StoryFrame[], time: number): { frame: StoryFrame; index: number; local: number } | null {
  const frame = frameAt(frames, time);
  if (!frame) return null;
  const index = frames.indexOf(frame);
  const local = time - frame.start;
  return { frame, index, local };
}

function isAbort(signal?: AbortSignal | null): boolean {
  return Boolean(signal?.aborted);
}

function abortError(): DOMException {
  return new DOMException("Сборка видео отменена", "AbortError");
}

/**
 * Собирает видео: пишет холст и звуковые дорожки в один MediaRecorder.
 *
 * Отмена через `signal` (кнопка «Стоп») останавливает запись и отдаёт
 * `AbortError` — вызывающий код не показывает её как ошибку, так же как
 * остановку запросов в чате и в озвучивателе манги.
 */
export async function renderStoryVideo(options: RenderOptions, deps: RecorderDeps = browserDeps): Promise<RenderedVideo> {
  const {
    frames,
    slides,
    audio,
    width = VIDEO_WIDTH,
    height = VIDEO_HEIGHT,
    fps = VIDEO_FPS,
    bitrate = VIDEO_BITRATE,
    fit = "cover",
    title,
    introTitle,
    onProgress,
    signal,
  } = options;

  if (isAbort(signal)) throw abortError();
  if (!frames.length) throw new Error(NO_FRAMES_MESSAGE);

  for (const frame of frames) {
    if (!slides[frame.slideId]) throw new Error(NO_IMAGE_MESSAGE(frame.slideId));
  }

  const format = pickVideoMime((mime) => deps.canRecord(mime));
  if (!format) throw new Error(NO_RECORDER_MESSAGE);

  const canvas = deps.createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error(NO_CANVAS_MESSAGE);

  const audioCtx = deps.createAudioContext();
  const destination = audioCtx.createMediaStreamDestination();
  const stream = canvas.captureStream(fps);
  for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);

  const recorder = deps.createRecorder(stream, {
    mimeType: format.mime,
    videoBitsPerSecond: bitrate,
    audioBitsPerSecond: 128_000,
  });

  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  };

  const duration = totalSeconds(frames);

  let stopped = false;
  let rafHandle = 0;
  let rejectLoop: ((reason: unknown) => void) | null = null;
  const sources: AudioBufferSourceLike[] = [];

  /** Останавливает дорожки, цикл отрисовки и AudioContext — ровно один раз. */
  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    deps.cancelFrame(rafHandle);
    for (const source of sources) {
      try {
        source.stop();
      } catch {
        // Дорожка уже закончилась — не критично.
      }
    }
    void audioCtx.close();
  };

  /**
   * Останавливает MediaRecorder и отдаёт записанные куски. Отдельной функцией,
   * чтобы отмена тоже освобождала рекордер (файл при этом уже не нужен).
   */
  const stopRecording = () =>
    new Promise<Blob>((resolve) => {
      const collect = () => resolve(new Blob(chunks, { type: format.mime }));
      recorder.onstop = collect;
      recorder.onerror = collect;
      try {
        if (recorder.state !== "inactive") recorder.stop();
        else collect();
      } catch {
        collect();
      }
    });

  // «Стоп»: рвём цикл отрисовки сразу, не дожидаясь следующего кадра.
  const onAbort = () => {
    rejectLoop?.(abortError());
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  // Первый кадр рисуем до старта записи: видео не должно начинаться с чёрного,
  // а постер для чата снимается именно с этого кадра.
  const firstSlide = slides[frames[0].slideId];
  drawSlideFrame(ctx, {
    width,
    height,
    fit,
    image: firstSlide.image,
    reveal: 0,
    progress: 0,
    speakerLabel: firstSlide.speakerLabel,
    subtitle: frames[0].cues[0]?.text,
    cueAge: 0,
    introTitle,
  });
  const poster = canvas.toDataURL("image/jpeg", 0.82);

  await audioCtx.resume();
  recorder.start(RECORD_TIMESLICE_MS);

  // Дорожки встают в очередь по таймлайну: старт каждого слайда — конец реплики
  // предыдущего, поэтому картинка не расходится с голосом. Звук идёт только в
  // MediaStreamAudioDestinationNode (в файл), а не в колонки: рендер беззвучный.
  const startTime = audioCtx.currentTime + LEAD_IN_SECONDS;
  for (const frame of frames) {
    const buffer = audio[frame.slideId];
    if (!buffer) continue;
    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(destination);
    source.start(startTime + frame.start);
    sources.push(source);
  }

  try {
    await new Promise<void>((resolve, reject) => {
      rejectLoop = reject;

      const tick = () => {
        if (isAbort(signal)) {
          reject(abortError());
          return;
        }

        const elapsed = audioCtx.currentTime - startTime;
        const located = locateFrame(frames, Math.max(0, elapsed));

        if (!located) {
          // История доиграна: держим последний кадр и закрываем запись.
          const last = frames[frames.length - 1];
          const lastSlide = slides[last.slideId];
          drawSlideFrame(ctx, {
            width,
            height,
            fit,
            image: lastSlide.image,
            reveal: 1,
            progress: 1,
            speakerLabel: lastSlide.speakerLabel,
            subtitle: last.cues[last.cues.length - 1]?.text,
            cueAge: 1,
          });
          onProgress?.(100, { index: frames.length - 1, time: duration, total: duration });
          resolve();
          return;
        }

        const { frame, index, local } = located;
        const slide = slides[frame.slideId];
        const cue =
          frame.cues.find((item) => local >= item.start && local < item.end) ?? frame.cues[frame.cues.length - 1];
        const cueAge = cue ? local - cue.start : 1;

        drawSlideFrame(ctx, {
          width,
          height,
          fit,
          image: slide.image,
          reveal: Math.min(1, local / 0.3),
          progress: duration > 0 ? Math.min(1, (frame.start + local) / duration) : 0,
          speakerLabel: slide.speakerLabel,
          subtitle: cue?.text,
          cueAge,
          introTitle: index === 0 && local < 1.6 ? introTitle : undefined,
        });
        onProgress?.(
          Math.max(0, Math.min(100, Math.round(((frame.start + local) / Math.max(duration, 0.001)) * 100))),
          { index, time: Math.max(0, elapsed), total: duration }
        );

        rafHandle = deps.requestFrame(tick);
      };

      rafHandle = deps.requestFrame(tick);
    });
  } catch (error) {
    // Отмена или сбой: освобождаем холст, дорожки и рекордер, файл не собираем.
    cleanup();
    void stopRecording();
    throw error;
  }

  signal?.removeEventListener("abort", onAbort);
  const blob = await stopRecording();
  cleanup();

  return {
    blob,
    mime: format.mime,
    ext: format.ext,
    fileName: videoFileName(format.ext, title),
    duration,
    width,
    height,
    poster,
  };
}

/**
 * Постер истории (первый слайд с заголовком) — dataURL для отправки в чат:
 * сообщение с видео получает预览, даже если плеер его не показывает.
 */
export function renderPoster(
  frames: StoryFrame[],
  slides: Record<string, RecorderSlide>,
  deps: RecorderDeps = browserDeps,
  options: { width?: number; height?: number; fit?: FitMode; introTitle?: string } = {}
): string {
  if (!frames.length) return "";
  const slide = slides[frames[0].slideId];
  if (!slide) return "";

  const width = options.width ?? VIDEO_WIDTH;
  const height = options.height ?? VIDEO_HEIGHT;
  const canvas = deps.createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  drawSlideFrame(ctx, {
    width,
    height,
    fit: options.fit ?? "cover",
    image: slide.image,
    reveal: 1,
    progress: 0,
    speakerLabel: slide.speakerLabel,
    subtitle: frames[0].cues[0]?.text,
    cueAge: 1,
    introTitle: options.introTitle,
  });

  return canvas.toDataURL("image/jpeg", 0.85);
}
