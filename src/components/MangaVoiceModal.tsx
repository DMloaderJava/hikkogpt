/**
 * Окно «Озвучиватель манги».
 *
 * Вся работа с запросами и состоянием страниц живёт в `useMangaVoice` — хук
 * построен по образцу `useChat` (отправка сообщения): единые заголовки и
 * обработка ошибок, `AbortController` с кнопкой «Стоп», понятные причины отказа
 * в плашке и в toast. Компонент здесь отвечает только за представление.
 */

import { useEffect } from "react";
import { BookOpen, Loader2, Square, Trash2, Volume2, X } from "lucide-react";
import { AudioPlayer } from "@/components/AudioPlayer";
import { useMangaVoice } from "@/hooks/useMangaVoice";
import { ACCEPTED_PAGE_ACCEPT, ANALYZE_BATCH_SIZE } from "@/lib/mangaPages";
import { MAX_TTS_SPEAKERS, TTS_VOICES, planTranscript, type TtsVoice } from "@/lib/mangaTranscript";

interface MangaVoiceModalProps {
  open: boolean;
  onClose: () => void;
}

export function MangaVoiceModal({ open, onClose }: MangaVoiceModalProps) {
  const {
    pages,
    voices,
    chapter,
    readyPages,
    pendingCount,
    isAnalyzing,
    analyzeProgress,
    speakingId,
    isRequesting,
    error,
    autoPlayKey,
    addFiles,
    removePage,
    setTranscript,
    setVoice,
    analyzePages,
    speakPage,
    speakAll,
    stop,
  } = useMangaVoice();

  // Закрытие окна останавливает запросы и глушит звук: ничего не должно
  // озвучиваться «в пустоту» (тот же принцип, что и stopStreaming в чате).
  // Страницы и уже готовая озвучка сохраняются в хуке — при повторном открытии
  // окно показывает прежний результат, а не пустой список.
  useEffect(() => {
    if (open) return;
    stop();
  }, [open, stop]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const analyzeLabel = (() => {
    if (isAnalyzing) {
      if (!analyzeProgress || analyzeProgress.preparing) return "Готовлю страницы к отправке…";
      const from = analyzeProgress.done + 1;
      const to = Math.min(analyzeProgress.done + ANALYZE_BATCH_SIZE, analyzeProgress.total);
      const suffix = analyzeProgress.batches > 1 ? ` из ${analyzeProgress.total}` : "";
      return `Анализирую страницы ${from}–${to}${suffix}…`;
    }
    if (!pages.length) return "Анализировать страницы";
    if (!pendingCount) return "Все страницы обработаны";
    const from = pages.length - pendingCount + 1;
    const to = pages.length;
    const batches = Math.ceil(pendingCount / ANALYZE_BATCH_SIZE);
    return batches > 1
      ? `Анализировать страницы ${from}–${to} (по ${ANALYZE_BATCH_SIZE} за запрос)`
      : `Анализировать страницы ${from}–${to}`;
  })();

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-background/70 backdrop-blur-sm animate-fade-in p-0 sm:p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        data-testid="manga-modal"
        className="w-full sm:max-w-2xl max-h-[90vh] overflow-y-auto scrollbar-thin rounded-t-2xl sm:rounded-2xl border border-border bg-background p-4 shadow-xl animate-slide-up"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
            <BookOpen className="h-4 w-4 text-interactive" />
            Озвучиватель манги
          </h2>
          <button
            onClick={onClose}
            aria-label="Закрыть"
            className="btn-interactive rounded-lg p-1.5 text-muted-foreground transition-all"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="mb-2 text-xs text-muted-foreground">
          Загрузите страницы по порядку — они разбираются батчами по {ANALYZE_BATCH_SIZE} изображений
          за одно нажатие. Каждая страница получит описание, реплики и отдельную озвучку.
        </p>

        <input
          data-testid="manga-file-input"
          aria-label="Страницы манги"
          type="file"
          accept={ACCEPTED_PAGE_ACCEPT}
          multiple
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = "";
          }}
          className="w-full text-sm"
        />

        {pages.length > 0 && (
          <div className="my-3 flex flex-wrap items-center gap-2">
            <button
              data-testid="manga-analyze"
              disabled={isAnalyzing || pendingCount === 0}
              onClick={() => void analyzePages()}
              className="flex items-center gap-2 rounded-lg bg-interactive px-4 py-2 text-sm text-interactive-foreground transition-all disabled:opacity-50"
            >
              {isAnalyzing && <Loader2 className="h-4 w-4 animate-spin" />}
              {analyzeLabel}
            </button>

            {readyPages.length > 0 && (
              <button
                data-testid="manga-speak-all"
                disabled={isRequesting}
                onClick={() => void speakAll()}
                className="flex items-center gap-2 rounded-lg bg-interactive/10 px-4 py-2 text-sm text-interactive transition-all disabled:opacity-50"
              >
                {speakingId !== null ? <Loader2 className="h-4 w-4 animate-spin" /> : <Volume2 className="h-4 w-4" />}
                Озвучить всё
              </button>
            )}

            {isRequesting && (
              <button
                data-testid="manga-stop"
                onClick={stop}
                aria-label="Остановить"
                className="flex items-center gap-2 rounded-lg bg-destructive/10 px-4 py-2 text-sm text-destructive transition-all hover:bg-destructive/20"
              >
                <Square className="h-3.5 w-3.5" fill="currentColor" />
                Стоп
              </button>
            )}
          </div>
        )}

        {isAnalyzing && analyzeProgress && !analyzeProgress.preparing && analyzeProgress.batches > 1 && (
          <p className="mb-3 text-[11px] text-muted-foreground">
            Батч {analyzeProgress.batch} из {analyzeProgress.batches} · обработано {analyzeProgress.done} из{" "}
            {analyzeProgress.total} страниц
          </p>
        )}

        {error && (
          <p role="alert" className="mb-3 rounded-xl bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        )}

        {chapter.speakers.length > 0 && (
          <div className="mb-4 rounded-xl border border-border bg-secondary/40 p-3">
            <p className="mb-2 text-xs font-medium text-foreground">Голоса персонажей</p>
            <div className="grid grid-cols-2 gap-2">
              {chapter.speakers.map((speaker) => (
                <label key={speaker} className="text-xs text-muted-foreground">
                  {chapter.names[speaker] ? `${chapter.names[speaker]} (${speaker})` : `Персонаж ${speaker}`}
                  <select
                    data-testid={`manga-voice-${speaker}`}
                    aria-label={`Голос персонажа ${speaker}`}
                    value={voices[String(speaker)] ?? TTS_VOICES[(speaker - 1) % TTS_VOICES.length]}
                    onChange={(e) => setVoice(speaker, e.target.value as TtsVoice)}
                    className="mt-1 w-full rounded-lg border border-border bg-secondary/50 px-2 py-2 text-sm text-foreground focus:border-interactive/40 focus:outline-none transition-all"
                  >
                    {TTS_VOICES.map((voice) => (
                      <option key={voice} value={voice}>
                        {voice}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            {chapter.speakers.length >= MAX_TTS_SPEAKERS && (
              <p className="mt-2 text-[11px] text-muted-foreground">
                Персонажей больше, чем голосов: часть из них делит голос с последним.
              </p>
            )}
          </div>
        )}

        <div className="space-y-4">
          {pages.map((page, i) => {
            const plan = planTranscript(page.transcript ?? "");
            const busyWithPage = speakingId === page.id;
            return (
              <div key={page.id} data-testid={`manga-page-${i + 1}`} className="rounded-xl border border-border p-3">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-sm font-medium text-foreground">Страница {i + 1}</p>
                  <button
                    onClick={() => removePage(page.id)}
                    aria-label={`Убрать страницу ${i + 1}`}
                    className="btn-interactive rounded-lg p-1.5 text-muted-foreground transition-all"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>

                <img
                  src={page.url}
                  alt={`Страница манги ${i + 1}`}
                  className="max-h-96 w-full rounded-lg object-contain"
                />

                {page.status === "analyzing" && (
                  <p className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Разбираю кадр…
                  </p>
                )}

                {page.status === "ready" && (
                  <>
                    {page.description && <p className="my-2 text-sm text-muted-foreground">{page.description}</p>}

                    <textarea
                      data-testid={`manga-transcript-${i + 1}`}
                      aria-label={`Реплики страницы ${i + 1}`}
                      value={page.transcript ?? ""}
                      placeholder={"Аки: Ты опоздал\nРассказчик: Он всегда опаздывал."}
                      onChange={(e) => setTranscript(page.id, e.target.value)}
                      rows={4}
                      className="w-full resize-none rounded-lg border border-border bg-secondary/50 p-2 text-sm text-foreground focus:border-interactive/40 focus:outline-none transition-all"
                    />

                    {plan.problems.length > 0 && (
                      <p className="mt-1.5 text-[11px] text-destructive">{plan.problems[0]}</p>
                    )}
                    {plan.speakers.length > 0 && plan.problems.length === 0 && (
                      <p className="mt-1.5 text-[11px] text-muted-foreground">
                        Голосов: {plan.speakers.length} · реплик: {plan.lines.length}
                      </p>
                    )}

                    {page.voiceError && (
                      <p data-testid={`manga-voice-error-${i + 1}`} className="mt-1.5 text-[11px] text-destructive">
                        Озвучка не удалась: {page.voiceError}
                      </p>
                    )}

                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <button
                        data-testid={`manga-speak-${i + 1}`}
                        disabled={isRequesting || plan.problems.length > 0}
                        onClick={() => void speakPage(page.id)}
                        className="flex items-center gap-2 rounded-lg bg-interactive px-3 py-2 text-sm text-interactive-foreground transition-all disabled:opacity-50"
                      >
                        {busyWithPage ? <Loader2 className="h-4 w-4 animate-spin" /> : <Volume2 className="h-4 w-4" />}
                        {page.audio ? "Переозвучить кадр" : "Озвучить кадр"}
                      </button>

                      {busyWithPage && (
                        <button
                          data-testid={`manga-stop-${i + 1}`}
                          onClick={stop}
                          aria-label={`Остановить озвучку страницы ${i + 1}`}
                          className="flex items-center gap-1.5 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive transition-all hover:bg-destructive/20"
                        >
                          <Square className="h-3 w-3" fill="currentColor" />
                          Стоп
                        </button>
                      )}
                    </div>

                    {page.audio && (
                      <div className="mt-3">
                        <AudioPlayer
                          src={page.audio}
                          fileName={`manga-page-${i + 1}.wav`}
                          autoPlay={autoPlayKey === `${page.id}:${page.audio}`}
                        />
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
