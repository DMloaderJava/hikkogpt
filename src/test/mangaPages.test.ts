import { describe, expect, it, vi } from "vitest";
import {
  ANALYZE_BATCH_SIZE,
  MAX_PAGE_DATA_URL_BYTES,
  MAX_PAGE_FILE_BYTES,
  MAX_PAGE_SIDE_PX,
  computeScaledSize,
  estimateDataURLBytes,
  filterPageFiles,
  formatRejections,
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
