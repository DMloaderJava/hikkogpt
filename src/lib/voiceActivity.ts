/**
 * Локальный детектор голосовой активности по PCM-чанкам микрофона.
 *
 * Gemini Live не сообщает, когда пользователь закончил говорить, поэтому
 * состояние «thinking» в UI мы выводим сами: после речи и короткой паузы
 * показываем, что модель «думает». Логика чистая (только Int16-сэмплы и счётчик
 * кадров), поэтому проверяется тестами без браузера.
 */

export interface VoiceActivityOptions {
  /** Порог RMS (0..1) для «есть речь»: ниже — считаем тишиной. */
  threshold?: number;
  /** Сколько миллисекунд тишины после речи считать концом реплики. */
  silenceMs?: number;
  /** Длительность одного чанка: 512 сэмплов @16 кГц = 32 мс. */
  frameMs?: number;
  /** Сколько подряд громких кадров нужно, чтобы признать начало речи. */
  onsetFrames?: number;
}

export type VoiceActivityEvent = "speech-start" | "speech-end" | "none";

/** RMS 16-битных сэмплов, нормализованный в 0..1. */
export function frameRms(samples: Int16Array): number {
  if (!samples || samples.length === 0) return 0;

  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i] / 32768;
    sum += value * value;
  }
  return Math.sqrt(sum / samples.length);
}

export class VoiceActivityTracker {
  private readonly threshold: number;
  private readonly silenceFrames: number;
  private readonly onsetFrames: number;

  private speechActive = false;
  private loudStreak = 0;
  private quietFrames = 0;

  constructor(options: VoiceActivityOptions = {}) {
    const frameMs = options.frameMs && options.frameMs > 0 ? options.frameMs : 32;
    this.threshold = options.threshold ?? 0.02;
    this.onsetFrames = Math.max(1, options.onsetFrames ?? 2);
    this.silenceFrames = Math.max(1, Math.round((options.silenceMs ?? 550) / frameMs));
  }

  get isSpeechActive(): boolean {
    return this.speechActive;
  }

  /** Скармливает очередной чанк микрофона и возвращает событие, если оно случилось. */
  push(samples: Int16Array): VoiceActivityEvent {
    const loud = frameRms(samples) >= this.threshold;

    if (loud) {
      this.quietFrames = 0;
      this.loudStreak++;
      // Одиночный щелчок речью не считается — нужен подтверждающий кадр.
      if (!this.speechActive && this.loudStreak >= this.onsetFrames) {
        this.speechActive = true;
        return "speech-start";
      }
      return "none";
    }

    this.loudStreak = 0;
    if (!this.speechActive) return "none";

    this.quietFrames++;
    if (this.quietFrames >= this.silenceFrames) {
      this.speechActive = false;
      this.quietFrames = 0;
      return "speech-end";
    }
    return "none";
  }

  /** Сброс состояния (начало/конец сессии, перебивание). */
  reset(): void {
    this.speechActive = false;
    this.loudStreak = 0;
    this.quietFrames = 0;
  }
}
