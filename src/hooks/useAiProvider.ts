import { useCallback, useEffect, useState } from "react";
import {
  AI_PROVIDER_STORAGE_KEY,
  getStoredAiProvider,
  isAiProvider,
  setStoredAiProvider,
  type AiProvider,
} from "@/types/ai-provider";

/** Событие same-tab синхронизации: выбор провайдера изменился. */
export const AI_PROVIDER_EVENT = "hikko:ai-provider-changed";

/**
 * Состояние выбранного API-провайдера с персистентностью в localStorage.
 * Синхронизируется между вкладками (событие `storage`) и между хуками
 * внутри вкладки (кастомное событие) — все потребители видят одно значение.
 */
export function useAiProvider() {
  const [provider, setProviderState] = useState<AiProvider>(getStoredAiProvider);

  const setProvider = useCallback((next: AiProvider) => {
    setProviderState(next);
    setStoredAiProvider(next);
    window.dispatchEvent(new Event(AI_PROVIDER_EVENT));
  }, []);

  useEffect(() => {
    const resync = () => setProviderState(getStoredAiProvider());
    const onStorage = (e: StorageEvent) => {
      if (e.key === AI_PROVIDER_STORAGE_KEY && isAiProvider(e.newValue)) {
        setProviderState(e.newValue);
      }
    };
    window.addEventListener(AI_PROVIDER_EVENT, resync);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(AI_PROVIDER_EVENT, resync);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return { provider, setProvider };
}
