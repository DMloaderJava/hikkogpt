/** Криптостойкий токен challenge (hex). Работает и в Deno, и в Node/Vite. */

export function generateLoginChallengeToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  // crypto.getRandomValues есть и в Deno, и в современных Node/браузерах.
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}
