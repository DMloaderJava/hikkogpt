/**
 * Пользовательские Gemini API ключи (BYOK).
 *
 * Хранятся ТОЛЬКО в localStorage на устройстве пользователя и отправляются
 * вместе с запросом в edge-функцию `chat`, которая перебирает их по кругу:
 * при исчерпании квоты (429/403/...) текущий ключ пропускается и пробуется
 * следующий. После пользовательских ключей пробуются серверные GEMINI_API_KEYS.
 */

export const MAX_USER_GEMINI_KEYS = 15;

const STORAGE_KEYS = "hikko-gemini-user-keys";
const STORAGE_INDEX = "hikko-gemini-user-key-index";

export function getStoredUserKeys(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((k): k is string => typeof k === "string" && k.trim().length > 0)
      .map((k) => k.trim())
      .slice(0, MAX_USER_GEMINI_KEYS);
  } catch {
    return [];
  }
}

export function setStoredUserKeys(keys: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEYS, JSON.stringify(keys.slice(0, MAX_USER_GEMINI_KEYS)));
  } catch {
    /* ignore: приватный режим и т.п. */
  }
}

export function getStoredUserKeyIndex(): number {
  try {
    const raw = Number.parseInt(localStorage.getItem(STORAGE_INDEX) || "0", 10);
    return Number.isInteger(raw) && raw >= 0 ? raw : 0;
  } catch {
    return 0;
  }
}

export function setStoredUserKeyIndex(index: number): void {
  try {
    localStorage.setItem(STORAGE_INDEX, String(Math.max(0, Math.floor(index) || 0)));
  } catch {
    /* ignore */
  }
}

/** Разбирает вставленный текст: один или несколько ключей через пробелы/запятые/переносы строк. */
export function parsePastedKeys(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8);
}

export interface MergeKeysResult {
  merged: string[];
  added: number;
  duplicates: number;
  overflow: number;
}

/** Добавляет новые ключи с дедупликацией и лимитом. */
export function mergeUserKeys(
  existing: string[],
  incoming: string[],
  max: number = MAX_USER_GEMINI_KEYS,
): MergeKeysResult {
  const seen = new Set(existing);
  const merged = [...existing];
  let added = 0;
  let duplicates = 0;
  let overflow = 0;
  for (const key of incoming) {
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    if (merged.length >= max) {
      overflow++;
      continue;
    }
    seen.add(key);
    merged.push(key);
    added++;
  }
  return { merged, added, duplicates, overflow };
}

/** Маскировка для отображения: AIza••••••••3f2a */
export function maskApiKey(key: string): string {
  if (key.length <= 8) return "••••••••";
  return `${key.slice(0, 4)}••••••••${key.slice(-4)}`;
}

/** Нестрогая проверка формата ключа Google AI Studio (AIza...). */
export function looksLikeGoogleKey(key: string): boolean {
  return /^AIza[0-9A-Za-z_-]{30,}$/.test(key);
}
