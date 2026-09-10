import { useCallback, useEffect, useRef, useState } from "react";
import { AudioPlaybackEngine, createBrowserAudioContext } from "@/lib/audioEngine";
import { isSoundEffect, type SoundboardPlayer } from "@/lib/soundboard";
import { supabase } from "@/integrations/supabase/client";
import {
  DEFAULT_LIVE_MODEL,
  PLAY_SOUND_TOOL,
  VOICE_SYSTEM_INSTRUCTION,
  type ConnectionStatus,
  type LiveRealtimeInputMessage,
  type LiveServerMessage,
  type LiveSetupMessage,
  type LiveToolResponse,
  type PrebuiltVoiceName,
  type SoundEffectType,
  type VoiceAgentState,
} from "@/types/gemini-live";

const MIC_WORKLET_PATH = "/pcm-recorder-worklet.js";
/** 512 сэмплов @16 кГц = 32 мс — в рекомендованном Gemini диапазоне 20–40 мс. */
const MIC_FRAME_SAMPLES = 512;
/** Если прокси не прислал proxyInfo (старая версия функции) — поднимаем сессию сами. */
const SETUP_FALLBACK_MS = 2000;
/** Пре-ролл: речь за время до setupComplete (~0.8 с) не теряется. */
const MAX_PRE_ROLL_CHUNKS = 25;
const INPUT_MIME_TYPE = "audio/pcm;rate=16000" as const;

export interface UseGeminiLiveOptions {
  voiceName?: PrebuiltVoiceName;
  systemInstruction?: string;
  /** Запасная модель, если прокси не прислал `proxyInfo`. */
  model?: string;
  onSoundTriggered?: (soundName: SoundEffectType) => void;
  onError?: (error: string) => void;
  onConnectionChange?: (status: ConnectionStatus) => void;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function audioChunkMessage(base64Data: string): LiveRealtimeInputMessage {
  return {
    realtimeInput: {
      mediaChunks: [{ mimeType: INPUT_MIME_TYPE, data: base64Data }],
    },
  };
}

function toErrorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/**
 * useGeminiLive — дирижёр голосового режима.
 *
 * Микрофон (AudioWorklet -> 16 кГц PCM) -> WebSocket-прокси -> Gemini Live.
 * Обратно: PCM 24 кГц в AudioPlaybackEngine + вызовы `play_sound` в саундборд.
 * Сигнал `interrupted` глушит и речь, и эффекты (barge-in).
 *
 * Порядок запуска важен:
 *   click -> engine.resume() + getUserMedia() (жест пользователя ещё «свежий»)
 *         -> сокет -> proxyInfo -> setup -> setupComplete -> отправка аудио.
 */
export function useGeminiLive(options: UseGeminiLiveOptions = {}) {
  const {
    voiceName = "Puck",
    systemInstruction = VOICE_SYSTEM_INSTRUCTION,
    model = DEFAULT_LIVE_MODEL,
    onSoundTriggered,
    onError,
    onConnectionChange,
  } = options;

  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [agentState, setAgentState] = useState<VoiceAgentState>("idle");
  const [isMuted, setIsMuted] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const engineRef = useRef<AudioPlaybackEngine | null>(null);
  const soundboardRef = useRef<SoundboardPlayer | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micCtxRef = useRef<AudioContext | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const fallbackTimerRef = useRef<number | null>(null);

  // Флаги, которые читает живой обработчик порта: рефы, а не состояние —
  // иначе замыкание connect() зафиксирует устаревшее значение.
  const mutedRef = useRef(false);
  const setupSentRef = useRef(false);
  const readyRef = useRef(false);
  const preRollRef = useRef<string[]>([]);

  // Колбэки в рефе: connect() не должен пересобираться при их смене.
  const callbacksRef = useRef({ onSoundTriggered, onError, onConnectionChange });
  callbacksRef.current = { onSoundTriggered, onError, onConnectionChange };

  /** Полный демонтаж сессии. Идемпотентен. */
  const cleanup = useCallback(async (preserveStatus = false) => {
    if (fallbackTimerRef.current !== null) {
      window.clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }

    // 1. Микрофонный конвейер
    const worklet = workletRef.current;
    workletRef.current = null;
    if (worklet) {
      try {
        // Последние <32 мс записи (успеет — хорошо, не успеет — не страшно).
        worklet.port.postMessage({ command: "flush" });
        worklet.port.onmessage = null;
        worklet.disconnect();
      } catch {
        /* узел уже отключён */
      }
    }

    micStreamRef.current?.getTracks().forEach((track) => track.stop());
    micStreamRef.current = null;

    const micCtx = micCtxRef.current;
    micCtxRef.current = null;
    if (micCtx && micCtx.state !== "closed") {
      try {
        await micCtx.close();
      } catch {
        /* контекст уже закрыт */
      }
    }

    // 2. Сокет: сначала снимаем обработчики, чтобы onclose не вызвал cleanup рекурсивно
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, "client cleanup");
      }
    }

    // 3. Звук
    soundboardRef.current?.dispose();
    soundboardRef.current = null;

    const engine = engineRef.current;
    engineRef.current = null;
    setAnalyser(null);
    if (engine) await engine.close();

    setupSentRef.current = false;
    readyRef.current = false;
    preRollRef.current = [];

    if (!preserveStatus) {
      setStatus("disconnected");
      setAgentState("idle");
    }
  }, []);

  const connect = useCallback(async () => {
    const callbacks = callbacksRef.current;

    await cleanup(true); // сбрасываем возможную прошлую сессию
    setErrorMessage(null);
    setStatus("connecting");
    setAgentState("idle");
    setIsMuted(false);
    mutedRef.current = false;

    try {
      // 1. Честный JWT пользователя: прокси валидирует его через
      // supabase.auth.getUser(token), anon-ключ тут не подойдёт (401).
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token;
      if (sessionError || !accessToken) {
        throw new Error("Для голосового режима нужно войти в аккаунт.");
      }

      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
      if (!supabaseUrl) throw new Error("Не задан VITE_SUPABASE_URL.");

      // 2. Вывод: движок + саундборд на одной шине
      const engine = new AudioPlaybackEngine();
      await engine.resume();
      const soundboard = engine.createSoundboard();
      engineRef.current = engine;
      soundboardRef.current = soundboard;
      setAnalyser(engine.analyser);
      // Предзагрузка идёт параллельно с поднятием сокета: к первой шутке
      // все 4 эффекта уже в памяти.
      void soundboard.preload();

      // 3. Микрофон
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Браузер не даёт доступ к микрофону.");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      micStreamRef.current = stream;

      const micCtx = createBrowserAudioContext({ latencyHint: "interactive" });
      micCtxRef.current = micCtx;
      await micCtx.audioWorklet.addModule(MIC_WORKLET_PATH);
      // Пока контекст suspended, process() не вызывается и аудио не идёт.
      if (micCtx.state === "suspended") await micCtx.resume();

      const micSource = micCtx.createMediaStreamSource(stream);
      const workletNode = new AudioWorkletNode(micCtx, "pcm-recorder", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        processorOptions: { frameSamples: MIC_FRAME_SAMPLES, targetSampleRate: 16000 },
      });
      workletRef.current = workletNode;
      micSource.connect(workletNode);

      // Узел обязан быть в графе: не связанные с destination узлы Web Audio не
      // рендерятся, и process() не вызывается. Гоним через нулевой гейн, чтобы
      // не слышать себя в колонках.
      const silentGain = micCtx.createGain();
      silentGain.gain.value = 0;
      workletNode.connect(silentGain);
      silentGain.connect(micCtx.destination);

      // 4. Сокет
      const wsUrl = `${supabaseUrl.replace(/^http/, "ws")}/functions/v1/gemini-live?token=${encodeURIComponent(accessToken)}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      const clearFallbackTimer = () => {
        if (fallbackTimerRef.current !== null) {
          window.clearTimeout(fallbackTimerRef.current);
          fallbackTimerRef.current = null;
        }
      };

      const sendSetup = (modelName: string) => {
        if (setupSentRef.current || ws.readyState !== WebSocket.OPEN) return;
        setupSentRef.current = true;
        const payload: LiveSetupMessage = {
          setup: {
            model: modelName,
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: {
                voiceConfig: { prebuiltVoiceConfig: { voiceName } },
              },
            },
            systemInstruction: { parts: [{ text: systemInstruction }] },
            tools: [{ functionDeclarations: [PLAY_SOUND_TOOL] }],
          },
        };
        ws.send(JSON.stringify(payload));
      };

      const sendAudio = (base64Data: string) => {
        if (ws.readyState !== WebSocket.OPEN || mutedRef.current) return;

        // До setupComplete Gemini принимает только setup, поэтому первые чанки
        // копим и досылаем сразу после подтверждения — так порядок сообщений
        // корректен и начало фразы не теряется.
        if (!readyRef.current) {
          if (preRollRef.current.length < MAX_PRE_ROLL_CHUNKS) {
            preRollRef.current.push(base64Data);
          }
          return;
        }

        ws.send(JSON.stringify(audioChunkMessage(base64Data)));
      };

      workletNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        sendAudio(arrayBufferToBase64(event.data));
      };

      ws.onopen = () => {
        // Ждём proxyInfo от прокси; если он не придёт — через 2 с поднимаем
        // сессию на модели по умолчанию, чтобы режим не висел молча.
        clearFallbackTimer();
        fallbackTimerRef.current = window.setTimeout(() => {
          fallbackTimerRef.current = null;
          sendSetup(model);
        }, SETUP_FALLBACK_MS);
      };

      ws.onmessage = (event: MessageEvent<string>) => {
        let message: LiveServerMessage;
        try {
          message = JSON.parse(typeof event.data === "string" ? event.data : "");
        } catch (err) {
          console.warn("[GeminiLive] Не разобрали сообщение от прокси:", err);
          return;
        }

        // А) Прокси сообщил фактически открытую модель -> шлём setup
        if (message.proxyInfo) {
          clearFallbackTimer();
          sendSetup(message.proxyInfo.model);
          return;
        }

        // Б) Google подтвердил конфигурацию -> можно лить аудио
        if (message.setupComplete) {
          readyRef.current = true;
          const preRoll = preRollRef.current;
          preRollRef.current = [];
          for (const data of preRoll) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify(audioChunkMessage(data)));
            }
          }
          setStatus("connected");
          setAgentState("listening");
          callbacks.onConnectionChange?.("connected");
          return;
        }

        // В) Прокси не смог поднять апстрим (ключи/модели кончились)
        if (message.proxyError) {
          const text = message.proxyError;
          setErrorMessage(text);
          setStatus("error");
          setAgentState("idle");
          callbacks.onError?.(text);
          return;
        }

        // Г) Контент модели: речь, перебивание, конец реплики
        if (message.serverContent) {
          const { interrupted, modelTurn, turnComplete } = message.serverContent;

          if (interrupted) {
            // Barge-in: обрываем и речь, и звучащий эффект
            engine.stopAndClearQueue();
            soundboard.stopAll();
            preRollRef.current = [];
            setAgentState("listening");
          }

          if (modelTurn?.parts?.length) {
            let hasAudio = false;
            for (const part of modelTurn.parts) {
              if (part.inlineData?.data) {
                engine.enqueuePcmChunk(part.inlineData.data);
                hasAudio = true;
              }
            }
            if (hasAudio) setAgentState("speaking");
          }

          if (turnComplete) setAgentState("listening");
        }

        // Д) Вызов инструмента: саундборд
        if (message.toolCall?.functionCalls?.length) {
          const responses: LiveToolResponse["toolResponse"]["functionResponses"] = [];

          for (const call of message.toolCall.functionCalls) {
            const soundName = call.args?.sound_name;

            if (call.name === "play_sound" && isSoundEffect(soundName)) {
              soundboard.play(soundName);
              callbacks.onSoundTriggered?.(soundName);
              responses.push({
                id: call.id,
                name: call.name,
                response: { output: { success: true, sound_name: soundName } },
              });
            } else {
              // Отвечать нужно на каждый functionCall, иначе ход модели зависнет.
              responses.push({
                id: call.id,
                name: call.name,
                response: { output: { success: false, error: "unsupported_call" } },
              });
            }
          }

          if (responses.length > 0 && ws.readyState === WebSocket.OPEN) {
            const payload: LiveToolResponse = { toolResponse: { functionResponses: responses } };
            ws.send(JSON.stringify(payload));
          }
        }
      };

      ws.onerror = () => {
        const text = "Ошибка соединения с голосовым сервисом.";
        setErrorMessage(text);
        setStatus("error");
        callbacks.onError?.(text);
      };

      ws.onclose = (event) => {
        if (event.code !== 1000) {
          const text = `Голосовая сессия закрыта (код ${event.code}).`;
          setErrorMessage(text);
          callbacks.onError?.(text);
          void cleanup(true).then(() => setStatus("error"));
        } else {
          void cleanup();
        }
      };
    } catch (err) {
      const text = toErrorMessage(err, "Не удалось запустить голосовой режим.");
      await cleanup(true);
      setErrorMessage(text);
      setStatus("error");
      callbacks.onError?.(text);
    }
  }, [cleanup, model, systemInstruction, voiceName]);

  const toggleMute = useCallback(() => {
    setIsMuted((prev) => {
      mutedRef.current = !prev;
      return !prev;
    });
  }, []);

  const disconnect = useCallback(() => {
    void cleanup();
  }, [cleanup]);

  // Демонтаж при размонтировании
  useEffect(() => {
    return () => {
      void cleanup();
    };
  }, [cleanup]);

  return {
    status,
    agentState,
    isMuted,
    errorMessage,
    /** Для VoiceVisualizer: analyser общей шины (речь + эффекты). */
    analyser,
    connect,
    disconnect,
    toggleMute,
  };
}
