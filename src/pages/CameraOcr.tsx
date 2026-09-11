import { useEffect } from "react";
import { mountCameraOcr } from "@/lib/cameraOcr";

/**
 * Страница «Камера + распознавание текста».
 *
 * Разметка — ровно те ID, которые ждёт модуль `@/lib/cameraOcr`
 * (см. `mountCameraOcr`): видео, скрытый холст, кнопки, статус, прогресс,
 * лоадер и выбор языка. Сам компонент не хранит состояния — всю динамику
 * (видео, текст, статус, прогресс) обновляет модуль напрямую в DOM,
 * поэтому React-рендер здесь статичен и не конфликтует с ним.
 */
const CameraOcr = () => {
  useEffect(() => {
    // Камера стартует при загрузке страницы (задняя по умолчанию).
    const controller = mountCameraOcr();
    return () => {
      void controller.destroy();
    };
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 py-8">
        <header className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold tracking-tight">
            Камера и распознавание текста
          </h1>
          <a
            href="/"
            className="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            На главную
          </a>
        </header>

        <section
          aria-label="Вид с камеры"
          className="relative aspect-video w-full overflow-hidden rounded-xl border border-border bg-black"
        >
          <video
            id="video"
            className="h-full w-full object-cover"
            muted
            playsInline
          />
          <div
            id="loader"
            hidden
            className="absolute inset-0 flex items-center justify-center bg-background/70"
          >
            <div className="flex flex-col items-center gap-3">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
              <span className="text-sm text-muted-foreground">Обработка…</span>
            </div>
          </div>
        </section>

        <div
          className="h-2 w-full overflow-hidden rounded-full bg-secondary"
          role="progressbar"
          aria-label="Прогресс распознавания"
        >
          <div
            id="progress-fill"
            className="h-full rounded-full bg-primary transition-[width] duration-200"
            style={{ width: "0%" }}
          />
        </div>

        <p
          id="status"
          role="status"
          className="min-h-5 text-sm text-muted-foreground"
        />

        <div className="flex flex-wrap gap-3">
          <button
            id="btn-capture"
            type="button"
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            Сфотографировать
          </button>
          <button
            id="btn-switch"
            type="button"
            className="rounded-md border border-border bg-secondary px-4 py-2 text-sm font-medium text-secondary-foreground transition-colors hover:bg-secondary/70 disabled:opacity-50"
          >
            Переключить камеру
          </button>
          <button
            id="btn-copy"
            type="button"
            className="rounded-md border border-border bg-secondary px-4 py-2 text-sm font-medium text-secondary-foreground transition-colors hover:bg-secondary/70 disabled:opacity-50"
          >
            Копировать
          </button>
          <button
            id="btn-clear"
            type="button"
            className="rounded-md border border-border bg-secondary px-4 py-2 text-sm font-medium text-secondary-foreground transition-colors hover:bg-secondary/70"
          >
            Очистить
          </button>
        </div>

        <div className="grid gap-2">
          <label
            htmlFor="recognized-text"
            className="text-sm font-medium text-muted-foreground"
          >
            Распознанный текст
          </label>
          <textarea
            id="recognized-text"
            rows={6}
            placeholder="Здесь появится распознанный текст…"
            className="w-full resize-y rounded-xl border border-input bg-card p-3 text-base text-card-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label
            htmlFor="lang-select"
            className="text-sm font-medium text-muted-foreground"
          >
            Язык распознавания
          </label>
          <select
            id="lang-select"
            className="h-9 rounded-md border border-input bg-card px-3 text-sm text-card-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="rus+eng">Русский + английский</option>
            <option value="rus">Русский</option>
            <option value="eng">Английский</option>
            <option value="deu">Немецкий</option>
            <option value="spa">Испанский</option>
            <option value="fra">Французский</option>
            <option value="ita">Итальянский</option>
            <option value="ukr">Украинский</option>
          </select>
        </div>
      </main>

      {/* Скрытый буфер для снимка — его заполняет модуль при нажатии «Сфотографировать». */}
      <canvas id="canvas" className="hidden" />
    </div>
  );
};

export default CameraOcr;
