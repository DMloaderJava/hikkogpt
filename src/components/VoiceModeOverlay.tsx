import { useEffect } from "react";
import { AlertTriangle, AudioLines, Loader2, Mic, MicOff, PhoneOff, RotateCcw } from "lucide-react";
import { VoiceVisualizer } from "@/components/VoiceVisualizer";
import { SOUND_LABELS } from "@/lib/soundboard";
import { isLegacyLiveModel, shortLiveModelName } from "@/types/gemini-live";
import type {
  ConnectionStatus,
  PrebuiltVoiceName,
  SoundEffectType,
  VoiceAgentState,
} from "@/types/gemini-live";

export interface VoiceModeOverlayProps {
  status: ConnectionStatus;
  agentState: VoiceAgentState;
  analyser: AnalyserNode | null;
  inputAnalyser?: AnalyserNode | null;
  isMuted: boolean;
  errorMessage: string | null;
  /** Последний эффект, который попросила модель — короткая вспышка в UI. */
  lastSound?: SoundEffectType | null;
  voiceName: PrebuiltVoiceName;
  /** Модель, на которой реально поднялась сессия (из `proxyInfo`). */
  liveModel?: string | null;
  onToggleMute: () => void;
  onReconnect: () => void;
  onClose: () => void;
}

function statusText(status: ConnectionStatus, agentState: VoiceAgentState): string {
  if (status === "connecting") return "Подключаюсь к Gemini Live…";
  if (status === "error") return "Сессия не поднялась";
  if (status === "disconnected") return "Сессия закрыта";
  switch (agentState) {
    case "listening":
      return "Слушаю…";
    case "thinking":
      return "Думаю…";
    case "speaking":
      return "Говорю…";
    default:
      return "Готов";
  }
}

export function VoiceModeOverlay({
  status,
  agentState,
  analyser,
  inputAnalyser = null,
  isMuted,
  errorMessage,
  lastSound = null,
  voiceName,
  liveModel = null,
  onToggleMute,
  onReconnect,
  onClose,
}: VoiceModeOverlayProps) {
  const isBusy = status === "connecting";
  const hasError = status === "error";

  // Esc — привычный способ выйти из «звонка».
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-background/85 backdrop-blur-md animate-fade-in">
      <div className="flex w-full max-w-sm flex-col items-center gap-5 px-6">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
          <AudioLines className="h-4 w-4" />
          <span>Голосовой режим</span>
          <span className="rounded-md bg-secondary px-1.5 py-0.5 text-[10px] normal-case tracking-normal">
            {voiceName}
          </span>
          {liveModel && (
            <span
              className={`rounded-md px-1.5 py-0.5 text-[10px] normal-case tracking-normal ${
                isLegacyLiveModel(liveModel)
                  ? "bg-destructive/15 text-destructive"
                  : "bg-secondary/60 text-muted-foreground"
              }`}
              title={
                isLegacyLiveModel(liveModel)
                  ? `${liveModel} — модель снята с эксплуатации, обновите GEMINI_LIVE_MODEL`
                  : liveModel
              }
            >
              {shortLiveModelName(liveModel)}
            </span>
          )}
        </div>

        <VoiceVisualizer
          analyser={analyser}
          inputAnalyser={isMuted ? null : inputAnalyser}
          state={isBusy ? "thinking" : agentState}
          size={232}
        />

        <div className="flex min-h-[3.5rem] flex-col items-center gap-1 text-center">
          <p className="text-base font-medium text-foreground">
            {statusText(status, agentState)}
          </p>
          {lastSound && !hasError && (
            <p className="text-xs text-interactive animate-pop" key={lastSound}>
              {SOUND_LABELS[lastSound]}
            </p>
          )}
          {!lastSound && !hasError && (
            <p className="text-xs text-muted-foreground">
              Говорите обычным голосом — можно перебивать в любой момент.
            </p>
          )}
        </div>

        {hasError && (
          <div className="w-full rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-left">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-destructive" />
              <p className="text-xs text-foreground">
                {errorMessage || "Не удалось поднять голосовую сессию."}
              </p>
            </div>
          </div>
        )}

        <div className="flex items-center gap-3">
          <button
            onClick={onToggleMute}
            disabled={hasError || isBusy}
            className={`flex h-12 w-12 items-center justify-center rounded-full border border-border transition-all active:scale-95 disabled:opacity-40 ${
              isMuted ? "bg-destructive/15 text-destructive" : "bg-card text-foreground btn-interactive"
            }`}
            title={isMuted ? "Снять микрофон с mute" : "Заглушить микрофон"}
            aria-pressed={isMuted}
          >
            {isMuted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
          </button>

          {hasError ? (
            <button
              onClick={onReconnect}
              className="flex h-12 items-center gap-2 rounded-full bg-interactive px-5 text-sm font-medium text-interactive-foreground transition-all active:scale-95"
            >
              <RotateCcw className="h-4 w-4" />
              Повторить
            </button>
          ) : (
            <button
              onClick={onClose}
              className="flex h-12 items-center gap-2 rounded-full bg-destructive px-5 text-sm font-medium text-destructive-foreground transition-all active:scale-95"
            >
              {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <PhoneOff className="h-4 w-4" />}
              Завершить
            </button>
          )}
        </div>

        <p className="text-[11px] text-muted-foreground">
          Esc — выйти. Ключ Gemini живёт на сервере, в браузер не попадает.
        </p>
      </div>
    </div>
  );
}

export default VoiceModeOverlay;
