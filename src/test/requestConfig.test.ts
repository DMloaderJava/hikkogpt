import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ANALYZE_PAYLOAD_BUDGET, MAX_PAGE_DATA_URL_BYTES } from "@/lib/mangaPages";
import { EDGE_TIMEOUT_MS } from "@/lib/edgeAuth";

/**
 * Стражи настройки запросов: то, что чинит «Failed to fetch» на стороне клиента,
 * не должно тихо разъехаться при правках. Проверяем исходники так же, как это
 * делают `mangaAnalyze.test.ts` и `voiceModeConfig.test.ts`.
 */

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

const edgeAuth = read("src/lib/edgeAuth.ts");
const viteConfig = read("vite.config.ts");
const mangaVoice = read("src/hooks/useMangaVoice.ts");
const mangaModal = read("src/components/MangaVoiceModal.tsx");
const useChat = read("src/hooks/useChat.ts");

describe("dev-прокси для edge-функций", () => {
  it("в dev запросы идут на свой origin", () => {
    expect(edgeAuth).toContain('import.meta.env.DEV ? "/functions/v1" : SUPABASE_FUNCTIONS_URL');
  });

  it("vite проксирует /functions/v1 на Supabase с тем же путём", () => {
    expect(viteConfig).toContain('"/functions/v1"');
    expect(viteConfig).toContain("functions/v1`");
    expect(viteConfig).toContain("changeOrigin: true");
    expect(viteConfig).toContain("loadEnv(mode, process.cwd()");
  });

  it("в сборке остаётся абсолютный адрес проекта", () => {
    expect(edgeAuth).toContain("SUPABASE_FUNCTIONS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`");
  });
});

describe("таймаут и повтор запроса", () => {
  it("таймаут ограничен установкой ответа и снимается после заголовков", () => {
    expect(edgeAuth).toContain("linked.clearTimeout()");
    expect(edgeAuth).toContain("timedOut");
    expect(EDGE_TIMEOUT_MS).toBeGreaterThan(120_000); // серверный таймаут manga-analyze
  });

  it("связь с внешним сигналом живёт дольше заголовков — «Стоп» рвёт тело", () => {
    expect(edgeAuth).toContain("external?.removeEventListener(\"abort\", onExternalAbort)");
    expect(edgeAuth).not.toMatch(/linked\.release\(\);\s*\n\s*if \(!res\.ok\)/);
  });

  it("сетевой сбой повторяется один раз, отмена и ошибка сервера — нет", () => {
    expect(edgeAuth).toContain("const attempts = 2");
    expect(edgeAuth).toContain("isTransient");
    expect(edgeAuth).toContain("isAbortError(e, options.signal)");
    expect(edgeAuth).toContain("if (options.signal?.aborted) throw");
  });

  it("«Failed to fetch» не показывается пользователю как есть", () => {
    expect(edgeAuth).toContain("NETWORK_ERROR_MESSAGE");
    expect(edgeAuth).toContain("TIMEOUT_ERROR_MESSAGE");
    expect(edgeAuth).not.toContain('message: "Failed to fetch"');
  });
});

describe("размер тела запроса manga-analyze", () => {
  it("батчи планируются по фактическому payload, а не только по числу страниц", () => {
    expect(mangaVoice).toContain("prepareAnalyzePayload(queue)");
    expect(mangaVoice).toContain("planAnalyzeBatches(payload)");
    expect(mangaVoice).toContain("images: batch.images");
  });

  it("бюджет тела запроса заметно меньше «пяти страниц по максимуму»", () => {
    expect(ANALYZE_PAYLOAD_BUDGET).toBeLessThan(5 * MAX_PAGE_DATA_URL_BYTES);
  });

  it("страницы, из-за которых батч не влезает, пережимаются жёстче", () => {
    expect(read("src/lib/mangaPages.ts")).toContain("ANALYZE_FALLBACK_MAX_BYTES");
  });
});

describe("остановка запросов в UI", () => {
  it("в озвучивателе манги есть «Стоп» — общий и по кадру", () => {
    expect(mangaModal).toContain('data-testid="manga-stop"');
    expect(mangaModal).toContain('data-testid={`manga-stop-${i + 1}`}');
    expect(mangaModal).toMatch(/onClick=\{stop\}/);
  });

  it("отправка сообщения использует тот же слой запросов", () => {
    expect(useChat).toContain("edgeRequest(CHAT_FN");
    expect(useChat).toContain("isAbortError(e, controller.signal)");
  });
});
