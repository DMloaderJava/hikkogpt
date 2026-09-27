import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { useVideoStory, STORY_STEPS_TOTAL, STAGE_TITLES, type StoryStage } from "@/hooks/useVideoStory";
import { DIALOG_TTS_FN } from "@/hooks/useMangaVoice";
import { EDGE_FUNCTIONS_URL } from "@/lib/edgeAuth";
import { MAX_STORY_SLIDES, TAIL_SECONDS } from "@/lib/videoStory";
import type {
  AudioBufferLike,
  Canvas2DLike,
  CanvasLike,
  MediaRecorderLike,
  MediaStreamLike,
  RecorderDeps,
} from "@/lib/videoRecorder";

/**
 * Студия видео-историй: пять этапов, озвучка слайдов через `dialog-tts`,
 * сборка видео в браузере и результат (скачивание + отправка в чат).
 *
 * Метод запросов тот же, что в чате и в озвучивателе манги, поэтому проверяются
 * заголовки и signal, отмена без ошибки, точная причина сбоя и то, что сбой
 * одного слайда не роняет всю историю.
 */

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const AUDIO_SECONDS = 2;

interface RecordedCall {
  url: string;
  body: Record<string, unknown> & {
    transcript?: string;
    voices?: Record<string, string>;
    styles?: Record<string, string>;
  };
  init: RequestInit;
}

const calls: RecordedCall[] = [];
const created: string[] = [];
const revoked: string[] = [];
const clicks: { href: string; download: string }[] = [];
let urlSeq = 0;
type Handler = (index: number, init: RequestInit) => Promise<unknown>;
let handler: Handler;

/** Подставные canvas / AudioContext / MediaRecorder: движок пишет видео «понарошку». */
function createDeps(options: { framesHang?: boolean } = {}) {
  let time = 0;
  const stats = { images: 0, recorderStarts: 0, recorderStops: 0, sources: [] as { when?: number }[] };

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
    save: () => {},
    restore: () => {},
    fillRect: () => {},
    clearRect: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    arc: () => {},
    fill: () => {},
    stroke: () => {},
    drawImage: () => {},
    measureText: (text: string) => ({ width: text.length * 8 }),
    fillText: () => {},
    createLinearGradient: () => ({}),
  };
  const canvas: CanvasLike = {
    width: 0,
    height: 0,
    getContext: () => ctx,
    captureStream: () => ({ getAudioTracks: () => [], getVideoTracks: () => [], addTrack: () => {} }) as MediaStreamLike,
    toDataURL: () => "data:image/jpeg;base64,POSTER",
  };
  const recorder: MediaRecorderLike = {
    state: "inactive",
    ondataavailable: null,
    onstop: null,
    onerror: null,
    start() {
      recorder.state = "recording";
      stats.recorderStarts += 1;
    },
    stop() {
      recorder.state = "inactive";
      stats.recorderStops += 1;
      recorder.ondataavailable?.({ data: new Blob(["видео"], { type: "video/webm" }) });
      recorder.onstop?.();
    },
  };

  const deps: RecorderDeps = {
    createCanvas: () => canvas,
    loadImage: async () => {
      stats.images += 1;
      return { width: 1000, height: 2000 };
    },
    createAudioContext: () => ({
      get currentTime() {
        return time;
      },
      sampleRate: 48000,
      state: "running",
      destination: {},
      resume: async () => {},
      close: async () => {},
      createMediaStreamDestination: () => ({
        stream: { getAudioTracks: () => [{ id: "audio" }], getVideoTracks: () => [], addTrack: () => {} },
      }),
      createBufferSource: () => {
        const source = { when: undefined as number | undefined };
        stats.sources.push(source);
        return {
          buffer: null as AudioBufferLike | null,
          connect: () => {},
          start: (when?: number) => {
            source.when = when;
          },
          stop: () => {},
        };
      },
    }),
    createRecorder: () => recorder,
    canRecord: (mime) => mime.startsWith("video/webm"),
    // Цикл отрисовки крутится сам: каждый кадр двигает часы AudioContext.
    requestFrame: (callback) => {
      if (options.framesHang) return 1;
      setTimeout(() => {
        time += 0.5;
        callback();
      }, 0);
      return 1;
    },
    cancelFrame: () => {},
    decodeAudio: async () => ({
      duration: AUDIO_SECONDS,
      sampleRate: 48000,
      numberOfChannels: 1,
      length: AUDIO_SECONDS * 48000,
    }),
  };

  return { deps, stats, recorder };
}

function pngFile(name: string) {
  return new File([`bytes-of-${name}`], name, { type: "image/png" });
}

const audioResponse = () => ({
  ok: true,
  status: 200,
  blob: async () => new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/wav" }),
});

const jsonResponse = (data: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => data,
  text: async () => JSON.stringify(data),
});

/** Зависания запроса: ответ приходит только по отмене сигнала. */
const hangingResponse = (init: RequestInit) =>
  new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
  });

function setup(options: { deps?: RecorderDeps; onShare?: (payload: { text: string; images: string[] }) => void; title?: string } = {}) {
  const harness = createDeps();
  return renderHook(() =>
    useVideoStory({ deps: options.deps ?? harness.deps, onShare: options.onShare, title: options.title })
  );
}

/** Добавляет слайды и проставляет им реплики по порядку. */
async function addSlides(hook: ReturnType<typeof setup>, count: number, text = (i: number) => `Реплика слайда ${i + 1}`) {
  await act(async () => {
    hook.result.current.addFiles(Array.from({ length: count }, (_, i) => pngFile(`s${i + 1}.png`)));
  });
  await act(async () => {
    hook.result.current.slides.forEach((slide, index) => hook.result.current.setSlideText(slide.id, text(index)));
  });
}

beforeEach(() => {
  urlSeq = 0;
  calls.length = 0;
  created.length = 0;
  revoked.length = 0;
  clicks.length = 0;
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.success).mockClear();

  URL.createObjectURL = vi.fn(() => {
    urlSeq += 1;
    const url = `blob:mock-${urlSeq}`;
    created.push(url);
    return url;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn((url: string) => {
    revoked.push(url);
  });

  // Предпрослушивание дорожки: jsdom не умеет играть звук.
  class FakeAudio {
    static instances: FakeAudio[] = [];
    src = "";
    paused = true;
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(src?: string) {
      this.src = src ?? "";
      FakeAudio.instances.push(this);
    }
    play() {
      this.paused = false;
      return Promise.resolve();
    }
    pause() {
      this.paused = true;
    }
  }
  FakeAudio.instances = [];
  vi.stubGlobal("Audio", FakeAudio);

  // Скачивание: ссылка настоящая (иначе appendChild не примет её), а клик
  // перехвачен — в jsdom загрузка файла всё равно не происходит.
  vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
    const element = document.createElementNS("http://www.w3.org/1999/xhtml", tag) as HTMLElement;
    if (tag === "a") {
      vi.spyOn(element as HTMLAnchorElement, "click").mockImplementation(() => {
        const anchor = element as HTMLAnchorElement;
        clicks.push({ href: anchor.href, download: anchor.download });
      });
    }
    return element;
  });

  handler = async () => audioResponse();
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as RecordedCall["body"]) : {};
    calls.push({ url, body, init: init ?? {} });
    return handler(calls.length - 1, init ?? {}) as never;
  }) as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("студия: этап 1 — материалы", () => {
  it("слайды добавляются по порядку, говорящие чередуются как в макете", async () => {
    const hook = setup();
    await act(async () => {
      hook.result.current.addFiles([pngFile("a.png"), pngFile("b.png"), pngFile("c.png")]);
    });

    expect(hook.result.current.slides).toHaveLength(3);
    expect(hook.result.current.slides.map((slide) => slide.file.name)).toEqual(["a.png", "b.png", "c.png"]);
    // Слайд 1 → Speaker 1, слайд 2 → Speaker 2, слайд 3 → снова Speaker 1.
    expect(hook.result.current.scriptList.map((item) => item.speaker)).toEqual([1, 2, 1]);
    expect(hook.result.current.slides.every((slide) => slide.url.startsWith("blob:mock-"))).toBe(true);
  });

  it("чужой формат не добавляется, причина видна", async () => {
    const hook = setup();
    await act(async () => {
      hook.result.current.addFiles([new File(["x"], "clip.gif", { type: "image/gif" })]);
    });

    expect(hook.result.current.slides).toHaveLength(0);
    expect(hook.result.current.error).toMatch(/PNG, JPEG или WebP/);
    expect(toast.error).toHaveBeenCalled();
  });

  it("больше предела слайдов не добавляется, и это объясняют", async () => {
    const hook = setup();
    await act(async () => {
      hook.result.current.addFiles(Array.from({ length: MAX_STORY_SLIDES + 3 }, (_, i) => pngFile(`s${i}.png`)));
    });

    expect(hook.result.current.slides).toHaveLength(MAX_STORY_SLIDES);
    expect(hook.result.current.error).toContain(`${MAX_STORY_SLIDES} слайдов`);
  });

  it("сортировка переносит слайд вместе с его репликой", async () => {
    const hook = setup();
    await addSlides(hook, 3);
    const ids = hook.result.current.slides.map((slide) => slide.id);

    await act(async () => {
      hook.result.current.moveSlide(0, 2);
    });

    expect(hook.result.current.slides.map((slide) => slide.id)).toEqual([ids[1], ids[2], ids[0]]);
    expect(hook.result.current.slides.map((slide) => slide.file.name)).toEqual(["s2.png", "s3.png", "s1.png"]);
    // Реплика уехала вместе со слайдом.
    expect(hook.result.current.scriptList.map((item) => item.text)).toEqual([
      "Реплика слайда 2",
      "Реплика слайда 3",
      "Реплика слайда 1",
    ]);
  });

  it("удаление слайда отзывает его превью", async () => {
    const hook = setup();
    await addSlides(hook, 2);
    const url = hook.result.current.slides[0].url;
    const id = hook.result.current.slides[0].id;

    await act(async () => {
      hook.result.current.removeSlide(id);
    });

    expect(hook.result.current.slides).toHaveLength(1);
    expect(revoked).toContain(url);
    expect(hook.result.current.script[id]).toBeUndefined();
  });

  it("переход на этап 2 закрыт, пока нет слайдов", async () => {
    const hook = setup();
    expect(hook.result.current.canGoStage(2)).toBe(false);
    expect(hook.result.current.stage).toBe(1);

    let moved = false;
    act(() => {
      moved = hook.result.current.setStage(2 as StoryStage);
    });
    expect(moved).toBe(false);
    expect(hook.result.current.stage).toBe(1);

    await addSlides(hook, 1);
    act(() => {
      moved = hook.result.current.setStage(2 as StoryStage);
    });
    expect(moved).toBe(true);
    expect(hook.result.current.stage).toBe(2);
  });
});

describe("студия: этап 2 — персонажи и голоса", () => {
  it("по умолчанию Speaker 1 — Charon, Speaker 2 — Kore", () => {
    const hook = setup();
    expect(hook.result.current.characters.map((c) => c.voice)).toEqual(["Charon", "Kore"]);
    expect(hook.result.current.characters[0].context).toMatch(/глубок|харизмат|уверен/i);
    expect(hook.result.current.characters[1].context).toMatch(/живо|выразител|тёпл|женск/i);
  });

  it("представление персонажа правится и уходит в озвучку", async () => {
    const hook = setup();
    await addSlides(hook, 1);
    await act(async () => {
      hook.result.current.setCharacter(1, { context: "строгий ментор", name: "Наставник" });
    });
    expect(hook.result.current.characters[0].context).toBe("строгий ментор");
    expect(hook.result.current.characters[0].name).toBe("Наставник");

    await act(async () => {
      await hook.result.current.generate();
    });
    expect(calls[0].body.styles).toEqual({ "1": "строгий ментор" });
  });

  it("голос не из списка dialog-tts не принимается", () => {
    const hook = setup();
    act(() => {
      hook.result.current.setCharacter(1, { voice: "onyx" as never });
    });
    expect(hook.result.current.characters[0].voice).toBe("Charon");

    act(() => {
      hook.result.current.setCharacter(2, { voice: "Fenrir" });
    });
    expect(hook.result.current.characters[1].voice).toBe("Fenrir");
  });

  it("нового говорящего можно добавить, а при удалении его слайды переходят первому", async () => {
    const hook = setup();
    await addSlides(hook, 3);

    act(() => {
      expect(hook.result.current.addCharacter()).toBe(true);
    });
    expect(hook.result.current.characters).toHaveLength(3);
    expect(hook.result.current.characters[2].speaker).toBe(3);

    await act(async () => {
      hook.result.current.setSlideSpeaker(hook.result.current.slides[2].id, 3);
    });
    expect(hook.result.current.scriptList[2].speaker).toBe(3);

    act(() => {
      expect(hook.result.current.removeCharacter(3)).toBe(true);
    });
    expect(hook.result.current.characters).toHaveLength(2);
    expect(hook.result.current.scriptList[2].speaker).toBe(1);
    // Последнего говорящего убрать нельзя: история останется без голосов.
    act(() => {
      expect(hook.result.current.removeCharacter(1)).toBe(true);
      expect(hook.result.current.removeCharacter(2)).toBe(false);
    });
  });
});

describe("студия: этап 4 — озвучка и сборка", () => {
  it("каждый слайд озвучивается своим запросом в dialog-tts", async () => {
    const hook = setup();
    await addSlides(hook, 2);

    let ok = false;
    await act(async () => {
      ok = await hook.result.current.generate();
    });

    expect(ok).toBe(true);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.url).toBe(`${EDGE_FUNCTIONS_URL}/${DIALOG_TTS_FN}`);
      expect(call.init.method).toBe("POST");
      expect(call.init.signal).toBeInstanceOf(AbortSignal);
      const headers = call.init.headers as Record<string, string>;
      expect(headers.Authorization).toMatch(/^Bearer /);
      expect(headers.apikey).toBe(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY);
    }
    // Формат тот же, что в озвучивателе манги: «Speaker N: текст» + карта голосов.
    expect(calls[0].body.transcript).toBe("Speaker 1: Реплика слайда 1");
    expect(calls[0].body.voices).toEqual({ "1": "Charon" });
    expect(calls[1].body.transcript).toBe("Speaker 2: Реплика слайда 2");
    expect(calls[1].body.voices).toEqual({ "2": "Kore" });
  });

  it("пустые реплики не доходят до озвучки: причина и возврат к сценарию", async () => {
    const hook = setup();
    await act(async () => {
      hook.result.current.addFiles([pngFile("a.png"), pngFile("b.png")]);
    });
    await act(async () => {
      hook.result.current.setSlideText(hook.result.current.slides[0].id, "Всё понятно");
    });

    let ok = true;
    await act(async () => {
      ok = await hook.result.current.generate();
    });

    expect(ok).toBe(false);
    expect(calls).toHaveLength(0);
    expect(hook.result.current.stage).toBe(3);
    expect(hook.result.current.error).toMatch(/Ошибка запроса api/);
    expect(hook.result.current.error).toMatch(/слайд 2: нет реплики/);
    expect(hook.result.current.failure?.stage).toBe("dialog-check");
  });

  it("видео собирается: этап 5, длительность от реплик, файл и постер", async () => {
    const harness = createDeps();
    const hook = setup({ deps: harness.deps, title: "Моя история" });
    await addSlides(hook, 2);

    await act(async () => {
      await hook.result.current.generate();
    });

    const video = hook.result.current.video;
    expect(video).toBeTruthy();
    expect(hook.result.current.stage).toBe(5);
    expect(hook.result.current.progress.percent).toBe(100);
    expect(hook.result.current.progress.label).toContain(`Этап ${STORY_STEPS_TOTAL} из ${STORY_STEPS_TOTAL}`);
    // Два слайда по 2 с озвучки + пауза: длительность считается от дорожек.
    expect(video?.duration).toBeCloseTo(2 * (AUDIO_SECONDS + TAIL_SECONDS), 5);
    expect(video?.ext).toBe("webm");
    expect(video?.fileName).toMatch(/^hikko-.*\.webm$/);
    expect(video?.poster).toBe("data:image/jpeg;base64,POSTER");
    expect(hook.result.current.videoUrl.startsWith("blob:mock-")).toBe(true);
    expect(harness.stats.images).toBe(2);
    expect(harness.stats.recorderStarts).toBe(1);
    expect(harness.stats.recorderStops).toBe(1);
    expect(toast.success).toHaveBeenCalled();
  });

  it("дорожки встают в очередь по таймлайну слайдов", async () => {
    const harness = createDeps();
    const hook = setup({ deps: harness.deps });
    await addSlides(hook, 2);

    await act(async () => {
      await hook.result.current.generate();
    });

    expect(harness.stats.sources).toHaveLength(2);
    const [first, second] = harness.stats.sources;
    expect(second.when).toBeGreaterThan(Number(first.when));
    expect(Number(second.when) - Number(first.when)).toBeCloseTo(AUDIO_SECONDS + TAIL_SECONDS, 5);
  });

  it("сбой одного слайда не останавливает историю: слайд помечен, видео собрано", async () => {
    const hook = setup();
    handler = async (index) => (index === 0 ? jsonResponse({ error: "Слишком много запросов" }, 429) : audioResponse());
    await addSlides(hook, 3);

    let ok = false;
    await act(async () => {
      ok = await hook.result.current.generate();
    });

    expect(ok).toBe(true);
    expect(calls).toHaveLength(3);
    expect(hook.result.current.slideIssues).toHaveLength(1);
    expect(hook.result.current.slideIssues[0].reason).toMatch(/Слишком много запросов|озвучк/i);
    expect(hook.result.current.readySlides).toHaveLength(2);
    expect(hook.result.current.video).toBeTruthy();
    // Причина первого сбоя показана целиком, в формате «Ошибка запроса api (…)».
    expect(hook.result.current.error).toMatch(/^Ошибка запроса api \(/);
    expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1);
  });

  it("если не озвучено ничего, видео не собирается и причина видна", async () => {
    const hook = setup();
    handler = async () => jsonResponse({ error: "Сервис озвучки недоступен" }, 502);
    await addSlides(hook, 2);

    let ok = true;
    await act(async () => {
      ok = await hook.result.current.generate();
    });

    expect(ok).toBe(false);
    expect(hook.result.current.video).toBeNull();
    expect(hook.result.current.stage).toBe(4);
    expect(hook.result.current.error).toMatch(/Ошибка запроса api/);
  });

  it("stop() прерывает озвучку, и это не считается ошибкой", async () => {
    const hook = setup();
    handler = async (_index, init) => hangingResponse(init);
    await addSlides(hook, 2);

    let finished!: Promise<boolean>;
    act(() => {
      finished = hook.result.current.generate();
    });
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(hook.result.current.isBusy).toBe(true);

    await act(async () => {
      hook.result.current.stop();
      await finished;
    });

    expect(hook.result.current.error).toBe("");
    expect(hook.result.current.failure).toBeNull();
    expect(hook.result.current.isBusy).toBe(false);
    expect(hook.result.current.video).toBeNull();
    expect(hook.result.current.progress.detail).toBe("Остановлено");
  });

  it("stop() прерывает запись видео: рекордер остановлен, файла нет", async () => {
    const harness = createDeps({ framesHang: true });
    const hook = setup({ deps: harness.deps });
    await addSlides(hook, 1);

    let finished!: Promise<boolean>;
    act(() => {
      finished = hook.result.current.generate();
    });
    await waitFor(() => expect(harness.stats.recorderStarts).toBe(1));

    await act(async () => {
      hook.result.current.stop();
      await finished;
    });

    expect(harness.stats.recorderStops).toBe(1);
    expect(hook.result.current.video).toBeNull();
    expect(hook.result.current.error).toBe("");
  });

  it("браузер без записи видео объясняет это, а не отдаёт пустой файл", async () => {
    const harness = createDeps();
    harness.deps.canRecord = () => false;
    const hook = setup({ deps: harness.deps });
    await addSlides(hook, 1);

    await act(async () => {
      await hook.result.current.generate();
    });

    expect(hook.result.current.video).toBeNull();
    expect(hook.result.current.error).toMatch(/MediaRecorder/);
  });

  it("правка реплики сбрасывает прежнюю дорожку слайда", async () => {
    const hook = setup();
    await addSlides(hook, 1);
    await act(async () => {
      await hook.result.current.generate();
    });
    expect(hook.result.current.readySlides).toHaveLength(1);
    const stale = Object.values(hook.result.current.tracks)[0]?.url;

    await act(async () => {
      hook.result.current.setSlideText(hook.result.current.slides[0].id, "Новая реплика");
    });

    expect(hook.result.current.tracks[hook.result.current.slides[0].id]).toBeUndefined();
    expect(revoked).toContain(stale);
    expect(hook.result.current.readySlides).toHaveLength(0);
  });
});

describe("студия: этап 5 — результат", () => {
  it("скачивание отдаёт файл с верным именем", async () => {
    const hook = setup({ title: "История" });
    await addSlides(hook, 1);
    await act(async () => {
      await hook.result.current.generate();
    });

    let saved = false;
    act(() => {
      saved = hook.result.current.download();
    });

    expect(saved).toBe(true);
    expect(clicks).toHaveLength(1);
    expect(clicks[0].download).toMatch(/^hikko-.*\.webm$/);
    expect(clicks[0].href.startsWith("blob:mock-")).toBe(true);
  });

  it("без готового видео скачивать и отправлять нечего", () => {
    const onShare = vi.fn();
    const hook = setup({ onShare });
    expect(hook.result.current.download()).toBe(false);
    expect(hook.result.current.share()).toBe(false);
    expect(onShare).not.toHaveBeenCalled();
    expect(clicks).toHaveLength(0);
  });

  it("отправка в чат: текст с параметрами истории и постер первого кадра", async () => {
    const onShare = vi.fn();
    const hook = setup({ onShare, title: "Моя история" });
    await addSlides(hook, 2);
    await act(async () => {
      await hook.result.current.generate();
    });

    let shared = false;
    act(() => {
      shared = hook.result.current.share();
    });

    expect(shared).toBe(true);
    expect(onShare).toHaveBeenCalledTimes(1);
    const payload = onShare.mock.calls[0][0] as { text: string; images: string[] };
    expect(payload.text).toContain("Видео-история «Моя история»");
    expect(payload.text).toContain("2 слайдов");
    expect(payload.text).toMatch(/Длительность \d+:\d{2}/);
    expect(payload.images).toEqual(["data:image/jpeg;base64,POSTER"]);
    expect(toast.success).toHaveBeenCalled();
  });

  it("предпрослушивание включает дорожку слайда и глушит прежний звук", async () => {
    const hook = setup();
    await addSlides(hook, 2);
    await act(async () => {
      await hook.result.current.generate();
    });

    const [first, second] = hook.result.current.slides;
    act(() => {
      expect(hook.result.current.previewSlide(first.id)).toBe(true);
    });
    expect(hook.result.current.previewId).toBe(first.id);

    act(() => {
      hook.result.current.previewSlide(second.id);
    });
    expect(hook.result.current.previewId).toBe(second.id);

    act(() => {
      hook.result.current.stopPreview();
    });
    expect(hook.result.current.previewId).toBeNull();

    // Без дорожки предпросмотр не начинается.
    act(() => {
      hook.result.current.removeSlide(second.id);
    });
    expect(hook.result.current.previewSlide(second.id)).toBe(false);
  });

  it("reset() освобождает object URL и возвращает студию на этап 1", async () => {
    const hook = setup();
    await addSlides(hook, 2);
    await act(async () => {
      await hook.result.current.generate();
    });
    const slideUrl = hook.result.current.slides[0].url;
    const videoUrl = hook.result.current.videoUrl;

    act(() => {
      hook.result.current.reset();
    });

    expect(hook.result.current.slides).toHaveLength(0);
    expect(hook.result.current.video).toBeNull();
    expect(hook.result.current.videoUrl).toBe("");
    expect(hook.result.current.stage).toBe(1);
    expect(hook.result.current.characters.map((c) => c.voice)).toEqual(["Charon", "Kore"]);
    expect(revoked).toContain(slideUrl);
    expect(revoked).toContain(videoUrl);
  });

  it("размонтирование гасит незакрытый запрос", async () => {
    const hook = setup();
    handler = async (_index, init) => hangingResponse(init);
    await addSlides(hook, 1);

    act(() => {
      void hook.result.current.generate();
    });
    await waitFor(() => expect(calls.length).toBe(1));
    const signal = calls[0].init.signal as AbortSignal;
    expect(signal.aborted).toBe(false);

    hook.unmount();
    expect(signal.aborted).toBe(true);
  });
});

describe("студия: этапы и подписи", () => {
  it("пять этапов с понятными названиями", () => {
    expect(STORY_STEPS_TOTAL).toBe(5);
    expect(STAGE_TITLES[1]).toMatch(/Материалы/);
    expect(STAGE_TITLES[2]).toMatch(/Персонажи и голоса/);
    expect(STAGE_TITLES[3]).toMatch(/Сценарий/);
    expect(STAGE_TITLES[4]).toMatch(/Генерация и сборка/);
    expect(STAGE_TITLES[5]).toMatch(/Готовое видео/);
  });

  it("процесс виден: этап, проценты и детали во время озвучки", async () => {
    const hook = setup();
    await addSlides(hook, 2);

    let finished!: Promise<boolean>;
    act(() => {
      finished = hook.result.current.generate();
    });
    await waitFor(() => expect(hook.result.current.progress.label).toMatch(/Этап 4 из 5/));

    await act(async () => {
      await finished;
    });
    expect(hook.result.current.progress.label).toMatch(/Этап 5 из 5/);
  });
});
