/**
 * Подготовка страниц манги к анализу.
 *
 * Проблема, которую решает модуль: страница скана — это PNG на 5–10 МБ, а в
 * `manga-analyze` картинки уходят inline-base64 внутри одного JSON-запроса
 * (батч до 5 страниц). 5 × 10 МБ → ~66 МБ текста в теле запроса: такой запрос
 * упирается в лимиты inline-данных модели и в память edge-функции, а на слабом
 * телефоне ещё и подвешивает вкладку на этапе FileReader. При этом Gemini всё
 * равно ресемплит изображения, поэтому качество анализа от уменьшения не страдает.
 *
 * Поэтому страница перед отправкой уменьшается до MAX_PAGE_SIDE_PX и
 * пережимается в JPEG с понишением качества, пока base64 не влезет в
 * MAX_PAGE_DATA_URL_BYTES. Если декодировать картинку не удалось (нет canvas,
 * битый файл, серверное окружение) — отправляем исходный dataURL без падения.
 */

import { blobToDataURL } from "@/lib/imageAttachments";

export const ACCEPTED_PAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const ACCEPTED_PAGE_ACCEPT = "image/png,image/jpeg,image/webp";
/** Лимит исходного файла (такой же показывается в подсказке). */
export const MAX_PAGE_FILE_BYTES = 10 * 1024 * 1024;
/** Сколько страниц анализируется за один запрос к `manga-analyze`. */
export const ANALYZE_BATCH_SIZE = 5;
/** Больше не нужно: модель всё равно ресемплит вход, а реплики читаются и так. */
export const MAX_PAGE_SIDE_PX = 1600;
/** Сколько байт занимает base64 одной страницы после сжатия. */
export const MAX_PAGE_DATA_URL_BYTES = 1_500_000;
/** Шаги качества JPEG: первое, что влезет в лимит, и побеждает. */
const JPEG_QUALITY_STEPS = [0.85, 0.7, 0.55];
/** Сколько ждём createImageBitmap/<img> до отказа от сжатия. */
const DECODE_TIMEOUT_MS = 8000;

export interface PageFileRejection {
  name: string;
  reason: string;
}

/**
 * Отбирает пригодные страницы и объясняет каждый отказ.
 * Пустой список (пользователь отменил выбор) ошибкой не считается.
 */
export function filterPageFiles(list: FileList | File[] | null): { accepted: File[]; rejected: PageFileRejection[] } {
  const files = Array.from(list ?? []);
  const accepted: File[] = [];
  const rejected: PageFileRejection[] = [];

  for (const file of files) {
    const type = (file.type || "").toLowerCase();
    if (!(ACCEPTED_PAGE_TYPES as readonly string[]).includes(type)) {
      rejected.push({ name: file.name, reason: "нужен PNG, JPEG или WebP" });
    } else if (file.size > MAX_PAGE_FILE_BYTES) {
      rejected.push({ name: file.name, reason: "больше 10 МБ" });
    } else if (file.size === 0) {
      rejected.push({ name: file.name, reason: "пустой файл" });
    } else {
      accepted.push(file);
    }
  }

  return { accepted, rejected };
}

/** Пропорциональное уменьшение до maxSide; никогда не увеличивает картинку. */
export function computeScaledSize(width: number, height: number, maxSide: number) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const scale = Math.min(1, maxSide / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)), scale };
}

/** Приблизительный размер декодированных байт по dataURL. */
export function estimateDataURLBytes(dataURL: string): number {
  const comma = dataURL.indexOf(",");
  const base64 = comma >= 0 ? dataURL.slice(comma + 1) : dataURL;
  const padding = (base64.match(/=+$/) ?? [""])[0].length;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

export interface DecodedImage {
  width: number;
  height: number;
  /** То, что можно передать в ctx.drawImage(). */
  source: CanvasImageSource;
  close?: () => void;
}

export interface PageDataUrlOptions {
  maxSide?: number;
  maxBytes?: number;
  /** Сколько ждём декодер, прежде чем отправить страницу как есть. */
  decodeTimeoutMs?: number;
  /** Инжектируемый декодер — нужен в тестах, где нет canvas/createImageBitmap. */
  decode?: (file: Blob, dataURL: string) => Promise<DecodedImage | null>;
  /** Инжектируемая фабрика canvas. */
  canvasFactory?: () => HTMLCanvasElement;
}

/**
 * Декодирование с таймаутом: битый файл или окружение без поддержки картинок
 * не должны вешать отправку — по таймауту страница уходит как есть.
 */
const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T | null> =>
  Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);

async function decodeInBrowser(file: Blob, dataURL: string, timeoutMs: number): Promise<DecodedImage | null> {
  const decode = (async () => {
    if (typeof createImageBitmap === "function") {
      const bitmap = await createImageBitmap(file);
      return {
        width: bitmap.width,
        height: bitmap.height,
        source: bitmap as CanvasImageSource,
        close: () => bitmap.close?.(),
      } satisfies DecodedImage;
    }
    if (typeof Image === "undefined") return null;
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("Не удалось прочитать изображение"));
      img.src = dataURL;
    });
    return { width: img.naturalWidth, height: img.naturalHeight, source: img } satisfies DecodedImage;
  })();

  return withTimeout(decode, timeoutMs);
}

/**
 * Возвращает dataURL страницы, пригодный для отправки в `manga-analyze`.
 * Всегда резолвится строкой: при любой проблеме со сжатием отдаётся исходный файл.
 */
export async function toPageDataURL(file: Blob, options: PageDataUrlOptions = {}): Promise<string> {
  const maxSide = options.maxSide ?? MAX_PAGE_SIDE_PX;
  const maxBytes = options.maxBytes ?? MAX_PAGE_DATA_URL_BYTES;
  const raw = await blobToDataURL(file);

  const decode = options.decode ?? ((f: Blob, url: string) => decodeInBrowser(f, url, options.decodeTimeoutMs ?? DECODE_TIMEOUT_MS));
  let decoded: DecodedImage | null = null;
  try {
    decoded = await decode(file, raw);
  } catch {
    decoded = null;
  }

  const fits = estimateDataURLBytes(raw) <= maxBytes;
  const target = decoded ? computeScaledSize(decoded.width, decoded.height, maxSide) : null;
  if (!decoded || !target || (target.scale >= 1 && fits)) {
    decoded?.close?.();
    return raw;
  }

  try {
    const canvas = (options.canvasFactory ?? (() => document.createElement("canvas")))();
    const ctx = canvas.getContext?.("2d") as CanvasRenderingContext2D | null;
    if (!ctx) return raw;

    canvas.width = target.width;
    canvas.height = target.height;
    ctx.drawImage(decoded.source, 0, 0, target.width, target.height);

    let out = "";
    for (const quality of JPEG_QUALITY_STEPS) {
      out = canvas.toDataURL("image/jpeg", quality);
      if (estimateDataURLBytes(out) <= maxBytes) break;
    }
    return out || raw;
  } catch {
    return raw;
  } finally {
    decoded.close?.();
  }
}

/** Человекочитаемая причина отказа (для плашки в модалке). */
export function formatRejections(rejected: PageFileRejection[]): string {
  if (!rejected.length) return "";
  const shown = rejected.slice(0, 3).map((r) => `${r.name} — ${r.reason}`).join("; ");
  const rest = rejected.length > 3 ? ` и ещё ${rejected.length - 3}` : "";
  return `Не добавлено: ${shown}${rest}`;
}
