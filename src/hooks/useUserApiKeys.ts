import { useCallback, useState } from "react";
import { toast } from "sonner";
import {
  MAX_USER_GEMINI_KEYS,
  getStoredUserKeyIndex,
  getStoredUserKeys,
  mergeUserKeys,
  parsePastedKeys,
  setStoredUserKeyIndex,
  setStoredUserKeys,
} from "@/lib/userApiKeys";

/**
 * Пользовательские Gemini-ключи из настроек.
 * `activeIndex` — ключ, с которого сервер начнёт перебор (обновляется
 * после каждого ответа: сервер сообщает, какой ключ реально сработал).
 */
export function useUserApiKeys() {
  const [keys, setKeysState] = useState<string[]>(getStoredUserKeys);
  const [activeIndex, setActiveIndexState] = useState<number>(getStoredUserKeyIndex);

  const setKeys = useCallback((next: string[]) => {
    setKeysState(next);
    setStoredUserKeys(next);
  }, []);

  const setActiveIndex = useCallback((index: number) => {
    const value = Math.max(0, Math.floor(index) || 0);
    setActiveIndexState(value);
    setStoredUserKeyIndex(value);
  }, []);

  const addKeysFromText = useCallback(
    (text: string) => {
      const incoming = parsePastedKeys(text);
      if (incoming.length === 0) {
        toast.warning("Вставьте хотя бы один ключ");
        return { added: 0, duplicates: 0, overflow: 0 };
      }
      const { merged, added, duplicates, overflow } = mergeUserKeys(keys, incoming);
      if (added > 0) {
        setKeys(merged);
        toast.success(added === 1 ? "Ключ добавлен" : `Добавлено ключей: ${added}`);
      } else if (duplicates > 0) {
        toast.info("Такие ключи уже добавлены");
      }
      if (overflow > 0) {
        toast.warning(`Лимит ${MAX_USER_GEMINI_KEYS} ключей: не поместилось: ${overflow}`);
      }
      return { added, duplicates, overflow };
    },
    [keys, setKeys],
  );

  const removeKey = useCallback(
    (index: number) => {
      const next = keys.filter((_, i) => i !== index);
      setKeys(next);
      setActiveIndexState((prev) => {
        const clamped = next.length === 0 ? 0 : Math.min(prev, next.length - 1);
        setStoredUserKeyIndex(clamped);
        return clamped;
      });
      toast.success("Ключ удалён");
    },
    [keys, setKeys],
  );

  const clearKeys = useCallback(() => {
    setKeys([]);
    setActiveIndex(0);
    toast.success("Все ключи удалены");
  }, [setKeys, setActiveIndex]);

  return { keys, activeIndex, setActiveIndex, addKeysFromText, removeKey, clearKeys };
}
