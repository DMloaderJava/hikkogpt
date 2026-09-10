import type { SoundEffectType } from "@/types/gemini-live";

/** Откуда брать mp3-эффекты (лежат в /public/sounds). */
export const SOUND_PATHS: Record<SoundEffectType, string> = {
  referee_whistle: "/sounds/referee_whistle.mp3",
  belly_laugh: "/sounds/belly_laugh.mp3",
  wheeze_laugh: "/sounds/wheeze_laugh.mp3",
  creepy_slow_laugh: "/sounds/creepy_slow_laugh.mp3",
};

export const SOUND_EFFECTS = Object.keys(SOUND_PATHS) as SoundEffectType[];

/** Человеческие подписи для UI (например, вспышки «Свисток судьи» в голосовом режиме). */
export const SOUND_LABELS: Record<SoundEffectType, string> = {
  referee_whistle: "Свисток судьи",
  belly_laugh: "Басовитый хохот",
  wheeze_laugh: "Истерический смех",
  creepy_slow_laugh: "Мрачный смех",
};

/** Проверка аргумента, который прилетел от модели в function call. */
export function isSoundEffect(value: unknown): value is SoundEffectType {
  return typeof value === "string" && value in SOUND_PATHS;
}

export interface PlayOptions {
  /** 0..1, по умолчанию 0.9 — эффект должен перекрывать речь. */
  volume?: number;
  /**
   * 1 — как записано. Небольшой разброс (0.95..1.05) убирает эффект
   * «одного и того же» хохота, когда шутка повторяется.
   */
  playbackRate?: number;
}

interface ActiveVoice {
  source: AudioBufferSourceNode;
  gain: GainNode;
}

const DEFAULT_VOLUME = 0.9;

/**
 * SoundboardPlayer — предзагрузка 4 mp3 в AudioBuffer и мгновенный запуск.
 *
 * Ключевой момент: звуки декодируются один раз при инициализации сессии, а
 * `play()` только создаёт BufferSource поверх уже готового буфера. Никакого
 * `new Audio()` в момент шутки — там полсекунды на fetch + decode, за которые
 * реплика уже пролетит.
 *
 * Контекст передаётся снаружи, чтобы саундборд и речь Gemini жили в одном
 * AudioContext (см. `AudioPlaybackEngine.createSoundboard()`).
 */
export class SoundboardPlayer {
  private ctx: AudioContext;
  private outputNode: AudioNode;
  private buffers: Map<SoundEffectType, AudioBuffer> = new Map();
  private active: Set<ActiveVoice> = new Set();
  private preloadPromise: Promise<void> | null = null;

  constructor(audioContext: AudioContext, outputNode?: AudioNode) {
    this.ctx = audioContext;
    this.outputNode = outputNode ?? audioContext.destination;
  }

  /** Сколько эффектов уже распаковано в память (0..4). */
  get loadedCount(): number {
    return this.buffers.size;
  }

  get ready(): boolean {
    return this.buffers.size === SOUND_EFFECTS.length;
  }

  isLoaded(soundName: SoundEffectType): boolean {
    return this.buffers.has(soundName);
  }

  /**
   * Предзагрузка всех 4 звуков в оперативку браузера.
   * Идемпотентна: повторный вызов не качает файлы заново (кроме `force`).
   * Падение одного файла не мешает остальным.
   */
  async preload(force = false): Promise<void> {
    if (!force) {
      if (this.ready) return; // всё уже распаковано
      if (this.preloadPromise) return this.preloadPromise; // загрузка уже идёт
    }

    const keys = force ? SOUND_EFFECTS : SOUND_EFFECTS.filter((key) => !this.buffers.has(key));

    const batch = Promise.all(
      keys.map(async (key) => {
        try {
          const response = await fetch(SOUND_PATHS[key]);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const arrayBuffer = await response.arrayBuffer();
          const decoded = await decodeAudioData(this.ctx, arrayBuffer);
          this.buffers.set(key, decoded);
        } catch (err) {
          console.warn(`[Soundboard] Не удалось загрузить звук: ${key}`, err);
        }
      })
    )
      .then(() => undefined)
      // Снимаем «замок», чтобы упавший файл можно было докачать следующим вызовом.
      .finally(() => {
        this.preloadPromise = null;
      });

    this.preloadPromise = batch;
    return batch;
  }

  /**
   * Мгновенное воспроизведение эффекта поверх речи.
   * Возвращает false, если звук ещё не предзагружен или неизвестен.
   */
  play(soundName: SoundEffectType | string, volumeOrOptions: number | PlayOptions = DEFAULT_VOLUME): boolean {
    const options: PlayOptions =
      typeof volumeOrOptions === "number" ? { volume: volumeOrOptions } : volumeOrOptions;

    if (!isSoundEffect(soundName)) {
      console.warn(`[Soundboard] Неизвестный звук: ${soundName}`);
      return false;
    }

    const buffer = this.buffers.get(soundName);
    if (!buffer) {
      console.warn(`[Soundboard] Звук не найден в буфере: ${soundName}`);
      return false;
    }

    // Контекст мог уснуть (таб в фоне, автоплей-политика) — будим, не дожидаясь.
    if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => {});

    const source = this.ctx.createBufferSource();
    const gain = this.ctx.createGain();

    source.buffer = buffer;
    source.playbackRate.value = options.playbackRate ?? 1;
    gain.gain.value = clamp01(options.volume ?? DEFAULT_VOLUME);

    source.connect(gain);
    gain.connect(this.outputNode);

    const voice: ActiveVoice = { source, gain };
    this.active.add(voice);
    // Единственное место, где голос освобождается: onended срабатывает и после
    // естественного конца, и после stop() — так gain не остаётся висеть на шине.
    source.onended = () => {
      this.active.delete(voice);
      try {
        gain.disconnect();
      } catch {
        /* уже отключён */
      }
    };

    source.start(0);
    return true;
  }

  /**
   * Заглушить все звучащие эффекты. Нужен при barge-in: пользователь перебил —
   * хохот должен оборваться вместе с репликой. Короткий фейд вместо `stop(0)`,
   * иначе на срезе слышен щелчок.
   */
  stopAll(fadeSeconds = 0.02): void {
    const now = this.ctx.currentTime;
    const fade = Math.max(0, fadeSeconds);

    for (const { source, gain } of this.active) {
      try {
        if (fade > 0) {
          gain.gain.cancelScheduledValues(now);
          gain.gain.setValueAtTime(gain.gain.value, now);
          gain.gain.linearRampToValueAtTime(0, now + fade);
        } else {
          gain.gain.value = 0;
        }
        source.stop(now + fade);
      } catch {
        // Источник уже остановился сам — это нормально.
      }
    }
    this.active.clear();
  }

  /** Полная выгрузка: стоп + освобождение буферов. */
  dispose(): void {
    this.stopAll(0);
    this.buffers.clear();
    this.preloadPromise = null;
  }
}

/** decodeAudioData с поддержкой старого callback-API Safari. */
function decodeAudioData(ctx: AudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise<AudioBuffer>((resolve, reject) => {
    const maybePromise = ctx.decodeAudioData(data, resolve, reject);
    if (maybePromise && typeof maybePromise.then === "function") {
      maybePromise.then(resolve, reject);
    }
  });
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_VOLUME;
  return Math.min(1, Math.max(0, value));
}
