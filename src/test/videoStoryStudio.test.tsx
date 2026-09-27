import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { toast } from "sonner";
import { VideoStoryStudio } from "@/components/VideoStoryStudio";
import { STORY_STEPS_TOTAL } from "@/hooks/useVideoStory";
import { DIALOG_TTS_FN } from "@/hooks/useMangaVoice";
import { EDGE_FUNCTIONS_URL } from "@/lib/edgeAuth";
import { MAX_STORY_SLIDES } from "@/lib/videoStory";
import type {
  AudioBufferLike,
  Canvas2DLike,
  CanvasLike,
  MediaRecorderLike,
  MediaStreamLike,
  RecorderDeps,
} from "@/lib/videoRecorder";

/**
 * Студия видео-историй целиком: пять этапов, drag-and-drop слайдов, профили
 * персонажей, сценарий по слайдам, сборка в браузере, плеер с субтитрами,
 * скачивание и отправка в чат.
 *
 * Движок записи подставной (в jsdom нет canvas 2d, AudioContext и MediaRecorder),
 * поэтому проверка идёт по тому, что видит пользователь и какие запросы уходят.
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

function createDeps(options: { canRecord?: boolean } = {}) {
  let time = 0;
  const stats = { images: 0, recorderStarts: 0, recorderStops: 0 };

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
    captureStream: () =>
      ({ getAudioTracks: () => [], getVideoTracks: () => [], addTrack: () => {} }) as MediaStreamLike,
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
      createBufferSource: () => ({
        buffer: null as AudioBufferLike | null,
        connect: () => {},
        start: () => {},
        stop: () => {},
      }),
    }),
    createRecorder: () => recorder,
    canRecord: (mime) => (options.canRecord === false ? false : mime.startsWith("video/webm")),
    // Цикл отрисовки крутится сам: каждый кадр двигает часы AudioContext.
    requestFrame: (callback) => {
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

function setInputFiles(input: HTMLElement, files: File[]) {
  Object.defineProperty(input, "files", { value: files, configurable: true });
  fireEvent.change(input);
}

const audioResponse = () => ({
  ok: true,
  status: 200,
  blob: async () => new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/wav" }),
});

/** Зависающий запрос: ответ приходит только по отмене сигнала. */
const hangingResponse = (init: RequestInit) =>
  new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
  });

interface StudioOptions {
  deps?: RecorderDeps;
  onShare?: (payload: { text: string; images: string[] }) => void;
  onClose?: () => void;
  title?: string;
}

let onClose: ReturnType<typeof vi.fn>;
let onShare: ReturnType<typeof vi.fn>;

function openStudio(options: StudioOptions = {}) {
  const harness = createDeps();
  onClose = vi.fn(options.onClose);
  onShare = vi.fn(options.onShare);
  const view = render(
    <VideoStoryStudio
      open
      onClose={onClose}
      onShare={options.onShare === null ? undefined : onShare}
      title={options.title}
      deps={options.deps ?? harness.deps}
    />
  );
  return { ...view, deps: options.deps ?? harness.deps, stats: harness.stats, recorder: harness.recorder };
}

/** Этап 1: добавляет слайды; этап 3: прописывает реплики. */
async function prepareStory(count = 2, text = (i: number) => `Реплика слайда ${i + 1}`) {
  // Зона загрузки живёт только на этапе 1 — сначала возвращаемся туда.
  const stageOne = screen.queryByTestId("story-stage-1");
  if (stageOne && !screen.queryByTestId("story-file-input")) {
    await act(async () => {
      fireEvent.click(stageOne);
    });
  }
  await act(async () => {
    setInputFiles(
      screen.getByTestId("story-file-input"),
      Array.from({ length: count }, (_, i) => pngFile(`s${i + 1}.png`))
    );
  });
  await waitFor(() => expect(screen.getByTestId("story-slide-1")).toBeTruthy());
  await act(async () => {
    fireEvent.click(screen.getByTestId("story-stage-3"));
  });
  await waitFor(() => expect(screen.getByTestId("story-script-1")).toBeTruthy());
  await act(async () => {
    for (let i = 0; i < count; i += 1) {
      fireEvent.change(screen.getByTestId(`story-script-${i + 1}`), { target: { value: text(i) } });
    }
  });
}

/** Этап 4 → «Собрать видео». */
async function generate() {
  await act(async () => {
    fireEvent.click(screen.getByTestId("story-stage-4"));
  });
  await waitFor(() => expect(screen.getByTestId("story-generate")).toBeTruthy());
  await act(async () => {
    fireEvent.click(screen.getByTestId("story-generate"));
  });
}

/** Доводит историю до этапа 5 (видео собрано). */
async function buildStory(count = 2) {
  await prepareStory(count);
  await generate();
  await waitFor(() => expect(screen.getByTestId("story-stage").textContent).toContain("ЭТАП 5"));
}

class FakeAudio {
  static instances: FakeAudio[] = [];
  src = "";
  paused = true;
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

beforeEach(() => {
  urlSeq = 0;
  calls.length = 0;
  created.length = 0;
  revoked.length = 0;
  clicks.length = 0;
  FakeAudio.instances = [];
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

  vi.stubGlobal("Audio", FakeAudio);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});

  // Скачивание: ссылка настоящая (иначе appendChild её не примет), клик перехвачен.
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

/* ------------------------------------------------------------------ */
/* Каркас                                                              */
/* ------------------------------------------------------------------ */

describe("студия: каркас", () => {
  it("показывает заголовок, первый этап и все пять шагов", () => {
    openStudio();
    expect(screen.getByTestId("story-modal")).toBeTruthy();
    expect(screen.getByTestId("story-stage").textContent).toContain("ЭТАП 1 / 5");
    for (let step = 1; step <= STORY_STEPS_TOTAL; step += 1) {
      expect(screen.getByTestId(`story-stage-${step}`)).toBeTruthy();
    }
    expect(screen.getByTestId("story-progress")).toBeTruthy();
    expect(screen.getByTestId("story-dropzone")).toBeTruthy();
  });

  it("закрытая студия ничего не рисует", () => {
    render(<VideoStoryStudio open={false} onClose={() => {}} />);
    expect(screen.queryByTestId("story-modal")).toBeNull();
  });

  it("шаги после первого заблокированы, пока нет слайдов", () => {
    openStudio();
    expect((screen.getByTestId("story-stage-2") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("story-next") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("story-back") as HTMLButtonElement).disabled).toBe(true);
  });

  it("Escape и клик по затемнению закрывают студию", () => {
    openStudio();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    const overlay = screen.getByTestId("story-modal").parentElement as HTMLElement;
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(2);

    // Клик внутри окна не закрывает его.
    fireEvent.click(screen.getByTestId("story-modal"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("орбитальный прогресс показывает этап и процент", () => {
    openStudio();
    expect(screen.getByTestId("story-progress-step").textContent).toContain("ЭТАП 1 / 5");
    expect(screen.getByTestId("story-progress").getAttribute("data-active")).toBe("false");
    expect(screen.getByTestId("story-progress-percent").textContent).toBe("0%");
  });
});

/* ------------------------------------------------------------------ */
/* Этап 1: материалы                                                   */
/* ------------------------------------------------------------------ */

describe("студия: этап 1 — материалы", () => {
  it("файлы из выбора становятся слайдами с превью", async () => {
    openStudio();
    await act(async () => {
      setInputFiles(screen.getByTestId("story-file-input"), [pngFile("a.png"), pngFile("b.png")]);
    });
    await waitFor(() => expect(screen.getByTestId("story-slide-2")).toBeTruthy());
    const first = screen.getByTestId("story-slide-1").querySelector("img") as HTMLImageElement;
    expect(first.src).toContain("blob:mock-");
    expect(first.alt).toBe("Слайд 1");
    expect((screen.getByTestId("story-stage-2") as HTMLButtonElement).disabled).toBe(false);
  });

  it("drop в зону загрузки добавляет слайды", async () => {
    openStudio();
    const dataTransfer = { files: [pngFile("drop.png")], types: ["Files"] };
    await act(async () => {
      fireEvent.dragOver(screen.getByTestId("story-dropzone"));
      fireEvent.drop(screen.getByTestId("story-dropzone"), { dataTransfer });
    });
    await waitFor(() => expect(screen.getByTestId("story-slide-1")).toBeTruthy());
  });

  it("чужой формат не проходит и причина видна", async () => {
    openStudio();
    const bad = new File(["gif"], "anim.gif", { type: "image/gif" });
    await act(async () => {
      setInputFiles(screen.getByTestId("story-file-input"), [bad]);
    });
    await waitFor(() => expect(screen.getByTestId("story-error").textContent).toMatch(/png|jpe?g|webp/i));
    expect(screen.queryByTestId("story-slide-1")).toBeNull();
  });

  it("лимит слайдов не превышается, а остаток объяснён", async () => {
    openStudio();
    const files = Array.from({ length: MAX_STORY_SLIDES + 3 }, (_, i) => pngFile(`s${i + 1}.png`));
    await act(async () => {
      setInputFiles(screen.getByTestId("story-file-input"), files);
    });
    await waitFor(() => expect(screen.getByTestId("story-error").textContent).toMatch(/помещается \d+ слайдов/));
    expect(screen.queryByTestId(`story-slide-${MAX_STORY_SLIDES + 1}`)).toBeNull();
    expect(screen.getByTestId(`story-slide-${MAX_STORY_SLIDES}`)).toBeTruthy();
  });

  it("стрелки меняют порядок слайдов", async () => {
    openStudio();
    await prepareStory(2);
    fireEvent.click(screen.getByTestId("story-stage-1"));
    const before = (screen.getByTestId("story-slide-1").querySelector("img") as HTMLImageElement).src;
    await act(async () => {
      fireEvent.click(screen.getByTestId("story-slide-right-1"));
    });
    await waitFor(() =>
      expect((screen.getByTestId("story-slide-1").querySelector("img") as HTMLImageElement).src).not.toBe(before)
    );
    expect((screen.getByTestId("story-slide-left-1") as HTMLButtonElement).disabled).toBe(true);
  });

  it("перетаскивание карточки меняет порядок", async () => {
    openStudio();
    await prepareStory(2);
    fireEvent.click(screen.getByTestId("story-stage-1"));
    const firstBefore = (screen.getByTestId("story-slide-1").querySelector("img") as HTMLImageElement).src;
    await act(async () => {
      fireEvent.dragStart(screen.getByTestId("story-slide-1"));
      fireEvent.drop(screen.getByTestId("story-slide-2"));
    });
    await waitFor(() =>
      expect((screen.getByTestId("story-slide-1").querySelector("img") as HTMLImageElement).src).not.toBe(firstBefore)
    );
  });

  it("удаление слайда убирает карточку и его реплику", async () => {
    openStudio();
    await prepareStory(2);
    fireEvent.click(screen.getByTestId("story-stage-1"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("story-slide-remove-1"));
    });
    await waitFor(() => expect(screen.queryByTestId("story-slide-2")).toBeNull());
    expect(screen.getByTestId("story-slide-1")).toBeTruthy();
    fireEvent.click(screen.getByTestId("story-stage-3"));
    expect(screen.queryByTestId("story-script-2")).toBeNull();
  });

  it("кнопка «Далее» ведёт на этап персонажей", async () => {
    openStudio();
    await prepareStory(1);
    fireEvent.click(screen.getByTestId("story-stage-1"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("story-next"));
    });
    await waitFor(() => expect(screen.getByTestId("story-stage").textContent).toContain("ЭТАП 2"));
  });
});

/* ------------------------------------------------------------------ */
/* Этап 2: персонажи и голоса                                          */
/* ------------------------------------------------------------------ */

describe("студия: этап 2 — персонажи и голоса", () => {
  async function toCharacters() {
    await prepareStory(1);
    fireEvent.click(screen.getByTestId("story-stage-2"));
    await waitFor(() => expect(screen.getByTestId("story-character-1")).toBeTruthy());
  }

  it("по умолчанию два говорящих: Charon и Kore", async () => {
    openStudio();
    await toCharacters();
    expect((screen.getByTestId("story-name-1") as HTMLInputElement).value).toBe("Charon");
    expect((screen.getByTestId("story-name-2") as HTMLInputElement).value).toBe("Kore");
    expect((screen.getByTestId("story-voice-1") as HTMLSelectElement).value).toBeTruthy();
    expect(screen.getByTestId("story-character-2")).toBeTruthy();
  });

  it("голос, имя и контекст персонажа редактируются", async () => {
    openStudio();
    await toCharacters();
    const voice = screen.getByTestId("story-voice-2") as HTMLSelectElement;
    const other = Array.from(voice.options).find((option) => option.value !== voice.value)?.value ?? voice.value;
    await act(async () => {
      fireEvent.change(voice, { target: { value: other } });
      fireEvent.change(screen.getByTestId("story-name-2"), { target: { value: "Наставница" } });
      fireEvent.change(screen.getByTestId("story-context-1"), { target: { value: "строгий ментор" } });
    });
    await waitFor(() => expect((screen.getByTestId("story-voice-2") as HTMLSelectElement).value).toBe(other));
    expect((screen.getByTestId("story-name-2") as HTMLInputElement).value).toBe("Наставница");
    expect((screen.getByTestId("story-context-1") as HTMLTextAreaElement).value).toBe("строгий ментор");
  });

  it("контекст персонажа уходит в запрос озвучки как styles", async () => {
    openStudio();
    await toCharacters();
    await act(async () => {
      fireEvent.change(screen.getByTestId("story-context-1"), { target: { value: "строгий ментор, говорит весомо" } });
    });
    await generate();
    await waitFor(() => expect(screen.getByTestId("story-stage").textContent).toContain("ЭТАП 5"));
    expect(calls[0].body.styles).toEqual({ "1": "строгий ментор, говорит весомо" });
  });

  it("говорящего можно добавить и убрать", async () => {
    openStudio();
    await toCharacters();
    await act(async () => {
      fireEvent.click(screen.getByTestId("story-add-character"));
    });
    await waitFor(() => expect(screen.getByTestId("story-character-3")).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByTestId("story-remove-character-3"));
    });
    await waitFor(() => expect(screen.queryByTestId("story-character-3")).toBeNull());
  });

  it("последнего говорящего убрать нельзя", async () => {
    openStudio();
    await toCharacters();
    await act(async () => {
      fireEvent.click(screen.getByTestId("story-remove-character-2"));
    });
    await waitFor(() => expect(screen.queryByTestId("story-remove-character-1")).toBeNull());
    expect(screen.getByTestId("story-character-1")).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ */
/* Этап 3: сценарий                                                    */
/* ------------------------------------------------------------------ */

describe("студия: этап 3 — сценарий по слайдам", () => {
  it("каждому слайду — строка с репликой и говорящим", async () => {
    openStudio();
    await prepareStory(3);
    for (let i = 1; i <= 3; i += 1) {
      expect(screen.getByTestId(`story-script-row-${i}`)).toBeTruthy();
      expect(screen.getByTestId(`story-script-${i}`)).toBeTruthy();
      expect(screen.getByTestId(`story-speaker-${i}`)).toBeTruthy();
    }
    expect(screen.getByTestId("story-script-row-1").textContent).toContain("Слайд 1");
    expect(screen.getByTestId("story-script-row-1").textContent).toContain("Реплика Speaker 1");
  });

  it("в сценарии видно превью слайда и имя говорящего", async () => {
    openStudio();
    await prepareStory(1);
    fireEvent.click(screen.getByTestId("story-stage-2"));
    await act(async () => {
      fireEvent.change(screen.getByTestId("story-name-1"), { target: { value: "Charon" } });
    });
    fireEvent.click(screen.getByTestId("story-stage-3"));
    expect((screen.getByTestId("story-speaker-1") as HTMLSelectElement).value).toBe("1");
    expect(screen.getByTestId("story-speaker-1").textContent).toContain("Charon");
    expect(screen.getByTestId("story-script-row-1").querySelector("img")).toBeTruthy();
  });

  it("пустая реплика не пускает на этап сборки", async () => {
    openStudio();
    await prepareStory(2);
    await act(async () => {
      fireEvent.change(screen.getByTestId("story-script-2"), { target: { value: "   " } });
    });
    await waitFor(() => expect(screen.getByTestId("story-script-issue-2")).toBeTruthy());
    expect((screen.getByTestId("story-stage-4") as HTMLButtonElement).disabled).toBe(true);
  });

  it("говорящего можно сменить, а авторасстановка чередует их", async () => {
    openStudio();
    await prepareStory(3);
    await act(async () => {
      fireEvent.change(screen.getByTestId("story-speaker-1"), { target: { value: "2" } });
    });
    await waitFor(() => expect((screen.getByTestId("story-speaker-1") as HTMLSelectElement).value).toBe("2"));

    await act(async () => {
      fireEvent.click(screen.getByTestId("story-auto-assign"));
    });
    await waitFor(() => expect((screen.getByTestId("story-speaker-1") as HTMLSelectElement).value).toBe("1"));
    expect((screen.getByTestId("story-speaker-2") as HTMLSelectElement).value).toBe("2");
    expect((screen.getByTestId("story-speaker-3") as HTMLSelectElement).value).toBe("1");
  });
});

/* ------------------------------------------------------------------ */
/* Этап 4: генерация и сборка                                          */
/* ------------------------------------------------------------------ */

describe("студия: этап 4 — генерация и сборка", () => {
  it("кнопка сборки недоступна без реплик", async () => {
    openStudio();
    await act(async () => {
      setInputFiles(screen.getByTestId("story-file-input"), [pngFile("a.png")]);
    });
    await waitFor(() => expect(screen.getByTestId("story-slide-1")).toBeTruthy());
    fireEvent.click(screen.getByTestId("story-stage-3"));
    expect((screen.getByTestId("story-stage-4") as HTMLButtonElement).disabled).toBe(true);
  });

  it("на каждый слайд уходит запрос dialog-tts с репликой и голосом", async () => {
    openStudio();
    await buildStory(2);
    expect(calls.length).toBe(2);
    for (const call of calls) {
      expect(call.url).toContain(`${EDGE_FUNCTIONS_URL}/${DIALOG_TTS_FN}`);
      expect(call.init.method).toBe("POST");
      expect(call.init.signal).toBeTruthy();
      expect(call.body.voices).toBeTruthy();
    }
    expect(calls[0].body.transcript).toBe("Speaker 1: Реплика слайда 1");
    expect(calls[1].body.transcript).toBe("Speaker 2: Реплика слайда 2");
    expect(calls[0].body.voices).toEqual({ "1": calls[0].body.voices?.["1"] });
  });

  it("после сборки открывается этап 5 с плеером и метаданными", async () => {
    openStudio();
    await buildStory(2);
    const player = screen.getByTestId("story-player") as HTMLVideoElement;
    expect(player.src).toContain("blob:mock-");
    expect(screen.getByTestId("story-result-meta").textContent).toMatch(/Длительность/);
    expect(screen.getByTestId("story-progress-step").textContent).toContain("ЭТАП 5");
    expect(screen.getByTestId("story-progress-percent").textContent).toBe("100%");
    expect(vi.mocked(toast.success)).toHaveBeenCalled();
  });

  it("сбой одного слайда помечается причиной, остальные собираются", async () => {
    openStudio();
    // Слой запросов повторяет сетевой сбой, поэтому отказываем по содержимому
    // реплики: все попытки первого слайда падают, второй озвучивается.
    handler = async (_index, init) => {
      const body = init.body ? (JSON.parse(String(init.body)) as { transcript?: string }) : {};
      return body.transcript?.includes("слайда 1")
        ? Promise.reject(new TypeError("Failed to fetch"))
        : audioResponse();
    };
    await prepareStory(2);
    fireEvent.click(screen.getByTestId("story-stage-4"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("story-generate"));
    });
    await waitFor(() => expect(screen.getByTestId("story-stage").textContent).toContain("ЭТАП 5"));
    fireEvent.click(screen.getByTestId("story-stage-4"));
    expect(screen.getByTestId("story-track-issue-1").textContent).toBeTruthy();
    expect(screen.getByTestId("story-track-preview-2")).toBeTruthy();
    expect(screen.queryByTestId("story-track-preview-1")).toBeNull();
  });

  it("полный сбой озвучки показывает точную причину и не даёт видео", async () => {
    openStudio();
    handler = async () => Promise.reject(new TypeError("Failed to fetch"));
    await prepareStory(1);
    fireEvent.click(screen.getByTestId("story-stage-4"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("story-generate"));
    });
    await waitFor(() => expect(screen.getByTestId("story-error")).toBeTruthy());
    expect(screen.getByTestId("story-error").textContent).toBeTruthy();
    expect(screen.queryByTestId("story-player")).toBeNull();
    expect(screen.getByTestId("story-stage").textContent).not.toContain("ЭТАП 5");
    expect((screen.getByTestId("story-generate") as HTMLButtonElement).disabled).toBe(false);
  });

  it("«Стоп» прерывает сборку без ошибки", async () => {
    openStudio();
    handler = (_index, init) => hangingResponse(init);
    await prepareStory(1);
    fireEvent.click(screen.getByTestId("story-stage-4"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("story-generate"));
    });
    await waitFor(() => expect(screen.getByTestId("story-stop")).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByTestId("story-stop"));
    });
    await waitFor(() => expect(screen.queryByTestId("story-stop")).toBeNull());
    expect(screen.queryByTestId("story-error")).toBeNull();
    expect(screen.queryByTestId("story-player")).toBeNull();
  });

  it("если браузер не умеет писать видео, причина понятна", async () => {
    const harness = createDeps({ canRecord: false });
    openStudio({ deps: harness.deps });
    await prepareStory(1);
    fireEvent.click(screen.getByTestId("story-stage-4"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("story-generate"));
    });
    await waitFor(() => expect(screen.getByTestId("story-error")).toBeTruthy());
    expect(screen.getByTestId("story-error").textContent).toMatch(/MediaRecorder|видео|запис/i);
  });

  it("дорожку слайда можно послушать и остановить", async () => {
    const harness = createDeps({ canRecord: false });
    openStudio({ deps: harness.deps });
    await prepareStory(1);
    fireEvent.click(screen.getByTestId("story-stage-4"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("story-generate"));
    });
    await waitFor(() => expect(screen.getByTestId("story-track-preview-1")).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByTestId("story-track-preview-1"));
    });
    await waitFor(() => expect(FakeAudio.instances.length).toBeGreaterThan(0));
    expect(FakeAudio.instances[0].paused).toBe(false);
    await act(async () => {
      fireEvent.click(screen.getByTestId("story-track-preview-1"));
    });
    await waitFor(() => expect(FakeAudio.instances[0].paused).toBe(true));
  });

  it("длительности дорожек видны в списке", async () => {
    const harness = createDeps({ canRecord: false });
    openStudio({ deps: harness.deps });
    await prepareStory(1);
    fireEvent.click(screen.getByTestId("story-stage-4"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("story-generate"));
    });
    await waitFor(() => expect(screen.getByTestId("story-track-1").textContent).toMatch(/0:0\d/));
    expect(screen.getByTestId("story-track-1").textContent).toContain("Speaker 1");
  });
});

/* ------------------------------------------------------------------ */
/* Этап 5: готовое видео                                               */
/* ------------------------------------------------------------------ */

describe("студия: этап 5 — готовое видео", () => {
  it("плеер показывает главы по слайдам и субтитры", async () => {
    openStudio();
    await buildStory(2);
    expect(screen.getByTestId("story-chapter-1").textContent).toContain("Слайд 1");
    expect(screen.getByTestId("story-chapter-2").textContent).toContain("Speaker 2");
    expect(screen.getByTestId("story-subtitle").textContent).toContain("Реплика");
  });

  it("переключение слайдов перематывает видео", async () => {
    openStudio();
    await buildStory(2);
    const player = screen.getByTestId("story-player") as HTMLVideoElement;
    await act(async () => {
      fireEvent.click(screen.getByTestId("story-chapter-2"));
    });
    await waitFor(() => expect(player.currentTime).toBeGreaterThan(0));
    expect(player.play).toHaveBeenCalled();
  });

  it("субтитры выключаются", async () => {
    openStudio();
    await buildStory(1);
    expect(screen.getByTestId("story-subtitle")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByTestId("story-subtitles-toggle"));
    });
    await waitFor(() => expect(screen.queryByTestId("story-subtitle")).toBeNull());
    expect(screen.getByTestId("story-subtitles-toggle").getAttribute("aria-pressed")).toBe("false");
  });

  it("скачивание отдаёт файл с понятным именем", async () => {
    openStudio({ title: "Night Shift" });
    await buildStory(1);
    await act(async () => {
      fireEvent.click(screen.getByTestId("story-download"));
    });
    await waitFor(() => expect(clicks.length).toBe(1));
    expect(clicks[0].download).toMatch(/^hikko-night-shift-\d{4}-\d{2}-\d{2}\.webm$/);
    expect(clicks[0].href).toContain("blob:mock-");
  });

  it("кириллический заголовок не ломает имя файла", async () => {
    openStudio({ title: "Ночная смена" });
    await buildStory(1);
    await act(async () => {
      fireEvent.click(screen.getByTestId("story-download"));
    });
    await waitFor(() => expect(clicks.length).toBe(1));
    expect(clicks[0].download).toMatch(/^hikko-story-\d{4}-\d{2}-\d{2}\.webm$/);
  });

  it("отправка в чат передаёт текст и первый кадр", async () => {
    openStudio({ title: "История" });
    await buildStory(2);
    await act(async () => {
      fireEvent.click(screen.getByTestId("story-share"));
    });
    await waitFor(() => expect(onShare).toHaveBeenCalledTimes(1));
    const payload = onShare.mock.calls[0][0] as { text: string; images: string[] };
    expect(payload.text).toContain("Видео-история «История»");
    expect(payload.text).toContain("2 слайдов");
    expect(payload.images).toEqual(["data:image/jpeg;base64,POSTER"]);
  });

  it("без onShare кнопки отправки в чат нет", async () => {
    openStudio({ onShare: null as never });
    await buildStory(1);
    expect(screen.queryByTestId("story-share")).toBeNull();
    expect(screen.getByTestId("story-download")).toBeTruthy();
  });

  it("«Новая история» возвращает к чистому этапу 1", async () => {
    openStudio();
    await buildStory(2);
    await act(async () => {
      fireEvent.click(screen.getByTestId("story-reset"));
    });
    await waitFor(() => expect(screen.getByTestId("story-stage").textContent).toContain("ЭТАП 1"));
    expect(screen.queryByTestId("story-slide-1")).toBeNull();
    expect(screen.getByTestId("story-dropzone")).toBeTruthy();
    expect(revoked.length).toBeGreaterThan(0);
  });

  it("правка слайдов после сборки сбрасывает старое видео", async () => {
    openStudio();
    await buildStory(1);
    fireEvent.click(screen.getByTestId("story-stage-1"));
    await act(async () => {
      setInputFiles(screen.getByTestId("story-file-input"), [pngFile("extra.png")]);
    });
    await waitFor(() => expect(screen.getByTestId("story-slide-2")).toBeTruthy());
    expect((screen.getByTestId("story-stage-5") as HTMLButtonElement).disabled).toBe(true);
  });
});
