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
 *    `apikey`, тот же JSON-контракт) и обязательно принимает `signal`; у него же
 *    таймаут на установку ответа и один повтор на сетевой сбой — «Failed to
 *    fetch» больше не показывается пользователю как есть;
 *    тело `manga-analyze` планируется по фактическому размеру страниц
 *    (`prepareAnalyzePayload` + `planAnalyzeBatches`), поэтому батч не
 *    раздувается до десятков мегабайт и не обрывается на плохой сети;
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
 * запросов и ответов прежний. Единственное добавление — поле `model` в теле
 * `manga-analyze`: так работает смена api (какая модель разбирает страницы).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { EdgeRequestError, edgeBlob, edgeJson, isAbortError } from "@/lib/edgeAuth";
import { useAiProvider } from "@/hooks/useAiProvider";
import { useUserApiKeys } from "@/hooks/useUserApiKeys";
import { syncActiveKeyFromHeaders } from "@/lib/aiKeySync";
import {
  classifyEdgeFailure,
  classifyPrepareFailure,
  dialogCheckFailure,
  failureTitle,
  isMangaFailure,
  mangaFailure,
  type MangaFailure,
} from "@/lib/mangaRequestError";
import { announceStopSpeech } from "@/lib/speechEvents";
import {
  ANALYZE_BATCH_SIZE,
  ANALYZE_PAYLOAD_BUDGET,
  filterPageFiles,
  formatRejections,
  planAnalyzeBatches,
  prepareAnalyzePayload,
  toPageDataURL,
} from "@/lib/mangaPages";
import {
  MAX_TTS_SPEAKERS,
  TTS_VOICES,
  defaultVoiceFor,
  formatTranscript,
  normalizeModelTranscript,
  planTranscript,
  type TranscriptPlan,
  type TtsVoice,
} from "@/lib/mangaTranscript";
import { hasStoredMangaApi, isMangaApi, loadMangaApi, saveMangaApi } from "@/lib/mangaApi";

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
  /** Почему озвучка этого кадра не удалась: «этап: причина» (пусто = всё хорошо). */
  voiceError?: string;
}

/** Фаза процесса — для кольца-прогресса и бейджа этапа в модалке. */
export type MangaPhase = "idle" | "preparing" | "analyzing" | "voicing";

/** Что происходит прямо сейчас: этап, процент и подпись. */
export interface MangaProgress {
  phase: MangaPhase;
  /** 0..100 — для кольца-прогресса. */
  percent: number;
  /** Подпись этапа: «Этап 2 из 5 · Сжатие страниц». */
  label: string;
  /** Детали: «Батч 2 из 3 · обработано 5 из 12 страниц». */
  detail?: string;
}

export type VoicesMap = Record<string, TtsVoice>;

/** Прогресс анализа: сколько страниц уже разобрано в текущем запуске. */
export interface AnalyzeProgress {
  /** true, пока страницы сжимаются в dataURL — тело запроса ещё не ушло. */
  preparing?: boolean;
  /** Номер текущего батча (1..batches). */
  batch: number;
  /** Сколько всего батчей в этом запуске. */
  batches: number;
  /** Сколько страниц ушло в обработку этим запуском. */
  total: number;
  /** Сколько из них уже разобрано. */
  done: number;
  /** Какое api разбирает этот запуск (имя из переключателя) — для строки процесса. */
  model?: string;
}

/** Номер этапа для бейджа: 1 — страницы, 2 — сжатие, 3 — анализ, 4 — озвучка, 5 — готово. */
export const MANGA_STEPS_TOTAL = 5;

const STEP_NAMES: Record<MangaPhase, string> = {
  idle: "Страницы добавлены",
  preparing: "Сжатие страниц",
  analyzing: "Анализ диалога",
  voicing: "Озвучка реплик",
};

const PHASE_STEP: Record<MangaPhase, number> = {
  idle: 1,
  preparing: 2,
  analyzing: 3,
  voicing: 4,
};

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

/**
 * Ответ модели → поля страницы.
 *
 * `transcript` сразу приводится к формату из промпта: только реплики
 * «Speaker 1: …» с пустой строкой между ними — описания сцены, «Рассказчик: …»
 * и markdown модель добавляет вопреки инструкциям, поэтому их вырезает
 * `normalizeModelTranscript`. `description` сохраняем (она держит стабильные
 * номера персонажей между страницами), но в диалоге не показываем.
 */
function applyAnalyzeResult(page: MangaPage, item: AnalyzePageResult | undefined): MangaPage {
  if (!item) return { ...page, status: "new" };
  const raw = item.transcript ?? "";
  return {
    ...page,
    status: "ready",
    description: item.description ?? "",
    transcript: normalizeModelTranscript(raw) || formatTranscript(raw),
    voiceError: undefined,
  };
}

/** Настройки хука озвучивателя. */
export interface UseMangaVoiceOptions {
  /**
   * Модель чата — берётся как api анализа, пока пользователь не выбрал своё в
   * окне манги: свой выбор сохраняется и дальше имеет приоритет.
   */
  preferredApi?: string;
}

export function useMangaVoice({ preferredApi }: UseMangaVoiceOptions = {}) {
  const [pages, setPages] = useState<MangaPage[]>([]);
  const [voices, setVoices] = useState<VoicesMap>(
    () => Object.fromEntries(TTS_VOICES.map((voice, i) => [String(i + 1), voice])) as VoicesMap
  );
  /**
   * Какое api разбирает страницы. Имя уходит в `manga-analyze` полем `model`,
   * а конкретную модель выбирает сервер — как в `chat`.
   */
  const [apiModel, setApiModelState] = useState<string>(() => loadMangaApi(preferredApi));
  /**
   * Провайдер (Lovable AI / Gemini API) и ключи пользователя — общие настройки
   * приложения: они уходят в тело каждого запроса манги так же, как в чате и
   * озвучке диалога, а сервер отвечает заголовком, какой ключ сработал.
   */
  const { provider } = useAiProvider();
  const { keys: userKeys, activeIndex: userKeyIndex, setActiveIndex } = useUserApiKeys();
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analyzeProgress, setAnalyzeProgress] = useState<AnalyzeProgress | null>(null);
  /** id страницы, которая озвучивается прямо сейчас. */
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  /** Последняя неудача целиком: этап, причина, код — для диагностики в UI. */
  const [failure, setFailure] = useState<MangaFailure | null>(null);
  /** Этап процесса для кольца-прогресса. */
  const [phase, setPhase] = useState<MangaPhase>("idle");
  /** Прогресс озвучки очереди («Озвучить всё»). */
  const [speakProgress, setSpeakProgress] = useState<{ done: number; total: number } | null>(null);
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
  /** Свежее api внутри цикла батчей — переключение во время запроса его не рвёт. */
  const apiModelRef = useRef(apiModel);
  apiModelRef.current = apiModel;
  const providerRef = useRef(provider);
  providerRef.current = provider;
  const userKeysRef = useRef(userKeys);
  userKeysRef.current = userKeys;
  const userKeyIndexRef = useRef(userKeyIndex);
  userKeyIndexRef.current = userKeyIndex;

  /**
   * Поля провайдера для тела запроса + синхронизация активного ключа по
   * заголовкам ответа (ротация при исчерпании квоты — как в `useChat`).
   */
  const aiRequestFields = useCallback(
    () => ({
      provider: providerRef.current,
      userKeys: userKeysRef.current,
      userKeyIndex: userKeyIndexRef.current,
    }),
    []
  );
  const onResponse = useCallback(
    (res: Response) => {
      syncActiveKeyFromHeaders(res.headers, setActiveIndex);
    },
    [setActiveIndex]
  );

  /**
   * Выбор api пользователем: неизвестное имя на сервер не уходит, а валидное
   * запоминается — при следующем открытии окна манги оно же и подставится.
   */
  const setApiModel = useCallback((id: string) => {
    if (!isMangaApi(id)) return;
    setApiModelState(id);
    saveMangaApi(id);
  }, []);

  // Пока своего сохранённого выбора нет, окно манги следует за моделью чата.
  useEffect(() => {
    if (hasStoredMangaApi() || !isMangaApi(preferredApi)) return;
    setApiModelState((prev) => (prev === preferredApi ? prev : preferredApi));
  }, [preferredApi]);

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
    setFailure(null);
    setPhase("idle");
    setSpeakProgress(null);
  }, []);

  /* ------------------------------------------------------------------ */
  /* Ошибки и остановка                                                  */
  /* ------------------------------------------------------------------ */

/**
   * Единая точка сообщения об ошибке: полный текст («Ошибка запроса api
   * (этап: причина)») уходит в плашку и в toast — окно может быть закрыто,
   * а ответ нет. Этап и причина сохраняются отдельно для диагностики в UI.
   */
  const reportFailure = useCallback((next: MangaFailure) => {
    setFailure(next);
    setError(next.message);
    toast.error(next.message);
    return next;
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
    setPhase("idle");
    setSpeakProgress(null);
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

    runningRef.current = true;
    stoppedRef.current = false;
    // Одна модель на весь запуск: смена api посреди главы не должна смешивать
    // нумерацию персонажей между батчами.
    const model = apiModelRef.current;
    setIsAnalyzing(true);
    setError("");
    setFailure(null);
    setPhase("preparing");
    setAnalyzeProgress({ preparing: true, batch: 1, batches: 1, total: queue.length, done: 0, model });

    const runId = (runIdRef.current += 1);
    const controller = new AbortController();
    abortRef.current = controller;

    const queuedIds = new Set(queue.map((p) => p.id));
    // UI сразу показывает, что страницы в работе; тяжёлая подготовка тела идёт следом.
    updatePages((prev) => prev.map((p) => (queuedIds.has(p.id) ? { ...p, status: "analyzing" } : p)));

    const failures: string[] = [];
    let done = 0;

    try {
      // Этап 2 — сжатие: страницы уменьшаются до 1600 px и пережимаются, батчи
      // режутся по фактическому размеру payload, а не «на глаз».
      const payload = await prepareAnalyzePayload(queue);
      if (stoppedRef.current || controller.signal.aborted) return failures.length === 0;

      const batches = planAnalyzeBatches(payload);
      setPhase("analyzing");

      for (let i = 0; i < batches.length; i += 1) {
        if (stoppedRef.current || controller.signal.aborted) break;

        const batch = batches[i];
        const batchIds = batch.pages.map((p) => p.id);
        setAnalyzeProgress({ batch: i + 1, batches: batches.length, total: queue.length, done, model });

        try {
          // Этап 3 — запрос к api анализа манги. Поле `model` — имя api из
          // переключателя: сервер сам решает, какую модель дёрнуть и на какую
          // сменить её при лимите (`toAiModel` + `shouldSwitchApi`).
          const data = await edgeJson<{ pages?: AnalyzePageResult[] }>(
            MANGA_ANALYZE_FN,
            { images: batch.images, model, ...aiRequestFields() },
            controller.signal,
            { onResponse }
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
          done += batch.pages.length;
        } catch (e) {
          if (isAbortError(e, controller.signal)) break;
          console.error("manga-analyze error:", e);
          const failure = classifyEdgeFailure(e, "analyze-api", "сервер не вернул страницы");
          failures.push(failure.message);
          reportFailure(
            batches.length > 1
              ? mangaFailure(failure.stage, `батч ${i + 1} из ${batches.length} — ${failure.reason}`, failure.status)
              : failure
          );
          // Страницы этого батча возвращаются в очередь — их можно отправить снова.
          updatePages((prev) => prev.map((p) => (batchIds.includes(p.id) ? { ...p, status: "new" } : p)));
        }
      }
    } catch (e) {
      // Этап 1–2: чтение файла или сжатие — до сети дело не дошло.
      if (!isAbortError(e, controller.signal)) {
        console.error("manga-analyze prepare error:", e);
        const failure = classifyPrepareFailure(e, queue[0]?.file?.name);
        failures.push(failure.message);
        reportFailure(failure);
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
        setPhase("idle");
        if (stoppedRef.current) {
          setError("");
          setFailure(null);
        }
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
    setPhase("voicing");
    let blob: Blob;
    try {
      // Этап 4 — запрос к api озвучки: нормализованный диалог + карта голосов.
      blob = await edgeBlob(
        DIALOG_TTS_FN,
        { transcript: plan.text, voices: voicesRef.current, ...aiRequestFields() },
        signal,
        { onResponse }
      );
    } catch (e) {
      if (isAbortError(e, signal)) throw e;
      // Сервер ответил, но вместо аудио пришёл мусор — это этап обработки аудио.
      throw classifyEdgeFailure(e, "tts-api", "сервер не вернул аудио");
    }

    let url: string;
    try {
      url = URL.createObjectURL(blob);
    } catch (e) {
      throw mangaFailure("tts-decode", e instanceof Error ? e.message : "браузер не смог создать ссылку на аудио");
    }
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
        // Сервер на таком тексте ответит 400 — показываем причину заранее и
        // честно называем этап: это проверка реплик, а не сбой запроса.
        const failure = dialogCheckFailure(plan.problems[0]);
        updatePages((prev) => prev.map((p) => (p.id === page.id ? { ...p, voiceError: failureTitle(failure) } : p)));
        reportFailure(failure);
        return false;
      }

      stoppedRef.current = false;
      setSpeakingId(page.id);
      setError("");
      setFailure(null);
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
          setFailure(null);
          return false;
        }
        console.error("dialog-tts error:", e);
        const failure = isMangaFailure(e) ? e : classifyEdgeFailure(e, "tts-api", "озвучка не удалась");
        updatePages((prev) => prev.map((p) => (p.id === page.id ? { ...p, voiceError: failureTitle(failure) } : p)));
        reportFailure(failure);
        return false;
      } finally {
        if (runIdRef.current === runId) {
          setSpeakingId(null);
          abortRef.current = null;
          setPhase("idle");
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
    setFailure(null);
    setPhase("voicing");
    announceStopSpeech();

    const runId = (runIdRef.current += 1);
    const controller = new AbortController();
    abortRef.current = controller;
    const failed: { page: MangaPage; failure: MangaFailure }[] = [];
    let stopped = false;
    let voiced = 0;

    try {
      for (let i = 0; i < queue.length; i += 1) {
        const page = queue[i];
        if (stoppedRef.current || controller.signal.aborted) {
          stopped = true;
          break;
        }

        const plan = planTranscript(page.transcript ?? "");
        if (plan.problems.length) {
          // Реплики не примет dialog-tts: запрос не уходит, причина — на кадре.
          const failure = dialogCheckFailure(plan.problems[0]);
          failed.push({ page, failure });
          updatePages((prev) =>
            prev.map((p) => (p.id === page.id ? { ...p, voiceError: failureTitle(failure) } : p))
          );
          setSpeakProgress({ done: i + 1, total: queue.length });
          continue;
        }

        setSpeakingId(page.id);
        setSpeakProgress({ done: i, total: queue.length });
        try {
          await requestVoice(page, plan, controller.signal);
          voiced += 1;
        } catch (e) {
          if (isAbortError(e, controller.signal)) {
            stopped = true;
            break;
          }
          console.error("dialog-tts error:", e);
          const failure = isMangaFailure(e) ? e : classifyEdgeFailure(e, "tts-api", "озвучка не удалась");
          failed.push({ page, failure });
          updatePages((prev) => prev.map((p) => (p.id === page.id ? { ...p, voiceError: failureTitle(failure) } : p)));
        }
        setSpeakProgress({ done: i + 1, total: queue.length });
      }
    } finally {
      if (runIdRef.current === runId) {
        setSpeakingId(null);
        abortRef.current = null;
        setSpeakProgress(null);
        setPhase("idle");
      }
    }

    if (stopped || stoppedRef.current || controller.signal.aborted) {
      setError("");
      setFailure(null);
      return false;
    }

    if (failed.length) {
      const indexById = new Map(queue.map((p, i) => [p.id, i + 1]));
      const first = failed[0];
      const where = indexById.get(first.page.id);
      const summary =
        failed.length === 1
          ? mangaFailure(first.failure.stage, `страница ${where} — ${first.failure.reason}`, first.failure.status)
          : mangaFailure(
              first.failure.stage,
              `${failed.length} страницы из ${queue.length} не озвучены; первая — страница ${where}: ${first.failure.reason}`,
              first.failure.status
            );
      reportFailure(summary);
      return false;
    }

    return voiced > 0;
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

  /**
   * Что происходит сейчас — для кольца-прогресса и бейджа этапа.
   * Проценты считаются от фактической работы: подготовка страниц — 10%,
   * анализ распределяется по батчам, озвучка — по страницам очереди.
   */
  const progress = useMemo<MangaProgress>(() => {
    const step = PHASE_STEP[phase];
    const label = `Этап ${step} из ${MANGA_STEPS_TOTAL} · ${STEP_NAMES[phase]}`;

    if (phase === "preparing") {
      return { phase, percent: 10, label, detail: "готовим изображения к отправке" };
    }

    if (phase === "analyzing" && analyzeProgress) {
      const perBatch = 80 / Math.max(1, analyzeProgress.batches);
      const percent = Math.min(90, Math.round(10 + perBatch * (analyzeProgress.batch - 1) + 4));
      return {
        phase,
        percent,
        label,
        detail: `Батч ${analyzeProgress.batch} из ${analyzeProgress.batches} · обработано ${analyzeProgress.done} из ${analyzeProgress.total} страниц`,
      };
    }

    if (phase === "voicing") {
      const total = speakProgress?.total ?? 0;
      const done = speakProgress?.done ?? 0;
      const percent = total > 0 ? Math.min(99, Math.round(10 + (85 * done) / total)) : 55;
      return {
        phase,
        percent,
        label,
        detail: total > 1 ? `Озвучено ${done} из ${total} страниц` : "синтезируем реплики",
      };
    }

    const percent = pendingCount === 0 && readyPages.length > 0 ? 100 : Math.round((readyPages.length / Math.max(1, pages.length)) * 100);
    return {
      phase,
      percent,
      label: pages.length === 0 ? `Этап ${step} из ${MANGA_STEPS_TOTAL} · Добавьте страницы` : label,
      detail: pendingCount ? `Осталось разобрать: ${pendingCount}` : readyPages.length ? "Всё готово" : undefined,
    };
  }, [analyzeProgress, pages.length, pendingCount, phase, readyPages.length, speakProgress]);

  return {
    pages,
    voices,
    apiModel,
    setApiModel,
    chapter,
    readyPages,
    pendingCount,
    isAnalyzing,
    analyzeProgress,
    speakingId,
    isRequesting,
    error,
    failure,
    phase,
    progress,
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
