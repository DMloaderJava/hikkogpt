import type { VoiceAgentState } from "@/types/gemini-live";

/**
 * Чистая математика для Canvas-сферы VoiceVisualizer: без обращений к DOM —
 * поэтому её можно проверять тестами, не поднимая canvas.
 */

export interface OrbHues {
  /** Основной тон ядра. */
  base: number;
  /** Акцент: свечение и микрофонное кольцо. */
  accent: number;
}

/** Тона по умолчанию — используются, если CSS-переменные недоступны. */
export const ORB_FALLBACK_HUES: Record<VoiceAgentState, OrbHues> = {
  idle: { base: 215, accent: 215 },
  listening: { base: 205, accent: 190 },
  thinking: { base: 265, accent: 285 },
  speaking: { base: 165, accent: 150 },
};

export const TAU = Math.PI * 2;

/** HSL-строка для canvas: `hsl(210 100% 52%)`, с альфой — `hsl(... / 0.5)`. */
export function hslColor(hue: number, saturation: number, lightness: number, alpha = 1): string {
  const h = Number.isFinite(hue) ? hue : 210;
  const s = clamp01(saturation / 100) * 100;
  const l = clamp01(lightness / 100) * 100;
  if (alpha >= 1) return `hsl(${h} ${s}% ${l}%)`;
  return `hsl(${h} ${s}% ${l}% / ${clamp01(alpha)})`;
}

/**
 * Достаёт тон из значения CSS-переменной вида `"210 100% 52%"` (так хранит
 * цвета index.css, потому что Tailwind оборачивает их в `hsl(var(--x))`).
 */
export function parseHue(cssValue: string | null | undefined, fallback: number): number {
  if (!cssValue) return fallback;
  const match = /(-?\d+(?:\.\d+)?)/.exec(cssValue.trim());
  if (!match) return fallback;
  const hue = Number(match[1]);
  if (!Number.isFinite(hue)) return fallback;
  return ((hue % 360) + 360) % 360;
}

/**
 * Общая громкость 0..1: RMS осциллограммы и средний уровень низких бинов
 * спектра. Для речи берём максимум из двух — спектр реагирует быстрее, RMS
 * стабильнее.
 */
export function computeLevel(
  frequency: Uint8Array | null,
  waveform: Uint8Array | null
): number {
  let rms = 0;
  if (waveform && waveform.length > 0) {
    let sum = 0;
    for (let i = 0; i < waveform.length; i++) {
      // Осциллограмма приходит со смещением 128 (беззнаковый байт).
      const value = (waveform[i] - 128) / 128;
      sum += value * value;
    }
    rms = Math.sqrt(sum / waveform.length);
  }

  let spectral = 0;
  if (frequency && frequency.length > 0) {
    const bins = Math.min(frequency.length, 48); // низ и середина — там энергия речи
    let sum = 0;
    for (let i = 0; i < bins; i++) sum += frequency[i];
    spectral = sum / bins / 255;
  }

  // Речь редко дотягивает до 1.0 — подтягиваем, чтобы сфера жила, а не дрожала.
  return clamp01(Math.max(rms, spectral) * 1.6);
}

/** Раскладывает спектр в `barCount` дорожек (максимум по группе бинов). */
export function sampleBars(
  frequency: Uint8Array,
  barCount: number,
  out?: Float32Array
): Float32Array {
  const bars = out && out.length === barCount ? out : new Float32Array(barCount);
  const total = frequency.length;

  if (total === 0 || barCount === 0) {
    bars.fill(0);
    return bars;
  }

  for (let i = 0; i < barCount; i++) {
    const start = Math.floor((i * total) / barCount);
    const end = Math.max(start + 1, Math.floor(((i + 1) * total) / barCount));

    let max = 0;
    for (let bin = start; bin < end && bin < total; bin++) {
      if (frequency[bin] > max) max = frequency[bin];
    }
    bars[i] = max / 255;
  }

  return bars;
}

/**
 * Экспоненциальное сглаживание дорожек на месте: вверх (attack) быстро, вниз
 * (release) медленно — иначе столбики «звенят» на каждом кадре.
 */
export function smoothBars(
  current: Float32Array,
  target: Float32Array,
  attack = 0.55,
  release = 0.12
): void {
  const count = Math.min(current.length, target.length);
  for (let i = 0; i < count; i++) {
    const raw = target[i];
    const goal = Number.isFinite(raw) ? clamp01(raw) : 0;
    const factor = goal > current[i] ? attack : release;
    current[i] += (goal - current[i]) * factor;
  }
}

/** Экспоненциальное сглаживание скаляра (0..1 по смыслу). */
export function smoothTowards(current: number, target: number, factor: number): number {
  const goal = Number.isFinite(target) ? target : 0;
  const k = Number.isFinite(factor) ? clamp01(factor) : 0.2;
  return current + (goal - current) * k;
}

/** Медленное «дыхание» сферы в простое: 0..1, период по умолчанию ~4.2 с. */
export function breath(timeMs: number, periodMs = 4200): number {
  if (!Number.isFinite(timeMs) || !Number.isFinite(periodMs) || periodMs <= 0) return 0.5;
  return (Math.sin((timeMs / periodMs) * TAU) + 1) / 2;
}

/** Уважаем настройку «уменьшить движение» — тогда сфера не крутится. */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
