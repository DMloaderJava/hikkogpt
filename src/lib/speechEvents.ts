/**
 * Глобальные события озвучки.
 *
 * Голосовой режим Gemini Live и озвучка сообщений чата (MessageBubble -> useTTS,
 * отдельный <audio>) не знают друг о друге: без такого «стопа» пользователь
 * получит два голоса одновременно. Событие шлётся при старте голосового режима.
 */
export const STOP_SPEECH_EVENT = "hikkogpt:stop-speech";

export function announceStopSpeech(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(STOP_SPEECH_EVENT));
  // Захват на случай, если что-то озвучивалось через браузерный синтез.
  try {
    window.speechSynthesis?.cancel();
  } catch {
    /* синтез недоступен */
  }
}
