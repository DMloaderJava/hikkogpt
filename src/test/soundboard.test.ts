import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SOUND_EFFECTS,
  SOUND_PATHS,
  SoundboardPlayer,
  isSoundEffect,
} from "@/lib/soundboard";
import {
  installWebAudioMock,
  MockAudioBufferSourceNode,
  MockGainNode,
  mockSoundResponse,
  type WebAudioMockHandle,
} from "./webAudioMock";

function fetchMock(options: { failFor?: string[] } = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const failing = (options.failFor ?? []).some((name) => url.endsWith(`/${name}.mp3`));
    if (failing) throw new Error("network down");
    return mockSoundResponse(128);
  });
}

describe("SoundboardPlayer", () => {
  let mock: WebAudioMockHandle;
  let player: SoundboardPlayer;
  let ctx: AudioContext;

  beforeEach(() => {
    mock = installWebAudioMock({ sampleRate: 24000 });
    // Контекст создаётся ровно так же, как его создаст AudioPlaybackEngine.
    const Ctor = window.AudioContext as unknown as new (options?: AudioContextOptions) => AudioContext;
    ctx = new Ctor();
    player = new SoundboardPlayer(ctx);
  });

  afterEach(() => {
    mock.restore();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("описывает 4 эффекта и их пути в /public/sounds", () => {
    expect(SOUND_EFFECTS).toHaveLength(4);
    expect(SOUND_PATHS.referee_whistle).toBe("/sounds/referee_whistle.mp3");
    expect(SOUND_PATHS.creepy_slow_laugh).toBe("/sounds/creepy_slow_laugh.mp3");
  });

  it("проверяет имя эффекта, пришедшее от модели в function call", () => {
    expect(isSoundEffect("belly_laugh")).toBe(true);
    expect(isSoundEffect("rickroll")).toBe(false);
    expect(isSoundEffect(undefined)).toBe(false);
  });

  it("предзагружает все 4 звука в AudioBuffer", async () => {
    const fetchFn = fetchMock();
    vi.stubGlobal("fetch", fetchFn);

    await player.preload();

    expect(fetchFn).toHaveBeenCalledTimes(4);
    expect(player.loadedCount).toBe(4);
    expect(player.ready).toBe(true);
    expect(player.isLoaded("wheeze_laugh")).toBe(true);
  });

  it("повторный preload() не перекачивает файлы, а force=true — перекачивает", async () => {
    const fetchFn = fetchMock();
    vi.stubGlobal("fetch", fetchFn);

    await Promise.all([player.preload(), player.preload()]);
    expect(fetchFn).toHaveBeenCalledTimes(4);

    await player.preload(true);
    expect(fetchFn).toHaveBeenCalledTimes(8);
  });

  it("продолжает работать, если один файл не скачался", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", fetchMock({ failFor: ["belly_laugh"] }));

    await player.preload();

    expect(player.loadedCount).toBe(3);
    expect(player.ready).toBe(false);
    expect(player.isLoaded("belly_laugh")).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("belly_laugh"), expect.anything());
  });

  it("повторный preload() докачивает только то, что упало в прошлый раз", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let failing = true;
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/belly_laugh.mp3") && failing) throw new Error("network down");
      return mockSoundResponse(128);
    });
    vi.stubGlobal("fetch", fetchFn);

    await player.preload();
    expect(player.loadedCount).toBe(3);

    failing = false;
    await player.preload();

    expect(player.loadedCount).toBe(4);
    expect(player.ready).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(5); // 4 в первый раз + только недостающий
    warn.mockRestore();
  });

  it("работает с Safari-версией decodeAudioData (только колбэки, без промиса)", async () => {
    mock.restore();
    mock = installWebAudioMock({ sampleRate: 24000, callbackOnlyDecode: true });
    const Ctor = window.AudioContext as unknown as new (options?: AudioContextOptions) => AudioContext;
    ctx = new Ctor();
    player = new SoundboardPlayer(ctx);
    vi.stubGlobal("fetch", fetchMock());

    await player.preload();

    expect(player.loadedCount).toBe(4);
  });

  it("play() проигрывает предзагруженный буфер мгновенно и поверх речи", async () => {
    vi.stubGlobal("fetch", fetchMock());
    await player.preload();

    const output = ctx.destination;
    const played = player.play("referee_whistle");

    expect(played).toBe(true);
    const source = mock.context.createdSources[0];
    expect(source.startTime).toBe(0); // старт без задержки на fetch/decode
    expect(source.buffer).not.toBeNull();
    expect((source.connections[0] as unknown as MockGainNode).gain.value).toBe(0.9);
    expect(source.connections[0].connections).toContain(output);
  });

  it("play() учитывает громкость и разброс темпа, клампя громкость", async () => {
    vi.stubGlobal("fetch", fetchMock());
    await player.preload();

    player.play("belly_laugh", { volume: 2, playbackRate: 1.04 });

    const source = mock.context.createdSources[0];
    expect((source.connections[0] as unknown as MockGainNode).gain.value).toBe(1);
    expect(source.playbackRate.value).toBe(1.04);
  });

  it("play() до предзагрузки не бросает исключение, а предупреждает", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(player.play("belly_laugh")).toBe(false);
    expect(mock.context.createdSources).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("не найден в буфере: belly_laugh"));
  });

  it("play() с неизвестным именем эффекта игнорируется", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", fetchMock());
    await player.preload();

    expect(player.play("air_horn")).toBe(false);
    expect(mock.context.createdSources).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Неизвестный звук: air_horn"));
  });

  it("stopAll() глушит хохот при barge-in коротким фейдом", async () => {
    vi.stubGlobal("fetch", fetchMock());
    await player.preload();

    player.play("wheeze_laugh");
    player.play("creepy_slow_laugh");
    mock.context.currentTime = 2;
    player.stopAll();

    for (const source of mock.context.createdSources as MockAudioBufferSourceNode[]) {
      expect(source.stopTime).toBeCloseTo(2.02, 6);
      const gain = source.connections[0] as unknown as MockGainNode;
      expect(gain.gain.events.some((e) => e.type === "linearRampToValueAtTime")).toBe(true);
    }
  });

  it("уже отыгравшие эффекты не перезапускаются и не считаются активными", async () => {
    vi.stubGlobal("fetch", fetchMock());
    await player.preload();

    player.play("referee_whistle");
    const source = mock.context.createdSources[0] as MockAudioBufferSourceNode;
    const gain = source.connections[0] as unknown as MockGainNode;
    source.onended?.(); // эффект доиграл сам

    player.stopAll();

    expect(source.stopTime).toBeNull();
    expect(gain.disconnected).toBe(true);
  });

  it("пишет звук в переданный outputNode (общая шина движка)", async () => {
    const bus = new MockGainNode();
    const onBus = new SoundboardPlayer(ctx, bus as unknown as AudioNode);
    vi.stubGlobal("fetch", fetchMock());
    await onBus.preload();

    onBus.play("belly_laugh", 0.5);

    expect(bus.incoming).toHaveLength(1);
    expect((bus.incoming[0] as unknown as MockGainNode).gain.value).toBe(0.5);
  });

  it("dispose() освобождает буферы, после него play() невозможен", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", fetchMock());
    await player.preload();

    player.dispose();

    expect(player.loadedCount).toBe(0);
    expect(player.play("belly_laugh")).toBe(false);
    expect(warn).toHaveBeenCalled();
  });
});
