/**
 * Плеер готовой видео-истории.
 *
 * Видео уже содержит и картинку, и звук, и субтитры (их рисует движок записи),
 * но плеер дополнительно показывает ту же строку поверх — её удобно читать на
 * паузе — и даёт переключаться между слайдами: начало каждого слайда известно
 * из таймлайна (`frames`), который собран от длительности реплик, поэтому прыжок
 * попадает точно в смену кадра.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Captions, CaptionsOff } from "lucide-react";
import { cueAt, formatClock, frameAt, type StoryFrame } from "@/lib/videoStory";

export interface StoryPlayerProps {
  /** Object URL собранного видео. */
  url: string;
  /** Таймлайн: слайды, их начало и субтитры. */
  frames: StoryFrame[];
  /** Постер (первый кадр) — показывается до запуска. */
  poster?: string;
  /** Подписи говорящих: «Speaker 1 · Charon». */
  speakerLabels?: Record<number, string>;
  subtitlesOn?: boolean;
  onToggleSubtitles?: () => void;
}

export function StoryPlayer({
  url,
  frames,
  poster,
  speakerLabels,
  subtitlesOn = true,
  onToggleSubtitles,
}: StoryPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const frame = frameAt(frames, time);
  const cue = frame ? cueAt(frame, time - frame.start) : null;
  const activeIndex = frame ? frames.indexOf(frame) : -1;

  // Свои часы не заводим: время берём у видео, поэтому субтитры не разъезжаются.
  const onTimeUpdate = useCallback(() => {
    const element = videoRef.current;
    if (!element) return;
    setTime(element.currentTime);
  }, []);

  const onLoadedMetadata = useCallback(() => {
    const element = videoRef.current;
    if (!element) return;
    setDuration(Number.isFinite(element.duration) ? element.duration : 0);
  }, []);

  useEffect(() => {
    setTime(0);
  }, [url]);

  /** Прыжок к слайду: чуть после его начала, чтобы кадр успел отрисоваться. */
  const jumpTo = useCallback((index: number) => {
    const element = videoRef.current;
    const frame = frames[index];
    if (!element || !frame) return;
    element.currentTime = Math.min(frame.start + 0.05, Math.max(0, (duration || frame.start + 1) - 0.05));
    setTime(element.currentTime);
    // play() в старых браузерах (и в jsdom) может не вернуть промис.
    Promise.resolve(element.play()).catch(() => {
      // Автозапуск может быть запрещён — не ошибка, пользователь нажмёт сам.
    });
  }, [duration, frames]);

  return (
    <div className="flex flex-col gap-3">
      <div className="relative overflow-hidden rounded-2xl border border-border bg-black">
        <video
          ref={videoRef}
          data-testid="story-player"
          className="block w-full"
          src={url}
          poster={poster}
          controls
          playsInline
          preload="metadata"
          onTimeUpdate={onTimeUpdate}
          onLoadedMetadata={onLoadedMetadata}
        />
        {subtitlesOn && cue && (
          <div className="pointer-events-none absolute inset-x-0 bottom-12 flex flex-col items-center gap-1 px-4">
            {frame && speakerLabels?.[frame.speaker] && (
              <span data-testid="story-subtitle-speaker" className="text-[11px] font-medium text-white/70">
                {speakerLabels[frame.speaker]}
              </span>
            )}
            <span
              data-testid="story-subtitle"
              className="max-w-[86%] rounded-lg bg-black/65 px-3 py-1.5 text-center text-sm font-semibold text-white shadow-lg"
            >
              {cue.text}
            </span>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs tabular-nums text-muted-foreground" data-testid="story-clock">
          {formatClock(time)} / {formatClock(duration || frames.reduce((sum, item) => sum + item.seconds, 0))}
        </span>
        {onToggleSubtitles && (
          <button
            type="button"
            onClick={onToggleSubtitles}
            aria-pressed={subtitlesOn}
            data-testid="story-subtitles-toggle"
            className="btn-interactive flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted-foreground"
          >
            {subtitlesOn ? <Captions className="h-3.5 w-3.5" /> : <CaptionsOff className="h-3.5 w-3.5" />}
            Субтитры
          </button>
        )}
      </div>

      {frames.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {frames.map((frame, index) => (
            <button
              key={frame.slideId}
              type="button"
              onClick={() => jumpTo(index)}
              data-testid={`story-chapter-${index + 1}`}
              aria-current={index === activeIndex}
              className={`btn-interactive rounded-xl border px-2.5 py-1.5 text-xs transition-all ${
                index === activeIndex
                  ? "border-interactive/60 bg-interactive/10 text-interactive"
                  : "border-border text-muted-foreground"
              }`}
            >
              Слайд {index + 1} · {speakerLabels?.[frame.speaker] ?? `Speaker ${frame.speaker}`} ·{" "}
              {formatClock(frame.seconds)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
