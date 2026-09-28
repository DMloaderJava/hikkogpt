/**
 * Студия видео-историй: состояние пяти этапов и все запросы фичи.
 *
 * Хук построен по тому же методу, что `useChat.sendMessage` и `useMangaVoice`:
 * request-логика живёт здесь, а не в компоненте, каждый запрос уходит через
 * общий `edgeRequest` (заголовки, таймаут, один повтор) и обязательно принимает
 * `signal`, отмена не показывается ошибкой, а причина отказа доезжает до
 * пользователя целиком — «Ошибка запроса api (этап: причина)».
 *
 * Этапы (из задания):
 * 1. Материалы — слайды: drag-and-drop, сортировка, превью;
 * 2. Персонажи и голоса — Speaker 1 (Charon) и Speaker 2 (Kore) по умолчанию,
 *    у каждого свой голос и «представление / контекст персонажа», который
 *    уходит в TTS полем `styles` и влияет на интонации;
 * 3. Сценарий по слайдам — реплика и говорящий на каждый слайд (связка
 *    «Слайд 1 → Speaker 1, Слайд 2 → Speaker 2» предлагается сама);
 * 4. Генерация и сборка — озвучка каждого слайда, расчёт таймингов от реальной
 *    длительности дорожек и сведение в один таймлайн;
 * 5. Готовое видео — плеер, субтитры, скачивание файла и отправка в чат.
 *
 * Видео собирается в браузере (`videoRecorder`): никаких внешних очередей
 * рендеринга, поэтому длительность слайда равна длительности его реплики.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { edgeBlob, isAbortError } from "@/lib/edgeAuth";
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
import { filterPageFiles, formatRejections } from "@/lib/mangaPages";
import { DIALOG_TTS_FN } from "@/hooks/useMangaVoice";
import {
  MAX_STORY_SLIDES,
  buildTtsRequest,
  defaultCharacters,
  formatClock,
  generationPercent,
  isTtsVoice,
  makeSlideId,
  planTimeline,
  totalSeconds,
  validateScript,
  type CharacterProfile,
  type ScriptIssue,
  type SlideScript,
  type StoryFrame,
  type StorySlide,
} from "@/lib/videoStory";
import {
  browserDeps,
  renderStoryVideo,
  type AudioBufferLike,
  type RecorderDeps,
  type RecorderSlide,
  type RenderedVideo,
} from "@/lib/videoRecorder";

/** Этап студии: 1 — материалы … 5 — готовое видео. */
export type StoryStage = 1 | 2 | 3 | 4 | 5;
export const STORY_STEPS_TOTAL = 5;

export const STAGE_TITLES: Record<StoryStage, string> = {
  1: "Материалы (слайды)",
  2: "Персонажи и голоса",
  3: "Сценарий по слайдам",
  4: "Генерация и сборка",
  5: "Готовое видео",
};

/** Что происходит прямо сейчас — для орбитальной анимации и бейджа этапа. */
export type StoryPhase = "idle" | "voicing" | "assembling" | "rendering";

export interface StoryProgress {
  phase: StoryPhase;
  /** 0..100 — для кольца-прогресса. */
  percent: number;
  /** Подпись: «Этап 4 из 5 · Озвучка слайдов». */
  label: string;
  /** Детали: «Слайд 2 из 5 · Speaker 2 · Kore». */
  detail?: string;
}

/** Дорожка озвучки слайда. */
export interface SlideTrack {
  /** Object URL аудио — для предпрослушивания. */
  url: string;
  /** Реальная длительность в секундах: от неё считается показ слайда. */
  seconds: number;
  /** Расшифровка не удалась (дорожка всё равно может быть сыграна). */
  decoded?: boolean;
}

/** Почему слайд не готов: текст вместо кода ошибки. */
export interface SlideIssue {
  slideId: string;
  reason: string;
}

const PHASE_STEP: Record<StoryPhase, number> = {
  idle: 1,
  voicing: 4,
  assembling: 4,
  rendering: 4,
};

const PHASE_NAMES: Record<StoryPhase, string> = {
  idle: "Ожидание",
  voicing: "Озвучка слайдов",
  assembling: "Сведение таймлайна",
  rendering: "Сборка видео",
};

/** Доли общего прогресса: озвучка → загрузка картинок → запись видео. */
const VOICE_SHARE = 0.5;
const LOAD_SHARE = 0.1;

export interface UseVideoStoryOptions {
  /** Отправить результат в чат: текст сообщения + постер (dataURL). */
  onShare?: (payload: { text: string; images: string[] }) => void;
  /** Зависимости движка записи: в браузере настоящие, в тестах подставные. */
  deps?: RecorderDeps;
  /** Заголовок истории — попадает в имя файла и на первый кадр. */
  title?: string;
}

let storySeq = 0;

export function useVideoStory({ onShare, deps = browserDeps, title }: UseVideoStoryOptions = {}) {
  const [stage, setStage] = useState<StoryStage>(1);
  const [slides, setSlides] = useState<StorySlide[]>([]);
  const [characters, setCharacters] = useState<CharacterProfile[]>(() => defaultCharacters());
  /** Реплика и говорящий каждого слайда (ключ — id слайда). */
  const [script, setScript] = useState<Record<string, SlideScript>>({});
  /** Готовые дорожки по id слайда. */
  const [tracks, setTracks] = useState<Record<string, SlideTrack>>({});
  /** Почему конкретный слайд не озвучен. */
  const [slideIssues, setSlideIssues] = useState<SlideIssue[]>([]);
  const [phase, setPhase] = useState<StoryPhase>("idle");
  const [percent, setPercent] = useState(0);
  const [detail, setDetail] = useState<string | undefined>(undefined);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState("");
  const [failure, setFailure] = useState<MangaFailure | null>(null);
  const [video, setVideo] = useState<RenderedVideo | null>(null);
  /**
   * Таймлайн собранного видео: по нему плеер показывает субтитры и переключает
   * слайды (начало каждого слайда = конец предыдущей реплики).
   */
  const [frames, setFrames] = useState<StoryFrame[]>([]);
  /** Object URL готового видео — для плеера. */
  const [videoUrl, setVideoUrl] = useState("");
  /** Слайд, который сейчас предпрослушивается. */
  const [previewId, setPreviewId] = useState<string | null>(null);

  /**
   * Ref'ы для длинных циклов (озвучка очереди, сборка): состояние читается
   * синхронно, поэтому «поправить реплику → сразу собрать» не видит устаревший
   * снимок. Тот же приём, что `pagesRef` в озвучивателе манги.
   */
  const slidesRef = useRef(slides);
  slidesRef.current = slides;
  const scriptRef = useRef(script);
  scriptRef.current = script;
  const charactersRef = useRef(characters);
  charactersRef.current = characters;
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;
  const framesRef = useRef(frames);
  framesRef.current = frames;

  /**
   * Провайдер (Lovable AI / Gemini API) и ключи пользователя — общие настройки
   * приложения: озвучка слайдов уходит тем же `dialog-tts`, что и в чате,
   * поэтому поля провайдера и ротация активного ключа работают так же.
   */
  const { provider } = useAiProvider();
  const { keys: userKeys, activeIndex: userKeyIndex, setActiveIndex } = useUserApiKeys();
  const providerRef = useRef(provider);
  providerRef.current = provider;
  const userKeysRef = useRef(userKeys);
  userKeysRef.current = userKeys;
  const userKeyIndexRef = useRef(userKeyIndex);
  userKeyIndexRef.current = userKeyIndex;

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

  const runIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const stoppedRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const videoUrlRef = useRef("");

  /* ------------------------------------------------------------------ */
  /* Уборка                                                              */
  /* ------------------------------------------------------------------ */

  const revokeTrack = useCallback((track?: SlideTrack) => {
    if (!track) return;
    try {
      URL.revokeObjectURL(track.url);
    } catch {
      // URL уже отозван.
    }
  }, []);

  const revokeSlide = useCallback((slide: Pick<StorySlide, "url">) => {
    try {
      URL.revokeObjectURL(slide.url);
    } catch {
      // URL уже отозван.
    }
  }, []);

  const stopPreview = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
      audioRef.current = null;
    }
    setPreviewId(null);
  }, []);

  /**
   * Сбрасывает собранное видео: история изменилась (слайд удалён, порядок
   * переставлен, голос или характер правились), поэтому прежний файл ей больше
   * не соответствует. Object URL отзываем сразу, чтобы не копить память.
   */
  const clearVideo = useCallback(() => {
    if (videoUrlRef.current) {
      try {
        URL.revokeObjectURL(videoUrlRef.current);
      } catch {
        // URL уже отозван.
      }
      videoUrlRef.current = "";
    }
    setVideoUrl("");
    setVideo(null);
    setFrames([]);
  }, []);

  // Размонтирование: гасим незакрытый запрос, предпросмотр и все object URL.
  useEffect(
    () => () => {
      stoppedRef.current = true;
      abortRef.current?.abort();
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      for (const track of Object.values(tracksRef.current)) revokeTrack(track);
      for (const slide of slidesRef.current) revokeSlide(slide);
      if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
    },
    [revokeSlide, revokeTrack]
  );

  const reportFailure = useCallback((next: MangaFailure) => {
    setFailure(next);
    setError(next.message);
    // Окно студии может быть закрыто или на другом этапе — дублируем в toast.
    toast.error(failureTitle(next));
  }, []);

  /* ------------------------------------------------------------------ */
  /* Этап 1: материалы                                                   */
  /* ------------------------------------------------------------------ */

  /**
   * Добавляет слайды.
   *
   * Формат и размер проверяются тем же `filterPageFiles`, что и страницы манги
   * (PNG/JPEG/WebP до 10 МБ), а отказ приходит понятным текстом. Говорящий
   * назначается по порядку: слайд 1 → Speaker 1, слайд 2 → Speaker 2 — как в
   * задании, дальше это можно поменять на этапе сценария.
   */
  const addFiles = useCallback(
    (list: FileList | File[] | null) => {
      const { accepted, rejected } = filterPageFiles(list);
      // Причины копим: за один раз может не пройти и формат, и предел слайдов.
      const notices: string[] = [];
      if (rejected.length) {
        const reason = formatRejections(rejected);
        notices.push(reason);
        toast.error(reason);
      }

      const room = Math.max(0, MAX_STORY_SLIDES - slidesRef.current.length);
      const taken = accepted.slice(0, room);
      if (accepted.length > taken.length) {
        const reason = `В историю помещается ${MAX_STORY_SLIDES} слайдов — добавлено ${taken.length}, остальные пропущены`;
        notices.push(reason);
        toast.error(reason);
      }
      if (!taken.length) {
        setError(notices.join("; "));
        return 0;
      }

      const start = slidesRef.current.length;
      const speakerCount = Math.max(1, charactersRef.current.length);
      const nextSlides: StorySlide[] = [];
      const nextScript: Record<string, SlideScript> = {};

      taken.forEach((file, index) => {
        storySeq += 1;
        const id = makeSlideId();
        let url = "";
        try {
          url = URL.createObjectURL(file);
        } catch {
          // Без превью слайд бесполезен — сообщаем и пропускаем файл.
          notices.push(`Не удалось показать превью файла ${file.name}`);
          toast.error(`Не удалось показать превью файла ${file.name}`);
          return;
        }
        nextSlides.push({ id, file, url });
        // Чередование говорящих: 1, 2, 1, 2…
        const speaker = charactersRef.current[(start + index) % speakerCount]?.speaker ?? 1;
        nextScript[id] = { slideId: id, speaker, text: "" };
      });

      if (!nextSlides.length) {
        setError(notices.join("; "));
        return 0;
      }
      slidesRef.current = [...slidesRef.current, ...nextSlides];
      setSlides(slidesRef.current);
      setScript((prev) => ({ ...prev, ...nextScript }));
      // Материалы изменились — прежний файл истории больше не соответствует.
      clearVideo();
      setError(notices.join("; "));
      return nextSlides.length;
    },
    [clearVideo]
  );

  /** Убирает слайд вместе с его превью, дорожкой и репликой. */
  const removeSlide = useCallback(
    (slideId: string) => {
      const slide = slidesRef.current.find((item) => item.id === slideId);
      if (!slide) return;
      stopPreview();
      revokeSlide(slide);
      revokeTrack(tracksRef.current[slideId]);
      const rest = slidesRef.current.filter((item) => item.id !== slideId);
      slidesRef.current = rest;
      setSlides(rest);
      setScript((prev) => {
        const next = { ...prev };
        delete next[slideId];
        return next;
      });
      setTracks((prev) => {
        const next = { ...prev };
        delete next[slideId];
        return next;
      });
      setSlideIssues((prev) => prev.filter((item) => item.slideId !== slideId));
      // История изменилась — собранное видео ей больше не соответствует.
      clearVideo();
    },
    [clearVideo, revokeSlide, revokeTrack, stopPreview]
  );

  /**
   * Переставляет слайд (drag-and-drop или стрелки сортировки).
   * Реплики и дорожки привязаны к id, поэтому едут вместе со слайдом.
   */
  const moveSlide = useCallback((from: number, to: number) => {
    const list = slidesRef.current;
    if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return;
    const next = [...list];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    slidesRef.current = next;
    setSlides(next);
    // Готовое видео собрано из прежнего порядка — сбрасываем результат,
    // дорожки озвучки при этом остаются (они привязаны к id слайда).
    clearVideo();
    setStage((prev) => (prev === 5 ? 3 : prev));
  }, [clearVideo]);

  /* ------------------------------------------------------------------ */
  /* Этап 2: персонажи и голоса                                          */
  /* ------------------------------------------------------------------ */

  /** Правит профиль говорящего: голос, имя и «представление / контекст». */
  const setCharacter = useCallback((speaker: number, patch: Partial<Omit<CharacterProfile, "speaker">>) => {
    const nextList = charactersRef.current.map((character) => {
        if (character.speaker !== speaker) return character;
        const next = { ...character, ...patch };
        // Голос — только из списка, который примет dialog-tts.
        if (patch.voice !== undefined && !isTtsVoice(patch.voice)) next.voice = character.voice;
        next.context = (next.context ?? "").slice(0, 300);
        next.name = (next.name ?? "").slice(0, 40);
        return next;
    });
    charactersRef.current = nextList;
    setCharacters(nextList);
    // Готовое видео озвучено прежним голосом — сбрасываем результат.
    clearVideo();
  }, [clearVideo]);

  /** Добавляет говорящего (не больше, чем примет `dialog-tts`). */
  const addCharacter = useCallback(() => {
    const existing = charactersRef.current.map((character) => character.speaker);
    const speaker = existing.length + 1;
    if (existing.includes(speaker) || speaker > 8) return false;
    const voicePool = ["Charon", "Kore", "Puck", "Aoede", "Fenrir", "Leda", "Zephyr", "Orus"] as const;
    const voice = voicePool.find((item) => !charactersRef.current.some((c) => c.voice === item)) ?? voicePool[existing.length % voicePool.length];
    const nextList = [...charactersRef.current, { speaker, voice, name: `Speaker ${speaker}`, context: "" }];
    // Ref обновляем сразу: два вызова подряд не должны видеть устаревший список.
    charactersRef.current = nextList;
    setCharacters(nextList);
    return true;
  }, []);

  /** Убирает говорящего; его слайды переходят к первому оставшемуся. */
  const removeCharacter = useCallback((speaker: number) => {
    const rest = charactersRef.current.filter((character) => character.speaker !== speaker);
    if (!rest.length) return false;
    charactersRef.current = rest;
    setCharacters(rest);
    setScript((prev) => {
      const next: Record<string, SlideScript> = {};
      for (const [key, item] of Object.entries(prev)) {
        next[key] = item.speaker === speaker ? { ...item, speaker: rest[0].speaker } : item;
      }
      return next;
    });
    return true;
  }, []);

  /* ------------------------------------------------------------------ */
  /* Этап 3: сценарий                                                    */
  /* ------------------------------------------------------------------ */

  /** Реплика слайда. Пустой текст помечается как проблема, а не как удаление. */
  const setSlideText = useCallback((slideId: string, text: string) => {
    setScript((prev) => ({
      ...prev,
      [slideId]: { slideId, speaker: prev[slideId]?.speaker ?? 1, text },
    }));
    // Текст изменился — прежняя дорожка ему не соответствует.
    setTracks((prev) => {
      if (!prev[slideId]) return prev;
      revokeTrack(prev[slideId]);
      const next = { ...prev };
      delete next[slideId];
      return next;
    });
    setSlideIssues((prev) => prev.filter((item) => item.slideId !== slideId));
  }, [revokeTrack]);

  /** Говорящий слайда: «Слайд 2 → Реплика Speaker 2». */
  const setSlideSpeaker = useCallback((slideId: string, speaker: number) => {
    if (!charactersRef.current.some((character) => character.speaker === speaker)) return;
    setScript((prev) => ({
      ...prev,
      [slideId]: { slideId, speaker, text: prev[slideId]?.text ?? "" },
    }));
    setTracks((prev) => {
      if (!prev[slideId]) return prev;
      revokeTrack(prev[slideId]);
      const next = { ...prev };
      delete next[slideId];
      return next;
    });
  }, [revokeTrack]);

  /** Расставить говорящих по порядку (1, 2, 1, 2…) — кнопка «как в макете». */
  const autoAssignSpeakers = useCallback(() => {
    const pool = charactersRef.current;
    if (!pool.length) return;
    setScript((prev) => {
      const next: Record<string, SlideScript> = {};
      slidesRef.current.forEach((slide, index) => {
        const speaker = pool[index % pool.length].speaker;
        next[slide.id] = { slideId: slide.id, speaker, text: prev[slide.id]?.text ?? "" };
      });
      return next;
    });
  }, []);

  /* ------------------------------------------------------------------ */
  /* Переходы между этапами                                              */
  /* ------------------------------------------------------------------ */

  /** Реплики в порядке слайдов — то, что уходит в озвучку и в таймлайн. */
  const scriptList = useMemo<SlideScript[]>(
    () => slides.map((slide) => script[slide.id]).filter((item): item is SlideScript => Boolean(item)),
    [script, slides]
  );

  const issues = useMemo<ScriptIssue[]>(
    () => validateScript(slides, scriptList, characters),
    [characters, scriptList, slides]
  );

  /** Можно ли перейти на этап: материалы → персонажи → сценарий → сборка → видео. */
  const canGoStage = useCallback(
    (next: StoryStage): boolean => {
      if (next === 1) return true;
      if (next === 2) return slides.length > 0;
      if (next === 3) return slides.length > 0 && characters.length > 0;
      if (next === 4) return slides.length > 0 && issues.length === 0;
      return Boolean(video);
    },
    [characters.length, issues.length, slides.length, video]
  );

  const goStage = useCallback(
    (next: StoryStage) => {
      if (!canGoStage(next)) return false;
      setStage(next);
      return true;
    },
    [canGoStage]
  );

  const progress = useMemo<StoryProgress>(() => {
    const step = video && stage === 5 ? STORY_STEPS_TOTAL : PHASE_STEP[phase];
    return {
      phase,
      percent: Math.max(0, Math.min(100, Math.round(percent))),
      label: `Этап ${step} из ${STORY_STEPS_TOTAL} · ${video && stage === 5 ? "Видео готово" : PHASE_NAMES[phase]}`,
      detail,
    };
  }, [detail, percent, phase, stage, video]);

  /* ------------------------------------------------------------------ */
  /* Этап 4: озвучка слайдов и сборка видео                              */
  /* ------------------------------------------------------------------ */

  /** Озвучивает одну реплику слайда и возвращает дорожку с её длительностью. */
  const requestTrack = useCallback(
    async (item: SlideScript, character: CharacterProfile, signal: AbortSignal): Promise<SlideTrack> => {
      const body = buildTtsRequest(item.text, character);
      let blob: Blob;
      try {
        blob = await edgeBlob(DIALOG_TTS_FN, { ...body, ...aiRequestFields() }, signal, { onResponse });
      } catch (e) {
        if (isAbortError(e, signal)) throw e;
        throw classifyEdgeFailure(e, "tts-api", "сервер не вернул аудио слайда");
      }

      let url: string;
      try {
        url = URL.createObjectURL(blob);
      } catch (e) {
        throw mangaFailure("tts-decode", e instanceof Error ? e.message : "браузер не смог создать ссылку на аудио");
      }

      // Длительность берём из декодированного аудио: от неё зависит, сколько
      // показывается слайд. Если браузер не смог её прочитать — играем дорожку,
      // но слайд получит минимальную длительность (это видно в деталях).
      try {
        const decoded: AudioBufferLike = await deps.decodeAudio(blob);
        return { url, seconds: Number.isFinite(decoded?.duration) ? decoded.duration : 0, decoded: true };
      } catch {
        return { url, seconds: 0, decoded: false };
      }
    },
    [aiRequestFields, deps, onResponse]
  );

  /**
   * Генерация и сборка: озвучить каждый слайд, посчитать таймлайн от реальной
   * длительности дорожек и записать видео в браузере.
   *
   * Сбой одного слайда не останавливает остальные (как «Озвучить всё» в манге):
   * слайд помечается причиной, а видео собирается из того, что озвучено.
   */
  const generate = useCallback(async (): Promise<boolean> => {
    const list = slidesRef.current;
    const items = list.map((slide) => scriptRef.current[slide.id]).filter((item): item is SlideScript => Boolean(item));
    const cast = charactersRef.current;

    const problems = validateScript(list, items, cast);
    if (problems.length) {
      const reason = problems
        .map((issue) => {
          const index = list.findIndex((slide) => slide.id === issue.slideId);
          return issue.slideId ? `слайд ${index + 1}: ${issue.reason}` : issue.reason;
        })
        .join("; ");
      reportFailure(dialogCheckFailure(reason));
      setStage(3);
      return false;
    }

    stoppedRef.current = false;
    setIsBusy(true);
    setError("");
    setFailure(null);
    setSlideIssues([]);
    setPhase("voicing");
    setPercent(0);
    setStage(4);
    stopPreview();

    const runId = (runIdRef.current += 1);
    const controller = new AbortController();
    abortRef.current = controller;

    // Прежние дорожки больше не нужны: отозвать, чтобы не копить object URL.
    for (const track of Object.values(tracksRef.current)) revokeTrack(track);
    setTracks({});

    const collected: Record<string, SlideTrack> = {};
    const failed: SlideIssue[] = [];
    let done = 0;

    try {
      for (const item of items) {
        if (stoppedRef.current || controller.signal.aborted) break;

        const character = cast.find((person) => person.speaker === item.speaker) ?? cast[0];
        const index = list.findIndex((slide) => slide.id === item.slideId);
        setDetail(
          `Слайд ${index + 1} из ${list.length} · Speaker ${character.speaker}${character.name ? ` · ${character.name}` : ""}`
        );

        try {
          const track = await requestTrack(item, character, controller.signal);
          collected[item.slideId] = track;
        } catch (e) {
          if (isAbortError(e, controller.signal)) break;
          const slideFailure = isMangaFailure(e) ? e : classifyEdgeFailure(e, "tts-api", "озвучка слайда не удалась");
          failed.push({ slideId: item.slideId, reason: slideFailure.reason });
          // Один слайд не роняет всю историю: продолжаем очередь.
          if (failed.length === 1) reportFailure(slideFailure);
        }

        done += 1;
        tracksRef.current = collected;
        setTracks({ ...collected });
        setPercent(generationPercent(done, items.length) * VOICE_SHARE);
      }

      if (stoppedRef.current || controller.signal.aborted) return false;

      if (!Object.keys(collected).length) {
        reportFailure(
          failed.length
            ? mangaFailure("tts-api", `не озвучен ни один слайд (${failed.length} с ошибками)`)
            : dialogCheckFailure("нет дорожек для сборки")
        );
        return false;
      }

      setSlideIssues(failed);

      // Таймлайн — от фактических длительностей: «реплика закончилась → слайд».
      setPhase("assembling");
      setDetail("Считаю тайминги слайдов по длительности реплик");
      const secondsById = Object.fromEntries(
        Object.entries(collected).map(([slideId, track]) => [slideId, track.seconds])
      );
      const frames: StoryFrame[] = planTimeline(items, secondsById);
      framesRef.current = frames;
      setFrames(frames);

      // Картинки для холста: без них запись не начнётся.
      const recorderSlides: Record<string, RecorderSlide> = {};
      const audioBuffers: Record<string, AudioBufferLike> = {};
      for (let i = 0; i < frames.length; i += 1) {
        if (stoppedRef.current || controller.signal.aborted) break;
        const frame = frames[i];
        const slide = list.find((item) => item.id === frame.slideId);
        if (!slide) continue;
        setPercent(VOICE_SHARE * 100 + generationPercent(i + 1, frames.length) * LOAD_SHARE * 100);
        setDetail(`Готовлю изображения ${i + 1} из ${frames.length}`);
        try {
          const image = await deps.loadImage(slide.url);
          const character = cast.find((person) => person.speaker === frame.speaker);
          recorderSlides[frame.slideId] = {
            image,
            speakerLabel: `Speaker ${frame.speaker}${character?.name ? ` · ${character.name}` : ""}`,
          };
        } catch (e) {
          if (isAbortError(e, controller.signal)) break;
          throw classifyPrepareFailure(e, slide.file.name);
        }
      }

      if (stoppedRef.current || controller.signal.aborted) return false;

      // Сборка видео идёт в реальном времени: прогресс — от часов движка.
      setPhase("rendering");
      setDetail(`Пишу видео · ${formatClock(totalSeconds(frames))} · ${frames.length} слайдов`);

      const rendered = await renderStoryVideo(
        {
          frames,
          slides: recorderSlides,
          audio: Object.fromEntries(
            Object.entries(collected)
              .filter(([slideId]) => recorderSlides[slideId])
              .map(([slideId, track]) => [
                slideId,
                { duration: track.seconds, sampleRate: 48000, numberOfChannels: 1, length: Math.round(track.seconds * 48000) },
              ])
          ),
          title,
          introTitle: title,
          signal: controller.signal,
          onProgress: (value) => {
            setPercent((VOICE_SHARE + LOAD_SHARE) * 100 + value * (1 - VOICE_SHARE - LOAD_SHARE));
          },
        },
        deps
      );

      if (runIdRef.current !== runId) return false;

      if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
      const url = URL.createObjectURL(rendered.blob);
      videoUrlRef.current = url;
      setVideoUrl(url);
      setVideo(rendered);
      setPercent(100);
      setDetail(`Готово · ${formatClock(rendered.duration)} · ${rendered.fileName}`);
      setStage(5);
      toast.success(`Видео собрано: ${formatClock(rendered.duration)}, ${rendered.ext.toUpperCase()}`);
      return true;
    } catch (e) {
      if (!isAbortError(e, controller.signal)) {
        const next = isMangaFailure(e) ? e : classifyPrepareFailure(e);
        reportFailure(next);
      }
      return false;
    } finally {
      if (runIdRef.current === runId) {
        setIsBusy(false);
        abortRef.current = null;
        setPhase("idle");
        if (stoppedRef.current) {
          setError("");
          setFailure(null);
          setDetail("Остановлено");
        }
      }
    }
  }, [deps, reportFailure, requestTrack, revokeTrack, stopPreview, title]);

  /** «Стоп»: рвёт текущую озвучку или запись видео. */
  const stop = useCallback(() => {
    stoppedRef.current = true;
    stopPreview();
    abortRef.current?.abort();
    setIsBusy(false);
    setPhase("idle");
    setDetail("Остановлено");
  }, [stopPreview]);

  /* ------------------------------------------------------------------ */
  /* Этап 5: плеер, скачивание, отправка в чат                           */
  /* ------------------------------------------------------------------ */

  /** Послушать дорожку слайда до сборки видео. */
  const previewSlide = useCallback(
    (slideId: string) => {
      const track = tracksRef.current[slideId];
      if (!track) return false;
      // Только одна дорожка одновременно: прежнюю глушим (как в чате).
      announceStopSpeech();
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      const audio = new Audio(track.url);
      audioRef.current = audio;
      setPreviewId(slideId);
      audio.onended = () => setPreviewId((prev) => (prev === slideId ? null : prev));
      audio.onerror = () => {
        setPreviewId(null);
        setError("Не удалось воспроизвести дорожку слайда");
      };
      void audio.play().catch(() => {
        setPreviewId(null);
        setError("Браузер не дал включить звук — нажмите ещё раз");
      });
      return true;
    },
    []
  );

  /** Скачать готовое видео: имя и расширение — от фактического формата записи. */
  const download = useCallback(() => {
    if (!video) return false;
    try {
      const url = URL.createObjectURL(video.blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = video.fileName;
      link.rel = "noopener";
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Файл уже отдан браузеру — ссылку можно освободить.
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось сохранить видео");
      return false;
    }
  }, [video]);

  /**
   * Отправить результат в чат: сообщение с постером и параметрами истории.
   *
   * Модель сообщения в чате хранит картинки (dataURL), а не видеофайлы, поэтому
   * в чат уходит постер первого кадра и подпись; сам файл скачивается кнопкой
   * «Скачать видео».
   */
  const share = useCallback(() => {
    if (!video || !onShare) return false;
    const voiced = Object.keys(tracksRef.current).length;
    const text = [
      `Видео-история${title ? ` «${title}»` : ""}: ${slidesRef.current.length} слайдов, ${voiced} озвучено.`,
      `Длительность ${formatClock(video.duration)}, формат ${video.ext.toUpperCase()}, ${video.width}×${video.height}.`,
      "Файл скачан с устройства — прикрепляю первый кадр как превью.",
    ].join("\n");
    onShare({ text, images: video.poster ? [video.poster] : [] });
    toast.success("Отправлено в чат");
    return true;
  }, [onShare, title, video]);

  /** Сброс студии: страницы, дорожки, видео и их object URL. */
  const reset = useCallback(() => {
    stop();
    for (const track of Object.values(tracksRef.current)) revokeTrack(track);
    for (const slide of slidesRef.current) revokeSlide(slide);
    if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
    videoUrlRef.current = "";
    tracksRef.current = {};
    setTracks({});
    setSlides([]);
    setScript({});
    setSlideIssues([]);
    setVideo(null);
    setVideoUrl("");
    setFrames([]);
    setCharacters(defaultCharacters());
    setStage(1);
    setPercent(0);
    setDetail(undefined);
    setError("");
    setFailure(null);
  }, [revokeSlide, revokeTrack, stop]);

  const readySlides = useMemo(
    () => slides.filter((slide) => Boolean(tracks[slide.id])).map((slide) => slide.id),
    [slides, tracks]
  );

  return {
    // этапы
    stage,
    setStage: goStage,
    canGoStage,
    phase,
    progress,
    isBusy,
    // материалы
    slides,
    addFiles,
    removeSlide,
    moveSlide,
    // персонажи
    characters,
    setCharacter,
    addCharacter,
    removeCharacter,
    // сценарий
    script,
    scriptList,
    issues,
    setSlideText,
    setSlideSpeaker,
    autoAssignSpeakers,
    // генерация
    tracks,
    slideIssues,
    readySlides,
    generate,
    stop,
    reset,
    previewSlide,
    stopPreview,
    previewId,
    // результат
    video,
    videoUrl,
    frames,
    download,
    share,
    error,
    failure,
  };
}
