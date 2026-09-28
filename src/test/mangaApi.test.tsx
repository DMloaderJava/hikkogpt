import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MangaApiSelector } from "@/components/MangaApiSelector";
import {
  DEFAULT_MANGA_API,
  MANGA_API_OPTIONS,
  describeMangaApi,
  hasStoredMangaApi,
  isMangaApi,
  loadMangaApi,
  saveMangaApi,
} from "@/lib/mangaApi";
import { MANGA_MODEL_MAP, toAiModel } from "../../supabase/functions/manga-analyze/parse";

/**
 * Смена api в озвучивателе манги.
 *
 * Клиент и сервер договариваются об именах: клиент шлёт понятное имя полем
 * `model`, сервер (`MANGA_MODEL_MAP`) превращает его в конкретную модель. Список
 * живёт в двух местах, поэтому здесь есть страж на их совпадение — иначе
 * переключатель «молча» всегда работал бы на модели по умолчанию.
 */

const parseSource = readFileSync(resolve(process.cwd(), "supabase/functions/manga-analyze/parse.ts"), "utf8");
const indexSource = readFileSync(resolve(process.cwd(), "supabase/functions/manga-analyze/index.ts"), "utf8");
const hookSource = readFileSync(resolve(process.cwd(), "src/hooks/useMangaVoice.ts"), "utf8");
/** Общий модуль запасного бэкенда (прямой Google Gemini) — один на все функции. */
const sharedSource = readFileSync(resolve(process.cwd(), "supabase/functions/_shared/gemini.ts"), "utf8");

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("список api: клиент и сервер согласованы", () => {
  it("имена переключателя совпадают с MANGA_MODEL_MAP сервера", () => {
    expect(MANGA_API_OPTIONS.map((o) => o.id).sort()).toEqual(Object.keys(MANGA_MODEL_MAP).sort());
  });

  it("каждое имя даёт реальную модель, а не модель по умолчанию", () => {
    for (const option of MANGA_API_OPTIONS) {
      expect(toAiModel(option.id)).toMatch(/^google\/gemini-/);
    }
    // «Самый умный» и «Экономный» — разные модели, иначе переключатель бессмысленен.
    expect(toAiModel("HikkoGPT")).not.toBe(toAiModel("Спорящий"));
  });

  it("api по умолчанию на клиенте и на сервере одно", () => {
    expect(DEFAULT_MANGA_API).toBe("HikkoGPT Smart");
    expect(toAiModel(DEFAULT_MANGA_API)).toBe(toAiModel(undefined));
    expect(toAiModel("несуществующий")).toBe(toAiModel(undefined));
  });

  it("у каждого api есть подпись — переключатель объясняет выбор", () => {
    for (const option of MANGA_API_OPTIONS) {
      expect(option.label.length).toBeGreaterThan(0);
      expect(describeMangaApi(option.id).length).toBeGreaterThan(0);
    }
    expect(describeMangaApi("нет такого")).toBe("");
  });

  it("персонажи чата в анализ не попали", () => {
    expect(MANGA_API_OPTIONS.map((o) => o.id)).not.toContain("Илон Маск");
    expect(MANGA_API_OPTIONS.map((o) => o.id)).not.toContain("Прохожий0");
  });
});

describe("isMangaApi", () => {
  it("принимает только имена из списка", () => {
    expect(isMangaApi("HikkoGPT")).toBe(true);
    expect(isMangaApi("Спорящий")).toBe(true);
    expect(isMangaApi("gpt-5")).toBe(false);
    expect(isMangaApi("")).toBe(false);
    expect(isMangaApi(undefined)).toBe(false);
    expect(isMangaApi(42)).toBe(false);
  });
});

describe("хранение выбора api", () => {
  it("без сохранённого выбора берёт модель чата, иначе — свою", () => {
    expect(loadMangaApi("HikkoGPT Turbo")).toBe("HikkoGPT Turbo");
    saveMangaApi("Спорящий");
    expect(loadMangaApi("HikkoGPT Turbo")).toBe("Спорящий");
  });

  it("чужое имя и мусор в хранилище не ломают окно", () => {
    expect(loadMangaApi("Илон Маск")).toBe(DEFAULT_MANGA_API);
    window.localStorage.setItem("hikkogpt.manga.api", "gpt-5");
    expect(loadMangaApi()).toBe(DEFAULT_MANGA_API);
    expect(hasStoredMangaApi()).toBe(false);
  });

  it("saveMangaApi не пишет имя не из списка", () => {
    saveMangaApi("левое-имя");
    expect(window.localStorage.getItem("hikkogpt.manga.api")).toBeNull();
    saveMangaApi("HikkoGPT");
    expect(window.localStorage.getItem("hikkogpt.manga.api")).toBe("HikkoGPT");
    expect(hasStoredMangaApi()).toBe(true);
  });

  it("недоступный localStorage не роняет загрузку выбора", () => {
    const getItem = vi.spyOn(window.localStorage.__proto__, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    const setItem = vi.spyOn(window.localStorage.__proto__, "setItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });

    expect(loadMangaApi("HikkoGPT")).toBe("HikkoGPT");
    expect(hasStoredMangaApi()).toBe(false);
    expect(() => saveMangaApi("HikkoGPT")).not.toThrow();

    getItem.mockRestore();
    setItem.mockRestore();
  });
});

describe("MangaApiSelector", () => {
  it("показывает текущее api и открывает список", () => {
    render(<MangaApiSelector value="HikkoGPT Smart" onChange={() => {}} />);
    const trigger = screen.getByRole("button", { name: "Api анализа манги" });
    expect(trigger).toHaveTextContent("HikkoGPT Smart");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    // Все api из списка видны (имена пересекаются — «HikkoGPT» и «HikkoGPT
    // Smart», — поэтому сверяем по порядку и содержимому пункта).
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(MANGA_API_OPTIONS.length);
    MANGA_API_OPTIONS.forEach((option, i) => {
      expect(options[i]).toHaveTextContent(option.label);
      expect(options[i]).toHaveTextContent(option.description);
    });
    expect(options[1]).toHaveAttribute("aria-selected", "true"); // HikkoGPT Smart
    expect(options[3]).toHaveAttribute("aria-selected", "false"); // Спорящий
  });

  it("выбор пункта вызывает onChange и закрывает список", () => {
    const onChange = vi.fn();
    render(<MangaApiSelector value="HikkoGPT Smart" onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Api анализа манги" }));
    fireEvent.click(screen.getByRole("option", { name: /Спорящий/ }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("Спорящий");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("Escape и клик мимо закрывают список без выбора", () => {
    const onChange = vi.fn();
    render(
      <div>
        <span>снаружи</span>
        <MangaApiSelector value="HikkoGPT" onChange={onChange} />
      </div>
    );
    const trigger = screen.getByRole("button", { name: "Api анализа манги" });

    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    fireEvent.click(trigger);
    fireEvent.mouseDown(screen.getByText("снаружи"));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("во время запроса api не переключается", () => {
    render(<MangaApiSelector value="HikkoGPT Turbo" onChange={vi.fn()} disabled />);
    const trigger = screen.getByRole("button", { name: "Api анализа манги" });
    expect(trigger).toBeDisabled();

    fireEvent.click(trigger);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("подсказка объясняет, что делает выбранное api", () => {
    render(<MangaApiSelector value="HikkoGPT" onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Api анализа манги" })).toHaveAttribute(
      "title",
      describeMangaApi("HikkoGPT")
    );
  });
});

describe("стражи: api доходит до сервера", () => {
  it("хук кладёт имя api в тело manga-analyze", () => {
    expect(hookSource).toContain("{ images: batch.images, model, ...aiRequestFields() }");
    expect(hookSource).toContain("loadMangaApi(preferredApi)");
    expect(hookSource).toContain("saveMangaApi(id)");
  });

  it("сервер мапит имя и не хардкодит модель", () => {
    expect(indexSource).toContain("const { images, model, provider, userKeys, userKeyIndex } = await req.json()");
    expect(indexSource).toContain("const aiModel = toAiModel(model)");
    expect(indexSource).toContain("model: aiModel");
    expect(indexSource).not.toContain("model: 'google/gemini-3-flash-preview'");
  });

  it("при лимите или сбое основного api функция меняет его на запасной", () => {
    // Запасной путь общий для всех функций (_shared/gemini.ts): сначала выбранный
    // провайдер, затем второй бэкенд с перебором ключей пользователя и сервера.
    expect(indexSource).toContain("const order: Backend[] = [requestedProvider");
    expect(indexSource).toContain("geminiGenerate(attempts, geminiModels, geminiBody");
    expect(indexSource).toContain("parseServerKeys(Deno.env.get('GEMINI_API_KEYS'))");
    expect(sharedSource).toContain("generativelanguage.googleapis.com");
    // Выбранное клиентом api определяет модель и у прямого Gemini.
    expect(indexSource).toContain("toGoogleModel(aiModel)");
    // Оба бэкенда получают один промпт: формат реплик не зависит от выбора api.
    expect(indexSource).toContain("const SYSTEM_PROMPT = [");
    expect(indexSource).toContain("{ role: 'system', content: SYSTEM_PROMPT }");
    expect(indexSource).toContain("systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] }");
    // Маппинг живёт в parse.ts — чистой части функции, которую покрывают тесты.
    expect(parseSource).toContain("export const MANGA_MODEL_MAP");
    expect(parseSource).toContain("export function toAiModel");
    expect(parseSource).toContain("export function toGoogleModel");
  });
});
