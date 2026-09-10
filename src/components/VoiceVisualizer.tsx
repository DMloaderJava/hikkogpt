import { useEffect, useRef, useState } from "react";
import type { VoiceAgentState } from "@/types/gemini-live";
import {
  ORB_FALLBACK_HUES,
  TAU,
  breath,
  computeLevel,
  hslColor,
  parseHue,
  prefersReducedMotion,
  sampleBars,
  smoothBars,
  smoothTowards,
  type OrbHues,
} from "@/lib/audioVisualization";

const BAR_COUNT = 64;
const DEFAULT_SIZE = 232;

export interface VoiceVisualizerProps {
  /** Analyser общей шины движка: речь модели + звуки саундборда. */
  analyser: AnalyserNode | null;
  /** Analyser микрофона: тонкое внешнее кольцо, когда говорите вы. */
  inputAnalyser?: AnalyserNode | null;
  state: VoiceAgentState;
  /** Сторона квадрата в CSS-пикселях. */
  size?: number;
  className?: string;
}

const STATE_LABELS: Record<VoiceAgentState, string> = {
  idle: "голосовой режим в ожидании",
  listening: "слушаю вас",
  thinking: "думаю",
  speaking: "говорю",
};

/**
 * VoiceVisualizer — сфера на Canvas 2D, которую качает analyser движка.
 *
 * Почему canvas, а не CSS/Framer Motion: звук меняется 60 раз в секунду, и
 * обновлять состояние React на каждом кадре — это ре-рендер всего чата. Здесь
 * же данные тянутся из AnalyserNode внутри requestAnimationFrame, а React
 * участвует только в смене состояния агента.
 */
export function VoiceVisualizer({
  analyser,
  inputAnalyser = null,
  state,
  size = DEFAULT_SIZE,
  className,
}: VoiceVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<VoiceAgentState>(state);
  const huesRef = useRef<OrbHues>(ORB_FALLBACK_HUES[state]);
  const [interactiveHue, setInteractiveHue] = useState(ORB_FALLBACK_HUES.listening.base);

  stateRef.current = state;

  // Тон «слушаю» берём из темы, чтобы сфера не спорила с интерфейсом.
  useEffect(() => {
    const root = document.documentElement;
    const readHue = () => {
      try {
        const raw = getComputedStyle(root).getPropertyValue("--interactive");
        setInteractiveHue(parseHue(raw, ORB_FALLBACK_HUES.listening.base));
      } catch {
        /* в окружении без getComputedStyle остаёмся на фолбэке */
      }
    };

    readHue();

    let observer: MutationObserver | null = null;
    if (typeof MutationObserver !== "undefined") {
      observer = new MutationObserver(readHue);
      observer.observe(root, { attributes: true, attributeFilter: ["class", "style"] });
    }

    return () => observer?.disconnect();
  }, []);

  // Палитра текущего состояния; смена темы тоже сюда попадает. Обновление hues
  // не перезапускает RAF-цикл — он зависит только от анализаторов и размера.
  useEffect(() => {
    const fallback = ORB_FALLBACK_HUES[state];
    huesRef.current =
      state === "listening"
        ? { base: interactiveHue, accent: (interactiveHue + 20) % 360 }
        : { base: fallback.base, accent: fallback.accent };
  }, [state, interactiveHue]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // jsdom и очень старые браузеры могут не дать контекст — тогда просто
    // оставляем пустое место, но не роняем страницу.
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(2, typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const reducedMotion = prefersReducedMotion();
    const motion = reducedMotion ? 0 : 1;
    const center = size / 2;
    const baseRadius = size * 0.27;
    const barInner = baseRadius * 1.06;
    const barMax = baseRadius * 0.62;

    const bars = new Float32Array(BAR_COUNT);
    const target = new Float32Array(BAR_COUNT);
    const frequencyData = analyser ? new Uint8Array(Math.max(2, analyser.frequencyBinCount)) : null;
    const waveformData = analyser ? new Uint8Array(Math.max(2, analyser.fftSize)) : null;
    const micData = inputAnalyser ? new Uint8Array(Math.max(2, inputAnalyser.fftSize)) : null;

    let raf = 0;
    let level = 0;
    let micLevel = 0;
    let startedAt = 0;

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (startedAt === 0) startedAt = now;

      const agentState = stateRef.current;
      const hues = huesRef.current;
      const time = now - startedAt;

      // 1. Тянем данные из анализаторов (никакого React-состояния в кадре)
      let targetLevel = 0;
      if (analyser && frequencyData && waveformData) {
        analyser.getByteFrequencyData(frequencyData);
        analyser.getByteTimeDomainData(waveformData);
        sampleBars(frequencyData, BAR_COUNT, target);
        targetLevel = computeLevel(frequencyData, waveformData);
      } else {
        target.fill(0);
      }
      smoothBars(bars, target, 0.55, 0.12);
      level = smoothTowards(level, targetLevel, 0.35);

      let targetMic = 0;
      if (inputAnalyser && micData) {
        inputAnalyser.getByteTimeDomainData(micData);
        targetMic = computeLevel(null, micData);
      }
      micLevel = smoothTowards(micLevel, agentState === "speaking" ? 0 : targetMic, 0.3);

      const idle = reducedMotion ? 0.5 : breath(time, 4200);
      const idleAmplitude = agentState === "idle" ? 0.05 : 0.03;

      ctx.clearRect(0, 0, size, size);

      // 2. Мягкое свечение вокруг
      const glowRadius = baseRadius * (1.5 + level * 0.5 + idle * idleAmplitude * motion);
      const glow = ctx.createRadialGradient(center, center, baseRadius * 0.15, center, center, glowRadius);
      glow.addColorStop(0, hslColor(hues.base, 92, 62, 0.32 + level * 0.28));
      glow.addColorStop(0.6, hslColor(hues.accent, 92, 58, 0.12 + level * 0.16));
      glow.addColorStop(1, hslColor(hues.accent, 92, 58, 0));
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(center, center, glowRadius, 0, TAU);
      ctx.fill();

      // 3. Частотное кольцо из столбиков
      const aliveFloor = agentState === "idle" ? 0.02 : 0.07;
      ctx.lineCap = "round";
      ctx.lineWidth = Math.max(1.5, size * 0.008);

      for (let i = 0; i < BAR_COUNT; i++) {
        const magnitude = Math.max(bars[i], aliveFloor * (0.6 + 0.4 * idle * motion));
        const length = barMax * (0.18 + 0.82 * magnitude);
        const angle = (i / BAR_COUNT) * TAU - Math.PI / 2;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);

        ctx.strokeStyle = hslColor(
          hues.accent,
          90,
          agentState === "idle" ? 55 : 64,
          0.22 + magnitude * 0.7
        );
        ctx.beginPath();
        ctx.moveTo(center + cos * barInner, center + sin * barInner);
        ctx.lineTo(center + cos * (barInner + length), center + sin * (barInner + length));
        ctx.stroke();
      }

      // 4. Ядро сферы
      const coreRadius = baseRadius * (0.92 + level * 0.16 + idle * 0.02 * motion);
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

      // 5. «Думаю» — вращающиеся дуги вокруг ядра
      if (agentState === "thinking") {
        const rotation = reducedMotion ? 0 : (time / 1400) * TAU;
        ctx.strokeStyle = hslColor(hues.accent, 92, 68, 0.55);
        ctx.lineWidth = Math.max(2, size * 0.012);
        for (let i = 0; i < 2; i++) {
          const start = rotation + i * Math.PI;
          ctx.beginPath();
          ctx.arc(center, center, coreRadius * 1.22, start, start + Math.PI * 0.42);
          ctx.stroke();
        }
      }

      // 6. Кольцо микрофона: видно, как звучит ваш голос
      if (micLevel > 0.015) {
        ctx.strokeStyle = hslColor(hues.accent, 95, 70, Math.min(0.75, 0.18 + micLevel * 1.6));
        ctx.lineWidth = Math.max(1.5, size * 0.01 * (1 + micLevel * 3));
        ctx.beginPath();
        ctx.arc(center, center, baseRadius * 1.62, 0, TAU);
        ctx.stroke();
      }
    };

    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      bars.fill(0);
      target.fill(0);
    };
  }, [analyser, inputAnalyser, size]);

  return (
    <div
      className={className}
      style={{ width: size, height: size }}
      role="img"
      aria-label={`Голосовой диалог: ${STATE_LABELS[state]}`}
    >
      <canvas ref={canvasRef} style={{ width: size, height: size, display: "block" }} aria-hidden />
    </div>
  );
}

export default VoiceVisualizer;
