/**
 * Озвучиватель манги: состояние страниц и все запросы фичи.
 *
 * Хук повторяет метод отправки сообщения в чате (`useChat.sendMessage`) —
 * request-логика вынесена из компонента, а каждый запрос живёт по одному
 * сценарию:
 *
 * 1. UI обновляется сразу: страница уходит в `analyzing`/`speaking` до ответа,
 *    а тяжёлая подготовка данных (сжатие сканов в dataURL) идёт фоном и не
 *    блокирует интерфейс;
 * 2. запрос уходит через общий `edgeRequest` (те же заголовки `Authorization` +
 *    `apikey`, тот же JSON-контракт) и обязательно принимает `signal`;
 * 3. длительные задачи можно прервать — `stop()` рвёт текущий запрос и всю
 *    очередь, как `stopStreaming()` в чате;
 * 4. отмена не показывается ошибкой (`isAbortError`), а причина отказа от
 *    сервера доезжает до пользователя целиком: плашка в модалке + toast, потому
 *    что окно может быть закрыто в момент ответа;
 * 5. результат раскладывается по страницам одним `updatePages`, страницы без
 *    ответа возвращаются в исходное состояние — их можно отправить повторно;
 * 6. «Озвучить всё» не останавливается на первой неудаче: страницы, которые не
 *    удалось озвучить, помечаются, остальные продолжают очередь (аналог
 *    `Promise.allSettled` в автораскладке картинок в чате).
 *
 * Серверные функции (`manga-analyze`, `dialog-tts`) не меняются: контракт
 * запросов и ответов прежний.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { EdgeRequestError, edgeBlob, edgeJson, isAbortError } from "@/lib/edgeAuth";
import { announceStopSpeech } from "@/lib/speechEvents";
import {
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
  type TranscriptPlan,
  type TtsVoice,
} from "@/lib/mangaTranscript";

/** Функции, в которые ходит фича (те же пути, что и раньше). */
export const MANGA_ANALYZE_FN = "manga-analyze";
export const DIALOG_TTS_FN = "dialog-tts";

export type MangaPageStatus = "new" | "analyzing" | "ready";

export interface MangaPage {
  id: string;
  file: File;
  /** Превью страницы (object URL). Отзывается при удалении страницы и на unmount. */
  url: string;
  status: MangaPageStatus;
  description?: string;
  transcript?: string;
  /** Готовая озвучка кадра (object URL). */
  audio?: string;
  /** Почему озвучка этого кадра не удалась (пусто = всё хорошо). */
  voiceError?: string;
}

export type VoicesMap = Record<string, TtsVoice>;

/** Прогресс анализа: сколько страниц уже разобрано в текущем запуске. */
export interface AnalyzeProgress {
  /** Номер текущего батча (1..batches). */
  batch: number;
  /** Сколько всего батчей в этом запуске. */
  batches: number;
  /** Сколько страниц ушло в обработку этим запуском. */
  total: number;
  /** Сколько из них уже разобрано. */
  done: number;
}

/** Ответ `manga-analyze` на один батч. */
interface AnalyzePageResult {
  description?: string;
  transcript?: string;
}

let pageSeq = 0;
const nextPageId = () => `manga-page-${Date.now().toString(36)}-${(pageSeq += 1)}`;

/** Освобождает object URL страницы (превью и озвучку). */
export function releasePage(page: Pick<MangaPage, "url" | "audio">) {
  try {
    URL.revokeObjectURL(page.url);
    if (page.audio) URL.revokeObjectURL(page.audio);
  } catch {
    // URL уже отозван — не критично
  }
}

const chunk = <T,>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

/** Ответ модели → поля страницы: пустые значения не затирают прежние. */
function applyAnalyzeResult(page: MangaPage, item: AnalyzePageResult | undefined): MangaPage {
  if (!item) return { ...page, status: "new" };
  return {
    ...page,
    status: "ready",
    description: item.description ?? "",
    transcript: item.transcript ?? "",
  };
}

export function useMangaVoice() {
  const [pages, setPages] = useState<MangaPage[]>([]);
  const [voices, setVoices] = useState<VoicesMap>(
    () => Object.fromEntries(TTS_VOICES.map((voice, i) => [String(i + 1), voice])) as VoicesMap
  );
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analyzeProgress, setAnalyzeProgress] = useState<AnalyzeProgress | null>(null);
  /** id страницы, которая озвучивается прямо сейчас. */
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  /** id страницы + url озвучки, которую запустили только что (для autoPlay). */
  const [autoPlayKey, setAutoPlayKey] = useState<string | null>(null);

  /**
   * Свежие страницы/голоса внутри длинных циклов — тот же приём, что `chats` в
   * `useChat`. Ref синхронизируется в момент апдейта, а не только на рендере:
   * иначе две правки подряд (например, «изменить реплики» → «Озвучить всё»)
   * читают устаревший снимок.
   */
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const voicesRef = useRef(voices);
  voicesRef.current = voices;

  /**
   * Единственный способ менять страницы: следующее состояние считается из ref
   * синхронно, поэтому «поправить реплики → сразу озвучить всё» и «ответ
   * пришёл → страница удалена» не могут прочитать устаревший снимок.
   */
  const updatePages = useCallback((updater: (prev: MangaPage[]) => MangaPage[]) => {
    const next = updater(pagesRef.current);
    pagesRef.current = next;
    setPages(next);
  }, []);

  /** Один контроллер на запрос; `stop()` рвёт и запрос, и очередь. */
  const abortRef = useRef<AbortController | null>(null);
  const stoppedRef = useRef(false);
  const runningRef = useRef(false);
  /** Токен запуска: «Стоп» и сразу новый анализ не должны чистить чужое состояние. */
  const runIdRef = useRef(0);

  /* ------------------------------------------------------------------ */
  /* Страницы                                                            */
  /* ------------------------------------------------------------------ */

  const addFiles = useCallback((list: FileList | File[] | null) => {
    const { accepted, rejected } = filterPageFiles(list);
    const rejectionNote = formatRejections(rejected);
    if (accepted.length) {
      updatePages((prev) => [
        ...prev,
        ...accepted.map((file) => ({
          id: nextPageId(),
          file,
          url: URL.createObjectURL(file),
          status: "new" as const,
        })),
      ]);
    }
    setError(rejectionNote);
    return { added: accepted.length, rejected: rejected.length };
  }, [updatePages]);

  const removePage = useCallback((id: string) => {
    updatePages((prev) => {
      const target = prev.find((p) => p.id === id);
      if (target) releasePage(target);
      return prev.filter((p) => p.id !== id);
    });
  }, [updatePages]);

  /** Правка реплик вручную: озвучка всегда берёт текст из состояния, а не из снимка. */
  const setTranscript = useCallback((id: string, transcript: string) => {
    updatePages((prev) => prev.map((p) => (p.id === id ? { ...p, transcript, voiceError: undefined } : p)));
  }, [updatePages]);

  const setVoice = useCallback((speaker: number | string, voice: TtsVoice) => {
    setVoices((prev) => {
      const next = { ...prev, [String(speaker)]: voice };
      voicesRef.current = next;
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    runIdRef.current += 1;
    abortRef.current?.abort();
    stoppedRef.current = true;
    pagesRef.current.forEach(releasePage);
    pagesRef.current = [];
    setPages([]);
    const freshVoices = Object.fromEntries(TTS_VOICES.map((voice, i) => [String(i + 1), voice])) as VoicesMap;
    voicesRef.current = freshVoices;
    setVoices(freshVoices);
    setIsAnalyzing(false);
    setAnalyzeProgress(null);
    setSpeakingId(null);
    setAutoPlayKey(null);
    setError("");
  }, []);

  /* ------------------------------------------------------------------ */
  /* Ошибки и остановка                                                  */
  /* ------------------------------------------------------------------ */

  /**
   * Единая точка сообщения об ошибке: причина показывается и в модалке, и в
   * toast (окно может быть закрыто, а ответ — нет).
   */
  const reportFailure = useCallback((message: string, fallback: string) => {
    const text = message || fallback;
    setError(text);
    toast.error(text);
  }, []);

  /**
   * Остановка: рвём текущий запрос, гасим автозапуск плееров и глушим звук —
   * как `stopStreaming` в чате. При закрытии окна вызывается тоже, поэтому при
   * повторном открытии озвученные страницы не стартуют все сразу.
   */
  const stop = useCallback(() => {
    runIdRef.current += 1;
    stoppedRef.current = true;
    abortRef.current?.abort();
    abortRef.current = null;
    setIsAnalyzing(false);
    setAnalyzeProgress(null);
    setSpeakingId(null);
    setAutoPlayKey(null);
    announceStopSpeech();
  }, []);

  /** При размонтировании (выход из чата) незакрытые запросы гасятся. */
  useEffect(() => {
    return () => {
      stoppedRef.current = true;
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  /* ------------------------------------------------------------------ */
  /* Анализ страниц (manga-analyze)                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Разбирает все страницы, до которых ещё не дошли: батчи по
   * `ANALYZE_BATCH_SIZE` уходят последовательно, одним нажатием кнопки.
   * Возвращает `true`, если ни один батч не упал.
   */
  const analyzePages = useCallback(async (): Promise<boolean> => {
    if (runningRef.current) return false;

    const queue = pagesRef.current.filter((p) => p.status !== "ready");
    if (!queue.length) return true;

    const batches = chunk(queue, ANALYZE_BATCH_SIZE);
    runningRef.current = true;
    stoppedRef.current = false;
    setIsAnalyzing(true);
    setError("");
    setAnalyzeProgress({ batch: 1, batches: batches.length, total: queue.length, done: 0 });

    const runId = (runIdRef.current += 1);
    const controller = new AbortController();
    abortRef.current = controller;

    const queuedIds = new Set(queue.map((p) => p.id));
    // UI сразу показывает, что страницы в работе; сжатие сканов идёт следом.
    updatePages((prev) => prev.map((p) => (queuedIds.has(p.id) ? { ...p, status: "analyzing" } : p)));

    const failures: string[] = [];
    let done = 0;

    try {
      for (let i = 0; i < batches.length; i += 1) {
        if (stoppedRef.current || controller.signal.aborted) break;

        const batch = batches[i];
        const batchIds = batch.map((p) => p.id);
        setAnalyzeProgress({ batch: i + 1, batches: batches.length, total: queue.length, done });

        try {
          // Страницы уменьшаются до 1600 px и пережимаются: батч из 5 сканов по
          // 10 МБ в base64 — это десятки мегабайт в одном запросе, он не проходит
          // по лимитам модели и edge-функции.
          const images = await Promise.all(batch.map((p) => toPageDataURL(p.file)));
          if (stoppedRef.current || controller.signal.aborted) break;

          const data = await edgeJson<{ pages?: AnalyzePageResult[] }>(
            MANGA_ANALYZE_FN,
            { images },
            controller.signal
          );
          const result: AnalyzePageResult[] = Array.isArray(data?.pages) ? data.pages : [];

          // Ответ раскладывается по страницам батча в том же порядке.
          updatePages((prev) =>
            prev.map((p) => {
              const index = batchIds.indexOf(p.id);
              if (index < 0) return p;
              return applyAnalyzeResult(p, result[index]);
            })
          );
          done += batch.length;
        } catch (e) {
          if (isAbortError(e, controller.signal)) break;
          console.error("manga-analyze error:", e);
          const reason = e instanceof Error ? e.message : "Ошибка анализа";
          failures.push(reason);
          reportFailure(
            batches.length > 1
              ? `Батч ${i + 1} из ${batches.length}: ${reason}`
              : reason,
            "Ошибка анализа страниц"
          );
          // Страницы этого батча возвращаются в очередь — их можно отправить снова.
          updatePages((prev) =>
            prev.map((p) => (batchIds.includes(p.id) ? { ...p, status: "new" } : p))
          );
        }
      }
    } finally {
      // Всё, что осталось «в анализе» (остановка или сбой), возвращается в `new`.
      updatePages((prev) =>
        prev.map((p) => (queuedIds.has(p.id) && p.status === "analyzing" ? { ...p, status: "new" } : p))
      );
      if (runIdRef.current === runId) {
        setIsAnalyzing(false);
        setAnalyzeProgress(null);
        abortRef.current = null;
        runningRef.current = false;
        if (stoppedRef.current) setError("");
      }
    }

    // Остановку пользователем успехом не считаем: часть батчей не ушла.
    return failures.length === 0 && !stoppedRef.current;
  }, [reportFailure, updatePages]);

  /* ------------------------------------------------------------------ */
  /* Озвучка кадра (dialog-tts)                                          */
  /* ------------------------------------------------------------------ */

  /** Запрашивает озвучку одной страницы и кладёт audio-URL в состояние. */
  const requestVoice = useCallback(async (page: MangaPage, plan: TranscriptPlan, signal: AbortSignal) => {
    const blob = await edgeBlob(DIALOG_TTS_FN, { transcript: plan.text, voices: voicesRef.current }, signal);
    const url = URL.createObjectURL(blob);
    let released = false;
    updatePages((prev) =>
      prev.map((p) => {
        if (p.id !== page.id) return p;
        if (p.audio && p.audio !== url) {
          URL.revokeObjectURL(p.audio);
          released = true;
        }
        return { ...p, audio: url, voiceError: undefined };
      })
    );
    // Страницу могли удалить, пока шёл запрос: освобождаем URL сразу.
    if (!released && !pagesRef.current.some((p) => p.id === page.id)) URL.revokeObjectURL(url);
    setAutoPlayKey(`${page.id}:${url}`);
    return url;
  }, [updatePages]);

  /**
   * «Озвучить кадр»: проверка лимитов до запроса, сам запрос с `signal`,
   * понятная причина при отказе. Возвращает `true`, если озвучка готова.
   */
  const speakPage = useCallback(
    async (pageId: string): Promise<boolean> => {
      const page = pagesRef.current.find((p) => p.id === pageId);
      if (!page) return false;

      const plan = planTranscript(page.transcript ?? "");
      if (plan.problems.length) {
        // Сервер на таком тексте ответит 400 — показываем причину заранее.
        setError(plan.problems[0]);
        return false;
      }

      stoppedRef.current = false;
      setSpeakingId(page.id);
      setError("");
      announceStopSpeech();

      const runId = (runIdRef.current += 1);
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        await requestVoice(page, plan, controller.signal);
        return true;
      } catch (e) {
        if (isAbortError(e, controller.signal)) {
          setError("");
          return false;
        }
        console.error("dialog-tts error:", e);
        const reason = e instanceof Error ? e.message : "Ошибка озвучки";
        updatePages((prev) => prev.map((p) => (p.id === page.id ? { ...p, voiceError: reason } : p)));
        reportFailure(reason, "Ошибка озвучки");
        return false;
      } finally {
        if (runIdRef.current === runId) {
          setSpeakingId(null);
          abortRef.current = null;
        }
      }
    },
    [reportFailure, requestVoice, updatePages]
  );

  /**
   * «Озвучить всё»: страницы озвучиваются по очереди, сбой одной не рвёт
   * остальные — неудачные помечаются, а итог показывается пользователю.
   * Страницы, которые `dialog-tts` заведомо не примет (пустые реплики, больше
   * 8 персонажей), не уходят на сервер, но получают ту же пометку, что и упавшие.
   */
  const speakAll = useCallback(async (): Promise<boolean> => {
    const queue = pagesRef.current.filter((p) => p.status === "ready");
    if (!queue.length) return false;

    stoppedRef.current = false;
    setError("");
    announceStopSpeech();

    const runId = (runIdRef.current += 1);
    const controller = new AbortController();
    abortRef.current = controller;
    const failed: { page: MangaPage; reason: string }[] = [];
    let stopped = false;

    try {
      for (const page of queue) {
        if (stoppedRef.current || controller.signal.aborted) {
          stopped = true;
          break;
        }

        const plan = planTranscript(page.transcript ?? "");
        if (plan.problems.length) {
          failed.push({ page, reason: plan.problems[0] });
          updatePages((prev) =>
            prev.map((p) => (p.id === page.id ? { ...p, voiceError: plan.problems[0] } : p))
          );
          continue;
        }

        setSpeakingId(page.id);
        try {
          await requestVoice(page, plan, controller.signal);
        } catch (e) {
          if (isAbortError(e, controller.signal)) {
            stopped = true;
            break;
          }
          console.error("dialog-tts error:", e);
          const reason = e instanceof Error ? e.message : "Ошибка озвучки";
          failed.push({ page, reason });
          updatePages((prev) => prev.map((p) => (p.id === page.id ? { ...p, voiceError: reason } : p)));
        }
      }
    } finally {
      if (runIdRef.current === runId) {
        setSpeakingId(null);
        abortRef.current = null;
      }
    }

    if (stopped || stoppedRef.current || controller.signal.aborted) {
      setError("");
      return false;
    }

    if (failed.length) {
      const indexById = new Map(queue.map((p, i) => [p.id, i + 1]));
      const first = failed[0];
      const where = indexById.get(first.page.id);
      const message =
        failed.length === 1
          ? `Не озвучена страница ${where ?? ""}: ${first.reason}`.replace(" : ", ": ")
          : `Не озвучено страниц: ${failed.length}. ${first.reason}`;
      reportFailure(message, "Ошибка озвучки");
      return false;
    }

    return true;
  }, [reportFailure, requestVoice, updatePages]);

  /* ------------------------------------------------------------------ */
  /* Производные данные для UI                                           */
  /* ------------------------------------------------------------------ */

  /** Все персонажи главы: номера и имена из транскриптов готовых страниц. */
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
  /** Любой запрос в полёте — можно показывать кнопку «Стоп». */
  const isRequesting = isAnalyzing || speakingId !== null;

  return {
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
    defaultVoiceFor,
    addFiles,
    removePage,
    setTranscript,
    setVoice,
    analyzePages,
    speakPage,
    speakAll,
    stop,
    reset,
  };
}

export type UseMangaVoice = ReturnType<typeof useMangaVoice>;

/** Ошибка запроса, которую показали пользователю (для тестов и логов). */
export { EdgeRequestError };
