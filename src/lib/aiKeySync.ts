/**
 * Единая обработка x-ai-key-* заголовков edge-функций.
 * Если ответ обработал ключ пользователя — запоминаем его активным,
 * чтобы следующий запрос начинался с него (ротация при исчерпании квоты).
 */
export function syncActiveKeyFromHeaders(
  headers: Headers | undefined | null,
  setActiveKeyIndex: (index: number) => void,
): { source: string | null; index: number } {
  if (!headers || typeof headers.get !== "function") return { source: null, index: -1 };
  const source = headers.get("x-ai-key-source");
  const raw = headers.get("x-ai-key-index");
  const index = raw == null ? NaN : Number.parseInt(raw, 10);
  if (source === "user" && Number.isInteger(index) && index >= 0) {
    setActiveKeyIndex(index);
    return { source, index };
  }
  return { source, index: -1 };
}

/** Та же логика для meta-события SSE (deepsearch отдаёт итог в потоке). */
export function syncActiveKeyFromMeta(
  meta: { keySource?: unknown; keyIndex?: unknown },
  setActiveKeyIndex: (index: number) => void,
): string | null {
  const { keySource, keyIndex } = meta;
  if (keySource === "user" && Number.isInteger(keyIndex) && (keyIndex as number) >= 0) {
    setActiveKeyIndex(keyIndex as number);
    return "user";
  }
  return typeof keySource === "string" ? keySource : null;
}
