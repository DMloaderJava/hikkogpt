import { SoundboardPlayer } from "@/lib/soundboard";

/** Формат вывода Gemini Live: PCM16 LE, mono, 24000 Hz. */
export const GEMINI_OUTPUT_SAMPLE_RATE = 24000;

/** Длина фейда при barge-in: короче — слышен щелчок, длиннее — «эхо» перебитой реплики. */
const BARGE_IN_FADE_SECONDS = 0.02;

export interface AudioPlaybackEngineOptions {
  /** Готовый AudioContext (тогда движок не создаёт и не закрывает его — владелец вызывает `close` сам). */
  audioContext?: AudioContext;
  /** Частота дискретизации входящих чанков Gemini. */
  sampleRate?: number;
  /** Начальная громкость общей шины, 0..1. */
  volume?: number;
}

interface ActiveChunk {
  source: AudioBufferSourceNode;
  gain: GainNode;
}

/**
 * PCM16 (base64, little-endian) -> Float32 [-1..1].
 * Нечётный «хвост» байта отбрасывается, битый base64 не роняет сессию.
 */
export function base64Pcm16ToFloat32(base64Data: string): Float32Array {
  if (!base64Data) return new Float32Array(0);

  let binary: string;
  try {
    binary = atob(base64Data.replace(/\s/g, ""));
  } catch (err) {
    console.warn("[AudioEngine] Битый base64-чанк, пропускаем", err);
    return new Float32Array(0);
  }

  const byteLength = binary.length - (binary.length % 2);
  if (byteLength === 0) return new Float32Array(0);

  const bytes = new Uint8Array(byteLength);
  for (let i = 0; i < byteLength; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  const view = new DataView(bytes.buffer);
  const samples = new Float32Array(byteLength / 2);
  for (let i = 0; i < samples.length; i++) {
    // Gemini отдаёт little-endian, поэтому читаем явно, а не через Int16Array
    // (тот использует порядок байт платформы).
    samples[i] = view.getInt16(i * 2, true) / 32768;
  }

  return samples;
}

/**
 * AudioPlaybackEngine — очередь воспроизведения речи Gemini Live.
 *
 * Gemini стримит чанки PCM16 24 кГц в base64. Движок раскладывает их встык:
 * каждый следующий стартует ровно в момент окончания предыдущего, поэтому
 * поток звучит бесшовно. Если очередь отстала (сеть дёрнулась, контекст был
 * усыплён) — чанк играет немедленно, без накопления задержки.
 *
 * Граф:
 *
 *   чанки Gemini ─> [BufferSource + Gain]* ─┐
 *                                           ├─> masterGain ─> analyser ─> destination
 *   soundboard ─────────────────────────────┘
 *
 * `outputNode` — общая шина. `createSoundboard()` подключает саундборд к ней же:
 * эффекты идут в тот же analyser (сфера реагирует на голос и на свисток) и
 * слушаются общим `setVolume()`.
 */
export class AudioPlaybackEngine {
  /** Частота входящих чанков (не частота AudioContext). */
  public readonly sampleRate: number;

  /** Для анимированной сферы: считайте `getByteFrequencyData` в RAF-цикле. */
  public readonly analyser: AnalyserNode;

  private readonly ctx: AudioContext;
  private readonly ownsContext: boolean;
  private readonly masterGain: GainNode;
  private activeChunks: ActiveChunk[] = [];
  private nextStartTime = 0;
  private closed = false;

  constructor(options: AudioPlaybackEngineOptions = {}) {
    this.sampleRate = options.sampleRate ?? GEMINI_OUTPUT_SAMPLE_RATE;
    this.ownsContext = !options.audioContext;
    this.ctx = options.audioContext ?? createBrowserAudioContext({ sampleRate: this.sampleRate });

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = clamp01(options.volume ?? 1, 1);

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256; // 128 бинов — сфере достаточно
    this.analyser.smoothingTimeConstant = 0.8; // анимация без дрожания

    // AnalyserNode пропускает сигнал сквозь себя без изменений.
    this.masterGain.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
  }

  get audioContext(): AudioContext {
    return this.ctx;
  }

  /** Шина, к которой подключается внешний звук (саундборд). */
  get outputNode(): AudioNode {
    return this.masterGain;
  }

  get state(): AudioContextState {
    return this.ctx.state;
  }

  get isPlaying(): boolean {
    return this.activeChunks.length > 0;
  }

  /** Сколько секунд речи уже стоит в очереди впереди текущего момента. */
  get queuedSeconds(): number {
    return Math.max(0, this.nextStartTime - this.ctx.currentTime);
  }

  /** Возобновить контекст (браузер требует клик перед воспроизведением звука). */
  async resume(): Promise<void> {
    if (this.ctx.state === "suspended") {
      await this.ctx.resume();
    }
  }

  /** Общая громкость речи и эффектов, 0..1. Без щелчка — короткий setTargetAtTime. */
  setVolume(volume: number): void {
    const target = clamp01(volume, 1);
    const now = this.ctx.currentTime;
    try {
      this.masterGain.gain.cancelScheduledValues(now);
      this.masterGain.gain.setTargetAtTime(target, now, 0.01);
    } catch {
      this.masterGain.gain.value = target;
    }
  }

  /** Добавление аудиочанка от Gemini в очередь бесшовного воспроизведения. */
  enqueuePcmChunk(base64Chunk: string): void {
    if (this.closed || !base64Chunk) return;

    const float32Data = base64Pcm16ToFloat32(base64Chunk);
    if (float32Data.length === 0) return;

    // Буфер создаём на «родной» частоте Gemini: если AudioContext открылся на
    // 48 кГц, Web Audio сам корректно ресемплирует при воспроизведении.
    const buffer = this.ctx.createBuffer(1, float32Data.length, this.sampleRate);
    buffer.getChannelData(0).set(float32Data);

    const gain = this.ctx.createGain();
    gain.gain.value = 1;

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    gain.connect(this.masterGain);

    const currentTime = this.ctx.currentTime;
    // Если очередь отстала или только началась — играем немедленно.
    if (this.nextStartTime < currentTime) {
      this.nextStartTime = currentTime;
    }

    const chunk: ActiveChunk = { source, gain };
    this.activeChunks.push(chunk);

    // Убираем завершённые ноды из очереди и отключаем gain от шины, иначе за
    // долгую сессию к masterGain накопятся тысячи «мёртвых» узлов.
    source.onended = () => {
      const idx = this.activeChunks.indexOf(chunk);
      if (idx !== -1) this.activeChunks.splice(idx, 1);
      try {
        gain.disconnect();
      } catch {
        /* уже отключён */
      }
    };

    source.start(this.nextStartTime);
    this.nextStartTime += buffer.duration;

    // Контекст мог быть усыплён политикой автоплея — будим на всякий случай.
    if (this.ctx.state === "suspended") void this.resume().catch(() => {});
  }

  /**
   * Моментальный сброс (barge-in): пользователь перебил или пришёл сигнал
   * `serverContent.interrupted`. Очередь чистится сразу, источники глушатся
   * коротким фейдом — без задержек и без щелчка.
   */
  stopAndClearQueue(fadeSeconds = BARGE_IN_FADE_SECONDS): void {
    const now = this.ctx.currentTime;
    const fade = Math.max(0, fadeSeconds);

    for (const { source, gain } of this.activeChunks) {
      try {
        if (fade > 0) {
          gain.gain.cancelScheduledValues(now);
          gain.gain.setValueAtTime(gain.gain.value, now);
          gain.gain.linearRampToValueAtTime(0, now + fade);
        } else {
          gain.gain.value = 0;
        }
        // onended не снимаем: он доотпустит gain после фейда.
        source.stop(now + fade);
      } catch {
        // Источник уже остановился сам — игнорируем.
      }
    }

    this.activeChunks = [];
    this.nextStartTime = now;
  }

  /** Саундборд на этом же AudioContext и этой же выходной шине, что и речь. */
  createSoundboard(): SoundboardPlayer {
    return new SoundboardPlayer(this.ctx, this.masterGain);
  }

  /**
   * Закрывает движок. Внешний AudioContext (переданный в конструктор) не
   * закрывается — им владеет тот, кто его создал.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    this.stopAndClearQueue(0);
    try {
      this.masterGain.disconnect();
      this.analyser.disconnect();
    } catch {
      /* уже отключено */
    }

    if (this.ownsContext && this.ctx.state !== "closed") {
      await this.ctx.close().catch(() => {});
    }
  }
}

/**
 * Создаёт AudioContext: поддержка webkit-префикса + фолбэк на нативные
 * настройки, если браузер не принял переданные (не все принимают произвольную
 * sampleRate или latencyHint).
 */
export function createBrowserAudioContext(options: AudioContextOptions = {}): AudioContext {
  const Ctor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) throw new Error("Web Audio API не поддерживается этим браузером");

  try {
    return new Ctor(options);
  } catch {
    return new Ctor();
  }
}

function clamp01(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}
