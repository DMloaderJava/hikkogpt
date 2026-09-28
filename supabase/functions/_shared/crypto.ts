/**
 * Симметричное шифрование пользовательских секретов (Gemini API key).
 *
 * AES-256-GCM, ключ — Edge Secret `USER_KEY_ENC_SECRET` (base64 от 32 байт,
 * `openssl rand -base64 32`). IV — 12 случайных байт на каждое шифрование,
 * в базу пишется вместе с шифротекстом (`user_api_keys.iv`).
 *
 * AAD привязывает шифротекст к конкретной строке: `user_api_keys:<user_id>:<provider>`.
 * Переставить ciphertext в чужую строку (или подменить provider) нельзя —
 * decrypt упадёт. Это защищает от «копипаста» строк между пользователями.
 *
 * Плейнтекст не логируется и не возвращается наружу. Ротация секрета делает
 * старые записи нечитаемыми — порядок ротации в SETUP_SUPABASE.md.
 *
 * Модуль намеренно не зависит от Deno API (кроме `Deno.env` через typeof-гард),
 * поэтому его можно импортировать в node-тестах (`scripts/unit-api-keys.mjs`).
 */

/** Имя Edge Secret с ключом шифрования. */
export const ENC_SECRET_ENV = 'USER_KEY_ENC_SECRET';

const ALGORITHM = 'AES-GCM';
/** 96 бит — рекомендованный GCM размер IV; другие значения не принимаются. */
const IV_BYTES = 12;
/** AES-256. */
const KEY_BYTES = 32;

/** Коды ошибок — edge-функции мапят их в HTTP-статусы, не в тексты. */
export type CryptoErrorCode =
  /** USER_KEY_ENC_SECRET не задан (не задеплоен секрет). */
  | 'enc_secret_missing'
  /** Секрет есть, но это не base64 от 32 байт. */
  | 'enc_secret_invalid'
  /** Шифротекст не расшифровался: другой секрет, другой AAD или порча данных. */
  | 'decrypt_failed';

export class CryptoError extends Error {
  readonly code: CryptoErrorCode;

  constructor(code: CryptoErrorCode, message: string) {
    super(message);
    this.name = 'CryptoError';
    this.code = code;
  }
}

/** Зашифрованный секрет в том виде, в каком он лежит в БД. */
export interface EncryptedSecret {
  /** base64(AES-256-GCM ciphertext). */
  ciphertext: string;
  /** base64(12 байт IV). */
  iv: string;
}

export interface SecretOptions {
  /** Явный секрет вместо USER_KEY_ENC_SECRET — только для тестов. */
  secret?: string;
  /** additionalData (см. `secretAad`). Без него шифротекст «переносим». */
  aad?: Uint8Array;
}

/** AAD строки `user_api_keys`: одинаковый при шифровании и расшифровке. */
export function secretAad(userId: string, provider: string): Uint8Array {
  return new TextEncoder().encode(`user_api_keys:${userId}:${provider}`);
}

function readEnv(name: string): string | undefined {
  // typeof-гард: тот же модуль импортируется node-тестом, где Deno нет.
  if (typeof Deno === 'undefined') return undefined;
  return Deno.env.get(name);
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function resolveSecret(secret?: string): string {
  // trim обязателен: `supabase secrets set` и .env легко приносят \n.
  const value = (secret ?? readEnv(ENC_SECRET_ENV) ?? '').trim();
  if (!value) {
    throw new CryptoError(
      'enc_secret_missing',
      `${ENC_SECRET_ENV} не задан: supabase secrets set ${ENC_SECRET_ENV}="$(openssl rand -base64 32)"`
    );
  }
  return value;
}

async function importKey(secret?: string): Promise<CryptoKey> {
  const value = resolveSecret(secret);

  let bytes: Uint8Array;
  try {
    bytes = fromBase64(value);
  } catch {
    throw new CryptoError(
      'enc_secret_invalid',
      `${ENC_SECRET_ENV} не является base64 (ожидается вывод \`openssl rand -base64 32\`)`
    );
  }

  if (bytes.length !== KEY_BYTES) {
    throw new CryptoError(
      'enc_secret_invalid',
      `${ENC_SECRET_ENV} должен быть base64 от ${KEY_BYTES} байт, получено ${bytes.length}`
    );
  }

  return crypto.subtle.importKey('raw', bytes, { name: ALGORITHM }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/** Шифрует секрет. Каждый вызов — новый IV, повторный шифровать нельзя. */
export async function encryptSecret(
  plaintext: string,
  options: SecretOptions = {}
): Promise<EncryptedSecret> {
  const key = await importKey(options.secret);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));

  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv, ...(options.aad ? { additionalData: options.aad } : {}) },
    key,
    new TextEncoder().encode(plaintext)
  );

  return { ciphertext: toBase64(new Uint8Array(ciphertext)), iv: toBase64(iv) };
}

/** Расшифровывает секрет. Любая неудача → CryptoError('decrypt_failed'). */
export async function decryptSecret(
  payload: EncryptedSecret,
  options: SecretOptions = {}
): Promise<string> {
  const key = await importKey(options.secret);

  let iv: Uint8Array;
  let ciphertext: Uint8Array;
  try {
    iv = fromBase64(payload.iv);
    ciphertext = fromBase64(payload.ciphertext);
  } catch {
    throw new CryptoError('decrypt_failed', 'Повреждённая запись: iv/ciphertext не base64');
  }

  if (iv.length !== IV_BYTES) {
    throw new CryptoError('decrypt_failed', `Ожидался IV ${IV_BYTES} байт, получено ${iv.length}`);
  }

  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: ALGORITHM, iv, ...(options.aad ? { additionalData: options.aad } : {}) },
      key,
      ciphertext
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    // GCM не даёт отличить «другой ключ» от «другие данные» — и не должен.
    throw new CryptoError(
      'decrypt_failed',
      'Не удалось расшифровать ключ: сменён USER_KEY_ENC_SECRET или запись повреждена'
    );
  }
}
