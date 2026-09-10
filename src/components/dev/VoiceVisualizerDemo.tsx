import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, MicOff, Power, Waves } from "lucide-react";
import { VoiceVisualizer } from "@/components/VoiceVisualizer";
import type { VoiceAgentState } from "@/types/gemini-live";

/**
 * Дев-стенд для сферы: открывается по хэшу #voice-preview (см. App.tsx).
 *
 * Голосовой режим целиком требует задеплоенного прокси и входа в аккаунт,
 * поэтому сферу удобнее смотреть отдельно. Здесь она подключена к настоящим
 * Web Audio-узлам: тестовый генератор или микрофон. В production-сборку этот
 * файл не попадает (ветка под import.meta.env.DEV вырезается).
 */
const STATES: VoiceAgentState[] = ["idle", "listening", "thinking", "speaking"];

export function VoiceVisualizerDemo() {
  const [state, setState] = useState<VoiceAgentState>("speaking");
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const [inputAnalyser, setInputAnalyser] = useState<AnalyserNode | null>(null);
  const [source, setSource] = useState<"none" | "tone" | "mic">("none");
  const [error, setError] = useState<string | null>(null);

  const ctxRef = useRef<AudioContext | null>(null);
  const nodesRef = useRef<{ osc?: OscillatorNode; lfo?: OscillatorNode; mic?: MediaStreamAudioSourceNode }>({});
  const streamRef = useRef<MediaStream | null>(null);

  const getContext = useCallback(async () => {
    if (!ctxRef.current || ctxRef.current.state === "closed") {
      ctxRef.current = new AudioContext({ latencyHint: "interactive" });
    }
    if (ctxRef.current.state === "suspended") await ctxRef.current.resume();
    return ctxRef.current;
  }, []);

  const stopEverything = useCallback(() => {
    const nodes = nodesRef.current;
    try {
      nodes.osc?.stop();
      nodes.lfo?.stop();
      nodes.mic?.disconnect();
    } catch {
      /* уже остановлено */
    }
    nodesRef.current = {};
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setAnalyser(null);
    setInputAnalyser(null);
    setSource("none");
  }, []);

  useEffect(() => () => {
    stopEverything();
    void ctxRef.current?.close();
  }, [stopEverything]);

  /** Тот же путь, что в бою: источник -> analyser -> gain(0) -> destination. */
  const startTone = useCallback(async () => {
    try {
      setError(null);
      stopEverything();
      const ctx = await getContext();

      const analyserNode = ctx.createAnalyser();
      analyserNode.fftSize = 256;
      analyserNode.smoothingTimeConstant = 0.8;

      const osc = ctx.createOscillator();
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      const voiceGain = ctx.createGain();
      const silent = ctx.createGain();

      osc.type = "sawtooth";
      osc.frequency.value = 180;
      lfo.frequency.value = 2.4; // «фраза» дышит, как речь
      lfoGain.gain.value = 120;

      voiceGain.gain.value = 0.6;
      silent.gain.value = 0; // в колонки не идёт, но граф «живой»

      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);
      osc.connect(voiceGain);
      voiceGain.connect(analyserNode);
      analyserNode.connect(silent);
      silent.connect(ctx.destination);

      osc.start();
      lfo.start();

      nodesRef.current = { osc, lfo };
      setAnalyser(analyserNode);
      setSource("tone");
      setState("speaking");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось запустить генератор");
    }
  }, [getContext, stopEverything]);

  const startMic = useCallback(async () => {
    try {
      setError(null);
      stopEverything();
      const ctx = await getContext();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;

      const analyserNode = ctx.createAnalyser();
      analyserNode.fftSize = 256;
      analyserNode.smoothingTimeConstant = 0.8;

      const source2 = ctx.createMediaStreamSource(stream);
      const silent = ctx.createGain();
      silent.gain.value = 0;
      source2.connect(analyserNode);
      analyserNode.connect(silent);
      silent.connect(ctx.destination);

      nodesRef.current = { mic: source2 };
      setInputAnalyser(analyserNode);
      setSource("mic");
      setState("listening");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Микрофон недоступен");
    }
  }, [getContext, stopEverything]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background p-6">
      <div className="text-center">
        <h1 className="text-lg font-semibold text-foreground">Демо сферы голосового режима</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          Дев-стенд: настоящий AnalyserNode, без прокси Gemini. Состояние переключается вручную.
        </p>
      </div>

      <VoiceVisualizer analyser={analyser} inputAnalyser={inputAnalyser} state={state} size={260} />

      <div className="flex flex-wrap items-center justify-center gap-2">
        {STATES.map((value) => (
          <button
            key={value}
            onClick={() => setState(value)}
            className={`rounded-lg px-3 py-1.5 text-xs transition-all ${
              state === value
                ? "bg-interactive text-interactive-foreground"
                : "bg-secondary/60 text-muted-foreground btn-interactive"
            }`}
          >
            {value}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={() => void startTone()}
          className={`flex items-center gap-2 rounded-xl px-3 py-2 text-xs transition-all ${
            source === "tone" ? "bg-interactive/15 text-interactive" : "btn-interactive text-muted-foreground"
          }`}
        >
          <Waves className="h-4 w-4" />
          Тестовый сигнал
        </button>
        <button
          onClick={() => void startMic()}
          className={`flex items-center gap-2 rounded-xl px-3 py-2 text-xs transition-all ${
            source === "mic" ? "bg-interactive/15 text-interactive" : "btn-interactive text-muted-foreground"
          }`}
        >
          {source === "mic" ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
          Микрофон
        </button>
        <button
          onClick={stopEverything}
          className="flex items-center gap-2 rounded-xl px-3 py-2 text-xs btn-interactive text-muted-foreground transition-all"
        >
          <Power className="h-4 w-4" />
          Стоп
        </button>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}
      <p className="text-[11px] text-muted-foreground">
        Состояние: {state} · источник: {source}
      </p>
    </div>
  );
}

export default VoiceVisualizerDemo;
