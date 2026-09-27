import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Loader2, Trash2, Volume2, X } from "lucide-react";
import { AudioPlayer } from "@/components/AudioPlayer";
import { getEdgeAuthHeaders } from "@/lib/edgeAuth";
import { useAiProvider } from "@/hooks/useAiProvider";
import { useUserApiKeys } from "@/hooks/useUserApiKeys";
import { syncActiveKeyFromHeaders } from "@/lib/aiKeySync";
import { announceStopSpeech } from "@/lib/speechEvents";
import {
  ACCEPTED_PAGE_ACCEPT,
  ANALYZE_BATCH_SIZE,
  filterPageFiles,
  formatRejections,
  toPageDataURL,
} from "@/lib/mangaPages";
import {
  MAX_TTS_SPEAKERS,
  TTS_VOICES,
  defaultVoiceFor,
  planTranscript,
} from "@/lib/mangaTranscript";
import type { TtsVoice } from "@/lib/mangaTranscript";

const endpoint = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

type PageStatus = "new" | "analyzing" | "ready";

interface Page {
  id: string;
  file: File;
  /** Превью страницы (object URL). Отзывается при удалении страницы и на unmount. */
  url: string;
  status: PageStatus;
  description?: string;
  transcript?: string;
  /** Готовая озвучка кадра (object URL). */
  audio?: string;
}

interface MangaVoiceModalProps {
  open: boolean;
  onClose: () => void;
}

let pageSeq = 0;
const nextPageId = () => `manga-page-${Date.now().toString(36)}-${(pageSeq += 1)}`;

function releasePage(page: Pick<Page, "url" | "audio">) {
  try {
    URL.revokeObjectURL(page.url);
    if (page.audio) URL.revokeObjectURL(page.audio);
  } catch {
    // URL уже отозван — не критично
  }
}

export function MangaVoiceModal({ open, onClose }: MangaVoiceModalProps) {
  const [pages, setPages] = useState<Page[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [voices, setVoices] = useState<Record<string, TtsVoice>>(() =>
    Object.fromEntries(TTS_VOICES.map((voice, i) => [String(i + 1), voice])) as Record<string, TtsVoice>
  );
  /** id страницы + url озвучки, которую запустили только что. Сбрасывается при закрытии. */
  const [autoPlayKey, setAutoPlayKey] = useState<string | null>(null);
  // Анализ и озвучка идут через выбранный в настройках провайдер.
  const { provider } = useAiProvider();
  const { keys: userKeys, activeIndex: userKeyIndex, setActiveIndex } = useUserApiKeys();

  const pagesRef = useRef(pages);
  pagesRef.current = pages;

  useEffect(
    () => () => {
      pagesRef.current.forEach(releasePage);
    },
    []
  );

  // При закрытии останавливаем звук и гасим автозапуск: иначе при повторном
  // открытии все озвученные страницы стартуют одновременно.
  useEffect(() => {
    if (open) return;
    announceStopSpeech();
    setAutoPlayKey(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  /** Все персонажи, которые встречаются в транскриптах главы. */
  const chapter = useMemo(() => {
    const speakers = new Set<number>();
    const names: Record<number, string> = {};
    for (const page of pages) {
      if (page.status !== "ready") continue;
      const plan = planTranscript(page.transcript ?? "");
      plan.speakers.forEach((s) => speakers.add(s));
      Object.entries(plan.names).forEach(([s, name]) => {
        names[Number(s)] = name;
      });
    }
    return { speakers: [...speakers].sort((a, b) => a - b).slice(0, MAX_TTS_SPEAKERS), names };
  }, [pages]);

  const readyPages = useMemo(() => pages.filter((p) => p.status === "ready"), [pages]);
  const pendingCount = useMemo(() => pages.filter((p) => p.status !== "ready").length, [pages]);

  const addFiles = useCallback((list: FileList | null) => {
    const { accepted, rejected } = filterPageFiles(list);
    const rejectionNote = formatRejections(rejected);
    if (accepted.length) {
      setPages((prev) => [
        ...prev,
        ...accepted.map((file) => ({ id: nextPageId(), file, url: URL.createObjectURL(file), status: "new" as const })),
      ]);
    }
    setError(rejectionNote);
  }, []);

  const removePage = useCallback((id: string) => {
    setPages((prev) => {
      const target = prev.find((p) => p.id === id);
      if (target) releasePage(target);
      return prev.filter((p) => p.id !== id);
    });
  }, []);

  const post = useCallback(async (path: string, body: Record<string, unknown>) => {
    const res = await fetch(`${endpoint}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await getEdgeAuthHeaders()) },
      body: JSON.stringify({ ...body, provider, userKeys, userKeyIndex }),
    });
    if (!res.ok) {
      const info = await res.json().catch(() => ({}));
      throw new Error(info?.error || `Ошибка ${res.status}`);
    }
    syncActiveKeyFromHeaders(res.headers, setActiveIndex);
    return res;
  }, [provider, userKeys, userKeyIndex, setActiveIndex]);

  const analyze = useCallback(async () => {
    const batch = pagesRef.current.filter((p) => p.status !== "ready").slice(0, ANALYZE_BATCH_SIZE);
    if (!batch.length || analyzing) return;

    const batchIds = new Set(batch.map((p) => p.id));
    setAnalyzing(true);
    setError("");
    setPages((prev) => prev.map((p) => (batchIds.has(p.id) ? { ...p, status: "analyzing" } : p)));

    try {
      // Страницы уменьшаются до 1600 px и пережимаются: батч из 5 сканов по 10 МБ
      // в base64 — это десятки мегабайт в одном запросе, он не проходит по лимитам.
      const images = await Promise.all(batch.map((p) => toPageDataURL(p.file)));
      const res = await post("manga-analyze", { images });
      const data = await res.json();
      const result: { description?: string; transcript?: string }[] = Array.isArray(data?.pages) ? data.pages : [];

      setPages((prev) =>
        prev.map((p) => {
          const index = batch.findIndex((b) => b.id === p.id);
          if (index < 0) return p;
          const item = result[index];
          if (!item) return { ...p, status: "new" };
          return {
            ...p,
            status: "ready",
            description: item.description ?? "",
            transcript: item.transcript ?? "",
          };
        })
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка анализа");
      setPages((prev) => prev.map((p) => (batchIds.has(p.id) && p.status === "analyzing" ? { ...p, status: "new" } : p)));
    } finally {
      setAnalyzing(false);
    }
  }, [analyzing, post]);

  const synthesize = useCallback(
    async (page: Page) => {
      const plan = planTranscript(page.transcript ?? "");
      if (plan.problems.length) {
        setError(plan.problems[0]);
        return false;
      }

      const res = await post("dialog-tts", { transcript: plan.text, voices });
      const url = URL.createObjectURL(await res.blob());
      setPages((prev) =>
        prev.map((p) => {
          if (p.id !== page.id) return p;
          if (p.audio && p.audio !== url) URL.revokeObjectURL(p.audio);
          return { ...p, audio: url };
        })
      );
      setAutoPlayKey(`${page.id}:${url}`);
      return true;
    },
    [post, voices]
  );

  const speak = useCallback(
    async (page: Page) => {
      setSpeakingId(page.id);
      setError("");
      announceStopSpeech();
      try {
        await synthesize(page);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Ошибка озвучки");
      } finally {
        setSpeakingId(null);
      }
    },
    [synthesize]
  );

  const speakAll = useCallback(async () => {
    const queue = pagesRef.current.filter((p) => p.status === "ready" && (p.transcript ?? "").trim());
    if (!queue.length) return;
    setError("");
    announceStopSpeech();
    for (const page of queue) {
      setSpeakingId(page.id);
      try {
        await synthesize(page);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Ошибка озвучки");
        break;
      }
    }
    setSpeakingId(null);
  }, [synthesize]);

  if (!open) return null;

  const analyzeLabel = analyzing
    ? "Анализирую…"
    : pendingCount
      ? `Анализировать страницы ${pages.length - pendingCount + 1}–${Math.min(pages.length - pendingCount + ANALYZE_BATCH_SIZE, pages.length)}`
      : "Все страницы обработаны";

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
          Загрузите страницы по порядку. Анализируем по {ANALYZE_BATCH_SIZE} изображений, затем добавляйте следующие.
          Каждая страница получит описание, реплики и отдельную озвучку.
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
              disabled={analyzing || pendingCount === 0}
              onClick={analyze}
              className="flex items-center gap-2 rounded-lg bg-interactive px-4 py-2 text-sm text-interactive-foreground transition-all disabled:opacity-50"
            >
              {analyzing && <Loader2 className="h-4 w-4 animate-spin" />}
              {analyzeLabel}
            </button>
            {readyPages.length > 0 && (
              <button
                data-testid="manga-speak-all"
                disabled={speakingId !== null}
                onClick={speakAll}
                className="flex items-center gap-2 rounded-lg bg-interactive/10 px-4 py-2 text-sm text-interactive transition-all disabled:opacity-50"
              >
                {speakingId !== null ? <Loader2 className="h-4 w-4 animate-spin" /> : <Volume2 className="h-4 w-4" />}
                Озвучить всё
              </button>
            )}
          </div>
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
                    value={voices[String(speaker)] ?? defaultVoiceFor(speaker)}
                    onChange={(e) =>
                      setVoices((prev) => ({ ...prev, [String(speaker)]: e.target.value as TtsVoice }))
                    }
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
                      onChange={(e) =>
                        setPages((prev) =>
                          prev.map((item) => (item.id === page.id ? { ...item, transcript: e.target.value } : item))
                        )
                      }
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

                    <button
                      data-testid={`manga-speak-${i + 1}`}
                      disabled={speakingId !== null || plan.problems.length > 0}
                      onClick={() => speak(page)}
                      className="mt-2 flex items-center gap-2 rounded-lg bg-interactive px-3 py-2 text-sm text-interactive-foreground transition-all disabled:opacity-50"
                    >
                      {busyWithPage ? <Loader2 className="h-4 w-4 animate-spin" /> : <Volume2 className="h-4 w-4" />}
                      {page.audio ? "Переозвучить кадр" : "Озвучить кадр"}
                    </button>

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
