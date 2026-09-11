import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { describeSocketClose, useGeminiLive } from "@/hooks/useGeminiLive";
import {
  MockAudioNode,
  installWebAudioMock,
  mockSoundResponse,
  type WebAudioMockHandle,
} from "./webAudioMock";

/**
 * Тесты дирижёра голосового режима: связка «микрофон -> пре-ролл -> setup ->
 * кадры» и разбор ответов прокси. Сокет, Web Audio, микрофон и сессия
 * Supabase подменены, поэтому проверяется именно логика useGeminiLive, а не
 * браузер.
 */

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: async () => ({
        data: { session: { access_token: "jwt-test-token" } },
        error: null,
      }),
    },
  },
}));

/** Кадр ворклета: Int16 PCM, как в проде (512 сэмплов @16 кГц). */
function micFrame(seed: number): ArrayBuffer {
  const samples = new Int16Array(512);
  for (let i = 0; i < samples.length; i++) samples[i] = seed + i;
  return samples.buffer;
}

function toBase64(buffer: ArrayBuffer): string {
  return Buffer.from(new Uint8Array(buffer)).toString("base64");
}

/**
 * Стенд AudioWorkletNode. Наследуется от MockAudioNode, чтобы вести себя как
 * настоящий узел графа: движок подключает его к нулевому гейну, а мок
 * запоминает соединения.
 */
class WorkletStub extends MockAudioNode {
  static instances: WorkletStub[] = [];

  port = {
    onmessage: null as ((event: { data: ArrayBuffer }) => void) | null,
    posted: [] as unknown[],
    postMessage: (data: unknown) => {
      this.port.posted.push(data);
    },
  };

  constructor(
    public context: unknown,
    public name: string,
    public options?: unknown
  ) {
    super();
    WorkletStub.instances.push(this);
  }

  /** Эмулирует очередной чанк от ворклета. */
  emit(buffer: ArrayBuffer): void {
    this.port.onmessage?.({ data: buffer });
  }
}

type RealtimeInputFrame = {
  audio: { mimeType: string; data: string };
  mediaChunks?: unknown;
};

type ToolResponseFrame = {
  functionResponses: Array<{
    id?: string;
    name?: string;
    response: { output: Record<string, unknown> };
  }>;
};

type SetupFrame = {
  model: string;
  generationConfig: { responseModalities: string[] };
  tools: Array<{ functionDeclarations: Array<{ name: string }> }>;
};

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  closedWith: { code: number; reason: string } | null = null;

  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  /** Апгрейд удался: прокси/Google открыли сокет. */
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  emit(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    this.closedWith = { code, reason };
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  /** Закрытие со стороны сервера (без предварительного close()). */
  serverClose(code: number, reason = ""): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  /** Разобранные отправленные фреймы. */
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }

  /** Последний отправленный setup: после ротации на прокси их может быть несколько. */
  setupFrame(): SetupFrame | undefined {
    const setups = this.frames().filter((frame) => frame.setup);
    return setups[setups.length - 1]?.setup as SetupFrame | undefined;
  }

  realtimeFrames(): RealtimeInputFrame[] {
    return this.frames()
      .map((frame) => frame.realtimeInput)
      .filter(Boolean) as RealtimeInputFrame[];
  }

  toolResponseFrame(): ToolResponseFrame | undefined {
    return this.frames().find((frame) => frame.toolResponse)?.toolResponse as
      | ToolResponseFrame
      | undefined;
  }
}

const lastSocket = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
const lastWorklet = () => WorkletStub.instances[WorkletStub.instances.length - 1];

const SETUP_COMPLETE = { setupComplete: {} };
const PROXY_INFO = { proxyInfo: { model: "models/gemini-3.1-flash-live-preview" } };

describe("describeSocketClose", () => {
  it("считает нормальным только 1000 и 1005 — молчаливое закрытие", () => {
    expect(describeSocketClose(1000)).toBeNull();
    expect(describeSocketClose(1005)).toBeNull();
  });

  it("объясняет отказ авторизации и конец сессии на стороне Gemini", () => {
    expect(describeSocketClose(1008)).toContain("не авторизована");
    expect(describeSocketClose(4410, "connection timeout")).toContain("connection timeout");
    expect(describeSocketClose(4410)).toContain("Переподключитесь");
  });

  it("показывает причину, когда апстрим так и не поднялся (4408)", () => {
    const text = describeSocketClose(4408, "API key not valid");
    expect(text).toContain("не поднялась");
    expect(text).toContain("API key not valid");
  });

  it("для прочих кодов оставляет код и причину", () => {
    expect(describeSocketClose(4415, "boom")).toBe("Голосовая сессия закрыта (код 4415): boom.");
  });
});

describe("useGeminiLive", () => {
  let audioMock: WebAudioMockHandle;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    WorkletStub.instances = [];

    audioMock = installWebAudioMock({ sampleRate: 48000 });
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("AudioWorkletNode", WorkletStub);
    vi.stubGlobal("fetch", vi.fn(async () => mockSoundResponse()));

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => ({
          getTracks: () => [{ stop: vi.fn() }],
        })),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    audioMock.restore();
  });

  /** Поднимает сессию до состояния «connected»: сокет, proxyInfo, setupComplete. */
  async function connectSession() {
    const view = renderHook(() => useGeminiLive({ voiceName: "Aoede" }));

    await act(async () => {
      await view.result.current.connect();
    });

    const socket = lastSocket();
    expect(socket).toBeDefined();

    await act(async () => {
      socket.open();
    });

    return { view, socket };
  }

  it("шлёт setup по proxyInfo от прокси, а не по своему списку моделей", async () => {
    const { view, socket } = await connectSession();

    // До proxyInfo setup не отправляется: модель в URL апстрима может отличаться.
    expect(socket.frames().some((f) => f.setup)).toBe(false);

    await act(async () => {
      socket.emit(PROXY_INFO);
    });

    const setup = socket.setupFrame();
    expect(setup?.model).toBe("models/gemini-3.1-flash-live-preview");
    // Модель показывается в оверлее: видно, что деплой подхватил актуальную.
    expect(view.result.current.liveModel).toBe("models/gemini-3.1-flash-live-preview");
    expect(setup?.generationConfig.responseModalities).toEqual(["AUDIO"]);
    expect(setup?.tools[0].functionDeclarations[0].name).toBe("play_sound");
  });

  it("после ротации на прокси (новый proxyInfo) пересылает setup заново", async () => {
    const { socket } = await connectSession();

    await act(async () => {
      socket.emit(PROXY_INFO);
    });
    expect(socket.frames().filter((f) => f.setup)).toHaveLength(1);

    // Первая пара «модель × ключ» не поднялась, прокси открыл следующую и снова
    // прислал proxyInfo — без повторного setup сессия осталась бы без конфигурации.
    await act(async () => {
      socket.emit({ proxyInfo: { model: "models/gemini-2.5-flash-native-audio-preview-12-2025" } });
    });

    expect(socket.frames().filter((f) => f.setup)).toHaveLength(2);
    expect(socket.setupFrame()?.model).toBe("models/gemini-2.5-flash-native-audio-preview-12-2025");
  });

  it("до setupComplete копит кадры микрофона и досылает их после подтверждения", async () => {
    const { view, socket } = await connectSession();
    await act(async () => {
      socket.emit(PROXY_INFO);
    });

    const worklet = lastWorklet();
    const first = micFrame(1);
    const second = micFrame(2);

    await act(async () => {
      worklet.emit(first);
      worklet.emit(second);
    });

    // Gemini до setupComplete принимает только setup — кадры ждут в пре-ролле.
    expect(socket.realtimeFrames()).toHaveLength(0);

    await act(async () => {
      socket.emit(SETUP_COMPLETE);
    });

    expect(view.result.current.status).toBe("connected");
    const frames = socket.realtimeFrames();
    expect(frames).toHaveLength(2);
    expect(frames.map((f) => f.audio.data)).toEqual([
      toBase64(first),
      toBase64(second),
    ]);
  });

  it("использует актуальное поле realtimeInput.audio, а не mediaChunks", async () => {
    const { socket } = await connectSession();
    await act(async () => {
      socket.emit(PROXY_INFO);
      socket.emit(SETUP_COMPLETE);
    });

    const buffer = micFrame(7);
    await act(async () => {
      lastWorklet().emit(buffer);
    });

    const [frame] = socket.realtimeFrames();
    expect(frame.mediaChunks).toBeUndefined();
    expect(frame.audio).toEqual({
      mimeType: "audio/pcm;rate=16000",
      data: toBase64(buffer),
    });
  });

  it("на mute перестаёт отправлять микрофон и возвращается после снятия", async () => {
    const { view, socket } = await connectSession();
    await act(async () => {
      socket.emit(PROXY_INFO);
      socket.emit(SETUP_COMPLETE);
    });

    await act(async () => {
      view.result.current.toggleMute();
    });
    expect(view.result.current.isMuted).toBe(true);

    await act(async () => {
      lastWorklet().emit(micFrame(1));
    });
    expect(socket.realtimeFrames()).toHaveLength(0);

    await act(async () => {
      view.result.current.toggleMute();
    });
    // Отдельный тик: снятие mute применяется в обработчике состояния React,
    // а кадры микрофона приходят асинхронно из ворклета.
    await act(async () => {
      lastWorklet().emit(micFrame(2));
    });
    expect(socket.realtimeFrames()).toHaveLength(1);
  });

  it("отвечает на play_sound саундбордом и шлёт toolResponse", async () => {
    const onSoundTriggered = vi.fn();
    const view = renderHook(() => useGeminiLive({ onSoundTriggered }));

    await act(async () => {
      await view.result.current.connect();
    });
    const socket = lastSocket();

    await act(async () => {
      socket.open();
      socket.emit(PROXY_INFO);
      socket.emit(SETUP_COMPLETE);
      socket.emit({
        toolCall: {
          functionCalls: [{ id: "call-1", name: "play_sound", args: { sound_name: "belly_laugh" } }],
        },
      });
    });

    const toolResponse = socket.toolResponseFrame();
    expect(toolResponse?.functionResponses).toHaveLength(1);
    expect(toolResponse?.functionResponses[0].id).toBe("call-1");
    expect(toolResponse?.functionResponses[0].response.output.success).toBe(true);
    expect(onSoundTriggered).toHaveBeenCalledWith("belly_laugh");
  });

  it("на неизвестный вызов инструмента отвечает success: false, чтобы ход не завис", async () => {
    const { socket } = await connectSession();
    await act(async () => {
      socket.emit(PROXY_INFO);
      socket.emit(SETUP_COMPLETE);
      socket.emit({ toolCall: { functionCalls: [{ id: "x", name: "launch_missiles" }] } });
    });

    const [response] = socket.toolResponseFrame()!.functionResponses;
    expect(response.response.output).toEqual({ success: false, error: "unsupported_call" });
  });

  it("показывает текст ошибки, если прокси перебрал все ключи и модели", async () => {
    const onError = vi.fn();
    const view = renderHook(() => useGeminiLive({ onError }));

    await act(async () => {
      await view.result.current.connect();
    });
    const socket = lastSocket();

    await act(async () => {
      socket.open();
      socket.serverClose(4408, "API key not valid");
    });

    expect(view.result.current.status).toBe("error");
    expect(view.result.current.errorMessage).toContain("API key not valid");
    expect(onError).toHaveBeenCalled();
  });

  it("не дублирует ошибку: причина из фрейма + закрытие сокета = один тост", async () => {
    const onError = vi.fn();
    const view = renderHook(() => useGeminiLive({ onError }));

    await act(async () => {
      await view.result.current.connect();
    });
    const socket = lastSocket();

    await act(async () => {
      socket.open();
      socket.emit({ upstreamError: { code: 4408, reason: "model not found" } });
    });
    const afterFrame = onError.mock.calls.length;

    await act(async () => {
      socket.serverClose(4408, "model not found");
    });

    expect(afterFrame).toBe(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(view.result.current.status).toBe("error");
  });

  it("отделяет «Gemini закрыл рабочую сессию» от штатного завершения", async () => {
    const { view, socket } = await connectSession();
    await act(async () => {
      socket.emit(PROXY_INFO);
      socket.emit(SETUP_COMPLETE);
      socket.serverClose(4410, "connection timeout");
    });

    expect(view.result.current.status).toBe("error");
    expect(view.result.current.errorMessage).toContain("connection timeout");

    // А нормальное закрытие (1000) — без ошибки.
    const clean = renderHook(() => useGeminiLive());
    await act(async () => {
      await clean.result.current.connect();
    });
    await act(async () => {
      lastSocket().close(1000, "client cleanup");
    });
    expect(clean.result.current.status).toBe("disconnected");
    expect(clean.result.current.errorMessage).toBeNull();
  });
});
