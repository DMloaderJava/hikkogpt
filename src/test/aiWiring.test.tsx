import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useAiProvider } from "@/hooks/useAiProvider";
import { useUserApiKeys } from "@/hooks/useUserApiKeys";
import { useDeepSearch } from "@/hooks/useDeepSearch";
import { syncActiveKeyFromHeaders, syncActiveKeyFromMeta } from "@/lib/aiKeySync";
import { setStoredUserKeys, setStoredUserKeyIndex } from "@/lib/userApiKeys";
import { setStoredAiProvider } from "@/types/ai-provider";

vi.mock("@/lib/edgeAuth", () => ({
  getEdgeAuthHeaders: async () => ({ Authorization: "Bearer test" }),
}));

const root = process.cwd();
const readSource = (path: string) => readFileSync(resolve(root, path), "utf8");

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("aiKeySync", () => {
  it("syncActiveKeyFromHeaders запоминает сработавший ключ пользователя", () => {
    const setIndex = vi.fn();
    const headers = new Headers({ "x-ai-key-source": "user", "x-ai-key-index": "2" });
    expect(syncActiveKeyFromHeaders(headers, setIndex)).toEqual({ source: "user", index: 2 });
    expect(setIndex).toHaveBeenCalledWith(2);
  });

  it("syncActiveKeyFromHeaders игнорирует серверные и битые значения", () => {
    const setIndex = vi.fn();
    syncActiveKeyFromHeaders(new Headers({ "x-ai-key-source": "server" }), setIndex);
    syncActiveKeyFromHeaders(new Headers({ "x-ai-key-source": "user", "x-ai-key-index": "oops" }), setIndex);
    syncActiveKeyFromHeaders(new Headers({}), setIndex);
    syncActiveKeyFromHeaders(undefined, setIndex);
    syncActiveKeyFromHeaders(null, setIndex);
    expect(setIndex).not.toHaveBeenCalled();
  });

  it("syncActiveKeyFromMeta разбирает meta-событие стрима", () => {
    const setIndex = vi.fn();
    expect(syncActiveKeyFromMeta({ keySource: "user", keyIndex: 4 }, setIndex)).toBe("user");
    expect(setIndex).toHaveBeenCalledWith(4);
    expect(syncActiveKeyFromMeta({ keySource: "server", keyIndex: -1 }, setIndex)).toBe("server");
  });
});

describe("хуки: синхронизация между экземплярами", () => {
  it("useUserApiKeys: индекс из одного экземпляра виден в другом", () => {
    setStoredUserKeys(["k11111111", "k22222222", "k33333333"]);
    const a = renderHook(() => useUserApiKeys());
    const b = renderHook(() => useUserApiKeys());
    act(() => {
      a.result.current.setActiveIndex(2);
    });
    expect(a.result.current.activeIndex).toBe(2);
    expect(b.result.current.activeIndex).toBe(2);
  });

  it("useUserApiKeys: добавление ключа видно во всех экземплярах", () => {
    const a = renderHook(() => useUserApiKeys());
    const b = renderHook(() => useUserApiKeys());
    act(() => {
      a.result.current.addKeysFromText("k11111111");
    });
    expect(b.result.current.keys).toEqual(["k11111111"]);
  });

  it("useAiProvider: выбор провайдера расходится по экземплярам", () => {
    const a = renderHook(() => useAiProvider());
    const b = renderHook(() => useAiProvider());
    act(() => {
      a.result.current.setProvider("gemini");
    });
    expect(b.result.current.provider).toBe("gemini");
  });
});

describe("useDeepSearch: провайдер и ключи в запросах", () => {
  it("clarify отправляет provider/userKeys/userKeyIndex и применяет ответный индекс", async () => {
    setStoredAiProvider("gemini");
    setStoredUserKeys(["k11111111", "k22222222", "k33333333"]);
    setStoredUserKeyIndex(1);

    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ questions: ["q1"] }), {
        status: 200,
        headers: { "x-ai-key-source": "user", "x-ai-key-index": "2" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useDeepSearch());
    await act(async () => {
      await result.current.startClarify("тема");
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sentInit = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    const sentBody = JSON.parse(sentInit.body as string);
    expect(sentBody).toMatchObject({
      action: "clarify",
      query: "тема",
      provider: "gemini",
      userKeys: ["k11111111", "k22222222", "k33333333"],
      userKeyIndex: 1,
    });
    // Сервер сообщил сработавший ключ — индекс обновился везде.
    expect(result.current.deepSearch.questions).toEqual(["q1"]);
    expect(localStorage.getItem("hikko-gemini-user-key-index")).toBe("2");
  });
});

describe("всё на gemini: проводка edge-функций", () => {
  const cases: Array<[string, string[]]> = [
    [
      "supabase/functions/deepsearch/index.ts",
      [
        "../_shared/gemini",
        "parseProvider",
        "withBackendFallback",
        "generateClarifyingQuestionsGemini",
        "generateSearchQueriesGemini",
        "streamAnalystGemini",
        'sendSSE(controller, encoder, "meta"',
      ],
    ],
    [
      "supabase/functions/dialog-tts/index.ts",
      ["../_shared/gemini", "parseProvider", "synthGemini", "extractTtsPcm", "GEMINI_TTS_MODELS"],
    ],
    [
      "supabase/functions/gemini-tts/index.ts",
      ["../_shared/gemini", "parseProvider", "GEMINI_TTS_MODELS", "extractTtsPcm"],
    ],
    [
      "supabase/functions/manga-analyze/index.ts",
      ["../_shared/gemini", "parseProvider", "imageUrlToPart", "VISION_MODELS", "extractGenerateText"],
    ],
  ];

  for (const [path, markers] of cases) {
    it(`${path} маршрутизирует по провайдеру`, () => {
      const src = readSource(path);
      for (const marker of markers) {
        expect(src, `${path}: нет ${marker}`).toContain(marker);
      }
      // Сообщает фронтенду фактический бэкенд.
      expect(src).toContain("providerResponseHeaders");
      expect(src).toContain("Access-Control-Expose-Headers");
    });
  }
});

describe("всё на gemini: проводка фронтенда", () => {
  it("глубокий поиск, озвучка и манга отправляют provider и ключи", () => {
    for (const path of [
      "src/hooks/useDeepSearch.ts",
      "src/components/MessageBubble.tsx",
      "src/components/DialogTtsModal.tsx",
      "src/components/MangaVoiceModal.tsx",
    ]) {
      const src = readSource(path);
      expect(src, `${path}: нет provider`).toContain("provider");
      expect(src, `${path}: нет userKeys`).toContain("userKeys");
      expect(src, `${path}: нет userKeyIndex`).toContain("userKeyIndex");
      expect(src, `${path}: нет syncActiveKey`).toContain("syncActiveKey");
    }
  });
});
