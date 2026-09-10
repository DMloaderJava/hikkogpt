import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { VoiceVisualizer } from "@/components/VoiceVisualizer";
import { ORB_BAR_COUNT, ORB_GEOMETRY, drawOrbFrame } from "@/lib/orbRenderer";
import { ORB_FALLBACK_HUES } from "@/lib/audioVisualization";
import { MockAnalyserNode } from "./webAudioMock";

/**
 * jsdom не рисует canvas (getContext возвращает null), поэтому подменяем 2D-контекст
 * заглушкой и ведём requestAnimationFrame вручную — так тест проверяет, что кадр
 * действительно рисуется и что цикл корректно останавливается.
 */
interface StubContext {
  calls: Record<string, number>;
  gradientStops: { count: number };
}

function installCanvasStub(): StubContext {
  const calls: Record<string, number> = {};
  const gradientStops = { count: 0 };

  const record = (name: string) => {
    calls[name] = (calls[name] ?? 0) + 1;
  };

  const ctx = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    lineCap: "butt",
    setTransform: () => record("setTransform"),
    clearRect: () => record("clearRect"),
    beginPath: () => record("beginPath"),
    arc: () => record("arc"),
    fill: () => record("fill"),
    moveTo: () => record("moveTo"),
    lineTo: () => record("lineTo"),
    stroke: () => record("stroke"),
    createRadialGradient: () => {
      record("createRadialGradient");
      return {
        addColorStop: () => {
          gradientStops.count++;
        },
      };
    },
  };

  (HTMLCanvasElement.prototype as unknown as { getContext: unknown }).getContext = () =>
    ctx as unknown as CanvasRenderingContext2D;

  return { calls, gradientStops };
}

function installRafStub() {
  const queue = new Map<number, FrameRequestCallback>();
  const cancelled: number[] = [];
  let nextId = 1;

  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextId++;
    queue.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    cancelled.push(id);
    // Настоящий браузер снимает кадр с исполнения — заглушка обязана так же.
    queue.delete(id);
  });

  return {
    /** Выполняет все запланированные кадры (и добавленные ими следующие). */
    flush(frames = 1) {
      for (let i = 0; i < frames; i++) {
        const pending = Array.from(queue.entries());
        queue.clear();
        for (const [, callback] of pending) callback(performance.now());
      }
    },
    pending: () => queue.size,
    cancelled,
  };
}

describe("VoiceVisualizer", () => {
  let stub: StubContext;
  let raf: ReturnType<typeof installRafStub>;

  beforeEach(() => {
    stub = installCanvasStub();
    raf = installRafStub();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("рисует кадр из analyser: спектр, осциллограмма, кольцо и ядро", () => {
    const analyser = new MockAnalyserNode();
    analyser.fftSize = 256;
    analyser.frequencyValue = 180;
    analyser.waveformValue = 200;

    render(<VoiceVisualizer analyser={analyser as unknown as AnalyserNode} state="speaking" />);
    raf.flush(2);

    expect(analyser.getByteFrequencyData as unknown as ReturnType<typeof vi.fn>).toBeDefined();
    expect(stub.calls.clearRect).toBeGreaterThan(0);
    expect(stub.calls.arc).toBeGreaterThan(0);
    expect(stub.calls.stroke).toBeGreaterThan(0);
    expect(stub.gradientStops.count).toBeGreaterThan(0);
  });

  it("передаёт анализатору буферы нужного размера", () => {
    const analyser = new MockAnalyserNode();
    analyser.fftSize = 256;
    const spyFreq = vi.spyOn(analyser, "getByteFrequencyData");
    const spyWave = vi.spyOn(analyser, "getByteTimeDomainData");

    render(<VoiceVisualizer analyser={analyser as unknown as AnalyserNode} state="speaking" />);
    raf.flush(1);

    expect(spyFreq).toHaveBeenCalled();
    expect(spyFreq.mock.calls[0][0]).toHaveLength(analyser.frequencyBinCount);
    expect(spyWave.mock.calls[0][0]).toHaveLength(256);
  });

  it("работает без analyser — сфера просто дышит", () => {
    render(<VoiceVisualizer analyser={null} state="idle" />);
    raf.flush(3);

    expect(stub.calls.clearRect).toBeGreaterThan(0);
    expect(stub.calls.arc).toBeGreaterThan(0);
  });

  it("рисует микрофонное кольцо, когда говорит пользователь", () => {
    const inputAnalyser = new MockAnalyserNode();
    inputAnalyser.fftSize = 256;
    inputAnalyser.waveformValue = 230; // «есть голос»

    render(
      <VoiceVisualizer
        analyser={null}
        inputAnalyser={inputAnalyser as unknown as AnalyserNode}
        state="listening"
      />
    );
    raf.flush(8); // кольцо появляется только после сглаживания уровня

    const arcsWithMic = stub.calls.arc;
    expect(arcsWithMic).toBeGreaterThan(0);
    expect(stub.calls.stroke).toBeGreaterThan(0);
  });

  it("останавливает цикл анимации при размонтировании", () => {
    const { unmount } = render(<VoiceVisualizer analyser={null} state="listening" />);
    raf.flush(1);

    unmount();

    expect(raf.cancelled.length).toBeGreaterThan(0);
    expect(raf.pending()).toBe(0);
  });

  it("описывает состояние агента для скринридеров", () => {
    const { rerender } = render(<VoiceVisualizer analyser={null} state="listening" />);
    expect(screen.getByRole("img")).toHaveAttribute("aria-label", "Голосовой диалог: слушаю вас");

    rerender(<VoiceVisualizer analyser={null} state="thinking" />);
    expect(screen.getByRole("img")).toHaveAttribute("aria-label", "Голосовой диалог: думаю");

    rerender(<VoiceVisualizer analyser={null} state="speaking" />);
    expect(screen.getByRole("img")).toHaveAttribute("aria-label", "Голосовой диалог: говорю");
  });

  it("переживает отсутствие 2D-контекста (jsdom, старый браузер)", () => {
    (HTMLCanvasElement.prototype as unknown as { getContext: unknown }).getContext = () => null;

    expect(() => {
      render(<VoiceVisualizer analyser={null} state="idle" />);
      raf.flush(1);
    }).not.toThrow();
  });
});

describe("drawOrbFrame: кадр сферы как чистая функция", () => {
  let stub: StubContext;

  beforeEach(() => {
    stub = installCanvasStub();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const frame = (overrides: Partial<Parameters<typeof drawOrbFrame>[0]> = {}) => {
    const ctx = (document.createElement("canvas").getContext("2d") as unknown) as CanvasRenderingContext2D;
    const params: Parameters<typeof drawOrbFrame>[0] = {
      ctx,
      size: 240,
      state: "speaking",
      hues: ORB_FALLBACK_HUES.speaking,
      bars: new Float32Array(ORB_BAR_COUNT).fill(0.6),
      level: 0.7,
      micLevel: 0,
      timeMs: 350,
      motion: true,
      idle: 0.5,
      ...overrides,
    };
    drawOrbFrame(params);
    return params;
  };

  it("рисует по столбику на каждую дорожку", () => {
    frame();
    expect(stub.calls.stroke).toBeGreaterThanOrEqual(ORB_BAR_COUNT);
  });

  it("ядро рисуется всегда, кольцо микрофона — только при голосе", () => {
    stub.calls.stroke = 0;
    frame({ micLevel: 0 });
    const strokesWithoutMic = stub.calls.stroke;

    stub.calls.stroke = 0;
    frame({ micLevel: 0.5 });
    const strokesWithMic = stub.calls.stroke;

    // тишина в микрофоне не должна рисовать внешнее кольцо
    expect(strokesWithMic).toBeGreaterThan(strokesWithoutMic - ORB_BAR_COUNT + 1);
    expect(stub.calls.arc).toBeGreaterThan(0);
  });

  it("дуги «думаю» рисуются только в состоянии thinking", () => {
    stub.calls.arc = 0;
    frame({ state: "listening" });
    const arcsListening = stub.calls.arc;

    stub.calls.arc = 0;
    frame({ state: "thinking" });
    const arcsThinking = stub.calls.arc;

    expect(arcsThinking).toBeGreaterThan(arcsListening);
  });

  it("при уменьшенной анимации рисует тот же кадр (без вращения)", () => {
    const withMotion = frame({ motion: true });
    const withoutMotion = frame({ motion: false });

    expect(withMotion.bars.length).toBe(withoutMotion.bars.length);
    expect(stub.calls.clearRect).toBeGreaterThan(0);
  });

  it("столбики и кольцо микрофона вписываются в квадрат холста", () => {
    // Константы — множители радиуса ядра (а он доля стороны холста).
    const base = ORB_GEOMETRY.baseRadius;
    const barsOuter = base * (ORB_GEOMETRY.barInner + ORB_GEOMETRY.barLength);
    const micOuter = base * ORB_GEOMETRY.micRing + 0.02; // + половина максимальной толщины

    expect(ORB_GEOMETRY.micRing).toBeGreaterThan(ORB_GEOMETRY.barInner);
    expect(barsOuter).toBeLessThan(0.5);
    expect(micOuter).toBeLessThan(0.5);
  });
});
