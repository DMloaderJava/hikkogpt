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
