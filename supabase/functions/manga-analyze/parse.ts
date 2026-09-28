/**
 * Чистая логика `manga-analyze`: валидация входа и разбор ответа модели.
 *
 * Вынесена из index.ts, чтобы её можно было покрыть тестами (сам index.ts
 * поднимает Deno-сервер и в vitest не импортируется). Файл не использует ничего
 * кроме стандартного JS, поэтому Deno-бандлер edge-функции тянет его как есть.
 */

export const MIN_IMAGES = 1;
export const MAX_IMAGES = 5;
/** 10 МБ байт → ~13.4 МБ base64; запас до 14 МБ совпадает с лимитом клиента. */
export const MAX_IMAGE_DATA_URL_CHARS = 14_000_000;
/**
 * «=» допустим только как хвостовой паддинг: «AA==AA» — не base64, а мусор,
 * который раньше проходил проверку и улетал в модель.
 */
export const IMAGE_DATA_URL_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

export const MAX_DESCRIPTION_CHARS = 2000;
export const MAX_TRANSCRIPT_CHARS = 6000;

export const INVALID_IMAGES_ERROR = `Отправьте от ${MIN_IMAGES} до ${MAX_IMAGES} изображений PNG, JPEG или WebP до 10 МБ`;

export interface AnalyzedPage {
  description: string;
  transcript: string;
}

export type ValidationResult = { ok: true; images: string[] } | { ok: false; error: string };

export function validateImages(input: unknown): ValidationResult {
  if (!Array.isArray(input)) return { ok: false, error: INVALID_IMAGES_ERROR };
  if (input.length < MIN_IMAGES || input.length > MAX_IMAGES) return { ok: false, error: INVALID_IMAGES_ERROR };

  for (const image of input) {
    if (typeof image !== "string") return { ok: false, error: INVALID_IMAGES_ERROR };
    if (image.length > MAX_IMAGE_DATA_URL_CHARS) return { ok: false, error: INVALID_IMAGES_ERROR };
    if (!IMAGE_DATA_URL_RE.test(image)) return { ok: false, error: INVALID_IMAGES_ERROR };
  }

  return { ok: true, images: input as string[] };
}

/**
 * Достаёт JSON из ответа модели.
 *
 * Модель регулярно оборачивает объект в ```json-забор, добавляет пояснение до
 * или после него, либо выдаёт объект с «хвостом». Прежняя версия делала только
 * `replace(/^```json/, '')` и падала на JSON.parse — пользователь получал
 * «Unexpected token …» вместо страниц.
 */
export function extractJson(raw: string): unknown {
  const text = (raw ?? "").trim();
  if (!text) throw new Error("Пустой ответ модели");

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [text];
  if (fence?.[1]) candidates.unshift(fence[1].trim());

  for (const candidate of candidates) {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const slice = candidate.slice(start, end + 1);
      try {
        return JSON.parse(slice);
      } catch {
        /* пробуем следующий вариант */
      }
    }
    try {
      return JSON.parse(candidate);
    } catch {
      /* пробуем следующий вариант */
    }
  }

  throw new Error("Ответ модели не является JSON");
}

const asText = (value: unknown): string => {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item.trim() : typeof item === "object" && item ? asText((item as Record<string, unknown>).text ?? (item as Record<string, unknown>).content) : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
};

function normalizePage(value: unknown): AnalyzedPage | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;

  const description = asText(item.description ?? item.summary ?? item.scene).slice(0, MAX_DESCRIPTION_CHARS);
  const transcript = asText(item.transcript ?? item.lines ?? item.dialog ?? item.dialogue).slice(0, MAX_TRANSCRIPT_CHARS);
  if (!description && !transcript) return null;

  return { description, transcript };
}

/**
 * Приводит ответ модели к массиву из `expected` страниц.
 * Возвращает null, если ответ непригоден (не массив, не та длина, нет ни одной
 * страницы с текстом) — вызывающий код отвечает 502.
 */
export function normalizePages(raw: unknown, expected: number): AnalyzedPage[] | null {
  const container = (raw && typeof raw === "object" && "pages" in (raw as Record<string, unknown>))
    ? (raw as Record<string, unknown>).pages
    : raw;

  if (!Array.isArray(container) || container.length !== expected) return null;

  const pages = container.map(normalizePage);
  if (pages.some((page) => page === null)) return null;

  return pages as AnalyzedPage[];
}

/** Понятные причины вместо «Ошибка анализа изображений» на любой статус апстрима. */
export function upstreamErrorMessage(status: number): string {
  if (status === 429) return "Слишком много запросов к анализу, попробуйте чуть позже.";
  if (status === 402) return "Недостаточно средств Lovable AI.";
  if (status === 401 || status === 403) return "Сервис анализа недоступен: проверьте ключ AI.";
  if (status === 413 || status === 400) return "Страницы не прошли: слишком тяжёлые изображения или неверный формат.";
  if (status >= 500) return "Сервис анализа временно недоступен, попробуйте снова.";
  return `Ошибка анализа изображений (${status})`;
}

/**
 * Смена api анализа: имена из переключателя (те же, что в чате) → модель шлюза.
 *
 * Клиент присылает понятное имя («HikkoGPT Smart»), а конкретный
 * провайдер/модель выбирается здесь — как в `chat`. Имя не из списка (старая
 * версия клиента, левый запрос) не ломает анализ: берётся модель по умолчанию.
 */
export const MANGA_MODEL_MAP: Record<string, string> = {
  HikkoGPT: "google/gemini-3.1-pro-preview",
  "HikkoGPT Smart": "google/gemini-3-flash-preview",
  "HikkoGPT Turbo": "google/gemini-3-flash-preview",
  Спорящий: "google/gemini-3.1-flash-lite-preview",
};

export const DEFAULT_MANGA_MODEL = "google/gemini-3-flash-preview";
export const MANGA_API_NAMES = Object.keys(MANGA_MODEL_MAP);

export function toAiModel(model: unknown): string {
  if (typeof model !== "string") return DEFAULT_MANGA_MODEL;
  return MANGA_MODEL_MAP[model] ?? DEFAULT_MANGA_MODEL;
}

/**
 * Модель шлюза → модель прямого Google Gemini (запасной api).
 *
 * Тот же маппинг, что в `chat`, потому что ключи `GEMINI_API_KEYS` общие; все
 * перечисленные модели понимают изображения, а анализ манги без них не работает.
 */
export function toGoogleModel(aiModel: string): string {
  const m = typeof aiModel === "string" ? aiModel : "";
  if (m.includes("3.1-pro")) return "gemini-2.0-flash-exp";
  if (m.includes("3-flash")) return "gemini-2.0-flash";
  if (m.includes("2.5-pro")) return "gemini-1.5-pro";
  if (m.includes("2.5-flash")) return "gemini-1.5-flash";
  if (m.includes("flash-lite")) return "gemini-2.0-flash";
  return "gemini-2.0-flash";
}

/** Те же mime, что принимает `validateImages`: запасной api не должен видеть то, что основной отверг бы. */
const INLINE_DATA_URL_RE = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/i;

/**
 * dataURL страницы → `inline_data` прямого api Gemini.
 *
 * Шлюз Lovable принимает OpenAI-формат `image_url`, а Google — свой; без этого
 * перехода запасной api получил бы страницы текстом и вернул пустой разбор.
 */
export function dataUrlToInlineData(url: string): { mime_type: string; data: string } | null {
  const match = typeof url === "string" ? url.match(INLINE_DATA_URL_RE) : null;
  if (!match) return null;
  return { mime_type: `image/${match[1].toLowerCase()}`, data: match[2] };
}

/**
 * Тело запроса к запасному api (прямой Gemini): системный промпт тот же, что и
 * для основного, страницы — `inline_data`. null, если хоть одну страницу не
 * удалось перевести (тогда запасной api не дёргаем вовсе).
 */
export function geminiAnalyzeBody(
  systemPrompt: string,
  images: string[],
  pageCount: number
): { systemInstruction: { parts: { text: string }[] }; contents: { role: string; parts: unknown[] }[] } | null {
  const parts: unknown[] = [{ text: `Проанализируй ${pageCount} страниц манги по порядку.` }];
  for (const image of images) {
    const inline = dataUrlToInlineData(image);
    if (!inline) return null;
    parts.push({ inline_data: inline });
  }

  return {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts }],
  };
}

/** Текст ответа прямого Gemini (`candidates[0].content.parts[].text`). */
export function geminiText(result: unknown): string {
  const parts = (result as { candidates?: { content?: { parts?: { text?: unknown }[] } }[] } | null)?.candidates?.[0]
    ?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("");
}

/**
 * Когда основной api стоит сменить на запасной: лимиты/оплата/сбой сервиса.
 * 4xx вроде 400 и 401 — ошибка запроса или ключа, повтор через Gemini её не чинит.
 */
export function shouldSwitchApi(status: number): boolean {
  return status === 402 || status === 429 || status >= 500;
}
