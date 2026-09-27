import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_MANGA_MODEL,
  INVALID_IMAGES_ERROR,
  MANGA_MODEL_MAP,
  MAX_IMAGES,
  MAX_IMAGE_DATA_URL_CHARS,
  dataUrlToInlineData,
  extractJson,
  geminiAnalyzeBody,
  geminiText,
  normalizePages,
  shouldSwitchApi,
  toAiModel,
  toGoogleModel,
  upstreamErrorMessage,
  validateImages,
} from "../../supabase/functions/manga-analyze/parse";

/**
 * Логика edge-функции `manga-analyze`. Сам index.ts поднимает Deno-сервер и в
 * vitest не импортируется, поэтому чистая часть вынесена в parse.ts — её здесь и
 * проверяем, плюс стражи на то, что index.ts действительно её использует.
 */
const indexSource = readFileSync(resolve(process.cwd(), "supabase/functions/manga-analyze/index.ts"), "utf8");
const configSource = readFileSync(resolve(process.cwd(), "supabase/config.toml"), "utf8");

const png = (chars = 64) => `data:image/png;base64,${"A".repeat(chars)}`;

describe("validateImages", () => {
  it("принимает от 1 до 5 dataURL", () => {
    expect(validateImages([png()]).ok).toBe(true);
    expect(validateImages(Array.from({ length: MAX_IMAGES }, png)).ok).toBe(true);
  });

  it("отклоняет пустой список, 6 картинок и не-массив", () => {
    expect(validateImages([]).ok).toBe(false);
    expect(validateImages(Array.from({ length: 6 }, png)).ok).toBe(false);
    expect(validateImages(undefined).ok).toBe(false);
    expect(validateImages("data:image/png;base64,AAAA").ok).toBe(false);
  });

  it("отклоняет чужой mime, не-base64 и слишком длинные строки", () => {
    expect(validateImages(["data:image/gif;base64,AAAA"]).ok).toBe(false);
    expect(validateImages(["data:image/png;base64,AA==AA"]).ok).toBe(false);
    expect(validateImages(["not-a-data-url"]).ok).toBe(false);
    expect(validateImages([`data:image/png;base64,${"A".repeat(MAX_IMAGE_DATA_URL_CHARS)}`]).ok).toBe(false);
  });

  it("текст ошибки совпадает с тем, что видит пользователь", () => {
    const result = validateImages([]);
    expect(result.ok).toBe(false);
    // При strictNullChecks: false union сужается только явным сравнением.
    if (result.ok === false) expect(result.error).toBe(INVALID_IMAGES_ERROR);
    expect(INVALID_IMAGES_ERROR).toContain("от 1 до 5");
  });
});

describe("extractJson", () => {
  const payload = '{"pages":[{"description":"Кадр","transcript":"Speaker 1: Привет"}]}';

  it("разбирает чистый JSON", () => {
    expect(extractJson(payload)).toEqual(JSON.parse(payload));
  });

  it("разбирает JSON внутри ```json-забора", () => {
    expect(extractJson("```json\n" + payload + "\n```")).toEqual(JSON.parse(payload));
  });

  it("разбирает JSON с пояснением модели вокруг", () => {
    const raw = `Вот результат анализа:\n${payload}\nНадеюсь, помог!`;
    expect(extractJson(raw)).toEqual(JSON.parse(payload));
  });

  it("не падает на мусоре, а бросает понятную ошибку", () => {
    expect(() => extractJson("")).toThrow();
    expect(() => extractJson("простите, я не могу")).toThrow();
  });
});

describe("normalizePages", () => {
  it("принимает ответ нужной длины", () => {
    const pages = normalizePages(
      { pages: [{ description: "Кадр", transcript: "Speaker 1: Привет" }] },
      1
    );
    expect(pages).toEqual([{ description: "Кадр", transcript: "Speaker 1: Привет" }]);
  });

  it("принимает голый массив без обёртки pages", () => {
    expect(normalizePages([{ description: "а", transcript: "б" }], 1)).toHaveLength(1);
  });

  it("транскрипт-массив склеивается в строки", () => {
    const pages = normalizePages(
      { pages: [{ description: "Кадр", transcript: ["Speaker 1: Привет", "Speaker 2: Пока"] }] },
      1
    );
    expect(pages?.[0].transcript).toBe("Speaker 1: Привет\nSpeaker 2: Пока");
  });

  it("отклоняет несовпадение количества страниц", () => {
    expect(normalizePages({ pages: [{ description: "а", transcript: "б" }] }, 2)).toBeNull();
    expect(normalizePages({ pages: [] }, 1)).toBeNull();
  });

  it("отклоняет страницы без содержимого", () => {
    expect(normalizePages({ pages: [{ description: "", transcript: "" }] }, 1)).toBeNull();
    expect(normalizePages({ pages: ["строка вместо объекта"] }, 1)).toBeNull();
  });

  it("обрезает сверхдлинные поля", () => {
    const pages = normalizePages(
      { pages: [{ description: "о".repeat(5000), transcript: "р".repeat(9000) }] },
      1
    );
    expect(pages?.[0].description).toHaveLength(2000);
    expect(pages?.[0].transcript).toHaveLength(6000);
  });
});

describe("upstreamErrorMessage", () => {
  it("различает квоту, оплату и сбой", () => {
    expect(upstreamErrorMessage(429)).toMatch(/Слишком много запросов/);
    expect(upstreamErrorMessage(402)).toMatch(/Недостаточно средств/);
    expect(upstreamErrorMessage(500)).toMatch(/временно недоступен/);
    expect(upstreamErrorMessage(418)).toContain("418");
  });
});

describe("смена api: имя из переключателя → модель", () => {
  const pngUrl = png(200);

  it("каждое имя переключателя даёт свою модель шлюза", () => {
    expect(toAiModel("HikkoGPT")).toBe("google/gemini-3.1-pro-preview");
    expect(toAiModel("HikkoGPT Smart")).toBe("google/gemini-3-flash-preview");
    expect(toAiModel("HikkoGPT Turbo")).toBe("google/gemini-3-flash-preview");
    expect(toAiModel("Спорящий")).toBe("google/gemini-3.1-flash-lite-preview");
    expect(new Set(Object.values(MANGA_MODEL_MAP)).size).toBeGreaterThan(1);
  });

  it("старый клиент без поля model и чужое имя получают модель по умолчанию", () => {
    expect(toAiModel(undefined)).toBe(DEFAULT_MANGA_MODEL);
    expect(toAiModel(null)).toBe(DEFAULT_MANGA_MODEL);
    expect(toAiModel("")).toBe(DEFAULT_MANGA_MODEL);
    expect(toAiModel("gpt-5")).toBe(DEFAULT_MANGA_MODEL);
    expect(toAiModel({ model: "HikkoGPT" })).toBe(DEFAULT_MANGA_MODEL);
    expect(toAiModel("Илон Маск")).toBe(DEFAULT_MANGA_MODEL);
  });

  it("запасной api: модель шлюза → прямой Gemini, все варианты зрячие", () => {
    expect(toGoogleModel("google/gemini-3.1-pro-preview")).toBe("gemini-2.0-flash-exp");
    expect(toGoogleModel("google/gemini-3-flash-preview")).toBe("gemini-2.0-flash");
    expect(toGoogleModel("google/gemini-3.1-flash-lite-preview")).toBe("gemini-2.0-flash");
    expect(toGoogleModel("google/gemini-2.5-pro")).toBe("gemini-1.5-pro");
    expect(toGoogleModel("")).toBe("gemini-2.0-flash");
    // Анализ манги без изображений не работает — текстовых моделей в списке нет.
    for (const aiModel of Object.values(MANGA_MODEL_MAP)) {
      expect(toGoogleModel(aiModel)).toMatch(/^gemini-/);
    }
  });

  it("api меняется только при лимите, оплате или сбое сервиса", () => {
    expect(shouldSwitchApi(429)).toBe(true);
    expect(shouldSwitchApi(402)).toBe(true);
    expect(shouldSwitchApi(500)).toBe(true);
    expect(shouldSwitchApi(503)).toBe(true);
    // 400/401 — ошибка запроса или ключа: второй провайдер её не починит.
    expect(shouldSwitchApi(400)).toBe(false);
    expect(shouldSwitchApi(401)).toBe(false);
    expect(shouldSwitchApi(413)).toBe(false);
    expect(shouldSwitchApi(200)).toBe(false);
  });
});

describe("смена api: тело запроса к прямому Gemini", () => {
  const page = (n: number) => `data:image/jpeg;base64,${"A".repeat(64 + n)}`;

  it("dataURL страницы превращается в inline_data с mime", () => {
    expect(dataUrlToInlineData(page(1))).toEqual({ mime_type: "image/jpeg", data: "A".repeat(65) });
    expect(dataUrlToInlineData("data:image/png;base64,QQ==")?.mime_type).toBe("image/png");
    expect(dataUrlToInlineData("data:image/webp;base64,QQ")).not.toBeNull();
    expect(dataUrlToInlineData("https://example.com/page.png")).toBeNull();
    expect(dataUrlToInlineData("data:image/gif;base64,QQ")).toBeNull();
    expect(dataUrlToInlineData("")).toBeNull();
  });

  it("промпт тот же, страницы идут картинками, а не текстом", () => {
    const body = geminiAnalyzeBody("SYSTEM", [page(1), page(2)], 2);
    expect(body?.systemInstruction.parts[0].text).toBe("SYSTEM");
    expect(body?.contents).toHaveLength(1);
    expect(body?.contents[0].role).toBe("user");

    const parts = body?.contents[0].parts as { text?: string; inline_data?: unknown }[];
    expect(parts).toHaveLength(3); // задание + 2 страницы
    expect(parts[0].text).toContain("2 страниц");
    expect(parts[1].inline_data).not.toBeUndefined();
    expect(parts[2].inline_data).not.toBeUndefined();
    // Ключ именно inline_data: в `inlineData` прямой api картинку не увидит.
    expect(JSON.stringify(body)).toContain("inline_data");
    expect(JSON.stringify(body)).not.toContain("image_url");
  });

  it("непереводимая страница отменяет запасной api, а не шлёт половину", () => {
    expect(geminiAnalyzeBody("SYSTEM", [page(1), "https://cdn/page.png"], 2)).toBeNull();
    expect(geminiAnalyzeBody("SYSTEM", [], 0)?.contents[0].parts).toHaveLength(1);
  });

  it("текст ответа Gemini достаётся из candidates, пустой ответ — пустая строка", () => {
    const result = { candidates: [{ content: { parts: [{ text: '{"pages":' }, { text: "[]}" }] } }] };
    expect(geminiText(result)).toBe('{"pages":[]}');
    expect(geminiText({ candidates: [{ content: { parts: [{ text: 42 }] } }] })).toBe("");
    expect(geminiText({ candidates: [] })).toBe("");
    expect(geminiText({})).toBe("");
    expect(geminiText(null)).toBe("");
  });

  it("разбор запасного api проходит тот же путь, что и основной", () => {
    const raw = geminiText({
      candidates: [
        { content: { parts: [{ text: '{"pages":[{"description":"Кадр 1","transcript":"Speaker 1: Привет."}]}' }] } },
      ],
    });
    const pages = normalizePages(extractJson(raw), 1);
    expect(pages).toEqual([{ description: "Кадр 1", transcript: "Speaker 1: Привет." }]);
  });
});

describe("system prompt: формат ответа модели", () => {
  it("требует только JSON с description и transcript", () => {
    expect(indexSource).toContain('{"pages":[{"description":"...","transcript":"..."}]}');
    expect(indexSource).toContain("Ровно один элемент pages на каждое изображение");
  });

  it("показывает формат на конкретном примере, а не на «Speaker N»", () => {
    expect(indexSource).toContain("Speaker 1: Ребята, начинаем?");
    expect(indexSource).toContain("Speaker 2: Я сказала тебе прекратить!");
    expect(indexSource).toContain("Speaker 3: Ладно, ладно, понял.");
    expect(indexSource).toContain("Speaker 4: Вы оба довольно забавные.");
    expect(indexSource).toContain("номер — реальная цифра, не буква N");
  });

  it("запрещает лишний текст в репликах", () => {
    expect(indexSource).toContain("между репликами одна пустая строка");
    expect(indexSource).toContain("никаких описаний, комментариев");
    expect(indexSource).toContain("в transcript его текст попадать не должен");
    expect(indexSource).toContain("максимум 8 персонажей");
  });

  it("description остаётся в JSON — он держит номера персонажей между страницами", () => {
    expect(indexSource).toContain("номера одного и того же персонажа одинаковы на всех страницах");
  });
});

describe("стражи index.ts и деплоя", () => {
  it("функция использует вынесенную валидацию и разбор", () => {
    expect(indexSource).toContain("validateImages(images)");
    expect(indexSource).toContain("extractJson(raw)");
    expect(indexSource).toContain("normalizePages(parsed, validated.images.length)");
    expect(indexSource).toContain("upstreamErrorMessage(response.status)");
  });

  it("не осталось прямого JSON.parse ответа модели", () => {
    expect(indexSource).not.toMatch(/JSON\.parse\(raw\)/);
  });

  it("проверяет JWT пользователя и не пускает без токена", () => {
    expect(indexSource).toContain("sb.auth.getUser(token)");
    expect(indexSource).toContain("{ error: 'Unauthorized' }, 401");
  });

  it("deploy-флаг verify_jwt выключен (функцию зовёт браузер с apikey)", () => {
    const section = configSource.match(/\[functions\.manga-analyze\]([\s\S]*?)(?=\n\[|$)/);
    expect(section, "в supabase/config.toml нет секции [functions.manga-analyze]").not.toBeNull();
    expect(section![1]).toMatch(/verify_jwt\s*=\s*false/);
  });
});
