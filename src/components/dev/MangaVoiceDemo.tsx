import { useEffect, useRef, useState } from "react";
import { BookOpen } from "lucide-react";
import { MangaVoiceModal } from "@/components/MangaVoiceModal";
import { EDGE_FUNCTIONS_URL } from "@/lib/edgeAuth";
import { ANALYZE_BATCH_SIZE } from "@/lib/mangaPages";

/**
 * Дев-стенд озвучивателя манги: открывается по хэшу #manga-preview (см. App.tsx).
 *
 * Фича живёт за авторизацией и зависит от двух edge-функций (`manga-analyze`,
 * `dialog-tts`), а посмотреть на метод запросов хочется без входа и без ключей.
 * Поэтому здесь подменяется только fetch в `functions/v1/*`: ответы приходят те
 * же по форме, что и с сервера, задержки и сбои включаются кнопками. Всё
 * остальное (хук `useMangaVoice`, модалка, плееры) — настоящий код.
 *
 * В production-сборку файл не попадает: ветка в App.tsx под import.meta.env.DEV.
 */

type Scenario = "ok" | "slow" | "analyzeError" | "ttsError" | "hang";

const SCENARIOS: { id: Scenario; label: string; hint: string }[] = [
  { id: "ok", label: "Успешный ответ", hint: "анализ и озвучка возвращаются сразу" },
  { id: "slow", label: "Медленный ответ", hint: "задержка 4 с — видно «Стоп» и прогресс батчей" },
  { id: "analyzeError", label: "Ошибка анализа", hint: "manga-analyze отвечает 502 с текстом сервера" },
  { id: "ttsError", label: "Ошибка озвучки", hint: "dialog-tts отвечает 429 с текстом сервера" },
  { id: "hang", label: "Запрос висит", hint: "ответ не приходит, пока не нажмёте «Стоп»" },
];

let scenario: Scenario = "ok";
const log: string[] = [];
const listeners = new Set<() => void>();

function pushLog(line: string) {
  log.unshift(`${new Date().toLocaleTimeString()} · ${line}`);
  if (log.length > 12) log.pop();
  listeners.forEach((fn) => fn());
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 1×1 px PNG, из которого «сканы» для стенда делаются нужного размера. */
async function samplePageFile(index: number): Promise<File> {
  const canvas = document.createElement("canvas");
  canvas.width = 900;
  canvas.height = 1300;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = index % 2 ? "#1b1b22" : "#232330";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#f5f5f7";
    ctx.font = "64px sans-serif";
    ctx.fillText(`Страница ${index + 1}`, 60, 140);
    for (let i = 0; i < 3; i += 1) {
      ctx.strokeStyle = "#5b5bd6";
      ctx.lineWidth = 6;
      ctx.strokeRect(60, 220 + i * 340, 780, 300);
    }
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  return new File([blob ?? new Blob(["sample"], { type: "image/png" })], `sample-page-${index + 1}.png`, {
    type: "image/png",
  });
}

const json = (data: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => data,
});

/** Тишина на 1 кГц — достаточно, чтобы плеер показал длительность. */
async function wavBlob(seconds = 2) {
  const sampleRate = 24000;
  const frames = sampleRate * seconds;
  const bytes = new Uint8Array(44 + frames * 2);
  const view = new DataView(bytes.buffer);
  const write = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + frames * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i += 1) {
    view.setInt16(44 + i * 2, Math.round(Math.sin((i / sampleRate) * 2 * Math.PI * 220) * 4000), true);
  }
  return new Blob([bytes], { type: "audio/wav" });
}

async function simulatedResponse(fn: string, body: { images?: string[] }, signal?: AbortSignal | null) {
  if (scenario === "hang") {
    pushLog(`${fn}: запрос завис (ждем «Стоп»)· signal=${signal ? "есть" : "НЕТ"}`);
    return new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    });
  }

  if (scenario === "slow") await wait(4000);

  if (fn === "manga-analyze") {
    const count = body.images?.length ?? 0;
    pushLog(`${fn}: ${count} страниц · signal=${signal ? "есть" : "НЕТ"}`);
    if (scenario === "analyzeError") return json({ error: "Сервис анализа недоступен" }, 502);
    return json({
      pages: Array.from({ length: count }, (_, i) => ({
        description: `Кадр ${i + 1}: Аки приходит в академию, Денджи ворчит.`,
        transcript: ["Рассказчик: Утро в Токио.", "Аки: Ты снова опоздал.", "Денджи: Я не опоздал, я пришёл вовремя — просто поздно."].join(
          "\n"
        ),
      })),
    });
  }

  pushLog(`${fn}: transcript=${(body as { transcript?: string }).transcript?.split("\n").length ?? 0} реплик`);
  if (scenario === "ttsError") return json({ error: "Слишком много запросов, попробуйте чуть позже." }, 429);
  return { ok: true, status: 200, blob: async () => wavBlob() };
}

if (typeof window !== "undefined" && !(window as unknown as { __mangaPreviewPatched?: boolean }).__mangaPreviewPatched) {
  const realFetch = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    // Ловим любой вызов edge-функций: и по URL из .env, и если страница открыта
    // на другом хосте (превью) с иным проектом Supabase.
    const marker = "/functions/v1/";
    const at = url.indexOf(marker);
    const isEdge = url.startsWith(EDGE_FUNCTIONS_URL) || at >= 0;
    if (!isEdge) return realFetch(input as RequestInfo, init);
    const fn = url.slice(at >= 0 ? at + marker.length : EDGE_FUNCTIONS_URL.length + 1).split(/[?#/]/)[0];
    const body = init?.body ? (JSON.parse(String(init.body)) as { images?: string[] }) : {};
    return simulatedResponse(fn, body, init?.signal) as unknown as Response;
  }) as typeof fetch;
  (window as unknown as { __mangaPreviewPatched?: boolean }).__mangaPreviewPatched = true;
}

export function MangaVoiceDemo() {
  const [open, setOpen] = useState(true);
  const [, force] = useState(0);
  const samplesRef = useRef(0);

  // Перерисовываем стенд, когда журнал запросов пополняется.
  useEffect(() => {
    const listener = () => force((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const addSamples = async () => {
    const start = samplesRef.current;
    samplesRef.current = start + 3;
    const files = await Promise.all([0, 1, 2].map((i) => samplePageFile(start + i)));
    const input = document.querySelector<HTMLInputElement>('[data-testid="manga-file-input"]');
    if (!input) return;
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    pushLog(`добавлено ${files.length} тестовых страниц`);
  };

  const active = SCENARIOS.find((s) => s.id === scenario)!;

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <div className="border-b border-border px-4 py-3">
        <h1 className="flex items-center gap-2 text-sm font-semibold">
          <BookOpen className="h-4 w-4 text-interactive" />
          Дев-стенд: озвучиватель манги
        </h1>
        <p className="mt-1 text-xs text-muted-foreground">
          Запросы к <code className="text-foreground">manga-analyze</code> и{" "}
          <code className="text-foreground">dialog-tts</code> здесь имитируются, весь клиентский код — настоящий:
          видны батчи, «Стоп», тексты ошибок и то, что каждый запрос уходит со своим{" "}
          <code className="text-foreground">signal</code>. Сейчас: {active.label} ({active.hint}).
        </p>
        <p className="mt-1 text-[11px] text-muted-foreground">
          Настоящие edge-функции в песочнице предпросмотра недоступны — исходящие соединения к{" "}
          <code>*.supabase.co</code> закрыты, браузер в таких условиях и показывает «Failed to fetch».
          Локально и на проде запросы идут через dev-прокси Vite (свой origin) и работают как обычно.
        </p>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            onClick={addSamples}
            className="rounded-lg bg-interactive px-3 py-1.5 text-xs text-interactive-foreground transition-all hover:opacity-90"
          >
            Добавить 3 тестовых страницы
          </button>
          <button
            onClick={() => setOpen(true)}
            className="rounded-lg bg-interactive/10 px-3 py-1.5 text-xs text-interactive transition-all hover:bg-interactive/20"
          >
            Открыть окно
          </button>
          {SCENARIOS.map((s) => (
            <button
              key={s.id}
              onClick={() => {
                scenario = s.id;
                pushLog(`сценарий: ${s.label}`);
                force((n) => n + 1);
              }}
              title={s.hint}
              className={`rounded-lg px-3 py-1.5 text-xs transition-all ${
                scenario === s.id
                  ? "bg-interactive/20 text-interactive"
                  : "bg-secondary/60 text-muted-foreground hover:text-foreground"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground">
          Анализ идёт батчами по {ANALYZE_BATCH_SIZE} страниц: добавьте 6+, чтобы увидеть очередь и «Стоп».
        </p>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        <p className="mb-2 text-xs font-medium text-muted-foreground">Журнал запросов</p>
        {log.length === 0 ? (
          <p className="text-sm text-muted-foreground">Запросов ещё не было.</p>
        ) : (
          <ul className="space-y-1.5">
            {log.map((line, i) => (
              <li key={i} className="rounded-lg bg-secondary/60 px-3 py-2 font-mono text-xs">
                {line}
              </li>
            ))}
          </ul>
        )}
      </div>

      <MangaVoiceModal open={open} onClose={() => setOpen(false)} />
    </div>
  );
}
