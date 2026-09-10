import { useEffect, useRef, useState } from "react";
import type { VoiceAgentState } from "@/types/gemini-live";
import {
  ORB_FALLBACK_HUES,
  breath,
  computeLevel,
  parseHue,
  prefersReducedMotion,
  sampleBars,
  smoothBars,
  smoothTowards,
  type OrbHues,
} from "@/lib/audioVisualization";
import { ORB_BAR_COUNT, drawOrbFrame } from "@/lib/orbRenderer";

const BAR_COUNT = ORB_BAR_COUNT;
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
    const motion = !reducedMotion;

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
      const time = now - startedAt;

      // 1. Данные из анализаторов — без состояния React
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

      // 2. Сам кадр — чистая функция (см. lib/orbRenderer)
      drawOrbFrame({
        ctx,
        size,
        state: agentState,
        hues: huesRef.current,
        bars,
        level,
        micLevel,
        timeMs: time,
        motion,
        idle: reducedMotion ? 0.5 : breath(time, 4200),
      });
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
