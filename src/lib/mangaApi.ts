/**
 * Смена api в озвучивателе манги.
 *
 * Клиент оперирует понятными именами («HikkoGPT Smart») — ровно теми же, что и
 * переключатель моделей в чате, а конкретный провайдер/модель выбирает
 * edge-функция `manga-analyze` (`MANGA_MODEL_MAP` в её parse.ts). Тест
 * `mangaApi.test.ts` сверяет два списка, поэтому имя нельзя переименовать
 * только с одной стороны: сервер молча ушёл бы на модель по умолчанию.
 *
 * Выбор запоминается в localStorage отдельно от чата (анализ длинных глав
 * удобнее держать на быстрой модели, не трогая модель переписки), но пока
 * пользователь ничего не выбрал, окно манги берёт модель чата — `preferredApi`.
 */

export interface MangaApiOption {
  /** Имя, которое уходит в `manga-analyze` полем `model`. */
  id: string;
  label: string;
  /** Короткая подсказка: чем api отличается при анализе страниц. */
  description: string;
}

/** Те же имена, что в `MANGA_MODEL_MAP` на сервере (порядок — от умного к быстрому). */
export const MANGA_API_OPTIONS: MangaApiOption[] = [
  { id: "HikkoGPT", label: "HikkoGPT", description: "Самый умный: точнее разберёт реплики" },
  { id: "HikkoGPT Smart", label: "HikkoGPT Smart", description: "Быстрый и умный" },
  { id: "HikkoGPT Turbo", label: "HikkoGPT Turbo", description: "Быстрый: длинные главы" },
  { id: "Спорящий", label: "Спорящий", description: "Экономный: меньше расход лимита" },
];

/** Api по умолчанию — как в чате при первом входе. */
export const DEFAULT_MANGA_API = "HikkoGPT Smart";

const STORAGE_KEY = "hikkogpt.manga.api";

/** Есть ли имя в списке переключателя (проверка входа из хранилища и из пропсов). */
export function isMangaApi(id: unknown): id is string {
  return typeof id === "string" && MANGA_API_OPTIONS.some((option) => option.id === id);
}

/** Подсказка выбранного api — для строки прогресса и aria-описания. */
export function describeMangaApi(id: string): string {
  return MANGA_API_OPTIONS.find((option) => option.id === id)?.description ?? "";
}

/**
 * Читает сохранённый выбор.
 *
 * `preferredApi` (модель чата) используется, только если своего сохранённого
 * выбора ещё нет; битое/устаревшее значение в хранилище не ломает окно — берётся
 * валидный запасной вариант. localStorage может быть недоступен (приватный
 * режим, iframe без storage), поэтому всё обёрнуто в try/catch.
 */
export function loadMangaApi(preferredApi?: string): string {
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    stored = null;
  }
  if (isMangaApi(stored)) return stored;
  if (isMangaApi(preferredApi)) return preferredApi;
  return DEFAULT_MANGA_API;
}

/** Пользователь сам выбрал api — с этого момента его выбор важнее модели чата. */
export function hasStoredMangaApi(): boolean {
  try {
    return isMangaApi(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return false;
  }
}

export function saveMangaApi(id: string): void {
  if (!isMangaApi(id)) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Хранилище недоступно — выбор останется до закрытия окна.
  }
}
