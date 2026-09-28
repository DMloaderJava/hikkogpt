/**
 * Ядро обработки анонимной заявки на тайтл — чистый TypeScript без Deno/node
 * зависимостей. Используется ДВАЖДЫ:
 *   1. edge-функцией submit-title (index.ts навешивает Deno-окружение);
 *   2. юнит-тестами scripts/unit-submissions.mjs через Vite SSR —
 *      оркестрация, валидация и лимиты проверяются локально без Deno.
 *
 * Лимиты: 15/мин + 100/час + 300/сутки на sha256(ip + salt).
 * Обложка: ≤5 MB, jpeg/png/webp, соотношение 3:4 ±10%.
 * Персональные данные: сырой IP не хранится нигде — только хэш.
 */

export const TITLE_TYPE_VALUES = ['manga', 'manhwa', 'manhua', 'oel'] as const;
export type TitleTypeValue = (typeof TITLE_TYPE_VALUES)[number];

export const COVER_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
export const COVER_ASPECT = 3 / 4; // w/h
export const COVER_ASPECT_TOLERANCE = 0.1; // ±10%
export const DESCRIPTION_MIN = 10;
export const DESCRIPTION_MAX = 10_000;
export const GENRES_MAX = 10;
export const ORIGINAL_TITLE_MAX = 200;

export const RATE_LIMITS: Array<{ windowSeconds: number; limit: number }> = [
  { windowSeconds: 60, limit: 15 },
  { windowSeconds: 3600, limit: 100 },
  { windowSeconds: 86400, limit: 300 },
];

// ── Типы ─────────────────────────────────────────────────────────────────────

export interface SubmissionPayload {
  original_title: string;
  type: TitleTypeValue;
  description: string;
  genres: string[];
  title_ru?: string;
  title_en?: string;
  alt_titles?: string[];
  author?: string;
  year?: number;
  country?: string;
  status?: string;
}

export interface SubmissionInput {
  captchaToken?: string;
  payloadRaw: unknown; // распарсенный JSON поля payload
  email?: string;
  coverBytes?: Uint8Array;
  ip: string;
  userAgent?: string;
}

export interface SubmissionRow {
  type: 'new_title';
  status: 'pending';
  payload: Record<string, unknown>;
  ip_hash: string;
  user_agent: string | null;
  turnstile_ok: boolean;
  public_token: string;
  submitter_email: string | null;
}

export type SubmissionDeps = {
  verifyCaptcha: (token: string, ip: string) => Promise<{ ok: boolean; error?: string }>;
  /** Атомарный инкремент окна; false — лимит превышен. */
  checkLimit: (windowSeconds: number, limit: number) => Promise<boolean>;
  uploadCover: (bytes: Uint8Array, token: string, ext: string) => Promise<string>;
  insertRequest: (row: SubmissionRow) => Promise<{ id: string }>;
  /** Подмена в тестах; по умолчанию crypto.getRandomValues. */
  randomToken?: () => string;
};

export type SubmissionResult = {
  status: number;
  body: Record<string, unknown>;
  /** Секунды для заголовка Retry-After (только 429). */
  retryAfter?: number;
};

// ── Валидация payload ────────────────────────────────────────────────────────

export type FieldErrors = Record<string, string>;

/** Опасные схемы в строках: заявка — не место для ссылок-инъекций. */
function containsDangerousScheme(value: string): boolean {
  return /(?:javascript|data|vbscript)\s*:/i.test(value);
}

function asTrimmedString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

export function validateSubmissionPayload(raw: unknown): {
  ok: true;
  value: SubmissionPayload;
} | { ok: false; fieldErrors: FieldErrors } {
  const errors: FieldErrors = {};
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, fieldErrors: { payload: 'Некорректный payload' } };
  }
  const p = raw as Record<string, unknown>;

  const originalTitle = asTrimmedString(p.original_title);
  if (!originalTitle) errors.original_title = 'Укажите название';
  else if (originalTitle.length > ORIGINAL_TITLE_MAX)
    errors.original_title = `Не длиннее ${ORIGINAL_TITLE_MAX} символов`;
  else if (containsDangerousScheme(originalTitle))
    errors.original_title = 'Ссылки в названии запрещены';

  const type = asTrimmedString(p.type);
  if (!TITLE_TYPE_VALUES.includes(type as TitleTypeValue)) {
    errors.type = `Тип должен быть одним из: ${TITLE_TYPE_VALUES.join(', ')}`;
  }

  const description = asTrimmedString(p.description);
  if (description.length < DESCRIPTION_MIN)
    errors.description = `Минимум ${DESCRIPTION_MIN} символов (сейчас ${description.length})`;
  else if (description.length > DESCRIPTION_MAX)
    errors.description = `Максимум ${DESCRIPTION_MAX} символов`;
  else if (containsDangerousScheme(description))
    errors.description = 'Ссылки в описании запрещены';

  const genres = Array.isArray(p.genres) ? p.genres : [];
  const cleanGenres = genres
    .map((g) => asTrimmedString(g))
    .filter((g) => g.length > 0 && g.length <= 50);
  if (cleanGenres.length < 1) errors.genres = 'Добавьте хотя бы один жанр';
  else if (cleanGenres.length > GENRES_MAX)
    errors.genres = `Не больше ${GENRES_MAX} жанров`;

  const altTitles = Array.isArray(p.alt_titles)
    ? p.alt_titles.map((t) => asTrimmedString(t)).filter(Boolean).slice(0, 10)
    : undefined;
  for (const [field, value] of [
    ['title_ru', asTrimmedString(p.title_ru)],
    ['title_en', asTrimmedString(p.title_en)],
    ['author', asTrimmedString(p.author)],
    ['country', asTrimmedString(p.country)],
    ['status', asTrimmedString(p.status)],
    ...(altTitles ?? []).map((t, i) => [`alt_titles.${i}`, t] as const),
  ] as Array<[string, string]>) {
    if (value.length > 200) errors[field] = 'Не длиннее 200 символов';
    else if (containsDangerousScheme(value)) errors[field] = 'Ссылки запрещены';
  }

  const year = p.year;
  if (year !== undefined && year !== null && year !== '') {
    const n = Number(year);
    const currentYear = new Date().getFullYear() + 1;
    if (!Number.isInteger(n) || n < 1900 || n > currentYear) {
      errors.year = `Год от 1900 до ${currentYear}`;
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, fieldErrors: errors };

  return {
    ok: true,
    value: {
      original_title: originalTitle,
      type: type as TitleTypeValue,
      description,
      genres: cleanGenres,
      ...(asTrimmedString(p.title_ru) && { title_ru: asTrimmedString(p.title_ru) }),
      ...(asTrimmedString(p.title_en) && { title_en: asTrimmedString(p.title_en) }),
      ...(altTitles && altTitles.length > 0 && { alt_titles: altTitles }),
      ...(asTrimmedString(p.author) && { author: asTrimmedString(p.author) }),
      ...(p.year !== undefined && p.year !== null && p.year !== '' && { year: Number(p.year) }),
      ...(asTrimmedString(p.country) && { country: asTrimmedString(p.country) }),
      ...(asTrimmedString(p.status) && { status: asTrimmedString(p.status) }),
    },
  };
}

// ── Валидация обложки ────────────────────────────────────────────────────────

export type CoverCheck =
  | { ok: true; width: number; height: number; ext: 'jpg' | 'png' | 'webp' }
  | { ok: false; error: string };

/** Размеры из заголовков JPEG (скан сегментов SOF), PNG (IHDR), WebP (VP8/VP8L/VP8X). */
export function imageSize(bytes: Uint8Array): { width: number; height: number; ext: 'jpg' | 'png' | 'webp' } | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // JPEG: FF D8 FF, затем сегменты; SOF0..SOF15 кроме DHT(C4)/DAC(CC)/RST
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    let off = 2;
    while (off + 9 < bytes.length) {
      if (bytes[off] !== 0xff) {
        off += 1;
        continue;
      }
      const marker = bytes[off + 1];
      // Сегменты без длины
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        off += 2;
        continue;
      }
      if (off + 4 > bytes.length) break;
      const len = dv.getUint16(off + 2);
      if (
        (marker >= 0xc0 && marker <= 0xcf) &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        if (off + 9 > bytes.length) return null;
        return { height: dv.getUint16(off + 5), width: dv.getUint16(off + 7), ext: 'jpg' };
      }
      off += 2 + len;
    }
    return null;
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A + IHDR (ширина/высота на offset 16/20)
  if (
    bytes.length > 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return { width: dv.getUint32(16), height: dv.getUint32(20), ext: 'png' };
  }

  // WebP: RIFF....WEBP
  if (
    bytes.length > 30 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    const format = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    if (format === 'VP8 ') {
      // Lossy: frame tag 3 байта, затем 3 байта sync (0x9d 0x01 0x2a), w/h — 14 бит
      const w = dv.getUint16(26, true) & 0x3fff;
      const h = dv.getUint16(28, true) & 0x3fff;
      return { width: w, height: h, ext: 'webp' };
    }
    if (format === 'VP8L') {
      // Lossless: биты размера упакованы в 4 байтах после первого байта флага
      const b = [bytes[21], bytes[22], bytes[23], bytes[24]];
      const w = 1 + (((b[1] & 0x3f) << 8) | b[0]);
      const h = 1 + (((b[3] & 0xf) << 10) | (b[2] << 2) | ((b[1] & 0xc0) >> 6));
      return { width: w, height: h, ext: 'webp' };
    }
    if (format === 'VP8X') {
      // Extended: 24-битные (size-1) значения на offset 24 и 27
      const w = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
      const h = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
      return { width: w, height: h, ext: 'webp' };
    }
    return null;
  }

  return null;
}

export function validateCoverFile(bytes?: Uint8Array): CoverCheck {
  if (!bytes || bytes.length === 0) return { ok: false, error: 'Обложка обязательна' };
  if (bytes.length > COVER_MAX_BYTES)
    return { ok: false, error: 'Обложка больше 5 MB' };

  const dims = imageSize(bytes);
  if (!dims)
    return { ok: false, error: 'Формат обложки: JPEG, PNG или WebP' };

  const { width, height } = dims;
  if (width < 100 || height < 100)
    return { ok: false, error: 'Обложка слишком маленькая (минимум 100×100)' };

  const ratio = width / height;
  const deviation = Math.abs(ratio - COVER_ASPECT) / COVER_ASPECT;
  if (deviation > COVER_ASPECT_TOLERANCE) {
    return {
      ok: false,
      error: `Соотношение сторон должно быть 3:4 (вертикальная обложка), сейчас ${width}×${height}`,
    };
  }
  return { ok: true, width, height, ext: dims.ext };
}

// ── Утилиты ──────────────────────────────────────────────────────────────────

/** 32 hex-символа из crypto.getRandomValues (Deno/node/браузер). */
export function randomToken(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** sha256hex(ip + salt) — через webcrypto, синхронной замены в Deno нет. */
export async function hashIp(ip: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${ip}${salt}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Клиентский IP для rate limit и ip_hash.
 *
 * cf-connecting-ip ставит Cloudflare на входе — клиенту недоступен, приоритет.
 * X-FORWARDED-FOR — только fallback: CF ДОПИСЫВАЕТ реальный IP в КОНЕЦ
 * цепочки, а первый элемент контролирует сам клиент. Берём последний элемент;
 * иначе лимит обходится ротацией «X-FORWARDED-FOR: <случайный IP>».
 */
export function pickClientIp(
  cfConnectingIp: string | null | undefined,
  xForwardedFor: string | null | undefined
): string {
  const cf = cfConnectingIp?.trim();
  if (cf) return cf;
  const last = xForwardedFor?.split(',').pop()?.trim();
  if (last) return last;
  return 'unknown';
}

// ── Оркестрация ──────────────────────────────────────────────────────────────

/**
 * Полный флоу submit-title с подставляемыми зависимостями.
 * Порядок: rate limit → капча → payload → обложка → upload → insert.
 * Лимит ПЕРЕД капчей: иначе бот без валидного токена дёргает siteverify
 * и функцию без ограничений (невалидные запросы окно расходуют — флуд
 * упирается в 429, а не в Turnstile).
 * Ошибки капчи = 400 error=captcha_missing|captcha_failed (по ТЗ:
 * «captcha-фейл → 400 без заявки»; 403 зарезервирован), лимиты = 429 +
 * Retry-After, данные = 400 с fieldErrors.
 */
export async function processSubmission(
  deps: SubmissionDeps,
  input: SubmissionInput
): Promise<SubmissionResult> {
  const token = (deps.randomToken ?? randomToken)();

  // 1. Rate limit ДО капчи: три окна; любой false → 429.
  //    Запросы с невалидной капчей окно расходуют — флуд без токена
  //    ограничивается тем же способом, что и валидный трафик.
  for (const { windowSeconds, limit } of RATE_LIMITS) {
    const allowed = await deps.checkLimit(windowSeconds, limit);
    if (!allowed) {
      return {
        status: 429,
        body: {
          ok: false,
          error: 'rate_limited',
          message: 'Слишком много заявок с одного адреса. Попробуйте позже.',
        },
        retryAfter: windowSeconds <= 60 ? 60 : Math.min(windowSeconds, 3600),
      };
    }
  }

  // 2. Капча (без токена или непрошедшая → 400, заявка не создаётся)
  if (!input.captchaToken) {
    return { status: 400, body: { ok: false, error: 'captcha_missing' } };
  }
  const captcha = await deps.verifyCaptcha(input.captchaToken, input.ip);
  if (!captcha.ok) {
    return { status: 400, body: { ok: false, error: 'captcha_failed', detail: captcha.error } };
  }

  // 3. Payload
  const checked = validateSubmissionPayload(input.payloadRaw);
  if (!checked.ok) {
    return { status: 400, body: { ok: false, error: 'validation_failed', fields: checked.fieldErrors } };
  }
  const payload = checked.value;

  // 4. Обложка
  const cover = validateCoverFile(input.coverBytes);
  if (!cover.ok) {
    return { status: 400, body: { ok: false, error: 'validation_failed', fields: { cover: cover.error } } };
  }

  // 5-6. Upload + INSERT
  const email = asTrimmedString(input.email);
  let coverUrl: string;
  try {
    coverUrl = await deps.uploadCover(input.coverBytes!, token, cover.ext);
  } catch (e) {
    return {
      status: 500,
      body: { ok: false, error: 'cover_upload_failed', detail: e instanceof Error ? e.message : String(e) },
    };
  }

  let inserted: { id: string };
  try {
    inserted = await deps.insertRequest({
      type: 'new_title',
      status: 'pending',
      payload: { ...payload, cover_url: coverUrl, cover_width: cover.width, cover_height: cover.height },
      ip_hash: await hashIp(input.ip, deps.ipSalt),
      user_agent: input.userAgent ?? null,
      turnstile_ok: true,
      public_token: token,
      submitter_email: email || null,
    });
  } catch (e) {
    return {
      status: 500,
      body: { ok: false, error: 'insert_failed', detail: e instanceof Error ? e.message : String(e) },
    };
  }

  return { status: 200, body: { ok: true, token, id: inserted.id } };
}

/**
 * Ответ get-submission: ТОЛЬКО статусные поля, без payload заявителя.
 * Используется edge-функцией; тесты проверяют отсутствие утечки payload.
 */
export function pickSubmissionStatus(row: {
  status: string;
  type: string;
  created_at: string;
  resolved_at: string | null;
  reject_reason?: string | null;
  payload?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    status: row.status,
    type: row.type,
    created_at: row.created_at,
    resolved_at: row.resolved_at,
    reason: row.reject_reason ?? null,
  };
}

/** Withdraw разрешён в первые 5 минут и только для pending. */
export function canWithdraw(row: { status: string; created_at: string }, nowMs: number): boolean {
  if (row.status !== 'pending') return false;
  const age = nowMs - new Date(row.created_at).getTime();
  return age >= 0 && age <= 5 * 60 * 1000;
}
