/**
 * Выбор API-провайдера для чата.
 *
 * - `lovable` — запросы идут через Lovable AI Gateway
 *   (ключ LOVABLE_API_KEY на стороне edge-функции).
 * - `gemini` — запросы идут напрямую в Google Generative Language API
 *   (ключи GEMINI_API_KEYS на стороне edge-функции).
 *
 * Выбор хранится в localStorage и отправляется в edge-функцию `chat`
 * в поле `provider`. Если выбранный провайдер недоступен, сервер
 * автоматически переключается на запасной.
 */

export type AiProvider = "lovable" | "gemini";

export const AI_PROVIDER_STORAGE_KEY = "hikko-ai-provider";

export interface AiProviderMeta {
  id: AiProvider;
  /** Полное название для настроек. */
  label: string;
  /** Короткая подпись для компактного переключателя в шапке. */
  shortLabel: string;
  /** Пояснение, куда уходит запрос. */
  description: string;
}

export const AI_PROVIDERS: Record<AiProvider, AiProviderMeta> = {
  lovable: {
    id: "lovable",
    label: "Lovable AI",
    shortLabel: "Lovable",
    description: "Через Lovable API key",
  },
  gemini: {
    id: "gemini",
    label: "Gemini API",
    shortLabel: "Gemini",
    description: "Напрямую через Google",
  },
};

export const AI_PROVIDER_IDS: AiProvider[] = ["lovable", "gemini"];

export function isAiProvider(value: unknown): value is AiProvider {
  return value === "lovable" || value === "gemini";
}

export function getStoredAiProvider(): AiProvider {
  try {
    const raw = localStorage.getItem(AI_PROVIDER_STORAGE_KEY);
    return isAiProvider(raw) ? raw : "lovable";
  } catch {
    return "lovable";
  }
}

export function setStoredAiProvider(provider: AiProvider): void {
  try {
    localStorage.setItem(AI_PROVIDER_STORAGE_KEY, provider);
  } catch {
    /* ignore: приватный режим и т.п. */
  }
}
