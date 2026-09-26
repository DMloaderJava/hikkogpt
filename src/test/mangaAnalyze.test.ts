import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  INVALID_IMAGES_ERROR,
  MAX_IMAGES,
  MAX_IMAGE_DATA_URL_CHARS,
  extractJson,
  normalizePages,
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
