import { describe, expect, it } from "vitest";
import {
  ORB_FALLBACK_HUES,
  breath,
  computeLevel,
  hslColor,
  parseHue,
  sampleBars,
  smoothBars,
  smoothTowards,
} from "@/lib/audioVisualization";
import { VoiceActivityTracker, frameRms } from "@/lib/voiceActivity";
import { SOUND_EFFECTS, SOUND_LABELS } from "@/lib/soundboard";
import {
  LIVE_VOICE_NAMES,
  isLegacyLiveModel,
  resolveLiveVoiceName,
  shortLiveModelName,
} from "@/types/gemini-live";

describe("audioVisualization: тон и цвет", () => {
  it("достаёт тон из значения CSS-переменной вида '210 100% 52%'", () => {
    expect(parseHue("210 100% 52%", 0)).toBe(210);
    expect(parseHue(" 265.5 80% 60% ", 0)).toBeCloseTo(265.5, 5);
    expect(parseHue("-30 100% 50%", 0)).toBe(330);
    expect(parseHue("400 100% 50%", 0)).toBe(40);
  });

  it("на пустом или мусорном значении возвращает фолбэк", () => {
    expect(parseHue("", 217)).toBe(217);
    expect(parseHue(undefined, 217)).toBe(217);
    expect(parseHue("hsl(var(--interactive))", 217)).toBe(217);
  });

  it("собирает HSL-строку, клампя насыщенность и альфу", () => {
    expect(hslColor(210, 100, 50)).toBe("hsl(210 100% 50%)");
    expect(hslColor(210, 100, 50, 0.5)).toBe("hsl(210 100% 50% / 0.5)");
    // Альфа клампится до 1, а при alpha >= 1 часть "/ x" не печатается вовсе.
    expect(hslColor(210, 500, 500, 9)).toBe("hsl(210 100% 100%)");
    expect(hslColor(210, 50, 50, -5)).toBe("hsl(210 50% 50% / 0)");
  });

  it("для каждого состояния агента есть палитра", () => {
    expect(Object.keys(ORB_FALLBACK_HUES).sort()).toEqual([
      "idle",
      "listening",
      "speaking",
      "thinking",
    ]);
    for (const hues of Object.values(ORB_FALLBACK_HUES)) {
      expect(hues.base).toBeGreaterThanOrEqual(0);
      expect(hues.accent).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("audioVisualization: уровень и спектр", () => {
  const silentWave = new Uint8Array(256).fill(128);
  const silentSpectrum = new Uint8Array(128);

  it("на тишине даёт ноль", () => {
    expect(computeLevel(silentSpectrum, silentWave)).toBe(0);
    expect(computeLevel(null, null)).toBe(0);
  });

  it("растёт с амплитудой сигнала", () => {
    const quiet = new Uint8Array(256);
    const loud = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      quiet[i] = 128 + (i % 2 === 0 ? 10 : -10);
      loud[i] = 128 + (i % 2 === 0 ? 100 : -100);
    }

    const quietLevel = computeLevel(null, quiet);
    const loudLevel = computeLevel(null, loud);

    expect(quietLevel).toBeGreaterThan(0);
    expect(loudLevel).toBeGreaterThan(quietLevel);
    expect(loudLevel).toBeLessThanOrEqual(1);
  });

  it("раскладывает спектр в дорожки и держится в 0..1", () => {
    const spectrum = new Uint8Array(128);
    for (let i = 0; i < 128; i++) spectrum[i] = i * 2;

    const bars = sampleBars(spectrum, 64);

    expect(bars).toHaveLength(64);
    // 128 бинов на 64 дорожки = по 2 бина: в первой max(0, 2) = 2
    expect(bars[0]).toBeCloseTo(2 / 255, 6);
    expect(bars[63]).toBeCloseTo(254 / 255, 5);
    expect(Math.max(...bars)).toBeLessThanOrEqual(1);
    expect(Math.min(...bars)).toBeGreaterThanOrEqual(0);
  });

  it("на пустом спектре и нуле дорожек не падает", () => {
    expect(Array.from(sampleBars(new Uint8Array(0), 32))).toHaveLength(32);
    expect(Array.from(sampleBars(new Uint8Array(0), 32))).toEqual(new Array(32).fill(0));
    expect(Array.from(sampleBars(new Uint8Array(16), 0))).toHaveLength(0);
  });

  it("переиспользует переданный буфер дорожек", () => {
    const spectrum = new Uint8Array(32).fill(255);
    const out = new Float32Array(8);
    const result = sampleBars(spectrum, 8, out);

    expect(result).toBe(out);
    expect(Array.from(out)).toEqual(new Array(8).fill(1));
  });
});

describe("audioVisualization: сглаживание", () => {
  it("подтягивается к цели и не выходит из 0..1", () => {
    const current = new Float32Array([0, 0.5, 1]);
    const target = new Float32Array([1, 1, 0]);

    smoothBars(current, target, 0.5, 0.25);

    expect(current[0]).toBeCloseTo(0.5, 6); // 0 → 1 растёт со скоростью attack
    expect(current[1]).toBeCloseTo(0.75, 6); // 0.5 → 1 тоже растёт: attack
    expect(current[2]).toBeCloseTo(0.75, 6); // 1 → 0 падает: release

    for (let i = 0; i < 40; i++) smoothBars(current, target, 0.5, 0.25);
    expect(current[0]).toBeCloseTo(1, 3);
    expect(current[1]).toBeCloseTo(1, 3);
    expect(current[2]).toBeCloseTo(0, 3);
  });

  it("вверх идёт быстрее, чем вниз (attack/release)", () => {
    const rising = new Float32Array(1);
    const falling = new Float32Array([1]);

    smoothBars(rising, new Float32Array([1]), 0.5, 0.1);
    smoothBars(falling, new Float32Array([0]), 0.5, 0.1);

    expect(rising[0]).toBeGreaterThan(1 - falling[0]);
  });

  it("NaN и выход за диапазон трактует как тишину", () => {
    const current = new Float32Array([0.5, 0.5]);
    const target = new Float32Array([Number.NaN, 5]);

    smoothBars(current, target, 1, 1);

    expect(current[0]).toBe(0);
    expect(current[1]).toBe(1);
  });

  it("smoothTowards сходится и защищён от мусора", () => {
    let value = 0;
    for (let i = 0; i < 30; i++) value = smoothTowards(value, 1, 0.3);
    expect(value).toBeCloseTo(1, 3);
    // Нечисловой коэффициент — не повод замереть: берём мягкий дефолтный шаг.
    expect(smoothTowards(0.5, 1, Number.NaN)).toBeCloseTo(0.6, 6);
    expect(smoothTowards(0.5, Number.NaN, 0.5)).toBe(0.25);
  });

  it("breath держится в 0..1 и периодичен", () => {
    for (let t = 0; t <= 9000; t += 250) {
      const value = breath(t, 4200);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    expect(breath(0, 4200)).toBeCloseTo(0.5, 6);
    expect(breath(1050, 4200)).toBeCloseTo(1, 6); // четверть периода — пик
    expect(breath(2100, 4200)).toBeCloseTo(0.5, 6);
    expect(breath(4200, 4200)).toBeCloseTo(0.5, 6);
    expect(breath(Number.NaN, 4200)).toBe(0.5);
    expect(breath(1000, 0)).toBe(0.5);
  });
});

describe("voiceActivity: детектор речи пользователя", () => {
  const FRAME = 512;
  const loudFrame = (rms: number) =>
    new Int16Array(FRAME).map((_, i) => (i % 2 === 0 ? 1 : -1) * Math.round(rms * 32768));
  const silentFrame = () => new Int16Array(FRAME);

  it("frameRms считает RMS и защищён от пустого кадра", () => {
    expect(frameRms(new Int16Array(0))).toBe(0);
    expect(frameRms(silentFrame())).toBe(0);
    expect(frameRms(loudFrame(0.5))).toBeCloseTo(0.5, 2);
    expect(frameRms(new Int16Array(FRAME).fill(32767))).toBeCloseTo(1, 3);
  });

  it("начало речи требует подтверждающего кадра (щелчки не считаются)", () => {
    const vad = new VoiceActivityTracker({ threshold: 0.05, frameMs: 32 });

    expect(vad.push(loudFrame(0.2))).toBe("none"); // пока только один кадр
    expect(vad.push(silentFrame())).toBe("none"); // щелчок и тишина
    expect(vad.isSpeechActive).toBe(false);

    vad.push(loudFrame(0.2));
    expect(vad.push(loudFrame(0.2))).toBe("speech-start");
    expect(vad.isSpeechActive).toBe(true);
  });

  it("конец речи — по накопленной паузе, а не по первому тихому кадру", () => {
    const vad = new VoiceActivityTracker({ threshold: 0.05, frameMs: 32, silenceMs: 96 });

    vad.push(loudFrame(0.3));
    expect(vad.push(loudFrame(0.3))).toBe("speech-start");

    expect(vad.push(silentFrame())).toBe("none"); // 32 мс
    expect(vad.push(silentFrame())).toBe("none"); // 64 мс
    expect(vad.push(silentFrame())).toBe("speech-end"); // 96 мс — хватит
  });

  it("не спамит speech-start на непрерывной речи", () => {
    const vad = new VoiceActivityTracker({ threshold: 0.05 });

    const events = [loudFrame(0.3), loudFrame(0.3), loudFrame(0.3), loudFrame(0.3)].map((frame) =>
      vad.push(frame)
    );

    expect(events.filter((event) => event === "speech-start")).toHaveLength(1);
  });

  it("шум ниже порога не считается речью, пустой кадр — тишина", () => {
    const vad = new VoiceActivityTracker({ threshold: 0.1 });

    for (let i = 0; i < 10; i++) expect(vad.push(loudFrame(0.02))).toBe("none");
    expect(vad.isSpeechActive).toBe(false);
    expect(vad.push(new Int16Array(0))).toBe("none");
  });

  it("reset() возвращает трекер в исходное состояние", () => {
    const vad = new VoiceActivityTracker({ threshold: 0.05 });
    vad.push(loudFrame(0.3));
    vad.push(loudFrame(0.3));
    expect(vad.isSpeechActive).toBe(true);

    vad.reset();

    expect(vad.isSpeechActive).toBe(false);
    expect(vad.push(loudFrame(0.3))).toBe("none"); // снова нужен подтверждающий кадр
  });
});

describe("выбор голоса для Live API", () => {
  it("пропускает только имена, которые поддерживает Gemini Live", () => {
    expect(LIVE_VOICE_NAMES).toHaveLength(5);
    for (const name of LIVE_VOICE_NAMES) {
      expect(resolveLiveVoiceName(name)).toBe(name);
    }
  });

  it("подменяет голос из настроек, которого нет в Live (Leda)", () => {
    expect(resolveLiveVoiceName("Leda")).toBe("Aoede");
    expect(resolveLiveVoiceName("Kore", "Puck")).toBe("Kore");
    expect(resolveLiveVoiceName("Kore", "Fenrir")).toBe("Kore");
  });

  it("переживает пустое значение и старый мусор в localStorage", () => {
    expect(resolveLiveVoiceName(null)).toBe("Aoede");
    expect(resolveLiveVoiceName(undefined)).toBe("Aoede");
    expect(resolveLiveVoiceName("")).toBe("Aoede");
  });
});

describe("модель Live-сессии в UI", () => {
  it("сокращает имя модели для бейджа", () => {
    expect(shortLiveModelName("models/gemini-3.1-flash-live-preview")).toBe("gemini-3.1-flash-live");
    expect(shortLiveModelName("models/gemini-2.5-flash-native-audio-preview-12-2025")).toBe(
      "gemini-2.5-flash-native-audio-preview-12-2025"
    );
    expect(shortLiveModelName(null)).toBe("");
  });

  it("подсвечивает модели, снятые Google с эксплуатации", () => {
    expect(isLegacyLiveModel("models/gemini-2.0-flash-live-001")).toBe(true);
    expect(isLegacyLiveModel("models/gemini-live-2.5-flash-preview")).toBe(true);
    expect(isLegacyLiveModel("models/gemini-3.1-flash-live-preview")).toBe(false);
    expect(isLegacyLiveModel("models/gemini-2.5-flash-native-audio-preview-12-2025")).toBe(false);
    expect(isLegacyLiveModel(null)).toBe(false);
  });
});

describe("подписи звуков саундборда", () => {
  it("покрывают все 4 эффекта", () => {
    expect(Object.keys(SOUND_LABELS).sort()).toEqual([...SOUND_EFFECTS].sort());
    for (const label of Object.values(SOUND_LABELS)) {
      expect(label.length).toBeGreaterThan(0);
    }
  });
});
