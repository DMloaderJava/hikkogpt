import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCameraOcr,
  mountCameraOcr,
  type CameraOcrController,
  type OcrEngine,
} from "@/lib/cameraOcr";

/** Разметка ровно с теми ID, которые ждёт модуль. */
function installDom(): void {
  document.body.innerHTML = `
    <video id="video"></video>
    <canvas id="canvas"></canvas>
    <textarea id="recognized-text"></textarea>
    <div id="status"></div>
    <div id="progress-fill"></div>
    <div id="loader"></div>
    <button id="btn-capture">Снять</button>
    <button id="btn-switch">Камера</button>
    <button id="btn-copy">Копировать</button>
    <button id="btn-clear">Очистить</button>
    <select id="lang-select"></select>
  `;
}

function installMediaMocks(): {
  getUserMedia: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  const stop = vi.fn();
  const track = { kind: "video", stop } as unknown as MediaStreamTrack;
  const stream = {
    getTracks: () => [track],
  } as unknown as MediaStream;
  const getUserMedia = vi.fn(async () => stream);

  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(HTMLMediaElement.prototype, "play", {
    value: vi.fn(async () => {}),
    configurable: true,
    writable: true,
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    value: vi.fn(() => ({
      drawImage: vi.fn(),
      clearRect: vi.fn(),
    })),
    configurable: true,
    writable: true,
  });

  return { getUserMedia, stop };
}

/** Ждёт, пока завершатся все промисы, запущенные обработчиками. */
const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const click = (id: string): void => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`нет элемента #${id}`);
  element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
};

const text = (id: string): string =>
  document.getElementById(id)?.textContent ?? "";

const width = (id: string): string =>
  (document.getElementById(id) as HTMLElement | null)?.style.width ?? "";

interface FakeEngine {
  engine: OcrEngine;
  languages: string[];
  disposed: () => boolean;
}

function fakeEngine(
  result: string,
  options: { fail?: boolean } = {},
): FakeEngine {
  const languages: string[] = [];
  let disposed = false;

  const engine: OcrEngine = {
    async recognize(_image, language, onProgress) {
      languages.push(language);
      onProgress(0, "loading tesseract core");
      onProgress(0.42, "recognizing text");
      if (options.fail) throw new Error("движок не отвечает");
      return result;
    },
    async dispose() {
      disposed = true;
    },
  };

  return { engine, languages, disposed: () => disposed };
}

describe("cameraOcr", () => {
  let media: ReturnType<typeof installMediaMocks>;
  let controllers: CameraOcrController[] = [];

  beforeEach(() => {
    installDom();
    media = installMediaMocks();
    const video = document.getElementById("video") as HTMLVideoElement;
    Object.defineProperty(video, "videoWidth", { value: 1280, configurable: true });
    Object.defineProperty(video, "videoHeight", { value: 720, configurable: true });
  });

  afterEach(async () => {
    for (const controller of controllers) await controller.destroy();
    controllers = [];
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  const mount = (
    engine: OcrEngine,
    options: Parameters<typeof mountCameraOcr>[0] = {},
  ): CameraOcrController => {
    const controller = mountCameraOcr({ engine, ...options });
    controllers.push(controller);
    return controller;
  };

  it("при старте запускает заднюю камеру и пишет поток в #video", async () => {
    mount(fakeEngine("").engine);
    await flush();

    expect(media.getUserMedia).toHaveBeenCalledTimes(1);
    const constraints = media.getUserMedia.mock.calls[0][0] as MediaStreamConstraints;
    expect(constraints.audio).toBe(false);
    expect(
      (constraints.video as MediaTrackConstraints).facingMode,
    ).toEqual({ ideal: "environment" });

    const video = document.getElementById("video") as HTMLVideoElement;
    expect(video.srcObject).not.toBeNull();
    expect(text("status")).toContain("Сфотографировать");
  });

  it("ошибку доступа к камере показывает в #status", async () => {
    media.getUserMedia.mockRejectedValueOnce(
      Object.assign(new Error("denied"), { name: "NotAllowedError" }),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    mount(fakeEngine("").engine);
    await flush();

    expect(text("status")).toContain("Доступ к камере запрещён");
    expect(consoleError).toHaveBeenCalled();
  });

  it("#btn-capture снимает кадр и выводит распознанный текст", async () => {
    const fake = fakeEngine("  Привет, мир  ");
    mount(fake.engine);
    await flush();

    click("btn-capture");
    await flush();

    const output = document.getElementById("recognized-text") as HTMLTextAreaElement;
    expect(output.value).toBe("Привет, мир");
    expect(text("status")).toContain("Готово");
    expect(width("progress-fill")).toBe("100%");

    const loader = document.getElementById("loader") as HTMLElement;
    expect(loader.style.display).toBe("none");
  });

  it("во время распознавания двигает #progress-fill и показывает #loader", async () => {
    let seenWidth = "";
    const engine: OcrEngine = {
      async recognize(_image, _language, onProgress) {
        onProgress(0.42, "recognizing text");
        seenWidth = width("progress-fill");
        const loader = document.getElementById("loader") as HTMLElement;
        expect(loader.style.display).not.toBe("none");
        return "текст";
      },
    };

    mount(engine);
    await flush();
    click("btn-capture");
    await flush();

    expect(seenWidth).toBe("42%");
  });

  it("если текста на снимке нет — сообщает об этом, а не показывает пустоту", async () => {
    mount(fakeEngine("   \n  ").engine);
    await flush();

    click("btn-capture");
    await flush();

    expect((document.getElementById("recognized-text") as HTMLTextAreaElement).value).toBe("");
    expect(text("status")).toContain("не найден");
  });

  it("ошибку OCR перехватывает и показывает в #status", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mount(fakeEngine("", { fail: true }).engine);
    await flush();

    click("btn-capture");
    await flush();

    expect(text("status")).toContain("Не удалось распознать текст");
    expect(consoleError).toHaveBeenCalled();
  });

  it("#btn-switch переключает камеру на фронтальную и обратно", async () => {
    mount(fakeEngine("").engine);
    await flush();

    click("btn-switch");
    await flush();
    expect(
      (media.getUserMedia.mock.calls[1][0] as MediaStreamConstraints).video as MediaTrackConstraints,
    ).toEqual(
      expect.objectContaining({ facingMode: { ideal: "user" } }),
    );
    expect(text("status")).toContain("Фронтальная камера");

    click("btn-switch");
    await flush();
    expect(
      (media.getUserMedia.mock.calls[2][0] as MediaStreamConstraints).video as MediaTrackConstraints,
    ).toEqual(
      expect.objectContaining({ facingMode: { ideal: "environment" } }),
    );
  });

  it("#lang-select меняет язык, который уходит в движок", async () => {
    const fake = fakeEngine("текст");
    mount(fake.engine);
    await flush();

    const select = document.getElementById("lang-select") as HTMLSelectElement;
    // Список заполняется модулем, если в разметке он был пустым.
    expect(select.options.length).toBeGreaterThan(0);
    select.value = "deu";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(text("status")).toContain("Немецкий");

    click("btn-capture");
    await flush();

    expect(fake.languages.at(-1)).toBe("deu");
  });

  it("#btn-copy копирует текст в буфер обмена", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    mount(fakeEngine("скопируй меня").engine);
    await flush();
    click("btn-capture");
    await flush();

    click("btn-copy");
    await flush();

    expect(writeText).toHaveBeenCalledWith("скопируй меня");
    expect(text("status")).toContain("скопирован");
  });

  it("#btn-copy не падает, когда текста нет", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    mount(fakeEngine("").engine);
    await flush();

    click("btn-copy");
    await flush();

    expect(writeText).not.toHaveBeenCalled();
    expect(text("status")).toContain("Нечего копировать");
  });

  it("#btn-clear очищает текст, статус и прогресс", async () => {
    mount(fakeEngine("что-то").engine);
    await flush();
    click("btn-capture");
    await flush();

    click("btn-clear");

    expect((document.getElementById("recognized-text") as HTMLTextAreaElement).value).toBe("");
    expect(text("status")).toBe("");
    expect(width("progress-fill")).toBe("0%");
  });

  it("destroy() снимает обработчики, останавливает камеру и закрывает движок", async () => {
    const fake = fakeEngine("");
    const controller = mount(fake.engine);
    await flush();

    await controller.destroy();
    click("btn-capture");
    await flush();

    expect(media.stop).toHaveBeenCalled();
    expect(fake.disposed()).toBe(true);
    expect(media.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("работает, даже если разметки нет вовсе — без исключений", async () => {
    document.body.innerHTML = "";
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const controller = createCameraOcr({ engine: fakeEngine("").engine });
    controllers.push(controller);

    await expect(controller.start()).resolves.toBeUndefined();
    await expect(controller.capture()).resolves.toBeUndefined();
    await expect(controller.copy()).resolves.toBeUndefined();
    expect(() => controller.clear()).not.toThrow();
    expect(consoleError).toHaveBeenCalled();
  });
});
