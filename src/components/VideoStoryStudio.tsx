/**
 * Студия видео-историй: пять этапов от слайдов до готового файла.
 *
 * Весь процесс и запросы живут в `useVideoStory` (тот же метод, что у отправки
 * сообщения в чате), компонент отвечает за представление:
 *
 * ЭТАП 1 «Материалы» — drag-and-drop загрузка слайдов, сортировка (перетаскиванием
 *   и стрелками), превью и удаление;
 * ЭТАП 2 «Персонажи и голоса» — профили говорящих: Speaker 1 (Charon) и Speaker 2
 *   (Kore) по умолчанию, выбор голоса, имя и «представление / контекст персонажа»,
 *   которое уходит в озвучку и влияет на интонации;
 * ЭТАП 3 «Сценарий по слайдам» — реплика и говорящий на каждый слайд, связь
 *   «Слайд 1 → Реплика Speaker 1» видна в самой строке;
 * ЭТАП 4 «Генерация и сборка» — озвучка дорожек, предпрослушивание, расчёт
 *   таймингов и запись видео с орбитальной анимацией процесса;
 * ЭТАП 5 «Готовое видео» — плеер с субтитрами и переключением слайдов,
 *   «Скачать видео» и «Отправить в чат».
 *
 * Видео собирается в браузере (Canvas + Web Audio + MediaRecorder), поэтому
 * никаких внешних очередей рендеринга и ожидания на сервере нет.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Clapperboard,
  Download,
  GripVertical,
  Loader2,
  Plus,
  RotateCcw,
  Send,
  Square,
  Trash2,
  Volume2,
  X,
} from "lucide-react";
import { OrbitProgress } from "@/components/OrbitProgress";
import { StoryPlayer } from "@/components/StoryPlayer";
import { STAGE_TITLES, STORY_STEPS_TOTAL, useVideoStory, type StoryStage } from "@/hooks/useVideoStory";
import { ACCEPTED_PAGE_ACCEPT } from "@/lib/mangaPages";
import { MAX_SLIDE_TEXT_CHARS, MAX_STORY_SLIDES, STORY_VOICES, formatClock } from "@/lib/videoStory";
import type { RecorderDeps } from "@/lib/videoRecorder";

export interface VideoStoryStudioProps {
  open: boolean;
  onClose: () => void;
  /** Отправить результат в чат: текст сообщения + постер. */
  onShare?: (payload: { text: string; images: string[] }) => void;
  /** Заголовок студии — уходит в текст сообщения при отправке в чат. */
  title?: string;
  /** Движок записи: в браузере настоящий, в тестах подставляют свой. */
  deps?: RecorderDeps;
}

/** Символы на орбите — из макета студии: искра, нота, кадр. */
const STUDIO_ORBIT_NODES = [
  { glyph: "✦", title: "Идея" },
  { glyph: "♫", title: "Озвучка" },
  { glyph: "▧", title: "Кадры" },
  { glyph: "▶", title: "Сборка" },
] as const;

const CONTEXT_HINTS = ["строгий ментор", "ироничный друг", "эмоциональная девушка", "спокойный рассказчик"];

/**
 * Список этапов — числами: `Object.keys` вернул бы строки, а правила перехода
 * (`canGoStage`) сравнивают номер этапа как число.
 */
const STAGE_LIST = Array.from({ length: STORY_STEPS_TOTAL }, (_, index) => (index + 1) as StoryStage);

export function VideoStoryStudio({ open, onClose, onShare, title, deps }: VideoStoryStudioProps) {
  const story = useVideoStory({ onShare, title, deps });
  const {
    slides,
    characters,
    script,
    scriptList,
    stage,
    progress,
    isBusy,
    error,
    failure,
    issues,
    tracks,
    slideIssues,
    readySlides,
    video,
    videoUrl,
    frames,
    previewId,
  } = story;

  const [subtitlesOn, setSubtitlesOn] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  /**
   * Тот же индекс в ref: `drop` может прийти до перерисовки, а замыкание
   * обработчика хранит прежнее состояние — тогда перестановка потерялась бы.
   */
  const dragIndexRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Закрытие останавливает озвучку и запись: ничего не должно собираться «в стол».
  useEffect(() => {
    if (open) return;
    story.stop();
    story.stopPreview();
    // Отключаем эффект только на открытии: stop стабилен, а story пересоздаётся.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const speakerLabels = useMemo(() => {
    const labels: Record<number, string> = {};
    for (const character of characters) {
      labels[character.speaker] = character.name
        ? `Speaker ${character.speaker} · ${character.name}`
        : `Speaker ${character.speaker}`;
    }
    return labels;
  }, [characters]);

  if (!open) return null;

  const issueBySlide = new Map(slideIssues.map((item) => [item.slideId, item.reason]));
  const voicedCount = readySlides.length;

  /* ---------------------------------------------------------------- */
  /* Этап 1: материалы                                                 */
  /* ---------------------------------------------------------------- */

  const stageMaterials = (
    <div className="flex flex-col gap-3">
      <div
        data-testid="story-dropzone"
        role="button"
        tabIndex={0}
        onClick={() => fileInputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            fileInputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          story.addFiles(e.dataTransfer.files);
        }}
        className={`flex cursor-pointer flex-col items-center gap-1 rounded-2xl border-2 border-dashed px-4 py-8 text-center transition-all ${
          dragOver ? "border-interactive bg-interactive/10" : "border-border hover:border-interactive/50"
        }`}
      >
        <Clapperboard className="h-6 w-6 text-interactive" />
        <p className="text-sm font-medium text-foreground">Перетащите изображения сюда</p>
        <p className="text-xs text-muted-foreground">
          PNG, JPEG или WebP до 10 МБ, не больше {MAX_STORY_SLIDES} слайдов · нажмите, чтобы выбрать файлы
        </p>
      </div>

      <input
        ref={fileInputRef}
        data-testid="story-file-input"
        aria-label="Слайды истории"
        type="file"
        accept={ACCEPTED_PAGE_ACCEPT}
        multiple
        className="hidden"
        onChange={(e) => {
          story.addFiles(e.target.files);
          e.target.value = "";
        }}
      />

      {slides.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {slides.map((slide, index) => (
            <article
              key={slide.id}
              data-testid={`story-slide-${index + 1}`}
              draggable
              onDragStart={() => {
                dragIndexRef.current = index;
                setDragIndex(index);
              }}
              onDragEnd={() => {
                dragIndexRef.current = null;
                setDragIndex(null);
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const from = dragIndexRef.current;
                if (from !== null && from !== index) story.moveSlide(from, index);
                dragIndexRef.current = null;
                setDragIndex(null);
              }}
              className={`animate-pop relative overflow-hidden rounded-xl border bg-muted/40 transition-all ${
                dragIndex === index ? "border-interactive opacity-60" : "border-border"
              }`}
            >
              <img src={slide.url} alt={`Слайд ${index + 1}`} className="h-28 w-full object-cover" />
              <div className="flex items-center justify-between gap-1 px-2 py-1.5">
                <span className="flex items-center gap-1 text-[11px] font-semibold text-foreground">
                  <GripVertical className="h-3 w-3 cursor-grab text-muted-foreground" />
                  Слайд {index + 1}
                </span>
                <span className="flex items-center gap-0.5">
                  <button
                    type="button"
                    aria-label={`Слайд ${index + 1}: раньше`}
                    data-testid={`story-slide-left-${index + 1}`}
                    disabled={index === 0}
                    onClick={() => story.moveSlide(index, index - 1)}
                    className="btn-interactive rounded p-1 text-muted-foreground disabled:opacity-30"
                  >
                    <ArrowLeft className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Слайд ${index + 1}: позже`}
                    data-testid={`story-slide-right-${index + 1}`}
                    disabled={index === slides.length - 1}
                    onClick={() => story.moveSlide(index, index + 1)}
                    className="btn-interactive rounded p-1 text-muted-foreground disabled:opacity-30"
                  >
                    <ArrowRight className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Убрать слайд ${index + 1}`}
                    data-testid={`story-slide-remove-${index + 1}`}
                    onClick={() => story.removeSlide(slide.id)}
                    className="btn-interactive rounded p-1 text-muted-foreground"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </span>
              </div>
            </article>
          ))}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Порядок слайдов = порядок в видео. Перетащите карточку или используйте стрелки; реплика и дорожка
        переезжают вместе со слайдом.
      </p>
    </div>
  );

  /* ---------------------------------------------------------------- */
  /* Этап 2: персонажи и голоса                                        */
  /* ---------------------------------------------------------------- */

  const stageCharacters = (
    <div className="flex flex-col gap-3">
      {characters.map((character) => (
        <article
          key={character.speaker}
          data-testid={`story-character-${character.speaker}`}
          className="animate-pop flex flex-col gap-2 rounded-2xl border border-border bg-muted/30 p-3"
        >
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-foreground">Speaker {character.speaker}</h3>
            {characters.length > 1 && (
              <button
                type="button"
                aria-label={`Убрать говорящего Speaker ${character.speaker}`}
                data-testid={`story-remove-character-${character.speaker}`}
                onClick={() => story.removeCharacter(character.speaker)}
                className="btn-interactive rounded p-1 text-muted-foreground"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              Голос
              <select
                data-testid={`story-voice-${character.speaker}`}
                aria-label={`Голос Speaker ${character.speaker}`}
                value={character.voice}
                onChange={(e) => story.setCharacter(character.speaker, { voice: e.target.value as never })}
                className="rounded-lg border border-border bg-background px-2 py-1 text-xs text-foreground"
              >
                {STORY_VOICES.map((voice) => (
                  <option key={voice} value={voice}>
                    {voice}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              Имя
              <input
                data-testid={`story-name-${character.speaker}`}
                aria-label={`Имя Speaker ${character.speaker}`}
                value={character.name}
                maxLength={40}
                onChange={(e) => story.setCharacter(character.speaker, { name: e.target.value })}
                className="w-32 rounded-lg border border-border bg-background px-2 py-1 text-xs text-foreground"
              />
            </label>
          </div>

          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Представление / контекст персонажа
            <textarea
              data-testid={`story-context-${character.speaker}`}
              aria-label={`Представление персонажа Speaker ${character.speaker}`}
              value={character.context}
              rows={2}
              maxLength={300}
              placeholder={CONTEXT_HINTS[character.speaker % CONTEXT_HINTS.length]}
              onChange={(e) => story.setCharacter(character.speaker, { context: e.target.value })}
              className="resize-none rounded-lg border border-border bg-background px-2 py-1.5 text-xs text-foreground"
            />
          </label>
          <p className="text-[11px] text-muted-foreground">
            Контекст уходит в озвучку как указание на манеру речи и влияет на интонации, но не читается вслух.
          </p>
        </article>
      ))}

      {characters.length < 8 && (
        <button
          type="button"
          data-testid="story-add-character"
          onClick={() => story.addCharacter()}
          className="btn-interactive flex items-center gap-2 self-start rounded-xl border border-border px-3 py-2 text-xs text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
          Добавить говорящего
        </button>
      )}
    </div>
  );

  /* ---------------------------------------------------------------- */
  /* Этап 3: сценарий по слайдам                                       */
  /* ---------------------------------------------------------------- */

  const stageScript = (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Каждому слайду — своя реплика и говорящий. Пустая реплика не даст собрать видео.
        </p>
        <button
          type="button"
          data-testid="story-auto-assign"
          onClick={() => story.autoAssignSpeakers()}
          className="btn-interactive rounded-xl border border-border px-3 py-1.5 text-xs text-foreground"
        >
          Расставить говорящих по порядку
        </button>
      </div>

      {slides.map((slide, index) => {
        const item = script[slide.id];
        const issue = issues.find((entry) => entry.slideId === slide.id);
        return (
          <article
            key={slide.id}
            data-testid={`story-script-row-${index + 1}`}
            className="animate-pop flex gap-3 rounded-2xl border border-border bg-muted/30 p-3"
          >
            <img
              src={slide.url}
              alt={`Слайд ${index + 1}`}
              className="h-20 w-14 flex-shrink-0 rounded-lg border border-border object-cover"
            />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold text-foreground">Слайд {index + 1}</span>
                <span className="text-[11px] text-muted-foreground">→</span>
                <select
                  data-testid={`story-speaker-${index + 1}`}
                  aria-label={`Говорящий слайда ${index + 1}`}
                  value={item?.speaker ?? characters[0]?.speaker ?? 1}
                  onChange={(e) => story.setSlideSpeaker(slide.id, Number(e.target.value))}
                  className="rounded-lg border border-border bg-background px-2 py-1 text-xs text-foreground"
                >
                  {characters.map((character) => (
                    <option key={character.speaker} value={character.speaker}>
                      Speaker {character.speaker}
                      {character.name ? ` · ${character.name}` : ""} ({character.voice})
                    </option>
                  ))}
                </select>
                <span className="text-[11px] text-muted-foreground">Реплика Speaker {item?.speaker ?? 1}</span>
              </div>

              <textarea
                data-testid={`story-script-${index + 1}`}
                aria-label={`Реплика слайда ${index + 1}`}
                value={item?.text ?? ""}
                rows={2}
                maxLength={MAX_SLIDE_TEXT_CHARS}
                placeholder="Что говорит персонаж на этом слайде?"
                onChange={(e) => story.setSlideText(slide.id, e.target.value)}
                className="resize-none rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground"
              />
              {issue && (
                <p data-testid={`story-script-issue-${index + 1}`} className="text-[11px] text-destructive">
                  {issue.reason}
                </p>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );

  /* ---------------------------------------------------------------- */
  /* Этап 4: генерация и сборка                                        */
  /* ---------------------------------------------------------------- */

  const stageGenerate = (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="story-generate"
          disabled={isBusy || issues.length > 0 || !slides.length}
          onClick={() => void story.generate()}
          className="flex items-center gap-2 rounded-xl bg-interactive px-4 py-2 text-sm text-interactive-foreground transition-all disabled:opacity-50"
        >
          {isBusy && progress.phase === "voicing" && <Loader2 className="h-4 w-4 animate-spin" />}
          {isBusy ? "Собираю видео…" : "Собрать видео"}
        </button>

        {isBusy && (
          <button
            type="button"
            data-testid="story-stop"
            onClick={() => story.stop()}
            className="btn-interactive flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm text-foreground"
          >
            <Square className="h-3.5 w-3.5" />
            Стоп
          </button>
        )}

        <span className="text-xs text-muted-foreground">
          {slides.length} слайдов · озвучено {voicedCount}
          {video ? ` · видео ${formatClock(video.duration)}` : ""}
        </span>
      </div>

      {issues.length > 0 && (
        <ul data-testid="story-script-issues" className="flex flex-col gap-1 text-[11px] text-destructive">
          {issues.map((issue, index) => (
            <li key={`${issue.slideId}-${index}`}>
              {issue.slideId
                ? `Слайд ${slides.findIndex((slide) => slide.id === issue.slideId) + 1}: ${issue.reason}`
                : issue.reason}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-2">
        {slides.map((slide, index) => {
          const track = tracks[slide.id];
          const reason = issueBySlide.get(slide.id);
          return (
            <div
              key={slide.id}
              data-testid={`story-track-${index + 1}`}
              className="flex items-center gap-2 rounded-xl border border-border bg-muted/30 px-3 py-2"
            >
              <img src={slide.url} alt="" className="h-10 w-8 flex-shrink-0 rounded object-cover" />
              <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                Слайд {index + 1} · {speakerLabels[script[slide.id]?.speaker ?? 1] ?? "Speaker 1"}
                {track ? ` · ${formatClock(track.seconds)}` : ""}
              </span>
              {track ? (
                <button
                  type="button"
                  data-testid={`story-track-preview-${index + 1}`}
                  aria-label={previewId === slide.id ? `Остановить дорожку слайда ${index + 1}` : `Послушать дорожку слайда ${index + 1}`}
                  onClick={() => (previewId === slide.id ? story.stopPreview() : story.previewSlide(slide.id))}
                  className="btn-interactive rounded-lg border border-border p-1.5 text-muted-foreground"
                >
                  {previewId === slide.id ? <Square className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
                </button>
              ) : (
                <span className="text-[11px] text-muted-foreground">{reason ? "сбой" : "нет дорожки"}</span>
              )}
              {reason && (
                <span data-testid={`story-track-issue-${index + 1}`} className="max-w-[45%] truncate text-[11px] text-destructive" title={reason}>
                  {reason}
                </span>
              )}
            </div>
          );
        })}
      </div>

      <p className="text-[11px] text-muted-foreground">
        Каждый слайд показывается ровно столько, сколько звучит его реплика. Сбой одного слайда не
        останавливает сборку: он помечается причиной, а видео собирается из озвученных.
      </p>
    </div>
  );

  /* ---------------------------------------------------------------- */
  /* Этап 5: готовое видео                                             */
  /* ---------------------------------------------------------------- */

  const stageResult = video ? (
    <div className="flex flex-col gap-3">
      <StoryPlayer
        url={videoUrl}
        frames={frames}
        poster={video.poster}
        speakerLabels={speakerLabels}
        subtitlesOn={subtitlesOn}
        onToggleSubtitles={() => setSubtitlesOn((prev) => !prev)}
      />

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="story-download"
          onClick={() => story.download()}
          className="flex items-center gap-2 rounded-xl bg-interactive px-4 py-2 text-sm text-interactive-foreground transition-all"
        >
          <Download className="h-4 w-4" />
          Скачать видео ({video.ext.toUpperCase()})
        </button>
        {onShare && (
          <button
            type="button"
            data-testid="story-share"
            onClick={() => story.share()}
            className="btn-interactive flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm text-foreground"
          >
            <Send className="h-4 w-4" />
            Отправить в чат
          </button>
        )}
        <button
          type="button"
          data-testid="story-reset"
          onClick={() => story.reset()}
          className="btn-interactive flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm text-foreground"
        >
          <RotateCcw className="h-4 w-4" />
          Новая история
        </button>
      </div>

      <dl data-testid="story-result-meta" className="grid grid-cols-2 gap-2 text-[11px] text-muted-foreground sm:grid-cols-4">
        <div>
          <dt>Длительность</dt>
          <dd className="font-medium text-foreground">{formatClock(video.duration)}</dd>
        </div>
        <div>
          <dt>Формат</dt>
          <dd className="font-medium text-foreground">{video.ext.toUpperCase()}</dd>
        </div>
        <div>
          <dt>Размер</dt>
          <dd className="font-medium text-foreground">{(video.blob.size / (1024 * 1024)).toFixed(1)} МБ</dd>
        </div>
        <div>
          <dt>Слайдов</dt>
          <dd className="font-medium text-foreground">{frames.length}</dd>
        </div>
      </dl>

      <p className="text-[11px] text-muted-foreground">
        В чат уходит первый кадр как превью и подпись с параметрами: сообщение хранит картинки, а не
        видеофайлы, поэтому сам файл скачивается на устройство.
      </p>
    </div>
  ) : (
    <p className="text-xs text-muted-foreground">Видео ещё не собрано — вернитесь к этапу «Генерация и сборка».</p>
  );

  const stageContent: Record<StoryStage, React.ReactNode> = {
    1: stageMaterials,
    2: stageCharacters,
    3: stageScript,
    4: stageGenerate,
    5: stageResult,
  };

  const nextEnabled = story.canGoStage((Math.min(STORY_STEPS_TOTAL, stage + 1) as StoryStage));

  return (
    <div
      className="animate-fade-in fixed inset-0 z-[60] flex items-end justify-center bg-background/70 p-0 backdrop-blur-sm sm:items-center sm:p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        data-testid="story-modal"
        className="scrollbar-thin max-h-[92vh] w-full overflow-y-auto rounded-t-2xl border border-border bg-background p-4 shadow-xl animate-slide-up sm:max-w-3xl sm:rounded-2xl"
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
            <Clapperboard className="h-4 w-4 text-interactive" />
            Студия видео-историй
          </h2>
          <div className="flex items-center gap-2">
            <span
              data-testid="story-stage"
              className="rounded-full border border-border px-2.5 py-1 text-[10px] tracking-[0.12em] text-muted-foreground"
            >
              ЭТАП {stage} / {STORY_STEPS_TOTAL}
            </span>
            <button
              type="button"
              onClick={onClose}
              aria-label="Закрыть"
              className="btn-interactive rounded-lg p-1.5 text-muted-foreground transition-all"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Шаги: видно, где история сейчас, и куда можно перейти. */}
        <nav aria-label="Этапы студии" className="mb-3 flex flex-wrap gap-1.5">
          {STAGE_LIST.map((step) => {
            const enabled = story.canGoStage(step);
            return (
              <button
                key={step}
                type="button"
                data-testid={`story-stage-${step}`}
                disabled={!enabled}
                onClick={() => story.setStage(step)}
                aria-current={stage === step}
                className={`rounded-xl border px-2.5 py-1.5 text-[11px] transition-all disabled:cursor-not-allowed disabled:opacity-45 ${
                  stage === step
                    ? "border-interactive/60 bg-interactive/10 font-semibold text-interactive"
                    : "border-border text-muted-foreground"
                }`}
              >
                {step}. {STAGE_TITLES[step]}
              </button>
            );
          })}
        </nav>

        <OrbitProgress
          percent={progress.percent}
          label={progress.label}
          detail={progress.detail}
          active={isBusy}
          phase={progress.phase}
          step={stage}
          stepsTotal={STORY_STEPS_TOTAL}
          nodes={STUDIO_ORBIT_NODES}
          testId="story-progress"
        />

        {error && (
          <p
            role="alert"
            data-testid="story-error"
            className="mt-3 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            {error}
            {failure?.status ? ` · код ${failure.status}` : ""}
          </p>
        )}

        <section className="mt-3" aria-label={STAGE_TITLES[stage]}>
          {stageContent[stage]}
        </section>

        <div className="mt-4 flex items-center justify-between gap-2 border-t border-border pt-3">
          <button
            type="button"
            data-testid="story-back"
            disabled={stage === 1}
            onClick={() => story.setStage((stage - 1) as StoryStage)}
            className="btn-interactive flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs text-foreground disabled:opacity-40"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Назад
          </button>
          <span className="text-[11px] text-muted-foreground">{STAGE_TITLES[stage]}</span>
          <button
            type="button"
            data-testid="story-next"
            disabled={!nextEnabled}
            onClick={() => story.setStage((Math.min(STORY_STEPS_TOTAL, stage + 1) as StoryStage))}
            className="btn-interactive flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs text-foreground disabled:opacity-40"
          >
            Далее
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
