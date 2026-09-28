import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CHARACTER_PRESETS,
  MAX_CUE_CHARS,
  MAX_SLIDE_TEXT_CHARS,
  MAX_STORY_SLIDES,
  MIN_SLIDE_SECONDS,
  STORY_VOICES,
  TAIL_SECONDS,
  VIDEO_BITRATE,
  VIDEO_FPS,
  VIDEO_HEIGHT,
  VIDEO_WIDTH,
  buildTtsRequest,
  cueAt,
  defaultCharacters,
  fitRect,
  formatClock,
  frameAt,
  generationPercent,
  isTtsVoice,
  pickVideoMime,
  planTimeline,
  splitCues,
  totalSeconds,
  validateScript,
  videoFileName,
  type CharacterProfile,
  type SlideScript,
  type StorySlide,
} from "@/lib/videoStory";
import { TTS_VOICES } from "@/lib/mangaTranscript";

/**
 * Видео-история: слайды, персонажи, сценарий и таймлайн.
 *
 * Ключевое правило из задания — «реплика под изображение закончилась →
 * следующий слайд», поэтому здесь проверяется, что длительность слайда
 * считается от озвучки, а таймлайн и субтитры не разъезжаются.
 */

const dialogTtsSource = readFileSync(resolve(process.cwd(), "supabase/functions/dialog-tts/index.ts"), "utf8");

const slide = (id: string): Pick<StorySlide, "id"> => ({ id });
const char = (speaker: number, voice: CharacterProfile["voice"] = "Charon", context = ""): CharacterProfile => ({
  speaker,
  voice,
  name: `Speaker ${speaker}`,
  context,
});

describe("персонажи и голоса по умолчанию", () => {
  it("Speaker 1 — Charon (глубокий, харизматичный, уверенный)", () => {
    const first = CHARACTER_PRESETS[0];
    expect(first.speaker).toBe(1);
    expect(first.voice).toBe("Charon");
    expect(first.context).toMatch(/глубок/i);
    expect(first.context).toMatch(/харизмат/i);
    expect(first.context).toMatch(/уверен/i);
  });

  it("Speaker 2 — Kore (живой, выразительный, тёплый женский)", () => {
    const second = CHARACTER_PRESETS[1];
    expect(second.speaker).toBe(2);
    expect(second.voice).toBe("Kore");
    expect(second.context).toMatch(/живо/i);
    expect(second.context).toMatch(/выразител/i);
    expect(second.context).toMatch(/тёпл/i);
    expect(second.context).toMatch(/женск/i);
  });

  it("голоса — те же, что принимает dialog-tts", () => {
    expect(STORY_VOICES).toEqual(TTS_VOICES);
    expect(isTtsVoice("Charon")).toBe(true);
    expect(isTtsVoice("Kore")).toBe(true);
    expect(isTtsVoice("onyx")).toBe(false);
    expect(isTtsVoice(undefined)).toBe(false);
    // Список клиента совпадает с ALLOWED_VOICES сервера.
    const allowed = dialogTtsSource.match(/ALLOWED_VOICES = \[([^\]]+)\]/)?.[1] ?? "";
    for (const voice of STORY_VOICES) {
      expect(allowed).toContain(`'${voice}'`);
    }
  });

  it("defaultCharacters отдаёт копии: правка профиля не меняет пресет", () => {
    const characters = defaultCharacters();
    characters[0].context = "строгий ментор";
    characters[0].voice = "Kore";
    expect(CHARACTER_PRESETS[0].context).toMatch(/глубок/i);
    expect(CHARACTER_PRESETS[0].voice).toBe("Charon");
    expect(defaultCharacters()[0].voice).toBe("Charon");
  });
});

describe("запрос озвучки реплики слайда", () => {
  it("формат тот же, что у dialog-tts: «Speaker N: текст» + карта голосов", () => {
    const body = buildTtsRequest("Ребята, начинаем?", char(1, "Charon"));
    expect(body.transcript).toBe("Speaker 1: Ребята, начинаем?");
    expect(body.voices).toEqual({ "1": "Charon" });
  });

  it("характер персонажа уходит полем styles, а не в текст реплики", () => {
    const body = buildTtsRequest("Я сказала тебе прекратить!", char(2, "Kore", "строгий ментор"));
    expect(body.styles).toEqual({ "2": "строгий ментор" });
    expect(body.transcript).not.toContain("строгий ментор");
    expect(body.transcript).toBe("Speaker 2: Я сказала тебе прекратить!");
  });

  it("без характера поля styles нет — старый контракт не меняется", () => {
    expect(buildTtsRequest("Привет", char(1, "Charon", "   ")).styles).toBeUndefined();
    expect(buildTtsRequest("Привет", char(1, "Charon")).styles).toBeUndefined();
  });

  it("переносы и лишние пробелы в реплике схлопываются", () => {
    const body = buildTtsRequest("  Первая   строка\nвторая\tстрока  ", char(1, "Charon"));
    expect(body.transcript).toBe("Speaker 1: Первая строка вторая строка");
  });

  it("сервер принимает styles как указание на манеру речи", () => {
    // Страж на серверную часть: поле читается и подмешивается в промпт TTS,
    // а не игнорируется (иначе контекст персонажа не влиял бы на интонации).
    expect(dialogTtsSource).toContain("body?.styles");
    expect(dialogTtsSource).toMatch(/## Style|Style:/);
  });
});

describe("проверка сценария", () => {
  it("валидный сценарий без замечаний", () => {
    const script: SlideScript[] = [
      { slideId: "s1", speaker: 1, text: "Ребята, начинаем?" },
      { slideId: "s2", speaker: 2, text: "Я сказала тебе прекратить!" },
    ];
    expect(validateScript([slide("s1"), slide("s2")], script, [char(1), char(2)])).toEqual([]);
  });

  it("слайд без реплики и с чужим говорящим не дойдут до озвучки", () => {
    const issues = validateScript(
      [slide("s1"), slide("s2"), slide("s3")],
      [
        { slideId: "s1", speaker: 1, text: "   " },
        { slideId: "s2", speaker: 7, text: "Ладно, ладно" },
      ],
      [char(1), char(2)]
    );
    expect(issues.map((i) => i.slideId)).toEqual(["s1", "s2", "s3"]);
    expect(issues[0].reason).toMatch(/нет реплики/);
    expect(issues[1].reason).toMatch(/Speaker 7 не задан/);
    expect(issues[2].reason).toMatch(/нет реплики/);
  });

  it("слишком длинная реплика и лишний слайд объясняются понятной причиной", () => {
    const long = "слово ".repeat(MAX_SLIDE_TEXT_CHARS);
    const issues = validateScript(
      Array.from({ length: MAX_STORY_SLIDES + 1 }, (_, i) => slide(`s${i + 1}`)),
      [{ slideId: "s1", speaker: 1, text: long }],
      [char(1)]
    );
    expect(issues.some((i) => i.reason.includes(`${MAX_STORY_SLIDES} слайдов`))).toBe(true);
    expect(issues.some((i) => i.reason.includes(`${MAX_SLIDE_TEXT_CHARS} символов`))).toBe(true);
  });
});

describe("субтитры: реплика режется внутри своего окна", () => {
  it("короткая реплика — один блок на всю длительность", () => {
    const cues = splitCues("Ребята, начинаем?", 4);
    expect(cues).toHaveLength(1);
    expect(cues[0]).toEqual({ start: 0, end: 4, text: "Ребята, начинаем?" });
  });

  it("длинная реплика режется по границам фраз и не длиннее лимита", () => {
    const text =
      "Это очень длинная реплика персонажа, которая точно не помещается в одну строку субтитров. Она продолжает мысль и заканчивается здесь.";
    const cues = splitCues(text, 12);
    expect(cues.length).toBeGreaterThan(1);
    for (const cue of cues) {
      expect(cue.text.length).toBeLessThanOrEqual(MAX_CUE_CHARS);
      expect(cue.end).toBeGreaterThan(cue.start);
    }
    // Без потерь текста: склейка кусков равна исходной реплике.
    expect(cues.map((c) => c.text).join(" ")).toBe(text.replace(/\s+/g, " ").trim());
  });

  it("сумма субтитров точно укладывается в длительность слайда", () => {
    const cues = splitCues("Первая фраза. Вторая фраза. Третья фраза.", 6);
    expect(cues[0].start).toBe(0);
    expect(cues[cues.length - 1].end).toBeCloseTo(6, 5);
    for (let i = 1; i < cues.length; i += 1) {
      expect(cues[i].start).toBeGreaterThanOrEqual(cues[i - 1].end - 0.001);
    }
  });

  it("пустой текст не даёт субтитров, а время не уходит в минус", () => {
    expect(splitCues("   ", 3)).toEqual([]);
    expect(splitCues("Привет", -5)[0].end).toBeGreaterThan(0);
    expect(splitCues("Привет", Number.NaN)[0].end).toBeGreaterThan(0);
  });

  it("очень длинный текст сжимается, а не вылезает за слайд", () => {
    const cues = splitCues(Array.from({ length: 40 }, (_, i) => `фраза ${i + 1}`).join(". "), 4);
    expect(cues[cues.length - 1].end).toBeLessThanOrEqual(4.01);
  });
});

describe("таймлайн: слайд живёт столько, сколько звучит реплика", () => {
  const script: SlideScript[] = [
    { slideId: "s1", speaker: 1, text: "Ребята, начинаем?" },
    { slideId: "s2", speaker: 2, text: "Я сказала тебе прекратить!" },
    { slideId: "s3", speaker: 1, text: "Ладно, ладно, понял." },
  ];

  it("длительность слайда = озвучка + пауза, следующий начинается после конца", () => {
    const frames = planTimeline(script, { s1: 3, s2: 5.4, s3: 2 });
    expect(frames[0].seconds).toBeCloseTo(3 + TAIL_SECONDS, 5);
    expect(frames[1].start).toBeCloseTo(3 + TAIL_SECONDS, 5);
    expect(frames[1].seconds).toBeCloseTo(5.4 + TAIL_SECONDS, 5);
    expect(frames[2].start).toBeCloseTo(3 + TAIL_SECONDS + 5.4 + TAIL_SECONDS, 5);
    expect(totalSeconds(frames)).toBeCloseTo(3 + 5.4 + 2 + TAIL_SECONDS * 3, 5);
  });

  it("слайд без озвучки не мелькает короче минимума", () => {
    const frames = planTimeline(script, { s2: 4 });
    expect(frames[0].seconds).toBe(MIN_SLIDE_SECONDS);
    expect(frames[0].audioSeconds).toBe(0);
    expect(frames[1].seconds).toBeCloseTo(4 + TAIL_SECONDS, 5);
  });

  it("очередность и говорящие сохраняются, субтитры привязаны к своему слайду", () => {
    const frames = planTimeline(script, { s1: 3, s2: 3, s3: 3 });
    expect(frames.map((f) => f.slideId)).toEqual(["s1", "s2", "s3"]);
    expect(frames.map((f) => f.speaker)).toEqual([1, 2, 1]);
    expect(frames[0].cues[0].text).toBe("Ребята, начинаем?");
    expect(frames[1].cues[0].text).toBe("Я сказала тебе прекратить!");
  });

  it("frameAt и cueAt отвечают, что на экране в момент времени", () => {
    const frames = planTimeline(script, { s1: 3, s2: 5, s3: 2 });
    expect(frameAt(frames, 0)?.slideId).toBe("s1");
    // Реплика слайда 1 звучит 3 с + пауза 0.5 с: смена кадра ровно на границе.
    expect(frameAt(frames, 3.49)?.slideId).toBe("s1");
    expect(frameAt(frames, 3 + TAIL_SECONDS)?.slideId).toBe("s2");
    expect(frameAt(frames, totalSeconds(frames))).toBeNull();
    expect(frameAt([], 1)).toBeNull();

    const first = frames[0];
    expect(cueAt(first, 0)?.text).toBe("Ребята, начинаем?");
    expect(cueAt(first, 99)?.text).toBe("Ребята, начинаем?"); // хвост — последний блок
  });

  it("пустой сценарий — нулевая длительность", () => {
    expect(planTimeline([], {})).toEqual([]);
    expect(totalSeconds([])).toBe(0);
  });
});

describe("раскладка кадра без искажений", () => {
  it("cover заполняет кадр, соотношение сторон сохраняется", () => {
    const rect = fitRect(1000, 2000, VIDEO_WIDTH, VIDEO_HEIGHT, "cover");
    // Соотношение источника и результата одинаковое — картинка не растянута.
    expect(rect.dw / rect.dh).toBeCloseTo(1000 / 2000, 3);
    expect(rect.dh).toBeGreaterThanOrEqual(VIDEO_HEIGHT);
    expect(rect.dy).toBeLessThan(0); // лишнее уходит за край
    expect(rect.sw).toBe(1000);
    expect(rect.sh).toBe(2000);
  });

  it("letterbox вписывает картинку целиком, с полями", () => {
    const rect = fitRect(1000, 2000, VIDEO_WIDTH, VIDEO_HEIGHT, "letterbox");
    expect(rect.dh).toBe(VIDEO_HEIGHT);
    expect(rect.dw).toBeLessThan(VIDEO_WIDTH);
    expect(rect.dx).toBeGreaterThan(0); // поля слева и справа
    expect(rect.dw / rect.dh).toBeCloseTo(0.5, 3);
  });

  it("широкая картинка в квадратном кадре: cover режет края, letterbox — поля сверху/снизу", () => {
    const cover = fitRect(2000, 500, 720, 720, "cover");
    expect(cover.dw).toBeGreaterThanOrEqual(720);
    expect(cover.dx).toBeLessThanOrEqual(0);
    const letterbox = fitRect(2000, 500, 720, 720, "letterbox");
    expect(letterbox.dw).toBe(720);
    expect(letterbox.dy).toBeGreaterThan(0);
  });

  it("нулевые размеры не роняют отрисовку", () => {
    expect(fitRect(0, 0, VIDEO_WIDTH, VIDEO_HEIGHT).dw).toBe(VIDEO_WIDTH);
    expect(fitRect(100, 100, 0, 0).dw).toBe(0);
    expect(fitRect(-5, 100, VIDEO_WIDTH, VIDEO_HEIGHT).sw).toBe(0);
  });

  it("параметры рендера: 720p30 и высокий битрейт", () => {
    expect(VIDEO_WIDTH).toBe(1280);
    expect(VIDEO_HEIGHT).toBe(720);
    expect(VIDEO_FPS).toBe(30);
    expect(VIDEO_BITRATE).toBeGreaterThanOrEqual(5_000_000);
  });
});

describe("формат файла и подписи времени", () => {
  it("берёт первый поддерживаемый формат: mp4, затем webm", () => {
    expect(pickVideoMime(() => true)).toEqual({ mime: "video/mp4;codecs=avc1.42E01E,mp4a.40.2", ext: "mp4" });
    expect(pickVideoMime((mime) => mime.startsWith("video/webm;codecs=vp9"))).toEqual({
      mime: "video/webm;codecs=vp9,opus",
      ext: "webm",
    });
    expect(pickVideoMime((mime) => mime === "video/webm")).toEqual({ mime: "video/webm", ext: "webm" });
    expect(pickVideoMime(() => false)).toBeNull();
  });

  it("имя файла: верное расширение, безопасный slug, дата", () => {
    expect(videoFileName("webm", "Моя история!")).toMatch(/^hikko-.*\d{4}-\d{2}-\d{2}\.webm$/);
    expect(videoFileName("mp4", "My Story")).toMatch(/^hikko-my-story-\d{4}-\d{2}-\d{2}\.mp4$/);
    expect(videoFileName("avi", "x")).toMatch(/\.webm$/); // чужое расширение не проходит
    expect(videoFileName("webm", "../../etc/passwd")).not.toContain("..");
    expect(videoFileName("webm")).toMatch(/^hikko-story-/);
  });

  it("часы в «0:07» / «1:23» / «1:02:03»", () => {
    expect(formatClock(7)).toBe("0:07");
    expect(formatClock(83)).toBe("1:23");
    expect(formatClock(3723)).toBe("1:02:03");
    expect(formatClock(-5)).toBe("0:00");
    expect(formatClock(Number.NaN)).toBe("0:00");
  });

  it("процент генерации ограничен 0..100", () => {
    expect(generationPercent(0, 4)).toBe(0);
    expect(generationPercent(1, 4)).toBe(25);
    expect(generationPercent(4, 4)).toBe(100);
    expect(generationPercent(1, 0)).toBe(0);
    expect(generationPercent(9, 4)).toBe(100);
  });
});
