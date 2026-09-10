import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Ворклет — обычный JS в /public, его нельзя импортировать как модуль: он живёт
 * в AudioWorkletGlobalScope. Поэтому читаем исходник и исполняем его в песочнице
 * с заглушками AudioWorkletProcessor / registerProcessor / sampleRate, а затем
 * гоняем process() вручную. Так проверяется главное — что на любой частоте
 * AudioContext на выходе действительно 16 000 Гц.
 */
const WORKLET_SOURCE = readFileSync(
  resolve(process.cwd(), "public/pcm-recorder-worklet.js"),
  "utf8"
);

const TARGET_RATE = 16000;
const FRAME_SAMPLES = 512;

interface WorkletProcessorLike {
  process(inputs: Float32Array[][]): boolean;
  port: { onmessage: ((event: { data: unknown }) => void) | null };
}

interface Harness {
  processor: WorkletProcessorLike;
  /** Все чанки, которые ворклет отправил на главный поток. */
  chunks: Int16Array[];
  flush: () => void;
}

function createHarness(sourceSampleRate: number, processorOptions: Record<string, unknown> = {}): Harness {
  const chunks: Int16Array[] = [];

  class StubAudioWorkletProcessor {
    port = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage: (data: ArrayBuffer) => {
        chunks.push(new Int16Array(data));
      },
    };
  }

  const factory = new Function(
    "AudioWorkletProcessor",
    "registerProcessor",
    "sampleRate",
    `${WORKLET_SOURCE}\n;return PcmRecorderProcessor;`
  ) as (
    processor: unknown,
    register: (name: string) => void,
    rate: number
  ) => new (options: unknown) => WorkletProcessorLike;

  const registered: string[] = [];
  const Processor = factory(StubAudioWorkletProcessor, (name) => registered.push(name), sourceSampleRate);
  expect(registered).toEqual(["pcm-recorder"]);

  const processor = new Processor({
    processorOptions: { frameSamples: FRAME_SAMPLES, targetSampleRate: TARGET_RATE, ...processorOptions },
  });

  const flush = () => processor.port.onmessage?.({ data: { command: "flush" } });

  return { processor, chunks, flush };
}

/**
 * Гоняем сигнал кадрами по 128 сэмплов — как это делает браузер.
 * autoFlush имитирует cleanup() в хуке, который досылает хвост < 512 сэмплов.
 */
function feed(harness: Harness, signal: Float32Array, quantum = 128, autoFlush = true) {
  for (let i = 0; i < signal.length; i += quantum) {
    harness.processor.process([[signal.subarray(i, Math.min(i + quantum, signal.length))]]);
  }
  if (autoFlush) harness.flush();
}

function sine(freq: number, seconds: number, sampleRate: number): Float32Array {
  const length = Math.round(seconds * sampleRate);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate);
  }
  return out;
}

function totalSamples(chunks: Int16Array[]): number {
  return chunks.reduce((sum, chunk) => sum + chunk.length, 0);
}

function join(chunks: Int16Array[]): Int16Array {
  const out = new Int16Array(totalSamples(chunks));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Частота по переходам через ноль — устойчива к усилению и фильтрации. */
function measureFrequency(samples: Int16Array, sampleRate: number): number {
  let firstCrossing = -1;
  let lastCrossing = -1;
  let crossings = 0;

  for (let i = 1; i < samples.length; i++) {
    if (samples[i - 1] <= 0 && samples[i] > 0) {
      if (firstCrossing === -1) firstCrossing = i;
      lastCrossing = i;
      crossings++;
    }
  }

  if (crossings < 2 || lastCrossing <= firstCrossing) return 0;
  return ((crossings - 1) * sampleRate) / (lastCrossing - firstCrossing);
}

describe("pcm-recorder-worklet: ресемплинг в 16 кГц", () => {
  it.each([44100, 48000, 96000])("на контексте %i Гц даёт ровно 16 000 сэмплов в секунду", (sourceRate) => {
    const harness = createHarness(sourceRate);

    feed(harness, sine(440, 1, sourceRate));

    const produced = totalSamples(harness.chunks);
    expect(produced).toBeGreaterThan(TARGET_RATE - 3);
    expect(produced).toBeLessThan(TARGET_RATE + 3);
  });

  it.each([44100, 48000, 96000])("на контексте %i Гц сохраняет частоту тона", (sourceRate) => {
    const harness = createHarness(sourceRate);

    feed(harness, sine(440, 1, sourceRate));

    const freq = measureFrequency(join(harness.chunks), TARGET_RATE);
    expect(freq).toBeGreaterThan(430);
    expect(freq).toBeLessThan(450);
  });

  it("не накапливает дрейф фазы на длинном потоке (10 секунд)", () => {
    const harness = createHarness(48000);

    feed(harness, sine(300, 10, 48000));

    const produced = totalSamples(harness.chunks);
    expect(produced).toBeGreaterThan(160_000 - 10);
    expect(produced).toBeLessThan(160_000 + 10);
  });

  it("режет ровно по 512 сэмплов (32 мс), коротким может быть только хвост", () => {
    const harness = createHarness(48000);

    feed(harness, sine(440, 1, 48000));

    const sizes = harness.chunks.map((chunk) => chunk.length);
    expect(sizes.length).toBeGreaterThan(30); // ~31 чанк в секунду
    expect(sizes.slice(0, -1).every((size) => size === FRAME_SAMPLES)).toBe(true);
    expect(sizes[sizes.length - 1]).toBeLessThanOrEqual(FRAME_SAMPLES);
  });

  it("отдаёт остаток по команде flush и восстанавливается после неё", () => {
    const harness = createHarness(48000);

    // 300 входных сэмплов = 100 выходных: до 512 не дотягивает, значит чанков нет
    feed(harness, sine(440, 300 / 48000, 48000), 128, false);
    expect(harness.chunks).toHaveLength(0);

    harness.flush();
    expect(harness.chunks).toHaveLength(1);
    expect(harness.chunks[0].length).toBe(100);

    // После flush счётчик обнулён: следующий чанк снова набирается с нуля
    harness.flush();
    expect(harness.chunks).toHaveLength(1);
  });

  it("первый сэмпл — сигнал, а не нулевая подстановка (нет щелчка на старте)", () => {
    const harness = createHarness(48000);
    const dc = new Float32Array(600).fill(0.5);

    feed(harness, dc);
    harness.flush();

    const samples = join(harness.chunks);
    expect(samples.length).toBeGreaterThan(0);
    expect(Math.abs(samples[0] - Math.round(0.5 * 0x7fff))).toBeLessThan(200);
  });

  it("не выходит за пределы Int16 на полной громкости", () => {
    const harness = createHarness(48000);
    const square = new Float32Array(2048);
    for (let i = 0; i < square.length; i++) square[i] = i % 64 < 32 ? 1 : -1;

    feed(harness, square);
    harness.flush();

    const samples = join(harness.chunks);
    expect(samples.length).toBeGreaterThan(0);
    let min = 0;
    let max = 0;
    for (const sample of samples) {
      if (sample < min) min = sample;
      if (sample > max) max = sample;
    }
    expect(min).toBeGreaterThanOrEqual(-32768);
    expect(max).toBeLessThanOrEqual(32767);
    expect(min).toBeLessThan(-32000);
    expect(max).toBeGreaterThan(32000);
  });

  it("антиалиасинг гасит то, что при децимации сложилось бы в речевой диапазон", () => {
    // 15.9 кГц при децимации 48 -> 16 кГц «складывается» в слышимые 100 Гц.
    const tone = sine(15900, 1, 48000).map((value) => value * 0.8);
    const rms = (samples: Int16Array) => {
      let sum = 0;
      for (const sample of samples) sum += (sample / 32768) ** 2;
      return Math.sqrt(sum / samples.length);
    };

    const filtered = createHarness(48000);
    feed(filtered, tone);
    const filteredRms = rms(join(filtered.chunks));

    const raw = createHarness(48000, { antiAlias: false });
    feed(raw, tone);
    const rawRms = rms(join(raw.chunks));

    expect(rawRms).toBeGreaterThan(0.3); // без фильтра алиас почти в полную амплитуду
    expect(filteredRms).toBeLessThan(0.05); // с фильтром — подавлен
    expect(filteredRms).toBeLessThan(rawRms / 10);
  });

  it("антиалиасинг можно отключить, частота при этом та же", () => {
    const harness = createHarness(48000, { antiAlias: false });

    feed(harness, sine(440, 1, 48000));

    expect(totalSamples(harness.chunks)).toBeGreaterThan(TARGET_RATE - 3);
    expect(totalSamples(harness.chunks)).toBeLessThan(TARGET_RATE + 3);
    expect(measureFrequency(join(harness.chunks), TARGET_RATE)).toBeGreaterThan(430);
  });

  it("на своём 16 кГц контексте работает как сквозной канал (ratio = 1)", () => {
    const harness = createHarness(16000);

    feed(harness, sine(440, 1, 16000));

    expect(totalSamples(harness.chunks)).toBe(TARGET_RATE);
    expect(measureFrequency(join(harness.chunks), TARGET_RATE)).toBeGreaterThan(430);
  });

  it("переживает пустой и тишину без ошибок и не рвёт поток", () => {
    const harness = createHarness(48000);

    expect(harness.processor.process([[]])).toBe(true);
    expect(harness.processor.process([[]])).toBe(true);

    feed(harness, new Float32Array(2048)); // тишина

    expect(totalSamples(harness.chunks)).toBeGreaterThan(0);
    expect(join(harness.chunks).every((sample) => sample === 0)).toBe(true);
  });

  it("понимает и строковую команду flush", () => {
    const harness = createHarness(48000);

    feed(harness, sine(440, 300 / 48000, 48000), 128, false);
    harness.processor.port.onmessage?.({ data: "flush" });

    expect(harness.chunks).toHaveLength(1);
  });
});
