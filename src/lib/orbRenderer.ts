import type { VoiceAgentState } from "@/types/gemini-live";
import { TAU, hslColor, type OrbHues } from "@/lib/audioVisualization";

/** Сколько столбиков в частотном кольце. */
export const ORB_BAR_COUNT = 64;

/** Пропорции сферы относительно размера холста. */
export const ORB_GEOMETRY = {
  /** Радиус ядра. */
  baseRadius: 0.27,
  /** Во сколько раз столбики начинаются дальше ядра. */
  barInner: 1.06,
  /** Максимальная длина столбика относительно радиуса ядра. */
  barLength: 0.62,
  /** Радиус кольца микрофона. */
  micRing: 1.62,
} as const;

export interface OrbFrameParams {
  ctx: CanvasRenderingContext2D;
  /** Сторона квадрата в CSS-пикселях (без учёта devicePixelRatio). */
  size: number;
  state: VoiceAgentState;
  hues: OrbHues;
  /** Сглаженные амплитуды дорожек, 0..1, длина ORB_BAR_COUNT. */
  bars: Float32Array;
  /** Общий уровень звука, 0..1. */
  level: number;
  /** Уровень микрофона, 0..1 (внешнее кольцо). */
  micLevel: number;
  /** Время с начала сессии, мс. */
  timeMs: number;
  /** false — уменьшенная анимация: без вращения и «дыхания». */
  motion: boolean;
  /** Значение «дыхания» 0..1 на текущий момент. */
  idle: number;
}

/**
 * Кадр сферы. Чистая функция от параметров: рисует в переданный 2D-контекст и
 * ничего не знает ни про React, ни про AnalyserNode. Благодаря этому её можно
 * проверять юнит-тестами и рендерить в PNG вне браузера.
 */
export function drawOrbFrame(params: OrbFrameParams): void {
  const { ctx, size, state, hues, bars, level, micLevel, timeMs, motion, idle } = params;
  const center = size / 2;
  const baseRadius = size * ORB_GEOMETRY.baseRadius;
  const barInner = baseRadius * ORB_GEOMETRY.barInner;
  const barMax = baseRadius * ORB_GEOMETRY.barLength;
  const idleAmplitude = state === "idle" ? 0.05 : 0.03;
  const motionFactor = motion ? 1 : 0;

  ctx.clearRect(0, 0, size, size);

  // 1. Мягкое свечение вокруг ядра
  const glowRadius = baseRadius * (1.5 + level * 0.5 + idle * idleAmplitude * motionFactor);
  const glow = ctx.createRadialGradient(center, center, baseRadius * 0.15, center, center, glowRadius);
  glow.addColorStop(0, hslColor(hues.base, 92, 62, 0.32 + level * 0.28));
  glow.addColorStop(0.6, hslColor(hues.accent, 92, 58, 0.12 + level * 0.16));
  glow.addColorStop(1, hslColor(hues.accent, 92, 58, 0));
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(center, center, glowRadius, 0, TAU);
  ctx.fill();

  // 2. Частотное кольцо
  const aliveFloor = state === "idle" ? 0.02 : 0.07;
  const count = bars.length;
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(1.5, size * 0.008);

  for (let i = 0; i < count; i++) {
    const magnitude = Math.max(bars[i], aliveFloor * (0.6 + 0.4 * idle * motionFactor));
    const length = barMax * (0.18 + 0.82 * magnitude);
    const angle = (i / count) * TAU - Math.PI / 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    ctx.strokeStyle = hslColor(hues.accent, 90, state === "idle" ? 55 : 64, 0.22 + magnitude * 0.7);
    ctx.beginPath();
    ctx.moveTo(center + cos * barInner, center + sin * barInner);
    ctx.lineTo(center + cos * (barInner + length), center + sin * (barInner + length));
    ctx.stroke();
  }

  // 3. Ядро
  const coreRadius = baseRadius * (0.92 + level * 0.16 + idle * 0.02 * motionFactor);
  const core = ctx.createRadialGradient(
    center - coreRadius * 0.28,
    center - coreRadius * 0.32,
    coreRadius * 0.12,
    center,
    center,
    coreRadius
  );
  core.addColorStop(0, hslColor(hues.base, 96, 76, 0.96));
  core.addColorStop(0.62, hslColor(hues.base, 88, 56, 0.9));
  core.addColorStop(1, hslColor(hues.accent, 86, 44, 0.82));
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(center, center, coreRadius, 0, TAU);
  ctx.fill();

  // 4. «Думаю» — вращающиеся дуги
  if (state === "thinking") {
    const rotation = (timeMs / 1400) * TAU * motionFactor;
    ctx.strokeStyle = hslColor(hues.accent, 92, 68, 0.55);
    ctx.lineWidth = Math.max(2, size * 0.012);
    for (let i = 0; i < 2; i++) {
      const start = rotation + i * Math.PI;
      ctx.beginPath();
      ctx.arc(center, center, coreRadius * 1.22, start, start + Math.PI * 0.42);
      ctx.stroke();
    }
  }

  // 5. Кольцо микрофона: видно, как звучит голос пользователя
  if (micLevel > 0.015) {
    ctx.strokeStyle = hslColor(hues.accent, 95, 70, Math.min(0.75, 0.18 + micLevel * 1.6));
    ctx.lineWidth = Math.max(1.5, size * 0.01 * (1 + micLevel * 3));
    ctx.beginPath();
    ctx.arc(center, center, baseRadius * ORB_GEOMETRY.micRing, 0, TAU);
    ctx.stroke();
  }
}
