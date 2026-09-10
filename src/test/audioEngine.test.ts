import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AudioPlaybackEngine,
  GEMINI_OUTPUT_SAMPLE_RATE,
  base64Pcm16ToFloat32,
} from "@/lib/audioEngine";
import {
  installWebAudioMock,
  MockAudioBufferSourceNode,
  MockGainNode,
  mockSoundResponse,
  type WebAudioMockHandle,
} from "./webAudioMock";

/** Кодирует 16-bit PCM в base64 точно так, как это отдаёт Gemini (LE, mono). */
function pcm16Base64(samples: number[]): string {
  const view = new DataView(new ArrayBuffer(samples.length * 2));
  samples.forEach((sample, i) => view.setInt16(i * 2, sample, true));

  let binary = "";
  new Uint8Array(view.buffer).forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

const CHUNK_10MS = 240; // 240 сэмплов @ 24000 Гц = 10 мс
const chunk10ms = () => pcm16Base64(new Array(CHUNK_10MS).fill(1000));

describe("base64Pcm16ToFloat32", () => {
  it("нормализует int16 [-32768..32767] в float32 [-1..1]", () => {
    const result = base64Pcm16ToFloat32(pcm16Base64([0, 32767, -32768, 16384]));

    expect(Array.from(result)).toEqual([0, 32767 / 32768, -1, 0.5]);
  });

  it("читает little-endian независимо от платформы", () => {
    // 0x0100 LE == 1, 0xFF7F LE == -129
    const result = base64Pcm16ToFloat32(pcm16Base64([1, -129]));
    expect(result[0]).toBeCloseTo(1 / 32768, 10);
    expect(result[1]).toBeCloseTo(-129 / 32768, 10);
  });

  it("возвращает пустой массив на пустом и битом base64, не бросая исключение", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(base64Pcm16ToFloat32("")).toHaveLength(0);
    expect(base64Pcm16ToFloat32("!!! не base64 !!!")).toHaveLength(0);
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });
});

describe("AudioPlaybackEngine", () => {
  let mock: WebAudioMockHandle;

  beforeEach(() => {
    mock = installWebAudioMock();
  });

  afterEach(() => {
    mock.restore();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("открывает AudioContext на нативной частоте Gemini 24000 Гц", () => {
    const engine = new AudioPlaybackEngine();

    expect(GEMINI_OUTPUT_SAMPLE_RATE).toBe(24000);
    expect(engine.sampleRate).toBe(24000);
    expect(engine.audioContext.sampleRate).toBe(24000);
    expect(engine.state).toBe("suspended");
  });

  it("откатывается на нативную частоту, если браузер отверг 24000 Гц", () => {
    mock.restore();
    mock = installWebAudioMock({ rejectCustomSampleRate: true });

    const engine = new AudioPlaybackEngine();
    expect(engine.audioContext.sampleRate).toBe(48000);

    // Буферы всё равно создаются в родном формате Gemini — ресемплит Web Audio.
    engine.enqueuePcmChunk(chunk10ms());
    const source = mock.context.createdSources[0];
    expect(source.buffer?.sampleRate).toBe(24000);
  });

  it("строит граф masterGain -> analyser(256) -> destination", () => {
    const engine = new AudioPlaybackEngine();
    const master = engine.outputNode as unknown as MockGainNode;

    expect(engine.analyser.fftSize).toBe(256);
    expect(engine.analyser.smoothingTimeConstant).toBeGreaterThan(0);
    expect(master.connections).toContain(engine.analyser);
    expect((engine.analyser as unknown as MockGainNode).connections).toContain(mock.context.destination);
  });

  it("выстраивает чанки встык — без пауз и наложений", () => {
    const engine = new AudioPlaybackEngine();

    engine.enqueuePcmChunk(chunk10ms());
    engine.enqueuePcmChunk(chunk10ms());
    engine.enqueuePcmChunk(chunk10ms());

    const starts = mock.context.createdSources.map((s: MockAudioBufferSourceNode) => s.startTime);
    expect(starts).toEqual([0, 0.01, 0.02]);
    expect(engine.queuedSeconds).toBeCloseTo(0.03, 6);
    expect(engine.isPlaying).toBe(true);
  });

  it("играет немедленно, если очередь отстала (не копит задержку)", () => {
    const engine = new AudioPlaybackEngine();
    mock.context.currentTime = 5;

    engine.enqueuePcmChunk(chunk10ms());

    expect(mock.context.createdSources[0].startTime).toBe(5);
    expect(engine.queuedSeconds).toBeCloseTo(0.01, 6);
  });

  it("будит усыплённый контекст при resume() и при постановке чанка", async () => {
    const engine = new AudioPlaybackEngine();

    await engine.resume();
    expect(engine.state).toBe("running");
    expect(mock.context.resumedCount).toBe(1);

    mock.context.state = "suspended";
    engine.enqueuePcmChunk(chunk10ms());
    await vi.waitFor(() => expect(mock.context.resumedCount).toBe(2));
  });

  it("игнорирует пустые и битые чанки", () => {
    const engine = new AudioPlaybackEngine();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    engine.enqueuePcmChunk("");
    engine.enqueuePcmChunk("не base64");

    expect(mock.context.createdSources).toHaveLength(0);
    expect(engine.isPlaying).toBe(false);
    warn.mockRestore();
  });

  it("barge-in: мгновенно глушит очередь коротким фейдом и сбрасывает расписание", () => {
    const engine = new AudioPlaybackEngine();
    engine.enqueuePcmChunk(chunk10ms());
    engine.enqueuePcmChunk(chunk10ms());
    engine.enqueuePcmChunk(chunk10ms());

    mock.context.currentTime = 0.005;
    engine.stopAndClearQueue();

    for (const source of mock.context.createdSources) {
      expect(source.stopTime).toBeCloseTo(0.005 + 0.02, 6);
    }
    expect(engine.isPlaying).toBe(false);
    expect(engine.queuedSeconds).toBe(0);

    // Новая реплика начинается ровно с текущего момента, а не с хвоста старой очереди.
    engine.enqueuePcmChunk(chunk10ms());
    expect(mock.context.createdSources[3].startTime).toBe(0.005);
  });

  it("barge-in с нулевым фейдом останавливает источники на месте", () => {
    const engine = new AudioPlaybackEngine();
    engine.enqueuePcmChunk(chunk10ms());
    mock.context.currentTime = 1;

    engine.stopAndClearQueue(0);

    const source = mock.context.createdSources[0];
    expect(source.stopTime).toBe(1);
    expect(source.disconnected).toBe(false); // источники не отключаются насильно — ждём onended
  });

  it("создаёт повторный чанк контекста после перебивания (сессия продолжается)", () => {
    const engine = new AudioPlaybackEngine();
    engine.enqueuePcmChunk(chunk10ms());
    engine.stopAndClearQueue();

    engine.enqueuePcmChunk(chunk10ms());
    engine.enqueuePcmChunk(chunk10ms());

    const fresh = mock.context.createdSources.slice(1);
    expect(fresh.map((s) => s.startTime)).toEqual([0, 0.01]);
  });

  it("освобождает gain-ноду, когда чанк доиграл (нет утечки узлов)", () => {
    const engine = new AudioPlaybackEngine();
    engine.enqueuePcmChunk(chunk10ms());

    const source = mock.context.createdSources[0] as MockAudioBufferSourceNode;
    const gain = source.connections[0] as unknown as MockGainNode;

    source.onended?.(); // браузер сам дёргает это по окончании чанка

    expect(engine.isPlaying).toBe(false);
    expect(gain.disconnected).toBe(true);
  });

  it("setVolume клампит значение в диапазон 0..1", () => {
    const engine = new AudioPlaybackEngine();
    const master = engine.outputNode as unknown as MockGainNode;

    engine.setVolume(2);
    expect(master.gain.value).toBe(1);

    engine.setVolume(-3);
    expect(master.gain.value).toBe(0);

    engine.setVolume(0.4);
    expect(master.gain.value).toBeCloseTo(0.4, 6);
  });

  it("createSoundboard() подключает саундборд к общей шине движка", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => mockSoundResponse()));

    const engine = new AudioPlaybackEngine();
    const soundboard = engine.createSoundboard();
    await soundboard.preload();

    const master = engine.outputNode as unknown as MockGainNode;
    const incomingBefore = master.incoming.length;
    soundboard.play("referee_whistle");

    // Звук пришёл на ту же шину: общая громкость и общий analyser.
    expect(master.incoming.length).toBe(incomingBefore + 1);
    expect(master.incoming[master.incoming.length - 1]).toBeInstanceOf(MockGainNode);
  });

  it("close() закрывает собственный контекст и перестаёт принимать чанки", async () => {
    const engine = new AudioPlaybackEngine();
    engine.enqueuePcmChunk(chunk10ms());

    await engine.close();

    expect(mock.context.closedCount).toBe(1);
    expect(engine.isPlaying).toBe(false);

    engine.enqueuePcmChunk(chunk10ms());
    expect(mock.context.createdSources).toHaveLength(1);
  });

  it("close() не закрывает внешний AudioContext, переданный владельцем", async () => {
    const external = new (window.AudioContext as unknown as new () => AudioContext)();
    const engine = new AudioPlaybackEngine({ audioContext: external });

    await engine.close();

    expect((external as unknown as { closedCount: number }).closedCount).toBe(0);
    expect(external.state).not.toBe("closed");
  });
});
