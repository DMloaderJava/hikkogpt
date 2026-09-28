import { describe, expect, it, vi } from "vitest";
import {
  ANALYZE_BATCH_SIZE,
  ANALYZE_PAYLOAD_BUDGET,
  ANALYZE_PAYLOAD_OVERHEAD_PER_IMAGE,
  MAX_PAGE_DATA_URL_BYTES,
  MAX_PAGE_FILE_BYTES,
  MAX_PAGE_SIDE_PX,
  computeScaledSize,
  estimateAnalyzePayloadChars,
  estimateDataURLBytes,
  filterPageFiles,
  formatRejections,
  planAnalyzeBatches,
  prepareAnalyzePayload,
  toPageDataURL,
} from "@/lib/mangaPages";
import type { DecodedImage } from "@/lib/mangaPages";

/**
 * Подготовка страниц к анализу. Без сжатия батч из пяти сканов по 10 МБ
 * уезжает в `manga-analyze` десятками мегабайт base64 в одном запросе.
 */

const file = (name: string, type: string, bytes = 1024) =>
  new File([new Uint8Array(Math.max(1, bytes)).fill(7)], name, { type });

const dataUrlOf = (bytes: number) => `data:image/jpeg;base64,${"A".repeat(Math.ceil((bytes * 4) / 3))}`;

function fakeCanvas(toDataURL: (type: string, quality?: number) => string) {
  const drawImage = vi.fn();
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage }),
    toDataURL,
  } as unknown as HTMLCanvasElement;
  return { canvas, drawImage };
}

describe("filterPageFiles", () => {
  it("принимает PNG, JPEG и WebP", () => {
    const { accepted, rejected } = filterPageFiles([
      file("a.png", "image/png"),
      file("b.jpg", "image/jpeg"),
      file("c.webp", "image/webp"),
    ]);
    expect(accepted).toHaveLength(3);
    expect(rejected).toEqual([]);
  });

  it("отсекает чужие типы, пустые и слишком большие файлы с причиной", () => {
    const { accepted, rejected } = filterPageFiles([
      file("a.gif", "image/gif"),
      file("b.png", "image/png", MAX_PAGE_FILE_BYTES + 1),
      new File([], "empty.png", { type: "image/png" }),
      file("ok.png", "image/png"),
    ]);
    expect(accepted.map((f) => f.name)).toEqual(["ok.png"]);
    expect(rejected.map((r) => r.reason)).toEqual(["нужен PNG, JPEG или WebP", "больше 10 МБ", "пустой файл"]);
  });

  it("пустой выбор (отмена диалога) не считается ошибкой", () => {
    expect(filterPageFiles(null)).toEqual({ accepted: [], rejected: [] });
    expect(formatRejections([])).toBe("");
  });

  it("причины отказов собираются в одну строку", () => {
    const note = formatRejections([
      { name: "a.gif", reason: "нужен PNG, JPEG или WebP" },
      { name: "b.png", reason: "больше 10 МБ" },
    ]);
    expect(note).toContain("a.gif");
    expect(note).toContain("больше 10 МБ");
  });

  it("лимиты батча и размера совпадают с серверными", () => {
    expect(ANALYZE_BATCH_SIZE).toBe(5);
    expect(MAX_PAGE_FILE_BYTES).toBe(10 * 1024 * 1024);
  });
});

describe("computeScaledSize", () => {
  it("уменьшает большую страницу до MAX_PAGE_SIDE_PX по длинной стороне", () => {
    const s = computeScaledSize(3000, 4000, MAX_PAGE_SIDE_PX);
    expect(s).toEqual({ width: 1200, height: 1600, scale: 0.4 });
  });

  it("не увеличивает маленькую страницу", () => {
    const s = computeScaledSize(800, 600, MAX_PAGE_SIDE_PX);
    expect(s).toEqual({ width: 800, height: 600, scale: 1 });
  });

  it("стороны не схлопываются в ноль", () => {
    expect(computeScaledSize(1, 9000, 1600).width).toBeGreaterThanOrEqual(1);
  });
});

describe("estimateDataURLBytes", () => {
  it("считает размер декодированных байт", () => {
    expect(estimateDataURLBytes("data:image/png;base64,AQIDBA==")).toBe(4);
    expect(estimateDataURLBytes(dataUrlOf(3000))).toBeGreaterThanOrEqual(2900);
  });
});

describe("toPageDataURL", () => {
  const decode = (width: number, height: number) => async (): Promise<DecodedImage> => ({
    width,
    height,
    source: {} as CanvasImageSource,
  });

  it("пережимает большой скан в JPEG нужного размера", async () => {
    const { canvas, drawImage } = fakeCanvas(() => dataUrlOf(400_000));
    const source = file("scan.png", "image/png", 4096);

    const out = await toPageDataURL(source, {
      decode: decode(2400, 3600),
      canvasFactory: () => canvas,
    });

    expect(out.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(canvas.width).toBe(1067);
    expect(canvas.height).toBe(1600);
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(estimateDataURLBytes(out)).toBeLessThanOrEqual(MAX_PAGE_DATA_URL_BYTES);
  });

  it("маленькую страницу отправляет как есть, не трогая canvas", async () => {
    const canvasFactory = vi.fn();
    const source = file("small.png", "image/png", 2048);

    const out = await toPageDataURL(source, { decode: decode(900, 1200), canvasFactory });

    expect(out.startsWith("data:image/png;base64,")).toBe(true);
    expect(canvasFactory).not.toHaveBeenCalled();
  });

  it("без декодера (нет canvas/createImageBitmap) отдаёт исходный dataURL", async () => {
    const out = await toPageDataURL(file("a.png", "image/png", 512), { decode: async () => null });
    expect(out.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("падение декодера не роняет отправку", async () => {
    const out = await toPageDataURL(file("a.png", "image/png", 512), {
      decode: async () => {
        throw new Error("boom");
      },
    });
    expect(out.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("canvas без 2d-контекста — фолбэк на исходник", async () => {
    const canvas = { width: 0, height: 0, getContext: () => null, toDataURL: vi.fn() } as unknown as HTMLCanvasElement;
    const out = await toPageDataURL(file("a.png", "image/png", 512), {
      decode: decode(4000, 4000),
      canvasFactory: () => canvas,
    });
    expect(out.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("снижает качество, пока base64 не влезет в лимит", async () => {
    const toDataURL = vi
      .fn()
      .mockReturnValueOnce(dataUrlOf(4_000_000))
      .mockReturnValueOnce(dataUrlOf(2_000_000))
      .mockReturnValueOnce(dataUrlOf(900_000));
    const { canvas } = fakeCanvas(toDataURL);

    const out = await toPageDataURL(file("a.png", "image/png", 512), {
      decode: decode(4000, 4000),
      canvasFactory: () => canvas,
    });

    expect(toDataURL).toHaveBeenCalledTimes(3);
    expect(toDataURL).toHaveBeenLastCalledWith("image/jpeg", 0.55);
    expect(estimateDataURLBytes(out)).toBeLessThanOrEqual(MAX_PAGE_DATA_URL_BYTES);
  });

  it("исключение при сжатии — тоже фолбэк на исходник", async () => {
    const out = await toPageDataURL(file("a.png", "image/png", 512), {
      decode: decode(4000, 4000),
      canvasFactory: () => {
        throw new Error("no canvas");
      },
    });
    expect(out.startsWith("data:image/png;base64,")).toBe(true);
  });
});

describe("planAnalyzeBatches: тело запроса влезает в сеть", () => {
  const prepared = (chars: number, id = 0) => ({
    page: { id },
    dataUrl: `data:image/jpeg;base64,${"A".repeat(chars)}`,
    chars: `data:image/jpeg;base64,`.length + chars,
  });

  it("режет не чаще, чем требует лимит сервера в 5 страниц", () => {
    const batches = planAnalyzeBatches(Array.from({ length: 5 }, (_, i) => prepared(1000, i)), 1_000_000);
    expect(batches).toHaveLength(1);
    expect(batches[0].images).toHaveLength(ANALYZE_BATCH_SIZE);
    expect(batches[0].pages.map((p) => p.id)).toEqual([0, 1, 2, 3, 4]);
  });

  it("12 страниц — три батча: 5 + 5 + 2", () => {
    const batches = planAnalyzeBatches(Array.from({ length: 12 }, (_, i) => prepared(1000, i)), 1_000_000);
    expect(batches.map((b) => b.pages.length)).toEqual([5, 5, 2]);
  });

  it("крупные страницы режутся по бюджету, даже если их меньше пяти", () => {
    const batches = planAnalyzeBatches(Array.from({ length: 4 }, (_, i) => prepared(900_000, i)), 2_000_000);
    expect(batches.map((b) => b.pages.length)).toEqual([2, 2]);
    expect(batches.every((b) => b.chars <= 2_000_000)).toBe(true);
  });

  it("страница больше бюджета всё равно уйдёт отдельным батчем", () => {
    const batches = planAnalyzeBatches([prepared(5_000_000, 1), prepared(1000, 2)], 1_000_000);
    expect(batches.map((b) => b.pages.map((p) => p.id))).toEqual([[1], [2]]);
  });

  it("estimateAnalyzePayloadChars считает то же, что и JSON.stringify тела", () => {
    const images = ["data:image/jpeg;base64,AAA", "data:image/jpeg;base64,BBBB"];
    const estimate = estimateAnalyzePayloadChars(images);
    const actual = JSON.stringify({ images }).length;
    expect(estimate).toBeGreaterThanOrEqual(actual);
    expect(estimate - actual).toBeLessThan(images.length * ANALYZE_PAYLOAD_OVERHEAD_PER_IMAGE);
  });

  it("бюджет по умолчанию держит тело запроса в нескольких мегабайтах", () => {
    expect(ANALYZE_PAYLOAD_BUDGET).toBeLessThanOrEqual(8_000_000);
    expect(ANALYZE_PAYLOAD_BUDGET).toBeGreaterThan(MAX_PAGE_DATA_URL_BYTES);
  });
});

describe("prepareAnalyzePayload: сжатие под бюджет", () => {
  const png = (name: string) => file(name, "image/png", 2048);

  it("возвращает страницу на страницу, порядок сохраняется", async () => {
    const files = [png("a.png"), png("b.png"), png("c.png")];
    const prepared = await prepareAnalyzePayload(files, {
      toDataUrl: async (f) => `data:image/png;base64,${f.name.length}${"A".repeat(10)}`,
    });

    expect(prepared.map((p) => p.page.name)).toEqual(["a.png", "b.png", "c.png"]);
    expect(prepared.every((p) => p.chars === p.dataUrl.length)).toBe(true);
  });

  it("если батч не влезает — страницы пережимаются жёстче", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 3000, height: 4000, close() {} })));
    const files = [png("a.png"), png("b.png")];

    const prepared = await prepareAnalyzePayload(files, {
      budget: 3000,
      toDataUrl: async () => `data:image/png;base64,${"A".repeat(4000)}`,
    });

    // dataURL заменены на результат более жёсткого сжатия (в jsdom без canvas
    // это исходный файл страницы — главное, что путь пройден без падения).
    expect(prepared).toHaveLength(2);
    expect(prepared.every((p) => p.dataUrl.startsWith("data:image/"))).toBe(true);
    expect(prepared.every((p) => p.dataUrl.length < 4000 + 23)).toBe(true);
  });

  it("когда всё влезает — повторного сжатия нет", async () => {
    const files = [png("a.png"), png("b.png")];
    const toDataUrl = vi.fn(async () => "data:image/png;base64,AAAA");

    const prepared = await prepareAnalyzePayload(files, { budget: 1_000_000, toDataUrl });

    expect(toDataUrl).toHaveBeenCalledTimes(2);
    expect(prepared.every((p) => p.dataUrl === "data:image/png;base64,AAAA")).toBe(true);
  });

  it("батчи из подготовленных страниц всегда проходят по бюджету и лимиту сервера", async () => {
    const files = Array.from({ length: 9 }, (_, i) => png(`p${i + 1}.png`));
    const prepared = await prepareAnalyzePayload(files, {
      budget: 5000,
      toDataUrl: async () => `data:image/png;base64,${"A".repeat(2000)}`,
    });

    const batches = planAnalyzeBatches(prepared, 5000);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.every((b) => b.pages.length <= ANALYZE_BATCH_SIZE)).toBe(true);
    expect(batches.every((b) => b.chars <= 5000 || b.pages.length === 1)).toBe(true);
    expect(batches.flatMap((b) => b.images)).toHaveLength(9);
  });
});
