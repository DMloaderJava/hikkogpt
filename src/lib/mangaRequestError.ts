/**
 * Точная причина сбоя в конвейере озвучки манги.
 *
 * Браузер на любой сетевой сбой говорит одно: `TypeError: Failed to fetch`.
 * По такому тексту невозможно понять, что именно сломалось — чтение файла,
 * сжатие скана, отправка запроса, ответ сервера, разбор диалога или декодирование
 * аудио. Поэтому каждый шаг конвейера имеет своё имя, а сообщение собирается по
 * схеме:
 *
 *     Ошибка запроса api (отправка запроса: соединение оборвалось до ответа сервера)
 *     └── что делаем ──────┘└── этап ─────┘└── причина ────────────────────────────┘
 *
 * Тот же текст уходит в плашку модалки, в toast и в `voiceError` конкретной
 * страницы — пользователь всегда видит, в какой момент и почему не получилось.
 */

import { EdgeRequestError, NETWORK_ERROR_MESSAGE, TIMEOUT_ERROR_MESSAGE } from "@/lib/edgeAuth";

/** Шаг конвейера: от добавления страницы до готовой озвучки. */
export type MangaStage =
  | "add-page"
  | "file-read"
  | "compress"
  | "send-request"
  | "analyze-api"
  | "analyze-answer"
  | "dialog-check"
  | "tts-api"
  | "tts-decode";

/** Человекочитаемое имя этапа — попадает в скобки сообщения. */
export const STAGE_LABELS: Record<MangaStage, string> = {
  "add-page": "добавление страницы",
  "file-read": "чтение файла страницы",
  compress: "сжатие изображения",
  "send-request": "отправка запроса",
  "analyze-api": "ответ api анализа манги",
  "analyze-answer": "обработка ответа анализа",
  "dialog-check": "проверка реплик перед озвучкой",
  "tts-api": "ответ api озвучки",
  "tts-decode": "обработка аудио озвучки",
};

/** Как называть функции в сообщении — без технических имён. */
export const API_LABELS: Record<string, string> = {
  "manga-analyze": "api анализа манги",
  "dialog-tts": "api озвучки",
  chat: "api чата",
  "image-search": "api поиска изображений",
  deepsearch: "api глубокого поиска",
  "elevenlabs-stt": "api распознавания речи",
};

export interface MangaFailure {
  stage: MangaStage;
  /** Подробная причина — то, что стоит в скобках после имени этапа. */
  reason: string;
  /** Полный текст для пользователя: «Ошибка запроса api (…)». */
  message: string;
  /** HTTP-код, если сервер всё-таки ответил. */
  status?: number;
}

const label = (stage: MangaStage) => STAGE_LABELS[stage];

/** Собирает сообщение вида «Ошибка запроса api (этап: причина)». */
export function mangaFailureMessage(stage: MangaStage, reason: string): string {
  return `Ошибка запроса api (${label(stage)}: ${reason})`;
}

export function mangaFailure(stage: MangaStage, reason: string, status?: number): MangaFailure {
  return { stage, reason, message: mangaFailureMessage(stage, reason), status };
}

/** Признак уже классифицированного сбоя (в отличие от «сырого» исключения). */
export function isMangaFailure(e: unknown): e is MangaFailure {
  return !!e && typeof e === "object" && "stage" in e && "message" in e && "reason" in e;
}

/** Причина «этап: деталь» — её же кладём в `voiceError` страницы. */
export function failureTitle(failure: MangaFailure): string {
  return `${label(failure.stage)}: ${failure.reason}`;
}

function apiLabel(fn: string): string {
  return API_LABELS[fn] ?? `api ${fn}`;
}

/**
 * Разбирает исключение одного запроса в конкретную причину.
 *
 * `stage` — этап, на котором запрос делали (например, `analyze-api`); сетевые
 * сбои всегда переопределяются в `send-request`, потому что до сервера дело не
 * дошло, а прикладная ошибка остаётся на этапе api.
 */
export function classifyEdgeFailure(e: unknown, stage: MangaStage, fallback: string): MangaFailure {
  if (e instanceof EdgeRequestError) {
    const api = apiLabel(e.fn);
    if (e.network) {
      return mangaFailure(
        "send-request",
        `запрос к ${api} не дошёл до сервера — соединение оборвалось (сеть, VPN, блокировщик или функция не развернута); повтор тоже не помог`
      );
    }
    if (e.timedOut) {
      return mangaFailure("send-request", `${api} не ответил вовремя — запрос прерван по таймауту`);
    }
    return mangaFailure(stage, e.message || fallback, e.status);
  }

  if (e instanceof TypeError) {
    // «Failed to fetch» вне edgeRequest — тот же смысл, но без имени функции.
    return mangaFailure("send-request", "запрос не дошёл до сервера — соединение оборвалось (сеть или блокировка запроса)");
  }

  if (e instanceof SyntaxError) {
    return mangaFailure("analyze-answer", "ответ сервера не удалось разобрать как JSON");
  }

  return mangaFailure(stage, e instanceof Error && e.message ? e.message : fallback);
}

/** Отказ при подготовке страниц (чтение файла / сжатие) — до всякой сети. */
export function classifyPrepareFailure(e: unknown, fileName?: string): MangaFailure {
  const where = fileName ? ` (${fileName})` : "";
  const reason = e instanceof Error && e.message ? e.message : "неизвестная причина";
  const stage: MangaStage = /прочитать|read/i.test(reason) ? "file-read" : "compress";
  return mangaFailure(stage, `${reason}${where}`);
}

/** Проверка реплик до запроса: это не сбой сети, а непригодные данные. */
export function dialogCheckFailure(reason: string): MangaFailure {
  return mangaFailure("dialog-check", reason);
}

/** Сетевое сообщение из edgeAuth не должно всплывать наружу без этапа. */
export const RAW_NETWORK_MESSAGE = NETWORK_ERROR_MESSAGE;
export const RAW_TIMEOUT_MESSAGE = TIMEOUT_ERROR_MESSAGE;
