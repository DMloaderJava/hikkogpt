/**
 * Вложения-изображения для строки ввода чата.
 *
 * Превью хранятся как лёгкие Blob-URL (URL.createObjectURL), а не base64-строки:
 * base64 фото 1280×720 весит 0.5–2 МБ текстом, и его присутствие в стейте
 * ChatInput заставляет React гонять мегабайты через Virtual DOM при каждом
 * нажатии клавиши. Конвертация в dataURL происходит один раз — в момент отправки.
 */

export interface ImageAttachment {
  id: string;
  /** Лёгкий превью-URL (URL.createObjectURL). Обязательно revoke после использования. */
  url: string;
  /** Исходные байты — для отправки на сервер. */
  blob: Blob;
}

export interface CapturedPhoto {
  blob: Blob;
  url: string;
}

/** Максимум вложений на одно сообщение. */
export const MAX_IMAGES_PER_MESSAGE = 5;

/**
 * E-mail, для которых лимит вложений НЕ применяется (кнопка камеры
 * не дизейблится, guard в handleCameraCapture пропускает).
 * Сравнение регистронезависимое.
 */
export const CAMERA_LIMIT_BYPASS_EMAILS: readonly string[] = ["babaevafarida8@gmail.com"];

export function isCameraLimitBypassed(userEmail: string | null | undefined): boolean {
  if (!userEmail) return false;
  const normalized = userEmail.trim().toLowerCase();
  return CAMERA_LIMIT_BYPASS_EMAILS.some((e) => e.toLowerCase() === normalized);
}

let attachmentSeq = 0;

export function createImageAttachment(blob: Blob): ImageAttachment {
  attachmentSeq += 1;
  return {
    id: `img-${Date.now().toString(36)}-${attachmentSeq}`,
    url: URL.createObjectURL(blob),
    blob,
  };
}

export function createImageAttachmentFromPhoto(photo: CapturedPhoto): ImageAttachment {
  attachmentSeq += 1;
  return { id: `img-${Date.now().toString(36)}-${attachmentSeq}`, url: photo.url, blob: photo.blob };
}

export function revokeImageAttachment(attachment: Pick<ImageAttachment, "url">): void {
  try {
    URL.revokeObjectURL(attachment.url);
  } catch {
    // ignore — URL уже отозван или невалиден
  }
}

/** Конвертация Blob → dataURL. Вызывать только в момент отправки. */
export function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error("Не удалось прочитать изображение"));
      reader.readAsDataURL(blob);
    } catch (err) {
      reject(err instanceof Error ? err : new Error("Не удалось прочитать изображение"));
    }
  });
}
