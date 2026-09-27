import { useCallback, useEffect, useState } from "react";
import {
  AI_PROVIDER_STORAGE_KEY,
  getStoredAiProvider,
  isAiProvider,
  setStoredAiProvider,
  type AiProvider,
} from "@/types/ai-provider";

/**
 * Состояние выбранного API-провайдера с персистентностью в localStorage.
 * Синхронизируется между вкладками через событие `storage`.
 */
export function useAiProvider() {
  const [provider, setProviderState] = useState<AiProvider>(getStoredAiProvider);

  const setProvider = useCallback((next: AiProvider) => {
    setProviderState(next);
    setStoredAiProvider(next);
  }, []);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === AI_PROVIDER_STORAGE_KEY && isAiProvider(e.newValue)) {
        setProviderState(e.newValue);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return { provider, setProvider };
}
