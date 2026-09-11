/**
 * Модуль «камера + распознавание текста» (Tesseract.js).
 *
 * Модуль ничего не знает о React и о вёрстке: он работает исключительно по ID
 * элементов, перечисленных ниже, и спокойно переживает перерисовку
 * интерфейса — элементы ищутся заново при каждом действии.
 *
 *   #video           — сюда выводится поток с камеры
 *   #canvas          — скрытый буфер, куда снимается кадр
 *   #recognized-text — распознанный текст (textarea / input / div)
 *   #status          — статус, прогресс, ошибки
 *   #progress-fill   — ширина в процентах во время распознавания
 *   #loader          — индикатор работы (показывается/скрывается)
 *   #btn-capture     — «Сфотографировать»
 *   #btn-switch      — «Переключить камеру»
 *   #btn-copy        — «Копировать»
 *   #btn-clear       — «Очистить»
 *   #lang-select     — выпадающий список языков
 *
 * Подключение — одна строка в точке входа (например, в src/main.tsx):
 *
 *   import { mountCameraOcr } from "@/lib/cameraOcr";
 *   mountCameraOcr();
 *
 * Глобальных переменных нет: камера, язык, состояние «идёт распознавание» и
 * кеш воркера Tesseract живут внутри контроллера, который возвращает
 * `createCameraOcr()` / `mountCameraOcr()`.
 */

import type {
  LoggerMessage,
  Worker as TesseractWorker,
  WorkerOptions,
} from "tesseract.js";

/** Какую камеру просим: заднюю («environment») или фронтальную («user»). */
export type CameraFacing = "environment" | "user";

/** Прогресс распознавания: `progress` — 0..1, `status` — сырой статус OCR. */
export type OcrProgressHandler = (progress: number, status: string) => void;

/**
 * Движок распознавания. Вынесен отдельно, чтобы модуль можно было
 * использовать и тестировать без реального Tesseract.js.
 */
export interface OcrEngine {
  /** Принимает кадр, язык и колбэк прогресса, возвращает распознанный текст. */
  recognize(
    image: HTMLCanvasElement,
    language: string,
    onProgress: OcrProgressHandler,
  ): Promise<string>;
  /** Освобождает ресурсы движка (воркер). Вызывается из `destroy()`. */
  dispose?: () => Promise<void>;
}

/** Настройки Tesseract.js-движка: любые опции воркера, кроме `logger`. */
export interface TesseractEngineOptions {
  workerOptions?: Partial<Omit<WorkerOptions, "logger">>;
}

/** Все ID, с которыми работает модуль. Можно переопределить любой. */
export interface CameraOcrElementIds {
  video: string;
  canvas: string;
  recognizedText: string;
  status: string;
  progressFill: string;
  loader: string;
  captureButton: string;
  switchButton: string;
  copyButton: string;
  clearButton: string;
  langSelect: string;
}

export interface CameraOcrOptions {
  /** Свой движок OCR (для тестов или другого бэкенда). По умолчанию — Tesseract.js. */
  engine?: OcrEngine;
  /** Чем заполнить #lang-select, если он пустой. */
  languages?: readonly string[];
  /** Язык по умолчанию, если #lang-select не найден или пуст. */
  defaultLanguage?: string;
  /** Камера, которая включается первой. По умолчанию — задняя. */
  initialFacing?: CameraFacing;
  /** Переопределение ID элементов. */
  ids?: Partial<CameraOcrElementIds>;
}

export interface CameraOcrController {
  /** Подключает обработчики и запускает камеру. Повторный вызов безопасен. */
  start(): Promise<void>;
  /** Переключает фронтальную/заднюю камеру. */
  switchCamera(): Promise<void>;
  /** Делает снимок с #video и распознаёт текст. */
  capture(): Promise<void>;
  /** Копирует содержимое #recognized-text в буфер обмена. */
  copy(): Promise<void>;
  /** Очищает #recognized-text, #status и прогресс. */
  clear(): void;
  /** Текущий распознанный (или введённый вручную) текст. */
  getText(): string;
  /** Текущий язык распознавания. */
  getLanguage(): string;
  /** Отключает обработчики, останавливает камеру и освобождает воркер. */
  destroy(): Promise<void>;
}

/**
 * Движок на базе Tesseract.js.
 *
 * Tesseract.js подключается динамическим `import()`, поэтому ядро и языковые
 * модели грузятся только при первом снимке, а не при загрузке страницы.
 * Воркер кешируется и переиспользуется между снимками (иначе языковую модель
 * пришлось бы скачивать заново каждый раз); если язык меняется — воркер
 * пересоздаётся.
 */
export function createTesseractEngine(
  options: TesseractEngineOptions = {},
): OcrEngine {
  let worker: TesseractWorker | null = null;
  let workerLanguage = "";
  let progressSink: OcrProgressHandler | null = null;

  const logger = (message: LoggerMessage): void => {
    if (progressSink) progressSink(message.progress, message.status);
  };

  const ensureWorker = async (language: string): Promise<TesseractWorker> => {
    if (worker && workerLanguage === language) return worker;
    if (worker) {
      await worker.terminate();
      worker = null;
    }
    const { createWorker } = await import("tesseract.js");
    workerLanguage = language;
    worker = await createWorker(language, undefined, {
      ...options.workerOptions,
      logger,
    });
    return worker;
  };

  return {
    async recognize(image, language, onProgress) {
      progressSink = onProgress;
      try {
        const active = await ensureWorker(language);
        const result = await active.recognize(image);
        return result.data.text ?? "";
      } finally {
        progressSink = null;
      }
    },
    async dispose() {
      if (!worker) return;
      await worker.terminate();
      worker = null;
      workerLanguage = "";
    },
  };
}

/**
 * Создаёт контроллер камеры и OCR. Камера по умолчанию не запускается —
 * для автозапуска при загрузке страницы используйте `mountCameraOcr()`.
 */
export function createCameraOcr(
  options: CameraOcrOptions = {},
): CameraOcrController {
  const ids: CameraOcrElementIds = {
    video: "video",
    canvas: "canvas",
    recognizedText: "recognized-text",
    status: "status",
    progressFill: "progress-fill",
    loader: "loader",
    captureButton: "btn-capture",
    switchButton: "btn-switch",
    copyButton: "btn-copy",
    clearButton: "btn-clear",
    langSelect: "lang-select",
    ...options.ids,
  };

  const languages = options.languages ?? [
    "rus+eng",
    "rus",
    "eng",
    "deu",
    "spa",
    "fra",
    "ita",
    "ukr",
  ];

  const statusLabels: Record<string, string> = {
    "loading tesseract core": "Загружаю ядро распознавания…",
    "initializing tesseract": "Инициализирую распознавание…",
    "loading language traineddata": "Загружаю языковую модель…",
    "initializing api": "Подготавливаю распознавание…",
    "recognizing text": "Распознаю текст…",
  };

  const languageLabels: Record<string, string> = {
    "rus+eng": "Русский + английский",
    rus: "Русский",
    eng: "Английский",
    deu: "Немецкий",
    spa: "Испанский",
    fra: "Французский",
    ita: "Итальянский",
    ukr: "Украинский",
  };

  const engine = options.engine ?? createTesseractEngine();

  let facing: CameraFacing = options.initialFacing ?? "environment";
  let stream: MediaStream | null = null;
  let language = options.defaultLanguage ?? languages[0] ?? "eng";
  let busy = false;
  let destroyed = false;
  let handlersBound = false;
  let loaderDisplay: string | null = null;
  let lastRecognizedText = "";

  const cleanups: Array<() => void> = [];

  // ---------------------------------------------------------------- элементы

  /** Ищет элемент по ID и проверяет, что он нужного типа. */
  const pick = <T extends HTMLElement>(
    id: string,
    ctor: new () => T,
  ): T | null => {
    const element = document.getElementById(id);
    return element instanceof ctor ? element : null;
  };

  const videoElement = (): HTMLVideoElement | null =>
    pick(ids.video, HTMLVideoElement);
  const canvasElement = (): HTMLCanvasElement | null =>
    pick(ids.canvas, HTMLCanvasElement);
  const langSelectElement = (): HTMLSelectElement | null =>
    pick(ids.langSelect, HTMLSelectElement);
  const byId = (id: string): HTMLElement | null => document.getElementById(id);

  const setTextContent = (id: string, value: string): void => {
    const element = byId(id);
    if (element) element.textContent = value;
  };

  const writeText = (value: string): void => {
    const element = byId(ids.recognizedText);
    if (!element) return;
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      element.value = value;
      return;
    }
    element.textContent = value;
  };

  const readText = (): string => {
    const element = byId(ids.recognizedText);
    if (!element) return lastRecognizedText;
    const raw =
      element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
        ? element.value
        : element.textContent ?? "";
    return raw.trim();
  };

  const setStatus = (value: string): void => {
    setTextContent(ids.status, value);
  };

  const setProgress = (percent: number): void => {
    const element = byId(ids.progressFill);
    if (!element) return;
    const clamped = Math.min(100, Math.max(0, Math.round(percent)));
    element.style.width = `${clamped}%`;
  };

  const setLoader = (visible: boolean): void => {
    const element = byId(ids.loader);
    if (!element) return;
    // Запоминаем «родной» display один раз, чтобы вернуть его при показе.
    if (loaderDisplay === null) loaderDisplay = element.style.display || "";
    element.style.display = visible ? loaderDisplay : "none";
    if (visible) element.removeAttribute("hidden");
    else element.setAttribute("hidden", "");
  };

  const setControlsEnabled = (enabled: boolean): void => {
    for (const id of [ids.captureButton, ids.switchButton, ids.copyButton]) {
      const element = byId(id);
      if (!element) continue;
      if (element instanceof HTMLButtonElement) element.disabled = !enabled;
      element.setAttribute("aria-busy", enabled ? "false" : "true");
    }
  };

  // ----------------------------------------------------------------- ошибки

  /** Превращает исключение в понятное пользователю сообщение. */
  const describeError = (error: unknown): string => {
    if (error instanceof Error) {
      switch (error.name) {
        case "NotAllowedError":
        case "PermissionDeniedError":
          return "Доступ к камере запрещён. Разрешите его в настройках браузера.";
        case "NotFoundError":
        case "DevicesNotFoundError":
          return "Камера не найдена.";
        case "NotReadableError":
        case "TrackStartError":
          return "Камера занята другим приложением.";
        case "OverconstrainedError":
        case "ConstraintNotSatisfiedError":
          return "Выбранная камера недоступна на этом устройстве.";
        case "SecurityError":
          return "Доступ к камере возможен только по HTTPS или на localhost.";
        case "AbortError":
          return "Камера не запустилась. Попробуйте ещё раз.";
        default:
          return error.message || "Неизвестная ошибка.";
      }
    }
    if (typeof error === "string" && error.length > 0) return error;
    return "Неизвестная ошибка.";
  };

  const reportError = (error: unknown, context: string): void => {
    const reason = describeError(error);
    setStatus(`${context}: ${reason}`);
    console.error(`[cameraOcr] ${context}`, error);
  };

  // ----------------------------------------------------------------- камера

  const stopStream = (): void => {
    if (!stream) return;
    for (const track of stream.getTracks()) track.stop();
    stream = null;
    const target = videoElement();
    if (target) target.srcObject = null;
  };

  const openStream = async (nextFacing: CameraFacing): Promise<void> => {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices || typeof mediaDevices.getUserMedia !== "function") {
      throw new Error("Браузер не поддерживает доступ к камере");
    }

    stopStream();

    const constraints: MediaStreamConstraints = {
      audio: false,
      video: {
        facingMode: { ideal: nextFacing },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    };

    const next = await mediaDevices.getUserMedia(constraints);
    const target = videoElement();
    if (!target) {
      for (const track of next.getTracks()) track.stop();
      throw new Error(`Элемент #${ids.video} не найден в разметке`);
    }

    stream = next;
    facing = nextFacing;
    target.srcObject = next;
    target.muted = true;
    target.setAttribute("playsinline", "true");

    try {
      await target.play();
    } catch {
      // Автовоспроизведение может быть запрещено — кадр всё равно снимется.
    }
  };

  // -------------------------------------------------------------- распознание

  const switchCamera = async (): Promise<void> => {
    if (busy) {
      setStatus("Дождитесь окончания распознавания.");
      return;
    }
    const previous = facing;
    const next: CameraFacing = facing === "environment" ? "user" : "environment";
    setLoader(true);
    setStatus("Переключаю камеру…");
    try {
      await openStream(next);
      setStatus(next === "environment" ? "Задняя камера включена." : "Фронтальная камера включена.");
    } catch (error) {
      facing = previous;
      reportError(error, "Не удалось переключить камеру");
      // Пытаемся вернуть предыдущий поток, если он был.
      try {
        await openStream(previous);
      } catch {
        setStatus("Камера недоступна.");
      }
    } finally {
      setLoader(false);
    }
  };

  const capture = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    setControlsEnabled(false);
    setLoader(true);
    setProgress(0);
    setStatus("Готовлюсь к распознаванию…");

    try {
      const video = videoElement();
      if (!video) throw new Error(`Элемент #${ids.video} не найден в разметке`);
      if (!video.videoWidth || !video.videoHeight) {
        throw new Error("Камера ещё не готова — подождите появления изображения");
      }

      const canvas = canvasElement();
      if (!canvas) throw new Error(`Элемент #${ids.canvas} не найден в разметке`);

      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;

      const context = canvas.getContext("2d");
      if (!context) throw new Error("Не удалось получить 2D-контекст холста");
      context.drawImage(video, 0, 0, canvas.width, canvas.height);

      const text = await engine.recognize(canvas, language, (progress, status) => {
        setProgress(progress * 100);
        const label = statusLabels[status];
        if (label) setStatus(label);
      });

      const cleaned = text.trim();
      lastRecognizedText = cleaned;
      writeText(cleaned);
      setProgress(100);
      setStatus(
        cleaned
          ? "Готово. Текст распознан."
          : "Текст на снимке не найден. Попробуйте другой ракурс.",
      );
    } catch (error) {
      reportError(error, "Не удалось распознать текст");
      setProgress(0);
    } finally {
      busy = false;
      setControlsEnabled(true);
      setLoader(false);
    }
  };

  const copy = async (): Promise<void> => {
    if (busy) return;
    try {
      const text = readText();
      if (!text) {
        setStatus("Нечего копировать — сначала распознайте текст.");
        return;
      }
      await copyToClipboard(text);
      setStatus("Текст скопирован в буфер обмена.");
    } catch (error) {
      reportError(error, "Не удалось скопировать текст");
    }
  };

  const clear = (): void => {
    try {
      lastRecognizedText = "";
      writeText("");
      setStatus("");
      setProgress(0);
      const canvas = canvasElement();
      const context = canvas?.getContext("2d") ?? null;
      if (canvas && context) context.clearRect(0, 0, canvas.width, canvas.height);
    } catch (error) {
      reportError(error, "Не удалось очистить");
    }
  };

  // ------------------------------------------------------------- обработчики

  const bindClick = (
    id: string,
    handler: () => void | Promise<void>,
  ): void => {
    const element = byId(id);
    if (!element) return;
    const listener = (event: Event): void => {
      event.preventDefault();
      try {
        // Синхронные обработчики (например, «Очистить») выполняются сразу —
        // интерфейс должен реагировать в этом же тике.
        const result: unknown = handler();
        if (result instanceof Promise) {
          void result.catch((error: unknown) =>
            reportError(error, "Ошибка обработки нажатия"),
          );
        }
      } catch (error) {
        reportError(error, "Ошибка обработки нажатия");
      }
    };
    element.addEventListener("click", listener);
    cleanups.push(() => element.removeEventListener("click", listener));
  };

  const fillLanguageSelect = (select: HTMLSelectElement): void => {
    if (select.options.length > 0) return;
    for (const code of languages) {
      const option = document.createElement("option");
      option.value = code;
      option.textContent = languageLabels[code] ?? code;
      select.append(option);
    }
  };

  const bindLanguageSelect = (): void => {
    const select = langSelectElement();
    if (!select) return;
    fillLanguageSelect(select);
    if (select.value) language = select.value;

    const listener = (event: Event): void => {
      const target = event.target;
      if (!(target instanceof HTMLSelectElement)) return;
      language = target.value;
      const label = languageLabels[language] ?? language;
      setStatus(`Язык распознавания: ${label}.`);
    };
    select.addEventListener("change", listener);
    cleanups.push(() => select.removeEventListener("change", listener));
  };

  const bindHandlers = (): void => {
    if (handlersBound) return;
    handlersBound = true;
    bindClick(ids.captureButton, capture);
    bindClick(ids.switchButton, switchCamera);
    bindClick(ids.copyButton, copy);
    bindClick(ids.clearButton, clear);
    bindLanguageSelect();

    const releaseCamera = (): void => stopStream();
    window.addEventListener("pagehide", releaseCamera);
    cleanups.push(() => window.removeEventListener("pagehide", releaseCamera));
  };

  const start = async (): Promise<void> => {
    if (destroyed) return;
    bindHandlers();
    setLoader(true);
    setStatus("Запускаю камеру…");
    try {
      await openStream(facing);
      setStatus("Камера включена. Нажмите «Сфотографировать».");
    } catch (error) {
      reportError(error, "Не удалось запустить камеру");
    } finally {
      setLoader(false);
    }
  };

  const destroy = async (): Promise<void> => {
    destroyed = true;
    for (const cleanup of cleanups.splice(0, cleanups.length)) cleanup();
    handlersBound = false;
    stopStream();
    try {
      await engine.dispose?.();
    } catch (error) {
      console.error("[cameraOcr] не удалось освободить движок OCR", error);
    }
  };

  return {
    start,
    switchCamera,
    capture,
    copy,
    clear,
    getText: readText,
    getLanguage: () => language,
    destroy,
  };
}

/**
 * Создаёт контроллер и сразу запускает камеру — либо немедленно, либо по
 * `DOMContentLoaded`, если модуль подключён до готовности DOM.
 *
 * Вызывать один раз на страницу: повторный вызов подключит второй набор
 * обработчиков и вторую камеру.
 *
 * Возвращает контроллер, поэтому при желании можно остановить камеру:
 * `const cameraOcr = mountCameraOcr(); … await cameraOcr.destroy();`
 */
export function mountCameraOcr(
  options: CameraOcrOptions = {},
): CameraOcrController {
  const controller = createCameraOcr(options);
  const run = (): void => {
    void controller.start();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run, { once: true });
  } else {
    run();
  }

  return controller;
}

/**
 * Копирование в буфер обмена: современный Clipboard API, а для http и старых
 * браузеров — фолбэк через временный textarea + execCommand.
 */
async function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-1000px";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  try {
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    if (!document.execCommand("copy")) {
      throw new Error("браузер отклонил команду копирования");
    }
  } finally {
    textarea.remove();
  }
}
