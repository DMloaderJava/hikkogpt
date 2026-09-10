import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { VoiceVisualizer } from "@/components/VoiceVisualizer";
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
