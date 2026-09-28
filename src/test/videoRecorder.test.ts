import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  browserDeps,
  NO_CANVAS_MESSAGE,
  NO_FRAMES_MESSAGE,
  NO_IMAGE_MESSAGE,
  NO_RECORDER_MESSAGE,
  drawSlideFrame,
  locateFrame,
  renderPoster,
  renderStoryVideo,
  wrapText,
  type AudioBufferLike,
  type Canvas2DLike,
  type CanvasLike,
  type ImageSourceLike,
  type MediaRecorderLike,
  type MediaStreamLike,
  type RecorderDeps,
  type RecorderSlide,
} from "@/lib/videoRecorder";
import {
  TAIL_SECONDS,
  VIDEO_BITRATE,
  VIDEO_FPS,
  VIDEO_HEIGHT,
  VIDEO_WIDTH,
  planTimeline,
  totalSeconds,
  type StoryFrame,
} from "@/lib/videoStory";

/**
 * Движок сборки видео (Canvas + Web Audio + MediaRecorder).
 *
 * В jsdom нет ни холста, ни AudioContext, ни рекордера, поэтому зависимости
 * подставные: они же показывают, что именно делает движок — в какой момент
 * стартует запись, когда звучит каждая дорожка, что рисуется на кадре и что
 * происходит при остановке.
 */

const buffer = (seconds: number): AudioBufferLike => ({
  duration: seconds,
  sampleRate: 48000,
  numberOfChannels: 1,
  length: Math.round(seconds * 48000),
});

const SCRIPT = [
  { slideId: "s1", speaker: 1, text: "Ребята, начинаем?" },
  { slideId: "s2", speaker: 2, text: "Я сказала тебе прекратить!" },
];
/** s1: 0..3.5 с, s2: 3.5..9 с (озвучка + пауза TAIL_SECONDS). */
const FRAMES: StoryFrame[] = planTimeline(SCRIPT, { s1: 3, s2: 5 });
const SLIDES: Record<string, RecorderSlide> = {
  s1: { image: { width: 1000, height: 2000 }, speakerLabel: "Speaker 1 · Charon" },
  s2: { image: { width: 2000, height: 1000 }, speakerLabel: "Speaker 2 · Kore" },
};
const AUDIO: Record<string, AudioBufferLike> = { s1: buffer(3), s2: buffer(5) };

interface DrawnImage {
  sw: number;
  sh: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}
interface DrawnText {
  text: string;
  x: number;
  y: number;
  font: string;
  alpha: number;
}
interface StartedSource {
  buffer: AudioBufferLike | null;
  when?: number;
  connectedTo: unknown[];
  stopped: boolean;
  connect: (node: unknown) => void;
  start: (when?: number) => void;
  stop: () => void;
}

function createHarness(options: { canRecord?: (mime: string) => boolean; noContext?: boolean } = {}) {
  const events: string[] = [];
  const drawnImages: DrawnImage[] = [];
  const drawnTexts: DrawnText[] = [];
  const fillRects: { x: number; y: number; w: number; h: number }[] = [];
  const sources: StartedSource[] = [];
  let time = 0;
  let pending: (() => void) | null = null;

  const destinationNode = { kind: "media-stream-destination" };
  const speakerNode = { kind: "speakers" };
  const audioTracks = [{ id: "audio-track" }];

  const ctx: Canvas2DLike = {
    fillStyle: "",
    strokeStyle: "",
    font: "",
    textAlign: "",
    textBaseline: "",
    globalAlpha: 1,
    shadowColor: "",
    shadowBlur: 0,
    lineWidth: 1,
    save: () => events.push("save"),
    restore: () => events.push("restore"),
    fillRect: (x, y, w, h) => fillRects.push({ x, y, w, h }),
    clearRect: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    arc: () => {},
    fill: () => {},
    stroke: () => {},
    drawImage: (_image, _sx, _sy, sw, sh, dx, dy, dw, dh) => {
      drawnImages.push({ sw, sh, dx, dy, dw, dh });
      events.push("drawImage");
    },
    // ~8 px на символ: достаточно, чтобы проверить перенос строки.
    measureText: (text: string) => ({ width: text.length * 8 }),
    fillText: (text, x, y) => {
      drawnTexts.push({ text, x, y, font: ctx.font, alpha: ctx.globalAlpha });
      events.push(`fillText:${text}`);
    },
    createLinearGradient: () => ({ kind: "gradient" }),
  };

  const stream: MediaStreamLike & { tracks: unknown[] } = {
    tracks: [],
    getAudioTracks: () => [],
    getVideoTracks: () => [{ id: "video-track" }],
    addTrack: (track: unknown) => {
      stream.tracks.push(track);
      events.push("addTrack");
    },
  };

  const canvas: CanvasLike = {
    width: 0,
    height: 0,
    getContext: () => (options.noContext ? null : ctx),
    captureStream: (frameRate?: number) => {
      events.push(`captureStream:${frameRate}`);
      return stream;
    },
    toDataURL: () => {
      events.push("toDataURL");
      return "data:image/jpeg;base64,POSTER";
    },
  };

  const recorder: MediaRecorderLike & {
    startedWith?: number;
    options?: { mimeType: string; videoBitsPerSecond: number; audioBitsPerSecond: number };
    chunks: Blob[];
  } = {
    state: "inactive",
    chunks: [],
    ondataavailable: null,
    onstop: null,
    onerror: null,
    start(timeslice?: number) {
      recorder.state = "recording";
      recorder.startedWith = timeslice;
      events.push("recorder.start");
    },
    stop() {
      recorder.state = "inactive";
      events.push("recorder.stop");
      const chunk = new Blob(["видео-данные"], { type: "video/webm" });
      recorder.chunks.push(chunk);
      recorder.ondataavailable?.({ data: chunk });
      recorder.onstop?.();
    },
  };

  const audioCtx = {
    get currentTime() {
      return time;
    },
    sampleRate: 48000,
    state: "running",
    destination: speakerNode,
    resume: async () => {
      events.push("resume");
    },
    close: async () => {
      events.push("close");
    },
    createMediaStreamDestination: () => ({ stream: { getAudioTracks: () => audioTracks, getVideoTracks: () => [], addTrack: () => {} } }),
    createBufferSource: () => {
      const source: StartedSource = {
        buffer: null,
        connectedTo: [],
        stopped: false,
        connect: (node: unknown) => {
          source.connectedTo.push(node);
        },
        start: (when?: number) => {
          source.when = when;
          events.push("source.start");
        },
        stop: () => {
          source.stopped = true;
        },
      };
      // buffer/when пишутся снаружи — объект уже в списке.
      sources.push(source);
      return {
        set buffer(value: AudioBufferLike | null) {
          source.buffer = value;
        },
        get buffer() {
          return source.buffer;
        },
        connect: source.connect,
        start: source.start,
        stop: source.stop,
      };
    },
  };

  const deps: RecorderDeps = {
    createCanvas: (width, height) => {
      canvas.width = width;
      canvas.height = height;
      events.push(`createCanvas:${width}x${height}`);
      return canvas;
    },
    loadImage: async () => ({ width: 1000, height: 2000 } as ImageSourceLike),
    createAudioContext: () => audioCtx,
    createRecorder: (mediaStream, recorderOptions) => {
      recorder.options = recorderOptions;
      events.push("createRecorder");
      return recorder;
    },
    canRecord: options.canRecord ?? ((mime: string) => mime.startsWith("video/webm")),
    requestFrame: (callback) => {
      pending = callback;
      return 1;
    },
    cancelFrame: () => {
      pending = null;
      events.push("cancelFrame");
    },
    decodeAudio: async () => buffer(2),
  };

  return {
    deps,
    events,
    drawnImages,
    drawnTexts,
    fillRects,
    sources,
    recorder,
    canvas,
    ctx,
    stream,
    destinationNode,
    speakerNode,
    setTime: (value: number) => {
      time = value;
    },
    /** Дать микротаскам и одному макротаску пройти (resume → start → первый кадр). */
    flush: () => new Promise((resolve) => setTimeout(resolve, 0)),
    /** Один шаг цикла отрисовки в момент `at` по часам AudioContext. */
    step: async (at: number) => {
      time = at;
      const callback = pending;
      pending = null;
      callback?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    hasPending: () => pending !== null,
  };
}

type Harness = ReturnType<typeof createHarness>;

/** Прогоняет рендер по списку моментов времени. */
async function drive(harness: Harness, promise: Promise<unknown>, times: number[]) {
  await harness.flush();
  for (const at of times) {
    await harness.step(at);
  }
  return promise;
}

/** Моменты: lead-in 0.2 с, слайд 1 (0..3.5), слайд 2 (3.5..9), конец. */
const TIMELINE = [0.2, 2, 4, 8, 9.5];

describe("renderStoryVideo: сборка", () => {
  it("пишет видео в поддерживаемом формате с высоким битрейтом", async () => {
    const harness = createHarness();
    const promise = renderStoryVideo({ frames: FRAMES, slides: SLIDES, audio: AUDIO }, harness.deps);
    const video = (await drive(harness, promise, TIMELINE)) as Awaited<ReturnType<typeof renderStoryVideo>>;

    expect(video.blob.size).toBeGreaterThan(0);
    expect(video.mime).toBe("video/webm;codecs=vp9,opus");
    expect(video.ext).toBe("webm");
    expect(video.fileName).toMatch(/^hikko-story-\d{4}-\d{2}-\d{2}\.webm$/);
    expect(video.duration).toBeCloseTo(totalSeconds(FRAMES), 5);
    expect(video.width).toBe(VIDEO_WIDTH);
    expect(video.height).toBe(VIDEO_HEIGHT);

    expect(harness.recorder.options).toEqual({
      mimeType: "video/webm;codecs=vp9,opus",
      videoBitsPerSecond: VIDEO_BITRATE,
      audioBitsPerSecond: 128_000,
    });
    expect(harness.canvas.width).toBe(VIDEO_WIDTH);
    expect(harness.events).toContain(`captureStream:${VIDEO_FPS}`);
  });

  it("выбирает mp4, если браузер умеет его писать", async () => {
    const harness = createHarness({ canRecord: (mime) => mime.startsWith("video/mp4") });
    const promise = renderStoryVideo({ frames: FRAMES, slides: SLIDES, audio: AUDIO, title: "My Story" }, harness.deps);
    const video = (await drive(harness, promise, TIMELINE)) as Awaited<ReturnType<typeof renderStoryVideo>>;

    expect(video.ext).toBe("mp4");
    expect(video.fileName).toMatch(/^hikko-my-story-.*\.mp4$/);
  });

  it("первый кадр рисуется до старта записи, а постер снимается с него", async () => {
    const harness = createHarness();
    const promise = renderStoryVideo({ frames: FRAMES, slides: SLIDES, audio: AUDIO, introTitle: "История" }, harness.deps);
    const video = (await drive(harness, promise, TIMELINE)) as Awaited<ReturnType<typeof renderStoryVideo>>;

    const drawAt = harness.events.indexOf("drawImage");
    const startAt = harness.events.indexOf("recorder.start");
    const posterAt = harness.events.indexOf("toDataURL");
    expect(drawAt).toBeGreaterThanOrEqual(0);
    expect(drawAt).toBeLessThan(startAt);
    // Постер — после первого кадра, иначе был бы чёрным.
    expect(posterAt).toBeGreaterThan(drawAt);
    expect(posterAt).toBeLessThan(startAt);
    expect(video.poster).toBe("data:image/jpeg;base64,POSTER");
  });

  it("дорожки встают в очередь по таймлайну: старт слайда = конец предыдущей реплики", async () => {
    const harness = createHarness();
    const promise = renderStoryVideo({ frames: FRAMES, slides: SLIDES, audio: AUDIO }, harness.deps);
    await drive(harness, promise, TIMELINE);

    expect(harness.sources).toHaveLength(2);
    const [first, second] = harness.sources;
    expect(first.buffer?.duration).toBe(3);
    expect(second.buffer?.duration).toBe(5);
    // LEAD_IN_SECONDS = 0.2: первая дорожка в 0.2, вторая — после 3 с озвучки и паузы.
    expect(first.when).toBeCloseTo(0.2, 5);
    expect(second.when).toBeCloseTo(0.2 + 3 + TAIL_SECONDS, 5);
    expect(second.when).toBeGreaterThan(Number(first.when));
  });

  it("звук пишется в файл и не идёт в колонки", async () => {
    const harness = createHarness();
    const promise = renderStoryVideo({ frames: FRAMES, slides: SLIDES, audio: AUDIO }, harness.deps);
    await drive(harness, promise, TIMELINE);

    // Все дорожки подключены к MediaStreamAudioDestinationNode, не к destination.
    expect(harness.sources.every((source) => source.connectedTo.length === 1)).toBe(true);
    expect(harness.sources.some((source) => source.connectedTo.includes(harness.speakerNode))).toBe(false);
    // Аудиодорожка добавлена в поток записи.
    expect(harness.stream.tracks).toHaveLength(1);
  });

  it("рисует каждый слайд без искажений и с его субтитром", async () => {
    const harness = createHarness();
    const promise = renderStoryVideo({ frames: FRAMES, slides: SLIDES, audio: AUDIO }, harness.deps);
    await drive(harness, promise, TIMELINE);

    expect(harness.drawnImages.length).toBeGreaterThanOrEqual(5);
    for (const image of harness.drawnImages) {
      // cover: соотношение источника сохранено, кадр заполнен.
      expect(image.sw / image.sh).toBeCloseTo(image.dw / image.dh, 1);
      expect(Math.max(image.dw, image.dh)).toBeGreaterThanOrEqual(Math.min(VIDEO_WIDTH, VIDEO_HEIGHT));
    }

    const texts = harness.drawnTexts.map((item) => item.text);
    expect(texts).toContain("Ребята, начинаем?");
    expect(texts).toContain("Я сказала тебе прекратить!");
    expect(texts).toContain("Speaker 1 · Charon");
    expect(texts).toContain("Speaker 2 · Kore");
  });

  it("letterbox оставляет картинку целиком в кадре", async () => {
    const harness = createHarness();
    const promise = renderStoryVideo({ frames: FRAMES, slides: SLIDES, audio: AUDIO, fit: "letterbox" }, harness.deps);
    await drive(harness, promise, TIMELINE);

    for (const image of harness.drawnImages) {
      expect(image.dx).toBeGreaterThanOrEqual(0);
      expect(image.dy).toBeGreaterThanOrEqual(0);
      expect(image.dx + image.dw).toBeLessThanOrEqual(VIDEO_WIDTH + 0.01);
      expect(image.dy + image.dh).toBeLessThanOrEqual(VIDEO_HEIGHT + 0.01);
    }
  });

  it("прогресс растёт монотонно и доходит до 100%", async () => {
    const harness = createHarness();
    const seen: number[] = [];
    const promise = renderStoryVideo(
      { frames: FRAMES, slides: SLIDES, audio: AUDIO, onProgress: (percent) => seen.push(percent) },
      harness.deps
    );
    await drive(harness, promise, TIMELINE);

    expect(seen.length).toBeGreaterThan(1);
    expect(seen[seen.length - 1]).toBe(100);
    for (let i = 1; i < seen.length; i += 1) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
  });

  it("в конце запись остановлена, дорожки заглушены, AudioContext закрыт", async () => {
    const harness = createHarness();
    const promise = renderStoryVideo({ frames: FRAMES, slides: SLIDES, audio: AUDIO }, harness.deps);
    await drive(harness, promise, TIMELINE);

    expect(harness.events).toContain("recorder.stop");
    expect(harness.events).toContain("close");
    expect(harness.sources.every((source) => source.stopped)).toBe(true);
    expect(harness.hasPending()).toBe(false);
  });
});

describe("renderStoryVideo: отмена и отказы", () => {
  it("«Стоп» прерывает сборку без сообщения об ошибке", async () => {
    const harness = createHarness();
    const controller = new AbortController();
    const promise = renderStoryVideo(
      { frames: FRAMES, slides: SLIDES, audio: AUDIO, signal: controller.signal },
      harness.deps
    );
    const aborted = expect(promise).rejects.toMatchObject({ name: "AbortError" });

    await harness.flush();
    await harness.step(0.2);
    controller.abort();
    await harness.flush();

    await aborted;
    expect(harness.events).toContain("recorder.stop");
    expect(harness.events).toContain("close");
    expect(harness.hasPending()).toBe(false);
  });

  it("отмена до старта не оставляет висящих дорожек", async () => {
    const harness = createHarness();
    const controller = new AbortController();
    controller.abort();

    await expect(
      renderStoryVideo({ frames: FRAMES, slides: SLIDES, audio: AUDIO, signal: controller.signal }, harness.deps)
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(harness.recorder.state).toBe("inactive");
  });

  it("браузер без записи видео получает понятную причину", async () => {
    const harness = createHarness({ canRecord: () => false });
    await expect(
      renderStoryVideo({ frames: FRAMES, slides: SLIDES, audio: AUDIO }, harness.deps)
    ).rejects.toThrow(NO_RECORDER_MESSAGE);
    expect(harness.events).not.toContain("createRecorder");
  });

  it("пустая история и слайд без картинки объясняются по-человечески", async () => {
    const harness = createHarness();
    await expect(renderStoryVideo({ frames: [], slides: {}, audio: {} }, harness.deps)).rejects.toThrow(
      NO_FRAMES_MESSAGE
    );
    await expect(
      renderStoryVideo({ frames: FRAMES, slides: { s1: SLIDES.s1 }, audio: AUDIO }, harness.deps)
    ).rejects.toThrow(NO_IMAGE_MESSAGE("s2"));
  });

  it("без 2D-контекста сборка не начинается", async () => {
    const harness = createHarness({ noContext: true });
    await expect(
      renderStoryVideo({ frames: FRAMES, slides: SLIDES, audio: AUDIO }, harness.deps)
    ).rejects.toThrow(NO_CANVAS_MESSAGE);
    expect(harness.events).not.toContain("recorder.start");
  });

  it("слайд без озвучки не роняет сборку: кадр показывается, дорожки нет", async () => {
    const harness = createHarness();
    const promise = renderStoryVideo({ frames: FRAMES, slides: SLIDES, audio: { s1: AUDIO.s1 } }, harness.deps);
    const video = (await drive(harness, promise, TIMELINE)) as Awaited<ReturnType<typeof renderStoryVideo>>;

    expect(harness.sources).toHaveLength(1);
    expect(video.duration).toBeCloseTo(totalSeconds(FRAMES), 5);
  });
});

describe("locateFrame: что на экране в момент времени", () => {
  it("находит слайд, его номер и локальное время", () => {
    expect(locateFrame(FRAMES, 0)?.frame.slideId).toBe("s1");
    expect(locateFrame(FRAMES, 1)?.index).toBe(0);
    expect(locateFrame(FRAMES, 1)?.local).toBeCloseTo(1, 5);

    const second = locateFrame(FRAMES, 3 + TAIL_SECONDS + 1);
    expect(second?.frame.slideId).toBe("s2");
    expect(second?.index).toBe(1);
    expect(second?.local).toBeCloseTo(1, 5);

    expect(locateFrame(FRAMES, totalSeconds(FRAMES))).toBeNull();
    expect(locateFrame(FRAMES, -1)).toBeNull();
  });
});

describe("drawSlideFrame: кадр и субтитры", () => {
  const state = {
    width: VIDEO_WIDTH,
    height: VIDEO_HEIGHT,
    fit: "cover" as const,
    image: { width: 1000, height: 2000 },
    reveal: 1,
    progress: 0.5,
    speakerLabel: "Speaker 1 · Charon",
    subtitle: "Ребята, начинаем?",
    cueAge: 1,
  };

  it("рисует фон, картинку, подпись, субтитр и полосу прогресса", () => {
    const harness = createHarness();
    drawSlideFrame(harness.ctx, state);

    expect(harness.drawnImages).toHaveLength(1);
    expect(harness.drawnTexts.map((item) => item.text)).toEqual(
      expect.arrayContaining(["Ребята, начинаем?", "Speaker 1 · Charon"])
    );
    // Полоса прогресса — тонкая полоса во всю ширину внизу кадра.
    const bar = harness.fillRects.find((rect) => rect.w === VIDEO_WIDTH && rect.h === 6);
    expect(bar).toBeTruthy();
    expect(harness.fillRects.some((rect) => rect.w === VIDEO_WIDTH * 0.5)).toBe(true);
  });

  it("субтитр появляется плавно: в начале строки прозрачность ниже", () => {
    const harness = createHarness();
    drawSlideFrame(harness.ctx, { ...state, cueAge: 0 });
    const faded = harness.drawnTexts.find((item) => item.text === "Ребята, начинаем?");
    expect(faded?.alpha).toBeLessThan(1);

    const harness2 = createHarness();
    drawSlideFrame(harness2.ctx, { ...state, cueAge: 1 });
    const shown = harness2.drawnTexts.find((item) => item.text === "Ребята, начинаем?");
    expect(shown?.alpha).toBe(1);
  });

  it("без картинки и субтитра кадр не падает", () => {
    const harness = createHarness();
    expect(() =>
      drawSlideFrame(harness.ctx, { width: VIDEO_WIDTH, height: VIDEO_HEIGHT, fit: "cover", reveal: 0, progress: 0 })
    ).not.toThrow();
    expect(harness.drawnImages).toHaveLength(0);
    expect(harness.drawnTexts).toHaveLength(0);
  });

  it("заголовок рисуется только на первом кадре", () => {
    const harness = createHarness();
    drawSlideFrame(harness.ctx, { ...state, introTitle: "История" });
    expect(harness.drawnTexts.map((item) => item.text)).toContain("История");
  });
});

describe("wrapText: перенос субтитра по ширине", () => {
  const harness = createHarness();

  it("короткая строка остаётся одной", () => {
    expect(wrapText(harness.ctx, "Привет", 400)).toEqual(["Привет"]);
  });

  it("длинная строка переносится по словам и не шире кадра", () => {
    const lines = wrapText(harness.ctx, "Очень длинная строка субтитра, которая не помещается целиком", 200);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length * 8).toBeLessThanOrEqual(200 + 8);
  });

  it("не влезшее обрезается многоточием в две строки", () => {
    const lines = wrapText(harness.ctx, Array.from({ length: 30 }, (_, i) => `слово${i + 1}`).join(" "), 120);
    expect(lines).toHaveLength(2);
    expect(lines[1].endsWith("…")).toBe(true);
  });

  it("пустой текст не даёт строк", () => {
    expect(wrapText(harness.ctx, "   ", 400)).toEqual([]);
  });
});

describe("renderPoster: превью истории для чата", () => {
  it("рисует первый слайд с подписью и субтитром", () => {
    const harness = createHarness();
    const poster = renderPoster(FRAMES, SLIDES, harness.deps, { introTitle: "История" });

    expect(poster).toBe("data:image/jpeg;base64,POSTER");
    expect(harness.drawnImages).toHaveLength(1);
    expect(harness.drawnTexts.map((item) => item.text)).toContain("Ребята, начинаем?");
    expect(harness.canvas.width).toBe(VIDEO_WIDTH);
  });

  it("без слайдов и без картинки первого слайда постера нет", () => {
    const harness = createHarness();
    expect(renderPoster([], {}, harness.deps)).toBe("");
    // Постер — это первый кадр: нет картинки первого слайда, нет и превью.
    expect(renderPoster(FRAMES, { s2: SLIDES.s2 }, harness.deps)).toBe("");
    expect(renderPoster(FRAMES, { s1: SLIDES.s1 }, harness.deps)).toBe("data:image/jpeg;base64,POSTER");
  });

  it("без 2D-контекста постер не рисуется", () => {
    const harness = createHarness({ noContext: true });
    expect(renderPoster(FRAMES, SLIDES, harness.deps)).toBe("");
  });
});

describe("стражи: сборка идёт в браузере", () => {
  it("движок не ходит в сеть и не зовёт внешние очереди рендеринга", () => {
    const source = readFileSync(resolve(process.cwd(), "src/lib/videoRecorder.ts"), "utf8");
    expect(source).not.toMatch(/\bfetch\(/);
    expect(source).not.toMatch(/supabase|functions\/v1/i);
    // Всё собирается локально: холст, звуковой поток и запись MediaRecorder.
    expect(source).toContain("captureStream");
    expect(source).toContain("createMediaStreamDestination");
    expect(source).toContain("createRecorder");
    expect(source).toContain("audioCtx.currentTime");
  });

  it("браузерные зависимости — настоящие API, а не заглушки", () => {
    expect(typeof browserDeps.createCanvas).toBe("function");
    expect(typeof browserDeps.decodeAudio).toBe("function");
    expect(typeof browserDeps.requestFrame).toBe("function");
  });
});
