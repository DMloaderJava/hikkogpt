import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_LIVE_MODEL, DEFAULT_LIVE_MODEL_FALLBACKS } from "@/types/gemini-live";

/**
 * Стражи блокеров Этапа 1. Все три проблемы были «тихими»: их не видно ни в
 * тестах, ни в сборке, а на проде они выглядят как «сессия не поднимается».
 *
 * Поэтому здесь проверяется не поведение, а конфигурация и константы, которые
 * легко случайно откатить: флаг verify_jwt у edge-функции, актуальность моделей
 * Live API и отказ от устаревшего поля realtimeInput.mediaChunks.
 *
 * Если тест упал — сначала посмотрите, не откатили ли осознанное решение
 * (см. docs/voice-mode.md, разделы P0/P1).
 */
const root = process.cwd();
const readSource = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("деплой edge-функции gemini-live", () => {
  it("отключает платформенную проверку JWT: браузерный WebSocket не шлёт Authorization", () => {
    const config = readSource("supabase/config.toml");
    const section = config.match(/\[functions\.gemini-live\]([\s\S]*?)(?=\n\[|$)/);

    expect(section, "в supabase/config.toml нет секции [functions.gemini-live]").not.toBeNull();
    expect(section![1]).toMatch(/verify_jwt\s*=\s*false/);
  });

  it("оставляет функцию доступной по WebSocket-апгрейду (426, а не 401)", () => {
    const proxy = readSource("supabase/functions/gemini-live/index.ts");

    expect(proxy).toContain('req.headers.get("upgrade")');
    expect(proxy).toContain("426");
    // Токен приходит query-параметром и валидируется внутри функции.
    expect(proxy).toContain('url.searchParams.get("token")');
    expect(proxy).toContain("getUser(token)");
  });
});

describe("модели Live API", () => {
  const proxy = readSource("supabase/functions/gemini-live/index.ts");

  it("дефолт совпадает с DEFAULT_LIVE_MODEL в типах приложения", () => {
    expect(proxy).toContain(`Deno.env.get("GEMINI_LIVE_MODEL") || "${DEFAULT_LIVE_MODEL}"`);
    expect(DEFAULT_LIVE_MODEL).toBe("models/gemini-3.1-flash-live-preview");
  });

  it("содержит все фолбэки из общего списка", () => {
    for (const model of DEFAULT_LIVE_MODEL_FALLBACKS) {
      expect(proxy, `в MODELS нет ${model}`).toContain(`"${model}"`);
    }
  });

  it("не ставит снятую с эксплуатации модель первой в ротации", () => {
    const envFallback = proxy.indexOf(`Deno.env.get("GEMINI_LIVE_MODEL") || "${DEFAULT_LIVE_MODEL}"`);
    const legacy = proxy.indexOf('"models/gemini-2.0-flash-live-001"');

    expect(envFallback).toBeGreaterThan(-1);
    expect(legacy).toBeGreaterThan(-1);
    // 09.12.2025 Google отключил gemini-2.0-flash-live-001 и
    // gemini-live-2.5-flash-preview: они допустимы только как страховка в конце.
    expect(legacy).toBeGreaterThan(envFallback);
  });

  it("считает сессию поднятой только по setupComplete, а не по onopen", () => {
    expect(proxy).toContain('"setupComplete" in parsed');
    expect(proxy).toContain("sessionReady");
    // watchdog: без него попытка с недоступной моделью висит вечно.
    expect(proxy).toContain("SETUP_TIMEOUT_MS");
  });
});

describe("протокол микрофона", () => {
  it("использует поле realtimeInput.audio, а не устаревший mediaChunks", () => {
    const hook = readSource("src/hooks/useGeminiLive.ts");
    const types = readSource("src/types/gemini-live.ts");

    // Упоминание в комментариях допустимо — важно, чтобы поля не было в кадре.
    expect(types).not.toMatch(/mediaChunks\s*:/);
    expect(hook).not.toMatch(/mediaChunks\s*:/);
    expect(types).toContain("audio: {");
    expect(hook).toContain("audio: {");
  });

  it("объявляет и разбирает фреймы прокси (sessionClosed / upstreamError)", () => {
    const hook = readSource("src/hooks/useGeminiLive.ts");
    const types = readSource("src/types/gemini-live.ts");

    for (const field of ["sessionClosed", "upstreamError"]) {
      expect(types).toContain(field);
      expect(hook).toContain(field);
    }
  });
});
