/**
 * Минимальный мок Web Audio API для jsdom (в jsdom нет ни AudioContext, ни
 * decodeAudioData). Нужен только для тестов: считает созданные ноды и
 * запоминает, когда и куда что подключилось/запустилось.
 */

export class MockAudioParam {
  value = 0;
  events: Array<{ type: string; value?: number; time?: number }> = [];

  setValueAtTime(value: number, time: number) {
    this.value = value;
    this.events.push({ type: "setValueAtTime", value, time });
    return this;
  }

  linearRampToValueAtTime(value: number, time: number) {
    this.value = value;
    this.events.push({ type: "linearRampToValueAtTime", value, time });
    return this;
  }

  setTargetAtTime(value: number, time: number) {
    this.value = value;
    this.events.push({ type: "setTargetAtTime", value, time });
    return this;
  }

  cancelScheduledValues(time: number) {
    this.events.push({ type: "cancelScheduledValues", time });
    return this;
  }
}

export class MockAudioNode {
  static counter = 0;
  readonly id = ++MockAudioNode.counter;

  connections: MockAudioNode[] = [];
  incoming: MockAudioNode[] = [];
  disconnected = false;

  connect<T extends MockAudioNode>(target: T): T {
    this.connections.push(target);
    target.incoming.push(this);
    return target;
  }

  disconnect(): void {
    this.disconnected = true;
    this.connections = [];
  }
}

export class MockGainNode extends MockAudioNode {
  gain = new MockAudioParam();
}

export class MockAnalyserNode extends MockAudioNode {
  fftSize = 2048;
  smoothingTimeConstant = 0.8;
  /** Значение, которым мок заполняет спектр (0 — тишина). */
  frequencyValue = 0;
  /** Значение осциллограммы при тишине — центр беззнакового байта. */
  waveformValue = 128;

  get frequencyBinCount(): number {
    return this.fftSize / 2;
  }

  getByteFrequencyData(target: Uint8Array): void {
    target.fill(this.frequencyValue);
  }

  getByteTimeDomainData(target: Uint8Array): void {
    target.fill(this.waveformValue);
  }
}

export class MockAudioBuffer {
  private readonly channels: Float32Array[];

  constructor(
    public numberOfChannels: number,
    public length: number,
    public sampleRate: number
  ) {
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }

  get duration(): number {
    return this.length / this.sampleRate;
  }

  getChannelData(channel: number): Float32Array {
    return this.channels[channel];
  }
}

export class MockAudioBufferSourceNode extends MockAudioNode {
  buffer: MockAudioBuffer | null = null;
  playbackRate = new MockAudioParam();
  onended: (() => void) | null = null;
  startTime: number | null = null;
  stopTime: number | null = null;

  start(when = 0): void {
    this.startTime = when;
  }

  stop(when = 0): void {
    this.stopTime = when;
  }
}

export interface MockAudioContextOptions {
  sampleRate?: number;
  /** Эмулировать Safari: decodeAudioData только через колбэки, без промиса. */
  callbackOnlyDecode?: boolean;
  /** Падать на произвольной sampleRate — как некоторые мобильные браузеры. */
  rejectCustomSampleRate?: boolean;
}

export class MockAudioWorklet {
  readonly modules: string[] = [];

  async addModule(url: string): Promise<void> {
    this.modules.push(url);
  }
}

export class MockAudioContext {
  static instances: MockAudioContext[] = [];
  static defaultSampleRate = 48000;

  readonly sampleRate: number;
  state: AudioContextState = "suspended";
  currentTime = 0;
  destination = new MockAudioNode();

  /** Захват микрофона в голосовом режиме подключает ворклет через addModule. */
  readonly audioWorklet = new MockAudioWorklet();
  readonly mediaStreamSources: MockAudioNode[] = [];

  readonly createdSources: MockAudioBufferSourceNode[] = [];
  readonly createdGains: MockGainNode[] = [];
  readonly callbackOnlyDecode: boolean;
  resumedCount = 0;
  closedCount = 0;

  constructor(public options: MockAudioContextOptions = {}) {
    if (options.rejectCustomSampleRate && options.sampleRate) {
      throw new Error("Unsupported sampleRate");
    }
    this.sampleRate = options.sampleRate ?? MockAudioContext.defaultSampleRate;
    this.callbackOnlyDecode = options.callbackOnlyDecode ?? false;
    MockAudioContext.instances.push(this);
  }

  createGain(): MockGainNode {
    const node = new MockGainNode();
    this.createdGains.push(node);
    return node;
  }

  createAnalyser(): MockAnalyserNode {
    return new MockAnalyserNode();
  }

  createBuffer(numberOfChannels: number, length: number, sampleRate: number): MockAudioBuffer {
    return new MockAudioBuffer(numberOfChannels, length, sampleRate);
  }

  createBufferSource(): MockAudioBufferSourceNode {
    const node = new MockAudioBufferSourceNode();
    this.createdSources.push(node);
    return node;
  }

  createMediaStreamSource(_stream?: unknown): MockAudioNode {
    const node = new MockAudioNode();
    this.mediaStreamSources.push(node);
    return node;
  }

  decodeAudioData(
    data: ArrayBuffer,
    onSuccess?: (buffer: MockAudioBuffer) => void,
    onError?: (err: Error) => void
  ): Promise<MockAudioBuffer> | undefined {
    // «Декодируем»: длина в сэмплах = байты / 2 канала, моно.
    const decoded = new MockAudioBuffer(1, Math.max(1, data.byteLength / 2), this.sampleRate);
    const promise = Promise.resolve(decoded);
    if (this.callbackOnlyDecode) {
      promise.then((b) => onSuccess?.(b)).catch((e) => onError?.(e));
      return undefined;
    }
    if (onSuccess) promise.then(onSuccess).catch((e) => onError?.(e));
    return promise;
  }

  async resume(): Promise<void> {
    this.resumedCount++;
    this.state = "running";
  }

  async close(): Promise<void> {
    this.closedCount++;
    this.state = "closed";
  }
}

export interface WebAudioMockHandle {
  /** Первый (обычно единственный) созданный контекст. */
  readonly context: MockAudioContext;
  readonly contexts: MockAudioContext[];
  restore: () => void;
}

/** Подменяет window.AudioContext моком. Возвращает хэндл с функцией восстановления. */
export function installWebAudioMock(options: MockAudioContextOptions = {}): WebAudioMockHandle {
  const win = window as unknown as Record<string, unknown>;
  const original = win.AudioContext;
  const originalWebkit = win.webkitAudioContext;
  MockAudioContext.instances = [];

  const ContextCtor = function (this: unknown, ctorOptions?: AudioContextOptions) {
    const merged: MockAudioContextOptions = { ...options, sampleRate: ctorOptions?.sampleRate ?? options.sampleRate };
    if (merged.rejectCustomSampleRate && ctorOptions?.sampleRate) {
      throw new Error("Unsupported sampleRate");
    }
    return new MockAudioContext(merged);
  };
  Object.defineProperty(ContextCtor, "name", { value: "AudioContext" });

  win.AudioContext = ContextCtor;
  win.webkitAudioContext = ContextCtor;

  return {
    get context() {
      return MockAudioContext.instances[0];
    },
    get contexts() {
      return MockAudioContext.instances;
    },
    restore: () => {
      win.AudioContext = original;
      win.webkitAudioContext = originalWebkit;
    },
  };
}

/** Ответ fetch с фейковым mp3-payload (байтов хватит, чтобы проверить декод). */
export function mockSoundResponse(byteLength = 64, ok = true): Response {
  const buffer = new ArrayBuffer(byteLength);
  return {
    ok,
    status: ok ? 200 : 404,
    arrayBuffer: async () => buffer,
  } as unknown as Response;
}
