import { describe, expect, it, vi } from "vitest";
import {
  buildAttempts,
  extractGenerateText,
  extractJsonText,
  extractTtsPcm,
  geminiGenerate,
  geminiGenerateStream,
  imageUrlToPart,
  parseProvider,
  parseServerKeys,
  providerResponseHeaders,
  readGeminiSseText,
  resolveClientKeys,
  resolveStartIndex,
} from "../../supabase/functions/_shared/gemini";

/** Мок fetch: очередь ответов (или ошибок) + журнал вызовов. */
function mockFetch(queue: Array<{ status: number; body?: unknown; raw?: string } | Error>) {
  const calls: { url: string; init: RequestInit }[] = [];
  let i = 0;
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = queue[Math.min(i++, queue.length - 1)];
    if (next instanceof Error) throw next;
    const text = next.raw ?? JSON.stringify(next.body ?? {});
    return new Response(text, { status: next.status });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const okGenerate = (text: string) => ({
  status: 200,
  body: { candidates: [{ content: { parts: [{ text }] } }] },
});

describe("shared/gemini: парсинг входа", () => {
  it("parseProvider: только явный gemini", () => {
    expect(parseProvider("gemini")).toBe("gemini");
    expect(parseProvider("lovable")).toBe("lovable");
    expect(parseProvider("gpt")).toBe("lovable");
    expect(parseProvider(undefined)).toBe("lovable");
    expect(parseProvider(null)).toBe("lovable");
  });

  it("resolveClientKeys фильтрует и обрезает до лимита", () => {
    expect(resolveClientKeys(["  k11111111  ", "short", 42, "", "k22222222"], 2)).toEqual([
      "k11111111",
      "k22222222",
    ]);
    expect(resolveClientKeys("not-array")).toEqual([]);
    expect(resolveClientKeys(undefined)).toEqual([]);
  });

  it("resolveStartIndex принимает только целые >= 0", () => {
    expect(resolveStartIndex(3)).toBe(3);
    expect(resolveStartIndex(0)).toBe(0);
    expect(resolveStartIndex(-1)).toBe(0);
    expect(resolveStartIndex(2.5)).toBe(0);
    expect(resolveStartIndex("x")).toBe(0);
    expect(resolveStartIndex(undefined)).toBe(0);
  });

  it("parseServerKeys режет по пробелам/запятым/переносам", () => {
    expect(parseServerKeys("a b,c\nd;e")).toEqual(["a", "b", "c", "d", "e"]);
    expect(parseServerKeys(undefined)).toEqual([]);
    expect(parseServerKeys("")).toEqual([]);
  });
});

describe("shared/gemini: очередь попыток", () => {
  it("ключи пользователя идут с активного индекса по кругу", () => {
    const attempts = buildAttempts(["A", "B", "C"], 1, ["S1"]);
    expect(attempts.map((a) => [a.key, a.source, a.userIndex])).toEqual([
      ["B", "user", 1],
      ["C", "user", 2],
      ["A", "user", 0],
      ["S1", "server", -1],
    ]);
  });

  it("индекс больше длины заворачивается", () => {
    const attempts = buildAttempts(["A", "B"], 5, []);
    expect(attempts.map((a) => a.key)).toEqual(["B", "A"]);
  });

  it("серверные дубли уже перебранных пропускаются", () => {
    const attempts = buildAttempts(["A"], 0, ["A", "S1"]);
    expect(attempts.map((a) => a.key)).toEqual(["A", "S1"]);
  });

  it("без ключей очередь пуста", () => {
    expect(buildAttempts([], 0, [])).toEqual([]);
  });

  it("providerResponseHeaders: индекс только для ключей пользователя", () => {
    expect(providerResponseHeaders("gemini", "user", 2)).toEqual({
      "x-ai-provider": "gemini",
      "x-ai-key-source": "user",
      "x-ai-key-index": "2",
    });
    expect(providerResponseHeaders("lovable", "lovable", -1)).toEqual({
      "x-ai-provider": "lovable",
      "x-ai-key-source": "lovable",
    });
  });
});

describe("shared/gemini: извлечение данных", () => {
  it("imageUrlToPart: base64 → inlineData, remote → текстовая пометка", () => {
    expect(imageUrlToPart("data:image/png;base64,AAA")).toEqual({
      inlineData: { mimeType: "image/png", data: "AAA" },
    });
    expect(imageUrlToPart("https://x/y.jpg")).toEqual({ text: "[изображение: https://x/y.jpg]" });
  });

  it("extractGenerateText склеивает текст без thought-частей", () => {
    const data = {
      candidates: [{ content: { parts: [{ text: "a" }, { text: "думаю", thought: true }, { text: "b" }] } }],
    };
    expect(extractGenerateText(data)).toBe("ab");
    expect(extractGenerateText({})).toBe("");
  });

  it("extractJsonText снимает markdown-обёртку", () => {
    expect(extractJsonText('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJsonText('{"a":1}')).toBe('{"a":1}');
  });

  it("extractTtsPcm достаёт байты и частоту из inlineData", () => {
    const data = {
      candidates: [
        { content: { parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: btoa("0123") } }] } },
      ],
    };
    const pcm = extractTtsPcm(data);
    expect(pcm).not.toBeNull();
    expect([...pcm!.bytes]).toEqual([48, 49, 50, 51]);
    expect(pcm!.sampleRate).toBe(24000);
    expect(pcm!.channels).toBe(1);
    expect(extractTtsPcm({ candidates: [{ content: { parts: [{ text: "hi" }] } }] })).toBeNull();
  });
});

describe("shared/gemini: ротация ключей и моделей", () => {
  it("успех с первого ключа возвращает метаданные попытки", async () => {
    const { fn, calls } = mockFetch([okGenerate("hi")]);
    const res = await geminiGenerate(buildAttempts(["A", "B"], 0, []), ["m1"], { a: 1 }, { fetchFn: fn });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(extractGenerateText(res.data)).toBe("hi");
    expect(res.source).toBe("user");
    expect(res.userIndex).toBe(0);
    expect(res.model).toBe("m1");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("models/m1:generateContent");
    expect(calls[0].url).toContain("key=A");
  });

  it("квота на первом ключе (429) → пробуется следующий", async () => {
    const { fn, calls } = mockFetch([{ status: 429, body: {} }, okGenerate("ok")]);
    const res = await geminiGenerate(buildAttempts(["A", "B"], 0, []), ["m1"], {}, { fetchFn: fn });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.userIndex).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toContain("key=B");
  });

  it("сетевая ошибка → следующий ключ", async () => {
    const { fn } = mockFetch([new Error("boom"), okGenerate("ok")]);
    const res = await geminiGenerate(buildAttempts(["A", "B"], 0, []), ["m1"], {}, { fetchFn: fn });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.userIndex).toBe(1);
  });

  it("404 → следующая модель без перебора остальных ключей", async () => {
    const { fn, calls } = mockFetch([{ status: 404, body: {} }, okGenerate("ok")]);
    const res = await geminiGenerate(buildAttempts(["A", "B"], 0, []), ["m1", "m2"], {}, { fetchFn: fn });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.model).toBe("m2");
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain("models/m1");
    expect(calls[1].url).toContain("models/m2");
  });

  it("400 фатально: один вызов, без ротации", async () => {
    const { fn, calls } = mockFetch([{ status: 400, raw: "bad request" }]);
    const res = await geminiGenerate(buildAttempts(["A", "B"], 0, []), ["m1", "m2"], {}, { fetchFn: fn });
    expect(res.ok).toBe(false);
    // NB: явное сравнение — falsy-сужение требует strictNullChecks (в проекте strict выключен).
    if (res.ok !== false) throw new Error("expected failure");
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(1);
  });

  it("все ключи и модели исчерпаны → failure с последним статусом", async () => {
    const { fn, calls } = mockFetch([{ status: 429, body: {} }]);
    const res = await geminiGenerate(buildAttempts(["A"], 0, ["S"]), ["m1", "m2"], {}, { fetchFn: fn });
    expect(res.ok).toBe(false);
    if (res.ok !== false) throw new Error("expected failure");
    expect(res.status).toBe(429);
    // 2 ключа × 2 модели
    expect(calls).toHaveLength(4);
  });

  it("без попыток fetch не вызывается", async () => {
    const { fn, calls } = mockFetch([okGenerate("x")]);
    const res = await geminiGenerate([], ["m1"], {}, { fetchFn: fn });
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("стрим возвращает upstream-ответ с метаданными", async () => {
    const { fn } = mockFetch([{ status: 429, body: {} }, { status: 200, raw: 'data: {"a":1}\n\n' }]);
    const res = await geminiGenerateStream(buildAttempts(["A", "B"], 0, []), ["m1"], {}, { fetchFn: fn });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.userIndex).toBe(1);
    expect(await res.resp.text()).toContain('"a":1');
  });
});

describe("shared/gemini: чтение SSE", () => {
  it("отдаёт текстовые дельты, thought — отдельно", async () => {
    const sse = [
      'data: {"candidates":[{"content":{"parts":[{"text":"Привет"}]}}]}',
      'data: {"candidates":[{"content":{"parts":[{"text":"хм","thought":true}]}}]}',
      'data: {"candidates":[{"content":{"parts":[{"text":" мир"}]}}]}',
      "",
    ].join("\n");
    const texts: string[] = [];
    const thoughts: string[] = [];
    await readGeminiSseText(
      new Response(sse),
      (t) => texts.push(t),
      (t) => thoughts.push(t),
    );
    expect(texts.join("")).toBe("Привет мир");
    expect(thoughts.join("")).toBe("хм");
  });

  it("битые строки игнорируются", async () => {
    const texts: string[] = [];
    await readGeminiSseText(new Response("data: {oops\n\ndata: [DONE]\n\n"), (t) => texts.push(t));
    expect(texts).toEqual([]);
  });
});
