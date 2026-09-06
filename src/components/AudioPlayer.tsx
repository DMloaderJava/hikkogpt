import { useEffect, useRef, useState } from "react";
import { Play, Pause, Download, RotateCcw, Volume2, VolumeX } from "lucide-react";

interface AudioPlayerProps {
  src: string;
  fileName?: string;
}

const fmt = (s: number) => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
};

export function AudioPlayer({ src, fileName = "dialog.wav" }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);

  useEffect(() => {
    setPlaying(false);
    setCurrent(0);
    setDuration(0);
  }, [src]);

  const onLoaded = () => {
    const a = audioRef.current;
    if (a && isFinite(a.duration)) setDuration(a.duration);
  };

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) { a.play().catch(() => {}); } else { a.pause(); }
  };

  const seek = (v: number) => {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = v;
    setCurrent(v);
  };

  const cycleRate = () => {
    const next = rate === 1 ? 1.25 : rate === 1.25 ? 1.5 : rate === 1.5 ? 0.75 : 1;
    setRate(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  };

  const progress = duration > 0 ? (current / duration) * 100 : 0;

  return (
    <div className="rounded-2xl border border-border bg-secondary/40 p-3 animate-fade-in-up">
      <audio
        ref={audioRef}
        src={src}
        autoPlay
        onLoadedMetadata={onLoaded}
        onDurationChange={onLoaded}
        onTimeUpdate={(e) => setCurrent((e.target as HTMLAudioElement).currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        className="hidden"
      />

      <div className="flex items-center gap-3">
        <button
          onClick={toggle}
          className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-interactive text-interactive-foreground shadow-sm shadow-interactive/25 transition-all hover:opacity-90 active:scale-90"
          title={playing ? "Пауза" : "Воспроизвести"}
        >
          {playing ? <Pause className="h-5 w-5" fill="currentColor" /> : <Play className="h-5 w-5 translate-x-[1px]" fill="currentColor" />}
        </button>

        <div className="min-w-0 flex-1">
          <div className="relative flex h-5 items-center">
            <div className="absolute left-0 right-0 h-1.5 rounded-full bg-border" />
            <div
              className="absolute left-0 h-1.5 rounded-full bg-interactive transition-[width] duration-100"
              style={{ width: `${progress}%` }}
            />
            <input
              type="range"
              min={0}
              max={duration || 0}
              step={0.01}
              value={current}
              onChange={(e) => seek(Number(e.target.value))}
              className="audio-range relative z-10 w-full appearance-none bg-transparent"
              aria-label="Позиция воспроизведения"
            />
          </div>

          <div className="mt-1 flex items-center justify-between text-[11px] tabular-nums text-muted-foreground">
            <span>{fmt(current)}</span>
            <span>{fmt(duration)}</span>
          </div>
        </div>
      </div>

      <div className="mt-2 flex items-center gap-1.5">
        <button onClick={() => seek(0)} className="btn-interactive rounded-lg p-2 text-muted-foreground transition-all" title="В начало">
          <RotateCcw className="h-4 w-4" />
        </button>
        <button
          onClick={() => {
            const a = audioRef.current;
            if (!a) return;
            a.muted = !a.muted;
            setMuted(a.muted);
          }}
          className="btn-interactive rounded-lg p-2 text-muted-foreground transition-all"
          title={muted ? "Включить звук" : "Выключить звук"}
        >
          {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
        </button>
        <button
          onClick={cycleRate}
          className="btn-interactive rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-all"
          title="Скорость воспроизведения"
        >
          {rate}x
        </button>

        <a
          href={src}
          download={fileName}
          className="ml-auto flex items-center gap-1.5 rounded-xl bg-interactive/10 px-3 py-2 text-xs font-medium text-interactive transition-all hover:bg-interactive/20 active:scale-95"
        >
          <Download className="h-3.5 w-3.5" /> Скачать
        </a>
      </div>
    </div>
  );
}
