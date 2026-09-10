// Захватывает моно-микрофон и отдаёт Int16 PCM на 16 000 Гц — это формат входа
// Gemini Live (`audio/pcm;rate=16000`).
//
// Частота AudioContext браузера не важна (44.1 / 48 / 96 кГц): поток
// ресемплируется здесь, фазовым аккумулятором с линейной интерполяцией. Поэтому
// мы не зависим от `new AudioContext({ sampleRate: 16000 })`, который на
// Safari/iOS и части Android-устройств либо бросает NotSupportedError, либо
// молча открывается на 44.1/48 кГц.
//
// Формат сообщений на главный поток: ArrayBuffer (transferable) с Int16 PCM.
// Чанки ровно `frameSamples` сэмплов (по умолчанию 512 = 32 мс).
// Остаток (последние < 32 мс записи) отдаётся по команде { command: "flush" }.

class PcmRecorderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    const opts = (options && options.processorOptions) || {};
    this.targetSampleRate = opts.targetSampleRate || 16000;
    this.frameSize = opts.frameSamples || 512;
    // Антиалиасинг: при децимации 48 -> 16 кГц каждый третий сэмпл брать нельзя —
    // всё, что выше 8 кГц, «сложится» обратно в речевой диапазон. Скользящее
    // среднее по окну ≈ коэффициенту децимации работает как простой ФНЧ.
    this.antiAlias = opts.antiAlias !== false;

    const nativeRate =
      typeof sampleRate === "number" && sampleRate > 0 ? sampleRate : 48000;
    this.resampleRatio = nativeRate / this.targetSampleRate;
    this.window = this.antiAlias ? Math.max(1, Math.round(this.resampleRatio)) : 1;

    // История для скользящего среднего (одно и то же значение пишется один раз).
    this.history = new Float32Array(this.window);
    this.historyIndex = 0;
    this.historySum = 0;
    this.historyFilled = 0;

    this.outputBuffer = new Int16Array(this.frameSize);
    this.outputIndex = 0;

    // Позиция внутри интервала между двумя соседними входными сэмплами, 0..1.
    this.resamplePhase = 0;
    this.lastSample = 0;
    this.primed = false;

    this.port.onmessage = (event) => {
      const data = event.data;
      if (data === "flush" || (data && data.command === "flush")) {
        this.flush();
      }
    };
  }

  /** Отдаёт накопленный остаток (может быть короче frameSize) и обнуляет буфер. */
  flush() {
    if (this.outputIndex === 0) return;
    const chunk = this.outputBuffer.slice(0, this.outputIndex);
    this.outputIndex = 0;
    this.port.postMessage(chunk.buffer, [chunk.buffer]);
  }

  /** Клампит в [-1..1], округляет и кладёт в чанк; на переполнении — flush. */
  push(value) {
    const clamped = value < -1 ? -1 : value > 1 ? 1 : value;
    this.outputBuffer[this.outputIndex++] = Math.round(
      clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
    );

    if (this.outputIndex === this.frameSize) {
      this.flush();
    }
  }

  /** Скользящее среднее по последним `window` входным сэмплам. */
  average(sample) {
    this.historySum += sample - this.history[this.historyIndex];
    this.history[this.historyIndex] = sample;
    this.historyIndex = (this.historyIndex + 1) % this.window;
    if (this.historyFilled < this.window) this.historyFilled++;
    return this.historySum / this.historyFilled;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel || channel.length === 0) return true;

    for (let i = 0; i < channel.length; i++) {
      const averaged = this.average(channel[i]);

      // Первый сэмпл: интерполировать ещё не от чего.
      if (!this.primed) {
        this.primed = true;
        this.lastSample = averaged;
      }

      // Фаза растёт на коэффициент децимации: в среднем получается ровно
      // targetSampleRate выходных сэмплов на секунду.
      while (this.resamplePhase < 1) {
        const interpolated =
          this.lastSample + (averaged - this.lastSample) * this.resamplePhase;
        this.push(interpolated);
        this.resamplePhase += this.resampleRatio;
      }

      this.resamplePhase -= 1;
      this.lastSample = averaged;
    }

    return true;
  }
}

registerProcessor("pcm-recorder", PcmRecorderProcessor);
