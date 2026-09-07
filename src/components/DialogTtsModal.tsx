import { useState, useRef, useEffect, useMemo } from "react";
import { X, Loader2, Volume2, Plus, Minus } from "lucide-react";
import { getEdgeAuthHeaders } from "@/lib/edgeAuth";
import { AudioPlayer } from "@/components/AudioPlayer";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;

const VOICES = ["Charon", "Kore", "Puck", "Aoede", "Fenrir", "Leda", "Zephyr", "Orus"];
const MAX_SPEAKERS = 8;

const EXAMPLE = `Speaker 1: Ребята, начинаем?
Speaker 2: Я сказала тебе прекратить!
Speaker 3: Ладно, ладно, понял.
Speaker 4: Вы оба довольно забавные.`;

interface DialogTtsModalProps {
  open: boolean;
  onClose: () => void;
}

export function DialogTtsModal({ open, onClose }: DialogTtsModalProps) {
  const [transcript, setTranscript] = useState("");
  const [speakerCount, setSpeakerCount] = useState(2);
  const [voices, setVoices] = useState<Record<string, string>>({
    "1": "Charon",
    "2": "Kore",
    "3": "Puck",
    "4": "Aoede",
    "5": "Fenrir",
    "6": "Leda",
    "7": "Zephyr",
    "8": "Orus",
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, []);

  // Auto-detect how many speakers the text actually uses
  const detected = useMemo(() => {
    const found = new Set<number>();
    for (const m of transcript.matchAll(/^\s*Speaker\s*(\d{1,2})\s*:/gim)) {
      const n = parseInt(m[1], 10);
      if (n >= 1 && n <= MAX_SPEAKERS) found.add(n);
    }
    return [...found].sort((a, b) => a - b);
  }, [transcript]);

  useEffect(() => {
    if (detected.length) setSpeakerCount(Math.max(2, Math.max(...detected)));
  }, [detected]);

  if (!open) return null;

  const slots = Array.from({ length: speakerCount }, (_, i) => String(i + 1));

  const generate = async () => {
    const text = transcript.trim();
    if (!text) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/dialog-tts`, {
        method: "POST",
        headers: { ...(await getEdgeAuthHeaders()), "Content-Type": "application/json" },
        body: JSON.stringify({ transcript: text, voices }),
      });
      if (!res.ok) {
        let msg = "Не удалось озвучить диалог.";
        try {
          const data = await res.json();
          if (data?.error) msg = data.error;
        } catch { /* ignore */ }
        throw new Error(msg);
      }
      const blob = await res.blob();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      setAudioUrl(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка озвучки");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-background/70 backdrop-blur-sm animate-fade-in p-0 sm:p-4">
      <div className="w-full sm:max-w-lg max-h-[90vh] overflow-y-auto scrollbar-thin rounded-t-2xl sm:rounded-2xl border border-border bg-background p-4 shadow-xl animate-slide-up">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
            <Volume2 className="h-4 w-4 text-interactive" />
            Озвучка диалога
          </h2>
          <button onClick={onClose} className="btn-interactive rounded-lg p-1.5 text-muted-foreground transition-all">
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="mb-2 text-xs text-muted-foreground">
          Каждая реплика с новой строки: <span className="text-foreground">Speaker 1:</span>,{" "}
          <span className="text-foreground">Speaker 2:</span>, <span className="text-foreground">Speaker 3:</span> … до {MAX_SPEAKERS} голосов
        </p>

        <textarea
          value={transcript}
          onChange={(e) => setTranscript(e.target.value)}
          placeholder={EXAMPLE}
          rows={8}
          className="w-full resize-none rounded-xl border border-border bg-secondary/50 p-3 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-interactive/40 focus:outline-none transition-all"
        />

        <div className="mt-1.5 flex items-center justify-between gap-2">
          <button
            onClick={() => setTranscript(EXAMPLE)}
            className="text-xs text-interactive btn-interactive rounded-md px-1.5 py-0.5 transition-all"
          >
            Вставить пример
          </button>

          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Голосов: {speakerCount}</span>
            <button
              onClick={() => setSpeakerCount((n) => Math.max(2, n - 1))}
              disabled={speakerCount <= 2}
              className="btn-interactive rounded-lg p-1.5 text-muted-foreground transition-all disabled:opacity-40"
              title="Убрать голос"
            >
              <Minus className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => setSpeakerCount((n) => Math.min(MAX_SPEAKERS, n + 1))}
              disabled={speakerCount >= MAX_SPEAKERS}
              className="btn-interactive rounded-lg p-1.5 text-muted-foreground transition-all disabled:opacity-40"
              title="Добавить голос"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          {slots.map((s) => (
            <label key={s} className="text-xs text-muted-foreground animate-fade-in">
              Голос Speaker {s}
              <select
                value={voices[s] ?? VOICES[0]}
                onChange={(e) => setVoices((prev) => ({ ...prev, [s]: e.target.value }))}
                className="mt-1 w-full rounded-lg border border-border bg-secondary/50 px-2 py-2 text-sm text-foreground focus:border-interactive/40 focus:outline-none transition-all"
              >
                {VOICES.map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
            </label>
          ))}
        </div>

        {speakerCount > 2 && (
          <p className="mt-2 text-[11px] text-muted-foreground">
            С 3 и более голосами реплики озвучиваются по очереди и склеиваются — это занимает немного больше времени.
          </p>
        )}

        {error && (
          <div className="mt-3 rounded-xl bg-destructive/10 px-3 py-2 text-xs text-destructive animate-slide-up">{error}</div>
        )}

        <button
          onClick={generate}
          disabled={loading || !transcript.trim()}
          className={`mt-3 flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-medium transition-all active:scale-95 ${
            loading || !transcript.trim()
              ? "bg-muted text-muted-foreground cursor-not-allowed"
              : "bg-interactive text-interactive-foreground hover:opacity-90"
          }`}
        >
          {loading ? <><Loader2 className="h-4 w-4 animate-spin" /> Озвучиваю...</> : <><Volume2 className="h-4 w-4" /> Озвучить</>}
        </button>

        {audioUrl && (
          <div className="mt-3">
            <AudioPlayer src={audioUrl} fileName="dialog.wav" />
          </div>
        )}
      </div>
    </div>
  );
}
